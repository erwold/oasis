import type { FileRefAttachment } from '@oasis-code/contract'
import { fileRefOf } from './attachments.ts'

/** The desktop shell's preload bridge (desktop/preload.js): present only inside the Electron window. */
export interface DesktopBridge {
  platform: string
  /** the system's folder dialog; resolves to the chosen absolute path, or null when the person cancelled */
  pickDirectory?: () => Promise<string | null>
  /** a PDF or a video the person attached, named to the harness where it lies (nothing copied or uploaded): the
   *  reference the harness made; null when the File has no file on disk behind it; rejects with the refusal */
  attachLocalFile?: (sessionId: string, file: File) => Promise<unknown>
  /** loads the ChatGPT page again (a page that did not load also retries by itself) */
  reloadChatGpt?: () => Promise<boolean>
  /** the shell's ChatGPT bridge: starts it (the signed-in ChatGPT page loads) and answers where the bridge listens */
  openChatGptBridge?: () => Promise<{ url: string; token: string } | null>
  /** places the ChatGPT page over the desk's ChatGPT card (window coordinates), or hides it */
  placeChatGpt?: (place: ChatGptPlace) => void
  /** whether the ChatGPT page is signed in, the oasis-code connector and the model the person's own use of it taught;
   *  `{ load: false }` never opens the page (opening it holds the window a moment): a page not open yet says
   *  `started: false`, its sign-in unknown */
  chatGptStatus?: (opts?: { load?: boolean }) => Promise<ChatGptStatus | null>
  /** a connector known here before, offered once (kept only when the app knows none) */
  offerChatGptConnector?: (mention: string) => Promise<string | null>
  /** reports the Browser card's display area and visibility; the page keeps its fixed desktop viewport */
  placeBrowser?: (place: ChatGptPlace) => void
  /** the person's input on the Browser card, in the fixed page's CSS coordinates */
  browserInput?: (input: BrowserInput) => Promise<{ ok: boolean; reason?: string } | null>
  /** what the agent's browser shows, and the run acting on it (null: none) */
  browserStatus?: () => Promise<BrowserStatus | null>
  /** the Browser card's tabs: a new one (blank, or at an address), one shown, one closed — the person's use of the page */
  browserTab?: (change: { action: 'new' | 'switch' | 'close'; id?: string; url?: string }) => Promise<BrowserControlResult | null>
  /** the Browser card's address bar and buttons on the tab shown */
  browserNavigate?: (change: { action: 'go' | 'back' | 'forward' | 'reload' | 'stop'; url?: string }) => Promise<BrowserControlResult | null>
  /** the person picks an element of the page shown (null: cancelled, or the page went elsewhere) */
  pickBrowserElement?: () => Promise<PickedElement | null>
  cancelBrowserPick?: () => Promise<boolean>
  /** the agent's browser's cookies, site storage and cache cleared, its page blank (refused while a run holds it) */
  clearBrowserData?: () => Promise<BrowserClearResult | null>
  /** the bridge sends again after its send log was damaged, the person having looked at the ChatGPT page */
  resumeChatGptSending?: () => Promise<ResumeSendingResult | null>
  /** the page an agent is acting on (computer use) as it is now, for the thread's live view: on the agent's browser,
   *  `owner` names the run whose own tab is asked for (absent: the tab the person shows on the Browser card) */
  surfaceFrame?: (surface: 'browser' | 'chatgpt', owner?: string | null) => Promise<SurfaceFrame | null>
  /** remote access (ChatGPT reaching oasis-code through the standing gateway): its state, turning it on or off, its
   *  one-time provider setup, and revoking its link (a new external secret: the URL changes) */
  remoteStatus?: () => Promise<RemoteStatus | null>
  setRemote?: (change: { enabled?: boolean; keep_awake?: boolean }) => Promise<RemoteStatus | null>
  configureRemote?: (change: RemoteSetup) => Promise<RemoteStatus | null>
  rotateRemote?: () => Promise<RemoteStatus | null>
}

export type RemoteProvider = 'quick' | 'cloudflare' | 'ngrok' | 'external'
export type RemoteState = 'off' | 'starting' | 'connected' | 'backend_offline' | 'tunnel_unavailable' | 'error'

