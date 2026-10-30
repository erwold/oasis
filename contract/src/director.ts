/** The director session (schema v8): the harness holds the main conversation with a director outside its own
 *  agents — a model route it runs itself, the ChatGPT web app through a browser bridge, or an OpenAI Workspace
 *  Agent — and continues that conversation itself when the person writes and when the runs the director dispatched
 *  finish. A TURN is one message to the director and its answer; the OUTBOX holds the task events (a run finished)
 *  that wait to be delivered as the next turn, persisted so a restart loses none and a retry repeats none. */

import { z } from 'zod'
import { BudgetSchema } from './models.ts'
import { DirectorToolSurfaceSchema } from './collab_core.ts'

const JsonRecord = z.record(z.string(), z.unknown())

/** native: a model route of this harness runs the director in process, with the director tools; bridge: the
 *  ChatGPT web app (a signed-in browser window the desktop shell holds, or any bridge speaking the same protocol)
 *  — the conversation is the person's own ChatGPT conversation, and the tools are the MCP connector. */
export const DIRECTOR_TRANSPORTS = ['native', 'bridge'] as const
export const DirectorTransportSchema = z.enum(DIRECTOR_TRANSPORTS)
export type DirectorTransport = z.infer<typeof DirectorTransportSchema>

/** idle: nothing queued, nothing running; generating: a turn is with the director (the model is answering, or the
 *  message was submitted and the answer has not come back); waiting_for_tasks: no turn, but runs the director
 *  started are still active — their end wakes it; needs_login: the bridge's browser is not signed in (the queued
 *  turn waits); paused: the person paused it (events queue up, nothing is sent); closed. */
export const DIRECTOR_STATES = ['idle', 'generating', 'waiting_for_tasks', 'needs_login', 'paused', 'closed'] as const
export const DirectorStateSchema = z.enum(DIRECTOR_STATES)
export type DirectorState = z.infer<typeof DirectorStateSchema>

/** user: the person's words; task_event: runs finished (the outbox); interaction: the harness asks for a plan, or what
 *  comes next, for an interaction of the session (the turn's input names it). */
export const DIRECTOR_TURN_KINDS = ['user', 'task_event', 'interaction'] as const
export const DirectorTurnKindSchema = z.enum(DIRECTOR_TURN_KINDS)
export type DirectorTurnKind = z.infer<typeof DirectorTurnKindSchema>

/** queued: waits its turn; generating: with the director now; awaiting_answer: submitted to the ChatGPT page, the
 *  answer comes back later (the bridge's poll); done; error; cancelled. */
export const DIRECTOR_TURN_STATUSES = ['queued', 'generating', 'awaiting_answer', 'done', 'error', 'cancelled'] as const
export const DirectorTurnStatusSchema = z.enum(DIRECTOR_TURN_STATUSES)
export type DirectorTurnStatus = z.infer<typeof DirectorTurnStatusSchema>
export const ACTIVE_DIRECTOR_TURN_STATUSES: readonly DirectorTurnStatus[] = ['generating', 'awaiting_answer']

export const DIRECTOR_EVENT_STATUSES = ['pending', 'delivering', 'delivered', 'failed', 'dropped'] as const
export const DirectorEventStatusSchema = z.enum(DIRECTOR_EVENT_STATUSES)
export type DirectorEventStatus = z.infer<typeof DirectorEventStatusSchema>

export const DirectorSessionSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  transport: DirectorTransportSchema,
  /** native: the route id; the others: what the transport reports (a label) */
  model: z.string().default(''),
  /** what the notes say the director is (e.g. "GPT-6 Pro", "ChatGPT") */
  label: z.string().default(''),
  state: DirectorStateSchema,
  config: JsonRecord.default({}),
  /** the external conversation: a ChatGPT conversation URL, a Workspace Agent conversation key */
  external_ref: z.string().nullable().default(null),
  current_turn_id: z.string().nullable().default(null),
  last_error: z.string().nullable().default(null),
  /** how many turns the director's own conversation record holds (native: the messages kept between turns) */
  history_turns: z.number().int().default(0),
  /** schema v25: the tool surface this director's conversation holds for every request (config.tool_surface; a session
   *  opened before surfaces existed holds director.v1) — absent from an older backend */
  tool_surface: DirectorToolSurfaceSchema.optional(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable().default(null),
})
export type DirectorSession = z.infer<typeof DirectorSessionSchema>

export const DirectorToolCallSchema = z.object({
  tool_call_id: z.string().nullable().optional(),
  name: z.string(), summary: z.string().default(''), status: z.string().default('ok'),
  /** the arguments the director passed, so the person can see what it asked for (null when too large to keep) */
  args: z.record(z.string(), z.unknown()).nullable().default(null),
  /** what came back, as the director read it: a refusal's or an error's reason in full, else a line about the result */
  outcome: z.string().default(''),
})
export type DirectorToolCall = z.infer<typeof DirectorToolCallSchema>

/** The original user message; tool dispatch uses this record, not a model's paraphrase. */
export const DirectorSayBodySchema = z.object({
  text: z.string(),
  model: z.string().nullable().optional(),
  thinking: z.string().nullable().optional(),
  attachments: z.array(z.string()).max(8).default([]),
  mentions: z.array(z.record(z.string(), z.unknown())).default([]),
  budget: BudgetSchema.nullable().optional(),
  fresh: z.boolean().default(false),
  resumes_run_id: z.string().nullable().optional(),
  participant_thinking: z.record(z.string(), z.string()).default({}),
  client_request_id: z.string().min(8).max(100).nullable().optional(),
})
export type DirectorSayBody = z.infer<typeof DirectorSayBodySchema>

