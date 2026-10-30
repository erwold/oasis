// Real Electron, app-level check of agent-owned browser tabs: the production composition (startBridge) in an isolated
// temporary profile and data directory, hidden unfocusable windows only (never shown, never focused, no system
// screenshot), a local fixture server on 127.0.0.1. Two runs work in parallel on their own tabs.
//
//   env -u OASIS_CODE_DATA -u OASIS_CODE_FRONTEND_DIST electron desktop/scripts/check_browser_agent_tabs.cjs <output-directory>
//
// Writes <output>/agent-tabs.json and prints one JSON line per check.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, WebContentsView, nativeImage, screen, session } = require('electron')

for (const name of Object.keys(process.env)) if (name.startsWith('OASIS_CODE_')) delete process.env[name]
const scriptAt = process.argv.findIndex((arg) => path.resolve(arg) === __filename)
const output = path.resolve(process.argv[scriptAt + 1] || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tabs-check-')))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-agent-tabs-check-'))
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(root, 'user-data'))
app.setPath('sessionData', path.join(root, 'session-data'))
app.on('window-all-closed', () => {})
const { startBridge } = require('../bridge')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const COLORS = { a: [220, 40, 40], b: [30, 150, 60] }

const page = (name) => `<!doctype html><title>page ${name}</title><style>html,body{margin:0;width:100%;height:100%;background:rgb(${COLORS[name].join(',')})}
#btn{position:absolute;left:600px;top:400px;width:120px;height:60px}</style><button id=btn>${name}</button>
<script>window.clicks=[];btn.onclick=e=>clicks.push({x:e.clientX,y:e.clientY,trusted:e.isTrusted});</script>`
const server = http.createServer((req, res) => {
  const name = (req.url || '').replace(/[^ab]/g, '').slice(0, 1) || 'a'
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(page(name))
})

function colour(image) {
  const im = nativeImage.createFromBuffer(Buffer.from(image.data_base64, 'base64'))
  const { width, height } = im.getSize()
  const bmp = im.toBitmap()
  const i = (Math.floor(height * 0.15) * width + Math.floor(width * 0.9)) * 4
  return { size: { width, height }, rgb: [bmp[i + 2], bmp[i + 1], bmp[i]] }
}
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 40)

async function check(name, run) {
  const result = { name, at: new Date().toISOString() }
  try { await run(result); result.passed = true } catch (error) { result.passed = false; result.error = String(error.stack || error) }
  results.push(result)
  console.log(JSON.stringify({ ...result, error: result.error ? result.error.split('\n')[0] : undefined }))
}
const timed = async (fn) => { const start = Date.now(); const out = await fn(); return { out, start, end: Date.now() } }

