/** The isolated HTML preview (components/IntelligentHtml.tsx) in a real Chromium, on its own: the component as the
 *  app builds it (vite, React dev build under StrictMode) in a stand-in host page that holds a cookie, a token in
 *  localStorage and an API — and the app's own page policy, read from frontend/index.html (what production serves),
 *  so the harness cannot pass with a policy the app does not have. "Outside" HTTP and HTTPS servers on loopback and a
 *  UDP port (a STUN target) count every connection and request the preview manages to make. Nothing of the backend,
 *  the desktop app or the person's data is involved; the browser is a separate headless process
 *  (OASIS_CODE_E2E_BROWSER names a Chromium executable, as in ui.e2e.ts).
 *
 *  What is asserted is what the docs claim: no host DOM/storage/cookie/API, no fetch/WebSocket/beacon/image/script/
 *  style/nested frame/WebRTC traffic, no forged or stale bridge message taken, an action only on the person's click
 *  and only as a proposal, a navigation stopped — and, under the app's page policy (frame-src 'none'), that the
 *  navigation's request is refused before it is sent: nothing reaches the outside. Without that policy (the component
 *  reused in a page that lacks it) its one request does leave, without cookies: a control, asserted as such.
 *  The host-theme tests import the theme interface (state/uiTheme.ts, themeMessage in state/uiSandbox.ts) directly: a
 *  tree without it fails to build the harness, it does not skip. The same harness also mounts the app's own surface
 *  block (UiSurface: one card, one title, the preview's Run / Stop / Reset in its header) for the embedded cases.
 *  No test runs a loop that never ends: it would hold the browser's thread (the docs say so too). */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import dgram from 'node:dgram'
import http from 'node:http'
import https from 'node:https'
import type { Socket } from 'node:net'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type Frame, type Page } from 'playwright-core'
// the bridge's protocol version as the host speaks it (2 since the interaction extension): a forged message carries the
// current one, so what refuses it is the check under test (the nonce, the window), not the version
import { UI_SANDBOX_VERSION } from '../src/state/uiSandbox.ts'
import { build, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const FRONTEND = process.cwd()
const SEL = '[data-testid="intelligent-html"]'
const FRAME = '[data-testid="intelligent-html-frame"]'

/** The app's page policy, exactly as frontend/index.html declares it (the page the backend and the desktop serve). */
const INDEX_HTML = readFileSync(join(FRONTEND, 'index.html'), 'utf8')
const POLICY_META = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i.exec(INDEX_HTML)
const APP_POLICY = POLICY_META?.[1] ?? ''

/** whether the HTTPS receiver can be made (decided before the tests are declared, so a skip is named, not silent) */
const OPENSSL = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()


type Hit = { url: string; cookie: string | undefined }
const outsideHits: Hit[] = []
const hostApiHits: Hit[] = []
/** TCP connections the outside servers accepted. Each keeps its raw socket, and its bytes are read when observed from
 *  `socket.bytesRead` — the bytes the kernel delivered on it (Node keeps the count after the socket closes,
 *  lib/net.js). A 'data' listener on the raw socket of an https.Server would see nothing once TLS takes the socket
 *  over (measured: a real HTTPS GET with rawDataBytes 0, bytesRead 1728), so it is not used. Bytes are the payload
 *  received; a TCP handshake alone is a connection with 0 bytes — 0 bytes is not "no connection". Chromium opens a
 *  connection for a frame navigation before the page policy refuses it (its PreconnectSockets runs before the
 *  frame-src check); what that connection carries is recorded, not promised. */
const outsideSockets: Array<{ scheme: 'http' | 'https'; socket: Socket }> = []
const newConnections = (from: number) => outsideSockets.slice(from).map((c) => ({ scheme: c.scheme, bytes: c.socket.bytesRead }))
const connectionCount = () => outsideSockets.length
let udpPackets = 0
let outDir = ''
let host: http.Server
let outside: http.Server
let outsideTls: https.Server | null = null
let udp: dgram.Socket
let HOST = ''
let OUT = ''
let OUTS = ''
let UDP_PORT = 0
let browser: Browser

const HARNESS_ID = 'virtual:intelligent-ui-sandbox-harness'
/** the stand-in host: the component, the props a test passes, what the callbacks were given; a count of the host's
 *  live 'message' listeners (the component's must be gone when it is); the page-policy violations the host saw; and,
 *  where the tree has it, the theme interface for the tests that forge theme messages */
const harnessEntry = `
import { createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { IntelligentHtml } from ${JSON.stringify(join(FRONTEND, 'src/components/IntelligentHtml.tsx'))}
import { UiSurfaceBlock } from ${JSON.stringify(join(FRONTEND, 'src/components/UiSurface.tsx'))}
import { useStore } from ${JSON.stringify(join(FRONTEND, 'src/state/store.ts'))}
import { readUiHostTheme, normalizeUiHostTheme } from ${JSON.stringify(join(FRONTEND, 'src/state/uiTheme.ts'))}
import { themeMessage } from ${JSON.stringify(join(FRONTEND, 'src/state/uiSandbox.ts'))}
import { appTheme } from ${JSON.stringify(join(FRONTEND, 'src/state/theme.ts'))}
// the app's own theme controller, as main.tsx starts it (the page stores the choice System, so the emulated scheme
// is what the host draws, as with the app; a test may choose an explicit theme through it, as Settings does)
window.__appTheme = appTheme()
window.__theme = { read: readUiHostTheme, normalize: normalizeUiHostTheme, message: themeMessage }
window.__violations = []
document.addEventListener('securitypolicyviolation', (e) => window.__violations.push({ directive: e.effectiveDirective || e.violatedDirective, blocked: e.blockedURI }))
let listeners = 0
const add = window.addEventListener, remove = window.removeEventListener
window.addEventListener = function (type, ...rest) { if (type === 'message') listeners++; return add.call(this, type, ...rest) }
window.removeEventListener = function (type, ...rest) { if (type === 'message') listeners--; return remove.call(this, type, ...rest) }
window.__listeners = () => listeners
const root = createRoot(document.getElementById('root'))
window.__ui = { states: [], actions: [] }
let list = []
const render = () => root.render(createElement(StrictMode, null, ...list.map((props, i) => createElement(IntelligentHtml, {
  key: 'p' + i, ...props,
  onStateChange: (s) => window.__uis[i].states.push(s),
  onAction: (id, s) => window.__uis[i].actions.push({ id, state: s }),
}))))
/** one preview (window.__ui records it) or several side by side (window.__uis[i]) */
window.__mountMany = (many) => { list = many; window.__uis = many.map(() => ({ states: [], actions: [] })); window.__ui = window.__uis[0]; render() }
window.__mount = (props) => window.__mountMany([props])
/** new props for preview i, its records kept (a replay toggle, a new revision) */
window.__setProps = (i, partial) => { list = list.map((p, j) => (j === i ? { ...p, ...partial } : p)); render() }
window.__unmount = () => { list = []; root.render(null) }
/** the app's own surface block around an html spec (embedded preview); its saves answered here, never sent anywhere */
window.__surfaceSaves = []
useStore.setState({ replaying: false, saveSurfaceState: async (target, revision, state) => {
  window.__surfaceSaves.push(state)
  return { ...window.__surfaceRecord, ...target, revision, state, updated_at: new Date(Date.now() + window.__surfaceSaves.length).toISOString() }
} })
window.__mountSurface = (record, opts = {}) => {
  window.__surfaceRecord = record
  useStore.setState({ replaying: !!opts.replaying })
  root.render(createElement(StrictMode, null, createElement('div', { className: 'e2e-thread', style: { padding: '12px', maxWidth: '760px' } },
    createElement(UiSurfaceBlock, { entry: { kind: 'ui', surface: record } }))))
}
window.__ready = true
`

const harnessPlugin: Plugin = {
  name: 'intelligent-ui-sandbox-harness',
  resolveId(id) { return id === HARNESS_ID ? `\0${HARNESS_ID}` : null },
  load(id) { return id === `\0${HARNESS_ID}` ? harnessEntry : null },
}

function listen(server: http.Server, port = 0): Promise<number> {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port)))
}

before(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'oasis-ui-sandbox-e2e-'))
  await build({
    configFile: false, root: FRONTEND, mode: 'development', logLevel: 'warn', plugins: [react(), harnessPlugin],
    define: { __OASIS_CODE_BUILD__: '"e2e"', 'process.env.NODE_ENV': '"development"' },
    build: { outDir, emptyOutDir: true, minify: false, sourcemap: false, rollupOptions: { input: HARNESS_ID, output: { entryFileNames: 'harness.js', assetFileNames: '[name][extname]' } } },
  })
  const css = readdirSync(outDir).filter((f) => f.endsWith('.css'))
  /** the host page: the app's own policy first (as index.html has it, before anything it governs) unless a test asks
   *  for a page without it (?policy=none: the component reused elsewhere); the app's global stylesheet (its tokens,
   *  typography and control rules) when a test compares the frame with the host (?appcss=1) */
  const page = (url: URL) => '<!doctype html><html><head><meta charset="utf-8">'
    + (url.searchParams.get('policy') === 'none' ? '' : POLICY_META![0])
    + `<title>host</title>${url.searchParams.get('appcss') === '1' ? '<link rel="stylesheet" href="/app.css">' : ''}${css.map((f) => `<link rel="stylesheet" href="/${f}">`).join('')}</head>`
    + '<body><div id="root"></div><script>localStorage.setItem("oasis-code.token", "host-token"); localStorage.setItem("oasis-code.theme", "system")</script><script type="module" src="/harness.js"></script></body></html>'
  host = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://host')
    if (url.pathname.startsWith('/api/')) { hostApiHits.push({ url: url.pathname + url.search, cookie: req.headers.cookie }); res.end('{"secret":"host-api"}'); return }
    if (url.pathname === '/app.css') { res.setHeader('content-type', 'text/css'); res.end(readFileSync(join(FRONTEND, 'src/index.css'))); return }
    const file = url.pathname.slice(1)
    if (file && readdirSync(outDir).includes(file)) {
      res.setHeader('content-type', file.endsWith('.css') ? 'text/css' : 'text/javascript')
      res.end(readFileSync(join(outDir, file)))
      return
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    // the backend's own cookie is HttpOnly SameSite=Strict; a SameSite=None one is what credentialless keeps home
    res.setHeader('set-cookie', ['oasis_e2e_strict=host-secret; Path=/; HttpOnly; SameSite=Strict', 'oasis_e2e_none=host-secret; Path=/; SameSite=None; Secure'])
    res.end(page(url))
  })
  const collect = (req: http.IncomingMessage, res: http.ServerResponse) => { outsideHits.push({ url: req.url ?? '', cookie: req.headers.cookie }); res.setHeader('content-type', 'text/html'); res.end('<p>outside</p>') }
  // 'connection' hands over the raw TCP socket for http and https alike (for https before TLS wraps it)
  const countConnections = (s: http.Server | https.Server, scheme: 'http' | 'https') => s.on('connection', (sock: Socket) => {
    outsideSockets.push({ scheme, socket: sock })
    sock.on('error', () => undefined)
  })
  outside = http.createServer(collect)
  countConnections(outside, 'http')
  HOST = `http://127.0.0.1:${await listen(host, Number(process.env.OASIS_CODE_E2E_PORT || 0))}`
  console.info(`e2e app host: ${HOST}`)
  OUT = `http://127.0.0.1:${await listen(outside)}`
  // an HTTPS receiver on loopback, its certificate made for this run in its own directory (the pages accept it, so a
  // request the browser did send would reach it); without openssl the HTTPS cases are skipped, by name
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(outDir, 'key.pem'), '-out', join(outDir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' })
    outsideTls = https.createServer({ key: readFileSync(join(outDir, 'key.pem')), cert: readFileSync(join(outDir, 'cert.pem')) }, collect)
    countConnections(outsideTls, 'https')
    OUTS = `https://127.0.0.1:${await listen(outsideTls as unknown as http.Server)}`
  } catch { outsideTls = null }
  udp = dgram.createSocket('udp4')
  udp.on('message', () => { udpPackets++ })
  await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', () => resolve()))
  UDP_PORT = udp.address().port
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  browser = await chromium.launch(executablePath ? { executablePath, headless: true, args: ['--no-sandbox'] } : { channel: 'chrome', headless: true })
})

