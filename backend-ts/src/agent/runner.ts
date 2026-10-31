/** Run lifecycle: start, stream, persist, recover, cancel, finish. Adapted from oasis agent/runner.py (see NOTICE)
 *  and cut to this product: one agent per run, a session's thread runs continue each other's history (across
 *  providers through the handoff), a run under a work order works on its own worktree with a fresh conversation,
 *  events persisted with a monotonic seq, bounded transport / outage recovery that replays nothing, hard budgets the
 *  mechanism enforces (a closing turn with no tool), and a receipt at the end whose measured side never merges with
 *  the model's own words. */

import { aliasedAgentMentions, EVENT_VERSION, refNativeFor, steersFromEvents, type Budget, type Attachment, type Run, type Session, type SteerRecord, type SteerRefusal, type SteerSource, type SteerUndeliveredReason, type Workspace } from '@oasis-code/contract'
import { join } from 'node:path'
import { newId } from '../ids.ts'
import { SteerInbox, steerParts, undeliveredReason, withoutOpenTail, withTailParts, type SteeringPort } from './steering.ts'
import type { AppState } from '../api/state.ts'
import { LoginRequired, NativeAuthError, NativeAuthTemporaryError } from '../auth/errors.ts'
import { ModelConfig } from '../config.ts'
import * as repo from '../db/repo.ts'
import { bindUiTask } from '../db/repo.ts'
import { routesOf, findModel, routeEndpoint, routeKeyEnv, routeLimits } from '../llm/catalog.ts'
import { BridgeError, bridgeImagesOf, type ChatGptBridge, ChatGptWebError, isChatGptWeb, nextPiece, SEND_TIMEOUT_MS, STOP_TIMEOUT_MS } from '../llm/chatgpt_web.ts'
import { keepAnswerImages, withAnswerImages } from '../director/answer_images.ts'
import { attachmentPiece, AttachmentHydration, attachmentReader, checkAttachmentHistory, isRefPiece, type AttachmentPlacer } from '../llm/attachments.ts'
import { LegacyAttachmentPlacer } from '../workspace/legacy_attachment_placer.ts'
import { deniedRoots, refAccess } from '../llm/ref_files.ts'
import { handoffNote, portableHistory, type HandoffReport } from '../llm/handoff.ts'
import { APP_ORIGIN, isRequest, isResponse, isRetryPrompt, isToolCall, isToolReturn, loadValue, modelRequest, toolReturn, userPrompt, type ModelMessage, type PromptOrigin, type ToolCallPart, type UserContent, modelResponse, textPart, thinkingPart, isText, isUserPrompt, answerText } from '../llm/messages.ts'
import { CancellationToken, ModelAPIError, providerErrorText, providerQuotaExhausted, RunCancelled, TransportError, UnexpectedModelBehavior, UsageLimitExceeded, type Model, type ModelSettings, type UsageLimits } from '../llm/model.ts'
import { buildModel, CredentialUnavailable, providerSystem } from '../llm/providers.ts'
import { routeThinking } from '../llm/providers/common.ts'
import { QueueCancelled, Serialized } from '../llm/slots.ts'
import { UsageMeter } from '../llm/usage.ts'
import { budgetLines } from '../models.ts'
import { effectiveControl, effectiveLocks, proposalPromptNote } from '../policy/gate.ts'
import { describeLock } from '../policy/locks.ts'
import { networkGranted } from '../policy/permissions.ts'
import { inferMode, type AccessMode } from '@oasis-code/contract/modes'
import { directorToolSurfaceOf } from '@oasis-code/contract'
import { getDirectorSession } from '../director/store.ts'
import { currentRequestCap, effectiveAccess, outsideRequest, surfaceCap } from '../policy/access.ts'
import { clock, monotonic, nowIso } from '../timebase.ts'
import { mentionsNote, type ResolvedMention } from '../workspace/entities.ts'
import { namedToolsNote } from './named_tools.ts'
import { PathPolicy, pinnedRoot, type PolicyRoot } from '../workspace/paths.ts'
import { RemotePathPolicy } from '../workspace/remote_policy.ts'
import { RemoteRefused } from '../workspace/remote.ts'
import { remoteInstructions } from './remote_instructions.ts'
import { effectiveRoots, rootPolicyOptions } from '../workspace/roots.ts'
import { workspaceAttached, isDirect, LockViolation } from '../workspace/service.ts'
import { LockWaitCancelled, type CohortJoin, type LockWaiting } from '../workspace/locks.ts'
import { cohortKeyOf, cohortOfRun } from '../workspace/cohort.ts'
import { launcherOf } from '../execution/processes.ts'
import { markerOf, recordMarker, snapshotUnavailable, type AttributionMarker } from './attribution.ts'
import { buildAgent } from './agent.ts'
import { diagnose } from './diagnosis.ts'
import { redactSecrets } from '../llm/redact.ts'
import { isContextError, legacyFileCost, nativeRefCost, resolveWindow, type FileCost } from './context.ts'
import { makeDeps, type AgentDeps } from './deps.ts'
import { RunEventMapper } from './events.ts'
import { runEventsPage, SessionEventHub, sessionEvents, snapshotCursor, type MemoryRun, type SessionFrame } from './session_events.ts'
import { ContextKeeper, ContextOverflowUnrecovered, ContextView, historyMetrics, outputReserve, workingView, type ContextAnchor } from './history.ts'
import { INSTRUCTIONS } from './instructions.ts'
import { partialTextOf, RunHalted, stoppedAfter, type Agent, type AnswerEnd, type RequestSeam } from './loop.ts'
import { buildRunManifest, inputFingerprints, instructionDelta } from './manifest.ts'
import { mainHeadRun, resolveCollab, writeCollab, type CollabStart } from './collab.ts'
import * as crepo from '../db/collab_repo.ts'
import type { ToolSnapshot } from '../db/collab_repo.ts'
import type { CollabSurface, ParticipantRole, RunCollab } from '@oasis-code/contract'
import { projectInstructions, SETTINGS_SOURCE, type InstructionFile, discoverInstructions, instructionFingerprint } from './project_instructions.ts'
import { FOLDER_RULE_SHOWN } from './tools/common.ts'
import { toolSchemaRows, visibleToolNames } from './tools/registry.ts'
import { buildReceipt, checkCounts, dumpWorkOrder, lostReceipt, produced as producedOf, type WorkOrder } from './work_orders.ts'
import { settleRunTask } from './ui_tasks.ts'
import { PROMPT_TEXT, text } from '../prompt_texts.ts'

// events streamed live but not written (their text_block / thinking_block counterpart is)
export const TRANSIENT_EVENTS = new Set(['text_delta', 'thinking_delta', 'tool_call_progress'])
export const SEGMENT_REQUEST_LIMIT = 60

/** The settings every request of the run carries: the route's output cap, its cache TTL, the conversation's cache
 *  key (the session's: one value for every run of the thread) and, when the person chose one, the unified thinking
 *  level as the route takes it (`routeThinking`: "off" disables thinking; null leaves the provider's default alone).
 *  providerSearch: the requests may carry the provider's own web search. */
export function modelSettings(cfg: ModelConfig, thinking: string | null, cacheKey: string | null = null, providerSearch = false): ModelSettings {
  const out: ModelSettings = { max_tokens: cfg.max_tokens, cache_ttl: cfg.cache_ttl, cache_key: cacheKey }
  const sent = routeThinking(thinking, cfg.reasoning_efforts, providerSearch)
  if (sent !== null) out.thinking = sent === 'off' ? false : sent
  if (cfg.reasoning_mode) out.reasoning_mode = cfg.reasoning_mode
  return out
}

/** What a run's requests are routed by at a provider that keys its cache: the session, one value for all its runs —
 *  conversations branching from one base (a relay's participants) go to the machine that holds that base. */
export function cacheKeyOf(sessionId: string): string {
  return `oasis:session:${sessionId}`
}

export const TRANSPORT_RECOVERY_MAX = 3
export const TRANSPORT_BACKOFF_S = [2.0, 5.0, 15.0]
export const OUTAGE_RECOVERY_MAX = 4
/** How many times a run answers a provider's refusal of its context size by compacting before it gives up. */
export const CONTEXT_RECOVERY_MAX = 1
export const OUTAGE_BACKOFF_S = [10.0, 30.0, 60.0, 120.0]
/** The closing turn's message (`{limit}` is the line reached): no tool, the useful result and what stays unresolved. */
export const CLOSING_NOTE = PROMPT_TEXT['app.closing']
/** The return a call gets when the run ended before the call completed. */
export const DANGLING_NOTE = PROMPT_TEXT['app.interrupted_call']

const TRANSIENT_ERROR_NAMES = new Set(['ReadTimeout', 'ConnectTimeout', 'WriteTimeout', 'PoolTimeout', 'TimeoutException', 'ReadError', 'WriteError', 'ConnectError',
  'RemoteProtocolError', 'NetworkError', 'ProtocolError', 'APITimeoutError', 'APIConnectionError'])
const TRANSIENT_API_MESSAGE = /unexpected EOF|connection reset|broken pipe|incomplete chunked|invalid SSE|SSE data|stream (closed|ended|error)|overloaded|EOF while/i

function causes(error: unknown): unknown[] {
  const out: unknown[] = []
  let current = error
  let seen = 0
  while (current !== null && current !== undefined && seen < 8) {
    out.push(current)
    current = (current as { cause?: unknown }).cause
    seen += 1
  }
  return out
}

/** What the model is told after a broken stream whose words were kept (and how the joined answer is recognised). */
const CUT_OFF_NOTE = PROMPT_TEXT['app.cut_off']

export function transientTransportError(error: unknown): string | null {
  for (const e of causes(error)) {
    const name = (e as { name?: string })?.name ?? ''
    if (e instanceof TransportError || TRANSIENT_ERROR_NAMES.has(name)) return e instanceof TransportError ? e.kind : name
    if (e instanceof ModelAPIError) {
      const m = TRANSIENT_API_MESSAGE.exec(e.message)
      if (m) return `ModelAPIError(${m[0]})`
    }
  }
  return null
}

/** [status, message] for an HTTP status the model route answered with. */
export function providerStatusError(error: unknown): [number, string] | null {
  for (const e of causes(error)) {
    const status = (e as { status_code?: unknown }).status_code
    if (typeof status === 'number' && status >= 100 && status < 600) {
      const body = (e as { body?: unknown }).body
      // Classify the complete error envelope, not a display excerpt: the refusal can follow a long prefix.
      const message = body == null ? String((e as Error).message ?? e) : providerErrorText(body)
      return [status, message.trim()]
    }
  }
  return null
}

/** quota | rate_limit | auth | bad_request | context_overflow | outage | transport | cancelled | other */
export function classifyError(error: unknown): string {
  if (error instanceof RunCancelled || error instanceof QueueCancelled) return 'cancelled'
  if (error instanceof LoginRequired) return 'auth'
  if (error instanceof NativeAuthTemporaryError) return error.status_code ? 'outage' : 'transport'
  if (error instanceof NativeAuthError) return 'auth'
  if (error instanceof ContextOverflowUnrecovered) return 'context_overflow'
  const status = providerStatusError(error)
  if (status && providerQuotaExhausted(status[0], status[1])) return 'quota'
  // HTTP 200 SSE failures (notably Codex context_length_exceeded) have no error status. Reuse the
  // context markers before generic "stream error" recovery; an explicit HTTP auth/rate status still wins.
  if (!status && causes(error).some((e) => e instanceof ModelAPIError && isContextError(e))) return 'context_overflow'
  if (transientTransportError(error)) return 'transport'
  if (status) {
    const [code, message] = status
    if (code === 429) return 'rate_limit'
    if (code === 401 || code === 403) return 'auth'
    if (code === 400 || code === 413 || code === 422) {
      if (/context|too (long|many tokens)|maximum.*tokens|prompt is too long/i.test(message)) return 'context_overflow'
      return 'bad_request'
    }
    if (code >= 500) return 'outage'
  }
  if (error instanceof CredentialUnavailable) return 'auth'
  return 'other'
}

/** An answer's end, as the run's error says it. */
export function answerEndLine(end: AnswerEnd): string {
  switch (end.reason) {
    case 'length': return `the answer reached the output limit${end.attempts ? ` (after ${end.attempts} continuation${end.attempts > 1 ? 's' : ''})` : ''}; its words so far are kept`
    case 'no_final_output': return `the model gave no answer text${end.attempts ? ` (asked again ${end.attempts} time${end.attempts > 1 ? 's' : ''})` : ''}`
    case 'provider_error': return `the provider ended the answer with an error${end.attempts ? ` (asked again ${end.attempts} time${end.attempts > 1 ? 's' : ''})` : ''}`
    case 'content_filter': return 'the provider stopped the answer (a refusal or its content filter)'
  }
}

export function describeException(error: unknown): string {
  const parts: string[] = []
  for (const e of causes(error).slice(0, 6)) {
    const message = String((e as { message?: string })?.message ?? '').trim()
    const name = (e as { name?: string })?.name || (e as object)?.constructor?.name || 'Error'
    const text = message ? `${name}: ${message}` : name
    if (!parts.length || parts[parts.length - 1] !== text) parts.push(text)
    if (message) break
  }
  return parts.join(' <- ')
}

/** The run's answer: its last response's words — and when that response is the continuation of an answer a broken
 *  stream cut off (the kept words, then the harness's note, then the rest), the two halves as one answer. */
export function joinedAnswer(messages: ModelMessage[], output: string): string {
  // back from the last response, while the one before it was cut (no tool call) and the request between asked for
  // the rest: a broken stream's kept words, an answer cut at the output limit — each continuation joins its part
  const responses = messages.map((m, i) => [m, i] as const).filter(([m]) => isResponse(m))
  let joined = output
  for (let k = responses.length - 1; k >= 1; k -= 1) {
    const [cut, cutAt] = responses[k - 1]!
    const [, lastAt] = responses[k]!
    if (!isResponse(cut) || cut.parts.some(isToolCall) || lastAt !== cutAt + 2) break
    const note = messages[cutAt + 1]!
    const continuing = isRequest(note) && note.parts.some((p) => isUserPrompt(p) && typeof p.content === 'string' && p.content.includes(CUT_OFF_NOTE))
    if (!continuing) break
    joined = answerText(cut.parts) + joined
  }
  return joined
}

/** A run cancelled or crashed mid-tool leaves its last model response with tool calls nobody answered; a new user
 *  prompt on top of that is refused by the providers. Every unmatched call of the working view (what the model
 *  receives: a call before a compaction is summarized, not replayed) is answered with a plain note so the
 *  conversation can continue; complete histories pass untouched. */
export function closeDanglingToolCalls(messages: ModelMessage[], note: string | Record<string, unknown> = DANGLING_NOTE): ModelMessage[] {
  const view = workingView(messages)
  const answered = new Set<string>()
  for (const message of view) {
    if (isRequest(message)) for (const part of message.parts) if ((isToolReturn(part) || isRetryPrompt(part)) && part.tool_call_id) answered.add(part.tool_call_id)
  }
  const dangling: ToolCallPart[] = []
  for (const message of view) {
    if (isResponse(message)) for (const part of message.parts) if (isToolCall(part) && !answered.has(part.tool_call_id)) dangling.push(part)
  }
  if (!dangling.length) return messages
  return [...messages, modelRequest(dangling.map((p) => toolReturn(p.tool_name, note, p.tool_call_id)))]
}

/** cursor: the session cursor the event was written with (schema v26; none for a transient one, or one read back) */
export interface RunEvent { seq: number; event: string; data: Record<string, unknown>; v: number; run_id: string; cursor?: number | null }

const SENTINEL = Symbol('end of events')

/** A UI task the app's stop or restart cut off (queued, or its run lost). */
const INTERRUPTED_TASK = { code: 'interrupted', message: 'the app stopped before the task finished' }

/** A queue an async consumer awaits: put never blocks. */
/** How many events a subscriber may fall behind before it is let go: its client resubscribes after its cursor and
 *  the handle replays what it missed, instead of the queue growing without bound behind a stalled connection. */
export const SUBSCRIBER_BACKLOG = 5000

class EventQueue {
  private readonly items: (RunEvent | typeof SENTINEL)[] = []
  private waiter: ((item: RunEvent | typeof SENTINEL) => void) | null = null
  private ended = false

  put(item: RunEvent | typeof SENTINEL): void {
    if (this.ended) return
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(item); return }
    if (item !== SENTINEL && this.items.length >= SUBSCRIBER_BACKLOG) { this.items.length = 0; item = SENTINEL }
    this.items.push(item)
    if (item === SENTINEL) this.ended = true
  }

  get(): Promise<RunEvent | typeof SENTINEL> {
    if (this.items.length) return Promise.resolve(this.items.shift()!)
    return new Promise((resolve) => { this.waiter = resolve })
  }
}

