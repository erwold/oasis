/** The subscription routes, independent of any proxy env vars (carried from oasis auth/models.py). The Codex route
 *  signs each request with the ChatGPT grant and its account id; the Claude route sends the CLI's identity headers
 *  and the OAuth betas. Both refuse to sign a request bound anywhere but the fixed first-party host and path. */

import type { FetchLike } from '../llm/http.ts'
import { AntigravityModel } from '../llm/providers/antigravity.ts'
import { AnthropicModel } from '../llm/providers/anthropic.ts'
import { OpenAIResponsesModel } from '../llm/providers/openai_responses.ts'
import { NativeAuthError } from './errors.ts'
import { CLI_USER_AGENT } from './oauth_anthropic.ts'
import type { OAuthCredential } from './store.ts'

export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
// the Codex backend lists and serves a model by this version: 0.155.1 was refused gpt-6.1-sol ("not supported when
// using Codex with a ChatGPT account") that 0.159.0 — the CLI's release of 2026-09-29 — is served (probed 2026-09-30)
export const CODEX_CLIENT_VERSION = '0.159.0'
// the originator the Codex backend was verified to accept for this harness lineage (oasis, 2026-09);
// a different value is untested against the provider
export const CODEX_ORIGINATOR = 'oasis'
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
export const CLI_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
export const ANTHROPIC_OAUTH_BETAS = ['claude-code-20250219', 'oauth-2025-04-20'] as const

/** What a signing hook needs from the token manager: the current grant of a provider, refreshed when stale. */
export interface GrantSource {
  access(provider: string): Promise<OAuthCredential>
}

export interface NativeOptions {
  maxRetries?: number
  fetchImpl?: FetchLike
}

type SignedRequest = { url: URL; headers: Headers; body: string }

/** The Codex signing hook: refuses any destination but the fixed endpoint, then bears the grant and its account id. */
export function codexSigner(manager: GrantSource): (request: SignedRequest) => Promise<void> {
  return async (request) => {
    const url = request.url
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || (url.port !== '' && url.port !== '443')
        || url.pathname !== '/backend-api/codex/responses') {
      throw new NativeAuthError('refusing to send Codex credentials to an unexpected endpoint')
    }
    const grant = await manager.access('openai-codex')
    if (!grant.account_id) throw new NativeAuthError('Codex login is missing its ChatGPT account id; sign in again')
    request.headers.set('authorization', `Bearer ${grant.access}`)
    request.headers.set('chatgpt-account-id', grant.account_id)
  }
}

/** The Codex backend's two image endpoints (the ChatGPT subscription's own Images API, as the Codex CLI calls it). */
export const CODEX_IMAGE_PATHS = ['/backend-api/codex/images/generations', '/backend-api/codex/images/edits'] as const

/** The image signing hook: exactly those two HTTPS paths on chatgpt.com (no port, query or fragment), then the
 *  grant and its account id; anything else is refused before the grant is read. */
export function codexImageSigner(manager: GrantSource): (request: SignedRequest) => Promise<void> {
  return async (request) => {
    const url = request.url
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.port !== '' || url.search !== '' || url.hash !== ''
        || url.username !== '' || url.password !== '' || !(CODEX_IMAGE_PATHS as readonly string[]).includes(url.pathname)) {
      throw new NativeAuthError('refusing to send Codex credentials to an unexpected endpoint')
    }
    const grant = await manager.access('openai-codex')
    if (!grant.account_id) throw new NativeAuthError('Codex login is missing its ChatGPT account id; sign in again')
    request.headers.set('authorization', `Bearer ${grant.access}`)
    request.headers.set('chatgpt-account-id', grant.account_id)
  }
}

/** The Claude signing hook: the fixed endpoint only, a bearer grant instead of a key, the CLI's identity headers. */
export function anthropicSigner(manager: GrantSource): (request: SignedRequest) => Promise<void> {
  return async (request) => {
    const url = request.url
    if (url.protocol !== 'https:' || url.hostname !== 'api.anthropic.com' || (url.port !== '' && url.port !== '443')
        || url.pathname !== '/v1/messages') {
      throw new NativeAuthError('refusing to send Claude credentials to an unexpected endpoint')
    }
    const grant = await manager.access('anthropic')
    request.headers.set('authorization', `Bearer ${grant.access}`)
    request.headers.delete('x-api-key')
    request.headers.set('user-agent', CLI_USER_AGENT)
    request.headers.set('x-app', 'cli')
    const betas = (request.headers.get('anthropic-beta') ?? '').split(',')
    const merged = [...new Set([...betas, ...ANTHROPIC_OAUTH_BETAS].map((b) => b.trim()).filter(Boolean))]
    request.headers.set('anthropic-beta', merged.join(','))
  }
}

export function codexModel(name: string, manager: GrantSource, opts: NativeOptions = {}): OpenAIResponsesModel {
  return new OpenAIResponsesModel(name, {
    baseUrl: CODEX_BASE_URL, codex: true, maxRetries: opts.maxRetries ?? 2, fetchImpl: opts.fetchImpl, beforeSend: codexSigner(manager),
    headers: { originator: CODEX_ORIGINATOR, version: CODEX_CLIENT_VERSION, 'openai-beta': 'responses=experimental', 'user-agent': 'oasis-code/native-auth' },
    // OpenAI's own web search answered on the owner's Codex sign-in (gpt-6.1-sol, 2026-09-30): the search, its sources,
    // the cited answer, and a second turn with the search item sent back
    profile: { supports_thinking: true, openai_supports_encrypted_reasoning_content: true, builtin_tools: ['web_search'] },
  })
}

export function anthropicModel(name: string, manager: GrantSource, opts: NativeOptions = {}): AnthropicModel {
  return new AnthropicModel(name, {
    baseUrl: ANTHROPIC_BASE_URL, maxRetries: opts.maxRetries ?? 2, fetchImpl: opts.fetchImpl, beforeSend: anthropicSigner(manager),
    systemPrefix: [{ type: 'text', text: CLI_IDENTITY }],
  })
}

export function nativeModel(modelId: string, manager: GrantSource, opts: NativeOptions = {}): OpenAIResponsesModel | AnthropicModel | AntigravityModel {
  const at = modelId.indexOf(':')
  const prefix = at < 0 ? modelId : modelId.slice(0, at)
  const name = at < 0 ? '' : modelId.slice(at + 1)
  if (at < 0 || !name) throw new NativeAuthError('model id must include provider:model')
  if (prefix === 'antigravity') return new AntigravityModel(name, manager, opts)
  if (prefix === 'openai') return codexModel(name, manager, opts)
  if (prefix === 'anthropic') return anthropicModel(name, manager, opts)
  throw new NativeAuthError(`no native OAuth route for ${prefix}`)
}
