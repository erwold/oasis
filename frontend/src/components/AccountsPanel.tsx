/** Settings (the Accounts panel carried from oasis frontend/src/components/AccountsPanel.tsx, grown into tabs):
 * Accounts — the subscriptions (Codex, Claude, Antigravity) with their sign-in state, the sign-in in flight, their allowances;
 * then the API keys, built-in and custom. Appearance — the theme (state/theme.ts). Connections — Live sharing (the
 * live links' listener) and Remote access (desktop shell only). The rail's footer opens it and shows each account's tightest allowance at a glance. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api/client'
import type { AccountUsage, AuthAccounts, AuthProvider, AuthProviderId, KeyProviderId, KeyRow, LoginSession, QuotaWindow, UsageSnapshot } from '../api/types'
import { customProviderId, maskKey, monogram, suggestEnvName } from '../state/accounts'
import { loginHint, pollDelay, showPasteBox } from '../state/auth'
import { hiddenProxyCount, percentLabel, quotaSummary, remainingPercent, resetCountdown, railAccounts, resetPending, visibleAccounts } from '../state/quota'
import { remoteAccess } from '../state/desktop'
import { SETTINGS_TAB_LABELS, settingsTabForKey, shownSettingsTab, visibleSettingsTabs, type SettingsTab } from '../state/settings'
import { useStore } from '../state/store'
import { appTheme, THEME_LABELS, THEME_PREFERENCES } from '../state/theme'
import { WEB_SEARCH_LABELS, type WebSearchEngine } from '../state/webSearch'
import { RemoteAccessCard } from './RemoteAccess'
import { LiveShareCard } from './LiveShareSettings'
import antigravityLogo from '../assets/logo-antigravity.png'
import claudeLogo from '../assets/logo-claude.png'
import codexLogo from '../assets/logo-codex.png'
import deepseekLogo from '../assets/logo-deepseek.png'
import geminiLogo from '../assets/logo-gemini.png'
import openaiLogo from '../assets/logo-openai.png'
import { GlobeIcon, RefreshIcon, SettingsIcon, SparklesIcon, XIcon } from './icons'
import { ProgressRing } from './ProgressRing'

const SUBSCRIPTIONS: { id: AuthProviderId; label: string; logo: string }[] = [
  { id: 'openai-codex', label: 'Codex', logo: codexLogo },
  { id: 'anthropic', label: 'Claude', logo: claudeLogo },
  { id: 'antigravity', label: 'Antigravity', logo: antigravityLogo },
]
// ink: a one-colour black logo, turned light on the dark theme
const KEY_MARKS: Record<string, { logo?: string; mono?: string; ink?: boolean }> = {
  'anthropic-api': { logo: claudeLogo },
  'openai-api': { logo: openaiLogo, ink: true },
  gemini: { logo: geminiLogo },
  deepseek: { logo: deepseekLogo },
  zhipu: { mono: 'GLM' },
}
const LOGO: Record<AuthProviderId, string> = { 'openai-codex': codexLogo, anthropic: claudeLogo, antigravity: antigravityLogo }
const SHOW_PROXY_KEY = 'oasis-code.accounts.showProxy'

type Tone = 'accent' | 'green' | 'orange' | 'red' | 'neutral'
type Tracked = { session: LoginSession; startedAt: number }

function readShowProxy(): boolean {
  try { return localStorage.getItem(SHOW_PROXY_KEY) === '1' } catch { return false }
}
function writeShowProxy(value: boolean): void {
  try { localStorage.setItem(SHOW_PROXY_KEY, value ? '1' : '0') } catch { /* private window */ }
}
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^\d{3}: /, '')
}
function ringTone(left: number | null, muted: boolean): Tone {
  if (muted || left === null) return 'neutral'
  return left <= 10 ? 'red' : left <= 25 ? 'orange' : 'accent'
}

function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`acct-pill-status tone-${tone}`}><i />{children}</span>
}

function Mark({ logo, mono, ink, icon }: { logo?: string; mono?: string; ink?: boolean; icon?: ReactNode }) {
  return <span className={`acct-mark${mono || icon ? ' mono' : ''}${ink ? ' ink' : ''}`} aria-hidden="true">{logo ? <img src={logo} alt="" /> : icon ?? mono}</span>
}

