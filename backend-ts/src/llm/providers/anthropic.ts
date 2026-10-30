/** The Anthropic Messages API over fetch: the harness's messages mapped to the official request shape (system
 *  text from the instructions, tool_use / tool_result pairs by the provider's id, a thinking block with its
 *  signature — or a redacted one with its data — sent back only to the provider that produced it), tools as
 *  input_schema, and the SSE stream read into parts as the events go out. Every request asks for the prompt cache:
 *  an explicit breakpoint on the last system block (tools and system are one entry whatever the messages do) and
 *  the top-level automatic breakpoint on the growing conversation, both with the route's TTL. Usage counts cache
 *  reads and writes into input_tokens, as the first backend did. The web search Anthropic runs itself (declared
 *  when the request names it): its `server_tool_use` and `web_search_tool_result` blocks and the citations on the
 *  words come back as parts of their own and go back to Anthropic exactly as they came. */

import { newId } from '../../ids.ts'
import { cleanSchema, postJson, readSse, type HttpOptions } from '../http.ts'
import {
  argsDict, isBuiltinCall, isBuiltinReturn, isRequest, isResponse, isRetryPrompt, isSystemPromptPart, isText, isThinking, isToolCall, isToolReturn, isUserPrompt,
  type ModelMessage, type ModelResponse, type RequestUsage, type ResponsePart,
} from '../messages.ts'
import { ModelAPIError, type Model, type ModelProfile, type ModelRequestParameters, type ModelSettings, type RequestContext, type StreamEvent, type StreamedResponse, type ThinkingSetting } from '../model.ts'
import { type ApiKey, currentKey, routeKey, ResponseBuilder, retryPromptText, streamedResponse, THINKING_BUDGETS, thinkingLevel, toolReturnParts, userBlocks, nativeFileBlock } from './common.ts'

import { AnthropicUsage } from './anthropic_usage.ts'

export const ANTHROPIC_VERSION = '2023-06-01'
/** Anthropic's web search tool: the version without dynamic filtering — the filtering version runs Anthropic's code
 *  execution first, which a Claude subscription refused with too_many_requests (2026-09-29), while this one answered */
export const WEB_SEARCH_TOOL = 'web_search_20250305'
export type CacheControl = { type: 'ephemeral'; ttl?: '1h' }
export type SystemBlock = { type: 'text'; text: string; cache_control?: CacheControl }

/** The cache_control a request carries: the 5-minute default needs no ttl field; the hour names it. */
export function cacheControl(ttl: '5m' | '1h' | undefined): CacheControl {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
}

/** How a Claude model takes thinking (Anthropic's model table, 2026-09). The current models take adaptive thinking with
 *  an effort level and refuse a thinking budget; they differ in how thinking is turned off and in whether omitting
 *  the field already means adaptive. The models before Opus 4.6 / Sonnet 4.6 take a budget. */
export interface ClaudeThinking {
  /** False for a compatibility fallback, not evidence of supported capabilities. */
  known: boolean
  mode: 'effort' | 'budget'
  /** how the person's "off" is sent: Sonnet 5.5's own lowest setting, the disabled type, the lowest effort (Opus 5.5
   *  and the Fable / Mythos models cannot turn thinking off), or nothing (a model that does not think by default) */
  off: 'between_tools' | 'disabled' | 'low_effort' | 'omit'
  /** omitting `thinking` already runs adaptive thinking */
  adaptive_by_default: boolean
  efforts: readonly string[]
}

