import type { RunTreeRow } from '../api/types'
import { isThreadRun } from '@oasis-code/contract'
import type { ThreadEntry } from './thread'

/** A lineage (carried from oasis state/lineage.ts, see NOTICE): one agent's conversation across the runs that
 *  continue it. The root is the run a person or a director started; each follow-up run resumes the previous one.
 *  The outline shows one node and the desk one card per lineage, both wearing the newest run's state; the card's
 *  thread is every run's stream in order, with a composer under it. */
export interface Lineage extends RunTreeRow {
  /** the runs of the conversation, oldest first; the root is `id` */
  lineage: RunTreeRow[]
  /** the newest run: its status, model, receipt and stream are the node's */
  latest: RunTreeRow
}

/** What a fold groups by: the plan node (the outline: one row per step) or the participant (the desk: one card per
 *  agent, every step it ran in its thread). */
export type FoldBy = 'plan_node_id' | 'participant_id'

/** Fold the tree's rows into lineages: a row that resumes another joins that row's lineage; the node keeps the
 *  root's identity (id, parent, who started it, its first request, its order) and takes the newest run's state.
 *  Folded by the plan node, a plan node is a row of its own — the runs of one node fold together (a step run again
 *  after a decision), a participant's later node stands apart from the earlier one it continues; folded by the
 *  participant, every run of one participant is one lineage. An ordinary continuation (neither) folds into the row
 *  it resumes. Rows come back in the tree's order. */
