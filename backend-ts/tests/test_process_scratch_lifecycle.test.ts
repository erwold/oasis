/** A sandboxed command's scratch folder (its profile.sb, a workspace-less command's HOME and TMPDIR) is its own: two
 *  starts in the same millisecond once got one scratch path and one profile.sb between them (the name was the pid,
 *  the clock and the count of live entries, read before an await that the entry is made after). And a command that
 *  ended is let go: its scratch removed, its live entry dropped — once its process and whatever it left are gone and
 *  its logs are sealed — while its record, its output pages, its log assets and the workspace's own HOME and
 *  temporary folder stay. Only this test's own temporary data directory and workspaces are touched. */

import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as repo from '../src/db/repo.ts'
import { SeatbeltRuntime, type IsolationReport, type Sandbox } from '../src/execution/isolation.ts'
import { exitedAwaitingReap } from '../src/execution/processes.ts'
import { sandboxForWorkspace } from '../src/workspace/sandbox.ts'
import { buggyRepo, domainState, FAKE_FULL, sleep, useFixtureHost, type DomainState } from './harness.ts'

/** writes a profile per call as the Seatbelt runtime does, and records what each call wrote where */
class ProfileRuntime {
  readonly name = 'profile-recorder'
  writes: { profile: string; writable: string[] }[] = []
  fail: Error | null = null
  fingerprint() { return 'p' }
  command(argv: string[], box: Sandbox, profile: string) {
    if (this.fail) throw this.fail
    writeFileSync(profile, JSON.stringify(box.writable))
    this.writes.push({ profile, writable: box.writable })
    return argv
  }
  async probe() { return { ...FAKE_FULL, runtime: this.name } }
}

// real processes, a cold xcrun warm-up and a Seatbelt probe: on a loaded machine one start can take seconds, so this
// file's tests and hooks get room of their own (Bun's default is 5 s), nothing else's
const SLOW_MS = 60_000
setDefaultTimeout(SLOW_MS)

let state: DomainState
let runtime: ProfileRuntime
const realNow = Date.now
beforeEach(() => {
  runtime = new ProfileRuntime()
  state = domainState({ runtime: runtime as never })
}, { timeout: SLOW_MS })
afterEach(async () => { Date.now = realNow; await state.close() }, { timeout: SLOW_MS })

async function workspace(st: DomainState = state) {
  const project = await st.workspaces.importProject('calc', buggyRepo())
  const session = repo.createSession(st.conn, project.id, 't', 'scripted:a')
  const ws = await st.workspaces.createWorkspace(project, session.id)
  const box: Sandbox = { writable: [ws.path], write_deny: [], read_deny: [], read_allow: [ws.path], network: false }
  return { project, ws, box }
}

const scratchOf = (xid: string, st: DomainState = state) => (repo.getExecution(st.conn, xid)!.isolation as { scratch: string }).scratch
const leftScratch = (st: DomainState = state) => existsSync(st.settings.scratch_dir) ? readdirSync(st.settings.scratch_dir).filter((n) => n.startsWith('x-')) : []

test('two sandboxed starts in the same millisecond get distinct scratch folders and profiles', async () => {
  const a = await workspace(), b = await workspace()
  // the clock frozen: what parallel tool calls or two sessions do now and then, made certain here
  const now = realNow()
  Date.now = () => now
  const [xa, xb] = await Promise.all([
    state.processes.start({ command: 'true', cwd: a.ws.path, sandbox: a.box, project_id: a.project.id, workspace_id: a.ws.id }),
    state.processes.start({ command: 'true', cwd: b.ws.path, sandbox: b.box, project_id: b.project.id, workspace_id: b.ws.id }),
  ]).finally(() => { Date.now = realNow })
  await state.processes.wait(xa.id, 10); await state.processes.wait(xb.id, 10)
  const sa = scratchOf(xa.id), sb = scratchOf(xb.id)
  expect(sa).not.toBe(sb)
  expect(runtime.writes).toHaveLength(2)
  expect(runtime.writes[0]!.profile).not.toBe(runtime.writes[1]!.profile)
  // each profile names its own scratch and workspace, never the other's
  for (const w of runtime.writes) {
    const mine = w.writable.includes(a.ws.path) ? { ws: a.ws.path, scratch: sa, other: [b.ws.path, sb] } : { ws: b.ws.path, scratch: sb, other: [a.ws.path, sa] }
    expect(w.writable).toContain(mine.ws)
    expect(w.writable).toContain(mine.scratch)
    for (const o of mine.other) expect(w.writable).not.toContain(o)
    expect(w.profile).toBe(join(mine.scratch, 'profile.sb'))
  }
})

