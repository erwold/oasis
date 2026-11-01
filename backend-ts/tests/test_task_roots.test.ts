/** A task across sessions and folders (schema v29): a session joins another session's task (task_root_id, any
 *  project); a session reaches folders besides its working folder (roots, each read or write) — by absolute path, for the
 *  file tools and for commands alike, read-only in an isolated copy, never written by a Full access command the kernel
 *  cannot hold to them; director.v6 opens a folder by path and kind, makes one on request, opens the project of tasks
 *  without a folder, joins a task and names roots, hands over another session's ended run with where it came from,
 *  asks for a read-only command and reads what a queued run waits for; a checkpoint says which nested repositories it
 *  left out. v1–v5 stay as they were. Scripted models and fixture folders only; no provider is called. */

import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { SCHEMA_VERSION, type Run } from '@oasis-code/contract'
import { connect, type Conn } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { Harness } from '../src/director/harness.ts'
import { scopeRefusal } from '../src/director/scope.ts'
import { buildServer } from '../src/director/server.ts'
import { SeatbeltRuntime, type Sandbox } from '../src/execution/isolation.ts'
import { isRequest, isUserPrompt, modelResponse, textPart, toolCallPart, toolReturns, type ModelMessage } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { PathPolicy } from '../src/workspace/paths.ts'
import { sandboxForWorkspace } from '../src/workspace/sandbox.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo, git, PassthroughRuntime, scriptedModel, setModel, sleep, waitDone } from './harness.ts'
import { tempDir } from './helpers.ts'

type Rec = Record<string, unknown>
const MODEL = 'scripted:a'
const FIXTURES = join(import.meta.dir, 'fixtures')
let app: App | null = null
const clients: McpClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  if (app) await app.close()
  app = null
})

const V5 = { 'x-oasis-tool-surface': 'director.v5' }
const real = (p: string) => realpathSync(p)

/** A runtime that runs the command unconfined and keeps every box it was given (a test of what the box says, never
 *  of the kernel: real Seatbelt cannot be nested in this environment). */
class RecordingRuntime extends PassthroughRuntime {
  readonly boxes: Sandbox[] = []
  override command(argv: string[], box: Sandbox, profile: string): string[] { this.boxes.push(box); return super.command(argv, box, profile) }
}

function playing(steps: ((messages: ModelMessage[]) => ReturnType<typeof modelResponse>)[], seen: ModelMessage[][] = []) {
  let n = 0
  return (messages: ModelMessage[]) => { seen.push(messages); const step = steps[n] ?? (() => modelResponse([textPart('done')])); n += 1; return step(messages) }
}
const userTexts = (messages: ModelMessage[]) => messages.filter(isRequest).flatMap((m) => m.parts).filter(isUserPrompt)
  .map((p) => (typeof p.content === 'string' ? p.content : p.content.filter((c): c is string => typeof c === 'string').join('\n'))).join('\n')
const returnsOf = (messages: ModelMessage[], tool: string) => toolReturns(messages).filter((p) => p.tool_name === tool).map((p) => p.content as Rec)

/** A source folder to read and an output folder to write, beside each other, and a direct project on a third. */
function folders() {
  const base = tempDir('oasis-roots-')
  const src = join(base, 'source')
  const out = join(base, 'output')
  const work = join(base, 'work')
  for (const d of [src, out, work]) mkdirSync(d, { recursive: true })
  writeFileSync(join(src, 'README.md'), 'the source\n')
  writeFileSync(join(work, 'notes.md'), 'work\n')
  return { base, src: real(src), out: real(out), work: real(work) }
}

async function openDirect(opts: { runtime?: RecordingRuntime } = {}) {
  app = await makeApp(null, opts.runtime ? { runtime: opts.runtime, probe: true } : {})
  const c = new Client(app)
  const f = folders()
  const project = await json(await c.post('/api/projects', { source_path: f.work, mode: 'direct' }))
  return { c, f, project }
}

// ---- schema v29 ------------------------------------------------------------------------------------------------------

function structure(conn: Conn): Record<string, unknown> {
  const tables = conn.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name as string).sort()
  return Object.fromEntries(tables.map((t) => [t, {
    columns: conn.all(`PRAGMA table_info(${t})`).map((r) => [r.name, r.type, r.notnull, r.dflt_value, r.pk]),
    indexes: conn.all(`PRAGMA index_list(${t})`).map((r) => r.name as string).filter((n) => !n.startsWith('sqlite_')).sort(),
  }]))
}

