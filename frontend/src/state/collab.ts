/** The collaboration model as the page reads it (pure, so node --test exercises it): one shape for every relation of a
 *  session — who a run belongs to (participant, conversation), who started it (origin), where it is shown (placement)
 *  and the typed edges between runs — whether the harness served it (GET /api/sessions/:id/collaboration, schema v25)
 *  or the page projected it from an older harness's rows (`legacyGraph`). The UI reads only this shape.
 *
 *  Rules kept here, never in a component:
 *  - an edge is shown as the kind it is: `cited` is a reference whose content was NOT handed over; `received` is an
 *    answer that WAS put into the later run's opening message; `after` is scheduling only. None is read off another.
 *  - the projection of older rows never invents a `cited` or a `received` edge (the old record has no such fact);
 *    what it infers carries `basis: 'inferred'` and says so.
 *  - a participant is the same only when its id is: two runs on one model are never merged by the model's name. */

import type {
  Anchor, CollabBasis, CollabEdge, CollabEndpoint, CollabGroup, CollabNode, CollabRun, CollaborationGraph, Conversation, DirectorTurn, DispatchEntry,
  DispatchItem, InteractionDetail, Origin, Participant, ParticipantRole, Relay, RunCollab, StatusCounts, ThreadItem,
} from '@oasis-code/contract'
import type { Run, RunTreeRow } from '../api/types'

export type { CollaborationGraph, CollabEdge, DispatchItem, DispatchEntry, ThreadItem, Participant, CollabRun }

export type CollabSource = 'graph' | 'legacy'
export interface CollabView { source: CollabSource; graph: CollaborationGraph }

const LIVE = new Set(['queued', 'running'])
const ENDED = new Set(['done', 'error', 'cancelled'])
type RunStatus = CollabRun['status']

// ---- the projection of an older harness's rows ---------------------------------------------------------------------

export interface LegacyInput {
  sessionId: string
  /** the session's own workspace: a run there works in the session folder (shared), never "isolated" */
  sessionWorkspaceId?: string | null
  tree: RunTreeRow[]
  runs: Pick<Run, 'id' | 'created_at' | 'resumes_run_id' | 'interaction_id' | 'interaction_node' | 'relay_id'>[]
  interactions: Pick<InteractionDetail, 'id' | 'status' | 'controller' | 'template' | 'then' | 'workspace_policy' | 'participants' | 'nodes' | 'created_at' | 'finished_at' | 'reason' | 'runs_started' | 'budget'>[]
  relays: Pick<Relay, 'id' | 'status' | 'rounds' | 'participants' | 'created_at' | 'finished_at'>[]
  turns: Pick<DirectorTurn, 'id' | 'dispatched_run_ids' | 'created_at'>[]
}

const origin = (o: Partial<Origin> & Pick<Origin, 'actor' | 'request'>): Origin => ({
  client: null, director_session_id: null, director_turn_id: null, tool_call_id: null, interaction_id: null, relay_id: null,
  watch_id: null, ui_task_id: null, parent_run_id: null, basis: 'projected', ...o,
})

const isCardRow = (r: Pick<RunTreeRow, 'work_order' | 'parent_run_id' | 'interaction_id' | 'spawned_by'>) =>
  r.spawned_by !== 'human_action' && r.interaction_id === null && (r.work_order !== null || r.parent_run_id !== null)

/** The runs in causal order: every run after the run it resumes (a resume chain is a fact of the record; two
 *  timestamps in one millisecond, or rows read out of order, are not), ties by creation time, then id. */
export function causalOrder<T extends Pick<RunTreeRow, 'id' | 'resumes_run_id' | 'created_at'>>(rows: T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  const out: T[] = []
  const placed = new Set<string>(), visiting = new Set<string>()
  const place = (r: T) => {
    if (placed.has(r.id) || visiting.has(r.id)) return
    visiting.add(r.id)
    const prev = r.resumes_run_id ? byId.get(r.resumes_run_id) : undefined
    if (prev) place(prev)
    visiting.delete(r.id)
    placed.add(r.id)
    out.push(r)
  }
  sorted.forEach(place)
  return out
}

type Owner = { id: string; role: ParticipantRole; basis: CollabBasis; conversation: string }
type ConvAcc = { id: string; participant: string; runs: string[]; forked_from: string | null; basis: CollabBasis; created_at: string }

