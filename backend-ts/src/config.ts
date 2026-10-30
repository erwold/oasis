/** Configuration: the OASIS_CODE_* environment, a JSON config file in the data directory, and the model catalog
 *  they define. Nothing here reads another product's credentials or data; the defaults keep every path under one
 *  data directory and the server on the loopback interface. */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z, CheckConfigSchema, PricingSchema, type CheckConfig, type Pricing } from '@oasis-code/contract'

export const ENV_PREFIX = 'OASIS_CODE_'
export const DEFAULT_PORT = 8321
export const DEFAULT_HOST = '127.0.0.1'
/** The director endpoint listens on the loopback too, on its own port. */
export const DEFAULT_DIRECTOR_PORT = 8322
export const DEFAULT_SNAPSHOT_MAX_BYTES = 2 * 1024 ** 3
export const DEFAULT_SNAPSHOT_MAX_FILES = 20_000

export function env(name: string, fallback?: string): string | undefined {
  const value = process.env[ENV_PREFIX + name]
  return value === undefined ? fallback : value
}

export function expandUser(path: string): string {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path
}

export function defaultDataDir(): string {
  return resolve(expandUser(env('DATA') || join(homedir(), '.oasis-code')))
}

export const Provider = z.enum(['anthropic', 'openai', 'google', 'deepseek', 'zhipu', 'antigravity'])
export type ProviderName = z.infer<typeof Provider>
export const OpenAIApi = z.enum(['responses', 'chat'])
/** api_key: the variable the route names (a key saved on the Accounts page under that name wins); oauth: the
 *  provider's subscription sign-in (Codex for openai, Claude for anthropic) held by this harness; google has no
 *  subscription route here, only a key (the Gemini API). */
export const AuthMode = z.enum(['api_key', 'oauth'])
export type AuthModeName = z.infer<typeof AuthMode>

export const OFFICIAL_ENDPOINTS: Record<ProviderName, string> = {
  anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com/v1', google: 'https://generativelanguage.googleapis.com',
  antigravity: 'https://daily-cloudcode-pa.googleapis.com', deepseek: 'https://api.deepseek.com', zhipu: 'https://open.bigmodel.cn/api/paas/v4',
}
export const DEFAULT_KEY_ENVS: Record<ProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY', antigravity: '', deepseek: 'DEEPSEEK_API_KEY', zhipu: 'ZHIPU_API_KEY',
}
export const OAUTH_PROVIDERS = new Set<string>(['anthropic', 'openai', 'antigravity'])

/** The reasoning efforts a provider can be sent, least to most (`none`: thinking off). */
export const EFFORT_SCALE = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = typeof EFFORT_SCALE[number]

/** The request fields the Chat mapping sets itself: extra_body may not replace them. */
/** A route's output cap when its config names none: room for a whole document in one tool call with thinking before
 *  it, and a bound on what one runaway response can spend. The cap is reserved under the window (a provider may
 *  refuse input and output over it), so a known window gives it a quarter of itself, between the older 16K and 64K:
 *  a 1M window 64K, a 200K one 50K, a small one 16K. An unknown window (and so an unknown model) keeps the 16K. A
 *  model whose own cap is lower needs its route to say so. */
export const DEFAULT_MAX_TOKENS = 64_000
const MIN_DEFAULT_MAX_TOKENS = 16_000
export function defaultMaxTokens(window: number | null): number {
  if (window === null) return MIN_DEFAULT_MAX_TOKENS
  return Math.min(DEFAULT_MAX_TOKENS, Math.max(MIN_DEFAULT_MAX_TOKENS, Math.floor(window / 4)))
}

export const CHAT_BODY_FIELDS = new Set(['model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice', 'max_completion_tokens', 'max_tokens', 'temperature', 'reasoning_effort', 'prompt_cache_key'])

/** Gemini 4 Argon's per-request streamGenerateContent output cap (long-decode guide, checked 2026-10-14); the same
 *  figure as ARGON_STREAM_OUTPUT_CAP in llm/providers/google.ts (kept here: that module imports this one). */
export const GEMINI_ARGON_MAX_TOKENS = 65_536
/** Gemini 4 Argon's unified input + thinking + output window: the most an explicit (long-decode) max_tokens may name. */
export const GEMINI_ARGON_WINDOW = 1_048_576

