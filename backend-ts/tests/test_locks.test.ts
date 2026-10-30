/** Hard locks — path / symbol × read_only / no_delete / no_signature_change — checked on the bytes, never promised
 *  in a prompt: a checkpoint or an integration of a violating tree is refused. */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as repo from '../src/db/repo.ts'
import { checkChange, lockCovers, lockSpec, signatures } from '../src/policy/locks.ts'
import { integrate } from '../src/workspace/integrate.ts'
import { LockViolation } from '../src/workspace/service.ts'
import { buggyRepo, domainState, type DomainState } from './harness.ts'

const PY_BEFORE = `class Calc:
    def add(self, a, b):
        return a - b

    def mul(self, a: int, b: int) -> int:
        return a * b


def helper(x=1):
    return x
`

test('python signatures and symbol sources', () => {
  const [sigs, sources] = signatures('calc.py', PY_BEFORE)
  expect(sigs.Calc).toBe('class Calc()')
  expect(sigs['Calc.add']).toBe('def add(self, a, b)')
  expect(sigs['Calc.mul']).toBe('def mul(self, a: int, b: int) -> int')
  expect(sigs.helper).toBe('def helper(x=1)')
  expect(sources['Calc.add']).toContain('return a - b')
  const [tsSigs] = signatures('api.ts', 'export async function load(id: string): Promise<Row> {\n}\nexport class Store {\n}\n')
  expect(tsSigs.load).toStartWith('export async function load(id: string)')
  expect('Store' in tsSigs).toBe(true)
})

test('the three modes on files and symbols', () => {
  const bodyFix = PY_BEFORE.replace('return a - b', 'return a + b')
  const argChange = PY_BEFORE.replace('def add(self, a, b)', 'def add(self, a, b, c=0)')
  const removed = PY_BEFORE.replace('def helper(x=1):\n    return x\n', '')
  const ro = [lockSpec({ path: 'calc.py', mode: 'read_only' })]
  expect(checkChange(ro, 'calc.py', PY_BEFORE, bodyFix).length).toBeGreaterThan(0)
  expect(checkChange(ro, 'other.py', PY_BEFORE, bodyFix)).toEqual([])
  expect(checkChange(ro, 'calc.py', PY_BEFORE, PY_BEFORE)).toEqual([])
  const nd = [lockSpec({ path: 'calc.py', mode: 'no_delete' })]
  expect(checkChange(nd, 'calc.py', PY_BEFORE, bodyFix)).toEqual([])
  expect(checkChange(nd, 'calc.py', PY_BEFORE, null)[0]).toContain('must not be deleted')
  const sig = [lockSpec({ path: '*.py', mode: 'no_signature_change' })]
  expect(checkChange(sig, 'calc.py', PY_BEFORE, bodyFix)).toEqual([]) // a body may change under a signature lock
  expect(checkChange(sig, 'calc.py', PY_BEFORE, argChange)[0]).toContain('Calc.add')
  expect(checkChange(sig, 'calc.py', PY_BEFORE, removed)[0]).toContain('helper')
  expect(checkChange(sig, 'calc.py', PY_BEFORE, PY_BEFORE + '\n\ndef new_fn():\n    pass\n')).toEqual([]) // adding a definition is fine
  expect(checkChange(sig, 'calc.py', PY_BEFORE, 'def broken(:\n')[0]).toContain('cannot be verified')
  const one = [lockSpec({ path: 'calc.py', symbol: 'mul', mode: 'read_only' })]
  expect(checkChange(one, 'calc.py', PY_BEFORE, bodyFix)).toEqual([]) // only Calc.mul is locked
  expect(checkChange(one, 'calc.py', PY_BEFORE, PY_BEFORE.replace('a * b', 'b * a'))[0]).toContain('Calc.mul is read-only')
  expect(checkChange([lockSpec({ path: 'calc.py', symbol: 'helper', mode: 'no_delete' })], 'calc.py', PY_BEFORE, removed)[0]).toContain('may not be removed')
  expect(lockCovers(lockSpec({ path: 'src/**' }), 'src/a/b.py')).toBe(true)
  expect(lockCovers(lockSpec({ path: 'src' }), 'src/x.py')).toBe(true)
  expect(lockCovers(lockSpec({ path: 'src' }), 'srcx/a')).toBe(false)
})

let state: DomainState
beforeEach(() => { state = domainState() })
afterEach(async () => { await state.close() })

test('a checkpoint and an integration of a violating tree are refused', async () => {
  const project = await state.workspaces.importProject('calc', buggyRepo())
  const session = repo.createSession(state.conn, project.id, 't', 'scripted:a')
  const ws = await state.workspaces.createWorkspace(project, session.id)
  const locks = [lockSpec({ path: 'test_calc.py', mode: 'read_only' })]
  writeFileSync(join(ws.path, 'test_calc.py'), '# gutted\n')              // an edit no tool made
  state.workspaces.noteWrite(ws)
  const error = await state.workspaces.checkpoint(ws, null, 'pin it', { locks }).catch((e) => e)
  expect(error).toBeInstanceOf(LockViolation)
  expect(error.message).toContain('read-only')
  const cp = await state.workspaces.checkpoint(ws, null, 'unlocked pin')             // without the lock it pins
  const other = repo.createSession(state.conn, project.id, 'other', 'scripted:a')
  const target = await state.workspaces.createWorkspace(project, other.id)
  const result = await integrate(state, target, [cp.id], { run_id: null, note: 'n', protected: [], verify: false, locks })
  expect(result.status).toBe('refused')
  expect(result.lock_violations.length).toBeGreaterThan(0)
  expect(result.composed_checkpoint_id).toBeNull()
  // without the lock the composition lands in the asking workspace, which still stands at the base
  const landed = await integrate(state, target, [cp.id], { run_id: null, note: 'n', protected: [], verify: false })
  expect(landed.status).toBe('integrated')
  expect(landed.applied_to_workspace).toBe(true)
  expect(landed.composed_checkpoint_id).toBeTruthy()
  expect(landed.files.map((f) => f.path)).toEqual(['test_calc.py'])
  // a protected path refuses the composition
  const refused = await integrate(state, await state.workspaces.createWorkspace(project, other.id), [cp.id], { run_id: null, note: 'n', protected: ['test_*.py'], verify: false })
  expect(refused.status).toBe('refused')
  expect(refused.protected_hits).toEqual(['test_calc.py'])
})
