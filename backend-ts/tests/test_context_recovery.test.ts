/** Only a whole summary replaces the earlier messages: one cut at the output limit, filtered or ended by an error is
 *  not taken (the record and its tail stay); a plain-text summary still is. A provider's refusal of the context for
 *  its size is answered once: a compaction whose summary request and tail carry no text longer than the bound (each
 *  cut one says so; the pending person's words are held out and reattached whole), taken only when the view is smaller, before the request goes
 *  again — no tool runs again; when that cannot be had, the run ends as a context overflow without sending the same
 *  request again. Scripted models, no command, no real model. */

import { afterEach, expect, test } from 'bun:test'
import { estimateMessages } from '../src/agent/context.ts'
import {
  ContextKeeper, ContextOverflowUnrecovered, isCompaction, personPieces, RECOVERY_PART_CHARS, workingView, type RequestSeam,
} from '../src/agent/history.ts'
import * as repo from '../src/db/repo.ts'
import {
  dumpJson, isRequest, isResponse, isText, isToolReturn, isUserPrompt, loadJson, loadValue, modelRequest, modelResponse, textPart, toolCallPart, toolReturn,
  userPrompt, userText, type ModelMessage,
} from '../src/llm/messages.ts'
import { applySessionMode } from '../src/policy/modes.ts'
import { ModelHTTPError, type ModelRequestParameters } from '../src/llm/model.ts'
import { scriptedModel } from '../src/llm/scripted.ts'
import { OpenAIResponsesModel } from '../src/llm/providers/openai_responses.ts'
import { codexSse, textOutput } from './providers_fixtures.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import { appState, buggyRepo, closeState, openSession, setModel, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

const PARAMS: ModelRequestParameters = { function_tools: [], allow_text_output: true, thinking: null }
const INSTRUCTIONS = 'You are the agent under test.'
const LONG = 'the quick brown fox jumps over the lazy dog '.repeat(40)

function history(n = 6, big = LONG): ModelMessage[] {
  const out: ModelMessage[] = [modelRequest([userPrompt('build it')], INSTRUCTIONS)]
  for (let i = 0; i < n; i += 1) {
    out.push(modelResponse([toolCallPart('read_file', { path: `f${i}` }, `tc_${i}`)]))
    out.push(modelRequest([toolReturn('read_file', { status: 'ok', content: big }, `tc_${i}`)], INSTRUCTIONS))
  }
  return out
}

const asksSummary = (messages: ModelMessage[]) => {
  const last = messages[messages.length - 1]!
  return isRequest(last) && last.parts.some((p) => isUserPrompt(p) && userText(p) === PROMPT_TEXT['compaction.request'])
}

const seam = (model: ReturnType<typeof scriptedModel>, extra: Partial<RequestSeam> = {}): RequestSeam => ({
  model, settings: { max_tokens: 1000 }, params: PARAMS, instructions: INSTRUCTIONS, observed: null, ...extra,
})

const over = (messages: ModelMessage[]) => ({ input_tokens: 11_400, messages: messages.length - 2 })

test('a summary cut at the output limit, filtered or ended by an error is not taken; the record and its tail stay', async () => {
  const messages = history(6)
  for (const [finish, text] of [['length', '<summary>Steps 0-3 ran; step 4 was about to'], ['length', 'Steps 0-3 ran and step'], ['content_filter', 'x'], ['error', 'y']] as const) {
    const keeper = new ContextKeeper({ window: 20_000, output_reserve: 500 })
    const model = scriptedModel(() => modelResponse([textPart(text)], { finish_reason: finish }))
    const [same, report] = await keeper.maybeCompact(messages, seam(model, { observed: over(messages) }))
    expect(same).toBe(messages)
    expect(report!.status).toBe('failed')
    expect(report!.reason).toBe(`the summary did not finish (${finish})`)
  }
})

