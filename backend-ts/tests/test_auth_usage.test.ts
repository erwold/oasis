/** Account quota checks (carried from oasis tests/test_account_usage.py): read-only requests to the fixed first-party
 *  endpoints, sanitized failures, cache and cooldown discipline, and the API answer. */

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CredentialStore, NativeAuthTemporaryError, OAuthCredential, TokenManager, resetStores, setDefaultAuthDir } from '../src/auth/store.ts'
import { ENDPOINTS, iso, parseClaude, parseCodex, UsageService } from '../src/auth/usage.ts'
import type { FetchLike } from '../src/auth/http.ts'
import type { App } from '../src/main.ts'
import { Client, makeApp } from './api_harness.ts'
import { tempDir } from './helpers.ts'

const NOW = 1_800_000_000
const CODEX = { plan_type: 'pro', rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: NOW + 3600 }, secondary_window: null } }
const CLAUDE = {
  five_hour: { utilization: 17, resets_at: iso(NOW + 100) }, seven_day: { utilization: 36, resets_at: iso(NOW + 1000) }, seven_day_opus: null, seven_day_sonnet: null,
  limits: [{ kind: 'weekly_scoped', percent: 60, resets_at: iso(NOW + 1000), is_active: false, scope: { model: { display_name: 'Fable' } } }],
}

type Req = { url: URL; method: string; headers: Headers; body: string }
type Handler = (request: Req) => Response | Promise<Response>

function fetchOf(handler: Handler): FetchLike {
  return async (input, init) => handler({ url: new URL(String(input)), method: init?.method ?? 'GET', headers: new Headers(init?.headers as Headers), body: typeof init?.body === 'string' ? init.body : '' })
}

function freshManager(): TokenManager {
  return new TokenManager(new CredentialStore(join(tempDir('oasis-usage-'), 'private', 'auth.json')), {}, () => NOW * 1000)
}

async function seed(manager: TokenManager, provider = 'openai-codex', changes: Record<string, unknown> = {}): Promise<void> {
  const value = new OAuthCredential({ access: 'synthetic-access', refresh: 'synthetic-refresh', expires_ms: (NOW + 3600) * 1000, account_id: 'test-account', email: 'test@example.invalid' })
  await manager.store.modify(provider, async () => value.with(changes))
}

function proxyFile(changes: Record<string, unknown> = {}): string {
  const directory = join(tempDir('oasis-proxy-'), 'proxy')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'claude-test.json')
  writeFileSync(path, JSON.stringify({ type: 'claude', access_token: 'proxy-access', refresh_token: 'proxy-refresh', email: 'proxy@example.invalid', expired: iso(NOW + 1000), ...changes }))
  return path
}

function service(manager: TokenManager, handler: Handler, proxyDir: string | null = null): UsageService {
  return new UsageService(manager, proxyDir, { fetchImpl: fetchOf(handler), clock: () => NOW })
}

const accounts = (result: Record<string, unknown>) => result.accounts as Record<string, unknown>[]
const fail = (): never => { throw new Error('missing credentials must not make a request') }

test('a Codex primary window can be weekly and a missing window is not zero', () => {
  const windows = parseCodex(CODEX, NOW)
  expect(windows).toHaveLength(1)
  expect(windows[0]).toEqual({ id: 'codex:primary', label: 'Weekly', used_percent: 10, resets_at: iso(NOW + 3600), window_seconds: 604800 })
  expect(parseCodex({ rate_limit: null }, NOW)).toEqual([])
})

test('Codex extra buckets and a relative reset', () => {
  const result = parseCodex({
    rate_limit: { primary_window: { used_percent: 100.5, reset_after_seconds: 42, limit_window_seconds: 18000 } },
    additional_rate_limits: [{ limit_name: 'Premium', rate_limit: { secondary_window: { used_percent: 55, limit_window_seconds: 7200 } } }],
  }, NOW)
  expect(result[0]!.label).toBe('5 hours')
  expect(result[0]!.used_percent).toBe(100.5)
  expect(result[0]!.resets_at).toBe(iso(NOW + 42))
  expect(result[1]!.label).toBe('Premium · 2 hours')
  expect(result[1]!.resets_at).toBeNull()
})

