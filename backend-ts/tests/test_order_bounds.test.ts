/** A work order's boundaries hold at the kernel: with the real macOS Seatbelt (enforcement full, never the
 *  passthrough), a command under a read-only order cannot write the worktree, under a read scope cannot read (or
 *  `git show`) what the scope leaves out, under a write scope and protected paths cannot replace, rename or delete
 *  what they hold; a work order without the network keeps it through an approval, and an approval runs with no more
 *  than the call had when it was proposed. Synthetic repos and a loopback canary only. */
import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from '@oasis-code/contract'
import { buildState } from '../src/api/state.ts'
import { buildRuntime, fnmatchRegex, globFilters, orderRules, SeatbeltRuntime, type OrderBounds } from '../src/execution/isolation.ts'
import { parseWorkOrder } from '../src/agent/work_orders.ts'
import * as repo from '../src/db/repo.ts'
import * as gate from '../src/policy/gate.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart } from '../src/llm/messages.ts'
import { sandboxForWorkspace } from '../src/workspace/sandbox.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, testConfig, testSettings, waitDone, type AppState } from './harness.ts'

const darwin = process.platform === 'darwin'
let state: AppState | null = null
let server: ReturnType<typeof Bun.serve> | null = null
afterEach(async () => { server?.stop(true); server = null; if (state) await closeState(state); state = null })

/** The app on the real Seatbelt, probed: these tests mean nothing on a passthrough. */
async function realState() {
  state = await buildState(testSettings(), testConfig(), { runtime: buildRuntime(), probe: true })
  expect(state.isolation.runtime).toBe('seatbelt')
  expect(state.isolation.enforcement).toBe('full')
  return state
}

async function calls(session: Session, orderRaw: Record<string, unknown>, sequence: [string, Record<string, unknown>][]) {
  const results: Record<string, unknown>[] = []
  let index = 0
  setModel(state!, 'scripted:a', scriptedModel((messages) => {
    if (index > 0) results.push(lastToolReturn(messages, sequence[index - 1]![0]) as Record<string, unknown>)
    const next = sequence[index++]
    return next ? modelResponse([toolCallPart(next[0], next[1], '')]) : modelResponse([textPart('done')])
  }))
  const run = await state!.runs.start(session, 'synthetic', { fresh: true, work_order: parseWorkOrder({ prompt: 'synthetic', ...orderRaw }) })
  return { run: await waitDone(state!, run.id), results }
}

const out = (r: Record<string, unknown>) => `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`

test('the profile renders an order\'s globs as the file tools read them', () => {
  const root = '/data/ws.1/tree'
  expect(globFilters(root, '**')).toEqual(['(subpath "/data/ws.1/tree")'])
  expect(globFilters(root, '.')).toEqual(['(subpath "/data/ws.1/tree")'])
  expect(globFilters(root, 'calc.py')).toEqual(['(subpath "/data/ws.1/tree/calc.py")'])
  expect(globFilters(root, 'src/**')).toEqual(['(subpath "/data/ws.1/tree/src")'])
  expect(globFilters(root, '/src/')).toEqual(['(subpath "/data/ws.1/tree/src")'])
  // a plain string, its escapes doubled for the profile's reader (the raw #"…" form cannot hold a quote)
  expect(globFilters(root, 'src/*.py')).toEqual(['(regex "^/data/ws\\\\.1/tree/src/.*\\\\.py$")'])
  expect(globFilters(root, 'test_?.py')).toEqual(['(regex "^/data/ws\\\\.1/tree/test_.\\\\.py$")'])
  expect(globFilters(root, 'a[!x]b.md')).toEqual(['(regex "^/data/ws\\\\.1/tree/a[^x]b\\\\.md$")'])
  expect(fnmatchRegex('a+b(c).py')).toBe('a\\+b\\(c\\)\\.py')
  const bounds: OrderBounds = { root, read_only: false, read: ['calc.py', 'src/*.py'], write: ['calc.py'], protected: ['test_calc.py', 'secrets/**'], repository: ['/data/ws.1/repo'], attached: { name: 'lib', root: '/elsewhere/lib', writable: false } }
  const rules = orderRules(bounds)
  expect(rules).toContain('(deny file-read*\n  (subpath "/data/ws.1/tree")\n  (subpath "/data/ws.1/repo")\n  (subpath "/elsewhere/lib"))')
  expect(rules).toContain('(allow file-read*\n  (subpath "/data/ws.1/tree/calc.py")\n  (regex "^/data/ws\\\\.1/tree/src/.*\\\\.py$"))')
  expect(rules).toContain('(allow file-read-metadata\n  (literal "/data/ws.1/tree")\n  (literal "/elsewhere/lib")\n  (literal "/data/ws.1/tree/src"))')
  expect(rules).toContain('(deny file-write*\n  (subpath "/data/ws.1/tree"))\n(allow file-write*\n  (subpath "/data/ws.1/tree/calc.py"))')
  expect(rules).toContain('(deny file-write*\n  (subpath "/data/ws.1/tree/test_calc.py")\n  (subpath "/data/ws.1/tree/secrets"))')
  // an attached folder named by its mount: the glob applies under its real root too
  const attached = orderRules({ ...bounds, read: ['lib/**', 'lib/src/*.h'], write: null, protected: [] })
  expect(attached).toContain('(subpath "/elsewhere/lib")\n  (regex "^/data/ws\\\\.1/tree/lib/src/.*\\\\.h$")\n  (regex "^/elsewhere/lib/src/.*\\\\.h$")')
  // read-only: nothing under the root (nor an attached folder opened for writing) is written, whatever the scope says
  const ro = orderRules({ ...bounds, read: null, read_only: true, write: ['**'], attached: { name: 'lib', root: '/elsewhere/lib', writable: true } })
  expect(ro).toContain('(deny file-write*\n  (subpath "/data/ws.1/tree")\n  (subpath "/elsewhere/lib"))')
  expect(ro).not.toContain('(allow file-write*')
  expect(orderRules(null)).toBe(';; no work order bounds')
  // the rules sit after the workspace's and before the pinned roots in the profile
  const profile = new SeatbeltRuntime().profile({ writable: [root], write_deny: [], read_deny: [], read_allow: [root], pinned: [root], network: false, bounds })
  expect(profile.indexOf(';; the work order')).toBeGreaterThan(profile.indexOf('(allow file-read-metadata'))
  expect(profile.indexOf(';; the work order')).toBeLessThan(profile.indexOf('(deny file-write-unlink'))
})

