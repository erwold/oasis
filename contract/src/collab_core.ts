/** The collaboration model's core vocabulary (schema v25; docs/multi-agent-unification-design.md): who a run belongs
 *  to, why it started and where it is shown — three facts kept apart, never read off one another.
 *
 *  - A PARTICIPANT is a stable agent identity inside one session: the session's own agent (`main`), a member of a group
 *    (an interaction's or a relay's participant), a separate task's agent, a child a run dispatched. It keeps its id
 *    across every run, follow-up and restart.
 *  - A CONVERSATION is one append-only message history of one participant; each run appends to exactly one. A fresh
 *    start, or a run that continues another participant's history, opens a new one (`forked_from_run_id`).
 *  - A run's ORIGIN says who or what started it (the person, a director turn, a connector client, a watch, a UI task,
 *    the harness's scheduler, a parent run) — never where it is shown.
 *  - A run's PLACEMENT says where it is shown (the thread, a group's board, a card) and where in the thread its summary
 *    stands (the anchor) — never who started it.
 *  - Typed EDGES (collaboration.ts) say how runs relate: a continuation, a scheduling order, an answer actually handed
 *    over, a citation that handed nothing over, a workspace a run was made from, a parent.
 *
 *  This file imports nothing of the contract (models.ts imports it); the graph's shapes are in collaboration.ts. */

import { z } from 'zod'

/** A run's handle (`run_` and the id's hex). */
export const RUN_ID = /^run_[A-Za-z0-9]{1,64}$/
export const RunIdSchema = z.string().regex(RUN_ID, 'a run id (run_…)')

/** A participant's id: `pa_` and 16 hex — the same id whether the row was written by v25+ code or projected from an
 *  older record (the projection derives it deterministically, and a later write of that participant keeps it). */
export const PARTICIPANT_KEY = /^pa_[0-9a-f]{16}$/
/** A conversation's id: `cv_` and 16 hex, derived the same way. */
export const CONVERSATION_KEY = /^cv_[0-9a-f]{16}$/

/** main: the session's own agent (the thread's conversation; one per session); member: a participant of a group (an
 *  interaction or a relay), introduced by it and keeping its membership in every follow-up; separate: the agent of a
 *  separate task (a work order on a workspace of its own); child: a run another run dispatched (none today: no agent
 *  tool dispatches; the role is reserved so a later one needs no new vocabulary). */
export const PARTICIPANT_ROLES = ['main', 'member', 'separate', 'child'] as const
export const ParticipantRoleSchema = z.enum(PARTICIPANT_ROLES)
export type ParticipantRole = z.infer<typeof ParticipantRoleSchema>

/** How a fact of the model is known: recorded (written by the harness when it happened, v25+), projected (derived
 *  deterministically from pre-v25 rows, read-only), inferred (projected with a heuristic the design names — shown as
 *  such, never presented as recorded). */
export const COLLAB_BASES = ['recorded', 'projected', 'inferred'] as const
export const CollabBasisSchema = z.enum(COLLAB_BASES)
export type CollabBasis = z.infer<typeof CollabBasisSchema>

// ---- origin: who or what started a run ---------------------------------------------------------------------------

/** person: the person in the app (composer, a card, a button); director: a director turn of this harness (native, or the
 *  bridge's turn the run was started in); connector: an MCP client outside any held turn (its client label in `client`);
 *  watch: a watch the main agent set fired; ui_task: an Intelligent UI `run` action; scheduler: the harness started it
 *  for a plan (an interaction's node, a relay's turn) — the plan's own origin is the group's; agent: a parent run
 *  dispatched it; harness: the harness itself (a recorded action, a restart repair). */
export const ORIGIN_ACTORS = ['person', 'director', 'connector', 'watch', 'ui_task', 'scheduler', 'agent', 'harness'] as const
export const OriginActorSchema = z.enum(ORIGIN_ACTORS)
export type OriginActor = z.infer<typeof OriginActorSchema>

/** What was asked: a message to a participant's conversation, a follow-up of a named run, a separate task, a plan's node
 *  (first run or a run again), a relay turn, a wake, a UI task, a child, a person's action recorded as a row. */