test('a plain-text summary that finished is taken (no tags required)', async () => {
  const messages = history(6)
  const keeper = new ContextKeeper({ window: 20_000, output_reserve: 500 })
  const model = scriptedModel(() => modelResponse([textPart('Steps 0-5 read f0..f5; nothing failed.')], { finish_reason: 'stop' }))
  const [out, report] = await keeper.maybeCompact(messages, seam(model, { observed: over(messages) }))
  expect(report!.status).toBe('compacted')
  expect(report!.trigger).toBe('threshold')
  expect(isCompaction(out[out.length - 1]!)).toBe(true)
  expect(userText(out[out.length - 1]!.parts[0] as never)).toContain('Steps 0-5 read f0..f5; nothing failed.')
})

test('after a refusal for size: the summary request carries no text over the bound, the tail\'s results are cut with their note, the person\'s words ride whole, and the view is smaller', async () => {
  const huge = 'x'.repeat(RECOVERY_PART_CHARS * 6)
  const words = 'keep every one of these words: ' + 'w '.repeat(RECOVERY_PART_CHARS)
  const messages = [...history(3, huge)]
  messages[messages.length - 1] = modelRequest([toolReturn('read_file', { status: 'ok', content: huge }, 'tc_2'), userPrompt(words)], INSTRUCTIONS)
  const keeper = new ContextKeeper({ window: 1_000_000, output_reserve: 500 })   // the prediction says it fits; the provider said no
  const asked: ModelMessage[][] = []
  const model = scriptedModel((m) => { asked.push(m); return modelResponse([textPart('<summary>read three files</summary>')], { finish_reason: 'stop' }) })
  keeper.recoverFromOverflow('prompt is too long')
  const [out, report] = await keeper.maybeCompact(messages, seam(model))
  expect(report!.status).toBe('compacted')
  expect(report!.trigger).toBe('overflow')
  // The pending person's words are held out of the summary; the other texts stay within the bound plus note.
  const texts0 = asked[0]!.flatMap((m) => (isRequest(m) ? m.parts.map((p) => (isToolReturn(p) ? JSON.stringify(p.content) : isUserPrompt(p) ? userText(p) : '')) : m.parts.filter(isText).map((p) => p.content)))
  expect(texts0).not.toContain(words) // held out of the summary after the provider's refusal
  const longest = Math.max(...texts0.filter((t) => t !== words).map((t) => t.length))
  expect(longest).toBeLessThan(RECOVERY_PART_CHARS + 300)
  // the compaction request: the tail's result cut with its note; the person's words whole
  const marker = out[out.length - 1]!
  const texts = (marker as { parts: unknown[] }).parts.map((p) => userText(p as never))
  expect(texts.some((t) => t.includes('characters shown; the whole text stays in the conversation record'))).toBe(true)
  expect(texts).toContain(words)
  expect(estimateMessages(workingView(out))).toBeLessThan(estimateMessages(workingView(messages)))
  expect(out.slice(0, messages.length)).toEqual(messages)                               // the record is only appended to
})

test('after a refusal for size, no smaller view to be had ends the run rather than sending the same again', async () => {
  const messages = history(3)
  const keeper = () => { const k = new ContextKeeper({ window: 1_000_000, output_reserve: 500 }); k.recoverFromOverflow('too long'); return k }
  const failing = scriptedModel(() => { throw new ModelHTTPError(400, 'm', { error: { message: 'prompt is too long' } }) })
  await expect(keeper().maybeCompact(messages, seam(failing))).rejects.toBeInstanceOf(ContextOverflowUnrecovered)
  const cut = scriptedModel(() => modelResponse([textPart('half')], { finish_reason: 'length' }))
  await expect(keeper().maybeCompact(messages, seam(cut))).rejects.toThrow('the summary did not finish (length)')
  const bloated = scriptedModel(() => modelResponse([textPart('s'.repeat(200_000))], { finish_reason: 'stop' }))
  await expect(keeper().maybeCompact(messages, seam(bloated))).rejects.toThrow('is not smaller than the refused one')
  const noBudget = scriptedModel(() => modelResponse([textPart('never asked')]))
  await expect(keeper().maybeCompact(messages, seam(noBudget, { requests_left: 0 }))).rejects.toThrow('no request left for a summary')
})

// ---- the run ----------------------------------------------------------------------------------------------------

const tooLong = () => new ModelHTTPError(400, 'scripted-a', { error: { message: 'prompt is too long: 250000 tokens > 200000 maximum' } })

