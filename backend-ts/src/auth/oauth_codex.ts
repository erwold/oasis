/** OpenAI Codex (ChatGPT Plus/Pro) OAuth: the same public client the Codex CLI registers, PKCE in the browser with a
 *  loopback callback on port 1455, or the device-code flow for a machine without a browser. The access token is a
 *  JWT whose claims name the ChatGPT account the subscription belongs to; the Codex backend wants that id in a
 *  header on every request. */

import { safeFetch } from '../safe_fetch.ts'
import { NativeAuthError, NativeAuthTemporaryError } from './errors.ts'
import { fetchWithTimeout, responseObject, tokenFields, type FetchLike } from './http.ts'
import { OAuthCredential, registerRefresher } from './store.ts'

export const PROVIDER = 'openai-codex'
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const AUTH_BASE_URL = 'https://auth.openai.com'
export const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`
export const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`
export const CALLBACK_HOST = '127.0.0.1'
export const CALLBACK_PORT = 1455
export const CALLBACK_PATH = '/auth/callback'
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`
export const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`
export const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`
export const DEVICE_VERIFICATION_URL = `${AUTH_BASE_URL}/codex/device`
export const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`
export const DEVICE_TIMEOUT_S = 15 * 60
export const SCOPE = 'openid profile email offline_access'
export const JWT_AUTH_CLAIM = 'https://api.openai.com/auth'
export const JWT_PROFILE_CLAIM = 'https://api.openai.com/profile'
export const TOKEN_TIMEOUT_MS = 30_000

export function authorizeUrl(opts: { state: string; challenge: string; originator: string; redirect_uri?: string }): string {
  const params = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: opts.redirect_uri ?? REDIRECT_URI, scope: SCOPE,
    code_challenge: opts.challenge, code_challenge_method: 'S256', state: opts.state, id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true', originator: opts.originator,
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const data = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function accountIdFromToken(access: string): string | null {
  const payload = decodeJwtPayload(access) ?? {}
  const auth = payload[JWT_AUTH_CLAIM]
  const account = auth && typeof auth === 'object' ? (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id : null
  return typeof account === 'string' && account ? account : null
}

export function emailFromTokens(access: string, idToken: string | null | undefined): string | null {
  for (const token of [access, idToken]) {
    if (!token) continue
    const profile = (decodeJwtPayload(token) ?? {})[JWT_PROFILE_CLAIM]
    const email = profile && typeof profile === 'object' ? (profile as { email?: unknown }).email : null
    if (typeof email === 'string' && email) return email.trim().toLowerCase()
  }
  return null
}

function credentialFromResponse(data: Record<string, unknown>, operation: string): OAuthCredential {
  const [access, refresh, expiresIn] = tokenFields(data, `OpenAI Codex token ${operation}`)
  const accountId = accountIdFromToken(access)
  if (accountId === null) throw new NativeAuthError(`OpenAI Codex token ${operation}: no ChatGPT account id in the access token`)
  return new OAuthCredential({
    access, refresh, expires_ms: Math.floor(Date.now() + expiresIn * 1000), account_id: accountId,
    email: emailFromTokens(access, data.id_token as string | undefined),
  })
}

async function tokenRequest(http: FetchLike, form: Record<string, string>, operation: string): Promise<OAuthCredential> {
  let response: Response
  try {
    response = await fetchWithTimeout(http, TOKEN_URL, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(),
    }, TOKEN_TIMEOUT_MS)
  } catch {
    throw new NativeAuthTemporaryError(`OpenAI Codex token ${operation}: network error`)
  }
  return credentialFromResponse(await responseObject(response, `OpenAI Codex token ${operation}`), operation)
}

export async function exchangeCode(http: FetchLike, opts: { code: string; verifier: string; redirect_uri: string }): Promise<OAuthCredential> {
  return tokenRequest(http, {
    grant_type: 'authorization_code', client_id: CLIENT_ID, code: opts.code, code_verifier: opts.verifier, redirect_uri: opts.redirect_uri,
  }, 'exchange')
}

export async function refreshWith(http: FetchLike, refreshToken: string): Promise<OAuthCredential> {
  return tokenRequest(http, { grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: refreshToken }, 'refresh')
}

export async function refresh(refreshToken: string): Promise<OAuthCredential> {
  return refreshWith(safeFetch, refreshToken)
}

registerRefresher(PROVIDER, refresh)

// -- device code (headless) ----------------------------------------------------

export interface DeviceAuth { device_auth_id: string; user_code: string; interval_s: number }

export async function deviceStart(http: FetchLike): Promise<DeviceAuth> {
  const response = await fetchWithTimeout(http, DEVICE_USER_CODE_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: CLIENT_ID }),
  }, TOKEN_TIMEOUT_MS)
  const data = await responseObject(response, 'OpenAI Codex device login')
  let interval = Number(data.interval ?? 5)
  if (!Number.isFinite(interval)) interval = 5
  for (const k of ['device_auth_id', 'user_code']) {
    if (typeof data[k] !== 'string' || !data[k]) {
      throw new NativeAuthError(`OpenAI Codex device login: unexpected response ${JSON.stringify(Object.keys(data).sort())}`)
    }
  }
  return { device_auth_id: data.device_auth_id as string, user_code: data.user_code as string, interval_s: Math.min(60, Math.max(1, interval)) }
}

/** Poll until the person approves in the browser: [authorization_code, code_verifier]. */
export async function devicePoll(http: FetchLike, device: DeviceAuth, opts: {
  deadline_s?: number; sleep?: (seconds: number) => Promise<void>; clock?: () => number
} = {}): Promise<[string, string]> {
  const sleep = opts.sleep ?? ((s: number) => new Promise<void>((r) => setTimeout(r, s * 1000)))
  const clock = opts.clock ?? (() => performance.now() / 1000)
  const deadline = clock() + (opts.deadline_s ?? DEVICE_TIMEOUT_S)
  let interval = device.interval_s
  while (clock() < deadline) {
    const response = await fetchWithTimeout(http, DEVICE_TOKEN_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
    }, TOKEN_TIMEOUT_MS)
    if (response.status === 200) {
      const data = await responseObject(response, 'OpenAI Codex device login')
      const code = data.authorization_code
      const verifier = data.code_verifier
      if (typeof code !== 'string' || !code || typeof verifier !== 'string' || !verifier) {
        throw new NativeAuthError(`OpenAI Codex device login: unexpected token response ${JSON.stringify(Object.keys(data).sort())}`)
      }
      return [code, verifier]
    }
    if (response.status !== 403 && response.status !== 404) { // 403 / 404 = authorization pending
      let errorCode: unknown = null
      try {
        const body = await response.json()
        const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : null
        errorCode = error && typeof error === 'object' ? (error as { code?: unknown }).code : error
      } catch { /* not JSON */ }
      if (errorCode === 'slow_down') interval += 5
      else if (errorCode !== 'deviceauth_authorization_pending') {
        throw new NativeAuthError(`OpenAI Codex device login failed (HTTP ${response.status})`)
      }
    }
    await sleep(Math.min(interval, Math.max(0, deadline - clock())))
  }
  throw new NativeAuthError('OpenAI Codex device login timed out')
}
