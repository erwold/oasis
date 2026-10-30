/** The trusted Git host. Every Git operation the harness performs runs here, in a scrubbed environment: no
 *  global/system config, hooks pointed at an empty directory, no credential helper, no signing, no external diff,
 *  no terminal prompt. Repository code never runs through these calls.
 *
 *  Layout under the data directory:
 *    repos/<project_id>/base.git                a bare mirror of the user's repository at import: its objects are
 *                                               read by every workspace of the project, written by none after it
 *    repos/<project_id>/views/<object>          an immutable view: the objects reachable from one commit (or tree),
 *                                               packed once — the base commit's whole, any other's thin over the
 *                                               base's — from the repository that holds them; read by many, written
 *                                               by none after
 *    repos/<project_id>/workspaces/<id>.git     a workspace's own repository: its index, its refs (HEAD on the branch
 *                                               oasis-code/<id>; refs/oasis-code/checkpoints/<cp>, the commits its
 *                                               checkpoints pin, never on the user's branches) and the objects it
 *                                               makes; what it reads besides is views, through objects/info/alternates
 *                                               — never a store another repository writes to
 *    workspaces/<id>/                           its working tree (a `.git` file pointing at the repository above)
 *
 *  A workspace made before this layout is a worktree of base.git (its metadata under base.git/worktrees/<id>, its
 *  checkpoints pinned in base.git); the harness takes it into a repository of its own the first time it touches it
 *  (WorkspaceService.adopt), leaving the base repository's objects and refs as they are.
 *  The user's original working tree is read at import and never written. */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { newId } from '../ids.ts'

/** A context wider than any file the page shows: a patch with it holds each changed file whole. */
const WHOLE_FILE_CONTEXT = 100_000_000

export const SNAPSHOT_TIMEOUT_S = 600
export const GIT_TIMEOUT_S = 300
export const CHECKPOINT_REF_PREFIX = 'refs/oasis-code/checkpoints/'
const HOOKS_DIR = join(tmpdir(), 'oasis-code-empty-hooks')

export class GitError extends Error {
  readonly stderr: string
  readonly code: number | null
  constructor(message: string, opts: { stderr?: string; code?: number | null } = {}) {
    super(message)
    this.name = 'GitError'
    this.stderr = opts.stderr ?? ''
    this.code = opts.code ?? null
  }
}

export interface GitResult { code: number; out: string; err: string }

// What a folder snapshot leaves out on top of the folder's own .gitignore files: dependency and cache directories
// no one wants carried into a harness copy (the report names them; nothing else is filtered).
export const SNAPSHOT_EXCLUDES = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.DS_Store', '*.pyc']

/** What the import saw in the user's folder and what it carried. `kind` is "repository" (a Git repository root
 *  with a commit: its HEAD is cloned) or "folder" (anything else a person points at: its files are snapshotted). */
export interface ImportReport {
  source_path: string
  head_commit: string | null
  branch: string | null
  kind: 'repository' | 'folder'
  staged: string[]
  unstaged: string[]
  untracked: string[]
  not_carried: string[]
  submodules: string
  lfs: string
  notes: string[]
}

export function newImportReport(sourcePath: string, headCommit: string | null, branch: string | null, kind: 'repository' | 'folder' = 'repository'): ImportReport {
  return { source_path: sourcePath, head_commit: headCommit, branch, kind, staged: [], unstaged: [], untracked: [], not_carried: [], submodules: 'none', lfs: 'none', notes: [] }
}

export function importReportDict(r: ImportReport): Record<string, unknown> {
  return {
    kind: r.kind, source_path: r.source_path, head_commit: r.head_commit, branch: r.branch,
    staged: r.staged.slice(0, 200), unstaged: r.unstaged.slice(0, 200), untracked: r.untracked.slice(0, 200),
    staged_count: r.staged.length, unstaged_count: r.unstaged.length, untracked_count: r.untracked.length,
    not_carried: r.not_carried.slice(0, 400), not_carried_count: r.not_carried.length,
    submodules: r.submodules, lfs: r.lfs, notes: r.notes,
    basis: 'the committed HEAD only (uncommitted changes are listed, not carried; the history behind HEAD is not '
      + 'carried either: the copy is shallow)',
  }
}

