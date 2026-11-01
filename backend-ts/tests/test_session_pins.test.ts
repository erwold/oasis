/** Pins on real temporary databases: append order, no activity, concurrent writers, migration and HTTP bounds. */
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionSchema } from '@oasis-code/contract'
import { connect, SCHEMA_VERSION, type Conn } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { tempDir } from './helpers.ts'

function fixture(conn: Conn) {
  const project = repo.createProject(conn, 'folder', { source_path: null, base_repo_path: '/nowhere', base_commit: null, base_branch: null, import_report: {} })
  return ['A', 'B', 'C'].map((title) => repo.createSession(conn, project.id, title, 'm'))
}
const pin = (conn: Conn, id: string) => repo.getSession(conn, id)!.pin_order
function cleanupWorks(conn: Conn, id: string) {
  expect(conn.get("SELECT name FROM sqlite_master WHERE type='trigger' AND name='sessions_clear_pin'")).not.toBeNull()
  repo.setSessionPinned(conn, id, true)
  expect(pin(conn, id)).toBeGreaterThan(0)
  conn.run("UPDATE sessions SET status='archived' WHERE id=?", [id])
  expect(pin(conn, id)).toBeNull()
  repo.setSessionPinned(conn, id, true)
  expect(pin(conn, id)).toBeNull()
  conn.run("UPDATE sessions SET status='open' WHERE id=?", [id])
  expect(pin(conn, id)).toBeNull()
  repo.setSessionPinned(conn, id, true)
  repo.deleteSession(conn, id)
  expect(pin(conn, id)).toBeNull()
  expect(repo.listSessions(conn, repo.getSession(conn, id)!.project_id).some((s) => s.id === id)).toBe(false)
}

test('pin/unpin is idempotent, appends on re-pin and never changes timestamps or normal ordering; persists across connections', () => {
  const path = join(tempDir('pins-'), 'index.db')
  let conn = connect(path)
  try {
    const [a, b, c] = fixture(conn)
    const before = repo.listSessions(conn, a!.project_id)
    repo.setSessionPinned(conn, a!.id, true)
    const first = pin(conn, a!.id)
    repo.setSessionPinned(conn, b!.id, true)
    repo.setSessionPinned(conn, a!.id, true)
    expect(pin(conn, a!.id)).toBe(first)
    expect(pin(conn, b!.id)).toBeGreaterThan(first!)
    repo.setSessionPinned(conn, a!.id, false)
    repo.setSessionPinned(conn, a!.id, false)
    expect(pin(conn, a!.id)).toBeNull()
    repo.setSessionPinned(conn, a!.id, true)
    expect(pin(conn, a!.id)).toBeGreaterThan(pin(conn, b!.id)!)
    expect(repo.listSessions(conn, a!.project_id).map(({ pin_order: _, ...s }) => s)).toEqual(before.map(({ pin_order: _, ...s }) => s))
    const saved = repo.listSessions(conn, a!.project_id)
    conn.close(); conn = connect(path)
    expect(repo.listSessions(conn, a!.project_id)).toEqual(saved)
    cleanupWorks(conn, c!.id)
    // Compatibility with a response from before v36.
    const { pin_order: _, ...old } = a!
    expect(SessionSchema.parse(old).pin_order).toBeUndefined()
  } finally { conn.close() }
})

test('independent SQLite writers allocate unique stable positions atomically', async () => {
  const path = join(tempDir('pins-concurrent-'), 'index.db')
  const conn = connect(path)
  try {
    const sessions = fixture(conn)
    const module = new URL('../src/db/repo.ts', import.meta.url).href
    const database = new URL('../src/db/database.ts', import.meta.url).href
    const children = sessions.map((s) => Bun.spawn([process.execPath, '-e', `import { connect } from ${JSON.stringify(database)}; import { setSessionPinned } from ${JSON.stringify(module)}; const c=connect(${JSON.stringify(path)}); for(let i=0;i<30;i++) setSessionPinned(c,${JSON.stringify(s.id)},true); c.close()`], { stdout: 'pipe', stderr: 'pipe' }))
    for (const child of children) {
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
    }
    const orders = sessions.map((s) => pin(conn, s.id)!)
    expect(new Set(orders).size).toBe(sessions.length)
    expect([...orders].sort()).toEqual([1, 2, 3])
    for (const s of sessions) repo.setSessionPinned(conn, s.id, true)
    expect(sessions.map((s) => pin(conn, s.id))).toEqual(orders)
  } finally { conn.close() }
})

