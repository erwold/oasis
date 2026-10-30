/** The remote writer lease and a conversation's background commands (workspace/remote_files.ts): a later run of the
 *  conversation takes over the one durable lease its earlier run's borrowed jobs keep — never a second lease — only
 *  when every record proves the conversation and the remote confirms the exact proof; an old run's late callback never
 *  releases a lease a later run took over; a release in flight is never met half done by an adoption; a release whose
 *  answer was lost is settled later; an unsettled file write, an owned / approval / foreign / unknown-origin job keep
 *  the lease exclusive; a lease from before cohorts were written is migrated only when its records prove it.
 *  An injected adapter that keeps one lease as the real one does; real isolated SQLite; no network, no SSH. */

import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { connect } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { createTarget } from '../src/db/remote_repo.ts'
import { RemoteExecutionDriver } from '../src/execution/remote_driver.ts'
import { RemoteError, type LeaseProof, type RemoteJob } from '../src/remote/types.ts'
import type { RunCohort } from '../src/workspace/cohort.ts'
import { RemoteFiles } from '../src/workspace/remote_files.ts'
import type { RemoteWorkspaceService } from '../src/workspace/remote.ts'
import { tempDir } from './helpers.ts'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
function gate() { let open!: () => void; const opened = new Promise<void>((r) => { open = r }); return { opened, open } }

