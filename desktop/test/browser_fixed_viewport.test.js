const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
// The same tests may load the baseline modules copied into handoff/ for a red/green run.
const root = process.env.BROWSER_FIXED_TEST_ROOT || path.resolve(__dirname, '..')
const { agentBrowser, browserInputCommand, electronSurface, jpegSize } = require(path.join(root, 'computer_electron'))
const { browserControls } = require(path.join(root, 'bridge'))
const jpg = (w, h) => Buffer.from([255, 216, 255, 192, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 34, 0, 2, 17, 1, 3, 17, 1, 255, 217])
const turn = () => new Promise((done) => setImmediate(done))
function fixture() {
  const views = []
  const win = () => ({ children: new Set(), isDestroyed: () => false, contentView: { addChildView(v) { this.owner.children.add(v) }, removeChildView(v) { this.owner.children.delete(v) } } })
  const main = win(), stage = win()
  main.contentView.owner = main; stage.contentView.owner = stage
  class View {
    constructor() {
      this.calls = []; this.bounds = { width: 0, height: 0 }
      const wc = this.webContents = new EventEmitter(), dbg = wc.debugger = new EventEmitter()
      wc.session = { webRequest: { onBeforeRequest() {} }, cookies: { get: async () => [], on() {} } }
      wc.getZoomFactor = () => 1; wc.setWindowOpenHandler = () => {}; wc.loadURL = async () => {}; wc.isDestroyed = () => false
      wc.getURL = () => 'https://example.org/'; wc.getTitle = () => 'Test'; wc.isLoading = () => false
      dbg.sent = []; dbg.attach = () => {}; dbg.sendCommand = async (method, params = {}) => {
        dbg.sent.push([method, params])
        if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: this.bounds.width, clientHeight: this.bounds.height } }
        if (method === 'Page.captureScreenshot') return { data: jpg(this.bounds.width * 2, this.bounds.height * 2).toString('base64') }
        return {}
      }
      views.push(this)
    }
    setBackgroundColor() {}
    setVisible(v) { this.calls.push(['visible', v]) }
    setBounds(bounds) { this.bounds = bounds; this.calls.push(['bounds', bounds]) }
  }
  const browser = agentBrowser({ WebContentsView: View, host: () => main, stage: { window: () => stage } })
  const nativeImage = { createFromBuffer: () => ({ resize: ({ width, height }) => ({ toJPEG: () => jpg(width, height) }) }) }
  const surface = electronSurface({ label: 'browser', contents: browser.contents, opened: browser.opened, allowsUrl: browser.allows, nativeImage, deviceScale: 2, pageId: browser.shownPage })
  return { browser, views, main, stage, surface }
}

test('fixed viewport: small, large, moving, folded and reopened cards never resize or reparent the page', () => {
  const { browser, views, stage, main } = fixture()
  browser.contents()
  const view = views[0]
  view.calls.length = 0
  for (const place of [
    { x: 10, y: 20, width: 457, height: 356, visible: true },
    { x: 800, y: 60, width: 1600, height: 900, visible: true },
    { x: 0, y: 0, width: 0, height: 0, visible: false },
    { x: 40, y: 40, width: 480, height: 600, visible: true },
  ]) {
    browser.place(place)
    assert.deepEqual(browser.size(), { width: 1280, height: 800 })
    assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1280, height: 800 })
    assert.ok(stage.children.has(view)); assert.ok(!main.children.has(view))
  }
  assert.deepEqual(view.calls, [], 'no resize/visibility operation can reach the page as the card changes')
})

test('fixed viewport: each card state captures the full 1280x800 model image and its genuine 2560x1600 display image', async () => {
  const { browser, surface, views } = fixture()
  for (const [width, height, visible] of [[457, 356, true], [1600, 900, true], [0, 0, false], [600, 500, true]]) {
    browser.place({ x: 0, y: 0, width, height, visible })
    const driver = surface.open(), info = await driver.info()
    const image = await driver.screenshot(info.viewport, { displayImage: true })
    assert.deepEqual(info.viewport, { width: 1280, height: 800 })
    assert.deepEqual(jpegSize(Buffer.from(image.data_base64, 'base64')), { width: 1280, height: 800 })
    assert.deepEqual(jpegSize(Buffer.from(image.display_image.data_base64, 'base64')), { width: 2560, height: 1600 })
    const live = await surface.frame()
    assert.deepEqual([live.image.width, live.image.height], [2560, 1600])
  }
  const captures = views[0].webContents.debugger.sent.filter(([m]) => m === 'Page.captureScreenshot')
  assert.ok(captures.every(([, p]) => p.fromSurface === false && !p.clip), 'capture never changes viewport or compositor clip')
})