/** The graph an older harness would have served, projected from what the page holds: the run tree, the thread's
 *  runs, the groups and the director's turns. Nothing is invented: no citation, no handover, no workspace fact the
 *  rows do not show; what is read off something the record cannot prove carries `basis: 'inferred'`.
 *  - A row that carries `collab` (a v25 harness whose graph route failed) keeps what it says: its participant, role,
 *    conversation (the id it names), group and basis.
 *  - Any other row: its participant by its own record (a group's step, a relay's turn, an order, a child; the thread's
 *    otherwise), never by a model's or a label's name; its conversation by the resume chain — no resume: a fresh
 *    conversation; resuming its participant's head: the same one; resuming an earlier run of its participant: a
 *    branch; resuming another participant: a new one from that history (participant_change). The page's ids are its
 *    own (`legacy:…`), never a harness's `pa_`/`cv_` ids. */
export function legacyGraph(input: LegacyInput): CollaborationGraph {
  const rows = input.tree.filter((r) => r.spawned_by !== 'plan' && r.kind !== 'plan' && r.kind !== 'decision')
  const byId = new Map(rows.map((r) => [r.id, r]))
  const dispatchedBy = new Map<string, string>()
  for (const t of input.turns) for (const id of t.dispatched_run_ids ?? []) dispatchedBy.set(id, t.id)
  const participants = new Map<string, Participant>()
  const owner = new Map<string, Owner | null>()
  const convs = new Map<string, ConvAcc>()
  const ixOf = (id: string | null) => (id ? input.interactions.find((ix) => ix.id === id) : undefined)
  const memberKey = (row: RunTreeRow): string | null => {
    if (row.interaction_id && row.interaction_node) {
      const node = ixOf(row.interaction_id)?.nodes.find((n) => n.id === row.interaction_node)
      const alias = node?.participant ?? row.participant_alias
      return alias ? `interaction:${row.interaction_id}:${alias}` : null
    }
    if (row.relay_id && row.participant_id) return `relay:${row.participant_id}`
    return null
  }
  const ensure = (id: string, role: ParticipantRole, row: RunTreeRow, basis: CollabBasis, group: Participant['group']): string => {
    if (!participants.has(id)) {
      participants.set(id, {
        id, session_id: input.sessionId, role, alias: role === 'member' ? (row.participant_alias ?? null) : null,
        label: role === 'main' ? 'the session\'s agent' : (row.participant_name ?? row.label ?? row.user_text_head ?? row.model ?? id),
        model: row.model, group, introduced_by: null, current_conversation_id: null, latest_run_id: null, state: 'idle', run_count: 0, basis, created_at: row.created_at,
      })
    }
    return id
  }
  const groupOf = (key: string, row: RunTreeRow): Participant['group'] =>
    key.startsWith('interaction:') ? { kind: 'interaction', id: row.interaction_id! } : key.startsWith('relay:') ? { kind: 'relay', id: row.relay_id! } : null
  const convAdd = (id: string, participant: string, runId: string, forked: string | null, basis: CollabBasis, at: string) => {
    const c = convs.get(id) ?? { id, participant, runs: [], forked_from: forked, basis, created_at: at }
    c.runs.push(runId)
    convs.set(id, c)
  }
  const headOfConv = (id: string) => convs.get(id)?.runs.at(-1) ?? null
  const ordered = causalOrder(rows)
  const forks = new Map<string, { reason: 'branch' | 'participant_change' | 'group_start'; basis: CollabBasis }>()
  for (const row of ordered) {
    const prev = row.resumes_run_id ? byId.get(row.resumes_run_id) : undefined
    const prevOwner = prev ? owner.get(prev.id) ?? null : null
    if (row.collab) {
      // what the harness projected or recorded for the row stands as it is said
      const c = row.collab
      if (c.participant_id === null || c.conversation_id === null) { owner.set(row.id, null); continue }
      const role = c.participant_role ?? 'main'
      ensure(c.participant_id, role, row, c.basis, c.placement.group)
      owner.set(row.id, { id: c.participant_id, role, basis: c.basis, conversation: c.conversation_id })
      const known = convs.has(c.conversation_id)
      convAdd(c.conversation_id, c.participant_id, row.id, known ? null : (prev ? prev.id : null), c.basis, row.created_at)
      if (prev && prevOwner && prevOwner.conversation !== c.conversation_id) forks.set(row.id, { reason: prevOwner.id === c.participant_id ? 'branch' : 'participant_change', basis: c.basis })
      continue
    }
    if (row.spawned_by === 'human_action') { owner.set(row.id, null); continue }
    // who: by the row's own record
    let who: { id: string; role: ParticipantRole; basis: CollabBasis }
    const member = memberKey(row)
    if (member) who = { id: ensure(`legacy:${member}`, 'member', row, 'projected', groupOf(member, row)), role: 'member', basis: 'projected' }
    else if (isCardRow(row)) {
      if (prevOwner && (prevOwner.role === 'separate' || prevOwner.role === 'child')) who = prevOwner
      else if (row.parent_run_id) who = { id: ensure(`legacy:child:${row.id}`, 'child', row, 'projected', null), role: 'child', basis: 'projected' }
      else who = { id: ensure(`legacy:separate:${row.id}`, 'separate', row, 'projected', null), role: 'separate', basis: 'projected' }
    } else if (prevOwner && prevOwner.role !== 'main' && row.workspace_id && prev?.workspace_id === row.workspace_id && row.workspace_id !== (input.sessionWorkspaceId ?? null)) {
      // a run of the thread resuming a participant's run in that participant's own folder: only a card's follow-up
      // through /resume makes one (an older harness detached it from its group) — that participant's, inferred. One in
      // the session folder may as well be the thread's next message after the group: the main agent's
      who = { id: prevOwner.id, role: prevOwner.role, basis: 'inferred' }
    } else who = { id: ensure('legacy:main', 'main', row, 'projected', null), role: 'main', basis: 'projected' }
    // which conversation: by the resume chain
    let conversation: string
    if (prev && prevOwner && prevOwner.id === who.id) {
      if (headOfConv(prevOwner.conversation) === prev.id) { conversation = prevOwner.conversation; convAdd(conversation, who.id, row.id, null, who.basis, row.created_at) }
      else {
        // an earlier run of its own resumed: a branch; which of two runs that resumed it in one millisecond came
        // first, the record cannot say
        const sibling = ordered.find((o) => o.id !== row.id && o.resumes_run_id === prev.id && owner.get(o.id)?.conversation === prevOwner.conversation)
        const tie = !!sibling && sibling.created_at === row.created_at
        conversation = `legacy-cv:${row.id}`
        convAdd(conversation, who.id, row.id, prev.id, tie || who.basis === 'inferred' ? 'inferred' : 'projected', row.created_at)
        forks.set(row.id, { reason: 'branch', basis: tie ? 'inferred' : 'projected' })
      }
    } else {
      conversation = `legacy-cv:${row.id}`
      convAdd(conversation, who.id, row.id, prev ? prev.id : null, who.basis, row.created_at)
      if (prev) forks.set(row.id, { reason: prevOwner?.role === 'main' && who.role === 'member' ? 'group_start' : 'participant_change', basis: 'projected' })
    }
    owner.set(row.id, { ...who, conversation })
  }
  // the participants' and conversations' state, read from their runs
  const conversations: Conversation[] = [...convs.values()].map((c) => ({
    id: c.id, session_id: input.sessionId, participant_id: c.participant, forked_from_run_id: c.forked_from, root_run_id: c.runs[0] ?? null,
    head_run_id: c.runs.at(-1) ?? null, run_ids: c.runs, tool_surface: null, basis: c.basis, created_at: c.created_at,
  }))
  const seqOf = new Map<string, number>()
  for (const c of conversations) c.run_ids.forEach((id, i) => seqOf.set(id, i + 1))
  for (const p of participants.values()) {
    const ids = ordered.filter((r) => owner.get(r.id)?.id === p.id).map((r) => r.id)
    const last = ids.length ? byId.get(ids[ids.length - 1]!) : undefined
    p.latest_run_id = last?.id ?? null
    p.current_conversation_id = last ? owner.get(last.id)?.conversation ?? null : null
    p.run_count = ids.length
    p.model = last?.model ?? p.model
    p.state = ids.some((id) => LIVE.has(byId.get(id)?.status ?? '')) ? 'running' : 'idle'
  }
  const runs: CollabRun[] = ordered.map((row) => {
    const o = owner.get(row.id) ?? null
    const collab: RunCollab = row.collab ?? {
      participant_id: o?.id ?? null, participant_role: o?.role ?? null, conversation_id: o?.conversation ?? null,
      conversation_seq: seqOf.get(row.id) ?? null, origin: originOf(row, dispatchedBy), placement: placementOf(row, o?.role ?? null, dispatchedBy, byId),
      basis: o?.basis ?? 'projected',
    }
    return {
      id: row.id, status: (row.status === 'waiting' ? 'queued' : row.status) as RunStatus, live: row.live, model: row.model ?? '', label: row.label, created_at: row.created_at,
      finished_at: row.finished_at, workspace_id: row.workspace_id, resumes_run_id: row.resumes_run_id, interaction_id: row.interaction_id,
      interaction_node: row.interaction_node, relay_id: row.relay_id, relay_step: row.relay_step, user_text_head: row.user_text_head,
      final_text_chars: row.receipt?.final_text ? row.receipt.final_text.length : null, error: row.error, collab,
    }
  })
  const edges: CollabEdge[] = []
  const edge = (e: Omit<CollabEdge, 'id' | 'basis' | 'created_at'> & { basis?: CollabEdge['basis']; created_at?: string }) => {
    edges.push({ basis: 'projected', created_at: byId.get(e.to.id)?.created_at ?? '', ...e, id: `legacy:${e.kind}:${e.from.id}>${e.to.id}` } as CollabEdge)
  }
  for (const r of runs) {
    const prev = r.resumes_run_id ? runs.find((x) => x.id === r.resumes_run_id) : undefined
    const fork = forks.get(r.id)
    if (prev && !fork && prev.collab.conversation_id && prev.collab.conversation_id === r.collab.conversation_id) {
      edge({ kind: 'continues', from: { kind: 'run', id: prev.id }, to: { kind: 'run', id: r.id }, meta: { conversation_id: r.collab.conversation_id }, basis: r.collab.basis === 'recorded' ? 'projected' : r.collab.basis })
    } else if (prev && fork) {
      edge({ kind: 'forks', from: { kind: 'run', id: prev.id }, to: { kind: 'run', id: r.id }, meta: { conversation_id: r.collab.conversation_id ?? '', reason: fork.reason }, basis: fork.basis === 'recorded' ? 'projected' : fork.basis })
    }
    const row = byId.get(r.id)!
    if (row.parent_run_id && byId.has(row.parent_run_id)) edge({ kind: 'spawned', from: { kind: 'run', id: row.parent_run_id }, to: { kind: 'run', id: r.id }, meta: {} })
    const turn = dispatchedBy.get(r.id)
    if (turn) edge({ kind: 'dispatched', from: { kind: 'director_turn', id: turn }, to: { kind: 'run', id: r.id }, meta: { tool: null, tool_call_id: null } })
  }
  // scheduling: which run of a step it depends on had ended when a run began is read off the node's run list as it is
  // now (a step run again later changes it) — inferred, never a recorded fact
  const nodes: CollabNode[] = []
  for (const ix of input.interactions) {
    for (const n of ix.nodes) {
      const pid = [...participants.values()].find((p) => p.group?.kind === 'interaction' && p.group.id === ix.id && p.alias === n.participant)?.id ?? null
      nodes.push({ id: `${ix.id}/${n.id}`, interaction_id: ix.id, node_id: n.id, kind: n.kind ?? 'plan', participant_id: pid, alias: n.participant, status: n.status,
                   run_ids: n.run_ids, current_run_id: n.run_id, depends_on: n.depends_on, receives: n.receives, receive_runs: n.receive_runs ?? [], cites: n.cites ?? [],
                   workspace: n.workspace, wave: n.wave })
      for (const runId of n.run_ids) {
        const started = byId.get(runId)?.created_at
        if (!started) continue
        for (const dep of n.depends_on) {
          const before = ix.nodes.find((d) => d.id === dep)?.run_ids.map((id) => byId.get(id)).filter((d): d is RunTreeRow => !!d && !!d.finished_at && d.finished_at <= started).at(-1)
          if (before) edge({ kind: 'after', from: { kind: 'run', id: before.id }, to: { kind: 'run', id: runId }, meta: { interaction_id: ix.id, from_node: dep, to_node: n.id }, basis: 'inferred' })
        }
      }
    }
  }
  const groups: CollabGroup[] = [
    ...input.interactions.map((ix): CollabGroup => ({
      kind: 'interaction', id: ix.id, status: ix.status, controller: ix.controller, template: ix.template, then: ix.then, workspace_policy: ix.workspace_policy ?? null,
      rounds: null, participant_ids: [...participants.values()].filter((p) => p.group?.kind === 'interaction' && p.group.id === ix.id).map((p) => p.id),
      runs_started: ix.runs_started, max_runs: ix.budget?.max_runs ?? null, concurrency: ix.budget?.concurrency ?? null, origin: null, anchor: null, reason: ix.reason, created_at: ix.created_at, finished_at: ix.finished_at,
    })),
    ...input.relays.map((relay): CollabGroup => ({
      kind: 'relay', id: relay.id, status: relay.status, controller: null, template: null, then: null, workspace_policy: null, rounds: relay.rounds,
      participant_ids: [...participants.values()].filter((p) => p.group?.kind === 'relay' && p.group.id === relay.id).map((p) => p.id),
      runs_started: 0, max_runs: null, concurrency: null, origin: null, anchor: null, reason: null, created_at: relay.created_at, finished_at: relay.finished_at,
    })),
  ]
  const inferred = runs.filter((r) => r.collab.basis === 'inferred' || r.collab.origin.basis === 'inferred').length + edges.filter((e) => e.basis === 'inferred').length
  const graph: CollaborationGraph = {
    session_id: input.sessionId, revision: 'legacy', main_participant_id: [...participants.values()].find((p) => p.role === 'main')?.id ?? null,
    actors: [{ kind: 'person' }], participants: [...participants.values()], conversations, groups, runs, nodes, edges, thread_items: [],
    legacy: { projected_runs: runs.filter((r) => !byId.get(r.id)?.collab).length, inferred_facts: inferred, notes: ['projected by the page from the rows it holds; ids are the page\'s own'] },
  }
  graph.thread_items = legacyThreadItems(graph, dispatchedBy, input.turns)
  return graph
}

