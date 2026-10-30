/** A conversation's background commands, through the app (beside test_lock_cohort, test_remote_cohort_lease and the
 *  acceptance file): who started each command is kept with it; the next run of the conversation is told which of its
 *  commands are still running and reads their output; the run's marker survives its death (a lost run's receipt
 *  says what the marker said); a snapshot run that leaves its own writers running claims no final state; a baseline
 *  that would pin a tree a hard lock refuses is not taken (the run's attribution unavailable, said); the harness's
 *  own operations stay refused while the conversation's run or its commands hold the folder. Synthetic local folders
 *  and repositories only. */

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Run } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { launcherOf } from '../src/execution/processes.ts'
import { isUserPrompt, lastToolReturn, modelResponse, textPart, toolCallPart, type ModelMessage, type ModelResponse } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { markerOf } from '../src/agent/attribution.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo, FAKE_FULL, PassthroughRuntime, scriptedModel, setModel, sleep, waitDone } from './harness.ts'
import { tempDir } from './helpers.ts'

const MODEL = 'scripted:a'
const OPTIONS = { probe: false, runtime: new PassthroughRuntime(), isolation: { ...FAKE_FULL, runtime: 'passthrough' } }
type Rec = Record<string, unknown>
const rec = (v: unknown) => (v ?? {}) as Rec

let app: App | null = null
const gateFiles: string[] = []
afterEach(async () => {
  for (const g of gateFiles.splice(0)) { try { writeFileSync(g, '') } catch { /* gone */ } }
  if (app) {
    for (const [id, h] of app.state.runs.handles) if (!h.done) app.state.runs.cancel(id)
    await app.close()
  }
  app = null
})

/** A file the shell waits for (a minute at most): `open()` lets it go. */
function gate() {
  const path = join(tempDir('oasis-cohort-gate-'), 'open')
  gateFiles.push(path)
  return { wait: `i=0; while [ ! -f '${path}' ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done`, open: () => writeFileSync(path, '') }
}

type Step = (messages: ModelMessage[]) => ModelResponse | Promise<ModelResponse>
const say = (t: string) => modelResponse([textPart(t)])
const promptText = (m: ModelMessage) => m.kind !== 'request' ? '' : m.parts.filter(isUserPrompt).map((p) => (Array.isArray(p.content) ? p.content.filter((c) => typeof c === 'string').join('\n') : String(p.content))).join('\n')
/** `TURN:<key>` in a run's message picks its steps (the n-th model call of the run plays the n-th step). */
function router(turns: Record<string, Step[]>) {
  return scriptedModel(async (messages) => {
    let at = -1
    let key: string | null = null
    for (let i = messages.length - 1; i >= 0 && key === null; i -= 1) {
      const m = /TURN:(\w+)/.exec(promptText(messages[i]!))
      if (m) { at = i; key = m[1]! }
    }
    const n = messages.slice(at + 1).filter((m) => m.kind === 'response').length
    const step = key === null ? undefined : turns[key]?.[n]
    return step ? step(messages) : say(`turn ${key ?? '?'} ends`)
  })
}

async function open(): Promise<Client> {
  app = await makeApp(null, OPTIONS)
  return new Client(app)
}
const chat = async (c: Client, sid: string, body: Rec) => json<Run>(await c.post(`/api/sessions/${sid}/chat`, body))
function plainFolder(): string {
  const dir = join(tempDir('oasis-cohort-folder-'), 'f')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'README.md'), 'x\n')
  return dir
}

