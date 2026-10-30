/** Where a bot stands now: the one reading every view's bot picture takes (the thread's answers and live line, the
 *  desk's cards and shelf, the outline, the relations' lanes, a card's conversation, the interaction's strip). Pure:
 *  read from what the page already holds — the run's record, its own rows, the forms it waits on, the approvals and
 *  proposals that wait for the person, the session's watches — never guessed from a stream that dropped.
 *
 *  - idle: nothing to do (a run the person stopped settles here, never as a success nor as a failure);
 *  - waiting: in line (its model, its folder, a request slot), or a watch it set (or a report of one not yet
 *    delivered) while nothing of its participant runs;
 *  - thinking: its model is asked, thinks, writes — a tool call still being written included (not yet run);
 *  - working: one of its tool calls runs (any of them, not only the latest row);
 *  - blocked: it waits on the person (a form, an approval or a proposal), or it ended in an error, a refusal or its
 *    provider's filter, its budget, an interruption that was not the person's;
 *  - done: it ended well, nothing of it waits — for a moment (25 s), then its still icon;
 *  - static: the still icon. A finished run's ending plays a moment, but what still waits (a watch, a person) never
 *    times out. Each run is read for itself: a later run of the same agent never moves an older answer's bot; what
 *    waits for an agent (a watch, an approval) is shown on its current run alone. */

import type { RunTreeRow, SSEItem } from '../api/types'
import { BLOCKED_MS, DONE_MS, endedAt, endingOf, identityKey, LIVE_STATUSES, runAfterQueueEvents, type BotState } from './outline.ts'

export { BLOCKED_MS, DONE_MS }

export interface PresenceRun {
  id: string
  status: string
  finished_at?: string | null
  receipt?: unknown
  error?: string | null
  waiting?: unknown
}

export interface EntryLike {
  kind?: string
  eventName?: string
  running?: boolean
  forming?: unknown
  input?: { status?: string } | null
  result?: Record<string, unknown>
  detail?: Record<string, unknown>
}

/** What a run's own rows say of it now. */
export interface RunSignals {
  /** tool calls that run (their call came, their result not yet); a call still being written is none */
  openTools: number
  /** a request waits for a slot (slot_wait, nothing of the request after it) */
  slotWaiting: boolean
  /** in line again (run_queued, its holder named or not), nothing of it after */
  queued: boolean
  /** a form the run waits on */
  pendingInput: boolean
  /** the approvals its refused calls named (a session grant's approval is reused: it may name an earlier run) */
  approvalIds: string[]
}

const NO_ENTRIES: readonly EntryLike[] = []
const signalCache = new WeakMap<readonly EntryLike[], RunSignals>()
/** what says a request went on after waiting for its slot */
const SLOT_ON = new Set(['slot_acquired', 'run_started', 'run_finished'])
const SLOT_WORK = new Set(['agent', 'thinking', 'activity', 'ui', 'input', 'error'])

export function runSignals(entries: readonly EntryLike[] = NO_ENTRIES): RunSignals {
  const kept = signalCache.get(entries)
  if (kept) return kept
  let openTools = 0, pendingInput = false, slotAt = -1, queuedAt = -1
  const approvalIds: string[] = []
  entries.forEach((e, i) => {
    if (e.kind === 'activity' && e.running === true && !e.forming) openTools += 1
    if (e.kind === 'input' && e.input?.status === 'pending') pendingInput = true
    if (e.eventName === 'slot_wait') slotAt = i
    if (e.eventName === 'run_queued') queuedAt = i
    const approval = e.kind === 'activity' ? e.result?.approval_id : undefined
    if (typeof approval === 'string' && approval) approvalIds.push(approval)
  })
  const wentOn = (from: number) => entries.slice(from + 1).some((e) => (e.eventName !== undefined && SLOT_ON.has(e.eventName)) || (e.kind !== undefined && SLOT_WORK.has(e.kind)))
  const slotWaiting = slotAt >= 0 && !wentOn(slotAt)
  const queued = queuedAt >= 0 && !wentOn(queuedAt)
  const out = { openTools, slotWaiting, queued, pendingInput, approvalIds }
  signalCache.set(entries, out)
  return out
}

/** What waits for the run's agent beside its own rows (presenceFacts): true only for the agent's current run. */
export interface PresenceFacts {
  /** a form of this run is pending (the store's word, which may come before the run's own row) */
  pendingInput?: boolean
  /** an approval or a proposal of this agent waits for the person */
  pendingApproval?: boolean
  /** a watch of this agent waits, or a report of one waits to be delivered */
  watching?: boolean
  /** a director's plan row: its interaction's own status (the tree folds several into the row's `waiting`) */
  groupStatus?: string | null
}

