/** The isolated HTML preview's rules, apart from React: the document the iframe gets (a strict CSP first, then the base
 *  stylesheet and a small bootstrap, then the model's HTML), the bridge between that document and the host, and the
 *  bounds on both.
 *
 *  What holds and what does not (measured in Chromium, see docs/intelligent-ui.md and e2e/intelligent-ui-sandbox.e2e.ts):
 *  - the frame is `sandbox="allow-scripts"` only: an opaque origin, so no host DOM, cookie, localStorage or API with
 *    the host's credentials; no popups, forms, downloads or top-level navigation;
 *  - the CSP blocks fetch/XHR/WebSocket/EventSource/beacon, remote images, fonts, media, workers, nested http(s)
 *    frames, prefetch and eval — but the frame's own CSP does not stop the document navigating ITSELF (script,
 *    `<meta refresh>`, a clicked link). What stops that request is the embedding page's policy: the product host page
 *    (frontend/index.html) carries `frame-src 'none'`, which blocks the frame's HTTP(S) navigation before any request
 *    is made (measured in Chrome 153, headless shell and full Chrome for Testing: with the parent policy as a header or
 *    as a meta, 0 GETs in every case; without it, one GET per case), while srcdoc frames still load. That policy
 *    covers this page's DOM iframes only, not the desktop app's separate WebContentsViews. A host page that embeds
 *    this component without such a policy still lets that one GET leave. Either way the host notices the navigation
 *    and removes the frame;
 *  - WebRTC is outside CSP: the bootstrap takes the RTC constructors away and removes nested frames (a fresh realm
 *    would bring them back). Best effort, in-frame, not a browser guarantee;
 *  - where the frame's script runs depends on the engine (measured: docs/intelligent-ui.md, "CPU"): system Chrome 156
 *    and the desktop app's Electron 38 (Chromium 140) put the sandboxed srcdoc frame in its own process — a busy frame
 *    delays the host's timers by about 0.1 s and is unloaded as `unresponsive` once it stops answering the heartbeat,
 *    which ends its loop too; Chrome for Testing 153's headless shell runs it on the host page's thread — a bounded loop
 *    is stopped as `stalled` after it ends, and a loop that never ends holds the whole page. Neither is promised by the
 *    platform, so the preview still runs only when the person asks, and never in replay;
 *  - the host's look reaches the frame as data only (state/uiTheme.ts): allowlisted, resolved token values and the
 *    body's typography, checked by kind, applied in the frame through the CSSOM — no host stylesheet, DOM or URL.
 *
 *  The bridge carries data only: from the frame a state of scalars and scalar arrays, an action id the person clicked,
 *  a height, a task asked for in the person's click (a `run` action's id, the state, an `input` JSON), a stop or a list
 *  of the surface's tasks; from the host a heartbeat, the theme, and the tasks' answers and updates (JSON the harness
 *  holds, structured-cloned, never evaluated). Nothing the frame says runs a tool or calls a model by itself: an action
 *  proposal becomes a draft the person sends; a task is started by the host, only for an action the surface declares
 *  with mode `run`, only on the person's click (the host's own checks, judgeRun), and its state is the harness's. */

import { checkUiTaskJson, uiActionMode, uiTaskRefusal, UI_ID_PATTERN, UI_LIMITS, UI_RESERVED_KEYS, UiStateSchema, type UiTaskResult, type UiTaskUpdate, type UiTaskView } from '@oasis-code/contract'
import { normalizeUiHostTheme, themeFrameScript, UI_BASE_STYLE, type UiHostTheme } from './uiTheme.ts'

export const UI_SANDBOX_CHANNEL = 'oasis-ui-sandbox'
export const UI_SANDBOX_VERSION = 2

/** The only sandbox token the frame gets. Never allow-same-origin (it would hand the frame the host's origin),
 *  never popups, forms, downloads, modals or top navigation. */
export const UI_SANDBOX_ATTR = 'allow-scripts'

/** Delivered as the document's first element. base-uri and form-action do not fall back to default-src, so they are
 *  named; the rest is spelled out for the reader although default-src 'none' already covers it. data: images only
 *  (inline pictures, no request). No 'unsafe-eval': eval and new Function throw inside the frame too. */
export const UI_SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "font-src 'none'",
  "media-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/** Permissions Policy for the frame: no powerful feature is delegated (a cross-origin frame has none by default;
 *  named for the reader and for engines that differ). */
export const UI_SANDBOX_ALLOW = [
  'camera', 'microphone', 'geolocation', 'display-capture', 'clipboard-read', 'clipboard-write', 'usb', 'serial',
  'hid', 'bluetooth', 'payment', 'fullscreen', 'publickey-credentials-get', 'screen-wake-lock', 'midi',
].map((f) => `${f} 'none'`).join('; ')

