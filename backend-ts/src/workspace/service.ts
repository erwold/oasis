import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs'
/** Workspaces: import a repository (or start an empty one), open task / verification worktrees, snapshot,
 *  checkpoint, diff. The four things stay apart: the workspace is mutable; a checkpoint is an immutable reference
 *  to an exact snapshot; verification targets an exact snapshot (verify/); and integration is another operation. */

import type { Checkpoint, LockSpec, Project, Snapshot, Workspace } from '@oasis-code/contract'
import type { Settings } from '../config.ts'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { newId } from '../ids.ts'
import { checkpointRef, GitError, GitHost, gitPointer, importReportDict, newWorkspaceId, realSource } from './git.ts'
import { measureFolder, overLimits, SnapshotTooLarge } from './measure.ts'
import { FileJournal } from './journal.ts'
import type { RemoteFiles } from './remote_files.ts'
import { RemoteRefused } from './remote.ts'
import { newWorktreeFolder } from './roots.ts'
import { FolderUnreachable, pinnedRoot, resolveReal, SKIP_DIRS, type AttachedRoot } from './paths.ts'
import { globMatch } from './paths.ts'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'

/** A tree breaks a hard lock: it is not pinned (a checkpoint) or composed (an integration). */
export class LockViolation extends GitError {
  readonly violations: string[]
  constructor(violations: string[]) {
    super('the workspace breaks a hard lock: ' + violations.join('; '))
    this.name = 'LockViolation'
    this.violations = [...violations]
  }
}

/** Per-process state of a workspace: the tree the harness last saw and how many harness-side writes happened
 *  since, so an unexpected change can be labelled external/unknown (never attributed to anyone). */
export interface WorkspaceLive {
  workspace_id: string
  last_tree: string | null
  writes_since_snapshot: number
  external_changes: string[]
}

/** The most of a whole diff's patch sent at once (characters): a page renders this much without stalling. */
export const PATCH_SHOWN_CHARS = 500_000

/** A whole diff's patch cut at a file's boundary once it passes `budget`: the files whose patches fit, how many there
 *  are, and how long the whole was; null when it fits. */
export function cutPatch(patch: string, budget = PATCH_SHOWN_CHARS): { patch: string; cut: { shown_files: number; total_files: number; chars: number } | null } {
  if (patch.length <= budget) return { patch, cut: null }
  const starts = [...patch.matchAll(/^diff --git /gm)].map((m) => m.index!)
  let end = 0
  let shown = 0
  for (let i = 0; i < starts.length; i += 1) {
    const next = starts[i + 1] ?? patch.length
    if (next > budget && shown > 0) break
    end = next
    shown += 1
    if (next > budget) break
  }
  return { patch: patch.slice(0, end), cut: { shown_files: shown, total_files: starts.length, chars: patch.length } }
}

export interface DiffResult {
  base_commit: string; tree_sha: string; snapshot_id: string | null; patch: string;
  files: { path: string; added: number | null; removed: number | null }[]; external_changes: string[]
}

/** What an attached project mounts: the folder's real path under a name inside every workspace (the folder's own
 *  name, or `attached` when that name cannot serve). null for a snapshot project. */
export function attachedOf(project: Pick<Project, 'kind' | 'source_path' | 'import_report'>, opts: { writable?: boolean } = {}): AttachedRoot | null {
  if (project.kind !== 'attached' || !project.source_path) return null
  const recorded = project.import_report.attached_as
  const name = typeof recorded === 'string' && recorded ? recorded : attachedName(project.source_path)
  return { name, root: resolveReal(project.source_path), writable: opts.writable === true }
}

/** Workspace-level sources take precedence over mutable session grants and parent project kind. */
export function workspaceAttached(project: Project, ws: Workspace, opts: { writable?: boolean } = {}): AttachedRoot | null {
  if (ws.source_mount) return { name: ws.source_mount.name, root: pinnedRoot(ws.source_mount.root), writable: false }
  return attachedOf(project, opts)
}

export function attachedName(source: string): string {
  const base = basename(source.replace(/\/+$/, ''))
  return base && base !== '.git' && !base.startsWith('.') && !base.includes('/') ? base : 'attached'
}

