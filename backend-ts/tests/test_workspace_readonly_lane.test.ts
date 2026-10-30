/** The read-only lane of the connector's command route (item 14) end to end: the route runs a read_only command
 *  beside the folder's writer, and the execution layer (executeCommand read_only) holds it to reading — its write to
 *  the folder never lands, or it is refused (409 restriction_unavailable, with its reason and next step) where this
 *  machine cannot enforce it. Never a prefix or a command name: the write here is an ordinary shell redirect.
 *
 *  INTEGRATION: this needs the execution worker's executeCommand read_only enforcement. On the locking branch alone it
 *  fails (the route passes read_only, nothing enforces it yet); with the execution patch merged it passes. */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { App } from '../src/main.ts'
import { Client, HEADERS, json, makeApp } from './api_harness.ts'
import { tempDir } from './helpers.ts'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

const V6 = { ...HEADERS, 'x-oasis-tool-surface': 'director.v6' }

test('a read_only command never writes the folder: held to reading, or refused where that cannot be enforced', async () => {
  const folder = join(tempDir('oasis-ro-'), 'f')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'README.md'), 'x\n')
  app = await makeApp(null, { probe: false })
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: folder, mode: 'direct' }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'look' }))
  expect(session.access_mode).toBe('full')                                       // the session's default: Full access
  const wsId = (session.workspace as Record<string, unknown>).id as string
  const res = await c.post(`/api/workspaces/${wsId}/commands`, { command: 'echo x > wrote.txt', wait_s: 10, read_only: true, access: 'session', session_id: session.id }, V6)
  const body = await res.json() as Record<string, unknown>
  // first of all: nothing was written, whatever the answer
  expect(existsSync(join(folder, 'wrote.txt')), JSON.stringify(body)).toBe(false)
  if (res.status === 409) {
    expect(body.code).toBe('restriction_unavailable')
    expect(String(body.detail)).not.toBe('')
  } else {
    expect(res.status, JSON.stringify(body)).toBe(200)
    expect(body.workspace_lane).toBe('read_only')
    expect(body.exit_code).not.toBe(0)
  }
})
