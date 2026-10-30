/** Antigravity internal GenerateContent, separate from the public Gemini API/Argon long decode. */
import { randomUUID } from 'node:crypto'
import { ANTIGRAVITY_DEFAULT_OUTPUT, antigravityOutputLimit, authorizationKey, resolveAntigravityModel, SUPPORTED_MODELS } from '../../auth/antigravity_catalog.ts'
import type { GrantSource, NativeOptions } from '../../auth/models.ts'
import { ANTIGRAVITY_DAILY_BASE, ANTIGRAVITY_USER_AGENT, INFERENCE_ENDPOINTS, control, isRecord } from '../../auth/oauth_antigravity.ts'
import { NativeAuthError, type OAuthCredential } from '../../auth/store.ts'
import { newId } from '../../ids.ts'
import { PROMPT_TEXT } from '../../prompt_texts.ts'
import { ContentEncodingRefused, safeFetch } from '../../safe_fetch.ts'
import { postJson, readSse } from '../http.ts'
import { responseRoute } from '../handoff.ts'
import { argsDict, isRequest, isResponse, isText, isThinking, isToolCall, isToolReturn, isRetryPrompt, isSystemPromptPart, type ModelMessage, type ModelResponse, type RequestUsage } from '../messages.ts'
import { ModelAPIError, type Model, type ModelSettings, type ModelRequestParameters, type RequestContext, type StreamedResponse, type StreamEvent } from '../model.ts'
import { countedUsage, ResponseBuilder, streamedResponse } from './common.ts'
import { AntigravityCarrierError, antigravityToolSchema, isAntigravityArgumentCarrier, originalToolArguments, wireToolArguments } from './antigravity_schema.ts'
import { GoogleModel } from './google.ts'