for (const partial of [false, true]) test(`v35 migration preserves every old row and installs cleanup (existing pin column: ${partial})`, () => {
  const path = join(tempDir('pins-upgrade-'), 'index.db')
  // The v35 schema, not a current DB with the version merely changed.
  const schema = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8').split('-- schema v36:')[0]!
  const raw = new Database(path)
  raw.exec(schema)
  raw.exec('PRAGMA user_version=35')
  raw.run("INSERT INTO projects(id,name,base_repo_path,created_at,updated_at) VALUES ('p','old','/tmp','2026-01-01','2026-01-02')")
  raw.run("INSERT INTO sessions(id,project_id,title,model,created_at,updated_at,last_activity_at) VALUES ('s','p','old','m','2026-01-01','2026-01-02','2026-01-01')")
  if (partial) {
    raw.exec('ALTER TABLE sessions ADD COLUMN pin_order INTEGER CHECK (pin_order > 0)')
    raw.run('UPDATE sessions SET pin_order=42')
  }
  const old = raw.query('SELECT * FROM sessions').get() as Record<string, unknown>
  raw.close()
  let conn = connect(path)
  try {
    expect(conn.get('PRAGMA user_version')!.user_version).toBe(SCHEMA_VERSION)
    const { pin_order, ...rest } = conn.get('SELECT * FROM sessions')!
    const { pin_order: _, ...oldRest } = old
    expect(rest).toEqual(oldRest)
    expect(pin_order).toBe(partial ? 42 : null)
    // Rewinding a test DB with the new index/trigger/column is harmless and keeps its pin values.
    conn.exec('PRAGMA user_version=35')
    conn.close(); conn = connect(path)
    expect(pin(conn, 's')).toBe(partial ? 42 : null)
    cleanupWorks(conn, 's')
  } finally { conn.close() }
})

test('HTTP pin reads/writes, auth, validation, not-found, non-open conflicts and deletion cleanup', async () => {
  const app = await makeApp()
  try {
    const c = new Client(app)
    const [a] = fixture(app.state.conn)
    const path = `/api/sessions/${a!.id}/pin`
    expect((await new Client(app, { headers: {} }).put(path, { pinned: true })).status).toBe(401)
    expect((await c.put(path, { pinned: true }, { origin: 'https://evil.invalid' })).status).toBe(403)
    for (const body of [{}, { pinned: 'true' }, { pinned: 1 }, { pinned: null }, { pinned: true, pin_order: 999 }]) {
      expect((await c.put(path, body)).status).toBe(422)
    }
    expect((await c.put('/api/sessions/missing/pin', { pinned: true })).status).toBe(404)
    const first = await json(await c.put(path, { pinned: true }))
    expect(first.pin_order).toBeGreaterThan(0)
    expect((await json(await c.put(path, { pinned: true }))).pin_order).toBe(first.pin_order)
    expect((await json(await c.get(`/api/sessions/${a!.id}`))).pin_order).toBe(first.pin_order)
    const projects = await json<any[]>(await c.get('/api/projects'))
    expect(projects.find((p) => p.id === a!.project_id).sessions.find((s: any) => s.id === a!.id).pin_order).toBe(first.pin_order)
    expect((await json(await c.put(path, { pinned: false }))).pin_order).toBeNull()
    expect((await json(await c.put(path, { pinned: false }))).pin_order).toBeNull()
    await c.put(path, { pinned: true })
    app.state.conn.run("UPDATE sessions SET status='archived' WHERE id=?", [a!.id])
    expect(pin(app.state.conn, a!.id)).toBeNull()
    expect((await c.put(path, { pinned: true })).status).toBe(409)
    expect((await json(await c.put(path, { pinned: false }))).pin_order).toBeNull()
    app.state.conn.run("UPDATE sessions SET status='open' WHERE id=?", [a!.id])
    expect((await json(await c.get(`/api/sessions/${a!.id}`))).pin_order).toBeNull()
    await c.put(path, { pinned: true })
    await json(await c.delete(`/api/sessions/${a!.id}`))
    expect(pin(app.state.conn, a!.id)).toBeNull()
    expect((await c.put(path, { pinned: true })).status).toBe(404)
  } finally { await app.close() }
})
