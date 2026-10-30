/** The interaction as the page reads it (pure, so node --test exercises it): which node of which interaction a run
 *  is, what each node's row says, what the board's own line says, what the header and the composer take as busy, and
 *  the plan in words — from the persisted nodes, never from a model's account of them. */

import { wordsSaidToDirector } from './director.ts'
import { CHATGPT_WEB_ID, participantNames, type Attribution, type DirectorNote, type DirectorTurn, type Interaction, type InteractionDetail, type InteractionNode, type InteractionNote, type InteractionParticipant, type ScheduleNode } from '@oasis-code/contract'
import type { Run } from '../api/types'
import { adoptionBoundaryKnown, isolatedWorkspace, protectsSource } from './workspacePolicy.ts'
import { uncountedNote, uncountedRequests } from './thread.ts'

export type { Interaction, InteractionDetail, InteractionNode, InteractionNote, InteractionParticipant }

/** How the agents named in a message work together: the director plans it (guided), every one alone on its own copy
 *  (independent), alone first and then reading each other's answers and responding over the exchange rounds chosen
 *  (discussion), or one after another as a relay (turns, over the rounds chosen). */
export type Orchestration = 'director' | 'independent' | 'discussion' | 'turns'
export const ORCHESTRATIONS: Orchestration[] = ['director', 'independent', 'discussion', 'turns']
/** A discussion's exchange rounds (the interaction body's `cross_rounds`). */
export const MAX_CROSS_ROUNDS = 4

export function orchestrationLabel(mode: Orchestration): string {
  switch (mode) {
    case 'director': return 'Guided'
    case 'independent': return 'Independently, then I choose'
    case 'discussion': return 'Discuss'
    case 'turns': return 'Take turns'
  }
}

/** The chip's text: the way, and how many runs it makes — the relay's turns, the template's one per participant, the
 *  director's up to the budget. */
export function orchestrationChipText(mode: Orchestration, participants: number, rounds: number, maxRuns: number): string {
  switch (mode) {
    case 'director': return `Guided · up to ${maxRuns} runs`
    case 'independent': return `Independently · ${participants} runs`
    case 'discussion': return `Discuss · ${rounds} exchange${rounds === 1 ? '' : 's'} · ${participants * (rounds + 1)} runs`
    case 'turns': return `Take turns · ${participants * rounds} runs`
  }
}


/** The name a person reads for a participant of the interaction: its label, and its place when two share it. The id
 *  (`pt_…`) is the harness's and the model's. */
export function participantName(interaction: Pick<InteractionDetail, 'participants'>, id: string): string {
  return participantNames(interaction.participants).get(id) ?? id
}

/** What the harness measured of a step's run, after the cost words: the files changed, the checks, the checkpoint. */
export function nodeFacts(receipt: { mechanical?: { checks?: { passed: number; failed: number; unknown: number } | null; diff?: { attribution?: Attribution | null } | null } | null; produced?: { files_changed?: unknown[] | null; final_checkpoint_id?: string | null } | null } | null): string {
  if (!receipt) return ''
  const files = receipt.produced?.files_changed?.length ?? 0
  // changes that cannot be told apart are never "0 files changed"; a partial count says it is one
  const attribution = receipt.mechanical?.diff?.attribution
  const parts = [attribution === 'unavailable' ? 'changes not attributable' : `${files} file${files === 1 ? '' : 's'} changed${attribution === 'partial' ? ' (partial)' : ''}`]
  const checks = receipt.mechanical?.checks
  if (checks) {
    parts.push(`${checks.passed} passed`)
    if (checks.failed) parts.push(`${checks.failed} failed`)
    if (checks.unknown) parts.push(`${checks.unknown} unknown`)
  }
  const cp = receipt.produced?.final_checkpoint_id
  if (cp) parts.push(cp.slice(0, 7))
  return parts.join(' · ')
}

