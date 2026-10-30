import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { useInteractionWorkspace } from './useInteractionWorkspace'
import type { Run } from '../api/types'
import { sourceMount, isolationLine } from '../state/workspacePolicy'
import { participantName, type InteractionTurn } from '../state/interaction'
import { jumpToRun } from './Relations'

/** A step's run as the thread holds it (a whole run) or as a card holds it (a row of the session's tree, which
 *  carries no model configuration: the evidence reads it from the run's record). */
export type StepRun = Pick<Run, 'id' | 'error' | 'workspace_id' | 'user_text'> & { status: string; model: string | null; model_config_snapshot?: Run['model_config_snapshot'] }

type Snapshot = Run['model_config_snapshot']
function useSnapshot(run: StepRun): { snapshot: Snapshot | null; error: string | null } {
  const [read, setRead] = useState<{ id: string; snapshot: Snapshot | null; error: string | null } | null>(null)
  const known = run.model_config_snapshot
  useEffect(() => {
    if (known) return
    let alive = true
    void api.run(run.id).then((detail) => { if (alive) setRead({ id: run.id, snapshot: detail.model_config_snapshot, error: null }) },
      (e) => { if (alive) setRead({ id: run.id, snapshot: null, error: e instanceof Error ? e.message : String(e) }) })
    return () => { alive = false }
  }, [run.id, known])
  if (known) return { snapshot: known, error: null }
  return read && read.id === run.id ? read : { snapshot: null, error: null }
}

function thinkingLine(snapshot: Snapshot | null, error: string | null, fallback: string | null | undefined): string {
  if (!snapshot) return error ? `Unavailable: ${error}` : 'Loading the run\'s record…'
  const requested = 'thinking' in snapshot ? snapshot.thinking : fallback
  const sent = snapshot.thinking_sent
  return `requested: ${requested == null ? 'provider default / not recorded' : String(requested)} · sent: ${sent === undefined ? 'not recorded' : sent === null ? 'none' : String(sent)}`
}

/** Evidence belongs to the existing run/participant, not a second simulation of the conversation. */
export function InteractionEvidence({ run, turn }: { run: StepRun; turn: InteractionTurn }) {
  const { node, participant, interaction } = turn
  const workspaceId = node.workspace_id ?? run.workspace_id
  const { workspace, error } = useInteractionWorkspace(workspaceId)
  const { snapshot, error: snapshotError } = useSnapshot(run)
  const mount = sourceMount(workspace)
  return <div className="activity-detail" data-testid="node-evidence">
    <dl className="kv">
      <dt>Participant</dt><dd>{participantName(interaction, participant.id)} · <code>{participant.id}</code></dd>
      <dt>Route</dt><dd data-testid="node-route"><code>{run.model}</code>{snapshot?.model ? ` · configured model ${String(snapshot.model)}` : ''}</dd>
      <dt>Thinking</dt><dd data-testid="node-thinking">{thinkingLine(snapshot, snapshotError, participant.thinking)}</dd>
      <dt>Boundary</dt><dd data-testid="node-boundary">{isolationLine(interaction, workspace) ?? (interaction.in_place ? 'Works in the session folder; not an isolated output.' : 'Works under the recorded workspace and run permissions.')}</dd>
      {mount && <><dt>Read-only source</dt><dd data-testid="node-source">{mount.root ?? 'path not reported'}{mount.name ? ` · mounted as ${mount.name}/` : ''}</dd></>}
      <dt>Output folder</dt><dd data-testid="node-output">{workspace?.path ?? (error ? `Unavailable: ${error}` : workspaceId ? 'Loading workspace path…' : 'Not allocated yet')}</dd>
      <dt>Record</dt><dd><code>{run.id}</code> · step {node.id} · wave {node.wave} · workspace <code>{workspaceId ?? 'not allocated'}</code> · {run.status}</dd>
    </dl>
    {run.error && <p className="err">{run.error}</p>}
    {node.instruction && <details data-testid="node-instruction"><summary>Instructions as sent</summary><pre className="relay-message">{node.instruction}</pre></details>}
    {node.receives.length > 0 && <div data-testid="node-originals">Original stage records: {node.receives.map((id) => {
      const from = interaction.nodes.find((n) => n.id === id)
      return <span key={id}>{from?.run_ids.map((runId) => <button key={runId} className="thread-btn" onClick={() => jumpToRun(runId)}>{id} · {runId}</button>) ?? `${id}: record unavailable`}</span>
    })}</div>}
  </div>
}
