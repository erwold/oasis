/** Native OAuth (carried from oasis tests/test_native_auth.py): synthetic grants and a scripted fetch only — the
 *  store, the locked refresh, the two token exchanges, the signing models, and the failure modes that must never
 *  report a success or leak a token. */

import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Agent } from '../src/agent/loop.ts'
import { responseObject, tokenFields } from '../src/auth/http.ts'
import { anthropicModel, anthropicSigner, CLI_IDENTITY, codexModel, codexSigner } from '../src/auth/models.ts'
import * as oauthAnthropic from '../src/auth/oauth_anthropic.ts'
import * as oauthCodex from '../src/auth/oauth_codex.ts'
import { generatePkce, generateState } from '../src/auth/pkce.ts'
import { CredentialStore, LoginRequired, NativeAuthError, NativeAuthTemporaryError, OAuthCredential, TokenManager } from '../src/auth/store.ts'
import { ModelAPIError } from '../src/llm/model.ts'
import { runAgent, tempDir, zodTool } from './helpers.ts'
import { anthropicSse, codexSse, textOutput } from './providers_fixtures.ts'
import { z } from '@oasis-code/contract'

const NOW = 1_900_000_000_000

function grant(opts: { stale?: boolean } = {}): OAuthCredential {
  return new OAuthCredential({ access: 'fake-access', refresh: 'fake-refresh', expires_ms: NOW + (opts.stale ? 1 : 3_600_000), account_id: 'account-test' })
}

async function seed(store: CredentialStore, provider = 'openai-codex', value?: OAuthCredential): Promise<void> {
  await store.modify(provider, async () => value ?? grant())
}

function manager(store: CredentialStore, refreshers: Record<string, (t: string) => Promise<OAuthCredential>> = {}): TokenManager {
  return new TokenManager(store, refreshers, () => NOW)
}

function jwt(payload: unknown): string {
  return 'header.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.signature'
}

function authStore(): CredentialStore {
  return new CredentialStore(join(tempDir(), 'private', 'auth.json'))
}

test('PKCE and a separate state', () => {
  const [verifier, challenge] = generatePkce()
  expect(verifier.length).toBeGreaterThanOrEqual(43)
  expect(verifier.length).toBeLessThanOrEqual(128)
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  expect(challenge).toBe(createHash('sha256').update(verifier, 'ascii').digest('base64url'))
  const state = generateState()
  for (const module of [oauthCodex, oauthAnthropic]) {
    const url = module === oauthCodex ? oauthCodex.authorizeUrl({ state, challenge, originator: 'oasis' }) : oauthAnthropic.authorizeUrl({ state, challenge })
    const q = new URL(url).searchParams
    expect(q.get('state')).toBe(state)
    expect(q.get('state')).not.toBe(verifier)
    expect(q.get('code_challenge')).toBe(challenge)
    expect(url).not.toContain(verifier)
  }
})

test('the store is private and atomic and keeps the other provider', async () => {
  const store = authStore()
  await Promise.all([seed(store), seed(new CredentialStore(store.path), 'anthropic')])
  expect(new Set(Object.keys(store.list()))).toEqual(new Set(['openai-codex', 'anthropic']))
  expect(statSync(store.path).mode & 0o777).toBe(0o600)
  expect(statSync(join(store.path, '..')).mode & 0o777).toBe(0o700)
  expect(String(store.read('anthropic'))).not.toContain('fake-access')
  expect(JSON.stringify(store.read('anthropic'))).not.toContain('fake-access')
  expect(JSON.stringify(store.list())).not.toContain('fake-refresh')
  expect(readdirSync(join(store.path, '..')).filter((n) => n.startsWith('.auth-'))).toEqual([])
  expect(await store.delete('anthropic')).toBe(true)
  expect(store.read('openai-codex')).not.toBeNull()
  expect(await store.delete('anthropic')).toBe(false)
})