/** The tunnel: the quick one (nothing to set up), or a stable provider, its fixed public host, and the provider's
 *  token (Cloudflare tunnel token, ngrok authtoken; an external tunnel takes none). The token goes to the backend's
 *  0600 file and never comes back. */
export interface RemoteSetup { provider: RemoteProvider; host?: string; token?: string }

/** Remote access as the shell reads it: `url` is the connector address (the external secret inside) once the tunnel
 *  has a name — a quick tunnel's changes when the gateway starts again; `token_set` whether the provider's token is
 *  kept (never the token). */
export interface RemoteStatus {
  state: RemoteState
  enabled: boolean
  keep_awake: boolean
  provider: RemoteProvider
  host: string | null
  url: string | null
  error: string | null
  token_set: boolean | null
  /** the gateway's loopback origin a tunnel forwards to (`http://127.0.0.1:8324`) */
  gateway_origin: string
}

type RemoteShell = Required<Pick<DesktopBridge, 'remoteStatus' | 'setRemote' | 'configureRemote' | 'rotateRemote'>>

/** The shell's remote access when there is one (the desktop app); a plain browser has none. */
export function remoteAccess(scope: { oasisCodeDesktop?: unknown }): RemoteShell | null {
  const b = bridgeOf(scope)
  return b && typeof b.remoteStatus === 'function' && typeof b.setRemote === 'function' && typeof b.configureRemote === 'function' && typeof b.rotateRemote === 'function'
    ? { remoteStatus: b.remoteStatus, setRemote: b.setRemote, configureRemote: b.configureRemote, rotateRemote: b.rotateRemote } : null
}

