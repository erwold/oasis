/** The outline's pure readings of a run row (adapted from oasis state/outline.ts, see NOTICE): which bot, which
 *  animation state, which glyph, the tree, the selection chain, what a row waits for. The bot is never a role, and
 *  there is no lead: a participant of a relay or an interaction wears a bot picked by its own id (the same one over
 *  its answers, on its card and in the outline); the session thread's own runs — one agent continuing one conversation — wear the bot
 *  a hash of the session id picks; every other run wears the one a hash of its own id picks, from the owner's set of
 *  twenty-nine; a director's plan row wears the director's own bot, the paper plane; a decision that is the person's wears none. */

import { BOT_HEX, botOf, CHATGPT_BOT, EMPTY_BOT_TABLE, identityTable as identityTableOf, memberBotOf, participantBotOf as participantBotIn, threadActionRecord, type BotIdentityRow, type BotIdentityTable } from '@oasis-code/contract'
import type { RunTreeRow } from '../api/types'

// the bots' identity is the contract's (contract/src/bots.ts: the backend computes the shares' bots with the same
// functions); the outline keeps the open session's one table and the names its views have always read
export { BOTS, BOT_HEX, CHATGPT_BOT, DIRECTOR_BOT, SHARE_BOTS, colourFamily, identityKey, mainBot, participantBots, sessionBots } from '@oasis-code/contract'
export type { BotIdentityTable as IdentityTable } from '@oasis-code/contract'

export type OutlineRow = Pick<RunTreeRow, 'id' | 'session_id' | 'model' | 'spawned_by' | 'parent_run_id' | 'work_order'> & Partial<Pick<RunTreeRow, 'participant_index' | 'participant_id' | 'kind' | 'collab'>>

/** Where a bot's picture is: its icon, or its animation in a state (idle, waiting, thinking, working, blocked, done —
 *  the six the set draws); ChatGPT's mark has no animation. Every bot picture of the page takes its path here. */
export function botSrc(bot: string, state: BotState = 'static'): string {
  return state === 'static' || bot === CHATGPT_BOT ? `/bots/icons/${bot}.png` : `/bots/anim/${state}/${bot}.webp`
}

// ---- identity: one bot per participant, wherever it is shown ---------------------------------------------------

/** The bots of the open session's participants (contract identityTable): every view reads a participant's bot from
 *  here when the harness names it — the thread's turns, the group's strip, the cards, the outline, the summaries, the
 *  relations — so a participant keeps one bot across its groups, its follow-ups and any renumbering of a group. */
let identities: BotIdentityTable = EMPTY_BOT_TABLE

type IdentityRow = Pick<RunTreeRow, 'id' | 'session_id' | 'created_at' | 'interaction_id' | 'relay_id' | 'participant_alias' | 'participant_index'> & Partial<Pick<RunTreeRow, 'collab' | 'participant_id'>>

/** The table for a session's rows (contract identityTable): a row without a stable participant is passed over. */
export function identityTable(rows: readonly IdentityRow[], sessionId: string): BotIdentityTable {
  return identityTableOf(rows as readonly BotIdentityRow[], sessionId)
}

/** The table the views read (the store sets it with every tree it reads; another session's is never used). */
export function setIdentities(table: BotIdentityTable | null): void { identities = table ?? EMPTY_BOT_TABLE }

/** A participant's bot by its stable id, or null when the harness names none (the caller then falls back). */
export function participantBotOf(participantId: string | null | undefined, model?: string | null): string | null {
  return participantBotIn(identities, participantId, model)
}

/** A group member's bot by its group and alias (a step on the strip, a turn of a relay): its stable participant's
 *  when the harness names one, else one picked by its handle in the group. */
export function memberBot(group: { kind: 'interaction' | 'relay'; id: string }, alias: string, model?: string | null): string | null {
  return memberBotOf(identities, group, alias, model)
}

/** The bot a run wears; a person's own action (no model) and the person's decision wear none. A participant the
 *  harness names wears its own bot (never one picked by its place in a group); the main agent the session's. */
