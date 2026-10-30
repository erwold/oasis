/** Independent remote/local confusion regressions. Real API, DB and mkdtemp sentinel;
 * no SSH, listener, provider call, production path or imported remote module required.
 * These intentionally fail on e8274e6: a remote target must never be stripped into local.
 */
import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { tempDir } from './helpers.ts'

let app: App | null = null
afterEach(async () => { await app?.close(); app = null })

async function fixture() {
  const root = tempDir('oasis-ssh-review-sentinel-')
  writeFileSync(join(root, 'sentinel.txt'), 'LOCAL ONLY — 远端不可接管\n')
  app = await makeApp()
  return { root, client: new Client(app) }
}

async function mustRejectWithoutLocalProject(client: Client, body: Record<string, unknown>, root: string) {
  const before = await json<unknown[]>(await client.get('/api/projects'))
  const response = await client.post('/api/projects', body)
  const reply = await response.json() as Record<string, unknown>
  const after = await json<unknown[]>(await client.get('/api/projects'))
  // Print only test-owned paths/IDs; useful old-fail evidence even when a status assertion fails.
  const evidence = JSON.stringify({ status: response.status, reply, projects_before: before.length, projects_after: after.length })
  expect({
    rejected: response.status >= 400 && response.status < 500,
    projects: after,
    sentinel: readFileSync(join(root, 'sentinel.txt'), 'utf8'),
    entries: readdirSync(root).sort(),
  }, evidence).toEqual({
    rejected: true, projects: before,
    sentinel: 'LOCAL ONLY — 远端不可接管\n', entries: ['sentinel.txt'],
  })
}

test('ssh review: unknown SSH target never opens the coincident real local directory', async () => {
  const { root, client } = await fixture()
  await mustRejectWithoutLocalProject(client, {
    target: { kind: 'ssh', target_id: 'ssh_review_unknown' }, source_path: root, mode: 'direct',
  }, root)
})

test('ssh review: malformed SSH identity cannot default to local', async () => {
  const { root, client } = await fixture()
  await mustRejectWithoutLocalProject(client, { target: { kind: 'ssh' }, source_path: root, mode: 'direct' }, root)
})

test('ssh review: unknown target kind cannot default to local', async () => {
  const { root, client } = await fixture()
  await mustRejectWithoutLocalProject(client, { target: { kind: 'ssh_typo', target_id: 'ssh_review_unknown' }, source_path: root, mode: 'direct' }, root)
})

test('ssh review: remote create_directory must not mkdir a local namesake', async () => {
  const { root, client } = await fixture()
  const child = join(root, 'must-not-exist')
  expect(existsSync(child)).toBe(false)
  await mustRejectWithoutLocalProject(client, {
    target: { kind: 'ssh', target_id: 'ssh_review_unknown' }, source_path: child, mode: 'direct', create_directory: true,
  }, root)
  expect(existsSync(child)).toBe(false)
})

test('ssh review: remote target validation precedes the local no_folder shortcut', async () => {
  const { root, client } = await fixture()
  await mustRejectWithoutLocalProject(client, { target: { kind: 'ssh', target_id: 'ssh_review_unknown' }, no_folder: true }, root)
})

test('ssh review: cached local client_request_id cannot satisfy an SSH request', async () => {
  const { root, client } = await fixture()
  const key = 'ssh-review-local-request'
  const local = await json(await client.post('/api/projects', { source_path: root, mode: 'direct', client_request_id: key }))
  expect(local.source_path).toBe(root)
  await mustRejectWithoutLocalProject(client, {
    target: { kind: 'ssh', target_id: 'ssh_review_unknown' }, source_path: root, mode: 'direct', client_request_id: key,
  }, root)
})

test('ssh review: legacy target-omitted local direct import still works', async () => {
  const { root, client } = await fixture()
  const project = await json(await client.post('/api/projects', { source_path: root, mode: 'direct' }))
  expect(project.source_path).toBe(root)
  expect(project.kind).toBe('direct')
  expect(readFileSync(join(root, 'sentinel.txt'), 'utf8')).toBe('LOCAL ONLY — 远端不可接管\n')
})
