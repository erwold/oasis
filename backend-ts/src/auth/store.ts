/** Private, atomic credential storage and cross-process refresh coordination (carried from oasis auth/store.py).
 *  The store is one JSON file (mode 0600 in a 0700 directory) holding OAuth grants and saved API keys; writes go
 *  through a temp file and a rename under a lock file, so two processes never interleave a refresh. */

import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync, constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { LoginRequired, NativeAuthError, NativeAuthTemporaryError } from './errors.ts'

export { LoginRequired, NativeAuthError, NativeAuthTemporaryError }

export const PROVIDERS = ['openai-codex', 'anthropic', 'antigravity'] as const
export type OAuthProvider = (typeof PROVIDERS)[number]
export const PROVIDER_FOR_PREFIX: Record<string, OAuthProvider> = { openai: 'openai-codex', anthropic: 'anthropic', antigravity: 'antigravity' }
export const MIN_VALIDITY_MS = 300_000
export const REFRESH_TIMEOUT_MS = 35_000
export const LOCK_TIMEOUT_MS = 60_000
/** A lock file that names no owner and is older than this was left by a process that died holding it. */
const STALE_LOCK_MS = 120_000
export const LOGIN_HINT = 'sign in on the Accounts page, or run: bun run auth login {provider}'

export function nowMs(): number { return Date.now() }

export interface OAuthCredentialFields {
  access: string
  refresh: string
  expires_ms: number
  authorization_id?: string | null
  tier_id?: string | null
  project_id?: string | null
  account_id?: string | null
  email?: string | null
  authorized_at_ms?: number | null
  disabled_reason?: string | null
}

/** One OAuth grant; `access` and `refresh` never appear in its public form or in a string of it. */
export class OAuthCredential {
  readonly access: string
  readonly refresh: string
  readonly expires_ms: number
  readonly authorization_id: string | null
  readonly tier_id: string | null
  readonly project_id: string | null
  readonly account_id: string | null
  readonly email: string | null
  readonly authorized_at_ms: number | null
  readonly disabled_reason: string | null

  constructor(fields: OAuthCredentialFields) {
    this.access = fields.access
    this.refresh = fields.refresh
    this.expires_ms = fields.expires_ms
    this.authorization_id = fields.authorization_id ?? null
    this.tier_id = fields.tier_id ?? null
    this.project_id = fields.project_id ?? null
    this.account_id = fields.account_id ?? null
    this.email = fields.email ?? null
    this.authorized_at_ms = fields.authorized_at_ms ?? null
    this.disabled_reason = fields.disabled_reason ?? null
    // the secrets are not enumerable: JSON.stringify and console output leave them out
    Object.defineProperty(this, 'access', { value: fields.access, enumerable: false, writable: false })
    Object.defineProperty(this, 'refresh', { value: fields.refresh, enumerable: false, writable: false })
  }

  with(changes: Partial<OAuthCredentialFields>): OAuthCredential {
    return new OAuthCredential({ ...this.fields(), ...changes })
  }

  fields(): OAuthCredentialFields {
    return {
      access: this.access, refresh: this.refresh, expires_ms: this.expires_ms, project_id: this.project_id, tier_id: this.tier_id, authorization_id: this.authorization_id, account_id: this.account_id, email: this.email,
      authorized_at_ms: this.authorized_at_ms, disabled_reason: this.disabled_reason,
    }
  }

  expiresWithin(ms: number, now: number = nowMs()): boolean {
    return now + ms >= this.expires_ms
  }

  public(): Record<string, unknown> {
    return {
      expires_ms: this.expires_ms, account_id: this.account_id, email: this.email, authorized_at_ms: this.authorized_at_ms,
      disabled_reason: this.disabled_reason,
    }
  }

  /** The entry as the store file keeps it (the only place the secrets are written). */
  stored(): Record<string, unknown> {
    return { type: 'oauth', ...this.fields() }
  }

  /** JSON.stringify never sees the secrets. */
  toJSON(): Record<string, unknown> {
    return this.public()
  }

  toString(): string {
    return `OAuthCredential(account_id=${this.account_id}, email=${this.email}, expires_ms=${this.expires_ms})`
  }

  equals(other: OAuthCredential | null): boolean {
    return other !== null && JSON.stringify(this.fields()) === JSON.stringify(other.fields())
  }

