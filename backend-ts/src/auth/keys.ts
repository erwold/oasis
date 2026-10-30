/** API keys saved from the page. A key the person saves lives in the harness's own store next to the OAuth grants,
 *  under the environment variable name a model route reads; it wins over the environment, and the environment
 *  keeps working for machines set up the old way. Custom providers name a service the catalogue does not know:
 *  their key is exported into this process's environment under the env name the person chose. Carried from oasis
 *  auth/keys.py, re-pointed at model routes. */

import { NativeAuthError } from './errors.ts'
import { credentialStore, onDefaultAuthDirChange } from './store.ts'

export interface KeyProviderInfo { label: string; env: string; unlocks: string; docs: string }

// provider id -> where its key comes from and what it unlocks (shown on the page, in this order)
export const KEY_PROVIDERS: Record<string, KeyProviderInfo> = {
  'anthropic-api': { label: 'Anthropic API', env: 'ANTHROPIC_API_KEY', unlocks: 'Claude models on the pay-as-you-go API', docs: 'https://console.anthropic.com/settings/keys' },
  'openai-api': { label: 'OpenAI API', env: 'OPENAI_API_KEY', unlocks: 'GPT models on the pay-as-you-go API', docs: 'https://platform.openai.com/api-keys' },
  gemini: { label: 'Google Gemini', env: 'GEMINI_API_KEY', unlocks: 'Gemini models on the Gemini API', docs: 'https://aistudio.google.com/apikey' },
  deepseek: { label: 'DeepSeek', env: 'DEEPSEEK_API_KEY', unlocks: 'DeepSeek models and Search on the standard API', docs: 'https://platform.deepseek.com/api_keys' },
  zhipu: { label: 'Zhipu BigModel', env: 'ZHIPU_API_KEY', unlocks: 'GLM models on the standard API (not Coding Plan)', docs: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys' },
}
export const PAGE_HIDDEN = new Set<string>()
export const MIN_KEY_LENGTH = 8
export const MAX_KEY_LENGTH = 512
const CUSTOM_ID = /^[a-z][a-z0-9-]{1,31}$/
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/
export const MAX_LABEL_LENGTH = 40
export const RESERVED_IDS = new Set<string>([...Object.keys(KEY_PROVIDERS), 'openai-codex', 'anthropic', 'antigravity'])
// env names this process exported from custom keys (never the shell's own): these it may replace or drop
const EXPORTED = new Set<string>()

/** A built-in key provider: an own name of KEY_PROVIDERS, never one it inherits (constructor, toString, ...). */
function isBuiltin(provider: string): boolean {
  return Object.hasOwn(KEY_PROVIDERS, provider)
}

/** The custom provider on record under this id, if any (an own entry only). */
function customProvider(provider: string): { label: string; env: string } | undefined {
  const custom = customProviders()
  return Object.hasOwn(custom, provider) ? custom[provider] : undefined
}

export type KeySource = 'stored' | 'env' | null

/** A pasted key, trimmed: printable ASCII without spaces, a sane length. */
export function validate(key: string): string {
  const value = key.trim()
  if (value.length < MIN_KEY_LENGTH || value.length > MAX_KEY_LENGTH) {
    throw new NativeAuthError(`a key is ${MIN_KEY_LENGTH} to ${MAX_KEY_LENGTH} characters`)
  }
  if (/\s/.test(value) || !/^[\x21-\x7e]+$/.test(value)) throw new NativeAuthError('a key is one printable ASCII token without spaces')
  return value
}

/** What the page shows for a saved key: the first characters only when the key is long enough that they give
 *  nothing away, then the last four. */
export function mask(key: string): string {
  if (key.length < MIN_KEY_LENGTH) return '••••'
  const head = key.length > 12 ? key.slice(0, 3) : ''
  return `${head}…${key.slice(-4)}`
}

/** The custom providers on record: id -> {label, env}. */
export function customProviders(): Record<string, { label: string; env: string }> {
  const out: Record<string, { label: string; env: string }> = {}
  for (const [name, entry] of Object.entries(credentialStore().apiKeyEntries())) {
    if (isBuiltin(name)) continue
    const label = entry.label
    const env = entry.env
    if (typeof label === 'string' && typeof env === 'string' && ENV_NAME.test(env)) out[name] = { label, env }
  }
  return out
}

export function storedKey(provider: string): string | null {
  if (!isBuiltin(provider) && customProvider(provider) === undefined) throw new NativeAuthError(`unknown key provider '${provider}'`)
  return credentialStore().readApiKey(provider)
}

export function envName(provider: string): string {
  if (isBuiltin(provider)) return KEY_PROVIDERS[provider]!.env
  const custom = customProvider(provider)
  if (custom === undefined) throw new NativeAuthError(`unknown key provider '${provider}'`)
  return custom.env
}

/** [key, "stored" | "env" | null]: the saved key first, the environment second. */
export function keyWithSource(provider: string): [string | null, KeySource] {
  const saved = storedKey(provider)
  if (saved) return [saved, 'stored']
  const name = envName(provider)
  const value = process.env[name]
  return value && !EXPORTED.has(name) ? [value, 'env'] : [null, null]
}

/** The key provider (built-in or custom) whose key is read from `env`, if any. */
export function providerForEnv(env: string): string | null {
  for (const [provider, info] of Object.entries(KEY_PROVIDERS)) if (info.env === env) return provider
  for (const [provider, custom] of Object.entries(customProviders())) if (custom.env === env) return provider
  return null
}

/** The credential a model route reading `env` gets: a key saved on the page under that name first, the
 *  environment's variable second; [key, "stored" | "env" | null]. */
export function keyForEnv(env: string): [string | null, KeySource] {
  const provider = providerForEnv(env)
  if (provider !== null) {
    try { return keyWithSource(provider) } catch (error) { if (!(error instanceof NativeAuthError)) throw error }
  }
  // a variable this process exported that no provider of the current store owns is not the environment's
  if (EXPORTED.has(env)) return [null, null]
  const value = process.env[env]
  return value ? [value, 'env'] : [null, null]
}

/** The variables this process set from the keys saved in Accounts (exportEnvironment): the harness's own copies of
 *  keys, never part of the environment the person started it with — a Full access command does not inherit them. */
export function harnessExportedKeyNames(): string[] {
  return [...EXPORTED]
}

/** Bring this process's environment in line with the store: every custom key is exported under its env name
 *  unless the shell set that name, and every name exported before that no custom key owns any more (a provider
 *  renamed or forgotten, another store's) is removed — only ever a name this process set itself. Where an older
 *  store has two custom keys on one env name, the first owns it, as providerForEnv says. Reads the store afresh, so
 *  the last call after racing saves and forgets leaves the environment as the store ended up. */
export function exportEnvironment(): string[] {
  const wanted = new Map<string, string>()
  // a name a built-in reads, or one an earlier custom key took, is not this one's (the order providerForEnv reads)
  const taken = new Set<string>(Object.values(KEY_PROVIDERS).map((info) => info.env))
  const store = credentialStore()
  for (const [name, custom] of Object.entries(customProviders())) {
    if (taken.has(custom.env)) continue
    taken.add(custom.env)
    const key = store.readApiKey(name)
    if (key && (!Object.hasOwn(process.env, custom.env) || EXPORTED.has(custom.env))) wanted.set(custom.env, key)
  }
  for (const env of [...EXPORTED]) {
    if (!wanted.has(env)) withdraw(env)
  }
  for (const [env, key] of wanted) {
    process.env[env] = key
    EXPORTED.add(env)
  }
  return [...wanted.keys()]
}

function withdraw(env: string): void {
  delete process.env[env]
  EXPORTED.delete(env)
}

// another store's keys are not this process's to carry: withdrawn when the default store changes (the app exports
// the new store's at once, exportEnvironment)
onDefaultAuthDirChange(() => { for (const env of [...EXPORTED]) withdraw(env) })

export function providerKey(provider: string): string | null {
  return keyWithSource(provider)[0]
}

export interface KeyRow {
  provider: string; label: string; env: string; unlocks: string; docs: string; source: KeySource; hint: string | null; custom: boolean
}

/** One row per key provider for the page, built-ins then custom ones: never the key itself. */
export function keyRows(): KeyRow[] {
  const rows: KeyRow[] = []
  for (const [provider, info] of Object.entries(KEY_PROVIDERS)) {
    if (PAGE_HIDDEN.has(provider)) continue
    const [key, source] = keyWithSource(provider)
    rows.push({ provider, label: info.label, env: info.env, unlocks: info.unlocks, docs: info.docs, source, hint: key ? mask(key) : null, custom: false })
  }
  for (const [provider, custom] of Object.entries(customProviders())) {
    const [key, source] = keyWithSource(provider)
    rows.push({
      provider, label: custom.label, env: custom.env,
      unlocks: `exported as ${custom.env}; a model route with api_key_env=${custom.env} reads it`, docs: '', source,
      hint: key ? mask(key) : null, custom: true,
    })
  }
  return rows
}

export function validateCustom(provider: string, label: string | null | undefined, env: string | null | undefined): [string, string] {
  if (RESERVED_IDS.has(provider) || !CUSTOM_ID.test(provider)) {
    throw new NativeAuthError('a custom provider id is 2 to 32 lowercase letters, digits or dashes, and not a built-in')
  }
  const labelValue = (label ?? '').trim()
  const envValue = (env ?? '').trim()
  if (!labelValue || labelValue.length > MAX_LABEL_LENGTH) {
    throw new NativeAuthError(`a custom provider needs a name of at most ${MAX_LABEL_LENGTH} characters`)
  }
  if (!ENV_NAME.test(envValue)) throw new NativeAuthError('an env name is uppercase letters, digits and underscores, like REPLICATE_API_TOKEN')
  if (Object.values(KEY_PROVIDERS).some((info) => info.env === envValue)) throw new NativeAuthError(`${envValue} belongs to a built-in provider`)
  return [labelValue, envValue]
}

export async function saveKey(provider: string, key: string, opts: { label?: string | null; env?: string | null } = {}): Promise<{ provider: string; source: 'stored'; hint: string }> {
  const value = validate(key)
  const store = credentialStore()
  if (isBuiltin(provider)) {
    await store.setApiKey(provider, value)
  } else {
    const existing = customProvider(provider)
    if (existing === undefined && opts.label == null && opts.env == null) throw new NativeAuthError(`unknown key provider '${provider}'`)
    const [label, env] = validateCustom(provider, opts.label ?? existing?.label, opts.env ?? existing?.env)
    try {
      await store.setApiKey(provider, value, { label, env }, (entries) => refuseSharedEnv(entries, provider, env))
    } finally {
      // whatever this save did or did not change, the environment follows the store
      exportEnvironment()
    }
  }
  return { provider, source: 'stored', hint: mask(value) }
}

/** Two custom providers never read one env name: taking a name another custom key holds is refused (checked under
 *  the store's lock, so of two racing saves one wins). A provider an older store already left on a shared name may
 *  still save its key there. */
function refuseSharedEnv(entries: Record<string, unknown>, provider: string, env: string): void {
  const own = Object.hasOwn(entries, provider) ? entries[provider] as { env?: unknown } | null : null
  if (own && typeof own === 'object' && own.env === env) return
  for (const [other, entry] of Object.entries(entries)) {
    if (other === provider || isBuiltin(other) || !entry || typeof entry !== 'object') continue
    const e = entry as { type?: unknown; env?: unknown }
    if (e.type === 'api_key' && e.env === env) throw new NativeAuthError(`${env} is already the env of the custom provider '${other}'`)
  }
}

export async function forgetKey(provider: string): Promise<boolean> {
  if (isBuiltin(provider)) return credentialStore().deleteApiKey(provider)
  if (customProvider(provider) === undefined) throw new NativeAuthError(`unknown key provider '${provider}'`)
  try {
    return await credentialStore().deleteApiKey(provider)
  } finally {
    exportEnvironment()
  }
}
