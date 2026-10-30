/** The reel behind the brand mark: with no lead bot in the set, the mark is whichever bot is up right now —
 *  the set's bots in a shuffled order, one at a time, each sliding out for the next like a slot machine. One reel
 *  for the page: the start screen shows its working loop, the rail its icon, both on the same bot. */

import { create } from 'zustand'
import { BOTS } from './outline.ts'

export const REEL_MS = 2600

/** A shuffle with the random source passed in (Fisher–Yates), so a test can pin it. */
export function shuffled<T>(items: readonly T[], rand: () => number = Math.random): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export function nextIndex(index: number, length: number): number {
  return length > 0 ? (index + 1) % length : 0
}

interface ReelState {
  order: string[]
  index: number
  /** how many components want the reel turning; the ticker runs while any does */
  watchers: number
  advance: () => void
  /** a component that shows the reel calls this on mount; the return stops its watch */
  watch: () => () => void
}

let timer: number | null = null

export const useReel = create<ReelState>((set, get) => ({
  order: shuffled(BOTS),
  index: 0,
  watchers: 0,
  advance: () => set((s) => ({ index: nextIndex(s.index, s.order.length) })),
  watch: () => {
    set((s) => ({ watchers: s.watchers + 1 }))
    if (timer === null) timer = window.setInterval(() => get().advance(), REEL_MS)
    return () => {
      set((s) => ({ watchers: Math.max(0, s.watchers - 1) }))
      if (get().watchers === 0 && timer !== null) { window.clearInterval(timer); timer = null }
    }
  },
}))

/** The bot at a reel position. */
export function botAt(order: readonly string[], index: number): string {
  return order[((index % order.length) + order.length) % order.length]
}