export interface RunHandle {
  run_id: string
  session_id: string
  project_id: string
  workspace_id: string
  model_id: string
  token: CancellationToken
  events: RunEvent[]
  queues: EventQueue[]
  status: string
  done: boolean
  task: Promise<void> | null
  saved_seq: number
  closing: string | null
  budget_exceeded: string | null
  /** how the run's final answer ended, when it did not end normally (see loop.AnswerEnd) */
  answer_end: AnswerEnd | null
  deadline_timer: ReturnType<typeof setTimeout> | null
  notes: string[] | null
  final_text: string
  produced: { checkpoints: string[]; executions: string[]; checks: string[] }
  resumes_run_id: string | null
  user_text: string
  budget: Budget
  // a run under a work order carries the order it runs under (dispatched by the person or a director)
  cfg: ModelConfig | null
  spawned_by: string
  label: string | null
  work_order: WorkOrder | null
  blocked_calls: number
  lock_refusals: number
  lock_violations: number
  /** the run's usage meter while it runs (its budget lines read it); let go once the run's end is written — the record,
   *  usage and receipt are then the database's, and the meter would keep the run's whole model chain alive. Never
   *  closed here: its model wraps the route's shared provider, which other runs still use */
  meter: UsageMeter | null
  started_at: number
  // the @-mentions of the person's message, resolved and pinned at send (read-only pointers)
  mentions: ResolvedMention[]
  // the thinking level the person chose for the run (null = the provider's default; 'off' disables it)
  thinking: string | null
  // the level its requests are sent: the one chosen as the route takes it; null when none is sent
  thinking_sent: string | null
  // the relay turn this run is (null for a run of its own)
  relay: RelayTurn | null
  // the interaction node this run is (null for a run of its own)
  interaction: InteractionNodeRun | null
  // a watch of the conversation woke it: the message is the harness's, not the person's
  wake: boolean
  // the UI task this run does (bound to it in start, before the run executes anything); null for any other run
  ui_task: string | null
  finalizing: boolean
  /** the person's words sent while the run works (in-run steering): its intake and the queued ones */
  steer: SteerInbox
  /** schema v25: the run's participant and its role, where it is shown, the tool list its conversation holds, the
   *  opening message's handover lines (citations, packets) and what run_started tells of them */
  participant_id: string | null
  participant_role: ParticipantRole | null
  surface: CollabSurface
  tool_snapshot: ToolSnapshot | null
  collab_lines: string[]
  collab: RunCollab | null
  handover: CollabStart['handover'] | null
  /** whether the run holds its folder as its writer: null for a run that never takes it (ChatGPT on the web), false
   *  until a tool-running run is handed it (queued, or stopped in line: it ended without touching the folder) */
  workspace_taken: boolean | null
  /** what the run's measured changes may claim as its own (agent/attribution.ts), kept on its manifest from the moment
   *  it is let into its folder; null before then (or for a run that never takes it) */
  attribution: AttributionMarker | null
}

/** A run as one turn of a relay: which relay and which turn; the harness's preface before the person's request
 *  (the first turn), or the whole message being the harness's (a later turn: the record so far, the roles, the
 *  earlier agent's answer). */
export interface RelayTurn {
  id: string
  step: number
  note: string | null
  harness_message: boolean
}

/** A run as one node of an interaction: which interaction and which node; the harness's preface (the roster, the
 *  step's note) before the person's request, and whether the whole message is the harness's. */
export interface InteractionNodeRun {
  id: string
  node: string
  note: string | null
  harness_message: boolean
}

function newHandle(init: Pick<RunHandle, 'run_id' | 'session_id' | 'project_id' | 'workspace_id' | 'model_id'> & Partial<RunHandle>): RunHandle {
  return {
    token: new CancellationToken(), events: [], queues: [], status: 'running', done: false, task: null, saved_seq: 0, closing: null,
    budget_exceeded: null, answer_end: null, deadline_timer: null, notes: null, final_text: '', produced: { checkpoints: [], executions: [], checks: [] }, resumes_run_id: null,
    user_text: '', budget: {}, cfg: null, spawned_by: 'human', label: null, work_order: null, blocked_calls: 0, lock_refusals: 0,
    lock_violations: 0, meter: null, started_at: 0, mentions: [], thinking: null, thinking_sent: null, relay: null, interaction: null, wake: false, ui_task: null, finalizing: false, steer: new SteerInbox(),
    participant_id: null, participant_role: null, surface: 'thread', tool_snapshot: null, collab_lines: [], collab: null, handover: null, workspace_taken: null, attribution: null, ...init,
  }
}

export interface StartOptions {
  model_id?: string | null
  budget?: Budget | null
  resumes_run_id?: string | null
  fresh?: boolean
  spawned_by?: string
  label?: string | null
  work_order?: WorkOrder | null
  workspace_id?: string | null
  mentions?: ResolvedMention[] | null
  /** the images attached to the person's message, already checked against the session */
  attachments?: Attachment[] | null
  /** the chat's idempotency key (unique in the session) */
  client_request_id?: string | null
  thinking?: string | null
  /** the relay turn this run is */
  relay?: RelayTurn | null
  /** the interaction node this run is */
  interaction?: InteractionNodeRun | null
  /** leave the session's model as it is (a relay's turns run on their participants' models, not the session's) */
  keep_session_model?: boolean
  /** a watch of the conversation woke it (spawned_by 'wake'): the whole message is the harness's */
  wake?: boolean
  /** the queued UI task this run does: bound to the run (running, agent_run_id) before the run executes anything */
  ui_task?: string | null
  /** schema v25: who the run belongs to, why it started, where it is shown, what it is handed or refers to */
  collab?: CollabStart | null
  /** schema v28: a cap on the run's access beyond what its origin carries ('sandbox') */
  access_cap?: AccessMode | null
}

/** A keyed start whose key already made a run for another intent (another target, text, model, order, citation…):
 *  refused, never answered with that other run. */
export class KeyConflict extends Error {
  constructor(readonly key: string, readonly run_id: string) { super(`client_request_id ${key} was already used for another request (run ${run_id}); send this one with a new key`); this.name = 'KeyConflict' }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

export class RunManager {
  readonly agent: Agent<AgentDeps>
  readonly handles = new Map<string, RunHandle>()
  segment_request_limit = SEGMENT_REQUEST_LIMIT
  transport_backoff_s = TRANSPORT_BACKOFF_S
  outage_backoff_s = OUTAGE_BACKOFF_S
  readonly built_models = new Map<string, Model>()
  /** every event emitted, under its run's session: the session's one stream (session_events.ts) */
  readonly sessions = new SessionEventHub()
  /** The app is shutting down: a run stopped now was cut off, not stopped by the person (its UI task, its wait). */
  private stopping = false
  /** Called with every run's receipt once it has finished (the director's outbox listens here). */
  private readonly finish_hooks: ((runId: string, receipt: Record<string, unknown>) => void)[] = []

  constructor(readonly state: AppState) {
    this.agent = buildAgent()
  }

  private legacy_placer: LegacyAttachmentPlacer | null = null
  /** The app's one placer of legacy (`native-v1`) PDFs and videos a route does not take: a confined writer under the
   *  isolation runtime, fail closed (docs/large-file-attachments-security.md §4). Each run says a refusal itself (an
   *  `attachment_refused` event); the server log hears it once too. */
  get legacyPlacer(): LegacyAttachmentPlacer {
    const state = this.state
    return this.legacy_placer ??= new LegacyAttachmentPlacer({
      runtime: state.processes.runtime, enforcement: () => state.isolation.enforcement,
      data_dir: state.settings.data_dir, scratch_dir: state.settings.scratch_dir,
      on_refused: (file, path, reason) => console.warn(`legacy attachment ${JSON.stringify(file.name)} not placed at ${path}: ${reason}`),
    })
  }

  /** What a run's tools and its native files may and may not read of a local reference (the harness's own reads). */
  localAccess(projectId: string): { data_dir: string; deny_roots: string[] } {
    const state = this.state
    return { data_dir: state.settings.data_dir, deny_roots: deniedRoots({ data_dir: state.settings.data_dir, projects: repo.listProjects(state.conn), project_id: projectId }).map((d) => d.root) }
  }

  onRunFinished(hook: (runId: string, receipt: Record<string, unknown>) => void): void {
    this.finish_hooks.push(hook)
  }

  // -- lookups ------------------------------------------------------------------

  /** The session thread's own live run: the main agent's, or a relay's turn (both are the thread's) — a member's
   *  follow-up, an interaction's step or a separate task works beside it (schema v25: by the run's participant and
   *  placement, never by who started it); with `workspaceId`, any live run under no order on that workspace (one
   *  writer per workspace). */
  activeRunOfSession(sessionId: string, workspaceId: string | null = null): RunHandle | null {
    for (const handle of this.handles.values()) {
      if (handle.session_id !== sessionId || handle.done || handle.work_order !== null) continue
      if (workspaceId !== null ? handle.workspace_id === workspaceId : handle.surface === 'thread') return handle
    }
    return null
  }

  activeRunsOfSession(sessionId: string): RunHandle[] {
    return [...this.handles.values()].filter((h) => h.session_id === sessionId && !h.done)
  }

  knowsModel(modelId: string): boolean {
    return findModel(this.state.config, modelId) !== null || this.state.model_overrides.has(modelId)
  }

  knownModelIds(): string[] {
    return [...routesOf(this.state.config).map((m) => m.id), ...[...this.state.model_overrides.keys()].filter((m) => findModel(this.state.config, m) === null)]
  }

  configFor(model: string): ModelConfig {
    const cfg = findModel(this.state.config, model)
    if (cfg === null && !this.state.model_overrides.has(model)) throw new Error(`unknown model: ${model}`)
    return cfg ?? new ModelConfig({ id: model, label: model, provider: 'openai', model, window_source: 'test override' })
  }

  // -- start / cancel ---------------------------------------------------------------

  /** the starts under way by client key: a resend arriving while the first is still being made waits for it */
  private readonly starting = new Map<string, { promise: Promise<Run>; intent: string | null }>()

  /** A start under the client's key, once: the run the key already made in the session (a resend after a lost
   *  answer), the one being made now (a concurrent resend), or the one `make` starts — never a second run, a second
   *  worktree or a second model request for the same key. A key with a different payload gets the first's run. */
  async startOnce(sessionId: string, key: string | null | undefined, make: () => Promise<Run>, intent: string | null = null): Promise<Run> {
    if (!key) return make()
    const earlier = repo.runForClientRequest(this.state.conn, sessionId, key)
    if (earlier !== null) { this.checkIntent(key, earlier.id, intent); return earlier }
    this.checkKeyFree(sessionId, key)
    const slot = `${sessionId}\u0000${key}`
    const pending = this.starting.get(slot)
    if (pending !== undefined) {
      if (intent !== null && pending.intent !== null && pending.intent !== intent) throw new KeyConflict(key, 'being started')
      return pending.promise
    }
    const promise = make().finally(() => { this.starting.delete(slot) })
    this.starting.set(slot, { promise, intent })
    return promise
  }

  /** The access cap a new run holds (schema v28): the sandbox when the request starting it holds one (a director of
   *  surface v1–v5, a connector's client: policy/access.ts), when its director session's surface is v1–v5, when its
   *  relay, interaction or parent run holds one, or — for any start but the person's own words — when the run it
   *  continues holds one; else none (the session's access decides). Only ever narrows. */
  accessCapFor(o: StartOptions, origin: RunCollab['origin'] | null, previous: Run | null): AccessMode | null {
    const conn = this.state.conn
    const caps: (AccessMode | null)[] = [currentRequestCap(), o.access_cap ?? null]
    if (origin?.director_session_id) {
      const ds = getDirectorSession(conn, origin.director_session_id)
      caps.push(ds === null ? 'sandbox' : surfaceCap(directorToolSurfaceOf(ds.config)))
    }
    const relayId = o.relay?.id ?? origin?.relay_id ?? null
    if (relayId) caps.push(repo.relayAccessCap(conn, relayId))
    const interactionId = o.interaction?.id ?? origin?.interaction_id ?? null
    if (interactionId) caps.push(repo.interactionAccessCap(conn, interactionId))
    if (origin?.parent_run_id) caps.push(repo.runAccessCap(conn, origin.parent_run_id))
    if (previous !== null && origin?.actor !== 'person') caps.push(repo.runAccessCap(conn, previous.id))
    return caps.includes('sandbox') ? 'sandbox' : null
  }

  /** The access cap a relay or an interaction holds for every run it starts (schema v28): the request's, and its
   *  director session's (v1–v5: the sandbox). */
  groupAccessCap(directorSessionId: string | null, origin: RunCollab['origin'] | null = null): AccessMode | null {
    const caps: (AccessMode | null)[] = [currentRequestCap()]
    for (const id of [directorSessionId, origin?.director_session_id ?? null]) {
      if (!id) continue
      const ds = getDirectorSession(this.state.conn, id)
      caps.push(ds === null ? 'sandbox' : surfaceCap(directorToolSurfaceOf(ds.config)))
    }
    if (origin?.parent_run_id) caps.push(repo.runAccessCap(this.state.conn, origin.parent_run_id))
    return caps.includes('sandbox') ? 'sandbox' : null
  }

  /** A keyed run found again: the same intent answers with it; another intent (both known) is a conflict. A run from
   *  before intents were recorded has none to compare and answers as before. */
  /** A key a follow-up step waiting in its interaction's queue holds is taken: any other start under it is refused. */
  checkKeyFree(sessionId: string, key: string): void {
    const held = crepo.queuedStepWithKey(this.state.conn, sessionId, key)
    if (held !== null) throw new KeyConflict(key, `${held.interaction_id}/${held.node_id}`)
  }

  checkIntent(key: string, runId: string, intent: string | null): void {
    if (intent === null) return
    const recorded = crepo.runIntentSha(this.state.conn, runId)
    if (recorded !== null && recorded !== intent) throw new KeyConflict(key, runId)
  }

  async start(session: Session, text: string, o: StartOptions = {}): Promise<Run> {
    const state = this.state
    const order = o.work_order ?? null
    const threadRun = order === null
    const model = (order?.model || null) || o.model_id || session.model
    const cfg = this.configFor(model)
    let wsId = o.workspace_id || session.workspace_id
    if (!wsId) throw new Error('the session has no workspace')
    if (repo.getWorkspace(state.conn, wsId)?.target?.kind === 'ssh') {
      if (session.access_mode !== 'full' || o.access_cap === 'sandbox') throw new RemoteRefused('sandbox_unavailable', 'Remote sandbox enforcement is unavailable.')
      if (order && (order.scope.read !== null || order.scope.write !== null)) throw new RemoteRefused('restriction_unavailable', 'Remote work-order filesystem allowlist bounds are unavailable; nothing started.')
      if (o.mentions?.length) throw new RemoteRefused('capability_unavailable', 'Remote symbol mentions are unavailable; name the remote file in the message.')
    }
    // one writer per workspace: a second thread run on a workspace another one works on is refused (an
    // interaction's nodes run side by side only on copies of their own)
    let previous: Run | null = null
    if (o.resumes_run_id) previous = repo.getRun(state.conn, o.resumes_run_id)
    // the thread's head: the main agent's latest run (or a relay's latest turn) — never a member's own follow-up, an
    // interaction's step on the session's folder, or a separate task's run
    else if (threadRun && !o.fresh && !o.interaction && !o.relay && !o.collab?.participant) previous = mainHeadRun(state, session.id)
    const previousWorkspace = previous?.workspace_id ? repo.getWorkspace(state.conn, previous.workspace_id) : null
    if (previousWorkspace?.source_mount && previousWorkspace.id !== wsId) {
      const target = repo.getWorkspace(state.conn, wsId)
      const ix = o.interaction ? repo.getInteraction(state.conn, o.interaction.id) : null
      const node = ix && o.interaction ? repo.getNode(state.conn, ix.id, o.interaction.node) : null
      // History may fork only into a new own participant workspace with the identical pinned,
      // enforced read-only source boundary, including an ordinary continuation on that boundary.
      // Previous interaction metadata is not authority; persisted workspace ownership is.
      // This never permits a direct or wider-write resume.
      const fork = previous?.session_id === session.id && previous.project_id === session.project_id
        && previousWorkspace.session_id === session.id && previousWorkspace.project_id === session.project_id
        && ix?.session_id === session.id && ix.workspace_policy === 'isolated' && ix.resumes_run_id === previous.id && !ix.fresh
        && node?.workspace === 'own' && node.status === 'queued' && node.workspace_id === wsId
        && target?.session_id === session.id && target.project_id === session.project_id && target.kind === 'child'
        && target.source_mount?.readonly === true && previousWorkspace.source_mount.readonly === true
        && target.source_mount.name === previousWorkspace.source_mount.name
        && pinnedRoot(target.source_mount.root) === pinnedRoot(previousWorkspace.source_mount.root)
      if (!fork) {
        if (o.workspace_id) throw new Error('a source-mounted conversation cannot resume in another writable workspace')
        wsId = previousWorkspace.id
      }
    }
    // who the run is, which conversation it appends to, why it starts and where it is shown — decided (and refused)
    // before anything is written
    const runId = newId('run')
    const resolved = resolveCollab(state, session, {
      run_id: runId, previous, fresh: !!o.fresh, order, interaction: o.interaction ? { id: o.interaction.id, node: o.interaction.node } : null,
      relay: o.relay ? { id: o.relay.id, step: o.relay.step } : null, spawned_by: o.spawned_by ?? 'human', label: o.label ?? null, model,
      wake: o.wake === true, ui_task: o.ui_task ?? null, collab: o.collab ?? null,
    })
    const accessCap = this.accessCapFor(o, resolved.origin as RunCollab['origin'], previous)
    if (accessCap === 'sandbox' && repo.getWorkspace(state.conn, wsId)?.target?.kind === 'ssh') throw new RemoteRefused('sandbox_unavailable', 'This run retains a sandbox cap that the SSH target cannot enforce.')
    // the thread is one conversation at a time (its main agent's run, or a relay's turn)
    if (resolved.placement.surface === 'thread' && this.activeRunOfSession(session.id) !== null) throw new Error(`session ${session.id} already has an active run`)
    if (threadRun && this.activeRunOfSession(session.id, wsId) !== null) throw new Error(`session ${session.id} already has an active run on workspace ${wsId}`)
    // the attachments of the message and of the history it continues, judged together before the run is accepted:
    // first from their references alone (the route's gate, the session's records, the bounds of one request on the
    // route), then what must be read — so a request that could not go is refused with the draft kept, and a file only
    // named by its path is never touched
    const read = attachmentReader((id) => repo.getAsset(state.conn, id), (path) => state.store.read(path), session.project_id, session.id)
    const refs = refAccess({ lookup: (id) => repo.getAsset(state.conn, id), store: state.store, project: session.project_id, session: session.id, local: this.localAccess(session.project_id) })
    const route = { limits: routeLimits(cfg), refs }
    const opening = modelRequest([userPrompt((o.attachments ?? []).map(attachmentPiece))])
    let replayed: ModelMessage[] = []
    let from = previous
    const walked = new Set<string>()
    while (from && !walked.has(from.id)) {
      if (from.session_id !== session.id || from.project_id !== session.project_id) throw new Error('cannot resume history outside this session')
      walked.add(from.id)
      const raw = repo.getRunHistory(state.conn, from.id)
      if (raw && raw !== '[]') { replayed = workingView(loadValue(JSON.parse(raw))); break }
      from = from.resumes_run_id ? repo.getRun(state.conn, from.resumes_run_id) : null
    }
    checkAttachmentHistory([...replayed, opening], read, cfg.capabilities, cfg.label || cfg.id, route)
    if (threadRun && model !== session.model && !o.keep_session_model) repo.setSessionModel(state.conn, session.id, model)
    const runBudget: Budget = order !== null ? order.budget : (o.budget ?? {})
    const thinking = o.thinking ?? null
    const thinkingSent = this.thinkingSent(cfg, thinking)
    const snapshot = cfg.dump()
    delete snapshot.pricing
    const uiTask = o.ui_task ?? null
    if (uiTask !== null && repo.getUiTask(state.conn, uiTask)?.status !== 'queued') throw new Error(`UI task ${uiTask} is not queued`)
    const run = state.conn.transaction(() => {
      const row = repo.insertRun(state.conn, {
        id: runId, session_id: session.id, project_id: session.project_id, workspace_id: wsId, model,
        model_config: { ...snapshot, api_key_env: routeKeyEnv(cfg), endpoint: routeEndpoint(cfg), thinking, thinking_sent: thinkingSent },
        user_text: text, status: 'running', budget: runBudget, resumes_run_id: previous ? previous.id : null,
        spawned_by: o.spawned_by ?? 'human', label: o.label ?? null, work_order: order !== null ? dumpWorkOrder(order) : null,
        attachments: o.attachments ?? [], client_request_id: o.client_request_id ?? null,
        relay_id: o.relay?.id ?? null, relay_step: o.relay?.step ?? null, interaction_id: o.interaction?.id ?? null, interaction_node: o.interaction?.node ?? null,
        participant_id: resolved.participant.id, conversation_id: resolved.conversation.id, origin: resolved.origin, placement: resolved.placement,
        intent_sha: o.collab?.intent_sha ?? null, access_cap: accessCap,
      })
      writeCollab(state, session.id, runId, resolved, o.collab?.edges ?? [])
      return row
    })
    const handle = newHandle({
      run_id: run.id, session_id: session.id, project_id: session.project_id, workspace_id: wsId, model_id: model, resumes_run_id: previous ? previous.id : null,
      user_text: text, budget: runBudget, cfg, spawned_by: o.spawned_by ?? 'human', label: o.label ?? null, work_order: order,
      mentions: [...(o.mentions ?? [])], thinking, thinking_sent: thinkingSent, relay: o.relay ?? null, interaction: o.interaction ?? null, wake: o.wake === true,
      participant_id: resolved.participant.id, participant_role: resolved.participant.role as ParticipantRole, surface: resolved.placement.surface,
      tool_snapshot: resolved.snapshot, collab_lines: [...(o.collab?.lines ?? [])], handover: o.collab?.handover ?? null,
      collab: { participant_id: resolved.participant.id, participant_role: resolved.participant.role as ParticipantRole, conversation_id: resolved.conversation.id, conversation_seq: null, origin: resolved.origin, placement: resolved.placement, basis: 'recorded' },
    })
    // the task knows its run before the run does anything (no await from here to execute's first step): no result,
    // event or end of the run can come before the task is bound to it
    if (uiTask !== null) {
      if (!bindUiTask(state.conn, uiTask, run.id)) console.warn(`UI task ${uiTask} was no longer queued when its run ${run.id} started`)
      else handle.ui_task = uiTask
    }
    this.handles.set(run.id, handle)
    // the run's own task: what it does and starts is the run's (its cap is stored), never the request's that started it
    handle.task = outsideRequest(() => isChatGptWeb(cfg.id) ? this.executeChatGpt(run, handle, cfg) : this.execute(run, handle, cfg))
    // the run as it stands once its task reached its first wait: queued when another writer holds its folder
    return handle.status === 'queued' ? { ...run, status: 'queued' } : run
  }

