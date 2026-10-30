import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { connect } from '../src/db/database.ts'
import { createTarget } from '../src/db/remote_repo.ts'
import { RemoteWorkspaceService, type RemoteHostProvider } from '../src/workspace/remote.ts'
import { tempDir } from './helpers.ts'

for (const oldFails of [false, true]) test(`disconnect/reconnect fences old probe ${oldFails ? 'failure' : 'success'} by epoch and provider identity`, async () => {
  const conn = connect(join(tempDir('remote-epoch-'), 'db'))
  let resolve!: (v: { capabilities: Record<string, boolean> }) => void, reject!: (e: Error) => void
  const old = new Promise<{ capabilities: Record<string, boolean> }>((r,j) => { resolve=r; reject=j })
  let count = 0
  const service = new RemoteWorkspaceService(conn, () => {
    const first = count++ === 0
    return { probe: () => first ? old : Promise.resolve({ capabilities: { new_connection: true } }),
      async listDirs() { throw new Error('not used') }, async openRoot() { throw new Error('not used') },
      async openForward() { throw new Error('not used') }, async closeForward() { return false }, async disconnect() {},
    } satisfies RemoteHostProvider
  })
  const target = createTarget(conn, { label: 'Fixture', destination: 'fixture.invalid' })
  try {
    const pending = service.connect(target.id)
    await service.disconnect(target.id)
    await service.connect(target.id)
    if (oldFails) reject(new Error('stale failure')); else resolve({ capabilities: { stale_connection: true } })
    await pending
    expect(service.target(target.id).state).toBe('ready')
    expect(service.target(target.id).capabilities).toEqual({ new_connection: true })
    expect(count).toBe(2)
  } finally { await service.close(); conn.close() }
})
