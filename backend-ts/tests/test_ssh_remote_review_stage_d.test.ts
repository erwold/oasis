/** Independent Stage D integration: real system loopback SSH, API, persisted driver/watch state.
 * Fresh HOME/keys/config/private registry. Commands are self-bounded and released in cleanup.
 * No pod/e2e/production listener. SQL fault injection changes only one test connection's cursor write.
 */
import { expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LoopbackSshd, inspectPid } from './remote/loopback_sshd.ts'
import { externalStatePython } from '../src/remote/external_state.fixture.ts'
import { Client, json, makeApp } from './api_harness.ts'
import type { App } from '../src/main.ts'
import type { Session, Workspace } from '@oasis-code/contract'
import { modelResponse, textPart, toolCallPart } from '../src/llm/messages.ts'
import { scriptedModel, steps } from '../src/llm/scripted.ts'
import { setModel, sleep, waitDone } from './harness.ts'
import { RemoteError } from '../src/remote/types.ts'
import * as repo from '../src/db/repo.ts'
import { newId } from '../src/ids.ts'

async function until(check: () => boolean, ms = 12000) {
  const deadline = Date.now() + ms
  while (!check()) { if (Date.now() > deadline) throw new Error('Independent review bounded wait expired'); await sleep(40) }
}
async function fixture() {
  const ssh = await LoopbackSshd.start({ parent: '/tmp' })
  const python = externalStatePython(ssh.root, join(ssh.root, 'unused-shared-volume'))
  const options = { remote_transport: { config_file: ssh.configFile, known_hosts_file: ssh.knownHostsFile, python, rpc_timeout_ms: 10000 }, watches: { tick_ms: 50, debounce_ms: 60000 }, remote_reconnect: { settle_ms: 1500 } }
  let app = await makeApp(null, options), c = new Client(app)
  setModel(app.state, 'scripted:a', scriptedModel(() => modelResponse([textPart('Observed.')])) )
  await app.start()
  const target = await json(await c.post('/api/ssh/targets', { label: 'Review Stage D', destination: ssh.alias, identity_file: ssh.clientKey }), 201)
  const targetId = String(target.id), host = `/api/ssh/targets/${targetId}`
  await json(await c.post(`${host}/connect`))
  const p = await json(await c.post('/api/projects', { source_path: ssh.workspace, mode: 'direct', target: { kind: 'ssh', target_id: targetId } }))
  const session = await json<Session & { workspace: Workspace }>(await c.post(`/api/projects/${p.id}/sessions`, { title: 'Review watches', model: 'scripted:a' }))
  const owner = newId('run')
  app.state.conn.run("INSERT INTO runs(id,session_id,project_id,workspace_id,model,user_text,status,created_at) VALUES (?,?,?,?,?,?,'done',?)",
    [owner, session.id, String(p.id), session.workspace.id, 'scripted:a', 'Independent watch owner.', new Date().toISOString()])
  const gates: string[] = [], executions: string[] = []
  const gate = 'review-release'
  gates.push(join(ssh.workspace, gate))
  const waitGate = `i=0; while [ ! -f ${gate} ] && [ "$i" -lt 400 ]; do sleep 0.1; i=$((i+1)); done`
  return {
    ssh, session, owner, host, targetId, gate, waitGate,
    get app() { return app }, get c() { return c },
    async command(command: string) {
      const result = await json(await c.post(`/api/workspaces/${session.workspace.id}/commands`, { command, access: 'session', session_id: session.id, wait_s: 1 }))
      const id = String(result.execution_id); executions.push(id); return { id, result }
    },
    release() { for (const path of gates) writeFileSync(path, '') },
    async restart(beforeStart: (next: App) => void) {
      const settings = app.state.settings
      await app.close()
      app = await makeApp(settings, options); c = new Client(app)
      setModel(app.state, 'scripted:a', scriptedModel(() => modelResponse([textPart('Observed.')])) )
      beforeStart(app)
      await app.start()
    },
    async close() {
      for (const path of gates) writeFileSync(path, '')
      try {
        await app.state.remote.connect(targetId)
        for (const id of executions) {
          const ended = await app.state.remote_driver.wait(id, 12)
          if (!ended) { await app.state.remote_driver.stop(id); await app.state.remote_driver.wait(id, 8) }
          const row = app.state.conn.get('SELECT job_id FROM remote_jobs WHERE execution_id=?', [id])
          if (row?.job_id) {
            const path = join(session.workspace.remote!.state_path, 'jobs', String(row.job_id), 'running.json')
            if (existsSync(path)) {
              const identity = JSON.parse(readFileSync(path, 'utf8'))
              await sleep(100)
              const childEnded = inspectPid(identity.pid_identity.pid) === null, supervisorEnded = inspectPid(identity.supervisor_pid) === null
              console.log('REVIEW_STAGE_D_JOB_PIDS', JSON.stringify({ child: identity.pid_identity.pid, supervisor: identity.supervisor_pid, childEnded, supervisorEnded }))
              expect(childEnded).toBe(true); expect(supervisorEnded).toBe(true)
            }
          }
        }
      } finally {
        await app.close(); await ssh.close()
        console.log('REVIEW_STAGE_D_FIXTURE', JSON.stringify(ssh.ledger.map(p => ({ ...p, ended: inspectPid(p.pid) === null }))))
        expect(existsSync(ssh.root)).toBe(false)
      }
    },
  }
}

