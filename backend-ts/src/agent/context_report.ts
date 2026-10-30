/** What the NEXT model request of a session would carry (adapted from oasis agent/context_report.py, see NOTICE) —
 *  the fixed instructions, the tool schemas, the conversation's working view (the record from its last compaction
 *  on) — in TOKENS first (counted with tiktoken's o200k_base on the very text the harness assembles, for a route
 *  whose vocabulary that is), bytes alongside, plus what the provider reported for the last run, its prompt-cache
 *  series per request (from the harness's own per-request records, so the scope is the run by construction), the
 *  route's window and the compaction threshold.
 *
 *  Three measures are kept apart: the STORED RECORD (the dump of the history, which repeats the instructions on
 *  every stored request), the CONTENT PROXY (the same dump with that repeated field cleared — still the record,
 *  with per-response metadata that is never sent) and the provider's TOKENS (input_tokens, which already include
 *  cache reads and writes). Nothing here is guessed: a count needs the route's tokenizer, and the estimate is the
 *  context keeper's own prediction for the next request (the one a compaction is decided on), labelled as such. */

import { CONTEXT_REPORT_SCHEMA, type ContextReport, type Run } from '@oasis-code/contract'
import type { AppState } from '../api/state.ts'
import type { ModelConfig } from '../config.ts'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { mainHeadRun } from './collab.ts'
import { findModel } from '../llm/catalog.ts'
import { isRequest, isResponse, isToolReturn, isUserPrompt, loadValue, type ModelMessage } from '../llm/messages.ts'
import { CONTEXT_MARGIN, countTokens, encoderOrNull, ESTIMATE_FACTOR, resolveWindow, WINDOW_SHARE, wireText } from './context.ts'
import { compactionCount, ContextKeeper, messageContentBytes, outputReserve, workingView } from './history.ts'
import { INSTRUCTIONS } from './instructions.ts'
import { contextSeedOf, routeFileCost } from './runner.ts'
import { toolSchemaRows, visibleToolNames } from './tools/registry.ts'

export { CONTEXT_REPORT_SCHEMA }
export type { ContextReport }
export const TOKENIZER = 'o200k_base'
export type Counter = (text: string) => number
// tests (and a deployment that knows better) install a counter for a route id here
export const COUNTER_OVERRIDES = new Map<string, [Counter, string]>()

/** [counter, its label, a note] for the route the next request goes to: an OpenAI route counts locally with
 *  o200k_base; an Anthropic route's tokenizer is not public — no count (the keeper's prediction stands in,
 *  labelled) unless a counter was installed for it; any other route gets no count. */
export function resolveCounter(cfg: ModelConfig | null): [Counter | null, string | null, string] {
  const modelId = cfg ? cfg.id : null
  const installed = modelId !== null ? COUNTER_OVERRIDES.get(modelId) : undefined
  if (installed) return [installed[0], installed[1], `counted with ${installed[1]} (installed for ${modelId})`]
  if (cfg === null || cfg.provider === 'openai') {
    if (encoderOrNull() === null) return [null, null, `tiktoken ${TOKENIZER} is not available here, so no tokens are counted`]
    return [countTokens, TOKENIZER, `counted with tiktoken ${TOKENIZER} (the OpenAI vocabulary; ${modelId ?? 'openai'})`]
  }
  if (cfg.provider === 'anthropic') return [null, null, `Anthropic's tokenizer is not public and no counter is installed for ${modelId}, so no tokens are counted`]
  return [null, null, `no tokenizer known for ${modelId}, so no tokens are counted`]
}

/** Counted tokens of every part's text on the wire, as one text (instructions not included: they go once, as the instructions segment). */
export function messageTokens(messages: ModelMessage[], counter: Counter | null): number | null {
  if (counter === null) return null
  return counter(wireText(messages))
}

/** The name / description / input-schema JSON of each visible tool, the way the byte stats measure it. */
export function toolSchemaPayloads(names: string[]): string[] {
  return toolSchemaRows(names).map((row) => JSON.stringify(row))
}

