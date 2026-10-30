/** Git as a workspace's commands see it: a repository of the workspace's own beside the base one, reading through
 *  its alternates only immutable views — the base commit's objects, the commit it starts from, the checkpoints
 *  shared into it — and pinning its checkpoints in itself; so `git status`, `git diff`, `git log`, `git show <own
 *  checkpoint>` work, no metadata is ever written, and what it was not given is never read — not a sibling
 *  workspace's checkpoints, not what its parent pinned after it started, not what an earlier-layout session pinned
 *  into the base repository, not another project's repository, not the data directory beside them: not by ref, not
 *  by commit, not by blob, not by enumeration. The repository view holds on any platform; the kernel's part (macOS
 *  Seatbelt) is what the real-sandbox tests show. A workspace of the earlier layout — a worktree of the base — is
 *  taken into a repository of its own the first time the harness touches it, its pins kept. */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Project, Workspace } from '@oasis-code/contract'
import { sandboxForWorkspace, worktreeGitDir } from '../src/agent/tools/commands.ts'
import * as repo from '../src/db/repo.ts'
import { ancestorsBetween, buildRuntime, type IsolationReport, type IsolationRuntime } from '../src/execution/isolation.ts'
import { ProcessManager } from '../src/execution/processes.ts'
import { AssetStore } from '../src/store.ts'
import { resolveReal } from '../src/workspace/paths.ts'
import { alternateObjectDirs } from '../src/workspace/sandbox.ts'
import { buggyRepo, domainState, git, type DomainState } from './harness.ts'

let state: DomainState | null = null
const closers: (() => Promise<void>)[] = []
afterEach(async () => { for (const c of closers.splice(0)) await c(); if (state) await state.close(); state = null })

/** `git` that may fail: its output, or null. */
function tryGit(args: string[], cwd: string): string | null {
  try { return git(args, cwd) } catch { return null }
}

const MARKER = 'SYNTHETIC_SIBLING_MARKER_4d2f'

/** Two workspaces of one project; the sibling pins a file only it has, the workspace pins one of its own. */
async function twoWorkspaces(s: DomainState) {
  const project = await s.workspaces.importProject('calc', buggyRepo())
  const ws = await s.workspaces.createWorkspace(project, repo.createSession(s.conn, project.id, 'mine', 'scripted:a').id)
  const sibling = await s.workspaces.createWorkspace(project, repo.createSession(s.conn, project.id, 'other', 'scripted:a').id)
  writeFileSync(join(sibling.path, 'sibling-only.txt'), MARKER + '\n')
  s.workspaces.noteWrite(sibling)
  const cpSibling = await s.workspaces.checkpoint(sibling, null, 'sibling only')
  const blob = git(['rev-parse', `${cpSibling.ref}:sibling-only.txt`], sibling.path)
  writeFileSync(join(ws.path, 'mine.txt'), 'MINE\n')
  s.workspaces.noteWrite(ws)
  const cpOwn = await s.workspaces.checkpoint(ws, null, 'own')
  return { project, ws, sibling, cpSibling, blob, cpOwn }
}

/** A workspace as the earlier layout made it: a worktree of the base repository on its branch. */
function legacyWorkspace(s: DomainState, project: Project, name: string): Workspace {
  const id = `ws_legacy_${name}`
  const path = join(s.settings.workspaces_dir, id)
  mkdirSync(dirname(path), { recursive: true })
  git(['worktree', 'add', '-q', '-b', `oasis-code/${id}`, path, project.base_commit!], project.base_repo_path)
  const session = repo.createSession(s.conn, project.id, name, 'scripted:a')
  return repo.insertWorkspace(s.conn, id, project.id, session.id, path, `oasis-code/${id}`, project.base_commit!, 'task')
}

/** A checkpoint as the earlier layout pinned it: the commit and its ref in the base repository (the worktree's common
 *  store), the rows the harness kept — made without the service, so nothing adopts the worktree first. */
function legacyPin(s: DomainState, ws: Workspace, file: string, marker: string): { ref: string; commit: string; blob: string; tree: string } {
  writeFileSync(join(ws.path, file), marker + '\n')
  git(['add', '--', file], ws.path)
  const tree = git(['write-tree'], ws.path)
  git(['reset', '-q'], ws.path)
  const cpId = `cp_legacy_${file.replace(/\W/g, '')}`
  const ref = `refs/oasis-code/checkpoints/${cpId}`
  const commit = git(['commit-tree', tree, '-p', ws.base_commit, '-m', `oasis-code checkpoint ${cpId}`], ws.path)
  git(['update-ref', ref, commit], ws.path)
  const snap = repo.insertSnapshot(s.conn, ws.id, ws.base_commit, tree, 5, [file], [], [`A ${file}`])
  repo.insertCheckpoint(s.conn, cpId, ws.id, null, snap.id, commit, ref, null, marker)
  return { ref, commit, blob: git(['rev-parse', `${commit}:${file}`], ws.path), tree }
}

/** The enumeration of every object a repository can reach through its stores. */
function objectsOf(cwd: string): string {
  return git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'], cwd)
}

