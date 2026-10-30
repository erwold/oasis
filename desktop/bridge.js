// The ChatGPT bridge: the desktop shell holds a signed-in ChatGPT page (its own persistent session, no preload,
// no Node, nothing of the app reachable from the page) and serves the bridge protocol the backend's bridge
// transport speaks, on the loopback under a token minted per app start:
//
//   GET  /state                 -> { ok, logged_in, generating, conversation, model, load_error }
//        (load_error: why the page did not load — a proxy's tunnel refused, the network down — or null; the page
//         retries by itself, and a message waits for it as `page_not_loaded`, never as a sign-in)
//   POST /send                  <- { text, turn_id, new_conversation, conversation_url?, mention?, model?, images? }
//                               -> { accepted, reason?, detail?, message_id?, conversation?, repeat?, journal_error? }
//        (a send whose request closes before its reply, or that a /stop names while it is on its way, is dropped: its
//         words do not go after that, or — already going — the answer is stopped once it shows; reason: cancelled.
//         sending: this turn is on its way already — asked again (its sender restarted, say), it is no longer dropped,
//         and a /send once it went answers as it did; ask again later.
//         no_composer: a signed-in page that shows no composer this bridge knows — the web app changed)
//        (images: [{ name, media_type, data_base64 }], up to eight PNG, JPEG, WebP or GIF: put into the page's image
//         input and uploaded before the words go; malformed ones are refused as bad_images, a page that did not take
//         them as images_not_attached with its reason as `detail`. Words over LONG_TEXT_CHARS go as a file of their
//         own, message.txt, the composer saying so — as the page itself turns a long paste into a file, but whole
//         and uploaded before the send. A message is sent only when the page shows this message went — its request
//         leaving the page with its words, or the page showing it as the newest sent message — else not_sent; what the
//         person does on the page meanwhile is no sign)
//        (conversation_url: a conversation of the person's ChatGPT, `https://chatgpt.com/c/…`, opened first and the
//         message sent there — it wins over new_conversation; a URL that is not one is refused as bad_conversation_url,
//         one the page does not open as conversation_not_found. mention: a connector as ChatGPT copies it,
//         `[$oasis-code](app://…)`; model: a ChatGPT model slug — the message goes as the page sends one with that
//         model chosen and that connector @-mentioned; without them it goes as plain words)
//   GET  /answer?turn_id=…      -> { status: 'generating', progress?: { thinking, text, steps } }
//                                | { status: 'done', text, thinking?, steps?, images?: [{ name, media_type, data_base64 }], model?, conversation? }
//                                | { status: 'lost', reason: 'restarted' | 'unconfirmed', detail, conversation? }
//                                | { status: 'unknown' }
//        (text: the answer's words, with the text files it links to in ChatGPT's sandbox — code, data — shown in it;
//         lost: a turn the journal holds that this run of the app did not send — it went before a restart, or with no
//         sign it did — its answer is on the page only, for good; unknown: a turn neither knows)
//   POST /stop                  <- { turn_id }   -> { stopped: true, sent?: false } | { stopped: false, reason: 'unknown' | 'restarted' | 'not_current' | 'not_generating' | 'no_stop_button' | 'still_generating' | 'sending' }
//        (the page's stop button, clicked for the message last sent while its own answer forms — and only then: a turn
//         the page has moved on from (a later turn, the person's own message after it), one answered or stopped, or
//         one sent before a restart (`restarted`) is not stopped by a late call; still_generating: clicked, and the
//         answer still forms. A message still on its way is dropped: `sent: false` when its words will not go,
//         `sending` when they were going — the answer is then stopped as soon as it shows)
//   GET  /computer/surfaces, POST /computer/observe, POST /computer/act, POST /computer/release <- { owner }
//        (computer use: an agent looks at and acts on the agent browser or this ChatGPT page — desktop/computer.js;
//         observe and act take { owner, session? }; one whose request closes before its turn is dropped; a run that
//         ended lets go of what it held)
//
// A turn is sent at most once: a /send for a turn already sent answers as it did (`repeat: true`), and one whose
// message was submitted without a sign that it went answers `unconfirmed` — never a second message — also after a
// restart of the app: the latest 200 turns are kept in the data directory (bridge-turns.json), each recorded before
// its words go, so one the app stopped while sending reads as unconfirmed. The same turn with another request (words,
// images, conversation) is `turn_conflict`; a journal that cannot be read or written sends no turn it cannot vouch
// for (`journal_unusable`), and a send that went but could not be recorded says so (`journal_error`). While an agent acts on the ChatGPT
// page (computer use) a send answers `page_in_use` and is tried again later; an agent is told to wait while a send
// goes or its answer forms.
//
// The HTTP side is pure over a `page` adapter (state / open / send / answer) so a test drives it with a fake page;
// `electronPage` is the adapter over a view in the app's window. A message's answer is the first assistant message that appears
// after it was sent, once the page stops generating; the person can read, sign in and click on the page meanwhile
// — it is their browser.

const http = require('node:http')
const crypto = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')
const dom = require('./chatgpt_dom')
const { tapPage } = require('./chatgpt_tap')
const { cdpOf } = require('./cdp')
const { holdsWords } = require('./chatgpt_stream')
const { ComputerRefusal, createComputer } = require('./computer')
const { agentBrowser, backstage, browserInputCommand, browserTabs, BROWSER_DEVICE_SCALE, BROWSER_PARTITION, electronSurface, pickElement, pruneDownloads, seatView } = require('./computer_electron')
const { DEFAULT_DIRECTOR_PORT, DEFAULT_GATEWAY_PORT } = require('./gateway_agent')
const { DEFAULT_PORT: BACKEND_PORT } = require('./shell')

const CHATGPT_URL = 'https://chatgpt.com/'
const DEFAULT_PORT = '8323'
const OPEN_TIMEOUT_MS = 20_000
// a message the page did not take goes once more after this long
const SEND_RETRY_MS = 1_500
// how long a sent message may take to show on the page (an answer forming, the conversation's address) before the
// send reads as not taken
const CONFIRM_MS = 20_000
// words longer than this go as a text file (the page makes a file of a long paste itself, uploading it while the
// send button waits, seen 2026-09-30 with 179,440 characters)
const LONG_TEXT_CHARS = 20_000
const LONG_TEXT_FILE = 'message.txt'
// an answer not done whose streams have been quiet this long is read back from the conversation, at most this often
const READ_BACK_QUIET_MS = 30_000
const READ_BACK_EVERY_MS = 30_000
const READ_BACK_SLOWER_AFTER_MS = 10 * 60_000
// how long before a page that did not load is loaded again (then every minute)
const RETRY_S = [2, 5, 15, 30, 60]
// after the stream says the answer is complete, a moment for the page to load the images it shows
const IMAGE_SETTLE_MS = 4_000
const DOWNLOAD_WAIT_MS = 20_000
// the text files of one answer taken into it, and how much of each
const MAX_ANSWER_FILES = 5
const MAX_FILE_CHARS = 100_000
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024
const PICTURE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

/** The page's downloads while `click` runs, taken instead of saved: each goes to a private temporary folder, is read,
 *  and is removed; only this view's downloads, only pictures, none over 8 MB. Other downloads (the person's own, in
 *  the card, at any other time) are not touched. */
async function takeDownloads(webContents, click, { waitMs = DOWNLOAD_WAIT_MS, tmpRoot = require('node:os').tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'oasis-bridge-'))
  const session = webContents.session
  const taken = []
  let pending = 0
  const onDownload = (_event, item, from) => {
    if (from !== webContents) return
    const name = path.basename(item.getFilename() || 'download').replace(/[^\w.\- ]/g, '_')
    const file = path.join(dir, name)
    item.setSavePath(file)
    pending += 1
    item.once('done', (_e, state) => {
      pending -= 1
      try {
        const ext = (name.split('.').pop() || '').toLowerCase()
        if (state === 'completed' && PICTURE_TYPES[ext]) {
          const bytes = fs.readFileSync(file)
          if (bytes.length <= MAX_DOWNLOAD_BYTES) taken.push({ name, media_type: PICTURE_TYPES[ext], data_base64: bytes.toString('base64') })
        }
      } catch { /* not readable: left out */ }
      fs.rmSync(file, { force: true })
    })
  }
  session.on('will-download', onDownload)
  try {
    const result = await click()
    const want = Array.isArray(result && result.clicked) ? result.clicked.length : 0
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline && (taken.length < want || pending > 0)) await new Promise((r) => setTimeout(r, 200))
    return { images: taken, clicked: result }
  } finally {
    session.removeListener('will-download', onDownload)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function bridgePortOf(env = process.env) {
  const port = String(env.OASIS_CODE_BRIDGE_PORT || DEFAULT_PORT)
  if (!/^\d{2,5}$/.test(port) || Number(port) > 65535) throw new Error(`OASIS_CODE_BRIDGE_PORT is not a port: ${port}`)
  return Number(port)
}

// a message's images ride in /send as base64: eight of 5 MB, and room for the words
const MAX_SEND_BODY = 64_000_000
const MAX_IMAGES = 8
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** A message's images as the page is given them, each name its own (the page names a tile by its file): null when
 *  any is malformed. */
function imagesOf(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > MAX_IMAGES) return null
  for (const image of raw) {
    if (!image || typeof image !== 'object' || !IMAGE_TYPES.has(image.media_type) || typeof image.data_base64 !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(image.data_base64)) return null
  }
  return uniquelyNamed(raw.map((image) => ({ name: image.name, media_type: image.media_type, data_base64: image.data_base64 })))
}

