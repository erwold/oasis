/** The Gemini 4 Argon long-thinking stream probe's machinery (docs/argon-probe-runbook.md). Everything here is pure
 *  or takes its fetch, clock and folders from the caller, and nothing runs on import: the offline suite drives it
 *  with scripted fetches and loopback servers only. The command line is scripts/argon_probe.ts.
 *
 *  What it guarantees, by construction:
 *  - every physical request goes through one FetchBudget: a seat is taken before each request starts (the app's own
 *    postJson retries and any resume hop of the adapter included — they call the same fetch); past the cap, or after
 *    a cancel, the probe's main signal is aborted (so no retry loop waits on) and nothing is sent;
 *  - the summary holds counts, timings, lengths, keyed hashes (HMAC under a salt kept only in the private output
 *    folder) and error names from a whitelist — never an error's own text, the key, a continuationToken, a
 *    thoughtSignature, a prompt or an answer; a last check refuses to write a summary holding any secret it saw;
 *  - the real key goes only to the exact official origin (https, default port, no user info); nothing here reads
 *    the app's database, its credential store or a key file. */

import { createHmac, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FetchLike } from '../src/llm/http.ts'
import { loadValue, type ModelMessage } from '../src/llm/messages.ts'
import { TransportError, type ModelRequestParameters, type ModelSettings } from '../src/llm/model.ts'

// ---- limits, origins, timeouts, prices --------------------------------------------------------------------------

/** No invocation may send more physical requests than this, whatever --max-fetches says. */
export const ABSOLUTE_MAX_FETCHES = 6
/** The idle test's own server costs nothing, but it is still bounded. */
export const IDLE_MAX_REQUESTS = 24
/** The wait before a continuation hop (the same 2 s the 6c840b2 adapter uses; nothing official). */
export const RESUME_DELAY_MS = 2_000
/** The only origin the real key is ever sent to. */
export const GOOGLE_ORIGIN = 'https://generativelanguage.googleapis.com'
/** The server closes a stream after 20 minutes (latest-model guide, as the user quoted it). */
export const ARGON_SERVER_STREAM_LIMIT_MS = 20 * 60_000
/** The raw transport's Bun socket idle timeout by default: 0, sent as `timeout: false` (off) — as the app's Argon route
 *  sends it. Bun's reference names milliseconds for a number, but a numeric value was not seen to take effect on Bun
 *  1.4.0 in a small offline check, while false was; `--socket-idle-ms N` sends a number for an explicit experiment
 *  (record whether it held). The whole-request deadline below bounds the client either way. */
export const RAW_SOCKET_IDLE_MS = 0
/** The raw transport's whole-request deadline (AbortSignal.timeout): never under 20 minutes. */
export const RAW_WHOLE_DEADLINE_MS = 22 * 60_000
/** The app's price list for the Argon route (src/config.ts, paid tier, version 2026-10; it doubles from 2026-12-01):
 *  an estimate for the person, not a quote. */
export const ARGON_PRICE_PER_MTOK = { input: 2, output: 10, from_2026_12_01: { input: 4, output: 20 } }
export const ARGON_STREAM_OUTPUT_CAP = 65_536

/** A message the probe wrote itself (no request or response text in it): the only error text a person sees whole. */
export class ProbeUsageError extends Error {
  constructor(message: string) { super(message); this.name = 'ProbeUsageError' }
}

/** Whether a base URL is exactly the official origin: https, the default port, no user info. A look-alike (http, :8443,
 *  user@host, another host) is not, and never gets the real key. */
export function isOfficialGoogleOrigin(base: string): boolean {
  let url: URL
  try { url = new URL(base) } catch { return false }
  return url.origin === GOOGLE_ORIGIN && url.username === '' && url.password === '' && url.search === '' && url.hash === ''
    && (url.pathname === '/' || url.pathname === '')
}

// ---- the budget -------------------------------------------------------------------------------------------------

export class ProbeBudgetError extends TransportError {
  constructor(max: number) { super('ProbeBudgetExhausted', `probe budget of ${max} physical request(s) used up; nothing more is sent`) }
}
export class ProbeCancelledError extends TransportError {
  constructor() { super('ProbeCancelled', 'the probe was cancelled; nothing more is sent') }
}

/** The one door to the network. A seat is taken before each physical request starts; a request past the cap, or
 *  after a cancel, aborts the probe's main signal (every retry and resume loop listening to it stops at once instead of
 *  sleeping and asking again) and is refused before any byte goes out. Each request's own signal is joined with the
 *  main one, so a cancel also cuts the one in flight. */
export class FetchBudget {
  attempted = 0
  refused = 0
  constructor(readonly max: number, private readonly inner: FetchLike, readonly controller: AbortController) {
    if (!Number.isInteger(max) || max < 0 || max > ABSOLUTE_MAX_FETCHES) throw new ProbeUsageError(`max fetches must be a whole number 0..${ABSOLUTE_MAX_FETCHES}`)
  }