async function realSandbox(s: DomainState): Promise<{ runtime: IsolationRuntime; report: IsolationReport; processes: ProcessManager }> {
  const runtime = buildRuntime()
  const report = await runtime.probe(s.settings.data_dir)
  expect(report.enforcement).toBe('full')
  const processes = new ProcessManager(s.settings, s.conn, new AssetStore(s.settings.assets_dir), runtime, report)
  closers.push(() => processes.shutdown())
  return { runtime, report, processes }
}

test('a workspace is a repository of its own: the base objects read through its alternates, its checkpoints pinned in it, a sibling checkpoint never seen', async () => {
  state = domainState()
  const { workspaces } = state
  const { project, ws, sibling, cpSibling, blob, cpOwn } = await twoWorkspaces(state)
  const base = resolveReal(project.base_repo_path)
  // the layout: a pointer file in the tree, the repository beside the base, its alternates naming the base commit's
  // view only — never the base repository's own object store
  const baseView = join(workspaces.viewsDir(project.id), project.base_commit!)
  expect(readFileSync(join(ws.path, '.git'), 'utf8').trim()).toBe(`gitdir: ${workspaces.workspaceGitDir(project.id, ws.id)}`)
  expect(workspaces.gitDirOf(ws)).toBe(workspaces.workspaceGitDir(project.id, ws.id))
  expect(worktreeGitDir(resolveReal(ws.path), base)).toBeNull()
  expect(alternateObjectDirs(join(workspaces.gitDirOf(ws), 'objects'))).toEqual([resolveReal(baseView)])
  expect(existsSync(join(baseView, 'pack'))).toBe(true)
  expect(git(['rev-parse', 'HEAD'], ws.path)).toBe(project.base_commit!)
  expect(git(['branch', '--show-current'], ws.path)).toBe(ws.branch)
  expect(existsSync(join(workspaces.gitDirOf(ws), 'hooks'))).toBe(false)                    // no template: nothing to run
  // the confinement: the tree writable, its pointer and the base never written; the repository and the object
  // stores its alternates name readable; no nested rules, the root pinned
  const box = sandboxForWorkspace(state.settings.data_dir, project, ws, { network: false })
  expect(box.read_allow).toEqual([resolveReal(ws.path), workspaces.gitDirOf(ws), resolveReal(baseView)])
  expect(box.write_deny).toEqual([join(resolveReal(ws.path), '.git'), base])
  expect(box.read_deny_within ?? []).toEqual([])
  expect(box.pinned).toEqual([resolveReal(ws.path)])
  // its own history and the base's read
  expect(git(['rev-parse', cpOwn.ref], ws.path)).toBe(cpOwn.commit_sha)
  expect(git(['show', `${cpOwn.ref}:mine.txt`], ws.path)).toBe('MINE')
  expect(git(['show', 'HEAD:calc.py'], ws.path)).toContain('return a - b')
  expect(git(['for-each-ref', '--format=%(refname)', 'refs/oasis-code/checkpoints/'], ws.path)).toBe(cpOwn.ref)
  // the sibling's: not by ref, not by commit, not by blob, not by enumeration
  expect(tryGit(['rev-parse', '--verify', '-q', cpSibling.ref], ws.path)).toBeNull()
  expect(tryGit(['show', `${cpSibling.ref}:sibling-only.txt`], ws.path)).toBeNull()
  expect(tryGit(['cat-file', '-p', blob], ws.path)).toBeNull()
  expect(tryGit(['cat-file', '-e', cpSibling.commit_sha], ws.path)).toBeNull()
  const all = git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'], ws.path)
  expect(all).not.toContain(blob)
  expect(all).not.toContain(cpSibling.commit_sha)
  expect(all).toContain(cpOwn.commit_sha)
  // nothing a workspace makes enters the base repository: no pin, no object, no branch
  expect(tryGit(['cat-file', '-e', blob], base)).toBeNull()
  expect(tryGit(['cat-file', '-e', cpOwn.commit_sha], base)).toBeNull()
  expect(git(['for-each-ref', 'refs/oasis-code/'], base)).toBe('')
  expect(git(['for-each-ref', '--format=%(refname)', 'refs/heads/'], base)).toBe('refs/heads/main')
  // the sibling reads its own
  expect(git(['show', `${cpSibling.ref}:sibling-only.txt`], sibling.path)).toBe(MARKER)
})