/** A director's plan row as its bot plays it, read from its interaction's status (the tree says `waiting` for a plan
 *  running its steps, one waiting on the person and one a restart interrupted alike): asked for a plan or for what
 *  comes next = thinking; its steps at work, the director asleep = idle; the person's decision owed, or interrupted
 *  by a restart (no one's choice) = blocked; ended: as a run ends. Null: not a status it reads (the row's own then). */
/** The interaction status a plan row is read with: its interaction's, on the live page only — a replay does not
 *  replay the interactions (today's status laid on a past plan row would be wrong), so there the row stands as it
 *  stood at the cursor. Null for any other row. */
export function planStatusFor(row: { kind?: string; interaction_id?: string | null }, interactions: readonly { id: string; status: string }[], replaying: boolean): string | null {
  if (replaying || row.kind !== 'plan' || !row.interaction_id) return null
  return interactions.find((ix) => ix.id === row.interaction_id)?.status ?? null
}

export function planPresence(groupStatus: string | null | undefined): BotState | null {
  switch (groupStatus) {
    case 'planning': case 'deciding': return 'thinking'
    case 'running': return 'idle'
    case 'waiting': case 'interrupted': return 'blocked'
    default: return null
  }
}

/** The bot's state for a run, at `now`. */
export function presenceOf(run: PresenceRun, entries: readonly EntryLike[] | undefined, facts: PresenceFacts = {}, now = Date.now()): BotState {
  const rows = entries ?? NO_ENTRIES
  const plan = planPresence(facts.groupStatus)
  if (plan) return plan
  switch (run.status) {
    case 'queued': return 'waiting'
    case 'watching': return 'waiting'                                   // an interaction node's: its watch waits
    case 'waiting': return 'idle'                                       // a plan's row: the director asleep
    case 'running': return runningPresence(runSignals(rows), facts)
    default: break
  }
  const ending = endingOf(run)
  if (ending === null) return 'static'
  // what still waits for the agent outlasts the moment its ending plays
  if (facts.pendingApproval) return 'blocked'
  if (facts.watching && ending !== 'blocked') return 'waiting'
  const at = endedAt(run)
  const since = Number.isFinite(at) ? now - at : Infinity
  if (ending === 'blocked') return since < BLOCKED_MS ? 'blocked' : facts.watching ? 'waiting' : 'static'
  return since < DONE_MS ? ending : 'static'
}

/** A run whose record says `running`, as its signals say it stands: a form it waits on blocks it, a line it waits in
 *  (its folder's, a request slot) makes it wait, else it thinks — or works while a tool call of it runs. */
function runningPresence(s: Pick<RunSignals, 'openTools' | 'slotWaiting' | 'queued' | 'pendingInput'>, facts: PresenceFacts): BotState {
  if (s.pendingInput || facts.pendingInput) return 'blocked'
  if (s.queued || s.slotWaiting) return 'waiting'
  return s.openTools > 0 ? 'working' : 'thinking'
}

/** "Running", as every view that says only whether an agent works now (the rail's dot) reads it: its bot thinks or
 *  works — its model is asked, thinks, writes, or a tool call of it runs. Never `waiting` (in line for its model, its
 *  folder or a request slot, or a watch: nothing of it runs), never `blocked` (it waits on the person, or ended in an
 *  error), never an ending (`done`, `idle`) nor the still icon. */
export const RUNNING_STATES: ReadonlySet<BotState> = new Set<BotState>(['thinking', 'working'])
export function isRunningState(state: BotState): boolean { return RUNNING_STATES.has(state) }

/** A live run as a summary tells of it (the project list's session activity: no stream, no rows of it on the page),
 *  read by the same rules as presenceOf: its record's status, and the signals its own rows would carry — a request
 *  waiting for its slot, a form of it waiting for the person (a summary never says which tool runs: thinking and
 *  working both read as running alike). */
export function summaryRunPresence(run: { status: string; slot_waiting?: boolean; pending_input?: boolean }, facts: PresenceFacts = {}): BotState {
  if (run.status !== 'running') return presenceOf({ id: '', status: run.status }, NO_ENTRIES, facts)
  return runningPresence({ openTools: 0, queued: false, slotWaiting: run.slot_waiting === true, pendingInput: run.pending_input === true }, facts)
}

