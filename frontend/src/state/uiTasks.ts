/** The agent tasks of an Intelligent UI surface (a `run` action pressed on a native surface, or oasisUI.run in an html
 *  one), held per (session, run, surface) in a registry — not by a component — so a surface drawn again, a frame
 *  reloaded, a session left and opened again finds the same tasks with what it streamed so far.
 *
 *  What is true about a task is the harness's record (UiTaskRecord, its `updated_at` strictly increasing): every
 *  status, every `data`, the end and its result come from a record — a `ui_task` event of the task's agent run, the
 *  answer to the start, a GET of the task or of the surface's list. Nothing here decides a status from how fast
 *  anything answers. What the record does not carry while the task runs — the answer as it streams, the tools it
 *  calls — is read from the agent run's own stream, followed with its cursor (a stream picked up again goes on after
 *  the last event it delivered, never twice).
 *
 *  While queued (no agent run yet) the task is asked for every second, only while someone watches the surface (a
 *  mounted view, a frame listening, a run() waiting). A run that ended without the task's terminal record makes the
 *  task be asked for again: the stream's end alone never ends a task. Updates (UiTaskUpdate) go to whoever listens:
 *  the frame's onTask / onProgress, the native card. */

import {
  isUiTaskActive, uiTaskRefusal, uiTaskResult, uiTaskView, UI_TASK_LIMITS, UiTaskRecordSchema,
  type UiTaskRecord, type UiTaskResult, type UiTaskUpdate, type UiTaskView,
} from '@oasis-code/contract'
import type { SurfaceTarget } from './uiQueue.ts'

export type { UiTaskRecord, UiTaskResult, UiTaskUpdate, UiTaskView }

/** One event of the agent run's stream (as api/sse.ts delivers it). */
export interface TaskRunEvent { event: string; data: Record<string, unknown>; id?: string }

export interface TaskTimers { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }

/** What the tasks of a surface do their work with (the API; a test's fakes). */
export interface TaskDeps {
  list: (target: SurfaceTarget) => Promise<UiTaskRecord[]>
  get: (sessionId: string, taskId: string) => Promise<UiTaskRecord>
  cancel: (sessionId: string, taskId: string) => Promise<UiTaskRecord>
  /** the agent run's events after `after` (null: from its start); the returned function stops following. onClose:
   *  the stream ended by itself (the run finished, or is over). */
  follow: (runId: string, after: number | null, onEvent: (item: TaskRunEvent) => void, onClose: () => void) => () => void
  /** a task has its agent run now (the thread may show that run at once): the record that says so */
  onRun?: (record: UiTaskRecord) => void
  /** the refusal a failed request stands for: the route's code and words, the task it names (task_active) */
  refusalOf?: (error: unknown) => { code: string; message: string; task?: unknown; notFound?: boolean }
  timers?: TaskTimers
  /** how often a queued task (or one whose run ended before its record did) is asked for */
  pollMs?: number
}

/** A task as a view shows it: the record, the answer as it streams (the record's own text once it ended), its tools. */
export interface TaskLive {
  record: UiTaskRecord
  text: string
  tools: { name: string; summary: string }[]
  /** a stop was asked and the task has not ended yet */
  stopping: boolean
}

export interface TasksView {
  /** newest first */
  tasks: TaskLive[]
  /** the press whose start is on its way (its action id) */
  starting: string | null
  /** the last start the harness refused (no task was made) */
  refused: { action_id: string; result: UiTaskResult } | null
  /** the surface's list was read once at least */
  loaded: boolean
}

interface Entry {
  record: UiTaskRecord
  text: string
  tools: { name: string; summary: string }[]
  stopping: boolean
  /** its end was said (a done update) or it was already over when first seen (history: nothing to say) */
  ended: boolean
  /** the last event of its run delivered (the stream's cursor), null before any */
  cursor: number | null
  unfollow: (() => void) | null
  /** its run's stream said the run is over */
  runOver: boolean
  poll: unknown
  asking: boolean
  waiters: Array<(r: UiTaskResult) => void>
}

const TOOL_LINES = 40
const defaultTimers: TaskTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }

/** A JSON value's words, for telling two data apart (a data the same as before is no update). */
function jsonOf(v: unknown): string {
  try { return JSON.stringify(v ?? null) ?? 'null' } catch { return '' }
}