test('a verification checkout reads the view of that checkpoint and no more of its workspace — not what it pins afterwards; removed, its repository goes with it', async () => {
  state = domainState()
  const { workspaces } = state
  const { project, ws, sibling, cpSibling, blob, cpOwn } = await twoWorkspaces(state)
  const views = workspaces.viewsDir(project.id)
  const path = await workspaces.openVerificationWorktree(project, cpSibling.commit_sha)
  const gitDir = workspaces.workspaceGitDir(project.id, path.slice(path.lastIndexOf('/') + 1))
  expect(readFileSync(join(path, 'sibling-only.txt'), 'utf8').trim()).toBe(MARKER)
  expect(git(['rev-parse', 'HEAD'], path)).toBe(cpSibling.commit_sha)
  expect(alternateObjectDirs(join(gitDir, 'objects'))).toEqual([resolveReal(join(views, project.base_commit!)), resolveReal(join(views, cpSibling.commit_sha))])
  expect(git(['cat-file', '-t', blob], path)).toBe('blob')
  expect(tryGit(['cat-file', '-e', cpOwn.commit_sha], path)).toBeNull()                    // the other workspace's pin: not shared
  // what the checkpoint's workspace pins after the checkout exists is not in the view
  writeFileSync(join(sibling.path, 'later.txt'), 'SIBLING_LATER_9e8d\n')
  workspaces.noteWrite(sibling)
  const later = await workspaces.checkpoint(sibling, null, 'later')
  const laterBlob = git(['rev-parse', `${later.ref}:later.txt`], sibling.path)
  expect(tryGit(['cat-file', '-p', laterBlob], path)).toBeNull()
  expect(tryGit(['show', `${later.commit_sha}:later.txt`], path)).toBeNull()
  expect(objectsOf(path)).not.toContain(laterBlob)
  expect(objectsOf(path)).toContain(blob)
  const box = sandboxForWorkspace(state.settings.data_dir, project, { path }, { network: false })
  expect(box.read_allow).toEqual([resolveReal(path), gitDir, resolveReal(join(views, project.base_commit!)), resolveReal(join(views, cpSibling.commit_sha))])
  expect(box.read_allow).not.toContain(workspaces.gitDirOf(sibling))
  await workspaces.removeVerificationWorktree(project, path)
  expect(existsSync(path)).toBe(false)
  expect(existsSync(gitDir)).toBe(false)
  // the workspaces' repositories and pins are as they were
  expect(git(['rev-parse', cpSibling.ref], sibling.path)).toBe(cpSibling.commit_sha)
  expect(git(['rev-parse', later.ref], sibling.path)).toBe(later.commit_sha)
  expect(git(['rev-parse', cpOwn.ref], ws.path)).toBe(cpOwn.commit_sha)
})

test('a child at its parent\'s checkpoint reads that checkpoint, not what the parent pins after the child started', async () => {
  state = domainState()
  const { workspaces, conn } = state
  const project = await workspaces.importProject('calc', buggyRepo())
  const parent = await workspaces.createWorkspace(project, repo.createSession(conn, project.id, 'parent', 'scripted:a').id)
  writeFileSync(join(parent.path, 'authorized.txt'), 'AUTHORIZED_CP1_5b0c\n')
  workspaces.noteWrite(parent)
  const cp1 = await workspaces.checkpoint(parent, null, 'cp1')
  const child = await workspaces.createWorkspace(project, repo.createSession(conn, project.id, 'child', 'scripted:a').id, { kind: 'child', base_commit: cp1.commit_sha })
  writeFileSync(join(parent.path, 'future-parent-only.txt'), 'PARENT_FUTURE_CP2_3a7e\n')
  workspaces.noteWrite(parent)
  const cp2 = await workspaces.checkpoint(parent, null, 'cp2')
  const futureBlob = git(['rev-parse', `${cp2.ref}:future-parent-only.txt`], parent.path)
  const views = workspaces.viewsDir(project.id)
  expect(alternateObjectDirs(join(workspaces.gitDirOf(child), 'objects'))).toEqual([resolveReal(join(views, project.base_commit!)), resolveReal(join(views, cp1.commit_sha))])
  expect(git(['rev-parse', 'HEAD'], child.path)).toBe(cp1.commit_sha)
  expect(readFileSync(join(child.path, 'authorized.txt'), 'utf8').trim()).toBe('AUTHORIZED_CP1_5b0c')
  expect(git(['show', 'HEAD:authorized.txt'], child.path)).toBe('AUTHORIZED_CP1_5b0c')
  expect(git(['show', 'HEAD:calc.py'], child.path)).toContain('return a - b')
  expect(tryGit(['cat-file', '-p', futureBlob], child.path)).toBeNull()
  expect(tryGit(['show', `${cp2.commit_sha}:future-parent-only.txt`], child.path)).toBeNull()
  expect(tryGit(['cat-file', '-e', cp2.commit_sha], child.path)).toBeNull()
  expect(tryGit(['rev-parse', '--verify', '-q', cp2.ref], child.path)).toBeNull()
  const all = objectsOf(child.path)
  expect(all).toContain(cp1.commit_sha)
  expect(all).not.toContain(futureBlob)
  expect(all).not.toContain(cp2.commit_sha)
  // the child works: it pins on cp1, diffs against it, and its pin is its own
  writeFileSync(join(child.path, 'child.txt'), 'c\n')
  workspaces.noteWrite(child)
  const cpChild = await workspaces.checkpoint(child, null, 'child pin')
  expect(git(['rev-parse', `${cpChild.commit_sha}^`], child.path)).toBe(cp1.commit_sha)
  expect((await workspaces.diff(child)).files.map((f) => f.path)).toEqual(['child.txt'])
  expect(tryGit(['cat-file', '-e', cpChild.commit_sha], parent.path)).toBeNull()
  const box = sandboxForWorkspace(state.settings.data_dir, project, child, { network: false })
  expect(box.read_allow).toEqual([resolveReal(child.path), workspaces.gitDirOf(child), resolveReal(join(views, project.base_commit!)), resolveReal(join(views, cp1.commit_sha))])
})