/** How many files a folder edited in place lists (its tree is walked, not a repository's index read). */
export const MAX_DIRECT_FILES = 20_000

/** A workspace that is the person's own folder (a direct project's): no repository of the harness's, never removed. */
export function isDirect(ws: Pick<Workspace, 'kind'>): boolean {
  return ws.kind === 'direct'
}

export class WorkspaceService {
  remoteFiles?: RemoteFiles
  requireRemoteFiles(): RemoteFiles {
    if (!this.remoteFiles) throw new RemoteRefused('remote_unavailable', 'Remote file provider unavailable; local fallback refused.', 503)
    return this.remoteFiles
  }
  readonly git: GitHost
  readonly live = new Map<string, WorkspaceLive>()
  /** what the file tools wrote in a folder edited in place, kept first */
  readonly journal: FileJournal
  /** an adoption under way, per workspace: callers that arrive meanwhile wait for it instead of starting a second */
  private readonly adopting = new Map<string, Promise<void>>()
  /** a host passed in belongs to its caller, who closes it */
  private readonly ownsGit: boolean

  constructor(readonly settings: Settings, readonly conn: Conn, git?: GitHost) {
    this.ownsGit = git === undefined
    this.git = git ?? new GitHost()
    this.journal = new FileJournal(conn)
  }

  close(): void {
    if (this.ownsGit) this.git.close()
  }

  /** Only what the harness made is ever removed: a path under its own workspaces folder. The person's folder (a
   *  direct project's workspace), or anything else a row could name, is refused before a byte goes. */
  private assertManaged(path: string): void {
    const root = resolveReal(this.settings.workspaces_dir)
    let real: string
    try { real = resolveReal(path) } catch { real = path }
    if (real === root || !real.startsWith(root + '/')) throw new GitError(`refused to remove ${path}: only a folder the harness made under ${root} is ever removed`)
  }

  // -- projects -------------------------------------------------------------

  baseRepoPath(projectId: string): string {
    return join(this.settings.repos_dir, projectId, 'base.git')
  }

  /** A folder the person points at. A repository root with a commit: its HEAD is cloned (uncommitted changes listed,
   *  not carried). Anything else — a plain folder, a repository with no commit, a directory inside one — is
   *  snapshotted as it is. The person's folder is never written. */
  async importProject(name: string, source: string, opts: { default_model?: string | null; mode?: 'snapshot' | 'attached' | 'direct' | null } = {}): Promise<Project> {
    if (opts.mode === 'attached') return this.attachProject(name, source, opts)
    if (opts.mode === 'direct') return this.directProject(name, source, opts)
    const report = await this.git.inspectSource(source)
    const sourcePath = report.source_path
    const pid = newId('p')
    const base = join(this.settings.repos_dir, pid, 'base.git')
    if (report.kind === 'folder') {
      // a folder is copied whole into the base: not over the limits, which a home folder crosses in a second
      const limits = { max_bytes: this.settings.snapshot_max_bytes, max_files: this.settings.snapshot_max_files }
      const measured = measureFolder(sourcePath, limits)
      if (overLimits(measured, limits)) throw new SnapshotTooLarge(sourcePath, measured, limits)
      const [baseCommit, carried] = await this.git.snapshotFolder(sourcePath, base)
      return repo.createProject(this.conn, name, {
        id: pid, source_path: sourcePath, base_repo_path: base, base_commit: baseCommit, base_branch: 'main',
        import_report: { ...importReportDict(report), ...carried }, default_model: opts.default_model ?? null,
      })
    }
    await this.git.cloneBase(sourcePath, base)
    const baseCommit = await this.git.revParse(base, report.head_commit!)
    return repo.createProject(this.conn, name, {
      id: pid, source_path: sourcePath, base_repo_path: base, base_commit: baseCommit, base_branch: report.branch,
      import_report: importReportDict(report), default_model: opts.default_model ?? null,
    })
  }

