import { cohortOfRun, parseCohort, sameCohort } from '../workspace/cohort.ts'
import { RemoteError, type BytePage, type LeaseProof, type MethodParams, type MethodResults, type RemoteJob, type RemoteMethod } from '../remote/types.ts'

/** Bind this to the existing remote service and the persisted root. No transport is owned here. */
export type RemoteJobRpc = <M extends RemoteMethod>(method: M, params: MethodParams[M], operation_id?: string) => Promise<MethodResults[M]>
export interface RemoteExecutionIdentity { target_id: string; root_id: string; generation: string; path: string; state_path: string }
export type RemoteExecutionSpec = MethodParams['jobs.start'] & { operation_id: string }
export interface RemoteExecutionState {
  version: 1
  identity: RemoteExecutionIdentity
  spec: RemoteExecutionSpec
  job_id: string | null
  start_attempted: boolean
  connection_state: 'connected' | 'disconnected' | 'unknown'
  job: RemoteJob | null
  writer_pinned: boolean
  cursors: { stdout: number; stderr: number }
  /** delivery 'not_sent': the transport proved no byte of the request reached ssh (a start that certainly never ran) */
  last_error: { code: string; message: string; delivery?: 'not_sent' | 'unknown' } | null
}
export interface RemoteObservation {
  state: RemoteExecutionState
  /** Only this fresh query may generate an end event; stale cached terminal state is not a new event. */
  terminal_confirmed: boolean
  /** Silence requires watch-layer continuity/timing; no RPC result alone establishes it. */
  silence_confirmed: false
}
export type RemoteOutput =
  | { available: true; stream: 'stdout' | 'stderr'; page: BytePage; state: RemoteExecutionState }
  | { available: false; stream: 'stdout' | 'stderr'; outcome: 'unknown'; state: RemoteExecutionState }
export type PersistRemoteExecution = (state: RemoteExecutionState) => Promise<void>
const copy = <T>(value: T): T => structuredClone(value)

export function createRemoteExecutionState(identity: RemoteExecutionIdentity, spec: RemoteExecutionSpec): RemoteExecutionState {
  if (!spec.operation_id) throw new Error('A durable operation_id is required')
  return { version: 1, identity: copy(identity), spec: copy({ ...spec, timeout_s: spec.timeout_s ?? null, output_cap_bytes: spec.output_cap_bytes ?? null }),
    job_id: null, start_attempted: false, connection_state: 'unknown', job: null, writer_pinned: true,
    cursors: { stdout: 0, stderr: 0 }, last_error: null }
}

/** One instance per execution. Persist its intent before any remote mutation. Restored attempted
 * executions ONLY query, even when the remote operation mapping is missing. Lease ownership,
 * access checks and atomic output storage remain the integration layer's responsibility. */
