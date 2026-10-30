/** The collaboration graph of a session (schema v25; docs/multi-agent-unification-design.md): its participants, their
 *  conversations, the groups that schedule them, every run with who it belongs to, why it started and where it is
 *  shown, the planned steps that have no run yet, and the typed edges between them — one answer, so every relation
 *  of a session is visible in one place. Read-only shapes (GET), plus the one body that addresses a participant.
 *
 *  Every edge names exact endpoints: a run id, never "the participant's latest". An edge is written once, when the
 *  fact happens (recorded), or derived from pre-v25 rows (projected / inferred) without writing anything back. A
 *  `received` edge means the harness put that run's final answer into the later run's opening message; a `cited`
 *  edge means an instruction referred to that run and nothing of it was handed over (`content_delivered: false`). */

import { z } from 'zod'
import type { Route } from './api.ts'
import { MAX_ATTACHMENTS_PER_MESSAGE, ROUTES } from './api.ts'
import {
  AnchorSchema, CitationsSchema, CollabBasisSchema, CollabSurfaceSchema, DirectorToolSurfaceSchema, GROUP_KINDS, GroupRefSchema,
  OriginSchema, ParticipantRoleSchema, ReceiveRunIdsSchema, RunCollabSchema, type CollabSurface, type RunCollab,
} from './collab_core.ts'
import { NodeStatusSchema } from './interaction.ts'
import { isThreadRun, RunStatusSchema, type Run } from './models.ts'

// ---- participants and conversations ------------------------------------------------------------------------------

export const ParticipantSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  role: ParticipantRoleSchema,
  /** the handle its group's turns name it by (`pt_3f2a9c`, `A`); null for the main agent and a separate task's */
  alias: z.string().nullable(),
  /** what the person reads: the group's label for it, an order's label, the route's label */
  label: z.string(),
  /** the route of its latest run (each run pins its own model) */
  model: z.string().nullable(),
  /** the group that introduced it (a member's interaction or relay); null otherwise */
  group: GroupRefSchema.nullable(),
  /** how it came to be: the origin of its first run (or of its group) */
  introduced_by: OriginSchema.nullable(),
  current_conversation_id: z.string().nullable(),
  latest_run_id: z.string().nullable(),
  /** from its runs: running (one is live), queued (a planned step of it waits), idle */
  state: z.enum(['idle', 'queued', 'running']),
  run_count: z.number().int(),
  basis: CollabBasisSchema,
  created_at: z.string(),
})
export type Participant = z.infer<typeof ParticipantSchema>

export const ConversationSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  participant_id: z.string(),
  /** the run whose history it started from (another participant's, or a branch of its own); null: it started fresh */
  forked_from_run_id: z.string().nullable(),
  root_run_id: z.string().nullable(),
  head_run_id: z.string().nullable(),
  /** its runs, oldest first */
  run_ids: z.array(z.string()),
  /** the agent tool surface its first run had (null: projected from a pre-v25 record) */
  tool_surface: z.string().nullable(),
  basis: CollabBasisSchema,
  created_at: z.string(),
})
export type Conversation = z.infer<typeof ConversationSchema>

// ---- groups: the scheduling policies --------------------------------------------------------------------------------

/** A group as the graph shows it: an interaction (a graph of nodes the harness schedules; its template or controller is
 *  its policy) or a relay (turns in order over rounds). A new pattern is a policy over the same graph, not a new kind. */
export const CollabGroupSchema = z.object({
  kind: z.enum(GROUP_KINDS),
  id: z.string(),
  status: z.string(),
  /** interaction: director | fixed; relay: null */
  controller: z.string().nullable(),
  /** interaction: independent | discussion | null (a director's plan) */
  template: z.string().nullable(),
  then: z.string().nullable(),
  workspace_policy: z.string().nullable(),
  /** relay: rounds planned */
  rounds: z.number().int().nullable(),
  participant_ids: z.array(z.string()),
  runs_started: z.number().int(),
  max_runs: z.number().int().nullable(),
  concurrency: z.number().int().nullable(),
  origin: OriginSchema.nullable(),
  anchor: AnchorSchema.nullable(),
  reason: z.string().nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
})
export type CollabGroup = z.infer<typeof CollabGroupSchema>

