/** The model interface every provider mapping implements and every wrapper (the usage meter, the request slot, the
 *  wire projection) composes: one request or one streamed request over the harness's message model, with the
 *  settings, the tool definitions and a cancellation signal; the stream's vocabulary is the one the runner maps. */

import type { ModelMessage, ModelResponse, RequestUsage, ResponsePart } from './messages.ts'

export type JsonSchema = Record<string, unknown>

export interface ToolDefinition {
  name: string
  description: string
  parameters_json_schema: JsonSchema
}

/** The unified thinking level: a level, `false` (off), or null (the provider's default). */
export type ThinkingSetting = string | false | null

/** An OpenAI Responses route's reasoning mode: a dimension of its own beside the effort (`pro` is not an effort
 *  level, and `xhigh` is not pro); null leaves it out. Only the API route takes it: the Codex subscription route
 *  ignores the setting (its adapter never sends it). */
export type ReasoningMode = 'pro' | null

export interface ModelSettings {
  max_tokens?: number
  thinking?: ThinkingSetting
  reasoning_mode?: ReasoningMode
  temperature?: number
  /** The session this request belongs to, as the routing hint an OpenAI route sends (`prompt_cache_key`, and on the
   *  Codex route the headers that name the thread): one value for every request of the session, whatever run (or
   *  relay participant, or interaction step) it comes in — it routes only; the cache matches each prefix itself. */
  cache_key?: string | null
  /** How long an Anthropic prompt-cache entry lives (the route's `cache_ttl`). */
  cache_ttl?: '5m' | '1h'
}

export interface ModelRequestParameters {
  function_tools: ToolDefinition[]
  allow_text_output: boolean
  /** the thinking level as the adapter reads it (lifted from the settings when the model's profile can think) */
  thinking: ThinkingSetting
  /** tools the provider runs itself that this request declares (only ones the model's profile names) */
  builtin_tools?: BuiltinTool[]
}

/** A tool the provider runs on its own side: its web search, at most `max_uses` searches in one response. */
export interface BuiltinTool { kind: 'web_search'; max_uses: number }

export interface ModelProfile {
  supports_thinking: boolean
  /** the provider-run tools this route can declare (its web search) */
  builtin_tools?: BuiltinTool['kind'][]
}

export type PartDelta =
  | { part_kind: 'text'; content_delta: string }
  | { part_kind: 'thinking'; content_delta?: string; signature_delta?: string }
  | { part_kind: 'tool-call'; args_delta?: string }
  | { part_kind: 'builtin-tool-call'; args_delta?: string }
  | { part_kind: 'citation'; citation: Record<string, unknown> }

export type StreamEvent =
  | { type: 'part_start'; index: number; part: ResponsePart }
  | { type: 'part_delta'; index: number; delta: PartDelta }
  | { type: 'part_end'; index: number; part: ResponsePart }

export interface StreamedResponse {
  /** The events, in order; the response is complete once the iterator ends. */
  events(): AsyncGenerator<StreamEvent, void, undefined>
  /** The complete response (valid after `events()` finished). */
  get(): ModelResponse
  /** the provider's count so far (null: none reported) */
  usage(): RequestUsage | null
  readonly model_name: string | null
}

export interface RequestContext {
  signal?: AbortSignal
}

