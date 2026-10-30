const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const { createComputer, outlineOf, nodeOfRef } = require('../computer')
const { agentBrowser, placementWatch, browserAllows, electronSurface, harnessAddress, HIDDEN_BOUNDS, jpegSize, keyOf, ownInput, seatView } = require('../computer_electron')
const { BRIDGE_OWNER, clearBrowserData, harnessPortsOf, liveFrame, serveBridge, createBridge } = require('../bridge')
const { cdpOf, CdpUnavailable } = require('../cdp')

/** An accessibility tree as the devtools protocol gives it. */
function axTree() {
  const node = (nodeId, role, name, extra = {}) => ({ nodeId: String(nodeId), role: { value: role }, name: { value: name }, backendDOMNodeId: nodeId, childIds: [], ...extra })
  const nodes = [
    node(1, 'RootWebArea', 'Test', { childIds: ['2', '3', '4', '5', '6', '9'] }),
    node(2, 'heading', 'Welcome', { properties: [{ name: 'level', value: { value: 1 } }] }),
    node(3, 'button', 'Send', { properties: [{ name: 'focusable', value: { value: true } }, { name: 'disabled', value: { value: true } }] }),
    node(4, 'textbox', 'Message', { value: { value: 'draft' }, properties: [{ name: 'focused', value: { value: true } }] }),
    node(5, 'StaticText', 'just words'),
    node(6, 'dialog', '', { childIds: ['7', '8'] }),
    node(7, 'link', 'Terms "and" rules'),
    node(8, 'generic', 'Clickable div', { properties: [{ name: 'focusable', value: { value: true } }] }),
    node(9, 'button', 'Hidden', { ignored: true }),
  ]
  for (const n of nodes) for (const c of n.childIds) nodes.find((m) => m.nodeId === c).parentId = n.nodeId
  return nodes
}

test('the outline lists the controls with refs and the landmarks between them; text, ignored nodes and the root are left out', () => {
  const { text, refs, lines } = outlineOf(axTree())
  assert.equal(text, [
    '- heading "Welcome" level=1',
    '- button "Send" disabled [ref=e3]',
    '- textbox "Message" value="draft" focused [ref=e4]',
    '- dialog',
    '  - link "Terms \\"and\\" rules" [ref=e7]',
    '  - generic "Clickable div" [ref=e8]',
  ].join('\n'))
  assert.deepEqual([...refs].sort(), [3, 4, 7, 8])
  // what says an element is still the one shown: its line, where the focus is aside
  assert.equal(lines.get(4), '- textbox "Message" value="draft"')
  const cut = outlineOf(axTree(), { maxLines: 2 })
  assert.match(cut.text, /… 4 more controls not listed/)
  assert.equal(nodeOfRef('e42'), 42)
  assert.equal(nodeOfRef('42'), null)
  assert.equal(nodeOfRef('e4x'), null)
})

/** A surface the test plays: a driver that records what it was asked, and the page's changes as the test makes them. */
function fakeSurface(opts = {}) {
  const calls = []
  const page = {
    url: 'https://example.com/', title: 'Example', viewport: { width: 1000, height: 600 }, text: 'x'.repeat(25_000), generation: 0, personAt: null, dialog: null, chooser: null,
    busy: null, notes: [], opened: false, frames: [], downloads: [], doneBy: {}, console: [], covered: null, moving: null, gone: new Set(), loading: false, labels: [],
    states: {}, ax: {}, boxes: null, at: null, active: null, values: {}, focusHeld: () => true, released: [], resets: 0, visibility: null, hooks: {}, treeGate: null, failShot: 0,
  }
  const hook = async (name) => { if (page.hooks[name]) await page.hooks[name]() }
  const driver = {
    info: async () => ({ url: page.url, title: page.title, loading: page.loading, viewport: { ...page.viewport } }),
    shallowInfo: () => ({ url: page.url, title: page.title, loading: false }),
    screenshot: async ({ width, height }) => {
      calls.push(['screenshot', width, height])
      await hook('screenshot')
      if (page.failShot > 0) { page.failShot -= 1; throw new Error('Page.captureScreenshot did not answer within 15 s') }
      return { media_type: 'image/jpeg', data_base64: 'AAAA', width: width / 2, height: height / 2 }
    },
    tree: async () => { if (page.treeGate) await page.treeGate; return [{ url: page.url, nodes: axTree() }, ...page.frames] },
    box: async (node) => (node === 8 || page.gone.has(node) ? null : page.moving ? page.moving(node) : { x: node * 10, y: node * 5 }),
    click: async (x, y, o) => { calls.push(['pointer', x, y]); if (o.beforePress) await o.beforePress(); calls.push(['click', x, y, o.button, o.count]); await hook('click') },
    move: async (x, y) => { calls.push(['move', x, y]) },
    scroll: async (x, y, dx, dy) => { calls.push(['scroll', x, y, dx, dy]) },
    insertText: async (text, o = {}) => { if (o.before) await o.before(); calls.push(['insertText', text]); if (page.active && page.values[page.active.node] !== undefined && !page.frozen) page.values[page.active.node] += text },
    key: async (keys, o = {}) => { await hook('keyStart'); if (o.before) await o.before(); calls.push(['key', keys]); await hook('key') },
    clearFocused: async (o = {}) => { if (o.before) await o.before(); if (o.beforeDelete) await o.beforeDelete(); calls.push(['clear']); if (page.active && page.values[page.active.node] !== undefined) page.values[page.active.node] = ''; await hook('clear') },
    navigate: async (url) => { calls.push(['navigate', url]); page.url = url; page.generation += 1 },
    history: async (d) => { calls.push(['history', d]) },
    reload: async () => { calls.push(['reload']) },
    setFiles: async (node, files) => { calls.push(['setFiles', node, files]) },
    answerDialog: async (accept, text) => { calls.push(['dialog', accept, text]); page.dialog = null; page.generation += 1 },
    readText: async (node) => (node === null ? page.text : `node ${node}`),
    hitTest: async (node) => { const c = typeof page.covered === 'function' ? page.covered(node) : page.covered; return c ? { ok: false, covering: c } : { ok: true } },
    focus: async (node) => { calls.push(['focus', node]) },
    selectOption: async (node, choice) => (choice === 'Blue' ? { ok: true, label: 'Blue' } : { ok: false, reason: `no option "${choice}"` }),
    drag: async (from, to) => { calls.push(['drag', from.x, from.y, to.x, to.y]) },
    settle: async () => { calls.push(['settle']); page.loading = false },
    pageWords: async () => { await hook('words'); return `${page.text}\n${page.labels.join('\n')}` },
    state: async (node) => page.states[node] || { disabled: false, readonly: false, desc: `element ${node}` },
    axNode: async (node) => page.ax[node] ?? null,
    layout: async () => (page.layouts && page.layouts.length ? page.layouts.shift() : page.boxes),
    nodeAt: async (x, y, expected) => (page.at ? page.at(x, y, expected) : null),
    activeElement: async () => page.active || { node: null, desc: 'nothing' },
    holdsFocus: async (node) => page.focusHeld(node),
    fieldValue: async (node) => (page.values[node] !== undefined ? { value: page.values[node], secret: false } : { value: null, secret: false }),
    caretToEnd: async (node) => { calls.push(['caretToEnd', node]) },
  }
  const surface = {
    label: 'fake', opened: () => page.opened,
    open: () => { page.opened = true; return driver },
    generation: () => page.generation,
    personAt: () => page.personAt,
    allowsUrl: opts.allowsUrl || browserAllows,
    busy: () => page.busy,
    events: (owner) => {
      const mine = page.downloads.filter((d) => d.owner === owner)
      page.downloads = page.downloads.filter((d) => d.owner !== owner)
      return { dialog: page.dialog, chooser: page.chooser, notes: page.notes.splice(0), downloads: mine.map(({ name, path: p, bytes }) => ({ name, path: p, bytes })), console: page.console.splice(0) }
    },
    peek: () => ({ dialog: page.dialog, chooser: page.chooser }),
    downloadsDone: (owner) => page.doneBy[owner] || 0,
    released: (owner) => { page.released.push(owner) },
    reset: async () => { page.resets += 1; page.url = 'about:blank'; page.generation += 1; return true },
    visibility: () => page.visibility,
    chooserUsed: () => { page.chooser = null },
    note: (line) => { page.notes.push(line) },
  }
  return { surface, page, calls }
}

function computerOf(surfaces, extra = {}) {
  let clock = 1_000_000
  const logs = []
  // the clock moves as the computer waits (a wait for a condition, an element settling)
  const computer = createComputer({ surfaces, now: () => clock, instance: 'i1', log: (line) => logs.push(line), settle: async (ms) => { clock += ms; await new Promise((r) => setImmediate(r)) }, ...extra })
  return { computer, tick: (ms) => { clock += ms }, time: () => clock, logs }
}

test('a look: the screenshot at the viewport, the outline, the snapshot an action names; an unknown surface or no owner is refused', async () => {
  const { surface, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  const look = await computer.observe({ surface: 'browser', owner: 'run_1' })
  assert.equal(look.status, 'ok')
  assert.equal(look.snapshot_id, 'browser-i1-1')
  assert.deepEqual(look.viewport, { width: 1000, height: 600 })
  assert.deepEqual(look.image, { media_type: 'image/jpeg', data_base64: 'AAAA', width: 500, height: 300 })
  assert.match(look.outline, /button "Send" disabled \[ref=e3\]/)
  assert.deepEqual(calls.find((c) => c[0] === 'screenshot'), ['screenshot', 1000, 600])
  const bare = await computer.observe({ surface: 'browser', owner: 'run_1', screenshot: false })
  assert.equal(bare.image, null)
  assert.equal((await computer.observe({ surface: 'nope', owner: 'run_1' })).status, 'refused')
  assert.equal((await computer.observe({ surface: 'browser' })).status, 'refused')
  assert.deepEqual(computer.list().surfaces, [{ id: 'browser', label: 'fake', opened: true, holder: 'run_1' }])
})

test('snapshot ids name this start of the app: another start\'s id is no current look', async () => {
  const a = createComputer({ surfaces: { browser: fakeSurface().surface } })
  const b = createComputer({ surfaces: { browser: fakeSurface().surface } })
  const la = await a.observe({ owner: 'run_1' })
  const lb = await b.observe({ owner: 'run_1' })
  assert.match(la.snapshot_id, /^browser-[0-9a-f]{8}-1$/)
  assert.notEqual(la.snapshot_id, lb.snapshot_id)
  const across = await b.act({ owner: 'run_1', action: 'click', ref: 'e7', snapshot_id: la.snapshot_id })
  assert.equal(across.status, 'stale')
  assert.match(across.reason, /not a current look/)
})

test('an action needs a current look: a page that changed, or was resized, since is stale — nothing is done, a fresh look comes back; a look is used up by its action', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  const look = await computer.observe({ surface: 'browser', owner: 'run_1' })
  const none = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 1, y: 1 })
  assert.equal(none.status, 'stale')
  assert.match(none.reason, /needs the snapshot_id/)
  page.generation += 1                                                             // the page navigated by itself
  const stale = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 1, y: 1, snapshot_id: look.snapshot_id })
  assert.equal(stale.status, 'stale')
  assert.equal(stale.snapshot_id, 'browser-i1-3')                                 // the fresh look (after the one the first refusal brought)
  assert.ok(!calls.some((c) => c[0] === 'click'))
  page.viewport = { width: 800, height: 600 }                                      // the card showed it at another size
  const resized = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 1, y: 1, snapshot_id: stale.snapshot_id })
  assert.equal(resized.status, 'stale')
  assert.match(resized.reason, /resized/)
  const ok = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 100, y: 50, snapshot_id: resized.snapshot_id })
  assert.equal(ok.status, 'ok')
  // x/y are the screenshot's pixels: the picture is half the viewport, so the page point is twice
  assert.deepEqual(calls.filter((c) => c[0] === 'click'), [['click', 200, 100, 'left', 1]])
  assert.equal(ok.done.clicked.x, 200)
  assert.ok(ok.snapshot_id)                                                        // every action answers with the look after it
  // the same look again (a retry after a lost answer, say): stale, nothing done twice
  const again = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 100, y: 50, snapshot_id: resized.snapshot_id })
  assert.equal(again.status, 'stale')
  assert.match(again.reason, /used by an earlier action/)
  assert.equal(calls.filter((c) => c[0] === 'click').length, 1)
  assert.ok(again.snapshot_id && again.snapshot_id !== resized.snapshot_id)
})

