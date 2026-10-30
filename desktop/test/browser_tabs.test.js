// Agent-owned browser tabs (2026-10-20): every run looks at and acts on its own tabs, in parallel with other runs, in
// the one shared profile; the Browser card shows whichever tab the person picks. These tests drive the production
// composition (startBridge: agentBrowser + browserTabs + one electronSurface per tab + createComputer + the card's
// controls) over fake Electron objects — no Electron, no network, a temporary data directory.
const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { startBridge } = require('../bridge')

const jpegOf = (width, height) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const within = (promise, ms, what) => Promise.race([promise, sleep(ms).then(() => { throw new Error(`${what}: still waiting after ${ms} ms (serialized?)`) })])

/** n parties: each `enter()` resolves only once all n entered. */
function barrier(n) {
  let count = 0
  let release
  const all = new Promise((r) => { release = r })
  return { enter() { count += 1; if (count >= n) release(); return all }, count: () => count }
}

function fakeElectron() {
  const views = []
  const windows = []
  const gates = { fn: null }                      // (wc, method, params) => promise to wait for, or null
  const session = new EventEmitter()
  session.webRequest = { onBeforeRequest: () => {} }
  session.cookies = { get: async () => [], on: () => {}, remove: async () => {} }
  session.order = []
  const live = () => views.filter((v) => !v.webContents.destroyed).length
  session.clearStorageData = async () => { session.order.push(['storage', live()]); if (session.hold) await session.hold }
  session.clearCache = async () => { session.order.push(['cache', live()]) }
  session.clearAuthCache = async () => { session.order.push(['auth', live()]) }
  class BrowserWindow {
    constructor(options) {
      this.options = options; this.children = new Set(); this.destroyed = false
      this.contentView = { addChildView: (v) => this.children.add(v), removeChildView: (v) => this.children.delete(v) }
      windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true }
    getContentSize() { return [this.options.width, this.options.height] }
    setContentSize() {}
  }
  class View {
    constructor() {
      this.bounds = null; this.visible = null
      const wc = new EventEmitter()
      wc.view = this; wc.destroyed = false; wc.url = 'about:blank'; wc.title = ''; wc.back = []; wc.ahead = []; wc.loaded = []
      wc.isDestroyed = () => wc.destroyed
      wc.getZoomFactor = () => 1
      wc.setZoomFactor = () => {}
      wc.setWindowOpenHandler = (fn) => { wc.openHandler = fn }
      // a main-frame navigation: started and committed a moment later (the page's own events)
      wc.loading = false
      wc.navigateTo = (url) => { wc.loading = true; setImmediate(() => { wc.emit('did-start-navigation', {}, url, false, true); wc.url = url; wc.emit('did-navigate', {}, url); wc.loading = false }) }
      wc.loadURL = async (url) => { wc.loaded.push(url); wc.navigateTo(url) }
      wc.getURL = () => wc.url
      wc.getTitle = () => wc.title
      wc.isLoading = () => wc.loading
      wc.reload = () => {}
      wc.stop = () => {}
      wc.close = () => { wc.destroyed = true }
      wc.session = session
      wc.mainFrame = { framesInSubtree: [], processId: 1 }
      wc.navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {}, clear: () => {} }
      const dbg = new EventEmitter()
      dbg.sent = []
      dbg.attach = () => {}
      dbg.detach = () => {}
      dbg.sendCommand = async (method, params = {}) => {
        dbg.sent.push([method, params])
        const wait = gates.fn ? gates.fn(wc, method, params) : null
        if (wait) await wait
        const css = { clientWidth: 1280, clientHeight: 800, pageX: 0, pageY: 0 }
        if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: css, layoutViewport: { ...css, clientWidth: 2560, clientHeight: 1600 }, cssContentSize: { width: 1280, height: 800 } }
        if (method === 'Page.captureScreenshot') return { data: jpegOf(2560, 1600).toString('base64') }
        if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: wc.title }, backendDOMNodeId: 1, childIds: [] }] }
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' }, childFrames: [] } }
        if (method === 'DOMSnapshot.captureSnapshot') return { documents: [] }
        if (method === 'DOM.getNodeForLocation') throw new Error('No node found at given location')
        if (method === 'Page.navigate') { wc.navigateTo(params.url); return {} }
        return {}
      }
      wc.debugger = dbg
      this.webContents = wc
      views.push(this)
    }
    setBackgroundColor() {}
    setBounds(b) { this.bounds = { ...b } }
    setVisible(v) { this.visible = v }
  }
  const host = new BrowserWindow({ width: 1600, height: 1000 })
  return { View, BrowserWindow, views, windows, session, gates, host }
}