/** Files each named apart (the page names a tile by its file): a clean name, `name (2).ext` for the second. */
function uniquelyNamed(files) {
  const taken = new Set()
  return files.map((file) => {
    const given = typeof file.name === 'string' && file.name.trim() ? file.name.trim().replace(/[\\/\n\r"]/g, '_').slice(0, 120) : 'image'
    const dot = given.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [given.slice(0, dot), given.slice(dot)] : [given, '']
    let name = given
    for (let n = 2; taken.has(name); n += 1) name = `${stem} (${n})${ext}`
    taken.add(name)
    return { ...file, name }
  })
}

/** What the page is given for a message: its words, or — when they are long — a line naming the file that holds them
 *  whole; and the files to upload first (the images, then that file). */
function outgoingOf(text, images, longText = LONG_TEXT_CHARS) {
  if (text.length <= longText) return { words: text, files: images }
  const files = uniquelyNamed([...images, { name: LONG_TEXT_FILE, media_type: 'text/plain', data_base64: Buffer.from(text, 'utf8').toString('base64') }])
  // the file is not named: the page renames one named as a file it took before (message.txt → message(2).txt)
  return { words: `The whole message (${text.length} characters) is in the attached text file. Read all of it, then answer it.`, files }
}

function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (d) => { body += String(d); if (body.length > limit) reject(new Error('body too large')) })
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

/** The computer's name for the ChatGPT page, and the bridge's own name when it takes the page for a send. */
const CHATGPT_SURFACE = 'chatgpt'
const BRIDGE_OWNER = 'bridge'
const JOURNAL_FILE = 'bridge-turns.json'
/** Where an agent's downloads wait for its run (the backend moves them into the run's temporary folder). */
const COMPUTER_DOWNLOADS = 'computer-downloads'
/** How many turns the journal keeps (the latest): a caller sends a turn again within minutes (a busy page, a sign-in),
 *  so a turn older than the last 200 is not known after a restart of the app. */
const JOURNAL_KEEP = 200
/** A journal that could not be read as one is set aside under this name; while one lies there the bridge sends no
 *  turn it does not know from this run of the app. The person resumes sending once they looked at the ChatGPT page:
 *  the file is then kept under the acknowledged name, which no longer holds sends back. */
const DAMAGED_JOURNAL = /^bridge-turns\.damaged-(?!.*\.acknowledged\.json$)[\w.-]+\.json$/
const ACKNOWLEDGED_SUFFIX = '.acknowledged.json'
const JOURNAL_STATES = new Set(['submitting', 'sent', 'unconfirmed'])

/** A journal record's states: `submitting` (kept before the words go to the page — one found so after a restart was
 *  cut off with the app and reads as unconfirmed), `sent`, `unconfirmed`. Each carries the message id given to it
 *  then: the newest kept holds the highest, so an id is never given twice, across runs of the app. */
function withKept(kept, turnId, record) {
  const next = new Map(kept)
  next.delete(turnId)
  if (record !== null) next.set(turnId, record)
  while (next.size > JOURNAL_KEEP) next.delete(next.keys().next().value)
  return next
}
function messageNumberOf(record) {
  const m = record && typeof record.message_id === 'string' ? /^m(\d+)$/.exec(record.message_id) : null
  return m ? Number(m[1]) : 0
}

/** The turns sent, kept in memory only (a test's, or a bridge without a data directory). `put` and `remove` answer
 *  null, or why the record could not be kept; `unusable` answers why no turn's fate can be known, or null; `state`
 *  says it for the ChatGPT card, and `resume` takes a damaged journal's pause off (see fileJournal). */
function memoryJournal() {
  let kept = new Map()
  let last = 0
  return {
    unusable: () => null,
    state: () => ({ state: 'usable' }),
    resume: () => ({ resumed: false, reason: 'the send log is not damaged' }),
    get: (turnId) => kept.get(turnId) || null,
    put: (turnId, record) => { kept = withKept(kept, turnId, record); last = Math.max(last, messageNumberOf(record)); return null },
    remove: (turnId) => { kept = withKept(kept, turnId, null); return null },
    lastMessage: () => last,
  }
}

/** When a damaged journal was set aside: read from its name (the time is in it), else the file's. */
function damagedAt(dataDir, name) {
  const m = /^bridge-turns\.damaged-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}(?:\.\d+)?)Z\.json$/.exec(name)
  if (m) return `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`
  try { return fs.statSync(path.join(dataDir, name)).mtime.toISOString() } catch { return null }
}

/** The turns a damaged journal still names (a cut-off file keeps most of them), each with its request digest and
 *  message id where they are still there. */
function salvagedTurns(raw) {
  const starts = []
  const record = /"((?:[^"\\]|\\.){1,200})":\{"state":"(?:submitting|sent|unconfirmed)"/g
  for (let m = record.exec(raw); m !== null; m = record.exec(raw)) starts.push({ index: m.index, id: m[1] })
  const found = []
  starts.forEach(({ index, id }, i) => {
    const text = raw.slice(index, i + 1 < starts.length ? starts[i + 1].index : raw.length)
    let turnId
    try { turnId = JSON.parse(`"${id}"`) } catch { return }
    const digest = /"digest":"([0-9a-f]{64})"/.exec(text)
    const messageId = /"message_id":"(m\d+)"/.exec(text)
    found.push({ turnId, digest: digest ? digest[1] : null, message_id: messageId ? messageId[1] : null })
  })
  return found
}

/** The turns, kept in the data directory (the last 200): a turn sent before a restart of the app is not sent again
 *  after it. Every write replaces the file whole (a temporary file, synced, renamed over it), so a crash leaves the
 *  old journal or the new one. A journal that cannot be read is no empty one: unreadable (its permissions), it is
 *  tried again at the next send; damaged, it is set aside — and either way the bridge sends no turn it does not know
 *  until the journal is usable again. For a damaged one that is when the person, having looked at the ChatGPT page,
 *  resumes sending on the ChatGPT card (`resume`), or removes the file set aside themselves. */
function fileJournal(dataDir, log = () => {}) {
  const file = path.join(dataDir, JOURNAL_FILE)
  let kept = null
  let last = 0
  let broken = null
  const damagedAside = () => {
    try { return fs.readdirSync(dataDir).filter((name) => DAMAGED_JOURNAL.test(name)).sort() } catch { return [] }
  }
  const damagedWhy = (asideFile) => `the bridge's turn journal was damaged and set aside as ${asideFile}: which turns were sent before is not known. Look at the ChatGPT page, then resume sending on the ChatGPT card`
  /** The journal file as it is on disk (a damaged one set aside), or null with `broken` saying why. */
  const readFile = () => {
    let raw
    try { raw = fs.readFileSync(file, 'utf8') } catch (error) {
      if (error.code === 'ENOENT') { broken = null; return { kept: new Map(), last: 0 } }
      broken = `the bridge's turn journal ${file} could not be read (${error.code || error.message}): which turns were sent before is not known`
      return null
    }
    const read = parseJournal(raw)
    if (read === null) {
      const asideFile = path.join(dataDir, `bridge-turns.damaged-${new Date().toISOString().replace(/[:]/g, '-')}.json`)
      try {
        fs.renameSync(file, asideFile)
        log(`[bridge] the turn journal could not be read as one; set aside as ${asideFile}`)
        broken = damagedWhy(asideFile)
      } catch (error) {
        broken = `the bridge's turn journal ${file} is damaged and could not be set aside (${error.code || error.message}): which turns were sent before is not known`
      }
      return null
    }
    broken = null
    return read
  }
  const load = () => {
    const aside = damagedAside()
    if (aside.length) {
      broken = damagedWhy(path.join(dataDir, aside[0]))
      kept = null
      return null
    }
    if (kept) return kept
    const read = readFile()
    if (read === null) return null
    kept = read.kept
    last = Math.max(last, read.last)
    return kept
  }
  const write = (next) => {
    const tmp = `${file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      const fd = fs.openSync(tmp, 'w', 0o600)
      try {
        fs.writeSync(fd, JSON.stringify(Object.fromEntries(next)))
        fs.fsyncSync(fd)
      } finally { fs.closeSync(fd) }
      fs.renameSync(tmp, file)
      // the rename itself survives a power loss once the directory is synced (not every system can sync one)
      try { const dir = fs.openSync(dataDir, 'r'); try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) } } catch { /* best effort */ }
      kept = next
      last = Math.max(last, ...[...next.values()].map(messageNumberOf))
      return null
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* nothing to remove */ }
      log(`[bridge] the turns could not be kept: ${error.message}`)
      return `the bridge's turn journal could not be written (${error.code || error.message})`
    }
  }
  return {
    unusable: () => (load() === null ? broken : null),
    /** For the ChatGPT card: `usable`; `damaged`, with the file set aside and when; or `unreadable`, with why. */
    state() {
      if (load() !== null) return { state: 'usable' }
      const aside = damagedAside()
      if (aside.length) return { state: 'damaged', file: aside[0], at: damagedAt(dataDir, aside[0]) }
      return { state: 'unreadable', reason: broken }
    },
    /** Sending resumed after a damaged journal, the person having looked at the ChatGPT page: the turns the damaged
     *  files still name are written to the journal as unconfirmed first — none of them is sent again — then each file
     *  is kept under its acknowledged name. A turn the damaged file no longer names is not known after this. When a
     *  step fails sends stay paused, and why is said. */
    resume() {
      const aside = damagedAside()
      if (!aside.length) return { resumed: false, reason: 'the send log is not damaged' }
      const read = readFile()
      if (read === null) return { resumed: false, reason: broken }
      let next = read.kept
      let salvaged = 0
      const now = new Date().toISOString()
      for (const name of aside) {
        let raw
        try { raw = fs.readFileSync(path.join(dataDir, name), 'utf8') } catch (error) { return { resumed: false, reason: `${name} could not be read (${error.code || error.message})` } }
        for (const turn of salvagedTurns(raw)) {
          if (next.has(turn.turnId)) continue
          next = withKept(next, turn.turnId, { state: 'unconfirmed', at: now, digest: turn.digest, message_id: turn.message_id, conversation: null, damaged_log: name })
          salvaged += 1
        }
      }
      last = Math.max(last, read.last)
      const notKept = write(next)
      if (notKept) { kept = null; return { resumed: false, reason: notKept } }
      const archived = []
      for (const name of aside) {
        const to = `${name.slice(0, -'.json'.length)}${ACKNOWLEDGED_SUFFIX}`
        try { fs.renameSync(path.join(dataDir, name), path.join(dataDir, to)) } catch (error) {
          kept = null
          return { resumed: false, reason: `${name} could not be kept as ${to} (${error.code || error.message})` }
        }
        archived.push(to)
      }
      broken = null
      log(`[bridge] sending resumed by the person: the damaged turn journal kept as ${archived.join(', ')}; the ${salvaged} turns it named are kept as unconfirmed`)
      return { resumed: true, archived, salvaged }
    },
    get: (turnId) => { const all = load(); return all ? all.get(turnId) || null : null },
    put: (turnId, record) => { const all = load(); return all ? write(withKept(all, turnId, record)) : broken },
    remove: (turnId) => { const all = load(); return all ? (all.has(turnId) ? write(withKept(all, turnId, null)) : null) : broken },
    lastMessage: () => (load() ? last : 0),
  }
}