function fixture() {
  const conn = connect(join(tempDir('oasis-cohort-lease-'), 'state.db'))
  const target = createTarget(conn, { label: 'Cohort', destination: 'user@cohort.invalid' })
  const root = { target_id: target.id, root_id: 'root', generation: 'generation', path: '/project', state_path: '/project/.oasis-remote' }
  const project = repo.createProject(conn, 'cohort', { kind: 'direct', source_path: root.path, base_repo_path: '', base_commit: null, base_branch: null, import_report: {}, remote: root })
  const session = repo.createSession(conn, project.id, 'cohort', 'scripted:a')
  const ws0 = repo.insertWorkspace(conn, 'ws_cohort', project.id, session.id, root.path, '', '', 'direct', null, root)
  repo.setSessionWorkspace(conn, session.id, ws0.id)
  const ws = repo.getWorkspace(conn, ws0.id)!
  const cohort = (conversation: string, participant = 'p_main'): RunCohort => ({ session_id: session.id, participant_id: participant, conversation_id: conversation, workspace_id: ws.id })
  /** a run row and its persisted collaboration record (none: `collab` false) */
  const run = (id: string, status: string, conversation = 'conv_a', collab = true) => {
    conn.run('INSERT INTO runs (id,session_id,project_id,workspace_id,model,user_text,status,created_at) VALUES (?,?,?,?,?,?,?,?)', [id, session.id, project.id, ws.id, 'scripted:a', id, status, new Date().toISOString()])
    if (collab) conn.run('INSERT INTO run_collab (run_id,session_id,participant_id,conversation_id,origin_json,placement_json,created_at) VALUES (?,?,?,?,?,?,?)', [id, session.id, 'p_main', conversation, '{}', '{}', new Date().toISOString()])
  }
  const setStatus = (id: string, status: string) => conn.run('UPDATE runs SET status=? WHERE id=?', [status, id])
  // the adapter's one lease, its jobs and its operation records
  const host = {
    lease: null as LeaseProof | null, fence: 0, ops: new Map<string, { state: string; result?: unknown }>(), jobs: new Map<string, RemoteJob>(), jobState: new Map<string, RemoteJob['state']>(),
    calls: [] as string[], releases: 0, conflicts: 0,
    releaseGate: null as Promise<void> | null, loseReleaseReply: false, opsUnknown: false,
  }
  const remote = {
    conn, isPaused: () => false, reachable: () => true,
    async request(_root: unknown, method: string, params: any, operation?: string): Promise<any> {
      host.calls.push(method)
      if (method === 'roots.validate') return root
      if (method === 'operations.status') {
        if (host.opsUnknown) return { operation_id: params.operation_id, state: 'not_found' }
        const op = host.ops.get(params.operation_id)
        return op ? { operation_id: params.operation_id, ...op } : { operation_id: params.operation_id, state: 'not_found' }
      }
      if (method === 'leases.inspect') return host.lease
      if (method === 'leases.acquire') {
        if (host.lease) { host.ops.set(operation!, { state: 'failed' }); throw new RemoteError('lease_conflict', 'Root already has a writer', 'conflict') }
        host.lease = { lease_id: `lease-${++host.fence}`, owner_id: params.owner_id, fence: host.fence }
        host.ops.set(operation!, { state: 'applied', result: host.lease })
        return host.lease
      }
      if (method === 'leases.release') {
        if (host.releaseGate) await host.releaseGate
        const proof = params.lease as LeaseProof
        // an operation is answered from its record once it has one (applied or failed), as the adapter does
        const recorded = host.ops.get(operation!)
        if (recorded?.state === 'applied') return { released: true }
        if (recorded?.state === 'failed') throw new RemoteError('outcome_unknown', 'Active or unknown job retains writer lease', 'unknown')
        if (!host.lease || host.lease.lease_id !== proof.lease_id || host.lease.fence !== proof.fence || host.lease.owner_id !== proof.owner_id) { host.conflicts++; throw new RemoteError('lease_conflict', 'Current root writer lease required', 'conflict') }
        for (const op of host.jobs.keys()) if ((host.jobState.get(op) ?? 'running') !== 'exited') { host.ops.set(operation!, { state: 'failed' }); throw new RemoteError('outcome_unknown', 'Active or unknown job retains writer lease', 'unknown') }
        host.lease = null; host.releases++
        host.ops.set(operation!, { state: 'applied', result: { released: true } })
        if (host.loseReleaseReply) { host.loseReleaseReply = false; throw new RemoteError('outcome_unknown', 'reply lost', 'unknown') }
        return { released: true }
      }
      if (method === 'jobs.start') {
        if (!host.lease || params.lease.lease_id !== host.lease.lease_id) throw new RemoteError('lease_conflict', 'Current root writer lease required', 'conflict')
        const job: RemoteJob = { job_id: `job-${host.jobs.size}`, operation_id: operation!, state: 'running', timeout_s: null, output_cap_bytes: null }
        host.jobs.set(operation!, job)
        return job
      }
      const entry = method === 'jobs.recover' ? [...host.jobs].find(([op]) => op === params.operation_id) : [...host.jobs].find(([, j]) => j.job_id === params.job_id)
      if (!entry) throw new RemoteError('outcome_unknown', 'No durable mapping', 'unknown')
      const [op, job] = entry
      const state = host.jobState.get(op) ?? 'running'
      const current = { ...job, state, ...(state === 'exited' ? { exit_code: 0, stdout_bytes: 0, stderr_bytes: 0 } : {}) }
      if (method === 'jobs.status' || method === 'jobs.recover') return current
      if (method === 'jobs.read') return { data: '', byte_offset: params.byte_offset, next_offset: params.byte_offset, eof: state === 'exited', total_written: 0, total_retained: 0, gaps: [] }
      if (method === 'jobs.stop') return { job_id: job.job_id, state: 'requested', job: current }
      throw new Error('unexpected ' + method)
    },
  } as unknown as RemoteWorkspaceService
  const files = new RemoteFiles(remote, { settle_ms: 0 })
  const driver = new RemoteExecutionDriver({ conn, remote })
  /** a borrowed job of `runId` (its run's own tool): started with the run's proof */
  const job = async (runId: string) => {
    const proof = files.leaseForRun(runId, ws)
    expect(proof).not.toBeNull()
    const x = await driver.start({ project_id: project.id, workspace_id: ws.id, run_id: runId, access: 'full', command: 'sleep 100', cwd: root.path, remote_lease: proof!, launched_by: 'run' }, ws)
    return x.id
  }
  /** the job of execution `xid` exits on the host and its end is read */
  const exit = async (xid: string) => {
    const op = String(conn.get('SELECT operation_id FROM remote_jobs WHERE execution_id=?', [xid])!.operation_id)
    host.jobState.set(op, 'exited')
    await driver.poll(xid)
    expect(driver.pending(xid)).toBe(false)
  }
  const note = () => repo.governanceForRef(conn, 'remote_file_lease', ws.id)!.params
  return { conn, ws, root, session, project, cohort, run, setStatus, host, remote, files, driver, job, exit, note, close: () => driver.close() }
}

const noQueue = () => { throw new Error('unexpected queue') }

