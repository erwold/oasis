/** The collaboration graph of a session, read from its rows (docs/multi-agent-unification-design.md §9.3): a pure
 *  function of what the database holds — the same rows always give the same graph, and nothing is written back.
 *
 *  A run written by a v25 backend carries its participant, conversation, origin and placement (`recorded`); an older
 *  run gets them by the design's projection rules (`projected`), or by one of its named heuristics where the rows
 *  cannot tell (`inferred`, counted and named in `legacy`). Participant and conversation ids are derived the same way
 *  for both (collab_repo.ts), so a projected participant that a new run continues keeps its id. */

import {
  CollaborationGraphSchema, type CollabBasis, type CollabEdge, type CollabGroup, type CollabNode, type CollabRun, type CollaborationGraph,
  type Conversation, type DirectorSession, type DirectorTurn, type Interaction, type InteractionEvent, type InteractionNode, type InteractionNote,
  type Origin, type Participant, type ParticipantRole, type Placement, type Relay, type RunCollab, type StatusCounts, type ThreadItem,
  directorToolSurfaceOf,
} from '@oasis-code/contract'
import { conversationIdOf, edgeIdOf, participantIdOf, type ConversationRow, type EdgeRow, type ParticipantRow, type RunMeta } from '../db/collab_repo.ts'

export const MAX_PACKET_ANSWER_CHARS = 24_000

export interface CollabRows {
  session: { id: string; workspace_id: string | null; project_id: string; model: string }
  runs: RunMeta[]
  workspaces: { id: string; session_id: string | null; source_mount: boolean; kind: string }[]
  interactions: Interaction[]
  nodes: InteractionNode[]
  events: (InteractionEvent & { interaction_id: string })[]
  notes: InteractionNote[]
  relays: Relay[]
  directors: DirectorSession[]
  turns: DirectorTurn[]
  ui_task_runs: Record<string, string>
  wake_runs: Record<string, string>
  participants: ParticipantRow[]
  conversations: ConversationRow[]
  edges: EdgeRow[]
  live: Set<string>
  /** a route's label, for a participant shown by its model */
  labelOf?: (model: string) => string
}

/** One run's place: who it belongs to, which conversation, why it started and where it is shown. */
export interface Assigned {
  run_id: string
  participant_id: string | null
  key: string | null
  role: ParticipantRole | null
  alias: string | null
  group: { kind: 'interaction' | 'relay'; id: string } | null
  conversation_id: string | null
  seq: number | null
  /** the run whose history it continued in the same conversation */
  continues: string | null
  /** the run whose history a new conversation started from, and why */
  fork: { from: string; reason: 'group_start' | 'branch' | 'participant_change' } | null
  origin: Origin
  placement: Placement
  basis: CollabBasis
  /** which heuristic decided the participant (inferred / projected rules of the design) */
  rule: string | null
}

export interface ConversationState {
  id: string; participant_id: string; runs: string[]; forked_from_run_id: string | null; reason: string | null; basis: CollabBasis
  tool_surface: string | null; created_at: string
}

export interface ParticipantState {
  id: string; key: string; role: ParticipantRole; alias: string | null; group: { kind: 'interaction' | 'relay'; id: string } | null
  basis: CollabBasis; first_run: string | null; label: string | null; model: string | null; introduced_by: Origin | null; created_at: string
}

export interface Assignment {
  runs: Map<string, Assigned>
  conversations: Map<string, ConversationState>
  participants: Map<string, ParticipantState>
  main_participant_id: string
  notes: string[]
  inferred: number
}

const ENDED = new Set(['done', 'error', 'cancelled'])

const origin = (o: Partial<Origin> & Pick<Origin, 'actor' | 'request'>): Origin => ({
  client: null, director_session_id: null, director_turn_id: null, tool_call_id: null, interaction_id: null, relay_id: null,
  watch_id: null, ui_task_id: null, parent_run_id: null, basis: 'recorded', ...o,
})

const letter = (index: number): string => String.fromCharCode(65 + (index % 26))

export function mainKey(): string { return 'main' }
export function interactionKey(interactionId: string, alias: string): string { return `interaction:${interactionId}:${alias}` }
export function relayKey(relayId: string, alias: string): string { return `relay:${relayId}:${alias}` }
export function separateKey(firstRunId: string): string { return `separate:${firstRunId}` }
export function childKey(rootRunId: string): string { return `child:${rootRunId}` }

/** A relay step's participant alias, as the relay names it. */
export function relayAlias(relay: Relay, step: number | null): string | null {
  const s = relay.steps.find((x) => x.seq === step) ?? (step !== null ? relay.steps[step] : undefined)
  if (s === undefined) return null
  return relay.participants[s.participant]?.id || letter(s.participant)
}

