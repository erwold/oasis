/** The session's one event stream, shared by every view that follows a run of the session (a thread's run, a card's,
 *  a surface task's): one EventSource however many runs work. A browser keeps at most six connections per host over
 *  HTTP/1.1; a stream per run held them all with six runs live and left the page's own requests (a diff, a card's
 *  transcript, a message sent) waiting behind them.
 *
 *  The server sends every event of each run of the session after the session cursor (GET /api/sessions/:id/events,
 *  contract events.ts SESSION_STREAM_READY). This side keeps one cursor (the id of the last whole frame) and, per run,
 *  the next seq it expects: a resume after a drop (?after=) repeats nothing a follower is handed twice.
 *
 *  A run's events wait here, within a budget, until a view follows it (a run started elsewhere is heard before the page
 *  knows of it; `onNewRun` says so). What a follower needs and this side does not hold (a run that began before the
 *  stream's cursor, events let go under the budget, a second view of a run) is read from the run's record in bounded
 *  pages (`history`, GET /api/runs/:id/events/page) until it meets what the stream holds; the stream's own events wait
 *  meanwhile and are handed after it, each once. A run of this session is never read from a stream of its own: only a
 *  run of another session goes to `fallback`. A lookup or a page that fails is tried again later, never traded for a
 *  connection per run. */

import { SESSION_STREAM_READY } from '@oasis-code/contract'
import type { ConnectionState, EventSourceLike, RunEvent } from './runStream'

export interface HistoryPage { events: { seq: number; event: string; data: Record<string, unknown> }[] }

export interface SessionStreamDeps {
  sessionId: string
  /** the session cursor to begin after (a session detail's event_cursor) */
  cursor: number
  names: readonly string[]
  source: (after: number) => EventSourceLike
  /** a run this stream has not heard: its session (only a run of another session is read from its own stream) */
  run: (runId: string) => Promise<{ session_id: string }>
  /** the run's events after `after`, at most `limit`, in seq order (a finite read) */
  history: (runId: string, after: number, limit: number) => Promise<HistoryPage>
  /** a run of another session: its own stream */
  fallback: Follow
  /** the first event of a run this stream had not heard of */
  onNewRun?: (runId: string) => void
  schedule?: (callback: () => void, delay: number) => unknown
  unschedule?: (timer: unknown) => void
  random?: () => number
  /** how many events a run nobody follows keeps for a view that comes later (past it, its oldest are let go) */
  keep?: number
  /** how many such events all runs keep together */
  keepTotal?: number
  /** a history page's size */
  page?: number
}

export type Follow = (runId: string, after: number | null, onEvent: (event: RunEvent) => void, onClose: () => void, onConnection?: (state: ConnectionState) => void) => () => void

export interface SessionStream {
  readonly sessionId: string
  follow: Follow
  reconnect: () => void
  close: () => void
}

interface Follower {
  after: number
  onEvent: (event: RunEvent) => void
  onClose: () => void
  onConnection?: (state: ConnectionState) => void
  /** while its history is read: what the stream said meanwhile, handed after it (null: following live) */
  pending: RunEvent[] | null
  done: boolean
}
interface RunLog { items: RunEvent[]; heard: boolean; next: number; followers: Set<Follower> }

const KEEP = 2_000
const KEEP_TOTAL = 50_000
const PAGE = 500

