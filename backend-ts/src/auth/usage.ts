/** Account quota snapshots (carried from oasis auth/usage.py). The harness's own grants are refreshed as needed; a
 *  CLIProxyAPI credential directory is read only when the operator names one (OASIS_CODE_USAGE_PROXY_AUTH_DIR) and
 *  is never written. */

import { authorizationKey, availableAntigravityModels } from './antigravity_catalog.ts'
import { ANTIGRAVITY_USER_AGENT, CONTROL_ENDPOINTS, control, reportedTierId, isRecord as agRecord } from './oauth_antigravity.ts'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expandUser } from '../config.ts'
import { safeFetch } from '../safe_fetch.ts'
import type { FetchLike } from './http.ts'
import { CLI_USER_AGENT } from './oauth_anthropic.ts'
import { accountIdFromToken } from './oauth_codex.ts'
import { LoginRequired, NativeAuthError, NativeAuthTemporaryError, PROVIDERS, tokenManager, type TokenManager } from './store.ts'

export const ENDPOINTS: Record<string, string> = {
  'openai-codex': 'https://chatgpt.com/backend-api/wham/usage',
  anthropic: 'https://api.anthropic.com/api/oauth/usage',
  antigravity: CONTROL_ENDPOINTS.fetchAvailableModels,
}
export const LABELS: Record<string, string> = { 'openai-codex': 'Codex', anthropic: 'Claude', antigravity: 'Antigravity' }
export const CACHE_SECONDS = 60
export const MAX_STALE_SECONDS = 900
// Anthropic rate-limits its usage endpoint hard and its windows are hours and days long: ask it every five minutes
// and keep the last good numbers for an hour, the countdowns run locally anyway.
export const POLL_SECONDS: Record<string, number> = { anthropic: 300 }
export const STALE_SECONDS: Record<string, number> = { anthropic: 3600 }
const MAX_TIMESTAMP = 253402300800

export const pollSeconds = (provider: string): number => POLL_SECONDS[provider] ?? CACHE_SECONDS
export const staleSeconds = (provider: string): number => STALE_SECONDS[provider] ?? MAX_STALE_SECONDS

export function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function timestamp(value: unknown): number | null {
  const numeric = number(value)
  if (numeric !== null) return numeric > 0 && numeric < MAX_TIMESTAMP ? numeric : null
  if (typeof value === 'string') {
    const text = value.replace(/Z$/, '+00:00')
    if (!/(?:[+-]\d{2}:?\d{2})$/.test(text)) return null
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? parsed / 1000 : null
  }
  return null
}

/** Seconds since the epoch as an ISO timestamp in UTC (`+00:00`, microseconds only when they are not zero). */
export function iso(value: number | null): string | null {
  if (value === null) return null
  const whole = Math.floor(value)
  const micros = Math.round((value - whole) * 1e6)
  const base = new Date(whole * 1000).toISOString().slice(0, 19)
  return `${base}${micros ? '.' + String(micros).padStart(6, '0') : ''}+00:00`
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : null
}

export interface QuotaWindow { id: string; label: string; used_percent: number | null; resets_at: string | null; window_seconds: number | null }

export function window(key: string, label: string, used: unknown, reset: unknown, seconds: unknown = null): QuotaWindow {
  const percent = number(used)
  return { id: key, label, used_percent: percent !== null && percent >= 0 ? percent : null, resets_at: iso(timestamp(reset)), window_seconds: number(seconds) }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

export function parseCodex(data: Record<string, unknown>, now: number): QuotaWindow[] {
  if (!['rate_limit', 'additional_rate_limits', 'plan_type'].some((k) => k in data)) throw new Error('unrecognized usage response')
  const result: QuotaWindow[] = []
  const addLimits = (raw: unknown, key: string, name = '') => {
    if (!isRecord(raw)) return
    for (const part of ['primary', 'secondary']) {
      const bucket = raw[`${part}_window`]
      if (!isRecord(bucket)) continue
      const duration = number(bucket.limit_window_seconds)
      // A primary window can be weekly. Never infer its length from its position.
      const label = duration === 18000 ? '5 hours' : duration === 604800 ? 'Weekly'
        : duration !== null && duration > 0 ? `${trimFloat(duration / 3600)} hours` : `${part[0]!.toUpperCase()}${part.slice(1)} window`
      let reset = timestamp(bucket.reset_at)
      const after = number(bucket.reset_after_seconds)
      if (reset === null && after !== null && after >= 0) reset = now + after
      result.push(window(`${key}:${part}`, name ? `${name} · ${label}` : label, bucket.used_percent, reset, duration))
    }
  }
  addLimits(data.rate_limit, 'codex')
  const extras = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : []
  extras.forEach((extra, i) => {
    if (!isRecord(extra)) return
    const name = text(extra.limit_name) || text(extra.metered_feature) || 'Model allowance'
    addLimits(extra.rate_limit, `extra:${i}`, name)
  })
  return result
}

/** Python's `%g` for a duration in hours: no trailing zeros. */
function trimFloat(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)))
}

