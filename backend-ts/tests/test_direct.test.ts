/** A folder edited in place (a direct project): opened at once whatever its size, no copy and no repository of the
 *  harness's; every session, work order and interaction step works in it, in turn; a file tool's write is kept first
 *  (the journal), so a run's file changes are told exactly and can be undone — never over what someone else wrote
 *  since. The folder is never removed, its Git metadata never written; the operations of copies (checkpoints, checks
 *  on a checkout, integration) are refused plainly. */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentMentionToken, type InteractionDetail, type Run, type UndoResult } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { buildRuntime } from '../src/execution/isolation.ts'
import { ProcessManager } from '../src/execution/processes.ts'
import { AssetStore } from '../src/store.ts'
import { sandboxForWorkspace } from '../src/workspace/sandbox.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart, type ModelMessage } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo, FAKE_FULL, git, PassthroughRuntime, scriptedModel, setModel, sleep, testSettings, waitDone } from './harness.ts'
import { Settings } from '../src/config.ts'
import { tempDir } from './helpers.ts'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

const MODEL = 'scripted:a'

/** A plain folder (no repository): a few files, one of them a big binary no copy should ever read. */
function assetFolder(): string {
  const dir = join(tempDir('oasis-direct-'), '铁扇公主')
  mkdirSync(join(dir, 'notes'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# rig\nstep one\n')
  writeFileSync(join(dir, 'notes', 'plan.txt'), 'bones: 0\n')
  writeFileSync(join(dir, 'model.blend'), Buffer.alloc(3 * 1024 * 1024, 7))
  return dir
}

/** A model that plays its steps in order, each seeing what the run has seen so far. */
function playing(steps: ((messages: ModelMessage[]) => ReturnType<typeof modelResponse>)[]) {
  let n = 0
  return (messages: ModelMessage[]) => { const step = steps[n] ?? (() => modelResponse([textPart('done')])); n += 1; return step(messages) }
}

async function open(folder: string) {
  app = await makeApp(null, { probe: false })
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: folder, mode: 'direct' }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'in place' }))
  return { c, project: project as Record<string, unknown>, sid: s.id as string, ws: (s.workspace as Record<string, unknown>) }
}

test('a folder opens in place at once: no copy, no repository, whatever its size; every session of it shares the folder', async () => {
  const folder = assetFolder()
  const base = testSettings()
  const settings = new Settings({ data_dir: base.data_dir, host: '127.0.0.1', port: 0, session_token: 'test-token', snapshot_max_bytes: 1024 })   // a copy would be refused as too big
  app = await makeApp(settings, { probe: false })
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: folder, mode: 'direct' }))
  expect(project).toMatchObject({ kind: 'direct', base_repo_path: '', base_commit: null, source_path: folder })
  expect(existsSync(join(settings.repos_dir, project.id as string))).toBe(false)  // no base repository
  const a = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'one' }))
  const b = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'two' }))
  const wa = a.workspace as Record<string, unknown>
  expect(wa).toMatchObject({ kind: 'direct', path: folder, branch: '', base_commit: '' })
  expect((b.workspace as Record<string, unknown>).id).toBe(wa.id)               // one folder, one workspace: writers take turns
  expect(existsSync(join(folder, '.git'))).toBe(false)                           // nothing of Git made in the folder
  expect(readdirSync(folder).sort()).toEqual(['README.md', 'model.blend', 'notes'])
  // the folder is listed by walking it (no repository to ask), and its status and diff are the journal's (empty)
  const entities = await json<{ files?: string[] } & Record<string, unknown>>(await c.get(`/api/workspaces/${wa.id}/entities`))
  expect(JSON.stringify(entities)).toContain('notes/plan.txt')
  const detail = await json<{ status: Record<string, unknown> }>(await c.get(`/api/workspaces/${wa.id}`))
  expect(detail.status).toMatchObject({ modified: [], added: [], in_place: true })
  expect((await json<{ files: unknown[]; patch: string }>(await c.get(`/api/workspaces/${wa.id}/diff`))).files).toEqual([])
  // not a folder, the disk's root: refused
  await json(await c.post('/api/projects', { source_path: join(folder, 'README.md'), mode: 'direct' }), 400)
  await json(await c.post('/api/projects', { source_path: '/', mode: 'direct' }), 400)
})

