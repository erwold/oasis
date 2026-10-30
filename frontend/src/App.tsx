import { useEffect } from 'react'
import { ChatGptSheet } from './components/ChatGptSheet'
import { Hero } from './components/Hero'
import { Sidebar } from './components/Sidebar'
import { Thread } from './components/Thread'
import { useStore } from './state/store'

/** Two states, after oasis's App: the start screen (the rail and one composer) until a session is open; then
 *  the rail beside the thread, the desk's cards floating over it. The rail is the only chrome. */
export function App() {
  const boot = useStore((s) => s.boot)
  const startSync = useStore((s) => s.startSync)
  const buildMismatch = useStore((s) => s.buildMismatch)
  const build = useStore((s) => s.build)
  const staleUi = useStore((s) => s.staleUi)
  const toast = useStore((s) => s.toast)
  const notice = useStore((s) => s.notice)
  const showToast = useStore((s) => s.showToast)
  const setNotice = useStore((s) => s.setNotice)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const session = useStore((s) => s.session)
  useEffect(() => { void boot() }, [boot])
  // another client (the director endpoint: ChatGPT) may add notes and runs to the open session and sessions to
  // the rail; the page asks the harness on a ticker and takes them in
  useEffect(() => startSync(), [startSync])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => showToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast, showToast])
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice, setNotice])
  if (buildMismatch) {
    return (
      <div className="app-shell">
        <div className="build-mismatch" data-testid="build-mismatch">
          <p className="build-mismatch-title">This UI does not match the backend it is talking to.</p>
          <p>{buildMismatch}</p>
          <p className="build-mismatch-hint">
            Rebuild the UI (<code>cd frontend && npm run build</code>) or restart the backend from the same checkout, then reload.
          </p>
          <p className="build-mismatch-meta">UI build {__OASIS_CODE_BUILD__} · backend {build?.source_fingerprint ?? '?'} · schema v{build?.schema_version ?? '?'} · {build?.api_version ?? '?'}</p>
        </div>
      </div>
    )
  }
  return (
    <div className="app-shell">
      {session ? (
        <div className={`workspace desk${sidebarOpen ? '' : ' rail-hidden'}`}>
          <Sidebar />
          <Thread />
        </div>
      ) : (
        <main className="workspace hero-workspace">
          <Sidebar />
          <Hero />
        </main>
      )}
      <ChatGptSheet />
      {toast && <div className="toast" role="status" onClick={() => showToast(null)}>{toast}</div>}
      {notice && !toast && <div className="toast notice" role="status" onClick={() => setNotice(null)}>{notice}</div>}
      {staleUi && <div className="stale-ui" role="status" data-testid="stale-ui">{staleUi} <button className="thread-btn" onClick={() => window.location.reload()}>Reload</button></div>}
    </div>
  )
}
