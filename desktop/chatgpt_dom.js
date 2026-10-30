// What the ChatGPT bridge window runs inside chatgpt.com, as scripts for webContents.executeJavaScript: read the
// page's state (signed in? generating? which conversation, which model), type a message into the composer and send
// it, read the latest assistant message as markdown. The selectors live here and nowhere else: the web app changes,
// and when it does this file is what to update. Nothing here is a documented interface of the product — it is the
// person's own signed-in browser doing what the person would do by hand — and none of it was verified against the
// live page by the build that wrote it (the desktop smoke exercises the bridge's HTTP side with a fake page).

const SELECTORS = {
  // the composer: a ProseMirror contenteditable today, a textarea in older builds
  composer: '#prompt-textarea, div[contenteditable="true"][data-id="root"], textarea[data-id="root"], form textarea',
  // looked for only in the composer's own form (its submit button first): the page holds other forms (its search)
  send: 'button[data-testid="send-button"], button[aria-label="Send prompt"]',
  // the stop button: its test id and English labels before the 2026-09-30 redesign; since, a button in the composer's
  // form labelled in the page's language ("停止", seen live). Exact labels only: the form holds other stop buttons
  // ("Stop dictation"); and only one the person can see counts (see __oasisStop)
  stop: 'button[data-testid="stop-button"], button[aria-label="Stop streaming" i], button[aria-label="Stop generating" i], form button[aria-label="Stop" i], form button[aria-label="停止"], form button[aria-label="停止生成"]',
  assistant: '[data-message-author-role="assistant"]',
  user: '[data-message-author-role="user"]',
  login: 'button[data-testid="login-button"], [data-testid="welcome-login-button"], a[href*="/auth/login"], button[data-testid="mobile-login-button"]',
  model: 'button[data-testid="model-switcher-dropdown-button"], [data-testid="model-switcher-dropdown-button"]',
}

/** The page's HTML-to-markdown walker, as source: the assistant's message as the person would paste it. */
const MARKDOWN_SOURCE = `
function __oasisMarkdown(root) {
  function text(node) { return node.textContent || '' }
  function walk(node, ctx) {
    if (node.nodeType === 3) return node.nodeValue.replace(/\\s+/g, ' ')
    if (node.nodeType !== 1) return ''
    const tag = node.tagName.toLowerCase()
    const kids = () => Array.from(node.childNodes).map((k) => walk(k, ctx)).join('')
    if (tag === 'pre') {
      const code = node.querySelector('code')
      const cls = code ? (code.className || '') : ''
      const lang = (cls.match(/language-([\\w+-]+)/) || [])[1] || ''
      return '\\n\\n\`\`\`' + lang + '\\n' + text(code || node).replace(/\\n$/, '') + '\\n\`\`\`\\n\\n'
    }
    if (tag === 'code') return '\`' + text(node) + '\`'
    if (/^h[1-6]$/.test(tag)) return '\\n\\n' + '#'.repeat(Number(tag[1])) + ' ' + kids().trim() + '\\n\\n'
    if (tag === 'p') return '\\n\\n' + kids().trim() + '\\n\\n'
    if (tag === 'br') return '\\n'
    if (tag === 'hr') return '\\n\\n---\\n\\n'
    if (tag === 'strong' || tag === 'b') return '**' + kids() + '**'
    if (tag === 'em' || tag === 'i') return '*' + kids() + '*'
    if (tag === 'a') { const href = node.getAttribute('href') || ''; const t = kids().trim(); return href && href !== t ? '[' + t + '](' + href + ')' : t }
    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(node.children).filter((c) => c.tagName.toLowerCase() === 'li')
      return '\\n\\n' + items.map((li, i) => (tag === 'ol' ? (i + 1) + '. ' : '- ') + walk(li, ctx).trim().replace(/\\n/g, '\\n  ')).join('\\n') + '\\n\\n'
    }
    if (tag === 'li') return kids()
    if (tag === 'blockquote') return '\\n\\n' + kids().trim().split('\\n').map((l) => '> ' + l).join('\\n') + '\\n\\n'
    if (tag === 'table') {
      const rows = Array.from(node.querySelectorAll('tr')).map((tr) => Array.from(tr.children).map((c) => text(c).trim().replace(/\\|/g, '\\\\|')))
      if (!rows.length) return ''
      const head = rows[0]
      return '\\n\\n| ' + head.join(' | ') + ' |\\n| ' + head.map(() => '---').join(' | ') + ' |\\n' + rows.slice(1).map((r) => '| ' + r.join(' | ') + ' |').join('\\n') + '\\n\\n'
    }
    if (tag === 'button' || tag === 'svg' || tag === 'style' || tag === 'script') return ''
    return kids()
  }
  return walk(root, {}).replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim()
}`

