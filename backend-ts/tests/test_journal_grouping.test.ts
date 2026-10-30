/** The journal's grouping of a folder edited in place, over long synthetic histories written through the production
 *  path (the file tool's journal.prepare, atomicWrite with the expected sha, journal.applied). Every read is checked
 *  against a model the test keeps of what it did — per path, in the order a path was first written, its writes in
 *  order, the first "before" and the last "after" — so a run's changes, the folder's standing changes, the status
 *  lists, the diff and Undo stay exactly what they were however many times one file is written. No timing is
 *  asserted here: the cost of the grouping is measured by scripts/perf_storage (journal phase). */

import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UndoResult, Workspace } from '@oasis-code/contract'
import { Settings } from '../src/config.ts'
import { connect, type Conn } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { atomicWrite, sha256Hex } from '../src/store.ts'
import { CHAIN_BROKEN, chainOf, fileNow, type FileChange } from '../src/workspace/journal.ts'
import { WorkspaceService } from '../src/workspace/service.ts'
import { tempDir } from './helpers.ts'

const closers: (() => void)[] = []
afterEach(() => { for (const close of closers.splice(0).reverse()) close() })

/** One applied write as the test made it: the model every read is checked against. */
interface Written { id: string; run: string; path: string; before: string | null; after: string }

interface Rig {
  conn: Conn
  service: WorkspaceService
  ws: Workspace
  sessionId: string
  log: Written[]
  /** the ids an undo took back */
  undone: Set<string>
  newRun(): string
  /** a file tool's write, as src/agent/tools/files.ts makes it */
  write(run: string, rel: string, text: string): Written
  /** a write kept first and then not made (the file changed under it): abandoned, never applied */
  abandon(run: string, rel: string, text: string): void
  undo(run: string): UndoResult
  disk(rel: string): string | null
}

async function rig(seed: Record<string, { text: string; mode?: number }>): Promise<Rig> {
  const folder = join(tempDir('oasis-journal-group-'), 'folder')
  mkdirSync(folder, { recursive: true })
  for (const [rel, f] of Object.entries(seed)) {
    mkdirSync(join(folder, rel, '..'), { recursive: true })
    writeFileSync(join(folder, rel), f.text)
    if (f.mode !== undefined) chmodSync(join(folder, rel), f.mode)
  }
  const settings = new Settings({ data_dir: join(tempDir('oasis-journal-data-'), 'data'), host: '127.0.0.1', port: 0, session_token: 'test-token' })
  mkdirSync(settings.data_dir, { recursive: true })
  const conn = connect(settings.db_path)
  const service = new WorkspaceService(settings, conn)
  closers.push(() => { service.close(); conn.close() })
  const project = await service.directProject('synthetic', folder)
  const session = repo.createSession(conn, project.id, 's', 'synthetic:model')
  const ws = await service.createWorkspace(project, session.id)
  const log: Written[] = []
  const undone = new Set<string>()
  let call = 0
  const disk = (rel: string): string | null => existsSync(join(ws.path, rel)) ? readFileSync(join(ws.path, rel), 'utf8') : null
  return {
    conn, service, ws, sessionId: session.id, log, undone, disk,
    newRun: () => repo.insertRun(conn, { session_id: session.id, project_id: project.id, workspace_id: ws.id, model: 'synthetic:model', model_config: {}, user_text: 'synthetic', status: 'running', budget: {} }).id,
    write(run, rel, text) {
      const data = Buffer.from(text)
      const now = fileNow(ws.path, rel)
      if (now.kind === 'unknown') throw new Error(`fixture: ${rel} cannot be read`)
      const before = now.kind === 'file' ? now.data : null
      call += 1
      const entry = service.journal.prepare(ws, { run_id: run, tool_call_id: `t${call}`, path: rel, action: before === null ? 'created' : 'edited', before, intended: data })
      if (before === null) mkdirSync(join(ws.path, rel, '..'), { recursive: true })
      atomicWrite(now.real, data, { expect: before === null ? { absent: true } : { sha256: sha256Hex(before) }, keep_mode: true })
      service.journal.applied(entry, data)
      const w = { id: entry.id, run, path: rel, before: before === null ? null : Buffer.from(before).toString('utf8'), after: text }
      log.push(w)
      return w
    },
    abandon(run, rel, text) {
      const now = fileNow(ws.path, rel)
      const before = now.kind === 'file' ? now.data : null
      call += 1
      const entry = service.journal.prepare(ws, { run_id: run, tool_call_id: `t${call}`, path: rel, action: before === null ? 'created' : 'edited', before, intended: Buffer.from(text) })
      service.journal.abandoned(entry)
    },
    undo(run) {
      // what Undo should do, from the model, before it runs: the file as the run left it is put back, else named
      const expected = expectedUndo(log, undone, run, disk)
      const result = service.journal.undoRun(ws, run, session.id)
      expect(result).toEqual(expected.result)
      for (const id of expected.takenBack) undone.add(id)
      return result
    },
  }
}