test('invalid usage never becomes the full allowance', () => {
  for (const invalid of [null, true, '15', Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    expect(parseCodex({ rate_limit: { primary_window: { used_percent: invalid } } }, NOW)[0]!.used_percent).toBeNull()
  }
})

test('Claude scoped buckets and inactive rows are visible', () => {
  expect(parseClaude(CLAUDE).map((w) => [w.label, w.used_percent])).toEqual([['5 hours', 17], ['Weekly', 36], ['Fable · Weekly', 60]])
})

test('Claude generic windows deduplicate the legacy ones and work without them', () => {
  const rows = [{ kind: 'session', percent: 25, is_active: false }, { kind: 'weekly_all', percent: 45 }, { kind: 'weekly_scoped', percent: 75, scope: { model: { display_name: 'Opus' } } }]
  const result = parseClaude({ five_hour: { utilization: 20 }, seven_day_opus: { utilization: 70 }, limits: rows })
  expect(Object.fromEntries(result.map((w) => [w.id, w.used_percent]))).toEqual({ five_hour: 25, seven_day: 45, seven_day_opus: 75 })
  expect(parseClaude({ limits: rows })).toHaveLength(3)
})

test('not connected never attempts the network or creates credentials', async () => {
  const manager = freshManager()
  const result = await service(manager, fail).snapshot()
  expect(accounts(result)).toHaveLength(3)
  expect(accounts(result).every((a) => a.status === 'login_required' && !(a.windows as unknown[]).length && a.source === 'harness')).toBe(true)
  expect(existsSync(manager.store.path)).toBe(false)
})

test('signed canonical read-only requests and no secret output', async () => {
  const manager = freshManager()
  await seed(manager)
  await seed(manager, 'anthropic')
  const saved = process.env.ANTHROPIC_BASE_URL
  process.env.ANTHROPIC_BASE_URL = 'https://invalid.example/token-collector'
  const seen: string[] = []
  const handler: Handler = (request) => {
    seen.push(request.url.toString())
    expect(request.method).toBe('GET')
    expect(request.body).toBe('')
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-access')
    if (request.url.host === 'chatgpt.com') {
      expect(request.headers.get('chatgpt-account-id')).toBe('test-account')
      return Response.json(CODEX)
    }
    expect(request.headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
    return Response.json(CLAUDE)
  }
  try {
    const before = readFileSync(manager.store.path)
    const result = await service(manager, handler).snapshot()
    expect(new Set(seen)).toEqual(new Set([ENDPOINTS['openai-codex'], ENDPOINTS.anthropic]))
    expect(accounts(result).filter((a) => a.provider !== 'antigravity').every((a) => a.status === 'ok')).toBe(true)
    expect(accounts(result).find((a) => a.provider === 'antigravity')?.status).toBe('login_required')
    expect(JSON.stringify(result)).not.toContain('synthetic')
    expect(JSON.stringify(result)).not.toContain('test-account')
    expect(readFileSync(manager.store.path).equals(before)).toBe(true)
  } finally {
    if (saved === undefined) delete process.env['ANTHROPIC_BASE_URL' as string]
    else process.env.ANTHROPIC_BASE_URL = saved
  }
})

test('cache: single flight, force cooldown and account change', async () => {
  const manager = freshManager()
  await seed(manager)
  const calls: string[] = []
  const usage = service(manager, async (request) => { calls.push(request.headers.get('authorization')!); await new Promise((r) => setTimeout(r, 10)); return Response.json(CODEX) })
  await Promise.all(Array.from({ length: 10 }, () => usage.snapshot({ refresh: true })))
  expect(calls).toHaveLength(1)
  await usage.snapshot()
  expect(calls).toHaveLength(1)
  usage.clock = () => NOW + 16
  await usage.snapshot({ refresh: true })
  expect(calls).toHaveLength(2)
  await seed(manager, 'openai-codex', { access: 'new-account-access', email: 'other@example.invalid' })
  const result = await usage.snapshot()
  expect(calls).toHaveLength(3)
  expect(accounts(result)[0]!.account_label).toBe('other@example.invalid')
})

test('native expiry refreshes the harness grant', async () => {
  const manager = freshManager()
  await seed(manager, 'openai-codex', { expires_ms: NOW * 1000 })
  const calls: string[] = []
  manager.refreshers['openai-codex'] = async (token) => { calls.push(token); return new OAuthCredential({ access: 'rotated', refresh: 'rotated-refresh', expires_ms: (NOW + 5000) * 1000, account_id: 'test-account' }) }
  const result = await service(manager, (request) => { expect(request.headers.get('authorization')).toBe('Bearer rotated'); return Response.json(CODEX) }).snapshot()
  expect(accounts(result)[0]!.status).toBe('ok')
  expect(calls).toEqual(['synthetic-refresh'])
})

test('a temporary native refresh outage is retryable', async () => {
  const manager = freshManager()
  await seed(manager, 'openai-codex', { expires_ms: NOW * 1000 })
  manager.refreshers['openai-codex'] = async () => { throw new NativeAuthTemporaryError('do not expose provider details') }
  const result = await service(manager, () => { throw new Error('no request without token') }).snapshot()
  expect(accounts(result)[0]!.error).toBe('unavailable')
  expect(JSON.stringify(result)).not.toContain('provider details')
})

test('proxy files are read-only and opt-in', async () => {
  const manager = freshManager()
  const path = proxyFile()
  const before = readFileSync(path)
  writeFileSync(join(path, '..', 'claude-disabled.json'), JSON.stringify({ type: 'claude', disabled: true }))
  symlinkSync(path, join(path, '..', 'claude-link.json'))
  const result = await service(manager, (request) => { expect(request.headers.get('authorization')).toBe('Bearer proxy-access'); return Response.json(CLAUDE) }, join(path, '..')).snapshot()
  const proxy = accounts(result).filter((a) => a.source === 'proxy')
  expect(proxy).toHaveLength(1)
  expect(proxy[0]!.status).toBe('ok')
  expect(readFileSync(path).equals(before)).toBe(true)
  expect(existsSync(manager.store.path)).toBe(false)
  expect(JSON.stringify(result)).not.toContain('proxy-refresh')
  expect(JSON.stringify(result)).not.toContain(path)
  // without a configured directory no proxy file is read at all
  const saved = process.env.OASIS_CODE_USAGE_PROXY_AUTH_DIR
  delete process.env['OASIS_CODE_USAGE_PROXY_AUTH_DIR' as string]
  try { expect(UsageService.fromEnvironment().proxy_dir).toBeNull() } finally { if (saved !== undefined) process.env.OASIS_CODE_USAGE_PROXY_AUTH_DIR = saved }
})

test('an outage retains the recent snapshot but never forever', async () => {
  const manager = freshManager()
  await seed(manager)
  const responses = [() => Response.json(CODEX), () => new Response('secret-error-body', { status: 503 }), () => new Response(null, { status: 503 })]
  const usage = service(manager, () => responses.shift()!())
  const first = accounts(await usage.snapshot())[0]!
  usage.clock = () => NOW + 61
  const stale = accounts(await usage.snapshot())[0]!
  expect(stale.status).toBe('stale')
  expect(stale.windows).toEqual(first.windows)
  expect(JSON.stringify(stale)).not.toContain('secret-error-body')
  usage.clock = () => NOW + 901
  const expired = accounts(await usage.snapshot())[0]!
  expect(expired.status).toBe('unavailable')
  expect(expired.windows).toEqual([])
})

test('HTTP failures are sanitized and redirects are not followed', async () => {
  for (const [status, error] of [[401, 'login_required'], [403, 'permission_denied'], [302, 'unavailable'], [500, 'unavailable']] as const) {
    const manager = freshManager()
    await seed(manager)
    const calls: string[] = []
    const result = await service(manager, (request) => { calls.push(request.url.toString()); return new Response('synthetic-access synthetic-refresh', { status, headers: { Location: 'https://invalid.example' } }) }).snapshot()
    expect(accounts(result)[0]!.error, String(status)).toBe(error)
    expect(calls).toEqual([ENDPOINTS['openai-codex']!])
    expect(JSON.stringify(result)).not.toContain('synthetic')
  }
})

test('rate-limit backoff also applies to a manual refresh', async () => {
  const manager = freshManager()
  await seed(manager)
  const calls: Req[] = []
  const usage = service(manager, (request) => { calls.push(request); return new Response(null, { status: 429, headers: { 'Retry-After': '120' } }) })
  const first = accounts(await usage.snapshot())[0]!
  expect(first.next_refresh_at).toBe(iso(NOW + 120))
  usage.clock = () => NOW + 70
  await usage.snapshot({ refresh: true })
  expect(calls).toHaveLength(1)
  usage.clock = () => NOW + 121
  await usage.snapshot({ refresh: true })
  expect(calls).toHaveLength(2)
})

test('Claude is asked every five minutes and keeps its numbers for an hour', async () => {
  const manager = freshManager()
  await seed(manager, 'anthropic')
  const responses = [() => Response.json(CLAUDE), ...Array.from({ length: 20 }, () => () => new Response(null, { status: 429, headers: { 'Retry-After': '30' } }))]
  const calls: string[] = []
  const usage = service(manager, (request) => { calls.push(request.url.host); return responses.shift()!() })
  const first = accounts(await usage.snapshot())[0]!
  expect(first.status).toBe('ok')
  expect(first.next_refresh_at).toBe(iso(NOW + 300))
  usage.clock = () => NOW + 120
  await usage.snapshot()
  expect(calls).toHaveLength(1)
  usage.clock = () => NOW + 301
  const limited = accounts(await usage.snapshot())[0]!
  expect(calls).toHaveLength(2)
  expect(limited.status).toBe('stale')
  expect(limited.windows).toEqual(first.windows)
  usage.clock = () => NOW + 3700
  expect(accounts(await usage.snapshot())[0]!.windows).toEqual([])
})

let app: App | null = null
afterEach(async () => { if (app) { await app.close(); app = null; setDefaultAuthDir(null); resetStores() } })

test('the usage API returns no-store and a normalized quota', async () => {
  const manager = freshManager()
  await seed(manager)
  app = await makeApp(null, { usage: service(manager, () => Response.json(CODEX)) })
  const response = await new Client(app).get('/api/auth/usage', { refresh: 'true' })
  const text = await response.clone().text()
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const body = await response.json() as Record<string, unknown>
  expect((((accounts(body))[0]!.windows as Record<string, unknown>[])[0]!).used_percent).toBe(10)
  expect(text).not.toContain('synthetic')
})
