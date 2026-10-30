// The Browser card's page as a pane (2026-10-16): the agent's browser is used on the card directly, laid out at the
// fixed desktop size with no page zoom, in tabs, with an address bar, back / forward / reload and an element picker; the
// person and the agent share the tab shown and its viewport. Every view, page and debugger here is a fake that keeps
// what it was asked: no Electron, no network, nothing outside the test's own objects.
const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const { createComputer } = require('../computer')
const electronSide = require('../computer_electron')
const { agentBrowser, electronSurface, HIDDEN_BOUNDS } = electronSide
const bridgeSide = require('../bridge')

/** The head of a JPEG of this size (its frame header is what jpegSize reads). */
function jpegOf(width, height) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9])
}

/** A page's debugger as far as a look goes: its viewport is its view's size (zoom 1), drawn at 2 device pixels per
 *  CSS pixel; every command is kept. */
function fakeDebugger(wc) {
  const dbg = new EventEmitter()
  dbg.attached = false
  dbg.sent = []
  dbg.attach = () => { dbg.attached = true }
  dbg.detach = () => { dbg.attached = false }
  dbg.isAttached = () => dbg.attached
  dbg.sendCommand = async (method, params = {}) => {
    dbg.sent.push([method, params])
    const b = (wc.view && wc.view.bounds) || { width: 1280, height: 800 }
    const css = { clientWidth: b.width / wc.zoom, clientHeight: b.height / wc.zoom, pageX: 0, pageY: 0 }
    if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: css, layoutViewport: { ...css, clientWidth: css.clientWidth * 2, clientHeight: css.clientHeight * 2 }, cssContentSize: { width: css.clientWidth, height: 2000 } }
    if (method === 'Page.captureScreenshot') return { data: jpegOf(css.clientWidth * 2, css.clientHeight * 2).toString('base64') }
    if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: wc.title }, backendDOMNodeId: 1, childIds: ['2'] }, { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Buy' }, backendDOMNodeId: 2, childIds: [] }] }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' }, childFrames: [] } }
    if (method === 'DOMSnapshot.captureSnapshot') return { documents: [] }
    if (method === 'DOM.getNodeForLocation') throw new Error('No node found at given location')
    return {}
  }
  return dbg
}

/** WebContentsViews as the agent browser makes them: their bounds and visibility as set (every call kept), their
 *  pages' zoom, address, history and debugger. */
function fakeViews() {
  const views = []
  const session = { webRequest: { onBeforeRequest: () => {} }, cookies: { get: async () => [], on: () => {}, remove: async () => {} }, on: () => {} }
  class View {
    constructor() {
      this.bounds = null; this.visible = null; this.calls = []
      const wc = new EventEmitter()
      wc.view = this
      wc.zoom = 1
      wc.zooms = []
      wc.destroyed = false
      wc.url = 'about:blank'
      wc.title = ''
      wc.loaded = []
      wc.back = []; wc.ahead = []
      wc.isDestroyed = () => wc.destroyed
      wc.getZoomFactor = () => wc.zoom
      wc.setZoomFactor = (z) => { wc.zoom = z; wc.zooms.push(z) }
      wc.setWindowOpenHandler = (fn) => { wc.openHandler = fn }
      wc.loadURL = async (url) => { if (wc.url !== 'about:blank' || wc.back.length) wc.back.push(wc.url); wc.ahead = []; wc.url = url; wc.loaded.push(url) }
      wc.getURL = () => wc.url
      wc.getTitle = () => wc.title
      wc.isLoading = () => false
      wc.reload = () => { wc.loaded.push(`reload ${wc.url}`) }
      wc.stop = () => {}
      wc.close = () => { wc.destroyed = true }
      wc.session = session
      wc.mainFrame = { framesInSubtree: [], processId: 1 }
      wc.navigationHistory = {
        canGoBack: () => wc.back.length > 0, canGoForward: () => wc.ahead.length > 0,
        goBack: () => { wc.ahead.push(wc.url); wc.url = wc.back.pop() }, goForward: () => { wc.back.push(wc.url); wc.url = wc.ahead.pop() },
        clear: () => { wc.back = []; wc.ahead = [] },
      }
      wc.debugger = fakeDebugger(wc)
      this.webContents = wc
      views.push(this)
    }
    setBackgroundColor() {}
    setBounds(b) { this.bounds = { ...b }; this.calls.push(['bounds', { ...b }]) }
    setVisible(v) { this.visible = v; this.calls.push(['visible', v]) }
  }
  return { View, views }
}
const fakeWindow = (name) => {
  const w = { name, children: new Set(), isDestroyed: () => false }
  w.contentView = { addChildView: (v) => w.children.add(v), removeChildView: (v) => w.children.delete(v) }
  return w
}
const setup = () => {
  const { View, views } = fakeViews()
  const main = fakeWindow('main')
  const stageWin = fakeWindow('stage')
  const lines = []
  const browser = agentBrowser({ WebContentsView: View, host: () => main, stage: { window: () => stageWin }, log: (l) => lines.push(l), harnessPorts: () => [8321] })
  return { browser, views, main, stageWin, lines }
}
const settle = () => new Promise((r) => setImmediate(r))

