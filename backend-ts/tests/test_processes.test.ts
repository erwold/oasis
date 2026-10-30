/** The process manager's own mechanics, runtime aside: a process group dies as a whole on timeout and on stop, the
 *  output is capped and paged (never lost), secrets never reach the child's environment, the resource limits hold
 *  in the shell's own unit and a limit the shell refuses leaves the command unrun, and a lost process is recorded as
 *  such. The OS confinement itself is what test_isolation_probe and test_order_bounds verify on macOS. */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as repo from '../src/db/repo.ts'
import { DEFAULT_LIMITS, IsolationUnavailable, LIMITS_REFUSED_EXIT, scrubbedEnv, unavailable, type Sandbox } from '../src/execution/isolation.ts'
import { ProcessManager, strayProcesses, toolchainEnv } from '../src/execution/processes.ts'
import { buggyRepo, domainState, PassthroughRuntime, sleep, type DomainState } from './harness.ts'
import { tempDir } from './helpers.ts'
import { killOwned, newNonce, ownsPid, publishPid, readPid } from './owned_pids.ts'

let state: DomainState
beforeEach(() => { state = domainState() })
afterEach(async () => { await state.close() })

async function env() {
  const project = await state.workspaces.importProject('calc', buggyRepo())
  const session = repo.createSession(state.conn, project.id, 't', 'scripted:a')
  const ws = await state.workspaces.createWorkspace(project, session.id)
  const box: Sandbox = { writable: [ws.path], write_deny: [], read_deny: [], read_allow: [ws.path], network: false }
  return { project, ws, box }
}

async function run(command: string, extra: Record<string, unknown> = {}) {
  const { project, ws, box } = await env()
  const x = await state.processes.start({ command, cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id, ...extra })
  await state.processes.wait(x.id, ((extra.timeout_s as number) ?? 60) + 5)
  return state.processes.summary(x.id)
}

test('a timeout kills the whole process group', async () => {
  const r = await run("sh -c 'sleep 30 & echo CHILD=$! ; echo $$ > pgid.txt; wait'", { timeout_s: 2 })
  expect(r.timed_out).toBe(true)
  expect(r.status).toBe('timeout')
  const x = repo.getExecution(state.conn, r.execution_id as string)!
  expect(x.effect_state).toBe('applied')
  expect(x.exit_code).not.toBeNull()
  const child = Number.parseInt((r.stdout as string).split('CHILD=')[1]!.split(/\s/)[0]!, 10)
  await sleep(300)
  expect(deadOrZombie(child)).toBe(true)
})

/** Gone, or killed and waiting for a PID 1 that does not reap (a container's): either way not running. */
function deadOrZombie(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`not a process id: ${pid}`)
  try { process.kill(pid, 0) } catch { return true }
  if (process.platform === 'linux') {
    try { return /^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8')) } catch { return true }
  }
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  return stat === '' || stat.startsWith('Z')
}

test('stop, the output cap and paging', async () => {
  const { project, ws, box } = await env()
  const x = await state.processes.start({
    command: 'python3 -c "import sys\nfor i in range(200000): print(\'line\', i)\nsys.stdout.flush()"; sleep 20',
    cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id, timeout_s: 60, output_cap_bytes: 20000,
  })
  for (let i = 0; i < 100; i += 1) {
    await sleep(50)
    if (state.processes.readOutput(x.id, 'stdout', 0, 10).total_bytes >= 20000) break
  }
  const page = state.processes.readOutput(x.id, 'stdout', 0, 100)
  expect(page.running).toBe(true)
  expect(page.returned_bytes).toBe(100)
  expect(page.text).toStartWith('line 0')
  expect(state.processes.stop(x.id)).toBe(true)
  await state.processes.wait(x.id, 10)
  const summary = state.processes.summary(x.id)
  expect(summary.status).toBe('cancelled')
  expect(summary.cancelled).toBe(true)
  expect(summary.truncated_at_cap).toBe(true)
  expect(summary.stdout_bytes).toBe(20000)
  expect(summary.stdout_shown).toBe('whole')                                      // 20,000 characters: under the 30,000 shown whole
  // the log survives as an asset and pages to the end
  const tail = state.processes.readOutput(x.id, 'stdout', 19990, 100)
  expect(tail.eof).toBe(true)
  expect(tail.returned_bytes).toBe(10)
  const row = repo.getExecution(state.conn, x.id)!
  expect(row.stdout_asset_id).toBeTruthy()
  expect(state.store.read(repo.getAsset(state.conn, row.stdout_asset_id!)!.storage_path).subarray(0, 6).toString()).toBe('line 0')
})