/** How long until the bot's state can change with the time alone (its ending settles), or null: it never does. */
export function settlesIn(run: PresenceRun, facts: PresenceFacts = {}, now = Date.now()): number | null {
  const ending = endingOf(run)
  if (ending === null || facts.pendingApproval) return null
  const at = endedAt(run)
  if (!Number.isFinite(at)) return null
  const left = (ending === 'blocked' ? BLOCKED_MS : facts.watching ? -1 : DONE_MS) - (now - at)
  return left > 0 ? left : null
}

// ---- what waits for an agent, on its current run alone --------------------------------------------------------

export interface HeadRow {
  id: string
  session_id: string
  created_at: string
  parent_run_id: string | null
  resumes_run_id?: string | null
  work_order?: unknown
  participant_id?: string | null
  collab?: { participant_id?: string | null; participant_role?: string | null } | null
  kind?: string
  spawned_by?: string | null
  model?: string | null
}

/** Whether a row is an agent's run (one that can be its agent's current run): never a plan's or a decision's row, nor a
 *  person's action (a command, a checkpoint: no model, no bot — it would otherwise read as the main agent's newest run
 *  and take its watch or its approval away), nor a plan's placeholder for a step not yet run (spawned_by plan). */
export function isAgentRun(row: Pick<HeadRow, 'kind' | 'spawned_by' | 'model'>): boolean {
  return (row.kind === undefined || row.kind === 'run') && row.spawned_by !== 'human_action' && row.spawned_by !== 'plan' && row.model !== null
}

export interface PresenceWorld {
  /** every run the page knows (the tree, the thread's runs) */
  rows: readonly HeadRow[]
  watches?: readonly { id: string; run_id: string; status: string }[]
  wakeEvents?: readonly { watch_id: string; status: string }[]
  proposals?: readonly { run_id: string | null; status: string }[]
  approvals?: readonly { id: string; run_id: string | null }[]
  inputs?: Record<string, { run_id: string; status: string }>
  /** a run's own rows (for the approvals its calls named) */
  entriesOf?: (runId: string) => readonly EntryLike[] | undefined
}

export interface PresenceIndex {
  keyOf: Map<string, string>
  heads: Map<string, string>
  watching: Set<string>
  approving: Set<string>
  inputs: Set<string>
}

/** Whose a run is: its participant (the session's main agent, a group's member, a separate task), followed back
 *  through the runs it continues when it names none. */
function agentKeys(rows: readonly HeadRow[]): Map<string, string> {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const keys = new Map<string, string>()
  const keyOf = (row: HeadRow, seen: Set<string>): string => {
    const held = keys.get(row.id)
    if (held) return held
    let key = identityKey(row as Parameters<typeof identityKey>[0])
    if (key === row.id && row.resumes_run_id && byId.has(row.resumes_run_id) && !seen.has(row.id)) {
      seen.add(row.id)
      key = keyOf(byId.get(row.resumes_run_id)!, seen)
    }
    keys.set(row.id, key)
    return key
  }
  for (const r of rows) keyOf(r, new Set())
  return keys
}

export function presenceIndex(world: PresenceWorld): PresenceIndex {
  const runs = world.rows.filter(isAgentRun)
  const keyOf = agentKeys(runs)
  const heads = new Map<string, { id: string; at: string }>()
  for (const r of runs) {
    const key = keyOf.get(r.id)!
    const held = heads.get(key)
    if (!held || r.created_at > held.at || (r.created_at === held.at && r.id > held.id)) heads.set(key, { id: r.id, at: r.created_at })
  }
  const agentOf = (runId: string | null | undefined): string | null => (runId ? keyOf.get(runId) ?? `run:${runId}` : null)
  const watching = new Set<string>()
  const watchRun = new Map((world.watches ?? []).map((w) => [w.id, w.run_id]))
  for (const w of world.watches ?? []) if (w.status === 'active') { const k = agentOf(w.run_id); if (k) watching.add(k) }
  for (const e of world.wakeEvents ?? []) if (e.status === 'pending') { const k = agentOf(watchRun.get(e.watch_id)); if (k) watching.add(k) }
  const approving = new Set<string>()
  for (const p of world.proposals ?? []) if (p.status === 'pending') { const k = agentOf(p.run_id); if (k) approving.add(k) }
  const pending = world.approvals ?? []
  if (pending.length) {
    const ids = new Set(pending.map((a) => a.id))
    for (const a of pending) { const k = agentOf(a.run_id); if (k) approving.add(k) }
    // a reused approval names the run that first asked; the run whose call it refused now is told its id
    if (world.entriesOf) for (const r of runs) {
      if (runSignals(world.entriesOf(r.id) ?? NO_ENTRIES).approvalIds.some((id) => ids.has(id))) approving.add(keyOf.get(r.id)!)
    }
  }
  const inputs = new Set<string>()
  for (const i of Object.values(world.inputs ?? {})) if (i.status === 'pending') inputs.add(i.run_id)
  return { keyOf, heads: new Map([...heads].map(([k, v]) => [k, v.id])), watching, approving, inputs }
}

