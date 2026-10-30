import { safeProviderStreamError } from './standard_errors.ts'
/** The OpenAI Responses API over fetch: instructions from the requests' instructions and system parts, input items
 *  (user messages, function_call / function_call_output pairs by call_id, reasoning items with their encrypted
 *  content sent back only to the provider that produced them), tools as functions, the SSE event stream read into
 *  parts. `store` is false so the encrypted reasoning can travel with the history instead of the provider's state.
 *  The prompt cache is the provider's own (a prefix match on the input); `prompt_cache_key` names the conversation
 *  so its requests are routed alike, on the API route and the Codex route both — and the Codex route names it in
 *  its headers as well (`conversationHeaders`), which is what its backend routes by. The web search OpenAI runs itself
 *  (declared when the request names it): its `web_search_call` item — the queries and the pages it found — comes back
 *  as a call and its results, and goes back to OpenAI as the item it came as; the words already carry their cited
 *  pages as links, so the `url_citation` annotations are kept on the part only to go back with it. */

import { newId } from '../../ids.ts'
import { cleanSchema, postJson, readSse, type HttpOptions } from '../http.ts'
import {
  argsText, isBuiltinCall, isRequest, isResponse, isRetryPrompt, isSystemPromptPart, isText, isThinking, isToolCall, isToolReturn, isUserPrompt,
  type ModelMessage, type ModelResponse, type RequestUsage, type ResponsePart,
} from '../messages.ts'
import { ModelAPIError, type Model, type ModelProfile, type ModelRequestParameters, type ModelSettings, type RequestContext, type StreamEvent, type StreamedResponse } from '../model.ts'
import { type ApiKey, countedUsage, currentKey, routeKey, REASONING_EFFORTS, ResponseBuilder, retryPromptText, routeThinking, streamedResponse, thinkingLevel, toolReturnParts, userBlocks, nativeFileBlock } from './common.ts'

export interface ResponsesOptions extends HttpOptions {
  apiKey?: ApiKey
  baseUrl?: string
  headers?: Record<string, string>
  profile?: Partial<ModelProfile> & { openai_supports_encrypted_reasoning_content?: boolean }
  /** the subscription route: store false, no max_output_tokens, instructions always present, completion required */
  codex?: boolean
}

export class OpenAIResponsesModel implements Model {
  get system(): string { return 'openai' }
  /** DeepSeek returns raw reasoning content, not OpenAI summaries/encrypted content. */
  protected get plainReasoning(): boolean { return false }
  readonly profile: ModelProfile
  readonly baseUrl: string
  readonly encryptedReasoning: boolean

  constructor(readonly model_name: string, readonly opts: ResponsesOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
    this.profile = { supports_thinking: true, ...(opts.profile ?? {}) }
    this.encryptedReasoning = opts.profile?.openai_supports_encrypted_reasoning_content ?? true
  }

  get url(): string { return `${this.baseUrl}/responses` }

  get route(): string { return routeKey(this.system, this.url, this.model_name) }