const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export function claudeThinking(model: string): ClaudeThinking {
  const name = model.replace(/^anthropic\./, '').replace(/-\d{8}$/, '')
  const current = (off: ClaudeThinking['off'], adaptiveByDefault: boolean, efforts: readonly string[] = ALL_EFFORTS): ClaudeThinking =>
    ({ known: true, mode: 'effort', off, adaptive_by_default: adaptiveByDefault, efforts })
  if (/^claude-(fable|mythos)-/.test(name) || name === 'claude-opus-5-5') return current('low_effort', true)
  if (name === 'claude-sonnet-5-5') return current('between_tools', true)
  // https://platform.claude.com/docs/en/build-with-claude/thinking (checked 2026-10-25; not live probed)
  if (name === 'claude-haiku-5-5' || name === 'claude-opus-5' || name === 'claude-sonnet-5') return current('disabled', true)
  if (/^claude-opus-4-[78]$/.test(name)) return current('disabled', false)
  if (/^claude-(opus|sonnet)-4-6$/.test(name)) return current('disabled', false, ['low', 'medium', 'high', 'max'])
  if (/^claude-(opus|sonnet|haiku)-[34](-|$)/.test(name) || /^claude-3/.test(name)) return { known: true, mode: 'budget', off: 'omit', adaptive_by_default: false, efforts: [] }
  // a name not in the table (a newer model, a proxy's alias): the current way, and "off" left to the model's default
  return { ...current('omit', false), known: false }
}

/** The unified level as an effort this model takes: `minimal` is its lowest, and a level it lacks is the one below. */
function effortFor(level: string, efforts: readonly string[]): string {
  const wanted = level === 'minimal' ? 'low' : level
  if (efforts.includes(wanted)) return wanted
  const order: readonly string[] = ALL_EFFORTS
  for (let i = order.indexOf(wanted); i >= 0; i -= 1) if (efforts.includes(order[i]!)) return order[i]!
  return efforts[0] ?? 'low'
}

/** The request fields for the person's thinking choice on this model. Adaptive thinking asks for summarized
 *  reasoning: the current models otherwise return empty thinking blocks, and Sonnet 5.5 writes its notes between
 *  tool calls into them — the thread would show nothing between the calls. */
export function thinkingFields(model: string, thinking: ThinkingSetting, maxTokens: number): Record<string, unknown> {
  const family = claudeThinking(model)
  const adaptive = { type: 'adaptive', display: 'summarized' }
  const level = thinkingLevel(thinking)
  const off = thinking === false || thinking === 'off'
  if (family.mode === 'budget') {
    if (!level) return {}
    const budget = THINKING_BUDGETS[level]!
    return { thinking: { type: 'enabled', budget_tokens: budget }, ...(maxTokens <= budget ? { max_tokens: budget + 4096 } : {}) }
  }
  if (off) {
    if (family.off === 'between_tools') return { thinking: { type: 'between_tools' } }
    if (family.off === 'disabled') return { thinking: { type: 'disabled' } }
    if (family.off === 'low_effort') return { thinking: adaptive, output_config: { effort: 'low' } }
    return {}
  }
  if (level) return { thinking: adaptive, output_config: { effort: effortFor(level, family.efforts) } }
  return family.adaptive_by_default ? { thinking: adaptive } : {}
}

export interface AnthropicOptions extends HttpOptions {
  apiKey?: ApiKey
  baseUrl?: string
  /** extra headers on every request (a signing hook may replace them) */
  headers?: Record<string, string>
  /** the system blocks a subscription route prefixes (the CLI identity) */
  systemPrefix?: SystemBlock[]
  profile?: Partial<ModelProfile>
}

export class AnthropicModel implements Model {
  readonly system = 'anthropic'
  readonly profile: ModelProfile
  readonly baseUrl: string