test('a later run of the conversation takes over the lease its earlier run\'s job keeps — no second lease; the old run\'s late callback never releases it; it goes once nothing keeps it', async () => {
  const f = fixture()
  try {
    f.run('run_r1', 'running')
    await f.files.holdRun(f.ws, 'run_r1', () => false, noQueue, f.cohort('conv_a'))
    expect(f.note()).toMatchObject({ state: 'held', owner_id: 'run_r1', holder_run_id: 'run_r1', cohort: f.cohort('conv_a') })
    const proof = f.files.leaseForRun('run_r1', f.ws)!
    const x1 = await f.job('run_r1')
    // R1 ends with its job running: no longer the foreground; the lease stays
    f.setStatus('run_r1', 'done')
    await f.files.releaseRun('run_r1')
    expect(f.host.lease).toEqual(proof)
    expect(f.files.leaseForRun('run_r1', f.ws)).toBeNull()
    // R2 of the same conversation: adopted, the same proof, no acquire
    f.run('run_r2', 'running')
    const acquiresBefore = f.host.calls.filter((m) => m === 'leases.acquire').length
    await f.files.holdRun(f.ws, 'run_r2', () => false, noQueue, f.cohort('conv_a'))
    expect(f.host.calls.filter((m) => m === 'leases.acquire').length).toBe(acquiresBefore)
    expect(f.files.leaseForRun('run_r2', f.ws)).toEqual(proof)
    expect(f.files.leaseForRun('run_r1', f.ws)).toBeNull()
    expect(f.note()).toMatchObject({ state: 'held', owner_id: 'run_r1', holder_run_id: 'run_r2', cohort: f.cohort('conv_a') })
    // the adopted run's own job borrows the same proof (the driver checks the run against the note's conversation)
    const x2 = await f.job('run_r2')
    expect(JSON.parse(String(f.conn.get('SELECT record_json FROM remote_jobs WHERE execution_id=?', [x2])!.record_json)).state.spec.lease).toEqual(proof)
    // R1's job ends and its old callback asks for the release: R2 holds it — nothing is released, nothing of R2's goes
    await f.exit(x1)
    await f.files.releaseIfIdle(f.ws)
    expect(f.host.releases).toBe(0)
    expect(f.files.leaseForRun('run_r2', f.ws)).toEqual(proof)
    // R2 ends with its job running: kept; the job ends: released once, every hold gone
    f.setStatus('run_r2', 'done')
    await f.files.releaseRun('run_r2')
    expect(f.host.releases).toBe(0)
    await f.exit(x2)
    await f.files.releaseIfIdle(f.ws)
    await f.files.releaseIfIdle(f.ws)
    expect(f.host.releases).toBe(1)
    expect(f.host.conflicts).toBe(0)
    expect(f.note()).toMatchObject({ state: 'released' })
    // a later run acquires afresh
    f.run('run_r3', 'running')
    await f.files.holdRun(f.ws, 'run_r3', () => false, noQueue, f.cohort('conv_a'))
    expect(f.files.leaseForRun('run_r3', f.ws)?.owner_id).toBe('run_r3')
  } finally { await f.close() }
})

test('another conversation, participant or a run without a cohort never takes it over: it waits for the writer', async () => {
  for (const [label, other] of [['another conversation', 'conv_b'], ['another participant', 'participant'], ['no cohort', null]] as const) {
    const f = fixture()
    try {
      f.run('run_r1', 'running')
      await f.files.holdRun(f.ws, 'run_r1', () => false, noQueue, f.cohort('conv_a'))
      await f.job('run_r1')
      f.setStatus('run_r1', 'done')
      await f.files.releaseRun('run_r1')
      f.run('run_x', 'running', other === 'conv_b' ? 'conv_b' : 'conv_a')
      const queued: string[] = []
      let stop = false
      const cohort = other === null ? null : other === 'participant' ? f.cohort('conv_a', 'p_member') : f.cohort('conv_b')
      const waiting = f.files.holdRun(f.ws, 'run_x', () => stop, (o) => { queued.push(o); stop = true }, cohort).catch((e) => e)
      expect(String(await waiting), label).toContain('stopped')
      expect(queued, label).toEqual(['run_r1'])
      expect(f.files.leaseForRun('run_x', f.ws), label).toBeNull()
      expect(f.note().holder_run_id, label).toBe('run_r1')
    } finally { await f.close() }
  }
})

test('a release already in flight is never met half done by an adoption: the run waits for it and then takes a fresh lease', async () => {
  const f = fixture()
  try {
    f.run('run_r1', 'running')
    await f.files.holdRun(f.ws, 'run_r1', () => false, noQueue, f.cohort('conv_a'))
    const stale = f.files.leaseForRun('run_r1', f.ws)!
    f.setStatus('run_r1', 'done')
    const g = gate(); f.host.releaseGate = g.opened
    const releasing = f.files.releaseRun('run_r1')                    // its intent written, its answer held back
    await sleep(20)
    expect(f.note()).toMatchObject({ state: 'releasing' })
    f.run('run_r2', 'running')
    const r2 = f.files.holdRun(f.ws, 'run_r2', () => false, () => {}, f.cohort('conv_a'))
    await sleep(50)
    expect(f.files.leaseForRun('run_r2', f.ws)).toBeNull()             // not adopted while the release is under way
    g.open(); f.host.releaseGate = null
    await releasing
    await r2
    expect(f.host.releases).toBe(1)
    expect(f.host.conflicts).toBe(0)
    const fresh = f.files.leaseForRun('run_r2', f.ws)!
    expect(fresh.owner_id).toBe('run_r2')
    expect(fresh.lease_id).not.toBe(stale.lease_id)
  } finally { await f.close() }
})