test('a refresh runs once across store instances', async () => {
  const store = authStore()
  await seed(store, 'openai-codex', grant({ stale: true }).with({ authorized_at_ms: NOW - 1000 }))
  const calls: string[] = []
  const refresh = async (token: string) => {
    calls.push(token)
    await new Promise((r) => setTimeout(r, 10))
    return grant().with({ access: 'rotated-access', refresh: 'rotated-refresh' })
  }
  const managers = Array.from({ length: 8 }, () => manager(new CredentialStore(store.path), { 'openai-codex': refresh }))
  const results = await Promise.all(managers.map((m) => m.access('openai-codex')))
  expect(calls).toEqual(['fake-refresh'])
  expect(results.every((r) => r.access === 'rotated-access' && r.authorized_at_ms === NOW - 1000)).toBe(true)
})

test('an invalid grant disables the login once and a new login recovers', async () => {
  const store = authStore()
  await seed(store, 'openai-codex', grant({ stale: true }))
  const calls: string[] = []
  const rejected = async (token: string): Promise<OAuthCredential> => { calls.push(token); throw new LoginRequired('invalid grant') }
  for (let i = 0; i < 3; i += 1) {
    const error = await manager(new CredentialStore(store.path), { 'openai-codex': rejected }).access('openai-codex').catch((e) => e)
    expect(error).toBeInstanceOf(LoginRequired)
    expect(error.message).toContain('bun run auth login')
  }
  expect(calls).toHaveLength(1)
  expect(store.read('openai-codex')!.disabled_reason).toBe('login_required')
  await seed(store)
  expect((await manager(store).access('openai-codex')).access).toBe('fake-access')
})

test('a transient refresh failure keeps the grant', async () => {
  const store = authStore()
  await seed(store, 'openai-codex', grant({ stale: true }))
  const retryable = async (): Promise<OAuthCredential> => { throw new NativeAuthError('HTTP 503') }
  const error = await manager(store, { 'openai-codex': retryable }).access('openai-codex').catch((e) => e)
  expect(error).toBeInstanceOf(NativeAuthError)
  expect(error.message).toContain('503')
  expect(store.read('openai-codex')!.equals(grant({ stale: true }))).toBe(true)
})

test('a corrupt store fails without dumping its contents', () => {
  for (const content of ['not-json', '[]', '{"anthropic":{"type":"oauth","access":null}}']) {
    const dir = tempDir()
    const path = join(dir, 'auth.json')
    writeFileSync(path, content)
    expect(() => new CredentialStore(path).read('anthropic')).toThrow(NativeAuthError)
  }
})

test('token responses are validated', () => {
  for (const ttl of [null, true, -1, 0, Number.NaN, Number.POSITIVE_INFINITY, '3600']) {
    expect(() => tokenFields({ access_token: 'secret', refresh_token: 'secret', expires_in: ttl }, 'test')).toThrow(NativeAuthError)
  }
})

test('error bodies are never exposed', async () => {
  const login = await responseObject(new Response(JSON.stringify({ error: 'invalid_grant', description: 'secret-token' }), { status: 400 }), 'refresh').catch((e) => e)
  expect(login).toBeInstanceOf(LoginRequired)
  expect(String(login)).not.toContain('secret')
  const outage = await responseObject(new Response('secret-token', { status: 500 }), 'refresh').catch((e) => e)
  expect(outage).toBeInstanceOf(NativeAuthTemporaryError)
  expect(outage.status_code).toBe(500)
  expect(String(outage)).not.toContain('secret')
})

test('the Codex exchange and refresh wire', async () => {
  const token = jwt({ [oauthCodex.JWT_AUTH_CLAIM]: { chatgpt_account_id: 'acct' } })
  const seen: URLSearchParams[] = []
  const http = async (_url: string | URL, init?: RequestInit) => {
    seen.push(new URLSearchParams(init?.body as string))
    return new Response(JSON.stringify({ access_token: token, refresh_token: 'rotated', expires_in: 3600 }), { status: 200 })
  }
  const g = await oauthCodex.exchangeCode(http, { code: 'code', verifier: 'verifier', redirect_uri: oauthCodex.REDIRECT_URI })
  await oauthCodex.refreshWith(http, 'old')
  expect(g.account_id).toBe('acct')
  expect(seen[0]!.get('code_verifier')).toBe('verifier')
  expect(seen[1]!.get('grant_type')).toBe('refresh_token')
})

