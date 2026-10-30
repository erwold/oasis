/** The replay's pure part (adapted from oasis state/replay.ts, see NOTICE): the state of a session at a moment —
 *  which runs existed and in what status (the thread's own and the tree's: children, orders, human actions), each
 *  one's rows, and the relays as they stood — rebuilt from the persisted events with the SAME reducer the live
 *  stream uses, so a replayed thread and a replayed card render exactly as the live ones did, and nothing later
 *  than the moment shows: not a run not yet started, not an answer not yet given, not a status not yet reached. */

import { isThreadRun } from '@oasis-code/contract'
import type { Relay, RelayStep, Run, RunTreeRow, SSEItem } from '../api/types'
import { applyEvent, crossSurfaceOf, screenSurfaceEvent, upsertSurface, type ThreadEntry } from './thread.ts'
import { admitSessionRecord, type SessionFacts } from './uiSurface.ts'

export interface ReplayEvent { run_id: string; seq: number; event: string; data: Record<string, unknown>; t: string }
export interface ReplayBody { session_id: string; runs: RunTreeRow[]; events: ReplayEvent[]; t0: string | null; t1: string | null }

const TERMINAL = new Set(['done', 'error', 'cancelled'])
export const SPEEDS = [1, 10, 30, 60, 300]

/** A run of the session's own thread: started by a person (or woken by a watch its agent set), under no order
 *  (children and human actions are the tree's). */
export const isThreadRow = (row: RunTreeRow): boolean => isThreadRun({ parent_run_id: row.parent_run_id, work_order: row.work_order, spawned_by: row.spawned_by })

/** A tree row as it stood at the cursor: not yet finished → running, with no receipt, error or usage yet. */
export function rowAt(row: RunTreeRow, cursor: number): RunTreeRow {
  const ended = row.finished_at ? Date.parse(row.finished_at) : NaN
  const over = Number.isFinite(ended) && ended <= cursor
  if (over) return { ...row, live: false }
  return { ...row, status: TERMINAL.has(row.status) ? 'running' : row.status, live: true, finished_at: null, receipt: null, error: null, usage: {} }
}

/** A clipped tree row as the thread's Run. */
export function runOfRow(row: RunTreeRow): Run {
  return {
    id: row.id, session_id: row.session_id, project_id: '', workspace_id: row.workspace_id, parent_run_id: row.parent_run_id,
    resumes_run_id: row.resumes_run_id, spawned_by: row.spawned_by, label: row.label, model: row.model ?? '', model_config_snapshot: {},
    user_text: row.user_text, status: row.status === 'waiting' ? 'queued' : row.status, usage: row.usage,
    budget: {}, error: row.error, created_at: row.created_at, finished_at: row.finished_at, saved_seq: 0,
    receipt: row.receipt ?? {}, work_order: row.work_order,
    // the tree's rows carry no attachments: a replayed turn shows its words without the images; its relay turn it keeps
    attachments: [], relay_id: row.relay_id ?? null, relay_step: row.relay_step ?? null, interaction_id: row.interaction_id ?? null, interaction_node: row.interaction_node ?? null,
  }
}

const STEP_OF_RUN: Record<string, RelayStep['status']> = { done: 'done', cancelled: 'cancelled', error: 'error' }

/** The relays as they stood among the clipped rows: one none of whose turns had started is not there; a turn is
 *  queued until its run exists, running until that run is over, then what the record says of it (its last run) or
 *  the run's own end (an earlier run of a turn run again later); the chain is running until its last turn's run is
 *  over, then as recorded. */
export function relaysAt(relays: Relay[], tree: RunTreeRow[]): Relay[] {
  const at = new Map(tree.map((r) => [r.id, r]))
  const out: Relay[] = []
  for (const relay of relays) {
    const steps: RelayStep[] = relay.steps.map((step) => {
      const runs = step.run_ids.filter((id) => at.has(id))
      if (!runs.length) return { ...step, status: 'queued', run_id: null, run_ids: [] }
      const last = at.get(runs[runs.length - 1]!)!
      const over = last.finished_at !== null
      const status: RelayStep['status'] = !over ? 'running' : runs.length === step.run_ids.length ? step.status : (STEP_OF_RUN[last.status] ?? 'done')
      return { ...step, status, run_id: last.id, run_ids: runs }
    })
    if (!steps.some((s) => s.run_ids.length)) continue
    const all = relay.steps.flatMap((s) => s.run_ids)
    const lastRun = all.length ? at.get(all[all.length - 1]!) : undefined
    if (lastRun && lastRun.finished_at !== null) { out.push({ ...relay, steps }); continue }
    const open = steps.findIndex((s) => s.status !== 'done')
    const current = open >= 0 ? open : steps.length - 1
    out.push({ ...relay, steps, status: 'running', reason: null, finished_at: null, current_step: current, round: steps[current]?.round ?? relay.round })
  }
  return out
}

export interface ReplayMoment {
  runs: Run[]; threads: Record<string, ThreadEntry[]>; liveRunId: string | null
  tree: RunTreeRow[]; childThreads: Record<string, ThreadEntry[]>; relays: Relay[]
}

/** The session at `cursor`: the tree's rows that existed, clipped to the moment; the thread's own among them as
 *  runs with their rows; every other's rows (a child's card reads them); the relays as they stood. */
/** `session`: the session's facts (its workspace), which a session surface's runs are checked against — without them
 *  no session surface is shown (a run surface always is). */
export function stateAt(body: Pick<ReplayBody, 'runs' | 'events'>, cursor: number, relays: Relay[] = [], session: SessionFacts | null = null): ReplayMoment {
  const tree = body.runs.filter((r) => Date.parse(r.created_at) <= cursor).map((r) => rowAt(r, cursor))
  const runs = tree.filter(isThreadRow).map(runOfRow)
  const ids = new Set(runs.map((r) => r.id))
  const threads: Record<string, ThreadEntry[]> = {}
  const childThreads: Record<string, ThreadEntry[]> = {}
  for (const r of runs) threads[r.id] = []
  for (const r of tree) if (!ids.has(r.id)) childThreads[r.id] = []
  for (const e of body.events) {
    if (Date.parse(e.t) > cursor) break
    // a session surface only from a run that may present one, as the session's rows say the run (never the event)
    const row = tree.find((r) => r.id === e.run_id)
    const item: SSEItem = screenSurfaceEvent({ event: e.event, data: e.data, id: String(e.seq) }, e.run_id, row, session)
    if (ids.has(e.run_id)) {
      threads[e.run_id] = applyEvent(threads[e.run_id], e.run_id, item)
      // a session surface this thread run updated: at its anchor's row, as it stood at that moment (a run beside the
      // thread never updates one)
      const cross = crossSurfaceOf(e.run_id, item)
      if (cross && ids.has(cross.run_id) && admitSessionRecord(cross, (id) => tree.find((r) => r.id === id), session)) threads[cross.run_id] = upsertSurface(threads[cross.run_id]!, cross.run_id, cross)
    } else if (e.run_id in childThreads) childThreads[e.run_id] = applyEvent(childThreads[e.run_id], e.run_id, item)
  }
  const live = runs.filter((r) => !TERMINAL.has(r.status)).at(-1)
  return { runs, threads, liveRunId: live?.id ?? null, tree, childThreads, relays: relaysAt(relays, tree) }
}

/** "3:05" / "1:02:03" */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}
