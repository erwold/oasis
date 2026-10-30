/** The collaboration model's one service (schema v25; docs/multi-agent-unification-design.md §5): every run starts
 *  through here with who it belongs to (participant), which history it continues (conversation), who started it
 *  (origin) and where it is shown (placement), and the typed edges of what it was handed or referred to — written in
 *  the same transaction as the run's row. Reads give the session's graph (agent/collab_projection.ts), the main
 *  agent's thread head, a run's collab. Nothing here rewrites a row written before v25. */

import {
  ACTIVE_RUN_STATUSES, CURRENT_AGENT_TOOL_SURFACE, type Citation, type CollaborationGraph, type GroupRef, type Origin, type ParticipantRole,
  type Placement, type Run, type RunCollab, type Session,
} from '@oasis-code/contract'
import type { AppState } from '../api/state.ts'
import * as crepo from '../db/collab_repo.ts'
import { participantIdOf, conversationIdOf, type NewEdge, type ToolSnapshot } from '../db/collab_repo.ts'
import * as repo from '../db/repo.ts'
import * as directorStore from '../director/store.ts'
import { findModel } from '../llm/catalog.ts'
import { schemaRowsFingerprint } from '../llm/usage.ts'
import { collabText } from './collab_texts.ts'
import {
  assignRuns, buildGraph, collabRunOf, interactionKey, mainHead, mainKey, relayAlias, relayKey, separateKey,
  type Assignment, type CollabRows,
} from './collab_projection.ts'
import { packetWithHeading } from './peer_packet.ts'
import { specs, toolSchemaRows, visibleToolNames } from './tools/registry.ts'
import { isChatGptWeb } from '../llm/chatgpt_web.ts'
import baselineSurface from './surfaces/agent.v1.json' with { type: 'json' }

export class CollabRefused extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null = null) { super(message); this.name = 'CollabRefused' }
}

const ENDED = new Set(['done', 'error', 'cancelled'])

export function originOf(o: Partial<Origin> & Pick<Origin, 'actor' | 'request'>): Origin {
  return {
    client: null, director_session_id: null, director_turn_id: null, tool_call_id: null, interaction_id: null, relay_id: null,
    watch_id: null, ui_task_id: null, parent_run_id: null, basis: 'recorded', ...o,
  }
}

// -- reading -------------------------------------------------------------------------------------------------------------

/** Everything of a session the graph is read from (no run history, manifest or usage). */
export function loadRows(state: AppState, sessionId: string): CollabRows {
  const conn = state.conn
  const session = repo.getSession(conn, sessionId)
  if (session === null) throw new CollabRefused(`session not found: ${sessionId}`, 404)
  const runs = crepo.listRunMetas(conn, sessionId)
  const wsIds = new Set<string>(runs.map((r) => r.workspace_id).filter((x): x is string => x !== null))
  if (session.workspace_id) wsIds.add(session.workspace_id)
  const workspaces = [...wsIds].map((id) => repo.getWorkspace(conn, id)).filter((w) => w !== null).map((w) => ({ id: w.id, session_id: w.session_id, source_mount: w.source_mount !== null, kind: w.kind }))
  const interactions = repo.listInteractions(conn, sessionId)
  const nodes = interactions.flatMap((ix) => repo.listNodes(conn, ix.id))
  const events = interactions.flatMap((ix) => repo.listInteractionEvents(conn, ix.id).map((e) => ({ ...e, interaction_id: ix.id })))
  const notes = interactions.flatMap((ix) => repo.listInteractionNotes(conn, ix.id))
  const directorIds = conn.all('SELECT id FROM director_sessions WHERE session_id=? ORDER BY created_at, rowid', [sessionId]).map((r) => String(r.id))
  const directors = directorIds.map((id) => directorStore.getDirectorSession(conn, id)).filter((d) => d !== null)
  const turns = directors.flatMap((d) => directorStore.listTurns(conn, d.id))
  const ui_task_runs: Record<string, string> = {}
  for (const row of conn.all('SELECT id, agent_run_id FROM ui_tasks WHERE session_id=? AND agent_run_id IS NOT NULL', [sessionId])) ui_task_runs[String(row.agent_run_id)] = String(row.id)
  const wake_runs: Record<string, string> = {}
  for (const row of conn.all('SELECT watch_id, run_id FROM wake_events WHERE session_id=? AND run_id IS NOT NULL', [sessionId])) wake_runs[String(row.run_id)] ??= String(row.watch_id)
  const live = new Set([...state.runs.handles.values()].filter((h) => h.session_id === sessionId && !h.done).map((h) => h.run_id))
  return {
    session: { id: session.id, workspace_id: session.workspace_id, project_id: session.project_id, model: session.model },
    runs, workspaces, interactions, nodes, events, notes, relays: repo.listRelays(conn, sessionId), directors, turns, ui_task_runs, wake_runs,
    participants: crepo.listParticipants(conn, sessionId), conversations: crepo.listConversations(conn, sessionId), edges: crepo.listEdges(conn, sessionId), live,
    labelOf: (model) => findModel(state.config, model)?.label || model,
  }
}