test('the Anthropic exchange wire', async () => {
  const seen: Record<string, unknown>[] = []
  const http = async (_url: string | URL, init?: RequestInit) => {
    seen.push(JSON.parse(init?.body as string))
    return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }), { status: 200 })
  }
  await oauthAnthropic.exchangeCode(http, { code: 'code', state: 'state', verifier: 'verifier' })
  await oauthAnthropic.refreshWith(http, 'old')
  expect(seen[0]!.state).toBe('state')
  expect(seen[0]!.code_verifier).toBe('verifier')
  expect(seen[1]!.refresh_token).toBe('old')
})

test('the device flow: pending, slow_down, success', async () => {
  const replies = [
    new Response('', { status: 403 }),
    new Response(JSON.stringify({ error: 'slow_down' }), { status: 429 }),
    new Response(JSON.stringify({ authorization_code: 'code', code_verifier: 'verifier' }), { status: 200 }),
  ]
  let elapsed = 0
  const sleeps: number[] = []
  const sleep = async (seconds: number) => { sleeps.push(seconds); elapsed += seconds }
  const http = async () => replies.shift()!
  const result = await oauthCodex.devicePoll(http, { device_auth_id: 'device', user_code: 'user', interval_s: 2 }, { sleep, clock: () => elapsed })
  expect(result).toEqual(['code', 'verifier'])
  expect(sleeps).toEqual([2, 7])
})

function echoAgent(): Agent<null> {
  return new Agent<null>({ instructions: 'Keep system instructions.', tools: [zodTool<null, z.ZodType>('echo', 'echo', z.object({ word: z.string() }), (_d, a) => (a as { word: string }).word)] })
}

test('a Codex run signs every request, keeps the wire shape and round-trips a tool', async () => {
  const store = authStore()
  await seed(store)
  process.env.OPENAI_BASE_URL = 'http://proxy.invalid/v1'
  process.env.OPENAI_API_KEY = 'proxy-key'
  const requests: Record<string, unknown>[] = []
  const handle = async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string)
    requests.push(body)
    const headers = new Headers(init?.headers as Headers)
    expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(headers.get('authorization')).toBe('Bearer fake-access')
    expect(headers.get('chatgpt-account-id')).toBe('account-test')
    expect(headers.get('originator')).toBe('oasis')
    // every request of the conversation names it the same way: the backend routes to its cache by these
    for (const name of ['session-id', 'thread-id', 'x-client-request-id']) expect(headers.get(name)).toBe('oasis:session:s_test')
    expect(body.prompt_cache_key).toBe('oasis:session:s_test')
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect('instructions' in body).toBe(true)
    expect('max_output_tokens' in body).toBe(false)
    expect(body.include).toContain('reasoning.encrypted_content')
    const output = requests.length === 1
      ? [{ type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'echo', arguments: '{"word":"hi"}', status: 'completed' }]
      : textOutput()
    return new Response(codexSse(output), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const model = codexModel('gpt-6-astra', manager(store), { fetchImpl: handle })
    const run = await runAgent(echoAgent(), model, 'Use echo.', null, { settings: { max_tokens: 32000, cache_key: 'oasis:session:s_test' } })
    expect(run.result.output).toBe('OK')
    expect(requests).toHaveLength(2)
    expect((requests[1]!.input as { type?: string }[]).some((i) => i.type === 'function_call_output')).toBe(true)
  } finally {
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_KEY
  }
})

