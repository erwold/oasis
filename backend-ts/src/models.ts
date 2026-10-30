/** The vocabulary shared by the database, the API and the agent: the contract's row models, re-exported with the
 *  constructors the rows are decoded through. */

import {
  BudgetSchema, GrantsSchema, type Approval, type Asset, type Budget, type CheckResult, type Checkpoint,
  type DirectorNote, type Execution, type Grants, type ModelRequestRecord, type Project, type Run, type Session, type Snapshot,
  type Workspace,
} from '@oasis-code/contract'

export { ACTIVE_RUN_STATUSES, isThreadRun } from '@oasis-code/contract'
export type {
  Approval, Asset, Budget, CheckResult, Checkpoint, DirectorNote, Execution, Grants, ModelRequestRecord, Project, Run, Session,
  Snapshot, Workspace,
}

export function defaultGrants(overrides: Partial<Grants> = {}): Grants {
  return { ...GrantsSchema.parse({}), ...overrides }
}

export function parseGrants(raw: unknown): Grants {
  const parsed = GrantsSchema.safeParse(raw ?? {})
  return parsed.success ? parsed.data : GrantsSchema.parse({})
}

/** A budget with only the lines that are set (what the rows store and the prompts print). */
export function budgetLines(budget: Budget | null | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of ['requests', 'total_tokens', 'wall_clock_s', 'tool_calls'] as const) {
    const value = budget?.[key]
    if (typeof value === 'number') out[key] = value
  }
  return out
}

/** A budget as the API carries it: every line present, null where none is set (what the first backend sent). */
export function parseBudget(raw: unknown): Budget {
  const parsed = BudgetSchema.safeParse(raw ?? {})
  return { requests: null, total_tokens: null, wall_clock_s: null, tool_calls: null, ...(parsed.success ? parsed.data : {}) }
}

export function emptyBudget(): Budget {
  return {}
}
