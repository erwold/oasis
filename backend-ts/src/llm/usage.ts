/** Usage metering: one record per provider request (tokens, latency, the model the provider reported, the
 *  tool-schema fingerprint, the outcome), totals per run, and cost as reported / estimated / unknown — an estimate
 *  cites its price list, an unknown is never 0. A request the provider reported no count for (none, all zeros, or a
 *  figure that is no count, or one the route's window could not hold) is filed with 0 in its token columns and an unknown cost — the zeros a record of the
 *  columns' shape, never a count: the UI reads an all-zero row as not reported — and the run's token totals are
 *  unknown (null) when no request of it was counted. */

import { createHash } from 'node:crypto'
import { resolveWindow } from '../agent/context.ts'
import type { ModelRequestRecord, Pricing } from '@oasis-code/contract'
import type { ModelConfig } from '../config.ts'
import { newId } from '../ids.ts'
import { monotonic, nowIso } from '../timebase.ts'
import { routeEndpoint } from './catalog.ts'
import { billingCount } from './providers/anthropic_usage.ts'
import { countedUsage, type CountedUsage } from './providers/common.ts'
import { emptyUsage, type ModelMessage, type ModelResponse, type RequestUsage } from './messages.ts'
import { redactSecrets } from './redact.ts'
import { WrapperModel, type Model, type ModelRequestParameters, type ModelSettings, type RequestContext, type StreamedResponse } from './model.ts'

export const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'] as const
export type UsageField = (typeof USAGE_FIELDS)[number]
export type PerRequestUsage = Record<UsageField, number>
type PricedUsage = Partial<PerRequestUsage> & Pick<RequestUsage, 'details'>