/** What waits for a run's agent, said on the agent's current run alone (an older answer of it, never). */
export function factsFor(index: PresenceIndex, runId: string): PresenceFacts {
  const key = index.keyOf.get(runId) ?? `run:${runId}`
  const head = index.heads.get(key) ?? runId
  const current = head === runId
  return {
    pendingInput: index.inputs.has(runId),
    pendingApproval: current && index.approving.has(key),
    watching: current && index.watching.has(key),
  }
}

// ---- the director ----------------------------------------------------------------------------------------------

/** The director's bot for one of its turns: queued = waiting; with its model = thinking (working while a tool call of
 *  it runs) — the words submitted to the ChatGPT page and its answer not back yet (awaiting_answer) is its model
 *  answering, thinking too; ended as a run does. `directorState` (the director's own state now) is laid only on the
 *  turn it is on now (`current`), never on a turn of its history: a sign-in it needs blocks. With no turn: its own
 *  state — waiting for the runs it started, blocked on a sign-in, idle (nothing to do, or paused by the person). */
export function directorPresence(turn: { status: string; finished_at?: string | null; updated_at?: string | null } | null,
  directorState: string | null | undefined, liveCalls: readonly { status?: string }[] = [], now = Date.now(), current = true): BotState {
  const state = current ? directorState : null
  if (!turn) {
    switch (state) {
      case 'generating': return 'thinking'
      case 'waiting_for_tasks': return 'waiting'
      case 'needs_login': return 'blocked'
      case 'idle': case 'paused': return 'idle'
      default: return 'static'
    }
  }
  if (state === 'needs_login' && (turn.status === 'queued' || turn.status === 'generating' || turn.status === 'awaiting_answer')) return 'blocked'
  switch (turn.status) {
    case 'queued': return 'waiting'
    case 'awaiting_answer':
    case 'generating': return liveCalls.some((c) => c.status === 'running') ? 'working' : 'thinking'
    default: break
  }
  const ending = turn.status === 'done' ? 'done' : turn.status === 'cancelled' ? 'idle' : turn.status === 'error' ? 'blocked' : null
  if (!ending) return 'static'
  const at = Date.parse(turn.finished_at ?? turn.updated_at ?? '')
  const since = Number.isFinite(at) ? now - at : Infinity
  return since < (ending === 'blocked' ? BLOCKED_MS : DONE_MS) ? ending : 'static'
}

/** How long until a director turn's ending settles (null: it does not, by the time alone). */
export function directorSettlesIn(turn: { status: string; finished_at?: string | null; updated_at?: string | null } | null, now = Date.now()): number | null {
  if (!turn || !['done', 'cancelled', 'error'].includes(turn.status)) return null
  const at = Date.parse(turn.finished_at ?? turn.updated_at ?? '')
  if (!Number.isFinite(at)) return null
  const left = (turn.status === 'error' ? BLOCKED_MS : DONE_MS) - (now - at)
  return left > 0 ? left : null
}

/** An interaction's step as its bot plays it. `run`: its current run as the page holds it (its raw status and its
 *  bot's state), which may be ahead of the node's record (the node is read on the session's tick, the run on its
 *  stream): a run in line or at work plays its own state; else the node's own word — a decision the person owes
 *  blocks, a watch or the line waits — else the run's ending, else the node's status read as a run's. */
export function nodePresence(node: { status: string }, run: { status: string; state: BotState } | null): BotState {
  if (run && LIVE_STATUSES.has(run.status)) return run.state
  if (node.status === 'waiting') return 'blocked'
  if (node.status === 'watching') return 'waiting'
  if (node.status === 'queued') return 'waiting'
  if (run) return run.state
  if (node.status === 'running') return 'thinking'
  if (node.status === 'error') return 'blocked'
  return 'static'
}

/** A step's current run: the newest the page knows of its node (its record's runs, the tree's rows of the node) —
 *  the node's own `run_id` may still name the one before (a step run again after a decision, a watch's wake). */