test('ssh review Stage D: API job restart preserves UTF8 partial watch, unknown pin and one final event each', async () => {
  const f = await fixture()
  try {
    const { id, result } = await f.command(`printf '\\344\\275'; ${f.waitGate}; printf '\\240_READY\\nFINAL'`)
    expect(result.timeout_s).toBeNull(); expect(result.output_cap_bytes).toBeNull(); expect(result.isolation).toBe('none')
    const initial = f.app.state.conn.get('SELECT job_id,operation_id FROM remote_jobs WHERE execution_id=?', [id])!
    const match = f.app.state.watches.register({ session_id: f.session.id, run_id: f.owner, note: 'Match complete UTF8 line.', input: { kind: 'match', execution_id: id, pattern: '你_READY', stream: 'stdout' } })
    const exit = f.app.state.watches.register({ session_id: f.session.id, run_id: f.owner, note: 'Wait real exit.', input: { kind: 'exit', execution_id: id } })
    const silence = f.app.state.watches.register({ session_id: f.session.id, run_id: f.owner, note: 'No offline silence.', input: { kind: 'silence', execution_id: id, silence_s: 30 } })
    if ('error' in match || 'error' in exit || 'error' in silence) throw new Error('Watch registration refused')
    await until(() => Number(f.app.state.conn.get('SELECT byte_offset FROM remote_watch_cursors WHERE watch_id=? AND stream=\'stdout\'', [match.id])?.byte_offset ?? -1) === 2)
    const saved = f.app.state.conn.get('SELECT * FROM remote_watch_cursors WHERE watch_id=? AND stream=\'stdout\'', [match.id])!
    expect(JSON.parse(String(saved.state_json)).utf8).toBe(Buffer.from([0xe4, 0xbd]).toString('base64'))
    expect(repo.listWakeEvents(f.app.state.conn, f.session.id)).toHaveLength(0)
    await json(await f.c.post(`${f.host}/disconnect`))
    const now = Date.now
    try {
      Date.now = () => now() + 45000
      ;(f.app.state.watches as unknown as { tick(): void }).tick()
    } finally { Date.now = now }
    expect(repo.listWakeEvents(f.app.state.conn, f.session.id)).toHaveLength(0)
    expect((await json(await f.c.get(`/api/executions/${id}`))).status).toBe('unknown')
    let bootChecked = false
    await f.restart(next => {
      expect(next.state.remote_driver.has(id)).toBe(true)
      expect(next.state.processes.isRunning(id)).toBe(true)
      const start = next.state.watches.start.bind(next.state.watches)
      next.state.watches.start = () => { bootChecked = true; expect(next.state.remote_driver.has(id)).toBe(true); expect(next.state.processes.isRunning(id)).toBe(true); return start() }
      const reap = next.state.processes.reapLost.bind(next.state.processes)
      next.state.processes.reapLost = ids => { expect(ids).not.toContain(id); return reap(ids) }
    })
    expect(bootChecked).toBe(true)
    expect(repo.getWatch(f.app.state.conn, match.id)?.status).toBe('active')
    expect(repo.listWakeEvents(f.app.state.conn, f.session.id)).toHaveLength(0)
    expect(f.app.state.locks.holder(f.session.workspace.id)).not.toBeNull()
    expect(await f.app.state.processes.wait(id, 0.01)).toBeNull()
    await json(await f.c.post(`${f.host}/connect`))
    f.release()
    await until(() => !f.app.state.processes.isRunning(id))
    await until(() => repo.getWatch(f.app.state.conn, match.id)?.status === 'done' && repo.getWatch(f.app.state.conn, exit.id)?.status === 'done')
    const final = await json(await f.c.get(`/api/executions/${id}`))
    expect(final.status).toBe('succeeded'); expect(final.output_complete).toBe(true)
    const output = await json(await f.c.get(`/api/executions/${id}/output`, { stream: 'stdout', offset: 0, limit: 100 }))
    expect(output.text).toBe('你_READY\nFINAL')
    expect(f.app.state.conn.get('SELECT job_id,operation_id FROM remote_jobs WHERE execution_id=?', [id])).toEqual(initial)
    const fired = () => repo.listWakeEvents(f.app.state.conn, f.session.id).filter(e => e.kind === 'fired')
    expect(fired().map(e => e.watch_id).sort()).toEqual([match.id, exit.id].sort())
    await f.app.state.remote_driver.poll(id); await sleep(250)
    expect(fired()).toHaveLength(2)
    const cursor = f.app.state.conn.get('SELECT byte_offset,state_json FROM remote_watch_cursors WHERE watch_id=? AND stream=\'stdout\'', [match.id])!
    expect(Number(cursor.byte_offset)).toBeGreaterThanOrEqual(Buffer.byteLength('你_READY\n'))
  } finally { await f.close() }
}, 60000)