async function setup() {
  const fake = fakeElectron()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-browser-tabs-'))
  const lines = []
  const bridge = await startBridge({ WebContentsView: fake.View, BrowserWindow: fake.BrowserWindow, host: () => fake.host, shell: { openExternal: async () => {} }, port: 0, dataDir: dir, log: (l) => lines.push(l) })
  const { computer, browser } = bridge
  const wcOf = (tab) => browser.contentsOf(tab)
  const presses = (tab) => wcOf(tab).debugger.sent.filter(([m, p]) => m === 'Input.dispatchMouseEvent' && p.type === 'mousePressed')
  const done = async () => { await bridge.close(); fs.rmSync(dir, { recursive: true, force: true }) }
  return { ...fake, dir, bridge, computer, browser, wcOf, presses, lines, done }
}
const A = { surface: 'browser', owner: 'run_A', session: 's_1', owner_label: 'Claude Opus 5.5' }
const B = { surface: 'browser', owner: 'run_B', session: 's_1', owner_label: 'GPT-6' }
// what a refusal must never carry of a page (another run's, or one that is gone)
const PAGE_FIELDS = ['image', 'display_image', 'outline', 'url', 'title', 'tabs', 'snapshot_id', 'downloads', 'console']
const noPage = (out) => { for (const k of PAGE_FIELDS) assert.equal(out[k], undefined, `a refusal carries no ${k}`) }

test('each run lazily gets its own blank tab (two runs of one session too); two first looks of one run at once open one tab; the card status names owners', async (t) => {
  const env = await setup()
  t.after(env.done)
  const [a1, a2] = await Promise.all([env.computer.observe(A), env.computer.observe(A)])
  assert.equal(a1.status, 'ok'); assert.equal(a2.status, 'ok')
  assert.equal(a1.tab_id, a2.tab_id, 'one tab for the run, however many first looks race')
  const b = await env.computer.observe(B)
  assert.equal(b.status, 'ok')
  assert.notEqual(b.tab_id, a1.tab_id, 'the same session\'s other run gets its own tab')
  assert.deepEqual(b.tabs.map((x) => x.tab_id), [b.tab_id], 'a look lists only the run\'s own tabs')
  const status = env.bridge.browserStatus()
  const line = (id) => status.tabs.find((x) => x.id === id)
  assert.deepEqual([line(a1.tab_id).owner, line(a1.tab_id).session, line(a1.tab_id).owner_label], ['run_A', 's_1', 'Claude Opus 5.5'])
  assert.equal(line(b.tab_id).owner, 'run_B')
  assert.equal(line(b.tab_id).holder, 'run_B')
  assert.equal(status.can_clear_data, false)
  assert.equal(typeof status.holder === 'string' || status.holder === null, true)
  // every tab in a hidden window of its own, at the fixed desktop viewport; none shown or focusable
  for (const id of [a1.tab_id, b.tab_id]) {
    const v = env.wcOf(id).view
    const homes = env.windows.filter((w) => w.children.has(v))
    assert.equal(homes.length, 1)
    assert.deepEqual(homes[0].options, { ...homes[0].options, show: false, focusable: false })
    assert.deepEqual([v.bounds.width, v.bounds.height], [1280, 800])
  }
  assert.notEqual(env.windows.find((w) => w.children.has(env.wcOf(a1.tab_id).view)), env.windows.find((w) => w.children.has(env.wcOf(b.tab_id).view)))
})

test('a run never reaches another run\'s tab: list, look, act, select and close by tab_id are refused alike for a foreign and a missing id, with nothing of the page', async (t) => {
  const env = await setup()
  t.after(env.done)
  const a = await env.computer.observe(A)
  const b = await env.computer.observe(B)
  const foreign = await env.computer.observe({ ...B, tab_id: a.tab_id })
  const missing = await env.computer.observe({ ...B, tab_id: 'tab-999' })
  assert.equal(foreign.status, 'refused'); noPage(foreign)
  assert.equal(missing.status, 'refused'); noPage(missing)
  assert.equal(foreign.reason.replace(a.tab_id, 'X'), missing.reason.replace('tab-999', 'X'), 'a foreign id reads as a missing one')
  for (const action of ['tab_select', 'tab_close', 'navigate', 'read_text']) {
    const out = await env.computer.act({ ...B, action, tab_id: a.tab_id, url: 'https://example.org/' })
    assert.equal(out.status, 'refused', action); noPage(out)
  }
  // the ChatGPT page has no tabs
  const chat = await env.computer.observe({ surface: 'chatgpt', owner: 'run_B', tab_id: b.tab_id })
  assert.equal(chat.status, 'refused'); noPage(chat)
  // A's look named by B: stale, no look of A's page, nothing pressed anywhere
  const stolen = await env.computer.act({ ...B, action: 'click', x: 10, y: 10, snapshot_id: a.snapshot_id })
  assert.equal(stolen.status, 'stale')
  assert.notEqual(stolen.tab_id, a.tab_id)
  assert.deepEqual([env.presses(a.tab_id), env.presses(b.tab_id)], [[], []])
  assert.equal(env.browser.exists(a.tab_id), true, 'A\'s tab is still open')
})