/** The paths of `writes` in the order each was first written, with its writes in order (a plain scan, not a map). */
function byFirstWrite(writes: Written[]): { path: string; list: Written[] }[] {
  const paths: string[] = []
  for (const w of writes) if (!paths.includes(w.path)) paths.push(w.path)
  return paths.map((path) => ({ path, list: writes.filter((w) => w.path === path) }))
}

interface Seen { path: string; before: string | null; after: string | null; created: boolean; ids: string[] }
const text = (data: Uint8Array | null): string | null => (data === null ? null : Buffer.from(data).toString('utf8'))
const seen = (changes: FileChange[]): Seen[] => changes.map((c) => ({ path: c.path, before: text(c.before), after: text(c.after), created: c.created, ids: c.entries.map((e) => e.id) }))

/** A run's changes: every applied write of the run (an undo does not take them out of the run's record). */
function expectedRun(log: Written[], run: string): Seen[] {
  return byFirstWrite(log.filter((w) => w.run === run))
    .map(({ path, list }) => ({ path, before: list[0]!.before, after: list[list.length - 1]!.after, created: list[0]!.before === null, ids: list.map((w) => w.id), broken: broken(list) }))
    .filter((c) => c.before !== c.after || c.created || c.broken)
    .map(({ broken: _broken, ...c }) => c)
}

/** Whether a file's writes of one run do not chain: one found the file other than as the previous one left it. */
function broken(list: Written[]): boolean {
  return list.some((w, i) => i > 0 && w.before !== list[i - 1]!.after)
}

/** The folder's standing changes: the writes no undo took back, against the file as it is now. */
function expectedFolder(log: Written[], undone: Set<string>, disk: (rel: string) => string | null): Seen[] {
  return byFirstWrite(log.filter((w) => !undone.has(w.id)))
    .map(({ path, list }) => ({ path, before: list[0]!.before, after: disk(path), created: list[0]!.before === null, ids: list.map((w) => w.id) }))
    .filter((c) => c.before !== c.after)
}

function expectedUndo(log: Written[], undone: Set<string>, run: string, disk: (rel: string) => string | null): { result: UndoResult; takenBack: string[] } {
  const standing = log.filter((w) => w.run === run && !undone.has(w.id))
  const result: UndoResult = { run_id: run, restored: [], removed: [], conflicts: [], nothing: standing.length === 0 }
  const takenBack: string[] = []
  for (const { path, list } of byFirstWrite(standing)) {
    const now = disk(path)
    // another hand between two of the run's writes: the whole path is left alone
    if (broken(list)) { result.conflicts.push({ path, reason: CHAIN_BROKEN, code: 'chain_broken' }); continue }
    if (now !== list[list.length - 1]!.after) { result.conflicts.push(now === null ? { path, reason: 'removed since the run wrote it', code: 'removed_since' } : { path, reason: 'changed since the run wrote it', code: 'changed_since' }); continue }
    if (list[0]!.before === null) result.removed.push(path)
    else result.restored.push(path)
    takenBack.push(...list.map((w) => w.id))
  }
  return { result, takenBack }
}

const modeOf = (r: Rig, rel: string) => statSync(join(r.ws.path, rel)).mode & 0o777

/** Every read the page and the run's receipt make, against the model. */
async function agrees(r: Rig, runs: string[]): Promise<void> {
  for (const run of runs) expect(seen(r.service.journal.runChanges(run))).toEqual(expectedRun(r.log, run))
  const folder = expectedFolder(r.log, r.undone, r.disk)
  expect(seen(r.service.journal.folderChanges(r.ws))).toEqual(folder)
  const status = await r.service.status(r.ws)
  expect(status.modified).toEqual(folder.filter((c) => c.before !== null && c.after !== null).map((c) => c.path))
  expect(status.added).toEqual(folder.filter((c) => c.before === null).map((c) => c.path))
  expect(status.deleted).toEqual(folder.filter((c) => c.after === null).map((c) => c.path))
  const diff = await r.service.diff(r.ws)
  expect(diff.files.map((f) => f.path)).toEqual(folder.map((c) => c.path).sort((a, b) => a.localeCompare(b)))
}

