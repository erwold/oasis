/** The journal of a folder edited in place (a direct project): a file tool's write there is kept first — the file as it
 *  was, in the database, and what the write means to leave, before a byte of it changes — then marked written with the
 *  file as written. From it: a run's file changes, exactly (its first "before" against its last "after", per file); the
 *  folder's changes by the tools since the session opened it; and undoing a run's file changes — each file put back as
 *  it was, or left alone, and said so, when it changed since the run wrote it (the person's edit, a later run's) or
 *  cannot be read: the harness never writes over what it did not write. A command's writes are not in it (a shell's
 *  writes are its own, as in any terminal); nor is the temporary folder.
 *
 *  A run's writes of one file chain: each write's "before" is the previous write's "after". Where they do not — the
 *  file changed between two of the run's writes (a command still running, the person, another writer) — the first
 *  "before" against the last "after" would fold that other change into the run's: the whole path is then not the
 *  run's (chain 'broken'), left out of its measured changes and never put back by its Undo. */

import { lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { JournalEntry, UndoResult, Workspace } from '@oasis-code/contract'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { atomicWrite, sha256Hex, WriteConflict } from '../store.ts'
import { pinnedRoot, FolderUnreachable } from './paths.ts'
import { unifiedDiff } from './textdiff.ts'

export interface FileChange {
  path: string
  /** the file before the first write (null: it was not there) */
  before: Uint8Array | null
  /** the file after the last write, or now (null: not there) */
  after: Uint8Array | null
  created: boolean
  entries: JournalEntry[]
  /** whether the entries chain (each one's before is the previous one's after); 'broken': another hand wrote between */
  chain: 'intact' | 'broken'
}

/** Whether a file's writes (in order) chain: each write found the file as the previous write left it. */
export function chainOf(entries: readonly Pick<JournalEntry, 'before_sha' | 'after_sha'>[]): 'intact' | 'broken' {
  for (let i = 1; i < entries.length; i += 1) if (entries[i]!.before_sha !== entries[i - 1]!.after_sha) return 'broken'
  return 'intact'
}

export interface JournalDiff { patch: string; files: { path: string; added: number | null; removed: number | null }[] }

/** A file of the folder as it stands: its bytes, not there, or not known — the folder cannot be reached where it was
 *  opened, the file cannot be read, or the name now leads through a link or to something that is not a file. A file
 *  that cannot be read is never taken for one that is not there. */
export type FileNow =
  | { kind: 'file'; real: string; data: Uint8Array }
  | { kind: 'absent'; real: string }
  | { kind: 'unknown'; reason: string }

const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? (error as Error).message

/** What is at `rel` in the folder at `root` now. */
export function fileNow(root: string, rel: string): FileNow {
  if (!rel || isAbsolute(rel) || rel.split('/').some((p) => p === '..' || p === '')) return { kind: 'unknown', reason: 'not a path inside the folder' }
  let realRoot: string
  try { realRoot = pinnedRoot(root) } catch (error) { return { kind: 'unknown', reason: (error as Error).message } }
  const path = resolve(realRoot, rel)
  let parent: string
  try { parent = realpathSync(dirname(path)) } catch (error) {
    const code = codeOf(error)
    // its directory is gone: so is the file
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent', real: path }
    return { kind: 'unknown', reason: `its directory cannot be read (${code})` }
  }
  if (parent !== realRoot && !parent.startsWith(realRoot + '/')) return { kind: 'unknown', reason: 'the path now leads out of the folder (a link)' }
  const real = join(parent, relative(dirname(path), path))
  try {
    const st = lstatSync(real)
    if (st.isSymbolicLink()) return { kind: 'unknown', reason: 'it is a link now' }
    if (!st.isFile()) return { kind: 'unknown', reason: 'it is not a file now' }
  } catch (error) {
    const code = codeOf(error)
    if (code === 'ENOENT') return { kind: 'absent', real }
    return { kind: 'unknown', reason: `it cannot be read (${code})` }
  }
  try { return { kind: 'file', real, data: readFileSync(real) } } catch (error) {
    const code = codeOf(error)
    if (code === 'ENOENT') return { kind: 'absent', real }
    return { kind: 'unknown', reason: `it cannot be read (${code})` }
  }
}

const shaOf = (data: Uint8Array | null): string | null => (data === null ? null : sha256Hex(data))

/** Why Undo leaves a path whose writes do not chain alone. */
export const CHAIN_BROKEN = 'the file changed between two of the run\'s writes (another writer); the run\'s changes to it cannot be told apart, so it is left alone'

/** Text a person can read from bytes, or null for a binary (a NUL within the first 8 KiB). */
function textOf(data: Uint8Array | null): string | null {
  if (data === null) return ''
  if (data.subarray(0, 8192).includes(0)) return null
  return Buffer.from(data).toString('utf8')
}

/** How a kept write was settled from the file: the harness's (applied), not done (abandoned), neither (unsettled), or
 *  not yet — the file could not be read, and the entry stays kept until it can be. */
export type Settled = 'applied' | 'abandoned' | 'unsettled' | 'unreadable'

export class FileJournal {
  constructor(private readonly conn: Conn) {}

  /** The file as it is, and what the write means to leave (`intended`, null: a removal), kept before a tool writes it.
   *  An undo names the entries it takes back (`undoes`). Throws when it cannot be kept: the write must not happen then. */
  prepare(ws: Workspace, o: { session_id?: string | null; run_id: string | null; tool_call_id: string | null; path: string; action: JournalEntry['action']; before: Uint8Array | null; intended: Uint8Array | null; undoes?: string[] }): JournalEntry {
    // one workspace serves every session of the folder: the entry names the session of the run that wrote
    return repo.prepareJournalEntry(this.conn, {
      workspace_id: ws.id, session_id: o.session_id ?? ws.session_id, run_id: o.run_id, tool_call_id: o.tool_call_id, path: o.path, action: o.action,
      before: o.before, before_sha: shaOf(o.before), intended_sha: shaOf(o.intended), undoes: o.undoes ?? [],
    })
  }

  applied(entry: JournalEntry, after: Uint8Array | null): void {
    repo.applyJournalEntry(this.conn, entry.id, after, shaOf(after))
  }

  abandoned(entry: JournalEntry): void {
    repo.settleJournalEntry(this.conn, entry.id, 'abandoned')
  }

  /** A kept write never marked (the harness stopped between the two) settled by the file: still as it was kept, the
   *  write did not happen; as the write meant to leave it, it did; anything else is another hand's (unsettled) — not
   *  taken for the write's, and never undone. A file that cannot be read settles nothing. */
  settle(entry: JournalEntry, ws: Workspace): Settled {
    if (ws.target?.kind === 'ssh') return 'unreadable' // remote operation receipts, never local same-path bytes
    const now = fileNow(ws.path, entry.path)
    if (now.kind === 'unknown') return 'unreadable'
    const data = now.kind === 'file' ? now.data : null
    const sha = shaOf(data)
    if (sha === entry.before_sha) { repo.settleJournalEntry(this.conn, entry.id, 'abandoned'); return 'abandoned' }
    const meant = entry.action === 'removed' ? data === null : entry.intended_sha !== null && sha === entry.intended_sha
    if (meant) { this.applied(entry, data); return 'applied' }
    repo.settleJournalEntry(this.conn, entry.id, 'unsettled')
    return 'unsettled'
  }

  /** Per file, the writes of `entries` taken together: the first one's "before" and the last one's "after". */
  private group(entries: JournalEntry[], after: (last: JournalEntry) => Uint8Array | null): FileChange[] {
    // one list per path, made at its first entry and appended to in place: a path written n times costs n, not n²
    const byPath = new Map<string, JournalEntry[]>()
    for (const e of entries) {
      const list = byPath.get(e.path)
      if (list === undefined) byPath.set(e.path, [e])
      else list.push(e)
    }
    return [...byPath].map(([path, list]) => {
      const first = list[0]!
      const last = list[list.length - 1]!
      const before = first.before_exists ? repo.journalBytes(this.conn, first.id, 'before') : null
      return { path, before, after: after(last), created: !first.before_exists, entries: list, chain: chainOf(list) }
    })
  }

  /** A run's file changes: its first "before" against its last "after", per file (as the run left them) — a path whose
   *  writes do not chain included, marked broken (runAttributed tells the run's own from the rest). */
  runChanges(runId: string): FileChange[] {
    const entries = repo.listJournal(this.conn, { run_id: runId })
    return this.group(entries, (last) => repo.journalBytes(this.conn, last.id, 'after')).filter((c) => c.chain === 'broken' || shaOf(c.before) !== shaOf(c.after) || c.created)
  }

  /** A run's file changes as the run's own: the paths whose writes chain; the rest (another hand wrote between two of
   *  the run's writes) by path, not counted as the run's. */
  runAttributed(runId: string): { changes: FileChange[]; unattributed: string[] } {
    const all = this.runChanges(runId)
    return { changes: all.filter((c) => c.chain === 'intact'), unattributed: all.filter((c) => c.chain === 'broken').map((c) => c.path) }
  }

  /** The folder's changes by the tools, still standing: per file a run wrote and no undo took back, the file before
   *  its first such write against the file now (so a later edit by anyone shows as it stands). A file that cannot be
   *  read now shows as the tools left it; a folder that cannot be reached is said so (FolderUnreachable), not shown as
   *  its files removed. */
  folderChanges(ws: Workspace): FileChange[] {
    if (ws.target?.kind === 'ssh') throw new FolderUnreachable('Remote journal requires its remote provider; local fallback refused.')
    pinnedRoot(ws.path)
    const entries = repo.listJournal(this.conn, { workspace_id: ws.id }).filter((e) => e.run_id !== null && e.undone_by === null)
    return this.group(entries, (last) => {
      const now = fileNow(ws.path, last.path)
      return now.kind === 'file' ? now.data : now.kind === 'absent' ? null : repo.journalBytes(this.conn, last.id, 'after')
    }).filter((c) => shaOf(c.before) !== shaOf(c.after))
  }

  /** The changes as a patch the page reads (git's headers, difflib's hunks) and a count per file; `full`, each file
   *  whole around its changes. */
  diffOf(changes: FileChange[], full = false): JournalDiff {
    const parts: string[] = []
    const files: JournalDiff['files'] = []
    for (const c of [...changes].sort((a, b) => a.path.localeCompare(b.path))) {
      const a = textOf(c.before)
      const b = textOf(c.after)
      const head = `diff --git a/${c.path} b/${c.path}\n${c.before === null ? 'new file mode 100644\n' : c.after === null ? 'deleted file mode 100644\n' : ''}`
      if (a === null || b === null) {
        parts.push(`${head}Binary files a/${c.path} and b/${c.path} differ\n`)
        files.push({ path: c.path, added: null, removed: null })
        continue
      }
      // full: the whole file as context around its changes
      const body = unifiedDiff(a, b, c.path, full ? Math.max(a.split('\n').length, b.split('\n').length) : 3)
      parts.push(head + body)
      let added = 0
      let removed = 0
      for (const line of body.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++ ')) added += 1
        else if (line.startsWith('-') && !line.startsWith('--- ')) removed += 1
      }
      files.push({ path: c.path, added, removed })
    }
    return { patch: parts.join(''), files }
  }

  /** A run's file changes undone: each file the run wrote put back as it was before the run (removed, when the run
   *  created it) — only while it is still as the run left it; a file changed since, or that cannot be read, is left
   *  alone and named, and so is one whose write the harness stopped in the middle of and could not settle. Each
   *  putting-back is itself a journal entry (the file as it was just before, what it is put back to, and the run's
   *  entries it takes back), so an undo stopped anywhere is settled at the next start like any write. */
  undoRun(ws: Workspace, runId: string, sessionId: string | null = null): UndoResult {
    if (ws.target?.kind === 'ssh') throw new FolderUnreachable('Remote undo requires its remote provider; local fallback refused.')
    // a write of the folder kept but never marked is a stopped process's (writes here are synchronous): settle it now
    for (const e of repo.listPreparedJournal(this.conn)) if (e.workspace_id === ws.id) this.settle(e, ws)
    const held = new Map<string, string>()
    for (const e of repo.listUnsettledJournal(this.conn, runId)) held.set(e.path, 'the harness stopped while writing it, and it is neither as it was nor as the run meant to write it')
    for (const e of repo.listPreparedJournal(this.conn, runId)) held.set(e.path, 'the harness stopped while writing it, and it cannot be read to tell whether the write happened')
    const standing = repo.listJournal(this.conn, { run_id: runId }).filter((e) => e.undone_by === null)
    const result: UndoResult = { run_id: runId, restored: [], removed: [], conflicts: [], nothing: standing.length === 0 && held.size === 0 }
    for (const [path, reason] of held) if (!standing.some((e) => e.path === path)) result.conflicts.push({ path, reason, code: 'unsettled' })
    for (const change of this.group(standing, (last) => repo.journalBytes(this.conn, last.id, 'after'))) {
      const last = change.entries[change.entries.length - 1]!
      const hold = held.get(change.path)
      if (hold !== undefined) { result.conflicts.push({ path: change.path, reason: hold, code: 'unsettled' }); continue }
      // another hand wrote the file between two of the run's writes: putting back the run's first "before" would undo
      // that change too — the whole path is left alone
      if (change.chain === 'broken') { result.conflicts.push({ path: change.path, reason: CHAIN_BROKEN, code: 'chain_broken' }); continue }
      const now = fileNow(ws.path, change.path)
      if (now.kind === 'unknown') { result.conflicts.push({ path: change.path, reason: now.reason, code: 'unreadable' }); continue }
      const current = now.kind === 'file' ? now.data : null
      if (shaOf(current) !== last.after_sha) {
        result.conflicts.push(current === null ? { path: change.path, reason: 'removed since the run wrote it', code: 'removed_since' } : { path: change.path, reason: 'changed since the run wrote it', code: 'changed_since' })
        continue
      }
      const undo = this.prepare(ws, {
        session_id: sessionId, run_id: null, tool_call_id: null, path: change.path, action: change.before === null ? 'removed' : 'restored',
        before: current, intended: change.before, undoes: change.entries.map((e) => e.id),
      })
      try {
        if (change.before === null) {
          // removed only while it is still what the run wrote (checked just now; a write between is the last window)
          const again = fileNow(ws.path, change.path)
          if (again.kind !== 'file' || shaOf(again.data) !== last.after_sha) throw new WriteConflict(`${change.path} changed`)
          unlinkSync(now.real)
          result.removed.push(change.path)
        } else {
          atomicWrite(now.real, change.before, { expect: { sha256: last.after_sha! }, keep_mode: true })
          result.restored.push(change.path)
        }
      } catch (error) {
        this.abandoned(undo)
        if (error instanceof WriteConflict) { result.conflicts.push({ path: change.path, reason: 'changed since the run wrote it', code: 'changed_since' }); continue }
        throw error
      }
      this.applied(undo, change.before)
    }
    return result
  }

  /** Startup: each write kept but never marked (the harness stopped between the two) settled by the file (settle). */
  recover(workspaceOf: (id: string) => Workspace | null): Record<Settled, number> {
    const counts: Record<Settled, number> = { applied: 0, abandoned: 0, unsettled: 0, unreadable: 0 }
    for (const e of repo.listPreparedJournal(this.conn)) {
      const ws = workspaceOf(e.workspace_id)
      if (ws === null) { repo.settleJournalEntry(this.conn, e.id, 'abandoned'); counts.abandoned += 1; continue }
      counts[this.settle(e, ws)] += 1
    }
    return counts
  }
}
