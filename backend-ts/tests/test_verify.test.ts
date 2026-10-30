/** Checks never turn green by default: parsed counts decide, nothing collected is unknown, a timeout is unknown, a
 *  weakened test is flagged for review, and a result belongs to its snapshot (stale after a change). */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CheckConfigSchema } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { judge, parseNodeTest, parsePytest, reviewFlags, runChecks } from '../src/verify/checks.ts'
import { buggyRepo, domainState, type DomainState } from './harness.ts'

test('the pytest parser and the judgement', () => {
  let [counts, summary] = parsePytest('collected 3 items\n...\n=========== 2 passed, 1 failed in 0.12s ===========\n')
  expect(counts).toEqual({ passed: 2, failed: 1 })
  expect(judge('pytest', 1, false, counts, summary, false)).toEqual(['fail', summary!])
  ;[counts, summary] = parsePytest('============ 4 passed in 0.10s ============')
  expect(judge('pytest', 0, false, counts, summary, false)[0]).toBe('pass')
  ;[counts, summary] = parsePytest('============ no tests ran in 0.01s ============')
  expect(judge('pytest', 5, false, counts, summary, false)[0]).toBe('unknown')
  expect(judge('pytest', 0, false, {}, null, false)).toEqual(['unknown', 'no pytest summary line in the log'])
  expect(judge('pytest', 0, false, {}, null, true)[1]).toEndWith('(log truncated at the cap)')
  expect(judge('pytest', null, true, {}, null, false)).toEqual(['unknown', 'timed out'])
  // exit 0 with nothing collected is not a pass
  expect(judge('pytest', 0, false, { collected: 0 }, 'no tests ran', false)[0]).toBe('unknown')
  // a green exit is not enough when the summary reports failures
  expect(judge('pytest', 0, false, { passed: 1, errors: 1 }, '1 passed, 1 error', false)[0]).toBe('fail')
})

test('the node parser', () => {
  const [counts, summary] = parseNodeTest('# tests 5\n# pass 5\n# fail 0\n')
  expect(counts.tests).toBe(5)
  expect(judge('node_test', 0, false, counts, summary, false)[0]).toBe('pass')
  expect(judge('node_test', 0, false, {}, null, false)[0]).toBe('unknown')
  expect(judge('node_test', 0, false, { tests: 0 }, 'tests 0', false)[0]).toBe('unknown')
})

test('the node parser: tests all skipped or all todo passed nothing and are unknown; a failure among skips still fails', () => {
  const node = (text: string, exit: number) => { const [c, s] = parseNodeTest(text); return judge('node_test', exit, false, c, s, false) }
  const skipped = node('TAP version 13\nok 1 - a # SKIP\nok 2 - b # SKIP\n1..2\n# tests 2\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 2\n# todo 0\n', 0)
  expect(skipped[0]).toBe('unknown')
  expect(skipped[1]).toContain('no test passed')
  expect(node('# tests 2\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 2\n', 0)[0]).toBe('unknown')
  expect(node('# tests 2\n# pass 0\n# fail 1\n# skipped 1\n', 1)[0]).toBe('fail')
  expect(node('# tests 3\n# pass 1\n# fail 0\n# skipped 2\n', 0)[0]).toBe('pass')
})

test('review flags name test weakening, never hide it', () => {
  const patch = '--- a/tests/test_x.py\n+++ b/tests/test_x.py\n@@ -1,4 +1,4 @@\n-    assert result == 5\n+    pass\n+@pytest.mark.skip(reason="flaky")\n'
  const files = [{ path: 'tests/test_x.py', added: 2, removed: 1 }, { path: 'tests/test_gone.py', added: 0, removed: 40 }, { path: 'pytest.ini', added: 1, removed: 0 }]
  const kinds = new Set(reviewFlags(patch, files).map((f) => f.kind))
  for (const kind of ['assertion removed', 'skip/xfail/only added', 'test_deleted_or_emptied', 'test_or_ci_configuration_changed']) expect(kinds.has(kind)).toBe(true)
  expect(reviewFlags('--- a/src/x.py\n+++ b/src/x.py\n-    assert x\n', [{ path: 'src/x.py', added: 0, removed: 1 }])).toEqual([])
})

let state: DomainState
beforeEach(() => { state = domainState() })
afterEach(async () => { await state.close() })

test('checks run on the exact checkpoint and go stale', async () => {
  const project = await state.workspaces.importProject('calc', buggyRepo())
  const session = repo.createSession(state.conn, project.id, 't', 'scripted:a')
  const ws = await state.workspaces.createWorkspace(project, session.id)
  const root = ws.path
  const spec = { checks: [
    CheckConfigSchema.parse({ id: 'unit', command: 'python3 -m unittest -v 2>&1', parser: 'exit_code' }),
    CheckConfigSchema.parse({ id: 'nothing', command: 'python3 -m pytest -q 2>&1 || true', parser: 'pytest' }),
    CheckConfigSchema.parse({ id: 'slow', command: 'sleep 5', parser: 'exit_code', timeout_s: 1 }),
  ] }
  const cpBug = await state.workspaces.checkpoint(ws, null, 'as imported')
  const results = await runChecks(state.conn, state.workspaces, state.processes, project, cpBug, spec)
  const byId = Object.fromEntries(results.map((r) => [r.check_id, r]))
  expect(byId.unit!.status).toBe('fail')
  expect(byId.unit!.exit_code).toBe(1)
  expect(byId.unit!.log_asset_id).toBeTruthy()
  expect(byId.nothing!.status).toBe('unknown')                       // `|| true` exits 0 but nothing was collected / no summary
  expect(byId.slow!.status).toBe('unknown')
  expect(byId.slow!.reason).toBe('timed out')
  // fix, checkpoint, verify again on the new snapshot; the old result is stale for the new tree
  writeFileSync(join(root, 'calc.py'), 'def add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a * b\n')
  state.workspaces.noteWrite(ws)
  const cpFix = await state.workspaces.checkpoint(ws, null, 'fixed')
  const results2 = await runChecks(state.conn, state.workspaces, state.processes, project, cpFix, { checks: spec.checks.slice(0, 1) })
  expect(results2[0]!.status).toBe('pass')
  expect(results2[0]!.snapshot_id).toBe(cpFix.snapshot_id)
  const latest = repo.latestSnapshot(state.conn, ws.id)!
  const old = repo.getSnapshot(state.conn, byId.unit!.snapshot_id)!
  expect(old.tree_sha).not.toBe(latest.tree_sha)                             // the first result no longer describes the workspace
  // the verification worktree was removed; the task workspace is untouched by the checks
  expect(readdirSync(state.settings.workspaces_dir).some((p) => p.startsWith('verify_'))).toBe(false)
  expect(readFileSync(join(root, 'calc.py'), 'utf8')).toStartWith('def add(a, b):\n    return a + b')
  expect(repo.listChecks(state.conn, ws.id).map((r) => r.check_id)).toContain('unit')
})
