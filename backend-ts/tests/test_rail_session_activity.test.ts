/** The rail's summary of every session's agents (GET /api/session-activity; api/session_activity.ts): the runs live now
 *  with the signals their rows would carry (a request slot waited for, a form the person owes), the open director's
 *  state, and how many agent runs and director turns of the session have ended — every end (done, a stop, an error, an
 *  interruption, a filtered answer) counting once, two ends in the same millisecond as two, a person's action never —
 *  for every session at once, a session nobody has open included, a deleted one never. Scripted models and fixture
 *  folders only; no provider is called. */

import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROUTES, SessionActivityResponseSchema, type SessionActivity } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { insertDirectorSession, insertTurn, updateDirectorSession, updateTurn } from '../src/director/store.ts'
import { modelResponse, textPart } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo, scriptedModel, setModel, waitDone } from './harness.ts'

const MODEL = 'scripted:a'
let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

type Rec = Record<string, unknown>
async function activities(c: Client): Promise<Record<string, SessionActivity>> {
  // the answer is what the contract says it is
  return SessionActivityResponseSchema.parse(await json(await c.get('/api/session-activity'))).sessions
}

/** A model that answers once `release` is called (the run stays live until then). */
function gated(text = 'finished') {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  return { model: scriptedModel(async () => { await gate; return modelResponse([textPart(text)]) }), release }
}

async function open(c: Client, title: string) {
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  return json(await c.post(`/api/projects/${project.id}/sessions`, { title, model: MODEL }))
}

test('the route is in the frozen table', () => {
  expect(ROUTES.some((r) => r.method === 'GET' && r.path === '/api/session-activity')).toBe(true)
})

test('a background run is live in its session\'s summary; once it ends the session has one more end; the other session stays quiet; a deleted one is gone', async () => {
  app = await makeApp()
  const c = new Client(app)
  const g = gated()
  setModel(app.state, MODEL, g.model)
  const bg = await open(c, 'background')
  const quiet = await open(c, 'quiet')
  const gone = await open(c, 'gone')
  const run = await json(await c.post(`/api/sessions/${bg.id}/chat`, { text: 'take your time' }))
  let a = await activities(c)
  expect(a[bg.id as string]!.live).toEqual([{ id: run.id as string, status: 'running', spawned_by: 'human', model: MODEL, slot_waiting: false, pending_input: false }])
  expect(a[bg.id as string]!.ended).toBe(0)
  expect(a[quiet.id as string]).toEqual({ live: [], director: null, ended: 0, agents: [] })
  expect(a[gone.id as string]).toBeDefined()
  g.release()
  expect((await waitDone(app.state, run.id as string)).status).toBe('done')
  expect((await c.delete(`/api/sessions/${gone.id}`)).status).toBeLessThan(300)
  a = await activities(c)
  expect(a[bg.id as string]!.live).toEqual([])
  expect(a[bg.id as string]!.ended).toBe(1)
  // the main agent ran: the rail draws its bot
  expect(a[bg.id as string]!.agents).toEqual([{ kind: 'main', participant_id: null, model: null }])
  expect(a[gone.id as string]).toBeUndefined()
})

test('every end counts — done, a stop, an error, a filtered answer — a person\'s action never; two ends in one millisecond count as two', async () => {
  app = await makeApp()
  const c = new Client(app)
  setModel(app.state, MODEL, scriptedModel(async () => modelResponse([textPart('ok')])))
  const s = await open(c, 'endings')
  const sid = s.id as string
  const first = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'one' }))
  await waitDone(app.state, first.id as string)
  expect((await activities(c))[sid]!.ended).toBe(1)
  // a stopped run
  const g = gated()
  setModel(app.state, MODEL, g.model)
  const second = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'two' }))
  expect((await json(await c.post(`/api/runs/${second.id}/cancel`))).cancelled).toBe(true)
  await waitDone(app.state, second.id as string, 5000)
  g.release()
  expect(repo.getRun(app.state.conn, second.id as string)!.status).toBe('cancelled')
  expect((await activities(c))[sid]!.ended).toBe(2)
  // a failed run
  setModel(app.state, MODEL, scriptedModel(async () => { throw new Error('the provider blew up') }))
  const third = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'three' }))
  await waitDone(app.state, third.id as string)
  expect(repo.getRun(app.state.conn, third.id as string)!.status).toBe('error')
  expect((await activities(c))[sid]!.ended).toBe(3)
  // a person's checkpoint (a human_action row) is no agent's end
  const detail = await json(await c.get(`/api/sessions/${sid}`))
  const ws = detail.workspace as Rec
  writeFileSync(join(ws.path as string, 'notes.md'), 'by hand\n')
  await json(await c.post(`/api/workspaces/${ws.id}/checkpoint`, { note: 'mine' }))
  expect(repo.listRuns(app.state.conn, sid).some((r) => r.spawned_by === 'human_action')).toBe(true)
  expect((await activities(c))[sid]!.ended).toBe(3)
  // two runs that end in the very same millisecond (one of them a filtered answer): two more ends, never one
  const p = { session_id: sid, project_id: s.project_id as string, workspace_id: null, model: MODEL, model_config: {}, user_text: 'x', status: 'running', budget: {} }
  const x = repo.insertRun(app.state.conn, p)
  const y = repo.insertRun(app.state.conn, p)
  const at = '2026-10-18T10:00:00.000Z'
  app.state.conn.run("UPDATE runs SET status='done', finished_at=?, receipt_json=? WHERE id=?", [at, JSON.stringify({ mechanical: { answer_end: { reason: 'content_filter' } } }), x.id])
  expect((await activities(c))[sid]!.ended).toBe(4)
  app.state.conn.run("UPDATE runs SET status='error', finished_at=? WHERE id=?", [at, y.id])
  expect((await activities(c))[sid]!.ended).toBe(5)
})

