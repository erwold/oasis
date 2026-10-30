import { useEffect, useState } from 'react'
import { MODE_DESCRIPTIONS, MODE_LABELS, inferMode } from '@oasis-code/contract/modes'
import { sourceMount } from '../state/workspacePolicy'
import { useStore } from '../state/store'

/** The session's permissions on the Workspace card, said only when they differ from the defaults. Every session
 *  starts in Auto (edits, commands and the network in its own worktree, and writes into an attached folder); a
 *  session left in another mode (set by the director, or before the mode chip left the composer) is brought back to
 *  Auto here, and a network or an attached folder turned off is turned on again. */
export function Permissions() {
  const session = useStore((s) => s.session)
  const control = useStore((s) => s.control)
  const projects = useStore((s) => s.projects)
  const liveRunId = useStore((s) => s.liveRunId)
  const setGrants = useStore((s) => s.setGrants)
  const setMode = useStore((s) => s.setMode)
  const loadMode = useStore((s) => s.loadMode)
  const showToast = useStore((s) => s.showToast)
  const [loading, setLoading] = useState(false)
  const sessionId = session?.id
  useEffect(() => {
    if (!sessionId) return
    let alive = true
    setLoading(true)
    // the store takes the answer only for the session (and opening) it was read for, and keeps a grants or mode change
    // made since it left
    void loadMode().catch((error) => { if (alive) showToast(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [sessionId, showToast, loadMode])
  if (!session) return null
  const fail = (error: unknown) => showToast(error instanceof Error ? error.message : String(error))
  const active = !!liveRunId || !!session.active_run || !!session.active_children?.length
  const mode = control ? inferMode(session.grants, control) : null
  const project = projects.find((p) => p.id === session.project_id)
  const attachedName = project?.kind === 'attached' ? String(project.import_report?.attached_as ?? 'attached') : null
  const immutableSource = sourceMount(session.workspace)
  const grants = session.grants
  const toAuto = async () => {
    setLoading(true)
    try {
      await setMode('auto')
    } catch (error) { fail(error) } finally { setLoading(false) }
  }
  const toggle = (body: Record<string, unknown>) => { void setGrants(body).catch(fail) }
  const networkOff = mode !== 'plan' && !grants.network
  const attachedOff = mode !== 'plan' && !!attachedName && !immutableSource && !grants.attached_write
  if ((mode === null || mode === 'auto') && !immutableSource && !networkOff && !attachedOff) return null
  return (
    <div className="permissions" data-testid="permissions">
      {mode !== null && mode !== 'auto' && (
        <span className="perm-mode" data-testid="permissions-mode" title={mode === 'custom' ? undefined : MODE_DESCRIPTIONS[mode]}>{mode === 'custom' ? 'Permissions set by hand' : MODE_LABELS[mode]}
          <button className="btn tiny" disabled={loading || active} title={active ? 'Stop the active runs first.' : 'Edits and commands in the worktree, without asking'}
                  onClick={() => void toAuto()} data-testid="permissions-auto">Switch to Auto</button>
        </span>
      )}
      {immutableSource && <span className="dim small" data-testid="source-permission">Source is read-only; session grants cannot enable source writes.</span>}
      {networkOff && (
        <span className="perm-mode" title="Commands, the web tools and the agent's browser cannot reach the network: each such call asks you first.">Network off
          <button className="btn tiny" disabled={loading} onClick={() => toggle({ network: true })} data-testid="grant-network">Turn on</button>
        </span>
      )}
      {attachedOff && (
        <span className="perm-mode" title="Runs read the attached folder but cannot write it. A checkpoint does not undo writes there.">Writing {attachedName}/ off
          <button className="btn tiny" disabled={loading} onClick={() => toggle({ attached_write: true })} data-testid="grant-attached-write">Allow</button>
        </span>
      )}
    </div>
  )
}
