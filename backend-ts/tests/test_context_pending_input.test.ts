/** Pending input is held outside an overfull summary, never cut. Real runner / loop + scripted provider;
 * synthetic assets and history only, no listener and no cloud requests. */
import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContextInputTooLarge, ContextKeeper, ContextView, isCompaction, workingView } from '../src/agent/history.ts'
import { countTokens, estimateMessages, ESTIMATE_FACTOR } from '../src/agent/context.ts'
import { Agent } from '../src/agent/loop.ts'
import { inheritedMessageCount } from '../src/agent/transcript.ts'
import * as repo from '../src/db/repo.ts'
import { attachmentPiece, attachmentReader } from '../src/llm/attachments.ts'
import { isRequest, isToolCall, isToolReturn, isUserPrompt, loadJson, modelRequest, modelResponse, textPart, toolCallPart, toolReturn, userPrompt, userText, type ModelMessage } from '../src/llm/messages.ts'
import { ModelHTTPError } from '../src/llm/model.ts'
import { ScriptedModel, scriptedModel } from '../src/llm/scripted.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import { legacyFileAttachment } from './file_fixtures.ts'
import { appState, buggyRepo, closeState, openSession, setModel, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
const priorWindow = process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS
afterEach(async () => {
  if (priorWindow === undefined) delete process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS
  else process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = priorWindow
  if (state) await closeState(state)
  state = null
})
const summaryAsked = (ms: ModelMessage[]) => {
  const last = ms.at(-1)
  return last !== undefined && isRequest(last) && last.parts.some((p) => isUserPrompt(p) && userText(p) === PROMPT_TEXT['compaction.request'])
}
const summary = () => modelResponse([textPart('<summary>Keep the API unchanged. The old conversation is complete.</summary>')])
const payload = (bytes: number) => 'ATTACHMENT_BEGIN\n' + 'k'.repeat(bytes - 33) + '\nATTACHMENT_END\n'
const INPUT = 'Read every byte of the attached text; preserve the final requirement.'
const OLD = 'Keep the API unchanged.\n' + 'old '.repeat(28_000)
const WINDOW = 80_000
const OUTPUT = 16_000

async function setup(window = WINDOW) {
  process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = String(window)
  state = await appState()
  return (await openSession(state, buggyRepo())).session
}

/** The scripted provider checks every actual input, including summary overhead and hydrated file metadata. */
function recording(seen: ModelMessage[][], reply: (ms: ModelMessage[], n: number) => ReturnType<typeof modelResponse>, window = WINDOW) {
  return new ScriptedModel((ms, info) => {
    const fixed = countTokens(ms.findLast(isRequest)?.instructions ?? '') + countTokens(JSON.stringify(info.function_tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters_json_schema }))))
    const estimated = Math.ceil((estimateMessages(ms) + fixed) * ESTIMATE_FACTOR)
    expect(estimated, `actual request fixed=${fixed}, estimated=${estimated}, inputLimit=${window - OUTPUT}`).toBeLessThanOrEqual(window - OUTPUT)
    seen.push(ms)
    const response = reply(ms, seen.length)
    return { ...response, usage: { input_tokens: estimated, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 } }
  }, { modelName: 'scripted-a' })
}

