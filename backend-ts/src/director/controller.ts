/** The director session's one manager. It owns the conversation's continuation: the person's messages and the
 *  task events of the outbox become turns, one at a time per director session, in order; a transport carries a
 *  turn to the director and its answer back; the answer is written as a director note (what the thread shows) and
 *  the events the turn delivered are marked so; a turn that fails sends its events back to the outbox for the next
 *  one. Nothing here lives only in memory that must survive: the turns, the outbox and the session's state are
 *  rows, and a restart reconciles from them — a turn that was with a model when the process died is marked so, one
 *  that was going to the bridge when it died or stopped goes again under its own id (the bridge sends a turn at most
 *  once, and answers one still on its way as `sending` until it went), an answer the
 *  ChatGPT page is still writing keeps waiting. A retry never repeats a dispatch: a task event is delivered by a new
 *  turn — never after a message that may have reached the director — and the runs a turn started are recorded on it. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '../llm/redact.ts'
import { ACTIVE_DIRECTOR_TURN_STATUSES, ACTIVE_RUN_STATUSES, CURRENT_DIRECTOR_TOOL_SURFACE, DirectorSayBodySchema, type DirectorSayBody, type DirectorDetail, type DirectorOutboxEvent, type DirectorSession, type DirectorToolCall, type DirectorTransport as TransportId, type DirectorTurn, type DirectorTurnStatus, type Run, type Session, THREAD_SPAWNERS } from '@oasis-code/contract'
import type { AppState } from '../api/state.ts'
import * as repo from '../db/repo.ts'
import { getRunMeta } from '../db/collab_repo.ts'
import { collabOfRun, collabOfRuns } from '../agent/collab.ts'
import { isChatGptWeb, BRIDGE_TOKEN_FILE, BRIDGE_URL_FILE } from '../llm/chatgpt_web.ts'
import { keepAnswerImages, withAnswerImages, type KeptImage } from './answer_images.ts'
import { RunCancelled } from '../llm/model.ts'
import type { FetchLike } from '../llm/http.ts'
import { safeFetch } from '../safe_fetch.ts'
import { nowIso } from '../timebase.ts'
import { Harness } from './harness.ts'
import { EVENT_MAX_ATTEMPTS, runFinishedPayload, taskEventMessage, taskEventQuestion } from './outbox.ts'
import * as store from './store.ts'
import { surfaceOf } from './surfaces/index.ts'
import { BridgeTransport, bridgeAnswerTimeoutS } from './transports/bridge.ts'
import { NativeTransport } from './transports/native.ts'
import { TransportError, type DirectorTransport, type Rec, type TurnContext, type TurnOutcome } from './transports/types.ts'

export interface TurnEvent { seq: number; event: string; data: Rec; turn_id: string }

const SENTINEL = Symbol('end of the turn')
const BUSY_RETRIES = 12
const DEFAULT_PROBE_MS = 15_000
const DEFAULT_ANSWER_TIMEOUT_S = 1800
const TURN_TAIL = 50

class EventQueue {
  private readonly items: (TurnEvent | typeof SENTINEL)[] = []
  private waiter: ((item: TurnEvent | typeof SENTINEL) => void) | null = null
  private ended = false
  put(item: TurnEvent | typeof SENTINEL): void {
    if (this.ended) return
    if (item === SENTINEL) this.ended = true
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(item); return }
    this.items.push(item)
  }
  get(): Promise<TurnEvent | typeof SENTINEL> {
    if (this.items.length) return Promise.resolve(this.items.shift()!)
    return new Promise((resolve) => { this.waiter = resolve })
  }
}

interface LiveTurn {
  turn_id: string
  director_session_id: string
  text: string
  thinking: string
  tool_calls: DirectorToolCall[]
  events: TurnEvent[]
  queues: EventQueue[]
  abort: AbortController
  done: boolean
  timers: ReturnType<typeof setTimeout>[]
}

/** The harness refused (a state that does not allow the call), with the status the API answers. */

export class DirectorError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = 'DirectorError' }
}

export interface DirectorServiceOptions {
  /** what the transports reach the outside with (a test plays the bridge and the workspace agent) */
  fetchImpl?: FetchLike
  transports?: DirectorTransport[]
  /** where the desktop bridge's token is read from (default: <data dir>/bridge-token) */
  local_bridge_token?: () => string | null
  /** where the desktop app's bridge listens (default: the address it wrote in the data directory) */
  local_bridge_url?: () => string | null
  /** how often a session that needs a sign-in asks its bridge again */
  probe_interval_ms?: number
}

const sourceOf = (ds: DirectorSession): string => ({ native: 'oasis-code', bridge: 'chatgpt' })[ds.transport]
/** The requests a run was started for that its starter waits to hear the end of (a plan's node, a retry and a relay's
 *  turn are its group's: the group's own event tells of them). */
const ANNOUNCED_REQUESTS = new Set(['message', 'resume', 'separate', 'followup', 'wake', 'ui_task'])
type Rec2 = Record<string, unknown>
/** A run row with its collab as the API reads it (the projection of its session; a pre-v25 row's is projected). */
function withCollabOf(state: AppState, run: Run): Run {
  const collab = collabOfRun(state, run)
  return collab ? ({ ...run, collab } as Run) : run
}

/** A run row with the origin its own v25 record holds (cheap: one row; nothing projected) — a pre-v25 row as it is. */
function withRecordedOrigin(conn: AppState['conn'], run: Run): Run {
  if ((run as unknown as Rec2).collab) return run
  const meta = getRunMeta(conn, run.id)
  return meta?.origin ? ({ ...run, collab: { origin: meta.origin, basis: 'recorded' } } as unknown as Run) : run
}

/** A run's recorded origin (schema v25: run.collab.origin), or null on a run written before it. */
function originOf(run: Run): Rec2 | null {
  const collab = (run as unknown as Rec2).collab
  // only a v25 row's own record (basis recorded): a projected origin of an older row is a reading, not what it was
  // started for — that row keeps the rule it was written under
  if (!collab || typeof collab !== 'object' || ((collab as Rec2).basis !== undefined && (collab as Rec2).basis !== 'recorded')) return null
  const origin = (collab as Rec2).origin
  return origin && typeof origin === 'object' ? (origin as Rec2) : null
}

/** Whether a run's end is a task event. A run with a recorded origin: when it was asked for explicitly (a message, a
 *  follow-up — of a group's participant too, which now runs as a step of its interaction —, a separate task, a wake, a
 *  UI task), never a plan's node, a retry or a relay's turn (its group's own event tells of those, once). A run from
 *  before origins: a thread run, whoever started it — a child run is its parent's, an interaction's node the
 *  interaction's. */