export class RemoteJobController {
  private state: RemoteExecutionState
  private tail: Promise<unknown> = Promise.resolve()
  private delivered: { stdout: number; stderr: number }
  constructor(private readonly rpc: RemoteJobRpc, state: RemoteExecutionState, private readonly persist: PersistRemoteExecution) {
    if (state.version !== 1) throw new Error('Unsupported remote execution recovery version')
    this.state = copy(state)
    this.delivered = copy(state.cursors)
  }
  snapshot(): RemoteExecutionState { return copy(this.state) }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn)
    this.tail = next.catch(() => {})
    return next
  }
  private async save(): Promise<void> { await this.persist(this.snapshot()) }
  private observation(terminal = false): RemoteObservation {
    return { state: this.snapshot(), terminal_confirmed: terminal, silence_confirmed: false }
  }
  private accept(job: RemoteJob): void {
    if (job.operation_id !== this.state.spec.operation_id || !job.job_id || (this.state.job_id && job.job_id !== this.state.job_id)) {
      throw new RemoteError('protocol_mismatch', 'Remote job identity differs from durable execution', 'unknown')
    }
    if (!['starting', 'running', 'unknown', 'exited'].includes(job.state)) throw new RemoteError('protocol_mismatch', 'Invalid remote job state', 'unknown')
    if (job.state === 'exited' && (job.terminal_confirmed === false || !((Number.isSafeInteger(job.exit_code) && job.exit_code! >= 0) || (Number.isSafeInteger(job.signal) && job.signal! > 0)))) {
      throw new RemoteError('outcome_unknown', 'Remote exit record has no trustworthy exit code or signal', 'unknown')
    }
    // Never replace a durable exit record with an older start/stop receipt.
    if (this.state.job?.state !== 'exited') this.state.job = copy(job)
    this.state.job_id = job.job_id
    this.state.connection_state = 'connected'
    this.state.writer_pinned = this.state.job?.state !== 'exited'
    this.state.last_error = job.state === 'unknown' ? { code: 'outcome_unknown', message: job.reason ?? 'Remote outcome unknown' } : null
  }
  private failed(error: unknown): void {
    const e = error as { code?: string; message?: string; status?: string; delivery?: 'not_sent' | 'unknown' }
    this.state.connection_state = e.status === 'disconnected' || ['remote_disconnected', 'remote_unavailable', 'disconnected'].includes(e.code ?? '') ? 'disconnected' : 'unknown'
    this.state.last_error = { code: e.code ?? 'outcome_unknown', message: e.message ?? 'Remote outcome unknown', ...(e.delivery ? { delivery: e.delivery } : {}) }
    this.state.writer_pinned = this.state.job?.state !== 'exited'
  }
  private async query(): Promise<RemoteObservation> {
    // Entering recovery permanently closes the execution path, including missing mappings.
    this.state.start_attempted = true
    await this.save()
    let terminal = false
    try {
      const job = this.state.job_id
        ? await this.rpc('jobs.status', { job_id: this.state.job_id })
        : await this.rpc('jobs.recover', { operation_id: this.state.spec.operation_id })
      this.accept(job); terminal = job.state === 'exited'
    } catch (error) { this.failed(error) }
    await this.save()
    return this.observation(terminal)
  }
  start(): Promise<RemoteObservation> {
    return this.serial(async () => {
      if (this.state.start_attempted || this.state.job_id) return this.query()
      // If save fails we still prohibit another start in this instance. A fresh instance may
      // retry ONLY from the durable state, which cannot contain a remotely sent intent yet.
      this.state.start_attempted = true
      await this.save()
      const { operation_id, ...params } = this.state.spec
      let terminal = false
      try { const job = await this.rpc('jobs.start', params, operation_id); this.accept(job); terminal = job.state === 'exited' }
      catch (error) { this.failed(error) }
      await this.save()
      return this.observation(terminal)
    })
  }
  status(): Promise<RemoteObservation> { return this.serial(() => this.query()) }
  reconnect(): Promise<RemoteObservation> { return this.status() }
  disconnect(): Promise<RemoteObservation> {
    return this.serial(async () => { this.state.connection_state = 'disconnected'; await this.save(); return this.observation() })
  }
  output(stream: 'stdout' | 'stderr', byte_offset?: number, limit?: number): Promise<RemoteOutput> {
    return this.serial(async () => {
      const offset = byte_offset ?? this.state.cursors[stream]
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid output byte offset')
      const pageLimit = Math.min(limit ?? PAGE_BYTES, PAGE_BYTES)
      if (!Number.isSafeInteger(pageLimit) || pageLimit < 1) throw new Error('Invalid output page limit')
      let page: BytePage | undefined
      try {
        if (!this.state.job_id) throw new RemoteError('outcome_unknown', 'Recover job identity before reading output', 'unknown')
        page = await this.rpc('jobs.read', { job_id: this.state.job_id, stream, byte_offset: offset, limit: pageLimit })
        const bytes = Buffer.from(page.data, 'base64')
        if (bytes.length > pageLimit || bytes.toString('base64') !== page.data || page.byte_offset !== offset || page.next_offset !== offset + bytes.length ||
          !Number.isSafeInteger(page.next_offset) || typeof page.eof !== 'boolean' ||
          !Number.isSafeInteger(page.total_written) || !Number.isSafeInteger(page.total_retained) ||
          page.total_retained < 0 || page.total_written < page.total_retained ||
          (bytes.length > 0 && page.next_offset > page.total_retained) ||
          (page.eof && page.next_offset < page.total_retained) ||
          (bytes.length === 0 && offset < page.total_retained) || !Array.isArray(page.gaps) ||
          page.gaps.some((g, i) => !Number.isSafeInteger(g.start) || !Number.isSafeInteger(g.end) || g.start < page!.total_retained ||
            g.end <= g.start || g.end > page!.total_written || (i > 0 && page!.gaps[i - 1]!.end > g.start))) {
          throw new RemoteError('protocol_mismatch', 'Invalid remote output byte cursor or loss metadata', 'unknown')
        }
        if (page.total_written > page.total_retained && !page.gaps.some(g => g.start <= page!.total_retained && g.end === page!.total_written)) {
          throw new RemoteError('log_gap', 'Remote output loss has no explicit gap range', 'unknown')
        }
        this.state.connection_state = 'connected'; this.state.last_error = null
      } catch (error) { page = undefined; this.failed(error) }
      await this.save()
      if (page && offset <= this.delivered[stream]) this.delivered[stream] = Math.max(this.delivered[stream], page.next_offset)
      return page ? { available: true, stream, page, state: this.snapshot() } : { available: false, stream, outcome: 'unknown', state: this.snapshot() }
    })
  }
  /** Caller must durably store/dedupe bytes before acknowledging. Explicit historical reads
   * do not rewind this cursor. Do not use characters or base64 length as byte offsets. */
  acknowledgeOutput(stream: 'stdout' | 'stderr', next_offset: number): Promise<void> {
    return this.serial(async () => {
      if (!Number.isSafeInteger(next_offset) || next_offset < this.state.cursors[stream] || next_offset > this.delivered[stream]) throw new Error('Output cursor must acknowledge contiguous delivered bytes monotonically')
      const next = this.snapshot(); next.cursors[stream] = next_offset
      await this.persist(copy(next)); this.state = next
    })
  }
  stop(operation_id: string, signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT' = 'SIGTERM'): Promise<RemoteObservation> {
    return this.serial(async () => {
      if (!operation_id || operation_id === this.state.spec.operation_id) throw new Error('A distinct durable stop operation_id is required')
      let terminal = false
      try {
        if (!this.state.job_id) throw new RemoteError('outcome_unknown', 'Recover job identity before stopping', 'unknown')
        const result = await this.rpc('jobs.stop', { job_id: this.state.job_id, signal }, operation_id)
        this.accept(result.job); terminal = result.job.state === 'exited'
      } catch (error) { this.failed(error) }
      await this.save(); return this.observation(terminal)
    })
  }
}

