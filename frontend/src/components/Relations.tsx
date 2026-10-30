import { useMemo } from 'react'
import type { CollabEdge, CollabEndpoint, CollaborationGraph } from '@oasis-code/contract'
import { edgeLine, handoverOf } from '../state/collab'
import { useStore } from '../state/store'
import { revealRun } from './Desk'
import { focusTurn } from './focusTurn'
import { useCollabView } from './useCollab'

/** A jump to a run: the thread's own turn scrolls into view; a run on a card brings its card forward at that run. */
export function jumpToRun(runId: string): void {
  const thread = useStore.getState().runs.some((r) => r.id === runId)
  if (thread && focusTurn(runId)) return
  revealRun(runId)
}

/** How an edge's end is named: a run by its participant's name and the run's short id; the rest by kind. */
export function endpointNamer(graph: Pick<CollaborationGraph, 'runs' | 'participants' | 'nodes'> | null): (end: CollabEndpoint) => string {
  return (end) => {
    switch (end.kind) {
      case 'run': {
        const run = graph?.runs.find((r) => r.id === end.id)
        const p = run?.collab.participant_id ? graph?.participants.find((x) => x.id === run.collab.participant_id) : undefined
        return `${p?.label ?? run?.label ?? 'a run'} (run ${end.id.slice(4, 10)})`
      }
      case 'node': return `step ${end.id.split('/').pop()}`
      case 'director_turn': return 'a director turn'
      case 'checkpoint': return `checkpoint ${end.id.slice(0, 10)}`
      case 'workspace': return `workspace ${end.id.slice(0, 10)}`
      case 'person': return 'you'
      case 'note': return 'your note'
    }
  }
}

/** Under a run's turn (in the thread or on its card): what it was handed and what it only cites — two lists, never
 *  one; each a jump to the run it names. Nothing when it has neither. */
export function RunHandover({ runId }: { runId: string }) {
  const view = useCollabView()
  const graph = view?.graph ?? null
  const name = useMemo(() => endpointNamer(graph), [graph])
  if (!graph) return null
  const { received, cited } = handoverOf(graph, runId)
  if (!received.length && !cited.length) return null
  const row = (e: CollabEdge, kind: 'received' | 'cited') => (
    <div key={e.id} className={`activity-line run-handover is-${kind}`} data-testid={`edge-${kind}-${runId}-${e.from.id}`} data-delivered={kind === 'received' ? 'true' : 'false'}>
      <span className="run-handover-kind">{kind === 'received' ? 'handed over' : 'cited'}</span>
      <span className="line">{edgeLine(e, name)}</span>
      {e.from.kind === 'run' && <button type="button" className="link-btn" data-testid="edge-jump" onClick={() => jumpToRun(e.from.id)}>open</button>}
    </div>
  )
  return (
    <div className="run-handovers" data-testid={`run-handovers-${runId}`}>
      {received.map((e) => row(e, 'received'))}
      {cited.map((e) => row(e, 'cited'))}
    </div>
  )
}

/** Beside an ended run (in the thread, on a card): the next message may cite it — named to the agent, nothing of it
 *  sent — or hand its answer over — its final answer sent whole in the message. Offered only by a harness that records
 *  references (schema v25); never in a replay. */
export function ReferenceButtons({ runId, status }: { runId: string; status: string }) {
  const graph = useStore((s) => s.collab.status === 'graph')
  const replaying = useStore((s) => s.replaying)
  const references = useStore((s) => s.references)
  const toggle = useStore((s) => s.toggleReference)
  if (!graph || replaying || !['done', 'error', 'cancelled'].includes(status)) return null
  const cited = references.cites.some((c) => c.run_id === runId)
  const handed = references.receive.includes(runId)
  return (
    <span className="ref-buttons">
      <button type="button" className={`turn-action ref-btn${cited ? ' on' : ''}`} aria-pressed={cited} data-testid={`cite-run-${runId}`} onClick={() => toggle(runId, 'cite')}
              title={cited ? 'Cited by your next message — click to take it back' : 'Cite this run in your next message: the agent is told which run it is; its answer is not sent'}>cite</button>
      <button type="button" className={`turn-action ref-btn${handed ? ' on' : ''}`} aria-pressed={handed} data-testid={`receive-run-${runId}`} onClick={() => toggle(runId, 'receive')}
              title={handed ? 'Handed over with your next message — click to take it back' : 'Hand this run\'s final answer over with your next message: it is sent whole, and adds to the input'}>hand over</button>
    </span>
  )
}

/** Over the composer: what the next message cites and what it hands over, apart; each can be taken back. */
export function ReferenceChips({ toAgent }: { toAgent: boolean }) {
  const references = useStore((s) => s.references)
  const toggle = useStore((s) => s.toggleReference)
  const clear = useStore((s) => s.clearReferences)
  const view = useCollabView()
  const name = useMemo(() => endpointNamer(view?.graph ?? null), [view])
  if (!references.cites.length && !references.receive.length) return null
  const chip = (runId: string, kind: 'cite' | 'receive') => (
    <span key={`${kind}-${runId}`} className={`ref-chip is-${kind}`} data-testid={`ref-chip-${kind}-${runId}`}>
      <span className="run-handover-kind">{kind === 'cite' ? 'cites' : 'hands over'}</span>{name({ kind: 'run', id: runId })}
      <button type="button" className="ref-chip-x" aria-label="Take it back" onClick={() => toggle(runId, kind)}>×</button>
    </span>
  )
  return (
    <div className="ref-chips" data-testid="reference-chips">
      {references.cites.map((c) => chip(c.run_id, 'cite'))}
      {references.receive.map((id) => chip(id, 'receive'))}
      <span className="dim small">{toAgent ? 'Cited runs are named to the agent, not sent; handed-over answers are sent whole.' : 'References go with a message to an agent or a separate task, not to the director or a note.'}</span>
      <button type="button" className="link-btn small" onClick={clear} data-testid="reference-clear">clear</button>
    </div>
  )
}
