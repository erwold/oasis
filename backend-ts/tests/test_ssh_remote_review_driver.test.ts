/** Independent tests of the committed durable-driver facade, not yet the ProcessManager/watch integration.
 * Pure cases use real SQLite + controlled RPC protocol replies. The UTF-8 case uses real owned loopback SSH.
 */
import { expect, test } from 'bun:test'
import { connect } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { createTarget } from '../src/db/remote_repo.ts'
import { RemoteExecutionDriver } from '../src/execution/remote_driver.ts'
import { RemoteError } from '../src/remote/types.ts'
import { RemoteWorkspaceService } from '../src/workspace/remote.ts'
import { createSshRemoteProvider } from '../src/workspace/ssh_provider.ts'
import { LoopbackSshd, inspectPid } from './remote/loopback_sshd.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { externalStatePython } from '../src/remote/external_state.fixture.ts'

type Scenario = 'normal' | 'lease-refused' | 'early-eof' | 'oversized-page'
function controlled(scenario: Scenario) {
  const conn = connect(':memory:')
  const target = createTarget(conn, { label: 'Review', destination: 'no-network.invalid' })
  const binding = { target_id: target.id, root_id: 'root', generation: 'generation', path: '/remote-review', state_path: '/remote-review/.oasis-remote' }
  const project = repo.createProject(conn, 'Review', { kind: 'direct', source_path: binding.path, base_repo_path: '', base_commit: null, base_branch: null, import_report: {}, remote: binding })
  const workspace = repo.insertWorkspace(conn, 'review_workspace', project.id, null, binding.path, '', '', 'direct', null, binding)
  const calls: string[] = []
  let op = '', ended = 0, delivered = 0
  const remote = {
    isPaused: () => false,
    async request(_root: unknown, method: string, params: Record<string, unknown>, operation?: string) {
      calls.push(method)
      if (method === 'leases.acquire') {
        if (scenario === 'lease-refused') throw new RemoteError('lease_conflict', 'Another writer already owns this root', 'conflict')
        return { lease_id: 'lease', owner_id: params.owner_id, fence: 1 }
      }
      if (method === 'jobs.start') { op = operation!; return { job_id: 'job', operation_id: op, state: 'running', timeout_s: null, output_cap_bytes: null } }
      if (method === 'jobs.status') return { job_id: 'job', operation_id: op, state: 'exited', exit_code: 0, timeout_s: null, output_cap_bytes: null }
      if (method === 'jobs.read') {
        const stdout = params.stream === 'stdout'
        const bytes = stdout ? Buffer.alloc(scenario === 'oversized-page' ? 256 * 1024 + 1 : 1, 65) : Buffer.alloc(0)
        const total = stdout && scenario === 'early-eof' ? 10 : bytes.length
        return { data: bytes.toString('base64'), byte_offset: params.byte_offset, next_offset: Number(params.byte_offset) + bytes.length,
          total_written: total, total_retained: total, eof: true, gaps: [] }
      }
      if (method === 'leases.release') return { released: true }
      if (method === 'leases.inspect') return null
      if (method === 'jobs.recover') throw new RemoteError('outcome_unknown', 'No job was ever started', 'unknown')
      throw new Error(`Unexpected RPC ${method}`)
    },
  } as unknown as RemoteWorkspaceService
  const driver = new RemoteExecutionDriver({ conn, remote, callbacks: { onEnd() { ended++ }, onOutput(e) { delivered += e.bytes.length } } })
  return { conn, workspace, calls, driver, get ended() { return ended }, get delivered() { return delivered },
    spec: { command: 'printf A', cwd: workspace.path, project_id: project.id, workspace_id: workspace.id },
    async close() { await driver.close(); conn.close() } }
}

test('ssh review driver: omitted ProcessSpec access remains sandbox-default and never runs Full remotely', async () => {
  const f = controlled('normal')
  try {
    await expect(f.driver.start(f.spec, f.workspace)).rejects.toMatchObject({ code: 'sandbox_unavailable' })
    expect(f.calls).toEqual([])
    expect(f.conn.all('SELECT id FROM executions')).toHaveLength(0)
  } finally { await f.close() }
})

