/** Final integration of the 2026-10-16 friction work (execution + task + locking + ui on the Full access base): the
 *  seams no single worker's branch held. Every test here failed on the merged tree before the integration commit
 *  (21612e2) by an assertion — or on the execution worker's own tree (e35df72) where that is said — and passes after.
 *
 *  - nested session folders: the deepest folder decides for a Full access command's host restriction as it does for
 *    the file tools (a writable folder inside a read-only one stays writable; a read-only one inside that is denied
 *    again), in the profile's own rule order; the sandbox does not re-deny a writable folder inside a read-only one;
 *  - a folder edited in place is shared by its sessions, their own folders are not: a native director bound to one
 *    session reads the shared folder and its own session's folders, and another session's folder no more than an
 *    unknown path; get_workspace names its own session's folders; a connector command's cwd is its chosen session's;
 *  - the connector route says why it ran in the sandbox (route_sandbox);
 *  - a check names no deadline unless configured: none with Full access, the sandbox's default in it (item 6);
 *  - a sandboxed command stopped by one of the sandbox's resource limits says which, with the configured value and
 *    how to go on — certain only where the signal is known (item 6);
 *  - a Full access command refused for the login shell says how to go on;
 *  - a process of a run being made while the run is stopped is stopped as soon as it exists.
 *
 *  RecordingRuntime is NOT an OS sandbox: it records what it is given and runs the command unconfined. These tests
 *  prove routing, records and profile text; the kernel's enforcement of the profile is tests/test_host_profile's real
 *  Seatbelt test (skipped where Seatbelt cannot nest). */

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CheckConfigSchema } from '@oasis-code/contract'
import { executeCommand } from '../src/agent/tools/commands.ts'
import * as repo from '../src/db/repo.ts'
import { Harness } from '../src/director/harness.ts'
import { insertDirectorSession } from '../src/director/store.ts'
import { directorToolset } from '../src/director/tools.ts'
import { hostProfile, type HostRestrictions, type Sandbox } from '../src/execution/isolation.ts'
import { HostShellRefused, loginShellOf } from '../src/execution/host_env.ts'
import { ProcessManager } from '../src/execution/processes.ts'
import type { App } from '../src/main.ts'
import { runChecks } from '../src/verify/checks.ts'
import { PathPolicy } from '../src/workspace/paths.ts'
import { workspaceAttached } from '../src/workspace/service.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo, domainState, FAKE_FULL, PassthroughRuntime, useFixtureHost, type DomainState } from './harness.ts'
import { tempDir } from './helpers.ts'

type Rec = Record<string, unknown>
const real = (p: string) => realpathSync(p)

/** Not an OS sandbox: records the boxes and host restrictions it is given, runs the command as it is. */
class RecordingRuntime extends PassthroughRuntime {
  readonly restrictions: HostRestrictions[] = []
  readonly boxes: Sandbox[] = []
  override command(argv: string[], box: Sandbox, profile: string): string[] { this.boxes.push(box); return super.command(argv, box, profile) }
  hostCommand(argv: string[], restrictions: HostRestrictions, profilePath: string): string[] {
    writeFileSync(profilePath, ';; recorded, not applied\n')
    this.restrictions.push(restrictions)
    return argv
  }
}

let app: App | null = null
const states: DomainState[] = []
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {})
  if (app) await app.close()
  app = null
  for (const st of states.splice(0)) await st.close()
})

function recordingState(limits?: ConstructorParameters<typeof ProcessManager>[5]): { st: DomainState; runtime: RecordingRuntime } {
  const st = domainState()
  const runtime = new RecordingRuntime()
  ;(st as { processes: ProcessManager }).processes = useFixtureHost(new ProcessManager(st.settings, st.conn, st.store, runtime, { ...FAKE_FULL, runtime: 'recording' }, limits))
  states.push(st)
  return { st, runtime }
}

async function workspaceOf(st: DomainState) {
  const project = await st.workspaces.importProject('calc', buggyRepo())
  const session = repo.createSession(st.conn, project.id, 't', 'scripted:a')
  const ws = await st.workspaces.createWorkspace(project, session.id)
  repo.setSessionWorkspace(st.conn, session.id, ws.id)
  return { project, session, ws }
}

async function execute(st: DomainState, opts: Rec) {
  const { project, ws } = await workspaceOf(st)
  const policy = PathPolicy.forWorkspace(ws.path, [], workspaceAttached(project, ws))
  const [payload] = await executeCommand({
    processes: st.processes, workspaces: st.workspaces, config: st.config, project, workspace: ws, policy, locks: [], run_id: null, tool_call_id: null,
    command: 'echo ran', wait_s: 30, decide: () => ({ network: true, access: 'full', requested_access: 'full', access_reasons: [] }), ...opts,
  } as never)
  return { payload: payload as Rec, project, ws }
}

