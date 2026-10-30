/** What the live link's page shows, held outside React (the page reads it through useSyncExternalStore): the
 *  connection's phase, the latest whole state (REPLACED by each `state` frame, never merged), why the link ended or
 *  paused, and the state's pictures — each fetched once by its opaque resource id, its type, length and pixel size
 *  checked against the state's own ref, shown as a `blob:` URL; dropped (and its URL revoked) once no state names it.
 *
 *  An ended link (revoked, expired, its session deleted, a capability the server does not know, a state the page
 *  cannot read) shows nothing of the session any more: the state and every picture are dropped, every request is
 *  aborted, nothing reconnects, and a picture that arrives after it is revoked at once and never shown. A pause (the
 *  listener turned off, the app stopping) drops what was shown too, and the connection asks again later. */

import {
  LIVE_PERMANENT_END, LIVE_SHARE_FORMAT, LIVE_SHARE_VERSION, LIVE_SHARE_VERSION_V2, LiveEndedFrameV2Schema, LiveErrorSchema, LiveStateFrameSchema, LiveStateFrameV2Schema,
  type LiveEndedFrameV2, type LiveImageRef, type LiveStateFrame, type LiveStateFrameV2,
} from '@oasis-code/contract'
import { shownSession } from '../team.ts'
import { fetchLiveImage, openLiveConnection, type FetchLike, type LiveConnection, type LiveConnectionOptions, type LivePhase } from './connection.ts'

/** A frame of either protocol: a v1 link's (one session), a v2 link's (one session or a task's, with their cards). */
export type LiveFrame = LiveStateFrame | LiveStateFrameV2
export const isTaskFrame = (f: LiveFrame): f is LiveStateFrameV2 => f.snapshot.version === LIVE_SHARE_VERSION_V2

/** The session a v2 frame shows: the one chosen while the frame still holds it, else the one the link opens on, else
 *  the task's first. */
export function shownSessionOf(frame: LiveStateFrameV2, chosen: string | null): string {
  const sessions = frame.snapshot.sessions
  return shownSession(sessions, chosen, sessions.some((s) => s.key === frame.start) ? frame.start : frame.snapshot.current)!
}

export type LiveEndedReason = LiveEndedFrameV2['reason']
/** Why the page stopped: the server's own reasons, and the page's — a capability the server does not know
 *  (`unauthorized`), a state it cannot read (`unreadable`: another format or version), a refusal of no known reason. */
export type LiveEnd = LiveEndedReason | 'unauthorized' | 'unreadable' | 'refused'

export type LivePicture =
  | { kind: 'loading' }
  | { kind: 'shown'; src: string; width: number; height: number }
  | { kind: 'failed'; why: string }

export interface LiveView {
  readonly phase: LivePhase | 'idle'
  readonly frame: LiveFrame | null
  /** a v2 frame's session shown (its pictures are the only ones loaded); null for a v1 frame or none */
  readonly selected: string | null
  /** the listener paused the link (turned off, the app stopping): nothing shown, asked again later */
  readonly paused: LiveEndedReason | null
  /** the link ended for good: nothing shown, nothing asked again */
  readonly ended: LiveEnd | null
  /** by resource id */
  readonly pictures: ReadonlyMap<string, LivePicture>
}

export interface LiveStoreOptions {
  capability: string
  fetchImpl?: FetchLike
  /** the connection (tests give their own) */
  connect?: <S, E extends string>(o: LiveConnectionOptions<S, E>) => LiveConnection
  /** a picture's pixel size, decoded (the page: createImageBitmap) */
  measure?: (blob: Blob) => Promise<{ width: number; height: number }>
  urls?: { create(blob: Blob): string; revoke(url: string): void }
  maxImageBytes?: number
  maxCacheBytes?: number
  concurrency?: number
  /** a picture not read whole within this is given up (a hung request never holds a slot for good) */
  imageTimeoutMs?: number
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
  /** passed on to the connection (tests) */
  connection?: Partial<Pick<LiveConnectionOptions<unknown, string>, 'timers' | 'random' | 'silenceMs' | 'baseDelayMs' | 'maxDelayMs'>>
}

export interface LiveStore {
  get(): LiveView
  subscribe(listener: () => void): () => void
  start(): void
  /** show another session of a v2 frame: its pictures load, every other session's are dropped */
  select(key: string): void
  /** the page leaves: everything stops, every URL revoked */
  close(): void
  nudge(): void
}

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024
export const MAX_CACHE_BYTES = 96 * 1024 * 1024
export const IMAGE_TIMEOUT_MS = 60_000

const PERMANENT: readonly string[] = LIVE_PERMANENT_END

/** A `state` event's data, checked whole by its protocol's schema (v1, v2); another format or version is refused by
 *  name first. */
export function readLiveState(raw: unknown): LiveFrame {
  const snap = (raw as { snapshot?: { format?: unknown; version?: unknown } } | null)?.snapshot
  if (snap?.format !== LIVE_SHARE_FORMAT) throw new Error('live state: another format')
  if (snap.version === LIVE_SHARE_VERSION) return LiveStateFrameSchema.parse(raw)
  if (snap.version === LIVE_SHARE_VERSION_V2) return LiveStateFrameV2Schema.parse(raw)
  throw new Error('live state: another version')
}

