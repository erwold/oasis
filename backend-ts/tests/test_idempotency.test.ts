/** A chat sent again with its key — the answer lost on the way back, the person pressing send once more — is the run
 *  it already started, whether the first is still running, finished, or racing the second; a key is the session's
 *  own, and without one nothing changes. */

import { afterEach, expect, test } from 'bun:test'
import * as repo from '../src/db/repo.ts'
import { modelResponse, textPart } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo, scriptedModel, setModel, waitDone } from './harness.ts'

let app: App | null = null
let release: () => void = () => {}
afterEach(async () => { release(); if (app) await app.close(); app = null })

async function heldSession() {
  app = await makeApp()
  const held = new Promise<void>((resolve) => { release = resolve })
  setModel(app.state, 'scripted:a', scriptedModel(async () => { await held; return modelResponse([textPart('done')]) }))
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'keys' }))
  const other = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'other' }))
  return { c, session: session.id as string, other: other.id as string }
}

test('the same key again, while the run is going and after it ended, is the same run; one run is made', async () => {
  const { c, session } = await heldSession()
  const body = { text: 'fix it', client_request_id: 'k-0001-first-message' }
  const first = await json(await c.post(`/api/sessions/${session}/chat`, body))
  const again = await json(await c.post(`/api/sessions/${session}/chat`, body))      // not a 409: the same message
  expect(again.id).toBe(first.id)
  release()
  await waitDone(app!.state, first.id as string)
  const later = await json(await c.post(`/api/sessions/${session}/chat`, body))
  expect(later.id).toBe(first.id)
  expect(later.status).toBe('done')
  expect(repo.listRuns(app!.state.conn, session).map((r) => r.id)).toEqual([first.id as string])
})

test('two sends of one message at once start one run', async () => {
  const { c, session } = await heldSession()
  const body = { text: 'fix it', client_request_id: 'k-0002-raced-message' }
  const [a, b] = await Promise.all([c.post(`/api/sessions/${session}/chat`, body), c.post(`/api/sessions/${session}/chat`, body)])
  const [ra, rb] = [await json(a), await json(b)]
  expect(ra.id).toBe(rb.id)
  expect(repo.listRuns(app!.state.conn, session)).toHaveLength(1)
})

test("a key is its session's own; without a key a second message while one runs is refused as before", async () => {
  const { c, session, other } = await heldSession()
  const key = 'k-0003-shared-key'
  const mine = await json(await c.post(`/api/sessions/${session}/chat`, { text: 'fix it', client_request_id: key }))
  const theirs = await json(await c.post(`/api/sessions/${other}/chat`, { text: 'fix it', client_request_id: key }))
  expect(theirs.id).not.toBe(mine.id)
  expect((await c.post(`/api/sessions/${session}/chat`, { text: 'another thing' })).status).toBe(409)
  expect((await c.post(`/api/sessions/${session}/chat`, { text: 'x', client_request_id: 'short' })).status).toBe(422)
})

test('the start screen sent twice imports the folder once and makes one session', async () => {
  app = await makeApp()
  const c = new Client(app)
  const src = buggyRepo()
  const body = { source_path: src, client_request_id: 'start-0001/project' }
  const [a, b] = await Promise.all([c.post('/api/projects', body), c.post('/api/projects', body)])  // the second joins the first
  const [pa, pb] = [await json(a), await json(b)]
  expect(pa.id).toBe(pb.id)
  expect((await json(await c.post('/api/projects', body))).id).toBe(pa.id)                        // and later, answered at once
  expect((await json<unknown[]>(await c.get('/api/projects'))).length).toBe(1)
  const other = await json(await c.post('/api/projects', { source_path: src, client_request_id: 'start-0002/project' }))
  expect(other.id).not.toBe(pa.id)                                                                  // a new key is a new request

  const sbody = { title: 'fix it', client_request_id: 'start-0001/session' }
  const [s1, s2] = await Promise.all([c.post(`/api/projects/${pa.id}/sessions`, sbody), c.post(`/api/projects/${pa.id}/sessions`, sbody)])
  const [ra, rb] = [await json(s1), await json(s2)]
  expect(ra.id).toBe(rb.id)
  expect((await json(await c.post(`/api/projects/${pa.id}/sessions`, sbody))).id).toBe(ra.id)
  expect(repo.listSessions(app.state.conn, pa.id as string)).toHaveLength(1)
  // a key is its project's own
  expect((await json(await c.post(`/api/projects/${other.id}/sessions`, sbody))).id).not.toBe(ra.id)
})