test('the Claude route keeps the tools and the system text behind the CLI identity', async () => {
  const store = authStore()
  await seed(store, 'anthropic')
  process.env.ANTHROPIC_API_KEY = 'proxy-key'
  process.env.ANTHROPIC_BASE_URL = 'http://proxy.invalid'
  const seen: Record<string, unknown>[] = []
  const handle = async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string)
    seen.push(body)
    const headers = new Headers(init?.headers as Headers)
    expect(new URL(String(url)).hostname).toBe('api.anthropic.com')
    expect(headers.get('authorization')).toBe('Bearer fake-access')
    expect(headers.has('x-api-key')).toBe(false)
    expect(headers.get('anthropic-beta')).toContain('oauth-2025-04-20')
    expect(headers.get('user-agent')).toBe('claude-cli/2.1.280 (external, cli)')
    expect((body.system as { text: string }[])[0]!.text).toBe(CLI_IDENTITY)
    expect(body.cache_control).toEqual({ type: 'ephemeral' })                                       // the subscription route asks for the cache like the API route
    expect((body.system as { cache_control?: unknown }[]).at(-1)!.cache_control).toEqual({ type: 'ephemeral' })
    if (body.stream) return new Response(anthropicSse(), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    return new Response(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 })
  }
  try {
    const model = anthropicModel('claude-opus-5-5', manager(store), { fetchImpl: handle })
    const run = await runAgent(new Agent<null>({ instructions: 'Original instructions', tools: [] }), model, 'Hi', null)
    expect(run.result.output).toBe('OK')
    expect((seen[0]!.system as { text: string }[]).some((b) => b.text === 'Original instructions')).toBe(true)
    // the non-streaming path reads the JSON answer
    const direct = await model.request([{ kind: 'request', parts: [{ part_kind: 'user-prompt', content: 'Hi' }], instructions: 'Original instructions' }], {}, { function_tools: [], allow_text_output: true, thinking: null })
    expect(direct.parts).toMatchObject([{ part_kind: 'text', content: 'OK' }])
    expect(direct.usage).toMatchObject({ input_tokens: 10, output_tokens: 2 })
  } finally {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_BASE_URL
  }
})