after(async () => {
  await browser?.close()
  host?.close()
  outside?.close()
  outsideTls?.close()
  udp?.close()
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})

/** A fresh context each (no shared storage between tests). policy: false serves the page without the app's policy;
 *  appCss: true adds the app's global stylesheet. Self-signed loopback TLS is accepted so that a request the browser
 *  sends to the HTTPS receiver does arrive there and is counted. */
async function hostPage(opts: { policy?: boolean; appCss?: boolean; viewport?: { width: number; height: number } } = {}): Promise<Page> {
  const page = await browser.newPage({ ignoreHTTPSErrors: true, ...(opts.viewport ? { viewport: opts.viewport } : {}) })
  page.on('pageerror', (e) => { throw e })
  const q = new URLSearchParams()
  if (opts.policy === false) q.set('policy', 'none')
  if (opts.appCss) q.set('appcss', '1')
  await page.goto(`${HOST}/${q.size ? `?${q}` : ''}`)
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true)
  return page
}

/** the system's scheme as the host page sees it: emulated, then waited for until the app's theme controller (the
 *  choice System) has drawn it on the root — a media query's change event comes with the next rendering step, not
 *  with the emulation call */
async function systemScheme(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme })
  await page.waitForFunction((s) => document.documentElement.dataset.theme === s, scheme, { timeout: 5_000 })
}

const violations = (page: Page) => page.evaluate(() => (window as unknown as { __violations: Array<{ directive: string; blocked: string }> }).__violations)

async function mount(page: Page, props: Record<string, unknown>) {
  await page.evaluate((p) => (window as unknown as { __mount: (p: unknown) => void }).__mount(p), props)
  await page.waitForSelector(SEL)
}

async function runPreview(page: Page): Promise<Frame> {
  await page.click('[data-testid="intelligent-html-run"]')
  return frameOf(page)
}

async function frameOf(page: Page): Promise<Frame> {
  const handle = await page.waitForSelector(FRAME)
  const frame = await handle.contentFrame()
  assert.ok(frame)
  return frame
}

const attr = (page: Page, name: string) => page.locator(SEL).getAttribute(name)
const ui = (page: Page) => page.evaluate(() => (window as unknown as { __ui: { states: Record<string, unknown>[]; actions: { id: string; state: Record<string, unknown> }[] } }).__ui)
const nonceOf = async (page: Page) => (/var NONCE="([0-9a-f]{32})"/.exec((await page.locator(FRAME).getAttribute('srcdoc')) ?? '') ?? [])[1]
/** the info panel's CPU sentence (IntelligentHtml.tsx), as the person reads it */
const CPU_HINT = 'When the app remains responsive, an unresponsive preview is stopped. In some browsers, a long script can freeze this tab, including its Stop control.'
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

const SPLIT = `<h3>Dinner split</h3>
<label>Total <input id="total" type="number"></label> <label>People <input id="people" type="number"></label>
<p>Each pays <output id="each"></output></p>
<script>
const s = oasisUI.getState(); const total = document.getElementById('total'), people = document.getElementById('people'), each = document.getElementById('each')
total.value = s.total; people.value = s.people
function show() { const t = Number(total.value), p = Math.max(1, Number(people.value)); each.textContent = (t / p).toFixed(2); oasisUI.setState({ total: t, people: p, each: Number((t / p).toFixed(2)) }) }
total.addEventListener('input', show); people.addEventListener('input', show); each.textContent = (s.total / s.people).toFixed(2)
</script>`

test('runs only when asked, from the stored state; the frame is sandboxed; its state comes back coalesced and restores', async () => {
  const page = await hostPage()
  await mount(page, { html: SPLIT, title: 'Dinner split', initialState: { total: 120, people: 3, junk: { nested: 1 } }, fallback: 'Total 120 for 3: 40 each.' })
  assert.equal(await attr(page, 'data-status'), 'idle')
  assert.equal(await page.locator(FRAME).count(), 0, 'nothing runs before Run')
  assert.match(await page.locator('[data-testid="intelligent-html-fallback"]').innerText(), /40 each/)
  const frame = await runPreview(page)
  assert.equal(await attr(page, 'data-status'), 'running')
  await frame.waitForFunction(() => document.getElementById('each')?.textContent === '40.00')
  // the iframe as the host made it
  const el = await page.locator(FRAME).evaluate((f: HTMLIFrameElement) => ({
    sandbox: f.getAttribute('sandbox'), allow: f.getAttribute('allow'), referrer: f.referrerPolicy, src: f.getAttribute('src'),
    credentialless: (f as HTMLIFrameElement & { credentialless?: boolean }).credentialless ?? null, csp: /http-equiv="Content-Security-Policy" content="default-src 'none'/.test(f.srcdoc),
  }))
  assert.equal(el.sandbox, 'allow-scripts')
  assert.equal(el.src, null, 'srcdoc only')
  assert.equal(el.referrer, 'no-referrer')
  if (await page.evaluate(() => 'credentialless' in HTMLIFrameElement.prototype)) assert.equal(el.credentialless, true)
  assert.ok(el.csp)
  assert.match(el.allow ?? '', /camera 'none'/)
  assert.equal(await frame.evaluate(() => origin), 'null', 'an opaque origin')
  // typing in the frame: the frame recomputes at once, the host hears the state, coalesced
  await frame.locator('#total').fill('150')
  await frame.waitForFunction(() => document.getElementById('each')?.textContent === '50.00')
  await page.waitForFunction(() => (window as unknown as { __ui: { states: Array<{ total?: number }> } }).__ui.states.at(-1)?.total === 150)
  const states = (await ui(page)).states
  assert.deepEqual(states.at(-1), { total: 150, people: 3, each: 50 })
  assert.ok(!('junk' in states.at(-1)!), 'what the bridge does not allow never reached the frame')
  await frame.locator('#people').pressSequentially('0')   // 30 people, typed one key at a time
  await page.waitForFunction(() => (window as unknown as { __ui: { states: Array<{ people?: number }> } }).__ui.states.at(-1)?.people === 30)
  // a refresh: the owner hands back what it stored; the preview starts from it
  const stored = (await ui(page)).states.at(-1)
  await page.reload()
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true)
  await mount(page, { html: SPLIT, title: 'Dinner split', initialState: stored })
  const again = await runPreview(page)
  await again.waitForFunction(() => (document.getElementById('total') as HTMLInputElement | null)?.value === '150' && (document.getElementById('people') as HTMLInputElement | null)?.value === '30')
  await page.close()
})

/** Everything a page might try, each reported back as data through the bridge. */
const PROBE = (out: string, hostUrl: string, udpPort: number, outs: string) => `
<link rel="stylesheet" href="${out}/style.css"><link rel="prefetch" href="${out}/prefetch"><link rel="dns-prefetch" href="//probe.invalid">
<script src="${out}/script.js"></script>
<img src="${out}/img.png"><div style="background:url(${out}/bg.png);width:4px;height:4px"></div>
<style>@font-face { font-family: x; src: url(${out}/font.woff) } p { font-family: x }</style>
<iframe src="${out}/frame"></iframe><object data="${out}/object"></object>
<form id="f" action="${out}/form"><input name="a" value="1"></form>
<p id="done">probe</p>
<script>
const r = {}
const tryIt = (k, f) => { try { const v = f(); r[k] = 'ok:' + String(v).slice(0, 60) } catch (e) { r[k] = e.name } }
tryIt('parentDom', () => parent.document.title)
tryIt('topDom', () => top.document.cookie)
tryIt('frameElement', () => String(window.frameElement))
tryIt('localStorage', () => localStorage.getItem('oasis-code.token'))
tryIt('sessionStorage', () => sessionStorage.length)
tryIt('cookie', () => document.cookie)
tryIt('indexedDB', () => indexedDB.open('x') && 'opened')
tryIt('eval', () => eval('1+1'))
tryIt('Function', () => new Function('return 1')())
tryIt('open', () => window.open('${out}/popup'))
tryIt('topNav', () => { top.location.href = '${out}/top'; return 'assigned' })
tryIt('rtc', () => new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udpPort}' }] }))
tryIt('worker', () => new Worker(URL.createObjectURL(new Blob(['postMessage(1)']))))
tryIt('form', () => { document.getElementById('f').submit(); return 'submitted' })
tryIt('beacon', () => navigator.sendBeacon('${out}/beacon', 'x'))
tryIt('ws', () => new WebSocket('${out.replace('http', 'ws')}/ws'))
tryIt('es', () => new EventSource('${out}/es'))
tryIt('xhr', () => { const x = new XMLHttpRequest(); x.open('GET', '${out}/xhr'); x.send(); return 'sent' })
tryIt('nested', () => { const f = document.createElement('iframe'); f.srcdoc = '<script>try{new RTCPeerConnection({iceServers:[{urls:"stun:127.0.0.1:${udpPort}"}]}).createDataChannel("x")}catch(e){}fetch("${out}/nested").catch(()=>0)<\\/script>'; document.body.append(f); return document.querySelectorAll('iframe,object').length })
const fetches = [['fetchOut', '${out}/fetch'], ['fetchHost', '${hostUrl}/api/sessions'], ['fetchRel', '/api/sessions']${outs ? `, ['fetchTls', '${outs}/fetch-tls']` : ''}]
Promise.all(fetches.map(([k, u]) => fetch(u, { credentials: 'include' }).then(() => { r[k] = 'ok' }, (e) => { r[k] = e.name })))
  .then(() => { r.framesLater = document.querySelectorAll('iframe,frame,object,embed').length })
  .then(() => import('${out}/module.js').then(() => { r.import = 'ok' }, (e) => { r.import = e.name }))
  .then(() => { parent.postMessage({ channel: 'oasis-ui-sandbox', v: ${UI_SANDBOX_VERSION}, nonce: '0'.repeat(32), type: 'action', payload: { actionId: 'apply', state: {}, gesture: true } }, '*'); r.done = 'yes'; oasisUI.setState(r) })
</script>`

