// oasis-code desktop (adapted from oasis desktop/main.js, see NOTICE): one window around the product, no browser.
//
// A packaged app (electron-builder, `npm run dist`) carries a compiled backend and the built UI under its resources
// and starts the backend itself; from the source tree (`npm start`) Bun runs backend-ts and the UI is built on first
// start when frontend/dist is missing. Either way the shell attaches to the oasis-code backend of its data directory
// (one that proves it holds that directory's session token) already answering on 127.0.0.1:OASIS_CODE_PORT (8321)
// instead of starting one, and refuses anything else on the port.
// Nothing here reads another product's credential files: keys and sign-ins live in the backend's data directory.
//
// OASIS_CODE_USER_DATA: where Electron keeps the app's profile (default: its own folder, or `electron` in a data
// directory other than ~/.oasis-code), so a second app on other data never shares the person's profile or lock.
//
// OASIS_CODE_BACKGROUND=1: persistent hidden QA instance. Requires explicit isolated DATA/USER_DATA and all
// four service ports; excludes 8321-8324. No Remote access creation/resume/enable and no foreground dialogs.
// Unlike SMOKE this never captures/quits on a timer. QA alone starts/stops its own instance.
//
// OASIS_CODE_SMOKE=1: headless self-test — wait for the app to render, check the preload bridge, capture a screenshot
// to OASIS_CODE_SMOKE_OUT (default: the system temp dir), then quit. `npm run smoke` gives it a data directory, a
// profile and a port of its own (scripts/start.js); started on the person's own profile it refuses to run, since it
// clears that profile's cache.

const { app, BrowserWindow, WebContentsView, dialog, ipcMain, nativeImage, screen, session, shell } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { backgroundMode, agentBrowserHeaders, allowReload, backendRestartDelay, attachChallenge, backendCommand, classifyAttach, classifyBuild, dataDirOf, knownTokens, linkTarget, portOf, redactTokens, userDataOf, windowBounds } = require('./shell')
const { bridgePortOf, connectorOf, frameAsk, rememberConnector, startBridge } = require('./bridge')
const { BROWSER_PARTITION } = require('./computer_electron')
const { createRemote } = require('./remote')
const { attachLocalFile, fromAppPage } = require('./local_files')

const PORT = portOf()
const BASE_URL = `http://127.0.0.1:${PORT}`
const REPO_ROOT = path.resolve(__dirname, '..')
const SMOKE = process.env.OASIS_CODE_SMOKE === '1'
// QA only: hidden at construction, no timer/foreground activation and no Remote access lifecycle.
const BACKGROUND = backgroundMode(process.env)
const DATA_DIR = dataDirOf()
const LOG_PATH = path.join(DATA_DIR, 'logs', 'desktop.log')
const COMMAND = backendCommand({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot: REPO_ROOT })

app.setName('oasis-code')
if (BACKGROUND && process.platform === 'darwin') app.setActivationPolicy('accessory')
// before anything reads the profile or takes the single-instance lock (both live in it)
const USER_DATA = userDataOf()
if (SMOKE && !USER_DATA) {
  console.error("smoke refused: it would run on the app's own Electron profile, the person's; use `npm run smoke`, or name a data directory (OASIS_CODE_DATA) or a profile (OASIS_CODE_USER_DATA)")
  process.exit(1)
}
if (USER_DATA) { app.setPath('userData', USER_DATA); app.setPath('sessionData', USER_DATA) }
let backend = null
let quitting = false
// when the backend ended without being asked to (a restart follows a few of them)
const backendEnds = []
let reloads = []
let mainWindow = null
// the ChatGPT bridge page and its loopback server, started on the page's first ask (ChatGPT named, or directing)
let bridge = null
let bridgeStarting = null
// remote access from ChatGPT (the director endpoint and its tunnel), made once the backend answers
let remote = null