const q = (v) => JSON.stringify(v)

/** How long the page may take to upload a message's images (eight of 5 MB on a slow line). */
const ATTACH_TIMEOUT_MS = 120_000

/** Whether an element is on screen for the person: laid out, not hidden; and the composer — the known selectors
 *  first, else the first visible editable region or text box on the page (the web app renames its editor without
 *  notice); and, for the log when none is found, what editable things the page does hold. */
const VISIBLE_SOURCE = `function __oasisVisible(el) {
  if (!el) return false
  if (!el.getClientRects().length) return false
  const s = getComputedStyle(el)
  return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0
}
function __oasisComposer(S) {
  const known = Array.from(document.querySelectorAll(S.composer)).find(__oasisVisible)
  if (known) return known
  return Array.from(document.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"], textarea, [role="textbox"]')).find(__oasisVisible) || null
}
function __oasisStop(S) {
  return Array.from(document.querySelectorAll(S.stop)).find(__oasisVisible) || null
}
function __oasisEditables() {
  return Array.from(document.querySelectorAll('[contenteditable], textarea, [role="textbox"], input[type="text"]')).slice(0, 6).map((el) => ({
    tag: el.tagName.toLowerCase(), id: el.id || null, cls: (el.className && String(el.className).slice(0, 60)) || null,
    testid: el.getAttribute('data-testid'), editable: el.getAttribute('contenteditable'), placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('data-placeholder'),
    visible: __oasisVisible(el),
  }))
}`

/** Whether the page is signed in: its own session says so when it could be read (a signed-out page shows a composer
 *  too — anyone may chat — and its sign-in buttons carry no test id, so a page with a composer and no known login
 *  button read as signed in, seen 2026-09-30; a signed-in page whose composer this file no longer finds has changed,
 *  and is still signed in); the controls on screen only when the session could not be read. */
function signedIn({ session, composerVisible, visibleLogins }) {
  if (session === true) return true
  if (session === false) return false
  return composerVisible && visibleLogins === 0
}

/** The page's session read in the page (true / false; null when it could not be read), a signed-in answer kept for
 *  half a minute (the state is read every second while an answer forms); a signed-out one is read again each time,
 *  so a sign-in shows at once. */
const SESSION_SOURCE = `async function __oasisSession() {
  const kept = window.__oasisSignedIn
  if (kept && kept.signed === true && Date.now() - kept.at < 30000) return true
  let signed = null
  try {
    const res = await fetch('/api/auth/session', { credentials: 'include' })
    if (res.ok) signed = !!(((await res.json()) || {}).accessToken)
  } catch (e) { /* not readable now */ }
  window.__oasisSignedIn = { signed, at: Date.now() }
  return signed
}
${signedIn.toString()}`

/** The page as JSON: signed in (its session; a composer to type in), generating (a stop button), the conversation
 *  (its URL and title), the model the switcher shows, how many assistant messages the page holds and the last one's
 *  text. */
function stateScript() {
  return `(async () => {
    ${MARKDOWN_SOURCE}
    const S = ${q(SELECTORS)}
    ${VISIBLE_SOURCE}
    ${SESSION_SOURCE}
    const composer = __oasisComposer(S)
    // only a login control the person can see says "signed out": a signed-in page keeps hidden sign-in links around
    const logins = Array.from(document.querySelectorAll(S.login)).filter(__oasisVisible)
    const session = await __oasisSession()
    const stop = __oasisStop(S)
    const messages = document.querySelectorAll(S.assistant)
    const last = messages.length ? messages[messages.length - 1] : null
    const model = document.querySelector(S.model)
    // the person's side of the conversation: the newest message shown as sent, how the bridge sees its own one went
    const users = document.querySelectorAll(S.user)
    const lastUser = users.length ? users[users.length - 1] : null
    return JSON.stringify({
      ok: true, logged_in: signedIn({ session, composerVisible: __oasisVisible(composer), visibleLogins: logins.length }), generating: !!stop, url: location.href, title: document.title,
      why: { session, composer: composer ? (__oasisVisible(composer) ? 'visible' : 'hidden') : 'missing', login: logins.slice(0, 2).map((el) => el.outerHTML.slice(0, 160)),
        ...(composer ? {} : { editables: __oasisEditables(), title: document.title, ready: document.readyState }) },
      conversation: /\\/c\\//.test(location.pathname) ? { url: location.href, title: document.title } : null,
      model: model ? (model.textContent || '').trim() : null, assistant_count: messages.length,
      last_assistant_text: last ? __oasisMarkdown(last) : '',
      user_count: users.length, last_user_text: lastUser ? (lastUser.textContent || '').slice(0, 40000) : '',
    })
  })()`
}

