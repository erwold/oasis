/** Minimal real app for the Accounts acceptance test: one listener, fresh data, no model calls or OAuth. */
import { readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DEFAULT_MODELS, ModelConfig, Settings } from '../../backend-ts/src/config.ts'
import { credentialStore, OAuthCredential, setDefaultAuthDir } from '../../backend-ts/src/auth/store.ts'
import { refreshCatalog } from '../../backend-ts/src/auth/antigravity_catalog.ts'
import { createApp } from '../../backend-ts/src/main.ts'
import { testConfig } from '../../backend-ts/tests/harness.ts'
import { installNetworkGuard } from '../../backend-ts/tests/network_guard.ts'

// The parent creates and owns this empty directory, supplies a private HOME, and removes both after exit.
// Do not fall back to the user's data directory if this fixture was invoked incorrectly.
const data = process.env.OASIS_CODE_DATA
if (!data || !process.env.OASIS_CODE_AUTH_DIR || resolve(data) !== resolve(process.env.OASIS_CODE_AUTH_DIR)) {
  throw new Error('Accounts fixture requires an explicit isolated data/auth directory')
}
// Refuse reused/non-fixture data before createApp can open any database or credential file. The parent owns this
// newly created empty directory; the explicit store selection below never falls back to the user's auth store.
const root = process.env.OASIS_CODE_E2E_ROOT
if (!root || !basename(root).startsWith('antigravity-accounts-') || resolve(data) !== join(resolve(root), 'data')
  || dirname(realpathSync(data)) !== realpathSync(root) || readdirSync(data).length !== 0) {
  throw new Error('Accounts fixture requires its own fresh, empty temporary data directory')
}
setDefaultAuthDir(data)
installNetworkGuard()
const withModels = process.argv.includes('--models')
const config = testConfig()
if (withModels) {
  const google = DEFAULT_MODELS.find((model) => model.id === 'google:gemini-4-argon')
  if (!google) throw new Error('The existing Gemini API route must remain in the default catalog')
  config.models.push(new ModelConfig(google))
  config.default_model = 'google:gemini-4-argon'
}
const app = await createApp(new Settings({ data_dir: data, host: '127.0.0.1', port: 8399, session_token: 'e2e-token' }), config, { probe: false })
// Provider-side synthetic discovery, not an HTTP replacement for /api/models: production catalog parsing,
// auth gating and API serialization run. Inference, OAuth and all other external requests stay blocked.
const upstreams = [
  ...['gemini-4-argon', 'gemini-3.8-flash', 'claude-opus-5-5', 'claude-sonnet-5-5']
    .flatMap((family) => ['low', 'medium', 'high'].map((effort) => `${family}-${effort}`)),
  'gpt-oss-120b-medium',
]
const catalog = async (input: string | URL | Request): Promise<Response> => {
  if (!String(input).endsWith(':fetchAvailableModels')) throw new Error('Unexpected fixture provider request')
  return Response.json({ models: Object.fromEntries(upstreams.map((id) => [id, {
    maxTokens: 1048576, maxOutputTokens: 65536, supportsThinking: true, supportsImages: true,
  }])) })
}
if (withModels) {
  await credentialStore(data).modify('antigravity', async () => new OAuthCredential({
    access: 'synthetic-access', refresh: 'synthetic-refresh', expires_ms: Date.now() + 3600_000,
    project_id: 'synthetic-project', account_id: 'synthetic-account', authorization_id: 'synthetic-generation', authorized_at_ms: 1,
  }))
  process.env.GEMINI_API_KEY = 'synthetic-gemini-e2e-key'
  await refreshCatalog(catalog)
}
try {
  await app.start()
  const server = Bun.serve({ hostname: '127.0.0.1', port: 8399, idleTimeout: 255, fetch: async (request, server) => {
    // A slow browser refreshes the same production cache before the real /api/models endpoint reads it.
    if (withModels && new URL(request.url).pathname === '/api/models') await refreshCatalog(catalog)
    return app.fetch(request, server)
  } })
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    server.stop(true)
    await app.close()
    process.exit(0)
  }
  process.once('SIGTERM', () => { void stop() })
  process.once('SIGINT', () => { void stop() })
  console.log('ANTIGRAVITY_ACCOUNTS_READY')
} catch (error) {
  await app.close()
  throw error
}