export const ORIGIN_REQUESTS = ['message', 'resume', 'separate', 'node', 'node_retry', 'followup', 'relay_turn', 'wake', 'ui_task', 'child', 'action'] as const
export const OriginRequestSchema = z.enum(ORIGIN_REQUESTS)
export type OriginRequest = z.infer<typeof OriginRequestSchema>

export const OriginSchema = z.object({
  actor: OriginActorSchema,
  request: OriginRequestSchema,
  /** the MCP client's label (ChatGPT, …) when a connector carried the request; shown only, it grants nothing */
  client: z.string().nullable().default(null),
  director_session_id: z.string().nullable().default(null),
  /** the director turn whose tool call started the run (native: recorded; a bridge turn: the turn held when the
   *  connector call arrived — basis says which) */
  director_turn_id: z.string().nullable().default(null),
  tool_call_id: z.string().nullable().default(null),
  interaction_id: z.string().nullable().default(null),
  relay_id: z.string().nullable().default(null),
  watch_id: z.string().nullable().default(null),
  ui_task_id: z.string().nullable().default(null),
  parent_run_id: z.string().nullable().default(null),
  basis: CollabBasisSchema.default('recorded'),
})
export type Origin = z.infer<typeof OriginSchema>

// ---- placement: where a run is shown -------------------------------------------------------------------------------

/** thread: inline in the session's thread (the main agent's runs; a relay's turns); group: on its group's board, the
 *  thread showing the group's summary at its anchor; card: a card of its own (a separate task, a child), the thread
 *  showing a dispatch summary at its anchor; record: a row of the record only (a person's action, never a model run). */
export const COLLAB_SURFACES = ['thread', 'group', 'card', 'record'] as const
export const CollabSurfaceSchema = z.enum(COLLAB_SURFACES)
export type CollabSurface = z.infer<typeof CollabSurfaceSchema>

export const GROUP_KINDS = ['interaction', 'relay'] as const
export const GroupRefSchema = z.object({ kind: z.enum(GROUP_KINDS), id: z.string() })
export type GroupRef = z.infer<typeof GroupRefSchema>

/** Where in the thread a summary stands: after a director turn's answer, after a thread run, at a group's own item. */
export const AnchorSchema = z.object({
  kind: z.enum(['director_turn', 'run', 'interaction', 'relay']),
  id: z.string(),
  basis: CollabBasisSchema.default('recorded'),
})
export type Anchor = z.infer<typeof AnchorSchema>

export const PlacementSchema = z.object({
  surface: CollabSurfaceSchema,
  group: GroupRefSchema.nullable().default(null),
  /** null: by time (created_at) */
  anchor: AnchorSchema.nullable().default(null),
})
export type Placement = z.infer<typeof PlacementSchema>

/** What a run carries of the model (on Run, RunTreeRow and every collaboration answer). Absent on an answer of a
 *  pre-v25 backend; on a pre-v25 row the API projects it (basis projected | inferred) and writes nothing. */
export const RunCollabSchema = z.object({
  /** null: a row that records a person's action (no model ran) */
  participant_id: z.string().nullable(),
  participant_role: ParticipantRoleSchema.nullable(),
  conversation_id: z.string().nullable(),
  /** the run's place in its conversation, 1-based */
  conversation_seq: z.number().int().nullable().default(null),
  origin: OriginSchema,
  placement: PlacementSchema,
  /** how the participant and conversation are known */
  basis: CollabBasisSchema,
})
export type RunCollab = z.infer<typeof RunCollabSchema>

/** A live run of the session as SessionDetail lists it (v25): the main agent's in `active_run`, every live run here. */
export const ActiveRunSchema = z.object({
  id: z.string(),
  status: z.string(),
  label: z.string().nullable(),
  model: z.string().nullable(),
  participant_id: z.string().nullable(),
  participant_role: ParticipantRoleSchema.nullable(),
  surface: CollabSurfaceSchema,
})
export type ActiveRun = z.infer<typeof ActiveRunSchema>

// ---- what a dispatch may name: citations and handed-over answers -------------------------------------------------

