/** A provider's count is a count only when it is one: a response without usage, a usage of all zeros, and a figure
 *  that is negative, not a number or endless are no count — the request's row keeps 0 in its token columns with an
 *  unknown cost (never an estimated $0 or a negative one), the run's token totals are unknown while nothing was
 *  counted, and the context keeper anchors on none of them (nor on a count larger than the window). (QA round 2:
 *  R2-25.) Real provider mappings over a scripted fetch, scripted models at the provider boundary. */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelRequestRecord } from '@oasis-code/contract'
import { ModelConfig } from '../src/config.ts'
import * as repo from '../src/db/repo.ts'
import { ContextKeeper, type RequestSeam } from '../src/agent/history.ts'
import { mapUsage as anthropicUsage } from '../src/llm/providers/anthropic.ts'
import { countedUsage } from '../src/llm/providers/common.ts'
import { mapUsage as googleUsage } from '../src/llm/providers/google.ts'
import { mapUsage as chatUsage, OpenAIChatModel } from '../src/llm/providers/openai_chat.ts'
import { mapUsage as responsesUsage } from '../src/llm/providers/openai_responses.ts'
import { UsageMeter } from '../src/llm/usage.ts'
import { emptyUsage, isRequest, isUserPrompt, modelRequest, modelResponse, textPart, toolCallPart, toolReturn, userPrompt, userText, type ModelMessage, type RequestUsage } from '../src/llm/messages.ts'
import type { ModelRequestParameters } from '../src/llm/model.ts'
import { ScriptedModel, scriptedModel } from '../src/llm/scripted.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import { appState, buggyRepo, closeState, openSession, setModel, testConfig, waitDone, type AppState } from './harness.ts'

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
const PRICING = { input_per_mtok: 3, output_per_mtok: 15, cache_read_per_mtok: null, cache_write_per_mtok: null, source: 'test-list', version: '1' }
const PRICED = new ModelConfig({ id: 'scripted:a', label: 'Scripted A', provider: 'anthropic', model: 'scripted-a', api_key_env: 'OASIS_TEST_KEY_A', pricing: PRICING })

const asksSummary = (messages: ModelMessage[]) => {
  const last = messages[messages.length - 1]!
  return isRequest(last) && last.parts.some((p) => isUserPrompt(p) && userText(p) === PROMPT_TEXT['compaction.request'])
}

