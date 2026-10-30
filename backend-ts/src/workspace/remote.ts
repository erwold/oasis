/** Integration boundary: the transport owns SSH/Python; this service owns persisted host/root identity, the
 *  person's connect intent and the connection's recovery. No local filesystem operation accepts a remote path. A
 *  missing transport fails closed.
 *
 *  Intent and state are kept apart. `connect_intent` is the person's: Connect writes 'connect', Disconnect writes
 *  'disconnect' (before anything is awaited), and nothing else writes it — a shutdown, a crash or a lost network
 *  never does. `state` is the transport's, as this process last saw it. A target the person connected is dialed
 *  again after a restart and after a lost connection, on a stepped schedule bounded by a grace period; an
 *  authentication, host-key or unsupported-transport refusal ends the schedule until the person acts. A target the
 *  person disconnected — or never connected — is never dialed: every request is refused before it reaches SSH.
 *
 *  A request that only reads is sent again once the connection is back (bounded wait). A mutation is sent at most
 *  once; when its reply is lost, its caller settles it from the operation's own receipt, never by sending it again. */
import type { RemoteWorkspaceBinding, SshTarget, PortForward, SshConnectIntent } from '@oasis-code/contract'
import { RemoteWorkspaceBindingSchema } from '@oasis-code/contract'
import type { Conn } from '../db/database.ts'
import * as targets from '../db/remote_repo.ts'
import { RemoteError, type RemoteMethod, type MethodParams, type MethodResults } from '../remote/types.ts'

export class RemoteRefused extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = 'RemoteRefused' }
}
/** A remote mutation whose reply was lost and whose own receipt could not be read within the settle bound: it may or
 *  may not have happened. It was not sent again; its journal record and the writer's lease stay as they are until a
 *  later reconciliation reads the receipt. A run that meets it stops before its next step (agent/loop RunHalted). */
export class RemoteOutcomeUnresolved extends RemoteRefused {
  constructor(message: string, readonly detail: { kind: 'file_write' | 'job_start'; operation_id: string; target_id: string; path?: string; execution_id?: string; receipt_state: string }) {
    super('outcome_unknown', message, 503)
    this.name = 'RemoteOutcomeUnresolved'
  }
}
export interface RemoteDirectory {
  path: string; name: string; parent: string | null;
  entries: { name: string; path: string; repository: boolean }[];
  truncated: boolean; favorites: { label: string; path: string }[];
}
/** A thin binding implemented over src/remote/SshTransport, never a second protocol/adapter. */
export interface RemoteHostProvider {
  probe(): Promise<{ capabilities: Record<string, boolean> }>;
  /** A real round trip to the host now — never a cached answer: what an attempt to reconnect checks. */
  check?(): Promise<void>;
  listDirs(path: string): Promise<RemoteDirectory>;
  openRoot(path: string, statePath?: string): Promise<Omit<RemoteWorkspaceBinding, 'target_id'>>;
  request?<M extends RemoteMethod>(root: RemoteWorkspaceBinding, method: M, params: MethodParams[M], operationId?: string): Promise<MethodResults[M]>;
  openForward(workspaceId: string, remotePort: number): Promise<Omit<PortForward, 'target_id'>>;
  closeForward(id: string): Promise<boolean>;
  disconnect(): Promise<void>;
}
export type RemoteProviderFactory = (target: SshTarget) => RemoteHostProvider

/** The methods that only read or ask (the remote changes nothing for them): sent again after a lost connection.
 *  Every other method is a mutation: sent once. */
export const SAFE_REMOTE_METHODS: ReadonlySet<string> = new Set<RemoteMethod>(['roots.validate', 'files.resolve', 'files.policyMatch', 'files.stat',
  'files.read', 'files.tail', 'files.list', 'files.search', 'operations.status', 'jobs.status', 'jobs.recover', 'jobs.read', 'leases.inspect'])

export interface ReconnectPolicy {
  /** the wait before each attempt once the connection is lost (ms); the last one repeats until grace_ms has passed */
  steps_ms: number[]
  /** how long after the loss attempts go on by themselves; then the target waits for the person's Connect */
  grace_ms: number
  /** how long a request waits for the connection to come back before it fails without being sent */
  request_wait_ms: number
  /** how long a mutation whose reply was lost is settled from its own receipt before the run is stopped */
  settle_ms: number
}
/** The steps between reconnection attempts of VS Code's remote agent connection (src/vs/platform/remote/common/
 *  remoteAgentConnection.ts: 0, 5, 5, 10, 10, 10, 10, 10, 30 s, the last repeated) inside a grace period. */