test('two runs in parallel: both looks capture at once and both clicks press at once (barriers), never busy; one tab stays one-at-a-time', async (t) => {
  const env = await setup()
  t.after(env.done)
  const a = await env.computer.observe(A)
  const b = await env.computer.observe(B)
  // looks: each capture waits until the other run's capture began too
  const looks = barrier(2)
  env.gates.fn = (wc, method, params) => (method === 'Page.captureScreenshot' && params.quality !== 1 ? looks.enter() : null)
  const [la, lb] = await within(Promise.all([env.computer.observe(A), env.computer.observe(B)]), 3000, 'parallel looks')
  assert.deepEqual([la.status, lb.status, la.tab_id, lb.tab_id], ['ok', 'ok', a.tab_id, b.tab_id])
  // clicks: each press waits until the other run's press began too
  const presses = barrier(2)
  env.gates.fn = (wc, method, params) => (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' ? presses.enter() : null)
  const [ca, cb] = await within(Promise.all([
    env.computer.act({ ...A, action: 'click', x: 100, y: 100, snapshot_id: la.snapshot_id }),
    env.computer.act({ ...B, action: 'click', x: 300, y: 300, snapshot_id: lb.snapshot_id }),
  ]), 5000, 'parallel clicks')
  env.gates.fn = null
  assert.deepEqual([ca.status, cb.status], ['ok', 'ok'])
  assert.deepEqual(env.presses(a.tab_id).map(([, p]) => [p.x, p.y]), [[50, 50]])
  assert.deepEqual(env.presses(b.tab_id).map(([, p]) => [p.x, p.y]), [[150, 150]])
  // the same tab: a second look does not begin its capture while the first is held
  let release
  const held = new Promise((r) => { release = r })
  let entered = 0
  const wcA = env.wcOf(a.tab_id)
  env.gates.fn = (wc, method, params) => (wc === wcA && method === 'Page.captureScreenshot' && params.quality !== 1 ? (entered += 1, entered === 1 ? held : null) : null)
  const first = env.computer.observe(A)
  const second = env.computer.observe(A)
  await sleep(150)
  assert.equal(entered, 1, 'the second look of the same tab waits for the first')
  // meanwhile B is not held up by A's queue
  assert.equal((await within(env.computer.observe(B), 2000, 'B during A\'s held look')).status, 'ok')
  release()
  assert.deepEqual([(await first).status, (await second).status], ['ok', 'ok'])
  env.gates.fn = null
})

test('A\'s navigation, actions and the person\'s input on A\'s tab never make B\'s look stale; they do make A\'s', async (t) => {
  const env = await setup()
  t.after(env.done)
  const a = await env.computer.observe(A)
  const b = await env.computer.observe(B)
  assert.equal((await env.computer.act({ ...A, action: 'navigate', url: 'https://a.example/' })).status, 'ok')
  const a2 = await env.computer.observe(A)
  // the person's input on A's tab (their own page events)
  env.wcOf(a.tab_id).emit('input-event', {}, { type: 'mouseDown' })
  const staleA = await env.computer.act({ ...A, action: 'click', x: 10, y: 10, snapshot_id: a2.snapshot_id })
  assert.ok(['stale', 'person_active'].includes(staleA.status))
  assert.deepEqual(env.presses(a.tab_id), [])
  const okB = await env.computer.act({ ...B, action: 'click', x: 10, y: 10, snapshot_id: b.snapshot_id })
  assert.equal(okB.status, 'ok', 'B\'s look is untouched by everything on A\'s tab')
  assert.equal(env.presses(b.tab_id).length, 1)
})

test('a look pins its tab: a different tab_id is stale with nothing pressed; with the run on another tab the look still goes to its own; the card switching tabs stales nothing', async (t) => {
  const env = await setup()
  t.after(env.done)
  const a1 = await env.computer.observe(A)
  const opened = await env.computer.act({ ...A, action: 'tab_new' })
  assert.equal(opened.status, 'ok')
  const a2 = opened.tab_id
  assert.notEqual(a2, a1.tab_id)
  assert.deepEqual(opened.tabs.map((x) => x.tab_id).sort(), [a1.tab_id, a2].sort())
  const mismatch = await env.computer.act({ ...A, action: 'click', x: 10, y: 10, snapshot_id: a1.snapshot_id, tab_id: a2 })
  assert.equal(mismatch.status, 'stale'); noPage(mismatch)
  assert.deepEqual([env.presses(a1.tab_id), env.presses(a2)], [[], []])
  // the person shows B's tab, then A2, then A1 on the card: no agent look changes
  const b = await env.computer.observe(B)
  for (const id of [b.tab_id, a2, a1.tab_id, b.tab_id]) assert.equal(env.bridge.browserTab({ action: 'switch', id }).ok, true)
  const ok = await env.computer.act({ ...A, action: 'click', x: 10, y: 10, snapshot_id: a1.snapshot_id })
  assert.equal(ok.status, 'ok')
  assert.equal(ok.tab_id, a1.tab_id, 'the look\'s own tab, though the run\'s current tab was A2')
  assert.deepEqual([env.presses(a1.tab_id).length, env.presses(a2).length], [1, 0])
  assert.equal((await env.computer.act({ ...B, action: 'click', x: 10, y: 10, snapshot_id: b.snapshot_id })).status, 'ok')
})

test('after the run ended (released), an approval of its look acts on the original tab — also after another run worked on its own; a look of a closed tab is stale and opens nothing', async (t) => {
  const env = await setup()
  t.after(env.done)
  const a = await env.computer.observe(A)
  assert.equal(env.computer.releaseOwner({ owner: 'run_A' }).status, 'ok')
  // (another session's run: one of A's session would take A's tab over)
  const B2 = { ...B, session: 's_2' }
  const b = await env.computer.observe(B2)
  assert.notEqual(b.tab_id, a.tab_id)
  assert.equal((await env.computer.act({ ...B2, action: 'click', x: 10, y: 10, snapshot_id: b.snapshot_id })).status, 'ok')
  const approved = await env.computer.act({ ...A, approval: true, action: 'click', x: 20, y: 20, snapshot_id: a.snapshot_id, tab_id: a.tab_id })
  assert.equal(approved.status, 'ok')
  assert.equal(approved.tab_id, a.tab_id)
  assert.equal(env.presses(a.tab_id).length, 1)
  env.computer.releaseOwner({ owner: 'run_A' })
  // its tab closed (the person closed it): the next approval is stale, and no tab is opened for it
  const look = approved.snapshot_id
  const tabsBefore = env.browser.all().length
  assert.equal(env.bridge.browserTab({ action: 'close', id: a.tab_id }).ok, true)
  const late = await env.computer.act({ ...A, approval: true, action: 'click', x: 20, y: 20, snapshot_id: look, tab_id: a.tab_id })
  assert.equal(late.status, 'stale'); noPage(late)
  const nothing = await env.computer.act({ ...A, approval: true, action: 'navigate', url: 'https://x.example/' })
  assert.equal(nothing.status, 'stale'); noPage(nothing)
  assert.ok(env.browser.all().length <= tabsBefore, 'no tab opened for an approval')
  assert.equal(env.browser.tabsOf('run_A').length, 0)
  // an approval that names no page, while the run has a current tab now: never sent to that tab (zero input)
  const later = await env.computer.observe(A)
  const sentBefore = env.wcOf(later.tab_id).debugger.sent.length
  for (const body of [{ action: 'navigate', url: 'https://x.example/' }, { action: 'key', keys: 'Enter', snapshot_id: 'browser-nope-1' }, { action: 'wait', seconds: 1 }]) {
    const out = await env.computer.act({ ...A, approval: true, ...body })
    assert.equal(out.status, 'stale', body.action); noPage(out)
  }
  assert.equal(env.wcOf(later.tab_id).debugger.sent.length, sentBefore, 'nothing reached the later current tab')
})

test('the next run of a session takes over the tabs its last ended run left, on the page it left (owner and label move with them); a run still going keeps its own; an approval of the ended run\'s look still reaches its tab', async (t) => {
  const env = await setup()
  t.after(env.done)
  const a = await env.computer.observe(A)
  const nav = await env.computer.act({ ...A, action: 'navigate', url: 'https://example.org/page', snapshot_id: a.snapshot_id })
  assert.equal(nav.status, 'ok')
  const second = await env.computer.act({ ...A, action: 'tab_new' })
  await env.computer.act({ ...A, action: 'tab_select', tab_id: a.tab_id })
  // a run of the session still going keeps its tabs: a parallel run gets its own
  const c = await env.computer.observe({ ...A, owner: 'run_C' })
  assert.ok(![a.tab_id, second.tab_id].includes(c.tab_id))
  env.computer.releaseOwner({ owner: 'run_A' })
  await sleep(5)
  env.computer.releaseOwner({ owner: 'run_C' })
  // the next run: the most recently ended run's tabs (C's), not A's
  const next = await env.computer.observe({ ...B, owner: 'run_N' })
  assert.equal(next.tab_id, c.tab_id)
  env.computer.releaseOwner({ owner: 'run_N' })
  env.bridge.browserTab({ action: 'close', id: c.tab_id })
  // N has nothing left: the run after it takes A's, on the page A was on
  const b = await env.computer.observe(B)
  assert.equal(b.status, 'ok')
  assert.equal(b.tab_id, a.tab_id)
  assert.equal(b.url, 'https://example.org/page')
  assert.deepEqual(b.tabs.map((x) => x.tab_id).sort(), [a.tab_id, second.tab_id].sort())
  const line = env.bridge.browserStatus().tabs.find((x) => x.id === a.tab_id)
  assert.deepEqual([line.owner, line.owner_label], ['run_B', 'GPT-6'])
  env.computer.releaseOwner({ owner: 'run_B' })
  const pressed = env.presses(a.tab_id).length
  const approved = await env.computer.act({ ...A, approval: true, action: 'click', x: 20, y: 20, snapshot_id: nav.snapshot_id, tab_id: a.tab_id })
  assert.equal(approved.status, 'ok')
  assert.equal(env.presses(a.tab_id).length, pressed + 1)
  // another session's run never takes them
  const other = await env.computer.observe({ ...B, owner: 'run_X', session: 's_2' })
  assert.ok(![a.tab_id, second.tab_id].includes(other.tab_id))
})

test('an action queued before the run let go is cancelled even when the same run takes the tab again; its unused look still serves a new explicit call', async (t) => {
  const env = await setup()
  t.after(env.done)
  const a = await env.computer.observe(A)
  let release
  const held = new Promise((r) => { release = r })
  const wcA = env.wcOf(a.tab_id)
  env.gates.fn = (wc, method, params) => (wc === wcA && method === 'Page.captureScreenshot' && params.quality !== 1 ? held : null)
  const slow = env.computer.observe(A)                                          // holds the tab's queue
  await sleep(20)
  const queued = env.computer.act({ ...A, action: 'click', x: 10, y: 10, snapshot_id: a.snapshot_id })
  await sleep(20)
  env.computer.releaseOwner({ owner: 'run_A' })                                  // the run ended
  const again = env.computer.act({ ...A, approval: true, action: 'click', x: 30, y: 30, snapshot_id: a.snapshot_id }) // re-takes the tab
  env.gates.fn = null
  release()
  await slow
  assert.equal((await queued).status, 'cancelled')
  const out = await again
  assert.equal(out.status, 'ok', 'the explicit new call used the look the cancelled one never used')
  assert.deepEqual(env.presses(a.tab_id).map(([, p]) => [p.x, p.y]), [[15, 15]])
})

test('a tab closed: its looks are stale, an action queued on it is cancelled, its late events change nothing, and its id is never reused', async (t) => {
  const env = await setup()
  t.after(env.done)
  const a = await env.computer.observe(A)
  const b = await env.computer.observe(B)
  const wcA = env.wcOf(a.tab_id)
  let release
  const held = new Promise((r) => { release = r })
  env.gates.fn = (wc, method, params) => (wc === wcA && method === 'Page.captureScreenshot' && params.quality !== 1 ? held : null)
  const slow = env.computer.observe(A)
  await sleep(20)
  const queued = env.computer.act({ ...A, action: 'navigate', url: 'https://a.example/' })
  const closing = env.computer.act({ ...A, action: 'tab_close', tab_id: a.tab_id })
  env.gates.fn = null
  release()
  await slow
  assert.equal((await queued).status, 'ok', 'what was queued before the close goes first')
  const closed = await closing
  assert.equal(closed.status, 'ok'); assert.deepEqual(closed.done, { closed: a.tab_id }); assert.deepEqual(closed.tabs, [])
  assert.equal(wcA.destroyed, true)
  assert.equal(env.windows.filter((w) => w.children.has(wcA.view)).length, 0)
  const stale = await env.computer.act({ ...A, action: 'click', x: 1, y: 1, snapshot_id: a.snapshot_id })
  assert.equal(stale.status, 'stale'); noPage(stale)
  // late events of the closed page reach nobody: B's look stays usable
  wcA.emit('did-navigate', {}, 'https://late.example/')
  wcA.debugger.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'alert', message: 'late' })
  assert.equal((await env.computer.act({ ...B, action: 'click', x: 1, y: 1, snapshot_id: b.snapshot_id })).status, 'ok')
  const fresh = await env.computer.observe(A)
  assert.notEqual(fresh.tab_id, a.tab_id, 'a new tab, never the old id')
})