/** A read-only source with a writable output folder inside it, and a read-only folder inside that output. */
function nested() {
  const base = real(tempDir('oasis-nest-'))
  const src = join(base, 'src')
  const out = join(src, 'out')
  const fixtures = join(out, 'fixtures')
  for (const d of [src, out, fixtures]) mkdirSync(d, { recursive: true })
  return { base, src, out, fixtures }
}

// ---- nested folders: the deepest decides ----------------------------------------------------------------------------

test('the host profile: a writable folder inside a read-only one is reopened after it, a read-only one inside that denied again — shallowest first, so the deepest has the last word; with none, the profile is as it was', () => {
  const f = nested()
  const p = hostProfile({ network: true, write_deny: [f.src, f.fixtures], write_allow: [f.out] } as HostRestrictions)
  const denySrc = p.indexOf(`(deny file-write*\n  (subpath "${f.src}")`)
  const allowOut = p.indexOf(`(allow file-write*\n  (subpath "${f.out}")`)
  const denyFixtures = p.lastIndexOf(`(subpath "${f.fixtures}")`)
  expect(denySrc).toBeGreaterThan(-1)
  expect(allowOut).toBeGreaterThan(denySrc)
  expect(denyFixtures).toBeGreaterThan(allowOut)
  // nothing after the reopening denies the whole read-only folder again (it would take the writable one with it)
  expect(p.slice(allowOut)).not.toContain(`(deny file-write*\n  (subpath "${f.src}")`)
  // its links stay denied, and it and its ancestors stay pinned against removal and rename
  expect(p).toContain(`(deny file-link\n  (subpath "${f.src}")`)
  const pins = p.slice(p.indexOf('(deny file-write-unlink'), p.indexOf('(deny file-write-create'))
  expect(pins).toContain(`(literal "${f.src}")`)
  expect(pins).toContain(`(literal "${dirname(f.src)}")`)
  // a writable folder outside every denied one reopens nothing; none at all: the profile it always was
  const plain = hostProfile({ network: true, write_deny: [f.src] })
  expect(hostProfile({ network: true, write_deny: [f.src], write_allow: [] } as HostRestrictions)).toBe(plain)
  expect(hostProfile({ network: true, write_deny: [f.src], write_allow: [f.base] } as HostRestrictions)).toBe(plain)
  expect(plain).not.toContain('(allow file-write*')
})

test('a Full access command with a writable folder inside a read-only one: the host restriction denies the read-only one and leaves the writable one (and a working folder inside a read-only one) writable; read_only denies them all', async () => {
  const { st, runtime } = recordingState()
  const f = nested()
  const { payload } = await execute(st, { roots: [{ path: f.src, access: 'read' }, { path: f.out, access: 'write' }, { path: f.fixtures, access: 'read' }] })
  expect(payload.status, JSON.stringify(payload)).toBe('succeeded')
  const r = runtime.restrictions.at(-1)!
  expect([...r.write_deny].sort()).toEqual([f.fixtures, f.src].sort())
  expect(r.write_allow).toEqual([f.out])
  // the working folder lying inside a read-only folder of the session's: written as the file tools write it
  const { ws } = await workspaceOf(st)
  const holding = dirname(real(ws.path))
  await execute(st, { roots: [{ path: holding, access: 'read' }] })
  const r2 = runtime.restrictions.at(-1)!
  expect(r2.write_deny).toEqual([holding])
  expect(r2.write_allow!.some((p) => dirname(p) === holding)).toBe(true)
  // a read-only command: every folder denied, nothing reopened
  await execute(st, { read_only: true, roots: [{ path: f.src, access: 'read' }, { path: f.out, access: 'write' }] })
  const r3 = runtime.restrictions.at(-1)!
  expect(r3.write_deny).toEqual(expect.arrayContaining([f.src, f.out]))
  expect(r3.write_allow ?? []).toEqual([])
})

test('a sandboxed command with a writable folder inside a read-only one: the writable one is writable and the read-only one is not re-denied over it (red on the execution worker\'s own tree, e35df72, where every read root was appended to write_deny)', async () => {
  const { st, runtime } = recordingState()
  const f = nested()
  const { payload } = await execute(st, { roots: [{ path: f.src, access: 'read' }, { path: f.out, access: 'write' }], decide: () => ({ network: false, access: 'sandbox' }) })
  expect(payload.status, JSON.stringify(payload)).toBe('succeeded')
  const box = runtime.boxes.at(-1)!
  expect(box.writable).toContain(f.out)
  expect(box.write_deny).not.toContain(f.src)
  // and nothing of a writable folder is added to what the sandbox reads past its credential denies
  expect(box.read_allow).not.toContain(f.out)
})