/** The journal file's turns (turn id → record) and the highest message number among them, or null when it is not a
 *  journal. */
function parseJournal(raw) {
  let saved
  try { saved = JSON.parse(raw) } catch { return null }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null
  const kept = new Map()
  for (const [turnId, record] of Object.entries(saved)) {
    if (record && typeof record === 'object' && JOURNAL_STATES.has(record.state)) kept.set(turnId, record)
  }
  return { kept, last: Math.max(0, ...[...kept.values()].map(messageNumberOf)) }
}

/** What makes a /send the request it is — its words, its images, where it goes — as a digest kept with the turn: the
 *  same turn asked again with another request is a conflict, not a repeat. */
function requestDigestOf(body) {
  const images = Array.isArray(body.images) ? body.images.map((image) => [image && image.media_type, crypto.createHash('sha256').update(String(image && image.data_base64)).digest('hex')]) : []
  const target = body.conversation_url ? dom.conversationUrlOf(body.conversation_url) || String(body.conversation_url) : null
  const what = { text: typeof body.text === 'string' ? body.text : '', images, target, new_conversation: target === null && !!body.new_conversation }
  return crypto.createHash('sha256').update(JSON.stringify(what)).digest('hex')
}

/** The bridge's protocol over a page adapter: { state(): Promise<PageState>, open(url?): Promise<void> (a fresh
 *  conversation, or the conversation at `url`), send(text): Promise<{accepted, reason}>, answer(): Promise<{generating,
 *  count, text, url}>, stop(): Promise<{clicked, stopped?}> } and, when the page is listened to, begin / end / heard
 *  (the turn's own request and answer). */
