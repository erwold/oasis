/** Remote direct file operations. Only explicit small files are transferred; never a project snapshot. */
import { posix } from 'node:path'
import { REMOTE_SMALL_FILE_BYTES, type Workspace, type RemoteWorkspaceBinding, type UndoResult } from '@oasis-code/contract'
import { DEFAULT_RECONNECT, RemoteWorkspaceService, RemoteRefused, RemoteOutcomeUnresolved } from './remote.ts'
import { CHAIN_BROKEN, chainOf, FileJournal, type FileChange } from './journal.ts'
import { cohortOfRun, parseCohort, sameCohort, type RunCohort } from './cohort.ts'
import { sha256Of, isBinary } from './reading.ts'
import { sniffImage } from '../llm/images.ts'
import * as repo from '../db/repo.ts'
import { newId } from '../ids.ts'
import { RemoteError, type LeaseProof, type OperationStatus, type WriteReceipt } from '../remote/types.ts'
import type { JournalEntry } from '@oasis-code/contract'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
/** The waits between asking for a lost reply's receipt again (ms; the last repeats until the settle bound). */
const SETTLE_STEPS_MS = [0, 250, 500, 1000, 2000, 4000, 8000]
/** A remote refusal that proves the mutation did not happen (an explicit precondition or policy answer). */
function definiteRefusal(error: unknown): boolean {
  const e = error as { status?: unknown; code?: string }
  return e.code !== 'outcome_unknown' && (e.status === 'refused' || e.status === 'conflict' || (error instanceof RemoteRefused && e.status !== undefined && Number(e.status) < 500))
}

export function remoteBinding(ws: Workspace): RemoteWorkspaceBinding {
  if (ws.target?.kind !== 'ssh' || !ws.remote || ws.remote.target_id !== ws.target.target_id || ws.remote.path !== ws.path) throw new RemoteRefused('root_changed', 'Remote workspace identity is missing or inconsistent.')
  return ws.remote
}
export function remotePath(ws: Workspace, path: string): string {
  const root = remoteBinding(ws)
  if (/[\x00-\x1f\x7f]/.test(path) || path.split('/').includes('..')) throw new RemoteRefused('path_refused', 'Invalid remote path.')
  const relative = posix.isAbsolute(path) ? posix.relative(root.path, path) : posix.normalize(path)
  if (relative === '..' || relative.startsWith('../') || relative.split('/').some(p => p === '.oasis-remote' || p.toLowerCase() === '.git')) throw new RemoteRefused('path_refused', 'Path escapes the project or addresses private metadata.')
  const absolute = posix.join(root.path, relative)
  if (absolute === root.state_path || absolute.startsWith(root.state_path + '/')) throw new RemoteRefused('path_refused', 'Remote state is not a user file.')
  return relative || '.'
}
/** The executions still live (not ended) on a remote root, with their durable job records. */
// the canonical root is its root_id and generation (as the folder lock's key): an alias target of the same root shares it
// every job of the root with its durable record and its execution's summary; which are still pending is decided from
// the durable record (liveJobs), never from a list of statuses
const ROOT_JOBS_SQL = "SELECT r.execution_id AS execution_id, r.record_json AS record_json, e.id AS row_id, e.run_id AS run_id, e.workspace_id AS workspace_id, e.isolation_json AS isolation_json, e.finished_at AS finished_at FROM remote_jobs r LEFT JOIN executions e ON e.id=r.execution_id WHERE r.root_id=? AND r.generation=?"
const UNSETTLED_WRITES_SQL = "SELECT 1 FROM remote_journal_operations r JOIN file_journal j ON j.id=r.journal_id WHERE r.root_id=? AND r.generation=? AND j.state='prepared' LIMIT 1"
const sameProof = (a: Partial<LeaseProof> | null | undefined, b: Partial<LeaseProof> | null | undefined): boolean =>
  !!a && !!b && typeof a.lease_id === 'string' && !!a.lease_id && a.lease_id === b.lease_id && a.owner_id === b.owner_id && a.fence === b.fence

/** The workspace's writer lease as this process holds it: the proof, the conversation it is kept for, and its
 *  foreground run (null: only the commands of that conversation's earlier runs hold it now). One per workspace. */
interface Holding { workspace: Workspace; lease: LeaseProof; holder: string | null; cohort: RunCohort | null }

