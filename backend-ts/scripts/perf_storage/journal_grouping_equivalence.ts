/** The functional half of the FileJournal grouping A/B: one seeded synthetic history played through the production
 *  path of a folder edited in place (WorkspaceService.directProject / createWorkspace; each tool write as
 *  src/agent/tools/files.ts makes it: journal.prepare, atomicWrite with the expected sha, journal.applied), with
 *  writes kept and abandoned, a person's edits, removals and mode changes, and Undo of earlier runs — then, at fixed
 *  points, every read made of it: FileJournal.runChanges of each run, folderChanges, WorkspaceService.status and
 *  diff, diffOf(full), and each undoRun's result, with the folder's files and modes.
 *
 *  The reads are written out canonically (ids as the order the journal kept them, bytes as sha-256, no timestamp)
 *  and digested. Played by the same script in the base tree and in the fix tree, the two digests must be equal
 *  before any timing is compared (journal_grouping_ab.sh). Only the scratch folder is written; the content is
 *  synthetic.
 *
 *  Env: PERF_SCRATCH, PERF_OUT, PERF_EQUIV_SEED (default 20261018), PERF_EQUIV_STEPS (default 3000),
 *  PERF_EQUIV_KEEP_CANONICAL=1 (also write the canonical record itself). */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { JournalEntry, Workspace } from '@oasis-code/contract'
import { Settings } from '../../src/config.ts'
import { connect } from '../../src/db/database.ts'
import * as repo from '../../src/db/repo.ts'
import { atomicWrite, sha256Hex } from '../../src/store.ts'
import { fileNow, type FileChange } from '../../src/workspace/journal.ts'
import { WorkspaceService } from '../../src/workspace/service.ts'
import { dirFromEnv, fingerprint, intFromEnv, main, writeResult } from './common.ts'

const PATHS = ['a.txt', 'b.txt', 'dir/c.txt', 'dir/sub/d.txt', 'e.bin', 'f.txt', 'g.md', 'h/i.txt', 'big.txt']
const HOT = 'hot.txt'
const MODES = [0o600, 0o644, 0o755]