export interface Model {
  readonly model_name: string
  /** The provider system the responses are stamped with (`provider_name`); the handoff keys on it. */
  readonly system: string | null
  /** The route its responses are stamped with (provider, endpoint, model): the one their reasoning, signatures and
   *  item ids go back to. Null for a model that stamps none. */
  readonly route?: string | null
  readonly profile: ModelProfile
  request(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<ModelResponse>
  requestStream(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<StreamedResponse>
  countTokens?(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters): Promise<RequestUsage>
  close?(): Promise<void>
}

// ---- errors -----------------------------------------------------------------------------------------------

/** The provider answered with an HTTP status. */
export class ModelHTTPError extends Error {
  readonly status_code: number
  readonly model_name: string
  readonly body: unknown
  constructor(statusCode: number, modelName: string, body: unknown, message?: string) {
    super(message ?? `status_code: ${statusCode}, model_name: ${modelName}, body: ${bodyText(body)}`)
    this.name = 'ModelHTTPError'
    this.status_code = statusCode
    this.model_name = modelName
    this.body = body
  }
}

function bodyText(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 500)
  try { return JSON.stringify(body).slice(0, 500) } catch { return String(body) }
}

/** The provider's stream or answer was not what the protocol promises (no status behind it). */
export class ModelAPIError extends Error {
  readonly model_name: string
  /** provider_code is a sanitized diagnostic code, never the raw error envelope. */
  constructor(modelName: string, message: string, readonly provider_code: string | null = null) {
    super(message)
    this.name = 'ModelAPIError'
    this.model_name = modelName
  }
}

/** A transport failure on the way to the provider: a dropped connection, a timeout, a reset. */
export class TransportError extends Error {
  readonly kind: string
  constructor(kind: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = kind
    this.kind = kind
  }
}

/** Error-envelope words for classification only, never a safe-to-display message. Do not scan echoed requests. */
export function providerErrorText(body: unknown): string {
  if (typeof body === 'string') return body
  if (!body || typeof body !== 'object') return ''
  const b = body as Record<string, unknown>
  const nested = b.error && typeof b.error === 'object' ? b.error as Record<string, unknown> : {}
  return [b.message, b.code, b.type, typeof b.error === 'string' ? b.error : null, nested.message, nested.code, nested.type]
    .filter((v): v is string => typeof v === 'string').join(' ')
}

/** A spent balance is not a transient rate limit. Keep this narrower than PROVIDER_QUOTA_WORDS: words like
 *  billing, quota or credit balance alone do not prove exhaustion. 401 remains a credential refusal.
 *  Anthropic documents the credit-balance wording, not a fixed HTTP status:
 *  https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers (checked 2026-10-25). */
export function providerQuotaExhausted(status: number, body: unknown): boolean {
  if (status === 401 || status < 400) return false
  if (status === 402) return true
  const text = providerErrorText(body)
  // Explicit balance evidence wins even when the same envelope also mentions a rate limit.
  if (/\binsufficient_quota\b|\binsufficient[_ -](?:credits?|funds|balance)\b|\bcredit\s*balance\s+(?:is\s+)?(?:too low|insufficient|exhausted|depleted)\b|\bcredits?\s+(?:(?:are|is)\s+)?(?:exhausted|depleted)\b|\bpayment required\b/i.test(text)) return true
  // Generic quota wording also describes renewable request/token allowances.
  return !PROVIDER_RATE_LIMIT_WORDS.test(text)
    && /\binsufficient[ -]quota\b|\b(?:quota|usage[ _-]?limit|plan limit)\s+(?:(?:has been|is)\s+)?(?:exceeded|exhausted|reached)\b|\bexceeded (?:your |the )?(?:current )?quota\b/i.test(text)
}

/** Short-cycle limits, used only on allowlisted provider error fields. */
export const PROVIDER_RATE_LIMIT_WORDS = /rate[_ -]?limit|too many requests|\bper[ _-]+(?:second|minute)\b|\b(?:requests?|tokens?)[ _-]*\/[ _-]*(?:s|sec(?:ond)?|m|min(?:ute)?)\b|\b(?:RPM|TPM|RPS|TPS)\b/i

/** Broader provider vocabulary used by protocol-specific error normalization, not a retry decision. */
export const PROVIDER_QUOTA_WORDS = /quota|insufficient_quota|usage[ _-]?limit|billing|credit balance|credits? (are|is) (exhausted|depleted)|payment required|plan limit/i
export const PROVIDER_MODEL_GONE_WORDS = /model.*(not found|does not exist|not available|unsupported|unknown)|no such model|invalid model/i
export const PROVIDER_CONTEXT_WORDS = /context|too (long|many tokens)|maximum.*tokens|prompt is too long/i

/** What ended a long decode, as facts only — never the failure itself, whose message or body (a provider's error)
 *  may quote the request, a continuation token or a thought signature back: a name and a transport kind from fixed
 *  forms, the HTTP status (or an in-stream error's code), the provider's status word, and which refusal its words named. */
export interface LongDecodeFailure {
  name: string
  transport_kind: string | null
  status_code: number | null
  provider_status: string | null
  reason: 'quota' | 'model_unavailable' | 'context_overflow' | null
}

/** A long decode (Gemini 4 Argon past its first checkpoint) whose stream kept dropping: the resumes from the last
 *  checkpoint this request may make are spent (or a resume was refused), and the answer is not whole. Deliberately no
 *  TransportError and no cause chain to one: the runner's transport recovery would send the whole request again from
 *  the start — every token up to the checkpoint thought (and billed) again, on the same network path that cut it —
 *  so the run ends instead, with its words up to the last checkpoint shown. The last failure is named in the message
 *  (masked, cut short) and kept as `detail.failure` facts for the diagnosis: never the raw error, never a `cause`
 *  (whose chain the runner reads). */
export class LongDecodeInterrupted extends Error {
  constructor(readonly model_name: string, message: string,
    readonly detail: { resumes: number; checkpoints: number; hops: number; last_error: string; failure: LongDecodeFailure | null }) {
    super(message)
    this.name = 'LongDecodeInterrupted'
  }
}

/** Whether a response came of a long decode that passed its first checkpoint (google.ts marks it in its
 *  provider_details): an end short of a whole answer there is not asked again in a new request by the loop. */
export function pastLongDecodeCheckpoint(response: { provider_details?: Record<string, unknown> | null }): boolean {
  const ld = response.provider_details?.long_decode as { checkpoints?: unknown; hops?: unknown } | undefined
  return !!ld && ((typeof ld.checkpoints === 'number' && ld.checkpoints > 0) || (typeof ld.hops === 'number' && ld.hops > 0))
}

export class UsageLimitExceeded extends Error {
  constructor(message: string) { super(message); this.name = 'UsageLimitExceeded' }
}

export class RunCancelled extends Error {
  constructor(message = 'the run was cancelled') { super(message); this.name = 'RunCancelled' }
}

/** A tool asks the model to try again with a different call (its message becomes the retry prompt). */
export class ModelRetry extends Error {
  constructor(message: string) { super(message); this.name = 'ModelRetry' }
}

export class UnexpectedModelBehavior extends Error {
  constructor(message: string) { super(message); this.name = 'UnexpectedModelBehavior' }
}

/** A cancellation token: `cancel()` flips it and aborts what listens (a request in flight). */
export class CancellationToken {
  private readonly controller = new AbortController()
  get cancelled(): boolean { return this.controller.signal.aborted }
  get signal(): AbortSignal { return this.controller.signal }
  cancel(): void { this.controller.abort(new RunCancelled()) }
}

/** The usage limits a loop stops at: requests per loop, tokens over the run, tool calls over the run. */
export interface UsageLimits {
  request_limit?: number | null
  total_tokens_limit?: number | null
  tool_calls_limit?: number | null
}

export function addUsage(total: RequestUsage, more: RequestUsage | undefined): RequestUsage {
  if (!more) return total
  return {
    ...total,
    input_tokens: (total.input_tokens ?? 0) + (more.input_tokens ?? 0),
    output_tokens: (total.output_tokens ?? 0) + (more.output_tokens ?? 0),
    cache_read_tokens: (total.cache_read_tokens ?? 0) + (more.cache_read_tokens ?? 0),
    cache_write_tokens: (total.cache_write_tokens ?? 0) + (more.cache_write_tokens ?? 0),
  }
}

/** A model built on another one: every method defaults to the wrapped one's. */
export abstract class WrapperModel implements Model {
  constructor(readonly wrapped: Model) {}
  get model_name(): string { return this.wrapped.model_name }
  get system(): string | null { return this.wrapped.system }
  get route(): string | null { return this.wrapped.route ?? null }
  get profile(): ModelProfile { return this.wrapped.profile }
  request(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<ModelResponse> {
    return this.wrapped.request(messages, settings, params, ctx)
  }
  requestStream(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<StreamedResponse> {
    return this.wrapped.requestStream(messages, settings, params, ctx)
  }
  countTokens(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters): Promise<RequestUsage> {
    if (!this.wrapped.countTokens) throw new Error(`${this.wrapped.model_name} cannot count tokens`)
    return this.wrapped.countTokens(messages, settings, params)
  }
  async close(): Promise<void> { await this.wrapped.close?.() }
}

/** The innermost model of a wrapper chain (what holds the HTTP client). */
export function unwrap(model: Model): Model {
  let current = model
  while (current instanceof WrapperModel) current = current.wrapped
  return current
}