const ModelConfigShape = z.object({
  id: z.string().min(1),
  label: z.string().default(''),
  provider: Provider,
  model: z.string().min(1),
  // an explicit compatible endpoint; null = the provider's official API (an oauth route ignores it)
  base_url: z.string().nullable().default(null),
  auth: AuthMode.default('api_key'),
  api_key_env: z.string().default(''),
  // OpenAI only: the Responses API (default) or Chat Completions
  api: OpenAIApi.default('responses'),
  // OpenAI Responses API routes with a key only: the reasoning mode sent beside the effort ('pro'); null = none
  reasoning_mode: z.enum(['pro']).nullable().default(null),
  // the reasoning efforts the route's provider takes for this model, as it said them; a level the person asks for
  // outside them is sent as the nearest one inside. null: not known here — the level is sent as asked
  reasoning_efforts: z.array(z.enum(EFFORT_SCALE)).nullable().default(null),
  // OpenAI Chat Completions routes only: the field a compatible endpoint streams its reasoning in and requires back on
  // the assistant turns of the history — `reasoning_content` (DeepSeek's thinking mode; Qwen / GLM routes that keep
  // their thinking) or `reasoning_details` (MiniMax with reasoning_split). What arrived under that field is kept whole
  // and sent back only to the same endpoint and model. null: the reasoning is shown, never sent back (the default,
  // and what the official API expects).
  reasoning_replay: z.enum(['reasoning_content', 'reasoning_details']).nullable().default(null),
  // OpenAI Chat Completions routes only: fields added to every request body as they are written here (a compatible
  // endpoint's own switches, e.g. MiniMax's reasoning_split); never one the harness sets itself
  extra_body: z.record(z.string(), z.unknown()).default({}),
  context_window: z.number().int().nullable().default(null),
  window_source: z.string().default('unknown'),
  // requests in flight at once for this route; null = unlimited
  concurrency: z.number().int().nullable().default(null),
  // the concurrency scope: routes sharing a scope share the slot (one account behind several ids)
  slot_scope: z.string().nullable().default(null),
  // the output a response may reach; unset, defaultMaxTokens of the window
  max_tokens: z.number().int().nullable().default(null),
  // Anthropic only: how long a prompt-cache entry lives after the request that wrote or read it. An hour by default:
  // a reply minutes after the last reads the conversation instead of writing it all again (a write into an hour-long
  // entry costs twice the input rate, a 5-minute one 1.25 times; a read costs a tenth either way)
  cache_ttl: z.enum(['5m', '1h']).default('1h'),
  pricing: PricingSchema.nullable().default(null),
  // capability claims and where they come from; unknown is the honest default
  capabilities: z.record(z.string(), z.unknown()).default({}),
  capability_source: z.string().default('unknown'),
})

export const ModelConfigSchema = ModelConfigShape.check((ctx) => {
  const m = ctx.value
  if (m.provider === 'antigravity' && (m.auth !== 'oauth' || m.base_url)) ctx.issues.push({ code: 'custom', input: m, message: 'Antigravity requires OAuth and its fixed endpoint' })
  if (m.auth === 'oauth' && !OAUTH_PROVIDERS.has(m.provider)) {
    ctx.issues.push({ code: 'custom', input: m, message: `model ${m.id}: provider ${m.provider} has no subscription sign-in here; use auth=api_key` })
  }
  if ((m.reasoning_replay !== null || Object.keys(m.extra_body).length) && (m.provider !== 'openai' || m.api !== 'chat')) {
    ctx.issues.push({ code: 'custom', input: m, message: `model ${m.id}: reasoning_replay and extra_body are for OpenAI Chat Completions routes (provider openai, api chat)` })
  }
  const owned = Object.keys(m.extra_body).filter((k) => CHAT_BODY_FIELDS.has(k))
  if (owned.length) {
    ctx.issues.push({ code: 'custom', input: m, message: `model ${m.id}: extra_body may not set ${owned.join(', ')} (the harness sets them)` })
  }
  if (m.reasoning_mode !== null && (m.provider !== 'openai' || m.api !== 'responses' || m.auth !== 'api_key')) {
    ctx.issues.push({ code: 'custom', input: m, message: `model ${m.id}: reasoning_mode needs an OpenAI Responses API route with a key (the Codex subscription route does not take it)` })
  }
  // Gemini 4 Argon (exactly): one streamGenerateContent request returns at most 65,536 output tokens (the route's
  // default). A larger max_tokens is the person's explicit opt-in to long decode — CONTINUATION hops, every one with
  // this same total, thinking and output together, all paid — and may name at most the unified window (input,
  // thinking and output share it; the provider refuses a total the input leaves no room for). Never raised by the
  // harness. Unset keeps the route's default; other models are untouched.
  if (m.provider === 'google' && m.model === 'gemini-4-argon' && m.max_tokens !== null && m.max_tokens > (m.context_window ?? GEMINI_ARGON_WINDOW)) {
    ctx.issues.push({ code: 'custom', input: m, message: `model ${m.id}: max_tokens ${m.max_tokens} is above Gemini 4 Argon's unified window of ${m.context_window ?? GEMINI_ARGON_WINDOW} tokens (input, thinking and output share it)` })
  }
})