// ---- runs and planned nodes ------------------------------------------------------------------------------------------

export const CollabRunSchema = z.object({
  id: z.string(),
  status: RunStatusSchema,
  live: z.boolean(),
  model: z.string(),
  label: z.string().nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
  workspace_id: z.string().nullable(),
  resumes_run_id: z.string().nullable(),
  interaction_id: z.string().nullable(),
  interaction_node: z.string().nullable(),
  relay_id: z.string().nullable(),
  relay_step: z.number().int().nullable(),
  /** the first line of what the run was asked (the person's words, never a harness handover message) */
  user_text_head: z.string(),
  /** the length of its final answer (receipt.final_text), null before it ends */
  final_text_chars: z.number().int().nullable(),
  error: z.string().nullable(),
  collab: RunCollabSchema,
})
export type CollabRun = z.infer<typeof CollabRunSchema>

/** A step of an interaction's plan: its endpoint id is `<interaction_id>/<node_id>`. A step with runs is also its runs;
 *  a step without one is only this (a planned step). */
export const CollabNodeSchema = z.object({
  id: z.string(),
  interaction_id: z.string(),
  node_id: z.string(),
  /** plan: a step of the plan; followup: a participant's follow-up the person or a director asked for (v25) */
  kind: z.enum(['plan', 'followup']),
  participant_id: z.string().nullable(),
  alias: z.string(),
  status: NodeStatusSchema,
  run_ids: z.array(z.string()),
  current_run_id: z.string().nullable(),
  depends_on: z.array(z.string()),
  receives: z.array(z.string()),
  receive_runs: z.array(z.string()),
  cites: z.array(z.string()),
  workspace: z.string(),
  wave: z.number().int(),
})
export type CollabNode = z.infer<typeof CollabNodeSchema>

// ---- edges ------------------------------------------------------------------------------------------------------------

/** run: a run id; node: `<interaction_id>/<node_id>`; checkpoint, workspace: their ids; director_turn: a turn id;
 *  person: the person (id `person`); note: an interaction note's id. */
export const ENDPOINT_KINDS = ['run', 'node', 'checkpoint', 'workspace', 'director_turn', 'person', 'note'] as const
export const CollabEndpointSchema = z.object({ kind: z.enum(ENDPOINT_KINDS), id: z.string() })
export type CollabEndpoint = z.infer<typeof CollabEndpointSchema>

/** continues: the later run appends to the earlier one's conversation; forks: it starts a new conversation from the
 *  earlier one's history; after: it was started only once the earlier one ended (scheduling, nothing handed over);
 *  received: the earlier run's final answer was in its opening message; cited: an instruction for it referred to the
 *  earlier run, nothing of which was handed over; workspace: its workspace was made from, or is, that of the earlier
 *  endpoint; spawned: a parent run dispatched it; dispatched: a director turn's tool call started it; note: the
 *  person's interaction note was handed to it; adopted: a run's output was composed into the session's folder. */
export const EDGE_KINDS = ['continues', 'forks', 'after', 'received', 'cited', 'workspace', 'spawned', 'dispatched', 'note', 'adopted'] as const
export type EdgeKind = (typeof EDGE_KINDS)[number]

const edge = {
  id: z.string(),
  from: CollabEndpointSchema,
  to: CollabEndpointSchema,
  basis: CollabBasisSchema,
  created_at: z.string(),
}

