/** What a compaction keeps reaching the model: the person's latest words ride in every compaction request (not only
 *  after a refusal for size), a summary held to its room keeps its short lines — the constraints and decisions —
 *  wherever they stand, however many compactions follow, and a compaction request never carries more than the window
 *  leaves room for: an earlier compaction's note is not nested in the next, and long results are cut when the request
 *  would not fit. (QA round 2: R2-23, R2-25.) Scripted models at the provider boundary. */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as repo from '../src/db/repo.ts'
import { compactionThreshold, countTokens, estimateMessages, ESTIMATE_FACTOR } from '../src/agent/context.ts'
import { boundedSummary, ContextKeeper, isCompaction, PERSON_SHARE, RECOVERY_PART_CHARS, SUMMARY_SHARE, type RequestSeam } from '../src/agent/history.ts'
import { imagePiece } from '../src/llm/images.ts'
import {
  emptyUsage, isRequest, isUserPrompt, loadValue, modelRequest, modelResponse, textPart, toolCallPart, toolReturn, userPrompt, userText, type ModelMessage, type ModelRequest,
} from '../src/llm/messages.ts'
import { ModelHTTPError, type ModelRequestParameters } from '../src/llm/model.ts'
import { ScriptedModel, scriptedModel } from '../src/llm/scripted.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import { appState, buggyRepo, closeState, openSession, setModel, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
const prior = process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS
beforeEach(() => { delete process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS })
afterEach(async () => {
  if (prior === undefined) delete process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS; else process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = prior
  if (state) await closeState(state)
  state = null
})

const PARAMS: ModelRequestParameters = { function_tools: [], allow_text_output: true, thinking: null }
const INSTRUCTIONS = 'You are the agent under test.'
const FACTS = {
  forbidden: 'FORBIDDEN: never modify vendor/legacy_api.py',
  manual: 'MANUAL-EDIT: the person hand-edited config/settings.toml line 12; keep their value 42',
  pending: 'PENDING-DECISION: ask the person whether to drop Python 3.8 before touching setup.cfg',
  done: 'DONE-WHEN: python3 -m unittest passes and CHANGELOG.md has an entry',
} as const
type Fact = keyof typeof FACTS
const FACT_NAMES = Object.keys(FACTS) as Fact[]
const FILLER = 'Read module m_n.py; its helper parses the header and returns the tuple of fields. '

const asksSummary = (messages: ModelMessage[]) => {
  const last = messages[messages.length - 1]!
  return isRequest(last) && last.parts.some((p) => isUserPrompt(p) && userText(p) === PROMPT_TEXT['compaction.request'])
}

function step(i: number, content: string = 'x '.repeat(200)): ModelMessage[] {
  return [
    modelResponse([toolCallPart('read_file', { path: `m${i}.py` }, `tc_${i}`)]),
    modelRequest([toolReturn('read_file', { status: 'ok', content }, `tc_${i}`)], INSTRUCTIONS),
  ]
}

const seam = (model: RequestSeam['model'], observed: RequestSeam['observed'], settings = { max_tokens: 500 }): RequestSeam =>
  ({ model, settings, params: PARAMS, instructions: INSTRUCTIONS, observed })

const facts = (marker: ModelMessage) => Object.fromEntries(FACT_NAMES.map((f) => [f, JSON.stringify(marker).includes(FACTS[f])]))
const ALL = Object.fromEntries(FACT_NAMES.map((f) => [f, true]))

/** A long summary with the facts placed as asked, each on a line of its own between two long lines of narrative. */
function placed(where: Record<Fact, 'start' | 'middle' | 'end'>): string {
  const at = (pos: string) => FACT_NAMES.filter((f) => where[f] === pos).map((f) => FACTS[f]).join('\n')
  const half = FILLER.repeat(200)
  return [at('start'), half, at('middle'), half, at('end')].filter(Boolean).join('\n')
}

