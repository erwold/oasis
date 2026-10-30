const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ChatGptStream, applyOp, isConversationImage, isConversationStream, imageNameOf } = require('../chatgpt_stream')
const { tapPage } = require('../chatgpt_tap')
const { createBridge } = require('../bridge')

const sse = (event, data) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`

/** A v1 delta stream: reasoning, a connector call and its result, then the words, split at awkward places. */
function deltaStream() {
  return [
    sse('delta_encoding', '"v1"'),
    sse('delta', { p: '', o: 'add', v: { message: { id: 'm-think', author: { role: 'assistant' }, content: { content_type: 'thoughts', thoughts: [] }, status: 'in_progress', recipient: 'all' }, conversation_id: 'conv-9' }, c: 0 }),
    sse('delta', { p: '/message/content/thoughts', o: 'append', v: [{ summary: 'Planning', content: 'The person wants a cat' }], c: 0 }),
    sse('delta', { p: '/message/content/thoughts/0/content', o: 'append', v: ', drawn by Opus.' }),
    sse('delta', { p: '', o: 'add', v: { message: { id: 'm-call', author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] }, recipient: 'api_tool.call_tool', status: 'in_progress' } }, c: 1 }),
    sse('delta', { p: '/message/content/parts/0', o: 'append', v: '{"name":"send_message"}' }),
    sse('delta', { p: '', o: 'add', v: { message: { id: 'm-res', author: { role: 'tool', name: 'api_tool.call_tool' }, content: { content_type: 'text', parts: ['run_1 started'] }, recipient: 'all', status: 'finished_successfully' } }, c: 2 }),
    sse('delta', { p: '', o: 'add', v: { message: { id: 'm-ans', author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] }, recipient: 'all', status: 'in_progress' } }, c: 3 }),
    sse('delta', { p: '/message/content/parts/0', o: 'append', v: '画好了：' }),
    sse('delta', { v: '![猫](sandbox:/mnt/data/cat.png)' }),
    sse('delta', { o: 'patch', v: [{ p: '/message/status', o: 'replace', v: 'finished_successfully' }, { p: '/message/end_turn', o: 'replace', v: true }] }),
    sse('', { type: 'message_stream_complete', conversation_id: 'conv-9' }),
    sse('', '[DONE]'),
  ].join('')
}

test('the v1 delta stream reads as reasoning, steps and words, whatever the chunking', () => {
  const whole = deltaStream()
  for (const size of [whole.length, 7, 1]) {
    const s = new ChatGptStream()
    for (let i = 0; i < whole.length; i += size) s.feed(whole.slice(i, i + size))
    const snap = s.snapshot()
    assert.equal(snap.thinking, 'Planning\nThe person wants a cat, drawn by Opus.')
    assert.deepEqual(snap.steps.map((x) => [x.kind, x.name]), [['call', 'api_tool.call_tool'], ['result', 'api_tool.call_tool']])
    assert.equal(snap.steps[0].summary, '{"name":"send_message"}')
    assert.equal(snap.text, '画好了：![猫](sandbox:/mnt/data/cat.png)')
    assert.equal(snap.done, true)
    assert.equal(snap.conversation_id, 'conv-9')
    assert.equal(snap.message_id, 'm-ans')
  }
})

test('while it forms, the stream says what it has and that it is not done', () => {
  const s = new ChatGptStream()
  const whole = deltaStream()
  s.feed(whole.slice(0, whole.indexOf('画好了') + 2))                 // cut inside the event that holds 画好了
  const snap = s.snapshot()
  assert.equal(snap.done, false)
  assert.match(snap.thinking, /wants a cat/)
  assert.equal(snap.text, '')                                   // that event is not complete yet
})

test('the older shape: whole messages per event', () => {
  const s = new ChatGptStream()
  s.feed(sse('', { message: { id: 'a1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Hel'] }, status: 'in_progress', recipient: 'all' }, conversation_id: 'c-1' }))
  s.feed(sse('', { message: { id: 'a1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Hello there'] }, status: 'finished_successfully', end_turn: true, recipient: 'all' }, conversation_id: 'c-1' }))
  const snap = s.snapshot()
  assert.equal(snap.text, 'Hello there')
  assert.equal(snap.done, true)
  assert.equal(s.messages().length, 1)
})

test('operations: append, replace, truncate, remove; junk is ignored', () => {
  assert.deepEqual(applyOp({ a: 'x' }, '/a', 'append', 'y'), { a: 'xy' })
  assert.deepEqual(applyOp({ a: [1] }, '/a', 'append', [2, 3]), { a: [1, 2, 3] })
  assert.deepEqual(applyOp({ a: 'hello' }, '/a', 'truncate', 2), { a: 'he' })
  assert.deepEqual(applyOp({ a: 1, b: 2 }, '/b', 'remove'), { a: 1 })
  assert.deepEqual(applyOp({}, '/x~1y/0', 'add', 'z'), { 'x/y': ['z'] })
  const s = new ChatGptStream()
  s.feed('data: not json\n\nevent: ping\ndata: {}\n\n: comment\n\n')
  assert.equal(s.snapshot().text, '')
  assert.equal(s.snapshot().done, false)
})

test('which requests are the answer stream, which images belong to the answer, and their names', () => {
  assert.equal(isConversationStream('https://chatgpt.com/backend-api/f/conversation', 'POST'), true)
  assert.equal(isConversationStream('https://chatgpt.com/backend-api/conversation', 'POST'), true)
  assert.equal(isConversationStream('https://chatgpt.com/backend-api/conversation/abc/stream', 'GET'), true)
  assert.equal(isConversationStream('https://chatgpt.com/backend-api/conversations?offset=0', 'GET'), false)
  assert.equal(isConversationStream('https://evil.example/backend-api/conversation', 'POST'), false)
  assert.equal(isConversationImage('https://files.oaiusercontent.com/file-1?se=1', 'image/png'), true)
  assert.equal(isConversationImage('https://chatgpt.com/backend-api/estuary/content?id=file-2', 'image/webp'), true)
  assert.equal(isConversationImage('https://chatgpt.com/cdn/assets/logo.png', 'image/png'), false)
  assert.equal(isConversationImage('https://files.oaiusercontent.com/file-1', 'application/json'), false)
  assert.equal(imageNameOf('https://files.oaiusercontent.com/file-1?rscd=attachment%3B%20filename%3Dcat.png', 'image/png'), 'cat.png')
  assert.equal(imageNameOf('https://chatgpt.com/backend-api/estuary/content?id=file-2abc', 'image/webp'), 'file-2abc.webp')
})

/** A page whose devtools protocol the test plays: requests, streamed bodies, images. */
function fakeContents() {
  const dbg = new EventEmitter()
  dbg.attached = false
  dbg.attach = () => { dbg.attached = true }
  dbg.detach = () => { dbg.attached = false }
  dbg.bodies = new Map()
  dbg.sendCommand = async (method, params) => {
    if (method === 'Network.streamResourceContent') return { bufferedData: Buffer.from(dbg.bodies.get(params.requestId) ?? '').toString('base64') }
    if (method === 'Network.getResponseBody') return { body: dbg.bodies.get(params.requestId), base64Encoded: true }
    return {}
  }
  const emit = (method, params) => dbg.emit('message', {}, method, params)
  return { contents: { debugger: dbg }, dbg, emit }
}

test("the tap hears the turn's stream live and keeps the images the page loads for it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-tap-'))
  try {
    const { contents, dbg, emit } = fakeContents()
    const tap = tapPage(contents, { captureDir: dir })
    assert.equal(dbg.attached, true)
    // before any turn: nothing is attributed
    emit('Network.requestWillBeSent', { requestId: 'r0', request: { url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST' } })
    tap.begin('turn_a')
    const whole = deltaStream()
    const cut = whole.indexOf('event: delta\ndata: {"p":"","o":"add","v":{"message":{"id":"m-ans"')
    dbg.bodies.set('r1', whole.slice(0, cut))
    emit('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST' } })
    emit('Network.responseReceived', { requestId: 'r1', response: { url: 'https://chatgpt.com/backend-api/f/conversation', mimeType: 'text/event-stream' } })
    await new Promise((r) => setImmediate(r))
    let heard = tap.heard('turn_a')
    assert.equal(heard.done, false)
    assert.match(heard.thinking, /wants a cat/)
    assert.equal(heard.steps.length, 2)
    emit('Network.dataReceived', { requestId: 'r1', data: Buffer.from(whole.slice(cut)).toString('base64') })
    emit('Network.loadingFinished', { requestId: 'r1' })
    heard = tap.heard('turn_a')
    assert.equal(heard.done, true)
    assert.equal(heard.text, '画好了：![猫](sandbox:/mnt/data/cat.png)')
    assert.ok(heard.done_at > 0)
    // an image of the answer, once; a tiny one and the app's own art are not kept
    const png = Buffer.alloc(4096, 7)
    dbg.bodies.set('i1', png.toString('base64'))
    dbg.bodies.set('i2', Buffer.alloc(100).toString('base64'))
    emit('Network.responseReceived', { requestId: 'i1', response: { url: 'https://files.oaiusercontent.com/file-1?rscd=attachment%3B%20filename%3Dcat.png', mimeType: 'image/png' } })
    emit('Network.responseReceived', { requestId: 'i2', response: { url: 'https://files.oaiusercontent.com/file-2', mimeType: 'image/png' } })
    emit('Network.responseReceived', { requestId: 'i3', response: { url: 'https://chatgpt.com/cdn/assets/logo.png', mimeType: 'image/png' } })
    for (const id of ['i1', 'i2', 'i3']) emit('Network.loadingFinished', { requestId: id })
    await new Promise((r) => setImmediate(r))
    heard = tap.heard('turn_a')
    assert.deepEqual(heard.images.map((i) => [i.name, i.media_type, Buffer.from(i.data_base64, 'base64').length]), [['cat.png', 'image/png', 4096]])
    assert.equal(tap.heard('turn_zz'), null)
    assert.match(fs.readFileSync(path.join(dir, 'turn_a.txt'), 'utf8'), /### POST \/backend-api\/f\/conversation[\s\S]*message_stream_complete/)
    tap.detach()
    assert.equal(dbg.attached, false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the bridge answers from what it heard: progress while it forms, then the words, the reasoning and the images', async () => {
  let heard = null
  let sent = false                                                     // a sent message: its request left the page, an answer forms
  const page = {
    state: async () => ({ ok: true, logged_in: true, generating: sent, url: 'https://chatgpt.com/', model: 'GPT-6 Pro', assistant_count: 0 }),
    open: async () => {},
    send: async () => { sent = true; heard.posted_at = Date.now(); return { accepted: true } },
    answer: async () => ({ generating: false, count: 0, text: '', url: 'https://chatgpt.com/' }),
    begin: (id) => { heard = { id, events: 0, thinking: '', steps: [], text: '', done: false, done_at: null, images: [], conversation_id: null, posted_at: null } },
    heard: (id) => (heard && heard.id === id ? heard : null),
  }
  const bridge = createBridge({ page, token: 't' })
  assert.equal((await bridge.send({ text: 'draw a cat', turn_id: 'turn_b' })).accepted, true)
  assert.equal(heard.id, 'turn_b')
  Object.assign(heard, { events: 5, thinking: 'Planning', steps: [{ kind: 'call', name: 'api_tool.call_tool', summary: 'send_message' }], text: '画', conversation_id: 'conv-9' })
  const forming = await bridge.answer('turn_b')
  assert.equal(forming.status, 'generating')
  assert.deepEqual(forming.progress, { thinking: 'Planning', text: '画', steps: [{ kind: 'call', name: 'api_tool.call_tool', summary: 'send_message' }] })
  assert.deepEqual(forming.conversation, { url: 'https://chatgpt.com/c/conv-9' })
  Object.assign(heard, { text: '画好了', done: true, done_at: Date.now() })
  assert.equal((await bridge.answer('turn_b')).status, 'generating')          // a moment for the images
  Object.assign(heard, { done_at: Date.now() - 10_000, images: [{ name: 'cat.png', media_type: 'image/png', data_base64: 'AAAA' }] })
  const done = await bridge.answer('turn_b')
  assert.equal(done.status, 'done')
  assert.equal(done.text, '画好了')
  assert.equal(done.thinking, 'Planning')
  assert.equal(done.model, 'GPT-6 Pro')
  assert.deepEqual(done.images.map((i) => i.name), ['cat.png'])
})

/** The shape seen on chatgpt.com (2026-09-27, a reasoning model): the request's stream ends after the first thoughts;
 *  the answer goes on over the page's socket, each message whole, the reasoning on channel analysis, an image made
 *  by a tool, and a final message that ends the turn with no words. */
function backgroundAnswer() {
  const post = [
    sse('delta_encoding', '"v1"'),
    sse('', { type: 'resume_conversation_token', kind: 'topic', token: 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4eCJ9.c2lnbmF0dXJl', conversation_id: 'conv-bg' }),
    sse('', { type: 'message_marker', conversation_id: 'conv-bg', message_id: 'm-t', marker: 'cot_token', event: 'first' }),
    sse('delta', { p: '', o: 'add', v: { message: { id: 'm-t', author: { role: 'assistant' }, content: { content_type: 'thoughts', thoughts: [{ summary: '思考中', content: '', finished: false }] }, status: 'in_progress', end_turn: false, recipient: 'all' }, conversation_id: 'conv-bg' }, c: 0 }),
    sse('', { type: 'message_stream_complete', conversation_id: 'conv-bg' }),
    sse('', '[DONE]'),
  ].join('')
  const update = (messages, conversation = 'conv-bg') => JSON.stringify({ type: 'conversation-update', payload: { conversation_id: conversation, update_type: 'add-messages', update_content: { messages } }, metadata: null })
  const msg = (id, role, content, extra = {}) => ({ id, author: { role, name: role === 'tool' ? 't2uay3k.sj1i4kz' : null }, content, status: 'finished_successfully', end_turn: false, recipient: 'all', ...extra })
  const frames = [
    JSON.stringify([{ id: 1, type: 'reply', reply: { type: 'connect', subscriptions: {} } }]),
    update([msg('m-a', 'assistant', { content_type: 'text', parts: ['We need to draw a cat for the person.'] }, { channel: 'analysis' })]),
    update([msg('m-x', 'assistant', { content_type: 'text', parts: ['not ours'] }, { channel: 'final', end_turn: true })], 'conv-other'),
    update([msg('m-c', 'assistant', { content_type: 'code', text: '{"prompt":"a cat"}' }, { recipient: 't2uay3k.sj1i4kz' })]),
    update([msg('m-t', 'tool', { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_000000009b1c', mime_type: 'image/png', width: 1254, height: 1254 }] })]),
    update([msg('m-r', 'assistant', { content_type: 'reasoning_recap', content: 'Worked for 25s' })]),
    JSON.stringify([{ type: 'message', topic_id: 'conversations', payload: update([msg('m-f', 'assistant', { content_type: 'text', parts: [''] }, { channel: 'final', end_turn: true })]) && JSON.parse(update([msg('m-f', 'assistant', { content_type: 'text', parts: [''] }, { channel: 'final', end_turn: true })])) }]),
  ]
  return { post, frames }
}

test('an answer that goes on over the socket: not done when the request stream ends; done when a message ends the turn', () => {
  const { post, frames } = backgroundAnswer()
  const s = new ChatGptStream()
  s.feed(post)
  assert.equal(s.snapshot().done, false)                        // the request's stream ended; the answer did not
  assert.equal(s.snapshot().conversation_id, 'conv-bg')
  for (const f of frames.slice(0, -1)) s.feedFrame(f)
  let snap = s.snapshot()
  assert.equal(snap.done, false)
  assert.equal(snap.thinking, 'We need to draw a cat for the person.')   // channel analysis is reasoning, not words
  assert.equal(snap.text, '')                                            // another conversation's answer is not ours
  assert.deepEqual(snap.steps.map((x) => [x.kind, x.summary]), [['call', '{"prompt":"a cat"}'], ['result', 'an image'], ['recap', '']])
  assert.deepEqual(snap.pointers, [{ pointer: 'sediment://file_000000009b1c', media_type: 'image/png', width: 1254, height: 1254 }])
  assert.equal(s.messages().filter((m) => m.id === 'm-t').length, 1)     // heard on the stream and the socket: once, the later
  assert.equal(s.messages().find((m) => m.id === 'm-t').author.role, 'tool')
  s.feedFrame(frames.at(-1))
  snap = s.snapshot()
  assert.equal(snap.done, true)
  assert.equal(snap.text, '')
  s.feedFrame('not json')
})

test('the tap takes the socket in; the capture keeps no token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-tap-'))
  try {
    const { redact } = require('../chatgpt_tap')
    assert.equal(redact('{"token":"abc","resume_token" : "def","x":"eyJhbGciOi12345.eyJzdWIiOi12345.sig"}'), '{"token":"<redacted>","resume_token":"<redacted>","x":"<redacted>"}')
    const { contents, dbg, emit } = fakeContents()
    const tap = tapPage(contents, { captureDir: dir })
    tap.begin('turn_bg')
    const { post, frames } = backgroundAnswer()
    dbg.bodies.set('r1', post)
    emit('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST', postData: '{"action":"next","messages":[]}' } })
    emit('Network.responseReceived', { requestId: 'r1', response: { url: 'https://chatgpt.com/backend-api/f/conversation', mimeType: 'text/event-stream' } })
    await new Promise((r) => setImmediate(r))
    emit('Network.loadingFinished', { requestId: 'r1' })
    assert.equal(tap.heard('turn_bg').done, false)
    for (const f of frames) emit('Network.webSocketFrameReceived', { requestId: 'ws', response: { payloadData: f } })
    const heard = tap.heard('turn_bg')
    assert.equal(heard.done, true)
    assert.ok(heard.done_at > 0)
    assert.equal(heard.pointers.length, 1)
    const captured = fs.readFileSync(path.join(dir, 'turn_bg.txt'), 'utf8')
    assert.doesNotMatch(captured, /eyJhbGciOiJFUzI1NiJ9/)
    assert.match(captured, /### body \{"action":"next"/)
    assert.match(captured, /### ws frame/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test("an answer that is only a picture: the bridge has the page fetch it and says so in words", async () => {
  let heard = null
  const asked = []
  const page = {
    state: async () => ({ ok: true, logged_in: true, generating: false, url: 'https://chatgpt.com/', model: 'GPT-6 Pro', assistant_count: 0 }),
    open: async () => {},
    send: async () => ({ accepted: true }),
    answer: async () => ({ generating: false, count: 0, text: '', url: 'https://chatgpt.com/' }),
    begin: (id) => { heard = { id, events: 9, thinking: 'draw', steps: [], text: '', done: true, done_at: Date.now() - 10_000, images: [], pointers: [{ pointer: 'sediment://file_000000009b1c' }], conversation_id: 'conv-bg' } },
    heard: (id) => (heard && heard.id === id ? heard : null),
    images: async (ids) => { asked.push(ids); return [{ name: 'file_000000009b1c.png', media_type: 'image/png', data_base64: 'AAAA' }] },
  }
  const bridge = createBridge({ page, token: 't' })
  await bridge.send({ text: 'draw a cat', turn_id: 'turn_img' })
  const done = await bridge.answer('turn_img')
  assert.deepEqual(asked, [{ ids: ['file_000000009b1c'], pictures: [] }])
  assert.equal(done.status, 'done')
  assert.equal(done.text, 'ChatGPT answered with an image.')
  assert.deepEqual(done.images.map((i) => i.name), ['file_000000009b1c.png'])
})

/** The shape seen on chatgpt.com (2026-09-27, an Instant turn): an image tool's call and its picture on the request's
 *  stream, which then ends — no closing message. */
test('an answer that is only a picture on the request stream is complete when the stream ends', () => {
  const s = new ChatGptStream()
  s.feed([
    sse('delta_encoding', '"v1"'),
    sse('delta', { p: '', o: 'add', v: { message: { id: 'm-c', author: { role: 'assistant' }, content: { content_type: 'code', language: 'python3', text: '{"prompt":"a cat"}' }, status: 'in_progress', recipient: 't2uay3k.sj1i4kz' }, conversation_id: 'conv-i' }, c: 0 }),
    sse('delta', { p: '/message/status', o: 'replace', v: 'finished_successfully' }),
    sse('delta', { p: '', o: 'add', v: { message: { id: 'm-t', author: { role: 'tool', name: 't2uay3k.sj1i4kz' }, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_1', mime_type: 'image/png' }] }, status: 'finished_successfully', recipient: 'all' } }, c: 1 }),
  ].join(''))
  assert.equal(s.snapshot().done, false)                        // the stream has not ended yet
  s.feed(sse('', { type: 'message_stream_complete', conversation_id: 'conv-i' }) + sse('', '[DONE]'))
  const snap = s.snapshot()
  assert.equal(snap.done, true)
  assert.equal(snap.pointers.length, 1)
  assert.equal(snap.text, '')
})

test('an answer gone on over the socket whose closing message never comes ends after a quiet minute', () => {
  const { post, frames } = backgroundAnswer()
  const s = new ChatGptStream()
  s.feed(post)
  for (const f of frames.slice(0, -1)) s.feedFrame(f)
  assert.equal(s.snapshot().done, false)
  assert.equal(s.snapshot(Date.now() + 61_000).done, true)
})

test('a message the person sends on the page themselves has its body recorded, asked for when the event lacks it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-tap-'))
  try {
    const { contents, dbg, emit } = fakeContents()
    const send = dbg.sendCommand
    dbg.sendCommand = async (method, params) => (method === 'Network.getRequestPostData' ? { postData: '{"model":"gpt-6-pro","token":"secret"}' } : send(method, params))
    tapPage(contents, { captureDir: dir })
    emit('Network.requestWillBeSent', { requestId: 'm1', request: { url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST', hasPostData: true } })
    await new Promise((r) => setImmediate(r))
    const [file] = fs.readdirSync(dir)
    assert.match(file, /^manual-\d{4}-\d\d-\d\d\.txt$/)
    const text = fs.readFileSync(path.join(dir, file), 'utf8')
    assert.match(text, /### body \{"model":"gpt-6-pro","token":"<redacted>"\}/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test("oasis-code's message goes as the page sends a hand-chosen model and an @-mentioned connector", () => {
  const { patchConversationBody } = require('../chatgpt_stream')
  const sent = JSON.stringify({ action: 'next', model: 'auto', parent_message_id: 'client-created-root', messages: [{ id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['[oasis-code] You are the director…\n\n画一只猫'] }, metadata: {} }], supported_encodings: ['v1'] })
  const app = 'asdk_app_6ab76cd077ec8191b06a2100bf24b186'
  const out = JSON.parse(patchConversationBody(sent, { model: 'gpt-6-pro', appId: app, markdown: `[$oasis-code](app://${app})` }))
  // the shape of the message the owner sent by hand with Pro chosen and the connector mentioned
  assert.equal(out.model, 'gpt-6-pro')
  assert.deepEqual(out.system_hints, [`plugin:${app}`])
  assert.deepEqual(out.messages[0].metadata, { serialization_metadata: { render_format: 'markdown' }, system_hints: [`plugin:${app}`] })
  assert.equal(out.messages[0].content.parts[0], `[$oasis-code](app://${app}) [oasis-code] You are the director…\n\n画一只猫`)
  assert.deepEqual(out.supported_encodings, ['v1'])
  // applied twice: no second hint, no second mention
  const again = JSON.parse(patchConversationBody(JSON.stringify(out), { model: 'gpt-6-pro', appId: app, markdown: `[$oasis-code](app://${app})` }))
  assert.deepEqual(again, out)
  // nothing to add: only what was asked; not a new message: untouched
  assert.equal(JSON.parse(patchConversationBody(sent, {})).model, 'auto')
  assert.equal(JSON.parse(patchConversationBody(sent, { model: 'gpt-6-pro' })).system_hints, undefined)
  assert.equal(patchConversationBody(JSON.stringify({ action: 'variant', messages: [] }), { model: 'x' }), null)
  assert.equal(patchConversationBody('not json', { model: 'x' }), null)
})

