/** Execution limits by selection (2026-10-16). With Full access there is no deadline unless one is given (a call's
 *  timeout_s, a check's, a configured one), no output cap unless one is configured, and no rlimit. Output streams to
 *  disk and is read back in bounded pages; a log is sealed without holding it in memory. When a cap or a failed log
 *  write keeps less than the command wrote, the result says how much of how much and why, and never calls it the whole
 *  output. Restrictions chosen for a Full access command (read-only, read-access roots, the network off) are held on
 *  the host and nothing else of the sandbox's is added. A restriction the runtime cannot be shown to hold refuses the
 *  command. Checks follow their session's access, and the sandbox when no session is bound.
 *
 *  Every host here is a fixture's: its own HOME, ZDOTDIR and TMPDIR (harness.fixtureHostEnvironment), never the
 *  person's. RecordingRuntime is NOT an OS sandbox. It records the restrictions and the argv, then runs the command as
 *  it is. These tests prove routing, environment, records and reporting only. The profile text and the OS enforcement
 *  are tests/test_host_profile.test.ts. This file imports only what the build before it had, so the same file runs
 *  against that build and its failures there are assertions, never a missing module. */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CheckConfigSchema } from '@oasis-code/contract'
import { executeCommand } from '../src/agent/tools/commands.ts'
import { loadConfig } from '../src/config.ts'
import * as repo from '../src/db/repo.ts'
import type { HostRestrictions, IsolationReport, Sandbox } from '../src/execution/isolation.ts'
import { ProcessManager } from '../src/execution/processes.ts'
import { withRequestCap } from '../src/policy/access.ts'
import { runChecks } from '../src/verify/checks.ts'
import { PathPolicy } from '../src/workspace/paths.ts'
import { workspaceAttached } from '../src/workspace/service.ts'
import { buggyRepo, domainState, FAKE_FULL, PassthroughRuntime, sleep, useFixtureHost, type DomainState } from './harness.ts'
import { tempDir } from './helpers.ts'

type Rec = Record<string, unknown>
const MiB = 1024 * 1024

/** Not an OS sandbox: records what it is given and runs the command as it is (the routing, never the enforcement). */
class RecordingRuntime extends PassthroughRuntime {
  readonly restrictions: HostRestrictions[] = []
  readonly argvs: string[][] = []
  readonly boxes: Sandbox[] = []
  override command(argv: string[], box: Sandbox, profile: string): string[] { this.boxes.push(box); return super.command(argv, box, profile) }
  hostCommand(argv: string[], restrictions: HostRestrictions, profilePath: string): string[] {
    writeFileSync(profilePath, ';; recorded, not applied\n')
    this.restrictions.push(restrictions)
    this.argvs.push([...argv])
    return argv
  }
}

let state: DomainState
beforeEach(() => { state = domainState() })
afterEach(async () => { await state.close() })

async function workspaceOf(st: DomainState = state) {
  const project = await st.workspaces.importProject('calc', buggyRepo())
  const session = repo.createSession(st.conn, project.id, 't', 'scripted:a')
  const ws = await st.workspaces.createWorkspace(project, session.id)
  repo.setSessionWorkspace(st.conn, session.id, ws.id)
  return { project, session, ws }
}

async function full(command: string, extra: Rec = {}, st: DomainState = state) {
  const { project, ws } = await workspaceOf(st)
  const x = await st.processes.start({ command, cwd: ws.path, project_id: project.id, workspace_id: ws.id, access: 'full', ...extra })
  await st.processes.wait(x.id, 60)
  return { x, summary: st.processes.summary(x.id), project, ws }
}

// ---- deadlines ----------------------------------------------------------------------------------------------------

