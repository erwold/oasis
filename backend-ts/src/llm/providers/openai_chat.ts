/** OpenAI Chat Completions over fetch, for a compatible endpoint configured with api=chat: system / user / assistant
 *  / tool messages, tool_calls by id, the chunk stream with `stream_options.include_usage`. Reasoning a compatible
 *  server streams (`reasoning_content`, `reasoning`, `reasoning_details`) becomes a thinking part. It is sent back
 *  only when the route names the field its endpoint requires back (`reasoningReplay`): then what arrived under that
 *  field is kept whole with the endpoint and model it came from, and put back on that assistant turn for the same
 *  endpoint and model only — another route's reasoning (another endpoint, model, or the Responses API) never is. The
 *  official endpoint gets `prompt_cache_key` (the conversation, for the provider's cache routing); a compatible
 *  endpoint is sent nothing it may not know, besides the fields its route's `extraBody` names. */

export const OFFICIAL_OPENAI_BASE_URL = 'https://api.openai.com/v1'

import { safeProviderStreamError } from './standard_errors.ts'
import { newId } from '../../ids.ts'
import { cleanSchema, postJson, readSse, type HttpOptions } from '../http.ts'
import {
  argsText, isRequest, isResponse, isRetryPrompt, isSystemPromptPart, isText, isThinking, isToolCall, isToolReturn, isUserPrompt,
  type ModelMessage, type ModelResponse, type RequestUsage,
} from '../messages.ts'
import { ModelAPIError, type Model, type ModelProfile, type ModelRequestParameters, type ModelSettings, type RequestContext, type StreamEvent, type StreamedResponse } from '../model.ts'
import { type ApiKey, countedUsage, currentKey, routeKey, REASONING_EFFORTS, ResponseBuilder, retryPromptText, returnedImagesNote, streamedResponse, thinkingLevel, toolReturnParts, userBlocks, nativeFileBlock } from './common.ts'

export interface ChatOptions extends HttpOptions {
  apiKey?: ApiKey
  baseUrl?: string
  headers?: Record<string, string>
  profile?: Partial<ModelProfile>
  /** the field the endpoint's reasoning arrives in and must be sent back in (null: shown, never sent back) */
  reasoningReplay?: 'reasoning_content' | 'reasoning_details' | null
  /** fields added to every request body as they are (the endpoint's own switches) */
  extraBody?: Record<string, unknown>
}

/** A thinking part's reasoning as a Chat endpoint sent it, kept for sending back: the field, its whole value, and the
 *  endpoint and model it came from. */
export interface ChatReasoning { field: 'reasoning_content' | 'reasoning_details'; value: unknown; source: string }

export function chatReasoningOf(details: Record<string, unknown> | null | undefined): ChatReasoning | null {
  const r = details?.chat_reasoning as ChatReasoning | undefined
  return r && typeof r === 'object' && (r.field === 'reasoning_content' || r.field === 'reasoning_details') && typeof r.source === 'string' ? r : null
}

/** reasoning_details pieces merged as they stream: by their index, text appended, the other fields as they came. */
function mergeDetails(into: Record<string, unknown>[], delta: unknown): void {
  if (!Array.isArray(delta)) return
  delta.forEach((raw, position) => {
    if (!raw || typeof raw !== 'object') return
    const item = raw as Record<string, unknown>
    const key = typeof item.index === 'number' ? item.index : position
    const at = into.findIndex((d, i) => (typeof d.index === 'number' ? d.index : i) === key)
    if (at === -1) { into.push({ ...item }); return }
    const current = into[at]!
    for (const [k, v] of Object.entries(item)) {
      if (v === undefined || v === null) continue
      if ((k === 'text' || k === 'summary' || k === 'data') && typeof v === 'string' && typeof current[k] === 'string') current[k] = (current[k] as string) + v
      else current[k] = v
    }
  })
}

