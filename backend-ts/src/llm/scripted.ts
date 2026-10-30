/** A scripted model: a function of (messages, info) -> ModelResponse, replayed as stream chunks the way a real
 *  provider's stream arrives, so the loop, the runner and the tests drive the same path a real route would.
 *  Nothing here reaches a network. */

import {
  emptyUsage, isText, isThinking, isToolCall, modelResponse, type ModelMessage, type ModelResponse, type RequestUsage, type ResponsePart,
} from './messages.ts'
import type {
  Model, ModelProfile, ModelRequestParameters, ModelSettings, RequestContext, StreamEvent, StreamedResponse, ToolDefinition,
} from './model.ts'

export interface AgentInfo {
  function_tools: ToolDefinition[]
  model_settings: ModelSettings
  model_request_parameters: ModelRequestParameters
}

export type Script = (messages: ModelMessage[], info: AgentInfo) => ModelResponse | Promise<ModelResponse>

export interface ScriptedOptions {
  modelName?: string
  profile?: ModelProfile
  /** The provider system the responses are stamped with (a fake that looks like a provider's own responses). */
  providerName?: string | null
  usage?: RequestUsage
}

let counter = 0

const isZero = (u: RequestUsage): boolean => !(u.input_tokens || u.output_tokens || u.cache_read_tokens || u.cache_write_tokens)

/** The response as a stream: text as one start and one delta per part, thinking with its signature, a tool call
 *  with its args as one delta. */
export class ScriptedModel implements Model {
  readonly model_name: string
  readonly system: string | null
  readonly profile: ModelProfile
  private readonly script: Script
  private readonly usageOf: RequestUsage
  calls = 0

  constructor(script: Script, opts: ScriptedOptions = {}) {
    this.script = script
    this.model_name = opts.modelName ?? 'scripted'
    this.system = opts.providerName ?? null
    this.profile = opts.profile ?? { supports_thinking: false }
    this.usageOf = opts.usage ?? { ...emptyUsage(), input_tokens: 5, output_tokens: 2 }
  }

  private info(settings: ModelSettings, params: ModelRequestParameters): AgentInfo {
    return { function_tools: params.function_tools, model_settings: settings, model_request_parameters: params }
  }

  private stamp(response: ModelResponse): ModelResponse {
    this.calls += 1
    const parts: ResponsePart[] = this.system
      ? response.parts.map((p) => ((isText(p) || isThinking(p) || isToolCall(p)) && p.provider_name == null ? { ...p, provider_name: this.system } : p))
      : response.parts
    return modelResponse(parts, {
      ...response, usage: response.usage && !isZero(response.usage) ? response.usage : this.usageOf, model_name: response.model_name ?? this.model_name,
      provider_name: response.provider_name ?? this.system,
      provider_response_id: response.provider_response_id ?? (this.system ? `${this.system}-resp-${this.calls}` : null),
    })
  }

  async request(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, _ctx?: RequestContext): Promise<ModelResponse> {
    return this.stamp(await this.script(messages, this.info(settings, params)))
  }

  async requestStream(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<StreamedResponse> {
    const raw = await Promise.race([
      Promise.resolve(this.script(messages, this.info(settings, params))),
      new Promise<never>((_, reject) => ctx?.signal?.addEventListener('abort', () => reject(ctx.signal?.reason ?? new Error('aborted')), { once: true })),
    ])
    if (ctx?.signal?.aborted) throw ctx.signal.reason ?? new Error('aborted')
    const response = this.stamp(raw)
    let index = 0
    const self = this
    return {
      model_name: response.model_name ?? this.model_name,
      usage: () => response.usage ?? self.usageOf,
      get: () => response,
      async *events(): AsyncGenerator<StreamEvent, void, undefined> {
        for (const part of response.parts) {
          const i = index++
          if (isText(part)) {
            const pieces = part.content.length > 4 ? [part.content.slice(0, 4), part.content.slice(4)] : [part.content]
            yield { type: 'part_start', index: i, part: { ...part, content: pieces[0]! } }
            for (const piece of pieces.slice(1)) yield { type: 'part_delta', index: i, delta: { part_kind: 'text', content_delta: piece } }
            yield { type: 'part_end', index: i, part }
          } else if (isThinking(part)) {
            yield { type: 'part_start', index: i, part: { ...part, content: '' } }
            yield { type: 'part_delta', index: i, delta: { part_kind: 'thinking', content_delta: part.content, signature_delta: part.signature ?? undefined } }
            yield { type: 'part_end', index: i, part }
          } else if (isToolCall(part)) {
            const id = part.tool_call_id || `call_${++counter}`
            const full = { ...part, tool_call_id: id }
            yield { type: 'part_start', index: i, part: { ...full, args: '' } }
            yield { type: 'part_delta', index: i, delta: { part_kind: 'tool-call', args_delta: typeof full.args === 'string' ? full.args : JSON.stringify(full.args ?? {}) } }
            yield { type: 'part_end', index: i, part: full }
            const at = response.parts.indexOf(part)
            response.parts[at] = full
          } else {
            yield { type: 'part_start', index: i, part }
            yield { type: 'part_end', index: i, part }
          }
        }
      },
    }
  }
}

/** A script that answers the k-th request with the k-th response and then repeats the last one (a final text). */
export function steps(...responses: (ResponsePart[] | ((messages: ModelMessage[]) => ModelResponse | Promise<ModelResponse>))[]): Script {
  let n = 0
  return (messages) => {
    const i = Math.min(n, responses.length - 1)
    n += 1
    const r = responses[i]!
    return typeof r === 'function' ? r(messages) : modelResponse(r)
  }
}

export function scriptedModel(script: Script, modelName = 'scripted', profile?: ModelProfile): ScriptedModel {
  return new ScriptedModel(script, { modelName, profile })
}

/** A scripted model whose responses carry a provider's identity (the provider_name the responses are stamped with,
 *  a response id, a model name) and whose thinking parts carry a signature — what a real route's history looks
 *  like, so the handoff has something to strip. */
export function stampedModel(script: Script, providerName: string, modelName: string): ScriptedModel {
  return new ScriptedModel(async (messages, info) => {
    const response = await script(messages, info)
    const parts = response.parts.map((p) => (isThinking(p) ? { ...p, signature: p.signature ?? 'sig' } : p))
    return { ...response, parts }
  }, { modelName, providerName })
}