function Row({ mark, name, sub, pill, actions, children }: {
  mark: ReactNode; name: string; sub: ReactNode; pill: ReactNode; actions: ReactNode; children?: ReactNode
}) {
  return (
    <div className="acct-row2">
      <div className="acct-row2-head">
        {mark}
        <div className="acct-row2-id"><strong>{name}</strong><span className="acct-sub">{sub}</span></div>
        {pill}
        <div className="acct-actions">{actions}</div>
      </div>
      {children}
    </div>
  )
}

function WindowRow({ window, now, muted }: { window: QuotaWindow; now: number; muted: boolean }) {
  const left = remainingPercent(window.used_percent)
  const pending = resetPending(window, now)
  const tone = ringTone(left, muted || pending)
  return (
    <div className="acct-window">
      <span className="acct-window-label">{window.label}</span>
      <span className="acct-window-value">
        <ProgressRing fraction={left === null ? null : left / 100} tone={tone} size={16} />
        <strong className={tone === 'red' ? 'tone-red' : undefined}>{left === null ? 'Not reported' : `${percentLabel(left)} left`}</strong>
        <span className="acct-window-meta" title={window.resets_at ? new Date(window.resets_at).toLocaleString() : undefined}>
          {pending ? 'reset pending' : resetCountdown(window.resets_at, now).replace('Resets in ', '')}
        </span>
      </span>
    </div>
  )
}

function Allowances({ account, now, offline }: { account: AccountUsage; now: number; offline: boolean }) {
  const stale = offline || account.status === 'stale'
  const proxy = account.source === 'proxy'
  return (
    <div className={`acct-allowances${stale ? ' is-stale' : ''}`}>
      {(proxy || stale) && (
        <div className="acct-source">
          {proxy && <span>CLIProxyAPI{account.account_label ? ` · ${account.account_label}` : ''}</span>}
          {stale && <span className="acct-source-flag">out of date</span>}
        </div>
      )}
      {account.message && <p className="acct-note">{account.message}</p>}
      {account.windows.map((w) => <WindowRow key={w.id} window={w} now={now} muted={stale} />)}
      {account.status === 'ok' && account.windows.length === 0 && <p className="acct-note">No allowance windows reported.</p>}
    </div>
  )
}

function SubscriptionRow({ provider, auth, tracked, local, busy, now, usage, offline, onSignIn, onSignOut, onCancel, onPaste }: {
  provider: (typeof SUBSCRIPTIONS)[number]; auth: AuthProvider | null; tracked: Tracked | null; local: boolean
  busy: boolean; now: number; usage: AccountUsage[]; offline: boolean
  onSignIn: () => void; onSignOut: () => void; onCancel: () => void; onPaste: (input: string) => Promise<void>
}) {
  const [pasted, setPasted] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const session = tracked?.session ?? null
  const inFlight = session !== null && (session.state === 'waiting' || session.state === 'exchanging')
  const status = auth?.status ?? 'signed_out'
  const pill: { tone: Tone; text: string } = inFlight ? { tone: 'accent', text: 'Signing in' }
    : status === 'ready' ? { tone: 'green', text: 'Signed in' }
    : status === 'refresh_needed' ? { tone: 'neutral', text: 'Refreshing' }
    : status === 'login_required' ? { tone: 'red', text: 'Sign in again' }
    : { tone: 'orange', text: 'Not signed in' }
  return (
    <Row mark={<Mark logo={provider.logo} />} name={provider.label}
      sub={<span>{auth?.account_label ?? (status === 'signed_out' ? 'Sign in with the browser' : 'Signed in')}</span>}
      pill={<StatusPill tone={pill.tone}>{pill.text}</StatusPill>}
      actions={inFlight
        ? <>
          {session.state === 'waiting' && <a className="acct-btn" href={session.url} target="_blank" rel="noopener noreferrer">Open page</a>}
          <button className="acct-btn" onClick={onCancel} disabled={busy}>Cancel</button>
        </>
        : <>
          {status !== 'signed_out' && <button className="acct-btn" onClick={onSignOut} disabled={busy || !local}>Sign out</button>}
          {(status === 'signed_out' || status === 'login_required') && (
            <button className="acct-btn ink" onClick={onSignIn} disabled={busy || !local} data-testid={`sign-in-${provider.id}`}>{status === 'signed_out' ? 'Sign in' : 'Sign in again'}</button>
          )}
        </>}>
      {session && session.state !== 'cancelled' && (
        <div className={`acct-flow${session.state === 'failed' ? ' is-failed' : ''}`} role="status">
          <p>{loginHint(session)}</p>
          {tracked && showPasteBox(session, tracked.startedAt, now) && (
            <form className="acct-inline-form" onSubmit={(event) => {
              event.preventDefault()
              setPasteError(null)
              void onPaste(pasted).then(() => setPasted(''), (error) => setPasteError(errorText(error)))
            }}>
              <input value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder="Paste the final redirect URL"
                aria-label={`${provider.label} redirect URL`} spellCheck={false} autoComplete="off" />
              <button type="submit" className="acct-btn ink" disabled={!pasted.trim() || busy}>Finish</button>
            </form>
          )}
          {pasteError && <p className="tone-red">{pasteError}</p>}
        </div>
      )}
      {usage.map((account) => <Allowances key={account.id} account={account} now={now} offline={offline} />)}
    </Row>
  )
}