test('Clear data: refused while any tab is held or busy (not only the tab shown); while it runs no tab opens for anyone; pages close before the profile is cleared; every look is stale after', async (t) => {
  const env = await setup()
  t.after(env.done)
  env.bridge.placeBrowser({ x: 0, y: 0, width: 600, height: 400, visible: true })
  const shown = env.browser.activeTab()
  const a = await env.computer.observe(A)
  assert.notEqual(a.tab_id, shown, 'the card keeps showing the person\'s tab')
  let refused = await env.bridge.clearBrowserData()
  assert.equal(refused.cleared, false); assert.equal(refused.holder, 'run_A')
  env.computer.releaseOwner({ owner: 'run_A' })
  // an operation under way on a tab no run holds any more (an approval in flight) refuses it too
  let release
  const held = new Promise((r) => { release = r })
  env.gates.fn = (wc, method, params) => (method === 'Page.captureScreenshot' && params.quality !== 1 ? held : null)
  const inflight = env.computer.observe(A)
  await sleep(20)
  env.computer.releaseOwner({ owner: 'run_A' })
  refused = await env.bridge.clearBrowserData()
  assert.equal(refused.cleared, false)
  assert.equal(env.bridge.browserStatus().can_clear_data, false)
  env.gates.fn = null
  release()
  await inflight
  env.computer.releaseOwner({ owner: 'run_A' })
  assert.equal(env.bridge.browserStatus().can_clear_data, true)
  // a clear held mid-way: nobody opens a page meanwhile
  let finish
  env.session.hold = new Promise((r) => { finish = r })
  const clearing = env.bridge.clearBrowserData()
  await sleep(10)
  const during = await Promise.all([env.computer.observe(B), env.computer.act({ ...B, action: 'tab_new' }), env.computer.act({ ...A, approval: true, action: 'click', x: 1, y: 1, snapshot_id: a.snapshot_id })])
  assert.deepEqual(during.map((o) => o.status), ['busy', 'busy', 'busy'])
  during.forEach(noPage)
  assert.equal(env.bridge.browserTab({ action: 'new', url: 'https://x.example/' }).ok, false)
  assert.equal(env.bridge.browserNavigate({ action: 'go', url: 'https://x.example/' }).ok, false)
  assert.equal(env.browser.all().length, 0, 'no page alive while the profile is cleared')
  finish()
  assert.deepEqual(await clearing, { cleared: true })
  env.session.hold = null
  assert.deepEqual(env.session.order.map(([what, open]) => [what, open]), [['storage', 0], ['cache', 0], ['auth', 0]])
  const after = env.browser.all()
  assert.equal(after.length, 1); assert.equal(after[0].owner, null, 'one blank tab of the person\'s')
  const stale = await env.computer.act({ ...A, approval: true, action: 'click', x: 1, y: 1, snapshot_id: a.snapshot_id })
  assert.equal(stale.status, 'stale'); noPage(stale)
  assert.equal(env.browser.all().length, 1, 'the stale approval opened nothing')
})