/** [native-currency amount, status, source]: estimated from the price list when one is configured, unknown otherwise. */
function estimateCurrencyCost(usage: PricedUsage, priced: (Omit<Pricing, 'next'> & { next?: Pricing['next'] }) | null | undefined, cacheTtl: '5m' | '1h' = '5m', at: Date = new Date()): [number | null, 'estimated' | 'unknown', string | null] {
  if (!priced) return [null, 'unknown', null]
  // a request made on or after a published change's day is priced at the new rates
  const next = priced.next ?? null
  const datedPricing = next && at.getTime() >= Date.parse(`${next.from}T00:00:00Z`)
    ? { ...priced, ...next, cache_write_1h_per_mtok: null, long_context: undefined }
    : priced
  const details = usage.details?.anthropic_usage === 1 ? usage.details : undefined
  const search = details?.web_search_requests
  const five = details?.ephemeral_5m_input_tokens, oneHour = details?.ephemeral_1h_input_tokens
  const split = !!details?.anthropic_cache_creation || five !== undefined || oneHour !== undefined
  // Counter-object presence (including all-zero counters) is not evidence of execution/multiple prompts.
  const server = !!(details?.anthropic_server_tool || (search ?? 0) > 0)
  const evidence = details ? ['web_search_requests', 'cache_creation_input_tokens', 'ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens', 'anthropic_iterations']
    .filter(k => details[k] !== undefined).map(k => `${k}=${details[k]}`).join(', ') : ''
  let billingSource = evidence ? `; Anthropic ${evidence}` : ''
  const unknown = (reason: string): [null, 'unknown', string] => [null, 'unknown', `${datedPricing.source}@${datedPricing.version}${billingSource}; ${reason}`]
  if (details) {
    if (details.anthropic_incomplete) return unknown('incomplete Anthropic stream; final billing usage unavailable')
    if (Object.keys(details).some(k => k.startsWith('anthropic_invalid_') && details[k])) return unknown('invalid Anthropic billing usage')
    if (details.anthropic_iterations || details.anthropic_complex_billing) return unknown('iterations/advisor/fallback/compaction billing boundaries unsupported; no iteration totals added')
    if (details.anthropic_search_error) return unknown('web search error: failed searches are free; whether reported requests exclude failures is undocumented; no error-block subtraction')
    if (search !== undefined && !billingCount(search)) return unknown('invalid web_search_requests')
    if ((details.anthropic_search_expected || details.anthropic_server_tool_usage) && search === undefined) return unknown('web_search_requests missing; content blocks are not billing counts')
    if ((search ?? 0) > 0 && (datedPricing.web_search_per_request === undefined || !Number.isFinite(datedPricing.web_search_per_request) || datedPricing.web_search_per_request < 0)) return unknown('web search price missing or invalid in configured currency')
    if (datedPricing.long_context && server) return unknown('server-tool prompt tariff boundaries unavailable; aggregate input is not a single prompt')
    if (split && (!billingCount(five) || !billingCount(oneHour) || !billingCount(details.cache_creation_input_tokens)
      || five + oneHour !== details.cache_creation_input_tokens || details.cache_creation_input_tokens !== (usage.cache_write_tokens ?? 0))) {
      return unknown('partial/inconsistent cache TTL breakdown; aggregate not inferred')
    }
    if ((usage.cache_write_tokens ?? 0) > 0 && !split) {
      if (server) return unknown('server-tool cache TTL breakdown missing; configured TTL is not evidence')
      billingSource += `; cache write configured ${cacheTtl} TTL fallback (breakdown absent)`
    }
  }
  const inp = usage.input_tokens ?? 0
  // Select once per request, using the inclusive input count (never add caches again).
  // A dated replacement supersedes the old tariff, including its optional prompt tier.
  const tier = datedPricing.long_context
  const high = tier !== undefined && inp > tier.above_input_tokens
  const pricing = high ? { ...datedPricing, ...tier } : datedPricing
  const tierSource = tier ? `; prompt ${high ? '>' : '<='}${tier.above_input_tokens}; ${high ? 'long-context' : 'base'} whole-request rates` : ''
  const cacheRead = usage.cache_read_tokens ?? 0
  const cacheWrite = usage.cache_write_tokens ?? 0
  const out = usage.output_tokens ?? 0
  // input_tokens as the records carry it includes cache reads for Anthropic; price the uncached part at the
  // input rate and the cached parts at their own rates when the list has them
  const uncached = Math.max(0, inp - cacheRead - cacheWrite)
  let usd = (uncached / 1e6) * pricing.input_per_mtok + (out / 1e6) * pricing.output_per_mtok
  usd += (cacheRead / 1e6) * (pricing.cache_read_per_mtok ?? pricing.input_per_mtok)
  // a write is priced at the entry's lifetime: an hour-long one at its own rate when the list has it
  const writeRate = (cacheTtl === '1h' ? pricing.cache_write_1h_per_mtok : null) ?? pricing.cache_write_per_mtok ?? pricing.input_per_mtok
  if (split) {
    // The validated split replaces, never adds to, the aggregate write charge.
    if ((five! > 0 && pricing.cache_write_per_mtok == null) || (oneHour! > 0 && pricing.cache_write_1h_per_mtok == null)) return unknown('cache TTL price missing')
    usd += (five! / 1e6) * (pricing.cache_write_per_mtok ?? 0) + (oneHour! / 1e6) * (pricing.cache_write_1h_per_mtok ?? 0)
  } else usd += (cacheWrite / 1e6) * writeRate
  usd += (search ?? 0) * (pricing.web_search_per_request ?? 0)
  const amount = Math.round(usd * 1e6) / 1e6
  const source = `${pricing.source}@${pricing.version}${tierSource}${billingSource}${pricing.schedule === 'deepseek-peak' ? '; local request-start UTC tariff estimate (provider billing timestamp not documented)' : ''}`
  const currency = pricing.currency ?? 'USD'
  const day = at.getUTCDay(), hour = at.getUTCHours()
  const peakBand = pricing.schedule === 'deepseek-peak' && day >= 1 && day <= 5
    && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))
  if (peakBand && at.getUTCFullYear() !== 2026) return [null, 'unknown', `${source}; estimated ${currency} ${amount}–${Math.round(usd * 2e6) / 1e6}; peak/Chinese-public-holiday unresolved; not a bill`]
  // During peak bands UTC and China have the same calendar date. Weekends remain off-peak even
  // on a government-designated make-up workday. Future years need an official holiday table.
  const date = at.toISOString().slice(5, 10)
  const holiday = HOLIDAYS_2026.some(([from, to]) => date >= from! && date <= to!)
  const multiplier = peakBand && !holiday ? 2 : 1
  const total = Math.round(usd * multiplier * 1e6) / 1e6
  return [total, 'estimated', `${source}${currency === 'CNY' ? `; estimated CNY ${total}; no FX conversion` : ''}${pricing.schedule === 'deepseek-peak' ? `; ${multiplier === 2 ? 'peak' : 'off-peak'}; 2026 holidays: State Council notice 2025-7` : ''}`]

}

