/** The remote writer lease when reconciliation and a new run meet (the pod's restart -> exit watch -> wake run
 *  chain): an injected remote that keeps one lease the way the adapter does (acquire refuses while one is held;
 *  release needs the current proof, else lease_conflict; operations are recorded by id), with gates that hold a reply
 *  so the interleaving is exact. Real isolated SQLite; no network, no SSH. */
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { connect } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { createTarget } from '../src/db/remote_repo.ts'
import { RemoteFiles } from '../src/workspace/remote_files.ts'
import type { RemoteWorkspaceService } from '../src/workspace/remote.ts'
import { RemoteError, type LeaseProof } from '../src/remote/types.ts'
import { tempDir } from './helpers.ts'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function gate() { let open!: () => void; const opened = new Promise<void>(resolve => { open = resolve }); return { opened, open } }

function fixture() {
  const conn = connect(join(tempDir('oasis-lease-race-'), 'state.db'))
  const target = createTarget(conn, { label: 'Race', destination: 'user@race.invalid' })
  const root = { target_id: target.id, root_id: 'root', generation: 'generation', path: '/project', state_path: '/project/.oasis-remote' }
  const project = repo.createProject(conn, 'race', { kind: 'direct', source_path: root.path, base_repo_path: '', base_commit: null, base_branch: null, import_report: {}, remote: root })
  const session = repo.createSession(conn, project.id, 'race', 'scripted:a')
  const ws = repo.insertWorkspace(conn, 'ws_race', project.id, session.id, root.path, '', '', 'direct', null, root)
  repo.setSessionWorkspace(conn, session.id, ws.id)
  const run = (id: string, status: string) => conn.run('INSERT INTO runs (id,session_id,project_id,workspace_id,model,user_text,status,created_at) VALUES (?,?,?,?,?,?,?,?)', [id, session.id, project.id, ws.id, 'scripted:a', id, status, new Date().toISOString()])
  // the host's one writer lease and its operation records, as the adapter keeps them
  const host = { lease: null as LeaseProof | null, fence: 0, ops: new Map<string, { state: string; result?: unknown }>(), releases: 0, conflicts: 0,
    gates: { acquireReply: null as Promise<void> | null, releaseApply: null as Promise<void> | null, inspectReply: null as Promise<void> | null } }
  const remote = {
    conn, isPaused: () => false,
    async request(_root: unknown, method: string, params: any, operation?: string): Promise<any> {
      if (method === 'roots.validate') return root
      if (method === 'operations.status') return host.ops.get(params.operation_id) ? { operation_id: params.operation_id, ...host.ops.get(params.operation_id) } : { operation_id: params.operation_id, state: 'not_found' }
      if (method === 'leases.inspect') { const current = host.lease; if (host.gates.inspectReply) await host.gates.inspectReply; return current }
      if (method === 'leases.acquire') {
        if (host.lease) { host.ops.set(operation!, { state: 'failed' }); throw new RemoteError('lease_conflict', 'Root already has a writer', 'conflict') }
        host.lease = { lease_id: `lease-${++host.fence}`, owner_id: params.owner_id, fence: host.fence }
        host.ops.set(operation!, { state: 'applied', result: host.lease })
        const granted = host.lease
        if (host.gates.acquireReply) await host.gates.acquireReply // applied on the host; the reply is still on its way
        return granted
      }
      if (method === 'leases.release') {
        if (host.gates.releaseApply) await host.gates.releaseApply
        const proof = params.lease as LeaseProof
        if (!host.lease || host.lease.lease_id !== proof.lease_id || host.lease.fence !== proof.fence || host.lease.owner_id !== proof.owner_id) { host.conflicts++; throw new RemoteError('lease_conflict', 'Current root writer lease required', 'conflict') }
        host.lease = null; host.releases++
        return { released: true }
      }
      throw new Error('unexpected ' + method)
    },
  } as unknown as RemoteWorkspaceService
  return { conn, ws: repo.getWorkspace(conn, ws.id)!, run, host, remote }
}

test('a job-end reconciliation and the wake run\'s own meet on the stale writer: released once, and the wake run gets its lease — never lease_conflict', async () => {
  const f = fixture()
  // the earlier life: run_old held the lease and ended with the app (interrupted); its record is the latest
  f.run('run_old', 'running')
  const before = new RemoteFiles(f.remote)
  await before.holdRun(f.ws, 'run_old', () => false, () => {})
  f.conn.run("UPDATE runs SET status='interrupted' WHERE id='run_old'")
  const stale = f.host.lease!
  // the next life: the job's end reconciles the target while the wake run takes the workspace; the first release is
  // held until both are under way
  const files = new RemoteFiles(f.remote)
  f.run('run_wake', 'running')
  const release = gate(); f.host.gates.releaseApply = release.opened
  const jobEnd = files.recover(f.ws)
  const queued: string[] = []
  const wake = files.holdRun(f.ws, 'run_wake', () => false, owner => queued.push(owner))
  await sleep(50)
  release.open(); f.host.gates.releaseApply = null
  await jobEnd
  await wake // old: rejects with lease_conflict "Current root writer lease required"
  expect(f.host.releases).toBe(1)
  expect(f.host.conflicts).toBe(0)
  expect(f.host.lease?.owner_id).toBe('run_wake')
  expect(f.host.lease?.lease_id).not.toBe(stale.lease_id)
  expect(files.leaseForRun('run_wake', f.ws)).toEqual(f.host.lease!)
})

test('a reconciliation during the wake run\'s acquisition (applied on the host, reply not yet back) never releases the lease being taken', async () => {
  const f = fixture()
  f.run('run_wake', 'running')
  const files = new RemoteFiles(f.remote)
  const reply = gate(); f.host.gates.acquireReply = reply.opened
  const wake = files.holdRun(f.ws, 'run_wake', () => false, () => {})
  for (let i = 0; i < 100 && !f.host.lease; i++) await sleep(5)
  expect(f.host.lease?.owner_id).toBe('run_wake') // taken on the host; its reply held back
  // a job's end (or a reconnection) reconciles the workspace now: it must not read the intent as a stale writer
  await files.recover(f.ws)
  reply.open(); f.host.gates.acquireReply = null
  await wake
  expect(f.host.releases).toBe(0) // old: 1 — the live run's lease released behind it
  expect(f.host.lease?.owner_id).toBe('run_wake')
  expect(files.leaseForRun('run_wake', f.ws)).toEqual(f.host.lease!)
})

test('a lease of a run still running is never taken for a stale writer by another process\'s reconciliation', async () => {
  const f = fixture()
  f.run('run_live', 'running')
  const owner = new RemoteFiles(f.remote)
  await owner.holdRun(f.ws, 'run_live', () => false, () => {})
  // a second RemoteFiles over the same records (the person's Connect route, a recovery listener) reconciles
  const other = new RemoteFiles(f.remote)
  await other.recover(f.ws)
  expect(f.host.releases).toBe(0)
  expect(f.host.lease?.owner_id).toBe('run_live')
})
