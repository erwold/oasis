// The computer's Electron side: a driver that looks at and acts on a page through its devtools protocol (the shared
// client of desktop/cdp.js — the ChatGPT tap listens on the same one), a surface adapter that keeps what the page did
// between two looks (navigated, was used by the person, opened a dialog or a file chooser, downloaded), and the agent's
// own browser: a view of its own persistent profile, hidden until the desk's Browser card shows it.
//
// Found on a real page (Electron 38, 2026-10-01): the protocol's screenshot draws a hidden view (capturePage does
// not), and its input reaches a hidden, unfocused page (sendInputEvent needs the window focused). `input-event` fires
// for the protocol's input as for the person's; the person's own input is told apart by its source — a key or wheel
// event the protocol sent carries Chromium's from-debugger flag, and a mouse event (Electron gives it no flags) is
// matched against the events the driver has in flight — never by when it comes. A page that has not drawn since it
// loaded (backstage, never screenshotted) does not route a press for seconds and then often drops it, and a press sent
// at once after the pointer moved went to the wrong frame over another site's iframe: the driver draws a frame and
// lets the pointer settle before it presses.
// With device emulation, Chromium's fromSurface screenshot temporarily changes the view and restores its old
// size afterwards, overwriting a card resize in flight. A concurrent clipped warm-up can also turn a full picture
// into one solid colour (Electron 38.8.6, 2026-10-16). Every capture therefore uses fromSurface:false without a clip:
// it reads the fixed 1280 × 800 browser view, keeps its 2x pixels, and leaves its size alone. Agent pictures are resized here.
// The agent's browser draws at two device pixels per CSS pixel whatever screen the app is on (2026-10-16, Electron
// 38.8.6): a device scale set on its own debugger session (Emulation.setDeviceMetricsOverride, size left to the
// view) — never the app's switch, so the ChatGPT page and the app keep their screen's. It holds across navigations
// to other sites and a page process that was replaced, and goes with the session: it is set again on every attach.
// The page lays out at its CSS size as before; DOMSnapshot's boxes are then not in `devicePixelRatio` (which says 2)
// but in the device pixels of the view (layoutViewport over cssLayoutViewport), which is the ratio used for them.

const fs = require('node:fs')
const path = require('node:path')
const { cdpOf } = require('./cdp')

const BROWSER_PARTITION = 'persist:oasis-code-browser'
const BROWSER_HOME = 'about:blank'
const HIDDEN_BOUNDS = { x: 0, y: 0, width: 1280, height: 800 }
const STAGE_SIZE = { width: 1920, height: 1200 }
// the longest side of a screenshot the agent gets (a larger viewport is scaled down; coordinates follow the picture)
const SHOT_MAX_SIDE = 1280
const SHOT_QUALITY = 70
// the picture as the page gives it, before it is made smaller
const RAW_QUALITY = 90
// the picture a person watching gets (the thread's live view): smaller and lighter than an agent's look, and given up
// on quickly — the next one is a moment away
// the live view a person watches is shown at the screen's pixels (a Retina screen draws two per CSS pixel): its
// picture keeps the page's own pixels, up to this side
const FRAME_MAX_SIDE = 1920
const FRAME_QUALITY = 70
// the agent's browser draws two device pixels per CSS pixel (see the head of this file): its live picture keeps them
// all — the fixed 1280 × 800 page is 2560 × 1600 regardless of the card — taken by the page at this quality,
// sent as it comes (no second encoding) up to this side; an agent's look is still made CSS-sized from it
// (SHOT_MAX_SIDE, SHOT_QUALITY)
const BROWSER_DEVICE_SCALE = 2
const SHARP_FRAME_MAX_SIDE = HIDDEN_BOUNDS.width * BROWSER_DEVICE_SCALE
const SHARP_FRAME_QUALITY = 80
// A stored picture for the thread: bounded independently from the agent's coordinate-bearing picture.
const DISPLAY_MAX_BYTES = 4 * 1024 * 1024
// a picture's sizes are logged when they change, at most this often
const PICTURE_LOG_MS = 10_000
const FRAME_TIMEOUT_MS = 3_000
const LOAD_WAIT_MS = 15_000
const SETTLE_MS = 350
// the person's input: what counts (a mouse passing over the card does not)
const PERSON_INPUT = new Set(['mouseDown', 'rawKeyDown', 'keyDown', 'char', 'mouseWheel', 'touchStart'])
// Chromium's mark on input the devtools protocol dispatched (WebInputEvent::kFromDebugger), in `_modifiers`
const FROM_DEBUGGER = 1 << 23
// how long after its dispatch answered an event the driver sent may still be heard as the driver's
const OWN_GRACE_MS = 200
// how long the pointer rests at its point before a press (the browser routes the press by where the pointer is)
const POINTER_SETTLE_MS = 100
// how long after the agent's press a file chooser it opened may still come (a page may open it a moment later)
const CHOOSER_TAIL_MS = 150
// a download an agent's page makes is taken up to this size, into the computer's downloads folder
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024
// a download that has not grown in this long is given up
const DOWNLOAD_STALL_MS = 60_000
const DOWNLOAD_CHECK_MS = 5_000
// a download that begins this soon after the person used a page no run holds is theirs
const PERSON_DOWNLOAD_MS = 60_000
const KEEP_CONSOLE = 20
const CONSOLE_CHARS = 300
// the harness's own sign-in cookie (backend-ts/src/api/auth.ts): never sent from the agent's browser
const SESSION_COOKIE = 'oasis_code_session'

// an element as a person would name it: tag, id, classes, its label or words (never a field's value)
const DESCRIBE = `(el) => {
  if (!el || el.nodeType !== 1) return 'nothing'
  const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''
  const field = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
  const words = String(el.getAttribute('aria-label') || (field ? el.getAttribute('placeholder') || el.getAttribute('name') || '' : el.innerText || '')).trim().replace(/\\s+/g, ' ').slice(0, 40)
  return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls + (words ? ' "' + words + '"' : '')
}`
// whether an element is `a` or inside it, across shadow roots
const WITHIN = `(a, el) => { for (let n = el; n; n = n.parentNode || n.host) if (n === a) return true; return false }`
// whether what the page's hit test found (of the element's own document) is the element, something in it, or its
// label — else a short description of what is there instead. (A node of another document is another script context's:
// it is never passed in; the frames are compared by node id instead.)
const HIT_FN = `function (hit) {
  const describe = ${DESCRIBE}
  const within = ${WITHIN}
  const el = hit && (hit.nodeType === 1 ? hit : hit.parentElement)
  if (!el) return { ok: true }
  if (within(this, el)) return { ok: true }
  if (el.tagName === 'LABEL' && el.control === this) return { ok: true }
  // what covers it is pinned to the view (a fixed or sticky header, a bar): scrolling the element clears it
  let pinned = false
  for (let n = el; n && n.nodeType === 1 && !pinned; n = n.parentElement) pinned = ['fixed', 'sticky'].includes(getComputedStyle(n).position)
  return { ok: false, covering: describe(el), pinned }
}`
const DESCRIBE_FN = `function () { return (${DESCRIBE})(this.nodeType === 1 ? this : this.parentElement) }`
const DOCUMENT_FN = 'function () { return this.nodeType === 9 ? this : this.ownerDocument }'
// the frame element a node's document is shown in (null at the top, or for a frame of another site)
const FRAME_OF_FN = 'function () { const d = this.nodeType === 9 ? this : this.ownerDocument; try { return (d.defaultView && d.defaultView.frameElement) || null } catch { return null } }'
// whether an element takes input now: a disabled control (itself, or in a disabled fieldset), aria-disabled, or a
// field that is read-only does not
const STATE_FN = `function () {
  const describe = ${DESCRIBE}
  const el = this.nodeType === 1 ? this : this.parentElement
  if (!el) return { disabled: false, readonly: false, desc: 'nothing' }
  const control = el.closest('button, input, select, textarea, option, optgroup, fieldset')
  const disabled = !!(control && control.matches(':disabled')) || !!el.closest('[aria-disabled="true"]')
  const readonly = (el.matches('input, textarea') && el.readOnly) || el.getAttribute('aria-readonly') === 'true'
  return { disabled, readonly, desc: describe(el) }
}`
// what is at a point (the hit element is \`this\`): whether it is disabled or read-only, whether it is another site's frame
const AT_FN = `function () {
  const describe = ${DESCRIBE}
  const el = this.nodeType === 1 ? this : this.parentElement
  if (!el) return { disabled: false, desc: 'nothing', other_site: false }
  const control = el.closest('button, input, select, textarea, option, optgroup, fieldset')
  const disabled = !!(control && control.matches(':disabled')) || !!el.closest('[aria-disabled="true"]')
  const readonly = (el.matches('input, textarea') && el.readOnly) || el.getAttribute('aria-readonly') === 'true'
  let other = false
  if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') { try { other = !el.contentDocument } catch { other = true } }
  return { disabled, readonly, desc: describe(el), other_site: other }
}`
// the control a point lands on (a link, a button, a field, an element with a control's role), or null
const CONTROL_FN = `function () {
  const sel = 'a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=option], [contenteditable=""], [contenteditable=true]'
  for (let n = this.nodeType === 1 ? this : this.parentElement; n; n = n.parentNode || n.host) if (n.nodeType === 1 && n.matches(sel)) return n
  return null
}`
// the focused element, followed into shadow roots and same-site frames
const ACTIVE_OF = `(doc) => {
  let a = doc.activeElement
  for (;;) {
    if (a && a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue }
    if (a && (a.tagName === 'IFRAME' || a.tagName === 'FRAME')) { let d = null; try { d = a.contentDocument } catch {} if (d && d.activeElement) { a = d.activeElement; continue } }
    return a
  }
}`
const HOLDS_FOCUS_FN = `function () {
  const within = ${WITHIN}
  const a = (${ACTIVE_OF})(this.ownerDocument)
  return !!a && (within(this, a) || within(a, this))
}`
// what a field holds (a text field, a textarea, an editable region); null for anything else
const VALUE_FN = `function () {
  if (this.matches && this.matches('input, textarea')) return { value: String(this.value), secret: this.type === 'password' }
  if (this.isContentEditable) return { value: this.innerText, secret: false }
  return { value: null, secret: false }
}`
// the caret at the end of the field's text (a click in the middle of the text left it there)
const END_FN = `function () {
  if (this.matches('input, textarea')) { try { const n = this.value.length; this.setSelectionRange(n, n) } catch {} return }
  if (this.isContentEditable) { const r = this.ownerDocument.createRange(); r.selectNodeContents(this); r.collapse(false); const s = this.ownerDocument.getSelection(); s.removeAllRanges(); s.addRange(r) }
}`
// a select's option chosen as a person would: the option selected, then input and change (a framework that watches
// the element's value setter still hears it)
const SELECT_FN = `function (choice) {
  if (this.tagName !== 'SELECT') return { ok: false, reason: 'not a select element: click it to open it, then click the option' }
  if (this.matches(':disabled') || this.closest('[aria-disabled="true"]')) return { ok: false, disabled: true, reason: 'the select is disabled' }
  const options = [...this.options]
  const lower = String(choice).trim().toLowerCase()
  const option = options.find((o) => o.value === choice) || options.find((o) => o.label.trim().toLowerCase() === lower) || options.find((o) => o.label.toLowerCase().includes(lower))
  if (!option) return { ok: false, reason: 'no option "' + choice + '" (the options: ' + options.slice(0, 30).map((o) => o.label.trim()).join(', ') + ')' }
  if (option.disabled || option.matches(':disabled')) return { ok: false, reason: 'the option "' + option.label.trim() + '" is disabled' }
  option.selected = true
  this.dispatchEvent(new Event('input', { bubbles: true }))
  this.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, label: option.label.trim() }
}`
const MODIFIERS = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 }
const NAMED_KEYS = {
  enter: ['Enter', 'Enter', 13, '\r'], return: ['Enter', 'Enter', 13, '\r'], tab: ['Tab', 'Tab', 9], escape: ['Escape', 'Escape', 27], esc: ['Escape', 'Escape', 27],
  backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46], space: [' ', 'Space', 32, ' '],
  arrowup: ['ArrowUp', 'ArrowUp', 38], arrowdown: ['ArrowDown', 'ArrowDown', 40], arrowleft: ['ArrowLeft', 'ArrowLeft', 37], arrowright: ['ArrowRight', 'ArrowRight', 39],
  up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39],
  home: ['Home', 'Home', 36], end: ['End', 'End', 35], pageup: ['PageUp', 'PageUp', 33], pagedown: ['PageDown', 'PageDown', 34],
}
for (let n = 1; n <= 12; n += 1) NAMED_KEYS[`f${n}`] = [`F${n}`, `F${n}`, 111 + n]
// the editing commands macOS gives a shortcut (a page's own handlers see the key; the text field needs the command)
const MAC_COMMANDS = { 'meta+a': 'selectAll', 'meta+c': 'copy', 'meta+x': 'cut', 'meta+v': 'paste', 'meta+z': 'undo', 'meta+shift+z': 'redo' }