/** Who started an older row, as far as its record shows: a director turn that lists it, a connector, a watch, the
 *  scheduler, a parent. `human` alone cannot tell the person in the app from any other client of the page's own
 *  routes: said as the person, inferred. */
function originOf(row: RunTreeRow, dispatchedBy: Map<string, string>): Origin {
  const turn = dispatchedBy.get(row.id) ?? null
  const request = row.work_order ? (row.resumes_run_id || row.work_order.resumes_run_id ? 'resume' : 'separate') : row.interaction_id ? 'node' : row.relay_id ? 'relay_turn' : row.spawned_by === 'wake' ? 'wake' : row.spawned_by === 'human_action' ? 'action' : 'message'
  if (turn) return origin({ actor: 'director', request, director_turn_id: turn })
  if (row.spawned_by === 'connector') return origin({ actor: 'connector', request })
  if (row.spawned_by === 'wake') return origin({ actor: 'watch', request: 'wake' })
  if (row.spawned_by === 'human_action') return origin({ actor: 'harness', request: 'action' })
  if (row.parent_run_id) return origin({ actor: 'agent', request: 'child', parent_run_id: row.parent_run_id })
  if (row.interaction_id || (row.relay_id && row.relay_step)) return origin({ actor: 'scheduler', request, interaction_id: row.interaction_id, relay_id: row.relay_id })
  return origin({ actor: 'person', request, basis: 'inferred' })
}