export const DEFAULT_RECONNECT: ReconnectPolicy = {
  steps_ms: [0, 5_000, 5_000, 10_000, 10_000, 10_000, 10_000, 10_000, 30_000],
  grace_ms: 3 * 60 * 60 * 1000, request_wait_ms: 30_000, settle_ms: 120_000,
}
/** States only the person can leave (a key, a host key, the host's Python): never dialed again by themselves. */
const PERSON_STATES = new Set(['auth_required', 'host_verification_required', 'unsupported'])
/** Waits until the promise settles or ms pass, whichever is first; the timer never outlives the wait. */
function settledOrAfter(promise: Promise<unknown> | undefined, ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    promise?.then(() => { clearTimeout(timer); resolve() }, () => { clearTimeout(timer); resolve() })
  })
}
/** A failure of reaching the host that may go away by itself (the network, the host restarting, a timed-out probe). */
function transient(error: unknown): boolean {
  return error instanceof RemoteError && error.retryable && (error.status === 'disconnected' || error.status === 'unknown')
}
const UNAVAILABLE = 'The SSH connection is unavailable; nothing was sent.'

interface Link {
  /** bumped by Connect, Disconnect and close: an attempt of an older epoch changes nothing when it settles */
  epoch: number
  ready: boolean
  attempt: { epoch: number; promise: Promise<void> } | null
  timer: ReturnType<typeof setTimeout> | null
  next_at: number | null
  failures: number
  lost_at: number | null
  gave_up: boolean
}

export class RemoteWorkspaceService {
  private readonly hosts = new Map<string, RemoteHostProvider>()
  private readonly links = new Map<string, Link>()
  private readonly probed = new WeakSet<RemoteHostProvider>()
  private readonly forwards = new Map<string, PortForward>()
  private readonly readyListeners: ((targetId: string, how: 'connect' | 'reconnect') => void)[] = []
  private closed = false
  readonly policy: ReconnectPolicy
  constructor(readonly conn: Conn, private readonly factory?: RemoteProviderFactory, policy: Partial<ReconnectPolicy> = {}) {
    this.policy = { ...DEFAULT_RECONNECT, ...policy }
    // What the last process saw is no connection of this one; the person's intent stays as it was (resume() acts on it).
    targets.disconnectTargets(conn)
  }
  /** Told each time a target's connection is established: by the person's Connect, or again by itself. */
  onReady(listener: (targetId: string, how: 'connect' | 'reconnect') => void): void { this.readyListeners.push(listener) }
  target(id: string): SshTarget {
    const target = targets.getTarget(this.conn, id)
    if (!target) throw new RemoteRefused('target_not_found', `SSH target not found: ${id}`, 404)
    return target
  }
  intent(id: string): SshConnectIntent { return this.target(id).connect_intent ?? 'none' }
  /** Not to be dialed: the person disconnected it, or never connected it. */
  isPaused(id: string): boolean { return this.intent(id) !== 'connect' }
  /** The connection is up as far as this process knows (the last attempt or request on it succeeded). */
  isReady(id: string): boolean { return !this.isPaused(id) && this.links.get(id)?.ready === true && this.hosts.has(id) }
  /** Whether a background reader may contact the host now: up, or nothing under way or scheduled to bring it back (its
   *  request then makes the attempt due). A poller that hears false skips quietly: the attempt under way, the schedule
   *  or the person's Connect brings the connection back, and onReady tells the pollers. */
  reachable(id: string): boolean {
    if (this.closed || this.isPaused(id) || PERSON_STATES.has(this.target(id).state)) return false
    const link = this.link(id)
    return (link.ready && this.hosts.has(id)) || (link.attempt === null && !link.timer && !link.gave_up)
  }
  private link(id: string): Link {
    let link = this.links.get(id)
    if (!link) { link = { epoch: 0, ready: false, attempt: null, timer: null, next_at: null, failures: 0, lost_at: null, gave_up: false }; this.links.set(id, link) }
    return link
  }
  private reset(link: Link): void {
    link.epoch += 1
    if (link.timer) clearTimeout(link.timer)
    link.timer = null; link.next_at = null; link.failures = 0; link.lost_at = null; link.gave_up = false; link.ready = false
  }

