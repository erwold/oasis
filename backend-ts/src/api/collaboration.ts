/** The collaboration model's routes (schema v25; contract/src/collaboration.ts COLLABORATION_ROUTES) and the one path
 *  every follow-up takes — `/api/runs/:id/resume`, `POST /api/participants/:id/messages`, a director's
 *  `start_run(resume_run_id)`: the run named belongs to a participant, and the new run is that participant's next one
 *  (the main agent's thread; a member's next step in its group; a relay member's own conversation; a separate task's
 *  next run under its order, narrowed, never widened). Every check is made before anything starts. */

import { Hono, type Context } from 'hono'
import {
  ACTIVE_RUN_STATUSES, ParticipantMessageBodySchema, type Citation, type CollabEdge, type ParticipantDetail, type Run, type RunCollaboration, type Session,
} from '@oasis-code/contract'
import {
  assignmentOf, CollabRefused, collabOfRuns, collabRunOf, EMPTY_HANDOVER, graphOf, prepareHandover, revisionOf, toolSnapshotFor, type CollabStart, type Handover,
} from '../agent/collab.ts'
import { buildGraph, relayKey } from '../agent/collab_projection.ts'
import { InteractionInvalid } from '../agent/interactions.ts'
import { KeyConflict } from '../agent/runner.ts'
import { narrowOrder, OrderWidened, parseWorkOrder, WorkOrderInvalid } from '../agent/work_orders.ts'
import * as crepo from '../db/collab_repo.ts'
import * as repo from '../db/repo.ts'
import { findModel } from '../llm/catalog.ts'
import { attachmentRefusal } from '@oasis-code/contract'
import { attachmentsFor } from './attachments.ts'
import { HttpError, intentOf, parseBody, requestOrigin, withoutManifest, type Api, type RequestOrigin } from './common.ts'
import { thinkingOr400 } from './runs.ts'
import { requireSession, type AppState } from './state.ts'

/** A refusal of the collaboration model, a key used for another intent, an interaction's refusal: as the API says it. */
export function asHttpError(error: unknown): unknown {
  if (error instanceof HttpError) return error
  if (error instanceof CollabRefused) return new HttpError(error.status, error.message, error.code)
  if (error instanceof KeyConflict) return new HttpError(409, error.message, 'key_conflict')
  if (error instanceof InteractionInvalid) return new HttpError(error.status, error.message, error.code, error.extra)
  return error
}

/** A run as the API answers it once the collaboration model knows it: without its manifest, with its collab. */
export function runAnswer(state: AppState, run: Run): Record<string, unknown> {
  const collab = collabOfRuns(state, run.session_id).get(run.id) ?? null
  // a run queued behind its folder's writer: where it waits (GET /api/runs/:id carries it always, null when none)
  const waiting = run.status === 'queued' ? state.runs.waitingOf(run.id) : null
  return { ...withoutManifest(run), collab, ...(waiting !== null ? { waiting } : {}) }
}

export interface FollowupBody {
  text: string
  model?: string | null
  thinking?: string | null
  attachments: string[]
  work_order?: Record<string, unknown> | null
  client_request_id?: string | null
  cites?: Citation[]
  receive_run_ids?: string[]
  /** schema v29: receive_run_ids may name other sessions' ended runs (api.ts ResumeBodySchema) */
  receive_across_sessions?: boolean
  expected_head_run_id?: string | null
  /** the request's intent when the route made it (the participants route keys it by the participant, not by the run
   *  that happens to be its head when a resend arrives) */
  intent?: string | null
}

/** The new run of a follow-up, or — a member's step queued behind its group's others — where it waits. */
export type FollowupResult = { run: Run } | { queued: { interaction_id: string; node_id: string; participant_id: string } }

/** A follow-up of `previous`: the next run of the participant it belongs to. Every refusal is the API's (4xx). */
export async function continueParticipant(api: Api, c: Context, previous: Run, body: FollowupBody): Promise<FollowupResult> {
  try {
    return await followupOf(api.state, previous, body, (sessionId, role) => requestOrigin(c, api.state, sessionId, role === 'member' ? 'followup' : 'resume'))
  } catch (error) {
    throw asHttpError(error)
  }
}

/** A watch's report continuing the conversation of the run that set it: the participant's next run (or its group's
 *  next step), opened by the harness's message, never the person's. */