function createBridge({ page, token, log = () => {}, computer = null, journal = memoryJournal(), sendRetryMs = SEND_RETRY_MS, readBackQuietMs = READ_BACK_QUIET_MS, readBackEveryMs = READ_BACK_EVERY_MS, confirmMs = CONFIRM_MS, confirmEveryMs = 500, longText = LONG_TEXT_CHARS }) {
  const turns = new Map()   // turn_id -> { before: assistant messages before the send, sent_at, message_id, conversation, answered }
  // turn_id -> { dropped, words_given, digest } for a message on its way (waiting for the page, opening, uploading, sending): a
  // dropped one goes no further, and one dropped once its words were given is stopped as soon as it shows it went
  const pending = new Map()
  let sends = 0
  let sending = Promise.resolve()
  let lastTurn = null
  let sendingNow = false

  let lastWhy = ''
  async function state() {
    const s = await page.state()
    // a page read as signed out says why in the app's log (what matched), once per change: the selectors follow a
    // web app that changes without notice
    const why = s.logged_in ? '' : JSON.stringify(s.why || null)
    if (why !== lastWhy) { lastWhy = why; if (why) log(`[bridge] the ChatGPT page reads as signed out: ${why} (${s.url || '?'})`) }
    return { ok: true, logged_in: !!s.logged_in, generating: !!s.generating, conversation: s.conversation || null, model: s.model || null, load_error: s.load_error || null }
  }

  /** Whether this turn's own message request left the page (the listener binds a request to the turn only when it
   *  carries the turn's words), or its answer was heard — a late frame of another conversation proves nothing, nor a
   *  request whose body is still being checked for the words. */
  function posted(turnId) {
    const heard = turnId && page.heard ? page.heard(turnId) : null
    return !!(heard && !heard.checking && (heard.posted_at || heard.events > 0))
  }

  /** Whether the page shows this turn's own message went: its request seen leaving the page (the surest sign), or a
   *  new message on the person's side of the conversation holding its words. What the person does meanwhile — their
   *  own message answered, another conversation opened — is no sign of it. */
  function wentOn(now, before, turnId, words) {
    if (posted(turnId)) return true
    return Number(now.user_count || 0) > Number(before.user_count || 0) && holdsWords(now.last_user_text, words)
  }

  /** The page as it stands once the message shows it went, or null when it did not in time. */
  async function shown(before, turnId, words) {
    const deadline = Date.now() + confirmMs
    for (;;) {
      const now = await page.state()
      if (wentOn(now, before, turnId, words)) return now
      if (Date.now() >= deadline) return null
      await new Promise((r) => setTimeout(r, confirmEveryMs))
    }
  }

  /** A turn's send, at most once: the same answer for a turn sent before (in this run of the app, or — kept in the
   *  journal — an earlier one), never a second message for one submitted without a sign it went, nor for one whose
   *  fate the journal cannot tell. The same turn asked with another request (words, images, conversation) is a
   *  conflict, not a repeat. */
  async function send(body) {
    const turnId = typeof body.turn_id === 'string' ? body.turn_id : ''
    const digest = requestDigestOf(body)
    if (turnId) {
      const known = turns.get(turnId)
      if (known) return known.digest !== digest ? conflictOf(turnId) : { accepted: true, message_id: known.message_id, conversation: known.conversation || null, repeat: true }
      // one on its way in this run is refused as `sending` by sendOnce
      if (!pending.has(turnId)) {
        const why = journal.unusable()
        if (why) {
          log(`[bridge] turn ${turnId} not sent: ${why}`)
          return { accepted: false, reason: 'journal_unusable', detail: why }
        }
        const kept = journal.get(turnId)
        if (kept && kept.digest && kept.digest !== digest) return conflictOf(turnId)
        if (kept && kept.state === 'sent') return { accepted: true, message_id: kept.message_id || null, conversation: kept.conversation || null, repeat: true }
        if (kept && kept.state === 'submitting') {
          return { accepted: false, reason: 'unconfirmed', detail: `a message for this turn was being given to the page at ${kept.at} when the app stopped; whether it went is not known, and it is not sent again — the ChatGPT page shows whether it did` }
        }
        if (kept && kept.damaged_log) return { accepted: false, reason: 'unconfirmed', detail: `this turn is named in the send log that was damaged (${kept.damaged_log}); whether its message went is not known, and it is not sent again — the ChatGPT page shows whether it did` }
        if (kept) return { accepted: false, reason: 'unconfirmed', detail: `a message for this turn was submitted on the page at ${kept.at} with no sign that it went; it is not sent again — the ChatGPT page shows whether it did` }
      }
    }
    return sendOnce(body, digest)
  }

  function conflictOf(turnId) {
    log(`[bridge] turn ${turnId} asked again with another message: refused`)
    return { accepted: false, reason: 'turn_conflict', detail: 'this turn was sent with other words, images or conversation; a turn is one message' }
  }

  async function sendOnce(body, digest) {
    const text = typeof body.text === 'string' ? body.text : ''
    const turnId = typeof body.turn_id === 'string' ? body.turn_id : ''
    const mention = dom.mentionOf(body.mention)
    const model = typeof body.model === 'string' && /^[a-z0-9][a-z0-9._-]{0,60}$/i.test(body.model) ? body.model : null
    const images = imagesOf(body.images)
    if (!text.trim()) return { accepted: false, reason: 'empty' }
    if (images === null) return { accepted: false, reason: 'bad_images' }
    const target = body.conversation_url === undefined || body.conversation_url === null || body.conversation_url === '' ? null : dom.conversationUrlOf(body.conversation_url)
    if (target === null && body.conversation_url) return { accepted: false, reason: 'bad_conversation_url' }
    // a turn_id sent again while its earlier send is still on its way is refused: one message per turn at a time.
    // Its sender wants it still (the harness restarted while it went, its first request cut): it is no longer dropped
    const going = turnId ? pending.get(turnId) : undefined
    if (going) {
      if (going.digest !== digest) return conflictOf(turnId)
      if (going.dropped) { going.dropped = false; log(`[bridge] turn ${turnId} asked again while on its way: no longer dropped`) }
      return { accepted: false, reason: 'sending' }
    }
    const job = { dropped: false, words_given: false, digest }
    if (turnId) pending.set(turnId, job)
    let begun = false
    let went = false
    let claimed = false
    const dropped = () => {
      if (!job.dropped) return false
      log(`[bridge] turn ${turnId} dropped before its words went`)
      return true
    }
    const run = sending.then(async () => {
      if (dropped()) return { accepted: false, reason: 'cancelled' }
      // an agent acting on the page (computer use) has it: the message waits (asked again, as for a busy page)
      if (computer) {
        const holder = computer.holder(CHATGPT_SURFACE)
        if (holder !== null && holder !== BRIDGE_OWNER) return { accepted: false, reason: 'page_in_use', detail: holder }
        computer.claim(CHATGPT_SURFACE, BRIDGE_OWNER)
        claimed = true
      }
      sendingNow = true
      let before = await page.state()
      if (before.load_error) return { accepted: false, reason: 'page_not_loaded', detail: before.load_error }
      if (!before.logged_in) return { accepted: false, reason: 'needs_login' }
      if (before.generating) return { accepted: false, reason: 'generating' }
      if (target !== null) {
        // the conversation the message belongs to: opened unless the page shows it already
        if (dom.conversationUrlOf(before.url) !== target) {
          await page.open(target)
          before = await page.state()
          if (!before.logged_in) return { accepted: false, reason: 'needs_login' }
          if (dom.conversationUrlOf(before.url) !== target) {
            log(`[bridge] the conversation ${target} did not open (the page shows ${before.url || '?'})`)
            return { accepted: false, reason: 'conversation_not_found' }
          }
        }
      } else if (body.new_conversation) {
        await page.open()
        before = await page.state()
        if (!before.logged_in) return { accepted: false, reason: 'needs_login' }
      }
      if (dropped()) return { accepted: false, reason: 'cancelled' }
      // the files first — the images, the words themselves when long — uploaded by the page before the words go (a
      // second try of the words finds them there); with none, what an earlier message left in the composer is taken
      // away, so nothing of it rides with this one
      const { words, files } = outgoingOf(text, images, longText)
      // the page's listener takes as this turn's only the request that carries these words
      if (turnId && page.begin) { page.begin(turnId, { words }); begun = true }
      // the model and the connector go with the request, as the page sends them when the person picks them
      if (page.arm && (mention || model)) page.arm(turnId, { model, appId: mention ? mention.appId : null, markdown: mention ? mention.markdown : null })
      if (files.length && !page.attach) return { accepted: false, reason: 'images_not_attached', detail: 'no_file_input' }
      if (page.attach) {
        const attached = await page.attach(files)
        if (attached && attached.reason === 'no_composer') return composerMissing(turnId, attached)
        if (!attached || attached.ok !== true) {
          log(`[bridge] the ChatGPT page did not take the files of turn ${turnId || '(none)'}: ${JSON.stringify(attached || null)}`)
          return { accepted: false, reason: 'images_not_attached', detail: (attached && attached.reason) || 'unknown' }
        }
      }
      // the files took their time: a message dropped meanwhile goes no further
      if (dropped()) return { accepted: false, reason: 'cancelled' }
      // kept before the words go: an app that stops while they go (a crash, a kill) finds the turn at its next start
      // and does not send it again
      // numbered on from the journal's highest: an id is never given twice, across runs of the app
      sends = Math.max(sends, journal.lastMessage()) + 1
      const messageId = `m${sends}`
      if (turnId) {
        const notKept = journal.put(turnId, { state: 'submitting', at: new Date().toISOString(), digest, message_id: messageId, conversation: before.conversation || null })
        if (notKept) {
          log(`[bridge] turn ${turnId} not sent: ${notKept}`)
          return { accepted: false, reason: 'journal_unusable', detail: notKept }
        }
      }
      // the page did not take the words: the turn may go later as if never asked
      const untaken = (reply) => {
        if (turnId) { const notRemoved = journal.remove(turnId); if (notRemoved) log(`[bridge] turn ${turnId}: ${notRemoved} (it reads as unconfirmed)`) }
        return reply
      }
      job.words_given = true
      let result = await page.send(words)
      if (result && result.reason === 'no_composer') return untaken(composerMissing(turnId, result))
      if (result && result.reason === 'no_send_button') {
        // the page did not take the words (an editor not yet ready, a sheet over it): what it held goes to the log, and
        // the words go once more — unless the page did take them after all (its request left, or it shows them as
        // sent), or the message was dropped meanwhile
        log(`[bridge] the ChatGPT page did not take turn ${turnId || '(none)'}: ${JSON.stringify(result.scene || null)}`)
        await new Promise((r) => setTimeout(r, sendRetryMs))
        const now = await page.state()
        if (wentOn(now, before, turnId, words)) result = { accepted: true }
        else if (job.dropped) {
          log(`[bridge] turn ${turnId} dropped: not sent a second time`)
          return untaken({ accepted: false, reason: 'cancelled' })
        } else {
          result = await page.send(words)
          if (result && result.reason === 'no_send_button') log(`[bridge] nor on a second try: ${JSON.stringify(result.scene || null)}`)
        }
      }
      if (result && (result.reason === 'composer_not_cleared' || result.reason === 'composer_mismatch')) {
        log(`[bridge] turn ${turnId || '(none)'} not sent: the composer ${result.reason === 'composer_not_cleared' ? 'kept what it held before' : 'did not hold these words alone'}: ${JSON.stringify(result.scene || null)}`)
      }
      if (!result || result.accepted !== true) return untaken({ accepted: false, reason: (result && result.reason) || 'not_accepted' })
      // taken only when the page shows this message went: the send button pressed or the words gone from the composer
      // are no proof (a long paste leaves the composer as a file the page is still uploading — seen 2026-09-30)
      const after = await shown(before, turnId, words)
      if (after === null) {
        // submitted, and no sign it went: whether it did is the page's to show — the turn is never sent a second time
        if (turnId) {
          const notKept = journal.put(turnId, { state: 'unconfirmed', at: new Date().toISOString(), digest, message_id: messageId, conversation: before.conversation || null })
          if (notKept) log(`[bridge] turn ${turnId}: ${notKept} (it reads as unconfirmed)`)
        }
        log(`[bridge] turn ${turnId || '(none)'} did not go: its request did not leave the page and the page did not show it within ${Math.round(confirmMs / 1000)} s`)
        return { accepted: false, reason: 'not_sent' }
      }
      went = true
      const conversation = before.conversation || null
      let journalError = null
      if (turnId) {
        turns.set(turnId, { before: Number(before.assistant_count || 0), sent_at: Date.now(), message_id: messageId, conversation, answered: false, digest })
        // the conversation it went to, for a repeat after a restart (a new one has its address only now)
        journalError = journal.put(turnId, { state: 'sent', at: new Date().toISOString(), digest, message_id: messageId, conversation: conversation || after.conversation || null })
        if (journalError) log(`[bridge] turn ${turnId} went, and ${journalError}: after a restart it reads as unconfirmed`)
      }
      lastTurn = turnId || null
      log(`[bridge] sent turn ${turnId || '(none)'} (${text.length} chars${words !== text ? ` as ${files[files.length - 1].name}` : ''}${images.length ? `, ${images.length} image${images.length === 1 ? '' : 's'}` : ''}${target !== null ? ` to ${target}` : ''})`)
      if (job.dropped) {
        // dropped while its words were going: they went, and the answer nobody waits for is stopped
        pending.delete(turnId)
        const stopped = await stop(turnId)
        log(`[bridge] turn ${turnId} was dropped as it went: ${JSON.stringify(stopped)}`)
      }
      return { accepted: true, message_id: messageId, conversation, ...(journalError ? { journal_error: journalError } : {}) }
    }).finally(() => {
      sendingNow = false
      if (claimed) computer.release(CHATGPT_SURFACE, BRIDGE_OWNER)
      if (turnId && pending.get(turnId) === job) pending.delete(turnId)
      if (begun && !went && page.end) page.end(turnId)
    })
    sending = run.catch(() => {})
    return run
  }

  /** A signed-in page that shows no composer this bridge knows (the web app changed): said as such, not as a sign-in. */
  function composerMissing(turnId, result) {
    log(`[bridge] turn ${turnId || '(none)'} not sent: the ChatGPT page shows no composer (the page may have changed): ${JSON.stringify(result.scene || null)}`)
    return { accepted: false, reason: 'no_composer' }
  }

  /** A message on its way given up by its sender (its request closed, or a stop for it): it goes no further. */
  function drop(turnId) {
    const job = pending.get(turnId)
    if (!job || job.dropped) return false
    job.dropped = true
    return true
  }

  async function answer(turnId) {
    const turn = turns.get(turnId)
    if (!turn) return pending.has(turnId) ? { status: 'unknown' } : lostOf(turnId)
    // the page's own answer stream when it was heard: live progress, then the words, the reasoning and the images
    let heard = page.heard ? page.heard(turnId) : null
    // the streams quiet on an answer not done: the web app may be finishing it in the background, where only the
    // conversation has it (seen 2026-09-30) — read back from there now and then
    // (the longest thinking runs up to an hour: half as often once it has been quiet ten minutes)
    const quietFor = heard ? Date.now() - Math.max(heard.last_at || 0, turn.sent_at) : 0
    const every = quietFor >= READ_BACK_SLOWER_AFTER_MS ? readBackEveryMs * 2 : readBackEveryMs
    if (heard && heard.events > 0 && !heard.done && page.turnMessages && page.absorb && heard.conversation_id && heard.input_message_id
      && quietFor >= readBackQuietMs && Date.now() - (turn.read_back_at || 0) >= every) {
      turn.read_back_at = Date.now()
      try {
        const got = await page.turnMessages({ conversationId: heard.conversation_id, after: heard.input_message_id })
        if (got.why && got.why !== turn.read_back_why) log(`[bridge] turn ${turnId}: the conversation was not read back (${got.why})`)
        turn.read_back_why = got.why || null
        page.absorb(turnId, got.messages || [])
        heard = page.heard(turnId)
      } catch (error) { log(`[bridge] turn ${turnId}: the conversation was not read back: ${error.message}`) }
    }
    if (heard && heard.events > 0) {
      const summary = JSON.stringify({ events: heard.events, done: heard.done, text: heard.text.length, thinking: heard.thinking.length, steps: heard.steps.length, images: heard.images.length, pointers: (heard.pointers || []).length })
      if (summary !== turn.heard) { turn.heard = summary; log(`[bridge] turn ${turnId} heard: ${summary}`) }
      const progress = { thinking: heard.thinking, text: heard.text, steps: heard.steps }
      const conversation = heard.conversation_id ? { url: `${CHATGPT_URL}c/${heard.conversation_id}` } : null
      // complete, and the page quiet for a moment: a message that ends the turn may still be receiving its words (seen
      // 2026-09-27), and the images the page shows load after it
      const quietSince = Math.max(heard.done_at ?? 0, heard.last_at ?? 0)
      if (!heard.done || Date.now() - quietSince < IMAGE_SETTLE_MS) return { status: 'generating', progress, conversation }
      // the answer's pictures: those the page loaded while it formed, else fetched by the page from where it shows them
      const pointers = heard.pointers || []
      const pictures = dom.sandboxPicturesOf(heard.text)
      let images = heard.images
      // sandbox pictures the page offers as downloads (seen 2026-09-27: a download button, no picture): clicked, and
      // the downloads taken; then whatever the page shows (image pointers, a picture shown once on screen)
      if (!images.length && pictures.length && page.downloads) {
        try {
          const got = await page.downloads(pictures)
          images = got.images
          log(`[bridge] turn ${turnId}: ${images.length} of ${pictures.length} pictures taken from the page's downloads (${JSON.stringify(got.clicked)})`)
        } catch (error) { log(`[bridge] the answer's downloads could not be taken: ${error.message}`) }
      }
      if (!images.length && (pointers.length || pictures.length) && page.images) {
        try { images = await page.images({ ids: pointers.map((p) => String(p.pointer).split('://').pop()), pictures }) } catch (error) { log(`[bridge] the answer's images could not be fetched: ${error.message}`) }
      }
      let text = heard.text.trim()
      if (!text && !pointers.length) text = String((await page.answer()).text || '').trim()
      if (!text && pointers.length) text = images.length ? 'ChatGPT answered with an image.' : 'ChatGPT answered with an image; it shows in the ChatGPT conversation.'
      if (!text) return { status: 'generating', progress, conversation }
      // the text files the answer links to in its sandbox (code, data): their words join the answer, so the session
      // — and whoever reads the answer next — has them, not a link to ChatGPT's sandbox
      const files = dom.sandboxFilesOf(text)
      if (files.length && page.files && heard.conversation_id && heard.message_id) {
        try {
          const got = await page.files({ conversationId: heard.conversation_id, messageId: heard.message_id, files: files.slice(0, MAX_ANSWER_FILES) })
          text = dom.withAnswerFiles(text, got.files || [])
          log(`[bridge] turn ${turnId}: ${(got.files || []).length} of ${files.length} files taken${(got.missed || []).length ? ` (missed: ${JSON.stringify(got.missed)})` : ''}`)
        } catch (error) { log(`[bridge] the answer's files could not be taken: ${error.message}`) }
      }
      const s = await page.state()
      log(`[bridge] turn ${turnId} answered (${text.length} chars, ${images.length} of ${pointers.length + pictures.length} images)`)
      turn.answered = true
      return { status: 'done', text, thinking: heard.thinking, steps: heard.steps, images, model: s.model || null, conversation: conversation || s.conversation || null }
    }
    const a = await page.answer()
    // what the page shows while the answer is awaited, logged when it changes: the evidence when an answer never lands
    const seen = JSON.stringify({ count: a.count, generating: !!a.generating, text: String(a.text || '').length, why: a.why || null })
    if (seen !== turn.seen) { turn.seen = seen; log(`[bridge] turn ${turnId} waits (${turn.before} before): ${seen}`) }
    const conversation = a.url && /\/c\//.test(a.url) ? { url: a.url } : null
    if (Number(a.count || 0) <= turn.before) return { status: 'generating', conversation }
    if (a.generating) return { status: 'generating', conversation }
    const text = String(a.text || '').trim()
    if (!text) return { status: 'generating', conversation }
    const s = await page.state()
    turn.answered = true
    return { status: 'done', text, model: s.model || null, conversation: conversation || s.conversation || null }
  }

  /** A turn the journal holds that this run of the app did not send (it went before a restart, or went with no sign
   *  it did): its answer forms, or formed, on the page only — said as such, for good; `unknown` for a turn neither
   *  knows. */
  function lostOf(turnId) {
    const kept = turnId ? journal.get(turnId) : null
    if (!kept) return { status: 'unknown' }
    const conversation = kept.conversation && typeof kept.conversation === 'object' ? kept.conversation : null
    const where = conversation && conversation.url ? ` (${conversation.url})` : ''
    if (kept.state === 'sent') return { status: 'lost', reason: 'restarted', detail: `the message went at ${kept.at}, before the desktop app restarted; its answer is on the ChatGPT page${where} and is not read back`, conversation }
    if (kept.damaged_log) return { status: 'lost', reason: 'unconfirmed', detail: `the message is named in the send log that was damaged (${kept.damaged_log}); whether it went is not known — the ChatGPT page shows whether it did`, conversation }
    return { status: 'lost', reason: 'unconfirmed', detail: `the message was given to the page at ${kept.at} with no sign that it went; the ChatGPT page${where} shows whether it did`, conversation }
  }

  /** The page's stop button for the message last sent, while its own answer forms: a turn the page has moved on from,
   *  one answered, or one it never had, is left alone — the answer forming may be the person's. */
  async function stop(turnId) {
    // a message still on its way: dropped — before its words went, it never goes; after, it is stopped once it shows
    const job = pending.get(turnId)
    if (job) {
      drop(turnId)
      log(`[bridge] stop for turn ${turnId}: dropped while ${job.words_given ? 'its words were going (stopped once it shows it went)' : 'on its way (its words will not go)'}`)
      return job.words_given ? { stopped: false, reason: 'sending' } : { stopped: true, sent: false }
    }
    const turn = turns.get(turnId)
    if (!turn) {
      const kept = turnId ? journal.get(turnId) : null
      return { stopped: false, reason: kept && kept.state === 'sent' ? 'restarted' : 'unknown' }
    }
    if (turnId !== lastTurn) return { stopped: false, reason: 'not_current' }
    if (turn.answered) return { stopped: false, reason: 'not_generating' }
    // the page's listener knows whose stream forms: this turn's answer complete, or a message the person sent after it
    const heard = page.heard ? page.heard(turnId) : null
    if (heard && heard.done) return { stopped: false, reason: 'not_generating' }
    if (heard && heard.current === false) return { stopped: false, reason: 'not_current' }
    const s = await page.state()
    if (!s.generating) return { stopped: false, reason: 'not_generating' }
    const result = page.stop ? await page.stop() : { clicked: false }
    log(`[bridge] stop for turn ${turnId}: ${result && result.clicked ? `clicked${result.stopped === false ? ', the answer still forming' : ''}` : 'no stop button'}`)
    if (!result || !result.clicked) return { stopped: false, reason: 'no_stop_button' }
    // clicked, and the page still forms the answer: it is not stopped, whatever was clicked
    if (result.stopped === false) return { stopped: false, reason: 'still_generating' }
    turn.answered = true
    return { stopped: true }
  }

  /** Why an agent may not act on the page now (computer use), or null: a message going, or the answer to the last one
   *  still forming on it. */
  async function busyForAgent() {
    if (sendingNow) return 'the bridge is sending a message to ChatGPT on this page; wait for it, then look again'
    const turn = lastTurn ? turns.get(lastTurn) : null
    if (turn && !turn.answered) {
      let generating = false
      try { generating = !!(await page.state()).generating } catch { generating = false }
      if (generating) return 'ChatGPT is answering a message oasis-code sent on this page; wait for the answer, then look again'
    }
    return null
  }

  return {
    state, send, answer, stop, drop, turns, busyForAgent,
    /** The send log as the ChatGPT card shows it (see fileJournal's `state`). */
    journalState: () => journal.state(),
    /** The person resumes sending after a damaged send log (see fileJournal's `resume`). */
    resumeSending: () => journal.resume(),
  }
}