export function announcesRun(run: Run): boolean {
  const origin = originOf(run)
  if (origin && typeof origin.request === 'string') return ANNOUNCED_REQUESTS.has(origin.request)
  return run.parent_run_id === null && run.interaction_id === null && (THREAD_SPAWNERS as readonly string[]).includes(run.spawned_by)
}
/** The line an interaction turn's note shows as its question: the harness's first line (what it asked). */
const interactionQuestion = (input: string): string => input.split('\n').find((line) => line.trim()) ?? input
// every error text a turn, its events or the session keep, masked: a provider's refusal may quote the key
const describe = (error: unknown): string => redactSecrets(error instanceof Error ? error.message : String(error))
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new RunCancelled()); return }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
  const onAbort = () => { clearTimeout(timer); reject(new RunCancelled()) }
  signal.addEventListener('abort', onAbort, { once: true })
})

export class DirectorService {
  /** the harness's own API, in process: what the native director's tools call (attached once the app serves) */
  harness: Harness | null = null
  private readonly transports = new Map<TransportId, DirectorTransport>()
  private readonly chains = new Map<string, Promise<void>>()
  private readonly live = new Map<string, LiveTurn>()
  private readonly liveByDirector = new Map<string, string>()
  private readonly probes = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly probeMs: number
  private stopping = false
  /** called with every turn once it ended (done, error or cancelled): the interactions wait on their turns here */
  private readonly turn_hooks: ((turn: DirectorTurn) => void)[] = []

  constructor(readonly state: AppState, opts: DirectorServiceOptions = {}) {
    // a director's bridge_url may name a bridge elsewhere: its answers go through safeFetch like any other
    const fetchImpl = opts.fetchImpl ?? ((input, init) => safeFetch(input, init))
    const localBridgeToken = opts.local_bridge_token ?? (() => { try { return readFileSync(join(state.settings.data_dir, BRIDGE_TOKEN_FILE), 'utf8').trim() || null } catch { return null } })
    const localBridgeUrl = opts.local_bridge_url ?? (() => {
      try { return readFileSync(join(state.settings.data_dir, BRIDGE_URL_FILE), 'utf8').trim().replace(/\/+$/, '') || null } catch { return null }
    })
    const defaults: DirectorTransport[] = [new NativeTransport(state), new BridgeTransport({ fetchImpl, localBridgeToken, localBridgeUrl })]
    for (const t of [...defaults, ...(opts.transports ?? [])]) this.transports.set(t.id, t)
    this.probeMs = opts.probe_interval_ms ?? DEFAULT_PROBE_MS
  }

  private get conn() { return this.state.conn }

  /** The native director's tools call the harness's API in process; the app hands its fetch here once it exists. */
  attachHarness(fetchImpl: FetchLike): void {
    this.harness = Harness.connect('http://127.0.0.1', this.state.session_token, { fetchImpl })
  }

  /** The runner's end-of-run hook: every finished run of a directed session is a task event. The outbox work runs
   *  on its own tick, never inside the run's own finalization (a director's trouble is never a run's); a tick
   *  that comes after the app began stopping does nothing (the database may be closed). */
  attachHooks(): void {
    this.state.runs.onRunFinished((runId, receipt) => {
      setTimeout(() => { if (this.stopping) return; try { this.onRunFinished(runId, receipt) } catch (error) { console.warn(`director outbox: ${describe(error)}`) } }, 0)
    })
  }

  onTurnFinished(hook: (turn: DirectorTurn) => void): void {
    this.turn_hooks.push(hook)
  }

  private turnEnded(turnId: string): void {
    const turn = store.getTurn(this.conn, turnId)
    if (!turn) return
    for (const hook of this.turn_hooks) {
      try { hook(turn) } catch (error) { console.warn(`a director turn hook failed for ${turnId}: ${describe(error)}`) }
    }
  }

  transport(id: TransportId): DirectorTransport {
    const t = this.transports.get(id)
    if (!t) throw new DirectorError(`unknown director transport: ${id}`)
    return t
  }

  // -- the session -------------------------------------------------------------

  open(session: Session, body: { transport: TransportId; model?: string | null; label?: string | null; config: Rec }): DirectorSession {
    if (store.openDirectorSessionOf(this.conn, session.id)) throw new DirectorError('this session already has a director; close it before opening another', 409)
    const transport = this.transport(body.transport)
    const readiness = transport.readiness()
    if (!readiness.ready) throw new DirectorError(readiness.hint ?? `the ${body.transport} transport is not ready`, 409)
    // the surface and the reach are the harness's: a new director session holds the current surface, reaches only its
    // own session, and a client sets neither
    for (const key of store.DIRECTOR_HELD_CONFIG_KEYS) if ((body.config ?? {})[key] !== undefined) throw new DirectorError(`${key} is kept by the harness: a director session opens on the current tool surface and reaches its own session`, 409)
    let normalized
    try { normalized = transport.normalizeConfig(body.config, body.model ?? null) } catch (error) { if (error instanceof TransportError) throw new DirectorError(error.message, error.status); throw error }
    const config = { ...normalized.config, tool_surface: CURRENT_DIRECTOR_TOOL_SURFACE }
    const ds = store.insertDirectorSession(this.conn, { session_id: session.id, transport: body.transport, model: normalized.model, label: body.label?.trim() || normalized.label, config })
    this.settle(ds.id)
    return store.getDirectorSession(this.conn, ds.id)!
  }

  /** Default composer routing: never silently reopen a closed director or resume a paused one. */
  ensure(session: Session): DirectorSession {
    const open = this.openOf(session.id)
    if (open) {
      if (open.state === 'paused') throw new DirectorError('the director is paused; resume it or send directly to an agent', 409)
      return open
    }
    if (store.hasClosedDirector(this.conn, session.id)) throw new DirectorError('the director was closed; reopen it or send directly to an agent', 409)
    const model = isChatGptWeb(session.model) ? this.state.config.default_model : session.model
    if (!model || isChatGptWeb(model)) throw new DirectorError('no native default model is available for this web session', 409)
    return this.open(session, { transport: 'native', model, config: {} })
  }

  /** The open director session of an oasis-code session, or null. */
  openOf(sessionId: string): DirectorSession | null {
    return store.openDirectorSessionOf(this.conn, sessionId)
  }

  requireOpen(sessionId: string): DirectorSession {
    const ds = store.openDirectorSessionOf(this.conn, sessionId)
    if (!ds) throw new DirectorError('this session has no director: open one first', 404)
    return ds
  }