test('a summary over its room keeps every short line — a constraint at its start, its middle or its end — and still fits', async () => {
  const layouts: Record<Fact, 'start' | 'middle' | 'end'>[] = [
    { forbidden: 'start', manual: 'middle', pending: 'middle', done: 'end' },
    { forbidden: 'middle', manual: 'middle', pending: 'middle', done: 'middle' },
    { done: 'start', forbidden: 'middle', manual: 'end', pending: 'end' },
  ]
  for (const where of layouts) {
    const keeper = new ContextKeeper({ window: 20_000, output_reserve: 500 })
    const limit = Math.floor(keeper.threshold * SUMMARY_SHARE)
    const summary = placed(where)
    const model = scriptedModel((m) => modelResponse([textPart(asksSummary(m) ? `<summary>${summary}</summary>` : 'ok')]))
    const messages: ModelMessage[] = [modelRequest([userPrompt('Task: tidy the parser.')], INSTRUCTIONS), ...step(0), ...step(1)]
    const [out, report] = await keeper.maybeCompact(messages, seam(model, { input_tokens: keeper.threshold + 100, messages: messages.length - 2 }))
    expect(report!.status).toBe('compacted')
    expect(report!.summary_cut_chars!).toBeGreaterThan(summary.length / 2)
    const marker = out[out.length - 1]!
    expect(facts(marker)).toEqual(ALL)
    const kept = boundedSummary(summary, limit)
    expect(Math.ceil(countTokens(kept.text) * ESTIMATE_FACTOR)).toBeLessThanOrEqual(limit)
    // each long line is cut where it stands and says how much of it was left out
    expect(kept.text.split('\n').filter((l) => l.includes("of the summary's")).length).toBe(2)
  }
})

test('a chain of four compactions whose model carries the earlier summary and adds its progress keeps every constraint', async () => {
  const keeper = new ContextKeeper({ window: 20_000, output_reserve: 500 })
  let round = 0
  const model = scriptedModel((m) => {
    if (!asksSummary(m)) return modelResponse([textPart('ok')])
    round += 1
    // the earlier summary as it reached this request (the compaction note's text after its opening), then this round's progress
    const notes = m.filter(isCompaction).map((c) => userText(c.parts[0] as never))
    const earlier = notes.length ? notes[notes.length - 1]!.slice(PROMPT_TEXT['compaction.note'].indexOf('{summary}')) : ''
    const progress = `Round ${round} progress: ${FILLER.repeat(120)}`
    return modelResponse([textPart(`<summary>${round === 1 ? `${progress}\n${Object.values(FACTS).join('\n')}` : `${earlier}\n${progress}`}</summary>`)])
  })
  let messages: ModelMessage[] = [modelRequest([userPrompt('Task: tidy the parser.')], INSTRUCTIONS), ...step(0)]
  for (let i = 1; i <= 4; i += 1) {
    // threshold 11_500, hard input budget 19_500: the 17_500-token counted prefix plus ~2_600 pending
    // result tokens crosses even the raised trigger, while omitting that result leaves room for the summary.
    messages = [...messages, ...step(i, 'x '.repeat(2_000))]
    const [out, report] = await keeper.maybeCompact(messages, seam(model, { input_tokens: 17_500, messages: messages.length - 2 }))
    expect(report!.status).toBe('compacted')
    expect(facts(out[out.length - 1]!)).toEqual(ALL)
    messages = out
  }
  expect(round).toBe(4)
})

test('a summary of many short lines that no cap would fit keeps its opening and its close, whole lines, within the room', () => {
  const lines = Array.from({ length: 2_000 }, (_, i) => `step ${i}: read m${i}.py, found nothing to change`)
  const summary = [FACTS.forbidden, ...lines, FACTS.done].join('\n')
  const limit = 2_000
  const kept = boundedSummary(summary, limit)
  expect(Math.ceil(countTokens(kept.text) * ESTIMATE_FACTOR)).toBeLessThanOrEqual(limit)
  expect(kept.text.startsWith(FACTS.forbidden)).toBe(true)
  expect(kept.text.endsWith(FACTS.done)).toBe(true)
  expect(kept.text).toContain("of the summary's")
  expect(kept.cut).toBeGreaterThan(summary.length / 2)
})