/** `inPlace`: the session edits its folder in place, where no step has a copy of its own. */
export function orchestrationHint(mode: Orchestration, inPlace = false): string {
  switch (mode) {
    case 'director': return 'The director reads your words once and commits a plan: the runs, their order, what each receives. The harness runs it; the director is asked again only at a decision it cannot make from the plan.'
    case 'independent': return inPlace
      ? 'Each works alone in this folder, edited in place: no copies, the writers take turns, nothing of the others handed on. You compare the answers.'
      : 'The same starting point, a separate copy of the files each, nothing shared. You compare and keep one.'
    case 'discussion': return inPlace
      ? 'Each answers alone in this folder, edited in place, then reads the others\' answers and responds; 1 to 4 exchanges. Each step\'s handover says what it was given.'
      : 'Each answers alone on its own copy, then reads the others\' answers and responds; 1 to 4 exchanges. Each step\'s handover says what it was given.'
    case 'turns': return 'Each participant speaks once, in the order named; 1 to 3 rounds. Every turn sees the turns before it.'
  }
}

export interface InteractionTurn {
  interaction: InteractionDetail
  node: InteractionNode
  participant: InteractionParticipant
  /** the node's first run (a later one carried it on after a decision or a restart) */
  first: boolean
  /** the newest run of the whole interaction: the board stands under it */
  latest: boolean
}

function runsOf(interaction: InteractionDetail): string[] {
  return interaction.nodes.flatMap((n) => n.run_ids)
}

/** The interaction node a run is, or null for a run of its own. */
export function interactionTurnOf(interactions: InteractionDetail[], run: Pick<Run, 'id' | 'interaction_id' | 'interaction_node'>): InteractionTurn | null {
  if (!run.interaction_id || !run.interaction_node) return null
  const interaction = interactions.find((ix) => ix.id === run.interaction_id)
  if (!interaction) return null
  const node = interaction.nodes.find((n) => n.id === run.interaction_node)
  if (!node) return null
  const participant = interaction.participants.find((p) => p.id === node.participant)
  if (!participant) return null
  const all = runsOf(interaction)
  return { interaction, node, participant, first: node.run_ids[0] === run.id, latest: all[all.length - 1] === run.id }
}

/** The interaction participant a run of its own continues — a director's follow-up resuming a participant's run,
 *  through any number of follow-ups — or null. It wears that participant's bot and id, as the participant's own turns do. */
export function continuedParticipant(interactions: InteractionDetail[], runs: Pick<Run, 'id' | 'resumes_run_id' | 'interaction_id' | 'interaction_node'>[], run: Pick<Run, 'resumes_run_id' | 'interaction_id'> & Partial<Pick<Run, 'interaction_node'>>): Pick<InteractionTurn, 'interaction' | 'participant'> | null {
  // a node's own run is its node's (interactionTurnOf); a run with the interaction's id but no node (a follow-up a
  // newer harness kept with its group without a node) still continues its participant along the resume chain
  if (run.interaction_id && run.interaction_node) return null
  const byId = new Map(runs.map((r) => [r.id, r]))
  const seen = new Set<string>()
  let cur = run.resumes_run_id ? byId.get(run.resumes_run_id) : undefined
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    const turn = interactionTurnOf(interactions, cur)
    if (turn) return { interaction: turn.interaction, participant: turn.participant }
    cur = cur.resumes_run_id ? byId.get(cur.resumes_run_id) : undefined
  }
  return null
}

/** The words each step was given beside the shared task, as sent, in plan order: who (with the step when one
 *  participant was given several) and the words. */
export function nodeInstructions(interaction: Pick<InteractionDetail, 'nodes'>): { node: string; who: string; text: string }[] {
  const given = [...interaction.nodes].sort((a, b) => a.seq - b.seq).filter((n) => n.instruction?.trim())
  const several = (p: string) => given.filter((n) => n.participant === p).length > 1
  return given.map((n) => ({ node: n.id, who: several(n.participant) ? `${n.participant} · ${n.id}` : n.participant, text: n.instruction!.trim() }))
}

/** What a node's row says. */
export function nodeState(node: InteractionNode): string {
  switch (node.status) {
    case 'queued': return node.depends_on.length ? `waits for ${node.depends_on.join(', ')}` : 'queued'
    case 'running': return 'working'
    case 'watching': return 'waits on its watch'
    case 'done': return 'done'
    case 'waiting': return 'waiting for your decision'
    case 'cancelled': return 'stopped'
    case 'error': return 'failed'
    default: return node.status
  }
}

/** Where a node works, in words. `inPlace`: the session edits its folder in place — every step works there, whatever
 *  its plan says. */