export function parseClaude(data: Record<string, unknown>): QuotaWindow[] {
  if (!['five_hour', 'seven_day', 'limits'].some((k) => k in data)) throw new Error('unrecognized usage response')
  const result = new Map<string, QuotaWindow>()
  const known: [string, string, number][] = [
    ['five_hour', '5 hours', 18000], ['seven_day', 'Weekly', 604800], ['seven_day_opus', 'Opus · Weekly', 604800], ['seven_day_sonnet', 'Sonnet · Weekly', 604800],
  ]
  for (const [key, label, seconds] of known) {
    const bucket = data[key]
    if (isRecord(bucket)) result.set(key, window(key, label, bucket.utilization, bucket.resets_at, seconds))
  }
  const limits = Array.isArray(data.limits) ? data.limits : []
  for (const row of limits) {
    if (!isRecord(row)) continue
    const scope = row.scope
    const model = isRecord(scope) ? scope.model : null
    const name = isRecord(model) ? text(model.display_name) : null
    let key: string; let label: string; let seconds: number
    if (row.kind === 'session') { key = 'five_hour'; label = '5 hours'; seconds = 18000 }
    else if (row.kind === 'weekly_all') { key = 'seven_day'; label = 'Weekly'; seconds = 604800 }
    else if (row.kind === 'weekly_scoped' && name) { key = `seven_day_${name.toLowerCase()}`; label = `${name} · Weekly`; seconds = 604800 }
    else continue
    // is_active identifies the binding limit, not whether the bucket exists.
    const parsed = window(key, label, row.percent, row.resets_at, seconds)
    if (!result.has(key) || parsed.used_percent !== null) result.set(key, parsed)
  }
  return [...result.values()]
}

export class UsageAccount {
  constructor(
    readonly id: string, readonly provider: string, readonly source: 'harness' | 'proxy', readonly email: string | null = null,
    readonly access = '', readonly account_id: string | null = null, readonly expires_at: number | null = null, readonly error: string | null = null, readonly authorization_key: string | null = null,
  ) {
    Object.defineProperty(this, 'access', { value: access, enumerable: false })
    Object.defineProperty(this, 'account_id', { value: account_id, enumerable: false })
    Object.defineProperty(this, 'authorization_key', { value: authorization_key, enumerable: false })
  }

  get fingerprint(): string {
    return createHash('sha256').update(JSON.stringify([this.access, this.account_id, this.email, this.error, this.authorization_key])).digest('hex')
  }

  public(): Record<string, unknown> {
    return { id: this.id, provider: this.provider, label: LABELS[this.provider], source: this.source, account_label: this.email }
  }
}

export function proxyAccounts(directory: string | null): UsageAccount[] {
  if (directory === null) return []
  const result: UsageAccount[] = []
  let names: string[]
  try { names = readdirSync(directory) } catch { return [] }
  // Only the two known proxy credential filename families, never recursive or archived files.
  for (const [prefix, provider] of [['codex', 'openai-codex'], ['claude', 'anthropic']] as const) {
    for (const name of names.filter((n) => n.startsWith(prefix) && n.endsWith('.json')).sort()) {
      const path = join(directory, name)
      try { if (lstatSync(path).isSymbolicLink()) continue } catch { continue }
      const key = 'proxy:' + createHash('sha256').update(path).digest('hex').slice(0, 16)
      try {
        const data = JSON.parse(readFileSync(path, 'utf8')) as unknown
        if (!isRecord(data) || data.type !== prefix || data.disabled) continue
        const access = typeof data.access_token === 'string' ? data.access_token : ''
        let accountId = text(data.account_id)
        if (provider === 'openai-codex') accountId = accountId || accountIdFromToken(access)
        result.push(new UsageAccount(key, provider, 'proxy', text(data.email), access, accountId, timestamp(data.expired)))
      } catch {
        result.push(new UsageAccount(key, provider, 'proxy', null, '', null, null, 'credential_unreadable'))
      }
    }
  }
  return result
}