function showError(title, message) {
  if (BACKGROUND) { log(`[shell] ${title}: ${message}`); return }
  dialog.showErrorBox(title, message)
}

// ---- logging: the console and <data dir>/logs/desktop.log (the backend's output goes there too) ----------------

// the log is kept private (0600) like the token files beside it: made so, and an older one made so on the first write
let logPrivate = false

function log(line) {
  const text = redactTokens(`${new Date().toISOString()} ${line}`, knownTokens(DATA_DIR))
  process.stdout.write(`${text}\n`)
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true, mode: 0o700 })
    fs.appendFileSync(LOG_PATH, `${text}\n`, { mode: 0o600 })
    if (!logPrivate) { fs.chmodSync(LOG_PATH, 0o600); logPrivate = true }
  } catch { /* the log is a convenience */ }
}

// ---- the backend --------------------------------------------------------------------------------------------------

/** What answers on the port; 'ours' only for the backend that proves it holds this data directory's session token,
 *  so the token is never sent to another data directory's backend or to anything posing as one. */
async function probe() {
  const challenge = attachChallenge()
  try {
    const res = await fetch(`${BASE_URL}/api/meta/build?challenge=${challenge}`, { signal: AbortSignal.timeout(1500) })
    let body = null
    try { body = await res.json() } catch { body = null }
    return classifyAttach(res.status, body, { token: sessionToken(), port: PORT, challenge })
  } catch {
    return classifyBuild(null, null)
  }
}

function startBackend() {
  const { command, args, cwd, frontend_dist } = COMMAND
  log(`[shell] starting the backend: ${command} ${args.join(' ')} (cwd ${cwd}, data ${DATA_DIR}, port ${PORT})`)
  backend = spawn(command, args, {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OASIS_CODE_PORT: PORT, OASIS_CODE_DATA: DATA_DIR, OASIS_CODE_FRONTEND_DIST: frontend_dist },
  })
  backend.stdout.on('data', (d) => log(`[backend] ${String(d).trimEnd()}`))
  backend.stderr.on('data', (d) => log(`[backend] ${String(d).trimEnd()}`))
  backend.on('error', (error) => {
    backend = null
    log(`[shell] the backend could not be started: ${error.message}`)
    if (!quitting) {
      showError('oasis-code backend did not start', `${command} could not be started (${error.message}).`)
      app.quit()
    }
  })
  backend.on('exit', (code, signal) => {
    backend = null
    log(`[shell] the backend exited (code ${code}, signal ${signal})`)
    if (quitting) return
    // ended unasked (a full disk, a crash): started again after a wait, a few times; the window and remote access
    // reconnect to it on their own. Past that the person is told, and the app ends.
    backendEnds.push(Date.now())
    const wait = backendRestartDelay(backendEnds, Date.now())
    if (wait !== null) {
      log(`[shell] starting the backend again in ${wait / 1000} s`)
      setTimeout(() => {
        if (quitting || backend) return
        startBackend()
        void waitForBackend(45_000).then((ok) => log(ok ? '[shell] the backend answers again' : '[shell] the backend did not answer after a restart'))
      }, wait)
      return
    }
    showError('oasis-code backend exited', `The backend exited (code ${code}${signal ? `, signal ${signal}` : ''}) and kept exiting after restarts. The log is at ${LOG_PATH}.`)
    app.quit()
  })
}

async function waitForBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await probe()) === 'ours') return true
    if (backend === null && !quitting) return false                       // it died; the exit handler said so
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

function stopBackend() {
  if (!backend) return
  log('[shell] stopping the backend')
  try { backend.kill(process.platform === 'win32' ? undefined : 'SIGTERM') } catch { /* gone */ }
}

function sessionToken() {
  if (process.env.OASIS_CODE_SESSION_TOKEN) return process.env.OASIS_CODE_SESSION_TOKEN
  try { return fs.readFileSync(path.join(DATA_DIR, 'session-token'), 'utf8').trim() } catch { return null }
}

