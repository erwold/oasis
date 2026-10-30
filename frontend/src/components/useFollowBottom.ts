import { useCallback, useEffect, useRef, useState, type UIEvent } from 'react'

const NEAR_BOTTOM = 48

/** A scroller that stays at its bottom while the person has not scrolled away from it: whatever makes it taller (a
 *  new entry, words streaming into the last one, a picture loading) or changes its own size (a card tiled, resized,
 *  opened from a strip) brings the bottom back into view. Sizes are watched, not entry counts — a reply streaming into
 *  one entry adds no entry. While it follows, the browser's scroll anchoring is off: an earlier turn folding above
 *  the view as a new one comes (a turn's work opens only while it is the latest) would otherwise be anchored by a
 *  scroll up, read here as the person's, and the thread would stop following (seen 2026-10-21 on a live session).
 *  Scrolled away, anchoring is on again: what the person reads stays put when something above it folds. */
export function useFollowBottom() {
  const node = useRef<HTMLDivElement | null>(null)
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [pinned, setPinnedState] = useState(true)
  // read by the size watch between a change and its render (a jump unpins, then scrolls to its run)
  const pinnedNow = useRef(pinned)
  const setPinned = useCallback((next: boolean) => {
    pinnedNow.current = next
    node.current?.style.setProperty('overflow-anchor', next ? 'none' : 'auto')
    setPinnedState(next)
  }, [])
  const ref = useCallback((next: HTMLDivElement | null) => {
    node.current = next
    next?.style.setProperty('overflow-anchor', pinnedNow.current ? 'none' : 'auto')
    setEl(next)
  }, [])
  useEffect(() => {
    if (!el) return
    let frame = 0
    const follow = () => {
      if (frame) return
      frame = requestAnimationFrame(() => { frame = 0; if (pinnedNow.current) el.scrollTop = el.scrollHeight })
    }
    const sizes = new ResizeObserver(follow)
    const watch = () => {
      sizes.disconnect()
      sizes.observe(el)
      for (const child of el.children) sizes.observe(child)
    }
    watch()
    const children = new MutationObserver(() => { watch(); follow() })
    children.observe(el, { childList: true })
    return () => { cancelAnimationFrame(frame); sizes.disconnect(); children.disconnect() }
  }, [el])
  useEffect(() => { if (pinned && node.current) node.current.scrollTop = node.current.scrollHeight }, [pinned])
  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const t = e.currentTarget
    setPinned(t.scrollHeight - t.scrollTop - t.clientHeight < NEAR_BOTTOM)
  }, [setPinned])
  return { ref, node, pinned, setPinned, onScroll }
}