/** A key combination (`Enter`, `Meta+A`, `Shift+Tab`, `a`) as the protocol's key events: its modifiers and its key. */
function keyOf(combo, platform = process.platform) {
  const parts = String(combo).split('+').map((p) => p.trim()).filter(Boolean)
  if (!parts.length) throw new Error('no key')
  let modifiers = 0
  const mods = []
  for (const part of parts.slice(0, -1)) {
    const bit = MODIFIERS[part.toLowerCase()]
    if (bit === undefined) throw new Error(`unknown modifier ${part}`)
    modifiers |= bit
    mods.push(bit === 4 ? 'meta' : bit === 2 ? 'ctrl' : bit === 1 ? 'alt' : 'shift')
  }
  const last = parts[parts.length - 1]
  const named = NAMED_KEYS[last.toLowerCase()]
  let key
  let code
  let vk
  let text
  if (named) [key, code, vk, text] = named
  else if (/^[a-z]$/i.test(last)) { key = (modifiers & 8) ? last.toUpperCase() : last.toLowerCase(); code = `Key${last.toUpperCase()}`; vk = last.toUpperCase().charCodeAt(0); text = key }
  else if (/^[0-9]$/.test(last)) { key = last; code = `Digit${last}`; vk = last.charCodeAt(0); text = last }
  else if (last.length === 1) { key = last; code = ''; vk = 0; text = last }
  else throw new Error(`unknown key ${last}`)
  // a shortcut types nothing
  if (modifiers & (1 | 2 | 4)) text = undefined
  const id = [...new Set(mods)].sort((a, b) => ['meta', 'ctrl', 'alt', 'shift'].indexOf(a) - ['meta', 'ctrl', 'alt', 'shift'].indexOf(b)).concat(last.toLowerCase()).join('+')
  const command = platform === 'darwin' ? MAC_COMMANDS[id] : undefined
  return { key, code, windowsVirtualKeyCode: vk, modifiers, text, commands: command ? [command] : undefined }
}

/** An event from the Browser card's scaled picture, already mapped to the fixed CSS viewport. Only this small
 *  input vocabulary crosses the app IPC; arbitrary protocol methods, coordinates outside the image and malformed
 *  keys are refused. Keyboard text is delivered separately (including IME and paste), so keyDown never types twice. */
function browserInputCommand(raw, platform = process.platform) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.page !== undefined && (typeof raw.page !== 'string' || raw.page.length > 100)) return null
  const names = raw.modifiers === undefined ? [] : raw.modifiers
  if (!Array.isArray(names) || names.length > 8 || names.some((name) => typeof name !== 'string' || MODIFIERS[name.toLowerCase()] === undefined)) return null
  const modifiers = names.reduce((bits, name) => bits | MODIFIERS[name.toLowerCase()], 0)
  if (['mouseMove', 'mouseDown', 'mouseUp', 'mouseWheel'].includes(raw.type)) {
    if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y) || raw.x < 0 || raw.y < 0 || raw.x >= HIDDEN_BOUNDS.width || raw.y >= HIDDEN_BOUNDS.height) return null
    const type = { mouseMove: 'mouseMoved', mouseDown: 'mousePressed', mouseUp: 'mouseReleased', mouseWheel: 'mouseWheel' }[raw.type]
    const button = raw.button ?? (raw.type === 'mouseDown' || raw.type === 'mouseUp' ? 'left' : 'none')
    if (!['none', 'left', 'middle', 'right'].includes(button) || ((raw.type === 'mouseDown' || raw.type === 'mouseUp') && button === 'none')) return null
    if (raw.buttons !== undefined && (!Number.isInteger(raw.buttons) || raw.buttons < 0 || raw.buttons > 7)) return null
    const params = { type, x: raw.x, y: raw.y, button, modifiers }
    if (raw.buttons !== undefined) params.buttons = raw.buttons
    if (raw.type === 'mouseDown' || raw.type === 'mouseUp') {
      const count = raw.clickCount ?? 1
      if (!Number.isInteger(count) || count < 1 || count > 3) return null
      params.clickCount = count
    }
    if (raw.type === 'mouseWheel') {
      if (!Number.isFinite(raw.deltaX) || !Number.isFinite(raw.deltaY) || Math.abs(raw.deltaX) > 10000 || Math.abs(raw.deltaY) > 10000) return null
      params.deltaX = raw.deltaX; params.deltaY = raw.deltaY
    }
    return { method: 'Input.dispatchMouseEvent', params }
  }
  if (raw.type === 'text') {
    if (typeof raw.text !== 'string' || raw.text.length < 1 || raw.text.length > 65536) return null
    return { method: 'Input.insertText', params: { text: raw.text } }
  }
  if (raw.type === 'keyDown' || raw.type === 'keyUp') {
    if (typeof raw.keyCode !== 'string' || raw.keyCode.length < 1 || raw.keyCode.length > 40) return null
    if (raw.code !== undefined && (typeof raw.code !== 'string' || raw.code.length > 40)) return null
    if (raw.location !== undefined && ![0, 1, 2, 3].includes(raw.location)) return null
    let k = { key: raw.keyCode, code: raw.code || '', windowsVirtualKeyCode: 0 }
    // Modifier keys and '+' are valid DOM keys too; keyOf handles named navigation/editing keys and shortcuts.
    try { k = keyOf([...names, raw.keyCode === ' ' ? 'Space' : raw.keyCode].join('+'), platform) } catch { /* DOM key */ }
    k.key = raw.keyCode
    const params = { type: raw.type === 'keyUp' ? 'keyUp' : 'rawKeyDown', key: k.key, code: raw.code || k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, nativeVirtualKeyCode: k.windowsVirtualKeyCode, modifiers }
    if (raw.location !== undefined) params.location = raw.location
    if (raw.isAutoRepeat === true) params.autoRepeat = true
    if (raw.type === 'keyDown' && k.commands) params.commands = k.commands
    if (raw.type === 'keyDown' && raw.keyCode === 'Enter' && !(modifiers & 7)) { params.type = 'keyDown'; params.text = '\r'; params.unmodifiedText = '\r' }
    return { method: 'Input.dispatchKeyEvent', params }
  }
  return null
}

/** The width and height of a JPEG (its frame header), or null. */
function jpegSize(bytes) {
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null
    const marker = bytes[i + 1]
    if (marker === 0xff) { i += 1; continue }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue }
    const length = (bytes[i + 2] << 8) | bytes[i + 3]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: (bytes[i + 7] << 8) | bytes[i + 8], height: (bytes[i + 5] << 8) | bytes[i + 6] }
    i += 2 + length
  }
  return null
}

/** The input events the page reports (`input-event`) for what the protocol dispatched. */
function heardAs(method, params) {
  if (method === 'Input.dispatchMouseEvent') return { mousePressed: ['mouseDown'], mouseReleased: ['mouseUp'], mouseWheel: ['mouseWheel'] }[params.type] || []
  if (method === 'Input.dispatchKeyEvent') return { keyDown: ['keyDown', 'char'], rawKeyDown: ['rawKeyDown'], char: ['char'], keyUp: ['keyUp'] }[params.type] || []
  return []
}

/** Which input the agent's driver sent: an event with flags says so itself; one without (a mouse event) is the
 *  driver's when the driver has one of its kind in flight. */
function ownInput({ now = () => Date.now() } = {}) {
  const pending = []
  return {
    /** The driver is about to send events heard as `types`; the returned function says the dispatch answered. */
    expect(types) {
      const entries = types.map((type) => ({ type, until: Infinity }))
      pending.push(...entries)
      return () => { const until = now() + OWN_GRACE_MS; for (const e of entries) e.until = until }
    },
    /** Whether an input event the page reported is the driver's (an expected one is used up). */
    heard(input) {
      const t = now()
      for (let i = pending.length - 1; i >= 0; i -= 1) if (pending[i].until < t) pending.splice(i, 1)
      const i = pending.findIndex((e) => e.type === input.type)
      if (i >= 0) pending.splice(i, 1)
      if (typeof input._modifiers === 'number') return (input._modifiers & FROM_DEBUGGER) !== 0
      return i >= 0
    },
  }
}

const withTimeout = (promise, ms) => {
  let timer = null
  return Promise.race([promise, new Promise((_r, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms) })]).finally(() => clearTimeout(timer))
}