/** The ApiError-shaped refusal: `{ status, detail, body: { error, task? } }`; anything else is `unavailable`. */
export function refusalOfError(error: unknown): { code: string; message: string; task?: unknown; notFound?: boolean } {
  const e = error as { status?: unknown; detail?: unknown; body?: unknown; message?: unknown } | null
  const body = e && typeof e.body === 'object' && e.body !== null ? (e.body as Record<string, unknown>) : null
  const status = typeof e?.status === 'number' ? e.status : null
  const code = typeof body?.error === 'string' ? body.error : status === 404 ? 'not_found' : status !== null ? `http_${status}` : 'unavailable'
  const message = typeof e?.detail === 'string' && e.detail ? e.detail : typeof e?.message === 'string' ? e.message : String(error)
  return { code, message, ...(body && body.task !== undefined ? { task: body.task } : {}), ...(status === 404 ? { notFound: true } : {}) }
}

export interface SurfaceTasks {
  readonly target: SurfaceTarget
  view: () => TasksView
  /** a view listens (and is watching while it does); the function returned stops it */
  subscribe: (listener: (view: TasksView) => void) => () => void
  /** every update of this surface's tasks from now on (watching while it listens) */
  onUpdate: (listener: (update: UiTaskUpdate) => void) => () => void
  /** the surface's tasks as the harness lists them (once per watch, and when asked) */
  refresh: () => Promise<void>
  /** a record the harness answered with (a start, a stop, an event the store saw) */
  adopt: (record: unknown) => void
  /** start a task — `start` is the request (the queue's launch) answering `{ task }` — and resolve with its result
   *  when it ends, or at once with a `refused` one. `started` hears the task's id before any of its updates. Never
   *  rejects. */
  run: (actionId: string, start: () => Promise<unknown>, started?: (taskId: string) => void) => Promise<UiTaskResult>
  /** ask a task of this surface to stop: true when the harness took the stop */
  stop: (taskId: string) => Promise<boolean>
  /** the tasks as a page sees them, newest first, at most UI_TASK_LIMITS.list */
  views: () => UiTaskView[]
  /** what a listener arriving now has missed of the tasks still under way: their status, text so far, data */
  current: () => UiTaskUpdate[]
}