function KeyProviderRow({ row, local, busy, onSave, onForget }: {
  row: KeyRow; local: boolean; busy: boolean; onSave: (key: string) => Promise<void>; onForget: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mark = KEY_MARKS[row.provider] ?? { mono: monogram(row.label) }
  const pill: { tone: Tone; text: string } = row.source === 'stored' ? { tone: 'green', text: 'Saved' }
    : row.source === 'env' ? { tone: 'neutral', text: 'Environment' }
    : { tone: 'orange', text: 'No key' }
  const close = () => { setEditing(false); setDraft(''); setError(null) }
  return (
    <Row mark={<Mark logo={mark.logo} mono={mark.mono} ink={mark.ink} />} name={row.label}
      sub={<>
        <span>{row.unlocks}</span>
        {row.hint && <span className="acct-key-hint"><code>{row.hint}</code>{row.source === 'env' ? ` from ${row.env}` : ' saved here'}</span>}
      </>}
      pill={<StatusPill tone={pill.tone}>{pill.text}</StatusPill>}
      actions={editing ? null : <>
        {row.source === 'stored' && <button className="acct-btn" onClick={onForget} disabled={busy || !local}>Remove</button>}
        <button className={`acct-btn${row.source ? '' : ' ink'}`} onClick={() => setEditing(true)} disabled={busy || !local} data-testid={`add-key-${row.provider}`}>
          {row.source === 'stored' ? 'Replace' : 'Add key'}
        </button>
      </>}>
      {editing && (
        <form className="acct-key-form" onSubmit={(event) => {
          event.preventDefault()
          setError(null)
          void onSave(draft).then(close, (failure) => setError(errorText(failure)))
        }}>
          <div className="acct-inline-form">
            <input type="password" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={`Paste your ${row.label} key`}
              aria-label={`${row.label} API key`} autoComplete="off" spellCheck={false} autoFocus data-testid={`key-input-${row.provider}`} />
            <button type="submit" className="acct-btn ink" disabled={!draft.trim() || busy} data-testid={`save-key-${row.provider}`}>Save</button>
            <button type="button" className="acct-btn" onClick={close} disabled={busy}>Cancel</button>
          </div>
          <p className="acct-note">
            {draft.trim() ? <>Will be kept as <code>{maskKey(draft.trim())}</code> in this Mac's oasis-code store (<code>{row.env}</code>) and never shown again.</>
              : <>Kept in this Mac's oasis-code store under <code>{row.env}</code>; only its last characters are ever shown.{row.docs && <> <a href={row.docs} target="_blank" rel="noopener noreferrer">Where to get one</a></>}</>}
          </p>
          {error && <p className="acct-note tone-red">{error}</p>}
        </form>
      )}
    </Row>
  )
}

function AddProviderForm({ busy, onSave, onClose }: {
  busy: boolean; onSave: (id: string, key: string, custom: { label: string; env: string }) => Promise<void>; onClose: () => void
}) {
  const [label, setLabel] = useState('')
  const [env, setEnv] = useState('')
  const [envTouched, setEnvTouched] = useState(false)
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const id = customProviderId(label)
  const envName = envTouched ? env : suggestEnvName(label)
  return (
    <form className="acct-key-form acct-add-form" onSubmit={(event) => {
      event.preventDefault()
      setError(null)
      void onSave(id, key, { label: label.trim(), env: envName }).then(onClose, (failure) => setError(errorText(failure)))
    }}>
      <div className="acct-inline-form">
        <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Service name, e.g. OpenRouter" aria-label="Provider name" autoFocus />
        <input value={envName} onChange={(event) => { setEnvTouched(true); setEnv(event.target.value.toUpperCase()) }} placeholder="ENV_NAME" aria-label="Environment variable name" spellCheck={false} />
      </div>
      <div className="acct-inline-form">
        <input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder="Paste the key" aria-label="API key" autoComplete="off" spellCheck={false} />
        <button type="submit" className="acct-btn ink" disabled={!id || !envName || !key.trim() || busy}>Add</button>
        <button type="button" className="acct-btn" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
      <p className="acct-note">
        Saved as <code>{id || '…'}</code>; the backend exports it as <code>{envName || '…'}</code>, so a model route with <code>api_key_env</code> set to that name reads it.
        {key.trim() && <> Kept as <code>{maskKey(key.trim())}</code>.</>}
      </p>
      {error && <p className="acct-note tone-red">{error}</p>}
    </form>
  )
}

function useAccounts(onSettled: (kind: 'auth' | 'key') => void) {
  const [accounts, setAccounts] = useState<AuthAccounts | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [tracked, setTracked] = useState<Partial<Record<AuthProviderId, Tracked>>>({})
  const alive = useRef(true)
  const settled = useRef(onSettled)
  useEffect(() => { settled.current = onSettled }, [onSettled])

  const load = useCallback(async () => {
    try {
      const data = await api.getAuthAccounts(AbortSignal.timeout(15_000))
      if (!alive.current) return
      setAccounts(data)
      setError(null)
      setTracked((current) => {
        const missing = data.providers.filter((provider) => provider.login && !current[provider.provider])
        if (missing.length === 0) return current
        const next = { ...current }
        for (const provider of missing) next[provider.provider] = { session: provider.login!, startedAt: Date.now() }
        return next
      })
    } catch (failure) {
      if (alive.current) setError(errorText(failure))
    }
  }, [])

  useEffect(() => {
    alive.current = true
    const initial = window.setTimeout(() => void load(), 0)
    return () => { alive.current = false; window.clearTimeout(initial) }
  }, [load])

  const track = useCallback((provider: AuthProviderId, session: LoginSession | null, startedAt?: number) => {
    setTracked((current) => {
      const next = { ...current }
      if (session) next[provider] = { session, startedAt: startedAt ?? current[provider]?.startedAt ?? Date.now() }
      else delete next[provider]
      return next
    })
  }, [])

  useEffect(() => {
    const timers: number[] = []
    for (const entry of Object.values(tracked)) {
      if (!entry) continue
      const delay = pollDelay(entry.session)
      if (delay === null) continue
      timers.push(window.setTimeout(() => {
        void api.getLogin(entry.session.id, AbortSignal.timeout(10_000)).then((session) => {
          if (!alive.current) return
          track(session.provider, session)
          if (session.state === 'done') { void load(); settled.current('auth') }
        }, () => { /* the next poll retries */ })
      }, delay))
    }
    return () => { for (const timer of timers) window.clearTimeout(timer) }
  }, [tracked, track, load])

  const act = async (who: string, work: () => Promise<void>) => {
    setBusy(who)
    setError(null)
    try { await work() } catch (failure) { setError(errorText(failure)) } finally { if (alive.current) setBusy(null) }
  }

  return {
    accounts, error, busy, tracked,
    signIn: (provider: AuthProviderId) => act(provider, async () => {
      const session = await api.startLogin(provider)
      track(provider, session, Date.now())
      window.open(session.url, '_blank', 'noopener')
    }),
    signOut: (provider: AuthProviderId) => act(provider, async () => {
      await api.logout(provider)
      track(provider, null)
      await load()
      settled.current('auth')
    }),
    cancel: (provider: AuthProviderId) => act(provider, async () => {
      const entry = tracked[provider]
      if (entry) track(provider, await api.cancelLogin(entry.session.id))
    }),
    paste: async (provider: AuthProviderId, input: string) => {
      const entry = tracked[provider]
      if (entry) track(provider, await api.submitLoginCode(entry.session.id, input))
    },
    saveKey: async (provider: KeyProviderId, key: string, custom?: { label: string; env: string }) => {
      setBusy(provider)
      try {
        await api.saveApiKey(provider, key, custom)
        await load()
        settled.current('key')
      } finally { if (alive.current) setBusy(null) }
    },
    forgetKey: (provider: KeyProviderId) => act(provider, async () => {
      await api.forgetApiKey(provider)
      await load()
      settled.current('key')
    }),
  }
}

function useUsage() {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now)
  const clockOffset = useRef(0)
  const pending = useRef<AbortController | null>(null)

  const load = useCallback(async (force = false) => {
    if (pending.current || document.hidden) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    try {
      const data = await api.getAccountUsage(force, AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]))
      if (controller.signal.aborted) return
      clockOffset.current = Date.parse(data.server_time) - Date.now()
      setNow(Date.now() + clockOffset.current)
      setSnapshot(data)
      setError(false)
    } catch {
      if (!controller.signal.aborted) setError(true)
    } finally {
      if (pending.current === controller) {
        pending.current = null
        if (!controller.signal.aborted) setBusy(false)
      }
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 60_000)
    const resume = () => { if (!document.hidden) void load() }
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', resume)
      pending.current?.abort()
      pending.current = null
    }
  }, [load])

  const tick = useCallback(() => setNow(Date.now() + clockOffset.current), [])
  return { snapshot, error, busy, now, load, tick }
}

