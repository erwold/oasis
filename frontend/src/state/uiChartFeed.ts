/** A chart's file source as it is read: the server is asked for one page at a time (never two at once), from the byte
 *  the reader has reached, and the bytes go to the parser (uiChartSource). No I/O of its own: the page request and the
 *  timers are given (FeedDeps), so a test drives it as the app does.
 *
 *  The file changing under the reader is noticed by what each page says of it and what the reader kept:
 *  - another file at the path (its identity: a rename over it, a delete and a new one) — read from the start;
 *  - smaller than what was read (truncated) — read from the start;
 *  - its first bytes, or the bytes just before the read position, not the ones read (rewritten in place, whatever its
 *    length: one that is longer than before, written after a truncation, included) — read from the start;
 *  - its whole prefix: the CRC-32 of every byte read is kept as they come, and the server is asked to compute the
 *    CRC-32 of the file's bytes before the read position (`verify`) — when the file did not grow but its time changed
 *    (a rewrite of the same length; an empty file has no prefix to check; at most once per TOUCH_VERIFY_MIN_MS, so a
 *    file only touched over and over is not hashed over and over), and on a deadline otherwise — once
 *    max(VERIFY_MIN_MS, 20 × the last check's duration) has passed since the last one, on the next page whether the
 *    reader is caught up or not (a file growing faster than it is read is checked all the same). A mismatch is read
 *    from the start. So a rewrite that keeps the
 *    file's identity, its first bytes and the bytes before the read position (one in its middle) is found by the next
 *    check: within about max(VERIFY_MIN_MS, 20 × the last check's duration) of the change. Each check reads the file's
 *    prefix on the server (O(size) disk reads, nothing of it sent); a poll that finds nothing new reads only the anchors.
 *  Reading from the start drops every point, the parser's state and the CRC; a new generation begins.
 *
 *  A missing file is asked for again (after RETRY_MISSING_MS); a failure (the connection, the server) again after a
 *  growing wait (up to RETRY_MAX_MS); a refusal (the path is no longer readable) after RETRY_REFUSED_MS; a stale revision
 *  waits for the revision the surface is drawn at (setRevision). An answer to a request made before a reset, or after
 *  the feed was let go, changes nothing. */

import { UI_CHART_SOURCE_LIMITS, type UiChartSource, type UiChartSourcePage, type UiChartXAxis } from '@oasis-code/contract'
import { crc32, SourceParser, type SourcePoints } from './uiChartSource.ts'

export const POLL_MS = 1000
export const VERIFY_MIN_MS = 10_000
/** a check asked for by a change without growth (a rewrite of the same length, or a touch) waits at least this long
 *  after the last check */
export const TOUCH_VERIFY_MIN_MS = 2_000
export const RETRY_MISSING_MS = 1500
export const RETRY_REFUSED_MS = 15_000
export const RETRY_MAX_MS = 15_000
/** while catching up, the chart is told of new points at most this often (each telling redraws it) */
export const CATCH_UP_NOTIFY_MS = 250

export type PageAnswer =
  | { kind: 'page'; page: Extract<UiChartSourcePage, { status: 'ok' }> }
  | { kind: 'missing'; reason: string }
  | { kind: 'stale' }
  | { kind: 'refused'; message: string }
  | { kind: 'error'; message: string }

export interface PageRequest { revision: number; offset: number; limit: number; verify: boolean; signal: AbortSignal }

export interface FeedDeps {
  fetchPage: (req: PageRequest) => Promise<PageAnswer>
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

export type FeedStatus = 'loading' | 'live' | 'missing' | 'retrying' | 'refused' | 'stale'

export interface FeedSnapshot {
  /** grows with every change of the points or of the status */
  version: number
  /** grows with every reading from the start */
  generation: number
  status: FeedStatus
  message: string | null
  points: SourcePoints
  /** bytes read of the file */
  offset: number
  /** the reader has read every byte the file had at its last page */
  caughtUp: boolean
  pages: number
  verifies: number
  resets: number
}

export function decodeBase64(s: string): Uint8Array {
  if (!s) return new Uint8Array(0)
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])

export class ChartFeed {
  private parser: SourceParser
  private snap: FeedSnapshot
  private listeners = new Set<() => void>()
  private cursor = 0
  private crc = 0
  private fileId: string | null = null
  private head: Uint8Array = new Uint8Array(0)
  private tail: Uint8Array = new Uint8Array(0)
  private lastMtime: number | null = null
  private needVerify = false
  private lastVerifyAt: number
  private verifyCost = 0
  /** when a check asked for by a change without growth was last made */
  private lastTouchCheck = Number.NEGATIVE_INFINITY
  private failures = 0
  private token = 0
  private inflight: AbortController | null = null
  private timer: unknown = null
  private disposed = false
  private lastNotify = 0
  private dirty = false
  private readonly anchorBytes = UI_CHART_SOURCE_LIMITS.anchorBytes

