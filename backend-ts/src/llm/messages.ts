/** The harness's own message model: a request / response split whose parts are the contract's (HISTORY_FORMAT).
 *  Constructors stamp what a provider does not (timestamps, ids); `dump` / `load` are the persisted form; every
 *  transform in history.ts and handoff.ts builds new objects and leaves its input untouched, so a message that
 *  did not change is the same object — and the same bytes on the next request. The record is only appended to:
 *  the loop adds responses and requests at its end, a compaction adds one request at its end, and the loading of
 *  a run adds at most one request (the answers of calls a stopped run left dangling). */

import {
  ForeignPartSchema, ModelMessagesSchema, ModelRequestSchema, ModelResponseSchema, z, type BuiltinToolCallPart, type BuiltinToolReturnPart, type ForeignPart, type ModelMessage, type ModelRequest, type ModelResponse, type RequestPart, type RequestUsage,
  type ResponsePart, type RetryPromptPart, type SystemPromptPart, type TextPart, type ThinkingPart, type ToolCallPart, type ToolReturnPart,
  type UserContent, type UserPromptPart,
} from '@oasis-code/contract'
import { nowIso } from '../timebase.ts'

export type {
  BuiltinToolCallPart, BuiltinToolReturnPart, ForeignPart, ModelMessage, ModelRequest, ModelResponse, RequestPart, RequestUsage, ResponsePart, RetryPromptPart, SystemPromptPart,
  TextPart, ThinkingPart, ToolCallPart, ToolReturnPart, UserContent, UserPromptPart,
}

// ---- constructors ----------------------------------------------------------------------------------------------

/** Who wrote a user part: the person (with the app's pieces of a list named), or the app. */
export type PromptOrigin = { origin: 'person'; app_pieces?: number[] } | { origin: 'app' }
export const APP_ORIGIN: PromptOrigin = { origin: 'app' }

export function userPrompt(content: UserContent, origin?: PromptOrigin): UserPromptPart {
  return { part_kind: 'user-prompt', content, timestamp: nowIso(), ...(origin ?? {}) }
}

export function systemPrompt(content: string): SystemPromptPart {
  return { part_kind: 'system-prompt', content, timestamp: nowIso() }
}

export function toolReturn(toolName: string, content: unknown, toolCallId: string, metadata?: Record<string, unknown> | null): ToolReturnPart {
  const part: ToolReturnPart = { part_kind: 'tool-return', tool_name: toolName, content, tool_call_id: toolCallId, timestamp: nowIso() }
  if (metadata !== undefined) part.metadata = metadata
  return part
}

export function retryPrompt(content: string | Record<string, unknown>[], toolName: string | null, toolCallId: string): RetryPromptPart {
  return { part_kind: 'retry-prompt', content, tool_name: toolName, tool_call_id: toolCallId, timestamp: nowIso() }
}

export function textPart(content: string, extra: Partial<TextPart> = {}): TextPart {
  return { part_kind: 'text', content, ...extra }
}

export function thinkingPart(content: string, extra: Partial<ThinkingPart> = {}): ThinkingPart {
  return { part_kind: 'thinking', content, ...extra }
}

export function toolCallPart(toolName: string, args: string | Record<string, unknown> | null, toolCallId: string, extra: Partial<ToolCallPart> = {}): ToolCallPart {
  return { part_kind: 'tool-call', tool_name: toolName, args, tool_call_id: toolCallId, ...extra }
}

export function modelRequest(parts: RequestPart[], instructions?: string | null): ModelRequest {
  const message: ModelRequest = { kind: 'request', parts }
  if (instructions !== undefined) message.instructions = instructions
  return message
}

export function emptyUsage(): RequestUsage {
  return { input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0 }
}

export function modelResponse(parts: ResponsePart[], extra: Partial<ModelResponse> = {}): ModelResponse {
  return {
    kind: 'response', parts, usage: extra.usage ?? emptyUsage(), model_name: extra.model_name ?? null, timestamp: extra.timestamp ?? nowIso(),
    provider_name: extra.provider_name ?? null, provider_details: extra.provider_details ?? null,
    provider_response_id: extra.provider_response_id ?? null, ...(extra.finish_reason !== undefined ? { finish_reason: extra.finish_reason } : {}),
  }
}

// ---- guards ---------------------------------------------------------------------------------------------------

export const isRequest = (m: ModelMessage): m is ModelRequest => m.kind === 'request'
export const isResponse = (m: ModelMessage): m is ModelResponse => m.kind === 'response'
export const isUserPrompt = (p: RequestPart): p is UserPromptPart => p.part_kind === 'user-prompt'
export const isSystemPromptPart = (p: RequestPart): p is SystemPromptPart => p.part_kind === 'system-prompt'
export const isToolReturn = (p: RequestPart): p is ToolReturnPart => p.part_kind === 'tool-return'
export const isRetryPrompt = (p: RequestPart): p is RetryPromptPart => p.part_kind === 'retry-prompt'
export const isText = (p: ResponsePart): p is TextPart => p.part_kind === 'text'
export const isThinking = (p: ResponsePart): p is ThinkingPart => p.part_kind === 'thinking'
export const isToolCall = (p: ResponsePart): p is ToolCallPart => p.part_kind === 'tool-call'
export const isBuiltinCall = (p: ResponsePart): p is BuiltinToolCallPart => p.part_kind === 'builtin-tool-call'
export const isBuiltinReturn = (p: ResponsePart): p is BuiltinToolReturnPart => p.part_kind === 'builtin-tool-return'