test('many concurrent starts of one workspace, the clock frozen: every scratch distinct', async () => {
  const a = await workspace()
  const now = realNow()
  Date.now = () => now
  const xs = await Promise.all(Array.from({ length: 8 }, () =>
    state.processes.start({ command: 'true', cwd: a.ws.path, sandbox: a.box, project_id: a.project.id, workspace_id: a.ws.id }))).finally(() => { Date.now = realNow })
  for (const x of xs) await state.processes.wait(x.id, 10)
  expect(new Set(xs.map((x) => scratchOf(x.id))).size).toBe(8)
  expect(new Set(runtime.writes.map((w) => w.profile)).size).toBe(8)
})

test('finished commands leave neither scratch nor live entry; their output, pages and log assets stay readable', async () => {
  const a = await workspace()
  const ids: string[] = []
  for (let i = 0; i < 3; i += 1) {
    const x = await state.processes.start({ command: `printf 'héllo-${i}-wörld'; printf 'err-${i}' >&2`, cwd: a.ws.path, sandbox: a.box, project_id: a.project.id, workspace_id: a.ws.id })
    await state.processes.wait(x.id, 10)
    ids.push(x.id)
  }
  expect(leftScratch()).toEqual([])
  expect(state.processes.live.size).toBe(0)
  // the workspace's own HOME and temporary folder are kept for its later commands
  expect(existsSync(join(state.processes.sandboxDir(a.ws.id), 'home'))).toBe(true)
  expect(existsSync(join(state.processes.sandboxDir(a.ws.id), 'tmp'))).toBe(true)
  for (const [i, id] of ids.entries()) {
    const done = await state.processes.wait(id, 1)
    expect(done?.status).toBe('succeeded')
    expect(state.processes.isRunning(id)).toBe(false)
    expect(state.processes.stop(id)).toBe(false)
    const summary = state.processes.summary(id)
    expect(summary.stdout).toBe(`héllo-${i}-wörld`)
    expect(summary.stderr).toBe(`err-${i}`)
    expect(summary.output_complete).toBe(true)
    expect(summary.running).toBe(false)
    // paged by 1 byte (a page edge inside é and ö), joined to the exact text
    let text = '', offset = 0
    for (let guard = 0; guard < 100; guard += 1) {
      const page = state.processes.readOutput(id, 'stdout', offset, 1)
      text += page.text; offset = page.next_offset
      if (page.eof) { expect((page as { command_total_bytes?: number | null }).command_total_bytes).toBe(page.total_bytes); break }
    }
    expect(text).toBe(`héllo-${i}-wörld`)
    // the sealed log asset (what remains once the log file is gone) holds the bytes
    const asset = repo.getAsset(state.conn, done!.stdout_asset_id!)!
    expect(Buffer.from(state.store.readRange(asset.storage_path, 0, 1024).bytes).toString('utf8')).toBe(`héllo-${i}-wörld`)
  }
})

test('the scratch stays while the command runs and until its logs are sealed; a stop and a timeout retire it too', async () => {
  const a = await workspace()
  const sealedWhile: boolean[] = []
  const save = state.store.save.bind(state.store)
  ;(state.store as { save: typeof save }).save = (...args: Parameters<typeof save>) => {
    const xid = (args[4] as { meta?: { execution_id?: string } } | undefined)?.meta?.execution_id
    if (xid) sealedWhile.push(existsSync(scratchOf(xid)))
    return save(...args)
  }
  const x = await state.processes.start({ command: 'echo started; sleep 30', cwd: a.ws.path, sandbox: a.box, project_id: a.project.id, workspace_id: a.ws.id })
  const scratch = scratchOf(x.id)
  for (let i = 0; i < 100 && state.processes.readOutput(x.id).total_bytes === 0; i += 1) await sleep(20)
  expect(existsSync(scratch)).toBe(true)
  expect(state.processes.live.size).toBe(1)
  expect(state.processes.stop(x.id)).toBe(true)
  const stopped = await state.processes.wait(x.id, 10)
  expect(stopped?.status).toBe('cancelled')
  expect(sealedWhile).toEqual([true])
  expect(existsSync(scratch)).toBe(false)
  expect(state.processes.live.size).toBe(0)
  expect(state.processes.summary(x.id).stdout).toBe('started\n')

  const t = await state.processes.start({ command: 'sleep 30', timeout_s: 0.2, cwd: a.ws.path, sandbox: a.box, project_id: a.project.id, workspace_id: a.ws.id })
  expect((await state.processes.wait(t.id, 10))?.status).toBe('timeout')
  expect(existsSync(scratchOf(t.id))).toBe(false)
  expect(state.processes.live.size).toBe(0)
})