test('card input accepts only fixed CSS image coordinates, preserves wheel/key/text details and refuses protocol injection', () => {
  assert.equal(typeof browserInputCommand, 'function')
  assert.deepEqual(browserInputCommand({ type: 'mouseDown', x: 1100.25, y: 650.5, button: 'right', clickCount: 2, modifiers: ['shift'] }), {
    method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 1100.25, y: 650.5, button: 'right', clickCount: 2, modifiers: 8 },
  })
  const wheel = browserInputCommand({ type: 'mouseWheel', x: 640, y: 400, deltaX: 12.25, deltaY: 250.5 })
  assert.deepEqual([wheel.params.deltaX, wheel.params.deltaY], [12.25, 250.5])
  const key = browserInputCommand({ type: 'keyDown', keyCode: 'a', code: 'KeyA', location: 0, modifiers: ['meta'] }, 'darwin')
  assert.equal(key.params.type, 'rawKeyDown'); assert.deepEqual(key.params.commands, ['selectAll']); assert.equal(key.params.text, undefined)
  assert.equal(browserInputCommand({ type: 'keyDown', keyCode: 'Enter' }).params.text, '\r')
  assert.deepEqual(browserInputCommand({ type: 'text', text: '中文 pasted text' }), { method: 'Input.insertText', params: { text: '中文 pasted text' } })
  for (const raw of [null, {}, { type: 'Runtime.evaluate', expression: '1' }, { type: 'mouseDown', x: 1280, y: 0 }, { type: 'mouseDown', x: NaN, y: 2 }, { type: 'mouseDown', x: 2, y: -1 }, { type: 'mouseDown', x: 1, y: 1, button: 'evil' }, { type: 'mouseWheel', x: 1, y: 1, deltaX: 0, deltaY: Infinity }, { type: 'text', text: 'x'.repeat(65537) }, { type: 'keyDown', keyCode: 'a', modifiers: ['evil'] }]) assert.equal(browserInputCommand(raw), null)
})

test('person input is ordered, marks agent looks stale, warms clicks without mutation and never presses a tab changed while queued', async () => {
  const { browser, surface, views } = fixture()
  browser.place({ x: 0, y: 0, width: 457, height: 356, visible: true })
  const controls = browserControls({ browser, surface, pick: () => {} })
  assert.equal(typeof controls.input, 'function')
  const page = browser.shownPage(), initial = surface.generation()
  assert.equal((await controls.input({ type: 'mouseMove', x: 100, y: 100, page })).ok, true)
  assert.equal(surface.generation(), initial, 'hover alone is not a person action')
  const down = controls.input({ type: 'mouseDown', x: 1100, y: 650, page })
  const up = controls.input({ type: 'mouseUp', x: 1100, y: 650, page })
  assert.ok(surface.generation() > initial)
  assert.equal((await down).ok, true); assert.equal((await up).ok, true)
  const commands = views[0].webContents.debugger.sent
  const capture = commands.find(([m]) => m === 'Page.captureScreenshot')[1]
  assert.deepEqual(capture, { format: 'jpeg', quality: 1, fromSurface: false })
  assert.deepEqual(commands.filter(([m]) => m === 'Input.dispatchMouseEvent').map(([, p]) => p.type), ['mouseMoved', 'mouseMoved', 'mousePressed', 'mouseReleased'])
  assert.equal((await controls.input({ type: 'text', text: 'hello 世界', page })).ok, true)
  assert.deepEqual(commands.at(-1), ['Input.insertText', { text: 'hello 世界' }])
  assert.equal((await controls.input({ type: 'mouseDown', x: 1, y: 1, page: 'old-page' })).ok, false)
  const pending = controls.input({ type: 'mouseDown', x: 1, y: 1, page })
  await turn()
  browser.newTab()
  assert.equal((await pending).ok, false)
  assert.equal(views[0].webContents.debugger.sent.filter(([m, p]) => m === 'Input.dispatchMouseEvent' && p.type === 'mousePressed').length, 1)
})

test('browser-input IPC runs only for the app top frame and preload exposes its narrow input endpoint', async () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const handler = source.split(/(?=ipcMain\.(?:handle|on)\()/).find((h) => h.startsWith("ipcMain.handle('browser-input'"))
  assert.ok(handler, 'the app installs a browser-input handler')
  let call, sent = 0
  const appPage = {}, mainWindow = { webContents: appPage }
  vm.runInNewContext(handler.slice(0, handler.indexOf('\n})') + 3), {
    ipcMain: { handle: (_name, fn) => { call = fn } }, mainWindow, BASE_URL: 'http://127.0.0.1:8398',
    fromAppPage: (event) => event.top === true && event.origin === 'app',
    bridge: { browserInput: async () => { sent += 1; return { ok: true } } },
  })
  for (const event of [{ sender: {} }, { sender: appPage, top: false, origin: 'app' }, { sender: appPage, top: true, origin: 'site' }]) assert.equal(await call(event, { type: 'text', text: 'x' }), null)
  await call({ sender: appPage, top: true, origin: 'app' }, { type: 'text', text: 'x' })
  assert.equal(sent, 1)
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8')
  assert.match(preload, /browserInput:.*ipcRenderer\.invoke\('browser-input', input\)/)
})