// ---- a shared folder's sessions: their own folders stay theirs --------------------------------------------------------

async function sharedFolderTwoSessions() {
  const runtime = new RecordingRuntime()
  app = await makeApp(null, { probe: false, runtime, isolation: { ...FAKE_FULL, runtime: 'recording' } })
  const c = new Client(app)
  const folder = join(real(tempDir('oasis-shared-')), 'f')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'README.md'), 'shared\n')
  const rootA = join(real(tempDir('oasis-root-a-')), 'a')
  const rootB = join(real(tempDir('oasis-root-b-')), 'b')
  for (const [d, name] of [[rootA, 'a.txt'], [rootB, 'b.txt']] as const) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, name), `${name}\n`) }
  const project = await json(await c.post('/api/projects', { source_path: folder, mode: 'direct' }))
  const a = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'A', roots: [{ path: rootA, access: 'read' }] }))
  const b = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'B', roots: [{ path: rootB, access: 'read' }] }))
  const wsId = (b.workspace as Rec).id as string
  expect((a.workspace as Rec).id).toBe(wsId)                                    // one folder edited in place, one workspace
  return { c, runtime, folder, rootA, rootB, a, b, wsId }
}

test('a native director bound to one session of a shared folder reads the folder and its own session\'s folders; another session\'s folder is refused as an unknown path is; get_workspace names its own folders', async () => {
  const f = await sharedFolderTwoSessions()
  const ds = insertDirectorSession(app!.state.conn, { session_id: f.b.id as string, transport: 'native', model: 'scripted:a', label: 'director', config: { tool_surface: 'director.v6' } })
  const harness = Harness.connect('http://localhost', 'test-token', { fetchImpl: (input, init) => Promise.resolve(app!.app.request(input, init)) })
  const toolset = await directorToolset(harness, app!.state.conn, 'director.v6')
  closers.push(() => toolset.close())
  const tool = (name: string) => toolset.tools.find((t) => t.name === name)!
  let n = 0
  const call = async (name: string, args: Rec): Promise<Rec> => (await tool(name).fn({
    deps: { session_id: f.b.id as string, director_session_id: ds.id, allow_destructive: false, onResult: () => {}, cancelled: () => false },
    tool_call_id: `tc_${++n}`, tool_name: name, retry: 0, messages: [],
  } as never, args as never)) as Rec
  expect(String((await call('read_file', { workspace_id: f.wsId, path: 'README.md' })).text ?? JSON.stringify(await call('read_file', { workspace_id: f.wsId, path: 'README.md' })))).toContain('shared')
  expect(JSON.stringify(await call('read_file', { workspace_id: f.wsId, path: join(f.rootB, 'b.txt') }))).toContain('b.txt')
  const other = await call('read_file', { workspace_id: f.wsId, path: join(f.rootA, 'a.txt') })
  const unknown = await call('read_file', { workspace_id: f.wsId, path: join(dirname(f.rootA), 'nowhere', 'a.txt') })
  expect(other.status).toBe('error')
  // the same answer as for a path that names nothing: A's folder is not revealed to B's director
  expect(String(other.error).replaceAll(join(f.rootA, 'a.txt'), 'P')).toBe(String(unknown.error).replaceAll(join(dirname(f.rootA), 'nowhere', 'a.txt'), 'P'))
  const detail = await call('get_workspace', { workspace_id: f.wsId })
  expect(((detail.effective_roots ?? []) as Rec[]).map((r) => r.path)).toEqual([f.rootB])
  // the person (or a connector, globally authorized) still reads every session's folder of the shared workspace
  const person = await app!.app.request(`/api/workspaces/${f.wsId}/file?path=${encodeURIComponent(join(f.rootA, 'a.txt'))}`, { headers: { 'x-oasis-code-token': 'test-token', origin: 'http://localhost' } })
  expect(person.status).toBe(200)
})

