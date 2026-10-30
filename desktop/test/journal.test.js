// The bridge's turn journal: a turn kept before its words go (an app that stops while they go never sends it
// again), written whole or not at all, a journal that cannot be read never read as empty (a damaged one resumed by
// the person, the turns it named kept unconfirmed), a turn sent before a
// restart answered for good, a stop only for the turn's own answer, one turn one request, and a send confirmed
// only by its own message.
const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { createBridge, fileJournal, memoryJournal, JOURNAL_FILE } = require('../bridge')
const { tapPage } = require('../chatgpt_tap')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-journal-'))
const fast = { confirmMs: 150, confirmEveryMs: 10, sendRetryMs: 10 }

/** A page that sends when asked: it shows the message as sent, moves to a conversation and forms an answer. */
function fakePage() {
  const page = {
    logged_in: true, generating: false, messages: [], url: 'https://chatgpt.com/', sent: [], shown: [], stops: 0,
    state: async () => ({ ok: true, logged_in: page.logged_in, generating: page.generating, url: page.url, conversation: /\/c\//.test(page.url) ? { url: page.url } : null, model: 'GPT', assistant_count: page.messages.length, user_count: page.shown.length, last_user_text: page.shown.at(-1) || '' }),
    open: async (url) => { page.url = url || 'https://chatgpt.com/' },
    attach: async (files) => ({ ok: true, count: files.length }),
    send: async (text) => { page.sent.push(text); page.shown.push(text); if (!/\/c\//.test(page.url)) page.url = 'https://chatgpt.com/c/conv-1'; page.generating = true; return { accepted: true } },
    answer: async () => ({ generating: page.generating, count: page.messages.length, text: page.messages.at(-1) || '', url: page.url }),
    stop: async () => { page.stops += 1; page.generating = false; return { clicked: true, stopped: true } },
  }
  return page
}

const boot = (page, dir, logs = []) => createBridge({ page, token: 't', log: (l) => logs.push(l), journal: fileJournal(dir, (l) => logs.push(l)), ...fast })

test('a turn is kept before its words go: an app that stopped while they went finds it unconfirmed and never sends it again', async () => {
  const dir = tmp()
  try {
    const page = fakePage()
    // the app dies as the page takes the words: the send never comes back
    page.send = async (text) => { page.sent.push(text); return new Promise(() => {}) }
    void boot(page, dir).send({ text: 'once', turn_id: 'turn_k', new_conversation: true })
    await sleep(30)
    const kept = JSON.parse(fs.readFileSync(path.join(dir, JOURNAL_FILE), 'utf8'))
    assert.equal(kept.turn_k.state, 'submitting')
    // the app started again over the same data directory
    const again = await boot(fakePage(), dir).send({ text: 'once', turn_id: 'turn_k', new_conversation: true })
    assert.equal(again.reason, 'unconfirmed')
    assert.match(again.detail, /when the app stopped/)
    assert.deepEqual(page.sent, ['once'])
    assert.deepEqual(fs.readdirSync(dir), [JOURNAL_FILE])                                     // no temporary file left
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a journal that cannot be written sends nothing: the send says why', async () => {
  const dir = tmp()
  const data = path.join(dir, 'ro')
  fs.mkdirSync(data)
  fs.chmodSync(data, 0o555)
  try {
    const page = fakePage()
    const out = await boot(page, data).send({ text: 'hi', turn_id: 'turn_ro' })
    assert.equal(out.reason, 'journal_unusable')
    assert.match(out.detail, /could not be written/)
    assert.deepEqual(page.sent, [])
  } finally { fs.chmodSync(data, 0o755); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a turn that went and could not be recorded is accepted with the reason, and reads as unconfirmed after a restart', async () => {
  const page = fakePage()
  const memory = memoryJournal()
  const journal = { ...memory, put: (turnId, record) => (record.state === 'sent' ? 'the disk is full' : memory.put(turnId, record)) }
  const out = await createBridge({ page, token: 't', journal, ...fast }).send({ text: 'hi', turn_id: 'turn_w' })
  assert.deepEqual([out.accepted, out.journal_error], [true, 'the disk is full'])
  page.generating = false
  assert.equal((await createBridge({ page, token: 't', journal, ...fast }).send({ text: 'hi', turn_id: 'turn_w' })).reason, 'unconfirmed')
  assert.deepEqual(page.sent, ['hi'])
})

for (const [label, damage] of [
  ['truncated', (file) => fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(0, 20))],
  ['garbled', (file) => fs.writeFileSync(file, '\u0000{not json')],
  ['empty', (file) => fs.writeFileSync(file, '')],
]) {
  test(`a journal left ${label} is set aside, never read as empty: no turn goes until the person removed it`, async () => {
    const dir = tmp()
    try {
      const page = fakePage()
      for (const id of ['turn_1', 'turn_2']) { await boot(page, dir).send({ text: id, turn_id: id }); page.generating = false }
      const file = path.join(dir, JOURNAL_FILE)
      damage(file)
      const damaged = fs.readFileSync(file)
      const bridge = boot(page, dir)
      for (const id of ['turn_2', 'turn_3']) {
        const out = await bridge.send({ text: id, turn_id: id })
        assert.equal(out.reason, 'journal_unusable')
        assert.match(out.detail, /set aside as .*bridge-turns\.damaged-.*\.json/)
      }
      assert.deepEqual(page.sent, ['turn_1', 'turn_2'])
      const aside = fs.readdirSync(dir).filter((f) => f.startsWith('bridge-turns.damaged-'))
      assert.equal(aside.length, 1)
      assert.deepEqual(fs.readFileSync(path.join(dir, aside[0])), damaged)                    // kept as it was
      // the person looked at the page and removed it: the journal starts afresh
      fs.rmSync(path.join(dir, aside[0]))
      assert.equal((await bridge.send({ text: 'turn_3', turn_id: 'turn_3' })).accepted, true)
      assert.deepEqual(page.sent, ['turn_1', 'turn_2', 'turn_3'])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
}

test('a damaged journal says so to the card; resuming keeps the file under an acknowledged name, and the turns it named are never sent again', async () => {
  const dir = tmp()
  try {
    const page = fakePage()
    for (const id of ['turn_1', 'turn_2']) { await boot(page, dir).send({ text: id, turn_id: id }); page.generating = false }
    const file = path.join(dir, JOURNAL_FILE)
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(0, -3))                           // cut off: both turns still named
    const bridge = boot(page, dir)
    const damaged = bridge.journalState()
    assert.equal(damaged.state, 'damaged')
    assert.match(damaged.file, /^bridge-turns\.damaged-.*\.json$/)
    assert.ok(Math.abs(Date.parse(damaged.at) - Date.now()) < 60_000, damaged.at)
    assert.equal((await bridge.send({ text: 'turn_3', turn_id: 'turn_3' })).reason, 'journal_unusable')
    const resumed = bridge.resumeSending()
    assert.deepEqual(resumed, { resumed: true, archived: [damaged.file.replace(/\.json$/, '.acknowledged.json')], salvaged: 2 })
    assert.deepEqual(bridge.journalState(), { state: 'usable' })
    assert.ok(fs.existsSync(path.join(dir, resumed.archived[0])))                               // kept, not removed
    // the turns the damaged file named: unconfirmed, never a second message — also after a restart of the app
    for (const b of [bridge, boot(page, dir)]) {
      for (const id of ['turn_1', 'turn_2']) {
        const again = await b.send({ text: id, turn_id: id })
        assert.equal(again.reason, 'unconfirmed')
        assert.match(again.detail, /send log that was damaged/)
      }
      const answer = await b.answer('turn_2')
      assert.deepEqual([answer.status, answer.reason], ['lost', 'unconfirmed'])
      assert.match(answer.detail, /send log that was damaged/)
    }
    assert.deepEqual(page.sent, ['turn_1', 'turn_2'])
    // a new turn goes, with a message id after the damaged file's
    const fresh = await boot(page, dir).send({ text: 'turn_3', turn_id: 'turn_3' })
    assert.deepEqual([fresh.accepted, fresh.message_id], [true, 'm3'])
    assert.deepEqual(page.sent, ['turn_1', 'turn_2', 'turn_3'])
    // an acknowledged file no longer holds sends back, and there is nothing more to resume
    assert.deepEqual(boot(page, dir).journalState(), { state: 'usable' })
    assert.equal(bridge.resumeSending().resumed, false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a garbled journal resumes too: what it named cannot be read, and that is said to the person before they resume', async () => {
  const dir = tmp()
  try {
    const page = fakePage()
    await boot(page, dir).send({ text: 'x', turn_id: 'turn_x' })
    page.generating = false
    fs.writeFileSync(path.join(dir, JOURNAL_FILE), '\u0000{not json')
    const bridge = boot(page, dir)
    assert.equal(bridge.journalState().state, 'damaged')
    assert.deepEqual({ ...bridge.resumeSending(), archived: null }, { resumed: true, archived: null, salvaged: 0 })
    assert.equal((await bridge.send({ text: 'y', turn_id: 'turn_y' })).accepted, true)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('resuming after a damaged journal that cannot be written changes nothing: sends stay paused, and why is said', async () => {
  const dir = tmp()
  const data = path.join(dir, 'd')
  fs.mkdirSync(data)
  try {
    const page = fakePage()
    await boot(page, data).send({ text: 'x', turn_id: 'turn_x' })
    page.generating = false
    fs.writeFileSync(path.join(data, JOURNAL_FILE), '{"turn_x":{"state":"sent"')
    const bridge = boot(page, data)
    const { file } = bridge.journalState()
    fs.chmodSync(data, 0o555)
    const out = bridge.resumeSending()
    assert.equal(out.resumed, false)
    assert.match(out.reason, /could not be written/)
    fs.chmodSync(data, 0o755)
    assert.deepEqual(bridge.journalState(), { state: 'damaged', file, at: bridge.journalState().at })
    assert.equal((await bridge.send({ text: 'y', turn_id: 'turn_y' })).reason, 'journal_unusable')
    assert.equal(bridge.resumeSending().resumed, true)
    assert.equal((await bridge.send({ text: 'x', turn_id: 'turn_x' })).reason, 'unconfirmed')
    assert.deepEqual(page.sent, ['x'])
  } finally { fs.chmodSync(data, 0o755); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a journal that cannot be read says why to the card, and offers nothing to resume: it is read again at the next send', async () => {
  const dir = tmp()
  const file = path.join(dir, JOURNAL_FILE)
  try {
    const page = fakePage()
    await boot(page, dir).send({ text: 'x', turn_id: 'turn_x' })
    fs.chmodSync(file, 0o000)
    const bridge = boot(page, dir)
    const state = bridge.journalState()
    assert.equal(state.state, 'unreadable')
    assert.match(state.reason, /could not be read \(EACCES\)/)
    assert.equal(bridge.resumeSending().resumed, false)
    fs.chmodSync(file, 0o600)
    assert.deepEqual(bridge.journalState(), { state: 'usable' })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a journal that cannot be read is no empty one: turns wait until it reads again, then a turn sent before repeats', async () => {
  const dir = tmp()
  const file = path.join(dir, JOURNAL_FILE)
  try {
    const page = fakePage()
    await boot(page, dir).send({ text: 'x', turn_id: 'turn_x' })
    page.generating = false
    fs.chmodSync(file, 0o000)
    const bridge = boot(page, dir)
    const out = await bridge.send({ text: 'x', turn_id: 'turn_x' })
    assert.equal(out.reason, 'journal_unusable')
    assert.match(out.detail, /could not be read \(EACCES\)/)
    fs.chmodSync(file, 0o600)
    assert.equal((await bridge.send({ text: 'x', turn_id: 'turn_x' })).repeat, true)
    assert.deepEqual(page.sent, ['x'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a turn sent before a restart: its answer and its stop say so for good, the page left alone', async () => {
  const dir = tmp()
  try {
    const page = fakePage()
    await boot(page, dir).send({ text: 'q', turn_id: 'turn_g', new_conversation: true })
    const after = boot(page, dir)
    const again = await after.send({ text: 'q', turn_id: 'turn_g', new_conversation: true })
    assert.deepEqual([again.repeat, again.conversation], [true, { url: 'https://chatgpt.com/c/conv-1' }])
    const answer = await after.answer('turn_g')
    assert.deepEqual([answer.status, answer.reason, answer.conversation], ['lost', 'restarted', { url: 'https://chatgpt.com/c/conv-1' }])
    assert.match(answer.detail, /before the desktop app restarted/)
    assert.deepEqual(await after.stop('turn_g'), { stopped: false, reason: 'restarted' })
    assert.equal(page.stops, 0)
    assert.deepEqual(await after.answer('turn_never'), { status: 'unknown' })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('message ids are never given twice, across runs of the app', async () => {
  const dir = tmp()
  try {
    const page = fakePage()
    assert.equal((await boot(page, dir).send({ text: 'a', turn_id: 'turn_a' })).message_id, 'm1')
    page.generating = false
    assert.equal((await boot(page, dir).send({ text: 'b', turn_id: 'turn_b' })).message_id, 'm2')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('one turn is one request: the same turn with other words, images or conversation is a conflict, also after a restart', async () => {
  const dir = tmp()
  try {
    const page = fakePage()
    const bridge = boot(page, dir)
    const conv = 'https://chatgpt.com/c/aaaaaaaa-1111'
    assert.equal((await bridge.send({ text: 'alpha', turn_id: 'turn_s', conversation_url: conv })).accepted, true)
    page.generating = false
    const image = [{ name: 'a.png', media_type: 'image/png', data_base64: 'iVBORw0KGgo=' }]
    for (const other of [{ text: 'beta', conversation_url: conv }, { text: 'alpha', conversation_url: conv, images: image }, { text: 'alpha', conversation_url: 'https://chatgpt.com/c/bbbbbbbb-2222' }]) {
      assert.equal((await bridge.send({ ...other, turn_id: 'turn_s' })).reason, 'turn_conflict')
      assert.equal((await boot(page, dir).send({ ...other, turn_id: 'turn_s' })).reason, 'turn_conflict')
    }
    assert.equal((await boot(page, dir).send({ text: 'alpha', turn_id: 'turn_s', conversation_url: conv })).repeat, true)
    assert.deepEqual(page.sent, ['alpha'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test("a stop is for the turn's own answer: one answered, or one the person's message followed, is left alone", async () => {
  const page = fakePage()
  const bridge = createBridge({ page, token: 't', ...fast })
  await bridge.send({ text: 'mine', turn_id: 'turn_m' })
  page.messages.push('answer to mine'); page.generating = false
  assert.equal((await bridge.answer('turn_m')).status, 'done')
  page.generating = true                                                        // the person's own message answered
  assert.deepEqual(await bridge.stop('turn_m'), { stopped: false, reason: 'not_generating' })
  // the page's listener says another message followed the turn's own
  page.generating = false
  page.heard = () => ({ events: 1, done: false, current: false })
  assert.equal((await bridge.send({ text: 'next', turn_id: 'turn_n' })).accepted, true)
  assert.deepEqual(await bridge.stop('turn_n'), { stopped: false, reason: 'not_current' })
  assert.equal(page.stops, 0)
})

/** A page whose send button was pressed and nothing went. */
function deadSendPage() {
  const page = fakePage()
  page.url = 'https://chatgpt.com/c/conv-mine'
  page.send = async (text) => { page.sent.push(text); return { accepted: true } }
  return page
}

test('a send is confirmed by its own message only: the person answered, or another conversation opened, is no sign', async () => {
  const page = deadSendPage()
  const bridge = createBridge({ page, token: 't', ...fast })
  const going = bridge.send({ text: 'oasis words', turn_id: 'turn_c1' })
  await sleep(40)
  page.shown.push('the person typed this'); page.messages.push('answer to the person'); page.generating = true
  assert.deepEqual(await going, { accepted: false, reason: 'not_sent' })
  page.generating = false
  const switching = bridge.send({ text: 'more oasis words', turn_id: 'turn_c2' })
  await sleep(40)
  page.url = 'https://chatgpt.com/c/another-conversation'
  assert.deepEqual(await switching, { accepted: false, reason: 'not_sent' })
  // its own words shown as sent are
  const own = bridge.send({ text: 'shown late', turn_id: 'turn_c3' })
  await sleep(40)
  page.shown.push('shown late')
  assert.equal((await own).accepted, true)
})

test("the page's listener binds the turn to the request that carries its words: the person's own request is theirs", async () => {
  const dbg = new EventEmitter()
  dbg.attach = () => {}
  dbg.detach = () => {}
  dbg.bodies = new Map()
  dbg.sendCommand = async (method, params) => (method === 'Network.getRequestPostData' ? { postData: dbg.bodies.get(params.requestId) } : {})
  const emit = (method, params) => dbg.emit('message', {}, method, params)
  const tap = tapPage({ debugger: dbg }, {})
  const page = deadSendPage()
  page.begin = (id, expect) => tap.begin(id, expect)
  page.end = (id) => tap.end(id)
  page.heard = (id) => tap.heard(id)
  const POST = { url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST' }
  const body = (words) => JSON.stringify({ action: 'next', messages: [{ content: { content_type: 'text', parts: [words] } }] })
  const bridge = createBridge({ page, token: 't', ...fast })
  const going = bridge.send({ text: 'oasis words', turn_id: 'turn_t1' })
  await sleep(40)
  emit('Network.requestWillBeSent', { requestId: 'p1', request: { ...POST, postData: body('the person typed this') } })
  assert.deepEqual(await going, { accepted: false, reason: 'not_sent' })
  // the turn's own request, its body asked for (the event did not hold it), and a mention before the words
  const own = bridge.send({ text: 'oasis words again', turn_id: 'turn_t2' })
  await sleep(40)
  dbg.bodies.set('o1', body('[$oasis-code](app://asdk_app_1) oasis  words\nagain'))
  emit('Network.requestWillBeSent', { requestId: 'o1', request: { ...POST, hasPostData: true } })
  assert.equal((await own).accepted, true)
  // a body asked for that is not the turn's lets the request go again
  tap.begin('turn_t3', { words: 'third words' })
  dbg.bodies.set('p2', body('by hand'))
  emit('Network.requestWillBeSent', { requestId: 'p2', request: { ...POST, hasPostData: true } })
  // bound while its body is asked for, and no sign the turn went meanwhile
  assert.deepEqual([tap.heard('turn_t3').posted_at, tap.heard('turn_t3').checking], [null, true])
  await sleep(5)
  assert.deepEqual([tap.heard('turn_t3').posted_at, tap.heard('turn_t3').checking], [null, false])
})
