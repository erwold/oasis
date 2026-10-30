/** The folder's one writer, in turn and in sight (items 13–15): a run behind another writer of its folder is queued —
 *  its row, its events and GET /api/runs/:id say who holds the folder and where the run stands — and a Stop takes it
 *  out of the line at once, before it ever starts; a command that may write is refused while another writer holds the
 *  folder (409 workspace_busy: who, since when, how to go on), a read_only one runs beside it; a command still running
 *  when its wait ends — the connector's, an approval's, a run's — keeps the folder held until it has really ended; the
 *  harness's own operations on a folder (a checkpoint, an integration, a pinned base, an adoption) take the folder in
 *  the same step as their check; an interaction that pins nothing is never refused for a writer. */

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentMentionToken, type InteractionDetail, type Run } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import * as gate from '../src/policy/gate.ts'
import { WorkspaceLocks } from '../src/workspace/locks.ts'
import type { HostRestrictions } from '../src/execution/isolation.ts'
import { Client, json, makeApp, parseSse } from './api_harness.ts'
import { appState, buggyRepo, closeState, collectEvents, FAKE_FULL, openSession, PassthroughRuntime, scriptedModel, setModel, sleep, waitDone, type AppState } from './harness.ts'
import { tempDir } from './helpers.ts'

let app: App | null = null
let state: AppState | null = null
afterEach(async () => {
  if (app) await app.close()
  app = null
  if (state) await closeState(state)
  state = null
})

const MODEL = 'scripted:a'
const rec = (v: unknown) => v as Record<string, unknown>
/** Passthrough (no OS isolation: these tests are of the queue, not the kernel) that also takes a Full access command's
 *  host restrictions and keeps them: a read_only command reaches the execution layer, which asks the OS for its
 *  restriction (integration: on the locking branch alone nothing asked; with execution merged, a runtime with no
 *  host restriction refuses it — test_workspace_readonly_lane holds that end). */
class HostRecordingRuntime extends PassthroughRuntime {
  readonly restrictions: HostRestrictions[] = []
  hostCommand(argv: string[], restrictions: HostRestrictions, profilePath: string): string[] {
    writeFileSync(profilePath, ';; recorded, not applied\n')
    this.restrictions.push(restrictions)
    return argv
  }
}
const hostRuntime = new HostRecordingRuntime()
const passthrough = { probe: false, runtime: hostRuntime, isolation: { ...FAKE_FULL, runtime: 'passthrough' } }

function plainFolder(): string {
  const dir = join(tempDir('oasis-queue-'), 'f')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'README.md'), 'x\n')
  return dir
}

/** Within `ms`, or what it is still: 'pending'. */
function settledWithin<T>(p: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([p, sleep(ms).then(() => 'pending' as const)])
}

async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not reached in time')
    await sleep(20)
  }
}

/** A direct folder with two sessions (one workspace, one lock), and a model whose first answer waits for `release`. */
async function sharedFolder() {
  app = await makeApp(null, passthrough)
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: plainFolder(), mode: 'direct' }))
  const s1 = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'one' }))
  const s2 = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'two' }))
  const wsId = rec(s1.workspace).id as string
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  let calls = 0
  const order: string[] = []
  setModel(app.state, MODEL, scriptedModel(async (messages) => {
    calls += 1
    order.push(/hold|second|third|order/.exec(JSON.stringify(messages))?.[0] ?? '?')
    if (calls === 1) await held
    return modelResponse([textPart('ok')])
  }))
  return { c, s1: s1.id as string, s2: s2.id as string, wsId, release, order, project: project.id as string }
}

const events = (runId: string) => repo.listEvents(app!.state.conn, runId).map((e) => e.event)

