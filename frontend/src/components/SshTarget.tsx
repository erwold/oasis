import { useEffect, useRef, useState } from 'react'
import { sessionTarget, taskTarget, targetKey, sshApi, type ExecutionTarget, type PortForward } from '../api/ssh'
import { useStore } from '../state/store'
import { allows, hostFor, openForward, ready, SSH_STATES, targetLabel, useSsh } from '../state/ssh'
import { browserControls, browserPlacer } from '../state/desktop'
import { XIcon } from './icons'

/** Target polling is independent of run SSE, the gateway and the Browser page. */
export function useSshTargets(active = true) {
  const hosts = useSsh((s) => s.targets)
  const refresh = useSsh((s) => s.refresh)
  useEffect(() => {
    if (!active) return
    void refresh()
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh() }, 5000)
    return () => clearInterval(timer)
  }, [active, refresh])
  return hosts
}
export function useExecutionTarget(): ExecutionTarget {
  const session = useStore((s) => s.session)
  const target = useStore((s) => s.target)
  const projects = useStore((s) => s.projects)
  return session ? sessionTarget(session, projects) : taskTarget(target, projects)
}

export function SshConnection({ target }: { target: ExecutionTarget }) {
  const hosts = useSshTargets(target.kind !== 'local')
  const host = hostFor(target, hosts)
  const [error, setError] = useState<string | null>(null)
  const identity = targetKey(target)
  useEffect(() => { setError(null) }, [identity])
  const current = useRef(identity); current.current = identity
  if (target.kind === 'local') return null
  const reconnect = async () => {
    if (target.kind !== 'ssh') return
    setError(null)
    try { await useSsh.getState().connect(target.target_id) }
    catch (e) { if (current.current === identity) setError(e instanceof Error ? e.message : 'Connection failed') }
  }
  return <span className="ssh-connection" data-testid="ssh-connection" data-target={identity} data-state={host?.state ?? 'unknown'}>
    <span role="status" className="dim small">{host ? SSH_STATES[host.state] : 'Unknown'}</span>
    {host?.state !== 'ready' && <button className="thread-btn" disabled={target.kind !== 'ssh' || host?.state === 'connecting'} onClick={() => void reconnect()}>Reconnect</button>}
    {error && <span className="err small" role="alert">{error}</span>}
  </span>
}

export function RemoteIdentity({ connection = false }: { connection?: boolean }) {
  const target = useExecutionTarget()
  const hosts = useSshTargets(target.kind !== 'local')
  const path = useStore((s) => s.session?.workspace?.path)
  if (target.kind === 'local') return null
  const where = `SSH · ${targetLabel(target, hosts)}${path ? ` · ${path}` : ''}`
  return <span className="ssh-identity" data-testid="remote-identity" title={where}>
    <span className="ssh-where">{where}</span>{connection && <SshConnection target={target} />}
  </span>
}

export function SshPorts() {
  const session = useStore((s) => s.session)
  const target = useExecutionTarget()
  const hosts = useSshTargets(target.kind !== 'local')
  const host = hostFor(target, hosts), sid = session?.id, wid = session?.workspace?.id
  const id = target.kind === 'ssh' ? target.target_id : null
  const identity = `${id}:${wid}:${sid}:${host?.generation}:${host?.state}`
  const current = useRef(identity); current.current = identity
  const [rows, setRows] = useState<PortForward[]>([]), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false)
  const canForward = allows(target, 'port_forwarding', hosts)
  const browser = !!browserControls(window as { oasisCodeDesktop?: unknown }) && !!browserPlacer(window as { oasisCodeDesktop?: unknown })
  useEffect(() => {
    let alive = true
    setRows([]); setError(null); setBusy(false)
    if (!id || !wid || !canForward) return
    const read = async () => {
      try { const rows = await sshApi.forwards(id); if (alive && current.current === identity) {
        setRows(rows.filter((r) => r.target_id === id && r.workspace_id === wid))
        const preview = useSsh.getState().preview
        if (preview?.workspace_id === wid && !rows.some((r) => r.id === preview.forward_id && r.state === 'ready')) useSsh.setState({ preview: null })
      } }
      catch { if (alive && current.current === identity) { setRows([]); setError('Disconnected'); if (useSsh.getState().preview?.workspace_id === wid) useSsh.setState({ preview: null }) } }
    }
    void read(); const timer = setInterval(() => void read(), 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [id, wid, identity, canForward])
  // the agent opens a port (forward_port); the list shows what is open
  if (target.kind === 'local' || (!rows.length && !error)) return null
  const work = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError(null)
    try { await fn() } catch (e) { if (current.current === identity) setError(e instanceof Error ? e.message : 'Port unavailable') }
    finally { if (current.current === identity) setBusy(false) }
  }
  return <section className="ssh-ports" aria-label="Ports" data-testid="ssh-ports">
    <div className="ssh-port-head"><strong>Ports</strong><RemoteIdentity /></div>
    {rows.map((row) => <div className="ssh-port-row" key={row.id} data-testid="ssh-port">
      <code>{row.remote_host}:{row.remote_port} → {row.local_host}:{row.local_port}</code>
      <span className="dim small">{row.state === 'ready' ? 'Connected' : row.state === 'error' ? 'Connection failed' : 'Disconnected'}</span>
      <button className="thread-btn" disabled={busy || !browser || !ready(target, hosts) || row.state !== 'ready'} onClick={() => void work(() => openForward(row, sid!, () => current.current === identity && useStore.getState().session?.id === sid))}>Open in browser</button>
      <button className="icon-btn" aria-label="Close port" disabled={busy} onClick={() => void work(async () => {
        const result = await sshApi.closeForward(id!, row.id)
        if (!result.closed) throw new Error('Port unavailable')
        if (current.current === identity) setRows((rows) => rows.filter((r) => r.id !== row.id))
        if (useSsh.getState().preview?.forward_id === row.id) useSsh.setState({ preview: null })
      })}><XIcon size={12} /></button>
    </div>)}
    {error && <span className="err small" role="alert">{error}</span>}
  </section>
}