test("the card shows a fixed backstage page: moving, resizing and hiding it never changes the view", () => {
  const { browser, views, main, stageWin } = setup()
  browser.contents()
  const view = views[0]
  assert.ok(stageWin.children.has(view))
  assert.deepEqual(view.bounds, HIDDEN_BOUNDS)
  view.calls.length = 0
  const card = { x: 865, y: 86, width: 480, height: 600, visible: true }
  for (const next of [card, { ...card, width: 800 }, { ...card, width: 1120, visible: false }, { ...card, x: 20, y: 10, width: 1120 }]) {
    browser.place(next)
    assert.ok(stageWin.children.has(view) && !main.children.has(view))
    assert.deepEqual(view.bounds, HIDDEN_BOUNDS)
    assert.equal(browser.visibility().shown, next.visible)
    assert.deepEqual(browser.size(), { width: 1280, height: 800 })
  }
  assert.deepEqual(view.calls, [])
  assert.equal(browser.visibility().ever, true)
  assert.deepEqual(view.webContents.zooms, [])
  view.webContents.zoom = 0.375
  view.webContents.emit('did-navigate')
  assert.equal(view.webContents.zoom, 1)
})

test('repeated card placements, including a moved card, do not touch the browser view', () => {
  const { browser, views } = setup()
  const card = { x: 10, y: 20, width: 640, height: 480, visible: true }
  browser.place(card)
  const view = views[0]
  view.calls.length = 0
  for (let i = 0; i < 5; i += 1) browser.place({ ...card })
  browser.place({ ...card, x: 11 })
  assert.deepEqual(view.calls, [])
})

test("tabs: a new one is shown on the card; every tab stays seated at 1280x800 whichever is shown; the last one closed leaves a blank tab; reset leaves one blank tab", async () => {
  const { browser, views, stageWin } = setup()
  assert.equal(typeof browser.newTab, 'function', 'the browser has tabs')
  browser.place({ x: 0, y: 40, width: 800, height: 500, visible: true })
  const first = browser.activeTab()
  const second = browser.newTab('example.org/a')
  assert.notEqual(second, first)
  assert.equal(browser.activeTab(), second)
  assert.equal(browser.contents(), views[1].webContents)
  assert.deepEqual(views[1].webContents.loaded, ['https://example.org/a'])
  // showing another tab moves no page: both stay in their backstage (a test's single stage here; one hidden window per
  // tab in the app) at the same desktop viewport
  assert.ok(stageWin.children.has(views[1]) && stageWin.children.has(views[0]))
  for (const v of views) assert.deepEqual([v.bounds.width, v.bounds.height], [1280, 800])
  assert.deepEqual(browser.status().tabs.map((t) => [t.id, t.active, t.owner]), [[first, false, null], [second, true, null]])
  // a refused address opens no tab (the harness's own port, a file)
  assert.equal(browser.newTab('http://127.0.0.1:8321/'), null)
  assert.equal(browser.newTab('file:///etc/passwd'), null)
  assert.equal(browser.status().tabs.length, 2)
  views[0].calls.length = 0
  assert.equal(browser.switchTab(first), true)
  assert.equal(browser.contents(), views[0].webContents)
  assert.deepEqual(views[0].calls, [], 'switching never reseats a page')
  assert.equal(browser.switchTab('tab-404'), false)
  // the tab shown closed: its neighbour is shown
  assert.equal(browser.closeTab(first), true)
  assert.equal(views[0].webContents.isDestroyed(), true)
  assert.equal(stageWin.children.has(views[0]), false)
  assert.equal(browser.activeTab(), second)
  // the last one closed: a blank tab takes its place
  assert.equal(browser.closeTab(second), true)
  assert.equal(browser.status().tabs.length, 1)
  assert.equal(browser.status().url, 'about:blank')
  browser.newTab('https://example.org/private')
  browser.newTab('https://example.org/other')
  assert.equal(browser.status().tabs.length, 3)
  await browser.reset()
  assert.equal(browser.status().tabs.length, 1)
  assert.equal(browser.status().url, 'about:blank')
  // at most MAX_TABS
  while (browser.newTab() !== null) { /* until refused */ }
  assert.equal(browser.status().tabs.length, electronSide.MAX_TABS)
})

test('the address bar opens what the browser may open (a bare name over https, this machine over http); back, forward and reload go to the tab shown', () => {
  const { browser, views } = setup()
  assert.equal(typeof browser.navigate, 'function', 'the browser has an address bar')
  browser.contents()
  const wc = views[0].webContents
  assert.deepEqual(browser.navigate('go', 'example.com/docs'), { ok: true, url: 'https://example.com/docs' })
  assert.deepEqual(browser.navigate('go', 'localhost:5173'), { ok: true, url: 'http://localhost:5173/' })
  assert.equal(browser.navigate('go', 'http://localhost:8321/api').ok, false)          // the harness's own port
  assert.equal(browser.navigate('go', 'javascript:alert(1)').ok, false)
  assert.equal(browser.navigate('go', 'two words').ok, false)
  assert.equal(wc.url, 'http://localhost:5173/')
  assert.equal(browser.status().can_go_back, true)
  assert.deepEqual(browser.navigate('back'), { ok: true })
  assert.equal(wc.url, 'https://example.com/docs')
  assert.equal(browser.status().can_go_forward, true)
  assert.deepEqual(browser.navigate('forward'), { ok: true })
  assert.equal(wc.url, 'http://localhost:5173/')
  assert.deepEqual(browser.navigate('reload'), { ok: true })
  assert.equal(wc.loaded.at(-1), 'reload http://localhost:5173/')
  assert.equal(browser.navigate('forward').ok, false)
})