test('downloads go to the run of the tab whose page began them (whatever the card shows); one from a closed tab is cancelled; one listener for any number of tabs', async (t) => {
  const env = await setup()
  t.after(env.done)
  env.bridge.placeBrowser({ x: 0, y: 0, width: 600, height: 400, visible: true })
  const a = await env.computer.observe(A)
  const b = await env.computer.observe(B)
  env.bridge.browserTab({ action: 'switch', id: b.tab_id })                    // the card shows B's tab
  assert.equal(env.session.listenerCount('will-download'), 1)
  const item = (name) => {
    const it = new EventEmitter()
    it.name = name; it.cancelled = false
    it.getFilename = () => name; it.getTotalBytes = () => 10; it.getReceivedBytes = () => 10; it.getMimeType = () => 'text/plain'; it.getURL = () => 'https://a.example/f'
    it.setSavePath = (p) => { it.path = p; fs.writeFileSync(p, 'x') }
    it.cancel = () => { it.cancelled = true }
    return it
  }
  const fromA = item('a.txt')
  env.session.emit('will-download', {}, fromA, env.wcOf(a.tab_id))
  fromA.emit('done', {}, 'completed')
  const lookA = await env.computer.observe(A)
  const lookB = await env.computer.observe(B)
  assert.deepEqual((lookA.downloads || []).map((d) => d.name), ['a.txt'])
  assert.equal(lookB.downloads, undefined, 'B never hears of A\'s download')
  // a page whose tab is gone
  const wcA = env.wcOf(a.tab_id)
  await env.computer.act({ ...A, action: 'tab_close', tab_id: a.tab_id })
  const late = item('late.txt')
  env.session.emit('will-download', {}, late, wcA)
  assert.equal(late.cancelled, true)
  for (let i = 0; i < 3; i += 1) await env.computer.act({ ...B, action: 'tab_new' })
  assert.equal(env.session.listenerCount('will-download'), 1)
})