  detail(sessionId: string): DirectorDetail {
    const transports = [...this.transports.values()].map((t) => ({ id: t.id, label: t.label, ...t.readiness() }))
    const ds = store.openDirectorSessionOf(this.conn, sessionId)
    if (!ds) return { session_id: sessionId, director: null, turns: [], pending_events: [], live: null, transports }
    const liveId = this.liveByDirector.get(ds.id)
    const live = liveId ? this.live.get(liveId) : undefined
    return {
      session_id: sessionId, director: ds, turns: store.listTurns(this.conn, ds.id, { tail: TURN_TAIL }),
      pending_events: store.listEvents(this.conn, ds.id).filter((e) => e.status === 'pending' || e.status === 'delivering' || e.status === 'failed'),
      live: live && !live.done ? { turn_id: live.turn_id, text: live.text, thinking: live.thinking, tool_calls: [...live.tool_calls] } : null, transports,
    }
  }

  update(sessionId: string, body: { paused?: boolean | null; model?: string | null; label?: string | null; config?: Rec | null }): DirectorSession {
    const ds = this.requireOpen(sessionId)
    const patch: Parameters<typeof store.updateDirectorSession>[2] = {}
    // the surface a conversation holds and the sessions it reaches are the harness's: an edit that would change either
    // is refused (the same value sent back is no change); every other key edits as before
    for (const key of store.DIRECTOR_HELD_CONFIG_KEYS) {
      if (!body.config || !(key in body.config)) continue
      if (JSON.stringify(body.config[key] ?? null) !== JSON.stringify(ds.config[key] ?? null)) throw new DirectorError(`${key} is kept by the harness: a director session keeps the tool surface it opened on, and reaches the sessions it created itself`, 409)
    }
    if ((body.model !== undefined && body.model !== null) || (body.config !== undefined && body.config !== null) || (body.label !== undefined && body.label !== null)) {
      const merged: Rec = { ...ds.config }
      for (const [k, v] of Object.entries(body.config ?? {})) { if ((store.DIRECTOR_HELD_CONFIG_KEYS as readonly string[]).includes(k)) continue; if (v === null) delete merged[k]; else merged[k] = v }
      let normalized
      try { normalized = this.transport(ds.transport).normalizeConfig(merged, body.model ?? ds.model) } catch (error) { if (error instanceof TransportError) throw new DirectorError(error.message, error.status); throw error }
      // whatever a transport keeps of a config, the harness's own keys stay as they were (a session from before
      // surfaces keeps none: it stays on v1)
      const held = Object.fromEntries(store.DIRECTOR_HELD_CONFIG_KEYS.filter((k) => ds.config[k] !== undefined).map((k) => [k, ds.config[k]]))
      const normalizedConfig: Rec = { ...normalized.config }
      for (const key of store.DIRECTOR_HELD_CONFIG_KEYS) delete normalizedConfig[key]
      patch.config = { ...normalizedConfig, ...held }
      patch.model = normalized.model
      if (body.label !== undefined && body.label !== null) patch.label = body.label.trim() || normalized.label
      else if (body.model && body.model !== ds.model) patch.label = normalized.label
    }
    if (body.paused === true && ds.state !== 'paused') {
      // a turn with the director now finishes; nothing new starts until the resume
      patch.state = 'paused'
      this.clearProbe(ds.id)
    } else if (body.paused === false && ds.state === 'paused') patch.state = ds.current_turn_id ? 'generating' : 'idle'
    const updated = store.updateDirectorSession(this.conn, ds.id, patch)
    if (body.paused === false) this.kick(ds.id)
    return updated
  }

  close(sessionId: string): DirectorSession {
    const ds = this.requireOpen(sessionId)
    this.clearProbe(ds.id)
    const liveId = this.liveByDirector.get(ds.id)
    const live = liveId ? this.live.get(liveId) : undefined
    if (live && !live.done) live.abort.abort(new RunCancelled('the director session was closed'))
    for (const t of store.listTurns(this.conn, ds.id)) {
      if (t.status === 'queued' || t.status === 'awaiting_answer') {
        store.updateTurn(this.conn, t.id, { status: 'cancelled', finished_at: nowIso(), error: 'the director session was closed' })
        this.finishLive(t.id, { status: 'cancelled', output: '', error: 'the director session was closed', note_id: null })
        this.turnEnded(t.id)
      }
    }
    const pending = store.listEvents(this.conn, ds.id).filter((e) => e.status === 'pending' || e.status === 'delivering').map((e) => e.id)
    store.markEvents(this.conn, pending, { status: 'dropped', error: 'the director session was closed' })
    return store.updateDirectorSession(this.conn, ds.id, { state: 'closed', closed_at: nowIso(), current_turn_id: null })
  }

  // -- turns ---------------------------------------------------------------------

  /** The person's message to the director: a turn, queued; it starts as soon as the director is free. */
  say(sessionId: string, message: string | DirectorSayBody): DirectorTurn {
    const envelope = DirectorSayBodySchema.parse(typeof message === 'string' ? { text: message } : message)
    if (envelope.client_request_id) {
      const prior = store.turnForClientRequest(this.conn, sessionId, envelope.client_request_id)
      if (prior) return prior
    }
    const ds = this.requireOpen(sessionId)
    if (!envelope.text.trim() && !envelope.attachments.length) throw new DirectorError('text or attachments are required')
    const turn = store.insertTurn(this.conn, { director_session_id: ds.id, session_id: sessionId, kind: 'user', input: envelope.text, envelope, model: ds.model })
    this.kick(ds.id)
    return turn
  }

  turn(turnId: string): DirectorTurn | null { return store.getTurn(this.conn, turnId) }

  /** The harness's own question to the director about an interaction of the session (a plan asked, what comes
   *  next): a turn, queued; it starts as soon as the director is free. */
  ask(sessionId: string, input: string): DirectorTurn {
    const ds = this.requireOpen(sessionId)
    const turn = store.insertTurn(this.conn, { director_session_id: ds.id, session_id: sessionId, kind: 'interaction', input, model: ds.model })
    this.kick(ds.id)
    return turn
  }

  cancelTurn(turnId: string): DirectorTurn {
    const turn = store.getTurn(this.conn, turnId)
    if (!turn) throw new DirectorError(`director turn not found: ${turnId}`, 404)
    const ds = store.getDirectorSession(this.conn, turn.director_session_id)!
    const live = this.live.get(turnId)
    if (live && !live.done && turn.status === 'generating') {
      live.abort.abort(new RunCancelled())
      return store.getTurn(this.conn, turnId)!
    }
    if (turn.status === 'queued' || turn.status === 'awaiting_answer' || turn.status === 'generating') {
      this.fail(ds, turn, new RunCancelled('cancelled by the person'), 'cancelled')
      this.kick(ds.id)
    }
    return store.getTurn(this.conn, turnId)!
  }