/** Every run's participant and conversation, oldest first: recorded columns where the run has them, else the projection. */
export function assignRuns(rows: CollabRows): Assignment {
  const sid = rows.session.id
  const sessionWs = rows.session.workspace_id
  const mainId = participantIdOf(sid, mainKey())
  const byId = new Map(rows.runs.map((r) => [r.id, r]))
  const nodeByKey = new Map(rows.nodes.map((n) => [`${n.interaction_id}/${n.id}`, n]))
  const relays = new Map(rows.relays.map((r) => [r.id, r]))
  const directors = new Map(rows.directors.map((d) => [d.id, d]))
  const recordedParticipants = new Map(rows.participants.map((p) => [p.id, p]))
  const recordedConversations = new Map(rows.conversations.map((c) => [c.id, c]))
  const nativeDispatch = new Map<string, DirectorTurn>()
  for (const t of rows.turns) {
    if (directors.get(t.director_session_id)?.transport !== 'native') continue
    for (const runId of t.dispatched_run_ids) if (!nativeDispatch.has(runId)) nativeDispatch.set(runId, t)
  }
  const bridgeTurns = rows.turns.filter((t) => directors.get(t.director_session_id)?.transport === 'bridge' && t.started_at !== null)
  const out: Assignment = { runs: new Map(), conversations: new Map(), participants: new Map(), main_participant_id: mainId, notes: [], inferred: 0 }
  const counted = new Map<string, number>()
  const note = (rule: string, text: string) => {
    counted.set(rule, (counted.get(rule) ?? 0) + 1)
    if ((counted.get(rule) ?? 0) <= 3) out.notes.push(text)
  }
  const lastMainBefore = (run: RunMeta): string | null => {
    let last: string | null = null
    for (const a of out.runs.values()) if (a.role === 'main' && byId.get(a.run_id)!.created_at <= run.created_at) last = a.run_id
    return last
  }
  const ensureParticipant = (p: Omit<ParticipantState, 'first_run' | 'created_at' | 'label' | 'model'>, run: RunMeta): ParticipantState => {
    let st = out.participants.get(p.id)
    if (st === undefined) {
      const rec = recordedParticipants.get(p.id)
      st = { ...p, first_run: run.id, created_at: rec?.created_at ?? run.created_at, label: rec?.label || null, model: run.model || null, introduced_by: rec?.introduced_by ?? p.introduced_by }
      if (rec) { st.basis = 'recorded'; st.role = rec.role as ParticipantRole; st.alias = rec.alias; st.group = rec.group_kind ? { kind: rec.group_kind as 'interaction' | 'relay', id: rec.group_id! } : null }
      out.participants.set(p.id, st)
    }
    st.model = run.model || st.model
    return st
  }
  out.participants.set(mainId, { id: mainId, key: mainKey(), role: 'main', alias: null, group: null, basis: recordedParticipants.has(mainId) ? 'recorded' : 'projected', first_run: null, label: null, model: rows.session.model, introduced_by: null, created_at: recordedParticipants.get(mainId)?.created_at ?? '' })

  for (const run of rows.runs) {
    const prevA = run.resumes_run_id ? out.runs.get(run.resumes_run_id) ?? null : null
    let a: Assigned
    if (run.participant_id !== null && run.origin !== null && run.placement !== null) {
      // a v25 run: everything as written
      const rec = recordedParticipants.get(run.participant_id)
      const role = (rec?.role ?? 'main') as ParticipantRole
      const group = rec?.group_kind ? { kind: rec.group_kind as 'interaction' | 'relay', id: rec.group_id! } : null
      ensureParticipant({ id: run.participant_id, key: rec?.legacy_key ?? '?', role, alias: rec?.alias ?? null, group, basis: 'recorded', introduced_by: rec?.introduced_by ?? run.origin }, run)
      a = { run_id: run.id, participant_id: run.participant_id, key: rec?.legacy_key ?? null, role, alias: rec?.alias ?? null, group, conversation_id: run.conversation_id, seq: null,
        continues: null, fork: null, origin: run.origin, placement: run.placement, basis: 'recorded', rule: null }
      const conv = run.conversation_id ? recordedConversations.get(run.conversation_id) : undefined
      const state = run.conversation_id ? out.conversations.get(run.conversation_id) : undefined
      if (state && run.resumes_run_id && state.runs.includes(run.resumes_run_id)) a.continues = run.resumes_run_id
      else if (conv?.forked_from_run_id) a.fork = { from: conv.forked_from_run_id, reason: (conv.fork_reason ?? 'participant_change') as 'group_start' | 'branch' | 'participant_change' }
    } else {
      a = projectRun(run)
    }
    // the conversation
    if (a.participant_id !== null) {
      if (a.conversation_id === null) {
        // projected: the same participant's head continues; anything else opens a conversation
        const prevConv = prevA?.conversation_id ? out.conversations.get(prevA.conversation_id) : undefined
        if (prevA && prevConv && prevA.participant_id === a.participant_id && prevConv.runs.at(-1) === prevA.run_id) {
          a.conversation_id = prevConv.id
          a.continues = prevA.run_id
        } else {
          a.conversation_id = conversationIdOf(sid, a.participant_id, run.id)
          if (prevA) {
            const first = !rows.runs.some((r) => r.created_at <= run.created_at && r.id !== run.id && out.runs.get(r.id)?.participant_id === a.participant_id)
            a.fork = { from: prevA.run_id, reason: prevA.participant_id === a.participant_id ? 'branch' : a.role === 'member' && first ? 'group_start' : 'participant_change' }
          } else if (run.resumes_run_id) {
            note('dangling', `run ${run.resumes_run_id}, which run ${run.id} continues, is not in this session's record: its conversation is shown as starting there`)
          }
        }
      }
      let conv = out.conversations.get(a.conversation_id)
      if (conv === undefined) {
        const rec = recordedConversations.get(a.conversation_id)
        conv = { id: a.conversation_id, participant_id: a.participant_id, runs: [], forked_from_run_id: rec ? rec.forked_from_run_id : a.fork?.from ?? null, reason: rec ? rec.fork_reason : a.fork?.reason ?? null,
          basis: rec ? 'recorded' : a.basis === 'inferred' ? 'inferred' : 'projected', tool_surface: rec?.tool_surface ?? null, created_at: rec?.created_at ?? run.created_at }
        out.conversations.set(conv.id, conv)
      }
      conv.runs.push(run.id)
      a.seq = conv.runs.length
    }
    if (a.basis === 'inferred') out.inferred += 1
    out.runs.set(run.id, a)
  }
  for (const [rule, n] of counted) if (n > 3) out.notes.push(`${rule}: ${n - 3} more like the above`)
  return out

  function projectRun(run: RunMeta): Assigned {
    const base = { run_id: run.id, conversation_id: null, seq: null, continues: null, fork: null, rule: null } as const
    const legacyOrigin = (request: Origin['request'], extra: Partial<Origin> = {}): Origin => {
      if (run.spawned_by === 'wake') return origin({ actor: 'watch', request: 'wake', watch_id: rows.wake_runs[run.id] ?? null, basis: 'projected', ...extra })
      const task = rows.ui_task_runs[run.id]
      if (task) return origin({ actor: 'ui_task', request: 'ui_task', ui_task_id: task, basis: 'projected', ...extra })
      const turn = nativeDispatch.get(run.id)
      if (turn) {
        const call = turn.tool_calls.find((c) => c.args && (c.args.resume_run_id === run.resumes_run_id) && run.resumes_run_id)
        return origin({ actor: 'director', request, director_session_id: turn.director_session_id, director_turn_id: turn.id, tool_call_id: call?.tool_call_id ?? null, basis: 'projected', ...extra })
      }
      if (run.spawned_by === 'connector') {
        const held = bridgeTurns.find((t) => t.started_at! <= run.created_at && (t.finished_at === null || run.created_at <= t.finished_at))
        if (held) return origin({ actor: 'director', request, client: run.label, director_session_id: held.director_session_id, director_turn_id: held.id, basis: 'inferred', ...extra })
        return origin({ actor: 'connector', request, client: run.label, basis: 'projected', ...extra })
      }
      if (run.spawned_by.startsWith('run:') || run.parent_run_id) return origin({ actor: 'agent', request: 'child', parent_run_id: run.parent_run_id, basis: 'projected', ...extra })
      return origin({ actor: 'person', request, basis: 'projected', ...extra })
    }
    const withBasis = (o: Origin, basis: CollabBasis): Origin => (basis === 'inferred' ? { ...o, basis: 'inferred' } : o)
    // a person's action: a row of the record, no participant
    if (run.spawned_by === 'human_action') {
      return { ...base, participant_id: null, key: null, role: null, alias: null, group: null, origin: origin({ actor: 'harness', request: 'action', basis: 'projected' }),
        placement: { surface: 'record', group: null, anchor: null }, basis: 'projected' }
    }
    const prevA = run.resumes_run_id ? out.runs.get(run.resumes_run_id) ?? null : null
    // a child run of a pre-v12 tree
    if (run.parent_run_id !== null) {
      let root = run.parent_run_id
      for (let i = 0; i < 64; i++) { const p = byId.get(root)?.parent_run_id; if (!p) break; root = p }
      const key = childKey(root)
      const id = participantIdOf(sid, key)
      const o = origin({ actor: 'agent', request: 'child', parent_run_id: run.parent_run_id, basis: 'projected' })
      ensureParticipant({ id, key, role: 'child', alias: null, group: null, basis: 'projected', introduced_by: o }, run)
      return { ...base, participant_id: id, key, role: 'child', alias: null, group: null, basis: 'projected', origin: o,
        placement: { surface: 'card', group: null, anchor: { kind: 'run', id: run.parent_run_id, basis: 'projected' } } }
    }
    // a follow-up of a pre-v12 child run under the order it carried (inherited or narrowed): the same child, its card
    if (run.work_order !== null && prevA !== null && prevA.role === 'child' && prevA.participant_id !== null) {
      const o = legacyOrigin('resume')
      return { ...base, participant_id: prevA.participant_id, key: prevA.key, role: 'child', alias: null, group: null, basis: 'projected', origin: o,
        placement: { surface: 'card', group: null, anchor: prevA.placement.anchor } }
    }
    // a work order's run: a separate task's (its follow-ups keep it)
    if (run.work_order !== null) {
      const same = prevA !== null && prevA.role === 'separate' && prevA.participant_id !== null
      const key = same ? prevA.key! : separateKey(run.id)
      const id = same ? prevA.participant_id! : participantIdOf(sid, key)
      const o = legacyOrigin(run.resumes_run_id ? 'resume' : 'separate')
      ensureParticipant({ id, key, role: 'separate', alias: null, group: null, basis: 'projected', introduced_by: o }, run)
      const anchorTurn = o.director_turn_id
      const head = anchorTurn ? null : lastMainBefore(run)
      return { ...base, participant_id: id, key, role: 'separate', alias: null, group: null, basis: 'projected', origin: o,
        placement: { surface: 'card', group: null, anchor: anchorTurn ? { kind: 'director_turn', id: anchorTurn, basis: o.basis } : head ? { kind: 'run', id: head, basis: 'inferred' } : null } }
    }
    // an interaction's node
    if (run.interaction_id !== null && run.interaction_node !== null) {
      const node = nodeByKey.get(`${run.interaction_id}/${run.interaction_node}`)
      const alias = node?.participant ?? run.interaction_node
      const basis: CollabBasis = node ? 'projected' : 'inferred'
      if (!node) note('node-missing', `run ${run.id} names step ${run.interaction_node} of ${run.interaction_id}, which the record does not hold: its participant is read from the step's name`)
      const key = interactionKey(run.interaction_id, alias)
      const id = participantIdOf(sid, key)
      const group = { kind: 'interaction' as const, id: run.interaction_id }
      const ix = rows.interactions.find((i) => i.id === run.interaction_id)
      ensureParticipant({ id, key, role: 'member', alias, group, basis, introduced_by: groupOrigin(ix ?? null) }, run)
      const retry = node !== undefined && node.run_ids.indexOf(run.id) > 0
      return { ...base, participant_id: id, key, role: 'member', alias, group, basis,
        origin: origin({ actor: 'scheduler', request: retry ? 'node_retry' : 'node', interaction_id: run.interaction_id, basis }),
        placement: { surface: 'group', group, anchor: { kind: 'interaction', id: run.interaction_id, basis: 'projected' } } }
    }
    // a relay's turn
    if (run.relay_id !== null) {
      const relay = relays.get(run.relay_id)
      const alias = relay ? relayAlias(relay, run.relay_step) : null
      const basis: CollabBasis = alias ? 'projected' : 'inferred'
      const name = alias ?? `step${run.relay_step ?? '?'}`
      if (!alias) note('relay-step-missing', `run ${run.id} is turn ${run.relay_step} of relay ${run.relay_id}, which the record does not hold`)
      const key = relayKey(run.relay_id, name)
      const id = participantIdOf(sid, key)
      const group = { kind: 'relay' as const, id: run.relay_id }
      ensureParticipant({ id, key, role: 'member', alias: name, group, basis, introduced_by: origin({ actor: 'person', request: 'relay_turn', relay_id: run.relay_id, basis: 'projected' }) }, run)
      const firstOfRelay = rows.runs.find((r) => r.relay_id === run.relay_id)?.id === run.id
      return { ...base, participant_id: id, key, role: 'member', alias: name, group, basis,
        origin: firstOfRelay ? legacyOrigin('relay_turn', { relay_id: run.relay_id }) : origin({ actor: 'scheduler', request: 'relay_turn', relay_id: run.relay_id, basis }),
        placement: { surface: 'thread', group, anchor: null } }
    }
    // a thread spawner's run: the main agent's — unless it continued a member's own conversation (H1/H2)
    if (prevA !== null && (prevA.role === 'member' || prevA.role === 'child') && prevA.participant_id !== null) {
      const prev = byId.get(prevA.run_id)!
      const onOwn = run.workspace_id !== null && run.workspace_id === prev.workspace_id && run.workspace_id !== sessionWs
      const turn = nativeDispatch.get(run.id)
      const pageStarted = run.spawned_by === 'human' && !turn && run.client_request_id === null && !rows.ui_task_runs[run.id]
      const nativeResume = turn !== undefined && turn.tool_calls.some((c) => c.args?.resume_run_id === prevA.run_id)
      let rule: string | null = null
      let basis: CollabBasis = 'projected'
      if (onOwn && run.client_request_id === null) rule = 'H1'
      else if (pageStarted) { rule = 'H2a'; basis = 'inferred' }
      else if (nativeResume) { rule = 'H2b'; basis = 'inferred' }
      if (rule !== null) {
        const p = out.participants.get(prevA.participant_id)!
        if (rule !== 'H1') note(rule, `run ${run.id} continued ${p.alias ?? 'a participant'}'s run ${prevA.run_id} ${rule === 'H2a' ? 'from the page (a card follow-up leaves no key; a composer message always has one)' : 'by a director tool call naming that run'}: read as that participant's follow-up (inferred)`)
        const o = withBasis(legacyOrigin('followup'), basis)
        const placement: Placement = prevA.group?.kind === 'interaction'
          ? { surface: 'group', group: prevA.group, anchor: { kind: 'interaction', id: prevA.group.id, basis } }
          : prevA.role === 'child' ? { surface: 'card', group: null, anchor: prevA.placement.anchor } : { surface: 'thread', group: prevA.group, anchor: null }
        return { ...base, participant_id: prevA.participant_id, key: prevA.key, role: prevA.role, alias: prevA.alias, group: prevA.group, basis, origin: o, placement, rule }
      }
      if (onOwn) {
        note('H1-keyed', `run ${run.id} continued participant run ${prevA.run_id} on that participant's workspace with a client key (a thread message naming the run): read as the main agent's (inferred)`)
        const o = withBasis(legacyOrigin('message'), 'inferred')
        return { ...base, participant_id: mainId, key: mainKey(), role: 'main', alias: null, group: null, basis: 'inferred', origin: o, placement: { surface: 'thread', group: null, anchor: null }, rule: 'H1-keyed' }
      }
    }
    const o = legacyOrigin(run.spawned_by === 'wake' ? 'wake' : rows.ui_task_runs[run.id] ? 'ui_task' : 'message')
    return { ...base, participant_id: mainId, key: mainKey(), role: 'main', alias: null, group: null, basis: o.basis === 'inferred' ? 'inferred' : 'projected', origin: o,
      placement: { surface: 'thread', group: null, anchor: null } }
  }

  function groupOrigin(ix: Interaction | null): Origin | null {
    if (ix === null) return null
    if (ix.source_turn_id) return origin({ actor: 'director', request: 'message', director_session_id: ix.director_session_id, director_turn_id: ix.source_turn_id, interaction_id: ix.id, basis: 'projected' })
    return createdOrigin(rows, ix) ?? origin({ actor: 'person', request: 'message', interaction_id: ix.id, basis: 'inferred' })
  }
}