export function assignmentOf(state: AppState, sessionId: string): { rows: CollabRows; assignment: Assignment } {
  const rows = loadRows(state, sessionId)
  return { rows, assignment: assignRuns(rows) }
}

export function revisionOf(state: AppState, sessionId: string): string {
  return crepo.collaborationFingerprint(state.conn, sessionId)
}

export function graphOf(state: AppState, sessionId: string): CollaborationGraph {
  const { rows, assignment } = assignmentOf(state, sessionId)
  return buildGraph(rows, revisionOf(state, sessionId), assignment)
}

/** Every run's collab of a session, by run id. */
export function collabOfRuns(state: AppState, sessionId: string): Map<string, RunCollab> {
  const { assignment } = assignmentOf(state, sessionId)
  const out = new Map<string, RunCollab>()
  for (const [id, a] of assignment.runs) {
    out.set(id, { participant_id: a.participant_id, participant_role: a.role, conversation_id: a.conversation_id, conversation_seq: a.seq, origin: a.origin, placement: a.placement, basis: a.basis })
  }
  return out
}

export function collabOfRun(state: AppState, run: Pick<Run, 'id' | 'session_id'>): RunCollab | null {
  return collabOfRuns(state, run.session_id).get(run.id) ?? null
}

/** The main agent's thread head: what a message to the thread continues when it names no run (its latest run, or a
 *  relay's latest turn). `sourceContinuations`: a run the thread continued on a source-mounted copy counts too (a new
 *  isolated group may start from it); otherwise only the session's own workspace — the one the thread writes. */
export function mainHeadRun(state: AppState, sessionId: string, opts: { sourceContinuations?: boolean } = {}): Run | null {
  const { rows, assignment } = assignmentOf(state, sessionId)
  const mounted = new Set(rows.workspaces.filter((w) => w.source_mount && w.session_id === sessionId).map((w) => w.id))
  const head = mainHead(rows, assignment, { sessionWorkspaceOnly: true, sourceMounted: opts.sourceContinuations ? (id) => mounted.has(id) : undefined })
  return head ? repo.getRun(state.conn, head.id) : null
}

// -- handing over and referring --------------------------------------------------------------------------------------

export interface Handover {
  cited: { run_id: string; participant_id: string | null; who: string; note: string | null }[]
  /** `session_id`: the session the answer came from (another session's only when the dispatch allowed it) */
  received: { run_id: string; participant_id: string | null; who: string; chars: number; session_id?: string }[]
  /** the opening message's lines: one per citation, one packet per answer handed over */
  lines: string[]
  /** the edges the new run gets (`to` is the run) */
  edges: Omit<NewEdge, 'to'>[]
}

export const EMPTY_HANDOVER: Handover = { cited: [], received: [], lines: [], edges: [] }

function whoOf(state: AppState, assignment: Assignment, run: Run): { who: string; participant_id: string | null } {
  const a = assignment.runs.get(run.id)
  const p = a?.participant_id ? assignment.participants.get(a.participant_id) : undefined
  const label = run.label || findModel(state.config, run.model)?.label || run.model
  const role = a?.role ?? null
  const who = role === 'main' ? `the session's main agent, ${label}` : role === 'member' ? `participant ${p?.alias ?? '?'} (${label})` : role === 'separate' ? `a separate task (${label})` : label
  return { who, participant_id: a?.participant_id ?? null }
}

