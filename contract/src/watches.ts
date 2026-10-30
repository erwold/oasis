/** A watch: what an agent of the session's own conversation asked to be woken for — a time, a command that ends, a
 *  line of its output, a number its output reports crossing a line, its output falling silent — and the events that
 *  fired (schema v18). The harness checks the condition; nothing asks a model until one fires. */

import { z } from 'zod'

export const WATCH_KINDS = ['timer', 'exit', 'match', 'metric', 'silence'] as const
export type WatchKind = (typeof WATCH_KINDS)[number]

export const METRIC_OPS = ['>=', '<=', '>', '<', '==', '!=', 'nonfinite'] as const
export type MetricOp = (typeof METRIC_OPS)[number]

export const WATCH_STREAMS = ['stdout', 'stderr', 'both'] as const

/** What a watch looks for, as registered (checked at registration; the harness evaluates it). */
export const WatchSpecSchema = z.object({
  kind: z.enum(WATCH_KINDS),
  /** the command it watches (every kind but timer) */
  execution_id: z.string().nullable().default(null),
  /** timer: when it first fires (ISO time) */
  at: z.string().nullable().default(null),
  /** timer that repeats: how long between one firing and the next */
  every_s: z.number().nullable().default(null),
  /** match: a regular expression a line of the output matches; metric: one whose first group is the number */
  pattern: z.string().nullable().default(null),
  /** metric: the field the number is read from — a JSON line's key (dotted), or `name=value` / `name: value` */
  field: z.string().nullable().default(null),
  op: z.enum(METRIC_OPS).nullable().default(null),
  value: z.number().nullable().default(null),
  stream: z.enum(WATCH_STREAMS).default('both'),
  /** silence: how long without a line of output */
  silence_s: z.number().nullable().default(null),
})
export type WatchSpec = z.infer<typeof WatchSpecSchema>

export const WATCH_STATUSES = ['active', 'done', 'cancelled', 'expired'] as const
export type WatchStatus = (typeof WATCH_STATUSES)[number]

export const WatchSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  /** the run that registered it */
  run_id: z.string(),
  spec: WatchSpecSchema,
  /** what the agent asked to be reminded of when woken */
  note: z.string(),
  /** a line the page shows: what it waits for */
  summary: z.string(),
  status: z.enum(WATCH_STATUSES),
  /** fire again after firing (the condition must stop holding and hold again, the cooldown passed) */
  repeat: z.boolean(),
  cooldown_s: z.number().int(),
  max_fires: z.number().int(),
  fires: z.number().int(),
  last_fired_at: z.string().nullable(),
  expires_at: z.string(),
  /** why it ended, when it did */
  ended_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type Watch = z.infer<typeof WatchSchema>

export const WAKE_EVENT_KINDS = ['fired', 'ended', 'lost', 'expired'] as const
export const WAKE_EVENT_STATUSES = ['pending', 'delivered', 'dropped'] as const

/** One thing a watch saw: its condition fired, the command it watched ended before it did, the command was lost to a
 *  restart, or the watch expired. Delivered to the session's conversation as a run the harness starts. */
export const WakeEventSchema = z.object({
  id: z.string(),
  watch_id: z.string(),
  session_id: z.string(),
  kind: z.enum(WAKE_EVENT_KINDS),
  /** what was seen, in words the agent reads */
  detail: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(WAKE_EVENT_STATUSES),
  /** the run it was delivered in */
  run_id: z.string().nullable(),
  created_at: z.string(),
  delivered_at: z.string().nullable(),
})
export type WakeEvent = z.infer<typeof WakeEventSchema>