  static fromJson(data: Record<string, unknown>): OAuthCredential {
    for (const k of ['access', 'refresh']) {
      if (typeof data[k] !== 'string' || !data[k]) throw new NativeAuthError('invalid credential token fields; sign in again')
    }
    if (!Number.isInteger(data.expires_ms) || (data.expires_ms as number) <= 0) {
      throw new NativeAuthError('invalid credential expiration; sign in again')
    }
    for (const k of ['account_id', 'email', 'disabled_reason', 'project_id', 'authorization_id', 'tier_id']) {
      if (data[k] !== undefined && data[k] !== null && typeof data[k] !== 'string') {
        throw new NativeAuthError('invalid credential metadata; sign in again')
      }
    }
    if (data.authorized_at_ms !== undefined && data.authorized_at_ms !== null && !Number.isInteger(data.authorized_at_ms)) {
      throw new NativeAuthError('invalid credential authorization time; sign in again')
    }
    return new OAuthCredential({
      access: data.access as string, refresh: data.refresh as string, expires_ms: data.expires_ms as number,
      authorization_id: (data.authorization_id as string | null | undefined) ?? null,
      tier_id: (data.tier_id as string | null | undefined) ?? null,
      project_id: (data.project_id as string | null | undefined) ?? null,
      account_id: (data.account_id as string | null | undefined) ?? null, email: (data.email as string | null | undefined) ?? null,
      authorized_at_ms: (data.authorized_at_ms as number | null | undefined) ?? null,
      disabled_reason: (data.disabled_reason as string | null | undefined) ?? null,
    })
  }
}

export type ModifyFn = (current: OAuthCredential | null) => Promise<OAuthCredential | null>
export type Refresher = (refreshToken: string) => Promise<OAuthCredential>

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

interface LockOwner { pid: number; nonce: string }

function sameOwner(a: LockOwner | null, b: LockOwner | null): boolean {
  return a === null ? b === null : b !== null && a.nonce === b.nonce
}

