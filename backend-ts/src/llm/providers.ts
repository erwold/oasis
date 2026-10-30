/** Three real model paths, each spoken directly over fetch: Anthropic Messages, OpenAI (Responses by default, Chat
 *  Completions by configuration) and the Gemini API (generateContent). A compatible endpoint is an explicit base_url
 *  on the same protocol; the harness never rewrites one protocol into another. Credentials come from the variable
 *  the route names or the subscription sign-in — read here, never logged. */

import { nativeModel } from '../auth/models.ts'
import { keyForEnv } from '../auth/keys.ts'
import { tokenManager } from '../auth/store.ts'
import type { ModelConfig } from '../config.ts'
import type { FetchLike } from './http.ts'
import type { Model } from './model.ts'
import { AnthropicModel } from './providers/anthropic.ts'
import { GoogleModel } from './providers/google.ts'
import { OpenAIChatModel } from './providers/openai_chat.ts'
import { OpenAIResponsesModel } from './providers/openai_responses.ts'

import { DeepSeekModel } from './providers/deepseek.ts'
import { ZhipuModel } from './providers/zhipu.ts'

export { DeepSeekModel, ZhipuModel, AnthropicModel, GoogleModel, OpenAIChatModel, OpenAIResponsesModel }

/** The route's credential variable is not set; no request was made. */
export class CredentialUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'CredentialUnavailable' }
}

export interface BuildOptions {
  fetchImpl?: FetchLike
  maxRetries?: number
}

export function buildModel(cfg: ModelConfig, opts: BuildOptions = {}): Model {
  const maxRetries = opts.maxRetries ?? 2
  if (cfg.auth === 'oauth') return nativeModel(`${cfg.provider}:${cfg.model}`, tokenManager(), { maxRetries, fetchImpl: opts.fetchImpl })
  // the key is read again at every request: a built model is kept for the process, the key is the person's to
  // replace or forget at any time
  const apiKey = (): string => {
    const [key] = keyForEnv(cfg.key_env)
    if (!key) throw new CredentialUnavailable(`model ${cfg.id}: no key for ${cfg.key_env} (save one on the Accounts page or set the variable)`)
    return key
  }
  apiKey() // a route with no key at all fails here, before a run is under way
  const common = { apiKey, baseUrl: cfg.base_url ?? undefined, maxRetries, fetchImpl: opts.fetchImpl }
  if (cfg.provider === 'anthropic') return new AnthropicModel(cfg.model, common)
  if (cfg.provider === 'openai') {
    return cfg.api === 'chat' ? new OpenAIChatModel(cfg.model, { ...common, reasoningReplay: cfg.reasoning_replay, extraBody: cfg.extra_body }) : new OpenAIResponsesModel(cfg.model, common)
  }
  if (cfg.provider === 'deepseek') return new DeepSeekModel(cfg.model, common)
  if (cfg.provider === 'zhipu') return new ZhipuModel(cfg.model, common)
  if (cfg.provider === 'google') return new GoogleModel(cfg.model, common)
  throw new Error(`unknown provider '${String(cfg.provider)}'`)
}

/** The `provider_name` this route's responses are stamped with. */
export function providerSystem(cfg: ModelConfig): string {
  return cfg.provider
}