/** The driver over one page (a webContents): each call goes through the page's shared protocol client. */
function cdpDriver(webContents, { log = () => {}, platform = process.platform, own = null, nativeImage = null, label = 'a page' } = {}) {
  const send = (method, params, timeoutMs) => {
    const cdp = cdpOf(webContents, { log })
    if (!cdp) return Promise.reject(new Error('the page has no debugger'))
    return cdp.send(method, params, timeoutMs)
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // what a kind of picture is (CSS viewport, what the page drew — its JPEG's own header —, what was sent): logged when
  // it changes, at most once per PICTURE_LOG_MS (a card being resized), never per frame; no address, no content
  const pictureSaid = new Map()
  const notePicture = (kind, css, drawn, sent, quality) => {
    const line = `CSS viewport ${css.width}x${css.height}, page drew ${drawn ? `${drawn.width}x${drawn.height} (${css.width ? Math.round((drawn.width / css.width) * 100) / 100 : '?'}x)` : 'an unreadable JPEG'}, sent ${sent.width}x${sent.height} at quality ${quality}`
    const said = pictureSaid.get(kind)
    const at = Date.now()
    if (said && (said.line === line || at - said.at < PICTURE_LOG_MS)) return
    pictureSaid.set(kind, { line, at })
    log(`[computer] ${label}'s ${kind} picture: ${line}`)
  }
  const release = () => { void send('Runtime.releaseObjectGroup', { objectGroup: 'computer' }).catch(() => undefined) }
  const waitLoaded = async (ms = LOAD_WAIT_MS) => {
    const deadline = Date.now() + ms
    await sleep(100)
    while (Date.now() < deadline && !webContents.isDestroyed() && webContents.isLoading()) await sleep(100)
  }
  // an input event the page answers with a JavaScript dialog is not answered until the dialog is (the page waits in
  // it): the dialog opening ends the wait, and the look that follows shows the dialog
  const dialogOpens = () => {
    const cdp = cdpOf(webContents, { log })
    if (!cdp) return { promise: new Promise(() => {}), off: () => {} }
    let off = () => {}
    const promise = new Promise((resolve) => { off = cdp.on((method) => { if (method === 'Page.javascriptDialogOpening') resolve('dialog') }) })
    return { promise, off: () => off() }
  }
  const input = async (method, params) => {
    const dialog = dialogOpens()
    const answered = own ? own.expect(heardAs(method, params)) : () => {}
    try { return await Promise.race([send(method, params, 60_000), dialog.promise]) } finally { answered(); dialog.off() }
  }
  const mouse = (type, x, y, extra = {}) => input('Input.dispatchMouseEvent', { type, x, y, ...extra })
  const pressKey = async (combo) => {
    const k = keyOf(combo, platform)
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, nativeVirtualKeyCode: k.windowsVirtualKeyCode, modifiers: k.modifiers }
    if (await input('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}), ...(k.commands ? { commands: k.commands } : {}) }) === 'dialog') return
    await input('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }
  // a page in a window nobody sees draws nothing until asked, and the browser routes a press by what was last drawn:
  // a frame is drawn before the pointer goes anywhere. A clipped capture would resize the compositor while a
  // live picture is being taken; use the same non-mutating capture path as screenshots, at low JPEG quality.
  const draw = () => send('Page.captureScreenshot', { format: 'jpeg', quality: 1, fromSurface: false }, 3_000).catch(() => undefined)
  const pointerTo = async (x, y, extra = {}) => {
    await draw()
    if (await mouse('mouseMoved', x, y, extra) === 'dialog') return 'dialog'
    await sleep(POINTER_SETTLE_MS)
    return null
  }
  /** The node the page's hit test finds at a viewport point (the protocol takes the document's coordinates). */
  const nodeAtPoint = async (x, y) => {
    const metrics = await send('Page.getLayoutMetrics')
    const vp = metrics.cssLayoutViewport || metrics.layoutViewport || {}
    try {
      const at = await send('DOM.getNodeForLocation', { x: Math.round(x + (vp.pageX || 0)), y: Math.round(y + (vp.pageY || 0)), includeUserAgentShadowDOM: false })
      return at.backendNodeId
    } catch { return null }
  }
  const resolve = async (node) => (await send('DOM.resolveNode', { backendNodeId: node, objectGroup: 'computer' })).object
  const callOn = async (object, fn, args = [], { byValue = true } = {}) => {
    const { result } = await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: fn, arguments: args, returnByValue: byValue })
    return byValue ? (result ? result.value : undefined) : result
  }
  const call = async (node, fn, args = [], opts = {}) => callOn(await resolve(node), fn, args, opts)
  const idOf = async (object) => (object && object.objectId ? (await send('DOM.describeNode', { objectId: object.objectId })).node.backendNodeId : null)
  /** The frame elements a node's document is shown in, innermost first, as node ids (comparable across documents). */
  const framesAround = async (object) => {
    const ids = []
    for (let at = object, n = 0; n < 8; n += 1) {
      at = await callOn(at, FRAME_OF_FN, [], { byValue: false })
      const id = await idOf(at)
      if (id === null) break
      ids.push(id)
    }
    return ids
  }
  /** Whether `hit` is `target`, inside it, or its label: in one document by the page's own script; across documents
   *  (a frame's) only as frames — the target's own frame element, or something in a frame the target is. */
  const reaches = async (target, hit, targetNode, hitNode) => {
    const [targetDoc, hitDoc] = await Promise.all([idOf(await callOn(target, DOCUMENT_FN, [], { byValue: false })), idOf(await callOn(hit, DOCUMENT_FN, [], { byValue: false }))])
    if (targetDoc === hitDoc) return (await callOn(target, HIT_FN, [{ objectId: hit.objectId }])) || { ok: true }
    if ((await framesAround(target)).includes(hitNode) || (await framesAround(hit)).includes(targetNode)) return { ok: true }
    return { ok: false, covering: await callOn(hit, DESCRIBE_FN) }
  }
  return {
    async info() {
      const metrics = await send('Page.getLayoutMetrics')
      const vp = metrics.cssLayoutViewport || metrics.layoutViewport || {}
      const content = metrics.cssContentSize || metrics.contentSize || {}
      const viewport = { width: Math.round(vp.clientWidth || 0), height: Math.round(vp.clientHeight || 0) }
      // where the view is in the page: there is more below (or to the right) when the page is longer than the view
      const scroll = { x: Math.round(vp.pageX || 0), y: Math.round(vp.pageY || 0), width: Math.round(content.width || viewport.width), height: Math.round(content.height || viewport.height) }
      return { url: webContents.getURL(), title: webContents.getTitle(), loading: webContents.isLoading(), viewport, scroll }
    },
    /** The viewport as a JPEG, CSS-pixel sized (not the screen's device pixels; with `devicePixels`, the page's own
     *  pixels, for a person's eyes), its longest side at most 1280 (or `maxSide`): taken as the page draws itself (no
     *  clip, no scale: the page is not touched) at `captureQuality`, sent so when it is the size wanted, else made
     *  smaller (at `quality`). Its width and height are read from the JPEG sent. `displayImage` also keeps a bounded
     *  device-pixel copy of that same capture for the thread, without changing the coordinate-bearing image. */
    async screenshot({ width, height }, { maxSide = SHOT_MAX_SIDE, quality = SHOT_QUALITY, captureQuality = RAW_QUALITY, timeoutMs, devicePixels = false, displayImage = false } = {}) {
      const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: captureQuality, fromSurface: false }, timeoutMs)
      const raw = Buffer.from(shot.data, 'base64')
      const got = jpegSize(raw)
      const base = devicePixels && got ? got : { width, height }
      const fit = Math.min(1, maxSide / Math.max(base.width || 1, base.height || 1))
      const want = { width: Math.max(1, Math.round(base.width * fit)), height: Math.max(1, Math.round(base.height * fit)) }
      const kind = devicePixels ? 'live' : 'look'
      let image
      if (!nativeImage || (got && got.width === want.width && got.height === want.height)) {
        const sent = got || want
        notePicture(kind, { width, height }, got, sent, captureQuality)
        image = { media_type: 'image/jpeg', data_base64: shot.data, width: sent.width, height: sent.height }
      } else {
        const small = nativeImage.createFromBuffer(raw).resize({ width: want.width, height: want.height, quality: 'good' }).toJPEG(quality)
        const sent = jpegSize(small) || want
        notePicture(kind, { width, height }, got, sent, quality)
        image = { media_type: 'image/jpeg', data_base64: small.toString('base64'), width: sent.width, height: sent.height }
      }
      // The thread keeps the same captured instant at device resolution. This never changes the agent image or
      // its coordinate scale, never captures a second frame, and never enlarges a low-resolution source.
      if (displayImage && !devicePixels && got && (got.width > image.width || got.height > image.height)) {
        try {
          let display = raw, displayQuality = captureQuality
          const fit = Math.min(1, SHARP_FRAME_MAX_SIDE / Math.max(got.width, got.height))
          if (fit < 1 || raw.length > DISPLAY_MAX_BYTES) {
            if (!nativeImage) return image
            display = nativeImage.createFromBuffer(raw).resize({ width: Math.max(1, Math.round(got.width * fit)), height: Math.max(1, Math.round(got.height * fit)), quality: 'good' }).toJPEG(SHARP_FRAME_QUALITY)
            displayQuality = SHARP_FRAME_QUALITY
          }
          const size = jpegSize(display)
          if (size && display.length <= DISPLAY_MAX_BYTES && Math.max(size.width, size.height) <= SHARP_FRAME_MAX_SIDE) {
            image.display_image = { media_type: 'image/jpeg', data_base64: display.toString('base64'), ...size }
            notePicture('display', { width, height }, got, size, displayQuality)
          }
        } catch { /* the optional display picture must not lose the agent's usable look */ }
      }
      return image
    },
    /** The page's accessibility tree, and each frame's: `[{ url, nodes }]`, the page first; a frame of another
     *  process (another site: the protocol's frame tree leaves it out, the page's own frame list has it) has
     *  `nodes: null`. */
    async tree() {
      const { nodes } = await send('Accessibility.getFullAXTree', {}, 20_000)
      const trees = [{ url: webContents.getURL(), nodes: nodes || [] }]
      let frameTree = null
      try { ({ frameTree } = await send('Page.getFrameTree')) } catch { /* the page's own frames only */ }
      const children = []
      const walk = (t) => { for (const c of (t && t.childFrames) || []) { children.push(c.frame); walk(c) } }
      walk(frameTree)
      for (const frame of children.slice(0, 10)) {
        try {
          const got = await send('Accessibility.getFullAXTree', { frameId: frame.id }, 10_000)
          trees.push({ url: frame.url, nodes: got.nodes || [] })
        } catch { trees.push({ url: frame.url, nodes: null }) }
      }
      try {
        const main = webContents.mainFrame
        for (const frame of main.framesInSubtree.filter((f) => f !== main && f.processId !== main.processId).slice(0, 10)) trees.push({ url: frame.url, nodes: null })
      } catch { /* the frame list is gone with the page */ }
      return trees
    },
    /** The middle of an element's first box, scrolled into view first (viewport CSS pixels); null when it has none. */
    async box(node) {
      try { await send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node }) } catch { /* not scrollable: its box as it is */ }
      let quads
      try { ({ quads } = await send('DOM.getContentQuads', { backendNodeId: node })) } catch { return null }
      const q = (quads || []).find((c) => c.length === 8)
      if (!q) return null
      return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 }
    },
    /** Whether the page's own hit test at (x, y) finds the element (see HIT_FN); a test that cannot be made is no
     *  reason to refuse. */
    async hitTest(node, x, y) {
      try {
        const at = await nodeAtPoint(x, y)
        if (at === null || at === node) return { ok: true }
        return await reaches(await resolve(node), await resolve(at), node, at)
      } catch {
        return { ok: true }
      } finally { release() }
    },
    /** What is at a viewport point now: `{ inside (in `expected`, when one is named), disabled, readonly, desc, other_site,
     *  control (the node of the control there, or null) }`, or null when nothing is. */
    async nodeAt(x, y, expected = null) {
      const at = await nodeAtPoint(x, y)
      if (at === null) return null
      try {
        const hit = await resolve(at)
        let inside = null
        if (expected !== null) {
          let exp = null
          try { exp = await resolve(expected) } catch { exp = null }
          inside = exp ? at === expected || (await reaches(exp, hit, expected, at)).ok : false
        }
        const out = await callOn(hit, AT_FN)
        const control = await idOf(await callOn(hit, CONTROL_FN, [], { byValue: false }))
        return { ...out, inside, control }
      } finally { release() }
    },
    /** Whether an element takes input: `{ disabled, readonly, desc }`. */
    async state(node) {
      try { return (await call(node, STATE_FN)) || { disabled: false, readonly: false, desc: '' } } finally { release() }
    },
    /** The element's accessibility node as it is now (the snapshot's line is compared with it), or null; it throws
     *  when the page has no such element any more. */
    async axNode(node) {
      const { nodes } = await send('Accessibility.getPartialAXTree', { backendNodeId: node, fetchRelatives: false })
      return (nodes || []).find((n) => n.backendDOMNodeId === node) || null
    },
    /** Where every laid-out node of the main document is now (viewport CSS pixels, one layout snapshot — taken
     *  beside the screenshot, it is where the picture shows them): `Map(node -> { x, y, width, height })` — empty
     *  when nothing is laid out. */
    async layout() {
      const snap = await send('DOMSnapshot.captureSnapshot', { computedStyles: [] }, 10_000)
      const doc = snap && snap.documents && snap.documents[0]
      if (!doc || !doc.layout) return new Map()
      // the layout is in the view's device pixels (the page zoom with them) — not `devicePixelRatio` under a device
      // scale set on the debugger (the agent's browser): the layout viewport's pixels over its CSS pixels
      const metrics = await send('Page.getLayoutMetrics')
      const device = metrics.layoutViewport || {}
      const css = metrics.cssLayoutViewport || {}
      const dpr = device.clientWidth > 0 && css.clientWidth > 0 ? device.clientWidth / css.clientWidth : 1
      const ids = doc.nodes.backendNodeId
      const sx = doc.scrollOffsetX || 0
      const sy = doc.scrollOffsetY || 0
      const boxes = new Map()
      doc.layout.nodeIndex.forEach((index, k) => {
        const id = ids[index]
        if (boxes.has(id)) return
        const [x, y, w, h] = doc.layout.bounds[k]
        boxes.set(id, { x: (x - sx) / dpr, y: (y - sy) / dpr, width: w / dpr, height: h / dpr })
      })
      return boxes
    },
    /** The element scrolled to the middle of the view (out from under a header pinned to its top, say). */
    async centre(node) {
      try { await call(node, 'function () { const el = this.nodeType === 1 ? this : this.parentElement; if (el) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }) }') } catch { /* gone: the next box says so */ } finally { release() }
    },
    /** The element focused unless it (or something in it, or around it) already is. */
    async focus(node) {
      try {
        if (!(await call(node, HOLDS_FOCUS_FN))) await send('DOM.focus', { backendNodeId: node })
      } catch { /* not focusable: the click is what there is */ } finally { release() }
    },
    /** Whether the element (or something in it, or around it) has the focus. */
    async holdsFocus(node) {
      try { return !!(await call(node, HOLDS_FOCUS_FN)) } catch { return false } finally { release() }
    },
    /** The focused element: `{ node, desc }` (node null when nothing is). */
    async activeElement() {
      try {
        const { result } = await send('Runtime.evaluate', { expression: `(${ACTIVE_OF})(document)`, objectGroup: 'computer' })
        if (!result || !result.objectId) return { node: null, desc: 'nothing' }
        const { node } = await send('DOM.describeNode', { objectId: result.objectId })
        const { result: desc } = await send('Runtime.callFunctionOn', { objectId: result.objectId, functionDeclaration: `function () { return (${DESCRIBE})(this) }`, returnByValue: true })
        return { node: node.backendNodeId, desc: desc ? desc.value : '' }
      } catch { return { node: null, desc: 'nothing' } } finally { release() }
    },
    /** What a field holds: `{ value (null: not a text field), secret }`. */
    async fieldValue(node) {
      try { return (await call(node, VALUE_FN)) || { value: null, secret: false } } catch { return { value: null, secret: false } } finally { release() }
    },
    async caretToEnd(node) {
      try { await call(node, END_FN) } catch { /* the caret stays where the click put it */ } finally { release() }
    },
    async selectOption(node, choice) {
      try { return (await call(node, SELECT_FN, [{ value: choice }])) || { ok: false, reason: 'the page did not answer' } } finally { release() }
    },
    /** A press at `from`, a move in steps, a release at `to` (a pointer drag; the page's own drag and drop sees it as
     *  a person's, an HTML5 drag included). */
    async drag(from, to) {
      if (await pointerTo(from.x, from.y) === 'dialog') return
      if (await mouse('mousePressed', from.x, from.y, { button: 'left', clickCount: 1, buttons: 1 }) === 'dialog') return
      for (let i = 1; i <= 10; i += 1) {
        await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10, { button: 'left', buttons: 1 })
        await sleep(16)
      }
      await mouse('mouseReleased', to.x, to.y, { button: 'left', clickCount: 1 })
    },
    /** A click at (x, y): the pointer there first; `beforePress` (it may throw) is the last word before the press. */
    async click(x, y, { button = 'left', count = 1, beforePress = null } = {}) {
      if (await pointerTo(x, y) === 'dialog') return
      if (beforePress) await beforePress()
      for (let n = 1; n <= count; n += 1) {
        if (await mouse('mousePressed', x, y, { button, clickCount: n, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4 }) === 'dialog') return
        if (await mouse('mouseReleased', x, y, { button, clickCount: n }) === 'dialog') return
      }
    },
    move: async (x, y) => { await pointerTo(x, y) },
    scroll: async (x, y, dx, dy) => { if (await pointerTo(x, y) !== 'dialog') await mouse('mouseWheel', x, y, { deltaX: dx, deltaY: dy }) },
    // `before` (it may throw) is the last word before the dispatch, as a click's `beforePress`
    async insertText(text, { before = null } = {}) { if (before) await before(); return input('Input.insertText', { text }) },
    async key(combo, { before = null } = {}) { if (before) await before(); return pressKey(combo) },
    /** What the focused field holds is selected and deleted (a text field, a textarea, an editable region); the
     *  select-all is harmless, so `beforeDelete` may still stop it before anything is deleted. */
    async clearFocused({ before = null, beforeDelete = null } = {}) {
      if (before) await before()
      await pressKey(platform === 'darwin' ? 'Meta+A' : 'Control+A')
      if (beforeDelete) await beforeDelete()
      await pressKey('Backspace')
    },
    /** Another site's frames (another process) listen for the next press; the returned check says whether one got
     *  it (true), none did (false), or it cannot be told (null: no such frame, or one did not answer). */
    async armOtherFrames() {
      let frames = []
      try { const main = webContents.mainFrame; frames = main.framesInSubtree.filter((f) => f !== main && f.processId !== main.processId).slice(0, 20) } catch { return async () => null }
      const key = `__oasis_press_${Math.random().toString(36).slice(2)}`
      // any of a press's events counts (a page may stop one of them before this listener hears it)
      const listen = `(() => { const k = ${JSON.stringify(key)}; window[k] = false; for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) addEventListener(t, () => { window[k] = true }, { capture: true, once: true }); return true })()`
      const armed = (await Promise.all(frames.map((f) => withTimeout(f.executeJavaScript(listen), 1_000).then(() => f, () => null)))).filter(Boolean)
      return async () => {
        if (!armed.length) return null
        const got = await Promise.all(armed.map((f) => withTimeout(f.executeJavaScript(`(() => { const v = window[${JSON.stringify(key)}]; delete window[${JSON.stringify(key)}]; return v })()`), 1_000).catch(() => null)))
        if (got.some((v) => v === true)) return true
        return got.every((v) => v === false) ? false : null
      }
    },
    async navigate(url) {
      const out = await send('Page.navigate', { url })
      if (out && out.errorText) throw new Error(`the page did not open ${url}: ${out.errorText}`)
      await waitLoaded()
    },
    async history(delta) {
      const nav = webContents.navigationHistory
      if (delta < 0 ? !nav.canGoBack() : !nav.canGoForward()) throw new Error(`there is no page to go ${delta < 0 ? 'back' : 'forward'} to`)
      if (delta < 0) nav.goBack(); else nav.goForward()
      await waitLoaded()
    },
    async reload() { webContents.reload(); await waitLoaded() },
    setFiles: (node, files) => send('DOM.setFileInputFiles', { backendNodeId: node, files }),
    answerDialog: (accept, text) => send('Page.handleJavaScriptDialog', { accept, ...(text !== undefined ? { promptText: text } : {}) }),
    /** The words of the page (or of one element) as it shows them. */
    async readText(node) {
      if (node === null || node === undefined) {
        const { result } = await send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true })
        return String((result && result.value) || '')
      }
      try { return String((await call(node, 'function () { return this.innerText !== undefined ? this.innerText : this.textContent }')) || '') } finally { release() }
    },
    async settle() { await waitLoaded(5_000); await sleep(SETTLE_MS) },
    /** What a wait for words reads: the page's words, and the names of its visible controls (aria-label, title). */
    async pageWords() {
      const { result } = await send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
        const names = [...document.querySelectorAll('[aria-label],[title]')].filter((e) => e.getClientRects().length).map((e) => e.getAttribute('aria-label') || e.getAttribute('title'))
        return (document.body ? document.body.innerText : '') + '\\n' + names.join('\\n')
      })()` })
      return String((result && result.value) || '')
    },
    /** What is known without asking the page (a page held by a dialog answers nothing). */
    shallowInfo: () => ({ url: webContents.getURL(), title: webContents.getTitle(), loading: webContents.isLoading() }),
    /** While the agent clicks, the page's file chooser comes to the computer instead of opening the system's dialog. */
    interceptChooser: (on) => send('Page.setInterceptFileChooserDialog', { enabled: !!on }),
  }
}

/** A page as the computer's surface: `contents()` gives (and makes, when needed) its webContents. The adapter
 *  counts the page's changes the agent did not make itself — a navigation, the person's input, a dialog — into
 *  `generation`, so a look taken before one of them reads as stale. A download is the run's that held the page when it
 *  began: named only on that run's looks, counted for its waits, given up when it lets go. `unheldDownloads` says what
 *  happens to one that begins while no run holds the page: 'page' (the page's own way, the person's save dialog — the
 *  ChatGPT page), or 'cancel' (the agent's browser: the page's own way too when it is the person's — the card shows the
 *  page, or they used it within the last minute — else cancelled). `reset` (the agent's browser) takes the page back to a blank one
 *  with no history; `visibility` says whether the page shows on a card now, and whether it ever did. `deviceScale`
 *  (the agent's browser): the page draws at this many device pixels per CSS pixel whatever the screen (set on its
 *  debugger session at every attach), and its live picture keeps them (SHARP_FRAME_MAX_SIDE); null: the screen's. */
function electronSurface({ label, contents, opened, allowsUrl, busy = () => null, log = () => {}, platform = process.platform, downloadsDir = null, console: listenConsole = false, unheldDownloads = 'page', reset = null, visibility = null, nativeImage = null, deviceScale = null, pageId = null, routeDownloads = true }) {
  let generation = 0
  let holder = () => null
  const downloads = []                 // finished: { owner, name, path, bytes, media_type, url }
  const inflight = new Map()           // item -> { owner, name, file, received, movedAt, noted, dropped }
  const doneBy = new Map()             // owner -> downloads finished
  const failedBy = new Map()           // owner -> downloads given up or refused
  const consoleLines = []
  let personAt = null
  let dialogSeq = 0
  const notes = []                     // { line, owner } (owner null: whoever looks next)
  // every page this surface has shown (the agent's browser has tabs): its driver, its dialog, its file chooser; `cur`
  // is the one shown now — a page that is not shown changes nothing an agent's look showed
  const pages = new WeakMap()
  let cur = null
  // the page shown, as the browser names it (its tab): another one since a look makes that look stale
  let seenPage = pageId ? pageId() : null
  const own = ownInput()
  // the profiles whose downloads are heard (one listener per profile, however many tabs open and close in it)
  const heardSessions = new WeakSet()
  // the agent's press under way (interception on), and when the person last used the page as it began
  let pressing = null
  const bump = () => { generation += 1 }
  const syncPage = () => { if (!pageId) return; const now = pageId(); if (now !== seenPage) { seenPage = now; bump() } }
  function note(line, owner = null) { notes.push({ line, owner }); if (notes.length > 20) notes.shift() }
  const personsDownload = () => {
    const seen = visibility ? visibility() : null
    return !!(seen && seen.shown) || (personAt !== null && Date.now() - personAt < PERSON_DOWNLOAD_MS)
  }
  const takeDownload = (item) => {
    const by = holder()
    const name = path.basename(item.getFilename() || 'download').replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'download'
    if (by === null || by === 'bridge') {
      // the person's own (the page shows on its card, or they used it a moment ago): the page's own way, their save
      // dialog. Else nobody's — a page left to itself — cancelled; no agent is told of it (the next to look may be
      // another session's).
      if (unheldDownloads !== 'cancel' || personsDownload()) return
      item.cancel()
      log(`[computer] a download (${name}) began on ${label} while no run held it and the person was not on it: cancelled`)
      return
    }
    const failed = () => failedBy.set(by, (failedBy.get(by) || 0) + 1)
    if (item.getTotalBytes() > MAX_DOWNLOAD_BYTES) { item.cancel(); failed(); note(`A download (${name}, ${Math.round(item.getTotalBytes() / 1048576)} MB) was refused: over ${MAX_DOWNLOAD_BYTES / 1048576} MB.`, by); return }
    fs.mkdirSync(downloadsDir, { recursive: true })
    const file = path.join(downloadsDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`)
    item.setSavePath(file)
    const rec = { owner: by, name, file, received: 0, movedAt: Date.now(), noted: false, dropped: false, watch: null }
    inflight.set(item, rec)
    const giveUp = (why) => { if (rec.noted || rec.dropped) return; rec.noted = true; note(why, by); item.cancel() }
    const watch = setInterval(() => { if (Date.now() - rec.movedAt > DOWNLOAD_STALL_MS) giveUp(`A download (${name}) made no progress for ${DOWNLOAD_STALL_MS / 1000} s; it was cancelled.`) }, DOWNLOAD_CHECK_MS)
    if (typeof watch.unref === 'function') watch.unref()
    rec.watch = watch
    item.on('updated', (_e, state) => {
      if (state === 'interrupted') { giveUp(`A download (${name}) was interrupted (the connection broke off); it was cancelled.`); return }
      const got = item.getReceivedBytes()
      if (got !== rec.received) { rec.received = got; rec.movedAt = Date.now() }
      if (got > MAX_DOWNLOAD_BYTES) giveUp(`A download (${name}) was cancelled: over ${MAX_DOWNLOAD_BYTES / 1048576} MB.`)
    })
    item.once('done', (_e, state) => {
      clearInterval(watch)
      inflight.delete(item)
      if (state === 'completed' && !rec.dropped) {
        let bytes = 0
        try { bytes = fs.statSync(file).size } catch { /* gone */ }
        downloads.push({ owner: by, name, path: file, bytes, media_type: item.getMimeType() || null, url: String(item.getURL() || '').slice(0, 300) })
        doneBy.set(by, (doneBy.get(by) || 0) + 1)
        log(`[computer] ${by} downloaded ${name} (${bytes} bytes)`)
        return
      }
      fs.rmSync(file, { force: true })
      if (rec.dropped) return
      failed()
      if (!rec.noted) note(`A download (${name}) did not finish (${state}).`, by)
    })
  }
  /** The page's record, its listeners set up once (a tab shown again is the same page, not a new one). */
  const recordOf = (wc) => {
    let rec = pages.get(wc)
    if (rec) return rec
    rec = { wc, driver: cdpDriver(wc, { log, platform, own, nativeImage, label }), dialog: null, chooser: null, framing: null }
    pages.set(wc, rec)
    const shown = () => cur === rec
    // the page's process ended (a crash, out of memory): said, and the page loaded again
    wc.on('render-process-gone', (_event, details) => {
      if (shown()) { note(`The page's process ended (${details && details.reason}); the page was loaded again.`); bump() }
      setTimeout(() => { if (!wc.isDestroyed()) wc.reload() }, 500)
    })
    wc.on('unresponsive', () => { if (shown()) note('The page stopped responding (a script running long); looks and actions may time out until it recovers.') })
    // a surface of one tab of the agent's browser (routeDownloads false) is handed its downloads by the browser's one
    // listener for the whole profile (agentBrowser's downloadRouter): a listener per tab would pile up
    if (routeDownloads && downloadsDir && wc.session && !heardSessions.has(wc.session)) {
      heardSessions.add(wc.session)
      wc.session.on('will-download', (_event, item, from) => { if (from && pages.has(from)) takeDownload(item) })
    }
    wc.on('did-navigate', () => { if (shown()) bump() })
    wc.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame && shown()) bump() })
    wc.on('input-event', (_event, ev) => {
      if (!ev || own.heard(ev) || !PERSON_INPUT.has(ev.type)) return
      personAt = Date.now()
      bump()
    })
    const cdp = cdpOf(wc, { log })
    if (!cdp) return rec
    cdp.onAttach(() => {
      void cdp.send('Page.enable').catch((error) => log(`[computer] Page.enable failed: ${error.message}`))
      // once per attach (the session's own setting, gone with it), never per picture: the page lays out again when it changes
      if (deviceScale) void cdp.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: deviceScale, mobile: false }).then(() => log(`[computer] ${label} draws at ${deviceScale}x`), (error) => log(`[computer] ${label}'s device scale was not set: ${error.message}`))
      // the page's errors (a web app the agent builds or checks): kept for the next look
      if (listenConsole) void cdp.send('Runtime.enable').then(() => cdp.send('Log.enable')).catch(() => undefined)
    })
    const heard = (line) => { if (!shown()) return; consoleLines.push(line.replace(/\s+/g, ' ').slice(0, CONSOLE_CHARS)); if (consoleLines.length > KEEP_CONSOLE) consoleLines.shift() }
    cdp.on((method, params) => {
      if (listenConsole) {
        if (method === 'Runtime.consoleAPICalled' && (params.type === 'error' || params.type === 'warning' || params.type === 'assert')) {
          heard(`${params.type}: ${(params.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ')}`)
        } else if (method === 'Runtime.exceptionThrown') {
          const d = params.exceptionDetails || {}
          heard(`uncaught: ${(d.exception && d.exception.description) || d.text || 'an exception'}${d.url ? ` (${d.url}:${d.lineNumber})` : ''}`)
        } else if (method === 'Log.entryAdded' && params.entry && params.entry.level === 'error') {
          heard(`${params.entry.source}: ${params.entry.text}${params.entry.url ? ` (${params.entry.url})` : ''}`)
        }
      }
      if (method === 'Page.javascriptDialogOpening') { dialogSeq += 1; rec.dialog = { type: params.type, message: String(params.message || '').slice(0, 2000), default_prompt: params.defaultPrompt || '', seq: dialogSeq }; if (shown()) bump() }
      else if (method === 'Page.javascriptDialogClosed') { rec.dialog = null; if (shown()) bump() }
      else if (method === 'Page.fileChooserOpened' && params.backendNodeId !== undefined) {
        // the agent's press opened it — unless the person's input came since the press: theirs, never offered to the
        // agent (dropped: interception kept it from the system's dialog, so they open it again)
        if (shown() && pressing !== null && personAt === pressing.personFrom) rec.chooser = { node: params.backendNodeId, mode: params.mode }
        else log(`[computer] a file chooser opened on ${label} after the person's input (or outside an agent's press): not offered to the agent`)
      }
      else if (method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) rec.chooser = null
    })
    cdp.attach()
    return rec
  }
  /** The page shown now becomes the surface's: another page than before is a change a look did not see. */
  const wire = (wc) => {
    const rec = recordOf(wc)
    if (cur !== rec) { cur = rec; bump() }
    syncPage()
    return rec
  }
  /** The record of the page shown now (the tab the person may have changed since the last look), never opening one. */
  const current = () => (opened() ? wire(contents()) : cur)
  return {
    label,
    opened,
    open() {
      const rec = wire(contents())
      const driver = rec.driver
      return {
        ...driver,
        // the agent's press brings a file chooser to the computer, never the system's dialog: interception is on from
        // right before the press (after the pointer went there and held still) to a moment after it. The person's own
        // clicks at any other time open theirs as usual; one in that moment is told apart by their input.
        click: async (x, y, opts = {}) => {
          const press = { personFrom: null }
          let on = false
          const beforePress = async () => {
            await driver.interceptChooser(true).catch(() => undefined)
            on = true
            press.personFrom = personAt
            pressing = press
            // the caller's last word stays the last before the press
            if (opts.beforePress) await opts.beforePress()
          }
          try {
            await driver.click(x, y, { ...opts, beforePress })
            if (on) await new Promise((r) => setTimeout(r, CHOOSER_TAIL_MS))
          } finally {
            if (on) {
              // a dialog the click opened holds the page, which answers no command until the dialog is answered: the
              // interception's end then waits its turn (sent, not awaited)
              const off = driver.interceptChooser(false).catch(() => undefined).then(() => { if (pressing === press) pressing = null })
              if (!rec.dialog) await off
            }
          }
        },
      }
    },
    /** The page as it is now, for a person watching the agent work: its address, title and a light picture. Null
     *  when no agent has opened the page, a dialog holds it (it answers nothing) or it does not answer in time. One
     *  capture at a time (a second asker gets the same one); it opens nothing and counts as nobody's input. */
    frame() {
      if (!opened()) return Promise.resolve(null)
      const rec = current()
      if (!rec || rec.wc.isDestroyed() || rec.dialog) return Promise.resolve(null)
      const page = rec.driver
      const shownAs = pageId ? pageId() : null
      // one capture at a time per page; a picture of a page no longer shown when it comes (the person changed the tab
      // meanwhile) is dropped, never shown as the new tab's; each names the page it is of
      rec.framing ??= (async () => {
        try {
          const info = await page.info()
          if (info.viewport.width < 1 || info.viewport.height < 1) return null
          const image = await page.screenshot(info.viewport, deviceScale
            ? { maxSide: SHARP_FRAME_MAX_SIDE, quality: SHARP_FRAME_QUALITY, captureQuality: SHARP_FRAME_QUALITY, timeoutMs: FRAME_TIMEOUT_MS, devicePixels: true }
            : { maxSide: FRAME_MAX_SIDE, quality: FRAME_QUALITY, timeoutMs: FRAME_TIMEOUT_MS, devicePixels: true })
          // A non-mutating capture can finish at a size set while it was in flight. Do not pair that picture
          // with the old viewport (the thread places its pointer by it); the next scheduled frame will try again.
          const settled = (await page.info()).viewport
          if (settled.width !== info.viewport.width || settled.height !== info.viewport.height) return null
          return { url: info.url, title: info.title, loading: !!info.loading, viewport: info.viewport, image, ...(shownAs !== null ? { page: shownAs } : {}) }
        } catch {
          return null
        } finally {
          rec.framing = null
        }
      })()
      return rec.framing.then((got) => (got && opened() && current() === rec && (!pageId || got.page === pageId()) ? got : null))
    },
    generation: () => { syncPage(); return generation },
    /** The page shown now as the surface names it (the browser's tab), or null for a surface of one page. */
    pageId: () => (pageId ? pageId() : null),
    personAt: () => personAt,
    /** The person used the page through the app (its address bar, its tabs, back, reload, the element picker): as
     *  their input on the page — an agent's look before it is stale, and an agent waits a moment. */
    personUsed() { personAt = Date.now(); bump() },
    allowsUrl,
    busy,
    /** What happened since the last look of this owner (the lists taken): the dialog and file chooser open now, the
     *  notes for it (or for anyone), its downloads, the page's errors. */
    events(owner) {
      const mine = []
      for (let i = 0; i < notes.length;) { if (notes[i].owner === null || notes[i].owner === owner) mine.push(notes.splice(i, 1)[0].line); else i += 1 }
      const taken = []
      for (let i = 0; i < downloads.length;) { if (downloads[i].owner === owner) { const d = downloads.splice(i, 1)[0]; taken.push({ name: d.name, path: d.path, bytes: d.bytes, media_type: d.media_type, url: d.url }) } else i += 1 }
      const rec = current()
      return { dialog: rec ? rec.dialog : null, chooser: rec ? rec.chooser : null, notes: mine, downloads: taken, console: consoleLines.splice(0) }
    },
    /** The dialog and the file chooser open now, on the page shown now (nothing taken). */
    peek: () => { const rec = current(); return { dialog: rec ? rec.dialog : null, chooser: rec ? rec.chooser : null } },
    /** How many of this owner's downloads finished. */
    downloadsDone: (owner) => doneBy.get(owner) || 0,
    /** How many of this owner's downloads were refused or did not finish (the notes say why). */
    downloadsFailed: (owner) => failedBy.get(owner) || 0,
    /** An owner let go: its downloads still on their way are cancelled, those it never took are removed — another run
     *  never gets them. */
    released(owner) {
      for (const [item, rec] of inflight) {
        if (rec.owner !== owner) continue
        rec.dropped = true
        item.cancel()
        log(`[computer] ${owner}'s download ${rec.name} was cancelled: the run let go of the page`)
      }
      for (let i = downloads.length - 1; i >= 0; i -= 1) {
        if (downloads[i].owner !== owner) continue
        fs.rmSync(downloads[i].path, { force: true })
        log(`[computer] ${owner}'s download ${downloads[i].name} was removed: the run let go of the page before it took it`)
        downloads.splice(i, 1)
      }
      for (let i = notes.length - 1; i >= 0; i -= 1) if (notes[i].owner === owner) notes.splice(i, 1)
      doneBy.delete(owner)
      failedBy.delete(owner)
    },
    /** The page taken back to a blank one with no history (another run takes the page); false when this surface
     *  keeps its page. */
    async reset() {
      if (!reset) return false
      const was = current()
      if (was && was.dialog) await was.driver.answerDialog(false).catch(() => undefined)
      await reset()
      const rec = current()
      for (const r of [was, rec]) if (r) { r.dialog = null; r.chooser = null }
      consoleLines.length = 0
      for (let i = notes.length - 1; i >= 0; i -= 1) if (notes[i].owner === null) notes.splice(i, 1)
      syncPage()
      bump()
      return true
    },
    visibility: () => (visibility ? visibility() : null),
    bindHolder: (fn) => { holder = fn },
    /** A download this page began, handed over by the profile's one listener (a tab of the agent's browser). */
    takeDownload: (item) => { if (downloadsDir) takeDownload(item); else item.cancel() },
    /** The page is gone (its tab closed): its downloads on their way are cancelled and those nobody took removed. */
    dispose() {
      for (const [item, rec] of inflight) { rec.dropped = true; clearInterval(rec.watch); try { item.cancel() } catch { /* done already */ } fs.rmSync(rec.file, { force: true }) }
      inflight.clear()
      for (const d of downloads.splice(0)) fs.rmSync(d.path, { force: true })
      notes.length = 0
      consoleLines.length = 0
      cur = null
    },
    chooserUsed: () => { const rec = current(); if (rec) rec.chooser = null },
    note,
  }
}