/** The Authorization header against the token, in constant time (a length difference alone says nothing more). */
function tokenMatches(header, token) {
  const given = Buffer.from(header)
  const wanted = Buffer.from(`Bearer ${token}`)
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted)
}

/** Whether the caller gave up on a reply (its request closed before the reply went): a computer action still waiting
 *  its turn is then dropped, not done for nobody. */
function closedOf(res) {
  let closed = false
  res.once('close', () => { if (!res.writableEnded) closed = true })
  return () => closed
}

/** The loopback ports of the harness itself — the backend's, the director's, this bridge's, the gateway's — which the agent's browser
 *  never opens (a page there could act as the person on the harness). */
function harnessPortsOf(env, bridgePort) {
  // the standing gateway's loopback port too: it serves the director's tools to whoever holds its secret
  return [env.OASIS_CODE_PORT || BACKEND_PORT, env.OASIS_CODE_DIRECTOR_PORT || DEFAULT_DIRECTOR_PORT, bridgePort, env.OASIS_CODE_GATEWAY_PORT || DEFAULT_GATEWAY_PORT].map(Number).filter((p) => Number.isInteger(p) && p > 0)
}

/** The bridge as an HTTP server on the loopback: every route under the token, JSON both ways. */
function serveBridge({ bridge, computer = null, token, port, host = '127.0.0.1', log = () => {} }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}`)
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    try {
      if (url.pathname === '/healthz') return reply(200, { ok: true, bridge: 'oasis-code chatgpt' })
      if (!tokenMatches(req.headers.authorization || '', token)) return reply(401, { detail: 'bad bridge token' })
      if (req.method === 'GET' && url.pathname === '/state') return reply(200, await bridge.state())
      if (req.method === 'POST' && url.pathname === '/send') {
        const body = await readJson(req, MAX_SEND_BODY)
        // a sender that gave up (its request closed before the reply) drops its message: the words do not go after it
        const turnId = body && typeof body.turn_id === 'string' ? body.turn_id : ''
        const gaveUp = () => { if (!res.writableEnded && turnId && bridge.drop(turnId)) log(`[bridge] the request for turn ${turnId} closed before its reply: the message is dropped`) }
        res.once('close', gaveUp)
        const out = await bridge.send(body)
        res.removeListener('close', gaveUp)
        return reply(200, out)
      }
      if (req.method === 'GET' && url.pathname === '/answer') return reply(200, await bridge.answer(url.searchParams.get('turn_id') || ''))
      if (req.method === 'POST' && url.pathname === '/stop') { const body = await readJson(req); return reply(200, await bridge.stop(typeof body.turn_id === 'string' ? body.turn_id : '')) }
      if (computer && req.method === 'GET' && url.pathname === '/computer/surfaces') return reply(200, computer.list())
      if (computer && req.method === 'POST' && url.pathname === '/computer/observe') return reply(200, await computer.observe(await readJson(req), { closed: closedOf(res) }))
      if (computer && req.method === 'POST' && url.pathname === '/computer/act') return reply(200, await computer.act(await readJson(req), { closed: closedOf(res) }))
      if (computer && req.method === 'POST' && url.pathname === '/computer/release') return reply(200, computer.releaseOwner(await readJson(req)))
      return reply(404, { detail: 'not found' })
    } catch (error) {
      log(`[bridge] ${req.method} ${url.pathname} failed: ${error.message}`)
      return reply(500, { detail: error.message })
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve({ server, port: server.address().port, url: `http://${host}:${server.address().port}`, close: () => new Promise((r) => server.close(() => r())) }))
  })
}

/** Where the renderer wants the page: the ChatGPT card's body in the main window's coordinates, and whether it
 *  shows (a card shelved, behind another, or under a dialog or a menu does not). Anything malformed reads as hidden. */
function viewPlaceOf(raw) {
  const hidden = { x: 0, y: 0, width: 0, height: 0, visible: false }
  if (!raw || typeof raw !== 'object') return hidden
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100_000, Math.round(v))) : null)
  const [x, y, width, height] = [n(raw.x), n(raw.y), n(raw.width), n(raw.height)]
  if (x === null || y === null || width === null || height === null) return hidden
  return { x, y, width, height, visible: raw.visible === true && width > 0 && height > 0 }
}