/** From the source tree, a missing frontend/dist is built once (npm run build in frontend/): the window shows it. */
function buildUi(setStatus) {
  return new Promise((resolve) => {
    const cwd = path.join(REPO_ROOT, 'frontend')
    setStatus('building the UI (frontend/: npm run build) — once')
    log('[shell] frontend/dist is missing: building it')
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    let tail = ''
    const keep = (d) => { tail = (tail + String(d)).slice(-2000); log(`[ui build] ${String(d).trimEnd()}`) }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('error', (error) => resolve({ ok: false, detail: error.message }))
    child.on('exit', (code) => resolve({ ok: code === 0, detail: tail }))
  })
}

// ---- the window ---------------------------------------------------------------------------------------------------

const STATE_PATH = () => path.join(app.getPath('userData'), 'window-state.json')

function savedBounds() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH(), 'utf8')) } catch { return null }
}

function rememberBounds(win) {
  if (win.isMinimized() || win.isFullScreen()) return
  try { fs.writeFileSync(STATE_PATH(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })) } catch { /* a convenience */ }
}

/** What the window shows while the backend comes up: the wordmark as the app draws it ("code" a chip of the same
 *  size), its chip turning through the bots' colours, and a thin bar sweeping under it. The status line is for a
 *  screen reader only (updated in place). */