test('a release whose answer was lost keeps the record releasing (never adopted); reconciliation settles it later and the next run goes on', async () => {
  const f = fixture()
  try {
    f.run('run_r1', 'running')
    await f.files.holdRun(f.ws, 'run_r1', () => false, noQueue, f.cohort('conv_a'))
    f.setStatus('run_r1', 'done')
    f.host.loseReleaseReply = true; f.host.opsUnknown = true
    await f.files.releaseRun('run_r1')
    expect(f.host.lease).toBeNull()                                    // released on the host; the answer never came
    expect(f.note()).toMatchObject({ state: 'releasing' })
    // the background-only hold does not keep reconciliation out: it settles the lost answer
    f.host.opsUnknown = false
    await f.files.recover(f.ws)
    expect(f.note()).toMatchObject({ state: 'released' })
    f.run('run_r2', 'running')
    await f.files.holdRun(f.ws, 'run_r2', () => false, noQueue, f.cohort('conv_a'))
    expect(f.files.leaseForRun('run_r2', f.ws)?.owner_id).toBe('run_r2')
  } finally { await f.close() }
})

test('a release refused by a job of unknown end leaves the lease held; once the job is read as ended, reconciliation releases it', async () => {
  const f = fixture()
  try {
    f.run('run_r1', 'running')
    await f.files.holdRun(f.ws, 'run_r1', () => false, noQueue, f.cohort('conv_a'))
    const x1 = await f.job('run_r1')
    f.setStatus('run_r1', 'done')
    await f.files.releaseRun('run_r1')                                  // the job lives: not even asked
    expect(f.host.calls.filter((m) => m === 'leases.release')).toHaveLength(0)
    await f.files.recover(f.ws)                                         // still live: nothing released
    expect(f.host.lease).not.toBeNull()
    await f.exit(x1)
    await f.files.recover(f.ws)
    expect(f.host.releases).toBe(1)
    expect(f.note()).toMatchObject({ state: 'released' })
  } finally { await f.close() }
})

test('an unsettled file write, or an owned, approval, foreign-conversation or unknown-origin job keeps the lease exclusive', async () => {
  for (const change of ['unsettled-write', 'owned-job', 'approval-job', 'foreign-run-job', 'no-collab-run-job', 'releasing-note'] as const) {
    const f = fixture()
    try {
      f.run('run_r1', 'running')
      await f.files.holdRun(f.ws, 'run_r1', () => false, noQueue, f.cohort('conv_a'))
      const x1 = await f.job('run_r1')
      f.setStatus('run_r1', 'done')
      await f.files.releaseRun('run_r1')
      expect(f.files.provenCohort(f.ws)?.cohort, change).toEqual(f.cohort('conv_a'))
      const record = JSON.parse(String(f.conn.get('SELECT record_json FROM remote_jobs WHERE execution_id=?', [x1])!.record_json))
      if (change === 'unsettled-write') {
        const entry = f.files.journal.prepare(f.ws, { session_id: f.session.id, run_id: 'run_r1', tool_call_id: 't1', path: 'a.txt', action: 'created', before: null, intended: Buffer.from('a') })
        f.conn.run('INSERT INTO remote_journal_operations (journal_id,target_id,root_id,generation,operation_id) VALUES (?,?,?,?,?)', [entry.id, f.root.target_id, f.root.root_id, f.root.generation, 'op_unsettled'])
      }
      if (change === 'owned-job') { record.lease_ownership = 'owned'; f.conn.run('UPDATE remote_jobs SET record_json=?', [JSON.stringify(record)]) }
      if (change === 'approval-job') f.conn.run("UPDATE executions SET isolation_json=json_set(isolation_json,'$.launched_by','approval') WHERE id=?", [x1])
      if (change === 'foreign-run-job') { f.run('run_b', 'done', 'conv_b'); f.conn.run('UPDATE executions SET run_id=? WHERE id=?', ['run_b', x1]) }
      if (change === 'no-collab-run-job') { f.run('run_legacy', 'done', 'conv_a', false); f.conn.run('UPDATE executions SET run_id=? WHERE id=?', ['run_legacy', x1]) }
      if (change === 'releasing-note') repo.logGovernance(f.conn, f.session.id, 'remote_file_lease', { actor: 'harness', ref: f.ws.id, params: { ...f.note(), state: 'releasing' } })
      expect(f.files.provenCohort(f.ws), change).toBeNull()
      f.run('run_r2', 'running')
      let stop = false
      const queued: string[] = []
      await f.files.holdRun(f.ws, 'run_r2', () => stop, (o) => { queued.push(o); stop = true }, f.cohort('conv_a')).catch(() => {})
      expect(f.files.leaseForRun('run_r2', f.ws), change).toBeNull()
      expect(queued.length, change).toBeGreaterThan(0)
    } finally { await f.close() }
  }
})

