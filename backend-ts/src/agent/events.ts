/** The agent loop's events -> the wire vocabulary. Tool internals emit their own tool_result; here only text,
 *  thinking and tool-call starts are surfaced. */

import { EVENT_VERSION, TOOL_CALL_METADATA_KEYS } from '@oasis-code/contract'
import type { AgentEvent } from './loop.ts'
import { answerText, isBuiltinCall, isBuiltinReturn, isText, isThinking, isToolCall, type BuiltinToolCallPart, type BuiltinToolReturnPart } from '../llm/messages.ts'

export { EVENT_VERSION }
export const MAX_ARGS_PREVIEW = 240

function toolCallMetadata(toolName: string, args: unknown): Record<string, unknown> {
  let parsed = args
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { return {} }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const keys = TOOL_CALL_METADATA_KEYS[toolName] ?? []
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const value = (parsed as Record<string, unknown>)[key]
    if ((typeof value === 'string' && value !== '') || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = typeof value === 'string' ? value.slice(0, 300) : value
    } else if (Array.isArray(value)) {
      out[key] = value.map((v) => String(v).slice(0, 120)).slice(0, 8)
    }
  }
  return out
}

export function mapStreamEvent(event: AgentEvent): [string, Record<string, unknown>] | null {
  if (event.type === 'part_start' && isText(event.part)) return ['text_delta', { text: event.part.content, start: true }]
  if (event.type === 'part_delta' && event.delta.part_kind === 'text') return ['text_delta', { text: event.delta.content_delta }]
  if (event.type === 'part_start' && isThinking(event.part)) return ['thinking_delta', { text: event.part.content || '', start: true }]
  if (event.type === 'part_delta' && event.delta.part_kind === 'thinking') {
    const delta = event.delta.content_delta
    return delta ? ['thinking_delta', { text: delta }] : null
  }
  if (event.type === 'part_end' && isText(event.part)) return ['text_block', { text: event.part.content }]
  if (event.type === 'part_end' && isThinking(event.part)) return ['thinking_block', { text: event.part.content || '' }]
  if (event.type === 'tool_call') {
    const part = event.part
    const rawArgs = part.args
    let preview = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? null)
    if (preview.length > MAX_ARGS_PREVIEW) preview = preview.slice(0, MAX_ARGS_PREVIEW) + '…'
    const payload: Record<string, unknown> = { tool: part.tool_name, tool_call_id: part.tool_call_id, summary: preview }
    Object.assign(payload, toolCallMetadata(part.tool_name, rawArgs))
    return ['tool_call', payload]
  }
  if (event.type === 'continued') {
    return ['run_continued', { reason: event.reason, attempt: event.attempt, of: event.of, kept_chars: event.kept_chars, finish_reason: event.finish_reason }]
  }
  if (event.type === 'tool_cancelled') {
    const part = event.part
    return ['tool_result', { tool: part.tool_name, tool_call_id: part.tool_call_id, status: 'cancelled', reason: event.reason, summary: event.reason.slice(0, 200) }]
  }
  return null
}


/** How often a tool call whose arguments still stream says how far it got: every this many characters more, or after
 *  this long with any more. A call that streams in less never says it. */
const PROGRESS_CHARS = 4096
const PROGRESS_MS = 1000
interface FormingCall { tool: string; id: string; args: string; shown: number; at: number }

/** What the call works on, once its arguments name it: the first of path, title or url whose string has closed. */
export function formingTarget(args: string): Record<string, string> {
  const head = args.slice(0, 4096)
  for (const key of ['path', 'title', 'url']) {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(head)
    if (!m) continue
    try { return { [key]: (JSON.parse(`"${m[1]}"`) as string).slice(0, 200) } } catch { return {} }
  }
  return {}
}

/** A run's events as the wire says them, over a whole segment: `mapStreamEvent` for each, except that the words of a
 *  response come as one answer however many text parts carry them (a provider that cites splits a sentence at each
 *  citation) — the parts that follow each other stream into one row and close as one `text_block`, the pages each
 *  cites as links after it — and that the provider's own tool calls (its web search) read as tool rows: its call as a
 *  `tool_call`, its results as a `tool_result` naming what it found. */