function loadingPage() {
  const html = `<!doctype html><meta charset="utf-8"><title>oasis-code</title>
<style>html,body{height:100%;margin:0;background:#fafafa;color:#222;font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-app-region:drag}
main{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px}
.word{display:inline-flex;align-items:baseline;gap:6px;font-size:30px;font-weight:650;letter-spacing:-.02em;line-height:1}
.chip{display:inline-flex;align-items:center;height:1.3em;padding:0 .38em .12em;border-radius:.34em;background:#222;color:#fff;letter-spacing:-.01em;animation:c 6s ease-in-out infinite}
@keyframes c{0%,100%{background:#222}20%{background:#F37C52}40%{background:#0EBB73}60%{background:#416CB7}80%{background:#9391F0}}
.bar{position:relative;width:88px;height:3px;border-radius:3px;background:#ebe8e2;overflow:hidden}
.bar::after{content:"";position:absolute;inset:0;width:40%;border-radius:3px;background:#222;animation:s 1.3s cubic-bezier(.65,0,.35,1) infinite}
@keyframes s{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
#status{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (prefers-reduced-motion:reduce){.chip,.bar::after{animation:none}}</style>
<main><div class="word">oasis<span class="chip">code</span></div><div class="bar"></div><div id="status" role="status">starting</div></main>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

async function createWindow() {
  const saved = savedBounds()
  const bounds = windowBounds(saved, screen.getAllDisplays().map((d) => d.workArea))
  const win = new BrowserWindow({
    ...bounds, minWidth: 720, minHeight: 480, show: !SMOKE && !BACKGROUND, ...(BACKGROUND ? { focusable: false } : {}), backgroundColor: '#fafafa', title: 'oasis-code',
    // frameless mac look: the traffic lights float over the rail, no title bar; the other platforms keep their frame
    // (y: the lights' top; they are 14 pt tall, so their middle is the 40 px thread header's middle when the rail is hidden)
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } } : {}),
    webPreferences: { backgroundThrottling: false, preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  })
  mainWindow = win
  if (!BACKGROUND && saved && saved.maximized) win.maximize()
  let bookmark = null
  const remember = () => { clearTimeout(bookmark); bookmark = setTimeout(() => rememberBounds(win), 400) }
  win.on('resize', remember)
  win.on('move', remember)
  win.on('close', (event) => {
    rememberBounds(win)
    // on the Mac, as Claude and Codex do: closing the window (its button, Cmd+W) hides it and the app stays in the Dock,
    // its runs, bridge and remote access going on; the Dock icon brings it back; Cmd+Q, the Dock's Quit, a logout quit
    if (process.platform !== 'darwin' || quitting || BACKGROUND || SMOKE) return
    event.preventDefault()
    // a full-screen window hidden as it is leaves a black space: it leaves full screen first
    if (win.isFullScreen()) { win.once('leave-full-screen', () => win.hide()); win.setFullScreen(false) } else win.hide()
  })
  // the backstage window (where the ChatGPT page and the agent's browser live while no card shows them) is no window of
  // the app's: the app ends with its own window, as it always did
  win.on('closed', () => { mainWindow = null; if (!quitting) app.quit() })
  // links: the system browser for the web, nothing for anything else, the app's own origin stays in the window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!BACKGROUND && linkTarget(url, BASE_URL) === 'external') void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (linkTarget(url, BASE_URL) !== 'app') { event.preventDefault(); if (!BACKGROUND && linkTarget(url, BASE_URL) === 'external') void shell.openExternal(url) }
  })
  // a renderer that dies is reloaded (logged), a few times a minute at most (the oasis white-screen lesson)
  win.webContents.on('render-process-gone', (_event, details) => {
    log(`[shell] renderer gone: ${details.reason} (exit ${details.exitCode})`)
    const next = allowReload(reloads, Date.now())
    reloads = next.history
    if (next.allowed && !quitting) win.reload()
    else showError('oasis-code', `The window crashed repeatedly (${details.reason}).`)
  })
  await win.loadURL(loadingPage())
  const setStatus = (text) => { if (!win.isDestroyed()) void win.webContents.executeJavaScript(`document.getElementById('status').textContent = ${JSON.stringify(text)}`).catch(() => undefined) }

  const found = await probe()
  if (found === 'foreign') {
    showError('Port in use', `Another oasis-code answers on ${BASE_URL}, not the one of this app's data directory (${DATA_DIR}): ` +
      'it runs with a different data directory or session token. Stop it, or start the app with another OASIS_CODE_PORT.')
    app.quit()
    return
  }
  if (found === 'other' || found === 'incompatible') {
    showError('Port in use', `Something other than a compatible oasis-code backend answers on ${BASE_URL} (${found}). ` +
      'Stop it, or start the app with another OASIS_CODE_PORT.')
    app.quit()
    return
  }
  if (found === 'none') {
    if (!COMMAND.bundled && !fs.existsSync(path.join(COMMAND.frontend_dist, 'index.html'))) {
      const built = await buildUi(setStatus)
      if (!built.ok) {
        showError('oasis-code UI did not build', `npm run build in frontend/ failed:\n${built.detail.slice(-1200)}`)
        app.quit()
        return
      }
    }
    setStatus(COMMAND.bundled ? 'starting the backend' : `starting the backend with ${COMMAND.hint}`)
    startBackend()
    if (!(await waitForBackend(COMMAND.bundled ? 60_000 : 45_000))) {
      const { command, args, cwd, hint } = COMMAND
      showError('oasis-code backend did not start',
        `Nothing compatible answers on ${BASE_URL}. ${COMMAND.bundled ? `The log is at ${LOG_PATH}.` : `Check that ${hint} is installed and try:\ncd ${cwd} && ${command} ${args.join(' ')}`}`)
      app.quit()
      return
    }
    log('[shell] the backend answers')
  } else {
    log(`[shell] attached to the backend already answering on ${BASE_URL}`)
  }
  // remote access comes up with the app when the person turned it on before (never in the smoke run)
  if (!SMOKE && !BACKGROUND && !remote) {
    remote = createRemote({ dataDir: DATA_DIR, backend: COMMAND, harnessPort: PORT, log, spawn, run: runCmd })
    void remote.resume()
  }
  const token = sessionToken()
  // the backend serves a freshly built UI: never trust the HTTP cache for the app
  await win.webContents.session.clearCache()
  await win.loadURL(token ? `${BASE_URL}/?token=${encodeURIComponent(token)}` : BASE_URL, { extraHeaders: 'pragma: no-cache\n' })

  if (SMOKE) {
    await new Promise((r) => setTimeout(r, 2500))
    const bridge = await win.webContents.executeJavaScript('JSON.stringify(window.oasisCodeDesktop ? { platform: window.oasisCodeDesktop.platform, pickDirectory: typeof window.oasisCodeDesktop.pickDirectory, attachLocalFile: typeof window.oasisCodeDesktop.attachLocalFile } : null)')
    const rendered = await win.webContents.executeJavaScript('document.querySelector("[data-testid=hero]") ? "app" : document.body.innerText.slice(0, 200)')
    const title = await win.webContents.executeJavaScript('document.title')
    console.log(`preload bridge: ${bridge}; page: ${rendered}; title: ${title}; backend: ${found === 'ours' ? 'attached' : COMMAND.bundled ? 'started (bundled)' : `started (${COMMAND.hint})`}`)
    if (!bridge || bridge === 'null' || !bridge.includes('"pickDirectory":"function"') || !bridge.includes('"attachLocalFile":"function"') || rendered !== 'app') { console.error('smoke FAILED'); app.exit(1); return }
    const image = await win.webContents.capturePage()
    const out = process.env.OASIS_CODE_SMOKE_OUT || path.join(os.tmpdir(), 'oasis-code-smoke.png')
    fs.writeFileSync(out, image.toPNG())
    console.log(`smoke screenshot written to ${out} (${image.getSize().width}x${image.getSize().height})`)
    app.quit()
  }
}

