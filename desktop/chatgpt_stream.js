// The ChatGPT web app's answer stream, read as the page receives it, which carries the whole answer as it forms —
// the reasoning, the tool calls (a connector's tools, image generation, code) and the words. Three shapes are read:
// the conversation request's server-sent events, as whole messages per event (the older one) or as
// `delta_encoding: v1`, JSON-patch-like operations on one document per message (`c`), where an event that names no
// path or operation repeats the previous ones; and — once the answer goes on in the background (a reasoning model,
// seen 2026-09-27: the request's stream ends after the first thoughts) — the page's socket frames,
// `conversation-update` / `add-messages` with each message whole. A message's `channel` says what it is: `analysis`
// is reasoning, `final` the answer; the answer is complete with an assistant message that ends the turn
// (`end_turn: true`), or when the request's stream ended with every message finished (seen 2026-09-27: an answer that
// was only a generated picture). Anything else is ignored; the page itself stays the fallback.

function unescapePointer(seg) {
  return seg.replace(/~1/g, '/').replace(/~0/g, '~')
}

function applyOp(doc, path, op, value) {
  if (path === '' || path === undefined || path === null) {
    if (op === 'append' && typeof doc === 'string' && typeof value === 'string') return doc + value
    return op === 'remove' ? {} : clone(value)
  }
  const segs = String(path).split('/').slice(1).map(unescapePointer)
  const root = doc && typeof doc === 'object' ? doc : {}
  let parent = root
  for (let i = 0; i < segs.length - 1; i += 1) {
    const key = segs[i]
    if (parent[key] === undefined || parent[key] === null || typeof parent[key] !== 'object') parent[key] = /^\d+$/.test(segs[i + 1]) ? [] : {}
    parent = parent[key]
  }
  const last = segs[segs.length - 1]
  const current = parent[last]
  if (op === 'append') {
    if (typeof current === 'string' && typeof value === 'string') parent[last] = current + value
    else if (Array.isArray(current)) parent[last] = current.concat(Array.isArray(value) ? value : [value])
    else parent[last] = clone(value)
  } else if (op === 'truncate') {
    if (typeof current === 'string' || Array.isArray(current)) parent[last] = current.slice(0, Number(value) || 0)
  } else if (op === 'remove') {
    if (Array.isArray(parent)) parent.splice(Number(last), 1)
    else delete parent[last]
  } else {
    parent[last] = clone(value)
  }
  return root
}

function clone(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value
}

function partsText(content) {
  if (!content || typeof content !== 'object') return ''
  if (Array.isArray(content.parts)) return content.parts.filter((p) => typeof p === 'string').join('\n')
  if (typeof content.text === 'string') return content.text
  return ''
}

/** The answer's words with ChatGPT's citation markers made links. The page writes a citation as a private-use run —
 *  `\ue200cite\ue202turn945630view0\ue202…\ue201` (seen 2026-09-29) — and draws it from the message's
 *  `metadata.content_references` (the marker as `matched_text`, the pages as `items` with their `supporting_websites`,
 *  and `alt`, the markdown the page itself would copy). Each marker becomes its pages as markdown links
 *  (` ([arXiv](…), [arXiv](…))`), else its `alt`; a marker with no reference (one still streaming, one of a kind the
 *  page shows as something else) is left out rather than shown as the private characters it is. */