/** One configured model route. `id` is the harness's own handle (what a run pins); `model` is the string sent to
 *  the provider; `configured_model` in the records is this entry, `provider_reported_model` is whatever the response said. */
export class ModelConfig {
  readonly id: string
  readonly label: string
  readonly provider: ProviderName
  readonly model: string
  readonly base_url: string | null
  readonly auth: AuthModeName
  readonly api_key_env: string
  readonly api: 'responses' | 'chat'
  readonly reasoning_mode: 'pro' | null
  readonly reasoning_efforts: Effort[] | null
  readonly reasoning_replay: 'reasoning_content' | 'reasoning_details' | null
  readonly extra_body: Record<string, unknown>
  readonly context_window: number | null
  readonly window_source: string
  readonly concurrency: number | null
  readonly slot_scope: string | null
  readonly max_tokens: number
  readonly cache_ttl: '5m' | '1h'
  readonly pricing: Pricing | null
  readonly capabilities: Record<string, unknown>
  readonly capability_source: string

  constructor(raw: z.input<typeof ModelConfigShape>) {
    const m = ModelConfigSchema.parse(raw)
    this.id = m.id; this.label = m.label; this.provider = m.provider; this.model = m.model; this.base_url = m.base_url
    this.auth = m.auth; this.api_key_env = m.api_key_env; this.api = m.api; this.reasoning_mode = m.reasoning_mode; this.reasoning_efforts = m.reasoning_efforts; this.context_window = m.context_window
    this.reasoning_replay = m.reasoning_replay; this.extra_body = m.extra_body
    this.window_source = m.window_source; this.concurrency = m.concurrency; this.slot_scope = m.slot_scope
    this.max_tokens = m.max_tokens ?? defaultMaxTokens(m.context_window); this.cache_ttl = m.cache_ttl; this.pricing = m.pricing; this.capabilities = m.capabilities
    this.capability_source = m.capability_source
  }

  get endpoint(): string { return this.base_url || OFFICIAL_ENDPOINTS[this.provider] }
  get key_env(): string { return this.api_key_env || DEFAULT_KEY_ENVS[this.provider] }

  /** available | unavailable — the presence of the named variable, never its value (api_key routes). */
  credentialStatus(): 'available' | 'unavailable' { return process.env[this.key_env] ? 'available' : 'unavailable' }

  get scope(): string {
    if (this.slot_scope) return this.slot_scope
    if (this.auth === 'oauth') return `${this.provider}:oauth`
    return `${this.provider}:${this.endpoint}:${this.key_env}`
  }

  /** The row as JSON (what a run snapshots; `pricing` left out by the runner). */
  dump(): Record<string, unknown> {
    return {
      id: this.id, label: this.label, provider: this.provider, model: this.model, base_url: this.base_url, auth: this.auth,
      api_key_env: this.api_key_env, api: this.api, reasoning_mode: this.reasoning_mode, reasoning_efforts: this.reasoning_efforts, reasoning_replay: this.reasoning_replay, extra_body: this.extra_body, context_window: this.context_window, window_source: this.window_source,
      concurrency: this.concurrency, slot_scope: this.slot_scope, max_tokens: this.max_tokens, cache_ttl: this.cache_ttl, pricing: this.pricing,
      capabilities: this.capabilities, capability_source: this.capability_source,
    }
  }
}

/** The JSON config file (data dir / config.json). Written by the operator; a repository's own file may only narrow
 *  what this grants. */
export interface HarnessConfig {
  models: ModelConfig[]
  default_model: string | null
  // the context window assumed for a route that has none configured (compaction is timed against the window)
  context_window_fallback_tokens: number
  // paths (relative, glob) no tool may write; the repository's own config may add, never remove
  protected_paths: string[]
  // environment variables passed into isolated commands (names only; values come from the host env)
  command_env_passthrough: string[]
  command_timeout_s: number
  command_output_cap_bytes: number
  // a Full access command's deadline and output retention cap: none unless set here (command_timeout_s and
  // command_output_cap_bytes are the sandbox's); a call's own timeout_s always applies
  full_access_command_timeout_s?: number | null
  full_access_output_cap_bytes?: number | null
  // the person has confirmed Full access on this machine without being asked (an operator's or a test's setting); else
  // the first Full command asks in the conversation, and a yes there confirms it (agent/ui_inputs.ts)
  full_access_confirmed?: boolean
  checks: CheckConfig[]
}

