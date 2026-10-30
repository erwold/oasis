/** ChatGPT on the web as a route: the person's own signed-in ChatGPT page, held by the desktop app and reached through
 *  its bridge (`desktop/bridge.js`), answering as a participant of plain conversation. A run on this route types its
 *  message into the page — never with the oasis-code connector, so ChatGPT works with its own abilities (the web,
 *  its code interpreter) on the words it is handed and nothing else — and reads the answer back; the next run of
 *  the same participant goes on in the same ChatGPT conversation. There is one page, so one answer forms at a time
 *  (the route's slot); the page's sign-in is the credential, and only the page knows it, so it is found out when a
 *  run sends.
 *
 *  The bridge speaks JSON over HTTP on the loopback under the token the desktop app keeps in the data directory
 *  (`bridge-token`); the protocol is the one the director's bridge transport speaks (see its header), with
 *  `conversation_url` on /send and POST /stop. */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHATGPT_WEB_ID } from '@oasis-code/contract'
import { env, ModelConfig } from '../config.ts'
import { safeFetch } from '../safe_fetch.ts'
import type { FetchLike } from './http.ts'

export { CHATGPT_WEB_ID }
/** The desktop app's bridge token file in the data directory (written by desktop/bridge.js, 0600). */
export const BRIDGE_TOKEN_FILE = 'bridge-token'
/** What the person's own use of the page taught the desktop app (desktop/bridge.js CONNECTOR_FILE): the model last chosen. */
export const CHATGPT_PREFS_FILE = 'chatgpt-connector.json'
export const DEFAULT_BRIDGE_PORT = '8323'
/** Where the desktop app's bridge listens, written beside its token when it starts (desktop/bridge.js URL_FILE). */
export const BRIDGE_URL_FILE = 'bridge-url'
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/

/** The desktop app's bridge as this process reaches it, read at every call: OASIS_CODE_BRIDGE_URL when it is set, else
 *  the address the running app wrote in the data directory (a backend the app attached to, started without the app's
 *  OASIS_CODE_BRIDGE_PORT, looked at the default port while the page listened on another, seen 2026-09-30), else the
 *  loopback on OASIS_CODE_BRIDGE_PORT or 8323. */
export function localBridgeUrl(dataDir: string): string {
  const explicit = env('BRIDGE_URL')
  if (explicit) return explicit.replace(/\/+$/, '')
  const written = readText(join(dataDir, BRIDGE_URL_FILE))?.replace(/\/+$/, '') ?? null
  if (written !== null && LOOPBACK_URL.test(written)) return written
  return `http://127.0.0.1:${env('BRIDGE_PORT') || DEFAULT_BRIDGE_PORT}`
}

/** Whether an address is this machine's (a bridge there is the desktop app's own). */
export function isLoopbackUrl(url: string): boolean {
  try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname) } catch { return false }
}
/** A ChatGPT model slug, as the page sends it when the person picks the model (`gpt-6-pro`, seen 2026-09-27). */
export const CHAT_MODEL = /^[a-z0-9][a-z0-9._-]{0,60}$/i

/** The route as the catalogue and a run's records carry it: words and images in (the bridge types the words and
 *  hands the page the images, as its file picker would), no tool of this harness, one answer at a time. */
export const CHATGPT_WEB = new ModelConfig({
  id: CHATGPT_WEB_ID, label: 'ChatGPT', provider: 'openai', model: 'chatgpt-web', base_url: 'https://chatgpt.com/', auth: 'oauth',
  window_source: 'unknown (the ChatGPT web app keeps its own conversation)', concurrency: 1, slot_scope: CHATGPT_WEB_ID,
  capabilities: { text_files: false, images: true, tool_calls: false, streaming: true },
  capability_source: "the desktop app's ChatGPT page, typed into through its bridge: words and pictures in, words and pictures out; ChatGPT's own tools stay on its side",
})

export function isChatGptWeb(modelId: string | null | undefined): boolean {
  return modelId === CHATGPT_WEB_ID
}

type Rec = Record<string, unknown>

/** Why a call to the bridge did not get an answer: nothing listens there, the connection dropped before its reply
 *  (`lost`: the bridge may have taken the call and acted on it), it answered too late, or with an HTTP error. */
export class BridgeError extends Error {
  constructor(message: string, readonly kind: 'unreachable' | 'lost' | 'refused' | 'timeout', readonly base: string, readonly status: number | null = null) {
    super(message)
    this.name = 'BridgeError'
  }
}

/** The next piece of a text that grows (its new tail), or the whole text again when it changed before the tail. */
export function nextPiece(shown: string, now: string): { text: string; start?: true } | null {
  if (now === shown) return null
  if (now.startsWith(shown)) return { text: now.slice(shown.length) }
  return { text: now, start: true }
}

const MAX_IMAGES = 8

/** The answer's images as the bridge sent them (base64); anything malformed is left out. */
export function bridgeImagesOf(raw: unknown): { name: string; bytes: Uint8Array }[] {
  if (!Array.isArray(raw)) return []
  const out: { name: string; bytes: Uint8Array }[] = []
  for (const item of raw.slice(0, MAX_IMAGES)) {
    if (!item || typeof item !== 'object') continue
    const { name, data_base64: data } = item as Rec
    if (typeof data !== 'string' || !data) continue
    out.push({ name: typeof name === 'string' ? name : 'image', bytes: new Uint8Array(Buffer.from(data, 'base64')) })
  }
  return out
}

/** Why a run on ChatGPT on the web ended without an answer, in the words the person reads: the page is signed out,
 *  the page (the desktop app's bridge) is not there, the page did not take the message, or no answer came in time. */