for (const [version, fixture] of [[27, 'schema_v27.sql'], [28, 'schema_v28.sql']] as const) {
  test(`a v${version} database (its schema.sql as it stood) upgrades to v29: task_root_id null and no roots for every session, nothing else of it rewritten, and it equals a fresh database`, () => {
    const base = tempDir(`oasis-v${version}-`)
    mkdirSync(join(base, 'old'))
    const path = join(base, 'old', 'index.db')
    const raw = new Database(path)
    raw.exec(readFileSync(join(FIXTURES, fixture), 'utf8') + `\nPRAGMA user_version = ${version};`)
    raw.run("INSERT INTO projects (id, name, base_repo_path, created_at, updated_at) VALUES ('p_1','legacy','/x','t','t')")
    const access = version === 28 ? ', access_mode' : ''
    raw.run(`INSERT INTO sessions (id, project_id, title, model, grants_json, created_at, updated_at, last_activity_at${access}) VALUES ('s_full','p_1','full','m','{"run_commands":true,"network":false}','t1','t2','t3'${version === 28 ? ",'full'" : ''})`)
    raw.run(`INSERT INTO sessions (id, project_id, title, model, grants_json, created_at, updated_at, last_activity_at${access}) VALUES ('s_box','p_1','box','m','{"workspace_write":false}','t1','t2','t3'${version === 28 ? ",'sandbox'" : ''})`)
    raw.run("INSERT INTO runs (id, session_id, project_id, model, user_text, status, created_at) VALUES ('run_1','s_full','p_1','m','hi','done','t')")
    if (version === 28) raw.run("INSERT INTO access_caps (subject_kind, subject_id, cap, created_at) VALUES ('run','run_1','sandbox','t')")
    const before = {
      sessions: raw.query('SELECT * FROM sessions ORDER BY id').all(),
      runs: raw.query('SELECT * FROM runs ORDER BY id').all(),
      caps: version === 28 ? raw.query('SELECT * FROM access_caps').all() : [],
    }
    raw.close()
    const migrated = connect(path)
    const fresh = connect(join(base, 'fresh', 'index.db'))
    try {
      expect(SCHEMA_VERSION).toBe(37)
      expect(migrated.get('PRAGMA user_version')!.user_version).toBe(37)
      expect(structure(migrated)).toEqual(structure(fresh))
      const sessions = migrated.all('SELECT * FROM sessions ORDER BY id')
      // every column the session had is as it was (v27: v28's access_mode added, full access for every session); the new one is null
      const added = version === 27 ? ['task_root_id', 'access_mode', 'pin_order'] : ['task_root_id', 'pin_order']
      expect(sessions.map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => !added.includes(k))))).toEqual(before.sessions as Rec[])
      if (version === 27) expect(sessions.map((s) => s.access_mode)).toEqual(['full', 'full'])
      expect(sessions.map((s) => s.task_root_id)).toEqual([null, null])
      expect(migrated.all('SELECT * FROM runs ORDER BY id')).toEqual(before.runs as Rec[])
      if (version === 28) expect(migrated.all('SELECT * FROM access_caps')).toEqual(before.caps as Rec[])
      expect(migrated.all('SELECT * FROM session_roots')).toEqual([])
      const full = repo.getSession(migrated, 's_full')!
      expect(full.access_mode).toBe('full')                                     // v27: every session goes to Full with the upgrade to v28
      expect(full.grants.network).toBe(false)
      expect(full.task_root_id).toBeNull()
      expect(full.roots).toEqual([])
      expect(repo.getSession(migrated, 's_box')!.grants.workspace_write).toBe(false)
      expect(existsSync(`${path}.v${version}.bak`)).toBe(true)
    } finally { migrated.close(); fresh.close() }
  })
}

// ---- a task across sessions and projects -----------------------------------------------------------------------------

test('a session joins another session\'s task in any project: task_root_id is that task\'s first session, the task\'s sessions are listed with each, and an unknown session is refused before anything is made', async () => {
  app = await makeApp()
  const c = new Client(app)
  const a = await json(await c.post('/api/projects', { source_path: folders().work, mode: 'direct' }))
  const b = await json(await c.post('/api/projects', { source_path: folders().work, mode: 'direct' }))
  const first = await json(await c.post(`/api/projects/${a.id}/sessions`, { title: 'first', model: MODEL }))
  expect(first.task_root_id).toBeNull()
  const second = await json(await c.post(`/api/projects/${b.id}/sessions`, { title: 'second', model: MODEL, task_session_id: first.id }))
  expect(second.task_root_id).toBe(first.id)
  // joining a joined session joins its task, never a chain
  const third = await json(await c.post(`/api/projects/${a.id}/sessions`, { title: 'third', model: MODEL, task_session_id: second.id }))
  expect(third.task_root_id).toBe(first.id)
  const detail = await json(await c.get(`/api/sessions/${first.id}`))
  expect((detail.task_sessions as Rec[]).map((s) => s.id)).toEqual([first.id, second.id, third.id])
  expect((detail.task_sessions as Rec[]).map((s) => s.project_id)).toEqual([a.id, b.id, a.id])
  // the rail's read: every project's sessions carry it
  const listed = (await json<Rec[]>(await c.get('/api/projects'))).flatMap((p) => p.sessions as Rec[])
  expect(Object.fromEntries(listed.map((s) => [s.id, s.task_root_id]))).toEqual({ [String(first.id)]: null, [String(second.id)]: first.id, [String(third.id)]: first.id })
  const before = repo.listSessions(app.state.conn, String(a.id)).length
  const unknown = await json(await c.post(`/api/projects/${a.id}/sessions`, { title: 'x', model: MODEL, task_session_id: 's_000000000000' }), 404)
  expect(unknown.code).toBe('task_session_not_found')
  expect(repo.listSessions(app.state.conn, String(a.id))).toHaveLength(before)
})

// ---- roots: registered, checked, changed by the person ---------------------------------------------------------------