const HarnessConfigSchema = z.object({
  models: z.array(z.record(z.string(), z.unknown())).default([]),
  default_model: z.string().nullable().default(null),
  context_window_fallback_tokens: z.number().int().default(200_000),
  protected_paths: z.array(z.string()).default(['.git/**', '.oasis-code/**']),
  command_env_passthrough: z.array(z.string()).default(['PATH', 'LANG', 'LC_ALL', 'TERM']),
  command_timeout_s: z.number().int().default(600),
  command_output_cap_bytes: z.number().int().default(8 * 1024 * 1024),
  full_access_command_timeout_s: z.number().int().positive().nullable().default(null),
  full_access_output_cap_bytes: z.number().int().positive().nullable().default(null),
  full_access_confirmed: z.boolean().default(false),
  checks: z.array(CheckConfigSchema).default([]),
})

export function harnessConfig(partial: Partial<Omit<HarnessConfig, 'models' | 'checks'>> & { models?: ModelConfig[]; checks?: CheckConfig[] } = {}): HarnessConfig {
  const base = HarnessConfigSchema.parse({})
  return {
    models: partial.models ?? [], default_model: partial.default_model ?? base.default_model,
    context_window_fallback_tokens: partial.context_window_fallback_tokens ?? base.context_window_fallback_tokens,
    protected_paths: partial.protected_paths ?? base.protected_paths,
    command_env_passthrough: partial.command_env_passthrough ?? base.command_env_passthrough,
    command_timeout_s: partial.command_timeout_s ?? base.command_timeout_s,
    command_output_cap_bytes: partial.command_output_cap_bytes ?? base.command_output_cap_bytes,
    full_access_command_timeout_s: partial.full_access_command_timeout_s ?? base.full_access_command_timeout_s,
    full_access_output_cap_bytes: partial.full_access_output_cap_bytes ?? base.full_access_output_cap_bytes,
    full_access_confirmed: partial.full_access_confirmed ?? base.full_access_confirmed,
    checks: partial.checks ?? [],
  }
}

// every default route's family takes image input by its provider's documentation (Claude, GPT, Gemini); this build has
// not probed each route with an image, so the source says so
const IMAGE_INPUT = { images: true }
// Anthropic's first-party rates per million tokens; a cache write at its entry's lifetime (5 minutes: 1.25 times the
// input rate; an hour, the routes' default: twice it)
const CLAUDE_PRICES = "Anthropic's price table (2026-09): input, output, cache read, 5-minute and 1-hour cache write"

const IMAGE_INPUT_SOURCE = "the model family's documented image input (not probed on this route)"
// a subscription route answered a one-page PDF's printed word on 2026-10-13 (the Claude routes as Anthropic Messages
// documents, the Codex routes as Responses input files)
const PDF_PROBED = { ...IMAGE_INPUT, pdf: true }
const PDF_PROBED_SOURCE = "images: the model family's documented input (not probed); PDF: a one-page PDF's word answered on this route (probed 2026-10-13)"

const FILE_INPUT_SOURCE = "official API documentation, checked 2026-10-12 (not a publication date); offline serializers only; no online route probe"
// Gemini 4 Argon: the official pages read on 2026-10-14 (the model was announced 2026-10-13); nothing probed online
const ARGON_MODEL_PAGE = 'https://ai.google.dev/gemini-api/docs/models/gemini-4-argon'
const ARGON_SOURCE = `${ARGON_MODEL_PAGE}; https://ai.google.dev/gemini-api/docs/generate-content/latest-model`
// the paid tier's standard rates per million tokens (output includes thinking; implicit caching only), read 2026-10-14
const GEMINI_PRICES = 'https://ai.google.dev/gemini-api/docs/pricing (paid tier, checked 2026-10-14)'
const ARGON_CHECKED = 'checked 2026-10-14 (published 2026-10-13); offline mock coverage only; not probed online'
function attachmentCapabilitySource(route: Record<string, unknown>): string {
  if (route.capability_source === CLAUDE_NEW_CAPABILITIES) return `${route.id}: Anthropic Messages; ${CLAUDE_NEW_CAPABILITIES}; text: app UTF-8 envelope v1; offline serializer coverage only`
  const protocol = route.provider === 'anthropic' ? 'Anthropic Messages' : route.provider === 'google' ? 'Gemini generateContent/streamGenerateContent' : route.auth === 'oauth' ? 'ChatGPT backend-api/codex/responses' : 'OpenAI Responses'
  // the one default Google route is Gemini 4 Argon
  const argon = route.provider === 'google'
  const source = route.provider === 'anthropic' ? 'https://platform.claude.com/docs/en/build-with-claude/pdf-support' : argon ? `${ARGON_SOURCE}; https://ai.google.dev/gemini-api/docs/generate-content/video-understanding` : 'https://developers.openai.com/api/docs/guides/file-inputs'
  const pdf = route.auth === 'oauth'
    ? 'PDF: a one-page PDF\'s word answered on this route (probed 2026-10-13); offline synthetic OAuth signer + serializer coverage'
    : argon ? `PDF/video: official declaration ${source}, ${ARGON_CHECKED}; audio is declared by the model page but this app has no audio attachment path (not offered)`
    : `PDF: official declaration ${source}, checked 2026-10-12 (not publication date), offline serializer coverage; not probed online`
  const images = argon ? `official Argon model page ${ARGON_MODEL_PAGE}, ${ARGON_CHECKED}` : IMAGE_INPUT_SOURCE
  return `${route.id}: ${protocol}; images: ${images}; text: app UTF-8 envelope v1, offline ${route.auth === 'oauth' ? 'synthetic OAuth signer + serializer' : 'serializer'} coverage; ${pdf}; `
    + 'a PDF or video reference (ref-v1, any size) travels as its bytes only when the route takes its kind and it fits the request bound, else as its path. See docs/large-file-attachments.md'
}

