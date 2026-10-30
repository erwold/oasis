/** A folder edited in place when things go wrong: the harness stopped inside a file-tool write (a real process killed
 *  between the journal's keeping and its marking), the person's own hand on the folder meanwhile, a file that cannot
 *  be read, a folder gone offline, an undo stopped half way, the folder opened twice or swapped for a link. The
 *  journal never takes a change it cannot prove for the run's, and Undo never writes over what the harness did not
 *  write. */

import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Run, UndoResult } from '@oasis-code/contract'
import { Settings } from '../src/config.ts'
import * as repo from '../src/db/repo.ts'
import { modelResponse, textPart, toolCallPart, type ModelMessage } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { atomicWrite, sha256Hex } from '../src/store.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { FAKE_FULL, PassthroughRuntime, scriptedModel, setModel, sleep, waitDone } from './harness.ts'
import { tempDir } from './helpers.ts'

const MODEL = 'scripted:a'
const BEFORE = '# rig\nstep one\n'
const AGENT = 'AGENT WROTE THIS\n'
const PERSON = 'THE PERSON WROTE THIS IN THEIR EDITOR\n'

let app: App | null = null
const cleanups: (() => void)[] = []
afterEach(async () => {
  if (app) await app.close()
  app = null
  for (const cleanup of cleanups.splice(0).reverse()) { try { cleanup() } catch { /* restored already */ } }
})

function folderFixture(): string {
  const folder = join(tempDir('oasis-direct-'), 'folder')
  mkdirSync(join(folder, 'notes'), { recursive: true })
  writeFileSync(join(folder, 'README.md'), BEFORE)
  writeFileSync(join(folder, 'notes', 'plan.txt'), 'bones: 0\n')
  return folder
}

function newSettings(): Settings {
  return new Settings({ data_dir: join(tempDir('oasis-data-'), 'data'), host: '127.0.0.1', port: 0, session_token: 'test-token' })
}

interface Stopped { settings: Settings; folder: string; ids: { workspace_id: string; run_id: string; entry_id: string } }

/** A real backend killed inside the run's second write of `target` (journal_crash_child.ts): after its bytes landed
 *  (`written`) or before. */
function stoppedInWrite(target: string, written: boolean): Stopped {
  const folder = folderFixture()
  const settings = newSettings()
  const out = join(tempDir('oasis-crash-'), 'ids.json')
  const child = spawnSync('bun', ['--preload', './tests/preload.ts', join(import.meta.dir, 'journal_crash_child.ts')], {
    cwd: join(import.meta.dir, '..'), encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, JOURNAL_CRASH: JSON.stringify({ data_dir: settings.data_dir, folder, target, written, agent_text: AGENT, out }) },
  })
  expect(child.signal, child.stderr).toBe('SIGKILL')
  return { settings, folder, ids: JSON.parse(readFileSync(out, 'utf8')) }
}

/** The next start on the same data directory, as main does it; then what the page reads of the run. */
async function restart(k: Stopped) {
  app = await makeApp(k.settings, { probe: false })
  await app.start()
  const c = new Client(app)
  const entry = repo.getJournalEntry(app.state.conn, k.ids.entry_id)!
  const runDiff = await json<{ files: { path: string }[]; patch: string }>(await c.get(`/api/runs/${k.ids.run_id}/diff`))
  return { c, entry, runDiff }
}

const undo = async (c: Client, runId: string) => json<UndoResult>(await c.post(`/api/runs/${runId}/undo`))

/** The model plays its steps in order. */
function playing(steps: ((messages: ModelMessage[]) => ReturnType<typeof modelResponse>)[]) {
  let n = 0
  return (messages: ModelMessage[]) => { const step = steps[n] ?? (() => modelResponse([textPart('done')])); n += 1; return step(messages) }
}

async function openFolder(folder: string, settings = newSettings(), opts: { commands?: boolean } = {}) {
  app = await makeApp(settings, opts.commands ? { probe: false, runtime: new PassthroughRuntime(), isolation: { ...FAKE_FULL, runtime: 'passthrough' } } : { probe: false })
  await app.start()
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: folder, mode: 'direct' }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'in place' }))
  return { c, settings, sid: s.id as string, wsId: (s.workspace as { id: string }).id }
}

