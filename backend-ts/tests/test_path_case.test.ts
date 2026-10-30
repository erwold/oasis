/** The file tools hold the same write boundary as the kernel on a macOS volume, which names a file whatever its case:
 *  `.GIT/config` is `.git/config` and `TEST_CALC.PY` is a protected `test_calc.py`. A case variant of the Git
 *  metadata, of a protected path or of a hard lock is refused as the exact name is, and so is a name that lands on
 *  them through a symlinked directory inside the workspace. In a folder edited in place a written `.git/config` would
 *  run host code at the person's next `git status` (SEC-05). */

import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from '@oasis-code/contract'
import { buildState } from '../src/api/state.ts'
import { parseWorkOrder } from '../src/agent/work_orders.ts'
import * as repo from '../src/db/repo.ts'
import { buildRuntime } from '../src/execution/isolation.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart } from '../src/llm/messages.ts'
import { lockCovers, lockSpec } from '../src/policy/locks.ts'
import { FOLDED_NAMES, PathPolicy, PathRefused } from '../src/workspace/paths.ts'
import { matchesProtected } from '../src/workspace/service.ts'
import { buggyRepo, closeState, git, scriptedModel, setModel, testConfig, testSettings, waitDone, type AppState } from './harness.ts'
import { tempDir } from './helpers.ts'

const darwin = process.platform === 'darwin'

function refusal(policy: PathPolicy, rel: string): string | null {
  try { policy.resolveWrite(rel); return null } catch (error) {
    if (error instanceof PathRefused) return error.message
    throw error
  }
}

function folder(): string {
  const root = join(tempDir('oasis-path-case-'), 'proj')
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
  writeFileSync(join(root, '.git', 'config'), '[core]\n')
  mkdirSync(join(root, 'secrets'))
  writeFileSync(join(root, 'secrets', 'key'), 'k\n')
  writeFileSync(join(root, 'test_calc.py'), 'def test(): pass\n')
  return root
}

test('macOS names are folded; other hosts compare names exactly', () => {
  expect(FOLDED_NAMES).toBe(darwin)
})

test.skipIf(!FOLDED_NAMES)('a case variant of the Git metadata is refused to the file tools, at any depth', () => {
  const policy = PathPolicy.forWorkspace(folder())
  for (const rel of ['.GIT/config', '.Git/hooks/post-commit', '.GIT', 'sub/.gIt/config', '.g‌it/config']) {
    expect(refusal(policy, rel)).toContain('Git metadata is never written')
  }
  expect(refusal(policy, 'gitnotes/config')).toBeNull()
})

test.skipIf(!FOLDED_NAMES)('a case variant of a protected path is refused as the exact name is', () => {
  const policy = PathPolicy.forWorkspace(folder(), ['test_calc.py', 'secrets/**', 'config/*.ENV'])
  for (const rel of ['test_calc.py', 'TEST_CALC.PY', 'Test_Calc.py', 'SECRETS/key', 'Secrets', 'CONFIG/prod.env']) {
    expect(refusal(policy, rel)).toContain('is a protected path')
  }
  expect(refusal(policy, 'calc.py')).toBeNull()
})

test('a symlinked directory inside the workspace does not reach the Git metadata or a protected path under another name', () => {
  const root = folder()
  symlinkSync('.git', join(root, 'g'))
  symlinkSync('secrets', join(root, 'vault'))
  const policy = PathPolicy.forWorkspace(root, ['secrets/**'])
  expect(refusal(policy, 'g/config')).toContain('Git metadata is never written')
  expect(refusal(policy, 'g/hooks/post-commit')).toContain('Git metadata is never written')
  expect(refusal(policy, 'vault/key')).toContain('is a protected path')
})

test.skipIf(!FOLDED_NAMES)('a hard lock and an integration\'s protected paths cover a case variant of their path', () => {
  expect(lockCovers(lockSpec({ path: 'calc.py', mode: 'read_only' }), 'CALC.PY')).toBe(true)
  expect(lockCovers(lockSpec({ path: 'Src/**', mode: 'read_only' }), 'src/main.py')).toBe(true)
  expect(lockCovers(lockSpec({ path: 'src', mode: 'read_only' }), 'SRC/main.py')).toBe(true)
  expect(lockCovers(lockSpec({ path: '*.PY', mode: 'read_only' }), 'calc.py')).toBe(true)
  expect(lockCovers(lockSpec({ path: 'calc.py', mode: 'read_only' }), 'calculator.py')).toBe(false)
  expect(matchesProtected('Secrets/key', ['secrets/**'])).toBe(true)
  expect(matchesProtected('TEST_CALC.PY', ['test_calc.py'])).toBe(true)
  expect(matchesProtected('calc.py', ['test_calc.py'])).toBe(false)
})