for (const provider of ['openai-codex', 'anthropic'] as const) {
  test(`a streamed run reloads the token between runs (${provider})`, async () => {
    const store = authStore()
    await seed(store, provider)
    const seen: string[] = []
    const handle = async (_url: string | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers as Headers).get('authorization')!)
      if (provider === 'openai-codex') return new Response(codexSse(textOutput()), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      return new Response(anthropicSse(), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const model = provider === 'openai-codex' ? codexModel('gpt-6-astra', manager(store), { fetchImpl: handle }) : anthropicModel('claude-opus-5-5', manager(store), { fetchImpl: handle })
    for (let i = 0; i < 2; i += 1) {
      if (i) await seed(store, provider, grant().with({ access: 'new-access' }))
      const run = await runAgent(new Agent<null>({ instructions: '', tools: [] }), model, 'Hi', null)
      expect(run.result.output).toBe('OK')
    }
    expect(seen).toEqual(['Bearer fake-access', 'Bearer new-access'])
  })
}

test('signing refuses a wrong destination without touching the grant', async () => {
  const store = authStore()
  await seed(store)
  const request = { url: new URL('https://other.invalid/responses'), headers: new Headers(), body: '' }
  const error = await codexSigner(manager(store))(request).catch((e) => e)
  expect(error).toBeInstanceOf(NativeAuthError)
  expect(error.message).toContain('unexpected endpoint')
  expect(request.headers.has('authorization')).toBe(false)
  for (const bad of ['http://chatgpt.com/backend-api/codex/responses', 'https://chatgpt.com:8443/backend-api/codex/responses', 'https://chatgpt.com/backend-api/other']) {
    await expect(codexSigner(manager(store))({ url: new URL(bad), headers: new Headers(), body: '' })).rejects.toThrow('unexpected endpoint')
  }
  await seed(store, 'anthropic')
  await expect(anthropicSigner(manager(store))({ url: new URL('https://api.anthropic.com/v1/complete'), headers: new Headers(), body: '' })).rejects.toThrow('unexpected endpoint')
  const good = { url: new URL('https://api.anthropic.com/v1/messages'), headers: new Headers({ 'x-api-key': 'k', 'anthropic-beta': 'a-beta' }), body: '' }
  await anthropicSigner(manager(store))(good)
  expect(good.headers.has('x-api-key')).toBe(false)
  expect(good.headers.get('anthropic-beta')).toBe('a-beta,claude-code-20250219,oauth-2025-04-20')
  expect(good.headers.get('x-app')).toBe('cli')
})

test('a failed stream does not report a success', async () => {
  const store = authStore()
  await seed(store)
  const response = { id: 'resp_failed', object: 'response', created_at: 1900000000, model: 'gpt-6-astra', status: 'failed', output: [], error: { code: 'server_error', message: 'stream error' } }
  const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', error: null }, sequence_number: 0 }, { type: 'response.failed', response, sequence_number: 1 }]
  const content = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  const model = codexModel('gpt-6-astra', manager(store), { fetchImpl: async () => new Response(content, { status: 200, headers: { 'content-type': 'text/event-stream' } }) })
  const error = await runAgent(new Agent<null>({ instructions: '', tools: [] }), model, 'Hi', null).catch((e) => e)
  expect(error).toBeInstanceOf(ModelAPIError)
  expect(error.message).toContain('server_error')
})

test('a truncated stream does not return partial text', async () => {
  const store = authStore()
  await seed(store)
  const content = codexSse(textOutput('partial')).split('event: response.completed')[0]!
  const model = codexModel('gpt-6-astra', manager(store), { fetchImpl: async () => new Response(content, { status: 200, headers: { 'content-type': 'text/event-stream' } }) })
  const error = await runAgent(new Agent<null>({ instructions: '', tools: [] }), model, 'Hi', null).catch((e) => e)
  expect(error).toBeInstanceOf(ModelAPIError)
  expect(error.message).toContain('stream ended')
})

for (const provider of ['openai-codex', 'anthropic'] as const) {
  for (const streaming of [false, true]) {
    test(`a missing login is reported as such, never as a transport failure (${provider}, streaming=${streaming})`, async () => {
      const store = authStore()
      const unreachable = async (): Promise<Response> => { throw new Error('a request without a login must not reach the provider') }
      const model = provider === 'openai-codex'
        ? codexModel('gpt-6-astra', manager(store), { maxRetries: 0, fetchImpl: unreachable })
        : anthropicModel('claude-opus-5-5', manager(store), { maxRetries: 0, fetchImpl: unreachable })
      const params = { function_tools: [], allow_text_output: true, thinking: null }
      const messages = [{ kind: 'request' as const, parts: [{ part_kind: 'user-prompt' as const, content: 'Hi' }] }]
      const error = streaming
        ? await runAgent(new Agent<null>({ instructions: '', tools: [] }), model, 'Hi', null).catch((e) => e)
        : await model.request(messages, {}, params).catch((e) => e)
      expect(error).toBeInstanceOf(LoginRequired)
      expect(error.message).toContain('bun run auth login')
    })
  }
}

test('the lock file is taken over when its owner died', async () => {
  const store = authStore()
  mkdirSync(join(store.path, '..'), { recursive: true, mode: 0o700 })
  const lock = store.path + '.lock'
  writeFileSync(lock, '')
  const old = Date.now() / 1000 - 600
  const { utimesSync } = require('node:fs') as typeof import('node:fs')
  utimesSync(lock, old, old)
  await seed(store)
  expect(store.read('openai-codex')).not.toBeNull()
  expect(existsSync(lock)).toBe(false)
})

test('a lock that names a dead process is taken over at once, however new', async () => {
  const store = authStore()
  mkdirSync(join(store.path, '..'), { recursive: true, mode: 0o700 })
  const exited = Bun.spawnSync(['true'])
  writeFileSync(store.path + '.lock', JSON.stringify({ pid: exited.pid, nonce: 'dead-owner' }))
  const started = Date.now()
  await seed(store)
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(existsSync(store.path + '.lock')).toBe(false)
})

test('a lock held by a live process is never taken over, however old: the next holder waits for it', async () => {
  const store = authStore()
  await seed(store)
  const lock = store.path + '.lock'
  const { utimesSync } = require('node:fs') as typeof import('node:fs')
  const order: string[] = []
  let inside = 0
  let most = 0
  const hold = async (name: string, ms: number) => {
    inside += 1; most = Math.max(most, inside); order.push(`${name} in`)
    await new Promise((r) => setTimeout(r, ms))
    inside -= 1; order.push(`${name} out`)
  }
  // the first holder's lock ages past any stale age while it holds it (a machine asleep, a process stopped)
  const old = Date.now() / 1000 - 600
  const first = store.locked(async () => { utimesSync(lock, old, old); await hold('first', 300) })
  await new Promise((r) => setTimeout(r, 30))
  const second = new CredentialStore(store.path).locked(() => hold('second', 50))
  await Promise.all([first, second])
  expect(most).toBe(1)
  expect(order).toEqual(['first in', 'first out', 'second in', 'second out'])
  expect(existsSync(lock)).toBe(false)
})

test('a holder whose lock is no longer its own leaves the lock file in place', async () => {
  const store = authStore()
  await seed(store)
  const lock = store.path + '.lock'
  const taker = JSON.stringify({ pid: process.pid, nonce: 'the-taker' })
  // meanwhile the lock became another holder's: releasing, the first holder does not remove it
  await store.locked(async () => { writeFileSync(lock, taker) })
  expect(existsSync(lock)).toBe(true)
  expect(readFileSync(lock, 'utf8')).toBe(taker)
})

test('a grant another writer stored while a refresh was under way stays; the older result is not written over it', async () => {
  const store = authStore()
  await seed(store, 'openai-codex', grant({ stale: true }))
  const newer = new OAuthCredential({ access: 'fake-access-newer', refresh: 'fake-refresh-newer', expires_ms: NOW + 7_200_000, account_id: 'account-test' })
  const result = await store.modify('openai-codex', async () => {
    // another writer (one that took the lock over) stores its grant while this one waits on its refresh
    writeFileSync(store.path, JSON.stringify({ 'openai-codex': newer.stored() }), { mode: 0o600 })
    return new OAuthCredential({ access: 'fake-access-older', refresh: 'fake-refresh-older', expires_ms: NOW + 3_600_000, account_id: 'account-test' })
  })
  expect(result?.access).toBe('fake-access-newer')
  expect(store.read('openai-codex')!.access).toBe('fake-access-newer')
})

// Exact repository OAuth routes, synthetic signer/credential fixtures only. Not an online capability probe.
test('UTF-8 attachments survive the Claude OAuth and Codex backend signing boundaries unchanged', async () => {
  const { AttachmentHydration, attachmentPiece } = await import('../src/llm/attachments.ts')
  const { sha256Hex } = await import('../src/store.ts')
  const bytes = Buffer.from('# PKCE flow\r\nUse a code verifier. 你好\n')
  const ref = { asset_id: 'a_oauth_text', name: 'notes.md', media_type: 'text/plain' as const, file_kind: 'text' as const, representation: 'utf8-v1' as const, bytes: bytes.length, sha256: sha256Hex(bytes) }
  for (const provider of ['anthropic', 'openai-codex'] as const) {
    const store = authStore(); await seed(store, provider)
    const seen: string[] = []
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers), body = JSON.parse(String(init?.body))
      expect(headers.get('authorization')).toBe('Bearer fake-access')
      expect(String(url)).toBe(provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://chatgpt.com/backend-api/codex/responses')
      if (provider === 'anthropic') { expect(body.system[0].text).toBe(CLI_IDENTITY); expect(headers.get('anthropic-beta')).toContain('oauth') }
      else { expect(headers.get('chatgpt-account-id')).toBe('account-test'); expect(body.store).toBe(false) }
      const blocks = provider === 'anthropic' ? body.messages.flatMap((m: { content: unknown[] }) => m.content) : body.input.flatMap((m: { content?: unknown[] }) => m.content ?? [])
      const envelope = blocks.map((b: { text?: string }) => b.text ?? '').find((t: string) => t.includes('[attached UTF-8 file v1:'))
      expect(envelope).toContain(bytes.toString('utf8'))
      expect(envelope).toContain(ref.sha256); seen.push(envelope)
      return new Response(provider === 'anthropic' ? anthropicSse() : codexSse(textOutput()), { headers: { 'content-type': 'text/event-stream' } })
    }
    const native = provider === 'anthropic' ? anthropicModel('claude-opus-5-5', manager(store), { fetchImpl }) : codexModel('gpt-6-astra', manager(store), { fetchImpl })
    const model = new AttachmentHydration(native, () => bytes, { images: true })
    const prompt = [attachmentPiece(ref)], frozen = JSON.stringify(prompt)
    for (let i = 0; i < 2; i++) await runAgent(new Agent<null>({ instructions: 'Keep instructions', tools: [] }), model, prompt, null)
    expect(seen[1]).toBe(seen[0]); expect(JSON.stringify(prompt)).toBe(frozen)
  }
})