function chatStream(usageChunk: string | null): string {
  const out = [
    `data: ${JSON.stringify({ id: 'c1', model: 'gpt-c', choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'c1', model: 'gpt-c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
  ]
  if (usageChunk !== null) out.push(`data: ${usageChunk}\n\n`)
  out.push('data: [DONE]\n\n')
  return out.join('')
}

test('the provider mappings: no usage, a negative, a non-number or an endless figure is no count; zero and missing cache figures are 0', () => {
  expect(countedUsage(null)).toBeNull()
  expect(countedUsage({ input_tokens: 12, output_tokens: 3 })).toEqual({ input_tokens: 12, output_tokens: 3, cache_read_tokens: 0, cache_write_tokens: 0 })
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 'many', '']) expect(countedUsage({ input_tokens: bad, output_tokens: 3 })).toBeNull()
  expect(anthropicUsage(undefined)).toBeNull()
  expect(anthropicUsage({ input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 })).toEqual({ input_tokens: 100, cache_read_tokens: 90, cache_write_tokens: 0, output_tokens: 5, details: { anthropic_usage: 1 } })
  expect(anthropicUsage({ input_tokens: -10, output_tokens: 5 })).toBeNull()
  expect(responsesUsage(undefined)).toBeNull()
  expect(responsesUsage({ input_tokens: 1e400, output_tokens: 5 })).toBeNull()
  expect(chatUsage({ prompt_tokens: 20, completion_tokens: -2 })).toBeNull()
  expect(googleUsage({ promptTokenCount: 20, candidatesTokenCount: 4, thoughtsTokenCount: 6 })).toEqual({ input_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 10 })
  expect(googleUsage({ promptTokenCount: 20, candidatesTokenCount: 4, thoughtsTokenCount: Number.NaN })).toBeNull()
})

test('a Chat Completions stream without a usage chunk, and one whose count is 1e400, are filed with an unknown cost and no tokens', async () => {
  const bodies = [chatStream(null), chatStream('{"id":"c1","model":"gpt-c","choices":[],"usage":{"prompt_tokens":1e400,"completion_tokens":3}}'),
    chatStream('{"id":"c1","model":"gpt-c","choices":[],"usage":{"prompt_tokens":40,"completion_tokens":3}}')]
  let i = 0
  const fetchImpl = (async () => new Response(bodies[i++]!, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch
  const chat = new OpenAIChatModel('gpt-c', { apiKey: 'synthetic-key-0002', baseUrl: 'http://chat.mock/v1', fetchImpl })
  const cfg = new ModelConfig({ id: 't:chat', provider: 'openai', model: 'gpt-c', api: 'chat', base_url: 'http://chat.mock/v1', api_key_env: 'X', pricing: PRICING })
  const rows: ModelRequestRecord[] = []
  const meter = new UsageMeter(chat, cfg, 'run_t', (r) => rows.push(r), () => {})
  const messages = [modelRequest([userPrompt('hi')], 'be brief')]
  const responses = []
  for (let k = 0; k < 2; k += 1) {
    const stream = await meter.requestStream(messages, {}, PARAMS)
    for await (const _ of stream.events()) { /* drain */ }
    expect(stream.usage()).toBeNull()
    responses.push(stream.get())
  }
  for (const r of rows) expect(r).toMatchObject({ status: 'ok', input_tokens: 0, output_tokens: 0, cost_status: 'unknown', cost_usd: null })
  for (const r of responses) expect(r.usage).toBeUndefined()
  // nothing counted: the run's token totals are unknown, not 0
  expect(meter.totalsWithTokens()).toMatchObject({ requests: 2, input_tokens: null, output_tokens: null, total_tokens: null, uncounted_requests: 2, cost_status: 'unknown', cost_usd: null })
  // one counted request: its tokens are the totals (a lower bound), the cost partly unpriced
  const stream = await meter.requestStream(messages, {}, PARAMS)
  for await (const _ of stream.events()) { /* drain */ }
  expect(rows[2]).toMatchObject({ input_tokens: 40, output_tokens: 3, cost_status: 'estimated' })
  expect(meter.totalsWithTokens()).toMatchObject({ requests: 3, input_tokens: 40, output_tokens: 3, uncounted_requests: 2, cost_status: 'partial' })
})

test('a wrapped model whose usage is negative, or all zeros, is metered as uncounted, and the response passed on carries no negative count', async () => {
  const usages: RequestUsage[] = [{ ...emptyUsage(), input_tokens: -50_000, output_tokens: -10 }, emptyUsage()]
  let n = 0
  const inner = new ScriptedModel(() => modelResponse([textPart('ok')], { usage: usages[n++]! }), { modelName: 'scripted-a', usage: emptyUsage() })
  const rows: ModelRequestRecord[] = []
  const meter = new UsageMeter(inner, PRICED, 'run_t', (r) => rows.push(r), () => {})
  const negative = await meter.request([modelRequest([userPrompt('hi')], 'i')], {}, PARAMS)
  expect(negative.usage).toBeUndefined()
  await meter.request([modelRequest([userPrompt('hi')], 'i')], {}, PARAMS)
  for (const r of rows) expect(r).toMatchObject({ input_tokens: 0, output_tokens: 0, cost_status: 'unknown', cost_usd: null })
  expect(meter.totals.cost_usd).toBeNull()
  // a meter seeded with totals saved while nothing was counted starts from 0, its unknowns carried
  const again = new UsageMeter(inner, PRICED, 'run_t', () => {}, () => {}, meter.totalsWithTokens())
  expect(again.totals).toMatchObject({ requests: 2, input_tokens: 0, uncounted_requests: 2 })
})

test('the keeper anchors on no count that is not one: zero, negative, not a number, endless, or more than the window', async () => {
  const model = scriptedModel((m) => modelResponse([textPart(asksSummary(m) ? '<summary>s</summary>' : 'ok')]))
  const seam = (observed: RequestSeam['observed']): RequestSeam => ({ model, settings: { max_tokens: 500 }, params: PARAMS, instructions: INSTRUCTIONS, observed })
  for (const count of [0, -5_000, Number.NaN, Number.POSITIVE_INFINITY, 1e12, 20_001]) {
    const keeper = new ContextKeeper({ window: 20_000, output_reserve: 500 })
    const messages: ModelMessage[] = [modelRequest([userPrompt('read')], INSTRUCTIONS), modelResponse([toolCallPart('read_file', { path: 'a' }, 't1')]),
      modelRequest([toolReturn('read_file', { status: 'ok', content: 'word '.repeat(200) }, 't1')], INSTRUCTIONS)]
    const [, report] = await keeper.maybeCompact(messages, seam({ input_tokens: count, messages: 1 }))
    expect(report).toBeNull()
    expect(keeper.lastPrediction()!.basis).toBe('estimate')
    expect(keeper.currentAnchor()).toBeNull()
    expect(new ContextKeeper({ window: 20_000, output_reserve: 500, anchor: { input_tokens: count, messages: 1 } }).currentAnchor()).toBeNull()
  }
})

test('a run whose provider never reports a count: rows of unknown cost, the receipt says no tokens were reported; a huge count on every response does not summarize in a loop', async () => {
  // Leave room around the compaction trigger for random workspace/path tokenization while still compacting repeatedly.
  process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = '38000'
  state = await appState({ sandbox: true, config: { ...testConfig([PRICED]), default_model: PRICED.id } })
  const { session, ws } = await openSession(state, buggyRepo())
  for (let i = 1; i <= 8; i += 1) writeFileSync(join(ws.path, `m${i}.py`), `def f_${i}(): pass  # a line of module ${i}\n`.repeat(100))
  const script = (usage: () => RequestUsage) => {
    let reads = 0
    let summaries = 0
    const model = new ScriptedModel((messages) => {
      if (asksSummary(messages)) { summaries += 1; return modelResponse([textPart('<summary>Read some modules.</summary>')], { usage: usage() }) }
      reads += 1
      return reads <= 8 ? modelResponse([toolCallPart('read_file', { path: `m${reads}.py` }, `r${reads}`)], { usage: usage() }) : modelResponse([textPart('done')], { usage: usage() })
    }, { modelName: 'scripted-a', usage: emptyUsage() })
    return { model, summaries: () => summaries }
  }
  const silent = script(() => emptyUsage())
  setModel(state, PRICED.id, silent.model)
  // Both runs receive the same budget hint: it is part of the estimated prompt, so only usage reporting differs.
  const run = await waitDone(state, (await state.runs.start(session, 'read the modules', { budget: { requests: 30 } })).id, 60_000)
  expect(run.status).toBe('done')
  const rows = repo.listModelRequests(state.conn, run.id)
  expect(rows.every((r) => r.cost_status === 'unknown' && r.input_tokens === 0)).toBe(true)
  expect(run.usage).toMatchObject({ input_tokens: null, output_tokens: null, total_tokens: null, cost_status: 'unknown', cost_usd: null })
  expect((run.receipt.mechanical as { usage: Record<string, unknown> }).usage).toMatchObject({ input_tokens: null, output_tokens: null, uncounted_requests: rows.length })
  // every response counted at 5 000 000 tokens, the same reads in a session of their own: no anchor is taken from the
  // count, so the estimate decides as it did when nothing was counted — the same summaries, not one after every step
  const huge = script(() => ({ ...emptyUsage(), input_tokens: 5_000_000, output_tokens: 10 }))
  setModel(state, PRICED.id, huge.model)
  const other = await openSession(state, buggyRepo())
  for (let i = 1; i <= 8; i += 1) writeFileSync(join(other.ws.path, `m${i}.py`), `def f_${i}(): pass  # a line of module ${i}\n`.repeat(100))
  const next = await waitDone(state, (await state.runs.start(other.session, 'read the modules', { budget: { requests: 30 } })).id, 60_000)
  expect(next.status).toBe('done')
  expect(silent.summaries()).toBeGreaterThan(1)
  expect(huge.summaries()).toBe(silent.summaries())
  expect(repo.listModelRequests(state.conn, next.id).length).toBe(rows.length)
  // a count the 38k window could not hold is filed as not reported, never priced
  const hugeRows = repo.listModelRequests(state.conn, next.id)
  expect(hugeRows.every((r) => r.cost_status === 'unknown' && r.cost_usd === null && r.input_tokens === 0)).toBe(true)
  expect(next.usage).toMatchObject({ input_tokens: null, total_tokens: null, cost_usd: null, uncounted_requests: hugeRows.length })
})