test('a workspace of the earlier layout is taken into a repository of its own when the harness touches it: its pins kept and readable, the base repository as it was', async () => {
  state = domainState()
  const { workspaces } = state
  const project = await workspaces.importProject('calc', buggyRepo())
  const ws = legacyWorkspace(state, project, 'a')
  const sibling = legacyWorkspace(state, project, 'b')
  const base = resolveReal(project.base_repo_path)
  const dir = worktreeGitDir(resolveReal(ws.path), base)!
  expect(dir).toBe(join(base, 'worktrees', ws.id))
  expect(workspaces.gitDirOf(ws)).toBe(dir)
  expect(workspaces.repoOf(ws)).toBe(ws.path)
  // not yet adopted: its refs and config readable, the base repository's object store not (the store every earlier
  // worktree pinned into), nor its other worktrees; nothing is written
  const before = sandboxForWorkspace(state.settings.data_dir, project, ws, { network: false })
  expect(before.read_allow).toEqual([resolveReal(ws.path), base])
  expect(before.read_deny_within).toEqual([join(base, 'worktrees'), join(base, 'objects')])
  expect(before.read_allow_within).toEqual([dir])
  expect(before.pinned).toEqual([resolveReal(ws.path)])
  // a pin of the earlier days, in the base repository; a sibling's too
  const old = legacyPin(state, ws, 'legacy-old.txt', 'LEGACY_OLD_PIN_2c4a')
  const siblingOld = legacyPin(state, sibling, 'sibling-old.txt', 'SIBLING_OLD_PIN_7f1b')
  writeFileSync(join(ws.path, 'calc.py'), 'def add(a, b):\n    return a + b\n')
  // the first touch adopts: the tree's pointer turns to a repository beside the base, reading the views of the base
  // and of its own pins; its branch and its refs are there; the files and the base repository are as they were
  expect(Object.keys(await workspaces.status(ws))).toContain('modified')
  const own = workspaces.workspaceGitDir(project.id, ws.id)
  expect(readFileSync(join(ws.path, '.git'), 'utf8').trim()).toBe(`gitdir: ${own}`)
  expect(workspaces.gitDirOf(ws)).toBe(own)
  expect(existsSync(dir)).toBe(false)
  const views = workspaces.viewsDir(project.id)
  expect(alternateObjectDirs(join(own, 'objects'))).toEqual([resolveReal(join(views, project.base_commit!)), resolveReal(join(views, old.commit)), resolveReal(join(views, old.tree))])
  expect(git(['branch', '--show-current'], ws.path)).toBe(ws.branch)
  expect(git(['rev-parse', 'HEAD'], ws.path)).toBe(project.base_commit!)
  expect(git(['rev-parse', old.ref], ws.path)).toBe(old.commit)
  expect(git(['show', `${old.ref}:legacy-old.txt`], ws.path)).toBe('LEGACY_OLD_PIN_2c4a')
  expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toContain('return a + b')
  expect(git(['status', '--short'], ws.path).split('\n').map((l) => l.trim())).toEqual(['M calc.py', '?? legacy-old.txt'])   // the index rebuilt from HEAD; the pin's file left untracked by the helper
  expect(git(['rev-parse', old.ref], base)).toBe(old.commit)                                  // kept in the base
  expect(git(['rev-parse', siblingOld.ref], base)).toBe(siblingOld.commit)
  // the sibling's earlier pin is not in this workspace's view
  expect(tryGit(['cat-file', '-p', siblingOld.blob], ws.path)).toBeNull()
  expect(tryGit(['cat-file', '-e', siblingOld.commit], ws.path)).toBeNull()
  expect(objectsOf(ws.path)).not.toContain(siblingOld.blob)
  // adopted, it pins in its own repository — on its old pin — and diffs; nothing more enters the base
  const cp = await workspaces.checkpoint(ws, null, 'after adoption')
  expect(cp.parent_checkpoint_id).toBe(`cp_legacy_legacyoldtxt`)
  expect(git(['rev-parse', `${cp.commit_sha}^`], ws.path)).toBe(old.commit)
  expect(git(['rev-parse', cp.ref], ws.path)).toBe(cp.commit_sha)
  expect(tryGit(['cat-file', '-e', cp.commit_sha], base)).toBeNull()
  expect((await workspaces.diff(ws)).patch).toContain('+    return a + b')
  const after = sandboxForWorkspace(state.settings.data_dir, project, ws, { network: false })
  expect(after.read_allow).toEqual([resolveReal(ws.path), own, ...alternateObjectDirs(join(own, 'objects'))])
  expect(after.read_deny_within ?? []).toEqual([])
  await workspaces.removeWorkingTree(ws)
  expect(existsSync(ws.path)).toBe(false)
  expect(git(['rev-parse', cp.ref], workspaces.repoOf(ws))).toBe(cp.commit_sha)
  expect(git(['rev-parse', old.ref], base)).toBe(old.commit)
})

