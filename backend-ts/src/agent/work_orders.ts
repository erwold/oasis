/** A work order (what the person or a director hands a run of its own) and a receipt (what the runner assembles
 *  when a run ends), on coding semantics. Adapted from oasis agent/work_orders.py (see NOTICE). No role lives here —
 *  who the run is and what it does are the order's prompt; the mechanism enforces the order's boundaries at every
 *  call and keeps the measured side of the receipt apart from the model's own words. The measured side is facts —
 *  what ran, what it left, how each check and acceptance line went — never a verdict on the task. */

import {
  MEASURED_METRICS, MechanicalSchema, ProducedSchema, RECEIPT_VERSION, ReceiptSchema, WORK_ORDER_VERSION,
  WorkOrderShapeSchema, z, type Budget, type Mechanical, type Produced, type Receipt, type WorkOrder,
} from '@oasis-code/contract'
import { budgetLines } from '../models.ts'
import { fnmatchcase } from '../workspace/paths.ts'

export { RECEIPT_VERSION, WORK_ORDER_VERSION }
export type { Mechanical, Produced, Receipt, WorkOrder }
export const USAGE_TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'total_tokens', 'cache_read_tokens', 'cache_write_tokens'] as const

/** A work order that does not validate: the message names what is wrong. */
export class WorkOrderInvalid extends Error {
  constructor(message: string) { super(message); this.name = 'WorkOrderInvalid' }
}

// ---- the work order ------------------------------------------------------------------

/** The full validation: the contract's shape, then the refinement only the backend can make (its tool surface).
 *  Throws WorkOrderInvalid with every issue named. */
export function parseWorkOrder(raw: unknown): WorkOrder {
  const parsed = WorkOrderShapeSchema.safeParse(raw)
  if (!parsed.success) throw new WorkOrderInvalid(issuesText(parsed.error))
  const order = parsed.data
  const problems: string[] = []
  if (order.tools !== null) {
    const { runToolNames } = require('./tools/registry.ts') as typeof import('./tools/registry.ts')
    const surface = runToolNames()
    const unknownTools = order.tools.filter((n) => !surface.includes(n))
    if (unknownTools.length) problems.push(`tools: unknown tool(s): ${unknownTools.join(', ')}; the run surface has ${surface.join(', ')}`)
    order.tools = [...new Set(order.tools)]
  }
  if (problems.length) throw new WorkOrderInvalid(problems.join('\n'))
  return order
}

function issuesText(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
}

export function workOrder(raw: Partial<WorkOrder> & { prompt: string }): WorkOrder {
  return parseWorkOrder(raw)
}

/** A follow-up asked for more than the order it continues allows. */
export { globsWithin } from './glob_subset.ts'
import { globsWithin } from './glob_subset.ts'

