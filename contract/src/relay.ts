/** The relay: one message of the person addressed to several agents, who take turns on it in the order named, each
 *  reading the earlier turns of the same conversation. What they do with the turn is the person's message, not a
 *  role the harness assigns; a round is every agent once, and the person chooses the rounds or continues. The
 *  harness schedules the turns (a turn starts only after the earlier one has ended and its record is written),
 *  persists the chain's state here, and never starts a turn on its own after a stop, a failure, a restart or a turn
 *  that ended waiting for the person's approval. */

import { z } from 'zod'

/** How many rounds a relay may run in all (a round: every participant once, in order). */
export const MAX_RELAY_ROUNDS = 5
export const MAX_RELAY_PARTICIPANTS = 6

export const RELAY_STATUSES = ['running', 'waiting', 'interrupted', 'done', 'cancelled', 'error'] as const
export const RelayStatusSchema = z.enum(RELAY_STATUSES)
export type RelayStatus = z.infer<typeof RelayStatusSchema>
/** A relay whose next turn the harness may still start on its own. */
export const ACTIVE_RELAY_STATUSES: readonly RelayStatus[] = ['running']
/** A relay the person can continue: waiting (the turn's approval was decided), interrupted (a restart), done (one more round). */
export const CONTINUABLE_RELAY_STATUSES: readonly RelayStatus[] = ['waiting', 'interrupted', 'done']

/** An earlier record's role (executor / reviewer): kept readable; no new relay assigns one. */
export const RelayRoleSchema = z.enum(['executor', 'reviewer'])
export type RelayRole = z.infer<typeof RelayRoleSchema>

export const RelayParticipantSchema = z.object({
  /** the model route's id (what a run pins) */
  model: z.string(),
  label: z.string(),
  /** the short id the turns name the participant by — A, B, … — unique in the relay whatever the labels */
  id: z.string().default(''),
  role: RelayRoleSchema.optional(),
  /** its own thinking effort, when the person chose one for it; else the relay's */
  thinking: z.string().nullable().optional(),
})
export type RelayParticipant = z.infer<typeof RelayParticipantSchema>

export const RELAY_STEP_STATUSES = ['queued', 'running', 'waiting', 'done', 'cancelled', 'error'] as const
export const RelayStepStatusSchema = z.enum(RELAY_STEP_STATUSES)
export type RelayStepStatus = z.infer<typeof RelayStepStatusSchema>

/** One turn of the chain: which participant, in which round, and the run(s) that carried it (a turn re-run after
 *  the person's decision or a restart keeps its earlier run ids; the last is the current one). */
export const RelayStepSchema = z.object({
  seq: z.number().int(),
  round: z.number().int(),
  participant: z.number().int(),
  status: RelayStepStatusSchema,
  run_id: z.string().nullable(),
  run_ids: z.array(z.string()).default([]),
})
export type RelayStep = z.infer<typeof RelayStepSchema>

export const RelaySchema = z.object({
  id: z.string(),
  session_id: z.string(),
  status: RelayStatusSchema,
  /** the person's message, as written (its agent mentions as tokens) */
  user_text: z.string(),
  participants: z.array(RelayParticipantSchema),
  steps: z.array(RelayStepSchema),
  /** rounds planned in all, and the round under way (1-based) */
  rounds: z.number().int(),
  round: z.number().int(),
  /** the step under way, or the next to start (an index into steps) */
  current_step: z.number().int(),
  /** why the relay is waiting, interrupted, cancelled or in error — for the person */
  reason: z.string().nullable().default(null),
  client_request_id: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
  finished_at: z.string().nullable().default(null),
})
export type Relay = z.infer<typeof RelaySchema>

/** The body of POST /api/relays/:id/continue: a finished relay gets more rounds (one by default); a waiting or an
 *  interrupted one is resumed as it stands. */
export const RelayContinueBodySchema = z.object({
  rounds: z.number().int().min(1).max(MAX_RELAY_ROUNDS).nullable().optional(),
})
export type RelayContinueBody = z.infer<typeof RelayContinueBodySchema>