export function botFor(row: OutlineRow): string | null {
  return botOf(row, identities)
}

/** What the outline's tree reads of a row — the app's run rows and a share's team rows alike: its id, the run that
 *  dispatched it, the plan that scheduled it, the rows it waits for. */
export interface TreeRow { id: string; parent_run_id: string | null; scheduled_by?: string | null; depends_on: readonly string[] }

/** Who a row hangs under in the outline: the plan that scheduled it, else the run that dispatched it. */
export const parentOf = (row: Pick<TreeRow, 'parent_run_id' | 'scheduled_by'>): string | null => row.scheduled_by ?? row.parent_run_id

export const botColor = (bot: string | null): string => (bot && BOT_HEX[bot]) || 'var(--line-strong)'

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

export const INK_LIGHT = '#ffffff'
export const INK_DARK = '#1b1b1f'

/** The text colour on a bot's colour: white or near-black, whichever contrasts more. */
export function inkOn(hex: string): string {
  const lum = luminance(hex)
  return (luminance(INK_LIGHT) + 0.05) / (lum + 0.05) >= (lum + 0.05) / (luminance(INK_DARK) + 0.05) ? INK_LIGHT : INK_DARK
}

/** The bot's six animations and its still icon (state/presence.ts says which one a run plays). */
export type BotState = 'idle' | 'waiting' | 'thinking' | 'working' | 'done' | 'blocked' | 'static'
export const BOT_STATES: readonly BotState[] = ['idle', 'waiting', 'thinking', 'working', 'done', 'blocked', 'static']

/** Whether a run's own rows say one of its tools runs now: any call whose result has not come (several may be open
 *  at once), never one the model is still writing (a `forming` row: its arguments stream, nothing runs yet). */
export function busyOf(entries: readonly { kind: string; running?: boolean; forming?: unknown }[]): boolean {
  return entries.some((e) => e.kind === 'activity' && e.running === true && !e.forming)
}

/** A live run's line under its rows, in the words its bot plays: the same word wherever the run shows. A run waiting
 *  for what holds its folder says what it waits for (never thinking: no model is asked yet). */
export function liveWord(state: BotState, waiting?: RunWaiting | null): string {
  if (waiting) return waitingLine(waiting)
  switch (state) {
    case 'working': return 'working…'
    case 'waiting': case 'idle': return 'queued for its model'
    case 'blocked': return 'waiting for you'
    default: return 'thinking…'
  }
}

/** What holds the folder a queued run waits for (the contract's run `waiting`, the same fields on its `run_queued`
 *  event): a run, a connector's command, an approval being carried out. Read loosely until the contract types it. */
export type BlockingKind = 'run' | 'command' | 'approval' | 'operation'
export interface RunWaiting {
  reason: string
  workspace_id: string | null
  blocking_owner: string
  blocking_kind: BlockingKind | null
  blocking_run_id: string | null
  /** the commands that hold the folder (a run's background writer still going after the run ended among them) */
  blocking_execution_ids: string[]
  blocking_session_id: string | null
  blocking_proposal_id: string | null
  queued_since: string | null
  position: number | null
}

const KINDS: readonly BlockingKind[] = ['run', 'command', 'approval', 'operation']
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** The holder's kind: as said, else read off its id (`run_…`, `command:cmd_…`, `approval:…`). */
function blockingKindOf(said: unknown, owner: string): BlockingKind | null {
  if (typeof said === 'string' && (KINDS as readonly string[]).includes(said)) return said as BlockingKind
  if (owner.startsWith('command:')) return 'command'
  if (owner.startsWith('approval:')) return 'approval'
  if (owner.startsWith('operation:')) return 'operation'
  if (owner.startsWith('run_')) return 'run'
  return null
}

/** A run's `waiting` (or a `run_queued` event's data) as the page reads it; null when it names no holder (ChatGPT's own
 *  queue, an older harness). */