export const ContinuesEdgeSchema = z.object({ ...edge, kind: z.literal('continues'), meta: z.object({ conversation_id: z.string() }) })
export const ForksEdgeSchema = z.object({
  ...edge, kind: z.literal('forks'),
  /** group_start: a group member's first run from the history its group pinned; branch: the same participant from an
   *  earlier run than its head; participant_change: another participant's history continued (a pre-v25 thread after a
   *  relay or an in-place interaction) */
  meta: z.object({ conversation_id: z.string(), reason: z.enum(['group_start', 'branch', 'participant_change']) }),
})
export const AfterEdgeSchema = z.object({
  ...edge, kind: z.literal('after'),
  meta: z.object({ interaction_id: z.string().nullable(), from_node: z.string().nullable(), to_node: z.string().nullable() }),
})
export const ReceivedEdgeSchema = z.object({
  ...edge, kind: z.literal('received'),
  meta: z.object({
    /** node_receives: a plan step's receives; relay_turn: a relay's packet; dispatch: a dispatch's receive_run_ids */
    via: z.enum(['node_receives', 'relay_turn', 'dispatch']),
    /** whole: the answer as written; cut: shortened at the packet limit (the cut named in the packet) */
    packet: z.enum(['whole', 'cut']),
    answer_chars: z.number().int().nullable(),
    handed_chars: z.number().int().nullable(),
    node: z.string().nullable(),
    content_delivered: z.literal(true),
    /** schema v29: an ended run of another session handed over on request (receive_across_sessions): where it came
     *  from; the edge is the receiving session's only. Absent: a run of this session */
    cross_session: z.literal(true).optional(),
    source_session_id: z.string().optional(),
    source_project_id: z.string().optional(),
    source_participant_id: z.string().nullable().optional(),
  }),
})
export const CitedEdgeSchema = z.object({
  ...edge, kind: z.literal('cited'),
  meta: z.object({
    by: z.enum(['director', 'person', 'connector']),
    director_turn_id: z.string().nullable(),
    note: z.string().nullable(),
    content_delivered: z.literal(false),
  }),
})
export const WorkspaceEdgeSchema = z.object({
  ...edge, kind: z.literal('workspace'),
  /** checkpoint_copy: a copy made from a checkpoint; same_workspace: the earlier run's workspace itself; source_mount: an
   *  output folder of its own over a live read-only source; session_folder: the session's own folder */
  meta: z.object({
    mode: z.enum(['checkpoint_copy', 'same_workspace', 'source_mount', 'session_folder']),
    workspace_id: z.string().nullable(),
    checkpoint_id: z.string().nullable(),
  }),
})
export const SpawnedEdgeSchema = z.object({ ...edge, kind: z.literal('spawned'), meta: z.object({}) })
export const DispatchedEdgeSchema = z.object({
  ...edge, kind: z.literal('dispatched'),
  meta: z.object({ tool: z.string().nullable(), tool_call_id: z.string().nullable() }),
})
export const NoteEdgeSchema = z.object({ ...edge, kind: z.literal('note'), meta: z.object({ interaction_id: z.string(), to: z.string() }) })
export const AdoptedEdgeSchema = z.object({
  ...edge, kind: z.literal('adopted'),
  meta: z.object({ interaction_id: z.string().nullable(), node: z.string().nullable(), checkpoint_id: z.string().nullable(), status: z.string(), composed_checkpoint_id: z.string().nullable() }),
})

export const CollabEdgeSchema = z.discriminatedUnion('kind', [
  ContinuesEdgeSchema, ForksEdgeSchema, AfterEdgeSchema, ReceivedEdgeSchema, CitedEdgeSchema, WorkspaceEdgeSchema,
  SpawnedEdgeSchema, DispatchedEdgeSchema, NoteEdgeSchema, AdoptedEdgeSchema,
])
export type CollabEdge = z.infer<typeof CollabEdgeSchema>

// ---- the thread's summaries ------------------------------------------------------------------------------------------

export const StatusCountsSchema = z.object({
  queued: z.number().int(), running: z.number().int(), done: z.number().int(), error: z.number().int(), cancelled: z.number().int(),
  total: z.number().int(),
})
export type StatusCounts = z.infer<typeof StatusCountsSchema>