function emptyHooksDir(): string {
  mkdirSync(HOOKS_DIR, { recursive: true })
  return HOOKS_DIR
}

function which(bin: string): string | null {
  if (bin.includes('/')) return existsSync(bin) ? bin : null
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(':')) {
    const candidate = join(dir, bin)
    try { if (statSync(candidate).isFile()) return candidate } catch { /* next */ }
  }
  return null
}

/** The source folder as one real path: `~` expanded, symlinks followed (a macOS temp dir is /var → /private/var, and
 *  git's --show-toplevel answers with the real one), a path that does not exist left as resolved. */
export function realSource(sourcePath: string): string {
  const resolved = resolve(expandUser(sourcePath))
  try { return realpathSync(resolved) } catch { return resolved }
}

function expandUser(path: string): string {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path
}

/** An async mutex: `run` waits for the previous holder. */
class AsyncLock {
  private tail: Promise<void> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

export interface RunOptions {
  cwd?: string | null
  check?: boolean
  timeout?: number
  env_extra?: Record<string, string>
  input?: Uint8Array | string | null
}

/** the private HOMEs of the hosts not yet closed (closeOpenGitHomes) */
const openHomes = new Set<string>()

/** Removes the HOME of every host still open: for a process (a test run) that ends without closing each one. */
export function closeOpenGitHomes(): void {
  for (const home of openHomes) rmSync(home, { recursive: true, force: true })
  openHomes.clear()
}

export class GitHost {
  readonly git_bin: string
  private readonly home: string
  private readonly indexLocks = new Map<string, AsyncLock>()

  constructor(gitBin = 'git') {
    this.git_bin = which(gitBin) ?? gitBin
    this.home = mkdtempSync(join(tmpdir(), 'oasis-code-git-home-'))
    openHomes.add(this.home)
  }

  /** Removes the private HOME made at construction; the host runs nothing after this. */
  close(): void {
    rmSync(this.home, { recursive: true, force: true })
    openHomes.delete(this.home)
  }

  // -- the scrubbed invocation --------------------------------------------

  env(): Record<string, string> {
    return {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: this.home,
      LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/usr/bin/false',
      SSH_ASKPASS: '/usr/bin/false',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_AUTHOR_NAME: 'oasis-code', GIT_AUTHOR_EMAIL: 'oasis-code@localhost',
      GIT_COMMITTER_NAME: 'oasis-code', GIT_COMMITTER_EMAIL: 'oasis-code@localhost',
    }
  }

  baseArgs(): string[] {
    const hooks = emptyHooksDir()
    return [this.git_bin,
      '-c', `core.hooksPath=${hooks}`,
      '-c', 'core.fsmonitor=false',
      '-c', 'credential.helper=',
      '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false',
      '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'core.editor=/usr/bin/false',
      '-c', 'core.sshCommand=/usr/bin/false',
      '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
      '-c', 'submodule.recurse=false',
      '-c', 'core.autocrlf=false']
  }

  async run(args: string[], opts: RunOptions = {}): Promise<GitResult> {
    const check = opts.check ?? true
    const timeout = opts.timeout ?? GIT_TIMEOUT_S
    const env = { ...this.env(), ...(opts.env_extra ?? {}) }
    const [bin, ...rest] = this.baseArgs()
    const raw = await runBytes(bin!, [...rest, ...args], { cwd: opts.cwd ?? undefined, env, timeout, input: opts.input ?? null })
    if (raw.timedOut) throw new GitError(`git ${args.slice(0, 2).join(' ')} timed out after ${timeout}s`)
    const out = new TextDecoder('utf-8', { fatal: false }).decode(raw.stdout)
    const err = new TextDecoder('utf-8', { fatal: false }).decode(raw.stderr)
    if (check && raw.code !== 0) {
      throw new GitError(`git ${args.join(' ')} failed (${raw.code}): ${err.trim().slice(0, 600)}`, { stderr: err, code: raw.code })
    }
    return { code: raw.code ?? -1, out, err }
  }

  // -- inspection of the user's repository (read only) ---------------------