/** The page adapter over chatgpt.com in a view of the app's own window (the ChatGPT card of the desk shows it): a
 *  persistent partition of its own (the sign-in stays between starts), no preload, no Node, navigation confined to
 *  the sign-in and chat hosts. The page lives as long as the app; the card only places it or hides it, so closing
 *  the card never ends the conversation and a director reading it never brings a window back. */
/** The page's own browser profile: its cookies are the ChatGPT sign-in, kept across the app's restarts. */
const PARTITION = 'persist:oasis-code-chatgpt'
/** ChatGPT's sign-in cookie (split in parts, `.0`, `.1`, seen 2026-09-30). */
const SESSION_COOKIE = '__Secure-next-auth.session-token'

/** Whether the profile's cookies can hold a sign-in: false when ChatGPT's session cookie is not among them (the page
 *  is signed out, whatever it would show); true when it is (it may still have expired: the page's own session says). */
function sessionCookiePresent(cookies) {
  return (cookies || []).some((c) => c && typeof c.name === 'string' && (c.name === SESSION_COOKIE || c.name.startsWith(`${SESSION_COOKIE}.`)))
}

function electronPage({ WebContentsView, host, shell, log = () => {}, captureDir = null, onConnector = () => {}, session = null, stage = null }) {
  let view = null
  let attachedTo = null
  let tap = null
  let place = viewPlaceOf(null)
  // the page's last load that failed (a proxy's tunnel refused, the network down), and the retry it waits for: the
  // page is not shown meanwhile (Chromium's error page is a blank) and the card says why
  let loadError = null
  let retry = null
  let retries = 0
  // hidden, the page keeps a real size (it lays out and loads its images as it would on screen)
  let bounds = { x: 0, y: 0, width: 1100, height: 800 }
  const showing = () => place.visible && loadError === null
  // shown, the page is on the card; hidden, it lives backstage (a window never shown) at the size it last showed at —
  // hidden inside the app's window it drew nothing new and took no size (a page never shown laid out at 0×0, seen
  // 2026-10-01); with no backstage (a test) it stays hidden in the app's window
  const apply = () => {
    if (!view || view.webContents.isDestroyed()) return
    if (place.visible) bounds = { x: place.x, y: place.y, width: place.width, height: place.height }
    attachedTo = seatView(view, { attachedTo, show: showing(), place: bounds, size: bounds, host, stage })
  }
  const reload = () => {
    clearTimeout(retry)
    retry = null
    if (!view || view.webContents.isDestroyed()) { ensure(); return }
    void view.webContents.loadURL(CHATGPT_URL).catch(() => undefined)
  }
  const ensure = () => {
    if (!view || view.webContents.isDestroyed()) {
      view = new WebContentsView({
        webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
      })
      view.setBackgroundColor('#ffffff')
      view.setVisible(false)
      attachedTo = null
      view.webContents.setWindowOpenHandler(({ url }) => {
        if (dom.allowedInBridge(url)) return { action: 'allow' }
        if (/^https?:/.test(url)) void shell.openExternal(url)
        return { action: 'deny' }
      })
      view.webContents.on('will-navigate', (event, url) => { if (!dom.allowedInBridge(url)) { event.preventDefault(); if (/^https?:/.test(url)) void shell.openExternal(url) } })
      tap = tapPage(view.webContents, { log, captureDir, onConnector })
      view.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
        // -3 is a load the page itself replaced (a redirect, a navigation over it): not a failure
        if (!isMainFrame || code === -3) return
        loadError = `${description || 'the page did not load'} (${code})`
        const wait = RETRY_S[Math.min(retries, RETRY_S.length - 1)]
        retries += 1
        log(`[bridge] the ChatGPT page did not load (${loadError}, ${url}); again in ${wait} s`)
        apply()
        clearTimeout(retry)
        retry = setTimeout(reload, wait * 1000)
      })
      view.webContents.on('did-finish-load', async () => {
        const chatgpt = (url) => /^https:\/\/[^/]*chatgpt\.com\//.test(String(url || ''))
        if (!chatgpt(view.webContents.getURL())) return
        // an error page finishing is no load: after a failure the view still names the address it tried (seen
        // 2026-09-29), so the document is asked where it is — Chromium's error page is at chrome-error://
        if (loadError !== null) {
          let at = null
          try { at = await view.webContents.executeJavaScript('location.href', true) } catch { /* no document to ask */ }
          if (!chatgpt(at)) return
          log('[bridge] the ChatGPT page loaded')
        }
        loadError = null
        retries = 0
        clearTimeout(retry)
        retry = null
        apply()
      })
      void view.webContents.loadURL(CHATGPT_URL).catch(() => undefined)
      log('[bridge] the ChatGPT page opened')
    }
    // the app's window may have been closed and opened again (macOS keeps the app): the page moves to the new one
    const win = showing() || !stage ? host() : stage.window()
    if (win && !win.isDestroyed() && attachedTo !== win) apply()
    return view
  }
  const run = async (script) => JSON.parse(await ensure().webContents.executeJavaScript(script, true))
  const waitForPage = async () => {
    const deadline = Date.now() + OPEN_TIMEOUT_MS
    while (Date.now() < deadline) {
      try { const s = await run(dom.stateScript()); if (s.logged_in || document_has_login(s)) return } catch { /* still loading */ }
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  const document_has_login = (s) => s && s.ok && !s.logged_in && typeof s.url === 'string' && !/^about:/.test(s.url)
  // an earlier conversation: its messages render after the page does; the count settles before a new message goes,
  // so the answer read off the page (when the stream was not heard) is the one after it
  const waitForMessages = async () => {
    const deadline = Date.now() + OPEN_TIMEOUT_MS / 2
    let last = -1
    let steady = 0
    while (Date.now() < deadline) {
      let count = -1
      try { count = Number((await run(dom.stateScript())).assistant_count || 0) } catch { /* still loading */ }
      if (count > 0 && count === last) { steady += 1; if (steady >= 3) return } else steady = 0
      last = count
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  return {
    load: () => { ensure() },
    /** whether the page exists yet (creating it holds the app's main thread for a moment, so a mere look does not) */
    opened: () => !!view && !view.webContents.isDestroyed(),
    /** Whether the profile holds ChatGPT's sign-in cookie, read without opening the page (null: not readable here). */
    signInCookie: async () => {
      if (!session || typeof session.fromPartition !== 'function') return null
      try { return sessionCookiePresent(await session.fromPartition(PARTITION).cookies.get({ url: 'https://chatgpt.com' })) } catch { return null }
    },
    /** The page itself (opened when it was not), for the computer's driver. */
    contents: () => ensure().webContents,
    begin: (turnId, expect) => { ensure(); if (tap) tap.begin(turnId, expect) },
    end: (turnId) => { if (tap) tap.end(turnId) },
    heard: (turnId) => (tap ? tap.heard(turnId) : null),
    absorb: (turnId, messages) => { if (tap) tap.absorb(turnId, messages) },
    turnMessages: (want) => run(dom.turnScript(want)),
    place: (raw) => { place = viewPlaceOf(raw); if (place.visible) ensure(); apply() },
    reload,
    close: () => {
      clearTimeout(retry)
      if (tap) tap.detach()
      tap = null
      if (view && !view.webContents.isDestroyed()) {
        if (attachedTo && !attachedTo.isDestroyed()) attachedTo.contentView.removeChildView(view)
        view.webContents.close()
      }
      view = null
      attachedTo = null
    },
    // a page that did not load says so (its error page has no composer, which would read as signed out)
    state: async () => (loadError !== null ? { ok: true, logged_in: false, generating: false, url: view ? view.webContents.getURL() : null, load_error: loadError } : run(dom.stateScript())),
    open: async (url) => {
      const target = url ? dom.conversationUrlOf(url) : null
      await ensure().webContents.loadURL(target || CHATGPT_URL)
      await waitForPage()
      if (target) await waitForMessages()
    },
    stop: () => run(dom.stopScript()),
    send: (text) => run(dom.sendScript(text)),
    attach: (images) => run(dom.attachScript(images)),
    arm: (turnId, patch) => { ensure(); if (tap) tap.arm(turnId, patch) },
    // the answer's pictures, given the page a few seconds to show those it shows only once on screen
    images: (want) => run(dom.imagesScript(want, 8, 8_000)),
    downloads: (pictures) => takeDownloads(ensure().webContents, () => run(dom.downloadScript(pictures))),
    answer: () => run(dom.answerScript()),
    files: (want) => run(dom.filesScript({ ...want, maxChars: MAX_FILE_CHARS })),
  }
}

/** What the person's own use of the ChatGPT page says, kept in the data directory: the oasis-code connector as ChatGPT
 *  names it (`[$oasis-code](app://asdk_app_…)`, from a message sent with it @-mentioned, or handed over by the page — a
 *  value the person set before) and the model they last chose (a new conversation otherwise starts on the web app's
 *  default). Every message oasis-code sends goes with both. */
const CONNECTOR_FILE = 'chatgpt-connector.json'
const CONNECTOR = /^\[\$[^\]]{1,80}\]\(app:\/\/[\w-]{1,120}\)$/
const MODEL = /^[a-z0-9][a-z0-9._-]{0,60}$/i
function chatGptPrefs(dataDir) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, CONNECTOR_FILE), 'utf8'))
    return {
      mention: typeof saved.mention === 'string' && CONNECTOR.test(saved.mention) ? saved.mention : null,
      model: typeof saved.model === 'string' && MODEL.test(saved.model) && saved.model !== 'auto' ? saved.model : null,
    }
  } catch { return { mention: null, model: null } }
}
function connectorOf(dataDir) {
  return chatGptPrefs(dataDir).mention
}
function rememberChatGpt(dataDir, { mention, model }) {
  const was = chatGptPrefs(dataDir)
  const next = { ...was }
  if (mention !== undefined && CONNECTOR.test(String(mention || '').trim())) next.mention = String(mention).trim()
  if (model !== undefined && MODEL.test(String(model || '')) && model !== 'auto') next.model = model
  if (next.mention === was.mention && next.model === was.model) return false
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, CONNECTOR_FILE), JSON.stringify({ ...next, at: new Date().toISOString() }), { mode: 0o600 })
  return true
}
function rememberConnector(dataDir, mention) {
  return CONNECTOR.test(String(mention || '').trim()) && (rememberChatGpt(dataDir, { mention }) || connectorOf(dataDir) === String(mention).trim())
}

