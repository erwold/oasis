/** The relay as the page reads it (pure, so node --test exercises it): which turn of which relay a run is, what
 *  each participant's row says, what the chain's own line says, what the header and the composer take as busy, and
 *  the send key's signature with the agents and the rounds in it. */

import { participantNames } from '@oasis-code/contract'
import type { Relay, RelayParticipant, RelayStep } from '@oasis-code/contract'
import type { Run } from '../api/types'

export type { Relay, RelayParticipant, RelayStep }

export interface RelayTurn {
  relay: Relay
  step: RelayStep
  participant: RelayParticipant
  /** the relay's very first run: the person's message stands over it */
  first: boolean
  /** a turn run again after the person's decision or a restart (the harness's message opens it) */
  rerun: boolean
  /** the newest run of the whole relay: the chain's board stands under it */
  latest: boolean
}

/** The short id a participant is named by (A, B, …): the record's, or by position for an earlier record without one. */
/** The name a person reads for a relay's participant: its label, and its place when two share it. */
export function relayParticipantName(relay: Relay, index: number): string {
  return participantNames(relay.participants.map((p, i) => ({ id: participantId(relay, i), label: p.label }))).get(participantId(relay, index)) ?? relay.participants[index]?.label ?? '?'
}

export function participantId(relay: Relay, index: number): string {
  return relay.participants[index]?.id || String.fromCharCode(65 + index)
}

function runsOf(relay: Relay): string[] {
  return relay.steps.flatMap((s) => s.run_ids)
}

/** The relay turn a run is, or null for a run of its own. */
export function relayTurnOf(relays: Relay[], run: Pick<Run, 'id' | 'relay_id' | 'relay_step'>): RelayTurn | null {
  if (!run.relay_id || run.relay_step === null || run.relay_step === undefined) return null
  const relay = relays.find((r) => r.id === run.relay_id)
  if (!relay) return null
  const step = relay.steps.find((s) => s.seq === run.relay_step) ?? relay.steps[run.relay_step]
  if (!step) return null
  const participant = relay.participants[step.participant]
  if (!participant) return null
  const all = runsOf(relay)
  const first = all[0] === run.id || (all.length === 0 && step.seq === 0)
  const rerun = step.run_ids.length > 1 && step.run_ids[0] !== run.id
  const latest = all.length === 0 ? step.seq === 0 : all[all.length - 1] === run.id
  return { relay, step, participant, first, rerun, latest }
}

/** What a participant's row says: queued, working, done, waiting, stopped, failed. */
export function stepState(step: RelayStep, _participant: RelayParticipant): string {
  switch (step.status) {
    case 'queued': return 'queued'
    case 'running': return 'working'
    case 'done': return 'done'
    case 'waiting': return 'waiting for your decision'
    case 'cancelled': return 'stopped'
    case 'error': return 'failed'
    default: return step.status
  }
}

/** The chain's own line under its latest turn. */
export function relayLine(relay: Relay): string {
  const round = relay.rounds > 1 ? ` · round ${relay.round} of ${relay.rounds}` : ''
  const current = relay.steps[relay.current_step]
  const who = current ? relay.participants[current.participant] : undefined
  switch (relay.status) {
    case 'running': return `Relay${round} · ${who ? `${who.label} ${current && current.status === 'queued' ? 'is next' : stepState(current!, who)}` : 'running'}`
    case 'waiting': return `Relay${round} · paused: ${relay.reason ?? 'waiting for your decision'}`
    case 'interrupted': return `Relay${round} · interrupted: ${relay.reason ?? 'the harness restarted'}`
    case 'done': return `Relay done${relay.rounds > 1 ? ` · ${relay.rounds} rounds` : ''}`
    case 'cancelled': return `Relay stopped${relay.reason ? ` · ${relay.reason}` : ''}`
    case 'error': return `Relay failed${relay.reason ? ` · ${relay.reason}` : ''}`
    default: return `Relay · ${relay.status}`
  }
}

/** The header's word for a live relay turn: who is on, by label and short id, which turn. */
export function relayHeaderLine(relay: Relay): string {
  const current = relay.steps[relay.current_step]
  const who = current ? relay.participants[current.participant] : undefined
  if (!who || !current) return 'relay running'
  return `${relayParticipantName(relay, current.participant)} (turn ${current.seq + 1} of ${relay.steps.length})`
}

/** The relay under way in the session, if any (the composer and the header take it as busy even between two turns). */
export function activeRelay(relays: Relay[]): Relay | null {
  return relays.find((r) => r.status === 'running') ?? null
}

/** The relay's newest run (its last turn's run). */
export function latestRunOfRelay(relay: Relay): string | null {
  const all = runsOf(relay)
  return all.length ? all[all.length - 1]! : null
}

/** Whether the chain is still the latest thing said in the thread: the person's later words are not rewound past. */
export function relayIsLatest(relay: Relay, latestRunId: string | null): boolean {
  const own = latestRunOfRelay(relay)
  return own === null || latestRunId === null || own === latestRunId
}

/** Whether the page can offer to continue the relay, and what the button says (nothing once the conversation moved on). */
export function continueLabel(relay: Relay, maxRounds: number, latestRunId: string | null = null): string | null {
  if (!relayIsLatest(relay, latestRunId)) return null
  if (relay.status === 'waiting') return 'Continue'
  if (relay.status === 'interrupted') return 'Continue'
  if (relay.status === 'done' && relay.rounds < maxRounds) return 'One more round'
  return null
}

/** Whether the relays the page holds differ from the ones the harness answers (status, steps, rounds). */
export function relaysChanged(known: Relay[], fresh: Relay[]): boolean {
  if (known.length !== fresh.length) return true
  return known.some((r, i) => JSON.stringify(r) !== JSON.stringify(fresh[i]))
}