/** The preview's bounds. The state's and the HTML's are the contract's own (UI_LIMITS, the same numbers the server
 *  checks a PUT …/state against), so what the frame may hold is exactly what the API takes; the rest are the
 *  sandbox's (traffic, watchdog, layout). */
export const UI_SANDBOX_LIMITS = {
  /** the model's HTML, UTF-16 code units (the contract's htmlChars) */
  htmlChars: UI_LIMITS.htmlChars,
  stateKeys: UI_LIMITS.stateKeys,
  stateArray: UI_LIMITS.stateArray,
  stringChars: UI_LIMITS.stringChars,
  /** the whole state as JSON, UTF-16 code units */
  stateChars: UI_LIMITS.stateChars,
  /** messages the host takes from one frame per window; more are dropped */
  messagesPerWindow: 60,
  /** received (taken or dropped) per window: past this the frame is stopped as flooding */
  floodPerWindow: 400,
  windowMs: 1_000,
  /** at most one action proposal this often */
  actionIntervalMs: 1_200,
  heartbeatMs: 1_000,
  /** no answer to the heartbeat for this long: the frame is stopped */
  unresponsiveMs: 4_000,
  /** the bootstrap says loaded from its own document's load event; an iframe load without it this long after: the
   *  document that loaded is not the one the host wrote (it navigated before it finished) */
  loadedAfterLoadMs: 800,
  readyMs: 6_000,
  /** a host timer this late means the thread was held (where the browser runs the frame on it): stopped after the fact */
  stallMs: 1_500,
  /** the host coalesces state reports for its owner this long */
  stateDebounceMs: 150,
  minHeight: 120,
  maxHeight: 720,
  defaultHeight: 360,
} as const

export type UiSandboxScalar = string | number | boolean | null
export type UiSandboxValue = UiSandboxScalar | UiSandboxScalar[]
export type UiSandboxState = Record<string, UiSandboxValue>

export type BridgeMessage =
  | { type: 'ready' }
  | { type: 'loaded' }
  | { type: 'pong'; seq: number }
  | { type: 'state'; state: UiSandboxState }
  | { type: 'action'; actionId: string; state: UiSandboxState; gesture: boolean }
  | { type: 'resize'; height: number }
  | { type: 'navigating' }
  /** oasisUI.run: a task asked for. Only the call id must be well formed (it is what the answer is addressed to);
   *  the rest is judged by the host, which answers a refusal rather than dropping the call (its Promise resolves) */
  | { type: 'task_run'; callId: string; actionId: string | null; state: UiSandboxState | null; stateProblem: string | null; input: unknown; gesture: boolean }
  | { type: 'task_stop'; callId: string; taskId: string }
  | { type: 'task_list'; callId: string }

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string }

export type StopReason = 'stopped' | 'navigated' | 'unresponsive' | 'stalled' | 'flood' | 'no-ready'

const RESERVED: ReadonlySet<string> = new Set(UI_RESERVED_KEYS)
const NONCE = /^[0-9a-f]{32}$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** A state key or an action id: the contract's id (UI_ID_PATTERN), none of its reserved names. */
export function idOk(key: unknown): key is string {
  return typeof key === 'string' && UI_ID_PATTERN.test(key) && !RESERVED.has(key)
}
export const stateKeyOk = idOk
export const actionIdOk = idOk

function scalarOk(v: unknown): v is UiSandboxScalar {
  if (v === null || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v === 'string') return v.length <= UI_SANDBOX_LIMITS.stringChars
  return false
}

/** The fewest JSON characters a scalar takes: a running lower bound lets a state too large be refused while it is
 *  walked, before anything is serialized (escapes only ever add). */
function jsonFloor(v: UiSandboxScalar): number {
  return typeof v === 'string' ? v.length + 2 : typeof v === 'number' ? 1 : 4
}

/** The whole state as the contract allows it (UiStateSchema, at most UI_LIMITS.stateKeys keys, at most
 *  UI_LIMITS.stateChars as JSON) — or why not. Bounded before anything costly: the key count before any value, an
 *  array's length before its items, a string's length without copying it, a running lower bound of the JSON size
 *  before the one exact JSON.stringify, which only runs on a state already known to be near the budget; the schema
 *  last. Always the whole state: a patch is merged first and the result checked. */
