/** A compaction keeps its summary to a share of the threshold, and one that frees too little does not come again
 *  after the very next step. Seen live on gpt-6.1-sol with a 22 000-token window (CTX-01): the instructions and
 *  tools filled most of the threshold, every compaction left the view just under it, and the run compacted after
 *  every file it read — nine times in eleven steps, each summary longer than the last. */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as repo from '../src/db/repo.ts'
import { countTokens, estimateMessages, ESTIMATE_FACTOR } from '../src/agent/context.ts'
import { BACKOFF_SHARE, boundedSummary, ContextInputTooLarge, ContextKeeper, isCompaction, SUMMARY_SHARE, type RequestSeam } from '../src/agent/history.ts'
import { isRequest, isUserPrompt, modelRequest, modelResponse, textPart, toolCallPart, toolReturn, userPrompt, userText, type ModelMessage } from '../src/llm/messages.ts'
import type { ModelRequestParameters } from '../src/llm/model.ts'
import { scriptedModel } from '../src/llm/scripted.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import { ModelConfig } from '../src/config.ts'
import { contextSeedOf } from '../src/agent/runner.ts'
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
const WORDS = 'the quick brown fox jumps over the lazy dog '

function step(i: number, size = 20): ModelMessage[] {
  return [
    modelResponse([toolCallPart('read_file', { path: `m${i}.py` }, `tc_${i}`)]),
    modelRequest([toolReturn('read_file', { status: 'ok', content: WORDS.repeat(size) }, `tc_${i}`)], INSTRUCTIONS),
  ]
}

function record(steps: number): ModelMessage[] {
  const out: ModelMessage[] = [modelRequest([userPrompt('read every module')], INSTRUCTIONS)]
  for (let i = 0; i < steps; i += 1) out.push(...step(i))
  return out
}

const asksSummary = (messages: ModelMessage[]) => {
  const last = messages[messages.length - 1]!
  return isRequest(last) && last.parts.some((p) => isUserPrompt(p) && userText(p) === PROMPT_TEXT['compaction.request'])
}

/** A model that writes the given summary when asked for one. */
function summarizer(summary: string, asked: { n: number } = { n: 0 }) {
  return scriptedModel((messages) => {
    if (asksSummary(messages)) { asked.n += 1; return modelResponse([textPart(`<summary>${summary}</summary>`)]) }
    return modelResponse([textPart('ok')])
  })
}

const seam = (model: ReturnType<typeof scriptedModel>, observed: RequestSeam['observed'] = null): RequestSeam => ({ model, settings: { max_tokens: 500 }, params: PARAMS, instructions: INSTRUCTIONS, observed })

test('a summary longer than its share of the threshold keeps its opening and its close, the middle cut with a note', async () => {
  const keeper = new ContextKeeper({ window: 20_000, output_reserve: 500 })            // threshold 11 500
  const limit = Math.floor(keeper.threshold * SUMMARY_SHARE)
  const long = `Constraints: never touch vendor/.\n${'Read m1.py: function island_lagoon found. '.repeat(600)}\nNext: C (caching) and D (TODO).`
  expect(Math.ceil(countTokens(long) * ESTIMATE_FACTOR)).toBeGreaterThan(limit)
  const messages = record(4)
  const [out, report] = await keeper.maybeCompact(messages, seam(summarizer(long), { input_tokens: 11_400, messages: messages.length - 2 }))
  expect(report!.status).toBe('compacted')
  expect(report!.summary_cut_chars).toBe(boundedSummary(long, limit).cut)
  expect(report!.summary_cut_chars!).toBeGreaterThan(long.length / 2)
  expect(report!.summary_chars).toBeLessThan(long.length)
  const marker = out[out.length - 1]!
  if (!isCompaction(marker)) throw new Error('no compaction request')
  const note = userText(marker.parts[0] as never)
  expect(note).toContain('Constraints: never touch vendor/.')
  expect(note).toContain('Next: C (caching) and D (TODO).')
  expect(note).toContain(`[${report!.summary_cut_chars} of the summary's ${long.length} characters were left out here`)
  // a summary within its share goes whole
  expect(boundedSummary('Done: A. Next: B.', limit)).toEqual({ text: 'Done: A. Next: B.', cut: 0 })
  expect(Math.ceil(countTokens(boundedSummary(long, limit).text) * ESTIMATE_FACTOR)).toBeLessThanOrEqual(limit + 50)
})

