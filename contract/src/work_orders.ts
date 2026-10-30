/** A work order (what the person or a director hands a run of its own, on its own worktree) and a receipt (what the
 *  runner assembles when a run ends). The shapes are frozen here; the backend adds the refinements that need its
 *  registry (known tools, known skills). */

import { z } from 'zod'
import { BudgetSchema } from './models.ts'
import { RECEIPT_VERSION, WORK_ORDER_VERSION } from './version.ts'

export const LockModeSchema = z.enum(['read_only', 'no_delete', 'no_signature_change'])
export type LockMode = z.infer<typeof LockModeSchema>

/** A hard lock: a path glob, optionally one symbol in it, × a mode — checked on the bytes, never promised in a prompt. */
export const LockSpecSchema = z.object({
  path: z.string().min(1),
  symbol: z.string().nullable().optional().default(null),
  mode: LockModeSchema.default('read_only'),
  label: z.string().nullable().optional().default(null),
})
export type LockSpec = z.infer<typeof LockSpecSchema>

/** Where the run works: always its own worktree, started from `base` — "parent" (the session workspace's state at
 *  dispatch, pinned as a checkpoint then) or a checkpoint id of the project. */
export const WorkspaceSpecSchema = z.object({ base: z.string().default('parent') })
export type WorkspaceSpec = z.infer<typeof WorkspaceSpecSchema>

/** Paths (globs relative to the worktree) the child may read / write; null = the whole worktree. */
export const ScopeSchema = z.object({
  read: z.array(z.string()).nullable().default(null),
  write: z.array(z.string()).nullable().default(null),
})
export type Scope = z.infer<typeof ScopeSchema>

/** commands: may the child run commands in the sandbox at all; network: may its commands and web tools reach the
 *  network (the session's grant must cover it too — an order never widens a grant). */
export const ExecutionPolicySchema = z.object({
  commands: z.boolean().default(true),
  network: z.boolean().default(true),
})
export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>

export const AcceptanceCheckSchema = z.object({
  metric: z.string(),
  op: z.enum(['<=', '<', '>=', '>', '==', '!=']),
  value: z.union([z.number(), z.string()]),
})
export type AcceptanceCheck = z.infer<typeof AcceptanceCheckSchema>