  /** What the run has spent so far. */
  private spent(handle: RunHandle): Record<'requests' | 'total_tokens' | 'tool_calls', number> {
    const own: Record<string, unknown> = handle.meter !== null ? handle.meter.totalsWithTokens() : {}
    const n = (v: unknown) => Math.trunc(Number(v ?? 0) || 0)
    return { requests: n(own.requests), total_tokens: n(own.total_tokens), tool_calls: handle.events.filter((e) => e.event === 'tool_call').length }
  }

  /** The commands an earlier run started in the workspace that still run as this one starts (a command may outlive
   *  its run): they may still write what this run reads and writes, and the person is told so. */
  private runningCommands(workspaceId: string): { execution_id: string; run_id: string | null; command: string }[] {
    return this.state.processes.runningInWorkspace(workspaceId).map((xid) => repo.getExecution(this.state.conn, xid)).filter((x) => x !== null)
      .map((x) => ({ execution_id: x.id, run_id: x.run_id, command: x.command.slice(0, 200) }))
  }

  /** Whether a Stop can still change how the run ends: it is live and its end is not being written yet (once finalize
   *  has taken the run's status, a Stop kills what is left but the run ends as it was going to). */
  canStop(runId: string): boolean {
    const handle = this.handles.get(runId)
    return handle !== undefined && !handle.done && !handle.finalizing
  }

  /** Stop a run: its model request is cancelled and its processes die with it. */
  cancel(runId: string): boolean {
    const handle = this.handles.get(runId)
    if (!handle || handle.done) return false
    handle.token.cancel()
    // Stop now: the processes of this run die with it
    this.state.processes.stopAllForRun(runId)
    return true
  }

  /** Every live run is stopped and waited for (ten seconds in all) — a run a finish hook started meanwhile too, so
   *  nothing of a run outlives the connection it writes to. */
  async shutdown(): Promise<void> {
    this.stopping = true
    const deadline = monotonic() + 10
    for (;;) {
      // as a Stop would: the model request cancelled and the run's processes killed (a command left to finish would
      // be waited for, and could write what the person was closing on)
      for (const handle of this.handles.values()) if (!handle.done) { handle.token.cancel(); this.state.processes.stopAllForRun(handle.run_id) }
      const tasks = [...this.handles.values()].filter((h) => h.task && !h.done).map((h) => h.task!)
      const remaining = deadline - monotonic()
      if (!tasks.length || remaining <= 0) return
      await Promise.race([Promise.allSettled(tasks), sleep(remaining * 1000)])
    }
  }

  /** Release what the built models hold (the native OAuth ones a signing hook). */
  async closeModels(): Promise<void> {
    for (const model of this.built_models.values()) {
      try { await model.close?.() } catch { /* released */ }
    }
    this.built_models.clear()
  }

  /** Startup: runs a dead process left running are errors now (their histories stand, their receipts say lost);
   *  executions left running are lost, and the processes they left behind are killed; a run whose row ended but
   *  whose run_finished event never got written (a crash between the two) gets the event from its row, so a
   *  replay ends as the row says; stale workspace locks are cleared. Nothing is replayed. */
  async reconcile(): Promise<Record<string, unknown>> {
    const conn = this.state.conn
    const dead = repo.markDeadRuns(conn)
    const lost = repo.markLostExecutions(conn)
    const strays = this.state.processes.reapLost(lost)
    const stale = this.state.locks.reconcile()
    for (const runId of dead) {
      // what the dead run left waiting on the person, and the UI task it was doing, end with it — their events before
      // the run's run_finished, as a live run's would be
      for (const input of repo.listUiInputs(conn, repo.getRun(conn, runId)?.session_id ?? '', { run_id: runId, status: 'pending', limit: 1_000 })) {
        if (repo.answerUiInput(conn, input.id, { status: 'closed', closed_reason: 'interrupted' })) {
          repo.insertEvent(conn, runId, repo.maxEventSeq(conn, runId) + 1, 'ui_input', { input: repo.getUiInput(conn, input.id) })
        }
      }
      // the steers it still had queued never reached its conversation: they end, interrupted (none is sent again)
      this.endQueuedSteers(runId)
      const task = repo.uiTaskOfRun(conn, runId)
      if (task !== null && repo.endUiTask(conn, task.id, { status: 'failed', error: INTERRUPTED_TASK, from: ['running'], run_id: runId })) {
        repo.insertEvent(conn, runId, repo.maxEventSeq(conn, runId) + 1, 'ui_task', { task: repo.getUiTask(conn, task.id) })
      }
      const run = repo.getRun(conn, runId)
      let receipt = run && Object.keys(run.receipt).length ? run.receipt : null
      if (run !== null && receipt === null) {
        // in place, the journal knows what the run's tools wrote (settled at startup before this): the receipt says it
        const ws = run.workspace_id ? repo.getWorkspace(conn, run.workspace_id) : null
        const journal = this.state.workspaces.journal
        const own = ws !== null && isDirect(ws) ? journal.runAttributed(runId) : null
        const inPlace = ws !== null && own !== null ? { workspace_id: ws.id, files: journal.diffOf(own.changes).files } : null
        // the marker kept at its admission stands for a run that died too
        const marker = markerOf(run.manifest)
        const attribution = marker === null ? null : {
          attribution: (own !== null ? (marker.overlapped || own.unattributed.length ? 'partial' : 'exact') : snapshotUnavailable(marker) ? 'unavailable' : null) as 'partial' | 'exact' | 'unavailable' | null,
          unattributed_paths: own?.unattributed ?? [], background_execution_ids: marker.background_execution_ids,
        }
        receipt = lostReceipt(runId, { label: run.label, error: run.error, finished_at: run.finished_at, in_place: inPlace, attribution }) as unknown as Record<string, unknown>
        repo.setRunReceipt(conn, runId, receipt)
      }
      repo.insertEvent(conn, runId, repo.maxEventSeq(conn, runId) + 1, 'run_finished', { status: 'error', error: repo.LOST_RUN_ERROR, reconciled: true, receipt })
    }
    const unfinished = repo.runsWithoutFinishEvent(conn).filter((r) => !dead.includes(r.id))
    for (const r of unfinished) {
      this.endQueuedSteers(r.id)
      repo.insertEvent(conn, r.id, repo.maxEventSeq(conn, r.id) + 1, 'run_finished', { status: r.status, usage: r.usage ?? {}, error: r.error, receipt: r.receipt, reconciled: true })
    }
    // the rest a dead process left: tasks still queued (their run never started) or running, forms still pending
    const tasks = repo.activeUiTasks(conn).filter((t) => repo.endUiTask(conn, t.record.id, { status: 'failed', error: INTERRUPTED_TASK, from: ['queued', 'running'] })).map((t) => t.record.id)
    const inputs = repo.pendingUiInputs(conn).filter((i) => repo.answerUiInput(conn, i.id, { status: 'closed', closed_reason: 'interrupted' })).map((i) => i.id)
    return { dead_runs: dead, lost_executions: lost, stray_processes: strays, unfinished_events: unfinished.map((r) => r.id), stale_locks: stale, ui_tasks: tasks, ui_inputs: inputs }
  }

  /** A run this process did not finish: each steer its events leave queued gets its steer_undelivered (interrupted). */
  private endQueuedSteers(runId: string): void {
    const conn = this.state.conn
    for (const queued of steersFromEvents(repo.listEvents(conn, runId)).filter((st) => st.status === 'queued')) {
      repo.insertEvent(conn, runId, repo.maxEventSeq(conn, runId) + 1, 'steer_undelivered', { steer: { ...queued, status: 'undelivered', reason: 'interrupted' } })
    }
  }

  // -- events ---------------------------------------------------------------

  emit(handle: RunHandle, event: string, data: Record<string, unknown>): void {
    const item: RunEvent = { seq: handle.events.length, event, data, v: EVENT_VERSION, run_id: handle.run_id, cursor: null }
    handle.events.push(item)
    if (!TRANSIENT_EVENTS.has(event)) item.cursor = repo.insertEvent(this.state.conn, handle.run_id, item.seq, event, data)
    for (const queue of handle.queues) queue.put(item)
    this.sessions.publish(handle.session_id, item)
    // the tool-call line is reached once the Nth call has run (its result is in): the Nth runs, an N+1th is refused
    if (event === 'tool_result') this.checkBudget(handle)
  }

  /** Persisted events after the cursor, then the live ones (an in-memory handle) — every item carries its seq; a
   *  client de-duplicates by it. `signal` ends the subscription at once, even while it waits for the next event (a
   *  generator's return() would wait for that event, and a quiet run may send none for hours). */
  async *subscribe(runId: string, opts: { after_seq?: number; signal?: AbortSignal } = {}): AsyncGenerator<RunEvent, void, undefined> {
    const afterSeq = opts.after_seq ?? -1
    const handle = this.handles.get(runId)
    if (!handle) {
      for (const item of repo.listEvents(this.state.conn, runId, afterSeq)) yield { ...item, v: EVENT_VERSION, run_id: runId }
      return
    }
    const queue = new EventQueue()
    handle.queues.push(queue)
    const stop = () => queue.put(SENTINEL)
    opts.signal?.addEventListener('abort', stop, { once: true })
    try {
      if (opts.signal?.aborted) return
      const replayed = [...handle.events]
      const doneAtSnapshot = handle.done
      const cursor = Math.max(-1, Math.min(afterSeq, replayed.length - 1))
      let nextSeq = cursor + 1
      for (const item of replayed) {
        if (item.seq < nextSeq) continue
        yield item
        nextSeq = item.seq + 1
      }
      if (doneAtSnapshot) return
      for (;;) {
        const item = await queue.get()
        if (item === SENTINEL) return
        if (item.seq < nextSeq) continue
        yield item
        nextSeq = item.seq + 1
      }
    } finally {
      opts.signal?.removeEventListener('abort', stop)
      const at = handle.queues.indexOf(queue)
      if (at >= 0) handle.queues.splice(at, 1)
    }
  }

  /** The runs of a session this process holds, with their events (a session stream's replay). */
  private heldRuns(sessionId: string): MemoryRun[] {
    const out: MemoryRun[] = []
    for (const handle of this.handles.values()) if (handle.session_id === sessionId) out.push({ run_id: handle.run_id, events: handle.events, done: handle.done })
    return out
  }

  /** The session cursor a session detail names (session_events.ts snapshotCursor). */
  sessionCursor(sessionId: string): number {
    return snapshotCursor(this.state.conn, this.heldRuns(sessionId))
  }

  /** A page of a run's events after `after` (session_events.ts runEventsPage). */
  eventsPage(runId: string, after: number, limit: number): repo.StoredEvent[] {
    const handle = this.handles.get(runId)
    return runEventsPage(this.state.conn, handle ? { run_id: runId, events: handle.events, done: handle.done } : null, runId, after, limit)
  }

  /** Every run of the session on one stream, after the session cursor `after` (session_events.ts). */
  subscribeSession(sessionId: string, opts: { after: number; signal?: AbortSignal }): AsyncGenerator<SessionFrame, void, undefined> {
    return sessionEvents({ conn: this.state.conn, hub: this.sessions, runs: () => this.heldRuns(sessionId) }, sessionId, opts)
  }

  // -- in-run steering ---------------------------------------------------------

  /** Why the run does not take the person's words now (null: it does). not_steerable: not the session's own thread
   *  run (an order's, a relay turn, an interaction node, a UI task, ChatGPT on the web); run_finishing: its intake
   *  closed (its end decided, its budget closing, a Stop, its end being written). */
  steerRefusal(handle: RunHandle): Exclude<SteerRefusal, 'empty_text' | 'steer_agents' | 'invalid_input' | 'key_conflict'> | null {
    if (handle.done) return 'run_not_live'
    // every run that works on a conversation of its own takes words while it works — the main agent's, a separate
    // task's, a group member's, a relay turn's; a UI task answers a surface, and ChatGPT on the web reads no words
    // between requests of its own
    if (handle.ui_task !== null || isChatGptWeb(handle.model_id)) return 'not_steerable'
    if (handle.finalizing || handle.token.cancelled || handle.closing !== null || handle.budget_exceeded !== null || !handle.steer.open) return 'run_finishing'
    return null
  }

  /** The steers of a run, by queued_seq: the live handle's, else the stored events'. */
  steersOf(runId: string): SteerRecord[] {
    const handle = this.handles.get(runId)
    return steersFromEvents(handle ? handle.events : repo.listEvents(this.state.conn, runId))
  }