export function nodeRunOf(node: { id: string; run_id?: string | null; run_ids?: readonly string[] }, interactionId: string,
  ...lists: readonly (readonly { id: string; created_at: string; interaction_id?: string | null; interaction_node?: string | null }[])[]): string | null {
  const ids = new Set([...(node.run_ids ?? []), ...(node.run_id ? [node.run_id] : [])])
  let best: { id: string; created_at: string } | null = null
  for (const rows of lists) for (const r of rows) {
    if (!ids.has(r.id) && !(r.interaction_id === interactionId && r.interaction_node === node.id)) continue
    if (!best || r.created_at > best.created_at || (r.created_at === best.created_at && r.id > best.id)) best = r
  }
  return best?.id ?? node.run_id ?? null
}

// ---- the page's records of a run, after its stream's words -----------------------------------------------------

/** A run's record as its `run_finished` says it ended: its status, receipt and error, and when (the receipt's time, else
 *  the moment the page heard it) — so its bot plays its ending now, not once the record is read again. The event's own
 *  `answer_end` (an older receipt may not carry it) is kept on the receipt: a filtered answer never reads as done. */
export function endedRecord(d: Record<string, unknown>, heardAt = new Date().toISOString()): { status: RunTreeRow['status']; receipt?: unknown; error: string | null; finished_at: string } {
  const said = d.receipt && typeof d.receipt === 'object' ? d.receipt as { finished_at?: unknown; mechanical?: Record<string, unknown> } : undefined
  const end = d.answer_end && typeof d.answer_end === 'object' ? d.answer_end : null
  const receipt = end && !said?.mechanical?.answer_end ? { ...(said ?? {}), mechanical: { ...(said?.mechanical ?? {}), answer_end: end } } : said
  const at = typeof d.finished_at === 'string' ? d.finished_at : typeof said?.finished_at === 'string' ? said.finished_at : heardAt
  return { status: String(d.status ?? 'done') as RunTreeRow['status'], ...(receipt ? { receipt } : {}), error: (d.error as string | null) ?? null, finished_at: at }
}

/** A row after its stream's words: in line or going on (runAfterQueueEvents), ended (run_finished). The same row
 *  when nothing changed. */
export function rowAfter<R extends { status: string; finished_at?: string | null; receipt?: unknown; error?: string | null; waiting?: unknown }>(row: R, items: readonly Pick<SSEItem, 'event' | 'data'>[]): R {
  let next = runAfterQueueEvents(row, items)
  const finished = items.find((item) => item.event === 'run_finished')
  if (finished) {
    const ended = endedRecord(finished.data)
    next = { ...next, status: ended.status, ...('live' in next ? { live: false } : {}), error: ended.error, finished_at: next.finished_at ?? ended.finished_at,
      receipt: (ended.receipt as R['receipt']) ?? next.receipt, waiting: null }
  }
  return next
}

/** The tree with a run's row after its stream's words (the same tree when nothing changed). */
export function treeAfter<R extends { id: string; status: string; finished_at?: string | null; receipt?: unknown }>(tree: R[], runId: string, items: readonly Pick<SSEItem, 'event' | 'data'>[]): R[] {
  const at = tree.findIndex((r) => r.id === runId)
  if (at < 0) return tree
  const row = rowAfter(tree[at]!, items)
  if (row === tree[at]) return tree
  const next = [...tree]
  next[at] = row
  return next
}

const ENDED_STATUSES = new Set(['done', 'error', 'cancelled'])
/** A tree read again over the one the page holds: the harness's rows, except that a row the page already heard end
 *  (its stream's run_finished) is never taken back to live by an answer read before that end; an ended row of the
 *  harness's is taken whole (its full record). */
export function mergeTree<R extends { id: string; status: string; live?: boolean; finished_at?: string | null; receipt?: unknown; error?: string | null }>(local: readonly R[], fresh: R[]): R[] {
  if (!local.length) return fresh
  const held = new Map(local.map((r) => [r.id, r]))
  let changed = false
  const out = fresh.map((r) => {
    const mine = held.get(r.id)
    if (!mine || !ENDED_STATUSES.has(mine.status) || ENDED_STATUSES.has(r.status) || !LIVE_STATUSES.has(r.status)) return r
    changed = true
    return { ...r, status: mine.status, ...('live' in r ? { live: false } : {}), finished_at: mine.finished_at ?? r.finished_at, receipt: mine.receipt ?? r.receipt, error: mine.error ?? r.error ?? null }
  })
  return changed ? out : fresh
}
