// Rendering gate for agent-owned browser tabs: real Electron, isolated temporary profile, hidden unfocusable windows
// only (never shown, never focused, no system screenshot). Proves that two (and three) pages that are NOT brought to
// the front can be captured and driven by CDP at the same time, each picture showing its own page.
//
//   electron desktop/scripts/check_browser_parallel_tabs.cjs <output-directory> [shared|per-host|both]
//
// shared:   every page's WebContentsView sits in ONE hidden backstage window, all at 0,0 1280x800, overlapping.
// per-host: every page has its own hidden backstage window (same partition, same tab manager in the app).
// Writes <output>/rendering-gate.json and prints one JSON line per check.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, WebContentsView, nativeImage, screen } = require('electron')
const { cdpDriver, jpegSize } = require('../computer_electron')
const { cdpOf } = require('../cdp')

const scriptAt = process.argv.findIndex((arg) => path.resolve(arg) === __filename)
const output = path.resolve(process.argv[scriptAt + 1] || fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-tabs-gate-')))
const which = process.argv[scriptAt + 2] || 'both'
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-parallel-tabs-gate-'))
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(profile, 'user-data'))
app.setPath('sessionData', path.join(profile, 'session-data'))
app.on('window-all-closed', () => {})
const PARTITION = 'persist:oasis-gate-browser'
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const windows = new Set()
const COLORS = [[220, 40, 40], [30, 150, 60], [40, 70, 210]]

const pageHtml = (n, [r, g, b]) => `<!doctype html><title>page ${n}</title><style>
html,body{margin:0;width:100%;height:100%;background:rgb(${r},${g},${b});font:28px sans-serif;color:white}
#count{position:absolute;left:20px;top:20px}#field{position:absolute;left:200px;top:300px;width:300px;height:60px;font:24px sans-serif}
#btn{position:absolute;left:${600 + n * 120}px;top:${400 + n * 50}px;width:100px;height:60px}</style>
<div id=count>0</div><textarea id=field></textarea><button id=btn>B${n}</button>
<script>window.frames_=0;window.clicks=[];window.keys=[];(function tick(){frames_++;count.textContent='page ${n} frame '+frames_;requestAnimationFrame(tick)})();
btn.onclick=e=>clicks.push({x:e.clientX,y:e.clientY,trusted:e.isTrusted});field.onkeydown=e=>keys.push({key:e.key,trusted:e.isTrusted});</script>`

function centreColour(image) {
  const im = nativeImage.createFromBuffer(Buffer.from(image.data_base64, 'base64'))
  const { width, height } = im.getSize()
  const bmp = im.toBitmap() // BGRA
  const at = (x, y) => { const i = (Math.floor(y) * width + Math.floor(x)) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i]] }
  return { size: { width, height }, sample: at(width * 0.9, height * 0.15) }
}
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 40)

async function check(name, run) {
  const result = { name, at: new Date().toISOString() }
  try { await run(result); result.passed = true } catch (error) { result.passed = false; result.error = String(error.stack || error) }
  results.push(result)
  fs.writeFileSync(path.join(output, 'rendering-gate.json'), JSON.stringify({ electron: process.versions.electron, platform: process.platform, scale: screen.getPrimaryDisplay().scaleFactor, profile_removed_at_end: true, results }, null, 2))
  console.log(JSON.stringify({ ...result, error: result.error ? result.error.split('\n')[0] : undefined }))
}

async function makePages(mode, count) {
  const shared = mode === 'shared' ? new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: 1920, height: 1200, title: 'gate backstage', webPreferences: { backgroundThrottling: false } }) : null
  if (shared) windows.add(shared)
  const pages = []
  for (let n = 0; n < count; n += 1) {
    const host = shared || new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: 1280, height: 800, title: `gate host ${n}`, webPreferences: { backgroundThrottling: false } })
    windows.add(host)
    const view = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    view.setBackgroundColor('#ffffff')
    host.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 })
    view.setVisible(true)
    const wc = view.webContents
    await wc.loadURL(`data:text/html,${encodeURIComponent(pageHtml(n, COLORS[n]))}`)
    const cdp = cdpOf(wc)
    cdp.attach()
    await cdp.send('Page.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: 2, mobile: false })
    pages.push({ n, host, view, wc, driver: cdpDriver(wc, { nativeImage, label: `gate page ${n}` }) })
  }
  return { shared, pages }
}

function closePages(set) {
  for (const p of set.pages) { try { cdpOf(p.wc).close() } catch {} if (!p.wc.isDestroyed()) p.wc.close(); if (p.host !== set.shared && !p.host.isDestroyed()) { p.host.destroy(); windows.delete(p.host) } }
  if (set.shared && !set.shared.isDestroyed()) { set.shared.destroy(); windows.delete(set.shared) }
}