test('a dialog or the person\'s input on one tab changes only that tab; a navigation between an action\'s checks and its press stops it (stale, nothing pressed)', async (t) => {
  const env = await setup()
  t.after(env.done)
  const a = await env.computer.observe(A)
  const b = await env.computer.observe(B)
  env.wcOf(a.tab_id).debugger.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'alert', message: 'on A' })
  const lookB = await env.computer.observe(B)
  assert.equal(lookB.dialog, null, 'A\'s dialog is not B\'s')
  assert.equal((await env.computer.act({ ...B, action: 'click', x: 1, y: 1, snapshot_id: b.snapshot_id })).status, 'ok', 'A\'s dialog leaves B\'s earlier look current')
  const b2 = await env.computer.observe(B)
  // B's page navigates by itself while the click warms up its pointer: the last word before the press says stale
  const wcB = env.wcOf(b.tab_id)
  env.gates.fn = (wc, method, params) => {
    if (wc === wcB && method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') { wc.emit('did-start-navigation', {}, 'https://elsewhere.example/', false, true) }
    return null
  }
  const pressedBefore = env.presses(b.tab_id).length
  const out = await env.computer.act({ ...B, action: 'click', x: 1, y: 1, snapshot_id: b2.snapshot_id })
  env.gates.fn = null
  assert.equal(out.status, 'stale')
  assert.match(out.reason, /navigated/)
  assert.equal(env.presses(b.tab_id).length, pressedBefore, 'nothing pressed after the navigation began')
})

