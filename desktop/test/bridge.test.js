const assert = require('node:assert/strict')
const test = require('node:test')
const { bridgePortOf, createBridge, outgoingOf, serveBridge } = require('../bridge')
const { allowedInBridge, answerScript, conversationUrlOf, sendScript, stateScript, stopScript, SELECTORS } = require('../chatgpt_dom')

/** A ChatGPT page as the bridge sees it: signed in or not, generating or not, its assistant messages, and the messages
 *  it shows as sent (`shown`, the person's side of the conversation). */
function fakePage() {
  const page = {
    logged_in: true, generating: false, messages: [], url: 'https://chatgpt.com/', opened: 0, sent: [], shown: [],
    state: async () => ({ ok: true, logged_in: page.logged_in, generating: page.generating, url: page.url, conversation: /\/c\//.test(page.url) ? { url: page.url } : null, model: 'GPT-6 Pro', assistant_count: page.messages.length, last_assistant_text: page.messages[page.messages.length - 1] || '', user_count: page.shown.length, last_user_text: page.shown[page.shown.length - 1] || '' }),
    open: async (url) => { page.opened += 1; page.url = url && !page.missing ? url : 'https://chatgpt.com/'; page.messages = url && page.history[url] ? [...page.history[url]] : [] },
    history: {}, missing: false, stops: 0,
    stop: async () => { page.stops += 1; page.generating = false; return { clicked: true } },
    send: async (text) => { if (!page.logged_in) return { accepted: false, reason: 'needs_login' }; page.sent.push(text); page.shown.push(text); page.url = 'https://chatgpt.com/c/conv-1'; page.generating = true; return { accepted: true } },
    answer: async () => ({ generating: page.generating, count: page.messages.length, text: page.messages[page.messages.length - 1] || '', url: page.url }),
  }
  return page
}

test('a message the page did not take goes once more, its scene logged; one the page took after all does not go twice', async () => {
  const page = fakePage()
  const logs = []
  const bridge = createBridge({ page, token: 't', log: (line) => logs.push(line), sendRetryMs: 0 })
  const send = page.send
  let refusals = 1
  page.send = async (text) => (refusals-- > 0 ? { accepted: false, reason: 'no_send_button', scene: { editor_ready: false } } : send(text))
  assert.deepEqual(await bridge.send({ text: 'first', turn_id: 'turn_1', new_conversation: true }), { accepted: true, message_id: 'm1', conversation: null })
  assert.deepEqual(page.sent, ['first'])
  assert.ok(logs.some((line) => line.includes('did not take turn turn_1') && line.includes('"editor_ready":false')))
  // the page shows the message although the send read as refused (Enter went through late): taken, not sent again
  page.generating = false
  page.send = async (words) => { page.shown.push(words); page.generating = true; return { accepted: false, reason: 'no_send_button', scene: null } }
  assert.deepEqual(await bridge.send({ text: 'second', turn_id: 'turn_2' }), { accepted: true, message_id: 'm2', conversation: { url: 'https://chatgpt.com/c/conv-1' } })
  // refused twice: said so, and logged both times
  page.generating = false
  page.send = async () => ({ accepted: false, reason: 'no_send_button', scene: { buttons: [] } })
  assert.deepEqual(await bridge.send({ text: 'third', turn_id: 'turn_3' }), { accepted: false, reason: 'no_send_button' })
  assert.ok(logs.some((line) => line.startsWith('[bridge] nor on a second try')))
  assert.deepEqual(page.sent, ['first'])
})

test('the port is OASIS_CODE_BRIDGE_PORT, 8323 by default', () => {
  assert.equal(bridgePortOf({}), 8323)
  assert.equal(bridgePortOf({ OASIS_CODE_BRIDGE_PORT: '9100' }), 9100)
  assert.throws(() => bridgePortOf({ OASIS_CODE_BRIDGE_PORT: 'x' }), /not a port/)
})

test('a message is sent once the page is signed in and quiet; its answer is the first assistant message after it, once generation stops', async () => {
  const page = fakePage()
  const bridge = createBridge({ page, token: 't' })
  page.logged_in = false
  assert.deepEqual(await bridge.send({ text: 'hi', turn_id: 'turn_1', new_conversation: true }), { accepted: false, reason: 'needs_login' })
  page.logged_in = true
  page.generating = true
  assert.deepEqual(await bridge.send({ text: 'hi', turn_id: 'turn_1' }), { accepted: false, reason: 'generating' })
  page.generating = false
  assert.deepEqual(await bridge.send({ text: '', turn_id: 'turn_1' }), { accepted: false, reason: 'empty' })
  const sent = await bridge.send({ text: 'why does add() subtract?', turn_id: 'turn_1', new_conversation: true })
  assert.deepEqual(sent, { accepted: true, message_id: 'm1', conversation: null })
  assert.equal(page.opened, 1)
  assert.deepEqual(page.sent, ['why does add() subtract?'])
  // generating, no assistant message yet
  assert.deepEqual(await bridge.answer('turn_1'), { status: 'generating', conversation: { url: 'https://chatgpt.com/c/conv-1' } })
  page.messages.push('It subtracts. I will fix it.')
  assert.equal((await bridge.answer('turn_1')).status, 'generating')            // the message is there but the page still streams
  page.generating = false
  assert.deepEqual(await bridge.answer('turn_1'), { status: 'done', text: 'It subtracts. I will fix it.', model: 'GPT-6 Pro', conversation: { url: 'https://chatgpt.com/c/conv-1' } })
  assert.deepEqual(await bridge.answer('turn_nope'), { status: 'unknown' })
  // the next turn goes to the same conversation; its answer is the message after the one before
  const second = await bridge.send({ text: '[oasis-code task event] run finished', turn_id: 'turn_2', new_conversation: false })
  assert.equal(second.accepted, true)
  assert.equal(second.message_id, 'm2')
  assert.deepEqual(second.conversation, { url: 'https://chatgpt.com/c/conv-1' })
  assert.equal(page.opened, 1)
  page.generating = false
  assert.equal((await bridge.answer('turn_2')).status, 'generating')            // still the first answer only
  page.messages.push('Verdict ok.')
  assert.equal((await bridge.answer('turn_2')).text, 'Verdict ok.')
  const state = await bridge.state()
  assert.deepEqual(state, { ok: true, logged_in: true, generating: false, conversation: { url: 'https://chatgpt.com/c/conv-1' }, model: 'GPT-6 Pro', load_error: null })
})

test('the server answers the protocol under its token on the loopback', async () => {
  const page = fakePage()
  const bridge = createBridge({ page, token: 'secret' })
  const served = await serveBridge({ bridge, token: 'secret', port: 0 })
  try {
    const get = (path, token = 'secret') => fetch(`${served.url}${path}`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal((await get('/state', 'wrong')).status, 401)
    assert.equal((await fetch(`${served.url}/healthz`)).status, 200)
    const state = await (await get('/state')).json()
    assert.equal(state.logged_in, true)
    const sent = await (await fetch(`${served.url}/send`, { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello', turn_id: 'turn_9', new_conversation: true }) })).json()
    assert.equal(sent.accepted, true)
    page.messages.push('hi there'); page.generating = false
    const answer = await (await get('/answer?turn_id=turn_9')).json()
    assert.equal(answer.status, 'done')
    assert.equal(answer.text, 'hi there')
    assert.equal((await get('/nope')).status, 404)
  } finally {
    await served.close()
  }
})

test('the page scripts carry the selectors, the words as JSON, and the markdown walker; the window stays on the sign-in and chat hosts', () => {
  const state = stateScript()
  assert.ok(state.includes(JSON.stringify(SELECTORS)))
  assert.ok(state.includes('logged_in'))
  const send = sendScript('say "hi" \n and <b>bold</b>')
  assert.ok(send.includes(JSON.stringify('say "hi" \n and <b>bold</b>')))
  assert.ok(send.includes('needs_login'))
  assert.ok(answerScript().includes('__oasisMarkdown'))
  // the scripts parse as JavaScript
  for (const script of [state, send, answerScript()]) new Function(`return ${script}`)   // eslint-disable-line no-new-func
  assert.equal(allowedInBridge('https://chatgpt.com/c/123'), true)
  assert.equal(allowedInBridge('https://auth.openai.com/authorize'), true)
  assert.equal(allowedInBridge('https://accounts.google.com/o/oauth2'), true)
  assert.equal(allowedInBridge('https://example.com/'), false)
  assert.equal(allowedInBridge('http://chatgpt.com/'), false)
  assert.equal(allowedInBridge('javascript:alert(1)'), false)
})

test('the bridge token lives in the data directory (0600) and survives a restart of the app', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { bridgeTokenOf, TOKEN_FILE } = require('../bridge')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-bridge-'))
  try {
    assert.equal(fs.existsSync(path.join(dir, TOKEN_FILE)), false)
    const first = bridgeTokenOf(dir)
    assert.ok(first.length >= 20)
    assert.equal(fs.existsSync(path.join(dir, TOKEN_FILE)), true)
    assert.equal(fs.statSync(path.join(dir, TOKEN_FILE)).mode & 0o777, 0o600)
    assert.equal(bridgeTokenOf(dir), first)                                     // the next run of the app: the same token
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

/** Electron's view and window, as far as the page adapter touches them. */
function fakeElectron() {
  const made = []
  class WebContentsView {
    constructor(options) {
      this.options = options
      this.bounds = null
      this.visible = true
      this.webContents = {
        destroyed: false, loads: [], scripts: [],
        isDestroyed() { return this.destroyed },
        handlers: {}, url: 'about:blank',
        setWindowOpenHandler() {}, on(name, fn) { this.handlers[name] = fn },
        getURL() { return this.url },
        loadURL(url) { this.loads.push(url); return Promise.resolve() },
        executeJavaScript(script) { this.scripts.push(script); return Promise.resolve(JSON.stringify({ ok: true, logged_in: true })) },
        close() { this.destroyed = true },
      }
      made.push(this)
    }
    setBackgroundColor() {}
    setBounds(bounds) { this.bounds = bounds }
    setVisible(visible) { this.visible = visible }
  }
  const windowOf = () => {
    const children = []
    return { children, destroyed: false, isDestroyed() { return this.destroyed },
      contentView: { addChildView: (v) => children.push(v), removeChildView: (v) => children.splice(children.indexOf(v), 1) } }
  }
  return { WebContentsView, made, windowOf }
}

test('the page is one view in the app window: read while hidden, never reopened as a window, placed where the card says', async () => {
  const { electronPage, viewPlaceOf } = require('../bridge')
  const { WebContentsView, made, windowOf } = fakeElectron()
  let host = windowOf()
  const page = electronPage({ WebContentsView, host: () => host, shell: { openExternal: async () => {} } })
  await page.state()
  await page.state()
  await page.answer()
  assert.equal(made.length, 1)                                                  // the director's reads reuse the page
  assert.equal(made[0].visible, false)                                          // and leave it hidden
  assert.equal(made[0].options.webPreferences.partition, 'persist:oasis-code-chatgpt')
  assert.equal(made[0].options.webPreferences.nodeIntegration, false)
  assert.deepEqual(host.children, [made[0]])
  page.place({ x: 600.4, y: 80, width: 420, height: 300, visible: true })
  assert.deepEqual(made[0].bounds, { x: 600, y: 80, width: 420, height: 300 })
  assert.equal(made[0].visible, true)
  page.place({ x: 600, y: 80, width: 420, height: 300, visible: false })        // shelved, behind a card, under a menu
  assert.equal(made[0].visible, false)
  await page.state()
  assert.equal(made.length, 1)
  host = windowOf()                                                             // the app's window opened again
  await page.state()
  assert.deepEqual(host.children, [made[0]])
  page.close()
  assert.equal(made[0].webContents.destroyed, true)
  assert.deepEqual(host.children, [])
  assert.deepEqual(viewPlaceOf({ x: 1, y: 2, width: 0, height: 5, visible: true }), { x: 1, y: 2, width: 0, height: 5, visible: false })
  assert.equal(viewPlaceOf({ x: 'a', y: 2, width: 3, height: 5, visible: true }).visible, false)
  assert.equal(viewPlaceOf(null).visible, false)
  assert.deepEqual(viewPlaceOf({ x: -9, y: Infinity, width: 3, height: 5, visible: true }), { x: 0, y: 0, width: 0, height: 0, visible: false })
})

test("a look at the status without loading (the @ menu's) never opens the page; once open, the look reads it", async () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { rememberChatGpt, startBridge } = require('../bridge')
  const { WebContentsView, made, windowOf } = fakeElectron()
  const host = windowOf()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-bridge-status-'))
  const bridge = await startBridge({ WebContentsView, host: () => host, shell: { openExternal: async () => {} }, port: 0, dataDir: dir })
  try {
    const mention = '[$oasis-code](app://asdk_app_1)'
    rememberChatGpt(dir, { mention })
    const usable = { state: 'usable' }
    assert.deepEqual(await bridge.status({ load: false }), { started: false, logged_in: null, connector: mention, model: null, journal: usable })
    assert.equal(made.length, 0)                                                  // creating the page holds the window: not for a look
    assert.deepEqual(await bridge.status(), { started: true, logged_in: true, connector: mention, model: null, load_error: null, journal: usable })
    assert.equal(made.length, 1)                                                  // the chip's read opens it
    assert.deepEqual(await bridge.status({ load: false }), { started: true, logged_in: true, connector: mention, model: null, load_error: null, journal: usable })
    assert.equal(made.length, 1)
    // a damaged send log shows on the card's status until the person resumes sending
    const aside = 'bridge-turns.damaged-2026-10-01T08-30-00.000Z.json'
    fs.writeFileSync(path.join(dir, aside), '{"turn_a":{"state":"sent"')
    assert.deepEqual((await bridge.status({ load: false })).journal, { state: 'damaged', file: aside, at: '2026-10-01T08:30:00.000Z' })
    assert.deepEqual(bridge.resumeSending(), { resumed: true, archived: ['bridge-turns.damaged-2026-10-01T08-30-00.000Z.acknowledged.json'], salvaged: 1, journal: usable })
    assert.deepEqual((await bridge.status({ load: false })).journal, usable)
  } finally {
    await bridge.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the model and the connector are armed for the message; malformed ones are not', async () => {
  const { mentionOf } = require('../chatgpt_dom')
  assert.deepEqual(mentionOf(' [$oasis-code](app://asdk_app_6ab76cd0) '), { markdown: '[$oasis-code](app://asdk_app_6ab76cd0)', name: 'oasis-code', appId: 'asdk_app_6ab76cd0' })
  assert.deepEqual(mentionOf('[oasis-code](app://asdk_app_1)'), { markdown: '[$oasis-code](app://asdk_app_1)', name: 'oasis-code', appId: 'asdk_app_1' })
  assert.equal(mentionOf('@oasis-code'), null)
  assert.equal(mentionOf('[$x](javascript:alert(1))'), null)
  const page = fakePage()
  const armed = []
  page.arm = (turnId, patch) => armed.push([turnId, patch])
  const bridge = createBridge({ page, token: 't' })
  await bridge.send({ text: 'draw a cat', turn_id: 'turn_1', mention: '[$oasis-code](app://asdk_app_1)', model: 'gpt-6-pro' })
  page.generating = false
  await bridge.send({ text: 'again', turn_id: 'turn_2', mention: 'not a mention', model: 'gpt 6; x' })
  page.generating = false
  await bridge.send({ text: 'plain', turn_id: 'turn_3' })
  assert.deepEqual(armed, [['turn_1', { model: 'gpt-6-pro', appId: 'asdk_app_1', markdown: '[$oasis-code](app://asdk_app_1)' }]])
  assert.deepEqual(page.sent, ['draw a cat', 'again', 'plain'])        // the words alone go into the composer
})

test('the page scripts keep their regular expressions whole (a template literal eats one backslash)', () => {
  const { sendScript, imagesScript } = require('../chatgpt_dom')
  const send = sendScript('a\n\nb')
  assert.ok(send.includes("replace(/\\s+/g, '')"), 'white space is \\s, not the letter s')
  assert.ok(!/replace\(\/s\+\/g/.test(send))
  assert.ok(imagesScript(['file_1']).includes('/^image\\//'))
  const { attachScript } = require('../chatgpt_dom')
  const attach = attachScript([{ name: 'a "b".png', media_type: 'image/png', data_base64: 'iVBO' }])
  assert.ok(attach.includes('"a \\"b\\".png"'), 'the images go in as JSON')
  const { stopScript } = require('../chatgpt_dom')
  for (const script of [send, imagesScript(['file_1']), attach, stopScript()]) assert.doesNotThrow(() => new Function(`return ${script}`))
  // the stop button as the redesigned page labels it, kept to the composer's form; clicked again while it stays
  assert.ok(stopScript().includes('form button[aria-label=\\"停止\\"]') && stopScript().includes('i < 8'))
  // the composer is emptied and seen empty before the words, and holds them alone before the send
  assert.ok(send.includes("document.execCommand('selectAll', false)") && send.includes("reason: 'composer_not_cleared'") && send.includes("reason: 'composer_mismatch'"))
})

test("the page's downloads while a picture is clicked are taken, read and removed; nothing else is touched", async () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { EventEmitter } = require('node:events')
  const { takeDownloads } = require('../bridge')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-dl-test-'))
  try {
    const session = new EventEmitter()
    const view = { session }
    const other = { session }
    const item = (name, bytes, state = 'completed') => {
      const it = new EventEmitter()
      it.getFilename = () => name
      it.setSavePath = (file) => { it.file = file }
      it.finish = () => { if (state === 'completed') fs.writeFileSync(it.file, bytes); it.emit('done', {}, state) }
      return it
    }
    const png = Buffer.alloc(3000, 1)
    const items = []
    const got = await takeDownloads(view, async () => {
      const cat = item('claude-opus-5.5-cat.png', png)
      const svg = item('cat.svg', Buffer.from('<svg/>'))
      const theirs = item('other.png', png)
      session.emit('will-download', {}, cat, view)
      session.emit('will-download', {}, svg, view)
      session.emit('will-download', {}, theirs, other)            // another window's download: not taken
      items.push(cat, svg, theirs)
      setTimeout(() => { cat.finish(); svg.finish() }, 20)
      return { clicked: ['claude-opus-5.5-cat.png'], seen: [] }
    }, { waitMs: 2000, tmpRoot: root })
    assert.deepEqual(got.images.map((i) => [i.name, i.media_type, Buffer.from(i.data_base64, 'base64').length]), [['claude-opus-5.5-cat.png', 'image/png', 3000]])
    assert.deepEqual(got.clicked, { clicked: ['claude-opus-5.5-cat.png'], seen: [] })
    assert.equal(items[2].file, undefined)                          // not redirected
    assert.equal(session.listenerCount('will-download'), 0)         // the person's downloads are theirs again
    assert.deepEqual(fs.readdirSync(root), [])                      // nothing left on disk
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a message for an earlier conversation opens it first (unless the page shows it), and its answer is the one after it', async () => {
  const page = fakePage()
  const bridge = createBridge({ page, token: 't' })
  const earlier = 'https://chatgpt.com/c/conv-7'
  page.history[earlier] = ['the derivation', 'a later answer']
  assert.deepEqual(await bridge.send({ text: 'x', turn_id: 'turn_0', conversation_url: 'https://example.com/c/conv-7' }), { accepted: false, reason: 'bad_conversation_url' })
  assert.deepEqual(await bridge.send({ text: 'x', turn_id: 'turn_0', conversation_url: 'https://chatgpt.com/' }), { accepted: false, reason: 'bad_conversation_url' })
  assert.equal(page.opened, 0)
  // new_conversation is overruled: the message belongs to the conversation named
  const sent = await bridge.send({ text: 'the critique, as written', turn_id: 'turn_1', new_conversation: true, conversation_url: `${earlier}?model=x` })
  assert.deepEqual(sent, { accepted: true, message_id: 'm1', conversation: { url: earlier } })
  assert.equal(page.opened, 1)
  assert.deepEqual(page.sent, ['the critique, as written'])
  page.url = earlier                                                              // sending leaves the page where it was
  page.messages.push('my answer to the critique'); page.generating = false
  assert.equal((await bridge.answer('turn_1')).text, 'my answer to the critique')
  // the page already shows it: not opened again
  await bridge.send({ text: 'and again', turn_id: 'turn_2', conversation_url: earlier })
  assert.equal(page.opened, 1)
  page.generating = false
  // a conversation the page does not open (deleted, another account's): refused, nothing typed
  page.missing = true
  assert.deepEqual(await bridge.send({ text: 'lost', turn_id: 'turn_3', conversation_url: 'https://chatgpt.com/c/gone' }), { accepted: false, reason: 'conversation_not_found' })
  assert.deepEqual(page.sent, ['the critique, as written', 'and again'])
  assert.equal(conversationUrlOf('https://chatgpt.com/g/g-abc/c/123-x/'), 'https://chatgpt.com/g/g-abc/c/123-x')
  assert.equal(conversationUrlOf('http://chatgpt.com/c/1'), null)
  assert.equal(conversationUrlOf('https://chatgpt.com.evil.test/c/1'), null)
  assert.equal(conversationUrlOf(null), null)
})

test('stop clicks the page stop button for the message last sent, and only for it', async () => {
  const page = fakePage()
  const bridge = createBridge({ page, token: 't' })
  assert.deepEqual(await bridge.stop('turn_1'), { stopped: false, reason: 'unknown' })
  await bridge.send({ text: 'first', turn_id: 'turn_1' })
  page.messages.push('one'); page.generating = false
  await bridge.send({ text: 'second', turn_id: 'turn_2' })
  assert.deepEqual(await bridge.stop('turn_1'), { stopped: false, reason: 'not_current' })   // a late stop of an earlier turn
  assert.equal(page.stops, 0)
  assert.deepEqual(await bridge.stop('turn_2'), { stopped: true })
  assert.equal(page.stops, 1)
  assert.deepEqual(await bridge.stop('turn_2'), { stopped: false, reason: 'not_generating' })
  // the turn stopped, an answer forming afterwards is not its own (the person's message): left alone
  page.generating = true
  assert.deepEqual(await bridge.stop('turn_2'), { stopped: false, reason: 'not_generating' })
  assert.equal(page.stops, 1)
  // a page without a stop button to click
  page.generating = false
  await bridge.send({ text: 'third', turn_id: 'turn_3' })
  page.stop = async () => ({ clicked: false })
  assert.deepEqual(await bridge.stop('turn_3'), { stopped: false, reason: 'no_stop_button' })
  // over HTTP, under the token
  const served = await serveBridge({ bridge, token: 'secret', port: 0 })
  try {
    const post = (path, body, token = 'secret') => fetch(`${served.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await post('/stop', { turn_id: 'turn_3' }, 'wrong')).status, 401)
    page.stop = async () => { page.generating = false; return { clicked: true } }
    assert.deepEqual(await (await post('/stop', { turn_id: 'turn_3' })).json(), { stopped: true })
    assert.deepEqual(await (await post('/stop', {})).json(), { stopped: false, reason: 'unknown' })
  } finally { await served.close() }
  const script = stopScript()
  assert.ok(script.includes(JSON.stringify(SELECTORS)))
  assert.doesNotThrow(() => new Function(`return ${script}`))                   // eslint-disable-line no-new-func
})

test('the page adapter opens a conversation by its address, and only a conversation', async () => {
  const { electronPage } = require('../bridge')
  const { WebContentsView, made, windowOf } = fakeElectron()
  const host = windowOf()
  const page = electronPage({ WebContentsView, host: () => host, shell: { openExternal: async () => {} } })
  page.load()
  const wc = made[0].webContents
  wc.executeJavaScript = (script) => { wc.scripts.push(script); return Promise.resolve(JSON.stringify(/assistant_count/.test(script) ? { ok: true, logged_in: true, assistant_count: 2, url: 'https://chatgpt.com/c/abc' } : { clicked: true })) }
  await page.open('https://chatgpt.com/c/abc#x')
  await page.open('javascript:alert(1)')
  await page.open()
  assert.deepEqual(wc.loads.slice(-3), ['https://chatgpt.com/c/abc', 'https://chatgpt.com/', 'https://chatgpt.com/'])
  assert.deepEqual(await page.stop(), { clicked: true })
  page.close()
})

test('a page that did not load says so, is kept off the card, is loaded again by itself and on a reload; a message waits for it as page_not_loaded', async () => {
  const { electronPage } = require('../bridge')
  const { WebContentsView, made, windowOf } = fakeElectron()
  const host = windowOf()
  const page = electronPage({ WebContentsView, host: () => host, shell: { openExternal: async () => {} } })
  page.load()
  const wc = made[0].webContents
  const failed = wc.handlers['did-fail-load']
  const finished = wc.handlers['did-finish-load']
  page.place({ x: 10, y: 10, width: 300, height: 200, visible: true })
  assert.equal(made[0].visible, true)
  // the document answers where it is; the view names the address it last committed
  let at = 'https://chatgpt.com/'
  const script = wc.executeJavaScript.bind(wc)
  wc.executeJavaScript = (s) => (s === 'location.href' ? Promise.resolve(at) : script(s))
  // the proxy's tunnel refused the load (2026-09-29): the card's place stays, the page does not show; Chromium's error
  // page is at chrome-error:// while the view still names the address it tried
  wc.url = 'https://chatgpt.com/'
  at = 'chrome-error://chromewebdata/'
  failed({}, -111, 'ERR_TUNNEL_CONNECTION_FAILED', 'https://chatgpt.com/', true)
  assert.equal(made[0].visible, false)
  assert.deepEqual(await page.state(), { ok: true, logged_in: false, generating: false, url: 'https://chatgpt.com/', load_error: 'ERR_TUNNEL_CONNECTION_FAILED (-111)' })
  failed({}, -3, 'ERR_ABORTED', 'https://chatgpt.com/', true)                        // a load the page replaced is no failure
  failed({}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://cdn.example/x.js', false)          // nor is a frame's
  assert.equal((await page.state()).load_error, 'ERR_TUNNEL_CONNECTION_FAILED (-111)')
  await finished()                                                                      // the error page finishing is no load
  assert.equal(made[0].visible, false)
  assert.equal((await page.state()).load_error, 'ERR_TUNNEL_CONNECTION_FAILED (-111)')
  // a message meanwhile: refused as not loaded, never as a sign-in
  const bridge = createBridge({ page, token: 't' })
  assert.deepEqual(await bridge.send({ text: 'hi', turn_id: 't1' }), { accepted: false, reason: 'page_not_loaded', detail: 'ERR_TUNNEL_CONNECTION_FAILED (-111)' })
  assert.equal((await bridge.state()).load_error, 'ERR_TUNNEL_CONNECTION_FAILED (-111)')
  // the person's reload loads it again; once loaded, it shows and reads as itself
  const loads = wc.loads.length
  page.reload()
  assert.equal(wc.loads.length, loads + 1)
  at = 'https://chatgpt.com/'
  await finished()
  assert.equal(made[0].visible, true)
  assert.equal((await page.state()).load_error, undefined)
  page.close()
})

test("an answer's text files in ChatGPT's sandbox are found by their links; pictures and other files are not", () => {
  const { sandboxFilesOf } = require('../chatgpt_dom')
  const text = [
    '[下载完整复核脚本：gan_pretrain_rl_checks.py](sandbox:/mnt/data/gan_pretrain_rl_checks.py)',
    '![plot](sandbox:/mnt/data/plot.png) [data](sandbox:/mnt/data/out.csv) [zip](sandbox:/mnt/data/all.zip)',
    'again [the script](sandbox:/mnt/data/gan_pretrain_rl_checks.py)',
  ].join('\n')
  assert.deepEqual(sandboxFilesOf(text), [
    { path: '/mnt/data/gan_pretrain_rl_checks.py', name: 'gan_pretrain_rl_checks.py' },
    { path: '/mnt/data/out.csv', name: 'out.csv' },
  ])
  assert.deepEqual(sandboxFilesOf('no files'), [])
})

test("a text file's words go under the block that links it, in a fence longer than any it holds; one not linked follows the answer", () => {
  const { withAnswerFiles } = require('../chatgpt_dom')
  const text = [
    'Intro.',
    '',
    '[the script](sandbox:/mnt/data/a.py)',
    'Run it once.',
    '',
    '| file | what |',
    '| --- | --- |',
    '| [data](sandbox:/mnt/data/b.csv) | numbers |',
    '| other | row |',
    '',
    'End.',
  ].join('\n')
  const out = withAnswerFiles(text, [
    { path: '/mnt/data/a.py', name: 'a.py', text: 'print("```")\n', chars: 13, truncated: false },
    { path: '/mnt/data/b.csv', name: 'b.csv', text: 'x,y\n1,2', chars: 20, truncated: true },
    { path: '/mnt/data/c.md', name: 'c.md', text: '# note', chars: 6, truncated: false },
  ])
  assert.equal(out, [
    'Intro.',
    '',
    '[the script](sandbox:/mnt/data/a.py)',
    'Run it once.',
    '',
    '**a.py**',
    '',
    '````python',
    'print("```")',
    '````',
    '',
    '| file | what |',
    '| --- | --- |',
    '| [data](sandbox:/mnt/data/b.csv) | numbers |',
    '| other | row |',
    '',
    '**b.csv**',
    '',
    '```csv',
    'x,y\n1,2',
    '```',
    '',
    '*The first 7 of 20 characters; the whole file is in the ChatGPT conversation.*',
    '',
    'End.',
    '',
    '**c.md**',
    '',
    '```markdown',
    '# note',
    '```',
  ].join('\n'))
  assert.equal(withAnswerFiles(text, []), text)
})

test("the page fetches the answer's files with its own session: the interpreter's address, text only, at most so much", async () => {
  const { filesScript } = require('../chatgpt_dom')
  const asked = []
  const fetch = async (url, init = {}) => {
    asked.push({ url: String(url), auth: (init.headers || {}).Authorization || null, credentials: init.credentials })
    const json = (body) => ({ ok: true, status: 200, json: async () => body, headers: { get: () => 'application/json' } })
    const file = (body, type) => ({ ok: true, status: 200, text: async () => body, headers: { get: () => type } })
    if (url === '/api/auth/session') return json({ accessToken: 'tok' })
    if (String(url).includes('sandbox_path=%2Fmnt%2Fdata%2Fa.py')) return json({ download_url: 'https://chatgpt.com/backend-api/estuary/content?id=file_1&fn=a.py' })
    if (String(url).includes('sandbox_path=%2Fmnt%2Fdata%2Fbin.txt')) return json({ download_url: 'https://chatgpt.com/backend-api/estuary/content?id=file_2' })
    if (String(url).includes('sandbox_path=%2Fmnt%2Fdata%2Fevil.txt')) return json({ download_url: 'https://evil.example/x' })
    if (String(url).includes('sandbox_path=')) return { ok: false, status: 404 }
    if (String(url).includes('file_1')) return file('0123456789', 'text/x-python')
    if (String(url).includes('file_2')) return file('a\u0000b', 'text/plain')
    throw new Error(`unexpected ${url}`)
  }
  const script = filesScript({ conversationId: 'conv-1', messageId: 'msg-1', maxChars: 4, files: [
    { path: '/mnt/data/a.py', name: 'a.py' }, { path: '/mnt/data/bin.txt', name: 'bin.txt' },
    { path: '/mnt/data/evil.txt', name: 'evil.txt' }, { path: '/mnt/data/gone.txt', name: 'gone.txt' },
  ] })
  const location = { href: 'https://chatgpt.com/c/conv-1', origin: 'https://chatgpt.com' }
  const out = JSON.parse(await new Function('fetch', 'location', `return ${script}`)(fetch, location))   // eslint-disable-line no-new-func
  assert.deepEqual(out.files, [{ path: '/mnt/data/a.py', name: 'a.py', media_type: 'text/x-python', text: '0123', chars: 10, truncated: true }])
  assert.deepEqual(out.missed, [{ path: '/mnt/data/bin.txt', why: 'not_text' }, { path: '/mnt/data/evil.txt', why: 'no_address' }, { path: '/mnt/data/gone.txt', why: 'http_404' }])
  assert.ok(asked[1].url.startsWith('/backend-api/conversation/conv-1/interpreter/download?message_id=msg-1&sandbox_path='))
  assert.equal(asked[1].auth, 'Bearer tok')
  assert.ok(!asked.some((a) => a.url.includes('evil.example')))        // an address off ChatGPT's hosts is never fetched
  // signed out: nothing fetched beyond the session
  const signedOut = async (url) => (url === '/api/auth/session' ? { ok: true, json: async () => ({}) } : assert.fail(`fetched ${url}`))
  const none = JSON.parse(await new Function('fetch', 'location', `return ${script}`)(signedOut, location))   // eslint-disable-line no-new-func
  assert.deepEqual(none.files, [])
  assert.equal(none.missed[0].why, 'no_session')
})

test("an answer heard from the stream carries the text files it links to, fetched for its conversation and message", async () => {
  const page = fakePage()
  const want = []
  const text = 'Done.\n\n[the script](sandbox:/mnt/data/a.py)'
  page.heard = () => ({ events: 3, done: true, done_at: 0, last_at: 0, text, thinking: '', steps: [], images: [], pointers: [], conversation_id: 'conv-1', message_id: 'msg-9' })
  page.files = async (w) => { want.push(w); return { files: [{ path: '/mnt/data/a.py', name: 'a.py', text: 'print(1)', chars: 8, truncated: false }], missed: [] } }
  const logs = []
  const bridge = createBridge({ page, token: 't', log: (line) => logs.push(line) })
  await bridge.send({ text: 'write a script', turn_id: 'turn_1', new_conversation: true })
  const done = await bridge.answer('turn_1')
  assert.equal(done.status, 'done')
  assert.equal(done.text, 'Done.\n\n[the script](sandbox:/mnt/data/a.py)\n\n**a.py**\n\n```python\nprint(1)\n```\n')
  assert.deepEqual(want, [{ conversationId: 'conv-1', messageId: 'msg-9', files: [{ path: '/mnt/data/a.py', name: 'a.py' }] }])
  assert.ok(logs.some((line) => line.includes('1 of 1 files taken')))
  // the page could not give them: the answer keeps its words
  page.files = async () => { throw new Error('page gone') }
  page.generating = false
  assert.equal((await bridge.send({ text: 'again', turn_id: 'turn_2' })).accepted, true)
  assert.equal((await bridge.answer('turn_2')).text, text)
})

test("signed in is the page's own session: a signed-out page with a composer and sign-in buttons of no known id is signed out", () => {
  const { signedIn, stateScript, sendScript } = require('../chatgpt_dom')
  // the session read: it decides (a signed-in page with no composer found has changed — a send says no_composer)
  assert.equal(signedIn({ session: false, composerVisible: true, visibleLogins: 0 }), false)      // seen 2026-09-30: read as signed in before
  assert.equal(signedIn({ session: true, composerVisible: true, visibleLogins: 0 }), true)
  assert.equal(signedIn({ session: true, composerVisible: false, visibleLogins: 0 }), true)
  // the session not readable: the controls on screen, as before
  assert.equal(signedIn({ session: null, composerVisible: true, visibleLogins: 0 }), true)
  assert.equal(signedIn({ session: null, composerVisible: true, visibleLogins: 1 }), false)
  // both scripts ask the session, the state caching only a signed-in answer
  for (const script of [stateScript(), sendScript('hi')]) {
    assert.ok(script.includes("fetch('/api/auth/session'"))
    assert.ok(script.includes('function signedIn('))
    assert.doesNotThrow(() => new Function(`return ${script}`))   // eslint-disable-line no-new-func
  }
  assert.ok(stateScript().includes('kept.signed === true'))
})

test("the bridge's address is written beside its token, for a backend the app attached to", () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { rememberBridgeUrl, URL_FILE } = require('../bridge')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-bridge-url-'))
  try {
    rememberBridgeUrl(dir, 'http://127.0.0.1:8343')
    assert.equal(fs.readFileSync(path.join(dir, URL_FILE), 'utf8'), 'http://127.0.0.1:8343\n')
    rememberBridgeUrl(dir, 'http://127.0.0.1:8323')                               // the next start: the file follows it
    assert.equal(fs.readFileSync(path.join(dir, URL_FILE), 'utf8').trim(), 'http://127.0.0.1:8323')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test("a page not opened yet reads as signed out when its profile holds no ChatGPT sign-in cookie; unknown when it does", async () => {
  const { sessionCookiePresent, electronPage } = require('../bridge')
  assert.equal(sessionCookiePresent([]), false)
  assert.equal(sessionCookiePresent([{ name: 'oai-client-session-epoch' }, { name: '__cf_bm' }]), false)
  assert.equal(sessionCookiePresent([{ name: '__Secure-next-auth.session-token.0' }, { name: '__Secure-next-auth.session-token.1' }]), true)   // split, seen 2026-09-30
  assert.equal(sessionCookiePresent([{ name: '__Secure-next-auth.session-token' }]), true)
  assert.equal(sessionCookiePresent([{ name: '__Secure-next-auth.session-token-old' }]), false)
  // the page adapter reads the page's own profile, and says null where there is no Electron session to read
  const { WebContentsView, windowOf } = fakeElectron()
  const host = windowOf()
  const asked = []
  const session = { fromPartition: (p) => ({ cookies: { get: async (filter) => { asked.push([p, filter.url]); return [] } } }) }
  assert.equal(await electronPage({ WebContentsView, host: () => host, shell: {}, session }).signInCookie(), false)
  assert.deepEqual(asked, [['persist:oasis-code-chatgpt', 'https://chatgpt.com']])
  assert.equal(await electronPage({ WebContentsView, host: () => host, shell: {} }).signInCookie(), null)
})

test("a message's images are uploaded by the page before its words go, each name its own; malformed ones, or a page that did not take them, send nothing", async () => {
  const page = fakePage()
  const logs = []
  const attached = []
  page.attach = async (images) => { attached.push(images); return { ok: true, count: images.length } }
  const bridge = createBridge({ page, token: 't', log: (line) => logs.push(line) })
  const png = { name: 'shot.png', media_type: 'image/png', data_base64: 'iVBORw0KGgo=' }
  assert.equal((await bridge.send({ text: 'look', turn_id: 'turn_1', new_conversation: true, images: [png, png, { ...png, name: '' }] })).accepted, true)
  assert.deepEqual(attached[0].map((i) => i.name), ['shot.png', 'shot (2).png', 'image'])
  assert.deepEqual(page.sent, ['look'])
  assert.ok(logs.some((line) => line.includes('(4 chars, 3 images)')))
  page.generating = false
  // malformed: a type the page does not read, bytes that are not base64, too many
  for (const images of [[{ ...png, media_type: 'image/svg+xml' }], [{ ...png, data_base64: 'not base64!' }], Array(9).fill(png), 'shot.png']) {
    assert.deepEqual(await bridge.send({ text: 'look', turn_id: 'turn_x', images }), { accepted: false, reason: 'bad_images' })
  }
  // the page did not take them: the words stay unsent, the reason goes back and to the log
  page.attach = async () => ({ ok: false, reason: 'upload_timeout', shown: [], of: 1 })
  assert.deepEqual(await bridge.send({ text: 'again', turn_id: 'turn_2', images: [png] }), { accepted: false, reason: 'images_not_attached', detail: 'upload_timeout' })
  assert.deepEqual(page.sent, ['look'])
  assert.ok(logs.some((line) => line.includes('did not take the files of turn turn_2') && line.includes('upload_timeout')))
  // no images: the page is asked for none — which takes away what an earlier message left in the composer
  page.attach = async (files) => { attached.push(files); return { ok: true, count: files.length } }
  assert.equal((await bridge.send({ text: 'words only', turn_id: 'turn_3' })).accepted, true)
  assert.deepEqual(attached.at(-1), [])
})

test('long words go as a file of their own, uploaded before a line that names it; images keep their names beside it', async () => {
  const page = fakePage()
  const attached = []
  page.attach = async (files) => { attached.push(files); return { ok: true, count: files.length } }
  const logs = []
  const bridge = createBridge({ page, token: 't', log: (line) => logs.push(line), longText: 10 })
  const text = '推导如下：GAN ≈ pretrain + RL'
  const png = { name: 'message.txt', media_type: 'image/png', data_base64: 'iVBORw0KGgo=' }
  assert.equal((await bridge.send({ text, turn_id: 'turn_1', new_conversation: true, images: [png] })).accepted, true)
  const files = attached[0]
  assert.deepEqual(files.map((f) => [f.name, f.media_type]), [['message.txt', 'image/png'], ['message (2).txt', 'text/plain']])
  assert.equal(Buffer.from(files[1].data_base64, 'base64').toString('utf8'), text)                     // whole, in UTF-8
  assert.deepEqual(page.sent, [`The whole message (${text.length} characters) is in the attached text file. Read all of it, then answer it.`])
  assert.ok(logs.some((line) => line.includes(`(${text.length} chars as message (2).txt, 1 image)`)))
  // at or under the line, the words go as they are
  assert.deepEqual(outgoingOf('short', [], 10), { words: 'short', files: [] })
})

test('a send the page took but did not act on is not taken: no answer began, the page did not move', async () => {
  const page = fakePage()
  const logs = []
  // the button was pressed, the words left the composer — and nothing happened (a long paste the page turned into a file)
  page.send = async (words) => { page.sent.push(words); return { accepted: true } }
  const bridge = createBridge({ page, token: 't', log: (line) => logs.push(line), confirmMs: 50, confirmEveryMs: 10 })
  assert.deepEqual(await bridge.send({ text: 'hello', turn_id: 'turn_1', new_conversation: true }), { accepted: false, reason: 'not_sent' })
  assert.ok(logs.some((line) => line.includes('turn turn_1 did not go')))
  assert.equal((await bridge.answer('turn_1')).status, 'lost')                                       // no answer to wait on
  // the message shown as sent a moment later is the proof
  page.send = async (words) => { page.sent.push(words); setTimeout(() => { page.shown.push(words); page.generating = true }, 20); return { accepted: true } }
  const slow = createBridge({ page, token: 't', confirmMs: 500, confirmEveryMs: 10 })
  assert.equal((await slow.send({ text: 'hello', turn_id: 'turn_2' })).accepted, true)
})

test('a composer that kept an earlier draft, or held more than the words, sends nothing and says why', async () => {
  const page = fakePage()
  const logs = []
  const bridge = createBridge({ page, token: 't', log: (line) => logs.push(line) })
  page.send = async () => ({ accepted: false, reason: 'composer_mismatch', scene: { composer_chars: 179154, words_chars: 98 } })
  assert.deepEqual(await bridge.send({ text: 'hello', turn_id: 'turn_1', new_conversation: true }), { accepted: false, reason: 'composer_mismatch' })
  assert.ok(logs.some((line) => line.includes('did not hold these words alone') && line.includes('179154')))
  page.send = async () => ({ accepted: false, reason: 'composer_not_cleared', scene: { words_in_composer: 12 } })
  assert.deepEqual(await bridge.send({ text: 'hello', turn_id: 'turn_2' }), { accepted: false, reason: 'composer_not_cleared' })
  assert.ok(logs.some((line) => line.includes('kept what it held before')))
  assert.deepEqual(page.sent, [])
})

test("the message's request seen leaving the page is proof it went, whatever the page's look (a stop button renamed)", async () => {
  const page = fakePage()
  let posted = null
  page.begin = () => { posted = null }
  page.heard = () => ({ events: 0, posted_at: posted })
  // the page shows nothing it would have shown before (no stop button it knows, the same address): its request went
  page.send = async (words) => { page.sent.push(words); setTimeout(() => { posted = Date.now() }, 20); return { accepted: true } }
  const bridge = createBridge({ page, token: 't', confirmMs: 500, confirmEveryMs: 10 })
  assert.equal((await bridge.send({ text: 'second round', turn_id: 'turn_2' })).accepted, true)
})

test('a turn is sent at most once: a repeat answers as the send did, one on its way is refused as sending, and the app\'s restart keeps them', async () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { fileJournal, JOURNAL_FILE } = require('../bridge')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-bridge-'))
  try {
    const page = fakePage()
    let bridge = createBridge({ page, token: 't', journal: fileJournal(dir) })
    const [one, two] = await Promise.all([bridge.send({ text: 'hi', turn_id: 'turn_1' }), bridge.send({ text: 'hi', turn_id: 'turn_1' })])
    assert.deepEqual(one, { accepted: true, message_id: 'm1', conversation: null })
    assert.deepEqual(two, { accepted: false, reason: 'sending' })                  // one message per turn at a time
    assert.deepEqual(page.sent, ['hi'])
    page.generating = false
    assert.deepEqual(await bridge.send({ text: 'hi', turn_id: 'turn_1' }), { accepted: true, message_id: 'm1', conversation: null, repeat: true })
    assert.deepEqual(page.sent, ['hi'])
    assert.equal(fs.statSync(path.join(dir, JOURNAL_FILE)).mode & 0o777, 0o600)
    // the app restarted: the turn is known from the data directory, and not sent again
    bridge = createBridge({ page, token: 't', journal: fileJournal(dir) })
    const conversation = { url: 'https://chatgpt.com/c/conv-1' }                 // the conversation it went to
    assert.deepEqual(await bridge.send({ text: 'hi', turn_id: 'turn_1' }), { accepted: true, message_id: 'm1', conversation, repeat: true })
    assert.deepEqual(page.sent, ['hi'])
    // its answer was this page's, before the restart: said so, for good
    const lost = await bridge.answer('turn_1')
    assert.deepEqual([lost.status, lost.reason, lost.conversation], ['lost', 'restarted', conversation])
    // a message submitted with no sign it went: not_sent once, and never sent a second time
    const quiet = fakePage()
    quiet.send = async (text) => { quiet.sent.push(text); return { accepted: true } }
    bridge = createBridge({ page: quiet, token: 't', journal: fileJournal(dir), confirmMs: 30, confirmEveryMs: 5 })
    assert.deepEqual(await bridge.send({ text: 'lost?', turn_id: 'turn_2' }), { accepted: false, reason: 'not_sent' })
    const again = await bridge.send({ text: 'lost?', turn_id: 'turn_2' })
    assert.equal(again.reason, 'unconfirmed')
    assert.match(again.detail, /not sent again/)
    assert.deepEqual(quiet.sent, ['lost?'])
    assert.equal(fileJournal(dir).get('turn_2').state, 'unconfirmed')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a stop the page did not act on is no stop: the answer still forming says so', async () => {
  const page = fakePage()
  const bridge = createBridge({ page, token: 't' })
  await bridge.send({ text: 'long', turn_id: 'turn_1' })
  page.stop = async () => ({ clicked: true, stopped: false })
  assert.deepEqual(await bridge.stop('turn_1'), { stopped: false, reason: 'still_generating' })
  page.stop = async () => { page.generating = false; return { clicked: true, stopped: true } }
  assert.deepEqual(await bridge.stop('turn_1'), { stopped: true })
})

test('an agent acting on the ChatGPT page holds it: a send waits (page_in_use); a send, or its answer forming, makes the agent wait', async () => {
  const { createComputer } = require('../computer')
  const holders = { chatgpt: null }
  const computer = {
    holder: (id) => holders[id],
    claim: (id, owner) => { holders[id] = owner },
    release: (id, owner) => { if (holders[id] === owner) holders[id] = null },
  }
  const page = fakePage()
  const bridge = createBridge({ page, token: 't', computer })
  holders.chatgpt = 'run_agent'
  assert.deepEqual(await bridge.send({ text: 'hi', turn_id: 'turn_1' }), { accepted: false, reason: 'page_in_use', detail: 'run_agent' })
  assert.deepEqual(page.sent, [])
  holders.chatgpt = null
  let during = null
  const send = page.send
  page.send = async (text) => { during = [holders.chatgpt, await bridge.busyForAgent()]; return send(text) }
  assert.equal((await bridge.send({ text: 'hi', turn_id: 'turn_1' })).accepted, true)
  assert.equal(during[0], 'bridge')
  assert.match(during[1], /sending a message/)
  assert.equal(holders.chatgpt, null)                                             // let go once sent
  assert.match(await bridge.busyForAgent(), /answering a message oasis-code sent/)
  page.generating = false
  page.messages.push('done')
  assert.equal((await bridge.answer('turn_1')).status, 'done')
  assert.equal(await bridge.busyForAgent(), null)
  // the real computer's lease: the bridge takes the page only when no agent holds it
  const real = createComputer({ surfaces: {} })
  real.claim('chatgpt', 'run_agent')
  const second = createBridge({ page: fakePage(), token: 't', computer: real })
  assert.equal((await second.send({ text: 'x', turn_id: 'turn_9' })).reason, 'page_in_use')
})

test('the server answers the computer routes under its token', async () => {
  const calls = []
  const computer = {
    list: () => ({ status: 'ok', surfaces: [] }),
    observe: async (body) => { calls.push(['observe', body]); return { status: 'ok', snapshot_id: 'browser-1' } },
    act: async (body) => { calls.push(['act', body]); return { status: 'ok', action: body.action } },
    releaseOwner: (body) => { calls.push(['release', body]); return { status: 'ok', released: ['browser'] } },
  }
  const served = await serveBridge({ bridge: createBridge({ page: fakePage(), token: 's' }), computer, token: 's', port: 0 })
  try {
    const call = (method, path, body, token = 's') => fetch(`${served.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    assert.equal((await call('POST', '/computer/observe', { owner: 'r' }, 'bad')).status, 401)
    assert.deepEqual(await (await call('GET', '/computer/surfaces')).json(), { status: 'ok', surfaces: [] })
    assert.deepEqual(await (await call('POST', '/computer/observe', { surface: 'browser', owner: 'r' })).json(), { status: 'ok', snapshot_id: 'browser-1' })
    assert.deepEqual(await (await call('POST', '/computer/act', { action: 'click', owner: 'r' })).json(), { status: 'ok', action: 'click' })
    assert.deepEqual(await (await call('POST', '/computer/release', { owner: 'r' })).json(), { status: 'ok', released: ['browser'] })
    assert.deepEqual(calls.map((c) => c[0]), ['observe', 'act', 'release'])
  } finally { await served.close() }
  const bare = await serveBridge({ bridge: createBridge({ page: fakePage(), token: 's' }), token: 's', port: 0 })
  try {
    assert.equal((await fetch(`${bare.url}/computer/surfaces`, { headers: { authorization: 'Bearer s' } })).status, 404)
  } finally { await bare.close() }
})