test("(single-page surface naming its page, e.g. a surface wired to the card's showing) a look is of the page shown: after the person shows another tab — same address, same size — a click on that look is stale and nothing is pressed on either", async () => {
  const { browser, views } = setup()
  assert.equal(typeof browser.shownPage, 'function', 'the browser names the tab shown')
  browser.place({ x: 0, y: 40, width: 800, height: 600, visible: true })
  const nativeImage = { createFromBuffer: () => ({ resize: (to) => ({ toJPEG: () => jpegOf(to.width, to.height) }) }) }
  const surface = electronSurface({ label: "the agent's browser", contents: browser.contents, opened: browser.opened, allowsUrl: browser.allows, reset: browser.reset, visibility: browser.visibility, nativeImage, deviceScale: 2, pageId: browser.shownPage })
  const computer = createComputer({ surfaces: { browser: surface }, instance: 'i1', settle: async () => {} })
  browser.navigate('go', 'https://shop.example/cart')
  const look = await computer.observe({ surface: 'browser', owner: 'run_1' })
  assert.equal(look.status, 'ok')
  assert.deepEqual(look.viewport, { width: 1280, height: 800 })
  // the person opens the same page in a new tab: same address, same size
  browser.newTab('https://shop.example/cart')
  const stale = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 100, y: 100, snapshot_id: look.snapshot_id })
  assert.equal(stale.status, 'stale')
  const pressed = (wc) => wc.debugger.sent.filter(([m]) => m === 'Input.dispatchMouseEvent')
  assert.deepEqual([pressed(views[0].webContents), pressed(views[1].webContents)], [[], []])
  // and back to the first tab: still not the look's moment (the page was shown away from and back)
  const second = await computer.observe({ surface: 'browser', owner: 'run_1' })
  browser.switchTab(browser.status().tabs[0].id)
  const back = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 100, y: 100, snapshot_id: second.snapshot_id })
  assert.equal(back.status, 'stale')
  assert.match(back.reason, /another tab/)
  assert.deepEqual([pressed(views[0].webContents), pressed(views[1].webContents)], [[], []])
})

test('a surface notices the tab shown changed without being opened, and keeps each tab\'s dialog to that tab', async () => {
  let id = 'tab-1'
  const pages = { 'tab-1': fakeViews(), 'tab-2': fakeViews() }
  const a = new (pages['tab-1'].View)().webContents
  const b = new (pages['tab-2'].View)().webContents
  const surface = electronSurface({ label: 'p', contents: () => (id === 'tab-1' ? a : b), opened: () => true, allowsUrl: () => true, pageId: () => id })
  surface.open()
  await settle()
  const g = surface.generation()
  id = 'tab-2'
  assert.ok(surface.generation() > g, 'another tab shown is a change of the page')
  assert.equal(surface.pageId(), 'tab-2')
  // a dialog opens on the tab no longer shown: the tab shown has none
  surface.open()
  a.debugger.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'alert', message: 'from tab 1' })
  assert.equal(surface.peek().dialog, null)
  id = 'tab-1'
  surface.open()
  assert.equal(surface.peek().dialog && surface.peek().dialog.message, 'from tab 1')
})

test('the computer refuses a look of another page than the one shown (a surface that names its pages)', async () => {
  const shot = { media_type: 'image/jpeg', data_base64: 'AAAA', width: 800, height: 600 }
  let page = 'tab-1'
  const pressed = []
  const driver = {
    info: async () => ({ url: 'https://shop.example/cart', title: 'Cart', loading: false, viewport: { width: 800, height: 600 } }),
    shallowInfo: () => ({ url: 'https://shop.example/cart', title: 'Cart', loading: false }),
    screenshot: async () => shot,
    tree: async () => [{ url: 'https://shop.example/cart', nodes: [] }],
    click: async (x, y) => { pressed.push([page, x, y]) },
  }
  const surface = {
    label: 'fake', opened: () => true, open: () => driver, generation: () => 0, pageId: () => page, personAt: () => null, allowsUrl: () => true, busy: () => null,
    events: () => ({ dialog: null, chooser: null, notes: [], downloads: [], console: [] }), peek: () => ({ dialog: null, chooser: null }), downloadsDone: () => 0, chooserUsed: () => {}, note: () => {},
  }
  const computer = createComputer({ surfaces: { browser: surface }, instance: 'i1', settle: async () => {} })
  const look = await computer.observe({ surface: 'browser', owner: 'run_1' })
  page = 'tab-2'
  const out = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 10, y: 10, snapshot_id: look.snapshot_id })
  assert.equal(out.status, 'stale')
  assert.match(out.reason, /another tab/)
  assert.deepEqual(pressed, [])
  const fresh = out.snapshot_id
  const ok = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 10, y: 10, snapshot_id: fresh })
  assert.equal(ok.status, 'ok')
  assert.deepEqual(pressed, [['tab-2', 10, 10]])
})