  /** The person's words to a live run: queued for its next request boundary (the steer_queued event is the record).
   *  The same key again answers with the steer it made — with other words it is refused (key_conflict): the new
   *  words are never swallowed. `client`: the connector's client the request came through (its origin), kept on the
   *  record so every later reading names it. */
  steer(runId: string, words: string, key: string, by: SteerSource = 'person', client: string | null = null): { steer: SteerRecord } | { refusal: SteerRefusal; detail: string } {
    const handle = this.handles.get(runId)
    const earlier = handle ? handle.steer.byKey(key) : (this.steersOf(runId).find((s) => s.client_request_id === key) ?? null)
    if (earlier !== null) {
      if (earlier.text === words) return { steer: earlier }
      return { refusal: 'key_conflict', detail: `client_request_id ${key} was already used on run ${runId} with other words; send them with a new key` }
    }
    if (!handle || handle.done) return { refusal: 'run_not_live', detail: `run ${runId} is not running` }
    const refusal = this.steerRefusal(handle)
    if (refusal === 'not_steerable') return { refusal, detail: `run ${runId} takes no message while it works (a UI task, ChatGPT on the web)` }
    if (refusal !== null) return { refusal, detail: `run ${runId} is finishing and takes no more messages; send yours when it ends` }
    const steer: SteerRecord = {
      id: newId('st'), run_id: runId, session_id: handle.session_id, text: words, client_request_id: key, status: 'queued',
      queued_at: nowIso(), queued_seq: handle.events.length, delivered_at: null, delivered_seq: null, request_index: null, reason: null,
      ...(by !== 'person' ? { by } : {}),
      ...(client ? { client } : {}),
    }
    handle.steer.put(steer)
    handle.steer.queue.push(steer)
    this.emit(handle, 'steer_queued', { steer })
    repo.noteSessionActivity(this.state.conn, handle.session_id, steer.queued_at)
    return { steer }
  }

  /** A queued steer that will not be delivered: out of the queue, its event written. */
  private undeliver(handle: RunHandle, queued: SteerRecord, reason: SteerUndeliveredReason): void {
    handle.steer.take(queued.id)
    const steer: SteerRecord = { ...queued, status: 'undelivered', reason }
    handle.steer.put(steer)
    this.emit(handle, 'steer_undelivered', { steer })
  }

  /** Whether the run can still hand queued words to its model: live, not stopped, not closing. */
  private canDeliver(handle: RunHandle): boolean {
    return !handle.done && !handle.finalizing && !handle.token.cancelled && handle.closing === null && handle.budget_exceeded === null
  }

  /** The steering seam of one run's execution: `commit(out, delivered)` writes the record with the words in it and
   *  their delivered events in one transaction. */
  private steeringPort(handle: RunHandle, keeper: ContextKeeper | null, commit: (out: ModelMessage[], write: () => void) => void, requestIndex: () => number): SteeringPort {
    const inbox = handle.steer
    const parts = (records: SteerRecord[]) => steerParts(records)
    return {
      pending: () => this.canDeliver(handle) && inbox.queue.length > 0,
      peek: () => {
        if (!this.canDeliver(handle) || !inbox.queue.length) return []
        for (const s of inbox.queue) inbox.peeked.add(s.id)
        return parts(inbox.queue)
      },
      deliver: (messages: ModelMessage[], seam: RequestSeam, must: boolean): ModelMessage[] => {
        if (!this.canDeliver(handle) || !inbox.queue.length) return messages
        const room = keeper !== null ? keeper.window - keeper.output_reserve : Infinity
        const taken: SteerRecord[] = []
        let deferred = false
        for (const queued of [...inbox.queue]) {
          if (deferred) break
          const fits = keeper === null || keeper.predict(withTailParts(messages, parts([...taken, queued])), seam).tokens <= room
          if (fits) { taken.push(queued); continue }
          // whole or not at all: words that cannot fit the window are never cut — refused now when the compaction
          // decision already counted them (or no later boundary is to come), else left, in order, for the next one
          if (must || inbox.peeked.has(queued.id)) this.undeliver(handle, queued, 'context')
          else deferred = true
        }
        if (!taken.length) { keeper?.predict(messages, seam); return messages }
        const out = withTailParts(messages, parts(taken))
        keeper?.predict(out, seam)
        const index = requestIndex()
        commit(out, () => {
          for (const queued of taken) {
            inbox.take(queued.id)
            const steer: SteerRecord = { ...queued, status: 'delivered', delivered_at: nowIso(), delivered_seq: handle.events.length, request_index: index }
            inbox.put(steer)
            this.emit(handle, 'steer_delivered', { steer })
          }
        })
        return out
      },
      close: () => inbox.close('answer_complete'),
    }
  }

  // -- budgets --------------------------------------------------------------

  /** The tool-call line: reached → the closing turn (no tool). */
  private checkBudget(handle: RunHandle): void {
    if (handle.budget_exceeded || handle.done || handle.closing !== null) return
    const limit = handle.budget.tool_calls
    if (limit === null || limit === undefined) return
    const calls = this.spent(handle).tool_calls
    if (calls >= limit) this.beginClosing(handle, `tool_calls ${calls} of ${limit}`)
  }

  private beginClosing(handle: RunHandle, reason: string): void {
    if (handle.closing || handle.done) return
    handle.closing = reason
    // a closing turn is the report, no new instruction joins it: the intake closes (what is queued ends with the run)
    handle.steer.close('budget')
    if (handle.notes !== null) handle.notes.push(text('app.closing', { limit: reason }))
    this.emit(handle, 'budget_closing', { reason })
  }

  private stopForBudget(handle: RunHandle, reason: string): void {
    if (handle.budget_exceeded || handle.done) return
    handle.budget_exceeded = reason
    handle.token.cancel()
    this.state.processes.stopAllForRun(handle.run_id)
  }

  /** A segment's limits: the harness's segment length, cut to the requests the run's budget has left, and the tokens
   *  it has left — the loop counts a segment's own usage, so the whole-run line is handed to it as what remains, and
   *  is met at the request that reaches it, not at the next segment boundary nor after a recovery starts afresh. */
  private limits(handle: RunHandle): UsageLimits {
    const b = handle.budget
    const spent = this.spent(handle)
    const left = b.requests != null ? Math.max(0, b.requests - spent.requests) : null
    const tokensLeft = b.total_tokens != null ? Math.max(0, b.total_tokens - spent.total_tokens) : null
    return { request_limit: left === null ? this.segment_request_limit : Math.min(this.segment_request_limit, left), total_tokens_limit: tokensLeft, tool_calls_limit: b.tool_calls ?? null }
  }

  private budgetLine(handle: RunHandle): string | null {
    const b = handle.budget
    const spent = this.spent(handle)
    if (b.requests != null && spent.requests >= b.requests) return `requests ${spent.requests} of ${b.requests}`
    if (b.total_tokens != null && spent.total_tokens >= b.total_tokens) return `total_tokens ${spent.total_tokens} of ${b.total_tokens}`
    if (b.tool_calls != null && spent.tool_calls >= b.tool_calls) return `tool_calls ${spent.tool_calls} of ${b.tool_calls}`
    return null
  }

  // -- the run ----------------------------------------------------------------

  /** The model behind a route, built once (a test's override first): what a native director runs on too. */
  modelFor(cfg: ModelConfig): Model { return this.resolveModel(cfg) }

  private resolveModel(cfg: ModelConfig): Model {
    const override = this.state.model_overrides.get(cfg.id)
    if (override) return override
    // the ChatGPT page is a participant of the conversation, reached through the desktop app — not a model API
    if (isChatGptWeb(cfg.id)) throw new Error(`${cfg.label} answers as a participant through the desktop app's page; it is no model a request can be sent to`)
    let built = this.built_models.get(cfg.id)
    if (!built) {
      built = buildModel(cfg)
      this.built_models.set(cfg.id, built)
    }
    return built
  }

  /** The provider system this run's requests are carried to (a test's override names its own). */
  private targetSystem(cfg: ModelConfig): string {
    const override = this.state.model_overrides.get(cfg.id)
    return override ? (override.system ?? cfg.provider) : providerSystem(cfg)
  }

  /** Whether the route's requests may carry the provider's own web search (the run's grants decide each request). */
  private offersProviderSearch(cfg: ModelConfig): boolean {
    try { return this.resolveModel(cfg).profile.builtin_tools?.includes('web_search') === true } catch { return false }
  }

  /** The thinking level a run on the route is sent for the level asked: none for a model that takes no thinking
   *  setting (or a route that cannot be built: the run fails where it builds it). */
  private thinkingSent(cfg: ModelConfig, thinking: string | null): string | null {
    let thinks = false
    try { thinks = this.resolveModel(cfg).profile.supports_thinking === true } catch { thinks = false }
    return thinks ? routeThinking(thinking, cfg.reasoning_efforts, this.offersProviderSearch(cfg)) : null
  }

  /** The route this run's responses are stamped with (endpoint and model), which the handoff keys on beside the
   *  provider; null when the model stamps none or cannot be built (the run then fails where it builds it). */
  private targetRoute(cfg: ModelConfig): string | null {
    try { return this.resolveModel(cfg).route ?? null } catch { return null }
  }

  /** The conversation this run continues (its session's latest thread run, or the run resumes_run_id names): the
   *  record as it was stored, its dangling calls answered; what of it a foreign provider cannot take is left out at
   *  the provider boundary on every request, and the note that says so opens this run's message. Returns
   *  [messages, handoff report, note, the previous run's context anchor and line when they were measured on this route]. */
  private loadHistory(handle: RunHandle, cfg: ModelConfig): [ModelMessage[] | null, HandoffReport | null, string | null, ContextSeed] {
    if (!handle.resumes_run_id) return [null, null, null, NO_SEED]
    // the conversation this run continues: the resumed run's history, or — when that run never got as far as a
    // request (a restart cut it off first) — the history it was itself continuing, back along the chain
    let from: string | null = handle.resumes_run_id
    let raw: string | null = null
    const walked = new Set<string>()
    while (from !== null && !walked.has(from)) {
      walked.add(from)
      raw = repo.getRunHistory(this.state.conn, from)
      if (raw && raw !== '[]') break
      from = repo.getRun(this.state.conn, from)?.resumes_run_id ?? null
    }
    if (!raw || raw === '[]' || from === null) return [null, null, null, NO_SEED]
    const previous = repo.getRun(this.state.conn, from)
    let messages: ModelMessage[]
    try {
      messages = loadValue(JSON.parse(raw))
    } catch {
      console.warn(`could not reload history of run ${handle.resumes_run_id}; starting fresh`)
      return [null, null, null, NO_SEED]
    }
    messages = closeDanglingToolCalls(messages)
    const [, report] = portableHistory(workingView(messages), this.targetSystem(cfg), this.targetRoute(cfg))
    // the note names the route the record comes from when that route is another; else the foreign models it holds
    const note = report.foreign_responses ? handoffNote(report, previous !== null && previous.model !== cfg.id ? previous.model : null, cfg.id) : null
    return [messages, report.foreign_responses ? report : null, note, previous !== null ? contextSeedOf(previous, cfg) : NO_SEED]
  }

  /** The instructions as the first message shows them: one entry per source with its scope, and the folder rule
   *  once when any comes from a folder's file. */
  static renderInstructions(files: InstructionFile[]): string[] {
    const parts = files.map((f) => text('context.project', { source: f.source, scope: f.scope, text: f.text }))
    if (files.some((f) => f.source !== SETTINGS_SOURCE)) parts.push(PROMPT_TEXT['context.project_scope_rule'])
    return parts
  }

  /** The permissions this run has, as lines: the mode when it is Plan, else each permission the session withholds
   *  (a call that needs it asks the person), the network when the run's own policy turns it off, and the tools an
   *  order takes away. Empty when nothing is withheld. */
  private permissionLines(deps: AgentDeps, order: WorkOrder | null): string[] {
    const grants = deps.session.grants
    const mode = inferMode(grants, effectiveControl(deps.conn, deps.session.id))
    const lines: string[] = []
    if (mode === 'plan') lines.push(PROMPT_TEXT['context.plan'])
    else {
      if (mode === 'approve') lines.push(PROMPT_TEXT['context.approve'])
      if (!grants.workspace_write) lines.push(text('context.permission', { action: 'Writing files' }))
      if (!grants.run_commands) lines.push(text('context.permission', { action: 'Running commands' }))
    }
    if (order !== null && !order.execution.network) lines.push(PROMPT_TEXT['context.network_off'])
    else if (!networkGranted(grants)) lines.push(text('context.permission', { action: 'Network access' }))
    if (order !== null && !order.execution.commands) lines.push(text('context.disabled', { tools: 'bash, bash_output, stop_command' }))
    // where commands run: said for Full access, and for the sandbox once access was chosen for the session (a session
    // made in the sandbox and never switched is told nothing new, as a session was before access modes existed)
    if (mode !== 'plan' && grants.run_commands && (order === null || order.execution.commands)) {
      const access = this.commandAccessOf(deps, order)
      if (access === 'full') lines.push(PROMPT_TEXT[deps.workspace.target?.kind === 'ssh' ? 'context.remote_full' : 'context.access_full'])
      else if (deps.session.access_mode === 'full' || repo.listGovernance(deps.conn, deps.session.id, 'session_access').length) lines.push(PROMPT_TEXT['context.access_sandbox'])
    }
    return lines
  }

  /** Where this run's commands run, as the run starts: the session's access narrowed by the run's cap
   *  (policy/access.ts; commands.ts decides the same way when each command starts). The network off and an order's
   *  bounds keep Full access on the host, held there by the OS (commands.ts). */
  private commandAccessOf(deps: AgentDeps, order: WorkOrder | null): AccessMode {
    return effectiveAccess({ session: deps.session, run_cap: deps.run_id ? repo.runAccessCap(deps.conn, deps.run_id) : null, order })
  }

  /** What this run may read and write inside the working folder beyond the permissions: an order's readable and
   *  writable paths, and the file restrictions — protected paths and hard locks — as one list. */
  private restrictionLines(deps: AgentDeps, order: WorkOrder | null): string[] {
    const lines: string[] = []
    if (order !== null && order.scope.read !== null) lines.push(text('context.scope_read', { paths: order.scope.read.join(', ') || 'none' }))
    if (order !== null && order.read_only) lines.push(text('context.scope_write', { paths: 'none in the working folder (this run is read-only; the temporary folder is writable)' }))
    else if (order !== null && order.scope.write !== null) lines.push(text('context.scope_write', { paths: order.scope.write.join(', ') || 'none' }))
    // every protected path the run is held to: the configuration's, the project's, the order's — the configuration's
    // (the app's own .git and .oasis-code) left unsaid in a session with no project folder, where there is nothing of
    // the person's for them to guard (a write there is still refused, with its reason)
    const configured = deps.project.config.no_folder === true ? [] : deps.config.protected_paths
    const protectedPaths = [...configured, ...((deps.project.config.protected_paths as string[] | undefined) ?? []), ...(order?.protected_paths ?? [])]
    const restrictions = [
      ...protectedPaths.map((path) => text('context.lock_read_only', { path })),
      ...effectiveLocks(deps.conn, deps.session.id, deps.project, order).map(describeLock),
    ]
    if (restrictions.length) lines.push(text('context.lock_header', { restrictions: [...new Set(restrictions)].join('\n') }))
    return lines
  }

  /** Whether the run's message is the person's own words as they sent them from the app. */
  private static personWrote(run: Run, handle: RunHandle): boolean {
    return !handle.relay?.harness_message && !handle.interaction?.harness_message && !handle.wake && run.spawned_by === 'human'
  }

  /** The task as the model reads it: the person's words (agent tokens as names), and — under an order — its goal,
   *  deliverables, the acceptance the app measures and the context it names, as plain lines below them. */
  private taskText(run: Run, handle: RunHandle): string {
    if (handle.relay?.harness_message || handle.interaction?.harness_message || handle.wake) return run.user_text
    // the agents the person named read as their letters beside a roster (two or more), else as their labels
    const lines = [aliasedAgentMentions(run.user_text)]
    const order = handle.work_order
    if (order !== null) {
      if (order.goal) lines.push(`Goal: ${order.goal}`)
      if (order.deliverables.length) lines.push(`Deliverables: ${order.deliverables.join('; ')}`)
      if (order.acceptance.length) lines.push(`Acceptance measured by the app: ${order.acceptance.map((c) => `${c.metric} ${c.op} ${c.value}`).join('; ')}`)
      if (order.context_refs.length) lines.push(`Context in this project: ${order.context_refs.join(', ')}`)
    }
    return lines.join('\n')
  }

  /** The run's first message: on a fresh conversation the session-fixed context (the folders, the project's
   *  instructions, the permissions and restrictions), then what belongs to this turn (a limit, the approvals'
   *  state, the referenced files, a relay's roster, the date), then the person's words as their own part; on a
   *  continued conversation only what changed or belongs to the turn. Returns the content the model gets, its
   *  text (what the manifest seals), the instruction sources, and the permissions and restrictions as strings
   *  (what the next run compares against). */
  /** The roots of a run, each with its access here: read-only; read and write (its Git metadata excepted in a Sandbox
   *  access session); or read-only in an isolated copy of a root the session has read and write. */
  static rootsText(roots: readonly PolicyRoot[]): string {
    return effectiveRoots(roots).map((r) => {
      const protectGit = roots.find((x) => x.path === r.path)?.protect_git === true
      if (r.access === 'write') return `${r.path} (read and write${protectGit ? ', its Git metadata excepted' : ''})`
      if (r.registered === 'write') return `${r.path} (read-only in this workspace, an isolated copy; the session has it read and write)`
      return `${r.path} (read-only)`
    }).join('; ')
  }