function ThemeChoice() {
  const theme = appTheme()
  const preference = useSyncExternalStore(theme.subscribe, theme.preference, theme.preference)
  return (
    <section className="acct-card settings-card" aria-labelledby="settings-theme-label">
      <div className="settings-row">
        <strong id="settings-theme-label">Theme</strong>
        <div className="seg settings-seg" role="radiogroup" aria-labelledby="settings-theme-label" data-testid="theme-choice">
          {THEME_PREFERENCES.map((p) => (
            <label key={p} className={preference === p ? 'on' : undefined}>
              <input type="radio" name="settings-theme" value={p} checked={preference === p} onChange={() => theme.set(p)} data-testid={`theme-${p}`} />
              {THEME_LABELS[p]}
            </label>
          ))}
        </div>
      </div>
    </section>
  )
}

const SEARCH_ROWS: { id: WebSearchEngine; mark: ReactNode; sub: string }[] = [
  { id: 'automatic', mark: <Mark icon={<SparklesIcon size={16} />} />, sub: "Claude and Codex use their own search, DeepSeek models DeepSeek; other models use Web" },
  { id: 'web', mark: <Mark icon={<GlobeIcon size={16} />} />, sub: 'DuckDuckGo, Brave or Bing result pages · no key' },
  { id: 'deepseek', mark: <Mark logo={deepseekLogo} />, sub: 'DeepSeek Search API · $0.75 per 1,000 searches' },
]