export function nodeCopy(node: InteractionNode, inPlace = false): string {
  if (inPlace || node.workspace === 'shared') return 'the session folder'
  if (node.workspace === 'own') return 'own copy'
  return `${node.workspace}'s copy`
}

/** What a node is handed: the answers of the nodes it receives, or nothing of the others. */
export function nodeReads(node: InteractionNode): string {
  return node.receives.length ? `reads ${node.receives.join(', ')}` : 'alone'
}

/** The interaction's own line under its board: its state and how many steps are done. Why it stands so is
 *  interactionReason's. */
export function interactionLine(interaction: InteractionDetail): string {
  const ended = interaction.nodes.filter((n) => n.status === 'done').length
  const progress = interaction.nodes.length ? ` · ${ended} of ${interaction.nodes.length} steps done` : ''
  switch (interaction.status) {
    case 'planning': return 'The director is planning the steps…'
    case 'running': return `Running${progress}`
    case 'deciding': return `Every step ended · the director is asked what comes next`
    case 'waiting': return `Paused${progress}`
    case 'interrupted': return `Interrupted${progress}`
    case 'done': return `Done${progress}`
    case 'cancelled': return `Stopped${progress}`
    case 'error': return `Failed${progress}`
    default: return interaction.status
  }
}

/** Why a paused, interrupted, stopped or failed interaction stands so; none for the others. */
/** Where a group stands, in one line: its state, the steps done, and — when it waits or ended badly — who it waits on
 *  or who failed, by name (the full reason, the plan's numbers and the usage go to the line's tooltip). */
export function groupStatusLine(interaction: InteractionDetail): string {
  if (interaction.status === 'planning' || interaction.status === 'deciding') return interactionLine(interaction)
  const nodes = interaction.nodes
  const names = (of: InteractionNode[]) => [...new Set(of.map((n) => participantName(interaction, n.participant)))].join(', ')
  const head: Record<string, string> = { running: 'Running', waiting: 'Paused', interrupted: 'Interrupted', done: 'Done', cancelled: 'Stopped', error: 'Failed' }
  const parts = [head[interaction.status] ?? interaction.status]
  if (nodes.length) parts.push(`${nodes.filter((n) => n.status === 'done').length} of ${nodes.length} done`)
  const failed = nodes.filter((n) => n.status === 'error')
  const stopped = nodes.filter((n) => n.status === 'cancelled')
  const deciding = nodes.filter((n) => n.status === 'waiting')
  const watching = nodes.filter((n) => n.status === 'watching')
  if (failed.length) parts.push(`${names(failed)} failed`)
  if (stopped.length && interaction.status !== 'cancelled') parts.push(`${names(stopped)} stopped`)
  if (deciding.length) parts.push(`${names(deciding)} waits for your decision`)
  if (watching.length) parts.push(`${names(watching)} waiting on a watch`)
  if (interaction.status === 'interrupted' && !failed.length) parts.push('cut off by a restart')
  return parts.join(' · ')
}

export function interactionReason(interaction: Pick<InteractionDetail, 'status' | 'reason'>): string | null {
  switch (interaction.status) {
    case 'waiting': return interaction.reason ?? 'waiting for you'
    case 'interrupted': return interaction.reason ?? 'the harness restarted'
    case 'cancelled': case 'error': return interaction.reason
    default: return null
  }
}

/** The header's word for a live interaction: how many steps work now, of how many. */
export function interactionHeaderLine(interaction: InteractionDetail): string {
  if (interaction.status === 'planning') return 'the director plans the steps'
  if (interaction.status === 'deciding') return 'the director decides what comes next'
  const w = waves(interaction)
  const running = interaction.nodes.filter((n) => n.status === 'running')
  const watching = interaction.nodes.filter((n) => n.status === 'watching')
  if (!running.length && !watching.length) return `wave ${w.current} of ${w.total} · ${interaction.nodes.filter((n) => n.status === 'done').length} of ${interaction.nodes.length} steps done`
  const names = (nodes: InteractionNode[]) => nodes.map((n) => participantName(interaction, n.participant)).join(', ')
  return [`wave ${w.current} of ${w.total}`, running.length ? `${names(running)} working` : null, watching.length ? `${names(watching)} waiting on a watch` : null].filter(Boolean).join(' · ')
}