test('refs are the snapshot\'s: a ref clicks its element\'s middle; one not in the snapshot, or with no box, is refused', async () => {
  const { surface, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  const look = await computer.observe({ surface: 'browser', owner: 'run_1' })
  const clicked = await computer.act({ surface: 'browser', owner: 'run_1', action: 'double_click', ref: 'e7', snapshot_id: look.snapshot_id })
  assert.equal(clicked.status, 'ok')
  assert.deepEqual(calls.filter((c) => c[0] === 'click'), [['click', 70, 35, 'left', 2]])
  const unknown = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', ref: 'e99', snapshot_id: clicked.snapshot_id })
  assert.equal(unknown.status, 'refused')
  assert.match(unknown.reason, /not one of the snapshot's refs/)
  const hidden = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', ref: 'e8', snapshot_id: clicked.snapshot_id })
  assert.equal(hidden.status, 'refused')
  assert.match(hidden.reason, /no box/)
  const typed = await computer.act({ surface: 'browser', owner: 'run_1', action: 'type', ref: 'e4', text: 'hello', clear: true, submit: true, snapshot_id: clicked.snapshot_id })
  assert.equal(typed.status, 'ok')
  assert.deepEqual(calls.slice(-9).filter((c) => !['screenshot', 'settle', 'pointer'].includes(c[0])), [['click', 40, 20, 'left', 1], ['focus', 4], ['clear'], ['insertText', 'hello'], ['key', 'Enter']])
  assert.deepEqual(typed.done, { typed: 5, cleared: true, submitted: true })
  const scrolled = await computer.act({ surface: 'browser', owner: 'run_1', action: 'scroll', snapshot_id: typed.snapshot_id })
  assert.deepEqual(calls.filter((c) => c[0] === 'scroll'), [['scroll', 500, 300, 0, 600]])  // the viewport's middle, a page down
  assert.equal((await computer.act({ surface: 'browser', owner: 'run_1', action: 'key', keys: '', snapshot_id: scrolled.snapshot_id })).status, 'refused')
  assert.equal((await computer.act({ surface: 'browser', owner: 'run_1', action: 'fly' })).status, 'refused')
})

test('one actor per surface: another run is told who holds it until the holder lets go or a quiet lease runs out', async () => {
  const { surface, page } = fakeSurface()
  const { computer, tick } = computerOf({ browser: surface })
  await computer.observe({ surface: 'browser', owner: 'run_1' })
  const other = await computer.observe({ surface: 'browser', owner: 'run_2' })
  assert.equal(other.status, 'busy')
  assert.equal(other.holder, 'run_1')
  assert.deepEqual(await computer.act({ surface: 'browser', owner: 'run_1', action: 'release' }), { status: 'ok', surface: 'browser', released: true })
  assert.equal((await computer.observe({ surface: 'browser', owner: 'run_2' })).status, 'ok')
  tick(91_000)                                                                     // run_2 went quiet
  assert.equal((await computer.observe({ surface: 'browser', owner: 'run_1' })).status, 'ok')
  assert.equal(computer.holder('browser'), 'run_1')
  // what a run left behind goes with it: when it lets go, and when its lease ran out and another took the page
  assert.deepEqual(page.released, ['run_1', 'run_2'])
  // a run that ended lets go of all it held at once
  assert.deepEqual(computer.releaseOwner({ owner: 'run_1' }), { status: 'ok', released: ['browser'] })
  assert.equal(computer.holder('browser'), null)
  assert.deepEqual(computer.releaseOwner({ owner: 'run_1' }), { status: 'ok', released: [] })
  assert.equal(computer.releaseOwner({}).status, 'refused')
})

test('the person using the page stops the agent; the surface\'s own busy reason too; navigation stays where the surface allows', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer, tick } = computerOf({ browser: surface })
  let look = await computer.observe({ surface: 'browser', owner: 'run_1' })
  page.personAt = 1_000_000
  const person = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 1, y: 1, snapshot_id: look.snapshot_id })
  assert.equal(person.status, 'person_active')
  tick(4_000)
  page.busy = 'the bridge is sending'
  const busy = await computer.act({ surface: 'browser', owner: 'run_1', action: 'navigate', url: 'https://a.example/' })
  assert.deepEqual([busy.status, busy.reason], ['busy', 'the bridge is sending'])
  // the ChatGPT page's reason is asked of the page (a promise): not busy is not busy
  const asked = surface.busy
  surface.busy = async () => null
  assert.equal((await computer.act({ surface: 'browser', owner: 'run_1', action: 'wait', seconds: 0 })).status, 'ok')
  surface.busy = async () => 'ChatGPT is answering'
  assert.equal((await computer.act({ surface: 'browser', owner: 'run_1', action: 'wait', seconds: 0 })).reason, 'ChatGPT is answering')
  surface.busy = asked
  page.busy = null
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'devtools://x']) {
    assert.equal((await computer.act({ surface: 'browser', owner: 'run_1', action: 'navigate', url })).status, 'refused', url)
  }
  look = await computer.act({ surface: 'browser', owner: 'run_1', action: 'navigate', url: 'http://localhost:5173/' })
  assert.equal(look.status, 'ok')
  assert.equal(look.url, 'http://localhost:5173/')
  assert.deepEqual(calls.filter((c) => c[0] === 'navigate'), [['navigate', 'http://localhost:5173/']])
  const { computer: chat } = computerOf({ chatgpt: fakeSurface({ allowsUrl: (u) => u.startsWith('https://chatgpt.com/') }).surface })
  assert.equal((await chat.act({ surface: 'chatgpt', owner: 'run_1', action: 'navigate', url: 'https://evil.example/' })).status, 'refused')
})

test('read_text pages the page\'s words; a dialog is shown and answered on the look that showed it; a file chooser takes the files', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  const first = await computer.act({ surface: 'browser', owner: 'run_1', action: 'read_text' })
  assert.equal(first.text.length, 20_000)
  assert.equal(first.next_offset, 20_000)
  assert.equal(first.total_chars, 25_000)
  const rest = await computer.act({ surface: 'browser', owner: 'run_1', action: 'read_text', offset: 20_000 })
  assert.deepEqual([rest.text.length, rest.next_offset], [5_000, null])
  const look = await computer.observe({ surface: 'browser', owner: 'run_1' })
  assert.equal((await computer.act({ surface: 'browser', owner: 'run_1', action: 'read_text', ref: 'e7', snapshot_id: look.snapshot_id })).text, 'node 7')
  assert.equal((await computer.act({ surface: 'browser', owner: 'run_1', action: 'read_text', ref: 'e7' })).text, 'node 7')   // the latest look's ref
  assert.equal((await computer.act({ surface: 'browser', owner: 'run_1', action: 'read_text', ref: 'e99' })).status, 'refused')
  page.dialog = { type: 'confirm', message: 'sure?', seq: 1 }
  page.generation += 1
  const held = await computer.observe({ surface: 'browser', owner: 'run_1' })
  assert.deepEqual([held.image, held.outline, held.dialog.type], [null, '', 'confirm'])
  const answered = await computer.act({ surface: 'browser', owner: 'run_1', action: 'dialog', accept: false, snapshot_id: held.snapshot_id })
  assert.deepEqual(answered.done, { dialog: 'confirm', accepted: false })
  assert.equal((await computer.act({ surface: 'browser', owner: 'run_1', action: 'dialog', snapshot_id: answered.snapshot_id })).status, 'refused')   // none open
  const none = await computer.act({ surface: 'browser', owner: 'run_1', action: 'upload', files: ['/tmp/a.txt'], snapshot_id: answered.snapshot_id })
  assert.match(none.reason, /no file chooser is open/)
  page.chooser = { node: 55, mode: 'selectMultiple' }
  const look2 = await computer.observe({ surface: 'browser', owner: 'run_1' })
  assert.ok(look2.notes.some((n) => /file chooser is open/.test(n)))
  const up = await computer.act({ surface: 'browser', owner: 'run_1', action: 'upload', files: ['/tmp/a.txt', '/tmp/b.png'], snapshot_id: look2.snapshot_id })
  assert.deepEqual(up.done, { uploaded: 2 })
  assert.deepEqual(calls.filter((c) => c[0] === 'setFiles'), [['setFiles', 55, ['/tmp/a.txt', '/tmp/b.png']]])
  assert.equal(page.chooser, null)
})

test('test_dialog_answer_is_tied_to_the_dialog_its_look_showed', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  page.dialog = { type: 'confirm', message: 'Save your draft?', seq: 1 }
  const shown = await computer.observe({ owner: 'run_1' })
  assert.equal((await computer.act({ owner: 'run_1', action: 'dialog', accept: true })).status, 'stale')   // no look named
  // another dialog took its place (the page answered the first itself): the approval of the first does not answer it
  page.dialog = { type: 'confirm', message: 'DELETE record 42 permanently?', seq: 2 }
  const other = await computer.act({ owner: 'run_1', action: 'dialog', accept: true, snapshot_id: shown.snapshot_id })
  assert.equal(other.status, 'stale')
  assert.match(other.reason, /DELETE record 42 permanently\?.*not the one that look showed/)
  assert.ok(!calls.some((c) => c[0] === 'dialog'))
  assert.equal(other.dialog.message, 'DELETE record 42 permanently?')             // the fresh look shows the one open now
  const answered = await computer.act({ owner: 'run_1', action: 'dialog', accept: false, snapshot_id: other.snapshot_id })
  assert.deepEqual([answered.status, calls.filter((c) => c[0] === 'dialog')], ['ok', [['dialog', false, undefined]]])
})

test('keys: named keys, letters and shortcuts; macOS editing shortcuts carry their command', () => {
  assert.deepEqual(keyOf('Enter', 'darwin'), { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r', commands: undefined })
  assert.deepEqual(keyOf('Meta+A', 'darwin'), { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, text: undefined, commands: ['selectAll'] })
  assert.equal(keyOf('Meta+A', 'linux').commands, undefined)
  assert.equal(keyOf('Shift+Meta+Z', 'darwin').commands[0], 'redo')
  assert.deepEqual(keyOf('Shift+Tab'), { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8, text: undefined, commands: undefined })
  assert.equal(keyOf('Shift+a').key, 'A')
  assert.equal(keyOf('F5').windowsVirtualKeyCode, 116)
  assert.throws(() => keyOf('Hyper+A'), /unknown modifier/)
  assert.throws(() => keyOf('Banana'), /unknown key/)
})

test('a JPEG says its size; the agent browser opens the web and a blank page only, never the harness\'s own addresses', () => {
  // SOI, APP0 (length 16), SOF0 with height 300, width 500
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0xf4, 0x03, ...Buffer.alloc(12)])
  assert.deepEqual(jpegSize(jpeg), { width: 500, height: 300 })
  assert.equal(jpegSize(Buffer.from([0x00, 0x01])), null)
  assert.equal(browserAllows('https://example.com/a'), true)
  assert.equal(browserAllows('http://127.0.0.1:5173/'), true)
  assert.equal(browserAllows('about:blank'), true)
  assert.equal(browserAllows('about:config'), false)
  assert.equal(browserAllows('file:///Users/me/.ssh/id_rsa'), false)
})