/** How many runs one dispatch may cite, and how many answers it may have handed over. */
export const MAX_CITATIONS = 8
export const MAX_RECEIVED_RUNS = 6
export const MAX_CITATION_NOTE_CHARS = 300

/** A run an instruction refers to: an exact run of the same session that has ended. Recorded as a `cited` edge and
 *  named to the agent by run and participant; nothing of the cited run's content is handed over by it. */
export const CitationSchema = z.object({
  run_id: RunIdSchema,
  /** what of it the instruction refers to, in the caller's words (shown with the edge) */
  note: z.string().trim().max(MAX_CITATION_NOTE_CHARS).nullable().optional(),
})
export type Citation = z.infer<typeof CitationSchema>
export const CitationsSchema = z.array(CitationSchema).max(MAX_CITATIONS)

/** Runs whose final answers the harness hands to the new run, whole, each as a packet of the opening message (the
 *  answer as written, its tool-call lines, the receipt's measured facts): exact runs of the same session that have
 *  ended. Recorded as `received` edges with what was handed. */
export const ReceiveRunIdsSchema = z.array(RunIdSchema).max(MAX_RECEIVED_RUNS)

// ---- tool surfaces: one fixed tool list per conversation ----------------------------------------------------------

/** The director tool surfaces. A conversation keeps the surface it began with for every request: its tool list,
 *  schemas, descriptions and system instructions never change under it (append-only context, a stable prompt cache).
 *  director.v1 is the 18-tool connector (11 for a native director) as of schema v24; director.v2 adds what the
 *  unification design lists; director.v3 adds steer_run (words into a run while it works) and says a participant's
 *  follow-up is not counted in its group's budget; director.v4 says a note posted to a thread is rendered as Markdown
 *  with LaTeX math; director.v5 asks the connector's client (ChatGPT on the web) to record its final answer in the
 *  session's thread, at the person's request; director.v6 runs its commands, sessions and dispatches under the
 *  session's access (full or sandbox) where v1–v5 keep the sandbox they were described with; director.v7 says a
 *  session is one task again, task_session_id only linking a session into another's task; director.v8 adds SSH targets
 *  (projects on a saved target, its directories, port forwards). New capabilities reach a new conversation (a director session
 *  opened on the newest surface, a connector URL of it), never an old one. */
export const DIRECTOR_TOOL_SURFACES = ['director.v1', 'director.v2', 'director.v3', 'director.v4', 'director.v5', 'director.v6', 'director.v7', 'director.v8', 'director.v9', 'director.v10', 'director.v11'] as const
export const DirectorToolSurfaceSchema = z.enum(DIRECTOR_TOOL_SURFACES)
export type DirectorToolSurface = z.infer<typeof DirectorToolSurfaceSchema>
export const LEGACY_DIRECTOR_TOOL_SURFACE: DirectorToolSurface = 'director.v1'
export const CURRENT_DIRECTOR_TOOL_SURFACE: DirectorToolSurface = 'director.v11'

/** The surface a director session's conversation holds: the one its config names, else v1 (a director session opened
 *  before surfaces existed keeps exactly the list it was given). */
export function directorToolSurfaceOf(config: Record<string, unknown> | null | undefined): DirectorToolSurface {
  const named = config?.tool_surface
  return typeof named === 'string' && (DIRECTOR_TOOL_SURFACES as readonly string[]).includes(named) ? (named as DirectorToolSurface) : LEGACY_DIRECTOR_TOOL_SURFACE
}

/** The agent tool surfaces (a conversation records the one its first run had; v25 adds no agent tool). */
export const AGENT_TOOL_SURFACES = ['agent.v1'] as const
export const AgentToolSurfaceSchema = z.enum(AGENT_TOOL_SURFACES)
export type AgentToolSurface = z.infer<typeof AgentToolSurfaceSchema>
export const CURRENT_AGENT_TOOL_SURFACE: AgentToolSurface = 'agent.v1'

/** The schema version that adds the collaboration tables (participants, conversations, collab_edges) and the runs'
 *  participant / conversation / origin / placement columns. SCHEMA_VERSION moves to it with the migration. */
export const COLLAB_SCHEMA_VERSION = 25
