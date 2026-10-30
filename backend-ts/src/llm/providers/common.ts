import { isAnyFilePiece } from '../attachments.ts'
/** What the four mappings share: the thinking levels, the text of a request part as the provider reads it, and a
 *  streamed response built part by part while the events go out. */

import { emptyUsage, modelResponse, type ModelResponse, type RequestUsage, type ResponsePart, type RetryPromptPart, type ToolReturnPart, type UserPromptPart } from '../messages.ts'
import type { StreamEvent, StreamedResponse, ThinkingSetting } from '../model.ts'
import { isImagePiece, returnHasImage } from '../images.ts'
import { text as promptText } from '../../prompt_texts.ts'
import { EFFORT_SCALE, type Effort } from '../../config.ts'

export const THINKING_BUDGETS: Record<string, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 65536 }
export const REASONING_EFFORTS: Record<string, string> = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }

/** A route's API key: the value itself, or a reader asked at each request — so a key saved, replaced or forgotten
 *  on the Accounts page counts from the next request on, in a run already going too (the reader throws when the key
 *  is gone, and nothing is sent). */
export type ApiKey = string | null | (() => string)

export function currentKey(key: ApiKey | undefined): string | null {
  return typeof key === 'function' ? key() : (key ?? null)
}

/** A route as its responses carry it: the provider, the endpoint the requests go to, the model asked for. */
export function routeKey(system: string, url: string, model: string): string {
  return `${system} ${url} ${model}`
}

export function thinkingLevel(thinking: ThinkingSetting): string | null {
  return typeof thinking === 'string' && thinking in THINKING_BUDGETS ? thinking : null
}

/** The effort a unified level is sent as ('off' is `none`). */
function effortOf(level: string): Effort | null {
  if (level === 'off') return 'none'
  const effort = REASONING_EFFORTS[level]
  return effort !== undefined && (EFFORT_SCALE as readonly string[]).includes(effort) ? effort as Effort : null
}

/** The level a route is sent for the level asked (null: the provider's default, left alone). A route whose efforts
 *  are known and lack the level is sent the nearest level it takes (the higher of two as near); a route whose efforts
 *  are not known is sent the level as asked. 'minimal' is raised to 'low' where the request may carry the provider's
 *  web search: OpenAI refuses the two together, and the least effort beside the search keeps the search the run's
 *  grants allow (dropping it would swap in the harness's own search mid-conversation). */
export function routeThinking(level: string | null, efforts: readonly Effort[] | null, providerSearch: boolean): string | null {
  if (level === null) return null
  const asked = effortOf(level)
  if (asked === null) return level
  const levels = ['off', ...Object.keys(REASONING_EFFORTS)]
  const taken = levels.filter((l) => {
    const effort = effortOf(l)
    return effort !== null && (efforts === null || efforts.includes(effort)) && !(providerSearch && effort === 'minimal')
  })
  if (taken.includes(level)) return level
  // a route that takes none of the unified levels is sent the level as asked: the provider's refusal says why
  if (!taken.length) return level
  const rank = (l: string) => EFFORT_SCALE.indexOf(effortOf(l)!)
  const at = EFFORT_SCALE.indexOf(asked)
  return taken.reduce((best, l) => (Math.abs(rank(l) - at) <= Math.abs(rank(best) - at) ? l : best))
}

/** A user part's text as one string (structured pieces as their JSON). */
export function userPartText(part: UserPromptPart): string {
  if (typeof part.content === 'string') return part.content
  return part.content.map((c) => (typeof c === 'string' ? c : JSON.stringify(c))).join('\n')
}

/** A user part as the blocks a provider carries: its text as one block, as before, when it holds no image; else the
 *  runs of text between the images, each image with its bytes (an image without them — the hydration's job at the
 *  provider boundary — is a line of text, never a request that fails on a missing field). */
export type UserBlock = { type: 'text'; text: string } | { type: 'image'; media_type: string; data: string } | { type: 'file'; media_type: string; data: string; name: string }
export function userBlocks(part: UserPromptPart): UserBlock[] {
  if (typeof part.content === 'string' || !part.content.some((p) => isImagePiece(p) || isAnyFilePiece(p))) return [{ type: 'text', text: userPartText(part) }]
  const blocks: UserBlock[] = []
  let text: string[] = []
  const flush = () => { if (text.length) blocks.push({ type: 'text', text: text.join('\n') }); text = [] }
  for (const piece of part.content) {
    if (isAnyFilePiece(piece)) {
      if (typeof piece.data !== 'string') throw new Error(`file not hydrated: ${piece.name}`)
      if (piece.representation === 'utf8-v1') text.push(piece.data)
      else { flush(); blocks.push({ type: 'file', media_type: piece.media_type, data: piece.data, name: piece.name }) }
    }
    else if (isImagePiece(piece) && typeof piece.data === 'string') { flush(); blocks.push({ type: 'image', media_type: piece.media_type, data: piece.data }) }
    else if (isImagePiece(piece)) throw new Error(`image not hydrated: ${piece.name}`)
    else text.push(typeof piece === 'string' ? piece : JSON.stringify(piece))
  }
  flush()
  return blocks
}