test('a run behind another writer of its folder is queued, and says who holds the folder and where it stands', async () => {
  const { c, s1, s2, wsId, release } = await sharedFolder()
  const a = await json<Run>(await c.post(`/api/sessions/${s1}/chat`, { text: 'hold' }))
  await until(() => app!.state.locks.holder(wsId) === a.id)
  const b = await json<Run>(await c.post(`/api/sessions/${s2}/chat`, { text: 'second' }))
  expect(b.status).toBe('queued')                                             // the answer says so at once
  expect(rec(b).waiting).toMatchObject({ reason: 'workspace_lock', blocking_run_id: a.id, position: 1 })
  const row = await json(await c.get(`/api/runs/${b.id}`))
  expect(row.status).toBe('queued')
  expect(row.live).toBe(true)
  expect(row.waiting).toMatchObject({ reason: 'workspace_lock', workspace_id: wsId, blocking_owner: a.id, blocking_kind: 'run', blocking_run_id: a.id, blocking_session_id: s1, position: 1 })
  expect(typeof rec(row.waiting).queued_since).toBe('string')
  const queued = repo.listEvents(app!.state.conn, b.id)
  expect(queued.map((e) => e.event)).toEqual(['run_queued'])
  expect(queued[0]!.data).toMatchObject({ reason: 'workspace_lock', blocking_run_id: a.id, position: 1 })
  expect(String(queued[0]!.data.message)).toContain(a.id)
  // the folder's lock as the workspace shows it: the holder and the line
  const ws = await json(await c.get(`/api/workspaces/${wsId}`))
  expect(ws.lock_owner).toBe(a.id)
  expect(rec(rec(ws.lock).holder)).toMatchObject({ owner: a.id, kind: 'run', run_id: a.id, background: false })
  expect((rec(ws.lock).waiters as Record<string, unknown>[]).map((w) => [w.owner, w.position])).toEqual([[b.id, 1]])
  release()
  await waitDone(app!.state, a.id)
  const done = await waitDone(app!.state, b.id)
  expect(done.status).toBe('done')
  // handed the folder: running again, said once, then its start
  expect(events(b.id).slice(0, 3)).toEqual(['run_queued', 'slot_acquired', 'run_started'])
  expect((await json(await c.get(`/api/runs/${b.id}`))).waiting).toBeNull()
})

test('a Stop takes a queued run out of the line at once: it ends cancelled, never started, never held the folder', async () => {
  const { c, s1, s2, wsId, release } = await sharedFolder()
  const a = await json<Run>(await c.post(`/api/sessions/${s1}/chat`, { text: 'hold' }))
  await until(() => app!.state.locks.holder(wsId) === a.id)
  const b = await json<Run>(await c.post(`/api/sessions/${s2}/chat`, { text: 'second' }))
  expect((await json(await c.post(`/api/runs/${b.id}/cancel`))).cancelled).toBe(true)
  // ended now, while the holder still holds the folder
  const ended = await settledWithin(waitDone(app!.state, b.id), 1000)
  expect(ended).not.toBe('pending')
  expect((ended as Run).status).toBe('cancelled')
  expect(events(b.id)).toEqual(['run_queued', 'run_finished'])                // no run_started
  expect(app!.state.locks.holder(wsId)).toBe(a.id)
  expect(app!.state.locks.state(wsId).waiters).toEqual([])
  release()
  await waitDone(app!.state, a.id)
  expect(app!.state.locks.holder(wsId)).toBeNull()                            // never handed to the stopped run
})