// The product integration boundary follows docs/ssh-remote/DRIVER-HANDOFF.md.
import type { Execution, Workspace, RemoteWorkspaceBinding } from '@oasis-code/contract'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import type { ProcessSpec } from './processes.ts'
import { hostRestricted } from './isolation.ts'
import { remoteBinding, remotePath } from '../workspace/remote_files.ts'
import type { RemoteWorkspaceService } from '../workspace/remote.ts'
import { newId } from '../ids.ts'

export interface RemoteDriverCallbacks {
  onOutput?(event: { execution_id: string; stream: 'stdout' | 'stderr'; offset: number; bytes: Buffer }): void
  onEnd?(execution_id: string): void
  onConnection?(execution_id: string, connected: boolean): void
}
interface DurableDriverRecord {
  version: 1
  state: RemoteExecutionState
  lease_operation_id: string
  release_operation_id: string
  stop_operation_id: string | null
  finalized: boolean
  start_refused?: boolean
  lease_released: boolean
  /** Missing on v1 records predating run borrowing means this job owns its lease. */
  lease_ownership?: 'owned' | 'borrowed'
  eof: { stdout: boolean; stderr: boolean }
  pages: { stdout: BytePage | null; stderr: BytePage | null }
  preview: { stdout: string; stderr: string } // bounded base64 bytes, never full logs
  log_incomplete: boolean
  last_output_at: string | null
}
const PAGE_BYTES = 256 * 1024
const PREVIEW_BYTES = 2000
function synchronous(value: unknown): void {
  if (value && typeof (value as { then?: unknown }).then === 'function') throw new Error('Remote driver callbacks must be synchronous DB transactions')
}