test('an armed turn: the next message request is paused, changed and let go; the rest pass; then nothing is paused', async () => {
  const { contents, dbg, emit } = fakeContents()
  const calls = []
  const send = dbg.sendCommand
  dbg.sendCommand = async (method, params) => { calls.push([method, params]); return send(method, params) }
  const logs = []
  const tap = tapPage(contents, { log: (l) => logs.push(l) })
  const app = 'asdk_app_1'
  tap.arm('turn_p', { model: 'gpt-6-pro', appId: app, markdown: `[$oasis-code](app://${app})` })
  await new Promise((r) => setImmediate(r))
  const enable = calls.find(([m]) => m === 'Fetch.enable')
  assert.deepEqual(enable[1].patterns.map((p) => p.urlPattern), ['*://chatgpt.com/backend-api/f/conversation', '*://chatgpt.com/backend-api/conversation'])
  emit('Fetch.requestPaused', { requestId: 'other', request: { url: 'https://chatgpt.com/backend-api/conversation', method: 'GET' } })
  const body = JSON.stringify({ action: 'next', model: 'auto', messages: [{ content: { content_type: 'text', parts: ['hi'] }, metadata: {} }] })
  emit('Fetch.requestPaused', { requestId: 'mine', request: { url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST', postData: body } })
  emit('Fetch.requestPaused', { requestId: 'later', request: { url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST', postData: body } })
  await new Promise((r) => setImmediate(r))
  const goes = calls.filter(([m]) => m === 'Fetch.continueRequest').map(([, p]) => p)
  assert.deepEqual(goes.map((p) => p.requestId), ['other', 'mine', 'later'])     // every paused request goes on
  assert.equal(goes[0].postData, undefined)
  const changed = JSON.parse(Buffer.from(goes[1].postData, 'base64').toString('utf8'))
  assert.equal(changed.model, 'gpt-6-pro')
  assert.deepEqual(changed.system_hints, [`plugin:${app}`])
  assert.equal(changed.messages[0].content.parts[0], `[$oasis-code](app://${app}) hi`)
  assert.equal(goes[2].postData, undefined)                                      // once: the next one is the person's
  assert.ok(calls.some(([m]) => m === 'Fetch.disable'))
  assert.ok(logs.includes('[bridge] turn turn_p went with model gpt-6-pro and the connector'))
  tap.arm('turn_q', {})                                                          // nothing to add: nothing paused
  assert.equal(calls.filter(([m]) => m === 'Fetch.enable').length, 1)
})

test('an answer handed on to the socket: event text, deltas and whole messages carried in frames are read', () => {
  const s = new ChatGptStream()
  s.feed([
    sse('delta_encoding', '"v1"'),
    sse('delta', { p: '', o: 'add', v: { message: { id: 'u', author: { role: 'user' }, content: { content_type: 'text', parts: ['draw'] }, status: 'finished_successfully', recipient: 'all' }, conversation_id: 'conv-h' }, c: 0 }),
    sse('', { type: 'stream_handoff', conversation_id: 'conv-h', options: [{ type: 'subscribe_ws_topic', topic_id: 'conversation-turn-1' }] }),
    sse('', '[DONE]'),
  ].join(''))
  assert.equal(s.snapshot().done, false)
  const topic = (payload) => JSON.stringify([{ type: 'message', topic_id: 'conversation-turn-1', payload }])
  s.feedFrame(topic({ type: 'stream-item', encoded_item: sse('delta', { p: '', o: 'add', v: { message: { id: 'a', author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] }, status: 'in_progress', recipient: 'all', channel: 'final' } }, c: 1 }) }))
  s.feedFrame(topic({ type: 'stream-item', item: { p: '/message/content/parts/0', o: 'append', v: '画好了' } }))
  assert.equal(s.snapshot().text, '画好了')
  assert.equal(s.snapshot().done, false)
  s.feedFrame(topic({ type: 'stream-item', item: { message: { id: 'a', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['画好了。'] }, status: 'finished_successfully', end_turn: true, recipient: 'all', channel: 'final' }, conversation_id: 'conv-h' } }))
  const snap = s.snapshot()
  assert.equal(snap.text, '画好了。')
  assert.equal(snap.done, true)
  s.feedFrame(topic({ item: { message: { id: 'z', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['other'] }, status: 'finished_successfully', end_turn: true, recipient: 'all' }, conversation_id: 'conv-other' } }))
  assert.equal(s.snapshot().text, '画好了。')                                  // another conversation's is not ours
})

test('an event stream the page opens while a turn is on is the turn\'s, whatever its address', async () => {
  const { contents, dbg, emit } = fakeContents()
  const tap = tapPage(contents, {})
  tap.begin('turn_h')
  emit('Network.requestWillBeSent', { requestId: 'r8', request: { url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST' } })
  dbg.bodies.set('r9', sse('delta', { p: '', o: 'add', v: { message: { id: 'a', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['hi'] }, status: 'finished_successfully', end_turn: true, recipient: 'all' } }, c: 0 }))
  emit('Network.responseReceived', { requestId: 'r9', response: { url: 'https://chatgpt.com/backend-api/some/resume/path?topic=x', mimeType: 'text/event-stream' } })
  emit('Network.responseReceived', { requestId: 'r10', response: { url: 'https://elsewhere.example/sse', mimeType: 'text/event-stream' } })
  await new Promise((r) => setImmediate(r))
  const heard = tap.heard('turn_h')
  assert.equal(heard.text, 'hi')
  assert.equal(heard.done, true)
})

test("the answer's sandbox pictures are asked of the page by their alt text and kept under their file names", async () => {
  const { sandboxPicturesOf } = require('../chatgpt_dom')
  const text = '画好了\n\n![Claude Opus 5.5 画的小橘猫](sandbox:/mnt/data/claude-opus-5.5-cat.png)\n\n[下载 PNG](sandbox:/mnt/data/claude-opus-5.5-cat.png) · [SVG](sandbox:/mnt/data/cat.svg)'
  assert.deepEqual(sandboxPicturesOf(text), [{ alt: 'Claude Opus 5.5 画的小橘猫', name: 'claude-opus-5.5-cat.png' }])   // links are not pictures
  let heard = null
  const asked = []
  const page = {
    state: async () => ({ ok: true, logged_in: true, generating: false, url: 'https://chatgpt.com/', model: 'GPT-6 Pro', assistant_count: 0 }),
    open: async () => {}, send: async () => ({ accepted: true }),
    answer: async () => ({ generating: false, count: 0, text: '', url: 'https://chatgpt.com/' }),
    begin: (id) => { heard = { id, events: 9, thinking: '', steps: [], text, done: true, done_at: Date.now() - 10_000, images: [], pointers: [], conversation_id: 'c' } },
    heard: (id) => (heard && heard.id === id ? heard : null),
    images: async (want) => { asked.push(want); return [{ name: 'claude-opus-5.5-cat.png', media_type: 'image/png', data_base64: 'AAAA' }] },
  }
  const bridge = createBridge({ page, token: 't' })
  await bridge.send({ text: 'draw', turn_id: 'turn_s' })
  const done = await bridge.answer('turn_s')
  assert.deepEqual(asked, [{ ids: [], pictures: [{ alt: 'Claude Opus 5.5 画的小橘猫', name: 'claude-opus-5.5-cat.png' }] }])
  assert.equal(done.text, text)
  assert.deepEqual(done.images.map((i) => i.name), ['claude-opus-5.5-cat.png'])
})

test('the oasis-code connector is learnt from a message the person sent with it @-mentioned, and kept', async () => {
  const { connectorOfBody } = require('../chatgpt_stream')
  const { connectorOf, rememberConnector, CONNECTOR_FILE } = require('../bridge')
  const app = 'asdk_app_6ab76cd077ec8191b06a2100bf24b186'
  const hand = (parts, hints) => JSON.stringify({ action: 'next', model: 'gpt-6-pro', system_hints: hints, messages: [{ content: { content_type: 'text', parts }, metadata: { system_hints: hints } }] })
  assert.equal(connectorOfBody(hand([`[$oasis-code](app://${app}) hi`], [`plugin:${app}`])), `[$oasis-code](app://${app})`)
  assert.equal(connectorOfBody(hand([`[$oasis-code](app://${app}) hi`], [])), null)                    // not an actual mention
  assert.equal(connectorOfBody(hand(['[$Trip.com](app://asdk_app_trip) hi'], ['plugin:asdk_app_trip'])), null)   // another app
  assert.equal(connectorOfBody('nope'), null)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-conn-'))
  try {
    assert.equal(connectorOf(dir), null)
    assert.equal(rememberConnector(dir, 'not a mention'), false)
    assert.equal(rememberConnector(dir, ` [$oasis-code](app://${app}) `), true)
    assert.equal(connectorOf(dir), `[$oasis-code](app://${app})`)
    assert.equal(fs.statSync(path.join(dir, CONNECTOR_FILE)).mode & 0o777, 0o600)
    // the tap hands a hand-sent mention over
    const { contents, emit } = fakeContents()
    const learnt = []
    tapPage(contents, { onConnector: (m) => learnt.push(m) })
    emit('Network.requestWillBeSent', { requestId: 'h1', request: { url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST', postData: hand([`[$oasis-code](app://${app}) hi`], [`plugin:${app}`]) } })
    assert.deepEqual(learnt, [{ mention: `[$oasis-code](app://${app})`, model: 'gpt-6-pro' }])
    const { chatGptPrefs } = require('../bridge')
    assert.deepEqual(chatGptPrefs(dir), { mention: `[$oasis-code](app://${app})`, model: null })
    const { rememberChatGpt } = require('../bridge')
    assert.equal(rememberChatGpt(dir, { model: 'gpt-6-pro' }), true)                  // the model joins the connector
    assert.equal(rememberChatGpt(dir, { model: 'auto' }), false)                      // "auto" is no choice
    assert.equal(rememberChatGpt(dir, { mention: 'junk', model: 'gpt-6-pro' }), false)
    assert.deepEqual(chatGptPrefs(dir), { mention: `[$oasis-code](app://${app})`, model: 'gpt-6-pro' })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test("the answer is the final channel's words; progress lines (commentary) go with the thinking", () => {
  const s = new ChatGptStream()
  const update = (m) => JSON.stringify({ type: 'conversation-update', payload: { conversation_id: 'c', update_type: 'add-messages', update_content: { messages: [m] } } })
  const msg = (id, channel, words, extra = {}) => ({ id, author: { role: 'assistant' }, channel, recipient: 'all', content: { content_type: 'text', parts: [words] }, status: 'finished_successfully', end_turn: false, ...extra })
  s.feedFrame(update(msg('f', 'final', '画好了！这是 Claude Opus 5.5 画的橘白小猫', { end_turn: true })))
  s.feedFrame(update(msg('p', 'commentary', '一条路径里 Claude 已画好绿眼睛、卷尾巴')))       // heard after the answer
  const snap = s.snapshot()
  assert.equal(snap.text, '画好了！这是 Claude Opus 5.5 画的橘白小猫')
  assert.match(snap.thinking, /一条路径里/)
  assert.equal(snap.done, true)
  assert.ok(snap.last_at > 0)
})

test("ChatGPT's citation markers become the pages they cite; a marker nothing names is left out, never shown", () => {
  const { citedText } = require('../chatgpt_stream')
  const one = 'citeturn945630view0turn691511view2'
  const metadata = { content_references: [
    { matched_text: one, type: 'grouped_webpages', alt: '([arXiv](https://arxiv.org/html/1806.07366))',
      items: [{ url: 'https://arxiv.org/html/1806.07366', attribution: 'arXiv', supporting_websites: [{ url: 'https://arxiv.org/html/2011.13456', attribution: 'arXiv' }] }] },
    { matched_text: 'citeturn1view0', type: 'grouped_webpages', alt: '([Wiki](https://en.wikipedia.org/wiki/ODE))', items: [] },
    { matched_text: ' ', type: 'sources_footnote', alt: '' },
  ] }
  const words = `ODE flows use this. ${one}\n\nSee alsociteturn1view0 and citeturn7view3 here.  \nNext line citetur`
  assert.equal(citedText(words, metadata),
    'ODE flows use this. ([arXiv](https://arxiv.org/html/1806.07366), [arXiv](https://arxiv.org/html/2011.13456))\n\nSee also ([Wiki](https://en.wikipedia.org/wiki/ODE)) and here.  \nNext line')
  assert.equal(citedText('no citations  \nhere', {}), 'no citations  \nhere')      // a hard line break stays
})

/** The shape seen on chatgpt.com (2026-09-30, GPT-6 Pro): the request's stream names the message sent and hands the
 *  turn on to the socket; the turn's topic carries two metadata frames and ends; the answer is made in the background
 *  and only the conversation has it. */
function handedOffInBackground() {
  return [
    sse('delta_encoding', '"v1"'),
    sse('', { type: 'input_message', input_message: { id: 'm-sent', author: { role: 'user' }, content: { content_type: 'text', parts: ['review this'] } }, conversation_id: 'conv-7' }),
    sse('delta', { p: '', o: 'add', v: { message: { id: 'm-tool', author: { role: 'tool', name: 'a8km123' }, content: { content_type: 'text', parts: [''] }, status: 'in_progress', recipient: 'all', metadata: { async_source: 'saserver' } }, conversation_id: 'conv-7' }, c: 0 }),
    sse('', { type: 'stream_handoff', conversation_id: 'conv-7', options: [{ type: 'subscribe_ws_topic', topic_id: 'conversation-turn-1' }] }),
  ].join('')
}
const readBackAnswer = () => [
  { id: 'm-tool', author: { role: 'tool', name: 'a8km123' }, content: { content_type: 'text', parts: [''] }, status: 'finished_successfully', recipient: 'all' },
  { id: 'm-think', author: { role: 'assistant' }, content: { content_type: 'thoughts', thoughts: [{ summary: 'Checking', content: 'The review holds.' }] }, status: 'finished_successfully', recipient: 'all' },
  { id: 'm-call', author: { role: 'assistant' }, content: { content_type: 'code', text: 'print(1)' }, status: 'finished_successfully', recipient: 'container.exec' },
  { id: 'm-out', author: { role: 'tool', name: 'container.exec' }, content: { content_type: 'execution_output', text: '1' }, status: 'finished_successfully', recipient: 'all' },
  { id: 'm-final', author: { role: 'assistant' }, channel: 'final', content: { content_type: 'text', parts: ['第三轮回应'] }, status: 'finished_successfully', end_turn: true, recipient: 'all' },
]

test('the message sent is named; messages read back from the conversation are taken in once each, and end the turn', () => {
  const stream = new ChatGptStream()
  stream.feed(handedOffInBackground())
  const quiet = stream.snapshot()
  assert.equal(quiet.input_message_id, 'm-sent')
  assert.equal(quiet.conversation_id, 'conv-7')
  assert.equal(quiet.done, false)
  assert.equal(quiet.text, '')
  stream.feedMessages(readBackAnswer().slice(0, 2))
  assert.equal(stream.snapshot().done, false)
  const events = stream.events
  stream.feedMessages(readBackAnswer().slice(0, 2))                          // read again, unchanged: nothing new
  assert.equal(stream.events, events)
  stream.feedMessages([...readBackAnswer(), { id: 'junk' }, null])
  const done = stream.snapshot()
  assert.equal(done.done, true)
  assert.equal(done.text, '第三轮回应')
  assert.equal(done.message_id, 'm-final')
  assert.equal(done.thinking, 'Checking\nThe review holds.')
  assert.deepEqual(done.steps.map((s) => [s.kind, s.name]), [['result', 'a8km123'], ['call', 'container.exec'], ['result', 'container.exec']])
})

test('an answer made in the background: the bridge reads it back from the conversation once the streams are quiet', async () => {
  const stream = new ChatGptStream()
  let doneAt = null
  const reads = []
  let answerReady = false
  let sent = false                                                     // a sent message: its request left the page, an answer forms
  const page = {
    state: async () => ({ ok: true, logged_in: true, generating: sent, url: 'https://chatgpt.com/c/conv-7', model: 'GPT-6 Pro', assistant_count: 0 }),
    open: async () => {},
    send: async () => { sent = true; return { accepted: true } },
    answer: async () => ({ generating: false, count: 0, text: '', url: 'https://chatgpt.com/c/conv-7' }),
    begin: () => {},
    heard: () => ({ ...stream.snapshot(), images: [], done_at: doneAt, posted_at: sent ? 1 : null }),
    absorb: (_turnId, messages) => { const before = stream.snapshot().done; stream.feedMessages(messages); if (!before && stream.snapshot().done) doneAt = Date.now() },
    turnMessages: async (want) => { reads.push(want); return answerReady ? { messages: readBackAnswer() } : { messages: readBackAnswer().slice(0, 1) } },
  }
  const logs = []
  const bridge = createBridge({ page, token: 't', log: (line) => logs.push(line), readBackQuietMs: 0, readBackEveryMs: 0 })
  assert.equal((await bridge.send({ text: 'review this', turn_id: 'turn_p' })).accepted, true)
  stream.feed(handedOffInBackground())
  stream.lastHeardAt = Date.now() - 1
  // still working in the background: read back, nothing to show yet
  assert.equal((await bridge.answer('turn_p')).status, 'generating')
  assert.deepEqual(reads, [{ conversationId: 'conv-7', after: 'm-sent' }])
  // made: read back, done; a moment for its images, then the answer
  answerReady = true
  assert.equal((await bridge.answer('turn_p')).status, 'generating')
  doneAt = Date.now() - 10_000
  stream.lastHeardAt = Date.now() - 10_000
  const done = await bridge.answer('turn_p')
  assert.equal(done.status, 'done')
  assert.equal(done.text, '第三轮回应')
  assert.equal(done.thinking, 'Checking\nThe review holds.')
  assert.deepEqual(done.conversation, { url: 'https://chatgpt.com/c/conv-7' })
  // not read back while the streams are live
  const quietBridge = createBridge({ page, token: 't', readBackQuietMs: 60_000, readBackEveryMs: 0 })
  await quietBridge.send({ text: 'again', turn_id: 'turn_q' })
  const before = reads.length
  stream.lastHeardAt = Date.now()
  await quietBridge.answer('turn_q')
  assert.equal(reads.length, before)
})

test('an answer thinking for up to an hour is read back every half minute, then every minute once quiet ten minutes', async () => {
  const stream = new ChatGptStream()
  stream.feed(handedOffInBackground())
  const reads = []
  const page = {
    state: async () => ({ ok: true, logged_in: true, generating: false, url: 'https://chatgpt.com/c/conv-7', assistant_count: 0 }),
    open: async () => {}, send: async () => ({ accepted: true }), begin: () => {},
    answer: async () => ({ generating: false, count: 0, text: '', url: 'https://chatgpt.com/c/conv-7' }),
    heard: () => ({ ...stream.snapshot(), images: [], done_at: null }),
    absorb: () => {},
    turnMessages: async () => { reads.push(Date.now()); return { messages: [] } },
  }
  const bridge = createBridge({ page, token: 't', readBackQuietMs: 30_000, readBackEveryMs: 30_000 })
  await bridge.send({ text: 'think hard', turn_id: 'turn_long' })
  const realNow = Date.now
  const start = realNow()
  let now = start
  Date.now = () => now
  try {
    const at = async (ms) => { now = start + ms; stream.lastHeardAt = start; await bridge.answer('turn_long') }
    await at(29_000)                     // not quiet long enough
    await at(30_000)                     // read
    await at(45_000)                     // too soon
    await at(60_000)                     // read
    await at(10 * 60_000)                // read (quiet ten minutes: from now on every minute)
    await at(10 * 60_000 + 30_000)       // too soon
    await at(11 * 60_000)                // read
    assert.deepEqual(reads.map((t) => t - start), [30_000, 60_000, 600_000, 660_000])
  } finally { Date.now = realNow }
})
