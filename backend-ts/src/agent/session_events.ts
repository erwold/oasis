/** A session's one event stream: every run of the session on one connection (GET /api/sessions/:id/events).
 *
 *  The cursor is the session cursor (`run_events.cursor`, schema v26): one persisted counter every written event takes,
 *  never reused. A client resumes after the last cursor it heard, one number however many runs the session has:
 *  - a run this process holds (its handle, its events in memory, deltas included) is replayed from memory, from the
 *    first event after the last one it wrote at or before the cursor (a delta after that is sent again; the client
 *    de-duplicates by the run's own seq);
 *  - a run of an earlier process is replayed from its persisted events after the cursor, read page by page by the
 *    cursor's index (never a run's whole history, never once per run);
 *  - both in cursor order, so a stream cut in the middle of its replay resumes after the last id it sent;
 *  - then one `stream_ready` frame, then the live events as the runs emit them.
 *  The live queue is opened before the replay is read, so an event emitted meanwhile is in one or the other (or both:
 *  dropped by its run's seq). A subscriber that falls SESSION_BACKLOG events behind is let go: its client comes back
 *  after its cursor and is replayed what it missed, instead of a queue growing behind a stalled connection. */

import { SESSION_STREAM_READY } from '@oasis-code/contract'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'

/** A run event as the runner holds it: `cursor` is the session cursor it was written with (none: a transient event). */
export interface CursorRunEvent { seq: number; event: string; data: Record<string, unknown>; run_id: string; cursor?: number | null }
/** A run this process holds: every event it emitted, in seq order. */
export interface MemoryRun { run_id: string; events: readonly CursorRunEvent[]; done: boolean }
/** One SSE frame of the session stream: its name, its id (the session cursor reached) and its data (JSON). */
export interface SessionFrame { event: string; id: number; data: string }

export const SESSION_BACKLOG = 20_000
export const REPLAY_PAGE = 500

const END = Symbol('end of the session stream')

class SessionQueue {
  private readonly items: (CursorRunEvent | typeof END)[] = []
  private waiter: ((item: CursorRunEvent | typeof END) => void) | null = null
  private ended = false

  put(item: CursorRunEvent | typeof END): void {
    if (this.ended) return
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(item); return }
    if (item !== END && this.items.length >= SESSION_BACKLOG) { this.items.length = 0; item = END }
    this.items.push(item)
    if (item === END) this.ended = true
  }

  get(): Promise<CursorRunEvent | typeof END> {
    if (this.items.length) return Promise.resolve(this.items.shift()!)
    return new Promise((resolve) => { this.waiter = resolve })
  }
}

/** The live side: the runner publishes every event it emits under its session; each open stream has a queue. */
export class SessionEventHub {
  private readonly queues = new Map<string, Set<SessionQueue>>()
  /** a watcher's mark per session (the live share: share/live/service.ts): told THAT the session changed, nothing of
   *  what — it only marks itself dirty; it runs inside the runner's emit, so it may not throw, wait or project */
  private readonly watchers = new Map<string, Set<() => void>>()
  /** told when any session ends (is deleted) */
  private readonly enders = new Set<(sessionId: string) => void>()

  /** Watch a session's events (no payload); the returned function stops watching. */
  watch(sessionId: string, mark: () => void): () => void {
    let set = this.watchers.get(sessionId)
    if (!set) this.watchers.set(sessionId, set = new Set())
    set.add(mark)
    return () => {
      const s = this.watchers.get(sessionId)
      if (!s) return
      s.delete(mark)
      if (!s.size) this.watchers.delete(sessionId)
    }
  }

  /** Hear of every session's end (deletion). */
  onEnd(fn: (sessionId: string) => void): () => void {
    this.enders.add(fn)
    return () => { this.enders.delete(fn) }
  }

  open(sessionId: string): SessionQueue {
    const queue = new SessionQueue()
    let set = this.queues.get(sessionId)
    if (!set) this.queues.set(sessionId, set = new Set())
    set.add(queue)
    return queue
  }

  close(sessionId: string, queue: SessionQueue): void {
    const set = this.queues.get(sessionId)
    if (!set) return
    set.delete(queue)
    if (!set.size) this.queues.delete(sessionId)
  }

  publish(sessionId: string, item: CursorRunEvent): void {
    const set = this.queues.get(sessionId)
    if (set) for (const queue of set) queue.put(item)
    const marks = this.watchers.get(sessionId)
    if (marks) for (const mark of marks) { try { mark() } catch { /* a watcher never breaks the run */ } }
  }

  /** The session is gone (deleted): its streams end. */
  end(sessionId: string): void {
    const set = this.queues.get(sessionId)
    if (set) for (const queue of set) queue.put(END)
    for (const fn of this.enders) { try { fn(sessionId) } catch { /* a watcher never breaks the deletion */ } }
  }

  /** How many streams the session has open (a test's and a diagnosis's question). */
  subscribers(sessionId: string): number {
    return this.queues.get(sessionId)?.size ?? 0
  }
}

/** The cursor a session detail names: every event of each run live now comes after it, and so does every event
 *  written from now on. A run still live is replayed whole to a page that never read its transcript. */