  private buildPrompt(run: Run, handle: RunHandle, deps: AgentDeps, o: { instructions: InstructionFile[]; more: string[]; fresh: boolean; previous: Run | null }):
    { content: UserContent; text: string; sources: string[]; permissions: string; restrictions: string } {
    const ws = deps.workspace
    const order = handle.work_order
    const parts: string[] = []
    if (ws.target?.kind === 'ssh' && ws.remote) parts.push(text('context.remote', { target: ws.target.target_id, root: ws.remote.root_id, generation: ws.remote.generation }))
    const permissions = this.permissionLines(deps, order)
    const restrictions = this.restrictionLines(deps, order)
    // an attached folder's line is a permission too (read-only or writable): it belongs to what a later run compares
    const attached = workspaceAttached(deps.project, deps.workspace, { writable: deps.session.grants.attached_write })
    // read-only is the file tools' (and the sandbox's): a Full access command runs as the user and is not held to it
    const attachedLine = attached !== null ? text(attached.writable ? 'context.attached_write' : this.commandAccessOf(deps, order) === 'full' ? 'context.attached_read_full' : 'context.attached_read', { path: `${attached.name}/` }) : null
    // the session's roots as this workspace holds them (schema v29): a permission too, said with what narrowed one
    const rootsLine = deps.policy.roots.length ? text('context.roots', { roots: RunManager.rootsText(deps.policy.roots) }) : null
    const permissionState = [...(attachedLine !== null ? [attachedLine] : []), ...(rootsLine !== null ? [rootsLine] : []), ...permissions]
    if (o.fresh) {
      parts.push(text(deps.project.config.no_folder === true ? 'context.working_own' : 'context.working', { path: ws.path }))
      // with Full access $TMPDIR is the user's own: the folder is named, not as $TMPDIR
      if (deps.policy.temp !== null) parts.push(text(this.commandAccessOf(deps, order) === 'full' ? 'context.temp_full' : 'context.temp', { path: deps.policy.temp }))
      if (attachedLine !== null) parts.push(attachedLine)
      if (rootsLine !== null) parts.push(rootsLine)
      parts.push(...RunManager.renderInstructions(o.instructions))
      if (o.more.length) parts.push(text('context.project_more', { folders: o.more.join(', ') }))
      parts.push(...permissions, ...restrictions)
    } else {
      const before = o.previous?.manifest ?? {}
      const changed = String(before.permissions ?? '') !== permissionState.join('\n') || String(before.restrictions ?? '') !== restrictions.join('\n')
      // the whole permission state, said again: what is withheld or that nothing is, then the restrictions
      if (changed) parts.push(text('context.mode_changed', { current_permissions: [permissionState.length ? permissionState.join(' ') : 'No permission is withheld.', ...restrictions].join(' ') }))
    }
    const budget = budgetLines(handle.budget)
    if (Object.keys(budget).length) parts.push(text('context.limit', { limit: Object.entries(budget).map(([k, v]) => `${k} ${v}`).join(', ') }))
    const gateNote = proposalPromptNote(deps.conn, deps.project.id, deps.session.id)
    if (gateNote) parts.push(gateNote)
    // a folder edited in place: what the person undid since the conversation's last turn (its record still says the
    // files were changed)
    if (isDirect(ws) && o.previous?.finished_at) {
      const undone = repo.listJournalUndos(deps.conn, ws.id, o.previous.finished_at)
      if (undone.length) parts.push(text('context.undone', { files: [...new Set(undone.map((u) => `${u.path} (${u.action === 'removed' ? 'removed: the run had created it' : 'restored'})`))].join(', ') }))
    }
    if (handle.mentions.length) parts.push(mentionsNote(handle.mentions))
    // only the person's own words name tools: not a harness's message (a relay's or an interaction's later turn — its
    // request lines say it — a wake), nor a connector's, whose words its client's model wrote
    const namedTools = RunManager.personWrote(run, handle) ? namedToolsNote(run.user_text) : null
    if (namedTools !== null) parts.push(namedTools)
    if (handle.relay?.note) parts.push(handle.relay.note)
    if (handle.interaction?.note) parts.push(handle.interaction.note)
    // what the dispatch names (schema v25): a line per run it refers to, a packet per answer handed over
    parts.push(...handle.collab_lines)
    parts.push(text('context.clock', clock()))
    const task = this.taskText(run, handle)
    const context = parts.join('\n')
    // images sent without words: the context alone, no empty part
    return { content: task ? [context, task] : [context], text: task ? `${context}\n${task}` : context, sources: o.instructions.map((f) => f.source), permissions: permissionState.join('\n'), restrictions: restrictions.join('\n') }
  }

  private async backoff(handle: RunHandle, delay: number): Promise<void> {
    const end = monotonic() + Math.max(0, delay)
    while (!handle.token.cancelled) {
      const remaining = end - monotonic()
      if (remaining <= 0) return
      await sleep(Math.min(250, remaining * 1000))
    }
  }

  private async execute(run: Run, handle: RunHandle, cfg: ModelConfig): Promise<void> {
    const state = this.state
    const session = repo.getSession(state.conn, run.session_id)!
    const project = repo.getProject(state.conn, run.project_id)!
    const workspace = repo.getWorkspace(state.conn, run.workspace_id!)!
    let stashed: ModelMessage[] = []
    // where this run's own messages start in the record (what it continued comes before)
    let ownFrom = 0
    let status = 'error'
    let error: string | null = null
    let historyJson: string | null = null
    let usage: Record<string, unknown> = {}
    let meter: UsageMeter | null = null
    let deps: AgentDeps | null = null
    let toolCallsTotal = 0
    let segments = 1
    const lockOwner = run.id
    handle.workspace_taken = false
    try {
      // the folder's one writer, in turn: queued and said so while another writer holds it, Stop-able there
      const joined = await this.takeWorkspace(run, handle, workspace)
      // what the run may claim as its own, kept before any request or tool: beside its conversation's commands, or
      // from a baseline of its own (a snapshot workspace: taken now, while it is the folder's one writer)
      await this.admitAttribution(run, handle, workspace, joined)
      handle.started_at = monotonic()
      const settings = modelSettings(cfg, handle.thinking, cacheKeyOf(session.id), this.offersProviderSearch(cfg))
      const resolved = resolveWindow(cfg, state.config.context_window_fallback_tokens)
      const order = handle.work_order
      const protectedPaths = [...state.config.protected_paths, ...((project.config.protected_paths as string[] | undefined) ?? []), ...(order !== null ? order.protected_paths : [])]
      const d = makeDeps({
        conn: state.conn, store: state.store, config: state.config, project, session, workspace, run_id: run.id, model_cfg: cfg,
        workspaces: state.workspaces, processes: state.processes, gate: state.gate,
        policy: workspace.target?.kind === 'ssh' ? new RemotePathPolicy(workspace, protectedPaths) : PathPolicy.forWorkspace(workspace.path, protectedPaths, workspaceAttached(project, workspace, { writable: session.grants.attached_write }), { temp: state.processes.ensureTemp(workspace.id), pinned: isDirect(workspace), ...rootPolicyOptions(session, workspace) }),
        emit: (event, data) => this.emit(handle, event, data), cancelled: () => handle.token.cancelled, cancel_signal: handle.token.signal,
        on_history: (messages) => {
          // the empty request a final answer opened for steers is no message until words go in it
          stashed = [...withoutOpenTail(messages)]
          // written to the row as it grows: a stop between requests or a crash keeps the response accepted and the
          // tool returns in hand, not only what the last request was sent with
          if (handle.meter !== null && !handle.done) this.persistProgress(handle, stashed, handle.meter, toolCallsTotal, segments)
        }, context: null,
        work_order: order, blocked_calls: handle.blocked_calls,
        watchable: handle.ui_task === null, watches: state.watches ?? null, computer: state.computer ?? null,
        ssh: state.ssh ? { hosts: state.ssh, remote: state.remote, api: () => state.director?.harness ?? null } : null,
        closing: () => handle.closing, locks: () => effectiveLocks(state.conn, session.id, project, order),
        lock_refusals: handle.lock_refusals, lock_violations: handle.lock_violations,
        ui_task: handle.ui_task, stop_reason: () => (handle.budget_exceeded !== null ? 'budget' : this.stopping ? 'interrupted' : 'cancelled'),
      })
      deps = d
      handle.notes = d.pending_notes
      // let in beside its conversation's commands: the turn is told which, by whom, and how they stand now (their output
      // is the existing output tool's to read: they are this session's)
      if (handle.attribution?.overlapped) {
        const lines = handle.attribution.background_execution_ids.map((xid) => {
          const x = repo.getExecution(state.conn, xid)
          return `${xid} (run ${x?.run_id ?? 'unknown'}, ${state.processes.isRunning(xid) ? 'still running' : x?.status ?? 'unknown'}): ${JSON.stringify((x?.command ?? '').slice(0, 120))}`
        })
        if (lines.length) d.pending_notes.push(text('context.background_commands', { commands: lines.join('; ') }))
      }
      handle.produced = d.produced
      // the tools every request of the conversation carries (its snapshot, schema v25); what the run may call now —
      // an order narrowed since, a role without the thread's tools — is refused at the call, never by a changed list
      const visible = handle.tool_snapshot ? [...handle.tool_snapshot.names].sort() : [...visibleToolNames({ order })].sort()
      d.tool_snapshot = handle.tool_snapshot
      d.tool_allowed = visibleToolNames({ order })
      const [loaded, handoff, note, seed] = this.loadHistory(handle, cfg)
      ownFrom = loaded?.length ?? 0
      const requestLimits = routeLimits(cfg)
      const keeper = new ContextKeeper({ window: resolved.window, output_reserve: outputReserve(settings), anchor: seed.anchor, trigger: seed.trigger, file_cost: routeFileCost(cfg) })
      d.context = keeper
      let history: ModelMessage[] | null = loaded
      let promptText: UserContent | null
      // the person's message (the context the app puts before it is its first piece); every other prompt this run
      // sends — a closing note, "Continue.", a reconnection note — is the app's
      let personPrompt: UserContent | null = null
      {
        // one snapshot of the project's instructions — the settings', the roots', and the subfolders' found in the
        // tree — the first message and the manifest read the same one; a continued conversation has them from its
        // first message and is told what changed since (a file rewritten or added, a source gone)
        const discovered = workspace.target?.kind === 'ssh' ? { shown: [] as InstructionFile[], more: [] as string[] } : discoverInstructions(d.policy, await state.workspaces.listFiles(workspace))
        const instructionFiles = workspace.target?.kind === 'ssh' ? await remoteInstructions(state.workspaces.requireRemoteFiles(), workspace, project.config.instructions as string | undefined)
          : [...projectInstructions(d.policy, project.config.instructions as string | undefined), ...discovered.shown]
        for (const f of instructionFiles) { d.instruction_scopes.add(f.source); d.instruction_versions.set(f.source, instructionFingerprint(f.text)) }
        d.instructions_undelivered = [...discovered.more]
        if (instructionFiles.some((f) => f.source !== SETTINGS_SOURCE)) d.instruction_scopes.add(FOLDER_RULE_SHOWN)
        const previous = history !== null && handle.resumes_run_id ? repo.getRun(state.conn, handle.resumes_run_id) : null
        // what the conversation was already shown (a folder entered, the rules shown before a command), at those
        // versions: not shown again unless it changed
        for (const shown of Array.isArray(previous?.manifest.instructions_shown) ? (previous!.manifest.instructions_shown as Record<string, unknown>[]) : []) {
          if (!d.instruction_scopes.has(String(shown.source))) { d.instruction_scopes.add(String(shown.source)); d.instruction_versions.set(String(shown.source), String(shown.sha256)) }
        }
        if (previous !== null && d.instruction_scopes.size) d.instruction_scopes.add(FOLDER_RULE_SHOWN)
        const built = this.buildPrompt(run, handle, d, { instructions: history === null ? instructionFiles : [], more: history === null ? discovered.more : [], fresh: history === null, previous })
        const { text: prompt, sources } = built
        const delta = previous !== null ? instructionDelta(previous.manifest, instructionFiles) : null
        if (delta !== null && (delta.changed.length || delta.removed.length)) {
          const lines = delta.changed.map((f) => text('context.project', { source: f.source, scope: f.scope, text: f.text }))
          if (delta.removed.length) lines.push(text('context.instructions_removed', { sources: delta.removed.join(', ') }))
          d.pending_notes.push(text('context.instructions_changed', { instructions: lines.join('\n') }))
        }
        const inputs = [...inputFingerprints(state.conn, state.store, { project_id: project.id, instruction_files: instructionFiles, order }),
          ...handle.mentions.map((m) => ({ kind: 'mention', ...m }))]
        if (note) d.pending_notes.push(note)
        const manifest = buildRunManifest({
          run_id: run.id, session_id: session.id, project_id: project.id,
          workspace: { id: workspace.id, path: workspace.path, branch: workspace.branch, base_commit: workspace.base_commit, kind: workspace.kind, tree_at_start: handle.attribution?.overlapped ? null : handle.attribution?.base_tree_sha ?? state.workspaces.liveOf(workspace).last_tree },
          instructions_text: INSTRUCTIONS, prompt, model_cfg: cfg, grants: session.grants, project_instruction_sources: sources,
          permissions: built.permissions, restrictions: built.restrictions,
          isolation: { ...state.isolation, diagnostics: [...state.isolation.diagnostics] }, budget: budgetLines(handle.budget), history_from: handle.resumes_run_id,
          handoff: handoff as unknown as Record<string, unknown> | null, tool_names: visible, work_order: order !== null ? dumpWorkOrder(order) : null,
          user_text: run.user_text, tool_rows: handle.tool_snapshot ? handle.tool_snapshot.rows : toolSchemaRows(visible), inputs,
          locks: d.locks() as unknown as Record<string, unknown>[], thinking: handle.thinking, thinking_sent: handle.thinking_sent,
        })
        if (workspace.target?.kind === 'ssh') { manifest.target = workspace.target; manifest.remote = workspace.remote }
        // the marker kept at admission goes on with the manifest (it is only ever widened)
        const kept = markerOf(repo.getRun(state.conn, run.id)?.manifest)
        if (kept !== null) manifest.background_attribution = kept
        if (handle.tool_snapshot) { manifest.tool_surface = handle.tool_snapshot.surface; manifest.tool_snapshot = { basis: handle.tool_snapshot.basis, sha256: handle.tool_snapshot.sha256 } }
        // where its commands run as it starts (schema v28): Full access is the host with no enforcement of the harness's —
        // `isolation` above is the sandbox's runtime, which then holds none of its commands (each execution says its own)
        const startAccess = this.commandAccessOf(d, order)
        manifest.access = startAccess === 'full' ? { mode: 'full', runtime: 'host', enforcement: 'none' } : { mode: 'sandbox', runtime: state.isolation.runtime, enforcement: state.isolation.enforcement }
        repo.setRunManifest(state.conn, run.id, manifest)
        this.emit(handle, 'run_started', {
          ...(handle.collab ? { collab: handle.collab } : {}),
          ...(handle.handover ? { handover: handle.handover } : {}),
          run_id: run.id, session_id: session.id, model: cfg.id, configured_model: cfg.model, provider: cfg.provider, endpoint: routeEndpoint(cfg),
          workspace_id: workspace.id, workspace_path: workspace.path, resumes_run_id: handle.resumes_run_id, handoff, context_threshold_tokens: keeper.threshold,
          context_window: resolved.window, context_window_source: resolved.source, context_window_known: resolved.known, tools: visible, isolation: state.isolation.enforcement, access: manifest.access,
          label: handle.label, work_order: order !== null ? dumpWorkOrder(order) : null,
          thinking: handle.thinking, thinking_sent: handle.thinking_sent, running_commands: this.runningCommands(workspace.id),
        })
        this.emitUiTask(handle)
        // the attached images ride with the person's words as references; their bytes join only at the provider
        promptText = run.attachments.length ? [...built.content, ...run.attachments.map(attachmentPiece)] : built.content
        personPrompt = promptText
        if (handle.budget.wall_clock_s && handle.deadline_timer === null) {
          handle.deadline_timer = setTimeout(() => this.stopForBudget(handle, `wall_clock_s > ${handle.budget.wall_clock_s}`), handle.budget.wall_clock_s * 1000)
        }
      }
      // the working view sits at the provider boundary: the loop's history, the stash and the record keep the whole
      // record; the request handed to the provider is the record from its last compaction on, carried to the route's
      // provider (and the estimate recorded is the keeper's prediction for it)
      const images = attachmentReader((id) => repo.getAsset(state.conn, id), (rel) => state.store.read(rel), project.id, session.id)
      // a legacy (native-v1) PDF or video the route does not take itself is kept in the workspace's temporary folder,
      // where the run's tools reach it, and the request names where; a reference (ref-v1) is named where it stands
      // — by the app's confined placer, once per file (its bytes read only then); a refusal is this run's visible event
      const placeDir = join(state.processes.ensureTemp(workspace.id), 'attachments')
      const legacyPlace = this.legacyPlacer.placer(placeDir)
      const placeReported = new Set<string>()
      const placed: AttachmentPlacer = (file, load) => {
        if (workspace.target?.kind === 'ssh') throw new Error('Remote workspace attachments cannot be placed at a local path; native model attachments only.')
        const path = legacyPlace(file, load)
        const outcome = this.legacyPlacer.outcome(placeDir, file)
        if (outcome?.status === 'refused' && !placeReported.has(path)) {
          placeReported.add(path)
          this.emit(handle, 'attachment_refused', { scope: 'placement', name: file.name, path, reason: outcome.reason })
        }
        return path
      }
      // the session's references: read only when this route takes one natively, bounded and checked, kept for the run
      const refs = refAccess({ lookup: (id) => repo.getAsset(state.conn, id), store: state.store, project: project.id, session: session.id, cache_bytes: requestLimits.request_bytes, local: this.localAccess(project.id) })
      let baseModel: Model = new ContextView(new AttachmentHydration(this.resolveModel(cfg), images, cfg.capabilities, placed, { limits: requestLimits, refs }), this.targetSystem(cfg))
      const slot = state.slots.slotFor(cfg.scope, cfg.concurrency)
      if (slot !== null) baseModel = new Serialized(baseModel, slot, run.id, () => handle.token.cancelled, (e, dd) => this.emit(handle, e, dd))
      meter = new UsageMeter(baseModel, cfg, run.id, (rec) => repo.insertModelRequest(state.conn, rec), (e, dd) => this.emit(handle, e, dd),
        null, () => keeper.lastPrediction()?.tokens ?? null)
      handle.meter = meter
      {
        const m = meter
        d.steering = this.steeringPort(handle, keeper, (out, write) => {
          // the words are in the record, and said delivered, together: a crash leaves both or neither
          state.conn.transaction(() => {
            stashed = [...out]
            this.persistProgress(handle, stashed, m, toolCallsTotal, segments)
            write()
          })
        }, () => m.totals.requests + 1)
      }
      // the next segment's first request continues a broken stream's kept words: no steer joins it
      let holdInput = false
      let recoveries = 0
      let outageRecoveries = 0
      let contextRecoveries = 0
      let closingTurns = 0
      let limits = this.limits(handle)
      for (;;) {
        // every segment (a request boundary, a recovery) starts with what the budget has left; a closing turn keeps its one request
        if (handle.closing === null) limits = this.limits(handle)
        let segmentToolCalls = 0
        try {
          const promptOrigin: PromptOrigin = promptText !== null && promptText === personPrompt && !handle.wake ? { origin: 'person', app_pieces: [0] } : APP_ORIGIN
          const mapper = new RunEventMapper()
          const hold = holdInput
          holdInput = false
          for await (const event of this.agent.runStreamEvents({ prompt: promptText, promptOrigin, deps: d, model: meter, modelSettings: settings, messageHistory: history, usageLimits: limits, token: handle.token, holdInput: hold })) {
            for (const [name, data] of mapper.map(event)) {
              if (name === 'tool_call') { segmentToolCalls += 1; toolCallsTotal += 1; recoveries = 0 }
              this.emit(handle, name, data)
            }
            if (event.type === 'result') {
              const result = event.result
              handle.final_text = joinedAnswer(result.allMessages(), result.output)
              handle.answer_end = result.incomplete
              historyJson = result.allMessagesJson()
              usage = { ...meter.totalsWithTokens(), tool_calls: toolCallsTotal, segments, ...historyMetrics(result.allMessages(), historyJson) }
              status = 'done'
            }
          }
          if (status === 'done' && handle.closing && closingTurns === 0 && d.closing_requests === 0 && handle.answer_end === null) {
            // the budget line was crossed by the segment's last tool call and the model's final words came from a
            // request that still had tools: one closing turn (the report, no tool)
            closingTurns += 1
            history = stashed.length ? closeDanglingToolCalls([...stashed]) : null
            promptText = text('app.closing', { limit: handle.closing })
            d.pending_notes.length = 0
            limits = { request_limit: 1 }
            this.emit(handle, 'run_continued', { reason: 'closing_turn', note: handle.closing })
            continue
          }
          if (status === 'done' && handle.answer_end !== null && handle.answer_end.reason !== 'content_filter') {
            // an answer that did not end normally after the bounded continuations: its words are kept (final_text),
            // and the run says it has no complete answer rather than passing it off as one
            status = 'error'
            error = `incomplete_answer: ${answerEndLine(handle.answer_end)}`
            this.emit(handle, 'error', { message: error, kind: 'incomplete', status_code: null, model: cfg.id })
          }
          break
        } catch (e) {
          if (e instanceof UsageLimitExceeded) {
            const over = this.budgetLine(handle)
            if (over && !handle.closing) {
              // a hard line: one closing turn from the stash, then the end
              this.beginClosing(handle, over)
              history = stashed.length ? closeDanglingToolCalls([...stashed]) : null
              promptText = text('app.closing', { limit: over })
              d.pending_notes.length = 0
              limits = { request_limit: 1 }
              closingTurns += 1
              this.emit(handle, 'run_continued', { reason: 'closing_turn', note: over })
              continue
            }
            if (handle.closing && closingTurns === 0 && d.closing_requests === 0 && stashed.length && !handle.token.cancelled) {
              // the line was reached inside a response (its later calls cut off) before the closing request was made:
              // the calls not run are answered as such, and the closing request is made now — once
              history = closeDanglingToolCalls([...stashed], { status: 'refused', reason: text('refusal.budget_line', { limit: handle.closing }) })
              promptText = text('app.closing', { limit: handle.closing })
              d.pending_notes.length = 0
              limits = { request_limit: 1 }
              closingTurns += 1
              this.persistProgress(handle, history, meter, toolCallsTotal, segments)
              this.emit(handle, 'run_continued', { reason: 'closing_turn', note: handle.closing })
              continue
            }
            if (handle.closing || handle.token.cancelled || segmentToolCalls === 0 || !stashed.length) {
              if (handle.closing) handle.budget_exceeded = handle.closing + ' (the closing turn filed no report)'
              throw e
            }
            segments += 1
            history = closeDanglingToolCalls([...stashed])
            // the request counter is the harness's own: the conversation goes on from the tool returns it ends with
            promptText = isRequest(history[history.length - 1]!) ? null : 'Continue.'
            this.persistProgress(handle, history, meter, toolCallsTotal, segments)
            this.emit(handle, 'run_continued', { reason: 'request_boundary', segment: segments, requests_before: meter.totals.requests })
            continue
          }
          if (e instanceof RunCancelled || e instanceof QueueCancelled) throw e
          // a tool stopped the run (an effect whose outcome is unknown): never retried, continued or recovered here
          if (e instanceof RunHalted) throw e
          // a failure that came with or after the Stop (a request the Stop broke, a wait it cut short) is the Stop
          if (handle.token.cancelled) throw stoppedAfter(e)
          const kind = classifyError(e)
          if (kind === 'transport' && recoveries < TRANSPORT_RECOVERY_MAX && stashed.length && !handle.token.cancelled) {
            recoveries += 1
            const delay = this.transport_backoff_s[Math.min(recoveries - 1, this.transport_backoff_s.length - 1)]!
            await this.backoff(handle, delay)
            if (handle.token.cancelled) throw stoppedAfter(e)
            history = closeDanglingToolCalls([...stashed])
            // what the model had already said stays said: its words so far join the conversation and it is asked for
            // the rest, not for the whole answer again
            const partial = partialTextOf(e)
            if (partial !== null) history = [...history, modelResponse([textPart(partial)], { model_name: cfg.model })]
            promptText = PROMPT_TEXT['app.reconnected'] + (partial !== null ? ` ${CUT_OFF_NOTE}` : '')
            holdInput = partial !== null
            this.persistProgress(handle, history, meter, toolCallsTotal, segments)
            this.emit(handle, 'run_continued', { reason: 'transport_error', error: redactSecrets(describeException(e)), recovery: recoveries, of: TRANSPORT_RECOVERY_MAX, backoff_s: delay,
              kept_chars: partial?.length ?? 0 })
            continue
          }
          if (kind === 'context_overflow' && !(e instanceof ContextOverflowUnrecovered) && contextRecoveries < CONTEXT_RECOVERY_MAX
            && stashed.length && !handle.token.cancelled && d.context !== null && d.closing() === null) {
            // the provider refused the request for its size: once, the keeper makes a smaller working view before the
            // next request (or ends the run) — the same request is never sent again as it was, no tool runs again
            contextRecoveries += 1
            d.context.recoverFromOverflow(redactSecrets(describeException(e)))
            history = closeDanglingToolCalls([...stashed])
            promptText = isRequest(history[history.length - 1]!) ? null : 'Continue.'
            this.persistProgress(handle, history, meter, toolCallsTotal, segments)
            this.emit(handle, 'run_continued', { reason: 'context_overflow', error: redactSecrets(describeException(e)), recovery: contextRecoveries, of: CONTEXT_RECOVERY_MAX })
            continue
          }
          if (kind === 'outage' && outageRecoveries < OUTAGE_RECOVERY_MAX && stashed.length && !handle.token.cancelled) {
            outageRecoveries += 1
            const delay = this.outage_backoff_s[Math.min(outageRecoveries - 1, this.outage_backoff_s.length - 1)]!
            await this.backoff(handle, delay)
            if (handle.token.cancelled) throw stoppedAfter(e)
            history = closeDanglingToolCalls([...stashed])
            promptText = PROMPT_TEXT['app.reconnected']
            this.persistProgress(handle, history, meter, toolCallsTotal, segments)
            this.emit(handle, 'run_continued', { reason: 'provider_outage', error: redactSecrets(describeException(e)), recovery: outageRecoveries, of: OUTAGE_RECOVERY_MAX, backoff_s: delay })
            continue
          }
          throw e
        }
      }
    } catch (e) {
      if (e instanceof RunCancelled || e instanceof QueueCancelled) {
        status = 'cancelled'
        await state.processes.waitAllForRun(run.id, 5)
        // the words the stopped answer had shown stay in the record, as the response they were (after its request)
        const partial = partialTextOf(e)
        const last = stashed[stashed.length - 1]
        if (partial !== null && last !== undefined && isRequest(last)) stashed = [...stashed, modelResponse([textPart(partial)], { model_name: cfg.model })]
        historyJson = this.stashJson(stashed)
        usage = this.usageFrom(meter, toolCallsTotal, segments, historyJson, stashed)
      } else if (e instanceof UsageLimitExceeded) {
        status = 'error'
        error = `budget_exceeded: ${handle.budget_exceeded ?? describeException(e)}`
        historyJson = this.stashJson(stashed)
        usage = this.usageFrom(meter, toolCallsTotal, segments, historyJson, stashed)
        this.emit(handle, 'error', { message: error, kind: 'budget' })
      } else if (e instanceof RunHalted) {
        // no request after the halting call: the record ends with its answer and the calls it kept from running
        status = 'error'
        error = `remote_outcome_unknown: ${redactSecrets(e.reason)}`
        historyJson = this.stashJson(stashed)
        usage = this.usageFrom(meter, toolCallsTotal, segments, historyJson, stashed)
        this.emit(handle, 'error', { message: error, kind: 'remote_unknown', status_code: null, model: cfg.id })
      } else if (handle.closing && e instanceof UnexpectedModelBehavior) {
        // the closing turn has no tool; a model that keeps calling one never reports: the budget line stands
        status = 'error'
        handle.budget_exceeded = `${handle.closing} (the closing turn kept calling tools)`
        historyJson = this.stashJson(stashed)
        usage = this.usageFrom(meter, toolCallsTotal, segments, historyJson, stashed)
        this.emit(handle, 'error', { message: `budget_exceeded: ${handle.budget_exceeded}`, kind: 'budget' })
      } else {
        status = 'error'
        error = redactSecrets(describeException(e))
        historyJson = this.stashJson(stashed)
        usage = this.usageFrom(meter, toolCallsTotal, segments, historyJson, stashed)
        // what kind of failure, for the page to say what it means and what to do; the model's route beside it
        const found = diagnose(e)
        this.emit(handle, 'error', { message: error, kind: found.kind, status_code: found.status_code, model: cfg.id })
      }
    } finally {
      if (deps !== null) {
        handle.blocked_calls = deps.blocked_calls
        handle.lock_refusals = deps.lock_refusals
        handle.lock_violations = deps.lock_violations
        // what the provider counted for the last request of this record on this route: the next run's anchor; and the
        // line a compaction that freed too little moved the next one to, so the next run does not compact at once
        deps.context?.observeLast(stashed, ownFrom)
        const anchor = deps.context?.currentAnchor() ?? null
        if (anchor !== null) usage = { ...usage, context_anchor: anchor }
        const trigger = deps.context?.currentTrigger() ?? null
        if (trigger !== null) usage = { ...usage, context_trigger: trigger }
      }
      handle.notes = null
      usage = { ...usage, model: cfg.id, configured_model: cfg.model }
      if (deps !== null) this.sealShownInstructions(handle, deps.instruction_versions)
      // the pages this run held (computer use) are free the moment it ends, not after their quiet lease
      if (deps !== null && deps.computer_used && deps.computer !== null) void deps.computer.request('/computer/release', { owner: run.id }).catch(() => undefined)
      try {
        await this.finalize(handle, status, historyJson, usage, error)
      } finally {
        // the commands the run leaves running still write the folder: it stays held for them until each exits
        try {
          if (handle.workspace_taken) this.leaseRunCommands(workspace.id, run.id)
        } catch (e) {
          // the records are gone (the harness is closing): nothing is left to hold the folder for
          console.warn(`the commands run ${run.id} left running could not be read: ${(e as Error).message}`)
        } finally {
          if (workspace.target?.kind === 'ssh') {
            // no longer the lease's foreground writer; the lease itself goes only once nothing keeps it — no run of its
            // conversation holds it, no job on its root is live — asked again when the jobs live now have ended (a
            // later run that took the lease over meanwhile keeps it: the check is made then, not now)
            const files = state.workspaces.requireRemoteFiles()
            const ended = files.endRun(run.id)
            const releaseRemote = async () => { try { if (ended !== null) await files.releaseIfIdle(ended) } catch { /* durable lease stays held on unknown effects; reconnect reconciles it */ } }
            const pending = ended !== null ? files.liveJobIds(ended).filter((id) => state.processes.isRunning(id)) : []
            if (pending.length) void Promise.all(pending.map((id) => state.processes.wait(id, null))).then(releaseRemote).catch(() => {})
            else await releaseRemote()
          }
          state.locks.release(workspace.id, lockOwner)
        }
      }
    }
  }