export class ChatGptWebError extends Error {
  constructor(readonly kind: 'signin' | 'unreachable' | 'refused' | 'timeout', message: string) {
    super(message)
    this.name = 'ChatGptWebError'
  }
}

/** A connection that dropped once made (Bun's ECONNRESET, undici's socket errors, Node's "socket hang up"): the call
 *  reached the bridge; anything else that fails to fetch (a refusal, no such host) never did. */
const DROPPED_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'ConnectionClosed'])
function droppedConnection(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: { code?: unknown } } | null
  const codes = [e?.code, e?.cause?.code].filter((c): c is string => typeof c === 'string')
  if (codes.some((c) => DROPPED_CODES.has(c))) return true
  return codes.length === 0 && /socket hang up|closed unexpectedly|other side closed/i.test(String(e?.message ?? ''))
}

const REQUEST_TIMEOUT_MS = 30_000
/** How long a message may take to go: the page uploads its files first (the bridge waits up to two minutes for that:
 *  images, or words long enough to go as a file), sends, and the bridge waits up to 20 s to see it went. A shorter
 *  wait here read a message still going as a bridge not there — while ChatGPT answered it (seen 2026-09-30). */
export const SEND_TIMEOUT_MS = 240_000
/** How long a Stop waits for the page to be told (the bridge clicks its stop button for up to eight seconds). */
export const STOP_TIMEOUT_MS = 15_000

/** One call to a bridge: JSON both ways, the token as a bearer when there is one; the answer's object (anything else
 *  reads as an empty one). */
export async function bridgeRequest(fetchImpl: FetchLike, base: string, token: string | null, method: 'GET' | 'POST', path: string, body?: Rec, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Rec> {
  const headers: Record<string, string> = { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
  const timeout = AbortSignal.timeout(timeoutMs)
  const init: RequestInit = { method, headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout }
  if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body) }
  let response: Response
  try {
    response = await fetchImpl(`${base}${path}`, init)
  } catch (error) {
    if (signal?.aborted) throw error
    // a bridge that is there but did not answer in time is not a bridge that is not there
    if ((error as Error).name === 'TimeoutError') throw new BridgeError(`the bridge at ${base} did not answer ${method} ${path} within ${Math.round(timeoutMs / 1000)} s`, 'timeout', base)
    if (droppedConnection(error)) throw new BridgeError(`the connection to the bridge at ${base} dropped before it answered ${method} ${path} (${(error as Error).message})`, 'lost', base)
    throw new BridgeError(`the bridge at ${base} is not reachable (${(error as Error).message})`, 'unreachable', base)
  }
  const text = await response.text()
  let data: unknown = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  if (response.status >= 400) throw new BridgeError(`the bridge refused ${method} ${path} (${response.status}): ${text.slice(0, 300)}`, 'refused', base, response.status)
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Rec) : {}
}

export interface ChatGptBridgeOptions {
  /** where the bridge listens (default: localBridgeUrl, read at every call) */
  url?: string
  /** the ChatGPT model the person last chose on the page (default: the desktop app's record of it) */
  model?: () => string | null
  fetchImpl?: FetchLike
  /** how often an answer is asked for while it forms */
  poll_ms?: number
  /** how long before a page busy with another message is asked again */
  busy_retry_ms?: number
  /** how long an answer may take in all */
  timeout_ms?: number
}

/** How long a ChatGPT answer may take: the web app's longest thinking runs for tens of minutes, up to an hour. */
export const CHATGPT_ANSWER_TIMEOUT_S = 90 * 60

/** The desktop app's bridge as the runs reach it. */
export class ChatGptBridge {
  readonly poll_ms: number
  readonly busy_retry_ms: number
  readonly timeout_ms: number
  private readonly tokenOf: () => string | null
  private readonly urlOf: () => string
  private readonly modelOf: () => string | null
  private readonly fetchImpl: FetchLike

  constructor(dataDir: string, o: ChatGptBridgeOptions = {}) {
    const fixed = o.url?.replace(/\/+$/, '') ?? null
    this.urlOf = () => fixed ?? localBridgeUrl(dataDir)
    // the desktop app's token file, read at every call (the app keeps it; a restart of the app keeps the same one)
    this.tokenOf = () => readText(join(dataDir, BRIDGE_TOKEN_FILE))
    this.modelOf = o.model ?? (() => rememberedModel(join(dataDir, CHATGPT_PREFS_FILE)))
    this.fetchImpl = o.fetchImpl ?? ((input, init) => safeFetch(input, init))
    this.poll_ms = o.poll_ms ?? 1000
    this.busy_retry_ms = o.busy_retry_ms ?? 5000
    this.timeout_ms = o.timeout_ms ?? CHATGPT_ANSWER_TIMEOUT_S * 1000
  }

  /** Where the bridge is now (the app may have started it on another port since). */
  get url(): string {
    return this.urlOf()
  }

  /** The ChatGPT model the person last chose on the page, or null (the page's default). */
  model(): string | null {
    const model = this.modelOf()
    return model && CHAT_MODEL.test(model) && model !== 'auto' ? model : null
  }

  request(method: 'GET' | 'POST', path: string, body?: Rec, signal?: AbortSignal, timeoutMs?: number): Promise<Rec> {
    return bridgeRequest(this.fetchImpl, this.url, this.tokenOf(), method, path, body, signal, timeoutMs)
  }
}

function readText(file: string): string | null {
  try { return existsSync(file) ? readFileSync(file, 'utf8').trim() || null : null } catch { return null }
}

function rememberedModel(file: string): string | null {
  const raw = readText(file)
  if (raw === null) return null
  try {
    const saved = JSON.parse(raw) as Rec
    return typeof saved.model === 'string' ? saved.model : null
  } catch { return null }
}