  /** Startup: every target the person left connected (and no refusal waiting for them) is dialed again, in the
   *  background, on the schedule. Targets they disconnected, or never connected, are left alone. */
  resume(): string[] {
    const resumed: string[] = []
    if (this.closed) return resumed
    for (const target of targets.listTargets(this.conn)) {
      if ((target.connect_intent ?? 'none') !== 'connect' || PERSON_STATES.has(target.state)) continue
      const link = this.link(target.id)
      if (link.ready || link.attempt || link.timer) continue
      this.schedule(target.id)
      resumed.push(target.id)
    }
    return resumed
  }

  async connect(id: string): Promise<SshTarget> {
    this.target(id)
    if (this.closed) throw new RemoteError('remote_unavailable', 'The app is closing; nothing was dialed.', 'disconnected', true)
    const link = this.link(id)
    this.reset(link)
    link.failures = 1 // the person's attempt is the schedule's first step: a failed Connect is tried again after the second
    targets.setIntent(this.conn, id, 'connect')
    const epoch = link.epoch
    try { await this.attempt(id, 'connect') }
    catch (error) { if (link.epoch === epoch && this.intent(id) === 'connect') throw error }
    return this.target(id)
  }

  async disconnect(id: string): Promise<SshTarget> {
    this.target(id)
    const link = this.link(id)
    this.reset(link) // a pending attempt or scheduled retry is dropped here, before anything is awaited
    // persisted before any await: a poll, a retry or the next start of the app cannot dial behind the person's action
    targets.setIntent(this.conn, id, 'disconnect')
    const provider = this.hosts.get(id)
    this.hosts.delete(id)
    targets.updateTarget(this.conn, id, { ...this.target(id), state: 'disconnected' })
    for (const [key, forward] of this.forwards) if (forward.target_id === id) this.forwards.set(key, { ...forward, state: 'disconnected' })
    this.conn.run("UPDATE remote_jobs SET connection_state='disconnected' WHERE target_id=?", [id])
    if (provider) await provider.disconnect()
    return this.target(id)
  }

  /** One attempt to establish the connection: joins the one under way, else dials. Settles the state (ready, a
   *  refusal for the person, or an error with the next attempt scheduled); an attempt of an older epoch changes
   *  nothing. */
  private attempt(id: string, how: 'connect' | 'reconnect'): Promise<void> {
    const link = this.link(id)
    if (link.attempt && link.attempt.epoch === link.epoch) return link.attempt.promise
    if (link.timer) { clearTimeout(link.timer); link.timer = null; link.next_at = null }
    const epoch = link.epoch
    let provider: RemoteHostProvider | undefined
    const current = () => link.epoch === epoch && !this.closed && this.intent(id) === 'connect' && (provider === undefined || this.hosts.get(id) === provider)
    const promise = (async () => {
      if (!current()) return
      targets.updateTarget(this.conn, id, { ...this.target(id), state: 'connecting' })
      try {
        provider = this.hosts.get(id)
        if (!provider) {
          if (!this.factory) throw new RemoteRefused('remote_unavailable', 'SSH transport is unavailable; nothing ran locally.', 503)
          provider = this.factory(this.target(id))
          this.hosts.set(id, provider)
        }
        // a provider that answered before may answer its probe from memory: the link itself is checked first
        if (this.probed.has(provider) && provider.check) await provider.check()
        const probe = await provider.probe()
        this.probed.add(provider)
        if (!current()) return
        // the schedule's count is reset by a request that works on the connection (watched), not by the probe alone:
        // a host that answers probes but fails every request still walks the steps, never a tight loop
        link.ready = true; link.gave_up = false
        targets.updateTarget(this.conn, id, { ...this.target(id), state: 'ready', capabilities: probe.capabilities, last_error: null })
        for (const listener of this.readyListeners) { try { listener(id, how) } catch { /* a listener's failure is its own */ } }
      } catch (error) {
        if (!current()) return
        this.failed(id, error)
        throw error
      }
    })()
    link.attempt = { epoch, promise }
    void promise.then(() => {}, () => {}).then(() => { if (link.attempt?.promise === promise) link.attempt = null })
    return promise
  }

  private failed(id: string, error: unknown): void {
    const link = this.link(id), code = (error as { code?: string }).code
    const state = code === 'auth_required' ? 'auth_required' : code === 'host_verification_required' ? 'host_verification_required' : code === 'unsupported_transport' ? 'unsupported' : 'error'
    link.ready = false
    targets.updateTarget(this.conn, id, { ...this.target(id), state, last_error: code ?? 'remote_unavailable' })
    // Only a failure of the network or the link is tried again. A refusal only the person can lift (a key, a host key,
    // the host's Python) and a failure that would be the same next time (a protocol or argument error, no
    // transport) end the schedule: no loop on them.
    if (state === 'error' && transient(error)) this.schedule(id)
    else { if (link.timer) clearTimeout(link.timer); link.timer = null; link.next_at = null; link.gave_up = true }
  }