// State Council 2026 holiday notice, checked 2026-10-18:
// https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html
const HOLIDAYS_2026 = [['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'], ['05-01', '05-05'],
  ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07']]

export interface CostEstimate { cost_usd: number | null; cost_cny: number | null; status: 'estimated' | 'unknown'; source: string | null }
/** Currency-separated estimate from counts, not a provider-reported bill. */
export function estimateRequestCost(usage: PricedUsage, priced: Parameters<typeof estimateCurrencyCost>[1], cacheTtl: '5m' | '1h' = '5m', at: Date = new Date()): CostEstimate {
  const [amount, status, source] = estimateCurrencyCost(usage, priced, cacheTtl, at)
  return { cost_usd: priced?.currency === 'CNY' ? null : amount, cost_cny: priced?.currency === 'CNY' ? amount : null, status, source }
}
/** Backward-compatible USD-only estimator; a CNY estimate is never converted or represented as USD zero. */
export function estimateCost(usage: PricedUsage, priced: Parameters<typeof estimateCurrencyCost>[1], cacheTtl: '5m' | '1h' = '5m', at: Date = new Date()): [number | null, 'estimated' | 'unknown', string | null] {
  const result = estimateRequestCost(usage, priced, cacheTtl, at)
  return [result.cost_usd, result.cost_usd === null ? 'unknown' : result.status, result.source]
}

/** sha256 over the compact JSON of tools' name / description / input schema, sorted by name — the payload a
 *  provider gets. The run manifest (from the agent's function schemas) and every request record (from the tool
 *  definitions the request carried) use this one function, so the two can be compared. */
export function schemaRowsFingerprint(rows: { name: string; description?: string | null; parameters?: Record<string, unknown> | null }[]): string {
  const ordered = rows.map((r) => ({ name: r.name, description: r.description ?? '', parameters: r.parameters ?? {} })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return createHash('sha256').update(canonicalJson(ordered), 'utf8').digest('hex')
}

/** JSON with sorted keys, compact separators and ASCII escapes (Python's json.dumps(sort_keys=True, separators=(",",":"))). */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): string => {
    if (v === null || v === undefined) return 'null'
    if (typeof v === 'string') return asciiJsonString(v)
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : JSON.stringify(v)
    if (typeof v === 'boolean') return v ? 'true' : 'false'
    if (Array.isArray(v)) return `[${v.map(walk).join(',')}]`
    if (typeof v === 'object') {
      const keys = Object.keys(v as object).sort()
      return `{${keys.map((k) => `${asciiJsonString(k)}:${walk((v as Record<string, unknown>)[k])}`).join(',')}}`
    }
    return JSON.stringify(v) ?? 'null'
  }
  return walk(value)
}

function asciiJsonString(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** The fingerprint of the tool schemas one request carried (16 hex chars in the record). */
export function toolSchemaFingerprint(params: ModelRequestParameters | null | undefined): string | null {
  try {
    const tools = params?.function_tools ?? []
    return schemaRowsFingerprint(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters_json_schema }))).slice(0, 16)
  } catch {
    return null
  }
}

export interface UsageTotals {
  requests: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd: number | null
  cost_cny: number | null
  cost_status: string
  cost_source: string | null
  provider_models: string[]
  /** requests the provider reported no count for */
  uncounted_requests: number
  [key: string]: unknown
}

export type Emit = (event: string, data: Record<string, unknown>) => void

/** Counts what every request cost as it completes — independent of the run's outcome — and files a
 *  ModelRequestRecord through `record`. */
export class UsageMeter extends WrapperModel {
  readonly totals: UsageTotals
  seq: number
  /** the route's known window (null: not configured, so no count is judged against an assumed one) */
  private readonly window: number | null