export class OrderWidened extends Error {
  constructor(message: string) { super(message); this.name = 'OrderWidened' }
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** The order a follow-up runs under: the previous run's order with `patch` applied where it narrows — a field the
 *  patch leaves out is inherited as it was, a field that would widen the order (read-only lifted, a tool or a path
 *  added, commands or the network turned on, a protected path dropped) is refused as a whole. Protected paths and
 *  locks can only be added to; the label, goal, deliverables, acceptance, context and budget follow the patch. */
export function narrowOrder(previousIn: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const previous = parseWorkOrder({ ...previousIn, prompt: String(previousIn.prompt || 'follow-up') })
  const out: Record<string, unknown> = { ...previousIn }
  const widened: string[] = []
  const given = (key: string) => key in patch && patch[key] !== undefined
  if (given('read_only')) {
    if (previous.read_only && patch.read_only !== true) widened.push('read_only: the run stays read-only')
    else out.read_only = patch.read_only === true
  }
  if (given('tools')) {
    const want = patch.tools === null ? null : Array.isArray(patch.tools) ? patch.tools.map(String) : []
    if (previous.tools !== null && (want === null || want.some((t) => !previous.tools!.includes(t)))) {
      widened.push(`tools: only ${previous.tools.join(', ')} are available to this run`)
    } else out.tools = want
  }
  if (given('scope')) {
    const scope = rec(patch.scope)
    const next: Record<string, unknown> = { ...rec(previousIn.scope) }
    for (const side of ['read', 'write'] as const) {
      if (!(side in scope) || scope[side] === undefined) continue
      const want = scope[side] === null ? null : Array.isArray(scope[side]) ? (scope[side] as unknown[]).map(String) : []
      const had = previous.scope[side]
      if (had !== null && (want === null || !globsWithin(want, had))) widened.push(`scope.${side}: within ${had.join(', ') || 'none'}`)
      else next[side] = want
    }
    out.scope = next
  }
  if (given('execution')) {
    const execution = rec(patch.execution)
    const next = { commands: previous.execution.commands, network: previous.execution.network }
    for (const key of ['commands', 'network'] as const) {
      if (!(key in execution) || execution[key] === undefined) continue
      if (!previous.execution[key] && execution[key] === true) widened.push(`execution.${key}: off for this run`)
      else next[key] = execution[key] === true
    }
    out.execution = next
  }
  if (given('protected_paths')) {
    const added = Array.isArray(patch.protected_paths) ? patch.protected_paths.map(String) : []
    out.protected_paths = [...new Set([...previous.protected_paths, ...added])]
  }
  if (given('locks')) {
    const before = previous.locks.map((l) => JSON.stringify(l))
    const added = (Array.isArray(patch.locks) ? patch.locks : []).filter((l) => !before.includes(JSON.stringify(l)))
    out.locks = [...previous.locks, ...added]
  }
  for (const key of ['label', 'goal', 'deliverables', 'acceptance', 'context_refs', 'budget', 'model']) if (given(key)) out[key] = patch[key]
  if (widened.length) throw new OrderWidened(`the follow-up may narrow the order it continues, not widen it: ${widened.join('; ')}`)
  return out
}

/** The order as the rows and the events carry it. */
export function dumpWorkOrder(order: WorkOrder): Record<string, unknown> {
  return { ...order, budget: budgetLines(order.budget) }
}

export function seesTool(order: WorkOrder, name: string): boolean {
  return order.tools === null || order.tools.includes(name)
}

/** Whether a worktree-relative path falls under one of the globs (a bare directory name covers everything below
 *  it; `dir/**` likewise). */
export function inScope(path: string, globs: string[]): boolean {
  let p = path.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (p === '.') p = ''
  for (const raw of globs) {
    const g = raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (g === '**' || g === '*' || g === '.' || g === '') return true
    if (!p) continue
    if (fnmatchcase(p, g)) return true
    const base = g.endsWith('/**') ? g.slice(0, -3) : g
    if (!/[*?[]/.test(base) && (p === base || p.startsWith(base + '/'))) return true
  }
  return false
}

/** Why the order refuses this call, or null to proceed. Checked before the session gate, so a refused call never
 *  reaches the workspace, the sandbox or the gate. */
export function orderRefusal(order: WorkOrder | null, toolName: string, effect: string, opts: { path?: string | null; network?: boolean; temp?: boolean } = {}): string | null {
  if (order === null) return null
  if (!seesTool(order, toolName)) return `${toolName} is not available in this run`
  // read-only and the scopes bound the working folder; the temporary folder is not it (the sandbox lets a command write there too)
  if (order.read_only && effect === 'workspace_write' && !opts.temp) return `This run is read-only: ${toolName} would change the working folder`
  if (effect === 'isolated_code_execution' && !order.execution.commands) return 'This run allows no commands'
  // a tool of another effect that reaches the web (a page the desktop app holds) says so with `network`
  if ((effect === 'network' || opts.network === true) && !order.execution.network) return 'Network access is off for this run'
  const path = opts.path ?? null
  if (path !== null) {
    if (effect === 'workspace_write' && order.scope.write !== null && !inScope(path, order.scope.write)) {
      return `${path} is outside the writable paths of this run (${order.scope.write.join(', ') || 'none'})`
    }
    if (effect === 'read' && order.scope.read !== null && !inScope(path, order.scope.read)) {
      return `${path} is outside the readable paths of this run (${order.scope.read.join(', ') || 'none'})`
    }
  }
  return null
}

// ---- the receipt ---------------------------------------------------------------------

export function produced(partial: Partial<Produced> = {}): Produced {
  return ProducedSchema.parse(partial)
}

export function mechanical(partial: Partial<Mechanical> = {}): Mechanical {
  return MechanicalSchema.parse(partial)
}

export function measuredFacts(m: Mechanical): Record<string, unknown> {
  return {
    tool_calls: m.tool_calls, requests: m.requests, refused_calls: m.refused_calls, gated_calls: m.gated_calls, blocked_calls: m.blocked_calls,
    lock_violations: m.lock_violations, lock_refusals: m.lock_refusals, executions: m.executions.length, failed_executions: m.failed_executions,
    checkpoints: m.checkpoints.length, checks_passed: m.checks.passed ?? 0, checks_failed: m.checks.failed ?? 0, checks_unknown: m.checks.unknown ?? 0, checks_not_run: m.checks.not_run ?? 0,
    files_changed: m.diff.files ?? null, lines_added: m.diff.added ?? null, lines_removed: m.diff.removed ?? null,
  }
}

function compare(actual: unknown, op: string, expected: unknown): boolean {
  if (op === '==') return actual === expected || String(actual) === String(expected)
  if (op === '!=') return !(actual === expected || String(actual) === String(expected))
  const a = Number(actual)
  const b = Number(expected)
  if (Number.isNaN(a) || Number.isNaN(b)) return false
  return { '<=': a <= b, '<': a < b, '>=': a >= b, '>': a > b }[op] ?? false
}

/** The line an acceptance check is judged under: the whole clause, so two clauses on one metric (`files_changed >= 1`
 *  and `files_changed <= 3`) are two lines, each kept, whichever order the order lists them in. */
export function acceptanceKey(check: { metric: string; op: string; value: unknown }): string {
  return `${check.metric} ${check.op} ${String(check.value)}`
}

/** pass / fail for every acceptance check the runner can measure itself, unknown for the rest — never guessed from
 *  the child's own numbers. Every clause is judged and kept under its own line; a clause that repeats another is
 *  the same line (the same judgement), never a second metric that overwrites the first. */
export function judgeAcceptance(order: WorkOrder | null, facts: Record<string, unknown>): Record<string, 'pass' | 'fail' | 'unknown'> {
  const out: Record<string, 'pass' | 'fail' | 'unknown'> = {}
  for (const check of order?.acceptance ?? []) {
    const actual = (MEASURED_METRICS as readonly string[]).includes(check.metric) ? facts[check.metric] : null
    out[acceptanceKey(check)] = actual === null || actual === undefined ? 'unknown' : compare(actual, check.op, check.value) ? 'pass' : 'fail'
  }
  return out
}

export interface ReceiptInputs {
  label: string | null
  usage: Record<string, unknown>
  error: string | null
  order: WorkOrder | null
  events: { event: string; data: Record<string, unknown> }[]
  blocked_calls: number
  produced: Produced
  lock_refusals?: number
  lock_violations?: number
  executions: { id: string; status: string; exit_code: number | null; effect_state: string }[]
  checks: CheckCounts
  diff: Record<string, unknown>
  budget_exceeded: string | null
  budget_reached: string | null
  budget_limits: Record<string, unknown>
  answer_end?: { reason: string; attempts: number } | null
  final_text: string
  finished_at: string
}

/** The receipt the runner assembles when a run ends: status (a budget stop reads budget_exceeded), the model's
 *  final words, what it produced and the mechanical side — measured from the run's events, the records
 *  and the usage, never from the model's words. */
export function buildReceipt(runId: string, status: string, r: ReceiptInputs): Receipt {
  const usage = r.usage
  const toolCalls = r.events.filter((e) => e.event === 'tool_call').length
  const refused = r.events.filter((e) => e.event === 'tool_result' && String(e.data.status ?? '').startsWith('refused')).length
  const gated = r.events.filter((e) => e.event === 'action_gated').length
  const n = (v: unknown) => Math.trunc(Number(v ?? 0) || 0)
  const m = mechanical({
    requests: n(usage.requests), tool_calls: toolCalls, refused_calls: refused, gated_calls: gated, blocked_calls: r.blocked_calls,
    lock_refusals: r.lock_refusals ?? 0, lock_violations: r.lock_violations ?? 0, segments: n(usage.segments) || 1,
    // the requests the provider reported no count for go with the totals, which cover only the counted ones
    usage: {
      ...Object.fromEntries(USAGE_TOKEN_FIELDS.map((k) => [k, typeof usage[k] === 'number' ? (usage[k] as number) : null])),
      ...(typeof usage.uncounted_requests === 'number' && usage.uncounted_requests > 0 ? { uncounted_requests: usage.uncounted_requests } : {}),
    },
    model: (usage.model as string) ?? null, configured_model: (usage.configured_model as string) ?? null,
    provider_models: [...((usage.provider_models as string[]) ?? [])],
    cost_usd: typeof usage.cost_usd === 'number' ? usage.cost_usd : null, cost_status: String(usage.cost_status ?? 'unknown'),
    cost_source: (usage.cost_source as string) ?? null,
    cost_cny: typeof usage.cost_cny === 'number' ? usage.cost_cny : null,
    executions: r.executions,
    failed_executions: r.executions.filter((x) => ['failed', 'timeout', 'lost'].includes(String(x.status)) || (x.exit_code !== null && x.exit_code !== undefined && x.exit_code !== 0)).length,
    checkpoints: [...r.produced.checkpoints], checks: { ...r.checks }, diff: { ...r.diff },
    budget: {
      limits: r.budget_limits, spent: { requests: n(usage.requests), tool_calls: toolCalls, total_tokens: usage.total_tokens ?? null },
      exceeded: r.budget_exceeded, reached: r.budget_reached,
    },
    budget_exceeded: r.budget_exceeded, budget_reached: r.budget_reached,
    answer_end: r.answer_end ?? null,
  })
  m.acceptance = judgeAcceptance(r.order, measuredFacts(m))
  const receiptStatus = r.budget_exceeded ? 'budget_exceeded' : status
  return ReceiptSchema.parse({
    version: RECEIPT_VERSION, run_id: runId, label: r.label, status: receiptStatus, error: r.error,
    produced: r.produced, mechanical: m, final_text: r.final_text, finished_at: r.finished_at,
  })
}

/** The receipt of a run whose process died before it could write one (startup reconciliation): status lost, nothing
 *  claimed — but what a folder edited in place's journal measured of the run (`in_place`): its file-tool writes there,
 *  as the run's diff and Undo read them. */
export function lostReceipt(runId: string, opts: {
  label: string | null; error: string | null; finished_at?: string | null
  in_place?: { workspace_id: string; files: { path: string; added: number | null; removed: number | null }[] } | null
  /** what the run's attribution marker said (agent/attribution.ts): kept for a run that died too */
  attribution?: { attribution: 'exact' | 'partial' | 'unavailable' | null; unattributed_paths: string[]; background_execution_ids: string[] } | null
}): Receipt {
  const inPlace = opts.in_place ?? null
  const a = opts.attribution ?? null
  const attributed = a === null ? {} : {
    ...(a.attribution !== null ? { attribution: a.attribution } : {}),
    ...(a.unattributed_paths.length ? { unattributed_paths: a.unattributed_paths } : {}),
    ...(a.background_execution_ids.length ? { background_execution_ids: a.background_execution_ids } : {}),
  }
  return ReceiptSchema.parse({
    version: RECEIPT_VERSION, run_id: runId, label: opts.label, status: 'lost', error: opts.error,
    ...(inPlace !== null ? { produced: produced({ workspace_id: inPlace.workspace_id, files_changed: inPlace.files.map((f) => f.path).slice(0, 200) }) } : {}),
    mechanical: mechanical(inPlace !== null ? {
      diff: { files: inPlace.files.length, added: inPlace.files.reduce((a, f) => a + (f.added ?? 0), 0), removed: inPlace.files.reduce((a, f) => a + (f.removed ?? 0), 0), in_place: true, ...attributed },
    } : Object.keys(attributed).length ? { diff: attributed } : {}),
    finished_at: opts.finished_at ?? null,
  })
}

export interface CheckCounts { passed: number; failed: number; unknown: number; not_run: number }

/** The counts of a set of check results, as the receipts carry them: passed, failed, could not be judged, and —
 *  of the checks the project configures (`configured`, by id) — the ones that did not run at all. A check that did
 *  not run is neither a failure nor a pass. */
export function checkCounts(results: { status: string; check_id?: string }[], configured: string[] = []): CheckCounts {
  const ran = new Set(results.map((r) => r.check_id).filter((id): id is string => typeof id === 'string'))
  return {
    passed: results.filter((r) => r.status === 'pass').length, failed: results.filter((r) => r.status === 'fail').length,
    unknown: results.filter((r) => r.status !== 'pass' && r.status !== 'fail').length,
    not_run: [...new Set(configured)].filter((id) => !ran.has(id)).length,
  }
}

/** The receipt of a person's own action recorded as a node: no model ran, nothing was spent, the produced side names
 *  what the action left, and the checks the action ran (verify, integrate) are counted as they went. */
export function humanReceipt(runId: string, opts: { label: string; kind: string; produced: Record<string, unknown>; text: string; finished_at: string; checks?: CheckCounts | null }): Receipt {
  return ReceiptSchema.parse({
    version: RECEIPT_VERSION, run_id: runId, label: opts.label, status: 'done', produced: produced(opts.produced as Partial<Produced>),
    mechanical: mechanical({ cost_status: 'no_requests', human_action: opts.kind, checks: opts.checks ?? { passed: 0, failed: 0, unknown: 0, not_run: 0 } }),
    final_text: opts.text, finished_at: opts.finished_at,
  })
}

export type { Budget }