/** A connector mention as ChatGPT copies it (`[$oasis-code](app://asdk_app_…)`): its markdown, the app's name and id. */
function mentionOf(markdown) {
  const m = /^\[\$?([^\]]{1,80})\]\(app:\/\/([\w-]{1,120})\)$/.exec(String(markdown || '').trim())
  return m ? { markdown: `[$${m[1]}](app://${m[2]})`, name: m[1], appId: m[2] } : null
}

/** Put the message's files into the composer's file input, as the person's file picker would — images into the image
 *  input, anything else (the words of a long message) into the one that takes any file — and wait until the page has
 *  uploaded each (its tile, named by the file, shows no progress bar). What the composer held already (an earlier
 *  message's leftovers, the person's own attachments) is taken away first: the message carries its own files only;
 *  with none, that is all it does. Returns JSON { ok, count } or { ok: false, reason: no_composer | no_file_input |
 *  attachments_left | upload_refused | upload_timeout, … }. */
function attachScript(images, timeoutMs = ATTACH_TIMEOUT_MS) {
  return `(async () => {
    const S = ${q(SELECTORS)}
    ${VISIBLE_SOURCE}
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const composer = __oasisComposer(S)
    if (!composer) return JSON.stringify({ ok: false, reason: 'no_composer', scene: { editables: __oasisEditables(), title: document.title, ready: document.readyState } })
    // a composer outside a form holds no attachments this file knows: nothing to take away, nowhere to put files
    const form = composer.closest('form')
    const images = ${q(images)}
    if (!form) return JSON.stringify(images.length ? { ok: false, reason: 'no_file_input' } : { ok: true, count: 0 })
    // a tile per attachment, named by its file (seen 2026-09-30): an image's is a div with role=button and its
    // progress bar inside; a file's (a text file) is a button, its progress bar and its remove button beside it. Both
    // bars and remove buttons carry the file's name in their label, in the page's language
    const tiles = () => Array.from(form.querySelectorAll('.composer-attachment-surface[aria-label]')).filter((el) => el.tagName === 'BUTTON' || el.getAttribute('role') === 'button')
    const named = (selector, name, tile) => Array.from(form.querySelectorAll(selector)).find((el) => el !== tile && (el.getAttribute('aria-label') || '').includes(name))
    for (const tile of tiles()) {
      const name = tile.getAttribute('aria-label')
      const remove = tile.querySelector('button') || named('button[aria-label]', name, tile)
      if (remove) remove.click()
    }
    for (let i = 0; i < 20 && tiles().length; i += 1) await sleep(100)
    if (tiles().length) return JSON.stringify({ ok: false, reason: 'attachments_left', count: tiles().length })
    if (!images.length) return JSON.stringify({ ok: true, count: 0 })
    const inputs = Array.from(form.querySelectorAll('input[type="file"]'))
    const onlyImages = images.every((image) => image.media_type.startsWith('image/'))
    const input = onlyImages
      ? inputs.find((el) => el.accept === 'image/*') || inputs.find((el) => el.accept.includes('image/')) || inputs.find((el) => !el.accept)
      : inputs.find((el) => !el.accept)
    if (!input) return JSON.stringify({ ok: false, reason: 'no_file_input' })
    const files = new DataTransfer()
    for (const image of images) {
      const raw = atob(image.data_base64)
      const bytes = new Uint8Array(raw.length)
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
      files.items.add(new File([bytes], image.name, { type: image.media_type }))
    }
    input.files = files.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    // the composer held nothing before: every tile now is one of these files — counted, not matched by name (the page
    // renames a file named as one it took before: message.txt becomes message(2).txt, seen 2026-09-30)
    let most = 0
    const deadline = Date.now() + ${q(timeoutMs)}
    while (Date.now() < deadline) {
      const shown = tiles().length
      most = Math.max(most, shown)
      // a tile that showed and went: the page refused a file (its size, its kind, a quota)
      if (shown < most) return JSON.stringify({ ok: false, reason: 'upload_refused', shown, of: images.length })
      if (shown >= images.length && !form.querySelector('[role="progressbar"]')) return JSON.stringify({ ok: true, count: shown })
      await sleep(250)
    }
    return JSON.stringify({ ok: false, reason: 'upload_timeout', shown: tiles().length, of: images.length })
  })()`
}