/** The interactions under way in the session (several may be): their runs may start on their own, or their director
 *  is asked. */
export function activeInteractions(interactions: InteractionDetail[]): InteractionDetail[] {
  return interactions.filter((ix) => ix.status === 'planning' || ix.status === 'running' || ix.status === 'deciding')
}

/** An interaction under way in the session, if any (the first of them). */
export function activeInteraction(interactions: InteractionDetail[]): InteractionDetail | null {
  return activeInteractions(interactions)[0] ?? null
}

/** The interaction the person's notes went to before 2026-10-16 (the first under way, else one paused or interrupted,
 *  else the session's latest when it ended well). Notes no longer take it: they name their group (noteCandidates). */
export function notableInteraction(interactions: InteractionDetail[]): InteractionDetail | null {
  const latest = interactions.reduce<InteractionDetail | null>((a, b) => (a === null || b.created_at > a.created_at ? b : a), null)
  return activeInteraction(interactions) ?? interactions.find((ix) => ix.status === 'waiting' || ix.status === 'interrupted') ?? (latest?.status === 'done' ? latest : null)
}

/** Every group the person's notes may go to now: each one under way, paused or interrupted, and the session's latest
 *  when it ended well (a note to it starts another round) — in the order they were made. None is chosen here: with
 *  several, the person names the group (the composer's To chip), then its recipient. */
export function noteCandidates(interactions: InteractionDetail[]): InteractionDetail[] {
  const latest = interactions.reduce<InteractionDetail | null>((a, b) => (a === null || (b.created_at ?? '') > (a.created_at ?? '') ? b : a), null)
  const open = new Set(['planning', 'running', 'deciding', 'waiting', 'interrupted'])
  return interactions.filter((ix) => open.has(ix.status) || (ix === latest && ix.status === 'done'))
    .map((ix, i) => ({ ix, i })).sort((a, b) => (a.ix.created_at ?? '').localeCompare(b.ix.created_at ?? '') || a.i - b.i).map(({ ix }) => ix)
}

/** A group as the To chip names it: its words' first line, cut at a word; two named alike keep apart by their order. */
export function groupLabel(interaction: Pick<InteractionDetail, 'id' | 'user_text'>, all: readonly Pick<InteractionDetail, 'id' | 'user_text'>[]): string {
  const words = (ix: Pick<InteractionDetail, 'id' | 'user_text'>) => {
    const line = (ix.user_text ?? '').trim().split(/\r?\n/)[0]?.trim() || ix.id
    if (line.length <= 30) return line
    const cut = line.slice(0, 30)
    const space = cut.lastIndexOf(' ')
    return `${space > 15 ? cut.slice(0, space) : cut}…`
  }
  const own = words(interaction)
  const alike = all.filter((ix) => words(ix) === own)
  return alike.length > 1 ? `${own} (${alike.findIndex((ix) => ix.id === interaction.id) + 1})` : own
}

/** Another round for the addressees of a note to a finished interaction (`everyone`, or one participant): each
 *  answers again after every participant's latest step, handed the others' latest answers, on its own copy. */
export function nextRound(interaction: Pick<InteractionDetail, 'participants' | 'nodes'>, to: string): ScheduleNode[] {
  const latest = interaction.participants.map((p) => interaction.nodes.filter((n) => n.participant === p.id && n.status === 'done').sort((a, b) => a.seq - b.seq).at(-1)).filter((n): n is InteractionNode => !!n)
  const taken = new Set(interaction.nodes.map((n) => n.id))
  const round = 1 + Math.max(0, ...interaction.nodes.map((n) => Number(/^cross-(\d+)-/.exec(n.id)?.[1] ?? 0)))
  return interaction.participants.flatMap((p, i) => {
    if (to !== 'everyone' && to !== p.id) return []
    let id = `cross-${round}-${i + 1}`
    for (let k = 2; taken.has(id); k += 1) id = `cross-${round}-${i + 1}-${k}`
    taken.add(id)
    return [{ id, participant: p.id, instruction: null, depends_on: latest.map((n) => n.id), receives: latest.filter((n) => n.participant !== p.id).map((n) => n.id), workspace: 'own' as const }]
  })
}