test('a write the harness was stopped in settles by the file: not made → abandoned; made as meant → the run\'s, and Undo takes it back', async () => {
  const notMade = stoppedInWrite('README.md', false)
  let r = await restart(notMade)
  expect(r.entry.state).toBe('abandoned')
  expect(await undo(r.c, notMade.ids.run_id)).toMatchObject({ restored: [], removed: ['made_by_run.txt'], conflicts: [] })
  expect(readFileSync(join(notMade.folder, 'README.md'), 'utf8')).toBe(BEFORE)
  await app!.close()
  app = null

  const made = stoppedInWrite('README.md', true)
  r = await restart(made)
  expect(r.entry).toMatchObject({ state: 'applied', after_sha: sha256Hex(Buffer.from(AGENT)), intended_sha: sha256Hex(Buffer.from(AGENT)) })
  expect(await undo(r.c, made.ids.run_id)).toMatchObject({ restored: ['README.md'], removed: ['made_by_run.txt'], conflicts: [] })
  expect(readFileSync(join(made.folder, 'README.md'), 'utf8')).toBe(BEFORE)
})

test('what the person did to the file while the harness was stopped is not the run\'s: unsettled, in no diff of the run, and left alone by Undo', async () => {
  const cases: { name: string; target: string; written: boolean; meanwhile: (path: string) => void; after: string | null }[] = [
    { name: 'edited, the write never made', target: 'README.md', written: false, meanwhile: (p) => writeFileSync(p, PERSON), after: PERSON },
    { name: 'edited after the write was made', target: 'README.md', written: true, meanwhile: (p) => writeFileSync(p, PERSON), after: PERSON },
    { name: 'deleted', target: 'README.md', written: false, meanwhile: (p) => unlinkSync(p), after: null },
    { name: 'created where the run meant to create it', target: 'new.txt', written: false, meanwhile: (p) => writeFileSync(p, PERSON), after: PERSON },
  ]
  for (const one of cases) {
    const k = stoppedInWrite(one.target, one.written)
    const path = join(k.folder, one.target)
    one.meanwhile(path)
    const r = await restart(k)
    expect(r.entry.state, one.name).toBe('unsettled')
    expect(r.entry.after_sha, one.name).toBeNull()
    expect(r.runDiff.files.map((f) => f.path), one.name).toEqual(['made_by_run.txt'])
    expect(r.runDiff.patch, one.name).not.toContain('deleted file mode')
    const result = await undo(r.c, k.ids.run_id)
    expect(result.removed, one.name).toEqual(['made_by_run.txt'])
    expect(result.restored, one.name).toEqual([])
    expect(result.conflicts, one.name).toEqual([{ path: one.target, reason: expect.stringContaining('neither as it was nor as the run meant to write it'), code: 'unsettled' }])
    expect(existsSync(path) ? readFileSync(path, 'utf8') : null, one.name).toBe(one.after)
    await app!.close()
    app = null
  }
})

test('the receipt of a run that died, its diff and its journal agree on the files it wrote', async () => {
  const k = stoppedInWrite('README.md', true)
  const r = await restart(k)
  const receipt = (await json<{ receipt: { status: string; produced: { workspace_id: string; files_changed: string[] }; mechanical: { diff: Record<string, unknown> } } }>(await r.c.get(`/api/runs/${k.ids.run_id}/receipt`))).receipt
  const journalled = repo.listJournal(app!.state.conn, { run_id: k.ids.run_id }).map((e) => e.path).sort()
  expect(journalled).toEqual(['README.md', 'made_by_run.txt'])
  expect(receipt.status).toBe('lost')
  expect(receipt.produced.workspace_id).toBe(k.ids.workspace_id)
  expect([...receipt.produced.files_changed].sort()).toEqual(journalled)
  expect(receipt.mechanical.diff).toMatchObject({ files: 2, in_place: true })
  expect(r.runDiff.files.map((f) => f.path).sort()).toEqual(journalled)
})