export const REMOTE_PROVIDERS: { value: RemoteProvider; label: string; host: string | null; token: string | null; help: string | null }[] = [
  { value: 'quick', label: 'Quick tunnel', host: null, token: null, help: null },
  { value: 'cloudflare', label: 'Cloudflare tunnel', host: 'mcp.example.com', token: 'Tunnel token', help: 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/' },
  { value: 'ngrok', label: 'ngrok domain', host: 'your-name.ngrok-free.dev', token: 'Authtoken', help: 'https://dashboard.ngrok.com/domains' },
  { value: 'external', label: 'Other HTTPS tunnel', host: 'mac.tailnet.ts.net', token: null, help: 'https://tailscale.com/docs/reference/tailscale-cli/funnel' },
]

/** The one step a provider needs besides the host (and its token), naming where the gateway listens. */
export function remoteSetupStep(provider: RemoteProvider, origin: string): string {
  if (provider === 'quick') return 'The address changes when the gateway restarts (a reboot, say).'
  if (provider === 'cloudflare') return `Route this hostname to ${origin}; paste its tunnel token.`
  if (provider === 'ngrok') return 'Use the dev domain assigned to your account; paste its authtoken.'
  return `Forward HTTPS on this hostname to ${origin}.`
}

/** One short line on remote access's state, for the person. */
export function remoteLine(s: RemoteStatus): string {
  switch (s.state) {
    case 'off': return 'Off'
    case 'starting': return 'Starting…'
    case 'connected': return 'Connected'
    case 'backend_offline': return 'Link is up; oasis-code is not running (tools answer once it is)'
    case 'tunnel_unavailable': return `Tunnel unavailable${s.error ? `: ${s.error}` : ''}`
    default: return `Needs attention: ${s.error ?? 'unknown'}`
  }
}

/** `load_error`: why the page did not load (it loads again by itself), or null. `journal`: the bridge's send log. */
export interface ChatGptStatus { started: boolean; logged_in: boolean | null; connector: string | null; model: string | null; load_error?: string | null; journal?: SendLogState }

/** The bridge's send log (which messages went): usable; damaged — set aside as `file` at `at`, sending paused until
 *  the person resumes it; or unreadable (read again at the next send). */
export type SendLogState =
  | { state: 'usable' }
  | { state: 'damaged'; file: string; at: string | null }
  | { state: 'unreadable'; reason: string | null }

export interface ResumeSendingResult { resumed: boolean; reason?: string; archived?: string[]; salvaged?: number; journal: SendLogState }

/** What the ChatGPT card says of the send log when sending is paused, and whether the person can resume it there;
 *  null while the log is usable (or its state is not known). */
export function sendLogNotice(journal: SendLogState | null | undefined): { text: string; resumable: boolean } | null {
  if (!journal || journal.state === 'usable') return null
  if (journal.state === 'damaged') return { text: 'The send log was damaged; sending is paused. Check the ChatGPT page for messages that may have gone, then resume.', resumable: true }
  return { text: `The send log cannot be read${journal.reason ? ` (${journal.reason})` : ''}; sending is paused until it can.`, resumable: false }
}

/** The shell's resume of the bridge's sending when there is one (the desktop app). */
export function chatGptSendingResumer(scope: { oasisCodeDesktop?: unknown }): (() => Promise<ResumeSendingResult | null>) | null {
  const resume = bridgeOf(scope)?.resumeChatGptSending
  return typeof resume === 'function' ? resume : null
}

export interface ChatGptPlace { x: number; y: number; width: number; height: number; visible: boolean }

/** The agent's browser as the shell reports it: the page it shows (the tab shown), its tabs, and the run acting on it. */
export interface BrowserStatus {
  opened: boolean; url: string | null; title: string | null; loading?: boolean; holder: string | null
  can_go_back?: boolean; can_go_forward?: boolean; tabs?: BrowserTab[]; active_tab?: string | null
  /** this showing of the tab shown (another tab shown in between makes another) */
  shown_page?: string | null
  /** whether the profile's data may be cleared now: no run holds any tab (absent: an older shell, `holder` says) */
  can_clear_data?: boolean
}
/** A tab of the agent's browser: `owner` the run it belongs to (kept after the run let go), `session` that run's
 *  session, `owner_label` a short trusted name of its agent, `holder` the run holding it now. All absent from an older
 *  shell; all null on a tab of the person's own. */
export interface BrowserTab {
  id: string; url: string; title: string; loading: boolean; active: boolean
  owner?: string | null; session?: string | null; owner_label?: string | null; holder?: string | null
}

/** A short handle for a run (`run_3f9a2c1b0d4e` → `run 3f9a`), told apart from the other runs at a glance. */
export function shortRunId(id: string): string {
  const m = /^([a-z]+)_([0-9a-z]{4})/i.exec(id)
  if (m) return `${m[1]} ${m[2]}`
  return id.length > 8 ? `${id.slice(0, 7)}…` : id
}

/** The agent a tab belongs to, as its badge on the Browser card shows it: its trusted short name (else the run's short
 *  id), whether the run holds the tab now (`live`) or only held it last, and the run and session in full for the
 *  tooltip. Null on a tab no agent ever had — never read from the page's title or address. */
export function tabOwnerBadge(tab: BrowserTab): { label: string; live: boolean; run: string; title: string } | null {
  const run = tab.holder || tab.owner || null
  if (!run) return null
  const name = typeof tab.owner_label === 'string' ? tab.owner_label.trim() : ''
  const label = name || shortRunId(run)
  const live = !!tab.holder
  const title = [`${name || 'Agent'} · ${live ? 'using this tab' : 'used this tab last'}`, `run ${run}`, tab.session ? `session ${tab.session}` : ''].filter(Boolean).join('\n')
  return { label, live, run, title }
}

/** The runs holding a tab of the browser now (an older shell names one: the tab shown's). */
export function browserHolders(status: BrowserStatus | null): string[] {
  if (!status) return []
  const tabs = status.tabs ?? []
  const perTab = tabs.some((t) => t.holder !== undefined)
  const held = perTab ? tabs.map((t) => t.holder) : [status.holder]
  return [...new Set(held.filter((h): h is string => !!h))]
}
export const BROWSER_VIEWPORT = { width: 1280, height: 800 } as const
export type BrowserInput = ({ page?: string | null; modifiers?: string[] } & (
  | { type: 'mouseDown' | 'mouseUp' | 'mouseMove'; x: number; y: number; button?: 'left' | 'middle' | 'right'; buttons?: number; clickCount?: number }
  | { type: 'mouseWheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'keyDown' | 'keyUp'; keyCode: string; code?: string; isAutoRepeat?: boolean; location?: number }
  | { type: 'text'; text: string }
))

/** A complete fixed desktop page, reduced only as needed. Like Claude's browser panel, it is at most 1×,
 *  horizontally centred by its container, with its top at the container's top. */
export function browserFrameSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.max(0, Math.min(1, width / BROWSER_VIEWPORT.width, height / BROWSER_VIEWPORT.height))
  return { width: Math.round(BROWSER_VIEWPORT.width * scale), height: Math.round(BROWSER_VIEWPORT.height * scale) }
}

/** A pointer on the displayed image to the fixed page. Blank space around the image is not page content;
 *  only an existing drag clamps its last move/up to the edge so a button is never left held down. */
export function browserPoint(rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number, dragging = false): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  const x = (clientX - rect.left) / rect.width, y = (clientY - rect.top) / rect.height
  if (!dragging && (x < 0 || x >= 1 || y < 0 || y >= 1)) return null
  return { x: Math.max(0, Math.min(BROWSER_VIEWPORT.width - 1, Math.floor(x * BROWSER_VIEWPORT.width))), y: Math.max(0, Math.min(BROWSER_VIEWPORT.height - 1, Math.floor(y * BROWSER_VIEWPORT.height))) }
}