/** Whether the page can offer to continue the interaction, and what the button says. */
export function continueInteractionLabel(interaction: InteractionDetail): string | null {
  if (interaction.status === 'waiting') return interaction.nodes.length ? 'Continue' : 'Ask the director again'
  if (interaction.status === 'interrupted') return 'Continue'
  return null
}

/** Whether a node's result can be adopted into the session's folder: it ended well on a copy of its own (or another's). */
export function adoptable(interaction: InteractionDetail, node: InteractionNode, sessionWorkspaceId: string | null, workspace?: unknown): boolean {
  if (protectsSource(workspace) || (isolatedWorkspace(interaction) && !adoptionBoundaryKnown(workspace))) return false
  if (node.status !== 'done' || !node.run_id) return false
  if (node.workspace_id === null || node.workspace_id === sessionWorkspaceId) return false
  return interaction.status === 'done' || interaction.status === 'waiting' || interaction.status === 'cancelled' || interaction.status === 'error' || interaction.status === 'interrupted'
}

/** Whether the interactions the page holds differ from the ones the harness answers. */
export function interactionsChanged(known: InteractionDetail[], fresh: InteractionDetail[]): boolean {
  if (known.length !== fresh.length) return true
  return known.some((ix, i) => JSON.stringify(ix) !== JSON.stringify(fresh[i]))
}

/** The session's tree names a group step's run its interactions as the page holds them do not know yet (the step
 *  started, or the group, since they were read): a card would show the run beside a stale record of its group. */
export function interactionsBehind(interactions: InteractionDetail[], rows: Pick<Run, 'id' | 'interaction_id' | 'interaction_node'>[]): boolean {
  return rows.some((row) => {
    if (!row.interaction_id || !row.interaction_node) return false
    const node = interactions.find((ix) => ix.id === row.interaction_id)?.nodes.find((n) => n.id === row.interaction_node)
    return !node || !node.run_ids.includes(row.id)
  })
}

/** The plan in words, from the nodes: one line per node. */
export function planLines(interaction: InteractionDetail): string[] {
  return interaction.nodes.map((n) => {
    const after = n.depends_on.length ? ` after ${n.depends_on.join(', ')}` : ''
    return `${n.id}: ${participantName(interaction, n.participant)}${after}, ${nodeReads(n)}, on ${isolatedWorkspace(interaction) ? 'its own workspace' : nodeCopy(n, interaction.in_place && !isolatedWorkspace(interaction))}`
  })
}

/** The thread's items of an interaction, and where each stands: the request (the person's words and images) at the
 *  interaction's own time; the director's answer to the plan asked right after it, whenever its turn ended (the
 *  runs began while the director was still writing); a decision answer at its own time; the board — the plan's rows,
 *  the interaction's line, what the person can do — after the newest of its runs (right after the request while none
 *  ran). The notes of an interaction's turns are the interaction's, not the conversation's. */
export type InteractionItem =
  | { kind: 'interaction_request'; interaction: InteractionDetail; at: string }
  | { kind: 'interaction_note'; interaction: InteractionDetail; note: DirectorNote; asked: 'plan' | 'decision'; at: string }
  | { kind: 'interaction_board'; interaction: InteractionDetail; at: string }
  | { kind: 'interaction_words'; interaction: InteractionDetail; note: InteractionNote; at: string }

export function interactionItems(interactions: InteractionDetail[], runs: Pick<Run, 'id' | 'interaction_id' | 'created_at'>[], notes: DirectorNote[], turns: (Pick<DirectorTurn, 'id' | 'kind'> & Partial<Pick<DirectorTurn, 'envelope' | 'dispatched_interaction_ids'>>)[]): { items: InteractionItem[]; noteIds: Set<string> } {
  const items: InteractionItem[] = []
  const noteIds = new Set<string>()
  const interactionTurns = new Set(turns.filter((t) => t.kind === 'interaction').map((t) => t.id))
  // an interaction the person's message to the director started with their words unchanged: the words and files
  // already stand over the director's turn, so the interaction does not repeat them
  const saidToDirector = wordsSaidToDirector(turns)
  for (const interaction of interactions) {
    if (saidToDirector.get(interaction.id) !== interaction.user_text) items.push({ kind: 'interaction_request', interaction, at: interaction.created_at })
    const asked = new Map<string, 'plan' | 'decision'>()
    for (const e of interaction.events) {
      const turnId = typeof e.payload.turn_id === 'string' ? e.payload.turn_id : null
      if (turnId && (e.kind === 'plan_asked' || e.kind === 'decision_asked')) asked.set(turnId, e.kind === 'plan_asked' ? 'plan' : 'decision')
    }
    for (const note of notes) {
      if (!note.turn_id || !interactionTurns.has(note.turn_id) || !asked.has(note.turn_id)) continue
      const kind = asked.get(note.turn_id)!
      noteIds.add(note.id)
      items.push({ kind: 'interaction_note', interaction, note, asked: kind, at: kind === 'plan' ? `${interaction.created_at}~1` : note.created_at })
    }
    // the person's words to the members while it ran: theirs in the thread, at the time they were said
    for (const note of interaction.notes) items.push({ kind: 'interaction_words', interaction, note, at: note.created_at })
    const own = runs.filter((r) => r.interaction_id === interaction.id).map((r) => r.created_at).sort()
    items.push({ kind: 'interaction_board', interaction, at: own.length ? `${own[own.length - 1]!}~` : `${interaction.created_at}~2` })
  }
  return { items, noteIds }
}