/** One run a dispatch summary lists, with where its card is (`focus`). */
export const DispatchEntrySchema = z.object({
  run_id: z.string(),
  participant_id: z.string().nullable(),
  label: z.string().nullable(),
  model: z.string(),
  status: RunStatusSchema,
  surface: CollabSurfaceSchema,
  user_text_head: z.string(),
  finished_at: z.string().nullable(),
  /** what a jump opens: the participant's card, at this run */
  focus: z.object({ participant_id: z.string().nullable(), run_id: z.string() }),
})
export type DispatchEntry = z.infer<typeof DispatchEntrySchema>

/** What the thread shows of work placed elsewhere, at its anchor: the separate tasks (and follow-ups on cards) one
 *  request dispatched — how many, each one's status, a jump to each card; a group's line. Collapsible; never the
 *  runs' own streams. */
export const DispatchItemSchema = z.object({
  kind: z.literal('dispatch'),
  id: z.string(),
  /** when it happened: where it stands among the thread's entries when it has no anchor */
  at: z.string(),
  anchor: AnchorSchema.nullable(),
  origin: OriginSchema,
  entries: z.array(DispatchEntrySchema),
  counts: StatusCountsSchema,
})
export const GroupItemSchema = z.object({
  kind: z.literal('group'),
  id: z.string(),
  at: z.string(),
  anchor: AnchorSchema.nullable(),
  group: GroupRefSchema,
  status: z.string(),
  counts: StatusCountsSchema,
})
export const ThreadItemSchema = z.discriminatedUnion('kind', [DispatchItemSchema, GroupItemSchema])
export type ThreadItem = z.infer<typeof ThreadItemSchema>
export type DispatchItem = z.infer<typeof DispatchItemSchema>
export type GroupItem = z.infer<typeof GroupItemSchema>

// ---- the graph ------------------------------------------------------------------------------------------------------

export const CollabActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person') }),
  z.object({
    kind: z.literal('director'), id: z.string(), transport: z.string(), label: z.string(), model: z.string(), state: z.string(),
    tool_surface: DirectorToolSurfaceSchema, open: z.boolean(),
  }),
])
export type CollabActor = z.infer<typeof CollabActorSchema>

/** GET /api/sessions/:session_id/collaboration. `revision` changes whenever anything in it does: a page asks again with
 *  `?if_revision=` and gets 304 while it stands. */
export const CollaborationGraphSchema = z.object({
  session_id: z.string(),
  revision: z.string(),
  main_participant_id: z.string().nullable(),
  actors: z.array(CollabActorSchema),
  participants: z.array(ParticipantSchema),
  conversations: z.array(ConversationSchema),
  groups: z.array(CollabGroupSchema),
  runs: z.array(CollabRunSchema),
  nodes: z.array(CollabNodeSchema),
  edges: z.array(CollabEdgeSchema),
  thread_items: z.array(ThreadItemSchema),
  /** what of the graph is projected from pre-v25 rows, and which heuristics it took (each named in the design) */
  legacy: z.object({ projected_runs: z.number().int(), inferred_facts: z.number().int(), notes: z.array(z.string()) }),
})
export type CollaborationGraph = z.infer<typeof CollaborationGraphSchema>

/** GET /api/runs/:run_id/collaboration: one run's place in the graph — its participant and conversation, the edges into
 *  and out of it, and the runs at their other ends. */
export const RunCollaborationSchema = z.object({
  run: CollabRunSchema,
  participant: ParticipantSchema.nullable(),
  conversation: ConversationSchema.nullable(),
  incoming: z.array(CollabEdgeSchema),
  outgoing: z.array(CollabEdgeSchema),
  related_runs: z.array(CollabRunSchema),
})
export type RunCollaboration = z.infer<typeof RunCollaborationSchema>

/** GET /api/participants/:participant_id (`?limit=&before=` pages its runs, newest first). */
export const ParticipantDetailSchema = z.object({
  participant: ParticipantSchema,
  conversations: z.array(ConversationSchema),
  runs: z.array(CollabRunSchema),
  next_before: z.string().nullable(),
  edges: z.array(CollabEdgeSchema),
})
export type ParticipantDetail = z.infer<typeof ParticipantDetailSchema>

