/** Import, snapshot, checkpoint, diff, path policy — on real Git repositories. */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as repo from '../src/db/repo.ts'
import { GitError } from '../src/workspace/git.ts'
import { cutPatch } from '../src/workspace/service.ts'
import { PathPolicy, PathRefused, posixOf } from '../src/workspace/paths.ts'
import { buggyRepo, domainState, git, type DomainState } from './harness.ts'
import { tempDir } from './helpers.ts'

let state: DomainState
beforeEach(() => { state = domainState() })
afterEach(async () => { await state.close() })

function walk(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      out.push(relative(root, path))
      if (statSync(path).isDirectory()) visit(path)
    }
  }
  visit(root)
  return out.sort()
}

test('an import reports the dirty state and carries only HEAD', async () => {
  const src = buggyRepo()
  writeFileSync(join(src, 'calc.py'), 'def add(a, b):\n    return a + b\n')            // unstaged
  writeFileSync(join(src, 'staged.txt'), 's\n')
  git(['add', 'staged.txt'], src)                                                        // staged
  writeFileSync(join(src, 'notes.txt'), 'n\n')                                           // untracked
  const project = await state.workspaces.importProject('calc', src)
  const report = project.import_report as Record<string, unknown>
  expect(String(report.basis)).toStartWith('the committed HEAD')
  expect(report.unstaged).toEqual(['calc.py'])
  expect(report.staged).toEqual(['staged.txt'])
  expect(report.untracked).toEqual(['notes.txt'])
  expect(new Set(report.not_carried as string[])).toEqual(new Set(['calc.py', 'staged.txt', 'notes.txt']))
  expect(project.base_commit).toBe(git(['rev-parse', 'HEAD'], src))
  const session = repo.createSession(state.conn, project.id, 't', 'scripted:a')
  const ws = await state.workspaces.createWorkspace(project, session.id)
  expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toStartWith('def add(a, b):\n    return a - b')   // HEAD, not the dirty file
  expect(existsSync(join(ws.path, 'notes.txt'))).toBe(false)
  // the user's tree was not touched
  expect(readFileSync(join(src, 'calc.py'), 'utf8')).toBe('def add(a, b):\n    return a + b\n')
  expect(existsSync(join(src, 'notes.txt'))).toBe(true)
  // the workspace's object store is its own (no hard links into the original)
  expect(statSync(join(project.base_repo_path, 'HEAD')).nlink).toBe(1)
})

