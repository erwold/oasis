// A message's turn on the ChatGPT page: dropped when its sender gives up, bound to its own request, honest about a
// stop that did not take; and the app's own page as the only one the shell's handlers answer.
const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { createBridge, serveBridge } = require('../bridge')
const { tapPage } = require('../chatgpt_tap')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A page that sends when asked (it shows the message, moves to a conversation and generates), its uploads as slow as
 *  `attachMs`. */
function fakePage({ attachMs = 0 } = {}) {
  const page = {
    logged_in: true, generating: false, messages: [], url: 'https://chatgpt.com/', sent: [], shown: [], stops: 0,
    state: async () => ({ ok: true, logged_in: page.logged_in, generating: page.generating, url: page.url, conversation: /\/c\//.test(page.url) ? { url: page.url } : null, model: 'GPT', assistant_count: page.messages.length, user_count: page.shown.length, last_user_text: page.shown.at(-1) || '' }),
    open: async () => { page.url = 'https://chatgpt.com/' },
    attach: async (files) => { await sleep(attachMs); return { ok: true, count: files.length } },
    send: async (text) => { page.sent.push(text); page.shown.push(text); page.url = 'https://chatgpt.com/c/conv-1'; page.generating = true; return { accepted: true } },
    answer: async () => ({ generating: page.generating, count: page.messages.length, text: page.messages.at(-1) || '', url: page.url }),
    stop: async () => { page.stops += 1; page.generating = false; return { clicked: true, stopped: true } },
  }
  return page
}

/** The page's devtools protocol, driven by the test: a request's body asked for (`posts`) answers after `postMs`. */
function fakeContents() {
  const dbg = new EventEmitter()
  dbg.attach = () => {}
  dbg.detach = () => {}
  dbg.bodies = new Map()
  dbg.posts = new Map()
  dbg.postMs = 0
  dbg.commands = []
  dbg.sendCommand = async (method, params) => {
    dbg.commands.push([method, params])
    if (method === 'Network.getRequestPostData') { await sleep(dbg.postMs); return { postData: dbg.posts.get(params.requestId) ?? '' } }
    if (method === 'Network.streamResourceContent') return { bufferedData: Buffer.from(dbg.bodies.get(params.requestId) ?? '').toString('base64') }
    if (method === 'Network.getResponseBody') return { body: Buffer.from(dbg.bodies.get(params.requestId) ?? '').toString('base64'), base64Encoded: true }
    return {}
  }
  const emit = (method, params) => dbg.emit('message', {}, method, params)
  return { contents: { debugger: dbg }, dbg, emit }
}

const sse = (d) => `data: ${JSON.stringify(d)}\n\n`
const update = (conversation, messages) => JSON.stringify({ type: 'conversation-update', payload: { conversation_id: conversation, update_type: 'add-messages', update_content: { messages } } })
const finalMsg = (id, words) => ({ id, author: { role: 'assistant' }, content: { content_type: 'text', parts: [words] }, status: 'finished_successfully', end_turn: true, recipient: 'all', channel: 'final' })
const POST = { url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST' }

test('a send whose request closes while its files upload is dropped: its words never go', async () => {
  const page = fakePage({ attachMs: 300 })
  const logs = []
  const bridge = createBridge({ page, token: 'tok', log: (l) => logs.push(l), confirmMs: 200, confirmEveryMs: 10 })
  const served = await serveBridge({ bridge, token: 'tok', port: 0, log: (l) => logs.push(l) })
  try {
    const gaveUp = new AbortController()
    const call = fetch(`${served.url}/send`, { method: 'POST', signal: gaveUp.signal, headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'cancel me', turn_id: 'turn_c', new_conversation: true }) })
    await sleep(50)
    gaveUp.abort()
    await call.catch(() => undefined)
    await sleep(500)
    assert.deepEqual(page.sent, [])
    assert.ok(logs.some((l) => l.includes('turn turn_c closed before its reply')))
    assert.equal((await bridge.answer('turn_c')).status, 'unknown')
  } finally { await served.close() }
})

test('a stop for a message on its way drops it: before its words went it never goes; while they went, its answer is stopped once it shows', async () => {
  const page = fakePage({ attachMs: 100 })
  const bridge = createBridge({ page, token: 't', confirmMs: 200, confirmEveryMs: 10 })
  const uploading = bridge.send({ text: 'x', turn_id: 'turn_early', new_conversation: true })
  await sleep(20)
  assert.deepEqual(await bridge.stop('turn_early'), { stopped: true, sent: false })
  assert.deepEqual(await uploading, { accepted: false, reason: 'cancelled' })
  assert.deepEqual(page.sent, [])
  // the words already with the page: they went, and the answer is stopped as soon as the page shows it went
  const send = page.send
  page.send = async (text) => { await sleep(50); return send(text) }
  const going = bridge.send({ text: 'y', turn_id: 'turn_late', new_conversation: true })
  await sleep(130)
  assert.deepEqual(await bridge.stop('turn_late'), { stopped: false, reason: 'sending' })
  assert.equal((await going).accepted, true)
  assert.deepEqual(page.sent, ['y'])
  assert.equal(page.stops, 1)
  assert.equal(page.generating, false)
})

test('a turn asked again while on its way (its sender restarted) is no longer dropped: it goes once, its answer is not stopped, and a later ask answers as it went', async () => {
  const page = fakePage()
  const logs = []
  const bridge = createBridge({ page, token: 'tok', log: (l) => logs.push(l), confirmMs: 500, confirmEveryMs: 10 })
  const served = await serveBridge({ bridge, token: 'tok', port: 0, log: (l) => logs.push(l) })
  const send = page.send
  page.send = async (text) => { const out = await send(text); page.shown.pop(); setTimeout(() => page.shown.push(text), 150); return out }
  const call = (body, signal) => fetch(`${served.url}/send`, { method: 'POST', signal, headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
  const request = { text: 'the event', turn_id: 'turn_r', new_conversation: true }
  try {
    const died = new AbortController()
    const first = call(request, died.signal).catch(() => undefined)
    await sleep(60)                                                                  // its words given, the page not showing them yet
    died.abort()
    await first
    await sleep(20)
    assert.deepEqual(await call(request), { accepted: false, reason: 'sending' })
    assert.equal((await call({ ...request, text: 'other words' })).reason, 'turn_conflict')
    await sleep(300)
    assert.deepEqual(await call(request), { accepted: true, message_id: 'm1', conversation: null, repeat: true })
    assert.deepEqual(page.sent, ['the event'])
    assert.equal(page.stops, 0)
    assert.equal(page.generating, true)
    assert.ok(logs.some((l) => l.includes('asked again while on its way')))
  } finally { await served.close() }
})

test('a stop whose clicks did not end the answer says the answer still forms', async () => {
  const page = fakePage()
  const bridge = createBridge({ page, token: 't', confirmMs: 100, confirmEveryMs: 10 })
  await bridge.send({ text: 'long', turn_id: 'turn_s', new_conversation: true })
  page.stop = async () => ({ clicked: true, stopped: false })
  assert.deepEqual(await bridge.stop('turn_s'), { stopped: false, reason: 'still_generating' })
})

test('a message read as not taken whose own request did leave the page is not typed a second time', async () => {
  const page = fakePage()
  let posted = null
  page.begin = () => { posted = null }
  page.heard = () => ({ events: 0, posted_at: posted })
  page.send = async (words) => { page.sent.push(words); posted = Date.now(); return { accepted: false, reason: 'no_send_button', scene: null } }
  const bridge = createBridge({ page, token: 't', sendRetryMs: 10, confirmMs: 100, confirmEveryMs: 10 })
  assert.equal((await bridge.send({ text: 'only once', turn_id: 'turn_r', new_conversation: true })).accepted, true)
  assert.equal(page.sent.length, 1)
})

test('a signed-in page with no composer this bridge knows says so, not that it is signed out', async () => {
  const page = fakePage()
  page.attach = async () => ({ ok: false, reason: 'no_composer', scene: { editables: [] } })
  const logs = []
  const bridge = createBridge({ page, token: 't', log: (l) => logs.push(l) })
  assert.deepEqual(await bridge.send({ text: 'hi', turn_id: 'turn_p', new_conversation: true }), { accepted: false, reason: 'no_composer' })
  delete page.attach
  page.send = async () => ({ accepted: false, reason: 'no_composer', scene: { editables: [] } })
  assert.deepEqual(await bridge.send({ text: 'hi', turn_id: 'turn_q' }), { accepted: false, reason: 'no_composer' })
  assert.ok(logs.some((l) => l.includes('shows no composer')))
})

test("a late socket frame of another conversation is neither the new turn's answer nor proof its message went", async () => {
  const { contents, dbg, emit } = fakeContents()
  const tap = tapPage(contents, {})
  tap.begin('turn_old')
  tap.begin('turn_new')
  emit('Network.webSocketFrameReceived', { requestId: 'ws', response: { payloadData: update('conv-OLD', [finalMsg('m-old', 'the OLD answer')]) } })
  assert.deepEqual([tap.heard('turn_new').text, tap.heard('turn_new').done, tap.heard('turn_new').events], ['', false, 0])
  // the bridge over the tap: the click went, nothing left the page — a late frame proves nothing
  const page = fakePage()
  page.begin = (id) => tap.begin(id)
  page.end = (id) => tap.end(id)
  page.heard = (id) => tap.heard(id)
  page.send = async (words) => {
    page.sent.push(words)
    setTimeout(() => emit('Network.webSocketFrameReceived', { requestId: 'ws', response: { payloadData: update('conv-OLD', [finalMsg('m-old', 'the OLD answer')]) } }), 20)
    return { accepted: true }
  }
  const bridge = createBridge({ page, token: 't', confirmMs: 150, confirmEveryMs: 10 })
  assert.deepEqual(await bridge.send({ text: 'new task', turn_id: 'turn_x', new_conversation: true }), { accepted: false, reason: 'not_sent' })
  // the turn that did not go catches nothing afterwards: a message the person then sends is theirs
  dbg.bodies.set('h1', sse({ v: { message: finalMsg('m-h', 'by hand'), conversation_id: 'c-h' }, c: 0, o: 'add', p: '' }))
  emit('Network.requestWillBeSent', { requestId: 'h1', request: POST })
  emit('Network.responseReceived', { requestId: 'h1', response: { url: POST.url, mimeType: 'text/event-stream' } })
  await sleep(5)
  assert.equal(tap.heard('turn_x').text, '')
})

test("the turn's frames count once its own request named the conversation: those of another conversation never, its own ones even when early", async () => {
  const { contents, dbg, emit } = fakeContents()
  const tap = tapPage(contents, {})
  tap.begin('turn_b')
  emit('Network.requestWillBeSent', { requestId: 'r1', request: POST })
  assert.ok(tap.heard('turn_b').posted_at > 0)
  // frames heard before the request's stream named the conversation wait for it
  emit('Network.webSocketFrameReceived', { requestId: 'ws', response: { payloadData: update('conv-OLD', [finalMsg('m-old', 'the OLD answer')]) } })
  emit('Network.webSocketFrameReceived', { requestId: 'ws', response: { payloadData: update('conv-b', [finalMsg('m-b', 'ours')]) } })
  assert.equal(tap.heard('turn_b').text, '')
  dbg.bodies.set('r1', sse({ type: 'input_message', input_message: { id: 'u-b' }, conversation_id: 'conv-b' }))
  emit('Network.responseReceived', { requestId: 'r1', response: { url: POST.url, mimeType: 'text/event-stream' } })
  await sleep(5)
  const heard = tap.heard('turn_b')
  assert.deepEqual([heard.conversation_id, heard.text, heard.done], ['conv-b', 'ours', true])
  // a resumed stream of another conversation is not the turn's
  dbg.bodies.set('r2', sse({ v: { message: finalMsg('m-z', 'elsewhere') }, c: 0, o: 'add', p: '' }))
  emit('Network.responseReceived', { requestId: 'r2', response: { url: 'https://chatgpt.com/backend-api/conversation/conv-zzzzzzzz/stream', mimeType: 'text/event-stream' } })
  await sleep(5)
  assert.equal(tap.heard('turn_b').text, 'ours')
})

test("a message request carries its body in the event: the page is listened to with room for a message's words", async () => {
  const { contents, dbg } = fakeContents()
  tapPage(contents, {})
  await sleep(0)
  const enable = dbg.commands.find(([method]) => method === 'Network.enable')
  assert.ok(enable && enable[1].maxPostDataSize >= 64 * 1024, JSON.stringify(enable))
})

test("a request whose body is asked for is no sign the turn's message went until the body shows its words", async () => {
  const { contents, dbg, emit } = fakeContents()
  const tap = tapPage(contents, {})
  dbg.postMs = 40
  tap.begin('turn_w', { words: 'oasis words' })
  dbg.posts.set('p1', JSON.stringify({ action: 'next', messages: [{ content: { parts: ['the person typed this'] } }] }))
  emit('Network.requestWillBeSent', { requestId: 'p1', request: { ...POST, hasPostData: true } })
  assert.deepEqual([tap.heard('turn_w').posted_at, tap.heard('turn_w').checking], [null, true])
  await sleep(80)
  assert.deepEqual([tap.heard('turn_w').posted_at, tap.heard('turn_w').checking], [null, false])   // the person's: let go
  dbg.posts.set('o1', JSON.stringify({ action: 'next', messages: [{ content: { parts: ['oasis words'] } }] }))
  emit('Network.requestWillBeSent', { requestId: 'o1', request: { ...POST, hasPostData: true } })
  assert.equal(tap.heard('turn_w').posted_at, null)
  await sleep(80)
  assert.ok(tap.heard('turn_w').posted_at > 0)                                     // its own: posted once its body showed it
})

test("while the person's request has its body asked for, the turn's own request (its words inline) takes its place", async () => {
  const { contents, dbg, emit } = fakeContents()
  const tap = tapPage(contents, {})
  dbg.postMs = 60
  tap.begin('turn_v', { words: 'oasis words' })
  dbg.posts.set('p1', JSON.stringify({ action: 'next', messages: [{ content: { parts: ['the person typed this'] } }] }))
  emit('Network.requestWillBeSent', { requestId: 'p1', request: { ...POST, hasPostData: true } })
  emit('Network.requestWillBeSent', { requestId: 'o1', request: { ...POST, postData: JSON.stringify({ action: 'next', messages: [{ content: { parts: ['oasis words'] } }] }) } })
  const heard = tap.heard('turn_v')
  assert.deepEqual([heard.posted_at > 0, heard.checking, heard.current], [true, false, true])
  await sleep(100)
  assert.ok(tap.heard('turn_v').posted_at > 0)                                     // the person's body, read late, unbinds nothing of it
  dbg.bodies.set('o1', sse({ v: { message: finalMsg('m-o', 'ours'), conversation_id: 'c-o' }, c: 0, o: 'add', p: '' }))
  emit('Network.responseReceived', { requestId: 'o1', response: { url: POST.url, mimeType: 'text/event-stream' } })
  await sleep(5)
  assert.equal(tap.heard('turn_v').text, 'ours')
})

test("the bridge over the tap: the person's request with its body asked for does not confirm the turn; the turn's own does", async () => {
  for (const [label, body, accepted] of [["the person's", 'the person typed this', false], ['its own', null, true]]) {
    const { contents, dbg, emit } = fakeContents()
    const tap = tapPage(contents, {})
    dbg.postMs = 60
    const page = fakePage()
    page.send = async (words) => {
      page.sent.push(words)                                                          // the click took; the page shows nothing
      dbg.posts.set('r1', JSON.stringify({ action: 'next', messages: [{ content: { parts: [body ?? words] } }] }))
      emit('Network.requestWillBeSent', { requestId: 'r1', request: { ...POST, hasPostData: true } })
      return { accepted: true }
    }
    page.begin = (id, expect) => tap.begin(id, expect)
    page.end = (id) => tap.end(id)
    page.heard = (id) => tap.heard(id)
    const bridge = createBridge({ page, token: 't', confirmMs: 300, confirmEveryMs: 10 })
    const out = await bridge.send({ text: 'oasis words', turn_id: 'turn_ask', new_conversation: true })
    assert.equal(out.accepted === true, accepted, `${label}: ${JSON.stringify(out)}`)
  }
})

test("a socket topic the turn's stream did not hand its answer on to is another answer's", () => {
  const { ChatGptStream } = require('../chatgpt_stream')
  const s = new ChatGptStream()
  s.feed(sse({ type: 'stream_handoff', conversation_id: 'conv-h', options: [{ type: 'subscribe_ws_topic', topic_id: 'conversation-turn-1' }] }))
  const topic = (id, words) => JSON.stringify([{ type: 'message', topic_id: id, payload: { type: 'stream-item', item: { message: finalMsg(`m-${id}`, words) } } }])
  s.feedFrame(topic('conversation-turn-0', 'an earlier answer'))
  assert.equal(s.snapshot().text, '')
  s.feedFrame(topic('conversation-turn-1', 'ours'))
  assert.equal(s.snapshot().text, 'ours')
})

test('a message the person sends by hand after an oasis turn is theirs: the turn keeps its answer, the connector is learnt', async () => {
  const { contents, dbg, emit } = fakeContents()
  const learnt = []
  const tap = tapPage(contents, { onConnector: (m) => learnt.push(m) })
  tap.begin('turn_done')
  dbg.bodies.set('r1', sse({ v: { message: finalMsg('m1', 'oasis answer'), conversation_id: 'c1' }, c: 0, o: 'add', p: '' }) + 'data: [DONE]\n\n')
  emit('Network.requestWillBeSent', { requestId: 'r1', request: POST })
  emit('Network.responseReceived', { requestId: 'r1', response: { url: POST.url, mimeType: 'text/event-stream' } })
  await sleep(5)
  emit('Network.loadingFinished', { requestId: 'r1' })
  await sleep(5)
  assert.equal(tap.heard('turn_done').text, 'oasis answer')
  const app = 'asdk_app_t'
  const body = JSON.stringify({ action: 'next', model: 'gpt-x', system_hints: [`plugin:${app}`], messages: [{ content: { content_type: 'text', parts: [`[$oasis-code](app://${app}) by hand`] } }] })
  dbg.bodies.set('r2', sse({ v: { message: finalMsg('m2', 'answer to the hand-sent message'), conversation_id: 'c1' }, c: 0, o: 'add', p: '' }) + 'data: [DONE]\n\n')
  emit('Network.requestWillBeSent', { requestId: 'r2', request: { ...POST, postData: body } })
  emit('Network.responseReceived', { requestId: 'r2', response: { url: POST.url, mimeType: 'text/event-stream' } })
  await sleep(5)
  emit('Network.loadingFinished', { requestId: 'r2' })
  await sleep(5)
  assert.equal(tap.heard('turn_done').text, 'oasis answer')
  assert.deepEqual(learnt, [{ mention: `[$oasis-code](app://${app})`, model: 'gpt-x' }])
})

test("every handler of the shell answers the app's own page only", () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const handlers = source.split(/(?=ipcMain\.(?:handle|on)\()/).slice(1)
  assert.ok(handlers.length >= 9)
  for (const handler of handlers) {
    const name = /^ipcMain\.\w+\('([\w-]+)'/.exec(handler)[1]
    const head = handler.split('\n').slice(0, 4).join('\n')
    assert.match(head, /event\.sender (?:===|!==) mainWindow\.webContents/, `${name} does not check who asks`)
  }
})
