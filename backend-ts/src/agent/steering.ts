/** In-run steering, the runner's side: what a live run holds of the person's words sent while it works (its intake,
 *  open until the run decides its end), how they ride into the next request (one app line, then each message as the
 *  person's own part, word for word), and the seam the loop and the history processor reach it through. The records
 *  are the run's events (contract/src/steering.ts); docs/in-run-steering-design.md is the design record. */

import type { SteerRecord, SteerUndeliveredReason } from '@oasis-code/contract'
import { APP_ORIGIN, isRequest, userPrompt, type ModelMessage, type ModelRequest, type RequestPart, type UserPromptPart } from '../llm/messages.ts'
import { PROMPT_TEXT } from '../prompt_texts.ts'
import type { RequestSeam } from './loop.ts'

/** A live run's intake of steers: open until the run decides its end; the queued ones in FIFO order. */
export class SteerInbox {
  open = true
  closed_reason: string | null = null
  /** queued, by queued_seq */
  readonly queue: SteerRecord[] = []
  /** every steer of the run as it stands, by id; and the id under each client key */
  readonly records = new Map<string, SteerRecord>()
  readonly keys = new Map<string, string>()
  /** the queued steers the last compaction decision counted (a steer that does not fit after it is refused) */
  readonly peeked = new Set<string>()

  close(reason: string): void {
    if (!this.open) return
    this.open = false
    this.closed_reason = reason
  }

  put(record: SteerRecord): void {
    this.records.set(record.id, record)
    this.keys.set(record.client_request_id, record.id)
  }

  byKey(key: string): SteerRecord | null {
    const id = this.keys.get(key)
    return id !== undefined ? (this.records.get(id) ?? null) : null
  }

  /** Take a steer out of the queue (it was delivered or ended). */
  take(id: string): void {
    const at = this.queue.findIndex((s) => s.id === id)
    if (at >= 0) this.queue.splice(at, 1)
    this.peeked.delete(id)
  }
}

/** The seam the agent (agent.ts) reaches the runner's steering through; null where the run takes none. */
export interface SteeringPort {
  /** words wait for the next boundary and the run can still deliver them */
  pending(): boolean
  /** the parts the waiting words would add to the pending request (the compaction decision counts them) */
  peek(): RequestPart[]
  /** at a request boundary: the messages with the waiting words appended to the pending request, committed (the
   *  record and the delivered events written together); the same messages when nothing goes. `must`: a steer that
   *  does not fit is refused now rather than left for a later boundary. */
  deliver(messages: ModelMessage[], seam: RequestSeam, must: boolean): ModelMessage[]
  /** the run takes no more words (its final answer is decided) */
  close(): void
}

/** The app's line before the steers of one boundary from one source: the person's, or a director's (a native
 *  director or the connector's client) — the model reads who said them. */
export function steerHeader(by: SteerRecord['by'] = 'person'): UserPromptPart {
  return userPrompt(PROMPT_TEXT[by === 'director' || by === 'connector' ? 'app.steer_director' : 'app.steer'], APP_ORIGIN)
}

/** Whether a request part is the app's line before steers (either source's). */
export function isSteerHeader(content: unknown): boolean {
  return content === PROMPT_TEXT['app.steer'] || content === PROMPT_TEXT['app.steer_director']
}

/** The parts the steers of one boundary add, in their order: each run of words from one source after its line. */
export function steerParts(records: SteerRecord[]): RequestPart[] {
  const out: RequestPart[] = []
  let source: string | null = null
  for (const r of records) {
    const by = r.by ?? 'person'
    const kind = by === 'person' ? 'person' : 'director'
    if (kind !== source) { out.push(steerHeader(by)); source = kind }
    out.push(steerPart(r))
  }
  return out
}

/** A steer as the request carries it: the person's words exactly as sent, as their own part. */
export function steerPart(record: SteerRecord): UserPromptPart {
  return { ...userPrompt(record.text, { origin: 'person' }), steer_id: record.id }
}

/** Whether a request part is a steer's words. */
export function isSteerPart(part: RequestPart): boolean {
  return part.part_kind === 'user-prompt' && typeof (part as { steer_id?: unknown }).steer_id === 'string'
}

/** The messages with `parts` appended to the pending request they end with (unchanged when they end otherwise). */
export function withTailParts(messages: ModelMessage[], parts: RequestPart[]): ModelMessage[] {
  const last = messages[messages.length - 1]
  if (!parts.length || !last || !isRequest(last)) return messages
  return [...messages.slice(0, -1), { ...last, parts: [...last.parts, ...parts] } as ModelRequest]
}

/** The record without the empty request a final answer opened for steers (never a request anything was said in). */
export function withoutOpenTail(messages: ModelMessage[]): ModelMessage[] {
  const last = messages[messages.length - 1]
  return last && isRequest(last) && last.parts.length === 0 ? messages.slice(0, -1) : messages
}

/** Why a run's steers still queued at its end were not delivered. */
export function undeliveredReason(o: { status: string; budget: boolean; stopping: boolean }): SteerUndeliveredReason {
  if (o.budget) return 'budget'
  // a run that ends done with words still queued had its answer whole and no request left to take them (the loop goes
  // on for queued words whenever the request line leaves room): its budget, not a failure
  if (o.status === 'done') return 'budget'
  if (o.status === 'cancelled') return o.stopping ? 'interrupted' : 'stopped'
  return 'failed'
}