test('ssh review Stage D: cursor transaction rollback must re-arm a fired-and-disarmed match for retry', async () => {
  const f = await fixture()
  const conn = f.app.state.conn, original = conn.run.bind(conn)
  let fault = true, attempts = 0, watched = ''
  try {
    const { id } = await f.command(`printf 'REVIEW_MATCH\\n'; ${f.waitGate}; printf final`)
    conn.run = ((sql, params = []) => {
      if (fault && sql.startsWith('INSERT INTO remote_watch_cursors') && String(params[0]) === watched && Number(params[2]) > 0) {
        attempts++; throw new Error('Independent review injected cursor persistence failure after fire')
      }
      return original(sql, params)
    }) as typeof conn.run
    const w = f.app.state.watches.register({ session_id: f.session.id, run_id: f.owner, note: 'Exactly one durable match.', input: { kind: 'match', execution_id: id, pattern: 'REVIEW_MATCH', stream: 'stdout' } })
    if ('error' in w) throw new Error(w.error)
    watched = w.id
    await until(() => attempts > 0)
    expect(repo.getWatch(conn, watched)?.status).toBe('active')
    expect(repo.listWakeEvents(conn, f.session.id)).toHaveLength(0)
    expect(conn.get('SELECT * FROM remote_watch_cursors WHERE watch_id=?', [watched])).toBeNull()
    fault = false
    for (let i = 0; i < 20 && repo.getWatch(conn, watched)?.fires === 0; i++) {
      f.app.state.processes.emitRemoteOutput({ execution_id: id, stream: 'stdout', bytes: Buffer.alloc(0) }); await sleep(75)
    }
    const actual = { status: repo.getWatch(conn, watched)?.status, fires: repo.getWatch(conn, watched)?.fires,
      events: repo.listWakeEvents(conn, f.session.id).filter(e => e.watch_id === watched && e.kind === 'fired').length,
      cursor: Number(conn.get('SELECT byte_offset FROM remote_watch_cursors WHERE watch_id=? AND stream=\'stdout\'', [watched])?.byte_offset ?? 0) }
    console.log('REVIEW_CURSOR_ROLLBACK_RETRY', JSON.stringify(actual))
    expect(actual).toEqual({ status: 'done', fires: 1, events: 1, cursor: Buffer.byteLength('REVIEW_MATCH\n') })
  } finally { conn.run = original; await f.close() }
}, 60000)

