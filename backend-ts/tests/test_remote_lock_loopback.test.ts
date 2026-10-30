import { expect, test } from 'bun:test'
import type { Workspace } from '@oasis-code/contract'
import { SshTransport } from '../src/remote/transport.ts'
import type { RemoteRoot } from '../src/remote/types.ts'
import { lockKeyOf } from '../src/workspace/locks.ts'
import { LoopbackSshd, inspectPid } from './remote/loopback_sshd.ts'
import { existsSync } from 'node:fs'

const binding = (root: RemoteRoot, target: string): Pick<Workspace, 'id' | 'kind' | 'path' | 'target' | 'remote'> => ({
  id: `workspace-${target}`, kind: 'direct', path: root.path, target: { kind: 'ssh', target_id: target }, remote: { ...root, target_id: target },
})

test('two owned SSH endpoints on this host recover one root identity; independently created roots remain separate', async () => {
  // Both sshd processes run on this machine as the same user. This is not a two-machine test.
  // Fresh keys/HOME/config/root per fixture; the production fixed per-user registry is shared.
  const a = await LoopbackSshd.start({ parent: process.env.TMPDIR })
  let b: LoopbackSshd | undefined
  const transports: SshTransport[] = []
  const connect = (f: LoopbackSshd) => {
    const t = new SshTransport({ destination: f.alias, identity_file: f.clientKey }, { config_file: f.configFile, known_hosts_file: f.knownHostsFile })
    transports.push(t); return t
  }
  try {
    b = await LoopbackSshd.start({ parent: process.env.TMPDIR })
    const first = connect(a), second = connect(b)
    const root = await first.openRoot({ path: a.workspace })
    const alias = await second.openRoot({ path: a.workspace })
    expect(a.port).not.toBe(b.port)
    expect(alias.root_id).toBe(root.root_id); expect(alias.generation).toBe(root.generation)
    expect(lockKeyOf(binding(root, 'target-a'), 'a')).toBe(lockKeyOf(binding(alias, 'target-b'), 'b'))
    await first.disconnect()
    const reconnected = await connect(a).openRoot({ path: a.workspace })
    expect(reconnected.root_id).toBe(root.root_id); expect(reconnected.generation).toBe(root.generation)
    expect(lockKeyOf(binding(reconnected, 'target-after-reconnect'), 'c')).toBe(lockKeyOf(binding(root, 'target-a'), 'a'))
    const separate = await second.openRoot({ path: b.workspace })
    expect(separate.root_id).not.toBe(root.root_id)
    expect(separate.generation).not.toBe(root.generation)
    expect(lockKeyOf(binding(separate, 'target-b'), 'b')).not.toBe(lockKeyOf(binding(root, 'target-a'), 'a'))
    // Synthetic same-spelling projection checks key scope; no claim of actual equal-path separate machines.
    const projected = binding(separate, 'target-b'); projected.path = root.path; projected.remote!.path = root.path
    expect(lockKeyOf(projected, 'b')).not.toBe(lockKeyOf(binding(root, 'target-a'), 'a'))
    console.log('LOCK_ROOT_IDENTITIES', JSON.stringify({ root_id: root.root_id, generation: root.generation, independent_root_id: separate.root_id, independent_generation: separate.generation, ports: [a.port, b.port] }))
  } finally {
    for (const t of transports) await t.disconnect()
    for (const f of [b, a]) if (f) {
      await f.close()
      expect(existsSync(f.root)).toBe(false)
      for (const record of f.ledger) expect(inspectPid(record.pid)).toBeNull()
      console.log('LOCK_ENDPOINT_CLEANUP', JSON.stringify({ utc: new Date().toISOString(), root: f.root, ledger: f.ledger }))
    }
  }
}, 30000)