  /** A turn's stream: its events so far, then the live ones until it ends (a turn no longer live yields its end). */
  async *subscribe(turnId: string, opts: { after_seq?: number; signal?: AbortSignal } = {}): AsyncGenerator<TurnEvent, void, undefined> {
    const afterSeq = opts.after_seq ?? -1
    const live = this.live.get(turnId)
    if (!live) {
      const turn = store.getTurn(this.conn, turnId)
      if (!turn) return
      const events: TurnEvent[] = [{ seq: 0, event: 'turn_started', data: { kind: turn.kind, input: turn.input, model: turn.model }, turn_id: turnId }]
      if (turn.output) events.push({ seq: 1, event: 'text_delta', data: { text: turn.output, start: true }, turn_id: turnId })
      if (!(ACTIVE_DIRECTOR_TURN_STATUSES as readonly string[]).includes(turn.status)) {
        events.push({ seq: events.length, event: 'turn_finished', data: { status: turn.status, output: turn.output, error: turn.error, note_id: turn.note_id }, turn_id: turnId })
      }
      for (const e of events) if (e.seq > afterSeq) yield e
      return
    }
    const queue = new EventQueue()
    live.queues.push(queue)
    const stop = () => queue.put(SENTINEL)
    opts.signal?.addEventListener('abort', stop, { once: true })
    try {
      if (opts.signal?.aborted) return
      const replayed = [...live.events]
      const doneAtSnapshot = live.done
      for (const e of replayed) if (e.seq > afterSeq) yield e
      if (doneAtSnapshot) return
      for (;;) {
        const item = await queue.get()
        if (item === SENTINEL) return
        if (item.seq < replayed.length) continue
        yield item
      }
    } finally {
      opts.signal?.removeEventListener('abort', stop)
      const at = live.queues.indexOf(queue)
      if (at >= 0) live.queues.splice(at, 1)
    }
  }

  // -- the outbox ----------------------------------------------------------------

  /** One status event for a routed interaction, never one wake per node. The payload is an execution index,
   *  not a model-authored conclusion. Deduplication survives restart and repeated finish hooks. */
  interactionFinished(interactionId: string): void {
    const ix = repo.getInteraction(this.conn, interactionId)
    if (!ix?.source_turn_id || !['done', 'waiting', 'error', 'cancelled', 'interrupted'].includes(ix.status)) return
    const cause = store.getTurn(this.conn, ix.source_turn_id)
    const ds = cause ? store.getDirectorSession(this.conn, cause.director_session_id) : null
    if (!ds || ds.state === 'closed') return
    const nodes = repo.listNodes(this.conn, ix.id).map((node) => {
      const run = node.run_id ? repo.getRun(this.conn, node.run_id) : null
      const ws = node.workspace_id ? repo.getWorkspace(this.conn, node.workspace_id) : null
      const participant = ix.participants.find((p) => p.id === node.participant)
      return { ...node, model: participant?.model, thinking: participant?.thinking ?? repo.interactionInputs(this.conn, ix.id).thinking,
        source_mount: ws?.source_mount ?? null, usage: run?.usage ?? null,
        answer_ref: run ? { run_id: run.id, tool: 'get_run', endpoint: `/api/runs/${run.id}`, field: 'receipt.final_text' } : null }
    })
    const event = store.enqueueEvent(this.conn, { director_session_id: ds.id, session_id: ix.session_id,
      kind: 'interaction_finished', ref_id: ix.id, cause_turn_id: ix.source_turn_id,
      dedupe_key: `interaction_finished:${ix.id}:${ix.revision}:${ix.runs_started}:${ix.status}`,
      payload: { interaction_id: ix.id, status: ix.status, reason: ix.reason, workspace_policy: ix.workspace_policy,
        participants: ix.participants, nodes, selection: 'Results remain independent; no output is automatically adopted.' },
    })
    if (event.fresh) this.kick(ds.id)
  }

  /** A run of a directed session ended: a task event, delivered by the next turn (once, whoever else read it). A
   *  native director is woken only by the runs it started; a run the person ran directly rides with its next turn. */
  onRunFinished(runId: string, receipt: Rec): void {
    const row = repo.getRun(this.conn, runId)
    // the row as the API answers it: with its collab (participant, origin) — what tells whose request it was
    const run = row ? withCollabOf(this.state, row) : null
    if (!run || !this.announces(run)) return
    for (const ds of this.directorsOf(run)) {
      if (this.enqueueRunFinished(ds, run, receipt)) this.kick(ds.id)
      else this.settle(ds.id)
    }
  }

  /** The open director sessions a run's end is told to: the one its origin names (a director turn started it, in
   *  its own session or in one it created); else the session's own director, and a director that created the session
   *  and dispatched the run. */
  private directorsOf(run: Run): DirectorSession[] {
    const origin = originOf(run)
    const named = typeof origin?.director_session_id === 'string' ? store.getDirectorSession(this.conn, origin.director_session_id) : null
    if (named && named.state !== 'closed') return [named]
    const own = store.openDirectorSessionOf(this.conn, run.session_id)
    const creators = store.directorsReaching(this.conn, run.session_id).filter((ds) => ds.session_id !== run.session_id && store.turnThatDispatched(this.conn, ds.id, run.id) !== null)
    return [...(own ? [own] : []), ...creators]
  }

  /** Whether a run's end is a task event. A run with a recorded origin: when it was asked for explicitly (a message,
   *  a follow-up — of a group's participant too —, a separate task, a wake, a UI task), never a plan's node, retry or
   *  relay turn (its group tells of those once). A run from before origins: a thread run of the conversation, whoever
   *  started it there — a child run is its parent's, and a node of an interaction is the interaction's. */
  private announces(run: Run): boolean {
    return announcesRun(run)
  }

  /** The turn that started a run: its recorded origin when that names this director session, else the turn whose
   *  tool call returned it. */
  private causeOf(ds: DirectorSession, run: Run): DirectorTurn | null {
    const origin = originOf(run)
    if (origin && origin.director_session_id === ds.id && typeof origin.director_turn_id === 'string') {
      const turn = store.getTurn(this.conn, origin.director_turn_id)
      if (turn && turn.director_session_id === ds.id) return turn
    }
    return store.turnThatDispatched(this.conn, ds.id, run.id)
  }

  private enqueueRunFinished(ds: DirectorSession, run: Run, receipt: Rec): boolean {
    const cause = this.causeOf(ds, run)
    return store.enqueueEvent(this.conn, {
      director_session_id: ds.id, session_id: run.session_id, kind: 'run_finished', ref_id: run.id, dedupe_key: `run_finished:${run.id}`,
      cause_turn_id: cause?.id ?? null, payload: runFinishedPayload(run, receipt),
    }).fresh
  }

