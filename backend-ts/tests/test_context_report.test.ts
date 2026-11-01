/** The context report (adapted from oasis tests/test_context_report.py, see NOTICE): bytes per segment of the next
 *  request, tokens only when the route's tokenizer is at hand (an Anthropic route is not counted with the OpenAI
 *  vocabulary), the last run's cache series from the harness's own per-request records, the context keeper's
 *  prediction for the next request (anchored on the provider's last count when the route is the same), the window as
 *  configured or assumed, and the compaction threshold under it. */

import { afterEach, expect, test } from 'bun:test'
import { compactionThreshold, encoderOrNull, ESTIMATE_FACTOR, estimateMessages } from '../src/agent/context.ts'
import * as cr from '../src/agent/context_report.ts'
import { contextReport as referenceReport } from './context_report_reference.ts'
import { reportMessages } from './context_report_fixture.ts'
import { INSTRUCTIONS } from '../src/agent/instructions.ts'
import { ModelConfig } from '../src/config.ts'
import * as repo from '../src/db/repo.ts'
import { loadValue, textPart, toolCallPart } from '../src/llm/messages.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, steps, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

const byKey = (report: cr.ContextReport) => Object.fromEntries(report.segments.map((s) => [s.key, s]))

test('an empty session reports the static segments', async () => {
  state = await appState()
  const { session } = await openSession(state, buggyRepo())
  const report = referenceReport(state, session.id)
  expect(cr.contextReport(state, session.id)).toEqual(report)
  expect(await cr.contextReportAsync(state, session.id)).toEqual(report)
  expect(report.schema_version).toBe(cr.CONTEXT_REPORT_SCHEMA)
  expect(report.model_id).toBe('scripted:a')
  const seg = byKey(report)
  expect(Object.keys(seg)).toEqual(['instructions', 'tool_schemas', 'history'])
  expect(seg.instructions!.bytes).toBe(Buffer.byteLength(INSTRUCTIONS, 'utf8'))
  expect(seg.instructions!.bytes).toBeGreaterThan(500)                         // the short instructions (under 1 KB since the surface refactor)
  expect(seg.tool_schemas!.bytes).toBeGreaterThan(1000)
  expect(seg.tool_schemas!.count).toBe(report.tools.length)
  expect(report.tools.length).toBe(21)                                          // read, write, edit, bash (+ output, stop), web search, fetch, watch, computer (observe, act), present_ui, read_ui, request_input, return_ui_result, generate_image, the five SSH tools
  expect(seg.history!.bytes).toBe(0)
  expect(seg.history!.count).toBe(0)
  expect(Math.abs(report.segments.reduce((a, s) => a + s.share, 0) - 1)).toBeLessThan(0.01)
  expect(report.last_run).toBeNull()
  // no provider count to anchor on: the keeper estimates the whole request, and the segments add up to it
  expect(report.tokens_est).toBeGreaterThan(seg.instructions!.tokens_est)
  expect(report.segments.reduce((a, s) => a + s.tokens_est, 0)).toBe(report.tokens_est)
  expect(report.estimate_basis).toContain('no provider count')
  // scripted:a is an Anthropic route: its tokenizer is not public, so nothing is counted and the report says why
  expect(report.total_tokens).toBeNull()
  expect(report.tokenizer).toBeNull()
  expect(report.tokens_basis).toContain('not public')
  expect(report.context_window).toBeNull()                                          // assumed, not the route's
  expect(report.context_window_source).toStartWith('assumed 120,000 tokens')
  expect(report.budget_tokens).toBe(compactionThreshold(state.config.context_window_fallback_tokens, 16_000))
  expect(report.budget_tokens).toBe(96_000)
  expect(report.budget_source).toContain('output reserve')
  expect(report.budget_note).toContain('prefix extension')
  expect(report.history.compactions).toBe(0)
  expect(report.bytes_basis).toContain('not tokens')
})