export async function wakeParticipant(state: AppState, head: Run, o: { text: string; client_request_id: string; watch_id: string }): Promise<FollowupResult> {
  try {
    return await followupOf(state, head, { text: o.text, attachments: [], client_request_id: o.client_request_id }, () => ({
      origin: {
        actor: 'watch', request: 'wake', client: null, director_session_id: null, director_turn_id: null, tool_call_id: null, interaction_id: null, relay_id: null,
        watch_id: o.watch_id, ui_task_id: null, parent_run_id: null, basis: 'recorded',
      },
      spawned_by: 'wake', via: null, tool_surface: null,
    }))
  } catch (error) {
    throw asHttpError(error)
  }
}

async function followupOf(state: AppState, previous: Run, body: FollowupBody, ask: (sessionId: string, role: string) => RequestOrigin): Promise<FollowupResult> {
  if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(previous.status)) throw new HttpError(409, `run ${previous.id} is still ${previous.status}; a follow-up needs it finished`)
  // the words go as the sender wrote them (whitespace too): only an empty message is refused
  if (!body.text.trim()) throw new HttpError(400, 'text is required')
  const text = body.text
  if (previous.spawned_by === 'human_action' || previous.workspace_id === null) throw new HttpError(400, "this row records a person's action; it has no conversation to continue")
  const session = requireSession(state, previous.session_id)
  const { rows, assignment } = assignmentOf(state, session.id)
  const a = assignment.runs.get(previous.id)
  if (!a || a.participant_id === null || a.role === null) throw new HttpError(400, `run ${previous.id} belongs to no participant; it cannot be continued`)
  const asked = ask(session.id, a.role)
  const wake = asked.origin.actor === 'watch'
  const thinking = thinkingOr400(body.thinking)
  const intent = body.intent !== undefined && body.intent !== null ? body.intent : body.client_request_id ? intentOf({
    route: 'followup', run: previous.id, text, model: body.model ?? null, thinking, attachments: body.attachments, work_order: body.work_order ?? null,
    cites: body.cites ?? [], receive_run_ids: body.receive_run_ids ?? [], expected_head_run_id: body.expected_head_run_id ?? null,
    ...(body.receive_across_sessions ? { receive_across_sessions: true } : {}),
  }) : null
  // a resend of a follow-up the harness already took: its run (the same intent), or the step it is queued as
  if (body.client_request_id) {
    const earlier = repo.runForClientRequest(state.conn, session.id, body.client_request_id)
    if (earlier !== null) { state.runs.checkIntent(body.client_request_id, earlier.id, intent); return { run: earlier } }
    // a step still queued under the key: the same follow-up again (its interaction answers with it), else refused
    const held = crepo.queuedStepWithKey(state.conn, session.id, body.client_request_id)
    if (held !== null && (a.role !== 'member' || a.group?.id !== held.interaction_id || (held.intent_sha !== null && held.intent_sha !== intent))) {
      throw new KeyConflict(body.client_request_id, `${held.interaction_id}/${held.node_id}`)
    }
  }
  // what is checked before anything is written: the head the sender saw, what the dispatch names, the attachments,
  // and that the conversation's tool list can be restored as it was sent (else nothing starts: a new conversation is
  // the way on, never a changed list under the same one)
  const expected = body.expected_head_run_id ?? null
  if (expected !== null) {
    const latest = rows.runs.filter((r) => assignment.runs.get(r.id)?.participant_id === a.participant_id).at(-1) ?? null
    if ((latest?.id ?? null) !== expected) throw new HttpError(409, `the participant's conversation moved on: its latest run is ${latest?.id ?? 'none'}, not ${expected}; read it again`, 'head_moved')
  }
  const handover = prepareHandover(state, session, { cites: body.cites, receive_run_ids: body.receive_run_ids, by: asked.origin, across_sessions: body.receive_across_sessions === true })
  const attachments = attachmentsFor(state, session, body.attachments)
  toolSnapshotFor(state, { previous, order: null })
  const collab = (extra: Partial<CollabStart> = {}): CollabStart => ({
    origin: asked.origin, edges: handover.edges, lines: handover.lines, handover: handover.lines.length ? { received: handover.received, cited: handover.cited } : null,
    expected_head_run_id: body.expected_head_run_id ?? null, intent_sha: intent, ...extra,
  })
  const checkModel = (model: string) => {
    if (!state.runs.knowsModel(model)) throw new HttpError(400, `unknown model: ${model}`)
    if (attachments.length) {
      const cfg = findModel(state.config, model)
      const refusal = cfg && attachmentRefusal(cfg.capabilities, attachments, cfg.label || cfg.id)
      if (refusal) throw new HttpError(400, refusal)
    }
  }
  const start = async (make: () => Promise<Run>): Promise<Run> => {
    try {
      return await state.runs.startOnce(session.id, body.client_request_id, make, intent)
    } catch (error) {
      const known = asHttpError(error)
      if (known instanceof HttpError) throw known
      throw new HttpError(/already has an active run|is still|being written/.test((error as Error).message) ? 409 : 400, (error as Error).message)
    }
  }
  // an order narrows a separate task's run only: a thread's or a member's conversation never takes one on (it would
  // change what that conversation may do under it)
  if (a.role !== 'separate' && !(a.role === 'child' && previous.work_order !== null) && body.work_order) throw new HttpError(400, 'a work order narrows a separate task\'s run; this run is a participant\'s conversation, which takes none')
  if (a.role === 'main') {
    const model = body.model || previous.model
    checkModel(model)
    const run = await start(() => state.runs.start(session, text, {
      wake, model_id: model, resumes_run_id: previous.id, spawned_by: asked.spawned_by, label: asked.via, thinking, attachments, client_request_id: body.client_request_id ?? null,
      collab: collab(),
    }))
    return { run }
  }
  if (a.role === 'member' && a.group?.kind === 'interaction') {
    const interaction = repo.getInteraction(state.conn, a.group.id)
    if (interaction === null) throw new HttpError(409, `the interaction ${a.group.id} of this run is not in the record`)
    const model = body.model || previous.model
    checkModel(model)
    try {
      const out = await state.interactions.followup(interaction, {
        alias: a.alias!, resumes: previous, text, origin: asked.origin, model, thinking, attachments, client_request_id: body.client_request_id ?? null,
        cites: body.cites ?? [], receive_run_ids: body.receive_run_ids ?? [], handover, expected_head_run_id: body.expected_head_run_id ?? null, intent_sha: intent,
        spawned_by: asked.spawned_by, label: asked.via,
      })
      if (out.run) return { run: out.run }
      return { queued: { interaction_id: interaction.id, node_id: out.node.id, participant_id: a.participant_id } }
    } catch (error) {
      const known = asHttpError(error)
      if (known instanceof HttpError) throw known
      throw new HttpError(/already has an active run|is still|being written/.test((error as Error).message) ? 409 : 400, (error as Error).message)
    }
  }
  if (a.role === 'member' && a.group?.kind === 'relay') {
    // a relay member's own conversation, on the session's folder: its own run, never a turn of the relay (the relay's
    // schedule does not hear of it — nothing advances)
    const model = body.model || previous.model
    checkModel(model)
    const run = await start(() => state.runs.start(session, text, {
      wake, model_id: model, resumes_run_id: previous.id, workspace_id: previous.workspace_id, spawned_by: asked.spawned_by, label: previous.label ?? asked.via, thinking, attachments,
      client_request_id: body.client_request_id ?? null, keep_session_model: true,
      collab: collab({ participant: { key: a.key ?? relayKey(a.group!.id, a.alias ?? '?'), role: 'member', alias: a.alias, group: a.group }, placement: { surface: 'thread', group: a.group, anchor: null } }),
    }))
    return { run }
  }
  if (a.role === 'child' && previous.work_order === null) {
    // a pre-v12 child run that ran under no order: the same child goes on in its own workspace, on its own card, with
    // its conversation's tool list (no tool is added; nothing here lets it start agents of its own)
    const model = body.model || previous.model
    checkModel(model)
    const run = await start(() => state.runs.start(session, text, {
      wake, model_id: model, resumes_run_id: previous.id, workspace_id: previous.workspace_id, spawned_by: asked.spawned_by, label: previous.label ?? asked.via, thinking, attachments,
      client_request_id: body.client_request_id ?? null, keep_session_model: true,
      collab: collab({ participant: { key: a.key ?? `child:${previous.id}`, role: 'child', alias: null, group: null }, placement: { surface: 'card', group: null, anchor: a.placement.anchor } }),
    }))
    return { run }
  }
  if (a.role === 'separate' || a.role === 'child') {
    // the follow-up runs under the resumed run's order (a separate task's, or the one a pre-v12 child carried): what
    // the body gives narrows it, nothing in it widens it
    let order = null
    try {
      const rawOrder = previous.work_order === null ? null
        : body.work_order !== null && body.work_order !== undefined ? narrowOrder(previous.work_order, body.work_order) : previous.work_order
      if (rawOrder !== null) order = parseWorkOrder({ ...rawOrder, prompt: text, resumes_run_id: previous.id, ...(body.model ? { model: body.model } : {}) })
    } catch (error) {
      if (error instanceof OrderWidened) throw new HttpError(400, error.message)
      if (error instanceof WorkOrderInvalid) throw new HttpError(400, `invalid work order: ${error.message}`)
      throw error
    }
    if (order === null) throw new HttpError(400, `run ${previous.id} is a separate task's but carries no order to continue under`)
    const model = body.model || order.model || previous.model
    checkModel(model)
    const run = await start(() => state.runs.start(session, text, {
      wake, model_id: model, spawned_by: asked.spawned_by, label: order.label ? order.label : previous.label ?? asked.via,
      work_order: order, resumes_run_id: previous.id, workspace_id: previous.workspace_id, thinking, attachments, client_request_id: body.client_request_id ?? null,
      collab: collab(),
    }))
    return { run }
  }
  throw new HttpError(400, `run ${previous.id} is a ${a.role} run; it is not continued here`)
}