/** The backstage: hidden windows where a page not shown on a card lives. A view hidden inside the app's window
 *  draws nothing new (a screenshot of it waits for a frame that never comes, seen 2026-10-01) and does not take a
 *  size; in a window of its own that is never shown it lays out at its size and draws when asked. `window()` is the
 *  one the ChatGPT page uses. `windowFor(key)` is a window of one tab of the agent's browser: two views in one hidden
 *  window overlap, and an unclipped `fromSurface: false` capture of the one underneath shows the one on top
 *  (Electron 44.9, 2026-10-20: handoff/rendering-gate.json) — so every tab has its own, made with the tab and
 *  destroyed with it (`release(key)`). None of them ever shows or takes the focus, and none is a window of the app's
 *  (the app quits when its window closes). */
function backstage({ BrowserWindow }) {
  let stage = null
  const hosts = new Map()
  const hidden = (width, height) => new BrowserWindow({ show: false, width, height, useContentSize: true, skipTaskbar: true, focusable: false, title: 'oasis-code backstage', webPreferences: { backgroundThrottling: false } })
  return {
    window() {
      if (!stage || stage.isDestroyed()) stage = hidden(STAGE_SIZE.width, STAGE_SIZE.height)
      return stage
    },
    windowFor(key) {
      let win = hosts.get(key)
      if (!win || win.isDestroyed()) { win = hidden(HIDDEN_BOUNDS.width, HIDDEN_BOUNDS.height); hosts.set(key, win) }
      return win
    },
    release(key) {
      const win = hosts.get(key)
      hosts.delete(key)
      if (win && !win.isDestroyed()) win.destroy()
    },
    hosts: () => hosts.size,
    is: (win) => (!!stage && win === stage) || [...hosts.values()].includes(win),
    close() {
      if (stage && !stage.isDestroyed()) stage.destroy()
      stage = null
      for (const win of hosts.values()) if (!win.isDestroyed()) win.destroy()
      hosts.clear()
    },
  }
}

