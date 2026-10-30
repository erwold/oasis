import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import adapterSource from './adapter.py' with { type: 'text' }
import { encodeFrame, FrameDecoder } from './protocol.ts'
import { RemoteError } from './types.ts'
import type { SshTargetConfig, TransportOptions, ProbeResult, DirectoryPage, RemoteRoot, RootRef, RemoteMethod, MethodParams, MethodResults, OwnedForward, RequestOptions, RetryPolicy, TransportStats } from './types.ts'
const exec = promisify(execFile)
const MUTATIONS = new Set(['files.write','files.edit','files.remove','jobs.start','jobs.stop','leases.acquire','leases.renew','leases.release'])
const FORBIDDEN_PORTS = new Set([8321,8322,8323,8324,8399])
const IDENTITY = ['protocol','request_id','operation_id','generation','root_id'] as const
const SOURCE = Buffer.from(adapterSource)
// Only bootstrap code is shell-quoted. User commands/paths live inside framed JSON stdin.
const BOOTSTRAP = 'import sys; n=int(sys.stdin.buffer.readline()); s=sys.stdin.buffer.read(n).decode("utf-8"); exec(compile(s,"<oasis-ssh-adapter>","exec"),{"__name__":"__main__","__source__":s})'
/** Transport failures of reads, probe and channel establishment only; never a sent mutation. */
export const DEFAULT_RETRY: Omit<RetryPolicy, 'budget_ms'> = { attempts: 4, base_delay_ms: 250, max_delay_ms: 2_000 }
/** Default hard wall-clock bound of ONE call (queue wait + establishment + attempts + backoff). */
const DEFAULT_BUDGET_SLACK_MS = 15_000
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
const token = () => randomUUID().replaceAll('-', '')
interface OwnedChild { child: ChildProcessWithoutNullStreams; identity: Promise<string | null>; command: string }
interface ForwardEntry { value: OwnedForward; server: Server; sockets: Set<Socket>; children: Set<OwnedChild> }
interface Wire { protocol: number; request_id: string; operation_id: string; generation: string | null; root_id: string | null; method: string; params: unknown }
type Delivery = 'not_sent' | 'sent'

/** One attempt's transport failure. `sent` means some byte of the batch reached ssh stdin. */
class AttemptFailure extends Error {
  constructor(readonly error: RemoteError, readonly delivery: Delivery, readonly retryable: boolean) { super(error.message); this.name = 'AttemptFailure' }
}
interface Reason { error: RemoteError; retryable: boolean }
/** One call's cancellation scope: the caller's signal plus a hard deadline timer. */
interface Scope { signal: AbortSignal; expired(): boolean; dispose(): void }
const cancelled = () => new AttemptFailure(new RemoteError('cancelled', 'Request cancelled', 'refused', false), 'not_sent', false)
interface Batch {
  wires: Wire[]; payload: Buffer; mutation: boolean
  values: unknown[]; written: boolean; settled: boolean
  timer?: ReturnType<typeof setTimeout>
  resolve(values: unknown[]): void; reject(failure: AttemptFailure): void
}
interface ChannelHost {
  terminate(owned: OwnedChild): Promise<void>
  classify(stderr: string): RemoteError
  closed(channel: Channel, reason: Reason): void
  pinged(): void
}
interface ChannelLimits { rpc_ms: number; idle_ping_ms: number; max_pipeline: number; max_queue: number }

/** One owned `ssh -T host python -c BOOTSTRAP` exec channel. The adapter source is sent ONCE, then
 * frames flow in order through the adapter's existing serve loop. A batch (openRoot + method) is
 * written as one contiguous buffer, so the adapter's per-channel root context cannot interleave.
 * Reads may pipeline; a mutation is written only onto an otherwise idle pipe, after a fresh
 * response (else a probe ping first), and nothing is written behind it until it is answered. */