test('test_harness_addresses_are_kept_from_the_agent_browser', () => {
  const ports = harnessPortsOf({}, 8323)
  // the standing gateway's port (8324) is the harness's too: the agent's browser never reaches it
  assert.deepEqual(ports, [8321, 8322, 8323, 8324])
  assert.deepEqual(harnessPortsOf({ OASIS_CODE_PORT: '9001', OASIS_CODE_DIRECTOR_PORT: '9002', OASIS_CODE_GATEWAY_PORT: '9004' }, 0), [9001, 9002, 9004])
  assert.equal(harnessAddress('http://127.0.0.1:8324/healthz', ports), true)
  for (const url of ['http://127.0.0.1:8321/api/approvals', 'http://localhost:8321/', 'http://[::1]:8322/x', 'http://127.0.0.2:8323/computer/act', 'ws://localhost:8321/ws', 'http://app.localhost:8321/', 'http://0.0.0.0:8321/', 'http://2130706433:8321/', 'http://localhost.:8321/api/approvals', 'http://127.0.0.1.:8321/']) {
    assert.equal(harnessAddress(url, ports), true, url)
  }
  for (const url of ['http://127.0.0.1:5173/', 'https://example.com:8321/', 'about:blank', 'not a url']) assert.equal(harnessAddress(url, ports), false, url)
})

test('test_agent_input_is_told_from_the_person_by_source_not_timing', () => {
  let t = 0
  const own = ownInput({ now: () => t })
  // key and wheel events carry their flags: the devtools protocol's own mark says they are the agent's
  assert.equal(own.heard({ type: 'keyDown', _modifiers: 1 << 23 }), true)
  assert.equal(own.heard({ type: 'rawKeyDown', _modifiers: (1 << 23) | 8 }), true)
  assert.equal(own.heard({ type: 'char', _modifiers: 0 }), false)                 // the person's key, even mid-action
  // a mouse event has none: the driver's own is one it has in flight
  assert.equal(own.heard({ type: 'mouseDown' }), false)
  const answered = own.expect(['mouseDown'])
  assert.equal(own.heard({ type: 'mouseDown' }), true)
  assert.equal(own.heard({ type: 'mouseDown' }), false)                           // a second press is not the driver's
  answered()
  const late = own.expect(['mouseUp'])
  late()
  t += 1_000
  assert.equal(own.heard({ type: 'mouseUp' }), false)                             // long after the dispatch answered: the person's
})

/** A page's debugger as Electron has it: one attach, events, commands. */
function fakeDebugger() {
  const dbg = new EventEmitter()
  dbg.attached = false
  dbg.attaches = 0
  dbg.refuse = null
  dbg.attach = () => { if (dbg.refuse) throw new Error(dbg.refuse); if (dbg.attached) throw new Error('Debugger is already attached to the target'); dbg.attached = true; dbg.attaches += 1 }
  dbg.detach = () => { dbg.attached = false }
  dbg.sent = []
  dbg.hang = new Set()
  dbg.sendCommand = (method, params) => { dbg.sent.push(method); return dbg.hang.has(method) ? new Promise(() => {}) : Promise.resolve({ method, params }) }
  return dbg
}

test('one protocol client per page: shared by its users, set up again after a detach, closed with the page', async () => {
  assert.equal(cdpOf({}), null)
  const dbg = fakeDebugger()
  const contents = { debugger: dbg }
  const a = cdpOf(contents)
  assert.equal(cdpOf(contents), a)                                                   // the tap and the computer share it
  const setups = []
  a.onAttach(() => setups.push('network'))
  assert.equal(a.attach(), true)
  assert.deepEqual(setups, ['network'])
  const heard = []
  const off = a.on((method) => heard.push(method))
  dbg.emit('message', {}, 'Page.loadEventFired', {})
  off()
  dbg.emit('message', {}, 'Page.loadEventFired', {})
  assert.deepEqual(heard, ['Page.loadEventFired'])
  const detached = []
  a.onDetach((reason) => detached.push(reason))
  dbg.attached = false
  dbg.emit('detach', {}, 'target closed')
  assert.deepEqual([a.attached(), detached], [false, ['target closed']])
  dbg.refuse = 'another client holds it'
  await assert.rejects(a.send('Page.enable'), CdpUnavailable)
  dbg.refuse = null
  await a.send('Page.enable')                                                       // attached again on the next command
  assert.deepEqual(setups, ['network', 'network'])
  assert.equal(dbg.attaches, 2)
  dbg.hang.add('Page.captureScreenshot')
  await assert.rejects(a.send('Page.captureScreenshot', {}, 20), /did not answer/)
  a.close()
  assert.equal(dbg.attached, false)
  assert.notEqual(cdpOf(contents), a)
})

test('a view shows on the card at its place, and lives backstage at its own size otherwise (hidden in the window when there is no backstage)', () => {
  const windowOf = () => {
    const children = []
    return { children, isDestroyed: () => false, contentView: { addChildView: (v) => children.push(v), removeChildView: (v) => children.splice(children.indexOf(v), 1) } }
  }
  const view = { visible: [], bounds: null, setVisible(v) { this.visible.push(v) }, setBounds(b) { this.bounds = b } }
  const main = windowOf()
  const back = windowOf()
  const stage = { window: () => back }
  const card = { x: 10, y: 20, width: 500, height: 400 }
  let at = seatView(view, { attachedTo: null, show: false, place: card, size: { width: 1280, height: 800 }, host: () => main, stage })
  assert.equal(at, back)
  assert.deepEqual([back.children.length, view.bounds, view.visible.at(-1)], [1, { x: 0, y: 0, width: 1280, height: 800 }, true])
  at = seatView(view, { attachedTo: at, show: true, place: card, size: { width: 1280, height: 800 }, host: () => main, stage })
  assert.deepEqual([at, back.children.length, main.children.length, view.bounds], [main, 0, 1, card])
  view.visible = []
  at = seatView(view, { attachedTo: at, show: false, place: card, size: { width: 1280, height: 800 }, host: () => main, stage: null })
  assert.equal(at, main)
  assert.deepEqual(view.visible, [true, false])                                   // shown for the moment of the resize
})

test('a click lands only where the element takes it: covered, it is refused with what covers it and a fresh look; never still, it is refused as unstable', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer, time } = computerOf({ browser: surface })
  const look = await computer.observe({ surface: 'browser', owner: 'run_1' })
  page.covered = 'div.modal "Accept cookies"'
  const covered = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', ref: 'e7', snapshot_id: look.snapshot_id })
  assert.equal(covered.status, 'covered')
  assert.equal(covered.covering, 'div.modal "Accept cookies"')
  assert.match(covered.reason, /covered at its middle by div.modal/)
  assert.ok(covered.snapshot_id && covered.outline)                                // a fresh look to go on
  assert.ok(!calls.some((c) => c[0] === 'click'))
  page.covered = null
  page.moving = (node) => ({ x: node * 10 + time() / 10, y: node * 5 })           // an animation that never ends
  const moving = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', ref: 'e7', snapshot_id: covered.snapshot_id })
  assert.equal(moving.status, 'unstable')
  assert.match(moving.reason, /did not hold still/)
  assert.ok(moving.snapshot_id && moving.outline)
  // a carousel that jumps every 200 ms is still for two samples at a time: never long enough
  page.moving = (node) => ({ x: node * 10 + (Math.floor(time() / 200) % 2) * 300, y: node * 5 })
  const carousel = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', ref: 'e7', snapshot_id: moving.snapshot_id })
  assert.equal(carousel.status, 'unstable')
  assert.ok(!calls.some((c) => c[0] === 'click'))
  page.moving = null
  const ok = await computer.act({ surface: 'browser', owner: 'run_1', action: 'type', ref: 'e4', text: 'x', snapshot_id: carousel.snapshot_id })
  assert.equal(ok.status, 'ok')
  assert.deepEqual(calls.filter((c) => c[0] === 'focus'), [['focus', 4]])         // the field focused if the click did not
})

test('test_click_hit_tests_the_point_right_before_the_press', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  const look = await computer.observe({ owner: 'run_1' })
  // still and clear while it is watched; an overlay comes in as the pointer gets there
  let tests = 0
  page.covered = () => ((tests += 1) > 1 ? 'div#ovl "Sale!"' : null)
  const out = await computer.act({ owner: 'run_1', action: 'click', ref: 'e7', snapshot_id: look.snapshot_id })
  assert.equal(out.status, 'covered')
  assert.match(out.reason, /nothing was pressed/)
  assert.ok(calls.some((c) => c[0] === 'pointer') && !calls.some((c) => c[0] === 'click'))
})

test('test_disabled_and_read_only_targets_are_not_actionable', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  let look = await computer.observe({ owner: 'run_1' })
  page.states[7] = { disabled: true, readonly: false, desc: 'button "Pay"' }
  const click = await computer.act({ owner: 'run_1', action: 'click', ref: 'e7', snapshot_id: look.snapshot_id })
  assert.deepEqual([click.status, click.reason], ['not_actionable', 'e7 (button "Pay") is disabled; nothing was done'])
  assert.ok(click.snapshot_id)
  page.states[4] = { disabled: false, readonly: true, desc: 'input#name' }
  const typed = await computer.act({ owner: 'run_1', action: 'type', ref: 'e4', text: 'x', snapshot_id: click.snapshot_id })
  assert.equal(typed.status, 'not_actionable')
  assert.match(typed.reason, /read-only/)
  page.states[4] = { disabled: true, readonly: false, desc: 'select#colour' }
  const picked = await computer.act({ owner: 'run_1', action: 'select', ref: 'e4', text: 'Blue', snapshot_id: typed.snapshot_id })
  assert.equal(picked.status, 'not_actionable')
  // x, y: what is at the point is asked
  page.at = () => ({ inside: null, disabled: true, desc: 'button#buy', other_site: false, control: null })
  look = await computer.observe({ owner: 'run_1' })
  const xy = await computer.act({ owner: 'run_1', action: 'click', x: 10, y: 10, snapshot_id: look.snapshot_id })
  assert.equal(xy.status, 'not_actionable')
  assert.ok(!calls.some((c) => c[0] === 'click' || c[0] === 'insertText'))
  // nothing was done: the look is still good for something else
  page.at = null
  assert.equal((await computer.act({ owner: 'run_1', action: 'hover', x: 10, y: 10, snapshot_id: look.snapshot_id })).status, 'ok')
})

test('test_type_says_where_the_text_went_and_how_much_landed; the caret goes to the end unless the field is cleared', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  page.active = { node: 4, desc: 'input#msg "Message"' }
  page.values[4] = 'acquisition memo'
  let look = await computer.observe({ owner: 'run_1' })
  const added = await computer.act({ owner: 'run_1', action: 'type', ref: 'e4', text: ' (draft)', snapshot_id: look.snapshot_id })
  assert.equal(added.status, 'ok')
  assert.deepEqual(added.done, { typed: 8, cleared: false, submitted: false, into: 'input#msg "Message"' })
  assert.equal(page.values[4], 'acquisition memo (draft)')
  assert.deepEqual(calls.filter((c) => c[0] === 'caretToEnd'), [['caretToEnd', 4]])
  const replaced = await computer.act({ owner: 'run_1', action: 'type', ref: 'e4', text: 'new', clear: true, snapshot_id: added.snapshot_id })
  assert.deepEqual(replaced.done, { typed: 3, cleared: true, submitted: false, into: 'input#msg "Message"' })
  assert.equal(calls.filter((c) => c[0] === 'caretToEnd').length, 1)
  // a field that takes nothing (a script holds its value): said, not counted as typed
  page.frozen = true
  const lost = await computer.act({ owner: 'run_1', action: 'type', ref: 'e4', text: 'abc', snapshot_id: replaced.snapshot_id })
  assert.equal(lost.status, 'not_actionable')
  assert.match(lost.reason, /did not land in input#msg/)
  assert.equal(lost.done.typed, 0)
  page.frozen = false
  // no target and no field focused: nothing is typed into the page itself
  page.active = { node: 1, desc: 'body' }
  look = await computer.observe({ owner: 'run_1' })
  const nowhere = await computer.act({ owner: 'run_1', action: 'type', text: 'abc', snapshot_id: look.snapshot_id })
  assert.equal(nowhere.status, 'not_actionable')
  assert.match(nowhere.reason, /no field has the focus/)
})