  /** The ends no hook announced: the hook lives in memory, so a run that ended while the process died (or that a
   *  restart found cut off) has a final row and no event. Every run of the session that ended since the director
   *  opened gets its event now; one already there is kept as it is. */
  private sweepFinishedRuns(ds: DirectorSession): void {
    for (const ix of repo.listInteractions(this.conn, ds.session_id)) this.interactionFinished(ix.id)
    for (const sessionId of [ds.session_id, ...store.authorizedSessionsOf(ds)]) {
      const collab = collabOfRuns(this.state, sessionId)
      for (const row of repo.listRuns(this.conn, sessionId)) {
        const run = { ...row, collab: collab.get(row.id) ?? null } as Run
        if (run.created_at < ds.created_at || (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status) || !this.announces(run)) continue
        if (!this.directorsOf(run).some((d) => d.id === ds.id)) continue
        this.enqueueRunFinished(ds, run, repo.getRunReceipt(this.conn, run.id) ?? {})
      }
    }
  }

  /** The director read a run's receipt itself (get_run / wait_for_run through the connector): the pending event
   *  about that run is delivered — no turn repeats what it already knows. Returns whether one was. */
  acknowledgeRun(runId: string, directorSessionId?: string | null): boolean {
    const row = repo.getRun(this.conn, runId)
    if (!row) return false
    const run = withRecordedOrigin(this.conn, row)
    // the director that read it, when the call said which (x-oasis-director-session-id, checked by the API) — a run
    // of a session it created is told to it, not to that session's own director
    const named = directorSessionId ? store.getDirectorSession(this.conn, directorSessionId) : null
    const ds = named && named.state !== 'closed' ? named : store.openDirectorSessionOf(this.conn, run.session_id)
    if (!ds) return false
    const pending = store.pendingEvents(this.conn, ds.id).filter((e) => e.kind === 'run_finished' && e.ref_id === runId)
    if (!pending.length) return false
    store.markEvents(this.conn, pending.map((e) => e.id), { status: 'delivered', delivered_turn_id: ds.current_turn_id, delivered: true, error: 'read by the director itself' })
    this.settle(ds.id)
    return true
  }

  // -- lifecycle ------------------------------------------------------------------

  /** What a restart finds: a turn that was with a model is marked interrupted (its events go back to the outbox), an
   *  answer still expected from outside keeps waiting with its timers re-armed, every open session is driven. */
  async reconcile(): Promise<{ interrupted: string[]; resumed: string[] }> {
    const interrupted: string[] = []
    const resumed: string[] = []
    for (const turn of store.listUnfinishedTurns(this.conn)) {
      const ds = store.getDirectorSession(this.conn, turn.director_session_id)
      if (!ds || ds.state === 'closed') { store.updateTurn(this.conn, turn.id, { status: 'cancelled', finished_at: nowIso(), error: 'the director session is closed' }); this.turnEnded(turn.id); continue }
      if (turn.status === 'generating' && ds.transport === 'bridge') {
        // the harness stopped while the turn went to the bridge: it goes again under its own id, and the bridge answers
        // it as it did (sent before, not sent, or not known to have gone) — never as a second message
        store.updateTurn(this.conn, turn.id, { status: 'queued', started_at: null })
        resumed.push(turn.id)
      } else if (turn.status === 'generating') {
        this.fail(ds, turn, new Error('interrupted: the harness restarted while the director was answering'), 'error')
        interrupted.push(turn.id)
      } else if (turn.status === 'awaiting_answer') {
        this.armPending(ds, turn)
        resumed.push(turn.id)
      }
    }
    for (const ds of store.listOpenDirectorSessions(this.conn)) {
      // an event left delivering with no turn working on it: delivered, when a finished turn answered it (a restart
      // between the answer and its acknowledgement, from before the two were one write); otherwise back to the outbox
      const turns = store.listTurns(this.conn, ds.id)
      for (const event of store.listEvents(this.conn, ds.id).filter((e) => e.status === 'delivering')) {
        const holders = turns.filter((t) => t.event_ids.includes(event.id))
        const answered = holders.filter((t) => t.status === 'done').at(-1)
        if (answered !== undefined) store.markEvents(this.conn, [event.id], { status: 'delivered', delivered_turn_id: answered.id, delivered: true, error: null })
        else if (!holders.some((t) => t.status === 'queued' || t.status === 'generating' || t.status === 'awaiting_answer')) store.markEvents(this.conn, [event.id], { status: 'pending' })
      }
      this.sweepFinishedRuns(ds)
      if (ds.state === 'needs_login') this.scheduleProbe(ds.id)
      this.kick(ds.id)
    }
    return { interrupted, resumed }
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    for (const timer of this.probes.values()) clearTimeout(timer)
    this.probes.clear()
    for (const live of [...this.live.values()]) {
      for (const timer of live.timers) clearTimeout(timer)
      live.timers = []
      if (!live.done) {
        const turn = store.getTurn(this.conn, live.turn_id)
        const ds = turn ? store.getDirectorSession(this.conn, turn.director_session_id) : null
        if (turn && ds && turn.status === 'generating') {
          live.abort.abort(new RunCancelled('the harness is shutting down'))
          // a message going to the bridge may reach ChatGPT whatever happens here: the turn is left for the next start
          // (reconcile asks the bridge again under its own id), never failed into a second message under another turn
          if (ds.transport !== 'bridge') this.fail(ds, turn, new Error('the harness shut down while the director was answering'), 'error')
        }
      }
    }
    await Promise.allSettled([...this.chains.values()])
    const native = this.transports.get('native') as NativeTransport | undefined
    await native?.close?.()
  }

  // -- the drive loop --------------------------------------------------------------

  /** One drive per director session at a time: the next kick after a running one runs when it ends. */
  kick(directorSessionId: string): void {
    if (this.stopping) return
    const previous = this.chains.get(directorSessionId) ?? Promise.resolve()
    const next = previous.then(() => this.drive(directorSessionId)).catch((error) => console.warn(`director ${directorSessionId}: ${describe(error)}`))
    this.chains.set(directorSessionId, next)
  }

  private async drive(directorSessionId: string): Promise<void> {
    for (;;) {
      if (this.stopping) return
      const ds = store.getDirectorSession(this.conn, directorSessionId)
      if (!ds || ds.state === 'closed' || ds.state === 'paused' || ds.state === 'needs_login') return
      if (ds.current_turn_id) {
        const current = store.getTurn(this.conn, ds.current_turn_id)
        if (current && (ACTIVE_DIRECTOR_TURN_STATUSES as readonly string[]).includes(current.status)) return
        store.updateDirectorSession(this.conn, ds.id, { current_turn_id: null })
      }
      let turn = store.nextQueuedTurn(this.conn, ds.id)
      const pending = store.pendingEvents(this.conn, ds.id)
      if (!turn) {
        if (pending.some((e) => !this.besideTurn(ds, e))) {
          turn = store.insertTurn(this.conn, { director_session_id: ds.id, session_id: ds.session_id, kind: 'task_event', input: taskEventMessage(ds.session_id, pending, surfaceOf(ds)), event_ids: pending.map((e) => e.id), model: ds.model })
        }
      } else if (!turn.event_ids.length) {
        // the runs the person ran directly meanwhile go with the director's next turn, whatever it is
        const beside = pending.filter((e) => this.besideTurn(ds, e))
        if (beside.length) turn = store.updateTurn(this.conn, turn.id, { event_ids: beside.map((e) => e.id) })
      }
      if (!turn) { this.settle(ds.id); return }
      await this.runTurn(store.getDirectorSession(this.conn, ds.id)!, turn)
    }
  }