test('a queued run stopped in line and the holder that finishes after it keep their handles and replays, and hold no meter once ended', async () => {
  const { c, s1, s2, wsId, release, order } = await sharedFolder()
  try {
    const a = await json<Run>(await c.post(`/api/sessions/${s1}/chat`, { text: 'hold' }))
    const aLive = collectEvents(app!.state, a.id)
    // the holder's first request has entered the model (and waits there for release)
    await until(() => order.length === 1 && app!.state.locks.holder(wsId) === a.id, 60_000)
    const b = await json<Run>(await c.post(`/api/sessions/${s2}/chat`, { text: 'second' }))
    const bLive = collectEvents(app!.state, b.id)
    expect((await json(await c.post(`/api/runs/${b.id}/cancel`))).cancelled).toBe(true)
    const stopped = await waitDone(app!.state, b.id)
    expect(stopped.status).toBe('cancelled')
    const hb = app!.state.runs.handles.get(b.id)!
    expect(hb.done).toBe(true)
    expect(hb.task).not.toBeNull()
    expect(hb.meter).toBeNull()
    expect('stash_json' in hb).toBe(false)
    expect(app!.state.runs.cancel(b.id)).toBe(false)
    // the stopped run's events, payloads included: the live stream, the late one, its SSE, the page and the saved rows
    const bEvents = await bLive
    expect(bEvents.map((e) => e.event)).toEqual(['run_queued', 'run_finished'])
    expect(bEvents[0]!.data).toMatchObject({ reason: 'workspace_lock', blocking_run_id: a.id, position: 1 })
    expect(bEvents[1]!.data).toMatchObject({ status: 'cancelled' })
    expect(await collectEvents(app!.state, b.id)).toEqual(bEvents)
    const plainOf = (e: { seq: number; event: string; data: Record<string, unknown> }) => ({ seq: e.seq, event: e.event, data: JSON.parse(JSON.stringify(e.data)) })
    expect(parseSse(await (await c.get(`/api/runs/${b.id}/events`)).text())).toEqual(bEvents.map((e) => ({ event: e.event, id: e.seq, data: plainOf(e).data })))
    const page = await json(await c.get(`/api/runs/${b.id}/events/page?after=-1&limit=1000`))
    expect(page.events).toEqual(bEvents.map(plainOf))
    expect(repo.listEvents(app!.state.conn, b.id).map(plainOf)).toEqual(bEvents.map(plainOf))
    const bRow = await json(await c.get(`/api/runs/${b.id}`))
    expect(bRow.live).toBe(false)
    expect({ status: bRow.status, receipt: bRow.receipt, usage: bRow.usage }).toEqual(JSON.parse(JSON.stringify({ status: stopped.status, receipt: stopped.receipt, usage: stopped.usage })))
    // the holder, still in its request, keeps its meter until its own end is written
    expect(app!.state.runs.handles.get(a.id)!.done).toBe(false)
    expect(app!.state.runs.handles.get(a.id)!.meter).not.toBeNull()
    release()
    const done = await waitDone(app!.state, a.id)
    expect(done.status).toBe('done')
    expect(done.usage).toMatchObject({ requests: 1 })
    expect(done.receipt.final_text).toBe('ok')
    const ha = app!.state.runs.handles.get(a.id)!
    expect(ha.done).toBe(true)
    expect(ha.meter).toBeNull()
    const aEvents = await aLive
    expect(aEvents.at(-1)!.event).toBe('run_finished')
    expect(await collectEvents(app!.state, a.id)).toEqual(aEvents)
    const aSaved = repo.listEvents(app!.state.conn, a.id).map(plainOf)
    const aBySeq = new Map(aEvents.map((e) => [e.seq, plainOf(e)]))
    expect(aSaved).toEqual(aSaved.map((e) => aBySeq.get(e.seq)!))
  } finally {
    release()
  }
})

test('writers queued for one folder go in turn, each told when its place changes', async () => {
  const { c, s1, s2, wsId, release, order } = await sharedFolder()
  const a = await json<Run>(await c.post(`/api/sessions/${s1}/chat`, { text: 'hold' }))
  await until(() => app!.state.locks.holder(wsId) === a.id)
  const b = await json<Run>(await c.post(`/api/sessions/${s2}/chat`, { text: 'second' }))
  const wo = await json<Run>(await c.post(`/api/sessions/${s1}/work-orders`, { work_order: { prompt: 'order', model: MODEL, workspace: { base: 'parent' } } }))
  expect(wo.status).toBe('queued')
  expect(rec((await json(await c.get(`/api/runs/${wo.id}`))).waiting).position).toBe(2)
  release()
  await waitDone(app!.state, a.id)
  await waitDone(app!.state, b.id)
  await waitDone(app!.state, wo.id)
  expect(order).toEqual(['hold', 'second', 'order'])
  // the order heard it moved up when the folder passed on to the second run (one step: never free in between)
  const moved = repo.listEvents(app!.state.conn, wo.id).filter((e) => e.event === 'run_queued').map((e) => [e.data.blocking_run_id, e.data.position])
  expect(moved).toEqual([[a.id, 2], [b.id, 1]])
})

