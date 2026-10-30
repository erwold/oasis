/** The isolated HTML preview's rules (state/uiSandbox.ts) without a browser: the document the frame gets, the bridge
 *  checks, the budgets, the watchdog. The browser's own part (what the sandbox and the CSP block) is measured in
 *  e2e/intelligent-ui-sandbox.e2e.ts. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { parseUiSurfaceSpec, UI_ID_PATTERN, UI_LIMITS, UI_RESERVED_KEYS, validateUiState } from '@oasis-code/contract'
import {
  actionIdOk, STOP_REASON_TEXT, buildSrcdoc, checkBridgeMessage, checkState, clampHeight, htmlTooLarge, judgeAction, makeNonce, MessageBudget,
  pingMessage, sanitizeInitialState, scriptJson, themeMessage, UI_SANDBOX_ALLOW, UI_SANDBOX_ATTR, UI_SANDBOX_CHANNEL, UI_SANDBOX_CSP,
  UI_SANDBOX_LIMITS, UI_SANDBOX_VERSION, watchdogVerdict, judgeRun, taskMessage,
} from '../src/state/uiSandbox.ts'
import { UI_BASE_STYLE, uiThemeDeclarations, type UiHostTheme } from '../src/state/uiTheme.ts'
import { createSurfaceTasks, type TaskRunEvent } from '../src/state/uiTasks.ts'

const NONCE = 'a'.repeat(32)
const msg = (type: string, payload: unknown, over: Record<string, unknown> = {}) =>
  ({ channel: UI_SANDBOX_CHANNEL, v: UI_SANDBOX_VERSION, nonce: NONCE, type, payload, ...over })

test('the frame may run scripts and nothing else: no same-origin, popups, forms, downloads or top navigation', () => {
  assert.equal(UI_SANDBOX_ATTR, 'allow-scripts')
  for (const token of ['allow-same-origin', 'allow-top-navigation', 'allow-popups', 'allow-forms', 'allow-downloads', 'allow-modals'])
    assert.ok(!UI_SANDBOX_ATTR.includes(token), token)
  for (const feature of ['camera', 'microphone', 'geolocation', 'clipboard-read', 'payment']) assert.match(UI_SANDBOX_ALLOW, new RegExp(`${feature} 'none'`))
})

test("the CSP: nothing by default, inline script and style only, no eval, no connections, no remote images, base and form named", () => {
  const directives = new Map(UI_SANDBOX_CSP.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k!, v.join(' ')]))
  assert.equal(directives.get('default-src'), "'none'")
  assert.equal(directives.get('script-src'), "'unsafe-inline'")
  assert.equal(directives.get('style-src'), "'unsafe-inline'")
  assert.equal(directives.get('img-src'), 'data:')
  for (const d of ['connect-src', 'frame-src', 'child-src', 'worker-src', 'object-src', 'font-src', 'media-src', 'base-uri', 'form-action'])
    assert.equal(directives.get(d), "'none'", d)
  assert.ok(!UI_SANDBOX_CSP.includes('unsafe-eval'))
  assert.ok(!/https?:|\*|'self'/.test(UI_SANDBOX_CSP), 'no host source anywhere')
  assert.ok(!UI_SANDBOX_CSP.includes('"'), 'fits in a double-quoted attribute')
})

test('the document puts the CSP first, then the bootstrap, and the model HTML only after both', () => {
  const html = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><script>alert(1)</script></head><body>hi</body></html>'
  const doc = buildSrcdoc(html, { nonce: NONCE, state: { a: 1 } })
  const csp = doc.indexOf('http-equiv="Content-Security-Policy"')
  const firstScript = doc.indexOf('<script')
  assert.ok(csp > 0 && csp < firstScript, 'the policy precedes every script')
  assert.ok(doc.indexOf('x-dns-prefetch-control') < firstScript)
  assert.ok(doc.endsWith(html), 'the HTML as it was, at the end')
  assert.equal(doc.indexOf(html), doc.length - html.length)
  assert.throws(() => buildSrcdoc('x', { nonce: 'short', state: {} }), /nonce/)
  assert.throws(() => buildSrcdoc('x', { nonce: `${NONCE.slice(1)}"`, state: {} }), /nonce/)
})

test('a state that tries to close the bootstrap element stays a string inside it', () => {
  const evil = '</script><script>parent.postMessage("x","*")</script><!--'
  const doc = buildSrcdoc('', { nonce: NONCE, state: { note: evil, 'a\u2028': 'x' } as never })
  const boot = doc.slice(doc.indexOf('<script>') + 8, doc.indexOf('</script>'))
  assert.ok(!boot.includes('</script'), 'no closing tag inside the bootstrap')
  assert.ok(!boot.includes('<!--'))
  assert.equal(doc.split('</script>').length, 2, 'exactly one script element before the HTML')
  assert.equal(scriptJson('\u2028<&>'), '"\\u2028\\u003c\\u0026\\u003e"')
  assert.equal(JSON.parse(scriptJson({ s: evil })).s, evil)
})

test('a nonce per frame: 128 random bits, hex, never repeated', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 2000; i++) { const n = makeNonce(); assert.match(n, /^[0-9a-f]{32}$/); seen.add(n) }
  assert.equal(seen.size, 2000)
})

test("the bounds are the contract's own, not a copy", () => {
  assert.equal(UI_SANDBOX_LIMITS.htmlChars, UI_LIMITS.htmlChars)
  assert.equal(UI_SANDBOX_LIMITS.stateKeys, UI_LIMITS.stateKeys)
  assert.equal(UI_SANDBOX_LIMITS.stateArray, UI_LIMITS.stateArray)
  assert.equal(UI_SANDBOX_LIMITS.stringChars, UI_LIMITS.stringChars)
  assert.equal(UI_SANDBOX_LIMITS.stateChars, UI_LIMITS.stateChars)
  const doc = buildSrcdoc('', { nonce: NONCE, state: {} })
  assert.ok(doc.includes(JSON.stringify(UI_ID_PATTERN.source).replace(/</g, '\\u003c')), 'the bootstrap carries the contract id pattern')
  for (const k of UI_RESERVED_KEYS) assert.ok(doc.includes(JSON.stringify(k)), `the bootstrap refuses ${k}`)
})

const x4000 = 'x'.repeat(4000)
/** what the API takes: the contract's own validateUiState (its checkUiJson preguard, UiStateSchema, the key count,
 *  the JSON size) for an html surface — the real function, not a restatement of its rules */
