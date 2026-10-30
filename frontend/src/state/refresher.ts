/** A read the page asks for again and again (the run tree, the collaboration graph): every run event that moves them
 *  asks, and with many agents at work that was a request per event. Here, per key (the session):
 *  - singleflight: one read at a time;
 *  - leading: a read asked when none ran for `gap` ms starts at once;
 *  - trailing: asks that come while one runs, or within `gap` of the last start, share one read that starts after both
 *    — so at most one read per `gap` (a second by default), and none asked is lost;
 *  - each ask resolves once a read that STARTED after it has been applied (an action that awaits it sees its own
 *    effect), or when its key is left (another session opened: the read is aborted, its answer never applied).
 *  The read itself applies its answer and checks it still holds (load gets an AbortSignal; an aborted read's answer is
 *  dropped by the caller's own check). */

export interface Refresher {
  /** ask for a read of `key`; resolves as above (never rejects: a failed read is the read's to report) */
  run: (key: string) => Promise<void>
  /** leave the key: the read under way is aborted, the asks waiting resolve */
  reset: () => void
}

export interface RefresherOptions {
  load: (key: string, signal: AbortSignal) => Promise<void>
  gap?: number
  now?: () => number
  schedule?: (callback: () => void, delay: number) => unknown
  unschedule?: (timer: unknown) => void
}

interface Waiting { promise: Promise<void>; resolve: () => void }
const waiting = (): Waiting => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } }

export function createRefresher(options: RefresherOptions): Refresher {
  const gap = options.gap ?? 1_000
  const now = options.now ?? (() => Date.now())
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const unschedule = options.unschedule ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  let key: string | null = null
  let lastStart = -Infinity
  let inflight: { controller: AbortController; done: Waiting } | null = null
  let trailing: Waiting | null = null
  let timer: unknown = null

  const start = (): Promise<void> => {
    const controller = new AbortController()
    const done = waiting()
    const current = key!
    inflight = { controller, done }
    lastStart = now()
    options.load(current, controller.signal).catch(() => undefined).finally(() => {
      if (inflight?.controller === controller) inflight = null
      done.resolve()
      if (key === current) arm()
    })
    return done.promise
  }
  /** the trailing read, when one is waiting: once nothing runs and the gap since the last start has passed */
  const arm = () => {
    if (!trailing || inflight || timer !== null) return
    const wait = Math.max(0, lastStart + gap - now())
    timer = schedule(() => {
      timer = null
      if (!trailing || inflight) return
      const asked = trailing
      trailing = null
      void start().then(asked.resolve)
    }, wait)
  }
  const reset = () => {
    if (timer !== null) { unschedule(timer); timer = null }
    if (inflight) { inflight.controller.abort(); inflight.done.resolve(); inflight = null }
    if (trailing) { trailing.resolve(); trailing = null }
    lastStart = -Infinity
  }

  return {
    run: (asked) => {
      if (asked !== key) { reset(); key = asked }
      if (!inflight && !trailing && timer === null && now() - lastStart >= gap) return start()
      trailing ??= waiting()
      const promise = trailing.promise
      arm()
      return promise
    },
    reset: () => { reset(); key = null },
  }
}