test('a command that may write is refused while another writer holds the folder, saying who and how to go on; read_only runs beside it', async () => {
  const { c, s1, wsId, release } = await sharedFolder()
  const a = await json<Run>(await c.post(`/api/sessions/${s1}/chat`, { text: 'hold' }))
  await until(() => app!.state.locks.holder(wsId) === a.id)
  const refused = await json(await c.post(`/api/workspaces/${wsId}/commands`, { command: 'ls', wait_s: 5, access: 'session', session_id: s1 }), 409)
  expect(refused).toMatchObject({ code: 'workspace_busy', operation: 'command', blocking_owner: a.id, blocking_kind: 'run', blocking_run_id: a.id, blocking_session_id: s1, workspace_id: wsId })
  expect(String(refused.detail)).toContain(`run ${a.id} of session ${s1}`)
  expect(String(refused.next_step)).toContain('read_only: true')
  // read-only: not a writer, so it runs now, beside the run (the OS holding it to reading is the execution layer's)
  const read = await json(await c.post(`/api/workspaces/${wsId}/commands`, { command: 'ls', wait_s: 5, read_only: true, access: 'session', session_id: s1 }))
  expect(read.exit_code).toBe(0)
  expect(String(read.stdout)).toContain('README.md')
  expect(read.workspace_lane).toBe('read_only')
  // what the route asked of the execution layer: a Full access command on the host with the folder denied its writes
  expect(read.effective_access).toBe('full')
  expect((read.access_reasons as Record<string, unknown>[]).map((r) => r.code)).toContain('read_only')
  expect(hostRuntime.restrictions.at(-1)!.write_deny).toContain(realpathSync(String(rec(await json(await c.get(`/api/workspaces/${wsId}`))).path)))
  expect(app!.state.locks.holder(wsId)).toBe(a.id)
  expect(app!.state.locks.state(wsId).readers).toEqual([])                   // listed only while it ran
  // a surface v1–v5 has no read-only command: refused, not run as a writer under another name
  const old = await json(await c.post(`/api/workspaces/${wsId}/commands`, { command: 'ls', read_only: true }, { 'x-oasis-tool-surface': 'director.v3', 'x-oasis-code-token': 'test-token', origin: 'http://localhost' }), 400)
  expect(old.code).toBe('read_only_unsupported')
  release()
  await waitDone(app!.state, a.id)
})

test("a connector's command still running when its wait ends keeps the folder held until it has really ended", async () => {
  const { c, s1, wsId } = await sharedFolder()
  setModel(app!.state, MODEL, scriptedModel(() => modelResponse([textPart('after the command')])))
  const started = await json(await c.post(`/api/workspaces/${wsId}/commands`, { command: 'sleep 2.5; echo done > after.txt', wait_s: 0 }))
  expect(started.status).toBe('running')
  expect(started.holds_workspace_until_exit).toBe(true)
  const xid = started.execution_id as string
  // the folder's holder: the command, which still runs (its route has answered)
  const holder = app!.state.locks.state(wsId).holder!
  expect(holder).toMatchObject({ kind: 'command', background: true, execution_ids: [xid] })
  // a run behind it is queued, named the command; another writer command is refused, named it too
  const run = await json<Run>(await c.post(`/api/sessions/${s1}/chat`, { text: 'next' }))
  expect(run.status).toBe('queued')
  expect((await json(await c.get(`/api/runs/${run.id}`))).waiting).toMatchObject({ blocking_kind: 'command', blocking_execution_ids: [xid] })
  const second = await json(await c.post(`/api/workspaces/${wsId}/commands`, { command: 'true' }), 409)
  expect(second).toMatchObject({ code: 'workspace_busy', blocking_kind: 'command', blocking_execution_ids: [xid] })
  // polling the command is no write: it is answered while the command holds the folder
  const polled = await json(await c.post(`/api/workspaces/${wsId}/commands`, { execution_id: xid, wait_s: 10 }))
  expect(polled.exit_code).toBe(0)
  const done = await waitDone(app!.state, run.id)
  expect(done.status).toBe('done')
  expect(events(run.id).slice(0, 3)).toEqual(['run_queued', 'slot_acquired', 'run_started'])
  expect(repo.getExecution(app!.state.conn, xid)!.finished_at).not.toBeNull()     // started only once it had ended
})

