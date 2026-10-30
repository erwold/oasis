import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { Client, json, makeApp } from './api_harness.ts'
import { LoopbackSshd, inspectPid } from './remote/loopback_sshd.ts'
import { scriptedModel, setModel, waitDone, sleep } from './harness.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart } from '../src/llm/messages.ts'
import * as repo from '../src/db/repo.ts'

async function until(check: () => boolean, ms = 15000) {
  const end = Date.now() + ms
  while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting for agent/watch outcome'); await sleep(40) }
}

test('real product agent bash borrows run lease, watch fires, and completed job does not release a still-running run lease', async () => {
  const f = await LoopbackSshd.start({ parent: process.env.TMPDIR })
  const app = await makeApp(null, { remote_transport: { config_file: f.configFile, known_hosts_file: f.knownHostsFile, rpc_timeout_ms: 10000 }, watches: { tick_ms: 100, debounce_ms: 50 } })
  const c = new Client(app), methods: string[] = []
  const request = app.state.remote.request.bind(app.state.remote)
  app.state.remote.request = async (root, method, params, operation) => { methods.push(method); return request(root, method, params, operation) }
  let release!: () => void, observed = false, bash: Record<string, unknown> | null = null, xid = '', runId = ''
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    await app.start()
    const target = await json(await c.post('/api/ssh/targets', { label: 'Borrowed agent', destination: f.alias, identity_file: f.clientKey }), 201)
    await json(await c.post(`/api/ssh/targets/${target.id}/connect`))
    const project = await json(await c.post('/api/projects', { source_path: f.workspace, mode: 'direct', target: { kind: 'ssh', target_id: target.id } }))
    const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'Agent borrowed lease', model: 'scripted:a', access_mode: 'full' }))
    const ws = repo.getWorkspace(app.state.conn, String((session.workspace as { id: string }).id))!
    setModel(app.state, 'scripted:a', scriptedModel(async messages => {
      const result = lastToolReturn(messages, 'bash') as Record<string, unknown> | null
      if (!result) return modelResponse([toolCallPart('bash', { command: "printf 'BORROWED_START\\n'; sleep 3; printf 'BORROWED_DONE\\n'", wait_s: 0 }, 'agent-bash')])
      bash = result
      if (typeof result.execution_id !== 'string') { observed = true; return modelResponse([textPart('Command did not start.')]) }
      xid = result.execution_id
      if (!lastToolReturn(messages, 'watch')) return modelResponse([toolCallPart('watch', { kind: 'exit', execution_id: xid, note: 'BORROWED_WATCH_WAKE' }, 'agent-watch')])
      observed = true
      await held
      return modelResponse([textPart('Agent observed command and watch.')])
    }))
    const started = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'Run the remote command and watch its exit.' }))
    runId = String(started.id)
    await until(() => observed || ['done', 'cancelled', 'error'].includes(repo.getRun(app.state.conn, runId)?.status ?? ''))
    console.log('BORROWED_AGENT_PHASE', JSON.stringify({ status: repo.getRun(app.state.conn, runId)?.status, error: repo.getRun(app.state.conn, runId)?.error, methods }))
    console.log('BORROWED_AGENT_TOOL_RESULT', JSON.stringify(bash))
    expect(typeof (bash as Record<string, unknown> | null)?.execution_id).toBe('string')
    expect(methods.filter(m => m === 'leases.acquire')).toHaveLength(1)
    expect(methods.filter(m => m === 'jobs.start')).toHaveLength(1)
    const runLease = app.state.workspaces.requireRemoteFiles().leaseForRun(runId, ws)!
    expect(runLease.owner_id).toBe(runId)
    const command = await app.state.remote_driver.wait(xid, 12)
    expect(command?.status).toBe('succeeded')
    await app.state.remote_driver.poll(xid)
    const stillHeld = await app.state.remote.request(ws.remote!, 'leases.inspect', {})
    expect(stillHeld).toMatchObject(runLease)
    expect(methods.filter(m => m === 'leases.release')).toHaveLength(0)
    expect(repo.getRun(app.state.conn, runId)?.status).toBe('running')
    const record = JSON.parse(String(app.state.conn.get('SELECT record_json FROM remote_jobs WHERE execution_id=?', [xid])!.record_json))
    expect(record.lease_ownership).toBe('borrowed')
    expect(record.state.spec.lease).toEqual(runLease)
    const output = await app.state.processes.readOutputAsync(xid, 'stdout', 0, 1024)
    expect(output.text).toContain('BORROWED_DONE')
    const injected = await c.post(`/api/workspaces/${ws.id}/commands`, { command: 'printf MUST_NOT_EXECUTE', access: 'session', session_id: session.id, remote_lease: runLease })
    expect(injected.status).toBe(409) // public request cannot borrow around the active run writer
    expect(methods.filter(m => m === 'jobs.start')).toHaveLength(1)
    release(); await waitDone(app.state, runId)
    await until(() => repo.listWakeEvents(app.state.conn, String(session.id)).filter(e => e.kind === 'fired').length === 1)
    await until(() => methods.includes('leases.release'))
    expect(repo.listWatches(app.state.conn, String(session.id))[0]?.status).toBe('done')
    console.log('BORROWED_AGENT_PASS', JSON.stringify({ run_id: runId, execution_id: xid, watches: repo.listWatches(app.state.conn, String(session.id)).map(w => ({ id: w.id, status: w.status })), port: f.port }))
  } finally {
    release()
    if (runId) await waitDone(app.state, runId).catch(() => {})
    if (xid && app.state.processes.isRunning(xid)) { await app.state.remote_driver.stop(xid); await app.state.remote_driver.wait(xid, 10) }
    await app.close(); await f.close()
    console.log('BORROWED_AGENT_CLEANUP', JSON.stringify({ utc: new Date().toISOString(), root: f.root, ledger: f.ledger.map(p => ({ ...p, alive: inspectPid(p.pid) !== null })) }))
    expect(existsSync(f.root)).toBe(false)
  }
}, 60000)