export function checkState(v: unknown): Checked<UiSandboxState> {
  if (!isPlainObject(v)) return { ok: false, reason: 'state is not a plain object' }
  const keys = Object.keys(v)
  if (keys.length > UI_SANDBOX_LIMITS.stateKeys) return { ok: false, reason: `state has more than ${UI_SANDBOX_LIMITS.stateKeys} keys` }
  if (Object.getOwnPropertySymbols(v).length) return { ok: false, reason: 'state has symbol keys' }
  const tooBig = { ok: false as const, reason: `state is more than ${UI_SANDBOX_LIMITS.stateChars} characters as JSON` }
  const out: UiSandboxState = {}
  let floor = 1
  for (const key of keys) {
    if (!idOk(key)) return { ok: false, reason: `state key not allowed: ${(key as string).slice(0, 80)}` }
    floor += key.length + 4
    const value = v[key]
    if (Array.isArray(value)) {
      if (value.length > UI_SANDBOX_LIMITS.stateArray) return { ok: false, reason: `state.${key} is longer than ${UI_SANDBOX_LIMITS.stateArray}` }
      const items: UiSandboxScalar[] = []
      floor += 1
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) return { ok: false, reason: `state.${key} is sparse` }
        const item: unknown = value[i]
        if (!scalarOk(item)) return { ok: false, reason: `state.${key}[${i}] is not a bounded scalar` }
        floor += jsonFloor(item) + 1
        if (floor > UI_SANDBOX_LIMITS.stateChars) return tooBig
        items.push(item)
      }
      out[key] = items
    } else if (scalarOk(value)) {
      floor += jsonFloor(value)
      out[key] = value
    } else return { ok: false, reason: `state.${key} is not a bounded scalar or scalar array` }
    if (floor > UI_SANDBOX_LIMITS.stateChars) return tooBig
  }
  if (JSON.stringify(out).length > UI_SANDBOX_LIMITS.stateChars) return tooBig
  if (!UiStateSchema.safeParse(out).success) return { ok: false, reason: 'state does not match the contract' }
  return { ok: true, value: out }
}

/** The host's initial state for the frame: whatever entries the bridge allows, in order, while the whole stays within
 *  the contract's bounds; the rest are dropped and counted (a stored state from an older contract must not keep the
 *  preview from opening). */
export function sanitizeInitialState(v: unknown): { state: UiSandboxState; dropped: number } {
  if (!isPlainObject(v)) return { state: {}, dropped: v == null ? 0 : 1 }
  let state: UiSandboxState = {}
  let kept = 0
  let dropped = 0
  for (const key of Object.keys(v)) {
    if (kept >= UI_SANDBOX_LIMITS.stateKeys) { dropped++; continue }
    const next = checkState({ ...state, [key]: v[key] })
    if (next.ok && Object.hasOwn(next.value, key)) { state = next.value; kept++ }
    else dropped++
  }
  return { state, dropped }
}

const PAYLOAD_KEYS: Record<BridgeMessage['type'], readonly string[]> = {
  ready: [], loaded: [], pong: ['seq'], state: ['state'], action: ['actionId', 'state', 'gesture'], resize: ['height'], navigating: [],
  task_run: ['callId', 'actionId', 'state', 'input', 'gesture'], task_stop: ['callId', 'taskId'], task_list: ['callId'],
}

/** A call's id as the bootstrap numbers them ("c" and up to 12 digits). */
const CALL_ID = /^c[0-9]{1,12}$/
export const callIdOk = (v: unknown): v is string => typeof v === 'string' && CALL_ID.test(v)
/** A task's id as the page may name one (the harness's ids are of these characters). */
const TASK_ID = /^[A-Za-z0-9_.:-]{1,100}$/
export const taskIdOk = (v: unknown): v is string => typeof v === 'string' && TASK_ID.test(v)

/** One message from the frame, taken apart: the envelope exactly (channel, version, this instance's nonce, a known
 *  type), the payload exactly (no extra key, every field typed and bounded). The caller has already checked that
 *  event.source is this instance's iframe window. */