test("a run's file-tool writes land in the folder, kept first: the receipt and the diff are the run's own, exactly", async () => {
  const folder = assetFolder()
  const { c, sid, ws } = await open(folder)
  setModel(app!.state, MODEL, scriptedModel(playing([
    () => modelResponse([toolCallPart('read_file', { path: 'README.md' }, 'r1')]),
    () => modelResponse([toolCallPart('edit_file', { path: 'README.md', old_string: 'step one', new_string: 'step one\nstep two' }, 'e1')]),
    () => modelResponse([toolCallPart('write_file', { path: 'notes/rig.md', content: 'root bone\n' }, 'w1')]),
    () => modelResponse([textPart('rigged')]),
  ])))
  const chat = await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: 'rig it' }))
  const run = await waitDone(app!.state, chat.id)
  expect(run.status).toBe('done')
  expect(readFileSync(join(folder, 'README.md'), 'utf8')).toBe('# rig\nstep one\nstep two\n')      // in the folder itself
  expect(readFileSync(join(folder, 'notes', 'rig.md'), 'utf8')).toBe('root bone\n')
  // the receipt: the run's own writes, counted from the journal
  const receipt = run.receipt as { produced: { files_changed: string[]; final_checkpoint_id: string | null }; mechanical: { diff: Record<string, unknown> } }
  expect(receipt.produced.files_changed.sort()).toEqual(['README.md', 'notes/rig.md'])
  expect(receipt.produced.final_checkpoint_id).toBeNull()                        // no checkpoint in place
  expect(receipt.mechanical.diff).toMatchObject({ files: 2, added: 2, removed: 0, in_place: true })
  const runDiff = await json<{ patch: string; files: { path: string }[] }>(await c.get(`/api/runs/${run.id}/diff`))
  expect(runDiff.patch).toContain('diff --git a/README.md b/README.md')
  expect(runDiff.patch).toContain('+step two')
  expect(runDiff.patch).toContain('new file mode')
  const one = await json<{ files: { path: string }[] }>(await c.get(`/api/runs/${run.id}/diff`, { path: 'notes/rig.md' }))
  expect(one.files.map((f) => f.path)).toEqual(['notes/rig.md'])
  // the folder's standing changes by the tools
  const standing = await json<{ files: { path: string }[] }>(await c.get(`/api/workspaces/${ws.id}/diff`))
  expect(standing.files.map((f) => f.path).sort()).toEqual(['README.md', 'notes/rig.md'])
  const entries = repo.listJournal(app!.state.conn, { run_id: run.id })
  expect(entries.map((e) => [e.path, e.action, e.state, e.session_id])).toEqual([['README.md', 'edited', 'applied', sid], ['notes/rig.md', 'created', 'applied', sid]])
  expect(Buffer.from(repo.journalBytes(app!.state.conn, entries[0]!.id, 'before')!).toString()).toBe('# rig\nstep one\n')
  expect(existsSync(join(folder, '.git'))).toBe(false)
})