test('what a command left running is stopped before its scratch goes', async () => {
  const a = await workspace()
  const x = await state.processes.start({ command: 'sleep 30 & echo $!', cwd: a.ws.path, sandbox: a.box, project_id: a.project.id, workspace_id: a.ws.id })
  const done = await state.processes.wait(x.id, 10)
  const child = Number(state.processes.summary(x.id).stdout)
  expect(Number.isInteger(child) && child > 1).toBe(true)
  // killed: gone, or exited and not yet reaped by the init it was handed to (a zombie runs nothing; the kernel's word on
  // macOS, /proc on Linux, as the reaper reads it)
  const running = () => { try { process.kill(child, 0) } catch { return false } return !exitedAwaitingReap(child) }
  expect(running()).toBe(false)
  expect(Number((done!.isolation as { stray_processes_killed?: number }).stray_processes_killed ?? 0)).toBeGreaterThan(0)
  expect(leftScratch()).toEqual([])
  expect(state.processes.live.size).toBe(0)
})

test('a start that fails before or at its process leaves no scratch, and no workspace folder is removed', async () => {
  const a = await workspace()
  runtime.fail = new Error('profile refused')
  await expect(state.processes.start({ command: 'true', cwd: a.ws.path, sandbox: a.box, project_id: a.project.id, workspace_id: a.ws.id })).rejects.toThrow('profile refused')
  expect(leftScratch()).toEqual([])
  runtime.fail = null
  // the process cannot be made (its working folder does not exist)
  await expect(state.processes.start({ command: 'true', cwd: join(a.ws.path, 'missing'), sandbox: a.box, project_id: a.project.id, workspace_id: a.ws.id })).rejects.toThrow('could not start the process')
  expect(leftScratch()).toEqual([])
  expect(state.processes.live.size).toBe(0)
  expect(existsSync(a.ws.path)).toBe(true)
  expect(existsSync(join(state.processes.sandboxDir(a.ws.id), 'home'))).toBe(true)
})

test('a command of no workspace: its HOME and TMPDIR are in its scratch and go with it', async () => {
  const a = await workspace()
  const x = await state.processes.start({ command: 'echo "$HOME|$TMPDIR"; touch "$HOME/h" "$TMPDIR/t"', cwd: a.ws.path, sandbox: a.box, project_id: a.project.id })
  const done = await state.processes.wait(x.id, 10)
  expect(done?.status).toBe('succeeded')
  const scratch = scratchOf(x.id)
  expect(state.processes.summary(x.id).stdout).toBe(`${join(scratch, 'home')}|${join(scratch, 'tmp')}\n`)
  expect(existsSync(scratch)).toBe(false)
  expect(state.processes.live.size).toBe(0)
})

test('a Full access command is let go once it ends; its record and output stay', async () => {
  const a = await workspace()
  const x = await state.processes.start({ command: 'echo full', cwd: a.ws.path, access: 'full', project_id: a.project.id, workspace_id: a.ws.id })
  expect((await state.processes.wait(x.id, 10))?.status).toBe('succeeded')
  expect(state.processes.live.size).toBe(0)
  expect(state.processes.summary(x.id).stdout).toBe('full\n')
})

/** The data store failing for the statements matched, as a full disk or a locked database would. */
function failWrites(match: (sql: string) => boolean): { failed: () => number; restore: () => void } {
  const conn = state.conn as unknown as { run: (sql: string, params?: unknown[]) => unknown }
  const run = conn.run.bind(conn)
  let failed = 0
  conn.run = (sql: string, params?: unknown[]) => { if (match(sql)) { failed += 1; throw new Error('SQLITE_FULL: database or disk is full') } return run(sql, params) }
  return { failed: () => failed, restore: () => { conn.run = run } }
}