/** The bridge token, kept in the data directory (0600) so a director opened in an earlier run of the app still
 *  reaches the bridge, and the backend (same machine, same data directory) reads the live one from there. */
const TOKEN_FILE = 'bridge-token'
/** Where the bridge listens, beside its token: the backend reads it at every call (a backend this app attached to
 *  was not started with this app's OASIS_CODE_BRIDGE_PORT, and looked for the page at the default port, seen
 *  2026-09-30). */
const URL_FILE = 'bridge-url'
function rememberBridgeUrl(dataDir, url) {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, URL_FILE), `${url}\n`)
}
function bridgeTokenOf(dataDir) {
  const file = path.join(dataDir, TOKEN_FILE)
  try { const saved = fs.readFileSync(file, 'utf8').trim(); if (saved) return saved } catch { /* none yet */ }
  const token = crypto.randomBytes(18).toString('base64url')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(file, token, { mode: 0o600 })
  return token
}

/** The whole bridge inside the desktop app: the page (loaded on first use, shown on the ChatGPT card), the server,
 *  the token. */
async function startBridge({ WebContentsView, BrowserWindow = null, nativeImage = null, host, shell, port, dataDir, log = () => {}, session = null }) {
  const token = bridgeTokenOf(dataDir)
  const onConnector = (learnt) => { if (rememberChatGpt(dataDir, learnt)) log(`[bridge] learnt from a message sent on the page: ${[learnt.mention && 'the oasis-code connector', learnt.model && `the model ${learnt.model}`].filter(Boolean).join(' and ')}`) }
  // where a page lives while no card shows it
  const stage = BrowserWindow ? backstage({ BrowserWindow }) : null
  const page = electronPage({ WebContentsView, host, shell, log, captureDir: path.join(dataDir, 'logs', 'bridge-capture'), onConnector, session, stage })
  // computer use: the agent's own browser and this ChatGPT page, as surfaces an agent looks at and acts on
  // what an agent's pages download, until its run takes it into its own folder (a day at most)
  const downloadsDir = path.join(dataDir, COMPUTER_DOWNLOADS)
  const pruned = pruneDownloads(downloadsDir)
  if (pruned) log(`[computer] ${pruned} downloads no run took were removed`)
  let bridgePort = Number(port)
  // the card's controls (made beside the surface, which asks them whether the person is picking an element)
  let controls = null
  const browser = agentBrowser({ WebContentsView, host, stage, log, harnessPorts: () => harnessPortsOf(process.env, bridgePort), profile: () => (session ? session.fromPartition(BROWSER_PARTITION) : null) })
  // every tab of the agent's browser is a surface of its own (its driver, generation, looks, person's input, dialog,
  // file chooser, console and downloads): a download is its tab's run's while that run holds the tab; it draws at 2x on
  // any screen (its picture on the Browser card is a Retina screen's pixels), the ChatGPT page at its screen's
  const tabs = browserTabs({
    browser, log,
    surfaceOf: (id, contents, opened) => electronSurface({ label: `the agent's browser (${id})`, contents, opened, pageId: () => browser.documentOf(id), allowsUrl: browser.allows, log, downloadsDir, console: true, unheldDownloads: 'cancel', visibility: () => browser.visibilityOf(id), nativeImage, deviceScale: BROWSER_DEVICE_SCALE, routeDownloads: false, busy: () => (controls && controls.picking(id) ? 'the person is picking an element on the page (the Browser card\'s picker); wait, then look again' : null) }),
  })
  // the person's use of a tab (its input, address bar, picker) is that tab's: another tab's looks stay as they are
  const personSide = { personUsed: (id) => { const surface = id ? tabs.page(id) : null; if (surface) surface.personUsed() } }
  controls = browserControls({ browser, surface: personSide, pick: (wc) => pickElement(wc, { log }) })
  // the Browser card's picture (shown while something covers the card) and the thread's live view ask for the same
  // page: one capture serves both (per tab: two tabs never share a picture)
  const frames = sharedFrames()
  browser.onClosed((id) => frames.drop(`browser/${id}`))
  let bridge = null
  const chatgptSurface = electronSurface({ label: 'the ChatGPT page', contents: page.contents, opened: page.opened, allowsUrl: dom.allowedInBridge, busy: () => (bridge ? bridge.busyForAgent() : null), log, downloadsDir, nativeImage })
  const computer = createComputer({ surfaces: { browser: tabs, chatgpt: chatgptSurface }, log })
  browser.bindHolder((id) => computer.holderOfTab('browser', id))
  // agent tabs idle for ten minutes (nobody holds them, nothing under way, not on the card) are closed
  const reaper = setInterval(() => { try { computer.reap() } catch (error) { log(`[computer] closing idle tabs failed: ${error.message}`) } }, 60_000)
  if (typeof reaper.unref === 'function') reaper.unref()
  const statusOf = () => ({ ...browser.status(), holder: computer.holderOfTab('browser', browser.activeTab()), can_clear_data: computer.canClear('browser') })
  bridge = createBridge({ page, token, log, computer, journal: fileJournal(dataDir, log) })
  const served = await serveBridge({ bridge, computer, token, port, log })
  bridgePort = served.port
  rememberBridgeUrl(dataDir, served.url)
  log(`[bridge] listening on ${served.url}`)
  return {
    url: served.url, token, page,
    // the computer and the agent's browser themselves (the shell uses the calls below; a test reaches in)
    computer, browser,
    load: () => page.load(),
    /** Whether the page is signed in (the page loads if it had not — unless `load` is false: then a page not opened yet
     *  answers `started: false`, signed out when its profile holds no sign-in cookie — the @ menu then offers the
     *  sign-in at once — and unknown otherwise), and the connector known. */
    status: async ({ load = true } = {}) => {
      if (!load && !page.opened()) {
        const prefs = chatGptPrefs(dataDir)
        const cookie = await page.signInCookie()
        return { started: false, logged_in: cookie === false ? false : null, connector: prefs.mention, model: prefs.model, journal: bridge.journalState() }
      }
      let signedIn = null
      let loadError = null
      try { const s = await page.state(); signedIn = s.load_error ? null : !!s.logged_in; loadError = s.load_error || null } catch { signedIn = null }
      const prefs = chatGptPrefs(dataDir)
      return { started: true, logged_in: signedIn, connector: prefs.mention, model: prefs.model, load_error: loadError, journal: bridge.journalState() }
    },
    /** The ChatGPT card's "Resume sending" after a damaged send log: the send log's state after it. */
    resumeSending: () => ({ ...bridge.resumeSending(), journal: bridge.journalState() }),
    reload: () => page.reload(),
    place: (raw) => page.place(raw),
    /** Where the desk's Browser card wants the agent's browser. */
    placeBrowser: (raw) => browser.place(viewPlaceOf(raw)),
    /** The agent's browser as the Browser card shows it: its page, and the run acting on it. */
    browserStatus: () => statusOf(),
    /** The Browser card's own controls (the person's: an agent's look before them is stale): its tabs, address bar,
     *  back, forward, reload, stop, and the element picker. */
    browserTab: (raw) => ({ ...controls.tab(raw), status: statusOf() }),
    browserNavigate: (raw) => ({ ...controls.navigate(raw), status: statusOf() }),
    browserInput: (raw) => controls.input(raw),
    pickBrowserElement: () => controls.pick(),
    cancelBrowserPick: () => controls.cancelPick(),
    /** The Browser card's "Clear browser data": refused while a run holds the browser (see clearBrowserData). */
    clearBrowserData: () => clearBrowserData({ computer, browser, log }),
    /** A surface as the thread's live view shows it (see liveFrame): `surfaceFrame('chatgpt')`; `surfaceFrame('browser')`
     *  is the tab the Browser card shows; `surfaceFrame('browser', owner)` (or `{ surface, owner }`) is that run's
     *  current tab — never another run's, and nothing when it has none. */
    surfaceFrame: (raw, ownerArg = null) => {
      const ask = frameAsk(raw, ownerArg)
      if (ask.surface === CHATGPT_SURFACE) {
        const identity = () => `${chatgptSurface.pageId() ?? ''}|${chatgptSurface.generation()}`
        return frames(CHATGPT_SURFACE, identity(), () => liveFrame(computer, CHATGPT_SURFACE, chatgptSurface), identity)
      }
      const tab = ask.owner ? computer.currentTab(ask.owner, 'browser') : browser.activeTab()
      const surface = tab ? tabs.page(tab) : null
      if (!surface) return Promise.resolve({ surface: 'browser', tab_id: null, holder: null, last: null, takes: 0, doing: null, pointer: null, image: null })
      // shared only among asks of the same tab as it was (its generation): a picture under way is never handed to an
      // ask of another tab, nor of the same tab after it changed
      const identity = () => `${tab}|${surface.generation()}`
      // a picture dropped because its tab changed while it was taken still says whose tab it is
      const nothing = () => ({ surface: 'browser', tab_id: tab, holder: null, last: null, doing: null, pointer: null, ...(computer.watch('browser', tab) || {}), image: null })
      const taken = frames(`browser/${tab}`, identity(), () => liveFrame(computer, 'browser', surface, tab), identity).then((frame) => frame || nothing())
      // a run's own tab: its document identity rides as `document` (`page` is the card's showing identity only)
      if (ask.owner) return taken.then((frame) => { if (!frame) return frame; const { page, ...rest } = frame; return { ...rest, ...(page ? { document: page } : {}) } })
      // the card's picture names the showing it was asked for (`page`, which the card's input carries back): kept only
      // when the card still shows that tab in that showing once the picture is in
      const shown = browser.shownPage()
      return taken.then((frame) => (frame && browser.activeTab() === tab && browser.shownPage() === shown ? { ...frame, page: shown } : { ...frame, image: null, page: browser.shownPage() }))
    },
    close: async () => { clearInterval(reaper); controls.cancelPick(); page.close(); browser.close(); tabs.dispose(); if (stage) stage.close(); await served.close() },
  }
}