test('an OpenAI route is counted and a counter can be installed', async () => {
  state = await appState()
  const { session } = await openSession(state, buggyRepo())
  const report = referenceReport(state, session.id, 'scripted:b')
  expect(cr.contextReport(state, session.id, 'scripted:b')).toEqual(report)
  expect(await cr.contextReportAsync(state, session.id, 'scripted:b')).toEqual(report)
  if (encoderOrNull() !== null) {
    const seg = byKey(report)
    expect(report.tokenizer).toBe('o200k_base')
    expect(seg.instructions!.tokens!).toBeGreaterThan(50)                     // the 505-character system text, counted
    expect(report.total_tokens).toBe(report.segments.reduce((a, s) => a + (s.tokens ?? 0), 0))
    expect(seg.instructions!.share).toBe(Math.round((seg.instructions!.tokens! / report.total_tokens!) * 10000) / 10000)
  }
  cr.COUNTER_OVERRIDES.set('scripted:a', [(text) => Math.floor(text.length / 3), 'fake-claude-counter'])
  let counted: cr.ContextReport
  try {
    counted = referenceReport(state, session.id, 'scripted:a')
    expect(cr.contextReport(state, session.id, 'scripted:a')).toEqual(counted)
    expect(await cr.contextReportAsync(state, session.id, 'scripted:a')).toEqual(counted)
  } finally { cr.COUNTER_OVERRIDES.delete('scripted:a') }
  expect(counted.tokenizer).toBe('fake-claude-counter')
  expect(counted.tokens_basis).toContain('installed for scripted:a')
  expect(byKey(counted).instructions!.tokens).toBe(Math.floor(INSTRUCTIONS.length / 3))
})

function record(st: AppState, runId: string, seq: number, inputTokens: number, cacheRead: number, cacheWrite = 0, output = 5, status = 'ok') {
  repo.insertModelRequest(st.conn, {
    id: `mr_${runId.slice(-6)}_${seq}`, run_id: runId, seq, model_id: 'scripted:a', configured_model: 'scripted-a', provider_reported_model: 'scripted-a',
    endpoint: 'x', started_at: 't', latency_ms: 10, input_tokens: inputTokens, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite,
    cost_usd: null, cost_status: 'unknown', cost_source: null, status, error: null, tool_schema_sha256: null, message_count: 0, context_estimate_tokens: null,
  })
}

test("the last run's cache series comes from its own records; the estimate stands on its last count", async () => {
  state = await appState()
  setModel(state, 'scripted:a', scriptedModel(steps([toolCallPart('read_file', { path: 'calc.py' }, '')], [textPart('read')])))
  const { session } = await openSession(state, buggyRepo())
  const run = await waitDone(state, (await state.runs.start(session, 'read calc.py')).id)
  expect(run.usage.history_wire_bytes as number).toBeGreaterThan(0)
  expect(run.usage.history_content_bytes as number).toBeGreaterThanOrEqual(run.usage.history_wire_bytes as number)
  // the scripted model reports its own (tiny) usage; replace the per-request records with a known series
  state.conn.run('DELETE FROM model_requests WHERE run_id=?', [run.id])
  record(state, run.id, 1, 3000, 0, 2900)
  record(state, run.id, 2, 3400, 2900, 400)
  record(state, run.id, 3, 0, 0, 0, 5, 'error')
  // the provider counted 20,000 for the request that held the first three messages (instructions and tools included):
  // the next request is that and the rest
  const usage: Record<string, unknown> = { ...run.usage, requests: 2, input_tokens: 6400, cache_read_tokens: 2900, cache_write_tokens: 3300, output_tokens: 10, context_anchor: { input_tokens: 20_000, messages: 3 } }
  state.conn.run('UPDATE runs SET usage_json=? WHERE id=?', [JSON.stringify(usage), run.id])
  const report = referenceReport(state, session.id)
  expect(cr.contextReport(state, session.id)).toEqual(report)
  expect(await cr.contextReportAsync(state, session.id)).toEqual(report)
  const cache = report.last_run!.cache
  expect(cache.scope).toBe('this run')
  expect(cache.recorded_requests).toBe(2)
  expect(cache.series.map((s) => s.seq)).toEqual([1, 2])
  expect(cache.hit_rate).toBe(Math.round((2900 / 6400) * 10000) / 10000)
  expect(cache.write_rate).toBe(Math.round((3300 / 6400) * 10000) / 10000)
  expect(cache.note).not.toContain('disagrees')
  expect(report.last_run!.last_request_input_tokens).toBe(3400)
  const messages = loadValue(JSON.parse(repo.getRunHistory(state.conn, run.id)!))
  expect(report.tokens_est).toBe(20_000 + Math.ceil(estimateMessages(messages.slice(3)) * ESTIMATE_FACTOR))   // not the mean over the run's requests
  expect(report.estimate_basis).toContain("provider's count of the last run's last request")
  expect(report.segments.reduce((a, s) => a + s.tokens_est, 0)).toBe(report.tokens_est)
  // another route counts differently: its next request is estimated whole
  expect(cr.contextReport(state, session.id, 'scripted:b').estimate_basis).toContain('no provider count')
  expect(report.history.messages).toBe(4)
  expect(report.history.tool_returns).toBe(1)
  expect(report.history.user_turns).toBe(1)
  // a compaction that freed too little moved the line: the report says where the next one waits
  state.conn.run('UPDATE runs SET usage_json=? WHERE id=?', [JSON.stringify({ ...usage, context_trigger: 100_000 }), run.id])
  const raised = referenceReport(state, session.id)
  expect(await cr.contextReportAsync(state, session.id)).toEqual(raised)
  expect(raised.budget_tokens).toBe(100_000)
  expect(raised.budget_source).toContain('raised to 100,000')
  // an aggregate that the records do not reproduce is named, not hidden
  usage.cache_read_tokens = 1
  state.conn.run('UPDATE runs SET usage_json=? WHERE id=?', [JSON.stringify(usage), run.id])
  expect(cr.contextReport(state, session.id).last_run!.cache.note).toContain('disagrees on cache_read')
})

