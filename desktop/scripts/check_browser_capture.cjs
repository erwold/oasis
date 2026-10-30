// Standalone real Electron regression, kept out of the fast unit suite.
// electron desktop/scripts/check_browser_capture.cjs <output-directory>
// BROWSER_CAPTURE_MODULE may name an older computer_electron.js for a red/green comparison.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, WebContentsView, nativeImage, screen } = require('electron')
const { cdpDriver } = require(process.env.BROWSER_CAPTURE_MODULE || '../computer_electron')
const scriptAt = process.argv.findIndex((arg) => path.resolve(arg) === __filename)
const output = path.resolve(process.argv[scriptAt + 1] || fs.mkdtempSync(path.join(os.tmpdir(), 'browser-capture-report-')))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-browser-capture-'))
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(profile, 'user-data'))
app.setPath('sessionData', path.join(profile, 'session-data'))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const windows = new Set()
const pages = new Set()
const html = `<!doctype html><style>html,body{margin:0;background:#ececec;width:100%;height:100%}h1{font:32px sans-serif;color:#125}.stripes{position:absolute;inset:100px 0 0;background:repeating-linear-gradient(90deg,#193d6d 0 13px,#d8e8f5 13px 26px)}</style><h1>Browser capture regression</h1><div class=stripes></div>`

async function fixture() {
  const win = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: 1450, height: 900, webPreferences: { backgroundThrottling: false } })
  windows.add(win)
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true } })
  const wc = view.webContents
  pages.add(wc)
  win.contentView.addChildView(view)
  view.setVisible(true)
  view.setBounds({ x: 0, y: 0, width: 1280, height: 800 })
  await wc.loadURL(`data:text/html,${encodeURIComponent(html)}`)
  wc.debugger.attach('1.3')
  await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: 2, mobile: false })
  let captureStarted
  const started = new Promise((resolve) => { captureStarted = resolve })
  const send = wc.debugger.sendCommand.bind(wc.debugger)
  wc.debugger.sendCommand = (method, params) => {
    const response = send(method, params)
    if (method === 'Page.captureScreenshot') captureStarted()
    return response
  }
  return {
    view, wc, started, driver: cdpDriver(wc, { nativeImage }),
    close() { wc.close(); pages.delete(wc); win.destroy(); windows.delete(win) },
  }
}

function pixels(image) {
  const raw = Buffer.from(image.data_base64, 'base64')
  const im = nativeImage.createFromBuffer(raw), bitmap = im.toBitmap()
  let count = 0, sum = 0, sum2 = 0
  const stride = Math.max(4, Math.floor(bitmap.length / 16000 / 4) * 4)
  for (let i = 0; i + 2 < bitmap.length; i += stride) {
    const brightness = (bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3
    count += 1; sum += brightness; sum2 += brightness * brightness
  }
  return { ...im.getSize(), bytes: raw.length, variance: sum2 / count - (sum / count) ** 2 }
}

async function check(name, action) {
  const env = await fixture()
  const result = { name }
  try { await action(env, result); result.passed = true } catch (error) { result.passed = false; result.error = String(error.stack || error) }
  finally { env.close() }
  results.push(result)
  console.log(JSON.stringify(result))
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
}

app.on('window-all-closed', () => {})
;(async () => {
  await app.whenReady()
  fs.writeFileSync(path.join(output, 'environment.json'), JSON.stringify({ pid: process.pid, argv: process.argv, electron: process.versions.electron, profile, displayScale: screen.getPrimaryDisplay().scaleFactor }, null, 2))
  for (let i = 0; i < 3; i += 1) {
    await check(`resize-${i}`, async ({ driver, view, started }, result) => {
      const image = driver.screenshot({ width: 1280, height: 800 }, { devicePixels: true, maxSide: 2560 })
      await started; await delay(5)
      view.setBounds({ x: 0, y: 0, width: 408, height: 236 })
      result.image = pixels(await image)
      await delay(100)
      result.bounds = view.getBounds()
      result.viewport = (await driver.info()).viewport
      assert.deepEqual(result.viewport, { width: 408, height: 236 }, 'capture must not restore the previous card viewport')
    })
    await check(`click-overlap-${i}`, async ({ driver, started }, result) => {
      const picture = driver.screenshot({ width: 1280, height: 800 }, { devicePixels: true, maxSide: 2560 })
      await started
      const click = driver.click(400, 300)
      const image = await picture
      await click
      result.image = pixels(image)
      fs.writeFileSync(path.join(output, `${result.name}.jpg`), Buffer.from(image.data_base64, 'base64'))
      assert.ok(result.image.variance > 1000, `capture must keep the page content, got variance ${result.image.variance}`)
      assert.deepEqual([result.image.width, result.image.height], [2560, 1600], 'the browser must retain its real 2x pixels')
    })
  }
})().catch((error) => { console.error(error.stack || error); results.push({ name: 'harness', passed: false }) }).finally(() => {
  for (const wc of pages) if (!wc.isDestroyed()) wc.close()
  for (const win of windows) if (!win.isDestroyed()) win.destroy()
  fs.rmSync(profile, { recursive: true, force: true })
  const failures = results.filter((result) => !result.passed).length
  console.log(`Result: ${results.length - failures}/${results.length} passed; temporary profile removed.`)
  app.exit(failures ? 1 : 0)
})