test('a Full access command has no deadline of its own: with the clock an hour on it still runs; the ProcessManager default (any caller: a check, the API) is none too', async () => {
  const { project, ws } = await workspaceOf()
  const x = await state.processes.start({ command: 'sleep 30', cwd: ws.path, project_id: project.id, workspace_id: ws.id, access: 'full' })
  expect((x.isolation as Rec).timeout_s).toBeNull()
  const realNow = performance.now.bind(performance)
  try {
    // the watch reads the monotonic clock (performance.now): an hour later than the start, past any 600 s default
    performance.now = () => realNow() + 3_600_000
    await sleep(400)
    expect(state.processes.isRunning(x.id)).toBe(true)
  } finally {
    performance.now = realNow
  }
  const running = state.processes.summary(x.id)
  expect(running.restrictions).toMatchObject({ environment: 'host', enforced_by: 'none', timeout_s: null, timeout_source: null, output_cap_bytes: null, resource_limits: null })
  expect(running.timeout_s).toBeNull()
  // stopped by request: said so, and its group killed
  expect(state.processes.stop(x.id)).toBe(true)
  await state.processes.wait(x.id, 10)
  const stopped = state.processes.summary(x.id)
  expect(stopped.status).toBe('cancelled')
  expect(stopped.stop_reason).toMatchObject({ code: 'stopped' })
})

test('the sandbox keeps its own defaults (600 s, 8 MiB, the rlimits), said as the sandbox\'s', async () => {
  const { project, ws } = await workspaceOf()
  const box: Sandbox = { writable: [ws.path], write_deny: [], read_deny: [], read_allow: [ws.path], network: false }
  const x = await state.processes.start({ command: 'true', cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id })
  await state.processes.wait(x.id, 30)
  const s = state.processes.summary(x.id)
  expect(s.timeout_s).toBe(600)
  expect(s.restrictions).toMatchObject({ environment: 'sandbox', network: 'denied', filesystem: 'sandbox', timeout_s: 600, timeout_source: 'default', output_cap_bytes: 8 * MiB })
  expect((s.restrictions as Rec).resource_limits).toMatchObject({ cpu_seconds: 3600, open_files: 1024, file_size_bytes: 2 * 1024 ** 3 })
})

test('an explicit timeout still stops a Full access command, its group and what it started, with the reason said', async () => {
  const { summary } = await full('sleep 60 & echo "child=$!"; wait', { timeout_s: 1, timeout_source: 'call' })
  expect(summary.timed_out).toBe(true)
  expect(summary.status).toBe('timeout')
  expect(summary.stop_reason).toMatchObject({ code: 'timeout' })
  expect(String((summary.stop_reason as Rec).detail)).toContain('deadline of 1 s (set by this call)')
  expect(String((summary.stop_reason as Rec).detail)).toContain('SIGKILL')
  const child = Number(/child=(\d+)/.exec(String(summary.stdout))?.[1])
  expect(child).toBeGreaterThan(1)
  let alive = true
  for (let i = 0; i < 40 && alive; i += 1) { try { process.kill(child, 0); await sleep(50) } catch { alive = false } }
  expect(alive).toBe(false)
})

// ---- output: on disk, paged, honest ---------------------------------------------------------------------------------

test('Full access keeps the whole output on disk with no cap (9 MiB past the old 8 MiB), read back in pages of at most 1 MiB', async () => {
  const { x, summary } = await full(`head -c ${9 * MiB} /dev/zero | tr '\\0' 'a'`)
  expect(summary.status, JSON.stringify(summary)).toBe('succeeded')
  expect(summary.stdout_bytes).toBe(9 * MiB)
  expect(summary.stdout_total_bytes).toBe(9 * MiB)
  expect(summary.output_complete).toBe(true)
  expect(summary.truncated_at_cap).toBe(false)
  expect(summary.output_cap_bytes).toBeNull()
  expect(String(summary.note)).toContain('The whole output is kept')                 // true here, and only here
  const page = state.processes.readOutput(x.id, 'stdout', 0, 10 * MiB)
  expect(page.returned_bytes).toBe(MiB)                                              // a page, never the whole
  const tail = state.processes.readOutput(x.id, 'stdout', 9 * MiB - 10, 100) as Rec
  expect([tail.returned_bytes, tail.eof, tail.text, tail.command_total_bytes, tail.dropped_bytes]).toEqual([10, true, 'a'.repeat(10), 9 * MiB, 0])
  const asset = repo.getAsset(state.conn, repo.getExecution(state.conn, x.id)!.stdout_asset_id!)!
  expect(asset.byte_size).toBe(9 * MiB)
})