/** Where a view goes: on the app's window at the card's place when it shows, else backstage at `size` (or, with no
 *  backstage, hidden in the app's window — shown for the moment of a resize, the only way a size reaches it). Returns
 *  the window it is in now. */
function seatView(view, { attachedTo, show, place, size, host, stage }) {
  const target = show ? host() : stage ? stage.window() : host()
  if (!target || target.isDestroyed()) return attachedTo
  if (attachedTo !== target) {
    if (attachedTo && !attachedTo.isDestroyed()) attachedTo.contentView.removeChildView(view)
    target.contentView.addChildView(view)
  }
  if (show) {
    view.setBounds({ x: place.x, y: place.y, width: place.width, height: place.height })
    view.setVisible(true)
  } else if (stage) {
    view.setBounds({ x: 0, y: 0, width: Math.min(size.width, STAGE_SIZE.width), height: Math.min(size.height, STAGE_SIZE.height) })
    view.setVisible(true)
  } else {
    view.setVisible(true)
    view.setBounds({ x: 0, y: 0, width: size.width, height: size.height })
    view.setVisible(false)
  }
  return target
}

/** Whether the agent's browser may open an address: the web (http, https) and a blank page; nothing of this machine's
 *  files, the browser's own pages or a script. */
function browserAllows(url) {
  if (url === BROWSER_HOME) return true
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch { return false }
}