export function checkBridgeMessage(data: unknown, nonce: string): Checked<BridgeMessage> {
  if (!isPlainObject(data)) return { ok: false, reason: 'not an object' }
  const envelope = Object.keys(data)
  if (envelope.length !== 5 || !['channel', 'v', 'nonce', 'type', 'payload'].every((k) => envelope.includes(k))) return { ok: false, reason: 'envelope keys' }
  if (data.channel !== UI_SANDBOX_CHANNEL) return { ok: false, reason: 'channel' }
  if (data.v !== UI_SANDBOX_VERSION) return { ok: false, reason: 'version' }
  if (typeof data.nonce !== 'string' || !NONCE.test(nonce) || data.nonce !== nonce) return { ok: false, reason: 'nonce' }
  const type = data.type
  if (typeof type !== 'string' || !Object.hasOwn(PAYLOAD_KEYS, type)) return { ok: false, reason: 'type' }
  const payload = data.payload
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload' }
  const want = PAYLOAD_KEYS[type as BridgeMessage['type']]
  const got = Object.keys(payload)
  if (got.length !== want.length || !want.every((k) => got.includes(k))) return { ok: false, reason: 'payload keys' }
  switch (type) {
    case 'ready': return { ok: true, value: { type } }
    case 'loaded': return { ok: true, value: { type } }
    case 'navigating': return { ok: true, value: { type } }
    case 'pong':
      return Number.isSafeInteger(payload.seq) && (payload.seq as number) >= 0 ? { ok: true, value: { type, seq: payload.seq as number } } : { ok: false, reason: 'seq' }
    case 'resize':
      return typeof payload.height === 'number' && Number.isFinite(payload.height) ? { ok: true, value: { type, height: payload.height } } : { ok: false, reason: 'height' }
    case 'state': {
      const state = checkState(payload.state)
      return state.ok ? { ok: true, value: { type, state: state.value } } : state
    }
    case 'task_run': {
      if (!callIdOk(payload.callId)) return { ok: false, reason: 'call id' }
      if (typeof payload.gesture !== 'boolean') return { ok: false, reason: 'gesture' }
      const state = checkState(payload.state)
      return { ok: true, value: { type, callId: payload.callId, actionId: actionIdOk(payload.actionId) ? payload.actionId : null,
        state: state.ok ? state.value : null, stateProblem: state.ok ? null : state.reason, input: payload.input, gesture: payload.gesture } }
    }
    case 'task_stop':
      if (!callIdOk(payload.callId)) return { ok: false, reason: 'call id' }
      return taskIdOk(payload.taskId) ? { ok: true, value: { type, callId: payload.callId, taskId: payload.taskId } } : { ok: false, reason: 'task id' }
    case 'task_list':
      return callIdOk(payload.callId) ? { ok: true, value: { type, callId: payload.callId } } : { ok: false, reason: 'call id' }
    default: {   // action
      if (!actionIdOk(payload.actionId)) return { ok: false, reason: 'action id' }
      if (typeof payload.gesture !== 'boolean') return { ok: false, reason: 'gesture' }
      const state = checkState(payload.state)
      return state.ok ? { ok: true, value: { type: 'action', actionId: payload.actionId, state: state.value, gesture: payload.gesture } } : state
    }
  }
}

/** Whether an action proposal is let through to the host's owner: the person's own click in the frame (the frame's
 *  bootstrap saw transient user activation, and the host page — to which the browser propagates a frame's
 *  activation — still has it), an id the surface declares when it declares any, and not sooner than the last one
 *  allows. A pass is a proposal still: the owner puts it in a draft for the person to send. */
export function judgeAction(msg: { actionId: string; gesture: boolean }, ctx: { hostActive: boolean | null; allowed?: readonly string[] | null; now: number; lastActionAt: number | null }): Checked<null> {
  if (ctx.allowed && !ctx.allowed.includes(msg.actionId)) return { ok: false, reason: `unknown action ${msg.actionId}` }
  if (!msg.gesture) return { ok: false, reason: 'action without a click in the preview' }
  if (ctx.hostActive === false) return { ok: false, reason: 'action without user activation' }
  if (ctx.lastActionAt !== null && ctx.now - ctx.lastActionAt < UI_SANDBOX_LIMITS.actionIntervalMs) return { ok: false, reason: 'actions too fast' }
  return { ok: true, value: null }
}

/** Whether a task the frame asks for (oasisUI.run) is started, by the rules of an action proposal and then some: an
 *  id the surface declares, with mode `run`; the person's own click in the frame and the host still activated; not
 *  sooner than the last action or task allows; a state and an input the contract takes. A refusal is an answer (a
 *  `refused` UiTaskResult with its code), never a thrown error or silence. */
export function judgeRun(
  msg: { actionId: string | null; gesture: boolean; state: UiSandboxState | null; stateProblem?: string | null; input: unknown },
  ctx: { hostActive: boolean | null; actions: readonly { id: string; mode?: 'draft' | 'run' }[]; now: number; lastActionAt: number | null },
): { ok: true } | { ok: false; code: string; reason: string } {
  const action = msg.actionId === null ? undefined : ctx.actions.find((a) => a.id === msg.actionId)
  if (!action) return { ok: false, code: 'unknown_action', reason: `unknown action ${msg.actionId ?? '(malformed id)'}` }
  if (uiActionMode(action) !== 'run') return { ok: false, code: 'not_a_run_action', reason: `action ${action.id} does not start a task (its mode is draft)` }
  if (!msg.gesture) return { ok: false, code: 'no_gesture', reason: 'run without a click in the preview' }
  if (ctx.hostActive === false) return { ok: false, code: 'no_gesture', reason: 'run without user activation' }
  if (ctx.lastActionAt !== null && ctx.now - ctx.lastActionAt < UI_SANDBOX_LIMITS.actionIntervalMs) return { ok: false, code: 'too_fast', reason: 'actions too fast' }
  if (msg.state === null) return { ok: false, code: 'invalid_state', reason: msg.stateProblem ?? 'state not allowed' }
  if (msg.input !== null && msg.input !== undefined) {
    const bad = checkUiTaskJson(msg.input, 'input')
    if (bad !== null) return { ok: false, code: 'invalid_input', reason: bad }
  }
  return { ok: true }
}