test('two touches at once adopt an earlier-layout workspace once: the detail and the diff a page asks for together both answer, one repository, no second git init', async () => {
  state = domainState()
  const { workspaces } = state
  const project = await workspaces.importProject('calc', buggyRepo())
  const ws = legacyWorkspace(state, project, 'c')
  writeFileSync(join(ws.path, 'calc.py'), 'def add(a, b):\n    return a + b\n')
  // the page opens the workspace: its status and its diff are asked for at the same moment
  const [status, diff] = await Promise.all([workspaces.status(ws), workspaces.diff(ws)])
  expect(status.modified).toEqual(['calc.py'])
  expect(diff.patch).toContain('+    return a + b')
  const own = workspaces.workspaceGitDir(project.id, ws.id)
  expect(readFileSync(join(ws.path, '.git'), 'utf8').trim()).toBe(`gitdir: ${own}`)
  expect(existsSync(join(own, 'config.lock'))).toBe(false)
  expect(git(['rev-parse', 'HEAD'], ws.path)).toBe(project.base_commit!)
  // adopted, a second pair of touches finds nothing to do
  await Promise.all([workspaces.adopt(ws, project), workspaces.adopt(ws, project), workspaces.status(ws)])
  expect(readFileSync(join(ws.path, '.git'), 'utf8').trim()).toBe(`gitdir: ${own}`)
})

test('a new session on a project with earlier-layout pins reads the imported base only: not a pin from before, not one made after it', async () => {
  state = domainState()
  const { workspaces, conn } = state
  const project = await workspaces.importProject('calc', buggyRepo())
  const legacy = legacyWorkspace(state, project, 'old')
  const base = resolveReal(project.base_repo_path)
  const before = legacyPin(state, legacy, 'legacy-session-only.txt', 'LEGACY_PRIVATE_BEFORE_6d2e')
  const fresh = await workspaces.createWorkspace(project, repo.createSession(conn, project.id, 'new', 'scripted:a').id)
  // the earlier session goes on (adopted at its next touch) and pins again
  writeFileSync(join(legacy.path, 'legacy-later.txt'), 'LEGACY_PRIVATE_AFTER_0b9c\n')
  workspaces.noteWrite(legacy)
  const after = await workspaces.checkpoint(legacy, null, 'later')
  const afterBlob = git(['rev-parse', `${after.ref}:legacy-later.txt`], legacy.path)
  expect(git(['show', `${before.ref}:legacy-session-only.txt`], legacy.path)).toBe('LEGACY_PRIVATE_BEFORE_6d2e')
  expect(git(['show', `${after.ref}:legacy-later.txt`], legacy.path)).toBe('LEGACY_PRIVATE_AFTER_0b9c')
  // the new session: the base, and nothing of the earlier one — not by ref, commit, blob or enumeration
  expect(git(['rev-parse', 'HEAD'], fresh.path)).toBe(project.base_commit!)
  expect(git(['show', 'HEAD:calc.py'], fresh.path)).toContain('return a - b')
  expect(alternateObjectDirs(join(workspaces.gitDirOf(fresh), 'objects'))).toEqual([resolveReal(join(workspaces.viewsDir(project.id), project.base_commit!))])
  for (const [commit, blob, file] of [[before.commit, before.blob, 'legacy-session-only.txt'], [after.commit_sha, afterBlob, 'legacy-later.txt']] as const) {
    expect(tryGit(['cat-file', '-p', blob], fresh.path)).toBeNull()
    expect(tryGit(['show', `${commit}:${file}`], fresh.path)).toBeNull()
    expect(tryGit(['cat-file', '-e', commit], fresh.path)).toBeNull()
    expect(objectsOf(fresh.path)).not.toContain(blob)
    expect(objectsOf(fresh.path)).not.toContain(commit)
  }
  expect(tryGit(['rev-parse', '--verify', '-q', before.ref], fresh.path)).toBeNull()
  // the base repository still holds the earlier pin (nothing deleted) and never got the later one
  expect(git(['rev-parse', before.ref], base)).toBe(before.commit)
  expect(git(['cat-file', '-t', before.blob], base)).toBe('blob')
  expect(tryGit(['cat-file', '-e', afterBlob], base)).toBeNull()
})

test('a workspace root that is a link is refused: nothing runs on ground a command could have swapped', async () => {
  state = domainState()
  const project = await state.workspaces.importProject('calc', buggyRepo())
  const ws = await state.workspaces.createWorkspace(project, repo.createSession(state.conn, project.id, 't', 'scripted:a').id)
  const linked = join(state.settings.workspaces_dir, 'ws_linked')
  symlinkSync(ws.path, linked)
  expect(() => sandboxForWorkspace(state!.settings.data_dir, project, { path: linked }, { network: false })).toThrow(/link/)
})