/** Whether a process runs under `pid` (one of another user's counts: signalling it is refused, not unknown). */
function processAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class CredentialStore {
  readonly path: string
  private readonly lockPath: string

  constructor(path: string) {
    this.path = resolve(path)
    this.lockPath = join(dirname(this.path), basename(this.path) + '.lock')
  }

  private load(): Record<string, unknown> {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return {}
      throw new NativeAuthError('could not read auth store; check its format and permissions')
    }
    let data: unknown
    try { data = JSON.parse(text) } catch { throw new NativeAuthError('could not read auth store; check its format and permissions') }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new NativeAuthError('auth store must be a JSON object')
    return data as Record<string, unknown>
  }

  read(provider: string): OAuthCredential | null {
    const entry = this.load()[provider]
    if (entry === undefined || entry === null) return null
    if (!entry || typeof entry !== 'object' || (entry as { type?: string }).type !== 'oauth') {
      throw new NativeAuthError(`invalid ${provider} credential; sign in again`)
    }
    return OAuthCredential.fromJson(entry as Record<string, unknown>)
  }

  list(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {}
    for (const p of PROVIDERS) {
      const grant = this.read(p)
      if (grant !== null) out[p] = grant.public()
    }
    return out
  }

  // -- API keys: `{"type": "api_key", "key": ...}` under the key provider's id --

  readApiKeyEntry(provider: string): Record<string, unknown> | null {
    const entry = this.load()[provider]
    if (entry === undefined || entry === null) return null
    const e = entry as { type?: string; key?: unknown }
    if (!entry || typeof entry !== 'object' || e.type !== 'api_key' || typeof e.key !== 'string') {
      throw new NativeAuthError(`invalid ${provider} key entry; save the key again`)
    }
    return entry as Record<string, unknown>
  }

  readApiKey(provider: string): string | null {
    const entry = this.readApiKeyEntry(provider)
    return entry ? ((entry.key as string) || null) : null
  }

  /** Every api-key entry, keyed by provider id (label and env travel with a custom one). */
  apiKeyEntries(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {}
    for (const [name, entry] of Object.entries(this.load())) {
      const e = entry as { type?: string; key?: unknown } | null
      if (e && typeof e === 'object' && e.type === 'api_key' && typeof e.key === 'string') out[name] = entry as Record<string, unknown>
    }
    return out
  }

  /** `check` sees the entries as they are under the lock, right before the write, and may refuse it by throwing:
   *  a rule across entries (two custom keys never share an env name) holds however many writers race. */
  async setApiKey(provider: string, key: string, fields: Record<string, string> = {}, check?: (entries: Record<string, unknown>) => void): Promise<void> {
    await this.locked(async () => {
      const data = this.load()
      check?.(data)
      data[provider] = { type: 'api_key', key, ...fields }
      this.write(data)
    })
  }

  async deleteApiKey(provider: string): Promise<boolean> {
    return this.locked(async () => {
      const data = this.load()
      const entry = data[provider] as { type?: string } | undefined
      if (!entry || typeof entry !== 'object' || entry.type !== 'api_key') return false
      delete data[provider]
      this.write(data)
      return true
    })
  }

  private write(data: Record<string, unknown>): void {
    const sorted = Object.fromEntries(Object.keys(data).sort().map((k) => [k, data[k]]))
    const name = join(dirname(this.path), `.auth-${process.pid}-${Math.random().toString(16).slice(2, 10)}`)
    const fd = openSync(name, 'w', 0o600)
    try {
      writeSync(fd, JSON.stringify(sorted, null, 2))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      renameSync(name, this.path)
    } finally {
      try { unlinkSync(name) } catch { /* renamed */ }
    }
  }

  /** The lock file's owner as it wrote itself there, or null while it is empty or unreadable. */
  private lockOwner(): LockOwner | null {
    try {
      const owner = JSON.parse(readFileSync(this.lockPath, 'utf8')) as Partial<LockOwner>
      return Number.isInteger(owner.pid) && typeof owner.nonce === 'string' ? { pid: owner.pid!, nonce: owner.nonce } : null
    } catch {
      return null
    }
  }

  /** Whether the lock in place may be taken over: its owner's process is gone — never while that process runs,
   *  however long it has held the lock (a machine asleep, a process stopped); a lock that names no owner (one being
   *  written, or left by an older build) only once it is older than STALE_LOCK_MS. */
  private abandoned(owner: LockOwner | null): boolean {
    if (owner !== null) return !processAlive(owner.pid)
    return Date.now() - statSync(this.lockPath).mtimeMs > STALE_LOCK_MS
  }

  /** Run `fn` holding the store's lock file (O_EXCL, with this process's pid and a nonce in it). A lock whose owner
   *  died is taken over; a holder removes only the lock that is still its own. */
  async locked<T>(fn: () => Promise<T>): Promise<T> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    const nonce = randomBytes(12).toString('hex')
    let fd: number | null = null
    while (fd === null) {
      try {
        const opened = openSync(this.lockPath, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
        try {
          writeSync(opened, JSON.stringify({ pid: process.pid, nonce }))
        } catch (error) {
          closeSync(opened)
          try { unlinkSync(this.lockPath) } catch { /* gone */ }
          throw error
        }
        fd = opened
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error
        try {
          const owner = this.lockOwner()
          // read again right before the unlink: a waiter that took the dead lock over first has put its own there
          if (this.abandoned(owner) && sameOwner(owner, this.lockOwner())) { unlinkSync(this.lockPath); continue }
        } catch { /* gone between the checks */ }
        if (Date.now() > deadline) throw new NativeAuthError('timed out waiting for the auth store lock')
        await sleep(50)
      }
    }
    try {
      return await fn()
    } finally {
      closeSync(fd)
      if (this.lockOwner()?.nonce === nonce) {
        try { unlinkSync(this.lockPath) } catch { /* gone */ }
      }
    }
  }

  async modify(provider: string, fn: ModifyFn): Promise<OAuthCredential | null> {
    if (!(PROVIDERS as readonly string[]).includes(provider)) throw new NativeAuthError(`unsupported OAuth provider: ${provider}`)
    return this.locked(async () => {
      const current = this.read(provider)
      const updated = await fn(current)
      if (updated === null) return current
      // fn may take long (a refresh over the network): a grant another writer stored meanwhile is newer than what
      // fn made from the one read before, and stays
      const latest = this.read(provider)
      if (latest === null ? current !== null : !latest.equals(current)) return latest
      const data = this.load()
      data[provider] = updated.stored()
      this.write(data)
      return updated
    })
  }

  async delete(provider: string): Promise<boolean> {
    return this.locked(async () => {
      const data = this.load()
      if (!Object.hasOwn(data, provider)) return false
      delete data[provider]
      this.write(data)
      return true
    })
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutSignal()), ms)
    promise.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

