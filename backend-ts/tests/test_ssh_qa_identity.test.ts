/** Behavioral regressions runnable on the pre-SSH baseline: no new product imports.
 * The old ImportBodySchema strips target, then imports a local folder. A remote request
 * must never silently succeed against the same-looking local path. */
import { afterEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { tempDir } from './helpers.ts'

let app: App | undefined
afterEach(async () => { await app?.close(); app = undefined })

test('remote identity: unknown target must reject rather than silently import an existing LOCAL directory', async () => {
  app = await makeApp()
  const c = new Client(app, { ip: '127.0.0.1' })
  const local = tempDir('qa-local-not-remote-')
  writeFileSync(join(local, 'sentinel.txt'), 'LOCAL_MUST_STAY_LOCAL')
  const response = await c.post('/api/projects', { source_path: local, mode: 'direct', target: { kind: 'ssh', target_id: 'qa-unknown-target' } })
  const body = await response.json()
  expect(response.status, `must refuse unknown remote target, not local success: ${JSON.stringify(body)}`).toBeGreaterThanOrEqual(400)
  const projects = await json<Array<Record<string, unknown>>>(await c.get('/api/projects'))
  expect(projects).toHaveLength(0)
  expect(readFileSync(join(local, 'sentinel.txt'), 'utf8')).toBe('LOCAL_MUST_STAY_LOCAL')
})

test('remote identity: invalid target kind must not be stripped and treated as local', async () => {
  app = await makeApp()
  const c = new Client(app, { ip: '127.0.0.1' })
  const local = tempDir('qa-invalid-target-')
  writeFileSync(join(local, 'sentinel.txt'), 'LOCAL')
  const response = await c.post('/api/projects', { source_path: local, mode: 'direct', target: { kind: 'ssh_typo', target_id: 'qa-target' } })
  expect(response.status).toBeGreaterThanOrEqual(400)
  expect(await json<unknown[]>(await c.get('/api/projects'))).toEqual([])
})

test('local project persists an explicit local target rather than relying on path inference', async () => {
  app = await makeApp()
  const c = new Client(app, { ip: '127.0.0.1' })
  const local = tempDir('qa-explicit-local-')
  writeFileSync(join(local, 'sentinel.txt'), 'LOCAL')
  const response = await c.post('/api/projects', { source_path: local, mode: 'direct' })
  expect(response.ok).toBe(true)
  const project = await response.json() as { id: string; target?: unknown }
  expect(project.target).toEqual({ kind: 'local' })
  const persisted = await json(await c.get(`/api/projects/${project.id}`))
  expect(persisted.target).toEqual({ kind: 'local' })
})