  get cancelled(): boolean { return this.controller.signal.aborted }

  cancel(): void { if (!this.controller.signal.aborted) this.controller.abort(new ProbeCancelledError()) }

  readonly fetch: FetchLike = async (input, init) => {
    if (this.controller.signal.aborted || init?.signal?.aborted) { this.refused += 1; throw new ProbeCancelledError() }
    if (this.attempted >= this.max) {
      this.refused += 1
      const error = new ProbeBudgetError(this.max)
      this.controller.abort(error)
      throw error
    }
    this.attempted += 1
    const signal = init?.signal ? AbortSignal.any([init.signal, this.controller.signal]) : this.controller.signal
    return this.inner(input, { ...init, signal })
  }
}

// ---- errors, by whitelist ---------------------------------------------------------------------------------------

const ERROR_NAMES = new Set(['Error', 'TypeError', 'AbortError', 'TimeoutError', 'DOMException', 'ModelHTTPError', 'ModelAPIError', 'TransportError',
  'ReadError', 'ConnectError', 'TimeoutException', 'NetworkError', 'ProbeBudgetExhausted', 'ProbeCancelled', 'ProbeUsageError', 'CredentialUnavailable', 'SyntaxError',
  'LongDecodeInterrupted', 'ContentEncodingRefused'])
const CATEGORIES: [RegExp, string][] = [
  [/^Gemini long decode interrupted/i, 'long_decode_interrupted'],
  [/socket connection was closed unexpectedly|closed unexpectedly|ConnectionClosed/i, 'socket_closed_unexpectedly'],
  [/ECONNRESET|connection reset|reset by peer/i, 'connection_reset'],
  [/budget of \d+ physical request/i, 'probe_budget'],
  [/probe was cancelled/i, 'probe_cancelled'],
  [/was silent for/i, 'adapter_idle_timeout'],
  [/no response from .* within/i, 'adapter_headers_timeout'],
  [/ended without a finishReason/i, 'eof_without_finish'],
  [/carried no chunks/i, 'no_chunks'],
  [/^Gemini error:/i, 'provider_error_event'],
  [/status_code: \d+/i, 'http_status'],
  [/timed? ?out|timeout/i, 'timeout'],
  [/ECONNREFUSED|Unable to connect|ConnectionRefused/i, 'connect_refused'],
  [/ENOTFOUND|EAI_AGAIN|DNS/i, 'dns'],
  [/certificate|TLS|SSL/i, 'tls'],
  [/abort/i, 'aborted'],
]

export interface ErrorSummary {
  name: string; kind: string | null; code: string | null; status: number | null; category: string
  /** a LongDecodeInterrupted's counts and its last failure's facts (numbers and fixed words only) */
  long_decode?: { resumes: number | null; checkpoints: number | null; hops: number | null; failure: { name: string | null; transport_kind: string | null; status_code: number | null; provider_status: string | null; reason: string | null } | null }
}

/** An error as a summary may hold it: a name, a transport kind and a code from fixed forms, an HTTP status, and a
 *  category matched from its text — never the text itself (a parse error or a provider message can quote the
 *  request or the answer). */
export function errorSummary(error: unknown): ErrorSummary {
  const e = (error ?? {}) as { name?: unknown; kind?: unknown; code?: unknown; status_code?: unknown; message?: unknown }
  const pick = (v: unknown) => (typeof v === 'string' && /^[A-Za-z_]{2,40}$/.test(v) ? v : null)
  const name = typeof e.name === 'string' && ERROR_NAMES.has(e.name) ? e.name : 'other'
  const message = typeof e.message === 'string' ? e.message : String(error)
  const category = CATEGORIES.find(([re]) => re.test(message))?.[1] ?? 'other'
  const summary: ErrorSummary = { name, kind: pick(e.kind), code: pick(e.code), status: typeof e.status_code === 'number' ? e.status_code : null, category }
  if (name === 'LongDecodeInterrupted') {
    const d = ((error as { detail?: unknown }).detail ?? {}) as Record<string, unknown>
    const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e6 ? v : null)
    const f = d.failure && typeof d.failure === 'object' ? d.failure as Record<string, unknown> : null
    const fixed = (v: unknown) => (typeof v === 'string' && /^[A-Za-z_]{1,40}$/.test(v) ? v : null)
    summary.long_decode = {
      resumes: num(d.resumes), checkpoints: num(d.checkpoints), hops: num(d.hops),
      failure: f ? { name: fixed(f.name), transport_kind: fixed(f.transport_kind), status_code: num(f.status_code), provider_status: fixed(f.provider_status), reason: fixed(f.reason) } : null,
    }
  }
  return summary
}

/** Whether BUN_CONFIG_VERBOSE_FETCH turns Bun's request logging on (it prints headers and bodies): any value but
 *  unset, empty, 0 or false. */
export function verboseFetchOn(value: string | undefined): boolean {
  return value !== undefined && !['', '0', 'false'].includes(value.trim().toLowerCase())
}

