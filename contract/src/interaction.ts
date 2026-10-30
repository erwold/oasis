/** The interaction: one message of the person to several agents, run as a graph of nodes the harness schedules —
 *  each node one run of one participant, started when the nodes it depends on have ended, handed the answers of
 *  the nodes it receives (and nothing of the others), on the session's working folder, on a copy of its own from
 *  the interaction's common starting point, or on another node's copy. Who works when and who reads whom is the
 *  plan: the director's (it reads the person's request and calls `schedule`), or a fixed template's (independent:
 *  every participant once, alone). The plan is data the harness executes; the director is asked again only where
 *  the plan says so (`then: director`), never after every run. The person stops, continues and adopts; a relation
 *  between participants is the person's words, never a role the harness assigns. */

import { z } from 'zod'
import { PARTICIPANT_ID } from './mentions.ts'
import { BudgetSchema, AttachmentSchema, MAX_DIRECTED_TITLE } from './models.ts'
import { CitationsSchema, MAX_CITATIONS, MAX_RECEIVED_RUNS, RunIdSchema } from './collab_core.ts'

export const MAX_INTERACTION_PARTICIPANTS = 6
/** How many runs one interaction may start in all, whatever its budget says (reruns after a decision count). */
export const MAX_INTERACTION_RUNS = 30
/** How many of its runs may be under way at once, at most. */
export const MAX_INTERACTION_CONCURRENCY = 4
export const DEFAULT_INTERACTION_CONCURRENCY = 2
/** How many nodes one schedule call may add. */
export const MAX_SCHEDULE_NODES = 12
export const MAX_NODE_INSTRUCTION_CHARS = 2000

/** planning: the director is asked for a plan (no node yet); running: nodes queued or under way; waiting: the
 *  person's word is needed (a node's run ended waiting for a decision, a node failed, the director planned nothing);
 *  deciding: every node ended and the director is asked what comes next; interrupted: a restart; done; cancelled;
 *  error (the budget, or a node the chain cannot go on without). */
export const INTERACTION_STATUSES = ['planning', 'running', 'waiting', 'deciding', 'interrupted', 'done', 'cancelled', 'error'] as const
export const InteractionStatusSchema = z.enum(INTERACTION_STATUSES)
export type InteractionStatus = z.infer<typeof InteractionStatusSchema>
/** An interaction whose runs the harness may still start on its own, or whose director it waits on. */
export const ACTIVE_INTERACTION_STATUSES: readonly InteractionStatus[] = ['planning', 'running', 'deciding']
/** An interaction the person can continue: waiting (decide, then go on), interrupted (a restart). */
export const CONTINUABLE_INTERACTION_STATUSES: readonly InteractionStatus[] = ['waiting', 'interrupted']

export const NODE_STATUSES = ['queued', 'running', 'watching', 'waiting', 'done', 'cancelled', 'error'] as const
export const NodeStatusSchema = z.enum(NODE_STATUSES)
export type NodeStatus = z.infer<typeof NodeStatusSchema>

/** Who plans: the director (a model with the schedule tool), or a fixed template the harness expands itself. */
export const InteractionControllerSchema = z.enum(['director', 'fixed'])
export type InteractionController = z.infer<typeof InteractionControllerSchema>

/** What follows the last node: stop (the person decides), or director (the director is asked what comes next). */
export const InteractionThenSchema = z.enum(['stop', 'director'])
export type InteractionThen = z.infer<typeof InteractionThenSchema>

export const InteractionParticipantSchema = z.object({
  /** the alias the turns name the participant by — A, B, … — unique in the interaction whatever the labels */
  id: z.string().regex(PARTICIPANT_ID),
  label: z.string(),
  /** the model route's id (what a run pins) */
  model: z.string(),
  /** its own thinking effort, when the person chose one for it; else the interaction's */
  thinking: z.string().nullable().optional(),
})
export type InteractionParticipant = z.infer<typeof InteractionParticipantSchema>

/** A node's id: the plan's own short name (`a1`, `review`). */
export const NodeIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,23}$/, 'a node id is 1–24 characters: a lowercase letter, then letters, digits, _ or -')

/** Where a node works: `own` — the participant's own copy of the files from the interaction's starting point (made
 *  at its first node, continued at its later ones); `shared` — the session's working folder (nodes on it run one at
 *  a time, and the participant continues the session's conversation); a node id — that node's copy, after it. */