  /** Take the run's folder as its one writer. Free: at once, no event. Held: the run is queued — its row and handle
   *  say so, run_queued names who holds the folder and where the run stands (again when that changes) — until every
   *  writer ahead has let go; then it runs (slot_acquired). Stopped while queued, it leaves the line at once and ends
   *  cancelled without run_started and without ever holding the folder. */
  private async takeWorkspace(run: Run, handle: RunHandle, workspace: Workspace): Promise<CohortJoin | null> {
    const state = this.state
    const since = monotonic()
    let queued = false
    // the run's conversation, as its own records say it (none: it joins nobody's commands)
    const cohort = cohortOfRun(state.conn, run.id)
    let joined: CohortJoin | null = null
    await state.locks.acquire(workspace.id, run.id, {
      kind: 'run', run_id: run.id, session_id: run.session_id, signal: handle.token.signal, cancelled: () => handle.token.cancelled,
      cohort: cohort !== null && cohort.workspace_id === workspace.id ? cohortKeyOf(cohort) : null,
      // let in beside its conversation's commands: the marker is kept before the run is let in (a marker not kept is
      // no handoff — the run then waits in line as any writer does)
      onJoined: (j) => {
        if (j.inherited_execution_ids.length) recordMarker(state.conn, run.id, { overlapped: true, background_execution_ids: j.inherited_execution_ids, inherited_from_run_ids: j.inherited_from_run_ids })
        joined = j
      },
      onQueued: (waiting) => {
        if (handle.done || handle.finalizing) return
        if (!queued) {
          queued = true
          repo.setRunStatus(state.conn, run.id, 'queued')
          handle.status = 'queued'
        }
        this.emit(handle, 'run_queued', { ...waiting, message: queuedMessage(waiting) })
      },
    })
    // handed the folder as it was stopped: nothing ran under it, and nothing will (the finally lets it go at once)
    if (handle.token.cancelled) throw new LockWaitCancelled(`run ${run.id} was stopped before it started`)
    if (queued) {
      repo.setRunStatus(state.conn, run.id, 'running')
      handle.status = 'running'
      this.emit(handle, 'slot_acquired', { scope: `workspace:${workspace.id}`, reason: 'workspace_lock', workspace_id: workspace.id, waited_ms: Math.round((monotonic() - since) * 1000) })
    }
    handle.workspace_taken = true
    if (workspace.target?.kind === 'ssh') {
      let remoteQueued = false
      await state.workspaces.requireRemoteFiles().holdRun(workspace, run.id, () => handle.token.cancelled, owner => {
        if (remoteQueued) return
        remoteQueued = true; handle.status = 'queued'; repo.setRunStatus(state.conn, run.id, 'queued')
        this.emit(handle, 'run_queued', { workspace_id: workspace.id, blocking_owner: owner, blocking_kind: 'run', reason: 'remote_writer', position: 1, message: 'Waiting for the remote project writer.' })
      }, cohort !== null && cohort.workspace_id === workspace.id ? cohort : null)
      if (handle.token.cancelled) throw new LockWaitCancelled('The run was stopped while waiting for its remote folder.')
      if (remoteQueued) { handle.status = 'running'; repo.setRunStatus(state.conn, run.id, 'running'); this.emit(handle, 'slot_acquired', { scope: `remote:${workspace.id}`, workspace_id: workspace.id, reason: 'remote_writer' }) }
    }
    return joined
  }

  /** The run's attribution marker, kept at admission (before any request or tool). Let in beside its conversation's
   *  commands: overlapped, their ids. A folder edited in place: its tool journal is its record. A snapshot workspace let
   *  in alone: the tree as it found it is its baseline — and when that differs from the latest checkpoint (or the base),
   *  what was already there is pinned as a workspace checkpoint of no run, so nothing earlier is ever counted as this
   *  run's. A baseline that cannot be taken makes the run's attribution unavailable (said, never guessed). */
  private async admitAttribution(run: Run, handle: RunHandle, workspace: Workspace, joined: CohortJoin | null): Promise<void> {
    const conn = this.state.conn
    if (joined !== null && joined.inherited_execution_ids.length) {
      // kept as it was let in (takeWorkspace): read back
      handle.attribution = recordMarker(conn, run.id, {})
      return
    }
    if (isDirect(workspace)) { handle.attribution = recordMarker(conn, run.id, {}); return }
    const workspaces = this.state.workspaces
    try {
      const snap = await workspaces.snapshot(workspace)
      const latest = repo.latestCheckpoint(conn, workspace.id)
      const latestTree = latest !== null ? repo.getSnapshot(conn, latest.snapshot_id)?.tree_sha ?? null : await workspaces.git.treeOf(workspace.path, workspace.base_commit)
      let baseline: string | null = null
      if (latestTree !== snap.tree_sha) {
        // pinned as any checkpoint is: a tree that breaks a hard lock is refused (and the run then has no baseline)
        const session = repo.getSession(conn, run.session_id)
        const project = repo.getProject(conn, run.project_id)
        const locks = session !== null && project !== null ? effectiveLocks(conn, session.id, project, handle.work_order) : []
        const cp = await workspaces.checkpoint(workspace, null, `the workspace as run ${run.id} found it`, { expected_tree: snap.tree_sha, locks })
        baseline = cp.id
      }
      handle.attribution = recordMarker(conn, run.id, { base_tree_sha: snap.tree_sha, baseline_checkpoint_id: baseline })
    } catch (error) {
      const refused = error instanceof LockViolation
      console.warn(`the baseline of run ${run.id} could not be taken: ${(error as Error).message}`)
      handle.attribution = recordMarker(conn, run.id, { unavailable_reason: refused ? 'baseline_lock_refused' : 'baseline_unavailable' })
    }
  }