/** Put the words into the composer and send them. (The model and the connector go with the request itself: see
 *  patchConversationBody.) Returns JSON { accepted, reason }: needs_login when signed out, no_composer when signed in
 *  with no composer to be found (with `scene`, the page's editable things), generating while a stop button shows, no_send_button when no send button showed and Enter did not send — then with `scene`, what the page
 *  held (the editor, the buttons by the composer), for the app's log. */
function sendScript(text) {
  return `(async () => {
    const S = ${q(SELECTORS)}
    ${VISIBLE_SOURCE}
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    ${SESSION_SOURCE}
    let composer = __oasisComposer(S)
    const session = await __oasisSession()
    if (!signedIn({ session, composerVisible: __oasisVisible(composer), visibleLogins: Array.from(document.querySelectorAll(S.login)).filter(__oasisVisible).length })) return JSON.stringify({ accepted: false, reason: 'needs_login' })
    if (!composer || !__oasisVisible(composer)) return JSON.stringify({ accepted: false, reason: 'no_composer', scene: { editables: __oasisEditables(), title: document.title, ready: document.readyState } })
    if (__oasisStop(S)) return JSON.stringify({ accepted: false, reason: 'generating' })
    // a page just loaded shows its composer before the editor takes it over: words typed then sit in the page but not
    // in the editor, which shows no send button and ignores Enter (seen 2026-09-30)
    const isTextarea = (el) => el.tagName.toLowerCase() === 'textarea'
    const ready = (el) => isTextarea(el) || el.classList.contains('ProseMirror') || !!el.pmViewDesc
    for (let i = 0; i < 50 && !ready(composer); i += 1) {
      await sleep(100)
      composer = __oasisComposer(S) || composer
    }
    const editorReady = ready(composer)
    composer.focus()
    const words = ${q(text)}
    let pasted = null
    if (isTextarea(composer)) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(composer, words)
      composer.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      // the editor keeps line breaks as paragraphs: words are compared without white space (a break among the first
      // words read as a paste that did not land, and the words went in twice, seen 2026-09-27)
      const bare = (t) => String(t || '').replace(/\\s+/g, '')
      // emptied first, by the editor's own select-all and delete, and seen empty: the page keeps a draft across loads,
      // and a long one (shown folded) outlived a select-and-paste — it went as the message, seen 2026-09-30
      for (let i = 0; i < 5 && bare(composer.textContent); i += 1) {
        composer.focus()
        document.execCommand('selectAll', false)
        document.execCommand('delete', false)
        await sleep(60)
      }
      if (bare(composer.textContent)) return JSON.stringify({ accepted: false, reason: 'composer_not_cleared', scene: { words_in_composer: bare(composer.textContent).length } })
      // a contenteditable editor: the paste path keeps the editor's own state in step
      const selection = window.getSelection()
      selection.removeAllRanges()
      const range = document.createRange()
      range.selectNodeContents(composer)
      selection.addRange(range)
      const data = new DataTransfer()
      data.setData('text/plain', words)
      pasted = !composer.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      if (!pasted || !bare(composer.textContent).includes(bare(words).slice(0, 40))) {
        if (!document.execCommand('insertText', false, words)) { composer.textContent = words; composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: words })) }
      }
      // what goes is these words and nothing more (the editor may render markdown, so it can hold fewer characters,
      // never many more)
      const held = bare(composer.textContent)
      const want = bare(words)
      if (!held || held.length > want.length + 200 || !(held.includes(want.slice(0, 40)) || held.includes(want.slice(-40)))) {
        return JSON.stringify({ accepted: false, reason: 'composer_mismatch', scene: { composer_chars: held.length, words_chars: want.length } })
      }
    }
    // the send button: one the person can see and press, never one of a dialog (the page keeps hidden sheets whose
    // close buttons are submit buttons too), and only the composer's own — its form's submit button, the known
    // selectors, else a button named send (in the page's language) — never another form's (the page's search)
    const scope = () => composer.closest('form') || composer.parentElement?.parentElement?.parentElement || composer
    const pressable = (el) => __oasisVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.closest('dialog, [role="dialog"]')
    const sendButton = () => {
      const form = composer.closest('form')
      const named = Array.from(scope().querySelectorAll('button')).filter((el) => /send|发送|送信|전송|enviar|envoyer|senden/i.test(el.getAttribute('aria-label') || el.getAttribute('data-testid') || ''))
      const candidates = [...(form ? form.querySelectorAll('button[type="submit"]') : []), ...scope().querySelectorAll(S.send), ...named]
      return candidates.find(pressable) || null
    }
    for (let i = 0; i < 40; i += 1) {
      const send = sendButton()
      if (send) { send.click(); return JSON.stringify({ accepted: true }) }
      await sleep(100)
    }
    // no button found: Enter in the composer, as the person would; sent when the words leave the composer
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
    const leftOver = () => String(isTextarea(composer) ? composer.value : (composer.textContent || '')).replace(/\\s+/g, '')
    for (let i = 0; i < 20; i += 1) {
      await sleep(100)
      if (!leftOver().includes(words.replace(/\\s+/g, '').slice(0, 40))) return JSON.stringify({ accepted: true, via: 'enter' })
    }
    const scene = {
      editor_ready: editorReady, pasted, visibility: document.visibilityState, focused: document.hasFocus(),
      composer: composer.outerHTML.slice(0, 300), words_in_composer: leftOver().length,
      buttons: Array.from(scope().querySelectorAll('button')).slice(0, 12).map((el) => ({
        label: el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 30), type: el.type, disabled: el.disabled,
        visible: __oasisVisible(el), testid: el.getAttribute('data-testid'),
      })),
      dialogs: Array.from(document.querySelectorAll('dialog[open], [role="dialog"]')).filter(__oasisVisible).length,
    }
    return JSON.stringify({ accepted: false, reason: 'no_send_button', scene })
  })()`
}