const cleanStrings = (values: string[]): string[] => {
  const out: string[] = []
  for (const v of values) {
    if (typeof v !== 'string') continue
    const t = v.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/** What a dispatcher hands a run of its own: its whole role (prompt), model, the tools it sees, whether it may
 *  write, where (scope, protected paths), whether it may run commands, what counts as done, what to hand back, how
 *  much it may spend, what it may refer to. The backend refines `tools` against its registry; everything else is
 *  validated here. */
export const WorkOrderShapeSchema = z.object({
  version: z.number().int().default(WORK_ORDER_VERSION),
  label: z.string().nullable().default(null),
  prompt: z.string().min(1),
  // an agent model id; null = the dispatcher's own model
  model: z.string().nullable().default(null),
  tools: z.array(z.string()).nullable().default(null),
  read_only: z.boolean().default(false),
  goal: z.string().nullable().default(null),
  workspace: WorkspaceSpecSchema.default(() => WorkspaceSpecSchema.parse({})),
  scope: ScopeSchema.default(() => ScopeSchema.parse({})),
  protected_paths: z.array(z.string()).default([]).transform(cleanStrings),
  // hard locks: a path (and optionally a symbol) × read_only / no_delete / no_signature_change — checked on the bytes
  locks: z.array(LockSpecSchema).default([]),
  execution: ExecutionPolicySchema.default(() => ExecutionPolicySchema.parse({})),
  acceptance: z.array(AcceptanceCheckSchema).default([]),
  deliverables: z.array(z.string()).default([]).transform(cleanStrings),
  budget: BudgetSchema.default({}),
  // what the child may refer to, already in the project: checkpoint / execution / asset / run ids, or paths
  context_refs: z.array(z.string()).default([]).transform(cleanStrings),
  resumes_run_id: z.string().nullable().default(null),
})
export type WorkOrder = z.infer<typeof WorkOrderShapeSchema>

// ---- the receipt ---------------------------------------------------------------------

/** What the run left behind, by id — measured from the records, never from the model's words. */
export const ProducedSchema = z.object({
  workspace_id: z.string().nullable().default(null),
  base_commit: z.string().nullable().default(null),
  checkpoints: z.array(z.string()).default([]),
  final_checkpoint_id: z.string().nullable().default(null),
  executions: z.array(z.string()).default([]),
  checks: z.array(z.string()).default([]),
  files_changed: z.array(z.string()).default([]),
  tree_sha: z.string().nullable().default(null),
})
export type Produced = z.infer<typeof ProducedSchema>

export const ExecutionSummarySchema = z.object({
  id: z.string(),
  status: z.string(),
  exit_code: z.number().int().nullable(),
  effect_state: z.string(),
})

/** How far a run's measured changes are its own: exact (measured against a baseline no other writer touched),
 *  partial (some paths, or the process-level authorship of what is shown, cannot be told — a command of an earlier
 *  run of the conversation was still writing, or a path's tool writes do not chain), unavailable (no reliable
 *  baseline: nothing is claimed as the run's, which is not the same as no change). */
export const ATTRIBUTIONS = ['exact', 'partial', 'unavailable'] as const
export const AttributionSchema = z.enum(ATTRIBUTIONS)
export type Attribution = z.infer<typeof AttributionSchema>

/** The attribution fields a receipt's diff and a run's diff answer carry (all optional: absent on older records). */
export const AttributionFieldsSchema = z.object({
  attribution: AttributionSchema.optional(),
  /** paths a tool of the run wrote whose change is not counted as the run's (a write between its tool writes) */
  unattributed_paths: z.array(z.string()).optional(),
  /** the commands of earlier runs of the conversation that were still running while this run worked */
  background_execution_ids: z.array(z.string()).optional(),
})
export type AttributionFields = z.infer<typeof AttributionFieldsSchema>

/** What the runner measured itself: counts from its own events and the records, never from the model's words. */
export const MechanicalSchema = z.object({
  requests: z.number().int().default(0),
  tool_calls: z.number().int().default(0),
  refused_calls: z.number().int().default(0),
  gated_calls: z.number().int().default(0),
  blocked_calls: z.number().int().default(0),
  lock_refusals: z.number().int().default(0),
  lock_violations: z.number().int().default(0),
  segments: z.number().int().default(0),
  usage: z.record(z.string(), z.number().nullable()).default({}),
  model: z.string().nullable().default(null),
  configured_model: z.string().nullable().default(null),
  provider_models: z.array(z.string()).default([]),
  cost_usd: z.number().nullable().default(null),
  /** Standard BigModel API estimate in CNY; null/absent is not zero USD. */
  cost_cny: z.number().nullable().optional(),
  cost_status: z.string().default('unknown'),
  cost_source: z.string().nullable().default(null),
  executions: z.array(ExecutionSummarySchema).default([]),
  failed_executions: z.number().int().default(0),
  checkpoints: z.array(z.string()).default([]),
  /** the checks as they went: how many passed, failed, could not be judged, and — of the project's configured checks — did not run at all */
  checks: z.object({ passed: z.number().int(), failed: z.number().int(), unknown: z.number().int(), not_run: z.number().int().default(0) }).default({ passed: 0, failed: 0, unknown: 0, not_run: 0 }),
  diff: z.object({
    files: z.number().int().optional(), added: z.number().int().nullable().optional(), removed: z.number().int().nullable().optional(),
    tree_sha: z.string().nullable().optional(), base_commit: z.string().nullable().optional(),
    /** a folder edited in place: the counts are this run's own file-tool writes (the journal), not a tree's difference */
    in_place: z.boolean().optional(),
    ...AttributionFieldsSchema.shape,
    /** a snapshot workspace: the tree this run started from (its own baseline, taken as it was admitted), apart from
     *  the workspace's integration base (base_commit); null when no reliable baseline exists */
    base_tree_sha: z.string().nullable().optional(),
  }).default({}),
  /** every acceptance line the order named, judged on what the runner measured: pass, fail, or unknown */
  acceptance: z.record(z.string(), z.enum(['pass', 'fail', 'unknown'])).default({}),
  budget: z.record(z.string(), z.unknown()).default({}),
  budget_exceeded: z.string().nullable().default(null),
  budget_reached: z.string().nullable().default(null),
  /** how the final answer ended when it did not end normally: cut at the output limit, no answer text, the
   *  provider's filter or refusal, a provider error — with the continuations or retries spent on it (null: normally) */
  answer_end: z.object({ reason: z.string(), attempts: z.number().int() }).nullable().default(null),
  human_action: z.string().nullable().default(null),
})
export type Mechanical = z.infer<typeof MechanicalSchema>

export const ReceiptStatusSchema = z.enum(['done', 'error', 'cancelled', 'lost', 'budget_exceeded'])
export const ReceiptSchema = z.object({
  version: z.number().int().default(RECEIPT_VERSION),
  run_id: z.string(),
  label: z.string().nullable().default(null),
  status: ReceiptStatusSchema,
  error: z.string().nullable().default(null),
  produced: ProducedSchema.default(() => ProducedSchema.parse({})),
  mechanical: MechanicalSchema.default(() => MechanicalSchema.parse({})),
  final_text: z.string().default(''),
  finished_at: z.string().nullable().default(null),
  /** true: the run was cancelled because the harness was shutting down (the app quit), not by the person's Stop —
   *  so its end is no one's activity in the session. Absent otherwise, and on every receipt written before it was kept. */
  interrupted: z.boolean().optional(),
})
export type Receipt = z.infer<typeof ReceiptSchema>

/** The acceptance metrics the runner measures itself; anything else is unknown. */
export const MEASURED_METRICS = [
  'tool_calls', 'requests', 'refused_calls', 'gated_calls', 'blocked_calls', 'lock_violations', 'lock_refusals', 'executions',
  'failed_executions', 'checkpoints', 'checks_passed', 'checks_failed', 'checks_unknown', 'checks_not_run', 'files_changed', 'lines_added',
  'lines_removed',
] as const