/** A tool return's content as the text the provider carries (a string as is, anything else as JSON). */
export function toolReturnText(part: ToolReturnPart): string {
  if (part.content && typeof part.content === 'object' && Object.values(part.content).some(isAnyFilePiece)) throw new Error('file tool results are not supported; use composer attachments')
  return typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? null)
}

/** An image a tool returned, with its bytes (the hydration's work), as a provider places it. */
export interface ReturnedImage { media_type: string; data: string; name: string }

/** A tool return as the provider carries it: its content with each image reference kept but its bytes taken out
 *  (`content`, and the same as text), and the images that carry bytes (`images`) for the provider to place — inside
 *  the result where the API takes images there, in a user message right after it where it does not. */
export function toolReturnParts(part: ToolReturnPart): { content: unknown; text: string; images: ReturnedImage[] } {
  if (part.content && typeof part.content === 'object' && Object.values(part.content).some(isAnyFilePiece)) throw new Error('file tool results are not supported; use composer attachments')
  if (!returnHasImage(part.content)) return { content: part.content, text: toolReturnText(part), images: [] }
  const images: ReturnedImage[] = []
  const content = Object.fromEntries(Object.entries(part.content).map(([k, v]) => {
    if (!isImagePiece(v) || typeof v.data !== 'string') return [k, v]
    images.push({ media_type: v.media_type, data: v.data, name: v.name })
    const reference: Record<string, unknown> = { ...v }
    delete reference.data
    return [k, reference]
  }))
  return { content, text: JSON.stringify(content), images }
}

/** The line that introduces images a tool returned when they travel in a user message after the result. */
export function returnedImagesNote(part: ToolReturnPart): string {
  const path = returnHasImage(part.content) && typeof part.content.path === 'string' ? ` (${part.content.path})` : ''
  return promptText('image.tool_origin', { id: part.tool_call_id, path_label: path })
}

export function retryPromptText(part: RetryPromptPart): string {
  if (typeof part.content === 'string') {
    return part.tool_name ? `${part.content}\n\nFix the errors and try again.` : part.content
  }
  return `${JSON.stringify(part.content, null, 2)}\n\nFix the errors and try again.`
}

const USAGE_COUNTS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'] as const

/** A usage with every figure present. */
export type CountedUsage = RequestUsage & Record<(typeof USAGE_COUNTS)[number], number>

/** A provider's count as the records take it: each figure a whole number of tokens, zero or more (a figure the usage
 *  leaves out is 0). A usage the provider did not send is unknown (null), and so is one with a figure that is no count
 *  — negative, not a number, endless — never a 0 or a negative a cost or a context prediction would be made from. */
export function countedUsage(raw: Partial<Record<(typeof USAGE_COUNTS)[number], unknown>> | null | undefined): CountedUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const out: CountedUsage = { ...emptyUsage(), input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }
  for (const key of USAGE_COUNTS) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
    if (!Number.isFinite(n) || n < 0) return null
    out[key] = Math.trunc(n)
  }
  return out
}

/** A part under construction: the provider's stream fills it, `finish` seals the ModelResponse. */
export class ResponseBuilder {
  readonly parts: ResponsePart[] = []
  /** the provider's count once it reports one (null until then: a response the provider did not count has no usage) */
  usage: RequestUsage | null = null
  model_name: string | null = null
  provider_response_id: string | null = null
  finish_reason: string | null = null
  /** what a provider adds to the response's own provider_details beside its route (Argon: its long decode's counts) */
  provider_extra: Record<string, unknown> | null = null
  private readonly argBuffers = new Map<number, string>()

  constructor(readonly provider_name: string, readonly fallbackModel: string, readonly route: string | null = null) {}

  /** Start a part; the event says what the model started saying. */
  start(index: number, part: ResponsePart): StreamEvent {
    this.parts[index] = part
    return { type: 'part_start', index, part }
  }

  textDelta(index: number, delta: string): StreamEvent {
    const part = this.parts[index]
    if (part && part.part_kind === 'text') this.parts[index] = { ...part, content: part.content + delta }
    return { type: 'part_delta', index, delta: { part_kind: 'text', content_delta: delta } }
  }