test('a stopped write whose file cannot be read waits to be settled: Undo leaves the file and says why, and settles it once it can be read', async () => {
  const k = stoppedInWrite('README.md', true)
  const readme = join(k.folder, 'README.md')
  writeFileSync(readme, PERSON)
  chmodSync(readme, 0o000)
  cleanups.push(() => chmodSync(readme, 0o644))
  const r = await restart(k)
  expect(r.entry).toMatchObject({ state: 'prepared', after_sha: null })         // not "no file": nothing is known yet
  const first = await undo(r.c, k.ids.run_id)
  expect(first).toMatchObject({ restored: [], removed: ['made_by_run.txt'] })
  expect(first.conflicts).toEqual([{ path: 'README.md', reason: 'the harness stopped while writing it, and it cannot be read to tell whether the write happened', code: 'unsettled' }])
  chmodSync(readme, 0o644)
  const second = await undo(r.c, k.ids.run_id)
  expect(repo.getJournalEntry(app!.state.conn, k.ids.entry_id)!.state).toBe('unsettled')
  expect(second.conflicts.map((x) => x.path)).toEqual(['README.md'])
  expect(readFileSync(readme, 'utf8')).toBe(PERSON)
})

test('a file the run wrote that cannot be read later is not a file removed: the diff shows the change as the tools left it, Undo leaves it and says why', async () => {
  const folder = folderFixture()
  const o = await openFolder(folder)
  setModel(app!.state, MODEL, scriptedModel(playing([
    () => modelResponse([toolCallPart('write_file', { path: 'made.txt', content: 'made\n' }, 'w1')]),
    () => modelResponse([toolCallPart('read_file', { path: 'README.md' }, 'r1')]),
    () => modelResponse([toolCallPart('edit_file', { path: 'README.md', old_string: 'step one', new_string: 'STEP ONE' }, 'e1')]),
  ])))
  const run = await waitDone(app!.state, (await json<Run>(await o.c.post(`/api/sessions/${o.sid}/chat`, { text: 'go' }))).id)
  const made = join(folder, 'made.txt')
  chmodSync(made, 0o000)
  cleanups.push(() => chmodSync(made, 0o644))
  const diff = await json<{ patch: string; files: { path: string }[] }>(await o.c.get(`/api/workspaces/${o.wsId}/diff`))
  expect(diff.patch).not.toContain('deleted file mode')
  expect(diff.files.map((f) => f.path).sort()).toEqual(['README.md', 'made.txt'])
  const detail = await json<{ status: { deleted: string[] } }>(await o.c.get(`/api/workspaces/${o.wsId}`))
  expect(detail.status.deleted).toEqual([])
  const result = await undo(o.c, run.id)
  expect(result).toMatchObject({ restored: ['README.md'], removed: [], conflicts: [{ path: 'made.txt', reason: 'it cannot be read (EACCES)' }] })
  chmodSync(made, 0o644)
  expect(readFileSync(made, 'utf8')).toBe('made\n')
})

test('a folder offline: the app starts, the stopped write waits, the diff and Undo say the folder cannot be reached (no error, no deletion)', async () => {
  const k = stoppedInWrite('README.md', true)
  const moved = k.folder + '.offline'
  renameSync(k.folder, moved)
  cleanups.push(() => renameSync(moved, k.folder))
  const r = await restart(k)
  expect(r.entry).toMatchObject({ state: 'prepared', after_sha: null })
  const diff = await r.c.get(`/api/workspaces/${k.ids.workspace_id}/diff`)
  expect(diff.status).toBe(409)
  expect(await diff.text()).toContain('cannot be reached where it was opened')
  const detail = await json<{ status: { deleted: string[]; unreachable?: string } }>(await r.c.get(`/api/workspaces/${k.ids.workspace_id}`))
  expect(detail.status.deleted).toEqual([])
  expect(detail.status.unreachable).toContain('cannot be reached where it was opened')
  const result = await undo(r.c, k.ids.run_id)
  expect(result.restored).toEqual([])
  expect(result.removed).toEqual([])
  expect(Object.fromEntries(result.conflicts.map((x) => [x.path, x.reason]))).toEqual({
    'README.md': 'the harness stopped while writing it, and it cannot be read to tell whether the write happened',
    'made_by_run.txt': expect.stringContaining('cannot be reached where it was opened'),
  })
  // back online: the write settles as the run's, and Undo takes the run back
  renameSync(moved, k.folder)
  cleanups.pop()
  expect(await undo(r.c, k.ids.run_id)).toMatchObject({ restored: ['README.md'], removed: ['made_by_run.txt'], conflicts: [] })
  expect(repo.getJournalEntry(app!.state.conn, k.ids.entry_id)!.state).toBe('applied')
  expect(readFileSync(join(k.folder, 'README.md'), 'utf8')).toBe(BEFORE)
})