for (const failure of [false, true]) test(`old conversation + fitting large attachment: summary excludes pending bytes; summary failure=${failure}`, async () => {
  const session = await setup()
  const seen: ModelMessage[][] = []
  setModel(state!, 'scripted:a', recording(seen, () => modelResponse([textPart('Old answer.')])))
  const first = await waitDone(state!, (await state!.runs.start(session, OLD)).id)
  expect(first.status).toBe('done')
  expect(seen).toHaveLength(1)
  const oldHistory = repo.getRunHistory(state!.conn, first.id)!
  const bytes = Buffer.from(payload(18_000))
  const attachment = await legacyFileAttachment(state!, session, bytes, 'pasted-text-1.txt')
  seen.length = 0
  setModel(state!, 'scripted:a', recording(seen, (ms) => {
    if (summaryAsked(ms)) {
      expect(JSON.stringify(ms)).toContain('Keep the API unchanged.')
      expect(JSON.stringify(ms)).not.toContain(attachment.asset_id)
      expect(JSON.stringify(ms)).not.toContain('ATTACHMENT_BEGIN')
      expect(JSON.stringify(ms)).not.toContain(INPUT)
      if (failure) throw new Error('synthetic summary failure')
      return summary()
    }
    expect(isCompaction(ms[0]!)).toBe(true)
    const files = ms.filter(isRequest).flatMap((m) => m.parts.flatMap((p) => isUserPrompt(p) && Array.isArray(p.content) ? p.content : []))
      .filter((p): p is { asset_id: string; data: string } => typeof p === 'object' && p !== null && 'asset_id' in p && p.asset_id === attachment.asset_id)
    expect(files).toHaveLength(1)
    expect(files[0]!.data).toContain(bytes.toString())
    expect(JSON.stringify(ms)).toContain(INPUT)
    return modelResponse([textPart('Read every byte.')])
  }))
  const run = await waitDone(state!, (await state!.runs.start(session, INPUT, { attachments: [attachment] })).id)
  expect(run.resumes_run_id).toBe(first.id)
  expect(run.status).toBe(failure ? 'error' : 'done')
  expect(seen.map(summaryAsked)).toEqual(failure ? [true] : [true, false])
  const events = repo.listEvents(state!.conn, run.id)
  expect(events.filter((e) => e.event === 'run_continued')).toHaveLength(0)
  if (failure) {
    expect(run.error).toBe('Message is too large.')
    expect(events.find((e) => e.event === 'error')!.data.kind).toBe('input_too_large')
    // Even a spent summary request must not make the held-out input part of future model history.
    seen.length = 0
    setModel(state!, 'scripted:a', recording(seen, () => modelResponse([textPart('Small reply.')])))
    const next = await waitDone(state!, (await state!.runs.start(session, 'Small follow-up.')).id)
    expect(next.status).toBe('done')
    expect(seen).toHaveLength(1)
    expect(JSON.stringify(seen)).not.toContain(attachment.asset_id)
  } else {
    const record = loadJson(repo.getRunHistory(state!.conn, run.id)!)
    expect(record.slice(0, loadJson(oldHistory).length)).toEqual(loadJson(oldHistory))
    expect(events.find((e) => e.event === 'context_compacted')!.data.after_tokens).toBeLessThanOrEqual(WINDOW - OUTPUT)
  }
})

for (const withHistory of [false, true]) test(`827934-byte input is refused with zero calls, retained for the person, not inherited; existing history=${withHistory}`, async () => {
  const session = await setup(1_000_000)
  const seen: ModelMessage[][] = []
  setModel(state!, 'scripted:a', recording(seen, () => modelResponse([textPart('ok')]), 1_000_000))
  const previous = withHistory ? await waitDone(state!, (await state!.runs.start(session, 'Remember requirement 913.')).id) : null
  const old = previous ? loadJson(repo.getRunHistory(state!.conn, previous.id)!) : []
  seen.length = 0
  const bytes = Buffer.from(payload(827_934))
  expect(bytes.length).toBe(827_934)
  const attachment = await legacyFileAttachment(state!, session, bytes, 'pasted-text-1.txt')
  const run = await waitDone(state!, (await state!.runs.start(session, INPUT, { attachments: [attachment] })).id)
  expect(run.status).toBe('error')
  expect(run.error).toBe('Message is too large.')
  expect(seen).toHaveLength(0)
  expect(repo.listModelRequests(state!.conn, run.id)).toHaveLength(0)
  expect(run.user_text).toBe(INPUT)
  expect(run.attachments).toEqual([attachment])
  const read = attachmentReader((id) => repo.getAsset(state!.conn, id), (path) => state!.store.read(path), session.project_id, session.id)
  expect(read(attachment)).toEqual(bytes)
  expect(repo.getRunHistory(state!.conn, run.id) ?? '').not.toContain(attachment.asset_id)
  const next = await waitDone(state!, (await state!.runs.start(session, 'A small follow-up.')).id)
  expect(next.status).toBe('done')
  expect(next.resumes_run_id).toBe(run.id)
  expect(seen).toHaveLength(1)
  expect(JSON.stringify(seen)).not.toContain(attachment.asset_id)
  expect(JSON.stringify(seen)).not.toContain(INPUT)
  expect(inheritedMessageCount(state!.conn, next)).toBe(old.length)
  if (previous) expect(JSON.stringify(seen)).toContain('Remember requirement 913.')
})

