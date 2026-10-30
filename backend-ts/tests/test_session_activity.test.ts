/** The rail's order is the sessions' latest activity — a run started or finished, words sent, a call to the director —
 *  never a rename, a setting, or what a restart's recovery writes (a run marked lost, a relay or an interaction
 *  interrupted, a director turn failed or swept); equal times keep one order; a deleted session moves nothing; an older
 *  database is filled from its rows by schema v27. Repository level, on databases of the test's own temp folder. */

import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { connect, type Conn } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import * as directorStore from '../src/director/store.ts'
import { tempDir } from './helpers.ts'

const tick = () => Bun.sleep(4)                       // the rows' times are milliseconds: each step a later one

function fixture(): { conn: Conn; projectId: string } {
  const conn = connect(join(tempDir('oasis-activity-'), 'index.db'))
  const project = repo.createProject(conn, 'p', { source_path: null, base_repo_path: '/nowhere', base_commit: null, base_branch: null, import_report: {} })
  return { conn, projectId: project.id }
}

function startRun(conn: Conn, projectId: string, sessionId: string, text = 'hi') {
  return repo.insertRun(conn, { session_id: sessionId, project_id: projectId, workspace_id: null, model: 'm', model_config: {}, user_text: text, status: 'running', budget: {} })
}

function endRun(conn: Conn, runId: string): void {
  repo.finishRun(conn, runId, 'done', { history_json: null, usage: {}, error: null, receipt: {}, saved_seq: 0 })
}

const order = (conn: Conn, projectId: string) => repo.listSessions(conn, projectId).map((s) => s.title)

test('a restart\'s recovery never moves a session up the list: lost runs, interrupted relays and interactions, director turns failed or swept', async () => {
  const { conn, projectId } = fixture()
  try {
    const a = repo.createSession(conn, projectId, 'A', 'm')
    await tick()
    const b = repo.createSession(conn, projectId, 'B', 'm')
    await tick()
    // A: a relay, an interaction and a director turn, all left under way; a run still running when the process died
    const relay = repo.insertRelay(conn, { session_id: a.id, user_text: 'go', participants: [], steps: [], rounds: 1, thinking: null, budget: {}, mentions: [], attachments: [], client_request_id: null })
    const ix = repo.insertInteraction(conn, {
      session_id: a.id, status: 'running', user_text: 'go', participants: [], controller: 'harness' as never, template: null, then: 'stop', budget: { max_runs: 1, concurrency: 1 },
      run_budget: {}, base_checkpoint_id: null, fresh: false, resumes_run_id: null, thinking: null, mentions: [], attachments: [], director_session_id: null, client_request_id: null,
    })
    const ds = directorStore.insertDirectorSession(conn, { session_id: a.id, transport: 'native', model: 'm', label: 'director', config: {} })
    const turn = directorStore.insertTurn(conn, { director_session_id: ds.id, session_id: a.id, kind: 'user', input: 'plan it' })
    directorStore.updateTurn(conn, turn.id, { status: 'generating', started_at: new Date().toISOString() })
    startRun(conn, projectId, a.id, 'the run the restart finds')
    await tick()
    // B: the person's latest real activity — a run started and finished
    const run = startRun(conn, projectId, b.id)
    await tick()
    endRun(conn, run.id)
    expect(order(conn, projectId)).toEqual(['B', 'A'])
    await tick()

    // the restart (runner.reconcile, relay.reconcile, interactions.reconcile, director reconcile write exactly these)
    expect(repo.markDeadRuns(conn).length).toBe(1)
    repo.updateRelay(conn, relay.id, { steps: [] })
    repo.updateRelay(conn, relay.id, { status: 'interrupted', reason: 'the harness restarted', finished_at: null })
    repo.updateInteraction(conn, ix.id, { runs_started: 0 })
    repo.updateInteraction(conn, ix.id, { status: 'interrupted', reason: 'the harness restarted' })
    directorStore.updateTurn(conn, turn.id, { status: 'error', error: 'interrupted: the harness restarted', finished_at: new Date().toISOString() })
    directorStore.insertTurn(conn, { director_session_id: ds.id, session_id: a.id, kind: 'task_event', input: 'run lost' })

    expect(order(conn, projectId)).toEqual(['B', 'A'])
    expect(repo.listProjects(conn).map((p) => p.id)).toEqual([projectId])
  } finally { conn.close() }
})

