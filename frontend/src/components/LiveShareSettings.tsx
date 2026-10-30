import { useEffect, useRef, useState } from 'react'
import { LIVE_SHARE_DEFAULT_PORT, type LiveShareSettings, type LiveShareSettingsResponse } from '@oasis-code/contract'
import { api } from '../api/client'
import { liveShareError, publicBaseUrl, serviceState } from '../state/liveShare'

type LiveShareBind = LiveShareSettings['bind']

/** Live sharing, in Settings › Connections (the web page and the desktop app alike): the share listener that serves
 *  live links' pages — off by default; on this computer only (loopback: a tunnel the person runs brings a public name to
 *  it) or on the local network (LAN: every device on it can reach the port); its port; the public URL a copied link
 *  names. Every change applies with Save (the whole settings object, as the backend takes it). Read every five seconds while its tab is shown. */
export function LiveShareCard({ shown }: { shown: boolean }) {
  const [data, setData] = useState<LiveShareSettingsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [bind, setBind] = useState<LiveShareBind>('loopback')
  const [port, setPort] = useState(String(LIVE_SHARE_DEFAULT_PORT))
  const [url, setUrl] = useState('')
  const [dirty, setDirty] = useState(false)
  // a save: a read that started before it is older than what the save answered
  const generation = useRef(0)

  useEffect(() => {
    if (!shown) return
    const controller = new AbortController()
    const read = () => {
      const started = generation.current
      void api.liveShareSettings(controller.signal).then((d) => {
        if (controller.signal.aborted || started !== generation.current) return
        setData(d)
        setError(null)
      }, (e: unknown) => { if (!controller.signal.aborted && started === generation.current) setError(liveShareError(e, 'Live sharing is not available in this app version.')) })
    }
    read()
    const timer = window.setInterval(read, 5_000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [shown])

  // the form follows what is saved until the person edits it
  useEffect(() => {
    if (!data || dirty) return
    setEnabled(data.settings.enabled)
    setBind(data.settings.bind)
    setPort(String(data.settings.port))
    setUrl(data.settings.public_base_url ?? '')
  }, [data, dirty])

  const portNumber = Number(port)
  const portOk = Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535
  const base = publicBaseUrl(url)
  const formOk = portOk && base !== undefined
  const state = data ? serviceState(data.settings, data.status) : null

  const save = (next: LiveShareSettings) => {
    setBusy(true)
    setError(null)
    generation.current += 1
    void api.saveLiveShareSettings(next).then((d) => { setData(d); setDirty(false) }, (e: unknown) => setError(liveShareError(e)))
      .finally(() => { generation.current += 1; setBusy(false) })
  }
  const formSettings = (): LiveShareSettings => ({ enabled, bind, port: portNumber, public_base_url: base ?? null })

  return (
    <section className="acct-card live-share-card" aria-label="Live sharing" data-testid="live-share-settings">
      <div className="acct-section-head"><strong>Live sharing</strong><span>Read-only live links to a session</span></div>
      {error && <p className="acct-banner is-error" role="alert" data-testid="live-share-settings-error">{error}</p>}
      {data && state && <>
        <div className="remote-row">
          <span className={`remote-dot live-share-dot is-${state.kind}`} aria-hidden />
          <span className="remote-line" data-testid="live-share-status" data-state={state.kind}>{state.line}</span>
        </div>
        <div className="remote-setup live-share-form">
          <label htmlFor="live-share-enabled">Sharing</label>
          <label className="remote-check">
            <input id="live-share-enabled" type="checkbox" checked={enabled} disabled={busy} onChange={(e) => { setEnabled(e.target.checked); setDirty(true) }} data-testid="live-share-enabled" />
            On
          </label>
          <label htmlFor="live-share-bind">Reachable</label>
          <select id="live-share-bind" value={bind} disabled={busy} onChange={(e) => { setBind(e.target.value as LiveShareBind); setDirty(true) }} data-testid="live-share-bind">
            <option value="loopback">This computer only (127.0.0.1)</option>
            <option value="lan">Local network — any device on it</option>
          </select>
          <label htmlFor="live-share-port">Port</label>
          <input id="live-share-port" type="number" min={1024} max={65535} value={port} disabled={busy} onChange={(e) => { setPort(e.target.value); setDirty(true) }}
                 aria-invalid={!portOk} data-testid="live-share-port" />
          <label htmlFor="live-share-base-url">Public URL</label>
          <input id="live-share-base-url" value={url} disabled={busy} spellCheck={false} autoComplete="off" placeholder={bind === 'lan' ? 'http://192.168.1.20:8325' : 'optional · https://share.example.com'}
                 onChange={(e) => { setUrl(e.target.value); setDirty(true) }} aria-invalid={base === undefined} data-testid="live-share-base-url" />
          {(!portOk || base === undefined) && <p className="remote-step live-error" data-testid="live-share-invalid">{!portOk ? 'Port: 1024 to 65535.' : 'Public URL: an http(s) origin only, no path.'}</p>}
          {bind === 'lan' && <p className="remote-step" data-testid="live-share-lan-note">Anyone on this network can reach the port; a link still needs its key.{base === null ? ' Set the public URL to copy links.' : ''}</p>}
          <div className="remote-setup-actions">
            <button className="acct-btn ink" disabled={busy || !dirty || !formOk} onClick={() => save(formSettings())} data-testid="live-share-save">{busy ? 'Saving…' : 'Save'}</button>
            {dirty && <button className="acct-btn quiet" disabled={busy} onClick={() => setDirty(false)}>Cancel</button>}
          </div>
        </div>
      </>}
      {!data && !error && <p className="acct-note">Checking…</p>}
    </section>
  )
}