test('a lease from before cohorts were written is taken over only when its own records prove the conversation, and the cohort is written first', async () => {
  for (const change of ['proven', 'owner-not-its-run', 'no-collab', 'job-without-ownership'] as const) {
    const f = fixture()
    try {
      f.run('run_r1', change === 'no-collab' ? 'running' : 'running', 'conv_a', change !== 'no-collab')
      await f.files.holdRun(f.ws, 'run_r1', () => false, noQueue, change === 'no-collab' ? null : f.cohort('conv_a'))
      const x1 = await f.job('run_r1')
      f.setStatus('run_r1', 'interrupted')
      // as an older build wrote it: no cohort, no holder field; its jobs without a launcher
      const legacy: Record<string, unknown> = { ...f.note() }
      delete legacy.cohort; delete legacy.holder_run_id; delete legacy.release_operation_id
      if (change === 'owner-not-its-run') legacy.run_id = 'run_other'
      repo.logGovernance(f.conn, f.session.id, 'remote_file_lease', { actor: 'harness', ref: f.ws.id, params: legacy })
      f.conn.run("UPDATE executions SET isolation_json=json_remove(isolation_json,'$.launched_by') WHERE id=?", [x1])
      if (change === 'job-without-ownership') {
        const record = JSON.parse(String(f.conn.get('SELECT record_json FROM remote_jobs WHERE execution_id=?', [x1])!.record_json))
        delete record.lease_ownership
        f.conn.run('UPDATE remote_jobs SET record_json=?', [JSON.stringify(record)])
      }
      // a restarted process: nothing in memory
      const next = new RemoteFiles(f.remote, { settle_ms: 0 })
      const proven = next.provenCohort(f.ws)
      if (change !== 'proven') { expect(proven, change).toBeNull(); continue }
      expect(proven).toMatchObject({ cohort: f.cohort('conv_a'), derived: true })
      f.run('run_r2', 'running')
      await next.holdRun(f.ws, 'run_r2', () => false, noQueue, f.cohort('conv_a'))
      expect(next.leaseForRun('run_r2', f.ws)).toEqual(f.host.lease!)
      expect(f.note()).toMatchObject({ state: 'held', cohort: f.cohort('conv_a'), holder_run_id: 'run_r2', owner_id: 'run_r1' })
    } finally { await f.close() }
  }
})

test('after a restart, a release whose recorded operation failed (a job still live then) is not replayed: held again, then released by a new operation once nothing keeps it', async () => {
  const f = fixture()
  try {
    f.run('run_r1', 'running')
    await f.files.holdRun(f.ws, 'run_r1', () => false, noQueue, f.cohort('conv_a'))
    const proof = f.files.leaseForRun('run_r1', f.ws)!
    const x1 = await f.job('run_r1')
    // an earlier life sent a release while the job was live: the host recorded it failed; the process died with the
    // record saying releasing
    await expect(f.remote.request(f.root as never, 'leases.release', { lease: proof }, 'op_failed')).rejects.toMatchObject({ code: 'outcome_unknown' })
    repo.logGovernance(f.conn, f.session.id, 'remote_file_lease', { actor: 'harness', ref: f.ws.id, params: { ...f.note(), state: 'releasing', release_operation_id: 'op_failed' } })
    f.setStatus('run_r1', 'interrupted')
    await f.exit(x1)
    const next = new RemoteFiles(f.remote, { settle_ms: 0 })
    await next.recover(f.ws)
    expect(f.host.releases).toBe(1)
    expect(f.host.lease).toBeNull()
    expect(f.note()).toMatchObject({ state: 'released', release_operation_id: null })
    // the failed operation was asked about, never sent again
    const releases = f.host.calls.filter((m) => m === 'leases.release').length
    expect(releases).toBe(2)                         // the failed one (earlier life), the new one
  } finally { await f.close() }
})

test('a background-only hold whose receipts were unknown at the run\'s end is reconciled later, and an unrelated run is not kept waiting forever', async () => {
  const f = fixture()
  try {
    f.run('run_r1', 'running')
    await f.files.holdRun(f.ws, 'run_r1', () => false, noQueue, f.cohort('conv_a'))
    // a file write of the run whose outcome is unknown at its end
    const entry = f.files.journal.prepare(f.ws, { session_id: f.session.id, run_id: 'run_r1', tool_call_id: 't1', path: 'a.txt', action: 'created', before: null, intended: Buffer.from('a') })
    f.conn.run('INSERT INTO remote_journal_operations (journal_id,target_id,root_id,generation,operation_id) VALUES (?,?,?,?,?)', [entry.id, f.root.target_id, f.root.root_id, f.root.generation, 'op_write'])
    f.setStatus('run_r1', 'done')
    f.host.opsUnknown = true
    await f.files.releaseRun('run_r1')
    expect(f.host.lease).not.toBeNull()                                 // kept: an unknown write keeps the lease
    // another conversation's run waits; the write's receipt is found applied meanwhile, and reconciliation (as the
    // waiting run asks for it) settles it and lets the lease go — the run then takes its own
    f.host.opsUnknown = false
    f.host.ops.set('op_write', { state: 'failed' })
    f.run('run_b', 'running', 'conv_b')
    await f.files.holdRun(f.ws, 'run_b', () => false, () => {}, f.cohort('conv_b'))
    expect(f.files.leaseForRun('run_b', f.ws)?.owner_id).toBe('run_b')
    expect(f.host.releases).toBe(1)
  } finally { await f.close() }
}, 30_000)