/** mulberry32: a small seeded generator, the same sequence on every machine. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const sha = (data: Uint8Array | null): string | null => (data === null ? null : sha256Hex(data))
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')

main(async () => {
  const scratch = dirFromEnv('PERF_SCRATCH')
  const seed = intFromEnv('PERF_EQUIV_SEED', 20261018)
  const steps = intFromEnv('PERF_EQUIV_STEPS', 3000)
  const root = join(scratch, `journal-equivalence-${seed}`)
  rmSync(root, { recursive: true, force: true })
  const folder = join(root, 'folder')
  mkdirSync(folder, { recursive: true })
  for (const p of PATHS.slice(0, 5)) { mkdirSync(dirname(join(folder, p)), { recursive: true }); writeFileSync(join(folder, p), `seed:${p}\n`) }
  chmodSync(join(folder, 'b.txt'), 0o755)
  const settings = new Settings({ data_dir: join(root, 'data'), config_path: join(root, 'config.json') })
  const conn = connect(settings.db_path)
  const service = new WorkspaceService(settings, conn)
  const project = await service.directProject('synthetic', folder)
  const session = repo.createSession(conn, project.id, 's', 'synthetic:model')
  const ws: Workspace = await service.createWorkspace(project, session.id)
  const random = rng(seed)
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)]!
  const runs: string[] = []
  const newRun = () => { runs.push(repo.insertRun(conn, { session_id: session.id, project_id: project.id, workspace_id: ws.id, model: 'synthetic:model', model_config: {}, user_text: 'synthetic', status: 'running', budget: {} }).id); return runs[runs.length - 1]! }
  let run = newRun()

  // ids as the order the journal kept them (rowid), runs as the order they were made
  const ordinal = (): Map<string, number> => new Map((conn.all('SELECT id FROM file_journal ORDER BY rowid') as { id: string }[]).map((r, i) => [r.id, i]))
  const runOrd = (id: string | null) => (id === null ? null : runs.indexOf(id))
  const entryOf = (ord: Map<string, number>, e: JournalEntry) => ({
    ord: ord.get(e.id) ?? -1, run: runOrd(e.run_id), tool_call_id: e.tool_call_id, path: e.path, action: e.action, state: e.state, before_exists: e.before_exists,
    before_sha: e.before_sha, after_sha: e.after_sha, intended_sha: e.intended_sha, undone_by: e.undone_by === null ? null : ord.get(e.undone_by) ?? -1,
  })
  const changesOf = (ord: Map<string, number>, changes: FileChange[]) => changes.map((c) => ({ path: c.path, before: sha(c.before), after: sha(c.after), created: c.created, entries: c.entries.map((e) => entryOf(ord, e)) }))
  const filesNow = () => [...PATHS, HOT].map((p) => {
    const at = join(ws.path, p)
    if (!existsSync(at)) return { path: p, sha: null, mode: null }
    return { path: p, sha: sha(readFileSync(at)), mode: lstatSync(at).mode & 0o777 }
  })

  const checkpoints: unknown[] = []
  const undos: unknown[] = []
  const counts: Record<string, number> = {}
  const count = (k: string) => { counts[k] = (counts[k] ?? 0) + 1 }
  const checkpoint = async (step: number) => {
    const ord = ordinal()
    const folderChanges = service.journal.folderChanges(ws)
    const diff = await service.diff(ws)
    const status = await service.status(ws)
    checkpoints.push({
      step,
      runChanges: runs.map((r) => changesOf(ord, service.journal.runChanges(r))),
      runDiffs: runs.map((r) => { const d = service.journal.diffOf(service.journal.runChanges(r)); return { patch: digest(d.patch), files: d.files } }),
      folderChanges: changesOf(ord, folderChanges),
      fullDiff: (() => { const d = service.journal.diffOf(folderChanges, true); return { patch: digest(d.patch), files: d.files } })(),
      diff: { patch: digest(diff.patch), files: diff.files },
      status: { modified: status.modified, added: status.added, deleted: status.deleted },
      files: filesNow(),
    })
  }

  const contentFor = (p: string, step: number): Buffer => {
    const r = random()
    if (r < 0.04) return Buffer.from(`seed:${p}\n`)                                   // back as it was first
    if (p === 'e.bin') return Buffer.concat([Buffer.from(`bin ${step}`), Buffer.from([0, 1, 2, step & 0xff])])
    if (p === 'big.txt') return Buffer.from(`${step}\n`.padEnd(65536, 'y'))           // 64 KiB
    return Buffer.from(`${p} step ${step}\n${'line\n'.repeat(step % 5)}`)
  }

  const toolWrite = (p: string, step: number, abandon: boolean) => {
    const now = fileNow(ws.path, p)
    if (now.kind === 'unknown') { count('skipped_unknown'); return }
    const before = now.kind === 'file' ? now.data : null
    const data = contentFor(p, step)
    const entry = service.journal.prepare(ws, { run_id: run, tool_call_id: `t${step}`, path: p, action: before === null ? 'created' : 'edited', before, intended: data })
    if (abandon) { service.journal.abandoned(entry); count('abandoned'); return }
    if (before === null) mkdirSync(dirname(now.real), { recursive: true })
    atomicWrite(now.real, data, { expect: before === null ? { absent: true } : { sha256: sha256Hex(before) }, keep_mode: true })
    service.journal.applied(entry, data)
    count(p === HOT ? 'write_hot' : 'write')
  }

  for (let step = 0; step < steps; step += 1) {
    const r = random()
    const existing = [...PATHS, HOT].filter((p) => existsSync(join(ws.path, p)))
    if (r < 0.45) toolWrite(HOT, step, false)
    else if (r < 0.72) toolWrite(pick(PATHS), step, false)
    else if (r < 0.76) toolWrite(pick([...PATHS, HOT]), step, true)
    else if (r < 0.82 && existing.length) { writeFileSync(join(ws.path, pick(existing)), `person ${step}\n`); count('person_edit') }
    else if (r < 0.84 && existing.length) { unlinkSync(join(ws.path, pick(existing))); count('person_remove') }
    else if (r < 0.86 && existing.length) { chmodSync(join(ws.path, pick(existing)), pick(MODES)); count('person_chmod') }
    else if (r < 0.90) {
      const target = pick(runs)
      undos.push({ step, run: runOrd(target), result: (() => { const u = service.journal.undoRun(ws, target, session.id); return { ...u, run_id: runOrd(u.run_id) } })() })
      count('undo')
    } else if (r < 0.93 && runs.length < 10) { run = newRun(); count('new_run') }
    else toolWrite(HOT, step, false)
    if (step % 250 === 249) await checkpoint(step)
  }
  // every run undone in turn, newest first, then read once more
  for (const target of [...runs].reverse()) undos.push({ step: steps, run: runOrd(target), result: (() => { const u = service.journal.undoRun(ws, target, session.id); return { ...u, run_id: runOrd(u.run_id) } })() })
  await checkpoint(steps)

  const canonical = JSON.stringify({ seed, steps, checkpoints, undos })
  const entries = (conn.get('SELECT count(*) AS n FROM file_journal') as { n: number }).n
  const hotMax = (conn.get("SELECT max(n) AS n FROM (SELECT count(*) AS n FROM file_journal WHERE state='applied' AND run_id IS NOT NULL GROUP BY run_id, path)") as { n: number }).n
  service.close()
  conn.close()
  rmSync(root, { recursive: true, force: true })
  // the whole canonical record (tens of MB) only when asked, to find where two digests part
  if (process.env.PERF_EQUIV_KEEP_CANONICAL === '1') writeFileSync(join(dirFromEnv('PERF_OUT'), `journal_grouping_equivalence_${seed}_canonical.json`), canonical + '\n', { mode: 0o600 })
  writeResult(`journal_grouping_equivalence_${seed}`, {
    kind: 'journal_grouping_equivalence', seed, steps, digest: digest(canonical), checkpoints: checkpoints.length, undos: undos.length,
    journal_entries: entries, max_entries_one_path_one_run: hotMax, ops: counts, fingerprint: fingerprint(),
  })
})