const seqOf = (item: RunEvent) => Number(item.id)
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function createSessionStream(deps: SessionStreamDeps): SessionStream {
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const unschedule = deps.unschedule ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const random = deps.random ?? Math.random
  const keep = deps.keep ?? KEEP
  const keepTotal = deps.keepTotal ?? KEEP_TOTAL
  const pageSize = deps.page ?? PAGE
  const logs = new Map<string, RunLog>()
  /** follows waiting for the stream to say it has replayed what its cursor left behind */
  const early: (() => void)[] = []
  /** what to stop on close: other sessions' streams, the timers of lookups and pages tried again */
  const owned = new Set<() => void>()
  let kept = 0
  let live: Set<string> = new Set()
  let ready = false
  let cursor = deps.cursor
  let source: EventSourceLike | null = null
  let state: ConnectionState = 'connecting'
  let generation = 0
  let failures = 0
  let timer: unknown = null
  let disposed = false

  const backoff = (attempt: number) => Math.round(Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)) * (0.5 + random() * 0.5))
  /** call `fn` after `ms`, unless the stream closes first */
  const later = (fn: () => void, ms: number) => {
    const stop = () => { unschedule(handle); owned.delete(stop) }
    const handle = schedule(() => { owned.delete(stop); if (!disposed) fn() }, ms)
    owned.add(stop)
  }

  const setState = (next: ConnectionState) => {
    if (state === next) return
    state = next
    for (const log of logs.values()) for (const f of log.followers) f.onConnection?.(next)
  }
  const logOf = (runId: string): RunLog => {
    let log = logs.get(runId)
    if (!log) { log = { items: [], heard: false, next: 0, followers: new Set() }; logs.set(runId, log) }
    return log
  }
  const forget = (log: RunLog, count: number) => { if (count > 0) { log.items.splice(0, count); kept -= count } }
  /** the budget: a run's own (trimmed back to `keep` once a quarter over, so a long run costs no splice per event),
   *  then all runs' together (the run holding most gives up half) */
  const budget = (log: RunLog) => {
    if (log.items.length > keep + Math.max(1, keep >> 2)) forget(log, log.items.length - keep)
    while (kept > keepTotal) {
      let largest: RunLog | null = null
      for (const l of logs.values()) if (!largest || l.items.length > largest.items.length) largest = l
      if (!largest?.items.length) break
      forget(largest, Math.ceil(largest.items.length / 2))
    }
  }

  const end = (f: Follower) => {
    if (f.done) return
    f.done = true
    for (const log of logs.values()) log.followers.delete(f)
    f.onConnection?.('closed')
    f.onClose()
  }
  /** hand one event to a follower, once, in order; its run's end ends the follow */
  const deliver = (f: Follower, item: RunEvent) => {
    if (f.done) return
    const seq = seqOf(item)
    if (seq <= f.after) return
    f.after = seq
    f.onEvent(item)
    if (item.event === 'run_finished') end(f)
  }

  const frame = (event: { type: string; data?: unknown; lastEventId?: string }, current: number) => {
    if (disposed || current !== generation || typeof event.data !== 'string') return
    let body: unknown
    try { body = JSON.parse(event.data) } catch { drop(); return }
    // the whole frame is checked before the cursor moves past it: a frame refused is asked for again, never skipped
    if (!isRecord(body)) { drop(); return }
    if (event.type === SESSION_STREAM_READY) {
      if (!Number.isSafeInteger(body.cursor) || !Array.isArray(body.live_runs) || !body.live_runs.every((r) => typeof r === 'string')) { drop(); return }
    } else if (typeof body.run_id !== 'string' || !Number.isSafeInteger(body.seq) || (body.seq as number) < 0 || !isRecord(body.data)) { drop(); return }
    const id = Number(event.lastEventId)
    if (event.lastEventId && Number.isSafeInteger(id) && id >= 0) cursor = Math.max(cursor, id)
    failures = 0
    setState('connected')
    if (event.type === SESSION_STREAM_READY) {
      live = new Set(body.live_runs as string[])
      if (!ready) { ready = true; for (const go of early.splice(0)) go() }
      return
    }
    const runId = body.run_id as string
    const seq = body.seq as number
    const log = logOf(runId)
    const first = !log.heard
    log.heard = true
    if (seq < log.next) return // heard before the drop
    log.next = seq + 1
    const item: RunEvent = { event: event.type, data: body.data as Record<string, unknown>, id: String(seq) }
    if (log.followers.size) {
      for (const f of [...log.followers]) { if (f.pending) f.pending.push(item); else deliver(f, item) }
    } else {
      log.items.push(item)
      kept += 1
      budget(log)
    }
    if (first) deps.onNewRun?.(runId)
  }

  const drop = () => {
    if (disposed || timer !== null) return
    generation += 1
    source?.close(); source = null
    setState('reconnecting')
    timer = schedule(() => { timer = null; connect() }, backoff(failures++))
  }
  const connect = () => {
    if (disposed) return
    const current = ++generation
    setState(failures ? 'reconnecting' : 'connecting')
    let next: EventSourceLike
    try { next = deps.source(cursor) } catch { drop(); return }
    source = next
    const handle = (event: { type: string; data?: unknown; lastEventId?: string }) => frame(event, current)
    for (const name of new Set([...deps.names, SESSION_STREAM_READY])) next.addEventListener(name, handle)
    next.addEventListener('open', () => { if (!disposed && current === generation) setState('connected') })
    next.addEventListener('error', (event: { data?: unknown }) => { if (!disposed && current === generation && typeof event.data !== 'string') drop() })
  }

  /** the history met the stream: what the stream said meanwhile is handed (each once), then live */
  const settle = (f: Follower) => {
    const waiting = f.pending ?? []
    f.pending = null
    for (const item of waiting) deliver(f, item)
  }
  /** A follower of a run of this session: what this side holds after its cursor; what it lacks, from the record in
   *  pages, until the two meet; then live. */
  const join = (runId: string, f: Follower) => {
    const log = logOf(runId)
    const held = log.items.filter((item) => seqOf(item) > f.after)
    const gap = held.length ? seqOf(held[0]!) > f.after + 1 : (!log.heard || log.next > f.after + 1)
    // what this side held for the run is the follower's now (the budget is for runs nobody follows)
    forget(log, log.items.length)
    f.pending = held
    log.followers.add(f)
    f.onConnection?.(state)
    if (!gap) { settle(f); return }
    let attempt = 0
    const read = () => {
      if (f.done || disposed) return
      deps.history(runId, f.after, pageSize).then((page) => {
        if (f.done || disposed) return
        attempt = 0
        for (const e of page.events) deliver(f, { event: e.event, data: e.data, id: String(e.seq) })
        const met = f.pending !== null && f.pending.length > 0 && f.after >= seqOf(f.pending[0]!) - 1
        if (f.done || met || page.events.length < pageSize) settle(f)
        else read()
      }, () => later(read, backoff(attempt++)))
    }
    read()
  }

  const follow: Follow = (runId, after, onEvent, onClose, onConnection) => {
    const f: Follower = { after: after === null || !Number.isSafeInteger(after) || after < 0 ? -1 : after, onEvent, onClose, onConnection, pending: null, done: false }
    let stopOther: (() => void) | null = null
    let attempt = 0
    const decide = () => {
      if (f.done || disposed) return
      if (logs.get(runId)?.heard || live.has(runId)) { join(runId, f); return }
      deps.run(runId).then((run) => {
        if (f.done || disposed) return
        if (run.session_id === deps.sessionId || logs.get(runId)?.heard) { join(runId, f); return }
        // a run of another session: its own stream, closed with this one
        const stop = deps.fallback(runId, after, onEvent, onClose, onConnection)
        const owner = () => { owned.delete(owner); stop() }
        stopOther = owner
        owned.add(owner)
      }, () => later(decide, backoff(attempt++)))
    }
    // asynchronously, as a stream of its own would: the caller keeps its handle before the first event lands
    queueMicrotask(() => { if (ready) decide(); else early.push(decide) })
    return () => {
      if (stopOther) { stopOther(); return }
      if (f.done) return
      f.done = true
      let followed = false
      for (const log of logs.values()) followed = log.followers.delete(f) || followed
      if (followed) onConnection?.('closed')
    }
  }

  connect()
  return {
    sessionId: deps.sessionId,
    follow,
    reconnect: () => { if (!disposed) { if (timer !== null) { unschedule(timer); timer = null } generation += 1; source?.close(); source = null; connect() } },
    close: () => {
      if (disposed) return
      disposed = true
      if (timer !== null) { unschedule(timer); timer = null }
      generation += 1
      source?.close(); source = null
      for (const stop of [...owned]) stop()
      owned.clear()
      for (const log of logs.values()) { for (const f of log.followers) { f.done = true; f.onConnection?.('closed') } log.followers.clear() }
      logs.clear()
      early.length = 0
      kept = 0
    },
  }
}