class Channel {
  readonly opened_at = Date.now()
  readonly ready: Promise<ProbeResult>
  probe?: ProbeResult
  closed = false
  served = 0
  last_response_at = 0
  private readonly decoder = new FrameDecoder()
  private readonly queue: Batch[] = []
  private readonly inflight: Batch[] = []
  private stderr = ''
  private established = false
  constructor(private readonly host: ChannelHost, readonly owned: OwnedChild, hello: Wire, private readonly limits: ChannelLimits) {
    const child = owned.child
    // Never print command/config/stderr or inherited environment; stderr only classifies failures.
    child.stderr.on('data', (b: Buffer) => { this.stderr = (this.stderr + b.toString()).slice(-8192) })
    child.stdout.on('data', (chunk: Buffer) => this.data(chunk))
    // Asynchronous pipe errors (EPIPE/ECONNRESET while the source or a large frame is still being
    // written) end THIS channel: a written batch counts as sent (mutation -> outcome_unknown), queued
    // batches as not sent. ChildProcess 'error' does not cover stdio stream errors.
    const broken = () => this.fail({ error: new RemoteError('remote_unavailable', 'SSH channel pipe failed', 'disconnected', true), retryable: true })
    child.stdin.on('error', broken)
    child.stdout.on('error', broken)
    child.once('error', () => this.fail({ error: new RemoteError('remote_unavailable', 'Cannot start SSH executable', 'disconnected', false), retryable: false }))
    child.once('close', code => this.exit(code))
    this.ready = new Promise<ProbeResult>((resolve, reject) => {
      const batch = this.batch([hello], false, values => {
        const response = values[0] as Record<string, any>
        if (response.ok !== true) {
          const e = response.error
          const error = new RemoteError(e?.code ?? 'protocol_mismatch', e?.reason ?? 'Invalid adapter hello', e?.status ?? 'refused', false)
          reject(new AttemptFailure(error, 'sent', false))
          this.fail({ error, retryable: false })
          return
        }
        this.established = true
        this.probe = response.result as ProbeResult
        resolve(this.probe)
        this.pump()
      }, reject)
      // Bootstrap exactly once per established channel: length-prefixed adapter source, then hello.
      this.write(batch, Buffer.concat([Buffer.from(`${SOURCE.length}\n`), SOURCE, batch.payload]))
    })
    this.ready.catch(() => {})
  }
  private batch(wires: Wire[], mutation: boolean, resolve: (values: unknown[]) => void, reject: (failure: AttemptFailure) => void, payload: Buffer = Buffer.concat(wires.map(encodeFrame))): Batch {
    return { wires, payload, mutation, values: [], written: false, settled: false, resolve, reject }
  }
  submit(wires: Wire[], payload: Buffer, mutation: boolean, signal?: AbortSignal): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      // An abort that landed between the caller's check and here must still stop the batch unsent.
      if (signal?.aborted) { reject(cancelled()); return }
      if (this.closed) { reject(new AttemptFailure(new RemoteError('remote_unavailable', 'SSH channel closed', 'disconnected', true), 'not_sent', true)); return }
      if (this.queue.length >= this.limits.max_queue) { reject(new AttemptFailure(new RemoteError('remote_busy', 'SSH request queue is full', 'refused', true), 'not_sent', false)); return }
      let batch!: Batch
      const cancel = () => {
        if (batch.settled) return
        batch.settled = true
        const index = this.queue.indexOf(batch)
        if (index >= 0) this.queue.splice(index, 1)
        // A written batch stays in flight: its late response is consumed in order and discarded.
        reject(new AttemptFailure(new RemoteError('cancelled', 'Request cancelled', 'refused', false), batch.written ? 'sent' : 'not_sent', false))
        this.pump()
      }
      batch = this.batch(wires, mutation,
        values => { signal?.removeEventListener('abort', cancel); resolve(values) },
        failure => { signal?.removeEventListener('abort', cancel); reject(failure) }, payload)
      signal?.addEventListener('abort', cancel, { once: true })
      this.queue.push(batch)
      this.pump()
    })
  }
  private pump(): void {
    if (this.closed || !this.established) return
    while (this.queue.length) {
      const next = this.queue[0]!
      if (this.inflight.some(b => b.mutation)) return
      if (next.mutation) {
        if (this.inflight.length) return
        if (Date.now() - this.last_response_at > this.limits.idle_ping_ms) { this.ping(); return }
      } else if (this.inflight.length >= this.limits.max_pipeline) return
      this.queue.shift()
      this.write(next)
    }
  }
  /** Liveness proof before a mutation on an idle channel: a dead pipe fails this unsent ping, not the mutation. */
  private ping(): void {
    this.host.pinged()
    const wire: Wire = { protocol: 1, request_id: token(), operation_id: token(), generation: null, root_id: null, method: 'probe', params: {} }
    const batch = this.batch([wire], false, values => {
      if ((values[0] as Record<string, unknown>).ok !== true) { this.fail({ error: new RemoteError('remote_unavailable', 'SSH channel liveness check failed', 'disconnected', true), retryable: true }); return }
      this.pump()
    }, () => {})
    this.write(batch, batch.payload, Math.min(this.limits.rpc_ms, 10_000))
  }
  private write(batch: Batch, bytes = batch.payload, deadline = this.limits.rpc_ms): void {
    batch.written = true
    this.inflight.push(batch)
    batch.timer = setTimeout(() => this.fail({ error: new RemoteError('remote_unavailable', 'RPC deadline elapsed; the SSH channel was closed', 'disconnected', true), retryable: true }), deadline)
    try { this.owned.child.stdin.write(bytes) }
    catch { this.fail({ error: new RemoteError('remote_unavailable', 'SSH channel write failed', 'disconnected', true), retryable: true }) }
  }
  private data(chunk: Buffer): void {
    if (this.closed) return
    try { this.decoder.feed(chunk, value => { if (!this.closed) this.frame(value) }) }
    catch (error) {
      const e = error instanceof RemoteError ? error : new RemoteError('protocol_mismatch', 'Invalid remote frame', 'unknown', false)
      this.fail({ error: e, retryable: false })
    }
  }
  /** Responses arrive in write order; each must carry exactly the identity of the wire it answers. */
  private frame(value: unknown): void {
    const batch = this.inflight[0]
    if (!batch) { this.fail({ error: new RemoteError('protocol_mismatch', 'Unexpected extra frame', 'unknown', false), retryable: false }); return }
    const wire = batch.wires[batch.values.length]!, response = value as Record<string, unknown> | null
    if (!response || typeof response !== 'object' || IDENTITY.some(key => response[key] !== wire[key])) {
      this.fail({ error: new RemoteError('protocol_mismatch', 'Response identity mismatch', 'unknown', false), retryable: false })
      return
    }
    batch.values.push(response)
    if (batch.values.length < batch.wires.length) return
    this.inflight.shift(); clearTimeout(batch.timer)
    this.last_response_at = Date.now(); this.served++
    // A complete definite response wins even if ssh exits right after it.
    if (!batch.settled) { batch.settled = true; batch.resolve(batch.values) }
    this.pump()
  }
  private exit(code: number | null): void {
    if (this.closed) return
    const error = this.established
      ? new RemoteError('remote_unavailable', 'SSH exec channel closed', 'disconnected', true)
      : code === 255 ? this.host.classify(this.stderr) : new RemoteError('remote_unavailable', 'SSH exec channel ended before the adapter answered', 'disconnected', true)
    this.fail({ error, retryable: error.code === 'remote_unavailable' })
  }
  fail(reason: Reason): void {
    if (this.closed) return
    this.closed = true
    for (const batch of [...this.inflight.splice(0), ...this.queue.splice(0)]) {
      clearTimeout(batch.timer)
      if (batch.settled) continue
      batch.settled = true
      batch.reject(new AttemptFailure(reason.error, batch.written ? 'sent' : 'not_sent', reason.retryable))
    }
    try { this.owned.child.stdin.end() } catch { /* already closed */ }
    void this.host.terminate(this.owned)
    this.host.closed(this, reason)
  }
}

