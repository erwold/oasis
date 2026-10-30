import { safeProviderHttpError } from './standard_errors.ts'
/** BigModel's standard API-key route (not Coding Plan, not the international Z.AI endpoint).
 * Preserved thinking is replayed byte-for-byte by the Chat serializer, scoped to endpoint/model.
 * GLM-5.3 cannot disable thinking; its smallest effort is low. */
import type { ModelMessage } from '../messages.ts'
import { ModelAPIError, ModelHTTPError, TransportError, type ModelRequestParameters, type ModelSettings, type RequestContext, type StreamedResponse } from '../model.ts'
import { OpenAIChatModel, type ChatOptions } from './openai_chat.ts'

export class ZhipuModel extends OpenAIChatModel {
  override get system(): string { return 'zhipu' }
  override get reasoningSource(): string { return `${this.route} reasoning_content` }

  constructor(model: string, opts: ChatOptions = {}) {
    super(model, { ...opts, baseUrl: opts.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4',
      reasoningReplay: 'reasoning_content', extraBody: {}, profile: { supports_thinking: true } })
  }

  protected override finishReason(reason: string): string {
    if (reason === 'model_context_window_exceeded') throw new ModelHTTPError(400, this.model_name, { error: { message: 'context window exceeded' } })
    if (reason === 'network_error') throw new TransportError('ReadError', 'BigModel stream network error')
    return reason === 'sensitive' ? 'content_filter' : super.finishReason(reason)
  }

  override async requestStream(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<StreamedResponse> {
    try { return await super.requestStream(messages, settings, params, ctx) }
    catch (error) {
      // Provider error bodies can echo arbitrary API keys (GLM keys have no reliably redactable prefix).
      // Keep the HTTP status for retry/access handling, never keep or log the raw response body.
      if (error instanceof ModelHTTPError) throw safeProviderHttpError(error, this.system, this.model_name)
      throw error
    }
  }

  override body(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters): Record<string, unknown> {
    if (params.function_tools.length > 128 || params.function_tools.some((t) => !/^[a-zA-Z0-9_-]{1,64}$/.test(t.name))) {
      throw new ModelAPIError(this.model_name, 'BigModel accepts at most 128 functions with names of 1–64 letters, digits, underscores or dashes')
    }
    const body = super.body(messages, settings, params)
    delete body.max_completion_tokens
    delete body.stream_options
    if (settings.max_tokens) body.max_tokens = settings.max_tokens
    body.tool_stream = true
    body.thinking = { type: 'enabled', clear_thinking: false }
    const level = params.thinking
    body.reasoning_effort = level === false || ['off', 'none', 'minimal', 'low'].includes(String(level)) ? 'low'
      : level === 'medium' || level === 'high' ? 'high' : 'max'
    if (params.function_tools.length) body.tool_choice = 'auto'
    return body
  }
}