test('the summary request tells the model the room its summary has, before the request itself', async () => {
  const keeper = new ContextKeeper({ window: 20_000, output_reserve: 500 })
  const seen: ModelMessage[][] = []
  const model = scriptedModel((m) => { seen.push(m); return modelResponse([textPart('<summary>Read m0 and m1.</summary>')]) })
  const messages: ModelMessage[] = [modelRequest([userPrompt('Task: tidy the parser.')], INSTRUCTIONS), ...step(0), ...step(1)]
  await keeper.maybeCompact(messages, seam(model, { input_tokens: keeper.threshold + 100, messages: messages.length - 2 }))
  const tail = seen[0]![seen[0]!.length - 1] as ModelRequest
  const texts = tail.parts.filter(isUserPrompt).map((p) => userText(p))
  expect(texts.at(-1)).toBe(PROMPT_TEXT['compaction.request'])
  const words = Math.floor((Math.floor(keeper.threshold * SUMMARY_SHARE) / ESTIMATE_FACTOR) * 0.75)
  expect(texts.at(-2)).toBe(PROMPT_TEXT['compaction.summary_room'].replace('{words}', String(words)))
  expect(PROMPT_TEXT['compaction.request']).not.toContain('at the cost of length')
})

test("a threshold compaction carries the person's latest words; longer than their share they are cut with a note, their images left out first", async () => {
  const keeper = new ContextKeeper({ window: 20_000, output_reserve: 500 })
  const model = scriptedModel(() => modelResponse([textPart('<summary>Read m0 and m1.</summary>')]))
  const image = imagePiece({ asset_id: 'a_1', media_type: 'image/png', bytes: 3, sha256: 'abc', width: 1, height: 1, name: 'shot.png' })
  // short words with an image that fits: carried as they are
  const short: ModelMessage[] = [modelRequest([userPrompt(['Match this screenshot.', image])], INSTRUCTIONS), ...step(0), ...step(1)]
  const [out] = await keeper.maybeCompact(short, seam(model, { input_tokens: keeper.threshold + 100, messages: short.length - 2 }))
  const marker = out[out.length - 1] as ModelRequest
  expect(userText(marker.parts[1] as never)).toBe(PROMPT_TEXT['compaction.person_words'])
  expect(marker.parts[2]).toEqual((short[0] as ModelRequest).parts[0]!)
  // words far over PERSON_SHARE of the threshold: cut from the end with a note, the image left out of the copy
  const long = `Constraint first: never touch vendor/. ${'and a very long pasted log line '.repeat(3_000)}`
  const big: ModelMessage[] = [modelRequest([userPrompt([long, image])], INSTRUCTIONS), ...step(0), ...step(1)]
  const [cut] = await new ContextKeeper({ window: 20_000, output_reserve: 500 }).maybeCompact(big, seam(model, { input_tokens: keeper.threshold + 100, messages: big.length - 2 }))
  const carried = (cut[cut.length - 1] as ModelRequest).parts[2]!
  if (!isUserPrompt(carried) || !Array.isArray(carried.content)) throw new Error('the person part is a list')
  expect(carried.content).toHaveLength(1)
  const text = carried.content[0] as string
  expect(text.startsWith('Constraint first: never touch vendor/.')).toBe(true)
  expect(text).toContain(`characters shown; the summary above was written from the whole message.`)
  expect(Math.ceil(estimateMessages([modelRequest([carried])]) * ESTIMATE_FACTOR)).toBeLessThanOrEqual(Math.floor(keeper.threshold * PERSON_SHARE) + 100)
})

