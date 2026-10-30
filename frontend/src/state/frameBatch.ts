/** A run's stream applied a frame at a time: a stream opened on a busy run replays hundreds of stored events at once,
 *  and a live one streams deltas faster than the page paints. Each event set into the store re-renders the session's
 *  cards; gathered and applied together, a burst is one render, not one per event. The order is kept. */

export interface FrameBatch<T> {
  push: (item: T) => void
  /** apply what is waiting now (the stream ended: its last events land before what follows the end) */
  flush: () => void
  /** drop what is waiting (the stream was closed: its session is no longer the one on show) */
  cancel: () => void
}

/** When to apply: the next frame the page paints, or a timer — whichever comes first, since a window hidden after the
 *  frame was asked for paints none until it shows again, and the tests have no frames. */
export type Schedule = (run: () => void) => () => void

const FRAME_MS = 16

const nextFrame: Schedule = (run) => {
  let done = false
  const once = () => { if (!done) { done = true; cancel(); run() } }
  const timer = setTimeout(once, FRAME_MS)
  const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(once) : null
  const cancel = () => {
    clearTimeout(timer)
    if (frame !== null) cancelAnimationFrame(frame)
  }
  return () => { done = true; cancel() }
}

export function frameBatch<T>(apply: (items: T[]) => void, schedule: Schedule = nextFrame): FrameBatch<T> {
  let waiting: T[] = []
  let unschedule: (() => void) | null = null
  const flush = () => {
    unschedule?.()
    unschedule = null
    if (!waiting.length) return
    const items = waiting
    waiting = []
    apply(items)
  }
  return {
    push: (item) => {
      waiting.push(item)
      if (!unschedule) unschedule = schedule(flush)
    },
    flush,
    cancel: () => {
      unschedule?.()
      unschedule = null
      waiting = []
    },
  }
}
