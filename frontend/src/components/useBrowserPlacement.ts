import { useEffect, useState, type RefObject } from 'react'
import { browserFrameSize, HIDDEN_CHATGPT, type ChatGptPlace } from '../state/desktop'

/** The card's display area and visibility, sampled once per animation frame. The page itself stays at 1280×800.
 *  Its mirror is ordinary DOM content: overlays and window clipping already handle drawing and pointer hit tests,
 *  so a partially covered card keeps its live image and its uncovered part remains interactive. */
export function useBrowserPlacement(ref: RefObject<HTMLDivElement | null>, place: (p: ChatGptPlace) => void): { shown: boolean; frame: { width: number; height: number } } {
  const [state, setState] = useState({ shown: false, frame: { width: 0, height: 0 } })
  useEffect(() => {
    let last = ''
    let lastState = ''
    let frame = 0
    const tick = () => {
      const el = ref.current
      if (el) {
        const rect = el.getBoundingClientRect()
        const width = el.offsetWidth, height = el.offsetHeight
        const visible = document.visibilityState === 'visible' && getComputedStyle(el).visibility !== 'hidden'
          && width > 0 && height > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight
          && rect.left + rect.width > 0 && rect.top + rect.height > 0
        const next = { x: Math.round(rect.left + (rect.width - width) / 2), y: Math.round(rect.top + (rect.height - height) / 2), width, height, visible }
        // A folded card can keep moving with a zero-height body. One hide is enough.
        const key = next.visible ? JSON.stringify(next) : 'hidden'
        if (key !== last) { last = key; place(next) }
        const now = { shown: next.visible, frame: browserFrameSize(width, height) }
        const stateKey = `${now.shown}|${now.frame.width}|${now.frame.height}`
        if (stateKey !== lastState) { lastState = stateKey; setState(now) }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame); place(HIDDEN_CHATGPT) }
  }, [place, ref])
  return state
}
