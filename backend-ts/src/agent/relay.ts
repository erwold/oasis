/** The relay: one message of the person to several agents, who take turns on it in the order named — what each
 *  does with its turn is the person's message to decide, not a role the harness assigns. Every turn is an ordinary
 *  thread run of the session on its participant's model. Each participant has a conversation of its own: its turns
 *  continue its own earlier turn (its record is only appended to, so its provider's cache reads it), and its first
 *  turn continues the conversation the relay started from — the same base for every participant. What the others
 *  did reaches a participant as one packet per turn it has not seen, part of the message that opens its turn
 *  (built once from the records, never rewritten): the speaker's answer as written, one line per tool call with the
 *  ids that read the result again, and the receipt's measured facts. The app note that opens a turn says which
 *  turn it is, who speaks, who spoke before and who is next — the participants by their short ids (A, B, …),
 *  never by a role.
 *
 *  The chain is scheduled here and persisted in `relays`: a turn starts only from the runner's finish hook, after
 *  the earlier run's row, receipt and history are written; a stop, a failure, a budget line, a restart or a turn
 *  that ended waiting for the person's decision ends the chain's own scheduling — the person continues it, or not. */

import {
  ACTIVE_RUN_STATUSES, MAX_RELAY_PARTICIPANTS, MAX_RELAY_ROUNDS, type Budget, type Attachment, type Relay, type RelayParticipant,
  type Origin, type RelayStep, type Run, type Session,
} from '@oasis-code/contract'
import type { AppState } from '../api/state.ts'
import { credentialState } from '../auth/routing.ts'
import * as repo from '../db/repo.ts'
import { findModel } from '../llm/catalog.ts'
import { isChatGptWeb } from '../llm/chatgpt_web.ts'
import { attachmentRefusal } from '@oasis-code/contract'
import { listProposals } from '../policy/gate.ts'
import { nowIso } from '../timebase.ts'
import type { ResolvedMention } from '../workspace/entities.ts'
import { requestLines } from './named_tools.ts'
import { MAX_ANSWER_CHARS, peerPacket } from './peer_packet.ts'
import { mainHeadRun, originOf, type Handover } from './collab.ts'
import type { RelayTurn } from './runner.ts'
import { text } from '../prompt_texts.ts'

export class RelayInvalid extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = 'RelayInvalid' }
}

/** The short id a participant is named by in the turns: A, B, … in the order named. */
export function participantId(index: number): string {
  return String.fromCharCode(65 + index)
}

/** The steps of rounds `from`..`to` (1-based, inclusive): every participant once per round, in order. */
export function planSteps(participants: number, from: number, to: number, seqStart = 0): RelayStep[] {
  const out: RelayStep[] = []
  for (let round = from; round <= to; round += 1) {
    for (let p = 0; p < participants; p += 1) out.push({ seq: seqStart + out.length, round, participant: p, status: 'queued', run_id: null, run_ids: [] })
  }
  return out
}

export interface RelayPlan {
  participants: RelayParticipant[]
  rounds: number
}

export interface RelayStartOptions {
  text: string
  plan: RelayPlan
  mentions: ResolvedMention[]
  attachments: Attachment[]
  thinking: string | null
  /** the limits every turn runs under (the chat body's budget is per run) */
  budget: Budget | null
  client_request_id: string | null
  /** the first turn starts a new conversation in the session (no earlier history) */
  fresh?: boolean
  /** the run the first turn continues (checked to be a finished thread run of the session) */
  resumes_run_id?: string | null
  /** schema v25: what the message names by exact run (checked before the relay starts) — its lines open the first
   *  turn (a citation names a run and hands nothing; a received run's answer goes whole), its edges go to that turn.
   *  The later turns hand each other their answers as before; nothing of this is passed on to them by the harness. */
  handover?: Handover | null
  /** the fingerprint of the request's intent (a resend with the same key and another intent is refused) */
  intent_sha?: string | null
  /** who asked for the relay (the request's checked origin; the person when not said) */
  origin?: Origin | null
}

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})

/** The budget line a finished run stopped at, if any: the runner ends such a run "done" after a closing turn that
 *  could use no tool, so its task may be unfinished — not a turn to hand on. */
export function budgetLineOf(run: Run): string | null {
  const mechanical = rec(rec(run.receipt).mechanical)
  const reached = mechanical.budget_reached ?? mechanical.budget_exceeded ?? rec(mechanical.budget).reached ?? rec(mechanical.budget).exceeded
  return typeof reached === 'string' && reached ? reached : null
}