/** Only invokes the system OpenSSH client. No private-key/config file reads, no local fs interpretation of remote paths. */
/** The options every ssh this app runs for a target is given (the transport's channel, a port forward, `ssh -G` when
 *  the app checks the host key). Never the person's own ssh_config (or the system one): -F /dev/null unless a config
 *  file is passed explicitly (isolated test sshd). Command-line options take precedence over any config. Never log
 *  ssh -G or expanded configuration. */
export function sshArgs(target: SshTargetConfig, options: TransportOptions): string[] {
  const args = ['-F', options.config_file ?? '/dev/null', '-T', '-o','BatchMode=yes', '-o','StrictHostKeyChecking=yes', '-o','ForwardAgent=no',
    '-o','ForwardX11=no', '-o','ForwardX11Trusted=no', '-o','PermitLocalCommand=no', '-o','ClearAllForwardings=yes',
    '-o','UpdateHostKeys=no', '-o','CheckHostIP=no', '-o','ControlMaster=no', '-o','ControlPath=none', '-o','ControlPersist=no',
    '-o','ForkAfterAuthentication=no', '-o','RequestTTY=no', '-o','StdinNull=no', '-o','RemoteCommand=none',
    '-o','SessionType=default', '-o','ConnectTimeout=10', '-o','ServerAliveInterval=5', '-o','ServerAliveCountMax=3']
  if (options.known_hosts_file) args.push('-o', `UserKnownHostsFile=${options.known_hosts_file}`, '-o','GlobalKnownHostsFile=/dev/null', '-o','IdentitiesOnly=yes')
  // the person's own files first (ssh's defaults), then the keys they trusted in the app
  else if (options.app_known_hosts_file) args.push('-o', `UserKnownHostsFile=~/.ssh/known_hosts ~/.ssh/known_hosts2 "${options.app_known_hosts_file}"`)
  if (target.identity_file) args.push('-i', target.identity_file)
  if (target.port != null) args.push('-p', String(target.port))
  return args
}

