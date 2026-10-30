/** In-run steering on the page: words the person sends while the session's own run works go into that same run's
 *  next model request (never a new run). This module is pure — the rows a steer word makes in its run's thread, which
 *  live run the composer may steer, what the composer says — so node --test exercises it without a browser.
 *
 *  The record is the harness's own: contract/src/steering.ts (SteerRecord, checked with SteerRecordSchema) — the page
 *  keeps no copy of its shape. */

import { CHATGPT_WEB_ID, mentionSegments, SteerRecordSchema, STEER_EVENTS, STEER_STATUSES, STEER_UNDELIVERED_REASONS, type SteerRecord, type SteerStatus, type SteerUndeliveredReason } from '@oasis-code/contract'
import type { ThreadEntry } from './thread.ts'

export { STEER_EVENTS, STEER_STATUSES, type SteerRecord, type SteerStatus }
export const STEER_REASONS = STEER_UNDELIVERED_REASONS
export type SteerReason = SteerUndeliveredReason

/** A steer record as the harness said it, checked against the contract's schema (an unreadable one is never shown as
 *  words). */
export function isSteerRecord(value: unknown): value is SteerRecord {
  return SteerRecordSchema.safeParse(value).success
}

/** queued is the only word a later one replaces; the first end (delivered or undelivered) stands. */
const settledRank = (status: SteerStatus): number => (status === 'queued' ? 0 : 1)

/** Whether `next` is a later word on the steer than `current` (none yet: it is). An older word (a queued record read
 *  again after its delivery, a stream replayed from its start) never moves a steer back. */
export function steerSupersedes(next: SteerRecord, current: SteerRecord | undefined): boolean {
  if (current === undefined) return true
  if (next.id !== current.id) return false
  return settledRank(next.status) > settledRank(current.status)
}

/** The steer's row in a run's rows, if any. */
export function steerRowAt(rows: ThreadEntry[], id: string): number {
  return rows.findIndex((e) => e.kind === 'user' && e.steer?.id === id)
}

const seqOf = (id: string | undefined): number | null => (id !== undefined && /^\d+$/.test(id) ? Number(id) : null)

/** Whether a word on a steer (`next`, from the run's stream when it has an event id — its persisted seq — or a snapshot
 *  when it has none: a send's answer, the run's list, a transcript) takes the steer's place from the row that stands
 *  (`current`, placed by `currentEvent`). A queued word never moves a steer (never back from an end); the end moves a
 *  queued one; a snapshot's end is only provisional — the stream's own word of an end places it where it happened
 *  (between the tool results before it and the model's next words), once; of two ends the stream said, the earlier
 *  persisted one stands. A repeat (the same seq) or an older word changes nothing. */
export function takesPlace(current: SteerRecord, currentEvent: string | undefined, next: SteerRecord, nextEvent: string | undefined): boolean {
  if (next.status === 'queued') return false
  if (current.status === 'queued') return true
  const placed = seqOf(currentEvent)
  const incoming = seqOf(nextEvent)
  if (incoming === null) return false
  if (placed === null) return true
  return incoming < placed
}

/** A run's rows after a steer word: one row per id. A new steer joins at the end (it stands at the run's tail while
 *  queued); a word that takes its place (takesPlace) moves the row to where that word came. */
export function applySteer(rows: ThreadEntry[], runId: string, steer: SteerRecord, eventId?: string): ThreadEntry[] {
  if (steer.run_id !== runId) return rows
  const at = steerRowAt(rows, steer.id)
  const row: ThreadEntry = { kind: 'user', runId, eventId, eventName: `steer_${steer.status}`, steer, text: steer.text }
  if (at < 0) return [...rows, row]
  const current = rows[at]!
  if (!takesPlace(current.steer!, current.eventId, steer, eventId)) return rows
  return [...rows.slice(0, at), ...rows.slice(at + 1), row]
}

/** A steer sent and not yet confirmed (its answer lost: a network failure, a page closed): the run and key its words
 *  went with. The same words again go to that run with that key — the harness answers with the record it took, even
 *  after the run ended — never as a new run; kept per session in the page's storage so a session switch or a reload
 *  never turns a retry into a duplicate. Released once the harness answered (a record, or a refusal) or the record
 *  came by another road (the run's stream, its list, its transcript). */
export interface PendingSteer { session_id: string; run_id: string; key: string; text: string }
export const PENDING_STEERS_KEY = 'oasis-code.pendingSteers'

/** Where the composer's words go when they are for the agent: the run an unconfirmed steer of the very same words went
 *  to (first: a retry is the same steer, live run or not), else the live run they may steer, else nowhere special
 *  (null: a new run as always). Words for the director or a participant's note keep their own road. */
