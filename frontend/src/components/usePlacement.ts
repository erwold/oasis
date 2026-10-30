import { useEffect, useState, type RefObject } from 'react'
import { chatGptPlaceOf, HIDDEN_CHATGPT, type ChatGptPlace } from '../state/desktop'

/** A page the desktop shell draws over a card's body (the ChatGPT page, the agent's browser): every frame the body's
 *  box and whether anything covers it go to the shell (only when they change), so the page follows the card as it
 *  glides, resizes or expands, and steps aside for a card in front, a menu or a dialog. Returns whether it shows. */
export function usePlacement(ref: RefObject<HTMLDivElement | null>, place: (p: ChatGptPlace) => void): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    let last = ''
    let frame = 0
    const tick = () => {
      const el = ref.current
      if (el) {
        // the card's own parts (its resize edges over the body's corners) do not cover it; anything else does
        const card = el.closest('.desk-win') ?? el
        const next = chatGptPlaceOf(el.getBoundingClientRect(), (x, y) => { const at = document.elementFromPoint(x, y); return !!at && card.contains(at) }, document.visibilityState === 'visible')
        const key = JSON.stringify(next)
        if (key !== last) { last = key; place(next); setShown(next.visible) }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame); place(HIDDEN_CHATGPT) }
  }, [place, ref])
  return shown
}