function placementOf(row: RunTreeRow, role: ParticipantRole | null, dispatchedBy: Map<string, string>, byId: Map<string, RunTreeRow>): RunCollab['placement'] {
  if (row.spawned_by === 'human_action') return { surface: 'record', group: null, anchor: null }
  if (row.interaction_id) return { surface: 'group', group: { kind: 'interaction', id: row.interaction_id }, anchor: { kind: 'interaction', id: row.interaction_id, basis: 'projected' } }
  if (row.relay_id) return { surface: 'thread', group: { kind: 'relay', id: row.relay_id }, anchor: null }
  if (role === 'separate' || role === 'child') {
    const turn = dispatchedBy.get(row.id)
    const anchor: Anchor | null = turn ? { kind: 'director_turn', id: turn, basis: 'projected' } : row.parent_run_id && byId.has(row.parent_run_id) ? { kind: 'run', id: row.parent_run_id, basis: 'projected' } : null
    return { surface: 'card', group: null, anchor }
  }
  return { surface: 'thread', group: null, anchor: null }
}

/** The thread's dispatch summaries an older harness would have served: the card runs a director turn started, one
 *  item per turn; every other card run (a person's, a connector's) one item of its own at its time. */
function legacyThreadItems(graph: CollaborationGraph, dispatchedBy: Map<string, string>, turns: LegacyInput['turns']): ThreadItem[] {
  const cards = graph.runs.filter((r) => r.collab.placement.surface === 'card')
  const byTurn = new Map<string, CollabRun[]>()
  const items: DispatchItem[] = []
  for (const r of cards) {
    const turn = dispatchedBy.get(r.id)
    if (turn) byTurn.set(turn, [...(byTurn.get(turn) ?? []), r])
    else items.push(dispatchItemOf(`legacy:${r.id}`, r.created_at, r.collab.placement.anchor, r.collab.origin, [r]))
  }
  for (const [turnId, runs] of byTurn) {
    const at = turns.find((t) => t.id === turnId)?.created_at ?? runs[0]!.created_at
    items.push(dispatchItemOf(`legacy:${turnId}`, at, { kind: 'director_turn', id: turnId, basis: 'projected' }, runs[0]!.collab.origin, runs))
  }
  return items.sort((a, b) => a.at.localeCompare(b.at))
}