test('a later callback asking for the release while an earlier release\'s answer is unknown sends that same operation again, never a new one', async () => {
  const f = fixture()
  try {
    f.run('run_r1', 'running')
    await f.files.holdRun(f.ws, 'run_r1', () => false, noQueue, f.cohort('conv_a'))
    f.setStatus('run_r1', 'done')
    // the release reaches the host but its answer is lost, and its receipt cannot be read yet
    f.host.loseReleaseReply = true; f.host.opsUnknown = true
    const proof = f.files.leaseForRun('run_r1', f.ws)!
    f.host.releaseGate = null
    // keep the host's lease (as if the release had not applied yet): only the answer is in doubt
    const realRequest = f.remote.request.bind(f.remote)
    const sent: string[] = []
    ;(f.remote as { request: typeof realRequest }).request = (async (root: never, method: string, params: never, operation?: string) => {
      if (method === 'leases.release') { sent.push(operation!); throw new RemoteError('outcome_unknown', 'reply lost', 'unknown') }
      return realRequest(root, method as never, params, operation)
    }) as typeof realRequest
    await f.files.releaseRun('run_r1')
    expect(f.note()).toMatchObject({ state: 'releasing' })
    const first = f.note().release_operation_id as string
    // an old callback asks again: the same operation, not a second one
    await f.files.releaseIfIdle(f.ws)
    expect(sent).toEqual([first, first])
    expect(f.note().release_operation_id).toBe(first)
    // its receipt is found applied: released, every hold gone
    f.host.opsUnknown = false
    f.host.ops.set(first, { state: 'applied', result: { released: true } })
    f.host.lease = null
    await f.files.releaseIfIdle(f.ws)
    expect(sent).toEqual([first, first])
    expect(f.note()).toMatchObject({ state: 'released' })
    expect(f.files.leaseForRun('run_r1', f.ws)).toBeNull()
    expect(proof.lease_id).toBeTruthy()
  } finally { await f.close() }
})

test('an operation\'s own lease after a run\'s is never taken for the run\'s conversation: its note says operation, carries no run or cohort, and a lost release answer leaves it releasing', async () => {
  const f = fixture()
  try {
    f.run('run_r1', 'running')
    await f.files.holdRun(f.ws, 'run_r1', () => false, noQueue, f.cohort('conv_a'))
    f.setStatus('run_r1', 'done')
    await f.files.releaseRun('run_r1')
    expect(f.note()).toMatchObject({ state: 'released' })
    // an operation (an undo) takes its own lease; its release answer is lost
    f.host.loseReleaseReply = true; f.host.opsUnknown = true
    await f.files.withLease(f.ws, 'undo_op', async (lease) => { expect(lease.owner_id).toBe('undo_op') })
    expect(f.note()).toMatchObject({ owner_kind: 'operation', owner_id: 'undo_op', run_id: null, cohort: null, holder_run_id: null, state: 'releasing' })
    expect(f.files.provenCohort(f.ws)).toBeNull()
    // a run of the earlier conversation does not take it over; it acquires its own once the release is settled
    f.host.opsUnknown = false
    f.run('run_r2', 'running')
    await f.files.holdRun(f.ws, 'run_r2', () => false, () => {}, f.cohort('conv_a'))
    expect(f.files.leaseForRun('run_r2', f.ws)?.owner_id).toBe('run_r2')
    expect(f.host.conflicts).toBe(0)
  } finally { await f.close() }
})

test('a cohort a note carries is never trusted alone: it must be its original run\'s own, and a holder that took it over must be of that conversation', async () => {
  for (const change of ['owner-not-run', 'cohort-not-the-run\'s', 'holder-of-another-conversation'] as const) {
    const f = fixture()
    try {
      f.run('run_r1', 'running')
      await f.files.holdRun(f.ws, 'run_r1', () => false, noQueue, f.cohort('conv_a'))
      await f.job('run_r1')
      f.setStatus('run_r1', 'done')
      await f.files.releaseRun('run_r1')
      expect(f.files.provenCohort(f.ws)).not.toBeNull()
      const params: Record<string, unknown> = { ...f.note() }
      if (change === 'owner-not-run') params.run_id = 'run_somebody'
      if (change === 'cohort-not-the-run\'s') params.cohort = f.cohort('conv_b')
      if (change === 'holder-of-another-conversation') { f.run('run_b', 'done', 'conv_b'); params.holder_run_id = 'run_b' }
      repo.logGovernance(f.conn, f.session.id, 'remote_file_lease', { actor: 'harness', ref: f.ws.id, params })
      expect(f.files.provenCohort(f.ws), change).toBeNull()
    } finally { await f.close() }
  }
})