  /** A folder attached, not copied: read as it stands and never written. The project's base is an empty repository,
   *  so a session's workspace is a scratch of its own with the folder mounted read-only inside it (createWorkspace). */
  async attachProject(name: string, source: string, opts: { default_model?: string | null } = {}): Promise<Project> {
    const sourcePath = realSource(source)
    let isDir = false
    try { isDir = statSync(sourcePath).isDirectory() } catch { isDir = false }
    if (!isDir) throw new GitError(`${sourcePath} is not a directory`)
    const pid = newId('p')
    const base = join(this.settings.repos_dir, pid, 'base.git')
    const commit = await this.git.initBase(base)
    const attachedAs = attachedName(sourcePath)
    return repo.createProject(this.conn, name, {
      id: pid, kind: 'attached', source_path: sourcePath, base_repo_path: base, base_commit: commit, base_branch: 'main',
      import_report: {
        kind: 'attached', source_path: sourcePath, attached_as: attachedAs, files_carried: 0,
        basis: `attached: the folder is read as it stands and never written; a session's workspace is a scratch of its own with the folder mounted read-only at ${attachedAs}/`,
      },
      default_model: opts.default_model ?? null,
    })
  }

  /** A folder edited in place: nothing copied, no repository made — the project names the folder, at once, whatever
   *  its size. Its sessions work in it; the file tools' writes are journalled first (FileJournal). */
  async directProject(name: string, source: string, opts: { default_model?: string | null } = {}): Promise<Project> {
    const sourcePath = realSource(source)
    let isDir = false
    try { isDir = statSync(sourcePath).isDirectory() } catch { isDir = false }
    if (!isDir) throw new GitError(`${sourcePath} is not a directory`)
    if (sourcePath === '/') throw new GitError('the root of the disk cannot be a project folder')
    return repo.createProject(this.conn, name, {
      kind: 'direct', source_path: sourcePath, base_repo_path: '', base_commit: null, base_branch: null,
      import_report: {
        kind: 'direct', source_path: sourcePath, files_carried: 0,
        basis: "edited in place: nothing copied; the file tools' writes are kept first, so a run's file changes can be undone; a command's writes are its own",
      },
      default_model: opts.default_model ?? null,
    })
  }

  /** A new Git worktree of a local repository, on a new branch, edited in place as a direct project. The repository's
   *  own `git worktree add` makes it: the branch and its commits belong to the repository. The folder, by default
   *  `<repository>-wt-<branch>` beside the repository, is a new one outside the harness's data. */
  async worktreeProject(name: string | null, source: string, wt: { branch: string; base?: string | null; folder?: string | null }, opts: { default_model?: string | null } = {}): Promise<Project> {
    const sourcePath = realSource(source)
    let isDir = false
    try { isDir = statSync(sourcePath).isDirectory() } catch { isDir = false }
    if (!isDir) throw new GitError(`${sourcePath} is not a directory`)
    const top = await this.git.run(['rev-parse', '--show-toplevel'], { cwd: sourcePath, check: false })
    if (top.code !== 0) throw new GitError(`${sourcePath} is not in a Git repository: a worktree is made of a repository`)
    const repository = realSource(top.out.trim())
    if ((await this.git.run(['check-ref-format', '--branch', wt.branch], { cwd: repository, check: false })).code !== 0) throw new GitError(`${wt.branch} is not a valid branch name`)
    if ((await this.git.run(['rev-parse', '--verify', '-q', `refs/heads/${wt.branch}`], { cwd: repository, check: false })).code === 0) {
      throw new GitError(`the branch ${wt.branch} exists in ${repository}: a worktree is made on a new branch (a folder already checked out on it opens by path)`)
    }
    const base = wt.base ?? 'HEAD'
    const resolved = await this.git.run(['rev-parse', '--verify', '-q', `${base}^{commit}`], { cwd: repository, check: false })
    if (resolved.code !== 0) throw new GitError(`${base} names no commit in ${repository}`)
    const baseCommit = resolved.out.trim()
    const folder = newWorktreeFolder(wt.folder ?? join(dirname(repository), `${basename(repository)}-wt-${wt.branch.replace(/[^A-Za-z0-9._-]+/g, '-')}`),
      [this.settings.data_dir, this.settings.workspaces_dir])
    await this.git.run(['worktree', 'add', '-b', wt.branch, folder, baseCommit], { cwd: repository })
    const path = realSource(folder)
    return repo.createProject(this.conn, name || `${basename(repository)} · ${wt.branch}`, {
      kind: 'direct', source_path: path, base_repo_path: '', base_commit: null, base_branch: null,
      import_report: {
        kind: 'direct', source_path: path, files_carried: 0,
        worktree: { repository, branch: wt.branch, base_commit: baseCommit },
        basis: `a Git worktree of ${repository} on the new branch ${wt.branch} from ${baseCommit}, edited in place: the file tools' writes are kept first, so a run's file changes can be undone; a command's writes are its own`,
      },
      default_model: opts.default_model ?? null,
    })
  }