export class SshTransport {
  private readonly ssh: string
  private readonly python: string
  private readonly rpcMs: number
  private readonly retry: RetryPolicy
  private readonly limits: ChannelLimits
  private readonly children = new Set<OwnedChild>()
  private readonly forwards = new Map<string, ForwardEntry>()
  private readonly channels = new Set<Channel>()
  private readonly sleepers = new Set<() => void>()
  private readonly counters = { challenges: 0, channels_opened: 0, channel_failures: 0, requests: 0, retries: 0, pings: 0 }
  private readonly host: ChannelHost = {
    terminate: owned => this.terminate(owned),
    classify: stderr => this.classify(stderr),
    closed: (channel, reason) => this.channelClosed(channel, reason),
    pinged: () => { this.counters.pings++ },
  }
  private channel?: Channel
  private opening?: Promise<Channel>
  private probing?: Promise<ProbeResult>
  private lastFailure: string | null = null
  private disconnected = false
  constructor(readonly target: SshTargetConfig, readonly options: TransportOptions = {}) {
    if (!target.destination || target.destination.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(target.destination)) throw new RemoteError('invalid_argument', 'Invalid SSH destination')
    if (target.port != null) this.port(target.port)
    for (const value of [target.identity_file, options.config_file, options.known_hosts_file, options.app_known_hosts_file, options.ssh_path, options.python]) {
      if (value != null && (!value || /[\x00-\x1f\x7f]/.test(value))) throw new RemoteError('invalid_argument', 'Invalid executable/config/identity path')
    }
    // quoted in UserKnownHostsFile: a quote in it would end the path early
    if (options.app_known_hosts_file?.includes('"')) throw new RemoteError('invalid_argument', 'Invalid known_hosts path')
    this.ssh = options.ssh_path ?? '/usr/bin/ssh'; this.python = options.python ?? 'python3'
    if (!this.ssh.startsWith('/')) throw new RemoteError('invalid_argument', 'SSH executable must be absolute')
    if (options.rpc_timeout_ms != null && (!Number.isFinite(options.rpc_timeout_ms) || options.rpc_timeout_ms <= 0)) throw new RemoteError('invalid_argument', 'RPC timeout must be positive')
    const rpcMs = options.rpc_timeout_ms ?? 30_000
    const retry: RetryPolicy = { ...DEFAULT_RETRY, budget_ms: rpcMs + DEFAULT_BUDGET_SLACK_MS, ...options.retry }
    if (!Number.isInteger(retry.attempts) || retry.attempts < 1 || retry.attempts > 20 || !(retry.budget_ms > 0) ||
      [retry.base_delay_ms, retry.max_delay_ms, retry.budget_ms].some(v => !Number.isFinite(v) || v < 0)) throw new RemoteError('invalid_argument', 'Invalid retry policy')
    for (const value of [options.idle_ping_ms, options.max_pipeline]) if (value != null && (!Number.isFinite(value) || value < 0)) throw new RemoteError('invalid_argument', 'Invalid channel option')
    this.rpcMs = rpcMs
    this.retry = retry
    this.limits = { rpc_ms: this.rpcMs, idle_ping_ms: options.idle_ping_ms ?? 5_000, max_pipeline: Math.max(1, Math.floor(options.max_pipeline ?? 8)), max_queue: 1024 }
  }
  private port(value: number): void { if (!Number.isInteger(value) || value < 1 || value > 65535) throw new RemoteError('invalid_argument', 'Invalid port') }
  private args(): string[] { return sshArgs(this.target, this.options) }
  private async identity(pid: number): Promise<string | null> {
    try { return (await exec('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='])).stdout.trim() || null }
    catch { return null }
  }
  private launch(args: string[]): OwnedChild {
    if (this.disconnected) throw new RemoteError('remote_unavailable', 'Transport disconnected', 'disconnected', true)
    const child = spawn(this.ssh, args, {stdio: ['pipe','pipe','pipe']})
    const command = [this.ssh, ...args].join(' ')
    const owned: OwnedChild = {child, command, identity: child.pid ? this.identity(child.pid) : Promise.resolve(null)}
    this.children.add(owned)
    child.once('close', () => this.children.delete(owned))
    // Never print command/config/stderr or inherited environment. No stdio stream error may become
    // an uncaught event; owners add their own handlers (channel failure, forward socket disposal).
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => {})
    return owned
  }
  private async terminate(owned: OwnedChild): Promise<void> {
    const child = owned.child
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
    const initial = await owned.identity, current = await this.identity(child.pid)
    // Only the exact recorded PID/start/command of this launch; no pattern/cwd/global kill.
    if (initial && current === initial && current.endsWith(owned.command)) child.kill('SIGTERM')
  }
  private classify(stderr: string): RemoteError {
    if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/.test(stderr)) return new RemoteError('host_verification_required','SSH host verification required','refused',false)
    if (/Permission denied|Authentication failed/.test(stderr)) return new RemoteError('auth_required','SSH authentication required','refused',false)
    return new RemoteError('remote_unavailable','SSH exec connection failed','disconnected',true)
  }
  private channelClosed(channel: Channel, reason: Reason): void {
    this.channels.delete(channel)
    if (this.channel === channel) this.channel = undefined
    if (!this.disconnected) { this.counters.channel_failures++; this.lastFailure = reason.error.code }
  }
  private alive(signal?: AbortSignal): void {
    if (this.disconnected) throw new AttemptFailure(new RemoteError('remote_unavailable', 'Transport disconnected', 'disconnected', true), 'not_sent', false)
    if (signal?.aborted) throw new AttemptFailure(new RemoteError('cancelled', 'Request cancelled', 'refused', false), 'not_sent', false)
  }
  /** Equal jitter: half the exponential ceiling plus a random half; never zero, never above max. */
  private delay(attempt: number): number {
    const ceiling = Math.min(this.retry.max_delay_ms, this.retry.base_delay_ms * 2 ** (attempt - 1))
    return ceiling / 2 + Math.random() * ceiling / 2
  }
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const wake = () => { clearTimeout(timer); this.sleepers.delete(wake); signal?.removeEventListener('abort', wake); resolve() }
      const timer = setTimeout(wake, ms)
      this.sleepers.add(wake)
      signal?.addEventListener('abort', wake, { once: true })
    })
  }
  /** Bounded backoff for transport failures. A sent mutation is never resent: it becomes outcome_unknown
   * with its original operation_id. Auth, host verification, protocol and definite remote refusals are
   * never retried. disconnect()/abort end pending backoff at once and never start another attempt. */
  private async withRetry<T>(run: () => Promise<T>, mutation: boolean, op: string | undefined, scope?: Scope): Promise<T> {
    const started = Date.now(), signal = scope?.signal
    let sent = false
    for (let attempt = 1; ; attempt++) {
      let failure: AttemptFailure
      try { this.alive(signal); return await run() }
      catch (error) {
        if (!(error instanceof AttemptFailure)) throw error
        failure = error
      }
      sent ||= failure.delivery === 'sent'
      const e = failure.error, expired = !!scope?.expired() && !this.disconnected
      if (mutation && failure.delivery === 'sent') {
        const why = expired ? 'Request deadline elapsed after the mutation was sent' : e.message
        throw new RemoteError('outcome_unknown', `${why}; the mutation may have been applied: query operation_id, never replay mutation`, 'unknown', true, op, 'unknown')
      }
      const exhausted = attempt >= this.retry.attempts || Date.now() - started >= this.retry.budget_ms
      if (!failure.retryable || exhausted || this.disconnected || signal?.aborted) {
        if (expired && (e.code === 'cancelled' || failure.retryable)) throw new RemoteError('remote_unavailable', `Request deadline elapsed${sent ? '' : ' before the request was sent'}`, 'disconnected', true, op, sent ? 'unknown' : 'not_sent')
        const suffix = failure.retryable && exhausted && attempt > 1 ? ` (after ${attempt} attempts)` : ''
        throw new RemoteError(e.code, e.message + suffix, e.status, e.retryable, op, sent ? 'unknown' : 'not_sent')
      }
      this.counters.retries++
      await this.sleep(this.delay(attempt), signal)
    }
  }
  /** Every public call settles within retry.budget_ms (default rpc_timeout_ms + 15 s), queue wait,
   * establishment, attempts and backoff included. On expiry an unsent batch is withdrawn (not_sent);
   * a sent mutation becomes outcome_unknown and is never resent; its late answer is discarded. */
  private scope(signal?: AbortSignal): Scope {
    const controller = new AbortController()
    let expired = false
    const forward = () => controller.abort()
    const timer = setTimeout(() => { expired = true; controller.abort() }, this.retry.budget_ms)
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', forward, { once: true })
    return { signal: controller.signal, expired: () => expired, dispose: () => { clearTimeout(timer); signal?.removeEventListener('abort', forward) } }
  }
  private until<T>(promise: Promise<T>, scope: Scope, op?: string): Promise<T> {
    const stop = () => scope.expired()
      ? new RemoteError('remote_unavailable', 'Request deadline elapsed before the request was sent', 'disconnected', true, op, 'not_sent')
      : new RemoteError('cancelled', 'Request cancelled', 'refused', false, op, 'not_sent')
    if (scope.signal.aborted) return Promise.reject(stop())
    return new Promise((resolve, reject) => {
      const abort = () => reject(stop())
      scope.signal.addEventListener('abort', abort, { once: true })
      promise.then(value => { scope.signal.removeEventListener('abort', abort); resolve(value) }, error => { scope.signal.removeEventListener('abort', abort); reject(error) })
    })
  }
  private async scoped<T>(signal: AbortSignal | undefined, body: (scope: Scope) => Promise<T>, op?: string): Promise<T> {
    const scope = this.scope(signal)
    try { await this.until(this.probe(), scope, op); return await body(scope) }
    finally { scope.dispose() }
  }
  private ensureChannel(signal?: AbortSignal): Promise<Channel> {
    if (this.channel && !this.channel.closed) return Promise.resolve(this.channel)
    if (signal?.aborted) return Promise.reject(cancelled())
    if (!this.opening) {
      const opening = this.establish()
      this.opening = opening
      opening.then(() => {}, () => {}).finally(() => { if (this.opening === opening) this.opening = undefined })
    }
    const opening = this.opening
    if (!signal) return opening
    if (signal.aborted) return Promise.reject(cancelled())
    return new Promise((resolve, reject) => {
      const cancel = () => reject(cancelled())
      signal.addEventListener('abort', cancel, { once: true })
      opening.then(channel => { signal.removeEventListener('abort', cancel); resolve(channel) }, error => { signal.removeEventListener('abort', cancel); reject(error) })
    })
  }
  private async establish(): Promise<Channel> {
    let owned: OwnedChild
    try { owned = this.launch([...this.args(), this.target.destination, `${quote(this.python)} -B -I -u -c ${quote(BOOTSTRAP)}`]) }
    catch (error) { throw new AttemptFailure(error as RemoteError, 'not_sent', false) }
    this.counters.channels_opened++
    const channel = new Channel(this.host, owned, this.wire('probe', {}), this.limits)
    this.channels.add(channel)
    try { await channel.ready }
    catch (error) {
      // Establishment never carried a caller's batch: nothing of it was sent.
      const failure = error as AttemptFailure
      throw new AttemptFailure(failure.error, 'not_sent', failure.retryable)
    }
    if (this.disconnected) {
      const error = new RemoteError('remote_unavailable', 'Transport disconnected', 'disconnected', true)
      channel.fail({ error, retryable: false })
      throw new AttemptFailure(error, 'not_sent', false)
    }
    this.channel = channel
    return channel
  }
  private async call(wires: Wire[], scope: Scope): Promise<unknown[]> {
    const signal = scope.signal
    const mutation = wires.some(w => MUTATIONS.has(w.method)), op = wires.at(-1)!.operation_id
    let payload: Buffer = Buffer.concat(wires.map(encodeFrame)) // oversize is a definite, unsent refusal
    let attempt = 0
    const values = await this.withRetry(async () => {
      const channel = await this.ensureChannel(signal)
      // A retried read gets fresh request identities: no response to an earlier attempt can satisfy it.
      const sent = attempt++ === 0 ? wires : wires.map(w => ({ ...w, request_id: token() }))
      if (sent !== wires) payload = Buffer.concat(sent.map(encodeFrame))
      this.counters.requests++
      return await channel.submit(sent, payload, mutation, signal)
    }, mutation, op, scope)
    return values.map((v, index) => {
      const response = v as Record<string, any>, wire = wires[index]!
      if (response.ok !== true) {
        const e = response.error
        throw new RemoteError(e?.code ?? 'protocol_mismatch', e?.reason ?? 'Invalid response', e?.status ?? 'unknown', !!e?.retryable, wire.operation_id)
      }
      return response.result
    })
  }
  private wire(method: string, params: unknown, root?: RootRef, op = token()): Wire {
    return {protocol: 1, request_id: token(), operation_id: op, generation: root?.generation ?? null, root_id: root?.root_id ?? null, method, params}
  }
  private challenge(signal: AbortSignal): Promise<void> {
    this.counters.challenges++
    // Challenge verifies exec, clean stdout AND a real nonzero SSH exit status; no state is created.
    const nonce = token(), command = `${quote(this.python)} -B -I -c ${quote(`import sys;sys.stdout.write(${JSON.stringify(nonce)});sys.exit(17)`)}`
    let owned: OwnedChild
    try { owned = this.launch([...this.args(), this.target.destination, command]) }
    catch (error) { return Promise.reject(new AttemptFailure(error as RemoteError, 'not_sent', false)) }
    const child = owned.child
    return new Promise<void>((resolve, reject) => {
      let stdout = '', stderr = '', settled = false
      const finish = (failure?: AttemptFailure) => {
        if (settled) return
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
        if (failure) reject(failure); else resolve()
      }
      // Silence is NOT evidence of an unsupported exec: a partition looks the same. Retry within the bound.
      const timer = setTimeout(() => { void this.terminate(owned); finish(new AttemptFailure(new RemoteError('remote_unavailable','SSH exec challenge timed out','disconnected',true), 'not_sent', true)) }, this.rpcMs)
      const abort = () => { void this.terminate(owned); finish(cancelled()) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      child.stdin.end()
      child.stdout.on('data', (b: Buffer) => { stdout = (stdout + b.toString()).slice(0, 1024) })
      child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-8192) })
      child.once('error', () => finish(new AttemptFailure(new RemoteError('remote_unavailable','Cannot start SSH executable'), 'not_sent', false)))
      child.once('close', (code, killed) => {
        if (this.disconnected) finish(new AttemptFailure(new RemoteError('remote_unavailable', 'Transport disconnected', 'disconnected', true), 'not_sent', false))
        else if (code === 17 && stdout === nonce) finish()
        else if (code === 255) { const error = this.classify(stderr); finish(new AttemptFailure(error, 'not_sent', error.code === 'remote_unavailable')) }
        else if (code === null || killed) finish(new AttemptFailure(new RemoteError('remote_unavailable','SSH exec challenge was interrupted','disconnected',true), 'not_sent', true))
        // Only a definite wrong exit status or polluted stdout means the exec transport is unsupported.
        else finish(new AttemptFailure(new RemoteError('unsupported_transport','Remote requires clean exec with accurate nonzero exit status'), 'not_sent', false))
      })
    })
  }
  /** Shared and cached once it succeeds. One probe attempt (challenge + channel hello, with retries) has
   * its own total bound of retry.budget_ms from its start; a caller joining it waits at most its own bound. */
  async probe(options: RequestOptions = {}): Promise<ProbeResult> {
    if (!this.probing) this.probing = this.doProbe().catch(error => { this.probing = undefined; throw error })
    if (!options.signal) return this.probing
    const scope = this.scope(options.signal)
    try { return await this.until(this.probing, scope) } finally { scope.dispose() }
  }
  private async doProbe(): Promise<ProbeResult> {
    const scope = this.scope()
    try {
      await this.withRetry(() => this.challenge(scope.signal), false, undefined, scope)
      // The channel's hello IS the adapter probe; the channel stays open for every later request.
      const channel = await this.withRetry(() => this.ensureChannel(scope.signal), false, undefined, scope)
      return channel.probe!
    } finally { scope.dispose() }
  }
  /** Fresh liveness for status/health: one framed `probe` round trip on the owned channel (a new
   * channel only if none is open), never a cached result and never a separate throwaway handshake. */
  async check(options: RequestOptions = {}): Promise<ProbeResult> {
    return this.scoped(options.signal, async scope => (await this.call([this.wire('probe', {})], scope))[0] as ProbeResult)
  }
  async listDirs(path: string, options: RequestOptions = {}): Promise<DirectoryPage> {
    return this.scoped(options.signal, async scope => (await this.call([this.wire('listDirs',{path})], scope))[0] as DirectoryPage)
  }
  async openRoot(input: {path: string; state_path?: string; expected_root_id?: string; expected_generation?: string}, options: RequestOptions = {}): Promise<RemoteRoot> {
    return this.scoped(options.signal, async scope => (await this.call([this.wire('openRoot',input)], scope))[0] as RemoteRoot)
  }
  /** root needs only path/state_path/root_id/generation: a persisted binding can be passed directly;
   * the pinned openRoot travels in the SAME batch and its answer must carry the same identity. */
  async request<M extends RemoteMethod>(root: RootRef, method: M, params: MethodParams[M], operation_id?: string, options: RequestOptions = {}): Promise<MethodResults[M]> {
    if (MUTATIONS.has(method) && (!operation_id || !/^[A-Za-z0-9_-]{1,128}$/.test(operation_id))) throw new RemoteError('invalid_argument','Mutations require a persisted operation_id')
    const values = await this.scoped(options.signal, scope => this.call([this.wire('openRoot',{path: root.path, state_path: root.state_path, expected_root_id: root.root_id, expected_generation: root.generation}), this.wire(method,params,root,operation_id)], scope), operation_id)
    const pinned = values[0] as Partial<RemoteRoot> | null
    if (pinned?.root_id !== root.root_id || pinned?.generation !== root.generation) throw new RemoteError('protocol_mismatch','Pinned root answer differs from the request identity','unknown',false,operation_id)
    return values[1] as MethodResults[M]
  }
  /** Diagnostics only (counts, local ssh PID, channel age); no command, path, key or stderr content. */
  stats(): TransportStats {
    const channel = this.channel && !this.channel.closed ? this.channel : undefined
    return { ...this.counters, disconnected: this.disconnected, last_failure: this.lastFailure,
      channel: channel ? { pid: channel.owned.child.pid ?? null, opened_at: new Date(channel.opened_at).toISOString(), batches: channel.served, idle_ms: Date.now() - channel.last_response_at } : null }
  }
  /** The listener is ours; each accepted socket uses SSH -W, whose forward destination is fixed.
   * ClearAllForwardings=yes suppresses config forwards without clearing our Node listener/-W channel. */
  async openForward(remote_port: number): Promise<OwnedForward> {
    this.port(remote_port)
    if (FORBIDDEN_PORTS.has(remote_port)) throw new RemoteError('invalid_argument','Reserved application/test port is not a forwarding target')
    await this.probe()
    const value: OwnedForward = {id: token(), remote_host:'127.0.0.1', remote_port, local_host:'127.0.0.1', local_port:0, local_url:'', state:'disconnected'}
    const entry: ForwardEntry = {value, server:createServer(), sockets:new Set(), children:new Set()}
    this.forwards.set(value.id, entry)
    try { await this.listenForward(entry); return {...entry.value} }
    catch (error) { this.forwards.delete(value.id); throw error }
  }
  private async listenForward(entry: ForwardEntry): Promise<void> {
    entry.server = createServer(socket => {
      entry.sockets.add(socket)
      let owned: OwnedChild
      try { owned = this.launch([...this.args(), '-W', `127.0.0.1:${entry.value.remote_port}`, this.target.destination]) }
      catch { socket.destroy(); return }
      entry.children.add(owned)
      const child = owned.child
      child.stderr.resume() // Do not reflect sensitive SSH diagnostics into browser data or logs.
      socket.pipe(child.stdin); child.stdout.pipe(socket)
      socket.on('error', () => {})
      child.stdout.once('error', () => socket.destroy())
      socket.once('close', () => { entry.sockets.delete(socket); child.stdin.end(); void this.terminate(owned) })
      child.once('error', () => { entry.value.state='error'; socket.destroy() })
      child.once('close', code => { entry.children.delete(owned); if (code !== 0) entry.value.state='error'; socket.destroy() })
    })
    await new Promise<void>((resolve,reject) => { entry.server.once('error',reject); entry.server.listen(0,'127.0.0.1',() => { entry.server.removeListener('error',reject); resolve() }) })
    const address = entry.server.address()
    if (!address || typeof address === 'string') throw new RemoteError('remote_unavailable','Loopback listener failed')
    if (FORBIDDEN_PORTS.has(address.port)) { await new Promise<void>(r => entry.server.close(() => r())); return this.listenForward(entry) }
    entry.value.local_port = address.port; entry.value.local_url = `http://127.0.0.1:${address.port}`; entry.value.state='ready'
    entry.server.on('error', () => { entry.value.state='error' })
  }
  listForwards(): OwnedForward[] { return [...this.forwards.values()].map(e => ({...e.value})) }
  async reconnectForward(id: string): Promise<OwnedForward> {
    const entry = this.forwards.get(id)
    if (!entry) throw new RemoteError('invalid_argument','Unknown owned forward')
    await this.stopForward(entry)
    await this.probe()
    await this.listenForward(entry)
    return {...entry.value}
  }
  private async stopForward(entry: ForwardEntry): Promise<void> {
    for (const socket of entry.sockets) socket.destroy()
    await Promise.all([...entry.children].map(p => this.terminate(p)))
    if (entry.server.listening) await new Promise<void>(resolve => entry.server.close(() => resolve()))
    entry.value.state='disconnected'
  }
  async closeForward(id: string): Promise<boolean> { const entry=this.forwards.get(id); if (!entry) return false; await this.stopForward(entry); this.forwards.delete(id); return true }
  /** Closes only this transport's own SSH children and listeners; remote durable jobs keep running.
   * Pending backoff ends at once, queued/in-flight requests fail, and nothing reconnects afterwards. */
  async disconnect(): Promise<void> {
    this.disconnected = true
    for (const wake of [...this.sleepers]) wake()
    const reason = { error: new RemoteError('remote_unavailable', 'Transport disconnected', 'disconnected', true), retryable: false }
    for (const channel of [...this.channels]) channel.fail(reason)
    this.channel = undefined
    await Promise.all([...this.forwards.values()].map(e => this.stopForward(e)))
    this.forwards.clear()
    await Promise.all([...this.children].map(p => this.terminate(p)))
  }
}