test('limits: a run gets 4 tabs, the browser 12 — beyond is refused, never busy; idle agent tabs close after 10 minutes, but not one held, busy, on the card or just used by the person', async (t) => {
  const env = await setup()
  t.after(env.done)
  await env.computer.observe(A)
  for (let i = 0; i < 3; i += 1) assert.equal((await env.computer.act({ ...A, action: 'tab_new' })).status, 'ok')
  const fifth = await env.computer.act({ ...A, action: 'tab_new' })
  assert.equal(fifth.status, 'refused'); assert.match(fifth.reason, /4 tabs/)
  for (const run of ['run_C', 'run_D']) for (let i = 0; i < 4; i += 1) { const out = i === 0 ? await env.computer.observe({ ...A, owner: run }) : await env.computer.act({ ...A, owner: run, action: 'tab_new' }); assert.equal(out.status, 'ok') }
  const full = await env.computer.observe(B)
  assert.equal(full.status, 'refused'); assert.match(full.reason, /12 tabs/); noPage(full)
  // ten minutes on, every lease has lapsed: idle agent tabs close — but not the one the person just typed into, nor
  // the one with a look under way
  env.computer.releaseOwner({ owner: 'run_C' })
  const cTabs = env.browser.tabsOf('run_C').map((x) => x.id)
  const busyTab = env.browser.tabsOf('run_D')[0].id
  let release
  const held = new Promise((r) => { release = r })
  env.gates.fn = (wc, method, params) => (wc === env.wcOf(busyTab) && method === 'Page.captureScreenshot' && params.quality !== 1 ? held : null)
  const inflight = env.computer.observe({ ...A, owner: 'run_D', tab_id: busyTab })
  await sleep(20)
  const every = env.browser.all().map((x) => x.id)
  const realNow = Date.now
  try {
    Date.now = () => realNow() + 11 * 60_000
    env.wcOf(cTabs[0]).emit('input-event', {}, { type: 'keyDown', _modifiers: 0 })
    const closed = env.computer.reap()
    assert.deepEqual(closed.sort(), every.filter((id) => id !== cTabs[0] && id !== busyTab).sort())
  } finally { Date.now = realNow }
  env.gates.fn = null
  release()
  assert.equal((await inflight).status, 'ok')
  // a new run (of another session: one of run_C's would take its tab over) gets a new tab, never a recycled one
  const fresh = await env.computer.observe({ ...A, owner: 'run_E', session: 's_9' })
  assert.equal(fresh.status, 'ok'); assert.ok(!every.includes(fresh.tab_id))
})