test('the root\'s guards are the canonical root\'s, whichever alias target recorded a job or a write', async () => {
  for (const change of ['alias-unsettled-write', 'alias-owned-job'] as const) {
    const f = fixture()
    try {
      const alias = createTarget(f.conn, { label: 'Alias', destination: 'user@alias.invalid' })
      f.run('run_r1', 'running')
      await f.files.holdRun(f.ws, 'run_r1', () => false, noQueue, f.cohort('conv_a'))
      const x1 = await f.job('run_r1')
      f.setStatus('run_r1', 'done')
      await f.files.releaseRun('run_r1')
      expect(f.files.provenCohort(f.ws)).not.toBeNull()
      if (change === 'alias-unsettled-write') {
        const entry = f.files.journal.prepare(f.ws, { session_id: f.session.id, run_id: 'run_r1', tool_call_id: 't1', path: 'a.txt', action: 'created', before: null, intended: Buffer.from('a') })
        f.conn.run('INSERT INTO remote_journal_operations (journal_id,target_id,root_id,generation,operation_id) VALUES (?,?,?,?,?)', [entry.id, alias.id, f.root.root_id, f.root.generation, 'op_alias'])
      } else {
        const record = JSON.parse(String(f.conn.get('SELECT record_json FROM remote_jobs WHERE execution_id=?', [x1])!.record_json))
        record.lease_ownership = 'owned'
        f.conn.run('UPDATE remote_jobs SET record_json=?, target_id=? WHERE execution_id=?', [JSON.stringify(record), alias.id, x1])
      }
      expect(f.files.provenCohort(f.ws), change).toBeNull()
      expect(f.files.liveJobIds(f.ws), change).toEqual([x1])
    } finally { await f.close() }
  }
})

test('a job is done only when its durable record is finalized and its summary agrees: a summary that says lost or ended beside an unfinalized record (owned, unowned or of another proof) keeps the lease exclusive', async () => {
  for (const [summary, ownership] of [
    ['lost', 'owned'], ['lost', 'missing'], ['lost', 'other-proof'],
    ['succeeded', 'owned'], ['failed', 'missing'], ['cancelled', 'other-proof'], ['timeout', 'owned'],
  ] as const) {
    const label = `${summary}/${ownership}`
    const f = fixture()
    try {
      f.run('run_r1', 'running')
      await f.files.holdRun(f.ws, 'run_r1', () => false, noQueue, f.cohort('conv_a'))
      const x1 = await f.job('run_r1')
      f.setStatus('run_r1', 'done')
      await f.files.releaseRun('run_r1')
      // only the summary moved (as an older or inconsistent recovery left it); the durable record is not finalized
      f.conn.run('UPDATE executions SET status=?, finished_at=? WHERE id=?', [summary, new Date().toISOString(), x1])
      const record = JSON.parse(String(f.conn.get('SELECT record_json FROM remote_jobs WHERE execution_id=?', [x1])!.record_json))
      expect(record.finalized, label).toBe(false)
      if (ownership === 'owned') record.lease_ownership = 'owned'
      if (ownership === 'missing') delete record.lease_ownership
      if (ownership === 'other-proof') record.state.spec.lease = { ...record.state.spec.lease, fence: record.state.spec.lease.fence + 1 }
      f.conn.run('UPDATE remote_jobs SET record_json=? WHERE execution_id=?', [JSON.stringify(record), x1])
      expect(f.files.liveJobIds(f.ws), label).toEqual([x1])
      expect(f.files.provenCohort(f.ws), label).toBeNull()
      // the conversation's next run waits (and can be stopped), holding nothing
      f.run('run_r2', 'running')
      const queued: string[] = []
      let stop = false
      const r2 = await f.files.holdRun(f.ws, 'run_r2', () => stop, (o) => { queued.push(o); stop = true }, f.cohort('conv_a')).catch((e) => e)
      expect(String(r2), label).toContain('stopped')
      expect(queued.length, label).toBeGreaterThan(0)
      expect(f.files.leaseForRun('run_r2', f.ws), label).toBeNull()
      // nothing releases the lease while the job is not durably done
      await f.files.releaseIfIdle(f.ws)
      await f.files.recover(f.ws)
      await new RemoteFiles(f.remote, { settle_ms: 0 }).recover(f.ws)
      expect(f.host.calls.filter((m) => m === 'leases.release'), label).toEqual([])
      expect(f.host.lease, label).not.toBeNull()
    } finally { await f.close() }
  }
})

