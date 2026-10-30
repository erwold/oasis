/** OAuth response validation; provider error bodies are never printed. */

import { LoginRequired, NativeAuthError, NativeAuthTemporaryError } from './errors.ts'

const LOGIN_ERRORS = new Set(['invalid_grant', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalid'])

/** The JSON object of a 200; the failure classes of anything else, without the body. */
export async function responseObject(response: Response, operation: string): Promise<Record<string, unknown>> {
  let data: unknown = null
  try { data = await response.json() } catch { data = null }
  if (response.status !== 200) {
    let error: unknown = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>).error : null
    if (error && typeof error === 'object') error = (error as { code?: unknown; type?: unknown }).code || (error as { type?: unknown }).type
    if (typeof error === 'string' && LOGIN_ERRORS.has(error)) throw new LoginRequired(`${operation}: login required`)
    if (response.status >= 500) throw new NativeAuthTemporaryError(`${operation} failed (HTTP ${response.status})`, response.status)
    throw new NativeAuthError(`${operation} failed (HTTP ${response.status})`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new NativeAuthError(`${operation}: expected a JSON object`)
  return data as Record<string, unknown>
}

export function tokenFields(data: Record<string, unknown>, operation: string): [string, string, number] {
  const access = data.access_token
  const refresh = data.refresh_token
  const ttl = data.expires_in
  if (typeof access !== 'string' || !access || typeof refresh !== 'string' || !refresh
      || typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
    throw new NativeAuthError(`${operation}: invalid token response`)
  }
  return [access, refresh, ttl]
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

/** A fetch with a timeout, network failures surfaced as one error class (the caller names the operation). */
export async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}