/** The pictures of the answer as the page shows them, fetched by the page itself (its own session: the address the
 *  image already loads from). `want` names them: file ids (an image pointer's `file_…`) and sandbox pictures of the
 *  answer's words ({ alt, name } of `![alt](sandbox:/mnt/data/name)`), which the page shows once the answer is on
 *  screen — so the last answer is scrolled into view and the page is given up to `waitMs` to show them. Picked by
 *  file id in the address, then by the alt text, else the page's last blob / large images; each is
 *  { name, media_type, data_base64 } (a sandbox picture keeps its file name), at most `max`, none over 8 MB. */
function imagesScript(want, max = 8, waitMs = 0) {
  const spec = Array.isArray(want) ? { ids: want, pictures: [] } : { ids: (want && want.ids) || [], pictures: (want && want.pictures) || [] }
  return `(async () => {
    const ids = ${q(spec.ids)}
    const pictures = ${q(spec.pictures)}
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const answerish = (i) => /^blob:|estuary|oaiusercontent|interpreter/.test(i.src) || (i.naturalWidth || 0) >= 256
    const choose = () => {
      const all = Array.from(document.querySelectorAll('img')).filter((i) => i.src && !/\\/cdn\\/|favicon|avatar|auth0/i.test(i.src))
      const out = []
      for (const i of all) {
        const id = ids.find((x) => i.src.includes(x))
        const pic = pictures.find((p) => p.alt && (i.alt || '').trim() === p.alt.trim())
        if (id || pic) out.push({ img: i, name: pic ? pic.name : id })
      }
      if (out.length) return out
      // the page shows a generated picture from a blob it fetched itself (seen 2026-09-27), and may hold no turn
      // elements: the answer's pictures are then the last large or blob images of the page
      const turns = document.querySelectorAll('article, [data-testid^="conversation-turn-"]')
      const last = turns.length ? turns[turns.length - 1] : null
      const pool = (last ? Array.from(last.querySelectorAll('img')) : all).filter(answerish)
      return pool.slice(-Math.max(1, ids.length + pictures.length)).map((img, k) => ({ img, name: pictures[k] ? pictures[k].name : null }))
    }
    let picked = choose()
    for (let waited = 0; waited < ${Number(waitMs) || 0} && picked.filter((p) => p.img.complete && p.img.naturalWidth).length < ids.length + pictures.length; waited += 250) {
      const answers = document.querySelectorAll('[data-message-author-role="assistant"]')
      if (answers.length) answers[answers.length - 1].scrollIntoView({ block: 'end' })
      await sleep(250)
      picked = choose()
    }
    const out = []
    const seen = new Set()
    for (const { img, name } of picked) {
      if (out.length >= ${Number(max) || 8} || seen.has(img.src)) continue
      seen.add(img.src)
      try {
        const res = await fetch(img.src, { credentials: 'include' })
        if (!res.ok) continue
        const blob = await res.blob()
        if (!/^image\\//.test(blob.type) || blob.size > 8 * 1024 * 1024) continue
        const data = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(blob) })
        const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' })[blob.type] || 'png'
        out.push({ name: name && /\\.[a-z0-9]+$/i.test(name) ? name : (name || 'image-' + (out.length + 1)) + '.' + ext, media_type: blob.type, data_base64: data.slice(data.indexOf(',') + 1) })
      } catch (e) { /* not fetchable from the page */ }
    }
    return JSON.stringify(out)
  })()`
}