/** Owns remote_jobs persistence and watch callbacks; never owns an SSH transport or local PID. */
export class RemoteExecutionDriver {
  private readonly conn: Conn
  private readonly remote: RemoteWorkspaceService
  private readonly callbacks: RemoteDriverCallbacks
  private readonly pollMs: number
  private readonly owned = new Set<string>()
  private readonly flights = new Map<string, Promise<void>>()
  private readonly waiters = new Map<string, Set<{ resolve: (value: Execution | null) => void; timer?: ReturnType<typeof setTimeout> }>>()
  private timer?: ReturnType<typeof setInterval>
  private closed = false
  constructor(options: { conn: Conn; remote: RemoteWorkspaceService; callbacks?: RemoteDriverCallbacks; poll_ms?: number }) {
    this.conn = options.conn; this.remote = options.remote; this.callbacks = options.callbacks ?? {}
    this.pollMs = Math.max(25, options.poll_ms ?? 500)
  }
  /** Synchronous: call before watch.start. Merely loading cannot contact SSH or unpin unknown work. */
  rehydrate(): void {
    for (const row of this.conn.all('SELECT execution_id FROM remote_jobs')) {
      const id = String(row.execution_id), record = this.load(id)
      this.owned.add(id)
      record.state.start_attempted = true
      record.state.connection_state = 'disconnected'
      record.state.writer_pinned = !record.finalized
      this.write(id, record)
    }
  }
  startPolling(): void {
    if (this.closed || this.timer) return
    this.timer = setInterval(() => { void this.poll().catch(() => {}) }, this.pollMs)
    this.timer.unref?.()
  }
  has(id: string): boolean { return this.owned.has(id) }
  pending(id: string): boolean { return this.has(id) && !this.load(id).finalized }
  connected(id: string): boolean {
    if (!this.has(id)) return false
    const record = this.load(id)
    return !this.remote.isPaused(record.state.identity.target_id) && record.state.connection_state === 'connected'
  }
  private load(id: string): DurableDriverRecord {
    const row = this.conn.get('SELECT record_json,connection_state FROM remote_jobs WHERE execution_id=?', [id])
    if (!row) throw new Error(`Unknown remote execution ${id}`)
    const record = JSON.parse(String(row.record_json)) as DurableDriverRecord
    if (record.version !== 1 || record.state?.version !== 1) throw new Error('Unsupported remote execution record')
    // The service writes this column immediately on explicit disconnect, independently of polls.
    record.state.connection_state = String(row.connection_state) as RemoteExecutionState['connection_state']
    return record
  }
  private write(id: string, record: DurableDriverRecord): void {
    const state = record.state
    this.conn.run('UPDATE remote_jobs SET job_id=?,state=?,connection_state=?,stdout_offset=?,stderr_offset=?,record_json=? WHERE execution_id=?',
      [state.job_id, record.start_refused ? 'refused' : record.finalized ? 'exited' : state.connection_state !== 'connected' ? 'unknown' : state.job?.state ?? 'unknown', state.connection_state,
        state.cursors.stdout, state.cursors.stderr, JSON.stringify(record), id])
  }
  private save(id: string, record: DurableDriverRecord): void {
    const previous = this.load(id)
    this.conn.transaction(() => {
      this.write(id, record)
      const before = previous.state.connection_state === 'connected', after = record.state.connection_state === 'connected'
      if (before !== after) synchronous(this.callbacks.onConnection?.(id, after))
    })
  }
  /** background: a poll's call — it never waits for (or dials past) the connection's schedule; the connection's
   *  return (RemoteWorkspaceService.onReady) polls again. A person's or a tool's call waits for the connection. */
  private rpc(record: DurableDriverRecord, background = false): RemoteJobRpc {
    return async (method, params, operation) => {
      if (this.closed || this.remote.isPaused(record.state.identity.target_id)) throw new RemoteError('remote_disconnected', 'Remote target is paused', 'disconnected')
      const result = await this.remote.request(record.state.identity as RemoteWorkspaceBinding, method, params, operation, background ? { wait_ms: 0 } : {})
      if (this.remote.isPaused(record.state.identity.target_id)) throw new RemoteError('remote_disconnected', 'Target disconnected during remote request', 'disconnected')
      return result
    }
  }
  private controller(id: string, record: DurableDriverRecord, background = false): RemoteJobController {
    return new RemoteJobController(this.rpc(record, background), record.state, async state => {
      const next = { ...record, state: { ...state, writer_pinned: !record.finalized } }
      this.save(id, next); record.state = next.state
    })
  }
  /** Internal ProcessSpec input is not authority by itself. Validate against the existing
   * run/lease governance record produced by RemoteFiles.holdRun, never create another lease system.
   * jobs.start still checks the same proof atomically against the remote root's current lease. */
  private borrowedLease(spec: ProcessSpec, workspace: Workspace): LeaseProof | null {
    const proof = spec.remote_lease
    if (!proof) return null
    const run = spec.run_id ? repo.getRun(this.conn, spec.run_id) : null
    const session = run ? repo.getSession(this.conn, run.session_id) : null
    const note = repo.governanceForRef(this.conn, 'remote_file_lease', workspace.id)
    const params = note?.params
    const held = params?.lease as Partial<LeaseProof> | null | undefined
    const root = params?.root as Partial<RemoteWorkspaceBinding> | null | undefined
    const binding = remoteBinding(workspace)
    // A direct workspace is shared across sessions; RemoteFiles writes governance under
    // its creator session, not necessarily the current run's session.
    // the run holding it now: the one that acquired it, or a later run of its conversation that took it over (the note
    // names it, and the conversation the lease is kept for is this run's own as its records say)
    const holder = typeof params?.holder_run_id === 'string' ? params.holder_run_id : params?.run_id
    const adopted = params?.owner_id !== run?.id
    if (!run || run.status !== 'running' || run.workspace_id !== workspace.id || run.project_id !== workspace.project_id ||
      !session || session.project_id !== workspace.project_id || session.workspace_id !== workspace.id ||
      note?.actor !== 'harness' || note.session_id !== workspace.session_id ||
      params?.state !== 'held' || params.owner_kind !== 'run' || holder !== run.id || typeof params.owner_id !== 'string' ||
      proof.owner_id !== params.owner_id || typeof proof.lease_id !== 'string' || !proof.lease_id || !Number.isSafeInteger(proof.fence) || proof.fence < 1 ||
      !held || held.lease_id !== proof.lease_id || held.owner_id !== proof.owner_id || held.fence !== proof.fence ||
      (adopted && !sameCohort(parseCohort(params.cohort), cohortOfRun(this.conn, run.id))) ||
      !root || (['target_id', 'root_id', 'generation', 'path', 'state_path'] as const).some(key => root[key] !== binding[key])) {
      throw new RemoteError('lease_conflict', 'Borrowed lease does not match this active run and persisted remote root', 'conflict')
    }
    return copy(proof)
  }
  async start(spec: ProcessSpec & { shell?: string }, workspace: Workspace): Promise<Execution> {
    if (this.closed) throw new Error('Remote execution driver is closed')
    const access = typeof spec.access === 'function' ? spec.access() : spec.access ?? 'sandbox'
    if (access !== 'full' || spec.sandbox) throw new RemoteError('sandbox_unavailable', 'Remote sandbox execution is unavailable')
    if (hostRestricted(spec.host_restrictions)) throw new RemoteError('restriction_unavailable', 'Remote restricted shell execution is unavailable')
    const binding = remoteBinding(workspace)
    if (this.remote.isPaused(binding.target_id)) throw new RemoteError('remote_disconnected', 'Remote target is paused', 'disconnected')
    if (spec.workspace_id && spec.workspace_id !== workspace.id) throw new RemoteError('root_changed', 'Execution workspace differs from persisted binding')
    if (!spec.command || spec.command.includes('\0')) throw new RemoteError('invalid_argument', 'Command required')
    const timeout = spec.timeout_s ?? null, cap = spec.output_cap_bytes ?? null
    if (timeout !== null && (!Number.isFinite(timeout) || timeout <= 0)) throw new RemoteError('invalid_argument', 'Invalid command timeout')
    if (cap !== null && (!Number.isSafeInteger(cap) || cap < 1)) throw new RemoteError('invalid_argument', 'Invalid output cap')
    const cwd = remotePath(workspace, spec.cwd)
    if (spec.project_id !== workspace.project_id) throw new RemoteError('root_changed', 'Execution project differs from persisted workspace')
    const shell = spec.shell ?? '/bin/sh'
    if (!shell.startsWith('/') || shell.includes('\0')) throw new RemoteError('invalid_argument', 'Remote shell must be an absolute executable path')
    const borrowed = this.borrowedLease(spec, workspace)
    // Only explicit env_extra crosses the boundary. No local HOME/SHELL/process.env/passthrough.
    const operation = newId('op'), owner = newId('owner')
    let id = ''
    const record: DurableDriverRecord = {
      version: 1, state: createRemoteExecutionState(binding, { operation_id: operation, command: spec.command, cwd,
        shell, env: { ...(spec.env_extra ?? {}) }, timeout_s: timeout, output_cap_bytes: cap,
        lease: borrowed ?? { lease_id: '', owner_id: owner, fence: 0 } }),
      lease_operation_id: newId('op'), release_operation_id: newId('op'), stop_operation_id: null,
      lease_ownership: borrowed ? 'borrowed' : 'owned',
      finalized: false, lease_released: false, eof: { stdout: false, stderr: false }, pages: { stdout: null, stderr: null },
      preview: { stdout: '', stderr: '' }, log_incomplete: false, last_output_at: null,
    }
    this.conn.transaction(() => {
      const execution = repo.insertExecution(this.conn, { run_id: spec.run_id ?? null, workspace_id: workspace.id, tool_call_id: spec.tool_call_id ?? null,
        kind: spec.kind ?? 'command', command: spec.command, cwd: spec.cwd, network: true,
        isolation: { runtime: 'ssh', enforcement: 'none', access_mode: 'full', requested_access: spec.access_report?.requested_access ?? 'full',
          effective_access: 'full', access_reasons: spec.access_report?.access_reasons ?? [], target_id: binding.target_id, root_id: binding.root_id,
          generation: binding.generation, shell, timeout_s: timeout, timeout_source: timeout === null ? null : spec.timeout_source ?? 'call', output_cap_bytes: cap,
          ...(spec.launched_by ? { launched_by: spec.launched_by } : {}) } })
      id = execution.id
      this.conn.run('INSERT INTO remote_jobs (execution_id,target_id,root_id,generation,operation_id,record_json) VALUES (?,?,?,?,?,?)',
        [id, binding.target_id, binding.root_id, binding.generation, operation, JSON.stringify(record)])
      repo.startExecution(this.conn, id)
    })
    this.owned.add(id)
    // Register this initial mutation as a flight so a poll cannot race the first jobs.start.
    const flight = (async () => {
      if (borrowed) { await this.controller(id, record).start(); this.unsentStart(id); return }
      let lease
      try { lease = await this.rpc(record)('leases.acquire', { owner_id: owner }, record.lease_operation_id) }
      catch (error) {
        // Only a definite lease refusal proves this attempt owns no lease and sent no job.
        // Do not release the other writer's lease, or conflate a lost acquisition ACK with refusal.
        if (error instanceof RemoteError && error.code === 'lease_conflict' && error.status === 'conflict') {
          record.start_refused = true; record.finalized = true; record.lease_released = true
          record.state.start_attempted = true; record.state.writer_pinned = false
          record.state.connection_state = 'connected'
          record.state.last_error = { code: error.code, message: error.message }
          this.conn.transaction(() => {
            repo.finishExecution(this.conn, id, { status: 'failed', exit_code: null, timed_out: false, cancelled: false, truncated: false,
              stdout_asset_id: null, stderr_asset_id: null, stdout_bytes: 0, stderr_bytes: 0, duration_ms: 0 })
            repo.setExecutionNotApplied(this.conn, id)
            this.write(id, record)
          })
          // No onEnd: nothing ran. Concurrent local waiters may now safely release their pins.
          this.resolveWaiters(id)
          throw error
        }
        record.state.start_attempted = true; record.state.last_error = { code: (error as RemoteError).code ?? 'outcome_unknown', message: 'Remote lease outcome unknown' }
        record.state.connection_state = (error as RemoteError).status === 'disconnected' ? 'disconnected' : 'unknown'
        this.save(id, record); return
      }
      record.state.spec.lease = lease
      this.save(id, record)
      await this.controller(id, record).start()
      this.unsentStart(id)
    })()
    this.flights.set(id, flight)
    try { await flight } finally { if (this.flights.get(id) === flight) this.flights.delete(id) }
    return repo.getExecution(this.conn, id)!
  }
  /** What is known of the start: the remote job's id once a reply or a recovery gave it; null while a lost start
   *  reply is unresolved. */
  startIdentity(id: string): { job_id: string | null; operation_id: string; finalized: boolean; refused: boolean } | null {
    if (!this.has(id)) return null
    const record = this.load(id)
    return { job_id: record.state.job_id, operation_id: record.state.spec.operation_id, finalized: record.finalized, refused: record.start_refused === true }
  }
  /** A start whose reply was lost, asked about now — the same operation's durable mapping (jobs.recover), never a
   *  second jobs.start — waiting for the connection as a tool's call does. The job's id, or null while unknown. */
  async recoverStart(id: string): Promise<string | null> {
    if (!this.has(id)) return null
    return this.exclusive(id, async () => {
      const record = this.load(id)
      if (record.state.job_id || record.finalized || record.start_refused) return record.state.job_id
      if (this.remote.isPaused(record.state.identity.target_id)) return null
      const observation = await this.controller(id, record).status()
      return observation.state.job_id
    })
  }
  /** A start the transport proved was never sent (no byte reached ssh): it did not run, and that is settled now — the
   *  execution ends as not applied (a lease this job owns is released by the next poll); nothing is sent again. */
  private unsentStart(id: string): void {
    const record = this.load(id)
    if (record.state.job_id || record.finalized || record.state.last_error?.delivery !== 'not_sent') return
    record.start_refused = true; record.finalized = true; record.state.writer_pinned = false
    this.conn.transaction(() => {
      repo.finishExecution(this.conn, id, { status: 'failed', exit_code: null, timed_out: false, cancelled: false, truncated: false,
        stdout_asset_id: null, stderr_asset_id: null, stdout_bytes: 0, stderr_bytes: 0, duration_ms: 0 })
      repo.setExecutionNotApplied(this.conn, id)
      this.write(id, record)
    })
    this.resolveWaiters(id)
  }
  private exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const result = (this.flights.get(id) ?? Promise.resolve()).catch(() => {}).then(fn)
    const flight = result.then(() => {}, () => {})
    this.flights.set(id, flight)
    void flight.then(() => { if (this.flights.get(id) === flight) this.flights.delete(id) })
    return result
  }
  async poll(id?: string): Promise<void> {
    if (this.closed) return
    if (id === undefined) {
      const errors: unknown[] = []
      for (const key of this.owned) { try { await this.poll(key) } catch (error) { errors.push(error) } }
      if (errors.length) throw new AggregateError(errors, 'Remote execution polls failed')
      return
    }
    if (!this.has(id)) return
    const existing = this.flights.get(id)
    if (existing) return existing
    return this.exclusive(id, () => this.pollOne(id))
  }
  private async pollOne(id: string): Promise<void> {
    let record = this.load(id)
    const target = record.state.identity.target_id
    // a target the person disconnected is never dialed; one whose connection is being restored is not dialed by a
    // poll either (the attempt under way, or the schedule, brings it back and polls again)
    if (this.remote.isPaused(target) || (typeof this.remote.reachable === 'function' && !this.remote.reachable(target))) {
      if (record.state.connection_state !== 'disconnected') { record.state.connection_state = 'disconnected'; this.save(id, record) }
      return
    }
    if (record.finalized) { await this.release(id, record); return }
    // Lost lease ACK: inspection can recover ownership, but never acquire a second lease.
    if (!record.state.spec.lease.lease_id) {
      try {
        const lease = await this.rpc(record, true)('leases.inspect', {})
        if (lease?.owner_id === record.state.spec.lease.owner_id) { record.state.spec.lease = lease; this.save(id, record) }
      } catch { /* jobs.recover below reports the actual connection/unknown state */ }
    }
    const controller = this.controller(id, record, true)
    const observation = await controller.status()
    if (observation.state.connection_state !== 'connected' || !observation.state.job_id) return
    for (const stream of ['stdout', 'stderr'] as const) {
      // Bounded work per tick; logs remain remote. A final job can require many ticks to drain.
      for (let n = 0; n < 4; n++) {
        const result = await this.controller(id, record, true).output(stream, record.state.cursors[stream], PAGE_BYTES)
        if (!result.available) return
        const page = result.page, bytes = Buffer.from(page.data, 'base64'), next = copy(record)
        next.state.cursors[stream] = page.next_offset
        next.eof[stream] = page.eof
        next.pages[stream] = { ...page, data: '' }
        next.preview[stream] = Buffer.concat([Buffer.from(next.preview[stream], 'base64'), bytes]).subarray(0, PREVIEW_BYTES).toString('base64')
        next.log_incomplete ||= page.gaps.length > 0 || page.storage_failed === true || page.log_complete === false
        if (bytes.length) next.last_output_at = new Date().toISOString()
        this.conn.transaction(() => {
          if (bytes.length) synchronous(this.callbacks.onOutput?.({ execution_id: id, stream, offset: page.byte_offset, bytes }))
          this.write(id, next)
        })
        record = next
        if (!bytes.length || page.eof) break
      }
    }
    if (observation.terminal_confirmed && record.eof.stdout && record.eof.stderr) {
      const job = record.state.job!
      record.log_incomplete ||= job.reason === 'storage_failed' || job.log_complete === false
      record.finalized = true
      record.state.writer_pinned = false
      this.conn.transaction(() => {
        const execution = repo.getExecution(this.conn, id)!
        repo.finishExecution(this.conn, id, { status: job.reason === 'storage_failed' || record.log_incomplete ? 'failed' : job.reason === 'timeout' ? 'timeout' : job.reason === 'stopped' ? 'cancelled' : job.exit_code === 0 ? 'succeeded' : 'failed',
          exit_code: job.exit_code ?? null, timed_out: job.reason === 'timeout', cancelled: job.reason === 'stopped', truncated: record.log_incomplete,
          stdout_asset_id: null, stderr_asset_id: null, stdout_bytes: record.pages.stdout?.total_retained ?? 0, stderr_bytes: record.pages.stderr?.total_retained ?? 0,
          duration_ms: Math.max(0, Date.now() - Date.parse(execution.started_at ?? execution.created_at)) })
        this.write(id, record)
        synchronous(this.callbacks.onEnd?.(id))
      })
      this.resolveWaiters(id)
      await this.release(id, record)
    }
  }
  private async release(id: string, record: DurableDriverRecord): Promise<void> {
    // The run owner releases only after the run AND all its jobs end, including after restart.
    if (record.lease_ownership === 'borrowed' || record.lease_released || !record.state.spec.lease.lease_id) return
    try {
      // a poll's call (no wait); the same durable operation_id each time, which the remote answers from its record
      const result = await this.rpc(record, true)('leases.release', { lease: record.state.spec.lease }, record.release_operation_id)
      if (result.released) { record.lease_released = true; this.save(id, record) }
    } catch { /* durable release id survives; subsequent polls retry the same id only */ }
  }
  private resolveWaiters(id: string): void {
    for (const waiter of this.waiters.get(id) ?? []) { if (waiter.timer) clearTimeout(waiter.timer); waiter.resolve(repo.getExecution(this.conn, id)) }
    this.waiters.delete(id)
  }
  wait(id: string, timeout_s: number | null): Promise<Execution | null> {
    if (!this.has(id)) return Promise.resolve(null)
    if (!this.pending(id)) return Promise.resolve(repo.getExecution(this.conn, id))
    if (timeout_s !== null && (!Number.isFinite(timeout_s) || timeout_s < 0)) return Promise.reject(new Error('Invalid wait timeout'))
    this.startPolling()
    return new Promise(resolve => {
      const waiter: { resolve: (v: Execution | null) => void; timer?: ReturnType<typeof setTimeout> } = { resolve }
      const group = this.waiters.get(id) ?? new Set(); group.add(waiter); this.waiters.set(id, group)
      if (timeout_s !== null) waiter.timer = setTimeout(() => { group.delete(waiter); if (!group.size) this.waiters.delete(id); resolve(null) }, timeout_s * 1000)
      void this.poll(id).catch(() => {})
    })
  }
  async readOutput(id: string, stream: 'stdout' | 'stderr', offset: number, limit: number): Promise<Record<string, unknown>> {
    if (!this.has(id)) throw new Error('Unknown remote execution')
    return this.exclusive(id, async () => {
    const record = this.load(id)
    const result = await this.controller(id, record).output(stream, offset, Math.max(1, Math.min(PAGE_BYTES, limit)))
    if (!result.available) return { execution_id: id, stream, offset, status: 'unknown', available: false, eof: false, running: this.pending(id), error: result.state.last_error }
    const page = result.page
    // Warm a decoder with at most three previous bytes. A character belongs to the page
    // containing its last byte; byte cursors/data remain unchanged, no replacement at page edges.
    const decoder = new TextDecoder('utf-8')
    let behind = offset > page.total_retained ? offset : Math.max(0, offset - 3)
    while (behind < offset) {
      const previous = await this.controller(id, record).output(stream, behind, offset - behind)
      if (!previous.available || previous.page.next_offset <= behind) return { execution_id: id, stream, offset, available: false, status: 'unknown', eof: false, error: { code: 'log_gap' } }
      decoder.decode(Buffer.from(previous.page.data, 'base64'), { stream: true })
      behind = previous.page.next_offset
    }
    const text = decoder.decode(Buffer.from(page.data, 'base64'), { stream: !page.eof })
    return { execution_id: id, stream, offset, available: true, status: record.finalized ? repo.getExecution(this.conn, id)!.status : record.state.job?.state ?? 'unknown',
      returned_bytes: page.next_offset - offset, next_offset: page.next_offset, total_bytes: page.total_retained, command_total_bytes: page.total_written,
      dropped_bytes: page.total_written - page.total_retained, gaps: page.gaps, output_complete: page.log_complete !== false && !page.storage_failed && page.gaps.length === 0,
      eof: page.eof, running: this.pending(id), data: page.data, text, storage_failed: page.storage_failed ?? false }
    })
  }
  async summary(id: string): Promise<Record<string, unknown>> {
    const record = this.load(id), execution = repo.getExecution(this.conn, id)!, job = record.state.job
    return { execution_id: id, status: record.finalized ? execution.status : this.connected(id) ? job?.state ?? 'unknown' : 'unknown',
      connection_state: this.connected(id) ? 'connected' : record.state.connection_state === 'unknown' ? 'unknown' : 'disconnected',
      running: !record.finalized, exit_code: record.finalized ? execution.exit_code : null, timed_out: execution.timed_out, cancelled: execution.cancelled,
      target_id: record.state.identity.target_id, root_id: record.state.identity.root_id, generation: record.state.identity.generation, job_id: record.state.job_id,
      stdout: Buffer.from(record.preview.stdout, 'base64').toString('utf8'), stderr: Buffer.from(record.preview.stderr, 'base64').toString('utf8'),
      stdout_shown: 'preview', stderr_shown: 'preview', stdout_bytes: record.pages.stdout?.total_retained ?? 0, stderr_bytes: record.pages.stderr?.total_retained ?? 0,
      output_complete: record.finalized && !record.log_incomplete, output_cap_bytes: record.state.spec.output_cap_bytes, timeout_s: record.state.spec.timeout_s,
      writer_pinned: !record.finalized, log_complete: !record.log_incomplete, last_output_at: record.last_output_at, stop_reason: job?.reason ?? record.state.last_error?.code ?? null,
      gaps: { stdout: record.pages.stdout?.gaps ?? [], stderr: record.pages.stderr?.gaps ?? [] }, error: record.state.last_error }
  }
  async stop(id: string): Promise<Record<string, unknown>> {
    if (!this.has(id)) throw new Error('Unknown remote execution')
    await this.poll(id)
    return this.exclusive(id, async () => {
    const record = this.load(id)
    if (record.finalized) return { ...await this.summary(id), state: 'terminal-confirmed' }
    record.stop_operation_id ??= newId('op'); this.save(id, record)
    const result = await this.controller(id, record).stop(record.stop_operation_id)
    return { execution_id: id, state: result.terminal_confirmed ? 'terminal-confirmed' : result.state.connection_state === 'connected' && result.state.job_id ? 'requested' : 'unknown',
      pending: this.pending(id), connection_state: result.state.connection_state }
    })
  }
  async close(): Promise<void> {
    this.closed = true
    if (this.timer) { clearInterval(this.timer); this.timer = undefined }
    for (const group of this.waiters.values()) for (const waiter of group) if (waiter.timer) clearTimeout(waiter.timer)
    // Unknown wait(null) promises deliberately stay pending: resolving would release workspace pins.
    await Promise.allSettled(this.flights.values())
  }
}