test("the card's controls are the person's use of the page: tabs, the address bar and the picker make an agent's earlier look stale", async () => {
  assert.equal(typeof bridgeSide.browserControls, 'function', 'the bridge has the card controls')
  const { browser } = setup()
  browser.place({ x: 0, y: 40, width: 800, height: 600, visible: true })
  let used = 0
  const surface = { personUsed: () => { used += 1 } }
  const picks = []
  const pick = () => { const p = { cancelled: false }; let done; p.promise = new Promise((r) => { done = r }); p.cancel = () => { p.cancelled = true; done(null) }; p.resolve = (v) => done(v); picks.push(p); return p }
  const controls = bridgeSide.browserControls({ browser, surface, pick })
  assert.equal(controls.tab({ action: 'new', url: 'https://example.org/' }).ok, true)
  assert.equal(used, 1)
  assert.equal(controls.navigate({ action: 'go', url: 'example.org/b' }).ok, true)
  assert.equal(used, 2)
  assert.equal(controls.navigate({ action: 'go', url: 'file:///etc/hosts' }).ok, false)
  assert.equal(used, 2)                                                            // nothing done: nothing used
  // the picker: what was picked comes back; a tab change ends a pick under way
  const first = controls.pick()
  picks[0].resolve({ tag: 'button', selector: '#buy', text: 'Buy', url: 'https://example.org/b' })
  assert.deepEqual(await first, { tag: 'button', selector: '#buy', text: 'Buy', url: 'https://example.org/b' })
  const second = controls.pick()
  controls.tab({ action: 'switch', id: browser.status().tabs[0].id })
  assert.equal(await second, null)
  assert.equal(picks[1].cancelled, true)
  assert.equal(controls.tab({ action: 'close', id: 'tab-404' }).ok, false)
  assert.equal(controls.tab({ action: 'explode' }).ok, false)
})

test('the element picker is the browser\'s own inspect mode: what the person clicks comes back described, and the mode ends; a navigation or a cancel gives nothing', async () => {
  assert.equal(typeof electronSide.pickElement, 'function', 'the browser has an element picker')
  const { View } = fakeViews()
  const wc = new View().webContents
  wc.url = 'https://example.org/b'
  wc.title = 'B'
  const answer = { tag: 'button', selector: 'main > button:nth-of-type(2)', role: null, text: 'Buy now', rect: { x: 10, y: 20, width: 80, height: 30 } }
  const send = wc.debugger.sendCommand
  wc.debugger.sendCommand = async (method, params = {}) => {
    if (method === 'DOM.resolveNode') { wc.debugger.sent.push([method, params]); return { object: { objectId: 'o1' } } }
    if (method === 'Runtime.callFunctionOn') { wc.debugger.sent.push([method, params]); return { result: { value: answer } } }
    return send(method, params)
  }
  const sent = (m) => wc.debugger.sent.filter(([x]) => x === m).map(([, p]) => p)
  const one = electronSide.pickElement(wc)
  await settle(); await settle()
  assert.equal(sent('Overlay.setInspectMode')[0].mode, 'searchForNode')
  wc.debugger.emit('message', {}, 'Overlay.inspectNodeRequested', { backendNodeId: 42 })
  const got = await one.promise
  assert.deepEqual(got, { ...answer, url: 'https://example.org/b', title: 'B' })
  assert.equal(sent('DOM.resolveNode')[0].backendNodeId, 42)
  assert.match(sent('Runtime.callFunctionOn')[0].functionDeclaration, /nth-of-type/)
  assert.doesNotMatch(sent('Runtime.callFunctionOn')[0].functionDeclaration, /\.value\b/)    // a field's value is never read
  assert.equal(sent('Overlay.setInspectMode').at(-1).mode, 'none')
  const two = electronSide.pickElement(wc)
  await settle()
  wc.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main' } })
  assert.equal(await two.promise, null)
  const three = electronSide.pickElement(wc)
  three.cancel()
  assert.equal(await three.promise, null)
  assert.equal(sent('Overlay.setInspectMode').at(-1).mode, 'none')
})

test('the Browser card and the thread asking for the same live picture of the same page share one capture (one under way, kept 100 ms); another tab or generation never gets it', async () => {
  assert.equal(typeof bridgeSide.sharedFrames, 'function', 'live pictures are shared')
  let t = 0
  let taken = 0
  let identity = 'tab-1#1|4'
  const frames = bridgeSide.sharedFrames({ now: () => t })
  const take = async () => { taken += 1; await settle(); return { n: taken } }
  const ask = (key = 'browser') => frames(key, identity, take, () => identity)
  const [a, b] = await Promise.all([ask(), ask()])
  assert.equal(taken, 1)
  assert.equal(a, b)
  t += 50
  assert.equal(await ask(), a)                                                       // within 100 ms: the same one
  assert.equal(taken, 1)
  await ask('chatgpt')                                                               // another surface: its own
  assert.equal(taken, 2)
  // the person showed another tab: a new capture, not the kept one
  identity = 'tab-2#2|5'
  const c = await ask()
  assert.equal(taken, 3)
  assert.notEqual(c, a)
  // a capture under way when the tab changes: its answer is no one's (dropped, not kept), and an ask of the new tab
  // made meanwhile does not wait for it
  let release = null
  const slow = frames('browser', 'tab-2#2|9', () => new Promise((r) => { release = () => r({ late: true }) }), () => identity)
  identity = 'tab-1#3|9'
  const fresh = await ask()
  assert.equal(taken, 4)
  assert.deepEqual(fresh, { n: 4 })
  release()
  assert.equal(await slow, null)
  t += 200
  const d = await ask()
  assert.equal(taken, 5)
  assert.notEqual(d, fresh)
  // a capture that failed is not kept
  await assert.rejects(frames('x', 'i', async () => { throw new Error('gone') }))
  assert.deepEqual(await frames('x', 'i', async () => ({ again: true })), { again: true })
})

