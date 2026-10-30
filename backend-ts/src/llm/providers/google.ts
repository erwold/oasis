/** The Gemini API (generateContent) over fetch: contents with user / model roles, functionCall / functionResponse
 *  parts (the harness gives each call an id when the provider sends none), a thought signature sent back on the
 *  call that carried it, tools as functionDeclarations, the key in the x-goog-api-key header and never in the URL,
 *  streamGenerateContent as SSE.
 *
 *  Gemini 4 Argon (`gemini-4-argon`, exactly) is mapped by its own documented profile (docs/gemini-4-argon.md,
 *  official pages checked 2026-10-14, not probed online): thinkingLevel low / medium / high instead of a budget,
 *  no sampling fields, the streaming per-request output cap, 20-minute timeouts, every thought signature returned on
 *  the part boundary it arrived on, and the provider's own functionCall ids paired with their functionResponse.
 *  Every other model id keeps the mapping it had. */

import { newId } from '../../ids.ts'
import { cleanSchema, postJson, readSse, sleep, type HttpOptions } from '../http.ts'
import {
  argsDict, isRequest, isResponse, isRetryPrompt, isSystemPromptPart, isText, isThinking, isToolCall, isToolReturn, isUserPrompt,
  type ModelMessage, type ModelResponse, type RequestUsage, type ResponsePart,
} from '../messages.ts'
import { LongDecodeInterrupted, PROVIDER_CONTEXT_WORDS, PROVIDER_MODEL_GONE_WORDS, PROVIDER_QUOTA_WORDS, type LongDecodeFailure, ModelAPIError, ModelHTTPError, TransportError, type Model, type ModelProfile, type ModelRequestParameters, type ModelSettings, type RequestContext, type StreamEvent, type StreamedResponse, type ThinkingSetting } from '../model.ts'
import { type ApiKey, countedUsage, currentKey, routeKey, ResponseBuilder, retryPromptText, returnedImagesNote, streamedResponse, THINKING_BUDGETS, thinkingLevel, toolReturnParts, userBlocks, nativeFileBlock } from './common.ts'
import { responseRoute } from '../handoff.ts'

export interface GoogleOptions extends HttpOptions {
  apiKey?: ApiKey
  baseUrl?: string
  headers?: Record<string, string>
  profile?: Partial<ModelProfile>
  /** Argon long decode: resumes from a checkpoint per request (default ARGON_MAX_RESUMES), CONTINUATION hops per
   *  request (default ARGON_MAX_HOPS), the waits before each resume (default ARGON_RESUME_BACKOFF_MS) */
  maxResumes?: number
  maxHops?: number
  resumeBackoffMs?: readonly number[]
}

/** Whether the model takes images inside a functionResponse (nested `parts` with inline data): the function-calling
 *  guide documents multimodal function responses for the Gemini 3 series only (checked 2026-10-14) — a later model,
 *  Gemini 4 Argon included, gets the images in a user turn right after the results until Google says otherwise. */
export function takesFunctionResponseImages(model: string): boolean {
  const version = /gemini-(\d+)/.exec(model)
  return version !== null && Number(version[1]) === 3
}

/** The Gemini 4 Argon thinking levels (thinking guide, checked 2026-10-14): `minimal` is refused by the API and
 *  thinking cannot be turned off; `medium` is the model's default. */
export const ARGON_THINKING_LEVELS = ['low', 'medium', 'high'] as const
export type ArgonThinkingLevel = (typeof ARGON_THINKING_LEVELS)[number]
/** One streamGenerateContent request returns at most this many output tokens on Argon (long-decode guide); past it
 *  the API ends the stream with CONTINUATION, a hop this build does not run (the route's max_tokens is held to this cap,
 *  and a next hop with the same total would be a 400: the total must be above the tokens used). Resuming a dropped
 *  stream from its checkpoint (ARGON_MAX_RESUMES) is not a hop: it stays within this one request's total. */
export const ARGON_STREAM_OUTPUT_CAP = 65_536
/** A non-streaming generateContent request's cap on Argon (documented; this adapter never makes one). */
export const ARGON_SYNC_OUTPUT_CAP = 32_768
/** The client timeout the latest-model guide asks for (the server closes a stream after 20 minutes). */
export const ARGON_TIMEOUT_MS = 20 * 60_000
/** Bun's own socket idle deadline on Argon: off (`timeout: false`), so the harness's 20-minute timers above are the
 *  only client deadlines. Not a number: Bun's current reference names milliseconds, but a numeric value was not seen to
 *  take effect on Bun 1.4.0 in a small offline check, while `false` was (a 6 s silence survived
 *  BUN_CONFIG_HTTP_IDLE_TIMEOUT=3 on loopback). It reaches this process's socket only: an idle limit a proxy, a tunnel
 *  or the provider holds is not lengthened by it. */
