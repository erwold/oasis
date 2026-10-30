/** Claude subscription OAuth using an independent PKCE verifier and state. */

import { safeFetch } from '../safe_fetch.ts'
import { NativeAuthTemporaryError } from './errors.ts'
import { fetchWithTimeout, responseObject, tokenFields, type FetchLike } from './http.ts'
import { OAuthCredential, registerRefresher } from './store.ts'

export const PROVIDER = 'anthropic'
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
export const CALLBACK_HOST = '127.0.0.1'
export const CALLBACK_PORT = 53692
export const CALLBACK_PATH = '/callback'
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`
// Inference and account identity only; oasis-code does not create API keys, upload files, manage MCP servers,
// or manage Claude Code sessions.
export const SCOPES = 'user:profile user:inference'
export const CLI_USER_AGENT = 'claude-cli/2.1.280 (external, cli)'
// The token response carries no identity; the CLI's bootstrap endpoint reports the account the grant belongs to
// (a label for the person, never a gate).
export const BOOTSTRAP_URL = 'https://api.anthropic.com/api/claude_cli/bootstrap'

export function authorizeUrl(opts: { state: string; challenge: string; redirect_uri?: string }): string {
  const params = new URLSearchParams({
    code: 'true', client_id: CLIENT_ID, response_type: 'code', redirect_uri: opts.redirect_uri ?? REDIRECT_URI, scope: SCOPES,
    code_challenge: opts.challenge, code_challenge_method: 'S256', state: opts.state,
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

async function tokenRequest(http: FetchLike, body: Record<string, string>, operation: string): Promise<OAuthCredential> {
  let response: Response
  try {
    response = await fetchWithTimeout(http, TOKEN_URL, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
    }, 30_000)
  } catch {
    throw new NativeAuthTemporaryError(`Anthropic token ${operation}: network error`)
  }
  const data = await responseObject(response, `Anthropic token ${operation}`)
  const [access, refresh, ttl] = tokenFields(data, `Anthropic token ${operation}`)
  return new OAuthCredential({ access, refresh, expires_ms: Math.floor(Date.now() + ttl * 1000) })
}

export async function exchangeCode(http: FetchLike, opts: { code: string; state: string; verifier: string; redirect_uri?: string }): Promise<OAuthCredential> {
  return tokenRequest(http, {
    grant_type: 'authorization_code', client_id: CLIENT_ID, code: opts.code, state: opts.state, code_verifier: opts.verifier,
    redirect_uri: opts.redirect_uri ?? REDIRECT_URI,
  }, 'exchange')
}

export async function refreshWith(http: FetchLike, refreshToken: string): Promise<OAuthCredential> {
  return tokenRequest(http, { grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: refreshToken }, 'refresh')
}

export async function refresh(refreshToken: string): Promise<OAuthCredential> {
  return refreshWith(safeFetch, refreshToken)
}

registerRefresher(PROVIDER, refresh)

/** [account id, email] as the CLI bootstrap reports them; [null, null] when it cannot be read. */
export async function identity(http: FetchLike, access: string): Promise<[string | null, string | null]> {
  let data: unknown = null
  try {
    const url = `${BOOTSTRAP_URL}?${new URLSearchParams({ entrypoint: 'cli', model: 'claude-opus-5-5' }).toString()}`
    const response = await fetchWithTimeout(http, url, {
      method: 'GET', headers: { authorization: `Bearer ${access}`, accept: 'application/json', 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': CLI_USER_AGENT },
    }, 15_000)
    data = response.status === 200 ? await response.json() : null
  } catch {
    return [null, null]
  }
  const account = data && typeof data === 'object' ? (data as { oauth_account?: unknown }).oauth_account : null
  if (!account || typeof account !== 'object') return [null, null]
  const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
  const a = account as { account_uuid?: unknown; account_email?: unknown }
  return [text(a.account_uuid), text(a.account_email)]
}