  /** The run's commands still running in its folder (or exited and not yet finished: their rows not ended). */
  private liveCommandsOf(workspaceId: string, runId: string): string[] {
    const processes = this.state.processes
    const xids = new Set(processes.runningInWorkspace(workspaceId).filter((xid) => repo.getExecution(this.state.conn, xid)?.run_id === runId))
    for (const x of repo.listExecutions(this.state.conn, { run_id: runId })) if (x.workspace_id === workspaceId && (x.status === 'running' || x.status === 'queued')) xids.add(x.id)
    return [...xids]
  }

  /** The run's commands still running in its folder as it ends: each holds the folder until it has really ended
   *  (exited, its logs sealed, its row finished), so the next writer never starts under a command still writing. */
  private leaseRunCommands(workspaceId: string, runId: string): void {
    const processes = this.state.processes
    // still running, or exited and not yet finished (its strays reaped, its logs sealed): its row is not ended yet
    // wait(xid, null) is already settled for one that ended meanwhile: its pin goes on the next turn, never kept. Only
    // a command this run's own tool started lets a later run of its conversation in beside it (an approval's, or one of
    // unknown origin, does not)
    for (const xid of this.liveCommandsOf(workspaceId, runId)) {
      const x = repo.getExecution(this.state.conn, xid)
      this.state.locks.holdUntil(workspaceId, runId, xid, processes.wait(xid, null), { run_id: runId, joinable: x !== null && x.run_id === runId && launcherOf(x) === 'run' })
    }
  }

  /** Where a queued run waits, for the person and the director: in place of the run_queued event's data. */
  waitingOf(runId: string): LockWaiting | null {
    return this.state.locks.waitingOf(runId)
  }

  /** What ChatGPT on the web is sent: the words of a conversation and nothing of the environment it has no tool for
   *  (no folders, restrictions, limits, referenced files or date) — a relay's or an interaction's note (the roster,
   *  the step) as its context, then the task as every participant reads it (the person's words, or the harness's
   *  whole message of a later step: the step's note, the packets it is handed, the person's notes). */
  private chatGptPrompt(run: Run, handle: RunHandle): { text: string; content: UserContent; origin: PromptOrigin } {
    const context = [handle.relay?.note, handle.interaction?.note].filter((p): p is string => !!p).join('\n')
    const task = this.taskText(run, handle)
    const pieces = [context, task].filter((p) => p.trim())
    // the harness's whole message (a later step) is the app's; else the person's words, the context its app piece
    const origin: PromptOrigin = handle.relay?.harness_message || handle.interaction?.harness_message || handle.wake ? APP_ORIGIN : { origin: 'person', app_pieces: context.trim() ? [0] : [] }
    return { text: pieces.join('\n'), content: pieces, origin }
  }

  /** The ChatGPT conversation a run on ChatGPT on the web goes on in: the one its participant spoke in last — the
   *  conversation the run it continues had (back over earlier runs of the page that never reached one) — or none,
   *  when the conversation it continues is not ChatGPT's (the page then opens a new one). */
  private chatGptConversationOf(resumes: string | null): string | null {
    const walked = new Set<string>()
    for (let id = resumes; id !== null && !walked.has(id);) {
      walked.add(id)
      const run = repo.getRun(this.state.conn, id)
      if (run === null || !isChatGptWeb(run.model)) return null
      const chatgpt = run.manifest.chatgpt as Record<string, unknown> | undefined
      if (typeof chatgpt?.conversation_url === 'string' && chatgpt.conversation_url) return chatgpt.conversation_url
      id = run.resumes_run_id
    }
    return null
  }

  /** A run on ChatGPT on the web: its message typed into the desktop app's ChatGPT page through the bridge (no
   *  connector: ChatGPT answers with its own abilities on the words it is handed), one answer forming at a time
   *  (the route's slot: a run behind another is queued and says so), its progress streamed as the page shows it,
   *  its answer — with the pictures the page kept, as the session's attachments — the run's final text. The record
   *  continues the conversation it resumed with this exchange (a later run of another route reads it as a
   *  handoff); the ChatGPT conversation's address is kept in the manifest, where the participant's next run finds
   *  it. No tool of the harness runs, no token count is known (the ChatGPT plan is not metered here); a Stop ends
   *  the wait and clicks the page's stop button. */
  private async executeChatGpt(run: Run, handle: RunHandle, cfg: ModelConfig): Promise<void> {
    const state = this.state
    const bridge = state.chatgpt
    const conn = state.conn
    let status = 'error'
    let error: string | null = null
    let historyJson: string | null = null
    let sent = false
    // a /send was made: the page may hold the message (uploading it, typing it) even when no reply said so
    let asked = false
    const usage: Record<string, unknown> = { requests: 0, tool_calls: 0, segments: 1, cost_status: 'unknown', cost_source: 'the ChatGPT plan, not metered here' }
    const manifestOf = () => repo.getRun(conn, run.id)?.manifest ?? {}
    const note = (chatgpt: Record<string, unknown>) => {
      const manifest = manifestOf()
      repo.setRunManifest(conn, run.id, { ...manifest, chatgpt: { ...(manifest.chatgpt as Record<string, unknown> | undefined), ...chatgpt } })
    }
    handle.started_at = monotonic()
    try {
      const continued = this.chatGptConversationOf(handle.resumes_run_id)
      const { text: prompt, content, origin } = this.chatGptPrompt(run, handle)
      const model = bridge.model()
      const earlier = this.recordOf(handle.resumes_run_id)
      const session = repo.getSession(conn, run.session_id)!
      const workspace = repo.getWorkspace(conn, run.workspace_id!)!
      repo.setRunManifest(conn, run.id, buildRunManifest({
        run_id: run.id, session_id: session.id, project_id: run.project_id,
        workspace: { id: workspace.id, path: workspace.path, branch: workspace.branch, base_commit: workspace.base_commit, kind: workspace.kind, tree_at_start: null },
        instructions_text: '', prompt, model_cfg: cfg, grants: session.grants, project_instruction_sources: [], isolation: { ...state.isolation, diagnostics: [...state.isolation.diagnostics] },
        budget: budgetLines(handle.budget), history_from: handle.resumes_run_id, handoff: null, tool_names: [], work_order: handle.work_order !== null ? dumpWorkOrder(handle.work_order) : null,
        user_text: run.user_text, inputs: [], locks: [], thinking: null,
      }))
      note({ bridge: bridge.url, conversation_url: continued, new_conversation: continued === null, chatgpt_model: model })
      this.emit(handle, 'run_started', {
        run_id: run.id, session_id: session.id, model: cfg.id, configured_model: cfg.model, provider: cfg.provider, endpoint: routeEndpoint(cfg),
        workspace_id: workspace.id, workspace_path: workspace.path, resumes_run_id: handle.resumes_run_id, handoff: null, context_threshold_tokens: null,
        context_window: null, context_window_source: cfg.window_source, context_window_known: false, tools: [], isolation: state.isolation.enforcement,
        label: handle.label, work_order: handle.work_order !== null ? dumpWorkOrder(handle.work_order) : null, thinking: null,
        chatgpt: { conversation_url: continued, new_conversation: continued === null },
      })
      this.emitUiTask(handle)
      if (handle.budget.wall_clock_s && handle.deadline_timer === null) {
        handle.deadline_timer = setTimeout(() => this.stopForBudget(handle, `wall_clock_s > ${handle.budget.wall_clock_s}`), handle.budget.wall_clock_s * 1000)
      }
      // the message's images, read from the session's store before anything goes: the page uploads them with the words
      const readImage = attachmentReader((id) => repo.getAsset(conn, id), (rel) => state.store.read(rel), run.project_id, run.session_id)
      const images = run.attachments.map((image) => {
        if ('file_kind' in image) throw new ChatGptWebError('refused', 'ChatGPT web bridge file attachment support is unknown; file not sent')
        const bytes = readImage(image)
        if (bytes === null) throw new ChatGptWebError('refused', `the image ${image.name} could not be read from the session's attachments`)
        return { name: image.name, media_type: image.media_type, data_base64: Buffer.from(bytes).toString('base64') }
      })
      const slot = state.slots.slotFor(cfg.scope, 1)!
      const onWait = (behind: string[]) => {
        repo.setRunStatus(conn, run.id, 'queued')
        handle.status = 'queued'
        this.emit(handle, 'run_queued', { reason: `ChatGPT answers one message at a time; ${behind.length} ${behind.length === 1 ? 'run is' : 'runs are'} ahead on its page`, behind, scope: cfg.id })
      }
      const answer = await slot.hold(run.id, () => handle.token.cancelled, onWait, async () => {
        if (handle.status === 'queued') {
          repo.setRunStatus(conn, run.id, 'running')
          handle.status = 'running'
          this.emit(handle, 'slot_acquired', { scope: cfg.id })
        }
        const deadline = monotonic() + bridge.timeout_ms / 1000
        const signal = handle.token.signal
        // the message, sent once the page is free (the person, or a director on the page, may be using it)
        let busy = false
        for (;;) {
          if (handle.token.cancelled) throw new RunCancelled()
          asked = true
          const out = await this.askBridge(() => bridge.request('POST', '/send', {
            text: prompt, turn_id: run.id, new_conversation: continued === null, ...(continued !== null ? { conversation_url: continued } : {}), ...(model !== null ? { model } : {}),
            ...(images.length ? { images } : {}),
          }, signal, SEND_TIMEOUT_MS), handle, true)
          if (out.accepted === true) {
            sent = true
            usage.requests = 1
            const url = urlOf(out.conversation)
            if (url !== null) note({ conversation_url: url })
            // sent, and not recorded by the bridge: after a restart of the desktop app it cannot tell this went
            if (typeof out.journal_error === 'string') note({ journal_error: out.journal_error })
            break
          }
          const reason = typeof out.reason === 'string' ? out.reason : 'not accepted'
          if (reason === 'needs_login') throw new ChatGptWebError('signin', 'ChatGPT is not signed in on the desktop app\'s ChatGPT page: sign in there, then run this again')
          if (reason === 'page_not_loaded') throw new ChatGptWebError('unreachable', `the desktop app's ChatGPT page did not load (${typeof out.detail === 'string' ? out.detail : 'no reason given'}); it loads again by itself — or reload it on the ChatGPT card — then run this again`)
          if (reason === 'conversation_not_found') throw new ChatGptWebError('refused', `the ChatGPT conversation this participant spoke in (${continued}) did not open on the page; it may have been deleted`)
          if (reason === 'images_not_attached') throw new ChatGptWebError('refused', `the ChatGPT page did not take the message's files (${typeof out.detail === 'string' ? out.detail : 'no reason given'}); nothing was sent — the app's log says what the page showed`)
          if (reason === 'no_composer') throw new ChatGptWebError('refused', "the ChatGPT page is signed in but shows no message box the app knows (the web app may have changed); nothing was sent — the app's log says what the page showed")
          // submitted with no sign that it went: the bridge never sends the turn a second time, so neither is it asked to
          if (reason === 'not_sent') throw new ChatGptWebError('refused', "the ChatGPT page showed no sign that the message went (no answer began, the page did not move); it is not sent again — look at the ChatGPT card, and the app's log says what the page showed")
          if (reason === 'unconfirmed') throw new ChatGptWebError('refused', `the ChatGPT page was given this message before, with no sign that it went; it is not sent again — look at the ChatGPT card (${typeof out.detail === 'string' ? out.detail : 'no detail'})`)
          if (reason === 'journal_unusable') throw new ChatGptWebError('refused', `the desktop app's ChatGPT page sends nothing while it cannot tell which messages went; nothing was sent (${typeof out.detail === 'string' ? out.detail : 'its turn journal is not usable'})`)
          if (reason === 'turn_conflict') throw new ChatGptWebError('refused', 'the desktop app\'s ChatGPT page has this run as another message; nothing was sent')
          if (reason !== 'generating' && reason !== 'page_in_use') throw new ChatGptWebError('refused', `the ChatGPT page did not take the message (${reason})`)
          if (!busy) {
            busy = true
            this.emit(handle, 'run_queued', { reason: reason === 'page_in_use' ? `an agent is using ChatGPT's page (computer use, ${typeof out.detail === 'string' ? out.detail : 'another run'}); this message goes when it lets go` : "ChatGPT's page is answering another message; this one goes when it is free", scope: cfg.id })
          }
          if (monotonic() > deadline) throw new ChatGptWebError('timeout', `ChatGPT's page stayed busy with another message for ${Math.round(bridge.timeout_ms / 60_000)} minutes`)
          await this.backoff(handle, bridge.busy_retry_ms / 1000)
        }
        // the answer, polled while it forms: its reasoning and its words stream to the thread as the page shows them
        const shown = { thinking: '', text: '' }
        for (;;) {
          if (handle.token.cancelled) throw new RunCancelled()
          const out = await this.askBridge(() => bridge.request('GET', `/answer?turn_id=${encodeURIComponent(run.id)}`, undefined, signal), handle)
          const url = urlOf(out.conversation)
          if (url !== null && url !== (manifestOf().chatgpt as Record<string, unknown> | undefined)?.conversation_url) note({ conversation_url: url })
          if (out.status === 'lost') throw new ChatGptWebError('refused', `ChatGPT's answer cannot be read back: ${typeof out.detail === 'string' ? out.detail : 'the desktop app restarted after the message went'}; it is not sent again`)
          if (out.status === 'unknown') throw new ChatGptWebError('refused', "the desktop app's ChatGPT page does not know this message (it may be another app's, or no longer kept); its answer, if any, is on the ChatGPT card")
          if (out.status === 'done' && typeof out.text === 'string' && out.text.trim()) return out
          const progress = out.progress && typeof out.progress === 'object' ? (out.progress as Record<string, unknown>) : null
          if (progress !== null) {
            const thinking = nextPiece(shown.thinking, typeof progress.thinking === 'string' ? progress.thinking : '')
            if (thinking !== null) this.emit(handle, 'thinking_delta', thinking)
            const words = nextPiece(shown.text, typeof progress.text === 'string' ? progress.text : '')
            if (words !== null) this.emit(handle, 'text_delta', words)
            shown.thinking = typeof progress.thinking === 'string' ? progress.thinking : shown.thinking
            shown.text = typeof progress.text === 'string' ? progress.text : shown.text
          }
          if (monotonic() > deadline) throw new ChatGptWebError('timeout', `ChatGPT gave no answer within ${Math.round(bridge.timeout_ms / 60_000)} minutes; what it wrote is on its page`)
          await this.backoff(handle, bridge.poll_ms / 1000)
        }
      })
      const thinking = typeof answer.thinking === 'string' ? answer.thinking.trim() : ''
      const kept = keepAnswerImages(state, session, bridgeImagesOf(answer.images), `run ${run.id}`)
      const final = withAnswerImages(String(answer.text).trim(), kept)
      if (thinking) this.emit(handle, 'thinking_block', { text: thinking })
      this.emit(handle, 'text_block', { text: final })
      handle.final_text = final
      const chatModel = typeof answer.model === 'string' && answer.model ? answer.model : null
      note({ answered_by: chatModel, images: kept.length })
      historyJson = JSON.stringify([...earlier,
        modelRequest([userPrompt(run.attachments.length ? [...content, ...run.attachments.map(attachmentPiece)] : content, origin)]),
        modelResponse([...(thinking ? [thinkingPart(thinking)] : []), textPart(final)], { model_name: chatModel ?? cfg.model, provider_name: cfg.id }),
      ])
      status = 'done'
    } catch (e) {
      if (e instanceof RunCancelled || e instanceof QueueCancelled || handle.token.cancelled) {
        status = 'cancelled'
        // the page stops forming the answer nobody waits for, and a message still on its way to the page is dropped
        // (the bridge leaves a message it moved on from alone); what the page did is the run's to say
        if (asked) error = await this.stopChatGpt(bridge, run.id, sent)
        if (error !== null) note({ stop: error })
      } else {
        error = redactSecrets(describeException(e))
        const found = diagnose(e)
        this.emit(handle, 'error', { message: error, kind: found.kind, status_code: found.status_code, model: cfg.id })
      }
    } finally {
      await this.finalize(handle, status, historyJson, { ...usage, model: cfg.id, configured_model: cfg.model }, error)
    }
  }