test('interleaved writes of several runs: per file the first write\'s "before" and the last one\'s "after", files in the order first written, through undo, a person\'s edits and a file made again', async () => {
  const r = await rig({ 'a.txt': { text: 'a0\n' }, 'dir/b.txt': { text: 'b0\n', mode: 0o640 }, 'tool.sh': { text: '#!/bin/sh\necho 0\n', mode: 0o755 }, 'same.txt': { text: 's0\n' } })
  const A = r.newRun()
  const B = r.newRun()
  const order = ['dir/b.txt', 'a.txt', 'new/x.txt', 'tool.sh', 'a.txt', 'same.txt', 'dir/b.txt', 'a.txt']
  for (let i = 0; i < 160; i += 1) {
    const path = order[i % order.length]!
    r.write(A, path, path === 'tool.sh' ? `#!/bin/sh\necho ${i}\n` : `${path} ${i}\n`)
    if (i === 37) r.abandon(A, 'a.txt', 'never written\n')
    if (i % 41 === 0) r.write(B, 'b-only.txt', `b-only ${i}\n`)
  }
  r.write(A, 'same.txt', 's0\n') // back as it was: no change of the run's, and none of the folder's
  r.write(A, 'once.txt', 'written once\n') // one write: its first is its last
  r.write(B, 'a.txt', 'B over A\n')
  expect(r.log.filter((w) => w.path === 'a.txt' && w.run === A)).toHaveLength(60)
  expect(expectedRun(r.log, A).map((c) => c.path)).toEqual(['dir/b.txt', 'a.txt', 'new/x.txt', 'tool.sh', 'once.txt'])
  await agrees(r, [A, B])

  // the person's own edit: Undo leaves that file alone, takes the others back, files in the order first written
  writeFileSync(join(r.ws.path, 'dir/b.txt'), 'the person\'s edit\n')
  const undoA = r.undo(A)
  expect(undoA.conflicts.map((c) => c.path)).toEqual(['dir/b.txt', 'a.txt'])
  expect(undoA.removed).toEqual(['new/x.txt', 'once.txt'])
  expect(undoA.restored).toEqual(['tool.sh', 'same.txt'])
  expect(r.disk('new/x.txt')).toBeNull()
  expect(r.disk('tool.sh')).toBe('#!/bin/sh\necho 0\n')
  expect(modeOf(r, 'tool.sh')).toBe(0o755)
  expect(modeOf(r, 'dir/b.txt')).toBe(0o640)
  await agrees(r, [A, B])

  // B's undo puts a.txt back as A left it; A's own writes of it still stand
  r.undo(B)
  expect(r.disk('a.txt')).toBe(r.log.filter((w) => w.path === 'a.txt' && w.run === A).at(-1)!.after)
  await agrees(r, [A, B])

  // made again by a later run after Undo removed it: created, from nothing, at its new place in the order
  const C = r.newRun()
  for (let i = 0; i < 3; i += 1) r.write(C, 'new/x.txt', `again ${i}\n`)
  await agrees(r, [A, B, C])

  // removed by the person: shown deleted, and Undo says so
  unlinkSync(join(r.ws.path, 'a.txt'))
  await agrees(r, [A, B, C])
  r.undo(A)
  r.undo(C)
  await agrees(r, [A, B, C])
  expect(r.undo(C).nothing).toBe(true)
})

test('a long history of one file (hundreds of tool calls) keeps every write in order and goes back whole on Undo, its mode kept', async () => {
  const r = await rig({ 'long.md': { text: '# long\n', mode: 0o600 }, 'other.txt': { text: 'o\n' } })
  const run = r.newRun()
  for (let i = 0; i < 400; i += 1) {
    r.write(run, 'long.md', `# long\n${'line\n'.repeat(i % 7)}write ${i}\n`)
    if (i % 100 === 99) r.write(run, `spread/${i}.txt`, `${i}\n`)
  }
  r.write(run, 'other.txt', 'o2\n')
  const changes = r.service.journal.runChanges(run)
  expect(changes.map((c) => c.path)).toEqual(['long.md', 'spread/99.txt', 'spread/199.txt', 'spread/299.txt', 'spread/399.txt', 'other.txt'])
  expect(changes[0]!.entries).toHaveLength(400)
  await agrees(r, [run])
  const diff = await r.service.diff(r.ws)
  expect(diff.files.find((f) => f.path === 'long.md')).toEqual({ path: 'long.md', added: 1 + (399 % 7), removed: 0 })
  const before = seen(changes)
  const undo = r.undo(run)
  expect(undo.restored).toEqual(['long.md', 'other.txt'])
  expect(r.disk('long.md')).toBe('# long\n')
  expect(modeOf(r, 'long.md')).toBe(0o600)
  // the run's record is the same after Undo; the folder has nothing standing
  expect(seen(r.service.journal.runChanges(run))).toEqual(before)
  expect(r.service.journal.folderChanges(r.ws)).toEqual([])
  await agrees(r, [run])
  expect(r.undo(run).nothing).toBe(true)
})