const HTML_SPEC = (() => {
  const parsed = parseUiSurfaceSpec({ version: 1, surface_id: 'probe', title: 'Probe', fallback: 'probe', kind: 'html', html: '<p>probe</p>' })
  assert.ok(parsed.ok, 'the probe spec parses')
  return parsed.value
})()
const contractTakes = (v: unknown) => validateUiState(HTML_SPEC, v).ok
/** a corpus at and around every bound */
const corpus: Array<[string, unknown]> = [
  ['scalars and arrays', { a: 1, b: 'x', c: true, d: null, e: [1, 'two', false, null] }],
  ['null kept', { maybe: null, list: [null, null] }],
  ['empty', {}],
  ['a 4000-character string', { a: x4000 }],
  ['a 4001-character string', { a: x4000 + 'x' }],
  ['three 4000-character strings (12 KB of JSON)', { a: x4000, b: x4000, c: x4000 }],
  ['five 4000-character strings: over 16000 as JSON', { a: x4000, b: x4000, c: x4000, d: x4000, e: x4000 }],
  ['four 3990-character strings', { a: 'y'.repeat(3990), b: 'y'.repeat(3990), c: 'y'.repeat(3990), d: 'y'.repeat(3990) }],
  ['escapes push it over (3 × 3000 quotes)', { a: '"'.repeat(3000), b: '"'.repeat(3000), c: '"'.repeat(3000) }],
  ['100 items', { a: Array.from({ length: 100 }, (_, i) => i) }],
  ['101 items', { a: Array.from({ length: 101 }, (_, i) => i) }],
  ['an array of strings over the budget', { a: Array.from({ length: 100 }, () => 'z'.repeat(200)) }],
  ['64 keys', Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`k${i}`, i]))],
  ['65 keys', Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i]))],
  ['a 64-character key', { ['k'.repeat(64)]: 1 }],
  ['a 65-character key', { ['k'.repeat(65)]: 1 }],
  ['ok-key_1', { 'ok-key_1': 1 }],
  ['a dot', { 'a.b': 1 }], ['a leading underscore', { _a: 1 }], ['a leading digit', { '1a': 1 }], ['a dollar', { $a: 1 }],
  ['a space', { 'a b': 1 }], ['empty key', { '': 1 }],
  ...UI_RESERVED_KEYS.map((k): [string, unknown] => [`reserved ${k}`, JSON.parse(`{${JSON.stringify(k)}: 1}`)]),
  ['nested object', { a: { b: 1 } }], ['nested array', { a: [[1]] }], ['object in array', { a: [{}] }],
  ['NaN', { a: Number.NaN }], ['Infinity', { a: Infinity }], ['undefined', { a: undefined }],
]

test("state: the host takes exactly what the contract takes, at every bound", () => {
  for (const [name, v] of corpus) assert.equal(checkState(v).ok, contractTakes(v), name)
  // and the ones the contract does take come back whole, nulls included
  assert.deepEqual(checkState({ maybe: null, list: [null, 1] }), { ok: true, value: { maybe: null, list: [null, 1] } })
  assert.deepEqual(checkState({ a: x4000, b: x4000, c: x4000, d: x4000, e: x4000 }), { ok: false, reason: `state is more than ${UI_LIMITS.stateChars} characters as JSON` })
  for (const bad of [null, [], 'x', new Date(), new Map(), { a: 1n }, { a: () => 1 }, { a: [1, , 3] }, { [Symbol('s')]: 1 }])
    assert.equal(checkState(bad).ok, false, String(bad))
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.equal(checkState(Object.assign(Object.create(null), { a: 1 })).ok, true)
})

test('a state far over the budget is refused while it is walked, before any serialization', () => {
  // 64 keys of 100 strings of 4000 characters: 25.6 M characters if serialized — refused at the fifth string
  const huge = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`k${i}`, Array.from({ length: 100 }, () => x4000)]))
  const stringify = JSON.stringify
  let calls = 0
  JSON.stringify = ((...args: Parameters<typeof stringify>) => { calls++; return stringify(...args) }) as typeof JSON.stringify
  try {
    const t = performance.now()
    assert.equal(checkState(huge).ok, false)
    assert.equal(calls, 0, 'no JSON.stringify of a state known to be too large')
    assert.ok(performance.now() - t < 50)
  } finally { JSON.stringify = stringify }
})

test('the initial state keeps what the contract allows, in order, within the whole budget; the rest is dropped and counted', () => {
  assert.deepEqual(sanitizeInitialState({ a: 1, b: { nested: true }, c: 'x', _x: 1, 'bad key': 2, d: null }), { state: { a: 1, c: 'x', d: null }, dropped: 3 })
  assert.deepEqual(sanitizeInitialState(undefined), { state: {}, dropped: 0 })
  assert.deepEqual(sanitizeInitialState('x'), { state: {}, dropped: 1 })
  const many = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`k${i}`, i]))
  const s = sanitizeInitialState(many)
  assert.equal(Object.keys(s.state).length, UI_SANDBOX_LIMITS.stateKeys)
  assert.equal(s.dropped, 70 - UI_SANDBOX_LIMITS.stateKeys)
  const big = sanitizeInitialState({ a: x4000, b: x4000, c: x4000, d: x4000, e: 1 })
  assert.deepEqual(Object.keys(big.state), ['a', 'b', 'c', 'e'], 'the fourth string would break the budget; the small one after it still fits')
  assert.equal(big.dropped, 1)
  assert.ok(contractTakes(big.state))
})

test('a bridge message: exactly the envelope, this nonce, a known type, exactly its payload', () => {
  assert.deepEqual(checkBridgeMessage(msg('ready', {}), NONCE), { ok: true, value: { type: 'ready' } })
  assert.deepEqual(checkBridgeMessage(msg('loaded', {}), NONCE), { ok: true, value: { type: 'loaded' } })
  assert.deepEqual(checkBridgeMessage(msg('navigating', {}), NONCE), { ok: true, value: { type: 'navigating' } })
  assert.deepEqual(checkBridgeMessage(msg('pong', { seq: 3 }), NONCE), { ok: true, value: { type: 'pong', seq: 3 } })
  assert.deepEqual(checkBridgeMessage(msg('resize', { height: 200.5 }), NONCE), { ok: true, value: { type: 'resize', height: 200.5 } })
  assert.deepEqual(checkBridgeMessage(msg('state', { state: { total: 3 } }), NONCE), { ok: true, value: { type: 'state', state: { total: 3 } } })
  assert.deepEqual(checkBridgeMessage(msg('action', { actionId: 'submit', state: {}, gesture: true }), NONCE),
    { ok: true, value: { type: 'action', actionId: 'submit', state: {}, gesture: true } })
  const refused: Array<[unknown, string]> = [
    [null, 'not an object'], ['ready', 'not an object'], [[msg('ready', {})], 'not an object'],
    [{ ...msg('ready', {}), extra: 1 }, 'envelope keys'], [{ channel: UI_SANDBOX_CHANNEL, v: 1, nonce: NONCE, type: 'ready' }, 'envelope keys'],
    [msg('ready', {}, { channel: 'other' }), 'channel'], [msg('ready', {}, { v: 1 }), 'version'], [msg('ready', {}, { v: 3 }), 'version'], [msg('ready', {}, { v: '2' }), 'version'],
    [msg('ready', {}, { nonce: 'b'.repeat(32) }), 'nonce'], [msg('ready', {}, { nonce: NONCE.toUpperCase() }), 'nonce'],
    [msg('tool_call', {}), 'type'], [msg('send', { text: 'hi' }), 'type'], [msg('toString', {}), 'type'], [msg('__proto__', {}), 'type'],
    [msg('ready', []), 'payload'], [msg('ready', { x: 1 }), 'payload keys'],
    [msg('pong', { seq: -1 }), 'seq'], [msg('pong', { seq: 1.5 }), 'seq'], [msg('resize', { height: Infinity }), 'height'],
    [msg('state', { state: { a: { b: 1 } } }), 'state.a is not a bounded scalar or scalar array'],
    [msg('state', { state: {}, run_id: 'r1' }), 'payload keys'], [msg('action', { actionId: 'go', state: {}, gesture: true, model: 'x' }), 'payload keys'],
    [msg('action', { actionId: 'go now', state: {}, gesture: true }), 'action id'], [msg('action', { actionId: '', state: {}, gesture: true }), 'action id'],
    [msg('action', { actionId: 'a'.repeat(65), state: {}, gesture: true }), 'action id'], [msg('action', { actionId: 'go', state: {}, gesture: 'yes' }), 'gesture'],
  ]
  for (const [data, reason] of refused) assert.deepEqual(checkBridgeMessage(data, NONCE), { ok: false, reason }, JSON.stringify(data))
  // an instance without a well-formed nonce of its own accepts nothing
  assert.equal(checkBridgeMessage(msg('ready', {}, { nonce: '' }), '').ok, false)
  assert.ok(actionIdOk('approve_plan-v2') && !actionIdOk('approve:plan') && !actionIdOk('-x') && !actionIdOk('_x') && !actionIdOk('toString') && !actionIdOk(3))
})