test('a session\'s roots: registered with it by real path, read and replaced by the person, refused with a code and a next step when they cannot be; a writable folder inside a read-only one is allowed', async () => {
  const { c, f, project } = await openDirect()
  const link = join(f.base, 'link-to-source')
  symlinkSync(f.src, link)
  mkdirSync(join(f.src, 'out-inside'))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'rooted', model: MODEL, roots: [{ path: f.out, access: 'write' }, { path: link, access: 'read' }, { path: join(f.src, 'out-inside'), access: 'write' }] }))
  expect(s.roots).toEqual([{ path: f.out, access: 'write' }, { path: f.src, access: 'read' }, { path: join(f.src, 'out-inside'), access: 'write' }].sort((x, y) => x.path.localeCompare(y.path)))
  const got = await json(await c.get(`/api/sessions/${s.id}/roots`))
  expect((got.roots as Rec[]).map((r) => [r.path, r.access])).toEqual((s.roots as Rec[]).map((r) => [r.path, r.access]))
  expect(got.changeable).toBe(true)
  // the person replaces them; a director, a connector or a surface never does
  const put = await json(await c.put(`/api/sessions/${s.id}/roots`, { roots: [{ path: f.src, access: 'read' }] }))
  expect((put.roots as Rec[]).map((r) => [r.path, r.access])).toEqual([[f.src, 'read']])
  const byDirector = await json(await c.put(`/api/sessions/${s.id}/roots`, { roots: [] }, V5), 403)
  expect(byDirector.code).toBe('roots_person_only')
  expect(repo.getSession(app!.state.conn, String(s.id))!.roots).toEqual([{ path: f.src, access: 'read' }])
  const refused = async (roots: Rec[], code: string) => {
    const r = await json(await c.put(`/api/sessions/${s.id}/roots`, { roots }), 400)
    expect(r.code, JSON.stringify(roots)).toBe(code)
    expect(typeof r.next_step).toBe('string')
    expect(String(r.detail)).toContain(String(r.next_step))
  }
  await refused([{ path: 'relative/path', access: 'read' }], 'root_not_absolute')
  await refused([{ path: join(f.base, 'missing'), access: 'read' }], 'root_missing')
  await refused([{ path: app!.state.settings.data_dir, access: 'read' }], 'root_in_harness_data')
  await refused([{ path: '/', access: 'read' }], 'root_in_harness_data')
  await refused([{ path: f.work, access: 'read' }], 'root_inside_working_folder')
  await refused([{ path: f.src, access: 'read' }, { path: link, access: 'write' }], 'root_conflict')
  if (process.env.TMPDIR !== undefined && homedir().startsWith(realpathSync(process.env.TMPDIR).replace(/\/tmp$/, ''))) {
    mkdirSync(join(homedir(), '.ssh', 'keys'), { recursive: true })
    await refused([{ path: join(homedir(), '.ssh', 'keys'), access: 'read' }], 'root_credential_store')
  }
  // a refusal changed nothing; a session made with a refused root is not made
  expect(repo.getSession(app!.state.conn, String(s.id))!.roots).toEqual([{ path: f.src, access: 'read' }])
  const count = repo.listSessions(app!.state.conn, String(project.id)).length
  expect((await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'bad', model: MODEL, roots: [{ path: 'x', access: 'read' }] }), 400)).code).toBe('root_not_absolute')
  expect(repo.listSessions(app!.state.conn, String(project.id))).toHaveLength(count)
})

test('a session takes as many roots as it names: 17 private folders registered with it and again by the person, with no count limit (schema or API)', async () => {
  const { c, f, project } = await openDirect()
  const many = Array.from({ length: 17 }, (_, i) => { const d = join(f.base, `root-${String(i).padStart(2, '0')}`); mkdirSync(d); return { path: real(d), access: i % 2 ? 'write' as const : 'read' as const } })
  const made = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'many', model: MODEL, roots: many }))
  expect(made.roots).toEqual(many)
  expect(repo.listSessionRoots(app!.state.conn, String(made.id))).toHaveLength(17)
  const replaced = await json(await c.put(`/api/sessions/${made.id}/roots`, { roots: [...many, { path: f.src, access: 'read' }] }))
  expect(replaced.roots as Rec[]).toHaveLength(18)
})

// ---- roots: the file tools ---------------------------------------------------------------------------------------------