/** Whether an address is one of the harness's own (the backend, the bridge, the director): a loopback host on one of
 *  `ports`. The agent's browser never opens or calls them — a page there could approve the agent's own proposals. */
function harnessAddress(url, ports) {
  let u
  try { u = new URL(url) } catch { return false }
  if (!/^(https?|wss?):$/.test(u.protocol)) return false
  // the root's trailing dot (`localhost.`, `127.0.0.1.`) is not part of the name
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  const loopback = host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '0.0.0.0' || host === '::1' || host === '::' || /^::ffff:(7f|127\.)/.test(host)
  const port = Number(u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80))
  return loopback && ports.includes(port)
}

/** A card whose place keeps changing (a layout that never settles) shows its page shrinking and growing: the places
 *  the renderer sends are counted, and past `burst` in `windowMs` the last few are logged — once per `quietMs`. */
function placementWatch({ log, now = Date.now, burst = 10, windowMs = 2_000, quietMs = 10_000, name = 'browser' }) {
  const recent = []
  let saidAt = -Infinity
  return (place) => {
    const at = now()
    recent.push({ at, place })
    while (recent.length && at - recent[0].at > windowMs) recent.shift()
    if (recent.length < burst || at - saidAt < quietMs) return
    saidAt = at
    const shown = recent.slice(-4).map(({ place: p }) => `${p.visible ? '' : 'hidden '}${p.x},${p.y} ${p.width}x${p.height}`).join(' | ')
    log(`[computer] the ${name} card's place changed ${recent.length} times in ${windowMs / 1000} s (its layout does not settle): ${shown}`)
  }
}

/** Where the agent browser's page goes, set only when it changes (a card that did not move sets nothing — a view
 *  given the same bounds or visibility again still makes the window lay out and draw): on the app's window at the
 *  card's place while the card shows it, else backstage at `size` (or, with no backstage, hidden in the app's window
 *  — shown for the moment of a resize, the only way a size reaches it). `seated` is what was set last (null: nothing
 *  known, e.g. a view just made or moved). Returns `{ attachedTo, seated }`. */
function seatPane(view, { attachedTo, seated, show, place, size, host, stage }) {
  const target = show ? host() : stage ? stage.window() : host()
  if (!target || target.isDestroyed()) return { attachedTo, seated }
  let known = seated
  if (attachedTo !== target) {
    if (attachedTo && !attachedTo.isDestroyed()) attachedTo.contentView.removeChildView(view)
    target.contentView.addChildView(view)
    known = null
  }
  // backstage the page keeps its size: a backstage smaller than it (a card larger than STAGE_SIZE, expanded on a large
  // screen) is made larger rather than the page cut to it
  if (!show && stage && typeof target.getContentSize === 'function' && typeof target.setContentSize === 'function') {
    const [w, h] = target.getContentSize()
    if (w < size.width || h < size.height) target.setContentSize(Math.max(w, size.width), Math.max(h, size.height))
  }
  const fits = !show && stage && typeof target.getContentSize === 'function'
  const bounds = show
    ? { x: place.x, y: place.y, width: place.width, height: place.height }
    : fits ? { x: 0, y: 0, width: size.width, height: size.height }
      : { x: 0, y: 0, width: Math.min(size.width, STAGE_SIZE.width), height: Math.min(size.height, STAGE_SIZE.height) }
  const visible = show || !!stage
  const moved = !known || known.x !== bounds.x || known.y !== bounds.y || known.width !== bounds.width || known.height !== bounds.height
  if (!show && !stage) {
    if (moved) { view.setVisible(true); view.setBounds(bounds) }
    if (moved || !known || known.visible !== false) view.setVisible(false)
  } else {
    if (moved) view.setBounds(bounds)
    if (!known || known.visible !== visible) view.setVisible(visible)
  }
  return { attachedTo: target, seated: { ...bounds, visible } }
}

/** What the person typed in the address bar as an address the browser opens: a scheme kept; a bare name of this
 *  machine (localhost, 127.x, [::1]) over http, any other over https; null when it is not an address at all. */
function addressOf(typed) {
  const text = String(typed || '').trim()
  if (!text || /\s/.test(text)) return null
  if (text === BROWSER_HOME) return text
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/:]+:\d+(\/|$)/.test(text) ? text : `${/^(localhost|127\.|\[::1\])/i.test(text) ? 'http' : 'https'}://${text}`
  try { return new URL(withScheme).href } catch { return null }
}