  /** [instructions, input items] */
  mapMessages(messages: ModelMessage[]): [string | null, Record<string, unknown>[]] {
    const items: Record<string, unknown>[] = []
    const systemTexts: string[] = []
    let instructions: string | null = null
    for (const message of messages) {
      if (isRequest(message)) {
        if (message.instructions) instructions = message.instructions
        for (const part of message.parts) {
          if (isSystemPromptPart(part)) systemTexts.push(part.content)
          else if (isUserPrompt(part)) {
            items.push({ role: 'user', content: userBlocks(part).map((b) => (b.type === 'text' ? { type: 'input_text', text: b.text }
              : b.type === 'file' ? nativeFileBlock(b, 'responses') : { type: 'input_image', image_url: `data:${b.media_type};base64,${b.data}` })) })
          }
          else if (isToolReturn(part)) {
            // a function_call_output's output may be a list of input_text / input_image: the image stays in the output
            const { text, images } = toolReturnParts(part)
            const output = images.length
              ? [{ type: 'input_text', text }, ...images.map((i) => ({ type: 'input_image', image_url: `data:${i.media_type};base64,${i.data}` }))]
              : text
            items.push({ type: 'function_call_output', call_id: part.tool_call_id, output })
          }
          else if (isRetryPrompt(part)) {
            if (part.tool_call_id) items.push({ type: 'function_call_output', call_id: part.tool_call_id, output: retryPromptText(part) })
            else items.push({ role: 'user', content: [{ type: 'input_text', text: retryPromptText(part) }] })
          }
        }
      } else if (isResponse(message)) {
        for (const part of message.parts) {
          const own = (part.provider_name ?? message.provider_name) === this.system
          if (isText(part)) {
            if (!part.content) continue
            const annotations = own ? (part.provider_details as { annotations?: unknown } | null | undefined)?.annotations : null
            const item: Record<string, unknown> = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: part.content, annotations: Array.isArray(annotations) ? annotations : [] }], status: 'completed' }
            if (part.id && own) item.id = part.id
            items.push(item)
          } else if (isBuiltinCall(part)) {
            // OpenAI's own search goes back as the item it came as (its results are in it); another provider's is not its to read
            const item = (part.provider_details as { item?: unknown } | null | undefined)?.item
            if (own && item && typeof item === 'object') items.push(item as Record<string, unknown>)
          } else if (isThinking(part)) {
            // reasoning travels back only to the provider that produced it, as the item it came in
            if (this.plainReasoning) {
              const kept = part.provider_details?.responses_reasoning as { source?: string; item?: Record<string, unknown> } | undefined
              if (own && kept?.source === this.route && kept.item) items.push(kept.item)
              continue
            }
            if (!own || !part.id) continue
            const encrypted = (part.provider_details as { encrypted_content?: string } | null)?.encrypted_content
            if (!encrypted && !part.content) continue
            const item: Record<string, unknown> = { type: 'reasoning', id: part.id, summary: part.content ? [{ type: 'summary_text', text: part.content }] : [] }
            if (encrypted) item.encrypted_content = encrypted
            items.push(item)
          } else if (isToolCall(part)) {
            const item: Record<string, unknown> = { type: 'function_call', call_id: part.tool_call_id, name: part.tool_name, arguments: argsText(part.args) }
            if (part.id && own) item.id = part.id
            items.push(item)
          }
        }
      }
    }
    const texts = [instructions, ...systemTexts].filter((t): t is string => !!t)
    return [texts.length ? texts.join('\n\n') : null, items]
  }

  body(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters): Record<string, unknown> {
    const [instructions, input] = this.mapMessages(messages)
    const body: Record<string, unknown> = { model: this.model_name, input, stream: true, store: false }
    if (settings.cache_key) body.prompt_cache_key = settings.cache_key
    if (this.opts.codex) body.instructions = instructions ?? 'You are a helpful assistant.'
    else if (instructions) body.instructions = instructions
    if (params.function_tools.length) {
      body.tools = params.function_tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: cleanSchema(t.parameters_json_schema), strict: false }))
    }
    if (!this.opts.codex && settings.max_tokens) body.max_output_tokens = settings.max_tokens
    if (settings.temperature !== undefined) body.temperature = settings.temperature
    const search = (params.builtin_tools ?? []).some((t) => t.kind === 'web_search')
    // the provider's search takes no per-response cap (the Anthropic tool's max_uses has no counterpart here)
    if (search) body.tools = [...((body.tools as Record<string, unknown>[] | undefined) ?? []), { type: 'web_search' }]
    const include = [...(this.encryptedReasoning ? ['reasoning.encrypted_content'] : []), ...(search ? ['web_search_call.action.sources'] : [])]
    if (include.length) body.include = include
    // the route's settings raise it already; said here too so no request carries the pair OpenAI refuses
    const level = routeThinking(thinkingLevel(params.thinking), null, search)
    if (level) body.reasoning = { effort: REASONING_EFFORTS[level], summary: 'auto' }
    else if (params.thinking === false) body.reasoning = { effort: 'none' }
    // the reasoning mode is its own dimension beside the effort; the API route only (the Codex route never sends it)
    if (settings.reasoning_mode && !this.opts.codex) body.reasoning = { ...((body.reasoning as Record<string, unknown> | undefined) ?? {}), mode: settings.reasoning_mode }
    return body
  }

  /** The conversation as the Codex backend reads it: the headers its own client names a thread by. The backend sends
   *  a request to the machine that holds the conversation's cache by these, not by the body's `prompt_cache_key`:
   *  six requests of one growing conversation read 0 cached tokens without them and 99 % of the request before with
   *  them (gpt-6.1-sol on the owner's sign-in, 2026-10-01). */
  conversationHeaders(settings: ModelSettings): Record<string, string> {
    if (!this.opts.codex || !settings.cache_key) return {}
    return { 'session-id': settings.cache_key, 'thread-id': settings.cache_key, 'x-client-request-id': settings.cache_key }
  }

  headers(settings: ModelSettings = {}): Record<string, string> {
    const headers: Record<string, string> = { ...(this.opts.headers ?? {}), ...this.conversationHeaders(settings) }
    const key = currentKey(this.opts.apiKey)
    if (key) headers.authorization = `Bearer ${key}`
    return headers
  }

  /** The Responses route serves streams; a non-streaming request is a drained stream. */
  async request(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<ModelResponse> {
    const stream = await this.requestStream(messages, settings, params, ctx)
    for await (const _ of stream.events()) { /* drain */ }
    return stream.get()
  }

  async requestStream(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<StreamedResponse> {
    const response = await postJson(this.url, this.body(messages, settings, params), this.headers(settings), this.model_name, { ...this.opts, requestProtocol: 'openai' }, ctx?.signal)
    const builder = new ResponseBuilder(this.system, this.model_name, this.route)
    const modelName = this.model_name
    const system = this.system
    const plainReasoning = this.plainReasoning
    const route = this.route
    const idleMs = this.opts.idleTimeoutMs
    const codex = !!this.opts.codex
    const open = new Map<number, number>() // output_index -> part index
    let next = 0
    const events = async function* (): AsyncGenerator<StreamEvent, void, undefined> {
      let completed = false
      for await (const message of readSse(response, modelName, idleMs)) {
        if (!message.data || message.data === '[DONE]') continue
        let data: Record<string, unknown>
        try { data = JSON.parse(message.data) } catch { continue }
        const type = data.type as string
        if (type === 'response.created') {
          const r = data.response as Record<string, unknown>
          builder.provider_response_id = (r.id as string) ?? null
          builder.model_name = (r.model as string) ?? null
        } else if (type === 'response.output_item.added') {
          const item = data.item as Record<string, unknown>
          const part = partOf(item, system)
          if (!part) continue
          const index = next++
          open.set(data.output_index as number, index)
          yield builder.start(index, isToolCall(part) ? { ...part, args: '' } : isBuiltinCall(part) ? part : { ...part, content: '' })
        } else if (type === 'response.output_text.delta') {
          const index = open.get(data.output_index as number)
          if (index !== undefined) yield builder.textDelta(index, data.delta as string)
        } else if (type === 'response.function_call_arguments.delta') {
          const index = open.get(data.output_index as number)
          if (index !== undefined) yield builder.argsDelta(index, data.delta as string)
        } else if (type === (plainReasoning ? 'response.reasoning_text.delta' : 'response.reasoning_summary_text.delta')) {
          const index = open.get(data.output_index as number)
          if (index !== undefined) yield builder.thinkingDelta(index, { content: data.delta as string })
        } else if (type === 'response.output_item.done') {
          const index = open.get(data.output_index as number)
          if (index === undefined) continue
          const item = data.item as Record<string, unknown>
          const current = builder.get(index)!
          if (isToolCall(current)) {
            const args = (item.arguments as string) ?? ''
            const buffered = builder.argsBuffered(index)
            if (!buffered && args) builder.argsDelta(index, args)
            yield builder.end(index, { tool_call_id: (item.call_id as string) || current.tool_call_id, id: (item.id as string) ?? null })
          } else if (isThinking(current)) {
            const summary = ((item.summary as { text?: string }[]) ?? []).map((s) => s.text ?? '').join('\n')
            if (plainReasoning) {
              const content = ((item.content as { type?: string; text?: string }[]) ?? []).filter((c) => c.type === 'reasoning_text').map((c) => c.text ?? '').join('')
              // Keep the complete item unchanged, independently of displayed text.
              yield builder.end(index, { content: content || current.content, id: (item.id as string) ?? null,
                provider_details: { responses_reasoning: { source: route, item } } })
              continue
            }
            const encrypted = item.encrypted_content as string | undefined
            yield builder.end(index, {
              content: summary || current.content, id: (item.id as string) ?? null,
              provider_details: encrypted ? { ...(current.provider_details ?? {}), encrypted_content: encrypted } : current.provider_details,
            })
          } else if (isText(current)) {
            const outputs = ((item.content as { type?: string; text?: string; annotations?: unknown[] }[]) ?? []).filter((c) => c.type === 'output_text')
            const text = outputs.map((c) => c.text ?? '').join('')
            const annotations = outputs.flatMap((c) => (Array.isArray(c.annotations) ? c.annotations : []))
            yield builder.end(index, { content: text || current.content, id: (item.id as string) ?? null, provider_details: annotations.length ? { annotations } : null })
          } else if (isBuiltinCall(current)) {
            // the search's call and, beside it, what it found: the item holds both, so it ends the call and adds the results
            yield builder.end(index, { args: searchArgs(item), provider_details: { item } })
            const results = next++
            yield builder.start(results, {
              part_kind: 'builtin-tool-return', tool_name: 'web_search', tool_call_id: current.tool_call_id, content: searchResultsOf(item),
              provider_name: system, provider_details: null,
            })
            yield builder.end(results)
          } else {
            yield builder.end(index)
          }
        } else if (type === 'response.completed') {
          completed = true
          const r = data.response as Record<string, unknown>
          builder.usage = mapUsage(r.usage as Record<string, unknown> | undefined)
          builder.model_name = (r.model as string) ?? builder.model_name
          builder.provider_response_id = (r.id as string) ?? builder.provider_response_id
          builder.finish_reason = builder.parts.some((p) => p && isToolCall(p)) ? 'tool_call' : 'stop'
        } else if (type === 'response.incomplete') {
          const r = data.response as Record<string, unknown>
          builder.usage = mapUsage(r.usage as Record<string, unknown> | undefined)
          if (codex) throw new ModelAPIError(modelName, 'Codex response incomplete')
          completed = true
          const reason = ((r.incomplete_details as Record<string, unknown> | undefined)?.reason as string | undefined) ?? 'max_output_tokens'
          builder.finish_reason = reason === 'content_filter' ? 'content_filter' : 'length'
        } else if (type === 'response.failed' || type === 'error') {
          const r = (data.response as Record<string, unknown> | undefined) ?? data
          const error = (r.error as Record<string, unknown> | undefined) ?? (data.error as Record<string, unknown> | undefined)
          if (codex) {
            if (error?.code === 'server_error') throw new ModelAPIError(modelName, 'Codex stream error (server_error)')
            throw new ModelAPIError(modelName, 'Codex response failed; check provider access and limits')
          }
          if (system === 'deepseek') throw safeProviderStreamError(error ?? data, system, modelName)
          if (system !== 'openai') throw new ModelAPIError(modelName, `${system} response failed`)
          throw new ModelAPIError(modelName, `OpenAI response failed: ${String(error?.code ?? error?.type ?? 'error')}: ${String(error?.message ?? '')}`.trim())
        }
      }
      if (!completed) {
        if (codex) throw new ModelAPIError(modelName, 'Codex stream ended before response.completed')
        throw new ModelAPIError(modelName, 'OpenAI stream ended before response.completed')
      }
    }
    return streamedResponse(builder, events)
  }
}

function partOf(item: Record<string, unknown>, system = 'openai'): ResponsePart | null {
  switch (item.type) {
    case 'message': {
      const text = ((item.content as { type?: string; text?: string }[]) ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? '').join('')
      return { part_kind: 'text', content: text, id: (item.id as string) ?? null, provider_name: system, provider_details: null }
    }
    case 'function_call': return {
      part_kind: 'tool-call', tool_name: item.name as string, args: (item.arguments as string) ?? '',
      tool_call_id: (item.call_id as string) || newId('call'), id: (item.id as string) ?? null, provider_name: system, provider_details: null,
    }
    case 'web_search_call': return {
      part_kind: 'builtin-tool-call', tool_name: 'web_search', args: {}, tool_call_id: (item.id as string) || newId('ws'),
      provider_name: system, provider_details: null,
    }
    case 'reasoning': {
      const summary = ((item.summary as { text?: string }[]) ?? []).map((s) => s.text ?? '').join('\n')
      const encrypted = item.encrypted_content as string | undefined
      return {
        part_kind: 'thinking', content: summary, id: (item.id as string) ?? null, signature: null, provider_name: system,
        provider_details: encrypted ? { encrypted_content: encrypted } : null,
      }
    }
    default: return null
  }
}

/** What the search was asked: its queries as the action names them (the first as `query`, as the thread shows one). */
function searchArgs(item: Record<string, unknown>): Record<string, unknown> {
  const action = (item.action as Record<string, unknown> | undefined) ?? {}
  const queries = Array.isArray(action.queries) ? action.queries.filter((q): q is string => typeof q === 'string') : []
  const query = typeof action.query === 'string' ? action.query : queries[0]
  if (action.type !== undefined && action.type !== 'search') {
    return { action: action.type, ...(typeof action.url === 'string' ? { url: action.url } : {}), ...(typeof action.pattern === 'string' ? { pattern: action.pattern } : {}) }
  }
  return { ...(query ? { query } : {}), ...(queries.length > 1 ? { queries } : {}) }
}

/** A search's results as the person reads them: the pages it found (OpenAI names addresses only); a failure as its status.
 *  Opening a page or finding in one is read on OpenAI's side: no results come back, only that it was done. */
function searchResultsOf(item: Record<string, unknown>): Record<string, unknown> {
  if (item.status === 'failed') return { status: 'error', error_code: 'failed' }
  const action = (item.action as Record<string, unknown> | undefined) ?? {}
  if (typeof action.type === 'string' && action.type !== 'search') return { status: 'ok', action: action.type }
  const sources = (action.sources as unknown[] | undefined) ?? []
  const results = sources.filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && typeof (s as Record<string, unknown>).url === 'string')
    .map((s) => ({ title: typeof s.title === 'string' ? s.title : '', url: String(s.url) }))
  return { status: 'ok', results }
}

export function mapUsage(usage: Record<string, unknown> | undefined): RequestUsage | null {
  const details = (usage?.input_tokens_details as Record<string, unknown> | undefined) ?? {}
  const counted = countedUsage(usage ? { input_tokens: usage.input_tokens, cache_read_tokens: details.cached_tokens, output_tokens: usage.output_tokens } : null)
  const reasoning = (usage?.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens
  return counted && typeof reasoning === 'number' && Number.isSafeInteger(reasoning) && reasoning >= 0 && reasoning <= counted.output_tokens
    ? { ...counted, details: { reasoning_tokens: reasoning } } : counted
}