/** What a dispatch names, checked before anything starts: exact ended runs of this very session (a run of another
 *  session, or none, is refused alike: nothing tells one from the other), each named once; their final answers become
 *  packets (receive_run_ids) or one line each that names them and hands nothing (cites).
 *  `across_sessions` (schema v29, an explicit request: director.v6's receive_run_ids): a received run may be another
 *  session's — its final answer handed over whole with where it came from (session and run), and nothing else of
 *  that session: no folder, root, grant or access comes with it, and that session's record is not written (the
 *  received edge is this session's). Cited runs stay this session's. */
export function prepareHandover(state: AppState, session: Session, o: { cites?: Citation[] | null; receive_run_ids?: string[] | null; by: Origin; across_sessions?: boolean }): Handover {
  const cites = o.cites ?? []
  const receives = o.receive_run_ids ?? []
  if (!cites.length && !receives.length) return EMPTY_HANDOVER
  const seen = (ids: string[]) => ids.find((id, i) => ids.indexOf(id) !== i)
  const twiceCited = seen(cites.map((c) => c.run_id))
  if (twiceCited) throw new CollabRefused(`cites names run ${twiceCited} more than once`, 400, 'invalid_input')
  const twiceReceived = seen(receives)
  if (twiceReceived) throw new CollabRefused(`receive_run_ids names run ${twiceReceived} more than once`, 400, 'invalid_input')
  const check = (id: string, what: string, across = false): Run => {
    const run = repo.getRun(state.conn, id)
    if (run === null || (run.session_id !== session.id && !(across && repo.getSession(state.conn, run.session_id)?.status !== repo.DELETED_SESSION))) {
      throw new CollabRefused(across ? `${what} ${id} is not a run of any session` : `${what} ${id} is not a run of this session`, 400, 'not_in_session')
    }
    if (run.spawned_by === 'human_action') throw new CollabRefused(`${what} ${id} records a person's action; it has no answer`, 400, 'invalid_input')
    if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status) || !ENDED.has(run.status)) throw new CollabRefused(`${what} ${id} is still ${run.status}: only an ended run's answer can be named`, 409, 'run_not_ended')
    return run
  }
  const citedRuns = cites.map((c) => ({ c, run: check(c.run_id, 'cited run') }))
  const receivedRuns = receives.map((id) => check(id, 'received run', o.across_sessions === true))
  const { assignment } = assignmentOf(state, session.id)
  // another session's run is named as that session names it (its own participants)
  const assignments = new Map<string, Assignment>([[session.id, assignment]])
  const assignmentFor = (sid: string): Assignment => {
    let found = assignments.get(sid)
    if (found === undefined) { found = assignmentOf(state, sid).assignment; assignments.set(sid, found) }
    return found
  }
  const out: Handover = { cited: [], received: [], lines: [], edges: [] }
  const by = o.by.actor === 'director' ? 'director' : o.by.actor === 'connector' ? 'connector' : 'person'
  for (const { c, run } of citedRuns) {
    const { who, participant_id } = whoOf(state, assignment, run)
    const note = c.note?.trim() || null
    out.cited.push({ run_id: run.id, participant_id, who, note })
    out.lines.push(collabText('dispatch.cited', { run_id: run.id, who, note: note ? `, on: ${note}` : '' }))
    out.edges.push({ kind: 'cited', from: { kind: 'run', id: run.id }, meta: { by, director_turn_id: o.by.director_turn_id ?? null, note, content_delivered: false } })
  }
  for (const run of receivedRuns) {
    const foreign = run.session_id !== session.id
    const { who, participant_id } = whoOf(state, foreign ? assignmentFor(run.session_id) : assignment, run)
    const answer = typeof run.receipt.final_text === 'string' ? run.receipt.final_text : ''
    const chars = Array.from(answer).length
    if (!foreign) {
      out.received.push({ run_id: run.id, participant_id, who, chars })
      out.lines.push(packetWithHeading(state.conn, run, collabText('dispatch.received', { run_id: run.id, who }), false, true))
      out.edges.push({ kind: 'received', from: { kind: 'run', id: run.id }, meta: { via: 'dispatch', packet: 'whole', answer_chars: chars, handed_chars: chars, node: null, content_delivered: true } })
      continue
    }
    // another session's answer: where it came from, said in the heading and kept on the edge (this session's record)
    const source = repo.getSession(state.conn, run.session_id)!
    out.received.push({ run_id: run.id, participant_id, who, chars, session_id: source.id })
    out.lines.push(packetWithHeading(state.conn, run, collabText('dispatch.received_session', { run_id: run.id, who, session_id: source.id, title: source.title }), false, true))
    out.edges.push({ kind: 'received', from: { kind: 'run', id: run.id }, meta: {
      via: 'dispatch', packet: 'whole', answer_chars: chars, handed_chars: chars, node: null, content_delivered: true,
      cross_session: true, source_session_id: source.id, source_project_id: source.project_id, source_participant_id: participant_id,
    } })
  }
  return out
}