/** The answer's sandbox files as the page offers them — a download button, not a picture (seen 2026-09-27) — clicked
 *  the way the person would, so the page fetches each with its own session and hands it over as a download. Matched in
 *  the last answer (else the page) by the file name in the address, by the alt text or the file name in the label.
 *  Returns { clicked: [names], seen: [what the page offered instead, when nothing matched] }. */
function downloadScript(pictures) {
  return `(async () => {
    const pictures = ${q(pictures)}
    const answers = document.querySelectorAll('[data-message-author-role="assistant"]')
    const scope = answers.length ? answers[answers.length - 1] : document
    const controls = Array.from(scope.querySelectorAll('a, button, [role="button"]'))
    const label = (el) => ((el.getAttribute('href') || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).trim()
    const clicked = []
    for (const p of pictures) {
      const el = controls.find((c) => label(c).includes(p.name)) || controls.find((c) => p.alt && (c.textContent || '').trim() === p.alt.trim())
      if (!el) continue
      el.scrollIntoView({ block: 'center' })
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0 }))
      el.click()
      clicked.push(p.name)
      await new Promise((r) => setTimeout(r, 300))
    }
    const seen = clicked.length ? [] : controls.slice(-8).map((c) => [c.tagName.toLowerCase(), (c.getAttribute('href') || '').slice(0, 80), (c.textContent || '').trim().slice(0, 60)].filter(Boolean).join(' | '))
    return JSON.stringify({ clicked, seen })
  })()`
}

/** The pictures an answer's words show from ChatGPT's sandbox: `![alt](sandbox:/mnt/data/name)`. */
function sandboxPicturesOf(text) {
  const out = []
  for (const m of String(text || '').matchAll(/!\[([^\]]*)\]\((sandbox:[^)\s]+)\)/g)) {
    const name = m[2].replace(/^sandbox:/, '').split('/').filter(Boolean).pop()
    if (name && !out.some((p) => p.name === name)) out.push({ alt: m[1], name })
  }
  return out
}

/** The files an answer's words link to in ChatGPT's sandbox that are text — code, data, notes:
 *  `[label](sandbox:/mnt/data/name.py)`, never a picture's `![…](…)`. Each is { path, name } once. */