test('optimistic estimate: provider overflow holds the current attachment outside the summary even when estimated to fit', async () => {
  const session = await setup()
  const seen: ModelMessage[][] = []
  setModel(state!, 'scripted:a', recording(seen, () => modelResponse([textPart('Old answer.')])))
  const first = await waitDone(state!, (await state!.runs.start(session, 'old '.repeat(8_000))).id)
  expect(first.status).toBe('done')
  seen.length = 0
  const bytes = Buffer.from(payload(10_000))
  const attachment = await legacyFileAttachment(state!, session, bytes, 'pasted-text-1.txt')
  setModel(state!, 'scripted:a', recording(seen, (ms, n) => {
    if (n === 1) throw new ModelHTTPError(400, 'scripted-a', { error: { message: 'prompt is too long' } })
    if (summaryAsked(ms)) {
      expect(JSON.stringify(ms)).not.toContain(attachment.asset_id)
      expect(JSON.stringify(ms)).not.toContain(INPUT)
      return summary()
    }
    expect(JSON.stringify(ms)).toContain(attachment.asset_id)
    expect(JSON.stringify(ms)).toContain(bytes.toString().replaceAll('\n', '\\n'))
    return modelResponse([textPart('Recovered.')])
  }))
  const run = await waitDone(state!, (await state!.runs.start(session, INPUT, { attachments: [attachment] })).id)
  expect(run.status).toBe('done')
  expect(seen.map(summaryAsked)).toEqual([false, true, false])
  expect(repo.listEvents(state!.conn, run.id).filter((e) => e.event === 'run_continued').map((e) => e.data.reason)).toEqual(['context_overflow'])
})

/** The actual loop and ContextView, for precise budget edges without the runner's variable workspace prefix. */
async function loop(messages: ModelMessage[], keeper: ContextKeeper, answer: (ms: ModelMessage[]) => ReturnType<typeof modelResponse>, requests?: number) {
  const seen: ModelMessage[][] = []
  const model = new ContextView(scriptedModel((ms) => { seen.push(ms); return answer(ms) }), 'test')
  const agent = new Agent<null>({ instructions: '', tools: [], processHistory: async (_, ms, seam) => {
    const [kept] = await keeper.maybeCompact(ms, seam)
    keeper.assertFits(kept, seam)
    return kept
  } })
  let error: unknown = null, done = false
  try {
    for await (const event of agent.runStreamEvents({ deps: null, model, prompt: null, messageHistory: messages, modelSettings: { max_tokens: keeper.output_reserve }, usageLimits: { request_limit: requests } })) {
      if (event.type === 'result') done = true
    }
  } catch (e) { error = e }
  return { seen, error, done }
}

const params = { function_tools: [], allow_text_output: true, thinking: null }
const measured = (messages: ModelMessage[]) => new ContextKeeper({ window: 1_000_000, output_reserve: 1000 }).predict(messages, { instructions: '', params }).tokens

for (const offset of [-1, 0, 1]) test(`single input hard budget edge ${offset}: exact fit is sent, one token over is not`, async () => {
  const ms = [modelRequest([userPrompt('word '.repeat(5_000), { origin: 'person' })])]
  const size = measured(ms)
  const keeper = new ContextKeeper({ window: size + 1000 + offset, output_reserve: 1000 })
  const result = await loop(ms, keeper, () => modelResponse([textPart('ok')]))
  expect(result.done).toBe(offset >= 0)
  expect(result.seen).toHaveLength(offset >= 0 ? 1 : 0)
  if (offset < 0) expect(result.error).toBeInstanceOf(ContextInputTooLarge)
  else expect(result.error).toBeNull()
})