test("after a threshold compaction every later request carries the person's task verbatim; the protected path stays refused", async () => {
  process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = '34000'                                // threshold 10 000
  state = await appState({ sandbox: true })
  const { session, ws } = await openSession(state, buggyRepo())
  for (let i = 1; i <= 8; i += 1) writeFileSync(join(ws.path, `m${i}.py`), `def f_${i}(): pass  # line of module ${i}\n`.repeat(160))
  mkdirSync(join(ws.path, 'secrets'), { recursive: true })
  writeFileSync(join(ws.path, 'secrets', 'key.txt'), 'synthetic-secret-0001\n')
  const task = `Read m1..m8. Constraint A: never modify secrets/key.txt. Constraint B: ${FACTS.manual}. ${FACTS.pending}.`
  const requests: ModelMessage[][] = []
  let reads = 0
  let triedSecret = false
  const counted = (parts: Parameters<typeof modelResponse>[0], messages: ModelMessage[]) =>
    modelResponse(parts, { usage: { input_tokens: estimateMessages(messages) + 6_000, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 } })
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    requests.push(messages)
    // the model puts the task in the middle of a long summary, as a real model may
    if (asksSummary(messages)) return counted([textPart(`<summary>Progress: ${FILLER.repeat(150)}\n${task}\n${FILLER.repeat(150)}\nNext: read the next module.</summary>`)], messages)
    reads += 1
    if (reads <= 8) return counted([toolCallPart('read_file', { path: `m${reads}.py` }, `r${reads}`)], messages)
    if (!triedSecret) { triedSecret = true; return counted([toolCallPart('write_file', { path: 'secrets/key.txt', content: 'overwritten' }, 'w1')], messages) }
    return counted([textPart('done')], messages)
  }))
  const run = await waitDone(state, (await state.runs.start(session, task)).id, 60_000)
  expect(run.status).toBe('done')
  const compactions = repo.listEvents(state.conn, run.id).filter((e) => e.event === 'context_compacted')
  expect(compactions.length).toBeGreaterThanOrEqual(1)
  const after = requests.slice(requests.findIndex(asksSummary) + 1).filter((m) => !asksSummary(m))
  expect(after.length).toBeGreaterThan(0)
  const verbatim = JSON.stringify(task).slice(1, -1)
  for (const m of after) expect(JSON.stringify(m)).toContain(verbatim)
  expect(readFileSync(join(ws.path, 'secrets', 'key.txt'), 'utf8')).toBe('synthetic-secret-0001\n')
  const history = loadValue(JSON.parse(repo.getRunHistory(state.conn, run.id)!)) as ModelMessage[]
  expect(JSON.stringify(history[0])).toContain(verbatim)                                   // the record keeps it first, whole
  expect(history.filter(isCompaction).length).toBe(compactions.length)
})

test('a refusal right after a threshold compaction: the recovery drops the nested note and cuts the carried results, and the run goes on', async () => {
  const keeper = new ContextKeeper({ window: 200_000, output_reserve: 500 })
  const big = 'BIGLINE some large tool output near the line\n'.repeat(1_400)
  const model = scriptedModel(() => modelResponse([textPart('<summary>Asked to read big1..3; all three were read in one step.</summary>')]))
  const messages: ModelMessage[] = [
    modelRequest([userPrompt('read big1..3')], INSTRUCTIONS),
    modelResponse([1, 2, 3].map((i) => toolCallPart('read_file', { path: `big${i}.txt` }, `b${i}`))),
    modelRequest([1, 2, 3].map((i) => toolReturn('read_file', { status: 'ok', content: big }, `b${i}`)), INSTRUCTIONS),
  ]
  const [first] = await keeper.maybeCompact(messages, seam(model, { input_tokens: keeper.threshold + 100, messages: 1 }))
  const marker = first[first.length - 1] as ModelRequest
  expect(isCompaction(marker)).toBe(true)
  // the provider refuses the compaction request for its size: the one recovery compacts with the marker as the tail
  keeper.recoverFromOverflow('prompt is too long')
  const [second, report] = await keeper.maybeCompact(first, seam(model, null))
  expect(report!.status).toBe('compacted')
  expect(report!.trigger).toBe('overflow')
  const again = second[second.length - 1] as ModelRequest
  const texts = again.parts.filter(isUserPrompt).map((p) => userText(p))
  // one note (this summary's), never the earlier one nested inside
  expect(texts.filter((t) => t.startsWith('App note: The conversation so far was summarized'))).toHaveLength(1)
  // each carried result held to the recovery bound with its note; the person's words still ride
  const results = texts.filter((t) => t.startsWith('Result of tool call b'))
  expect(results).toHaveLength(3)
  for (const r of results) { expect(r.length).toBeLessThan(RECOVERY_PART_CHARS + 400); expect(r).toContain('characters shown') }
  expect(texts).toContain('read big1..3')
})