test("the frame reaches nothing of the host's and sends no request to the network", async (t) => {
  const page = await hostPage()
  assert.equal(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), APP_POLICY, "under the app's own page policy")
  const before = { out: outsideHits.length, api: hostApiHits.length, udp: udpPackets, conns: connectionCount() }
  await mount(page, { html: PROBE(OUT, HOST, UDP_PORT, OUTS), title: 'Probe' })
  await runPreview(page)
  await page.waitForFunction(() => (window as unknown as { __ui: { states: Array<{ done?: string }> } }).__ui.states.at(-1)?.done === 'yes', null, { timeout: 15_000 })
  await settle(2_500)   // time for any ICE/STUN packet or late request
  const r = (await ui(page)).states.at(-1) as Record<string, string>
  for (const k of ['parentDom', 'topDom', 'localStorage', 'sessionStorage', 'cookie', 'eval', 'Function', 'topNav', 'indexedDB']) assert.match(r[k]!, /^(SecurityError|EvalError)$/, `${k}: ${r[k]}`)
  assert.equal(r.frameElement, 'ok:null')
  assert.equal(r.open, 'ok:null', 'no popup')
  assert.equal(r.rtc, 'TypeError', 'no RTCPeerConnection')
  assert.match(r.worker!, /SecurityError|ok/)   // created or not, it may fetch nothing (worker-src 'none' — counted below)
  for (const k of ['fetchOut', 'fetchHost', 'fetchRel', ...(OUTS ? ['fetchTls'] : [])]) assert.equal(r[k], 'TypeError', k)
  assert.equal(r.import, 'TypeError')
  assert.equal(r.framesLater, 0, 'nested frames (written in the HTML, appended by script) removed before they load')
  assert.deepEqual(outsideHits.slice(before.out), [], 'no request reached the outside server')
  assert.deepEqual(hostApiHits.slice(before.api), [], "no request reached the host's API")
  assert.equal(udpPackets - before.udp, 0, 'no WebRTC packet')
  // the nested <iframe src> the HTML writes is refused by the frame's own frame-src, but Chromium may open a TCP
  // connection to its address first (a navigation preconnect): recorded as an observation, not asserted away
  t.diagnostic(`outside TCP connections during the probe (not requests): ${JSON.stringify(newConnections(before.conns))}`)
  // the host is as it was
  assert.equal(await page.title(), 'host')
  assert.equal(await page.evaluate(() => localStorage.getItem('oasis-code.token')), 'host-token')
  // the forged action (a guessed nonce) was not taken
  assert.deepEqual((await ui(page)).actions, [])
  assert.equal(await attr(page, 'data-status'), 'running')
  await page.close()
})

const ACTIONS = `<button id="apply" onclick="oasisUI.action('apply')">Apply</button>
<button id="other" onclick="oasisUI.action('delete_everything')">Other</button>
<input id="note" value="keep me" oninput="oasisUI.setState({ note: this.value })">
<script>oasisUI.setState({ note: 'keep me' }); oasisUI.action('apply')   // at load: no click</script>`

test("an action is taken only on the person's click, only a declared one, not too fast — and it is a proposal", async () => {
  const page = await hostPage()
  await mount(page, { html: ACTIONS, title: 'Choose', actionIds: ['apply'] })
  const frame = await runPreview(page)
  await page.waitForFunction(() => document.querySelector('[data-testid="intelligent-html"]')?.getAttribute('data-last-reject') === 'action without a click in the preview')
  assert.deepEqual((await ui(page)).actions, [])
  await frame.click('#apply')
  await page.waitForFunction(() => (window as unknown as { __ui: { actions: unknown[] } }).__ui.actions.length === 1)
  assert.deepEqual((await ui(page)).actions, [{ id: 'apply', state: { note: 'keep me' } }])
  assert.match(await page.locator('[data-testid="intelligent-html-status"]').innerText(), /Proposed “apply” — nothing is sent until you send it/)
  await frame.click('#apply')   // at once again
  await page.waitForFunction(() => document.querySelector('[data-testid="intelligent-html"]')?.getAttribute('data-last-reject') === 'actions too fast')
  await settle(1_300)
  await frame.click('#other')
  await page.waitForFunction(() => document.querySelector('[data-testid="intelligent-html"]')?.getAttribute('data-last-reject') === 'unknown action delete_everything')
  assert.equal((await ui(page)).actions.length, 1)
  await page.close()
})

test('forged and stale messages: another frame, the host itself, an old nonce — none is taken; the nonce is not in the DOM', async () => {
  const page = await hostPage()
  await mount(page, { html: '<p id="p">quiet</p>', title: 'Quiet' })
  const frame = await runPreview(page)
  await frame.waitForSelector('#p')
  const nonce = (await nonceOf(page))!
  assert.match(nonce, /^[0-9a-f]{32}$/)
  // what the model's code could read of its own document does not hold the nonce (the bootstrap removed itself)
  assert.equal(await frame.evaluate((n) => document.documentElement.outerHTML.includes(n) || [...document.scripts].some((s) => s.text.includes(n)), nonce), false)
  const forged = { channel: 'oasis-ui-sandbox', v: UI_SANDBOX_VERSION, nonce, type: 'action', payload: { actionId: 'apply', state: { x: 1 }, gesture: true } }
  // another sandboxed frame on the page, holding the right nonce
  await page.evaluate((msg) => new Promise<void>((resolve) => {
    const f = document.createElement('iframe')
    f.setAttribute('sandbox', 'allow-scripts')
    f.srcdoc = `<script>parent.postMessage(${JSON.stringify(msg)}, '*')<\/script>`
    f.onload = () => resolve()
    document.body.append(f)
  }), forged)
  // the host window itself
  await page.evaluate((msg) => window.postMessage(msg, '*'), forged)
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="intelligent-html"]')?.getAttribute('data-rejected')) >= 2)
  await settle(1_200)
  assert.equal(await attr(page, 'data-last-reject'), 'message from another window')
  // a new frame (Reset) has a new nonce; the frame's own old nonce is refused
  await page.click('[data-testid="intelligent-html-reset"]')
  await page.waitForFunction((old) => !document.querySelector('[data-testid="intelligent-html-frame"]')?.getAttribute('srcdoc')?.includes(old), nonce)
  const fresh = await frameOf(page)
  await fresh.waitForSelector('#p')
  assert.notEqual(await nonceOf(page), nonce)
  await fresh.evaluate((msg) => parent.postMessage({ ...msg, type: 'state', payload: { state: { stale: true } } }, '*'), forged)
  await page.waitForFunction(() => document.querySelector('[data-testid="intelligent-html"]')?.getAttribute('data-last-reject') === 'nonce', null, { timeout: 5_000 })
  assert.deepEqual((await ui(page)).actions, [])
  assert.ok(!(await ui(page)).states.some((s) => 'stale' in s || 'x' in s))
  await page.close()
})

test("the app's page policy is frame-src 'none' and nothing else: the host keeps its own requests; the preview's srcdoc still runs", async () => {
  // what frontend/index.html declares is what this harness serves (one policy, before any script or stylesheet)
  assert.equal(APP_POLICY, "frame-src 'none'")
  assert.equal(INDEX_HTML.match(/http-equiv="Content-Security-Policy"/gi)?.length, 1)
  assert.ok(INDEX_HTML.indexOf('Content-Security-Policy') < INDEX_HTML.search(/<script|<link rel="stylesheet"/), 'the policy comes before what it governs')
  const page = await hostPage()
  assert.equal(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), APP_POLICY)
  // the host itself: its API (connect), its scripts and styles are not restricted by it
  assert.equal(await page.evaluate(async () => (await (await fetch('/api/own')).json() as { secret: string }).secret), 'host-api')
  await mount(page, { html: '<p id="p">runs</p><script>oasisUI.setState({ ran: true })</script>', title: 'Runs' })
  const frame = await runPreview(page)
  await frame.waitForSelector('#p')
  await page.waitForFunction(() => (window as unknown as { __ui: { states: Array<{ ran?: boolean }> } }).__ui.states.at(-1)?.ran === true)
  assert.equal(await frame.evaluate(() => origin), 'null')
  assert.deepEqual(await violations(page), [], 'a srcdoc frame is not a URL load: the policy does not touch it')
  await page.close()
})

/** Ways a page navigates its own frame; target is where it goes. */
const NAVIGATIONS = [
  ['a script', (u: string) => `<p>loading</p><script>setTimeout(() => { location.href = '${u}?d=' + encodeURIComponent(JSON.stringify(oasisUI.getState())) }, 300)</script>`],
  ['a meta refresh', (u: string) => `<meta http-equiv="refresh" content="0;url=${u}">`],
  ['a clicked link', (u: string) => `<a id="go" href="${u}">go</a>`],
  ['a script before the page finished', (u: string) => `<script>location.replace('${u}')</script><p>never</p>`],
] as const
type NavCase = { name: string; html: (u: string) => string; scheme: 'http' | 'https' }
const NAV_CASES: NavCase[] = [
  ...NAVIGATIONS.map(([name, html]) => ({ name, html, scheme: 'http' as const })),
  ...NAVIGATIONS.filter(([name]) => name !== 'a script before the page finished').map(([name, html]) => ({ name, html, scheme: 'https' as const })),
]
/** the clicked link over HTTP goes to the host's own API (a same-site URL: the cookie question is sharpest there) */
const navTarget = (c: NavCase) => c.scheme === 'https' ? `${OUTS}/nav-${c.name.replace(/\W+/g, '-')}-tls`
  : c.name === 'a clicked link' ? `${HOST}/api/navigated` : `${OUT}/nav-${c.name.replace(/\W+/g, '-')}`
const navHits = (c: NavCase, from: { out: number; api: number }) => c.scheme === 'http' && c.name === 'a clicked link' ? hostApiHits.slice(from.api) : outsideHits.slice(from.out)

async function navigateAway(page: Page, c: NavCase) {
  await mount(page, { html: c.html(navTarget(c)), title: 'Nav', initialState: { secret_note: 'typed by the person' } })
  // a meta refresh of 0 s may navigate (and the host remove the frame) before the frame can be looked up: only the
  // clicked link needs it
  if (c.name === 'a clicked link') await (await runPreview(page)).click('#go')
  else await page.click('[data-testid="intelligent-html-run"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="intelligent-html"]')?.getAttribute('data-stop-reason') === 'navigated', null, { timeout: 10_000 })
  assert.equal(await page.locator(FRAME).count(), 0, 'the frame is gone')
  assert.equal(await page.locator('[data-testid="intelligent-html-notice"]').innerText(), 'Stopped: the preview tried to navigate away.')
}