// ---- keyed hashes -----------------------------------------------------------------------------------------------

/** HMAC-SHA256 under the output folder's private salt, first 16 hex: equal inputs compare equal within the folder,
 *  and a short secret (a two-word answer, a key) cannot be guessed from the summary. */
export function keyedHash(salt: Buffer, value: string | Uint8Array): string {
  return createHmac('sha256', salt).update(value).digest('hex').slice(0, 16)
}

/** JSON with the keys of every object sorted: two bodies equal as JSON have the same canonical text. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, walk((v as Record<string, unknown>)[k])]))
    return v
  }
  return JSON.stringify(walk(value))
}

/** The JSON paths where two values differ (paths only, never the values), at most `limit`. */
export function diffPaths(a: unknown, b: unknown, limit = 20, path = '$', out: string[] = []): string[] {
  if (out.length >= limit) return out
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path} (length ${a.length} vs ${b.length})`)
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffPaths(a[i], b[i], limit, `${path}[${i}]`, out)
    return out
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    for (const k of keys) {
      const inA = k in (a as object), inB = k in (b as object)
      if (!inA || !inB) { if (out.length < limit) out.push(`${path}.${k} (only in ${inA ? 'the first' : 'the second'})`); continue }
      diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], limit, `${path}.${k}`, out)
    }
    return out
  }
  if (JSON.stringify(a) !== JSON.stringify(b) && out.length < limit) out.push(path)
  return out
}

// ---- the request files ------------------------------------------------------------------------------------------

/** A private file: the person's alone (no group or world bits) — it holds the conversation. */
export function assertPrivateFile(path: string): void {
  let mode: number
  try { mode = statSync(path).mode & 0o777 } catch { throw new ProbeUsageError(`cannot read ${path}`) }
  if (mode & 0o077) throw new ProbeUsageError(`${path} is readable by others (mode ${mode.toString(8)}); chmod 600 it first`)
}

function readJsonFile(path: string, what: string): unknown {
  assertPrivateFile(path)
  // a parse error's text quotes the file: it is replaced by a fixed one
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { throw new ProbeUsageError(`the ${what} is not valid JSON`) }
}

/** The Google body file: a GenerateContent body (contents, systemInstruction, tools, generationConfig). One with a
 *  continuationToken is refused — a token belongs to the stream that issued it, never to a fresh probe. */
export function loadGoogleBody(path: string): Record<string, unknown> {
  const data = readJsonFile(path, 'Google body file')
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ProbeUsageError('the Google body file must be a JSON object (a GenerateContent body)')
  const body = data as Record<string, unknown>
  if (!Array.isArray(body.contents) || body.contents.length === 0) throw new ProbeUsageError('the Google body file has no contents[]: it must be the GenerateContent body itself')
  if ('continuationToken' in body) throw new ProbeUsageError('the Google body file carries a continuationToken: remove it (a probe starts a fresh stream)')
  return body
}

export const APP_REQUEST_FORMAT = 'oasis-app-request-v1'

/** The app's own request, as the app holds it: the history (hydrated: attachments with their bytes), the settings
 *  and the request parameters the runner passed — and, optionally, the wire body the person expects them to make. */
export interface AppRequest {
  format: typeof APP_REQUEST_FORMAT
  messages: ModelMessage[]
  settings: ModelSettings
  params: ModelRequestParameters
  expected_body: Record<string, unknown> | null
}

export function loadAppRequest(path: string): AppRequest {
  const data = readJsonFile(path, 'app request file') as Record<string, unknown> | null
  if (!data || typeof data !== 'object' || data.format !== APP_REQUEST_FORMAT) throw new ProbeUsageError(`the app request file must be an object with format "${APP_REQUEST_FORMAT}"`)
  let messages: ModelMessage[]
  // a schema error's text quotes the history: it is replaced by a fixed one
  try { messages = loadValue(data.messages) } catch { throw new ProbeUsageError('the app request file\'s messages are not in the app\'s history format') }
  const settings = data.settings
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new ProbeUsageError('the app request file needs settings (an object)')
  const params = data.params as Record<string, unknown> | undefined
  if (!params || !Array.isArray(params.function_tools) || typeof params.allow_text_output !== 'boolean' || !('thinking' in params)) {
    throw new ProbeUsageError('the app request file needs params { function_tools: [], allow_text_output, thinking }')
  }
  const expected = data.expected_body
  if (expected !== undefined && expected !== null && (typeof expected !== 'object' || Array.isArray(expected))) throw new ProbeUsageError('expected_body must be an object')
  return { format: APP_REQUEST_FORMAT, messages, settings: settings as ModelSettings, params: params as unknown as ModelRequestParameters, expected_body: (expected as Record<string, unknown> | undefined) ?? null }
}

export interface BodyShape {
  body_bytes: number
  contents: number
  roles: string
  parts: Record<string, number>
  tools: number
  thinking_level: string | null
  include_thoughts: boolean | null
  max_output_tokens: number | null
  top_level_fields: string[]
  approx_input_tokens: number
}

export function bodyShape(body: Record<string, unknown>): BodyShape {
  const contents = (body.contents as { role?: string; parts?: Record<string, unknown>[] }[] | undefined) ?? []
  const parts: Record<string, number> = {}
  const bump = (k: string) => { parts[k] = (parts[k] ?? 0) + 1 }
  for (const turn of contents) {
    for (const part of turn.parts ?? []) {
      if (typeof part.text === 'string') bump(part.thought ? 'thought_text' : 'text')
      if (part.functionCall) bump('functionCall')
      if (part.functionResponse) bump('functionResponse')
      if (part.inline_data || part.inlineData) bump('inline_data')
      if (part.file_data || part.fileData) bump('file_data')
      if (typeof part.thoughtSignature === 'string') bump('thoughtSignature')
    }
  }
  const gen = (body.generationConfig ?? {}) as Record<string, unknown>
  const thinking = (gen.thinkingConfig ?? {}) as Record<string, unknown>
  const tools = (body.tools as { functionDeclarations?: unknown[] }[] | undefined) ?? []
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8')
  return {
    body_bytes: bytes,
    contents: contents.length,
    roles: contents.map((c) => (c.role === 'model' ? 'M' : c.role === 'user' ? 'U' : '?')).join(''),
    parts,
    tools: tools.reduce((n, t) => n + (t.functionDeclarations?.length ?? 0), 0),
    thinking_level: typeof thinking.thinkingLevel === 'string' ? thinking.thinkingLevel : null,
    include_thoughts: typeof thinking.includeThoughts === 'boolean' ? thinking.includeThoughts : null,
    max_output_tokens: typeof gen.maxOutputTokens === 'number' ? gen.maxOutputTokens : null,
    top_level_fields: Object.keys(body).sort(),
    // a rough figure for the cost estimate only (about 4 bytes a token for text; base64 media is far off)
    approx_input_tokens: Math.ceil(bytes / 4),
  }
}

/** Every string of a request the summary must never contain: texts (a prompt, a tool result, an argument) of 16+
 *  characters, and signatures and inline data of 8+. */
export function requestSecrets(value: unknown): string[] {
  const out: string[] = []
  const walk = (v: unknown, key: string | null): void => {
    if (typeof v === 'string') {
      if (key !== null && /signature|^data$/i.test(key)) { if (v.length >= 8) out.push(v) }
      else if (v.length >= 16) out.push(v)
      return
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, key); return }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k)
  }
  walk(value, null)
  return out
}

/** A rough money figure for the person — never a limit. The only hard limit is the number of physical requests
 *  (FetchBudget). The input is guessed from the body's bytes (about 4 a token; base64 media is far off), a resume hop
 *  re-sends the whole input and may carry generated context besides, and a dropped request may still be billed. The
 *  price list is the app's (src/config.ts) for the date the probe runs: 2026-10 until 2026-11-30, 2026-12 from
 *  2026-12-01. */
export function costEstimate(shape: BodyShape, physicalRequests: number, now: Date = new Date()): Record<string, unknown> {
  const later = now.getTime() >= Date.UTC(2026, 11, 1)
  const price = later ? ARGON_PRICE_PER_MTOK.from_2026_12_01 : { input: ARGON_PRICE_PER_MTOK.input, output: ARGON_PRICE_PER_MTOK.output }
  const out = Math.min(shape.max_output_tokens ?? ARGON_STREAM_OUTPUT_CAP, ARGON_STREAM_OUTPUT_CAP)
  const perRequest = (shape.approx_input_tokens * price.input + out * price.output) / 1_000_000
  return {
    basis: `a rough estimate, not a quote and not a limit: the app's price list for google:gemini-4-argon (paid tier, version ${later ? '2026-12' : '2026-10'}: $${price.input} in / $${price.output} out per Mtok) and an input guessed from the body's bytes`,
    price_version: later ? '2026-12' : '2026-10',
    approx_input_tokens: shape.approx_input_tokens,
    max_output_tokens_per_request: out,
    rough_estimate_usd_per_request: Math.round(perRequest * 100) / 100,
    physical_requests: physicalRequests,
    rough_estimate_usd: Math.round(perRequest * physicalRequests * 100) / 100,
    hard_limit: 'only the number of physical requests is enforced (--max-fetches); no amount of money is guaranteed',
    note: 'the user reported about $0.6-1.2 per high request from experience (not a quote); a resume hop re-sends the whole input (and may carry generated context) and is billed as a request; a dropped request may still be billed for what was generated',
  }
}

// ---- the stream meter -------------------------------------------------------------------------------------------

export interface Checkpoint { at_ms: number; at_bytes: number; gap_before_ms: number; token_len: number; token_hash: string; output_tokens: number | null }

export interface StreamScan {
  sse_events: number
  error_event_status: string | null
  finish_reason: string | null
  usage: { prompt: number | null; cached: number | null; candidates: number | null; thoughts: number | null; total: number | null } | null
  text_chars: number
  thought_chars: number
  function_calls: number
  signatures: number
  checkpoints: Checkpoint[]
}

/** Reads the SSE bytes as they arrive (beside whoever consumes them) and keeps what the summary may hold. The
 *  continuationTokens and signatures it sees go into `secrets`; the last token stays in memory (`lastToken`) for a
 *  raw resume and is never written. */
export class SseScanner {
  readonly scan: StreamScan = { sse_events: 0, error_event_status: null, finish_reason: null, usage: null, text_chars: 0, thought_chars: 0, function_calls: 0, signatures: 0, checkpoints: [] }
  lastToken: string | null = null
  private buffer = ''
  private data: string[] = []
  private readonly decoder = new TextDecoder()
  constructor(private readonly salt: Buffer, readonly secrets: Set<string>) {}

  push(bytes: Uint8Array, at: { ms: number; bytes: number; gap_before_ms: number }): void {
    this.buffer += this.decoder.decode(bytes, { stream: true })
    let i: number
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, i)
      this.buffer = this.buffer.slice(i + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line === '') { this.flush(at); continue }
      if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''))
    }
  }

  end(at: { ms: number; bytes: number; gap_before_ms: number }): void {
    if (this.buffer.trim().startsWith('data:')) this.data.push(this.buffer.trim().slice(5).trimStart())
    this.buffer = ''
    this.flush(at)
  }

  private flush(at: { ms: number; bytes: number; gap_before_ms: number }): void {
    if (this.data.length === 0) return
    const text = this.data.join('\n')
    this.data = []
    this.scan.sse_events += 1
    let chunk: Record<string, unknown>
    try { chunk = JSON.parse(text) } catch { return }
    if (chunk.error) {
      const e = chunk.error as Record<string, unknown>
      const status = String(e.status ?? e.code ?? 'error')
      this.scan.error_event_status = /^[A-Z_0-9]{1,40}$/.test(status) ? status : 'error'
    }
    const u = chunk.usageMetadata as Record<string, unknown> | undefined
    if (u) {
      const n = (x: unknown) => (typeof x === 'number' ? x : null)
      this.scan.usage = { prompt: n(u.promptTokenCount), cached: n(u.cachedContentTokenCount), candidates: n(u.candidatesTokenCount), thoughts: n(u.thoughtsTokenCount), total: n(u.totalTokenCount) }
    }
    const candidate = ((chunk.candidates as Record<string, unknown>[] | undefined) ?? [])[0]
    const parts = ((candidate?.content as { parts?: Record<string, unknown>[] } | undefined)?.parts) ?? []
    for (const part of parts) {
      if (typeof part.text === 'string') { if (part.thought) this.scan.thought_chars += part.text.length; else this.scan.text_chars += part.text.length }
      if (part.functionCall) this.scan.function_calls += 1
      if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) { this.scan.signatures += 1; this.secrets.add(part.thoughtSignature) }
    }
    // the long-decode guide puts the token on the candidate; a top-level one is taken as well
    const token = typeof candidate?.continuationToken === 'string' ? candidate.continuationToken : typeof chunk.continuationToken === 'string' ? chunk.continuationToken : null
    if (token) {
      this.secrets.add(token)
      this.lastToken = token
      const usage = this.scan.usage
      const output = usage && (usage.candidates !== null || usage.thoughts !== null) ? (usage.candidates ?? 0) + (usage.thoughts ?? 0) : null
      this.scan.checkpoints.push({ at_ms: at.ms, at_bytes: at.bytes, gap_before_ms: at.gap_before_ms, token_len: token.length, token_hash: keyedHash(this.salt, token), output_tokens: output })
    }
    if (typeof candidate?.finishReason === 'string') this.scan.finish_reason = /^[A-Z_]{1,40}$/.test(candidate.finishReason) ? candidate.finishReason : 'OTHER'
  }
}

export interface WireRecord {
  seq: number
  label: string
  url_origin_path: string
  request_bytes: number
  /** the body's keyed hash with any continuationToken taken out: equal to the input's when the same body went out */
  body_hash_canonical: string | null
  resume_token_hash: string | null
  /** the Bun socket idle timeout this request was sent with (`init.timeout`), or 'bun-default' when none was set */
  socket_idle_timeout: number | boolean | 'bun-default'
  status: number | null
  headers_ms: number | null
  first_byte_ms: number | null
  last_byte_ms: number | null
  end: 'eof' | 'error' | 'cancelled' | 'fetch_error' | 'open'
  end_ms: number | null
  /** from the last byte (or the headers, when no byte came) to the end: the silence the connection died in */
  silence_at_end_ms: number | null
  bytes: number
  reads: number
  max_gap_ms: number
  top_gaps_ms: number[]
  gaps_over_s: Record<'30' | '45' | '55' | '60' | '75', number>
  error: ErrorSummary | null
  scan: StreamScan
}

const GAP_MARKS = [30, 45, 55, 60, 75] as const

/** A fetch whose response bodies are metered as they are read (time to headers, first byte, every gap between
 *  reads, how the body ended, the silence before the end) and scanned as SSE; the consumer reads the same bytes. */
export function meteredFetch(inner: FetchLike, opts: { salt: Buffer; secrets: Set<string>; now?: () => number; label: () => string; onRecord: (r: WireRecord, scanner: SseScanner) => void }): FetchLike {
  const now = opts.now ?? Date.now
  let seq = 0
  return async (input, init) => {
    seq += 1
    const t0 = now()
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const body = typeof init?.body === 'string' ? init.body : null
    let parsed: Record<string, unknown> | null = null
    try { parsed = body ? JSON.parse(body) as Record<string, unknown> : null } catch { parsed = null }
    const token = parsed && typeof parsed.continuationToken === 'string' ? parsed.continuationToken : null
    if (token) opts.secrets.add(token)
    const withoutToken = parsed ? Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== 'continuationToken')) : null
    const scanner = new SseScanner(opts.salt, opts.secrets)
    const timeout = (init as { timeout?: unknown } | undefined)?.timeout
    const record: WireRecord = {
      seq, label: opts.label(), url_origin_path: `${url.origin}${url.pathname}`, request_bytes: body ? Buffer.byteLength(body, 'utf8') : 0,
      body_hash_canonical: withoutToken ? keyedHash(opts.salt, canonicalJson(withoutToken)) : null, resume_token_hash: token ? keyedHash(opts.salt, token) : null,
      socket_idle_timeout: typeof timeout === 'number' || typeof timeout === 'boolean' ? timeout : 'bun-default',
      status: null, headers_ms: null, first_byte_ms: null, last_byte_ms: null, end: 'open', end_ms: null, silence_at_end_ms: null, bytes: 0, reads: 0,
      max_gap_ms: 0, top_gaps_ms: [], gaps_over_s: { '30': 0, '45': 0, '55': 0, '60': 0, '75': 0 }, error: null, scan: scanner.scan,
    }
    const emit = () => opts.onRecord(record, scanner)
    let response: Response
    try {
      response = await inner(input, init)
    } catch (error) {
      const t = now() - t0
      record.end = 'fetch_error'; record.end_ms = t; record.silence_at_end_ms = t
      record.error = errorSummary(error)
      emit()
      throw error
    }
    record.status = response.status
    record.headers_ms = now() - t0
    emit()
    if (!response.body) { record.end = 'eof'; record.end_ms = record.headers_ms; emit(); return response }
    const reader = response.body.getReader()
    let last = record.headers_ms
    const finish = (end: WireRecord['end'], error?: unknown) => {
      if (record.end !== 'open') return
      const t = now() - t0
      record.end = end; record.end_ms = t; record.silence_at_end_ms = t - (record.last_byte_ms ?? record.headers_ms ?? 0)
      if (error !== undefined) record.error = errorSummary(error)
      scanner.end({ ms: t, bytes: record.bytes, gap_before_ms: 0 })
      emit()
    }
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let chunk: Awaited<ReturnType<typeof reader.read>>
        try { chunk = await reader.read() } catch (error) { finish('error', error); controller.error(error); return }
        if (chunk.done) { finish('eof'); controller.close(); return }
        const t = now() - t0
        const gap = t - last
        last = t
        record.reads += 1
        record.bytes += chunk.value.byteLength
        if (record.first_byte_ms === null) record.first_byte_ms = t
        record.last_byte_ms = t
        if (gap > record.max_gap_ms) record.max_gap_ms = gap
        record.top_gaps_ms = [...record.top_gaps_ms, gap].sort((a, b) => b - a).slice(0, 5)
        for (const mark of GAP_MARKS) if (gap >= mark * 1000) record.gaps_over_s[String(mark) as keyof WireRecord['gaps_over_s']] += 1
        scanner.push(chunk.value, { ms: t, bytes: record.bytes, gap_before_ms: gap })
        controller.enqueue(chunk.value)
      },
      cancel(reason) {
        finish('cancelled', reason)
        return reader.cancel(reason).catch(() => {})
      },
    })
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}

// ---- outcomes ---------------------------------------------------------------------------------------------------

/** How the connection ended — the network's side. */
export type TransportOutcome = 'clean_eof' | 'http_status' | 'dropped_before_headers' | 'dropped_before_first_byte' | 'dropped_mid_stream' | 'cancelled' | 'open'
/** How the model's response ended — the provider's side. `stop_text_candidate` (STOP with at least the threshold of
 *  words) and `stop_tool_call` say only that this one response ended normally: whether the task got a complete final
 *  answer is never judged here — a person reads the private answer file (--save-text) for that. A tool call needs the
 *  tool's result and another request; a MAX_TOKENS whose thinking filled the cap with a few words is no answer. */
export type ResponseOutcome = 'stop_text_candidate' | 'stop_tool_call' | 'stop_without_text' | 'max_tokens' | 'continuation' | 'filtered' | 'provider_error' | 'no_finish' | 'none'

export function outcomeOf(r: WireRecord, minTextChars = 40): { transport: TransportOutcome; response: ResponseOutcome; final_answer: 'manual_review_needed' } {
  let transport: TransportOutcome
  if (r.end === 'open') transport = 'open'
  else if (r.end === 'cancelled' || r.error?.name === 'ProbeCancelled' || r.error?.category === 'probe_cancelled') transport = 'cancelled'
  else if (r.end === 'fetch_error') transport = 'dropped_before_headers'
  else if (r.status !== null && (r.status < 200 || r.status >= 300)) transport = 'http_status'
  else if (r.end === 'error') transport = r.first_byte_ms === null ? 'dropped_before_first_byte' : 'dropped_mid_stream'
  else transport = 'clean_eof'
  const f = r.scan.finish_reason
  let response: ResponseOutcome
  if (r.scan.error_event_status) response = 'provider_error'
  else if (f === null) response = r.status === null || transport === 'http_status' ? 'none' : 'no_finish'
  else if (f === 'STOP') response = r.scan.function_calls > 0 ? 'stop_tool_call' : r.scan.text_chars >= minTextChars ? 'stop_text_candidate' : 'stop_without_text'
  else if (f === 'MAX_TOKENS') response = 'max_tokens'
  else if (f === 'CONTINUATION') response = 'continuation'
  else if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'ESCALATION', 'PUP_LIMITED_DISABLED'].includes(f)) response = 'filtered'
  else response = 'provider_error'
  return { transport, response, final_answer: 'manual_review_needed' }
}

// ---- private output ---------------------------------------------------------------------------------------------

/** The output folder: created 0700 (an existing one must not be open to others), with the salt the keyed hashes use
 *  (0600, never printed). */
export function prepareOutputDir(dir: string): { salt: Buffer } {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const mode = statSync(dir).mode & 0o777
  if (mode & 0o077) throw new ProbeUsageError(`the output folder ${dir} is open to others (mode ${mode.toString(8)}); use a private one (chmod 700)`)
  const saltPath = join(dir, '.salt')
  if (!existsSync(saltPath)) writeFileSync(saltPath, randomBytes(32).toString('hex'), { mode: 0o600 })
  const salt = Buffer.from(readFileSync(saltPath, 'utf8').trim(), 'hex')
  if (salt.length !== 32) throw new ProbeUsageError('the output folder salt is damaged; remove .salt to start a new folder')
  return { salt }
}

/** Refuses (throws, writes nothing) when the text holds any secret the probe saw. */
export function assertNoSecrets(text: string, secrets: Iterable<string>): void {
  for (const s of secrets) {
    if (!s || s.length < 8) continue
    const probe = s.length > 64 ? s.slice(0, 64) : s
    if (text.includes(probe)) throw new ProbeUsageError('refusing to write: the summary would contain a key, token, signature or request text')
  }
}

export function writePrivateJson(path: string, value: unknown, secrets: Iterable<string>): string {
  const text = JSON.stringify(value, null, 2) + '\n'
  assertNoSecrets(text, secrets)
  writeFileSync(path, text, { mode: 0o600 })
  chmodSync(path, 0o600)
  return text
}

/** The proxy variables of this process as a summary may name them: scheme, host and port, never a user or password. */
export function proxyEnvironment(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) {
    const v = env[name]
    if (v === undefined) continue
    if (/no_proxy/i.test(name)) { out[name] = v.length > 200 ? `${v.slice(0, 200)}…` : v; continue }
    try { const u = new URL(v); out[name] = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}` } catch { out[name] = '(unparsable)' }
  }
  return out
}