  constructor(wrapped: Model, readonly cfg: ModelConfig, readonly run_id: string, readonly record: (rec: ModelRequestRecord) => void,
    readonly emit: Emit, totals?: Record<string, unknown> | null, readonly contextEstimate?: ((messages: ModelMessage[]) => number | null) | null) {
    super(wrapped)
    this.totals = {
      requests: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null, cost_cny: null, cost_status: 'no_requests',
      cost_source: null, provider_models: [], uncounted_requests: 0,
    }
    for (const [key, value] of Object.entries(totals ?? {})) {
      // a token total stored as unknown (null) is no tokens counted so far
      if ((USAGE_FIELDS as readonly string[]).includes(key)) { if (typeof value === 'number' && Number.isFinite(value)) (this.totals as Record<string, unknown>)[key] = value }
      else if (key in this.totals && (typeof value === 'number' || typeof value === 'string' || Array.isArray(value) || value === null)) (this.totals as Record<string, unknown>)[key] = value
    }
    this.seq = Math.trunc(this.totals.requests)
    const resolved = resolveWindow(cfg, 0)
    this.window = resolved.known ? resolved.window : null
  }

  /** The provider's count when it is one this route could have served: a figure above the route's window (a request's
   *  input, its reply, its cached parts each fit in it) is no count of this request, the way the context keeper does
   *  not anchor on it — filed as not reported and never priced. */
  private plausible(usage: RequestUsage | null | undefined): CountedUsage | null {
    const reported = countedUsage(usage)
    if (reported === null) return null
    const window = this.window
    if (window !== null && USAGE_FIELDS.some((f) => reported[f] > window)) return null
    return { ...reported, ...(usage?.details ? { details: usage.details } : {}) }
  }

  /** The response as the loop and the record take it, so the loop's token line does not count what the record does
   *  not: a usage with a figure that is no number is no usage (the provider's mappings already leave it out; a wrapped
   *  model that does not is held to the same); a count the window could not hold goes on as a count of nothing, the
   *  way a provider that counts nothing reports it. */
  private withCountedUsage(response: ModelResponse): ModelResponse {
    if (response.usage === undefined || this.plausible(response.usage) !== null) return response
    if (countedUsage(response.usage) !== null) return { ...response, usage: emptyUsage() }
    const uncounted: ModelResponse = { ...response }
    delete uncounted.usage
    return uncounted
  }

