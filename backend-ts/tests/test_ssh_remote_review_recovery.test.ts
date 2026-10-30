/** Independent committed-service recovery tests. Injected provider, real isolated SQLite;
 * no network, command, SSH, listener or user settings. */
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { connect } from '../src/db/database.ts'
import { createTarget } from '../src/db/remote_repo.ts'
import { RemoteWorkspaceService, type RemoteHostProvider } from '../src/workspace/remote.ts'
import { lockKeyOf } from '../src/workspace/locks.ts'
import { tempDir } from './helpers.ts'

function setup(probe: RemoteHostProvider['probe']) {
  const conn = connect(join(tempDir('oasis-ssh-review-recovery-'), 'state.db'))
  const calls = { factories: 0, lists: 0, disconnects: 0 }
  const provider: RemoteHostProvider = {
    probe,
    async listDirs(path) { calls.lists++; return { path, name: 'remote', parent: null, entries: [], truncated: false, favorites: [] } },
    async openRoot() { throw new Error('not used') },
    async openForward() { throw new Error('not used') },
    async closeForward() { return false },
    async disconnect() { calls.disconnects++ },
  }
  const service = new RemoteWorkspaceService(conn, () => { calls.factories++; return provider })
  const target = createTarget(conn, { label: 'Review', destination: 'fixture.invalid' })
  return { service, target, calls, async close() { await service.close(); conn.close() } }
}

test('ssh review: user disconnect prevents directory polling from silently creating a provider', async () => {
  const f = setup(async () => ({ capabilities: {} }))
  try {
    await f.service.connect(f.target.id)
    await f.service.disconnect(f.target.id)
    await expect(Promise.resolve().then(() => f.service.listDirs(f.target.id, '/remote'))).rejects.toMatchObject({ code: 'remote_disconnected' })
    expect(f.calls).toEqual({ factories: 1, lists: 0, disconnects: 1 })
    expect(f.service.target(f.target.id).state).toBe('disconnected')
  } finally { await f.close() }
})

test('ssh review: a stale connect success cannot overwrite a newer explicit disconnect', async () => {
  let finish!: (value: { capabilities: Record<string, boolean> }) => void
  const deferred = new Promise<{ capabilities: Record<string, boolean> }>(resolve => { finish = resolve })
  const f = setup(() => deferred)
  try {
    const pending = f.service.connect(f.target.id).catch(error => error)
    expect(f.service.target(f.target.id).state).toBe('connecting')
    await f.service.disconnect(f.target.id)
    finish({ capabilities: { durable_jobs: true } })
    await pending
    expect(f.service.target(f.target.id).state).toBe('disconnected')
    expect(f.calls).toEqual({ factories: 1, lists: 0, disconnects: 1 })
  } finally { await f.close() }
})

test('ssh review: a stale connect failure cannot overwrite a newer explicit disconnect', async () => {
  let fail!: (reason: Error) => void
  const deferred = new Promise<{ capabilities: Record<string, boolean> }>((_resolve, reject) => { fail = reject })
  const f = setup(() => deferred)
  try {
    const pending = f.service.connect(f.target.id).catch(error => error)
    await f.service.disconnect(f.target.id)
    fail(new Error('injected stale probe failure'))
    await pending
    expect(f.service.target(f.target.id).state).toBe('disconnected')
  } finally { await f.close() }
})

const remoteWorkspace = (target: string, root: string, generation: string) => ({
  id: 'w', kind: 'direct' as const, path: '/same/path', target: { kind: 'ssh' as const, target_id: target },
  remote: { target_id: target, root_id: root, generation, path: '/same/path', state_path: '/same/path/.oasis-remote' },
})

test('ssh review: independently issued roots on different hosts never share a lock just because paths match', () => {
  // Distinct validated registry identities model distinct roots/hosts. A target label alone is not host identity.
  const a = remoteWorkspace('host_a', 'issued_root_a', 'issued_generation_a')
  const b = remoteWorkspace('host_b', 'issued_root_b', 'issued_generation_b')
  expect(lockKeyOf(a, 'w')).not.toBe(lockKeyOf(b, 'w'))
  expect(lockKeyOf(a, 'w')).not.toBe(lockKeyOf(remoteWorkspace('host_a', 'another_root', 'issued_generation_a'), 'w'))
  expect(lockKeyOf(a, 'w')).not.toBe(lockKeyOf(remoteWorkspace('host_a', 'issued_root_a', 'new_generation'), 'w'))
  expect(() => lockKeyOf({ ...a, remote: null }, 'w')).toThrow('remote workspace identity missing')
  expect(lockKeyOf(a, 'w')).not.toBe(lockKeyOf({ ...a, target: { kind: 'local' }, remote: null }, 'w'))
})

test('ssh review: target aliases of the same validated root and generation must share one writer lock', () => {
  const a = remoteWorkspace('host_alias_a', 'same_issued_root', 'same_issued_generation')
  const b = remoteWorkspace('host_alias_b', 'same_issued_root', 'same_issued_generation')
  expect(a.target.target_id).not.toBe(b.target.target_id)
  expect(lockKeyOf(a, 'w')).toBe(lockKeyOf(b, 'w'))
})