/** An `ended` event's reason: v1's, and v2's `busy` (the listener cannot hold the whole task now: asked again later). */
export function readLiveEnded(raw: unknown): LiveEndedReason {
  return LiveEndedFrameV2Schema.parse(raw).reason
}

/** A refused request that says the listener is too busy to hold the view now (429/503 `busy`): what was shown goes. */
export function busyRefusal(status: number, body: unknown): boolean {
  const parsed = LiveErrorSchema.safeParse(body)
  return (status === 429 || status === 503) && parsed.success && parsed.data.error === 'busy'
}

/** What a refused stream request means: an unknown capability, an end with its reason, or (busy, unavailable, a
 *  server error) worth asking again. */
export function liveRefusal(status: number, body: unknown): LiveEnd | null {
  const parsed = LiveErrorSchema.safeParse(body)
  const error = parsed.success ? parsed.data : null
  if (status === 401) return 'unauthorized'
  if (status === 410) return error?.reason ?? 'refused'
  if (status === 429 || status === 408 || status >= 500) return null
  // 403, 404, 405 …: the page asked what this server does not answer; asking again would not change it
  return 'refused'
}

/** A signal aborted when either is (AbortSignal.any where the browser has it). */
function both(a: AbortSignal, b: AbortSignal): AbortSignal {
  const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  if (any) return any.call(AbortSignal, [a, b])
  const c = new AbortController()
  const abort = () => c.abort()
  if (a.aborted || b.aborted) abort()
  a.addEventListener('abort', abort, { once: true })
  b.addEventListener('abort', abort, { once: true })
  return c.signal
}

const defaultMeasure = async (blob: Blob) => {
  const bitmap = await createImageBitmap(blob)
  try { return { width: bitmap.width, height: bitmap.height } } finally { bitmap.close() }
}

