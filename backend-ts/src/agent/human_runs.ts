/** A person's own writes are nodes on the run tree too (adapted from oasis agent/human_runs.py, see NOTICE): a
 *  checkpoint pinned from the UI, checks run from the UI, an integration composed from the UI — one run row each,
 *  spawned_by=human_action, status done, with a receipt whose produced side names what the action left. No model
 *  ran; the row carries no history and no usage, so it never becomes the session's conversation or its context. */

import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { setGateHooks } from '../policy/gate.ts'
import { nowIso } from '../timebase.ts'
import { humanReceipt, type CheckCounts } from './work_orders.ts'

export const HUMAN_ACTION = 'human_action'

export interface HumanRunOptions {
  session_id: string | null; project_id: string; workspace_id: string | null; label: string; text: string; produced: Record<string, unknown>; kind: string
  /** the checks the action ran (verify, integrate), counted as they went, with the configured ones that did not run */
  checks?: CheckCounts | null
}

/** A finished run row for a human action; null when nothing could be recorded (never throws). */
export function recordHumanRun(conn: Conn, o: HumanRunOptions): string | null {
  try {
    if (o.session_id === null || repo.getSession(conn, o.session_id) === null) return null
    const run = repo.insertRun(conn, {
      session_id: o.session_id, project_id: o.project_id, workspace_id: o.workspace_id, model: '', model_config: {}, user_text: o.text, status: 'running',
      budget: {}, spawned_by: HUMAN_ACTION, label: o.label,
    })
    const finished = nowIso()
    const receipt = humanReceipt(run.id, { label: o.label, kind: o.kind, produced: o.produced, text: o.text, finished_at: finished, checks: o.checks ?? null })
    repo.finishRun(conn, run.id, 'done', { history_json: null, usage: {}, error: null, receipt: receipt as unknown as Record<string, unknown>, saved_seq: 0 })
    return run.id
  } catch (error) { // the record must never fail the write it describes
    console.warn(`could not record the human run for ${o.kind}: ${(error as Error).message}`)
    return null
  }
}

setGateHooks({ recordHumanRun: (conn, opts) => { recordHumanRun(conn, opts as unknown as HumanRunOptions) } })
