/** A command the harness lost: the harness is killed (SIGKILL, a crash) while a command runs, and started again on
 *  the same data directory. The command's own process — a shell whose environment the kernel withholds, so the
 *  execution id it carries cannot find it — runs on detached from the dead harness; the next life kills it, its
 *  process group and what it left, by what the execution recorded, at startup or on a Stop of the lost execution.
 *  A process that merely has the recorded pid now is never touched. */

import { afterEach, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Settings } from '../src/config.ts'
import { connect, type Conn } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { ProcessManager, processIdentity, strayProcesses } from '../src/execution/processes.ts'
import { AssetStore } from '../src/store.ts'
import { FAKE_FULL, PassthroughRuntime, sleep } from './harness.ts'
import { tempDir } from './helpers.ts'
import { killOwned, newNonce, ownsPid, readPid } from './owned_pids.ts'

const LIFE = join(import.meta.dir, 'fixtures', 'lost_command_life.ts')

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) { try { await f() } catch { /* gone */ } }
})

interface Lost { data: string; folder: string; xid: string; root: number; nonce: string }

/** The first life: a harness in a child process starts the command (a shell loop that beats into a file and keeps a
 *  child of its group running), then is killed as a crash would kill it. */
async function lostCommand(): Promise<Lost> {
  const data = join(tempDir('oasis-lost-'), 'data')
  mkdirSync(data, { recursive: true })
  const folder = tempDir('oasis-lost-folder-')
  const nonce = newNonce()
  const command = `: ${nonce}; echo "$$ ${nonce}" > root.pid.tmp; mv root.pid.tmp root.pid; sleep 60 & while :; do echo tick >> heartbeats; sleep 0.05; done`
  const life: ChildProcess = spawn('bun', ['run', LIFE, data, folder, command], { stdio: ['ignore', 'pipe', 'inherit'] })
  cleanup.push(() => { if (life.exitCode === null && life.signalCode === null) life.kill('SIGKILL') })
  const line = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: life.stdout! })
    lines.once('line', resolve)
    life.once('exit', () => reject(new Error('the first life ended before it started the command')))
  })
  const xid = (JSON.parse(line) as { execution_id: string }).execution_id
  const root = await readPid(join(folder, 'root.pid'), nonce, 10_000)
  expect(root).not.toBeNull()
  cleanup.push(() => killOwned(root, nonce))
  const exited = new Promise((resolve) => life.once('exit', resolve))
  life.kill('SIGKILL')
  await exited
  return { data, folder, xid, root: root!, nonce }
}

/** The next life on the same data directory: its connection and process manager, the lost executions marked. */
function nextLife(data: string): { conn: Conn; processes: ProcessManager; lost: string[] } {
  const settings = new Settings({ data_dir: data, host: '127.0.0.1', port: 0, session_token: 'test-token' })
  const conn = connect(settings.db_path)
  const runtime = new PassthroughRuntime()
  const processes = new ProcessManager(settings, conn, new AssetStore(settings.assets_dir), runtime, { ...FAKE_FULL, runtime: runtime.name })
  cleanup.push(async () => { await processes.shutdown(); conn.close() })
  return { conn, processes, lost: repo.markLostExecutions(conn) }
}

function beats(folder: string): number {
  const path = join(folder, 'heartbeats')
  return existsSync(path) ? readFileSync(path, 'utf8').length : 0
}

async function stillBeating(folder: string): Promise<boolean> {
  const before = beats(folder)
  await sleep(300)
  return beats(folder) > before
}

test('a command running when the harness died is killed at the next startup: its own process, its group, nothing left writing', async () => {
  const lost = await lostCommand()
  // the harness is gone and the command is not: its shell goes on writing the folder
  expect(ownsPid(lost.root, lost.nonce)).toBe(true)
  expect(await stillBeating(lost.folder)).toBe(true)
  const { conn, processes, lost: marked } = nextLife(lost.data)
  expect(marked).toEqual([lost.xid])
  const recorded = repo.getExecution(conn, lost.xid)!.isolation as Record<string, unknown>
  expect(recorded.root_pid).toBe(lost.root)
  expect(processes.reapLost(marked)).toBeGreaterThanOrEqual(1)
  await sleep(100)
  expect(ownsPid(lost.root, lost.nonce)).toBe(false)
  expect(await stillBeating(lost.folder)).toBe(false)
  expect(strayProcesses([lost.xid], [lost.root])).toEqual([])
  expect(repo.getExecution(conn, lost.xid)!.status).toBe('lost')
}, 30_000)

test('a Stop of a lost execution stops what still runs of it', async () => {
  const lost = await lostCommand()
  const { processes, lost: marked } = nextLife(lost.data)
  expect(marked).toEqual([lost.xid])
  expect(processes.stop(lost.xid)).toBe(true)
  await sleep(100)
  expect(ownsPid(lost.root, lost.nonce)).toBe(false)
  expect(await stillBeating(lost.folder)).toBe(false)
  // nothing of it is left: a second Stop stops nothing
  expect(processes.stop(lost.xid)).toBe(false)
}, 30_000)

test('a process that has a lost execution\'s recorded pid but is not its process is left alone', async () => {
  const { conn, processes } = nextLife(join(tempDir('oasis-lost-'), 'data'))
  const nonce = newNonce()
  const sleeper = spawn('python3', ['-c', 'import time; time.sleep(30)', nonce], { stdio: 'ignore', detached: true })
  cleanup.push(() => { sleeper.kill('SIGKILL') })
  await sleep(200)
  const identity = processIdentity(sleeper.pid!)
  expect(identity).not.toBeNull()
  // the record of a command whose process was another one, earlier, with the pid this sleeper has now
  const x = repo.insertExecution(conn, { run_id: null, workspace_id: null, tool_call_id: null, kind: 'command', command: 'sleep', cwd: '/', isolation: {}, network: false })
  repo.startExecution(conn, x.id)
  repo.noteExecutionRoot(conn, x.id, { pid: sleeper.pid!, identity: `${identity}0`, uniqueid: null })
  expect(repo.markLostExecutions(conn)).toEqual([x.id])
  expect(processes.reapLost([x.id])).toBe(0)
  expect(processes.stop(x.id)).toBe(false)
  await sleep(100)
  expect(ownsPid(sleeper.pid!, nonce)).toBe(true)
}, 30_000)
