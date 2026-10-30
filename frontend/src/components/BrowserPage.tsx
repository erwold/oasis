import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { browserControls, type BrowserControlResult, browserDataClearer, browserInputOf, browserLine, browserModifiers, browserPoint, browserWheel, browserStatusOf, CLEAR_BROWSER_DATA_CONFIRM, clearBrowserDataOffer, pickedLine, standInImage, surfaceFrames, tabOwnerBadge, type BrowserInput, type BrowserStatus, type ChatGptPlace, type SurfaceFrame } from '../state/desktop'
import { useStore } from '../state/store'
import { ChevronLeftIcon, ChevronRightIcon, PickIcon, PlusIcon, RefreshIcon, XIcon } from './icons'
import { useBrowserPlacement } from './useBrowserPlacement'

/** One capture at a time, followed by this interval. The page stays at its fixed desktop size backstage. */
const CARD_FRAME_EVERY_MS = 80
/** How often the card reads what the browser shows (its address, its tabs, the run acting on it). */
const STATUS_EVERY_MS = 1000

/** The agent's browser as the shell reports it: one reader for the whole card (its bar, its line, its buttons), read
 *  while anything shows it and again at once after the person's own controls. */
let status: BrowserStatus | null = null
const statusListeners = new Set<() => void>()
let statusTimer = 0
function setStatus(next: BrowserStatus | null): void { status = next; statusListeners.forEach((l) => l()) }
/** Reads in order: a read asked before a newer one was published, or before (or while) one of the person's own
 *  controls went to the shell, says what was shown before it and is dropped — a slow read never takes the card back
 *  to the tab shown before the person's switch. Only the person's controls count: an agent's navigating changes the
 *  status, which the next read brings. */
let asked = 0
let publishedAt = 0
let controlEpoch = 0
let controlsGoing = 0
function publish(next: BrowserStatus | null): void { publishedAt = ++asked; setStatus(next) }
function readStatus(): void {
  const read = browserStatusOf(window as { oasisCodeDesktop?: unknown })
  if (!read) return
  const seq = ++asked, epoch = controlEpoch
  void read().then((s) => {
    if (seq < publishedAt || epoch !== controlEpoch || controlsGoing > 0) return
    publishedAt = seq
    setStatus(s)
  }, () => undefined)
}
/** One of the person's controls of the card: what it answers is the browser after it (else it is read again). */
function personControl<T extends BrowserControlResult | null>(going: Promise<T>): Promise<T | null> {
  controlsGoing += 1; controlEpoch += 1
  const settle = (out: T | null) => {
    controlsGoing -= 1; controlEpoch += 1
    if (out?.status) publish(out.status); else readStatus()
    return out
  }
  return going.then(settle, () => settle(null))
}
function subscribeStatus(listener: () => void): () => void {
  statusListeners.add(listener)
  if (statusListeners.size === 1) { readStatus(); statusTimer = window.setInterval(readStatus, STATUS_EVERY_MS) }
  return () => { statusListeners.delete(listener); if (!statusListeners.size) window.clearInterval(statusTimer) }
}
const useBrowserStatus = (): BrowserStatus | null => useSyncExternalStore(subscribeStatus, () => status, () => null)

/** The card displays the same fixed desktop page the agent sees. Its image is fitted into the card; input is
 *  mapped back to page coordinates. Moving, covering or resizing the card never changes the page's viewport. */