  /** A Stop of a run on ChatGPT that asked the page to send, told to the page — also when no reply said it was sent
   *  (a message still being uploaded is dropped before its words go). Null when nothing is left forming; else what
   *  the person should know — the answer may still form on the page. */
  private async stopChatGpt(bridge: ChatGptBridge, runId: string, sent: boolean): Promise<string | null> {
    let out: Record<string, unknown>
    try {
      out = await bridge.request('POST', '/stop', { turn_id: runId }, undefined, STOP_TIMEOUT_MS)
    } catch (error) {
      return sent ? `stopped here; ChatGPT's page could not be told to stop (${(error as Error).message}) — its answer may still form there` : null
    }
    if (out.stopped === true) return null
    if (out.reason === 'still_generating') return "stopped here; ChatGPT's page did not stop — its stop button was clicked and the answer still forms there"
    if (out.reason === 'no_stop_button') return "stopped here; ChatGPT's page showed no stop button to click — its answer may still form there"
    if (out.reason === 'sending') return 'stopped as the message went to ChatGPT: it may have been sent — the page stops its answer once it shows'
    if (out.reason === 'restarted') return "stopped here; the desktop app restarted after the message went, so its answer is not stopped by the app — stop it on the ChatGPT card if it still forms"
    return null
  }

  /** A call to the bridge, its failure in the person's terms: nothing listening (the desktop app, or its ChatGPT page,
   *  is not open), a connection dropped before the reply (a message may have gone), or a refusal of its token. A Stop
   *  meanwhile is the run's cancellation. */
  private async askBridge(call: () => Promise<Record<string, unknown>>, handle: RunHandle, sending = false): Promise<Record<string, unknown>> {
    try {
      return await call()
    } catch (error) {
      if (handle.token.cancelled) throw new RunCancelled()
      if (!(error instanceof BridgeError)) throw error
      if (error.kind === 'timeout') throw new ChatGptWebError('timeout', `ChatGPT's page did not finish taking the message in time (${error.message}); it may have been sent — look at the ChatGPT card before running it again`)
      if (error.kind === 'lost') throw new ChatGptWebError(sending ? 'timeout' : 'refused', sending ? `ChatGPT's page did not reply about the message (${error.message}); it may have been sent — look at the ChatGPT card before running it again` : error.message)
      if (error.kind === 'unreachable') throw new ChatGptWebError('unreachable', `ChatGPT's page is not reachable: nothing answers at ${error.base}. ChatGPT runs through the oasis-code desktop app — open it, then run this again`)
      if (error.status === 401) throw new ChatGptWebError('unreachable', `the ChatGPT bridge at ${error.base} refused this app's token: it belongs to another data directory or another start of the desktop app`)
      throw new ChatGptWebError('refused', error.message)
    }
  }

  /** The record a run continues (its dangling calls answered), or nothing. */
  private recordOf(runId: string | null): ModelMessage[] {
    if (!runId) return []
    const raw = repo.getRunHistory(this.state.conn, runId)
    if (!raw) return []
    try { return closeDanglingToolCalls(loadValue(JSON.parse(raw))) } catch { return [] }
  }

  private stashJson(stashed: ModelMessage[]): string | null {
    if (!stashed.length) return null
    try { return JSON.stringify(stashed) } catch { console.warn('could not serialize the stashed history'); return null }
  }

  private usageFrom(meter: UsageMeter | null, toolCalls: number, segments: number, historyJson: string | null, messages: ModelMessage[] | null = null): Record<string, unknown> {
    const base = meter ? meter.totalsWithTokens() : {}
    const metrics = messages?.length ? historyMetrics(messages, historyJson) : { history_bytes: historyJson ? Buffer.byteLength(historyJson, 'utf8') : 0 }
    return { ...base, tool_calls: toolCalls, segments, ...metrics }
  }

  private persistProgress(handle: RunHandle, history: ModelMessage[], meter: UsageMeter, toolCalls: number, segments: number): void {
    let saved: string
    try { saved = JSON.stringify(history) } catch { return }
    handle.saved_seq = handle.events.length
    repo.saveRunProgress(this.state.conn, handle.run_id, saved, { ...meter.totalsWithTokens(), tool_calls: toolCalls, segments, ...historyMetrics(history, saved) }, handle.saved_seq)
  }

  /** The instruction files the run was shown by its end — the first message's and the folders' entered, at the
   *  versions shown — added to the manifest: what the next run of the conversation compares against. */
  private sealShownInstructions(handle: RunHandle, versions: Map<string, string>): void {
    if (handle.done || handle.finalizing || !versions.size) return
    try {
      const row = repo.getRun(this.state.conn, handle.run_id)
      if (row === null) return
      repo.setRunManifest(this.state.conn, handle.run_id, { ...row.manifest, instructions_shown: [...versions].map(([source, sha256]) => ({ source, sha256 })) })
    } catch (error) {
      // a connection already closed (the process is going down): the next run compares against the manifest's inputs
      console.warn(`the shown instructions of ${handle.run_id} were not sealed: ${(error as Error).message}`)
    }
  }

  /** The run's UI task as it stands (running, bound to this run): its first event, before the first model request. */
  private emitUiTask(handle: RunHandle): void {
    if (handle.ui_task === null) return
    const task = repo.getUiTask(this.state.conn, handle.ui_task)
    if (task !== null && task.agent_run_id === handle.run_id) this.emit(handle, 'ui_task', { task })
  }

  /** The end of a run, whichever way it ended: the row, the receipt, the run_finished event, the finish hooks. */
  private async finalize(handle: RunHandle, statusIn: string, historyJson: string | null, usageIn: Record<string, unknown>, errorIn: string | null): Promise<void> {
    if (handle.finalizing || handle.done) return
    handle.finalizing = true
    // the intake closes with the run; what is still queued was never in the conversation, and ends here — before the
    // receipt and run_finished, so the stream says each message's end before the run's
    handle.steer.close('finished')
    if (handle.steer.queue.length) {
      const reason = undeliveredReason({ status: statusIn, budget: handle.budget_exceeded !== null || handle.closing !== null, stopping: this.stopping })
      for (const queued of [...handle.steer.queue]) this.undeliver(handle, queued, reason)
    }
    let status = statusIn
    let error = errorIn
    let usage = usageIn
    if (handle.deadline_timer !== null) {
      clearTimeout(handle.deadline_timer)
      handle.deadline_timer = null
    }
    if (handle.budget_exceeded) {
      // the Stop that ended the run was the budget's, not the person's: the row says error with the budget line,
      // the receipt says budget_exceeded; a dispatcher may resume it with a new order
      status = 'error'
      error = `budget_exceeded: ${handle.budget_exceeded}`
    }
    if (handle.cfg !== null) usage = { model: handle.cfg.id, configured_model: handle.cfg.model, ...usage }
    // the marker as it was kept (at admission, before anything ran): never what a failed setup left in memory
    if (handle.workspace_taken === true) {
      try { handle.attribution = markerOf(repo.getRun(this.state.conn, handle.run_id)?.manifest) ?? handle.attribution } catch { /* the handle's own stands */ }
    }
    // a run stopped while it waited in line never held its folder: it pins nothing of it (another writer holds it)
    if (handle.workspace_taken !== false) await this.pinFinalState(handle)
    const finishedAt = nowIso()
    // cancelled by the harness shutting down (the app quit), not by the person: said on the receipt, which the row and
    // run_finished carry, so the session's activity (and a later fill of it) never counts this end
    const interrupted = this.stopping && status === 'cancelled'
    const built = (await this.receipt(handle, status, usage, error, finishedAt)) as unknown as Record<string, unknown>
    const receipt = interrupted ? { ...built, interrupted: true } : built
    // the task's end, before the run's: its terminal record is on the stream ahead of run_finished
    if (handle.ui_task !== null) {
      try {
        const task = settleRunTask(this.state.conn, handle.ui_task, handle.run_id, { status, error, final_text: handle.final_text, interrupted })
        if (task !== null) this.emit(handle, 'ui_task', { task })
      } catch (e) {
        console.warn(`the UI task ${handle.ui_task} of ${handle.run_id} was not ended: ${(e as Error).message}`)
      }
    }
    handle.saved_seq = handle.events.length + 1
    repo.finishRun(this.state.conn, handle.run_id, status, { history_json: historyJson, usage, error, receipt, saved_seq: handle.saved_seq })
    handle.status = status
    this.emit(handle, 'run_finished', { status, usage, error, receipt, answer_end: handle.answer_end })
    handle.done = true
    for (const queue of handle.queues) queue.put(SENTINEL)
    for (const hook of this.finish_hooks) {
      try { hook(handle.run_id, receipt) } catch (e) { console.warn(`a finish hook failed for ${handle.run_id}: ${(e as Error).message}`) }
    }
    // the end is written (row, usage, receipt, run_finished): nothing reads the meter of a finished run, and the
    // finished handle stays (late streams, Stop answers) without holding its model chain and what it captured
    handle.meter = null
  }

  /** The harness keeps what a run leaves: when the worktree differs from its base and from its latest checkpoint, the
   *  state is pinned as a checkpoint of this run (a model never has to remember to). A state that breaks a hard lock
   *  is not pinned; the refusal is counted. */
  private async pinFinalState(handle: RunHandle): Promise<void> {
    const conn = this.state.conn
    const ws = repo.getWorkspace(conn, handle.workspace_id)
    const session = repo.getSession(conn, handle.session_id)
    const project = repo.getProject(conn, handle.project_id)
    if (ws === null || session === null || project === null) return
    // a folder edited in place is not pinned: its file changes are in the journal, each undoable
    if (isDirect(ws)) return
    // no baseline of its own (it worked beside its conversation's commands, or none was kept): nothing of the tree is
    // pinned as its
    if ((handle.workspace_taken === true && handle.attribution === null) || snapshotUnavailable(handle.attribution)) return
    // its own commands still write: the tree it leaves is not settled, so it is not its final state either
    const live = this.liveCommandsOf(ws.id, handle.run_id)
    if (live.length) {
      handle.attribution = recordMarker(conn, handle.run_id, { unavailable_reason: 'live_writers', background_execution_ids: live })
      return
    }
    try {
      const snap = await this.state.workspaces.snapshot(ws)
      if (!snap.changed_paths.length) return
      const latest = repo.latestCheckpoint(conn, ws.id)
      const latestSnap = latest ? repo.getSnapshot(conn, latest.snapshot_id) : null
      if (latestSnap !== null && latestSnap.tree_sha === snap.tree_sha) return
      const locks = effectiveLocks(conn, session.id, project, handle.work_order)
      const cp = await this.state.workspaces.checkpoint(ws, handle.run_id, 'the final state of the run', { expected_tree: snap.tree_sha, locks })
      handle.produced.checkpoints.push(cp.id)
      this.emit(handle, 'checkpoint', { checkpoint_id: cp.id, commit: cp.commit_sha, changed: snap.changed_paths.length, note: cp.note, final: true })
    } catch (error) {
      if (error instanceof LockViolation) { handle.lock_refusals += 1; return }
      console.warn(`could not pin the final state of run ${handle.run_id}: ${(error as Error).message}`)
    }
  }

  /** Measured only: counted from this run's own events and the records (executions, checkpoints, checks, the diff
   *  of its worktree against its base); the model's own words are kept apart as final_text. */
  private async receipt(handle: RunHandle, status: string, usage: Record<string, unknown>, error: string | null, finishedAt: string) {
    const conn = this.state.conn
    const executions = repo.listExecutions(conn, { run_id: handle.run_id })
    const checkpoints = repo.listCheckpointsOfRun(conn, handle.run_id).map((c) => c.id)
    const checks = repo.listChecks(conn, handle.workspace_id).filter((c) => c.run_id === handle.run_id)
    const counts = checkCounts(checks, configuredCheckIds(this.state, repo.getProject(conn, handle.project_id)))
    const ws = repo.getWorkspace(conn, handle.workspace_id)
    let diff: Record<string, unknown> = {}
    let filesChanged: string[] = []
    try {
      // a run that never held its folder changed nothing in it: what the folder shows is another writer's
      const marker = handle.attribution
      const beside = marker !== null && marker.background_execution_ids.length ? { background_execution_ids: [...marker.background_execution_ids] } : {}
      if (handle.workspace_taken === false) { /* nothing measured */ } else if (ws !== null && isDirect(ws)) {
        // in place: this run's own file-tool writes (the journal), not the folder's standing difference — a path another
        // hand wrote between two of its writes left out and named; beside its conversation's commands, partial
        const own = this.state.workspaces.journal.runAttributed(handle.run_id)
        const measured = this.state.workspaces.journal.diffOf(own.changes)
        filesChanged = measured.files.map((f) => f.path)
        diff = {
          files: measured.files.length, added: measured.files.reduce((a, f) => a + (f.added ?? 0), 0), removed: measured.files.reduce((a, f) => a + (f.removed ?? 0), 0), in_place: true,
          attribution: marker?.overlapped || own.unattributed.length ? 'partial' : 'exact', ...(own.unattributed.length ? { unattributed_paths: own.unattributed } : {}), ...beside,
        }
      } else if (ws !== null && ((handle.workspace_taken === true && marker === null) || snapshotUnavailable(marker))) {
        // no baseline of its own: nothing is claimed as the run's (which is not "no change")
        diff = { attribution: 'unavailable', base_tree_sha: null, base_commit: ws.base_commit, ...beside }
      } else if (ws !== null) {
        // its own baseline (taken as it was let in), not the workspace's integration base
        const from = marker?.base_tree_sha ?? null
        const measured = await this.state.workspaces.diff(ws, { from })
        filesChanged = measured.files.map((f) => f.path)
        diff = {
          files: measured.files.length, added: measured.files.reduce((a, f) => a + (f.added ?? 0), 0), removed: measured.files.reduce((a, f) => a + (f.removed ?? 0), 0),
          tree_sha: measured.tree_sha, base_commit: measured.base_commit, ...(from !== null ? { base_tree_sha: from, attribution: 'exact' } : {}),
        }
      }
    } catch (e) {
      console.warn(`could not measure the diff of run ${handle.run_id}: ${(e as Error).message}`)
    }
    const produced = producedOf({
      workspace_id: handle.workspace_id, base_commit: ws ? ws.base_commit : null, checkpoints, final_checkpoint_id: checkpoints.length ? checkpoints[checkpoints.length - 1]! : null,
      executions: executions.map((x) => x.id), checks: checks.map((c) => c.id), files_changed: filesChanged.slice(0, 200), tree_sha: (diff.tree_sha as string) ?? null,
    })
    return buildReceipt(handle.run_id, status, {
      label: handle.label, usage, error, order: handle.work_order, events: handle.events, blocked_calls: handle.blocked_calls,
      produced, lock_refusals: handle.lock_refusals, lock_violations: handle.lock_violations,
      executions: executions.map((x) => ({ id: x.id, status: x.status, exit_code: x.exit_code, effect_state: x.effect_state })), checks: counts, diff,
      budget_exceeded: handle.budget_exceeded, budget_reached: handle.closing, budget_limits: budgetLines(handle.budget),
      answer_end: handle.answer_end,
      final_text: handle.final_text, finished_at: finishedAt,
    })
  }
}

/** A queued run's wait in words (run_queued's message): who holds the folder and the run's place in line. */
export function queuedMessage(w: LockWaiting): string {
  const who = w.blocking_kind === 'run' ? `run ${w.blocking_run_id ?? w.blocking_owner}${w.blocking_session_id ? ` of session ${w.blocking_session_id}` : ''}`
    : w.blocking_kind === 'command' ? `command ${w.blocking_execution_ids.join(', ') || w.blocking_owner}`
    : w.blocking_kind === 'approval' ? `the approved action of proposal ${w.blocking_proposal_id ?? w.blocking_owner}`
    : w.blocking_owner ?? 'another writer'
  return `the working folder is being written by ${who}; this run starts when it is free (${w.position === 1 ? 'next' : `number ${w.position} in line`}); Stop takes it out of the line`
}

/** What a file piece costs the estimate on a route: the request as this route will be sent it — a reference whose
 *  bytes it takes is reserved for, one it is given the path of is its note (never its size). */
export function routeFileCost(cfg: ModelConfig): FileCost {
  const limits = routeLimits(cfg)
  return (piece) => (isRefPiece(piece) ? (refNativeFor(cfg.capabilities, limits, piece) ? nativeRefCost(piece) : 0) : legacyFileCost(piece))
}

/** What a run's keeper starts from when it continues a record: the previous run's anchor and the line its keeper had
 *  moved to. */
export interface ContextSeed { anchor: ContextAnchor | null; trigger: number | null }
const NO_SEED: ContextSeed = { anchor: null, trigger: null }

/** The context anchor a finished run left in its usage (the provider's count of its last request and the record's
 *  length then) and the compaction line its keeper had moved to, usable only by a run on the same route: another
 *  route counts differently and has its own window (its keeper starts at its own threshold). */
export function contextSeedOf(previous: Run, cfg: ModelConfig): ContextSeed {
  if (previous.model !== cfg.id) return NO_SEED
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
  const raw = previous.usage.context_anchor
  const { input_tokens, messages } = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const trigger = previous.usage.context_trigger
  return { anchor: finite(input_tokens) && finite(messages) ? { input_tokens, messages } : null, trigger: finite(trigger) ? trigger : null }
}

/** The ids of the checks a project configures (its own, else the harness's): what a receipt counts as not run. */
export function configuredCheckIds(state: { config: { checks: { id: string }[] } }, project: { config: Record<string, unknown> } | null): string[] {
  const own = ((project?.config.checks as unknown[] | undefined) ?? []).map((c) => (c && typeof c === 'object' ? (c as { id?: unknown }).id : undefined)).filter((id): id is string => typeof id === 'string')
  return own.length ? own : state.config.checks.map((c) => c.id)
}

/** A conversation's address as the bridge names it ({ url }), or null. */
function urlOf(conversation: unknown): string | null {
  const url = conversation && typeof conversation === 'object' ? (conversation as Record<string, unknown>).url : null
  return typeof url === 'string' && url ? url : null
}

export { userPrompt }
