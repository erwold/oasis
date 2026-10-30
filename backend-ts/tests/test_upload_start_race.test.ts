/** Regression: an upload's start counted against the session's MAX_OPEN_UPLOADS_PER_SESSION only once its staged file
 *  existed, so starts made at once (each awaiting its file) all saw room and all were taken. The quota now counts the
 *  starts still making their file; a start whose file could not be made gives its place back; a close waits for the
 *  starts under way and leaves no staged file and no open upload behind. */

import { afterEach, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import type { Session } from '@oasis-code/contract'
import { MAX_OPEN_UPLOADS_PER_SESSION, Uploads } from '../src/api/uploads.ts'
import { StagedUpload } from '../src/llm/ref_files.ts'
import { HttpError } from '../src/api/state.ts'
import { createApp, type App } from '../src/main.ts'
import { Client, json } from './api_harness.ts'
import { buggyRepo, testConfig, testSettings } from './harness.ts'
import { tempDir } from './helpers.ts'

const realCreate = StagedUpload.create
let app: App | null = null
afterEach(async () => {
  StagedUpload.create = realCreate
  await app?.close()
  app = null
})

const probe = { name: 'probe.pdf', type: 'application/pdf', size: 10 }
const sessionA = { id: 's_race_a', project_id: 'p_race' } as Session
const sessionB = { id: 's_race_b', project_id: 'p_race' } as Session
const statusOf = (r: PromiseSettledResult<unknown>) => r.status === 'fulfilled' ? 200 : r.reason instanceof HttpError ? r.reason.status : 500
const count = (xs: number[], v: number) => xs.filter((x) => x === v).length

/** StagedUpload.create held at a gate: each call waits until it is released (or failed), then makes its file. */
function gateCreate() {
  const waiting: Array<{ go: () => void; fail: (e: Error) => void }> = []
  StagedUpload.create = (dir: string, id: string) => new Promise<StagedUpload>((resolve, reject) => {
    waiting.push({ go: () => { realCreate.call(StagedUpload, dir, id).then(resolve, reject) }, fail: reject })
  })
  const until = async (n: number) => { for (let i = 0; i < 1000 && waiting.length < n; i++) await new Promise((r) => setTimeout(r, 1)) ; expect(waiting.length).toBeGreaterThanOrEqual(n) }
  return { waiting, until }
}

test('starts made at once in one session: no more than the quota are taken, the rest 429; another session is untouched', async () => {
  const uploads = new Uploads(tempDir('oasis-race-'))
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => uploads.start(sessionA, probe)))
  const statuses = results.map(statusOf)
  expect(count(statuses, 200)).toBe(MAX_OPEN_UPLOADS_PER_SESSION)
  expect(count(statuses, 429)).toBe(20 - MAX_OPEN_UPLOADS_PER_SESSION)
  expect(uploads.open).toBe(MAX_OPEN_UPLOADS_PER_SESSION)
  expect(readdirSync(uploads.dir).length).toBe(MAX_OPEN_UPLOADS_PER_SESSION)
  // the other session has its own quota
  await uploads.start(sessionB, probe)
  expect(uploads.open).toBe(MAX_OPEN_UPLOADS_PER_SESSION + 1)
  await uploads.close()
  expect(uploads.open).toBe(0)
  expect(readdirSync(uploads.dir)).toEqual([])
})

test('a start still making its file holds its place; one whose file cannot be made gives it back', async () => {
  const uploads = new Uploads(tempDir('oasis-race-'))
  const gate = gateCreate()
  const first = Array.from({ length: MAX_OPEN_UPLOADS_PER_SESSION }, () => uploads.start(sessionA, probe).then(() => 200, (e) => statusOf({ status: 'rejected', reason: e })))
  await gate.until(MAX_OPEN_UPLOADS_PER_SESSION)
  // the quota is full of starts under way: one more is refused before it makes anything; another session is not
  // (bounded: before the fix this start was let through to make a 17th file, held at the gate)
  const extra = await Promise.race([uploads.start(sessionA, probe).then(() => 200, (e) => statusOf({ status: 'rejected', reason: e })), Bun.sleep(500).then(() => 'let through')])
  expect(extra).toBe(429)
  expect(gate.waiting.length).toBe(MAX_OPEN_UPLOADS_PER_SESSION)
  const other = uploads.start(sessionB, probe)
  await gate.until(MAX_OPEN_UPLOADS_PER_SESSION + 1)
  // the disk refuses every file of session A: each start fails and its place is given back
  for (const w of gate.waiting.splice(0, MAX_OPEN_UPLOADS_PER_SESSION)) w.fail(Object.assign(new Error('no space'), { code: 'EIO' }))
  expect(await Promise.all(first)).toEqual(Array(MAX_OPEN_UPLOADS_PER_SESSION).fill(500))
  expect(uploads.open).toBe(0)
  gate.waiting.splice(0).forEach((w) => w.go())
  await other
  // with the disk back, session A has its whole quota again
  StagedUpload.create = realCreate
  const again = await Promise.allSettled(Array.from({ length: MAX_OPEN_UPLOADS_PER_SESSION }, () => uploads.start(sessionA, probe)))
  expect(again.map(statusOf)).toEqual(Array(MAX_OPEN_UPLOADS_PER_SESSION).fill(200))
  expect(uploads.open).toBe(MAX_OPEN_UPLOADS_PER_SESSION + 1)
  await uploads.close()
  expect(uploads.open).toBe(0)
  expect(readdirSync(uploads.dir)).toEqual([])
})