/** The engine the web_search tool uses, picked like a theme: a row's Use saves it at once. DeepSeek needs the key
 *  Accounts keeps; without one its row asks for it first and is used once it is saved. */
export function WebSearchCard({ local, keyRow, busy, onSaveKey }: {
  local: boolean; keyRow: KeyRow | null; busy: boolean; onSaveKey: (key: string) => Promise<void>
}) {
  const [engine, setEngine] = useState<WebSearchEngine | null>(null)
  const [saving, setSaving] = useState<WebSearchEngine | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [draft, setDraft] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    api.getWebSearch(controller.signal).then((value) => setEngine(value.engine), () => {
      if (!controller.signal.aborted) setError('Could not load Web Search settings')
    })
    return () => controller.abort()
  }, [])
  const hasKey = !!keyRow?.source
  const use = async (id: WebSearchEngine) => {
    setSaving(id); setError(null)
    try { setEngine((await api.saveWebSearch({ engine: id })).engine) } catch { setError('Could not save Web Search settings') } finally { setSaving(null) }
  }
  const closeKey = () => { setAsking(false); setDraft('') }
  const disabled = !local || engine === null || saving !== null || busy
  return (
    <section className="acct-card" aria-label="Search engine" data-testid="web-search-engines">
      <div className="acct-section-head"><strong>Search engine</strong><span>The web_search tool</span></div>
      {SEARCH_ROWS.map((row) => {
        const on = engine === row.id
        const needsKey = row.id === 'deepseek' && !hasKey
        return (
          <Row key={row.id} mark={row.mark} name={WEB_SEARCH_LABELS[row.id]} sub={<span>{row.sub}</span>}
            pill={on ? <StatusPill tone="green">In use</StatusPill> : needsKey ? <StatusPill tone="orange">No key</StatusPill> : null}
            actions={on || (needsKey && asking) ? null : needsKey
              ? <button className="acct-btn ink" onClick={() => setAsking(true)} disabled={disabled} data-testid="web-search-add-key">Add key</button>
              : <button className="acct-btn" onClick={() => void use(row.id)} disabled={disabled} data-testid={`web-search-use-${row.id}`}>{saving === row.id ? 'Saving…' : 'Use'}</button>}>
            {needsKey && asking && (
              <form className="acct-key-form" onSubmit={(event) => {
                event.preventDefault()
                setError(null)
                void onSaveKey(draft.trim()).then(() => { closeKey(); return use('deepseek') }, (failure) => setError(errorText(failure)))
              }}>
                <div className="acct-inline-form">
                  <input type="password" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Paste your DeepSeek key"
                    aria-label="DeepSeek API key" autoComplete="off" spellCheck={false} autoFocus data-testid="web-search-key" />
                  <button type="submit" className="acct-btn ink" disabled={!draft.trim() || busy}>Save</button>
                  <button type="button" className="acct-btn" onClick={closeKey} disabled={busy}>Cancel</button>
                </div>
              </form>
            )}
          </Row>
        )
      })}
      {error && <p className="acct-note tone-red" role="alert">{error}</p>}
    </section>
  )
}