test('an action passes only on a click in the preview, a declared id, the host still activated, not too fast', () => {
  const base = { hostActive: true, allowed: ['apply'], now: 10_000, lastActionAt: null }
  assert.equal(judgeAction({ actionId: 'apply', gesture: true }, base).ok, true)
  assert.deepEqual(judgeAction({ actionId: 'apply', gesture: false }, base), { ok: false, reason: 'action without a click in the preview' })
  assert.deepEqual(judgeAction({ actionId: 'apply', gesture: true }, { ...base, hostActive: false }), { ok: false, reason: 'action without user activation' })
  assert.equal(judgeAction({ actionId: 'apply', gesture: true }, { ...base, hostActive: null }).ok, true, 'an engine without userActivation: the frame flag stands')
  assert.deepEqual(judgeAction({ actionId: 'delete_all', gesture: true }, base), { ok: false, reason: 'unknown action delete_all' })
  assert.equal(judgeAction({ actionId: 'anything', gesture: true }, { ...base, allowed: null }).ok, true)
  assert.deepEqual(judgeAction({ actionId: 'apply', gesture: true }, { ...base, lastActionAt: 10_000 - UI_SANDBOX_LIMITS.actionIntervalMs + 1 }), { ok: false, reason: 'actions too fast' })
  assert.equal(judgeAction({ actionId: 'apply', gesture: true }, { ...base, lastActionAt: 10_000 - UI_SANDBOX_LIMITS.actionIntervalMs }).ok, true)
})

test('the message budget takes a window’s worth, drops the excess, calls a flood a flood, and starts over', () => {
  const b = new MessageBudget({ messagesPerWindow: 3, floodPerWindow: 6, windowMs: 1000 })
  assert.deepEqual([0, 1, 2, 3, 4].map((t) => b.take(t)), ['take', 'take', 'take', 'drop', 'drop'])
  assert.equal(b.take(5), 'flood')
  assert.equal(b.take(1005), 'take', 'a new window')
  assert.equal(new MessageBudget().take(0), 'take', 'the first message at time zero is in a window')
})

test('the watchdog: a held thread, a frame that never started, a frame that stopped answering', () => {
  const L = UI_SANDBOX_LIMITS
  assert.equal(watchdogVerdict({ now: 1000, lastTick: 0, startedAt: 0, ready: true, lastPong: 900 }), null)
  assert.equal(watchdogVerdict({ now: L.heartbeatMs + L.stallMs + 1, lastTick: 0, startedAt: 0, ready: true, lastPong: 0 }), 'stalled')
  assert.equal(watchdogVerdict({ now: L.readyMs + 1, lastTick: L.readyMs - 900, startedAt: 0, ready: false, lastPong: null }), 'no-ready')
  assert.equal(watchdogVerdict({ now: L.readyMs - 1, lastTick: L.readyMs - 900, startedAt: 0, ready: false, lastPong: null }), null)
  assert.equal(watchdogVerdict({ now: 10_000, lastTick: 9_500, startedAt: 0, ready: true, lastPong: 10_000 - L.unresponsiveMs - 1 }), 'unresponsive')
  assert.equal(clampHeight(5), L.minHeight)
  assert.equal(clampHeight(99_999), L.maxHeight)
  assert.equal(clampHeight(Number.NaN), L.defaultHeight)
  assert.equal(htmlTooLarge('中'.repeat(UI_LIMITS.htmlChars)), false, 'UTF-16 code units, as the contract counts: Chinese is not penalized')
  assert.equal(htmlTooLarge('x'.repeat(UI_LIMITS.htmlChars + 1)), true)
  assert.deepEqual(pingMessage(NONCE, 4), { channel: UI_SANDBOX_CHANNEL, v: 2, nonce: NONCE, type: 'ping', payload: { seq: 4 } })
})

/** The bootstrap in a bare context: a window whose parent records what it is sent. Only the logic is exercised
 *  here (the browser's sandbox is the e2e's); nothing of the host runs it. */