export function waitingOf(value: unknown): RunWaiting | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const owner = text(v.blocking_owner) ?? text(v.blocking_run_id)
  // the fields under `waiting` (a run record, an event that nests them): read there
  if (!owner) return v.waiting !== value ? waitingOf(v.waiting) : null
  return {
    reason: text(v.reason) ?? 'workspace_lock', workspace_id: text(v.workspace_id), blocking_owner: owner,
    blocking_kind: blockingKindOf(v.blocking_kind, owner), blocking_run_id: text(v.blocking_run_id),
    blocking_execution_ids: Array.isArray(v.blocking_execution_ids) ? v.blocking_execution_ids.filter((x): x is string => typeof x === 'string' && x !== '') : [],
    blocking_session_id: text(v.blocking_session_id), blocking_proposal_id: text(v.blocking_proposal_id),
    queued_since: text(v.queued_since), position: typeof v.position === 'number' && Number.isFinite(v.position) ? v.position : null,
  }
}

/** The holder as the line names it: its kind, then its own id — a command by its execution id (a run that ended with
 *  its background command still writing is the command, never the run), an approval by its proposal. */
export function waitingLine(w: RunWaiting): string {
  if (w.blocking_kind === 'command') {
    const ids = w.blocking_execution_ids
    if (ids.length) return `Waiting for command ${ids[0]}${ids.length > 1 ? ` +${ids.length - 1}` : ''}`
    return w.blocking_owner.startsWith('run_') ? `Waiting for a command of ${w.blocking_owner}` : `Waiting for command ${w.blocking_owner.replace(/^command:/, '')}`
  }
  if (w.blocking_kind === 'approval') return `Waiting for approval ${w.blocking_proposal_id ?? w.blocking_owner.replace(/^approval:/, '')}`
  if (w.blocking_kind === 'run') return `Waiting for run ${w.blocking_run_id ?? w.blocking_owner}`
  // the harness's own step on the folder (`operation:<checkpoint|integrate|…>:<id>`): named by what it does
  if (w.blocking_kind === 'operation') return `Waiting for ${w.blocking_owner.split(':')[1] || 'an operation'}`
  return `Waiting for ${w.blocking_owner}`
}

/** The line's tooltip: where, its place in the queue, since when; every command holding the folder. */
export function waitingTitle(w: RunWaiting): string {
  return [w.workspace_id ? `workspace ${w.workspace_id}` : null, w.blocking_session_id ? `session ${w.blocking_session_id}` : null,
    w.blocking_execution_ids.length > 1 ? `commands ${w.blocking_execution_ids.join(', ')}` : null,
    w.position !== null ? `position ${w.position}` : null, w.queued_since ? `since ${w.queued_since}` : null].filter(Boolean).join(' · ')
}

/** What a live run waits for now: its latest `run_queued` that names a holder, while nothing of the run came after it
 *  (the lock taken — `slot_acquired` — its start, any word or tool); before any event, its record's `waiting` while it
 *  is queued. */
export function liveWaiting(run: { status?: string; waiting?: unknown }, entries: readonly { kind?: string; eventName?: string; detail?: Record<string, unknown> }[]): RunWaiting | null {
  const at = entries.findLastIndex((e) => e.eventName === 'run_queued')
  const went = (from: number) => entries.slice(from).some((e) => (e.eventName !== undefined && WENT_ON.has(e.eventName)) || (e.kind !== undefined && WORKED.has(e.kind)))
  if (at >= 0) return went(at + 1) ? null : waitingOf(entries[at]!.detail)
  if (went(0)) return null
  return run.status === 'queued' ? waitingOf(run.waiting) : null
}
/** what says a queued run went on: the lock taken, its start or end; any word, thought, tool, surface or form of it */
const WENT_ON = new Set(['slot_acquired', 'run_started', 'run_finished'])
const WORKED = new Set(['agent', 'thinking', 'activity', 'ui', 'input', 'error'])

/** The page's run record after its stream said these: queued with what holds it (`run_queued` naming a holder), then
 *  running again once the lock is taken or the run starts. The same record when none of them came. */