/** Who started an interaction, as its creation recorded it (a connector's client, a person, a director); null for an
 *  interaction created before its creation said. */
function createdOrigin(rows: CollabRows, ix: Interaction): Origin | null {
  const created = rows.events.find((e) => e.interaction_id === ix.id && e.kind === 'created')
  const said = created?.payload?.origin as Partial<Origin> | undefined
  if (!said || typeof said.actor !== 'string') return null
  return origin({ ...said, actor: said.actor, request: said.request ?? 'message', interaction_id: ix.id, basis: 'recorded' } as Origin)
}

/** The main agent's thread head: its latest run, or a relay's latest turn (a relay's turns are the thread's) — never a
 *  member's own follow-up, an interaction's step, a separate task's run or a record. `sessionWorkspaceOnly`: only a run
 *  on the session's own workspace (a continuation the thread made on a source-mounted copy is another writer's place). */
export function mainHead(rows: CollabRows, assignment: Assignment, opts: { sessionWorkspaceOnly: boolean; sourceMounted?: (wsId: string) => boolean }): RunMeta | null {
  for (let i = rows.runs.length - 1; i >= 0; i--) {
    const run = rows.runs[i]!
    const a = assignment.runs.get(run.id)
    if (!a || a.placement.surface !== 'thread') continue
    const isMain = a.role === 'main'
    const isRelayTurn = a.role === 'member' && a.group?.kind === 'relay' && run.relay_id !== null
    if (!isMain && !isRelayTurn) continue
    if (opts.sessionWorkspaceOnly && run.workspace_id !== null && rows.session.workspace_id !== null && run.workspace_id !== rows.session.workspace_id) {
      if (!(opts.sourceMounted?.(run.workspace_id) ?? false)) continue
      if (isRelayTurn) continue
    }
    return run
  }
  return null
}