for (const c of NAV_CASES) {
  test(`a navigation by ${c.name} (${c.scheme}) under the app's page policy: refused before any HTTP request — no request reaches the outside; the preview stops`, { skip: c.scheme === 'https' && !OPENSSL ? 'no openssl for the HTTPS receiver' : false }, async (t) => {
    if (c.scheme === 'https' && !OUTS) return assert.fail('the HTTPS receiver did not start')
    const page = await hostPage()
    const from = { out: outsideHits.length, api: hostApiHits.length, conns: connectionCount() }
    await navigateAway(page, c)
    await settle(800)
    assert.deepEqual(navHits(c, from), [], 'no request reached the receiver')
    assert.deepEqual(outsideHits.slice(from.out), [], 'nor any outside server')
    // what may still reach it below HTTP: Chromium preconnects for the navigation before the page policy refuses it,
    // so a TCP connection (and, for https, what the preconnect sends on it) can arrive. Recorded, not asserted: it
    // is a known limit of this architecture (docs/intelligent-ui.md), not something the app claims to prevent
    t.diagnostic(`below HTTP for ${navTarget(c)}: ${JSON.stringify(newConnections(from.conns))}`)
    // and it is the page policy that refused it: the host saw its frame-src violation for that address
    const v = await violations(page)
    assert.ok(v.some((x) => x.directive === 'frame-src' && navTarget(c).startsWith(x.blocked)), `frame-src violation for ${navTarget(c)}: ${JSON.stringify(v)}`)
    await page.close()
  })
}

for (const c of NAV_CASES) {
  test(`control, a page without the app's policy (the component reused elsewhere): a navigation by ${c.name} (${c.scheme}) — its one request does leave, without the host's cookie; the preview stops`, { skip: c.scheme === 'https' && !OPENSSL ? 'no openssl for the HTTPS receiver' : false }, async () => {
    if (c.scheme === 'https' && !OUTS) return assert.fail('the HTTPS receiver did not start')
    const page = await hostPage({ policy: false })
    assert.equal(await page.locator('meta[http-equiv="Content-Security-Policy"]').count(), 0)
    const from = { out: outsideHits.length, api: hostApiHits.length }
    await navigateAway(page, c)
    // the component alone cannot stop the navigation's own GET: what the docs say a page without the policy gets
    const hits = navHits(c, from)
    assert.equal(hits.length, 1, `exactly the one request: ${JSON.stringify(hits)}`)
    assert.equal(hits[0]!.cookie, undefined, "no cookie of the host's on it, not even a SameSite=None one (credentialless frame)")
    if (c.name === 'a script') assert.match(hits[0]!.url, /secret_note/, 'what the frame knew can ride on it')
    await settle(500)
    assert.equal(navHits(c, from).length, 1, 'and nothing after it: the frame is gone')
    await page.close()
  })
}

test('a flood of messages stops the preview', async () => {
  const page = await hostPage()
  await mount(page, { html: `<script>for (let i = 0; i < 2000; i++) parent.postMessage({ channel: 'oasis-ui-sandbox', junk: i }, '*')</script>`, title: 'Flood' })
  // the frame may be gone before it could be looked into (the flood stops it at once): only the stop is waited for
  await page.click('[data-testid="intelligent-html-run"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="intelligent-html"]')?.getAttribute('data-stop-reason') === 'flood', null, { timeout: 10_000 })
  assert.equal(await page.locator(FRAME).count(), 0)
  await page.close()
})

test('a busy frame is stopped: by its silence where it runs apart from the host, once it lets go where it shares the thread; one that stops answering is stopped', async () => {
  const page = await hostPage()
  // bounded: 5.5 s of busy work, past the 4 s the host waits for an answer. Chrome and Electron put a sandboxed frame
  // in a process of its own: the host keeps its thread and stops the silent frame. A browser that runs the frame on
  // the host's thread names it by the host's late watchdog tick, once the loop lets go.
  await page.evaluate(() => {
    const w = window as unknown as { __maxGap: number }
    w.__maxGap = 0
    let last = performance.now()
    setInterval(() => { const n = performance.now(); w.__maxGap = Math.max(w.__maxGap, n - last); last = n }, 100)
  })
  await mount(page, { html: `<script>setTimeout(() => { const t = Date.now(); while (Date.now() - t < 5500) {} }, 300)</script>`, title: 'Busy' })
  await runPreview(page)
  await page.waitForFunction(() => ['unresponsive', 'stalled'].includes(document.querySelector('[data-testid="intelligent-html"]')?.getAttribute('data-stop-reason') ?? ''), null, { timeout: 15_000 })
  const reason = await page.locator('[data-testid="intelligent-html"]').getAttribute('data-stop-reason')
  const maxGap = await page.evaluate(() => (window as unknown as { __maxGap: number }).__maxGap)
  assert.equal(reason, maxGap < 1_000 ? 'unresponsive' : 'stalled', `host's longest timer gap ${Math.round(maxGap)} ms`)
  assert.equal(await page.locator(FRAME).count(), 0)
  // a page that replaces its own document (and with it the bootstrap's listener) stops answering the heartbeat
  await mount(page, { html: `<script>setTimeout(() => { document.open(); document.write('<p id=gone>replaced</p>'); document.close() }, 300)</script>`, title: 'Silent' })
  await page.click('[data-testid="intelligent-html-run"]')
  await page.waitForFunction(() => ['unresponsive', 'navigated'].includes(document.querySelector('[data-testid="intelligent-html"]')?.getAttribute('data-stop-reason') ?? ''), null, { timeout: 15_000 })
  await page.close()
})

test('read-only and oversized HTML run nothing; the fallback stands', async () => {
  const page = await hostPage()
  const beforeOut = outsideHits.length
  await mount(page, { html: `<img src="${OUT}/readonly.png"><script>location.href='${OUT}/readonly'</script>`, title: 'Replay', readOnly: true, fallback: 'Budget: 3 rows, total 420.' })
  assert.equal(await attr(page, 'data-status'), 'read-only')
  assert.equal(await page.locator('[data-testid="intelligent-html-run"]').count(), 0)
  assert.match(await page.locator('[data-testid="intelligent-html-notice"]').innerText(), /does not run here/)
  assert.match(await page.locator('[data-testid="intelligent-html-fallback"]').innerText(), /total 420/)
  await mount(page, { html: 'x'.repeat(60_001), title: 'Huge' })
  assert.equal(await attr(page, 'data-status'), 'too-large')
  assert.equal(await page.locator(FRAME).count(), 0)
  assert.match(await page.locator('[data-testid="intelligent-html-notice"]').innerText(), /longer than 60,000 characters/)
  // the contract counts UTF-16 code units: 59,000 Chinese characters are within it, not three times over
  await mount(page, { html: `<p>${'中'.repeat(59_000)}</p>`, title: '长文' })
  assert.equal(await attr(page, 'data-status'), 'idle')
  assert.equal(await page.locator('[data-testid="intelligent-html-cpu-hint"]').innerText(), CPU_HINT)
  await settle(800)
  assert.equal(outsideHits.length, beforeOut)
  await page.close()
})

test('stop, run again, a new revision, unmount: a new nonce each frame, the state kept, no listener left behind', async () => {
  const page = await hostPage()
  const baseline = await page.evaluate(() => (window as unknown as { __listeners: () => number }).__listeners())
  const counter = (label: string) => `<p id="label">${label}</p><button id="inc" onclick="oasisUI.setState({ n: oasisUI.getState().n + 1 }); document.getElementById('n').textContent = oasisUI.getState().n">+</button><span id="n"></span><script>document.getElementById('n').textContent = oasisUI.getState().n</script>`
  await mount(page, { html: counter('v1'), title: 'Counter', initialState: { n: 1 } })
  let frame = await runPreview(page)
  const n1 = await nonceOf(page)
  await frame.click('#inc')
  await frame.waitForFunction(() => document.getElementById('n')?.textContent === '2')
  await page.click('[data-testid="intelligent-html-stop"]')
  assert.equal(await attr(page, 'data-stop-reason'), 'stopped')
  assert.equal(await page.locator(FRAME).count(), 0)
  frame = await runPreview(page)
  const n2 = await nonceOf(page)
  await frame.waitForFunction(() => document.getElementById('n')?.textContent === '2')   // the state the person had
  // the model publishes a new revision while it runs: a new frame with the same state
  await mount(page, { html: counter('v2'), title: 'Counter', initialState: { n: 1 } })
  await page.waitForFunction((old) => !document.querySelector('[data-testid="intelligent-html-frame"]')?.getAttribute('srcdoc')?.includes(old!), n2)
  frame = await frameOf(page)
  await frame.waitForFunction(() => document.getElementById('label')?.textContent === 'v2' && document.getElementById('n')?.textContent === '2')
  const n3 = await nonceOf(page)
  assert.equal(new Set([n1, n2, n3]).size, 3)
  await page.evaluate(() => (window as unknown as { __unmount: () => void }).__unmount())
  await page.waitForFunction((b) => (window as unknown as { __listeners: () => number }).__listeners() === b, baseline)
  await page.close()
})

test("the docs' HTML example (a savings simulator) runs in the sandbox: sliders recompute, state comes back, its action is a proposal", async () => {
  const examples = JSON.parse(readFileSync(join(FRONTEND, '../docs/intelligent-ui-examples.json'), 'utf8')) as { examples: Array<{ spec: { kind: string; title: string; html: string; fallback: string; initial_state: Record<string, unknown>; actions: Array<{ id: string }> } }> }
  const spec = examples.examples.find((e) => e.spec.kind === 'html')!.spec
  const page = await hostPage()
  const before = outsideHits.length
  await mount(page, { html: spec.html, title: spec.title, initialState: spec.initial_state, fallback: spec.fallback, actionIds: spec.actions.map((a) => a.id) })
  const frame = await runPreview(page)
  await frame.waitForFunction(() => Number(document.getElementById('final')?.textContent?.replace(/\D/g, '')) > 700_000)
  await page.waitForFunction(() => (window as unknown as { __ui: { states: Array<{ final?: number }> } }).__ui.states.at(-1)?.final !== undefined)
  const first = (await ui(page)).states.at(-1)!
  assert.equal(first.monthly, 2000)
  assert.ok(Math.abs((first.final as number) - 733_000) < 2_000, String(first.final))
  await frame.locator('#years').fill('30')
  await page.waitForFunction(() => (window as unknown as { __ui: { states: Array<{ years?: number }> } }).__ui.states.at(-1)?.years === 30)
  assert.ok(((await ui(page)).states.at(-1)!.final as number) > 1_300_000)
  await frame.click('#explain')
  await page.waitForFunction(() => (window as unknown as { __ui: { actions: unknown[] } }).__ui.actions.length === 1)
  assert.equal((await ui(page)).actions[0]!.id, 'explain')
  assert.equal((await ui(page)).actions[0]!.state.years, 30)
  assert.equal(outsideHits.length, before)
  await page.close()
})