/** A command's exit code and output, within `timeoutMs` (killed past it: code null); `input` goes to its stdin (a
 *  provider token for `gateway setup`, never an argument); its own `env` when given, else the app's. */
function runCmd(command, args, { cwd, env, input = '', timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    let child
    try { child = spawn(command, args, { cwd, env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'] }) } catch (error) { resolve({ code: null, stdout: '', stderr: error.message }); return }
    let out = ''
    let err = ''
    let settled = false
    const done = (code) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, stdout: out, stderr: err }) }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } err += `${command} gave no answer in ${Math.round(timeoutMs / 1000)} s`; done(null) }, timeoutMs)
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    child.on('error', (error) => { err += error.message; done(null) })
    child.on('close', (code) => done(code))
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

// remote access, from the app's own page only: its state, turning it (or keeping the Mac awake) on or off, a new token
ipcMain.handle('remote-status', (event) => (mainWindow && event.sender === mainWindow.webContents && remote ? remote.status() : null))
ipcMain.handle('remote-set', (event, change) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !remote || !change || typeof change !== 'object') return null
  return remote.set({ enabled: change.enabled, keep_awake: change.keep_awake })
})
// the one-time setup: a provider, its fixed host and (Cloudflare, ngrok) its token, kept by the backend in 0600 files
ipcMain.handle('remote-configure', (event, change) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !remote || !change || typeof change !== 'object') return null
  return remote.configure({ provider: String(change.provider || ''), host: String(change.host || ''), token: typeof change.token === 'string' ? change.token : '' })
})
// revoke the link: a new external secret (the old URL stops answering)
ipcMain.handle('remote-rotate', (event) => (mainWindow && event.sender === mainWindow.webContents && remote ? remote.rotate() : null))

// the page's folder chip: the system's folder dialog, the chosen path handed back (nothing else about the file
// system reaches the page)
ipcMain.handle('pick-directory', async (event) => {
  if (BACKGROUND) return null
  if (!mainWindow || event.sender !== mainWindow.webContents) return null
  const owner = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(owner, { properties: ['openDirectory', 'createDirectory'], title: 'Choose the folder to work in' })
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
})