test("the agent's complete desktop picture and click coordinates are independent of card size", async () => {
  const { browser } = setup()
  const nativeImage = { createFromBuffer: () => ({ resize: (to) => ({ toJPEG: () => jpegOf(to.width, to.height) }) }) }
  const surface = electronSurface({ label: "the agent's browser", contents: browser.contents, opened: browser.opened, allowsUrl: browser.allows, nativeImage, deviceScale: 2, pageId: browser.shownPage })
  const computer = createComputer({ surfaces: { browser: surface }, instance: 'i1', settle: async () => {} })
  for (const card of [{ width: 480, height: 600 }, { width: 800, height: 520 }, { width: 1601, height: 901 }]) {
    browser.place({ x: 20, y: 40, ...card, visible: true })
    const look = await computer.observe({ surface: 'browser', owner: 'run_1' })
    assert.deepEqual(look.viewport, { width: 1280, height: 800 })
    assert.deepEqual([look.image.width, look.image.height], [1280, 800])
    browser.place({ x: 20, y: 40, width: card.width - 40, height: card.height, visible: true })
    const wc = browser.contents()
    wc.debugger.sent.length = 0
    const ok = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 640, y: 400, snapshot_id: look.snapshot_id })
    assert.equal(ok.status, 'ok')
    const press = wc.debugger.sent.find(([m, p]) => m === 'Input.dispatchMouseEvent' && p.type === 'mousePressed')[1]
    assert.deepEqual([press.x, press.y], [640, 400])
  }
})

test("a live picture is of the tab shown now: a capture of tab A that comes after the person showed tab B is dropped, never shown as B's; the next one is B's", async () => {
  const { browser, views } = setup()
  assert.equal(typeof browser.newTab, 'function', 'the browser has tabs')
  browser.place({ x: 0, y: 40, width: 800, height: 600, visible: true })
  const nativeImage = { createFromBuffer: () => ({ resize: (to) => ({ toJPEG: () => jpegOf(to.width, to.height) }) }) }
  const surface = electronSurface({ label: "the agent's browser", contents: browser.contents, opened: browser.opened, allowsUrl: browser.allows, nativeImage, deviceScale: 2, pageId: browser.shownPage })
  browser.navigate('go', 'https://a.example/')
  // tab A's capture is held until the test lets it go
  const a = views[0].webContents
  let release = null
  const send = a.debugger.sendCommand
  a.debugger.sendCommand = async (method, params) => {
    if (method === 'Page.captureScreenshot') await new Promise((r) => { release = r })
    return send(method, params)
  }
  const first = surface.frame()
  while (!release) await settle()
  // the person shows a new tab (B) while A's picture is being taken
  browser.newTab('https://b.example/')
  release()
  assert.equal(await first, null)
  // asked again: B's picture, of B's address
  const second = await surface.frame()
  assert.ok(second && second.image)
  assert.equal(second.url, 'https://b.example/')
  // nor do the dialog and file chooser of A stand for B's
  surface.open()
  a.debugger.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'leave A?' })
  assert.equal(surface.peek().dialog, null)
  assert.equal(surface.events('run_1').dialog, null)
})

test('a profile has one download listener however many tabs open and close in it', () => {
  const { View } = fakeViews()
  let listeners = 0
  const pages = [new View().webContents, new View().webContents, new View().webContents]
  const session = { on: (name) => { if (name === 'will-download') listeners += 1 } }
  for (const wc of pages) wc.session = session
  let shown = 0
  const surface = electronSurface({ label: 'p', contents: () => pages[shown], opened: () => true, allowsUrl: () => true, downloadsDir: '/nonexistent-never-written', pageId: () => shown })
  for (shown = 0; shown < pages.length; shown += 1) surface.open()
  shown = 0
  surface.open()
  assert.equal(listeners, 1)
})

/** The agent's browser with a surface and a computer over it, as the bridge wires them (fakes for Electron). */
function wired({ width = 800, height = 600 } = {}) {
  const env = setup()
  env.browser.place({ x: 0, y: 40, width, height, visible: true })
  env.browser.contents()
  const nativeImage = { createFromBuffer: () => ({ resize: (to) => ({ toJPEG: () => jpegOf(to.width, to.height) }) }) }
  env.surface = electronSurface({ label: "the agent's browser", contents: env.browser.contents, opened: env.browser.opened, allowsUrl: env.browser.allows, reset: env.browser.reset, visibility: env.browser.visibility, nativeImage, deviceScale: 2, pageId: env.browser.shownPage })
  env.computer = createComputer({ surfaces: { browser: env.surface }, instance: 'i1', settle: async () => {} })
  env.pressed = () => env.views.flatMap((v) => v.webContents.debugger.sent.filter(([m, p]) => m === 'Input.dispatchMouseEvent' && p.type === 'mousePressed'))
  /** Holds the next screenshot of a page until the returned function is called. */
  env.holdShot = (wc) => {
    const gate = {}
    const send = wc.debugger.sendCommand
    wc.debugger.sendCommand = async (method, params) => {
      if (method === 'Page.captureScreenshot' && !gate.used) { gate.used = true; await new Promise((r) => { gate.release = r }) }
      return send(method, params)
    }
    return gate
  }
  return env
}

