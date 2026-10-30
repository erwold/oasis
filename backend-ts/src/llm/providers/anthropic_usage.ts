/** Bounded Anthropic billing evidence. Merge cumulative wire counts BEFORE making input inclusive.
 * No arbitrary provider objects, iteration payloads or strings enter RequestUsage.details. */
import type { RequestUsage } from '../messages.ts'

const tokens = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const
const ttl = ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'] as const
export const billingCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 0
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

export class AnthropicUsage {
  private readonly counts: Record<string, number> = {}
  private readonly invalid = new Set<string>()
  private readonly flags: Record<string, number> = { anthropic_usage: 1 }
  private seen = false

  constructor(searchExpected = false, streaming = false) {
    if (searchExpected) this.flags.anthropic_search_expected = 1
    if (streaming) this.flags.anthropic_incomplete = 1
  }

  private number(key: string, value: unknown): void {
    // Missing/null means no update, but an explicit zero replaces the previous cumulative count.
    if (value === undefined || value === null) return
    if (billingCount(value)) { this.counts[key] = value; this.invalid.delete(key) }
    else { delete this.counts[key]; this.invalid.add(key) }
  }

  merge(raw: unknown): void {
    if (raw == null) return
    this.seen = true
    if (!object(raw)) { this.flags.anthropic_invalid_usage = 1; return }
    for (const key of tokens) this.number(key, raw[key])
    for (const [group, keys] of [['cache_creation', ttl], ['server_tool_use', ['web_search_requests']]] as const) {
      const nested = raw[group]
      if (nested == null) continue
      if (!object(nested)) { this.flags[`anthropic_invalid_${group}`] = 1; continue }
      if (group === 'server_tool_use') this.flags.anthropic_server_tool_usage = 1
      else this.flags.anthropic_cache_creation = 1
      for (const key of keys) this.number(key, nested[key])
      // Other server tools are outside this estimator's scope, not silently free.
      if (group === 'server_tool_use' && Object.keys(nested).some(k => k !== 'web_search_requests' && nested[k] != null && nested[k] !== 0)) {
        this.flags.anthropic_complex_billing = 1
      }
    }
    if (raw.iterations != null && (!Array.isArray(raw.iterations) || raw.iterations.length > 0)) {
      this.flags.anthropic_iterations = Array.isArray(raw.iterations) ? raw.iterations.length : 1
    }
  }

  block(raw: unknown): void {
    if (!object(raw)) return
    if (raw.type === 'server_tool_use') {
      this.flags.anthropic_server_tool = 1
      if (raw.name === 'web_search') this.flags.anthropic_search_expected = 1
      else this.flags.anthropic_complex_billing = 1
    }
    if (raw.type === 'web_search_tool_result') {
      this.flags.anthropic_search_expected = 1
      this.flags.anthropic_server_tool = 1
      if (!Array.isArray(raw.content)) this.flags.anthropic_search_error = 1
    }
    if (raw.type === 'fallback' || raw.type === 'compaction' || raw.type === 'advisor_tool_result') this.flags.anthropic_complex_billing = 1
  }

  complete(): void { delete this.flags.anthropic_incomplete }

  usage(): RequestUsage | null {
    if (!this.seen) return null
    if (tokens.some(k => this.invalid.has(k))) return null
    const details = { ...this.flags }
    // Keep presence as well as counts: a TTL split alone is NOT evidence for an omitted aggregate.
    for (const key of ['cache_creation_input_tokens', ...ttl, 'web_search_requests']) {
      if (this.counts[key] !== undefined) details[key] = this.counts[key]!
    }
    for (const key of this.invalid) details[`anthropic_invalid_${key}`] = 1
    const input = (this.counts.input_tokens ?? 0) + (this.counts.cache_read_input_tokens ?? 0) + (this.counts.cache_creation_input_tokens ?? 0)
    if (!Number.isFinite(input)) return null
    return { input_tokens: input, output_tokens: this.counts.output_tokens ?? 0,
      cache_read_tokens: this.counts.cache_read_input_tokens ?? 0, cache_write_tokens: this.counts.cache_creation_input_tokens ?? 0, details }
  }
}
