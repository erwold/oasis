/** The native transport: a model route of this harness IS the director. The turn runs the agent loop on the
 *  director's own conversation (kept whole on the director session between turns, compacted by the context keeper
 *  only near the route's window — the same rule as a run's), with the director tools in process, streaming its text
 *  into the turn; a tool call that starts a run is recorded so the run's end comes back as the next turn. Any
 *  configured route can direct — a Codex subscription route (openai:gpt-6-astra), an API route with reasoning.mode
 *  pro, a Claude route — the same way the thread's agent runs on any of them. */

import { THINKING_LEVELS, type DirectorToolCall, type DirectorToolSurface } from '@oasis-code/contract'
import { attachmentsFor } from '../../api/attachments.ts'
import type { AppState } from '../../api/state.ts'
import { resolveWindow } from '../../agent/context.ts'
import { ContextKeeper, ContextView, outputReserve, workingView, type RequestSeam } from '../../agent/history.ts'
import { Agent } from '../../agent/loop.ts'
import { closeDanglingToolCalls, modelSettings } from '../../agent/runner.ts'
import { findModel } from '../../llm/catalog.ts'
import { isChatGptWeb } from '../../llm/chatgpt_web.ts'
import { handoffNote, noteOnFirstRequest, portableHistory } from '../../llm/handoff.ts'
import { dumpJson, isText, loadJson, type ModelMessage } from '../../llm/messages.ts'
import { RunCancelled, type Model, type ModelSettings } from '../../llm/model.ts'
import { providerSystem } from '../../llm/providers.ts'
import { credentialState } from '../../auth/routing.ts'
import { personRunsMessage, runIdsOf } from '../outbox.ts'
import * as store from '../store.ts'
import { callSummary, directorToolset, resultSummary, type DirectorToolDeps, type DirectorToolset, callOutcome, keptArgs } from '../tools.ts'
import { nativeInstructionsFor, surfaceOf, surfaceText } from '../surfaces/index.ts'
import { DIRECTOR_HELD_CONFIG_KEYS } from '../store.ts'
import { bool, num, str, TransportError, type DirectorTransport, type Readiness, type Rec, type TurnContext, type TurnOutcome } from './types.ts'

export const NATIVE_DEFAULTS = { max_requests_per_turn: 40, max_tool_calls_per_turn: 80 }

/** What a native director reads before its first request: its surface's system instructions (v1: the manual, then
 *  what differs when the harness itself holds the conversation; v2: what the harness and its tools do, and their
 *  limits). Nothing of the session rides in it (the turn's context names the session), so the text is the same for
 *  every director of a surface and every turn. */
export function nativeInstructions(surface: DirectorToolSurface = 'director.v1'): string {
  return nativeInstructionsFor(surface)
}

/** The line of a turn that carries the person's original message envelope, in the surface's words: v1's names no
 *  turn (v1 binds the envelope to the turn's dispatches itself), v2's names the turn a call's source_turn_id takes. */
export function envelopeLine(surface: DirectorToolSurface, turnId: string, envelope: Record<string, unknown>): string {
  if (surface === 'director.v1') return `${surfaceText(surface, 'native.envelope_prefix')}${JSON.stringify(envelope)}`
  return surfaceText(surface, 'director.envelope', { turn_id: turnId, envelope: JSON.stringify(envelope) })
}

/** The conversation a director's requests are routed by at a provider that keys its cache: the director session. */
export function directorCacheKey(directorId: string): string {
  return `oasis:director:${directorId}`
}

export class NativeTransport implements DirectorTransport {
  readonly id = 'native' as const
  readonly label = 'a model route of this harness'
  /** one toolset per surface: a conversation's tools are its surface's, whatever surface another director holds */
  private readonly toolsets = new Map<DirectorToolSurface, Promise<DirectorToolset>>()

  constructor(private readonly state: AppState) {}

  readiness(): Readiness {
    if (!this.state.director.harness) return { ready: false, hint: 'the director tools are not attached (the harness is not serving its API in this process)' }
    const routes = this.state.config.models.filter((m) => credentialState(m).status === 'available').map((m) => m.id)
    if (!routes.length && this.state.model_overrides.size === 0) return { ready: true, hint: 'no model route has a credential yet: sign in or save a key on the Accounts page' }
    return { ready: true, hint: null }
  }