test.skipIf(!darwin)('read-only: a shell and an interpreter cannot write the worktree, on the real Seatbelt', async () => {
  await realState()
  const { session, ws } = await openSession(state!, buggyRepo())
  const before = readFileSync(join(ws.path, 'calc.py'), 'utf8')
  const { results } = await calls(session, { read_only: true }, [
    ['read_file', { path: 'calc.py' }], ['edit_file', { path: 'calc.py', old_string: 'a - b', new_string: 'a + b' }],
    ['write_file', { path: 'calc.py', content: 'SYNTHETIC_WRITE\n' }],
    ['bash', { command: "printf SYNTHETIC_SHELL_WRITE > calc.py; python3 -c \"open('calc.py','a').write('PYTHON_WRITE')\"; printf new > brand_new.txt; rm calc.py; mv calc.py moved; echo still-here" }],
    ['bash', { command: 'cat calc.py && git status --short && echo READS_FINE' }],
  ])
  expect(results[1]!.status).toBe('refused_by_work_order')
  expect(results[2]!.status).toBe('refused_by_work_order')
  expect(out(results[3]!)).toContain('Operation not permitted')
  expect(out(results[3]!)).toContain('still-here')                       // the command itself ran to its end
  expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toBe(before)
  expect(() => readFileSync(join(ws.path, 'brand_new.txt'))).toThrow()
  expect(results[4]!.status).toBe('succeeded')
  expect(out(results[4]!)).toContain('READS_FINE')
}, 30000)

test.skipIf(!darwin)('a read scope hides the rest of the worktree from a command, and its history too', async () => {
  await realState()
  const { session } = await openSession(state!, buggyRepo())
  const { results } = await calls(session, { scope: { read: ['calc.py'] } }, [
    ['read_file', { path: 'README.md' }], ['bash', { command: 'cat README.md' }], ['bash', { command: 'git show HEAD:README.md; git log --oneline' }],
    ['bash', { command: 'cat calc.py' }], ['bash', { command: 'ls .' }],
  ])
  expect(results[0]!.status).toBe('refused_by_work_order')
  expect(results[1]!.status).toBe('failed')
  expect(JSON.stringify(results[1])).not.toContain('# calc')
  expect(JSON.stringify(results[2])).not.toContain('# calc')
  expect(results[3]!.status).toBe('succeeded')
  expect(out(results[3]!)).toContain('def add')
  expect(results[4]!.status).toBe('failed')                              // the names a scope leaves out are not listed either
}, 30000)

test.skipIf(!darwin)('a write scope and protected paths: a command cannot replace, rename, delete or recreate what they hold', async () => {
  await realState()
  const { session, ws } = await openSession(state!, buggyRepo())
  const before = readFileSync(join(ws.path, 'test_calc.py'), 'utf8')
  const readme = readFileSync(join(ws.path, 'README.md'), 'utf8')
  const { results } = await calls(session, { scope: { write: ['calc.py'] }, protected_paths: ['test_calc.py'] }, [
    ['read_file', { path: 'test_calc.py' }], ['write_file', { path: 'test_calc.py', content: 'SYNTHETIC_TOOL_WRITE\n' }],
    ['bash', { command: 'mv test_calc.py renamed_test; rm renamed_test; printf SYNTHETIC_REPLACEMENT > test_calc.py; cp calc.py test_calc.py; printf X > README.md; mkdir newdir; echo still-here' }],
    ['bash', { command: 'printf "def add(a, b):\\n    return a + b\\n" > calc.py; cat calc.py' }],
  ])
  expect(results[1]!.status).toBe('refused_by_work_order')
  expect(out(results[2]!)).toContain('still-here')
  expect(readFileSync(join(ws.path, 'test_calc.py'), 'utf8')).toBe(before)
  expect(readFileSync(join(ws.path, 'README.md'), 'utf8')).toBe(readme)
  expect(() => readFileSync(join(ws.path, 'renamed_test'))).toThrow()
  expect(results[3]!.status).toBe('succeeded')
  expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toBe('def add(a, b):\n    return a + b\n')
  // the same with no order at all: the project's protected paths hold for a command too
  const { results: plain } = await calls(session, {}, [['bash', { command: 'mkdir -p secrets && printf leak > secrets/key; printf ok > allowed.txt; echo done' }]])
  expect(out(plain[0]!)).toContain('done')
  expect(() => readFileSync(join(ws.path, 'secrets', 'key'))).toThrow()
  expect(readFileSync(join(ws.path, 'allowed.txt'), 'utf8')).toBe('ok')
}, 30000)