test('a rename, a model, grants or a workspace change is no activity; a run, words, a call to the director and its answer are', async () => {
  const { conn, projectId } = fixture()
  try {
    const a = repo.createSession(conn, projectId, 'A', 'm')
    await tick()
    const b = repo.createSession(conn, projectId, 'B', 'm')
    await tick()
    expect(order(conn, projectId)).toEqual(['B', 'A'])
    repo.renameSession(conn, a.id, 'A')
    repo.setSessionModel(conn, a.id, 'other')
    repo.setSessionGrants(conn, a.id, a.grants)
    repo.setSessionWorkspace(conn, a.id, 'ws_x')
    repo.touchSession(conn, a.id)
    expect(order(conn, projectId)).toEqual(['B', 'A'])

    await tick()
    const run = startRun(conn, projectId, a.id)                      // a run started
    expect(order(conn, projectId)).toEqual(['A', 'B'])
    await tick()
    startRun(conn, projectId, b.id)
    expect(order(conn, projectId)).toEqual(['B', 'A'])
    await tick()
    endRun(conn, run.id)                                             // a run this process ran to its end
    expect(order(conn, projectId)).toEqual(['A', 'B'])

    await tick()
    const ds = directorStore.insertDirectorSession(conn, { session_id: b.id, transport: 'native', model: 'm', label: 'director', config: {} })
    expect(order(conn, projectId)).toEqual(['A', 'B'])               // opening a director is no call to it
    const report = directorStore.insertTurn(conn, { director_session_id: ds.id, session_id: b.id, kind: 'task_event', input: 'a run ended' })
    repo.insertDirectorNote(conn, b.id, { source: 'director', model: 'm', question: '', answer: 'noted', turn_id: report.id })
    expect(order(conn, projectId)).toEqual(['A', 'B'])               // the harness's own report and its answer
    await tick()
    const call = directorStore.insertTurn(conn, { director_session_id: ds.id, session_id: b.id, kind: 'user', input: 'what next?' })
    expect(order(conn, projectId)).toEqual(['B', 'A'])               // the person's call
    await tick()
    startRun(conn, projectId, a.id)
    await tick()
    repo.insertDirectorNote(conn, b.id, { source: 'director', model: 'm', question: 'what next?', answer: 'this', turn_id: call.id })
    expect(order(conn, projectId)).toEqual(['B', 'A'])               // its answer
    await tick()
    startRun(conn, projectId, a.id)
    await tick()
    repo.insertDirectorNote(conn, b.id, { source: 'ChatGPT', model: '', question: '', answer: 'mirrored', turn_id: null })
    expect(order(conn, projectId)).toEqual(['B', 'A'])               // a note a director mirrored itself

    // a message to a group or to agents in turn, before any of its runs starts
    await tick()
    repo.insertInteraction(conn, {
      session_id: a.id, status: 'planning', user_text: 'plan it', participants: [], controller: 'harness' as never, template: null, then: 'stop', budget: { max_runs: 1, concurrency: 1 },
      run_budget: {}, base_checkpoint_id: null, fresh: false, resumes_run_id: null, thinking: null, mentions: [], attachments: [], director_session_id: null, client_request_id: null,
    })
    expect(order(conn, projectId)).toEqual(['A', 'B'])
    await tick()
    repo.insertRelay(conn, { session_id: b.id, user_text: 'take turns', participants: [], steps: [], rounds: 1, thinking: null, budget: {}, mentions: [], attachments: [], client_request_id: null })
    expect(order(conn, projectId)).toEqual(['B', 'A'])

    const sessions = repo.listSessions(conn, projectId)
    for (const s of sessions) expect(s.last_activity_at! >= s.created_at).toBe(true)
  } finally { conn.close() }
})

test('equal activity times keep one order (the later made first, then by id), the same on every read', async () => {
  const { conn, projectId } = fixture()
  try {
    const made = []
    for (let i = 0; i < 6; i++) { made.push(repo.createSession(conn, projectId, `S${i}`, 'm')); if (i % 2) await tick() }
    conn.run("UPDATE sessions SET last_activity_at='2026-10-01T00:00:00.000Z'")
    const first = order(conn, projectId)
    const expected = [...made].sort((x, y) => (y.created_at.localeCompare(x.created_at)) || (y.id.localeCompare(x.id))).map((s) => s.title)
    expect(first).toEqual(expected)
    for (let i = 0; i < 20; i++) expect(order(conn, projectId)).toEqual(first)
  } finally { conn.close() }
})