function dispatchItemOf(id: string, at: string, anchor: Anchor | null, o: Origin, runs: CollabRun[]): DispatchItem {
  const entries: DispatchEntry[] = runs.map((r) => ({
    run_id: r.id, participant_id: r.collab.participant_id, label: r.label, model: r.model, status: r.status, surface: r.collab.placement.surface,
    user_text_head: r.user_text_head, finished_at: r.finished_at, focus: { participant_id: r.collab.participant_id, run_id: r.id },
  }))
  return { kind: 'dispatch', id, at, anchor, origin: o, entries, counts: countStatuses(entries.map((e) => e.status)) }
}

// ---- reading the view ---------------------------------------------------------------------------------------------

/** The counts of a list of statuses (every status in its own bucket; the total is the list's length). */
export function countStatuses(statuses: string[]): StatusCounts {
  const counts: StatusCounts = { queued: 0, running: 0, done: 0, error: 0, cancelled: 0, total: statuses.length }
  for (const s of statuses) if (s === 'queued' || s === 'running' || s === 'done' || s === 'error' || s === 'cancelled') counts[s] += 1
  return counts
}

/** Every edge into and out of a run. */
export function edgesOfRun(graph: Pick<CollaborationGraph, 'edges'>, runId: string): { incoming: CollabEdge[]; outgoing: CollabEdge[] } {
  return {
    incoming: graph.edges.filter((e) => e.to.kind === 'run' && e.to.id === runId),
    outgoing: graph.edges.filter((e) => e.from.kind === 'run' && e.from.id === runId),
  }
}