test("a run's file changes are undone: put back, or removed when the run made them; a file changed since is left alone; the next turn is told", async () => {
  const folder = assetFolder()
  const { c, sid } = await open(folder)
  let told = ''
  setModel(app!.state, MODEL, scriptedModel(playing([
    () => modelResponse([toolCallPart('read_file', { path: 'README.md' }, 'r1')]),
    () => modelResponse([toolCallPart('edit_file', { path: 'README.md', old_string: 'step one', new_string: 'STEP ONE' }, 'e1')]),
    () => modelResponse([toolCallPart('read_file', { path: 'notes/plan.txt' }, 'r2')]),
    () => modelResponse([toolCallPart('write_file', { path: 'notes/plan.txt', content: 'bones: 12\n' }, 'w1')]),
    () => modelResponse([toolCallPart('write_file', { path: 'notes/new.md', content: 'made by the run\n' }, 'w2')]),
    () => modelResponse([textPart('changed three files')]),
    (m) => { told = JSON.stringify(m.at(-1)); return modelResponse([textPart('noted')]) },
  ])))
  const first = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: 'change them' }))).id)
  // the person edits one of them afterwards: that one is theirs now
  writeFileSync(join(folder, 'notes', 'plan.txt'), 'bones: 12\nmy own line\n')
  const undo = await json<UndoResult>(await c.post(`/api/runs/${first.id}/undo`))
  expect(undo.restored).toEqual(['README.md'])
  expect(undo.removed).toEqual(['notes/new.md'])
  expect(undo.conflicts).toEqual([{ path: 'notes/plan.txt', reason: 'changed since the run wrote it', code: 'changed_since' }])
  expect(readFileSync(join(folder, 'README.md'), 'utf8')).toBe('# rig\nstep one\n')
  expect(existsSync(join(folder, 'notes', 'new.md'))).toBe(false)
  expect(readFileSync(join(folder, 'notes', 'plan.txt'), 'utf8')).toBe('bones: 12\nmy own line\n')    // never written over
  // again: what was undone stays undone; the file the person kept is still not taken
  const again = await json<UndoResult>(await c.post(`/api/runs/${first.id}/undo`))
  expect(again.restored).toEqual([])
  expect(again.removed).toEqual([])
  expect(again.conflicts.map((x) => x.path)).toEqual(['notes/plan.txt'])
  // the next turn of the conversation hears what was undone
  await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: 'what now?' }))).id)
  expect(told).toContain('the user undid file changes in the folder')
  expect(told).toContain('README.md (restored)')
  expect(told).toContain('notes/new.md (removed: the run had created it)')
  // the undo is in the journal too, and the folder's standing diff no longer shows what went back
  const standing = await json<{ files: { path: string }[] }>(await c.get(`/api/workspaces/${repo.getSession(app!.state.conn, sid)!.workspace_id}/diff`))
  expect(standing.files.map((f) => f.path)).toEqual(['notes/plan.txt'])
  // the run itself may hold the folder a moment after it finished: its undo goes on; another run's write refuses it
  const wsId = repo.getSession(app!.state.conn, sid)!.workspace_id!
  await app!.state.locks.acquire(wsId, first.id)
  expect((await json<UndoResult>(await c.post(`/api/runs/${first.id}/undo`))).conflicts.map((x) => x.path)).toEqual(['notes/plan.txt'])
  app!.state.locks.release(wsId, first.id)
  await app!.state.locks.acquire(wsId, 'run_other')
  await json(await c.post(`/api/runs/${first.id}/undo`), 409)
  app!.state.locks.release(wsId, 'run_other')
  // a run that is not there
  await json(await c.post('/api/runs/run_nothing/undo'), 404)
})

test('a command a run left running in the folder holds its undo off, and the folder for another session\'s next run, until it is stopped', async () => {
  const folder = assetFolder()
  app = await makeApp(null, { probe: false, runtime: new PassthroughRuntime(), isolation: { ...FAKE_FULL, runtime: 'passthrough' } })
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: folder, mode: 'direct' }))
  const sid = (await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'in place' }))).id as string
  const other = (await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'another session of the folder' }))).id as string
  setModel(app.state, MODEL, scriptedModel(playing([
    () => modelResponse([toolCallPart('write_file', { path: 'gen.txt', content: 'v1\n' }, 'w1')]),
    // a regenerator that keeps the file as the run wrote it, and outlives the run
    () => modelResponse([toolCallPart('bash', { command: 'while :; do echo v1 > gen.txt; sleep 0.05; done', wait_s: 1 }, 'b1')]),
    () => modelResponse([textPart('the regenerator runs')]),
  ])))
  const first = await waitDone(app.state, (await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: 'make gen.txt and keep it fresh' }))).id)
  expect(first.status).toBe('done')
  const xid = repo.listExecutions(app.state.conn, { run_id: first.id })[0]!.id
  expect(app.state.processes.isRunning(xid)).toBe(true)
  // the undo would put back a file the command writes again at once: refused, and the command named
  const refused = await json<{ detail: string }>(await c.post(`/api/runs/${first.id}/undo`), 409)
  expect(refused.detail).toContain(xid)
  expect(existsSync(join(folder, 'gen.txt'))).toBe(true)
  // the command still writes the folder: it holds it (its run has ended) and another session's run waits in line, told
  // why (a run of the same conversation would work beside it: test_background_cohort)
  setModel(app.state, MODEL, scriptedModel(playing([() => modelResponse([textPart('second run')])])))
  const second = await json<Run>(await c.post(`/api/sessions/${other}/chat`, { text: 'next' }))
  expect(second.status).toBe('queued')
  expect((await json(await c.get(`/api/runs/${second.id}`))).waiting).toMatchObject({ reason: 'workspace_lock', blocking_kind: 'command', blocking_run_id: first.id, blocking_execution_ids: [xid] })
  expect(app.state.processes.isRunning(xid)).toBe(true)
  // stopped, the command no longer writes: the next run starts (nothing of the folder's still runs as it does), and
  // the undo goes through
  expect((await json<{ stopped: boolean }>(await c.post(`/api/executions/${xid}/stop`))).stopped).toBe(true)
  await app.state.processes.wait(xid, 5)
  await waitDone(app.state, second.id)
  const started = repo.listEvents(app.state.conn, second.id).find((e) => e.event === 'run_started')!
  expect(started.data.running_commands).toEqual([])
  const undo = await json<UndoResult>(await c.post(`/api/runs/${first.id}/undo`))
  expect(undo.removed).toEqual(['gen.txt'])
  await sleep(200)
  expect(existsSync(join(folder, 'gen.txt'))).toBe(false)
})

