// Listening to the ChatGPT page as it works, through the view's own devtools protocol (the page is not changed and
// nothing is sent on its behalf): the answer stream of each message oasis-code sent (read live, so the reasoning,
// the tool calls and the words reach the session while they form) and the images the page loads for the answer
// (the files the answer made or shows, kept so the session can show them too), including the socket the page moves
// the answer to when it goes on in the background. Request headers are never read; each stream's body (tokens
// redacted), the conversation updates of its socket and the images the page loads are also written to
// <data dir>/logs/bridge-capture/ (the last few turns), the evidence when the web app changes.

const fs = require('node:fs')
const path = require('node:path')
const { ChatGptStream, bodyCarriesWords, connectorOfBody, isConversationImage, isConversationStream, imageNameOf, patchConversationBody } = require('./chatgpt_stream')
const { cdpOf } = require('./cdp')

const MAX_IMAGES = 8
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MIN_IMAGE_BYTES = 2048
const KEEP_TURNS = 10
const KEEP_CAPTURES = 20
// socket frames heard after the turn's request left but before its stream named the conversation
const MAX_EARLY_FRAMES = 200
const ARM_MS = 30_000
// a message request's body carried in its event up to this size (a larger one is asked for): a message's words go
// inline up to the bridge's LONG_TEXT_CHARS, beyond that as a file
const MAX_POST_DATA = 1024 * 1024
// a socket frame kept whole up to this size: the frame that ends an answer carries its words and its citations
// together (one of 2026-09-29 was over 20,000 characters, and its citations were cut from the evidence)
const MAX_FRAME_CAPTURE = 2 * 1024 * 1024
// the page's new-message requests, paused while oasis-code's message is on its way (and only then)
const MESSAGE_PATTERNS = [{ urlPattern: '*://chatgpt.com/backend-api/f/conversation', requestStage: 'Request' }, { urlPattern: '*://chatgpt.com/backend-api/conversation', requestStage: 'Request' }]