test('each read gives its own lists: changing what one call returned changes no other call, no other file, and not Undo', async () => {
  const r = await rig({ 'a.txt': { text: 'a\n' }, 'b.txt': { text: 'b\n' } })
  const run = r.newRun()
  for (let i = 0; i < 6; i += 1) { r.write(run, 'a.txt', `a${i}\n`); r.write(run, 'b.txt', `b${i}\n`) }
  const first = r.service.journal.runChanges(run)
  const snapshot = seen(first)
  const again = r.service.journal.runChanges(run)
  expect(first[0]!.entries).not.toBe(again[0]!.entries)
  expect(first[0]!.entries).not.toBe(first[1]!.entries)
  for (const c of first) expect(c.entries.every((e) => e.path === c.path)).toBe(true)
  // what a caller does to a returned list stays in that list
  first[0]!.entries.reverse()
  first[0]!.entries.push(first[1]!.entries[0]!)
  first[1]!.entries.length = 0
  expect(seen(again)).toEqual(snapshot)
  expect(seen(r.service.journal.runChanges(run))).toEqual(snapshot)
  const folder = r.service.journal.folderChanges(r.ws)
  folder[0]!.entries.splice(0)
  expect(seen(r.service.journal.folderChanges(r.ws))).toEqual(expectedFolder(r.log, r.undone, r.disk))
  r.undo(run)
  expect(r.disk('a.txt')).toBe('a\n')
  expect(r.disk('b.txt')).toBe('b\n')
  await agrees(r, [run])
})

test('a write between two of a run\'s writes (another hand: a command still running, the person) breaks the chain: the whole path is not the run\'s, and Undo leaves it with chain_broken', async () => {
  const r = await rig({ 'shared.txt': { text: 's0\n' }, 'own.txt': { text: 'o0\n' }, 'abandoned.txt': { text: 'x0\n' } })
  const run = r.newRun()
  r.write(run, 'shared.txt', 's1\n')
  r.write(run, 'own.txt', 'o1\n')
  // a background writer changes the file between the run's two writes of it
  writeFileSync(join(r.ws.path, 'shared.txt'), 'background\n')
  r.write(run, 'shared.txt', 'background\nand the run\n')
  // an abandoned write in the middle is no write: it does not break the chain
  r.write(run, 'abandoned.txt', 'x1\n')
  r.abandon(run, 'abandoned.txt', 'never\n')
  r.write(run, 'abandoned.txt', 'x2\n')
  r.write(run, 'own.txt', 'o2\n')
  const changes = r.service.journal.runChanges(run)
  expect(changes.map((c) => [c.path, c.chain])).toEqual([['shared.txt', 'broken'], ['own.txt', 'intact'], ['abandoned.txt', 'intact']])
  const attributed = r.service.journal.runAttributed(run)
  expect(attributed.changes.map((c) => c.path)).toEqual(['own.txt', 'abandoned.txt'])
  expect(attributed.unattributed).toEqual(['shared.txt'])
  expect(seen(changes)).toEqual(expectedRun(r.log, run))
  const undo = r.undo(run)
  expect(undo.conflicts).toEqual([{ path: 'shared.txt', reason: CHAIN_BROKEN, code: 'chain_broken' }])
  expect(undo.restored).toEqual(['own.txt', 'abandoned.txt'])
  // the background's bytes and the run's last write stand: nothing of the path was put back
  expect(r.disk('shared.txt')).toBe('background\nand the run\n')
  expect(r.disk('own.txt')).toBe('o0\n')
})

test('a chain is judged on the writes alone: same bytes before and after (ABA by another hand) cannot be seen, and a removal chains to absence', () => {
  const e = (before_sha: string | null, after_sha: string | null) => ({ before_sha, after_sha })
  expect(chainOf([])).toBe('intact')
  expect(chainOf([e('a', 'b')])).toBe('intact')
  expect(chainOf([e('a', 'b'), e('b', null), e(null, 'c')])).toBe('intact')
  expect(chainOf([e('a', 'b'), e('c', 'd')])).toBe('broken')
  expect(chainOf([e(null, 'b'), e(null, 'c')])).toBe('broken')
})