test.skipIf(process.platform !== 'darwin')('on macOS the shell reads its own Git and the base objects, writes no metadata, and sees no sibling checkpoint, no other project, no data directory', async () => {
  state = domainState()
  const { settings, workspaces } = state
  const { processes } = await realSandbox(state)
  const { project, ws, sibling, cpSibling, blob, cpOwn } = await twoWorkspaces(state)
  const other = await workspaces.importProject('other', buggyRepo())
  const secret = join(settings.data_dir, 'auth.json')
  writeFileSync(secret, '{"secret":"never"}')
  const base = resolveReal(project.base_repo_path)
  const box = sandboxForWorkspace(settings.data_dir, project, ws, { network: false })
  const run = async (command: string) => {
    const x = await processes.start({ command, cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id })
    await processes.wait(x.id, 60)
    return processes.summary(x.id)
  }
  const head = git(['rev-parse', 'HEAD'], ws.path)
  // reads that a person's coding needs, quiet
  const status = await run('git status --short')
  expect([status.exit_code, String(status.stderr)]).toEqual([0, ''])
  writeFileSync(join(ws.path, 'calc.py'), 'def add(a, b):\n    return a + b\n')
  const diff = await run('git diff')
  expect([diff.exit_code, String(diff.stderr)]).toEqual([0, ''])
  expect(String(diff.stdout)).toContain('+    return a + b')
  expect(String((await run('git status --short')).stdout)).toContain(' M calc.py')
  const rev = await run('git rev-parse HEAD')
  expect([rev.exit_code, String(rev.stdout).trim()]).toEqual([0, head])
  const log = await run('git log -1 --format=%H')
  expect([log.exit_code, String(log.stdout).trim()]).toEqual([0, head])
  expect((await run('git ls-files')).exit_code).toBe(0)
  expect(String((await run('git branch --show-current')).stdout).trim()).toBe(ws.branch)
  // its own history and the base's read
  const own = await run(`git show ${cpOwn.ref}:mine.txt`)
  expect([own.exit_code, String(own.stdout).trim()]).toEqual([0, 'MINE'])
  const pins = await run("git for-each-ref --format='%(refname)' refs/oasis-code/checkpoints/")
  expect([pins.exit_code, String(pins.stdout).trim()]).toEqual([0, cpOwn.ref])
  const shown = await run('git show HEAD:calc.py')
  expect([shown.exit_code, String(shown.stdout).includes('return a - b')]).toEqual([0, true])
  // the sibling's checkpoint: not by its ref, not by its commit, not by its blob, not by enumeration
  expect((await run(`git show ${cpSibling.ref}:sibling-only.txt`)).exit_code).not.toBe(0)
  expect((await run(`git cat-file -p ${blob}`)).exit_code).not.toBe(0)
  expect((await run(`git cat-file -e ${cpSibling.commit_sha}`)).exit_code).not.toBe(0)
  const all = await run("git cat-file --batch-all-objects --batch-check='%(objectname)'")
  expect(all.exit_code).toBe(0)
  expect(String(all.stdout)).toContain(cpOwn.commit_sha)
  expect(String(all.stdout)).not.toContain(blob)
  expect(String(all.stdout)).not.toContain(cpSibling.commit_sha)
  for (const command of [`git show ${cpSibling.ref}:sibling-only.txt`, `git cat-file -p ${blob}`, `cat "${workspaces.gitDirOf(sibling)}/objects/${blob.slice(0, 2)}/${blob.slice(2)}"`]) {
    expect(String((await run(command)).stdout)).not.toContain(MARKER)
  }
  // the sibling's repository is not readable, nor the base repository beyond its objects (its refs, its HEAD)
  expect((await run(`cat "${workspaces.gitDirOf(sibling)}/HEAD"`)).exit_code).not.toBe(0)
  expect((await run(`ls "${workspaces.gitDirOf(sibling)}/objects"`)).exit_code).not.toBe(0)
  expect((await run(`cat "${base}/HEAD"`)).exit_code).not.toBe(0)
  expect((await run(`ls "${base}/refs/heads"`)).exit_code).not.toBe(0)
  expect((await run(`ls "${base}/objects" | head -1`)).exit_code).toBe(0)
  // writes of the metadata are refused: no commit, no branch, no ref, no pointer, nothing in the repository
  expect((await run('git commit -qam "from the sandbox"')).exit_code).not.toBe(0)
  expect((await run('git checkout -q -b escaped')).exit_code).not.toBe(0)
  expect((await run('git update-ref refs/heads/escaped HEAD')).exit_code).not.toBe(0)
  expect((await run(`sh -c "echo x > '${workspaces.gitDirOf(ws)}/escaped'"`)).exit_code).not.toBe(0)
  expect((await run('sh -c "echo x > .git"')).exit_code).not.toBe(0)
  expect(git(['rev-parse', 'HEAD'], ws.path)).toBe(head)
  expect(tryGit(['rev-parse', '--verify', '-q', 'refs/heads/escaped'], ws.path)).toBeNull()
  expect(existsSync(join(workspaces.gitDirOf(ws), 'escaped'))).toBe(false)
  expect(readFileSync(join(ws.path, '.git'), 'utf8')).toContain('gitdir:')
  // what stays hidden: the sibling worktree, another project's repository, the data directory
  expect((await run(`ls "${resolveReal(sibling.path)}"`)).exit_code).not.toBe(0)
  expect((await run(`cat "${resolveReal(other.base_repo_path)}/HEAD"`)).exit_code).not.toBe(0)
  expect((await run(`cat "${secret}"`)).exit_code).not.toBe(0)
  expect((await run(`ls "${settings.data_dir}"`)).exit_code).not.toBe(0)
  const ownHead = await run('cat "$(git rev-parse --git-dir)/HEAD"')
  expect([ownHead.exit_code, String(ownHead.stdout).trim()]).toEqual([0, `ref: refs/heads/${ws.branch}`])
})