/** What the capture must not keep: tokens the stream carries (a resume token, anything shaped like a JWT). */
function redact(text) {
  return String(text).replace(/"(\w*token\w*)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted>"').replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+/g, '<redacted>')
}

/** Whether a stream's address belongs to the conversation: one that names another conversation does not (an address
 *  that names none, or a conversation not known yet, is not ruled out by it). */
function ofConversation(url, conversationId) {
  if (!conversationId) return true
  try {
    const named = /\/conversation\/([\w-]{8,})(\/|$)/.exec(new URL(url).pathname)
    return !named || named[1] === conversationId
  } catch { return false }
}

function isChatGpt(url) {
  try { return /(^|\.)chatgpt\.com$/.test(new URL(url).hostname) } catch { return false }
}

function tapPage(webContents, { log = () => {}, captureDir = null, onConnector = () => {} } = {}) {
  const turns = new Map()            // turn id -> { stream, images, seen, done_at, began }
  const requests = new Map()         // request id -> { kind: 'stream' | 'image', turn, url, mime, live, decoder }
  let active = null
  let armed = null                  // { turn, patch, timer }: oasis-code's next message goes with the model and the connector
  // the page's one debugger, shared with the computer driver (desktop/cdp.js)
  const cdp = cdpOf(webContents, { log })
  if (!cdp) return null
  if (!cdp.attach()) {
    log(`[bridge] the page cannot be listened to (${cdp.reason()}); answers are read from the page`)
    return null
  }
  const send = (method, params = {}) => cdp.send(method, params)
  // after a detach (the person opened the page's DevTools) the network is listened to again once the page is attached again
  const offAttach = cdp.onAttach(() => void send('Network.enable', { maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: 16 * 1024 * 1024, maxPostDataSize: MAX_POST_DATA }).catch((error) => log(`[bridge] Network.enable failed: ${error.message}`)))

  // the stream and the socket in one file (in the order they came, a replay of the turn); side notes (the images
  // the page loads) in another, so they never split an event of the stream
  const capture = (turnId, text, file = `${turnId}.txt`) => {
    if (!captureDir) return
    try {
      fs.mkdirSync(captureDir, { recursive: true })
      fs.appendFileSync(path.join(captureDir, file), redact(text))
    } catch { /* the capture is evidence only */ }
  }
  const prune = () => {
    while (turns.size > KEEP_TURNS) turns.delete(turns.keys().next().value)
    if (!captureDir) return
    try {
      const files = fs.readdirSync(captureDir).map((f) => ({ f, t: fs.statSync(path.join(captureDir, f)).mtimeMs })).sort((a, b) => b.t - a.t)
      for (const { f } of files.slice(KEEP_CAPTURES)) fs.rmSync(path.join(captureDir, f), { force: true })
    } catch { /* nothing to prune */ }
  }
  const frame = (turnId, payload) => {
    const turn = turns.get(turnId)
    const before = turn.stream.snapshot().done
    turn.stream.feedFrame(payload)
    if (!before && turn.stream.snapshot().done) turn.done_at = Date.now()
    capture(turnId, `\n### ws frame\n${payload.slice(0, MAX_FRAME_CAPTURE)}\n`)
  }
  const feed = (entry, text) => {
    if (!text) return
    const turn = turns.get(entry.turn)
    if (!turn) return
    const before = turn.stream.snapshot().done
    turn.stream.feed(text)
    capture(entry.turn, text)
    if (!before && turn.stream.snapshot().done) turn.done_at = Date.now()
    // the conversation known now: the frames that came before it are read (those of another conversation are not)
    if (turn.stream.conversationId !== null && turn.early.length) {
      const early = turn.early
      turn.early = []
      for (const payload of early) frame(entry.turn, payload)
    }
  }
  const bound = (turnId) => { const turn = turns.get(turnId); return !!turn && turn.request_id !== null }
  /** Whether a message request's body carries the turn's own words (a turn begun with none takes any). */
  const carriesTurnWords = (turnId, body) => {
    const turn = turns.get(turnId)
    return !turn || turn.words === null || bodyCarriesWords(body, turn.words)
  }
  /** A request bound to the turn whose body turned out not to carry its words: the person's, and nothing of it the
   *  turn's — the turn waits for its own again. */
  const unbind = (turnId, requestId) => {
    const turn = turns.get(turnId)
    requests.delete(requestId)
    if (!turn || turn.request_id !== requestId) return
    log(`[bridge] turn ${turnId}: a message request without its words left the page (the person's); still waiting for its own`)
    Object.assign(turn, { stream: new ChatGptStream(), images: [], seen: new Set(), done_at: null, posted_at: null, request_id: null, early: [], checking: false })
  }
  /** A request bound to the turn whose asked-for body carries its words: the turn's own, posted now. */
  const confirm = (turnId, requestId) => {
    const turn = turns.get(turnId)
    if (!turn || turn.request_id !== requestId) return
    turn.checking = false
    turn.posted_at = Date.now()
  }
  const decode = (entry, base64) => entry.decoder.decode(Buffer.from(base64, 'base64'), { stream: true })

  const disarm = () => {
    if (!armed) return
    clearTimeout(armed.timer)
    armed = null
    void send('Fetch.disable').catch(() => undefined)
  }

  const offMessages = cdp.on((method, params) => {
    try {
      // oasis-code's own message leaving the page: it goes as a hand-sent one with the model chosen and the connector
      // mentioned would; every paused request is let go, changed or not
      if (method === 'Fetch.requestPaused') {
        const { requestId, request } = params
        // only oasis-code's own message goes changed: one the person sends meanwhile goes as they sent it
        const job = armed && request.method === 'POST' && isConversationStream(request.url, request.method) && (!request.postData || carriesTurnWords(armed.turn, request.postData)) ? armed : null
        const patched = job && request.postData ? patchConversationBody(request.postData, job.patch) : null
        if (job) {
          // taken at once (the next message is the person's), the pausing stopped only once this one went on
          clearTimeout(job.timer)
          armed = null
          const what = [job.patch.model && `model ${job.patch.model}`, job.patch.appId && 'the connector'].filter(Boolean).join(' and ')
          log(patched ? `[bridge] turn ${job.turn} went with ${what}` : `[bridge] turn ${job.turn} went as the page sent it (${request.postData ? 'not a new message' : 'no body to change'})`)
        }
        // the request goes on first; only then does the pausing stop (stopping it first fails the request: seen
        // 2026-09-27, the page then sent the message again, unchanged)
        void send('Fetch.continueRequest', patched ? { requestId, postData: Buffer.from(patched).toString('base64') } : { requestId })
          .catch((error) => log(`[bridge] a paused request could not go on: ${error.message}`))
          .finally(() => { if (job && !armed) void send('Fetch.disable').catch(() => undefined) })
        return
      }
      if (method === 'Network.requestWillBeSent') {
        const { requestId, request } = params
        // a message the person sent on the page themselves: its body only (how the page encodes a mention or a model),
        // and the oasis-code connector learnt from it when they @-mentioned it (a large body is asked for)
        // a new message while oasis-code's turn already has its own is the person's too: the turn keeps its answer, and
        // what the page does from now on is theirs
        const mine = active ? turns.get(active) : null
        const newMessage = request.method === 'POST' && isConversationStream(request.url, request.method)
        if (mine && newMessage && mine.request_id !== null && !mine.checking) active = null
        // a new message while the turn waits for its own request is the turn's only when it carries the turn's words
        // (a body the event does not hold is asked for, the request bound meanwhile — not counted as posted — and let
        // go if it is not)
        let ours = active && newMessage ? (request.postData ? carriesTurnWords(active, request.postData) : request.hasPostData ? 'ask' : carriesTurnWords(active, '')) : null
        // while the bound request's body is asked for, only a request that shows the turn's words takes its place: the
        // one being checked is then the person's
        if (mine && mine.checking && active && newMessage) {
          if (ours === true && request.postData) unbind(active, mine.request_id)
          else ours = false
        }
        if ((!active || ours === false) && isConversationStream(request.url, request.method)) {
          const file = `manual-${new Date().toISOString().slice(0, 10)}.txt`
          const head = `\n### ${new Date().toISOString()} ${request.method} ${new URL(request.url).pathname}\n### body `
          const seen = (body) => {
            capture('manual', `${head}${String(body).slice(0, 16000)}\n`, file)
            let model = null
            try { const parsed = JSON.parse(body); model = typeof parsed.model === 'string' ? parsed.model : null } catch { /* not JSON */ }
            onConnector({ mention: connectorOfBody(body) || undefined, model: model || undefined })
          }
          if (request.postData) seen(request.postData)
          else if (request.hasPostData) void send('Network.getRequestPostData', { requestId }).then((r) => seen(r.postData), (error) => capture('manual', `${head}(not read: ${error.message})\n`, file))
          return
        }
        if (active && isConversationStream(request.url, request.method)) {
          const turn = turns.get(active)
          // the turn is its own message's request: the first new message after it began (the surest sign a send went —
          // the page's look changes, its requests do not), and a stream the page resumes for that conversation after it
          if (!turn) return
          if (newMessage) {
            turn.request_id = requestId
            if (ours === 'ask') {
              const turnId = active
              turn.checking = true
              void send('Network.getRequestPostData', { requestId }).then((r) => r.postData, () => '').then((body) => {
                if (carriesTurnWords(turnId, body)) confirm(turnId, requestId)
                else unbind(turnId, requestId)
              })
            } else turn.posted_at = Date.now()
          } else if (turn.request_id === null || !ofConversation(request.url, turn.stream.conversationId)) return
          requests.set(requestId, { kind: 'stream', turn: active, url: request.url, live: false, decoder: new TextDecoder() })
          turn.stream.last = { c: null, p: null, o: null }
          // the request's body (what the page sent: how a mention is encoded, say), headers never
          capture(active, `\n### ${request.method} ${new URL(request.url).pathname}\n${request.postData ? `### body ${String(request.postData).slice(0, 8000)}\n` : ''}`)
          if (!request.postData && request.hasPostData) void send('Network.getRequestPostData', { requestId }).then((r) => capture(active, `### body ${String(r.postData).slice(0, 8000)}\n`, `${active}.images.txt`), () => undefined)
        }
        return
      }
      if (method === 'Network.responseReceived') {
        const { requestId, response } = params
        let entry = requests.get(requestId)
        // an answer handed on to another stream (`stream_handoff` → a resumed event stream, seen 2026-09-27): any
        // event stream the page opens on chatgpt.com while the turn is on is the turn's
        if (!entry && active && bound(active) && /text\/event-stream/.test(String(response.mimeType || '')) && isChatGpt(response.url) && ofConversation(response.url, turns.get(active).stream.conversationId)) {
          entry = { kind: 'stream', turn: active, url: response.url, live: false, decoder: new TextDecoder() }
          requests.set(requestId, entry)
          capture(active, `\n### stream ${new URL(response.url).pathname}\n`)
        }
        if (entry && entry.kind === 'stream') {
          void send('Network.streamResourceContent', { requestId }).then((r) => {
            entry.live = true
            if (r && r.bufferedData) feed(entry, decode(entry, r.bufferedData))
          }, () => { entry.live = false })
          return
        }
        if (active && bound(active) && isConversationImage(response.url, response.mimeType)) requests.set(requestId, { kind: 'image', turn: active, url: response.url, mime: response.mimeType })
        // which images the page loads while an answer forms: the evidence when an answer's picture is not kept
        if (active && /^image\//.test(String(response.mimeType || ''))) {
          try { const u = new URL(response.url); capture(active, `### image ${u.protocol === 'blob:' || u.protocol === 'data:' ? u.protocol : u.hostname + u.pathname} ${response.mimeType} ${isConversationImage(response.url, response.mimeType) ? 'kept' : 'ignored'}\n`, `${active}.images.txt`) } catch { /* not a URL */ }
        }
        return
      }
      if (method === 'Network.dataReceived') {
        const entry = requests.get(params.requestId)
        if (entry && entry.kind === 'stream' && entry.live && params.data) feed(entry, decode(entry, params.data))
        return
      }
      // the page's socket: where the web app goes on with an answer in the background. A frame is the turn's only once
      // its own request told which conversation it is (a late frame of another conversation — an earlier answer
      // finishing — is not this turn's answer); frames that come before that wait for it
      if (method === 'Network.webSocketFrameReceived') {
        if (!active || !params.response || typeof params.response.payloadData !== 'string') return
        const payload = params.response.payloadData
        const turn = turns.get(active)
        if (!turn || turn.request_id === null) return
        if (turn.stream.conversationId === null) {
          if (turn.early.length < MAX_EARLY_FRAMES) turn.early.push(payload)
          return
        }
        frame(active, payload)
        return
      }
      if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        const entry = requests.get(params.requestId)
        if (!entry) return
        requests.delete(params.requestId)
        if (method === 'Network.loadingFailed') return
        if (entry.kind === 'stream' && !entry.live) {
          void send('Network.getResponseBody', { requestId: params.requestId }).then((r) => {
            feed(entry, r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body)
            feed(entry, '\n\n')
          }, (error) => log(`[bridge] the answer stream could not be read: ${error.message}`))
        } else if (entry.kind === 'stream') {
          feed(entry, entry.decoder.decode() + '\n\n')
        } else if (entry.kind === 'image') {
          void send('Network.getResponseBody', { requestId: params.requestId }).then((r) => {
            const turn = turns.get(entry.turn)
            if (!turn || turn.images.length >= MAX_IMAGES) return
            const bytes = r.base64Encoded ? Buffer.from(r.body, 'base64') : Buffer.from(r.body, 'binary')
            if (bytes.length < MIN_IMAGE_BYTES || bytes.length > MAX_IMAGE_BYTES) { capture(entry.turn, `### image not kept: ${bytes.length} bytes\n`, `${entry.turn}.images.txt`); return }
            const key = entry.url.split('?')[0]
            if (turn.seen.has(key)) return
            turn.seen.add(key)
            turn.images.push({ name: imageNameOf(entry.url, entry.mime), media_type: entry.mime, data_base64: bytes.toString('base64') })
          }, (error) => capture(entry.turn, `### image body not read: ${error.message}\n`, `${entry.turn}.images.txt`))
        }
      }
    } catch (error) {
      log(`[bridge] listening to the page failed on ${method}: ${error.message}`)
    }
  })
  const offDetach = cdp.onDetach((reason) => log(`[bridge] stopped listening to the page (${reason})`))

  return {
    /** A message is about to be sent for this turn (`words`: what it carries — its request is the one that carries
     *  them): what the page receives for it from now on is its answer. */
    begin(turnId, { words = null } = {}) {
      active = turnId
      turns.set(turnId, { stream: new ChatGptStream(), images: [], seen: new Set(), done_at: null, began: Date.now(), posted_at: null, request_id: null, early: [], checking: false, words: typeof words === 'string' && words.trim() ? words : null })
      prune()
    },
    /** The turn's message did not go (or was dropped): nothing the page does from now on is its. */
    end(turnId) {
      if (active === turnId) active = null
    },
    /** The next new message the page sends goes with this model and connector (`{ model, appId, markdown }`): the
     *  request is paused, changed and let go; nothing is paused once it went, or after half a minute. */
    arm(turnId, patch) {
      disarm()
      if (!patch || (!patch.model && !patch.appId)) return
      armed = { turn: turnId, patch, timer: setTimeout(() => { log(`[bridge] turn ${turnId}: no message left the page to go with the model and the connector`); disarm() }, ARM_MS) }
      void send('Fetch.enable', { patterns: MESSAGE_PATTERNS }).catch((error) => { log(`[bridge] the message cannot be sent with the model and the connector: ${error.message}`); disarm() })
    },
    /** Messages of the turn read back from the conversation, taken in as if heard. */
    absorb(turnId, messages) {
      const turn = turns.get(turnId)
      if (!turn) return
      const before = turn.stream.snapshot().done
      turn.stream.feedMessages(messages)
      if (!before && turn.stream.snapshot().done) turn.done_at = Date.now()
    },
    /** The turn's answer as heard so far (null when nothing of it was heard); `checking`: the request bound to it has
     *  its body asked for, and is no sign yet that the turn's message went. */
    heard(turnId) {
      const turn = turns.get(turnId)
      if (!turn) return null
      return { ...turn.stream.snapshot(), images: turn.images, done_at: turn.done_at, posted_at: turn.posted_at, checking: turn.checking, current: active === turnId }
    },
    /** The page is going away: nothing more is listened to, and its debugger is let go. */
    detach() { disarm(); offMessages(); offAttach(); offDetach(); cdp.close() },
  }
}

module.exports = { tapPage, redact }
