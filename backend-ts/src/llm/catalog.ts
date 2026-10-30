/** The model catalog the UI and the runs see: configured routes with what is known about each (credential
 *  presence, window and its source, capabilities and their source). Nothing here asserts a provider's guarantee;
 *  unknown stays unknown. */

import { discoveredRoutes } from '../auth/antigravity_catalog.ts'
import { ANTIGRAVITY_DAILY_BASE } from '../auth/oauth_antigravity.ts'
import { requestLimitsFor, type ModelEntry, type RequestLimits } from '@oasis-code/contract'
import { resolveWindow } from '../agent/context.ts'
import { ANTHROPIC_BASE_URL, CODEX_BASE_URL } from '../auth/models.ts'
import { credentialState } from '../auth/routing.ts'
import type { HarnessConfig, ModelConfig } from '../config.ts'
import { claudeThinking } from './providers/anthropic.ts'
import { CHATGPT_WEB, CHATGPT_WEB_ID, isChatGptWeb } from './chatgpt_web.ts'

/** The configured routes, then ChatGPT on the web (a route of the desktop app's, unless the configuration names one
 *  of that id itself). */
export function routesOf(config: HarnessConfig): ModelConfig[] {
  const dynamic = discoveredRoutes()
  const routes = [...config.models.filter(m => m.provider !== 'antigravity' || dynamic.some(d => d.id === m.id)), ...dynamic.filter(d => !config.models.some(m => m.id === d.id))]
  return routes.some((m) => m.id === CHATGPT_WEB_ID) ? routes : [...routes, CHATGPT_WEB]
}

/** The endpoint a route's requests go to: ChatGPT on the web is its page; a subscription route's is the fixed
 *  first-party one (its configured base_url is not used); else the configured or official API. */
export function routeEndpoint(m: ModelConfig): string {
  if (isChatGptWeb(m.id) || m.auth !== 'oauth') return m.endpoint
  return m.provider === 'antigravity' ? ANTIGRAVITY_DAILY_BASE : m.provider === 'openai' ? CODEX_BASE_URL : ANTHROPIC_BASE_URL
}

/** The bounds one request of a route meets (what http.ts asserts on its body): its provider's wire protocol and, for
 *  OpenAI, whether the endpoint is the Codex backend. What native attachments are judged against. */
export function routeLimits(m: ModelConfig): RequestLimits {
  const protocol = m.provider === 'anthropic' ? 'anthropic' : (m.provider === 'google' || m.provider === 'antigravity') ? 'google' : m.provider === 'openai' ? 'openai' : null
  return requestLimitsFor({ protocol, url: routeEndpoint(m) })
}

/** The variable a route's key is read from; none for a subscription route (it signs in instead). */
export function routeKeyEnv(m: ModelConfig): string | null {
  return m.auth === 'api_key' ? m.key_env : null
}

/** Pure capability resolution; no credential access and no nearest-effort request mapping. */
export function supportedThinking(m: ModelConfig): string[] | null {
  if (m.reasoning_efforts !== null) return m.reasoning_efforts
  if (m.provider !== 'anthropic') return null
  const capability = claudeThinking(m.model)
  return capability.known ? [...(capability.off === 'disabled' ? ['off'] : []), ...capability.efforts] : null
}

export function catalogEntries(config: HarnessConfig): ModelEntry[] {
  const out: ModelEntry[] = []
  for (const m of routesOf(config)) {
    const state = credentialState(m)
    const known = resolveWindow(m, config.context_window_fallback_tokens)
    const [window, windowSource] = known.known ? [known.window, known.source] : [null, known.source]
    out.push({
      id: m.id, label: m.label || m.id, provider: m.provider, configured_model: m.model, endpoint: routeEndpoint(m),
      api: m === CHATGPT_WEB ? 'chatgpt-web' : { openai: m.api, anthropic: 'messages', google: 'generateContent', antigravity: 'generateContent', deepseek: 'responses', zhipu: 'chat' }[m.provider],
      auth: m.auth, account: state.account, account_label: state.account_label, credential: state.status, credential_source: state.source,
      credential_hint: state.hint, credential_env: routeKeyEnv(m), context_window: window, window_source: windowSource,
      concurrency: m.concurrency, slot_scope: m.scope,
      capabilities: Object.keys(m.capabilities).length ? m.capabilities : { tool_calls: 'unknown', streaming: 'unknown' },
      capability_source: m.capability_source, pricing: m.pricing,
      cost_basis: m.provider === 'antigravity' ? 'subscription quota; per-request monetary cost unknown; no paid credits enabled' : m.pricing ? `estimated${m.pricing.currency ? ` in ${m.pricing.currency}` : ''} from the configured price list${m.pricing.currency === 'CNY' ? '; USD unknown (no FX conversion)' : ''}${m.pricing.schedule === 'deepseek-peak' ? '; peak/holiday uncertainty is recorded as a range' : ''}` : 'unknown (no price list configured)',
      supported_thinking: supportedThinking(m),
      default: m.id === config.default_model, reasoning_mode: m.reasoning_mode, reasoning_replay: m.reasoning_replay,
    })
  }
  return out
}

export function findModel(config: HarnessConfig, modelId: string): ModelConfig | null {
  return routesOf(config).find((m) => m.id === modelId) ?? null
}