test('ssh review driver: definite lease refusal cannot create an immortal unknown writer', async () => {
  const f = controlled('lease-refused')
  try {
    let execution: Awaited<ReturnType<typeof f.driver.start>> | undefined
    try { execution = await f.driver.start({ ...f.spec, access: 'full' }, f.workspace) }
    catch (error) { expect(error).toMatchObject({ code: 'lease_conflict' }) }
    expect(f.calls.filter(c => c === 'jobs.start')).toHaveLength(0)
    if (execution) {
      expect(f.driver.pending(execution.id), 'A definite lease_conflict proves no job/start side effect occurred').toBe(false)
      expect(['failed', 'cancelled']).toContain(repo.getExecution(f.conn, execution.id)!.status)
    }
  } finally { await f.close() }
})

test('ssh review driver: premature EOF cannot finalize before all retained log bytes', async () => {
  const f = controlled('early-eof')
  try {
    const execution = await f.driver.start({ ...f.spec, access: 'full' }, f.workspace)
    await f.driver.poll(execution.id)
    expect({ pending: f.driver.pending(execution.id), ended: f.ended, complete: (await f.driver.summary(execution.id)).output_complete })
      .toEqual({ pending: true, ended: 0, complete: false })
    expect(f.calls).not.toContain('leases.release')
  } finally { await f.close() }
})

test('ssh review driver: response frame budget does not authorize oversized output pages', async () => {
  const f = controlled('oversized-page')
  try {
    const execution = await f.driver.start({ ...f.spec, access: 'full' }, f.workspace)
    await f.driver.poll(execution.id)
    expect(f.delivered).toBe(0)
    expect(f.driver.pending(execution.id)).toBe(true)
    expect(f.conn.get('SELECT stdout_offset FROM remote_jobs')?.stdout_offset).toBe(0)
  } finally { await f.close() }
})

test('ssh review driver real SSH: text pages across UTF-8 boundaries reconstruct output without replacement characters', async () => {
  const fixture = await LoopbackSshd.start({ parent: '/tmp' })
  const conn = connect(':memory:')
  const python = externalStatePython(fixture.root, join(fixture.root, 'unused-shared-volume'))
  const remote = new RemoteWorkspaceService(conn, createSshRemoteProvider({ config_file: fixture.configFile, known_hosts_file: fixture.knownHostsFile, python, rpc_timeout_ms: 10_000 }))
  const driver = new RemoteExecutionDriver({ conn, remote, poll_ms: 50 })
  try {
    const target = createTarget(conn, { label: 'Owned review fixture', destination: fixture.alias, identity_file: fixture.clientKey })
    await remote.connect(target.id)
    const binding = await remote.openRoot(target.id, fixture.workspace)
    const project = repo.createProject(conn, 'Review', { kind: 'direct', source_path: binding.path, base_repo_path: '', base_commit: null, base_branch: null, import_report: {}, remote: binding })
    const workspace = repo.insertWorkspace(conn, 'review_utf8', project.id, null, binding.path, '', '', 'direct', null, binding)
    const execution = await driver.start({ project_id: project.id, workspace_id: workspace.id, cwd: workspace.path, command: "printf '你hello界'", access: 'full' }, workspace)
    const terminal = await driver.wait(execution.id, 10)
    expect(terminal?.status).toBe('succeeded')
    expect(terminal?.isolation.root_pid).toBeUndefined()
    const bytes: Buffer[] = [], text: string[] = []
    let offset = 0
    for (let n = 0; n < 20; n++) {
      const page = await driver.readOutput(execution.id, 'stdout', offset, 2)
      expect(page.available).toBe(true)
      bytes.push(Buffer.from(String(page.data), 'base64')); text.push(String(page.text))
      offset = Number(page.next_offset)
      if (page.eof) break
    }
    const record = JSON.parse(String(conn.get('SELECT record_json FROM remote_jobs')!.record_json))
    const identity = JSON.parse(readFileSync(join(binding.state_path, 'jobs', record.state.job_id, 'running.json'), 'utf8'))
    await Bun.sleep(100)
    console.log('REVIEW_DRIVER_REAL_PIDS', JSON.stringify({ child_pid: identity.pid_identity.pid, supervisor_pid: identity.supervisor_pid,
      child_ended: inspectPid(identity.pid_identity.pid) === null, supervisor_ended: inspectPid(identity.supervisor_pid) === null }))
    expect(Buffer.concat(bytes).toString('utf8')).toBe('你hello界')
    expect(text.join('')).toBe('你hello界')
  } finally {
    await driver.close(); await remote.close(); conn.close(); await fixture.close()
    console.log('REVIEW_DRIVER_FIXTURE_PIDS', JSON.stringify(fixture.ledger.map(p => ({ ...p, ended: inspectPid(p.pid) === null }))))
    expect(existsSync(fixture.root)).toBe(false)
  }
}, 60_000)
