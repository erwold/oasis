/** The session's permission presets over the API: a session starts in the mode it is created with (one transaction:
 *  grants, run control, audit entry), the mode is read back and inferred for custom combinations, a change is refused
 *  while a run is active, Plan blocks every non-read tool at the tool boundary and Ask before changes turns a patch
 *  into a proposal. */

import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as repo from '../src/db/repo.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { BUGGY_CALC, buggyRepo, scriptedModel, setModel, steps, waitDone } from './harness.ts'
import { rec } from './tree_helpers.ts'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

async function sessionIn(c: Client, mode?: string) {
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  return json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'modes', ...(mode ? { mode } : {}) }))
}

const patchingScript = () => steps(
  [toolCallPart('read_file', { path: 'calc.py' }, '')],
  [toolCallPart('edit_file', { path: 'calc.py', old_string: 'a - b   # the bug: this should add', new_string: 'a + b' }, '')],
  (m) => modelResponse([textPart(JSON.stringify({ read: rec(lastToolReturn(m, 'read_file')).status, patch: lastToolReturn(m, 'edit_file') }))]),
)

test('a session starts in the mode it is created with; omitted, it is Auto; an unknown mode is refused', async () => {
  app = await makeApp()
  const c = new Client(app)
  const plain = await sessionIn(c)
  expect((await json(await c.get(`/api/sessions/${plain.id}/mode`))).mode).toBe('auto')
  const plan = await sessionIn(c, 'plan')
  const grants = rec(plan.grants)
  expect([grants.workspace_write, grants.run_commands, grants.network, grants.attached_write]).toEqual([false, false, true, false])   // Plan reads the web too
  const read = await json(await c.get(`/api/sessions/${plan.id}/mode`))
  expect(read.mode).toBe('plan')
  expect(rec(read.control).desired_state).toBe('pause')
  const audit = repo.listGovernance(app.state.conn, plan.id as string, 'session_mode')
  expect(audit.map((e) => e.params.mode)).toEqual(['plan'])
  const approve = await sessionIn(c, 'approve')
  expect((await json(await c.get(`/api/sessions/${approve.id}/mode`))).mode).toBe('approve')
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  expect((await c.post(`/api/projects/${project.id}/sessions`, { title: 'x', mode: 'yolo' })).status).toBe(422)
  expect((await c.put(`/api/sessions/${plain.id}/mode`, { mode: 'yolo' })).status).toBe(422)
})

test('the network and the folder-write grant are add-ons beside a mode; choosing one turns both on; no commands reads as custom', async () => {
  app = await makeApp()
  const c = new Client(app)
  const session = await sessionIn(c)
  await json(await c.put(`/api/sessions/${session.id}/grants`, { network: false, attached_write: true }))
  expect((await json(await c.get(`/api/sessions/${session.id}/mode`))).mode).toBe('auto')
  const after = await json(await c.put(`/api/sessions/${session.id}/mode`, { mode: 'auto' }))
  expect(after.mode).toBe('auto')
  const grants = rec(rec(after.session).grants)
  expect([grants.workspace_write, grants.run_commands, grants.network, grants.attached_write]).toEqual([true, true, true, true])
  await json(await c.put(`/api/sessions/${session.id}/grants`, { run_commands: false }))
  expect((await json(await c.get(`/api/sessions/${session.id}/mode`))).mode).toBe('custom')
})

test('Plan: the run reads, and its patch is blocked at the tool boundary with the file untouched', async () => {
  app = await makeApp()
  const { state } = app
  setModel(state, 'scripted:a', scriptedModel(patchingScript()))
  const c = new Client(app)
  const session = await sessionIn(c, 'plan')
  const run = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'fix add' }))
  await waitDone(state, run.id as string)
  const result = JSON.parse(state.runs.handles.get(run.id as string)!.final_text) as { read: string; patch: Record<string, unknown> }
  expect(result.read).toBe('ok')
  expect(result.patch.status).toBe('blocked')
  expect(result.patch.reason).toBe('plan_mode')
  expect(readFileSync(join(rec(session.workspace).path as string, 'calc.py'), 'utf8')).toBe(BUGGY_CALC)
  expect(rec(repo.getRun(state.conn, run.id as string)!.receipt.mechanical).blocked_calls).toBe(1)
  const results = repo.listEvents(state.conn, run.id as string).filter((e) => e.event === 'tool_result').map((e) => [e.data.tool, e.data.status])
  expect(results).toEqual([['read_file', 'ok'], ['edit_file', 'blocked']])
})

test('Ask before changes: the patch becomes a proposal for the person, the file untouched until it is decided', async () => {
  app = await makeApp()
  const { state } = app
  setModel(state, 'scripted:a', scriptedModel(patchingScript()))
  const c = new Client(app)
  const session = await sessionIn(c, 'approve')
  const run = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'fix add' }))
  await waitDone(state, run.id as string)
  const result = JSON.parse(state.runs.handles.get(run.id as string)!.final_text) as { patch: Record<string, unknown> }
  expect(result.patch.status).toBe('action_gated')
  const proposals = (await json(await c.get(`/api/sessions/${session.id}/action-proposals`))).proposals as Record<string, unknown>[]
  expect(proposals.map((p) => p.proposal_asset_id)).toEqual([result.patch.proposal_asset_id])
  expect(readFileSync(join(rec(session.workspace).path as string, 'calc.py'), 'utf8')).toBe(BUGGY_CALC)
})

test('the mode does not change under an active run', async () => {
  app = await makeApp()
  const { state } = app
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  setModel(state, 'scripted:a', scriptedModel(async () => { await held; return modelResponse([textPart('done')]) }))
  const c = new Client(app)
  const session = await sessionIn(c)
  const run = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'hold' }))
  const refused = await c.put(`/api/sessions/${session.id}/mode`, { mode: 'plan' })
  expect(refused.status).toBe(409)
  expect((await json(await c.get(`/api/sessions/${session.id}/mode`))).mode).toBe('auto')
  release()
  await waitDone(state, run.id as string)
  expect((await json(await c.put(`/api/sessions/${session.id}/mode`, { mode: 'plan' }))).mode).toBe('plan')
})