test('a connector command on a shared folder runs in its chosen session\'s folders: a cwd in another session\'s folder is refused', async () => {
  const f = await sharedFolderTwoSessions()
  const V6 = { 'x-oasis-tool-surface': 'director.v6' }
  const theirs = await json(await f.c.post(`/api/workspaces/${f.wsId}/commands`, { command: 'pwd', wait_s: 10, cwd: f.rootA, access: 'session', session_id: f.b.id }, V6), 400)
  expect(String(theirs.detail)).toContain('cwd')
  const own = await json(await f.c.post(`/api/workspaces/${f.wsId}/commands`, { command: 'pwd', wait_s: 10, cwd: f.rootB, access: 'session', session_id: f.b.id }, V6))
  expect(own.exit_code).toBe(0)
  expect(String(own.stdout).trim()).toBe(f.rootB)
  // what the OS was asked to hold for it: B's read-only folder, never A's
  expect(f.runtime.restrictions.at(-1)!.write_deny).toEqual([f.rootB])
})

// ---- the connector route's sandbox, said ----------------------------------------------------------------------------

test('the connector command route without access "session" runs in the sandbox and says why (route_sandbox)', async () => {
  const f = await sharedFolderTwoSessions()
  const res = await json(await f.c.post(`/api/workspaces/${f.wsId}/commands`, { command: 'true', wait_s: 10 }))
  expect(res.requested_access).toBe('sandbox')
  expect(res.effective_access).toBe('sandbox')
  // (and the session's read-only folder, said as for every command of it)
  expect((res.access_reasons as Rec[]).map((r) => r.code)).toEqual(['route_sandbox', 'read_only_root'])
  expect(String((res.access_reasons as Rec[])[0]!.next_step)).toContain('session')
})

// ---- item 6: checks and the sandbox's limits ----------------------------------------------------------------------

test('a check names no deadline unless its config does: none with Full access, the sandbox\'s default in it', async () => {
  const { st } = recordingState()
  const { project, session, ws } = await workspaceOf(st)
  const check = CheckConfigSchema.parse({ id: 'quick', command: 'true', parser: 'exit_code' })
  expect(check.timeout_s).toBeNull()
  repo.setSessionAccess(st.conn, session.id, 'full')
  const cp = await st.workspaces.checkpoint(ws, null, 'to check')
  const [onHost] = await runChecks(st.conn, st.workspaces, st.processes, project, cp, { checks: [check] })
  expect(onHost!.status).toBe('pass')
  const checks = () => repo.listExecutions(st.conn, { workspace_id: ws.id }).filter((x) => x.kind === 'check')
  expect(checks().at(-1)!.isolation).toMatchObject({ effective_access: 'full', timeout_s: null })
  repo.setSessionAccess(st.conn, session.id, 'sandbox')
  await runChecks(st.conn, st.workspaces, st.processes, project, cp, { checks: [check] })
  expect(checks().at(-1)!.isolation).toMatchObject({ effective_access: 'sandbox', timeout_s: 600, timeout_source: 'default' })
  // a configured one holds either way, said as the check's
  await runChecks(st.conn, st.workspaces, st.processes, project, cp, { checks: [{ ...check, timeout_s: 30 }] })
  expect(checks().at(-1)!.isolation).toMatchObject({ timeout_s: 30, timeout_source: 'check' })
})

test('a sandboxed command stopped by the sandbox\'s CPU-time or file-size limit says which limit, its value and how to go on; a Full access command\'s exit status is never read as one', async () => {
  const { st } = recordingState({ cpu_seconds: 1, address_space_bytes: 8 * 1024 ** 3, file_size_bytes: 4096, open_files: 1024 })
  const { project, ws } = await workspaceOf(st)
  const box = (await import('../src/workspace/sandbox.ts')).sandboxForWorkspace(st.settings.data_dir, project, ws, { network: false })
  const run = async (command: string, access: 'sandbox' | 'full') => {
    const x = await st.processes.start({ command, cwd: ws.path, project_id: project.id, workspace_id: ws.id, access, ...(access === 'sandbox' ? { sandbox: box } : {}), timeout_s: 30 })
    await st.processes.wait(x.id, 40)
    return st.processes.summary(x.id)
  }
  const cpu = await run('while :; do :; done', 'sandbox')
  expect([-24, 152]).toContain(cpu.exit_code as number)
  expect(cpu.stop_reason).toMatchObject({ code: 'cpu_limit', certain: cpu.exit_code === -24 })
  expect(String((cpu.stop_reason as Rec).detail)).toContain('1 s')
  expect(String((cpu.stop_reason as Rec).next_step)).toContain('Full access')
  const big = await run('head -c 65536 /dev/zero > big.bin', 'sandbox')
  expect([-25, 153]).toContain(big.exit_code as number)
  expect(big.stop_reason).toMatchObject({ code: 'file_size_limit' })
  expect(String((big.stop_reason as Rec).detail)).toContain('4,096 bytes')
  // a program's own exit status 152 under Full access: no limit applies there, nothing is claimed
  const own = await run('exit 152', 'full')
  expect(own.exit_code).toBe(152)
  expect(own.stop_reason).toBeNull()
})