test("a run's command still running as the run ends keeps the folder held for another session's writer until it exits", async () => {
  const { c, s1, s2, wsId } = await sharedFolder()
  let n = 0
  setModel(app!.state, MODEL, scriptedModel(() => {
    n += 1
    if (n === 1) return modelResponse([toolCallPart('bash', { command: 'sleep 2.5', wait_s: 1 }, 'b1')])
    return modelResponse([textPart(n === 2 ? 'left it running' : 'next')])
  }))
  const first = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${s1}/chat`, { text: 'start it' }))).id)
  expect(first.status).toBe('done')
  const xid = repo.listExecutions(app!.state.conn, { run_id: first.id })[0]!.id
  expect(app!.state.processes.isRunning(xid)).toBe(true)
  // another session's run (a run of the same conversation would work beside it: test_background_cohort)
  const next = await json<Run>(await c.post(`/api/sessions/${s2}/chat`, { text: 'next' }))
  expect(next.status).toBe('queued')
  expect((await json(await c.get(`/api/runs/${next.id}`))).waiting).toMatchObject({ blocking_kind: 'command', blocking_run_id: first.id, blocking_execution_ids: [xid] })
  expect(app!.state.locks.state(wsId).holder).toMatchObject({ owner: first.id, kind: 'run', background: true, execution_ids: [xid] })
  await waitDone(app!.state, next.id)
  expect(repo.getExecution(app!.state.conn, xid)!.finished_at).not.toBeNull()
  expect(app!.state.locks.holder(wsId)).toBeNull()
})

test("a checkpoint is made as the folder's writer: nobody starts writing between its check and its pin", async () => {
  app = await makeApp(null, passthrough)
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'snap' }))
  const wsId = rec(s.workspace).id as string
  setModel(app.state, MODEL, scriptedModel(() => modelResponse([textPart('ran')])))
  const workspaces = app.state.workspaces
  const real = workspaces.checkpoint.bind(workspaces)
  let release!: () => void
  const pinning = new Promise<void>((r) => { release = r })
  workspaces.checkpoint = (async (...args: Parameters<typeof real>) => { await pinning; return real(...args) }) as typeof real
  const pending = c.post(`/api/workspaces/${wsId}/checkpoint`, { note: 'mine' })
  await until(() => app!.state.locks.holder(wsId) !== null)
  expect(app.state.locks.state(wsId).holder).toMatchObject({ kind: 'operation', operation: 'checkpoint' })
  // meanwhile: a writer command is refused naming the checkpoint; a run waits behind it
  const refused = await json(await c.post(`/api/workspaces/${wsId}/commands`, { command: 'touch late.txt' }), 409)
  expect(refused).toMatchObject({ code: 'workspace_busy', blocking_kind: 'operation' })
  const run = await json<Run>(await c.post(`/api/sessions/${s.id}/chat`, { text: 'write' }))
  expect(run.status).toBe('queued')
  release()
  expect((await pending).status).toBe(200)
  workspaces.checkpoint = real
  expect((await waitDone(app.state, run.id)).status).toBe('done')
})

test("the folder's refusals are one 409: workspace_busy, the holder's kind and id as they are, how to go on", async () => {
  app = await makeApp(null, passthrough)
  const c = new Client(app)
  const state = app.state
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'snap' }))
  const wsId = rec(s.workspace).id as string
  setModel(state, MODEL, scriptedModel(() => modelResponse([textPart('ok')])))
  const cp = await json(await c.post(`/api/workspaces/${wsId}/checkpoint`, { note: 'first' }))
  await state.locks.acquire(wsId, 'command:cmd_fake')
  const shape = { code: 'workspace_busy', workspace_id: wsId, blocking_owner: 'command:cmd_fake', blocking_kind: 'command', blocking_run_id: null }
  const checkpoint = await json(await c.post(`/api/workspaces/${wsId}/checkpoint`, { note: 'x' }), 409)
  expect(checkpoint).toMatchObject({ ...shape, operation: 'checkpoint' })
  expect(String(checkpoint.detail)).not.toContain('run command:')             // a command is not called a run
  expect(await json(await c.post(`/api/workspaces/${wsId}/integrate`, { checkpoint_ids: [cp.id] }), 409)).toMatchObject({ ...shape, operation: 'integrate' })
  const order = await json(await c.post(`/api/sessions/${s.id}/work-orders`, { work_order: { prompt: 'p', model: MODEL, workspace: { base: 'parent' } } }), 409)
  expect(order).toMatchObject({ ...shape, operation: 'work_order_base', latest_checkpoint_id: cp.id })
  expect(String(order.next_step)).toContain(cp.id as string)
  const A = agentMentionToken('Scripted A', MODEL, 'A')
  const B = agentMentionToken('Scripted A', MODEL, 'B')
  const ix = await json(await c.post(`/api/sessions/${s.id}/interactions`, { text: `${A} ${B} go`, plan: { template: 'independent' } }), 409)
  expect(ix).toMatchObject({ ...shape, operation: 'interaction_base' })
  state.locks.release(wsId, 'command:cmd_fake')
})

test('an interaction over a folder edited in place pins nothing: it is taken while another session writes the folder, its steps queue', async () => {
  const { c, s1, s2, wsId, release } = await sharedFolder()
  const a = await json<Run>(await c.post(`/api/sessions/${s1}/chat`, { text: 'hold' }))
  await until(() => app!.state.locks.holder(wsId) === a.id)
  const A = agentMentionToken('Scripted A', MODEL, 'A')
  const B = agentMentionToken('Scripted A', MODEL, 'B')
  const created = await json<InteractionDetail>(await c.post(`/api/sessions/${s2}/interactions`, { text: `${A} ${B} each look`, plan: { template: 'independent' } }))
  expect(created.base_checkpoint_id).toBeNull()
  await until(async () => (await json<InteractionDetail>(await c.get(`/api/interactions/${created.id}`))).nodes.some((n) => n.run_id !== null))
  const detail = await json<InteractionDetail>(await c.get(`/api/interactions/${created.id}`))
  const step = detail.nodes.find((n) => n.run_id !== null)!
  expect((await json(await c.get(`/api/runs/${step.run_id}`))).waiting).toMatchObject({ blocking_run_id: a.id })
  release()
  await waitDone(app!.state, a.id)
  let now = detail
  for (let i = 0; i < 400 && !['done', 'error', 'waiting'].includes(now.status); i += 1) { await sleep(25); now = await json<InteractionDetail>(await c.get(`/api/interactions/${created.id}`)) }
  for (const n of now.nodes) if (n.run_id) await waitDone(app!.state, n.run_id)
  expect((await json<InteractionDetail>(await c.get(`/api/interactions/${created.id}`))).status).toBe('done')
})

test("an undo while another writer holds the folder: 409 workspace_busy naming it; the run's own hold lets it through", async () => {
  const { c, s1, wsId, release } = await sharedFolder()
  release()
  setModel(app!.state, MODEL, scriptedModel((m) => (!lastToolReturn(m, 'write_file') ? modelResponse([toolCallPart('write_file', { path: 'n.txt', content: 'n\n' }, 'w')]) : modelResponse([textPart('wrote')]))))
  const first = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${s1}/chat`, { text: 'write' }))).id)
  await app!.state.locks.acquire(wsId, 'run_other')
  const refused = await json(await c.post(`/api/runs/${first.id}/undo`), 409)
  expect(refused).toMatchObject({ code: 'workspace_busy', operation: 'undo', blocking_owner: 'run_other', blocking_kind: 'run', blocking_run_id: 'run_other' })
  app!.state.locks.release(wsId, 'run_other')
  expect((await json(await c.post(`/api/runs/${first.id}/undo`))).removed).toEqual(['n.txt'])
})

