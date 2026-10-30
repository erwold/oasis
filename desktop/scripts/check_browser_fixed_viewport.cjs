// Real Electron regression, isolated profile and hidden/unfocusable windows only.
// electron desktop/scripts/check_browser_fixed_viewport.cjs <output-directory>
// BROWSER_FIXED_TEST_ROOT optionally points to baseline desktop modules for the identical red run.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, WebContentsView, nativeImage, screen } = require('electron')
const source = process.env.BROWSER_FIXED_TEST_ROOT || path.resolve(__dirname, '..')
const { agentBrowser, backstage, electronSurface, pickElement } = require(path.join(source, 'computer_electron'))
const { browserControls } = require(path.join(source, 'bridge'))
const output = path.resolve(process.argv[2])
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-fixed-viewport-check-'))
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(profile, 'user'))
app.setPath('sessionData', path.join(profile, 'sessions'))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
app.on('window-all-closed', () => {})
let host, stage, browser
const results = []
async function check(name, run) {
  const result = { name }
  try { await run(result); result.passed = true } catch (error) { result.passed = false; result.error = String(error.stack || error) }
  results.push(result)
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(result))
}
const html = `<!doctype html><title>Fixed viewport regression</title><style>
body{margin:0;height:2400px;background:repeating-linear-gradient(115deg,#bce 0 60px,#fda 60px 120px);font:22px sans-serif}
#buy{position:absolute;left:1000px;top:620px;width:180px;height:70px;background:#17a64b;color:white;font:24px sans-serif}
#field{position:absolute;left:900px;top:520px;width:280px;height:70px;font:24px sans-serif}
#desktop{display:block}#mobile{display:none}@media(max-width:800px){#desktop{display:none}#mobile{display:block}}
</style><h1 id=desktop>Desktop 1280 × 800</h1><h1 id=mobile>Mobile layout</h1><textarea id=field></textarea><button id=buy>Target</button>
<script>window.resizes=[];window.clicks=[];window.keys=[];addEventListener('resize',()=>resizes.push({w:innerWidth,h:innerHeight}));buy.onclick=e=>clicks.push({x:e.clientX,y:e.clientY,trusted:e.isTrusted});field.onkeydown=e=>keys.push({key:e.key,trusted:e.isTrusted});</script>`
;(async () => {
  await app.whenReady()
  if (app.dock) app.dock.hide()
  fs.writeFileSync(path.join(output, 'environment.json'), JSON.stringify({ pid: process.pid, argv: process.argv, electron: process.versions.electron, scale: screen.getPrimaryDisplay().scaleFactor, profile, source }, null, 2))
  host = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: 1800, height: 1100, webPreferences: { backgroundThrottling: false } })
  stage = backstage({ BrowserWindow })
  browser = agentBrowser({ WebContentsView, host: () => host, stage })
  browser.place({ x: 0, y: 0, width: 457, height: 356, visible: true })
  const wc = browser.contents()
  const surface = electronSurface({ label: 'fixed viewport test', contents: browser.contents, opened: browser.opened, allowsUrl: browser.allows, nativeImage, deviceScale: 2, pageId: browser.shownPage })
  const driver = surface.open()
  await wc.loadURL(`data:text/html,${encodeURIComponent(html)}`)
  await driver.screenshot((await driver.info()).viewport)
  await delay(100)
  await wc.executeJavaScript('resizes=[]')
  const read = () => wc.executeJavaScript('({width:innerWidth,height:innerHeight,resizeEvents:resizes,desktop:getComputedStyle(desktop).display,button:JSON.parse(JSON.stringify(buy.getBoundingClientRect()))})')
  for (const [name, place] of [
    ['small', { x: 10, y: 10, width: 457, height: 356, visible: true }],
    ['large', { x: 20, y: 30, width: 1600, height: 900, visible: true }],
    ['folded', { x: 0, y: 0, width: 0, height: 0, visible: false }],
    ['reopened', { x: 20, y: 20, width: 480, height: 600, visible: true }],
  ]) await check(name, async (result) => {
    browser.place(place)
    await delay(100)
    result.page = await read()
    const info = await driver.info(), image = await driver.screenshot(info.viewport, { displayImage: true })
    result.model = nativeImage.createFromBuffer(Buffer.from(image.data_base64, 'base64')).getSize()
    result.display = image.display_image ? nativeImage.createFromBuffer(Buffer.from(image.display_image.data_base64, 'base64')).getSize() : null
    fs.writeFileSync(path.join(output, `${name}-model.jpg`), Buffer.from(image.data_base64, 'base64'))
    if (image.display_image) fs.writeFileSync(path.join(output, `${name}-display.jpg`), Buffer.from(image.display_image.data_base64, 'base64'))
    assert.deepEqual([result.page.width, result.page.height], [1280, 800])
    assert.deepEqual(result.page.resizeEvents, [])
    assert.equal(result.page.desktop, 'block')
    assert.deepEqual(result.model, { width: 1280, height: 800 })
    assert.deepEqual(result.display, { width: 2560, height: 1600 })
  })
  const controls = browserControls({ browser, surface, pick: (page) => pickElement(page, { timeoutMs: 3000 }) })
  const input = (event) => controls.input({ ...event, page: browser.shownPage() })
  await check('click-keyboard-ime-paste', async (result) => {
    assert.equal(typeof controls.input, 'function')
    assert.equal((await input({ type: 'mouseDown', x: 1090, y: 655 })).ok, true)
    assert.equal((await input({ type: 'mouseUp', x: 1090, y: 655 })).ok, true)
    await input({ type: 'mouseDown', x: 1040, y: 550 }); await input({ type: 'mouseUp', x: 1040, y: 550 })
    await input({ type: 'text', text: '上海 paste' })
    await input({ type: 'keyDown', keyCode: 'Enter', code: 'Enter' }); await input({ type: 'keyUp', keyCode: 'Enter', code: 'Enter' })
    await input({ type: 'text', text: 'second line' })
    result.state = await wc.executeJavaScript('({clicks,keys,value:field.value,focused:document.activeElement.id})')
    assert.deepEqual(result.state.clicks, [{ x: 1090, y: 655, trusted: true }])
    assert.equal(result.state.value, '上海 paste\nsecond line')
    assert.equal(result.state.focused, 'field')
    const key = async (keyCode, modifiers = []) => { await input({ type: 'keyDown', keyCode, modifiers }); await input({ type: 'keyUp', keyCode, modifiers }) }
    await key('a', [process.platform === 'darwin' ? 'meta' : 'control'])
    await input({ type: 'text', text: 'edit123' })
    await key('ArrowLeft'); await key('Backspace')
    result.edited = await wc.executeJavaScript('field.value')
    assert.equal(result.edited, 'edit13', 'select-all, caret navigation and delete act on the remote field')
    await key('Tab')
    result.tabFocus = await wc.executeJavaScript('document.activeElement.id')
    assert.equal(result.tabFocus, 'buy')
    await key('Tab', ['shift'])
    result.shiftTabFocus = await wc.executeJavaScript('document.activeElement.id')
    assert.equal(result.shiftTabFocus, 'field')
  })
  await check('element-picker', async (result) => {
    assert.equal(typeof controls.input, 'function')
    const picked = controls.pick()
    await delay(150)
    await input({ type: 'mouseMove', x: 1090, y: 655 })
    await input({ type: 'mouseDown', x: 1090, y: 655 }); await input({ type: 'mouseUp', x: 1090, y: 655 })
    const found = await picked
    result.picked = found && { selector: found.selector, tag: found.tag, text: found.text, rect: found.rect }
    assert.equal(result.picked && result.picked.selector, '#buy')
  })
  await check('scroll-and-overlapping-capture', async (result) => {
    assert.equal(typeof controls.input, 'function')
    const shot = driver.screenshot((await driver.info()).viewport, { displayImage: true })
    const click = input({ type: 'mouseDown', x: 1090, y: 655 })
    browser.place({ x: 600, y: 70, width: 300, height: 200, visible: true })
    const image = await shot
    await click; await input({ type: 'mouseUp', x: 1090, y: 655 })
    const raw = nativeImage.createFromBuffer(Buffer.from(image.display_image.data_base64, 'base64'))
    const pixels = raw.toBitmap(); let count = 0, sum = 0, squares = 0
    for (let i = 0; i < pixels.length; i += 160) { const x = pixels[i]; count++; sum += x; squares += x*x }
    result.variance = squares/count - (sum/count)**2
    result.picture = raw.getSize()
    fs.writeFileSync(path.join(output, 'overlapping-display.jpg'), Buffer.from(image.display_image.data_base64, 'base64'))
    await input({ type: 'mouseWheel', x: 600, y: 400, deltaX: 0, deltaY: 420 })
    await delay(200)
    await surface.frame()
    await delay(100)
    result.scroll = await wc.executeJavaScript('({x:scrollX,y:scrollY,resizeEvents:resizes,width:innerWidth,height:innerHeight})')
    assert.ok(result.variance > 100, 'concurrent warm-up must not erase the capture')
    assert.deepEqual(result.picture, { width: 2560, height: 1600 })
    assert.ok(result.scroll.y > 100)
    assert.deepEqual(result.scroll.resizeEvents, [])
    assert.deepEqual([result.scroll.width,result.scroll.height], [1280,800])
  })
  await check('same-tab-document-replacement', async (result) => {
    const before = browser.shownPage()
    const identities = []
    wc.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) identities.push({ at: 'start', page: browser.shownPage() }) })
    wc.on('did-navigate', () => identities.push({ at: 'commit', page: browser.shownPage() }))
    const loaded = new Promise((resolve) => wc.once('did-finish-load', resolve))
    await wc.executeJavaScript("location.href = 'about:blank'").catch(() => undefined)
    await loaded
    result.identities = { before, events: identities, after: browser.shownPage() }
    assert.ok(identities.some((entry) => entry.at === 'start' && entry.page !== before))
    assert.ok(identities.some((entry) => entry.at === 'commit' && entry.page !== identities[0].page))
    result.oldInput = await controls.input({ type: 'text', text: 'must not reach the new document', page: before })
    assert.equal(result.oldInput.ok, false)
  })
})().catch((error) => { console.error(error.stack || error); results.push({ name: 'harness', passed: false }) }).finally(() => {
  if (browser) browser.close()
  if (stage) stage.close()
  if (host && !host.isDestroyed()) host.destroy()
  fs.rmSync(profile, { recursive: true, force: true })
  const failed = results.filter((r) => !r.passed).length
  console.log(`Result: ${results.length - failed}/${results.length} passed; profile removed.`)
  app.exit(failed ? 1 : 0)
})