async function overflowRun(summary: (messages: ModelMessage[]) => ReturnType<typeof modelResponse>, budget?: { requests: number }) {
  state = await appState()
  const { session } = await openSession(state, buggyRepo())
  const seen: { summary: boolean; messages: ModelMessage[] }[] = []
  let normal = 0
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    const isSummary = asksSummary(messages)
    seen.push({ summary: isSummary, messages })
    if (isSummary) return summary(messages)
    normal += 1
    // a long first answer beside the call: what makes the refused view large (the summary stands for it afterwards)
    if (normal === 1) return modelResponse([textPart('Working through the file. '.repeat(1_500)), toolCallPart('read_file', { path: 'calc.py' }, 'r1')])
    if (normal === 2) throw tooLong()
    return modelResponse([textPart('add() subtracts.')], { finish_reason: 'stop' })
  }))
  const run = await waitDone(state, (await state.runs.start(session, 'read calc.py and explain', budget ? { budget } : {})).id)
  return { run, seen, events: repo.listEvents(state.conn, run.id) }
}

test('a refusal for size is answered once: a summary, a smaller view, the request again — the read is not run again', async () => {
  const { run, seen, events } = await overflowRun(() => modelResponse([textPart('<summary>The user asked to read calc.py; it was read.</summary>')], { finish_reason: 'stop' }))
  expect(run.status).toBe('done')
  expect(run.receipt.final_text).toBe('add() subtracts.')
  expect(seen.map((s) => s.summary)).toEqual([false, false, true, false])
  expect(events.filter((e) => e.event === 'tool_result')).toHaveLength(1)
  expect(events.filter((e) => e.event === 'run_continued').map((e) => e.data.reason)).toEqual(['context_overflow'])
  const compacted = events.filter((e) => e.event === 'context_compacted')
  expect(compacted.map((e) => [e.data.status, e.data.trigger])).toEqual([['compacted', 'overflow']])
  // what the provider read after the recovery opens with the compaction and is smaller than what it refused
  const refused = seen[1]!.messages
  const after = seen[3]!.messages
  expect(isCompaction(after[0]!)).toBe(true)
  expect(after.filter(isResponse)).toHaveLength(0)
  expect(estimateMessages(after)).toBeLessThan(estimateMessages(refused))
  expect(after.length).toBeLessThan(refused.length)
})

test('a refusal for size whose summary fails too: the run ends as a context overflow; the refused request is not sent again', async () => {
  const { run, seen, events } = await overflowRun(() => { throw tooLong() })
  expect(run.status).toBe('error')
  expect(seen.map((s) => s.summary)).toEqual([false, false, true])
  const error = events.find((e) => e.event === 'error')!
  expect(error.data.kind).toBe('context_overflow')
  expect(String(error.data.message)).toContain('could not be made smaller')
  expect(events.filter((e) => e.event === 'tool_result')).toHaveLength(1)
})

test('a refusal for size with no request left for a summary: no summary, no second try, a context overflow', async () => {
  const { run, seen, events } = await overflowRun(() => modelResponse([textPart('never')]), { requests: 2 })
  expect(run.status).toBe('error')
  expect(seen.map((s) => s.summary)).toEqual([false, false])
  expect(events.find((e) => e.event === 'error')!.data.kind).toBe('context_overflow')
})