export function browserModifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): string[] {
  return [event.altKey && 'alt', event.ctrlKey && 'control', event.metaKey && 'meta', event.shiftKey && 'shift'].filter((key): key is string => !!key)
}

/** Wheel distances are page CSS pixels. Line/page events from a mouse use the same units as a trackpad. */
export function browserWheel(deltaX: number, deltaY: number, deltaMode: number): { deltaX: number; deltaY: number } {
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? BROWSER_VIEWPORT.height : 1
  return { deltaX: deltaX * unit, deltaY: deltaY * unit }
}

export function browserInputOf(scope: { oasisCodeDesktop?: unknown }): DesktopBridge['browserInput'] | null {
  const input = bridgeOf(scope)?.browserInput
  return typeof input === 'function' ? input : null
}

/** What a control of the Browser card did, and the browser after it. */
export interface BrowserControlResult { ok: boolean; reason?: string; id?: string; url?: string; status?: BrowserStatus }
/** An element the person picked on the page: a selector that finds it again, its tag, role and words, its box. */
export interface PickedElement { tag: string; selector: string; role: string | null; text: string; url: string; title?: string; rect?: { x: number; y: number; width: number; height: number } }

function bridgeOf(scope: { oasisCodeDesktop?: unknown }): Partial<DesktopBridge> | null {
  const bridge = scope.oasisCodeDesktop
  return bridge && typeof bridge === 'object' ? (bridge as Partial<DesktopBridge>) : null
}

/** The desktop app's way of naming a File's file on disk to the harness, for one session; null in a plain browser.
 *  It answers the local reference, or null when the File has none behind it (the page uploads that one); an answer
 *  that is neither is an error (never taken as "upload it"). */
export function localAttacher(scope: { oasisCodeDesktop?: unknown }, sessionId: string): ((file: File) => Promise<FileRefAttachment | null>) | null {
  const b = bridgeOf(scope)
  if (!b || typeof b.attachLocalFile !== 'function') return null
  const attach = b.attachLocalFile.bind(b)
  return async (file) => {
    const answer = await attach(sessionId, file)
    if (answer === null) return null
    const ref = fileRefOf(answer, 'local')
    if (ref) return ref
    throw new Error('the desktop app answered something other than a local reference; the file was not attached')
  }
}

/** The platform the desktop shell reports, or null in a plain browser (or when the bridge is malformed). */
export function desktopPlatform(scope: { oasisCodeDesktop?: unknown }): string | null {
  const platform = bridgeOf(scope)?.platform
  return typeof platform === 'string' && platform ? platform : null
}

/** The shell's folder dialog when there is one; a plain browser has none (the person types a path). */
export function folderDialog(scope: { oasisCodeDesktop?: unknown }): (() => Promise<string | null>) | null {
  const pick = bridgeOf(scope)?.pickDirectory
  return typeof pick === 'function' ? pick : null
}