test('an import snapshots a plain folder', async () => {
  const plain = join(tempDir(), 'plain')
  mkdirSync(join(plain, 'src'), { recursive: true })
  mkdirSync(join(plain, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(join(plain, 'src', 'app.py'), "print('hi')\n")
  writeFileSync(join(plain, 'README.md'), '# plain\n')
  writeFileSync(join(plain, '.gitignore'), '*.log\n')
  writeFileSync(join(plain, 'debug.log'), 'noise\n')
  writeFileSync(join(plain, '.DS_Store'), Buffer.from([0]))
  writeFileSync(join(plain, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  const before = walk(plain)
  const project = await state.workspaces.importProject('plain', plain)
  const report = project.import_report as Record<string, unknown>
  expect(report.kind).toBe('folder')
  expect(String(report.basis)).toStartWith('a snapshot of the folder')
  expect(report.files_carried).toBe(3)
  expect(report.excluded_patterns).toContain('node_modules/')
  expect((report.notes as string[]).some((n) => n.includes('not a Git repository'))).toBe(true)
  expect(project.base_branch).toBe('main')
  expect(project.base_commit).toBeTruthy()
  expect(walk(plain)).toEqual(before)          // the folder untouched, no .git
  const session = repo.createSession(state.conn, project.id, 't', 'scripted:a')
  const ws = await state.workspaces.createWorkspace(project, session.id)
  const carried = walk(ws.path).filter((p) => !p.split('/').includes('.git'))
  expect(carried).toEqual(['.gitignore', 'README.md', 'src', 'src/app.py'])
})

test('an import snapshots a repository without commits and a directory inside one', async () => {
  const src = buggyRepo()
  const sub = join(src, 'sub')
  mkdirSync(sub)
  writeFileSync(join(sub, 'inner.txt'), 'inner\n')
  const inside = await state.workspaces.importProject('sub', sub)
  expect(inside.import_report.kind).toBe('folder')
  expect(inside.import_report.files_carried).toBe(1)
  expect((inside.import_report.notes as string[]).some((n) => n.includes('a directory inside the repository'))).toBe(true)
  const fresh = join(tempDir(), 'fresh')
  mkdirSync(fresh)
  git(['init', '-q', '-b', 'main'], fresh)
  writeFileSync(join(fresh, 'a.txt'), 'a\n')
  const project = await state.workspaces.importProject('fresh', fresh)
  expect(project.import_report.kind).toBe('folder')
  expect(project.import_report.files_carried).toBe(1)
  expect((project.import_report.notes as string[]).some((n) => n.includes('no commit yet'))).toBe(true)
  const error = await state.workspaces.importProject('x', join(tempDir(), 'missing')).catch((e) => e)
  expect(error).toBeInstanceOf(GitError)
  expect(error.message).toContain('not a directory')
})

test('an empty project starts from an explicit initial commit', async () => {
  const project = await state.workspaces.createEmptyProject('fresh')
  expect(project.base_commit).toBeTruthy()
  expect(String(project.import_report.basis)).toStartWith('a new empty repository')
  const session = repo.createSession(state.conn, project.id, 't', 'scripted:a')
  const ws = await state.workspaces.createWorkspace(project, session.id)
  writeFileSync(join(ws.path, 'hello.txt'), 'hi\n')
  state.workspaces.noteWrite(ws)
  const cp = await state.workspaces.checkpoint(ws, null, 'first file')
  const snap = repo.getSnapshot(state.conn, cp.snapshot_id)!
  expect(snap.changed_paths).toEqual(['A hello.txt'])
})

async function workspace() {
  const src = buggyRepo()
  const project = await state.workspaces.importProject('calc', src)
  const session = repo.createSession(state.conn, project.id, 't', 'scripted:a')
  const ws = await state.workspaces.createWorkspace(project, session.id)
  return { src, project, ws }
}

test('a snapshot covers untracked files while HEAD stays', async () => {
  const { ws } = await workspace()
  const root = ws.path
  writeFileSync(join(root, 'calc.py'), 'def add(a, b):\n    return a + b\n')
  writeFileSync(join(root, 'new_module.py'), 'X = 1\n')
  mkdirSync(join(root, '__pycache__'))
  writeFileSync(join(root, '__pycache__', 'junk.pyc'), Buffer.from([0, 1]))
  state.workspaces.noteWrite(ws)
  const snap = await state.workspaces.snapshot(ws)
  expect(snap.base_commit).toBe(ws.base_commit)
  expect(git(['rev-parse', 'HEAD'], root)).toBe(ws.base_commit)            // HEAD did not move
  expect(snap.untracked).toContain('new_module.py')
  expect(new Set(snap.changed_paths)).toEqual(new Set(['M calc.py', 'A new_module.py']))      // the ignored .pyc is not in the tree
  const diff = await state.workspaces.diff(ws)
  expect(diff.patch).toContain('+X = 1')
  expect(diff.patch).toContain('+    return a + b')
  expect(new Set(diff.files.map((f) => f.path))).toEqual(new Set(['calc.py', 'new_module.py']))
})

test('a checkpoint pins an immutable ref off the user branches', async () => {
  const { project, ws } = await workspace()
  const root = ws.path
  writeFileSync(join(root, 'calc.py'), 'def add(a, b):\n    return a + b\n')
  state.workspaces.noteWrite(ws)
  const cp1 = await state.workspaces.checkpoint(ws, null, 'fix add (tests not run)')
  const base = project.base_repo_path
  // pinned in the workspace's own repository: the base repository holds neither the ref nor the commit
  expect(git(['rev-parse', cp1.ref], root)).toBe(cp1.commit_sha)
  expect(git(['rev-parse', `${cp1.commit_sha}^`], root)).toBe(ws.base_commit)
  expect(git(['rev-parse', 'refs/heads/main'], base)).toBe(ws.base_commit)            // main untouched
  expect(git(['for-each-ref', 'refs/oasis-code/'], base)).toBe('')
  expect(() => git(['cat-file', '-e', cp1.commit_sha], base)).toThrow()
  writeFileSync(join(root, 'calc.py'), 'def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n')
  state.workspaces.noteWrite(ws)
  const cp2 = await state.workspaces.checkpoint(ws, null, 'add sub')
  expect(cp2.parent_checkpoint_id).toBe(cp1.id)
  expect(git(['rev-parse', `${cp2.commit_sha}^`], root)).toBe(cp1.commit_sha)
  // a version conflict refuses to pin a moved tree
  const snap = repo.latestSnapshot(state.conn, ws.id)!
  writeFileSync(join(root, 'calc.py'), 'changed again\n')
  state.workspaces.noteWrite(ws)
  const error = await state.workspaces.checkpoint(ws, null, 'stale', { expected_tree: snap.tree_sha }).catch((e) => e)
  expect(error).toBeInstanceOf(GitError)
  expect(error.message).toContain('version conflict')
})

test('an external edit is labelled unknown, not attributed', async () => {
  const { ws } = await workspace()
  await state.workspaces.snapshot(ws)
  writeFileSync(join(ws.path, 'README.md'), 'edited in an editor\n')          // no tool wrote
  const status = await state.workspaces.status(ws)
  expect(Array.isArray(status.external_changes)).toBe(true)                    // status alone does not judge
  const snap = await state.workspaces.snapshot(ws)
  expect(state.workspaces.liveOf(ws).external_changes).toEqual(['M README.md'])
  expect(snap.changed_paths).toContain('M README.md')
  const diff = await state.workspaces.diff(ws)
  expect(diff.external_changes).toEqual(['M README.md'])
})

test('path policy boundaries', () => {
  const base = tempDir()
  const root = join(base, 'ws')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'secrets'))
  mkdirSync(join(root, '.git'))
  const outside = join(base, 'outside.txt')
  writeFileSync(outside, 'x')
  symlinkSync(outside, join(root, 'link.txt'))
  symlinkSync(base, join(root, 'escape'))
  const policy = PathPolicy.forWorkspace(root, ['secrets/**'])
  expect(() => policy.resolveRead('/etc/passwd')).toThrow('outside the allowed folders')      // no absolute path but the temporary folder's
  expect(() => policy.resolveRead('../outside.txt')).toThrow("'..'")
  expect(() => policy.resolveRead('link.txt')).toThrow('outside')
  expect(() => policy.resolveRead('escape/outside.txt')).toThrow('outside')
  expect(() => policy.resolveWrite('.git/config')).toThrow('Git metadata')
  expect(() => policy.resolveWrite('secrets/key.pem')).toThrow('protected')
  for (const bad of ['/etc/passwd', 'link.txt']) expect(() => policy.resolveRead(bad)).toThrow(PathRefused)
  const [pure, real] = policy.resolveWrite('src/new.py')
  expect(real).toBe(join(policy.root, 'src', 'new.py'))
  expect(posixOf(pure)).toBe('src/new.py')
})

test('the copy is shallow and the snapshot index persists', async () => {
  const src = buggyRepo()
  writeFileSync(join(src, 'calc.py'), 'def add(a, b):\n    return a + b\n')
  git(['commit', '-q', '-am', 'second commit'], src)
  const project = await state.workspaces.importProject('calc', src)
  const base = project.base_repo_path
  expect(git(['rev-parse', '--is-shallow-repository'], base)).toBe('true')
  expect(project.base_commit).toBe(git(['rev-parse', 'HEAD'], src))
  expect(String(project.import_report.basis)).toContain('shallow')
  const session = repo.createSession(state.conn, project.id, 't', 'scripted:a')
  const ws = await state.workspaces.createWorkspace(project, session.id)
  const first = await state.workspaces.snapshot(ws)
  const index = await state.workspaces.git.snapshotIndex(ws.path)
  expect(statSync(index).isFile()).toBe(true)
  expect(index.startsWith(state.workspaces.workspaceGitDir(project.id, ws.id) + '/')).toBe(true)   // the workspace's own repository, beside the base
  expect(git(['rev-parse', '--is-shallow-repository'], ws.path)).toBe('true')                      // it knows the base copy's boundary
  const again = await state.workspaces.snapshot(ws)
  expect(again.tree_sha).toBe(first.tree_sha)
  expect(again.file_count).toBe(first.file_count)
  writeFileSync(join(ws.path, 'calc.py'), 'def add(a, b):\n    return a + b + 0\n')
  writeFileSync(join(ws.path, 'new.txt'), 'n\n')
  state.workspaces.noteWrite(ws)
  const changed = await state.workspaces.snapshot(ws)
  expect(changed.tree_sha).not.toBe(first.tree_sha)
  expect([...changed.changed_paths].sort()).toEqual(['A new.txt', 'M calc.py'])
  // two snapshots at the same time share the index in turn and agree
  const results = await Promise.all([0, 1].map(() => state.workspaces.git.snapshotTree(ws.path, ws.base_commit).then((r) => r.tree_sha)))
  expect(results).toEqual([changed.tree_sha, changed.tree_sha])
  const cp = await state.workspaces.checkpoint(ws, null, 'pinned on a shallow base')
  expect(git(['cat-file', '-t', cp.commit_sha], ws.path)).toBe('commit')        // pinned in the workspace's repository
  expect(git(['rev-parse', `${cp.commit_sha}^{tree}`], ws.path)).toBe(changed.tree_sha)
  expect(() => git(['cat-file', '-t', cp.commit_sha], base)).toThrow()          // never in the base
})

test("a git repository made inside a workspace (an agent's clone) is left out of its snapshots: one with no commit yet does not fail them, one with commits leaves no pointer", async () => {
  const project = await state.workspaces.importProject('calc', buggyRepo())
  const session = repo.createSession(state.conn, project.id, 't', 'scripted:a')
  const ws = await state.workspaces.createWorkspace(project, session.id)
  const first = await state.workspaces.git.snapshotTree(ws.path, ws.base_commit)
  // a clone under way: its repository is there, no commit in it yet
  git(['init', '-q', join(ws.path, 'work', 'clone')], ws.path)
  writeFileSync(join(ws.path, 'work', 'clone', 'half.txt'), 'h\n')
  writeFileSync(join(ws.path, 'notes.txt'), 'n\n')
  const during = await state.workspaces.git.snapshotTree(ws.path, ws.base_commit)
  expect(during.changed).toEqual(['A notes.txt'])
  expect(during.excluded).toContain('work/clone (a git repository of its own)')
  // the clone done: still left out, no pointer to it in the tree
  git(['add', 'half.txt'], join(ws.path, 'work', 'clone'))
  git(['commit', '-q', '-m', 'c'], join(ws.path, 'work', 'clone'))
  const after = await state.workspaces.git.snapshotTree(ws.path, ws.base_commit)
  expect(after.changed).toEqual(['A notes.txt'])
  expect(git(['ls-tree', '-r', after.tree_sha], ws.path)).not.toContain('160000')
  expect(after.tree_sha).toBe(during.tree_sha)
  expect(after.file_count).toBe(first.file_count + 1)
  // a pointer an earlier build's snapshot left in the index is taken out (the base has none there)
  const index = await state.workspaces.git.snapshotIndex(ws.path)
  const head = git(['rev-parse', 'HEAD'], join(ws.path, 'work', 'clone'))
  expect(spawnSync('git', ['update-index', '--add', '--cacheinfo', `160000,${head},work/clone`], { cwd: ws.path, env: { ...process.env, GIT_INDEX_FILE: index } }).status).toBe(0)
  const cleaned = await state.workspaces.git.snapshotTree(ws.path, ws.base_commit)
  expect(cleaned.tree_sha).toBe(during.tree_sha)
})

test("a whole diff too large to send at once is cut at a file's boundary: the files that fit, how many there are, how long the whole was", async () => {
  const file = (name: string, chars: number) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1 @@\n+${'x'.repeat(chars)}\n`
  const patch = file('a.txt', 300) + file('b.txt', 300) + file('c.txt', 300)
  expect(cutPatch(patch, 10_000)).toEqual({ patch, cut: null })
  const cut = cutPatch(patch, 800)
  expect(cut.patch).toBe(file('a.txt', 300) + file('b.txt', 300))
  expect(cut.cut).toEqual({ shown_files: 2, total_files: 3, chars: patch.length })
  // one file alone past the budget is still shown: a cut never leaves nothing
  expect(cutPatch(patch, 100).cut).toEqual({ shown_files: 1, total_files: 3, chars: patch.length })
  expect(cutPatch(patch, 100).patch).toBe(file('a.txt', 300))
  // a workspace whose new files outweigh the budget: the service's whole diff, cut, keeps every file in its list
  const project = await state.workspaces.importProject('calc', buggyRepo())
  const session = repo.createSession(state.conn, project.id, 't', 'scripted:a')
  const ws = await state.workspaces.createWorkspace(project, session.id)
  for (let i = 0; i < 4; i += 1) writeFileSync(join(ws.path, `big${i}.txt`), `${'line of text\n'.repeat(20_000)}`)
  const whole = await state.workspaces.diff(ws)
  const shown = cutPatch(whole.patch)
  expect(whole.files.filter((f) => f.path.startsWith('big'))).toHaveLength(4)
  expect(shown.cut!.total_files).toBe(4)
  expect(shown.cut!.shown_files).toBeLessThan(4)
  expect(shown.patch.length).toBeLessThanOrEqual(whole.patch.length)
})