// HTTP 200 SSE -> OpenAIResponsesModel -> ordinary ModelAPIError -> runner -> one overflow compaction.
for (const shape of ['response.failed', 'nested error', 'top-level error'] as const) {
  for (const refusedAgain of [false, true]) {
    test(`Codex ${shape}: real parser drives one runner compaction; refused again=${refusedAgain}`, async () => {
      state = await appState()
      const { session } = await openSession(state, buggyRepo())
      const seen: { summary: boolean; input: string }[] = []
      const token = 'opaque-runner-fixture-credential'
      const reason = 'The request exceeds the context window.' // fixture, not an observed upstream message
      let normal = 0
      const model = new OpenAIResponsesModel('gpt-6-astra', {
        codex: true, baseUrl: 'https://codex.invalid',
        beforeSend: ({ headers }) => { headers.set('authorization', `Bearer ${token}`) },
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as { input: unknown }
          const input = JSON.stringify(body.input)
          const summary = input.includes(PROMPT_TEXT['compaction.request'])
          seen.push({ summary, input })
          let content: string
          if (summary) content = codexSse(textOutput('<summary>calc.py was read; add subtracts.</summary>'))
          else {
            normal += 1
            if (normal === 1) content = codexSse([
              ...textOutput('Working through the file. '.repeat(1_500)),
              { type: 'function_call', id: 'fc_1', call_id: 'r1', name: 'read_file', arguments: JSON.stringify({ path: 'calc.py' }) },
            ])
            else if (normal === 2 || refusedAgain) {
              const error = { code: 'context_length_exceeded', message: `${reason} ${token}` }
              const event = shape === 'response.failed' ? { type: shape, response: { error } }
                : shape === 'nested error' ? { type: 'error', error } : { type: 'error', ...error }
              content = `data: ${JSON.stringify(event)}\n\n`
            } else content = codexSse(textOutput('add() subtracts.'))
          }
          return new Response(content, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        },
      })
      setModel(state, 'scripted:a', model)
      const run = await waitDone(state, (await state.runs.start(session, 'read calc.py and explain')).id)
      const events = repo.listEvents(state.conn, run.id)
      expect(seen.map((s) => s.summary)).toEqual([false, false, true, false])
      expect(events.filter((e) => e.event === 'tool_result')).toHaveLength(1)
      expect(events.filter((e) => e.event === 'run_continued').map((e) => e.data.reason)).toEqual(['context_overflow'])
      expect(events.filter((e) => e.event === 'context_compacted').map((e) => [e.data.status, e.data.trigger])).toEqual([['compacted', 'overflow']])
      expect(seen[3]!.input.length).toBeLessThan(seen[1]!.input.length)
      expect(seen[3]!.input).toContain('calc.py was read')
      const requests = repo.listModelRequests(state.conn, run.id)
      expect(requests).toHaveLength(4)
      const failed = requests.filter((r) => r.status === 'error')
      expect(failed).toHaveLength(refusedAgain ? 2 : 1)
      for (const record of failed) {
        expect(record.error).toContain('ModelAPIError')
        expect(record.error).toContain('context_length_exceeded')
        expect(record.error).toContain(reason)
        expect(record.error).not.toContain(token)
      }
      expect(JSON.stringify(events)).not.toContain(token)
      if (refusedAgain) {
        expect(run.status).toBe('error')
        expect(events.find((e) => e.event === 'error')!.data.kind).toBe('context_overflow')
      } else {
        expect(run.status).toBe('done')
        expect(run.receipt.final_text).toBe('add() subtracts.')
      }
    })
  }
}