export const NodeWorkspaceSchema = z.union([z.literal('own'), z.literal('shared'), NodeIdSchema])
export type NodeWorkspace = z.infer<typeof NodeWorkspaceSchema>

export const InteractionNodeSchema = z.object({
  id: NodeIdSchema,
  interaction_id: z.string(),
  seq: z.number().int(),
  participant: z.string(),
  /** the director's words for this step (what the person's request means here), or none */
  instruction: z.string().nullable().default(null),
  /** the nodes that must have ended before this one starts */
  depends_on: z.array(NodeIdSchema).default([]),
  /** the nodes (of depends_on) whose answers this node is handed as packets; none: it works without seeing the others */
  receives: z.array(NodeIdSchema).default([]),
  workspace: NodeWorkspaceSchema.default('own'),
  status: NodeStatusSchema,
  run_id: z.string().nullable().default(null),
  /** every run of this node (a node run again after a decision or a restart keeps its earlier ones; the last is current) */
  run_ids: z.array(z.string()).default([]),
  /** the workspace the node's runs work on, once known */
  workspace_id: z.string().nullable().default(null),
  /** the schedule call (the interaction's revision) that added the node */
  revision: z.number().int().default(1),
  /** the wave the node starts in: 1 for a node that depends on nothing, else one past the latest wave it depends on
   *  (nodes of one wave start together, within the concurrency); read off the graph by the harness */
  wave: z.number().int().default(1),
  created_at: z.string(),
  updated_at: z.string(),
  // schema v25 (absent from an older backend; an older row reads plan, no message, none named):
  /** plan: a step of the plan; followup: a participant's follow-up the person or a director asked for (its run
   *  continues the participant's conversation; the scheduler starts nothing else for it) */
  kind: z.enum(['plan', 'followup']).optional(),
  /** a follow-up's message: the words as sent (they open its run as the sender's own), who sent them */
  message: z.object({ text: z.string(), by: z.enum(['person', 'director', 'connector']), director_turn_id: z.string().nullable().default(null) }).nullable().optional(),
  /** the runs of the session the step's instruction cites (nothing of them handed over), and the runs whose answers it
   *  is handed beside its receives — exact run ids, fixed when the step was added */
  cites: z.array(RunIdSchema).optional(),
  receive_runs: z.array(RunIdSchema).optional(),
})
export type InteractionNode = z.infer<typeof InteractionNodeSchema>

export const InteractionBudgetSchema = z.object({
  max_runs: z.number().int().min(1).max(MAX_INTERACTION_RUNS),
  concurrency: z.number().int().min(1).max(MAX_INTERACTION_CONCURRENCY),
})
export type InteractionBudget = z.infer<typeof InteractionBudgetSchema>

export const InteractionWorkspacePolicySchema = z.enum(['legacy', 'isolated'])
export const InteractionSchema = z.object({
  workspace_policy: InteractionWorkspacePolicySchema.default('legacy'),
  source_turn_id: z.string().nullable().default(null),
  id: z.string(),
  session_id: z.string(),
  status: InteractionStatusSchema,
  /** the person's message, as written (its agent mentions as tokens) */
  user_text: z.string(),
  participants: z.array(InteractionParticipantSchema),
  controller: InteractionControllerSchema,
  /** the fixed template that made the plan (`independent`), null for a director's plan */
  template: z.string().nullable().default(null),
  then: InteractionThenSchema.default('stop'),
  /** how many schedule calls the plan has had (0 while planning) */
  revision: z.number().int().default(0),
  budget: InteractionBudgetSchema,
  /** runs started in all, counted against budget.max_runs */
  runs_started: z.number().int().default(0),
  /** the common starting point of every `own` copy: the session workspace pinned when the interaction started */
  base_checkpoint_id: z.string().nullable().default(null),
  /** a shared node's conversation: a new one (fresh), the run named, else the session's latest at the start */
  fresh: z.boolean().default(false),
  resumes_run_id: z.string().nullable().default(null),
  director_session_id: z.string().nullable().default(null),
  /** the director turn the interaction waits on (its planning turn, a decision turn), while it does */
  director_turn_id: z.string().nullable().default(null),
  /** why the interaction is waiting, interrupted, cancelled or in error — for the person */
  reason: z.string().nullable().default(null),
  /** the images the person attached to the message (every participant's first run reads them) */
  attachments: z.array(AttachmentSchema).default([]),
  client_request_id: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
  finished_at: z.string().nullable().default(null),
})
export type Interaction = z.infer<typeof InteractionSchema>