/** The interaction that asked a director turn — for its plan or for what comes next — and where the turn's answer
 *  stands in the thread; null for a turn no interaction asked. A turn still with the director stands there already,
 *  so it never moves when its answer lands. */
export function interactionAskOf(interactions: InteractionDetail[], turnId: string): { interaction: InteractionDetail; asked: 'plan' | 'decision'; at: string } | null {
  for (const interaction of interactions) {
    for (const e of interaction.events) {
      if (e.payload.turn_id !== turnId || (e.kind !== 'plan_asked' && e.kind !== 'decision_asked')) continue
      const asked = e.kind === 'plan_asked' ? 'plan' : 'decision'
      return { interaction, asked, at: asked === 'plan' ? `${interaction.created_at}~1` : e.created_at }
    }
  }
  return null
}

/** The wave a node shares with others: the participants whose steps start alongside it (the same wave), by name. */
export function alongside(interaction: InteractionDetail, node: InteractionNode): string[] {
  return interaction.nodes.filter((n) => n.id !== node.id && n.wave === node.wave).map((n) => participantName(interaction, n.participant))
}

/** The handover line under a node's run: what it comes after (or alongside), where it works, what it received. */
export function handoverLine(interaction: InteractionDetail, node: InteractionNode): string {
  const base = interaction.base_checkpoint_id ? interaction.base_checkpoint_id.slice(0, 7) : 'the start'
  const where = isolatedWorkspace(interaction) ? 'its own workspace' : (interaction.in_place && !isolatedWorkspace(interaction)) || node.workspace === 'shared' ? 'the session folder' : node.workspace === 'own' ? `its own copy from ${base}` : `${node.workspace}'s copy, after it`
  const with_ = alongside(interaction, node)
  const order = node.depends_on.length ? `after ${node.depends_on.join(', ')}` : with_.length ? `starts alongside ${with_.join(', ')}` : 'starts first'
  const others = interaction.nodes.filter((n) => n.id !== node.id && n.wave < node.wave && !node.receives.includes(n.id)).map((n) => n.id)
  const got = node.receives.length ? `received ${node.receives.join(', ')}'s answer and tool calls${others.length ? `, not ${others.join(', ')}'s` : ''}` : 'sees your words only'
  return `${order} · ${where} · ${got}`
}

/** The packet manifest folded under a handover: what the harness handed the run, and what it did not. */
export function handoverManifest(interaction: InteractionDetail, node: InteractionNode, first: boolean): string {
  const handed = [first ? 'your request' : 'its own conversation so far', ...node.receives.map((id) => `${id}'s packet (the answer as written, one line per tool call, the measured facts)`)]
  if (node.instruction) handed.push("the director's note for the step")
  const kept = interaction.nodes.filter((n) => n.id !== node.id && !node.receives.includes(n.id)).map((n) => `${n.id}'s answer`)
  if (node.workspace !== 'shared' && (!interaction.in_place || isolatedWorkspace(interaction))) kept.push("the other copies' files")
  return `Handed: ${handed.join('; ')}.\nNot handed: ${kept.length ? kept.join('; ') : 'nothing else there was'}.`
}

