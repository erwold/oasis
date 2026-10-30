/** The rail's dot on each session: blue while one of its agents runs, green once one ended since the person last
 *  looked at the session, none otherwise. Pure, so node --test exercises it; the store keeps what was seen (in the
 *  page's storage: it outlives a restart of the app) and the rail draws the dot.
 *
 *  - running: read by the bots' own rules (state/presence.ts isRunningState): thinking or working. A run in line for
 *    its model, folder or request slot, a watch, a form or an approval the person owes, an ending: not running. The
 *    open session reads its own records (its stream's, at once); every other session reads the summary the harness
 *    gives for all of them (GET /api/session-activity, contract SessionActivitySchema), so a session in the background
 *    is never missed.
 *  - unread: the session's count of ends (`ended`: every agent run and director turn that reached an end — done, a
 *    stop, an error, an interruption, a filtered answer — each once, two in one millisecond as two) is past the count
 *    the person has seen there. A later end never hides an earlier unseen one: the count only grows. A stop the person
 *    makes in the session they are reading is seen once the summary that counts it lands while they are still there
 *    (it is read at once when the run's stream says it finished).
 *  - seen: what the person saw, per session, as that count. The session the person has open in a visible window is
 *    seen as it goes (each summary that lands while it is in view marks it; an end counted while they read it never
 *    turns green); opening a session sees it. A summary that lands after the person left a session (or hid the
 *    window) never marks that session: an end it counts may have come after they left. The first summary the page holds marks (this feature new, or the
 *    page's storage cleared) lays every session's history as seen: an old end never turns green. A session made after
 *    that (a director's in the background) starts unseen. A session no longer listed loses its mark. */

import type { SessionActivity } from '@oasis-code/contract'
import type { BotState } from './outline.ts'
import { directorPresence, isAgentRun, isRunningState, summaryRunPresence } from './presence.ts'

export type SessionDot = 'running' | 'unread' | null

/** Whether one of the session's agents runs now, as its summary tells (a run, or its director). */
export function activityRunning(activity: SessionActivity | null | undefined): boolean {
  if (!activity) return false
  for (const run of activity.live) {
    if (isAgentRun({ spawned_by: run.spawned_by, model: run.model }) && isRunningState(summaryRunPresence(run))) return true
  }
  const d = activity.director
  return d ? isRunningState(directorPresence(d.turn, d.state)) : false
}

/** Whether the session has ends the person has not seen (no mark: never seen). */
export function isUnread(ended: number | null | undefined, seen: number | null | undefined): boolean {
  if (!ended || ended <= 0) return false
  return seen === null || seen === undefined || ended > seen
}

/** The dot: running first (it says the most now); unread only while the person does not have the session in view. */
export function sessionDot(o: { running: boolean; ended: number | null | undefined; seen: number | null | undefined; viewing: boolean }): SessionDot {
  if (o.running) return 'running'
  if (o.viewing) return null
  return isUnread(o.ended, o.seen) ? 'unread' : null
}

// ---- what was seen ----------------------------------------------------------------------------------------------

/** v2: the marks are counts of ends (v1 held times — a time cannot tell two ends of one millisecond apart; a v1 store
 *  is read as none: the next summary lays history as seen again, never all green). */
export const SEEN_KEY = 'oasis-code.railSeen.v2'

/** What the person saw: a mark per session (how many of its ends were seen); `ready` once the marks were laid the
 *  first time (before that the page has no idea of what was seen and shows no green). */
export interface SeenState { ready: boolean; marks: Readonly<Record<string, number>> }
export const NOT_READY: SeenState = { ready: false, marks: {} }

interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

export function readSeen(storage: StorageLike | null): SeenState {
  if (!storage) return NOT_READY
  try {
    const raw = storage.getItem(SEEN_KEY)
    if (!raw) return NOT_READY
    const body = JSON.parse(raw) as { marks?: unknown }
    const marks: Record<string, number> = {}
    if (body.marks && typeof body.marks === 'object') for (const [k, v] of Object.entries(body.marks)) if (typeof v === 'number' && Number.isFinite(v)) marks[k] = v
    return { ready: true, marks }
  } catch { return NOT_READY }
}

export function writeSeen(storage: StorageLike | null, seen: SeenState): void {
  if (!storage || !seen.ready) return
  try { storage.setItem(SEEN_KEY, JSON.stringify({ marks: seen.marks })) } catch { /* no storage: the marks live as long as the page */ }
}

/** The marks after a summary of every session: the first lays every session's history as seen; after that, a session
 *  no longer listed loses its mark. The same object when nothing changed. */
export function seenAfterSummary(seen: SeenState, sessions: Readonly<Record<string, SessionActivity>>): SeenState {
  if (!seen.ready) {
    const marks: Record<string, number> = {}
    for (const [id, a] of Object.entries(sessions)) marks[id] = a.ended
    return { ready: true, marks }
  }
  const gone = Object.keys(seen.marks).filter((id) => !(id in sessions))
  if (!gone.length) return seen
  const marks = { ...seen.marks }
  for (const id of gone) delete marks[id]
  return { ready: true, marks }
}

/** The marks once the person saw the session with `ended` ends: a mark only moves forward. The same object when
 *  nothing changed. */
export function seenAfterLook(seen: SeenState, sessionId: string, ended: number | null | undefined): SeenState {
  if (!seen.ready || ended === null || ended === undefined) return seen
  const held = seen.marks[sessionId]
  if (held !== undefined && held >= ended) return seen
  return { ready: true, marks: { ...seen.marks, [sessionId]: ended } }
}

// ---- the open session, from the page's own records --------------------------------------------------------------

type RecordLike = { id: string; status: string; kind?: string; spawned_by?: string | null; model?: string | null }

/** Whether one of the open session's agents runs now, from its records (the thread's, the tree's: each run's bot by
 *  `stateOf`, presence's own reading with its rows and what waits for its agent), the live runs its detail names
 *  that no record holds yet, and its director (its current turn and the tool calls that turn runs). */
export function recordsRunning(records: Iterable<RecordLike>, stateOf: (run: RecordLike) => BotState,
  director: { state: string; turn: { status: string; finished_at?: string | null } | null; calls?: readonly { status?: string }[] } | null = null): boolean {
  for (const r of records) {
    if ((r.status !== 'running' && r.status !== 'queued') || !isAgentRun({ kind: r.kind, spawned_by: r.spawned_by, model: r.model })) continue
    if (isRunningState(stateOf(r))) return true
  }
  return director ? isRunningState(directorPresence(director.turn, director.state, director.calls ?? [])) : false
}