test('mixed pending request: summary excludes only person input, keeps tool calls paired, then carries the whole attachment', async () => {
  const file = attachmentPiece({ asset_id: 'fixture', file_kind: 'text', representation: 'utf8-v1', name: 'note.txt', media_type: 'text/plain', bytes: 9_000, sha256: 'a'.repeat(64) })
  const person = userPrompt([INPUT, file], { origin: 'person' })
  const messages = [modelRequest([userPrompt('old '.repeat(8_000))]), modelResponse([toolCallPart('read_file', {}, 'call1')]), modelRequest([toolReturn('read_file', 'result1', 'call1'), person])]
  const frozen = JSON.stringify(messages)
  const keeper = new ContextKeeper({ window: 21_000, output_reserve: 1000 })
  const result = await loop(messages, keeper, (ms) => {
    if (summaryAsked(ms)) {
      expect(JSON.stringify(ms)).not.toContain('fixture')
      const calls = ms.flatMap((m) => m.parts.filter(isToolCall)).map((p) => String(p.tool_call_id))
      const returns = ms.filter(isRequest).flatMap((m) => m.parts.filter(isToolReturn)).map((p) => p.tool_call_id)
      expect(calls).toEqual(['call1'])
      expect(returns).toEqual(calls)
      return summary()
    }
    expect(ms[0]!.parts).toContainEqual(person)
    expect(JSON.stringify(ms)).toContain('Result of tool call call1')
    return modelResponse([textPart('done')])
  })
  expect(result.error).toBeNull()
  expect(result.done).toBe(true)
  expect(result.seen.map(summaryAsked)).toEqual([true, false])
  expect(JSON.stringify(messages)).toBe(frozen)
})

test('no summary request budget and known-overfull history: no model request of either kind', async () => {
  const messages = [modelRequest([userPrompt('old '.repeat(8_000))]), modelResponse([textPart('done')]), modelRequest([userPrompt('new '.repeat(8_000))])]
  const result = await loop(messages, new ContextKeeper({ window: 20_000, output_reserve: 1000 }), summary, 0)
  expect(result.error).toBeInstanceOf(ContextInputTooLarge)
  expect(result.seen).toHaveLength(0)
  expect(result.done).toBe(false)
})

test('a summary that cannot make room for the preserved input is locally refused before the formal request', async () => {
  const messages = [modelRequest([userPrompt('old '.repeat(4_000))]), modelResponse([textPart('done')]), modelRequest([userPrompt('new '.repeat(9_000))])]
  const result = await loop(messages, new ContextKeeper({ window: 13_000, output_reserve: 1000 }), () => modelResponse([textPart('summary '.repeat(2_000))]))
  expect(result.error).toBeInstanceOf(ContextInputTooLarge)
  expect(result.seen.map(summaryAsked)).toEqual([true])
  expect(result.done).toBe(false)
})

test('closing turn skips compaction but still refuses an oversized tool result before the next model call', async () => {
  const session = await setup()
  const ws = repo.getWorkspace(state!.conn, session.workspace_id!)!
  writeFileSync(join(ws.path, 'huge.txt'), 'huge '.repeat(60_000))
  const seen: ModelMessage[][] = []
  setModel(state!, 'scripted:a', recording(seen, () => modelResponse([toolCallPart('read_file', { path: 'huge.txt' }, 'read1')])))
  const run = await waitDone(state!, (await state!.runs.start(session, 'Read huge.txt.', { budget: { tool_calls: 1 } })).id)
  expect(run.status).toBe('error')
  expect(run.error).toBe('Message is too large.')
  expect(seen).toHaveLength(1)
  const events = repo.listEvents(state!.conn, run.id)
  expect(events.filter((e) => e.event === 'context_compacting')).toHaveLength(0)
  expect(events.filter((e) => e.event === 'budget_closing')).toHaveLength(1)
})