/** The shell's ChatGPT bridge when there is one (the desktop app); a plain browser has none (the person names a bridge URL). */
export function chatGptBridge(scope: { oasisCodeDesktop?: unknown }): (() => Promise<{ url: string; token: string } | null>) | null {
  const open = bridgeOf(scope)?.openChatGptBridge
  return typeof open === 'function' ? open : null
}

/** The shell's placement of the ChatGPT page when there is one (the desktop app); a plain browser has no page to place. */
export function chatGptPlacer(scope: { oasisCodeDesktop?: unknown }): ((place: ChatGptPlace) => void) | null {
  const place = bridgeOf(scope)?.placeChatGpt
  return typeof place === 'function' ? place : null
}

export const HIDDEN_CHATGPT: ChatGptPlace = { x: 0, y: 0, width: 0, height: 0, visible: false }
const PROBE_INSET = 6

/** Where the ChatGPT page goes for a card body at `rect` (window coordinates). The page is drawn above the whole
 *  app, so it shows only while nothing covers the body — a card in front, a menu, a dialog hides the page instead
 *  of being hidden under it. `uncovered(x, y)` says whether the card itself is what sits at a point. */
export function chatGptPlaceOf(rect: { left: number; top: number; width: number; height: number }, uncovered: (x: number, y: number) => boolean, pageShown: boolean): ChatGptPlace {
  const x = Math.round(rect.left), y = Math.round(rect.top), width = Math.round(rect.width), height = Math.round(rect.height)
  if (!pageShown || width < 4 * PROBE_INSET || height < 4 * PROBE_INSET) return { ...HIDDEN_CHATGPT }
  const [l, t, r, b] = [rect.left + PROBE_INSET, rect.top + PROBE_INSET, rect.left + rect.width - PROBE_INSET, rect.top + rect.height - PROBE_INSET]
  const probes: [number, number][] = [[l, t], [r, t], [l, b], [r, b], [(l + r) / 2, (t + b) / 2]]
  return { x, y, width, height, visible: probes.every(([px, py]) => uncovered(px, py)) }
}

/** The overlays of the app that may open over a card (a menu, a dialog, a popover): drawn in the page, they would
 *  be hidden under a page the shell draws above the whole window — so the Browser card's page steps aside for them. */
export const OVERLAY_SELECTOR = 'dialog[open], [role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], .picker-popover, .mention-menu, .desk-tail-list, .toast, .change-preview, .media-hover'

/** Whether a floating thing lets the pointer through (`pointer-events: none`, fixed or absolute — a hover preview): the
 *  window's hit test never finds it, so it covers the card wherever its box crosses it, as an overlay does. */
export function passesPointer(style: { pointerEvents: string; position: string }): boolean {
  return style.pointerEvents === 'none' && (style.position === 'fixed' || style.position === 'absolute')
}
const BROWSER_PROBES = 4
/** What else may lie over a card without being one of the overlays named above: the window's top-level pieces (a portal
 *  mounted on the body), the desk's other cards, a popover, anything positioned by its own style (a menu placed at the
 *  pointer) — each counts only where it is the topmost thing over the card. */
export const FLOATING_SELECTOR = 'body > *, .desk-layer > *, [popover], [style*="position"]'

type Box = { left: number; top: number; right: number; bottom: number }
/** A thing that may lie over the Browser card's body: its box, whether it is an overlay of the app (it covers wherever
 *  it crosses the body), and whether it is the topmost thing at a point (the window's own hit test). */
export interface OverCandidate { rect: Box; overlay: boolean; topAt: (x: number, y: number) => boolean }

/** The boxes that cover the body now: an overlay crossing it, or another thing that is the topmost at some point of
 *  where it crosses (its middle or near one of its corners) — a two-pixel line between the probes is still caught. */