test('Codex server_error saying request took too long takes transport recovery, never compaction', async () => {
  state = await appState()
  state.runs.transport_backoff_s = [0.01]
  const { session } = await openSession(state, buggyRepo())
  let requests = 0
  setModel(state, 'scripted:a', new OpenAIResponsesModel('gpt-6-astra', {
    codex: true, fetchImpl: async () => {
      requests += 1
      const content = requests === 1 ? codexSse([
        ...textOutput('Reading calc.py.'),
        { type: 'function_call', id: 'fc_1', call_id: 'r1', name: 'read_file', arguments: JSON.stringify({ path: 'calc.py' }) },
      ]) : requests === 2 ? `data: ${JSON.stringify({ type: 'response.failed', response: { error: { code: 'server_error', message: 'request took too long' } } })}\n\n`
        : codexSse(textOutput('add() subtracts.'))
      return new Response(content, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  }))
  const run = await waitDone(state, (await state.runs.start(session, 'read calc.py and explain')).id)
  const events = repo.listEvents(state.conn, run.id)
  expect(run.status).toBe('done')
  expect(requests).toBe(3)
  expect(events.filter((e) => e.event === 'run_continued').map((e) => e.data.reason)).toEqual(['transport_error'])
  expect(events.filter((e) => e.event === 'context_compacted')).toHaveLength(0)
  expect(events.filter((e) => e.event === 'tool_result')).toHaveLength(1)
  const failed = repo.listModelRequests(state.conn, run.id).find((r) => r.status === 'error')!
  expect(failed.error).toContain('server_error')
  expect(failed.error).toContain('request took too long')
})

// ---- the person's latest words through a recovery (Codex's overflow-keeper case, and its neighbours) --------------

const END = 'END_REQUIREMENT_7Q: include the final number 913 in your answer.'
const LONG_ASK = 'Read the note once and answer briefly.\n' + 'Ordinary context detail. '.repeat(500) + '\n' + END
const has = (messages: ModelMessage[], text: string) => JSON.stringify(messages).includes(JSON.stringify(text).slice(1, -1))

async function askedAfterTools(opts: { calls: number; ask: string; summary?: (m: ModelMessage[]) => ReturnType<typeof modelResponse>; limit?: number }) {
  state = await appState()
  const { session } = await openSession(state, buggyRepo())
  const seen: { summary: boolean; messages: ModelMessage[] }[] = []
  let normal = 0
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    const isSummary = asksSummary(messages)
    seen.push({ summary: isSummary, messages })
    if (isSummary) return (opts.summary ?? (() => modelResponse([textPart('<summary>The note was read.</summary>')], { finish_reason: 'stop' })))(messages)
    normal += 1
    if (normal === 1) {
      return modelResponse([textPart('Reading. '.repeat(3_000)), ...Array.from({ length: opts.calls }, (_, i) => toolCallPart('read_file', { path: 'calc.py' }, `r${i}`))])
    }
    if (normal === 2) throw tooLong()
    // a provider window: a view still over it is refused again
    if (opts.limit !== undefined && JSON.stringify(messages).length > opts.limit) throw tooLong()
    return modelResponse([textPart(has(messages, END) ? 'Final number: 913.' : 'no requirement in view')], { finish_reason: 'stop' })
  }))
  const run = await waitDone(state, (await state.runs.start(session, opts.ask)).id)
  return { run, seen, events: repo.listEvents(state.conn, run.id), history: repo.getRunHistory(state.conn, run.id) ?? '' }
}

test('a tool\'s return is the last request and the person\'s long message ends with a requirement past the bound: the summary request and the recovered request both carry it whole', async () => {
  const { run, seen, events, history } = await askedAfterTools({ calls: 1, ask: LONG_ASK })
  expect(LONG_ASK.indexOf(END)).toBeGreaterThan(RECOVERY_PART_CHARS)
  expect(seen.map((s) => s.summary)).toEqual([false, false, true, false])
  expect(has(seen[2]!.messages, END)).toBe(true)                                        // the summary could read it
  expect(has(seen[3]!.messages, END)).toBe(true)                                        // and the model reads it after
  expect(has(seen[3]!.messages, LONG_ASK)).toBe(true)                                   // whole, not a cut copy
  expect(JSON.stringify(seen[3]!.messages).length).toBeLessThan(JSON.stringify(seen[1]!.messages).length)
  expect(run.status).toBe('done')
  expect(run.receipt.final_text).toBe('Final number: 913.')
  expect(events.filter((e) => e.event === 'tool_result')).toHaveLength(1)
  expect(history).toContain(END.slice(0, 20))                                           // the record keeps it too
})

test('several calls of one response before the refusal: each ran once, every return answers its call after the recovery, the requirement rides', async () => {
  const { run, seen, events } = await askedAfterTools({ calls: 3, ask: LONG_ASK })
  expect(run.status).toBe('done')
  expect(events.filter((e) => e.event === 'tool_result').map((e) => e.data.tool_call_id)).toEqual(['r0', 'r1', 'r2'])
  const after = seen[3]!.messages
  expect(has(after, END)).toBe(true)
  for (const id of ['r0', 'r1', 'r2']) expect(has(after, `Result of tool call ${id} (read_file)`)).toBe(true)
})

test('the person\'s words alone do not fit the window: locally refused before any model call', async () => {
  const huge = 'An enormous request. '.repeat(40_000) + END
  const { run, seen, events } = await askedAfterTools({ calls: 1, ask: huge, limit: 400_000 })
  expect(run.status).toBe('error')
  expect(run.error).toBe('Message is too large.')
  expect(run.user_text).toBe(huge)
  expect(seen).toHaveLength(0)
  expect(events.filter((e) => e.event === 'run_continued')).toHaveLength(0)
  expect(events.find((e) => e.event === 'error')!.data.kind).toBe('input_too_large')
})