const TEXT_FILE = /\.(py|ipynb|js|mjs|cjs|ts|tsx|jsx|json|jsonl|md|markdown|txt|csv|tsv|ya?ml|toml|ini|cfg|conf|sh|bash|zsh|sql|html?|css|xml|svg|r|jl|java|c|h|cc|cpp|hpp|go|rs|rb|php|swift|kt|scala|m|tex|bib|log|diff|patch)$/i
function sandboxFilesOf(text) {
  const out = []
  for (const m of String(text || '').matchAll(/(!?)\[[^\]]*\]\(sandbox:([^)\s]+)\)/g)) {
    if (m[1]) continue
    const path = m[2].split(/[?#]/)[0]
    const name = path.split('/').filter(Boolean).pop()
    if (name && TEXT_FILE.test(name) && !out.some((f) => f.path === path)) out.push({ path, name })
  }
  return out
}

/** The page's own session, read in the page for its reads of the conversation; it never leaves the page. The read
 *  fails now and then when asked twice in a row (seen 2026-09-30): once more after a moment. */
const TOKEN_SOURCE = `async function __oasisToken() {
  for (let i = 0; i < 2; i += 1) {
    if (i) await new Promise((r) => setTimeout(r, 500))
    try { const token = ((await (await fetch('/api/auth/session', { credentials: 'include' })).json()) || {}).accessToken; if (token) return token } catch (e) { /* signed out, or a moment */ }
  }
  return null
}`

/** The turn's messages as the conversation holds them, read by the page as it reads them itself: from the message
 *  oasis-code sent (`after`) down the branch the conversation shows now. Returns JSON { messages } in the
 *  conversation's order, or { messages: [], why } — no_session, http_…, not_on_branch. */
function turnScript({ conversationId, after }) {
  return `(async () => {
    ${TOKEN_SOURCE}
    const token = await __oasisToken()
    if (!token) return JSON.stringify({ messages: [], why: 'no_session' })
    const res = await fetch('/backend-api/conversation/' + encodeURIComponent(${q(conversationId)}), { headers: { Authorization: 'Bearer ' + token }, credentials: 'include' })
    if (!res.ok) return JSON.stringify({ messages: [], why: 'http_' + res.status })
    const conversation = await res.json()
    const nodes = (conversation && conversation.mapping) || {}
    const after = ${q(after)}
    const path = []
    let found = false
    for (let id = conversation && conversation.current_node, hops = 0; id && nodes[id] && hops < 5000; id = nodes[id].parent, hops += 1) {
      if (id === after) { found = true; break }
      if (nodes[id].message) path.push(nodes[id].message)
    }
    return JSON.stringify(found ? { messages: path.reverse() } : { messages: [], why: 'not_on_branch' })
  })()`
}

/** The answer's sandbox files, fetched by the page itself as it does when the person clicks one: the conversation's
 *  interpreter hands out an address for the file (asked with the page's own session, which stays in the page), and the
 *  file is read as text — at most `maxChars` of it, none that is not text. Returns JSON { files: [{ path, name,
 *  media_type, text, chars, truncated }], missed: [{ path, why }] }. */
function filesScript({ conversationId, messageId, files, maxChars = 100_000 }) {
  return `(async () => {
    const conversationId = ${q(conversationId)}
    const messageId = ${q(messageId)}
    const want = ${q(files)}
    const out = { files: [], missed: [] }
    ${TOKEN_SOURCE}
    const token = await __oasisToken()
    if (!token) { out.missed = want.map((f) => ({ path: f.path, why: 'no_session' })); return JSON.stringify(out) }
    for (const f of want) {
      try {
        const asked = await fetch('/backend-api/conversation/' + encodeURIComponent(conversationId) + '/interpreter/download?message_id=' + encodeURIComponent(messageId) + '&sandbox_path=' + encodeURIComponent(f.path), { headers: { Authorization: 'Bearer ' + token }, credentials: 'include' })
        if (!asked.ok) { out.missed.push({ path: f.path, why: 'http_' + asked.status }); continue }
        const where = (await asked.json() || {}).download_url
        const url = where ? new URL(where, location.href) : null
        if (!url || url.protocol !== 'https:' || !/(^|\\.)(chatgpt\\.com|oaiusercontent\\.com)$/.test(url.hostname)) { out.missed.push({ path: f.path, why: 'no_address' }); continue }
        const res = await fetch(url.href, { credentials: url.origin === location.origin ? 'include' : 'omit' })
        if (!res.ok) { out.missed.push({ path: f.path, why: 'http_' + res.status }); continue }
        const text = await res.text()
        if (text.includes('\\u0000')) { out.missed.push({ path: f.path, why: 'not_text' }); continue }
        const max = ${Number(maxChars) || 100_000}
        out.files.push({ path: f.path, name: f.name, media_type: res.headers.get('content-type') || null, text: text.slice(0, max), chars: text.length, truncated: text.length > max })
      } catch (e) { out.missed.push({ path: f.path, why: String(e && e.message || e).slice(0, 120) }) }
    }
    return JSON.stringify(out)
  })()`
}

const FENCE_LANGUAGE = { py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx', md: 'markdown', markdown: 'markdown', sh: 'bash', zsh: 'bash', yml: 'yaml', htm: 'html', rs: 'rust', rb: 'ruby', kt: 'kotlin', jl: 'julia', ipynb: 'json', txt: '', log: '' }

/** The answer with each text file it links to shown under the block that links it (after the paragraph, the list
 *  item or the table — never inside one): its name and its text in a fence longer than any it holds, and, when only
 *  the start was kept, how much. A file the words do not link to follows the answer. */
function withAnswerFiles(text, files) {
  if (!files || !files.length) return text
  const lines = String(text).split('\n')
  const after = new Map()          // line index -> the blocks that go after it
  const tail = []
  const blockOf = (f) => {
    const ext = (f.name.split('.').pop() || '').toLowerCase()
    const language = FENCE_LANGUAGE[ext] ?? ext
    const longest = Math.max(0, ...(String(f.text).match(/`+/g) || []).map((run) => run.length))
    const fence = '`'.repeat(Math.max(3, longest + 1))
    const note = f.truncated ? `\n\n*The first ${f.text.length.toLocaleString('en-US')} of ${Number(f.chars).toLocaleString('en-US')} characters; the whole file is in the ChatGPT conversation.*` : ''
    return `**${f.name}**\n\n${fence}${language}\n${String(f.text).replace(/\n$/, '')}\n${fence}${note}`
  }
  for (const f of files) {
    const at = lines.findIndex((line) => line.includes(`](sandbox:${f.path})`))
    if (at < 0) { tail.push(blockOf(f)); continue }
    let end = at
    const table = /^\s*\|/.test(lines[at])
    while (end + 1 < lines.length && lines[end + 1].trim() !== '' && (!table || /^\s*\|/.test(lines[end + 1])) && !/^\s*(`{3,}|~{3,})/.test(lines[end + 1])) end += 1
    after.set(end, [...(after.get(end) || []), blockOf(f)])
  }
  const out = []
  lines.forEach((line, i) => {
    out.push(line)
    if (after.has(i)) out.push('', after.get(i).join('\n\n'), '')
  })
  let joined = out.join('\n').replace(/\n{3,}/g, '\n\n')
  if (tail.length) joined = `${joined.trimEnd()}\n\n${tail.join('\n\n')}`
  return joined
}

/** The latest assistant message: whether the page still generates, how many assistant messages there are, the last
 *  one as markdown, the conversation URL. */
function answerScript() {
  return `(() => {
    ${MARKDOWN_SOURCE}
    const S = ${q(SELECTORS)}
    ${VISIBLE_SOURCE}
    const messages = document.querySelectorAll(S.assistant)
    const last = messages.length ? messages[messages.length - 1] : null
    const stop = __oasisStop(S)
    // what the page's messages look like today, for the log when an answer does not come: the candidates' counts
    const count = (sel) => document.querySelectorAll(sel).length
    const roles = {}
    for (const el of document.querySelectorAll('[data-message-author-role]')) { const r = el.getAttribute('data-message-author-role'); roles[r] = (roles[r] || 0) + 1 }
    const turns = {}
    for (const el of document.querySelectorAll('[data-turn]')) { const r = el.getAttribute('data-turn'); turns[r] = (turns[r] || 0) + 1 }
    return JSON.stringify({
      generating: !!stop, count: messages.length, text: last ? __oasisMarkdown(last) : '', url: location.href,
      why: { roles, turns, articles: count('article'), conversation_turns: count('[data-testid^="conversation-turn"]'), markdown: count('.markdown'),
        stop: stop ? stop.outerHTML.slice(0, 160) : null },
    })
  })()`
}

/** Click the page's stop button (the one the person would click while an answer forms), and again while it stays:
 *  clicks in an answer's first seconds go unheeded (three clicks a second apart from the button's showing did not stop
 *  it; one 1.5 s in did, seen 2026-10-01). Returns JSON { clicked, stopped }: stopped once the button went away, within
 *  eight clicks a second apart. */
function stopScript() {
  return `(async () => {
    const S = ${q(SELECTORS)}
    ${VISIBLE_SOURCE}
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    if (!__oasisStop(S)) return JSON.stringify({ clicked: false })
    for (let i = 0; i < 8; i += 1) {
      const stop = __oasisStop(S)
      if (!stop) return JSON.stringify({ clicked: true, stopped: true })
      stop.click()
      await sleep(1000)
    }
    return JSON.stringify({ clicked: true, stopped: !__oasisStop(S) })
  })()`
}

/** A conversation of the person's ChatGPT as its address: `https://chatgpt.com/c/<id>` (or a GPT's conversation,
 *  `/g/<gizmo>/c/<id>`), the query and fragment left out; anything else is null. */
function conversationUrlOf(url) {
  let u
  try { u = new URL(String(url || '')) } catch { return null }
  if (u.protocol !== 'https:' || u.hostname !== 'chatgpt.com') return null
  const m = /^(\/g\/[\w-]{1,120})?\/c\/[\w-]{1,120}\/?$/.exec(u.pathname)
  return m ? `https://chatgpt.com${u.pathname.replace(/\/$/, '')}` : null
}

/** Whether a URL belongs to the sign-in and chat flow the bridge window may show (everything else opens outside). */
function allowedInBridge(url) {
  let u
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'https:') return false
  return /(^|\.)chatgpt\.com$|(^|\.)openai\.com$|(^|\.)auth0\.com$|(^|\.)accounts\.google\.com$|(^|\.)login\.microsoftonline\.com$|(^|\.)appleid\.apple\.com$/.test(u.hostname)
}

module.exports = { attachScript, ATTACH_TIMEOUT_MS, signedIn, conversationUrlOf, stopScript, downloadScript, imagesScript, sandboxPicturesOf, sandboxFilesOf, filesScript, turnScript, withAnswerFiles, mentionOf, SELECTORS, MARKDOWN_SOURCE, VISIBLE_SOURCE, stateScript, sendScript, answerScript, allowedInBridge }
