/** A backend restart is not the person's Disconnect. Real system OpenSSH on loopback (own HOME, generated keys,
 *  own config, recorded PIDs); no pod, no product ports. Each case is a whole product life: target saved and
 *  connected, a remote project, an agent run whose command keeps running on the host with an exit watch, then the
 *  backend stopped and started again on the same data — and what the next life does without anyone pressing a
 *  button: dial the host it was told to stay connected to (on a bounded schedule, while the host is away too), or
 *  never dial the host the person disconnected. */
import { expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Client, json, makeApp } from './api_harness.ts'
import { LoopbackSshd, inspectPid } from './remote/loopback_sshd.ts'
import { scriptedModel, setModel, sleep, waitDone } from './harness.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart, userTexts } from '../src/llm/messages.ts'
import * as repo from '../src/db/repo.ts'
import { createSshRemoteProvider } from '../src/workspace/ssh_provider.ts'
import type { App } from '../src/main.ts'
import type { SshTarget } from '@oasis-code/contract'
import type { RemoteHostProvider } from '../src/workspace/remote.ts'

const WAKE_NOTE = 'RESTART_WAKE_NOTE'
const MARK = 'RESTART_JOB_DONE'

async function until(check: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (!(await check())) { if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for: ${what}`); await sleep(50) }
}

/** The life's options: the fixture's transport, every provider the app makes and every attempt to reach the host
 *  (probe or live check) counted, watches checked often, and a reconnection schedule short enough for a test. */
function lifeOptions(f: LoopbackSshd, dials: { n: number; attempts: number }, debounceMs = 50) {
  const transport = { config_file: f.configFile, known_hosts_file: f.knownHostsFile, rpc_timeout_ms: 10000 }
  const factory = createSshRemoteProvider(transport)
  return {
    remote_transport: transport,
    remote_provider: (target: SshTarget): RemoteHostProvider => {
      dials.n++
      const provider = factory(target)
      return { ...provider, probe: () => { dials.attempts++; return provider.probe() }, check: () => { dials.attempts++; return provider.check!() } }
    },
    watches: { tick_ms: 100, debounce_ms: debounceMs },
    remote_reconnect: { steps_ms: [0, 250, 250, 500], grace_ms: 120_000, request_wait_ms: 8000, settle_ms: 8000 },
  }
}

/** The remote command waits for the test's gate file (released at an exact phase; a 120 s bound so it can never
 *  outlive the test) and then prints its mark: it is provably still running at the restart. */
export function gated(f: LoopbackSshd) {
  const name = `.gate-${randomBytes(6).toString('hex')}`
  return {
    command: `i=0; while [ ! -e ${name} ] && [ $i -lt 1200 ]; do sleep 0.1; i=$((i+1)); done; printf '${MARK}\\n'`,
    release: () => writeFileSync(join(f.workspace, name), ''),
  }
}

/** The agent of the first life starts a remote command that outlives the life, and asks to be woken at its exit;
 *  a wake run (the second life's) answers once. Every model call is counted by life. */
function script(app: App, calls: { first: number; wake: number }, command: string) {
  setModel(app.state, 'scripted:a', scriptedModel(async messages => {
    const bash = lastToolReturn(messages, 'bash') as Record<string, unknown> | null
    if (userTexts(messages).some(t => t.includes(WAKE_NOTE))) { calls.wake++; return modelResponse([textPart('woken after the restart')]) }
    calls.first++
    if (!bash) return modelResponse([toolCallPart('bash', { command, wait_s: 0 }, 'job')])
    if (!lastToolReturn(messages, 'watch')) return modelResponse([toolCallPart('watch', { kind: 'exit', execution_id: bash.execution_id, note: WAKE_NOTE }, 'watch')])
    return modelResponse([textPart('started; waiting for the exit')])
  }))
}

function countMethods(app: App, methods: string[]) {
  const request = app.state.remote.request.bind(app.state.remote)
  app.state.remote.request = (async (...args: Parameters<typeof request>) => { methods.push(args[1]); return request(...args) }) as typeof request
}

async function firstLife(f: LoopbackSshd, command: string, debounceMs = 50) {
  const dials = { n: 0, attempts: 0 }, calls = { first: 0, wake: 0 }, methods: string[] = []
  const app = await makeApp(null, lifeOptions(f, dials, debounceMs))
  countMethods(app, methods)
  await app.start()
  const c = new Client(app)
  const target = await json(await c.post('/api/ssh/targets', { label: 'Restart', destination: f.alias, identity_file: f.clientKey }), 201)
  await json(await c.post(`/api/ssh/targets/${target.id}/connect`))
  const project = await json(await c.post('/api/projects', { source_path: f.workspace, mode: 'direct', target: { kind: 'ssh', target_id: target.id } }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'Restart', model: 'scripted:a', access_mode: 'full' }))
  script(app, calls, command)
  const run = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'Start the long command and watch its exit.' }))
  const done = await waitDone(app.state, String(run.id), 30_000)
  expect(done.status).toBe('done')
  const xid = repo.listExecutions(app.state.conn, { run_id: String(run.id) })[0]!.id
  expect(app.state.processes.isRunning(xid)).toBe(true)
  expect(repo.listWatches(app.state.conn, String(session.id)).map(w => w.status)).toEqual(['active'])
  return { app, c, target, session: String(session.id), xid, settings: app.state.settings, methods, calls }
}

async function secondLife(f: LoopbackSshd, settings: App['state']['settings'], command: string) {
  const dials = { n: 0, attempts: 0 }, calls = { first: 0, wake: 0 }, methods: string[] = []
  const app = await makeApp(settings, lifeOptions(f, dials))
  countMethods(app, methods)
  script(app, calls, command)
  return { app, c: new Client(app), dials, calls, methods }
}

const fired = (app: App, session: string) => repo.listWakeEvents(app.state.conn, session).filter(e => e.kind === 'fired')
const wakeRuns = (app: App, session: string) => repo.listRuns(app.state.conn, session).filter(r => r.spawned_by === 'wake')

async function cleanup(f: LoopbackSshd, apps: (App | null)[], label: string, release?: () => void) {
  // the gated command ends now whatever happened above (it would end at its own bound otherwise)
  try { release?.() } catch { /* the workspace is gone already */ }
  await sleep(400)
  for (const app of apps) if (app) await app.close().catch(() => {})
  await f.close()
  const alive = f.ledger.filter(p => inspectPid(p.pid) !== null)
  console.log(label, JSON.stringify({ utc: new Date().toISOString(), owned: f.ledger.length, alive: alive.map(p => p.pid) }))
  expect(alive).toEqual([])
  expect(existsSync(f.root)).toBe(false)
}

test('graceful restart: a target left connected is dialed again by itself; the job still running at the restart ends, its exit watch wakes once and the wake run answers', async () => {
  const f = await LoopbackSshd.start({ parent: process.env.TMPDIR })
  const gate = gated(f)
  let one: App | null = null, two: App | null = null
  try {
    const first = await firstLife(f, gate.command)
    one = first.app
    expect(first.methods.filter(m => m === 'jobs.start')).toHaveLength(1)
    await first.app.close(); one = null
    const second = await secondLife(f, first.settings, gate.command)
    two = second.app
    await second.app.start()
    await sleep(300)
    gate.release() // the command ends only now: in the second life, with nobody pressing Connect
    await until(() => fired(second.app, first.session).length >= 1, 30_000, 'the exit watch to fire after the restart')
    await until(() => wakeRuns(second.app, first.session).some(r => r.status === 'done'), 30_000, 'the wake run to answer')
    await sleep(500)
    expect(fired(second.app, first.session)).toHaveLength(1)
    expect(wakeRuns(second.app, first.session)).toHaveLength(1)
    expect(second.calls.wake).toBe(1)
    expect(second.dials.attempts).toBeGreaterThanOrEqual(1)
    expect(second.methods.filter(m => m === 'jobs.start')).toHaveLength(0)
    expect(repo.getExecution(second.app.state.conn, first.xid)!.status).toBe('succeeded')
    const out = await second.app.state.processes.readOutputAsync(first.xid, 'stdout', 0, 1024)
    expect(String(out.text)).toContain(MARK)
    expect(second.app.state.remote.target(String(first.target.id)).state).toBe('ready')
    expect(repo.listWatches(second.app.state.conn, first.session).map(w => w.status)).toEqual(['done'])
  } finally { await cleanup(f, [one, two], 'RESTART_GRACEFUL_CLEANUP', gate.release) }
}, 120_000)

test('host away across the restart: the next life keeps dialing on its bounded schedule and resumes when the host is back, without a click', async () => {
  const f = await LoopbackSshd.start({ parent: process.env.TMPDIR })
  const gate = gated(f)
  let one: App | null = null, two: App | null = null
  try {
    const first = await firstLife(f, gate.command)
    one = first.app
    await first.app.close(); one = null
    await f.stopListener()
    const second = await secondLife(f, first.settings, gate.command)
    two = second.app
    await second.app.start()
    // the attempts really happen (each a refused ssh), and they are not a hot loop
    await until(() => second.dials.attempts >= 3, 15_000, 'reconnection attempts while the host is away')
    gate.release() // the command ends while the host cannot be reached: its end is the host's record, read later
    await sleep(1500)
    const attempts = second.dials.attempts
    expect(attempts).toBeLessThan(40)
    expect(['error', 'connecting']).toContain(second.app.state.remote.target(String(first.target.id)).state)
    expect(fired(second.app, first.session)).toHaveLength(0) // a lost connection is not the command's end
    expect(second.app.state.processes.isRunning(first.xid)).toBe(true)
    await f.startListener()
    await until(() => fired(second.app, first.session).length >= 1, 30_000, 'the exit watch to fire once the host is back')
    await until(() => wakeRuns(second.app, first.session).some(r => r.status === 'done'), 30_000, 'the wake run to answer')
    await sleep(500)
    expect(fired(second.app, first.session)).toHaveLength(1)
    expect(second.calls.wake).toBe(1)
    expect(repo.getExecution(second.app.state.conn, first.xid)!.status).toBe('succeeded')
    expect(second.app.state.remote.target(String(first.target.id)).state).toBe('ready')
    console.log('RESTART_HOST_AWAY', JSON.stringify({ attempts_while_away: attempts, attempts_total: second.dials.attempts, providers: second.dials.n }))
  } finally { await f.startListener().catch(() => {}); await cleanup(f, [one, two], 'RESTART_HOST_AWAY_CLEANUP', gate.release) }
}, 120_000)

test('explicit Disconnect survives the restart: the next life never dials, the watch waits, and Connect resumes exactly once', async () => {
  const f = await LoopbackSshd.start({ parent: process.env.TMPDIR })
  const gate = gated(f)
  let one: App | null = null, two: App | null = null
  try {
    const first = await firstLife(f, gate.command)
    one = first.app
    await json(await first.c.post(`/api/ssh/targets/${first.target.id}/disconnect`))
    await first.app.close(); one = null
    const second = await secondLife(f, first.settings, gate.command)
    two = second.app
    await second.app.start()
    gate.release() // the command ends on the host; nothing of this life may learn it before Connect
    await sleep(2500)
    expect(second.dials).toEqual({ n: 0, attempts: 0 })
    expect(second.methods).toEqual([])
    expect(second.app.state.remote.target(String(first.target.id)).state).toBe('disconnected')
    expect(fired(second.app, first.session)).toHaveLength(0)
    expect(second.app.state.processes.isRunning(first.xid)).toBe(true) // unknown, still pending: not ended, not lost
    const refused = await second.c.get(`/api/ssh/targets/${first.target.id}/dirs`, { path: '/' })
    expect(refused.status).toBe(503)
    expect(second.dials).toEqual({ n: 0, attempts: 0 })
    await json(await second.c.post(`/api/ssh/targets/${first.target.id}/connect`))
    await until(() => fired(second.app, first.session).length >= 1, 30_000, 'the exit watch after the explicit Connect')
    await until(() => wakeRuns(second.app, first.session).some(r => r.status === 'done'), 30_000, 'the wake run')
    await sleep(500)
    expect(fired(second.app, first.session)).toHaveLength(1)
    expect(second.calls.wake).toBe(1)
  } finally { await cleanup(f, [one, two], 'RESTART_DISCONNECT_CLEANUP', gate.release) }
}, 120_000)

test('an exit that fired just before the restart is delivered once after it: the wake run starts in the next life and takes the remote writer by itself', async () => {
  const f = await LoopbackSshd.start({ parent: process.env.TMPDIR })
  const gate = gated(f)
  let one: App | null = null, two: App | null = null
  try {
    // the first life gathers wakes for a minute: the exit fires in it, its wake run is not started before the close
    const first = await firstLife(f, gate.command, 60_000)
    one = first.app
    gate.release()
    await until(() => fired(first.app, first.session).length >= 1, 30_000, 'the exit watch to fire in the first life')
    expect(wakeRuns(first.app, first.session)).toHaveLength(0)
    expect(repo.listPendingWakeEvents(first.app.state.conn, first.session)).toHaveLength(1)
    await first.app.close(); one = null
    const second = await secondLife(f, first.settings, gate.command)
    two = second.app
    await second.app.start()
    await until(() => wakeRuns(second.app, first.session).some(r => r.status === 'done' || r.status === 'error'), 30_000, 'the wake run of the pending event')
    await sleep(500)
    const wakes = wakeRuns(second.app, first.session)
    expect(wakes).toHaveLength(1)
    expect(wakes[0]!.status, wakes[0]!.error ?? '').toBe('done') // c738506: the paused target fails the wake run's writer
    expect(second.calls.wake).toBe(1)
    expect(fired(second.app, first.session)).toHaveLength(1)
    expect(repo.listPendingWakeEvents(second.app.state.conn, first.session)).toHaveLength(0)
  } finally { await cleanup(f, [one, two], 'RESTART_PENDING_WAKE_CLEANUP', gate.release) }
}, 120_000)

test('after a restart, the conversation\'s next run works beside its still-running remote job — the lane rebuilt as that conversation\'s from its records, the same lease taken over — while another session waits', async () => {
  const f = await LoopbackSshd.start({ parent: process.env.TMPDIR })
  const gate = gated(f)
  let one: App | null = null, two: App | null = null
  try {
    const first = await firstLife(f, gate.command)
    one = first.app
    const firstWs = repo.getWorkspace(first.app.state.conn, repo.getSession(first.app.state.conn, first.session)!.workspace_id!)!
    const leaseBefore = await first.app.state.remote.request(firstWs.remote!, 'leases.inspect', {})
    expect(leaseBefore).not.toBeNull()
    await first.app.close(); one = null
    const second = await secondLife(f, first.settings, gate.command)
    two = second.app
    await second.app.start()
    const wsId = repo.getSession(second.app.state.conn, first.session)!.workspace_id!
    // the job's lane, rebuilt from the records: its conversation's, joinable
    expect(second.app.state.locks.state(wsId).holder).toMatchObject({ kind: 'run', background: true, execution_ids: [first.xid] })
    expect(second.app.state.locks.state(wsId).holder?.cohort).toBeTruthy()
    // another session of the folder waits for the job
    const other = await json(await second.c.post(`/api/projects/${repo.getSession(second.app.state.conn, first.session)!.project_id}/sessions`, { title: 'Other', model: 'scripted:a', access_mode: 'full' }))
    const outsider = await json(await second.c.post(`/api/sessions/${other.id}/chat`, { text: 'Another session.' }))
    expect(outsider.status).toBe('queued')
    // the conversation's next run: in at once, beside the job, on the lease the job keeps (no second one)
    const next = await json(await second.c.post(`/api/sessions/${first.session}/chat`, { text: 'Look again while it runs.' }))
    expect(next.status).not.toBe('queued')
    const done = await waitDone(second.app.state, String(next.id), 30_000)
    expect(done.status, String(done.error)).toBe('done')
    expect(repo.listEvents(second.app.state.conn, String(next.id)).map(e => e.event)).not.toContain('run_queued')
    expect(second.methods.filter(m => m === 'leases.acquire')).toHaveLength(0)
    const leaseNow = await second.app.state.remote.request(repo.getWorkspace(second.app.state.conn, wsId)!.remote!, 'leases.inspect', {})
    expect(leaseNow).toEqual(leaseBefore)
    expect(second.app.state.processes.isRunning(first.xid)).toBe(true)
    expect(repo.getRun(second.app.state.conn, String(next.id))!.manifest.background_attribution).toMatchObject({ overlapped: true, background_execution_ids: [first.xid] })
    expect(repo.getRun(second.app.state.conn, String(outsider.id))!.status).toBe('queued')
    // the job ends: the outsider goes on
    gate.release()
    await waitDone(second.app.state, String(outsider.id), 60_000)
    expect(repo.getRun(second.app.state.conn, String(outsider.id))!.status).toBe('done')
  } finally { await cleanup(f, [one, two], 'RESTART_COHORT_CLEANUP', gate.release) }
}, 120_000)
