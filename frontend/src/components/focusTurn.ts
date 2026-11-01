import { useStore } from '../state/store'
import { holdThread, onThreadFollow } from '../state/threadFollow'

let cancelPending: (() => void) | null = null

/** A navigation during the initial cooperative render belongs to this opening, not to a fallback card. The
 *  observer is only present while a known thread turn is waiting to mount; a new navigation/session cancels it. */
function waitForTurn(runId: string): boolean {
  const scroller = document.querySelector<HTMLElement>('.thread-scroll[data-transcript-pending]')
  const sessionId = scroller?.dataset.sessionId
  const state = useStore.getState()
  if (!scroller || sessionId !== state.session?.id || !state.runs.some((r) => r.id === runId)) return false
  holdThread()
  const cleanup = () => { stopFollow(); observer.disconnect(); window.clearTimeout(timer); if (cancelPending === cleanup) cancelPending = null }
  const observer = new MutationObserver(() => {
    if (!scroller.isConnected || scroller.dataset.sessionId !== sessionId) { cleanup(); return }
    if (scroller.querySelector(`[data-testid="run-${CSS.escape(runId)}"]`)) { cleanup(); focusTurn(runId) }
    else if (!scroller.hasAttribute('data-transcript-pending')) cleanup()
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-transcript-pending', 'data-session-id'] })
  const timer = window.setTimeout(cleanup, 30_000)
  const stopFollow = onThreadFollow(cleanup)
  cancelPending = cleanup
  return true
}

/** The thread brought to an agent's answer (from the Agent Teams outline): the turn scrolls smoothly into view, then
 *  the line that encloses the agent's part lights twice. Returns false when the run has no turn in the thread (an
 *  order run, a child: its card is where it is read). */
export function focusTurn(runId: string): boolean {
  cancelPending?.()
  const section = document.querySelector<HTMLElement>(`[data-testid="run-${CSS.escape(runId)}"]`)
  if (!section) return waitForTurn(runId)
  holdThread()
  const span = section.querySelector<HTMLElement>('.agent-span') ?? section
  const scroller = section.closest<HTMLElement>('.thread-scroll')
  let lit = false
  let moved = false
  const onScroll = () => { moved = true }
  const light = () => {
    if (lit) return
    lit = true
    scroller?.removeEventListener('scroll', onScroll)
    scroller?.removeEventListener('scrollend', light)
    span.classList.remove('flash')
    void span.offsetWidth                              // a fresh start: a second click lights it again
    span.classList.add('flash')
  }
  // the light comes when the scroll has arrived, however long a glide over a long thread takes; a turn already in
  // place never scrolls (lit at once), and a scroll that never reports its end is lit after a while anyway
  scroller?.addEventListener('scroll', onScroll, { passive: true })
  scroller?.addEventListener('scrollend', light)
  window.setTimeout(() => { if (!moved) light() }, 150)
  window.setTimeout(light, 2500)
  section.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return true
}