/** The waves of an interaction: how many, and the one the strip's playhead stands over (the last when none is). */
export function waves(interaction: InteractionDetail): { total: number; current: number } {
  const total = Math.max(0, ...interaction.nodes.map((n) => n.wave))
  return { total, current: stripWaves(interaction).current ?? total }
}

/** How the participants work together, in a few words. */
export function interactionWay(interaction: Pick<InteractionDetail, 'controller' | 'template'>): string {
  return interaction.controller === 'director' ? 'guided' : interaction.template === 'independent' ? 'independent' : interaction.template === 'discussion' ? 'independent first, then exchange and respond' : 'a fixed plan'
}

/** The board's progress line, after the interaction's own: the wave, the concurrency, the runs used. Who works shows
 *  on the strip. */
export function boardLine(interaction: InteractionDetail): string {
  const w = waves(interaction)
  const parts: string[] = []
  if (w.total) parts.push(`wave ${w.current} of ${w.total}`)
  parts.push(`${interaction.budget.concurrency} at a time`, `${interaction.runs_started} of ${interaction.budget.max_runs} runs`)
  return parts.join(' · ')
}

/** The board's quiet line: the requests and tokens the finished runs counted (a run in flight is not yet counted),
 *  that the director's own are not among them, the revision. */
export function usageLine(interaction: InteractionDetail, runs: Pick<Run, 'id' | 'status' | 'usage'>[]): string {
  const own = runs.filter((r) => interaction.nodes.some((n) => n.run_ids.includes(r.id)))
  const counted = own.filter((r) => r.status !== 'running' && r.status !== 'queued')
  const inFlight = own.length - counted.length
  const sum = (of: typeof counted, key: string) => of.reduce((n, r) => n + (typeof r.usage[key] === 'number' ? (r.usage[key] as number) : 0), 0)
  // a run whose tokens are unknown (null) adds nothing to the sums, and its requests are among the uncounted ones
  const known = counted.filter((r) => typeof r.usage.input_tokens === 'number' || typeof r.usage.output_tokens === 'number')
  const uncounted = counted.reduce((n, r) => n + uncountedRequests(r.usage), 0)
  const requests = sum(counted, 'requests')
  const tokens = known.length ? `${sum(known, 'input_tokens')} in / ${sum(known, 'output_tokens')} out tokens` : 'tokens not reported'
  const parts: string[] = []
  if (counted.length) parts.push(`participants: ${requests} request${requests === 1 ? '' : 's'} · ${tokens}${uncounted && known.length ? ` (${uncountedNote(uncounted, requests)})` : ''}${inFlight ? ` · ${inFlight} run${inFlight === 1 ? '' : 's'} not yet counted` : ''}`)
  else if (inFlight) parts.push(`${inFlight} run${inFlight === 1 ? '' : 's'} not yet counted`)
  parts.push('director usage not included', `rev ${interaction.revision}`)
  return parts.join(' · ')
}

/** The strip's groups: the steps of each wave in their order, the waves in theirs, and the one the playhead stands
 *  over — the lowest wave with a step running, else with one that stopped, failed or waits for the person (what
 *  continue runs again), else with one queued; none when nothing is left. */
export function stripWaves(interaction: Pick<InteractionDetail, 'nodes'>): { waves: { wave: number; nodes: InteractionNode[] }[]; current: number | null } {
  const byWave = new Map<number, InteractionNode[]>()
  for (const n of [...interaction.nodes].sort((a, b) => a.wave - b.wave || a.seq - b.seq)) byWave.set(n.wave, [...(byWave.get(n.wave) ?? []), n])
  const lowest = (statuses: InteractionNode['status'][]) => {
    const at = interaction.nodes.filter((n) => statuses.includes(n.status)).map((n) => n.wave)
    return at.length ? Math.min(...at) : null
  }
  const current = lowest(['running', 'watching']) ?? lowest(['cancelled', 'error', 'waiting']) ?? lowest(['queued'])
  return { waves: [...byWave].map(([wave, nodes]) => ({ wave, nodes })), current }
}

/** Where a note to `to` would land: in a finished interaction, another round it starts; else, from the plan: each
 *  addressee's step in flight at its next request, else its next run (a step that stopped, failed or waits runs again
 *  first: sending the note continues a paused interaction), or that no run of it is left. */
