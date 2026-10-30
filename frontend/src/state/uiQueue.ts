/** The request queue of an Intelligent UI surface: one per (session, run, surface), held in a registry, not by a
 *  component — a surface drawn again (its text version and back, a session left and opened again, a second view of it)
 *  finds the same queue, so its requests stay one at a time in the order the person made them, whatever mounts and
 *  unmounts meanwhile. Components only subscribe to what it says.
 *
 *  What it holds: every edit numbered in order (`seq`); the newest edit; the save waiting for the pause; the actions
 *  pressed (each a fixed snapshot, numbered with the edit it carries); the highest edit the harness confirmed. A
 *  request that fails is never restored as it was: what is restored, when anything is, is the newest edit — and only
 *  when no newer save or action already carries it. So a stale save can never land after a newer action or edit. */

import { snapshotAction, type ActionSnapshot, type UiState } from './uiSurface.ts'

export type SaveStatus = { kind: 'idle' } | { kind: 'pending' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'conflict'; message: string } | { kind: 'error'; message: string }
export type ActionStatus = { snapshot: ActionSnapshot; phase: 'preparing' | 'done' | 'already' | 'error'; message?: string } | null

export interface SaverTimers { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }

export interface SurfaceTarget { session_id: string; run_id: string; surface_id: string }

/** What a queue does its work with (the store's actions; a test's fakes). */
export interface QueueDeps {
  delay: number
  save: (target: SurfaceTarget, revision: number, state: UiState) => Promise<unknown>
  prepare: (snapshot: ActionSnapshot) => Promise<{ receipt_id: string; prompt: string }>
  /** the prompt into its own session's draft, once per receipt (false: placed already) */
  place: (sessionId: string, receiptId: string, prompt: string) => boolean
  /** a `run` action's press, as pressed, started as an agent task (POST …/tasks): the task's record as the harness
   *  answered (absent: the surface offers no task) */
  startTask?: (snapshot: ActionSnapshot, input: unknown) => Promise<unknown>
  isConflict: (error: unknown) => boolean
  onConflict: (target: SurfaceTarget) => void
  errorText?: (error: unknown) => string
  timers?: SaverTimers
  newId?: () => string
}

export interface QueueView {
  status: SaveStatus
  action: ActionStatus
  /** the person's newest edit the harness has not confirmed (null: none) — a surface drawn again shows it */
  unconfirmed: { state: UiState; revision: number } | null
}

export interface SurfaceQueue {
  readonly target: SurfaceTarget
  /** the person's state, edited at a spec revision: saved after the pause */
  edit: (state: UiState, revision: number) => void
  /** an action pressed: a snapshot of the newest unconfirmed edit at `base.revision` (else `base`, the state and revision
   *  on show — never an older revision's or an already-confirmed edit) taken now, sent after the request
   *  on its way; edits after the press go after it. Its prompt goes to its own session's draft. */
  press: (actionId: string, base: { state: UiState; revision: number }) => ActionSnapshot
  /** a `run` action pressed: the same snapshot as a press (the newest unconfirmed edit at the revision on show, so
   *  the click carries what the person just typed, and a save waiting for it is folded in), sent in the same order;
   *  the promise is the harness's answer to the start (it rejects with the request's error). `input` is the task's
   *  extra JSON, part of what a retry must repeat to keep its key. */
  launch: (actionId: string, base: { state: UiState; revision: number }, input?: unknown) => { snapshot: ActionSnapshot; started: Promise<unknown> }
  /** a held failed edit sent again (the person's retry) */
  retry: () => void
  /** something of the person's waits, is on its way, is queued or is held */
  busy: () => boolean
  view: () => QueueView
  /** listen to what it says; the returned function stops listening (the queue goes on with its work) */
  subscribe: (listener: (view: QueueView) => void) => () => void
}

interface Edit { state: UiState; revision: number; seq: number }
interface Job { kind: 'save'; edit: Edit }
interface ActionJob { kind: 'action'; edit: Edit; snapshot: ActionSnapshot }
interface TaskJob { kind: 'task'; edit: Edit; snapshot: ActionSnapshot; input: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void }

const defaultTimers: SaverTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }

/** A queue for one surface. `onIdle` is called when it has nothing to do and no one listens (the registry lets it go). */
export function createSurfaceQueue(target: SurfaceTarget, deps: QueueDeps, onIdle: () => void = () => undefined): SurfaceQueue {
  const timers = deps.timers ?? defaultTimers
  const text = deps.errorText ?? ((e: unknown) => (e instanceof Error ? e.message : String(e)))
  let seq = 0
  let latest: Edit | null = null
  let confirmed = 0
  let waiting: Edit | null = null
  let timer: unknown = null
  let held = false
  /** the edit last tried by itself because no view was there to retry it: once per edit, never a loop */
  let triedAlone = 0
  let running = false
  const actions: Array<ActionJob | TaskJob> = []
  let failedPress: ActionSnapshot | null = null
  /** the last start that failed, with its input as JSON: a retry of exactly it keeps its key */
  let failedLaunch: { snapshot: ActionSnapshot; input: string } | null = null
  let status: SaveStatus = { kind: 'idle' }
  let action: ActionStatus = null
  const listeners = new Set<(view: QueueView) => void>()

  const view = (): QueueView => ({ status, action, unconfirmed: latest && latest.seq > confirmed ? { state: latest.state, revision: latest.revision } : null })
  const emit = () => { const v = view(); for (const l of [...listeners]) l(v) }
  const stopTimer = () => { if (timer !== null) { timers.clear(timer); timer = null } }
  const queued = () => waiting !== null || timer !== null || actions.length > 0 || held
  const busy = () => running || queued()
  const idleCheck = () => { if (!busy() && listeners.size === 0) onIdle() }

  /** After a failure: the newest edit, unless a save waiting or an action queued already carries it, or the harness
   *  confirmed it — held for a retry (never the failed request's own, possibly older, state; never in a loop). */
  const recover = () => {
    if (!latest || latest.seq <= confirmed || waiting !== null || actions.some((a) => a.edit.seq >= latest!.seq)) return
    waiting = latest
    held = true
    unheldIfAlone()
  }
  /** with no view to retry it, a held edit is tried once more by itself (leaving never drops an edit) */
  const unheldIfAlone = () => {
    if (!held || listeners.size > 0 || !latest || triedAlone === latest.seq) return
    triedAlone = latest.seq
    held = false
  }

  const run = async (job: Job | ActionJob | TaskJob) => {
    if (job.kind === 'task') {
      try {
        if (!deps.startTask) throw new Error('this surface starts no task')
        const answered = await deps.startTask(job.snapshot, job.input)
        confirmed = Math.max(confirmed, job.edit.seq)
        failedLaunch = null
        job.resolve(answered)
      } catch (error) {
        failedLaunch = { snapshot: job.snapshot, input: inputKey(job.input) }
        if (deps.isConflict(error)) deps.onConflict(target)
        // the start was refused (or failed) and saved nothing: the person's newest values go out as a save of their own
        // (once — a save that fails is held as any other)
        recover()
        held = false
        job.reject(error)
      }
      return
    }
    if (job.kind === 'save') {
      status = { kind: 'saving' }; emit()
      try {
        await deps.save(target, job.edit.revision, job.edit.state)
        confirmed = Math.max(confirmed, job.edit.seq)
        if (!queued()) status = { kind: 'saved' }
      } catch (error) {
        if (deps.isConflict(error)) {
          // the agent republished the surface: edits made at that revision are moot
          if (waiting && waiting.revision <= job.edit.revision) { waiting = null; held = false }
          confirmed = Math.max(confirmed, job.edit.seq)
          status = { kind: 'conflict', message: text(error) }
          deps.onConflict(target)
        } else {
          recover()
          status = { kind: 'error', message: text(error) }
        }
      }
      return
    }
    try {
      const prepared = await deps.prepare(job.snapshot)
      confirmed = Math.max(confirmed, job.edit.seq)
      failedPress = null
      const placed = deps.place(job.snapshot.session_id, prepared.receipt_id, prepared.prompt)
      action = { snapshot: job.snapshot, phase: placed ? 'done' : 'already' }
    } catch (error) {
      failedPress = job.snapshot
      if (deps.isConflict(error)) deps.onConflict(target)
      // the person's newest values are kept for a save of their own: a failed press loses none
      recover()
      action = { snapshot: job.snapshot, phase: 'error', message: text(error) }
      if (held) status = { kind: 'error', message: 'your values were not saved' }
    }
  }

  const pump = () => {
    if (running) return
    let job: Job | ActionJob | TaskJob | undefined = actions.shift()
    if (!job && waiting !== null && timer === null && !held) { job = { kind: 'save', edit: waiting }; waiting = null }
    if (!job) { emit(); idleCheck(); return }
    running = true
    void run(job).finally(() => { running = false; emit(); pump() })
  }

  return {
    target,
    edit: (state, revision) => {
      seq += 1
      latest = { state, revision, seq }
      waiting = latest
      held = false
      stopTimer()
      timer = timers.set(() => { timer = null; pump() }, deps.delay)
      status = running ? { kind: 'saving' } : { kind: 'pending' }
      emit()
    },
    press: (actionId, base) => {
      // only the person's newest edit the harness has not confirmed, and only at the revision on show, outranks what
      // the view shows: an edit already confirmed (a later server state may have replaced it on screen) or one made at
      // an older revision (the agent republished; the view masks it) must never become the action's state
      const current = latest !== null && latest.seq > confirmed && latest.revision === base.revision ? latest : null
      const carried: Edit = current ?? { state: base.state, revision: base.revision, seq }
      const snapshot = snapshotAction(target, carried.revision, actionId, carried.state, failedPress, deps.newId)
      // the press carries the newest edit: a save waiting for it is not needed
      if (waiting && waiting.seq <= carried.seq) { stopTimer(); waiting = null; held = false }
      actions.push({ kind: 'action', edit: carried, snapshot })
      action = { snapshot, phase: 'preparing' }
      emit()
      pump()
      return snapshot
    },
    launch: (actionId, base, input) => {
      const current = latest !== null && latest.seq > confirmed && latest.revision === base.revision ? latest : null
      const carried: Edit = current ?? { state: base.state, revision: base.revision, seq }
      const key = inputKey(input)
      const same = failedLaunch !== null && failedLaunch.input === key ? failedLaunch.snapshot : null
      const snapshot = snapshotAction(target, carried.revision, actionId, carried.state, same, deps.newId)
      if (waiting && waiting.seq <= carried.seq) { stopTimer(); waiting = null; held = false }
      let resolve!: (v: unknown) => void, reject!: (e: unknown) => void
      const started = new Promise<unknown>((res, rej) => { resolve = res; reject = rej })
      actions.push({ kind: 'task', edit: carried, snapshot, input, resolve, reject })
      emit()
      pump()
      return { snapshot, started }
    },
    retry: () => { stopTimer(); held = false; pump() },
    busy,
    view,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        // the last view went: a held edit is tried once more (leaving never drops it); else let the queue go when idle
        unheldIfAlone()
        if (!running) pump()
      }
    },
  }
}

function inputKey(input: unknown): string {
  try { return JSON.stringify(input ?? null) ?? 'null' } catch { return String(Math.random()) }
}

/** Queues by surface (session, run, surface id): the same queue for every view of a surface; one with nothing to do
 *  and no one listening is let go. */
export function createQueueRegistry() {
  const queues = new Map<string, SurfaceQueue>()
  const keyOf = (t: SurfaceTarget) => JSON.stringify([t.session_id, t.run_id, t.surface_id])
  return {
    acquire: (target: SurfaceTarget, deps: QueueDeps): SurfaceQueue => {
      const key = keyOf(target)
      const found = queues.get(key)
      if (found) return found
      const queue = createSurfaceQueue({ ...target }, deps, () => { if (queues.get(key) === queue) queues.delete(key) })
      queues.set(key, queue)
      return queue
    },
    /** the queue of a surface if it has one now (never makes one: a render reads, an effect acquires) */
    peek: (target: SurfaceTarget): SurfaceQueue | undefined => queues.get(keyOf(target)),
    size: () => queues.size,
  }
}

/** The page's registry. */
export const surfaceQueues = createQueueRegistry()