export function snapshotCursor(conn: Conn, runs: readonly MemoryRun[]): number {
  let cursor = repo.lastEventCursor(conn)
  for (const run of runs) {
    if (run.done) continue
    const first = run.events.find((e) => typeof e.cursor === 'number')
    if (first) cursor = Math.min(cursor, first.cursor! - 1)
  }
  return cursor
}

interface Pending { key: number; order: number; seq: number; item: CursorRunEvent }

/** A held run's events after the cursor, each with the cursor it sorts by: its own (written), else the last written
 *  before it in the run (a delta follows the event it came after). Read backwards from the end: what it costs is what
 *  the run emitted since the cursor. */
function memoryTail(run: MemoryRun, after: number, order: number): Pending[] {
  const events = run.events
  let start = events.length
  let base = after
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const cursor = events[i]!.cursor
    if (typeof cursor === 'number' && cursor <= after) { base = cursor; break }
    start = i
  }
  const out: Pending[] = []
  let key = base
  for (let i = start; i < events.length; i += 1) {
    const item = events[i]!
    if (typeof item.cursor === 'number') key = item.cursor
    out.push({ key, order, seq: item.seq, item })
  }
  return out
}

/** One page of a run's record after `after` (a page catching a follower up to the session stream, never a stream):
 *  from memory for a run this process holds (its deltas too; its seq is its index), else from the database by the
 *  run's key. At most `limit` events. */
export function runEventsPage(conn: Conn, held: MemoryRun | null, runId: string, after: number, limit: number): repo.StoredEvent[] {
  const from = Math.max(0, after + 1)
  if (held) {
    const slice = held.events[from]?.seq === from ? held.events.slice(from, from + limit) : held.events.filter((e) => e.seq > after).slice(0, limit)
    return slice.map((e) => ({ seq: e.seq, event: e.event, data: e.data }))
  }
  return repo.listEvents(conn, runId, after, limit)
}

function frame(item: CursorRunEvent, id: number): SessionFrame {
  return { event: item.event, id, data: JSON.stringify({ run_id: item.run_id, seq: item.seq, data: item.data }) }
}

/** The session's frames after `after`, then live until `signal` aborts or the session ends. */
export async function* sessionEvents(
  deps: { conn: Conn; hub: SessionEventHub; runs: () => MemoryRun[] },
  sessionId: string,
  opts: { after: number; signal?: AbortSignal },
): AsyncGenerator<SessionFrame, void, undefined> {
  const queue = deps.hub.open(sessionId)
  const stop = () => queue.put(END)
  opts.signal?.addEventListener('abort', stop, { once: true })
  try {
    if (opts.signal?.aborted) return
    // a cursor this database never gave (another data directory's, a hand-made one) resumes from where it stands
    const ceiling = repo.lastEventCursor(deps.conn) // what is written after this comes by the queue, opened already
    const after = Math.max(0, Math.min(Math.trunc(opts.after), ceiling))
    const held = deps.runs()
    const heldIds = new Set(held.map((r) => r.run_id))
    const live = held.filter((r) => !r.done).map((r) => r.run_id)
    // a run's events in memory as they stand now, taken at once (what is emitted later comes by the queue)
    const memory = held.flatMap((run, order) => memoryTail(run, after, order))
      .sort((a, b) => a.key - b.key || a.order - b.order || a.seq - b.seq)
    const next = new Map<string, number>()
    let reached = after
    const send = (item: CursorRunEvent, key: number): SessionFrame | null => {
      const expected = next.get(item.run_id)
      if (expected !== undefined && item.seq < expected) return null
      next.set(item.run_id, item.seq + 1)
      reached = Math.max(reached, key)
      return frame(item, reached)
    }
    let m = 0
    let page: repo.CursorEvent[] = []
    let p = 0
    let pageAfter = after
    let pagesDone = false
    const nextStored = (): repo.CursorEvent | null => {
      for (;;) {
        while (p < page.length) {
          const row = page[p]!
          if (!heldIds.has(row.run_id)) return row
          p += 1 // a held run's rows come from memory (with its deltas)
        }
        if (pagesDone) return null
        page = repo.sessionEventsAfter(deps.conn, sessionId, pageAfter, ceiling, REPLAY_PAGE)
        p = 0
        if (page.length < REPLAY_PAGE) pagesDone = true
        if (page.length) pageAfter = page[page.length - 1]!.cursor
      }
    }
    for (;;) {
      if (opts.signal?.aborted) return
      const stored = nextStored()
      const fromMemory = m < memory.length ? memory[m]! : null
      if (!stored && !fromMemory) break
      let out: SessionFrame | null
      if (stored && (!fromMemory || stored.cursor < fromMemory.key)) {
        p += 1
        out = send({ ...stored, cursor: stored.cursor }, stored.cursor)
      } else {
        m += 1
        out = send(fromMemory!.item, fromMemory!.key)
      }
      if (out) yield out
    }
    yield { event: SESSION_STREAM_READY, id: reached, data: JSON.stringify({ cursor: reached, live_runs: live }) }
    for (;;) {
      const item = await queue.get()
      if (item === END) return
      const out = send(item, typeof item.cursor === 'number' ? item.cursor : reached)
      if (out) yield out
    }
  } finally {
    opts.signal?.removeEventListener('abort', stop)
    deps.hub.close(sessionId, queue)
  }
}
