/** Integration, fully offline (adapted from oasis tests/test_subagent_runs.py, see NOTICE): chosen checkpoints of
 *  separate worktrees compose onto their common base in an integration worktree; base drift keeps the composition but
 *  does not write the workspace; a conflict, a protected path or different bases refuse it. */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as repo from '../src/db/repo.ts'
import { integrate } from '../src/workspace/integrate.ts'
import { appState, buggyRepo, closeState, git, openSession, type AppState } from './harness.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

async function childWorkspace(st: AppState, project: { id: string } & Record<string, unknown>, sessionId: string, ws: Parameters<AppState['workspaces']['checkpoint']>[0], note: string) {
  const base = await st.workspaces.checkpoint(ws, null, note)
  const cws = await st.workspaces.createWorkspace(project as never, sessionId, { kind: 'child', base_commit: base.commit_sha })
  return { cws, base }
}

async function editAndPin(st: AppState, ws: Parameters<AppState['workspaces']['checkpoint']>[0], path: string, text: string, note: string) {
  const target = join(ws.path, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
  st.workspaces.noteWrite(ws)
  return st.workspaces.checkpoint(ws, null, note)
}

test('integration composes checkpoints onto their base', async () => {
  state = await appState()
  const { project, session, ws } = await openSession(state, buggyRepo())
  const { cws: aWs, base } = await childWorkspace(state, project, session.id, ws, 'base')
  const bWs = await state.workspaces.createWorkspace(project, session.id, { kind: 'child', base_commit: base.commit_sha })
  const fixed = readFileSync(join(aWs.path, 'calc.py'), 'utf8').replace('return a - b   # the bug: this should add', 'return a + b')
  const cpA = await editAndPin(state, aWs, 'calc.py', fixed, 'fix add')
  const cpB = await editAndPin(state, bWs, 'notes.md', '# notes\n', 'notes')
  const result = await integrate(state, ws, [cpA.id, cpB.id], { run_id: null, note: 'both', protected: ['secrets/**'], verify: false })
  expect(result.status).toBe('integrated')
  expect(result.applied).toEqual([cpA.id, cpB.id])
  expect(result.conflicts).toEqual([])
  expect(result.base_commit).toBe(base.commit_sha)
  expect(result.composed_checkpoint_id).toBeTruthy()
  expect(result.applied_to_workspace).toBe(true)
  expect(result.files.map((f) => f.path).sort()).toEqual(['calc.py', 'notes.md'])
  expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toContain('return a + b')
  expect(readFileSync(join(ws.path, 'notes.md'), 'utf8')).toBe('# notes\n')
  const composed = repo.getCheckpoint(state.conn, result.composed_checkpoint_id!)!
  const intWs = repo.getWorkspace(state.conn, composed.workspace_id)!
  expect(intWs.kind).toBe('integration')
  expect(existsSync(intWs.path)).toBe(false)              // the tree is gone; the integration's repository, with the ref, stays
  expect(git(['rev-parse', composed.ref], state.workspaces.repoOf(intWs))).toBe(composed.commit_sha)
  expect(git(['for-each-ref', 'refs/oasis-code/'], project.base_repo_path)).toBe('')   // nothing composed entered the base
  // the session workspace drifted from the base now: a second composition keeps its checkpoint but does not write
  const cpB2 = await editAndPin(state, bWs, 'notes.md', '# notes v2\n', 'notes v2')
  const again = await integrate(state, ws, [cpB2.id], { run_id: null, note: 'later', protected: [], verify: false })
  expect(again.status).toBe('integrated')
  expect(again.applied_to_workspace).toBe(false)
  expect(again.reason).toContain('base drift')
  expect(readFileSync(join(ws.path, 'notes.md'), 'utf8')).toBe('# notes\n')
  // a conflict names the file and composes nothing
  const cWs = await state.workspaces.createWorkspace(project, session.id, { kind: 'child', base_commit: base.commit_sha })
  const cpC = await editAndPin(state, cWs, 'calc.py', fixed.replace('return a + b', 'return b + a'), 'other fix')
  const otherSession = repo.createSession(state.conn, project.id, 'other', 'scripted:a')
  const otherWs = await state.workspaces.createWorkspace(project, otherSession.id)
  const conflict = await integrate(state, otherWs, [cpA.id, cpC.id], { run_id: null, note: 'clash', protected: [], verify: false })
  expect(conflict.status).toBe('conflict')
  expect(conflict.applied).toEqual([cpA.id])
  expect(conflict.conflicts).toEqual(['calc.py'])
  expect(conflict.composed_checkpoint_id).toBeNull()
  expect(readFileSync(join(otherWs.path, 'calc.py'), 'utf8')).toContain('return a - b')
  // a protected path refuses the composition
  const dWs = await state.workspaces.createWorkspace(project, session.id, { kind: 'child', base_commit: base.commit_sha })
  const cpD = await editAndPin(state, dWs, 'secrets/key.txt', 'x\n', 'leak')
  const refused = await integrate(state, otherWs, [cpD.id], { run_id: null, note: 'no', protected: ['secrets/**'], verify: false })
  expect(refused.status).toBe('refused')
  expect(refused.protected_hits).toEqual(['secrets/key.txt'])
  expect(refused.composed_checkpoint_id).toBeNull()
  // checkpoints from different bases (different trees) are refused; two pinned commits of one tree are one base
  const eWs = await state.workspaces.createWorkspace(project, session.id, { kind: 'child', base_commit: composed.commit_sha })
  const cpE = await editAndPin(state, eWs, 'README.md', '# later\n', 'later')
  const mixed = await integrate(state, otherWs, [cpA.id, cpE.id], { run_id: null, note: 'mix', protected: [], verify: false })
  expect(mixed.status).toBe('refused')
  expect(mixed.reason).toContain('different bases')
  const sameTree = await state.workspaces.checkpoint(otherWs, null, 'pinned again')          // another commit, the same tree
  const fWs = await state.workspaces.createWorkspace(project, otherSession.id, { kind: 'child', base_commit: sameTree.commit_sha })
  const cpF = await editAndPin(state, fWs, 'docs.md', 'd\n', 'docs')
  expect((await integrate(state, otherWs, [cpB.id, cpF.id], { run_id: null, note: 'two pins', protected: [], verify: false })).status).toBe('integrated')
})