test('test_type_stops_when_the_person_comes_in_or_the_focus_leaves_and_says_what_was_done', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer, time } = computerOf({ browser: surface })
  page.active = { node: 4, desc: 'input#a' }
  page.values[4] = 'x'
  const look = await computer.observe({ owner: 'run_1' })
  // the person clicks into the page between the clearing and the typing
  page.hooks.clear = async () => { page.personAt = time() }
  const person = await computer.act({ owner: 'run_1', action: 'type', ref: 'e4', text: 'agent', clear: true, submit: true, snapshot_id: look.snapshot_id })
  assert.equal(person.status, 'person_active')
  assert.match(person.reason, /stopped before typing \(done so far: clicked the field, cleared it\)/)
  assert.deepEqual(person.done, { steps: ['clicked the field', 'cleared it'] })
  assert.ok(!calls.some((c) => c[0] === 'insertText' || c[0] === 'key'))
  assert.ok(person.snapshot_id)
  page.hooks.clear = null
  page.personAt = null
  // the person comes in as the driver is about to press Enter: Enter is not pressed
  page.hooks.keyStart = async () => { page.personAt = time() }
  const look1 = await computer.observe({ owner: 'run_1' })
  const late = await computer.act({ owner: 'run_1', action: 'type', ref: 'e4', text: 'agent', submit: true, snapshot_id: look1.snapshot_id })
  assert.equal(late.status, 'person_active')
  assert.deepEqual(late.done, { steps: ['clicked the field', 'typed 5 characters'] })
  assert.ok(!calls.some((c) => c[0] === 'key'))
  page.hooks.keyStart = null
  page.personAt = null
  // a page script moves the focus to another field as soon as this one has it
  page.focusHeld = () => false
  page.active = { node: 7, desc: 'input#other' }
  const look2 = await computer.observe({ owner: 'run_1' })
  const typedBefore = calls.filter((c) => c[0] === 'insertText').length
  const moved = await computer.act({ owner: 'run_1', action: 'type', ref: 'e4', text: 'agent', snapshot_id: look2.snapshot_id })
  assert.equal(moved.status, 'not_actionable')
  assert.match(moved.reason, /the focus left the field \(it is on input#other now\); stopped before typing \(done so far: clicked the field\)/)
  assert.equal(calls.filter((c) => c[0] === 'insertText').length, typedBefore)
})

test('test_wait_ends_when_the_person_uses_the_page', async () => {
  const { surface, page } = fakeSurface()
  const { computer, time } = computerOf({ browser: surface })
  await computer.observe({ owner: 'run_1' })
  let reads = 0
  page.hooks.words = async () => { reads += 1; if (reads === 3) page.personAt = time() }
  const waited = await computer.act({ owner: 'run_1', action: 'wait', text: 'READY', seconds: 60 })
  assert.equal(waited.status, 'person_active')
  assert.match(waited.reason, /during the wait/)
  assert.equal(waited.done.met, false)
  assert.ok(waited.snapshot_id && waited.outline)                                 // a fresh look: the person changed the page
  page.personAt = time()
  const plain = computer.act({ owner: 'run_1', action: 'wait', seconds: 5 })
  assert.equal((await plain).status, 'person_active')                            // the person was just there
})

test('test_queued_action_does_not_run_after_its_run_let_go_or_another_took_the_page', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer, tick, logs } = computerOf({ browser: surface })
  const look = await computer.observe({ owner: 'run_A' })
  let open
  page.treeGate = new Promise((r) => { open = r })
  const slow = computer.observe({ owner: 'run_A' })
  const click = computer.act({ owner: 'run_A', action: 'click', ref: 'e7', snapshot_id: look.snapshot_id })
  assert.deepEqual(computer.releaseOwner({ owner: 'run_A' }), { status: 'ok', released: ['browser'] })   // Stop
  page.treeGate = null
  open()
  await slow
  const out = await click
  assert.deepEqual([out.status, out.snapshot_id], ['cancelled', undefined])
  assert.match(out.reason, /nothing was done/)
  assert.ok(!calls.some((c) => c[0] === 'click'))
  assert.ok(logs.some((l) => /run_A's click on browser was dropped: the run no longer holds the page/.test(l)))
  // its lease ran out while it waited, and another run took the page
  const look2 = await computer.observe({ owner: 'run_A' })
  page.treeGate = new Promise((r) => { open = r })
  const slow2 = computer.observe({ owner: 'run_A' })
  const click2 = computer.act({ owner: 'run_A', action: 'click', ref: 'e7', snapshot_id: look2.snapshot_id })
  tick(91_000)
  const b = computer.observe({ owner: 'run_B' })
  page.treeGate = null
  open()
  await slow2
  assert.equal((await click2).status, 'cancelled')
  assert.equal((await b).status, 'ok')
  assert.equal(computer.holder('browser'), 'run_B')
  assert.ok(!calls.some((c) => c[0] === 'click'))
})

test('test_queued_action_is_dropped_when_its_request_closed', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer, logs } = computerOf({ browser: surface })
  const look = await computer.observe({ owner: 'run_A' })
  let open
  page.treeGate = new Promise((r) => { open = r })
  const slow = computer.observe({ owner: 'run_A' })
  let closed = false
  const click = computer.act({ owner: 'run_A', action: 'click', ref: 'e7', snapshot_id: look.snapshot_id }, { closed: () => closed })
  closed = true                                                                    // the backend's fetch was aborted (Stop)
  page.treeGate = null
  open()
  await slow
  assert.equal((await click).status, 'cancelled')
  assert.ok(!calls.some((c) => c[0] === 'click'))
  assert.ok(logs.some((l) => /run_A's click on browser was dropped: its request closed before it started/.test(l)))
  // over HTTP: the bridge says when the caller went away
  const seen = []
  const served = await serveBridge({ bridge: createBridge({ page: { opened: () => false }, token: 's' }), token: 's', port: 0, computer: {
    act: async (_body, { closed: gone }) => { await new Promise((r) => setTimeout(r, 150)); seen.push(gone()); return { status: 'ok' } },
  } })
  try {
    const abort = new AbortController()
    const call = fetch(`${served.url}/computer/act`, { method: 'POST', headers: { authorization: 'Bearer s', 'content-type': 'application/json' }, body: '{"owner":"r","action":"click"}', signal: abort.signal }).catch(() => null)
    await new Promise((r) => setTimeout(r, 40))
    abort.abort()
    await call
    await new Promise((r) => setTimeout(r, 200))
    assert.deepEqual(seen, [true])
  } finally { await served.close() }
})

test('test_an_action_done_is_said_as_done_when_the_look_after_it_fails', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer, logs } = computerOf({ browser: surface })
  const look = await computer.observe({ owner: 'run_1' })
  page.failShot = 2                                                                // the look after the click (and its retry) cannot be taken
  const out = await computer.act({ owner: 'run_1', action: 'click', ref: 'e7', snapshot_id: look.snapshot_id })
  assert.equal(out.status, 'ok')
  assert.deepEqual(out.done, { clicked: 'e7' })
  assert.match(out.look_failed, /did not answer within 15 s/)
  assert.equal(out.snapshot_id, undefined)
  assert.ok(logs.some((l) => /click was done; the look after it failed/.test(l)))
  // the retry a lost answer invites does not click again
  page.failShot = 0
  const retry = await computer.act({ owner: 'run_1', action: 'click', ref: 'e7', snapshot_id: look.snapshot_id })
  assert.equal(retry.status, 'stale')
  assert.equal(calls.filter((c) => c[0] === 'click').length, 1)
  // an action that fails after it began says so
  const look2 = await computer.observe({ owner: 'run_1' })
  page.hooks.key = async () => { throw new Error('Input.dispatchKeyEvent did not answer within 60 s') }
  const broke = await computer.act({ owner: 'run_1', action: 'key', keys: 'Enter', snapshot_id: look2.snapshot_id })
  assert.equal(broke.status, 'error')
  assert.match(broke.reason, /part of it may have been done; look before trying again/)
  assert.equal((await computer.act({ owner: 'run_1', action: 'key', keys: 'Enter', snapshot_id: look2.snapshot_id })).status, 'stale')
})

test('test_a_look_the_page_navigated_under_is_taken_again_or_kept_stale', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  // the page navigates once, between the screenshot and the outline: the look is taken again, and holds
  let jumps = 1
  page.hooks.screenshot = async () => { if (jumps > 0) { jumps -= 1; page.url = 'https://example.com/b'; page.generation += 1 } }
  const once = await computer.observe({ owner: 'run_1' })
  assert.equal(calls.filter((c) => c[0] === 'screenshot').length, 2)
  assert.equal(once.url, 'https://example.com/b')
  assert.equal((await computer.act({ owner: 'run_1', action: 'click', x: 10, y: 10, snapshot_id: once.snapshot_id })).status, 'ok')
  // a page that keeps moving under the look: the look is kept, but an action on it is stale
  page.hooks.screenshot = async () => { page.generation += 1 }
  const moving = await computer.observe({ owner: 'run_1' })
  page.hooks.screenshot = null
  const out = await computer.act({ owner: 'run_1', action: 'click', x: 10, y: 10, snapshot_id: moving.snapshot_id })
  assert.equal(out.status, 'stale')
  assert.equal(calls.filter((c) => c[0] === 'click').length, 1)
})

test('test_target_must_still_be_what_the_look_showed', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  const look = await computer.observe({ owner: 'run_1' })
  // the same node now reads differently (the record behind the button was swapped)
  page.ax[7] = { role: { value: 'link' }, name: { value: 'Delete everything' } }
  const swapped = await computer.act({ owner: 'run_1', action: 'click', ref: 'e7', snapshot_id: look.snapshot_id })
  assert.equal(swapped.status, 'stale')
  assert.equal(swapped.reason, 'e7 is not what that look showed (it was `- link "Terms \\"and\\" rules"`, it is `- link "Delete everything"` now); nothing was done')
  assert.ok(!calls.some((c) => c[0] === 'pointer'))
  // the focus moving onto it is no change
  page.ax[7] = { role: { value: 'link' }, name: { value: 'Terms "and" rules' }, properties: [{ name: 'focused', value: { value: true } }] }
  assert.equal((await computer.act({ owner: 'run_1', action: 'click', ref: 'e7', snapshot_id: swapped.snapshot_id })).status, 'ok')
})