export function coveringBoxes(body: { left: number; top: number; width: number; height: number }, candidates: ReadonlyArray<OverCandidate>): Box[] {
  const b = { left: body.left, top: body.top, right: body.left + body.width, bottom: body.top + body.height }
  const out: Box[] = []
  for (const c of candidates) {
    const i = { left: Math.max(b.left, c.rect.left), top: Math.max(b.top, c.rect.top), right: Math.min(b.right, c.rect.right), bottom: Math.min(b.bottom, c.rect.bottom) }
    if (i.right <= i.left || i.bottom <= i.top) continue
    if (c.overlay) { out.push(i); continue }
    const inset = (lo: number, hi: number) => Math.min(1, (hi - lo) / 2)
    const dx = inset(i.left, i.right), dy = inset(i.top, i.bottom)
    const points: [number, number][] = [[(i.left + i.right) / 2, (i.top + i.bottom) / 2], [i.left + dx, i.top + dy], [i.right - dx, i.top + dy], [i.left + dx, i.bottom - dy], [i.right - dx, i.bottom - dy]]
    if (points.some(([x, y]) => c.topAt(x, y))) out.push(i)
  }
  return out
}

/** Where the agent's browser goes for the Browser card's body. Its size is the body's own laid-out size (`layout`,
 *  untouched by a card's lift or hover scale, so a drag never makes the page lay out again); its place the body's
 *  middle on screen, pixel-snapped. It shows only while all of the body is in the window, no overlay of the app
 *  (`overlays`) crosses it and the card itself is what lies at every probe of a grid over it — a page drawn above the
 *  window would hide whatever covers it and take its clicks, so it steps aside rather than risk that. */
export function browserPlaceOf(
  rect: { left: number; top: number; width: number; height: number },
  layout: { width: number; height: number },
  uncovered: (x: number, y: number) => boolean,
  pageShown: boolean,
  view: { width: number; height: number },
  overlays: ReadonlyArray<{ left: number; top: number; right: number; bottom: number }> = [],
): ChatGptPlace {
  const width = Math.round(layout.width), height = Math.round(layout.height)
  const x = Math.round(rect.left + (rect.width - layout.width) / 2), y = Math.round(rect.top + (rect.height - layout.height) / 2)
  const place = { x, y, width, height }
  if (!pageShown || width < 4 * PROBE_INSET || height < 4 * PROBE_INSET) return { ...place, visible: false }
  // all of it in the window (a view past its edges is cut off where the card is not)
  if (rect.left < 0 || rect.top < 0 || rect.left + rect.width > view.width || rect.top + rect.height > view.height) return { ...place, visible: false }
  const r = { left: rect.left, top: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height }
  if (overlays.some((o) => o.right > r.left && o.left < r.right && o.bottom > r.top && o.top < r.bottom)) return { ...place, visible: false }
  const [l, t, rt, b] = [r.left + PROBE_INSET, r.top + PROBE_INSET, r.right - PROBE_INSET, r.bottom - PROBE_INSET]
  for (let i = 0; i <= BROWSER_PROBES; i += 1) {
    for (let j = 0; j <= BROWSER_PROBES; j += 1) {
      if (!uncovered(l + ((rt - l) * i) / BROWSER_PROBES, t + ((b - t) * j) / BROWSER_PROBES)) return { ...place, visible: false }
    }
  }
  return { ...place, visible: true }
}

/** Whether the Browser card needs its stand-in picture now: its page does not show, but the card's body itself is on
 *  screen to be seen (the app shown, the body laid out and visible, all of it inside the window) — something covers it.
 *  A card put away or folded to its title, one past the window's edge, or the app hidden asks for no picture. */
export function browserStandIn(place: ChatGptPlace, pageShown: boolean, bodyVisible: boolean, rect: { left: number; top: number; width: number; height: number }, view: { width: number; height: number }): boolean {
  if (place.visible || !pageShown || !bodyVisible) return false
  if (place.width < 4 * PROBE_INSET || place.height < 4 * PROBE_INSET) return false
  return rect.left >= 0 && rect.top >= 0 && rect.left + rect.width <= view.width && rect.top + rect.height <= view.height
}

/** The stand-in picture to draw for the page shown now: a picture is of the page (the tab, as each showing of it is
 *  named) it was taken of — a picture of another tab, or of this tab before another was shown, is never drawn. */
export function standInImage(frame: { page?: string | null; image: SurfaceFrame['image'] } | null, page: string | null | undefined): SurfaceFrame['image'] {
  if (!frame || !frame.image) return null
  if (page && frame.page !== page) return null
  return frame.image
}