export function createLiveStore(o: LiveStoreOptions): LiveStore {
  const connect = o.connect ?? openLiveConnection
  const measure = o.measure ?? defaultMeasure
  const urls = o.urls ?? { create: (b: Blob) => URL.createObjectURL(b), revoke: (u: string) => URL.revokeObjectURL(u) }
  const maxImageBytes = o.maxImageBytes ?? MAX_IMAGE_BYTES
  const maxCacheBytes = o.maxCacheBytes ?? MAX_CACHE_BYTES
  const concurrency = o.concurrency ?? 4
  const imageTimeoutMs = o.imageTimeoutMs ?? IMAGE_TIMEOUT_MS
  const timers = o.timers ?? { setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms), clearTimeout: (h: unknown) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>) }
  const listeners = new Set<() => void>()
  let view: LiveView = { phase: 'idle', frame: null, selected: null, paused: null, ended: null, pictures: new Map() }
  let connection: LiveConnection | null = null
  let stopped = false
  // the pictures: by resource, what is known of each (its ref as the state said it, its load, its URL, the bytes it
  // holds of the budget — reserved when its load starts, so loads under way together never pass the budget)
  interface Entry { ref: LiveImageRef; picture: LivePicture; controller: AbortController | null; url: string | null; bytes: number; session: string | null }
  const entries = new Map<string, Entry>()
  const queue: string[] = []
  let loading = 0
  let cachedBytes = 0

  const emit = () => { for (const l of [...listeners]) l() }
  const set = (patch: Partial<LiveView>) => { view = { ...view, ...patch }; emit() }
  const picturesNow = (): ReadonlyMap<string, LivePicture> => new Map([...entries].map(([k, e]) => [k, e.picture]))

  const drop = (resource: string) => {
    const e = entries.get(resource)
    if (!e) return
    e.controller?.abort()
    if (e.url) urls.revoke(e.url)
    cachedBytes -= e.bytes
    entries.delete(resource)
  }
  const dropAll = () => {
    for (const k of [...entries.keys()]) drop(k)
    queue.length = 0
  }

  const pump = () => {
    while (!stopped && loading < concurrency && queue.length) {
      const resource = queue.shift()!
      const e = entries.get(resource)
      if (!e || e.picture.kind !== 'loading' || e.controller) continue
      void load(resource, e)
    }
  }

  async function load(resource: string, e: Entry): Promise<void> {
    const controller = new AbortController()
    e.controller = controller
    loading += 1
    // still the picture this page wants (not dropped by a newer state, an end, or the page leaving)
    const current = () => !stopped && entries.get(resource) === e
    const timer = timers.setTimeout(() => controller.abort(), imageTimeoutMs)
    try {
      if (e.ref.bytes > maxImageBytes) throw new Error("over the page's size bound")
      if (cachedBytes + e.ref.bytes > maxCacheBytes) throw new Error("over the page's picture budget")
      cachedBytes += e.ref.bytes
      e.bytes = e.ref.bytes
      const signal = connection ? both(controller.signal, connection.signal) : controller.signal
      const blob = await fetchLiveImage(resource, o.capability, { mediaType: e.ref.media_type, bytes: e.ref.bytes, maxBytes: maxImageBytes }, signal, o.fetchImpl)
      if (!current()) return
      const size = await measure(blob)
      if (!current()) return
      if (size.width !== e.ref.width || size.height !== e.ref.height) throw new Error('not the picture announced')
      const url = urls.create(blob)
      // gone while it was made (an end, a new state without it): never shown
      if (!current()) { urls.revoke(url); return }
      e.url = url
      e.picture = { kind: 'shown', src: url, width: e.ref.width, height: e.ref.height }
      set({ pictures: picturesNow() })
    } catch {
      if (!current()) return
      cachedBytes -= e.bytes
      e.bytes = 0
      e.picture = { kind: 'failed', why: 'could not be shown' }
      set({ pictures: picturesNow() })
    } finally {
      timers.clearTimeout(timer)
      if (e.controller === controller) e.controller = null
      loading -= 1
      pump()
    }
  }

  const sameRef = (a: LiveImageRef, b: LiveImageRef) => a.media_type === b.media_type && a.width === b.width && a.height === b.height && a.bytes === b.bytes

  // the pictures a frame shows now: a v1 frame's all; a v2 frame's, those of the session shown — each session's images
  // are its own (an item names a ref of ITS session; no picture is looked for in another session)
  const wantedOf = (frame: LiveFrame, selected: string | null): { session: string | null; refs: Map<string, LiveImageRef>; wanted: Set<string> } => {
    const shown = isTaskFrame(frame) ? frame.snapshot.sessions.find((s) => s.key === selected) ?? null : null
    const part = isTaskFrame(frame) ? shown : frame.snapshot
    const refs = new Map((part?.images ?? []).map((r) => [r.resource, r]))
    const wanted = new Set((part?.items ?? []).flatMap((i) => (i.kind === 'image' && i.image && refs.has(i.image) ? [i.image] : [])))
    return { session: shown?.key ?? null, refs, wanted }
  }
  const apply = (frame: LiveFrame, selected: string | null) => {
    const { session, refs, wanted } = wantedOf(frame, selected)
    for (const [resource, e] of [...entries]) if (!wanted.has(resource) || e.session !== session || !sameRef(e.ref, refs.get(resource)!)) drop(resource)
    for (const resource of wanted) {
      if (entries.has(resource)) continue
      entries.set(resource, { ref: refs.get(resource)!, picture: { kind: 'loading' }, controller: null, url: null, bytes: 0, session })
      queue.push(resource)
    }
    view = { ...view, frame, selected, paused: null, pictures: picturesNow() }
    emit()
    pump()
  }

  const onState = (frame: LiveFrame) => {
    if (stopped) return
    const prev = view.frame
    // an older revision of the same projection, arriving late: the newer one stands
    if (prev && prev.epoch === frame.epoch && frame.revision < prev.revision) return
    // a v2 state of another epoch (the listener restarted, the projection made again): its keys may name other
    // sessions — the choice and every picture start again (a v1 state keeps the pictures it still names, as it did)
    const fresh = !prev || prev.epoch !== frame.epoch || prev.snapshot.version !== frame.snapshot.version
    if (fresh && (isTaskFrame(frame) || (prev && isTaskFrame(prev)))) dropAll()
    const chosen = fresh ? null : view.selected
    apply(frame, isTaskFrame(frame) ? shownSessionOf(frame, chosen) : null)
  }

  const onEnded = (reason: LiveEnd, permanent: boolean) => {
    dropAll()
    if (permanent) { stopped = true; set({ frame: null, selected: null, ended: reason, paused: null, pictures: new Map() }) }
    else set({ frame: null, selected: null, paused: reason as LiveEndedReason, pictures: new Map() })
  }

  return {
    get: () => view,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l) } },
    start() {
      if (connection || stopped) return
      connection = connect<LiveFrame, LiveEnd>({
        capability: o.capability,
        readState: readLiveState,
        readEnded: readLiveEnded,
        permanent: (r) => PERMANENT.includes(r) || r === 'unauthorized' || r === 'unreadable' || r === 'refused',
        // a v2 view the listener is too busy to hold whole now: asked again later, and nothing of it stays shown
        // meanwhile (a v1 link keeps its last state while it reconnects, as it always did)
        refusal: (status, body) => {
          const end = liveRefusal(status, body)
          if (end === null && !stopped && view.frame && isTaskFrame(view.frame) && busyRefusal(status, body)) onEnded('busy', false)
          return end
        },
        unreadable: 'unreadable',
        onState,
        onEnded,
        onPhase: (phase) => { if (!stopped || phase === 'ended') set({ phase }) },
        fetchImpl: o.fetchImpl,
        ...o.connection,
      })
    },
    close() {
      stopped = true
      connection?.close()
      dropAll()
    },
    select(key) {
      const frame = view.frame
      if (stopped || !frame || !isTaskFrame(frame) || view.selected === key || !frame.snapshot.sessions.some((s) => s.key === key)) return
      apply(frame, key)
    },
    nudge: () => connection?.nudge(),
  }
}