export const DirectorTurnSchema = z.object({
  envelope: DirectorSayBodySchema.nullable().default(null),
  dispatched_interaction_ids: z.array(z.string()).default([]),
  id: z.string(),
  director_session_id: z.string(),
  session_id: z.string(),
  seq: z.number().int(),
  kind: DirectorTurnKindSchema,
  /** what went to the director: the person's words, or the task-event message */
  input: z.string(),
  /** the director's answer */
  output: z.string().default(''),
  status: DirectorTurnStatusSchema,
  model: z.string().default(''),
  usage: z.record(z.string(), z.number()).default({}),
  tool_calls: z.array(DirectorToolCallSchema).default([]),
  /** the outbox events this turn delivered (a task-event turn) */
  event_ids: z.array(z.string()).default([]),
  /** the runs the director started in this turn (a tool call that returned a run) */
  dispatched_run_ids: z.array(z.string()).default([]),
  /** the director note written when the turn ended (what the thread shows) */
  note_id: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  /** the provider's response id, the bridge's message id, the workspace agent's run id */
  external_ref: z.string().nullable().default(null),
  created_at: z.string(),
  started_at: z.string().nullable().default(null),
  finished_at: z.string().nullable().default(null),
})
export type DirectorTurn = z.infer<typeof DirectorTurnSchema>

export const DirectorOutboxEventSchema = z.object({
  id: z.string(),
  director_session_id: z.string(),
  session_id: z.string(),
  seq: z.number().int(),
  /** run_finished (the kinds are open: a new one is a new payload, never a new column) */
  kind: z.string(),
  /** the run / interaction the event is about */
  ref_id: z.string(),
  dedupe_key: z.string(),
  /** the director turn whose tool call started the run; null when the person or another client did */
  cause_turn_id: z.string().nullable().default(null),
  payload: JsonRecord.default({}),
  status: DirectorEventStatusSchema,
  attempts: z.number().int().default(0),
  delivered_turn_id: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  created_at: z.string(),
  delivered_at: z.string().nullable().default(null),
})
export type DirectorOutboxEvent = z.infer<typeof DirectorOutboxEventSchema>

// ---- bodies ------------------------------------------------------------------------------------------------------

/** Per transport, `config` holds:
 *  - native: thinking (off | minimal | … | xhigh | null), reasoning_mode ('pro' | null; an OpenAI API Responses route
 *    only), allow_destructive (may it cancel runs itself; default false), max_requests_per_turn,
 *    max_tool_calls_per_turn (its own conversation is kept whole between turns and compacted only near the
 *    route's context window, like a run's)
 *  - bridge: bridge_url (the bridge's base URL), bridge_token, mention (the connector as ChatGPT copies it),
 *    chatgpt_model (a ChatGPT model slug), poll_interval_s (default 1), poll_timeout_s (default 1800),
 *    new_conversation (default true: the first turn opens a new ChatGPT conversation) */
export const DirectorOpenBodySchema = z.object({
  transport: DirectorTransportSchema,
  model: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  config: JsonRecord.default({}),
})
export type DirectorOpenBody = z.infer<typeof DirectorOpenBodySchema>

export const DirectorUpdateBodySchema = z.object({
  paused: z.boolean().nullable().optional(),
  model: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  /** merged over the current config; a null value removes a key */
  config: JsonRecord.nullable().optional(),
})
export type DirectorUpdateBody = z.infer<typeof DirectorUpdateBodySchema>


/** The answer of a turn that waits for one (a bridge turn, a workspace agent's, or any transport's when the
 *  director speaks through the MCP connector): the text, the model as the director's client shows it, where it
 *  came from. */
// ---- responses -----------------------------------------------------------------------------------------------------

export const DirectorTransportInfoSchema = z.object({
  id: DirectorTransportSchema,
  label: z.string(),
  ready: z.boolean(),
  hint: z.string().nullable(),
})
export type DirectorTransportInfo = z.infer<typeof DirectorTransportInfoSchema>

/** A turn as it streams: the text so far and the tool calls so far (a turn that is not live has none). */
export const DirectorLiveTurnSchema = z.object({
  turn_id: z.string(),
  text: z.string(),
  /** the director's reasoning as it forms (the ChatGPT page's thoughts, heard by the bridge); not kept once the turn ends */
  thinking: z.string().default(''),
  tool_calls: z.array(DirectorToolCallSchema),
})
export type DirectorLiveTurn = z.infer<typeof DirectorLiveTurnSchema>

export const DirectorDetailSchema = z.object({
  session_id: z.string(),
  director: DirectorSessionSchema.nullable(),
  turns: z.array(DirectorTurnSchema),
  pending_events: z.array(DirectorOutboxEventSchema),
  live: DirectorLiveTurnSchema.nullable(),
  transports: z.array(DirectorTransportInfoSchema),
})
export type DirectorDetail = z.infer<typeof DirectorDetailSchema>

/** The events of a turn's stream (SSE): turn_started {kind, input}, text_delta {text}, tool_call {name, summary},
 *  tool_result {name, status, summary}, note {text}, turn_finished {status, output, error, note_id}. */
export const DIRECTOR_TURN_EVENTS = ['turn_started', 'text_delta', 'tool_call', 'tool_result', 'note', 'turn_finished'] as const