/** What the person picked on the page, as a line of their message to an agent (the page's address without its query
 *  or fragment: they may hold a token or what was searched for). */
export function pickedLine(p: PickedElement): string {
  const words = p.text ? ` "${p.text.length > 80 ? `${p.text.slice(0, 79)}…` : p.text}"` : ''
  const role = p.role ? ` role=${p.role}` : ''
  let where = p.url
  try { const u = new URL(p.url); where = `${u.origin}${u.pathname}` } catch { /* as the shell gave it */ }
  return `The element \`${p.selector}\` (<${p.tag}>${role}${words}) on ${where}`
}

/** The shell's ChatGPT status when there is one (the desktop app). */
export function chatGptStatusOf(scope: { oasisCodeDesktop?: unknown }): ((opts?: { load?: boolean }) => Promise<ChatGptStatus | null>) | null {
  const status = bridgeOf(scope)?.chatGptStatus
  return typeof status === 'function' ? status : null
}

export function chatGptConnectorOffer(scope: { oasisCodeDesktop?: unknown }): ((mention: string) => Promise<string | null>) | null {
  const offer = bridgeOf(scope)?.offerChatGptConnector
  return typeof offer === 'function' ? offer : null
}

/** Whether ChatGPT can be named here (the desktop app holds the page; a plain browser cannot). */
export function chatGptAvailable(scope: { oasisCodeDesktop?: unknown }): boolean {
  return !!chatGptBridge(scope)
}

/** What the ChatGPT chip warns of: the page not signed in, or no connector known yet (the person has not @-mentioned
 *  oasis-code on the page); null when ChatGPT is ready — or its state is not known yet. */
export type ChatGptWarning = 'signin' | 'connector' | null
export function chatGptWarning(status: ChatGptStatus | null): ChatGptWarning {
  if (!status) return null
  if (status.logged_in === false) return 'signin'
  if (!status.connector) return 'connector'
  return null
}

/** ChatGPT as a participant needs its page signed in, nothing more (no connector): 'signin' when it is not — known
 *  from the page, or before it opens from its profile holding no sign-in cookie — null when it is, undefined while
 *  that is unknown (not read yet, or the page not opened and its cookie there: the @ menu never opens it). */
export function chatGptSignIn(status: ChatGptStatus | null): 'signin' | null | undefined {
  if (!status) return undefined
  if (status.logged_in === false) return 'signin'
  if (status.started === false || status.logged_in === null) return undefined
  return null
}

/** The page started (the bridge listening, the page loading) before a run types into it; outside the desktop app
 *  there is nothing to start, and the run says the page is not reachable. */
export async function startChatGptPage(scope: { oasisCodeDesktop?: unknown }): Promise<void> {
  const open = chatGptBridge(scope)
  if (open) await open()
}

/** The shell's placement of the agent's browser when there is one (the desktop app). */
export function browserPlacer(scope: { oasisCodeDesktop?: unknown }): ((place: ChatGptPlace) => void) | null {
  const place = bridgeOf(scope)?.placeBrowser
  return typeof place === 'function' ? place : null
}

/** Whether computer use has pages to act on here (the desktop app holds them; a plain browser has none). */
export function computerAvailable(scope: { oasisCodeDesktop?: unknown }): boolean {
  return browserPlacer(scope) !== null
}

/** A page of computer use as a person watching follows it: the run that holds it, the action going on now, where the
 *  agent's pointer last went (the page's own pixels) and — while a run holds the page — its picture as it is now. */
export interface SurfaceFrame {
  surface: string
  holder: string | null
  /** who held the page last — the run and its session (`session:<id>`, or the run itself) — still there after its
   *  lease ran out or it let go; null before anyone took it */
  last: { owner: string; party: string } | null
  doing: { action: string; target: string | null; since: number } | null
  pointer: { x: number; y: number; action: string; at: number } | null
  image: { media_type: string; data_base64: string; width: number; height: number } | null
  url?: string
  title?: string
  loading?: boolean
  viewport?: { width: number; height: number }
  /** the page the picture is of (the agent's browser: the showing of the tab it was taken of) */
  page?: string | null
  /** the tab the picture is of (the agent's browser) */
  tab_id?: string | null
}