test('a retention cap (configured for Full access, or the sandbox\'s) says what it kept of what was written and never calls it the whole output', async () => {
  const { x, summary } = await full(`head -c 100000 /dev/zero | tr '\\0' 'b'`, { output_cap_bytes: 40_000 })
  expect(summary.stdout_bytes).toBe(40_000)
  expect(summary.stdout_total_bytes).toBe(100_000)
  expect(summary.output_complete).toBe(false)
  expect(summary.truncated_at_cap).toBe(true)
  expect(summary.stdout_shown).toBe('preview')
  const note = String(summary.note)
  expect(note).toContain('stdout kept the first 40,000 of 100,000 bytes written (the output cap of 40,000 bytes); the rest was not kept')
  expect(note).not.toContain('whole output')
  const window = state.processes.readOutput(x.id, 'stdout', 0, 10) as Rec
  expect([window.total_bytes, window.command_total_bytes, window.dropped_bytes]).toEqual([40_000, 100_000, 60_000])
  // the sandbox's own cap reads the same
  const { project, ws } = await workspaceOf()
  const box: Sandbox = { writable: [ws.path], write_deny: [], read_deny: [], read_allow: [ws.path], network: false }
  const boxed = await state.processes.start({ command: `head -c 100000 /dev/zero | tr '\\0' 'c'`, cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id, output_cap_bytes: 40_000 })
  await state.processes.wait(boxed.id, 30)
  const sandboxed = state.processes.summary(boxed.id)
  expect(String(sandboxed.note)).not.toContain('whole output')
  expect(String(sandboxed.note)).toContain('kept the first 40,000 of 100,000 bytes written')
  expect(sandboxed.output_complete).toBe(false)
})

test('a log that cannot be written (a full disk) ends the command as it ends and says what was not kept; nothing waits on it', async () => {
  const real = state.processes.logWrite
  state.processes.logWrite = () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }) }
  let summary: Rec
  try {
    ;({ summary } = await full('echo hello; echo oops >&2'))
  } finally {
    state.processes.logWrite = real
  }
  expect(summary.status).toBe('succeeded')
  expect(summary.running).toBe(false)
  expect(summary.output_complete).toBe(false)
  expect(summary.stdout_total_bytes).toBe(6)
  expect(summary.stdout_bytes).toBe(0)
  expect(String(summary.note)).toContain('stdout kept the first 0 of 6 bytes written (its log could not be written)')
  expect(String(summary.note)).not.toContain('whole output')
})

test('a large log is sealed without being held in memory, and a sealed log is read back by range, never whole', async () => {
  const save = state.store.save.bind(state.store)
  state.store.save = ((conn, projectId, kind, data, opts) => {
    if (typeof data !== 'string' && data.length > MiB) throw new Error(`a whole ${data.length}-byte log held in memory`)
    return save(conn, projectId, kind, data, opts)
  }) as typeof state.store.save
  const { x } = await full(`head -c ${3 * MiB} /dev/zero | tr '\\0' 'c'`)
  const row = repo.getExecution(state.conn, x.id)!
  expect(row.stdout_asset_id).toBeTruthy()
  const asset = repo.getAsset(state.conn, row.stdout_asset_id!)!
  expect(asset.byte_size).toBe(3 * MiB)
  const logPath = join(state.settings.logs_dir, `${x.id}.stdout`)
  expect(asset.sha256).toBe(createHash('sha256').update(readFileSync(logPath)).digest('hex'))
  // the log file gone: the asset answers, a page of it
  rmSync(logPath)
  state.store.read = () => { throw new Error('the whole asset read') }
  const tail = state.processes.readOutput(x.id, 'stdout', 3 * MiB - 5, 100)
  expect([tail.returned_bytes, tail.text, tail.eof, tail.total_bytes]).toEqual([5, 'ccccc', true, 3 * MiB])
})

// ---- restrictions chosen for a Full access command ------------------------------------------------------------------

