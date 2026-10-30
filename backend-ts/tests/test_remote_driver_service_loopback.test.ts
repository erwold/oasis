import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { connect } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { createTarget } from '../src/db/remote_repo.ts'
import { RemoteExecutionDriver } from '../src/execution/remote_driver.ts'
import { RemoteWorkspaceService } from '../src/workspace/remote.ts'
import { createSshRemoteProvider } from '../src/workspace/ssh_provider.ts'
import { RemoteError } from '../src/remote/types.ts'
import { LoopbackSshd, inspectPid } from './remote/loopback_sshd.ts'

test('real service + DB driver: lost ACK, DB reopen, paused reconnect, final logs and lease release', async () => {
  const f = await LoopbackSshd.start({ parent: process.env.TMPDIR })
  const dbPath = join(f.root, 'execution.db'), options = { config_file: f.configFile, known_hosts_file: f.knownHostsFile }
  let conn = connect(dbPath), remote = new RemoteWorkspaceService(conn, createSshRemoteProvider(options))
  let driver = new RemoteExecutionDriver({ conn, remote, poll_ms: 100 })
  const startUtc = new Date().toISOString(), events: string[] = [], chunks: Buffer[] = []
  let executionId: string | undefined
  try {
    const target = createTarget(conn, { label: 'owned loopback', destination: f.alias, identity_file: f.clientKey })
    await remote.connect(target.id)
    const binding = await remote.openRoot(target.id, f.workspace)
    conn.run("INSERT INTO projects (id,name,source_path,base_repo_path,kind,created_at,updated_at,target_id,remote_binding_json) VALUES ('p','test',?,'','direct','t','t',?,?)", [binding.path, target.id, JSON.stringify(binding)])
    const ws = repo.insertWorkspace(conn, 'w', 'p', null, binding.path, '', '', 'direct', null, binding)
    const request = remote.request.bind(remote)
    let starts = 0
    remote.request = async (root, method, params, operation) => {
      const result = await request(root, method, params, operation)
      if (method === 'jobs.start') { starts++; throw new RemoteError('outcome_unknown', 'test drops start ACK after remote execution', 'unknown') }
      return result
    }
    const e = await driver.start({ command: "printf x >> once; printf '你hello'; sleep 1; printf DONE; printf ERR >&2; exit 7", cwd: ws.path, project_id: 'p', workspace_id: ws.id, access: 'full' }, ws)
    executionId = e.id
    expect(conn.get('SELECT job_id FROM remote_jobs')?.job_id).toBeNull(); expect(driver.pending(e.id)).toBe(true)
    await remote.disconnect(target.id)
    await driver.poll(e.id); expect(driver.connected(e.id)).toBe(false)
    await driver.close(); await remote.close(); conn.close()
    conn = connect(dbPath); remote = new RemoteWorkspaceService(conn, createSshRemoteProvider(options))
    driver = new RemoteExecutionDriver({ conn, remote, poll_ms: 100, callbacks: {
      onOutput(event) { events.push(event.stream); if (event.stream === 'stdout') chunks.push(event.bytes) },
      onEnd() { events.push('end') },
    } })
    driver.rehydrate(); expect(driver.has(e.id)).toBe(true); expect(driver.pending(e.id)).toBe(true)
    await driver.poll(e.id); expect(driver.connected(e.id)).toBe(false)
    await remote.connect(target.id)
    const result = await driver.wait(e.id, 15)
    expect(result?.status).toBe('failed'); expect(result?.exit_code).toBe(7)
    await driver.poll(e.id) // waits for the same single-flight lease release
    expect(events.at(-1)).toBe('end'); expect(Buffer.concat(chunks).toString()).toBe('你helloDONE')
    expect(starts).toBe(1); expect(driver.pending(e.id)).toBe(false)
    const count = await remote.request(binding, 'files.read', { path: 'once' })
    expect(Buffer.from(count.data, 'base64').toString()).toBe('x')
    expect(await remote.request(binding, 'leases.inspect', {})).toBeNull()
    const output = await driver.readOutput(e.id, 'stderr', 0, 256)
    expect(output.text).toBe('ERR'); expect(output.eof).toBe(true)
    const summary = await driver.summary(e.id)
    expect(summary.output_complete).toBe(true); expect(summary.timeout_s).toBeNull(); expect(summary.output_cap_bytes).toBeNull()
    expect(repo.getExecution(conn, e.id)?.isolation.root_pid).toBeUndefined()
    console.log('DRIVER_SERVICE_LOOPBACK_PASS', JSON.stringify({ start_utc: startUtc, end_utc: new Date().toISOString(), port: f.port, evidence: f.root, execution_id: e.id, remote: conn.get('SELECT job_id,state,stdout_offset,stderr_offset FROM remote_jobs') }))
  } finally {
    // The only command is bounded by its own one-second sleep, not an imposed product deadline.
    if (executionId && driver.pending(executionId)) { await new Promise(r => setTimeout(r, 1500)); await driver.poll(executionId).catch(() => {}) }
    await driver.close(); await remote.close(); conn.close()
    await f.close({ keepEvidence: true })
    console.log('DRIVER_SERVICE_CLEANUP', JSON.stringify({ end_utc: new Date().toISOString(), evidence: f.root, ledger: f.ledger }))
    for (const row of f.ledger) expect(inspectPid(row.pid)).toBeNull()
  }
}, 60000)