function SettingsDialog({ usage, close, showProxy, setShowProxy }: {
  usage: ReturnType<typeof useUsage>; close: () => void; showProxy: boolean; setShowProxy: (value: boolean) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const { load, tick } = usage
  const loadModels = useStore((s) => s.loadModels)
  const wanted = useStore((s) => s.settingsTab)
  const setTab = useStore((s) => s.setSettingsTab)
  const settled = useCallback((kind: 'auth' | 'key') => { if (kind === 'auth') void load(true); void loadModels() }, [load, loadModels])
  const accounts = useAccounts(settled)
  const hidden = usage.snapshot ? hiddenProxyCount(usage.snapshot.accounts) : 0
  const [adding, setAdding] = useState(false)
  // Connections holds Live sharing (every page) and Remote access (the desktop shell only)
  const remote = remoteAccess(window as { oasisCodeDesktop?: unknown }) !== null
  const tabs = visibleSettingsTabs({ connections: true })
  const tab = shownSettingsTab(tabs, wanted)
  const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({})

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [tick])

  const onTabKey = (event: React.KeyboardEvent) => {
    const next = settingsTabForKey(tabs, tab, event.key)
    if (!next) return
    event.preventDefault()
    setTab(next)
    tabRefs.current[next]?.focus()
  }

  const local = accounts.accounts?.local ?? true
  const visible = visibleAccounts(usage.snapshot?.accounts ?? [], showProxy)
  // every panel stays mounted (hidden when not shown): a sign-in in flight, its polling, a half-typed key and Remote
  // access's own state live on across a change of tab
  return (
    <dialog ref={dialog} className="acct-dialog settings-dialog" aria-labelledby="settings-title" data-testid="settings-dialog"
      onCancel={(event) => { event.preventDefault(); close() }} onClose={close}
      onClick={(event) => {
        if (event.target !== dialog.current) return
        const rect = dialog.current.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close()
      }}>
      <header className="acct-head settings-head">
        <h2 id="settings-title" className="settings-title">Settings</h2>
        <div className="settings-tabs" role="tablist" aria-label="Settings" onKeyDown={onTabKey}>
          {tabs.map((t) => (
            <button key={t} ref={(el) => { tabRefs.current[t] = el }} type="button" role="tab" id={`settings-tab-${t}`} aria-controls={`settings-panel-${t}`}
              aria-selected={tab === t} tabIndex={tab === t ? 0 : -1} className={tab === t ? 'on' : undefined}
              onClick={() => setTab(t)} data-testid={`settings-tab-${t}`}>{SETTINGS_TAB_LABELS[t]}</button>
          ))}
        </div>
        <button className="icon-btn settings-close" aria-label="Close" onClick={close}><XIcon size={16} /></button>
      </header>
      <div className="acct-body" role="tabpanel" id="settings-panel-accounts" aria-labelledby="settings-tab-accounts" hidden={tab !== 'accounts'} aria-busy={usage.busy} data-testid="settings-panel-accounts">
        {!local && <p className="acct-banner">Signing in and saving keys work only from the machine that runs the backend.</p>}
        {accounts.error && <p className="acct-banner is-error" role="alert">{accounts.error}</p>}
        {usage.error && <p className="acct-banner is-error" role="status">Could not refresh allowances.{usage.snapshot ? ' Showing the last check.' : ''}</p>}
        <section className="acct-card" aria-label="Subscriptions">
          <div className="acct-section-head"><strong>Subscriptions</strong><span>Signed in with the browser · routes with auth: oauth</span></div>
          {accounts.accounts
            ? SUBSCRIPTIONS.map((provider) => (
              <SubscriptionRow key={provider.id} provider={provider}
                auth={accounts.accounts?.providers.find((p) => p.provider === provider.id) ?? null}
                tracked={accounts.tracked[provider.id] ?? null} local={local} busy={accounts.busy === provider.id} now={usage.now}
                usage={visible.filter((a) => a.provider === provider.id)} offline={usage.error}
                onSignIn={() => void accounts.signIn(provider.id)} onSignOut={() => void accounts.signOut(provider.id)}
                onCancel={() => void accounts.cancel(provider.id)} onPaste={(input) => accounts.paste(provider.id, input)} />
            ))
            : <p className="acct-note">Checking sign-ins…</p>}
        </section>
        <section className="acct-card" aria-label="API keys">
          <div className="acct-section-head"><strong>API keys</strong><span>Pay as you go · routes with auth: api_key</span></div>
          {accounts.accounts
            ? accounts.accounts.keys.map((row) => (
              <KeyProviderRow key={row.provider} row={row} local={local} busy={accounts.busy === row.provider}
                onSave={(key) => accounts.saveKey(row.provider, key)} onForget={() => void accounts.forgetKey(row.provider)} />
            ))
            : <p className="acct-note">Checking keys…</p>}
          <div className="acct-card-foot">
            {adding
              ? <AddProviderForm busy={accounts.busy !== null} onClose={() => setAdding(false)} onSave={(id, key, custom) => accounts.saveKey(id, key, custom)} />
              : <button className="acct-btn quiet" onClick={() => setAdding(true)} disabled={!local || !accounts.accounts}>+ Add a provider</button>}
          </div>
        </section>
      </div>
      <div className="acct-body" role="tabpanel" id="settings-panel-appearance" aria-labelledby="settings-tab-appearance" hidden={tab !== 'appearance'} data-testid="settings-panel-appearance">
        <ThemeChoice />
      </div>
      <div className="acct-body" role="tabpanel" id="settings-panel-web-search" aria-labelledby="settings-tab-web-search" hidden={tab !== 'web-search'} data-testid="settings-panel-web-search">
        <WebSearchCard local={local && !!accounts.accounts} keyRow={accounts.accounts?.keys.find((row) => row.provider === 'deepseek') ?? null}
          busy={accounts.busy === 'deepseek'} onSaveKey={(key) => accounts.saveKey('deepseek', key)} />
      </div>
      {tabs.includes('connections') && (
        <div className="acct-body" role="tabpanel" id="settings-panel-connections" aria-labelledby="settings-tab-connections" hidden={tab !== 'connections'} data-testid="settings-panel-connections">
          {remote && <RemoteAccessCard />}
          <LiveShareCard shown={tab === 'connections'} />
        </div>
      )}
      {tab === 'accounts' && (
        <footer className="acct-foot">
          <span className="acct-foot-note">Codex checked every minute, Claude every five</span>
          <span className="acct-foot-actions">
            {(hidden > 0 || showProxy) && (
              <button className="acct-btn quiet" onClick={() => setShowProxy(!showProxy)} aria-pressed={showProxy}>
                {showProxy ? 'Hide CLIProxyAPI' : `Show CLIProxyAPI (${hidden})`}
              </button>
            )}
            <button className="acct-btn" disabled={usage.busy} onClick={() => void load(true)}><RefreshIcon size={12} />{usage.busy ? 'Checking…' : 'Refresh'}</button>
          </span>
        </footer>
      )}
    </dialog>
  )
}