test('a file-tool write keeps what it means to leave before it writes: the entry\'s intended sha is the written file\'s', async () => {
  const folder = folderFixture()
  const o = await openFolder(folder)
  setModel(app!.state, MODEL, scriptedModel(playing([() => modelResponse([toolCallPart('write_file', { path: 'fresh.txt', content: 'x\n' }, 'w1')])])))
  const run = await waitDone(app!.state, (await json<Run>(await o.c.post(`/api/sessions/${o.sid}/chat`, { text: 'go' }))).id)
  const [entry] = repo.listJournal(app!.state.conn, { run_id: run.id })
  expect(entry).toMatchObject({ state: 'applied', intended_sha: sha256Hex(Buffer.from('x\n')), after_sha: sha256Hex(Buffer.from('x\n')) })
})

test('an undo stopped anywhere is settled at the next start: the run\'s changes read undone exactly when the files went back, and a second Undo agrees', async () => {
  for (const stage of ['kept', 'written', 'marked'] as const) {
    const folder = folderFixture()
    const o = await openFolder(folder)
    setModel(app!.state, MODEL, scriptedModel(playing([
      () => modelResponse([toolCallPart('read_file', { path: 'README.md' }, 'r1')]),
      () => modelResponse([toolCallPart('edit_file', { path: 'README.md', old_string: 'step one', new_string: 'STEP ONE' }, 'e1')]),
      () => modelResponse([toolCallPart('write_file', { path: 'notes/new.md', content: 'made by the run\n' }, 'w1')]),
    ])))
    const run = await waitDone(app!.state, (await json<Run>(await o.c.post(`/api/sessions/${o.sid}/chat`, { text: 'go' }))).id)
    const conn = app!.state.conn
    const journal = app!.state.workspaces.journal
    const ws = repo.getWorkspace(conn, o.wsId)!
    const entries = repo.listJournal(conn, { run_id: run.id })
    const readme = entries.find((e) => e.path === 'README.md')!
    const created = entries.find((e) => e.path === 'notes/new.md')!
    // undoRun's steps, as it takes them, up to `stage`; then the process is gone
    const putBack = journal.prepare(ws, { session_id: o.sid, run_id: null, tool_call_id: null, path: 'README.md', action: 'restored', before: readFileSync(join(folder, 'README.md')), intended: Buffer.from(BEFORE), undoes: [readme.id] })
    const takenAway = journal.prepare(ws, { session_id: o.sid, run_id: null, tool_call_id: null, path: 'notes/new.md', action: 'removed', before: readFileSync(join(folder, 'notes/new.md')), intended: null, undoes: [created.id] })
    if (stage !== 'kept') {
      atomicWrite(join(folder, 'README.md'), Buffer.from(BEFORE), { expect: { sha256: readme.after_sha! }, keep_mode: true })
      unlinkSync(join(folder, 'notes/new.md'))
    }
    if (stage === 'marked') { journal.applied(putBack, Buffer.from(BEFORE)); journal.applied(takenAway, null) }
    await app!.close()
    app = await makeApp(o.settings, { probe: false })
    await app.start()
    const c = new Client(app)
    const settled = [putBack, takenAway].map((e) => repo.getJournalEntry(app!.state.conn, e.id)!.state)
    const undoneBy = repo.listJournal(app.state.conn, { run_id: run.id }).map((e) => e.undone_by)
    if (stage === 'kept') {
      expect(settled, stage).toEqual(['abandoned', 'abandoned'])
      expect(undoneBy, stage).toEqual([null, null])                              // nothing went back: the run's changes stand
      expect(await undo(c, run.id), stage).toMatchObject({ restored: ['README.md'], removed: ['notes/new.md'], conflicts: [] })
    } else {
      expect(settled, stage).toEqual(['applied', 'applied'])
      expect(undoneBy, stage).toEqual([putBack.id, takenAway.id])
      expect((await json<{ files: unknown[] }>(await c.get(`/api/workspaces/${o.wsId}/diff`))).files, stage).toEqual([])
      expect(await undo(c, run.id), stage).toMatchObject({ restored: [], removed: [], conflicts: [], nothing: true })
    }
    expect(readFileSync(join(folder, 'README.md'), 'utf8'), stage).toBe(BEFORE)
    expect(existsSync(join(folder, 'notes/new.md')), stage).toBe(false)
    await app.close()
    app = null
  }
})

