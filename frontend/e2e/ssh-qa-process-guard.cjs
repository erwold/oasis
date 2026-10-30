/* QA-only preload: record spawned PIDs, verify exact ps identity before ChildProcess.kill,
 * and fail closed if any test accidentally invokes the real launchctl/Remote access installer.
 * Loaded only by the isolated serial QA runner, never by the product. */
'use strict'
// Existing suites use E2E_PORT, not the product PORT; enforce both before their modules load.
if (process.env.OASIS_CODE_E2E_PORT && process.env.OASIS_CODE_E2E_PORT !== '8399') throw new Error('QA e2e port must be 8399')
process.env.OASIS_CODE_E2E_PORT = '8399'
const cp = require('node:child_process')
const fs = require('node:fs')
const { basename } = require('node:path')
const { syncBuiltinESMExports } = require('node:module')
const originalSync = cp.spawnSync
const originalSpawn = cp.ChildProcess.prototype.spawn
const originalKill = cp.ChildProcess.prototype.kill
const records = new WeakMap()
const byPid = new Map()
const originalProcessKill = process.kill.bind(process)
const log = (row) => {
  if (process.env.OASIS_SSH_QA_PID_LOG) fs.appendFileSync(process.env.OASIS_SSH_QA_PID_LOG, JSON.stringify({ utc: new Date().toISOString(), owner: process.pid, ...row }) + '\n')
}
function identity(pid) {
  const r = originalSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' })
  if (r.status !== 0 || !r.stdout.trim()) return null
  const m = /^(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/.exec(r.stdout.trim())
  if (!m) throw new Error('QA cannot parse owned process identity')
  return { started: m[1].replace(/\s+/g, ' '), command: m[2] }
}
function allowed(file, args) {
  const words = [String(file), ...(Array.isArray(args) ? args.map(String) : [])]
  if (basename(String(file)) === 'launchctl' || words.some((s) => /(?:^|[\s/])launchctl(?:\s|$)/.test(s))) {
    log({ event: 'forbidden-launchctl' })
    throw new Error('QA forbids real launchctl; remote-access tests must use their injected mock')
  }
}
cp.ChildProcess.prototype.spawn = function (options) {
  allowed(options.file, options.args)
  const result = originalSpawn.call(this, options)
  if (this.pid) {
    const found = identity(this.pid)
    const record = { pid: this.pid, ...found }
    records.set(this, record)
    byPid.set(this.pid, record)
    log({ event: 'spawn', ...record })
    this.once('exit', (code, signal) => log({ event: 'exit', pid: record.pid, code, signal }))
  }
  return result
}
cp.ChildProcess.prototype.kill = function (signal) {
  if (this.exitCode !== null || this.signalCode !== null) return false
  const record = records.get(this)
  if (!record) throw new Error('QA refuses unrecorded child signal')
  const now = identity(record.pid)
  if (!now) return false
  if (!record.command || now.started !== record.started || now.command !== record.command) {
    log({ event: 'signal-refused-identity', pid: record.pid })
    throw new Error(`QA refuses changed PID identity: ${record.pid}`)
  }
  log({ event: 'signal-verified', pid: record.pid, signal: signal || 'SIGTERM', ...now })
  return originalKill.call(this, signal)
}
process.kill = function (pid, signal = 'SIGTERM') {
  if (signal === 0) return originalProcessKill(pid, signal) // read-only existence check
  const record = byPid.get(pid)
  if (!Number.isInteger(pid) || pid <= 1 || !record) {
    log({ event: 'process-signal-refused-unowned-or-group', pid, signal })
    throw new Error('QA refuses unrecorded PID or process-group signal')
  }
  const now = identity(pid)
  if (!now || !record.command || now.started !== record.started || now.command !== record.command) {
    log({ event: 'process-signal-refused-identity', pid, signal })
    throw new Error('QA refuses process.kill identity mismatch')
  }
  log({ event: 'process-signal-verified', pid, signal, ...now })
  return originalProcessKill(pid, signal)
}
for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
  const original = cp[name]
  cp[name] = function (file, args, ...rest) { allowed(file, args); return original.call(this, file, args, ...rest) }
}
syncBuiltinESMExports()