test('ssh review Stage D: run lease exists before model and failed disconnect release survives Map loss for recovery', async () => {
  const f = await fixture()
  let enter = false, finish!: () => void, runId = ''
  const modelGate = new Promise<void>(resolve => { finish = resolve })
  try {
    setModel(f.app.state, 'scripted:a', scriptedModel(async () => { enter = true; await modelGate; return modelResponse([textPart('Done without a command.')]) }))
    const row = await json(await f.c.post(`/api/sessions/${f.session.id}/chat`, { text: 'Hold the run until observed.' }))
    runId = String(row.id)
    await until(() => enter)
    const files = f.app.state.workspaces.requireRemoteFiles()
    const lease = await f.app.state.remote.request(f.session.workspace.remote!, 'leases.inspect', {})
    expect(lease?.owner_id).toBe(runId)
    expect(files.leaseForRun(runId, f.session.workspace)?.lease_id).toBe(lease?.lease_id)
    expect(repo.governanceForRef(f.app.state.conn, 'remote_file_lease', f.session.workspace.id)?.params).toMatchObject({ owner_kind: 'run', run_id: runId, state: 'held' })
    await json(await f.c.post(`${f.host}/disconnect`))
    finish()
    await waitDone(f.app.state, runId)
    await sleep(300)
    const leasePath = join(f.session.workspace.remote!.state_path, 'lease.json')
    expect(JSON.parse(readFileSync(leasePath, 'utf8')).lease_id).toBe(lease?.lease_id)
    await f.restart(next => {
      expect(next.state.workspaces.requireRemoteFiles().leaseForRun(runId, f.session.workspace)).toBeNull()
      expect(repo.governanceForRef(next.state.conn, 'remote_file_lease', f.session.workspace.id)?.params.state).toBe('held')
    })
    await json(await f.c.post(`${f.host}/connect`))
    expect(await f.app.state.remote.request(f.session.workspace.remote!, 'leases.inspect', {})).toBeNull()
    expect(repo.governanceForRef(f.app.state.conn, 'remote_file_lease', f.session.workspace.id)?.params.state).toBe('released')
  } finally {
    finish()
    try { if (runId && f.app.state.runs.handles.has(runId)) await waitDone(f.app.state, runId) }
    finally { await f.close() }
  }
}, 60000)