test('a look of tab A, then tab B shown, then A again (same address, same size): the look of A is stale — each showing is its own', async () => {
  const { browser, computer, pressed } = wired()
  assert.equal(typeof browser.shownPage, 'function', 'the browser names each showing of a tab')
  browser.navigate('go', 'https://shop.example/cart')
  const first = browser.activeTab()
  const lookA = await computer.observe({ surface: 'browser', owner: 'run_1' })
  browser.newTab('https://shop.example/cart')
  browser.switchTab(first)
  const out = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 100, y: 100, snapshot_id: lookA.snapshot_id })
  assert.equal(out.status, 'stale')
  assert.match(out.reason, /another tab/)
  assert.deepEqual(pressed(), [])
})

test('a look whose picture is being taken when the person shows another tab is of one page only: taken again of the tab shown, its picture, address and page together', async () => {
  const { browser, views, computer, pressed } = wired()
  assert.equal(typeof browser.newTab, 'function', 'the browser has tabs')
  browser.navigate('go', 'https://a.example/')
  const gate = wired.hold = null
  const held = (() => { const g = {}; const wc = views[0].webContents; const send = wc.debugger.sendCommand; wc.debugger.sendCommand = async (m, p) => { if (m === 'Page.captureScreenshot' && !g.used) { g.used = true; await new Promise((r) => { g.release = r }) } return send(m, p) }; return g })()
  void gate
  const looking = computer.observe({ surface: 'browser', owner: 'run_1' })
  while (!held.release) await settle()
  browser.newTab('https://b.example/')
  held.release()
  const look = await looking
  assert.equal(look.status, 'ok')
  assert.equal(look.url, 'https://b.example/')
  // the reads of that look went to B (its picture asked of B's page), and an action on it acts on B
  assert.ok(views[1].webContents.debugger.sent.some(([m]) => m === 'Page.captureScreenshot'))
  const ok = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 10, y: 10, snapshot_id: look.snapshot_id })
  assert.equal(ok.status, 'ok')
  assert.equal(views[0].webContents.debugger.sent.filter(([m, p]) => m === 'Input.dispatchMouseEvent' && p.type === 'mousePressed').length, 0)
  assert.equal(pressed().length, 1)
})

test('an unexpected viewport change during capture is taken again; a viewport still changing is not acted on', async () => {
  const { browser, views, computer, pressed } = wired({ width: 800, height: 600 })
  const wc = views[0].webContents
  const send = wc.debugger.sendCommand
  let shots = 0
  let keepMoving = false
  wc.debugger.sendCommand = async (method, params) => {
    if (method === 'Page.captureScreenshot') { shots += 1; if (shots === 1 || keepMoving) views[0].setBounds({ x: 0, y: 0, width: 800 + shots * 40, height: 600 }) }
    return send(method, params)
  }
  const look = await computer.observe({ surface: 'browser', owner: 'run_1' })
  assert.equal(shots, 2)                                                           // taken again
  assert.deepEqual(look.viewport, { width: 840, height: 600 })
  assert.deepEqual([look.image.width, look.image.height], [840, 600])
  // a card that keeps moving through both tries: the look is kept, but an action on it is stale
  keepMoving = true
  const moving = await computer.observe({ surface: 'browser', owner: 'run_1' })
  const out = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 10, y: 10, snapshot_id: moving.snapshot_id })
  assert.equal(out.status, 'stale')
  assert.deepEqual(pressed(), [])
})

test('the live picture follows the page the person shows even before any agent looked (a frame never opens a page)', async () => {
  const env = setup()
  const nativeImage = { createFromBuffer: () => ({ resize: (to) => ({ toJPEG: () => jpegOf(to.width, to.height) }) }) }
  const surface = electronSurface({ label: "the agent's browser", contents: env.browser.contents, opened: env.browser.opened, allowsUrl: env.browser.allows, nativeImage, deviceScale: 2, pageId: env.browser.shownPage })
  // nothing opened yet: no picture, and no page made for it
  assert.equal(await surface.frame(), null)
  assert.equal(env.views.length, 0)
  // the person uses the card: the page is placed and browsed, no agent looked
  assert.equal(typeof env.browser.navigate, 'function', 'the browser has an address bar')
  env.browser.place({ x: 0, y: 40, width: 640, height: 480, visible: true })
  env.browser.navigate('go', 'https://a.example/')
  const one = await surface.frame()
  assert.equal(one.url, 'https://a.example/')
  assert.deepEqual(one.viewport, { width: 1280, height: 800 })
  env.browser.newTab('https://b.example/')
  assert.equal((await surface.frame()).url, 'https://b.example/')
})