  async createEmptyProject(name: string, opts: { default_model?: string | null } = {}): Promise<Project> {
    const pid = newId('p')
    const base = join(this.settings.repos_dir, pid, 'base.git')
    const commit = await this.git.initBase(base)
    return repo.createProject(this.conn, name, {
      id: pid, source_path: null, base_repo_path: base, base_commit: commit, base_branch: 'main',
      import_report: { basis: 'a new empty repository with one empty initial commit', source_path: null }, default_model: opts.default_model ?? null,
    })
  }

  // -- workspaces -----------------------------------------------------------

  /** The repository of a workspace — its metadata, refs and the objects it makes — beside the base repository. */
  workspaceGitDir(projectId: string, wsId: string): string {
    return join(this.settings.repos_dir, projectId, 'workspaces', `${wsId}.git`)
  }

  /** Where a workspace's Git metadata is: its own repository, or — a workspace made before this layout — its
   *  worktree directory in the base repository. */
  gitDirOf(ws: Pick<Workspace, 'id' | 'project_id' | 'path'>): string {
    const own = this.workspaceGitDir(ws.project_id, ws.id)
    if (existsSync(own)) return own
    return gitPointer(ws.path) ?? join(this.baseRepoPath(ws.project_id), 'worktrees', ws.id)
  }

  /** Where a workspace's objects and refs are read: its working tree while it stands; its repository after (an
   *  integration's tree goes, its composed checkpoint stays); the base repository for a workspace of the earlier
   *  layout, whose checkpoints are pinned there. */
  repoOf(ws: Pick<Workspace, 'id' | 'project_id' | 'path'>): string {
    if (existsSync(join(ws.path, '.git'))) return ws.path
    const own = this.workspaceGitDir(ws.project_id, ws.id)
    return existsSync(own) ? own : this.baseRepoPath(ws.project_id)
  }

  // -- views: what a repository reads besides its own objects ---------------

  viewsDir(projectId: string): string {
    return join(this.settings.repos_dir, projectId, 'views')
  }

