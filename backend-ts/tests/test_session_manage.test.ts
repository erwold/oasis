/** A session can be renamed and deleted from the sidebar: a deleted one is gone from the lists and the API (its
 *  records stay on disk), an open director is closed with it, and a session with a run under way is not deleted.
 *  A run's measured change reads back as a patch for the thread's file chips. */

import { afterEach, expect, test } from 'bun:test'
import { lastToolReturn, modelResponse, textPart, toolCallPart } from '../src/llm/messages.ts'
import { createApp, type App } from '../src/main.ts'
import * as repo from '../src/db/repo.ts'
import { Client, json } from './api_harness.ts'
import { buggyRepo, scriptedModel, setModel, testConfig, testSettings, waitDone } from './harness.ts'

let app: App | null = null
let release: () => void = () => {}
afterEach(async () => { release(); if (app) await app.close(); app = null })

async function twoSessions() {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const held = new Promise<void>((resolve) => { release = resolve })
  setModel(app.state, 'scripted:a', scriptedModel(async () => { await held; return modelResponse([textPart('done')]) }))
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const keep = await json<{ id: string }>(await c.post(`/api/projects/${project.id}/sessions`, { title: 'keep' }))
  const drop = await json<{ id: string }>(await c.post(`/api/projects/${project.id}/sessions`, { title: 'hello' }))
  return { c, project, keep, drop }
}

test('renaming a session changes its title everywhere; an empty title is refused', async () => {
  const { c, project, keep } = await twoSessions()
  expect((await json(await c.put(`/api/sessions/${keep.id}`, { title: '  cat drawing  ' }))).title).toBe('cat drawing')
  const listed = await json<{ sessions: { id: string; title: string }[] }>(await c.get(`/api/projects/${project.id}`))
  expect(listed.sessions.find((s) => s.id === keep.id)!.title).toBe('cat drawing')
  await json(await c.put(`/api/sessions/${keep.id}`, { title: '   ' }), 422)
  await json(await c.put('/api/sessions/nope', { title: 'x' }), 404)
})

test('a deleted session leaves the lists and the API; its records stay; its director is closed', async () => {
  const { c, project, keep, drop } = await twoSessions()
  await json(await c.post(`/api/sessions/${drop.id}/director`, { transport: 'bridge', model: 'ChatGPT', config: { bridge_url: 'http://127.0.0.1:9' } }))
  expect(await json<Record<string, unknown>>(await c.delete(`/api/sessions/${drop.id}`))).toEqual({ deleted: true, session_id: drop.id })
  const listed = await json<{ sessions: { id: string }[] }>(await c.get(`/api/projects/${project.id}`))
  expect(listed.sessions.map((s) => s.id)).toEqual([keep.id])
  const all = await json<{ id: string; sessions: { id: string }[] }[]>(await c.get('/api/projects'))
  expect(all.flatMap((p) => p.sessions.map((s) => s.id))).not.toContain(drop.id)
  await json(await c.get(`/api/sessions/${drop.id}`), 404)
  await json(await c.post(`/api/sessions/${drop.id}/chat`, { text: 'still there?' }), 404)
  await json(await c.delete(`/api/sessions/${drop.id}`), 404)
  expect(repo.getSession(app!.state.conn, drop.id)!.status).toBe('deleted')                  // the row is kept
  expect((app!.state.conn.get('SELECT state FROM director_sessions WHERE session_id=?', [drop.id]) as { state: string }).state).toBe('closed')
})

test('a session with a run under way is not deleted', async () => {
  const { c, drop } = await twoSessions()
  const run = await json(await c.post(`/api/sessions/${drop.id}/chat`, { text: 'wait' }))
  const refused = await json<{ detail: string }>(await c.delete(`/api/sessions/${drop.id}`), 409)
  expect(refused.detail).toContain('under way')
  release()
  await waitDone(app!.state, run.id as string)
  await json(await c.delete(`/api/sessions/${drop.id}`))
})

test("a run's measured change reads back as a patch, whole or one file", async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  setModel(app.state, 'scripted:a', scriptedModel((m) => (!lastToolReturn(m, 'write_file')
    ? modelResponse([toolCallPart('write_file', { path: 'art/cat.svg', content: '<svg xmlns="http://www.w3.org/2000/svg">\n<circle r="4"/>\n</svg>\n' }, '')])
    : modelResponse([textPart('drew a cat')]))))
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json<{ id: string }>(await c.post(`/api/projects/${project.id}/sessions`, { title: 'cat' }))
  const run = await json<{ id: string }>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'draw a cat' }))
  await waitDone(app.state, run.id)
  const whole = await json<{ files: { path: string; added: number; removed: number }[]; patch: string }>(await c.get(`/api/runs/${run.id}/diff`))
  expect(whole.files).toEqual([{ path: 'art/cat.svg', added: 3, removed: 0 }])
  expect(whole.patch).toContain('+<circle r="4"/>')
  const one = await json<{ files: unknown[]; patch: string }>(await c.get(`/api/runs/${run.id}/diff`, { path: 'calc.py' }))
  expect(one.files).toEqual([])
  expect(one.patch).toBe('')
  await json(await c.get('/api/runs/run_nope/diff'), 404)
})