test('secrets never reach the child environment', async () => {
  process.env.OASIS_TEST_KEY_A = 'sk-should-not-leak'
  process.env.SOME_TOKEN = 'leak'
  process.env.HARMLESS = 'fine'
  try {
    const r = await run('env', { env_passthrough: ['PATH', 'HARMLESS', 'SOME_TOKEN', 'OASIS_TEST_KEY_A'] })
    expect(r.stdout as string).toContain('HARMLESS=fine')
    expect(r.stdout as string).not.toContain('sk-should-not-leak')
    expect(r.stdout as string).not.toContain('SOME_TOKEN')
    expect(r.stdout as string).toContain('HOME=')
    const wsId = repo.getExecution(state.conn, r.execution_id as string)!.workspace_id!
    expect(r.stdout as string).toContain(`HOME=${state.processes.homeFor(wsId, '')}`)       // its own HOME, in the workspace's sandbox folder
    expect(r.stdout as string).toContain(`TMPDIR=${state.processes.tempFor(wsId, '')}`)
    expect(scrubbedEnv(['PATH', 'MY_PASSWORD'], { X: '1' }).MY_PASSWORD).toBeUndefined()
  } finally {
    delete process.env.OASIS_TEST_KEY_A
    delete process.env.SOME_TOKEN
    delete process.env.HARMLESS
  }
})

test('a workspace write lands, the exit code and the streams are recorded', async () => {
  const r = await run('echo ok > inside.txt && echo INSIDE_OK && echo warn >&2 && exit 3')
  expect(r.status).toBe('failed')
  expect(r.exit_code).toBe(3)
  expect(r.stdout as string).toContain('INSIDE_OK')
  expect(r.stderr as string).toContain('warn')
  const x = repo.getExecution(state.conn, r.execution_id as string)!
  expect(x.stderr_asset_id).toBeTruthy()
  expect(existsSync(x.cwd + '/inside.txt')).toBe(true)
  expect(x.isolation).toMatchObject({ runtime: 'passthrough', enforcement: 'full' })
})

test('a resource limit the shell refuses stops the command before any of it runs', async () => {
  const { project, ws, box } = await env()
  const broken = new ProcessManager(state.settings, state.conn, state.store, new PassthroughRuntime(), state.isolation, { ...DEFAULT_LIMITS, cpu_seconds: -1 })
  const x = await broken.start({ command: 'echo PAYLOAD_RAN > ran.txt; echo cpu=$(ulimit -t)', cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id })
  await broken.wait(x.id, 30)
  const r = broken.summary(x.id)
  expect(r.status).toBe('failed')
  expect(r.exit_code).toBe(LIMITS_REFUSED_EXIT)
  expect(r.stdout).toBe('')
  expect(r.stderr as string).toContain('ulimit')                                                  // the shell's own reason
  expect(r.stderr as string).toContain('the resource limits could not be applied; the command did not run')
  expect(existsSync(join(ws.path, 'ran.txt'))).toBe(false)
})

test('the file size limit holds in the shell\'s unit: 1024 bytes asked, at most 1024 written', async () => {
  const { project, ws, box } = await env()
  const capped = new ProcessManager(state.settings, state.conn, state.store, new PassthroughRuntime(), state.isolation, { ...DEFAULT_LIMITS, file_size_bytes: 1024 })
  const x = await capped.start({ command: 'head -c 4096 /dev/zero > big.bin && echo AFTER', cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id })
  await capped.wait(x.id, 30)
  const r = capped.summary(x.id)
  expect(r.status).toBe('failed')                                                                  // the writer was killed at the limit (SIGXFSZ)
  expect(r.stdout as string).not.toContain('AFTER')
  const size = statSync(join(ws.path, 'big.bin')).size
  expect(size).toBeGreaterThan(0)
  expect(size).toBeLessThanOrEqual(1024)
  // the limits at their defaults leave an ordinary command alone
  const fine = await run('head -c 4096 /dev/zero > fine.bin && wc -c < fine.bin')
  expect(fine.status).toBe('succeeded')
  expect((fine.stdout as string).trim()).toBe('4096')
})

