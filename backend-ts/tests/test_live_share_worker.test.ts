/** The projector thread's lifecycle (src/share/live/projector.ts WorkerProjector): a missing or broken worker file, a
 *  thread that never answers (timeout), a thread that cannot open its database — each answers as failed, never throws
 *  at the caller, and the next question starts a fresh thread. Synthetic worker files in a temporary folder. */

import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { WorkerProjector, projectorWorkerEntry } from '../src/share/live/projector.ts'
import type { ProjectorInit, ProjectRequest } from '../src/share/live/projector_core.ts'
import { tempDir } from './helpers.ts'

const INIT: ProjectorInit = { db_path: '/nonexistent/live-share-test/index.db', assets_dir: '/nonexistent/live-share-test/assets', data_dir: '/nonexistent/live-share-test', workspaces_dir: '/nonexistent/live-share-test/ws', session_token: 'synthetic', models: [], default_model: null }
const REQ: ProjectRequest = { session_id: 's_x', options: { include_tool_details: false, include_images: false, exclude_run_ids: [] }, salt: 'x', runs: [], max_bytes: 1024 }

function workerFile(body: string): string {
  const path = join(tempDir('oasis-live-worker-'), 'w.ts')
  writeFileSync(path, body)
  return path
}

test('no worker file in the build: answers failed, says why', async () => {
  const p = new WorkerProjector(() => INIT, { entry: null })
  expect(await p.project(REQ)).toEqual({ ok: false, code: 'error' })
  expect(await p.image({ session_id: 's', asset_id: 'a', resource: 'm' + '0'.repeat(24), salt: 'x' })).toEqual({ ok: false })
  expect(p.failed).toContain('not in this build')
})

test('a worker that throws when it loads, or a missing file: the question answers failed, the next starts a new thread', async () => {
  for (const entry of [workerFile('throw new Error("boom at load")\n'), '/nonexistent/live-share-test/worker.ts']) {
    const p = new WorkerProjector(() => INIT, { entry, project_timeout_ms: 3000 })
    expect(await p.project(REQ)).toEqual({ ok: false, code: 'error' })
    expect(p.running).toBe(false)
    expect(await p.project(REQ)).toEqual({ ok: false, code: 'error' })
    await p.close()
  }
})

test('a thread that never answers is stopped at its timeout; another thread\'s questions are not failed by it', async () => {
  const entry = workerFile('self.onmessage = () => {}\n')
  const p = new WorkerProjector(() => INIT, { entry, project_timeout_ms: 150 })
  const started = Date.now()
  expect(await p.project(REQ)).toEqual({ ok: false, code: 'error' })
  expect(Date.now() - started).toBeLessThan(2000)
  expect(p.running).toBe(false)
  // a question to the next thread, then a late stop of nothing: it still waits for its own thread's timeout
  const second = p.project(REQ)
  expect(p.running).toBe(true)
  expect(await second).toEqual({ ok: false, code: 'error' })
  await p.close()
  expect(p.running).toBe(false)
})

test('the real worker with a database it cannot open answers failed (no error text); the entry resolves in this build', async () => {
  expect(projectorWorkerEntry()).not.toBeNull()
  const p = new WorkerProjector(() => INIT, { project_timeout_ms: 10_000 })
  const reply = await p.project(REQ)
  expect(reply).toEqual({ ok: false, code: 'error' })
  expect(JSON.stringify(reply)).not.toContain('nonexistent')
  await p.close()
})