  constructor(readonly model_name: string, readonly opts: AnthropicOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '')
    this.profile = { supports_thinking: true, builtin_tools: ['web_search'], ...opts.profile }
  }

  get url(): string { return `${this.baseUrl}/v1/messages` }

  get route(): string { return routeKey(this.system, this.url, this.model_name) }

  /** [system blocks, messages]: the request as the provider reads it. */
  mapMessages(messages: ModelMessage[], params: ModelRequestParameters): [SystemBlock[], Record<string, unknown>[]] {
    const systemTexts: string[] = []
    const out: Record<string, unknown>[] = []
    let instructions: string | null = null
    for (const message of messages) {
      if (isRequest(message)) {
        if (message.instructions) instructions = message.instructions
        const content: Record<string, unknown>[] = []
        for (const part of message.parts) {
          if (isSystemPromptPart(part)) systemTexts.push(part.content)
          else if (isUserPrompt(part)) {
            for (const block of userBlocks(part)) {
              content.push(block.type === 'text' ? block : block.type === 'file' ? nativeFileBlock(block, 'anthropic') : { type: 'image', source: { type: 'base64', media_type: block.media_type, data: block.data } })
            }
          }
          else if (isToolReturn(part)) {
            // a tool_result carries image blocks beside its text: the image stays inside the result it came from
            const { text, images } = toolReturnParts(part)
            const result = images.length
              ? [{ type: 'text', text }, ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } }))]
              : text
            content.push({ type: 'tool_result', tool_use_id: part.tool_call_id, content: result, is_error: false })
          }
          else if (isRetryPrompt(part)) {
            if (part.tool_call_id) content.push({ type: 'tool_result', tool_use_id: part.tool_call_id, content: retryPromptText(part), is_error: true })
            else content.push({ type: 'text', text: retryPromptText(part) })
          }
        }
        if (content.length) out.push({ role: 'user', content })
      } else if (isResponse(message)) {
        const content: Record<string, unknown>[] = []
        // a search the model asked for after a call of ours ended the turn was never run: it came with no result, and
        // Anthropic refuses its call without one. A paused turn goes back as it came (the provider runs what it left)
        const answered = new Set(message.parts.filter(isBuiltinReturn).map((p) => p.tool_call_id))
        const unrun = (id: string) => message.finish_reason !== 'pause_turn' && !answered.has(id)
        for (const part of message.parts) {
          // what Anthropic itself produced goes back as it came: the words with their citations, its web search's
          // call and results (another provider's are not its to read)
          const own = (part.provider_name ?? message.provider_name) === this.system
          if (isText(part)) {
            const citations = (part.provider_details as { citations?: unknown } | null | undefined)?.citations
            if (part.content) content.push(own && Array.isArray(citations) && citations.length ? { type: 'text', text: part.content, citations } : { type: 'text', text: part.content })
          }
          else if (isBuiltinCall(part)) { if (own && !unrun(part.tool_call_id)) content.push({ type: 'server_tool_use', id: part.tool_call_id, name: part.tool_name, input: argsDict(part.args) }) }
          else if (isBuiltinReturn(part)) {
            const block = (part.provider_details as { block?: unknown } | null | undefined)?.block
            if (own && block && typeof block === 'object') content.push(block as Record<string, unknown>)
          }
          else if (isThinking(part)) {
            // a thinking block travels back only to the provider that produced it: signed as it was, or redacted with
            // the data it came with (both unchanged: the provider checks them against the conversation that made them)
            if ((part.provider_name ?? message.provider_name) !== this.system) continue
            const redacted = (part.provider_details as { redacted_data?: unknown } | null)?.redacted_data
            if (typeof redacted === 'string' && redacted) content.push({ type: 'redacted_thinking', data: redacted })
            else if (part.signature) content.push({ type: 'thinking', thinking: part.content, signature: part.signature })
          } else if (isToolCall(part)) {
            content.push({ type: 'tool_use', id: part.tool_call_id, name: part.tool_name, input: argsDict(part.args) })
          }
        }
        if (content.length) out.push({ role: 'assistant', content })
      }
    }
    // consecutive same-role turns merge (the API refuses two user turns in a row)
    const merged: Record<string, unknown>[] = []
    for (const turn of out) {
      const last = merged[merged.length - 1]
      if (last && last.role === turn.role) last.content = [...(last.content as unknown[]), ...(turn.content as unknown[])]
      else merged.push(turn)
    }
    const system: SystemBlock[] = [...(this.opts.systemPrefix ?? [])]
    if (instructions) system.push({ type: 'text', text: instructions })
    for (const text of systemTexts) system.push({ type: 'text', text })
    void params
    return [system, merged]
  }

  body(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, stream: boolean): Record<string, unknown> {
    const [system, mapped] = this.mapMessages(messages, params)
    const cache = cacheControl(settings.cache_ttl)
    const body: Record<string, unknown> = { model: this.model_name, max_tokens: settings.max_tokens ?? 4096, messages: mapped, stream, cache_control: cache }
    if (system.length) {
      const last = system[system.length - 1]!
      system[system.length - 1] = { ...last, cache_control: cache }
      body.system = system
    }
    const tools: Record<string, unknown>[] = params.function_tools.map((t) => ({ name: t.name, description: t.description, input_schema: cleanSchema(t.parameters_json_schema) }))
    for (const tool of params.builtin_tools ?? []) {
      if (tool.kind === 'web_search') tools.push({ type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: tool.max_uses })
    }
    if (tools.length) body.tools = tools
    if (settings.temperature !== undefined) body.temperature = settings.temperature
    Object.assign(body, thinkingFields(this.model_name, params.thinking, body.max_tokens as number))
    return body
  }

  headers(): Record<string, string> {
    const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION, ...(this.opts.headers ?? {}) }
    const key = currentKey(this.opts.apiKey)
    if (key) headers['x-api-key'] = key
    return headers
  }

  async request(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<ModelResponse> {
    const response = await postJson(this.url, this.body(messages, settings, params, false), this.headers(), this.model_name, { ...this.opts, requestProtocol: 'anthropic' }, ctx?.signal)
    const data = (await response.json()) as Record<string, unknown>
    const builder = new ResponseBuilder(this.system, this.model_name, this.route)
    builder.model_name = (data.model as string) ?? null
    builder.provider_response_id = (data.id as string) ?? null
    builder.finish_reason = mapStop(data.stop_reason as string | null)
    const billing = new AnthropicUsage(params.builtin_tools?.some(t => t.kind === 'web_search'))
    billing.merge(data.usage)
    let index = 0
    for (const block of (data.content as Record<string, unknown>[]) ?? []) {
      billing.block(block)
      const part = partOf(block)
      if (part) { builder.start(index, part); builder.end(index); index += 1 }
    }
    builder.usage = billing.usage()
    return builder.response()
  }

  async requestStream(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<StreamedResponse> {
    const response = await postJson(this.url, this.body(messages, settings, params, true), this.headers(), this.model_name, { ...this.opts, requestProtocol: 'anthropic' }, ctx?.signal)
    const builder = new ResponseBuilder(this.system, this.model_name, this.route)
    const modelName = this.model_name
    const idleMs = this.opts.idleTimeoutMs
    const billing = new AnthropicUsage(params.builtin_tools?.some(t => t.kind === 'web_search'), true)
    const open = new Map<number, number>() // provider block index -> part index
    let next = 0
    const events = async function* (): AsyncGenerator<StreamEvent, void, undefined> {
      // the protocol's end: message_stop (a stop_reason in message_delta, which comes just before it, is taken too);
      // a stream that closes without either was cut, and what it carried is not a whole response
      let ended = false, messageStopped = false
      for await (const message of readSse(response, modelName, idleMs)) {
        if (!message.data) continue
        let data: Record<string, unknown>
        try { data = JSON.parse(message.data) } catch { continue }
        const type = data.type as string
        if (type === 'message_stop') { ended = true; messageStopped = true }
        else if (type === 'message_start') {
          const m = data.message as Record<string, unknown>
          builder.model_name = (m.model as string) ?? null
          builder.provider_response_id = (m.id as string) ?? null
          billing.merge(m.usage)
          builder.usage = billing.usage()
        } else if (type === 'content_block_start') {
          billing.block(data.content_block)
          builder.usage = billing.usage()
          const part = partOf(data.content_block as Record<string, unknown>)
          if (!part) continue
          const index = next++
          open.set(data.index as number, index)
          // a call's arguments stream after its start (a server tool's arrive whole when there are no deltas)
          if (isToolCall(part) || (isBuiltinCall(part) && Object.keys(argsDict(part.args)).length === 0)) yield builder.start(index, { ...part, args: '' })
          else yield builder.start(index, part)
        } else if (type === 'content_block_delta') {
          const index = open.get(data.index as number)
          if (index === undefined) continue
          const delta = data.delta as Record<string, unknown>
          if (delta.type === 'text_delta') yield builder.textDelta(index, delta.text as string)
          else if (delta.type === 'thinking_delta') yield builder.thinkingDelta(index, { content: delta.thinking as string })
          else if (delta.type === 'signature_delta') yield builder.thinkingDelta(index, { signature: delta.signature as string })
          else if (delta.type === 'input_json_delta') yield builder.argsDelta(index, delta.partial_json as string)
          else if (delta.type === 'citations_delta' && delta.citation && typeof delta.citation === 'object') yield builder.citation(index, delta.citation as Record<string, unknown>)
        } else if (type === 'content_block_stop') {
          const index = open.get(data.index as number)
          if (index !== undefined) yield builder.end(index)
        } else if (type === 'message_delta') {
          const delta = data.delta as Record<string, unknown> | undefined
          if (delta?.stop_reason) { builder.finish_reason = mapStop(delta.stop_reason as string); ended = true }
          billing.merge(data.usage)
          builder.usage = billing.usage()
        } else if (type === 'error') {
          const error = data.error as Record<string, unknown> | undefined
          throw new ModelAPIError(modelName, `Anthropic stream error: ${String(error?.type ?? 'error')}: ${String(error?.message ?? '')}`.trim())
        }
      }
      if (!ended) throw new ModelAPIError(modelName, 'the Anthropic stream ended before message_stop')
      // Preserve the legacy stop_reason acceptance, but only a protocol stop seals billing.
      if (messageStopped) billing.complete()
      builder.usage = billing.usage()
    }
    return streamedResponse(builder, events)
  }
}

function partOf(block: Record<string, unknown>): ResponsePart | null {
  switch (block.type) {
    case 'text': {
      const citations = Array.isArray(block.citations) && block.citations.length ? block.citations : null
      return { part_kind: 'text', content: (block.text as string) ?? '', id: null, provider_name: 'anthropic', provider_details: citations ? { citations } : null }
    }
    case 'server_tool_use': return {
      part_kind: 'builtin-tool-call', tool_name: String(block.name ?? 'server_tool'), args: (block.input as Record<string, unknown>) ?? {},
      tool_call_id: String(block.id ?? newId('srvtoolu')), provider_name: 'anthropic', provider_details: null,
    }
    case 'web_search_tool_result': return {
      part_kind: 'builtin-tool-return', tool_name: 'web_search', tool_call_id: String(block.tool_use_id ?? ''), content: searchResultsOf(block.content),
      provider_name: 'anthropic', provider_details: { block },
    }
    case 'thinking': return { part_kind: 'thinking', content: (block.thinking as string) ?? '', id: null, signature: (block.signature as string) || null, provider_name: 'anthropic', provider_details: null }
    case 'redacted_thinking': return { part_kind: 'thinking', content: '', id: null, signature: null, provider_name: 'anthropic', provider_details: { redacted_data: (block.data as string) ?? '' } }
    case 'tool_use': return {
      part_kind: 'tool-call', tool_name: block.name as string, args: (block.input as Record<string, unknown>) ?? {},
      tool_call_id: (block.id as string) || newId('toolu'), id: null, provider_name: 'anthropic', provider_details: null,
    }
    default: return null
  }
}

/** A web search's results as the person reads them: the title, the address and the page's age of each (what only
 *  Anthropic reads stays in the block); an error as its code. */
function searchResultsOf(content: unknown): Record<string, unknown> {
  if (!Array.isArray(content)) {
    const code = content && typeof content === 'object' ? (content as Record<string, unknown>).error_code : null
    return { status: 'error', error_code: typeof code === 'string' ? code : 'unknown' }
  }
  const results = content.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as Record<string, unknown>).url === 'string')
    .map((r) => ({ title: String(r.title ?? ''), url: String(r.url), ...(typeof r.page_age === 'string' ? { page_age: r.page_age } : {}) }))
  return { status: 'ok', results }
}

function mapStop(reason: string | null | undefined): string | null {
  switch (reason) {
    case 'end_turn': case 'stop_sequence': return 'stop'
    case 'max_tokens': return 'length'
    case 'tool_use': return 'tool_call'
    case 'refusal': return 'content_filter'
    case null: case undefined: return null
    default: return reason
  }
}

/** The provider's count with the cache reads and writes inside input_tokens (the inclusive convention); null: none. */
export function mapUsage(usage: Record<string, unknown> | undefined): RequestUsage | null {
  const billing = new AnthropicUsage()
  billing.merge(usage)
  return billing.usage()
}