function historySection(historyJson: string | null, messages: ModelMessage[], counter: Counter | null): Record<string, unknown> {
  const base = {
    bytes_basis: 'raw_bytes: the stored record; content_bytes: the record with the per-request instructions field '
      + "cleared — a proxy for the conversation's size that still carries record metadata (usage, provider "
      + 'ids, timestamps); wire_bytes: the same proxy of the working view (the record from its last compaction on) '
      + "— what a request carries; none of these is the sent content, the provider's request size or tokens",
  }
  if (!historyJson) {
    return { messages: 0, raw_bytes: 0, content_bytes: 0, wire_bytes: 0, wire_tokens: counter !== null ? 0 : null, compactions: 0, tool_returns: 0, model_turns: 0, user_turns: 0, ...base }
  }
  const wire = workingView(messages)
  return {
    messages: messages.length, raw_bytes: Buffer.byteLength(historyJson, 'utf8'), content_bytes: messageContentBytes(messages), wire_bytes: messageContentBytes(wire),
    wire_tokens: messageTokens(wire, counter), compactions: compactionCount(messages),
    tool_returns: messages.filter(isRequest).flatMap((m) => m.parts).filter(isToolReturn).length,
    model_turns: messages.filter(isResponse).length,
    user_turns: messages.filter(isRequest).flatMap((m) => m.parts).filter(isUserPrompt).length,
    ...base,
  }
}

/** Per-request provider usage from the harness's own records (model_requests): how much of each request's input
 *  was read from / written to the prompt cache. input includes cache_read and cache_write (the inclusive
 *  convention). Failed requests carry no usage and are left out, and so are requests the provider reported no count
 *  for (filed with all-zero columns). */
export function cacheSeries(conn: Conn, runId: string): Record<string, number | null>[] {
  return repo.listModelRequests(conn, runId).filter((r) => r.status === 'ok' && r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens > 0)
    .map((r) => ({ seq: r.seq, input: r.input_tokens, cache_read: r.cache_read_tokens, cache_write: r.cache_write_tokens, output: r.output_tokens, latency_ms: r.latency_ms }))
}

/** The last run's cache figures. The series comes from the run's own per-request records, so its scope is the run
 *  by construction; the run's aggregate is still checked against it, and a mismatch is said, not hidden. */
function runCache(usage: Record<string, unknown>, series: Record<string, number | null>[]): Record<string, unknown> {
  const requests = Math.trunc(Number(usage.requests ?? 0) || 0)
  if (!series.length) return { scope: 'no_requests', requests, recorded_requests: 0, hit_rate: null, write_rate: null, series: [], note: 'no successful request recorded for this run' }
  const totalIn = series.reduce((a, s) => a + (s.input ?? 0), 0)
  const read = series.reduce((a, s) => a + (s.cache_read ?? 0), 0)
  const write = series.reduce((a, s) => a + (s.cache_write ?? 0), 0)
  const mismatch: string[] = []
  for (const [key, field] of [['input', 'input_tokens'], ['cache_read', 'cache_read_tokens'], ['cache_write', 'cache_write_tokens'], ['output', 'output_tokens']] as const) {
    if (typeof usage[field] === 'number' && series.reduce((a, s) => a + (s[key] ?? 0), 0) !== usage[field]) mismatch.push(key)
  }
  const note = `rates over this run's own ${series.length} recorded request(s); input includes cache reads and writes`
    + (mismatch.length ? `; the run's aggregate disagrees on ${mismatch.join(', ')} (the per-request records are shown)` : '')
  const round4 = (x: number) => Math.round(x * 1e4) / 1e4
  return { scope: 'this run', requests, recorded_requests: series.length, hit_rate: totalIn ? round4(read / totalIn) : null, write_rate: totalIn ? round4(write / totalIn) : null, series: series.slice(-60), note }
}

function lastRunOf(conn: Conn, run: Run | null): Record<string, unknown> | null {
  if (run === null) return null
  const usage = run.usage
  const series = cacheSeries(conn, run.id)
  const keys = ['requests', 'tool_calls', 'input_tokens', 'output_tokens', 'total_tokens', 'cache_read_tokens', 'cache_write_tokens', 'model', 'configured_model',
    'cost_usd', 'cost_cny', 'cost_status', 'history_bytes', 'history_content_bytes', 'history_wire_bytes', 'history_compactions', 'segments']
  const records = repo.listModelRequests(conn, run.id)
  const lastOk = [...records].reverse().find((r) => r.status === 'ok')
  return {
    run_id: run.id, status: run.status, created_at: run.created_at, cache: runCache(usage, series),
    last_request_input_tokens: series.length ? series[series.length - 1]!.input : null,
    last_request_context_estimate: lastOk ? lastOk.context_estimate_tokens : null,
    tokens_basis: 'input_tokens includes cache_read_tokens and cache_write_tokens (the inclusive convention); cache_read_tokens is the subset read from the prompt cache',
    ...Object.fromEntries(keys.filter((k) => k in usage).map((k) => [k, usage[k]])),
  }
}