/** The refusal of a judged run, as the page's Promise gets it. */
export function runRefusal(verdict: { code: string; reason: string }): UiTaskResult {
  return uiTaskRefusal(verdict.code, verdict.reason)
}

/** Counting what one frame sends, per fixed window: taken up to messagesPerWindow, dropped past it, and once the
 *  frame has sent floodPerWindow in a window it is flooding (the host stops it). */
export class MessageBudget {
  private start = Number.NEGATIVE_INFINITY
  private count = 0
  private readonly limits: { messagesPerWindow: number; floodPerWindow: number; windowMs: number }
  constructor(limits: { messagesPerWindow: number; floodPerWindow: number; windowMs: number } = UI_SANDBOX_LIMITS) { this.limits = limits }
  take(now: number): 'take' | 'drop' | 'flood' {
    if (now - this.start >= this.limits.windowMs || now < this.start) { this.start = now; this.count = 0 }
    this.count++
    if (this.count >= this.limits.floodPerWindow) return 'flood'
    return this.count > this.limits.messagesPerWindow ? 'drop' : 'take'
  }
}

/** The watchdog's reading at one tick: what, if anything, the host should stop the frame for. */
export function watchdogVerdict(w: { now: number; lastTick: number; startedAt: number; ready: boolean; lastPong: number | null }): StopReason | null {
  if (w.now - w.lastTick > UI_SANDBOX_LIMITS.heartbeatMs + UI_SANDBOX_LIMITS.stallMs) return 'stalled'
  if (!w.ready) return w.now - w.startedAt > UI_SANDBOX_LIMITS.readyMs ? 'no-ready' : null
  return w.now - (w.lastPong ?? w.startedAt) > UI_SANDBOX_LIMITS.unresponsiveMs ? 'unresponsive' : null
}

export function clampHeight(h: number): number {
  if (!Number.isFinite(h)) return UI_SANDBOX_LIMITS.defaultHeight
  return Math.round(Math.min(UI_SANDBOX_LIMITS.maxHeight, Math.max(UI_SANDBOX_LIMITS.minHeight, h)))
}

/** The contract's measure of an html surface: UTF-16 code units, as the server counts them. */
export function htmlTooLarge(html: string): boolean {
  return html.length > UI_SANDBOX_LIMITS.htmlChars
}

/** 128 random bits, hex: one per mounted frame (a new run, a reset, a new revision each get their own). */
export function makeNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** JSON that may stand inside an inline <script>: nothing in it can close the element or start a comment. */
export function scriptJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

export const STOP_REASON_TEXT: Record<StopReason, string> = {
  stopped: 'Stopped.',
  navigated: 'Stopped: the preview tried to navigate away.',
  unresponsive: 'Stopped: the preview stopped answering.',
  stalled: 'Stopped: the preview held the page busy.',
  flood: 'Stopped: the preview sent too many messages.',
  'no-ready': 'Stopped: the preview did not start.',
}

/** The bootstrap, as the frame's first script. It keeps the nonce in its closure and removes its own element, so the
 *  model's code cannot read it from the DOM; it captures what it relies on before that code runs; it exposes
 *  `window.oasisUI` (version, getState, setState, action, run, stop, tasks, onTask) and nothing else. It is the frame's code, not the host's: the host
 *  trusts none of it and checks every message again. */
