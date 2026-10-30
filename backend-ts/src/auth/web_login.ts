/** Browser sign-in driven from the UI.
 *
 *  One bounded session per provider: the manager mints PKCE + state, opens the loopback callback, hands the
 *  authorization URL to the page (which opens it in a new tab), and finishes the exchange in the background. The page
 *  polls the session until it is done. When the callback port is taken, or the browser runs on another machine, the
 *  person pastes the final redirect URL back and the session completes the same way. The grant lands in the harness's
 *  own store like a CLI login. Carried from oasis auth/web_login.py. */

import { randomBytes } from 'node:crypto'
import { CallbackServer, Deferred, LoginCancelled, validatedInput, type CallbackResult } from './callback.ts'
import { safeFetch } from '../safe_fetch.ts'
import type { FetchLike } from './http.ts'
import { CODEX_ORIGINATOR } from './models.ts'
import * as oauthAnthropic from './oauth_anthropic.ts'
import * as oauthAntigravity from './oauth_antigravity.ts'
import * as oauthCodex from './oauth_codex.ts'
import { generatePkce, generateState } from './pkce.ts'
import { credentialStore, MIN_VALIDITY_MS, NativeAuthError, PROVIDERS, tokenManager, type CredentialStore, type OAuthCredential, type TokenManager } from './store.ts'

export const LOGIN_TIMEOUT_S = 600
export const LABELS: Record<string, string> = { [oauthCodex.PROVIDER]: 'Codex (ChatGPT)', [oauthAnthropic.PROVIDER]: 'Claude', antigravity: 'Antigravity' }
export const SESSION_STATES = ['waiting', 'exchanging', 'done', 'failed', 'cancelled'] as const
export type SessionState = (typeof SESSION_STATES)[number]

interface OAuthModule {
  PROVIDER: string; CALLBACK_HOST: string; CALLBACK_PORT: number; CALLBACK_PATH: string; REDIRECT_URI: string
}
export const MODULES: Record<string, OAuthModule> = { [oauthCodex.PROVIDER]: oauthCodex, [oauthAnthropic.PROVIDER]: oauthAnthropic, antigravity: oauthAntigravity }

class LoginTimeout extends Error { constructor() { super('sign-in timed out'); this.name = 'LoginTimeout' } }

const nowMs = () => Date.now()