test('test_x_y_actions_check_what_is_at_the_point_against_the_look', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  // the look had "Archive item 7" (e7) at page point (70, 34); x, y are the screenshot's (half the page)
  page.boxes = new Map([[7, { x: 60, y: 30, width: 20, height: 10 }], [3, { x: 0, y: 100, width: 50, height: 20 }]])
  let look = await computer.observe({ owner: 'run_1' })
  // the list was reordered: another button is at that point now
  page.at = (_x, _y, expected) => ({ inside: false, disabled: false, desc: 'button#l2 "Delete ALL items"', other_site: false, control: 3, expected })
  const reordered = await computer.act({ owner: 'run_1', action: 'click', x: 35, y: 17, snapshot_id: look.snapshot_id })
  assert.equal(reordered.status, 'stale')
  assert.match(reordered.reason, /the look had `- link "Terms \\"and\\" rules"`; the page has button#l2 "Delete ALL items" there now/)
  // a control came where the look had none (a banner pushed it there)
  look = reordered
  page.at = () => ({ inside: null, disabled: false, desc: 'a#promo "Buy now"', other_site: false, control: 501 })
  const banner = await computer.act({ owner: 'run_1', action: 'click', x: 300, y: 250, snapshot_id: look.snapshot_id })
  assert.equal(banner.status, 'stale')
  assert.match(banner.reason, /a#promo "Buy now", which that look did not have there/)
  assert.ok(!calls.some((c) => c[0] === 'click'))
  // the same element as the look's, or nothing of note: clicked
  page.at = (_x, _y, expected) => ({ inside: expected === 7, disabled: false, desc: 'a', other_site: false, control: 7 })
  const same = await computer.act({ owner: 'run_1', action: 'click', x: 35, y: 17, snapshot_id: banner.snapshot_id })
  assert.equal(same.status, 'ok')
  page.at = () => ({ inside: null, disabled: false, desc: 'div#canvas', other_site: false, control: null })
  const blank = await computer.act({ owner: 'run_1', action: 'click', x: 300, y: 250, snapshot_id: same.snapshot_id })
  assert.equal(blank.status, 'ok')
  // the page reflowed while the look was taken (a banner pushed the list down between the picture and the outline)
  page.layouts = [new Map([[7, { x: 60, y: 30, width: 20, height: 10 }]]), new Map([[7, { x: 60, y: 330, width: 20, height: 10 }]])]
  const moving = await computer.observe({ owner: 'run_1' })
  page.at = (_x, _y, expected) => ({ inside: expected === 7, disabled: false, desc: 'a', other_site: false, control: 7 })
  const moved = await computer.act({ owner: 'run_1', action: 'click', x: 35, y: 17, snapshot_id: moving.snapshot_id })
  assert.equal(moved.status, 'stale')
  assert.match(moved.reason, /moved at that point while that look was taken/)
  assert.equal(calls.filter((c) => c[0] === 'click').length, 2)
})

test('test_another_site_frame_that_did_not_get_the_click_is_not_ok', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  page.at = () => ({ inside: null, disabled: false, desc: 'iframe#ad', other_site: true, control: null })
  let got = false
  surface.open = ((open) => () => ({ ...open(), armOtherFrames: async () => async () => got }))(surface.open)
  const look = await computer.observe({ owner: 'run_1' })
  const missed = await computer.act({ owner: 'run_1', action: 'click', x: 100, y: 100, snapshot_id: look.snapshot_id })
  assert.equal(missed.status, 'not_actionable')
  assert.match(missed.reason, /frame did not receive it/)
  assert.deepEqual(missed.done, { clicked: { x: 200, y: 200 }, received: false })
  got = true
  assert.equal((await computer.act({ owner: 'run_1', action: 'click', x: 100, y: 100, snapshot_id: missed.snapshot_id })).status, 'ok')
  assert.equal(calls.filter((c) => c[0] === 'click').length, 2)
})