export function createSurfaceTasks(target: SurfaceTarget, deps: TaskDeps): SurfaceTasks {
  const timers = deps.timers ?? defaultTimers
  const pollMs = deps.pollMs ?? 1_000
  const refusalOf = deps.refusalOf ?? refusalOfError
  const entries = new Map<string, Entry>()
  const viewers = new Set<(v: TasksView) => void>()
  const hearers = new Set<(u: UiTaskUpdate) => void>()
  let starting: string | null = null
  let refused: TasksView['refused'] = null
  let loaded = false
  let listing: Promise<void> | null = null
  let snapshot: TasksView | null = null

  const watching = () => viewers.size > 0 || hearers.size > 0
  const ordered = () => [...entries.values()].sort((a, b) => (b.record.created_at.localeCompare(a.record.created_at)) || b.record.id.localeCompare(a.record.id))
  const view = (): TasksView => {
    if (!snapshot) snapshot = { tasks: ordered().map((e) => ({ record: e.record, text: e.text, tools: e.tools, stopping: e.stopping })), starting, refused, loaded }
    return snapshot
  }
  const changed = () => { snapshot = null; const v = view(); for (const l of [...viewers]) l(v) }
  const say = (u: UiTaskUpdate) => { for (const l of [...hearers]) { try { l(u) } catch { /* a listener's own fault */ } } }
  const base = (e: Entry) => ({ task_id: e.record.id, action_id: e.record.action_id })

  const settle = (e: Entry) => {
    const result = uiTaskResult(e.record)
    if (!result) return
    const waiting = e.waiters.splice(0)
    for (const w of waiting) w(result)
  }

  const stopFollowing = (e: Entry) => { if (e.unfollow) { const f = e.unfollow; e.unfollow = null; f() } }
  const stopPolling = (e: Entry) => { if (e.poll !== null) { timers.clear(e.poll); e.poll = null } }

  /** follow or ask, as the task stands and as long as anyone watches it */
  const track = (e: Entry) => {
    const active = isUiTaskActive(e.record.status)
    if (!active || (!watching() && e.waiters.length === 0)) { stopFollowing(e); stopPolling(e); return }
    const runId = e.record.agent_run_id
    if (e.record.status === 'running' && runId && !e.runOver) {
      stopPolling(e)
      if (!e.unfollow) follow(e, runId)
      return
    }
    // queued, or its run is over and its end has not come yet: ask again in a while
    if (e.poll === null && !e.asking) e.poll = timers.set(() => { e.poll = null; void ask(e) }, pollMs)
  }

  const ask = async (e: Entry) => {
    if (e.asking || !isUiTaskActive(e.record.status)) return
    e.asking = true
    try {
      adopt(await deps.get(target.session_id, e.record.id))
    } catch (error) {
      // the task is gone (its session deleted): that is its end, said by the harness
      if (refusalOf(error).notFound) gone(e)
    } finally {
      e.asking = false
      track(e)
    }
  }

  const gone = (e: Entry) => {
    const now = new Date().toISOString()
    e.record = { ...e.record, status: 'failed', error: { code: 'not_found', message: 'the task is no longer known to the harness' }, finished_at: e.record.finished_at ?? now }
    finish(e)
    changed()
  }

  const finish = (e: Entry) => {
    stopFollowing(e); stopPolling(e)
    e.stopping = false
    // the answer is the record's once the task ended (the streamed words were its progress)
    if (e.record.text) e.text = e.record.text
    if (!e.ended) {
      e.ended = true
      const result = uiTaskResult(e.record)
      if (result) say({ type: 'done', ...base(e), result })
    }
    settle(e)
  }

  const follow = (e: Entry, runId: string) => {
    let open = true
    const stop = deps.follow(runId, e.cursor, (item) => {
      if (!open) return
      const seq = item.id && /^\d+$/.test(item.id) ? Number(item.id) : null
      if (seq !== null) e.cursor = seq
      const d = item.data
      switch (item.event) {
        case 'ui_task': adopt(d.task); return
        case 'text_delta': {
          const delta = typeof d.text === 'string' ? d.text : ''
          if (!delta && d.start !== true) return
          // a new block of words after earlier ones reads as a new paragraph
          const add = d.start === true && e.text ? `\n\n${delta}` : delta
          e.text = (e.text + add).slice(-UI_TASK_LIMITS.progressTextChars)
          if (!e.ended) say({ type: 'text', ...base(e), delta: add, text: e.text })
          changed()
          return
        }
        case 'tool_call': {
          const tool = { name: typeof d.tool === 'string' ? d.tool : String(d.tool ?? ''), summary: String(d.summary ?? '').replace(/\s+/g, ' ').slice(0, 200) }
          e.tools = [...e.tools, tool].slice(-TOOL_LINES)
          if (!e.ended) say({ type: 'tool', ...base(e), ...tool })
          changed()
          return
        }
        case 'run_finished':
          e.runOver = true
          // the terminal record comes before run_finished; when it did not, the task is asked for
          if (isUiTaskActive(e.record.status)) void ask(e)
          return
      }
    }, () => {
      if (!open) return
      open = false
      e.unfollow = null
      e.runOver = true
      if (isUiTaskActive(e.record.status)) void ask(e)
    })
    e.unfollow = () => { open = false; stop() }
  }

  const adopt = (raw: unknown) => {
    const parsed = UiTaskRecordSchema.safeParse(raw)
    if (!parsed.success) return
    const record = parsed.data
    if (record.session_id !== target.session_id || record.surface_run_id !== target.run_id || record.surface_id !== target.surface_id) return
    let e = entries.get(record.id)
    if (!e) {
      const active = isUiTaskActive(record.status)
      e = { record, text: active ? '' : record.text, tools: [], stopping: false, ended: !active, cursor: null, unfollow: null, runOver: false, poll: null, asking: false, waiters: [] }
      entries.set(record.id, e)
      if (active) {
        say({ type: 'status', ...base(e), status: record.status as 'queued' | 'running' })
        // a task first seen with data says it; one with none yet has nothing to say
        if (record.data !== null && record.data !== undefined) say({ type: 'data', ...base(e), data: record.data })
      }
      if (record.agent_run_id) deps.onRun?.(record)
      if (!active) settle(e)
      track(e)
      changed()
      return
    }
    const before = e.record
    // the later word only: a record written before the one held (a replayed event, a list read earlier) is not
    if (!(record.updated_at > before.updated_at)) { track(e); return }
    e.record = record
    if (record.agent_run_id && record.agent_run_id !== before.agent_run_id) { e.runOver = false; e.cursor = null; deps.onRun?.(record) }
    if (isUiTaskActive(record.status) && record.status !== before.status && !e.ended) say({ type: 'status', ...base(e), status: record.status as 'queued' | 'running' })
    // every replacement of the data is said at once — null included (return_ui_result cleared it); the same value again is not
    if (jsonOf(record.data) !== jsonOf(before.data) && !e.ended) say({ type: 'data', ...base(e), data: record.data ?? null })
    if (!isUiTaskActive(record.status)) finish(e)
    else track(e)
    changed()
  }

  const refresh = (): Promise<void> => {
    if (listing) return listing
    listing = (async () => {
      try {
        const tasks = await deps.list(target)
        for (const t of tasks) adopt(t)
      } catch { /* the next watch asks again */ }
      finally {
        listing = null
        if (!loaded) { loaded = true; changed() }
      }
    })()
    return listing
  }

  const wake = () => { for (const e of entries.values()) track(e) }

  const surface: SurfaceTasks = {
    target,
    view,
    subscribe: (listener) => {
      const first = !watching()
      viewers.add(listener)
      if (first) { void refresh(); wake() }
      return () => { viewers.delete(listener); if (!watching()) wake() }
    },
    onUpdate: (listener) => {
      const first = !watching()
      hearers.add(listener)
      if (first) { void refresh(); wake() }
      return () => { hearers.delete(listener); if (!watching()) wake() }
    },
    refresh,
    adopt,
    run: async (actionId, start, started) => {
      starting = actionId
      changed()
      let answered: unknown
      try {
        answered = await start()
      } catch (error) {
        const r = refusalOf(error)
        if (r.task !== undefined) adopt(r.task)
        const result = uiTaskRefusal(r.code, r.message)
        starting = null
        refused = { action_id: actionId, result }
        changed()
        return result
      }
      starting = null
      refused = null
      const parsed = UiTaskRecordSchema.safeParse((answered as { task?: unknown } | null)?.task)
      if (!parsed.success) {
        changed()
        return uiTaskRefusal('unavailable', 'the harness answered the start with no task')
      }
      const id = parsed.data.id
      started?.(id)
      adopt(parsed.data)
      const e = entries.get(id)
      changed()
      if (!e) return uiTaskRefusal('unavailable', 'the harness answered with a task of another surface')
      // it may have ended already (a start answered again with its request's earlier task)
      const ended = uiTaskResult(e.record)
      if (ended) return ended
      return new Promise<UiTaskResult>((resolve) => { e.waiters.push(resolve); track(e) })
    },
    stop: async (taskId) => {
      const e = entries.get(taskId)
      if (!e || !isUiTaskActive(e.record.status)) return false
      e.stopping = true
      changed()
      try {
        adopt(await deps.cancel(target.session_id, taskId))
        return true
      } catch (error) {
        const r = refusalOf(error)
        if (r.notFound) gone(e)
        // a refusal that names the task (409 task_finishing: its run is already writing its end; it ends as the run
        // does, never as stopped) is the harness's word on it: taken, and the task is followed on to that end
        else if (r.task !== undefined) adopt(r.task)
        e.stopping = false
        changed()
        if (isUiTaskActive(e.record.status)) track(e)
        return false
      }
    },
    views: () => ordered().slice(0, UI_TASK_LIMITS.list).map((e) => ({ ...uiTaskView(e.record), text: e.ended ? e.record.text : e.text })),
    current: () => {
      const out: UiTaskUpdate[] = []
      for (const e of ordered().reverse()) {
        if (!isUiTaskActive(e.record.status)) continue
        out.push({ type: 'status', ...base(e), status: e.record.status as 'queued' | 'running' })
        if (e.text) out.push({ type: 'text', ...base(e), delta: '', text: e.text })
        if (e.record.data !== null && e.record.data !== undefined) out.push({ type: 'data', ...base(e), data: e.record.data })
      }
      return out
    },
  }
  return surface
}

/** The tasks of every surface by (session, run, surface): the same object for every view of one surface, kept for
 *  the page's life (what a task streamed is kept with its cursor, so a view drawn again goes on from there). */
export function createTaskRegistry() {
  const all = new Map<string, SurfaceTasks>()
  const keyOf = (t: SurfaceTarget) => JSON.stringify([t.session_id, t.run_id, t.surface_id])
  return {
    acquire: (target: SurfaceTarget, deps: TaskDeps): SurfaceTasks => {
      const key = keyOf(target)
      let found = all.get(key)
      if (!found) { found = createSurfaceTasks({ ...target }, deps); all.set(key, found) }
      return found
    },
    peek: (target: SurfaceTarget): SurfaceTasks | undefined => all.get(keyOf(target)),
  }
}

/** The page's registry. */
export const surfaceTasks = createTaskRegistry()