// ---- the idle test's endpoint -----------------------------------------------------------------------------------

export interface IdlePlan {
  /** seconds of silence before each data chunk after the first; the stream ends after the last */
  gaps_s: number[]
  /** seconds the server waits, after reading the whole request, before it sends the response headers */
  headers_delay_s: number
  /** a comment line (`: hb`) every this many seconds inside each gap; 0 = none */
  heartbeat_s: number
  /** padding of each data chunk (the Gemini checkpoint chunks were 140-230 KB) */
  chunk_bytes: number
}

export function parseIdlePlan(value: unknown): IdlePlan {
  const v = (value ?? {}) as Record<string, unknown>
  const num = (x: unknown, d: number, max: number) => { const n = x === undefined ? d : Number(x); if (!Number.isFinite(n) || n < 0 || n > max) throw new ProbeUsageError('bad idle plan'); return n }
  const gaps = Array.isArray(v.gaps_s) ? v.gaps_s.map((g) => num(g, 0, 1200)) : []
  if (gaps.length === 0 || gaps.length > 20) throw new ProbeUsageError('bad idle plan: 1-20 gaps')
  return { gaps_s: gaps, headers_delay_s: num(v.headers_delay_s, 0, 1200), heartbeat_s: num(v.heartbeat_s, 0, 600), chunk_bytes: Math.floor(num(v.chunk_bytes, 64, 1_000_000)) }
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) { resolve(); return }
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
})