  /** The next attempt, on the stepped schedule, unless the grace period since the loss has passed. */
  private schedule(id: string): void {
    const link = this.link(id)
    if (this.closed || link.timer || this.intent(id) !== 'connect') return
    const now = Date.now()
    link.lost_at ??= now
    const steps = this.policy.steps_ms
    const wait = steps[Math.min(link.failures, steps.length - 1)] ?? 0
    if (now + wait - link.lost_at > this.policy.grace_ms) {
      link.gave_up = true
      targets.updateTarget(this.conn, id, { ...this.target(id), state: 'error', last_error: 'reconnect_gave_up' })
      return
    }
    link.failures += 1
    link.next_at = now + wait
    const epoch = link.epoch
    link.timer = setTimeout(() => {
      link.timer = null; link.next_at = null
      if (link.epoch !== epoch || this.closed) return
      void this.attempt(id, 'reconnect').catch(() => { /* recorded by failed(), next attempt scheduled there */ })
    }, wait)
    link.timer.unref?.()
  }

  /** A request on this provider found no connection: unless something newer already replaced it, the target is no
   *  longer ready and the schedule takes over (immediately first). */
  private lost(id: string, provider: RemoteHostProvider, error: unknown): void {
    if (this.closed || this.hosts.get(id) !== provider || this.intent(id) !== 'connect') return
    const link = this.link(id)
    if (!link.ready) return
    link.ready = false
    targets.updateTarget(this.conn, id, { ...this.target(id), state: 'error', last_error: (error as { code?: string }).code ?? 'remote_unavailable' })
    if (!link.attempt) this.schedule(id)
  }

  /** The provider to send a request with: the target must be one the person connected. When its connection is not
   *  up, the next attempt is due at once (never sooner than the schedule allows) and the request waits for the
   *  connection only while its own deadline lasts — wait_ms 0 (a background poller) never waits and never dials
   *  itself; the request then fails without being sent. A Disconnect meanwhile wins. */
  private async usable(id: string, waitMs: number): Promise<RemoteHostProvider> {
    const deadline = Date.now() + Math.max(0, waitMs)
    for (;;) {
      const target = this.target(id)
      if (this.closed) throw new RemoteError('remote_unavailable', UNAVAILABLE, 'disconnected', true)
      const intent = target.connect_intent ?? 'none'
      if (intent === 'disconnect') throw new RemoteRefused('remote_disconnected', 'The SSH target was disconnected; reconnect it before continuing.', 503)
      if (intent !== 'connect') throw new RemoteRefused('remote_unavailable', 'The SSH target is not connected; connect it before continuing.', 503)
      if (PERSON_STATES.has(target.state)) throw new RemoteError(target.state === 'unsupported' ? 'unsupported_transport' : target.state, UNAVAILABLE, 'refused', false)
      const link = this.link(id), provider = this.hosts.get(id)
      if (link.ready && provider) return provider
      if (link.gave_up) throw new RemoteError('remote_unavailable', UNAVAILABLE, 'disconnected', true)
      // nothing under way and nothing scheduled (a start before resume(), a poll after a quiet loss): due now
      if (!link.attempt && !link.timer) this.schedule(id)
      const left = deadline - Date.now()
      if (left <= 0) throw new RemoteError('remote_unavailable', UNAVAILABLE, 'disconnected', true)
      await settledOrAfter(link.attempt?.promise, link.attempt ? left : Math.min(50, left))
    }
  }