export class RemoteFiles {
  readonly journal: FileJournal
  /** a workspace with a live writer of this process: a run's (or its conversation's) lease, an acquisition under way,
   *  an operation's own lease — reconciliation never releases what is here */
  private readonly activeLeases = new Set<string>()
  private readonly holdings = new Map<string, Holding>()
  /** adoption, release and reconciliation of one canonical root, one at a time */
  private readonly rootTurns = new Map<string, Promise<void>>()
  leaseForRun(runId: string | null, ws: Workspace): LeaseProof | null {
    const held = runId ? this.holdings.get(ws.id) : null
    return held && held.holder === runId && JSON.stringify(held.workspace.remote) === JSON.stringify(ws.remote) ? held.lease : null
  }
  private serial<T>(ws: Workspace, fn: () => Promise<T>): Promise<T> {
    const root = remoteBinding(ws)
    const key = JSON.stringify([root.root_id, root.generation])
    const result = (this.rootTurns.get(key) ?? Promise.resolve()).then(fn)
    const tail = result.then(() => {}, () => {})
    this.rootTurns.set(key, tail)
    void tail.then(() => { if (this.rootTurns.get(key) === tail) this.rootTurns.delete(key) })
    return result
  }
  /** The root's jobs still pending (the canonical root: any alias target's), each with its proof, run and launcher as
   *  its records say. A job is done only when its durable record says it was finalized (`finalized: true`, written
   *  with its end in one transaction, as the driver's own pending() reads it) and its execution's summary agrees (it
   *  has ended). Anything else — a record not finalized whatever its summary says (lost, or a terminal status written
   *  apart from it), a summary still open beside a finalized record, a record that cannot be read, a job with no
   *  execution row — is pending: it keeps the lease.
   *  Only a pending job whose durable record says, in its own schema, that it is not finalized (`finalized: false`, as
   *  the driver keeps every job until its end) and that has its execution row can prove the conversation (`provable`):
   *  the driver and the lock pins then hold it as pending too. Any other pending job (finalized but not ended, the
   *  field missing or not a boolean, unreadable, no row) is inconsistent: it keeps the lease and makes it exclusive. */
  private liveJobs(ws: Workspace): { execution_id: string; provable: boolean; borrowed: boolean; lease: Partial<LeaseProof> | null; run_id: string | null; workspace_id: string | null; launcher: unknown }[] {
    const root = remoteBinding(ws)
    const out: { execution_id: string; provable: boolean; borrowed: boolean; lease: Partial<LeaseProof> | null; run_id: string | null; workspace_id: string | null; launcher: unknown }[] = []
    for (const row of this.remote.conn.all(ROOT_JOBS_SQL, [root.root_id, root.generation])) {
      let record: Record<string, unknown> | null = null
      let isolation: Record<string, unknown> = {}
      try { const parsed = JSON.parse(String(row.record_json)); record = parsed && typeof parsed === 'object' ? parsed : null } catch { record = null }
      try { isolation = JSON.parse(String(row.isolation_json ?? '{}')) ?? {} } catch { isolation = {} }
      const hasRow = row.row_id !== null && row.row_id !== undefined
      const done = record !== null && record.finalized === true && hasRow && row.finished_at !== null && row.finished_at !== undefined
      if (done) continue
      const spec = (record?.state as { spec?: { lease?: Partial<LeaseProof> } } | undefined)?.spec
      out.push({ execution_id: String(row.execution_id), provable: record !== null && record.finalized === false && hasRow, borrowed: record?.lease_ownership === 'borrowed', lease: spec?.lease ?? null,
        run_id: typeof row.run_id === 'string' ? row.run_id : null, workspace_id: typeof row.workspace_id === 'string' ? row.workspace_id : null, launcher: isolation.launched_by })
    }
    return out
  }
  /** The executions still live on the workspace's root (what keeps its writer lease held). */
  liveJobIds(ws: Workspace): string[] {
    return this.liveJobs(ws).map((j) => j.execution_id)
  }
  /** The conversation the workspace's held lease is kept for — only when every record proves it: the latest note says
   *  held (not intent, releasing or released) for this root, a run's lease, its cohort written (or, a lease from before
   *  cohorts were written, derived exactly from its original run's own record when that run acquired it), no file write
   *  of the root unsettled, and every live job on the root a durably pending (`provable`) borrowed command of that same
   *  proof whose run is of that same conversation (an approval's, an owned, a mixed or an inconsistent one: none). Null
   *  otherwise: the lease stays exclusive. */
  provenCohort(ws: Workspace): { cohort: RunCohort; lease: LeaseProof; note_id: number; derived: boolean } | null {
    const conn = this.remote.conn, root = remoteBinding(ws)
    const note = repo.governanceForRef(conn, 'remote_file_lease', ws.id), saved = note?.params
    if (!note || !saved || saved.state !== 'held' || saved.owner_kind !== 'run' || JSON.stringify(saved.root) !== JSON.stringify(root)) return null
    const lease = saved.lease as LeaseProof | undefined
    if (!lease || typeof lease.lease_id !== 'string' || !lease.lease_id || lease.owner_id !== saved.owner_id) return null
    // the lease must be a run's own: acquired by the run the note names (owner_id is that run), whose persisted record
    // gives the conversation — a cohort the note carries is only ever checked against that record, never trusted alone
    // (a note's fields are merged from earlier ones); one from before cohorts were written (no such field) is derived
    // from that record; a holder that took it over must be of the same conversation by its own record
    if (typeof saved.run_id !== 'string' || saved.owner_id !== saved.run_id) return null
    const trusted = cohortOfRun(conn, saved.run_id)
    const derived = !('cohort' in saved)
    if (trusted === null || (!derived && !sameCohort(parseCohort(saved.cohort), trusted))) return null
    if (typeof saved.holder_run_id === 'string' && saved.holder_run_id !== saved.run_id && !sameCohort(cohortOfRun(conn, saved.holder_run_id), trusted)) return null
    const cohort = trusted
    if (cohort.workspace_id !== ws.id) return null
    if (conn.get(UNSETTLED_WRITES_SQL, [root.root_id, root.generation])) return null
    for (const job of this.liveJobs(ws)) {
      // a pending job of inconsistent records proves nothing: the lease stays exclusive
      if (!job.provable || !job.borrowed || !sameProof(job.lease, lease) || job.run_id === null) return null
      // its execution must be of this very workspace (the one whose lock pins it after a restart): none, or another
      // workspace's, proves nothing — the root's guards still count it, whatever alias recorded it
      if (job.workspace_id !== ws.id || job.workspace_id !== cohort.workspace_id) return null
      if (job.launcher !== undefined && job.launcher !== 'run') return null
      if (!sameCohort(cohortOfRun(conn, job.run_id), cohort)) return null
    }
    return { cohort, lease, note_id: note.id, derived }
  }
  /** A run of the conversation the lease is kept for takes it as its foreground writer — the same durable lease, never
   *  a second one — once the records prove the conversation (provenCohort), no other run holds it in this process, and
   *  the remote confirms the exact proof. The cohort (derived for an older lease) is written before the run holds it. */
  private adopt(ws: Workspace, runId: string, cohort: RunCohort): Promise<boolean> {
    return this.serial(ws, async () => {
      const held = this.holdings.get(ws.id)
      if (held !== undefined ? held.holder !== null : this.activeLeases.has(ws.id)) return false
      const proven = this.provenCohort(ws)
      if (proven === null || !sameCohort(proven.cohort, cohort) || (held !== undefined && !sameProof(held.lease, proven.lease))) return false
      const current = await this.remote.request(remoteBinding(ws), 'leases.inspect', {})
      if (!sameProof(current, proven.lease)) return false
      // nothing moved while the remote was asked
      const again = this.holdings.get(ws.id)
      if (repo.governanceForRef(this.remote.conn, 'remote_file_lease', ws.id)?.id !== proven.note_id || (again !== undefined ? again.holder !== null : this.activeLeases.has(ws.id))) return false
      this.leaseNote(ws, 'held', { cohort: proven.cohort, holder_run_id: runId })
      this.holdings.set(ws.id, { workspace: ws, lease: proven.lease, holder: runId, cohort: proven.cohort })
      this.activeLeases.add(ws.id)
      return true
    })
  }
  async holdRun(ws: Workspace, runId: string, cancelled: () => boolean, queued: (owner: string) => void, cohort: RunCohort | null = null): Promise<void> {
    if (this.leaseForRun(runId, ws)) return
    const root = remoteBinding(ws)
    // the lease its conversation's commands keep: taken over, not waited for
    if (cohort !== null && await this.adopt(ws, runId, cohort)) return
    await this.recover(ws)
    let reconciled = Date.now()
    for (;;) {
      if (cancelled()) throw new RemoteRefused('cancelled', 'The run was stopped while waiting for the remote writer.')
      if (cohort !== null && await this.adopt(ws, runId, cohort)) return
      const current = await this.remote.request(root, 'leases.inspect', {})
      if (current !== null) {
        queued(current.owner_id); await sleep(500)
        // a writer left behind by an ended run (its last receipts unread when it ended, or the app restarted) is let
        // go by reconciliation once its receipts can be read: asked again while this run waits, not only at its start
        if (Date.now() - reconciled > 5000) { reconciled = Date.now(); await this.recover(ws).catch(() => {}) }
        continue
      }
      const acquire = newId('op')
      // From its intent on, this acquisition is the workspace's live writer: a reconciliation running meanwhile (a
      // job's end, a reconnection) must not read the intent as a stale writer and release the lease it is taking.
      if (this.activeLeases.has(ws.id)) { queued('another remote writer'); await sleep(500); continue }
      this.activeLeases.add(ws.id)
      let lease: LeaseProof | null = null
      try {
        // the conversation it is kept for, and its foreground run, written with the intent (a later run of it adopts it)
        this.leaseNote(ws, 'intent', { owner_id: runId, owner_kind: 'run', run_id: runId, acquire_operation_id: acquire, lease: null, cohort: cohort ?? null, holder_run_id: runId, release_operation_id: null })
        lease = await this.acquireOnce(root, runId, acquire, cancelled)
      } finally { if (!lease) this.activeLeases.delete(ws.id) }
      if (!lease) { queued('another remote writer'); await sleep(500); continue }
      this.leaseNote(ws, 'held', { lease })
      this.holdings.set(ws.id, { workspace: ws, lease, holder: runId, cohort })
      return
    }
  }
  /** One leases.acquire, sent once: the lease, or null when another writer holds the root (busy). A lost reply is
   *  settled from the acquisition's own receipt — never acquired again; still unknown after the bound, it throws. */
  private async acquireOnce(root: ReturnType<typeof remoteBinding>, runId: string, acquire: string, cancelled: () => boolean): Promise<LeaseProof | null> {
    try { return await this.remote.request(root, 'leases.acquire', { owner_id: runId }, acquire) }
    catch (error) {
      if ((error as { code?: string }).code === 'lease_conflict') return null
      if (definiteRefusal(error) || (error as { delivery?: string }).delivery === 'not_sent') throw error
      const status = await this.settleOperation(root, acquire, cancelled)
      if (status?.state === 'applied' && status.result && 'lease_id' in status.result && status.result.owner_id === runId) return status.result
      if (status?.state === 'failed') return null
      throw new RemoteRefused('outcome_unknown', `Remote operation outcome unknown: writer lease (operation ${acquire}); not sent again.`, 503)
    }
  }
  /** The receipt of one operation whose reply was lost: operations.status of that operation_id — the mutation itself
   *  is never sent again — asked while the connection comes back, until it is applied or failed or the settle bound
   *  passes (null then: still unknown; not_found and prepared are unknown too). */
  async settleOperation(root: ReturnType<typeof remoteBinding>, operationId: string, cancelled: () => boolean = () => false): Promise<OperationStatus | null> {
    const deadline = Date.now() + this.settleMs
    let last: OperationStatus | null = null
    for (let n = 0; ; n++) {
      const left = deadline - Date.now()
      if (left <= 0 || cancelled()) return last
      try {
        last = await this.remote.request(root, 'operations.status', { operation_id: operationId }, undefined, { wait_ms: left })
        if (last.state === 'applied' || last.state === 'failed') return last
      } catch (error) {
        // a target the person disconnected meanwhile is not waited for
        if ((error as { code?: string }).code === 'remote_disconnected') return last
      }
      await sleep(Math.min(SETTLE_STEPS_MS[Math.min(n + 1, SETTLE_STEPS_MS.length - 1)]!, Math.max(0, deadline - Date.now())))
    }
  }
  /** The run is no longer the lease's foreground writer (its end): the workspace it held, or null. Only that run's own
   *  hold is let go — a later run that took the lease over is never touched. */
  endRun(runId: string): Workspace | null {
    for (const h of this.holdings.values()) if (h.holder === runId) { h.holder = null; return h.workspace }
    return null
  }
  /** The run's end: no longer the foreground writer, and the lease released if nothing else keeps it (releaseIfIdle). */
  async releaseRun(runId: string): Promise<void> {
    const ws = this.endRun(runId)
    if (ws !== null) await this.releaseIfIdle(ws)
  }
  /** The lease released once nothing keeps it — asked again each time, whoever asks (a run's end, a command's end that
   *  an earlier run's callback waited for): no foreground run holds it, no job on its root is live (or of unknown
   *  outcome), every prepared write's receipt is reconciled. The release's intent is written before it is sent, and a
   *  lease being released is never taken over; an outcome that stays unknown keeps the record 'releasing' (recover()
   *  settles it later, the same operation). Released, every hold of it in this process is gone with it. */
  releaseIfIdle(ws: Workspace): Promise<void> {
    return this.serial(ws, async () => {
      const h = this.holdings.get(ws.id)
      if (h === undefined || h.holder !== null || this.liveJobs(ws).length) return
      const counts = await this.reconcileReceipts(h.workspace)
      if (counts.unknown || this.holdings.get(ws.id) !== h || h.holder !== null) return
      // a release already recorded (its answer lost) is settled from its own receipt, and sent again as the same
      // operation while it has none — never replaced by a new one (another callback may ask after the first)
      const saved = repo.governanceForRef(this.remote.conn, 'remote_file_lease', ws.id)?.params
      let operation = newId('op')
      if (saved?.state === 'releasing' && typeof saved.release_operation_id === 'string') {
        const receipt = await this.remote.request(remoteBinding(ws), 'operations.status', { operation_id: saved.release_operation_id }).catch(() => null)
        if (this.holdings.get(ws.id) !== h || h.holder !== null) return
        if (receipt?.state === 'applied') {
          this.leaseNote(h.workspace, 'released', { release_operation_id: null })
          this.holdings.delete(ws.id); this.activeLeases.delete(ws.id)
          return
        }
        if (receipt?.state === 'failed') this.leaseNote(h.workspace, 'held', { release_operation_id: null })
        else operation = saved.release_operation_id
      }
      await this.sendRelease(h.workspace, h.lease, operation)
    })
  }
  /** leases.release of `lease`, its intent written first. Released (or found no longer this proof's): the record says
   *  released and this process holds nothing of it. Refused for a reason that proves nothing was released: held again.
   *  Unknown: left 'releasing'. */
  private async sendRelease(ws: Workspace, lease: LeaseProof, operation: string): Promise<boolean> {
    const root = remoteBinding(ws)
    this.leaseNote(ws, 'releasing', { release_operation_id: operation })
    let released = false
    try {
      await this.remote.request(root, 'leases.release', { lease }, operation)
      released = true
    } catch (error) {
      const e = error as { code?: string; status?: string; delivery?: string }
      // the proof is no longer the root's lease: nothing of it is this process's to hold
      if (e.code === 'lease_conflict') released = true
      // never sent (the target away or disconnected before a byte left), or refused outright: nothing was released —
      // held again, as before the intent
      else if (e.delivery === 'not_sent' || (error instanceof RemoteRefused && e.code === 'remote_disconnected') || definiteRefusal(error)) {
        this.leaseNote(ws, 'held', { release_operation_id: null })
        return false
      } else {
        const status = await this.settleOperation(root, operation).catch(() => null)
        if (status?.state === 'applied') released = true
        else if (status?.state === 'failed') { this.leaseNote(ws, 'held', { release_operation_id: null }); return false }
        else return false
      }
    }
    if (released) {
      this.leaseNote(ws, 'released', { release_operation_id: null })
      const h = this.holdings.get(ws.id)
      if (h !== undefined && sameProof(h.lease, lease)) { this.holdings.delete(ws.id); this.activeLeases.delete(ws.id) }
    }
    return released
  }
  /** how long a write whose reply was lost is settled from its receipt before the outcome is called unresolved */
  readonly settleMs: number
  constructor(readonly remote: RemoteWorkspaceService, opts: { settle_ms?: number } = {}) {
    this.journal = new FileJournal(remote.conn)
    this.settleMs = Math.max(0, opts.settle_ms ?? remote.policy?.settle_ms ?? DEFAULT_RECONNECT.settle_ms)
  }
  private leaseNote(ws: Workspace, state: string, values: Record<string, unknown> = {}): void {
    if (!ws.session_id) throw new RemoteRefused('session_required', 'A remote file lease needs a persisted session.')
    const previous = repo.governanceForRef(this.remote.conn, 'remote_file_lease', ws.id)?.params ?? {}
    repo.logGovernance(this.remote.conn, ws.session_id, 'remote_file_lease', { actor: 'harness', ref: ws.id, params: { ...previous, ...values, root: remoteBinding(ws), state } })
  }
  /** Each prepared write of the workspace settled from its remote operation receipt: applied (the receipt matches
   *  what was intended), abandoned (it failed), else left unknown. A write is never replayed. */
  private async reconcileReceipts(ws: Workspace): Promise<{ applied: number; abandoned: number; unknown: number }> {
    const result = { applied: 0, abandoned: 0, unknown: 0 }, conn = this.remote.conn, root = remoteBinding(ws)
    for (const entry of repo.listPreparedJournal(conn).filter(e => e.workspace_id === ws.id)) {
      const op = conn.get('SELECT * FROM remote_journal_operations WHERE journal_id=?', [entry.id])
      if (!op || op.target_id !== root.target_id || op.root_id !== root.root_id || op.generation !== root.generation) { result.unknown++; continue }
      const status = await this.remote.request(root, 'operations.status', { operation_id: String(op.operation_id) })
      result[this.settleEntry(entry, String(op.operation_id), status)]++
    }
    return result
  }
  /** One prepared write against its operation's receipt: 'applied' only for an applied receipt of this very operation
   *  that matches the journal (path, before, intended after); 'abandoned' for a failed one; anything else unknown. */
  private settleEntry(entry: JournalEntry, operationId: string, status: OperationStatus): 'applied' | 'abandoned' | 'unknown' {
    const conn = this.remote.conn, receipt = status.result
    if (status.state === 'applied' && receipt && 'after' in receipt && receipt.state === 'applied') {
      const after = receipt.after === null ? null : Buffer.from(receipt.after, 'base64')
      const hash = after === null ? null : sha256Of(after)
      if (receipt.operation_id !== operationId || receipt.path !== entry.path || receipt.before_sha256 !== entry.before_sha || receipt.after_sha256 !== hash || hash !== entry.intended_sha) return 'unknown'
      conn.transaction(() => { this.journal.applied(entry, after); conn.run("UPDATE remote_journal_operations SET state='applied' WHERE journal_id=?", [entry.id]) })
      return 'applied'
    }
    if (status.state === 'failed') {
      conn.transaction(() => { this.journal.abandoned(entry); conn.run("UPDATE remote_journal_operations SET state='abandoned' WHERE journal_id=?", [entry.id]) })
      return 'abandoned'
    }
    return 'unknown'
  }
  private readonly recovering = new Map<string, Promise<{ applied: number; abandoned: number; unknown: number }>>()
  /** Reconcile receipts, never replay a write. Lease ownership lives in the existing append-only governance log.
   *  One reconciliation of a workspace at a time: a second caller (a Connect's route beside the reconnection's
   *  listener, a queued run) joins the one under way. */
  recover(ws: Workspace): Promise<{ applied: number; abandoned: number; unknown: number }> {
    const running = this.recovering.get(ws.id)
    if (running) return running
    const next = this.serial(ws, () => this.recoverOnce(ws)).finally(() => { if (this.recovering.get(ws.id) === next) this.recovering.delete(ws.id) })
    this.recovering.set(ws.id, next)
    return next
  }
  private async recoverOnce(ws: Workspace): Promise<{ applied: number; abandoned: number; unknown: number }> {
    const conn = this.remote.conn, root = remoteBinding(ws)
    // a foreground writer of this process (a run's, an acquisition under way, an operation's) is never reconciled away;
    // a lease only background commands keep (no foreground run) is reconciled like any other — its receipts settled,
    // a release whose answer was lost settled — under the root's one turn, so no adoption meets it half done
    const kept = this.holdings.get(ws.id)
    const background = kept !== undefined && kept.holder === null
    if ((this.activeLeases.has(ws.id) && !background) || this.remote.isPaused(root.target_id)) return { applied: 0, abandoned: 0, unknown: 0 }
    await this.remote.request(root, 'roots.validate', {})
    const result = await this.reconcileReceipts(ws)
    // A restarted run's borrowed jobs may still be alive or draining their final logs. A receipt alone does not unpin
    // them: a job not durably finalized (liveJobs) keeps the lease.
    if (this.liveJobs(ws).length) return result
    const note = repo.governanceForRef(conn, 'remote_file_lease', ws.id), saved = note?.params
    if (!note || !saved || !['intent','held','releasing'].includes(String(saved.state)) || JSON.stringify(saved.root) !== JSON.stringify(root) || result.unknown) return result
    // A lease of a run still going (its original run, or the run of its conversation that holds it now) is that run's
    // writer, never a stale one.
    for (const id of [saved.run_id, saved.holder_run_id]) if (saved.owner_kind === 'run' && typeof id === 'string' && ['running', 'queued'].includes(repo.getRun(conn, id)?.status ?? '')) return result
    // Every await below may let a run take the workspace: the stale writer is released only while the record read
    // above is still the latest and no acquisition or held lease of this process is on it.
    const unchanged = () => (background ? this.holdings.get(ws.id) === kept && kept!.holder === null : !this.activeLeases.has(ws.id)) && repo.governanceForRef(conn, 'remote_file_lease', ws.id)?.id === note.id
    const letGo = (proof: LeaseProof | null) => {
      const h = this.holdings.get(ws.id)
      if (h !== undefined && h.holder === null && (proof === null || sameProof(h.lease, proof))) { this.holdings.delete(ws.id); this.activeLeases.delete(ws.id) }
    }
    let lease = saved.lease as LeaseProof | undefined
    if (!lease && typeof saved.acquire_operation_id === 'string') {
      const status = await this.remote.request(root, 'operations.status', { operation_id: saved.acquire_operation_id })
      if (status.state === 'applied' && status.result && 'lease_id' in status.result) lease = status.result
    }
    const current = await this.remote.request(root, 'leases.inspect', {})
    if (!unchanged()) return result
    if (current === null) { this.leaseNote(ws, 'released', { release_operation_id: null }); letGo(null); return result }
    if (!lease || lease.owner_id !== saved.owner_id || current.lease_id !== lease.lease_id || current.owner_id !== lease.owner_id || current.fence !== lease.fence) return result
    // The adapter also refuses release if any durable job or operation remains unknown. A release already under way (its
    // intent written, its outcome unknown) is settled from its own receipt first: applied, it is done; failed (refused
    // then, by a job or an operation not settled at the time), the lease is held again and released by a new operation
    // now that nothing keeps it — a failed operation is never replayed (the adapter would answer its failure again);
    // with no receipt, the same operation again, never a second.
    let operation = newId('op')
    if (saved.state === 'releasing' && typeof saved.release_operation_id === 'string') {
      const receipt = await this.remote.request(root, 'operations.status', { operation_id: saved.release_operation_id }).catch(() => null)
      if (!unchanged()) return result
      if (receipt?.state === 'applied') { this.leaseNote(ws, 'released', { release_operation_id: null }); letGo(lease); return result }
      if (receipt?.state === 'failed') this.leaseNote(ws, 'held', { release_operation_id: null })
      else operation = saved.release_operation_id
    }
    if (operation !== saved.release_operation_id || saved.state !== 'releasing') this.leaseNote(ws, 'releasing', { release_operation_id: operation })
    try { await this.remote.request(root, 'leases.release', { lease }, operation) }
    catch (error) {
      // the lease is no longer this proof's (released or taken meanwhile by another reconciliation or writer): that
      // writer's state is not this record's to change; nothing was released here
      if ((error as { code?: string }).code === 'lease_conflict') { if (repo.governanceForRef(conn, 'remote_file_lease', ws.id)?.params.release_operation_id === operation) { this.leaseNote(ws, 'released', { release_operation_id: null }); letGo(lease) } return result }
      throw error
    }
    if (repo.governanceForRef(conn, 'remote_file_lease', ws.id)?.params.release_operation_id === operation) { this.leaseNote(ws, 'released', { release_operation_id: null }); letGo(lease) }
    return result
  }
  async recoverTarget(targetId: string): Promise<{ workspace_id: string; status: string; code?: string }[]> {
    const results: { workspace_id: string; status: string; code?: string }[] = []
    for (const row of this.remote.conn.all('SELECT id FROM workspaces WHERE target_id=?', [targetId])) {
      const ws = repo.getWorkspace(this.remote.conn, String(row.id))
      if (!ws) continue
      try { const counts = await this.recover(ws); results.push({ workspace_id: ws.id, status: counts.unknown ? 'unknown' : 'reconciled' }) }
      catch (error) { results.push({ workspace_id: ws.id, status: 'unknown', code: (error as { code?: string }).code ?? 'remote_unavailable' }) }
    }
    return results
  }
  async resolve(ws: Workspace, path: string, allowMissing = false, waitMs?: number) {
    const root = remoteBinding(ws)
    const resolved = await this.remote.request(root, 'files.resolve', { path: remotePath(ws, path), allow_missing: allowMissing }, undefined, waitMs === undefined ? {} : { wait_ms: waitMs })
    if (remotePath(ws, resolved.path) !== resolved.path || posix.join(root.path, resolved.path) !== resolved.absolute_path) throw new RemoteRefused('protocol_mismatch', 'Remote canonical path is inconsistent.')
    return resolved
  }
  async list(ws: Workspace, path = '.', offset = 0, limit = 300) {
    const rel = (await this.resolve(ws, path)).path
    const page = await this.remote.request(remoteBinding(ws), 'files.list', { path: rel, offset: Math.max(0, offset), limit: Math.max(1, Math.min(300, limit)) })
    const entries = page.entries.filter(e => !e.path.split('/').some(p => p === '.git' || p === '.oasis-remote')).map(e => ({ path: posix.normalize(e.path) + (e.kind === 'directory' ? '/' : ''), bytes: e.kind === 'file' ? e.size : null }))
    return { status: 'ok' as const, path: rel, entries, count: offset + entries.length, truncated: page.truncated, next_offset: page.next_offset, skipped_in_excluded_dirs: page.entries.length - entries.length }
  }
  /** A regular file's bytes, up to 2 MiB — or up to `images` bytes for a PNG, JPEG or WebP file (its first bytes say). */
  async raw(ws: Workspace, path: string, images = REMOTE_SMALL_FILE_BYTES): Promise<Buffer> {
    const rel = (await this.resolve(ws, path)).path, root = remoteBinding(ws)
    const stat = await this.remote.request(root, 'files.stat', { path: rel })
    const limit = stat.kind === 'file' && stat.size > REMOTE_SMALL_FILE_BYTES && stat.size <= images
      && sniffImage(Buffer.from((await this.remote.request(root, 'files.read', { path: rel, byte_offset: 0, limit: 16, expected_hash: stat.sha256 })).data, 'base64')) !== null
      ? images : REMOTE_SMALL_FILE_BYTES
    if (stat.kind !== 'file' || stat.size > limit) throw new RemoteRefused('file_limit', images > REMOTE_SMALL_FILE_BYTES ? `Remote file tools read regular files up to 2 MiB, and PNG, JPEG or WebP images up to ${images / 1024 / 1024} MB.` : 'Remote file tools read regular files up to 2 MiB.')
    const chunks: Buffer[] = []
    let offset = 0
    for (;;) {
      const page = await this.remote.request(root, 'files.read', { path: rel, byte_offset: offset, limit: 256 * 1024, expected_hash: stat.sha256 })
      const data = Buffer.from(page.data, 'base64')
      if (page.next_offset !== offset + data.length || page.next_offset > limit) throw new RemoteRefused('protocol_mismatch', 'Invalid remote file page.')
      chunks.push(data)
      if (page.eof) break
      if (page.next_offset <= offset) throw new RemoteRefused('protocol_mismatch', 'Remote file read made no progress.')
      offset = page.next_offset
    }
    const data = Buffer.concat(chunks)
    if (stat.sha256 && sha256Of(data) !== stat.sha256) throw new RemoteRefused('version_conflict', 'Remote file changed during read.')
    return data
  }
  async read(ws: Workspace, path: string, offset = 1, limit = 400) {
    path = (await this.resolve(ws, path)).path
    const data = await this.raw(ws, path)
    if (isBinary(data)) throw new RemoteRefused('file_type', 'Remote text tools do not read binary files.')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
    const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop()
    const start = Math.max(1, Math.trunc(offset) || 1), count = Math.max(1, Math.min(2000, Math.trunc(limit) || 1))
    const window = lines.slice(start - 1, start - 1 + count), end = start + window.length - 1
    return { status: 'ok' as const, path: remotePath(ws, path), sha256: sha256Of(data), bytes: data.length, total_lines: lines.length, from_line: start, to_line: end,
      truncated: end < lines.length, next_offset_line: end < lines.length ? end + 1 : null, content: window.map((line, i) => `${start + i}\t${line}`).join('\n') }
  }
  async now(ws: Workspace, path: string): Promise<Buffer | null> {
    const root = remoteBinding(ws)
    // Validate separately: a missing/replaced project or state is never the absence of a user file.
    await this.remote.request(root, 'roots.validate', {})
    try { return await this.raw(ws, path) } catch (error) {
      // The v1 adapter sends the exact remote exception class in its authenticated framed response.
      // No SSH stderr, timeout, generic storage failure or unknown operation is treated as absence.
      if (error instanceof RemoteError && (error.code === 'not_found' || (error.code === 'storage_failed' && error.message === 'FileNotFoundError'))) {
        await this.remote.request(root, 'roots.validate', {})
        return null
      }
      throw error
    }
  }
  async withLease<T>(ws: Workspace, owner: string, action: (lease: LeaseProof) => Promise<T>): Promise<T> {
    const borrowed = this.leaseForRun(owner, ws)
    if (borrowed) return action(borrowed)
    const root = remoteBinding(ws)
    if (this.activeLeases.has(ws.id)) throw new RemoteRefused('workspace_busy', 'A remote file operation already holds this workspace.')
    await this.recover(ws)
    if (this.activeLeases.has(ws.id)) throw new RemoteRefused('workspace_busy', 'A remote file operation already holds this workspace.')
    this.activeLeases.add(ws.id)
    const acquireOperation = newId('op')
    let lease: LeaseProof
    try {
      // an operation's own lease: nothing of a run's earlier note (its run, conversation, holder, release) carries over
      this.leaseNote(ws, 'intent', { owner_id: owner, owner_kind: 'operation', run_id: null, cohort: null, holder_run_id: null, release_operation_id: null, acquire_operation_id: acquireOperation, lease: null })
      lease = await this.remote.request(root, 'leases.acquire', { owner_id: owner }, acquireOperation)
      this.leaseNote(ws, 'held', { lease })
    } catch (error) { this.activeLeases.delete(ws.id); throw error }
    let settled = false
    try { const result = await action(lease); settled = true; return result }
    catch (error) {
      const e = error as { status?: unknown; code?: string }
      // Explicit precondition refusals are settled; transport/storage/receipt uncertainty never is.
      settled = e.code !== 'outcome_unknown' && (e.status === 'conflict' || e.status === 'refused' || (error instanceof RemoteRefused && error.status < 500))
      throw error
    }
    finally {
      // Unknown mutation outcome keeps the remote lease; never unlock merely because the connection ended.
      // released as a run's is: its intent written first, under the root's one turn; an unknown answer stays 'releasing'
      // (never adopted: it is no run's lease) until reconciliation settles it
      try {
        if (settled) await this.serial(ws, () => this.sendRelease(ws, lease, newId('op')))
      } finally { this.activeLeases.delete(ws.id) }
    }
  }
  ensureSettled(ws: Workspace): void {
    const root = remoteBinding(ws)
    if (this.remote.conn.get("SELECT 1 FROM remote_journal_operations r JOIN file_journal j ON j.id=r.journal_id WHERE r.root_id=? AND r.generation=? AND j.state='prepared' LIMIT 1", [root.root_id, root.generation])) throw new RemoteRefused('outcome_unknown', 'A remote file operation is unsettled; reconcile it before another mutation.', 503)
  }
  async write(ws: Workspace, path: string, data: Buffer | null, expected: string | null, record: { session_id: string | null; run_id: string | null; tool_call_id: string | null; cancelled?: () => boolean }, lease: LeaseProof, undoes: string[] = []) {
    if (data && data.length > REMOTE_SMALL_FILE_BYTES) throw new RemoteRefused('file_limit', 'Remote journal writes are limited to 2 MiB.')
    const rel = (await this.resolve(ws, path, true)).path, root = remoteBinding(ws), before = await this.now(ws, rel)
    if ((before === null ? null : sha256Of(before)) !== expected) throw new RemoteRefused('version_conflict', 'Remote file changed or was not read before writing.')
    this.ensureSettled(ws)
    const op = newId('op')
    const entry = this.remote.conn.transaction(() => {
      const e = this.journal.prepare(ws, { session_id: record.session_id, run_id: record.run_id, tool_call_id: record.tool_call_id, path: rel, action: data === null ? 'removed' : before === null ? 'created' : undoes.length ? 'restored' : 'overwritten', before, intended: data, undoes })
      this.remote.conn.run('INSERT INTO remote_journal_operations (journal_id,target_id,root_id,generation,operation_id) VALUES (?,?,?,?,?)', [e.id,root.target_id,root.root_id,root.generation,op])
      return e
    })
    let receipt: WriteReceipt
    try {
      receipt = data === null
        ? await this.remote.request(root, 'files.remove', { path: rel, expected_hash: expected!, lease }, op)
        : await this.remote.request(root, 'files.write', { path: rel, expected_hash: expected, data: data.toString('base64'), lease }, op)
    } catch (error) {
      // An explicit remote refusal proves no write; so does a failure before any byte of it reached ssh.
      const e = error as { status?: unknown; code?: string; delivery?: string }
      if (((e.status === 'refused' || e.status === 'conflict') && e.code !== 'outcome_unknown') || (e.delivery === 'not_sent' && e.code !== 'outcome_unknown')) {
        this.remote.conn.transaction(() => {
          this.journal.abandoned(entry)
          this.remote.conn.run("UPDATE remote_journal_operations SET state='abandoned' WHERE journal_id=?", [entry.id])
        })
        throw error
      }
      // The reply was lost (or the remote could not say): the write was sent once and is never sent again. What
      // happened is in its own operation receipt, asked for while the connection comes back.
      const status = await this.settleOperation(root, op, record.cancelled)
      const settled = status ? this.settleEntry(entry, op, status) : 'unknown'
      if (settled === 'applied') return status!.result as WriteReceipt
      if (settled === 'abandoned') throw new RemoteRefused(status!.code ?? 'write_failed', `Remote write failed (${status!.code ?? 'failed'}); nothing was written.`, 409)
      throw new RemoteOutcomeUnresolved(`Remote operation outcome unknown: write ${rel} (operation ${op}, receipt ${status?.state ?? 'unreachable'}); not sent again.`,
        { kind: 'file_write', operation_id: op, target_id: root.target_id, path: rel, receipt_state: status?.state ?? 'unreachable' })
    }
    if (receipt.state !== 'applied' || receipt.operation_id !== op || receipt.path !== rel || receipt.before_sha256 !== expected || receipt.after_sha256 !== (data === null ? null : sha256Of(data))) {
      // a receipt for something other than what the journal prepared: neither applied nor abandoned, never resent
      throw new RemoteOutcomeUnresolved(`Remote operation outcome unknown: write ${rel} (operation ${op}, receipt does not match the prepared write).`,
        { kind: 'file_write', operation_id: op, target_id: root.target_id, path: rel, receipt_state: 'mismatch' })
    }
    this.remote.conn.transaction(() => {
      this.journal.applied(entry, data)
      this.remote.conn.run("UPDATE remote_journal_operations SET state='applied' WHERE journal_id=?", [entry.id])
    })
    return receipt
  }
  async changes(ws: Workspace): Promise<FileChange[]> {
    await this.remote.request(remoteBinding(ws), 'roots.validate', {})
    const grouped = new Map<string, ReturnType<typeof repo.listJournal>>()
    for (const entry of repo.listJournal(this.remote.conn, { workspace_id: ws.id }).filter(e => e.run_id !== null && e.undone_by === null)) {
      const group = grouped.get(entry.path) ?? []; group.push(entry); grouped.set(entry.path, group)
    }
    const changes: FileChange[] = []
    for (const [path, entries] of grouped) {
      const before = repo.journalBytes(this.remote.conn, entries[0]!.id, 'before'), after = await this.now(ws, path)
      if ((before === null ? null : sha256Of(before)) !== (after === null ? null : sha256Of(after))) changes.push({ path, before, after, created: before === null, entries, chain: chainOf(entries) })
    }
    return changes
  }
  async undo(ws: Workspace, runId: string, sessionId: string): Promise<UndoResult> {
    const unresolved = repo.listPreparedJournal(this.remote.conn, runId)
    const changes = this.journal.runChanges(runId).filter(c => c.entries.some(e => e.undone_by === null))
    const result: UndoResult = { run_id: runId, restored: [], removed: [], conflicts: [], nothing: changes.length === 0 && unresolved.length === 0 }
    for (const e of unresolved) result.conflicts.push({ path: e.path, reason: 'Remote write outcome is unknown; reconcile it before undo.', code: 'remote_unknown' })
    if (!changes.length) return result
    return this.withLease(ws, newId('undo'), async lease => {
      for (const change of changes) {
        if (unresolved.some(e => e.path === change.path)) continue
        // another hand wrote between two of the run's writes: the whole path is left alone
        if (change.chain === 'broken') { result.conflicts.push({ path: change.path, reason: CHAIN_BROKEN, code: 'chain_broken' }); continue }
        const last = change.entries.at(-1)!
        try {
          const now = await this.now(ws, change.path)
          if ((now === null ? null : sha256Of(now)) !== last.after_sha) { result.conflicts.push({ path: change.path, reason: 'Changed since the run wrote it.', code: 'changed_since' }); continue }
          await this.write(ws, change.path, change.before === null ? null : Buffer.from(change.before), last.after_sha, { session_id: sessionId, run_id: null, tool_call_id: null }, lease, change.entries.map(e => e.id))
          ;(change.before === null ? result.removed : result.restored).push(change.path)
        } catch (error) {
          if ((error as { code?: string }).code === 'version_conflict') result.conflicts.push({ path: change.path, reason: 'Changed since the run wrote it.', code: 'changed_since' })
          else throw error
        }
      }
      return result
    })
  }
}