export class RelayManager {
  /** the process is shutting down: a turn that ends now is recorded, nothing starts after it (the next start finds
   *  the chain interrupted and the person continues it) */
  private stopping = false

  constructor(readonly state: AppState) {}

  shutdown(): void { this.stopping = true }

  attachHooks(): void {
    this.state.runs.onRunFinished((runId) => {
      try { this.onRunFinished(runId) } catch (error) { console.warn(`relay: ${(error as Error).message}`) }
    })
  }

  // -- planning ----------------------------------------------------------------------------------------------------

  /** The participants of a message, checked before anything starts: known routes, a credential for each, image
   *  input on each when images ride along, and the rounds within the line. An agent's `id` is the alias the message
   *  names it by (A, B, …) when the message carries one; else its position. */
  plan(agents: { model: string; id?: string | null; label?: string | null; thinking?: string | null }[], rounds: number, attachments: Attachment[]): RelayPlan {
    if (agents.length < 2) throw new RelayInvalid('a relay names at least two agents')
    if (agents.length > MAX_RELAY_PARTICIPANTS) throw new RelayInvalid(`a relay names at most ${MAX_RELAY_PARTICIPANTS} agents`)
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_RELAY_ROUNDS) throw new RelayInvalid(`rounds must be between 1 and ${MAX_RELAY_ROUNDS}`)
    const participants: RelayParticipant[] = agents.map((a, i) => {
      const cfg = findModel(this.state.config, a.model)
      const overridden = this.state.model_overrides.has(a.model)
      if (cfg === null && !overridden) throw new RelayInvalid(`unknown model: ${a.model}`)
      const label = cfg?.label || a.model
      if (cfg !== null && !overridden) {
        const credential = credentialState(cfg)
        if (credential.status !== 'available') throw new RelayInvalid(`${label} has no credential here (${credential.hint ?? 'sign in or save a key on the Accounts page'})`)
      }
      const refusal = cfg && attachmentRefusal(cfg.capabilities, attachments, cfg.label || cfg.id)
      if (refusal) throw new RelayInvalid(refusal)
      return { model: a.model, label: a.label || label, id: a.id || participantId(i), ...(a.thinking ? { thinking: a.thinking } : {}) }
    })
    const ids = participants.map((p) => p.id)
    if (new Set(ids).size !== ids.length) throw new RelayInvalid('a relay names each participant once: two agents share an alias')
    return { participants, rounds }
  }

  // -- the chain -------------------------------------------------------------------------------------------------------

  async start(session: Session, o: RelayStartOptions): Promise<{ relay: Relay; run: Run }> {
    if (this.state.runs.activeRunOfSession(session.id) !== null) throw new RelayInvalid(`session ${session.id} already has an active run`, 409)
    if (o.resumes_run_id) {
      const previous = repo.getRun(this.state.conn, o.resumes_run_id)
      if (previous === null || previous.session_id !== session.id || previous.workspace_id === null) throw new RelayInvalid(`resumes_run_id is not a run of this session: ${o.resumes_run_id}`)
      if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(previous.status)) throw new RelayInvalid(`run ${o.resumes_run_id} is still ${previous.status}`, 409)
    }
    const steps = planSteps(o.plan.participants.length, 1, o.plan.rounds)
    // the base every participant's first turn continues: none (fresh), the run named, else the session's latest run
    // as it stands now (a later turn must not pick up another participant's run as the session's latest)
    const base = o.fresh ? null : (o.resumes_run_id ?? mainHeadRun(this.state, session.id)?.id ?? null)
    const relay = repo.insertRelay(this.state.conn, {
      session_id: session.id, user_text: o.text, participants: o.plan.participants, steps, rounds: o.plan.rounds, thinking: o.thinking, budget: o.budget ?? {},
      mentions: o.mentions as unknown as Record<string, unknown>[], attachments: o.attachments, client_request_id: o.client_request_id,
      fresh: o.fresh ?? false, resumes_run_id: base, access_cap: this.state.runs.groupAccessCap(null, (o.origin ?? null) as never),
    })
    const run = await this.startFirst(relay, { handover: o.handover ?? null, intent_sha: o.intent_sha ?? null, origin: o.origin ?? null })
    return { relay: repo.getRelay(this.state.conn, relay.id)!, run }
  }

  /** The first turn of a relay whose first turn never started: a fresh one, or one a crash (or a refused start) left
   *  without a run — a resend of the same message with its key starts it now instead of a second relay. */
  async startFirst(relay: Relay, named: { handover: Handover | null; intent_sha: string | null; origin?: Origin | null } = { handover: null, intent_sha: null }): Promise<Run> {
    try {
      return await this.startStep(relay, 0, { resumes: null, text: relay.user_text, note: this.preface(relay, 0), harness_message: false, first: true, handover: named.handover, intent_sha: named.intent_sha, origin: named.origin ?? null })
    } catch (error) {
      this.finish(relay, 'error', `${relay.participants[0]!.label}'s turn could not start: ${(error as Error).message}`)
      throw error
    }
  }

  /** A relay whose first turn never ran (no run of any step): the one a resend with the same key resumes. */
  static unstarted(relay: Relay): boolean {
    return relay.steps.every((s) => s.run_ids.length === 0 && s.run_id === null)
  }

  /** The chain's newest run is the session's latest thread run: nothing was said since. A relay the conversation moved
   *  on from is not continued (its context would rewind past the person's later words); a new message names the agents. */
  private movedOn(relay: Relay): string | null {
    const last = [...relay.steps].reverse().find((s) => s.run_id !== null)?.run_id ?? null
    const latest = mainHeadRun(this.state, relay.session_id)
    if (last === null || latest === null || latest.id === last) return null
    return latest.relay_id === relay.id ? null : latest.id
  }

  /** The relay under way in the session (the harness may still start its next turn), if any. */
  activeOf(sessionId: string): Relay | null {
    return repo.listRelays(this.state.conn, sessionId).find((r) => r.status === 'running') ?? null
  }

  /** Stop the whole chain: the live turn is cancelled, no later turn starts. */
  cancel(relayId: string): boolean {
    const relay = repo.getRelay(this.state.conn, relayId)
    if (relay === null) return false
    if (!['running', 'waiting', 'interrupted'].includes(relay.status)) return false
    const step = relay.steps[relay.current_step]
    const live = step?.run_id ? this.state.runs.handles.get(step.run_id) : undefined
    const stopping = live !== undefined && !live.done
    this.finish(relay, 'cancelled', stopping ? `stopped by the person during ${this.label(relay, step!)}'s turn` : 'stopped by the person')
    if (stopping) this.state.runs.cancel(step!.run_id!)
    return true
  }

  /** Waiting or interrupted relays are the person's to continue; a new message of theirs supersedes them (`except`:
   *  the relay that message is a resend of). */
  supersede(sessionId: string, except: string | null = null): string[] {
    const out: string[] = []
    for (const relay of repo.listRelays(this.state.conn, sessionId)) {
      if (relay.id === except) continue
      if (relay.status !== 'waiting' && relay.status !== 'interrupted') continue
      this.finish(relay, 'cancelled', 'superseded by a new message')
      out.push(relay.id)
    }
    return out
  }

  /** Resume a waiting relay (its decision made) or an interrupted one, or give a finished one more rounds. */
  async continue(relayId: string, o: { rounds?: number | null } = {}): Promise<Relay> {
    const relay = repo.getRelay(this.state.conn, relayId)
    if (relay === null) throw new RelayInvalid(`relay not found: ${relayId}`, 404)
    const session = repo.getSession(this.state.conn, relay.session_id)
    if (session === null || session.status === repo.DELETED_SESSION) throw new RelayInvalid(`session not found: ${relay.session_id}`, 404)
    if (this.state.runs.activeRunOfSession(session.id) !== null) throw new RelayInvalid(`session ${session.id} already has an active run`, 409)
    const later = this.movedOn(relay)
    if (later !== null) throw new RelayInvalid(`the conversation moved on since this relay (run ${later} came after it); name the agents in a new message instead`, 409)
    const step = relay.steps[relay.current_step]
    if (relay.status === 'waiting') {
      if (!step?.run_id) throw new RelayInvalid('the waiting turn has no run', 409)
      const pending = this.pendingDecisions(session, step.run_id)
      if (pending.length) throw new RelayInvalid(`${this.label(relay, step)}'s turn still waits for your decision on ${pending.length} proposed action${pending.length === 1 ? '' : 's'}`, 409)
      await this.startStep(relay, relay.current_step, { resumes: step.run_id, text: this.continuation(relay, step), note: null, harness_message: true, first: false })
      return repo.getRelay(this.state.conn, relayId)!
    }
    if (relay.status === 'interrupted') {
      const run = step?.run_id ? repo.getRun(this.state.conn, step.run_id) : null
      if (step === undefined) throw new RelayInvalid('the relay has no turn to continue', 409)
      if (run === null) {
        if (relay.current_step === 0 && RelayManager.unstarted(relay)) await this.startFirst(relay)
        else await this.startStep(relay, relay.current_step, this.turnMessage(relay, relay.current_step))
      } else if (run.status === 'done') {
        await this.advanceAfter(relay, relay.current_step)
      } else {
        await this.startStep(relay, relay.current_step, { resumes: run.id, text: this.continuation(relay, step), note: null, harness_message: true, first: false })
      }
      return repo.getRelay(this.state.conn, relayId)!
    }
    if (relay.status === 'done') {
      const add = o.rounds ?? 1
      if (!Number.isInteger(add) || add < 1) throw new RelayInvalid('rounds must be a positive number')
      const total = relay.rounds + add
      if (total > MAX_RELAY_ROUNDS) throw new RelayInvalid(`a relay runs at most ${MAX_RELAY_ROUNDS} rounds in all; this one has had ${relay.rounds}`)
      const steps = [...relay.steps, ...planSteps(relay.participants.length, relay.rounds + 1, total, relay.steps.length)]
      repo.updateRelay(this.state.conn, relay.id, { steps, rounds: total, status: 'running', reason: null, finished_at: null })
      const fresh = repo.getRelay(this.state.conn, relay.id)!
      await this.startStep(fresh, relay.steps.length, this.turnMessage(fresh, relay.steps.length))
      return repo.getRelay(this.state.conn, relayId)!
    }
    throw new RelayInvalid(`a ${relay.status} relay cannot be continued; send a new message instead`, 409)
  }

  /** Startup, after the runner's own reconcile: a relay left running is interrupted — nothing starts on its own. */
  reconcile(): { interrupted: string[]; finished: string[] } {
    const interrupted: string[] = []
    const finished: string[] = []
    for (const relay of repo.listRelaysWithStatus(this.state.conn, ['running'])) {
      // a turn's run inserted before the relay recorded it (a restart between the two): recorded now, as an attempt
      // of its step, so every run of the relay is accounted for
      for (const run of repo.listRunsOfRelay(this.state.conn, relay.id)) {
        const owner = run.relay_step === null ? undefined : relay.steps.find((s) => s.seq === run.relay_step)
        if (owner !== undefined && !owner.run_ids.includes(run.id)) {
          relay.steps = relay.steps.map((s) => (s.seq === owner.seq ? { ...s, run_ids: [...s.run_ids, run.id] } : s))
          repo.updateRelay(this.state.conn, relay.id, { steps: relay.steps })
        }
      }
      const step = relay.steps[relay.current_step]
      if (step === undefined) { this.finish(relay, 'error', 'the relay has no turn to run'); continue }
      const run = step.run_id ? repo.getRun(this.state.conn, step.run_id) : this.findRunOfStep(relay, step)
      const who = this.label(relay, step)
      if (run === null) {
        this.setStep(relay, step.seq, { status: 'queued' })
        this.finish(relay, 'interrupted', `the harness restarted before ${who}'s turn started; continue to start it`)
        interrupted.push(relay.id)
      } else if (run.status === 'done') {
        this.setStep(relay, step.seq, { status: 'done', run_id: run.id })
        const next = relay.steps[relay.current_step + 1]
        const session = repo.getSession(this.state.conn, relay.session_id)
        const line = budgetLineOf(run)
        if (line !== null) {
          this.setStep(relay, step.seq, { status: 'error', run_id: run.id })
          this.finish(relay, 'error', `${who}'s turn stopped at its budget line (${line}); its task may be unfinished, so nothing follows it`)
          finished.push(relay.id)
        } else if (session !== null && this.pendingDecisions(session, run.id).length) {
          this.finish(relay, 'waiting', `${who}'s turn ended waiting for your decision; decide, then continue`)
          interrupted.push(relay.id)
        } else if (next === undefined) {
          this.finish(relay, 'done', null)
          finished.push(relay.id)
        } else {
          this.finish(relay, 'interrupted', `the harness restarted before ${this.label(relay, next)}'s turn started; continue to start it`)
          interrupted.push(relay.id)
        }
      } else if (run.status === 'cancelled') {
        this.setStep(relay, step.seq, { status: 'cancelled', run_id: run.id })
        this.finish(relay, 'cancelled', `stopped during ${who}'s turn`)
        finished.push(relay.id)
      } else if (run.error === repo.LOST_RUN_ERROR || (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) {
        this.setStep(relay, step.seq, { status: 'error', run_id: run.id })
        this.finish(relay, 'interrupted', `${who}'s turn was cut off by a restart; continue to let it carry on from its record`)
        interrupted.push(relay.id)
      } else {
        this.setStep(relay, step.seq, { status: 'error', run_id: run.id })
        this.finish(relay, 'error', `${who}'s turn failed: ${run.error ?? run.status}`)
        finished.push(relay.id)
      }
    }
    return { interrupted, finished }
  }

  // -- the hook ------------------------------------------------------------------------------------------------------

  private onRunFinished(runId: string): void {
    const run = repo.getRun(this.state.conn, runId)
    if (run === null || run.relay_id === null) return
    const relay = repo.getRelay(this.state.conn, run.relay_id)
    if (relay === null) return
    const step = relay.steps[relay.current_step]
    if (step === undefined || step.run_id !== run.id) return
    const who = this.label(relay, step)
    if (relay.status !== 'running') {
      // stopped (or superseded) while the turn ran: the turn's end is recorded, nothing follows
      this.setStep(relay, step.seq, { status: run.status === 'done' ? 'done' : run.status === 'cancelled' ? 'cancelled' : 'error' })
      return
    }
    if (run.status === 'cancelled') {
      if (this.stopping) {
        // the harness is shutting down (the desktop app closing, a SIGTERM): the turn was cut off, not stopped by the
        // person — the chain waits for the next start and the person's word, its record so far kept
        this.setStep(relay, step.seq, { status: 'error' })
        this.finish(relay, 'interrupted', `${who}'s turn was cut off when the harness shut down; continue to let it carry on from its record`)
        return
      }
      this.setStep(relay, step.seq, { status: 'cancelled' })
      this.finish(relay, 'cancelled', `stopped during ${who}'s turn`)
      return
    }
    if (run.status !== 'done') {
      this.setStep(relay, step.seq, { status: 'error' })
      this.finish(relay, 'error', `${who}'s turn ${run.status === 'error' ? 'failed' : `ended ${run.status}`}: ${run.error ?? 'no error recorded'}`)
      return
    }
    const line = budgetLineOf(run)
    if (line !== null) {
      // the runner ends a run at its budget line "done" after a closing turn without tools: the task may be unfinished
      this.setStep(relay, step.seq, { status: 'error' })
      this.finish(relay, 'error', `${who}'s turn stopped at its budget line (${line}); its task may be unfinished, so nothing follows it`)
      return
    }
    const session = repo.getSession(this.state.conn, relay.session_id)
    const pending = session === null ? [] : this.pendingDecisions(session, run.id)
    if (pending.length) {
      this.setStep(relay, step.seq, { status: 'waiting' })
      this.finish(relay, 'waiting', `${who}'s turn ended waiting for your decision on ${pending.length} proposed action${pending.length === 1 ? '' : 's'}; decide, then continue`)
      return
    }
    this.setStep(relay, step.seq, { status: 'done' })
    if (this.stopping) return
    void this.advanceAfter(repo.getRelay(this.state.conn, relay.id)!, step.seq)
  }

  /** The turn after `seq` starts now (its row exists before the first await), or the chain is done. */
  private async advanceAfter(relay: Relay, seq: number): Promise<void> {
    const next = relay.steps[seq + 1]
    if (next === undefined) { this.finish(relay, 'done', null); return }
    const fresh = repo.getRelay(this.state.conn, relay.id)!
    try {
      await this.startStep(fresh, next.seq, this.turnMessage(fresh, next.seq))
    } catch (error) {
      const again = repo.getRelay(this.state.conn, relay.id)
      if (again && (again.status === 'running' || again.status === 'interrupted')) {
        this.setStep(again, next.seq, { status: 'error' })
        this.finish(again, 'error', `${this.label(again, next)}'s turn could not start: ${(error as Error).message}`)
      }
      throw error
    }
  }

  // -- turns -------------------------------------------------------------------------------------------------------------

  private async startStep(relay: Relay, seq: number, message: { resumes: string | null; text: string; note: string | null; harness_message: boolean; first: boolean; received?: { run_id: string; packet: 'whole' | 'cut'; answer_chars: number; handed_chars: number }[]; handover?: Handover | null; intent_sha?: string | null; origin?: Origin | null }): Promise<Run> {
    const session = repo.getSession(this.state.conn, relay.session_id)
    if (session === null) throw new RelayInvalid(`session not found: ${relay.session_id}`, 404)
    const step = relay.steps[seq]
    if (step === undefined) throw new RelayInvalid(`no turn ${seq} in relay ${relay.id}`)
    const participant = relay.participants[step.participant]!
    const inputs = repo.relayInputs(this.state.conn, relay.id)
    const turn: RelayTurn = { id: relay.id, step: seq, note: message.note, harness_message: message.harness_message }
    // the participant's conversation: on a re-run the turn's own run; else its own earlier turn, or — its first
    // turn — the relay's base (a fresh conversation when the relay has none)
    const own = this.ownPreviousRun(relay, seq)
    const previous = message.resumes ?? own ?? inputs.resumes_run_id
    const firstOfParticipant = message.resumes === null && own === null
    const run = await this.state.runs.start(session, message.text, {
      model_id: participant.model, resumes_run_id: previous, fresh: previous === null, thinking: participant.thinking ?? inputs.thinking, budget: inputs.budget, relay: turn, keep_session_model: true,
      mentions: firstOfParticipant ? (inputs.mentions as unknown as ResolvedMention[]) : null, attachments: firstOfParticipant ? inputs.attachments : [],
      client_request_id: message.first ? relay.client_request_id : null,
      // schema v25: the first turn is the person's request; the rest the relay's schedule — each turn's received
      // packets recorded as exact runs (whole, or cut at the packet limit)
      collab: {
        origin: message.first && message.origin ? { ...message.origin, request: 'relay_turn', relay_id: relay.id }
          : originOf(message.first ? { actor: 'person', request: 'relay_turn', relay_id: relay.id } : { actor: 'scheduler', request: 'relay_turn', relay_id: relay.id }),
        edges: [
          ...(message.received ?? []).map((r) => ({ kind: 'received', from: { kind: 'run', id: r.run_id }, meta: { via: 'relay_turn', packet: r.packet, answer_chars: r.answer_chars, handed_chars: r.handed_chars, node: null, content_delivered: true } })),
          ...(message.handover?.edges ?? []),
        ],
        lines: message.handover?.lines ?? [],
        handover: message.handover?.lines.length ? { received: message.handover.received, cited: message.handover.cited } : null,
        intent_sha: message.intent_sha ?? null,
      },
    })
    const steps = relay.steps.map((s) => (s.seq === seq ? { ...s, status: 'running' as const, run_id: run.id, run_ids: [...s.run_ids, run.id] } : s))
    repo.updateRelay(this.state.conn, relay.id, { steps, current_step: seq, round: step.round, status: 'running', reason: null, finished_at: null })
    return run
  }

  /** The message that opens a turn after the first: the app note (which turn, who speaks, who spoke before, who is
   *  next), then — on the participant's first turn — the person's request as written, then one packet per turn of
   *  another participant since this participant last spoke. A participant's first turn gets the roster as its
   *  context, as the relay's first turn did. */
  private turnMessage(relay: Relay, seq: number): { resumes: null; text: string; note: string | null; harness_message: true; first: false; received: { run_id: string; packet: 'whole' | 'cut'; answer_chars: number; handed_chars: number }[] } {
    const step = relay.steps[seq]!
    const own = this.ownPreviousRun(relay, seq)
    const since = own === null ? -1 : relay.steps.findIndex((s) => s.run_id === own)
    const lines = [this.turnNote(relay, seq)]
    const received: { run_id: string; packet: 'whole' | 'cut'; answer_chars: number; handed_chars: number }[] = []
    if (own === null) lines.push(requestLines(relay.user_text))
    for (const earlier of relay.steps.slice(since + 1, seq)) {
      if (earlier.run_id === null || earlier.participant === step.participant) continue
      const run = repo.getRun(this.state.conn, earlier.run_id)
      if (run === null) continue
      lines.push(peerPacket(this.state.conn, run, { turn: earlier.seq + 1, speaker: this.idOf(relay, earlier.participant), plain: isChatGptWeb(relay.participants[step.participant]?.model) }))
      const chars = Array.from(typeof run.receipt.final_text === 'string' ? run.receipt.final_text.trim() : '').length
      received.push({ run_id: run.id, packet: chars > MAX_ANSWER_CHARS ? 'cut' : 'whole', answer_chars: chars, handed_chars: Math.min(chars, MAX_ANSWER_CHARS) })
    }
    return { resumes: null, text: lines.join('\n\n'), note: own === null ? this.roster(relay) : null, harness_message: true, first: false, received }
  }

  private turnNote(relay: Relay, seq: number): string {
    const step = relay.steps[seq]!
    const me = this.idOf(relay, step.participant)
    const authors = relay.steps.slice(0, seq).filter((s) => s.run_id !== null).map((s) => this.idOf(relay, s.participant))
    const next = relay.steps[seq + 1]
    return text('relay.turn', {
      turn: seq + 1, total: relay.steps.length, speaker: me, authors: authors.length ? authors.join(', ') : 'none',
      next: next ? this.idOf(relay, next.participant) : 'none',
    })
  }

  /** The context of the first turn: the participants and their order, once, and the first turn's note. */
  private preface(relay: Relay, seq: number): string {
    return `${this.roster(relay)}\n${this.turnNote(relay, seq)}`
  }

  private roster(relay: Relay): string {
    const participants = relay.participants.map((p, i) => `${this.idOf(relay, i)}: ${p.label} (${p.model})`).join('\n')
    return text('relay.roster', { participants, order: relay.participants.map((_p, i) => this.idOf(relay, i)).join(', ') })
  }

  /** The message of a turn taken up again (after the person's decision, after a restart): the same turn, the same
   *  speaker; what happened meanwhile — a decision on a proposal — stands in the run's own context lines. */
  private continuation(relay: Relay, step: RelayStep): string {
    return text('relay.continue', { turn: step.seq + 1, speaker: this.idOf(relay, step.participant) })
  }

  // -- helpers -----------------------------------------------------------------------------------------------------------

  private label(relay: Relay, step: RelayStep): string {
    return relay.participants[step.participant]?.label ?? `agent ${step.participant + 1}`
  }

  private idOf(relay: Relay, index: number): string {
    return relay.participants[index]?.id || participantId(index)
  }

  /** The run of this step's participant's latest earlier turn (its own conversation), or null on its first turn. */
  private ownPreviousRun(relay: Relay, seq: number): string | null {
    const participant = relay.steps[seq]!.participant
    for (let i = seq - 1; i >= 0; i -= 1) {
      const step = relay.steps[i]!
      if (step.participant === participant && step.run_id) return step.run_id
    }
    return null
  }

  private findRunOfStep(relay: Relay, step: RelayStep): Run | null {
    return repo.listRunsOfRelay(this.state.conn, relay.id).filter((r) => r.relay_step === step.seq).at(-1) ?? null
  }

  private setStep(relay: Relay, seq: number, patch: Partial<RelayStep>): void {
    const steps = relay.steps.map((s) => (s.seq === seq ? { ...s, ...patch, run_ids: patch.run_id && !s.run_ids.includes(patch.run_id) ? [...s.run_ids, patch.run_id] : s.run_ids } : s))
    repo.updateRelay(this.state.conn, relay.id, { steps })
    relay.steps = steps
  }

  private finish(relay: Relay, status: Relay['status'], reason: string | null): void {
    const final = status === 'done' || status === 'cancelled' || status === 'error'
    repo.updateRelay(this.state.conn, relay.id, { status, reason, finished_at: final ? nowIso() : null })
  }

  /** The actions of a run that still wait for the person: pending approvals (a grant the session lacks) and
   *  pending action proposals (the Ask-before-changes gate). */
  pendingDecisions(session: Session, runId: string): { kind: 'approval' | 'proposal'; id: string; action: string }[] {
    const approvals = this.state.gate.listPending(session.id).filter((a) => a.run_id === runId).map((a) => ({ kind: 'approval' as const, id: a.id, action: a.action }))
    const proposals = listProposals(this.state.conn, session.project_id, session.id).filter((p) => p.run_id === runId && p.status === 'pending')
      .map((p) => ({ kind: 'proposal' as const, id: p.proposal_asset_id, action: p.tool_name ?? 'action' }))
    return [...approvals, ...proposals]
  }

}
