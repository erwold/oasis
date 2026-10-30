import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { REMOTE_PROVIDERS, remoteAccess, remoteLine, remoteSetupStep, type RemoteProvider, type RemoteStatus } from '../state/desktop'
import { useStore } from '../state/store'
import { CheckIcon, CopyIcon, PlayIcon } from './icons'

/** the Connect ChatGPT walkthrough, loaded only when the person opens it */
const RemoteAccessDemo = lazy(() => import('./RemoteAccessDemo'))

/** Remote access, in Settings › Connections (the desktop app only): ChatGPT reaches oasis-code at one fixed URL served
 *  by a standing gateway (a launchd agent that keeps running when this app quits). On or off, its state, the
 *  connector's address, the one-time tunnel setup, keeping the Mac awake, and revoking the link (a new address).
 *  Read every two seconds while shown (the shell reads local status only; it never probes the public name). */
export function RemoteAccessCard() {
  const shell = remoteAccess(window as { oasisCodeDesktop?: unknown })
  const showToast = useStore((s) => s.showToast)
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [provider, setProvider] = useState<RemoteProvider>('quick')
  const [host, setHost] = useState('')
  const [token, setToken] = useState('')
  const [demoOpen, setDemoOpen] = useState(false)
  const demoButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const reader = remoteAccess(window as { oasisCodeDesktop?: unknown })
    if (!reader) return
    let alive = true
    const read = () => { void reader.remoteStatus().then((s) => { if (alive) setStatus(s) }, () => undefined) }
    read()
    const timer = window.setInterval(read, 2000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])
  if (!shell || !status) return null
  const act = (work: () => Promise<RemoteStatus | null>, after?: () => void) => {
    setBusy(true)
    void work().then((s) => { if (s) setStatus(s); after?.() }, (e) => showToast(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false))
  }
  const copy = async () => {
    if (!status.url) return
    try { await navigator.clipboard.writeText(status.url); setCopied(true); window.setTimeout(() => setCopied(false), 1500) } catch { showToast('Could not copy: select the address and copy it') }
  }
  const choice = REMOTE_PROVIDERS.find((p) => p.value === provider)!
  const setupShown = editing
  const openSetup = () => { setProvider(status.provider); setHost(status.provider === 'quick' ? '' : status.host ?? ''); setToken(''); setEditing(true) }
  const save = () => act(() => shell.configureRemote(choice.host === null ? { provider } : { provider, host, token: choice.token ? token : undefined }), () => { setEditing(false); setToken('') })
  return (
    <section className="acct-card remote-card" aria-label="Remote access" data-testid="remote-access">
      <div className="acct-section-head">
        <strong>Remote access</strong>
        <button ref={demoButton} type="button" className="remote-demo-open" aria-expanded={demoOpen} onClick={() => setDemoOpen(!demoOpen)} data-testid="remote-demo-open">
          <PlayIcon size={10} />Connect ChatGPT
        </button>
        <span>ChatGPT on the web directs oasis-code at a fixed address</span>
      </div>
      {demoOpen && (
        <Suspense fallback={<div className="remote-demo-loading" />}>
          <RemoteAccessDemo onClose={() => { setDemoOpen(false); demoButton.current?.focus() }} />
        </Suspense>
      )}
      <div className="remote-row">
        <span className={`remote-dot is-${status.state}`} aria-hidden />
        <span className="remote-line" data-testid="remote-line">{remoteLine(status)}</span>
        <button className={`acct-btn${status.enabled ? '' : ' ink'}`} disabled={busy} data-testid="remote-toggle"
                onClick={() => act(() => shell.setRemote({ enabled: !status.enabled }))}>{status.enabled ? 'Turn off' : 'Turn on'}</button>
      </div>
      {!setupShown && (
        <div className="remote-where" data-testid="remote-where">
          {REMOTE_PROVIDERS.find((p) => p.value === status.provider)?.label ?? status.provider}{status.host ? ` · ${status.host}` : ''}{' '}
          <button className="acct-btn quiet" disabled={busy} onClick={openSetup} data-testid="remote-change">Change</button>
        </div>
      )}
      {setupShown && (
        <div className="remote-setup" data-testid="remote-setup">
          <label htmlFor="remote-provider">Tunnel</label>
          <select id="remote-provider" value={provider} disabled={busy} onChange={(e) => setProvider(e.target.value as RemoteProvider)} data-testid="remote-provider">
            {REMOTE_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          {choice.host !== null && <>
            <label htmlFor="remote-host">Host</label>
            <input id="remote-host" value={host} placeholder={choice.host} disabled={busy} spellCheck={false} autoComplete="off" onChange={(e) => setHost(e.target.value)} data-testid="remote-host" />
          </>}
          {choice.token && <>
            <label htmlFor="remote-token">{choice.token}</label>
            <input id="remote-token" type="password" value={token} disabled={busy} autoComplete="off"
                   placeholder={status.provider === provider && status.token_set ? 'saved — paste to replace' : ''} onChange={(e) => setToken(e.target.value)} data-testid="remote-token" />
          </>}
          <p className="remote-step" data-testid="remote-step">{remoteSetupStep(provider, status.gateway_origin)}{choice.help && <> <a href={choice.help} target="_blank" rel="noreferrer">Setup</a></>}</p>
          <div className="remote-setup-actions">
            <button className="acct-btn ink" disabled={busy || (choice.host !== null && !host.trim())} onClick={save} data-testid="remote-save">Save</button>
            {editing && <button className="acct-btn quiet" disabled={busy} onClick={() => { setEditing(false); setToken('') }}>Cancel</button>}
          </div>
        </div>
      )}
      {status.url && (
        <div className="remote-url">
          <code title="The connector's address: its key is inside — whoever has it can direct this Mac" data-testid="remote-url">{status.url}</code>
          <button className="acct-btn" onClick={() => void copy()} data-testid="remote-copy">{copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}{copied ? 'Copied' : 'Copy'}</button>
        </div>
      )}
      <div className="remote-row remote-options">
        <label className="remote-check">
          <input type="checkbox" checked={status.keep_awake} disabled={busy} onChange={(e) => act(() => shell.setRemote({ keep_awake: e.target.checked }))} data-testid="remote-awake" />
          Keep this Mac awake while the app is open
        </label>
        {status.url && <button className="acct-btn quiet" disabled={busy} data-testid="remote-rotate"
                               title="A new address: the current one stops working at once"
                               onClick={() => { if (window.confirm('Revoke this link? The current address stops working at once; paste the new one into ChatGPT.')) act(() => shell.rotateRemote()) }}>Revoke link</button>}
      </div>
    </section>
  )
}