function recordingState(report: IsolationReport = { ...FAKE_FULL, runtime: 'recording' }): { st: DomainState; runtime: RecordingRuntime } {
  const st = domainState()
  const runtime = new RecordingRuntime()
  ;(st as { processes: ProcessManager }).processes = useFixtureHost(new ProcessManager(st.settings, st.conn, st.store, runtime, report))
  return { st, runtime }
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

test('read_only with Full access: the OS denies writes to the working folder, its Git metadata and the session\'s folders, on the host, with the user\'s environment and nothing else of the sandbox\'s', async () => {
  const { st, runtime } = recordingState()
  try {
    const extra = tempDir('oasis-root-')
    const { payload, ws } = await execute(st, { read_only: true, roots: [{ path: extra, access: 'write' }], command: 'echo "home=$HOME locks=$GIT_OPTIONAL_LOCKS"' })
    expect(payload.status, JSON.stringify(payload)).toBe('succeeded')
    expect(runtime.restrictions).toHaveLength(1)                                   // handed to the OS runtime, not ignored
    expect(payload.requested_access).toBe('full')
    expect(payload.effective_access).toBe('full')
    expect(((payload.access_reasons ?? []) as Rec[]).map((r) => r.code)).toEqual(['read_only'])
    const restrictions = payload.restrictions as Rec
    expect(restrictions).toMatchObject({ environment: 'host', enforced_by: 'passthrough', network: 'allowed', filesystem: 'restricted', resource_limits: null, timeout_s: null })
    const denied = restrictions.write_denied as string[]
    const real = (p: string) => realpathSync(p)
    expect(denied).toContain(real(ws.path))
    expect(denied).toContain(real(extra))
    // the shell is the user's, unwrapped: no ulimit prelude, no box of the sandbox's; only the write denies
    expect(runtime.argvs[0]!.slice(1, 4)).toEqual(['-l', '-i', '-c'])
    expect(runtime.boxes).toHaveLength(0)
    const held = runtime.restrictions[0]!
    expect(held.network).toBe(true)
    expect(held.bounds ?? null).toBeNull()
    expect(held.write_deny.map((p) => realpathSync(p))).toEqual(expect.arrayContaining([real(ws.path), real(extra), join(real(ws.path), '.git')]))
    expect(String(payload.stdout)).toContain(`home=${st.processes.hostEnvironment().HOME} locks=0`)
    // it noted no write of the working folder (a checkpoint has nothing of it to look for)
    expect((st.workspaces as unknown as { live: Map<string, { writes_since_snapshot: number }> }).live.get(ws.id)?.writes_since_snapshot ?? 0).toBe(0)
  } finally {
    await st.close()
  }
})

test('a folder the session holds with read access is denied writes with Full access too; one with write access is not', async () => {
  const { st, runtime } = recordingState()
  try {
    const readable = tempDir('oasis-ro-')
    const writable = tempDir('oasis-rw-')
    const { payload } = await execute(st, { roots: [{ path: readable, access: 'read' }, { path: writable, access: 'write' }] })
    expect(payload.status).toBe('succeeded')
    expect(runtime.restrictions).toHaveLength(1)
    expect(((payload.access_reasons ?? []) as Rec[]).map((r) => r.code)).toEqual(['read_only_root'])
    const real = (p: string) => realpathSync(p)
    expect((payload.restrictions as Rec).write_denied).toEqual([real(readable)])
    expect(runtime.restrictions[0]!.write_deny).toEqual([readable])
  } finally {
    await st.close()
  }
})

test('read_only in the sandbox: the order bound read-only and the session\'s folders denied, never guessed from the command', async () => {
  const { st, runtime } = recordingState()
  try {
    const root = tempDir('oasis-root-')
    const { payload } = await execute(st, { read_only: true, roots: [{ path: root, access: 'write' }], decide: () => ({ network: false, access: 'sandbox' }) })
    expect(payload.status).toBe('succeeded')
    expect(payload.effective_access).toBe('sandbox')
    const box = runtime.boxes[0]!
    expect(box.bounds?.read_only).toBe(true)
    expect(box.write_deny).toContain(root)
    expect(box.writable).not.toContain(root)
    expect((payload.restrictions as Rec).order_bounds).toMatchObject({ read_only: true })
  } finally {
    await st.close()
  }
})

test('a restriction the runtime cannot hold refuses the command: no fallback to the unrestricted host or the whole sandbox', async () => {
  // the passthrough runtime has no host profile at all
  const plain = await execute(state, { read_only: true })
  expect(plain.payload).toMatchObject({ status: 'refused', code: 'restriction_unavailable', isolation: 'unavailable', effective_access: 'full', restrictions: null })
  expect(((plain.payload.access_reasons ?? []) as Rec[]).map((r) => r.code)).toEqual(['read_only', 'restriction_unavailable'])
  expect(repo.listExecutions(state.conn, { workspace_id: plain.ws.id })).toHaveLength(0)
  // a runtime whose probe did not verify the network denial: the network off is refused, not dropped
  const { st } = recordingState({ ...FAKE_FULL, runtime: 'recording', network_isolation: false })
  try {
    const offline = await execute(st, { decide: () => ({ network: false, access: 'full' }) })
    expect(offline.payload).toMatchObject({ status: 'refused', code: 'restriction_unavailable' })
    expect(String(offline.payload.reason)).toContain('the network denial')
    expect(repo.listExecutions(st.conn, { workspace_id: offline.ws.id })).toHaveLength(0)
  } finally {
    await st.close()
  }
})

test('the network off with Full access: denied on the host by the profile, the user\'s HOME, SSH_AUTH_SOCK, uid and git as before; the profile removed once it ends', async () => {
  const { st, runtime } = recordingState()
  try {
    const host = st.processes.hostEnvironment()
    const sock = join(String(host.HOME), 'agent.sock')
    st.processes.hostEnvironment = () => ({ ...host, SSH_AUTH_SOCK: sock })
    const command = 'echo "home=$HOME sock=$SSH_AUTH_SOCK uid=$(id -u)"; git init -q g && cd g && git -c user.email=a@b -c user.name=n commit --allow-empty -qm one && git branch side && git branch --list'
    const { payload } = await execute(st, { command, decide: () => ({ network: false, access: 'full', requested_access: 'full' }) })
    expect(payload.status, JSON.stringify(payload)).toBe('succeeded')
    expect(String(payload.stdout)).toContain(`home=${host.HOME} sock=${sock} uid=${process.getuid!()}`)
    expect(String(payload.stdout)).toContain('side')
    expect(payload).toMatchObject({ effective_access: 'full', network: false, isolation: 'restricted' })
    expect(((payload.access_reasons ?? []) as Rec[]).map((r) => r.code)).toEqual(['network_off'])
    expect(payload.restrictions).toMatchObject({ environment: 'host', network: 'denied', filesystem: 'none', write_denied: [], resource_limits: null })
    expect(runtime.restrictions[0]).toMatchObject({ network: false, write_deny: [] })
    const profiles = join(st.settings.scratch_dir, 'host-profiles')
    expect(existsSync(profiles) ? readdirSync(profiles) : []).toEqual([])            // written for it, removed once it ended
  } finally {
    await st.close()
  }
})

test('the configured Full access deadline and retention cap: parsed from config.json, applied through executeCommand, said as the config\'s; a call\'s timeout_s wins; the sandbox keeps command_timeout_s', async () => {
  const path = join(tempDir('oasis-config-'), 'config.json')
  writeFileSync(path, JSON.stringify({ full_access_command_timeout_s: 7, full_access_output_cap_bytes: 5000 }))
  const parsed = loadConfig(path)
  expect([parsed.full_access_command_timeout_s, parsed.full_access_output_cap_bytes, parsed.command_timeout_s]).toEqual([7, 5000, 600])
  const st = state
  ;(st as { config: typeof parsed }).config = { ...st.config, full_access_command_timeout_s: 7, full_access_output_cap_bytes: 5000 }
  const capped = await execute(st, { command: `head -c 20000 /dev/zero | tr '\\0' 'd'` })
  expect(capped.payload.restrictions).toMatchObject({ environment: 'host', timeout_s: 7, timeout_source: 'config', output_cap_bytes: 5000 })
  expect([capped.payload.stdout_bytes, capped.payload.stdout_total_bytes, capped.payload.output_complete]).toEqual([5000, 20000, false])
  const given = await execute(st, { command: 'true', timeout_s: 3 })
  expect(given.payload.restrictions).toMatchObject({ timeout_s: 3, timeout_source: 'call' })
  // with nothing configured for Full access: none at all
  ;(st as { config: typeof parsed }).config = { ...st.config, full_access_command_timeout_s: null, full_access_output_cap_bytes: null }
  const open = await execute(st, { command: 'true' })
  expect(open.payload.restrictions).toMatchObject({ timeout_s: null, timeout_source: null, output_cap_bytes: null })
  // the sandbox's own: the configured command limit and cap
  const boxed = await execute(st, { command: 'true', decide: () => ({ network: false, access: 'sandbox' }) })
  expect(boxed.payload.restrictions).toMatchObject({ environment: 'sandbox', timeout_s: 600, timeout_source: 'config', output_cap_bytes: 8 * MiB })
})

// ---- checks ----------------------------------------------------------------------------------------------------------

test('checks follow their session\'s access: on the host for a Full session, in the sandbox for a sandboxed one, a capped request or none bound', async () => {
  const { project, session, ws } = await workspaceOf()
  repo.setSessionAccess(state.conn, session.id, 'full')
  const check = CheckConfigSchema.parse({ id: 'where', command: 'echo "home=$HOME"', parser: 'exit_code', timeout_s: 30 })
  const cp = await state.workspaces.checkpoint(ws, null, 'to check')
  const [onHost] = await runChecks(state.conn, state.workspaces, state.processes, project, cp, { checks: [check] })
  expect(onHost!.status).toBe('pass')
  const hosted = repo.listExecutions(state.conn, { workspace_id: ws.id }).filter((x) => x.kind === 'check')
  expect(hosted.map((x) => (x.isolation as Rec).runtime)).toEqual(['host'])
  expect(hosted[0]!.isolation).toMatchObject({ effective_access: 'full', timeout_s: 30, timeout_source: 'check' })
  expect(state.processes.readOutput(hosted[0]!.id, 'stdout').text).toContain(`home=${state.processes.hostEnvironment().HOME}`)
  // a request capped to the sandbox (a director surface v1–v5): the sandbox, said
  await withRequestCap('sandbox', () => runChecks(state.conn, state.workspaces, state.processes, project, cp, { checks: [check] }))
  const capped = repo.listExecutions(state.conn, { workspace_id: ws.id }).filter((x) => x.kind === 'check').at(-1)!
  expect(capped.isolation).toMatchObject({ runtime: 'passthrough', effective_access: 'sandbox' })
  expect(((capped.isolation as Rec).access_reasons as Rec[]).map((r) => r.code)).toEqual(['request_cap'])
  // the session moved to the sandbox: its checks too
  repo.setSessionAccess(state.conn, session.id, 'sandbox')
  await runChecks(state.conn, state.workspaces, state.processes, project, cp, { checks: [check] })
  expect((repo.listExecutions(state.conn, { workspace_id: ws.id }).filter((x) => x.kind === 'check').at(-1)!.isolation as Rec).runtime).toBe('passthrough')
  // no session bound: the sandbox, never Full by default, and said
  const orphan = await state.workspaces.createWorkspace(project, null)
  const orphanCp = await state.workspaces.checkpoint(orphan, null, 'no session')
  await runChecks(state.conn, state.workspaces, state.processes, project, orphanCp, { checks: [check] })
  const unbound = repo.listExecutions(state.conn, { workspace_id: orphan.id }).filter((x) => x.kind === 'check').at(-1)!
  expect(unbound.isolation).toMatchObject({ runtime: 'passthrough', effective_access: 'sandbox' })
  expect(((unbound.isolation as Rec).access_reasons as Rec[]).map((r) => r.code)).toEqual(['no_session'])
})
