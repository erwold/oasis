/** API keys saved from the page (carried from oasis tests/test_api_keys.py): stored beside the grants, preferred
 *  over the environment, never echoed back, exported for custom providers, and the catalogue follows them. */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { DEFAULT_MODELS, ModelConfig, type HarnessConfig } from '../src/config.ts'
import * as keys from '../src/auth/keys.ts'
import { CredentialStore, NativeAuthError, OAuthCredential, credentialStore } from '../src/auth/store.ts'
import { catalogEntries } from '../src/llm/catalog.ts'
import { buildModel } from '../src/llm/providers.ts'
import { privateAuthDir } from './helpers.ts'

let auth: ReturnType<typeof privateAuthDir>
let store: CredentialStore
beforeEach(() => { auth = privateAuthDir(); store = credentialStore() })
afterEach(() => auth.done())

test('mask shows at most a short head and the tail', () => {
  expect(keys.mask('sk-0123456789abcdef')).toBe('sk-…cdef')
  expect(keys.mask('abcdefghijk')).toBe('…hijk')
  expect(keys.mask('short')).toBe('••••')
})

test('pasted keys are validated', () => {
  for (const bad of ['', '   ', 'short', 'has space inside', 'tab\there', 'x'.repeat(513), 'non-ascii-é-key']) {
    expect(() => keys.validate(bad)).toThrow(NativeAuthError)
  }
})

test('a saved key wins over the environment and forgetting falls back', async () => {
  process.env.ANTHROPIC_API_KEY = 'env-key-0001'
  try {
    expect(keys.keyWithSource('anthropic-api')).toEqual(['env-key-0001', 'env'])
    expect(keys.keyForEnv('ANTHROPIC_API_KEY')).toEqual(['env-key-0001', 'env'])
    const row = await keys.saveKey('anthropic-api', '  sk-ant-saved-key-9999  ')
    expect(row).toEqual({ provider: 'anthropic-api', source: 'stored', hint: 'sk-…9999' })
    expect(keys.keyWithSource('anthropic-api')).toEqual(['sk-ant-saved-key-9999', 'stored'])
    expect(keys.keyForEnv('ANTHROPIC_API_KEY')).toEqual(['sk-ant-saved-key-9999', 'stored'])
    expect(await keys.forgetKey('anthropic-api')).toBe(true)
    expect(keys.keyWithSource('anthropic-api')).toEqual(['env-key-0001', 'env'])
    delete process.env.ANTHROPIC_API_KEY
    expect(keys.keyWithSource('anthropic-api')).toEqual([null, null])
    expect(await keys.forgetKey('anthropic-api')).toBe(false)
    await expect(keys.saveKey('nope', 'whatever-key-1234')).rejects.toThrow(NativeAuthError)
    // a variable no provider owns still reaches a route that names it
    process.env.MY_ROUTE_KEY = 'route-key-0002'
    expect(keys.keyForEnv('MY_ROUTE_KEY')).toEqual(['route-key-0002', 'env'])
  } finally {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.MY_ROUTE_KEY
  }
})

test('key rows never carry the key and grants stay untouched', async () => {
  await store.modify('anthropic', async () => new OAuthCredential({ access: 'synthetic-access', refresh: 'synthetic-refresh', expires_ms: 4_000_000_000_000, email: 'me@example.invalid' }))
  await keys.saveKey('openai-api', 'sk-openai-secret-value-42')
  const rows = Object.fromEntries(keys.keyRows().map((r) => [r.provider, r]))
  expect(rows['openai-api']!.source).toBe('stored')
  expect(rows['openai-api']!.hint).toBe('sk-…e-42')
  expect(rows['anthropic-api']!.source).toBeNull()
  expect(rows['anthropic-api']!.hint).toBeNull()
  expect(JSON.stringify(rows)).not.toContain('secret')
  expect(store.read('anthropic')!.email).toBe('me@example.invalid')
  expect(Object.keys(store.list())).toEqual(['anthropic'])
})

