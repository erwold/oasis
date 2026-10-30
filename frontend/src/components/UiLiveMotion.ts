/** What makes a live surface move, and only when its data does: a change seen while the page is visible arms a
 *  one-shot mark (the element keyed by it plays its CSS animation once and stays still); a first drawing, a change
 *  that arrives while the page is hidden, and a person who asks for reduced motion (the CSS) get none. Nothing loops. */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

const visible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden'

/** The key of the last change seen while the page was visible, or null: render the one-shot mark (keyed by it) while
 *  it equals the current key. The first key, the one the surface is drawn with, arms nothing. */
export function useArrival(key: string | number | null): string | null {
  const seen = useRef(key)
  const [armed, setArmed] = useState<string | null>(null)
  useEffect(() => {
    if (key === seen.current) return
    seen.current = key
    setArmed(key !== null && visible() ? String(key) : null)
  }, [key])
  return armed !== null && armed === (key === null ? null : String(key)) ? armed : null
}

/** An element's width in whole CSS pixels as laid out (before paint, then on every resize); `fallback` before it is
 *  measured and where nothing lays out (a server render, a test DOM). */
export function useWidth(ref: RefObject<HTMLElement | null>, fallback: number): number {
  const [width, setWidth] = useState(fallback)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => { const w = Math.floor(el.clientWidth); if (w > 0) setWidth((cur) => (cur === w ? cur : w)) }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}