/** The person's own controls of the agent's browser, from the Browser card: tabs (`{ action: 'new' | 'switch' |
 *  'close', id?, url? }`), the address bar and its buttons (`{ action: 'go' | 'back' | 'forward' | 'reload' | 'stop',
 *  url? }`) and the element picker (one at a time; a new pick, a tab change or a navigation ends the one under way).
 *  Each is the person's use of the page (`surface.personUsed`): an agent's look before it is stale, an agent's next
 *  action waits a moment — the same as their click on the page. Nothing here is an agent's: no tool reaches it. */
function browserControls({ browser, surface, pick }) {
  let picking = null
  let inputs = Promise.resolve()
  let queuedMove = null
  const endPick = () => { if (picking) { picking.cancel(); picking = null } }
  const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : null)
  return {
    tab(raw) {
      const action = raw && typeof raw === 'object' ? raw.action : null
      endPick()
      if (action === 'new') {
        const id = browser.newTab(str(raw.url))
        if (id === null) return { ok: false, reason: 'no new tab (too many tabs, or an address the browser does not open)' }
        surface.personUsed(id)
        return { ok: true, id }
      }
      // showing another tab only changes what the card shows: no tab's page changed, no agent's look goes stale (the
      // card's queued input of the tab shown before is refused by its showing identity)
      if (action === 'switch') {
        if (!browser.switchTab(str(raw.id, 40))) return { ok: false, reason: 'no such tab' }
        return { ok: true }
      }
      // closing a tab (any, a run's too: the person may take any page back) ends it; the run's looks of it are stale
      if (action === 'close') {
        if (!browser.closeTab(str(raw.id, 40))) return { ok: false, reason: 'no such tab' }
        return { ok: true }
      }
      return { ok: false, reason: 'unknown tab action' }
    },
    navigate(raw) {
      const action = raw && typeof raw === 'object' ? raw.action : null
      if (!['go', 'back', 'forward', 'reload', 'stop'].includes(action)) return { ok: false, reason: 'unknown action' }
      endPick()
      const tab = browser.activeTab()
      const out = browser.navigate(action, str(raw.url))
      if (out.ok) surface.personUsed(browser.activeTab() || tab)
      return out
    },
    /** Person input uses CDP because the fixed browser's hidden window must never take focus. Queue input so a
     *  quick down/up or a key and its text keep order; recheck the tab before every dispatch. */
    input(raw) {
      let command = browserInputCommand(raw)
      if (!command) return Promise.resolve({ ok: false, reason: 'invalid browser input' })
      const page = browser.shownPage()
      if (!browser.opened() || !browser.visibility().shown || (raw.page !== undefined && raw.page !== page)) return Promise.resolve({ ok: false, reason: 'the pictured page is no longer shown' })
      const wc = browser.contents()
      const tab = browser.activeTab()
      // Keep one latest move between input boundaries. A slow capture must not queue hundreds of stale hover
      // positions ahead of the person's mouse-up or typing; down/up/key/wheel events are never coalesced.
      if (raw.type === 'mouseMove' && queuedMove && queuedMove.page === page) {
        queuedMove.update(command)
        return queuedMove.pending
      }
      const slot = { page, pending: null, update: (next) => { command = next } }
      queuedMove = raw.type === 'mouseMove' ? slot : null
      if (raw.type !== 'mouseMove') surface.personUsed(tab)
      const stillShown = () => !wc.isDestroyed() && browser.visibility().shown && browser.shownPage() === page
      const perform = async () => {
        if (queuedMove === slot) queuedMove = null
        if (!stillShown()) return { ok: false, reason: 'the pictured page is no longer shown' }
        const cdp = cdpOf(wc)
        if (!cdp) return { ok: false, reason: 'browser input is unavailable' }
        if (raw.type === 'mouseDown') {
          // The same non-mutating draw as agent pointer warm-up: never a clipped/fromSurface capture.
          await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 1, fromSurface: false }, 3000).catch(() => undefined)
          if (!stillShown()) return { ok: false, reason: 'the pictured page is no longer shown' }
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: command.params.x, y: command.params.y, modifiers: command.params.modifiers })
          await new Promise((resolve) => setTimeout(resolve, 100))
          if (!stillShown()) return { ok: false, reason: 'the pictured page is no longer shown' }
        }
        await cdp.send(command.method, command.params)
        return { ok: true }
      }
      const pending = inputs.then(perform).catch(() => ({ ok: false, reason: 'browser input could not be delivered' }))
      slot.pending = pending
      inputs = pending.then(() => undefined)
      return pending
    },
    /** What the person picked on the page shown (null: cancelled, or the page went elsewhere). */
    async pick() {
      endPick()
      if (typeof browser.clearing === 'function' && browser.clearing()) return null
      const wc = browser.contents()
      const tab = browser.activeTab()
      surface.personUsed(tab)
      const mine = pick(wc)
      mine.tab = tab
      picking = mine
      const got = await mine.promise
      if (picking === mine) picking = null
      return got
    },
    cancelPick() { endPick(); return true },
    /** Whether the person is picking an element now (an agent waits: its press would be taken for the pick). */
    picking: (tab) => picking !== null && (tab === undefined || picking.tab === undefined || picking.tab === tab),
  }
}

/** Live pictures shared by their askers: one capture under way per surface (a second asker waits for it), and its
 *  answer given again to an ask within `keepMs` of it — the Browser card and the thread's live view ask on their own
 *  clocks (250 ms, 120 ms) and would otherwise make two captures where one shows the same page. Shared only among asks
 *  of the same `identity` (the page shown and its generation): an ask after the person changed the tab, or the page
 *  changed, starts its own capture, and a capture's answer is kept only when the page is still the one it started on
 *  (`identityNow`). One entry per surface. */
const FRAME_SHARE_MS = 100
function sharedFrames({ keepMs = FRAME_SHARE_MS, now = Date.now } = {}) {
  const kept = new Map()               // surface (or browser tab) -> { identity, at, value } | { identity, pending }
  const shared = (key, identity, take, identityNow = () => identity) => {
    const was = kept.get(key)
    if (was && was.identity === identity && was.pending) return was.pending
    if (was && was.identity === identity && !was.pending && now() - was.at < keepMs) return Promise.resolve(was.value)
    const entry = { identity, pending: null }
    entry.pending = Promise.resolve().then(take).then((value) => {
      const current = identityNow() === identity
      if (kept.get(key) === entry) { if (current) kept.set(key, { identity, at: now(), value }); else kept.delete(key) }
      return current ? value : null
    }, (error) => { if (kept.get(key) === entry) kept.delete(key); throw error })
    kept.set(key, entry)
    return entry.pending
  }
  /** A page gone (a tab closed): nothing of it is kept. */
  shared.drop = (key) => { kept.delete(key) }
  shared.size = () => kept.size
  return shared
}

/** What a live-picture ask names: the old string (`'browser'`, `'chatgpt'`) or `{ surface, owner }` — the owner a
 *  run id (letters, digits, `_ - : .`, at most 100), anything else none. */
function frameAsk(raw, ownerArg = null) {
  const pick = raw && typeof raw === 'object' ? raw : { surface: raw, owner: ownerArg }
  const surface = pick.surface === CHATGPT_SURFACE ? CHATGPT_SURFACE : 'browser'
  const owner = surface === 'browser' && typeof pick.owner === 'string' && /^[\w:.-]{1,100}$/.test(pick.owner) ? pick.owner : null
  return { surface, owner }
}

/** The agent browser's profile cleared at the person's ask (the Browser card): its cookies, site storage and cache
 *  gone — every project and session signed out, since the profile is one for all — and its page blank with no
 *  history. Never while a run holds the browser: an agent would find itself signed out mid-task. */
async function clearBrowserData({ computer, browser, log = () => {} }) {
  try {
    await computer.whenFree('browser', () => browser.clearData())
  } catch (error) {
    if (error instanceof ComputerRefusal) return { cleared: false, reason: error.message, holder: error.extra.holder || null }
    log(`[computer] clearing the agent browser's data failed: ${error.message}`)
    return { cleared: false, reason: error.message }
  }
  log("[computer] the agent browser's cookies, site storage and cache were cleared by the person; its page is blank")
  return { cleared: true }
}

/** A surface as the thread's live view shows it: who holds it and who held it last (the run and its session), what
 *  the agent is doing and where its pointer went, and the page as it is now — also between two actions far apart (a
 *  model slow to answer outlasts the quiet lease: nobody holds the page then, and the run that held it last still
 *  wants it). No picture while the bridge has the page for a send of its own, nor one the page changed hands during
 *  (the bridge may take it while the picture is being taken): who the frame says held the page held it all along. */
async function liveFrame(computer, key, surface, tab = null) {
  const watching = () => computer.watch(key, tab) || { surface: key, ...(tab ? { tab_id: tab } : {}), holder: null, last: null, takes: 0, doing: null, pointer: null }
  const before = watching()
  const frame = before.holder !== BRIDGE_OWNER ? await surface.frame() : null
  const { takes, ...after } = watching()
  // a tab closed while its picture was being taken shows nothing (its id is never another page's)
  const gone = tab !== null && computer.watch(key, tab) === null
  const kept = frame !== null && !gone && takes === before.takes && after.holder !== BRIDGE_OWNER
  return { ...after, ...(kept ? frame : { image: null }) }
}

module.exports = { browserControls, clearBrowserData, COMPUTER_DOWNLOADS, FRAME_SHARE_MS, frameAsk, liveFrame, sharedFrames, BRIDGE_OWNER, harnessPortsOf, fileJournal, memoryJournal, JOURNAL_FILE, outgoingOf, LONG_TEXT_CHARS, sessionCookiePresent, rememberBridgeUrl, URL_FILE, chatGptPrefs, connectorOf, rememberChatGpt, rememberConnector, CONNECTOR_FILE, takeDownloads, CHATGPT_URL, DEFAULT_PORT, TOKEN_FILE, bridgePortOf, bridgeTokenOf, createBridge, serveBridge, electronPage, startBridge, viewPlaceOf }