test.skipIf(process.platform !== 'darwin')('on macOS a command writes inside its HOME and its worktree but cannot remove, rename or replace either; a HOME found replaced on the host is not followed', async () => {
  state = domainState()
  const { settings, workspaces } = state
  const { processes } = await realSandbox(state)
  const project = await workspaces.importProject('calc', buggyRepo())
  const ws = await workspaces.createWorkspace(project, repo.createSession(state.conn, project.id, 'a', 'scripted:a').id)
  const other = await workspaces.createWorkspace(project, repo.createSession(state.conn, project.id, 'b', 'scripted:a').id)
  const homeOther = processes.homeFor(other.id, '')
  mkdirSync(homeOther, { recursive: true })
  writeFileSync(join(homeOther, 'memory.txt'), 'SYNTHETIC_HOME_B_1a2b\n')
  const box = sandboxForWorkspace(settings.data_dir, project, ws, { network: false })
  const run = async (command: string) => {
    const x = await processes.start({ command, cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id })
    await processes.wait(x.id, 60)
    return processes.summary(x.id)
  }
  const home = processes.homeFor(ws.id, '')
  // inside: fine; the root itself: not removed, not renamed, not replaced by a link
  expect((await run('echo ok > "$HOME/note.txt" && cat "$HOME/note.txt"')).exit_code).toBe(0)
  expect((await run('rm -rf "$HOME"')).exit_code).not.toBe(0)
  expect(lstatSync(home).isDirectory()).toBe(true)
  expect((await run('mv "$HOME" "$PWD/taken"')).exit_code).not.toBe(0)
  expect(lstatSync(home).isDirectory()).toBe(true)
  // a link to the other's HOME can only land inside this one (the root stays a directory), and is not followed
  expect((await run(`ln -sfn "${homeOther}" "$HOME/peek" && cat "$HOME/peek/memory.txt"`)).exit_code).not.toBe(0)
  expect(lstatSync(home).isSymbolicLink()).toBe(false)
  expect((await run('mv "$PWD" "$HOME/tree"')).exit_code).not.toBe(0)
  expect(lstatSync(ws.path).isDirectory()).toBe(true)
  expect(existsSync(join(ws.path, 'calc.py'))).toBe(true)
  expect((await run(`cat "${homeOther}/memory.txt"`)).exit_code).not.toBe(0)
  // the host: a HOME found replaced by a link (placed here, as no command can) is not followed — the next command
  // gets a real directory again and reads nothing of the other's
  rmSync(home, { recursive: true, force: true })
  symlinkSync(homeOther, home)
  const probe = await run(`cat "$HOME/memory.txt"; cat "${homeOther}/memory.txt"; echo "HOME=$HOME"`)
  expect(String(probe.stdout)).not.toContain('SYNTHETIC_HOME_B_1a2b')
  expect(String(probe.stdout)).toContain(`HOME=${home}`)
  expect(lstatSync(home).isSymbolicLink()).toBe(false)
  expect(lstatSync(home).isDirectory()).toBe(true)
  expect(readFileSync(join(homeOther, 'memory.txt'), 'utf8')).toContain('SYNTHETIC_HOME_B_1a2b')   // the other's HOME untouched
})