  normalizeConfig(config: Rec, model: string | null): { config: Rec; model: string; label: string } {
    const id = model || this.state.config.default_model || ''
    if (!id || !this.state.runs.knowsModel(id)) throw new TransportError(`unknown model: ${id || '(none)'}`)
    if (isChatGptWeb(id) && !this.state.model_overrides.has(id)) throw new TransportError('ChatGPT on the web answers as a participant; a director of this harness runs on a model route (ChatGPT directs through the bridge transport)')
    const cfg = findModel(this.state.config, id)
    if (cfg !== null && !this.state.model_overrides.has(id)) {
      const credential = credentialState(cfg)
      if (credential.status !== 'available') throw new TransportError(`${id} has no credential (${credential.hint ?? 'sign in or save a key on the Accounts page'})`, 409)
    }
    const thinking = config.thinking === undefined || config.thinking === null ? null : str(config.thinking)
    if (thinking !== null && !(THINKING_LEVELS as readonly string[]).includes(thinking)) throw new TransportError(`thinking must be one of ${THINKING_LEVELS.join(', ')}`)
    const mode = config.reasoning_mode === undefined || config.reasoning_mode === null ? null : str(config.reasoning_mode)
    if (mode !== null) {
      if (mode !== 'pro') throw new TransportError("reasoning_mode must be 'pro' or null")
      if (cfg === null || cfg.provider !== 'openai' || cfg.api !== 'responses' || cfg.auth !== 'api_key') {
        throw new TransportError(`reasoning_mode pro needs an OpenAI API route on the Responses API with a key (${id} is ${cfg ? `${cfg.provider} ${cfg.api} ${cfg.auth}` : 'not such a route'}); the Codex subscription route does not take it`)
      }
    }
    // the harness's own keys (the surface, the reach) pass through as they are: the controller decides them
    const held = Object.fromEntries(DIRECTOR_HELD_CONFIG_KEYS.filter((k) => config[k] !== undefined).map((k) => [k, config[k]]))
    return {
      config: {
        thinking, reasoning_mode: mode, allow_destructive: bool(config.allow_destructive, false),
        max_requests_per_turn: Math.max(1, Math.trunc(num(config.max_requests_per_turn, NATIVE_DEFAULTS.max_requests_per_turn))),
        max_tool_calls_per_turn: Math.max(1, Math.trunc(num(config.max_tool_calls_per_turn, NATIVE_DEFAULTS.max_tool_calls_per_turn))),
        ...held,
      },
      model: id, label: cfg ? (cfg.label || cfg.id) : id,
    }
  }

  private tools(surface: DirectorToolSurface): Promise<DirectorToolset> {
    const harness = this.state.director.harness
    if (!harness) throw new TransportError('the director tools are not attached: the harness must serve its API in this process', 503)
    let toolset = this.toolsets.get(surface)
    if (!toolset) { toolset = directorToolset(harness, this.state.conn, surface); this.toolsets.set(surface, toolset) }
    return toolset
  }

  async close(): Promise<void> {
    for (const toolset of this.toolsets.values()) await (await toolset).close().catch(() => {})
    this.toolsets.clear()
  }