function bootFrame(state: Record<string, unknown> = {}, active = false, opts: { theme?: UiHostTheme; cssom?: boolean; timers?: Array<() => void> } = {}) {
  const sent: Array<{ data: Record<string, unknown>; target: string }> = []
  const listeners: Record<string, Array<(e: unknown) => void>> = {}
  const parent = { postMessage: (data: Record<string, unknown>, target: string) => sent.push({ data: structuredClone(data), target }) }
  class UserActivation { get isActive() { return active } }
  const removed: string[] = []
  /** a CSSOM just big enough for the theme rule: every setProperty / removeProperty the bootstrap makes is recorded */
  const cssom: Array<[string, string, string?]> = []
  const rules: Array<{ selector: string; style: unknown }> = []
  const appended: string[] = []
  class CSSStyleDeclaration {
    setProperty(p: string, v: string) { cssom.push(['set', p, v]) }
    removeProperty(p: string) { cssom.push(['remove', p]) }
  }
  const sheet = { cssRules: rules, insertRule: (selector: string, i: number) => { rules.splice(i, 0, { selector, style: new CSSStyleDeclaration() }); return i } }
  /** the event classes as a browser has them: data and source as prototype getters, stopImmediatePropagation on
   *  Event.prototype, isTrusted an unforgeable own property; post() dispatches like the browser does (listeners in
   *  order, window.event set during each, stopped by the native stopImmediatePropagation only) */
  const stopped = new WeakSet<object>()
  class Event { stopImmediatePropagation() { stopped.add(this) } }
  class MessageEvent extends Event {
    readonly type = 'message'
    #data: unknown
    #source: unknown
    constructor(data: unknown, source: unknown, trusted: boolean) {
      super(); this.#data = data; this.#source = source
      Object.defineProperty(this, 'isTrusted', { value: trusted, enumerable: true, configurable: false, writable: false })
    }
    get data() { return this.#data }
    get source() { return this.#source }
  }
  const dom = opts.cssom ? {
    head: { appendChild: (el: { tag: string }) => appended.push(el.tag) },
    createElement: (tag: string) => ({ tag, sheet }),
  } : {}
  const win: Record<string, unknown> = {
    parent, navigator: { userActivation: new UserActivation() },
    // the frame's own timers: at once by default; held for the test to run (as their own tasks) when it asks
    setTimeout: (f: () => void) => { if (opts.timers) opts.timers.push(f); else f(); return 1 }, clearTimeout: () => undefined,
    addEventListener: (type: string, f: (e: unknown) => void) => { (listeners[type] ??= []).push(f) },
    document: { currentScript: { remove: () => removed.push('script') }, documentElement: null, body: null, ...dom },
    ...(opts.cssom ? { CSSStyleDeclaration } : {}),
    MutationObserver: class { observe() { /* no DOM */ } },
    RTCPeerConnection: class {},
    Event, MessageEvent,
  }
  win.window = win
  const doc = buildSrcdoc('', { nonce: NONCE, state: state as never, ...(opts.theme ? { theme: opts.theme } : {}) })
  const code = doc.slice(doc.indexOf('<script>') + 8, doc.indexOf('</script>'))
  const ctx = vm.createContext(win)
  vm.runInContext(code, ctx)
  /** a message as the browser delivers it: its data structured-cloned into the frame's realm (so the frame's own
   *  prototypes are its prototypes), from `source`; trusted unless the frame made it itself */
  const parse = vm.runInContext('JSON.parse', ctx) as (s: string) => unknown
  const post = (source: unknown, data: unknown, trusted = true) => {
    const e = new MessageEvent(data === undefined ? undefined : parse(JSON.stringify(data)), source, trusted)
    for (const l of [...(listeners.message ?? [])]) {
      win.event = e
      try { l(e) } finally { win.event = undefined }
      if (stopped.has(e)) break
    }
  }
  return { win, sent, listeners, removed, ctx, cssom, rules, appended, post }
}

test('the bootstrap: says ready, removes its element, hides the nonce, exposes only oasisUI, takes WebRTC away', () => {
  const f = bootFrame({ total: 5 })
  assert.deepEqual(f.sent[0], { data: { channel: UI_SANDBOX_CHANNEL, v: 2, nonce: NONCE, type: 'ready', payload: {} }, target: '*' })
  assert.deepEqual(f.removed, ['script'])
  // its own document's load is reported; a load event of an element inside it (seen in capture) is not
  const onLoad = f.listeners.load![0]!
  onLoad({ target: {} })
  onLoad({ target: f.win.document })
  assert.deepEqual(f.sent.filter((s) => s.data.type === 'loaded').length, 1)
  assert.equal(vm.runInContext('typeof NONCE', f.ctx), 'undefined', 'the nonce is the closure\'s')
  assert.equal(vm.runInContext('RTCPeerConnection', f.ctx), undefined)
  assert.equal(vm.runInContext('(() => { try { RTCPeerConnection = class {}; } catch (e) {} return RTCPeerConnection })()', f.ctx), undefined, 'not put back')
  assert.deepEqual(vm.runInContext('JSON.stringify(oasisUI.getState())', f.ctx), '{"total":5}')
  assert.equal(vm.runInContext('Object.isFrozen(oasisUI)', f.ctx), true)
  assert.equal(vm.runInContext('(() => { try { window.oasisUI = 1 } catch (e) {} return typeof oasisUI.setState })()', f.ctx), 'function')
  assert.ok(!vm.runInContext('oasisUI.action.toString() + oasisUI.setState.toString()', f.ctx).includes(NONCE))
  // a message from the parent with this nonce gets a pong; one from anywhere else, or with another nonce, nothing
  f.post(f.win.parent, pingMessage(NONCE, 7))
  f.post({}, pingMessage(NONCE, 8))
  f.post(f.win.parent, pingMessage('b'.repeat(32), 9))
  assert.deepEqual(f.sent.filter((s) => s.data.type === 'pong').map((s) => s.data.payload), [{ seq: 7 }])
})

test('the bootstrap refuses what the host would refuse, before it is sent', async () => {
  const f = bootFrame()
  const tryState = (expr: string) => vm.runInContext(`(() => { try { oasisUI.setState(${expr}); return 'ok' } catch (e) { return e.name } })()`, f.ctx)
  assert.equal(tryState('{ a: 1, b: [1, "x", null] }'), 'ok')
  for (const expr of ['{ a: { b: 1 } }', '{ a: NaN }', '{ "bad key": 1 }', 'JSON.parse(\'{"__proto__": 1}\')', '{ constructor: 1 }', '{ toString: 1 }',
    '{ _a: 1 }', '{ "a.b": 1 }', '{ a: "x".repeat(4001) }', '[1]', 'null', '{ a: new Array(101).fill(0) }',
    '{ a: "x".repeat(4000), b: "x".repeat(4000), c: "x".repeat(4000), d: "x".repeat(4000), e: "x".repeat(4000) }'])
    assert.notEqual(tryState(expr), 'ok', expr)
  // the budget is the merged state's: patches that each fit, together do not
  assert.equal(tryState('{ p: "x".repeat(4000) }'), 'ok')
  assert.equal(tryState('{ q: "x".repeat(4000) }'), 'ok')
  assert.equal(tryState('{ r: "x".repeat(4000) }'), 'ok')
  assert.equal(tryState('{ s: "x".repeat(4000) }'), 'RangeError')
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(Object.keys(oasisUI.getState()))', f.ctx)), ['a', 'b', 'p', 'q', 'r'], 'the refused patch changed nothing')
  assert.equal(tryState('{ a: null }'), 'ok')
  assert.equal(vm.runInContext('oasisUI.getState().a', f.ctx), null, 'null kept')
  await new Promise((r) => setImmediate(r))
  const states = f.sent.filter((s) => s.data.type === 'state')
  assert.equal(states.length, 1, 'the changes of one task go out as one message, at the end of the task')
  assert.deepEqual(states[0]!.data.payload, { state: { a: null, b: [1, 'x', null], p: 'x'.repeat(4000), q: 'x'.repeat(4000), r: 'x'.repeat(4000) } })
  for (const s of f.sent) assert.equal(checkBridgeMessage(s.data, NONCE).ok, true, JSON.stringify(s.data))
})

test('the bootstrap reports whether the person clicked; the host decides', () => {
  const idle = bootFrame({ n: 1 }, false)
  assert.equal(vm.runInContext('oasisUI.action("apply")', idle.ctx), false)
  const clicked = bootFrame({ n: 1 }, true)
  assert.equal(vm.runInContext('oasisUI.action("apply")', clicked.ctx), true)
  const [a, b] = [idle, clicked].map((f) => f.sent.find((s) => s.data.type === 'action')!.data)
  assert.deepEqual(a!.payload, { actionId: 'apply', state: { n: 1 }, gesture: false })
  assert.deepEqual(b!.payload, { actionId: 'apply', state: { n: 1 }, gesture: true })
  // the model's code overriding the getter after the bootstrap ran changes nothing
  vm.runInContext('Object.defineProperty(Object.getPrototypeOf(navigator.userActivation), "isActive", { get: () => true })', idle.ctx)
  assert.equal(vm.runInContext('oasisUI.action("apply")', idle.ctx), false)
})

test('the bootstrap and the host agree with the contract on the whole corpus', () => {
  for (const [name, v] of corpus) {
    const f = bootFrame()
    f.ctx.candidate = v
    const frameTakes = vm.runInContext('(() => { try { oasisUI.setState(candidate); return true } catch (e) { return false } })()', f.ctx)
    // the frame's own check sees what the model wrote; a value structured clone would not carry (undefined) is not
    // sent anyway, so only compare where the contract's verdict is defined on the same value
    assert.equal(frameTakes, contractTakes(v), name)
    assert.equal(checkState(v).ok, contractTakes(v), name)
  }
})

const DARK: UiHostTheme = {
  scheme: 'dark',
  tokens: { '--ink': 'oklch(0.93 0.003 264)', '--accent': 'oklch(0.68 0.17 254)', '--shadow-card': '0 0 0 1px oklch(0.29 0.006 264), 0 1px 2px oklch(0 0 0 / 0.3)', '--radius-sm': '8px', '--font-mono': '"JetBrains Mono", ui-monospace, monospace' },
  typography: { family: 'Inter, -apple-system, sans-serif', size: '13.5px', lineHeight: '1.5', letterSpacing: '-0.01em' },
}
const LIGHT: UiHostTheme = { scheme: 'light', tokens: { '--ink': 'oklch(0.247 0.006 258.361)' }, typography: { size: '14px' } }
const applied = (calls: Array<[string, string, string?]>) => calls.map(([op, p, v]): [string, string | null] => [p, op === 'set' ? v! : null])

test('the document: CSP, then the base stylesheet as it is, then the bootstrap; the theme only as JSON inside the bootstrap', () => {
  const evil = { scheme: 'dark', tokens: { '--ink': '</style><script>alert(1)</script>', '--accent': 'red;}*{display:none' }, typography: {} } as unknown as UiHostTheme
  for (const theme of [undefined, DARK, evil]) {
    const doc = buildSrcdoc('<p>hi</p>', { nonce: NONCE, state: {}, ...(theme ? { theme } : {}) })
    const csp = doc.indexOf('http-equiv="Content-Security-Policy"')
    const style = doc.indexOf('<style>')
    const script = doc.indexOf('<script>')
    assert.ok(csp > 0 && csp < style && style < script, 'CSP, style, script')
    assert.equal(doc.slice(style + 7, doc.indexOf('</style>')), UI_BASE_STYLE, 'the stylesheet is the constant: no theme value in CSS text')
    assert.equal(doc.split('<style').length, 2)
    assert.equal(doc.split('</script>').length, 2)
    assert.ok(!doc.includes('alert(1)') && !doc.includes('display:none'), 'a value the checks refuse is not even carried')
    assert.ok(doc.endsWith('<p>hi</p>'))
  }
  // the same run with another theme: only the bootstrap's JSON differs (the host sends later changes as messages)
  const a = buildSrcdoc('x', { nonce: NONCE, state: {}, theme: DARK }), b = buildSrcdoc('x', { nonce: NONCE, state: {}, theme: LIGHT })
  assert.notEqual(a, b)
  assert.ok(!UI_SANDBOX_CSP.includes('font-src data') && UI_SANDBOX_CSP.includes("font-src 'none'"), 'no font is loaded for the theme')
})

test('the bootstrap applies the initial theme through the CSSOM before it says ready, on a :where(:root) rule after the base stylesheet', () => {
  const f = bootFrame({ n: 1 }, false, { theme: DARK, cssom: true })
  assert.deepEqual(f.appended, ['style'], 'one style element of its own')
  assert.deepEqual(f.rules.map((r) => r.selector), [':where(:root){}'])
  assert.deepEqual(applied(f.cssom), uiThemeDeclarations(DARK), 'exactly the declarations the host computes, nothing else')
  assert.equal(f.sent[0]!.data.type, 'ready')
  // no theme given: the rule exists (later messages land on it) and nothing is set — the stylesheet's fallbacks stand
  const bare = bootFrame({}, false, { cssom: true })
  assert.deepEqual(bare.cssom, [])
  assert.deepEqual(bare.rules.map((r) => r.selector), [':where(:root){}'])
})

test('a theme message from the parent with this nonce re-themes in place; anything else is ignored', () => {
  const f = bootFrame({ n: 1 }, false, { theme: DARK, cssom: true })
  vm.runInContext('oasisUI.setState({ n: 2, note: "kept" })', f.ctx)
  const before = f.cssom.length
  const m = themeMessage(NONCE, LIGHT)
  assert.deepEqual(Object.keys(m).sort(), ['channel', 'nonce', 'payload', 'type', 'v'])
  assert.deepEqual(m.payload, { theme: LIGHT })
  const ignored: unknown[] = [
    { ...m, nonce: 'b'.repeat(32) }, { ...m, v: 1 }, { ...m, v: 3 }, { ...m, channel: 'x' }, { ...m, extra: 1 }, { ...m, type: 'Theme' },
    { ...m, payload: { theme: LIGHT, more: 1 } }, { ...m, payload: {} }, { ...m, payload: { theme: { ...LIGHT, extra: 1 } } },
    { ...m, payload: { theme: { ...LIGHT, scheme: 'sepia' } } }, { ...m, payload: { theme: { ...LIGHT, tokens: { '--secret': 'red' } } } },
    { ...m, payload: { theme: { ...LIGHT, tokens: { '--ink': 'red;}*{display:none' } } } }, { ...m, payload: { theme: { ...LIGHT, tokens: { '--ink': 'url(x)' } } } },
    { ...m, payload: { theme: { ...LIGHT, tokens: { '--ink': 'var(--x)' } } } }, { ...m, payload: { theme: { ...LIGHT, tokens: { '--ink': 'x'.repeat(65) } } } },
    { ...m, payload: { theme: { ...LIGHT, tokens: JSON.parse('{"__proto__":"red"}') } } }, { ...m, payload: { theme: { ...LIGHT, typography: { weight: '900' } } } },
    { ...m, payload: { theme: { ...LIGHT, tokens: { '--ink': 3 } } } }, { ...m, payload: { theme: [LIGHT] } }, { ...m, payload: 'x' },
  ]
  for (const data of ignored) f.post(f.win.parent, data)
  f.post({}, m)   // not the parent
  assert.equal(f.cssom.length, before, 'nothing applied from a wrong source, nonce, envelope or payload')
  f.post(f.win.parent, m)
  assert.deepEqual(applied(f.cssom.slice(before)), uiThemeDeclarations(LIGHT), 'the new theme, the old tokens removed')
  assert.equal(vm.runInContext('JSON.stringify(oasisUI.getState())', f.ctx), '{"n":2,"note":"kept"}', 'the state stays: no reload')
  // the generated code replacing the CSSOM methods after the bootstrap ran changes nothing
  vm.runInContext('CSSStyleDeclaration.prototype.setProperty = function () { throw new Error("hijacked") }', f.ctx)
  const mid = f.cssom.length
  f.post(f.win.parent, themeMessage(NONCE, DARK))
  assert.deepEqual(applied(f.cssom.slice(mid)), uiThemeDeclarations(DARK))
  // and nothing in a theme message is a capability: no message goes back
  assert.ok(f.sent.every((s) => ['ready', 'state'].includes(s.data.type as string)), JSON.stringify(f.sent.map((s) => s.data.type)))
})

test('host → frame messages are checked exactly: the ping too; a frame cannot send a theme to the host', () => {
  const f = bootFrame()
  const p = pingMessage(NONCE, 5)
  for (const bad of [{ ...p, v: 1 }, { ...p, v: 3 }, { ...p, extra: 1 }, { ...p, payload: { seq: 5, x: 1 } }, { ...p, payload: { seq: -1 } }, { ...p, payload: { seq: 1.5 } }, { ...p, payload: { seq: '5' } }])
    f.post(f.win.parent, bad)
  assert.equal(f.sent.filter((s) => s.data.type === 'pong').length, 0)
  f.post(f.win.parent, p)
  assert.deepEqual(f.sent.filter((s) => s.data.type === 'pong').map((s) => s.data.payload), [{ seq: 5 }])
  assert.deepEqual(checkBridgeMessage({ ...themeMessage(NONCE, LIGHT) }, NONCE), { ok: false, reason: 'type' })
  // themeMessage normalizes what it is given (B passes it along without reading it)
  assert.deepEqual(themeMessage(NONCE, { ...LIGHT, tokens: { '--ink': 'url(x)', '--accent': '#09f' } }).payload.theme.tokens, { '--accent': '#09f' })
})

test("the model's code patching prototypes first: the host's ping and theme still work, nothing of the model sees them or the nonce, a synthetic parent message is refused", () => {
  const f = bootFrame({ n: 1 }, false, { theme: LIGHT, cssom: true })
  // what the model would do once it runs (after the bootstrap): record anything any hook sees, window.event included
  vm.runInContext(`(function(){
    var leaks = globalThis.leaks = [], busy = false, dp = Object.defineProperty, str = JSON.stringify, n = 0;
    function grab(where, v){ if (busy) return; busy = true; try { var s = typeof v === 'string' ? v : str(v); dp(leaks, n++, { value: where + ':' + s, enumerable: true }) } catch (e) {} busy = false }
    var MEP = MessageEvent.prototype, gd = Object.getOwnPropertyDescriptor, realData = gd(MEP, 'data').get, realSource = gd(MEP, 'source').get;
    function peek(where){ if (busy) return; try { var ev = window.event; if (ev) grab(where + '/window.event', realData.call(ev)) } catch (e) {} }
    dp(MEP, 'data', { configurable: true, get: function(){ var d = realData.call(this); grab('data', d); return d } });
    dp(MEP, 'source', { configurable: true, get: function(){ peek('source'); return realSource.call(this) } });
    Event.prototype.stopImmediatePropagation = function(){ peek('stopImmediatePropagation') };
    var push = Array.prototype.push; Array.prototype.push = function(){ peek('push'); return push.apply(this, arguments) };
    var io = Array.prototype.indexOf; Array.prototype.indexOf = function(){ peek('indexOf'); return io.apply(this, arguments) };
    var ex = RegExp.prototype.exec; RegExp.prototype.exec = function(s){ peek('exec'); return ex.call(this, s) };
    var ts = RegExp.prototype.test; RegExp.prototype.test = function(s){ peek('test'); return ts.call(this, s) };
    var ks = Object.keys; Object.keys = function(o){ peek('keys'); return ks(o) };
    Reflect.apply = function(f, t, a){ peek('Reflect.apply'); return f.apply(t, a) };
    Object.prototype.hasOwnProperty = function(){ peek('hasOwnProperty'); return false };
    Number.isSafeInteger = function(){ peek('isSafeInteger'); return true };
    CSSStyleDeclaration.prototype.setProperty = function(){ peek('setProperty') };
    CSSStyleDeclaration.prototype.removeProperty = function(){ peek('removeProperty') };
    ['channel', 'nonce', 'payload', 'theme', 'seq', 'v', 'type', 'tokens', 'typography', 'scheme', 'then', 'length'].forEach(function(k){
      try { dp(Object.prototype, k, { configurable: true, get: function(){ peek('Object.prototype.' + k) }, set: function(){ peek('set ' + k) } }) } catch (e) {}
    });
    dp(Array.prototype, '0', { configurable: true, get: function(){ peek('Array[0]') }, set: function(){ peek('Array[0]=') } });
    addEventListener('message', function(e){ grab('listener', realData.call(e)) }, true);
  })()`, f.ctx)
  const mark = f.cssom.length
  f.post(f.win.parent, pingMessage(NONCE, 11))
  f.post(f.win.parent, themeMessage(NONCE, DARK))
  assert.deepEqual(f.sent.filter((s) => s.data.type === 'pong').map((s) => s.data.payload), [{ seq: 11 }], 'the real ping is answered')
  assert.deepEqual(applied(f.cssom.slice(mark)), uiThemeDeclarations(DARK), 'the real theme is applied, through the captured CSSOM methods')
  // the frame dispatching a message itself that claims the parent and carries the nonce (worst case): refused
  const mark2 = f.cssom.length
  f.post(f.win.parent, pingMessage(NONCE, 12), false)
  f.post(f.win.parent, themeMessage(NONCE, LIGHT), false)
  assert.equal(f.sent.filter((s) => s.data.type === 'pong').length, 1, 'no pong to a synthetic ping')
  assert.equal(f.cssom.length, mark2, 'no theme from a synthetic message')
  const leaks = JSON.parse(vm.runInContext('JSON.stringify(leaks)', f.ctx)) as string[]
  const fromHost = leaks.filter((l) => !l.includes('"seq":12') && !l.includes('oklch(0.247'))   // the synthetic two are the model's own
  assert.deepEqual(fromHost.filter((l) => l.includes(NONCE)), [], 'no hook, getter or listener of the model saw the nonce')
  // the probe is live: its listener does see what the bootstrap does not stop (a message with another nonce)
  f.post(f.win.parent, pingMessage('b'.repeat(32), 13))
  assert.ok((JSON.parse(vm.runInContext('JSON.stringify(leaks)', f.ctx)) as string[]).some((l) => l.startsWith('listener:') && l.includes('"seq":13')))
})

test('without the native event accessors the bootstrap takes nothing from the host (it fails closed)', () => {
  const f = bootFrame()
  // a stand-in event without the MessageEvent getters: the captured getter throws on it, so it is ignored
  f.listeners.message![0]!({ isTrusted: true, source: f.win.parent, data: pingMessage(NONCE, 1), stopImmediatePropagation: () => undefined })
  assert.equal(f.sent.filter((s) => s.data.type === 'pong').length, 0)
})

test('the navigation notice says what happened, not that a request always leaves (the product host page blocks it)', () => {
  assert.equal(STOP_REASON_TEXT.navigated, 'Stopped: the preview tried to navigate away.')
})

// ---------------------------------------------------------------- bridge v2: tasks

test('task messages from the frame: the call id must be well formed (its answer is addressed to it); the rest is the host\'s to judge', () => {
  assert.deepEqual(checkBridgeMessage(msg('task_run', { callId: 'c1', actionId: 'go', state: { n: 1 }, input: { rows: [1] }, gesture: true }), NONCE),
    { ok: true, value: { type: 'task_run', callId: 'c1', actionId: 'go', state: { n: 1 }, stateProblem: null, input: { rows: [1] }, gesture: true } })
  // a malformed id or state is still a call to answer (a refusal), not a message to drop
  const odd = checkBridgeMessage(msg('task_run', { callId: 'c2', actionId: 'go now', state: { a: { b: 1 } }, input: null, gesture: false }), NONCE)
  assert.ok(odd.ok && odd.value.type === 'task_run' && odd.value.actionId === null && odd.value.state === null && /bounded scalar/.test(odd.value.stateProblem ?? ''))
  assert.deepEqual(checkBridgeMessage(msg('task_stop', { callId: 'c3', taskId: 'uit_1' }), NONCE), { ok: true, value: { type: 'task_stop', callId: 'c3', taskId: 'uit_1' } })
  assert.deepEqual(checkBridgeMessage(msg('task_list', { callId: 'c4' }), NONCE), { ok: true, value: { type: 'task_list', callId: 'c4' } })
  const refused: Array<[unknown, string]> = [
    [msg('task_run', { callId: 'x1', actionId: 'go', state: {}, input: null, gesture: true }), 'call id'],
    [msg('task_run', { callId: 'c1', actionId: 'go', state: {}, input: null, gesture: 'yes' }), 'gesture'],
    [msg('task_run', { callId: 'c1', actionId: 'go', state: {}, gesture: true }), 'payload keys'],
    [msg('task_stop', { callId: 'c1', taskId: 'uit 1' }), 'task id'], [msg('task_stop', { callId: 'c1', taskId: 'x'.repeat(101) }), 'task id'],
    [msg('task_list', { callId: 3 }), 'call id'], [msg('task_list', { callId: 'c1', more: 1 }), 'payload keys'],
    // host → frame types are not the frame's to send
    [msg('task_reply', { callId: 'c1', result: {} }), 'type'], [msg('task_update', { update: {} }), 'type'],
  ]
  for (const [data, reason] of refused) assert.deepEqual(checkBridgeMessage(data, NONCE), { ok: false, reason }, JSON.stringify(data))
})

test('a task starts only for a declared `run` action, on a click, the host still activated, not too fast, with a state and an input the contract takes', () => {
  const actions = [{ id: 'go', mode: 'run' as const }, { id: 'draft_it' }, { id: 'drafted', mode: 'draft' as const }]
  const base = { hostActive: true, actions, now: 10_000, lastActionAt: null }
  const run: { actionId: string | null; gesture: boolean; state: Record<string, number> | null; input: unknown } = { actionId: 'go', gesture: true, state: { n: 1 }, input: null }
  type Ctx = { hostActive: boolean | null; lastActionAt: number | null }
  assert.deepEqual(judgeRun(run, base), { ok: true })
  const code = (m: Partial<typeof run>, c: Partial<Ctx> = {}) => { const v = judgeRun({ ...run, ...m }, { ...base, ...c }); return v.ok ? 'ok' : v.code }
  assert.equal(code({ actionId: 'nope' }), 'unknown_action')
  assert.equal(code({ actionId: null }), 'unknown_action')
  assert.equal(code({ actionId: 'draft_it' }), 'not_a_run_action', 'an action without a mode is a draft')
  assert.equal(code({ actionId: 'drafted' }), 'not_a_run_action')
  assert.equal(code({ gesture: false }), 'no_gesture')
  assert.equal(code({}, { hostActive: false }), 'no_gesture')
  assert.equal(code({}, { hostActive: null }), 'ok', 'an engine without userActivation: the frame flag stands')
  assert.equal(code({}, { lastActionAt: 10_000 - UI_SANDBOX_LIMITS.actionIntervalMs + 1 }), 'too_fast')
  assert.equal(code({ state: null }), 'invalid_state')
  assert.equal(code({ input: { text: 'x'.repeat(9_000) } }), 'invalid_input')
  assert.equal(code({ input: { constructor: 1 } }), 'invalid_input', 'a reserved key')
  assert.equal(code({ input: { rows: [1, 2], note: 'ok' } }), 'ok')
})

test('oasisUI.run in a click: the state and input go with it; its updates reach onProgress and onTask; the Promise resolves with the host\'s result', async () => {
  const timers: Array<() => void> = []
  const f = bootFrame({ n: 1 }, true, { timers })
  const runTimers = () => { while (timers.length) { const t = timers.shift()!; f.win.event = undefined; t() } }
  vm.runInContext(`
    globalThis.got = []; globalThis.heard = []; globalThis.done = null;
    oasisUI.setState({ n: 5 });
    oasisUI.run('go', { input: { rows: [1, 2] }, onProgress: function (u) { got.push(u.type + ':' + (u.text || u.name || '')) } }).then(function (r) { done = r });
  `, f.ctx)
  const asked = f.sent.find((s) => s.data.type === 'task_run')!.data
  assert.deepEqual(asked.payload, { actionId: 'go', state: { n: 5 }, input: { rows: [1, 2] }, gesture: true, callId: 'c1' }, 'the newest state, flushed with the click')
  assert.equal(checkBridgeMessage(asked, NONCE).ok, true)
  assert.equal(f.sent.filter((s) => s.data.type === 'state').length, 0, 'the pending state went with the run, not after it')
  const post = (m: Parameters<typeof taskMessage>[1]) => f.post(f.win.parent, taskMessage(NONCE, m))
  // an update before onTask has a listener is kept for the first one (a task started before the page listened)
  post({ type: 'task_started', payload: { callId: 'c1', taskId: 'uit_1' } })
  post({ type: 'task_update', payload: { update: { type: 'status', task_id: 'uit_1', action_id: 'go', status: 'running' } } })
  runTimers()
  vm.runInContext(`oasisUI.onTask(function (u) { heard.push(u.type) })`, f.ctx)
  post({ type: 'task_update', payload: { update: { type: 'text', task_id: 'uit_1', action_id: 'go', delta: 'Hi', text: 'Hi' } } })
  post({ type: 'task_update', payload: { update: { type: 'tool', task_id: 'uit_1', action_id: 'go', name: 'read_file', summary: 'a.csv' } } })
  const result = { ok: true, task_id: 'uit_1', status: 'succeeded', text: 'Hi', data: { total: 3 }, error: null } as const
  post({ type: 'task_update', payload: { update: { type: 'done', task_id: 'uit_1', action_id: 'go', result } } })
  // a reply with another nonce, or from another window, is not the host's: nothing resolves from it
  f.post(f.win.parent, { ...taskMessage(NONCE, { type: 'task_reply', payload: { callId: 'c1', result: { ...result, text: 'forged' } } }), nonce: 'b'.repeat(32) })
  f.post({}, taskMessage(NONCE, { type: 'task_reply', payload: { callId: 'c1', result: { ...result, text: 'forged' } } }))
  post({ type: 'task_reply', payload: { callId: 'c1', result } })
  assert.equal(vm.runInContext('done', f.ctx), null, 'nothing of the page runs inside the host\'s message event')
  runTimers()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(got)', f.ctx)), ['status:', 'text:Hi', 'tool:read_file', 'done:'])
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(heard)', f.ctx)), ['status', 'text', 'tool', 'done'])
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(done)', f.ctx)), result)
  // a second reply to the same call changes nothing (it resolved once)
  post({ type: 'task_reply', payload: { callId: 'c1', result: { ...result, text: 'again' } } })
  runTimers(); await new Promise((r) => setImmediate(r))
  assert.equal(vm.runInContext('done.text', f.ctx), 'Hi')
})

test('stop() and tasks() are answered by the host; a malformed id or option throws; an input that is not JSON resolves refused, nothing sent', async () => {
  const f = bootFrame({}, true)
  vm.runInContext(`globalThis.r = {}; oasisUI.stop('uit_1').then(function (v) { r.stop = v }); oasisUI.tasks().then(function (v) { r.list = v })`, f.ctx)
  const [stop, list] = f.sent.filter((s) => s.data.type === 'task_stop' || s.data.type === 'task_list').map((s) => s.data)
  assert.deepEqual(stop!.payload, { taskId: 'uit_1', callId: 'c1' })
  assert.deepEqual(list!.payload, { callId: 'c2' })
  const view = { task_id: 'uit_1', action_id: 'go', status: 'cancelled', input: null, text: '', data: null, error: null, created_at: '2026-10-12T00:00:00.000Z', finished_at: '2026-10-12T00:00:01.000Z' } as const
  f.post(f.win.parent, taskMessage(NONCE, { type: 'stop_reply', payload: { callId: 'c1', ok: true } }))
  f.post(f.win.parent, taskMessage(NONCE, { type: 'list_reply', payload: { callId: 'c2', tasks: [view] } }))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(r)', f.ctx)), { stop: true, list: [view] })
  const thrown = (expr: string) => vm.runInContext(`(() => { try { ${expr}; return 'ok' } catch (e) { return e.name } })()`, f.ctx)
  assert.equal(thrown(`oasisUI.run('go now')`), 'TypeError')
  assert.equal(thrown(`oasisUI.run('constructor')`), 'TypeError')
  assert.equal(thrown(`oasisUI.run('go', { inputs: 1 })`), 'TypeError')
  assert.equal(thrown(`oasisUI.run('go', { onProgress: 3 })`), 'TypeError')
  assert.equal(thrown(`oasisUI.onTask(3)`), 'TypeError')
  assert.equal(thrown(`oasisUI.stop('')`), 'TypeError')
  const before = f.sent.length
  vm.runInContext(`var cyc = {}; cyc.self = cyc; oasisUI.run('go', { input: cyc }).then(function (v) { r.bad = v })`, f.ctx)
  await new Promise((r) => setImmediate(r))
  assert.equal(f.sent.length, before, 'nothing sent')
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(r.bad)', f.ctx)), { ok: false, task_id: null, status: 'refused', text: '', data: null, error: { code: 'invalid_input', message: 'oasisUI: input is not JSON' } })
  // the unsubscribe onTask returns stops that listener only
  vm.runInContext(`globalThis.a = []; globalThis.b = []; var offA = oasisUI.onTask(function (u) { a.push(u.type) }); oasisUI.onTask(function (u) { b.push(u.type) }); offA()`, f.ctx)
  f.post(f.win.parent, taskMessage(NONCE, { type: 'task_update', payload: { update: { type: 'status', task_id: 'uit_2', action_id: 'go', status: 'queued' } } }))
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify([a, b])', f.ctx)), [[], ['status']])
})

test("the page's data cleared while its task runs: the host's tasks say null at once, and the frame's onProgress and onTask hear it before the end", async () => {
  const f = bootFrame({ n: 1 }, true)
  // the owner's tasks, followed through a stream the test drives; every update posted to the frame as the host does
  const streams: Array<(e: TaskRunEvent) => void> = []
  const tasks = createSurfaceTasks({ session_id: 's1', run_id: 'r1', surface_id: 'calc' }, {
    list: async () => [], get: async () => { throw new Error('not asked') }, cancel: async () => { throw new Error('not asked') },
    follow: (_run, _after, onEvent) => { streams.push(onEvent); return () => undefined },
    timers: { set: () => 0, clear: () => undefined },
  })
  tasks.onUpdate((update) => f.post(f.win.parent, taskMessage(NONCE, { type: 'task_update', payload: { update } })))
  let n = 0
  const record = (over: Record<string, unknown>) => ({
    id: 'uit_1', session_id: 's1', surface_run_id: 'r1', surface_id: 'calc', revision: 1, action_id: 'go', request_id: 'ui-req-1', agent_run_id: 'run_t',
    status: 'running', input: null, text: '', data: null, error: null, created_at: '2026-10-12T00:00:00.000Z', started_at: null, finished_at: null,
    updated_at: new Date(Date.UTC(2026, 9, 12, 0, 0, 1, ++n)).toISOString(), ...over,
  })
  vm.runInContext(`globalThis.prog = []; globalThis.heard = []; oasisUI.onTask(function (u) { if (u.type === 'data') heard.push(u.data) });
    oasisUI.run('go', { onProgress: function (u) { prog.push(u.type === 'data' ? ['data', u.data] : [u.type]) } })`, f.ctx)
  // the host answers the call with the task it started, then follows the task's run
  const finished = tasks.run('go', async () => ({ task: record({}) }), (taskId) => f.post(f.win.parent, taskMessage(NONCE, { type: 'task_started', payload: { callId: 'c1', taskId } })))
  await new Promise((r) => setImmediate(r))
  streams[0]!({ event: 'ui_task', data: { task: record({ data: { chart: [3, 4] } }) }, id: '2' })
  streams[0]!({ event: 'ui_task', data: { task: record({ data: null }) }, id: '3' })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(prog)', f.ctx)), [['status'], ['data', { chart: [3, 4] }], ['data', null]], 'onProgress heard the clearing while the task ran')
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(heard)', f.ctx)), [{ chart: [3, 4] }, null], 'and so did onTask')
  assert.equal(tasks.view().tasks[0]!.record.status, 'running', 'no end yet')
  streams[0]!({ event: 'ui_task', data: { task: record({ status: 'succeeded', data: null, text: 'done', finished_at: '2026-10-12T00:00:09.000Z' }) }, id: '4' })
  assert.equal((await finished).status, 'succeeded')
})
