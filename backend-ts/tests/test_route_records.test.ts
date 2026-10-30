/** A run's records name the endpoint its requests go to and the key variable it reads — the same the catalogue shows:
 *  a subscription route's fixed first-party endpoint and no key variable; a key route's configured API and variable. */
import { afterEach, expect, test } from 'bun:test'
import * as repo from '../src/db/repo.ts'
import { DEFAULT_MAX_TOKENS, DEFAULT_MODELS, defaultMaxTokens, ModelConfig } from '../src/config.ts'
import { ANTHROPIC_BASE_URL, CODEX_BASE_URL } from '../src/auth/models.ts'
import { catalogEntries } from '../src/llm/catalog.ts'
import { modelResponse, textPart } from '../src/llm/messages.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, testConfig, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

async function recordsOf(cfg: ModelConfig) {
  const config = { ...testConfig([cfg]), default_model: cfg.id }
  state = await appState({ config, models: { [cfg.id]: scriptedModel(() => modelResponse([textPart('ok')])) } })
  const { session } = await openSession(state, buggyRepo(), cfg.id)
  const run = await waitDone(state, (await state.runs.start(session, 'hi')).id)
  return {
    entry: catalogEntries(config).find((e) => e.id === cfg.id)!,
    started: repo.listEvents(state.conn, run.id).find((e) => e.event === 'run_started')!.data,
    snapshot: run.model_config_snapshot as Record<string, unknown>,
    manifest: run.manifest.model as Record<string, unknown>,
    requests: repo.listModelRequests(state.conn, run.id),
  }
}

test('a Codex sign-in run records the Codex endpoint and no key variable', async () => {
  const sol = new ModelConfig({ id: 'openai:gpt-6.1-sol', provider: 'openai', model: 'gpt-6.1-sol', auth: 'oauth', context_window: 272_000 })
  const r = await recordsOf(sol)
  expect(r.entry.endpoint).toBe(CODEX_BASE_URL)
  expect(r.started.endpoint).toBe(CODEX_BASE_URL)
  expect(r.snapshot.endpoint).toBe(CODEX_BASE_URL)
  expect(r.snapshot.api_key_env).toBeNull()
  expect(r.manifest.endpoint).toBe(CODEX_BASE_URL)
  expect(r.manifest.credential_env).toBeNull()
  expect(r.requests.length).toBeGreaterThan(0)
  expect(r.requests.every((q) => q.endpoint === CODEX_BASE_URL)).toBe(true)
})

test('a Claude sign-in run records the Claude endpoint, whatever base_url the row carries', async () => {
  const opus = new ModelConfig({ id: 'anthropic:claude-x', provider: 'anthropic', model: 'claude-x', auth: 'oauth', base_url: 'https://proxy.example' })
  const r = await recordsOf(opus)
  expect(r.started.endpoint).toBe(ANTHROPIC_BASE_URL)
  expect(r.snapshot.endpoint).toBe(ANTHROPIC_BASE_URL)
  expect(r.snapshot.api_key_env).toBeNull()
  expect(r.requests.every((q) => q.endpoint === ANTHROPIC_BASE_URL)).toBe(true)
})

test('a key route records its configured endpoint and key variable, as the catalogue shows them', async () => {
  const api = new ModelConfig({ id: 'openai-api:gpt-x', provider: 'openai', model: 'gpt-x', api_key_env: 'MY_OPENAI_KEY', base_url: 'https://compat.example/v1' })
  const r = await recordsOf(api)
  expect(r.entry.endpoint).toBe('https://compat.example/v1')
  expect(r.started.endpoint).toBe('https://compat.example/v1')
  expect(r.snapshot.endpoint).toBe('https://compat.example/v1')
  expect(r.snapshot.api_key_env).toBe('MY_OPENAI_KEY')
  expect(r.manifest.credential_env).toBe('MY_OPENAI_KEY')
  expect(r.requests.every((q) => q.endpoint === 'https://compat.example/v1')).toBe(true)
})

test("a route's output cap: a quarter of a known window between 16K and 64K, 16K for an unknown one, unless its config says", () => {
  const route = (provider: 'anthropic' | 'openai' | 'google', extra: { max_tokens?: number; context_window?: number } = {}) =>
    new ModelConfig({ id: `${provider}:x`, label: 'x', provider, model: 'x', ...extra })
  for (const provider of ['anthropic', 'openai', 'google'] as const) {
    expect(route(provider).max_tokens, provider).toBe(16_000)
    expect(route(provider, { context_window: 1_000_000 }).max_tokens, provider).toBe(64_000)
  }
  expect(route('openai', { context_window: 200_000 }).max_tokens).toBe(50_000)
  expect(route('google', { context_window: 32_000 }).max_tokens).toBe(16_000)
  expect(route('anthropic', { max_tokens: 8_000, context_window: 1_000_000 }).max_tokens).toBe(8_000)
  expect(defaultMaxTokens(null)).toBe(16_000)
  expect(DEFAULT_MAX_TOKENS).toBe(64_000)
  // every built-in Claude route names the model's own output cap (the API's 128,000), above the window's default
  for (const m of DEFAULT_MODELS.filter((d) => d.provider === 'anthropic')) {
    const config = new ModelConfig(m as ConstructorParameters<typeof ModelConfig>[0])
    expect(config.max_tokens, config.id).toBe(128_000)
  }
})