// -- the write path ---------------------------------------------------------------------------------------------------

export interface ParticipantSpec {
  key: string
  role: ParticipantRole
  alias: string | null
  group: GroupRef | null
  label?: string | null
}

/** What a caller of runs.start says of the run's place (all optional: the runner derives what is left out). */
export interface CollabStart {
  origin?: Origin
  participant?: ParticipantSpec
  placement?: Placement
  /** edges into the new run (cited, received, after, workspace, dispatched, note) */
  edges?: Omit<NewEdge, 'to'>[]
  /** refuse (head_moved) when the participant's latest run is another */
  expected_head_run_id?: string | null
  /** the opening message's extra lines (citations, packets) */
  lines?: string[]
  /** what run_started tells of them */
  handover?: { received: Handover['received']; cited: Handover['cited'] } | null
  intent_sha?: string | null
}

export interface ResolvedCollab {
  participant: crepo.ParticipantRow extends infer R ? Omit<R & object, 'created_at' | 'updated_at'> : never
  conversation: { id: string; fresh: boolean; forked_from_run_id: string | null; fork_reason: string | null }
  origin: Origin
  placement: Placement
  snapshot: ToolSnapshot
  tool_surface: string
}

/** The default origin of a run a caller did not describe: from what started it. */
export function defaultOrigin(o: { spawned_by: string; label: string | null; order: boolean; resumes: boolean; interaction?: { id: string } | null; relay?: { id: string } | null; wake?: boolean; ui_task?: string | null }): Origin {
  if (o.interaction) return originOf({ actor: 'scheduler', request: 'node', interaction_id: o.interaction.id })
  if (o.relay) return originOf({ actor: 'scheduler', request: 'relay_turn', relay_id: o.relay.id })
  if (o.wake || o.spawned_by === 'wake') return originOf({ actor: 'watch', request: 'wake' })
  if (o.ui_task) return originOf({ actor: 'ui_task', request: 'ui_task', ui_task_id: o.ui_task })
  const request = o.order ? (o.resumes ? 'resume' : 'separate') : 'message'
  if (o.spawned_by === 'connector') return originOf({ actor: 'connector', request, client: o.label })
  if (o.spawned_by === 'human_action') return originOf({ actor: 'harness', request: 'action' })
  return originOf({ actor: 'person', request })
}

/** The agent tool surface of the baseline build (main 3d06c7b, schema v24) — every tool's name, description and
 *  parameters in the order a request lists them (scripts/agent_surface_snapshot.ts on that tree): what an older
 *  conversation's list is rebuilt from, whatever the registry says later. */
const BASELINE_AGENT_SURFACE = baselineSurface as { surface: string; rows: ToolSnapshot['rows'] }

/** A tool list in a request's order: the names in the order `rows` (a surface, in its order) lists them. */
function orderedRows(source: ToolSnapshot['rows'], names: Iterable<string>): { rows: ToolSnapshot['rows']; missing: string[] } {
  const wanted = new Set(names)
  const rows = source.filter((r) => wanted.has(r.name))
  const found = new Set(rows.map((r) => r.name))
  return { rows, missing: [...wanted].filter((n) => !found.has(n)) }
}

function currentRows(): ToolSnapshot['rows'] {
  return toolSchemaRows(specs().map((s) => s.name))
}

/** A conversation's tool list as it stands now, made by its first request: the run's visible tools, in the registry's order. */
export function freshToolSnapshot(order: { tools: string[] | null } | null): ToolSnapshot {
  const { rows } = orderedRows(currentRows(), visibleToolNames({ order }))
  return { surface: CURRENT_AGENT_TOOL_SURFACE, basis: 'recorded', names: rows.map((r) => r.name), rows, sha256: schemaRowsFingerprint(rows) }
}

