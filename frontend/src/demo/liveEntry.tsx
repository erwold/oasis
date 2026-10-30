/** The live UI demo's entry (main.tsx loads it lazily for `?demo=live-ui`, instead of the app — the app's boot, its
 *  token and its sync never start). The stores' actions are swapped for in-memory ones before anything draws, and put
 *  back when the demo is unmounted (a page leaving, or the `oasis-live-demo:unmount` event a test sends). */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installLiveAdapter } from './liveAdapter'
import { bootLive, LiveDemo, optionsFrom, type LiveTheme } from './LiveDemo'

export const UNMOUNT_EVENT = 'oasis-live-demo:unmount'

/** the skin in the address, so a reload keeps it (the address only: nothing is stored) */
function keepTheme(theme: LiveTheme) {
  const url = new URL(window.location.href)
  if (url.searchParams.get('theme') === theme) return
  url.searchParams.set('theme', theme)
  window.history.replaceState(window.history.state, '', url)
}

export function mountLiveDemo(el: HTMLElement): () => void {
  const initial = optionsFrom(window.location.search)
  const restore = installLiveAdapter()
  // the demo's Atelier is the app's claude palette whatever the app's own choice is (its Signal skin re-points the
  // tokens over it); the app's theme is put back when the demo leaves
  const appTheme = document.documentElement.dataset.theme
  document.documentElement.dataset.theme = 'claude'
  const boot = bootLive(initial)
  const root = createRoot(el)
  root.render(<StrictMode><LiveDemo initial={initial} boot={boot} onTheme={keepTheme} /></StrictMode>)
  let mounted = true
  const unmount = () => {
    if (!mounted) return
    mounted = false
    root.unmount()
    delete document.documentElement.dataset.liveTheme
    if (appTheme === undefined) delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = appTheme
    restore()
    window.removeEventListener(UNMOUNT_EVENT, unmount)
    window.removeEventListener('pagehide', unmount)
    el.dataset.liveDemo = 'unmounted'
  }
  window.addEventListener(UNMOUNT_EVENT, unmount)
  window.addEventListener('pagehide', unmount)
  el.dataset.liveDemo = 'mounted'
  return unmount
}