  private async runTurn(ds: DirectorSession, turn: DirectorTurn): Promise<void> {
    const transport = this.transport(ds.transport)
    const session = repo.getSession(this.conn, ds.session_id)
    const project = session ? repo.getProject(this.conn, session.project_id) : null
    const live = this.openLive(ds, turn)
    store.updateTurn(this.conn, turn.id, { status: 'generating', started_at: nowIso(), model: ds.model, error: null })
    if (turn.event_ids.length) store.markEvents(this.conn, turn.event_ids, { status: 'delivering' })
    store.updateDirectorSession(this.conn, ds.id, { state: 'generating', current_turn_id: turn.id })
    this.emit(live, 'turn_started', { kind: turn.kind, input: turn.input, model: ds.model })
    // busy with this very message once: it may have gone, whatever comes after
    let mayHaveSent = false
    try {
      if (!session || !project) throw new DirectorError('the session is gone', 404)
      const ctx = this.contextOf(ds, turn, session, project, live)
      let outcome = await transport.send(ctx)
      // asked again a dozen times — and, while the transport says how long it may stay busy with this very message
      // (the bridge still sending it), for at least that long from when it first said so
      let askUntil = 0
      for (let attempt = 0; outcome.kind === 'busy'; attempt += 1) {
        if (outcome.retry_for_s && askUntil === 0) askUntil = performance.now() + outcome.retry_for_s * 1000
        if (attempt >= BUSY_RETRIES && performance.now() >= askUntil) break
        if (outcome.may_have_sent) mayHaveSent = true
        const wait = Math.max(1, outcome.retry_in_s ?? 5)
        this.emit(live, 'note', { text: `${outcome.reason}; trying again in ${wait} s` })
        await sleep(wait * 1000, live.abort.signal)
        outcome = await transport.send(ctx)
      }
      if (outcome.kind === 'busy') throw new TransportError(outcome.reason, 503, { may_have_sent: mayHaveSent || outcome.may_have_sent === true })
      // a turn that ended while its message went (cancelled, its session closed, the harness stopping) stays ended
      if (!this.stillGenerating(turn.id)) return
      if (outcome.kind === 'answered') { this.complete(ds, turn, outcome); return }
      if (outcome.kind === 'needs_login') { this.holdForLogin(ds, turn, live, outcome.reason); return }
      if (outcome.kind === 'lost') throw new TransportError(outcome.reason, 502, { may_have_sent: true })
      store.updateTurn(this.conn, turn.id, { status: 'awaiting_answer', external_ref: outcome.external_ref ?? null })
      if (outcome.external_ref) store.updateDirectorSession(this.conn, ds.id, { external_ref: outcome.external_ref })
      if (outcome.note) this.emit(live, 'note', { text: outcome.note })
      this.armPending(store.getDirectorSession(this.conn, ds.id)!, store.getTurn(this.conn, turn.id)!, live)
    } catch (error) {
      // the harness stopping while a message went to the bridge: the turn stays for the next start, which asks the
      // bridge again under the same id and has it answer as this send did
      if (this.stopping && ds.transport === 'bridge' && this.stillGenerating(turn.id)) { this.leaveForRestart(live); return }
      const cancelled = error instanceof RunCancelled || live.abort.signal.aborted
      this.fail(ds, turn, error, cancelled ? 'cancelled' : 'error', { redeliver: !(mayHaveSent || (error instanceof TransportError && error.may_have_sent)) })
    }
  }

  private stillGenerating(turnId: string): boolean {
    return store.getTurn(this.conn, turnId)?.status === 'generating'
  }

  /** A turn left as it is for the next start of the harness (reconcile): its stream ends here, without an end. */
  private leaveForRestart(live: LiveTurn): void {
    if (live.done) return
    this.emit(live, 'note', { text: 'the harness stopped while the message went to ChatGPT; it is asked for again under this turn when the harness starts' })
    live.done = true
    for (const timer of live.timers) clearTimeout(timer)
    live.timers = []
    for (const queue of live.queues) queue.put(SENTINEL)
  }

  private contextOf(ds: DirectorSession, turn: DirectorTurn, session: Session, project: NonNullable<ReturnType<typeof repo.getProject>>, live: LiveTurn): TurnContext {
    return {
      director: ds, turn, session, project, signal: live.abort.signal,
      emit: (event, data) => this.emit(live, event, data),
      dispatched: (runId) => {
        const fresh = store.getTurn(this.conn, turn.id)
        if (fresh && !fresh.dispatched_run_ids.includes(runId)) store.updateTurn(this.conn, turn.id, { dispatched_run_ids: [...fresh.dispatched_run_ids, runId] })
      },
    }
  }

  /** A turn whose answer comes from outside: the transport's poll (when it has one) until the answer or the
   *  deadline, whichever first; the answer may also land through answer(). */
  private armPending(ds: DirectorSession, turn: DirectorTurn, liveIn?: LiveTurn): void {
    const live = liveIn ?? this.openLive(ds, turn)
    // the harness stopping: the next start re-arms the wait (reconcile)
    if (this.stopping) { this.leaveForRestart(live); return }
    const transport = this.transport(ds.transport)
    const session = repo.getSession(this.conn, ds.session_id)
    const project = session ? repo.getProject(this.conn, session.project_id) : null
    if (!session || !project) { this.fail(ds, turn, new DirectorError('the session is gone', 404)); return }
    const ctx = this.contextOf(ds, turn, session, project, live)
    const timeoutS = ds.transport === 'bridge' ? bridgeAnswerTimeoutS(ds.config) : Number(ds.config.poll_timeout_s ?? ds.config.answer_timeout_s ?? DEFAULT_ANSWER_TIMEOUT_S)
    const startedAt = turn.started_at ? Date.parse(turn.started_at) : Date.now()
    const deadline = startedAt + Math.max(10, timeoutS) * 1000
    const remaining = Math.max(0, deadline - Date.now())
    live.timers.push(setTimeout(() => {
      if (live.done) return
      this.fail(ds, store.getTurn(this.conn, turn.id) ?? turn, new Error(`no answer from the director in ${Math.round(timeoutS)} s`))
      this.kick(ds.id)
    }, remaining))
    if (!transport.poll) return
    const intervalMs = Math.max(500, Number(ds.config.poll_interval_s ?? 3) * 1000)
    const tick = async () => {
      if (live.done || this.stopping) return
      try {
        const current = store.getDirectorSession(this.conn, ds.id)
        const outcome = current && current.state !== 'closed' ? await transport.poll!({ ...ctx, director: current }) : null
        if (live.done) return
        if (outcome && outcome.kind === 'answered') { this.complete(current!, store.getTurn(this.conn, turn.id)!, outcome); this.kick(ds.id); return }
        if (outcome && outcome.kind === 'lost') {
          // the message went: what it carried is not sent again, and the turn does not wait for its deadline
          this.emit(live, 'note', { text: outcome.reason })
          this.fail(current!, store.getTurn(this.conn, turn.id) ?? turn, new Error(outcome.reason), 'error', { redeliver: false })
          this.kick(ds.id)
          return
        }
      } catch (error) {
        this.emit(live, 'note', { text: `the bridge could not be read: ${describe(error)}` })
      }
      if (!live.done) live.timers.push(setTimeout(() => { void tick() }, intervalMs))
    }
    live.timers.push(setTimeout(() => { void tick() }, intervalMs))
  }