export function BrowserPage({ place }: { place: (p: ChatGptPlace) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const picture = useRef<HTMLImageElement>(null)
  const keyboard = useRef<HTMLTextAreaElement>(null)
  const composing = useRef<{ page?: string | null } | null>(null)
  const pressed = useRef<{ pointer: number; button: 'left' | 'middle' | 'right'; clicks: number; page?: string | null } | null>(null)
  const lastClick = useRef<{ at: number; x: number; y: number; button: string; clicks: number; page?: string | null } | null>(null)
  const { shown, frame: fitted } = useBrowserPlacement(ref, place)
  const current = useBrowserStatus()
  const page = current?.shown_page ?? null
  const frame = useLiveFrame(shown, page, current?.active_tab ?? null)
  const image = standInImage(frame, page)
  const input = browserInputOf(window as { oasisCodeDesktop?: unknown })
  const send = (event: BrowserInput) => { if (image && input) void input({ page: frame?.page, ...event }).catch(() => undefined) }
  const latest = useRef({ image, send })
  latest.current = { image, send }
  const point = (e: { clientX: number; clientY: number }, dragging = false) => {
    const rect = picture.current?.getBoundingClientRect()
    return image && rect ? browserPoint(rect, e.clientX, e.clientY, dragging) : null
  }
  const pointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const at = point(e)
    if (!at || e.button < 0 || e.button > 2) return
    e.preventDefault()
    keyboard.current?.focus({ preventScroll: true })
    const button = e.button === 1 ? 'middle' : e.button === 2 ? 'right' : 'left'
    // Chromium pointer events have detail=0 even for a double click. Keep the click sequence in display pixels.
    const previous = lastClick.current
    const repeated = previous && previous.button === button && previous.page === frame?.page && e.timeStamp - previous.at >= 0
      && e.timeStamp - previous.at <= 500 && Math.abs(e.clientX - previous.x) <= 4 && Math.abs(e.clientY - previous.y) <= 4
    const clicks = Math.min(3, e.detail || (repeated ? previous.clicks + 1 : 1))
    lastClick.current = { at: e.timeStamp, x: e.clientX, y: e.clientY, button, clicks, page: frame?.page }
    pressed.current = { pointer: e.pointerId, button, clicks, page: frame?.page }
    e.currentTarget.setPointerCapture(e.pointerId)
    send({ type: 'mouseDown', ...at, button, clickCount: clicks, buttons: e.buttons, modifiers: browserModifiers(e) })
  }
  const pointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const held = pressed.current
    if (!held || held.pointer !== e.pointerId) return
    const at = point(e, true)
    if (at) send({ type: 'mouseUp', ...at, button: held.button, clickCount: held.clicks, buttons: e.buttons, modifiers: browserModifiers(e), page: held.page })
    pressed.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const key = (e: KeyboardEvent<HTMLTextAreaElement>, type: 'keyDown' | 'keyUp') => {
    if (composing.current || e.nativeEvent.isComposing || e.key === 'Process' || e.key === 'Unidentified' || e.key === 'Dead') return
    // Paste belongs to the input event below, where the actual clipboard text is available.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') return
    send({ type, keyCode: e.key, code: e.code, isAutoRepeat: e.repeat, location: e.location, modifiers: browserModifiers(e) })
    // Ordinary text goes through the textarea's input/IME path once. Navigation/editing keys act on the page.
    if (type === 'keyDown' && !(e.key.length === 1 && !e.metaKey && (!e.ctrlKey || e.getModifierState('AltGraph')))) e.preventDefault()
  }
  const text = (value: string) => { if (value) send({ type: 'text', text: value }) }
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // React delegates wheel listeners as passive; this listener keeps the host conversation from scrolling.
    const wheel = (e: WheelEvent) => {
      const rect = picture.current?.getBoundingClientRect()
      const at = latest.current.image && rect ? browserPoint(rect, e.clientX, e.clientY) : null
      if (!at) return
      e.preventDefault()
      latest.current.send({ type: 'mouseWheel', ...at, ...browserWheel(e.deltaX, e.deltaY, e.deltaMode), modifiers: browserModifiers(e) })
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])
  return (
    <div className="browser-pane">
      <BrowserBar />
      <div ref={ref} className="chatgpt-page browser-native" data-testid="browser-page" data-shown={shown ? 'yes' : 'no'}
           tabIndex={0} role="application" aria-label="Browser page" onFocus={(e) => { if (e.target === e.currentTarget) keyboard.current?.focus({ preventScroll: true }) }}
           onPointerDown={pointerDown} onPointerUp={pointerUp} onPointerCancel={pointerUp}
           onPointerMove={(e) => { const at = point(e, !!pressed.current); if (at) send({ type: 'mouseMove', ...at, buttons: e.buttons, ...(pressed.current ? { button: pressed.current.button, page: pressed.current.page } : {}), modifiers: browserModifiers(e) }) }}
           onContextMenu={(e) => e.preventDefault()}>
        {image && <img ref={picture} className="browser-stand-in" src={`data:${image.media_type};base64,${image.data_base64}`} width={image.width} height={image.height}
                      style={{ width: fitted.width, height: fitted.height }} alt="" draggable={false} />}
        <textarea ref={keyboard} className="browser-input-capture" data-testid="browser-input" aria-label="Browser page keyboard" tabIndex={-1} spellCheck={false} autoComplete="off" autoCapitalize="off"
                  onKeyDown={(e) => key(e, 'keyDown')} onKeyUp={(e) => key(e, 'keyUp')}
                  onCompositionStart={() => { composing.current = { page: frame?.page } }}
                  onCompositionEnd={(e) => { const started = composing.current; composing.current = null; const value = e.currentTarget.value || e.data; if (value) send({ type: 'text', text: value, page: started?.page }); e.currentTarget.value = '' }}
                  onInput={(e) => { if (!composing.current && !(e.nativeEvent as InputEvent).isComposing) { text(e.currentTarget.value); e.currentTarget.value = '' } }}
                  onPaste={(e) => { e.preventDefault(); text(e.clipboardData.getData('text/plain')); e.currentTarget.value = '' }} />
      </div>
    </div>
  )
}