export type IdleLog = (event: Record<string, unknown>) => void

/** The controlled endpoint's handler: POST /idle with the shared secret in `x-idle-probe-secret` and `{ plan }` as
 *  JSON. It reads the whole request (a request was really made — not a bare TLS handshake), optionally waits before
 *  the headers, then sends one SSE chunk, the planned silences and a closing `done` chunk — and logs on its own side
 *  when the client went away, which the client cannot see. Serve it with Bun.serve({ idleTimeout: 0 }): Bun's own
 *  server default (10 s) would cut the test itself. */
export function idleHandler(opts: { secret: string; log: IdleLog; now?: () => number }): (req: Request, ip?: string | null) => Promise<Response> {
  const now = opts.now ?? Date.now
  let counter = 0
  return async (req, ip) => {
    const url = new URL(req.url)
    if (url.pathname !== '/idle' || req.method !== 'POST') return new Response('not found', { status: 404 })
    const given = req.headers.get('x-idle-probe-secret') ?? ''
    if (opts.secret.length < 16 || !timingSafeEqualText(given, opts.secret)) return new Response('forbidden', { status: 403 })
    const id = `r${++counter}-${randomBytes(3).toString('hex')}`
    const t0 = now()
    const raw = await req.text()
    let plan: IdlePlan
    try { plan = parseIdlePlan((JSON.parse(raw) as { plan?: unknown }).plan) } catch { return new Response('bad plan', { status: 400 }) }
    opts.log({ id, ev: 'request', request_bytes: Buffer.byteLength(raw), remote: ip ?? null, plan })
    if (plan.headers_delay_s > 0) {
      await sleep(plan.headers_delay_s * 1000, req.signal)
      if (req.signal.aborted) { opts.log({ id, ev: 'client_gone_before_headers', t_ms: now() - t0 }); return new Response(null, { status: 499 }) }
    }
    const abort = new AbortController()
    const pad = 'x'.repeat(Math.max(0, plan.chunk_bytes))
    const enc = new TextEncoder()
    let gone = false
    const goneAt = (via: string) => { if (!gone) { gone = true; abort.abort(); opts.log({ id, ev: 'client_gone', via, t_ms: now() - t0 }) } }
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (s: string): boolean => {
          if (gone) return false
          try { controller.enqueue(enc.encode(s)); return true } catch { goneAt('enqueue'); return false }
        }
        opts.log({ id, ev: 'headers_sent', t_ms: now() - t0 })
        send(`data: ${JSON.stringify({ i: 0, pad })}\n\n`)
        for (let i = 0; i < plan.gaps_s.length && !gone; i++) {
          const gapEnd = now() + plan.gaps_s[i]! * 1000
          while (!gone && now() < gapEnd) {
            const wait = plan.heartbeat_s > 0 ? Math.min(plan.heartbeat_s * 1000, gapEnd - now()) : gapEnd - now()
            await sleep(wait, abort.signal)
            if (!gone && plan.heartbeat_s > 0 && now() < gapEnd) send(': hb\n\n')
          }
          if (gone) break
          send(`data: ${JSON.stringify({ i: i + 1, after_gap_s: plan.gaps_s[i], pad })}\n\n`)
          opts.log({ id, ev: 'chunk', i: i + 1, t_ms: now() - t0 })
        }
        if (!gone) {
          send(`data: ${JSON.stringify({ done: true })}\n\n`)
          opts.log({ id, ev: 'done', t_ms: now() - t0 })
          try { controller.close() } catch { /* gone */ }
        }
      },
      cancel() { goneAt('cancel') },
    })
    req.signal.addEventListener('abort', () => goneAt('request_signal'), { once: true })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-idle-probe-id': id } })
  }
}

function timingSafeEqualText(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

/** Reads an idle-test response to its end and says whether the `done` chunk arrived. */
export async function readIdleResponse(response: Response): Promise<{ done: boolean; chunks: number; error: ErrorSummary | null }> {
  if (!response.body) return { done: false, chunks: 0, error: null }
  const reader = response.body.getReader()
  const dec = new TextDecoder()
  let text = ''
  let chunks = 0
  try {
    for (;;) {
      const r = await reader.read()
      if (r.done) break
      text += dec.decode(r.value, { stream: true })
      let i: number
      while ((i = text.indexOf('\n\n')) >= 0) {
        const block = text.slice(0, i)
        text = text.slice(i + 2)
        if (block.startsWith('data:')) {
          chunks += 1
          if (block.includes('"done":true')) { void reader.cancel().catch(() => {}); return { done: true, chunks, error: null } }
        }
      }
    }
    return { done: false, chunks, error: null }
  } catch (error) {
    return { done: false, chunks, error: errorSummary(error) }
  }
}