class TimeoutSignal extends Error { constructor() { super('timeout'); this.name = 'TimeoutSignal' } }

export class TokenManager {
  constructor(readonly store: CredentialStore, readonly refreshers: Record<string, Refresher>, private readonly clock: () => number = nowMs) {}

  private static require(provider: string, grant: OAuthCredential | null): OAuthCredential {
    if (grant === null || grant.disabled_reason) {
      throw new LoginRequired(`no usable ${provider} login; ` + LOGIN_HINT.replace('{provider}', provider))
    }
    return grant
  }

  async access(provider: string): Promise<OAuthCredential> {
    const current = TokenManager.require(provider, this.store.read(provider))
    if (!current.expiresWithin(MIN_VALIDITY_MS, this.clock())) return current
    const refreshIfStale: ModifyFn = async (storedOrNull) => {
      const stored = TokenManager.require(provider, storedOrNull)
      if (!stored.expiresWithin(MIN_VALIDITY_MS, this.clock())) return null
      const refresher = this.refreshers[provider]
      if (refresher === undefined) throw new NativeAuthError(`no refresh flow for ${provider}`)
      let fresh: OAuthCredential
      try {
        fresh = await withTimeout(refresher(stored.refresh), REFRESH_TIMEOUT_MS)
      } catch (error) {
        // commit the terminal state while still holding the lock, so every other process stops retrying the grant
        if (error instanceof LoginRequired) return stored.with({ disabled_reason: 'login_required' })
        if (error instanceof TimeoutSignal) throw new NativeAuthTemporaryError(`${provider} token refresh timed out`)
        throw error
      }
      return fresh.with({
        authorization_id: stored.authorization_id,
        tier_id: fresh.tier_id || stored.tier_id,
        project_id: fresh.project_id || stored.project_id,
        account_id: fresh.account_id || stored.account_id, email: fresh.email || stored.email,
        authorized_at_ms: stored.authorized_at_ms || fresh.authorized_at_ms,
      })
    }
    return TokenManager.require(provider, await this.store.modify(provider, refreshIfStale))
  }
}

// ---- the process-wide store -------------------------------------------------------------------------------

let defaultDir: string | null = null
const stores = new Map<string, CredentialStore>()
const managers = new Map<string, TokenManager>()
const dirListeners: (() => void)[] = []

/** The app sets its data directory here at startup so every caller of credentialStore() / tokenManager() shares one store. */
export function setDefaultAuthDir(path: string | null): void {
  defaultDir = path === null ? null : resolve(path.startsWith('~') ? join(homedir(), path.slice(1)) : path)
  stores.clear()
  managers.clear()
  for (const listener of dirListeners) listener()
}

/** Called whenever the default store changes: what this process took from the previous store (the custom keys it
 *  exported into its environment) is withdrawn; the store stays a leaf, so the key module registers itself here. */
export function onDefaultAuthDirChange(listener: () => void): void {
  dirListeners.push(listener)
}

export function defaultAuthDir(): string {
  if (defaultDir !== null) return defaultDir
  const explicit = process.env.OASIS_CODE_AUTH_DIR || process.env.OASIS_CODE_DATA
  const raw = explicit || '~/.oasis-code'
  return resolve(raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw)
}

export function credentialStore(path?: string | null): CredentialStore {
  const dir = resolve(path || defaultAuthDir())
  let store = stores.get(dir)
  if (!store) {
    store = new CredentialStore(join(dir, 'auth.json'))
    stores.set(dir, store)
  }
  return store
}

/** The refresh flows are registered by the OAuth modules (they import this one), so the store stays a leaf. */
const refreshers: Record<string, Refresher> = {}

export function registerRefresher(provider: string, refresher: Refresher): void {
  refreshers[provider] = refresher
  managers.clear()
}

export function tokenManager(path?: string | null): TokenManager {
  const dir = resolve(path || defaultAuthDir())
  let manager = managers.get(dir)
  if (!manager) {
    manager = new TokenManager(credentialStore(dir), refreshers)
    managers.set(dir, manager)
  }
  return manager
}

/** Drop the cached stores (tests point the default directory somewhere else between cases). */
export function resetStores(): void {
  stores.clear()
  managers.clear()
}

export function storeFileExists(path?: string | null): boolean {
  return existsSync(credentialStore(path).path)
}