export function noteLanding(interaction: InteractionDetail, to: string): string {
  const addressees = to === 'everyone' ? interaction.participants.map((p) => p.id) : [to]
  if (interaction.status === 'done') return `another round as this is sent · ${addressees.map((a) => participantName(interaction, a)).join(', ')} answer${addressees.length === 1 ? 's' : ''} again`
  const where = addressees.map((a) => {
    const nodes = interaction.nodes.filter((n) => n.participant === a)
    const queued = nodes.find((n) => n.status === 'queued')
    const running = nodes.find((n) => n.status === 'running')
    const again = nodes.find((n) => n.status === 'cancelled' || n.status === 'error' || n.status === 'waiting')
    const name = participantName(interaction, a)
    // while the plan runs, a member none of whose steps is still to come goes on in its conversation at once
    const ahead = nodes.some((n) => n.status === 'queued' || n.status === 'running' || n.status === 'watching')
    if (interaction.status === 'running' && !ahead && nodes.some((n) => n.run_id)) return `${name}: goes on now, in its own conversation`
    // a step in flight takes the words at its next request (ChatGPT on the web takes nothing while it works)
    const steerable = interaction.participants.find((p) => p.id === a)?.model !== CHATGPT_WEB_ID
    if (interaction.status === 'running' && running && steerable) return `${name}: ${running.id}, at its next request`
    if (again && !running) return `${name}: ${again.id} runs again as this is sent`
    if (queued && !running) return `${name}: next run (${queued.id})`
    if (queued) return `${name}: queued behind ${running!.id}`
    if (running) return `${name}: queued (no later run planned yet)`
    return `${name}: no run left; the director may plan one`
  })
  return where.join(' · ')
}

/** What a note's row says of its delivery, the participants by name. */
export function noteState(note: InteractionNote, interaction?: Pick<InteractionDetail, 'participants'>): string {
  return noteStateLine(note.status, Object.keys(note.delivered).map((id) => (interaction ? participantName(interaction, id) : id)).sort())
}

/** noteState's words from the status and the names of the addressees handed the note (already named and sorted): the
 *  session share says a group note's state with them from its snapshot (`delivered_to`). */
export function noteStateLine(status: InteractionNote['status'], delivered: readonly string[]): string {
  switch (status) {
    case 'queued': return 'queued'
    case 'partly': return `delivered to ${delivered.join(', ')}; queued for the rest`
    case 'delivered': return `delivered to ${delivered.join(', ')}`
    case 'undelivered': return 'not delivered: the interaction ended first'
  }
}

/** Where a group's steps work, as the composer offers it (the interaction body's `workspace_policy`): `legacy` — the
 *  session's own rule, as before (the composer's default: a folder edited in place stays in place, and Keep and undo
 *  work there); `isolated` — the rule the directors' groups use (a step's own workspace whatever the project: a copy;
 *  over a folder edited in place or an attached one, an output folder of its own over the folder mounted read-only).
 *  The words say what each means for this project's kind. */
export type GroupPolicy = 'legacy' | 'isolated'
export const GROUP_POLICIES: GroupPolicy[] = ['legacy', 'isolated']
export function groupPolicyLabel(policy: GroupPolicy, projectKind: string | null | undefined): string {
  const folder = projectKind === 'direct' || projectKind === 'attached'
  if (policy === 'legacy') return projectKind === 'direct' ? 'Shared folder' : 'As the session works'
  return folder ? 'Isolated · output folders' : 'Isolated copies'
}
export function groupPolicyHint(policy: GroupPolicy, projectKind: string | null | undefined): string {
  if (projectKind === 'direct') return policy === 'legacy'
    ? 'Every step works in this folder, edited in place; the writers take turns. Keep and undo work as they do for the thread.'
    : 'Each step writes to an output folder of its own and reads this folder live, read-only. Nothing is written back here: Keep cannot apply a result.'
  if (projectKind === 'attached') return policy === 'legacy'
    ? 'As the session works with the attached folder (unchanged from before).'
    : 'Each step writes to an output folder of its own and reads the attached folder live, read-only.'
  return policy === 'legacy'
    ? 'Each step on a copy of its own of the session\'s files, as before; Keep composes one back.'
    : 'Each step on a copy of its own, made from the session\'s checkpoint — the rule the directors\' groups use.'
}