/** The rail's footer: Settings, with each account's tightest allowance at a glance. */
export function AccountsPanel() {
  const usage = useUsage()
  const open = useStore((s) => s.settingsOpen)
  const setOpen = useStore((s) => s.setSettingsOpen)
  const [showProxy, setShowProxyState] = useState(readShowProxy)
  const setShowProxy = useCallback((value: boolean) => { writeShowProxy(value); setShowProxyState(value) }, [])
  const launcher = useRef<HTMLButtonElement>(null)
  // the focus goes back to the launcher once the modal dialog is gone (while it is open the rest of the page is inert,
  // so a focus() made in the same tick is refused)
  const close = useCallback(() => { setOpen(false); window.setTimeout(() => launcher.current?.focus(), 0) }, [setOpen])
  const rows = usage.snapshot ? railAccounts(usage.snapshot.accounts, showProxy) : []
  const attention = rows.some((a) => a.status === 'login_required')
  return (
    <div className="acct-footer">
      <button ref={launcher} className="acct-launcher" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label="Settings" title="Settings" data-testid="settings">
        <span className="acct-launcher-head">
          <SettingsIcon size={14} />
          <span>Settings</span>
          <i className={`acct-dot tone-${usage.error ? 'neutral' : attention ? 'orange' : usage.snapshot ? 'green' : 'neutral'}`} />
        </span>
        {usage.snapshot
          ? <span className="acct-launcher-rows">{rows.map((account) => {
            const values = account.windows.map((w) => remainingPercent(w.used_percent)).filter((n): n is number => n !== null)
            const left = values.length ? Math.min(...values) : null
            const summary = usage.error ? 'Out of date' : quotaSummary(account, usage.now)
            return (
              <span className="acct-launcher-row" key={account.id} title={`${account.label}${account.source === 'proxy' ? ' (proxy)' : ''}: ${summary}`}>
                <span className="acct-launcher-name"><img src={LOGO[account.provider]} alt="" /><span className="acct-launcher-label">{account.label}</span>{account.source === 'proxy' && <em>proxy</em>}
                  <span className="acct-launcher-value">{summary.replace(/ left$/, '')}</span></span>
                <span className={`acct-mini tone-${ringTone(left, usage.error || account.status !== 'ok')}`}><i style={{ width: `${left ?? 0}%` }} /></span>
              </span>
            )
          })}</span>
          : <span className="acct-launcher-hint">{usage.error ? 'Unable to load' : 'Checking allowances…'}</span>}
      </button>
      {open && <SettingsDialog usage={usage} close={close} showProxy={showProxy} setShowProxy={setShowProxy} />}
    </div>
  )
}