// what an element the person picked is, for the message they write to an agent: a selector that finds it again (its
// id when the page has one such, else tag and place among its kind, up to five levels), its tag, role and words —
// never what was typed: a field, an editable region, a text box / search box / combo box (or anything holding one)
// is named by its label or placeholder only
const PICK_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement
  if (!el) return null
  const doc = el.ownerDocument
  const esc = (v) => (doc.defaultView && doc.defaultView.CSS && doc.defaultView.CSS.escape ? doc.defaultView.CSS.escape(v) : v)
  const parts = []
  for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
    if (n.id) { let one = false; try { one = doc.querySelectorAll('#' + esc(n.id)).length === 1 } catch {} if (one) { parts.unshift('#' + esc(n.id)); break } }
    let part = n.tagName.toLowerCase()
    const up = n.parentElement
    if (up) { const kin = Array.from(up.children).filter((c) => c.tagName === n.tagName); if (kin.length > 1) part += ':nth-of-type(' + (kin.indexOf(n) + 1) + ')' }
    parts.unshift(part)
    if (n === doc.body || n === doc.documentElement) break
  }
  const typed = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], [role="searchbox"], [role="combobox"]'
  const holdsTyping = el.isContentEditable || el.matches(typed) || !!el.querySelector(typed)
  const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || ''
  const words = String(label || (holdsTyping ? '' : el.innerText || '')).trim().replace(/\\s+/g, ' ').slice(0, 200)
  const r = el.getBoundingClientRect()
  return { tag: el.tagName.toLowerCase(), selector: parts.join(' > '), role: el.getAttribute('role') || null, text: words, rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } }
}`
const PICK_MS = 120_000
/** A page's address without its query and fragment (they may hold a token or what was searched for). */
function pageAddress(url) {
  try { const u = new URL(url); return `${u.origin}${u.pathname}` } catch { return '' }
}

/** The person picks an element of the page (the DevTools' own inspect mode, drawn by the browser — nothing is put in
 *  the page, and the page's click handlers never see the pick): `{ promise, cancel }`, the promise resolving to what
 *  was picked, or null when the pick was cancelled, the page went elsewhere or nothing was picked in time. */
function pickElement(webContents, { log = () => {}, timeoutMs = PICK_MS } = {}) {
  const cdp = cdpOf(webContents, { log })
  if (!cdp) return { promise: Promise.resolve(null), cancel: () => {} }
  let settle = null
  let off = () => {}
  let timer = null
  let starting = Promise.resolve()
  // the mode is ended after it was started (a cancel at once must not leave the page in it)
  const end = async (value, { fromStart = false } = {}) => {
    if (!settle) return
    const done = settle
    settle = null
    off()
    clearTimeout(timer)
    if (!fromStart) await starting
    await cdp.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }).catch(() => undefined)
    await cdp.send('Overlay.disable').catch(() => undefined)
    done(value)
  }
  const promise = new Promise((resolve) => { settle = resolve })
  off = cdp.on((method, params) => {
    if (method === 'Overlay.inspectNodeRequested' && params && params.backendNodeId !== undefined) {
      void (async () => {
        let picked = null
        try {
          const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: params.backendNodeId, objectGroup: 'pick' })
          const { result } = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: PICK_FN, returnByValue: true })
          picked = result && result.value ? { ...result.value, url: pageAddress(webContents.getURL()), title: webContents.getTitle() } : null
        } catch (error) { log(`[computer] the picked element could not be read: ${error.message}`) }
        void cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'pick' }).catch(() => undefined)
        await end(picked)
      })()
    } else if (method === 'Page.frameNavigated' && params && params.frame && !params.frame.parentId) void end(null)
  })
  timer = setTimeout(() => void end(null), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  starting = (async () => {
    try {
      await cdp.send('DOM.enable')
      await cdp.send('Overlay.enable')
      await cdp.send('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: { showInfo: true, showStyles: false, contentColor: { r: 111, g: 168, b: 220, a: 0.35 }, borderColor: { r: 47, g: 111, b: 235, a: 0.9 }, paddingColor: { r: 147, g: 196, b: 125, a: 0.25 }, marginColor: { r: 246, g: 178, b: 107, a: 0.25 } } })
    } catch (error) {
      log(`[computer] the element picker did not start: ${error.message}`)
      await end(null, { fromStart: true })
    }
  })()
  return { promise, cancel: () => void end(null) }
}

/** The agent's own browser: views of a persistent profile of its own (a site the person signs in to on the card stays
 *  signed in for the agent — the profile is shared by every project and session), in tabs. A tab is the person's
 *  (opened on the card, `owner` null) or a run's (opened by the computer for that run, `owner` its run id — the
 *  backend's, never the page's or the model's words). The tab the Browser card shows (`active`) is the person's
 *  choice and nothing more: a run looks at and acts on its own tabs whichever one the card shows. Every tab lives in a
 *  hidden window of its own (the backstage's `windowFor`) at HIDDEN_BOUNDS from its first moment to its last: moving,
 *  resizing, covering or folding a card, or showing another tab on it, never changes a page's bounds, parent window
 *  or visibility, and two tabs draw and take input at the same time. The renderer fits the picture inside the card
 *  and maps input back to CSS pixels. A new window a page opens loads in the same tab (never another tab: a named
 *  window or a popup never reaches another run's page). `harnessPorts()` names the loopback ports of the harness
 *  itself: the browser neither opens nor calls them, and never sends the harness's sign-in cookie. `profile()` is the
 *  profile's session (BROWSER_PARTITION), for clearing it before a page opened. */
const MAX_TABS = 12
const MAX_TABS_PER_RUN = 4
const LABEL_CHARS = 60
function agentBrowser({ WebContentsView, host, stage = null, log = () => {}, harnessPorts = () => [], profile = () => null }) {
  const tabs = []                      // { id, view, owner, session, label, created_at, attachedTo, seated, ever }, in the order the tab strip shows them
  let active = null
  let made = 0
  // Every showing on the card, and every main-frame navigation of the tab shown, has its own identity: the card's
  // queued input never lands on another tab or a replacement document. (An agent's look is not bound to it: its tab's
  // own generation says whether that tab changed.)
  let shownCount = 0
  let place = { x: 0, y: 0, width: 0, height: 0, visible: false }
  // Card geometry belongs to the renderer; the browser's layout and capture size never follow it.
  const size = { width: HIDDEN_BOUNDS.width, height: HIDDEN_BOUNDS.height }
  const guarded = new WeakSet()
  const closedHooks = new Set()
  let holderOf = () => null
  // the person's Clear data under way: no tab opens (theirs or a run's) and no page loads until it is done
  let clearing = false
  const allows = (url) => browserAllows(url) && !harnessAddress(url, harnessPorts())
  const watch = placementWatch({ log })
  const onCard = () => place.visible
  const alive = (tab) => !!tab && !tab.closed && !tab.view.webContents.isDestroyed()
  const navigating = (wc) => { if (active && active.view.webContents === wc) shownCount += 1 }
  const labelOf = (label) => (typeof label === 'string' ? label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, LABEL_CHARS) || null : null)
  // the page is drawn at its own size: a zoom Chromium kept for a site (the profile remembers one per host — an
  // earlier version of the card zoomed the page out to fit) is taken back to 1 when the page comes in
  const unzoom = (wc) => { if (!wc.isDestroyed() && Math.abs(wc.getZoomFactor() - 1) > 0.001) wc.setZoomFactor(1) }
  /** The hidden window a tab lives in: its own (production), else the one backstage (a test's), else the app's. */
  const hostOf = (tab) => (stage ? (typeof stage.windowFor === 'function' ? stage.windowFor(tab.id) : stage.window()) : host())
  /** A tab put in its window at HIDDEN_BOUNDS, set only when something changed (its window was destroyed, say). */
  const seat = (tab) => {
    if (!alive(tab)) return
    const win = hostOf(tab)
    if (!win || win.isDestroyed()) return
    const out = seatPane(tab.view, { attachedTo: tab.attachedTo, seated: tab.seated, show: false, place, size, host: () => win, stage: stage ? { window: () => win } : null })
    tab.attachedTo = out.attachedTo
    tab.seated = out.seated
  }
  const cookieUrl = (c) => `${c.secure ? 'https' : 'http'}://${String(c.domain || '').replace(/^\./, '')}${c.path || '/'}`
  const guard = (session) => {
    if (guarded.has(session)) return
    guarded.add(session)
    session.webRequest.onBeforeRequest((details, done) => {
      const refused = harnessAddress(details.url, harnessPorts())
      if (refused) log(`[computer] the agent browser was kept from the harness's own address ${String(details.url).slice(0, 120)}`)
      done({ cancel: refused })
    })
    // the harness's sign-in cookie never stays in this profile (the person may have opened the harness on the card
    // before it was refused): removed at the start and whenever it is set. The headers are main.js's (a session has
    // one onBeforeSendHeaders listener): it marks every loopback request as the agent browser's.
    const drop = (cookie) => session.cookies.remove(cookieUrl(cookie), cookie.name).catch((error) => log(`[computer] removing a harness cookie failed: ${error.message}`))
    void session.cookies.get({ name: SESSION_COOKIE }).then((found) => Promise.all(found.map(drop))).catch(() => undefined)
    session.cookies.on('changed', (_event, cookie, _cause, removed) => { if (!removed && cookie.name === SESSION_COOKIE) void drop(cookie) })
  }
  const makeTab = (url = BROWSER_HOME, { owner = null, session = null, label = null } = {}) => {
    const view = new WebContentsView({ webPreferences: { partition: BROWSER_PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    view.setBackgroundColor('#ffffff')
    const wc = view.webContents
    guard(wc.session)
    wc.setWindowOpenHandler(({ url: next }) => {
      if (allows(next) && next !== BROWSER_HOME) void wc.loadURL(next).catch(() => undefined)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (event, next) => { if (!allows(next)) event.preventDefault() })
    wc.on('will-redirect', (event, next) => { if (!allows(next)) event.preventDefault() })
    // the tab's own document identity (for its agent's looks: whichever tab the card shows) moves at every main-frame
    // navigation's start and commit; the card's showing identity moves too when it is the tab shown
    let self = null
    const moved = () => { if (self) self.doc += 1; navigating(wc) }
    wc.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) moved() })
    // Start invalidates the previous page immediately; commit invalidates any frame captured while it loaded.
    wc.on('did-navigate', () => { moved(); unzoom(wc) })
    wc.on('did-navigate-in-page', (_event, _url, mainFrame) => { if (mainFrame) moved() })
    made += 1
    const tab = { id: `tab-${made}`, view, owner, session, label: labelOf(label), created_at: Date.now(), attachedTo: null, seated: null, ever: false, closed: false, doc: 0 }
    self = tab
    tabs.push(tab)
    // a page destroyed some other way (its process gone for good, the app closing) is a tab closed
    if (typeof wc.once === 'function') wc.once('destroyed', () => { if (!tab.closed) dropTab(tab) })
    unzoom(wc)
    seat(tab)
    void wc.loadURL(url).catch(() => undefined)
    if (made === 1) log('[computer] the agent browser opened')
    return tab
  }
  /** A tab gone: out of its window (and its window destroyed), its debugger let go, its page closed; told to those
   *  who keep something of it (the computer's looks, its surface's downloads). Its id is never used again. */
  const dropTab = (tab) => {
    if (tab.closed) return
    tab.closed = true
    const i = tabs.indexOf(tab)
    if (i >= 0) tabs.splice(i, 1)
    if (tab === active) active = null
    const wc = tab.view.webContents
    if (tab.attachedTo && !tab.attachedTo.isDestroyed()) tab.attachedTo.contentView.removeChildView(tab.view)
    tab.attachedTo = null
    try { const cdp = cdpOf(wc); if (cdp) cdp.close() } catch { /* the page is going */ }
    if (!wc.isDestroyed()) wc.close()
    if (stage && typeof stage.release === 'function') stage.release(tab.id)
    for (const hook of closedHooks) { try { hook(tab.id) } catch (error) { log(`[computer] after closing ${tab.id}: ${error.message}`) } }
  }
  /** The tab shown on the card becomes `tab` (the person's choice; no page moves or changes size). */
  const show = (tab) => {
    if (tab === active) return
    active = tab
    shownCount += 1
    if (tab && onCard()) tab.ever = true
  }
  const prune = () => { for (const tab of [...tabs]) if (!alive(tab)) dropTab(tab) }
  /** The tab the card shows (a blank one of the person's made when there is none). */
  const ensure = () => {
    prune()
    if (!alive(active) && clearing && !tabs.length) throw new Error("the browser's data is being cleared")
    if (!alive(active)) { active = null; show(tabs[0] || makeTab()) }
    // the backstage may have been closed and opened again: every page goes where it belongs now
    for (const tab of tabs) if (!tab.attachedTo || tab.attachedTo.isDestroyed()) { tab.attachedTo = null; tab.seated = null; seat(tab) }
    return active.view
  }
  const tabOf = (id) => tabs.find((t) => t.id === id && alive(t)) || null
  const tabLine = (t) => ({ id: t.id, url: t.view.webContents.getURL(), title: t.view.webContents.getTitle(), loading: t.view.webContents.isLoading(), active: t === active, owner: t.owner, session: t.session, owner_label: t.label, holder: t.owner ? holderOf(t.id) : null })
  const removeAll = () => { for (const tab of [...tabs]) dropTab(tab); active = null }
  return {
    contents: () => ensure().webContents,
    opened: () => alive(active),
    allows,
    /** The tab shown now, or null before the first. */
    activeTab: () => (alive(active) ? active.id : null),
    /** This showing/document of the tab shown. A switch or main-frame navigation of it invalidates the card's queued
     *  input; null before the first tab. */
    shownPage: () => (alive(active) ? `${active.id}#${shownCount}` : null),
    /** The card's visibility is kept for ownership and status; its dimensions never resize a browser view. */
    place(next) {
      watch(next)
      place = next
      if ((onCard() || alive(active)) && !clearing) ensure()
      if (onCard() && alive(active)) active.ever = true
    },
    /** Whether the tab shown is on the card now, and whether a tab ever was. */
    visibility: () => ({ shown: alive(active) && onCard(), ever: tabs.some((t) => t.ever) }),
    /** Whether a tab is on the card now, and whether it ever was (a page never shown draws only when looked at). */
    visibilityOf: (id) => { const tab = tabOf(id); return { shown: !!tab && tab === active && onCard(), ever: !!tab && tab.ever } },
    /** The fixed CSS viewport shared by screenshots and person/agent input. */
    size: () => ({ ...size }),
    /** A new tab of the person's, shown (blank, or at `url` when the browser may open it); null past MAX_TABS or for a
     *  refused address. */
    newTab(url = null) {
      const target = url === null ? BROWSER_HOME : addressOf(url)
      if (target === null || !allows(target) || clearing) return null
      prune()
      if (tabs.length >= MAX_TABS) return null
      const tab = makeTab(target)
      show(tab)
      return tab.id
    },
    /** A new tab of a run's own (blank, or at `url`): `{ id }`, or `{ refused, full }` when the browser (`full:
     *  'browser'`) or the run (`full: 'run'`) has as many tabs as it may, or the address is refused. It is not shown
     *  on the card unless the card shows nothing yet. Synchronous: the tab exists once this returns. */
    openAgentTab(owner, { session = null, label = null, url = null } = {}) {
      if (typeof owner !== 'string' || !owner) return { refused: 'an owner (the run) is required' }
      if (clearing) return { refused: "the person is clearing the browser's data; try again in a moment" }
      const target = url === null ? BROWSER_HOME : addressOf(url)
      if (target === null || !allows(target)) return { refused: `the browser does not open ${String(url).slice(0, 200)}` }
      prune()
      if (tabs.filter((t) => t.owner === owner).length >= MAX_TABS_PER_RUN) return { refused: `this run has ${MAX_TABS_PER_RUN} tabs open, as many as a run may: close one (tab_close) first`, full: 'run' }
      if (tabs.length >= MAX_TABS) return { refused: `the browser has ${MAX_TABS} tabs open, as many as it may (other runs' and the person's included): close one of this run's tabs (tab_close), or try again later`, full: 'browser' }
      const tab = makeTab(target, { owner, session, label })
      if (!alive(active)) show(tab)
      return { id: tab.id }
    },
    /** A run's tab handed to the next run of its session (its owner and label become that run's); false when there is
     *  no such agent tab or the run has as many tabs as it may. */
    adoptAgentTab(id, owner, { label = null } = {}) {
      const tab = tabOf(id)
      if (!tab || tab.owner === null || typeof owner !== 'string' || !owner) return false
      if (tab.owner !== owner && tabs.filter((t) => alive(t) && t.owner === owner).length >= MAX_TABS_PER_RUN) return false
      tab.owner = owner
      tab.label = labelOf(label)
      return true
    },
    /** The tab named shown on the card; false when there is no such tab. Nothing an agent looked at changes. */
    switchTab(id) {
      ensure()
      const tab = tabOf(id)
      if (!tab) return false
      show(tab)
      return true
    },
    /** The tab named closed (the person's close: the last one is replaced by a blank tab of theirs). */
    closeTab(id) {
      ensure()
      const tab = tabOf(id)
      if (!tab) return false
      const i = tabs.indexOf(tab)
      const next = tab === active ? (tabs[i + 1] || tabs[i - 1] || null) : active
      dropTab(tab)
      if (!alive(active)) show(next && alive(next) ? next : makeTab())
      return true
    },
    /** A tab closed by the computer (its run's tab_close, or idle): the card shows a neighbour, or nothing. */
    closeAgentTab(id) {
      const tab = tabOf(id)
      if (!tab) return false
      const i = tabs.indexOf(tab)
      const wasShown = tab === active
      const next = tabs[i + 1] || tabs[i - 1] || null
      dropTab(tab)
      if (wasShown && next && alive(next)) show(next)
      else if (wasShown) shownCount += 1
      return true
    },
    exists: (id) => tabOf(id) !== null,
    /** A tab's document as its agent's looks name it (`tab-3#d2`): another after a main-frame navigation of that tab
     *  began or committed — never after the card showed another tab. Null for a closed tab. */
    documentOf: (id) => { const tab = tabOf(id); return tab ? `${tab.id}#d${tab.doc}` : null },
    ownerOf: (id) => { const tab = tabOf(id); return tab ? tab.owner : null },
    contentsOf: (id) => { const tab = tabOf(id); return tab ? tab.view.webContents : null },
    tabIdOf: (wc) => { const tab = tabs.find((t) => t.view.webContents === wc); return tab && alive(tab) ? tab.id : null },
    /** A run's own tabs (only its own). */
    tabsOf: (owner) => tabs.filter((t) => alive(t) && t.owner === owner).map((t) => ({ id: t.id, url: t.view.webContents.getURL(), title: t.view.webContents.getTitle(), loading: t.view.webContents.isLoading() })),
    all: () => tabs.filter(alive).map((t) => ({ id: t.id, owner: t.owner, session: t.session, created_at: t.created_at })),
    onClosed: (fn) => { closedHooks.add(fn); return () => closedHooks.delete(fn) },
    /** Who holds a tab now (the computer's lease), for the card. */
    bindHolder: (fn) => { holderOf = fn },
    /** The address bar, back, forward, reload and stop of the tab shown: `{ ok, reason? }`. */
    navigate(action, url) {
      if (clearing) return { ok: false, reason: "the browser's data is being cleared" }
      const wc = ensure().webContents
      const nav = wc.navigationHistory
      if (action === 'go') {
        const target = addressOf(url)
        if (target === null) return { ok: false, reason: 'not an address' }
        if (!allows(target)) return { ok: false, reason: 'the browser does not open this address' }
        navigating(wc)
        void wc.loadURL(target).catch(() => undefined)
        return { ok: true, url: target }
      }
      if (action === 'back') { if (!nav.canGoBack()) return { ok: false, reason: 'no page to go back to' }; navigating(wc); nav.goBack(); return { ok: true } }
      if (action === 'forward') { if (!nav.canGoForward()) return { ok: false, reason: 'no page to go forward to' }; navigating(wc); nav.goForward(); return { ok: true } }
      if (action === 'reload') { navigating(wc); wc.reload(); return { ok: true } }
      if (action === 'stop') { wc.stop(); return { ok: true } }
      return { ok: false, reason: `unknown action ${action}` }
    },
    /** Every tab closed — every run's and the person's — and one blank tab of the person's shown, with no history. */
    async reset() {
      if (!tabs.some(alive) || clearing) return
      removeAll()
      show(makeTab())
    },
    /** The profile's cookies, site storage, HTTP cache and HTTP-auth cache cleared (`profile`: the BROWSER_PARTITION
     *  session, also before a page first opened), then every tab closed — each run's looks of them go with them — and
     *  one blank tab shown. */
    async clearData() {
      const open = tabs.find(alive)
      const target = open ? open.view.webContents.session : profile()
      if (!target) throw new Error("the agent browser's profile is not available")
      const had = tabs.some(alive)
      clearing = true
      try {
        // every page closed first: none keeps running (its scripts, its requests) to write cookies or storage back
        // while the profile is cleared
        removeAll()
        await target.clearStorageData()
        await target.clearCache()
        await target.clearAuthCache()
      } finally { clearing = false }
      if (had) show(makeTab())
    },
    /** Whether a Clear data is under way. */
    clearing: () => clearing,
    status() {
      if (!alive(active)) return { opened: false, url: null, title: null, loading: false, can_go_back: false, can_go_forward: false, tabs: tabs.filter(alive).map(tabLine), active_tab: null, shown_page: null }
      const wc = active.view.webContents
      const nav = wc.navigationHistory
      return { opened: true, url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), can_go_back: !!(nav && nav.canGoBack()), can_go_forward: !!(nav && nav.canGoForward()), tabs: tabs.filter(alive).map(tabLine), active_tab: active.id, shown_page: `${active.id}#${shownCount}` }
    },
    close() { removeAll() },
  }
}