/** POST /api/participants/:participant_id/messages: a message to a participant, continuing its current conversation (a
 *  follow-up of its head run): the main agent's thread, a member's next step in its group, a separate task's next
 *  run under its order (narrowed, never widened). `expected_head_run_id` refuses (409) when the head moved meanwhile.
 *  Answers the Run it started (200), or — a member's step queued behind its group's others — QueuedFollowup (202). */
export const ParticipantMessageBodySchema = z.object({
  text: z.string(),
  model: z.string().nullable().optional(),
  thinking: z.string().nullable().optional(),
  attachments: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
  /** a separate task's order narrowed (a field left out is inherited; a field that would widen it is refused) */
  work_order: z.record(z.string(), z.unknown()).nullable().optional(),
  expected_head_run_id: z.string().nullable().optional(),
  cites: CitationsSchema.optional(),
  receive_run_ids: ReceiveRunIdsSchema.optional(),
  client_request_id: z.string().min(8).max(100).nullable().optional(),
})
export type ParticipantMessageBody = z.infer<typeof ParticipantMessageBodySchema>

/** HTTP 202 of POST /api/participants/:participant_id/messages and POST /api/runs/:run_id/resume: an interaction
 *  member's follow-up the harness took as a step of its interaction (`node_id`, kind followup) that cannot start yet
 *  (the group runs: its queue, its concurrency, one run at a time per participant). No run exists yet — there is no
 *  run id to read or to listen to; the step's run starts when the queue reaches it, as the same participant's next
 *  run (its `interaction_id`, its `interaction_node` = `node_id`). The same client key again answers with the same
 *  step (202), or its run once started (200). */
export const QueuedFollowupSchema = z.object({
  queued: z.literal(true),
  interaction_id: z.string(),
  node_id: z.string(),
  participant_id: z.string(),
})
export type QueuedFollowup = z.infer<typeof QueuedFollowupSchema>

/** What a follow-up answers: the Run it started (200), or the step it waits as (202). */
export type FollowupAnswer = Run | QueuedFollowup

export function isQueuedFollowup(answer: unknown): answer is QueuedFollowup {
  return QueuedFollowupSchema.safeParse(answer).success
}

/** The routes of the collaboration model, served from schema v25 on: ROUTES (api.ts) lists them with the rest (the
 *  frozen-table test checks that every one answers); this is that list's collaboration part. */
export const COLLABORATION_ROUTES: readonly Route[] = ROUTES.filter((r) => r.path.endsWith('/collaboration') || r.path.startsWith('/api/participants/'))

// ---- readings shared by the backend and the page -------------------------------------------------------------------

type SurfaceRow = Pick<Run, 'spawned_by' | 'work_order' | 'parent_run_id' | 'interaction_id' | 'relay_id'> & { collab?: RunCollab | null }

/** Where a run is shown: its placement when the answer carries one; otherwise what a pre-v25 row's own fields say
 *  (a person's action is a record, an interaction's node its group's, a run under an order or with a parent a card,
 *  else the thread). The fallback cannot see the resume chain: a pre-v25 follow-up of a participant reads as the
 *  thread's until the API's projection (`collab`) says otherwise — read `collab` where it is present. */
export function runSurface(run: SurfaceRow): CollabSurface {
  if (run.collab) return run.collab.placement.surface
  if (run.spawned_by === 'human_action') return 'record'
  if (run.interaction_id !== null) return 'group'
  if (run.work_order !== null || run.parent_run_id !== null) return 'card'
  return 'thread'
}

/** A run of the session's main agent shown in the thread (what the thread's composer continues, steers and stops). */
export function isMainThreadRun(run: SurfaceRow): boolean {
  if (run.collab) return run.collab.participant_role === 'main' && run.collab.placement.surface === 'thread'
  return isThreadRun(run) && run.relay_id === null && run.interaction_id === null
}