export const ARGON_SOCKET_IDLE_TIMEOUT = false as const
/** Long decode, streaming (long-decode guide, updated 2026-10-13): past the first 32,768 tokens the stream carries a
 *  `candidates[0].continuationToken` every 5,000 tokens; what came after the last one is pending. A stream that drops
 *  after one is sent again — the same body, plus the latest token — at most this many times per request (a resume
 *  whose own request fails is one of them); the pending part is dropped, never shown, never answered. */
export const ARGON_MAX_RESUMES = 5
/** CONTINUATION hops one request may take (only with a route's explicit max_tokens above one stream's cap). */
export const ARGON_MAX_HOPS = 20
/** The unified input + thinking + output window: the most an explicit max_tokens may name. */
export const ARGON_WINDOW = 1_048_576
/** The waits before each resume (the last one repeats). */
export const ARGON_RESUME_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const

/** What this build knows of a Gemini model id: null for every id but the documented `gemini-4-argon`, whose
 *  requests follow its own rules; any other id keeps the generic mapping it had. */
export interface GeminiProfile {
  model: 'gemini-4-argon'
  thinking_levels: readonly ArgonThinkingLevel[]
  stream_output_cap: number
  timeout_ms: number
  /** the wire MIME of a QuickTime video: the GenerateContent video page lists video/quicktime */
  mov_wire_mime: string
}

export function geminiProfile(model: string): GeminiProfile | null {
  if (model !== 'gemini-4-argon') return null
  return { model, thinking_levels: ARGON_THINKING_LEVELS, stream_output_cap: ARGON_STREAM_OUTPUT_CAP, timeout_ms: ARGON_TIMEOUT_MS, mov_wire_mime: 'video/quicktime' }
}

/** The level an Argon request carries for the unified level asked: a level it takes as is; `minimal`, `off` and
 *  false (it cannot think less than low) as low; `xhigh` and `max` as high; null (or a word no level) as none — the
 *  model's own default, medium. The same nearest-level rule the runner applies to the route's reasoning_efforts, so a
 *  route configured without them still never sends a level the API refuses. */
export function argonThinkingLevel(thinking: ThinkingSetting | undefined): ArgonThinkingLevel | null {
  if (thinking === false || thinking === 'off' || thinking === 'minimal') return 'low'
  if (thinking === 'xhigh' || thinking === 'max') return 'high'
  return typeof thinking === 'string' && (ARGON_THINKING_LEVELS as readonly string[]).includes(thinking) ? thinking as ArgonThinkingLevel : null
}

type GoogleDetails = { thought_signature?: string; call_id?: string } | null | undefined

export class GoogleModel implements Model {
  readonly system = 'google'
  readonly profile: ModelProfile
  readonly baseUrl: string
  /** the documented model's own rules (Argon), or null: the generic mapping */
  readonly gemini: GeminiProfile | null
  /** the HTTP options the requests go out with: the route's, with Argon's 20-minute timeouts where none is named */
  readonly http: GoogleOptions