  /** What the folder is: a repository root with a commit (its HEAD gets cloned), or a folder (snapshotted): a plain
   *  directory, a repository with no commit yet, or a directory inside a repository. */
  async inspectSource(sourcePath: string): Promise<ImportReport> {
    const source = realSource(sourcePath)
    let isDir = false
    try { isDir = statSync(source).isDirectory() } catch { isDir = false }
    if (!isDir) throw new GitError(`${source} is not a directory`)
    const top = await this.run(['rev-parse', '--show-toplevel'], { cwd: source, check: false })
    const toplevel = top.code === 0 ? resolve(top.out.trim()) : null
    const head = toplevel === source ? await this.run(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: source, check: false }) : null
    const headCommit = head !== null ? head.out.trim() || null : null
    if (headCommit === null) {
      const report = newImportReport(source, null, null, 'folder')
      if (toplevel === null) report.notes.push("not a Git repository: the folder's files are snapshotted as they are")
      else if (toplevel !== source) report.notes.push(`a directory inside the repository ${toplevel}: snapshotted as a folder, the repository's history not carried`)
      else report.notes.push('a repository with no commit yet: its files are snapshotted as they are')
      return report
    }
    const branch = (await this.run(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: source, check: false })).out.trim() || null
    const report = newImportReport(source, headCommit, branch)
    const status = await this.run(['status', '--porcelain=v1', '--untracked-files=all', '-z'], { cwd: source, check: false })
    if (status.code === 0) {
      for (const entry of status.out.split('\0')) {
        if (entry.length < 4) continue
        const x = entry[0]!
        const y = entry[1]!
        const path = entry.slice(3)
        if (x === '?' && y === '?') { report.untracked.push(path); continue }
        if (x !== ' ' && x !== '?') report.staged.push(path)
        if (y !== ' ' && y !== '?') report.unstaged.push(path)
      }
    }
    report.not_carried = [...new Set([...report.staged, ...report.unstaged, ...report.untracked])].sort()
    if (existsSync(join(source, '.gitmodules'))) report.submodules = 'present: not initialised in the harness copy (unsupported in v0.1)'
    const attributes = join(source, '.gitattributes')
    if (existsSync(attributes) && readFileSync(attributes, 'utf8').includes('filter=lfs')) {
      report.lfs = 'attributes name LFS filters: the harness copy carries pointer files only (unsupported in v0.1)'
    }
    return report
  }

  // -- the managed base repository ----------------------------------------

  /** A bare copy of the user's repository at its HEAD. --no-local + --no-hardlinks: objects are copied through the
   *  transport, never shared with the original's object store; --depth 1: the HEAD commit and its tree only — the
   *  harness works from that commit and never walks history; nothing is checked out, so no hook runs. */
  async cloneBase(source: string, baseRepo: string): Promise<void> {
    mkdirSync(dirname(baseRepo), { recursive: true })
    await this.run(['clone', '--bare', '--no-local', '--no-hardlinks', '--no-recurse-submodules', '--depth', '1',
      pathToFileURL(resolve(source)).href, baseRepo], { timeout: SNAPSHOT_TIMEOUT_S })
    await this.run(['config', 'core.logAllRefUpdates', 'true'], { cwd: baseRepo })
  }

  /** A bare repository whose first commit is the folder's files as they are now: the folder is read as the work
   *  tree through the environment (nothing is written into it), its own .gitignore files apply, and so do
   *  SNAPSHOT_EXCLUDES. Returns [commit, what was carried and left]. */
  async snapshotFolder(sourcePath: string, baseRepo: string, branch = 'main'): Promise<[string, Record<string, unknown>]> {
    const source = realSource(sourcePath)
    mkdirSync(dirname(baseRepo), { recursive: true })
    await this.run(['init', '--bare', '-b', branch, baseRepo])
    const tmp = mkdtempSync(join(tmpdir(), 'oasis-code-snapshot-'))
    let files = 0
    const nested: string[] = []
    let tree: string
    try {
      const excludes = join(tmp, 'excludes')
      writeFileSync(excludes, SNAPSHOT_EXCLUDES.join('\n') + '\n')
      const env = { GIT_INDEX_FILE: join(tmp, 'index'), GIT_WORK_TREE: source, GIT_DIR: baseRepo }
      await this.run(['-c', `core.excludesFile=${excludes}`, 'add', '-A', '--', '.'], { cwd: source, env_extra: env, timeout: SNAPSHOT_TIMEOUT_S })
      const listed = (await this.run(['ls-files', '--stage', '-z'], { cwd: source, env_extra: env })).out
      for (const entry of listed.split('\0')) {
        if (!entry) continue
        const mode = entry.split(' ', 1)[0]!
        const path = entry.split('\t').slice(1).join('\t')
        if (mode === '160000') nested.push(path)
        else files += 1
      }
      tree = (await this.run(['write-tree'], { cwd: source, env_extra: env })).out.trim()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
    const commit = (await this.run(['commit-tree', tree, '-m', `oasis-code: snapshot of ${source}`], { cwd: baseRepo })).out.trim()
    await this.run(['update-ref', `refs/heads/${branch}`, commit], { cwd: baseRepo })
    const carried: Record<string, unknown> = {
      files_carried: files, excluded_patterns: [...SNAPSHOT_EXCLUDES],
      basis: "a snapshot of the folder's files as they were at import (its .gitignore files and the excluded patterns applied; no history)",
    }
    if (nested.length) {
      carried.nested_repositories = nested.slice(0, 50)
      carried.notes_nested = 'nested Git repositories are recorded as links; their files are not carried'
    }
    return [commit, carried]
  }

  /** A new empty project: a bare repository whose first commit is an empty tree, so a workspace can branch from something real. */
  async initBase(baseRepo: string, branch = 'main'): Promise<string> {
    mkdirSync(dirname(baseRepo), { recursive: true })
    await this.run(['init', '--bare', '-b', branch, baseRepo])
    const tree = (await this.run(['mktree'], { cwd: baseRepo, input: '' })).out.trim()
    const commit = (await this.run(['commit-tree', tree, '-m', 'oasis-code: initial empty commit'], { cwd: baseRepo })).out.trim()
    await this.run(['update-ref', `refs/heads/${branch}`, commit], { cwd: baseRepo })
    return commit
  }

  /** An isolated output repository, with no objects or history copied from the source. */
  async initScratch(path: string, gitDir: string, branch: string): Promise<string> {
    mkdirSync(dirname(path), { recursive: true })
    mkdirSync(dirname(gitDir), { recursive: true })
    await this.run(['init', '-q', '--template=', '-b', branch, `--separate-git-dir=${gitDir}`, path])
    const tree = (await this.run(['mktree'], { cwd: path, input: '' })).out.trim()
    const commit = (await this.run(['commit-tree', tree, '-m', 'oasis-code: isolated outputs'], { cwd: path })).out.trim()
    await this.run(['update-ref', `refs/heads/${branch}`, commit], { cwd: path })
    await this.run(['reset', '-q', '--hard'], { cwd: path })
    return commit
  }

  async defaultBranch(baseRepo: string): Promise<string | null> {
    const ref = (await this.run(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: baseRepo, check: false })).out.trim()
    return ref || null
  }

  // -- a workspace's repository ---------------------------------------------

  /** A repository of a workspace's own: `gitDir` beside the base repository, the working tree at `path` checked out
   *  at `commit` on `branch` (detached when null). Its object store reads the views in `alternates` — the base
   *  commit's, the commit it starts from, the checkpoints shared into it — through objects/info/alternates; what it
   *  makes stays its own. No template: no sample hooks, and the hooks directory of every call here is empty, so the
   *  checkout runs no repository code. */
  async openRepo(baseRepo: string, path: string, gitDir: string, opts: { branch: string | null; commit: string; alternates: string[] }): Promise<void> {
    mkdirSync(dirname(path), { recursive: true })
    mkdirSync(dirname(gitDir), { recursive: true })
    await this.run(['init', '-q', '--template=', '-b', opts.branch ?? 'main', `--separate-git-dir=${gitDir}`, path])
    this.dressRepo(baseRepo, gitDir, opts.alternates)
    if (opts.branch !== null) await this.run(['update-ref', `refs/heads/${opts.branch}`, opts.commit], { cwd: path })
    else await this.run(['update-ref', '--no-deref', 'HEAD', opts.commit], { cwd: path })
    await this.run(['reset', '-q', '--hard'], { cwd: path })
  }

  /** A worktree of the earlier layout taken into a repository of its own at `gitDir`: HEAD on `branch` at `head`, the
   *  refs in `refs` (its checkpoints) written there, the views in `alternates` its object store, the tree's `.git`
   *  pointer turned to it and its index rebuilt from HEAD — the files untouched. */
  async adoptRepo(baseRepo: string, path: string, gitDir: string, opts: { branch: string; head: string; refs: [string, string][]; alternates: string[] }): Promise<void> {
    mkdirSync(dirname(gitDir), { recursive: true })
    // init wants a tree to make: a scratch one, gone at once; the real tree gets the pointer below
    const scratch = mkdtempSync(join(tmpdir(), 'oasis-code-adopt-'))
    try {
      await this.run(['init', '-q', '--template=', '-b', opts.branch, `--separate-git-dir=${gitDir}`, join(scratch, 'tree')])
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
    this.dressRepo(baseRepo, gitDir, opts.alternates)
    writeFileSync(join(path, '.git'), `gitdir: ${gitDir}\n`)
    await this.run(['update-ref', `refs/heads/${opts.branch}`, opts.head], { cwd: path })
    for (const [ref, sha] of opts.refs) await this.run(['update-ref', ref, sha], { cwd: path })
    await this.run(['reset', '-q'], { cwd: path })
  }

  /** What every workspace repository carries: its alternates (the views it reads) and the base copy's shallow
   *  boundary (the history behind the imported HEAD is not carried; the repository knows where it stops). */
  private dressRepo(baseRepo: string, gitDir: string, alternates: string[]): void {
    const objects = join(gitDir, 'objects')
    mkdirSync(join(objects, 'info'), { recursive: true })
    writeFileSync(join(objects, 'info', 'alternates'), [...new Set(alternates.map((p) => realpathSync(p)))].join('\n') + '\n')
    if (existsSync(join(baseRepo, 'shallow'))) copyFileSync(join(baseRepo, 'shallow'), join(gitDir, 'shallow'))
  }

  /** The objects reachable from `id` (a commit, a tree) — beyond those reachable from `exclude`, when given — packed
   *  from `sourceRepo` into `dest` as one pack: an object store of its own, complete for what it names, that nothing
   *  writes to afterwards. */
  async packView(sourceRepo: string, id: string, exclude: string | null, dest: string): Promise<void> {
    mkdirSync(join(dest, 'pack'), { recursive: true })
    const revs = `${id}\n${exclude !== null ? `^${exclude}\n` : ''}`
    await this.run(['pack-objects', '--revs', '-q', join(dest, 'pack', 'pack')], { cwd: sourceRepo, input: revs })
  }

  /** The working tree removed. A worktree of the earlier layout is removed and pruned from the base repository. A
   *  workspace's own repository stays — its checkpoints live there — unless `gitDir` names it to go with the tree
   *  (a verification's, which pins nothing). */
  async removeTree(baseRepo: string, path: string, gitDir: string | null): Promise<void> {
    const pointer = gitPointer(path)
    if (pointer !== null && resolve(pointer).startsWith(join(resolve(baseRepo), 'worktrees') + '/')) {
      await this.run(['worktree', 'remove', '--force', path], { cwd: baseRepo, check: false })
      if (existsSync(path)) rmSync(path, { recursive: true, force: true })
      await this.run(['worktree', 'prune'], { cwd: baseRepo, check: false })
      return
    }
    if (existsSync(path)) rmSync(path, { recursive: true, force: true })
    if (gitDir !== null) rmSync(gitDir, { recursive: true, force: true })
  }

  // -- status, snapshot, diff ----------------------------------------------

  async status(worktree: string): Promise<Record<'modified' | 'added' | 'deleted' | 'untracked' | 'renamed', string[]>> {
    const out = (await this.run(['status', '--porcelain=v1', '--untracked-files=all', '-z'], { cwd: worktree })).out
    const result = { modified: [] as string[], added: [] as string[], deleted: [] as string[], untracked: [] as string[], renamed: [] as string[] }
    const entries = out.split('\0')
    let i = 0
    while (i < entries.length) {
      const entry = entries[i]!
      i += 1
      if (entry.length < 4) continue
      const x = entry[0]!
      const y = entry[1]!
      const path = entry.slice(3)
      if (x === 'R' || y === 'R') { result.renamed.push(path); i += 1 } // the origin path follows as its own NUL-terminated entry
      else if (x === '?' && y === '?') result.untracked.push(path)
      else if (x === 'D' || y === 'D') result.deleted.push(path)
      else if (x === 'A' || y === 'A') result.added.push(path)
      else result.modified.push(path)
    }
    return result
  }

  /** The workspace's own snapshot index, beside its regular one in its repository. It persists between snapshots so
   *  git's stat cache carries over: only files that changed since the last snapshot are hashed again. */
  async snapshotIndex(worktree: string): Promise<string> {
    return (await this.run(['rev-parse', '--git-path', 'oasis-snapshot-index'], { cwd: worktree })).out.trim()
  }

  private indexLock(worktree: string): AsyncLock {
    const key = resolve(worktree)
    let lock = this.indexLocks.get(key)
    if (!lock) {
      lock = new AsyncLock()
      this.indexLocks.set(key, lock)
    }
    return lock
  }

  /** Write the working files (tracked + untracked, ignore rules honoured) as a tree object through the worktree's
   *  snapshot index. Returns the tree sha, the file count, the untracked and changed paths. `add -A` makes the index
   *  match the working files whatever it held before, so a kept index gives the same tree as a fresh one and only
   *  the stat cache differs; one snapshot at a time per worktree, since git locks the index file. */
  async snapshotTree(worktree: string, baseCommit: string): Promise<{ tree_sha: string; file_count: number; untracked: string[]; changed: string[]; excluded: string[] }> {
    const index = await this.snapshotIndex(worktree)
    const env = { GIT_INDEX_FILE: index }
    const [tree, count, nested] = await this.indexLock(worktree).run(async () => {
      let isFile = false
      try { isFile = statSync(index).isFile() } catch { isFile = false }
      if (!isFile) await this.run(['read-tree', baseCommit], { cwd: worktree, env_extra: env })
      // a git repository made inside the workspace (an agent's clone) is its own history, not the workspace's files:
      // left out — `add` would keep only a pointer to it, and fails outright on one with no commit yet (a clone
      // still under way). One an earlier snapshot pointed at, the base not having it, leaves the index too
      const repos = (await this.run(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: worktree, env_extra: env })).out
        .split('\0').filter((p) => p.endsWith('/')).map((p) => p.slice(0, -1))
      await this.run(['add', '-A', '--', '.', ...repos.map((p) => `:(exclude)${p}`)], { cwd: worktree, env_extra: env })
      const links = (await this.run(['ls-files', '--stage', '-z'], { cwd: worktree, env_extra: env })).out.split('\0')
        .filter((e) => e.startsWith('160000 ')).map((e) => e.split('\t').slice(1).join('\t'))
      if (links.length) {
        const based = new Set((await this.run(['ls-tree', '-r', '-z', baseCommit], { cwd: worktree })).out.split('\0')
          .filter((e) => e.startsWith('160000 ')).map((e) => e.split('\t').slice(1).join('\t')))
        const stray = links.filter((p) => !based.has(p))
        if (stray.length) await this.run(['rm', '--cached', '-q', '-f', '--', ...stray], { cwd: worktree, env_extra: env })
        repos.push(...stray.filter((p) => !repos.includes(p)))
      }
      const t = (await this.run(['write-tree'], { cwd: worktree, env_extra: env })).out.trim()
      const c = (await this.run(['ls-files', '-z'], { cwd: worktree, env_extra: env })).out.split('\0').filter(Boolean).length
      return [t, c, repos] as const
    })
    const untracked = (await this.run(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: worktree })).out.split('\0').filter(Boolean)
    const changed = await this.changedPaths(worktree, baseCommit, tree)
    const ignored = (await this.run(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: worktree, check: false })).out
    const excluded = ['.gitignore', '.git/info/exclude', ...nested.map((p) => `${p} (a git repository of its own)`)]
    if (ignored) excluded.push(`${ignored.split('\0').filter(Boolean).length} ignored entries`)
    return { tree_sha: tree, file_count: count, untracked, changed, excluded }
  }

  async changedPaths(repo: string, base: string, tree: string): Promise<string[]> {
    const out = (await this.run(['diff-tree', '-r', '--name-status', '-z', base, tree], { cwd: repo })).out
    const parts = out.split('\0')
    const changed: string[] = []
    let i = 0
    while (i < parts.length - 1) {
      const status = parts[i]!
      const path = parts[i + 1]!
      i += 2
      if (!status) continue
      if (status.startsWith('R') || status.startsWith('C')) {
        changed.push(`${status[0]} ${path} -> ${i < parts.length ? parts[i] : '?'}`)
        i += 1
      } else {
        changed.push(`${status} ${path}`)
      }
    }
    return changed
  }

  async diffTrees(repo: string, base: string, tree: string, opts: { paths?: string[] | null; stat?: boolean; full?: boolean } = {}): Promise<string> {
    // full: each changed file whole, its unchanged lines as context
    const args = ['diff-tree', '-r', opts.stat ? '--stat' : '-p', ...(opts.full ? [`--unified=${WHOLE_FILE_CONTEXT}`] : []), '--no-color', '--find-renames', base, tree]
    if (opts.paths?.length) args.push('--', ...opts.paths)
    return (await this.run(args, { cwd: repo })).out
  }

  async numstat(repo: string, base: string, tree: string): Promise<{ path: string; added: number | null; removed: number | null }[]> {
    const out = (await this.run(['diff-tree', '-r', '--numstat', '-z', base, tree], { cwd: repo })).out
    const rows: { path: string; added: number | null; removed: number | null }[] = []
    for (const entry of out.split('\0').filter(Boolean)) {
      const fields = entry.split('\t')
      if (fields.length >= 3) {
        const [add, rem, path] = fields as [string, string, string]
        rows.push({ path, added: add === '-' ? null : Number.parseInt(add, 10), removed: rem === '-' ? null : Number.parseInt(rem, 10) })
      }
    }
    return rows
  }

  async commitTree(repo: string, tree: string, parent: string | null, message: string): Promise<string> {
    const args = ['commit-tree', tree, '-m', message]
    if (parent) args.push('-p', parent)
    return (await this.run(args, { cwd: repo })).out.trim()
  }

  async pinRef(repo: string, ref: string, sha: string): Promise<void> {
    await this.run(['update-ref', ref, sha], { cwd: repo })
  }

  async revParse(repo: string, rev: string): Promise<string> {
    return (await this.run(['rev-parse', '--verify', rev], { cwd: repo })).out.trim()
  }

  async treeOf(repo: string, commit: string): Promise<string> {
    return (await this.run(['rev-parse', `${commit}^{tree}`], { cwd: repo })).out.trim()
  }

  async lsFiles(worktree: string): Promise<string[]> {
    const out = (await this.run(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: worktree })).out
    return [...new Set(out.split('\0').filter(Boolean))].sort()
  }

  async showBlob(repo: string, tree: string, path: string): Promise<Uint8Array | null> {
    const [bin, ...rest] = this.baseArgs()
    const raw = await runBytes(bin!, [...rest, 'cat-file', 'blob', `${tree}:${path}`], { cwd: repo, env: this.env(), timeout: GIT_TIMEOUT_S, input: null })
    return raw.code === 0 ? raw.stdout : null
  }
}