export const ERRORS: Record<string, string> = {
  login_required: 'Sign in again to read account usage.',
  not_connected: 'Sign in with OAuth to view subscription usage.',
  credential_unreadable: 'The account credential could not be read.',
  proxy_expired: 'The proxy access token has expired. Waiting for CLIProxyAPI to refresh it.',
  permission_denied: 'This login does not have access to account usage.',
  rate_limited: 'The provider is limiting usage checks. Retrying later.',
  unavailable: 'The provider could not be reached. Retrying later.',
  invalid_response: 'The provider returned an unrecognized usage response.',
}

interface CachedUsage { fingerprint: string; report: Record<string, unknown>; refresh_at: number; force_after: number }

/** A counting semaphore: at most `size` checks talk to the providers at once. */
class Capacity {
  private active = 0
  private readonly waiters: (() => void)[] = []
  constructor(private readonly size: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>((r) => this.waiters.push(r))
    this.active += 1
    try { return await fn() } finally {
      this.active -= 1
      this.waiters.shift()?.()
    }
  }
}

export class UsageService {
  readonly cache = new Map<string, CachedUsage>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly capacity = new Capacity(4)
  manager: TokenManager
  proxy_dir: string | null
  fetchImpl: FetchLike
  clock: () => number

  constructor(manager: TokenManager, proxyDir: string | null = null, opts: { fetchImpl?: FetchLike; clock?: () => number } = {}) {
    this.manager = manager
    this.proxy_dir = proxyDir
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => safeFetch(input, init))
    this.clock = opts.clock ?? (() => Date.now() / 1000)
  }

  static fromEnvironment(): UsageService {
    const path = (process.env.OASIS_CODE_USAGE_PROXY_AUTH_DIR ?? '').trim()
    return new UsageService(tokenManager(), path ? expandUser(path) : null)
  }

  accounts(): UsageAccount[] {
    const result: UsageAccount[] = []
    for (const provider of PROVIDERS) {
      try {
        const grant = this.manager.store.read(provider)
        if (grant) {
          result.push(new UsageAccount(`harness:${provider}`, provider, 'harness', grant.email, grant.access, grant.account_id, grant.expires_ms / 1000,
            grant.disabled_reason ? 'login_required' : null, provider === 'antigravity' ? authorizationKey(grant) : null))
        }
      } catch {
        result.push(new UsageAccount(`harness:${provider}`, provider, 'harness', null, '', null, null, 'credential_unreadable'))
      }
    }
    result.push(...proxyAccounts(this.proxy_dir))
    for (const provider of PROVIDERS) {
      if (!result.some((a) => a.provider === provider)) result.push(new UsageAccount(`harness:${provider}`, provider, 'harness', null, '', null, null, 'not_connected'))
    }
    return result
  }

  async snapshot(opts: { refresh?: boolean } = {}): Promise<Record<string, unknown>> {
    const refresh = opts.refresh ?? false
    const accounts = this.accounts()
    const active = new Set(accounts.map((a) => a.id))
    for (const key of [...this.cache.keys()]) if (!active.has(key)) this.cache.delete(key)
    // a proxy file holding the same subscription as a harness sign-in (same provider, same email) is not asked again:
    // it mirrors the sign-in's report, so the provider sees one check per account
    const signedIn = new Map(accounts.filter((a) => a.source === 'harness' && a.email && !a.error).map((a) => [`${a.provider}\n${a.email}`, a]))
    const mirrors = new Map<string, UsageAccount>()
    for (const a of accounts) {
      const twin = a.source === 'proxy' ? signedIn.get(`${a.provider}\n${a.email}`) : undefined
      if (twin) mirrors.set(a.id, twin)
    }
    const queried = accounts.filter((a) => !mirrors.has(a.id))
    const reports = new Map(await Promise.all(queried.map(async (a) => [a.id, await this.report(a, { refresh })] as const)))
    const out = accounts.map((account) => {
      const twin = mirrors.get(account.id)
      return twin ? { ...reports.get(twin.id)!, ...account.public(), mirrors: twin.id } : reports.get(account.id)!
    })
    return { accounts: out, server_time: iso(this.clock()), poll_interval_seconds: CACHE_SECONDS }
  }

  /** One account's report, single-flight per account (concurrent readers share one check). */
  report(account: UsageAccount, opts: { refresh?: boolean } = {}): Promise<Record<string, unknown>> {
    const previous = this.chains.get(account.id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => this.reportNow(account, opts.refresh ?? false))
    this.chains.set(account.id, next)
    return next
  }

  /** A queued or in-flight quota read belongs to the captured authorization, not the next login. */
  private sameAuthorization(account: UsageAccount): boolean {
    if (account.provider !== 'antigravity' || account.source !== 'harness') return true
    try {
      const current = this.manager.store.read('antigravity')
      if (!current) return account.authorization_key === null
      return account.authorization_key === authorizationKey(current) && (!current.disabled_reason || account.error === 'login_required')
    } catch { return false }
  }

  private discardedReport(account: UsageAccount): Record<string, unknown> {
    this.cache.delete(account.id)
    return { ...account.public(), status: 'unavailable', windows: [], checked_at: null, next_refresh_at: iso(this.clock()), error: 'account_changed', message: 'The account changed while reading usage; refresh account usage.', plan: null }
  }

  private async reportNow(account: UsageAccount, refresh: boolean): Promise<Record<string, unknown>> {
    if (!this.sameAuthorization(account)) return this.discardedReport(account)
    let now = this.clock()
    let cached = this.cache.get(account.id) ?? null
    if (cached && cached.fingerprint !== account.fingerprint) cached = null
    if (cached && now < (refresh ? cached.force_after : cached.refresh_at)) return cached.report
    const report: Record<string, unknown> = { ...account.public(), status: 'ok', windows: [], checked_at: null, error: null, message: null, plan: null }
    let error = account.error
    let delay = pollSeconds(account.provider)
    if (!error && !account.access) error = 'login_required'
    if (!error && account.source === 'proxy' && account.expires_at !== null && account.expires_at <= now) error = 'proxy_expired'
    if (!error) {
      try {
        await this.capacity.run(async () => {
          let access = account.access
          let accountId = account.account_id
          let project: string | null = null
          if (account.source === 'harness') {
            const grant = await this.manager.access(account.provider)
            if (account.provider === 'antigravity' && (authorizationKey(grant) !== account.authorization_key || !this.sameAuthorization(account))) throw new UsageAccountChanged()
            access = grant.access; accountId = grant.account_id; project = grant.project_id
          }
          const headers: Record<string, string> = { Authorization: `Bearer ${access}`, Accept: 'application/json' }
          if (account.provider === 'anthropic') {
            headers['anthropic-beta'] = 'oauth-2025-04-20'
            headers['User-Agent'] = CLI_USER_AGENT
          } else if (accountId && account.provider === 'openai-codex') {
            headers['ChatGPT-Account-Id'] = accountId
          }
          // Fixed first-party URLs. Never follow a redirect with account credentials.
          const response = await this.fetchImpl(ENDPOINTS[account.provider]!, { method: account.provider === 'antigravity' ? 'POST' : 'GET', headers: account.provider === 'antigravity' ? { ...headers, 'content-type': 'application/json', 'user-agent': ANTIGRAVITY_USER_AGENT } : headers, ...(account.provider === 'antigravity' ? { body: JSON.stringify({ project }) } : {}), redirect: 'manual', signal: AbortSignal.timeout(20_000) })
          if (response.status === 401) error = 'login_required'
          else if (response.status === 403) error = 'permission_denied'
          else if (response.status === 429) {
            error = 'rate_limited'
            const retry = response.headers.get('Retry-After') ?? '60'
            let wait = Number(retry)
            if (!Number.isFinite(wait) || retry.trim() === '') {
              const at = Date.parse(retry)
              wait = Number.isFinite(at) ? at / 1000 - now : pollSeconds(account.provider)
            }
            // Preserve long Retry-After windows; the date bound only keeps a malformed header from overflowing serialization.
            delay = Number.isFinite(wait) ? Math.min(253402300000 - now, Math.max(pollSeconds(account.provider), wait)) : pollSeconds(account.provider)
          } else if (response.status !== 200) error = 'unavailable'
          else {
            const data = (await response.json()) as unknown
            if (!isRecord(data)) throw new Error('usage must be an object')
            report.windows = account.provider === 'antigravity' ? parseAntigravity(data) : account.provider === 'openai-codex' ? parseCodex(data, this.clock()) : parseClaude(data)
            if (account.provider !== 'antigravity') report.plan = text(data.plan_type)
            report.checked_at = iso(this.clock())
          }
          if (account.provider === 'antigravity') {
            // A grant may predate paidTier handling. Refresh metadata through the normal fixed
            // control endpoint, not by rewriting credentials or reclassifying a cached free-tier.
            if (!this.sameAuthorization(account)) throw new UsageAccountChanged()
            try {
              const assist = await control(this.fetchImpl, access, 'loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } })
              if (!this.sameAuthorization(account)) throw new UsageAccountChanged()
              report.plan = reportedTierId(assist)
            } catch (failure) {
              if (failure instanceof UsageAccountChanged || !this.sameAuthorization(account)) throw new UsageAccountChanged()
              // Optional tier metadata unavailable: quota remains useful, plan is unknown. Never
              // substitute the stale grant's tier or surface a sensitive raw control error.
              report.plan = null
            }
          }
        })
      } catch (failure) {
        if (failure instanceof UsageAccountChanged) error = 'account_changed'
        else if (failure instanceof LoginRequired) error = 'login_required'
        else if (failure instanceof NativeAuthTemporaryError) error = 'unavailable'
        else if (failure instanceof NativeAuthError) error = 'credential_unreadable'
        else if (failure instanceof SyntaxError || (failure as Error).message === 'usage must be an object' || /unrecognized usage response/.test((failure as Error).message)) error = 'invalid_response'
        else error = 'unavailable'
      }
    }
    if (error === 'account_changed' || !this.sameAuthorization(account)) return this.discardedReport(account)
    if (error) {
      report.status = 'unavailable'; report.error = error; report.message = ERRORS[error]
      if (['login_required', 'not_connected', 'proxy_expired'].includes(error)) report.status = 'login_required'
      if (['unavailable', 'rate_limited', 'invalid_response'].includes(error) && cached) {
        const checked = timestamp(cached.report.checked_at)
        if (checked !== null && now - checked <= staleSeconds(account.provider)) {
          report.status = 'stale'; report.windows = cached.report.windows; report.checked_at = cached.report.checked_at
          if (account.provider !== 'antigravity') report.plan = cached.report.plan
        }
      }
    }
    now = this.clock()
    report.next_refresh_at = iso(now + delay)
    this.cache.set(account.id, { fingerprint: account.fingerprint, report, refresh_at: now + delay, force_after: now + (error ? delay : 15) })
    return report
  }
}

/** Remaining fraction is not usage tokens. Missing quota stays unknown, never zero consumed. */
export function parseAntigravity(data: Record<string, unknown>): QuotaWindow[] {
  if (!agRecord(data.models)) throw new Error('unrecognized usage response')
  const models = data.models
  return availableAntigravityModels(models).map(({ id, model }) => {
    // One explicitly labeled default-effort quota, not an inferred shared bucket or an aggregation of variants.
    const raw = models[model.upstream[model.defaultEffort]!]
    const quota = agRecord(raw) && agRecord(raw.quotaInfo) ? raw.quotaInfo : {}
    const remaining = number(quota.remainingFraction)
    return window(id, model.label + ' (' + model.defaultEffort + ' default)', remaining !== null && remaining >= 0 && remaining <= 1 ? (1 - remaining) * 100 : null, quota.resetTime)
  })
}

class UsageAccountChanged extends Error { constructor() { super('account changed during quota request'); this.name = 'UsageAccountChanged' } }