test('the person\'s short words as the pending tail: carried once, whole, in the compaction request', async () => {
  const messages = [...history(6), modelResponse([textPart('Done with the files.')]), modelRequest([userPrompt('Now add a test; keep it under 20 lines.')], INSTRUCTIONS)]
  const keeper = new ContextKeeper({ window: 1_000_000, output_reserve: 500 })
  keeper.recoverFromOverflow('too long')
  const model = scriptedModel(() => modelResponse([textPart('Six files were read.')], { finish_reason: 'stop' }))
  const [out, report] = await keeper.maybeCompact(messages, seam(model))
  expect(report!.status).toBe('compacted')
  const marker = out[out.length - 1]!
  const texts = (marker as { parts: unknown[] }).parts.map((p) => userText(p as never))
  expect(texts.filter((t) => t === 'Now add a test; keep it under 20 lines.')).toHaveLength(1)
  expect(texts.some((t) => t.startsWith(PROMPT_TEXT['compaction.person_words']))).toBe(false)   // the tail holds it: no second copy
})

test('the person\'s words before the last tool call are carried with a note that says so, after a refusal and after a threshold compaction alike', async () => {
  const messages = [modelRequest([userPrompt('Rename add to plus everywhere.')], INSTRUCTIONS), ...history(4).slice(1)]
  const keeper = new ContextKeeper({ window: 1_000_000, output_reserve: 500 })
  keeper.recoverFromOverflow('too long')
  const model = scriptedModel(() => modelResponse([textPart('Four files were read.')], { finish_reason: 'stop' }))
  const [out] = await keeper.maybeCompact(messages, seam(model))
  const texts = ((out[out.length - 1]!) as { parts: unknown[] }).parts.map((p) => userText(p as never))
  expect(texts[1]).toBe(PROMPT_TEXT['compaction.person_words'])
  expect(texts[2]).toBe('Rename add to plus everywhere.')
  // a threshold compaction carries them too: the view after it starts at the compaction, without their message
  const plain = new ContextKeeper({ window: 20_000, output_reserve: 500 })
  const [again] = await plain.maybeCompact(messages, seam(model, { observed: over(messages) }))
  const plainTexts = ((again[again.length - 1]!) as { parts: unknown[] }).parts.map((p) => userText(p as never))
  expect(plainTexts.slice(1, 3)).toEqual([PROMPT_TEXT['compaction.person_words'], 'Rename add to plus everywhere.'])
})

// ---- whose words: the person's task beside the app's context (Codex's MC-01 shape), by origin and in older records ----

test('a run\'s message is marked: the person\'s part names the app\'s context piece; the app\'s own prompts are the app\'s; saved and loaded they keep it', async () => {
  state = await appState()
  const { session } = await openSession(state, buggyRepo())
  setModel(state, 'scripted:a', scriptedModel(() => modelResponse([textPart('ok')], { finish_reason: 'stop' })))
  const first = await waitDone(state, (await state.runs.start(session, 'first question')).id)
  applySessionMode(state.conn, repo.getSession(state.conn, session.id)!, 'plan')
  const second = await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, LONG_ASK, { resumes_run_id: first.id })).id)
  const record = loadValue(JSON.parse(repo.getRunHistory(state.conn, second.id)!))
  const parts = record.filter(isRequest).flatMap((m) => m.parts.filter(isUserPrompt))
  const current = parts.find((p) => Array.isArray(p.content) && p.content.includes(LONG_ASK))!
  expect(current.origin).toBe('person')
  expect(current.app_pieces).toEqual([0])
  expect(String((current.content as unknown[])[0])).toStartWith('App note')           // the mode note opens the context
  expect(personPieces(current)).toEqual(new Set([1]))
  expect(personPieces(userPrompt('App note: x', { origin: 'app' }))).toBeNull()
})

