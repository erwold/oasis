/** The live link page's one way out: the ONLY network call site of the live viewer's bundle (vite.live-share.config.ts
 *  counts it) — two exact same-origin paths, the stream and a picture by its key, each asked with the capability in
 *  the Authorization header (never in a URL), redirects refused, nothing cached, no referrer.
 *
 *  The stream (`GET /live/api/stream`, text/event-stream, read by ./sse.ts):
 *  - `state` → the whole current safe snapshot, checked by the caller's reader, then handed on to REPLACE what is shown
 *    (never appended: every connection and every reconnection opens with the whole state again);
 *  - `ended` → why the link ended: for good (revoked, expired, its session deleted — nothing reconnects), or for now
 *    (the listener turned off, the app stopping — what was shown is dropped, and the page asks again later);
 *  - comments are the server's heartbeat; silence past the heartbeat bound drops the connection and reconnects;
 *  - anything else (an event of no known name) is ignored.
 *  A dropped stream, a refused connection, a 5xx or 429 reconnect after a bounded exponential wait (with jitter), the
 *  wait reset once a state arrived. A refusal that names an end (401, 410 with its reason, …) ends. A state that fails its check
 *  ends too, as `unreadable`: the page cannot read what this server sends, and asking again would not change it. */

import { LIVE_IMAGE_RESOURCE, LIVE_PATHS } from '@oasis-code/contract'
import { SseParser, type SseBounds } from './sse.ts'

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export const STREAM_PATH = LIVE_PATHS.stream
export const IMAGE_PATH = LIVE_PATHS.image_prefix
/** an image's opaque resource key as the state's `images` names it (never an asset id, never the item's display key) */
export const IMAGE_RESOURCE = LIVE_IMAGE_RESOURCE

export type LivePhase = 'connecting' | 'connected' | 'reconnecting' | 'ended'

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
}