/** The provider of the scenario below refuses a request whose input plus the route's output cap is over its window.
 *  The window is chosen for margins, not at an edge. Measured 2026-10-13 (macOS, this checkout): the run's first
 *  request carries 7 676 tokens (7 383 of them the tool schemas, 92 the instructions) and is predicted at 9 979
 *  (x ESTIMATE_FACTOR); the window 34 000 this test had (threshold 10 000) left 21 tokens, so a slightly longer
 *  workspace path (a CI runner's) compacted the first request itself and the run counted two compactions. At 38 000
 *  the threshold was 14 000; the three reads are predicted near 30 000, past what the provider takes (22 000). The
 *  generate_image tool (2026-10-17) adds its schema to every request: the grown-instructions run's first request was
 *  then predicted at 13 415, over 14 000 less the 1 000 headroom. At 40 000 the threshold is 16 000 and the provider
 *  takes 24 000, which the three reads still pass. The progress element's paragraph in present_ui (2026-11-01) put the
 *  grown-instructions first request past 15 000; at 42 000 the threshold is 18 000 and the provider takes 26 000. */
const READS_WINDOW = 42_000
const READS_OUTPUT_CAP = 16_000
/** what the first request's prediction leaves below the threshold at least: fixed overhead grown past it fails this
 *  precondition by name, not as a second compaction */
const FIRST_REQUEST_HEADROOM = 1_000

async function threeLargeReads(extraRuleLines: number) {
  process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = String(READS_WINDOW)
  const threshold = compactionThreshold(READS_WINDOW, READS_OUTPUT_CAP)
  state = await appState({ sandbox: true })
  const { session, ws } = await openSession(state, buggyRepo())
  for (let i = 1; i <= 3; i += 1) writeFileSync(join(ws.path, `big${i}.txt`), `BIGLINE ${i} some large tool output near the line\n`.repeat(1_400))
  if (extraRuleLines > 0) {
    // more fixed overhead in every request of the run: the project's instructions, as a longer path or a grown tool
    // surface would add it
    const rules = join(ws.path, 'AGENTS.md')
    writeFileSync(rules, `${existsSync(rules) ? readFileSync(rules, 'utf8') : ''}\n${'Rule: keep every changed line under one hundred characters and say why.\n'.repeat(extraRuleLines)}`)
  }
  const sent: { count: number; summary: boolean }[] = []
  let normal = 0
  let refusals = 0
  // the provider counts what it is sent: the messages, the instructions and the tool schemas the run really carries
  // (not a fixed stand-in for the last two, which grow with the tool surface)
  setModel(state, 'scripted:a', new ScriptedModel((m, info) => {
    const last = m.findLast(isRequest)
    const tools = JSON.stringify(info.function_tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters_json_schema })))
    const count = estimateMessages(m) + countTokens(last?.instructions ?? '') + countTokens(tools)
    sent.push({ count, summary: asksSummary(m) })
    if (count + READS_OUTPUT_CAP > READS_WINDOW) {
      refusals += 1
      throw new ModelHTTPError(400, 'scripted-a', { error: { message: `prompt is too long: ${count} tokens + max_tokens ${READS_OUTPUT_CAP} > ${READS_WINDOW} maximum` } })
    }
    const usage = { ...emptyUsage(), input_tokens: count, output_tokens: 10 }
    if (asksSummary(m)) return modelResponse([textPart('<summary>Asked to read big1..3; all three were read in one step.</summary>')], { usage })
    normal += 1
    if (normal === 1) return modelResponse([1, 2, 3].map((i) => toolCallPart('read_file', { path: `big${i}.txt` }, `b${i}`)), { usage })
    return modelResponse([textPart('done')], { usage })
  }, { modelName: 'scripted-a', usage: emptyUsage() }))
  const run = await waitDone(state, (await state.runs.start(session, 'read big1..3')).id)
  expect(run.status).toBe('done')
  expect(refusals).toBe(0)                                                                // the compaction request fit: nothing to recover
  // the fixture's own margins, measured: the first request well under the threshold, the reads well past the window
  expect(sent[0]!.summary).toBe(false)
  expect(Math.ceil(sent[0]!.count * ESTIMATE_FACTOR)).toBeLessThanOrEqual(threshold - FIRST_REQUEST_HEADROOM)
  const compacted = repo.listEvents(state.conn, run.id).filter((e) => e.event === 'context_compacted').map((e) => e.data)
  expect(compacted).toHaveLength(1)                                                       // exactly one: the reads', not the first request's
  expect(compacted[0]!.trigger).toBe('threshold')
  expect(compacted[0]!.estimate_tokens as number).toBeGreaterThan(READS_WINDOW - READS_OUTPUT_CAP)  // without it the provider would refuse
  expect(compacted[0]!.after_tokens as number).toBeLessThanOrEqual(READS_WINDOW - READS_OUTPUT_CAP)
  // one summary request and two of the run's own, every one within the window with the output's room
  expect(sent.map((s) => s.summary)).toEqual([false, true, false])
  for (const s of sent) expect(s.count + READS_OUTPUT_CAP).toBeLessThanOrEqual(READS_WINDOW)
  return { first: sent[0]!.count }
}