function bootstrap(nonce: string, state: UiSandboxState, theme: UiHostTheme | null): string {
  const L = UI_SANDBOX_LIMITS
  return `(function(){"use strict";
var NONCE=${scriptJson(nonce)},CH=${scriptJson(UI_SANDBOX_CHANNEL)},V=${UI_SANDBOX_VERSION};
var P=window.parent,W=window,apply=Reflect.apply,isArr=Array.isArray,keys=Object.keys,now=Date.now,P0=Promise.resolve(),pthen=Promise.prototype.then,freeze=Object.freeze,def=Object.defineProperty,isFin=Number.isFinite,setT=W.setTimeout,clearT=W.clearTimeout;
/* the event accessors the message listener uses, taken before the model's code can replace them (a replaced getter or
   stopImmediatePropagation would let that code watch the host's messages, nonce included); without them, nothing is
   taken from the host at all (the heartbeat then goes unanswered and the host stops the frame) */
var evData=null,evSource=null,evStop=null;try{var gopd=Object.getOwnPropertyDescriptor,MEP=W.MessageEvent.prototype;evData=gopd(MEP,"data").get;evSource=gopd(MEP,"source").get;evStop=W.Event.prototype.stopImmediatePropagation}catch(e){}
var uaObj=W.navigator&&W.navigator.userActivation,uaGet=null;try{uaGet=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(uaObj),"isActive").get}catch(e){}
function gesture(){try{return uaGet?!!apply(uaGet,uaObj,[]):false}catch(e){return false}}
function send(type,payload){try{P.postMessage({channel:CH,v:V,nonce:NONCE,type:type,payload:payload},"*")}catch(e){}}
var KEY=new RegExp(${scriptJson(UI_ID_PATTERN.source)}),RES=Object.create(null),RL=${scriptJson(UI_RESERVED_KEYS)},stringify=JSON.stringify,tst=RegExp.prototype.test;for(var r=0;r<RL.length;r++)RES[RL[r]]=1;
function scalar(v){return v===null||typeof v==="boolean"||(typeof v==="number"&&isFin(v))||(typeof v==="string"&&v.length<=${L.stringChars})}
function low(v){return typeof v==="string"?v.length+2:typeof v==="number"?1:4}
var BIG="oasisUI: state larger than ${L.stateChars} characters as JSON";
function clean(o){if(typeof o!=="object"||o===null||isArr(o))throw new TypeError("oasisUI: state must be an object");var out={},ks=keys(o),n=1;
if(ks.length>${L.stateKeys})throw new RangeError("oasisUI: more than ${L.stateKeys} keys");
for(var i=0;i<ks.length;i++){var k=ks[i],v=o[k];if(!apply(tst,KEY,[k])||RES[k]===1)throw new TypeError("oasisUI: key not allowed: "+k);n+=k.length+4;
if(isArr(v)){if(v.length>${L.stateArray})throw new RangeError("oasisUI: array longer than ${L.stateArray}: "+k);var a=[];n+=1;for(var j=0;j<v.length;j++){if(!scalar(v[j]))throw new TypeError("oasisUI: not a bounded scalar: "+k+"["+j+"]");n+=low(v[j])+1;if(n>${L.stateChars})throw new RangeError(BIG);a.push(v[j])}out[k]=a}
else if(scalar(v)){n+=low(v);out[k]=v}else throw new TypeError("oasisUI: not a bounded scalar: "+k);
if(n>${L.stateChars})throw new RangeError(BIG)}
if(stringify(out).length>${L.stateChars})throw new RangeError(BIG);
return out}
function copy(s){var o={},ks=keys(s);for(var i=0;i<ks.length;i++){var v=s[ks[i]];o[ks[i]]=isArr(v)?v.slice():v}return o}
var state=clean(${scriptJson(state)}),pending=false,timer=null,lastSent=0;
/* a change after a quiet spell is sent at the end of the task that made it (so a click's state is out before the host
   handles anything after the click, a Stop included); a burst is held to one message every 30 ms, the last one sent */
function flush(){if(!pending)return;pending=false;timer=null;lastSent=now();send("state",{state:copy(state)})}
function schedule(){if(pending)return;pending=true;var wait=lastSent+30-now();if(wait<=0)apply(pthen,P0,[flush]);else timer=setT(flush,wait)}
/* tasks: run() in the person's click asks the host for a task and resolves once, with the host's answer (no timer of
   its own); stop() and tasks() too. What the host says of them reaches the model's code in a task of its own (setT), never
   inside the host's message event (where window.event would show the envelope, nonce included). */
var Prom=Promise,presolve=Promise.resolve,parse=JSON.parse,calls=Object.create(null),progress=Object.create(null),hearers=[],held=[],callSeq=0;
function later(f){setT(f,0)}
function isFn(f){return typeof f==="function"}
function plain(o){return typeof o==="object"&&o!==null&&!isArr(o)}
function hear(f,u){try{f(u)}catch(e){setT(function(){throw e},0)}}
function refusedR(code,message){return{ok:false,task_id:null,status:"refused",text:"",data:null,error:{code:code,message:message}}}
function call(type,payload){var id="c"+(++callSeq);payload.callId=id;return new Prom(function(res){calls[id]={res:res,prog:payload.prog};delete payload.prog;send(type,payload)})}
function answer(id,v){var c=calls[id];if(!c)return;delete calls[id];later(function(){c.res(v)})}
function deliver(u){var prog=progress[u.task_id];if(u.type==="done")delete progress[u.task_id];later(function(){if(prog)hear(prog,u);var n=hearers.length;if(n===0){if(held.length<200)held[held.length]=u;return}var hs=[];for(var i=0;i<n;i++)hs[i]=hearers[i];for(var j=0;j<n;j++)hear(hs[j],u)})}
var api=freeze({version:V,
getState:function(){return copy(state)},
setState:function(patch){var p=clean(patch),next=copy(state),ks=keys(p);for(var i=0;i<ks.length;i++)next[ks[i]]=p[ks[i]];state=clean(next);schedule()},
action:function(id){if(typeof id!=="string"||!apply(tst,KEY,[id])||RES[id]===1)throw new TypeError("oasisUI: action id");var g=gesture();if(timer!==null)clearT(timer);timer=null;pending=false;send("action",{actionId:id,state:copy(state),gesture:g});return g},
run:function(id,opts){if(typeof id!=="string"||!apply(tst,KEY,[id])||RES[id]===1)throw new TypeError("oasisUI: action id");
if(opts!==undefined&&!plain(opts))throw new TypeError("oasisUI: run options must be an object");var o=opts||{},ok=keys(o);
for(var i=0;i<ok.length;i++){if(ok[i]!=="input"&&ok[i]!=="onProgress")throw new TypeError("oasisUI: unknown run option: "+ok[i])}
var prog=o.onProgress;if(prog!==undefined&&!isFn(prog))throw new TypeError("oasisUI: onProgress must be a function");
var g=gesture(),inp=null,bad=false;if(o.input!==undefined){try{var js=stringify(o.input);if(js===undefined)bad=true;else inp=parse(js)}catch(e){bad=true}}
if(timer!==null)clearT(timer);timer=null;pending=false;
if(bad)return apply(presolve,Prom,[refusedR("invalid_input","oasisUI: input is not JSON")]);
return call("task_run",{actionId:id,state:copy(state),input:inp,gesture:g,prog:prog})},
stop:function(taskId){if(typeof taskId!=="string"||!taskId||taskId.length>100)throw new TypeError("oasisUI: task id");return call("task_stop",{taskId:taskId})},
tasks:function(){return call("task_list",{})},
onTask:function(f){if(!isFn(f))throw new TypeError("oasisUI: onTask takes a function");hearers[hearers.length]=f;var mine=held;held=[];
if(mine.length)later(function(){for(var i=0;i<mine.length;i++)hear(f,mine[i])});var on=true;
return function(){if(!on)return;on=false;var rest=[];for(var i=0;i<hearers.length;i++){if(hearers[i]!==f)rest[rest.length]=hearers[i]}hearers=rest}}});
def(W,"oasisUI",{value:api,writable:false,configurable:false,enumerable:false});
var gone=["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCIceCandidate","RTCSessionDescription","RTCRtpSender","RTCRtpReceiver","RTCRtpTransceiver","RTCIceTransport","RTCDtlsTransport","RTCSctpTransport","RTCCertificate"];
for(var g=0;g<gone.length;g++){try{def(W,gone[g],{value:undefined,writable:false,configurable:false})}catch(e){}}
var FRAMES="iframe,frame,frameset,object,embed,portal,fencedframe";
function strip(n){if(!n||n.nodeType!==1)return;var bad=[];try{if(n.matches(FRAMES))bad.push(n);var q=n.querySelectorAll(FRAMES);for(var i=0;i<q.length;i++)bad.push(q[i])}catch(e){}
for(var b=0;b<bad.length;b++){try{bad[b].removeAttribute("srcdoc");bad[b].removeAttribute("src");bad[b].removeAttribute("data");bad[b].remove()}catch(e){}}}
try{new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var a=ms[i].addedNodes;for(var j=0;j<a.length;j++)strip(a[j])}}).observe(document,{childList:true,subtree:true})}catch(e){}
${themeFrameScript(scriptJson)}
${theme ? `try{THEME(${scriptJson(theme)})}catch(e){}` : ''}
/* from the host: a trusted event (not one the frame dispatched itself), from the parent window, with this nonce, the
   five-key envelope, this version, a known type, exactly its payload. Read through the captured accessors only, and
   nothing in this listener calls anything the model's code could have replaced: code of the model's that ran in here
   would find the event in window.event. stopImmediatePropagation (captured) keeps every later listener from it. */
function exact(o,want){if(typeof o!=="object"||o===null||isArr(o))return false;var k=keys(o);if(k.length!==want.length)return false;for(var i=0;i<k.length;i++){if(apply(idxOf,want,[k[i]])<0)return false}return true}
var ENV=["channel","v","nonce","type","payload"],isSafe=Number.isSafeInteger,idxOf=Array.prototype.indexOf;
W.addEventListener("message",function(e){var d;try{if(e.isTrusted!==true||apply(evSource,e,[])!==P)return;d=apply(evData,e,[])}catch(x){return}
if(!d||typeof d!=="object"||d.channel!==CH||d.nonce!==NONCE)return;try{apply(evStop,e,[])}catch(x){}
if(!exact(d,ENV)||d.v!==V)return;var p=d.payload;
if(d.type==="ping"){if(exact(p,["seq"])&&isSafe(p.seq)&&p.seq>=0)send("pong",{seq:p.seq})}
else if(d.type==="theme"){if(exact(p,["theme"]))try{THEME(p.theme)}catch(e){}}
else if(d.type==="task_started"){if(exact(p,["callId","taskId"])&&typeof p.callId==="string"&&typeof p.taskId==="string"){var c=calls[p.callId];if(c&&c.prog)progress[p.taskId]=c.prog}}
else if(d.type==="task_update"){if(exact(p,["update"])&&plain(p.update)&&typeof p.update.task_id==="string")deliver(p.update)}
else if(d.type==="task_reply"){if(exact(p,["callId","result"])&&plain(p.result))answer(p.callId,p.result)}
else if(d.type==="stop_reply"){if(exact(p,["callId","ok"]))answer(p.callId,p.ok===true)}
else if(d.type==="list_reply"){if(exact(p,["callId","tasks"])&&isArr(p.tasks))answer(p.callId,p.tasks)}},true);
W.addEventListener("pagehide",function(){send("navigating",{})},true);
W.addEventListener("load",function(e){if(e.target===document)send("loaded",{})},true);
var lastH=0;function measure(){var h=Math.ceil(Math.max(document.documentElement?document.documentElement.scrollHeight:0,document.body?document.body.scrollHeight:0));if(h&&Math.abs(h-lastH)>2){lastH=h;send("resize",{height:h})}}
try{var ro=new ResizeObserver(function(){measure()});W.addEventListener("DOMContentLoaded",function(){measure();try{ro.observe(document.documentElement)}catch(e){}},true)}catch(e){}
try{document.currentScript&&document.currentScript.remove()}catch(e){}
send("ready",{});
})();`
}