export const STREAM_URL = INFERENCE_ENDPOINTS.streamGenerateContent
// GPT-OSS needs the envelope instruction at system scope; declaration-only guidance failed a live tool roundtrip.
const GPT_CARRIER_INSTRUCTION = 'When calling a tool, follow its declared wire parameter schema. A tool whose parameters require __oasis_json takes exactly one argument named __oasis_json: a string containing the entire original argument object as JSON. The original schema quoted in the description describes the contents of that string, not the outer function arguments. Never put the original properties alongside __oasis_json or replace the envelope with them.'
/** Fixed endpoint, validated before acquiring the credential. Exported for endpoint-isolation tests. */
export async function antigravitySigner(manager: GrantSource, request: { url: URL; headers: Headers }): Promise<OAuthCredential> {
  if (request.url.href !== STREAM_URL) throw new NativeAuthError('refusing to send Antigravity credentials to an unexpected endpoint')
  const grant = await manager.access('antigravity')
  if (!grant.project_id || !grant.account_id) throw new NativeAuthError('Antigravity login lacks project or identity; sign in again')
  request.headers.delete('x-goog-api-key')
  request.headers.set('authorization', `Bearer ${grant.access}`)
  return grant
}
/** prompt includes cache; candidate output excludes thoughts. Counts are cumulative snapshots, not deltas. */
export function antigravityUsage(raw: Record<string, unknown>): RequestUsage | null {
  if (!('promptTokenCount' in raw) || !('candidatesTokenCount' in raw)) return null
  for (const key of ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'cachedContentTokenCount', 'totalTokenCount']) if (key in raw && (typeof raw[key] !== 'number' || !Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0)) return null
  const c = countedUsage({ input_tokens: raw.promptTokenCount, output_tokens: raw.candidatesTokenCount, cache_read_tokens: raw.cachedContentTokenCount })
  const t = countedUsage({ output_tokens: raw.thoughtsTokenCount })
  if (!c || !t || c.cache_read_tokens > c.input_tokens) return null
  return { ...c, output_tokens: c.output_tokens + t.output_tokens }
}
/** Official BuildGenerateContentRequest: a nonzero level wins over budget; defaults are resolved before serialization. */
export function antigravityThinkingConfig(selection: ReturnType<typeof resolveAntigravityModel>, metadata: Record<string, unknown>): Record<string, unknown> {
  const includeThoughts = metadata.supportsThinking !== false
  if (selection.model.thinking === 'level') return { includeThoughts, thinkingLevel: selection.effort.toUpperCase() }
  if (selection.model.thinking === 'flash-budget') return { includeThoughts, thinkingBudget: { low: 1000, medium: 4000, high: -1 }[selection.effort] }
  return { includeThoughts, thinkingBudget: 8192 }
}
export class AntigravityModel implements Model {
  readonly system = 'antigravity'
  readonly profile = { supports_thinking: true }
  get route(): string | undefined {
    const source = this.manager as GrantSource & { store?: { read(provider: string): OAuthCredential | null } }
    const grant = source.store?.read('antigravity')
    return grant ? this.routeForGrant(grant) : undefined
  }
  constructor(readonly model_name: string, readonly manager: GrantSource, readonly opts: NativeOptions = {}) {
    if (!Object.hasOwn(SUPPORTED_MODELS, model_name)) throw new NativeAuthError('unsupported Antigravity text/tool model')
  }
  routeForGrant(grant: OAuthCredential): string { return `antigravity:${ANTIGRAVITY_DAILY_BASE}:${this.model_name}:${authorizationKey(grant)}` }
  signatureRouteForGrant(grant: OAuthCredential, upstreamId: string): string { return 'antigravity:' + ANTIGRAVITY_DAILY_BASE + ':' + upstreamId + ':' + authorizationKey(grant) }
  private selected(thinking: unknown) {
    try { return resolveAntigravityModel(this.model_name, thinking) } catch { throw new ModelAPIError(this.model_name, 'unsupported Antigravity thinking effort') }
  }
  body(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, grant: OAuthCredential, catalogMetadata: Record<string, unknown> = {}): Record<string, unknown> {
    const selection = this.selected(params.thinking)
    const route = this.routeForGrant(grant)
    const signatureRoute = this.signatureRouteForGrant(grant, selection.upstreamId)
    // ContextView retains same-group history; only the actual upstream owns private replay data.
    // Responses predating signature_route are accepted only when their old exact route matches.
    const owns = (message: ModelResponse): boolean => message.provider_name === this.system && (
      message.provider_details && Object.hasOwn(message.provider_details, 'signature_route')
        ? responseRoute(message) === route && message.provider_details.signature_route === signatureRoute
        : responseRoute(message) === signatureRoute)
    // A generic mapper is used only for user/system/tool results. It cannot activate public Argon behavior.
    const mapper = new GoogleModel('__antigravity_internal__')
    const contents: Record<string, unknown>[] = []
    const system: string[] = []
    let instructions: string | null = null
    const family = selection.model.family
    const declarations = params.function_tools.map(t => ({ name: t.name, description: t.description, parameters: antigravityToolSchema(t.parameters_json_schema, family === 'claude') }))
    const schemas = new Map(declarations.map(d => [d.name, d.parameters]))
    const ids = new Map<string, string>()
    for (const m of messages) if (isResponse(m) && owns(m)) {
      for (const p of m.parts) if (isToolCall(p) && typeof p.provider_details?.call_id === 'string') ids.set(p.tool_call_id, p.provider_details.call_id)
    }
    for (const m of messages) {
      if (isRequest(m)) {
        if (m.instructions) instructions = m.instructions
        for (const p of m.parts) if (isSystemPromptPart(p)) system.push(p.content)
        const [, turns] = mapper.mapMessages([m])
        const resultIds = m.parts.filter(p => isToolReturn(p) || (isRetryPrompt(p) && p.tool_call_id)).map(p => ids.get((p as { tool_call_id: string }).tool_call_id))
        let at = 0
        for (const turn of turns) for (const p of turn.parts as Record<string, unknown>[]) if (isRecord(p.functionResponse)) {
          const id = resultIds[at++]; if (id) p.functionResponse.id = id
        }
        for (const turn of turns) for (const p of turn.parts as Record<string, unknown>[]) {
          if (p.inlineData || p.fileData) throw new ModelAPIError(this.model_name, 'Antigravity native PDF/video support is not verified on this route')
        }
        contents.push(...turns)
      } else if (isResponse(m)) {
        const own = owns(m)
        const parts: Record<string, unknown>[] = []
        for (const p of m.parts) {
          const scoped = own && ((p as { provider_name?: string | null }).provider_name ?? m.provider_name) === this.system
          const detail = 'provider_details' in p && isRecord(p.provider_details) ? p.provider_details : {}
          const signature = scoped && typeof detail.thought_signature === 'string' ? detail.thought_signature : null
          if (isText(p)) { if (p.content || signature) parts.push({ text: p.content, ...(signature ? { thoughtSignature: signature } : {}) }) }
          else if (isThinking(p)) { if (signature) parts.push(detail.signature_only === true ? { thoughtSignature: signature } : { text: p.content, thought: true, thoughtSignature: signature }) }
          else if (isToolCall(p)) parts.push({ functionCall: { name: p.tool_name, args: scoped && isRecord(detail.wire_args) ? detail.wire_args : wireToolArguments(argsDict(p.args), schemas.get(p.tool_name) ?? {}), ...(scoped && typeof detail.call_id === 'string' ? { id: detail.call_id } : {}) }, ...(signature ? { thoughtSignature: signature } : {}) })
        }
        if (parts.length) contents.push({ role: 'model', parts })
      }
    }
    const merged: Record<string, unknown>[] = []
    for (const turn of contents) {
      const last = merged.at(-1)
      if (last && last.role === turn.role) (last.parts as unknown[]).push(...turn.parts as unknown[])
      else merged.push(turn)
    }
    const outputLimit = antigravityOutputLimit(catalogMetadata)
    const cap = settings.max_tokens ?? Math.min(ANTIGRAVITY_DEFAULT_OUTPUT, outputLimit)
    if (!Number.isSafeInteger(cap) || cap <= 0 || cap > outputLimit) throw new ModelAPIError(this.model_name, `Antigravity output limit must be 1–${outputLimit} tokens (effective catalog/adapter cap)`)
    const generationConfig: Record<string, unknown> = { maxOutputTokens: cap }
    generationConfig.thinkingConfig = antigravityThinkingConfig(selection, catalogMetadata)
    const request: Record<string, unknown> = { contents: merged, generationConfig, sessionId: settings.cache_key ?? randomUUID() }
    const systemTexts = [instructions, ...system].filter((t): t is string => !!t)
    if (family === 'gpt-oss' && declarations.some(d => isAntigravityArgumentCarrier(d.parameters))) systemTexts.push(GPT_CARRIER_INSTRUCTION)
    if (systemTexts.length) request.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] }
    if (params.function_tools.length) request.tools = [{ functionDeclarations: declarations }]
    if (params.function_tools.length && (family === 'claude' || family === 'gpt-oss')) request.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } }
    return { project: grant.project_id, model: selection.upstreamId, request, requestType: 'agent', requestId: randomUUID(), userAgent: 'antigravity' }
  }
  async request(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<ModelResponse> {
    const stream = await this.requestStream(messages, settings, params, ctx)
    for await (const _ of stream.events()) { /* drain */ }
    return stream.get()
  }
  async requestStream(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<StreamedResponse> {
    const selection = this.selected(params.thinking)
    // Capture this request's effort before either awaited auth/catalog operation; shared callers cannot change its gate.
    const selectedParams = { ...params, thinking: selection.effort }
    const headers = new Headers({ 'user-agent': ANTIGRAVITY_USER_AGENT })
    const grant = await antigravitySigner(this.manager, { url: new URL(STREAM_URL), headers })
    const http = this.opts.fetchImpl ?? ((i: string | URL, o?: RequestInit) => safeFetch(i, o))
    const catalog = await control(http, grant.access, 'fetchAvailableModels', { project: grant.project_id }, ctx?.signal)
    if (!isRecord(catalog.models) || (!Object.hasOwn(catalog.models, selection.upstreamId) || !isRecord(catalog.models[selection.upstreamId]))) throw new NativeAuthError('Antigravity model not available in this account catalog')
    const metadata = catalog.models[selection.upstreamId]
    const body = this.body(messages, settings, selectedParams, grant, isRecord(metadata) ? metadata : {})
    const declarations = ((body.request as Record<string, any>).tools?.[0]?.functionDeclarations ?? []) as { name: string; parameters: Record<string, unknown> }[]
    const schemas = new Map(declarations.map(d => [d.name, d.parameters]))
    // Recheck after catalog lookup: a logout or new login must not sign a late inference request.
    const current = await this.manager.access('antigravity')
    if (authorizationKey(current) !== authorizationKey(grant)) throw new NativeAuthError('Antigravity account changed; retry the request')
    headers.set('authorization', `Bearer ${current.access}`)
    const safeHttp: typeof http = async (url, init) => {
      let result: Response
      try { result = await http(url, init) } catch (error) {
        if (init?.signal?.aborted) throw new DOMException('Antigravity request aborted', 'AbortError')
        // a refused Content-Encoding is said as it is (its message names the origin only, never the credential)
        if (error instanceof ContentEncodingRefused) throw error
        throw new Error('Antigravity transport failed')
      }
      if (!result.ok) {
        void result.body?.cancel().catch(() => {})
        return new Response(JSON.stringify({ error: { message: `Antigravity request refused (HTTP ${result.status})` } }), { status: result.status, headers: { 'content-type': 'application/json', ...(result.headers.get('retry-after') ? { 'retry-after': result.headers.get('retry-after')! } : {}) } })
      }
      return result
    }
    const response = await postJson(STREAM_URL, body, Object.fromEntries(headers), this.model_name, { fetchImpl: safeHttp, maxRetries: 0, requestProtocol: 'google' }, ctx?.signal)
    const builder = new ResponseBuilder(this.system, selection.upstreamId, this.routeForGrant(grant))
    builder.provider_extra = { signature_route: this.signatureRouteForGrant(grant, selection.upstreamId), upstream_model: selection.upstreamId, thinking_effort: selection.effort }
    const model = selection.upstreamId
    const claude = selection.model.family === 'claude'
    const events = async function* (): AsyncGenerator<StreamEvent> {
      let index = 0
      let finished = false
      let cumulative: Record<string, unknown> = {}
      let thoughtIndex: number | null = null
      for await (const event of readSse(response, model)) {
        if (!event.data || event.data === '[DONE]') continue
        let envelope: unknown
        try { envelope = JSON.parse(event.data) } catch { throw new ModelAPIError(model, 'Antigravity returned invalid SSE JSON') }
        if (!isRecord(envelope)) throw new ModelAPIError(model, 'Antigravity returned invalid SSE envelope')
        const data = isRecord(envelope.response) ? envelope.response : envelope
        if (envelope.error || data.error) throw new ModelAPIError(model, 'Antigravity stream reported a server error')
        if (isRecord(data.usageMetadata)) { cumulative = { ...cumulative, ...data.usageMetadata }; builder.usage = antigravityUsage(cumulative) }
        if (typeof data.responseId === 'string') builder.provider_response_id = data.responseId
        if (typeof data.modelVersion === 'string') builder.model_name = data.modelVersion
        const candidate = Array.isArray(data.candidates) ? data.candidates[0] : null
        if (!isRecord(candidate)) {
          if (isRecord(data.promptFeedback) && data.promptFeedback.blockReason) { builder.finish_reason = 'content_filter'; finished = true }
          continue
        }
        const content = isRecord(candidate.content) ? candidate.content : {}
        for (const part of Array.isArray(content.parts) ? content.parts : []) {
          if (!isRecord(part)) throw new ModelAPIError(model, 'Antigravity returned an invalid part')
          const signature = typeof part.thoughtSignature === 'string' ? part.thoughtSignature : null
          const details = signature ? { thought_signature: signature } : {}
          if (finished) {
            const signatureTail = !!signature && Object.keys(part).every(k => ['thoughtSignature', 'text', 'thought'].includes(k)) && (part.text === undefined || part.text === '') && (part.thought === undefined || part.thought === true)
            const emptyTail = Object.keys(part).length === 1 && part.text === ''
            if (emptyTail) continue
            if (!signatureTail) throw new ModelAPIError(model, 'Antigravity returned non-signature content after its finish reason')
          }
          // Claude thinking deltas share one signed block. The signature can arrive on its own
          // after several text chunks; never replay just the last fragment under that signature.
          if (claude && (part.thought === true || (signature && (part.text === undefined || part.text === '') && !part.functionCall && thoughtIndex !== null))) {
            if (thoughtIndex === null) {
              thoughtIndex = index++
              yield builder.start(thoughtIndex, { part_kind: 'thinking', content: '', id: null, signature: null, provider_name: 'antigravity', provider_details: {} })
            }
            if (typeof part.text === 'string') yield builder.thinkingDelta(thoughtIndex, { content: part.text })
            if (signature) {
              builder.parts[thoughtIndex] = { ...builder.parts[thoughtIndex]!, provider_details: details } as never
              yield builder.end(thoughtIndex); thoughtIndex = null
            }
            continue
          }
          if (thoughtIndex !== null) { yield builder.end(thoughtIndex); thoughtIndex = null }
          if (typeof part.text === 'string') {
            const n = index++
            yield builder.start(n, part.thought ? { part_kind: 'thinking', content: '', id: null, signature: null, provider_name: 'antigravity', provider_details: details } : { part_kind: 'text', content: '', id: null, provider_name: 'antigravity', provider_details: details })
            yield part.thought ? builder.thinkingDelta(n, { content: part.text }) : builder.textDelta(n, part.text)
            yield builder.end(n)
          } else if (isRecord(part.functionCall)) {
            const call = part.functionCall
            if (typeof call.name !== 'string' || !call.name || (call.args !== undefined && !isRecord(call.args))) throw new ModelAPIError(model, 'Antigravity returned an invalid tool call')
            const n = index++, id = typeof call.id === 'string' ? call.id : null
            // a call whose carrier does not decode is not run: the loop hands the model the reason and it calls again
            let args: unknown = {}, problem: string | null = null
            try { args = originalToolArguments(call.args ?? {}, schemas.get(call.name) ?? {}) }
            catch (error) { if (!(error instanceof AntigravityCarrierError)) throw error; problem = PROMPT_TEXT['app.carrier_malformed'] }
            yield builder.start(n, { part_kind: 'tool-call', tool_name: call.name, tool_call_id: id || newId('call'), args: '', id: null, provider_name: 'antigravity', provider_details: { ...details, wire_args: call.args ?? {}, ...(id ? { call_id: id } : {}), ...(problem ? { args_problem: problem } : {}) } })
            yield builder.argsDelta(n, JSON.stringify(args)); yield builder.end(n)
          } else if (signature) {
            const n = index++
            // A signature-only boundary is retained as such, not attached to an unrelated call.
            yield builder.start(n, { part_kind: 'thinking', content: '', id: null, signature: null, provider_name: 'antigravity', provider_details: { ...details, signature_only: true } })
            yield builder.end(n)
          } else throw new ModelAPIError(model, 'Antigravity returned an unsupported part')
        }
        if (candidate.finishReason) {
          finished = true
          builder.finish_reason = candidate.finishReason === 'STOP' ? 'stop' : candidate.finishReason === 'MAX_TOKENS' ? 'length' : 'content_filter'
          if (candidate.finishReason === 'CONTINUATION') throw new ModelAPIError(model, 'Antigravity internal continuation is not supported')
        }
      }
      if (thoughtIndex !== null) yield builder.end(thoughtIndex)
      if (!finished) throw new ModelAPIError(model, 'Antigravity stream ended before a finish reason')
    }
    return streamedResponse(builder, events)
  }
}