  constructor(readonly model_name: string, readonly opts: GoogleOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, '')
    this.profile = { supports_thinking: true, ...(opts.profile ?? {}) }
    this.gemini = geminiProfile(model_name)
    if (this.gemini) {
      const timeoutMs = opts.timeoutMs ?? this.gemini.timeout_ms
      const idleTimeoutMs = opts.idleTimeoutMs ?? this.gemini.timeout_ms
      // Bun's socket idle deadline (5 minutes unless BUN_CONFIG_HTTP_IDLE_TIMEOUT says otherwise) would cut a silence
      // the 20-minute timers above allow: it is turned off, so they (and a Stop, through the signal) end the request
      const socketIdleTimeoutMs = opts.socketIdleTimeoutMs ?? ARGON_SOCKET_IDLE_TIMEOUT
      this.http = { ...opts, timeoutMs, idleTimeoutMs, socketIdleTimeoutMs }
    } else this.http = opts
  }

  get route(): string { return routeKey(this.system, this.url(false), this.model_name) }

  url(stream: boolean): string {
    const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent'
    return `${this.baseUrl}/v1beta/models/${this.model_name}:${method}`
  }

  /** [system instruction text, contents] */
  mapMessages(messages: ModelMessage[]): [string | null, Record<string, unknown>[]] {
    const contents: Record<string, unknown>[] = []
    const systemTexts: string[] = []
    let instructions: string | null = null
    const callNames = new Map<string, string>()
    // Argon: the local tool_call_id of each call → the id the provider itself gave it (its recorded call_id). Only a
    // provider id goes back as functionCall.id / functionResponse.id, and it is the provider's even when the local id
    // differs (the loop renames a reused id `<id>_2`, …); a call the provider gave no id goes back without one — an id
    // the harness made up is never sent as the provider's
    const nativeIds = new Map<string, string>()
    const argon = this.gemini !== null
    const nativeId = (toolCallId: string | null | undefined): Record<string, unknown> => {
      const id = argon && toolCallId ? nativeIds.get(toolCallId) : undefined
      return id ? { id } : {}
    }
    for (const message of messages) {
      if (isRequest(message)) {
        if (message.instructions) instructions = message.instructions
        const parts: Record<string, unknown>[] = []
        // a model without images inside a functionResponse: images a tool returned follow as a user turn of their own
        const returnedImages: Record<string, unknown>[] = []
        for (const part of message.parts) {
          if (isSystemPromptPart(part)) systemTexts.push(part.content)
          else if (isUserPrompt(part)) {
            for (const block of userBlocks(part)) parts.push(block.type === 'text' ? { text: block.text } : block.type === 'file' ? nativeFileBlock(block, 'google', this.gemini ? { movWireMime: this.gemini.mov_wire_mime } : undefined) : { inline_data: { mime_type: block.media_type, data: block.data } })
          }
          else if (isToolReturn(part)) {
            const { content, images } = toolReturnParts(part)
            const response = content && typeof content === 'object' && !Array.isArray(content) ? (content as Record<string, unknown>) : { return_value: content ?? null }
            const inline = images.map((i) => ({ inline_data: { mime_type: i.media_type, data: i.data } }))
            if (inline.length && takesFunctionResponseImages(this.model_name)) parts.push({ functionResponse: { name: part.tool_name, response, parts: inline } })
            else {
              parts.push({ functionResponse: { ...nativeId(part.tool_call_id), name: part.tool_name, response } })
              if (inline.length) returnedImages.push({ role: 'user', parts: [{ text: returnedImagesNote(part) }, ...inline] })
            }
          } else if (isRetryPrompt(part)) {
            if (part.tool_call_id) parts.push({ functionResponse: { ...nativeId(part.tool_call_id), name: part.tool_name ?? callNames.get(part.tool_call_id) ?? 'tool', response: { call_error: retryPromptText(part) } } })
            else parts.push({ text: retryPromptText(part) })
          }
        }
        if (parts.length) contents.push({ role: 'user', parts })
        contents.push(...returnedImages)
      } else if (isResponse(message)) {
        const parts = argon ? this.argonModelParts(message, callNames, nativeIds) : this.modelParts(message, callNames)
        if (parts.length) contents.push({ role: 'model', parts })
      }
    }
    const merged: Record<string, unknown>[] = []
    for (const turn of contents) {
      const last = merged[merged.length - 1]
      if (last && last.role === turn.role) last.parts = [...(last.parts as unknown[]), ...(turn.parts as unknown[])]
      else merged.push(turn)
    }
    const texts = [instructions, ...systemTexts].filter((t): t is string => !!t)
    return [texts.length ? texts.join('\n\n') : null, merged]
  }

  /** A model turn as every Gemini model but Argon gets it (unchanged): words, calls with the signature they carried. */
  private modelParts(message: ModelResponse, callNames: Map<string, string>): Record<string, unknown>[] {
    const parts: Record<string, unknown>[] = []
    for (const part of message.parts) {
      if (isText(part)) { if (part.content) parts.push({ text: part.content }) }
      else if (isThinking(part)) continue
      else if (isToolCall(part)) {
        callNames.set(part.tool_call_id, part.tool_name)
        const item: Record<string, unknown> = { functionCall: { name: part.tool_name, args: argsDict(part.args) } }
        const signature = (part.provider_details as GoogleDetails)?.thought_signature
        if (signature && (part.provider_name ?? message.provider_name) === this.system) item.thoughtSignature = signature
        parts.push(item)
      }
    }
    return parts
  }

  /** A model turn as Argon gets it back: every part that carried a thought signature on its own boundary, with that
   *  signature (a text part, an empty text part, a thought summary, a call); the calls with the provider's own ids.
   *  Signatures and ids go back only on this route's own responses — another route's (another Gemini model's
   *  included) arrive here already without them (handoff.ts), and a response stamped with another route is held to
   *  the same here. A response without a route stamp (an older record, or one of an unknown route — a 3.6 one
   *  among them) is not taken for Argon's own: its signatures and ids stay off the wire; every response this
   *  adapter builds carries its route. A call of this route that came without a signature is sent as it came:
   *  nothing is made up. */
  private argonModelParts(message: ModelResponse, callNames: Map<string, string>, nativeIds: Map<string, string>): Record<string, unknown>[] {
    const ownMessage = message.provider_name === this.system && responseRoute(message) === this.route
    const own = (part: ResponsePart) => ownMessage && ((part as { provider_name?: string | null }).provider_name ?? message.provider_name) === this.system
    const parts: Record<string, unknown>[] = []
    for (const part of message.parts) {
      const signature = own(part) ? (part.provider_details as GoogleDetails)?.thought_signature : undefined
      if (isText(part)) {
        if (part.content || signature) parts.push({ text: part.content, ...(signature ? { thoughtSignature: signature } : {}) })
      } else if (isThinking(part)) {
        // a thought summary goes back only when it carried a signature (its position is the signature's context)
        if (signature) parts.push({ text: part.content, thought: true, thoughtSignature: signature })
      } else if (isToolCall(part)) {
        callNames.set(part.tool_call_id, part.tool_name)
        const recorded = own(part) ? (part.provider_details as GoogleDetails)?.call_id : undefined
        const id = typeof recorded === 'string' && recorded !== '' ? recorded : undefined
        if (id) nativeIds.set(part.tool_call_id, id)
        else nativeIds.delete(part.tool_call_id)
        const item: Record<string, unknown> = { functionCall: { ...(id ? { id } : {}), name: part.tool_name, args: argsDict(part.args) } }
        if (signature) item.thoughtSignature = signature
        parts.push(item)
      }
    }
    return parts
  }

  body(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters): Record<string, unknown> {
    const [system, contents] = this.mapMessages(messages)
    const body: Record<string, unknown> = { contents }
    if (system) body.systemInstruction = { parts: [{ text: system }] }
    if (params.function_tools.length) {
      // parametersJsonSchema takes the tools' JSON Schema as it is (a nullable field's `type: [..., "null"]` among it);
      // `parameters` takes only the API's OpenAPI subset and refuses such a schema with a 400
      body.tools = [{ functionDeclarations: params.function_tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: cleanSchema(t.parameters_json_schema) })) }]
    }
    const generation: Record<string, unknown> = {}
    if (this.gemini) {
      // Argon: the output total named on every request — one stream's cap unless the route names its own; a total
      // above the cap is the route's explicit opt-in to long decode (CONTINUATION hops, each with this same total,
      // never raised); no sampling fields (ignored, with a warning) and never a thinking budget (deprecated; beside a
      // level it is a 400): the level, or none for the model's default
      const cap = this.gemini.stream_output_cap
      generation.maxOutputTokens = Math.min(settings.max_tokens && settings.max_tokens > 0 ? settings.max_tokens : cap, ARGON_WINDOW)
      const level = argonThinkingLevel(params.thinking)
      generation.thinkingConfig = { ...(level ? { thinkingLevel: level } : {}), includeThoughts: true }
      body.generationConfig = generation
      return body
    }
    if (settings.max_tokens) generation.maxOutputTokens = settings.max_tokens
    if (settings.temperature !== undefined) generation.temperature = settings.temperature
    const level = thinkingLevel(params.thinking)
    if (level) generation.thinkingConfig = { thinkingBudget: THINKING_BUDGETS[level], includeThoughts: true }
    else if (params.thinking === false) generation.thinkingConfig = { thinkingBudget: 0 }
    if (Object.keys(generation).length) body.generationConfig = generation
    return body
  }

  headers(): Record<string, string> {
    const headers: Record<string, string> = { ...(this.opts.headers ?? {}) }
    const key = currentKey(this.opts.apiKey)
    if (key) headers['x-goog-api-key'] = key
    return headers
  }

  async request(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<ModelResponse> {
    const stream = await this.requestStream(messages, settings, params, ctx)
    for await (const _ of stream.events()) { /* drain */ }
    return stream.get()
  }

  async requestStream(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<StreamedResponse> {
    const body = this.body(messages, settings, params)
    const http: GoogleOptions = { ...this.http, requestProtocol: 'google' }
    const signal = ctx?.signal
    // Argon's later requests of one answer (a resume from a checkpoint, a CONTINUATION hop): the same body — contents,
    // tools, config, signatures, the same maxOutputTokens — plus only the latest token. Each is tried once: the resume
    // budget is their only retry count (postJson's own retries would multiply it, each a paid request)
    const send = (token: string | null): Promise<Response> =>
      postJson(this.url(true), token === null ? body : { ...body, continuationToken: token }, this.headers(), this.model_name, token === null ? http : { ...http, maxRetries: 0 }, signal)
    const first = await send(null)
    const builder = new ResponseBuilder(this.system, this.model_name, this.route)
    const modelName = this.model_name
    const idleMs = this.http.idleTimeoutMs
    const argon = this.gemini !== null
    const maxResumes = this.opts.maxResumes ?? ARGON_MAX_RESUMES
    const maxHops = this.opts.maxHops ?? ARGON_MAX_HOPS
    const backoff = this.opts.resumeBackoffMs?.length ? this.opts.resumeBackoffMs : ARGON_RESUME_BACKOFF_MS
    // a CONTINUATION hop is taken only with a total above one stream's cap (the route's explicit opt-in): below it the
    // API ends at MAX_TOKENS, and a hop with a total not above the tokens used is a 400
    const hopsAllowed = argon && Number(gen(body).maxOutputTokens) > ARGON_STREAM_OUTPUT_CAP
    const events = async function* (): AsyncGenerator<StreamEvent, void, undefined> {
      let next = 0
      let textIndex: number | null = null
      let thoughtIndex: number | null = null
      let sawChunk = false
      const closeText = function* (): Generator<StreamEvent> {
        if (textIndex !== null) { yield builder.end(textIndex); textIndex = null }
        if (thoughtIndex !== null) { yield builder.end(thoughtIndex); thoughtIndex = null }
      }
      /** One chunk into the response, as events. `calls` false: a functionCall in it is left out (the pending part of
       *  a long decode that ended filtered or failed is never a call to run). */
      const apply = function* (data: Record<string, unknown>, calls = true): Generator<StreamEvent> {
        if (data.modelVersion) builder.model_name = data.modelVersion as string
        // a long decode's later streams answer under their own ids: the response keeps the first
        if (data.responseId && !(argon && builder.provider_response_id)) builder.provider_response_id = data.responseId as string
        const candidate = firstCandidate(data)
        if (!candidate) {
          // the prompt itself was blocked: no candidate, the reason in promptFeedback — a filter's answer (taken as it
          // is, never retried as a cut stream); BLOCK_REASON_UNSPECIFIED is no block named
          if (blockedPrompt(data)) builder.finish_reason = 'content_filter'
          return
        }
        const content = candidate.content as { parts?: Record<string, unknown>[] } | undefined
        for (const part of content?.parts ?? []) {
          const signature = typeof part.thoughtSignature === 'string' && part.thoughtSignature ? part.thoughtSignature : undefined
          if (typeof part.text === 'string') {
            if (argon && signature) {
              // Argon: a part that carries a signature is a part of its own — never merged into the words before or
              // after it — so the signature goes back on the boundary it came on (an empty text part included)
              yield* closeText()
              const index = next++
              yield builder.start(index, part.thought
                ? { part_kind: 'thinking', content: '', id: null, signature: null, provider_name: 'google', provider_details: { thought_signature: signature } }
                : { part_kind: 'text', content: '', id: null, provider_name: 'google', provider_details: { thought_signature: signature } })
              if (part.text) yield part.thought ? builder.thinkingDelta(index, { content: part.text }) : builder.textDelta(index, part.text)
              yield builder.end(index)
              continue
            }
            if (part.thought) {
              if (thoughtIndex === null) {
                yield* closeText()
                thoughtIndex = next++
                yield builder.start(thoughtIndex, { part_kind: 'thinking', content: '', id: null, signature: null, provider_name: 'google', provider_details: null })
              }
              yield builder.thinkingDelta(thoughtIndex, { content: part.text })
              if (signature) builder.parts[thoughtIndex] = { ...builder.get(thoughtIndex)!, provider_details: { thought_signature: signature } } as never
            } else {
              if (textIndex === null) {
                yield* closeText()
                textIndex = next++
                yield builder.start(textIndex, { part_kind: 'text', content: '', id: null, provider_name: 'google', provider_details: null })
              }
              yield builder.textDelta(textIndex, part.text)
              if (signature) builder.parts[textIndex] = { ...builder.get(textIndex)!, provider_details: { thought_signature: signature } } as never
            }
          } else if (part.functionCall && calls) {
            yield* closeText()
            const call = part.functionCall as { name?: string; args?: Record<string, unknown>; id?: string }
            const index = next++
            const id = call.id || newId('call')
            // Argon: the provider's own id is marked as such (only it goes back as functionCall.id / functionResponse.id)
            const details: Record<string, unknown> = { ...(signature ? { thought_signature: signature } : {}), ...(argon && call.id ? { call_id: call.id } : {}) }
            const tool: Record<string, unknown> = { part_kind: 'tool-call', tool_name: call.name ?? '', args: '', tool_call_id: id, id: null, provider_name: 'google', provider_details: Object.keys(details).length ? details : null }
            yield builder.start(index, tool as never)
            yield builder.argsDelta(index, JSON.stringify(call.args ?? {}))
            yield builder.end(index)
          }
        }
        if (candidate.finishReason) builder.finish_reason = mapFinish(candidate.finishReason as string)
      }

      // Argon's long decode. `token`: the latest checkpoint (or CONTINUATION) token — everything shown came before it;
      // `pending`: the chunks after it, held back (never shown, never a call) until the next token or the end commits
      // them; a drop discards them and the same body goes again with the token. Before the first token the stream is
      // shown as it comes, as it always was: a drop there has nothing to resume from (the runner's recovery, as before).
      // Past the first token no failure goes back to the runner as one it recovers from by sending it all again (a
      // transport error, an outage, a context overflow): it is LongDecodeInterrupted, the failure named in it.
      let token: string | null = null
      let pending: Record<string, unknown>[] = []
      let checkpoints = 0
      let resumes = 0
      let hops = 0
      // usage: within a stream cumulative (its last count stands); a stream that dropped counts up to its last committed
      // chunk (the provider bills a dropped stream to its last checkpoint, none before the first); the streams summed —
      // their output, and their input as details (each later stream reads the prompt again: priced, never the context)
      const streams: RequestUsage[] = []
      let committed: RequestUsage | null = null
      let seen: RequestUsage | null = null
      const total = (): RequestUsage | null => joinUsage(committed ? [...streams, committed] : streams, resumes, hops)
      const interrupted = (why: string, underlying: unknown = null, streamError: Record<string, unknown> | null = null): LongDecodeInterrupted => {
        builder.usage = total()
        const last = underlying === null ? why : `${why}; last failure: ${describeFailure(underlying, streamError)}`
        return new LongDecodeInterrupted(modelName,
          `Gemini long decode interrupted after ${checkpoints} checkpoint${checkpoints === 1 ? '' : 's'}, ${resumes} resume${resumes === 1 ? '' : 's'} and ${hops} hop${hops === 1 ? '' : 's'} (the words after the last checkpoint dropped): ${last}`,
          { resumes, checkpoints, hops, last_error: last, failure: underlying === null ? null : failureFacts(underlying, streamError) })
      }
      // a stream left before its end (a frame that is no JSON, the provider's passing error, a drop, a long decode's
      // end): its body is cancelled, so the request it belongs to does not go on (and on Google's side, generate) while
      // the next one runs. Argon only; a body already read to its end or already broken takes it as a no-op
      const release = (r: Response): void => { if (argon) void r.body?.cancel().catch(() => {}) }
      let response = first
      for (;;) {
        let finished: string | null = null
        let terminalToken: string | null = null
        let failure: unknown = null
        try {
          for await (const message of readSse(response, modelName, idleMs)) {
            if (!message.data) continue
            let data: Record<string, unknown>
            try { data = JSON.parse(message.data) } catch {
              if (!argon) continue
              if (finished !== null) continue
              // a whole data frame that is no JSON: words or a call may be missing — never an answer that seems whole.
              // Past a checkpoint a drop (resumed); before one, a broken stream as the runner knows it
              const broken = new ModelAPIError(modelName, 'the Gemini stream carried invalid SSE data (a frame that is no JSON)')
              if (token !== null) { failure = broken; break }
              builder.usage = total()
              throw broken
            }
            // Argon: after the answer's end (its finishReason: STOP, MAX_TOKENS, CONTINUATION, …) only a count is taken —
            // a late error frame takes nothing away from an end that came (nor from a hop its token named)
            if (argon && finished !== null && data.error) continue
            if (data.error) {
              const error = data.error as Record<string, unknown>
              const thrown = new ModelAPIError(modelName, `Gemini error: ${String(error.status ?? error.code ?? 'error')}: ${String(error.message ?? '')}`.trim())
              if (argon && token !== null && finished === null) {
                // past a checkpoint: the provider's passing failure is resumed like a drop; any other ends the answer
                if (transientStreamError(error)) { failure = thrown; break }
                throw interrupted('the provider ended the stream with an error', thrown, error)
              }
              if (argon) builder.usage = total()
              throw thrown
            }
            sawChunk = true
            const usage = data.usageMetadata ? mapUsage(data.usageMetadata as Record<string, unknown>) : undefined
            if (!argon) {
              if (usage !== undefined) builder.usage = usage
              yield* apply(data)
              continue
            }
            if (usage !== undefined) seen = usage
            if (finished !== null) {
              // after the end only its metadata (a count) is taken: no word, no call comes after a finishReason
              committed = seen
              builder.usage = total()
              continue
            }
            const candidate = firstCandidate(data)
            const blocked = !candidate && blockedPrompt(data)
            const terminal = candidate && typeof candidate.finishReason === 'string' && candidate.finishReason ? candidate.finishReason : blocked ? 'BLOCKED_PROMPT' : null
            const carried = candidate && typeof candidate.continuationToken === 'string' && candidate.continuationToken ? candidate.continuationToken : null
            if (token === null && carried === null && terminal === null) { yield* apply(data); continue }
            pending.push(data)
            if (carried === null && terminal === null) continue
            // a token or the end commits what was held: shown now, in order. An end that is a filter or the provider's
            // failure commits the held words but no call among them (and the response keeps none: see below)
            const ending = terminal === null ? null : blocked ? 'content_filter' : mapFinish(terminal)
            const keepCalls = ending !== 'content_filter' && ending !== 'error'
            for (const held of pending) yield* apply(held, keepCalls)
            pending = []
            committed = seen
            if (terminal !== null) {
              finished = terminal
              terminalToken = carried
            } else {
              token = carried
              checkpoints += 1
            }
            builder.usage = total()
          }
        } catch (error) {
          if (!argon) throw error
          release(response)
          if (signal?.aborted) { builder.usage = total(); throw signal.reason ?? error }
          if (error instanceof LongDecodeInterrupted) throw error
          if (finished !== null && error instanceof TransportError) {
            // the answer had ended (its finishReason came): a broken tail after it takes nothing away
          } else if (token !== null && finished === null && error instanceof TransportError) {
            failure = error
          } else if (token !== null) {
            throw interrupted('the stream failed', error)
          } else {
            builder.usage = total()
            if (error instanceof TransportError && seen && seen.output_tokens) {
              // no checkpoint yet: nothing to resume from, and the provider bills nothing for it — said in the error (the
              // record keeps no count for it), the error still a transport one for the runner
              throw new TransportError(error.kind, `${error.message} (before the first long-decode checkpoint: ${seen.output_tokens} output tokens streamed, none committed)`, { cause: error })
            }
            throw error
          }
        }
        release(response)
        if (argon && failure === null && finished === null) {
          // a stream closed cleanly without its finishReason: past a checkpoint a drop like any other; before one, what
          // it said and counted stands as it always did (a cut one's error follows below)
          if (token !== null) failure = new TransportError('ReadError', 'the stream ended without a finishReason after a long-decode checkpoint')
          else { committed = seen; builder.usage = total() }
        }
        let resumeFrom: string | null = null
        if (failure !== null) resumeFrom = token
        else if (argon && finished === 'CONTINUATION' && hopsAllowed) {
          // the stream's cap reached with the total not spent: the next hop, from the token this end carried — never an
          // older checkpoint's (that would say the hop's words again), never past the hop budget; either is the end of
          // the long decode, not an answer cut at its limit (asking for "the rest" would think it all again)
          if (terminalToken === null) throw interrupted('CONTINUATION came without its continuationToken')
          if (hops >= maxHops) throw interrupted(`the hop budget (${maxHops}) is spent`)
          hops += 1
          token = terminalToken
          resumeFrom = token
        }
        if (resumeFrom === null) break
        // the next stream: what this one held back is gone; its count up to its last commit stays. The end the last
        // stream named (a CONTINUATION's 'length') is no end of the answer: only the next stream's own finishReason is
        pending = []
        builder.finish_reason = null
        if (committed) streams.push(committed)
        committed = null
        seen = null
        builder.usage = total()
        for (;;) {
          if (failure !== null) {
            if (resumes >= maxResumes) throw interrupted(`the resumes from the last checkpoint (${maxResumes}) are spent`, failure)
            resumes += 1
            builder.usage = total()
            await sleep(backoff[Math.min(resumes - 1, backoff.length - 1)]!, signal)
          }
          try {
            response = await send(resumeFrom)
            break
          } catch (error) {
            if (signal?.aborted) throw signal.reason ?? error
            // the resume's own request failed on its way: one more of the same budget, from the same checkpoint; one
            // refused (a 400, a key) ends the long decode, named
            if (!resumableSendFailure(error)) throw interrupted('a resume was refused', error)
            failure = error
          }
        }
      }
      if (argon) {
        builder.usage = total()
        // the response says it came of a long decode past its first checkpoint: the loop does not ask such an answer
        // again in a new request (an output-limit continuation, an empty answer's retry) — that would think it all again
        if (checkpoints > 0 || hops > 0) builder.provider_extra = { long_decode: { checkpoints, resumes, hops } }
        // a filtered or failed Argon answer is no call to run, whenever the call came (the loop runs every call of a
        // response it is given): the calls stay in the events shown, not in the response
        if (builder.finish_reason === 'content_filter' || builder.finish_reason === 'error') {
          builder.parts.forEach((part, i) => { if (part && isToolCall(part)) delete builder.parts[i] })
        }
      }
      if (!sawChunk) throw new ModelAPIError(modelName, 'the Gemini stream carried no chunks')
      // the protocol's end is the candidate's finishReason: a stream that closes before it was cut
      if (builder.finish_reason === null) throw new ModelAPIError(modelName, 'the Gemini stream ended without a finishReason')
      yield* closeText()
      if (builder.finish_reason === 'stop' && builder.parts.some((p) => p && isToolCall(p))) builder.finish_reason = 'tool_call'
    }
    return streamedResponse(builder, events)
  }
}

const gen = (body: Record<string, unknown>): Record<string, unknown> => (body.generationConfig ?? {}) as Record<string, unknown>

function firstCandidate(data: Record<string, unknown>): Record<string, unknown> | undefined {
  return ((data.candidates as Record<string, unknown>[] | undefined) ?? [])[0]
}

/** An in-stream error the provider passes through (overloaded, unavailable, a deadline): worth a resume past a checkpoint. */
function transientStreamError(error: Record<string, unknown>): boolean {
  const status = String(error.status ?? '')
  const code = Number(error.code)
  return ['UNAVAILABLE', 'INTERNAL', 'DEADLINE_EXCEEDED', 'RESOURCE_EXHAUSTED', 'ABORTED'].includes(status) || code === 429 || code === 408 || code >= 500
}

/** A resume's request that failed on its way (a transport failure, a status a client retries) — not one refused. */
function resumableSendFailure(error: unknown): boolean {
  if (error instanceof TransportError) return true
  if (error instanceof ModelHTTPError) return error.status_code === 408 || error.status_code === 409 || error.status_code === 429 || error.status_code >= 500
  return false
}

/** A long decode's last failure as facts only (LongDecodeFailure): no message, no body, no token, no signature.
 *  `streamError`: the provider's in-stream error object, for its code and status word. */
export function failureFacts(error: unknown, streamError: Record<string, unknown> | null = null): LongDecodeFailure {
  const word = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : null)
  const rawName = (error as { name?: unknown })?.name
  const name = word(rawName, /^[A-Za-z]{1,40}$/) ?? 'Error'
  const transport_kind = error instanceof TransportError ? word(error.kind, /^[A-Za-z]{1,40}$/) : null
  const streamCode = Number(streamError?.code)
  const status_code = error instanceof ModelHTTPError ? error.status_code
    : Number.isInteger(streamCode) && streamCode >= 400 && streamCode < 600 ? streamCode : null
  const provider_status = word(streamError?.status, /^[A-Z_]{1,40}$/)
    ?? (error instanceof ModelHTTPError ? word((((error.body ?? {}) as { error?: { status?: unknown } }).error ?? {}).status, /^[A-Z_]{1,40}$/) : null)
  // the provider's words, read here and dropped: only which refusal they named is kept
  const body = error instanceof ModelHTTPError && error.body && typeof error.body === 'object' ? error.body as { message?: unknown; error?: { message?: unknown } } : null
  const words = String(body?.error?.message ?? body?.message ?? (streamError?.message ?? (error as { message?: unknown })?.message ?? ''))
  const reason: LongDecodeFailure['reason'] = status_code === null ? null
    : [400, 413, 422].includes(status_code) && PROVIDER_CONTEXT_WORDS.test(words) ? 'context_overflow'
    : PROVIDER_QUOTA_WORDS.test(words) ? 'quota'
    : PROVIDER_MODEL_GONE_WORDS.test(words) ? 'model_unavailable'
    : null
  return { name, transport_kind, status_code, provider_status, reason }
}