test('a close while starts are still making their files: none is left open, no staged file stays, a later start is refused', async () => {
  const uploads = new Uploads(tempDir('oasis-race-'))
  const gate = gateCreate()
  const starts = Promise.allSettled(Array.from({ length: 3 }, () => uploads.start(sessionA, probe)))
  await gate.until(3)
  const closing = uploads.close()
  gate.waiting.splice(0).forEach((w) => w.go())
  await closing
  // the close waited for the starts under way: by now none is open and none left a file
  expect(uploads.open).toBe(0)
  expect(readdirSync(uploads.dir)).toEqual([])
  const results = await starts
  expect(results.map(statusOf)).toEqual([503, 503, 503])
  expect(uploads.open).toBe(0)
  expect(readdirSync(uploads.dir)).toEqual([])
  StagedUpload.create = realCreate
  await expect(uploads.start(sessionA, probe)).rejects.toMatchObject({ status: 503 })
  expect(readdirSync(uploads.dir)).toEqual([])
})

test("the director's repro: a start not yet awaited, then close() — the start is refused and nothing stays open or on disk", async () => {
  const uploads = new Uploads(tempDir('oasis-race-'))
  const opening = uploads.start(sessionA, probe).then(() => true, (e) => statusOf({ status: 'rejected', reason: e }))
  await uploads.close()
  expect(await opening).toBe(503)
  expect(uploads.open).toBe(0)
  expect(readdirSync(uploads.dir)).toEqual([])
})

test('HTTP: 20 POST …/uploads at once take the quota and answer 429 for the rest; a failed file gives its place back; another session starts', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const a = await json<Session>(await c.post(`/api/projects/${project.id}/sessions`, { title: 'a' }))
  const b = await json<Session>(await c.post(`/api/projects/${project.id}/sessions`, { title: 'b' }))
  const start = (s: Session) => c.post(`/api/sessions/${s.id}/uploads`, probe)
  // a file that cannot be made: 500, and nothing counted
  StagedUpload.create = async () => { throw Object.assign(new Error('disk refused'), { code: 'EIO' }) }
  const failed = await Promise.all(Array.from({ length: 4 }, () => start(a)))
  expect(failed.map((r) => r.status)).toEqual([500, 500, 500, 500])
  StagedUpload.create = realCreate
  const res = await Promise.all(Array.from({ length: 20 }, () => start(a)))
  const statuses = res.map((r) => r.status)
  expect(count(statuses, 200)).toBe(MAX_OPEN_UPLOADS_PER_SESSION)
  expect(count(statuses, 429)).toBe(20 - MAX_OPEN_UPLOADS_PER_SESSION)
  const ids = new Set(await Promise.all(res.filter((r) => r.status === 200).map(async (r) => (await r.json() as { upload_id: string }).upload_id)))
  expect(ids.size).toBe(MAX_OPEN_UPLOADS_PER_SESSION)
  expect(readdirSync(`${app.state.settings.data_dir}/uploads`).length).toBe(MAX_OPEN_UPLOADS_PER_SESSION)
  expect((await start(b)).status).toBe(200)
  // one cancelled gives one place back
  const one = [...ids][0]!
  expect((await c.request('DELETE', `/api/sessions/${a.id}/uploads/${one}`)).status).toBe(200)
  expect((await start(a)).status).toBe(200)
  expect((await start(a)).status).toBe(429)
})
