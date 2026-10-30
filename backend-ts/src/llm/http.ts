/** The HTTP plumbing every provider mapping shares: one `fetch` (injectable, so a test plays the provider and the
 *  suite's guard never sees a real host), bounded retries on the statuses and transport failures a provider SDK
 *  would retry, the provider's status as ModelHTTPError, a transport failure as TransportError, and an SSE reader. */

import { APP_REQUEST_CAP_BYTES, requestLimitsFor } from '@oasis-code/contract'
import { ContentEncodingRefused, safeFetch } from '../safe_fetch.ts'
import { ModelHTTPError, providerQuotaExhausted, TransportError } from './model.ts'

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface HttpOptions {
  requestProtocol?: 'anthropic' | 'google' | 'openai'
  fetchImpl?: FetchLike
  maxRetries?: number
  /** Called with the request just before it is sent (the signing hook of a subscription route); may throw. */
  beforeSend?: (request: { url: URL; headers: Headers; body: string }) => Promise<void> | void
  /** how long a request may wait for the response's headers (each attempt) */
  timeoutMs?: number
  /** how long a streamed response may stay silent between two pieces */
  idleTimeoutMs?: number
  /** Bun's own socket idle deadline for this request (fetch's non-standard `timeout`: reset on every byte, default
   *  BUN_CONFIG_HTTP_IDLE_TIMEOUT, 5 minutes; 0 or false: none). Unset: the option is not passed and Bun's default
   *  holds, as before. A route whose own deadlines are longer than Bun's default turns it off (false), so the
   *  harness's timers (timeoutMs, idleTimeoutMs) and the caller's signal are what end the request (Argon). It reaches
   *  only this process's socket: it cannot lengthen an idle deadline a proxy, a tunnel or the provider holds. */
  socketIdleTimeoutMs?: number | false
}

const RETRY_STATUSES = new Set([408, 409, 429])
const retryable = (status: number): boolean => RETRY_STATUSES.has(status) || status >= 500
const BACKOFF_MS = [500, 1000, 2000, 4000]
// A provider answers with headers in seconds, streaming or not; five minutes is a stall, not a slow model.
export const RESPONSE_TIMEOUT_MS = 5 * 60_000
// A streamed answer may go quiet while a reasoning model thinks (some routes send no keep-alive while it does): ten
// minutes of nothing between two pieces is a stall. A stall is a transport failure the runner recovers from.
export const STREAM_IDLE_TIMEOUT_MS = 10 * 60_000
// A Retry-After the harness waits out; a provider asking for longer gets its error back at once.
export const RETRY_AFTER_CAP_MS = 60_000