test('a deleted session takes no activity and moves its project nowhere; a project without sessions stands at its making', async () => {
  const { conn, projectId } = fixture()
  try {
    const kept = repo.createSession(conn, projectId, 'kept', 'm')
    await tick()
    const other = repo.createProject(conn, 'q', { source_path: null, base_repo_path: '/elsewhere', base_commit: null, base_branch: null, import_report: {} })
    await tick()
    const gone = repo.createSession(conn, projectId, 'gone', 'm')
    repo.deleteSession(conn, gone.id)
    const before = repo.getProject(conn, projectId)!.last_activity_at
    expect(before).toBe(kept.last_activity_at!)
    expect(repo.listProjects(conn).map((p) => p.id)).toEqual([other.id, projectId])
    await tick()
    const run = startRun(conn, projectId, gone.id)                   // a run of the deleted one ending late
    endRun(conn, run.id)
    expect(repo.getSession(conn, gone.id)!.last_activity_at).toBe(gone.last_activity_at!)
    expect(repo.getProject(conn, projectId)!.last_activity_at).toBe(before)
    expect(repo.listProjects(conn).map((p) => p.id)).toEqual([other.id, projectId])
    await tick()
    startRun(conn, projectId, kept.id)
    expect(repo.listProjects(conn).map((p) => p.id)).toEqual([projectId, other.id])
  } finally { conn.close() }
})

test('schema v27 fills an older database from its rows: never from the finish a restart wrote, nor a task report\'s answer; twice is a no-op', () => {
  const base = tempDir('oasis-activity-v26-')
  const path = join(base, 'index.db')
  const made = connect(path)
  // the database as v26 left it: no last_activity_at, its index gone, the version said
  made.exec('DROP INDEX sessions_by_activity')
  made.exec('ALTER TABLE sessions DROP COLUMN last_activity_at')
  made.exec('PRAGMA user_version = 26')
  const at = (m: number) => `2026-10-0${m}T00:00:00.000Z`
  made.run("INSERT INTO projects (id, name, base_repo_path, created_at, updated_at) VALUES ('p_1','p','/x',?,?)", [at(1), at(9)])
  for (const [id, title, created, updated, status] of [['s_a', 'A', at(1), at(9), 'open'], ['s_b', 'B', at(1), at(5), 'open'], ['s_c', 'C', at(1), at(8), 'deleted'], ['s_d', 'D', at(2), at(2), 'open']]) {
    made.run('INSERT INTO sessions (id, project_id, title, model, created_at, updated_at, status) VALUES (?,?,?,?,?,?,?)', [id!, 'p_1', title!, 'm', created!, updated!, status!])
  }
  const run = (id: string, session: string, created: string, finished: string | null, error: string | null) =>
    made.run("INSERT INTO runs (id, session_id, project_id, model, user_text, status, created_at, finished_at, error) VALUES (?,?,'p_1','m','x',?,?,?,?)", [id, session, error ? 'error' : 'done', created, finished, error])
  run('run_a', 's_a', at(2), at(9), repo.LOST_RUN_ERROR)            // A: started on the 2nd, found lost by the restart of the 9th
  run('run_b', 's_b', at(3), at(4), null)                            // B: ran on the 3rd to the 4th
  run('run_c', 's_c', at(7), at(8), null)                            // C: deleted, its run the latest
  made.run("INSERT INTO run_events (run_id, seq, event, data_json, created_at) VALUES ('run_a', 1, 'steer_queued', '{}', ?)", [at(3)])
  made.run("INSERT INTO relays (id, session_id, status, user_text, participants_json, steps_json, rounds, round, current_step, created_at, updated_at, finished_at) VALUES ('relay_d','s_d','interrupted','x','[]','[]',1,1,0,?,?,?)", [at(1), at(9), at(9)])
  made.run("INSERT INTO director_sessions (id, session_id, transport, model, label, state, config_json, created_at, updated_at) VALUES ('dir_1','s_d','native','m','d','idle','{}',?,?)", [at(2), at(2)])
  made.run("INSERT INTO director_turns (id, director_session_id, session_id, seq, kind, input, status, created_at) VALUES ('turn_r','dir_1','s_d',1,'task_event','x','done',?)", [at(6)])
  made.run("INSERT INTO director_notes (id, session_id, source, answer, created_at, turn_id) VALUES ('note_r','s_d','d','report answered',?, 'turn_r')", [at(6)])
  made.close()

  const conn = connect(path)
  try {
    const of = (id: string) => conn.get('SELECT last_activity_at FROM sessions WHERE id=?', [id])!.last_activity_at
    expect(of('s_a')).toBe(at(3))                                    // its steer, not the restart's finish of the 9th
    expect(of('s_b')).toBe(at(4))
    expect(of('s_c')).toBe(at(8))
    expect(of('s_d')).toBe(at(2))                                    // its making: the report's answer is no activity
    expect(repo.listSessions(conn, 'p_1').map((s) => s.title)).toEqual(['B', 'A', 'D'])
    expect(repo.getProject(conn, 'p_1')!.last_activity_at).toBe(at(4))   // the deleted session's run is not the project's
    expect(repo.backfillSessionActivity(conn)).toBe(0)
  } finally { conn.close() }
})

