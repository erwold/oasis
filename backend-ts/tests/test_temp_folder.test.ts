/** The workspace's temporary folder: one per workspace, beside the worktree, the commands' $TMPDIR and the one
 *  absolute location the file tools reach — kept across commands, runs and restarts, never in a checkpoint or a
 *  diff, unreachable from another workspace, gone with the session. Real processes through PassthroughRuntime (the
 *  manager's mechanics); the kernel's part is what the real-Seatbelt case shows. */
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from '@oasis-code/contract'
import { buildState } from '../src/api/state.ts'
import * as repo from '../src/db/repo.ts'
import { buildRuntime } from '../src/execution/isolation.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart } from '../src/llm/messages.ts'
import { PathPolicy, PathRefused } from '../src/workspace/paths.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { sandboxForWorkspace } from '../src/workspace/sandbox.ts'
import { appState, buggyRepo, closeState, FAKE_FULL, openSession, PassthroughRuntime, scriptedModel, setModel, testConfig, testSettings, userTexts, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

async function calls(session: Session, sequence: [string, Record<string, unknown>][], opts: { fresh?: boolean } = {}) {
  const results: Record<string, unknown>[] = []
  let index = 0
  let prompt = ''
  setModel(state!, 'scripted:a', scriptedModel((messages) => {
    if (index === 0) prompt = userTexts(messages)[0] ?? ''
    if (index > 0) results.push(lastToolReturn(messages, sequence[index - 1]![0]) as Record<string, unknown>)
    const next = sequence[index++]
    return next ? modelResponse([toolCallPart(next[0], next[1], '')]) : modelResponse([textPart('done')])
  }))
  const run = await state!.runs.start(session, 'synthetic', { fresh: opts.fresh ?? false })
  await waitDone(state!, run.id)
  return { results, prompt, run }
}

const text = (r: Record<string, unknown> | undefined) => `${String(r?.stdout ?? '')}${String(r?.stderr ?? '')}`

test('commands and tools of one workspace share its temporary folder, across runs; a checkpoint never carries it', async () => {
  state = await appState({ sandbox: true })
  const { session, ws } = await openSession(state, buggyRepo())
  const tmp = state.processes.tempFor(ws.id, '')
  const first = await calls(session, [
    ['bash', { command: 'echo "$TMPDIR"; printf KEPT > "$TMPDIR/note.txt"' }],
    ['bash', { command: 'cat "$TMPDIR/note.txt"' }],
    ['read_file', { path: join(tmp, 'note.txt') }],
    ['write_file', { path: join(tmp, 'made-by-tool.txt'), content: 'TOOL\n' }],
    ['read_file', { path: join(tmp, 'made-by-tool.txt') }],
    ['edit_file', { path: join(tmp, 'made-by-tool.txt'), old_string: 'TOOL', new_string: 'EDITED' }],
    ['read_file', { path: tmp }],
    ['bash', { command: 'cat made-by-tool.txt', cwd: tmp }],
  ])
  expect(first.prompt).toContain(`Temporary folder: ${tmp} ($TMPDIR)`)
  expect(text(first.results[0]).trim()).toBe(tmp)
  expect(text(first.results[1])).toBe('KEPT')
  expect(first.results[2]!.status).toBe('ok')
  expect(String(first.results[2]!.content)).toContain('KEPT')
  expect(first.results[3]!.status).toBe('ok')
  expect(first.results[5]!.status).toBe('ok')
  expect(readFileSync(join(tmp, 'made-by-tool.txt'), 'utf8')).toBe('EDITED\n')
  expect(first.results[6]!.kind).toBe('directory')
  expect((first.results[6]!.files as string[]).sort()).toEqual([join(tmp, 'made-by-tool.txt'), join(tmp, 'note.txt')])
  expect(text(first.results[7])).toBe('EDITED\n')
  // a later run of the same workspace finds the files; the worktree's diff and a checkpoint never hold them
  const later = await calls(session, [['bash', { command: 'ls "$TMPDIR" | sort' }]], { fresh: true })
  expect(text(later.results[0]).trim().split('\n')).toEqual(['made-by-tool.txt', 'note.txt'])
  expect((await state.workspaces.diff(ws)).files).toEqual([])
  const snap = await state.workspaces.snapshot(ws)
  expect(snap.changed_paths).toEqual([])
  expect(existsSync(join(ws.path, 'note.txt'))).toBe(false)
  // the run recorded where its commands' temporary folder was
  const execution = repo.listExecutions(state.conn, { run_id: first.run.id })[0]!
  expect((execution.isolation as { tmp?: string }).tmp).toBe(tmp)
})

test('the temporary folder survives a restart of the harness on the same data directory', async () => {
  const settings = testSettings()
  state = await appState({ settings, sandbox: true })
  const { session, ws } = await openSession(state, buggyRepo())
  await calls(session, [['bash', { command: 'printf SURVIVES > "$TMPDIR/keep"' }]])
  await closeState(state)
  state = await buildState(settings, testConfig(), { probe: false, runtime: state.processes.runtime, isolation: state.isolation })
  const again = repo.getSession(state.conn, session.id)!
  const { results } = await calls(again, [['bash', { command: 'cat "$TMPDIR/keep"' }]])
  expect(text(results[0])).toBe('SURVIVES')
  expect(state.processes.tempFor(ws.id, '')).toStartWith(settings.sandboxes_dir)
})

test("the policy reaches the temporary folder by its absolute path and no other absolute path; '..' and links out are refused", () => {
  state = null
  const settings = testSettings()
  const root = join(settings.data_dir, 'ws')
  const tmp = join(settings.data_dir, 'sandboxes', 'ws_1', 'tmp')
  mkdirSync(root, { recursive: true })
  mkdirSync(tmp, { recursive: true })
  writeFileSync(join(tmp, 'a.txt'), 'a')
  symlinkSync(settings.data_dir, join(tmp, 'escape'))
  const policy = PathPolicy.forWorkspace(root, [], null, { temp: tmp })
  const real = policy.temp!
  expect(policy.resolveRead(join(tmp, 'a.txt'))[1]).toBe(join(real, 'a.txt'))
  expect(policy.resolveRead(tmp)[0]).toEqual([real])
  expect(policy.resolveWrite(join(tmp, 'new', 'b.txt'))[0]).toEqual([real, 'new', 'b.txt'])
  expect(() => policy.resolveRead(`${tmp}/../home/x`)).toThrow(/'\.\.' is refused/)
  expect(() => policy.resolveRead(join(tmp, 'escape', 'index.db'))).toThrow(/outside the temporary folder/)
  expect(() => policy.resolveRead(settings.data_dir)).toThrow(/outside the allowed folders/)
  expect(() => policy.resolveRead('/etc/passwd')).toThrow(PathRefused)
  expect(() => policy.resolveRead(join(settings.data_dir, 'sandboxes', 'ws_2', 'tmp', 'other'))).toThrow(/outside the allowed folders/)
  expect(() => policy.resolveWrite(tmp)).toThrow(/temporary folder itself/)
  // without a temporary folder no absolute path is reachable at all
  expect(() => PathPolicy.forWorkspace(root, []).resolveRead(join(tmp, 'a.txt'))).toThrow(/outside the allowed folders/)
})

test.skipIf(process.platform !== 'darwin')("another workspace's temporary folder is out of reach for a command, on the real Seatbelt", async () => {
  state = await buildState(testSettings(), testConfig(), { runtime: buildRuntime(), probe: true })
  expect(state.isolation.enforcement).toBe('full')
  const a = await openSession(state, buggyRepo())
  const b = await openSession(state, buggyRepo())
  const tmpB = state.processes.ensureTemp(b.ws.id)
  writeFileSync(join(tmpB, 'secret.txt'), 'B_PRIVATE')
  const { results } = await calls(a.session, [
    ['bash', { command: `cat '${join(tmpB, 'secret.txt')}'; echo exit=$?` }],
    ['read_file', { path: join(tmpB, 'secret.txt') }],
    ['bash', { command: 'printf MINE > "$TMPDIR/mine"; cat "$TMPDIR/mine"' }],
  ])
  expect(text(results[0])).not.toContain('B_PRIVATE')
  expect(text(results[0])).toContain('exit=1')
  expect(results[1]!.status).toBe('refused')
  expect(String(results[1]!.reason)).toContain('outside the allowed folders')
  expect(text(results[2])).toBe('MINE')
}, 30000)

test('deleting a session removes its temporary folder, and is refused while a command of it still runs', async () => {
  const app = await makeApp(null, { runtime: new PassthroughRuntime(), isolation: FAKE_FULL })
  try {
    const c = new Client(app)
    const st = app.state
    const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
    const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 't', model: 'scripted:a' }))
    const ws = repo.getWorkspace(st.conn, session.workspace_id as string)!
    const tmp = st.processes.ensureTemp(ws.id)
    writeFileSync(join(tmp, 'x'), 'x')
    const sandbox = sandboxForWorkspace(st.settings.data_dir, repo.getProject(st.conn, project.id as string)!, ws, { network: false })
    const running = await st.processes.start({ command: 'sleep 20', cwd: ws.path, sandbox, project_id: project.id as string, workspace_id: ws.id })
    expect((await c.delete(`/api/sessions/${session.id}`)).status).toBe(409)
    expect(existsSync(join(tmp, 'x'))).toBe(true)
    st.processes.stop(running.id)
    await st.processes.wait(running.id, 5)
    expect((await c.delete(`/api/sessions/${session.id}`)).status).toBe(200)
    expect(existsSync(st.processes.sandboxDir(ws.id))).toBe(false)
  } finally { await app.close() }
})