test('the file tools reach a session\'s roots by absolute path: a read root read and never written, a write root written (its Git metadata too, in a Full access session); the run is told its roots', async () => {
  const { c, f, project } = await openDirect()
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'files', model: MODEL, roots: [{ path: f.src, access: 'read' }, { path: f.out, access: 'write' }] }))
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, scriptedModel(playing([
    () => modelResponse([
      toolCallPart('read_file', { path: join(f.src, 'README.md') }, 'r1'),
      toolCallPart('write_file', { path: join(f.src, 'new.md'), content: 'no' }, 'w1'),
      toolCallPart('write_file', { path: join(f.out, 'result.md'), content: 'made\n' }, 'w2'),
      toolCallPart('write_file', { path: join(f.out, '.git', 'config'), content: '[core]\n' }, 'w3'),
      toolCallPart('read_file', { path: f.out }, 'r2'),
    ]),
    () => modelResponse([textPart('done')]),
  ], seen)))
  await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${s.id}/chat`, { text: 'use the folders' }))).id)
  const last = seen.at(-1)!
  const reads = returnsOf(last, 'read_file')
  expect(reads[0]!.status).toBe('ok')
  expect(String(reads[0]!.content)).toContain('the source')
  const writes = returnsOf(last, 'write_file')
  expect(writes[0]!.status).toBe('refused')
  expect(String(writes[0]!.reason)).toContain('read-only')
  expect(existsSync(join(f.src, 'new.md'))).toBe(false)
  expect(writes[1]!.status).toBe('ok')
  expect(readFileSync(join(f.out, 'result.md'), 'utf8')).toBe('made\n')
  expect(writes[2]!.status).toBe('ok')                                         // a Full access session's root is the user's own
  expect((reads[1]!.files as string[])).toContain(join(f.out, 'result.md'))
  // told in its opening message, each root with its access
  const opening = userTexts(seen[0]!)
  expect(opening).toContain(`${f.src} (read-only)`)
  expect(opening).toContain(`${f.out} (read and write)`)
  // a write in a root is no change of the working folder's journal (nothing of the folder to undo)
  expect(repo.getSession(app!.state.conn, String(s.id))!.access_mode).toBe('full')
})

test('in a Sandbox access session a write root keeps its Git metadata from the file tools, and says so', async () => {
  const { c, f, project } = await openDirect()
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'sandboxed', model: MODEL, access_mode: 'sandbox', roots: [{ path: f.out, access: 'write' }] }))
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, scriptedModel(playing([
    () => modelResponse([toolCallPart('write_file', { path: join(f.out, '.git', 'config'), content: 'x' }, 'w1'), toolCallPart('write_file', { path: join(f.out, 'ok.md'), content: 'ok' }, 'w2')]),
    () => modelResponse([textPart('done')]),
  ], seen)))
  await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${s.id}/chat`, { text: 'write' }))).id)
  const writes = returnsOf(seen.at(-1)!, 'write_file')
  expect(writes[0]!.status).toBe('refused')
  expect(String(writes[0]!.reason)).toContain('Git metadata')
  expect(writes[1]!.status).toBe('ok')
  expect(userTexts(seen[0]!)).toContain(`${f.out} (read and write, its Git metadata excepted)`)
})

test('an isolated copy holds every root read-only and says which the session has writable; its workspace lists its effective roots', async () => {
  const { c, f, project } = await openDirect()
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'parent', model: MODEL, roots: [{ path: f.out, access: 'write' }] }))
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, scriptedModel(playing([
    () => modelResponse([toolCallPart('write_file', { path: join(f.out, 'from-copy.md'), content: 'x' }, 'w1')]),
    () => modelResponse([textPart('done')]),
  ], seen)))
  const run = await json<Run>(await c.post(`/api/sessions/${s.id}/work-orders`, { work_order: { prompt: 'separate', model: MODEL }, workspace_policy: 'isolated' }))
  await waitDone(app!.state, run.id)
  const write = returnsOf(seen.at(-1)!, 'write_file')[0]!
  expect(write.status).toBe('refused')
  expect(String(write.reason)).toContain('read-only in this workspace')
  expect(existsSync(join(f.out, 'from-copy.md'))).toBe(false)
  expect(userTexts(seen[0]!)).toContain(`${f.out} (read-only in this workspace, an isolated copy; the session has it read and write)`)
  const ws = await json(await c.get(`/api/workspaces/${repo.getRun(app!.state.conn, run.id)!.workspace_id}`))
  expect(ws.effective_roots).toEqual([{ path: f.out, access: 'read', registered: 'write' }])
  const own = await json(await c.get(`/api/workspaces/${s.workspace_id}`))
  expect(own.effective_roots).toEqual([{ path: f.out, access: 'write', registered: 'write' }])
})

// ---- roots: commands ---------------------------------------------------------------------------------------------------