test('test_looks_are_bound_to_their_run_and_another_run_acting_makes_them_stale', async () => {
  const { surface, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  // two runs of one session: the page is not cleared between them
  const a = await computer.observe({ owner: 'run_A', session: 's1' })
  computer.releaseOwner({ owner: 'run_A' })
  const b = await computer.observe({ owner: 'run_B', session: 's1' })
  const theirs = await computer.act({ owner: 'run_B', action: 'click', ref: 'e7', snapshot_id: a.snapshot_id })
  assert.equal(theirs.status, 'stale')
  assert.match(theirs.reason, /another run's look/)
  assert.equal((await computer.act({ owner: 'run_B', action: 'type', ref: 'e4', text: '5000', snapshot_id: b.snapshot_id, session: 's1' })).status, 'ok')
  computer.releaseOwner({ owner: 'run_B' })
  // run_A comes back with its old look: another run typed on the page since
  const back = await computer.act({ owner: 'run_A', action: 'click', ref: 'e7', snapshot_id: a.snapshot_id, session: 's1' })
  assert.equal(back.status, 'stale')
  assert.match(back.reason, /another run acted on the page since that look/)
  assert.equal(calls.filter((c) => c[0] === 'click').length, 1)
})

test('test_browser_is_cleared_when_another_session_takes_it', async () => {
  const { surface, page } = fakeSurface()
  const { computer, logs, tick, time } = computerOf({ browser: surface })
  await computer.observe({ owner: 'run_A', session: 's1' })
  page.url = 'https://bank.example/account'
  computer.releaseOwner({ owner: 'run_A' })
  // another run of the same session: the page is still its own
  assert.equal((await computer.observe({ owner: 'run_A2', session: 's1' })).url, 'https://bank.example/account')
  computer.releaseOwner({ owner: 'run_A2' })
  // another session: a blank page before its first look, and it is told why
  const b = await computer.observe({ owner: 'run_B', session: 's2' })
  assert.equal(b.url, 'about:blank')
  assert.equal(page.resets, 1)
  assert.ok(b.notes.some((n) => /cleared to a blank page.*shared by every project and session/.test(n)))
  assert.ok(logs.some((l) => /cleared for run_B/.test(l)))
  computer.releaseOwner({ owner: 'run_B' })
  // the person opened a page for the next run on the card: it is theirs to hand over
  page.url = 'https://shop.example/'
  page.personAt = 5
  const c = await computer.observe({ owner: 'run_C', session: 's3' })
  assert.deepEqual([c.url, page.resets], ['https://shop.example/', 1])
  // the person used the page while run_C held it, and run_C's lease ran out: that was run_C's time, the page is cleared
  page.personAt = time()
  assert.equal((await computer.act({ owner: 'run_C', session: 's3', action: 'click', ref: 'e7', snapshot_id: c.snapshot_id })).status, 'person_active')
  tick(91_000)
  const d = await computer.observe({ owner: 'run_D', session: 's4' })
  assert.deepEqual([d.url, page.resets], ['about:blank', 2])
})

test('test_downloads_belong_to_the_run_that_held_the_page', async () => {
  const { surface, page } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  await computer.observe({ owner: 'run_A', session: 's1' })
  page.downloads.push({ owner: 'run_A', name: 'a-secret-report.csv', path: '/d/1-a.csv', bytes: 9 })
  page.doneBy.run_A = 1
  computer.releaseOwner({ owner: 'run_A' })
  assert.deepEqual(page.released, ['run_A'])                                       // its leftovers are dropped by the surface
  const b = await computer.observe({ owner: 'run_B', session: 's1' })
  assert.equal(b.downloads, undefined)
  const waited = await computer.act({ owner: 'run_B', action: 'wait', download: true, seconds: 2 })
  assert.equal(waited.done.met, false)                                             // another run's download meets no wait of B's
  page.doneBy.run_B = 1
  page.downloads.push({ owner: 'run_B', name: 'b.csv', path: '/d/2-b.csv', bytes: 3 })
  const got = await computer.act({ owner: 'run_B', action: 'wait', download: true, seconds: 2 })
  assert.equal(got.done.met, false)                                                // it finished before the wait began
  assert.deepEqual(got.downloads, [{ name: 'b.csv', path: '/d/2-b.csv', bytes: 3 }])   // named on B's own look
  // B's next download breaks off: its wait ends then, not at its seconds
  let asks = 0
  surface.downloadsFailed = (owner) => (owner === 'run_B' && asks++ > 1 ? 1 : 0)
  const broke = await computer.act({ owner: 'run_B', action: 'wait', download: true, seconds: 30 })
  assert.deepEqual([broke.done.met, broke.done.ended], [false, 'a download did not finish (the notes say why)'])
  assert.ok(broke.done.waited_s < 30)
})

test('test_a_page_never_shown_says_its_animations_may_not_run', async () => {
  const { surface, page } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  page.visibility = { shown: false, ever: false }
  assert.ok((await computer.observe({ owner: 'run_1' })).notes.some((n) => /never been shown on screen.*animations may not run/.test(n)))
  // shown once (on the card, or hidden again after), it keeps drawing: nothing to say
  page.visibility = { shown: false, ever: true }
  assert.deepEqual((await computer.observe({ owner: 'run_1' })).notes, [])
  page.visibility = { shown: true, ever: true }
  assert.deepEqual((await computer.observe({ owner: 'run_1' })).notes, [])
})

test('select picks an option by label or value; drag goes from a ref to x, y in the screenshot\'s pixels', async () => {
  const { surface, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  const look = await computer.observe({ surface: 'browser', owner: 'run_1' })
  const none = await computer.act({ surface: 'browser', owner: 'run_1', action: 'select', ref: 'e4', text: 'Mauve', snapshot_id: look.snapshot_id })
  assert.deepEqual([none.status, none.reason], ['refused', 'no option "Mauve"'])
  const picked = await computer.act({ surface: 'browser', owner: 'run_1', action: 'select', ref: 'e4', text: 'Blue', snapshot_id: look.snapshot_id })   // no option chosen: the look holds
  assert.deepEqual([picked.status, picked.done], ['ok', { selected: 'Blue' }])
  assert.equal((await computer.act({ surface: 'browser', owner: 'run_1', action: 'select', text: 'Blue', snapshot_id: picked.snapshot_id })).status, 'refused')
  const dragged = await computer.act({ surface: 'browser', owner: 'run_1', action: 'drag', ref: 'e7', to_x: 100, to_y: 50, snapshot_id: picked.snapshot_id })
  assert.equal(dragged.status, 'ok')
  assert.deepEqual(calls.filter((c) => c[0] === 'drag'), [['drag', 70, 35, 200, 100]])
  const nowhere = await computer.act({ surface: 'browser', owner: 'run_1', action: 'drag', ref: 'e7', snapshot_id: dragged.snapshot_id })
  assert.match(nowhere.reason, /where to drop/)
})

test('a wait for a condition is the host\'s: words that show or go, an element that goes, an address, a download; it ends when the run lets go', async () => {
  const { surface, page } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  const look = await computer.observe({ surface: 'browser', owner: 'run_1' })
  page.text = 'thinking…'
  let reads = 0
  page.hooks.words = async () => { reads += 1; if (reads === 4) page.text = 'The answer is 42' }
  const shown = await computer.act({ surface: 'browser', owner: 'run_1', action: 'wait', text: 'answer is 42', seconds: 120 })
  assert.deepEqual([shown.status, shown.done.met, shown.done.waited_s], ['ok', true, 1.5])
  page.hooks.words = null
  const gone = await computer.act({ surface: 'browser', owner: 'run_1', action: 'wait', text: 'thinking', gone: true, seconds: 5 })
  assert.equal(gone.done.met, true)
  const late = await computer.act({ surface: 'browser', owner: 'run_1', action: 'wait', text: 'never', seconds: 3 })
  assert.deepEqual([late.done.met, late.done.waited_s], [false, 3])
  const long = await computer.act({ surface: 'browser', owner: 'run_1', action: 'wait', text: 'never', seconds: 9999 })
  assert.equal(long.done.waited_s, 300)                                            // five minutes at most
  page.gone.add(7)
  const refGone = await computer.act({ surface: 'browser', owner: 'run_1', action: 'wait', ref: 'e7', snapshot_id: look.snapshot_id, seconds: 5 })
  assert.equal(refGone.done.met, true)
  page.url = 'https://example.com/done'
  assert.equal((await computer.act({ surface: 'browser', owner: 'run_1', action: 'wait', url: '/done', seconds: 5 })).done.met, true)
  let asked = 0
  surface.downloadsDone = (owner) => (owner === 'run_1' && asked++ > 1 ? 1 : 0)  // the download finishes while it waits
  const got = await computer.act({ surface: 'browser', owner: 'run_1', action: 'wait', download: true, seconds: 5 })
  assert.equal(got.done.met, true)
  // a run that lets go (it ended) ends its wait
  let begun
  const started = new Promise((r) => { begun = r })
  page.hooks.words = async () => begun()
  const waiting = computer.act({ surface: 'browser', owner: 'run_1', action: 'wait', text: 'never', seconds: 300 })
  await started
  computer.releaseOwner({ owner: 'run_1' })
  const ended = await waiting
  assert.equal(ended.done.met, false)
  assert.match(ended.done.ended, /let go/)
})

test('a look carries what happened since: downloads, the page\'s errors, frames (another site\'s named, not outlined), the scroll', async () => {
  const { surface, page } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  page.downloads.push({ owner: 'run_1', name: 'report.csv', path: '/data/computer-downloads/1-report.csv', bytes: 12 })
  page.console.push('uncaught: TypeError: x is undefined (http://localhost:5173/app.js:3)')
  const frameNodes = [{ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: '' }, childIds: ['2'], backendDOMNodeId: 90 }, { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Pay' }, childIds: [], backendDOMNodeId: 91 }]
  page.frames.push({ url: 'https://example.com/embed', nodes: frameNodes }, { url: 'https://ads.other.example/x', nodes: null })
  const look = await computer.observe({ surface: 'browser', owner: 'run_1' })
  assert.deepEqual(look.downloads, [{ name: 'report.csv', path: '/data/computer-downloads/1-report.csv', bytes: 12 }])
  assert.deepEqual(look.console, ['uncaught: TypeError: x is undefined (http://localhost:5173/app.js:3)'])
  assert.match(look.outline, /- frame "example.com"\n {2}- button "Pay" \[ref=e91\]/)
  assert.match(look.outline, /- frame "ads.other.example" \(another site's page: not outlined/)
  const clicked = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', ref: 'e91', snapshot_id: look.snapshot_id })
  assert.equal(clicked.status, 'ok')                                               // a frame's ref is the snapshot's too
  const again = await computer.observe({ surface: 'browser', owner: 'run_1' })
  assert.equal(again.downloads, undefined)                                         // said once
})

test('a page still loading is looked at once it has loaded; a wait reads the controls\' names too, and may name a ref of the latest look', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  page.loading = true
  const look = await computer.observe({ surface: 'browser', owner: 'run_1' })
  assert.equal(look.loading, false)
  assert.ok(calls.some((c) => c[0] === 'settle'))
  page.labels = ['停止']                                                          // a stop button: its name, not words on the page
  const still = await computer.act({ surface: 'browser', owner: 'run_1', action: 'wait', text: '停止', gone: true, seconds: 2 })
  assert.equal(still.done.met, false)
  page.gone.add(3)
  const refWait = await computer.act({ surface: 'browser', owner: 'run_1', action: 'wait', ref: 'e3', seconds: 5 })
  assert.deepEqual([refWait.status, refWait.done.met], ['ok', true])
  assert.equal((await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', ref: 'e7' })).status, 'stale')  // an input action still needs its look
})

/** A webContents as the surface adapter wires it (no debugger), and a download item of its session. */
function fakeContents() {
  const wc = new EventEmitter()
  wc.session = new EventEmitter()
  wc.isDestroyed = () => false
  return wc
}
function fakeDownload(name, total = 10) {
  const item = new EventEmitter()
  item.cancelled = false
  item.received = 0
  item.getFilename = () => name
  item.getTotalBytes = () => total
  item.getReceivedBytes = () => item.received
  item.setSavePath = (p) => { item.savePath = p }
  item.cancel = () => { item.cancelled = true }
  item.getMimeType = () => 'text/csv'
  item.getURL = () => `https://example.com/${name}`
  return item
}

test('test_surface_keeps_each_download_for_its_run_and_gives_up_the_rest', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-dl-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 })
  const wc = fakeContents()
  const logs = []
  let shown = false
  const surface = electronSurface({ label: 'browser', contents: () => wc, opened: () => true, allowsUrl: () => true, downloadsDir: dir, unheldDownloads: 'cancel', log: (l) => logs.push(l), visibility: () => ({ shown, ever: shown }) })
  let holder = 'run_A'
  surface.bindHolder(() => holder)
  surface.open()
  const finish = (item) => { fs.writeFileSync(item.savePath, 'x,y\n'); item.emit('done', {}, 'completed') }
  // A's download finishes after A let go of the page and B took it: B never sees it
  const a = fakeDownload('a-secret-report.csv')
  wc.session.emit('will-download', {}, a, wc)
  holder = 'run_B'
  finish(a)
  assert.equal(surface.downloadsDone('run_B'), 0)
  assert.deepEqual(surface.events('run_B').downloads, [])
  assert.equal(surface.downloadsDone('run_A'), 1)
  const kept = a.savePath
  surface.released('run_A')
  assert.equal(fs.existsSync(kept), false)                                         // dropped with A, never handed on
  // one on its way when its run lets go is cancelled
  const b = fakeDownload('b.csv')
  wc.session.emit('will-download', {}, b, wc)
  surface.released('run_B')
  assert.equal(b.cancelled, true)
  b.emit('done', {}, 'cancelled')
  assert.deepEqual(surface.events('run_B').notes, [])
  // one while nobody holds the page and the person is not on it: cancelled, and no agent is told (the next to look
  // may be another session's)
  holder = null
  const c = fakeDownload('c.csv')
  wc.session.emit('will-download', {}, c, wc)
  assert.deepEqual([c.cancelled, c.savePath], [true, undefined])
  assert.deepEqual(surface.events('run_C').notes, [])
  // the person's own, on the card: the browser's own way (their save dialog), and no agent is told either
  shown = true
  const mine = fakeDownload('mine.csv')
  wc.session.emit('will-download', {}, mine, wc)
  assert.deepEqual([mine.cancelled, mine.savePath], [false, undefined])
  assert.deepEqual(surface.events('run_C').notes, [])
  shown = false
  // ... and the person's own just after they used the page (a link they clicked), off the card too; a minute on, not
  wc.emit('input-event', {}, { type: 'mouseDown', modifiers: [] })
  const clicked = fakeDownload('clicked.csv')
  wc.session.emit('will-download', {}, clicked, wc)
  assert.equal(clicked.cancelled, false)
  t.mock.timers.tick(61_000)
  const later = fakeDownload('later.csv')
  wc.session.emit('will-download', {}, later, wc)
  assert.equal(later.cancelled, true)
  // interrupted: cancelled and said to its run
  holder = 'run_C'
  const d = fakeDownload('d.csv')
  wc.session.emit('will-download', {}, d, wc)
  d.emit('updated', {}, 'interrupted')
  assert.equal(d.cancelled, true)
  d.emit('done', {}, 'interrupted')
  assert.deepEqual(surface.events('run_C').notes, ['A download (d.csv) was interrupted (the connection broke off); it was cancelled.'])
  assert.deepEqual([surface.downloadsFailed('run_C'), surface.downloadsDone('run_C')], [1, 0])
  // stalled: given up after a minute without progress
  const e = fakeDownload('e.csv', 1_000)
  wc.session.emit('will-download', {}, e, wc)
  e.received = 10
  e.emit('updated', {}, 'progressing')
  t.mock.timers.tick(30_000)
  assert.equal(e.cancelled, false)
  t.mock.timers.tick(35_000)
  assert.equal(e.cancelled, true)
  assert.ok(surface.events('run_C').notes.some((n) => /made no progress for 60 s/.test(n)))
  // the finished one of its own run comes with its look, once
  const f = fakeDownload('f.csv')
  wc.session.emit('will-download', {}, f, wc)
  finish(f)
  assert.deepEqual(surface.events('run_C').downloads.map((x) => x.name), ['f.csv'])
  assert.deepEqual(surface.events('run_C').downloads, [])
})

test('a person may watch: the action going on and where the pointer went are kept per surface; watching takes and opens nothing', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer, tick } = computerOf({ browser: surface })
  assert.deepEqual(computer.watch('browser'), { surface: 'browser', holder: null, last: null, takes: 0, doing: null, pointer: null })
  assert.equal(computer.watch('nope'), null)
  assert.equal(computer.watch('constructor'), null)
  assert.equal(page.opened, false)                                                   // a watcher opens no page
  const look = await computer.observe({ surface: 'browser', owner: 'run_1' })
  // while an action runs the watcher reads what it is and what it is on
  let during = null
  const driver = surface.open()
  const click = driver.click
  driver.click = async (...args) => { during = computer.watch('browser'); return click(...args) }
  const done = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', ref: 'e3', snapshot_id: look.snapshot_id })
  assert.equal(done.status, 'ok')
  assert.deepEqual(during.doing, { action: 'click', target: 'e3', since: during.doing.since })
  assert.deepEqual([during.pointer.x, during.pointer.y, during.pointer.action], [30, 15, 'click'])   // the element's middle
  // between two actions nothing is going on; the pointer stays where it went
  const after = computer.watch('browser')
  assert.deepEqual([after.holder, after.doing, after.pointer.x, after.pointer.y], ['run_1', null, 30, 15])
  // x and y are the screenshot's pixels: the pointer is kept in the page's own
  const hovered = await computer.act({ surface: 'browser', owner: 'run_1', action: 'hover', x: 100, y: 50, snapshot_id: done.snapshot_id })
  assert.deepEqual([computer.watch('browser').pointer.x, computer.watch('browser').pointer.y, computer.watch('browser').pointer.action], [200, 100, 'hover'])
  // an action that names no point leaves the pointer; a refused one is not going on (each action on the look the one
  // before it came back with: a look is used up by its action)
  const typed = await computer.act({ surface: 'browser', owner: 'run_1', action: 'type', text: 'hello', snapshot_id: hovered.snapshot_id })
  assert.equal(typed.status, 'ok')
  assert.equal(computer.watch('browser').pointer.action, 'hover')
  const refused = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', ref: 'e999', snapshot_id: typed.snapshot_id })
  assert.equal(refused.status, 'refused')
  assert.equal(computer.watch('browser').doing, null)
  // a model slow to answer outlasts the quiet lease: nobody holds the page, the pointer is still the run's — and stays
  // its own when it takes the page again; another run starts without one
  tick(91_000)
  assert.deepEqual([computer.watch('browser').holder, computer.watch('browser').pointer.action], [null, 'hover'])
  await computer.observe({ surface: 'browser', owner: 'run_1' })
  assert.equal(computer.watch('browser').pointer.action, 'hover')
  tick(91_000)
  await computer.observe({ surface: 'browser', owner: 'run_2' })
  assert.deepEqual([computer.watch('browser').holder, computer.watch('browser').pointer], ['run_2', null])
  assert.ok(calls.some((c) => c[0] === 'click'))
})

test('who held the page last stays after its lease runs out and after it lets go; letting go clears its pointer and action', async () => {
  const { surface } = fakeSurface()
  const { computer, tick } = computerOf({ browser: surface })
  const look = await computer.observe({ surface: 'browser', owner: 'run_1', session: 's_1' })
  await computer.act({ surface: 'browser', owner: 'run_1', session: 's_1', action: 'hover', x: 10, y: 10, snapshot_id: look.snapshot_id })
  assert.deepEqual(computer.watch('browser').last, { owner: 'run_1', party: 'session:s_1' })
  assert.equal(computer.watch('browser').takes, 1)
  // a quiet lease run out: nobody holds it, it was the run's last, its pointer stays (it may come back)
  tick(91_000)
  assert.deepEqual([computer.watch('browser').holder, computer.watch('browser').last.owner, computer.watch('browser').pointer.action], [null, 'run_1', 'hover'])
  // another session's run takes it: the last holder is that run, the count of takes goes up
  await computer.observe({ surface: 'browser', owner: 'run_2', session: 's_2' })
  assert.deepEqual([computer.watch('browser').last, computer.watch('browser').takes], [{ owner: 'run_2', party: 'session:s_2' }, 2])
  const again = await computer.observe({ surface: 'browser', owner: 'run_2', session: 's_2' })
  assert.equal(computer.watch('browser').takes, 2)                                    // the same holder takes nothing new
  await computer.act({ surface: 'browser', owner: 'run_2', session: 's_2', action: 'hover', x: 20, y: 20, snapshot_id: again.snapshot_id })
  assert.equal(computer.watch('browser').pointer.action, 'hover')
  // the run ends: nobody holds the page, it was run_2's last, and its pointer and action are gone with it
  assert.deepEqual(computer.releaseOwner({ owner: 'run_2' }), { status: 'ok', released: ['browser'] })
  const after = computer.watch('browser')
  assert.deepEqual([after.holder, after.last, after.pointer, after.doing], [null, { owner: 'run_2', party: 'session:s_2' }, null, null])
})

test("a point past the picture's right or bottom edge is refused; one inside it lands", async () => {
  const { surface, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  // the page is 1000×600, its picture 500×300
  const look = await computer.observe({ surface: 'browser', owner: 'run_1' })
  for (const [x, y] of [[500, 10], [10, 300], [900, 10], [10, 590]]) {
    const out = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x, y, snapshot_id: look.snapshot_id })
    assert.equal(out.status, 'refused', `${x},${y}`)
    assert.match(out.reason, /outside the screenshot \(500×300 pixels\)/)
  }
  const drag = await computer.act({ surface: 'browser', owner: 'run_1', action: 'drag', x: 10, y: 10, to_x: 600, to_y: 10, snapshot_id: look.snapshot_id })
  assert.equal(drag.status, 'refused')
  assert.match(drag.reason, /where to drop .* is outside the screenshot/)
  assert.ok(!calls.some((c) => ['click', 'drag', 'pointer'].includes(c[0])))
  const hovered = await computer.act({ surface: 'browser', owner: 'run_1', action: 'hover', x: 499, y: 299, snapshot_id: look.snapshot_id })
  assert.equal(hovered.status, 'ok')
  assert.deepEqual(calls.filter((c) => c[0] === 'move').at(-1), ['move', 998, 598])
})

test("the live frame: no picture the page changed hands during (the bridge took it for a send while it was taken), none while the bridge holds it", async () => {
  const { surface } = fakeSurface()
  const { computer } = computerOf({ chatgpt: surface })
  let gate = null
  const live = { frame: async () => { if (gate) await gate.promise; return { url: 'https://chatgpt.com/', title: 'ChatGPT', loading: false, viewport: { width: 1000, height: 600 }, image: { media_type: 'image/jpeg', data_base64: 'AAAA', width: 500, height: 300 } } } }
  await computer.observe({ surface: 'chatgpt', owner: 'run_1', session: 's_1' })
  const shown = await liveFrame(computer, 'chatgpt', live)
  assert.deepEqual([shown.holder, shown.last, shown.image.width, 'takes' in shown], ['run_1', { owner: 'run_1', party: 'session:s_1' }, 500, false])
  computer.releaseOwner({ owner: 'run_1' })
  // the bridge takes the page while the picture is being taken
  let open
  gate = { promise: new Promise((r) => { open = r }) }
  const pending = liveFrame(computer, 'chatgpt', live)
  computer.claim('chatgpt', BRIDGE_OWNER)
  open()
  const raced = await pending
  assert.deepEqual([raced.holder, raced.image], [BRIDGE_OWNER, null])
  // taken and let go again during the picture: still none (it may show the send)
  computer.release('chatgpt', BRIDGE_OWNER)
  gate = { promise: new Promise((r) => { open = r }) }
  const between = liveFrame(computer, 'chatgpt', live)
  computer.claim('chatgpt', BRIDGE_OWNER)
  computer.release('chatgpt', BRIDGE_OWNER)
  open()
  assert.deepEqual([(await between).holder, (await between).last.owner, (await between).image], [null, BRIDGE_OWNER, null])
  // while the bridge holds the page none is taken at all
  gate = null
  computer.claim('chatgpt', BRIDGE_OWNER)
  let asked = 0
  const counted = { frame: async () => { asked += 1; return live.frame() } }
  assert.equal((await liveFrame(computer, 'chatgpt', counted)).image, null)
  assert.equal(asked, 0)
})

/** The head of a JPEG of this size (its frame header is what jpegSize reads). */
function jpegOf(width, height) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9])
}