  /** The immutable view of an object's reachable closure — a commit, a tree — at `views/<id>`: packed once from
   *  the repository that holds it (`source`; else the workspace whose checkpoint pins it, else the base repository),
   *  the base commit's whole, any other's thin over the base's (its objects beyond the base, so no view repeats the
   *  base). Read by every repository allowed that object; written by none after. */
  async view(project: Project, id: string, source?: string): Promise<string> {
    const dir = join(this.viewsDir(project.id), id)
    if (existsSync(join(dir, 'pack'))) return dir
    const exclude = project.base_commit !== null && id !== project.base_commit ? project.base_commit : null
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`
    await this.git.packView(source ?? this.sourceOf(project, id), id, exclude, tmp)
    try {
      renameSync(tmp, dir)
    } catch {
      rmSync(tmp, { recursive: true, force: true })                 // another call packed it first
      if (!existsSync(join(dir, 'pack'))) throw new GitError(`could not place the object view ${dir}`)
    }
    return dir
  }

  /** The views a repository checked out at `commit` reads: the base commit's, the commit's own beyond it, and the
   *  ones shared into it. */
  private async viewsFor(project: Project, commit: string, share: string[] = []): Promise<string[]> {
    const ids = [...new Set([...(project.base_commit ? [project.base_commit] : []), commit, ...share])]
    const out: string[] = []
    for (const id of ids) out.push(await this.view(project, id))
    return out
  }

  /** Where an object is read from to be packed: the base repository for the base commit, else the repository of the
   *  workspace whose checkpoint pins it, else the base repository. */
  private sourceOf(project: Project, id: string): string {
    if (id === project.base_commit) return project.base_repo_path
    for (const cp of repo.listCheckpointsByCommit(this.conn, id)) {
      const ws = repo.getWorkspace(this.conn, cp.workspace_id)
      if (ws !== null) return this.repoOf(ws)
    }
    return project.base_repo_path
  }

  /** A workspace made before this layout — a worktree of the base repository — taken into a repository of its own
   *  the first time the harness touches it: beside the base, reading the views of the base commit, of every
   *  checkpoint it pinned and of its latest snapshot's tree; its branch and its checkpoint refs written there, its
   *  index rebuilt from HEAD, the tree's `.git` pointer turned to it. The base repository keeps the objects and refs
   *  it holds (nothing is deleted); only the stale worktree registration goes. A workspace already its own repository
   *  is left alone. Two touches at once (a page opening the workspace's detail and its diff together) adopt once:
   *  the second waits for the first, never a second `git init` on the same repository. */
  async adopt(ws: Workspace, projectIn?: Project): Promise<void> {
    if (isDirect(ws)) return
    const project = projectIn ?? repo.getProject(this.conn, ws.project_id)
    if (project === null) throw new GitError(`project ${ws.project_id} not found`)
    const base = project.base_repo_path
    const pointer = gitPointer(ws.path)
    if (pointer === null || !resolveReal(pointer).startsWith(join(resolveReal(base), 'worktrees') + '/')) return
    const underWay = this.adopting.get(ws.id)
    if (underWay) return underWay
    const task = this.adoptNow(ws, project, base, pointer).finally(() => this.adopting.delete(ws.id))
    this.adopting.set(ws.id, task)
    return task
  }

  private async adoptNow(ws: Workspace, project: Project, base: string, pointer: string): Promise<void> {
    const head = await this.git.revParse(ws.path, 'HEAD')
    const pins = repo.listCheckpoints(this.conn, ws.id)
    const latest = repo.latestSnapshot(this.conn, ws.id)
    const ids = [...new Set([...(project.base_commit ? [project.base_commit] : []), head, ...pins.map((cp) => cp.commit_sha), ...(latest ? [latest.tree_sha] : [])])]
    const alternates: string[] = []
    for (const id of ids) alternates.push(await this.view(project, id, ws.path))
    const gitDir = this.workspaceGitDir(project.id, ws.id)
    rmSync(gitDir, { recursive: true, force: true })
    await this.git.adoptRepo(base, ws.path, gitDir, { branch: ws.branch, head, refs: pins.map((cp) => [cp.ref, cp.commit_sha]), alternates })
    await this.git.run(['worktree', 'prune'], { cwd: base, check: false })
    rmSync(pointer, { recursive: true, force: true })
  }

  /** A workspace: a repository of its own with its working tree checked out at the base — the project's, or a
   *  checkpoint's commit — reading the views of the base, of that commit and of the checkpoints in `share`
   *  (an integration's), and nothing a workspace writes to. */
  async createWorkspace(project: Project, sessionId: string | null, opts: { kind?: string; base_commit?: string | null; share?: string[] } = {}): Promise<Workspace> {
    if (project.target?.kind === 'ssh') {
      if (project.kind !== 'direct' || !project.remote || opts.base_commit || opts.share?.length || (opts.kind && opts.kind !== 'task')) throw new RemoteRefused('capability_unavailable', 'Remote projects support direct workspaces only.')
      const existing = repo.listWorkspaces(this.conn, project.id).find(w => w.kind === 'direct')
      return existing ?? repo.insertWorkspace(this.conn, newWorkspaceId(), project.id, sessionId, project.remote.path, '', '', 'direct', null, project.remote)
    }
    // a folder edited in place is one workspace, whoever asks for one — a session, a work order's run, an
    // interaction's step: its writers take turns on it (the workspace lock), never on copies
    if (project.kind === 'direct') {
      const existing = repo.listWorkspaces(this.conn, project.id).find((w) => isDirect(w))
      if (existing) return existing
      return repo.insertWorkspace(this.conn, newWorkspaceId(), project.id, sessionId, resolveReal(project.source_path!), '', '', 'direct')
    }
    const wsId = newWorkspaceId()
    const path = join(this.settings.workspaces_dir, wsId)
    const commit = opts.base_commit || project.base_commit
    if (!commit) throw new GitError('the project has no base commit')
    const branch = `oasis-code/${wsId}`
    const alternates = await this.viewsFor(project, commit, opts.share ?? [])
    await this.git.openRepo(project.base_repo_path, path, this.workspaceGitDir(project.id, wsId), { branch, commit, alternates })
    const attached = attachedOf(project)
    if (attached !== null) await this.mountAttached(path, attached)
    const ws = repo.insertWorkspace(this.conn, wsId, project.id, sessionId, path, branch, commit, opts.kind ?? 'task')
    this.live.set(wsId, { workspace_id: wsId, last_tree: await this.git.treeOf(path, commit), writes_since_snapshot: 0, external_changes: [] })
    return ws
  }

  /** The session's source is derived here, never supplied by a model. No hidden session/project and no copy. */
  async createSourceWorkspace(project: Project, sessionId: string, source: Workspace): Promise<Workspace> {
    if (project.target?.kind === 'ssh' || source.target?.kind === 'ssh') throw new RemoteRefused('capability_unavailable', 'Remote isolated copies are unavailable.')
    // Validate the originally approved path before attachedOf can canonicalize a replacement symlink.
    const root = source.source_mount?.root ?? (isDirect(source) ? source.path : project.kind === 'attached' ? project.source_path : null)
    if (!root) throw new GitError('this workspace has no live source to mount')
    const canonical = pinnedRoot(root)
    const attached = workspaceAttached(project, source)
    for (const directory of [this.settings.data_dir, this.settings.workspaces_dir]) {
      const managed = resolveReal(directory)
      const inside = (a: string, b: string) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
      if (inside(canonical, managed) || inside(managed, canonical)) throw new GitError('source overlaps harness data/workspaces; an isolated source must be disjoint before any workspace is created')
    }
    const mount = { root: canonical, name: attached?.name ?? attachedName(root), readonly: true as const }
    const id = newWorkspaceId()
    const path = join(this.settings.workspaces_dir, id)
    const branch = `oasis-code/${id}`
    const commit = await this.git.initScratch(path, this.workspaceGitDir(project.id, id), branch)
    await this.mountAttached(path, mount)
    return repo.insertWorkspace(this.conn, id, project.id, sessionId, path, branch, commit, 'child', mount)
  }

  /** The attached folder inside a workspace: a symlink named after it, excluded from the workspace's snapshots and
   *  diffs (its repository's info/exclude), so the folder is reached as `<name>/…` by the file tools and by
   *  commands alike and never becomes part of the workspace's tree. */
  private async mountAttached(worktree: string, attached: AttachedRoot): Promise<void> {
    symlinkSync(attached.root, join(worktree, attached.name))
    const exclude = (await this.git.run(['rev-parse', '--git-path', 'info/exclude'], { cwd: worktree })).out.trim()
    const excludePath = isAbsolute(exclude) ? exclude : join(worktree, exclude)
    mkdirSync(dirname(excludePath), { recursive: true })
    const line = `/${attached.name}\n`
    let current = ''
    try { current = readFileSync(excludePath, 'utf8') } catch { current = '' }
    if (!current.split('\n').includes(line.trim())) appendFileSync(excludePath, (current && !current.endsWith('\n') ? '\n' : '') + line)
  }

  /** A detached checkout of `commit` for a verification, reading the views of the base and of that commit — that
   *  checkpoint, not the rest of its workspace; removed whole with removeVerificationWorktree. */
  async openVerificationWorktree(project: Project, commit: string): Promise<string> {
    const id = `verify_${newId('v')}`
    const path = join(this.settings.workspaces_dir, id)
    await this.git.openRepo(project.base_repo_path, path, this.workspaceGitDir(project.id, id), { branch: null, commit, alternates: await this.viewsFor(project, commit) })
    return path
  }

  async removeVerificationWorktree(project: Project, path: string): Promise<void> {
    this.assertManaged(path)
    await this.git.removeTree(project.base_repo_path, path, this.workspaceGitDir(project.id, basename(path)))
  }

  /** A workspace's working tree removed; its repository — its checkpoints — stays. */
  async removeWorkingTree(ws: Workspace): Promise<void> {
    if (isDirect(ws)) throw new GitError('the folder is the person\'s own: the harness never removes it')
    this.assertManaged(ws.path)
    await this.git.removeTree(this.baseRepoPath(ws.project_id), ws.path, null)
  }

  liveOf(ws: Workspace): WorkspaceLive {
    let state = this.live.get(ws.id)
    if (!state) {
      const latest = repo.latestSnapshot(this.conn, ws.id)
      state = { workspace_id: ws.id, last_tree: latest ? latest.tree_sha : null, writes_since_snapshot: 0, external_changes: [] }
      this.live.set(ws.id, state)
    }
    return state
  }

  noteWrite(ws: Workspace): void {
    this.liveOf(ws).writes_since_snapshot += 1
  }

  // -- snapshot / checkpoint / diff ----------------------------------------

  async snapshot(ws: Workspace): Promise<Snapshot> {
    if (isDirect(ws)) throw new GitError('a folder edited in place has no snapshots: its file changes are in the journal')
    await this.adopt(ws)
    const info = await this.git.snapshotTree(ws.path, ws.base_commit)
    const state = this.liveOf(ws)
    if (state.last_tree !== null && info.tree_sha !== state.last_tree && state.writes_since_snapshot === 0) {
      // the tree moved and no tool wrote: someone or something else did; the author is unknown and the record
      // keeps every such path (a later harness write does not erase what was seen)
      for (const changed of await this.git.changedPaths(ws.path, state.last_tree, info.tree_sha)) {
        if (!state.external_changes.includes(changed)) state.external_changes.push(changed)
      }
    }
    state.last_tree = info.tree_sha
    state.writes_since_snapshot = 0
    return repo.insertSnapshot(this.conn, ws.id, ws.base_commit, info.tree_sha, info.file_count, info.untracked, info.excluded, info.changed)
  }

  /** Pin the workspace's exact state as an immutable commit under refs/oasis-code/checkpoints/. Partial or failing
   *  work may be pinned; a checkpoint is not an acceptance. `expected_tree` refuses to pin a tree that moved since
   *  the caller looked. */
  async checkpoint(ws: Workspace, runId: string | null, note: string, opts: { expected_tree?: string | null; locks?: LockSpec[] | null } = {}): Promise<Checkpoint> {
    if (isDirect(ws)) throw new GitError("a folder edited in place has no checkpoints: a run's file changes can be undone instead")
    const snap = await this.snapshot(ws)
    if (opts.expected_tree != null && snap.tree_sha !== opts.expected_tree) {
      throw new GitError(`workspace version conflict: expected tree ${opts.expected_tree.slice(0, 12)}, found ${snap.tree_sha.slice(0, 12)}`)
    }
    if (opts.locks?.length) {
      const { checkTree } = await import('../policy/locks.ts')
      const violations = await checkTree(this.git, ws.path, await this.git.treeOf(ws.path, ws.base_commit), snap.tree_sha, opts.locks)
      if (violations.length) throw new LockViolation(violations)
    }
    const previous = repo.latestCheckpoint(this.conn, ws.id)
    const parentSha = previous ? previous.commit_sha : ws.base_commit
    const cpId = newId('cp')
    const message = `oasis-code checkpoint ${cpId}\n\n${note}`.trim()
    // the commit and its ref in the workspace's own repository: pinned there, read by no other workspace
    const sha = await this.git.commitTree(ws.path, snap.tree_sha, parentSha, message)
    const ref = checkpointRef(cpId)
    await this.git.pinRef(ws.path, ref, sha)
    return repo.insertCheckpoint(this.conn, cpId, ws.id, runId, snap.id, sha, ref, previous ? previous.id : null, note)
  }

  /** The unified diff of the workspace (a fresh snapshot tree, so new files count) against its base commit (or `from`). */
  async diff(ws: Workspace, opts: { tree?: string | null; paths?: string[] | null; full?: boolean; from?: string | null } = {}): Promise<DiffResult> {
    if (isDirect(ws)) {
      // the tools' changes still standing, against the file before each was first written (the journal)
      const changes = (ws.target?.kind === 'ssh' ? await this.requireRemoteFiles().changes(ws) : this.journal.folderChanges(ws)).filter((c) => !opts.paths || opts.paths.includes(c.path))
      const { patch, files } = this.journal.diffOf(changes, opts.full === true)
      return { base_commit: '', tree_sha: '', snapshot_id: null, patch, files, external_changes: [] }
    }
    await this.adopt(ws)
    const repoPath = this.repoOf(ws)
    let tree = opts.tree ?? null
    let snapshotId: string | null = null
    if (tree === null) {
      const snap = await this.snapshot(ws)
      tree = snap.tree_sha
      snapshotId = snap.id
    }
    // `from`: another tree to measure against (a run's own baseline); else the workspace's base
    const from = opts.from ?? ws.base_commit
    const patch = await this.git.diffTrees(repoPath, from, tree, { paths: opts.paths ?? null, full: opts.full === true })
    const stat = await this.git.numstat(repoPath, from, tree)
    const state = this.liveOf(ws)
    return { base_commit: ws.base_commit, tree_sha: tree, snapshot_id: snapshotId, patch, files: stat, external_changes: [...state.external_changes] }
  }

  async status(ws: Workspace): Promise<Record<string, unknown>> {
    if (isDirect(ws)) {
      let changes
      try { changes = ws.target?.kind === 'ssh' ? await this.requireRemoteFiles().changes(ws) : this.journal.folderChanges(ws) } catch (error) {
        // the folder cannot be reached: nothing is known of its files (not "all removed"), and the page says why
        if (error instanceof FolderUnreachable) return { modified: [], added: [], deleted: [], untracked: [], renamed: [], base_commit: '', branch: '', path: ws.path, external_changes: [], in_place: true, unreachable: error.message }
        throw error
      }
      return {
        modified: changes.filter((c) => c.before !== null && c.after !== null).map((c) => c.path), added: changes.filter((c) => c.before === null).map((c) => c.path),
        deleted: changes.filter((c) => c.after === null).map((c) => c.path), untracked: [], renamed: [], base_commit: '', branch: '', path: ws.path,
        external_changes: [], in_place: true,
      }
    }
    await this.adopt(ws)
    const st = await this.git.status(ws.path)
    const state = this.liveOf(ws)
    return { ...st, base_commit: ws.base_commit, branch: ws.branch, path: ws.path, external_changes: [...state.external_changes] }
  }

  async listFiles(ws: Workspace): Promise<string[]> {
    if (ws.target?.kind === 'ssh') return (await this.requireRemoteFiles().list(ws)).entries.map(e => e.path)
    if (isDirect(ws)) return walkFolder(pinnedRoot(ws.path), MAX_DIRECT_FILES)
    await this.adopt(ws)
    return this.git.lsFiles(ws.path)
  }
}

/** A folder's files by walking it (no repository to ask): relative paths, sorted by directory, the tool and build
 *  folders skipped (SKIP_DIRS), links not followed, at most `max`. */
export function walkFolder(root: string, max: number): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string): void => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) } catch { return }
    for (const entry of entries) {
      if (out.length >= max) return
      if (entry.isSymbolicLink()) continue
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), path) } else if (entry.isFile()) out.push(path)
    }
  }
  walk(root, '')
  return out
}

export function matchesProtected(path: string, patterns: string[]): boolean {
  return patterns.some((p) => globMatch(path, p))
}