  private holdForLogin(ds: DirectorSession, turn: DirectorTurn, live: LiveTurn, said: string): void {
    const reason = redactSecrets(said)
    store.updateTurn(this.conn, turn.id, { status: 'queued', started_at: null })
    if (turn.event_ids.length) store.markEvents(this.conn, turn.event_ids, { status: 'pending' })
    store.updateDirectorSession(this.conn, ds.id, { state: 'needs_login', current_turn_id: null, last_error: reason })
    this.finishLive(turn.id, { status: 'queued', output: '', error: reason, note_id: null })
    this.scheduleProbe(ds.id)
  }

  private scheduleProbe(directorSessionId: string): void {
    this.clearProbe(directorSessionId)
    if (this.stopping) return
    this.probes.set(directorSessionId, setTimeout(() => {
      this.probes.delete(directorSessionId)
      void this.probe(directorSessionId)
    }, this.probeMs))
  }

  private clearProbe(directorSessionId: string): void {
    const timer = this.probes.get(directorSessionId)
    if (timer) clearTimeout(timer)
    this.probes.delete(directorSessionId)
  }

  private async probe(directorSessionId: string): Promise<void> {
    const ds = store.getDirectorSession(this.conn, directorSessionId)
    if (!ds || ds.state !== 'needs_login') return
    const transport = this.transport(ds.transport)
    let ready = true
    try { if (transport.probe) ready = (await transport.probe(ds)).ready } catch { ready = false }
    if (ready) {
      store.updateDirectorSession(this.conn, ds.id, { state: 'idle', last_error: null })
      this.kick(ds.id)
    } else this.scheduleProbe(ds.id)
  }

  // -- the end of a turn -------------------------------------------------------------

  private complete(ds: DirectorSession, turn: DirectorTurn, outcome: Extract<TurnOutcome, { kind: 'answered' }>, source?: string): DirectorTurn {
    const fresh = store.getTurn(this.conn, turn.id)
    if (!fresh || !(ACTIVE_DIRECTOR_TURN_STATUSES as readonly string[]).includes(fresh.status)) return fresh ?? turn
    const live = this.live.get(turn.id)
    const said = outcome.text.trim() || (live?.text.trim() ?? '') || '(the director answered nothing)'
    const text = withAnswerImages(said, this.keepImages(ds.session_id, outcome.images ?? []))
    const model = outcome.model || ds.model
    // the note names the director as the person knows it: the route's label for a native one, what the chat shows otherwise
    const shown = ds.transport === 'native' ? (ds.label || model) : (outcome.model || ds.label || ds.model)
    const events = fresh.event_ids.map((id) => store.getEvent(this.conn, id)).filter((e): e is NonNullable<typeof e> => e !== null)
    const question = fresh.kind === 'user' ? fresh.input : fresh.kind === 'interaction' ? interactionQuestion(fresh.input) : taskEventQuestion(events)
    const note = repo.insertDirectorNote(this.conn, ds.session_id, { source: source?.trim() || sourceOf(ds), model: shown, question, answer: text, turn_id: fresh.id })
    // the calls as they streamed, completed by the transport's own record of each (its arguments, what came back);
    // one streamed call is completed once, in order — two calls alike stay two
    const calls = live ? live.tool_calls.map((c) => ({ ...c })) : []
    const used = new Set<number>()
    for (const c of outcome.tool_calls ?? []) {
      const i = calls.findIndex((k, j) => !used.has(j) && (c.tool_call_id ? k.tool_call_id === c.tool_call_id : !k.tool_call_id && k.name === c.name))
      if (i >= 0) { used.add(i); calls[i] = { ...calls[i]!, ...c } } else calls.push(c)
    }
    // the turn's answer and the delivery of the events it answered are one fact: written together or not at all
    this.conn.transaction(() => {
      store.updateTurn(this.conn, fresh.id, { status: 'done', output: text, model, usage: outcome.usage ?? {}, tool_calls: calls, note_id: note.id, finished_at: nowIso(), external_ref: outcome.external_ref ?? fresh.external_ref, error: null })
      store.markEvents(this.conn, fresh.event_ids, { status: 'delivered', delivered_turn_id: fresh.id, delivered: true, error: null })
    })
    store.updateDirectorSession(this.conn, ds.id, { current_turn_id: null, last_error: null, ...(outcome.external_ref ? { external_ref: outcome.external_ref } : {}) })
    this.finishLive(fresh.id, { status: 'done', output: text, error: null, note_id: note.id })
    this.turnEnded(fresh.id)
    this.settle(ds.id)
    return store.getTurn(this.conn, fresh.id)!
  }

  /** The answer's pictures as the session's attachments. */
  private keepImages(sessionId: string, images: NonNullable<Extract<TurnOutcome, { kind: 'answered' }>['images']>): KeptImage[] {
    const session = repo.getSession(this.conn, sessionId)
    return session ? keepAnswerImages(this.state, session, images, 'director') : []
  }