export function steerRoute(f: { destination: 'agent' | 'director' | 'note'; draft: string; pending: PendingSteer | null | undefined; liveTarget: string | null }): { run_id: string; key: string | null } | null {
  if (f.destination !== 'agent') return null
  if (f.pending && f.pending.text === f.draft) return { run_id: f.pending.run_id, key: f.pending.key }
  if (f.liveTarget) return { run_id: f.liveTarget, key: null }
  return null
}

/** The harness answered and did not take the steer (a 4xx: refused, run ended, key spent): its route is released. A
 *  lost answer (no status) or a server failure (5xx) may have been taken: the route stays for the retry. */
export function steerNotTaken(error: unknown): boolean {
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined
  return typeof status === 'number' && status >= 400 && status < 500
}

type KeyStore = { getItem(key: string): string | null; setItem(key: string, value: string): void }
const isPending = (v: unknown): v is PendingSteer => !!v && typeof v === 'object' && ['session_id', 'run_id', 'key', 'text'].every((k) => typeof (v as Record<string, unknown>)[k] === 'string')

/** The unconfirmed steers kept in the page's storage, by session (unreadable storage: none). */
export function readPendingSteers(storage: KeyStore | null | undefined): Record<string, PendingSteer> {
  try {
    const raw = JSON.parse(storage?.getItem(PENDING_STEERS_KEY) ?? '{}') as Record<string, unknown>
    return Object.fromEntries(Object.entries(raw ?? {}).filter((e): e is [string, PendingSteer] => isPending(e[1]) && e[1].session_id === e[0]))
  } catch { return {} }
}
export function writePendingSteers(storage: KeyStore | null | undefined, pending: Record<string, PendingSteer>): void {
  try { storage?.setItem(PENDING_STEERS_KEY, JSON.stringify(pending)) } catch { /* no storage: kept for this page only */ }
}

/** Every steer record of a list into a run's rows, in the order the harness queued them. */
export function adoptSteers(rows: ThreadEntry[], runId: string, records: unknown[]): ThreadEntry[] {
  const own = records.filter(isSteerRecord).filter((r) => r.run_id === runId).sort((a, b) => a.queued_seq - b.queued_seq)
  let out = rows
  for (const record of own) {
    // a list read again places only what moved: a steer already ended on the page keeps its place
    const at = steerRowAt(out, record.id)
    if (at >= 0 && !steerSupersedes(record, out[at]!.steer)) continue
    out = applySteer(out, runId, record)
  }
  return out
}

/** A finished run's steers as rows, from its transcript (cold: a refresh, a session opened again): a delivered steer
 *  where its words stand in the run's history (the user entry carrying its steer_id), with the record's own words and
 *  state; every other record of the list (queued, undelivered, or not found in the history) after the run's rows, by
 *  queued order. A user entry without a steer_id is the run's opening message or the harness's own prompt: never shown. */
export function steerRowFor(runId: string, steerId: string, text: string, records: Map<string, SteerRecord>): ThreadEntry {
  const known = records.get(steerId)
  const steer: SteerRecord = known ?? {
    id: steerId, run_id: runId, session_id: '', text, client_request_id: '', status: 'delivered',
    queued_at: '', queued_seq: Number.MAX_SAFE_INTEGER, delivered_at: null, delivered_seq: null, request_index: null, reason: null,
  }
  return { kind: 'user', runId, eventName: `steer_${steer.status}`, steer, text: steer.text }
}

/** The facts the composer decides on: may its words go into the live run now? */
export interface SteerFacts {
  run: { id: string; status: string; parent_run_id?: string | null; work_order?: unknown; relay_id?: string | null; interaction_id?: string | null; model?: string } | undefined
  /** the session's active run as the harness last said it (steerable: the harness's own word) */
  activeRun: { id: string; steerable?: boolean } | null | undefined
  /** the run is a UI task's */
  uiTask: boolean
  relayLive: boolean
  interactionLive: boolean
  /** where the composer's words go */
  destination: 'agent' | 'director' | 'note'
  replaying: boolean
}

const LIVE = new Set(['queued', 'running'])

/** The run the composer's words steer, or null (they go as they always did: a new run, the director's queue, a
 *  participant's note — or wait). Only the session's own run, words meant for the agent, outside a relay and an
 *  interaction; the harness's steerable is the word when it named this run, else what the page knows of the run
 *  (no parent, no order, no relay, no interaction, no UI task, not ChatGPT on the web). The harness checks again. */