const span = (ms: number): string => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`)

/** A Retry-After header as milliseconds (seconds or an HTTP date), or null when there is none or it does not parse. */
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (value === null || !value.trim()) return null
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : null
}

function transportKind(error: unknown): string {
  const name = (error as { name?: string })?.name ?? ''
  const message = String((error as { message?: string })?.message ?? error)
  // the error's own code before its words: Bun reports a peer that closed the socket as a TypeError with code
  // ECONNRESET and the message "The socket connection was closed unexpectedly…", whose "connection" the word test
  // below would take for a failure to connect (ConnectError) — before or after the headers alike
  const code = String((error as { code?: unknown })?.code ?? '')
  if (/^(ECONNRESET|EPIPE)$/.test(code)) return 'ReadError'
  if (/^(ETIMEDOUT)$/.test(code)) return 'TimeoutException'
  if (/^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ConnectionRefused)$/.test(code)) return 'ConnectError'
  if (name === 'TimeoutError' || /timeout|timed out/i.test(message)) return 'TimeoutException'
  if (/ECONNRESET|reset|socket hang up|EPIPE|broken pipe/i.test(message)) return 'ReadError'
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|unable to connect|failed to fetch|fetch failed|ConnectionRefused|connect/i.test(message)) return 'ConnectError'
  return 'NetworkError'
}

/** POST a JSON body and return the response (2xx), retrying what a provider client would; anything else raises. */
export async function postJson(url: string, body: unknown, headers: Record<string, string>, modelName: string, opts: HttpOptions = {},
  signal?: AbortSignal): Promise<Response> {
  // a configured base_url may be any host: no route's response reaches the runtime's Brotli decoder (safe_fetch.ts)
  const fetchImpl = opts.fetchImpl ?? safeFetch
  const maxRetries = opts.maxRetries ?? 2
  const text = JSON.stringify(body)
  let attempt = 0
  for (;;) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    const request = { url: new URL(url), headers: new Headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }), body: text }
    if (opts.beforeSend) await opts.beforeSend(request)
    assertRequestSize(request.body, { protocol: opts.requestProtocol, url: request.url.toString() })
    let response: Response
    // the deadline for the headers is this attempt's own; the caller's signal (a Stop) is kept apart so a stop is
    // never reported as a timeout
    const timeoutMs = opts.timeoutMs ?? RESPONSE_TIMEOUT_MS
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new TransportError('TimeoutException', `no response from ${modelName} within ${span(timeoutMs)}`)), timeoutMs)
    try {
      const init: RequestInit & { timeout?: number | boolean } = { method: 'POST', headers: request.headers, body: request.body, redirect: 'manual', signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal }
      if (opts.socketIdleTimeoutMs !== undefined) init.timeout = opts.socketIdleTimeoutMs
      response = await fetchImpl(request.url.toString(), init)
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      if (deadline.signal.aborted) {
        if (attempt < maxRetries) {
          await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!, signal)
          attempt += 1
          continue
        }
        throw deadline.signal.reason as TransportError
      }
      // a refused Content-Encoding (Brotli, an unknown coding) is the endpoint's answer, not a failed transport: never
      // retried, said as it is
      if (error instanceof ModelHTTPError || error instanceof TransportError || error instanceof ContentEncodingRefused) throw error
      const kind = transportKind(error)
      if (attempt < maxRetries && kind !== 'NetworkError') {
        await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!, signal)
        attempt += 1
        continue
      }
      throw new TransportError(kind, `${kind}: ${String((error as Error)?.message ?? error)}`, { cause: error })
    } finally {
      clearTimeout(timer)
    }
    if (response.ok) return response
    // a redirect is not followed: the request carries the route's credential, which goes to the endpoint the route
    // names and nowhere else; the person sees where the endpoint pointed and can name that one instead
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => {})
      const target = redirectTarget(response.headers.get('location'), request.url)
      throw new ModelHTTPError(response.status, modelName, { error: { message: `the endpoint redirected to ${target}; the request was not followed there (its credential goes only to the configured endpoint)` } })
    }
    let errorBody: unknown = null
    let raw = ''
    try { raw = await response.text() } catch { raw = '' }
    try { errorBody = raw ? JSON.parse(raw) : null } catch { errorBody = raw }
    // the provider's own word on when to come back is taken (within a minute); asked to wait longer, the caller gets
    // the error now rather than a run that hangs in a sleep
    const after = retryAfterMs(response.headers.get('retry-after'))
    if (!providerQuotaExhausted(response.status, errorBody) && retryable(response.status) && attempt < maxRetries && (after === null || after <= RETRY_AFTER_CAP_MS)) {
      await sleep(after ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!, signal)
      attempt += 1
      continue
    }
    throw new ModelHTTPError(response.status, modelName, errorBody)
  }
}

/** Where a redirect points, as origin and path (a query may carry what is not the log's to show). */
function redirectTarget(location: string | null, from: URL): string {
  if (!location) return 'an unnamed location'
  try {
    const url = new URL(location, from)
    return `${url.origin}${url.pathname}`
  } catch {
    return 'an unreadable location'
  }
}

/** Wait `ms`, cut short (rejecting with the signal's reason) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return }
    // the run's signal lives as long as the run: a listener left on it after the sleep would pile up per retry
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason ?? new Error('aborted')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface SseMessage { event: string | null; data: string; id: string | null }

/** The server-sent events of a response body, one message at a time (`data:` lines joined by newlines). A body
 *  silent for `idleMs` is a stalled stream: it is cancelled and a TimeoutException raised. */
export async function* readSse(response: Response, modelName: string, idleMs: number = STREAM_IDLE_TIMEOUT_MS): AsyncGenerator<SseMessage, void, undefined> {
  if (!response.body) throw new ModelAPIErrorLike(modelName, 'the response carried no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event: string | null = null
  let id: string | null = null
  let data: string[] = []
  const flush = (): SseMessage | null => {
    if (data.length === 0 && event === null) return null
    const message: SseMessage = { event, data: data.join('\n'), id }
    event = null; id = null; data = []
    return message
  }
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>
      let timer: ReturnType<typeof setTimeout> | undefined
      const silence = new Promise<'silent'>((resolve) => { timer = setTimeout(() => resolve('silent'), idleMs) })
      try {
        const first = await Promise.race([reader.read(), silence])
        if (first === 'silent') {
          void reader.cancel().catch(() => {})
          throw new TransportError('TimeoutException', `the stream from ${modelName} was silent for ${span(idleMs)}`)
        }
        chunk = first
      } catch (error) {
        if (error instanceof TransportError) throw error
        throw new TransportError(transportKind(error), `the stream dropped: ${String((error as Error)?.message ?? error)}`, { cause: error })
      } finally {
        clearTimeout(timer)
      }
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line === '') {
          const message = flush()
          if (message) yield message
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        let value = colon < 0 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
        else if (field === 'id') id = value
      }
    }
    if (buffer.trim()) {
      const line = buffer.trim()
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    const message = flush()
    if (message) yield message
  } finally {
    try { reader.releaseLock() } catch { /* released */ }
  }
}

class ModelAPIErrorLike extends Error {
  constructor(readonly model_name: string, message: string) { super(message); this.name = 'ModelAPIError' }
}

/** A JSON schema as the providers accept it: the draft marker and zod's safe-integer bounds left out. */
export function cleanSchema(schema: Record<string, unknown>, opts: { additionalProperties?: boolean } = {}): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k === '$schema') continue
        if (k === 'additionalProperties' && opts.additionalProperties === false) continue
        if ((k === 'minimum' && v === -9007199254740991) || (k === 'maximum' && v === 9007199254740991)) continue
        out[k] = walk(v)
      }
      return out
    }
    return value
  }
  return walk(schema) as Record<string, unknown>
}

/** Entire final JSON, AFTER signing: no truncation, no canonical-history mutation. 128 MiB is an
 * application memory/safety bound for unknown endpoints, not a claimed Codex provider limit. It permits
 * the legacy 8 x 5 MiB images (55.93 MB base64) plus substantial text/tools. Known provider caps are decimal MB. */
export const MAX_PROVIDER_REQUEST_BYTES = APP_REQUEST_CAP_BYTES
/** The figures are the contract's (PROVIDER_REQUEST_LIMITS): the same ones a native attachment is judged against
 *  before a request is sent (refNativeFor, nativeTotalRefusal); image planning may already have read images. */
export function assertRequestSize(body: string, route: { protocol?: HttpOptions['requestProtocol']; url?: string } = {}): void {
  const limits = requestLimitsFor({ protocol: route.protocol ?? null, url: route.url ?? null })
  const limit = limits.request_bytes
  const basis = limits.key === 'anthropic' || limits.key === 'google' ? limits.basis : 'application safety cap 128 MiB (provider request cap unknown)'
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > limit) throw new Error(`complete provider request is ${bytes} bytes; cap ${limit} bytes (${basis}; including base64/history/tools); nothing was sent`)
  if (limits.key === 'openai_api') {
    // File inputs, NOT images and NOT the complete JSON limit: sum raw bytes, including repeated history inputs.
    let total = 0
    const walk = (v: unknown): void => {
      if (!v || typeof v !== 'object') return
      if (Array.isArray(v)) { for (const item of v) walk(item); return }
      for (const [key, value] of Object.entries(v)) {
        if (key === 'file_data' && typeof value === 'string') {
          const data = /^data:[^,]*;base64,(.*)$/s.exec(value)?.[1]
          if (data !== undefined) {
            const raw = Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
            if (raw >= 50_000_000) throw new Error(`OpenAI input file is ${raw} bytes; per-file cap is strictly less than 50000000 bytes`)
            total += raw
          }
        } else walk(value)
      }
    }
    walk(JSON.parse(body))
    if (total > 50_000_000) throw new Error(`OpenAI input files total ${total} raw bytes; cap 50000000 bytes (separate from JSON/base64 bytes); nothing was sent`)
  }
}