/** A chunk without a candidate whose promptFeedback names a block: a filter's answer. */
function blockedPrompt(data: Record<string, unknown>): boolean {
  const block = (data.promptFeedback as { blockReason?: unknown } | undefined)?.blockReason
  return typeof block === 'string' && block !== '' && block !== 'BLOCK_REASON_UNSPECIFIED'
}

/** A failure as a long decode's error names it: its facts only (failureFacts — a name, a transport kind, a status, the
 *  provider's status word, the refusal named), never its words: a provider's message or body may quote the request,
 *  a key, a continuation token or a thought signature back, and this line goes to the record and the page. */
export function describeFailure(error: unknown, streamError: Record<string, unknown> | null = null): string {
  const f = failureFacts(error, streamError)
  const bits = [f.transport_kind && f.transport_kind !== f.name ? `transport ${f.transport_kind}` : null, f.status_code !== null ? `status ${f.status_code}` : null, f.provider_status, f.reason]
    .filter((b): b is string => !!b)
  return `${f.name}${bits.length ? ` (${bits.join(', ')})` : ''}`
}

/** The streams of one answer as one count: the first stream's input (the prompt: the context's size), every stream's
 *  output; the later streams' input in details (long_decode_extra_input_tokens / _cache_read_tokens), which the meter
 *  prices. One stream and no resume: its own count, as it always was. */