test('a sandboxed command\'s box writes the session\'s write roots (their nested Git metadata denied), reads its read roots as any folder, and the rendered profile says so', async () => {
  const runtime = new RecordingRuntime()
  const { c, f, project } = await openDirect({ runtime })
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'box', model: MODEL, access_mode: 'sandbox', roots: [{ path: f.src, access: 'read' }, { path: f.out, access: 'write' }] }))
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, scriptedModel(playing([
    () => modelResponse([toolCallPart('bash', { command: 'echo in-root', wait_s: 30, cwd: f.out }, 'b1')]),
    () => modelResponse([textPart('done')]),
  ], seen)))
  await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${s.id}/chat`, { text: 'run' }))).id)
  const result = returnsOf(seen.at(-1)!, 'bash')[0]!
  expect(result.status).toBe('succeeded')
  const box = runtime.boxes.at(-1)!
  expect(box.writable).toContain(f.out)
  expect(box.writable).not.toContain(f.src)
  expect((box.write_deny_patterns ?? []).some((p) => new RegExp(p).test(join(f.out, 'sub', '.git', 'config')))).toBe(true)
  const profile = new SeatbeltRuntime().profile(box)
  expect(profile).toContain(`(subpath "${f.out}")`)
  // the same box without roots is the box it always was
  const plain = sandboxForWorkspace(app!.state.settings.data_dir, project as never, { path: f.work, kind: 'direct' }, { network: true })
  expect(plain.writable).not.toContain(f.out)
  const rooted = sandboxForWorkspace(app!.state.settings.data_dir, project as never, { path: f.work, kind: 'direct' }, { network: true, roots: [{ path: f.out, access: 'write' }, { path: f.src, access: 'read' }] })
  expect(rooted.writable).toEqual([...plain.writable, f.out])
})

test('a Full access command never writes past a read-only root: without a host restriction to hold it, it is refused (restriction_unavailable) and nothing runs — no sandbox stands in', async () => {
  const runtime = new RecordingRuntime()
  const { c, f, project } = await openDirect({ runtime })
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'full', model: MODEL, roots: [{ path: f.src, access: 'read' }] }))
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, scriptedModel(playing([
    () => modelResponse([toolCallPart('bash', { command: `echo x > ${join(f.src, 'written.txt')}`, wait_s: 30 }, 'b1')]),
    () => modelResponse([textPart('done')]),
  ], seen)))
  const run = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${s.id}/chat`, { text: 'run' }))).id)
  const result = returnsOf(seen.at(-1)!, 'bash')[0]!
  expect(result.status).toBe('refused')
  expect(result.code).toBe('restriction_unavailable')
  // integration (final integrator): the interim refusal of this branch named the roots in its reason; execution's
  // host-restricted path (merged) refuses with the runtime's reason and names the roots in access_reasons — the same
  // fact, said where every refusal of a restriction says it (nothing weakened: refused, nothing ran, no box)
  expect((result.access_reasons as Rec[]).map((r) => r.code)).toEqual(['read_only_root', 'restriction_unavailable'])
  expect(String((result.access_reasons as Rec[])[0]!.detail)).toContain(f.src)
  expect(result.effective_access).toBe('full')
  expect(existsSync(join(f.src, 'written.txt'))).toBe(false)
  expect(repo.listExecutions(app!.state.conn, { run_id: run.id })).toHaveLength(0)
  expect(runtime.boxes).toHaveLength(0)
  // a write root alone holds nothing back: the Full command runs on the host and writes it
  await json(await c.put(`/api/sessions/${s.id}/roots`, { roots: [{ path: f.out, access: 'write' }] }))
  const seen2: ModelMessage[][] = []
  setModel(app!.state, MODEL, scriptedModel(playing([
    () => modelResponse([toolCallPart('bash', { command: `echo y > ${join(f.out, 'host.txt')} && echo wrote`, wait_s: 30 }, 'b1')]),
    () => modelResponse([textPart('done')]),
  ], seen2)))
  await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${s.id}/chat`, { text: 'run' }))).id)
  // the conversation goes on: its latest bash return is this run's
  expect(returnsOf(seen2.at(-1)!, 'bash').at(-1)).toMatchObject({ status: 'succeeded' })
  expect(readFileSync(join(f.out, 'host.txt'), 'utf8')).toBe('y\n')
})

test('the path policy: the deepest root decides, a link out of a root is refused, an isolated copy\'s root says what the session has', () => {
  const f = folders()
  mkdirSync(join(f.src, 'gen'))
  symlinkSync(f.out, join(f.src, 'escape'))
  const policy = PathPolicy.forWorkspace(f.work, [], null, { roots: [
    { path: f.src, access: 'read', registered: 'read', protect_git: false },
    { path: join(f.src, 'gen'), access: 'write', registered: 'write', protect_git: false },
    { path: f.out, access: 'read', registered: 'write', protect_git: false },
  ] })
  expect(policy.resolveRead(join(f.src, 'README.md'))[1]).toBe(join(f.src, 'README.md'))
  expect(() => policy.resolveWrite(join(f.src, 'README.md'))).toThrow(/read-only/)
  expect(policy.resolveWrite(join(f.src, 'gen', 'made.txt'))[1]).toBe(join(f.src, 'gen', 'made.txt'))
  expect(() => policy.resolveRead(join(f.src, 'escape', 'x'))).toThrow(/outside the root/)
  expect(() => policy.resolveWrite(join(f.out, 'x'))).toThrow(/isolated copy/)
  expect(() => policy.resolveRead(join(f.base, 'elsewhere.txt'))).toThrow()
  expect(() => policy.resolveWrite(join(f.src, 'gen'))).toThrow(/itself/)
})

// ---- open_project (v6) and the REST folder made on request --------------------------------------------------------------

async function directing(surface: 'director.v5' | 'director.v6', opts: { runtime?: RecordingRuntime } = {}) {
  if (!app) app = await makeApp(null, opts.runtime ? { runtime: opts.runtime, probe: true } : {})
  const harness = Harness.connect('http://localhost', 'test-token', { fetchImpl: (input, init) => Promise.resolve(app!.app.request(input, init)) })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await buildServer(harness, { surface }).connect(serverTransport)
  const client = new McpClient({ name: 't', version: '0' })
  await client.connect(clientTransport)
  clients.push(client)
  return client
}

async function call(c: McpClient, name: string, args: Rec = {}): Promise<Rec> {
  const result = await c.callTool({ name, arguments: args })
  const text = ((result.content as { text?: string }[] | undefined) ?? []).map((p) => p.text ?? '').join('')
  if (result.isError) return { error: text }
  return (result.structuredContent as Rec | undefined) ?? JSON.parse(text)
}

test('REST create_directory makes the last component only, in a parent that exists, and refuses the rest with a code; without it a missing folder is refused as before', async () => {
  app = await makeApp()
  const c = new Client(app)
  const base = real(tempDir('oasis-mk-'))
  const made = await json(await c.post('/api/projects', { source_path: join(base, 'fresh'), mode: 'direct', create_directory: true }))
  expect(made.directory_created).toBe(true)
  expect(made.source_path).toBe(join(base, 'fresh'))
  expect(existsSync(join(base, 'fresh'))).toBe(true)
  const again = await json(await c.post('/api/projects', { source_path: join(base, 'fresh'), mode: 'direct', create_directory: true }))
  expect(again.directory_created).toBe(false)
  const missing = await json(await c.post('/api/projects', { source_path: join(base, 'no', 'deeper'), mode: 'direct', create_directory: true }), 400)
  expect(missing.code).toBe('parent_missing')
  expect(existsSync(join(base, 'no'))).toBe(false)
  writeFileSync(join(base, 'a-file'), 'x')
  expect((await json(await c.post('/api/projects', { source_path: join(base, 'a-file'), mode: 'direct', create_directory: true }), 400)).code).toBe('not_a_directory')
  expect((await json(await c.post('/api/projects', { source_path: join(app.state.settings.data_dir, 'inside'), mode: 'direct', create_directory: true }), 400)).code).toBe('create_refused')
  expect(existsSync(join(app.state.settings.data_dir, 'inside'))).toBe(false)
  // the old call, unchanged: a folder that is not there is not opened
  const old = await c.post('/api/projects', { source_path: join(base, 'absent'), mode: 'direct' })
  expect(old.status).toBe(400)
  expect(await old.text()).toContain('is not a directory')
  expect(existsSync(join(base, 'absent'))).toBe(false)
})

test('director.v6 open_project reuses a folder\'s project of the same kind only, makes a folder on request, opens the no-folder project, and refuses arguments that ask two things; v5 keeps reusing whatever the kind', async () => {
  const v6 = await directing('director.v6')
  const folder = buggyRepo()
  const direct = await call(v6, 'open_project', { path: folder })
  expect(direct.kind).toBe('direct')
  const snap = await call(v6, 'open_project', { path: folder, mode: 'snapshot' })
  expect(snap.reused).toBe(false)
  expect(snap.kind).toBe('snapshot')
  expect(snap.same_folder_projects).toEqual([{ id: direct.id, kind: 'direct' }])
  const directAgain = await call(v6, 'open_project', { path: folder })
  expect(directAgain.reused).toBe(true)
  expect(directAgain.id).toBe(direct.id)
  expect(directAgain.same_folder_projects).toEqual([{ id: snap.id, kind: 'snapshot' }])
  // a folder made on request: its last component, in a parent that exists
  const parent = real(tempDir('oasis-parent-'))
  const made = await call(v6, 'open_project', { path: join(parent, 'output'), create_directory: true })
  expect(made.directory_created).toBe(true)
  expect(made.kind).toBe('direct')
  expect(existsSync(join(parent, 'output'))).toBe(true)
  const noParent = await call(v6, 'open_project', { path: join(parent, 'x', 'y'), create_directory: true })
  expect(String(noParent.error)).toContain('does not exist')
  expect(existsSync(join(parent, 'x'))).toBe(false)
  const noFolder = await call(v6, 'open_project', { no_folder: true })
  expect(noFolder.no_folder).toBe(true)
  expect(noFolder.reused).toBe(false)
  expect((await call(v6, 'open_project', { no_folder: true })).id).toBe(noFolder.id)
  const projects = repo.listProjects(app!.state.conn).length
  expect(String((await call(v6, 'open_project', { no_folder: true, path: folder })).error)).toContain('no_folder is not combined with path')
  expect(String((await call(v6, 'open_project', {})).error)).toContain('path is required')
  expect(repo.listProjects(app!.state.conn)).toHaveLength(projects)
  // v5: as it was — the folder's existing project, whatever its kind; no create_directory to ask for
  const v5 = await directing('director.v5')
  const old = await call(v5, 'open_project', { path: folder, mode: 'attached' })
  expect(old.reused).toBe(true)
  const { tools } = await v5.listTools()
  expect(Object.keys((tools.find((t) => t.name === 'open_project')!.inputSchema as { properties: Rec }).properties)).not.toContain('create_directory')
})

test('director.v6 create_session joins a task and names roots; get_session reads them back; v5 neither takes nor answers them', async () => {
  const v6 = await directing('director.v6')
  const f = folders()
  const p1 = await call(v6, 'open_project', { path: f.work })
  const first = await call(v6, 'create_session', { project_id: p1.id, title: 'first' })
  const p2 = await call(v6, 'open_project', { path: join(f.base, 'out2'), create_directory: true })
  const second = await call(v6, 'create_session', { project_id: p2.id, title: 'second', task_session_id: first.id, roots: [{ path: f.src, access: 'read' }] })
  expect(second.task_root_id).toBe(first.id)
  expect(second.roots).toEqual([{ path: f.src, access: 'read' }])
  const read = await call(v6, 'get_session', { session_id: second.id })
  expect(read.task_root_id).toBe(first.id)
  expect((read.task_sessions as Rec[]).map((s) => s.id)).toEqual([first.id, second.id])
  expect(read.roots).toEqual([{ path: f.src, access: 'read' }])
  const refused = await call(v6, 'create_session', { project_id: p1.id, title: 'bad', roots: [{ path: join(f.base, 'nope'), access: 'read' }] })
  expect(String(refused.error)).toContain('is not an existing folder')
  const v5 = await directing('director.v5')
  const old = await call(v5, 'create_session', { project_id: p1.id, title: 'old', task_session_id: first.id })
  expect(old.task_root_id).toBeUndefined()
  expect(repo.getSession(app!.state.conn, String(old.id))!.task_root_id).toBeNull()
})

// ---- another session's ended run handed over ------------------------------------------------------------------------------

test('an ended run of another session is handed over only when asked for (receive_across_sessions; director.v6): headed with its session and run, recorded in the receiving session only; without it the same-session rule holds (not_in_session), and v5 keeps it', async () => {
  app = await makeApp()
  const c = new Client(app)
  const p = await json(await c.post('/api/projects', { source_path: folders().work, mode: 'direct' }))
  const q = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const a = await json(await c.post(`/api/projects/${p.id}/sessions`, { title: 'source session', model: MODEL }))
  const b = await json(await c.post(`/api/projects/${q.id}/sessions`, { title: 'receiving', model: MODEL, task_session_id: a.id }))
  setModel(app.state, MODEL, scriptedModel(() => modelResponse([textPart('the answer of A')])))
  const runA = await waitDone(app.state, (await json<Run>(await c.post(`/api/sessions/${a.id}/chat`, { text: 'answer' }))).id)
  const edgesA = (await json(await c.get(`/api/sessions/${a.id}/collaboration`))).edges
  // unchanged: the same-session rule
  const refused = await json(await c.post(`/api/sessions/${b.id}/chat`, { text: 'use it', receive_run_ids: [runA.id] }), 400)
  expect(refused.code).toBe('not_in_session')
  const seen: ModelMessage[][] = []
  setModel(app.state, MODEL, scriptedModel(playing([() => modelResponse([textPart('got it')])], seen)))
  const runB = await waitDone(app.state, (await json<Run>(await c.post(`/api/sessions/${b.id}/chat`, { text: 'use it', receive_run_ids: [runA.id], receive_across_sessions: true }))).id)
  const opening = userTexts(seen[0]!)
  expect(opening).toContain(`Answer of run ${runA.id}`)
  expect(opening).toContain(`of session ${a.id} ("source session")`)
  expect(opening).toContain('no access to that session\'s files comes with it')
  expect(opening).toContain('the answer of A')
  const graphB = await json(await c.get(`/api/sessions/${b.id}/collaboration`))
  const received = (graphB.edges as Rec[]).find((e) => e.kind === 'received' && (e.to as Rec).id === runB.id)!
  expect((received.from as Rec).id).toBe(runA.id)
  expect(received.meta).toMatchObject({ cross_session: true, source_session_id: a.id, source_project_id: p.id })
  // the source session's record is as it was; nothing of its folder reaches the receiving session
  expect((await json(await c.get(`/api/sessions/${a.id}/collaboration`))).edges).toEqual(edgesA)
  expect(repo.getSession(app.state.conn, String(b.id))!.roots).toEqual([])
  // a run still going, or none, is refused alike across sessions
  expect((await json(await c.post(`/api/sessions/${b.id}/chat`, { text: 'x', receive_run_ids: ['run_000000000000'], receive_across_sessions: true }), 400)).code).toBe('not_in_session')
  // through the director: v6 hands it over, v5 keeps the same-session rule
  const v6 = await directing('director.v6')
  setModel(app.state, MODEL, scriptedModel(() => modelResponse([textPart('ok')])))
  const viaV6 = await call(v6, 'start_run', { session_id: b.id, text: 'again', receive_run_ids: [runA.id] })
  expect(typeof viaV6.id, JSON.stringify(viaV6)).toBe('string')
  await waitDone(app.state, String(viaV6.id))
  const v5 = await directing('director.v5')
  expect(String((await call(v5, 'start_run', { session_id: b.id, text: 'again', receive_run_ids: [runA.id] })).error)).toContain('not a run of this session')
})

test('a native director\'s scope: a v6 call may receive the answers of any session it reaches and of none other (unknown and unreached alike); a shared folder\'s workspace is each of its sessions\' on v6, the first session\'s on v1–v5', async () => {
  app = await makeApp()
  const c = new Client(app)
  const st = app.state
  const project = await json(await c.post('/api/projects', { source_path: folders().work, mode: 'direct' }))
  const a = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'A', model: MODEL }))
  const b = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'B', model: MODEL }))
  const other = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'other', model: MODEL }))
  setModel(st, MODEL, scriptedModel(() => modelResponse([textPart('answer')])))
  const runA = await waitDone(st, (await json<Run>(await c.post(`/api/sessions/${a.id}/chat`, { text: 'x' }))).id)
  const runOther = await waitDone(st, (await json<Run>(await c.post(`/api/sessions/${other.id}/chat`, { text: 'x' }))).id)
  const bId = String(b.id)
  const reach = [String(a.id)]
  // one folder edited in place: one workspace, owned by the first session
  expect(b.workspace_id).toBe(a.workspace_id)
  expect(scopeRefusal(st.conn, bId, 'read_file', { workspace_id: b.workspace_id }, [], 'director.v6')).toBeNull()
  expect(scopeRefusal(st.conn, bId, 'read_file', { workspace_id: b.workspace_id }, [], 'director.v5')).not.toBeNull()
  // a handover across sessions: reached, yes; not reached, or nothing of that name, the same refusal
  expect(scopeRefusal(st.conn, bId, 'start_run', { session_id: bId, receive_run_ids: [runA.id] }, reach, 'director.v6')).toBeNull()
  const outside = scopeRefusal(st.conn, bId, 'start_run', { session_id: bId, receive_run_ids: [runOther.id] }, reach, 'director.v6')
  const unknown = scopeRefusal(st.conn, bId, 'start_run', { session_id: bId, receive_run_ids: ['run_000000000000'] }, reach, 'director.v6')
  expect(outside).not.toBeNull()
  expect(unknown).toBe(outside)
  // v5: one session per call, as before
  expect(scopeRefusal(st.conn, bId, 'start_run', { session_id: bId, receive_run_ids: [runA.id] }, reach, 'director.v5')).not.toBeNull()
  // any other thing of another session in the same call stays refused on v6
  expect(scopeRefusal(st.conn, bId, 'start_run', { session_id: bId, resume_run_id: runA.id }, reach, 'director.v6')).not.toBeNull()
})

// ---- v6 bash read_only and get_run waiting ----------------------------------------------------------------------------------

test('director.v6 bash asks for a read-only command and passes through where it ran and what held it; get_run returns what a queued run waits for; v5 does neither', async () => {
  const sent: { url: string; body: Rec | null }[] = []
  const waiting = { reason: 'workspace_lock', workspace_id: 'ws_1', blocking_owner: 'run_aaaaaaaaaaaa', blocking_kind: 'run', blocking_run_id: 'run_aaaaaaaaaaaa', queued_since: '2026-10-16T00:00:00Z', position: 1 }
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) as Rec : null })
    if (url.includes('/commands')) return Response.json({ status: 'succeeded', exit_code: 0, stdout: 'x', requested_access: 'full', effective_access: 'full', access_reasons: [{ code: 'read_only', detail: 'd', next_step: 'n' }], restrictions: { filesystem: 'read_only' }, stdout_total_bytes: 1, output_complete: true, stop_reason: 'exited' })
    if (url.includes('/api/runs/')) return Response.json({ id: 'run_bbbbbbbbbbbb', session_id: 's_1', status: 'queued', waiting })
    return Response.json({})
  }
  const connectWith = async (surface: 'director.v5' | 'director.v6') => {
    const harness = Harness.connect('http://127.0.0.1:9', 'unused', { fetchImpl: fetchImpl as never })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await buildServer(harness, { surface }).connect(st)
    const client = new McpClient({ name: 't', version: '0' })
    await client.connect(ct)
    clients.push(client)
    return client
  }
  const v6 = await connectWith('director.v6')
  const ran = await call(v6, 'bash', { workspace_id: 'ws_1', session_id: 's_1', command: 'ls', read_only: true })
  expect(sent.at(-1)!.body).toMatchObject({ command: 'ls', access: 'session', session_id: 's_1', read_only: true })
  expect(ran).toMatchObject({ requested_access: 'full', effective_access: 'full', restrictions: { filesystem: 'read_only' }, output_complete: true, stop_reason: 'exited' })
  expect((ran.access_reasons as Rec[])[0]!.code).toBe('read_only')
  await call(v6, 'bash', { workspace_id: 'ws_1', command: 'ls' })
  expect(sent.at(-1)!.body!.read_only).toBeUndefined()
  const queued = await call(v6, 'get_run', { run_id: 'run_bbbbbbbbbbbb' })
  expect(queued.waiting).toEqual(waiting)
  expect(String(queued.note)).toContain('behind run run_aaaaaaaaaaaa')
  const v5 = await connectWith('director.v5')
  const old = await call(v5, 'bash', { workspace_id: 'ws_1', command: 'ls', read_only: true })
  expect(sent.at(-1)!.body!.read_only).toBeUndefined()
  expect(old.requested_access).toBeUndefined()
  expect((await call(v5, 'get_run', { run_id: 'run_bbbbbbbbbbbb' })).waiting).toBeUndefined()
})

// ---- nested repositories a checkpoint leaves out ----------------------------------------------------------------------------

test('a checkpoint says which nested git repositories its tree left out, and an interaction\'s copies say the same of their starting point', async () => {
  app = await makeApp()
  const c = new Client(app)
  const p = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const s = await json(await c.post(`/api/projects/${p.id}/sessions`, { title: 'nested', model: MODEL }))
  const ws = s.workspace as Rec
  const nested = join(String(ws.path), 'repo')
  mkdirSync(nested)
  git(['init', '-q'], nested)
  writeFileSync(join(nested, 'inside.txt'), 'kept out\n')
  writeFileSync(join(String(ws.path), 'plain.txt'), 'kept\n')
  await json(await c.post(`/api/workspaces/${ws.id}/checkpoint`, { note: 'with a nested repository' }))
  const detail = await json(await c.get(`/api/workspaces/${ws.id}`))
  expect((detail.checkpoints as Rec[]).at(-1)!.excluded_nested_repositories).toEqual(['repo'])
  setModel(app.state, MODEL, scriptedModel(() => modelResponse([textPart('answer')])))
  const ix = await json(await c.post(`/api/sessions/${s.id}/interactions`, { text: 'two', workspace_policy: 'isolated', participants: [{ model: MODEL }, { model: MODEL }], plan: { template: 'independent' } }))
  expect(ix.base_excluded_nested_repositories).toEqual(['repo'])
  for (let i = 0; i < 200 && app.state.interactions.detail(repo.getInteraction(app.state.conn, String(ix.id))!).live; i += 1) await sleep(25)
  for (const n of repo.listNodes(app.state.conn, String(ix.id))) if (n.run_id) await waitDone(app.state, n.run_id)
})