/** The report for a session's thread: what its next request carries. */
export function contextReport(state: AppState, sessionId: string, modelIdIn: string | null = null): ContextReport {
  const conn = state.conn
  const session = repo.getSession(conn, sessionId)
  if (session === null) throw new Error(sessionId)
  const run = mainHeadRun(state, sessionId)
  const lastRun = lastRunOf(conn, run)
  const modelId = modelIdIn || (lastRun?.model as string | undefined) || session.model
  const cfg = findModel(state.config, modelId)
  const [counter, tokenizer, counterNote] = resolveCounter(cfg)
  const fallback = state.config.context_window_fallback_tokens
  const resolved = cfg ? resolveWindow(cfg, fallback) : { window: fallback, source: `assumed ${fallback.toLocaleString('en-US')} tokens (unknown route ${modelId})`, known: false }
  const reserve = outputReserve({ max_tokens: cfg?.max_tokens })
  // the keeper the next run on this record and route starts with: its anchor and its compaction line
  const seed = run !== null && cfg !== null ? contextSeedOf(run, cfg) : { anchor: null, trigger: null }
  const keeper = new ContextKeeper({ window: resolved.window, output_reserve: reserve, anchor: seed.anchor, trigger: seed.trigger, file_cost: cfg !== null ? routeFileCost(cfg) : undefined })
  const raised = keeper.currentTrigger()
  const budget = raised ?? keeper.threshold
  const budgetSource = `the smaller of ${WINDOW_SHARE * 100} % of the window and the window less the output reserve (${reserve.toLocaleString('en-US')}) and a margin of ${CONTEXT_MARGIN.toLocaleString('en-US')} tokens`
    + (raised !== null ? `, raised to ${raised.toLocaleString('en-US')} after a compaction that freed too little` : '')
  const text = INSTRUCTIONS
  const names = [...visibleToolNames({ order: null })].sort()
  const payloads = toolSchemaPayloads(names)
  const schemaBytes = payloads.reduce((a, p) => a + Buffer.byteLength(p, 'utf8'), 0)
  const historyJson = run !== null ? repo.getRunHistory(conn, run.id) : null
  const messages: ModelMessage[] = historyJson ? loadValue(JSON.parse(historyJson)) : []
  const history = historySection(historyJson, messages, counter)
  const instructionTokens = countTokens(text)
  const schemaTokens = countTokens(JSON.stringify(toolSchemaRows(names)))
  const estimated = keeper.estimate(messages, () => instructionTokens + schemaTokens)
  // a run still at work has stored no anchor yet: the keeper's own prediction for its latest request (anchored on the
  // provider's counts as the run goes) is the closer figure than an estimate of the whole record
  const latest = lastRun?.last_request_context_estimate
  const running = estimated.basis === 'estimate' && run?.model === modelId && typeof latest === 'number' && latest > 0
  const prediction = running ? { tokens: latest, basis: 'latest_request' as const } : estimated
  const fixedEst = { instructions: Math.ceil(instructionTokens * ESTIMATE_FACTOR), tool_schemas: Math.ceil(schemaTokens * ESTIMATE_FACTOR) }
  // each part rounded up on its own can pass the prediction (the whole rounded up once) by a token: the tools give it back
  if (fixedEst.instructions + fixedEst.tool_schemas === prediction.tokens + 1) fixedEst.tool_schemas -= 1
  const segments: Record<string, unknown>[] = [
    { key: 'instructions', label: 'Fixed instructions', bytes: Buffer.byteLength(text, 'utf8'), tokens: counter ? counter(text) : null, sent: 'every request', note: 'the system instructions (sent once per request)' },
    { key: 'tool_schemas', label: 'Tool schemas', bytes: schemaBytes, tokens: counter ? counter(payloads.join('\n')) : null, sent: 'every request', count: names.length,
      note: "name + description + input schema per tool (counted on the harness's JSON of them; the provider's own framing adds a little)" },
    { key: 'history', label: 'Conversation (working view, instructions cleared)', bytes: history.wire_bytes, tokens: history.wire_tokens, sent: 'every request', count: history.messages,
      note: `${history.user_turns} user turn(s), ${history.model_turns} model turn(s), ${history.tool_returns} tool result(s); `
        + `a proxy: the record from its last compaction on (${history.compactions} compaction(s) in the record) in the record's `
        + `JSON with the per-request instructions field cleared, record metadata still counted — not the provider request; `
        + `${history.content_bytes} bytes of the whole record, ${history.raw_bytes} bytes as stored` },
  ]
  const total = segments.reduce((a, s) => a + (s.bytes as number), 0)
  const counted = segments.every((s) => s.tokens !== null && s.tokens !== undefined)
  const totalTokens = counted ? segments.reduce((a, s) => a + (s.tokens as number), 0) : null
  const round4 = (x: number) => Math.round(x * 1e4) / 1e4
  // the fixed part's scaled estimate, and the conversation as the rest of the prediction: the segments add up to it
  const segmentEst: Record<string, number> = { ...fixedEst, history: Math.max(0, prediction.tokens - fixedEst.instructions - fixedEst.tool_schemas) }
  for (const segment of segments) {
    segment.share = counted && totalTokens ? round4((segment.tokens as number) / totalTokens) : total ? round4((segment.bytes as number) / total) : 0
    segment.tokens_est = segmentEst[segment.key as string]!
  }
  const estimateBasis = prediction.basis === 'latest_request'
    ? `the context keeper's prediction for the run's latest request, anchored on the provider's counts during the run; the instructions and tools are estimated with ${TOKENIZER} ×${ESTIMATE_FACTOR}, the conversation is the rest`
    : prediction.basis === 'anchor'
    ? `the context keeper's prediction for the next request: the provider's count of the last run's last request plus the estimate of the ${messages.length - (seed.anchor?.messages ?? 0)} message(s) after it (×${ESTIMATE_FACTOR}); the instructions and tools are estimated with ${TOKENIZER} ×${ESTIMATE_FACTOR}, the conversation is the rest`
    : `the context keeper's prediction for the next request: the instructions, the tools and the working view estimated with ${TOKENIZER} ×${ESTIMATE_FACTOR} (no provider count on this record and route to anchor on)`
  const reported = lastRun?.last_request_input_tokens as number | null | undefined
  const tokensBasis = counted
    ? `${counterNote}, on the text the harness assembles (instructions once, the tools' JSON, every message part's text on the wire)`
      + (reported ? `; the provider reported ${reported.toLocaleString('en-US')} input tokens on the last run's last request` : '')
    : `${counterNote}; the estimate is the context keeper's prediction`
  return {
    schema_version: CONTEXT_REPORT_SCHEMA, session_id: sessionId, model_id: modelId, total_bytes: total, total_tokens: totalTokens, tokenizer: counted ? tokenizer : null,
    context_window: resolved.known ? resolved.window : null, context_window_source: resolved.source, budget_tokens: budget, budget_source: budgetSource,
    budget_note: 'the record is only appended to; when the next request is predicted to exceed this threshold the model summarizes the '
      + 'conversation and reads on from the summary (the record keeps every earlier message); between compactions every request is a prefix extension of the previous one',
    tokens_basis: tokensBasis,
    bytes_basis: 'the record\'s JSON of what the harness assembles: instructions once, tool schemas, and a proxy for the '
      + "conversation's working view (the stored record from its last compaction on, with the repeated instructions cleared, record metadata "
      + "still counted); not the provider's wire bytes, not the sent content and not tokens",
    tokens_est: prediction.tokens, estimate_basis: estimateBasis,
    segments, per_message: ['the workspace line', "project instructions (a thread's first request)", 'session grants', 'hard limits', 'harness notes (handoff, recovery)', 'your request'],
    tools: names, history, last_run: lastRun,
  } as ContextReport
}