test('the fixed provider frame alone cannot fit: zero calls, even for a tiny message', async () => {
  const session = await setup(20_000) // 4_000 input tokens after the unchanged 16_000 output reserve
  let calls = 0
  setModel(state!, 'scripted:a', scriptedModel(() => { calls++; return summary() }))
  const run = await waitDone(state!, (await state!.runs.start(session, 'Hi.')).id)
  expect(run.status).toBe('error')
  expect(run.error).toBe('Message is too large.')
  expect(calls).toBe(0)
})

test('history that cannot fit even without the pending message is rejected before a summary call', async () => {
  const messages = [modelRequest([userPrompt('old '.repeat(20_000))]), modelResponse([textPart('done')]), modelRequest([userPrompt('small new input')])]
  const result = await loop(messages, new ContextKeeper({ window: 20_000, output_reserve: 1000 }), summary)
  expect(result.error).toBeInstanceOf(ContextInputTooLarge)
  expect(result.done).toBe(false)
  expect(result.seen).toHaveLength(0)
})

test('an impossible queued steer is refused whole, not sent in a summary and not allowed to fail the running answer', async () => {
  const session = await setup(34_000)
  const seen: ModelMessage[][] = []
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((r) => { entered = r })
  const gate = new Promise<void>((r) => { release = r })
  setModel(state!, 'scripted:a', new ScriptedModel(async (ms, info) => {
    const tokens = new ContextKeeper({ window: 34_000, output_reserve: OUTPUT }).predict(ms, {
      instructions: ms.findLast(isRequest)?.instructions ?? '', params: { ...params, function_tools: info.function_tools },
    }).tokens
    expect(tokens).toBeLessThanOrEqual(34_000 - OUTPUT)
    seen.push(ms)
    if (summaryAsked(ms)) return summary()
    entered()
    await gate
    return modelResponse([textPart('Initial answer.')])
  }, { modelName: 'scripted-a' }))
  const run = await state!.runs.start(session, 'Answer briefly.')
  try {
    await Promise.race([started, waitDone(state!, run.id).then(() => { throw new Error('run ended before its first request') })])
    const words = '界'.repeat(19_000)
    const queued = state!.runs.steer(run.id, words, 'oversized-steer-key')
    expect('steer' in queued).toBe(true)
    release()
    const done = await waitDone(state!, run.id)
    expect(done.status).toBe('done')
    expect(done.receipt.final_text).toBe('Initial answer.')
    expect(state!.runs.steersOf(run.id)).toMatchObject([{ text: words, status: 'undelivered', reason: 'context' }])
    expect(JSON.stringify(seen)).not.toContain(words)
  } finally { release() }
})

test('a second overflow compaction reads the entire earlier summary, including a constraint beyond the text bound', async () => {
  const constraint = 'NEVER_CHANGE_VENDOR_913'
  const previous = `${'progress '.repeat(1400)}\n${constraint}`
  const marker = { ...modelRequest([userPrompt(`App note: The conversation so far was summarized.\n${previous}`, { origin: 'app' }), userPrompt('current')]), compaction: { covers: 1, tokens_before: 20_000, summary_input_tokens: null, model: null, at: '2026-10-31T00:00:00Z' } }
  const messages = [marker, modelResponse([textPart('More history. '.repeat(4_000))]), modelRequest([userPrompt('next '.repeat(8_000))])]
  const keeper = new ContextKeeper({ window: 80_000, output_reserve: 1000 })
  keeper.recoverFromOverflow('prompt is too long')
  const result = await loop(messages, keeper, (ms) => {
    if (summaryAsked(ms)) {
      expect(JSON.stringify(ms)).toContain(constraint)
      expect(JSON.stringify(ms)).not.toContain('next next next')
      return modelResponse([textPart(`<summary>${constraint}</summary>`)])
    }
    expect(JSON.stringify(workingView(ms))).toContain(constraint)
    return modelResponse([textPart('done')])
  })
  expect(result.error).toBeNull()
  expect(result.done).toBe(true)
  expect(result.seen.map(summaryAsked)).toEqual([true, false])
})