test("a run still at work (no anchor stored yet) shows the keeper's prediction for its latest request, not an estimate of the whole record", async () => {
  state = await appState()
  setModel(state, 'scripted:a', scriptedModel(steps([toolCallPart('read_file', { path: 'calc.py' }, '')], [textPart('read')])))
  const { session } = await openSession(state, buggyRepo())
  const run = await waitDone(state, (await state.runs.start(session, 'read calc.py')).id)
  // as it stands while the run works: no anchor in its usage, its requests recorded with the keeper's prediction
  const usage: Record<string, unknown> = { ...run.usage }
  delete usage.context_anchor
  state.conn.run('UPDATE runs SET usage_json=? WHERE id=?', [JSON.stringify(usage), run.id])
  state.conn.run('DELETE FROM model_requests WHERE run_id=?', [run.id])
  record(state, run.id, 1, 3000, 0)
  state.conn.run('UPDATE model_requests SET context_estimate_tokens=? WHERE run_id=?', [41_234, run.id])
  const report = referenceReport(state, session.id)
  expect(cr.contextReport(state, session.id)).toEqual(report)
  expect(await cr.contextReportAsync(state, session.id)).toEqual(report)
  expect(report.tokens_est).toBe(41_234)
  expect(report.estimate_basis).toContain("latest request")
  expect(report.segments.reduce((a, s) => a + s.tokens_est, 0)).toBe(report.tokens_est)
  // another route's next request is still estimated whole
  expect(cr.contextReport(state, session.id, 'scripted:b').estimate_basis).toContain('no provider count')
})


test('async snapshots do not mix later history, usage, model configuration, or replaced same-label counters', async () => {
  state = await appState()
  setModel(state, 'scripted:a', scriptedModel(steps([textPart('synthetic reply')])))
  const { session } = await openSession(state, buggyRepo())
  const run = await waitDone(state, (await state.runs.start(session, 'synthetic prompt')).id)
  const cfgIndex = state.config.models.findIndex((model) => model.id === 'scripted:a')
  const cfg = state.config.models[cfgIndex]!
  try {
    cr.COUNTER_OVERRIDES.set('scripted:a', [(text) => text.length, 'same-label'])
    const expectedFirst = referenceReport(state, session.id)
    const first = cr.contextReportAsync(state, session.id)
    // Same label, different function: pure worker work MAY coalesce, but the callback/result must not.
    cr.COUNTER_OVERRIDES.set('scripted:a', [(text) => text.length + 100, 'same-label'])
    const expectedSecond = referenceReport(state, session.id)
    const second = cr.contextReportAsync(state, session.id)
    // Mutate all DB/config sources before either pending call can finish. The report may be late, not mixed.
    state.conn.run('UPDATE runs SET history_json=?, usage_json=? WHERE id=?', [JSON.stringify(reportMessages()), JSON.stringify({ context_anchor: { input_tokens: 30_000, messages: 1 }, context_trigger: 110_000 }), run.id])
    state.config.models[cfgIndex] = new ModelConfig({ ...cfg, context_window: 240_000 })
    cr.COUNTER_OVERRIDES.delete('scripted:a')
    const expectedThird = referenceReport(state, session.id)
    const third = cr.contextReportAsync(state, session.id)
    const [a, b, c] = await Promise.all([first, second, third])
    expect(a).toEqual(expectedFirst)
    expect(b).toEqual(expectedSecond)
    expect(c).toEqual(expectedThird)
    expect(a.total_tokens).not.toBe(b.total_tokens)
    expect(c.history.raw_bytes).not.toBe(a.history.raw_bytes)
    // No global old-count cache can be populated by a late response.
    expect(await cr.contextReportAsync(state, session.id)).toEqual(expectedThird)
  } finally {
    cr.COUNTER_OVERRIDES.delete('scripted:a')
    state.config.models[cfgIndex] = cfg
  }
})