export function isoOfMs(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

/** The provider-specific code exchange (Anthropic also checks the state and looks the account up). */
export async function exchange(provider: string, http: FetchLike, result: CallbackResult, verifier: string, redirectUri: string, signal?: AbortSignal): Promise<OAuthCredential> {
  if (provider === oauthAnthropic.PROVIDER) {
    let grant = await oauthAnthropic.exchangeCode(http, { code: result.code, state: result.state, verifier, redirect_uri: redirectUri })
    if (!grant.email) {
      const [accountId, email] = await oauthAnthropic.identity(http, grant.access)
      grant = grant.with({ account_id: accountId || grant.account_id, email })
    }
    return grant
  }
  if (provider === 'antigravity') return oauthAntigravity.exchangeCode(http, { code: result.code, verifier, redirect_uri: redirectUri, signal })
  if (provider !== oauthCodex.PROVIDER) throw new NativeAuthError('unknown OAuth provider')
  return oauthCodex.exchangeCode(http, { code: result.code, verifier, redirect_uri: redirectUri })
}

export function accountStatus(grant: OAuthCredential | null, now: number): 'signed_out' | 'login_required' | 'refresh_needed' | 'ready' {
  if (grant === null) return 'signed_out'
  if (grant.disabled_reason) return 'login_required'
  if (grant.expiresWithin(MIN_VALIDITY_MS, now)) return 'refresh_needed'
  return 'ready'
}

export class LoginSession {
  state: SessionState = 'waiting'
  error: string | null = null
  account_label: string | null = null
  server: CallbackServer | null = null
  readonly pasted = new Deferred<CallbackResult>()
  readonly cancelled = new Deferred<never>()
  readonly abort = new AbortController()
  task: Promise<void> | null = null

  constructor(
    readonly id: string, readonly provider: string, readonly url: string, readonly started_ms: number, readonly expires_ms: number,
    readonly paste_only: boolean, readonly verifier: string, readonly state_token: string, readonly redirect_uri: string,
  ) {}

  get active(): boolean { return this.state === 'waiting' || this.state === 'exchanging' }

  public(): Record<string, unknown> {
    return {
      id: this.id, provider: this.provider, url: this.url, state: this.state, error: this.error, paste_only: this.paste_only,
      expires_at: isoOfMs(this.expires_ms), account_label: this.account_label,
    }
  }
}

export interface LoginManagerOptions {
  manager?: TokenManager
  fetchImpl?: FetchLike
  timeout_s?: number
  /** tests bind port 0; production uses each provider's registered port */
  callback_ports?: Record<string, number>
  now_ms?: () => number
}

export class LoginManager {
  static IDENTITY_WAIT_MS = 5000
  readonly sessions = new Map<string, LoginSession>()
  readonly fetchImpl: FetchLike
  readonly timeout_s: number
  readonly callback_ports: Record<string, number>
  private storeRef: CredentialStore | null
  private managerRef: TokenManager | null
  private identityTask: Promise<void> | null = null
  private readonly nowMs: () => number

  constructor(store: CredentialStore | null = null, opts: LoginManagerOptions = {}) {
    this.storeRef = store
    this.managerRef = opts.manager ?? null
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => safeFetch(input, init))
    this.timeout_s = opts.timeout_s ?? LOGIN_TIMEOUT_S
    this.callback_ports = opts.callback_ports ?? {}
    this.nowMs = opts.now_ms ?? nowMs
  }

  get store(): CredentialStore {
    if (this.storeRef === null) this.storeRef = credentialStore()
    return this.storeRef
  }

  get manager(): TokenManager {
    if (this.managerRef === null) this.managerRef = tokenManager()
    return this.managerRef
  }

  // -- read ---------------------------------------------------------------

  /** An Anthropic grant stored without its email (a sign-in from before the lookup existed) gets it filled once, in
   *  the background; the first reader waits a few seconds for it. */
  async ensureIdentity(): Promise<void> {
    if (this.identityTask === null) {
      let grant: OAuthCredential | null
      try { grant = this.store.read(oauthAnthropic.PROVIDER) } catch { return }
      if (grant === null || grant.disabled_reason || grant.email) return
      this.identityTask = this.backfillIdentity().catch(() => {})
    }
    await Promise.race([this.identityTask, new Promise<void>((r) => setTimeout(r, LoginManager.IDENTITY_WAIT_MS))])
  }

  private async backfillIdentity(): Promise<void> {
    const grant = await this.manager.access(oauthAnthropic.PROVIDER)
    const [accountId, email] = await oauthAnthropic.identity(this.fetchImpl, grant.access)
    if (!email && !accountId) return
    await this.store.modify(oauthAnthropic.PROVIDER, async (current) => {
      if (current === null || current.email) return null
      return current.with({ account_id: accountId || current.account_id, email })
    })
  }

  accounts(): Record<string, unknown>[] {
    const now = this.nowMs()
    const rows = []
    for (const provider of PROVIDERS) {
      let grant: OAuthCredential | null = null
      let status: string
      let error: string | null = null
      try {
        grant = this.store.read(provider)
        status = accountStatus(grant, now)
      } catch (failure) {
        grant = null; status = 'login_required'; error = (failure as Error).message
      }
      const active = [...this.sessions.values()].find((s) => s.provider === provider && s.active) ?? null
      rows.push({
        provider, label: LABELS[provider], status, error,
        account_label: grant ? grant.email || grant.account_id : null,
        expires_at: grant ? isoOfMs(grant.expires_ms) : null,
        login: active ? active.public() : null,
      })
    }
    return rows
  }

  find(loginId: string): LoginSession | null { return this.sessions.get(loginId) ?? null }

  get(loginId: string): LoginSession {
    const session = this.sessions.get(loginId)
    if (session === undefined) throw new NativeAuthError(`no such sign-in: ${loginId}`)
    return session
  }

  // -- sessions -----------------------------------------------------------

  async start(provider: string): Promise<LoginSession> {
    const module = Object.hasOwn(MODULES, provider) ? MODULES[provider] : undefined
    if (module === undefined) throw new NativeAuthError(`unknown provider '${provider}'`)
    for (const previous of [...this.sessions.values()].filter((s) => s.provider === provider && s.active)) await this.cancel(previous.id)
    const [verifier, challenge] = generatePkce()
    const state = generateState()
    const port = this.callback_ports[provider] ?? module.CALLBACK_PORT
    let server: CallbackServer | null = new CallbackServer({ host: module.CALLBACK_HOST, port, path: module.CALLBACK_PATH, expected_state: state })
    let redirectUri = module.REDIRECT_URI
    try {
      await server.start()
      if (port === 0) redirectUri = `http://localhost:${server.bound_port}${module.CALLBACK_PATH}`
    } catch {
      server = null
    }
    const url = provider === oauthCodex.PROVIDER
      ? oauthCodex.authorizeUrl({ state, challenge, redirect_uri: redirectUri, originator: CODEX_ORIGINATOR })
      : provider === 'antigravity' ? oauthAntigravity.authorizeUrl({ state, challenge, redirect_uri: redirectUri }) : oauthAnthropic.authorizeUrl({ state, challenge, redirect_uri: redirectUri })
    const now = this.nowMs()
    const session = new LoginSession(randomBytes(12).toString('base64url'), provider, url, now, now + Math.round(this.timeout_s * 1000), server === null, verifier, state, redirectUri)
    session.server = server
    this.sessions.set(session.id, session)
    session.task = this.run(session)
    return session
  }

  private async awaitCode(session: LoginSession): Promise<CallbackResult> {
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new LoginTimeout()), this.timeout_s * 1000) })
    const waits: Promise<CallbackResult>[] = [session.pasted.promise, session.cancelled.promise, timeout]
    if (session.server !== null) waits.push(session.server.wait())
    for (const p of waits) p.catch(() => {})
    try {
      return await Promise.race(waits)
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  private async run(session: LoginSession): Promise<void> {
    const http: FetchLike = (input, init) => this.fetchImpl(input, { ...init, signal: init?.signal ? AbortSignal.any([session.abort.signal, init.signal]) : session.abort.signal })
    try {
      const result = await this.awaitCode(session)
      session.state = 'exchanging'
      const grant = await exchange(session.provider, http, result, session.verifier, session.redirect_uri, session.abort.signal)
      if (session.abort.signal.aborted) throw new LoginCancelled()
      const authorizedAt = this.nowMs()
      await this.store.modify(session.provider, async () => { if (session.abort.signal.aborted) throw new LoginCancelled(); return grant.with({ authorized_at_ms: authorizedAt }) })
      session.account_label = grant.email || grant.account_id
      session.state = 'done'
    } catch (failure) {
      if (failure instanceof LoginCancelled || (failure as Error).name === 'AbortError' || session.abort.signal.aborted) {
        session.state = 'cancelled'
      } else if (failure instanceof LoginTimeout) {
        session.state = 'failed'; session.error = 'sign-in timed out; start it again'
      } else if (failure instanceof NativeAuthError) {
        session.state = 'failed'; session.error = failure.message
      } else {
        // transport errors can carry request metadata; only the type is safe to show
        const name = (failure as Error).name || 'Error'
        session.state = 'failed'; session.error = `sign-in failed (${name})`
        console.warn(`login ${session.provider} failed: ${name}`)
      }
    } finally {
      if (session.server !== null) {
        await session.server.close()
        session.server = null
      }
    }
  }

  async submit(loginId: string, text: string): Promise<LoginSession> {
    const session = this.get(loginId)
    if (session.state !== 'waiting') throw new NativeAuthError(`this sign-in is ${session.state}; start it again`)
    if (session.provider === 'antigravity') oauthAntigravity.validatePastedRedirect(text, session.redirect_uri)
    const result = validatedInput(text, session.state_token)
    session.pasted.resolve(result)
    return session
  }

  async cancel(loginId: string): Promise<LoginSession> {
    const session = this.get(loginId)
    if (session.active) {
      session.abort.abort()
      session.cancelled.reject(new LoginCancelled())
      if (session.task !== null) await session.task
      session.state = 'cancelled'
    }
    if (session.server !== null) {
      await session.server.close()
      session.server = null
    }
    return session
  }

  async logout(provider: string): Promise<boolean> {
    if (!Object.hasOwn(MODULES, provider)) throw new NativeAuthError(`unknown provider '${provider}'`)
    for (const session of [...this.sessions.values()].filter((s) => s.provider === provider && s.active)) await this.cancel(session.id)
    return this.store.delete(provider)
  }

  async close(): Promise<void> {
    for (const session of [...this.sessions.values()]) if (session.active) await this.cancel(session.id)
  }
}