  readonly source: UiChartSource
  readonly axis: UiChartXAxis
  private revision: number
  private readonly deps: FeedDeps
  private readonly pageBytes: number

  constructor(source: UiChartSource, axis: UiChartXAxis, revision: number, deps: FeedDeps, pageBytes: number = UI_CHART_SOURCE_LIMITS.pageBytes) {
    this.source = source; this.axis = axis; this.revision = revision; this.deps = deps; this.pageBytes = pageBytes
    this.parser = new SourceParser(source, axis)
    this.lastVerifyAt = deps.now()
    this.snap = { version: 0, generation: 0, status: 'loading', message: null, points: this.parser.points, offset: 0, caughtUp: false, pages: 0, verifies: 0, resets: 0 }
  }

  snapshot = (): FeedSnapshot => this.snap
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }

  start(): void { if (!this.disposed && this.timer === null && this.inflight === null) this.schedule(0) }

  /** The revision the surface is drawn at: the server reads the source under it. */
  setRevision(revision: number): void {
    if (revision === this.revision) return
    this.revision = revision
    if (this.snap.status === 'stale') { this.cancelTimer(); this.schedule(0) }
  }

  dispose(): void {
    this.disposed = true
    this.token += 1
    this.cancelTimer()
    this.inflight?.abort()
    this.inflight = null
    this.listeners.clear()
  }

  private cancelTimer(): void { if (this.timer !== null) { this.deps.clearTimer(this.timer); this.timer = null } }
  private schedule(ms: number): void {
    if (this.disposed) return
    this.cancelTimer()
    this.timer = this.deps.setTimer(() => { this.timer = null; void this.poll() }, ms)
  }

  private set(patch: Partial<FeedSnapshot>, force = false): void {
    this.snap = { ...this.snap, ...patch, version: this.snap.version + 1 }
    this.dirty = true
    const now = this.deps.now()
    if (!force && now - this.lastNotify < CATCH_UP_NOTIFY_MS) return
    this.flush(now)
  }
  private flush(now = this.deps.now()): void {
    if (!this.dirty) return
    this.dirty = false
    this.lastNotify = now
    for (const fn of [...this.listeners]) fn()
  }

  /** Every point dropped: the file is read from its start. */
  private reset(): void {
    this.token += 1
    this.inflight?.abort()
    this.inflight = null
    this.parser = new SourceParser(this.source, this.axis)
    this.cursor = 0; this.crc = 0; this.fileId = null; this.head = new Uint8Array(0); this.tail = new Uint8Array(0)
    this.lastMtime = null; this.needVerify = false; this.lastVerifyAt = this.deps.now()
    this.set({ points: this.parser.points, offset: 0, caughtUp: false, generation: this.snap.generation + 1, resets: this.snap.resets + 1 }, true)
  }

  private verifyDue(now: number): boolean {
    if (this.cursor === 0) return false
    // a change without growth asks for a check; a file only touched again and again is checked at most so often
    if (this.needVerify && now - this.lastTouchCheck >= Math.max(TOUCH_VERIFY_MIN_MS, 4 * this.verifyCost)) return true
    // on a deadline, whether the reader is caught up or not: a file that grows faster than it is read is checked too
    return now - this.lastVerifyAt >= Math.max(VERIFY_MIN_MS, 20 * this.verifyCost)
  }

  async poll(): Promise<void> {
    if (this.disposed || this.inflight !== null) return
    const token = this.token
    const started = this.deps.now()
    const verify = this.verifyDue(started)
    const revision = this.revision
    const ctrl = new AbortController()
    this.inflight = ctrl
    let answer: PageAnswer
    try {
      answer = await this.deps.fetchPage({ revision, offset: this.cursor, limit: this.pageBytes, verify, signal: ctrl.signal })
    } catch (error) {
      answer = { kind: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    // an answer to a request of before a reset (or after the feed was let go) is another reading's
    if (token !== this.token || this.disposed) return
    this.inflight = null
    switch (answer.kind) {
      case 'stale':
        // asked at a revision the surface has left: asked again at once when the newer one is known already
        if (revision !== this.revision) { this.schedule(0); return }
        this.set({ status: 'stale', message: 'the surface changed' }, true); this.schedule(RETRY_REFUSED_MS); return
      case 'missing': this.failures = 0; this.set({ status: 'missing', message: answer.reason }, true); this.schedule(RETRY_MISSING_MS); return
      case 'refused': this.set({ status: 'refused', message: answer.message }, true); this.schedule(RETRY_REFUSED_MS); return
      case 'error': {
        this.failures += 1
        this.set({ status: 'retrying', message: answer.message }, true)
        this.schedule(Math.min(RETRY_MAX_MS, 500 * 2 ** Math.min(5, this.failures)))
        return
      }
      case 'page': this.page(answer.page, verify, started)
    }
  }

  private page(p: Extract<UiChartSourcePage, { status: 'ok' }>, verified: boolean, started: number): void {
    const now = this.deps.now()
    this.failures = 0
    const head = decodeBase64(p.head)
    const anchor = p.anchor === null ? null : decodeBase64(p.anchor)
    const changed = (this.fileId !== null && p.file_id !== this.fileId)
      || p.size < this.cursor
      || p.offset !== this.cursor
      || !equalBytes(head.subarray(0, this.head.length), this.head)
      || (this.cursor > 0 && (anchor === null || !equalBytes(anchor, this.tail)))
      || (verified && p.crc !== this.crc)
    if (changed) { this.reset(); this.schedule(0); return }
    if (verified) {
      if (this.needVerify) this.lastTouchCheck = now
      this.lastVerifyAt = now; this.verifyCost = now - started; this.needVerify = false
    }
    this.fileId = p.file_id
    const data = decodeBase64(p.data)
    if (data.length) {
      this.parser.feed(data)
      this.crc = crc32(data, this.crc)
      if (this.head.length < this.anchorBytes) this.head = joinTail(this.head, data, this.anchorBytes, true)
      this.tail = joinTail(this.tail, data, this.anchorBytes, false)
      this.cursor += data.length
    } else if (p.eof && !verified && this.cursor > 0 && this.lastMtime !== null && p.mtime_ms !== this.lastMtime && p.size === this.cursor) {
      // not grown, but written: a rewrite of the same length (or a touch) — the whole prefix is checked next
      this.needVerify = true
    }
    this.lastMtime = p.mtime_ms
    const status: FeedStatus = 'live'
    const grew = data.length > 0
    if (grew || this.snap.status !== status || this.snap.caughtUp !== p.eof || verified) {
      this.set({ status, message: null, offset: this.cursor, caughtUp: p.eof, pages: this.snap.pages + 1, verifies: this.snap.verifies + (verified ? 1 : 0) }, p.eof)
    } else this.flush(now)
    this.schedule(p.eof ? POLL_MS : 0)
  }
}

/** The first (`front`) or last `max` bytes of `kept` followed by `data`. */
function joinTail(kept: Uint8Array, data: Uint8Array, max: number, front: boolean): Uint8Array {
  if (front) {
    const out = new Uint8Array(Math.min(max, kept.length + data.length))
    out.set(kept.subarray(0, out.length))
    if (kept.length < out.length) out.set(data.subarray(0, out.length - kept.length), kept.length)
    return out
  }
  if (data.length >= max) return data.slice(data.length - max)
  const keep = Math.min(kept.length, max - data.length)
  const out = new Uint8Array(keep + data.length)
  out.set(kept.subarray(kept.length - keep), 0)
  out.set(data, keep)
  return out
}

// ---------------------------------------------------------------- feeds shared by what draws them

interface Held { feed: ChartFeed; refs: number; idle: unknown }
const feeds = new Map<string, Held>()
/** a feed nothing draws is let go after this long (a chart drawn again meanwhile — a scroll, a switch of session — goes
 *  on from where it was) */
export const FEED_IDLE_MS = 30_000

/** The feed of `key`, made by `make` when there is none; `release` when the chart no longer draws it. */
export function acquireFeed(key: string, make: () => ChartFeed, timers: Pick<FeedDeps, 'setTimer' | 'clearTimer'>): { feed: ChartFeed; release: () => void } {
  let held = feeds.get(key)
  if (!held) { held = { feed: make(), refs: 0, idle: null }; feeds.set(key, held) }
  if (held.idle !== null) { timers.clearTimer(held.idle); held.idle = null }
  held.refs += 1
  held.feed.start()
  const h = held
  let released = false
  return {
    feed: h.feed,
    release: () => {
      if (released) return
      released = true
      h.refs -= 1
      if (h.refs > 0) return
      h.idle = timers.setTimer(() => {
        if (h.refs > 0 || feeds.get(key) !== h) return
        feeds.delete(key)
        h.feed.dispose()
      }, FEED_IDLE_MS)
    },
  }
}