test("the folder is never removed and its Git metadata never written; the copies' operations are refused plainly", async () => {
  const folder = buggyRepo()                                                      // a repository: its .git is the person's
  const head = git(['rev-parse', 'HEAD'], folder).trim()
  const refsBefore = git(['for-each-ref'], folder)
  const { c, ws } = await open(folder)
  const workspace = repo.getWorkspace(app!.state.conn, ws.id as string)!
  await expect(app!.state.workspaces.removeWorkingTree(workspace)).rejects.toThrow('never removes it')
  await expect(app!.state.workspaces.removeVerificationWorktree(repo.getProject(app!.state.conn, workspace.project_id)!, folder)).rejects.toThrow('only a folder the harness made')
  await json(await c.post(`/api/workspaces/${ws.id}/checkpoint`, { note: 'x' }), 409)
  await json(await c.post(`/api/workspaces/${ws.id}/verify`, {}), 409)
  await json(await c.post(`/api/workspaces/${ws.id}/integrate`, { checkpoint_ids: ['cp_x'] }), 409)
  // commands: the folder writable, its Git metadata not, the harness's data not readable, a hard lock's file not writable
  const project = repo.getProject(app!.state.conn, workspace.project_id)!
  const box = sandboxForWorkspace(app!.state.settings.data_dir, project, workspace, { network: false, deny_write: [join(folder, 'calc.py')] })
  expect(box.writable).toEqual([folder])
  expect(box.write_deny).toEqual([join(folder, '.git'), join(folder, 'calc.py')])
  expect(box.read_deny).toEqual([app!.state.settings.data_dir])
  expect(box.read_allow).toEqual([folder])
  // after all this, the person's repository is as it was: no ref, no index file, no object of the harness's
  expect(git(['rev-parse', 'HEAD'], folder).trim()).toBe(head)
  expect(git(['for-each-ref'], folder)).toBe(refsBefore)
  expect(existsSync(join(folder, '.git', 'oasis-snapshot-index'))).toBe(false)
})

test('a write kept but never marked (a stop between the two) is settled at startup by the file', async () => {
  const folder = assetFolder()
  const { ws } = await open(folder)
  const workspace = repo.getWorkspace(app!.state.conn, ws.id as string)!
  const journal = app!.state.workspaces.journal
  const happened = journal.prepare(workspace, { run_id: 'run_a', tool_call_id: 't', path: 'README.md', action: 'edited', before: readFileSync(join(folder, 'README.md')), intended: Buffer.from('written\n') })
  writeFileSync(join(folder, 'README.md'), 'written\n')
  const never = journal.prepare(workspace, { run_id: 'run_a', tool_call_id: 't2', path: 'notes/plan.txt', action: 'edited', before: readFileSync(join(folder, 'notes', 'plan.txt')), intended: Buffer.from('never written\n') })
  expect(journal.recover((id) => repo.getWorkspace(app!.state.conn, id))).toEqual({ applied: 1, abandoned: 1, unsettled: 0, unreadable: 0 })
  expect(repo.getJournalEntry(app!.state.conn, happened.id)!.state).toBe('applied')
  expect(repo.getJournalEntry(app!.state.conn, never.id)!.state).toBe('abandoned')
})