  thinkingDelta(index: number, delta: { content?: string; signature?: string }): StreamEvent {
    const part = this.parts[index]
    if (part && part.part_kind === 'thinking') {
      this.parts[index] = {
        ...part, content: part.content + (delta.content ?? ''),
        signature: delta.signature !== undefined ? (part.signature ?? '') + delta.signature : part.signature,
      }
    }
    return { type: 'part_delta', index, delta: { part_kind: 'thinking', content_delta: delta.content, signature_delta: delta.signature } }
  }

  argsDelta(index: number, delta: string): StreamEvent {
    this.argBuffers.set(index, (this.argBuffers.get(index) ?? '') + delta)
    return { type: 'part_delta', index, delta: { part_kind: this.parts[index]?.part_kind === 'builtin-tool-call' ? 'builtin-tool-call' : 'tool-call', args_delta: delta } }
  }

  /** A citation of a text part (a page the words stand on), kept on the part as the provider sent it. */
  citation(index: number, citation: Record<string, unknown>): StreamEvent {
    const part = this.parts[index]
    if (part && part.part_kind === 'text') {
      const details = (part.provider_details ?? {}) as Record<string, unknown>
      const citations = Array.isArray(details.citations) ? details.citations : []
      this.parts[index] = { ...part, provider_details: { ...details, citations: [...citations, citation] } }
    }
    return { type: 'part_delta', index, delta: { part_kind: 'citation', citation } }
  }

  /** Seal a part: a call's args (the harness's tools and the provider's own) parsed from their buffer (kept as text
   *  when they do not parse). */
  end(index: number, patch: Partial<ResponsePart> = {}): StreamEvent {
    let part = this.parts[index]!
    if (part.part_kind === 'tool-call' || part.part_kind === 'builtin-tool-call') {
      const text = this.argBuffers.get(index) ?? (typeof part.args === 'string' ? part.args : null)
      if (text !== null) {
        let args: string | Record<string, unknown> | null = text
        try {
          const parsed = JSON.parse(text || '{}')
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
        } catch { /* keep the text */ }
        part = { ...part, args }
      }
    }
    part = { ...part, ...patch } as ResponsePart
    this.parts[index] = part
    return { type: 'part_end', index, part }
  }

  get(index: number): ResponsePart | undefined { return this.parts[index] }

  /** Whether any args text arrived for this tool-call part through deltas. */
  argsBuffered(index: number): boolean { return (this.argBuffers.get(index) ?? '').length > 0 }

  response(): ModelResponse {
    const response = modelResponse(this.parts.filter(Boolean), {
      model_name: this.model_name ?? this.fallbackModel, provider_name: this.provider_name,
      provider_response_id: this.provider_response_id, finish_reason: this.finish_reason, provider_details: this.route !== null || this.provider_extra !== null ? { ...(this.route !== null ? { route: this.route } : {}), ...(this.provider_extra ?? {}) } : null,
    })
    if (this.usage === null) delete response.usage
    else response.usage = this.usage
    return response
  }
}

/** A streamed response over a generator of events and a builder that has the whole answer when they end. */
export function streamedResponse(builder: ResponseBuilder, events: () => AsyncGenerator<StreamEvent, void, undefined>): StreamedResponse {
  let response: ModelResponse | null = null
  return {
    events,
    get: () => (response ??= builder.response()),
    usage: () => builder.usage,
    get model_name() { return builder.model_name ?? builder.fallbackModel },
  }
}

/** New binary user blocks only; tool protocols are intentionally not inferred from this function. A QuickTime video
 *  goes to Gemini as `video/mov` (the video page the Gemini 3.6 route was written against) unless the model's own
 *  profile names another wire MIME (Gemini 4 Argon: `video/quicktime`, as the GenerateContent video page lists it). */
export function nativeFileBlock(b: Extract<UserBlock, { type: 'file' }>, protocol: 'anthropic' | 'responses' | 'chat' | 'google', opts: { movWireMime?: string } = {}): Record<string, unknown> {
  if (protocol === 'google') {
    if (!['application/pdf', 'video/mp4', 'video/webm', 'video/quicktime'].includes(b.media_type)) throw new Error(`unsupported Gemini file MIME: ${b.media_type}`)
    return { inlineData: { mimeType: b.media_type === 'video/quicktime' ? (opts.movWireMime ?? 'video/mov') : b.media_type, data: b.data } }
  }
  if (b.media_type !== 'application/pdf') throw new Error(`${protocol} does not support native ${b.media_type}; video is not converted to images`)
  if (protocol === 'anthropic') return { type: 'document', source: { type: 'base64', media_type: b.media_type, data: b.data } }
  const file = { filename: b.name, file_data: `data:${b.media_type};base64,${b.data}` }
  return protocol === 'responses' ? { type: 'input_file', ...file } : { type: 'file', file }
}