/** A command that forks a child which leaves the process group (setsid) and keeps writing: with the parent
 *  waiting, then with the parent exiting first. Returns how many bytes the child wrote after the execution ended. */
async function escapedChild(opts: { parentExits: boolean; stop: boolean }) {
  const { project, ws, box } = await env()
  const nonce = newNonce()
  writeFileSync(join(ws.path, 'lifetime.py'), [
    'import os, sys, time', 'pid = os.fork()', 'if pid == 0:', '    os.setsid()', "    dev = os.open('/dev/null', os.O_RDWR)", '    for fd in (0, 1, 2): os.dup2(dev, fd)',
    `    ${publishPid(join(ws.path, 'child.pid'), nonce)}`, '    until = time.monotonic() + 4', '    while time.monotonic() < until:',
    "        with open('heartbeats', 'a') as f: f.write('tick\\n')", '        time.sleep(0.05)', '    os._exit(0)', 'else:', opts.parentExits ? '    os._exit(0)' : '    time.sleep(8)', '',
  ].join('\n'))
  const x = await state.processes.start({ command: `python3 lifetime.py ${nonce}`, cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id, timeout_s: 10 })
  const heartbeat = join(ws.path, 'heartbeats')
  const child = await readPid(join(ws.path, 'child.pid'), nonce)
  expect(child).not.toBeNull()
  for (let i = 0; i < 200 && !existsSync(heartbeat); i += 1) await sleep(20)
  try {
    if (opts.stop) expect(state.processes.stop(x.id)).toBe(true)
    const done = await state.processes.wait(x.id, 5)
    const before = readFileSync(heartbeat, 'utf8').length
    await sleep(350)
    const after = readFileSync(heartbeat, 'utf8').length
    return { status: done?.status, late_bytes: after - before, child_alive: ownsPid(child, nonce), summary: state.processes.summary(x.id) }
  } finally {
    killOwned(child, nonce)
  }
}

test('a stop ends a child that left the process group: nothing of the command writes on after the execution ended', async () => {
  const r = await escapedChild({ parentExits: false, stop: true })
  expect(r.status).toBe('cancelled')
  expect(r.late_bytes).toBe(0)
  expect(r.child_alive).toBe(false)
  expect(r.summary.stray_processes_killed).toBeGreaterThanOrEqual(1)
  expect(String(r.summary.cleanup)).toContain('left running were stopped with it')
})

test('a parent that exits first takes its escaped child with it: the execution is recorded ended only then', async () => {
  const r = await escapedChild({ parentExits: true, stop: false })
  expect(r.status).toBe('succeeded')
  expect(r.late_bytes).toBe(0)
  expect(r.child_alive).toBe(false)
  expect(r.summary.stray_processes_killed).toBeGreaterThanOrEqual(1)
})

test.skipIf(process.platform !== 'darwin')('a child that left the group with a clean environment is found by the kernel lineage and stopped; a process the command did not start is left alone', async () => {
  const { project, ws, box } = await env()
  const nonce = newNonce()
  const bystander = spawn('sleep', ['30'], { stdio: 'ignore' })
  writeFileSync(join(ws.path, 'child.py'), `import os,sys,time\n${publishPid(join(ws.path, 'child.pid'), nonce)}\nt=time.monotonic()+4\nwhile time.monotonic()<t:\n    open('heartbeats','a').write('tick\\n')\n    time.sleep(0.05)\n`)
  writeFileSync(join(ws.path, 'parent.py'), `import os,subprocess,sys,time\nsubprocess.Popen([sys.executable,'child.py','${nonce}'],env={'PATH':'/usr/bin:/bin'},start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nd=time.monotonic()+2\nwhile not os.path.exists('heartbeats') and time.monotonic()<d: time.sleep(0.01)\nos._exit(0)\n`)
  const x = await state.processes.start({ command: `python3 parent.py ${nonce}`, cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id, timeout_s: 10 })
  const done = await state.processes.wait(x.id, 5)
  const child = await readPid(join(ws.path, 'child.pid'), nonce)
  expect(child).not.toBeNull()
  try {
    const before = readFileSync(join(ws.path, 'heartbeats'), 'utf8').length
    await sleep(350)
    expect(done?.status).toBe('succeeded')
    expect(readFileSync(join(ws.path, 'heartbeats'), 'utf8').length).toBe(before)
    expect(ownsPid(child, nonce)).toBe(false)
    expect(state.processes.summary(x.id).stray_processes_killed).toBe(1)
    expect(deadOrZombie(bystander.pid!)).toBe(false)                          // not of this command: untouched
  } finally {
    killOwned(child, nonce)
    bystander.kill('SIGKILL')                                                 // the test's own child, by its handle
  }
})