// -- the graph -------------------------------------------------------------------------------------------------------

function headLine(text: string): string {
  const t = text.replace(/@\[([^\]]*)\]\([^)]*\)/g, '$1').trim()
  return t ? t.split(/\r?\n/)[0]!.slice(0, 160) : ''
}

function counts(statuses: string[]): StatusCounts {
  const c = { queued: 0, running: 0, done: 0, error: 0, cancelled: 0, total: statuses.length }
  for (const s of statuses) if (s in c && s !== 'total') (c as Record<string, number>)[s] += 1
  return c
}

const PACKET_HEADING = /^(Step|Turn) (\S+) \(([^,()]+), run (run_[A-Za-z0-9]+)\):$/gm

export function buildGraph(rows: CollabRows, revision: string, assignment: Assignment = assignRuns(rows)): CollaborationGraph {
  const sid = rows.session.id
  const byId = new Map(rows.runs.map((r) => [r.id, r]))
  const labelOf = rows.labelOf ?? ((m: string) => m)
  const edges = new Map<string, CollabEdge>()
  const add = (e: Omit<CollabEdge, 'id'> & { id?: string }) => {
    const id = e.id ?? edgeIdOf(e.kind, e.from.kind, e.from.id, e.to.kind, e.to.id)
    if (!edges.has(id)) edges.set(id, { ...e, id } as CollabEdge)
  }
  // recorded edges, as written
  for (const e of rows.edges) {
    add({ id: e.id, kind: e.kind, from: { kind: e.from_kind, id: e.from_id }, to: { kind: e.to_kind, id: e.to_id }, basis: 'recorded', created_at: e.created_at, meta: e.meta } as unknown as CollabEdge)
  }
  const recordedRun = (id: string) => byId.get(id)?.participant_id !== null && byId.get(id)?.participant_id !== undefined
  // continues / forks from the conversations
  for (const run of rows.runs) {
    const a = assignment.runs.get(run.id)!
    if (a.conversation_id === null) continue
    const basis: CollabBasis = a.basis === 'recorded' ? 'recorded' : a.basis
    if (a.continues && byId.has(a.continues)) add({ kind: 'continues', from: { kind: 'run', id: a.continues }, to: { kind: 'run', id: run.id }, basis, created_at: run.created_at, meta: { conversation_id: a.conversation_id } })
    else if (a.fork && byId.has(a.fork.from)) add({ kind: 'forks', from: { kind: 'run', id: a.fork.from }, to: { kind: 'run', id: run.id }, basis, created_at: run.created_at, meta: { conversation_id: a.conversation_id, reason: a.fork.reason } })
    if (run.parent_run_id && byId.has(run.parent_run_id)) add({ kind: 'spawned', from: { kind: 'run', id: run.parent_run_id }, to: { kind: 'run', id: run.id }, basis: 'projected', created_at: run.created_at, meta: {} })
  }
  // what the record of pre-v25 runs shows of the rest
  const nodesOf = new Map<string, InteractionNode[]>()
  for (const n of rows.nodes) nodesOf.set(n.interaction_id, [...(nodesOf.get(n.interaction_id) ?? []), n])
  const legacyNotes = [...assignment.notes]
  for (const run of rows.runs) {
    if (recordedRun(run.id)) continue
    // dispatched (H6): a native turn's record of what it started
    const turn = rows.turns.find((t) => t.dispatched_run_ids.includes(run.id) && rows.directors.find((d) => d.id === t.director_session_id)?.transport === 'native')
    if (turn) add({ kind: 'dispatched', from: { kind: 'director_turn', id: turn.id }, to: { kind: 'run', id: run.id }, basis: 'projected', created_at: run.created_at, meta: { tool: null, tool_call_id: null } })
    if (run.interaction_id && run.interaction_node) {
      const ix = rows.interactions.find((i) => i.id === run.interaction_id)
      const nodes = nodesOf.get(run.interaction_id) ?? []
      const node = nodes.find((n) => n.id === run.interaction_node)
      if (!node || !ix) continue
      // after (H5): each step it waited for, by the run of it that had ended when this one started
      for (const dep of node.depends_on) {
        const d = nodes.find((n) => n.id === dep)
        const ended = (d?.run_ids ?? []).map((id) => byId.get(id)).filter((r): r is RunMeta => !!r && r.finished_at !== null && r.finished_at <= run.created_at)
        const last = ended.at(-1)
        if (last) add({ kind: 'after', from: { kind: 'run', id: last.id }, to: { kind: 'run', id: run.id }, basis: 'projected', created_at: run.created_at, meta: { interaction_id: ix.id, from_node: dep, to_node: node.id } })
      }
      // received (H4): the packets its opening message holds, each checked against the step it names
      if (node.receives.length && node.run_ids[0] === run.id) {
        for (const m of run.user_text.matchAll(PACKET_HEADING)) {
          const [, kind, stepId, , runId] = m
          if (kind !== 'Step') continue
          const dep = nodes.find((n) => n.id === stepId)
          if (!dep || !node.receives.includes(dep.id) || !dep.run_ids.includes(runId!)) { legacyNotes.push(`run ${run.id}: a packet names step ${stepId} (run ${runId}), which its step does not receive: no edge`); continue }
          const from = byId.get(runId!)
          const cut = run.user_text.includes(`more characters; they are in run ${runId}.]`)
          add({ kind: 'received', from: { kind: 'run', id: runId! }, to: { kind: 'run', id: run.id }, basis: 'projected', created_at: run.created_at,
            meta: { via: 'node_receives', packet: cut ? 'cut' : 'whole', answer_chars: from?.final_text_chars ?? null, handed_chars: cut ? MAX_PACKET_ANSWER_CHARS : from?.final_text_chars ?? null, node: dep.id, content_delivered: true } })
        }
      }
      // workspace: the copy it worked on
      const ws = rows.workspaces.find((w) => w.id === run.workspace_id)
      const first = node.run_ids[0] === run.id
      if (first) {
        if (run.workspace_id === rows.session.workspace_id) add({ kind: 'workspace', from: { kind: 'workspace', id: run.workspace_id! }, to: { kind: 'run', id: run.id }, basis: 'projected', created_at: run.created_at, meta: { mode: 'session_folder', workspace_id: run.workspace_id, checkpoint_id: null } })
        else if (node.workspace !== 'own' && node.workspace !== 'shared') {
          const other = nodes.find((n) => n.id === node.workspace)?.run_ids.find((id) => byId.get(id)?.created_at! <= run.created_at)
          if (other) add({ kind: 'workspace', from: { kind: 'run', id: other }, to: { kind: 'run', id: run.id }, basis: 'projected', created_at: run.created_at, meta: { mode: 'same_workspace', workspace_id: run.workspace_id, checkpoint_id: null } })
        } else if (ws?.source_mount) add({ kind: 'workspace', from: { kind: 'workspace', id: rows.session.workspace_id ?? ws.id }, to: { kind: 'run', id: run.id }, basis: 'projected', created_at: run.created_at, meta: { mode: 'source_mount', workspace_id: run.workspace_id, checkpoint_id: null } })
        else if (ix.base_checkpoint_id) add({ kind: 'workspace', from: { kind: 'checkpoint', id: ix.base_checkpoint_id }, to: { kind: 'run', id: run.id }, basis: 'projected', created_at: run.created_at, meta: { mode: 'checkpoint_copy', workspace_id: run.workspace_id, checkpoint_id: ix.base_checkpoint_id } })
      }
    }
    // received (H4) of a relay's later turn: the turns its message hands
    if (run.relay_id) {
      const relay = rows.relays.find((r) => r.id === run.relay_id)
      if (relay) for (const m of run.user_text.matchAll(PACKET_HEADING)) {
        const [, kind, , , runId] = m
        if (kind !== 'Turn') continue
        const from = byId.get(runId!)
        if (!from || from.relay_id !== relay.id || from.created_at > run.created_at) { legacyNotes.push(`run ${run.id}: a packet names run ${runId}, not an earlier turn of its relay: no edge`); continue }
        const cut = run.user_text.includes(`more characters; they are in run ${runId}.]`)
        add({ kind: 'received', from: { kind: 'run', id: runId! }, to: { kind: 'run', id: run.id }, basis: 'projected', created_at: run.created_at,
          meta: { via: 'relay_turn', packet: cut ? 'cut' : 'whole', answer_chars: from.final_text_chars, handed_chars: cut ? MAX_PACKET_ANSWER_CHARS : from.final_text_chars, node: null, content_delivered: true } })
      }
    }
  }
  // notes handed (delivered_json names the run that took each)
  for (const n of rows.notes) {
    for (const [to, runId] of Object.entries(n.delivered)) {
      if (!byId.has(runId)) continue
      add({ kind: 'note', from: { kind: 'note', id: n.id }, to: { kind: 'run', id: runId }, basis: recordedRun(runId) ? 'recorded' : 'projected', created_at: n.created_at, meta: { interaction_id: n.interaction_id, to } })
    }
  }
  // adoptions: a step's output composed into the session's folder
  for (const e of rows.events) {
    if (e.kind !== 'adopted') continue
    const node = rows.nodes.find((n) => n.interaction_id === e.interaction_id && n.id === e.payload.node)
    const runId = node?.run_id
    if (!runId || !rows.session.workspace_id) continue
    add({ kind: 'adopted', from: { kind: 'run', id: runId }, to: { kind: 'workspace', id: rows.session.workspace_id }, basis: 'projected', created_at: e.created_at,
      meta: { interaction_id: e.interaction_id, node: node.id, checkpoint_id: (e.payload.checkpoint_id as string | null) ?? null, status: String(e.payload.status ?? ''), composed_checkpoint_id: (e.payload.composed_checkpoint_id as string | null) ?? null } })
  }

  // runs
  const collabOf = (runId: string): RunCollab => {
    const a = assignment.runs.get(runId)!
    return { participant_id: a.participant_id, participant_role: a.role, conversation_id: a.conversation_id, conversation_seq: a.seq, origin: a.origin, placement: a.placement, basis: a.basis }
  }
  const runs: CollabRun[] = rows.runs.map((r) => collabRunOf(r, collabOf(r.id), rows.live.has(r.id)))
  // participants
  const nodeParticipant = (ixId: string, alias: string) => participantIdOf(sid, interactionKey(ixId, alias))
  const participants: Participant[] = []
  for (const p of assignment.participants.values()) {
    const mine = rows.runs.filter((r) => assignment.runs.get(r.id)?.participant_id === p.id)
    if (p.role === 'main' && !mine.length && !rows.participants.some((x) => x.id === p.id)) {
      participants.push({ id: p.id, session_id: sid, role: 'main', alias: null, label: labelOf(rows.session.model), model: rows.session.model, group: null, introduced_by: null,
        current_conversation_id: null, latest_run_id: null, state: 'idle', run_count: 0, basis: p.basis, created_at: p.created_at || '' })
      continue
    }
    const latest = mine.at(-1) ?? null
    const queued = p.group?.kind === 'interaction' && rows.nodes.some((n) => n.interaction_id === p.group!.id && n.participant === p.alias && n.status === 'queued')
    const groupLabel = p.group?.kind === 'interaction' ? rows.interactions.find((i) => i.id === p.group!.id)?.participants.find((x) => x.id === p.alias)?.label
      : p.group?.kind === 'relay' ? rows.relays.find((r) => r.id === p.group!.id)?.participants.find((x, i) => (x.id || letter(i)) === p.alias)?.label : null
    const orderLabel = p.role === 'separate' ? (mine.find((r) => r.work_order && typeof r.work_order.label === 'string' && r.work_order.label)?.work_order?.label as string | undefined) ?? mine[0]?.label ?? null : null
    participants.push({
      id: p.id, session_id: sid, role: p.role, alias: p.alias, label: p.label || groupLabel || orderLabel || labelOf(latest?.model ?? p.model ?? rows.session.model),
      model: latest?.model ?? p.model, group: p.group, introduced_by: p.introduced_by ?? (mine[0] ? assignment.runs.get(mine[0].id)!.origin : null),
      current_conversation_id: latest ? assignment.runs.get(latest.id)!.conversation_id : null, latest_run_id: latest?.id ?? null,
      state: mine.some((r) => rows.live.has(r.id) || r.status === 'running' || r.status === 'queued') ? 'running' : queued ? 'queued' : 'idle',
      run_count: mine.length, basis: p.basis, created_at: p.created_at || (mine[0]?.created_at ?? ''),
    })
  }
  const conversations: Conversation[] = [...assignment.conversations.values()].map((c) => ({
    id: c.id, session_id: sid, participant_id: c.participant_id, forked_from_run_id: c.forked_from_run_id, root_run_id: c.runs[0] ?? null, head_run_id: c.runs.at(-1) ?? null,
    run_ids: c.runs, tool_surface: c.tool_surface, basis: c.basis, created_at: c.created_at,
  }))
  // groups and planned steps
  const groups: CollabGroup[] = []
  for (const ix of rows.interactions) {
    groups.push({
      kind: 'interaction', id: ix.id, status: ix.status, controller: ix.controller, template: ix.template, then: ix.then, workspace_policy: ix.workspace_policy, rounds: null,
      participant_ids: ix.participants.map((p) => nodeParticipant(ix.id, p.id)), runs_started: ix.runs_started, max_runs: ix.budget.max_runs, concurrency: ix.budget.concurrency,
      origin: ix.source_turn_id ? origin({ actor: 'director', request: 'message', director_session_id: ix.director_session_id, director_turn_id: ix.source_turn_id, interaction_id: ix.id, basis: 'recorded' })
        : createdOrigin(rows, ix) ?? origin({ actor: 'person', request: 'message', interaction_id: ix.id, basis: 'inferred' }),
      anchor: ix.source_turn_id ? { kind: 'director_turn', id: ix.source_turn_id, basis: 'recorded' } : { kind: 'interaction', id: ix.id, basis: 'recorded' },
      reason: ix.reason, created_at: ix.created_at, finished_at: ix.finished_at,
    })
  }
  for (const relay of rows.relays) {
    groups.push({
      kind: 'relay', id: relay.id, status: relay.status, controller: null, template: null, then: null, workspace_policy: null, rounds: relay.rounds,
      participant_ids: relay.participants.map((p, i) => participantIdOf(sid, relayKey(relay.id, p.id || letter(i)))), runs_started: relay.steps.reduce((n, s) => n + s.run_ids.length, 0),
      max_runs: null, concurrency: 1, origin: origin({ actor: 'person', request: 'relay_turn', relay_id: relay.id, basis: 'projected' }), anchor: { kind: 'relay', id: relay.id, basis: 'recorded' },
      reason: relay.reason, created_at: relay.created_at, finished_at: relay.finished_at,
    })
  }
  const waves = new Map<string, number>()
  for (const [ixId, ns] of nodesOf) {
    const byNode = new Map(ns.map((n) => [n.id, n]))
    const wave = (id: string, seen: Set<string>): number => {
      const k = `${ixId}/${id}`
      if (waves.has(k)) return waves.get(k)!
      const n = byNode.get(id)
      if (!n || seen.has(id)) return 0
      seen.add(id)
      const w = 1 + Math.max(0, ...n.depends_on.map((d) => wave(d, seen)))
      waves.set(k, w)
      return w
    }
    for (const n of ns) wave(n.id, new Set())
  }
  const nodes: CollabNode[] = rows.nodes.map((n) => ({
    id: `${n.interaction_id}/${n.id}`, interaction_id: n.interaction_id, node_id: n.id, kind: n.kind ?? 'plan', participant_id: nodeParticipant(n.interaction_id, n.participant),
    alias: n.participant, status: n.status, run_ids: n.run_ids, current_run_id: n.run_id, depends_on: n.depends_on, receives: n.receives,
    receive_runs: n.receive_runs ?? [], cites: n.cites ?? [], workspace: n.workspace, wave: waves.get(`${n.interaction_id}/${n.id}`) ?? 1,
  }))
  // the thread's summaries
  const thread_items: ThreadItem[] = []
  const dispatches = new Map<string, { anchor: CollabRun['collab']['placement']['anchor']; at: string; origin: Origin; entries: CollabRun[] }>()
  for (const r of runs) {
    const c = r.collab
    const followup = c.origin.request === 'followup' && c.placement.surface !== 'thread'
    if (c.placement.surface !== 'card' && !followup) continue
    const key = c.placement.anchor ? `${c.placement.anchor.kind}:${c.placement.anchor.id}${followup ? `:fu:${r.id}` : ''}` : `run:${r.id}`
    const item = dispatches.get(key) ?? { anchor: followup ? (c.origin.director_turn_id ? { kind: 'director_turn', id: c.origin.director_turn_id, basis: c.origin.basis } : null) : c.placement.anchor, at: r.created_at, origin: c.origin, entries: [] }
    item.entries.push(r)
    dispatches.set(key, item)
  }
  for (const [key, item] of dispatches) {
    thread_items.push({
      kind: 'dispatch', id: `ti_${key.replace(/[^A-Za-z0-9_]/g, '_')}`, at: item.at, anchor: item.anchor ?? null, origin: item.origin,
      entries: item.entries.map((r) => ({ run_id: r.id, participant_id: r.collab.participant_id, label: r.label ?? participants.find((p) => p.id === r.collab.participant_id)?.label ?? null, model: r.model, status: r.status,
        surface: r.collab.placement.surface, user_text_head: r.user_text_head, finished_at: r.finished_at, focus: { participant_id: r.collab.participant_id, run_id: r.id } })),
      counts: counts(item.entries.map((r) => r.status)),
    })
  }
  for (const g of groups) {
    const statuses = g.kind === 'interaction'
      ? rows.nodes.filter((n) => n.interaction_id === g.id).map((n) => n.status === 'waiting' ? 'error' : n.status === 'watching' ? 'running' : n.status)
      : rows.relays.find((r) => r.id === g.id)!.steps.map((s) => (s.status === 'waiting' ? 'error' : s.status ?? 'queued'))
    thread_items.push({ kind: 'group', id: `ti_${g.kind}_${g.id}`, at: g.created_at, anchor: g.anchor, group: { kind: g.kind, id: g.id }, status: g.status, counts: counts(statuses as string[]) })
  }
  thread_items.sort((x, y) => x.at.localeCompare(y.at))
  // actors
  const actors: CollaborationGraph['actors'] = [{ kind: 'person' }]
  for (const d of rows.directors) {
    actors.push({ kind: 'director', id: d.id, transport: d.transport, label: d.label || d.model, model: d.model, state: d.state, tool_surface: directorToolSurfaceOf(d.config), open: d.closed_at === null })
  }
  const projected = rows.runs.filter((r) => !recordedRun(r.id)).length
  const graph: CollaborationGraph = {
    session_id: sid, revision, main_participant_id: assignment.main_participant_id, actors, participants, conversations, groups, runs, nodes,
    edges: [...edges.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)), thread_items,
    legacy: { projected_runs: projected, inferred_facts: assignment.inferred + [...edges.values()].filter((e) => e.basis === 'inferred').length, notes: legacyNotes.slice(0, 50) },
  }
  return CollaborationGraphSchema.parse(graph)
}

export function collabRunOf(r: RunMeta, collab: RunCollab, live: boolean): CollabRun {
  return {
    id: r.id, status: r.status as CollabRun['status'], live, model: r.model, label: r.label, created_at: r.created_at, finished_at: r.finished_at, workspace_id: r.workspace_id,
    resumes_run_id: r.resumes_run_id, interaction_id: r.interaction_id, interaction_node: r.interaction_node, relay_id: r.relay_id, relay_step: r.relay_step,
    user_text_head: headLine(r.user_text), final_text_chars: ENDED.has(r.status) ? r.final_text_chars ?? 0 : null, error: r.error, collab,
  }
}