export function runAfterQueueEvents<R extends { status: string; waiting?: unknown }>(run: R, items: readonly { event: string; data: Record<string, unknown> }[]): R {
  let next = run
  for (const item of items) {
    // a run that ended stays ended: a stream read again from its start replays the words it waited on before
    if (item.event === 'run_queued' && LIVE_STATUSES.has(next.status)) {
      const waiting = waitingOf(item.data)
      if (waiting) next = { ...next, status: 'queued', waiting }
    } else if ((item.event === 'slot_acquired' || item.event === 'run_started') && next.status === 'queued' && next.waiting) {
      next = { ...next, status: 'running', waiting: null }
    }
  }
  return next
}

/** How long a run's ending plays before its bot settles to its still icon: done, or the person's stop (idle); an
 *  ending that blocked (an error, its budget, its provider's filter, an interruption not the person's) a little longer. */
export const DONE_MS = 25_000
export const BLOCKED_MS = 40_000

/** How a run ended, as its bot plays it: done; idle when the person stopped it (no success, no failure); blocked when
 *  it ended in an error (its budget's included), when the harness stopped it (the app quit: `receipt.interrupted`), or
 *  when its provider's filter cut its answer. Null while it has not ended. */
export function endingOf(run: { status: string; receipt?: unknown }): 'done' | 'idle' | 'blocked' | null {
  const receipt = run.receipt as { interrupted?: boolean; mechanical?: { answer_end?: { reason?: string } | null } } | null | undefined
  if (run.status === 'done') return receipt?.mechanical?.answer_end?.reason === 'content_filter' ? 'blocked' : 'done'
  if (run.status === 'cancelled') return receipt?.interrupted === true ? 'blocked' : 'idle'
  if (run.status === 'error' || run.status === 'interrupted') return 'blocked'
  return null
}

/** When a run ended, as its row or its receipt says (NaN: not said). */
export function endedAt(run: { finished_at?: string | null; receipt?: unknown }): number {
  const said = run.finished_at ?? (run.receipt as { finished_at?: string | null } | null | undefined)?.finished_at ?? null
  return said ? Date.parse(said) : NaN
}

/** The bot's state read off the run alone (state/presence.ts adds what waits for its agent): queued = waiting; a
 *  plan's row asleep = idle; running = thinking while the model speaks or is waited for, working while one of its
 *  tools runs (`busy`, from its own stream); a run that just ended plays its ending for a moment, then settles to its
 *  static icon. */
export function botState(row: { status: string; finished_at?: string | null; receipt?: unknown }, busy: boolean, now: number): BotState {
  switch (row.status) {
    case 'queued': return 'waiting'
    case 'waiting': return 'idle'                                      // a plan's row: the director asleep, the person's turn
    case 'running': return busy ? 'working' : 'thinking'
    default: break
  }
  const ending = endingOf(row)
  if (ending === null) return 'static'
  const at = endedAt(row)
  const since = Number.isFinite(at) ? now - at : Infinity
  return since < (ending === 'blocked' ? BLOCKED_MS : DONE_MS) ? ending : 'static'
}

/** What a finished run's icon says, from what its receipt measured: done; warn when it is done and some of its
 *  commands exited with an error (an agent's probes and tries often do: no failure of the run); bad when something
 *  that judges the work failed (a check, a lock); err when the run itself ended in error or was stopped. No verdict on
 *  the task. */
export type Glyph = 'done' | 'warn' | 'bad' | 'err' | null
export function glyphFor(row: Pick<RunTreeRow, 'status' | 'receipt'>): Glyph {
  if (row.status === 'error' || row.status === 'cancelled') return 'err'
  if (row.status !== 'done') return null
  const m = row.receipt?.mechanical
  if ((m?.checks?.failed ?? 0) > 0 || (m?.lock_violations ?? 0) > 0) return 'bad'
  return (m?.failed_executions ?? 0) > 0 ? 'warn' : 'done'
}

