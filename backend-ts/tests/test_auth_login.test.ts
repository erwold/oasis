/** Sign-in sessions driven from the page (carried from oasis tests/test_login_api.py): synthetic grants, mock token
 *  endpoints, the loopback callback simulated through its handler, and the loopback-only rule on every endpoint that
 *  creates or removes a grant. */

import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { CredentialStore, NativeAuthError, OAuthCredential, TokenManager, resetStores, setDefaultAuthDir } from '../src/auth/store.ts'
import { accountStatus, LoginManager, type LoginSession } from '../src/auth/web_login.ts'
import type { FetchLike } from '../src/auth/http.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { tempDir } from './helpers.ts'

const NOW = 1_900_000_000_000
const PORTS = { 'openai-codex': 0, anthropic: 0 }

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}
const CODEX_ACCESS = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-synthetic' }, 'https://api.openai.com/profile': { email: 'codex@example.invalid' } })

type Handler = (request: { url: URL; method: string; headers: Headers; body: string }) => Response | Promise<Response>

function tokenEndpoint(request: { url: URL }): Response {
  if (request.url.host === 'auth.openai.com') return Response.json({ access_token: CODEX_ACCESS, refresh_token: 'synthetic-refresh', expires_in: 3600 })
  if (request.url.pathname === '/api/claude_cli/bootstrap') return Response.json({ oauth_account: { account_uuid: 'acct-claude', account_email: 'claude@example.invalid' } })
  return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600 })
}

function fetchOf(handler: Handler): FetchLike {
  return async (input, init) => handler({ url: new URL(String(input)), method: init?.method ?? 'GET', headers: new Headers(init?.headers as Headers), body: typeof init?.body === 'string' ? init.body : '' })
}

function freshStore(): CredentialStore {
  return new CredentialStore(join(tempDir('oasis-auth-'), 'private', 'auth.json'))
}

function manager(store: CredentialStore, handler: Handler = tokenEndpoint, extra: ConstructorParameters<typeof LoginManager>[1] = {}): LoginManager {
  return new LoginManager(store, { fetchImpl: fetchOf(handler), callback_ports: PORTS, ...extra })
}

const justNow = (ms: number | null) => ms !== null && Math.abs(ms - Date.now()) < 5000
const settled = (session: LoginSession) => session.task
const browserRedirect = (session: LoginSession, query: Record<string, string>) =>
  session.server!.respond(`GET ${session.server!.path}?${new URLSearchParams(query).toString()} HTTP/1.1`)

let open: LoginManager[] = []
afterEach(async () => { for (const m of open) await m.close(); open = [] })

test('the callback completes a Codex sign-in', async () => {
  const store = freshStore()
  const logins = manager(store)
  open.push(logins)
  const session = await logins.start('openai-codex')
  expect(session.state).toBe('waiting')
  expect(session.paste_only).toBe(false)
  expect(session.url).toContain(`state=${session.state_token}`)
  expect(session.url).toContain('code_challenge=')
  expect(session.redirect_uri).toBe(`http://localhost:${session.server!.bound_port}/auth/callback`)
  expect((logins.accounts()[0]!.login as Record<string, unknown>).id).toBe(session.id)
  expect(browserRedirect(session, { code: 'synthetic-code', state: session.state_token })[0]).toBe('200 OK')
  await settled(session)
  expect(session.state).toBe('done')
  expect(session.error).toBeNull()
  expect(session.account_label).toBe('codex@example.invalid')
  expect(session.server).toBeNull()
  const grant = store.read('openai-codex')!
  expect(grant.account_id).toBe('acct-synthetic')
  expect(justNow(grant.authorized_at_ms)).toBe(true)
  const row = logins.accounts()[0]!
  expect(row.status).toBe('ready')
  expect(row.account_label).toBe('codex@example.invalid')
  expect(row.login).toBeNull()
  expect(JSON.stringify(session.public()) + JSON.stringify(logins.accounts())).not.toContain('synthetic-')
})