test('consecutive queued mouse moves keep only the latest point without passing a mouse-up or key boundary', async () => {
  const { browser, surface, views } = fixture()
  browser.place({ x: 0, y: 0, width: 457, height: 356, visible: true })
  const controls = browserControls({ browser, surface, pick: () => {} })
  assert.equal(typeof controls.input, 'function')
  const dbg = views[0].webContents.debugger, send = dbg.sendCommand
  let release
  dbg.sendCommand = async (method, params) => {
    if (method === 'Page.captureScreenshot' && !release) await new Promise((done) => { release = done })
    return send(method, params)
  }
  const down = controls.input({ type: 'mouseDown', x: 100, y: 100 })
  while (!release) await turn()
  const pending = []
  for (let i = 0; i < 40; i += 1) pending.push(controls.input({ type: 'mouseMove', x: 200 + i, y: 150, button: 'left', buttons: 1 }))
  pending.push(controls.input({ type: 'mouseUp', x: 239, y: 150, button: 'left', buttons: 0 }))
  pending.push(controls.input({ type: 'mouseMove', x: 300, y: 200 }))
  pending.push(controls.input({ type: 'keyDown', keyCode: 'Enter' }))
  pending.push(controls.input({ type: 'mouseMove', x: 400, y: 200 }))
  release()
  assert.ok((await Promise.all([down, ...pending])).every((r) => r.ok))
  const mouse = dbg.sent.filter(([m]) => m === 'Input.dispatchMouseEvent').map(([, p]) => [p.type, p.x, p.buttons])
  assert.deepEqual(mouse, [
    ['mouseMoved', 100, undefined], ['mousePressed', 100, undefined],
    ['mouseMoved', 239, 1], ['mouseReleased', 239, 0], ['mouseMoved', 300, undefined], ['mouseMoved', 400, undefined],
  ])
})

test('same-tab address navigation rejects clicks and text queued for the previous document, including old mirror frames', async () => {
  const { browser, surface, views } = fixture()
  browser.place({ x: 0, y: 0, width: 457, height: 356, visible: true })
  const controls = browserControls({ browser, surface, pick: () => {} })
  const page = browser.shownPage(), dbg = views[0].webContents.debugger, send = dbg.sendCommand
  let release
  dbg.sendCommand = async (method, params) => {
    if (method === 'Page.captureScreenshot' && !release) await new Promise((done) => { release = done })
    return send(method, params)
  }
  const down = controls.input({ type: 'mouseDown', x: 100, y: 100, page })
  while (!release) await turn()
  const text = controls.input({ type: 'text', text: 'only for the old page', page })
  assert.equal(controls.navigate({ action: 'go', url: 'https://new.example/' }).ok, true)
  release()
  assert.notEqual(browser.shownPage(), page)
  assert.ok((await Promise.all([down, text])).every((r) => !r.ok))
  assert.equal((await controls.input({ type: 'text', text: 'late event from old frame', page })).ok, false)
  assert.deepEqual(dbg.sent.filter(([method]) => method.startsWith('Input.')), [])
})

test('page-driven main-frame navigation changes picture identity at start and commit; iframe navigation does not', async () => {
  const { browser, surface, views } = fixture()
  browser.place({ x: 0, y: 0, width: 457, height: 356, visible: true })
  const controls = browserControls({ browser, surface, pick: () => {} })
  const wc = views[0].webContents, page = browser.shownPage()
  wc.emit('did-start-navigation', {}, 'https://frame.example/', false, false)
  assert.equal(browser.shownPage(), page)
  const pending = controls.input({ type: 'text', text: 'stale queued input', page })
  wc.emit('did-start-navigation', {}, 'https://next.example/', false, true)
  assert.notEqual(browser.shownPage(), page)
  assert.equal((await pending).ok, false)
  const loading = browser.shownPage()
  wc.emit('did-navigate', {}, 'https://next.example/')
  assert.notEqual(browser.shownPage(), loading, 'a frame captured while the previous document was loading cannot act after commit')
  assert.equal((await controls.input({ type: 'text', text: 'stale loading frame', page: loading })).ok, false)
  const committed = browser.shownPage()
  wc.emit('did-navigate-in-page', {}, 'https://next.example/#route', true)
  assert.notEqual(browser.shownPage(), committed)
})