  private count(usage: RequestUsage | null | undefined, modelName: string | null | undefined, started: number, startedAt: string, messages: ModelMessage[],
    params: ModelRequestParameters, error: string | null = null): void {
    const reported = this.plausible(usage)
    // a request the provider served reads its input, so a count of nothing is no count; and a request that failed or
    // was stopped before the provider counted anything is not known to have cost nothing (a provider may bill the
    // input of a request it dropped): either is an unknown cost, never an estimated 0
    const counted = reported !== null && USAGE_FIELDS.some((f) => reported[f] > 0)
    const per: PerRequestUsage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }
    if (counted) for (const f of USAGE_FIELDS) per[f] = reported[f]
    this.seq += 1
    this.totals.requests += 1
    for (const f of USAGE_FIELDS) this.totals[f] += per[f]
    if (!counted) this.totals.uncounted_requests += 1
    // a long decode's later streams (resumes from a checkpoint) read the prompt again: their input is priced, though
    // the record's input column keeps the first stream's prompt — the context's size, what the keeper anchors on
    const extra = counted ? continuationInput(usage) : null
    const priced = extra ? { ...per, input_tokens: per.input_tokens + extra.input_tokens, cache_read_tokens: per.cache_read_tokens + extra.cache_read_tokens } : per
    // countedUsage normalizes only token columns. Pass the original billing evidence explicitly.
    const estimate = estimateRequestCost({ ...priced, details: usage?.details }, this.cfg.provider === 'antigravity' ? null : this.cfg.pricing, this.cfg.cache_ttl, new Date(startedAt))
    // Even an aggregate beyond the route window may explain why billing is unknown (iterations, etc.).
    const { cost_usd: usd, cost_cny: cny, status, source } = counted ? estimate : { cost_usd: null, cost_cny: null, status: 'unknown' as const,
      source: usage?.details?.anthropic_usage && estimate.status === 'unknown' ? estimate.source : null }
    if (status === 'estimated') {
      if (usd !== null) this.totals.cost_usd = (this.totals.cost_usd ?? 0) + usd
      if (cny !== null) this.totals.cost_cny = (this.totals.cost_cny ?? 0) + cny
      this.totals.cost_status = this.totals.cost_status === 'no_requests' || this.totals.cost_status === 'estimated' ? 'estimated' : 'partial'
      this.totals.cost_source = source
    } else {
      this.totals.cost_status = this.totals.cost_usd === null && this.totals.cost_cny === null ? 'unknown' : 'partial'
      if (source) this.totals.cost_source = source
    }
    if (modelName && !this.totals.provider_models.includes(modelName)) this.totals.provider_models.push(modelName)
    const rec: ModelRequestRecord = {
      id: newId('mr'), run_id: this.run_id, seq: this.seq, model_id: this.cfg.id, configured_model: this.cfg.model,
      provider_reported_model: modelName ?? null, endpoint: routeEndpoint(this.cfg), started_at: startedAt,
      latency_ms: Math.trunc((monotonic() - started) * 1000), cost_usd: usd, cost_cny: cny, cost_status: status, cost_source: source,
      status: error ? 'error' : 'ok', error, tool_schema_sha256: toolSchemaFingerprint(params), message_count: messages.length,
      context_estimate_tokens: this.contextEstimate ? this.contextEstimate(messages) : null, ...per,
    }
    this.record(rec)
    this.emit('model_request', {
      seq: rec.seq, model: this.cfg.id, provider_reported_model: modelName ?? null, latency_ms: rec.latency_ms, cost_usd: usd, cost_cny: cny,
      cost_status: status, cost_source: source, status: rec.status, error, ...per,
    })
  }

  override async request(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<ModelResponse> {
    const started = monotonic()
    const startedAt = nowIso()
    let response: ModelResponse
    try {
      response = await super.request(messages, settings, params, ctx)
    } catch (error) {
      this.count(null, null, started, startedAt, messages, params, errorText(error))
      throw error
    }
    this.count(response.usage, response.model_name, started, startedAt, messages, params)
    return this.withCountedUsage(response)
  }

  override async requestStream(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<StreamedResponse> {
    const started = monotonic()
    const startedAt = nowIso()
    let stream: StreamedResponse
    try {
      stream = await super.requestStream(messages, settings, params, ctx)
    } catch (error) {
      // the request failed before a stream opened: an error record, no tokens
      this.count(null, null, started, startedAt, messages, params, errorText(error))
      throw error
    }
    const meter = this
    let counted = false
    const events = async function* () {
      // a stream that broke is an error record with whatever usage had arrived, never an ok one
      let failure: string | null = null
      try {
        yield* stream.events()
      } catch (error) {
        failure = errorText(error)
        throw error
      } finally {
        if (!counted) {
          counted = true
          meter.count(stream.usage(), stream.model_name, started, startedAt, messages, params, failure)
        }
      }
    }
    return { events, get: () => meter.withCountedUsage(stream.get()), usage: () => meter.plausible(stream.usage()), get model_name() { return stream.model_name } }
  }

  /** The run's totals as its usage keeps them: the token totals unknown (null) when no request was counted. */
  totalsWithTokens(): Omit<UsageTotals, UsageField | 'uncounted_requests'> & Record<UsageField | 'total_tokens', number | null> & { uncounted_requests?: number } {
    const { uncounted_requests: uncounted, ...totals } = this.totals
    const known = totals.requests === 0 || uncounted < totals.requests
    const tokens = Object.fromEntries(USAGE_FIELDS.map((f) => [f, known ? totals[f] : null])) as Record<UsageField, number | null>
    return { ...totals, ...tokens, total_tokens: known ? totals.input_tokens + totals.output_tokens : null, ...(uncounted > 0 ? { uncounted_requests: uncounted } : {}) }
  }
}

/** The input a long decode's later streams read again (google.ts: usage.details long_decode_extra_input_tokens /
 *  long_decode_extra_cache_read_tokens), or null: none, or figures that are no counts. */
export function continuationInput(usage: RequestUsage | null | undefined): { input_tokens: number; cache_read_tokens: number } | null {
  const details = usage?.details
  if (!details) return null
  const input = details.long_decode_extra_input_tokens
  const cached = details.long_decode_extra_cache_read_tokens ?? 0
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  if (!count(input) || !count(cached) || cached > input) return null
  return input > 0 ? { input_tokens: Math.trunc(input), cache_read_tokens: Math.trunc(cached) } : null
}

function errorText(error: unknown): string {
  const name = (error as { name?: string })?.name || (error as object)?.constructor?.name || 'Error'
  const message = String((error as { message?: string })?.message ?? error)
  // masked before it is cut: a key half cut off would slip past the patterns
  return redactSecrets(`${name}: ${message}`).slice(0, 300)
}