/** The tool list an older conversation (recorded before v25: no list of its own) was sent, rebuilt from what its run's
 *  manifest recorded — its tools' names and the fingerprint of their schema rows — out of the baseline surface (or
 *  the registry as it is, when that is what matches). Only a list whose rows give exactly the recorded fingerprint is
 *  returned; anything else is null with the reason (the history goes on only with the list it was made with). */
export function reconstructToolSnapshot(manifest: Record<string, unknown>): { snapshot: ToolSnapshot } | { reason: string } {
  const names = Array.isArray(manifest.tools) ? (manifest.tools as unknown[]).filter((n): n is string => typeof n === 'string') : null
  if (names === null) return { reason: 'its record lists no tools' }
  const recorded = typeof manifest.tool_schema_sha256 === 'string' ? manifest.tool_schema_sha256 : null
  if (recorded === null) return { reason: 'its record has no fingerprint of the tool schemas it was sent' }
  for (const source of [BASELINE_AGENT_SURFACE.rows, currentRows()]) {
    const { rows, missing } = orderedRows(source, names)
    if (missing.length) continue
    if (schemaRowsFingerprint(rows) === recorded) return { snapshot: { surface: CURRENT_AGENT_TOOL_SURFACE, basis: 'reconstructed', names: rows.map((r) => r.name), rows, sha256: recorded } }
  }
  const unknown = orderedRows(BASELINE_AGENT_SURFACE.rows, names).missing
  return { reason: unknown.length ? `it lists tools this build has no record of (${unknown.join(', ')})` : 'the descriptions or schemas it was sent are not the ones this build has on record (its fingerprint matches neither)' }
}

export class ToolSurfaceUnrecoverable extends CollabRefused {
  constructor(readonly run_id: string, readonly reason: string, sessionId: string) {
    super(`run ${run_id}'s conversation cannot go on: ${reason}, so its tool list cannot be restored byte for byte, and a continuation would change the tools that conversation was sent. Nothing was started. A new conversation can be started instead: POST /api/sessions/${sessionId}/chat with fresh: true (receive_run_ids: ["${run_id}"] hands its final answer over whole).`, 409, 'tool_surface_unrecoverable')
    this.name = 'ToolSurfaceUnrecoverable'
  }
}

/** The tool list every request of the conversation a run continues carries — decided before the run is written:
 *  the history it is given comes from `previous` or, past runs that recorded no history (an interrupted one), the
 *  nearest run up its chain that did. That run's conversation's own list (v25+); an older conversation's list rebuilt
 *  from its manifest and proven by its recorded fingerprint (a run on ChatGPT on the web sent no list: the list of
 *  the history before it, if any); a run whose list cannot be proven is refused (ToolSurfaceUnrecoverable) — never
 *  continued with a list made up now. A run with no history at all: the run's visible tools now. */
export function toolSnapshotFor(state: AppState, o: { previous: Run | null; order: { tools: string[] | null } | null }): ToolSnapshot {
  const conn = state.conn
  const seen = new Set<string>()
  let from: Run | null = o.previous
  while (from !== null && !seen.has(from.id) && seen.size < 500) {
    seen.add(from.id)
    const meta = crepo.getRunMeta(conn, from.id)
    const conv = meta?.conversation_id ? crepo.getConversation(conn, meta.conversation_id) : null
    if (conv?.tool_snapshot) return conv.tool_snapshot
    const empty = meta ? meta.history_empty : true
    if (!empty) {
      const manifest = from.manifest ?? {}
      const chatgpt = isChatGptWeb(from.model) || (manifest.chatgpt !== undefined && Array.isArray(manifest.tools) && (manifest.tools as unknown[]).length === 0)
      if (!chatgpt) {
        const rebuilt = reconstructToolSnapshot(manifest)
        if ('snapshot' in rebuilt) return rebuilt.snapshot
        throw new ToolSurfaceUnrecoverable(from.id, rebuilt.reason, from.session_id)
      }
      // ChatGPT on the web was sent no tool list by the harness: the list is the one of the history before it
    }
    from = from.resumes_run_id ? repo.getRun(conn, from.resumes_run_id) : null
  }
  return freshToolSnapshot(o.order)
}