/** The whole document for srcdoc: the CSP before anything else (a meta policy covers only what follows it; a later
 *  policy can only add restrictions), DNS prefetch off (once off it cannot be turned back on), no referrer, the base
 *  stylesheet for plain HTML (state/uiTheme.ts: zero specificity, every token with a fallback), the bootstrap — which
 *  adds the theme's own `:where(:root)` rule after that stylesheet and applies the initial theme through the CSSOM,
 *  before any of the model's code runs — then the model's HTML as it is (the parser takes a whole document there too).
 *  The theme is never written into the document's text: it is JSON inside the bootstrap (scriptJson), and a later
 *  change arrives as a themeMessage, so the srcdoc does not depend on it once built. */
export function buildSrcdoc(html: string, opts: { nonce: string; state: UiSandboxState; theme?: UiHostTheme }): string {
  if (!NONCE.test(opts.nonce)) throw new Error('nonce must be 32 hex characters')
  const theme = opts.theme === undefined ? null : normalizeUiHostTheme(opts.theme)
  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${UI_SANDBOX_CSP}">`
    + '<meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer">'
    + `<style>${UI_BASE_STYLE}</style>`
    + `<script>${bootstrap(opts.nonce, opts.state, theme)}</script>`
    + '</head><body>'
    + html
}