test('a live run waiting for a request slot or for the person\'s form says so', async () => {
  app = await makeApp()
  const c = new Client(app)
  const g = gated()
  setModel(app.state, MODEL, g.model)
  const s = await open(c, 'waits')
  const run = await json(await c.post(`/api/sessions/${s.id}/chat`, { text: 'wait' }))
  const id = run.id as string
  // the run asks for a slot another holds (slots.ts: it is among the slot's waiters until it gets one)
  const slot = app.state.slots.slotFor('test-scope', 1)!
  const held = await slot.take('someone_else', () => false, null)
  let stop = false
  const queued = slot.take(id, () => stop, null).catch(() => null)
  let live = (await activities(c))[s.id as string]!.live
  expect(live.map((r) => [r.id, r.slot_waiting, r.pending_input])).toEqual([[id, true, false]])
  stop = true
  await queued
  held.release()
  // a form of the run waits for the person
  const form = repo.insertUiInput(app.state.conn, { session_id: s.id as string, run_id: id, tool_call_id: 'tc_form', request: { title: 'Pick', root: 'r', elements: {} } })
  live = (await activities(c))[s.id as string]!.live
  expect(live.map((r) => [r.id, r.slot_waiting, r.pending_input])).toEqual([[id, false, true]])
  app.state.conn.run("UPDATE ui_inputs SET status='dismissed' WHERE id=?", [form.id])
  live = (await activities(c))[s.id as string]!.live
  expect(live.map((r) => [r.id, r.slot_waiting, r.pending_input])).toEqual([[id, false, false]])
  g.release()
  await waitDone(app.state, id)
})

test('the open director: its state and current turn; each of its turns that ends (done or not) is one more end', async () => {
  app = await makeApp()
  const c = new Client(app)
  const s = await open(c, 'directed')
  const sid = s.id as string
  const conn = app.state.conn
  const d = insertDirectorSession(conn, { session_id: sid, transport: 'native', model: MODEL, label: 'Director', config: {} })
  const past = insertTurn(conn, { director_session_id: d.id, session_id: sid, kind: 'user', input: 'before' })
  updateTurn(conn, past.id, { status: 'done', finished_at: '2026-10-18T09:00:00.000Z' })
  const now = insertTurn(conn, { director_session_id: d.id, session_id: sid, kind: 'user', input: 'now' })
  updateTurn(conn, now.id, { status: 'generating', started_at: '2026-10-18T09:10:00.000Z' })
  updateDirectorSession(conn, d.id, { state: 'generating', current_turn_id: now.id })
  let a = (await activities(c))[sid]!
  expect(a.director).toEqual({ state: 'generating', turn: { id: now.id, status: 'generating', finished_at: null } })
  expect(a.ended).toBe(1)
  updateTurn(conn, now.id, { status: 'error', finished_at: '2026-10-18T09:00:00.000Z', error: 'interrupted' })
  updateDirectorSession(conn, d.id, { state: 'idle', current_turn_id: null })
  a = (await activities(c))[sid]!
  expect(a.director).toEqual({ state: 'idle', turn: null })
  expect(a.ended).toBe(2)
  // closed: no director; its turns' ends still count
  updateDirectorSession(conn, d.id, { state: 'closed', closed_at: '2026-10-18T09:30:00.000Z' })
  a = (await activities(c))[sid]!
  expect(a.director).toBeNull()
  expect(a.ended).toBe(2)
})
