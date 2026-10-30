import { expect, test } from 'bun:test'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { SshTransport } from '../src/remote/transport.ts'
import { RemoteError, type Lease } from '../src/remote/types.ts'
import { RemoteJobController as RemoteExecutionDriver, createRemoteExecutionState, type RemoteExecutionState, type RemoteJobRpc } from '../src/execution/remote_driver.ts'
import { LoopbackSshd, inspectPid } from './remote/loopback_sshd.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function terminal(driver: RemoteExecutionDriver) {
  for (let i = 0; i < 70; i++) {
    const result = await driver.status()
    if (result.terminal_confirmed) return result
    await sleep(100)
  }
  throw new Error('No durable terminal record observed')
}

test('real SSH durable driver: lost ACK, restart, no reexecution, byte pages/gaps and stop', async () => {
  const start = new Date().toISOString()
  const f = await LoopbackSshd.start({ parent: process.env.TMPDIR })
  const options = { config_file: f.configFile, known_hosts_file: f.knownHostsFile, rpc_timeout_ms: 10000 }
  const target = { destination: f.alias, identity_file: f.clientKey }
  let transport = new SshTransport(target, options)
  let lease: Lease | undefined
  let root: Awaited<ReturnType<SshTransport['openRoot']>> | undefined
  const drivers: RemoteExecutionDriver[] = []
  try {
    const probe = await transport.probe()
    console.log('DRIVER_LOOPBACK_PLATFORM', JSON.stringify({ platform: probe.platform, python: probe.python_version, port: f.port, root: f.root, start_utc: start }))
    root = await transport.openRoot({ path: f.workspace })
    lease = await transport.request(root, 'leases.acquire', { owner_id: 'driver-test-owner' }, 'driver-lease')
    const binding = { target_id: 'loopback-test', root_id: root.root_id, generation: root.generation, path: root.path, state_path: root.state_path }
    const bound: RemoteJobRpc = (method, params, operation) => transport.request(root!, method, params, operation)
    let starts = 0, persisted: RemoteExecutionState | undefined
    const lostAck: RemoteJobRpc = async (method, params, operation) => {
      const result = await bound(method, params, operation)
      if (method === 'jobs.start') { starts++; throw new RemoteError('outcome_unknown', 'Test dropped completed RPC ACK', 'unknown') }
      return result
    }
    const db = join(f.root, 'execution.json')
    const persist = async (state: RemoteExecutionState) => { writeFileSync(db + '.tmp', JSON.stringify(state)); renameSync(db + '.tmp', db); persisted = state }
    const driver = new RemoteExecutionDriver(lostAck, createRemoteExecutionState(binding, {
      operation_id: 'durable-start', command: "printf x >> invocation-count; printf '你hello'; printf ERR >&2; sleep 1; printf done; exit 7", cwd: '.', shell: '/bin/sh', lease,
    }), persist)
    drivers.push(driver)
    const lost = await driver.start()
    expect(lost.state.job_id).toBeNull(); expect(lost.state.writer_pinned).toBe(true); expect(lost.terminal_confirmed).toBe(false)
    await driver.disconnect(); await transport.disconnect()
    transport = new SshTransport(target, options)
    const restored = new RemoteExecutionDriver(bound, JSON.parse(readFileSync(db, 'utf8')), persist)
    drivers.push(restored)
    await restored.start()
    const sameId = restored.snapshot().job_id; expect(sameId).not.toBeNull()
    const done = await terminal(restored)
    expect(done.state.job?.exit_code).toBe(7); expect(done.state.writer_pinned).toBe(false)
    expect(done.state.spec.timeout_s).toBeNull(); expect(done.state.spec.output_cap_bytes).toBeNull()
    expect(starts).toBe(1)
    const count = await transport.request(root, 'files.read', { path: 'invocation-count' })
    expect(Buffer.from(count.data, 'base64').toString()).toBe('x')
    const chunks: Buffer[] = []
    for (;;) {
      const out = await restored.output('stdout', undefined, 2)
      expect(out.available).toBe(true)
      if (!out.available) throw new Error('Output unavailable')
      chunks.push(Buffer.from(out.page.data, 'base64'))
      await restored.acknowledgeOutput('stdout', out.page.next_offset)
      if (out.page.eof) break
    }
    expect(Buffer.concat(chunks).toString()).toBe('你hellodone')
    expect(persisted?.cursors.stdout).toBe(Buffer.byteLength('你hellodone'))
    expect((await restored.reconnect()).state.job_id).toBe(sameId)
    const stderr = await restored.output('stderr'); expect(stderr.available).toBe(true)
    if (stderr.available) expect(Buffer.from(stderr.page.data, 'base64').toString()).toBe('ERR')

    const capped = new RemoteExecutionDriver(bound, createRemoteExecutionState(binding, { operation_id: 'capped-start', command: 'printf 123456789', lease, output_cap_bytes: 3 }), async () => {})
    drivers.push(capped); await capped.start(); await terminal(capped)
    const page = await capped.output('stdout'); expect(page.available).toBe(true)
    if (page.available) { expect(page.page.total_written).toBe(9); expect(page.page.total_retained).toBe(3); expect(page.page.gaps).toEqual([{ start: 3, end: 9 }]) }

    const stoppable = new RemoteExecutionDriver(bound, createRemoteExecutionState(binding, { operation_id: 'stop-start', command: 'sleep 3', lease }), async () => {})
    drivers.push(stoppable); await stoppable.start()
    for (let i = 0; i < 20 && (await stoppable.status()).state.job?.state !== 'running'; i++) await sleep(50)
    const stopping = await stoppable.stop('stop-request')
    if (!stopping.terminal_confirmed) expect(stopping.state.writer_pinned).toBe(true)
    const stopped = await terminal(stoppable)
    expect(stopped.state.job?.reason).toBe('stopped')
    expect(stopped.state.job?.signal).toBe(15)
    const identities = drivers.map(d => d.snapshot().job).filter(Boolean)
    console.log('DRIVER_REMOTE_JOB_LEDGER', JSON.stringify(identities))
  } finally {
    // Commands are bounded in their own test scripts. Query actual exits before releasing lease.
    let allTerminal = true
    for (const driver of drivers) {
      try { await terminal(driver) } catch { allTerminal = false }
    }
    if (allTerminal && root && lease) await transport.request(root, 'leases.release', { lease }, 'driver-lease-release')
    await transport.disconnect()
    await f.close({ keepEvidence: true })
    console.log('DRIVER_FIXTURE_CLEANUP', JSON.stringify({ end_utc: new Date().toISOString(), evidence: f.root, allTerminal, ledger: f.ledger }))
    for (const record of f.ledger) expect(inspectPid(record.pid)).toBeNull()
  }
}, 60000)
