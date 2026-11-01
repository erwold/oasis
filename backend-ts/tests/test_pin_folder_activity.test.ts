/** Pinned activity remains session activity, but never folder activity. Only temporary databases. */
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { connect, type Conn } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import * as director from '../src/director/store.ts'
import { tempDir } from './helpers.ts'
import { Client, json, makeApp } from './api_harness.ts'

const at = (day: number) => `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`
function fixture(conn: Conn) {
  const folder = (name: string) => repo.createProject(conn, name, { source_path: null, base_repo_path: '/unused', base_commit: null, base_branch: null, import_report: {} })
  const a = folder('No folder'), b = folder('B'), empty = folder('empty')
  const pinned = repo.createSession(conn, a.id, 'pin', 'm'), quiet = repo.createSession(conn, a.id, 'quiet', 'm')
  const other = repo.createSession(conn, b.id, 'other', 'm')
  conn.run('UPDATE projects SET created_at=?, updated_at=?', [at(1), at(1)])
  conn.run('UPDATE sessions SET created_at=?, updated_at=?, last_activity_at=?', [at(1), at(2), at(2)])
  conn.run('UPDATE sessions SET last_activity_at=? WHERE id=?', [at(3), other.id])
  repo.setSessionPinned(conn, pinned.id, true)
  return { a, b, empty, pinned, quiet, other }
}
const run = (c: Conn, s: ReturnType<typeof repo.createSession>) => repo.insertRun(c, { session_id: s.id, project_id: s.project_id, workspace_id: null, model: 'm', model_config: {}, user_text: 'hi', status: 'running', budget: {} })
const interaction = (c: Conn, id: string) => repo.insertInteraction(c, {
  session_id: id, status: 'planning', user_text: 'hi', participants: [], controller: 'harness' as never, template: null, then: 'stop', budget: { max_runs: 1, concurrency: 1 },
  run_budget: {}, base_checkpoint_id: null, fresh: false, resumes_run_id: null, thinking: null, mentions: [], attachments: [], director_session_id: null, client_request_id: null,
})
type Session = ReturnType<typeof repo.createSession>
const actions: Record<string, (c: Conn, s: Session) => void> = {
  'run starts': (c, s) => { run(c, s) },
  'run finishes': (c, s) => { const r = run(c, s); repo.finishRun(c, r.id, 'done', { history_json: null, usage: {}, error: null, receipt: {}, saved_seq: 0 }) },
  'steer activity': (c, s) => { repo.noteSessionActivity(c, s.id, new Date().toISOString()) },
  'relay message': (c, s) => { repo.insertRelay(c, { session_id: s.id, user_text: 'hi', participants: [], steps: [], rounds: 1, thinking: null, budget: {}, mentions: [], attachments: [], client_request_id: null }) },
  'interaction message': (c, s) => { interaction(c, s.id) },
  'interaction note': (c, s) => { const i = interaction(c, s.id); repo.insertInteractionNote(c, { interaction_id: i.id, to: 'all', text: 'more' }) },
  'director call': (c, s) => { const d = director.insertDirectorSession(c, { session_id: s.id, transport: 'native', model: 'm', label: 'director', config: {} }); director.insertTurn(c, { director_session_id: d.id, session_id: s.id, kind: 'user', input: 'hi' }) },
  'director answer': (c, s) => { repo.insertDirectorNote(c, s.id, { source: 'director', model: 'm', question: 'hi', answer: 'done' }) },
}
for (const [name, act] of Object.entries(actions)) test(`pinned ${name} advances only the session; unpin immediately restores folder activity`, () => {
  const conn = connect(join(tempDir('pin-folder-'), 'index.db'))
  try {
    const { a, b, empty, pinned } = fixture(conn)
    act(conn, pinned)
    const active = repo.getSession(conn, pinned.id)!
    expect(active.last_activity_at! > at(3)).toBe(true)
    expect(active.pin_order).toBe(1)
    expect(repo.getProject(conn, a.id)!.last_activity_at).toBe(at(2))
    expect(repo.listProjects(conn).map((p) => p.id)).toEqual([b.id, a.id, empty.id])
    repo.setSessionPinned(conn, pinned.id, false)
    expect(repo.getProject(conn, a.id)!.last_activity_at).toBe(active.last_activity_at!)
    expect(repo.listProjects(conn)[0]!.id).toBe(a.id)
    expect(repo.getSession(conn, pinned.id)!.last_activity_at).toBe(active.last_activity_at!)
  } finally { conn.close() }
})

test('reads discard prior pin activity, all-pinned and empty folders use creation, archive restores participation, reopen needs no backfill', () => {
  const path = join(tempDir('pin-folder-reopen-'), 'index.db')
  let conn = connect(path)
  try {
    const { a, b, empty, pinned, quiet } = fixture(conn)
    // Existing activity and updated_at from before pinning must not leak back through a fallback.
    repo.noteSessionActivity(conn, pinned.id, at(9)); repo.touchSession(conn, pinned.id)
    repo.setSessionPinned(conn, quiet.id, true)
    expect(repo.getProject(conn, a.id)!.last_activity_at).toBe(at(1))
    expect(repo.getProject(conn, empty.id)!.last_activity_at).toBe(at(1))
    conn.close(); conn = connect(path)
    expect(conn.get('PRAGMA user_version')!.user_version).toBe(37)
    expect(repo.getProject(conn, a.id)!.last_activity_at).toBe(at(1))
    expect(repo.listProjects(conn)[0]!.id).toBe(b.id)
    conn.run("UPDATE sessions SET status='archived' WHERE id=?", [pinned.id])
    expect(repo.getSession(conn, pinned.id)!.pin_order).toBeNull()
    expect(repo.getProject(conn, a.id)!.last_activity_at).toBe(at(9))
    repo.deleteSession(conn, pinned.id)
    expect(repo.getProject(conn, a.id)!.last_activity_at).toBe(at(1))
  } finally { conn.close() }
})

test('HTTP project reads and pin/unpin refresh physical folder activity, including cross-folder task members', async () => {
  const app = await makeApp()
  try {
    const c = new Client(app), conn = app.state.conn
    const { a, b, pinned, other } = fixture(conn)
    repo.setSessionTask(conn, pinned.id, other.id)
    repo.noteSessionActivity(conn, pinned.id, at(9))
    const projects = () => c.get('/api/projects').then((r) => json<any[]>(r))
    let rows = await projects()
    expect(rows[0].id).toBe(b.id)
    expect(rows.find((p) => p.id === a.id).last_activity_at).toBe(at(2))
    expect(rows.find((p) => p.id === b.id).last_activity_at).toBe(at(3))
    expect((await c.put(`/api/sessions/${pinned.id}/pin`, { pinned: false })).status).toBe(200)
    rows = await projects()
    expect(rows[0].id).toBe(a.id)
    expect(rows[0].last_activity_at).toBe(at(9))
    expect((await c.put(`/api/sessions/${pinned.id}/pin`, { pinned: true })).status).toBe(200)
    expect((await projects())[0].id).toBe(b.id)
  } finally { await app.close() }
})