test('a Full access command refused for its login shell says how to go on', () => {
  for (const env of [{}, { SHELL: 'zsh' }, { SHELL: '/usr/local/bin/xonsh' }, { SHELL: '/nonexistent/bin/zsh' }]) {
    let message = ''
    try { loginShellOf(env, () => null) } catch (error) { expect(error).toBeInstanceOf(HostShellRefused); message = (error as Error).message }
    expect(message).toContain('nothing ran')
    expect(message).toContain('To go on')
    expect(message).toContain('Sandbox access')
  }
})

// ---- a stopped run's process being made ---------------------------------------------------------------------------

test('a process of a run that is stopped while it is being made is stopped as soon as it exists', async () => {
  const { st } = recordingState()
  const { project, ws } = await workspaceOf(st)
  const runId = 'run_0123456789ab'
  const starting = st.processes.start({ command: 'sleep 5; echo finished', cwd: ws.path, project_id: project.id, workspace_id: ws.id, run_id: runId, access: 'full' })
  // the run is stopped before its process exists: stopAllForRun finds no live process of it yet
  expect(st.processes.stopAllForRun(runId)).toBe(0)
  const x = await starting
  const ended = await st.processes.wait(x.id, 10)
  expect(ended!.cancelled).toBe(true)
  expect(st.processes.readOutput(x.id, 'stdout').text).not.toContain('finished')
})

test('two sessions in one folder and none named: 409 session_ambiguous names the candidates and how to go on (none is chosen for the caller)', async () => {
  const f = await sharedFolderTwoSessions()
  const res = await json(await f.c.post(`/api/workspaces/${f.wsId}/commands`, { command: 'true', access: 'session' }, { 'x-oasis-tool-surface': 'director.v6' }), 409)
  expect(res.code).toBe('session_ambiguous')
  expect(Array.isArray(res.candidates), JSON.stringify(res)).toBe(true)
  expect((res.candidates as Rec[]).map((c) => c.session_id).sort()).toEqual([f.a.id, f.b.id].sort())
  expect(String(res.next_step)).toContain('session_id')
  expect(f.runtime.restrictions).toHaveLength(0)                                  // nothing ran
})

// ---- a copy, a read-only mount: the file tools' boundary, not a Full access command's ------------------------------

test('a Full access run over a folder it only reads (attached, writes not granted) is told the folder is read-only to the file tools and that a command, as the user, can change it; a sandboxed run keeps its line', async () => {
  const prompts: string[] = []
  const { appState, closeState } = await import('./harness.ts')
  const { scriptedModel } = await import('../src/llm/scripted.ts')
  const { modelResponse, textPart } = await import('../src/llm/messages.ts')
  const st = await appState({ models: { 'scripted:a': scriptedModel((m) => { prompts.push(JSON.stringify(m)); return modelResponse([textPart('done')]) }, 'scripted-a') } })
  try {
    const root = join(real(tempDir('oasis-stuff-')), 'Downloads')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'a.txt'), 'hello\n')
    const project = await st.workspaces.importProject('stuff', root, { mode: 'attached' })
    for (const access of ['full', 'sandbox'] as const) {
      const session = repo.createSession(st.conn, project.id, access, 'scripted:a')
      const ws = await st.workspaces.createWorkspace(project, session.id)
      repo.setSessionWorkspace(st.conn, session.id, ws.id)
      repo.setSessionGrants(st.conn, session.id, { ...session.grants, attached_write: false })
      repo.setSessionAccess(st.conn, session.id, access)
      const run = await st.runs.start(repo.getSession(st.conn, session.id)!, 'look')
      const { waitDone } = await import('./harness.ts')
      await waitDone(st, run.id)
    }
    expect(prompts[0]).toContain('Attached folder: Downloads/ (read-only to the file tools; with Full access a command runs as the user and can change the original files there')
    expect(prompts.at(-1)).toContain('Attached folder: Downloads/ (read-only).')
  } finally {
    await closeState(st)
  }
})

test('director.v6 says a source-mounted copy is read-only to the file tools and sandboxed commands only: with Full access a participant\'s commands can write the source folder (the copy is no OS isolation for them)', async () => {
  const { readFileSync } = await import('node:fs')
  const v6 = readFileSync(join(import.meta.dir, '..', 'src', 'director', 'surfaces', 'director.v6.json'), 'utf8')
  expect(v6).toContain("a Full access session's commands run as the user and can write it")
  expect(v6).toContain('the copy is no OS isolation for them')
  expect(v6).not.toContain('a direct or attached source folder is mounted read-only)')
})