/** The shell's live picture of a page of computer use when there is one (the desktop app). */
export function surfaceFrames(scope: { oasisCodeDesktop?: unknown }): ((surface: 'browser' | 'chatgpt', owner?: string | null) => Promise<SurfaceFrame | null>) | null {
  const frame = bridgeOf(scope)?.surfaceFrame
  return typeof frame === 'function' ? frame : null
}

/** The Browser card's own controls when the shell has them all (the desktop app): tabs, address bar and buttons,
 *  element picker. */
export function browserControls(scope: { oasisCodeDesktop?: unknown }): Required<Pick<DesktopBridge, 'browserTab' | 'browserNavigate' | 'pickBrowserElement' | 'cancelBrowserPick'>> | null {
  const b = bridgeOf(scope)
  if (!b || typeof b.browserTab !== 'function' || typeof b.browserNavigate !== 'function' || typeof b.pickBrowserElement !== 'function' || typeof b.cancelBrowserPick !== 'function') return null
  return { browserTab: b.browserTab, browserNavigate: b.browserNavigate, pickBrowserElement: b.pickBrowserElement, cancelBrowserPick: b.cancelBrowserPick }
}

export function browserStatusOf(scope: { oasisCodeDesktop?: unknown }): (() => Promise<BrowserStatus | null>) | null {
  const status = bridgeOf(scope)?.browserStatus
  return typeof status === 'function' ? status : null
}

export interface BrowserClearResult { cleared: boolean; reason?: string; holder?: string | null }

/** The shell's clearing of the agent browser's data when there is one (the desktop app). */
export function browserDataClearer(scope: { oasisCodeDesktop?: unknown }): (() => Promise<BrowserClearResult | null>) | null {
  const clear = bridgeOf(scope)?.clearBrowserData
  return typeof clear === 'function' ? clear : null
}

/** Whether the Browser card offers "Clear browser data" now: never while a run holds any tab of the browser (the
 *  shell refuses it then too; it says so in `can_clear_data` — the tab shown being free says nothing of the others,
 *  and only an older shell without it is read by its one `holder`), nor while one clear is going; the title says why. */
export function clearBrowserDataOffer(status: BrowserStatus | null, clearing: boolean): { enabled: boolean; title: string } {
  if (clearing) return { enabled: false, title: 'Clearing the browser data…' }
  const blocked = typeof status?.can_clear_data === 'boolean' ? !status.can_clear_data : !!status?.holder
  if (blocked) return { enabled: false, title: 'An agent is using the browser; clear its data once the run lets go of it.' }
  return { enabled: true, title: "Clear the agent's browser data: its cookies, site storage and cache. Every project and session is signed out of the sites it used." }
}

/** The question asked before clearing: the profile is one for the whole app. */
export const CLEAR_BROWSER_DATA_CONFIRM = "Clear the agent's browser data? All of its tabs — yours and every agent's — are closed, then its cookies, site storage and cache are removed and a blank tab opens. The browser is shared by every project and session, so all of them are signed out of the sites it used."

/** The Browser card's line beside its title: an agent acting on the page, else the page's site. */
export function browserLine(status: BrowserStatus | null): string {
  if (!status || !status.opened) return 'not opened'
  const holders = browserHolders(status).length
  if (holders > 1) return `${holders} agents are using it`
  if (holders) return 'an agent is using it'
  try { return status.url && /^https?:/.test(status.url) ? new URL(status.url).host : 'blank' } catch { return 'blank' }
}

/** Whether an entry of the thread is computer use on the agent's browser (a result says which page it acted on). */
export function usesAgentBrowser(entry: { kind: string; tool?: string; result?: Record<string, unknown> }): boolean {
  return entry.kind === 'activity' && (entry.tool === 'computer_observe' || entry.tool === 'computer_act') && entry.result?.surface === 'browser'
}

/** The shell's reload of the ChatGPT page when there is one (the desktop app). */
export function chatGptReloader(scope: { oasisCodeDesktop?: unknown }): (() => Promise<boolean>) | null {
  const reload = bridgeOf(scope)?.reloadChatGpt
  return typeof reload === 'function' ? reload : null
}