test('custom providers are named once, then keyed and exported', async () => {
  delete process.env.REPLICATE_API_TOKEN
  await expect(keys.saveKey('replicate', 'r8_synthetic_token_0001')).rejects.toThrow('unknown key provider')
  for (const bad of [{ label: 'Replicate', env: 'lowercase' }, { label: '', env: 'REPLICATE_API_TOKEN' }, { label: 'Replicate', env: 'OPENAI_API_KEY' }]) {
    await expect(keys.saveKey('replicate', 'r8_synthetic_token_0001', bad)).rejects.toThrow(NativeAuthError)
  }
  await expect(keys.saveKey('Replicate', 'r8_synthetic_token_0001', { label: 'Replicate', env: 'REPLICATE_API_TOKEN' })).rejects.toThrow('not a built-in')
  const row = await keys.saveKey('replicate', 'r8_synthetic_token_0001', { label: 'Replicate', env: 'REPLICATE_API_TOKEN' })
  expect(row).toEqual({ provider: 'replicate', source: 'stored', hint: 'r8_…0001' })
  expect(keys.customProviders()).toEqual({ replicate: { label: 'Replicate', env: 'REPLICATE_API_TOKEN' } })
  expect(keys.keyWithSource('replicate')).toEqual(['r8_synthetic_token_0001', 'stored'])
  expect(keys.keyForEnv('REPLICATE_API_TOKEN')).toEqual(['r8_synthetic_token_0001', 'stored'])
  expect(process.env['REPLICATE_API_TOKEN' as string]).toBe('r8_synthetic_token_0001')
  await keys.saveKey('replicate', 'r8_synthetic_token_0002')
  expect(process.env['REPLICATE_API_TOKEN' as string]).toBe('r8_synthetic_token_0002')
  const custom = keys.keyRows().find((r) => r.provider === 'replicate')!
  expect(custom.custom).toBe(true)
  expect(custom.label).toBe('Replicate')
  expect(custom.hint).toBe('r8_…0002')
  expect(JSON.stringify(keys.keyRows())).not.toContain('synthetic_token')
  expect(await keys.forgetKey('replicate')).toBe(true)
  expect('REPLICATE_API_TOKEN' in process.env).toBe(false)
  expect(keys.customProviders()).toEqual({})
  expect(() => keys.keyWithSource('replicate')).toThrow(NativeAuthError)
})

test('a shell variable is never overwritten by a custom key', async () => {
  process.env.MY_SERVICE_KEY = 'from-the-shell-0001'
  try {
    await keys.saveKey('my-service', 'saved-key-value-0002', { label: 'My service', env: 'MY_SERVICE_KEY' })
    expect(keys.exportEnvironment()).toEqual([])
    expect(process.env.MY_SERVICE_KEY).toBe('from-the-shell-0001')
    expect(keys.keyWithSource('my-service')).toEqual(['saved-key-value-0002', 'stored'])
    await keys.forgetKey('my-service')
    expect(process.env.MY_SERVICE_KEY).toBe('from-the-shell-0001')
  } finally {
    delete process.env.MY_SERVICE_KEY
  }
})

test('the Gemini key from the page and the catalogue', async () => {
  delete process.env.GEMINI_API_KEY
  const cfg: HarnessConfig = {
    models: DEFAULT_MODELS.map((m) => new ModelConfig(m as never)), default_model: null, context_window_fallback_tokens: 0,
    protected_paths: [], command_env_passthrough: [], checks: [],
  } as unknown as HarnessConfig
  const route = cfg.models.find((m) => m.provider === 'google')!
  let entry = catalogEntries(cfg).find((e) => e.id === route.id)!
  expect(entry.credential).toBe('unavailable')
  expect(entry.account).toBe('gemini')
  expect(entry.api).toBe('generateContent')
  expect(entry.endpoint).toBe('https://generativelanguage.googleapis.com')
  expect(entry.cost_basis).toBe('estimated from the configured price list')
  await keys.saveKey('gemini', 'AIza-test-gemini-key-0042')
  entry = catalogEntries(cfg).find((e) => e.id === route.id)!
  expect(entry.credential).toBe('available')
  expect(entry.credential_source).toBe('stored')
  const row = keys.keyRows().find((r) => r.provider === 'gemini')!
  expect(row.hint).toBe('AIz…0042')
  expect(row.env).toBe('GEMINI_API_KEY')
  expect(JSON.stringify(keys.keyRows())).not.toContain('AIza-test-gemini-key-0042')
  expect(buildModel(route).model_name).toBe('gemini-4-argon')
  expect(() => new ModelConfig({ id: 'g', provider: 'google', model: 'gemini-x', auth: 'oauth' })).toThrow('no subscription sign-in')
  // an oauth route reports its sign-in state and the subscription endpoint
  const oauth = new ModelConfig({ id: 'codex:gpt', label: 'GPT via Codex', provider: 'openai', model: 'gpt-6-astra', auth: 'oauth' })
  const entries = catalogEntries({ ...cfg, models: [oauth] })
  expect(entries[0]).toMatchObject({ credential: 'unavailable', account: 'openai-codex', credential_hint: 'sign in', credential_env: null })
  expect(entries[0]!.endpoint).toStartWith('https://chatgpt.com/')
  await store.modify('openai-codex', async () => new OAuthCredential({ access: 'a', refresh: 'r', expires_ms: 4_000_000_000_000, account_id: 'acct', email: 'x@example.invalid' }))
  expect(catalogEntries({ ...cfg, models: [oauth] })[0]).toMatchObject({ credential: 'available', credential_source: 'oauth', account_label: 'x@example.invalid' })
})