/** The visible card receives complete frames of the same page; each read finishes before the next begins.
 *  A tab change drops its previous picture, including a read that completes after the tab changed. */
function useLiveFrame(wanted: boolean, page: string | null, tab: string | null): SurfaceFrame | null {
  const [frame, setFrame] = useState<SurfaceFrame | null>(null)
  // a picture that names its tab is of that tab only (another run's tab is never drawn as the one the person shows)
  const ours = (f: SurfaceFrame) => (!page || f.page === page) && (!tab || !f.tab_id || f.tab_id === tab)
  useEffect(() => { setFrame((f) => (f && !ours(f) ? null : f)) }, [page, tab])
  useEffect(() => {
    if (!wanted) return
    const read = surfaceFrames(window as { oasisCodeDesktop?: unknown })
    if (!read) return
    let alive = true
    let timer = 0
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try { const next = await read('browser'); if (alive && next?.image && ours(next)) setFrame(next) } catch { /* the shell is restarting: the next one */ }
      }
      if (alive) timer = window.setTimeout(() => void tick(), CARD_FRAME_EVERY_MS)
    }
    void tick()
    return () => { alive = false; window.clearTimeout(timer) }
  }, [wanted, page, tab])
  return frame
}

const siteOf = (url: string): string => { try { return /^https?:/.test(url) ? new URL(url).host : '' } catch { return '' } }

/** The tabs and the address bar of the agent's browser: the person's own controls. A tab an agent's run has carries
 *  that agent's badge (a dot while the run holds it); showing another tab never moves a run off its own. */