/** The runs a run was handed (whole or cut) and the runs it only cites: two lists, never one. */
export function handoverOf(graph: Pick<CollaborationGraph, 'edges'>, runId: string): { received: Extract<CollabEdge, { kind: 'received' }>[]; cited: Extract<CollabEdge, { kind: 'cited' }>[] } {
  const into = graph.edges.filter((e) => e.to.id === runId)
  return {
    received: into.filter((e): e is Extract<CollabEdge, { kind: 'received' }> => e.kind === 'received' && e.meta.content_delivered === true),
    cited: into.filter((e): e is Extract<CollabEdge, { kind: 'cited' }> => e.kind === 'cited'),
  }
}

const chars = (n: number | null) => (n === null ? '?' : n.toLocaleString('en-US'))

/** One edge in words, from the later run's side: what came to it from the earlier end. The cited wording never says
 *  received, and the received wording always says how much was handed. */
export function edgeLine(edge: CollabEdge, name: (endpoint: CollabEndpoint) => string): string {
  const from = name(edge.from)
  let line: string
  switch (edge.kind) {
    case 'received': line = edge.meta.packet === 'cut'
      ? `received ${from}'s answer, cut to ${chars(edge.meta.handed_chars)} of ${chars(edge.meta.answer_chars)} chars`
      : `received ${from}'s answer in full (${chars(edge.meta.handed_chars ?? edge.meta.answer_chars)} chars)`; break
    case 'cited': line = `cites ${from}'s answer${edge.meta.note ? ` — “${edge.meta.note}”` : ''} · reference only, content not handed over`; break
    case 'after': line = `ran after ${from} ended · scheduling only, nothing handed over`; break
    case 'continues': line = `continues ${from} in the same conversation`; break
    case 'forks': line = `starts from ${from}'s history (${edge.meta.reason === 'group_start' ? 'the group\'s starting point' : edge.meta.reason === 'branch' ? 'a branch of its own' : 'another participant\'s history'})`; break
    case 'dispatched': line = `started by ${from}${edge.meta.tool ? ` (${edge.meta.tool})` : ''}`; break
    case 'spawned': line = `dispatched by ${from}`; break
    case 'workspace': line = workspaceLine(edge.meta.mode, from); break
    case 'note': line = `your note was handed to it`; break
    case 'adopted': line = `kept into the session folder · ${edge.meta.status}`; break
  }
  return `${line}${edge.basis === 'inferred' ? ' · inferred' : edge.basis === 'projected' ? ' · from older records' : ''}`
}