test("while the person picks an element, an agent's action waits (busy) and is never taken for the pick", async () => {
  const env = wired()
  assert.equal(typeof bridgeSide.browserControls, 'function', 'the bridge has the card controls')
  let controls = null
  const surface = electronSurface({ label: "the agent's browser", contents: env.browser.contents, opened: env.browser.opened, allowsUrl: env.browser.allows, pageId: env.browser.shownPage, busy: () => (controls && controls.picking() ? 'the person is picking an element' : null) })
  const computer = createComputer({ surfaces: { browser: surface }, instance: 'i2', settle: async () => {}, personQuietMs: 0 })
  let pending = null
  controls = bridgeSide.browserControls({ browser: env.browser, surface, pick: () => { const p = {}; p.promise = new Promise((r) => { pending = r }); p.cancel = () => pending(null); return p } })
  assert.equal(typeof controls.picking, 'function', 'the controls say when a pick is under way')
  const look = await computer.observe({ surface: 'browser', owner: 'run_1' })
  const picking = controls.pick()
  assert.equal(controls.picking(), true)
  const out = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 10, y: 10, snapshot_id: look.snapshot_id })
  assert.equal(out.status, 'busy')
  assert.deepEqual(env.pressed(), [])
  pending({ tag: 'a', selector: 'a', role: null, text: 'x', url: 'https://x.example/' })
  await picking
  assert.equal(controls.picking(), false)
})

test("a picked element is described without anything typed: a field, an editable region, a text box or whatever holds one is named by its label only; the address loses its query and fragment", async () => {
  // the picker's own function, run on stand-in elements (no DOM here): what it reads of each
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'computer_electron.js'), 'utf8')
  assert.ok(src.includes('const PICK_FN = `'), 'the browser describes a picked element')
  const fn = src.slice(src.indexOf('const PICK_FN = `') + 'const PICK_FN = `'.length, src.indexOf('}`', src.indexOf('const PICK_FN = `')) + 1).replace(/\\\\/g, '\\')
  const pick = (el) => Function(`return (${fn})`)().call(el)
  const doc = { querySelectorAll: () => [1], defaultView: null }
  const el = (o) => ({ nodeType: 1, ownerDocument: doc, id: '', parentElement: null, tagName: 'DIV', isContentEditable: false, attrs: {}, getAttribute(n) { return this.attrs[n] ?? null }, matches: () => false, querySelector: () => null, innerText: '', getBoundingClientRect: () => ({ x: 1, y: 2, width: 3, height: 4 }), ...o })
  assert.equal(pick(el({ tagName: 'BUTTON', innerText: 'Buy now' })).text, 'Buy now')
  assert.equal(pick(el({ isContentEditable: true, innerText: 'my secret draft' })).text, '')
  assert.equal(pick(el({ matches: () => true, innerText: 'typed in a role=textbox', attrs: { 'aria-label': 'Search' } })).text, 'Search')
  assert.equal(pick(el({ querySelector: () => ({}), innerText: 'a form holding what was typed' })).text, '')
  assert.equal(pick(el({ tagName: 'INPUT', matches: () => true, attrs: { placeholder: 'Email' }, value: 'me@example.com' })).text, 'Email')
  const { View } = fakeViews()
  const wc = new View().webContents
  wc.url = 'https://shop.example/cart?token=abc#pay'
  const send = wc.debugger.sendCommand
  wc.debugger.sendCommand = async (m, p = {}) => (m === 'DOM.resolveNode' ? { object: { objectId: 'o' } } : m === 'Runtime.callFunctionOn' ? { result: { value: { tag: 'a', selector: 'a', role: null, text: '' } } } : send(m, p))
  const one = electronSide.pickElement(wc)
  await settle(); await settle()
  wc.debugger.emit('message', {}, 'Overlay.inspectNodeRequested', { backendNodeId: 7 })
  assert.equal((await one.promise).url, 'https://shop.example/cart')
})

test('tabs opened and closed fifteen times over one profile leave one download listener', () => {
  const env = setup()
  assert.equal(typeof env.browser.newTab, 'function', 'the browser has tabs')
  let listeners = 0
  const session = env.views.length ? env.views[0].webContents.session : null
  void session
  const surface = electronSurface({ label: 'p', contents: env.browser.contents, opened: env.browser.opened, allowsUrl: () => true, downloadsDir: '/nonexistent-never-written', pageId: env.browser.shownPage })
  env.browser.contents()
  env.views[0].webContents.session.on = (name) => { if (name === 'will-download') listeners += 1 }
  surface.open()
  for (let i = 0; i < 15; i += 1) {
    const id = env.browser.newTab('https://example.org/' + i)
    surface.open()
    env.browser.closeTab(id)
    surface.open()
  }
  assert.equal(listeners, 1)
  assert.equal(env.browser.status().tabs.length, 1)
})

test('a first tab asked for by address is the only tab; an oversized card does not grow the backstage window', () => {
  const { View, views } = fakeViews()
  const main = fakeWindow('main')
  const stageWin = fakeWindow('stage')
  stageWin.size = [1920, 1200]
  stageWin.getContentSize = () => [...stageWin.size]
  stageWin.setContentSize = (w, h) => { stageWin.size = [w, h] }
  const browser = agentBrowser({ WebContentsView: View, host: () => main, stage: { window: () => stageWin } })
  assert.equal(typeof browser.newTab, 'function', 'the browser has tabs')
  browser.newTab('https://example.org/')
  assert.equal(views.length, 1)
  assert.equal(browser.status().tabs.length, 1)
  browser.place({ x: 0, y: 0, width: 2400, height: 1350, visible: true })
  browser.place({ x: 0, y: 0, width: 2400, height: 1350, visible: false })
  assert.deepEqual([views[0].bounds.width, views[0].bounds.height], [1280, 800])
  assert.deepEqual(stageWin.size, [1920, 1200])
})