test('a run the harness cancelled as it shut down (receipt.interrupted) moves no session; the person\'s Stop does', async () => {
  const { conn, projectId } = fixture()
  try {
    const a = repo.createSession(conn, projectId, 'A', 'm')
    await tick()
    const b = repo.createSession(conn, projectId, 'B', 'm')
    const stopped = startRun(conn, projectId, a.id, 'still running when the app quits')
    await tick()
    startRun(conn, projectId, b.id)
    await tick()
    expect(order(conn, projectId)).toEqual(['B', 'A'])
    // the app quits: the runner cancels A's run and marks its receipt (the same statement as its status and finished_at)
    repo.finishRun(conn, stopped.id, 'cancelled', { history_json: null, usage: {}, error: null, receipt: { interrupted: true }, saved_seq: 0 })
    expect(repo.getRun(conn, stopped.id)!.receipt).toMatchObject({ interrupted: true })
    expect(order(conn, projectId)).toEqual(['B', 'A'])
    // the person's Stop: no mark, it is activity
    await tick()
    const second = startRun(conn, projectId, b.id)
    await tick()
    startRun(conn, projectId, a.id)
    await tick()
    expect(order(conn, projectId)).toEqual(['A', 'B'])
    await tick()
    repo.finishRun(conn, second.id, 'cancelled', { history_json: null, usage: {}, error: null, receipt: {}, saved_seq: 0 })
    expect(order(conn, projectId)).toEqual(['B', 'A'])
  } finally { conn.close() }
})

test('the v27 fill leaves out a finish the harness\'s shutdown wrote (receipt.interrupted) and keeps an unmarked cancel', () => {
  const path = join(tempDir('oasis-activity-shutdown-'), 'index.db')
  const made = connect(path)
  made.exec('DROP INDEX sessions_by_activity')
  made.exec('ALTER TABLE sessions DROP COLUMN last_activity_at')
  made.exec('PRAGMA user_version = 26')
  const at = (d: number) => `2026-10-0${d}T00:00:00.000Z`
  made.run("INSERT INTO projects (id, name, base_repo_path, created_at, updated_at) VALUES ('p_1','p','/x',?,?)", [at(1), at(1)])
  for (const id of ['s_a', 's_b']) made.run("INSERT INTO sessions (id, project_id, title, model, created_at, updated_at) VALUES (?,'p_1',?,'m',?,?)", [id, id, at(1), at(9)])
  const run = (id: string, session: string, created: number, finished: number, receipt: string) =>
    made.run("INSERT INTO runs (id, session_id, project_id, model, user_text, status, created_at, finished_at, receipt_json) VALUES (?,?,'p_1','m','x','cancelled',?,?,?)", [id, session, at(created), at(finished), receipt])
  run('run_a', 's_a', 2, 8, '{"interrupted":true}')                  // A: cancelled by the quit on the 8th
  run('run_b', 's_b', 3, 5, '{}')                                    // B: stopped by the person on the 5th
  made.close()
  const filled = connect(path)
  try {
    expect(filled.get("SELECT last_activity_at AS t FROM sessions WHERE id='s_a'")!.t).toBe(at(2))
    expect(filled.get("SELECT last_activity_at AS t FROM sessions WHERE id='s_b'")!.t).toBe(at(5))
    expect(repo.listSessions(filled, 'p_1').map((s) => s.id)).toEqual(['s_b', 's_a'])
  } finally { filled.close() }
})
