/** The process manager's lineage tick: one reading of the kernel's process table serves every running command (the
 *  readings grow with the ticks, not with the commands), a command's end still reads a table of its own made after
 *  its process exited, no tick is left pending once the last command has exited, every reading that fails is the
 *  failure of exactly one command (the first waiting one it was made for: that watch alone fails on its own path, as
 *  when it read alone; the rest are read again and go on), and commands stopped or timed out side by side each take
 *  only what they made. Every assertion is on counts and on which processes live — none on how long anything took; a
 *  wait only waits for a condition (bounded, generous). macOS (the kernel lineage). */

import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as repo from '../src/db/repo.ts'
import type { Sandbox } from '../src/execution/isolation.ts'
import { identityOf, type ProcessIdentity } from '../src/execution/lineage.ts'
import type { ProcessManager } from '../src/execution/processes.ts'
import { buggyRepo, domainState, sleep, type DomainState } from './harness.ts'
import { killOwned, newNonce, ownsPid, publishPid, readPid } from './owned_pids.ts'

const darwin = process.platform === 'darwin'

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

type LiveView = { xid: string; exited: boolean; lineage: Set<bigint> }
interface TrackCall { xids: string[]; exited: boolean[]; reads: number; table_given: boolean; threw: boolean }

/** The manager's readings of the process table counted (its documented test seam), and every entry into its lineage
 *  reading recorded with the commands it was given and the readings it made — the manager's own private step,
 *  reached by cast as the fork watcher tests reach theirs. */
function observe(manager: ProcessManager) {
  const seen = { reads: 0, calls: [] as TrackCall[] }
  const read = manager.processIdentities
  manager.processIdentities = () => { seen.reads += 1; return read() }
  const steps = manager as unknown as { trackLineage: (lives: Iterable<LiveView>, table?: ProcessIdentity[]) => void; lineageTick: unknown }
  const track = steps.trackLineage.bind(manager)
  steps.trackLineage = (lives, table) => {
    const list = [...lives]
    const before = seen.reads
    const record = (threw: boolean) => seen.calls.push({ xids: list.map((l) => l.xid), exited: list.map((l) => l.exited), reads: seen.reads - before, table_given: table !== undefined, threw })
    try {
      track(list, table)
    } catch (error) {
      record(true)
      throw error
    }
    record(false)
  }
  return { seen, pending: () => steps.lineageTick !== null }
}

/** Waits for a condition, checking every 10 ms, at most `limitMs` (a bound for a hung run, never a measurement). */
async function until(condition: () => boolean, limitMs = 10_000): Promise<boolean> {
  for (const end = Date.now() + limitMs; Date.now() < end;) {
    if (condition()) return true
    await sleep(10)
  }
  return condition()
}