test('a compaction the provider counts above half the threshold moves the next one up by half the threshold; one that frees enough keeps the threshold', async () => {
  const keeper = new ContextKeeper({ window: 20_000, output_reserve: 500 })            // threshold 11 500, window less output 19 500
  const threshold = keeper.threshold
  const half = Math.ceil(threshold * BACKOFF_SHARE)
  const asked = { n: 0 }
  const model = summarizer('Read m0-m3. Next: m4.', asked)
  const messages = record(4)
  const [out, first] = await keeper.maybeCompact(messages, seam(model, { input_tokens: threshold - 100, messages: messages.length - 2 }))
  expect(first!.status).toBe('compacted')
  expect(first!.trigger_tokens).toBe(threshold)
  expect(asked.n).toBe(1)
  // the provider counts the first request after it at 8 000 (the instructions and tools it carries): too little was freed
  let view = [...out, ...step(10)]
  expect((await keeper.maybeCompact(view, seam(model, { input_tokens: 8_000, messages: out.length })))[1]).toBeNull()
  // over the threshold but under 8 000 + half the threshold: no summary is asked, the request goes as it is
  let sent = view.length
  view = [...view, ...step(11)]
  const [kept, quiet] = await keeper.maybeCompact(view, seam(model, { input_tokens: threshold + 200, messages: sent }))
  expect(quiet).toBeNull()
  expect(kept).toBe(view)
  expect(asked.n).toBe(1)
  // over the moved line: compacted, asked over that line
  sent = view.length
  view = [...view, ...step(12)]
  const [again, second] = await keeper.maybeCompact(view, seam(model, { input_tokens: 8_000 + half + 200, messages: sent }))
  expect(second!.status).toBe('compacted')
  expect(second!.trigger_tokens).toBe(8_000 + half)
  expect(asked.n).toBe(2)
  // this time the provider counts the view after it low: the next compaction is asked at the threshold again
  view = [...again, ...step(13)]
  expect((await keeper.maybeCompact(view, seam(model, { input_tokens: 3_000, messages: again.length })))[1]).toBeNull()
  sent = view.length
  view = [...view, ...step(14)]
  const [, third] = await keeper.maybeCompact(view, seam(model, { input_tokens: threshold + 200, messages: sent }))
  expect(third!.status).toBe('compacted')
  expect(third!.trigger_tokens).toBe(threshold)
  expect(asked.n).toBe(3)
})

test("the moved line never passes the window less the output's room", async () => {
  const keeper = new ContextKeeper({ window: 20_000, output_reserve: 500 })
  const model = summarizer('x')
  const messages = record(4)
  const [out] = await keeper.maybeCompact(messages, seam(model, { input_tokens: keeper.threshold + 100, messages: messages.length - 2 }))
  let view = [...out, ...step(10)]
  expect((await keeper.maybeCompact(view, seam(model, { input_tokens: 17_000, messages: out.length })))[1]).toBeNull()
  const sent = view.length
  view = [...view, ...step(11)]
  expect((await keeper.maybeCompact(view, seam(model, { input_tokens: 19_000, messages: sent })))[1]).toBeNull()
  // The provider-counted prefix alone now exceeds the hard input budget. Even a summary cannot be sent as-is;
  // the backoff line still stops at 19_500, but the local refusal replaces the old mock's oversized summary call.
  await expect(keeper.maybeCompact(view, seam(model, { input_tokens: 19_600, messages: sent }))).rejects.toBeInstanceOf(ContextInputTooLarge)
  expect(keeper.currentTrigger()).toBe(19_500)
  expect(keeper.lastPrediction()!.tokens).toBeGreaterThan(19_500)
})

test('a run whose instructions fill most of a small window does not compact after every file it reads', async () => {
  // a 34 000-token window with the route's 16 000-token output cap: the threshold is 10 000. The provider counts the
  // instructions and tools at about 6 000 more than the record's estimate, so each compaction leaves ~8 500 of it
  process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = '34000'
  state = await appState({ sandbox: true })
  const { session, ws } = await openSession(state, buggyRepo())
  for (let i = 1; i <= 11; i += 1) writeFileSync(join(ws.path, `m${i}.py`), `def f_${i}_x(): pass  # a line of module ${i}\n`.repeat(100))
  let reads = 0
  const counted = (parts: Parameters<typeof modelResponse>[0], messages: ModelMessage[]) =>
    modelResponse(parts, { usage: { input_tokens: estimateMessages(messages) + 6_000, output_tokens: 10 } as never })
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    if (asksSummary(messages)) return counted([textPart(`<summary>${'Read a module, found its function. '.repeat(40)}</summary>`)], messages)
    reads += 1
    return reads <= 11 ? counted([toolCallPart('read_file', { path: `m${reads}.py` }, `r${reads}`)], messages) : counted([textPart('done')], messages)
  }))
  const run = await waitDone(state, (await state.runs.start(session, 'read every module')).id, 60_000)
  expect(run.status).toBe('done')
  const events = repo.listEvents(state.conn, run.id)
  const threshold = events.find((e) => e.event === 'run_started')!.data.context_threshold_tokens as number
  expect(threshold).toBe(10_000)
  const compactions = events.filter((e) => e.event === 'context_compacted').map((e) => e.data)
  expect(compactions.every((c) => c.status === 'compacted')).toBe(true)
  // at the threshold every read after the first compaction came over it again (ten compactions in eleven reads)
  expect(compactions.length).toBeGreaterThan(1)
  expect(compactions.length).toBeLessThanOrEqual(5)
  expect(compactions.slice(1).every((c) => (c.trigger_tokens as number) > threshold)).toBe(true)
})