export class RunEventMapper {
  /** the words of the text parts ended so far in the run of parts that follow each other, links and all */
  private words: string | null = null
  /** the tool calls whose arguments are still streaming, by their part's index in the response */
  private forming = new Map<number, FormingCall>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) { this.now = now }

  map(event: AgentEvent): [string, Record<string, unknown>][] {
    const out: [string, Record<string, unknown>][] = []
    const textEvent = (event.type === 'part_start' || event.type === 'part_end') ? isText(event.part) : event.type === 'part_delta' && (event.delta.part_kind === 'text' || event.delta.part_kind === 'citation')
    if (!textEvent) out.push(...this.flush())
    if (event.type === 'part_start' && isToolCall(event.part)) {
      const args = typeof event.part.args === 'string' ? event.part.args : ''
      this.forming.set(event.index, { tool: event.part.tool_name, id: event.part.tool_call_id, args, shown: 0, at: this.now() })
      return out
    }
    if (event.type === 'part_delta' && event.delta.part_kind === 'tool-call') {
      const call = this.forming.get(event.index)
      if (call && event.delta.args_delta) {
        call.args += event.delta.args_delta
        const now = this.now()
        if (call.args.length - call.shown >= PROGRESS_CHARS || (now - call.at >= PROGRESS_MS && call.args.length > call.shown)) {
          call.shown = call.args.length
          call.at = now
          out.push(['tool_call_progress', { tool: call.tool, tool_call_id: call.id, chars: call.args.length, ...formingTarget(call.args) }])
        }
      }
      return out
    }
    if (event.type === 'part_end' && isToolCall(event.part)) { this.forming.delete(event.index); return out }
    if (event.type === 'part_start' && isText(event.part)) {
      // a text part that follows another goes on in the same row
      out.push(['text_delta', this.words === null ? { text: event.part.content, start: true } : { text: event.part.content }])
      this.words ??= ''
      return out
    }
    if (event.type === 'part_delta' && event.delta.part_kind === 'citation') return out
    if (event.type === 'part_end' && isText(event.part)) {
      this.words = (this.words ?? '') + answerText([event.part])
      return out
    }
    if (event.type === 'part_end' && isBuiltinCall(event.part)) { out.push(['tool_call', builtinCall(event.part)]); return out }
    if (event.type === 'part_end' && isBuiltinReturn(event.part)) { out.push(['tool_result', builtinReturn(event.part)]); return out }
    if ((event.type === 'part_start' || event.type === 'part_delta') && !textEvent && (event.type === 'part_start' ? event.part.part_kind.startsWith('builtin-') : event.delta.part_kind === 'builtin-tool-call')) return out
    const mapped = mapStreamEvent(event)
    if (mapped) out.push(mapped)
    return out
  }

  /** The words of the text parts so far as one block (the run of them ended). */
  flush(): [string, Record<string, unknown>][] {
    if (this.words === null) return []
    const text = this.words
    this.words = null
    return [['text_block', { text }]]
  }
}

function builtinCall(part: BuiltinToolCallPart): Record<string, unknown> {
  const args = part.args && typeof part.args === 'object' ? part.args : {}
  const preview = JSON.stringify(args)
  return { tool: part.tool_name, tool_call_id: part.tool_call_id, summary: preview.length > MAX_ARGS_PREVIEW ? `${preview.slice(0, MAX_ARGS_PREVIEW)}…` : preview,
    provider: part.provider_name ?? null, ...toolCallMetadata(part.tool_name, args) }
}

/** What a provider's search tool returned, as its row reads it: a search's results, an action that is not a search
 *  (a page opened, a pattern found in one) as that action without a count, a failure as its status. */
export function builtinResult(part: BuiltinToolReturnPart): Record<string, unknown> {
  const content = part.content && typeof part.content === 'object' ? (part.content as Record<string, unknown>) : {}
  const engine = part.provider_name ?? 'provider'
  if (content.status === 'error') return { status: 'error', engine, summary: `the provider's search failed: ${String(content.error_code ?? 'unknown')}` }
  if (typeof content.action === 'string') return { status: 'ok', engine, action: content.action, summary: content.action }
  const results = Array.isArray(content.results) ? (content.results as Record<string, unknown>[]) : []
  return { status: 'ok', engine, results: results.length, urls: results.map((r) => String(r.url)).slice(0, 20), summary: `${results.length} result(s)` }
}

function builtinReturn(part: BuiltinToolReturnPart): Record<string, unknown> {
  return { tool: part.tool_name, tool_call_id: part.tool_call_id, provider: part.provider_name ?? null, ...builtinResult(part) }
}
