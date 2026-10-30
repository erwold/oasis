/** Deferred provider regression for service epoch handling. Real SQLite and real owned loopback
 * listeners; no SSH, process launch, production ports or other machine. Only the provider's completion
 * timing is controlled. This does not claim reproduction of a specific system SSH handshake race.
 */
import { expect, test } from 'bun:test'
import { createServer, type Server } from 'node:net'
import { connect } from '../src/db/database.ts'
import { createTarget } from '../src/db/remote_repo.ts'
import { RemoteWorkspaceService, type RemoteHostProvider } from '../src/workspace/remote.ts'
import { freeLoopbackPort } from './remote/loopback_sshd.ts'

async function close(server: Server): Promise<void> {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
for (const reconnect of [false, true]) test(`ssh review forward: late old provider forward after disconnect${reconnect ? ' and reconnect' : ''} cannot publish or leave its listener`, async () => {
  const conn = connect(':memory:')
  let release!: () => void
  const deferred = new Promise<void>(resolve => { release = resolve })
  const listeners: Server[] = []
  let closes = 0, factories = 0
  const service = new RemoteWorkspaceService(conn, () => {
    const providerId = ++factories
    const owned: Server[] = []
    return {
      async probe() { return { capabilities: { port_forwarding: true } } },
      async listDirs() { throw new Error('not used') },
      async openRoot() { throw new Error('not used') },
      async openForward(workspace_id, remote_port) {
        await deferred
        const port = await freeLoopbackPort()
        const server = createServer(socket => socket.end('owned review listener'))
        owned.push(server); listeners.push(server)
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
        return { id: `forward_${providerId}`, workspace_id, remote_host: '127.0.0.1', remote_port,
          local_host: '127.0.0.1', local_port: port, local_url: `http://127.0.0.1:${port}`, state: 'ready' }
      },
      async closeForward() { closes++; await Promise.all(owned.map(close)); return true },
      async disconnect() { await Promise.all(owned.map(close)) },
    } satisfies RemoteHostProvider
  })
  const target = createTarget(conn, { label: 'Deferred owned provider', destination: 'no-network.invalid' })
  try {
    await service.connect(target.id)
    const pending = service.openForward(target.id, 'review_workspace', 18088).then(value => ({ value }), error => ({ error }))
    await service.disconnect(target.id)
    expect(service.target(target.id).state).toBe('disconnected')
    expect(listeners).toHaveLength(0)
    if (reconnect) await service.connect(target.id)
    release()
    const result = await pending
    const actual = { published_ready: service.listForwards(target.id).some(f => f.state === 'ready'),
      listener_alive: listeners.some(s => s.listening), closes, target_state: service.target(target.id).state,
      resolved_ready: 'value' in result && result.value.state === 'ready' }
    console.log('REVIEW_LATE_FORWARD', JSON.stringify({ reconnect, ...actual }))
    expect(actual).toMatchObject({ published_ready: false, listener_alive: false,
      target_state: reconnect ? 'ready' : 'disconnected', resolved_ready: false })
  } finally {
    release()
    await Promise.all(listeners.map(close))
    await service.close(); conn.close()
    expect(listeners.every(s => !s.listening)).toBe(true)
  }
}, 15_000)