function citedText(words, metadata) {
  let text = String(words || '')
  const refs = metadata && Array.isArray(metadata.content_references) ? metadata.content_references : []
  for (const ref of refs) {
    const marker = ref && typeof ref.matched_text === 'string' ? ref.matched_text : ''
    if (!marker.includes('\ue200')) continue
    const pages = []
    for (const item of Array.isArray(ref.items) ? ref.items : []) {
      for (const page of [item, ...(Array.isArray(item && item.supporting_websites) ? item.supporting_websites : [])]) {
        if (page && typeof page.url === 'string' && /^https?:\/\//.test(page.url) && !pages.some((p) => p.url === page.url)) pages.push(page)
      }
    }
    const label = (page) => String(page.attribution || page.title || new URL(page.url).hostname).replace(/[[\]\n]/g, ' ').trim()
    const link = pages.length ? `(${pages.map((p) => `[${label(p)}](${p.url})`).join(', ')})` : typeof ref.alt === 'string' ? ref.alt.trim() : ''
    // a space before the marker is the link's own
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(new RegExp(` ?${escaped}`, 'g'), () => (link ? ` ${link}` : ''))
  }
  // what no reference names, and a marker still arriving at the end of the words
  return text.replace(/ ?\ue200[^\ue201]*\ue201/g, '').replace(/ ?\ue200[^\ue201]*$/, '')
}

const MAX_STEP = 400
const QUIET_MS = 60_000

class ChatGptStream {
  constructor() {
    this.buffer = ''
    this.docs = new Map()       // c (or a message id) -> the message document
    this.order = []
    this.last = { c: null, p: null, o: null }
    this.ended = false          // the request's stream ended (the answer may go on over the socket)
    this.conversationId = null
    this.events = 0
    this.seq = 0
    this.stamp = new Map()      // key -> when it was last put (a message seen twice is the later one)
    this.socketUpdates = 0      // messages heard on the socket: the answer went on in the background
    this.lastHeardAt = 0
    this.inputMessageId = null  // the message oasis-code sent, as the conversation names it
    this.readBack = new Map()   // id -> what a message read back from the conversation was last time
    this.topics = new Set()     // the socket topics this answer was handed on to (`stream_handoff`)
  }

  /** This turn's messages as the conversation holds them, read back when the streams went quiet: an answer the web
   *  app finished in the background (a Pro answer, `async_source`) reaches the page by its own reads of the
   *  conversation, which no stream carries — the turn's topic ended after two metadata frames (seen 2026-09-30).
   *  Each is taken in as a socket message is, in the conversation's order; one unchanged since the last read is not. */
  feedMessages(messages) {
    for (const m of Array.isArray(messages) ? messages : []) {
      if (!m || typeof m.id !== 'string' || !m.author) continue
      const was = `${m.status}|${JSON.stringify(m.content || null).length}|${m.end_turn}`
      if (this.readBack.get(m.id) === was) continue
      this.readBack.set(m.id, was)
      this.events += 1
      this.socketUpdates += 1
      this.put(`id:${m.id}`, { message: m })
    }
  }

  /** One socket frame of the page. The updates of this conversation (whole messages) are taken in; so is what a
   *  turn's own topic carries (an answer handed on to the socket, `stream_handoff` → `subscribe_ws_topic`, seen
   *  2026-09-27): wherever in the frame there is server-sent-event text, a delta, or a whole message, it is read as
   *  the request's stream would be. */
  feedFrame(payload) {
    let value
    try { value = JSON.parse(payload) } catch { return }
    const items = Array.isArray(value) ? value : [value]
    for (const raw of items) {
      const item = raw && raw.type === 'message' && raw.payload ? raw.payload : raw
      if (!item || item.type !== 'conversation-update' || !item.payload) {
        // a turn's topic: the one its own stream handed the answer on to — another topic is another answer's
        const topic = raw && typeof raw.topic_id === 'string' ? raw.topic_id : null
        if (topic === null || this.topics.has(topic)) this.carried(item, 0)
        continue
      }
      const update = item.payload
      if (this.conversationId && update.conversation_id && update.conversation_id !== this.conversationId) continue
      if (!this.conversationId && typeof update.conversation_id === 'string') this.conversationId = update.conversation_id
      if (update.update_type !== 'add-messages') continue
      const messages = update.update_content && Array.isArray(update.update_content.messages) ? update.update_content.messages : []
      for (const m of messages) if (m && typeof m.id === 'string') { this.events += 1; this.socketUpdates += 1; this.put(`id:${m.id}`, { message: m }) }
    }
  }

  /** Text as it arrives: complete events are read, a partial one waits for the rest. */
  feed(chunk) {
    this.buffer += chunk
    const blocks = this.buffer.split(/\r?\n\r?\n/)
    this.buffer = blocks.pop() ?? ''
    for (const block of blocks) this.block(block)
  }

  /** What a socket frame carries for a turn, found wherever it sits: event-stream text, a delta, a whole message. */
  carried(node, depth) {
    if (depth > 6 || node === null || node === undefined) return
    if (typeof node === 'string') {
      if (/(^|\n)(data|event):/.test(node)) { this.socketUpdates += 1; this.feed(node.endsWith('\n\n') ? node : `${node}\n\n`) }
      return
    }
    if (Array.isArray(node)) { for (const x of node) this.carried(x, depth + 1); return }
    if (typeof node !== 'object') return
    if (node.type === 'conversation-update') return
    if (node.conversation_id && this.conversationId && node.conversation_id !== this.conversationId) return
    if ('o' in node && 'v' in node || ('p' in node && 'v' in node)) { this.socketUpdates += 1; this.events += 1; this.delta(node); return }
    if (node.message && node.message.author && typeof node.message.id === 'string') { this.socketUpdates += 1; this.events += 1; this.put(`id:${node.message.id}`, { message: node.message }); return }
    for (const key of Object.keys(node)) if (key !== 'token') this.carried(node[key], depth + 1)
  }

  block(block) {
    let event = 'message'
    const data = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (!data.length) return
    this.events += 1
    this.handle(event, data.join('\n'))
  }

  handle(event, raw) {
    if (raw.trim() === '[DONE]') { this.ended = true; return }
    let v
    try { v = JSON.parse(raw) } catch { return }
    if (event === 'delta_encoding' || typeof v !== 'object' || v === null) return
    if (typeof v.conversation_id === 'string') this.conversationId = v.conversation_id
    if (v.type === 'message_stream_complete') { this.ended = true; return }
    if (v.type === 'stream_handoff' && Array.isArray(v.options)) {
      for (const o of v.options) if (o && typeof o.topic_id === 'string') this.topics.add(o.topic_id)
      return
    }
    if (v.type === 'input_message' && v.input_message && typeof v.input_message.id === 'string') { this.inputMessageId = v.input_message.id; return }
    if (typeof v.type === 'string' && !('v' in v) && !('o' in v)) return
    if (v.message && typeof v.message === 'object' && !('o' in v) && !('p' in v) && !('v' in v)) {
      const key = String(v.message.id ?? `m${this.order.length}`)
      this.put(key, { message: v.message, conversation_id: v.conversation_id })
      return
    }
    if (!('v' in v) && !('o' in v)) return
    this.delta(v)
  }

  delta(d) {
    const c = d.c !== undefined ? d.c : (this.last.c ?? 0)
    if (d.o === 'patch' && Array.isArray(d.v)) {
      for (const op of d.v) if (op && typeof op === 'object') this.op(c, op.p ?? '', op.o ?? 'append', op.v)
      this.last = { c, p: null, o: null }
      return
    }
    const p = d.p !== undefined ? d.p : this.last.p
    const o = d.o !== undefined ? d.o : (this.last.o ?? 'append')
    this.last = { c, p, o }
    this.op(c, p ?? '', o, d.v)
  }

  op(c, path, op, value) {
    const key = `c${c}`
    const doc = applyOp(this.docs.get(key), path, op, value)
    this.put(key, doc)
  }

  put(key, doc) {
    if (!this.docs.has(key)) this.order.push(key)
    this.docs.set(key, doc)
    this.seq += 1
    this.stamp.set(key, this.seq)
    this.lastHeardAt = Date.now()
    const conv = doc && typeof doc === 'object' ? doc.conversation_id : null
    if (typeof conv === 'string') this.conversationId = conv
  }

  /** The messages so far, in the order they were last heard of (the web app reuses a message's id — a first thought
   *  becomes a tool's result — so the order they began in is not the order they happened in); a message heard twice
   *  (the request's stream, then a socket frame) is the version heard last. */
  messages() {
    const byId = new Map()
    const order = []
    for (const key of this.order) {
      const d = this.docs.get(key)
      const m = (d && d.message) || (d && d.author ? d : null)
      if (!m) continue
      const id = typeof m.id === 'string' ? m.id : key
      const at = this.stamp.get(key) || 0
      const had = byId.get(id)
      if (!had) { order.push(id); byId.set(id, { m, at }) } else if (at >= had.at) byId.set(id, { m, at })
    }
    return order.map((id) => byId.get(id)).sort((x, y) => x.at - y.at).map((x) => x.m)
  }

  /** What the person should see: the reasoning, the steps (tool calls and what they returned), the words, the
   *  images the answer holds (their file pointers), and whether the answer is complete. */
  snapshot(now = Date.now()) {
    const thinking = []
    const steps = []
    const images = []
    let text = ''
    let finished = false
    let finalText = null
    let open = false
    let assistantMessageId = null
    for (const m of this.messages()) {
      if (m.status === 'in_progress') open = true
      const role = m.author && m.author.role
      const content = m.content || {}
      const type = content.content_type
      const recipient = m.recipient || 'all'
      const parts = Array.isArray(content.parts) ? content.parts : []
      for (const part of parts) {
        if (part && typeof part === 'object' && part.content_type === 'image_asset_pointer' && typeof part.asset_pointer === 'string' && !images.some((i) => i.pointer === part.asset_pointer)) {
          images.push({ pointer: part.asset_pointer, media_type: part.mime_type || null, width: part.width || null, height: part.height || null })
        }
      }
      if (type === 'thoughts' && Array.isArray(content.thoughts)) {
        for (const t of content.thoughts) if (t && typeof t.content === 'string' && t.content.trim()) thinking.push([t.summary, t.content].filter((x) => typeof x === 'string' && x.trim()).join('\n'))
        continue
      }
      if (type === 'reasoning_recap') { if (typeof content.content === 'string' && content.content) steps.push({ kind: 'recap', name: content.content, summary: '' }); continue }
      if (role === 'assistant' && recipient !== 'all') {
        steps.push({ kind: 'call', name: recipient, summary: partsText(content).slice(0, MAX_STEP) })
        continue
      }
      if (role === 'tool') {
        const name = (m.author && m.author.name) || 'tool'
        const shown = parts.some((p) => p && typeof p === 'object' && p.content_type === 'image_asset_pointer') ? 'an image' : partsText(content).slice(0, MAX_STEP)
        steps.push({ kind: 'result', name, summary: shown, status: m.status || null })
        continue
      }
      // reasoning (analysis) and the progress lines the page shows while it works (commentary, seen 2026-09-27: "一条路径里
      // Claude 已画好…") are not the answer: they go with the thinking
      if (role === 'assistant' && (m.channel === 'analysis' || m.channel === 'commentary')) {
        const words = partsText(content)
        if (words.trim()) thinking.push(words)
        continue
      }
      if (role === 'assistant' && (type === 'text' || type === 'multimodal_text')) {
        const words = citedText(partsText(content), m.metadata)
        // the answer is the final channel's words once there are any (older pages name no channel)
        if (m.channel === 'final') { if (words) { finalText = words; assistantMessageId = m.id || assistantMessageId } } else if (words) { text = words; assistantMessageId = m.id || assistantMessageId }
        if (m.status === 'finished_successfully' && m.end_turn === true) { finished = true; assistantMessageId = m.id || assistantMessageId }
      }
    }
    if (finalText !== null) text = finalText
    // complete: a message ended the turn; or the request's stream ended with every message finished and something to
    // show, when nothing went on over the socket (an answer that is only a tool's picture has no closing message); an
    // answer that went on over the socket ends with its closing message — or, should that never come, after a
    // minute with everything finished and nothing new
    const settled = this.ended && !open && (text.length > 0 || images.length > 0)
    const done = finished || (settled && this.socketUpdates === 0) || (settled && now - this.lastHeardAt > QUIET_MS)
    return { thinking: thinking.join('\n\n'), steps, text, pointers: images, done, last_at: this.lastHeardAt, conversation_id: this.conversationId, message_id: assistantMessageId, input_message_id: this.inputMessageId, events: this.events }
  }
}

/** Whether a request of the page is the answer stream (a new message, or a stream resumed). */
function isConversationStream(url, method) {
  try {
    const u = new URL(url)
    if (!/(^|\.)chatgpt\.com$/.test(u.hostname)) return false
    if (method === 'POST' && /^\/backend-api\/(f\/)?conversation\/?$/.test(u.pathname)) return true
    return method === 'GET' && /^\/backend-api\/(f\/)?conversation\/[^/]+\/stream\/?$/.test(u.pathname)
  } catch { return false }
}

/** Whether a response the page loads is an image of the conversation (a file the answer made or showed), not the
 *  app's own art. */
function isConversationImage(url, mimeType) {
  if (!/^image\//.test(String(mimeType || ''))) return false
  try {
    const u = new URL(url)
    if (/(^|\.)oaiusercontent\.com$/.test(u.hostname)) return true
    return /(^|\.)chatgpt\.com$/.test(u.hostname) && /^\/backend-api\/(estuary\/content|files\/)/.test(u.pathname)
  } catch { return false }
}

/** A name for an image the page loaded: the file name its signed address carries, else its file id. */
function imageNameOf(url, mimeType) {
  const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' })[String(mimeType)] || 'png'
  try {
    const u = new URL(url)
    const disposition = u.searchParams.get('rscd') || ''
    const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(decodeURIComponent(disposition))
    if (named) return named[1].split('/').pop()
    const id = u.searchParams.get('id') || u.pathname.split('/').filter(Boolean).pop() || 'image'
    return `${id.replace(/[^\w.-]/g, '').slice(0, 60) || 'image'}.${ext}`
  } catch { return `image.${ext}` }
}

/** The message oasis-code sends, as the page would have sent it had the person chosen the model and @-mentioned the
 *  connector (seen 2026-09-27 on a hand-sent message: `model: "gpt-6-pro"`; `system_hints: ["plugin:<app id>"]` on
 *  the request and on the message's metadata, with `serialization_metadata.render_format: "markdown"`; the words
 *  after `[$oasis-code](app://<app id>)`). Null when the body is not a new message (the page's other requests pass
 *  untouched). */
function patchConversationBody(raw, { model = null, appId = null, markdown = null } = {}) {
  let body
  try { body = JSON.parse(raw) } catch { return null }
  if (!body || typeof body !== 'object' || body.action !== 'next' || !Array.isArray(body.messages) || !body.messages.length) return null
  if (model) body.model = model
  if (appId) {
    const hint = `plugin:${appId}`
    const withHint = (list) => [...new Set([...(Array.isArray(list) ? list : []), hint])]
    body.system_hints = withHint(body.system_hints)
    const m = body.messages[body.messages.length - 1]
    const meta = m.metadata && typeof m.metadata === 'object' ? m.metadata : {}
    m.metadata = { ...meta, serialization_metadata: { ...(meta.serialization_metadata || {}), render_format: 'markdown' }, system_hints: withHint(meta.system_hints) }
    const parts = m.content && Array.isArray(m.content.parts) ? m.content.parts : null
    if (markdown && parts && typeof parts[0] === 'string' && !parts[0].includes(`](app://${appId})`)) parts[0] = `${markdown} ${parts[0]}`
  }
  return JSON.stringify(body)
}

/** The oasis-code connector as a message the person sent names it (they @-mentioned it on the page): the markdown
 *  the page writes, `[$<name>](app://<id>)`, with its id among the request's `plugin:` hints. Null when the message
 *  mentions no oasis connector. */
function connectorOfBody(raw) {
  let body
  try { body = JSON.parse(raw) } catch { return null }
  if (!body || !Array.isArray(body.messages)) return null
  const hints = new Set([...(Array.isArray(body.system_hints) ? body.system_hints : []), ...body.messages.flatMap((m) => (m && m.metadata && Array.isArray(m.metadata.system_hints) ? m.metadata.system_hints : []))])
  for (const m of body.messages) {
    const parts = m && m.content && Array.isArray(m.content.parts) ? m.content.parts : []
    for (const part of parts) {
      if (typeof part !== 'string') continue
      for (const hit of part.matchAll(/\[\$([^\]]{1,80})\]\(app:\/\/([\w-]{1,120})\)/g)) {
        if (/oasis/i.test(hit[1]) && hints.has(`plugin:${hit[2]}`)) return `[$${hit[1]}](app://${hit[2]})`
      }
    }
  }
  return null
}

/** Whether a text holds a message's words: white space run together, the words whole within it (the page may show a
 *  connector's mention or a file's tile beside them). Empty words are held by nothing. */
function holdsWords(text, words) {
  const want = String(words || '').replace(/\s+/g, ' ').trim()
  return want.length > 0 && String(text || '').replace(/\s+/g, ' ').includes(want)
}

/** Whether a new-message request's body carries these words (its last message's text parts): the page's own request
 *  for oasis-code's message, not one the person sent meanwhile. */
function bodyCarriesWords(raw, words) {
  let body
  try { body = JSON.parse(raw) } catch { return false }
  const messages = body && Array.isArray(body.messages) ? body.messages : []
  const last = messages[messages.length - 1]
  const parts = last && last.content && Array.isArray(last.content.parts) ? last.content.parts : []
  return holdsWords(parts.filter((p) => typeof p === 'string').join('\n'), words)
}

module.exports = { ChatGptStream, bodyCarriesWords, holdsWords, citedText, applyOp, connectorOfBody, isConversationStream, isConversationImage, imageNameOf, patchConversationBody }