test('one real folder opened as two direct projects (through a link) is written by one run at a time', async () => {
  const folder = folderFixture()
  const link = join(tempDir('oasis-alias-'), 'alias')
  symlinkSync(folder, link)
  const a = await openFolder(folder)
  const viaLink = await json(await a.c.post('/api/projects', { source_path: link, mode: 'direct' }))
  const b = await json(await a.c.post(`/api/projects/${viaLink.id}/sessions`, { title: 'alias' }))
  const wsB = b.workspace as { id: string; path: string }
  expect(wsB.id).not.toBe(a.wsId)
  expect(wsB.path).toBe(folder)
  let active = 0
  let overlapped = false
  setModel(app!.state, MODEL, scriptedModel(async (messages: ModelMessage[]) => {
    const text = JSON.stringify(messages)
    const who = text.includes('from A') ? 'A' : 'B'
    if (text.includes('"tool_name":"write_file"')) { active -= 1; return modelResponse([textPart(`${who} done`)]) }
    active += 1
    if (active > 1) overlapped = true
    await sleep(200)
    return modelResponse([toolCallPart('write_file', { path: `from_${who}.txt`, content: `${who}\n` }, `w${who}`)])
  }))
  const ra = await json<Run>(await a.c.post(`/api/sessions/${a.sid}/chat`, { text: 'from A' }))
  const rb = await json<Run>(await a.c.post(`/api/sessions/${b.id}/chat`, { text: 'from B' }))
  await sleep(50)
  expect(app!.state.locks.holder(wsB.id)).toBe(ra.id)                            // B's workspace reads A's run as the folder's writer
  await waitDone(app!.state, ra.id)
  await waitDone(app!.state, rb.id)
  expect(overlapped).toBe(false)
  expect(readFileSync(join(folder, 'from_A.txt'), 'utf8')).toBe('A\n')
  expect(readFileSync(join(folder, 'from_B.txt'), 'utf8')).toBe('B\n')
})

test('a folder moved away and a link put in its place is not followed: the next run writes nothing through it, reads refuse it', async () => {
  const folder = folderFixture()
  const outside = join(tempDir('oasis-outside-'), 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'README.md'), BEFORE)
  const o = await openFolder(folder)
  renameSync(folder, folder + '.moved')
  symlinkSync(outside, folder)
  cleanups.push(() => { rmSync(folder); renameSync(folder + '.moved', folder) })
  setModel(app!.state, MODEL, scriptedModel(playing([
    () => modelResponse([toolCallPart('write_file', { path: 'after_swap.txt', content: 'x\n' }, 'w1')]),
    () => modelResponse([textPart('ok')]),
  ])))
  const run = await waitDone(app!.state, (await json<Run>(await o.c.post(`/api/sessions/${o.sid}/chat`, { text: 'go' }))).id)
  expect(run.status).toBe('error')
  expect(run.error).toContain('is a link now')
  expect(existsSync(join(outside, 'after_swap.txt'))).toBe(false)
  expect(readFileSync(join(outside, 'README.md'), 'utf8')).toBe(BEFORE)
  const read = await o.c.get(`/api/workspaces/${o.wsId}/file`, { path: 'README.md' })
  expect(read.status).toBe(409)
  expect(await read.text()).toContain('is a link now')
})

test('a command sent through the connector takes the folder\'s write lock: refused while a run writes, held while it runs, released after', async () => {
  const folder = folderFixture()
  const o = await openFolder(folder, newSettings(), { commands: true })
  await app!.state.locks.acquire(o.wsId, 'run_other')
  const refused = await o.c.post(`/api/workspaces/${o.wsId}/commands`, { command: 'echo no > refused.txt', wait_s: 5 })
  expect(refused.status).toBe(409)
  expect(await refused.text()).toContain('run_other')
  expect(existsSync(join(folder, 'refused.txt'))).toBe(false)
  app!.state.locks.release(o.wsId, 'run_other')
  const pending = o.c.post(`/api/workspaces/${o.wsId}/commands`, { command: 'sleep 0.5 && echo yes > ran.txt', wait_s: 10 })
  let holder: string | null = null
  for (let i = 0; i < 100 && holder === null; i += 1) { holder = app!.state.locks.holder(o.wsId); if (holder === null) await sleep(10) }
  expect(holder).toStartWith('command:')
  expect((await json(await pending)).exit_code).toBe(0)
  expect(readFileSync(join(folder, 'ran.txt'), 'utf8')).toBe('yes\n')
  expect(app!.state.locks.holder(o.wsId)).toBeNull()
})