/** The agent browser's tabs as one tabbed surface of the computer (see createComputer): a surface per tab, made on
 *  first use with `surfaceOf(tab, contents, browser)`, and the profile's one download listener, which hands a download
 *  to the tab whose page began it (Electron's will-download names that page) — never to the tab shown or a run's
 *  current tab; a download from a page no tab has (closed meanwhile) is cancelled. */
function browserTabs({ browser, surfaceOf, label = "the agent's browser", log = () => {} }) {
  const surfaces = new Map()             // tab id -> surface
  const heard = new WeakSet()            // the profiles listened to (one listener each, however many tabs)
  const closedHooks = new Set()
  const route = (item, from) => {
    const id = from ? browser.tabIdOf(from) : null
    const surface = id ? page(id) : null
    if (!surface) { try { item.cancel() } catch { /* gone */ } log('[computer] a download from a page no tab holds any more was cancelled'); return }
    surface.takeDownload(item)
  }
  const listeners = []                   // [session, listener]: taken off when the manager is disposed
  const listen = (wc) => {
    if (!wc || !wc.session || heard.has(wc.session) || typeof wc.session.on !== 'function') return
    heard.add(wc.session)
    const listener = (_event, item, from) => route(item, from)
    wc.session.on('will-download', listener)
    listeners.push([wc.session, listener])
  }
  function page(id) {
    if (!browser.exists(id)) return null
    let surface = surfaces.get(id)
    if (!surface) {
      const wc = browser.contentsOf(id)
      listen(wc)
      surface = surfaceOf(id, () => browser.contentsOf(id) || wc, () => browser.exists(id))
      surfaces.set(id, surface)
    }
    return surface
  }
  browser.onClosed((id) => {
    const surface = surfaces.get(id)
    surfaces.delete(id)
    if (surface && typeof surface.dispose === 'function') surface.dispose()
    for (const hook of closedHooks) hook(id)
  })
  return {
    tabbed: true,
    label,
    allowsUrl: browser.allows,
    open(owner, opts = {}) {
      const made = browser.openAgentTab(owner, opts)
      if (made && made.id) listen(browser.contentsOf(made.id))
      return made
    },
    page,
    exists: browser.exists,
    ownerOf: browser.ownerOf,
    adopt: (id, owner, opts) => browser.adoptAgentTab(id, owner, opts),
    tabsOf: browser.tabsOf,
    all: browser.all,
    close: (id) => browser.closeAgentTab(id),
    onClosed: (fn) => { closedHooks.add(fn); return () => closedHooks.delete(fn) },
    /** The surface of a tab without making it for a closed one (the person's input, the card's picture). */
    surfaces: () => surfaces.size,
    listen,
    /** The manager gone (the bridge closing): its download listener off the profile (a later manager's downloads are
     *  never routed — or cancelled — by this one), its tabs' surfaces disposed. */
    dispose() {
      for (const [session, listener] of listeners.splice(0)) if (typeof session.removeListener === 'function') session.removeListener('will-download', listener)
      for (const surface of surfaces.values()) if (typeof surface.dispose === 'function') surface.dispose()
      surfaces.clear()
    },
    listenerCount: () => listeners.length,
  }
}

/** Downloads older than a day, left by a run that never took them, are removed (at the app's start). */
function pruneDownloads(dir, maxAgeMs = 24 * 3600_000) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { return 0 }
  let removed = 0
  for (const name of names) {
    const file = path.join(dir, name)
    try { if (Date.now() - fs.statSync(file).mtimeMs > maxAgeMs) { fs.rmSync(file, { force: true, recursive: true }); removed += 1 } } catch { /* gone */ }
  }
  return removed
}

module.exports = { browserInputCommand, browserTabs, placementWatch, pruneDownloads, MAX_DOWNLOAD_BYTES, MAX_TABS_PER_RUN, agentBrowser, addressOf, backstage, browserAllows, harnessAddress, cdpDriver, electronSurface, ownInput, jpegSize, keyOf, pickElement, seatPane, seatView, BROWSER_DEVICE_SCALE, BROWSER_PARTITION, HIDDEN_BOUNDS, MAX_TABS, SESSION_COOKIE }