/** One thing that happened to the interaction, appended in order: created, planned (a revision), node_started,
 *  node_finished, decision_asked, decided, stopped, continued, adopted. */
export const InteractionEventSchema = z.object({
  seq: z.number().int(),
  kind: z.string(),
  /** person | director | harness */
  actor: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string(),
})
export type InteractionEvent = z.infer<typeof InteractionEventSchema>

/** A note the person wrote while the interaction ran, to everyone or to one participant: queued, and handed to each
 *  addressee at its next run's start (never into a request in flight); delivered once every addressee had it,
 *  partly while some had, undelivered when the interaction ended first. */
export const INTERACTION_NOTE_STATUSES = ['queued', 'partly', 'delivered', 'undelivered'] as const
export const InteractionNoteSchema = z.object({
  id: z.string(),
  interaction_id: z.string(),
  /** everyone, or a participant's letter */
  to: z.string(),
  text: z.string(),
  status: z.enum(INTERACTION_NOTE_STATUSES),
  /** the run each addressee was handed the note in, by letter */
  delivered: z.record(z.string(), z.string()).default({}),
  created_at: z.string(),
  updated_at: z.string(),
})
export type InteractionNote = z.infer<typeof InteractionNoteSchema>

export const InteractionDetailSchema = InteractionSchema.extend({
  nodes: z.array(InteractionNodeSchema),
  events: z.array(InteractionEventSchema).default([]),
  notes: z.array(InteractionNoteSchema).default([]),
  /** a run of the interaction is under way in this process */
  live: z.boolean().default(false),
  /** the session edits its folder in place (a direct project's): every step works in that one folder, own included */
  in_place: z.boolean().default(false),
  /** the git repositories inside the session's workspace its starting point (base checkpoint) left out: the steps'
   *  copies do not contain them (workspace-relative paths; empty when none or no copy is made) */
  base_excluded_nested_repositories: z.array(z.string()).optional(),
})
export type InteractionDetail = z.infer<typeof InteractionDetailSchema>

// ---- bodies ------------------------------------------------------------------------------------------------------

/** A node as a plan names it (the director's schedule call, or a body's fixed plan). Frozen: it is the director.v1
 *  schedule tool's node schema (a tool list a conversation already holds never changes); v25 additions are on
 *  ScheduleNodeV2Schema. */
export const ScheduleNodeSchema = z.object({
  id: NodeIdSchema,
  participant: z.string().regex(PARTICIPANT_ID, "a participant is named by its id, exactly as the app lists it"),
  instruction: z.string().max(MAX_NODE_INSTRUCTION_CHARS).nullable().optional(),
  depends_on: z.array(NodeIdSchema).max(MAX_SCHEDULE_NODES).default([]),
  receives: z.array(NodeIdSchema).max(MAX_SCHEDULE_NODES).default([]),
  workspace: NodeWorkspaceSchema.default('own'),
})
export type ScheduleNode = z.infer<typeof ScheduleNodeSchema>

/** A node with what schema v25 adds (the HTTP bodies, the director.v2 tools): `cites` — runs of the session the step's
 *  instruction refers to, recorded as cited edges and named to the participant without their content; `receive_runs`
 *  — runs of the session (outside the plan too) whose final answers the step is handed whole, like `receives` but by
 *  exact run. Both name ended runs, fixed when the step is added. A pre-v25 backend does not read them. */
export const ScheduleNodeV2Schema = ScheduleNodeSchema.extend({
  cites: z.array(RunIdSchema).max(MAX_CITATIONS).optional(),
  receive_runs: z.array(RunIdSchema).max(MAX_RECEIVED_RUNS).optional(),
})
export type ScheduleNodeV2 = z.infer<typeof ScheduleNodeV2Schema>

/** POST /api/interactions/:id/schedule — the director's plan, or more of it: nodes added to the graph (a node may
 *  depend on one already there), and what follows the last. `expected_revision` refuses a plan made against a graph
 *  that changed meanwhile. */
