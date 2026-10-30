/** What a director transport is: the way one turn reaches the director and its answer comes back. Two exist —
 *  native (a model route of this harness, in process, with the director tools) and bridge (the ChatGPT web app
 *  behind a bridge that types into the person's own signed-in conversation). The controller owns the turn's lifecycle, the outbox and the state; a transport only
 *  sends, and says whether the answer is here, comes later, or cannot be had until the person signs in. */

import type { DirectorSession, DirectorToolCall, DirectorTransport as TransportId, DirectorTurn, Project, Session } from '@oasis-code/contract'

export type Rec = Record<string, unknown>

export interface TurnContext {
  director: DirectorSession
  turn: DirectorTurn
  session: Session
  project: Project
  /** the turn's stream: text_delta {text, start?}, thinking_delta {text, start?} (start: the text so far is replaced),
   *  tool_call {name, summary}, tool_result {name, status, summary}, note {text} */
  emit(event: string, data: Rec): void
  /** a run this turn started (the outbox links its end back to this turn) */
  dispatched(runId: string): void
  signal: AbortSignal
}

export type TurnOutcome =
  /** the answer is here */
  | { kind: 'answered'; text: string; model: string; usage?: Record<string, number>; tool_calls?: DirectorToolCall[]; external_ref?: string | null; images?: AnswerImage[] }
  /** the message was submitted; the answer arrives later (the transport's poll, or POST …/answer from outside) */
  | { kind: 'pending'; external_ref?: string | null; note?: string }
  /** the transport cannot send until the person signs in (the bridge's browser shows the sign-in page) */
  | { kind: 'needs_login'; reason: string }
  /** the transport is busy (the web app still generating an earlier answer): try again in a moment. `may_have_sent`:
   *  busy with this very message (it may go meanwhile), so a turn that gives up waiting does not send it again.
   *  `retry_for_s`: how long the transport may stay busy so — the turn asks again for at least that long */
  | { kind: 'busy'; reason: string; retry_in_s?: number; may_have_sent?: boolean; retry_for_s?: number }
  /** the message went, and its answer cannot be had here (the bridge restarted since, or no longer knows the message):
   *  the turn ends now, and what it carried is not sent again */
  | { kind: 'lost'; reason: string }

/** A picture the director's answer showed (the bridge keeps what the ChatGPT page loaded for it). */
export interface AnswerImage { name: string; bytes: Uint8Array }

export interface Readiness { ready: boolean; hint: string | null }

export interface TransportDeps {
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>
  /** the desktop app's bridge token, kept in the data directory (0600): the live one, whatever a director's config
   *  saved when it was opened in an earlier run of the app */
  localBridgeToken?: () => string | null
  /** where the desktop app's bridge listens now, as the app wrote it in the data directory (null: nothing written) —
   *  the live one, whatever address a director's config saved when it was opened */
  localBridgeUrl?: () => string | null
}

export interface DirectorTransport {
  readonly id: TransportId
  readonly label: string
  /** whether a director session of this transport could be opened now, and what is missing when not */
  readiness(): Readiness
  /** the config as stored: defaults filled, the required keys checked (throws with the reason) */
  normalizeConfig(config: Rec, model: string | null): { config: Rec; model: string; label: string }
  send(ctx: TurnContext): Promise<TurnOutcome>
  /** a pending turn's answer, when the transport can ask for it (null: not yet) */
  poll?(ctx: TurnContext): Promise<TurnOutcome | null>
  /** whether the transport can send again after needs_login (the bridge asks its browser) */
  probe?(director: DirectorSession): Promise<{ ready: boolean; reason: string | null }>
}

/** A transport's refusal or failure. `may_have_sent`: the message may have reached the director although no reply
 *  said so (a connection lost after the bridge took it, a send with no sign it went) — what the turn carried is not
 *  sent again under another turn. */
export class TransportError extends Error {
  readonly may_have_sent: boolean
  constructor(message: string, readonly status = 400, opts: { may_have_sent?: boolean } = {}) {
    super(message)
    this.name = 'TransportError'
    this.may_have_sent = opts.may_have_sent ?? false
  }
}

export function str(v: unknown, fallback = ''): string { return typeof v === 'string' ? v : fallback }
export function num(v: unknown, fallback: number): number { return typeof v === 'number' && Number.isFinite(v) ? v : fallback }
export function bool(v: unknown, fallback: boolean): boolean { return typeof v === 'boolean' ? v : fallback }