// a PDF or a video the person attached, named to the harness where it lies (no byte copied): from the app page's top
// frame only; the path checked here and again by the backend; registered under the session token, which stays here —
// the page gets the attachment, or the refusal as an error (it never uploads a file refused here)
ipcMain.handle('attach-local-file', async (event, raw) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('refused: only the app window attaches files')
  return attachLocalFile(event, raw, { win: mainWindow, baseUrl: BASE_URL, protectedRoots: [DATA_DIR, app.getPath('userData')], token: sessionToken() })
})

// the ChatGPT bridge — the signed-in page (a view in this window, shown on the desk's ChatGPT card) and the loopback
// server the backend talks to (its runs on ChatGPT, and the director's bridge transport); started once per app run
function ensureBridge() {
  bridgeStarting ??= startBridge({ WebContentsView, BrowserWindow, nativeImage, host: () => mainWindow, shell, session, port: bridgePortOf(), dataDir: DATA_DIR, log })
    .then((b) => { bridge = b; return b }).catch((error) => { bridgeStarting = null; throw error })
  return bridgeStarting
}

ipcMain.handle('open-chatgpt-bridge', async (event) => {
  // the bridge's token opens the person's ChatGPT page: handed to the app's own page only
  if (!mainWindow || event.sender !== mainWindow.webContents) return null
  if (!bridge) await ensureBridge()
  bridge.load()
  return { url: bridge.url, token: bridge.token }
})

// the composer's ChatGPT chip: whether the page is signed in and the connector is known (the bridge starts on the
// first ask, as it would for the first message; `{ load: false }`, the @ menu's look, never opens the page); and a
// connector the page knew before, handed over once
ipcMain.handle('chatgpt-status', async (event, opts) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return null
  if (!bridge) await ensureBridge()
  return bridge.status({ load: !(opts && opts.load === false) })
})
// the ChatGPT card's reload: the page loaded again (a page that did not load retries by itself as well)
ipcMain.handle('chatgpt-reload', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false
  if (!bridge) await ensureBridge()
  bridge.reload()
  return true
})
ipcMain.handle('chatgpt-connector', (event, mention) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return null
  if (!connectorOf(DATA_DIR)) rememberConnector(DATA_DIR, mention)
  return connectorOf(DATA_DIR)
})

// the ChatGPT card says where its body is and whether it shows; only the app's own page places the view
ipcMain.on('chatgpt-view', (event, raw) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return
  if (bridge) { bridge.place(raw); return }
  if (raw && raw.visible === true) void ensureBridge().then((b) => b.place(raw)).catch((error) => log(`[bridge] did not start: ${error.message}`))
})