test('turning read-only removes the frame in the same commit; no callback after it; running again is a new frame', async () => {
  const page = await hostPage()
  await mount(page, { html: `<p id="t">ticking</p><script>let n = 0; setInterval(() => oasisUI.setState({ n: ++n }), 60)</script>`, title: 'Ticker' })
  const frame = await runPreview(page)
  await frame.waitForSelector('#t')
  await page.waitForFunction(() => (window as unknown as { __ui: { states: unknown[] } }).__ui.states.length >= 2)
  const oldNonce = await nonceOf(page)
  // watch every DOM change: a read-only card must never hold an iframe, not for one commit
  await page.evaluate(() => {
    const w = window as unknown as { __overlap: boolean }
    w.__overlap = false
    new MutationObserver(() => { if (document.querySelector('[data-status="read-only"] iframe')) w.__overlap = true })
      .observe(document.body, { subtree: true, childList: true, attributes: true })
  })
  await page.evaluate(() => (window as unknown as { __setProps: (i: number, p: unknown) => void }).__setProps(0, { readOnly: true }))
  await page.waitForFunction(() => document.querySelector('[data-testid="intelligent-html"]')?.getAttribute('data-status') === 'read-only')
  assert.equal(await page.locator(FRAME).count(), 0)
  const after = (await ui(page)).states.length
  await settle(1_200)
  assert.equal((await ui(page)).states.length, after, 'no onStateChange once read-only (not even the pending flush)')
  assert.equal(await page.evaluate(() => (window as unknown as { __overlap: boolean }).__overlap), false, 'no commit showed a read-only card with a frame')
  await page.evaluate(() => (window as unknown as { __setProps: (i: number, p: unknown) => void }).__setProps(0, { readOnly: false }))
  assert.equal(await attr(page, 'data-status'), 'idle', 'it does not resume by itself')
  await runPreview(page)
  assert.notEqual(await nonceOf(page), oldNonce)
  await page.close()
})

test('two previews at once: each hears only its own frame, keeps its own state and actions, and reports nothing', async () => {
  const page = await hostPage()
  const card = (label: string) => `<p>${label}</p><input id="v" oninput="oasisUI.setState({ v: this.value })"><button id="go" onclick="oasisUI.action('go')">go</button>`
  await page.evaluate((html) => (window as unknown as { __mountMany: (l: unknown[]) => void }).__mountMany(html.map((h, i) => ({ html: h, title: `Card ${i}`, actionIds: ['go'] }))), [card('one'), card('two')])
  for (const i of [0, 1]) await page.locator(SEL).nth(i).locator('[data-testid="intelligent-html-run"]').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="intelligent-html-frame"]').length === 2)
  const frames = await Promise.all([0, 1].map(async (i) => (await page.locator(FRAME).nth(i).elementHandle())!.contentFrame()))
  await frames[0]!.locator('#v').fill('first')
  await frames[1]!.locator('#v').fill('second')
  await frames[1]!.click('#go')
  await page.waitForFunction(() => (window as unknown as { __uis: Array<{ actions: unknown[] }> }).__uis[1]!.actions.length === 1)
  await settle(3_500)   // several heartbeats of both: their ready/pong/state/resize traffic crosses on the one window
  const uis = await page.evaluate(() => (window as unknown as { __uis: Array<{ states: Array<{ v?: string }>; actions: Array<{ id: string; state: { v?: string } }> }> }).__uis)
  assert.deepEqual(uis[0]!.states.map((x) => x.v).filter(Boolean).at(-1), 'first')
  assert.ok(uis[0]!.states.every((x) => x.v !== 'second'))
  assert.ok(uis[1]!.states.every((x) => x.v !== 'first'))
  assert.deepEqual(uis[0]!.actions, [])
  assert.deepEqual(uis[1]!.actions, [{ id: 'go', state: { v: 'second' } }])
  const cards = page.locator(SEL)
  for (const i of [0, 1]) {
    assert.equal(await cards.nth(i).getAttribute('data-rejected'), '0', `card ${i} counted nothing as suspicious`)
    assert.equal(await cards.nth(i).getAttribute('data-status'), 'running')
  }
  assert.equal(await page.locator('.uisbx-warn').count(), 0, 'no "Ignored" notice on either')
  await page.close()
})

test("a state the contract would refuse is refused in the frame: five 4000-character strings, nulls kept", async () => {
  const page = await hostPage()
  await mount(page, { html: `<script>
    const big = 'x'.repeat(4000)
    let err = 'none'
    try { oasisUI.setState({ a: big, b: big, c: big, d: big, e: big }) } catch (e) { err = e.name }
    let merged = 'none'
    oasisUI.setState({ a: big, b: big, c: big })
    try { oasisUI.setState({ d: big }) } catch (e) { merged = e.name }
    oasisUI.setState({ a: null, b: null, c: null, err, merged, kept: [null, 1] })
  </script>`, title: 'Budget' })
  await runPreview(page)
  await page.waitForFunction(() => (window as unknown as { __ui: { states: Array<{ err?: string }> } }).__ui.states.some((x) => x.err))
  const states = (await ui(page)).states
  assert.deepEqual(states.at(-1), { a: null, b: null, c: null, err: 'RangeError', merged: 'RangeError', kept: [null, 1] })
  for (const st of states) assert.ok(JSON.stringify(st).length <= 16_000, 'nothing over the contract budget reached the owner')
  assert.equal(await attr(page, 'data-rejected'), '0')
  await page.close()
})

// ---- the host's theme in the frame: the interface of state/uiTheme.ts + themeMessage (skipped, by name, without it) ----

/** Plain semantic HTML with no styling of its own: an input to type into, a local counter, a birth mark (a document
 *  loaded again would have another). */
const THEMED = `<h3 id="h">Heading</h3><p id="p">Body text</p>
<label>Name <input id="name"></label> <button id="b">Go</button> <button id="bp" type="submit">Save</button> <select id="s"><option>one</option></select>
<textarea id="t"></textarea> <span id="c">0</span>
<script>window.__born = Math.random(); let n = 0; setInterval(() => { document.getElementById('c').textContent = String(++n) }, 40)</script>`

type Look = { body: Record<string, string>; input: Record<string, string>; button: Record<string, string>; primary: Record<string, string> }
/** What text and controls compute to: on the host (sel null: elements made for the measure under the app's own rules,
 *  inside an intelligent-UI surface's scope (`.uis`: the face, radii, shadows and accent a surface's content reads,
 *  index.css), its text in the page's ink — a plain input, and the host's real action buttons, `.thread-btn` and
 *  `.thread-btn.primary`, which a native surface's buttons use too) or in the frame (the model's own unstyled
 *  elements: an input, a button, a submit button). One function, evaluated on either side; nothing here states what
 *  the values should be. */
function lookOf(sel: { input: string; button: string; primary: string } | null): Look {
  const box = sel ? null : document.createElement('div')
  if (box) { box.className = 'uis'; box.style.cssText = 'position:absolute;left:-10000px;top:0;color:var(--ink)'; box.innerHTML = '<input><button class="thread-btn">b</button><button class="thread-btn primary">p</button>'; document.body.append(box) }
  const pick = (el: Element, keys: string[]) => { const cs = getComputedStyle(el) as unknown as Record<string, string>; return Object.fromEntries(keys.map((k) => [k, cs[k]!])) }
  const BUTTON = ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'height', 'paddingLeft', 'paddingRight', 'borderTopLeftRadius', 'backgroundColor', 'color', 'boxShadow']
  const look = {
    body: pick(box ?? document.body, ['color', 'fontFamily', 'fontSize', 'lineHeight', 'letterSpacing']),
    input: pick(box ? box.querySelector('input')! : document.querySelector(sel!.input)!, ['color', 'backgroundColor', 'borderRadius', 'fontFamily', 'fontSize', 'letterSpacing']),
    button: pick(box ? box.querySelector('button.thread-btn:not(.primary)')! : document.querySelector(sel!.button)!, BUTTON),
    primary: pick(box ? box.querySelector('button.primary')! : document.querySelector(sel!.primary)!, BUTTON),
  }
  box?.remove()
  return look
}
const hostLook = (page: Page) => page.evaluate(lookOf, null)
const frameLook = (frame: Frame) => frame.evaluate(lookOf, { input: '#name', button: '#b', primary: '#bp' })
const frameColor = (frame: Frame) => frame.evaluate(() => getComputedStyle(document.body).color)

/** the frame matches the host: text, typography and controls (waits for a theme message to land) */
async function matchesHost(page: Page, frame: Frame, label: string) {
  const host = await hostLook(page)
  await frame.waitForFunction((c) => getComputedStyle(document.body).color === c, host.body.color, { timeout: 5_000 })
    .catch(() => undefined)
  // the buttons ease their background over 0.12 s, as the host's do: compare once that has settled
  const want = JSON.stringify(host)
  for (let i = 0; i < 25 && JSON.stringify(await frameLook(frame)) !== want; i++) await settle(100)
  assert.deepEqual(await frameLook(frame), host, `${label}: the frame's text and controls compute as the host's`)
  return host
}

const running = (page: Page) => attr(page, 'data-status')

test('host theme: light → dark → light, and a root/body style change — the same frame follows, nothing reloads, no callback', async () => {
  const page = await hostPage({ appCss: true })
  await systemScheme(page, 'light')
  await mount(page, { html: THEMED, title: 'Themed', initialState: {} })
  const frame = await runPreview(page)
  await frame.waitForSelector('#c')
  const light = await matchesHost(page, frame, 'light at start (captured for this run)')
  assert.equal(light.body.fontSize, '13.5px')
  const nonce = await nonceOf(page)
  const srcdoc = await page.locator(FRAME).getAttribute('srcdoc')
  await page.locator(FRAME).evaluate((f) => { (f as unknown as { __mark: string }).__mark = 'the same element' })
  const born = await frame.evaluate(() => (window as unknown as { __born: number }).__born)
  await frame.locator('#name').fill('typed')
  await frame.focus('#name')
  const before = await ui(page)
  const kept = async (label: string) => {
    assert.equal(await page.locator(FRAME).evaluate((f) => (f as unknown as { __mark?: string }).__mark), 'the same element', `${label}: the same iframe`)
    assert.equal(await nonceOf(page), nonce, `${label}: the same nonce`)
    assert.equal(await page.locator(FRAME).getAttribute('srcdoc'), srcdoc, `${label}: srcdoc not rebuilt`)
    assert.equal(await frame.evaluate(() => (window as unknown as { __born: number }).__born), born, `${label}: the same document`)
    assert.equal(await frame.locator('#name').inputValue(), 'typed', `${label}: the input kept`)
    assert.equal(await frame.evaluate(() => document.activeElement?.id), 'name', `${label}: the focus kept`)
    const c = Number(await frame.locator('#c').innerText())
    await frame.waitForFunction((x) => Number(document.getElementById('c')!.textContent) > x, c)
    assert.ok(c > 5, `${label}: the local counter kept counting (${c})`)
    assert.equal(await running(page), 'running')
  }
  await systemScheme(page, 'dark')
  const dark = await matchesHost(page, frame, 'dark')
  assert.notEqual(dark.body.color, light.body.color, 'the host did change')
  await kept('dark')
  await systemScheme(page, 'light')
  assert.deepEqual(await matchesHost(page, frame, 'light again'), light)
  await kept('light again')
  // the root's inline style and a body class: the same path (an observer on the host, a theme message to the frame)
  await page.evaluate(() => document.documentElement.style.setProperty('--ink', 'rgb(1, 2, 3)'))
  assert.equal((await matchesHost(page, frame, 'root style')).body.color, 'rgb(1, 2, 3)')
  await page.evaluate(() => {
    const st = document.createElement('style'); st.textContent = 'body.e2e-alt { --ink: rgb(4, 5, 6) }'; document.head.append(st)
    document.body.classList.add('e2e-alt')
  })
  assert.equal((await matchesHost(page, frame, 'body class')).body.color, 'rgb(4, 5, 6)')
  await page.evaluate(() => { document.body.classList.remove('e2e-alt'); document.documentElement.style.removeProperty('--ink') })
  assert.deepEqual(await matchesHost(page, frame, 'restored'), light)
  await kept('restored')
  // a theme message is the host's word to the frame: nothing comes back for it
  const after = await ui(page)
  assert.deepEqual(after.states.length, before.states.length, 'no onStateChange for a theme change')
  assert.deepEqual(after.actions, [])
  assert.equal(await attr(page, 'data-rejected'), '0')
  // a new run captures the theme it starts in
  await page.click('[data-testid="intelligent-html-stop"]')
  await systemScheme(page, 'dark')
  const again = await runPreview(page)
  await again.waitForSelector('#c')
  assert.deepEqual(await matchesHost(page, again, 'a new run in dark'), dark)
  await page.close()
})

