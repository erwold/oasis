/** Thin integration binding; all SSH/Python behavior belongs to src/remote. */
import { posix } from 'node:path'
import { SshTransport } from '../remote/transport.ts'
import type { TransportOptions } from '../remote/types.ts'
import type { RemoteProviderFactory } from './remote.ts'

/** Test-only options are constructor inputs, never accepted by public REST. */
export function createSshRemoteProvider(options: TransportOptions = {}): RemoteProviderFactory {
  return target => {
    const transport = new SshTransport(target, options)
    return {
      async probe() { const result = await transport.probe(); return { capabilities: { ...result.capabilities } } },
      /** A real round trip now: one framed probe on the transport's own channel (a new channel only if none is alive). */
      async check() { await transport.check() },
      async listDirs(path) {
        const page = await transport.listDirs(path || '/')
        return {
          path: page.path, name: posix.basename(page.path) || '/', parent: page.path === '/' ? null : posix.dirname(page.path),
          entries: page.entries.filter(e => e.kind === 'directory').map(e => ({ name: posix.basename(e.path), path: posix.isAbsolute(e.path) ? e.path : posix.join(page.path, e.path), repository: false })),
          truncated: page.truncated, favorites: [{ label: 'Root', path: '/' }],
        }
      },
      openRoot: (path, state_path) => transport.openRoot({ path, state_path }),
      // one batch: the transport pins the persisted root (expected root_id and generation) in the same batch as the
      // method and refuses an answer of another identity; no separate unpinned open (it could recreate state)
      request: (binding, method, params, operationId) => transport.request(binding, method, params, operationId),
      async openForward(workspace_id, port) { return { ...await transport.openForward(port), workspace_id } },
      closeForward: id => transport.closeForward(id),
      disconnect: () => transport.disconnect(),
    }
  }
}
