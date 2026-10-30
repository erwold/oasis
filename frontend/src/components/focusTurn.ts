/** The thread brought to an agent's answer (from the Agent Teams outline): the turn scrolls smoothly into view, then
 *  the line that encloses the agent's part lights twice. Returns false when the run has no turn in the thread (an
 *  order run, a child: its card is where it is read). */
export function focusTurn(runId: string): boolean {
  const section = document.querySelector<HTMLElement>(`[data-testid="run-${CSS.escape(runId)}"]`)
  if (!section) return false
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