let bridge = null
let host = null
;(async () => {
  await app.whenReady()
  try { if (process.platform === 'darwin' && typeof app.setActivationPolicy === 'function') app.setActivationPolicy('accessory') } catch { /* below */ }
  if (app.dock) app.dock.hide()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  host = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } })
  bridge = await startBridge({ WebContentsView, BrowserWindow, nativeImage, host: () => host, shell: { openExternal: async () => {} }, port: 0, dataDir: path.join(root, 'data'), session, log: () => {} })
  const { computer, browser } = bridge
  const A = { surface: 'browser', owner: 'run_A', session: 's_1', owner_label: 'check A' }
  const B = { surface: 'browser', owner: 'run_B', session: 's_1', owner_label: 'check B' }
  const wcOf = (tab) => browser.contentsOf(tab)
  const allWindows = () => BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), visible: w.isVisible(), focused: w.isFocused() }))
  let a = null
  let b = null
  await check('two runs navigate their own tabs at once (Promise.all), each look shows its own page, never busy; hidden windows only', async (result) => {
    const [na, nb] = await Promise.all([timed(() => computer.act({ ...A, action: 'navigate', url: `${base}/a` })), timed(() => computer.act({ ...B, action: 'navigate', url: `${base}/b` }))])
    result.statuses = [na.out.status, nb.out.status]
    assert.deepEqual(result.statuses, ['ok', 'ok'])
    a = na.out; b = nb.out
    assert.notEqual(a.tab_id, b.tab_id)
    result.overlap_ms = Math.min(na.end, nb.end) - Math.max(na.start, nb.start)
    result.durations_ms = [na.end - na.start, nb.end - nb.start]
    result.colours = [colour(a.image), colour(b.image)]
    assert.ok(near(result.colours[0].rgb, COLORS.a), `A's look shows page a (${result.colours[0].rgb})`)
    assert.ok(near(result.colours[1].rgb, COLORS.b), `B's look shows page b (${result.colours[1].rgb})`)
    assert.deepEqual(result.colours[0].size, { width: 1280, height: 800 }, 'model picture 1280x800')
    result.display = a.display_image ? { width: a.display_image.width, height: a.display_image.height } : null
    assert.deepEqual(result.display, { width: 2560, height: 1600 }, 'display picture keeps 2x device pixels')
    result.windows = allWindows()
    assert.ok(result.windows.every((w) => !w.visible && !w.focused), 'no window visible or focused')
    result.backstage_windows = result.windows.filter((w) => w.title === 'oasis-code backstage').length
    assert.ok(result.backstage_windows >= 2, 'one hidden host per tab')
  })
  await check('Promise.all observe of both runs: overlapping in time, both ok, pictures of their own pages', async (result) => {
    const [oa, ob] = await Promise.all([timed(() => computer.observe(A)), timed(() => computer.observe(B))])
    result.statuses = [oa.out.status, ob.out.status]
    assert.deepEqual(result.statuses, ['ok', 'ok'])
    result.overlap_ms = Math.min(oa.end, ob.end) - Math.max(oa.start, ob.start)
    result.durations_ms = [oa.end - oa.start, ob.end - ob.start]
    assert.ok(result.overlap_ms > 0, 'the two looks were in flight at the same time')
    assert.ok(near(colour(oa.out.image).rgb, COLORS.a) && near(colour(ob.out.image).rgb, COLORS.b))
    a = oa.out; b = ob.out
  })
  await check('Promise.all click of both runs on their own pages: each page got exactly its own trusted click; innerWidth stays 1280x800', async (result) => {
    // the button's middle, in the look's picture pixels (1280x800 for a 1280x800 CSS viewport)
    const [ca, cb] = await Promise.all([timed(() => computer.act({ ...A, action: 'click', x: 660, y: 430, snapshot_id: a.snapshot_id })), timed(() => computer.act({ ...B, action: 'click', x: 640, y: 420, snapshot_id: b.snapshot_id }))])
    result.statuses = [ca.out.status, cb.out.status]
    assert.deepEqual(result.statuses, ['ok', 'ok'])
    result.overlap_ms = Math.min(ca.end, cb.end) - Math.max(ca.start, cb.start)
    assert.ok(result.overlap_ms > 0)
    result.pages = await Promise.all([wcOf(a.tab_id), wcOf(b.tab_id)].map((wc) => wc.executeJavaScript('({clicks, w: innerWidth, h: innerHeight})')))
    assert.deepEqual(result.pages[0].clicks, [{ x: 660, y: 430, trusted: true }])
    assert.deepEqual(result.pages[1].clicks, [{ x: 640, y: 420, trusted: true }])
    for (const p of result.pages) assert.deepEqual([p.w, p.h], [1280, 800])
    a = ca.out; b = cb.out
  })
  await check('A navigates and the person types on A\'s tab via the card; the card switching tabs: B\'s look is still current', async (result) => {
    bridge.placeBrowser({ x: 0, y: 0, width: 640, height: 400, visible: true })
    assert.equal(bridge.browserTab({ action: 'switch', id: a.tab_id }).ok, true)
    result.input = await bridge.browserInput({ type: 'mouseDown', x: 10, y: 10, page: browser.shownPage() })
    await bridge.browserInput({ type: 'mouseUp', x: 10, y: 10, page: browser.shownPage() })
    // the person used A's tab a moment ago: A waits (person_active, 3 s quiet) — B is not concerned
    result.a_right_after_person = (await computer.act({ ...A, action: 'navigate', url: `${base}/a?again` })).status
    assert.equal(result.a_right_after_person, 'person_active')
    assert.equal(bridge.browserTab({ action: 'switch', id: b.tab_id }).ok, true)
    const out = await computer.act({ ...B, action: 'click', x: 640, y: 420, snapshot_id: b.snapshot_id })
    result.b = out.status
    assert.equal(out.status, 'ok')
    b = out
  })
  await check('after run A ended (released), an approval of its look acts on A\'s original tab; a look of a closed tab is stale', async (result) => {
    await delay(3200)                                                            // the person's 3 s on A's tab are over
    const look = await computer.observe(A)
    computer.releaseOwner({ owner: 'run_A' })
    assert.equal((await computer.act({ ...B, action: 'navigate', url: `${base}/b?x` })).status, 'ok')
    await wcOf(look.tab_id).executeJavaScript('clicks=[]')
    const approved = await computer.act({ ...A, approval: true, action: 'click', x: 660, y: 430, snapshot_id: look.snapshot_id, tab_id: look.tab_id })
    result.approved = approved.status
    assert.equal(approved.status, 'ok')
    assert.equal(approved.tab_id, look.tab_id)
    assert.equal((await wcOf(look.tab_id).executeJavaScript('clicks')).length, 1)
    computer.releaseOwner({ owner: 'run_A' })
    assert.equal(bridge.browserTab({ action: 'close', id: look.tab_id }).ok, true)
    const stale = await computer.act({ ...A, approval: true, action: 'click', x: 660, y: 430, snapshot_id: approved.snapshot_id, tab_id: look.tab_id })
    result.after_close = stale.status
    assert.equal(stale.status, 'stale'); assert.equal(stale.image, undefined)
  })
  await check('live pictures follow the run\'s own tab; the card\'s names its showing', async (result) => {
    const fb = await bridge.surfaceFrame({ surface: 'browser', owner: 'run_B' })
    result.fb = { tab: fb.tab_id, size: fb.image ? { width: fb.image.width, height: fb.image.height } : null }
    assert.equal(fb.tab_id, b.tab_id)
    assert.ok(near(colour(fb.image).rgb, COLORS.b))
    const card = await bridge.surfaceFrame('browser')
    result.card = { tab: card.tab_id, page: card.page, shown: browser.shownPage() }
    assert.equal(card.page, browser.shownPage())
  })
  await check('Clear data refused while B holds a tab; after B lets go it closes every tab and leaves one blank tab', async (result) => {
    result.refused = await bridge.clearBrowserData()
    assert.equal(result.refused.cleared, false)
    computer.releaseOwner({ owner: 'run_B' })
    result.cleared = await bridge.clearBrowserData()
    assert.deepEqual(result.cleared, { cleared: true })
    result.tabs = browser.all()
    assert.equal(result.tabs.length, 1); assert.equal(result.tabs[0].owner, null)
    const stale = await computer.act({ ...B, approval: true, action: 'click', x: 1, y: 1, snapshot_id: b.snapshot_id, tab_id: b.tab_id })
    assert.equal(stale.status, 'stale')
    result.windows = allWindows()
    assert.ok(result.windows.every((w) => !w.visible && !w.focused))
  })
})().catch((error) => { console.error(error.stack || error); results.push({ name: 'harness', passed: false, error: String(error.stack || error) }) }).finally(async () => {
  try { if (bridge) await bridge.close() } catch { /* closing */ }
  if (host && !host.isDestroyed()) host.destroy()
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
  const failed = results.filter((r) => !r.passed).length
  fs.writeFileSync(path.join(output, 'agent-tabs.json'), JSON.stringify({ electron: process.versions.electron, platform: process.platform, scale: screen.getPrimaryDisplay().scaleFactor, isolated_root_removed: true, passed: results.length - failed, total: results.length, results }, null, 2))
  console.log(`Result: ${results.length - failed}/${results.length} passed; temporary profile and data removed.`)
  app.exit(failed ? 1 : 0)
})
