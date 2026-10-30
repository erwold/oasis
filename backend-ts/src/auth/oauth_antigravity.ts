/** Personal OAuth protocol observed at CLIProxyAPI 911f49cb; not an official integration.
 * All credential-bearing destinations are fixed, and redirects are never followed. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContentEncodingRefused, safeFetch as screenedFetch } from '../safe_fetch.ts'
import { responseObject, tokenFields, type FetchLike } from './http.ts'
import { defaultAuthDir, NativeAuthError, NativeAuthTemporaryError, OAuthCredential, registerRefresher } from './store.ts'

export const PROVIDER = 'antigravity'
// The consumer catalog is client-profile dependent. Verified against official Hub 2.23.0
// and same-account controlled requests on 2026-10-19: the legacy unversioned UA omits
// Argon and Flash effort IDs. Identify this implementation and declare compatibility;
// this is a fixed protocol profile, never a response-triggered fallback or rotation.
export const ANTIGRAVITY_USER_AGENT = 'oasis-code/antigravity-oauth (compatible; antigravity/hub/2.23.0)'
export const CALLBACK_HOST = '127.0.0.1'
export const CALLBACK_PORT = 51121
export const CALLBACK_PATH = '/oauth-callback'
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`
/** The OAuth client the sign-in uses is not part of the source: OASIS_CODE_ANTIGRAVITY_CLIENT_ID and
 *  OASIS_CODE_ANTIGRAVITY_CLIENT_SECRET, else `antigravity-client.json` ({"client_id", "client_secret"}) in the data
 *  directory, read at each use; with neither, signing in and refreshing say what is missing. */
export const CLIENT_FILE = 'antigravity-client.json'
export function oauthClient(): { id: string; secret: string } {
  const id = process.env.OASIS_CODE_ANTIGRAVITY_CLIENT_ID, secret = process.env.OASIS_CODE_ANTIGRAVITY_CLIENT_SECRET
  if (id && secret) return { id, secret }
  let data: unknown = null
  try { data = JSON.parse(readFileSync(join(defaultAuthDir(), CLIENT_FILE), 'utf8')) } catch { /* no file, or not JSON */ }
  const file = isRecord(data) ? data : {}
  if (typeof file.client_id === 'string' && file.client_id && typeof file.client_secret === 'string' && file.client_secret) return { id: file.client_id, secret: file.client_secret }
  throw new NativeAuthError(`Antigravity sign-in needs an OAuth client: put {"client_id", "client_secret"} in ${CLIENT_FILE} in the data folder, or set OASIS_CODE_ANTIGRAVITY_CLIENT_ID and OASIS_CODE_ANTIGRAVITY_CLIENT_SECRET`)
}
export const TOKEN_URL = 'https://oauth2.googleapis.com/token'
// Consumer endpoint split observed at the pinned reference: never rotate/fall back between tiers.
export const ANTIGRAVITY_PROD_BASE = 'https://cloudcode-pa.googleapis.com'
export const ANTIGRAVITY_DAILY_BASE = 'https://daily-cloudcode-pa.googleapis.com'
export const CONTROL_ENDPOINTS = Object.freeze({
  loadCodeAssist: `${ANTIGRAVITY_PROD_BASE}/v1internal:loadCodeAssist`,
  onboardUser: `${ANTIGRAVITY_DAILY_BASE}/v1internal:onboardUser`,
  fetchAvailableModels: `${ANTIGRAVITY_DAILY_BASE}/v1internal:fetchAvailableModels`,
})
export const INFERENCE_ENDPOINTS = Object.freeze({
  generateContent: `${ANTIGRAVITY_DAILY_BASE}/v1internal:generateContent`,
  streamGenerateContent: `${ANTIGRAVITY_DAILY_BASE}/v1internal:streamGenerateContent?alt=sse`,
})
export const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo?alt=json'
const SCOPES = ['cloud-platform', 'userinfo.email', 'userinfo.profile', 'cclog', 'experimentsandconfigs'].map(s => `https://www.googleapis.com/auth/${s}`)