test('host theme: an explicit choice in Settings (light → claude → dark) reaches the running frame at once, nothing rebuilt; the system changing then moves nothing', async () => {
  const page = await hostPage({ appCss: true })
  await page.emulateMedia({ colorScheme: 'light' })
  const choose = (p: string) => page.evaluate((x) => (window as unknown as { __appTheme: { set: (p: string) => void } }).__appTheme.set(x), p)
  await choose('light')
  await mount(page, { html: THEMED, title: 'Themed', initialState: {} })
  const frame = await runPreview(page)
  await frame.waitForSelector('#c')
  const light = await matchesHost(page, frame, 'light')
  const srcdoc = await page.locator(FRAME).getAttribute('srcdoc')
  const nonce = await nonceOf(page)
  const born = await frame.evaluate(() => (window as unknown as { __born: number }).__born)
  await frame.locator('#name').fill('kept')
  const same = async (label: string) => {
    assert.equal(await page.locator(FRAME).getAttribute('srcdoc'), srcdoc, `${label}: srcdoc not rebuilt`)
    assert.equal(await nonceOf(page), nonce, `${label}: the same nonce`)
    assert.equal(await frame.evaluate(() => (window as unknown as { __born: number }).__born), born, `${label}: the same document`)
    assert.equal(await frame.locator('#name').inputValue(), 'kept', `${label}: the input kept`)
    assert.equal(await running(page), 'running')
  }
  await choose('claude')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'claude')
  const claude = await matchesHost(page, frame, 'claude')
  assert.notEqual(claude.body.color, light.body.color, 'claude\'s ink is not light\'s')
  assert.equal(claude.body.color, 'rgb(34, 34, 34)')
  assert.equal(await frame.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light')
  await same('claude')
  await choose('dark')
  const dark = await matchesHost(page, frame, 'dark')
  assert.equal(await frame.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark')
  await same('dark')
  // an explicit dark is not the system's: the system going light and dark again changes nothing
  await page.emulateMedia({ colorScheme: 'light' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.emulateMedia({ colorScheme: 'light' })
  await settle(200)
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
  assert.deepEqual(await matchesHost(page, frame, 'dark, system light'), dark)
  assert.equal(await page.evaluate(() => localStorage.getItem('oasis-code.theme')), 'dark')
  await choose('system')
  assert.deepEqual(await matchesHost(page, frame, 'system (light)'), light)
  assert.equal(await page.evaluate(() => localStorage.getItem('oasis-code.theme')), 'system', 'the choice stays system, not what it resolved to')
  await same('system')
  await page.close()
})

test('host theme: a forged theme message — wrong nonce, another window, a malformed or hostile payload — changes nothing and fetches nothing', async () => {
  const page = await hostPage({ appCss: true })
  await systemScheme(page, 'light')
  await mount(page, { html: THEMED, title: 'Themed' })
  const frame = await runPreview(page)
  await frame.waitForSelector('#c')
  await matchesHost(page, frame, 'start')
  const baseline = await frameColor(frame)
  const nonce = (await nonceOf(page))!
  const from = { out: outsideHits.length, conns: connectionCount(), states: (await ui(page)).states.length }
  const images = await frame.evaluate(() => document.images.length)
  // a theme as the interface makes it, every colour in it painted rgb(1, 2, 3): what a forger would like applied
  const painted = await page.evaluate((n) => {
    const T = (window as unknown as { __theme: { read: () => unknown; normalize: (x: unknown) => unknown; message: (n: string, t: unknown) => Record<string, unknown> } }).__theme
    const paint = (v: unknown): unknown => typeof v === 'string' ? (/^\s*(#|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\()/i.test(v) ? 'rgb(1, 2, 3)' : v)
      : Array.isArray(v) ? v.map(paint) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, paint(x)])) : v
    return T.message(n, T.normalize(paint(T.read())))
  }, nonce)
  assert.deepEqual(Object.keys(painted).sort(), ['channel', 'nonce', 'payload', 'type', 'v'], 'the five-field envelope')
  assert.equal(painted.type, 'theme')
  // hostile strings in every leaf: a declaration break-out, a style-element break-out, a remote font and image
  const hostile = (v: unknown, i = 0): unknown => typeof v === 'string'
    ? [`red; background: url(${OUT}/theme-bg)`, `</style><img src="${OUT}/theme-img">`, `url(${OUT}/theme-font.woff)`, `expression(alert(1))`][i % 4]
    : Array.isArray(v) ? v.map((x, j) => hostile(x, i + j)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x], j) => [k, hostile(x, i + j)])) : v
  const forged: Array<[string, Record<string, unknown>]> = [
    ['wrong nonce', { ...painted, nonce: '0'.repeat(32) }],
    ['hostile payload', { ...painted, payload: hostile(painted.payload) as Record<string, unknown> }],
    ['extra payload key', { ...painted, payload: { ...(painted.payload as Record<string, unknown>), extra: 1 } }],
    ['payload not an object', { ...painted, payload: 'body{color:red}' }],
    ['extra envelope key', { ...painted, extra: 1 }],
    ['wrong version', { ...painted, v: UI_SANDBOX_VERSION + 1 }],
    ['wrong channel', { ...painted, channel: 'other' }],
  ]
  for (const [, msg] of forged) await page.locator(FRAME).evaluate((f, m) => (f as HTMLIFrameElement).contentWindow!.postMessage(m, '*'), msg)
  // another window on the page, holding the right nonce and a well-formed message, posting straight to the preview
  await page.evaluate((msg) => new Promise<void>((resolve) => {
    const preview = document.querySelector('[data-testid="intelligent-html-frame"]') as HTMLIFrameElement
    const idx = Array.from({ length: window.frames.length }, (_, i) => window.frames[i]).indexOf(preview.contentWindow!)
    const f = document.createElement('iframe')
    f.setAttribute('sandbox', 'allow-scripts')
    f.srcdoc = `<script>parent.frames[${idx}].postMessage(${JSON.stringify(msg)}, '*')<\/script>`
    f.onload = () => resolve()
    document.body.append(f)
  }), painted)
  await settle(1_000)
  assert.equal(await frameColor(frame), baseline, 'none of them was applied')
  assert.equal(await frame.evaluate(() => document.images.length), images, 'nothing was written into the document')
  assert.deepEqual(outsideHits.slice(from.out), [], 'nothing fetched')
  assert.deepEqual(newConnections(from.conns), [], 'not even a connection')
  assert.equal(await running(page), 'running')
  assert.equal((await ui(page)).states.length, from.states, 'no callback')
  // the control: the same well-formed message from the host itself, with this frame's nonce, is applied
  await page.locator(FRAME).evaluate((f, m) => (f as HTMLIFrameElement).contentWindow!.postMessage(m, '*'), painted)
  await frame.waitForFunction(() => getComputedStyle(document.body).color === 'rgb(1, 2, 3)', null, { timeout: 5_000 })
  await page.close()
})

test('host theme: narrow, by keyboard, one title and one frame border; manual start; Stop and Reset reachable', async () => {
  const page = await hostPage({ appCss: true, viewport: { width: 360, height: 760 } })
  await mount(page, { html: THEMED, title: 'Surface title', fallback: 'Plain text.' })
  assert.equal(await running(page), 'idle', 'it waits for the person')
  assert.equal(await page.locator(FRAME).count(), 0)
  const focusHost = async (testid: string, key: string) => {
    for (let i = 0; i < 25; i++) {
      if (await page.evaluate((t) => (document.activeElement as HTMLElement | null)?.dataset?.testid === t, testid)) return
      await page.keyboard.press(key)
    }
    assert.fail(`${testid} not reached by ${key}`)
  }
  await focusHost('intelligent-html-run', 'Tab')
  await page.keyboard.press('Enter')
  const frame = await frameOf(page)
  await frame.waitForSelector('#name')
  // into the frame by keyboard, type there
  for (let i = 0; i < 25 && (await frame.evaluate(() => document.activeElement?.id)) !== 'name'; i++) await page.keyboard.press('Tab')
  await page.keyboard.type('kb')
  assert.equal(await frame.locator('#name').inputValue(), 'kb')
  // the card: the title once, no implementation term in the visible chrome, one border around the frame, no overflow
  const card = await page.locator(SEL).evaluate((section) => {
    const iframe = section.querySelector('iframe')!
    const chain: Element[] = []
    for (let el: Element | null = iframe; el && section.contains(el); el = el.parentElement) chain.push(el)
    const ringed = chain.filter((el) => {
      const cs = getComputedStyle(el)
      const border = ['Top', 'Right', 'Bottom', 'Left'].some((s) => parseFloat((cs as unknown as Record<string, string>)[`border${s}Width`]!) > 0 && (cs as unknown as Record<string, string>)[`border${s}Style`] !== 'none')
      return border || cs.boxShadow !== 'none'
    })
    return {
      text: (section as HTMLElement).innerText, ringed: ringed.map((el) => el.tagName + '.' + el.className),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, name: section.getAttribute('aria-label') ?? '',
    }
  })
  assert.equal(card.text.split('Surface title').length - 1, 1, `the title once: ${JSON.stringify(card.text)}`)
  assert.doesNotMatch(card.text, /sandbox/i, 'no implementation term as visible chrome')
  assert.ok(card.ringed.length <= 1, `one border around the frame at most: ${card.ringed.join(', ')}`)
  assert.ok(card.overflow <= 0, `no horizontal overflow at 360 px (${card.overflow})`)
  assert.match(card.name, /Surface title/, 'the card is named for its title')
  // Reset and Stop by keyboard
  await focusHost('intelligent-html-reset', 'Shift+Tab')
  const oldNonce = await nonceOf(page)
  await page.keyboard.press('Enter')
  await page.waitForFunction((old) => !document.querySelector('[data-testid="intelligent-html-frame"]')?.getAttribute('srcdoc')?.includes(old!), oldNonce)
  await focusHost('intelligent-html-stop', 'Tab')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('[data-testid="intelligent-html"]')?.getAttribute('data-stop-reason') === 'stopped')
  assert.equal(await page.locator(FRAME).count(), 0)
  await page.close()
})