test('ssh review Stage D: run finalization cannot release an unknown file-write outcome before receipt reconciliation', async () => {
  const f = await fixture()
  const remote = f.app.state.remote, original = remote.request.bind(remote)
  let lost = false, reconciled = false, releasedBeforeReconcile = false
  try {
    writeFileSync(join(f.ssh.workspace, 'note.txt'), 'original\n')
    remote.request = (async (...args: Parameters<typeof original>) => {
      const value = await original(...args)
      if (args[1] === 'files.write' && !lost) { lost = true; throw new RemoteError('outcome_unknown', 'Review dropped real write acknowledgement', 'unknown') }
      if (lost && args[1] === 'operations.status') reconciled = true
      if (lost && args[1] === 'leases.release' && !reconciled) releasedBeforeReconcile = true
      return value
    }) as typeof remote.request
    setModel(f.app.state, 'scripted:a', scriptedModel(steps(
      [toolCallPart('read_file', { path: 'note.txt' }, 'read')],
      [toolCallPart('edit_file', { path: 'note.txt', old_string: 'original', new_string: 'changed' }, 'write')],
      [textPart('Stopped after the write.')],
    )))
    const row = await json(await f.c.post(`/api/sessions/${f.session.id}/chat`, { text: 'Edit once, preserving unknown outcome.' }))
    const run = await waitDone(f.app.state, String(row.id))
    await sleep(500)
    expect(lost).toBe(true)
    expect(readFileSync(join(f.ssh.workspace, 'note.txt'), 'utf8')).toBe('changed\n')
    const prepared = repo.listPreparedJournal(f.app.state.conn, run.id).length
    const leaseHeld = (await original(f.session.workspace.remote!, 'leases.inspect', {})) !== null
    const actual = { prepared, leaseHeld, reconciled, releasedBeforeReconcile }
    console.log('REVIEW_UNKNOWN_RUN_LEASE', JSON.stringify(actual))
    expect(releasedBeforeReconcile).toBe(false)
    if (prepared) expect(leaseHeld).toBe(true)
  } finally { remote.request = original; await f.close() }
}, 60000)

test('ssh Stage D: a write whose receipt cannot be had keeps the run lease past the run, its journal prepared; the next reconcile settles it and releases once', async () => {
  const f = await fixture()
  const remote = f.app.state.remote, original = remote.request.bind(remote)
  let lost = false, receiptsDown = true, releases = 0
  try {
    writeFileSync(join(f.ssh.workspace, 'note.txt'), 'original\n')
    remote.request = (async (...args: Parameters<typeof original>) => {
      if (lost && receiptsDown && args[1] === 'operations.status') return { operation_id: String((args[2] as { operation_id: string }).operation_id), state: 'unknown' }
      if (args[1] === 'leases.release') releases++
      const value = await original(...args)
      if (args[1] === 'files.write' && !lost) { lost = true; throw new RemoteError('outcome_unknown', 'dropped write acknowledgement', 'unknown') }
      return value
    }) as typeof remote.request
    setModel(f.app.state, 'scripted:a', scriptedModel(steps(
      [toolCallPart('read_file', { path: 'note.txt' }, 'read')],
      [toolCallPart('edit_file', { path: 'note.txt', old_string: 'original', new_string: 'changed' }, 'write')],
      [textPart('Stopped after the write.')],
    )))
    const row = await json(await f.c.post(`/api/sessions/${f.session.id}/chat`, { text: 'Edit once; the receipt stays unknown.' }))
    const run = await waitDone(f.app.state, String(row.id))
    await sleep(500)
    expect(lost).toBe(true)
    expect(repo.listPreparedJournal(f.app.state.conn, run.id)).toHaveLength(1)
    expect(await original(f.session.workspace.remote!, 'leases.inspect', {})).not.toBeNull()
    expect(releases).toBe(0)
    // the receipt can be had again: the next reconcile settles the write (never replays it) and releases the lease
    receiptsDown = false
    const target = f.session.workspace.target
    if (target?.kind !== 'ssh') throw new Error('the fixture session is not on an SSH target')
    await f.app.state.workspaces.requireRemoteFiles().recoverTarget(target.target_id)
    expect(repo.listPreparedJournal(f.app.state.conn, run.id)).toHaveLength(0)
    expect(await original(f.session.workspace.remote!, 'leases.inspect', {})).toBeNull()
    expect(releases).toBe(1)
    expect(readFileSync(join(f.ssh.workspace, 'note.txt'), 'utf8')).toBe('changed\n')
  } finally { remote.request = original; await f.close() }
}, 60000)