test('at two device pixels per CSS pixel, a laid-out page (DOMSnapshot boxes in device pixels) is checked and clicked in CSS pixels on a 480-wide card', async () => {
  // the shape Electron 38 gave under the 2x override (docs/engineering-browser.md): layoutViewport in device pixels,
  // cssLayoutViewport in CSS pixels, DOMSnapshot bounds in device pixels — a stand-in, not a measurement of this change
  const env = wired({ width: 480, height: 600 })
  const wc = env.views[0].webContents
  wc.title = 'Shop'
  const send = wc.debugger.sendCommand
  const button = { node: 2, device: [200, 400, 160, 80] }                         // CSS: x 100, y 200, 80 × 40
  wc.debugger.sendCommand = async (method, params = {}) => {
    if (method === 'DOMSnapshot.captureSnapshot') { wc.debugger.sent.push([method, params]); return { documents: [{ nodes: { backendNodeId: [1, button.node] }, layout: { nodeIndex: [0, 1], bounds: [[0, 0, 960, 1200], button.device] }, scrollOffsetX: 0, scrollOffsetY: 0 }] } }
    if (method === 'DOM.getNodeForLocation') { wc.debugger.sent.push([method, params]); const [x, y, w, h] = button.device.map((v) => v / 2); return { backendNodeId: params.x >= x && params.x <= x + w && params.y >= y && params.y <= y + h ? button.node : 1 } }
    if (method === 'DOM.resolveNode') return { object: { objectId: `n${params.backendNodeId}` } }
    if (method === 'Runtime.callFunctionOn') {
      const f = params.functionDeclaration
      if (/other_site/.test(f)) return { result: { value: { disabled: false, readonly: false, desc: 'button "Buy"', other_site: false } } }
      if (/\[role=button\]/.test(f)) return { result: { objectId: 'ctl' } }
      return { result: { value: null } }
    }
    if (method === 'DOM.describeNode') return { node: { backendNodeId: button.node } }
    if (method === 'Accessibility.getPartialAXTree') return { nodes: [{ nodeId: '2', role: { value: 'button' }, name: { value: 'Buy' }, backendDOMNodeId: 2, childIds: [] }] }
    return send(method, params)
  }
  const look = await env.computer.observe({ surface: 'browser', owner: 'run_1' })
  assert.deepEqual(look.viewport, { width: 1280, height: 800 })
  assert.deepEqual([look.image.width, look.image.height], [1280, 800])
  // the button's middle in the picture (CSS 140, 220): checked against the look's boxes (in CSS pixels), then pressed there
  const ok = await env.computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 140, y: 220, snapshot_id: look.snapshot_id })
  assert.equal(ok.status, 'ok')
  const press = env.pressed()[0][1]
  assert.deepEqual([press.x, press.y], [140, 220])
  assert.deepEqual(wc.debugger.sent.filter(([m]) => m === 'DOM.getNodeForLocation').map(([, p]) => [p.x, p.y])[0], [140, 220])
  // a point the look had no control at, where the page now has the button (it moved there), is stale
  const again = await env.computer.observe({ surface: 'browser', owner: 'run_1' })
  button.device = [0, 0, 160, 80]
  const moved = await env.computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 40, y: 20, snapshot_id: again.snapshot_id })
  assert.equal(moved.status, 'stale')
})

test('the person beginning a pick while an agent\'s click waits to press: the press is not sent (busy), never taken for the pick', async () => {
  const env = wired()
  assert.equal(typeof bridgeSide.browserControls, 'function', 'the bridge has the card controls')
  let controls = null
  const surface = electronSurface({ label: "the agent's browser", contents: env.browser.contents, opened: env.browser.opened, allowsUrl: env.browser.allows, pageId: env.browser.shownPage, busy: () => (controls && controls.picking() ? 'the person is picking an element' : null) })
  const computer = createComputer({ surfaces: { browser: surface }, instance: 'i3', settle: async () => {}, personQuietMs: 0 })
  controls = bridgeSide.browserControls({ browser: env.browser, surface: { personUsed: () => {} }, pick: () => ({ promise: new Promise(() => {}), cancel: () => {} }) })
  const look = await computer.observe({ surface: 'browser', owner: 'run_1' })
  // the pick begins as the agent's pointer reaches its point (before the press)
  const wc = env.browser.contents()
  const send = wc.debugger.sendCommand
  wc.debugger.sendCommand = async (method, params = {}) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && !controls.picking()) void controls.pick()
    return send(method, params)
  }
  const out = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 10, y: 10, snapshot_id: look.snapshot_id })
  assert.equal(out.status, 'busy')
  assert.deepEqual(env.pressed(), [])
})

test("the live picture and the status name the showing of the tab they are of (A, B, then A again are three)", async () => {
  const { browser, surface } = wired()
  assert.equal(typeof browser.shownPage, 'function', 'the browser names each showing of a tab')
  browser.navigate('go', 'https://a.example/')
  const a1 = browser.status().shown_page
  const f1 = await surface.frame()
  assert.equal(f1.page, a1)
  const first = browser.activeTab()
  browser.newTab('https://b.example/')
  const b = browser.status().shown_page
  assert.notEqual(b, a1)
  assert.equal((await surface.frame()).page, b)
  browser.switchTab(first)
  const a2 = browser.status().shown_page
  assert.notEqual(a2, a1)
  assert.equal((await surface.frame()).page, a2)
})