/** The one network call: an exact path of the page's own origin, the capability in its header. */
export function liveRequest(path: string, capability: string, init: { signal: AbortSignal; accept: string; lastEventId?: string | null }, fetchImpl?: FetchLike): Promise<Response> {
  if (path !== STREAM_PATH && !(path.startsWith(IMAGE_PATH) && IMAGE_RESOURCE.test(path.slice(IMAGE_PATH.length)))) {
    return Promise.reject(new Error('live link: not a path of the page'))
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${capability}`, Accept: init.accept }
  if (init.lastEventId) headers['Last-Event-ID'] = init.lastEventId
  const request: RequestInit = {
    method: 'GET', headers, signal: init.signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    referrerPolicy: 'no-referrer', mode: 'same-origin',
  }
  return fetchImpl ? fetchImpl(path, request) : fetch(path, request)
}

export interface LiveConnectionOptions<S, E extends string> {
  capability: string
  /** a `state` event's parsed JSON → the state to show; throws when it is not one */
  readState(raw: unknown): S
  /** an `ended` event's parsed JSON → why; throws when it is not one */
  readEnded(raw: unknown): E
  /** whether an end is for good (else the page asks again later) */
  permanent(reason: E): boolean
  /** the end a refused request names (its status, its JSON body when it had one), or null when it is worth asking again */
  refusal(status: number, body: unknown): E | null
  /** the end said when a state cannot be read (for good: asking again would not change it) */
  unreadable: E
  onState(state: S): void
  /** the stream ended; `permanent` false: it pauses, and reconnects */
  onEnded(reason: E, permanent: boolean): void
  onPhase(phase: LivePhase): void
  fetchImpl?: FetchLike
  timers?: Timers
  random?: () => number
  /** no byte for this long (heartbeats included) drops the connection */
  silenceMs?: number
  baseDelayMs?: number
  maxDelayMs?: number
  bounds?: SseBounds
}

export interface LiveConnection {
  /** stop for good (the page leaves): nothing reconnects, no callback runs after it */
  close(): void
  /** reconnect at once when waiting to (the page came back online) */
  nudge(): void
  /** the signal every request of this connection's life carries (aborted once it ended or closed) */
  readonly signal: AbortSignal
}

export const DEFAULT_SILENCE_MS = 45_000
export const DEFAULT_BASE_DELAY_MS = 1_000
export const DEFAULT_MAX_DELAY_MS = 30_000

/** The wait before the attempt-th reconnection (1-based): base·2^(n-1), at most max, then 50–100 % of it. */
export function reconnectDelay(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const full = Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(30, attempt - 1)))
  return Math.round(full * (0.5 + 0.5 * random()))
}

export function openLiveConnection<S, E extends string>(o: LiveConnectionOptions<S, E>): LiveConnection {
  const timers = o.timers ?? realTimers
  const random = o.random ?? Math.random
  const silenceMs = o.silenceMs ?? DEFAULT_SILENCE_MS
  const base = o.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const max = o.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const life = new AbortController()
  let attempt: AbortController | null = null
  let retryTimer: unknown = null
  let silenceTimer: unknown = null
  let failures = 0
  let lastEventId: string | null = null
  let serverRetry: number | null = null
  let done = false

  const phase = (p: LivePhase) => { if (!done || p === 'ended') o.onPhase(p) }
  const clearSilence = () => { if (silenceTimer !== null) { timers.clearTimeout(silenceTimer); silenceTimer = null } }
  const finish = (reason: E | null) => {
    if (done) return
    done = true
    clearSilence()
    if (retryTimer !== null) { timers.clearTimeout(retryTimer); retryTimer = null }
    attempt?.abort()
    life.abort()
    if (reason !== null) { o.onPhase('ended'); o.onEnded(reason, true) }
  }
  const schedule = () => {
    if (done) return
    failures += 1
    phase('reconnecting')
    const wait = Math.max(reconnectDelay(failures, base, max, random), serverRetry !== null ? Math.min(serverRetry, max) : 0)
    retryTimer = timers.setTimeout(() => { retryTimer = null; void connect() }, wait)
  }

  async function connect(): Promise<void> {
    if (done) return
    const controller = new AbortController()
    attempt = controller
    const abortAttempt = () => controller.abort()
    life.signal.addEventListener('abort', abortAttempt, { once: true })
    const armSilence = () => {
      clearSilence()
      silenceTimer = timers.setTimeout(() => { silenceTimer = null; controller.abort() }, silenceMs)
    }
    if (failures === 0) phase('connecting')
    let ended = false
    // armed before anything is awaited: a connection whose answer never comes (a half-open socket, headers that never
    // arrive, a refusal whose body never ends) is dropped like a silent stream, and asked again
    armSilence()
    try {
      const res = await liveRequest(STREAM_PATH, o.capability, { signal: controller.signal, accept: 'text/event-stream', lastEventId }, o.fetchImpl)
      if (done || controller.signal.aborted) return
      if (!res.ok) {
        const body = await refusalBody(res, controller.signal)
        if (done || controller.signal.aborted) return
        const end = o.refusal(res.status, body)
        if (end !== null) { ended = true; finish(end) }
        return
      }
      if (!(res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/event-stream') || !res.body) {
        void res.body?.cancel().catch(() => undefined)
        ended = true
        finish(o.unreadable)
        return
      }
      const parser = new SseParser(o.bounds)
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      // an abort (silence, the page leaving, an end) ends the read at once, whatever the fetch does with its body
      controller.signal.addEventListener('abort', () => { void reader.cancel().catch(() => undefined) }, { once: true })
      armSilence()
      for (;;) {
        const { value, done: eof } = await reader.read()
        if (done || controller.signal.aborted) { void reader.cancel().catch(() => undefined); return }
        if (eof) break
        armSilence()
        for (const m of parser.push(value)) {
          if (m.event === 'state') {
            let state: S
            try { state = o.readState(JSON.parse(m.data)) } catch { ended = true; void reader.cancel().catch(() => undefined); finish(o.unreadable); return }
            if (done) return
            lastEventId = m.id
            failures = 0
            phase('connected')
            o.onState(state)
          } else if (m.event === 'ended') {
            let reason: E
            try { reason = o.readEnded(JSON.parse(m.data)) } catch { reason = o.unreadable }
            void reader.cancel().catch(() => undefined)
            if (o.permanent(reason) || reason === o.unreadable) { ended = true; finish(reason); return }
            // for now: what was shown goes, the page asks again later (the finally below schedules it)
            lastEventId = null
            o.onEnded(reason, false)
            return
          }
        }
        if (parser.retry !== null) serverRetry = parser.retry
        if (done) return
      }
      parser.end()
    } catch {
      // a protocol error (the stream broke its bounds), a network error, an abort (silence, or the page left): asked
      // again unless it ended
    } finally {
      clearSilence()
      life.signal.removeEventListener('abort', abortAttempt)
      if (attempt === controller) attempt = null
      if (!ended && !done) schedule()
    }
  }

  void connect()
  return {
    close: () => finish(null),
    nudge: () => {
      if (done || retryTimer === null) return
      timers.clearTimeout(retryTimer)
      retryTimer = null
      void connect()
    },
    signal: life.signal,
  }
}

/** A refused request's JSON body, read within a small bound (or null). */
async function refusalBody(res: Response, signal: AbortSignal): Promise<unknown> {
  try {
    if (!(res.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) { void res.body?.cancel().catch(() => undefined); return null }
    const bytes = await readBounded(res, 4096, signal)
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch { return null }
}

export interface ImageCheck { mediaType: string; bytes: number; maxBytes: number }

/** A picture of the state, by its opaque resource id: asked once, its type and length checked against the state's own
 *  ref (and a bound), read whole into a Blob of that type. Throws on anything else; the caller decodes it, checks its
 *  size, and shows it as a `blob:` URL it revokes. */
export async function fetchLiveImage(resource: string, capability: string, check: ImageCheck, signal: AbortSignal, fetchImpl?: FetchLike): Promise<Blob> {
  if (!IMAGE_RESOURCE.test(resource)) throw new Error('live link: not an image resource')
  if (check.bytes > check.maxBytes) throw new Error('live link: picture over its bound')
  const res = await liveRequest(`${IMAGE_PATH}${resource}`, capability, { signal, accept: check.mediaType }, fetchImpl)
  if (!res.ok) { void res.body?.cancel().catch(() => undefined); throw new Error(`live link: picture refused (${res.status})`) }
  const mediaType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (mediaType !== check.mediaType) { void res.body?.cancel().catch(() => undefined); throw new Error('live link: not the picture announced') }
  const bytes = await readBounded(res, Math.min(check.bytes, check.maxBytes), signal)
  if (bytes.byteLength !== check.bytes) throw new Error('live link: not the picture announced')
  if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  return new Blob([bytes as BlobPart], { type: mediaType })
}

/** A body read whole within a bound; an abort ends the read at once (whatever the fetch does with its body). */
async function readBounded(res: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const stop = () => { void reader.cancel().catch(() => undefined) }
  if (signal.aborted) stop()
  signal.addEventListener('abort', stop, { once: true })
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    if (done) break
    total += value.byteLength
    if (total > maxBytes) { void reader.cancel().catch(() => undefined); throw new Error('live link: picture over its bound') }
    parts.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.byteLength }
  return out
}