test.skipIf(!darwin)('an order without the network keeps a command offline through an approval; a grant widened after the proposal widens nothing', async () => {
  await realState()
  let hits = 0
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { hits++; return new Response('SYNTHETIC_NETWORK_OK') } })
  const { session, project } = await openSession(state!, buggyRepo())
  expect(session.grants.network).toBe(true)
  const command = `/usr/bin/curl --noproxy '*' --max-time 2 -s http://127.0.0.1:${server.port}/qa; echo exit=$?`
  const { results: offline } = await calls(session, { execution: { network: false } }, [['bash', { command }]])
  expect(hits).toBe(0)
  expect(offline[0]!.network).toBe(false)
  gate.recordRunControl(state!.conn, session.id, 'pause', ['isolated_code_execution'])
  const { results: gated } = await calls(session, { execution: { network: false } }, [['bash', { command }]])
  expect(gated[0]!.status).toBe('action_gated')
  const proposal = gate.listProposals(state!.conn, project.id, session.id)[0]!
  const decision = await gate.decideProposal(state!, proposal.proposal_asset_id, 'approve')
  const ran = decision.result as Record<string, unknown>
  expect(ran.network).toBe(false)
  expect(hits).toBe(0)
  expect(String(ran.stdout)).toContain('exit=7')                         // curl could not connect
  // a thread run (no order) proposed while the network was off, approved after the person turned it on: still off
  repo.setSessionGrants(state!.conn, session.id, { ...session.grants, network: false })
  const off = repo.getSession(state!.conn, session.id)!
  setModel(state!, 'scripted:a', scriptedModel((messages) => lastToolReturn(messages, 'bash') ? modelResponse([textPart('done')]) : modelResponse([toolCallPart('bash', { command }, '')])))
  await waitDone(state!, (await state!.runs.start(off, 'synthetic', { fresh: true })).id)
  const second = gate.listProposals(state!.conn, project.id, session.id).find((p) => p.status === 'pending')!
  repo.setSessionGrants(state!.conn, session.id, { ...session.grants, network: true })
  const widened = await gate.decideProposal(state!, second.proposal_asset_id, 'approve')
  expect((widened.result as Record<string, unknown>).network).toBe(false)
  expect(hits).toBe(0)
  // and the other way round: proposed with the network, approved after it was withdrawn — off as well
  gate.recordRunControl(state!.conn, session.id, 'run')
  gate.recordRunControl(state!.conn, session.id, 'pause', ['isolated_code_execution'])
  const on = repo.getSession(state!.conn, session.id)!
  await waitDone(state!, (await state!.runs.start(on, 'synthetic', { fresh: true })).id)
  const third = gate.listProposals(state!.conn, project.id, session.id).find((p) => p.status === 'pending')!
  repo.setSessionGrants(state!.conn, session.id, { ...session.grants, network: false })
  const narrowed = await gate.decideProposal(state!, third.proposal_asset_id, 'approve')
  expect((narrowed.result as Record<string, unknown>).network).toBe(false)
  expect(hits).toBe(0)
}, 40000)

test('a workspace sandbox carries the order\'s bounds only when the order bounds something', () => {
  const project = { kind: 'snapshot', source_path: null, base_repo_path: '/tmp/none/base.git' } as never
  const plain = sandboxForWorkspace('/tmp/none', project, { path: '/tmp/none/ws' }, { network: false })
  expect(plain.bounds ?? null).toBeNull()
  const unbounded = sandboxForWorkspace('/tmp/none', project, { path: '/tmp/none/ws' }, { network: false, order: { read_only: false, read: null, write: null, protected: [] } })
  expect(unbounded.bounds ?? null).toBeNull()
  const bounded = sandboxForWorkspace('/tmp/none', project, { path: '/tmp/none/ws' }, { network: false, order: { read_only: true, read: null, write: null, protected: ['.git/**'] } })
  expect(bounded.bounds!.read_only).toBe(true)
  expect(bounded.bounds!.repository.some((p) => p.endsWith('/none/base.git'))).toBe(true)
})
