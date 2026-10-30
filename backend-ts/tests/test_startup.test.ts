/** A harness that cannot start says why in one line and exits 1: a port already taken ends the start before the data
 *  directory is touched (nothing reconciled, resumed or claimed), a data directory held by another harness before
 *  anything in it is read, a database whose copy before its upgrade cannot be made before it is upgraded. None ends as
 *  an uncaught stack. */

import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCHEMA_VERSION } from '@oasis-code/contract'
import { UpgradeBackupFailed } from '../src/db/database.ts'
import { claimDataDir, DataInUse } from '../src/db/instance.ts'
import { startupFailure } from '../src/main.ts'
import { tempDir } from './helpers.ts'

const BACKEND = join(import.meta.dir, '..')

async function startBackend(data: string, port: number): Promise<{ code: number; stderr: string; stdout: string }> {
  const child = Bun.spawn(['bun', 'run', 'src/index.ts'], {
    cwd: BACKEND, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, OASIS_CODE_DATA: data, OASIS_CODE_PORT: String(port), OASIS_CODE_SESSION_TOKEN: 'startup-token' },
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  return { code, stdout, stderr }
}

function freePort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = probe.port as number
  probe.stop(true)
  return port
}

test('a taken port is one line and exit 1, before the data directory is claimed or read', async () => {
  const occupant = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('someone else') })
  const data = join(tempDir('oasis-startup-port-'), 'data')
  try {
    const result = await startBackend(data, occupant.port as number)
    expect(result.code).toBe(1)
    const lines = result.stderr.trim().split('\n')
    expect(lines).toEqual([`oasis-code did not start: port ${occupant.port} on 127.0.0.1 is already in use (another oasis-code, or another program); stop it, or set OASIS_CODE_PORT to a free port`])
    expect(result.stdout).toBe('')
    // the data directory was never made, let alone claimed, migrated or reconciled
    expect(existsSync(data)).toBe(false)
  } finally {
    occupant.stop(true)
  }
}, 60_000)

test('a data directory held by another harness is one line and exit 1, and the port is given back', async () => {
  const data = tempDir('oasis-startup-data-')
  const release = claimDataDir(data)
  const port = freePort()
  try {
    const result = await startBackend(data, port)
    expect(result.code).toBe(1)
    const lines = result.stderr.trim().split('\n')
    expect(lines.length).toBe(1)
    expect(lines[0]).toStartWith(`oasis-code did not start: the data directory ${data} is in use by another oasis-code (pid ${process.pid},`)
    expect(readdirSync(data).sort()).toEqual(['instance.lock'])                       // nothing of the data was made or read
  } finally {
    release()
  }
  // the port it bound first is free again
  const again = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('') })
  again.stop(true)
}, 60_000)

test('a database whose copy before its upgrade cannot be made is one line and exit 1, and stays as it was', async () => {
  const data = tempDir('oasis-startup-backup-')
  const db = join(data, 'index.db')
  const raw = new Database(db)
  raw.exec(readFileSync(join(import.meta.dir, 'fixtures', 'schema_v2.sql'), 'utf8'))
  raw.run('PRAGMA user_version = 2')
  raw.close()
  // the copy's place taken by a folder that cannot be replaced
  const blocker = join(data, 'index.db.v2.bak')
  mkdirSync(blocker)
  writeFileSync(join(blocker, 'keep'), 'x')
  chmodSync(blocker, 0o500)
  try {
    const result = await startBackend(data, freePort())
    expect(result.code).toBe(1)
    const lines = result.stderr.trim().split('\n')
    expect(lines.length).toBe(1)
    expect(lines[0]).toStartWith(`oasis-code did not start: the database at schema v2 could not be copied before its upgrade to v${SCHEMA_VERSION}, so it was not upgraded (`)
    expect(lines[0]).toEndWith(`check that ${data} is writable and has room, and start again`)
  } finally { chmodSync(blocker, 0o700) }
  const after = new Database(db, { readonly: true })
  try { expect((after.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2) } finally { after.close() }
}, 60_000)

test('only a taken port, a held data directory and a database that could not be copied before its upgrade are startup diagnostics; anything else keeps its stack', () => {
  const settings = { host: '127.0.0.1', port: 8321 }
  expect(startupFailure(new DataInUse('the data directory /d is in use by another oasis-code'), settings)).toBe('the data directory /d is in use by another oasis-code')
  expect(startupFailure(new UpgradeBackupFailed('the database at schema v2 could not be copied'), settings)).toBe('the database at schema v2 could not be copied')
  expect(startupFailure(Object.assign(new Error('Failed to start server. Is port 8321 in use?'), { code: 'EADDRINUSE' }), settings)).toContain('port 8321 on 127.0.0.1 is already in use')
  expect(startupFailure(new Error('boom'), settings)).toBeNull()
  expect(startupFailure(Object.assign(new Error('denied'), { code: 'EACCES' }), settings)).toBeNull()
})
