/** Test-only TCP fault proxy in front of the fixture sshd (loopback only). The ssh client talks
 * real, encrypted SSH through it; faults are network-level, not a mock of the transport:
 *  pass      forward bytes (optionally delayed per direction: latency injection)
 *  refuse    accept then close at once (network/host down: ssh exits 255 before any session)
 *  blackhole keep sockets open but drop every byte (silent partition)
 *  reset()   close every established connection (link loss under a live channel)
 *  stall()   stop reading every socket (TCP backpressure: uploads stay outstanding); resume() undoes it */
import { createServer, connect, type Server, type Socket } from 'node:net'
export type ProxyMode = 'pass' | 'refuse' | 'blackhole'
export class FaultProxy {
  mode: ProxyMode = 'pass'
  delay_ms = 0
  accepted = 0
  private stalled = false
  private readonly sockets = new Set<Socket>()
  private constructor(private readonly server: Server, readonly port: number) {}
  static async start(target: number): Promise<FaultProxy> {
    for (;;) {
      let proxy: FaultProxy | undefined
      const server = createServer(client => proxy?.accept(client, target))
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
      const port = (server.address() as { port: number }).port
      if (![8321, 8322, 8323, 8324, 8399].includes(port)) { proxy = new FaultProxy(server, port); return proxy }
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
  private track(socket: Socket): void { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); socket.on('error', () => {}); if (this.stalled) socket.pause() }
  private accept(client: Socket, target: number): void {
    this.accepted++
    this.track(client)
    if (this.mode === 'refuse') { client.destroy(); return }
    const upstream = connect(target, '127.0.0.1')
    this.track(upstream)
    const relay = (from: Socket, to: Socket) => from.on('data', (chunk: Buffer) => {
      if (this.mode === 'blackhole') return
      if (this.delay_ms > 0) setTimeout(() => { if (!to.destroyed) to.write(chunk) }, this.delay_ms)
      else to.write(chunk)
    })
    relay(client, upstream); relay(upstream, client)
    client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy())
  }
  reset(): void { for (const socket of [...this.sockets]) socket.destroy() }
  stall(): void { this.stalled = true; for (const socket of this.sockets) socket.pause() }
  resume(): void { this.stalled = false; for (const socket of this.sockets) socket.resume() }
  async close(): Promise<void> { this.reset(); await new Promise<void>(resolve => this.server.close(() => resolve())) }
}