test('a provider that refuses input plus output over its window: three large reads in one step are compacted into a request it takes', async () => {
  await threeLargeReads(0)
})

test('the three large reads compact once whatever fixed overhead the run carries: grown instructions move no compaction to the first request', async () => {
  const base = await threeLargeReads(0)
  await closeState(state!)
  state = null
  const grown = await threeLargeReads(140)
  // the knob is real: every request of the second run carries over a thousand more tokens
  expect(grown.first - base.first).toBeGreaterThanOrEqual(1_000)
  // and with the old window (threshold 10 000) that first request alone would have been compacted
  expect(Math.ceil(grown.first * ESTIMATE_FACTOR)).toBeGreaterThan(compactionThreshold(34_000, READS_OUTPUT_CAP))
})

test('compaction budgets new file representations in the appended copy, never mutating the covered history', async () => {
  const { attachmentPiece } = await import('../src/llm/attachments.ts')
  for (const file_kind of ['text', 'pdf', 'video'] as const) {
    const file = attachmentPiece({ asset_id: 'a_file', name: file_kind === 'text' ? 'notes.md' : file_kind === 'pdf' ? 'proof.pdf' : 'clip.mp4', file_kind,
      media_type: file_kind === 'text' ? 'text/plain' : file_kind === 'pdf' ? 'application/pdf' : 'video/mp4', representation: file_kind === 'text' ? 'utf8-v1' : 'native-v1', bytes: 500 * 1024, sha256: 'a'.repeat(64) })
    const model = scriptedModel(() => modelResponse([textPart('<summary>The file was read; keep the user constraint.</summary>')]))
    const original: ModelMessage[] = [modelRequest([userPrompt(['Never change secrets/.', file])], INSTRUCTIONS), ...step(0), ...step(1)]
    const frozen = JSON.stringify(original)
    const keeper = new ContextKeeper({ window: 20_000, output_reserve: 500 })
    const [out] = await keeper.maybeCompact(original, seam(model, { input_tokens: keeper.threshold + 100, messages: original.length - 2 }))
    const carried = (out.at(-1) as ModelRequest).parts[2]!
    expect(JSON.stringify(carried)).toContain('covered by the summary; omitted')
    expect(JSON.stringify(carried)).not.toContain('"kind":"file"')
    expect(Math.ceil(estimateMessages([modelRequest([carried])]) * ESTIMATE_FACTOR)).toBeLessThanOrEqual(Math.floor(keeper.threshold * PERSON_SHARE) + 100)
    expect(JSON.stringify(original)).toBe(frozen)
    expect(JSON.stringify(out.slice(0, original.length))).toBe(frozen)
    expect(JSON.stringify(out)).not.toContain('"data":')
    const roomy = new ContextKeeper({ window: 10_000_000, output_reserve: 500 })
    const [kept] = await roomy.maybeCompact(original, seam(model, { input_tokens: roomy.threshold + 100, messages: original.length - 2 }))
    expect((kept.at(-1) as ModelRequest).parts[2]).toEqual((original[0] as ModelRequest).parts[0]!)
  }
})