// Official declarations verified 2026-10-25; offline coverage only, not live probed.
const CLAUDE_NEW_WINDOW = 'https://platform.claude.com/docs/en/models/overview (checked 2026-10-25; not live probed)'
const CLAUDE_NEW_CAPABILITIES = `${CLAUDE_NEW_WINDOW}; https://platform.claude.com/docs/en/build-with-claude/pdf-support (checked 2026-10-25; not live probed)`
/** The most output a current Claude model takes in one response: the API refused more, naming 128,000, for Opus 5.5,
 *  Fable 5.1, Sonnet 5.5 and Sonnet 5 (probed 2026-10-15). Thinking counts toward it: under the window's default of 64K
 *  a max-effort answer could spend it all on thinking and end with no words. */
const CLAUDE_OUTPUT_CAP = 128_000

// Independently branded routes: official declarations, not live probes. No native search is advertised;
// external web_search remains subject to the harness's network gate and configured search provider.
export const STANDARD_CN_MODELS: Record<string, unknown>[] = [
  ...[
    { model: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', images: true, input: .15, cached: .003, output: .6 },
    { model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', images: false, input: .66, cached: .022, output: 1.98 },
  ].map((m) => ({ id: `deepseek:${m.model}`, label: m.label, provider: 'deepseek', model: m.model, api: 'responses',
    api_key_env: 'DEEPSEEK_API_KEY', context_window: 1_048_576, max_tokens: 393_216, reasoning_efforts: ['none', 'low', 'high', 'max'],
    window_source: 'https://api-docs.deepseek.com/api/list-models/ (checked 2026-10-18; not probed)',
    capabilities: { images: m.images, pdf: false, tool_calls: true, streaming: true, thinking: true, thinking_default: 'high', cache: 'automatic', max_output_tokens: 393_216 },
    capability_source: 'https://api-docs.deepseek.com/guides/responses_api/; https://api-docs.deepseek.com/quick_start/pricing/ (checked 2026-10-18; not probed)',
    pricing: { currency: 'USD', schedule: 'deepseek-peak', input_per_mtok: m.input, cache_read_per_mtok: m.cached, output_per_mtok: m.output,
      source: 'https://api-docs.deepseek.com/quick_start/pricing/ (off-peak; peak 2x; Chinese public holidays excluded)', version: '2026-10-18' } })),
  ...[
    { model: 'glm-5.3', label: 'GLM-5.3', images: false, input: 8, cached: 2, output: 28 },
    { model: 'glm-5.3-flash', label: 'GLM-5.3 Flash', images: true, input: .8, cached: .23, output: 2.8 },
    { model: 'glm-5.3-flashx', label: 'GLM-5.3 FlashX', images: true, input: 2, cached: .57, output: 7 },
  ].map((m) => ({ id: `zhipu:${m.model}`, label: m.label, provider: 'zhipu', model: m.model, api: 'chat',
    api_key_env: 'ZHIPU_API_KEY', context_window: 1_048_576, max_tokens: 131_072, reasoning_efforts: ['low', 'high', 'max'],
    window_source: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3; https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash (checked 2026-10-18; not probed)',
    capabilities: { images: m.images, pdf: false, tool_calls: true, streaming: true, thinking: true, thinking_required: true, thinking_default: 'max', cache: 'automatic', max_output_tokens: 131_072, max_functions: 128, max_function_name_length: 64 },
    capability_source: 'BigModel standard API docs (checked 2026-10-18; not probed); image_url supported on Flash/FlashX; file/video paths not implemented',
    pricing: { currency: 'CNY', input_per_mtok: m.input, cache_read_per_mtok: m.cached, output_per_mtok: m.output,
      source: 'https://docs.bigmodel.cn/cn/guide/start/pricing (standard API; cache storage temporarily free; no FX conversion)', version: '2026-10-18' } })),
]

export const DEFAULT_MODELS: Record<string, unknown>[] = [
  // Labels are the model's name alone: the account a route runs on is the catalogue's `account`, and the page groups
  // routes by it. Subscription routes (sign in on the Accounts page): the ids and windows are the ones the oasis
  // lineage verified through the Codex / Claude routes on 2026-09-23; they are routes, not guarantees.
  { id: 'anthropic:claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic', model: 'claude-opus-5-5', auth: 'oauth', max_tokens: CLAUDE_OUTPUT_CAP,
    context_window: 1_000_000, window_source: 'oasis proxy registry (probed 2026-09-23)', capabilities: PDF_PROBED, capability_source: PDF_PROBED_SOURCE },
  { id: 'anthropic:claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic', model: 'claude-sonnet-5-5', auth: 'oauth', max_tokens: CLAUDE_OUTPUT_CAP,
    context_window: 1_000_000, window_source: "Anthropic's model table (2026-09); the route answered on 2026-09-29", capabilities: PDF_PROBED, capability_source: PDF_PROBED_SOURCE },
  { id: 'anthropic:claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic', model: 'claude-sonnet-5', auth: 'oauth', max_tokens: CLAUDE_OUTPUT_CAP,
    context_window: 1_000_000, window_source: 'oasis proxy registry', capabilities: PDF_PROBED, capability_source: PDF_PROBED_SOURCE },
  { id: 'anthropic:claude-fable-5-1', label: 'Claude Fable 5.1', provider: 'anthropic', model: 'claude-fable-5-1', auth: 'oauth', max_tokens: CLAUDE_OUTPUT_CAP,
    context_window: 1_000_000, window_source: 'oasis proxy registry (probed 2026-09-23)', capabilities: PDF_PROBED, capability_source: PDF_PROBED_SOURCE },
  { id: 'openai:gpt-6-astra', label: 'GPT-6 Astra', provider: 'openai', model: 'gpt-6-astra', auth: 'oauth',
    context_window: 1_000_000, window_source: 'oasis owner (900k accepted 2026-09-22)', capabilities: PDF_PROBED, capability_source: PDF_PROBED_SOURCE },
  // the Codex backend refused effort 'none' for gpt-6.1-sol, naming what it takes: low, medium, high, xhigh, max (2026-10-01)
  { id: 'openai:gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'openai', model: 'gpt-6.1-sol', auth: 'oauth', reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    context_window: 272_000, window_source: 'Codex /models context_window (probed 2026-09-30)', capabilities: PDF_PROBED, capability_source: PDF_PROBED_SOURCE },
  { id: 'openai:gpt-6-luna', label: 'GPT-6 Luna', provider: 'openai', model: 'gpt-6-luna', auth: 'oauth',
    context_window: 272_000, window_source: 'oasis proxy registry (probed 2026-09-23)', capabilities: PDF_PROBED, capability_source: PDF_PROBED_SOURCE },
  { id: 'openai:gpt-5.6-luna', label: 'GPT-5.6 Luna', provider: 'openai', model: 'gpt-5.6-luna', auth: 'oauth',
    context_window: 921_000, window_source: 'oasis proxy registry', capabilities: PDF_PROBED, capability_source: PDF_PROBED_SOURCE },
  // Pay-as-you-go routes: the key comes from the Accounts page or the environment variable named here.
  { id: 'anthropic-api:claude-fable-5-1', label: 'Claude Fable 5.1', provider: 'anthropic', model: 'claude-fable-5-1', max_tokens: CLAUDE_OUTPUT_CAP,
    api_key_env: 'ANTHROPIC_API_KEY', context_window: 1_000_000, window_source: CLAUDE_NEW_WINDOW,
    capabilities: { ...IMAGE_INPUT, pdf: true }, capability_source: CLAUDE_NEW_CAPABILITIES,
    pricing: { web_search_per_request: .01, input_per_mtok: 10, output_per_mtok: 50, cache_read_per_mtok: .25, cache_write_per_mtok: 12.5, cache_write_1h_per_mtok: 20,
      source: 'https://platform.claude.com/docs/en/about-claude/pricing', version: '2026-10-25' } },
  { id: 'anthropic-api:claude-haiku-5-5', label: 'Claude Haiku 5.5', provider: 'anthropic', model: 'claude-haiku-5-5', max_tokens: CLAUDE_OUTPUT_CAP,
    api_key_env: 'ANTHROPIC_API_KEY', context_window: 1_000_000, window_source: CLAUDE_NEW_WINDOW,
    capabilities: { ...IMAGE_INPUT, pdf: true }, capability_source: CLAUDE_NEW_CAPABILITIES,
    pricing: { web_search_per_request: .01, input_per_mtok: .1, output_per_mtok: .5, cache_read_per_mtok: .01, cache_write_per_mtok: .125, cache_write_1h_per_mtok: .2,
      long_context: { above_input_tokens: 100_000, input_per_mtok: .5, output_per_mtok: 2.5, cache_read_per_mtok: .05, cache_write_per_mtok: .625, cache_write_1h_per_mtok: 1 },
      source: 'https://platform.claude.com/docs/en/models/haiku-5-5/overview; https://platform.claude.com/docs/en/about-claude/pricing', version: '2026-10-25' } },
  { id: 'anthropic-api:claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic', model: 'claude-opus-5-5', max_tokens: CLAUDE_OUTPUT_CAP,
    api_key_env: 'ANTHROPIC_API_KEY', context_window: 1_000_000, window_source: "Anthropic's model table (2026-06)", capabilities: { ...IMAGE_INPUT, pdf: true }, capability_source: FILE_INPUT_SOURCE,
    pricing: { web_search_per_request: .01, input_per_mtok: 4, output_per_mtok: 20, cache_read_per_mtok: 0.2, cache_write_per_mtok: 5, cache_write_1h_per_mtok: 8, source: CLAUDE_PRICES, version: '2026-09' } },
  { id: 'anthropic-api:claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic', model: 'claude-sonnet-5-5', max_tokens: CLAUDE_OUTPUT_CAP,
    api_key_env: 'ANTHROPIC_API_KEY', context_window: 1_000_000, window_source: "Anthropic's model table (2026-09)", capabilities: { ...IMAGE_INPUT, pdf: true }, capability_source: FILE_INPUT_SOURCE,
    pricing: { web_search_per_request: .01, input_per_mtok: 2, output_per_mtok: 10, cache_read_per_mtok: 0.1, cache_write_per_mtok: 2.5, cache_write_1h_per_mtok: 4,
      source: 'https://platform.claude.com/docs/en/about-claude/pricing', version: '2026-10-25' } },
  { id: 'anthropic-api:claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic', model: 'claude-sonnet-5', max_tokens: CLAUDE_OUTPUT_CAP,
    api_key_env: 'ANTHROPIC_API_KEY', context_window: 1_000_000, window_source: "Anthropic's model table (2026-06)", capabilities: { ...IMAGE_INPUT, pdf: true }, capability_source: FILE_INPUT_SOURCE,
    pricing: { web_search_per_request: .01, input_per_mtok: 2, output_per_mtok: 10, cache_read_per_mtok: 0.2, cache_write_per_mtok: 2.5, cache_write_1h_per_mtok: 4, source: CLAUDE_PRICES, version: '2026-09' } },
  { id: 'openai-api:gpt-5.6', label: 'GPT-5.6', provider: 'openai', model: 'gpt-5.6', api_key_env: 'OPENAI_API_KEY',
    window_source: 'unknown (not configured)', capabilities: { ...IMAGE_INPUT, pdf: true }, capability_source: FILE_INPUT_SOURCE },
  // the Responses API's pro reasoning mode on GPT-6 (`reasoning.mode: "pro"`, a dimension beside the effort): a route
  // for directing, billed by the API, not the ChatGPT plan; the model id and the mode are as the API documented
  // them when this build was written, not probed here
  { id: 'openai-api:gpt-6-pro', label: 'GPT-6 Pro (API)', provider: 'openai', model: 'gpt-6-astra', api_key_env: 'OPENAI_API_KEY', reasoning_mode: 'pro',
    window_source: 'unknown (not configured)', capabilities: { ...IMAGE_INPUT, pdf: true }, capability_source: FILE_INPUT_SOURCE },
  // Gemini 4 Argon on the Gemini API (generateContent) with a key saved as "gemini" or GEMINI_API_KEY
  // (docs/gemini-4-argon.md): the window is the unified input + thinking +
  // output limit; the output total is the owner's 262,144 — four streams' worth, the hops past the first 65,536 a
  // long decode (docs/gemini-4-argon.md), paid only as far as an answer goes; the thinking levels are the three the model takes (minimal / off / xhigh / max are sent as the nearest and
  // the run's records say so). The price list is the paid tier's, with the rise published for 2026-12-01.
  { id: 'google:gemini-4-argon', label: 'Gemini 4 Argon', provider: 'google', model: 'gemini-4-argon', api_key_env: 'GEMINI_API_KEY',
    reasoning_efforts: ['low', 'medium', 'high'], context_window: 1_048_576, max_tokens: 262_144,
    window_source: `official model page: 1,048,576 unified input + thinking + output tokens (${ARGON_SOURCE}; ${ARGON_CHECKED})`,
    capabilities: { ...IMAGE_INPUT, pdf: true, video: ['video/mp4', 'video/webm', 'video/quicktime'] }, capability_source: ARGON_CHECKED,
    pricing: { input_per_mtok: 2, output_per_mtok: 10, cache_read_per_mtok: 0.1, source: GEMINI_PRICES, version: '2026-10',
      next: { from: '2026-12-01', input_per_mtok: 4, output_per_mtok: 20, cache_read_per_mtok: 0.2, version: '2026-12' } } },
].map<Record<string, unknown>>((route) => ({ ...route, capability_source: attachmentCapabilitySource(route) })).concat(STANDARD_CN_MODELS)

export function loadConfig(path: string): HarnessConfig {
  let config: HarnessConfig
  if (existsSync(path)) {
    const data = HarnessConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    config = { ...data, models: data.models.map((m) => new ModelConfig(m as z.input<typeof ModelConfigShape>)), checks: data.checks }
  } else {
    config = harnessConfig()
  }
  if (config.models.length === 0) config.models = DEFAULT_MODELS.map((m) => new ModelConfig(m as z.input<typeof ModelConfigShape>))
  if (config.default_model === null) config.default_model = env('DEFAULT_MODEL') || config.models[0]!.id
  const ids = config.models.map((m) => m.id)
  if (new Set(ids).size !== ids.length) throw new Error('config.models: duplicate model ids')
  return config
}

export interface SettingsInit {
  data_dir?: string
  host?: string
  port?: number
  config_path?: string | null
  session_token?: string | null
  director_port?: number
  director_token?: string | null
  director_allowed_hosts?: string[]
  snapshot_max_bytes?: number
  snapshot_max_files?: number
}

export class Settings {
  readonly data_dir: string
  readonly host: string
  readonly port: number
  readonly config_path: string | null
  // the browser session token (a random one is minted at startup and written to the data dir when unset)
  readonly session_token: string | null
  // the director endpoint's port and the secret path segment its MCP URL carries (minted into the data dir when unset)
  readonly director_port: number
  readonly director_token: string | null
  // hostnames the director endpoint accepts requests under besides the loopback (a tunnel's), comma-separated
  readonly director_allowed_hosts: string[]
  // a folder over either line is not snapshotted into a base repository (a 300 GB Downloads once was, by accident):
  // the import refuses with the measured size and offers to attach the folder read-only instead
  readonly snapshot_max_bytes: number
  readonly snapshot_max_files: number

  constructor(init: SettingsInit = {}) {
    this.data_dir = init.data_dir !== undefined ? resolve(init.data_dir) : defaultDataDir()
    this.host = init.host ?? (env('HOST', DEFAULT_HOST) || DEFAULT_HOST)
    this.port = init.port ?? Number(env('PORT', String(DEFAULT_PORT)) || DEFAULT_PORT)
    this.config_path = init.config_path ?? null
    this.session_token = init.session_token !== undefined ? init.session_token : (env('SESSION_TOKEN') ?? null)
    this.director_port = init.director_port ?? Number(env('DIRECTOR_PORT', String(DEFAULT_DIRECTOR_PORT)) || DEFAULT_DIRECTOR_PORT)
    this.director_token = init.director_token !== undefined ? init.director_token : (env('DIRECTOR_TOKEN') ?? null)
    this.director_allowed_hosts = init.director_allowed_hosts
      ?? (env('DIRECTOR_ALLOWED_HOSTS') || '').split(',').map((h) => h.trim()).filter(Boolean)
    this.snapshot_max_bytes = init.snapshot_max_bytes ?? Number(env('SNAPSHOT_MAX_BYTES', String(DEFAULT_SNAPSHOT_MAX_BYTES)) || DEFAULT_SNAPSHOT_MAX_BYTES)
    this.snapshot_max_files = init.snapshot_max_files ?? Number(env('SNAPSHOT_MAX_FILES', String(DEFAULT_SNAPSHOT_MAX_FILES)) || DEFAULT_SNAPSHOT_MAX_FILES)
  }

  get db_path(): string { return join(this.data_dir, 'index.db') }
  get repos_dir(): string { return join(this.data_dir, 'repos') }
  get workspaces_dir(): string { return join(this.data_dir, 'workspaces') }
  get assets_dir(): string { return join(this.data_dir, 'assets') }
  get scratch_dir(): string { return join(this.data_dir, 'scratch') }
  /** one folder per workspace for what its commands and tools keep beside the worktree: its HOME and its temporary folder */
  get sandboxes_dir(): string { return join(this.data_dir, 'sandboxes') }
  get logs_dir(): string { return join(this.data_dir, 'logs') }
  get config_file(): string {
    if (this.config_path !== null) return this.config_path
    const explicit = env('CONFIG')
    return explicit ? resolve(expandUser(explicit)) : join(this.data_dir, 'config.json')
  }
  load(): HarnessConfig { return loadConfig(this.config_file) }
}

export function getSettings(): Settings {
  return new Settings()
}

export type { CheckConfig, Pricing }