test('a command that leaves nothing behind is recorded without a cleanup line', async () => {
  const r = await run('echo clean')
  expect(r.stray_processes_killed).toBe(0)
  expect(r.cleanup).toBeUndefined()
})

test('pages of any byte size, read from 0 by next_offset, join into the exact text; a character cut by the cap reads as U+FFFD', async () => {
  const text = 'A中🙂B\n文🚀Z\n'
  const r = await run(`printf '${text}'`)
  for (const limit of [1, 2, 3, 5]) {
    let offset = 0
    let joined = ''
    for (let i = 0; i < 100; i += 1) {
      const page = state.processes.readOutput(r.execution_id as string, 'stdout', offset, limit)
      expect(page.returned_bytes).toBeLessThanOrEqual(limit)
      joined += page.text
      if (page.eof) break
      expect(page.next_offset).toBeGreaterThan(offset)
      offset = page.next_offset
    }
    expect(joined).toBe(text)
  }
  const capped = await run(`printf '${text}'`, { output_cap_bytes: 3 })          // 'A' and two of 中's three bytes
  expect(state.processes.readOutput(capped.execution_id as string, 'stdout', 0, 100).text).toBe('A\uFFFD')
})

test('nothing runs without full enforcement, and a lost process is marked at startup', async () => {
  const partial = new ProcessManager(state.settings, state.conn, state.store, new PassthroughRuntime(), unavailable('fake', 'not probed'))
  const { project, ws, box } = await env()
  await expect(partial.start({ command: 'true', cwd: ws.path, sandbox: box, project_id: project.id })).rejects.toThrow(IsolationUnavailable)
  // a row left running by a process that died
  const x = repo.insertExecution(state.conn, { run_id: null, workspace_id: ws.id, tool_call_id: null, kind: 'command', command: 'sleep', cwd: ws.path, isolation: {}, network: false })
  repo.startExecution(state.conn, x.id)
  expect(repo.markLostExecutions(state.conn)).toEqual([x.id])
  const lost = repo.getExecution(state.conn, x.id)!
  expect(lost.status).toBe('lost')
  expect(lost.effect_state).toBe('unknown')
})

test('an execution id is matched as a variable of a process\'s environment, never as text its arguments carry', async () => {
  const nonce = newNonce()
  const xid = `x_${nonce}`
  const path = process.env.PATH ?? '/usr/bin:/bin'
  const carrier = spawn('python3', ['-c', 'import time; time.sleep(30)', nonce], { stdio: 'ignore', env: { PATH: path, OASIS_CODE_EXECUTION_ID: xid } })
  const lookalike = spawn('python3', ['-c', 'import time; time.sleep(30)', `OASIS_CODE_EXECUTION_ID=${xid}`, nonce], { stdio: 'ignore', env: { PATH: path } })
  const longer = spawn('python3', ['-c', 'import time; time.sleep(30)', nonce], { stdio: 'ignore', env: { PATH: path, OASIS_CODE_EXECUTION_ID: `${xid}_2` } })
  try {
    await sleep(300)
    const found = strayProcesses([xid]).map((s) => s.pid)
    expect(found).toContain(carrier.pid!)
    expect(found).not.toContain(lookalike.pid!)
    expect(found).not.toContain(longer.pid!)
  } finally {
    for (const p of [carrier, lookalike, longer]) p.kill('SIGKILL')              // the test's own children, by their handles
  }
})