async function runningThenEnds(xid: string, scratch: string) {
  // running: followed, its scratch kept
  expect(state.processes.isRunning(xid)).toBe(true)
  expect(state.processes.live.has(xid)).toBe(true)
  expect(existsSync(scratch)).toBe(true)
  for (let i = 0; i < 100 && state.processes.readOutput(xid).total_bytes === 0; i += 1) await sleep(20)
  expect(existsSync(scratch)).toBe(true)
  const done = await state.processes.wait(xid, 10)
  expect(done?.status).toBe('succeeded')
  expect(state.processes.summary(xid).stdout).toBe('started\ndone\n')
  expect(existsSync(scratch)).toBe(false)
  expect(state.processes.live.size).toBe(0)
}

for (const [what, match] of [['its root', (sql: string) => sql.includes('$.root_pid')], ['its lineage', (sql: string) => sql.includes('$.lineage')]] as const) {
  test(`a record of ${what} that cannot be written once the process exists: the command is still followed, its scratch kept until it ends`, async () => {
    const a = await workspace()
    const fault = failWrites(match)
    let x
    try {
      x = await state.processes.start({ command: 'echo started; sleep 0.6; echo done', cwd: a.ws.path, sandbox: a.box, project_id: a.project.id, workspace_id: a.ws.id })
    } finally { fault.restore() }
    expect(fault.failed()).toBeGreaterThan(0)
    await runningThenEnds(x.id, scratchOf(x.id))
  })
}

test('a start that fails after its process exists: the process is followed and reaped, its scratch goes only once it ended', async () => {
  const a = await workspace()
  // the root's record goes through; the read of the execution right after it fails, so start rejects with a live process
  const conn = state.conn as unknown as { run: (sql: string, params?: unknown[]) => unknown; get: (sql: string, params?: unknown[]) => unknown }
  const run = conn.run.bind(conn), get = conn.get.bind(conn)
  let armed = false
  conn.run = (sql, params) => { const r = run(sql, params); if (sql.includes('$.root_pid')) armed = true; return r }
  conn.get = (sql, params) => { if (armed) { armed = false; throw new Error('SQLITE_IOERR: disk I/O error') } return get(sql, params) }
  const before = new Set(leftScratch())
  try {
    await expect(state.processes.start({ command: 'echo started; sleep 0.6; echo done', cwd: a.ws.path, sandbox: a.box, project_id: a.project.id, workspace_id: a.ws.id })).rejects.toThrow('SQLITE_IOERR')
  } finally { conn.run = run; conn.get = get }
  const [xid] = [...state.processes.live.keys()]
  expect(xid).toBeDefined()
  const made = leftScratch().filter((n) => !before.has(n))
  expect(made).toHaveLength(1)
  expect(scratchOf(xid!)).toBe(join(state.settings.scratch_dir, made[0]!))
  await runningThenEnds(xid!, scratchOf(xid!))
})

test('a kill sent is not a process seen gone: while what a command left still runs, its scratch is kept', async () => {
  const a = await workspace()
  // the signals are taken and never land: what the command left keeps running
  const sent: number[] = []
  state.processes.killProcess = (pid) => { sent.push(pid) }
  const x = await state.processes.start({ command: 'sleep 30 & echo $!', cwd: a.ws.path, sandbox: a.box, project_id: a.project.id, workspace_id: a.ws.id })
  await state.processes.wait(x.id, 20)
  const child = Number(state.processes.summary(x.id).stdout)
  try {
    expect(sent).toContain(child)
    let alive = true
    try { process.kill(child, 0) } catch { alive = false }
    expect(alive).toBe(true)
    expect(existsSync(scratchOf(x.id))).toBe(true)
  } finally {
    // this test's own child, stopped by the test
    try { process.kill(child, 'SIGKILL') } catch { /* gone */ }
  }
})

// -- the real Seatbelt: two commands started in the same millisecond never reach each other's folders -----------

const ATTEMPT = `const fs = require('node:fs')
let t = null
for (let i = 0; i < 500 && t === null; i += 1) { try { t = JSON.parse(fs.readFileSync('target.json', 'utf8')) } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20) } }
const out = {}
const tries = {
  own_ws: () => fs.writeFileSync(t.own_ws + '/own.txt', 'W'), own_scratch: () => fs.writeFileSync(t.own_scratch + '/own.txt', 'W'),
  other_ws: () => fs.writeFileSync(t.other_ws + '/pwned.txt', 'W'), other_scratch: () => fs.writeFileSync(t.other_scratch + '/pwned.txt', 'W'),
  other_profile: () => fs.readFileSync(t.other_scratch + '/profile.sb', 'utf8'),
}
for (const [k, f] of Object.entries(tries)) { try { f(); out[k] = 'ok' } catch (e) { out[k] = e.code } }
console.log(JSON.stringify(out))
// held until the test has seen both answer: neither ends (and has its scratch removed) while the other still tries it
for (let i = 0; i < 1500 && !fs.existsSync('release'); i += 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)`