/** A page as Electron gives it, as far as the surface asks: its debugger answers the protocol's commands. */
function fakeDebuggedContents() {
  const wc = new EventEmitter()
  const dbg = fakeDebugger()
  wc.debugger = dbg
  wc.shots = 0
  wc.destroyed = false
  dbg.sendCommand = async (method, params) => {
    dbg.sent.push(method)
    if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800, pageX: 0, pageY: 0 }, cssContentSize: { width: 1280, height: 2000 } }
    if (method === 'Runtime.evaluate') return { result: { value: 2 } }
    if (method === 'Page.captureScreenshot') { wc.shots += 1; wc.clip = params.clip; wc.quality = params.quality; await new Promise((r) => setImmediate(r)); return { data: wc.shotData ?? 'AAAA' } }
    return {}
  }
  wc.getURL = () => 'https://example.com/'
  wc.getTitle = () => 'Example'
  wc.isLoading = () => false
  wc.isDestroyed = () => wc.destroyed
  return wc
}

test('the live picture: a lighter look at a page an agent opened, one capture at a time; never of a page not opened, or one a dialog holds', async () => {
  const wc = fakeDebuggedContents()
  let opened = false
  let made = 0
  // Electron's nativeImage as far as a picture made smaller goes
  const resized = []
  const nativeImage = { createFromBuffer: () => ({ resize: (to) => { resized.push(to); return { toJPEG: (quality) => Buffer.from(`small@${quality}`) } } }) }
  const surface = electronSurface({ label: 'fake', contents: () => { made += 1; opened = true; return wc }, opened: () => opened, allowsUrl: browserAllows, nativeImage })
  // the page draws at the screen's pixels: a 1280 x 800 viewport on a Retina screen is a 2560 x 1600 picture
  wc.shotData = jpegOf(2560, 1600).toString('base64')
  assert.equal(await surface.frame(), null)
  assert.equal(made, 0)                                                              // watching opens nothing
  surface.open()
  const [a, b] = await Promise.all([surface.frame(), surface.frame()])
  assert.equal(a, b)                                                                 // two askers, one capture
  assert.equal(wc.shots, 1)
  assert.deepEqual([a.url, a.title, a.loading, a.viewport], ['https://example.com/', 'Example', false, { width: 1280, height: 800 }])
  // the page is asked for its picture as it draws itself — no clip, no scale: a scaled one makes the page shrink and
  // grow back before the person's eyes — and the picture keeps the page's own pixels for a person's eyes (a Retina
  // screen shows the thread's window at two per CSS pixel), made smaller here only past 1920 on its longest side
  assert.deepEqual([wc.clip, wc.quality], [undefined, 90])
  assert.deepEqual(resized, [{ width: 1920, height: 1200, quality: 'good' }])
  assert.deepEqual([a.image.media_type, Buffer.from(a.image.data_base64, 'base64').toString(), a.image.width, a.image.height], ['image/jpeg', 'small@70', 1920, 1200])
  assert.ok(!wc.debugger.sent.includes('Runtime.evaluate'))
  assert.equal(surface.generation(), 1)                                              // a picture is nobody's input: no look goes stale
  await surface.frame()
  assert.equal(wc.shots, 2)
  // a JavaScript dialog holds the page: it answers nothing, so nothing is asked
  wc.debugger.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'alert', message: 'hi' })
  assert.equal(await surface.frame(), null)
  wc.debugger.emit('message', {}, 'Page.javascriptDialogClosed', {})
  assert.ok(await surface.frame())
  wc.destroyed = true
  assert.equal(await surface.frame(), null)
  assert.equal(wc.shots, 3)
})

test('test_x_y_on_a_look_without_a_screenshot_is_checked_and_a_layout_not_read_takes_no_point', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  // a look without a picture still reads where things are: "Archive item 7" (e7) at page point (70, 34)
  page.boxes = new Map([[7, { x: 60, y: 30, width: 20, height: 10 }], [3, { x: 0, y: 100, width: 50, height: 20 }]])
  const bare = await computer.observe({ owner: 'run_1', screenshot: false })
  assert.equal(bare.image, null)
  // the list was reordered under it: another button is at that point now
  page.at = (_x, _y, expected) => ({ inside: false, disabled: false, desc: 'button#l2 "Delete ALL items"', other_site: false, control: 3, expected })
  const reordered = await computer.act({ owner: 'run_1', action: 'click', x: 70, y: 34, snapshot_id: bare.snapshot_id, screenshot: false })
  assert.equal(reordered.status, 'stale')
  assert.match(reordered.reason, /the page has button#l2 "Delete ALL items" there now/)
  // a look whose layout could not be read: no x, y on it (a ref still goes)
  surface.open = ((open) => () => ({ ...open(), layout: async () => { throw new Error('DOMSnapshot.captureSnapshot did not answer') } }))(surface.open)
  page.at = (_x, _y, expected) => ({ inside: expected === 7, disabled: false, desc: 'a', other_site: false, control: 7 })
  const unread = await computer.observe({ owner: 'run_1' })
  const refused = await computer.act({ owner: 'run_1', action: 'click', x: 35, y: 17, snapshot_id: unread.snapshot_id })
  assert.equal(refused.status, 'stale')
  assert.match(refused.reason, /could not be read when that look was taken/)
  assert.ok(!calls.some((c) => c[0] === 'click'))
  assert.equal((await computer.act({ owner: 'run_1', action: 'click', ref: 'e7', snapshot_id: refused.snapshot_id })).status, 'ok')
})

test('test_refused_action_leaves_another_sessions_page_and_one_that_goes_ahead_clears_it', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  // session 1's run looked and proposed a click; session 2 used the page since
  const a = await computer.observe({ owner: 'run_A', session: 's1' })
  computer.releaseOwner({ owner: 'run_A' })
  await computer.observe({ owner: 'run_B', session: 's2' })
  page.url = 'https://mail.example/inbox'
  computer.releaseOwner({ owner: 'run_B' })
  const resets = page.resets
  // the approval of run_A's click comes now: its look is stale, and session 2's page is neither cleared nor shown
  const stale = await computer.act({ owner: 'run_A', session: 's1', action: 'click', ref: 'e7', snapshot_id: a.snapshot_id })
  assert.equal(stale.status, 'stale')
  assert.equal(page.resets, resets)
  assert.deepEqual([stale.url, stale.snapshot_id, stale.outline], [undefined, undefined, undefined])
  assert.equal(page.url, 'https://mail.example/inbox')
  computer.releaseOwner({ owner: 'run_A' })
  // an action that goes ahead (no look to check) clears it first
  const went = await computer.act({ owner: 'run_C', session: 's3', action: 'navigate', url: 'https://example.org/' })
  assert.equal(went.status, 'ok')
  assert.equal(page.resets, resets + 1)
  assert.ok(calls.some((c) => c[0] === 'navigate'))
})

test('test_a_target_gone_from_the_page_is_stale_not_an_error', async () => {
  const { surface, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  const look = await computer.observe({ owner: 'run_1' })
  // the element was removed: the protocol knows no such node any more
  surface.open = ((open) => () => ({ ...open(), state: async () => { throw new Error('No node with given id found') } }))(surface.open)
  const gone = await computer.act({ owner: 'run_1', action: 'click', ref: 'e7', snapshot_id: look.snapshot_id })
  assert.equal(gone.status, 'stale')
  assert.match(gone.reason, /e7 is no longer on the page; nothing was done/)
  surface.open = ((open) => () => ({ ...open(), axNode: async () => { throw new Error('No node with given id found') } }))(surface.open)
  const vanished = await computer.act({ owner: 'run_1', action: 'type', ref: 'e4', text: 'x', snapshot_id: gone.snapshot_id })
  assert.equal(vanished.status, 'stale')
  assert.match(vanished.reason, /e4 is no longer on the page/)
  assert.ok(!calls.some((c) => c[0] === 'click' || c[0] === 'insertText'))
})

test('test_file_chooser_is_intercepted_around_the_agents_press_and_never_offered_after_the_persons_input', async () => {
  const wc = fakeDebuggedContents()
  wc.session = new EventEmitter()
  const surface = electronSurface({ label: 'fake', contents: () => wc, opened: () => true, allowsUrl: browserAllows })
  const driver = surface.open()
  const sent = wc.debugger.sent
  const intercepts = () => sent.filter((m) => m === 'Page.setInterceptFileChooserDialog').length
  const chooserOpens = () => wc.debugger.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 42, mode: 'selectSingle' })
  // the agent's press opens one: interception goes on only once the pointer went there, and the chooser is the agent's
  let order = null
  await driver.click(10, 10, { beforePress: async () => { order = [sent.lastIndexOf('Input.dispatchMouseEvent'), sent.lastIndexOf('Page.setInterceptFileChooserDialog')]; chooserOpens() } })
  assert.ok(order[0] >= 0 && order[0] < order[1])
  assert.equal(intercepts(), 2)
  assert.deepEqual(surface.peek().chooser, { node: 42, mode: 'selectSingle' })
  surface.chooserUsed()
  chooserOpens()                                                                        // outside any press: not the agent's
  assert.equal(surface.peek().chooser, null)
  // the person clicks their own upload button in the moment of the agent's press: theirs, never offered to the agent
  await driver.click(10, 10, { beforePress: async () => { wc.emit('input-event', {}, { type: 'mouseDown', modifiers: [] }); chooserOpens() } })
  assert.equal(surface.peek().chooser, null)
  // a press the caller stopped (its last word threw) still ends the interception
  const before = intercepts()
  await assert.rejects(driver.click(10, 10, { beforePress: async () => { throw new Error('person_active') } }), /person_active/)
  assert.equal(intercepts(), before + 2)
})