test('live pictures: the thread\'s view of a run shows that run\'s tab; the card\'s names its showing; a tab closed mid-picture shows nothing', async (t) => {
  const env = await setup()
  t.after(env.done)
  env.bridge.placeBrowser({ x: 0, y: 0, width: 600, height: 400, visible: true })
  const a = await env.computer.observe(A)
  const b = await env.computer.observe(B)
  const captured = []
  env.gates.fn = (wc, method) => { if (method === 'Page.captureScreenshot') captured.push(wc); return null }
  const fa = await env.bridge.surfaceFrame({ surface: 'browser', owner: 'run_A' })
  assert.equal(fa.tab_id, a.tab_id); assert.ok(fa.image)
  assert.equal(fa.page, undefined, 'a run\'s view carries no card showing identity')
  assert.ok(captured.every((wc) => wc === env.wcOf(a.tab_id)))
  captured.length = 0
  const fb = await env.bridge.surfaceFrame('browser', 'run_B')
  assert.equal(fb.tab_id, b.tab_id)
  assert.ok(captured.every((wc) => wc === env.wcOf(b.tab_id)))
  const none = await env.bridge.surfaceFrame({ surface: 'browser', owner: 'run_nobody' })
  assert.equal(none.image, null)
  await sleep(5)                                                                 // the card's blank tab loaded
  const card = await env.bridge.surfaceFrame('browser')
  assert.equal(card.page, env.browser.shownPage())
  assert.equal(card.tab_id, env.browser.activeTab())
  // B's tab closes while its picture is taken: nothing shown (past the 100 ms a shared picture is kept)
  await sleep(150)
  let release
  const held = new Promise((r) => { release = r })
  env.gates.fn = (wc, method) => (method === 'Page.captureScreenshot' && wc === env.wcOf(b.tab_id) ? held : null)
  const pending = env.bridge.surfaceFrame({ surface: 'browser', owner: 'run_B' })
  await sleep(10)
  await env.computer.act({ ...B, action: 'tab_close', tab_id: b.tab_id })
  release()
  assert.equal((await pending).image, null)
  env.gates.fn = null
})

test('the card\'s queued input stays with its showing (A → B → A refuses the old one) while switching alone stales no agent look', async (t) => {
  const env = await setup()
  t.after(env.done)
  env.bridge.placeBrowser({ x: 0, y: 0, width: 600, height: 400, visible: true })
  const a = await env.computer.observe(A)
  const b = await env.computer.observe(B)
  env.bridge.browserTab({ action: 'switch', id: a.tab_id })
  const oldShowing = env.browser.shownPage()
  env.bridge.browserTab({ action: 'switch', id: b.tab_id })
  env.bridge.browserTab({ action: 'switch', id: a.tab_id })
  const refused = await env.bridge.browserInput({ type: 'text', text: 'late', page: oldShowing })
  assert.equal(refused.ok, false)
  assert.deepEqual(env.wcOf(a.tab_id).debugger.sent.filter(([m]) => m === 'Input.insertText'), [])
  assert.equal((await env.computer.act({ ...A, action: 'click', x: 1, y: 1, snapshot_id: a.snapshot_id })).status, 'ok')
  assert.equal((await env.computer.act({ ...B, action: 'click', x: 1, y: 1, snapshot_id: b.snapshot_id })).status, 'ok')
  // the person's input on the tab shown (A) is A's: B's next look-based action is untouched
  const a2 = await env.computer.observe(A)
  const b2 = await env.computer.observe(B)
  assert.equal((await env.bridge.browserInput({ type: 'text', text: 'mine', page: env.browser.shownPage() })).ok, true)
  assert.equal((await env.computer.act({ ...A, action: 'click', x: 1, y: 1, snapshot_id: a2.snapshot_id })).status !== 'ok', true)
  assert.equal((await env.computer.act({ ...B, action: 'click', x: 1, y: 1, snapshot_id: b2.snapshot_id })).status, 'ok')
})

test('the IPC takes the old string or { surface, owner }; preload exposes the owner argument', () => {
  const { frameAsk } = require('../bridge')
  assert.deepEqual(frameAsk('chatgpt'), { surface: 'chatgpt', owner: null })
  assert.deepEqual(frameAsk('browser'), { surface: 'browser', owner: null })
  assert.deepEqual(frameAsk({ surface: 'browser', owner: 'run_1' }), { surface: 'browser', owner: 'run_1' })
  assert.deepEqual(frameAsk({ surface: 'browser', owner: 'x'.repeat(101) }), { surface: 'browser', owner: null })
  assert.deepEqual(frameAsk({ surface: 'browser', owner: '<script>' }), { surface: 'browser', owner: null })
  assert.deepEqual(frameAsk({ surface: 'chatgpt', owner: 'run_1' }), { surface: 'chatgpt', owner: null })
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  assert.match(preload, /surfaceFrame: \(surface, owner\)/)
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(main, /const ask = frameAsk\(raw\)/)
})