export function foldLineages(rows: RunTreeRow[], by: FoldBy = 'plan_node_id'): Lineage[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  // folded by participant, the harness's stable participant (schema v25: `collab.participant_id`) is the key when the
  // row carries one — the same participant across groups, follow-ups and restarts is one card; never a model's name
  const own = (row: RunTreeRow): string | null => (by === 'participant_id' && row.collab?.participant_id ? `pa:${row.collab.participant_id}` : row[by])
  const keyOf = (row: RunTreeRow): string => {
    let cur = row
    const seen = new Set<string>()
    while (!own(cur) && cur.resumes_run_id && byId.has(cur.resumes_run_id) && !seen.has(cur.id)) {
      seen.add(cur.id)
      cur = byId.get(cur.resumes_run_id)!
    }
    return own(cur) ?? cur.id
  }
  const groups = new Map<string, RunTreeRow[]>()
  for (const row of rows) {
    const key = keyOf(row)
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  const out: Lineage[] = []
  const emitted = new Set<string>()
  for (const row of rows) {
    const key = keyOf(row)
    if (emitted.has(key)) continue
    emitted.add(key)
    const lineage = [...groups.get(key)!].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    const root = lineage[0]!
    const latest = lineage[lineage.length - 1]!
    // the plan's fields are the node's: from the root (a plain follow-up folded in carries none of its own)
    out.push({ ...latest, id: root.id, parent_run_id: root.parent_run_id, spawned_by: root.spawned_by, created_at: root.created_at,
               label: root.label ?? latest.label, user_text: root.user_text, user_text_head: root.user_text_head,
               work_order: root.work_order, resumes_run_id: null, plan_node_id: root.plan_node_id, participant_id: root.participant_id,
               participant_alias: root.participant_alias, participant_index: root.participant_index, participant_name: root.participant_name, depends_on: root.depends_on, scheduled_by: root.scheduled_by, kind: root.kind, lineage, latest })
  }
  return out
}

/** The desk's agents: the runs folded by participant, one card each — a plan's own rows (a node not started, the
 *  plan, the decision) are no runs and carry no card. */
export const foldAgents = (rows: RunTreeRow[]): Lineage[] => foldLineages(rows.filter((r) => r.spawned_by !== 'plan'), 'participant_id')

/** The agent (the desk's lineage) that carries a run. */
export function agentOf(agents: Pick<Lineage, 'id' | 'lineage'>[], runId: string): string | null {
  return agents.find((a) => a.lineage.some((r) => r.id === runId))?.id ?? null
}

/** The desk window that shows a run: its agent's card (`run:<the card's first run>`) — a participant's later run
 *  (a second step, a follow-up) is on the card its first run opened, never on a card of its own. Null while the run
 *  is not in the tree yet (the card appears when it is). */
export function cardIdForRun(agents: Pick<Lineage, 'id' | 'lineage'>[], runId: string): string | null {
  const agent = agentOf(agents, runId)
  return agent ? `run:${agent}` : null
}

/** The card of a participant (by its stable id), at its newest run: for a jump that names a participant and no run. */
export function cardOfParticipant(agents: Pick<Lineage, 'id' | 'lineage'>[], participantId: string): string | null {
  const agent = agents.find((a) => a.lineage.some((r) => (r as Partial<RunTreeRow>).collab?.participant_id === participantId))
  return agent ? `run:${agent.id}` : null
}

/** The lineages with their dependencies naming rows: a dependency on a run names the lineage that carries it. */
export function withDependencies(lineages: Lineage[]): Lineage[] {
  const rowOfRun = new Map<string, string>()
  for (const l of lineages) for (const r of l.lineage) rowOfRun.set(r.id, l.id)
  return lineages.map((l) => ({ ...l, depends_on: l.depends_on.map((id) => rowOfRun.get(id) ?? id) }))
}

/** One run's own rows: a child's watched stream (or stored conversation), else the thread's own rows for it. */
export function entriesOfRun(runId: string, childThreads: Record<string, ThreadEntry[]>, threads: Record<string, ThreadEntry[]>): ThreadEntry[] {
  return childThreads[runId] ?? threads[runId] ?? []
}

/** A row of the session thread's own runs: started by a person (or woken by a watch its agent set), under no order
 *  (children and human actions are the tree's). */
export const isThreadRow = (row: Pick<RunTreeRow, 'parent_run_id' | 'work_order' | 'spawned_by'>): boolean =>
  isThreadRun({ parent_run_id: row.parent_run_id, work_order: row.work_order, spawned_by: row.spawned_by })

/** Whether two values the API answered with (plain objects, arrays, primitives) hold the same data. */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (!sameData(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  return true
}

/** The rows of a tree read again, with every row whose data did not change kept as the object it was (and the list
 *  itself kept when nothing changed): the tree is read after every event of every run, and a view that draws a row
 *  again only when its row is another object draws only what changed. */
export function keepUnchanged<T extends { id: string }>(prev: readonly T[] | null, next: T[]): T[] {
  if (!prev) return next
  const before = new Map(prev.map((r) => [r.id, r]))
  let same = prev.length === next.length
  const out = next.map((row, i) => {
    const old = before.get(row.id)
    const kept = old && sameData(old, row) ? old : row
    if (kept !== prev[i]) same = false
    return kept
  })
  return same ? (prev as T[]) : out
}

/** A selector of the rows of several runs (a card's every step): the list it answered before while every run's rows
 *  are the same arrays — a store selector that answers a new array each time redraws on every change of the store.
 *  `undefined` for a run whose rows were never read. One picker per view. */
export function entriesPicker(): (ids: readonly string[], childThreads: Record<string, ThreadEntry[]>, threads: Record<string, ThreadEntry[]>) => readonly (ThreadEntry[] | undefined)[] {
  let last: (ThreadEntry[] | undefined)[] = []
  return (ids, childThreads, threads) => {
    const next = ids.map((id) => childThreads[id] ?? threads[id])
    if (next.length === last.length && next.every((rows, i) => rows === last[i])) return last
    last = next
    return next
  }
}

/** Whether any run's rows hold an entry `test` accepts. Each run's answer is kept for its rows' array (a new array
 *  when a row came), so a store change costs a look per run, not a walk of every row of the session. */
export function anyEntry(test: (entry: ThreadEntry) => boolean): (childThreads: Record<string, ThreadEntry[]>, threads: Record<string, ThreadEntry[]>) => boolean {
  const seen = new WeakMap<ThreadEntry[], boolean>()
  const has = (rows: ThreadEntry[]): boolean => {
    let hit = seen.get(rows)
    if (hit === undefined) { hit = rows.some(test); seen.set(rows, hit) }
    return hit
  }
  return (childThreads, threads) => Object.values(childThreads).some(has) || Object.values(threads).some(has)
}

/** The tools whose calls start, read or stop a run's commands (its executions). */
const COMMAND_TOOLS = new Set(['bash', 'bash_output', 'stop_command'])

/** A number that changes when a run's commands may have: a command call finished (twice the count) or one is running
 *  (one more) — the terminal reads the run's commands again on it, not after every tool call of the run. */
export function commandPulse(rows: readonly ThreadEntry[]): number {
  let finished = 0, running = 0
  for (const e of rows) {
    if (e.kind !== 'activity' || !e.tool || !COMMAND_TOOLS.has(e.tool)) continue
    if (e.running) running = 1
    else finished += 1
  }
  return finished * 2 + running
}