test('a seeded line holds the next keeper between the threshold and it; it never passes the window less the output, and a line at or under the threshold is none', async () => {
  const model = summarizer('Read m0-m3. Next: m4.')
  const messages = record(4)
  const observed = { input_tokens: 12_000, messages: messages.length - 2 }
  const seeded = new ContextKeeper({ window: 20_000, output_reserve: 500, trigger: 15_000 })
  expect(seeded.currentTrigger()).toBe(15_000)
  expect((await seeded.maybeCompact(messages, seam(model, observed)))[1]).toBeNull()
  // without the seed the same prediction is over the threshold (11 500) and a summary is asked
  const [, fresh] = await new ContextKeeper({ window: 20_000, output_reserve: 500 }).maybeCompact(messages, seam(model, observed))
  expect(fresh!.status).toBe('compacted')
  expect(new ContextKeeper({ window: 20_000, output_reserve: 500, trigger: 90_000 }).currentTrigger()).toBe(19_500)
  for (const line of [11_500, 3_000, Number.NaN, Number.POSITIVE_INFINITY, null]) expect(new ContextKeeper({ window: 20_000, output_reserve: 500, trigger: line }).currentTrigger()).toBeNull()
})

test('a run observes its last count as it ends: the anchor and the moved line the next run is seeded with stand on it', async () => {
  const keeper = new ContextKeeper({ window: 20_000, output_reserve: 500 })
  const messages = record(4)
  const [out] = await keeper.maybeCompact(messages, seam(summarizer('Read m0-m3.'), { input_tokens: keeper.threshold + 100, messages: messages.length - 2 }))
  // the request after the compaction went out and was answered: the run ends there, no request carries its count
  const ended = [...out, modelResponse([textPart('done')], { usage: { input_tokens: 9_000, output_tokens: 5 } as never })]
  expect(keeper.currentTrigger()).toBeNull()
  keeper.observeLast(ended, messages.length)
  expect(keeper.currentAnchor()).toEqual({ input_tokens: 9_000, messages: out.length })
  expect(keeper.currentTrigger()).toBe(9_000 + Math.ceil(keeper.threshold * BACKOFF_SHARE))
  // a response before the run's own messages is not this run's count
  const other = new ContextKeeper({ window: 20_000, output_reserve: 500 })
  other.observeLast(ended, ended.length)
  expect(other.currentAnchor()).toBeNull()
})

test('the moved line outlives the run: the next turn on the same route does not summarize the summary at once; another route starts afresh', async () => {
  // a 38 000-token window with the route's 16 000-token output cap: the threshold is 14 000, half of it 7 000 (the run's
  // instructions and tool schemas alone come to over 10 000: the window leaves them room under the threshold)
  process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = '38000'
  state = await appState({ sandbox: true })
  const { session, ws } = await openSession(state, buggyRepo())
  writeFileSync(join(ws.path, 'm1.py'), 'def f_1_x(): pass  # a line of module 1\n'.repeat(100))
  // the provider's counts: 13 000 for the first request, 14 500 for each after the compaction (the instructions and
  // tools fill most of this window), so the compaction frees too little and the line moves to 21 500
  let calls = 0
  let summaries = 0
  const counts = (n: number) => ({ usage: { input_tokens: n, output_tokens: 10 } as never })
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    if (asksSummary(messages)) { summaries += 1; return modelResponse([textPart('<summary>Read m1.py. Next: answer.</summary>')], counts(13_500)) }
    calls += 1
    if (calls === 1) return modelResponse([toolCallPart('read_file', { path: 'm1.py' }, 'r1')], counts(13_000))
    return modelResponse([textPart('done')], counts(14_500))
  }))
  const first = await waitDone(state, (await state.runs.start(session, 'read m1.py')).id, 60_000)
  expect(first.status).toBe('done')
  expect(summaries).toBe(1)
  expect(first.usage.context_trigger).toBe(14_500 + 7_000)
  expect(first.usage.context_anchor).toMatchObject({ input_tokens: 14_500 })
  // the next turn's first prediction (~14 500 and its words) is over the threshold but under the moved line
  const second = await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'and now?')).id, 60_000)
  expect(second.status).toBe('done')
  expect(summaries).toBe(1)
  expect(repo.listEvents(state.conn, second.id).some((e) => e.event === 'context_compacted')).toBe(false)
  expect(second.usage.context_trigger).toBe(14_500 + 7_000)
  // another route reads neither the anchor nor the line: it counts differently and has its own window
  expect(contextSeedOf(second, new ModelConfig({ id: 'scripted:b', provider: 'openai', model: 'b' }))).toEqual({ anchor: null, trigger: null })
  expect(contextSeedOf(second, new ModelConfig({ id: 'scripted:a', provider: 'anthropic', model: 'scripted-a' })).trigger).toBe(21_500)
})
