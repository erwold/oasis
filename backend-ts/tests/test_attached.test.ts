/** A folder attached, not copied. A snapshot import copies the folder into a base repository and refuses one over
 *  the limits with what it measured; an attached project copies nothing: the folder is mounted read-only under
 *  its name inside every workspace (a symlink the snapshots ignore), the file tools list, read and search it there,
 *  commands read it there, every write into it is refused — by the path policy and, on macOS, by the kernel — and
 *  the workspace itself is the run's scratch. */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { sandboxForWorkspace } from '../src/agent/tools/commands.ts'
import { Settings } from '../src/config.ts'
import { connect } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { buildRuntime } from '../src/execution/isolation.ts'
import { ProcessManager } from '../src/execution/processes.ts'
import { modelResponse, textPart, toolCallPart, type ModelMessage } from '../src/llm/messages.ts'
import { AssetStore } from '../src/store.ts'
import { humanBytes, measureFolder, SnapshotTooLarge } from '../src/workspace/measure.ts'
import { PathPolicy, PathRefused } from '../src/workspace/paths.ts'
import { listWorkspaceFiles, readWorkspaceFile } from '../src/workspace/reading.ts'
import { attachedName, attachedOf, WorkspaceService } from '../src/workspace/service.ts'
import { Client, makeApp } from './api_harness.ts'
import { appState, closeState, git, lastToolReturn, scriptedModel, steps, userTexts, waitDone, type AppState } from './harness.ts'
import { tempDir } from './helpers.ts'

let state: AppState | null = null
const closers: (() => void | Promise<void>)[] = []
afterEach(async () => {
  if (state) await closeState(state)
  state = null
  for (const close of closers.splice(0)) await close()
})