test('inconsistent records (finalized but not ended, finalized missing or not a boolean, unreadable, no execution row, an execution of no or another workspace) keep the lease and make it exclusive: never joinable, never released', async () => {
  for (const change of ['finalized-summary-running', 'finalized-missing', 'finalized-not-boolean', 'no-execution-row', 'unreadable-record', 'missing-workspace', 'wrong-workspace'] as const) {
    const f = fixture()
    try {
      f.run('run_r1', 'running')
      await f.files.holdRun(f.ws, 'run_r1', () => false, noQueue, f.cohort('conv_a'))
      const x1 = await f.job('run_r1')
      f.setStatus('run_r1', 'done')
      await f.files.releaseRun('run_r1')
      expect(f.files.provenCohort(f.ws)?.cohort, change).toEqual(f.cohort('conv_a'))   // consistent: provable
      const record = JSON.parse(String(f.conn.get('SELECT record_json FROM remote_jobs WHERE execution_id=?', [x1])!.record_json))
      if (change === 'finalized-summary-running' || change === 'no-execution-row') record.finalized = true
      if (change === 'finalized-missing') delete record.finalized
      if (change === 'finalized-not-boolean') record.finalized = 'false'
      f.conn.run('UPDATE remote_jobs SET record_json=? WHERE execution_id=?', [change === 'unreadable-record' ? '{not json' : JSON.stringify(record), x1])
      if (change === 'no-execution-row') {
        f.conn.run('PRAGMA foreign_keys=OFF')
        f.conn.run('DELETE FROM executions WHERE id=?', [x1])
      }
      // the execution row names no workspace, or another one: its record is otherwise consistent (still pending)
      if (change === 'missing-workspace' || change === 'wrong-workspace') {
        f.conn.run('UPDATE executions SET workspace_id=? WHERE id=?', [change === 'missing-workspace' ? null : 'ws_elsewhere', x1])
        expect(f.driver.pending(x1), change).toBe(true)
      }
      // finalized in its record: the driver (and so the lock pins rebuilt from it) no longer hold it as pending
      if (change === 'finalized-summary-running') {
        expect(repo.getExecution(f.conn, x1)!.finished_at).toBeNull()
        expect(f.driver.pending(x1)).toBe(false)
      }
      // the lease's guards keep it pending all the same — and it proves no conversation
      expect(f.files.liveJobIds(f.ws), change).toEqual([x1])
      expect(f.files.provenCohort(f.ws), change).toBeNull()
      // the conversation's next run waits (and can be stopped), holding nothing
      f.run('run_r2', 'running')
      const queued: string[] = []
      let stop = false
      const r2 = await f.files.holdRun(f.ws, 'run_r2', () => stop, (o) => { queued.push(o); stop = true }, f.cohort('conv_a')).catch((e) => e)
      expect(String(r2), change).toContain('stopped')
      expect(queued.length, change).toBeGreaterThan(0)
      expect(f.files.leaseForRun('run_r2', f.ws), change).toBeNull()
      // and nothing releases the lease
      await f.files.releaseIfIdle(f.ws)
      await f.files.recover(f.ws)
      await new RemoteFiles(f.remote, { settle_ms: 0 }).recover(f.ws)
      expect(f.host.calls.filter((m) => m === 'leases.release'), change).toEqual([])
      expect(f.host.lease, change).not.toBeNull()
    } finally { await f.close() }
  }
})

test('a durably pending job (finalized false in its record) of the conversation\'s exact proof still proves it, whatever its summary says', async () => {
  for (const summary of ['lost', 'succeeded', 'running'] as const) {
    const f = fixture()
    try {
      f.run('run_r1', 'running')
      await f.files.holdRun(f.ws, 'run_r1', () => false, noQueue, f.cohort('conv_a'))
      const x1 = await f.job('run_r1')
      f.setStatus('run_r1', 'done')
      await f.files.releaseRun('run_r1')
      if (summary !== 'running') f.conn.run('UPDATE executions SET status=?, finished_at=? WHERE id=?', [summary, new Date().toISOString(), x1])
      expect(f.driver.pending(x1), summary).toBe(true)
      expect(f.files.liveJobIds(f.ws), summary).toEqual([x1])
      expect(f.files.provenCohort(f.ws)?.cohort, summary).toEqual(f.cohort('conv_a'))
      f.run('run_r2', 'running')
      await f.files.holdRun(f.ws, 'run_r2', () => false, noQueue, f.cohort('conv_a'))
      expect(f.files.leaseForRun('run_r2', f.ws), summary).toEqual(f.host.lease!)
      expect(f.host.calls.filter((m) => m === 'leases.release'), summary).toEqual([])
    } finally { await f.close() }
  }
})

test('a job finalized in its record and ended in its summary is done: the lease goes, as before', async () => {
  const f = fixture()
  try {
    f.run('run_r1', 'running')
    await f.files.holdRun(f.ws, 'run_r1', () => false, noQueue, f.cohort('conv_a'))
    const x1 = await f.job('run_r1')
    f.setStatus('run_r1', 'done')
    await f.files.releaseRun('run_r1')
    await f.exit(x1)                                   // the driver's own end: finalized and ended in one transaction
    expect(f.files.liveJobIds(f.ws)).toEqual([])
    await f.files.releaseIfIdle(f.ws)
    expect(f.host.releases).toBe(1)
  } finally { await f.close() }
})
