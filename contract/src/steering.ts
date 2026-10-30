/** In-run steering: the person's words sent to a run that is still working, handed to the agent at the run's next
 *  model request (never by cancelling a request or a tool already under way). The record of each message is derived
 *  from the run's persisted events (`steer_queued`, then `steer_delivered` or `steer_undelivered`, data `{ steer }`),
 *  which are also its FIFO: queued_seq orders them. docs/in-run-steering-design.md is the design record. */

import { z } from 'zod'

/** queued: saved, waiting for the run's next request boundary; delivered: written, word for word, into the request
 *  the run committed at a request boundary (the conversation record holds it from then on — this does not say the
 *  provider answered or the model read it); undelivered: the run ended (or could not fit it) before that boundary,
 *  the words never entered the conversation. */
export const STEER_STATUSES = ['queued', 'delivered', 'undelivered'] as const
export const SteerStatusSchema = z.enum(STEER_STATUSES)
export type SteerStatus = z.infer<typeof SteerStatusSchema>

/** Why a message was not delivered: the person stopped the run, the run failed, it reached its budget, the app
 *  stopped (or crashed) under it, or the words alone could not fit the model's window at the boundary. */
export const STEER_UNDELIVERED_REASONS = ['stopped', 'failed', 'budget', 'interrupted', 'context'] as const
export const SteerUndeliveredReasonSchema = z.enum(STEER_UNDELIVERED_REASONS)
export type SteerUndeliveredReason = z.infer<typeof SteerUndeliveredReasonSchema>

/** Who sent the words: the person (the thread's composer), a director (a native director's call), or the connector's
 *  client (ChatGPT through the connector). An older record names none: the person's. */
export const STEER_SOURCES = ['person', 'director', 'connector'] as const
export const SteerSourceSchema = z.enum(STEER_SOURCES)
export type SteerSource = z.infer<typeof SteerSourceSchema>

export const SteerRecordSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  session_id: z.string(),
  /** the person's words exactly as sent: never trimmed, rewritten or summarized */
  text: z.string(),
  client_request_id: z.string(),
  status: SteerStatusSchema,
  queued_at: z.string(),
  /** the seq of its steer_queued event: the FIFO order */
  queued_seq: z.number().int(),
  delivered_at: z.string().nullable(),
  /** the seq of its steer_delivered event: where it stands among the run's events (after the tool results it followed) */
  delivered_seq: z.number().int().nullable(),
  /** which of the run's model requests (1-based, summaries counted) carried it */
  request_index: z.number().int().nullable(),
  reason: SteerUndeliveredReasonSchema.nullable(),
  by: SteerSourceSchema.optional(),
  /** the connector's client the words came through (`ChatGPT`, or another MCP client's name), as the harness read it
   *  from the request itself (`Origin.client`) — never from the body; absent for the person's own page and on a
   *  record from before it was kept (a reader names that one neutrally, never as a client it cannot know) */
  client: z.string().optional(),
})
export type SteerRecord = z.infer<typeof SteerRecordSchema>

/** POST /api/runs/:run_id/steer — strict: any other field (attachments, mentions) is refused. */
export const SteerBodySchema = z.object({
  text: z.string().min(1).max(20_000),
  client_request_id: z.string().min(8).max(100),
}).strict()
export type SteerBody = z.infer<typeof SteerBodySchema>

export const SteerResponseSchema = z.object({ run_id: z.string(), steer: SteerRecordSchema })
export type SteerResponse = z.infer<typeof SteerResponseSchema>

/** GET /api/runs/:run_id/steers — by queued_seq. */
export const SteerListSchema = z.object({ steers: z.array(SteerRecordSchema) })
export type SteerList = z.infer<typeof SteerListSchema>

/** The `code` beside `detail` of a refused steer. 400: empty_text (no visible words), steer_agents (structured agent
 *  or tool mentions: a steer is plain text), invalid_input (any other field, a malformed body); 409: run_not_live (the
 *  run ended or is not this process's), not_steerable (a run that takes no words while it works: a UI task, ChatGPT
 *  on the web), run_finishing (its intake closed: its final answer
 *  was decided, its budget closing, a Stop, its end being written), key_conflict (the key was used with other words). */
export const STEER_REFUSALS = ['empty_text', 'steer_agents', 'invalid_input', 'run_not_live', 'not_steerable', 'run_finishing', 'key_conflict'] as const
export type SteerRefusal = (typeof STEER_REFUSALS)[number]
export const SteerErrorSchema = z.object({ detail: z.string(), code: z.enum(STEER_REFUSALS) })
export type SteerError = z.infer<typeof SteerErrorSchema>

/** The three persisted run events of a steer; data is `{ steer: SteerRecord }` as it stands after the event. */
export const STEER_EVENTS = ['steer_queued', 'steer_delivered', 'steer_undelivered'] as const

/** The records a run's events hold, by queued_seq: each record is the latest one its events carried. */
export function steersFromEvents(events: readonly { seq: number; event: string; data: Record<string, unknown> }[]): SteerRecord[] {
  const byId = new Map<string, SteerRecord>()
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!(STEER_EVENTS as readonly string[]).includes(e.event)) continue
    const parsed = SteerRecordSchema.safeParse(e.data.steer)
    if (parsed.success) byId.set(parsed.data.id, parsed.data)
  }
  return [...byId.values()].sort((a, b) => a.queued_seq - b.queued_seq)
}