/** What the icon means for this run, for its tooltip: what was measured, in counts. */
export function glyphTitle(row: Pick<RunTreeRow, 'status' | 'receipt'>, glyph: Glyph): string {
  const m = row.receipt?.mechanical
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
  if (glyph === 'err') return row.status === 'cancelled' ? 'Stopped' : 'Ended in an error'
  if (glyph === 'bad') {
    const said = [(m?.checks?.failed ?? 0) > 0 ? `${plural(m!.checks!.failed!, 'check')} failed` : '', (m?.lock_violations ?? 0) > 0 ? `${plural(m!.lock_violations!, 'locked file')} changed` : '']
    return `Done · ${said.filter(Boolean).join(' · ')}`
  }
  if (glyph === 'warn') return `Done · ${plural(m?.failed_executions ?? 0, 'command')} exited with an error`
  return glyph === 'done' ? 'Done' : ''
}

export interface OutlineNode<R extends TreeRow = RunTreeRow> { row: R; children: OutlineNode<R>[]; depth: number }

/** The runs as a forest: who scheduled a row (a plan), else its parent run, is the tree; a row whose parent is not
 *  in the list is a root. */
export function buildTree<R extends TreeRow>(rows: readonly R[]): OutlineNode<R>[] {
  const byId = new Map<string, OutlineNode<R>>()
  for (const row of rows) byId.set(row.id, { row, children: [], depth: 0 })
  const roots: OutlineNode<R>[] = []
  for (const row of rows) {
    const node = byId.get(row.id)!
    const parentId = parentOf(row)
    const parent = parentId ? byId.get(parentId) : undefined
    if (parent) parent.children.push(node); else roots.push(node)
  }
  const stamp = (n: OutlineNode<R>, depth: number) => { n.depth = depth; n.children.forEach((c) => stamp(c, depth + 1)) }
  roots.forEach((r) => stamp(r, 0))
  return roots
}

/** The lit set of a selection: the selected row, every ancestor up to its root, its whole subtree, and the rows a
 *  dependency edge joins it to — what it waits for, and what waits for it. */
export function selectionChain(rows: readonly TreeRow[], selected: string | null): Set<string> {
  const lit = new Set<string>()
  if (!selected) return lit
  const byId = new Map(rows.map((r) => [r.id, r]))
  let cur = byId.get(selected)
  while (cur) { lit.add(cur.id); const up = parentOf(cur); cur = up ? byId.get(up) : undefined }
  let grew = true
  while (grew) {
    grew = false
    for (const r of rows) { const up = parentOf(r); if (up && lit.has(up) && !lit.has(r.id) && isUnder(byId, r.id, selected)) { lit.add(r.id); grew = true } }
  }
  const picked = byId.get(selected)
  for (const id of picked?.depends_on ?? []) if (byId.has(id)) lit.add(id)
  for (const r of rows) if (r.depends_on.includes(selected)) lit.add(r.id)
  return lit
}

function isUnder(byId: Map<string, TreeRow>, id: string, ancestor: string): boolean {
  let cur = byId.get(id)
  while (cur) { if (cur.id === ancestor) return true; const up = parentOf(cur); cur = up ? byId.get(up) : undefined }
  return false
}

/** The rows a row waits for, as the outline names them: the participant's place (`#1`, the badge its bot wears)
 *  when the row has one, else the id's short form. */
export function waitsNames(row: Pick<TreeRow, 'depends_on'>, byId: ReadonlyMap<string, { participant_index?: number | null }>): string[] {
  return row.depends_on.map((id) => { const i = byId.get(id)?.participant_index; return i !== null && i !== undefined ? `#${i + 1}` : id.slice(4, 10) })
}

export function waitsLabel(row: Pick<TreeRow, 'depends_on'>, byId: ReadonlyMap<string, { participant_index?: number | null }>, word = 'waits'): string {
  return `${word} ${waitsNames(row, byId).join(', ')}`
}

/** The dependency edges among the rows on show — the folded ones have no end to draw to — with `k`, which of the
 *  waiting row's dependencies the edge is (its lane at the right edge). */
export function dependencyEdges(visible: readonly Pick<TreeRow, 'id' | 'depends_on'>[]): { from: string; to: string; k: number }[] {
  const shown = new Set(visible.map((r) => r.id))
  const out: { from: string; to: string; k: number }[] = []
  for (const row of visible) row.depends_on.forEach((from, k) => { if (shown.has(from)) out.push({ from, to: row.id, k }) })
  return out
}