// ---- the whole path: a scripted run's tool calls under the real Seatbelt ------------------------------------------

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

async function run(session: Session, orderRaw: Record<string, unknown> | null, sequence: [string, Record<string, unknown>][]): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = []
  let index = 0
  setModel(state!, 'scripted:a', scriptedModel((messages) => {
    if (index > 0) results.push(lastToolReturn(messages, sequence[index - 1]![0]) as Record<string, unknown>)
    const next = sequence[index++]
    return next ? modelResponse([toolCallPart(next[0], next[1], '')]) : modelResponse([textPart('done')])
  }))
  const opts = orderRaw === null ? { fresh: true } : { fresh: true, work_order: parseWorkOrder({ prompt: 'case variants', ...orderRaw }) }
  const started = await state!.runs.start(session, 'case variants', opts)
  await waitDone(state!, started.id)
  return results
}

async function openSession(mode: 'snapshot' | 'direct', source: string) {
  const project = await state!.workspaces.importProject('calc', source, { mode })
  const s = repo.createSession(state!.conn, project.id, 'case', 'scripted:a')
  const ws = await state!.workspaces.createWorkspace(project, s.id)
  repo.setSessionWorkspace(state!.conn, s.id, ws.id)
  return { session: repo.getSession(state!.conn, s.id)!, ws }
}

test.skipIf(!darwin)('a snapshot: a protected path and the worktree\'s Git pointer in another case stay as they are', async () => {
  state = await buildState(testSettings(), testConfig(), { runtime: buildRuntime(), probe: true })
  const { session, ws } = await openSession('snapshot', buggyRepo())
  const calc = readFileSync(join(ws.path, 'test_calc.py'), 'utf8')
  const pointer = readFileSync(join(ws.path, '.git'), 'utf8')
  const results = await run(session, { protected_paths: ['test_calc.py'] }, [
    ['read_file', { path: 'TEST_CALC.PY' }],
    ['write_file', { path: 'TEST_CALC.PY', content: 'overwritten\n' }],
    ['read_file', { path: '.GIT' }],
    ['write_file', { path: '.GIT', content: 'gitdir: /tmp/elsewhere\n' }],
  ])
  expect(results.map((r) => r.status)).toEqual(['ok', 'refused', 'ok', 'refused'])
  expect(readFileSync(join(ws.path, 'test_calc.py'), 'utf8')).toBe(calc)
  expect(readFileSync(join(ws.path, '.git'), 'utf8')).toBe(pointer)
}, 60000)

test.skipIf(!darwin)('a folder edited in place: its Git metadata in another case is not written, and the person\'s next git runs nothing of the agent\'s', async () => {
  state = await buildState(testSettings(), testConfig(), { runtime: buildRuntime(), probe: true })
  const source = join(tempDir('oasis-path-case-direct-'), 'proj')
  mkdirSync(source, { recursive: true })
  git(['init', '-q', '-b', 'main'], source)
  writeFileSync(join(source, 'a.txt'), 'a\n')
  git(['add', '-A'], source)
  git(['commit', '-q', '-m', 'init'], source)
  const configBefore = readFileSync(join(source, '.git', 'config'), 'utf8')
  const { session } = await openSession('direct', source)
  const marker = join(tempDir('oasis-path-case-marker-'), 'ran-on-the-host')
  const results = await run(session, null, [
    ['write_file', { path: '.GIT/hooks/post-commit', content: '#!/bin/sh\necho hook\n' }],
    ['read_file', { path: '.Git/config' }],
    ['edit_file', { path: '.Git/config', old_string: '[core]', new_string: `[core]\n\tfsmonitor = "touch '${marker}'; false"` }],
  ])
  spawnSync('git', ['status', '--short'], { cwd: source, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: source, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' })
  expect(results.map((r) => r.status)).toEqual(['refused', 'ok', 'refused'])
  expect(existsSync(join(source, '.git', 'hooks', 'post-commit'))).toBe(false)
  expect(readFileSync(join(source, '.git', 'config'), 'utf8')).toBe(configBefore)
  expect(existsSync(marker)).toBe(false)
}, 60000)