export function joinUsage(streams: RequestUsage[], resumes = 0, hops = 0): RequestUsage | null {
  if (streams.length === 0) return null
  const [head, ...rest] = streams as [RequestUsage, ...RequestUsage[]]
  if (rest.length === 0 && resumes === 0 && hops === 0) return head
  const sum = (key: 'input_tokens' | 'cache_read_tokens' | 'output_tokens', list: RequestUsage[]) => list.reduce((n, u) => n + (u[key] ?? 0), 0)
  return {
    ...head,
    output_tokens: sum('output_tokens', streams),
    details: {
      ...(head.details ?? {}),
      long_decode_streams: streams.length, long_decode_resumes: resumes, long_decode_hops: hops,
      long_decode_extra_input_tokens: sum('input_tokens', rest), long_decode_extra_cache_read_tokens: sum('cache_read_tokens', rest),
    },
  }
}

function mapFinish(reason: string): string {
  switch (reason) {
    case 'STOP': return 'stop'
    case 'MAX_TOKENS': return 'length'
    // the per-request output cap reached with the answer unfinished (Argon's long decode): this build sends no
    // continuationToken, so the response is what a cut one is — incomplete, never a stop
    case 'CONTINUATION': return 'length'
    // ESCALATION and PUP_LIMITED_DISABLED (API reference FinishReason, checked 2026-10-14) end a response that was
    // filtered as well
    case 'SAFETY': case 'RECITATION': case 'BLOCKLIST': case 'PROHIBITED_CONTENT': case 'SPII': case 'ESCALATION': case 'PUP_LIMITED_DISABLED': return 'content_filter'
    // the provider's own failures (API reference FinishReason, checked 2026-10-14): never a whole answer, even with
    // words — a missing signature is the provider's 'error' as well (this route never sends a dummy one)
    case 'MALFORMED_FUNCTION_CALL': case 'MISSING_THOUGHT_SIGNATURE': case 'MALFORMED_RESPONSE': case 'UNEXPECTED_TOOL_CALL': case 'TOO_MANY_TOOL_CALLS': return 'error'
    default: return reason.toLowerCase()
  }
}

/** The provider's count, its thinking inside output_tokens; null: none, or one with a figure that is no count. */
export function mapUsage(usage: Record<string, unknown>): RequestUsage | null {
  const thoughts = countedUsage({ output_tokens: usage.thoughtsTokenCount })
  const counted = countedUsage({ input_tokens: usage.promptTokenCount, cache_read_tokens: usage.cachedContentTokenCount, output_tokens: usage.candidatesTokenCount })
  return counted === null || thoughts === null ? null : { ...counted, output_tokens: counted.output_tokens + thoughts.output_tokens }
}
