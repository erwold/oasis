import type { CSSProperties } from 'react'
import { botColor, memberBot } from '../state/outline'
import { nodePresence, nodeRunOf } from '../state/presence'
import { useStore } from '../state/store'
import { BotImage, useRunPresence } from './BotImage'
import { nodeState, participantName, stripWaves, type InteractionDetail, type InteractionNode } from '../state/interaction'

/** The interaction's steps as a strip, wave by wave: each step wears its participant's bot — playing its step's state,
 *  its line filled once done, an empty slot while it waits — and the wave under way stands under the playhead. A
 *  step that ran takes the thread to its run. */
export function InteractionStrip({ interaction }: { interaction: InteractionDetail }) {
  const { waves, current } = stripWaves(interaction)
  if (!waves.length) return null
  return (
    <div className="ix-strip" data-testid="interaction-strip">
      {waves.map(({ wave, nodes }) => (
        <div key={wave} className={`ix-wave${wave === current ? ' is-current' : ''}`} style={{ flexGrow: nodes.length }} data-wave={wave}>
          <div className="ix-wave-steps">
            {nodes.map((n) => <Step key={n.id} interaction={interaction} node={n} />)}
          </div>
          <span className="ix-wave-label">wave {wave}</span>
        </div>
      ))}
    </div>
  )
}

function modelOf(interaction: InteractionDetail, node: InteractionNode): string | null {
  return interaction.participants.find((p) => p.id === node.participant)?.model ?? null
}

function Step({ interaction, node }: { interaction: InteractionDetail; node: InteractionNode }) {
  // the participant's one bot (its stable id's when the harness names it; else the one its handle in the group picks)
  const bot = memberBot({ kind: 'interaction', id: interaction.id }, node.participant, modelOf(interaction, node))
  const name = participantName(interaction, node.participant)
  const runId = node.run_id
  // the step's bot: its current run (the newest the page knows of the node — its record may lag the run's stream)
  // while in line or at work; else the node's own word (a decision owed, a watch, the line), else the run's ending
  const current = useStore((s) => nodeRunOf(node, interaction.id, s.tree, s.runs))
  const status = useStore((s) => (current ? (s.runs.find((r) => r.id === current) ?? s.tree.find((r) => r.id === current))?.status ?? null : null))
  const runState = useRunPresence(status ? current : null)
  const state = nodePresence(node, status ? { status, state: runState } : null)
  const show = () => document.querySelector(`[data-testid="run-${runId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return (
    <button type="button" className={`ix-step is-${node.status}`} style={{ '--bot': botColor(bot) } as CSSProperties} disabled={!runId} onClick={show}
            title={`${name} · ${node.kind === 'followup' ? 'follow-up' : 'step'} ${node.id} · ${nodeState(node)}`} data-testid="interaction-step" data-node={node.id} data-status={node.status} data-kind={node.kind ?? 'plan'}>
      {bot && <BotImage bot={bot} state={state} />}
      <span className="ix-step-bar" />
    </button>
  )
}
