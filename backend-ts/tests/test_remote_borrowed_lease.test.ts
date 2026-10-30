import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandBodySchema } from '@oasis-code/contract'
import { connect } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { createTarget } from '../src/db/remote_repo.ts'
import { RemoteFiles } from '../src/workspace/remote_files.ts'
import type { RemoteWorkspaceService } from '../src/workspace/remote.ts'
import { RemoteExecutionDriver } from '../src/execution/remote_driver.ts'
import { RemoteError, type LeaseProof, type RemoteJob } from '../src/remote/types.ts'

async function fixture(borrow = true, sharedSession = false) {
  const dir = mkdtempSync(join(tmpdir(), 'borrowed-lease-db-')), path = join(dir, 'state.db')
  let conn = connect(path)
  const target = createTarget(conn, { label: 'Test', destination: 'controlled.invalid' })
  const root = { target_id: target.id, root_id: 'root', generation: 'generation', path: '/project', state_path: '/tmp/private' }
  const project = repo.createProject(conn, 'test', { kind: 'direct', source_path: root.path, base_repo_path: '', base_commit: null, base_branch: null, import_report: {}, remote: root })
  const session = repo.createSession(conn, project.id, 'test', 'scripted:a')
  const ws = repo.insertWorkspace(conn, 'ws_borrow', project.id, session.id, root.path, '', '', 'direct', null, root)
  repo.setSessionWorkspace(conn, session.id, ws.id)
  const runSession = sharedSession ? repo.createSession(conn, project.id, 'second session', 'scripted:a') : session
  repo.setSessionWorkspace(conn, runSession.id, ws.id)
  const runId = 'run_borrow'
  conn.run("INSERT INTO runs (id,session_id,project_id,workspace_id,model,user_text,status,created_at) VALUES (?,?,?,?,?,?,'running',?)", [runId, runSession.id, project.id, ws.id, 'scripted:a', 'test', new Date().toISOString()])
  let lease: LeaseProof | null = null, counter = 0, state: RemoteJob['state'] = 'running', outcome: 'ok' | 'lost' | 'refused' = 'ok'
  const calls: { method: string; params: any; operation?: string }[] = [], jobs = new Map<string, RemoteJob>()
  const remote = {
    get conn() { return conn }, isPaused: () => false,
    async request(_root: unknown, method: string, params: any, operation?: string): Promise<any> {
      calls.push({ method, params, operation })
      if (method === 'roots.validate') return root
      if (method === 'leases.inspect') return lease
      if (method === 'leases.acquire') {
        if (lease) throw new RemoteError('lease_conflict', 'Already held', 'conflict')
        lease = { lease_id: `lease-${++counter}`, owner_id: params.owner_id, fence: counter }; return lease
      }
      if (method === 'leases.release') { expect(params.lease).toEqual(lease); lease = null; return { released: true } }
      if (method === 'jobs.start') {
        expect(params.lease).toEqual(lease)
        if (outcome === 'refused') throw new RemoteError('invalid_argument', 'Remote precondition refused', 'refused')
        const job: RemoteJob = { job_id: `job-${jobs.size}`, operation_id: operation!, state: 'running', timeout_s: null, output_cap_bytes: null }
        jobs.set(operation!, job)
        if (outcome === 'lost') throw new RemoteError('outcome_unknown', 'Lost start ACK', 'unknown')
        return job
      }
      const job = method === 'jobs.recover' ? jobs.get(params.operation_id) : [...jobs.values()].find(j => j.job_id === params.job_id)
      if (!job) throw new RemoteError('outcome_unknown', 'No durable mapping', 'unknown')
      const current = { ...job, state, ...(state === 'exited' ? { exit_code: 0, stdout_bytes: 0, stderr_bytes: 0 } : {}) }
      if (method === 'jobs.status' || method === 'jobs.recover') return current
      if (method === 'jobs.stop') return { job_id: job.job_id, state: 'requested', job: current }
      if (method === 'jobs.read') return { data: '', byte_offset: params.byte_offset, next_offset: params.byte_offset, eof: state === 'exited', total_written: 0, total_retained: 0, gaps: [] }
      throw new Error('Unexpected method ' + method)
    },
  } as unknown as RemoteWorkspaceService
  const files = new RemoteFiles(remote)
  if (borrow) await files.holdRun(ws, runId, () => false, () => { throw new Error('Unexpected queue') })
  const proof = files.leaseForRun(runId, ws)
  let driver = new RemoteExecutionDriver({ conn, remote })
  const spec = { project_id: project.id, workspace_id: ws.id, run_id: runId, access: 'full' as const, command: 'echo test', cwd: root.path, ...(proof ? { remote_lease: proof } : {}) }
  return { get conn() { return conn }, get driver() { return driver }, remote, files, ws, runId, proof, spec, calls,
    get held() { return lease }, setState(value: RemoteJob['state']) { state = value }, setOutcome(value: typeof outcome) { outcome = value },
    async reopen() { await driver.close(); conn.close(); conn = connect(path); driver = new RemoteExecutionDriver({ conn, remote }); driver.rehydrate() },
    async close() { await driver.close(); conn.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test('borrowed job persists proof/ownership across actual DB close and reopen; terminal never releases run lease', async () => {
  const f = await fixture()
  try {
    const execution = await f.driver.start(f.spec, f.ws)
    expect(f.calls.filter(c => c.method === 'leases.acquire')).toHaveLength(1)
    let record = JSON.parse(String(f.conn.get('SELECT record_json FROM remote_jobs')!.record_json))
    expect(record.lease_ownership).toBe('borrowed'); expect(record.state.spec.lease).toEqual(f.proof)
    await f.reopen(); f.setState('exited'); await f.driver.poll(execution.id)
    expect(f.driver.pending(execution.id)).toBe(false); expect(f.held).toEqual(f.proof)
    expect(f.calls.filter(c => c.method === 'jobs.start')).toHaveLength(1)
    expect(f.calls.filter(c => c.method === 'leases.release')).toHaveLength(0)
    record = JSON.parse(String(f.conn.get('SELECT record_json FROM remote_jobs')!.record_json))
    expect(record.lease_ownership).toBe('borrowed'); expect(record.lease_released).toBe(false)
    await f.files.releaseRun(f.runId); expect(f.held).toBeNull() // only the existing run owner releases
  } finally { await f.close() }
})
test('borrowed unknown start survives restart, keeps pin, and stop never releases run lease', async () => {
  const f = await fixture(); f.setOutcome('lost')
  try {
    const execution = await f.driver.start(f.spec, f.ws)
    expect(f.driver.pending(execution.id)).toBe(true)
    await f.reopen(); f.setState('unknown'); await f.driver.poll(execution.id)
    expect(await f.driver.wait(execution.id, 0.01)).toBeNull(); expect(f.driver.pending(execution.id)).toBe(true)
    await f.driver.stop(execution.id)
    expect(f.held).toEqual(f.proof); expect(f.calls.filter(c => c.method === 'leases.release')).toHaveLength(0)
    f.setState('exited'); await f.driver.poll(execution.id); await f.driver.stop(execution.id)
    expect(f.driver.pending(execution.id)).toBe(false); expect(f.held).toEqual(f.proof)
    expect(f.calls.filter(c => c.method === 'jobs.start')).toHaveLength(1)
    expect(f.calls.filter(c => c.method === 'leases.acquire')).toHaveLength(1)
  } finally { await f.close() }
})
test('remote start refusal and invalid command never release a borrowed run lease', async () => {
  const f = await fixture(); f.setOutcome('refused')
  try {
    await expect(f.driver.start({ ...f.spec, command: '\0' }, f.ws)).rejects.toMatchObject({ code: 'invalid_argument' })
    const execution = await f.driver.start(f.spec, f.ws)
    await f.driver.poll(execution.id); await f.driver.stop(execution.id)
    expect(f.held).toEqual(f.proof)
    expect(f.calls.filter(c => c.method === 'leases.release')).toHaveLength(0)
    expect(f.calls.filter(c => c.method === 'leases.acquire')).toHaveLength(1)
    expect(f.driver.pending(execution.id)).toBe(true) // no invented remote terminal record
  } finally { await f.close() }
})
test('legacy record without ownership flag retains independent-job own-lease release', async () => {
  const f = await fixture(false)
  try {
    const execution = await f.driver.start(f.spec, f.ws)
    const record = JSON.parse(String(f.conn.get('SELECT record_json FROM remote_jobs')!.record_json))
    expect(record.lease_ownership).toBe('owned'); delete record.lease_ownership
    f.conn.run('UPDATE remote_jobs SET record_json=?', [JSON.stringify(record)])
    await f.reopen(); f.setState('exited'); await f.driver.poll(execution.id)
    expect(f.driver.pending(execution.id)).toBe(false); expect(f.held).toBeNull()
    expect(f.calls.filter(c => c.method === 'leases.release')).toHaveLength(1)
  } finally { await f.close() }
})
test('borrowed proof must match active run and existing held governance identity before any job or DB intent', async () => {
  for (const change of ['missing-run', 'wrong-owner', 'wrong-fence', 'wrong-id', 'root-generation', 'root-target', 'not-held', 'inactive-run', 'no-governance']) {
    const f = await fixture()
    try {
      const spec = { ...f.spec, remote_lease: { ...f.proof! } }
      if (change === 'missing-run') spec.run_id = 'missing'
      if (change === 'wrong-owner') spec.remote_lease.owner_id = 'another-run'
      if (change === 'wrong-fence') spec.remote_lease.fence++
      if (change === 'wrong-id') spec.remote_lease.lease_id = 'forged'
      if (change === 'inactive-run') f.conn.run("UPDATE runs SET status='done' WHERE id=?", [f.runId])
      if (change === 'no-governance') f.conn.run('DELETE FROM governance_log')
      if (change === 'root-generation' || change === 'root-target' || change === 'not-held') {
        const note = repo.governanceForRef(f.conn, 'remote_file_lease', f.ws.id)!.params
        if (change === 'not-held') note.state = 'released'
        else (note.root as Record<string, unknown>)[change === 'root-generation' ? 'generation' : 'target_id'] = 'foreign'
        repo.logGovernance(f.conn, f.ws.session_id!, 'remote_file_lease', { actor: 'harness', ref: f.ws.id, params: note })
      }
      const callsBefore = f.calls.length
      await expect(f.driver.start(spec, f.ws)).rejects.toMatchObject({ code: 'lease_conflict' })
      expect(f.calls.length).toBe(callsBefore); expect(f.conn.all('SELECT * FROM executions')).toHaveLength(0)
      expect(f.held).toEqual(f.proof)
    } finally { await f.close() }
  }
  const publicInput = CommandBodySchema.parse({ command: 'echo test', remote_lease: { lease_id: 'forged', owner_id: 'run', fence: 1 } })
  expect('remote_lease' in publicInput).toBe(false)
})

test('two jobs share the run proof; neither first nor last job completion releases it', async () => {
  const f = await fixture()
  try {
    const [one, two] = await Promise.all([f.driver.start(f.spec, f.ws), f.driver.start(f.spec, f.ws)])
    expect(f.calls.filter(c => c.method === 'leases.acquire')).toHaveLength(1)
    expect(f.calls.filter(c => c.method === 'jobs.start')).toHaveLength(2)
    f.setState('exited'); await f.driver.poll(one.id)
    expect(f.driver.pending(one.id)).toBe(false); expect(f.driver.pending(two.id)).toBe(true)
    expect(f.held).toEqual(f.proof)
    await f.driver.poll(two.id)
    expect(f.driver.pending(two.id)).toBe(false); expect(f.held).toEqual(f.proof)
    expect(f.calls.filter(c => c.method === 'leases.release')).toHaveLength(0)
    await f.files.releaseRun(f.runId); expect(f.held).toBeNull()
  } finally { await f.close() }
})

test('a later session sharing the direct workspace borrows its own run proof, not the workspace creator session', async () => {
  const f = await fixture(true, true)
  try {
    expect(repo.getRun(f.conn, f.runId)?.session_id).not.toBe(f.ws.session_id)
    const e = await f.driver.start(f.spec, f.ws)
    expect(f.driver.pending(e.id)).toBe(true)
    expect(f.calls.filter(c => c.method === 'leases.acquire')).toHaveLength(1)
    f.setState('exited'); await f.driver.poll(e.id); expect(f.held).toEqual(f.proof)
  } finally { await f.close() }
})
