/** One harness per data directory: a second one started while the first lives is refused before it reads or recovers
 *  anything; once the first is gone its claim is taken over and recovery goes on as before. A workspace lock of a
 *  process that still runs is not removed as stale. (Two real HTTP backends on one data: Codex's DATA-09.) */

import { expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { claimDataDir, DataInUse } from '../src/db/instance.ts'
import { WorkspaceLocks } from '../src/workspace/locks.ts'
import { sleep } from './harness.ts'
import { tempDir } from './helpers.ts'

/** A second process's attempt to claim `data`: 'claimed' or 'refused'. */
function claimFromAnother(data: string): string {
  const script = `import { claimDataDir } from ${JSON.stringify(join(import.meta.dir, '../src/db/instance.ts'))}; try { claimDataDir(${JSON.stringify(data)}); console.log('claimed') } catch (e) { console.log(e.name === 'DataInUse' ? 'refused' : 'error ' + e.message) }`
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' }).stdout.trim()
}

test('a live holder refuses a second claim; a holder that died leaves it free; a release frees it; this process shares its own', async () => {
  const data = tempDir('oasis-claim-')
  const holder = spawn(process.execPath, ['-e', `import { claimDataDir } from ${JSON.stringify(join(import.meta.dir, '../src/db/instance.ts'))}; claimDataDir(${JSON.stringify(data)}); console.log('held'); setTimeout(() => {}, 30000)`], { stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    await new Promise<void>((resolve) => holder.stdout!.once('data', () => resolve()))
    expect(() => claimDataDir(data)).toThrow(DataInUse)
    expect(() => claimDataDir(data)).toThrow(`(pid ${holder.pid},`)                   // the refusal names the holder
    expect(claimFromAnother(data)).toBe('refused')
  } finally {
    holder.kill('SIGKILL')                                                             // the test's own child, by its handle
    await new Promise((resolve) => holder.once('exit', resolve))
  }
  // the kernel dropped the dead holder's lock: nothing to judge stale
  const release = claimDataDir(data)
  expect(JSON.parse(readFileSync(join(data, 'instance.lock'), 'utf8')).pid).toBe(process.pid)
  expect(claimFromAnother(data)).toBe('refused')
  const again = claimDataDir(data)                                                     // this process reopening its own
  again()
  expect(claimFromAnother(data)).toBe('refused')                                       // still held by the first claim
  release()
  expect(claimFromAnother(data)).toBe('claimed')                                       // released: another may take it
  expect(existsSync(join(data, 'instance.lock'))).toBe(true)                           // the lock file stays; only the lock goes
})

test('a command the harness starts does not inherit the claim', async () => {
  const data = tempDir('oasis-claim-inherit-')
  const release = claimDataDir(data)
  try {
    const open = spawnSync('/bin/sh', ['-c', 'lsof -p $$ 2>/dev/null | grep -c instance.lock'], { encoding: 'utf8' }).stdout.trim()
    expect(open).toBe('0')
  } finally { release() }
})

test('a workspace lock of a process that still runs is kept at startup; a dead process\'s is removed', async () => {
  const dir = tempDir('oasis-locks-')
  mkdirSync(dir, { recursive: true })
  const live = spawn('sleep', ['30'], { stdio: 'ignore' })
  try {
    writeFileSync(join(dir, 'ws_live.lock'), JSON.stringify({ owner: 'run_a', pid: live.pid }))
    writeFileSync(join(dir, 'ws_dead.lock'), JSON.stringify({ owner: 'run_b', pid: 999_999 }))
    const stale = new WorkspaceLocks(dir).reconcile()
    expect(stale).toEqual(['ws_dead'])
    expect(existsSync(join(dir, 'ws_live.lock'))).toBe(true)
  } finally {
    live.kill('SIGKILL')
    await sleep(10)
  }
})

test('eight processes claiming at once: exactly one holds it, whatever the order', async () => {
  const data = tempDir('oasis-claim-race-')
  const go = join(data, 'go')
  const script = `import { existsSync } from 'node:fs'; import { claimDataDir } from ${JSON.stringify(join(import.meta.dir, '../src/db/instance.ts'))}
while (!existsSync(${JSON.stringify(go)})) await Bun.sleep(1)
try { claimDataDir(${JSON.stringify(data)}); console.log('claimed') } catch (e) { console.log(e.name === 'DataInUse' ? 'refused' : 'error') }
await Bun.sleep(300)`
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] }))
  const outputs = children.map((c) => new Promise<string>((resolve) => { let out = ''; c.stdout!.on('data', (d) => { out += d }); c.once('exit', () => resolve(out.trim())) }))
  await sleep(300)                                                                       // all waiting at the line
  writeFileSync(go, '')
  const results = await Promise.all(outputs)
  expect(results.filter((r) => r === 'claimed')).toHaveLength(1)
  expect(results.filter((r) => r === 'refused')).toHaveLength(7)
}, 20_000)

test('a claim whose label cannot be written gives the lock and the descriptor back: the process lives on, another takes the directory', async () => {
  const data = tempDir('oasis-claim-fault-')
  // A: flock succeeds, then the label's write fails once with EIO (only that write; everything else is real)
  const script = `const fs = require('node:fs'); const write = fs.writeSync; let failed = 0
fs.writeSync = function (fd, text, ...rest) { if (!failed && typeof text === 'string' && text.includes('"pid"')) { failed = 1; const e = new Error('EIO: i/o error, write'); e.code = 'EIO'; throw e } return write.call(this, fd, text, ...rest) }
const { claimDataDir } = await import(${JSON.stringify(join(import.meta.dir, '../src/db/instance.ts'))})
try { claimDataDir(${JSON.stringify(data)}); console.log('claimed') } catch (e) { console.log('failed ' + e.code + ' ' + failed) }
setTimeout(() => {}, 30000)`
  const a = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    const said = await new Promise<string>((resolve) => a.stdout!.once('data', (d) => resolve(String(d).trim())))
    expect(said).toBe('failed EIO 1')
    expect(a.exitCode).toBeNull()                                                      // A lives on
    const open = spawnSync('/bin/sh', ['-c', `lsof -p ${a.pid} 2>/dev/null | grep -c instance.lock`], { encoding: 'utf8' }).stdout.trim()
    expect(open).toBe('0')                                                             // no descriptor left on the lock
    expect(claimFromAnother(data)).toBe('claimed')                                     // and no lock: another process takes it
    const release = claimDataDir(data)                                                 // so does this one, and holds it
    expect(claimFromAnother(data)).toBe('refused')
    release()
  } finally {
    a.kill('SIGKILL')                                                                  // the test's own child, by its handle
    await new Promise((resolve) => a.once('exit', resolve))
  }
})