test('test_type_that_did_not_land_is_not_ok_when_the_field_already_held_the_text', async () => {
  const { surface, page } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  page.active = { node: 4, desc: 'input#code' }
  // a full field (maxlength), or one a script holds: "abcde" takes nothing of "abc", though it holds "abc" already
  page.values[4] = 'abcde'
  page.frozen = true
  const look = await computer.observe({ owner: 'run_1' })
  const full = await computer.act({ owner: 'run_1', action: 'type', ref: 'e4', text: 'abc', snapshot_id: look.snapshot_id })
  assert.equal(full.status, 'not_actionable')
  assert.match(full.reason, /did not land in input#code/)
  assert.equal(full.done.typed, 0)
  page.frozen = false
  // typed and landed, the same text once more: ok
  const twice = await computer.act({ owner: 'run_1', action: 'type', ref: 'e4', text: 'abc', snapshot_id: full.snapshot_id })
  assert.deepEqual([twice.status, twice.done.typed, page.values[4]], ['ok', 3, 'abcdeabc'])
})

test('test_type_at_x_y_into_a_read_only_field_is_not_actionable', async () => {
  const { surface, page, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  page.boxes = new Map([[4, { x: 0, y: 0, width: 200, height: 40 }]])
  page.at = (_x, _y, expected) => ({ inside: expected === 4, disabled: false, readonly: true, desc: 'input#fixed', other_site: false, control: 4 })
  const look = await computer.observe({ owner: 'run_1' })
  const out = await computer.act({ owner: 'run_1', action: 'type', x: 20, y: 10, text: 'fix', snapshot_id: look.snapshot_id })
  assert.equal(out.status, 'not_actionable')
  assert.match(out.reason, /input#fixed\) is read-only; nothing was done/)
  assert.ok(!calls.some((c) => c[0] === 'click' || c[0] === 'insertText'))
  // a click there is no typing: it goes
  assert.equal((await computer.act({ owner: 'run_1', action: 'click', x: 20, y: 10, snapshot_id: out.snapshot_id })).status, 'ok')
})

test('test_click_under_a_pinned_header_scrolls_it_clear_once_and_refuses_what_still_covers_it', async () => {
  const { surface, calls } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  let centred = 0
  let pinnedAfter = false
  surface.open = ((open) => () => ({
    ...open(),
    centre: async (node) => { calls.push(['centre', node]); centred += 1 },
    hitTest: async () => (centred && !pinnedAfter ? { ok: true } : { ok: false, covering: 'header#top', pinned: true }),
  }))(surface.open)
  const look = await computer.observe({ owner: 'run_1' })
  const clicked = await computer.act({ owner: 'run_1', action: 'click', ref: 'e7', snapshot_id: look.snapshot_id })
  assert.equal(clicked.status, 'ok')
  assert.deepEqual(calls.filter((c) => c[0] === 'centre'), [['centre', 7]])
  // still under it in the middle (a header as tall as the view): covered, scrolled once only
  pinnedAfter = true
  centred = 0
  const covered = await computer.act({ owner: 'run_1', action: 'click', ref: 'e7', snapshot_id: clicked.snapshot_id })
  assert.equal(covered.status, 'covered')
  assert.equal(centred, 1)
  // what covers it is not pinned (a modal on the page): never scrolled
  const { surface: s2, calls: c2 } = fakeSurface()
  const { computer: k2 } = computerOf({ browser: s2 })
  s2.open = ((open) => () => ({ ...open(), centre: async () => { c2.push(['centre']) }, hitTest: async () => ({ ok: false, covering: 'div#modal', pinned: false }) }))(s2.open)
  const l2 = await k2.observe({ owner: 'run_1' })
  assert.equal((await k2.act({ owner: 'run_1', action: 'click', ref: 'e7', snapshot_id: l2.snapshot_id })).status, 'covered')
  assert.ok(!c2.some((c) => c[0] === 'centre'))
})

test("the person clears the agent browser's data only while no run holds it; a run that takes it meanwhile looks after the clear", async () => {
  const { surface } = fakeSurface()
  const { computer, tick } = computerOf({ browser: surface })
  const done = []
  let release = null
  const browser = { clearData: async () => { done.push('clear start'); await new Promise((r) => { release = r }); done.push('clear end') } }
  // a run holds the browser: refused, nothing cleared
  await computer.observe({ surface: 'browser', owner: 'run_1' })
  const refused = await clearBrowserData({ computer, browser })
  assert.deepEqual([refused.cleared, refused.holder], [false, 'run_1'])
  assert.match(refused.reason, /in use by run_1/)
  assert.deepEqual(done, [])
  // let go: cleared; a run that takes the page while the clear goes looks only after it
  computer.releaseOwner({ owner: 'run_1' })
  const clearing = clearBrowserData({ computer, browser })
  await new Promise((r) => setImmediate(r))
  const look = computer.observe({ surface: 'browser', owner: 'run_2' }).then((l) => { done.push(`look ${l.status}`) })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(done, ['clear start'])
  release()
  assert.deepEqual(await clearing, { cleared: true })
  await look
  assert.deepEqual(done, ['clear start', 'clear end', 'look ok'])
  // run_2's lease ran out: nobody holds the browser, a clear goes
  tick(200_000)
  assert.deepEqual(await clearBrowserData({ computer, browser: { clearData: async () => undefined } }), { cleared: true })
})

test("a clear that waited its turn behind a run's look is refused when a run took the browser meanwhile", async () => {
  const { surface, page } = fakeSurface()
  const { computer } = computerOf({ browser: surface })
  let open = null
  page.hooks.screenshot = () => new Promise((r) => { open = r })
  // run_1's look is under way; it lets go, the clear waits its turn, and run_2 takes the page before the clear's turn
  const first = computer.observe({ surface: 'browser', owner: 'run_1' })
  await new Promise((r) => setImmediate(r))
  computer.releaseOwner({ owner: 'run_1' })
  let cleared = false
  const clearing = clearBrowserData({ computer, browser: { clearData: async () => { cleared = true } } })
  const second = computer.observe({ surface: 'browser', owner: 'run_2' })
  page.hooks.screenshot = null
  open()
  await first
  const out = await clearing
  await second
  assert.deepEqual([out.cleared, out.holder, cleared], [false, 'run_2', false])
})

test("the agent browser's data is cleared on its profile also before its page opened: storage, cache, sign-ins", async () => {
  const cleared = []
  const profile = { clearStorageData: async () => { cleared.push('storage') }, clearCache: async () => { cleared.push('cache') }, clearAuthCache: async () => { cleared.push('auth') } }
  const browser = agentBrowser({ WebContentsView: class {}, host: () => null, profile: () => profile })
  await browser.clearData()
  assert.deepEqual(cleared, ['storage', 'cache', 'auth'])
  assert.equal(browser.opened(), false)                                                  // clearing opens no page
  await assert.rejects(agentBrowser({ WebContentsView: class {}, host: () => null }).clearData(), /profile is not available/)
})

test("a card's place that keeps changing is logged with its last places, once in a while; a settled card says nothing", () => {
  const lines = []
  let t = 0
  const watch = placementWatch({ log: (line) => lines.push(line), now: () => t })
  // a card dragged once: a few places, then still
  for (let i = 0; i < 6; i++) { t += 16; watch({ x: 10 + i, y: 20, width: 600, height: 400, visible: true }) }
  t += 5_000; watch({ x: 16, y: 20, width: 600, height: 400, visible: true })
  assert.deepEqual(lines, [])
  // a layout that does not settle: two sizes in turn, every frame
  for (let i = 0; i < 40; i++) { t += 50; watch(i % 2 ? { x: 10, y: 20, width: 900, height: 700, visible: true } : { x: 10, y: 20, width: 420, height: 330, visible: false }) }
  assert.equal(lines.length, 1)
  assert.match(lines[0], /changed \d+ times in 2 s/)
  assert.match(lines[0], /10,20 900x700/)
  assert.match(lines[0], /hidden 10,20 420x330/)
  // still unsettled ten seconds on: said again
  for (let i = 0; i < 220; i++) { t += 50; watch({ x: 10, y: 20, width: i % 2 ? 900 : 420, height: 700, visible: true }) }
  assert.equal(lines.length, 2)
})

test('at the three widths a card shows (480, 800, 1120) and one past 1280: a look is the viewport made at most 1280 on its longest side; a click at x, y of the picture lands at its ratio, x and y each; typing goes into the field', async () => {
  // replaces 2026-10-16's "lives backstage at its own size … drawn smaller, never laid out narrower": the page is now laid
  // out at the card's own size (docs/browser-native-pane-report.md); the agent's coordinates follow the picture
  const { surface, page, calls } = fakeSurface()
  const driver = surface.open()
  driver.screenshot = async ({ width, height }) => {
    const fit = Math.min(1, 1280 / Math.max(width, height))
    return { media_type: 'image/jpeg', data_base64: 'AAAA', width: Math.round(width * fit), height: Math.round(height * fit) }
  }
  const { computer } = computerOf({ browser: surface })
  for (const [viewport, picture] of [[{ width: 480, height: 600 }, [480, 600]], [{ width: 800, height: 520 }, [800, 520]], [{ width: 1120, height: 700 }, [1120, 700]], [{ width: 1560, height: 900 }, [1280, 738]]]) {
    page.viewport = viewport
    calls.length = 0
    const look = await computer.observe({ surface: 'browser', owner: 'run_1' })
    assert.deepEqual([look.viewport, look.image.width, look.image.height], [viewport, ...picture])
    const clicked = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 400, y: 300, snapshot_id: look.snapshot_id })
    assert.equal(clicked.status, 'ok')
    assert.deepEqual(calls.filter((c) => c[0] === 'click'), [['click', 400 * (viewport.width / picture[0]), 300 * (viewport.height / picture[1]), 'left', 1]])
    const typed = await computer.act({ surface: 'browser', owner: 'run_1', action: 'type', ref: 'e4', text: 'hello', snapshot_id: clicked.snapshot_id })
    assert.equal(typed.status, 'ok')
    assert.deepEqual(calls.filter((c) => c[0] === 'insertText'), [['insertText', 'hello']])
    // a point past the picture is refused, whatever the viewport
    const past = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: picture[0], y: 1, snapshot_id: typed.snapshot_id })
    assert.equal(past.status, 'refused')
  }
})


test('a look carries its display picture separately and coordinate clicks still use the agent picture', async () => {
  const { surface, calls } = fakeSurface()
  const display = { media_type: 'image/jpeg', data_base64: 'HD', width: 2000, height: 1200 }
  surface.open().screenshot = async (_viewport, options) => {
    return { media_type: 'image/jpeg', data_base64: 'AGENT', width: 500, height: 300, ...(options?.displayImage ? { display_image: display } : {}) }
  }
  const { computer } = computerOf({ browser: surface })
  const look = await computer.observe({ surface: 'browser', owner: 'run_1' })
  assert.equal(look.status, 'ok')
  assert.deepEqual(look.display_image, display)
  assert.equal('display_image' in look.image, false)
  const clicked = await computer.act({ surface: 'browser', owner: 'run_1', action: 'click', x: 100, y: 50, snapshot_id: look.snapshot_id })
  assert.equal(clicked.status, 'ok')
  assert.deepEqual(calls.find((call) => call[0] === 'click'), ['click', 200, 100, 'left', 1])
  const bare = await computer.observe({ surface: 'browser', owner: 'run_1', screenshot: false })
  assert.equal('display_image' in bare, false)
})