/** A run's name where it is shown as an agent: the session's main agent by its place (its label says only who sent
 *  the message — a connector's name, not the agent's), any other by its order's label or its first line. */
export function nameOf(row: Pick<RunTreeRow, 'label' | 'user_text_head' | 'id'> & { collab?: RunTreeRow['collab']; spawned_by?: string | null; work_order?: RunTreeRow['work_order'] }): string {
  if (row.collab?.participant_role === 'main') return 'Main agent'
  // a connector's run carries the connector's name as its label unless its order named it: that names the sender
  if (row.spawned_by === 'connector' && !row.work_order?.label) return row.user_text_head || row.label || row.id
  return row.label || row.user_text_head || row.id
}

/** A row that records an action (a director's or a person's command, integration, checkpoint), not an agent's run. */
export const isActionRow = (row: Pick<RunTreeRow, 'spawned_by'>): boolean => row.spawned_by === 'human_action'

export function durationOf(row: Pick<RunTreeRow, 'created_at' | 'finished_at'>, now: number): string {
  const end = row.finished_at ? Date.parse(row.finished_at) : now
  const ms = end - Date.parse(row.created_at)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const m = Math.round(ms / 60000)
  return m >= 60 ? `${(m / 60).toFixed(1)}h` : m >= 1 ? `${m}m` : `${Math.round(ms / 1000)}s`
}

export const LIVE_STATUSES = new Set(['queued', 'running'])

/** An action taken beside the agents (a command, a checkpoint, checks, an integration), as the thread lists it:
 *  what it was, who took it (a connector's client, or the person by hand), its first line and its outcome line. */
export interface ThreadAction { id: string; at: string; what: string; by: string | null; head: string; outcome: string | null; text: string }

export function threadActions(rows: Pick<RunTreeRow, 'id' | 'spawned_by' | 'label' | 'created_at' | 'user_text'>[]): ThreadAction[] {
  // the label's what/by and the text's head/outcome: the one reading the session share's action item is made with too
  // (contract/src/actions.ts), so the app and the exported copy say the same line
  return rows.filter(isActionRow).map((r): ThreadAction => ({ id: r.id, at: r.created_at, ...threadActionRecord(r.label, r.user_text), text: r.user_text }))
    .sort((a, b) => a.at.localeCompare(b.at))
}

/** The clock a row's bot and right side read: the time now while it can still change with the time (a row not ended,
 *  or ended within the 45 s its icon plays done or blocked); for a row ended before that, a clock that never moves —
 *  what botState and durationOf answer for it no longer depends on the time, so a row passed it draws once, not on
 *  every tick of the clock. */
export function stateClock(row: Pick<RunTreeRow, 'finished_at'>, now: number): number {
  const ended = row.finished_at ? Date.parse(row.finished_at) : NaN
  return Number.isFinite(ended) && now - ended >= 45_000 ? Number.POSITIVE_INFINITY : now
}

/** The rows of a list of `count` rows `row` px tall to draw for a view `height` px tall scrolled to `top`: those in
 *  view and `overscan` rows on each side (an end past the last row is the count). */
export function rowWindow(top: number, height: number, count: number, row: number, overscan: number): { start: number; end: number } {
  const first = Math.floor(Math.max(0, top) / row)
  const last = Math.ceil((Math.max(0, top) + Math.max(0, height)) / row)
  return { start: Math.max(0, first - overscan), end: Math.min(count, last + overscan) }
}

export interface RailPoint { x: number; y: number }
export interface RailLine { d: string; lit: boolean; color: string; len: number; key: string }
export interface RailEdge { x: number; y1: number; y2: number; color: string; lit: boolean; key: string }

/** The hairline from a parent's icon down and into its child's: an elbow, and its length (the flow's dash runs it). */
export function elbow(p: RailPoint, q: RailPoint): { d: string; len: number } {
  const r = 6, x1 = p.x, y1 = p.y + 10, xe = q.x - 10
  return { d: `M${x1} ${y1} L${x1} ${q.y - r} Q${x1} ${q.y} ${x1 + r} ${q.y} L${xe} ${q.y}`, len: (q.y - r - y1) + (Math.PI * r / 2) + (xe - x1 - r) }
}