/** A folder a person keeps things in: files, a nested directory, a node_modules to leave out, a link not followed. */
function stuffFolder(): string {
  const root = join(tempDir('oasis-stuff-'), 'Downloads')
  mkdirSync(join(root, 'notes'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(root, 'a.txt'), 'hello attached\n')
  writeFileSync(join(root, 'notes', 'todo.md'), '# todo\n- find the receipt\n')
  writeFileSync(join(root, 'node_modules', 'x', 'index.js'), 'x'.repeat(5000))
  writeFileSync(join(root, 'big.bin'), Buffer.alloc(3000))
  return root
}

function service(limits: { snapshot_max_bytes?: number; snapshot_max_files?: number } = {}) {
  const settings = new Settings({ data_dir: join(tempDir('oasis-data-'), 'data'), host: '127.0.0.1', port: 0, session_token: 'test-token', ...limits })
  mkdirSync(settings.data_dir, { recursive: true })
  const conn = connect(settings.db_path)
  closers.push(() => conn.close())
  return { settings, conn, workspaces: new WorkspaceService(settings, conn) }
}

test('the measure counts files and bytes, leaves the excluded directories out, and stops at the first limit crossed', () => {
  const root = stuffFolder()
  const expected = ['a.txt', 'big.bin', 'notes/todo.md'].reduce((n, f) => n + statSync(join(root, f)).size, 0)
  const whole = measureFolder(root, { max_bytes: 1e9, max_files: 1e6 })
  expect(whole).toMatchObject({ files: 3, bytes: expected, stopped_early: false })
  const byBytes = measureFolder(root, { max_bytes: 100, max_files: 1e6 })
  expect(byBytes.stopped_early).toBe(true)
  expect(byBytes.bytes).toBeGreaterThan(100)
  expect(byBytes.files).toBeLessThanOrEqual(3)
  const byFiles = measureFolder(root, { max_bytes: 1e9, max_files: 1 })
  expect(byFiles).toMatchObject({ files: 2, stopped_early: true })
  expect(humanBytes(3041)).toBe('3 kB')
  expect(humanBytes(2 * 1024 ** 3)).toBe('2.0 GB')
  expect(humanBytes(311 * 1024 ** 3)).toBe('311 GB')
  expect(attachedName('/Users/x/Downloads/')).toBe('Downloads')
  expect(attachedName('/Users/x/.hidden')).toBe('attached')
})

test('a snapshot over a limit is refused with the measure and nothing is copied; attached copies nothing by design', async () => {
  const root = stuffFolder()
  const small = service({ snapshot_max_files: 2 })
  let refused: unknown = null
  try { await small.workspaces.importProject('stuff', root) } catch (error) { refused = error }
  expect(refused).toBeInstanceOf(SnapshotTooLarge)
  const e = refused as SnapshotTooLarge
  expect(e.message).toContain('attach the folder read-only')
  expect(e.measured.files).toBeGreaterThanOrEqual(3)
  expect(e.limits.max_files).toBe(2)
  expect(e.asBody()).toMatchObject({ refusal: 'snapshot_too_large', options: ['attached', 'subfolder'], source_path: realpathSync(root) })
  expect(existsSync(small.settings.repos_dir)).toBe(false)
  expect(repo.listProjects(small.conn)).toHaveLength(0)
  // under the limits the snapshot goes as before
  const wide = service()
  const copied = await wide.workspaces.importProject('stuff', root)
  expect(copied.kind).toBe('snapshot')
  expect(copied.import_report.files_carried).toBe(3)
  // attached: an empty base, the folder recorded, nothing carried
  const attached = await wide.workspaces.importProject('stuff', root, { mode: 'attached' })
  expect(attached.kind).toBe('attached')
  expect(attached.source_path).toBe(realpathSync(root))
  expect(attached.import_report).toMatchObject({ kind: 'attached', attached_as: 'Downloads', files_carried: 0 })
  expect(String(attached.import_report.basis)).toContain('never written')
  expect(git(['ls-tree', attached.base_commit!], attached.base_repo_path)).toBe('')
  expect(attachedOf(attached)).toEqual({ name: 'Downloads', root: realpathSync(root), writable: false })
  expect(attachedOf(attached, { writable: true })!.writable).toBe(true)
  expect(attachedOf(copied)).toBeNull()
})

test("a workspace mounts the attached folder read-only; the policy and the listing reach it, the snapshot ignores it", async () => {
  const root = stuffFolder()
  const { conn, workspaces } = service()
  const project = await workspaces.importProject('stuff', root, { mode: 'attached' })
  const session = repo.createSession(conn, project.id, 't', 'scripted:a')
  const ws = await workspaces.createWorkspace(project, session.id)
  const link = join(ws.path, 'Downloads')
  expect(lstatSync(link).isSymbolicLink()).toBe(true)
  expect(readFileSync(join(link, 'a.txt'), 'utf8')).toBe('hello attached\n')
  const excludeRel = git(['rev-parse', '--git-path', 'info/exclude'], ws.path)
  const exclude = isAbsolute(excludeRel) ? excludeRel : join(ws.path, excludeRel)
  expect(readFileSync(exclude, 'utf8').split('\n')).toContain('/Downloads')
  // the workspace's own listing and snapshot know nothing of the link
  expect(await workspaces.listFiles(ws)).toEqual([])
  const empty = await workspaces.snapshot(ws)
  expect(empty.file_count).toBe(0)
  expect(empty.untracked).toEqual([])
  writeFileSync(join(ws.path, 'out.txt'), 'y\n')
  const one = await workspaces.snapshot(ws)
  expect(one.file_count).toBe(1)
  expect((await workspaces.diff(ws)).files.map((f) => f.path)).toEqual(['out.txt'])
  // the policy: reads through the link land in the folder; writes into it are refused; the scratch is writable
  const policy = PathPolicy.forWorkspace(ws.path, [], attachedOf(project))
  expect(policy.resolveRead('Downloads/a.txt')[1]).toBe(join(realpathSync(root), 'a.txt'))
  expect(policy.resolveRead('Downloads')[1]).toBe(realpathSync(root))
  expect(() => policy.resolveWrite('Downloads/a.txt')).toThrow(/attached folder Downloads\//)
  expect(() => policy.resolveWrite('Downloads/new.txt')).toThrow(PathRefused)
  expect(() => policy.resolveRead('Downloads/../a.txt')).toThrow(/'\.\.' is refused/)
  expect(policy.resolveWrite('out.txt')[1]).toBe(join(policy.root, 'out.txt'))
  // the listing walks the folder as it stands, node_modules left out, paged
  const listed = listWorkspaceFiles(policy, [], ws.path, 'Downloads')
  expect(listed.status).toBe('ok')
  if (listed.status === 'ok') {
    expect(listed.entries.map((e) => e.path)).toEqual(['Downloads/a.txt', 'Downloads/big.bin', 'Downloads/notes/todo.md'])
    expect(listed.skipped_in_excluded_dirs).toBe(1)
    expect(listed.truncated).toBe(false)
  }
  const page = listWorkspaceFiles(policy, [], ws.path, 'Downloads', 2)
  expect(page.status === 'ok' && page.truncated && page.entries.length === 2).toBe(true)
  const nested = listWorkspaceFiles(policy, [], ws.path, 'Downloads/notes')
  expect(nested.status === 'ok' && nested.entries.map((e) => e.path)).toEqual(['Downloads/notes/todo.md'])
  const notDir = listWorkspaceFiles(policy, [], ws.path, 'Downloads/a.txt')
  expect(notDir.status === 'refused' && notDir.reason).toContain('not a directory')
  // the root's listing names the attached folder first (a link no snapshot holds: a reader who only lists finds it)
  const scratch = listWorkspaceFiles(policy, ['out.txt'], ws.path, '.')
  expect(scratch.status === 'ok' && scratch.entries).toEqual([{ path: 'Downloads/', bytes: null, attached: true }, { path: 'out.txt', bytes: 2 }])
  const read = readWorkspaceFile(policy, 'Downloads/notes/todo.md')
  expect(read.status === 'ok' && read.content).toContain('find the receipt')
})

test('the API attaches a folder, refuses a big snapshot with 413 and the measure, and reads the folder through the workspace', async () => {
  const root = stuffFolder()
  const settings = new Settings({ data_dir: join(tempDir('oasis-data-'), 'data'), host: '127.0.0.1', port: 0, session_token: 'test-token', snapshot_max_files: 1 })
  const app = await makeApp(settings)
  closers.push(() => closeState(app.state))
  const c = new Client(app)
  const refused = await c.post('/api/projects', { source_path: root })
  expect(refused.status).toBe(413)
  const body = await refused.json() as Record<string, unknown>
  expect(body.refusal).toBe('snapshot_too_large')
  expect((body.measured as Record<string, number>).files).toBeGreaterThanOrEqual(2)
  expect((body.limits as Record<string, number>).max_files).toBe(1)
  expect(body.options).toEqual(['attached', 'subfolder'])
  expect(String(body.detail)).toContain('attach the folder read-only')
  const created = await c.post('/api/projects', { source_path: root, mode: 'attached' })
  expect(created.status).toBe(200)
  const project = await created.json() as Record<string, unknown>
  expect(project.kind).toBe('attached')
  const listed = await (await c.get('/api/projects')).json() as Record<string, unknown>[]
  expect(listed.map((p) => p.kind)).toEqual(['attached'])
  const session = await (await c.post(`/api/projects/${project.id}/sessions`, { title: 'look' })).json() as Record<string, unknown>
  const wsId = (session.workspace as Record<string, unknown>).id as string
  const files = await (await c.get(`/api/workspaces/${wsId}/files`, { path: 'Downloads' })).json() as Record<string, unknown>
  expect((files.entries as { path: string }[]).map((e) => e.path)).toContain('Downloads/notes/todo.md')
  const file = await (await c.get(`/api/workspaces/${wsId}/file`, { path: 'Downloads/a.txt' })).json() as Record<string, unknown>
  expect(String(file.content)).toContain('hello attached')
  expect((await c.get(`/api/workspaces/${wsId}/file`, { path: 'Downloads/../a.txt' })).status).toBe(400)
})

test('a run on an attached project reads the folder, writes only its scratch, and is told so', async () => {
  const root = stuffFolder()
  const prompts: string[] = []
  const editAttached = (messages: ModelMessage[]) => {
    prompts.push(...userTexts(messages))
    const read = lastToolReturn(messages, 'read_file') as Record<string, unknown>
    expect(read.status).toBe('ok')
    return modelResponse([toolCallPart('edit_file', { path: 'Downloads/a.txt', old_string: 'hello', new_string: 'bye' }, '')])
  }
  const script = steps(
    [toolCallPart('read_file', { path: 'Downloads' }, '')],
    [toolCallPart('read_file', { path: 'Downloads/a.txt', offset: 1, limit: 40 }, '')],
    editAttached,
    [toolCallPart('write_file', { path: 'found.md', content: 'a.txt says hello\n' }, '')],
    [toolCallPart('bash', { command: 'grep -Rl receipt Downloads/', timeout_s: 30 }, '')],
    [toolCallPart('bash', { command: 'cat Downloads/a.txt', timeout_s: 30 }, '')],
    [textPart('done')],
  )
  state = await appState({ sandbox: true, models: { 'scripted:a': scriptedModel(script, 'scripted-a') } })
  const project = await state.workspaces.importProject('stuff', root, { mode: 'attached' })
  const session = repo.createSession(state.conn, project.id, 'look', 'scripted:a')
  const ws = await state.workspaces.createWorkspace(project, session.id)
  repo.setSessionWorkspace(state.conn, session.id, ws.id)
  expect(session.grants.attached_write).toBe(true)                                                     // a new session may write the attached folder
  repo.setSessionGrants(state.conn, session.id, { ...session.grants, attached_write: false })          // made read-only for this test
  let run = await state.runs.start(repo.getSession(state.conn, session.id)!, 'what does a.txt say? note it down')
  run = await waitDone(state, run.id)
  expect(run.status).toBe('done')
  expect(prompts[0]).toContain('Attached folder: Downloads/ (read-only).')
  const events = repo.listEvents(state.conn, run.id)
  const results = events.filter((e) => e.event === 'tool_result').map((e) => e.data as Record<string, unknown>)
  const byTool = (tool: string) => results.filter((r) => r.tool === tool)
  expect(byTool('read_file')[0]).toMatchObject({ status: 'ok', path: 'Downloads/', count: 3 })
  expect(byTool('read_file')[1]).toMatchObject({ status: 'ok', path: 'Downloads/a.txt' })
  expect(byTool('edit_file')[0]!.status).toBe('refused')
  expect(String(byTool('edit_file')[0]!.summary)).toContain('attached folder')
  expect(byTool('write_file')[0]).toMatchObject({ status: 'ok', path: 'found.md', op: 'created' })
  expect(byTool('bash').map((r) => r.exit_code)).toEqual([0, 0])
  // the folder is as it was; the scratch holds the note; the receipt counts the refusal and the one file
  expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('hello attached\n')
  expect(readFileSync(join(ws.path, 'found.md'), 'utf8')).toBe('a.txt says hello\n')
  const receipt = run.receipt as Record<string, Record<string, unknown>>
  expect(receipt.produced!.files_changed).toEqual(['found.md'])
  expect(receipt.mechanical!.refused_calls).toBe(1)
  const [grep, cat] = repo.listExecutions(state.conn, { run_id: run.id })
  expect(state.store.read(repo.getAsset(state.conn, grep!.stdout_asset_id!)!.storage_path).toString().trim().split('\n')).toHaveLength(1)
  expect(state.store.read(repo.getAsset(state.conn, cat!.stdout_asset_id!)!.storage_path).toString()).toContain('hello attached')
})

test.skipIf(process.platform !== 'darwin')('on macOS the sandbox reads the attached folder and the kernel refuses to write it', async () => {
  const root = stuffFolder()
  const { settings, conn, workspaces } = service()
  const runtime = buildRuntime()
  const report = await runtime.probe(settings.data_dir)
  expect(report.enforcement).toBe('full')
  const processes = new ProcessManager(settings, conn, new AssetStore(settings.assets_dir), runtime, report)
  closers.push(() => processes.shutdown())
  const project = await workspaces.importProject('stuff', root, { mode: 'attached' })
  const session = repo.createSession(conn, project.id, 't', 'scripted:a')
  const ws = await workspaces.createWorkspace(project, session.id)
  const box = sandboxForWorkspace(settings.data_dir, project, ws, { network: false })
  expect(box.read_deny).not.toContain(realpathSync(root))
  const run = async (command: string) => {
    const x = await processes.start({ command, cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id })
    await processes.wait(x.id, 60)
    return processes.summary(x.id)
  }
  const read = await run('cat Downloads/a.txt')
  expect(read.exit_code).toBe(0)
  expect(String(read.stdout)).toContain('hello attached')
  const write = await run('sh -c "echo x > Downloads/new.txt"')
  expect(write.exit_code).not.toBe(0)
  expect(existsSync(join(root, 'new.txt'))).toBe(false)
  const scratch = await run('sh -c "echo y > out.txt"')
  expect(scratch.exit_code).toBe(0)
  expect(existsSync(join(ws.path, 'out.txt'))).toBe(true)
})

test("the session's grant opens the attached folder for writing: the policy, the sandbox's roots, a run that moves files", async () => {
  const root = stuffFolder()
  const { conn, workspaces, settings } = service()
  const project = await workspaces.importProject('stuff', root, { mode: 'attached' })
  const session = repo.createSession(conn, project.id, 't', 'scripted:a')
  const ws = await workspaces.createWorkspace(project, session.id)
  // the policy: the folder's files writable, the link itself and a protected glob inside the folder not
  const open = PathPolicy.forWorkspace(ws.path, ['Downloads/keep/**'], attachedOf(project, { writable: true }))
  expect(open.resolveWrite('Downloads/new.txt')[1]).toBe(join(realpathSync(root), 'new.txt'))
  expect(open.resolveWrite('Downloads/notes/todo.md')[1]).toBe(join(realpathSync(root), 'notes', 'todo.md'))
  expect(() => open.resolveWrite('Downloads')).toThrow(/attached folder itself/)
  expect(() => open.resolveWrite('Downloads/keep/x.txt')).toThrow(/protected path/)
  const shut = PathPolicy.forWorkspace(ws.path, [], attachedOf(project))
  expect(() => shut.resolveWrite('Downloads/new.txt')).toThrow(/never written/)
  // the sandbox: the folder among the writable roots only with the grant
  expect(sandboxForWorkspace(settings.data_dir, project, ws, { network: false }).writable).toEqual([realpathSync(ws.path)])
  expect(sandboxForWorkspace(settings.data_dir, project, ws, { network: false, attached_write: true }).writable).toEqual([realpathSync(ws.path), realpathSync(root)])
})

test('with the grant a run writes the folder itself — a note, a move — and is told the grant is on', async () => {
  const root = stuffFolder()
  const prompts: string[] = []
  const first = (messages: ModelMessage[]) => {
    prompts.push(...userTexts(messages))
    return modelResponse([toolCallPart('write_file', { path: 'Downloads/note.txt', content: 'sorted by the run\n' }, '')])
  }
  const script = steps(
    first,
    [toolCallPart('bash', { command: 'mkdir Downloads/series && mv Downloads/a.txt Downloads/series/ && ls Downloads/series', timeout_s: 30 }, '')],
    [textPart('moved')],
  )
  state = await appState({ sandbox: true, models: { 'scripted:a': scriptedModel(script, 'scripted-a') } })
  const project = await state.workspaces.importProject('stuff', root, { mode: 'attached' })
  const session = repo.createSession(state.conn, project.id, 'sort', 'scripted:a')
  const ws = await state.workspaces.createWorkspace(project, session.id)
  repo.setSessionWorkspace(state.conn, session.id, ws.id)
  repo.setSessionGrants(state.conn, session.id, { ...repo.getSession(state.conn, session.id)!.grants, attached_write: true })
  let run = await state.runs.start(repo.getSession(state.conn, session.id)!, 'put a.txt into a folder named series and leave a note')
  run = await waitDone(state, run.id)
  expect(run.status).toBe('done')
  expect(prompts[0]).toContain("Attached folder: Downloads/ (writable). Changes here affect the user's original files and cannot be undone here.")
  const results = repo.listEvents(state.conn, run.id).filter((e) => e.event === 'tool_result').map((e) => e.data as Record<string, unknown>)
  expect(results.find((r) => r.tool === 'write_file')).toMatchObject({ status: 'ok', path: 'Downloads/note.txt', op: 'created' })
  expect(results.find((r) => r.tool === 'bash')).toMatchObject({ status: 'succeeded', exit_code: 0 })
  // the folder itself changed; the scratch did not, so the receipt's diff is empty and nothing was refused
  expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('sorted by the run\n')
  expect(existsSync(join(root, 'series', 'a.txt'))).toBe(true)
  expect(existsSync(join(root, 'a.txt'))).toBe(false)
  const receipt = run.receipt as Record<string, Record<string, unknown>>
  expect(receipt.produced!.files_changed).toEqual([])
  expect(receipt.mechanical!.refused_calls).toBe(0)
})

test.skipIf(process.platform !== 'darwin')('on macOS the grant lets the kernel accept a write into the folder', async () => {
  const root = stuffFolder()
  const { settings, conn, workspaces } = service()
  const runtime = buildRuntime()
  const report = await runtime.probe(settings.data_dir)
  expect(report.enforcement).toBe('full')
  const processes = new ProcessManager(settings, conn, new AssetStore(settings.assets_dir), runtime, report)
  closers.push(() => processes.shutdown())
  const project = await workspaces.importProject('stuff', root, { mode: 'attached' })
  const session = repo.createSession(conn, project.id, 't', 'scripted:a')
  const ws = await workspaces.createWorkspace(project, session.id)
  const box = sandboxForWorkspace(settings.data_dir, project, ws, { network: false, attached_write: true })
  const x = await processes.start({ command: 'sh -c "echo x > Downloads/new2.txt"', cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id })
  await processes.wait(x.id, 60)
  expect(processes.summary(x.id).exit_code).toBe(0)
  expect(readFileSync(join(root, 'new2.txt'), 'utf8')).toBe('x\n')
})
