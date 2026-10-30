import { useEffect, useState } from 'react'
import type { RunTreeRow } from '../api/types'
import { botSrc, type BotState } from '../state/outline'
import { directorPresence, directorSettlesIn, factsFor, planStatusFor, presenceIndex, presenceOf, settlesIn, type PresenceIndex, type PresenceRun } from '../state/presence'
import { useReplay } from '../state/replay'
import { recordsRunning } from '../state/sessionDots'
import { useStore } from '../state/store'
import { useSharePresentation } from './ThreadPresentation'

/** A share's bot pictures: the still picture of a bot its page carries (a `data:` URL), or null when it carries none
 *  (the bot is then not drawn). Never a path of the app, never an animation. */
export type BotStill = (bot: string) => string | null

/** Every bot picture of the page: one element, its picture by botSrc (an animation of the bot's state, or its still
 *  icon), whole in its box whatever the picture's own proportions (some icons are not square), never squeezed by
 *  the row it stands in; its state said on `data-bot-state` (ChatGPT's mark is still in every state, its state is
 *  said all the same). An identity mark (a chip, a mention, the composer's director) is a still bot.
 *  A share's page draws only the stills it carries: `still` (given by the view that draws it — a share's card, its list
 *  of sessions) or the share's presentation around it (its thread); either one, and the bot is that still whatever its
 *  state, its state said `static`. */
export function BotImage({ bot, state = 'static', className, size, title, still }: { bot: string; state?: BotState; className?: string; size?: number; title?: string; still?: BotStill }) {
  // the session share's copy: the bot's still picture embedded in the page (never a path to fetch), no animation
  const shared = useSharePresentation()
  const stillOf = still ?? shared?.botSrc
  const src = stillOf ? stillOf(bot) : botSrc(bot, state)
  if (src === null) return null
  return (
    <img className={className ? `bot-img ${className}` : 'bot-img'} src={src} alt="" draggable={false} width={size} height={size}
         title={title} data-bot={bot} data-bot-state={stillOf ? 'static' : state} />
  )
}

type StoreState = ReturnType<typeof useStore.getState>

const NONE: readonly never[] = []
const NO_INPUTS: Record<string, never> = {}

/** The time a bot is read at: now, or during a replay the replay's cursor (the record stands as it stood then; its
 *  endings play by the cursor, never by the wall clock). The replay applies its state into the store at each step, so a
 *  selector reading this runs again as the cursor moves. */
function clockOf(s: StoreState): number {
  const replay = useReplay.getState()
  return s.replaying && replay.active ? replay.cursor : Date.now()
}

/** What waits for each agent (state/presence.ts), read once per change of what it is read from, for every bot. */
let held: { key: unknown[]; index: PresenceIndex; byId: Map<string, PresenceRun> } | null = null
export function presenceIndexOf(s: StoreState): PresenceIndex { return heldFor(s).index }
function heldFor(s: StoreState): NonNullable<typeof held> {
  // during a replay the record stands at the cursor: no watch nor approval of now is laid on it
  const live = !s.replaying
  const approvals = (live ? s.session?.pending_approvals : null) ?? NONE
  const key = [s.tree, s.runs, live, live ? s.session?.watches : null, live ? s.session?.wake_events : null, live ? s.proposals : null, live ? s.uiInputs : null,
    approvals, approvals.length ? s.threads : null, approvals.length ? s.childThreads : null]
  if (held && held.key.length === key.length && held.key.every((k, i) => k === key[i])) return held
  const byId = new Map<string, RunTreeRow | StoreState['runs'][number]>()
  for (const r of s.tree) byId.set(r.id, r)
  // the thread's record first: its own stream updates it before the tree is read again
  for (const r of s.runs) byId.set(r.id, later(r, byId.get(r.id)))
  const index = presenceIndex({
    rows: [...byId.values()],
    watches: (live ? s.session?.watches : null) ?? NONE, wakeEvents: (live ? s.session?.wake_events : null) ?? NONE,
    proposals: live ? s.proposals : NONE, approvals, inputs: live ? s.uiInputs : NO_INPUTS,
    entriesOf: (id) => entriesIn(s, id),
  })
  held = { key, index, byId: byId as Map<string, PresenceRun> }
  return held
}

/** A run's own rows: its card's stream's, unless that stream has said nothing yet while the thread's has (a run of
 *  the thread its card also follows: an empty list just opened never hides the rows the thread heard). */
function entriesIn(s: StoreState, id: string) {
  const child = s.childThreads[id]
  const thread = s.threads[id]
  return child && (child.length || !thread) ? child : thread
}

const ENDED = new Set(['done', 'error', 'cancelled'])
/** Of two words on one run, the later: an ended record over a live one (one source heard the end before the other). */
function later<R extends PresenceRun>(a: R, b: R | undefined): R {
  return b && !ENDED.has(a.status) && ENDED.has(b.status) ? b : a
}

/** A run's record as the page holds it now: the thread's (its stream updates it first), else the tree's, else the one
 *  the view drew. */
function recordOf(s: StoreState, run: PresenceRun | string): PresenceRun | null {
  if (typeof run === 'string') return heldFor(s).byId.get(run) ?? null
  return later(heldFor(s).byId.get(run.id) ?? run, run)
}