export function steerTarget(f: SteerFacts): string | null {
  if (f.destination !== 'agent' || f.replaying || f.relayLive || f.interactionLive) return null
  const run = f.run
  if (!run || !LIVE.has(run.status)) return null
  if (f.activeRun && f.activeRun.id === run.id && typeof f.activeRun.steerable === 'boolean') return f.activeRun.steerable ? run.id : null
  if (run.parent_run_id || (run.work_order !== null && run.work_order !== undefined) || run.relay_id || run.interaction_id || f.uiTask) return null
  if (run.model === CHATGPT_WEB_ID) return null
  return run.id
}

/** Why the draft cannot steer as it is (null: it can). The draft is never changed: the files and the chips stay. A
 *  plain @ in the words is words. */
export function steerRefusal(draft: string, files: number): string | null {
  if (files > 0) return 'Files cannot join a run already under way. They stay here: remove them to send the words now, or send them once the run ends.'
  if (mentionSegments(draft).some((piece) => 'agent' in piece || 'tool' in piece)) {
    return 'An agent or tool named with @ cannot join a run already under way. Your words stay here: take the chip out to send them now, or send them once the run ends.'
  }
  return null
}

/** Enter sends (Shift+Enter is a new line; a key an input method is composing with never sends). */
export function enterSends(e: { key: string; shiftKey: boolean; isComposing: boolean }): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing
}

/** Who sent a steer's words, as its row names them: the person; the session's director (named by the row from the
 *  director it knows); or the connector's client by the name the harness recorded from the request (ChatGPT keeps
 *  ChatGPT's mark). A connector record from before the name was kept says `connector` — never a client it cannot know. */
type SteerSender = { kind: 'person' } | { kind: 'director' } | { kind: 'connector'; name: string; chatgpt: boolean }
export function steerSender(steer: Pick<SteerRecord, 'by' | 'client'>): SteerSender {
  if (steer.by === 'director') return { kind: 'director' }
  if (steer.by !== 'connector') return { kind: 'person' }
  const name = steer.client?.trim() || 'connector'
  return { kind: 'connector', name, chatgpt: name === 'ChatGPT' }
}

const REASONS: Record<string, string> = {
  stopped: 'the run was stopped first',
  failed: 'the run failed first',
  budget: 'the run reached its budget first',
  interrupted: 'the harness stopped before the next request',
  context: 'the conversation no longer fit the model',
}

/** What the steer's row says of where it stands. Delivered means handed to this run's next model request — not that
 *  the model has acted on it. */
export function steerLabel(steer: Pick<SteerRecord, 'status' | 'reason'>): string {
  if (steer.status === 'queued') return 'queued · goes into this run\'s next model request, after the step under way'
  if (steer.status === 'delivered') return 'delivered · handed to this run\'s next model request'
  return `not delivered · ${(steer.reason && REASONS[steer.reason]) || 'the run ended first'}`
}

/** The refusal code of a failed request (the harness answers { detail, code }), if it said one. */
export function refusalCode(error: unknown): string | null {
  const body = error && typeof error === 'object' ? (error as { body?: unknown }).body : null
  const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : null
  return typeof code === 'string' ? code : null
}

/** What the person reads when a steer was not taken. The draft is always kept; nothing starts a run for it. */
export function steerErrorText(error: unknown): string {
  const code = refusalCode(error)
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined
  const detail = error && typeof error === 'object' && typeof (error as { detail?: unknown }).detail === 'string' ? (error as { detail: string }).detail : null
  switch (code) {
    case 'run_not_live':
    case 'run_finishing':
      return 'The run ended before your words could join it. Your draft is kept: send it again to start a new run.'
    case 'not_steerable':
      return 'This run does not take words while it works. Your draft is kept: send it once the run ends.'
    case 'key_conflict':
      return 'That message key was already used for other words. Your draft is kept: send it again.'
    case 'steer_agents':
      return 'Agents named with @ cannot join a run already under way. Your draft is kept.'
    case 'empty_text':
      return 'There are no words to send. Your draft is kept.'
    default:
      if (typeof status === 'number') return `${detail ?? `refused (${status})`}. Your draft is kept.`
      return `Your words may not have reached the harness (${error instanceof Error ? error.message : String(error)}). Your draft is kept: sending it again is safe.`
  }
}

/** The draft with a steer's words put back after it — the words exactly as sent, never over what is there. */
export function putBackDraft(draft: string, text: string): string {
  if (draft === '') return text
  return `${draft}${draft.endsWith('\n') ? '\n' : '\n\n'}${text}`
}

/** Whether the session's active run changed in a way the composer reads (another run, its steerable word). */
export function activeRunMoved(a: { id: string; status?: string; steerable?: boolean } | null | undefined, b: { id: string; status?: string; steerable?: boolean } | null | undefined): boolean {
  if (!a || !b) return !a !== !b
  return a.id !== b.id || a.status !== b.status || a.steerable !== b.steerable
}