  listDirs(id: string, path: string): Promise<RemoteDirectory> {
    if (path && (!path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path))) throw new RemoteRefused('path_required', 'A remote folder must be an absolute path.', 400)
    return this.usable(id, this.policy.request_wait_ms).then(provider => this.watched(id, provider, () => provider.listDirs(path)))
  }
  async openRoot(id: string, path: string, statePath?: string): Promise<RemoteWorkspaceBinding> {
    if (!path.startsWith('/') || path === '/' || /[\x00-\x1f\x7f]/.test(path)) throw new RemoteRefused('path_required', 'A remote project must name an absolute folder other than /.', 400)
    const provider = await this.usable(id, this.policy.request_wait_ms)
    const root = await this.watched(id, provider, () => provider.openRoot(path, statePath))
    return RemoteWorkspaceBindingSchema.parse({ ...root, target_id: id })
  }
  /** A call on the provider whose loss of connection is noticed (the schedule then takes over). */
  private async watched<T>(id: string, provider: RemoteHostProvider, call: () => Promise<T>): Promise<T> {
    try {
      const value = await call()
      const link = this.links.get(id)
      if (link && this.hosts.get(id) === provider) { link.failures = 0; link.lost_at = null }
      return value
    } catch (error) {
      const e = error as { status?: string; code?: string }
      if (e.status === 'disconnected') this.lost(id, provider, error)
      else if (e.code === 'auth_required' || e.code === 'host_verification_required') { if (this.hosts.get(id) === provider) this.failed(id, error) }
      throw error
    }
  }
  /** One remote call. A method that only reads is sent again once the connection is back, until the wait runs out;
   *  a mutation is sent once and its failure is its caller's to settle (never resent here).
   *  opts.wait_ms: how long to wait for the connection (background pollers pass 0: they never wait or dial past
   *  the schedule). */
  async request<M extends RemoteMethod>(root: RemoteWorkspaceBinding, method: M, params: MethodParams[M], operationId?: string, opts: { wait_ms?: number } = {}): Promise<MethodResults[M]> {
    const id = root.target_id, waitMs = opts.wait_ms ?? this.policy.request_wait_ms
    const deadline = Date.now() + waitMs
    const safe = SAFE_REMOTE_METHODS.has(method)
    for (;;) {
      const provider = await this.usable(id, Math.max(0, deadline - Date.now()))
      if (!provider.request) throw new RemoteRefused('remote_unavailable', 'Remote file/job provider unavailable; local fallback refused.', 503)
      try { return await this.watched(id, provider, () => provider.request!(root, method, params, operationId)) }
      catch (error) {
        const e = error as { status?: string }
        // a read that found no connection is asked again once the connection is back; a mutation never is
        if (!safe || e.status !== 'disconnected' || Date.now() >= deadline) throw error
      }
    }
  }
  async openForward(id: string, workspaceId: string, remotePort: number): Promise<PortForward> {
    const provider = await this.usable(id, this.policy.request_wait_ms), epoch = this.link(id).epoch
    const record = { ...await this.watched(id, provider, () => provider.openForward(workspaceId, remotePort)), target_id: id }
    if (this.isPaused(id) || this.link(id).epoch !== epoch || this.hosts.get(id) !== provider) {
      await provider.closeForward(record.id) // close through the old owner, never the replacement connection
      throw new RemoteRefused('remote_disconnected', 'The connection changed while opening this forward; the late listener was closed.', 503)
    }
    if (record.local_host !== '127.0.0.1' || record.remote_host !== '127.0.0.1' || [8321,8322,8323,8324,8399].includes(record.local_port)) {
      await provider.closeForward(record.id)
      throw new RemoteRefused('forward_refused', 'The forward must use an isolated loopback port.')
    }
    this.forwards.set(record.id, record)
    return record
  }
  listForwards(id: string): PortForward[] { this.target(id); return [...this.forwards.values()].filter(f => f.target_id === id) }
  async closeForward(id: string, forwardId: string): Promise<boolean> {
    this.target(id)
    const record = this.forwards.get(forwardId)
    if (!record || record.target_id !== id) return false
    const provider = this.hosts.get(id)
    const closed = provider ? await provider.closeForward(forwardId) : record.state === 'disconnected'
    if (closed) this.forwards.delete(forwardId)
    return closed
  }
  /** The app's shutdown: this process's SSH connections and listeners end; remote jobs keep running; the person's
   *  intent is untouched — a target left connected is dialed again by the next start. */
  async close(): Promise<void> {
    this.closed = true
    for (const link of this.links.values()) this.reset(link)
    const providers = [...this.hosts.entries()]
    this.hosts.clear()
    for (const [id] of providers) {
      try {
        const target = targets.getTarget(this.conn, id)
        if (target && (target.state === 'ready' || target.state === 'connecting')) targets.updateTarget(this.conn, id, { ...target, state: 'disconnected' })
      } catch { /* the record stays as it was; the next start normalizes it */ }
    }
    for (const [key, forward] of this.forwards) this.forwards.set(key, { ...forward, state: 'disconnected' })
    await Promise.allSettled(providers.map(([, provider]) => provider.disconnect()))
  }
}
