/** Independent real macOS SSH storage recovery using the QA fixture's isolated HOME/config/PID ledger.
 * Only deterministic storage syscalls are injected; supervisor, shell child, SSH and filesystem are real.
 * Commands are self-bounded even on the pre-fix path. No e2e/pod or manual remote PID signal.
 */
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LoopbackSshd, inspectPid } from './remote/loopback_sshd.ts'
import { SshTransport } from '../src/remote/transport.ts'
import { storageFaultPython } from '../src/remote/storage_fault.fixture.ts'
import type { RemoteJob } from '../src/remote/types.ts'
import { newId } from '../src/ids.ts'

test('ssh review storage: actual post-spawn, log and terminal ENOSPC preserve truthful terminal and reap owned child', async () => {
  const fixture = await LoopbackSshd.start({ parent: '/tmp' })
  const transports: SshTransport[] = []
  try {
    for (const mode of ['running', 'log', 'terminal'] as const) {
      const path = join(fixture.workspace, mode)
      mkdirSync(path)
      const transport = new SshTransport({ destination: fixture.alias, identity_file: fixture.clientKey }, {
        config_file: fixture.configFile, known_hosts_file: fixture.knownHostsFile,
        python: storageFaultPython(fixture.root, mode), rpc_timeout_ms: 10_000,
      })
      transports.push(transport)
      const root = await transport.openRoot({ path })
      const lease = await transport.request(root, 'leases.acquire', { owner_id: `review_${mode}` }, newId('op'))
      const start = await transport.request(root, 'jobs.start', {
        command: mode === 'terminal' ? 'printf finished' : 'printf started; sleep 1; printf orphan > must-not-run', lease,
      }, newId('op'))
      expect(start.timeout_s).toBeNull()
      expect(start.output_cap_bytes).toBeNull()
      let terminal: RemoteJob | undefined
      for (let attempt = 0; attempt < 50; attempt++) {
        const current = await transport.request(root, 'jobs.status', { job_id: start.job_id })
        if (current.state === 'exited') { terminal = current; break }
        await Bun.sleep(100)
      }
      expect(terminal).toMatchObject({ state: 'exited', reason: 'storage_failed', terminal_confirmed: true, log_complete: false })
      if (mode !== 'terminal') expect(terminal!.signal).toBe(9)
      const job = join(root.state_path, 'jobs', start.job_id)
      expect(existsSync(join(job, 'exit.json'))).toBe(false)
      const page = await transport.request(root, 'jobs.read', { job_id: start.job_id, stream: 'stdout' })
      expect(page).toMatchObject({ eof: true, storage_failed: true, log_complete: false })
      const identity = JSON.parse(readFileSync(join(job, 'fault-identity.json'), 'utf8')) as {
        supervisor_pid: number; supervisor_identity: string; pid_identity: { pid: number; identity: string }
      }
      // Exact recorded PID only; do not enumerate or signal. Give successfully reaped supervisors time to exit.
      await Bun.sleep(1100)
      const child = inspectPid(identity.pid_identity.pid)
      const supervisor = inspectPid(identity.supervisor_pid)
      expect(child).toBeNull()
      expect(supervisor).toBeNull()
      expect(existsSync(join(path, 'must-not-run'))).toBe(false)
      expect(await transport.request(root, 'leases.release', { lease }, newId('op'))).toEqual({ released: true })
      console.log('REVIEW_STORAGE_REAPED', JSON.stringify({ mode, child_pid: identity.pid_identity.pid, supervisor_pid: identity.supervisor_pid, child_ended: child === null, supervisor_ended: supervisor === null }))
      await transport.disconnect()
    }
  } finally {
    await Promise.all(transports.map(t => t.disconnect()))
    await fixture.close()
    console.log('REVIEW_STORAGE_FIXTURE_PIDS', JSON.stringify(fixture.ledger.map(p => ({ ...p, ended: inspectPid(p.pid) === null }))))
    expect(existsSync(fixture.root)).toBe(false)
  }
}, 120_000)