function detailsText(details: Record<string, unknown>[]): string {
  return details.map((d) => (typeof d.text === 'string' ? d.text : typeof d.summary === 'string' ? d.summary : '')).join('')
}

export class OpenAIChatModel implements Model {
  get system(): string { return 'openai' }
  readonly profile: ModelProfile
  readonly baseUrl: string

  constructor(readonly model_name: string, readonly opts: ChatOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
    this.profile = { supports_thinking: true, ...(opts.profile ?? {}) }
  }

  get url(): string { return `${this.baseUrl}/chat/completions` }

  get route(): string { return routeKey(this.system, this.url, this.model_name) }

  /** Where this route's reasoning comes from: its endpoint, its model, the field. */
  get reasoningSource(): string { return `${this.baseUrl} ${this.model_name} ${this.opts.reasoningReplay ?? 'none'}` }

  mapMessages(messages: ModelMessage[]): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = []
    let instructions: string | null = null
    for (const message of messages) {
      if (isRequest(message)) {
        if (message.instructions) instructions = message.instructions
        // a tool message carries text only: images a tool returned follow the request's tool messages as user messages
        const returnedImages: Record<string, unknown>[] = []
        for (const part of message.parts) {
          if (isSystemPromptPart(part)) out.push({ role: 'system', content: part.content })
          else if (isUserPrompt(part)) {
            const blocks = userBlocks(part)
            // a text-only part stays the plain string it always was; with images, the content-part list
            out.push({ role: 'user', content: blocks.length === 1 && blocks[0]!.type === 'text' ? blocks[0]!.text
              : blocks.map((b) => (b.type === 'text' ? b : b.type === 'file' ? nativeFileBlock(b, 'chat') : { type: 'image_url', image_url: { url: `data:${b.media_type};base64,${b.data}` } })) })
          }
          else if (isToolReturn(part)) {
            const { text, images } = toolReturnParts(part)
            out.push({ role: 'tool', tool_call_id: part.tool_call_id, content: text })
            if (images.length) {
              returnedImages.push({ role: 'user', content: [{ type: 'text', text: returnedImagesNote(part) },
                ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.media_type};base64,${i.data}` } }))] })
            }
          }
          else if (isRetryPrompt(part)) {
            if (part.tool_call_id) out.push({ role: 'tool', tool_call_id: part.tool_call_id, content: retryPromptText(part) })
            else out.push({ role: 'user', content: retryPromptText(part) })
          }
        }
        out.push(...returnedImages)
      } else if (isResponse(message)) {
        const texts: string[] = []
        const calls: Record<string, unknown>[] = []
        let reasoning: ChatReasoning | null = null
        for (const part of message.parts) {
          if (isText(part)) { if (part.content) texts.push(part.content) }
          else if (isThinking(part)) {
            // sent back only where it came from, under the field it came in
            const kept = chatReasoningOf(part.provider_details)
            if (kept !== null && this.opts.reasoningReplay && kept.field === this.opts.reasoningReplay && kept.source === this.reasoningSource) reasoning = kept
          }
          else if (isToolCall(part)) calls.push({ id: part.tool_call_id, type: 'function', function: { name: part.tool_name, arguments: argsText(part.args) } })
        }
        if (texts.length || calls.length || reasoning !== null) {
          const item: Record<string, unknown> = { role: 'assistant', content: texts.length ? texts.join('\n\n') : null }
          if (reasoning !== null) item[reasoning.field] = reasoning.value
          if (calls.length) item.tool_calls = calls
          out.push(item)
        }
      }
    }
    if (instructions) out.unshift({ role: 'system', content: instructions })
    return out
  }

  body(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters): Record<string, unknown> {
    const body: Record<string, unknown> = { ...(this.opts.extraBody ?? {}), model: this.model_name, messages: this.mapMessages(messages), stream: true, stream_options: { include_usage: true } }
    if (settings.cache_key && this.baseUrl === OFFICIAL_OPENAI_BASE_URL) body.prompt_cache_key = settings.cache_key
    if (params.function_tools.length) {
      body.tools = params.function_tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: cleanSchema(t.parameters_json_schema) } }))
    }
    if (settings.max_tokens) body.max_completion_tokens = settings.max_tokens
    if (settings.temperature !== undefined) body.temperature = settings.temperature
    const level = thinkingLevel(params.thinking)
    if (level) body.reasoning_effort = REASONING_EFFORTS[level]
    return body
  }

  protected finishReason(reason: string): string { return mapFinish(reason) }

  headers(): Record<string, string> {
    const headers: Record<string, string> = { ...(this.opts.headers ?? {}) }
    const key = currentKey(this.opts.apiKey)
    if (key) headers.authorization = `Bearer ${key}`
    return headers
  }

  async request(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<ModelResponse> {
    const stream = await this.requestStream(messages, settings, params, ctx)
    for await (const _ of stream.events()) { /* drain */ }
    return stream.get()
  }

  async requestStream(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<StreamedResponse> {
    const response = await postJson(this.url, this.body(messages, settings, params), this.headers(), this.model_name, { ...this.opts, requestProtocol: 'openai' }, ctx?.signal)
    const builder = new ResponseBuilder(this.system, this.model_name, this.route)
    const modelName = this.model_name
    const system = this.system
    const finishReason = (reason: string) => this.finishReason(reason)
    const idleMs = this.opts.idleTimeoutMs
    const replay = this.opts.reasoningReplay ?? null
    const source = this.reasoningSource
    const events = async function* (): AsyncGenerator<StreamEvent, void, undefined> {
      // the reasoning as it arrived under the route's field, whole (a string, or the merged reasoning_details)
      let keptContent = ''
      const keptDetails: Record<string, unknown>[] = []
      let keptAny = false
      let textIndex: number | null = null
      let thinkingIndex: number | null = null
      const callIndex = new Map<number, number>() // tool_calls[i].index -> part index
      // the calls whose first chunk carried no id (theirs is made up until the provider's arrives)
      const madeUpIds = new Set<number>()
      let next = 0
      let sawChunk = false
      // the protocol's end: a choice's finish_reason, or the closing [DONE] (a compatible server may send only one)
      let ended = false
      for await (const message of readSse(response, modelName, idleMs)) {
        if (message.data === '[DONE]') { ended = true; continue }
        if (!message.data) continue
        let data: Record<string, unknown>
        try { data = JSON.parse(message.data) } catch { continue }
        if (data.error) {
          const error = data.error as Record<string, unknown>
          if (system === 'zhipu') throw safeProviderStreamError(error, system, modelName)
          throw new ModelAPIError(modelName, system === 'openai' ? `chat completion failed: ${String(error.message ?? error.code ?? 'error')}` : `${system} chat completion failed`)
        }
        sawChunk = true
        if (data.id) builder.provider_response_id = data.id as string
        if (data.model) builder.model_name = data.model as string
        if (data.usage) builder.usage = mapUsage(data.usage as Record<string, unknown>)
        for (const choice of (data.choices as Record<string, unknown>[]) ?? []) {
          const delta = (choice.delta as Record<string, unknown>) ?? {}
          if (replay === 'reasoning_content' && typeof delta.reasoning_content === 'string') { keptContent += delta.reasoning_content; keptAny = true }
          let reasoning = (delta.reasoning_content ?? delta.reasoning) as string | undefined
          if (Array.isArray(delta.reasoning_details)) {
            const before = detailsText(keptDetails)
            mergeDetails(keptDetails, delta.reasoning_details)
            if (replay === 'reasoning_details') keptAny = true
            // shown as it grows, when no plain reasoning field carries the same words
            if (!reasoning) reasoning = detailsText(keptDetails).slice(before.length) || undefined
          }
          if (reasoning) {
            if (thinkingIndex === null) {
              thinkingIndex = next++
              yield builder.start(thinkingIndex, { part_kind: 'thinking', content: '', id: null, signature: null, provider_name: system, provider_details: null })
            }
            yield builder.thinkingDelta(thinkingIndex, { content: reasoning })
          }
          if (typeof delta.content === 'string' && delta.content) {
            if (textIndex === null) {
              textIndex = next++
              yield builder.start(textIndex, { part_kind: 'text', content: '', id: null, provider_name: system, provider_details: null })
            }
            yield builder.textDelta(textIndex, delta.content)
          }
          for (const call of (delta.tool_calls as Record<string, unknown>[]) ?? []) {
            const i = (call.index as number) ?? 0
            let index = callIndex.get(i)
            const fn = (call.function as Record<string, unknown>) ?? {}
            if (index === undefined) {
              index = next++
              callIndex.set(i, index)
              if (!call.id) madeUpIds.add(index)
              yield builder.start(index, {
                part_kind: 'tool-call', tool_name: (fn.name as string) ?? '', args: '', tool_call_id: (call.id as string) || newId('call'),
                id: null, provider_name: system, provider_details: null,
              })
            } else if (fn.name || call.id) {
              // a later chunk of the same call: its name streams in pieces like its arguments (each piece is appended),
              // and an id that arrives after the first chunk replaces the one made up for it
              const current = builder.get(index)!
              if (isToolCall(current)) {
                builder.parts[index] = {
                  ...current, tool_name: current.tool_name + (typeof fn.name === 'string' ? fn.name : ''),
                  tool_call_id: typeof call.id === 'string' && call.id && madeUpIds.has(index) ? call.id : current.tool_call_id,
                }
                if (typeof call.id === 'string' && call.id) madeUpIds.delete(index)
              }
            }
            if (typeof fn.arguments === 'string' && fn.arguments) yield builder.argsDelta(index, fn.arguments)
          }
          if (choice.finish_reason) { builder.finish_reason = finishReason(choice.finish_reason as string); ended = true }
        }
      }
      if (!sawChunk) throw new ModelAPIError(modelName, 'the chat completion stream carried no chunks')
      if (!ended) throw new ModelAPIError(modelName, 'the chat completion stream ended without a finish_reason or [DONE]')
      if (keptAny) {
        const value = replay === 'reasoning_details' ? keptDetails : keptContent
        const kept: ChatReasoning = { field: replay!, value, source }
        if (thinkingIndex === null) {
          thinkingIndex = next++
          builder.start(thinkingIndex, { part_kind: 'thinking', content: '', id: null, signature: null, provider_name: system, provider_details: null })
        }
        builder.parts[thinkingIndex] = { ...builder.get(thinkingIndex)!, provider_details: { chat_reasoning: kept as unknown as Record<string, unknown> } } as never
      }
      if (thinkingIndex !== null) yield builder.end(thinkingIndex)
      if (textIndex !== null) yield builder.end(textIndex)
      for (const index of callIndex.values()) yield builder.end(index)
    }
    return streamedResponse(builder, events)
  }
}

function mapFinish(reason: string): string {
  switch (reason) {
    case 'stop': return 'stop'
    case 'length': return 'length'
    case 'tool_calls': case 'function_call': return 'tool_call'
    case 'content_filter': return 'content_filter'
    default: return reason
  }
}

export function mapUsage(usage: Record<string, unknown>): RequestUsage | null {
  const details = (usage.prompt_tokens_details as Record<string, unknown> | undefined) ?? {}
  const counted = countedUsage({ input_tokens: usage.prompt_tokens, cache_read_tokens: details.cached_tokens, output_tokens: usage.completion_tokens })
  const reasoning = (usage.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens
  return counted && typeof reasoning === 'number' && Number.isSafeInteger(reasoning) && reasoning >= 0 && reasoning <= counted.output_tokens
    ? { ...counted, details: { reasoning_tokens: reasoning } } : counted
}