/** The outline's rails, from where its icons stand — every row is one row tall and indented one step per depth, so
 *  the icon of the `i`th shown row stands at the reference row's plus (i - ref.index) rows down and (depth -
 *  ref.depth) steps across: one row measured places them all, drawn or not (a list that draws only the rows in view
 *  still joins a row in view to its parent above it). The spawn lines (the folder to each root, each open row to its
 *  children) and the dependency lanes at the right edge (`right`), each kept when it crosses the band from `top` to
 *  `bottom` (a line wholly out of view is not drawn, nor one hidden under another along the whole band). */
export function railsOf(o: {
  visible: readonly { row: TreeRow; children: readonly { row: TreeRow }[]; depth: number }[]
  roots: readonly { row: TreeRow }[]
  closed: ReadonlySet<string>
  folder: RailPoint | null
  ref: { index: number; depth: number; at: RailPoint } | null
  ind: number; rowH: number; right: number; top: number; bottom: number
  spawnLit: ReadonlySet<string>
  selected: string | null
  colorOf: (id: string) => string
}): { lines: RailLine[]; edges: RailEdge[] } {
  const index = new Map(o.visible.map((n, i) => [n.row.id, i]))
  const depthOf = new Map(o.visible.map((n) => [n.row.id, n.depth]))
  const at = (id: string): RailPoint | null => {
    const i = index.get(id)
    if (i === undefined || !o.ref) return null
    return { x: o.ref.at.x + (depthOf.get(id)! - o.ref.depth) * o.ind, y: o.ref.at.y + (i - o.ref.index) * o.rowH }
  }
  const crosses = (a: number, b: number) => Math.max(a, b) >= o.top && Math.min(a, b) <= o.bottom
  const lines: RailLine[] = []
  // a parent's lines: each child's elbow whose arm is in the band; of the children below the band, whose lines all
  // run down the same stretch of the band, the last (drawn on top of the others) and any lit one
  const fan = (p: RailPoint, from: string, kids: readonly { row: TreeRow }[]) => {
    const below: { q: RailPoint; row: TreeRow }[] = []
    for (const c of kids) {
      const q = at(c.row.id)
      if (!q || !crosses(p.y, q.y)) continue
      if (q.y > o.bottom) below.push({ q, row: c.row })
      else lines.push({ ...elbow(p, q), lit: o.spawnLit.has(c.row.id), color: o.colorOf(c.row.id), key: `${from}->${c.row.id}` })
    }
    below.forEach(({ q, row }, i) => {
      if (i === below.length - 1 || o.spawnLit.has(row.id)) lines.push({ ...elbow(p, q), lit: o.spawnLit.has(row.id), color: o.colorOf(row.id), key: `${from}->${row.id}` })
    })
  }
  if (o.folder) fan(o.folder, '__session', o.roots)
  for (const n of o.visible) {
    if (o.closed.has(n.row.id)) continue
    const p = at(n.row.id)
    if (p) fan(p, n.row.id, n.children)
  }
  const edges: RailEdge[] = []
  for (const e of dependencyEdges(o.visible.map((n) => n.row))) {
    const a = at(e.from), b = at(e.to)
    if (!a || !b || !crosses(a.y, b.y)) continue
    edges.push({ x: o.right - 9 - e.k * 5, y1: a.y + 9, y2: b.y - 9, color: o.colorOf(e.from), lit: !!o.selected && (e.from === o.selected || e.to === o.selected), key: `${e.from}~>${e.to}` })
  }
  return { lines, edges }
}

/** The clock a desk card's bot reads: none for a live row (botState answers a live row by its stream, never by the
 *  time), stateClock otherwise — a card at work draws again for its stream, not for every tick of the clock. */
export function botClock(row: Pick<RunTreeRow, 'status' | 'finished_at'>, now: number): number {
  return LIVE_STATUSES.has(row.status) ? 0 : stateClock(row, now)
}