test.skipIf(process.platform !== 'darwin')('Seatbelt: same-millisecond starts in two workspaces each hold only their own workspace and scratch', async () => {
  const seatbelt = new SeatbeltRuntime()
  const probeState = domainState()
  let report: IsolationReport
  try { report = await seatbelt.probe(probeState.settings.data_dir) } finally { await probeState.close() }
  expect(report.enforcement).toBe('full')
  const st = domainState({ runtime: seatbelt, report })
  useFixtureHost(st.processes)
  try {
    const a = await workspace(st), b = await workspace(st)
    const boxOf = (w: typeof a) => sandboxForWorkspace(st.settings.data_dir, w.project, w.ws, { network: false })
    for (const w of [a, b]) writeFileSync(join(w.ws.path, 'attempt.cjs'), ATTEMPT)
    const command = `'${process.execPath}' attempt.cjs`
    const now = realNow()
    Date.now = () => now
    const [xa, xb] = await Promise.all([
      st.processes.start({ command, cwd: a.ws.path, sandbox: boxOf(a), project_id: a.project.id, workspace_id: a.ws.id }),
      st.processes.start({ command, cwd: b.ws.path, sandbox: boxOf(b), project_id: b.project.id, workspace_id: b.ws.id }),
    ]).finally(() => { Date.now = realNow })
    const sa = scratchOf(xa.id, st), sb = scratchOf(xb.id, st)
    expect(sa).not.toBe(sb)
    // each command's profile, read while both run: its own scratch and workspace, never the other's
    const pa = readFileSync(join(sa, 'profile.sb'), 'utf8'), pb = readFileSync(join(sb, 'profile.sb'), 'utf8')
    expect(pa).not.toBe(pb)
    const real = (p: string) => p.replace(/^\/var\//, '/private/var/').replace(/^\/tmp\//, '/private/tmp/')
    expect(pa).toContain(real(sa)); expect(pa).not.toContain(real(sb)); expect(pa).not.toContain(`"${real(b.ws.path)}"`)
    expect(pb).toContain(real(sb)); expect(pb).not.toContain(real(sa)); expect(pb).not.toContain(`"${real(a.ws.path)}"`)
    writeFileSync(join(a.ws.path, 'target.json'), JSON.stringify({ own_ws: a.ws.path, own_scratch: sa, other_ws: b.ws.path, other_scratch: sb }))
    writeFileSync(join(b.ws.path, 'target.json'), JSON.stringify({ own_ws: b.ws.path, own_scratch: sb, other_ws: a.ws.path, other_scratch: sa }))
    for (let i = 0; i < 1000 && [xa.id, xb.id].some((id) => st.processes.readOutput(id).total_bytes === 0); i += 1) await sleep(20)
    for (const w of [a, b]) writeFileSync(join(w.ws.path, 'release'), '')
    const [da, db] = [await st.processes.wait(xa.id, 30), await st.processes.wait(xb.id, 30)]
    for (const [d, id] of [[da, xa.id], [db, xb.id]] as const) {
      const summary = st.processes.summary(id)
      expect({ status: d?.status, stderr: summary.stderr }).toEqual({ status: 'succeeded', stderr: '' })
      expect(JSON.parse(String(summary.stdout).trim())).toEqual({ own_ws: 'ok', own_scratch: 'ok', other_ws: 'EPERM', other_scratch: 'EPERM', other_profile: 'EPERM' })
    }
    expect(existsSync(join(a.ws.path, 'pwned.txt')) || existsSync(join(b.ws.path, 'pwned.txt'))).toBe(false)
    expect(existsSync(join(a.ws.path, 'own.txt')) && existsSync(join(b.ws.path, 'own.txt'))).toBe(true)
    // both ended: their scratch folders are gone, the workspaces stay
    expect(existsSync(sa) || existsSync(sb)).toBe(false)
    expect(st.processes.live.size).toBe(0)
  } finally {
    Date.now = realNow
    await st.close()
  }
}, SLOW_MS)