test('the launcher is kept with each command; the next run is told which of its conversation\'s commands still run, reads their output, and its Stop leaves them', async () => {
  const c = await open()
  const project = await json(await c.post('/api/projects', { source_path: plainFolder(), mode: 'direct' }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'bg' }))
  const sid = s.id as string
  const wsId = rec(s.workspace).id as string
  const g = gate()
  const r2Saw: string[] = []
  let r2Release!: () => void
  const r2Held = new Promise<void>((r) => { r2Release = r })
  setModel(app!.state, MODEL, router({
    r1: [() => modelResponse([toolCallPart('bash', { command: `echo first-line; ${g.wait}; echo done`, wait_s: 1 }, 'b1')]), () => say('left running')],
    r2: [
      (m) => { r2Saw.push(JSON.stringify(m)); const xid = repo.listExecutions(app!.state.conn, { workspace_id: wsId })[0]!.id; return modelResponse([toolCallPart('bash_output', { execution_id: xid }, 'o1')]) },
      async (m) => { r2Saw.push(JSON.stringify(lastToolReturn(m, 'bash_output'))); await r2Held; return say('read it') },
    ],
  }))
  const r1 = await waitDone(app!.state, (await chat(c, sid, { text: 'TURN:r1' })).id)
  const xid = repo.listExecutions(app!.state.conn, { run_id: r1.id })[0]!.id
  expect(launcherOf(repo.getExecution(app!.state.conn, xid))).toBe('run')
  expect(app!.state.processes.isRunning(xid)).toBe(true)

  const r2 = await chat(c, sid, { text: 'TURN:r2' })
  expect(r2.status).not.toBe('queued')
  await (async () => { for (let i = 0; i < 400 && r2Saw.length < 2; i += 1) await sleep(25) })()
  // told before its first request: the command, its run and how it stands
  expect(r2Saw[0]).toContain('Commands an earlier turn of this conversation started are still running')
  expect(r2Saw[0]).toContain(xid)
  expect(r2Saw[0]).toContain(r1.id)
  // and it reads the command's output with the existing tool (the command is its session's)
  expect(r2Saw[1]).toContain('first-line')
  expect(markerOf(repo.getRun(app!.state.conn, r2.id)!.manifest)).toMatchObject({ overlapped: true, background_execution_ids: [xid], inherited_from_run_ids: [r1.id] })
  // the workspace's lock names R2 as the foreground and the command as R1's
  const lock = rec(rec(await json(await c.get(`/api/workspaces/${wsId}`))).lock)
  expect(rec(lock.holder)).toMatchObject({ owner: r2.id, background: false, background_execution_ids: [xid], origin_run_ids: [r1.id] })
  // R2 stopped: the command goes on
  expect((await json(await c.post(`/api/runs/${r2.id}/cancel`))).cancelled).toBe(true)
  r2Release()
  expect((await waitDone(app!.state, r2.id)).status).toBe('cancelled')
  expect(app!.state.processes.isRunning(xid)).toBe(true)
  expect(markerOf(repo.getRun(app!.state.conn, r2.id)!.manifest)?.overlapped).toBe(true)
  g.open()
  await app!.state.processes.wait(xid, 20)
  for (let i = 0; i < 200 && app!.state.locks.holder(wsId) !== null; i += 1) await sleep(25)
  // a connector's command, once the folder is free, is the connector's
  const routed = await json(await c.post(`/api/workspaces/${wsId}/commands`, { command: 'true', wait_s: 5 }))
  expect(launcherOf(repo.getExecution(app!.state.conn, routed.execution_id as string))).toBe('connector')
})

test('a run that died keeps what its marker said: its lost receipt is partial in place, unavailable in a snapshot workspace', async () => {
  const c = await open()
  const state = app!.state
  const direct = await json(await c.post('/api/projects', { source_path: plainFolder(), mode: 'direct' }))
  const ds = await json(await c.post(`/api/projects/${direct.id}/sessions`, { title: 'direct' }))
  const snapshot = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const ss = await json(await c.post(`/api/projects/${snapshot.id}/sessions`, { title: 'snapshot' }))
  const marker = { version: 1, overlapped: true, background_execution_ids: ['x_bg'], inherited_from_run_ids: ['run_earlier'], base_tree_sha: null, baseline_checkpoint_id: null, unavailable_reason: 'overlapped_background_writers' }
  const dead = (session: Rec) => {
    const run = repo.insertRun(state.conn, { session_id: session.id as string, project_id: session.project_id as string, workspace_id: rec(session.workspace).id as string, model: MODEL, model_config: {}, user_text: 'died', status: 'running', budget: {} })
    repo.setRunManifest(state.conn, run.id, { background_attribution: marker })
    return run.id
  }
  const d = dead(ds)
  const sn = dead(ss)
  await state.runs.reconcile()
  const diffOf = (id: string) => rec(rec(repo.getRun(state.conn, id)!.receipt.mechanical).diff)
  expect(repo.getRun(state.conn, d)!.receipt.status).toBe('lost')
  expect(diffOf(d)).toMatchObject({ in_place: true, attribution: 'partial', background_execution_ids: ['x_bg'] })
  expect(diffOf(sn)).toMatchObject({ attribution: 'unavailable', background_execution_ids: ['x_bg'] })
})