export function workspaceLine(mode: Extract<CollabEdge, { kind: 'workspace' }>['meta']['mode'], from = 'a checkpoint'): string {
  switch (mode) {
    case 'checkpoint_copy': return `works on its own copy, made from ${from}`
    case 'same_workspace': return `works in ${from}'s folder (shared, not isolated)`
    case 'source_mount': return 'writes to an output folder of its own; the source folder is mounted read-only'
    case 'session_folder': return 'works in the session folder (shared, not isolated)'
  }
}

/** The participant a run belongs to (null: a person's recorded action — nothing to continue). */
export function participantOfRun(graph: Pick<CollaborationGraph, 'runs' | 'participants'>, runId: string): Participant | null {
  const pid = graph.runs.find((r) => r.id === runId)?.collab.participant_id
  return pid ? graph.participants.find((p) => p.id === pid) ?? null : null
}

/** The run a participant's next message continues (its conversation's head), as the graph says it. */
export function headOf(graph: Pick<CollaborationGraph, 'participants' | 'conversations'>, participantId: string): string | null {
  const p = graph.participants.find((x) => x.id === participantId)
  if (!p) return null
  const conv = graph.conversations.find((c) => c.id === p.current_conversation_id)
  return conv?.head_run_id ?? p.latest_run_id
}

/** The graph as the replay shows it at `cursor`: what existed by then (runs, participants, edges, summaries by their
 *  creation time); a run's status from the replayed rows (`statusAt`), unknown otherwise. The graph is the harness's
 *  current record cut by time — not a snapshot of the past (a plan's later revisions are not undone). */
export function graphAt(graph: CollaborationGraph, cursor: number, statusAt: (runId: string) => string | undefined): CollaborationGraph {
  const by = (t: string | null | undefined) => !t || Date.parse(t) <= cursor
  const runs = graph.runs.filter((r) => by(r.created_at)).map((r) => {
    const s = statusAt(r.id)
    return { ...r, status: (s && s !== 'waiting' ? s : r.status) as RunStatus, finished_at: r.finished_at && by(r.finished_at) ? r.finished_at : null }
  })
  const ids = new Set(runs.map((r) => r.id))
  const endpointThere = (e: CollabEndpoint) => e.kind !== 'run' || ids.has(e.id)
  return {
    ...graph,
    participants: graph.participants.filter((p) => by(p.created_at)),
    conversations: graph.conversations.filter((c) => by(c.created_at)).map((c) => ({ ...c, run_ids: c.run_ids.filter((id) => ids.has(id)) })),
    runs,
    nodes: graph.nodes.map((n) => ({ ...n, run_ids: n.run_ids.filter((id) => ids.has(id)) })),
    edges: graph.edges.filter((e) => by(e.created_at) && endpointThere(e.from) && endpointThere(e.to)),
    thread_items: graph.thread_items.filter((t) => by(t.at)).map((t) => t.kind === 'dispatch'
      ? { ...t, entries: t.entries.filter((e) => ids.has(e.run_id)).map((e) => ({ ...e, status: (runs.find((r) => r.id === e.run_id)?.status ?? e.status) })) }
      : t).map((t) => (t.kind === 'dispatch' ? { ...t, counts: countStatuses(t.entries.map((e) => e.status)) } : t)),
  }
}

/** Is a run's status one that ended? */
export const ended = (status: string) => ENDED.has(status)