  async send(ctx: TurnContext): Promise<TurnOutcome> {
    const { state } = this
    const { director, turn } = ctx
    const modelId = director.model
    if (!state.runs.knowsModel(modelId)) throw new TransportError(`unknown model: ${modelId}`)
    const cfg = state.runs.configFor(modelId)
    const system = state.model_overrides.has(modelId) && !findModel(state.config, modelId) ? (state.runs.modelFor(cfg).system ?? '') : providerSystem(cfg)
    // the provider boundary: the record from its last compaction on, carried to this route's provider
    const model: Model = new ContextView(state.runs.modelFor(cfg), system)
    const config = director.config
    // the surface the conversation holds, for every request of every turn: its tools, instructions and texts
    const surface = surfaceOf(director)
    const toolset = await this.tools(surface)
    const project = ctx.project
    const calls: DirectorToolCall[] = []
    const deps: DirectorToolDeps = {
      session_id: director.session_id, director_session_id: director.id, turn_id: turn.id, envelope: turn.envelope, allow_destructive: bool(config.allow_destructive, false),
      report_only: turn.kind === 'task_event' && turn.event_ids.some((id) => { const e = store.getEvent(state.conn, id); return e?.kind === 'interaction_finished' && e.payload.workspace_policy === 'isolated' }),
      onResult: (name, args, result, isError, toolCallId) => {
        const { status, summary } = resultSummary(result, isError)
        const outcome = callOutcome(result, isError)
        calls.push({ tool_call_id: toolCallId, name, summary: callSummary(name, args), status, args: keptArgs(args), outcome })
        ctx.emit('tool_result', { tool_call_id: toolCallId, name, status, summary, outcome, call_summary: callSummary(name, args), args: keptArgs(args) })
        for (const runId of runIdsOf(name, result)) ctx.dispatched(runId)
      },
      cancelled: () => ctx.signal.aborted,
    }
    const settings: ModelSettings = modelSettings(cfg, config.thinking === undefined ? null : (config.thinking as string | null), directorCacheKey(director.id))
    if (config.reasoning_mode === 'pro') settings.reasoning_mode = 'pro'
    const keeper = new ContextKeeper({ window: resolveWindow(cfg, state.config.context_window_fallback_tokens).window, output_reserve: outputReserve(settings), ...contextSeed(state, director.id, turn.id, modelId) })
    // the record is written as it grows, so a turn cut off keeps what was said and answered up to the cut
    const persist = (messages: ModelMessage[]) => store.setDirectorHistory(state.conn, director.id, dumpJson(messages))
    const processHistory = async (_deps: DirectorToolDeps, messages: ModelMessage[], seam: RequestSeam): Promise<ModelMessage[]> => {
      const [kept, report] = await keeper.maybeCompact(messages, seam)
      if (report !== null) ctx.emit('note', { text: report.status === 'compacted' ? `the director's conversation was compacted (about ${report.estimate_tokens.toLocaleString('en-US')} tokens → ${(report.after_tokens ?? 0).toLocaleString('en-US')})` : `the director's conversation could not be compacted: ${report.reason ?? 'unknown'}` })
      persist(kept)
      return kept
    }
    const agent = new Agent<DirectorToolDeps>({ instructions: nativeInstructions(surface), tools: toolset.tools, retries: 2, processHistory, onMessages: (_d, messages) => persist(messages) })
    // the session this director directs, as the turn's context (never in the system text): the person's words follow
    const context = surfaceText(surface, 'director.context', { session_id: director.session_id, project_name: project.name, workspace_id: ctx.session.workspace_id ?? 'none' })
    // the runs the person ran directly since the director last spoke: a block of their own before this turn's words
    // (a task-event turn's words are its events already)
    const beside = turn.kind === 'task_event' ? [] : turn.event_ids.map((id) => store.getEvent(state.conn, id)).filter((e) => e !== null)
    // the director's own conversation: the whole record kept on the director session between turns; what a foreign
    // provider cannot take is left out at the boundary, and the note that says so opens this turn
    let history: ModelMessage[] | null = null
    const stored = store.getDirectorHistory(state.conn, director.id)
    if (stored) {
      try { history = loadJson(stored) } catch (error) { ctx.emit('note', { text: `the director's earlier conversation could not be read and starts afresh (${(error as Error).message})` }); history = null }
    }
    if (history) {
      history = closeDanglingToolCalls(history)
      const [, report] = portableHistory(workingView(history), system, model.route ?? null)
      const note = handoffNote(report, null, modelId)
      if (note) history = noteOnFirstRequest(history, note)
    }
    const limits = { request_limit: Math.trunc(num(config.max_requests_per_turn, NATIVE_DEFAULTS.max_requests_per_turn)), tool_calls_limit: Math.trunc(num(config.max_tool_calls_per_turn, NATIVE_DEFAULTS.max_tool_calls_per_turn)) }
    const token = new (await import('../../llm/model.ts')).CancellationToken()
    const onAbort = () => token.cancel()
    if (ctx.signal.aborted) throw new RunCancelled()
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    let output = ''
    let usage: Record<string, number> = {}
    let messages: ModelMessage[] | null = null
    try {
      const envelope = turn.envelope ? JSON.parse(JSON.stringify({ ...turn.envelope, text: undefined, attachment_metadata: attachmentsFor(state, ctx.session, turn.envelope.attachments).map(({ asset_id, name, media_type, bytes }) => ({ asset_id, name, media_type, bytes })) })) as Record<string, unknown> : null
      for await (const event of agent.runStreamEvents({ prompt: [context, ...(envelope ? [envelopeLine(surface, turn.id, envelope)] : []), ...(beside.length ? [personRunsMessage(beside, surface)] : []), turn.input], deps, model, modelSettings: settings, messageHistory: history, usageLimits: limits, token })) {
        if (event.type === 'part_delta' && event.delta.part_kind === 'text' && event.delta.content_delta) ctx.emit('text_delta', { text: event.delta.content_delta })
        else if (event.type === 'part_start' && isText(event.part) && event.part.content) ctx.emit('text_delta', { text: event.part.content, start: true })
        else if (event.type === 'tool_call') ctx.emit('tool_call', { tool_call_id: event.part.tool_call_id, name: event.part.tool_name, summary: callSummary(event.part.tool_name, argsOf(event.part.args)), args: keptArgs(argsOf(event.part.args)) })
        else if (event.type === 'result') {
          output = event.result.output
          usage = Object.fromEntries(Object.entries(event.result.usage).filter(([, v]) => typeof v === 'number')) as Record<string, number>
          messages = event.result.allMessages()
        }
      }
    } finally {
      ctx.signal.removeEventListener('abort', onAbort)
    }
    if (messages) persist(messages)
    // the line a compaction that freed too little moved the next one to rides with the turn's usage (settled on the
    // turn's last count): the next turn on this route starts from it instead of summarizing the summary at once
    if (messages) keeper.observeLast(messages, history?.length ?? 0)
    const line = keeper.currentTrigger()
    if (line !== null) usage = { ...usage, context_trigger: line }
    return { kind: 'answered', text: output, model: modelId, usage, tool_calls: calls }
  }
}

/** The compaction line the director's last answered turn left, when that turn ran on this route (another route has its
 *  own window and threshold). */
function contextSeed(state: AppState, directorId: string, turnId: string, modelId: string): { trigger: number | null } {
  const last = store.listTurns(state.conn, directorId).filter((t) => t.id !== turnId && t.status === 'done').at(-1)
  const trigger = last && last.model === modelId ? last.usage.context_trigger : undefined
  return { trigger: typeof trigger === 'number' && Number.isFinite(trigger) && trigger > 0 ? trigger : null }
}

function argsOf(args: unknown): Rec {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Rec
  if (typeof args === 'string') { try { const parsed = JSON.parse(args); if (parsed && typeof parsed === 'object') return parsed as Rec } catch { /* text */ } }
  return {}
}
