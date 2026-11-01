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
import { findModel, routeLimits } from '../llm/catalog.ts'
import { resolveWindow } from './context.ts'
import { outputReserve } from './history.ts'
import { INSTRUCTIONS } from './instructions.ts'
import { contextSeedOf } from './runner.ts'
import { toolSchemaRows, visibleToolNames } from './tools/registry.ts'
import { computeContextReport, finishInstalledCounter, resolveReportCounter, type ContextReportInput, type Counter } from './context_report_compute.ts'
import { ContextReportWorker } from './context_report_worker_client.ts'

export { CONTEXT_REPORT_SCHEMA }
export type { ContextReport, Counter }
export { TOKENIZER, messageTokens } from './context_report_compute.ts'
// tests (and a deployment that knows better) install a counter for a route id here
export const COUNTER_OVERRIDES = new Map<string, [Counter, string]>()
export function resolveCounter(cfg: ModelConfig | null): [Counter | null, string | null, string] {
  return resolveReportCounter(cfg, cfg ? COUNTER_OVERRIDES.get(cfg.id) : undefined)
}

/** The name / description / input-schema JSON of each visible tool, the way the byte stats measure it. */
export function toolSchemaPayloads(names: string[]): string[] {
  return toolSchemaRows(names).map((row) => JSON.stringify(row))
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

/** Read once, without any await. Raw history stays a string here: JSON.parse/loadValue, wireText and the
 * byte proxies run in the worker. Never give DbReadCache an asynchronous loader, or re-read DB state on return. */
function reportSnapshot(state: AppState, sessionId: string, modelIdIn: string | null): { input: ContextReportInput; counter: Counter | undefined } {
  const conn = state.conn
  const session = repo.getSession(conn, sessionId)
  if (session === null) throw new Error(sessionId)
  const run = mainHeadRun(state, sessionId)
  const lastRun = lastRunOf(conn, run)
  const modelId = modelIdIn || (lastRun?.model as string | undefined) || session.model
  const cfg = findModel(state.config, modelId)
  const installed = cfg ? COUNTER_OVERRIDES.get(cfg.id) : undefined
  const fallback = state.config.context_window_fallback_tokens
  const resolved = cfg ? resolveWindow(cfg, fallback) : { window: fallback, source: `assumed ${fallback.toLocaleString('en-US')} tokens (unknown route ${modelId})`, known: false }
  const names = [...visibleToolNames({ order: null })].sort()
  // Small metadata is detached from mutable configuration/usage before the first await. The large history is
  // already immutable text and is not parsed, re-encoded or JSON-stringified to form an in-flight key.
  const metadata = structuredClone({
    sessionId, modelId, route: cfg ? { id: cfg.id, provider: cfg.provider, capabilities: cfg.capabilities } : null,
    fileLimits: cfg ? routeLimits(cfg) : null, resolved, reserve: outputReserve({ max_tokens: cfg?.max_tokens }),
    seed: run !== null && cfg !== null ? contextSeedOf(run, cfg) : { anchor: null, trigger: null },
    runModel: run?.model ?? null, lastRun, text: INSTRUCTIONS, names, payloads: toolSchemaPayloads(names),
    schemaEstimateText: JSON.stringify(toolSchemaRows(names)), installedLabel: installed?.[1] ?? null,
  })
  return { input: { ...metadata, historyJson: run !== null ? repo.getRunHistory(conn, run.id) : null }, counter: installed?.[0] }
}

/** Synchronous compatibility/reference entry; HTTP uses contextReportAsync, never this entry. */
export function contextReport(state: AppState, sessionId: string, modelIdIn: string | null = null): ContextReport {
  const { input, counter } = reportSnapshot(state, sessionId, modelIdIn)
  return computeContextReport(input, counter).report
}

const reportWorker = new ContextReportWorker()

/** Only pure data enters the bounded worker; first encoder initialization is off the API event loop too.
 * Arbitrary installed functions cannot be transferred: their display counts run in this realm, captured at the
 * snapshot, in their original order. They must themselves be fast; built-in estimates still run off-thread. */
export async function contextReportAsync(state: AppState, sessionId: string, modelIdIn: string | null = null): Promise<ContextReport> {
  const { input, counter } = reportSnapshot(state, sessionId, modelIdIn)
  const result = await reportWorker.compute(input)
  return counter ? finishInstalledCounter(result, counter) : result.report
}