test('a pasted redirect completes an Anthropic sign-in and checks the state', async () => {
  const store = freshStore()
  const seen: Record<string, unknown>[] = []
  const lookups: { url: URL; headers: Headers }[] = []
  const logins = manager(store, (request) => {
    if (request.method === 'POST') seen.push(JSON.parse(request.body) as Record<string, unknown>)
    else lookups.push(request)
    return tokenEndpoint(request)
  })
  open.push(logins)
  const session = await logins.start('anthropic')
  await expect(logins.submit(session.id, 'http://localhost:53692/callback?code=x&state=not-this-login')).rejects.toThrow(NativeAuthError)
  expect(session.state).toBe('waiting')
  await logins.submit(session.id, `http://localhost:53692/callback?code=synthetic-code&state=${session.state_token}`)
  await settled(session)
  expect(session.state).toBe('done')
  expect(seen[0]!.code).toBe('synthetic-code')
  expect(seen[0]!.state).toBe(session.state_token)
  const grant = store.read('anthropic')!
  expect(justNow(grant.authorized_at_ms)).toBe(true)
  expect(lookups.map((r) => r.url.pathname)).toEqual(['/api/claude_cli/bootstrap'])
  expect(lookups[0]!.headers.get('authorization')).toBe('Bearer synthetic-access')
  expect(lookups[0]!.headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
  expect(lookups[0]!.headers.get('user-agent')).toStartWith('claude-cli/')
  expect([grant.email, grant.account_id]).toEqual(['claude@example.invalid', 'acct-claude'])
  await expect(logins.submit(session.id, 'anything')).rejects.toThrow('done')
})

test('a provider rejection is reported without its body', async () => {
  const store = freshStore()
  const logins = manager(store, () => Response.json({ error: 'invalid_grant', error_description: 'SECRET-DETAIL' }, { status: 400 }))
  open.push(logins)
  const session = await logins.start('openai-codex')
  browserRedirect(session, { code: 'x', state: session.state_token })
  await settled(session)
  expect(session.state).toBe('failed')
  expect(session.error).toBeTruthy()
  expect(session.error).not.toContain('SECRET')
  expect(store.read('openai-codex')).toBeNull()
})

test('declined consent fails the session', async () => {
  const logins = manager(freshStore())
  open.push(logins)
  const session = await logins.start('anthropic')
  expect(browserRedirect(session, { error: 'access_denied', state: session.state_token })[0]).toStartWith('400')
  await settled(session)
  expect(session.state).toBe('failed')
  expect(session.error).toContain('declined')
})

test('timeout, cancel and restart', async () => {
  const store = freshStore()
  const quick = manager(store, tokenEndpoint, { timeout_s: 0.05 })
  open.push(quick)
  const session = await quick.start('openai-codex')
  await settled(session)
  expect(session.state).toBe('failed')
  expect(session.error).toContain('timed out')
  const logins = manager(store)
  open.push(logins)
  const first = await logins.start('openai-codex')
  const second = await logins.start('openai-codex')
  expect(first.state).toBe('cancelled')
  expect(first.server).toBeNull()
  expect(second.state).toBe('waiting')
  expect(await logins.cancel(second.id)).toBe(second)
  expect(second.state).toBe('cancelled')
  expect(logins.accounts()[0]!.login).toBeNull()
  await logins.close()
})

test('sign-out removes the grant and stops a sign-in', async () => {
  const store = freshStore()
  const logins = manager(store)
  open.push(logins)
  await store.modify('anthropic', async () => new OAuthCredential({ access: 'synthetic-access', refresh: 'synthetic-refresh', expires_ms: Date.now() + 3_600_000, email: 'old@example.invalid' }))
  const session = await logins.start('anthropic')
  expect(await logins.logout('anthropic')).toBe(true)
  expect(session.state).toBe('cancelled')
  expect(store.read('anthropic')).toBeNull()
  expect(await logins.logout('anthropic')).toBe(false)
  await expect(logins.logout('gemini')).rejects.toThrow(NativeAuthError)
})

test('identity is backfilled once for a grant stored without it', async () => {
  const store = freshStore()
  const lookups: string[] = []
  await store.modify('anthropic', async () => new OAuthCredential({ access: 'synthetic-access', refresh: 'synthetic-refresh', expires_ms: Date.now() + 3_600_000 }))
  const logins = manager(store, (request) => { lookups.push(request.url.pathname); return tokenEndpoint(request) }, { manager: new TokenManager(store, {}) })
  open.push(logins)
  await logins.ensureIdentity()
  expect(lookups).toEqual(['/api/claude_cli/bootstrap'])
  expect(logins.accounts()[1]!.account_label).toBe('claude@example.invalid')
  await logins.ensureIdentity()
  expect(lookups).toEqual(['/api/claude_cli/bootstrap'])
})

test('account status names every state', () => {
  const fresh = new OAuthCredential({ access: 'a', refresh: 'r', expires_ms: NOW + 3_600_000 })
  expect(accountStatus(null, NOW)).toBe('signed_out')
  expect(accountStatus(fresh, NOW)).toBe('ready')
  expect(accountStatus(fresh.with({ expires_ms: NOW + 1000 }), NOW)).toBe('refresh_needed')
  expect(accountStatus(fresh.with({ disabled_reason: 'login_required' }), NOW)).toBe('login_required')
})

test('the endpoints write only from the local machine', async () => {
  const store = freshStore()
  const logins = manager(store)
  let app: App | null = await makeApp(null, { logins })
  try {
    const local = new Client(app, { ip: '127.0.0.1' })
    const remote = new Client(app, { ip: '10.0.0.5' })
    expect((await new Client(app, { headers: {} }).get('/api/auth/accounts')).status).toBe(401)          // the session token still gates reads
    const response = await local.get('/api/auth/accounts')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json() as Record<string, unknown>
    expect(body.local).toBe(true)
    expect((body.providers as Record<string, unknown>[]).map((p) => p.status)).toEqual(['signed_out', 'signed_out', 'signed_out'])
    expect((body.keys as Record<string, unknown>[]).map((r) => r.provider)).toEqual(['anthropic-api', 'openai-api', 'gemini', 'deepseek', 'zhipu'])
    expect((await json(await remote.get('/api/auth/accounts'))).local).toBe(false)
    expect((await remote.post('/api/auth/login/openai-codex')).status).toBe(403)
    expect((await local.post('/api/auth/login/gemini')).status).toBe(404)
    const started = await local.post('/api/auth/login/openai-codex')
    const startedText = await started.clone().text()
    expect(started.status).toBe(200)
    const login = await started.json() as Record<string, unknown>
    expect(login.state).toBe('waiting')
    expect(login.url as string).toContain('state=')
    expect(startedText).not.toContain('synthetic')
    expect((await json(await local.get(`/api/auth/login/${login.id}`))).state).toBe('waiting')
    expect((await local.get('/api/auth/login/nope')).status).toBe(404)
    expect((await remote.post(`/api/auth/login/${login.id}/code`, { input: 'x' })).status).toBe(403)
    const wrong = await local.post(`/api/auth/login/${login.id}/code`, { input: 'http://localhost/cb?code=x&state=no' })
    expect(wrong.status).toBe(400)
    expect((await wrong.json() as Record<string, string>).detail).toContain('state')
    const session = logins.get(login.id as string)
    browserRedirect(session, { code: 'synthetic-code', state: session.state_token })
    await settled(session)
    const finished = await json(await local.get(`/api/auth/login/${login.id}`))
    expect(finished.state).toBe('done')
    expect(finished.account_label).toBe('codex@example.invalid')
    expect(((await json(await local.get('/api/auth/accounts'))).providers as Record<string, unknown>[])[0]!.status).toBe('ready')
    expect((await remote.delete('/api/auth/accounts/openai-codex')).status).toBe(403)
    expect(store.read('openai-codex')).not.toBeNull()
    expect(await json<Record<string, unknown>>(await local.delete('/api/auth/accounts/openai-codex'))).toEqual({ provider: 'openai-codex', removed: true })
    expect(store.read('openai-codex')).toBeNull()
    const again = await json(await local.post('/api/auth/login/anthropic'))
    expect((await remote.delete(`/api/auth/login/${again.id}`)).status).toBe(403)
    expect((await json(await local.delete(`/api/auth/login/${again.id}`))).state).toBe('cancelled')
    // keys: saved and forgotten from the local machine only
    expect((await remote.put('/api/auth/keys/gemini', { key: 'AIzaSyA-synthetic-key-0123456789' })).status).toBe(403)
    expect((await local.put('/api/auth/keys/nope', { key: 'AIzaSyA-synthetic-key-0123456789' })).status).toBe(404)
  } finally {
    await app.close()
    app = null
    setDefaultAuthDir(null)
    resetStores()
  }
})