// the desk's Browser card: where the agent's browser shows (only the app's own page places it), and what it shows
ipcMain.on('browser-view', (event, raw) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !fromAppPage(event, mainWindow, BASE_URL)) return
  if (bridge) { bridge.placeBrowser(raw); return }
  if (raw && raw.visible === true) void ensureBridge().then((b) => b.placeBrowser(raw)).catch((error) => log(`[bridge] did not start: ${error.message}`))
})
ipcMain.handle('browser-status', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !fromAppPage(event, mainWindow, BASE_URL)) return null
  if (!bridge) await ensureBridge()
  return bridge.browserStatus()
})
// the Browser card's own controls, from the app's own page only — its top frame, at the backend's origin (not a frame
// in it, not another view): its tabs, its address bar and buttons, the element picker (the person's use of the page;
// no page and no agent reaches them)
ipcMain.handle('browser-tab', async (event, raw) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !fromAppPage(event, mainWindow, BASE_URL)) return null
  if (!bridge) await ensureBridge()
  return bridge.browserTab(raw)
})
ipcMain.handle('browser-navigate', async (event, raw) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !fromAppPage(event, mainWindow, BASE_URL)) return null
  if (!bridge) await ensureBridge()
  return bridge.browserNavigate(raw)
})
// Input from the scaled browser picture is restricted to the app's top frame, just like tabs and navigation.
ipcMain.handle('browser-input', async (event, raw) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !fromAppPage(event, mainWindow, BASE_URL)) return null
  if (!bridge) return { ok: false, reason: 'the browser is not open' }
  return bridge.browserInput(raw)
})
ipcMain.handle('browser-pick', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !fromAppPage(event, mainWindow, BASE_URL)) return null
  if (!bridge) await ensureBridge()
  return bridge.pickBrowserElement()
})
ipcMain.handle('browser-pick-cancel', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !fromAppPage(event, mainWindow, BASE_URL) || !bridge) return false
  return bridge.cancelBrowserPick()
})
// the Browser card's "Clear browser data", from the app's own page only: the bridge refuses it while a run holds the
// browser
ipcMain.handle('browser-clear-data', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !fromAppPage(event, mainWindow, BASE_URL)) return null
  if (!bridge) await ensureBridge()
  return bridge.clearBrowserData()
})
// the ChatGPT card's "Resume sending" after a damaged send log, from the app's own page only
ipcMain.handle('chatgpt-resume-sending', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return null
  if (!bridge) await ensureBridge()
  return bridge.resumeSending()
})
// the thread's live view of computer use: the page an agent is acting on as it is now, with the agent's pointer
// `surface` is the old string ('browser' | 'chatgpt'), or { surface, owner }: the browser picture of that run's own
// current tab (the thread's live view of that run); without an owner, the tab the Browser card shows
ipcMain.handle('surface-frame', async (event, raw) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !bridge) return null
  const ask = frameAsk(raw)
  // the agent's browser's picture: from the app page's top frame at the backend's origin (the ChatGPT page's as before)
  if (ask.surface !== 'chatgpt' && !fromAppPage(event, mainWindow, BASE_URL)) return null
  return bridge.surfaceFrame(ask)
})

// one running app: a second launch brings the window forward instead of racing for the port
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (BACKGROUND) return
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() } else void createWindow()
  })
  app.whenReady().then(() => {
    log(`[shell] Electron profile: ${app.getPath('userData')}`)
    // the agent's browser is marked on everything it sends to this machine, before its first page loads: the backend
    // refuses the API to it, so a page the agent drives never decides the person's approvals or permissions, even when
    // the person once opened the app's link there
    session.fromPartition(BROWSER_PARTITION).webRequest.onBeforeSendHeaders((details, callback) => callback({ requestHeaders: agentBrowserHeaders(details.url, details.requestHeaders) }))
    // `npm start` on macOS runs a bundle with the product's icon (devbundle.js); Electron started any other way from
    // the source tree still shows its own, so the Dock tile gets the product's as soon as the app is ready
    if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
      try { app.dock.setIcon(path.join(__dirname, 'build', 'icon.png')) } catch (error) { log(`[shell] dock icon: ${error.message}`) }
    }
    // the bridge comes up with the app (its pages load only when first used): a director session on ChatGPT carries on
    // after a restart, and an agent's computer use finds the pages it acts on
    if (!SMOKE) void ensureBridge().catch((error) => log(`[bridge] did not start: ${error.message}`))
    return createWindow()
  })
  // the Dock icon: the hidden window shown again where it was (made anew only when there is none)
  app.on('activate', () => {
    if (BACKGROUND) return
    if (!mainWindow) { void createWindow(); return }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
  })
  // the quit stops what remote access started inside the app (keeping the Mac awake); the gateway and its tunnel are
  // a launchd agent of their own and keep serving — only turning remote access off removes them
  let remoteStopped = false
  let remoteStopping = false
  app.on('before-quit', (event) => {
    if (!quitting) { quitting = true; stopBackend(); if (bridge) void bridge.close().catch(() => undefined) }
    if (!remote || remoteStopped) return
    event.preventDefault()
    if (remoteStopping) return
    remoteStopping = true
    void remote.stop().catch((error) => log(`[remote] stopping: ${error.message}`)).finally(() => { remoteStopped = true; app.quit() })
  })
  app.on('window-all-closed', () => app.quit())
}