test.skipIf(process.platform !== 'darwin')('on macOS an adopted earlier-layout workspace reads its own pins and no sibling\'s; a new session beside it reads none of theirs; a child reads its checkpoint and not its parent\'s later one', async () => {
  state = domainState()
  const { settings, workspaces, conn } = state
  const { processes } = await realSandbox(state)
  const project = await workspaces.importProject('calc', buggyRepo())
  const ws = legacyWorkspace(state, project, 'a')
  const sibling = legacyWorkspace(state, project, 'b')
  const base = resolveReal(project.base_repo_path)
  const old = legacyPin(state, ws, 'legacy-old.txt', 'LEGACY_OLD_PIN_2c4a')
  const siblingOld = legacyPin(state, sibling, 'sibling-old.txt', 'SIBLING_OLD_PIN_7f1b')
  const fresh = await workspaces.createWorkspace(project, repo.createSession(conn, project.id, 'new', 'scripted:a').id)
  const run = async (command: string, where: Workspace) => {
    await workspaces.adopt(where, project)                                                  // as the command path does
    const box = sandboxForWorkspace(settings.data_dir, project, where, { network: false })
    const x = await processes.start({ command, cwd: where.path, sandbox: box, project_id: project.id, workspace_id: where.id })
    await processes.wait(x.id, 60)
    return processes.summary(x.id)
  }
  const head = git(['rev-parse', 'HEAD'], ws.path)
  const status = await run('git status --short', ws)
  expect([status.exit_code, String(status.stderr)]).toEqual([0, ''])
  const rev = await run('git rev-parse HEAD', ws)
  expect([rev.exit_code, String(rev.stdout).trim()]).toEqual([0, head])
  expect((await run('git log -1 --format=%H', ws)).exit_code).toBe(0)
  const shown = await run(`git show ${old.ref}:legacy-old.txt`, ws)
  expect([shown.exit_code, String(shown.stdout).trim()]).toEqual([0, 'LEGACY_OLD_PIN_2c4a'])
  expect((await run('git commit -qam "from the sandbox"', ws)).exit_code).not.toBe(0)
  for (const command of [`git cat-file -p ${siblingOld.blob}`, `git show ${siblingOld.commit}:sibling-old.txt`, `git show ${siblingOld.ref}:sibling-old.txt`, `cat "${base}/objects/${siblingOld.blob.slice(0, 2)}/${siblingOld.blob.slice(2)}"`]) {
    const r = await run(command, ws)
    expect([command, r.exit_code === 0]).toEqual([command, false])
    expect(String(r.stdout)).not.toContain('SIBLING_OLD_PIN_7f1b')
  }
  expect(String((await run("git cat-file --batch-all-objects --batch-check='%(objectname)'", ws)).stdout)).not.toContain(siblingOld.blob)
  const own = await run('cat "$(git rev-parse --git-dir)/HEAD"', ws)
  expect([own.exit_code, String(own.stdout).trim()]).toEqual([0, `ref: refs/heads/${ws.branch}`])
  // the new session beside them: the base, and nothing either earlier session pinned
  const calc = await run('git show HEAD:calc.py', fresh)
  expect([calc.exit_code, String(calc.stdout).includes('return a - b')]).toEqual([0, true])
  for (const [commit, blob, file] of [[old.commit, old.blob, 'legacy-old.txt'], [siblingOld.commit, siblingOld.blob, 'sibling-old.txt']] as const) {
    for (const command of [`git cat-file -p ${blob}`, `git show ${commit}:${file}`]) {
      const r = await run(command, fresh)
      expect([command, r.exit_code === 0]).toEqual([command, false])
      expect(String(r.stdout)).not.toMatch(/_PIN_/)
    }
    expect(String((await run("git cat-file --batch-all-objects --batch-check='%(objectname)'", fresh)).stdout)).not.toContain(blob)
  }
  // a child of the new session at its checkpoint: that checkpoint, not the parent's later one
  writeFileSync(join(fresh.path, 'authorized.txt'), 'AUTHORIZED_CP1_5b0c\n')
  workspaces.noteWrite(fresh)
  const cp1 = await workspaces.checkpoint(fresh, null, 'cp1')
  const child = await workspaces.createWorkspace(project, repo.createSession(conn, project.id, 'child', 'scripted:a').id, { kind: 'child', base_commit: cp1.commit_sha })
  writeFileSync(join(fresh.path, 'future-parent-only.txt'), 'PARENT_FUTURE_CP2_3a7e\n')
  workspaces.noteWrite(fresh)
  const cp2 = await workspaces.checkpoint(fresh, null, 'cp2')
  const futureBlob = git(['rev-parse', `${cp2.ref}:future-parent-only.txt`], fresh.path)
  const authorized = await run('git show HEAD:authorized.txt', child)
  expect([authorized.exit_code, String(authorized.stdout).trim()]).toEqual([0, 'AUTHORIZED_CP1_5b0c'])
  for (const command of [`git cat-file -p ${futureBlob}`, `git show ${cp2.commit_sha}:future-parent-only.txt`, `git show ${cp2.ref}:future-parent-only.txt`, `cat "${join(fresh.path, 'future-parent-only.txt')}"`]) {
    const r = await run(command, child)
    expect([command, r.exit_code === 0]).toEqual([command, false])
    expect(String(r.stdout)).not.toContain('PARENT_FUTURE_CP2_3a7e')
  }
  const all = await run("git cat-file --batch-all-objects --batch-check='%(objectname)'", child)
  expect(String(all.stdout)).toContain(cp1.commit_sha)
  expect(String(all.stdout)).not.toContain(futureBlob)
  expect(String(all.stdout)).not.toContain(cp2.commit_sha)
})

test('the directories between a denied root and an allowed path are the ones whose metadata a path walk needs; nothing else', () => {
  expect(ancestorsBetween(['/d/repos/p/base.git'], ['/d'])).toEqual(['/d', '/d/repos', '/d/repos/p'])
  expect(ancestorsBetween(['/d/repos/p/base.git/worktrees/ws'], ['/d/repos/p/base.git/worktrees'])).toEqual(['/d/repos/p/base.git/worktrees'])
  expect(ancestorsBetween(['/d/ws'], ['/d'])).toEqual(['/d'])
  expect(ancestorsBetween(['/elsewhere/x'], ['/d'])).toEqual([])
  expect(ancestorsBetween(['/d'], ['/d'])).toEqual([])
})