test('a compaction whose fixed part leaves the bounded tail no room for the output cuts the tail\'s results shorter until the request fits', async () => {
  // a small window: instructions and the tool schemas take much of it, so three results at RECOVERY_PART_CHARS each
  // would still leave the next request no room for its output; the keeper halves the bound until its own estimate fits
  const fixedInstructions = 'Follow the rules of this test. '.repeat(1_200)
  const keeper = new ContextKeeper({ window: 34_000, output_reserve: 16_000 })
  const big = 'BIGLINE some large tool output near the line\n'.repeat(1_400)
  const model = scriptedModel(() => modelResponse([textPart('<summary>Asked to read big1..3; all three were read in one step.</summary>')]))
  const messages: ModelMessage[] = [
    modelRequest([userPrompt('read big1..3')], fixedInstructions),
    modelResponse([1, 2, 3].map((i) => toolCallPart('read_file', { path: `big${i}.txt` }, `b${i}`))),
    modelRequest([1, 2, 3].map((i) => toolReturn('read_file', { status: 'ok', content: big }, `b${i}`)), fixedInstructions),
  ]
  const tight: RequestSeam = { model, settings: { max_tokens: 16_000 }, params: PARAMS, instructions: fixedInstructions, observed: null }
  const [out, report] = await keeper.maybeCompact(messages, tight)
  expect(report!.status).toBe('compacted')
  expect(report!.after_tokens as number).toBeLessThanOrEqual(34_000 - 16_000)
  const marker = out[out.length - 1] as ModelRequest
  const results = marker.parts.filter(isUserPrompt).map((p) => userText(p)).filter((t) => t.startsWith('Result of tool call b'))
  expect(results).toHaveLength(3)
  for (const r of results) {
    expect(r.length).toBeLessThan(RECOVERY_PART_CHARS / 2 + 400)                    // cut below the usual bound, with its note
    expect(r).toContain('characters shown')
  }
  // the record keeps every result whole
  expect(out.slice(0, 3)).toEqual(messages)
})

test('compaction keeps a PDF / video reference (ref-v1) in the appended copy as it is — its path, never its size counted — and mutates nothing before', async () => {
  const { attachmentPiece } = await import('../src/llm/attachments.ts')
  const ref = attachmentPiece({ asset_id: 'a_ref', name: 'holiday.mkv', media_type: 'video/x-matroska', bytes: 2 * 1024 ** 3, file_kind: 'video',
    representation: 'ref-v1', origin: 'local', location: '/Users/person/Movies/holiday.mkv', sha256: null })
  const model = scriptedModel(() => modelResponse([textPart('<summary>The clip was looked at; keep the user constraint.</summary>')]))
  const original: ModelMessage[] = [modelRequest([userPrompt(['Never change secrets/.', ref])], INSTRUCTIONS), ...step(0), ...step(1)]
  const frozen = JSON.stringify(original)
  const keeper = new ContextKeeper({ window: 20_000, output_reserve: 500 })
  const [out] = await keeper.maybeCompact(original, seam(model, { input_tokens: keeper.threshold + 100, messages: original.length - 2 }))
  const carried = JSON.stringify((out.at(-1) as ModelRequest).parts[2]!)
  expect(carried).toContain('"representation":"ref-v1"')
  expect(carried).toContain('/Users/person/Movies/holiday.mkv')
  expect(carried).not.toContain('covered by the summary; omitted')
  expect(estimateMessages([modelRequest([userPrompt([ref])])])).toBeLessThan(500)                    // 2 GiB counts as its note
  expect(JSON.stringify(out.slice(0, original.length))).toBe(frozen)
})