/** The run's participant, conversation, origin and placement, decided before its row is written (and refused with
 *  nothing written: head_moved, a participant already speaking). */
export function resolveCollab(state: AppState, session: Session, o: {
  run_id: string; previous: Run | null; fresh: boolean; order: { tools: string[] | null; label?: string | null } | null
  interaction: { id: string; node: string } | null; relay: { id: string; step: number } | null
  spawned_by: string; label: string | null; model: string; wake: boolean; ui_task: string | null; collab: CollabStart | null
}): ResolvedCollab {
  const conn = state.conn
  const { rows, assignment } = assignmentOf(state, session.id)
  const prevA = o.previous ? assignment.runs.get(o.previous.id) ?? null : null
  // who it is
  let spec: ParticipantSpec
  if (o.collab?.participant) spec = o.collab.participant
  else if (o.order !== null) {
    // a run under an order is a separate task's (its order is what it is held to), whatever else it names
    if (prevA && prevA.role === 'separate' && prevA.key) spec = { key: prevA.key, role: 'separate', alias: null, group: null }
    // a pre-v12 child's follow-up under its order: the same child
    else if (prevA && prevA.role === 'child' && prevA.key) spec = { key: prevA.key, role: 'child', alias: null, group: null }
    else spec = { key: separateKey(o.run_id), role: 'separate', alias: null, group: null, label: o.order.label ?? o.label }
  } else if (o.interaction) {
    const node = repo.getNode(conn, o.interaction.id, o.interaction.node)
    const alias = node?.participant ?? o.interaction.node
    spec = { key: interactionKey(o.interaction.id, alias), role: 'member', alias, group: { kind: 'interaction', id: o.interaction.id } }
    const ix = repo.getInteraction(conn, o.interaction.id)
    spec.label = ix?.participants.find((p) => p.id === alias)?.label ?? null
  } else if (o.relay) {
    const relay = repo.getRelay(conn, o.relay.id)
    const alias = (relay ? relayAlias(relay, o.relay.step) : null) ?? `step${o.relay.step}`
    spec = { key: relayKey(o.relay.id, alias), role: 'member', alias, group: { kind: 'relay', id: o.relay.id }, label: relay?.participants.find((p, i) => (p.id || String.fromCharCode(65 + i)) === alias)?.label ?? null }
  } else spec = { key: mainKey(), role: 'main', alias: null, group: null }
  const pid = participantIdOf(session.id, spec.key)
  // the participant speaks once at a time: its conversation is one
  for (const h of state.runs.handles.values()) {
    if (h.session_id === session.id && !h.done && h.participant_id === pid && spec.role !== 'main') {
      throw new CollabRefused(`participant ${spec.alias ?? pid} is already running (run ${h.run_id}); a message to it waits until that run ends`, 409, 'participant_busy')
    }
  }
  const mine = rows.runs.filter((r) => assignment.runs.get(r.id)?.participant_id === pid)
  const latest = mine.at(-1) ?? null
  const expected = o.collab?.expected_head_run_id ?? null
  if (expected !== null && expected !== undefined && (latest?.id ?? null) !== expected) {
    throw new CollabRefused(`the participant's conversation moved on: its latest run is ${latest?.id ?? 'none'}, not ${expected}; read it again`, 409, 'head_moved')
  }
  // which conversation
  let conversation: ResolvedCollab['conversation']
  if (o.previous && prevA && prevA.participant_id === pid && prevA.conversation_id && assignment.conversations.get(prevA.conversation_id)?.runs.at(-1) === o.previous.id) {
    conversation = { id: prevA.conversation_id, fresh: false, forked_from_run_id: null, fork_reason: null }
  } else {
    const reason = !o.previous ? null : prevA?.participant_id === pid ? 'branch' : spec.role === 'member' && mine.length === 0 ? 'group_start' : 'participant_change'
    conversation = { id: conversationIdOf(session.id, pid, o.run_id), fresh: true, forked_from_run_id: o.previous?.id ?? null, fork_reason: reason }
  }
  // why and where
  const origin = o.collab?.origin ?? defaultOrigin({ spawned_by: o.spawned_by, label: o.label, order: o.order !== null, resumes: o.previous !== null, interaction: o.interaction, relay: o.relay, wake: o.wake, ui_task: o.ui_task })
  let placement: Placement
  if (o.collab?.placement) placement = o.collab.placement
  else if (spec.role === 'main') placement = { surface: 'thread', group: null, anchor: null }
  else if (spec.role === 'member' && spec.group?.kind === 'relay') placement = { surface: 'thread', group: spec.group, anchor: null }
  else if (spec.role === 'member' && spec.group) placement = { surface: 'group', group: spec.group, anchor: { kind: 'interaction', id: spec.group.id, basis: 'recorded' } }
  else if (spec.role === 'child' && prevA && prevA.role === 'child') placement = { surface: 'card', group: null, anchor: prevA.placement.anchor }
  else {
    const head = origin.director_turn_id ? null : mainHead(rows, assignment, { sessionWorkspaceOnly: true })
    placement = { surface: 'card', group: null, anchor: origin.director_turn_id ? { kind: 'director_turn', id: origin.director_turn_id, basis: origin.basis } : head ? { kind: 'run', id: head.id, basis: 'recorded' } : null }
  }
  // the tools: those the history it continues was made with (its own conversation's, or — a fork — the conversation
  // the run it starts from belongs to); a conversation with no history gets the run's own
  let snapshot = toolSnapshotFor(state, { previous: o.previous, order: o.order })
  // A newly introduced/different participant is a recorded new conversation, not a continuation of the source
  // participant's provider frame. Keep the inherited function definitions but choose its provider-native tools on
  // that new conversation's first request. Never mutate the source snapshot or strip a frame on a continuation.
  if (conversation.fresh && (conversation.fork_reason === 'group_start' || conversation.fork_reason === 'participant_change')) {
    const { provider_frame: _sourceFrame, ...definitions } = snapshot as ToolSnapshot & { provider_frame?: unknown }
    snapshot = definitions
  }
  const existing = crepo.getParticipant(conn, pid)
  return {
    participant: {
      id: pid, session_id: session.id, role: spec.role, alias: spec.alias, label: existing?.label || spec.label || '', model: o.model,
      group_kind: spec.group?.kind ?? null, group_id: spec.group?.id ?? null, legacy_key: spec.key, introduced_by: existing?.introduced_by ?? (mine[0] ? assignment.runs.get(mine[0].id)!.origin : origin),
    },
    conversation, origin, placement, snapshot, tool_surface: snapshot.surface,
  }
}

