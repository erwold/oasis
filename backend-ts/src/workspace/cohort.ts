/** A run's conversation cohort: the persisted identity (session, participant, conversation, workspace) a later run of
 *  the same conversation shares with the commands an earlier run of it left running. It is read from the run's own
 *  records — its row and the run_collab row written with it — never inferred from a model, a session alone or a parent
 *  run. A run without that record (older than the collaboration model, or one whose workspace is unknown) has none,
 *  and nothing that rests on a cohort is granted to it. */

import { createHash } from 'node:crypto'
import type { Conn } from '../db/database.ts'

export interface RunCohort {
  session_id: string
  participant_id: string
  conversation_id: string
  workspace_id: string
}

const FIELDS = ['session_id', 'participant_id', 'conversation_id', 'workspace_id'] as const

/** The key a cohort is compared by (the folder's lock carries it): the four identities, hashed. */
export function cohortKeyOf(c: RunCohort): string {
  return `cohort-${createHash('sha256').update(JSON.stringify(FIELDS.map((f) => c[f]))).digest('hex').slice(0, 32)}`
}

/** A cohort as a record holds it (a lease's governance note), or null when it is not one. */
export function parseCohort(value: unknown): RunCohort | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  for (const f of FIELDS) if (typeof v[f] !== 'string' || !v[f]) return null
  return { session_id: v.session_id as string, participant_id: v.participant_id as string, conversation_id: v.conversation_id as string, workspace_id: v.workspace_id as string }
}

export function sameCohort(a: RunCohort | null, b: RunCohort | null): boolean {
  return a !== null && b !== null && FIELDS.every((f) => a[f] === b[f])
}

/** The run's cohort as its records say it: its row (session, workspace) and its run_collab row (participant,
 *  conversation, written in the same transaction as the row); null when either is missing or they disagree. */
export function cohortOfRun(conn: Conn, runId: string): RunCohort | null {
  const row = conn.get(
    'SELECT r.session_id AS session_id, r.workspace_id AS workspace_id, c.session_id AS collab_session, c.participant_id AS participant_id, c.conversation_id AS conversation_id FROM runs r JOIN run_collab c ON c.run_id = r.id WHERE r.id = ?',
    [runId],
  ) as Record<string, unknown> | null | undefined
  if (!row || row.collab_session !== row.session_id) return null
  return parseCohort(row)
}