interface RawResult { code: number | null; stdout: Uint8Array; stderr: Uint8Array; timedOut: boolean }

/** Run a process to completion with its output as bytes, killed after `timeout` seconds. */
export function runBytes(bin: string, args: string[], opts: { cwd?: string; env: Record<string, string>; timeout: number; input: Uint8Array | string | null }): Promise<RawResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: [opts.input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, opts.timeout * 1000)
    child.stdout!.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr!.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', (error) => { clearTimeout(timer); reject(new GitError(`could not run ${bin}: ${error.message}`)) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut })
    })
    if (opts.input !== null) {
      child.stdin!.on('error', () => { /* the process may exit before reading */ })
      child.stdin!.end(typeof opts.input === 'string' ? Buffer.from(opts.input, 'utf8') : opts.input)
    }
  })
}

/** Where a working tree's `.git` file points (absolute), or null: a `.git` directory, or no Git at all. */
export function gitPointer(root: string): string | null {
  let pointer: string
  try {
    if (!statSync(join(root, '.git')).isFile()) return null
    pointer = readFileSync(join(root, '.git'), 'utf8')
  } catch { return null }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)
  if (!m) return null
  return isAbsolute(m[1]!) ? m[1]! : join(root, m[1]!)
}

export function checkpointRef(cpId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(cpId)) throw new Error(`bad checkpoint id '${cpId}'`)
  return CHECKPOINT_REF_PREFIX + cpId
}

export function newWorkspaceId(): string {
  return newId('ws')
}