  /** A turn that ended without its answer. Its events go back to the outbox for the next turn — unless the message
   *  may have reached the director (`redeliver: false`): then they are failed, shown to the person, never sent twice. */
  private fail(ds: DirectorSession, turn: DirectorTurn, error: unknown, status: DirectorTurnStatus = 'error', opts: { redeliver?: boolean } = {}): void {
    const fresh = store.getTurn(this.conn, turn.id)
    if (!fresh || fresh.status === 'done' || fresh.status === 'error' || fresh.status === 'cancelled') return
    const message = describe(error)
    const live = this.live.get(turn.id)
    store.updateTurn(this.conn, fresh.id, { status, error: message, finished_at: nowIso(), output: live?.text ?? fresh.output, tool_calls: live ? [...live.tool_calls] : fresh.tool_calls })
    if (fresh.event_ids.length) {
      const events = fresh.event_ids.map((id) => store.getEvent(this.conn, id)).filter((e): e is NonNullable<typeof e> => e !== null)
      if (opts.redeliver === false) {
        store.markEvents(this.conn, events.map((e) => e.id), { status: 'failed', bump_attempts: true, error: `${message} (the message may have reached the director: not sent again)` })
      } else {
        const retry = events.filter((e) => e.attempts + 1 < EVENT_MAX_ATTEMPTS).map((e) => e.id)
        const spent = events.filter((e) => e.attempts + 1 >= EVENT_MAX_ATTEMPTS).map((e) => e.id)
        store.markEvents(this.conn, retry, { status: 'pending', bump_attempts: true, error: message })
        store.markEvents(this.conn, spent, { status: 'failed', bump_attempts: true, error: `${message} (${EVENT_MAX_ATTEMPTS} attempts)` })
      }
    }
    const current = store.getDirectorSession(this.conn, ds.id)
    if (current && current.state !== 'closed') store.updateDirectorSession(this.conn, ds.id, { current_turn_id: current.current_turn_id === fresh.id ? null : current.current_turn_id, last_error: status === 'cancelled' ? null : message })
    this.finishLive(fresh.id, { status, output: live?.text ?? fresh.output, error: message, note_id: null })
    this.turnEnded(fresh.id)
    this.settle(ds.id)
  }

  /** An event that wakes no director by itself: a native director records every run it starts, so a run it did not
   *  start is the person's own. A bridge (ChatGPT) starts runs through the connector, unrecorded: all of them wake it. */
  private besideTurn(ds: DirectorSession, event: DirectorOutboxEvent): boolean {
    return ds.transport === 'native' && event.kind === 'run_finished' && event.cause_turn_id === null && !store.turnThatDispatched(this.conn, ds.id, event.ref_id)
  }

  /** The session's state when no turn is with the director: waiting for the runs it awaits while any is active — a
   *  native director the runs it started, another every run the person or it started — idle otherwise; a paused,
   *  closed or signed-out session keeps its state. */
  settle(directorSessionId: string): void {
    const ds = store.getDirectorSession(this.conn, directorSessionId)
    if (!ds || ds.state === 'closed' || ds.state === 'paused' || ds.state === 'needs_login') return
    if (ds.current_turn_id) {
      const current = store.getTurn(this.conn, ds.current_turn_id)
      if (current && (ACTIVE_DIRECTOR_TURN_STATUSES as readonly string[]).includes(current.status)) return
    }
    const awaited = (runId: string) => ds.transport !== 'native' || store.turnThatDispatched(this.conn, ds.id, runId) !== null
    const thread = (spawnedBy: string) => (THREAD_SPAWNERS as readonly string[]).includes(spawnedBy)
    // a run whose end will be told to this director: by its origin when recorded, by the thread rule before that
    const told = (run: Run | null, fallback: boolean) => {
      if (!run) return fallback
      const origin = originOf(run)
      if (origin && typeof origin.request === 'string') return ANNOUNCED_REQUESTS.has(origin.request) && this.directorsOf(run).some((d) => d.id === ds.id)
      return fallback
    }
    const sessions = [ds.session_id, ...store.authorizedSessionsOf(ds)]
    // a run's recorded origin read from its own v25 row (a row from before v25 has none: the thread rule)
    const withOrigin = (r: Run | null): Run | null => (r === null ? null : withRecordedOrigin(this.conn, r))
    const active = sessions.some((sid) => this.state.runs.activeRunsOfSession(sid).some((h) => told(withOrigin(repo.getRun(this.conn, h.run_id)), thread(h.spawned_by)) && awaited(h.run_id)))
      || sessions.some((sid) => repo.listRuns(this.conn, sid).some((r) => (ACTIVE_RUN_STATUSES as readonly string[]).includes(r.status) && told(withOrigin(r), r.parent_run_id === null && thread(r.spawned_by)) && awaited(r.id)))
    const next = active ? 'waiting_for_tasks' : 'idle'
    if (ds.state !== next || ds.current_turn_id) store.updateDirectorSession(this.conn, ds.id, { state: next, current_turn_id: null })
  }

  // -- the live turn ---------------------------------------------------------------------

  private openLive(ds: DirectorSession, turn: DirectorTurn): LiveTurn {
    const existing = this.live.get(turn.id)
    if (existing && !existing.done) return existing
    const live: LiveTurn = { turn_id: turn.id, director_session_id: ds.id, text: turn.output ?? '', thinking: '', tool_calls: [...turn.tool_calls], events: [], queues: [], abort: new AbortController(), done: false, timers: [] }
    this.live.set(turn.id, live)
    this.liveByDirector.set(ds.id, turn.id)
    return live
  }

  private emit(live: LiveTurn, event: string, data: Rec): void {
    if (live.done) return
    if (event === 'text_delta') live.text = (data.start === true ? '' : live.text) + String(data.text ?? '')
    if (event === 'thinking_delta') live.thinking = (data.start === true ? '' : live.thinking) + String(data.text ?? '')
    if (event === 'tool_call') live.tool_calls.push({ ...(typeof data.tool_call_id === 'string' ? { tool_call_id: data.tool_call_id } : {}), name: String(data.name ?? ''), summary: String(data.summary ?? ''), status: 'running', args: data.args && typeof data.args === 'object' ? (data.args as Rec) : null, outcome: '' })
    if (event === 'tool_result') {
      const open = [...live.tool_calls].reverse().find((c) => (data.tool_call_id ? c.tool_call_id === data.tool_call_id : c.name === data.name) && c.status === 'running')
      if (open) {
        open.status = String(data.status ?? 'ok')
        if (typeof data.call_summary === 'string') open.summary = data.call_summary
        if ('args' in data) open.args = data.args && typeof data.args === 'object' ? data.args as Rec : null
        // what came back: the transport's own account of it, else its summary line (the bridge's)
        if (typeof data.outcome === 'string') open.outcome = data.outcome
        else if (typeof data.summary === 'string') open.outcome = data.summary
      }
    }
    const item: TurnEvent = { seq: live.events.length, event, data, turn_id: live.turn_id }
    live.events.push(item)
    for (const queue of live.queues) queue.put(item)
  }

  private finishLive(turnId: string, data: { status: string; output: string; error: string | null; note_id: string | null }): void {
    const live = this.live.get(turnId)
    if (!live || live.done) return
    this.emit(live, 'turn_finished', data)
    live.done = true
    for (const timer of live.timers) clearTimeout(timer)
    live.timers = []
    for (const queue of live.queues) queue.put(SENTINEL)
    if (this.liveByDirector.get(live.director_session_id) === turnId) this.liveByDirector.delete(live.director_session_id)
    // the finished turn's events stay readable for a while (a page that reconnects after the end)
    setTimeout(() => { if (this.live.get(turnId) === live) this.live.delete(turnId) }, 60_000).unref?.()
  }
}