/** Where a participant id lives: the participants table, else the session whose projection gives it (remembered). */
const participantSessions = new Map<string, string>()

function sessionOfParticipant(state: AppState, participantId: string): string | null {
  const recorded = crepo.getParticipant(state.conn, participantId)
  if (recorded) return recorded.session_id
  const known = participantSessions.get(participantId)
  if (known) return known
  for (const row of state.conn.all("SELECT id FROM sessions WHERE status != 'deleted' ORDER BY updated_at DESC")) {
    const sid = String(row.id)
    const { assignment } = assignmentOf(state, sid)
    for (const pid of assignment.participants.keys()) participantSessions.set(pid, sid)
    if (assignment.participants.has(participantId)) return sid
  }
  return null
}

export function collaborationRoutes(api: Api): Hono {
  const app = new Hono()
  const { state } = api

  app.get('/api/sessions/:session_id/collaboration', (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    const revision = revisionOf(state, session.id)
    const asked = c.req.query('if_revision')
    if (asked && asked === revision) return c.body(null, 304)
    const graph = graphOf(state, session.id)
    for (const p of graph.participants) participantSessions.set(p.id, session.id)
    return c.json(graph)
  })

  app.get('/api/runs/:run_id/collaboration', (c) => {
    const run = repo.getRun(state.conn, c.req.param('run_id'))
    if (run === null) throw new HttpError(404, `run not found: ${c.req.param('run_id')}`)
    const { rows, assignment } = assignmentOf(state, run.session_id)
    const graph = buildGraph(rows, revisionOf(state, run.session_id), assignment)
    const me = graph.runs.find((r) => r.id === run.id)!
    const incoming = graph.edges.filter((e) => e.to.kind === 'run' && e.to.id === run.id)
    const outgoing = graph.edges.filter((e) => e.from.kind === 'run' && e.from.id === run.id)
    const otherIds = new Set([...incoming.map((e) => e.from), ...outgoing.map((e) => e.to)].filter((p) => p.kind === 'run').map((p) => p.id))
    const answer: RunCollaboration = {
      run: me, participant: graph.participants.find((p) => p.id === me.collab.participant_id) ?? null,
      conversation: graph.conversations.find((cv) => cv.id === me.collab.conversation_id) ?? null,
      incoming, outgoing, related_runs: graph.runs.filter((r) => otherIds.has(r.id)),
    }
    return c.json(answer)
  })

  app.get('/api/participants/:participant_id', (c) => {
    const pid = c.req.param('participant_id')
    const sid = sessionOfParticipant(state, pid)
    if (sid === null) throw new HttpError(404, `participant not found: ${pid}`)
    const graph = graphOf(state, sid)
    const participant = graph.participants.find((p) => p.id === pid)
    if (!participant) throw new HttpError(404, `participant not found: ${pid}`)
    const limitRaw = Number(c.req.query('limit') ?? 50)
    const limit = Number.isInteger(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 50
    const before = c.req.query('before') ?? null
    const mine = graph.runs.filter((r) => r.collab.participant_id === pid).reverse()
    const from = before ? mine.findIndex((r) => r.id === before) + 1 : 0
    const page = mine.slice(Math.max(0, from), Math.max(0, from) + limit)
    const ids = new Set(mine.map((r) => r.id))
    const edges: CollabEdge[] = graph.edges.filter((e) => (e.from.kind === 'run' && ids.has(e.from.id)) || (e.to.kind === 'run' && ids.has(e.to.id)))
    const answer: ParticipantDetail = {
      participant, conversations: graph.conversations.filter((cv) => cv.participant_id === pid), runs: page,
      next_before: from + limit < mine.length ? page.at(-1)?.id ?? null : null, edges,
    }
    return c.json(answer)
  })

  app.post('/api/participants/:participant_id/messages', async (c) => {
    const pid = c.req.param('participant_id')
    const sid = sessionOfParticipant(state, pid)
    if (sid === null) throw new HttpError(404, `participant not found: ${pid}`)
    const body = await parseBody(c, ParticipantMessageBodySchema)
    const session = requireSession(state, sid)
    const { rows, assignment } = assignmentOf(state, sid)
    const participant = assignment.participants.get(pid)
    if (!participant) throw new HttpError(404, `participant not found: ${pid}`)
    // the request's intent, by the participant it is sent to (not the run that is its head when a resend arrives):
    // the same key again answers with what the first send started — its run, or the step it waits as — and the same
    // key with anything else changed is refused
    const key = body.client_request_id ?? null
    const intent = key !== null ? intentOf({
      route: 'participant', participant: pid, text: body.text, model: body.model ?? null, thinking: thinkingOr400(body.thinking), attachments: body.attachments,
      work_order: body.work_order ?? null, cites: body.cites ?? [], receive_run_ids: body.receive_run_ids ?? [], expected_head_run_id: body.expected_head_run_id ?? null,
    }) : null
    if (key !== null) {
      const earlier = repo.runForClientRequest(state.conn, sid, key)
      try {
        if (earlier !== null) { state.runs.checkIntent(key, earlier.id, intent); return c.json(runAnswer(state, earlier)) }
        const held = crepo.queuedStepWithKey(state.conn, sid, key)
        if (held !== null) {
          if (held.intent_sha !== intent) throw new KeyConflict(key, `${held.interaction_id}/${held.node_id}`)
          return c.json({ queued: true, interaction_id: held.interaction_id, node_id: held.node_id, participant_id: pid }, 202)
        }
      } catch (error) { throw asHttpError(error) }
    }
    const mine = rows.runs.filter((r) => assignment.runs.get(r.id)?.participant_id === pid)
    const latest = mine.at(-1) ?? null
    if (latest === null) {
      // the main agent before its first run: a first message of the thread
      if (participant.role !== 'main') throw new HttpError(409, 'the participant has no run to continue yet')
      return firstThreadMessage(api, c, session, body, intent)
    }
    const previous = repo.getRun(state.conn, latest.id)!
    const out = await continueParticipant(api, c, previous, { ...body, expected_head_run_id: body.expected_head_run_id ?? null, intent })
    if ('queued' in out) return c.json({ queued: true, ...out.queued }, 202)
    return c.json(runAnswer(state, out.run))
  })

  return app
}

async function firstThreadMessage(api: Api, c: Context, session: Session, body: { text: string; model?: string | null; thinking?: string | null; attachments: string[]; cites?: Citation[]; receive_run_ids?: string[]; client_request_id?: string | null }, routeIntent: string | null = null): Promise<Response> {
  const { state } = api
  if (!body.text.trim()) throw new HttpError(400, 'text is required')
  const asked = requestOrigin(c, state, session.id, 'message')
  const handover: Handover = prepareHandover(state, session, { cites: body.cites, receive_run_ids: body.receive_run_ids, by: asked.origin }) ?? EMPTY_HANDOVER
  const model = body.model || session.model
  if (!state.runs.knowsModel(model)) throw new HttpError(400, `unknown model: ${model}`)
  const thinking = thinkingOr400(body.thinking)
  // the fingerprint covers everything the run is asked with: the same key with other words, model, effort, images or
  // references is another request (refused), never a resend
  const intent = routeIntent ?? (body.client_request_id ? intentOf({
    route: 'participant_first', session: session.id, text: body.text, model, thinking, attachments: body.attachments, cites: body.cites ?? [], receive_run_ids: body.receive_run_ids ?? [],
  }) : null)
  try {
    const run = await state.runs.startOnce(session.id, body.client_request_id, () => state.runs.start(session, body.text, {
      model_id: model, thinking, attachments: attachmentsFor(state, session, body.attachments), client_request_id: body.client_request_id ?? null,
      spawned_by: asked.spawned_by, label: asked.via,
      collab: { origin: asked.origin, edges: handover.edges, lines: handover.lines, handover: handover.lines.length ? { received: handover.received, cited: handover.cited } : null, intent_sha: intent },
    }), intent)
    return c.json(runAnswer(state, run))
  } catch (error) {
    const known = asHttpError(error)
    if (known instanceof HttpError) throw known
    throw new HttpError(/already has an active run|is still|being written/.test((error as Error).message) ? 409 : 400, (error as Error).message)
  }
}

export { collabRunOf }
