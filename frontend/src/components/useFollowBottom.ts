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
  const lastTop = useRef(0)
  const setPinned = useCallback((next: boolean) => {
    pinnedNow.current = next
    lastTop.current = node.current?.scrollTop ?? 0
    node.current?.style.setProperty('overflow-anchor', next ? 'none' : 'auto')
    setPinnedState(next)
  }, [])
  // Called only when the first complete transcript has committed. A held view/queued focus must win; this
  // neither changes pinned state nor broadcasts a new follow intent. Later size changes still use the rAF below.
  const initialFollow = useCallback(() => {
    const target = node.current
    if (pinnedNow.current && target) { target.scrollTop = target.scrollHeight; lastTop.current = target.scrollTop }
  }, [])
  const ref = useCallback((next: HTMLDivElement | null) => {
    node.current = next
    // This callback attaches a new scroller (session/Records are keyed). Its initial offset is zero; reading
    // scrollTop here forces the entire new shell to lay out during React commit before the body exists.
    lastTop.current = 0
    next?.style.setProperty('overflow-anchor', pinnedNow.current ? 'none' : 'auto')
    setEl(next)
  }, [])
  useEffect(() => {
    if (!el) return
    let frame = 0
    const follow = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (pinnedNow.current) { el.scrollTop = el.scrollHeight; lastTop.current = el.scrollTop }
      })
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
  useEffect(() => {
    if (!el) return
    let frame = 0
    let pointerDown = false, extending = false
    let manual: Range | null = null
    const sameRange = (a: Range, b: Range | null) => b !== null && a.startContainer === b.startContainer && a.endContainer === b.endContainer && a.startOffset === b.startOffset && a.endOffset === b.endOffset
    const rememberSelection = () => { const s = document.getSelection(); manual = s && !s.isCollapsed && s.rangeCount ? s.getRangeAt(0).cloneRange() : null }
    const down = () => { pointerDown = true; cancelAnimationFrame(frame) }
    const up = () => { if (pointerDown) rememberSelection(); pointerDown = false }
    const keyDown = (e: KeyboardEvent) => {
      if (e.shiftKey && /^(Arrow|Page|Home|End)/.test(e.key)) { extending = true; cancelAnimationFrame(frame) }
    }
    const keyUp = () => { if (extending) rememberSelection(); extending = false }
    const revealSelection = () => {
      const selected = document.getSelection()
      if (!selected || selected.isCollapsed || !selected.rangeCount) return
      const range = selected.getRangeAt(0).cloneRange()
      if (pointerDown || extending) { manual = range; return }
      if (sameRange(range, manual)) return // a persistent drag/Shift selection is the person's, never recentered
      const element = (n: Node) => n.nodeType === Node.ELEMENT_NODE ? n as Element : n.parentElement
      const start = element(range.startContainer)?.closest('.turn-group')
      const end = element(range.endContainer)?.closest('.turn-group')
      if (!start || start !== end || !el.contains(start) || getComputedStyle(start).contentVisibility !== 'auto') return // leave cross-turn/Select All selection alone
      setPinned(false)
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const current = document.getSelection()
        if (!current?.rangeCount || current.isCollapsed || pointerDown || extending) return
        const now = current.getRangeAt(0)
        if (!sameRange(now, range) || sameRange(now, manual)) return
        // Native find can choose its scroll offset while an offscreen turn still has its estimated height.
        // Read the selected range's actual layout, then keep a short match above the floating composer.
        const r = range.getBoundingClientRect(), view = el.getBoundingClientRect()
        const dock = parseFloat(getComputedStyle(el.parentElement ?? el).getPropertyValue('--dock-h')) || 0
        const bottom = view.bottom - dock, room = bottom - view.top
        if (r.height < room && (r.top < view.top || r.bottom > bottom)) el.scrollTop += r.top - view.top - (room - r.height) / 2
      })
    }
    document.addEventListener('selectionchange', revealSelection)
    document.addEventListener('pointerdown', down, true); document.addEventListener('pointerup', up, true)
    document.addEventListener('pointercancel', up, true)
    document.addEventListener('keydown', keyDown, true); document.addEventListener('keyup', keyUp, true)
    return () => {
      cancelAnimationFrame(frame); document.removeEventListener('selectionchange', revealSelection)
      document.removeEventListener('pointerdown', down, true); document.removeEventListener('pointerup', up, true)
      document.removeEventListener('pointercancel', up, true)
      document.removeEventListener('keydown', keyDown, true); document.removeEventListener('keyup', keyUp, true)
    }
  }, [el, setPinned])
  useEffect(() => {
    if (pinned && node.current) { node.current.scrollTop = node.current.scrollHeight; lastTop.current = node.current.scrollTop }
  }, [pinned])
  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const t = e.currentTarget
    const before = lastTop.current
    lastTop.current = t.scrollTop
    const near = t.scrollHeight - t.scrollTop - t.clientHeight < NEAR_BOTTOM
    // A queued scroll at the old bottom must not undo holdThread() before a smooth jump starts moving.
    // Conversely, a height change without upward scrolling is not a request to stop following: the size
    // observer will bring the new bottom into view. Rejoin follow by actually scrolling down to it (or Jump).
    if (pinnedNow.current) {
      if (!near && t.scrollTop < before) setPinned(false)
    } else if (near && t.scrollTop > before) setPinned(true)
  }, [setPinned])
  return { ref, node, pinned, setPinned, onScroll, initialFollow }
}