/** A place a text part cites (a provider's web search result the words stand on): its address and title. */
export interface CitedPage { url: string; title: string }

/** The pages a text part cites, each once, in order (the provider's citations as it sent them, kept on the part). */
export function citedPages(part: TextPart): CitedPage[] {
  const raw = (part.provider_details as { citations?: unknown } | null | undefined)?.citations
  const out: CitedPage[] = []
  for (const c of Array.isArray(raw) ? raw : []) {
    const url = c && typeof c === 'object' ? (c as Record<string, unknown>).url : null
    if (typeof url !== 'string' || !/^https?:\/\//.test(url) || out.some((p) => p.url === url)) continue
    const title = (c as Record<string, unknown>).title
    out.push({ url, title: typeof title === 'string' && title.trim() ? title.trim() : new URL(url).hostname })
  }
  return out
}

/** A response's words as the person and the next reader take them: its text parts in order (a provider that cites
 *  splits one answer into several), each followed by the pages it cites as markdown links —
 *  ` ([title](url), …)`. The record keeps the parts as they came; this is only how they read. */
export function answerText(parts: ResponsePart[]): string {
  return parts.filter(isText).map((p) => {
    const pages = citedPages(p)
    return pages.length ? `${p.content} (${pages.map((c) => `[${c.title.replace(/\s+/g, ' ').replace(/[[\]]/g, '\\$&')}](${c.url})`).join(', ')})` : p.content
  }).join('')
}

/** A user part's text (the string pieces of a list content joined). */
export function userText(part: UserPromptPart): string {
  const content = part.content
  if (typeof content === 'string') return content
  return content.filter((c): c is string => typeof c === 'string').join(' ')
}

/** A retry prompt as the model reads it (pydantic-ai's wording for a structured validation error). */
export function retryText(part: RetryPromptPart): string {
  if (typeof part.content === 'string') return part.content
  return JSON.stringify(part.content)
}

/** The tool call's args as an object (a JSON string parsed; anything else an empty object). */
export function argsDict(args: unknown): Record<string, unknown> {
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return {} }
  }
  return args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
}

/** Why a call's arguments are not an object the tool can take, or null when they are (absent arguments are {}): the
 *  JSON parser's own message for text that does not parse, or what the text parsed to. */
export function argsProblem(args: unknown): string | null {
  if (args === null || args === undefined) return null
  let value = args
  if (typeof args === 'string') {
    if (!args.trim()) return null
    try { value = JSON.parse(args) } catch (error) {
      const shown = args.length > 200 ? `${args.slice(0, 200)}… (${args.length} characters)` : args
      return `the arguments are not valid JSON (${(error as Error).message}); received: ${shown}`
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return `the arguments must be a JSON object; received ${Array.isArray(value) ? 'an array' : value === null ? 'null' : typeof value}`
  return null
}

export function argsText(args: unknown): string {
  return typeof args === 'string' ? args : JSON.stringify(args ?? {})
}

// ---- the persisted form -------------------------------------------------------------------------------------

/** The messages as one JSON text (the record's bytes; a prefix of a later dump, the record being appended to only). */
export function dumpJson(messages: ModelMessage[]): string {
  return JSON.stringify(messages)
}

/** The JSON of one message, for a prefix comparison. */
export function dumpOne(message: ModelMessage): string {
  return JSON.stringify(message)
}

/** The messages of a stored record: checked against the schema, returned as parsed — the same keys in the same
 *  order, so a record loaded and dumped again is the same bytes (the schema's own output would reorder keys). */
export function loadJson(text: string): ModelMessage[] {
  return loadValue(JSON.parse(text))
}

export function loadValue(value: unknown): ModelMessage[] {
  ModelMessagesSchema.parse(value)
  return value as ModelMessage[]
}

/** ModelMessagesSchema for its verdict alone. A response part is checked against a union whose last member,
 *  ForeignPartSchema, is any object with a string part_kind; every other member is a loose object whose part_kind is
 *  a string literal, so a part one of them accepts ForeignPartSchema accepts too, and the union accepts exactly what
 *  ForeignPartSchema does — without trying the members before it (and building their issues) on every part. Every
 *  other schema is the contract's own. */
const ModelMessagesVerdictSchema = z.array(z.discriminatedUnion('kind', [
  ModelRequestSchema, ModelResponseSchema.extend({ parts: z.array(ForeignPartSchema) }),
]))

/** Whether loadValue accepts the value (it throws exactly when this is false); no issue list is kept. */
export function isModelMessages(value: unknown): value is ModelMessage[] {
  return ModelMessagesVerdictSchema.safeParse(value).success
}

/** The newest tool return of `toolName` in a history (what a scripted model reads the way a real one would). */
export function lastToolReturn(messages: ModelMessage[], toolName: string): unknown {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!
    if (!isRequest(m)) continue
    for (const p of m.parts) if (isToolReturn(p) && p.tool_name === toolName) return p.content
  }
  return null
}

export function toolReturns(messages: ModelMessage[]): ToolReturnPart[] {
  const out: ToolReturnPart[] = []
  for (const m of messages) if (isRequest(m)) for (const p of m.parts) if (isToolReturn(p)) out.push(p)
  return out
}

export function userTexts(messages: ModelMessage[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (!isRequest(m)) continue
    for (const p of m.parts) {
      if (!isUserPrompt(p)) continue
      if (typeof p.content === 'string') out.push(p.content)
      else { const strings = p.content.filter((c): c is string => typeof c === 'string'); if (strings.length) out.push(strings.join('\n')) }
    }
  }
  return out
}