test("an interaction's steps and a work order's run work in the folder, in turn: no copy to start from, none to adopt", async () => {
  const folder = assetFolder()
  const { c, sid, ws } = await open(folder)
  const A = agentMentionToken('Scripted A', MODEL, 'A')
  const B = agentMentionToken('Scripted A', MODEL, 'B')
  const running: string[] = []
  let overlapped = false
  setModel(app!.state, MODEL, scriptedModel(async (messages: ModelMessage[]) => {
    const who = /You are ([A-Z])\./.exec(JSON.stringify(messages))?.[1] ?? '?'
    const wrote = lastToolReturn(messages, 'write_file')
    if (wrote) { running.splice(running.indexOf(who), 1); return modelResponse([textPart(`${who} done`)]) }
    if (running.length) overlapped = true
    running.push(who)
    await sleep(60)
    return modelResponse([toolCallPart('write_file', { path: `from_${who}.txt`, content: `${who}\n` }, `w${who}`)])
  }))
  const created = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} ${B} each leave a file`, plan: { template: 'independent' } }))
  expect(created.base_checkpoint_id).toBeNull()
  let detail = created
  for (let i = 0; i < 400 && !['done', 'error', 'waiting'].includes(detail.status); i += 1) { await sleep(25); detail = await json<InteractionDetail>(await c.get(`/api/interactions/${created.id}`)) }
  for (const n of detail.nodes) if (n.run_id) await waitDone(app!.state, n.run_id)
  detail = await json<InteractionDetail>(await c.get(`/api/interactions/${created.id}`))
  expect(detail.status).toBe('done')
  expect(detail.nodes.map((n) => n.workspace_id)).toEqual([ws.id as string, ws.id as string])        // 'own' steps: the folder, not copies
  expect(overlapped).toBe(false)                                                  // one writer at a time
  expect(readFileSync(join(folder, 'from_A.txt'), 'utf8')).toBe('A\n')
  expect(readFileSync(join(folder, 'from_B.txt'), 'utf8')).toBe('B\n')
  await json(await c.post(`/api/interactions/${created.id}/adopt`, { node_id: detail.nodes[0]!.id }), 409)
  // a work order in place: from the folder as it is, on the same workspace; a named checkpoint is refused
  setModel(app!.state, MODEL, scriptedModel(() => modelResponse([textPart('ordered')])))
  const order = await json<Run>(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'look around', model: MODEL, workspace: { base: 'parent' } } }))
  expect(order.workspace_id).toBe(ws.id as string)
  await waitDone(app!.state, order.id)
  await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'look', model: MODEL, workspace: { base: 'cp_somewhere' } } }), 400)
})

test.skipIf(process.platform !== 'darwin')('on macOS a command in a folder edited in place writes its files but no Git metadata: the folder\'s own, nor a repository nested anywhere in it', async () => {
  const folder = buggyRepo()
  const nested = join(folder, 'vendor', 'nested')
  mkdirSync(nested, { recursive: true })
  git(['init', '-q', '-b', 'main'], nested)
  writeFileSync(join(nested, 'n.txt'), 'n\n')
  git(['add', '-A'], nested)
  git(['commit', '-q', '-m', 'nested'], nested)
  const nestedHead = git(['rev-parse', 'HEAD'], nested).trim()
  const { ws } = await open(folder)
  const workspace = repo.getWorkspace(app!.state.conn, ws.id as string)!
  const project = repo.getProject(app!.state.conn, workspace.project_id)!
  const runtime = buildRuntime({ extra_read_deny: [app!.state.settings.data_dir] })
  const report = await runtime.probe(app!.state.settings.data_dir)
  expect(report.enforcement).toBe('full')
  const processes = new ProcessManager(app!.state.settings, app!.state.conn, new AssetStore(app!.state.settings.assets_dir), runtime, report)
  try {
    const box = sandboxForWorkspace(app!.state.settings.data_dir, project, workspace, { network: false })
    const run = async (command: string) => {
      const x = await processes.start({ command, cwd: folder, sandbox: box, project_id: project.id, workspace_id: workspace.id })
      await processes.wait(x.id, 60)
      return processes.summary(x.id).exit_code
    }
    expect(await run('echo ok > plain.txt && echo ok > vendor/nested/plain.txt && echo "*.log" > vendor/nested/.gitignore')).toBe(0)
    expect(await run('echo x > .git/escape')).not.toBe(0)
    expect(await run('echo x > vendor/nested/.git/escape')).not.toBe(0)
    expect(await run('echo x > vendor/nested/.GIT/escape')).not.toBe(0)                    // the volume folds case: the same directory
    expect(await run('cd vendor/nested && git add -A && git commit -qm sandbox')).not.toBe(0)
    expect(await run('mkdir -p other && cd other && git init -q')).not.toBe(0)              // a new repository's metadata likewise
    expect(git(['rev-parse', 'HEAD'], nested).trim()).toBe(nestedHead)
    expect(existsSync(join(nested, '.git', 'escape'))).toBe(false)
    expect(readFileSync(join(nested, '.gitignore'), 'utf8')).toBe('*.log\n')
  } finally {
    await processes.shutdown()
  }
})