test('an approval while another writer holds the folder is refused naming it (nothing approved for later); its own reasons have codes', async () => {
  app = await makeApp()
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'gate' }))
  const sid = session.id as string
  await json(await c.post(`/api/sessions/${sid}/agent-control`, { desired_state: 'pause', gate_effects: ['workspace_write'] }))
  setModel(app.state, MODEL, scriptedModel((m) => (!lastToolReturn(m, 'write_file')
    ? modelResponse([toolCallPart('write_file', { path: 'NEW.md', content: 'hi\n' }, '')]) : modelResponse([textPart('proposed')]))))
  await waitDone(app.state, (await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'add a file' }))).id as string)
  const pid = ((await json(await c.get(`/api/sessions/${sid}/action-proposals`))).proposals as Record<string, unknown>[])[0]!.proposal_asset_id as string
  const wsId = rec(session.workspace).id as string
  await app.state.locks.acquire(wsId, 'command:cmd_fake')
  const busy = await json(await c.post(`/api/action-proposals/${pid}/decide`, { decision: 'approve' }), 409)
  expect(busy).toMatchObject({ code: 'workspace_busy', operation: 'approve', blocking_kind: 'command', blocking_owner: 'command:cmd_fake' })
  expect(String(busy.detail)).not.toContain('run command:')
  app.state.locks.release(wsId, 'command:cmd_fake')
  await sleep(100)
  expect(gate.listProposals(app.state.conn, project.id as string, sid).map((p) => p.status)).toEqual(['pending'])   // not approved behind the holder
  expect(rec((await json(await c.post(`/api/action-proposals/${pid}/decide`, { decision: 'approve' }))).result).status).toBe('ok')
  expect((await json(await c.post(`/api/action-proposals/${pid}/decide`, { decision: 'approve' }), 409)).code).toBe('proposal_already_decided')
})