export const ScheduleBodySchema = z.object({
  /** a few words naming what the user asked: the session's title while the person has not named it (the first plan) */
  title: z.string().trim().min(1).max(MAX_DIRECTED_TITLE).optional(),
  nodes: z.array(ScheduleNodeV2Schema).min(1).max(MAX_SCHEDULE_NODES),
  then: InteractionThenSchema.default('stop'),
  expected_revision: z.number().int().nullable().optional(),
})
export type ScheduleBody = z.infer<typeof ScheduleBodySchema>

/** The fixed templates the harness expands itself, no director asked: independent — every participant once, alone
 *  on its own copy, nothing handed on, the person decides after. */
export const INTERACTION_TEMPLATES = ['independent', 'discussion'] as const
export const InteractionTemplateSchema = z.enum(INTERACTION_TEMPLATES)
export type InteractionTemplate = z.infer<typeof InteractionTemplateSchema>

/** POST /api/sessions/:id/interactions. The participants are the message's own (`participantsOf(text)`); a client
 *  whose text carries no tokens names them here instead. `plan`: a template, a fixed graph, or none — the director
 *  is asked then (an open director session of the session, else a native one opened on `director_model`). */
export const InteractionBodySchema = z.object({
  workspace_policy: InteractionWorkspacePolicySchema.default('legacy'),
  source_turn_id: z.string().nullable().optional(),
  text: z.string(),
  participants: z.array(z.object({ model: z.string().min(1), label: z.string().nullable().optional(), id: z.string().regex(PARTICIPANT_ID).nullable().optional(), thinking: z.string().nullable().optional() })).max(MAX_INTERACTION_PARTICIPANTS).default([]),
  plan: z.union([
    z.object({ template: InteractionTemplateSchema, cross_rounds: z.number().int().min(1).max(4).default(1) }),
    z.object({ nodes: z.array(ScheduleNodeV2Schema).min(1).max(MAX_SCHEDULE_NODES), then: InteractionThenSchema.default('stop') }),
  ]).nullable().optional(),
  director_model: z.string().nullable().optional(),
  thinking: z.string().nullable().optional(),
  // a participant's own thinking effort, by its id in the message (`pt_3f2a9c`: the @ menu's choice for its model);
  // a participant without one runs at `thinking`
  participant_thinking: z.record(z.string(), z.string()).default({}),
  /** the limits every run of the interaction runs under */
  budget: BudgetSchema.nullable().optional(),
  max_runs: z.number().int().min(1).max(MAX_INTERACTION_RUNS).nullable().optional(),
  concurrency: z.number().int().min(1).max(MAX_INTERACTION_CONCURRENCY).nullable().optional(),
  mentions: z.array(z.record(z.string(), z.unknown())).default([]),
  attachments: z.array(z.string()).max(8).default([]),
  fresh: z.boolean().default(false),
  resumes_run_id: z.string().nullable().optional(),
  client_request_id: z.string().min(8).max(100).nullable().optional(),
  /** schema v25: runs of the session the request refers to, recorded as cited edges on the interaction's first steps */
  cites: CitationsSchema.optional(),
})
export type InteractionBody = z.infer<typeof InteractionBodySchema>

/** POST /api/interactions/:id/continue: a waiting interaction goes on (a node whose decision was made runs again; a
 *  failed node is run again; a director that planned nothing is asked again), an interrupted one likewise. */
export const InteractionContinueBodySchema = z.object({})

/** POST /api/interactions/:id/notes: words for everyone, or for one participant, while the interaction runs. */
export const InteractionNoteBodySchema = z.object({
  attachments: z.array(z.never()).max(0, 'participant notes take words only').optional(),
  to: z.string().refine((v) => v === 'everyone' || PARTICIPANT_ID.test(v), 'to is everyone, or a participant\'s id'),
  text: z.string().min(1).max(20_000),
})
export type InteractionNoteBody = z.infer<typeof InteractionNoteBodySchema>

/** POST /api/interactions/:id/adopt: the final state of a node's own copy composed into the session's working folder
 *  (the integration: composed, checked, written only when the folder still stands at the base). */
export const AdoptBodySchema = z.object({ node_id: NodeIdSchema })
export type AdoptBody = z.infer<typeof AdoptBodySchema>
