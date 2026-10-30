import { useEffect, useMemo, useRef, useState } from 'react'
import type { LiveShareSettingsResponse, ShareLinkV2 } from '@oasis-code/contract'
import { api } from '../api/client'
import { useStore } from '../state/store'
import {
  copyableUrl, DEFAULT_EXPIRY, EXPIRY_CHOICES, EXPIRY_UNITS, expirySeconds, linkOptionsLine, linkRequest, linkTimeLine, liveRunChoices, liveShareError,
  serviceState, type ExpiryUnit,
} from '../state/liveShare'
import { CheckIcon, CopyIcon } from './icons'

/** A link just made or revealed: its URL (with its capability) kept here only, while the dialog is open. */
interface Revealed { id: string; url: string | null }

/** The share dialog's Live link side (ShareDialog.tsx): a link to this session that shows it as it works, read-only —
 *  its options (tool details, images, runs left out) and its expiry fixed when it is made; Create (and copy); the
 *  session's links with Copy (revealed again from the app: the same link every time) and Revoke. Closing the dialog
 *  revokes nothing. Where no link can be copied (the listener off, no public URL for LAN), it says so, with the way
 *  to Settings. No idle wait: a working session can be shared. */
export function ShareLivePanel({ sessionId, onOpenSettings }: { sessionId: string; onOpenSettings: () => void }) {
  const runs = useStore((s) => s.runs)
  const choices = useMemo(() => liveRunChoices(runs, sessionId), [runs, sessionId])
  const [service, setService] = useState<LiveShareSettingsResponse | null>(null)
  const [links, setLinks] = useState<ShareLinkV2[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tools, setTools] = useState(false)
  const [images, setImages] = useState(false)
  const [excluded, setExcluded] = useState<string[]>([])
  // every session of the task, now and later (off by default); the run list is this session's alone, so it goes with
  // what it left out
  const [task, setTask] = useState(false)
  const chooseTask = (on: boolean) => { setTask(on); setExcluded([]) }
  const [expiry, setExpiry] = useState(DEFAULT_EXPIRY)
  const [amount, setAmount] = useState(2)
  const [unit, setUnit] = useState<ExpiryUnit>('hours')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Revealed | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // mounted (set on every setup: StrictMode runs setup, cleanup, setup) — a result arriving after unmount is dropped
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  // a change the person made (create, copy, revoke): a list read that started before it is older than what is shown
  const generation = useRef(0)

  // the listener's state and the session's links: read when shown, then every 15 s (viewers, expiries)
  useEffect(() => {
    const controller = new AbortController()
    const read = () => {
      const started = generation.current
      void Promise.all([api.liveShareSettings(controller.signal), api.shareLinksV2(sessionId, controller.signal)]).then(([s, l]) => {
        if (controller.signal.aborted || started !== generation.current) return
        setService(s)
        setLinks(l.links)
        setLoadError(null)
        setNow(Date.now())
      }, (e: unknown) => { if (!controller.signal.aborted && started === generation.current) setLoadError(liveShareError(e, 'Live sharing is not available in this app version.')) })
    }
    read()
    const timer = window.setInterval(read, 15_000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [sessionId])

  const seconds = expirySeconds(expiry, amount, unit)
  const state = service ? serviceState(service.settings, service.status) : null
  const lanWithoutUrl = service?.settings.bind === 'lan' && !service.settings.public_base_url
  const active = links?.filter((l) => l.state === 'active') ?? []
  // the ended ones: the latest few, for what became of them
  const ended = links?.filter((l) => l.state !== 'active').slice(0, 10) ?? []

  const put = (link: ShareLinkV2) => setLinks((ls) => [link, ...(ls ?? []).filter((l) => l.id !== link.id)])
  const copy = async (id: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      if (!alive.current) return
      setCopied(id)
      window.setTimeout(() => { if (alive.current) setCopied((c) => (c === id ? null : c)) }, 1500)
    } catch { if (alive.current) setError('Could not copy: select the link below and copy it.') }
  }
  const create = async () => {
    if (seconds === null) return
    setBusy('create'); setError(null); generation.current += 1
    try {
      const made = await api.createShareLinkV2(sessionId, { ...linkRequest({ tools, images, excluded: task ? [] : excluded }, seconds), include_task_sessions: task })
      if (!alive.current) return
      put(made.link)
      setRevealed({ id: made.link.id, url: made.url })
      if (copyableUrl(made.url)) await copy(made.link.id, made.url)
    } catch (e) { if (alive.current) setError(liveShareError(e)) } finally { generation.current += 1; if (alive.current) setBusy(null) }
  }
  const copyLink = async (link: ShareLinkV2) => {
    setBusy(link.id); setError(null); generation.current += 1
    try {
      const r = await api.revealShareLinkV2(link.id)
      if (!alive.current) return
      put(r.link)
      setRevealed({ id: link.id, url: r.url })
      if (copyableUrl(r.url)) await copy(link.id, r.url)
    } catch (e) { if (alive.current) setError(liveShareError(e)) } finally { generation.current += 1; if (alive.current) setBusy(null) }
  }
  const revoke = async (link: ShareLinkV2) => {
    setBusy(link.id); setError(null); setConfirm(null); generation.current += 1
    try {
      const r = await api.revokeShareLinkV2(link.id)
      if (!alive.current) return
      put(r.link)
      setRevealed((v) => (v?.id === link.id ? null : v))
    } catch (e) { if (alive.current) setError(liveShareError(e)) } finally { generation.current += 1; if (alive.current) setBusy(null) }
  }
  const toggleRun = (id: string) => setExcluded((ex) => (ex.includes(id) ? ex.filter((x) => x !== id) : [...ex, id]))
  const included = choices.length - excluded.filter((id) => choices.some((r) => r.run_id === id)).length

  return (
    <div className="live-panel" data-testid="live-share-dialog">
      <div className="live-service" data-testid="live-share-service" data-state={state?.kind ?? (loadError ? 'error' : 'loading')}>
        {loadError ? <span className="live-error" data-testid="live-share-load-error">{loadError}</span>
          : !state ? <span className="dim">Loading…</span>
          : <>
              <span className={`live-dot is-${state.kind}`} />
              <span>Sharing service: <b>{state.line}</b>{service?.settings.bind === 'lan' && state.kind === 'listening' ? ' · LAN' : ''}</span>
              {state.kind !== 'listening' && <span className="dim">Links can be made now; they open once it is on.</span>}
              {lanWithoutUrl && <span className="dim">Set a public URL to copy links.</span>}
              <button type="button" className="link-btn" onClick={onOpenSettings} data-testid="live-share-settings-open">Settings</button>
            </>}
      </div>

      <div className="live-create" data-testid="live-share-create-form">
        <label className="share-opt" title="Tools' short results and a cut output preview, redacted">
          <input type="checkbox" checked={tools} onChange={(e) => setTools(e.target.checked)} data-testid="live-share-tools" /> Tool details
        </label>
        <label className="share-opt" title="The session's own pictures, metadata removed. What they show is not redacted.">
          <input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} data-testid="live-share-images" /> Images
          {images && <span className="share-cue" data-testid="live-share-images-cue">pixels not redacted</span>}
        </label>
        <label className="share-opt">
          <input type="checkbox" checked={task} onChange={(e) => chooseTask(e.target.checked)} data-testid="live-share-task" /> 包含这个任务下的所有会话
        </label>
        {!task && choices.length > 1 && (
          <details className="share-runs" data-testid="live-share-runs">
            <summary>Runs {included}/{choices.length}</summary>
            <div className="share-runs-list">
              {choices.map((r) => (
                <label key={r.run_id} className="share-run">
                  <input type="checkbox" checked={!excluded.includes(r.run_id)} onChange={() => toggleRun(r.run_id)} data-testid="live-share-run" />
                  <span className="share-run-label" title={r.label}>{r.label}</span><span className={`share-run-status ${r.status}`}>{r.status}</span>
                </label>
              ))}
            </div>
          </details>
        )}
        <label className="share-opt">Expires
          <select value={expiry} onChange={(e) => setExpiry(e.target.value)} data-testid="live-share-expiry">
            {EXPIRY_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        {expiry === 'custom' && (
          <span className="share-opt live-custom">
            <input type="number" min={1} step={1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} aria-label="Expires after" data-testid="live-share-expiry-amount" />
            <select value={unit} onChange={(e) => setUnit(e.target.value as ExpiryUnit)} aria-label="Unit" data-testid="live-share-expiry-unit">
              {Object.keys(EXPIRY_UNITS).map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
            {seconds === null && <span className="live-error" data-testid="live-share-expiry-invalid">5 minutes to 30 days</span>}
          </span>
        )}
        <span className="thread-spacer" />
        <button type="button" className="thread-btn primary" disabled={seconds === null || busy !== null || !service} onClick={() => void create()} data-testid="live-share-create">
          {busy === 'create' ? 'Creating…' : 'Create link'}
        </button>
      </div>

      {error && <div className="live-error live-message" role="alert" data-testid="live-share-error">{error}</div>}
      {revealed && (
        copyableUrl(revealed.url)
          ? <div className="live-url-row" data-testid="live-share-url-row">
              <input className="live-url" readOnly value={revealed.url} onFocus={(e) => e.currentTarget.select()} aria-label="Live link" data-testid="live-share-url" />
              <button type="button" className="thread-btn" onClick={() => void copy(revealed.id, revealed.url!)} data-testid="live-share-copy">
                {copied === revealed.id ? <><CheckIcon size={12} /> Copied</> : <><CopyIcon size={12} /> Copy</>}
              </button>
            </div>
          : <div className="live-message" data-testid="live-share-no-url">
              No address to copy yet: set the public URL in Settings. <button type="button" className="link-btn" onClick={onOpenSettings}>Settings</button>
            </div>
      )}

      <div className="live-links" data-testid="live-share-links">
        {links === null && !loadError && <div className="dim">Loading links…</div>}
        {links !== null && links.length === 0 && <div className="dim" data-testid="live-share-links-empty">No links yet.</div>}
        {[...active, ...ended].map((link) => (
          <div key={link.id} className={`live-link is-${link.state}`} data-testid="live-share-link" data-link-id={link.id} data-state={link.state}>
            <span className="live-link-what">
              <span className="live-link-options">{linkOptionsLine(link)}</span>
              <span className="dim">{linkTimeLine(link, now)}{link.state === 'active' && link.viewers ? ` · ${link.viewers} viewing` : ''}</span>
            </span>
            {link.state === 'active' && <>
              <button type="button" className="thread-btn" disabled={busy !== null} onClick={() => void copyLink(link)} data-testid="live-share-link-copy">
                {copied === link.id ? <><CheckIcon size={12} /> Copied</> : <><CopyIcon size={12} /> Copy</>}
              </button>
              {confirm === link.id
                ? <>
                    <button type="button" className="thread-btn danger" disabled={busy !== null} onClick={() => void revoke(link)} data-testid="live-share-revoke-confirm">Revoke now</button>
                    <button type="button" className="thread-btn" onClick={() => setConfirm(null)} data-testid="live-share-revoke-cancel">Keep</button>
                  </>
                : <button type="button" className="thread-btn" disabled={busy !== null} onClick={() => setConfirm(link.id)} data-testid="live-share-link-revoke">Revoke</button>}
            </>}
          </div>
        ))}
      </div>
    </div>
  )
}