/** The fork watcher kept out (as when its thread did not start): what is found is the lineage tick's. */
function withoutForkWatcher(manager: ProcessManager): void {
  (manager as unknown as { forks: { state: string } }).forks.state = 'failed'
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join()

test.skipIf(!darwin)('five running commands are read from one table reading per tick; a stopped one reads a fresh table of its own after it exited; no tick is left once the last has exited', async () => {
  const { project, ws, box } = await env()
  const manager = state.processes
  const { seen, pending } = observe(manager)
  const xids: string[] = []
  for (let i = 0; i < 5; i += 1) xids.push((await manager.start({ command: 'sleep 30', cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id, timeout_s: 60 })).id)
  try {
    const tickOfAll = (c: TrackCall) => !c.table_given && sameSet(c.xids, xids)
    expect(await until(() => seen.calls.some(tickOfAll))).toBe(true)
    // a window of five ticks with all five running: each reads the table once, for all five, and nothing else reads it
    const fromCall = seen.calls.length, fromReads = seen.reads
    expect(await until(() => seen.calls.length - fromCall >= 5)).toBe(true)
    const window = seen.calls.slice(fromCall)
    const readsInWindow = seen.reads - fromReads
    expect(window.every(tickOfAll)).toBe(true)
    expect(window.every((c) => c.reads === 1)).toBe(true)
    expect(readsInWindow).toBe(window.length)
    expect(xids.every((x) => manager.isRunning(x))).toBe(true)

    // one stopped: its end reads a table made after its process exited, given to it alone
    const [stopped, ...others] = xids as [string, ...string[]]
    expect(manager.stop(stopped)).toBe(true)
    expect((await manager.wait(stopped, 10))?.status).toBe('cancelled')
    const ownEnd = seen.calls.findIndex((c) => sameSet(c.xids, [stopped]) && c.exited[0] === true && !c.table_given)
    expect(ownEnd).toBeGreaterThanOrEqual(0)
    expect(seen.calls[ownEnd]!.reads).toBe(1)
    // the tick goes on for the four others, never again for the stopped one
    const afterEnd = seen.calls.length
    expect(await until(() => seen.calls.slice(afterEnd).some((c) => !c.table_given && sameSet(c.xids, others)))).toBe(true)
    expect(seen.calls.slice(ownEnd + 1).filter((c) => !c.table_given && c.xids.length > 1).every((c) => !c.xids.includes(stopped))).toBe(true)
    expect(pending()).toBe(true)
  } finally {
    for (const x of xids) manager.stop(x)
    for (const x of xids) await manager.wait(x, 10)
  }
  // the last one exited: no tick pending, and none reads the table any more
  expect(xids.every((x) => !manager.isRunning(x))).toBe(true)
  expect(pending()).toBe(false)
  const reads = seen.reads
  await sleep(250)
  expect(seen.reads).toBe(reads)
  expect(pending()).toBe(false)
}, 30_000)

test.skipIf(!darwin)('the tick alone (no fork watcher) finds what a brief intermediate made, and the stop takes it after the intermediate is gone', async () => {
  const { project, ws, box } = await env()
  const manager = state.processes
  withoutForkWatcher(manager)
  observe(manager)
  const nonce = newNonce()
  writeFileSync(join(ws.path, 'child.py'), `import os,sys,time\n${publishPid(join(ws.path, 'child.pid'), nonce)}\nt=time.monotonic()+20\nwhile time.monotonic()<t: time.sleep(0.05)\n`)
  writeFileSync(join(ws.path, 'parent.py'), `import os,subprocess,sys,time\n${publishPid(join(ws.path, 'parent.pid'), nonce)}\nsubprocess.Popen([sys.executable,'child.py','${nonce}'],env={'PATH':'/usr/bin:/bin'},start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nd=time.monotonic()+20\nwhile not os.path.exists('go') and time.monotonic()<d: time.sleep(0.01)\nos._exit(0)\n`)
  const x = await manager.start({ command: `python3 parent.py ${nonce}; sleep 30`, cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id, timeout_s: 60 })
  const parent = await readPid(join(ws.path, 'parent.pid'), nonce)
  const child = await readPid(join(ws.path, 'child.pid'), nonce)
  expect(parent).not.toBeNull()
  expect(child).not.toBeNull()
  try {
    const childId = identityOf(child!)
    expect(childId).not.toBeNull()
    const live = manager.live.get(x.id) as unknown as LiveView
    // read into the command's lineage by the tick while the intermediate lives (the fork watcher is out)
    expect(await until(() => live.lineage.has(childId!.uniqueid))).toBe(true)
    writeFileSync(join(ws.path, 'go'), '')
    expect(await until(() => !ownsPid(parent, nonce))).toBe(true)
    expect(ownsPid(child, nonce)).toBe(true)
    expect(manager.stop(x.id)).toBe(true)
    expect((await manager.wait(x.id, 10))?.status).toBe('cancelled')
    expect(ownsPid(child, nonce)).toBe(false)
    expect(manager.summary(x.id).stray_processes_killed).toBeGreaterThanOrEqual(1)
  } finally {
    killOwned(child, nonce)
    killOwned(parent, nonce)
  }
}, 30_000)

test.skipIf(!darwin)('commands stopped and timed out side by side each take only what they made: the others\' and a bystander run on', async () => {
  const { project, ws, box } = await env()
  const manager = state.processes
  const bystander = spawn('sleep', ['30'], { stdio: 'ignore' })
  const names = ['stopped', 'timed', 'running'] as const
  const nonces = Object.fromEntries(names.map((n) => [n, newNonce()])) as Record<(typeof names)[number], string>
  const xids = {} as Record<(typeof names)[number], string>
  const children = {} as Record<(typeof names)[number], number | null>
  try {
    for (const name of names) {
      const nonce = nonces[name]
      // a child that leaves the group with a clean environment (only the kernel lineage finds it), its parent waiting on
      writeFileSync(join(ws.path, `${name}_child.py`), `import os,sys,time\n${publishPid(join(ws.path, `${name}.pid`), nonce)}\nt=time.monotonic()+25\nwhile time.monotonic()<t: time.sleep(0.05)\n`)
      writeFileSync(join(ws.path, `${name}_parent.py`), `import subprocess,sys,time\nsubprocess.Popen([sys.executable,'${name}_child.py','${nonce}'],env={'PATH':'/usr/bin:/bin'},start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\ntime.sleep(25)\n`)
      xids[name] = (await manager.start({ command: `python3 ${name}_parent.py ${nonce}`, cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id, timeout_s: name === 'timed' ? 2 : 60 })).id
    }
    for (const name of names) children[name] = await readPid(join(ws.path, `${name}.pid`), nonces[name])
    for (const name of names) expect(children[name]).not.toBeNull()

    expect(manager.stop(xids.stopped)).toBe(true)
    expect((await manager.wait(xids.stopped, 10))?.status).toBe('cancelled')
    expect(ownsPid(children.stopped, nonces.stopped)).toBe(false)
    expect(manager.isRunning(xids.running)).toBe(true)
    expect(ownsPid(children.running, nonces.running)).toBe(true)

    expect((await manager.wait(xids.timed, 15))?.status).toBe('timeout')
    expect(ownsPid(children.timed, nonces.timed)).toBe(false)
    expect(manager.isRunning(xids.running)).toBe(true)
    expect(ownsPid(children.running, nonces.running)).toBe(true)

    expect(manager.stop(xids.running)).toBe(true)
    expect((await manager.wait(xids.running, 10))?.status).toBe('cancelled')
    expect(ownsPid(children.running, nonces.running)).toBe(false)
    for (const name of names) expect(manager.summary(xids[name]).stray_processes_killed).toBeGreaterThanOrEqual(1)
    expect(bystander.exitCode).toBeNull()
    expect(bystander.signalCode).toBeNull()
  } finally {
    for (const name of names) if (xids[name]) manager.stop(xids[name])
    for (const name of names) killOwned(children[name] ?? null, nonces[name])
    bystander.kill('SIGKILL')                                                   // the test's own child, by its handle
  }
}, 45_000)

type Finishing = LiveView & { finished: boolean }

/** `count` quiet commands whose watches wait for the same ticks, and a reader that fails the next `failures` readings
 *  once one tick has read for all of them. */
async function onOneTick(count: number, failures: number) {
  const { project, ws, box } = await env()
  const manager = state.processes
  const { seen, pending } = observe(manager)
  const counted = manager.processIdentities
  let failing = 0
  manager.processIdentities = () => {
    if (failing > 0) { failing -= 1; throw new Error('injected reading failure') }
    return counted()
  }
  const xids: string[] = []
  for (let i = 0; i < count; i += 1) xids.push((await manager.start({ command: 'sleep 30', cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id, timeout_s: 60 })).id)
  expect(await until(() => seen.calls.some((c) => !c.table_given && sameSet(c.xids, xids)))).toBe(true)
  const from = seen.calls.length
  failing = failures
  const finishing = () => xids.filter((x) => (manager.live.get(x) as unknown as Finishing).finished)
  return { manager, seen, pending, xids, from, finishing, injected: () => failing === 0 }
}

/** Each failed reading went to exactly one command — the first of the commands it was read for — that command's watch
 *  failed on its own path (said once, its waiters let go, its process left as that path leaves it), every other one
 *  is read on, from one reading per tick, and no later reading is for a failed one. */
async function expectAttributed(failures: number) {
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  const { manager, seen, pending, xids, from, finishing, injected } = await onOneTick(3, failures)
  try {
    expect(await until(injected)).toBe(true)
    expect(await until(() => finishing().length === failures)).toBe(true)
    const lost = finishing()
    const kept = xids.filter((x) => !lost.includes(x))
    // the failed readings, in order: each made for the commands still unserved, failed for the first of them
    const threw = seen.calls.slice(from).filter((c) => c.threw)
    expect(threw.length).toBe(failures)
    expect(sameSet(threw.map((c) => c.xids[0]!), lost)).toBe(true)
    threw.forEach((c, i) => expect(c.xids.length).toBe(xids.length - i))
    // then one reading that succeeded served the rest
    const regrouped = seen.calls.slice(from).find((c) => !c.threw && !c.table_given)
    expect(regrouped !== undefined && sameSet(regrouped.xids, kept) && regrouped.reads === 1).toBe(true)
    for (const x of lost) {
      expect(errors.mock.calls.filter((args) => String(args[0]).includes(`${x}: its end could not be recorded (injected reading failure)`)).length).toBe(1)
      expect(manager.isRunning(x)).toBe(true)
    }
    for (const x of kept) {
      expect(errors.mock.calls.some((args) => String(args[0]).includes(`${x}: its end could not be recorded`))).toBe(false)
      expect(manager.isRunning(x)).toBe(true)
    }
    const after = seen.calls.length
    expect(await until(() => seen.calls.slice(after).filter((c) => !c.table_given && sameSet(c.xids, kept) && c.reads === 1).length >= 3)).toBe(true)
    expect(seen.calls.slice(after).some((c) => c.xids.some((x) => lost.includes(x)))).toBe(false)
    expect(finishing()).toEqual(lost)
  } finally {
    errors.mockRestore()
    for (const x of xids) manager.stop(x)                                       // a failed one too: its process group, by its handle
    for (const x of xids) await manager.wait(x, 10)
  }
  expect(await until(() => xids.every((x) => !manager.isRunning(x)))).toBe(true)
  expect(pending()).toBe(false)
}

test.skipIf(!darwin)('one shared reading that fails is one command\'s failure: exactly that watch fails on its own path, the two others go on, read from one reading per tick', async () => {
  await expectAttributed(1)
}, 30_000)

test.skipIf(!darwin)('a second failing reading for the rest is the next command\'s: exactly two watches fail, each on its own path, the third goes on', async () => {
  await expectAttributed(2)
}, 30_000)