function BrowserBar() {
  const controls = browserControls(window as { oasisCodeDesktop?: unknown })
  const s = useBrowserStatus()
  const sessionId = useStore((st) => st.session?.id ?? null)
  const appendDraft = useStore((st) => st.appendDraft)
  const [typed, setTyped] = useState<string | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  // a pick under way ends with the card (put away, another session shown): what comes after goes nowhere
  const pickFor = useRef<string | null>(null)
  useEffect(() => {
    if (!picking) return
    return () => { pickFor.current = null; void browserControls(window as { oasisCodeDesktop?: unknown })?.cancelBrowserPick() }
  }, [picking, sessionId])
  // what was typed and not gone to belongs to the tab it was typed on: another tab shown shows its own address
  const activeTab = s?.active_tab ?? null
  useEffect(() => { setTyped(null); setRefused(null) }, [activeTab])
  if (!controls) return null
  const tabs = s?.tabs ?? []
  const go = (e: FormEvent) => {
    e.preventDefault()
    const url = (typed ?? s?.url ?? '').trim()
    if (!url) return
    void personControl(controls.browserNavigate({ action: 'go', url })).then((out) => {
      if (out?.ok) { setTyped(null); setRefused(null) } else setRefused(out?.reason ?? 'refused')
    })
  }
  // the picked element goes into the message of the session the pick began in — never another one's draft
  const pick = () => {
    if (picking) { void controls.cancelBrowserPick(); return }
    if (!sessionId) return
    const mine = sessionId
    pickFor.current = mine
    setPicking(true)
    void controls.pickBrowserElement().then((got) => {
      if (!got || pickFor.current !== mine) return
      appendDraft(mine, pickedLine(got))
    }, () => undefined).finally(() => { if (pickFor.current === mine) pickFor.current = null; setPicking(false) })
  }
  const address = typed ?? (s?.url && s.url !== 'about:blank' ? s.url : '')
  return (
    <div className="browser-bar" data-testid="browser-bar">
      <div className="browser-tabstrip">
      <div className="browser-tabs" role="tablist" data-testid="browser-tabs">
        {tabs.map((t) => {
          const badge = tabOwnerBadge(t)
          const name = t.title || siteOf(t.url) || 'New tab'
          return (
          <div key={t.id} className={`browser-tab${t.active ? ' on' : ''}`} data-testid="browser-tab" data-active={t.active ? 'yes' : 'no'} data-owner={badge?.run} title={t.url}>
            <button type="button" role="tab" aria-selected={t.active} className="browser-tab-name" aria-label={badge ? `${name} · ${badge.label}` : undefined} onClick={() => void personControl(controls.browserTab({ action: 'switch', id: t.id }))}>
              {badge && <span className="browser-tab-owner" data-testid="browser-tab-owner" data-live={badge.live ? 'yes' : 'no'} title={badge.title}><i aria-hidden /><span>{badge.label}</span></span>}
              <span className="browser-tab-title">{name}</span>
            </button>
            <button type="button" className="browser-tab-close" aria-label="Close tab" data-testid="browser-tab-close" onClick={() => void personControl(controls.browserTab({ action: 'close', id: t.id }))}><XIcon size={11} /></button>
          </div>
          )
        })}
      </div>
        <button type="button" className="icon-btn browser-new-tab" aria-label="New tab" title="New tab" data-testid="browser-new-tab" onClick={() => void personControl(controls.browserTab({ action: 'new' }))}><PlusIcon size={13} /></button>
      </div>
      <form className="browser-nav" onSubmit={go}>
        <button type="button" className="icon-btn" aria-label="Back" title="Back" data-testid="browser-back" disabled={!s?.can_go_back} onClick={() => void personControl(controls.browserNavigate({ action: 'back' }))}><ChevronLeftIcon size={14} /></button>
        <button type="button" className="icon-btn" aria-label="Forward" title="Forward" data-testid="browser-forward" disabled={!s?.can_go_forward} onClick={() => void personControl(controls.browserNavigate({ action: 'forward' }))}><ChevronRightIcon size={14} /></button>
        {s?.loading
          ? <button type="button" className="icon-btn" aria-label="Stop" title="Stop" data-testid="browser-stop" onClick={() => void personControl(controls.browserNavigate({ action: 'stop' }))}><XIcon size={13} /></button>
          : <button type="button" className="icon-btn" aria-label="Reload" title="Reload" data-testid="browser-reload" disabled={!s?.opened} onClick={() => void personControl(controls.browserNavigate({ action: 'reload' }))}><RefreshIcon size={13} /></button>}
        <input className="browser-address" data-testid="browser-address" aria-label="Address" spellCheck={false} autoComplete="off" value={address}
               aria-invalid={refused ? true : undefined} title={refused ?? undefined}
               onChange={(e) => { setTyped(e.target.value); setRefused(null) }} onFocus={(e) => e.currentTarget.select()} onBlur={() => { if (typed === (s?.url ?? '')) setTyped(null) }}
               onKeyDown={(e) => { if (e.key === 'Escape') { setTyped(null); setRefused(null); e.currentTarget.blur() } }} />
        <button type="button" className={`icon-btn${picking ? ' on' : ''}`} aria-label="Pick an element" aria-pressed={picking} title="Pick an element of the page for your message" data-testid="browser-pick" disabled={!s?.opened || !sessionId} onClick={pick}><PickIcon size={14} /></button>
      </form>
    </div>
  )
}

/** What the agent's browser shows, beside the card's title: an agent acting on it, else the page's site. */
export function BrowserMeta() {
  const s = useBrowserStatus()
  return <span className="desk-state" data-testid="browser-meta" title={s?.url ?? ''}>{browserLine(s)}</span>
}

/** The Browser card's "Clear data": the profile's cookies, site storage and cache, after the person confirms (it
 *  signs every project out); not while a run holds the browser. */
export function ClearBrowserDataButton() {
  const clear = browserDataClearer(window as { oasisCodeDesktop?: unknown })
  const s = useBrowserStatus()
  const showToast = useStore((st) => st.showToast)
  const [clearing, setClearing] = useState(false)
  if (!clear) return null
  const offer = clearBrowserDataOffer(s, clearing)
  const run = () => {
    if (!window.confirm(CLEAR_BROWSER_DATA_CONFIRM)) return
    setClearing(true)
    void clear().then((out) => {
      if (!out) showToast("The agent's browser is not available")
      else showToast(out.cleared ? "The agent's browser data was cleared" : `Not cleared: ${out.reason ?? 'refused'}`)
      readStatus()
    }, (error: unknown) => showToast(error instanceof Error ? error.message : String(error))).finally(() => setClearing(false))
  }
  return (
    <button type="button" className="icon-btn desk-text-btn" disabled={!offer.enabled} title={offer.title} data-testid="browser-clear-data" onClick={run}>
      Clear data
    </button>
  )
}