test("the model is shown Claude Code's limits, in characters: whole up to 30,000; past it a success's first 2,000 and where the rest is, a failure's head and tail of its first 30,000", async () => {
  // characters, not bytes: 30,000 three-byte characters come back whole
  const whole = await run(`python3 -c "import sys; sys.stdout.write('中'*30000)"`)
  expect([whole.stdout_shown, String(whole.stdout).length, whole.note]).toEqual(['whole', 30000, null])
  // a success past it: the first 2,000 characters and where the whole output is
  const big = await run(`python3 -c "import sys; sys.stdout.write('中'*2000 + '文'*40000)"`)
  expect(big.stdout_shown).toBe('preview')
  expect(big.stdout).toBe('中'.repeat(2000))
  expect(String(big.note)).toMatch(/^Output too large \(123\.0KB\)\. The whole output is kept: bash_output\(execution_id, stream, offset\) reads it\./)
  expect(big.stdout_bytes).toBe(42000 * 3)
  // a failure past it: 5,000 characters from each end of its first 30,000, nothing past them
  const failed = await run(`python3 -c "import sys; sys.stdout.write('a'*5000 + 'b'*20000 + 'c'*5000 + 'd'*9000); sys.exit(2)"`)
  expect(failed.stdout_shown).toBe('excerpt')
  expect(failed.stdout).toBe(`${'a'.repeat(5000)}\n…[middle elided]…\n${'c'.repeat(5000)}`)
  expect(failed.note).toBeNull()
  // an exit of 1 from diff says "they differ": no failure, the success's preview
  const file = join(tempDir('oasis-diff-'), 'long.txt')
  writeFileSync(file, `${'x'.repeat(40000)}\n`)
  const diff = await run(`diff /dev/null ${file}`)
  expect([diff.exit_code, diff.stdout_shown]).toEqual([1, 'preview'])
  // the same exit from another command is a failure
  const other = await run(`python3 -c "import sys; sys.stdout.write('y'*40000); sys.exit(1)"`)
  expect([other.exit_code, other.stdout_shown]).toEqual([1, 'excerpt'])
})

test('rustup reads the host\'s own toolchains and never installs one on its own', async () => {
  const home = tempDir('oasis-home-')
  expect(toolchainEnv({}, home)).toEqual({ RUSTUP_AUTO_INSTALL: '0' })
  mkdirSync(join(home, '.rustup'))
  expect(toolchainEnv({}, home)).toEqual({ RUSTUP_AUTO_INSTALL: '0', RUSTUP_HOME: join(home, '.rustup') })
  const elsewhere = tempDir('oasis-rustup-')
  expect(toolchainEnv({ RUSTUP_HOME: elsewhere }, home)).toEqual({ RUSTUP_AUTO_INSTALL: '0', RUSTUP_HOME: elsewhere })
  // what a command runs with
  const r = await run('echo "auto=$RUSTUP_AUTO_INSTALL"')
  expect(String(r.stdout)).toContain('auto=0')
})

const diskFull = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28, syscall: 'write' })

test('a full disk under a command its log: the command ends as it ends, its output marked cut, the harness up; the next command logs again', async () => {
  const real = state.processes.logWrite
  let refused = 0
  state.processes.logWrite = () => { refused += 1; throw diskFull() }
  const r = await run("sh -c 'for i in 1 2 3 4 5; do echo line$i; done; echo err >&2'")
  expect(r.status).toBe('succeeded')
  expect(r.exit_code).toBe(0)
  const x = repo.getExecution(state.conn, r.execution_id as string)!
  expect(x.truncated).toBe(true)
  expect(refused).toBe(2)                                          // one try a stream: its log stops being kept
  state.processes.logWrite = real
  const next = await run("sh -c 'echo again'")
  expect(next.status).toBe('succeeded')
  expect(String(next.stdout)).toContain('again')
})

test('a full disk when a finished command its log is kept: the command recorded as it ended, without the log', async () => {
  const save = state.store.save.bind(state.store)
  state.store.save = (() => { throw diskFull() }) as typeof state.store.save
  const r = await run("sh -c 'echo kept-not'")
  state.store.save = save
  expect(r.status).toBe('succeeded')
  const x = repo.getExecution(state.conn, r.execution_id as string)!
  expect(x.status).toBe('succeeded')
  expect(x.stdout_asset_id).toBeNull()
})