/** A run's bot state now, in the store's terms (the run's own rows, what waits for its agent). */
export function runPresenceIn(s: StoreState, run: PresenceRun | string, now = clockOf(s)): BotState {
  const record = recordOf(s, run)
  if (!record) return 'static'
  const facts = factsFor(presenceIndexOf(s), record.id)
  // a director's plan row: its interaction's own status, on the live page only (planStatusFor)
  const plan = planStatusFor(record as { kind?: string; interaction_id?: string | null }, s.interactions, s.replaying)
  return presenceOf(record, entriesIn(s, record.id), plan ? { ...facts, groupStatus: plan } : facts, now)
}

/** What the run's ending timer depends on: its record's end and what waits for its agent (a string: stable). */
function settleKey(s: StoreState, run: PresenceRun | string): string {
  const record = recordOf(s, run)
  if (!record) return ''
  const f = factsFor(presenceIndexOf(s), record.id)
  return `${record.status}|${record.finished_at ?? ''}|${(record.receipt as { finished_at?: string } | null | undefined)?.finished_at ?? ''}|${f.watching ? 1 : 0}${f.pendingApproval ? 1 : 0}|${s.replaying ? 1 : 0}`
}

/** A run's bot state, drawn again when it changes (a store selector answering the state alone) and once its ending
 *  has played (one timer, set again when its end or what waits for its agent changes; none during a replay, whose
 *  cursor moves the store). `run`: the record the view holds, or the run's id. */
export function useRunPresence(run: PresenceRun | string | null | undefined): BotState {
  const [, setTick] = useState(0)
  const state = useStore((s) => (run ? runPresenceIn(s, run) : 'static'))
  const key = useStore((s) => (run ? settleKey(s, run) : ''))
  useEffect(() => {
    if (!run) return
    const s = useStore.getState()
    if (s.replaying) return
    const record = recordOf(s, run)
    if (!record) return
    const left = settlesIn(record, factsFor(presenceIndexOf(s), record.id))
    if (left === null) return
    const timer = window.setTimeout(() => setTick((n) => n + 1), left + 50)
    return () => window.clearTimeout(timer)
  }, [key, state]) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}

type DirectorTurnLike = Parameters<typeof directorPresence>[0] & { id?: string }

/** The director's bot state for a turn, or — `undefined` — for the turn it is on now (none: its own state: waiting
 *  for the runs it started, a sign-in it needs, idle). The director's state now is laid on its current turn alone,
 *  never on a turn of its history; an ending settles by one timer (the replay's cursor during a replay). */
export function useDirectorPresence(turn: DirectorTurnLike | undefined, calls?: readonly { status?: string }[]): BotState {
  const directorState = useStore((s) => (s.replaying ? null : s.director?.director?.state ?? null))
  const currentId = useStore((s) => s.director?.director?.current_turn_id ?? null)
  const current = useStore((s) => (turn === undefined && currentId ? s.director?.turns.find((t) => t.id === currentId) ?? null : null))
  const liveCalls = useStore((s) => (turn === undefined && current && s.directorLive?.turn_id === current.id ? s.directorLive.tool_calls : undefined))
  const replaying = useStore((s) => s.replaying)
  const [, setTick] = useState(0)
  const shown = turn === undefined ? current : turn
  const isCurrent = turn === undefined || !turn || turn.id === currentId || turn.status === 'queued'
  const cursor = useReplay((r) => (r.active ? r.cursor : null))
  const now = replaying && cursor !== null ? cursor : Date.now()
  const state = directorPresence(shown, directorState, calls ?? liveCalls, now, isCurrent)
  const ends = shown ? `${shown.status}|${shown.finished_at ?? ''}|${(shown as { updated_at?: string | null }).updated_at ?? ''}` : ''
  useEffect(() => {
    if (replaying) return
    const left = directorSettlesIn(shown)
    if (left === null) return
    const timer = window.setTimeout(() => setTick((n) => n + 1), left + 50)
    return () => window.clearTimeout(timer)
  }, [ends, replaying, state]) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}

/** A run's bot, playing the run's state. */
export function RunBot({ bot, run, className, size }: { bot: string; run: PresenceRun | string; className?: string; size?: number }) {
  return <BotImage bot={bot} state={useRunPresence(run)} className={className} size={size} />
}

// ---- the rail's dot for the open session (state/sessionDots.ts) ---------------------------------------------------

/** Whether one of the open session's agents runs now, by the bots' own reading of the page's records (its stream's
 *  word, at once) — its live runs the detail names that no record holds yet included; null during a replay (the
 *  records stand at the cursor: the rail reads the session's summary then). */
export function openSessionRunningIn(s: StoreState): boolean | null {
  if (s.replaying || !s.session) return null
  const held = heldFor(s)
  const now = Date.now()
  const extra = (s.session.active_runs ?? []).filter((a) => !held.byId.has(a.id)).map((a) => ({ id: a.id, status: a.status }))
  const d = s.director?.director ?? null
  const turn = d?.current_turn_id ? s.director?.turns.find((t) => t.id === d.current_turn_id) ?? null : null
  const calls = turn && s.directorLive?.turn_id === turn.id ? s.directorLive.tool_calls : []
  return recordsRunning([...held.byId.values(), ...extra], (r) => runPresenceIn(s, r, now), d ? { state: d.state, turn, calls } : null)
}