// ---- the outside receivers themselves: positive controls for what the tests above count ----

test('the receivers count what does reach them: a real HTTP and HTTPS GET each show a connection, its bytes and the request — the bytes still counted once the socket closed', { skip: OPENSSL ? false : 'no openssl for the HTTPS receiver' }, async () => {
  if (!OUTS) return assert.fail('the HTTPS receiver did not start')
  const from = { out: outsideHits.length, conns: connectionCount() }
  // from Node, one connection each, closed after the answer (no keep-alive agent)
  const get = (mod: typeof http | typeof https, url: string) => new Promise<void>((resolve, reject) => {
    const req = mod.get(url, { agent: false, ...(mod === https ? { rejectUnauthorized: false } : {}) }, (res) => { res.resume(); res.on('end', () => resolve()) })
    req.on('error', reject)
  })
  await get(http, `${OUT}/control-node-http`)
  await get(https, `${OUTS}/control-node-https`)
  await settle(300)
  const node = outsideSockets.slice(from.conns)
  assert.deepEqual(node.map((c) => c.scheme), ['http', 'https'], 'one TCP connection each')
  assert.ok(node.every((c) => c.socket.destroyed), 'both sockets are closed by now')
  for (const c of newConnections(from.conns)) assert.ok(c.bytes > 0, `bytes counted on the closed ${c.scheme} socket: ${c.bytes}`)
  assert.deepEqual(outsideHits.slice(from.out).map((h) => h.url), ['/control-node-http', '/control-node-https'])
  // from a browser page (the host page itself, not a preview): the same receivers see Chromium's requests
  const page = await hostPage({ policy: false })
  const mark = { out: outsideHits.length, conns: connectionCount() }
  await page.evaluate(async ([o, s]) => {
    await fetch(`${o}/control-browser-http`, { mode: 'no-cors' })
    await fetch(`${s}/control-browser-https`, { mode: 'no-cors' })
  }, [OUT, OUTS])
  await page.close()
  await settle(300)
  const seen = newConnections(mark.conns)
  for (const scheme of ['http', 'https'] as const) {
    assert.ok(seen.some((c) => c.scheme === scheme && c.bytes > 0), `a ${scheme} connection with bytes from the browser: ${JSON.stringify(seen)}`)
  }
  assert.deepEqual(outsideHits.slice(mark.out).map((h) => h.url).sort(), ['/control-browser-http', '/control-browser-https'])
})

// ---- the bridge against the model's own code in a real browser: prototype hooks and listeners first ----

/** The model's code as an attacker of the bridge: before anything arrives it replaces what a listener might call
 *  (the MessageEvent data/source getters, stopImmediatePropagation, Array push/indexOf, RegExp exec/test, Object.keys,
 *  Reflect.apply, Number.isSafeInteger, the CSSOM setters) with hooks that look into window.event, and listens at
 *  capture, at bubble and through onmessage. Everything any of them sees is written into #leaks (read from outside
 *  the page's own JavaScript world). Its button dispatches, in the frame, a synthetic MessageEvent that claims the
 *  parent as its source and carries what is typed in #msg (the test types the real nonce in: the worst case). */
const HOOKS = `<p id="state">hooked</p><pre id="leaks">[]</pre><textarea id="msg"></textarea><button id="synth">synth</button>
<script>(function(){
  var leaks = [], busy = false, dp = Object.defineProperty, str = JSON.stringify, n = 0, out = document.getElementById('leaks');
  function grab(where, v){ if (busy) return; busy = true; try { var s = typeof v === 'string' ? v : str(v); dp(leaks, n++, { value: where + ':' + s, enumerable: true, configurable: true }); out.textContent = str(leaks) } catch (e) {} busy = false }
  var MEP = MessageEvent.prototype, gd = Object.getOwnPropertyDescriptor, realData = gd(MEP, 'data').get, realSource = gd(MEP, 'source').get;
  function peek(where){ if (busy) return; try { var ev = window.event; if (ev && ev.type === 'message') grab(where + '/window.event', realData.call(ev)) } catch (e) {} }
  dp(MEP, 'data', { configurable: true, get: function(){ var d = realData.call(this); grab('data', d); return d } });
  dp(MEP, 'source', { configurable: true, get: function(){ peek('source'); return realSource.call(this) } });
  Event.prototype.stopImmediatePropagation = function(){ peek('stopImmediatePropagation') };
  var push = Array.prototype.push; Array.prototype.push = function(){ peek('push'); return push.apply(this, arguments) };
  var io = Array.prototype.indexOf; Array.prototype.indexOf = function(){ peek('indexOf'); return io.apply(this, arguments) };
  var ex = RegExp.prototype.exec; RegExp.prototype.exec = function(s){ peek('exec'); return ex.call(this, s) };
  var ts = RegExp.prototype.test; RegExp.prototype.test = function(s){ peek('test'); return ts.call(this, s) };
  var ks = Object.keys; Object.keys = function(o){ peek('keys'); return ks(o) };
  var ra = Reflect.apply; Reflect.apply = function(f, t, a){ peek('Reflect.apply'); return ra(f, t, a) };
  var si = Number.isSafeInteger; Number.isSafeInteger = function(x){ peek('isSafeInteger'); return si(x) };
  var sp = CSSStyleDeclaration.prototype.setProperty; CSSStyleDeclaration.prototype.setProperty = function(){ peek('setProperty'); return sp.apply(this, arguments) };
  var rp = CSSStyleDeclaration.prototype.removeProperty; CSSStyleDeclaration.prototype.removeProperty = function(){ peek('removeProperty'); return rp.apply(this, arguments) };
  addEventListener('message', function(e){ grab('capture', realData.call(e)) }, true);
  addEventListener('message', function(e){ grab('bubble', realData.call(e)) });
  onmessage = function(e){ grab('onmessage', realData.call(e)) };
  document.getElementById('synth').onclick = function(){
    var list = JSON.parse(document.getElementById('msg').value);
    for (var i = 0; i < list.length; i++) dispatchEvent(new MessageEvent('message', { data: list[i], source: parent, origin: 'null' }));
    document.getElementById('state').textContent = 'synthesized ' + list.length;
  };
})()</script>`

test("the model's code hooks the prototypes and listens first: the host's real ping and theme still work, none of its hooks or listeners sees the nonce, a synthetic message with the nonce is refused", async () => {
  const page = await hostPage({ appCss: true })
  await systemScheme(page, 'light')
  // every pong the host window hears (from any frame), by seq
  await page.evaluate(() => {
    const w = window as unknown as { __pongs: number[] }
    w.__pongs = []
    window.addEventListener('message', (e) => { const d = e.data as { type?: string; payload?: { seq?: number } } | null; if (d && d.type === 'pong' && typeof d.payload?.seq === 'number') w.__pongs.push(d.payload.seq) })
  })
  const pongs = () => page.evaluate(() => (window as unknown as { __pongs: number[] }).__pongs)
  await mount(page, { html: HOOKS, title: 'Hooks' })
  const frame = await runPreview(page)
  await frame.waitForSelector('#synth')
  const nonce = (await nonceOf(page))!
  const leaks = async () => JSON.parse((await frame.locator('#leaks').textContent()) ?? '[]') as string[]
  // the real heartbeat, through every hook: answered, again and again (the watchdog would stop a silent frame)
  const start = (await pongs()).length
  await page.waitForFunction((n) => (window as unknown as { __pongs: number[] }).__pongs.length >= n + 3, start, { timeout: 8_000 })
  assert.equal(await running(page), 'running')
  // the real theme: the host goes dark, the same frame follows
  const lightColor = await frameColor(frame)
  await systemScheme(page, 'dark')
  const dark = await hostLook(page)
  await frame.waitForFunction((c) => getComputedStyle(document.body).color === c, dark.body.color, { timeout: 5_000 })
  assert.notEqual(dark.body.color, lightColor)
  // the worst case: the model's code holds the real nonce and dispatches a ping and a theme in the frame, claiming
  // the parent as source. Neither is taken: no pong with that seq reaches the host, the colour stays
  const painted = await page.evaluate((n) => {
    const T = (window as unknown as { __theme: { read: () => { tokens: Record<string, string> }; message: (n: string, t: unknown) => unknown } }).__theme
    const t = T.read()
    return T.message(n, { ...t, tokens: { ...t.tokens, '--ink': 'rgb(1, 2, 3)' } })
  }, nonce)
  // before the synthetic messages: everything the hooks and listeners saw came from the host (pings, the theme)
  const hostOnly = await leaks()
  assert.deepEqual(hostOnly.filter((l) => l.includes(nonce)), [], `no hook or listener saw the nonce: ${JSON.stringify(hostOnly.filter((l) => l.includes(nonce))).slice(0, 400)}`)
  const synthetic = [{ channel: 'oasis-ui-sandbox', v: UI_SANDBOX_VERSION, nonce, type: 'ping', payload: { seq: 777_777 } }, painted]
  await frame.locator('#msg').fill(JSON.stringify(synthetic))
  await frame.locator('#synth').click()
  await frame.waitForFunction(() => document.getElementById('state')?.textContent === 'synthesized 2')
  await settle(1_500)
  assert.ok(!(await pongs()).includes(777_777), 'no pong to the synthetic ping')
  assert.equal(await frameColor(frame), dark.body.color, 'the synthetic theme was not applied')
  assert.equal(await running(page), 'running')
  // nothing any hook, getter or listener saw from the host carried the nonce (the synthetic two are its own doing)
  const all = await leaks()
  const fromHost = all.filter((l) => !l.includes('777777') && !l.includes('rgb(1'))
  assert.deepEqual(fromHost.filter((l) => l.includes(nonce)), [], `no hook or listener saw the nonce: ${JSON.stringify(all.filter((l) => l.includes(nonce))).slice(0, 400)}`)
  // the probe is live: a message on the channel with another nonce is not the bootstrap's, so its listeners see it
  await page.locator(FRAME).evaluate((f, v) => (f as HTMLIFrameElement).contentWindow!.postMessage({ channel: 'oasis-ui-sandbox', v, nonce: 'b'.repeat(32), type: 'ping', payload: { seq: 13 } }, '*'), UI_SANDBOX_VERSION)
  await frame.waitForFunction(() => (JSON.parse(document.getElementById('leaks')?.textContent ?? '[]') as string[]).some((l) => l.startsWith('bubble:') && l.includes('"seq":13')), null, { timeout: 5_000 })
  const live = await leaks()
  for (const where of ['capture:', 'bubble:', 'onmessage:']) assert.ok(live.some((l) => l.startsWith(where) && l.includes('"seq":13')), `the ${where} probe is live`)
  await page.close()
})