/** The rows a new run joins, in the caller's transaction: the participant and conversation (with the deterministic ids
 *  their projection gives, so a projected one keeps its id), the conversation's head, the edges into the run. */
export function writeCollab(state: AppState, sessionId: string, runId: string, r: ResolvedCollab, edges: Omit<NewEdge, 'to'>[]): void {
  const conn = state.conn
  crepo.ensureParticipant(conn, r.participant)
  const conv = crepo.ensureConversation(conn, {
    id: r.conversation.id, session_id: sessionId, participant_id: r.participant.id, forked_from_run_id: r.conversation.forked_from_run_id,
    fork_reason: r.conversation.fork_reason, root_run_id: r.conversation.fresh ? runId : null, head_run_id: null, tool_surface: r.tool_surface, tool_snapshot: r.snapshot,
  })
  if (!conv.tool_snapshot) crepo.setConversationSnapshot(conn, conv.id, r.tool_surface, r.snapshot)
  crepo.setConversationHead(conn, conv.id, runId)
  for (const e of edges) crepo.insertEdge(conn, sessionId, { ...e, to: { kind: 'run', id: runId } })
  if (r.origin.actor === 'director' && r.origin.director_turn_id && r.origin.basis === 'recorded') {
    crepo.insertEdge(conn, sessionId, { kind: 'dispatched', from: { kind: 'director_turn', id: r.origin.director_turn_id }, to: { kind: 'run', id: runId }, meta: { tool: null, tool_call_id: r.origin.tool_call_id } })
  }
}

/** A run as the API answers it: with its collab. */
export function withCollab<T extends Pick<Run, 'id' | 'session_id'>>(state: AppState, run: T, collab?: Map<string, RunCollab>): T & { collab: RunCollab | null } {
  const map = collab ?? collabOfRuns(state, run.session_id)
  return { ...run, collab: map.get(run.id) ?? null }
}

export { collabRunOf }
