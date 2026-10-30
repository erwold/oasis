import type { ConnectionState } from '../api/runStream'

/** Multiple views can watch the same run. Disposing an older view must not erase a newer connection. */
export function createConnectionTracker() {
  const runs = new Map<string, Map<symbol, ConnectionState>>()
  const listeners = new Set<() => void>()
  return {
    set(runId: string, owner: symbol, state: ConnectionState): void {
      let owners = runs.get(runId)
      if (state === 'closed') {
        if (!owners?.delete(owner)) return
        if (owners.size === 0) runs.delete(runId)
      } else {
        if (owners?.get(owner) === state) return
        if (!owners) { owners = new Map(); runs.set(runId, owners) }
        owners.set(owner, state)
      }
      for (const listener of listeners) listener()
    },
    snapshot(runId: string | null): ConnectionState {
      const owners = runId ? runs.get(runId) : undefined
      if (!owners?.size) return 'closed'
      const states = [...owners.values()]
      if (states.includes('connected')) return 'connected'
      return states.includes('reconnecting') ? 'reconnecting' : 'connecting'
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
export const runConnections = createConnectionTracker()