/** The heartbeat the host sends (to "*": an opaque origin has no name to address). */
export function pingMessage(nonce: string, seq: number) {
  return { channel: UI_SANDBOX_CHANNEL, v: UI_SANDBOX_VERSION, nonce, type: 'ping', payload: { seq } }
}

/** The host's theme now, for a frame that said ready: the same five-key envelope as the ping, type 'theme', payload
 *  exactly { theme } (normalized again here). The frame applies it to its theme rule in place — no reload, its DOM
 *  and state stay — and ignores it unless it comes from its parent with its nonce and the exact shape. */
export function themeMessage(nonce: string, theme: UiHostTheme) {
  return { channel: UI_SANDBOX_CHANNEL, v: UI_SANDBOX_VERSION, nonce, type: 'theme', payload: { theme: normalizeUiHostTheme(theme) } }
}

/** What the host tells the frame of its tasks — each the same five-key envelope, exactly its payload; the frame takes
 *  them only from its parent with its nonce:
 *  - task_started: the call `callId` made task `taskId` (the frame routes that task's updates to its onProgress);
 *  - task_update: one UiTaskUpdate of a task of this surface (every one, whoever started the task);
 *  - task_reply: the result of the run call `callId` (once; after its `done` update when there is one);
 *  - stop_reply / list_reply: the answers to stop() and tasks(). */
export type TaskHostMessage =
  | { type: 'task_started'; payload: { callId: string; taskId: string } }
  | { type: 'task_update'; payload: { update: UiTaskUpdate } }
  | { type: 'task_reply'; payload: { callId: string; result: UiTaskResult } }
  | { type: 'stop_reply'; payload: { callId: string; ok: boolean } }
  | { type: 'list_reply'; payload: { callId: string; tasks: UiTaskView[] } }

export function taskMessage(nonce: string, msg: TaskHostMessage) {
  return { channel: UI_SANDBOX_CHANNEL, v: UI_SANDBOX_VERSION, nonce, type: msg.type, payload: msg.payload }
}