const MODE_NOTE = 'App note: The permission state changed. Current permissions: Plan mode.\nDate: 2026-09-28. Time zone: Asia/Shanghai.'
const oldAsk = 'An older question: what is in the note?'
const withMode = (origin: boolean) => userPrompt([MODE_NOTE, LONG_ASK], origin ? { origin: 'person', app_pieces: [0] } : undefined)

function afterRead(current: ReturnType<typeof userPrompt>): ModelMessage[] {
  return [
    modelRequest([userPrompt(oldAsk, { origin: 'person' })], INSTRUCTIONS), modelResponse([textPart('It is a note.')]),
    modelRequest([current], INSTRUCTIONS),
    modelResponse([textPart('Reading. '.repeat(3_000)), toolCallPart('read_file', { path: 'note' }, 'n1')]),
    modelRequest([toolReturn('read_file', { status: 'ok', content: 'Private fact: 42. '.repeat(2_000) }, 'n1')], INSTRUCTIONS),
  ]
}

async function recovered(messages: ModelMessage[]) {
  const keeper = new ContextKeeper({ window: 1_000_000, output_reserve: 500 })
  keeper.recoverFromOverflow('too long')
  const asked: ModelMessage[][] = []
  const model = scriptedModel((m) => { asked.push(m); return modelResponse([textPart('The note was read.')], { finish_reason: 'stop' }) })
  const [out, report] = await keeper.maybeCompact(messages, seam(model))
  return { out, report, summaryInput: asked[0]!, marker: out[out.length - 1]! }
}

for (const [label, origin] of [['marked', true], ['an older record, unmarked', false]] as const) {
  test(`the app's mode note and the current task in one part (${label}): the task is the person's latest words — whole in the summary request and carried after, the older question is not`, async () => {
    const { report, summaryInput, marker, out } = await recovered(afterRead(withMode(origin)))
    expect(report!.status).toBe('compacted')
    expect(has(summaryInput, END)).toBe(true)
    expect(has([marker], LONG_ASK)).toBe(true)
    expect(has([marker], oldAsk)).toBe(false)
    expect(estimateMessages(workingView(out))).toBeLessThan(estimateMessages(workingView(afterRead(withMode(origin)))))
  })
}

test('the task alone (no app note before it) and several pieces with an image: the person\'s pieces ride whole, the image with them, the long app context is cut', async () => {
  const image = { kind: 'image', asset_id: 'a1', media_type: 'image/png', name: 'shot.png' }
  const context = 'Working folder: /w.\n' + 'Project instructions line. '.repeat(1_000)
  const parts = userPrompt([context, LONG_ASK, image as never, 'PS: keep it short.'], { origin: 'person', app_pieces: [0] })
  const { summaryInput, marker } = await recovered(afterRead(parts))
  expect(has(summaryInput, END)).toBe(true)
  const carried = (marker as { parts: ReturnType<typeof userPrompt>[] }).parts.find((p) => Array.isArray(p.content) && p.content.includes(LONG_ASK))!
  const pieces = carried.content as unknown[]
  expect(pieces[1]).toBe(LONG_ASK)
  expect(pieces[2]).toEqual(image)
  expect(pieces[3]).toBe('PS: keep it short.')
  expect(String(pieces[0]).length).toBeLessThan(context.length)                        // the app's context, cut with its note
  expect(carried.origin).toBe('person')
  const plain = await recovered(afterRead(userPrompt(LONG_ASK, { origin: 'person' })))
  expect(has([plain.marker], LONG_ASK)).toBe(true)
  expect(has([plain.marker], oldAsk)).toBe(false)
})

test('origin survives the record\'s round trip; an app part is never the person\'s, whatever its text', () => {
  const record = [modelRequest([withMode(true), userPrompt('Plain words that look like mine', { origin: 'app' })], INSTRUCTIONS)]
  const loaded = loadJson(dumpJson(record))
  const [person, app] = (loaded[0] as { parts: ReturnType<typeof userPrompt>[] }).parts
  expect([person!.origin, person!.app_pieces, app!.origin]).toEqual(['person', [0], 'app'])
  expect(personPieces(app!)).toBeNull()
  expect(personPieces(userPrompt('App note: legacy note'))).toBeNull()                  // older record: by its text
  expect(personPieces(userPrompt('legacy words'))).toBe('whole')
})