async function gate(mode, count) {
  const set = await makePages(mode, count)
  const label = `${mode}/${count}`
  try {
    await check(`${label}: cold concurrent capture shows each page (never shown, never focused)`, async (result) => {
      const t0 = Date.now()
      const shots = await Promise.all(set.pages.map(async (p) => { const s = Date.now(); const raw = await p.driver.screenshot({ width: 1280, height: 800 }, { devicePixels: true, maxSide: 2560, timeoutMs: 8000 }); return { raw, ms: Date.now() - s } }))
      result.total_ms = Date.now() - t0
      result.each_ms = shots.map((s) => s.ms)
      result.pictures = shots.map((s, i) => ({ jpeg: jpegSize(Buffer.from(s.raw.data_base64, 'base64')), ...centreColour(s.raw), want: COLORS[i] }))
      shots.forEach((s, i) => fs.writeFileSync(path.join(output, `${mode}-${count}-cold-${i}.jpg`), Buffer.from(s.raw.data_base64, 'base64')))
      for (const pic of result.pictures) {
        assert.deepEqual(pic.jpeg, { width: 2560, height: 1600 }, 'DSF2 unclipped full picture')
        assert.ok(near(pic.sample, pic.want), `picture shows its own page colour ${pic.want} (got ${pic.sample})`)
      }
      result.windows = [...windows].map((w) => ({ visible: w.isVisible(), focused: w.isFocused() }))
      assert.ok(result.windows.every((w) => !w.visible && !w.focused), 'no window visible or focused')
      result.visibility = await Promise.all(set.pages.map((p) => p.wc.executeJavaScript('document.visibilityState')))
    })
    await check(`${label}: 6 rounds of concurrent captures keep pages distinct and progressing`, async (result) => {
      const rounds = []
      for (let r = 0; r < 6; r += 1) {
        const t0 = Date.now()
        const shots = await Promise.all(set.pages.map((p) => p.driver.screenshot({ width: 1280, height: 800 }, { devicePixels: true, maxSide: 2560, timeoutMs: 8000 })))
        const frames = await Promise.all(set.pages.map((p) => p.wc.executeJavaScript('frames_')))
        rounds.push({ ms: Date.now() - t0, colours: shots.map((s) => centreColour(s).sample), bytes: shots.map((s) => s.data_base64.length), frames })
        shots.forEach((s, i) => assert.ok(near(centreColour(s).sample, COLORS[i]), `round ${r}: page ${i} picture shows page ${i}`))
        await delay(50)
      }
      result.rounds = rounds
      // a page drawn only on capture still advances one frame per capture at least
      for (let i = 0; i < set.pages.length; i += 1) assert.ok(rounds[5].frames[i] > rounds[0].frames[i], `page ${i}'s frames advanced`)
      for (let i = 0; i < set.pages.length; i += 1) assert.ok(new Set(rounds.map((r) => r.bytes[i])).size > 1, `page ${i}'s pictures change`)
    })
    await check(`${label}: concurrent CDP click, insertText and key (with warm-up) land on their own pages only`, async (result) => {
      const t0 = Date.now()
      await Promise.all(set.pages.map(async (p) => {
        const bx = 650 + p.n * 120, by = 430 + p.n * 50
        await p.driver.click(bx, by)
        await p.driver.click(350, 330)
        await p.driver.insertText(`hello ${p.n}`)
        await p.driver.key('Enter')
        await p.driver.insertText('again')
      }))
      result.ms = Date.now() - t0
      result.pages = await Promise.all(set.pages.map((p) => p.wc.executeJavaScript('({clicks,keys,value:field.value,focused:document.activeElement.id})')))
      result.pages.forEach((st, n) => {
        assert.deepEqual(st.clicks, [{ x: 650 + n * 120, y: 430 + n * 50, trusted: true }], `page ${n} got exactly its own click`)
        assert.equal(st.value, `hello ${n}\nagain`, `page ${n} got exactly its own text`)
        assert.ok(st.keys.length >= 1 && st.keys.every((k) => k.trusted))
      })
      result.windows = [...windows].map((w) => ({ visible: w.isVisible(), focused: w.isFocused() }))
      assert.ok(result.windows.every((w) => !w.visible && !w.focused), 'no window visible or focused after input')
    })
    await check(`${label}: capture of one page overlapping input on another`, async (result) => {
      const [a, b] = set.pages
      await b.wc.executeJavaScript('clicks=[]')
      const [shot] = await Promise.all([a.driver.screenshot({ width: 1280, height: 800 }, { devicePixels: true, maxSide: 2560, timeoutMs: 8000 }), b.driver.click(650 + 120, 430 + 50)])
      result.colour = centreColour(shot).sample
      result.b_clicks = await b.wc.executeJavaScript('clicks')
      assert.ok(near(result.colour, COLORS[0]))
      assert.equal(result.b_clicks.length, 1)
    })
  } finally { closePages(set) }
}

;(async () => {
  await app.whenReady()
  try { if (process.platform === 'darwin' && typeof app.setActivationPolicy === 'function') app.setActivationPolicy('accessory') } catch { /* dock hidden below */ }
  if (app.dock) app.dock.hide()
  const modes = which === 'both' ? ['shared', 'per-host'] : [which]
  for (const mode of modes) { await gate(mode, 2); await gate(mode, 3) }
})().catch((error) => { console.error(error.stack || error); results.push({ name: 'harness', passed: false, error: String(error.stack || error) }) }).finally(() => {
  for (const w of windows) if (!w.isDestroyed()) w.destroy()
  fs.rmSync(profile, { recursive: true, force: true })
  const failed = results.filter((r) => !r.passed).length
  fs.writeFileSync(path.join(output, 'rendering-gate.json'), JSON.stringify({ electron: process.versions.electron, platform: process.platform, scale: screen.getPrimaryDisplay ? screen.getPrimaryDisplay().scaleFactor : null, passed: results.length - failed, total: results.length, results }, null, 2))
  console.log(`Result: ${results.length - failed}/${results.length} passed; profile removed.`)
  app.exit(failed ? 1 : 0)
})