// ---- embedded in the app's own surface block (UiSurface): the host's card, title and header controls ----

/** A small deterministic page of plain HTML: no style of its own, an input, a button and a submit button, a select,
 *  a textarea, a JS counter that keeps counting, a table. */
const SURFACE_HTML = `<h3>Section</h3><p>Body text in the app's typography.</p>
<label>Name <input id="name" placeholder="Type here"></label> <select id="s"><option>One</option><option>Two</option></select>
<p><button id="b">Secondary</button> <button id="bp" type="submit">Primary</button></p>
<textarea id="t" rows="2"></textarea>
<table><thead><tr><th>Item</th><th>Count</th></tr></thead><tbody><tr><td>Counter</td><td id="c">0</td></tr></tbody></table>
<script>let n = 0; setInterval(() => { document.getElementById('c').textContent = String(++n) }, 50)</script>`

const surfaceRecord = (html: string) => ({
  session_id: 's1', run_id: 'r1', surface_id: 'probe', revision: 2, model: 'test-model',
  spec: { version: 1, surface_id: 'probe', title: 'Surface title', fallback: 'Plain text version of the surface.', kind: 'html', html, initial_state: {}, actions: [] },
  state: {}, created_at: '2026-10-11T00:00:00.000Z', updated_at: '2026-10-11T00:00:00.000Z',
})

const SURFACE = '[data-testid="ui-surface-probe"]'
const SHOTS = process.env.OASIS_CODE_E2E_SHOTS ?? ''
async function shot(page: Page, name: string) {
  if (SHOTS) await page.locator(SURFACE).screenshot({ path: join(SHOTS, `${name}.png`) })
}
const activeTestId = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.testid ?? document.activeElement?.tagName ?? '')
async function tabTo(page: Page, testid: string, key = 'Tab') {
  for (let i = 0; i < 30; i++) {
    if ((await activeTestId(page)) === testid) return
    await page.keyboard.press(key)
  }
  assert.fail(`${testid} not reached by ${key}`)
}

for (const vp of [{ name: 'regular', width: 900 }, { name: 'narrow', width: 320 }]) {
  test(`embedded in the surface block (${vp.name}, ${vp.width} px): one card and one title, Run / Stop / Reset in the surface header, keyboard focus moves between them, a live theme change keeps the input, focus and counter, the text version stands in`, async () => {
    const page = await hostPage({ appCss: true, viewport: { width: vp.width, height: 900 } })
    await systemScheme(page, 'light')
    await page.evaluate((r) => (window as unknown as { __mountSurface: (r: unknown) => void }).__mountSurface(r), surfaceRecord(SURFACE_HTML))
    const surface = page.locator(SURFACE)
    await surface.waitFor()
    assert.equal(await surface.getAttribute('data-kind'), 'html')
    assert.equal(await surface.getAttribute('data-revision'), '2')
    const preview = surface.locator(SEL)
    assert.equal(await preview.getAttribute('data-status'), 'idle')
    // the controls live in the surface's header, not in the preview's own box
    const header = surface.locator('[data-testid="ui-html-controls"]')
    assert.equal(await header.locator('[data-testid="intelligent-html-run"]').count(), 1)
    assert.equal(await preview.locator('[data-testid="intelligent-html-run"]').count(), 0)
    // provenance is there for whoever looks for it, not as a badge; no kind or revision badge in the visible text
    assert.match((await surface.locator('[data-testid="ui-provenance"]').textContent()) ?? '', /revision 2 · presented in run r1 by test-model/)
    const visible = await surface.innerText()
    assert.doesNotMatch(visible, /interactive preview|rev 2|sandbox/i)
    assert.equal(visible.split('Surface title').length - 1, 1, `the title once: ${JSON.stringify(visible)}`)
    // with a fallback, idle shows the fallback and no notice; how it runs is behind the info toggle
    assert.equal(await preview.locator('[data-testid="intelligent-html-notice"]').count(), 0)
    assert.equal(await preview.locator('[data-testid="intelligent-html-fallback"]').innerText(), 'Plain text version of the surface.')
    const info = preview.locator('[data-testid="intelligent-html-info"]')
    assert.equal(await info.isVisible(), false)
    await header.locator('[data-testid="intelligent-html-info-toggle"]').click()
    assert.equal(await info.isVisible(), true)
    assert.match(await info.innerText(), /cannot reach oasis-code’s page/)
    assert.equal(await info.locator('[data-testid="intelligent-html-cpu-hint"]').innerText(), CPU_HINT)
    await shot(page, `light-${vp.name}-idle-info`)
    await header.locator('[data-testid="intelligent-html-info-toggle"]').click()
    assert.equal(await info.isVisible(), false)
    await shot(page, `light-${vp.name}-idle`)
    // Run by keyboard; the focus moves to Stop, which replaced it
    await page.locator('body').focus()
    await tabTo(page, 'intelligent-html-run')
    await page.keyboard.press('Enter')
    const frame = await frameOf(page)
    await frame.waitForSelector('#c')
    await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset?.testid === 'intelligent-html-stop', null, { timeout: 3_000 })
    assert.equal(await header.locator('[data-testid="intelligent-html-reset"]').count(), 1)
    assert.equal(await page.locator(FRAME).getAttribute('title'), 'Interactive preview: Surface title')
    // into the frame by keyboard and type there
    for (let i = 0; i < 30 && (await frame.evaluate(() => document.activeElement?.id)) !== 'name'; i++) await page.keyboard.press('Tab')
    await page.keyboard.type('typed')
    assert.equal(await frame.locator('#name').inputValue(), 'typed')
    const light = await matchesHost(page, frame, `embedded ${vp.name}, light`)
    // No outer ring around the frame; contents remain within the surface without horizontal scrolling.
    const layout = await surface.evaluate((section) => {
      const iframe = section.querySelector('iframe')!
      const ringed: string[] = []
      for (let el: Element | null = iframe; el && section.contains(el); el = el.parentElement) {
        const cs = getComputedStyle(el) as unknown as Record<string, string>
        const border = ['Top', 'Right', 'Bottom', 'Left'].some((s) => parseFloat(cs[`border${s}Width`]!) > 0 && cs[`border${s}Style`] !== 'none')
        if (border || cs.boxShadow !== 'none') ringed.push(`${el.tagName}.${(el as HTMLElement).className}`)
      }
      const box = section.getBoundingClientRect()
      const past = [...section.querySelectorAll('*')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > box.right + 0.5 || r.left < box.left - 0.5) })
        .map((el) => `${el.tagName}.${(el as HTMLElement).className}`)
      return { ringed, past, cardRight: box.right, viewport: document.documentElement.clientWidth, scroll: section.scrollWidth - section.clientWidth,
      }
    })
    assert.deepEqual(layout.ringed, [], 'no outer card around the embedded frame')
    assert.deepEqual(layout.past, [], 'nothing of the card past its edges')
    assert.ok(layout.cardRight <= layout.viewport + 0.5, `the card fits the window (${layout.cardRight} / ${layout.viewport})`)
    assert.ok(layout.scroll <= 0, `no horizontal scroll in the card (${layout.scroll})`)
    assert.ok(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'no horizontal overflow inside the frame')
    await shot(page, `light-${vp.name}-running`)
    // the host goes dark while it runs: the same frame, the same nonce, the input, the focus and the counter kept
    const nonce = await nonceOf(page)
    const c0 = Number(await frame.locator('#c').innerText())
    await systemScheme(page, 'dark')
    const dark = await matchesHost(page, frame, `embedded ${vp.name}, dark`)
    assert.notEqual(dark.body.color, light.body.color)
    assert.equal(await nonceOf(page), nonce)
    assert.equal(await frame.locator('#name').inputValue(), 'typed')
    assert.equal(await frame.evaluate(() => document.activeElement?.id), 'name')
    await frame.waitForFunction((x) => Number(document.getElementById('c')!.textContent) > x + 3, c0)
    await shot(page, `dark-${vp.name}-running`)
    // Stop by keyboard: back out of the frame to the header; the focus then moves to Run again
    await page.locator('[data-testid="intelligent-html-stop"]').focus()
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('[data-testid="intelligent-html"]')?.getAttribute('data-stop-reason') === 'stopped')
    await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset?.testid === 'intelligent-html-run', null, { timeout: 3_000 })
    assert.equal(await header.locator('[data-testid="intelligent-html-run"]').innerText(), 'Run again')
    assert.equal(await page.locator(FRAME).count(), 0)
    // the text version: the plain fallback instead of the preview and its controls; back again, nothing runs by itself
    await surface.locator('[data-testid="ui-text-toggle"]').click()
    assert.equal(await surface.locator('[data-testid="ui-fallback"]').innerText(), 'Plain text version of the surface.')
    assert.equal(await surface.locator('[data-testid="intelligent-html-run"]').count(), 0)
    await shot(page, `dark-${vp.name}-text-version`)
    await surface.locator('[data-testid="ui-text-toggle"]').click()
    assert.equal(await surface.locator(SEL).getAttribute('data-status'), 'idle')
    assert.equal(await page.locator(FRAME).count(), 0)
    await page.close()
  })
}

test('embedded in a replay: read-only, nothing runs, no Run anywhere on the surface, the fallback stands', async () => {
  const page = await hostPage({ appCss: true })
  const before = outsideHits.length
  await page.evaluate((r) => (window as unknown as { __mountSurface: (r: unknown, o: unknown) => void }).__mountSurface(r, { replaying: true }), surfaceRecord(`<img src="${OUT}/replay.png"><script>location.href='${OUT}/replay'</script>`))
  const surface = page.locator(SURFACE)
  await surface.waitFor()
  assert.equal(await surface.locator(SEL).getAttribute('data-status'), 'read-only')
  assert.equal(await surface.locator('[data-testid="intelligent-html-run"]').count(), 0)
  assert.equal(await surface.locator('[data-testid="intelligent-html-notice"]').innerText(), 'Read-only: this preview does not run here.')
  assert.equal(await surface.locator('[data-testid="intelligent-html-fallback"]').innerText(), 'Plain text version of the surface.')
  assert.equal(await surface.locator('[data-testid="ui-readonly"]').count(), 1)
  await shot(page, 'light-regular-replay')
  await settle(800)
  assert.equal(await page.locator(FRAME).count(), 0)
  assert.equal(outsideHits.length, before)
  await page.close()
})