test('an approved command still running when its wait ends keeps the folder held until it exits', async () => {
  state = await appState({ sandbox: true })
  const { project, session, ws } = await openSession(state, buggyRepo())
  gate.recordRunControl(state.conn, session.id, 'pause', ['isolated_code_execution'])
  setModel(state, MODEL, scriptedModel((m) => (!lastToolReturn(m, 'bash')
    ? modelResponse([toolCallPart('bash', { command: 'sleep 2.5; echo done', wait_s: 1 }, '')]) : modelResponse([textPart('proposed')]))))
  await waitDone(state, (await state.runs.start(session, 'run it')).id)
  const pid = gate.listProposals(state.conn, project.id, session.id)[0]!.proposal_asset_id
  const decided = await gate.decideProposal(state, pid, 'approve')
  const result = rec(decided.result)
  expect(result.status).toBe('running')
  expect(result.holds_workspace_until_exit).toBe(true)
  const xid = result.execution_id as string
  expect(state.locks.state(ws.id).holder).toMatchObject({ owner: `approval:${pid}`, kind: 'approval', background: true, execution_ids: [xid] })
  setModel(state, MODEL, scriptedModel(() => modelResponse([textPart('after')])))
  const next = await state.runs.start(repo.getSession(state.conn, session.id)!, 'next', { fresh: true })
  expect(next.status).toBe('queued')
  expect(state.runs.waitingOf(next.id)).toMatchObject({ blocking_kind: 'command', blocking_proposal_id: pid, blocking_execution_ids: [xid] })
  await waitDone(state, next.id)
  expect(repo.getExecution(state.conn, xid)!.finished_at).not.toBeNull()
})

// -- the lock itself ----------------------------------------------------------------------------------------------

function locks(): WorkspaceLocks { return new WorkspaceLocks(join(tempDir('oasis-locks-'), 'locks')) }

test('a waiter that is stopped leaves the line at once and is never handed the folder', async () => {
  const l = locks()
  await l.acquire('w', 'run_a')
  const stop = new AbortController()
  const waiting = l.acquire('w', 'run_b', { signal: stop.signal } as never)
  let got: unknown = 'pending'
  waiting.then(() => { got = 'held' }, (e) => { got = e })
  await sleep(20)
  stop.abort()
  await sleep(20)
  expect((got as Error).name).toBe('LockWaitCancelled')                     // a QueueCancelled: the runner ends it cancelled
  l.release('w', 'run_a')
  await sleep(20)
  expect(l.holder('w')).toBeNull()
})

test("a holder taking its own folder again goes through (no wait for itself); the line is first come, first served", async () => {
  const l = locks()
  await l.acquire('w', 'run_a')
  expect(await settledWithin(l.acquire('w', 'run_a'), 200)).not.toBe('pending')
  const order: string[] = []
  const b = l.acquire('w', 'run_b').then(() => order.push('b'))
  const c = l.acquire('w', 'run_c').then(() => order.push('c'))
  expect(l.tryAcquire('w', 'op_x')).toBe(false)                               // no barging past the line
  l.release('w', 'run_a')
  expect(l.holder('w')).toBe('run_a')                                         // taken twice, let go once
  l.release('w', 'run_a')
  await b
  l.release('w', 'run_b')
  await c
  expect(order).toEqual(['b', 'c'])
})

test('a command that ended before its lease was taken never keeps the folder held', async () => {
  const l = locks()
  await l.acquire('w', 'command:cmd_x')
  expect(l.holdUntil('w', 'command:cmd_x', 'x_1', Promise.resolve())).toBe(true)
  l.release('w', 'command:cmd_x')
  await sleep(0)
  expect(l.holder('w')).toBeNull()
  // one that ends later: held for it until then, then handed on
  await l.acquire('w', 'command:cmd_y')
  let end!: () => void
  l.holdUntil('w', 'command:cmd_y', 'x_2', new Promise<void>((r) => { end = r }))
  l.release('w', 'command:cmd_y')
  const next = l.acquire('w', 'run_n')
  expect(l.state('w').holder).toMatchObject({ background: true, execution_ids: ['x_2'] })
  expect(await settledWithin(next, 50)).toBe('pending')
  end()
  await next
  expect(l.holder('w')).toBe('run_n')
})
