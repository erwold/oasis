/** The live link page's entry (vite.live-share.config.ts builds it into live-share.js and live-share.css, which the
 *  share listener serves at /live/assets/ under its own CSP — `connect-src 'self'`; the app's CSP and the offline file's
 *  are not touched). It reads the capability from the fragment (`/live/#<capability>`: never sent to a server, kept
 *  for a reload, never logged, never stored), opens the link's stream with it, and draws the app's thread from each
 *  whole state. No app boot, no session token, no sync, no storage: the page store, the API and the desk are the
 *  in-memory stand-ins of ../../viewer/offline (the build puts them where the app's modules would be). */

// FIRST: zod without its eval JIT, before any module that builds a schema evaluates
import '../../viewer/jitless'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LIVE_CAPABILITY } from '@oasis-code/contract'
import { createLiveStore } from '../liveState'
import { LiveNoCapability, LiveShareApp } from './LiveShareApp'
// the app's own stylesheet, then the share pages' shell and the live page's own lines
import '../../../index.css'
import '../../viewer/shell.css'
import './live.css'

/** The capability the fragment carries, or null: exactly the contract's shape, nothing else read from the URL. */
export function capabilityOf(hash: string): string | null {
  const value = hash.startsWith('#') ? hash.slice(1) : hash
  return LIVE_CAPABILITY.test(value) ? value : null
}

const root = document.getElementById('root')
if (root) {
  const capability = capabilityOf(window.location.hash)
  if (!capability) createRoot(root).render(<StrictMode><LiveNoCapability /></StrictMode>)
  else {
    const store = createLiveStore({ capability })
    store.start()
    window.addEventListener('online', () => store.nudge())
    // the page leaves for good (not into the back/forward cache): every request stops, every picture URL revoked
    window.addEventListener('pagehide', (e) => { if (!e.persisted) store.close() })
    createRoot(root).render(<StrictMode><LiveShareApp store={store} /></StrictMode>)
  }
}