test('a snapshot run that leaves its own writer running claims no final state; the folder\'s operations stay refused while the conversation holds it', async () => {
  const c = await open()
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'snap' }))
  const sid = s.id as string
  const wsId = rec(s.workspace).id as string
  const g = gate()
  let r2Release!: () => void
  const r2Held = new Promise<void>((r) => { r2Release = r })
  let r2In = false
  setModel(app!.state, MODEL, router({
    r1: [
      () => modelResponse([toolCallPart('write_file', { path: 'mine.txt', content: 'mine\n' }, 'w1')]),
      () => modelResponse([toolCallPart('bash', { command: `${g.wait}; echo later > later.txt`, wait_s: 1 }, 'b1')]),
      () => say('left a writer running'),
    ],
    r2: [async () => { r2In = true; await r2Held; return say('r2') }],
  }))
  const r1 = await waitDone(app!.state, (await chat(c, sid, { text: 'TURN:r1' })).id)
  expect(r1.status, String(r1.error)).toBe('done')
  const xid = repo.listExecutions(app!.state.conn, { run_id: r1.id })[0]!.id
  // its own writer still runs as it ends: no final checkpoint, nothing claimed as its change
  expect(rec(r1.receipt.produced).final_checkpoint_id ?? null).toBeNull()
  expect(rec(rec(r1.receipt.mechanical).diff)).toMatchObject({ attribution: 'unavailable', background_execution_ids: [xid] })
  expect(markerOf(r1.manifest)?.unavailable_reason).toBe('live_writers')
  expect((await json(await c.get(`/api/runs/${r1.id}/diff`), 409)).code).toBe('attribution_unavailable')
  // while only its command holds the folder: a checkpoint is refused
  expect((await json(await c.post(`/api/workspaces/${wsId}/checkpoint`, { note: 'now' }), 409)).code).toBe('workspace_busy')
  // the next run of the conversation works beside it; still refused while it does
  const r2 = await chat(c, sid, { text: 'TURN:r2' })
  for (let i = 0; i < 400 && !r2In; i += 1) await sleep(25)
  expect(r2In).toBe(true)
  const refused = await json(await c.post(`/api/workspaces/${wsId}/checkpoint`, { note: 'now' }), 409)
  expect(refused).toMatchObject({ code: 'workspace_busy', blocking_run_id: r2.id })
  expect(String(refused.detail)).toContain(xid)
  r2Release()
  await waitDone(app!.state, r2.id)
  g.open()
  await app!.state.processes.wait(xid, 20)
  for (let i = 0; i < 200 && app!.state.locks.holder(wsId) !== null; i += 1) await sleep(25)
  expect(app!.state.locks.holder(wsId)).toBeNull()
})

test('a baseline a hard lock refuses is not pinned: the run says its attribution is unavailable, and nothing of the old change is claimed', async () => {
  const c = await open()
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'locked' }))
  const sid = s.id as string
  const ws = rec(s.workspace)
  setModel(app!.state, MODEL, router({}))
  await json(await c.put(`/api/sessions/${sid}/locks`, { locks: [{ path: 'README.md', mode: 'read_only' }] }))
  // an edit no tool made, of a file a hard lock holds read-only
  writeFileSync(join(ws.path as string, 'README.md'), 'edited by hand\n')
  const run = await waitDone(app!.state, (await chat(c, sid, { text: 'TURN:look' })).id)
  expect(run.status, String(run.error)).toBe('done')
  expect(markerOf(run.manifest)).toMatchObject({ overlapped: false, unavailable_reason: 'baseline_lock_refused', base_tree_sha: null, baseline_checkpoint_id: null })
  expect(repo.listCheckpoints(app!.state.conn, ws.id as string)).toEqual([])
  expect(rec(rec(run.receipt.mechanical).diff)).toMatchObject({ attribution: 'unavailable' })
  expect(rec(run.receipt.produced).files_changed).toEqual([])
})
