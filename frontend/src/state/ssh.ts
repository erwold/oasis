import { create } from 'zustand'
import { sshApi, targetKey, type ExecutionTarget, type SshTarget, type PortForward } from '../api/ssh'
import { browserControls, browserPlacer } from './desktop'
import { useDesk } from './desk'

export const SSH_STATES: Record<SshTarget['state'], string> = {
  disconnected: 'Disconnected', connecting: 'Connecting…', ready: 'Connected', auth_required: 'Authentication required',
  host_verification_required: 'Host verification required', unsupported: 'Unsupported', error: 'Connection failed',
}
interface SshState {
  targets: SshTarget[]; error: string | null;
  preview: { session_id: string; target_id: string; workspace_id: string; forward_id: string; generation: string | null } | null;
  refresh: () => Promise<void>; connect: (id: string) => Promise<void>;
}
let revision = 0
let refreshing: Promise<void> | null = null
export const useSsh = create<SshState>((set, get) => ({
  targets: [], error: null, preview: null,
  refresh: () => {
    if (refreshing) return refreshing
    const ticket = revision
    refreshing = sshApi.targets().then((targets) => { if (ticket === revision) set({ targets, error: null }) }, () => {
      if (ticket === revision) set({ targets: get().targets.map((t) => ({ ...t, state: 'disconnected' })), error: 'Disconnected' })
    }).finally(() => { refreshing = null })
    return refreshing
  },
  connect: async (id) => {
    ++revision
    set({ targets: get().targets.map((t) => t.id === id ? { ...t, state: 'connecting' } : t) })
    try {
      const target = await sshApi.connect(id)
      if (target.id !== id) throw new Error('Unknown SSH target')
      ++revision
      set({ targets: get().targets.map((t) => t.id === id ? target : t) })
      if (target.state !== 'ready') throw new Error(SSH_STATES[target.state])
    } catch (error) {
      ++revision
      set({ targets: get().targets.map((t) => t.id === id && t.state === 'connecting' ? { ...t, state: 'error' } : t) })
      throw error
    }
  },
}))
export function hostFor(target: ExecutionTarget, targets = useSsh.getState().targets): SshTarget | undefined {
  return target.kind === 'ssh' ? targets.find((h) => h.id === target.target_id) : undefined
}
export function targetLabel(target: ExecutionTarget, targets = useSsh.getState().targets): string {
  return target.kind === 'local' ? 'Local' : target.kind === 'unknown' ? 'Unknown' : hostFor(target, targets)?.label || target.target_id
}
export function ready(target: ExecutionTarget, targets = useSsh.getState().targets): boolean { return target.kind === 'local' || hostFor(target, targets)?.state === 'ready' }
export function allows(target: ExecutionTarget, capability: string, targets = useSsh.getState().targets): boolean {
  return target.kind === 'local' || (ready(target, targets) && hostFor(target, targets)?.capabilities[capability] === true)
}
export function requireRemote(target: ExecutionTarget, capability = 'direct_files'): void {
  if (target.kind === 'local') return
  if (!ready(target)) throw new Error('SSH: Disconnected')
  if (!allows(target, capability)) throw new Error('SSH: Unsupported')
}
export function forwardUrl(forward: PortForward, targetId: string, workspaceId: string): string {
  if (forward.target_id !== targetId || forward.workspace_id !== workspaceId || forward.state !== 'ready'
      || forward.local_host !== '127.0.0.1' || forward.remote_host !== '127.0.0.1'
      || !Number.isInteger(forward.local_port) || forward.local_port < 1 || forward.local_port > 65535
      || [8321, 8322, 8323, 8324, 8399].includes(forward.local_port)) throw new Error('Port unavailable')
  const url = new URL(forward.local_url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port || 80) !== forward.local_port
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Port unavailable')
  return url.href
}
/** A deliberate user action, never shell.openExternal or a rewritten remote localhost link. */
export async function openForward(forward: PortForward, sessionId: string, current: () => boolean,
  scope: { oasisCodeDesktop?: unknown } = window as { oasisCodeDesktop?: unknown }): Promise<void> {
  const target: ExecutionTarget = { kind: 'ssh', target_id: forward.target_id }
  requireRemote(target, 'port_forwarding')
  const generation = hostFor(target)?.generation ?? null
  const controls = browserControls(scope)
  if (!controls || !browserPlacer(scope)) throw new Error('Browser unavailable')
  const fresh = (await sshApi.forwards(forward.target_id)).find((f) => f.id === forward.id)
  if (!fresh || !current()) return
  requireRemote(target, 'port_forwarding')
  if (hostFor(target)?.generation !== generation) throw new Error('Port unavailable')
  const url = forwardUrl(fresh, forward.target_id, forward.workspace_id)
  const result = await controls.browserTab({ action: 'new', url })
  if (!result?.ok) throw new Error(result?.reason || 'Browser unavailable')
  if (!current() || !ready(target) || hostFor(target)?.generation !== generation) return
  useSsh.setState({ preview: { session_id: sessionId, target_id: forward.target_id, workspace_id: forward.workspace_id, forward_id: forward.id, generation } })
  const desk = useDesk.getState()
  desk.ensure('browser', 'browser'); desk.setMin('browser', false); desk.focus('browser')
}
export function sameTarget(a: ExecutionTarget, b: ExecutionTarget): boolean { return targetKey(a) === targetKey(b) && a.kind !== 'unknown' }