export function validateRedirect(uri: string): void {
  let u: URL
  try { u = new URL(uri) } catch { throw new NativeAuthError('invalid Antigravity callback') }
  if (u.protocol !== 'http:' || u.hostname !== 'localhost' || !u.port || u.pathname !== CALLBACK_PATH || u.search || u.hash || u.username || u.password) throw new NativeAuthError('invalid Antigravity callback')
}
export function authorizeUrl(opts: { state: string; challenge?: string; redirect_uri?: string }): string {
  const redirect = opts.redirect_uri ?? REDIRECT_URI
  validateRedirect(redirect)
  const params = new URLSearchParams({ client_id: oauthClient().id, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '), state: opts.state, access_type: 'offline', prompt: 'consent' })
  if (opts.challenge) { params.set('code_challenge', opts.challenge); params.set('code_challenge_method', 'S256') }
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}
async function token(http: FetchLike, fields: Record<string, string>, previousRefresh?: string): Promise<OAuthCredential> {
  const client = oauthClient()
  const response = await safeFetch(http, TOKEN_URL, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, ...fields }), signal: AbortSignal.timeout(30_000) })
  const data = await responseObject(response, 'Antigravity token exchange')
  if (data.refresh_token === undefined && previousRefresh) data.refresh_token = previousRefresh
  const [access, refresh, ttl] = tokenFields(data, 'Antigravity token exchange')
  return new OAuthCredential({ access, refresh, expires_ms: Date.now() + Math.round(ttl * 1000) })
}
export async function exchangeCode(http: FetchLike, opts: { code: string; verifier: string; redirect_uri: string; signal?: AbortSignal }): Promise<OAuthCredential> {
  validateRedirect(opts.redirect_uri)
  const underlying = http
  http = (url, init) => underlying(url, { ...init, signal: opts.signal ? AbortSignal.any([opts.signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal })
  let grant = await token(http, { grant_type: 'authorization_code', code: opts.code, code_verifier: opts.verifier, redirect_uri: opts.redirect_uri })
  const data = await responseObject(await safeFetch(http, USERINFO_URL, { redirect: 'manual', headers: { authorization: `Bearer ${grant.access}` }, signal: AbortSignal.timeout(20_000) }), 'Antigravity identity')
  if (typeof data.id !== 'string' || !data.id) throw new NativeAuthError('Antigravity identity missing account id')
  grant = grant.with({ account_id: data.id, email: typeof data.email === 'string' ? data.email : null })
  const assist = await control(http, grant.access, 'loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } })
  const project = projectOf(assist) ?? await onboardDefault(http, grant.access, assist, { signal: opts.signal })
  // Only the server's explicitly allowed default; never select a paid upgrade or enable credits.
  return grant.with({ project_id: project, authorization_id: randomUUID(), tier_id: reportedTierId(assist) })
}
export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export async function control(http: FetchLike, access: string, method: 'loadCodeAssist' | 'fetchAvailableModels' | 'onboardUser', body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!Object.hasOwn(CONTROL_ENDPOINTS, method)) throw new NativeAuthError('unsupported Antigravity control operation')
  const response = await safeFetch(http, CONTROL_ENDPOINTS[method], { method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', 'user-agent': ANTIGRAVITY_USER_AGENT }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) })
  return responseObject(response, `Antigravity ${method}`)
}
export function refreshToken(http: FetchLike, refresh: string): Promise<OAuthCredential> { return token(http, { grant_type: 'refresh_token', refresh_token: refresh }, refresh) }
registerRefresher(PROVIDER, refresh => refreshToken((input, init) => screenedFetch(input, init), refresh))

function projectOf(data: Record<string, unknown>): string | null {
  for (const key of ['cloudaicompanionProject', 'projectId', 'project']) {
    const p = data[key]
    const id = typeof p === 'string' ? p : isRecord(p) && typeof p.id === 'string' ? p.id : null
    if (id?.trim()) return id.trim()
  }
  return null
}
/** Standard onboarding observed in the fixed reference; no inferred free/paid tier or fabricated project. */
export async function onboardDefault(http: FetchLike, access: string, assist: Record<string, unknown>, opts: { signal?: AbortSignal; pollMs?: number } = {}): Promise<string> {
  const defaults = (Array.isArray(assist.allowedTiers) ? assist.allowedTiers : []).filter(t => isRecord(t) && t.isDefault === true && typeof t.id === 'string' && t.id)
  if (defaults.length !== 1) throw new NativeAuthError('Antigravity did not offer one authorized default tier for onboarding')
  const tier = defaults[0] as Record<string, unknown>
  for (let attempt = 0; attempt < 5; attempt++) {
    opts.signal?.throwIfAborted()
    const data = await control(http, access, 'onboardUser', { tier_id: tier.id, metadata: { ide_type: 'ANTIGRAVITY', ide_name: 'antigravity' } }, opts.signal)
    if (data.done === true) {
      const project = isRecord(data.response) ? projectOf(data.response) : null
      if (!project) throw new NativeAuthError('Antigravity onboarding completed without a project')
      return project
    }
    if (attempt < 4) await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new DOMException('Sign-in cancelled', 'AbortError')) }
      const timer = setTimeout(() => { opts.signal?.removeEventListener('abort', abort); resolve() }, opts.pollMs ?? 2000)
      opts.signal?.addEventListener('abort', abort, { once: true })
      if (opts.signal?.aborted) abort()
    })
  }
  throw new NativeAuthError('Antigravity onboarding did not complete within five polls')
}

async function safeFetch(http: FetchLike, url: string, init: RequestInit): Promise<Response> {
  try { return await http(url, init) } catch (error) {
    if (init.signal?.aborted) throw new DOMException('Antigravity request cancelled or timed out', 'AbortError')
    // a refused Content-Encoding says what it is (it names no credential): not a transport that may come back
    if (error instanceof ContentEncodingRefused) throw error
    throw new NativeAuthTemporaryError('Antigravity transport unavailable')
  }
}

/** Pasted callbacks are accepted only at this session's exact registered redirect. */
export function validatePastedRedirect(text: string, expectedUri: string): void {
  let url: URL
  try { url = new URL(text.trim()) } catch { throw new NativeAuthError('paste the complete Antigravity callback URL') }
  const expected = new URL(expectedUri)
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash || url.username || url.password) throw new NativeAuthError('Antigravity callback URL does not match this login')
}

/** Raw control-plane label, not a marketing subscription classification. paidTier is distinct
 * from currentTier (the reference reads paidTier.id separately); paid metadata wins when
 * present. This never selects an onboarding tier, reads a balance, or enables credits. */
export function reportedTierId(assist: Record<string, unknown>): string | null {
  for (const key of ['paidTier', 'currentTier']) {
    const tier = assist[key]
    if (isRecord(tier) && typeof tier.id === 'string' && tier.id.trim()) return tier.id.trim()
  }
  return null
}
