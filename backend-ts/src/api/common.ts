/** What every route module shares: the app's services, the body parser, the error type, and the run row. */

import type { Context } from 'hono'
import { ACTIVE_DIRECTOR_TURN_STATUSES, CONNECTOR_SPAWNER, plainAgentMentions, z, type Origin, type OriginRequest, type Run } from '@oasis-code/contract'
import { createHash } from 'node:crypto'
import * as directorStore from '../director/store.ts'
import { canonicalJson } from '../llm/usage.ts'
import type { RunHandle } from '../agent/runner.ts'
import type { LoginManager } from '../auth/web_login.ts'
import type { UsageService } from '../auth/usage.ts'
import { CONNECTOR_HEADER } from './auth.ts'
import { currentRequestAgent } from '../policy/access.ts'
import { boundOfAgent, DelegationRefused, type DelegationBound } from '../policy/delegation.ts'
import { HttpError, type AppState } from './state.ts'

export { HttpError }

export interface Api {
  state: AppState
  logins: LoginManager
  usage: UsageService
}

function issuesText(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
}

/** The JSON body validated against its schema: an empty body is `{}`; a bad one is a 422 with the issues. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown = {}
  const text = await c.req.text()
  if (text.trim()) {
    try { raw = JSON.parse(text) } catch { throw new HttpError(422, 'the request body is not JSON') }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new HttpError(422, issuesText(parsed.error))
  return parsed.data
}

/** The connector's client a request comes through (a short name, or null for the person's own page). Only shown: it
 *  grants nothing. */
export function connectorOf(c: Context): string | null {
  const name = (c.req.header(CONNECTOR_HEADER) ?? '').trim()
  return /^[\w .()-]{1,40}$/.test(name) ? name : null
}

/** How a run a request starts records who started it: the connector's client, or the person. (The pre-v25 reading,
 *  kept for `spawned_by` and older callers; the run's origin is `requestOrigin`.) */
export function startedBy(c: Context): { spawned_by: string; via: string | null } {
  const via = connectorOf(c)
  return { spawned_by: via ? CONNECTOR_SPAWNER : 'human', via }
}

/** The director context a director's Harness sends with a tool call's request (schema v25): its session, the turn the
 *  call belongs to, the call's id, the tool surface it holds. Only these headers make a run's origin a director's —
 *  never a tool's arguments — and only once the director store confirms them. */
export const DIRECTOR_SESSION_HEADER = 'x-oasis-director-session-id'
export const DIRECTOR_TURN_HEADER = 'x-oasis-director-turn-id'
export const DIRECTOR_TOOL_CALL_HEADER = 'x-oasis-director-tool-call-id'
export const TOOL_SURFACE_HEADER = 'x-oasis-tool-surface'

export interface RequestOrigin {
  origin: Origin
  /** the pre-v25 column, as before: connector when a connector carried the request, else human */
  spawned_by: string
  /** the connector's client label (what `label` showed before) */
  via: string | null
  /** the director tool surface the caller holds (director.v1 / director.v2), when it said */
  tool_surface: string | null
}

/** Who or what a request comes from, for a run it starts in `sessionId`: a director turn (its headers, checked
 *  against the director store: the turn is that director session's, and the director's session is the target or one
 *  it was authorized for — `config.authorized_session_ids`), a connector's client (inside a held bridge turn: that
 *  turn, inferred), or the person. A header that does not check out is refused, never ignored into another origin. */
export function requestOrigin(c: Context, state: AppState, sessionId: string, request: OriginRequest): RequestOrigin {
  const via = connectorOf(c)
  const spawned_by = via ? CONNECTOR_SPAWNER : 'human'
  const dsId = (c.req.header(DIRECTOR_SESSION_HEADER) ?? '').trim()
  const turnId = (c.req.header(DIRECTOR_TURN_HEADER) ?? '').trim()
  const callId = (c.req.header(DIRECTOR_TOOL_CALL_HEADER) ?? '').trim() || null
  const surface = (c.req.header(TOOL_SURFACE_HEADER) ?? '').trim() || null
  const base = { client: via, director_session_id: null, director_turn_id: null, tool_call_id: null, interaction_id: null, relay_id: null, watch_id: null, ui_task_id: null, parent_run_id: null }
  // a run's own tool (its checked header, main.ts): the agent's request, never the person's — the run it starts names
  // the calling run (its cap follows: runner accessCapFor). The pre-v25 column keeps 'human' (a thread message, not a
  // connector's): the origin is the record of who asked.
  const agent = currentRequestAgent()
  if (agent !== null) return { origin: { ...base, actor: 'agent', request, parent_run_id: agent.run_id, basis: 'recorded' }, spawned_by, via, tool_surface: surface }
  if (dsId || turnId) {
    const ds = dsId ? directorStore.getDirectorSession(state.conn, dsId) : null
    const turn = turnId ? directorStore.getTurn(state.conn, turnId) : null
    if (ds === null || turn === null || turn.director_session_id !== ds.id) throw new HttpError(400, 'the director context of this request does not check out (its director session and turn)', 'invalid_director_context')
    const authorized = Array.isArray(ds.config.authorized_session_ids) ? (ds.config.authorized_session_ids as unknown[]).filter((x): x is string => typeof x === 'string') : []
    if (ds.session_id !== sessionId && !authorized.includes(sessionId)) throw new HttpError(403, 'this director may not start runs in that session', 'director_scope')
    return { origin: { ...base, actor: 'director', request, director_session_id: ds.id, director_turn_id: turn.id, tool_call_id: callId, basis: 'recorded' }, spawned_by, via, tool_surface: surface }
  }
  if (via) {
    // a connector's call while the session's bridge director holds a turn: that turn's, as far as the time tells
    const open = directorStore.openDirectorSessionOf(state.conn, sessionId)
    const held = open !== null && open.transport === 'bridge' && open.current_turn_id ? directorStore.getTurn(state.conn, open.current_turn_id) : null
    if (open !== null && held !== null && (ACTIVE_DIRECTOR_TURN_STATUSES as readonly string[]).includes(held.status)) {
      return { origin: { ...base, actor: 'director', request, director_session_id: open.id, director_turn_id: held.id, basis: 'inferred' }, spawned_by, via, tool_surface: surface }
    }
    return { origin: { ...base, actor: 'connector', request, basis: 'recorded' }, spawned_by, via, tool_surface: surface }
  }
  return { origin: { ...base, actor: 'person', request, basis: 'recorded' }, spawned_by, via, tool_surface: surface }
}

/** The bounds of the agent run the request comes from (policy/delegation.ts), or null for any other caller; a 403
 *  with the reason when what it asks for cannot be held to them. */
export function agentBound(state: AppState): DelegationBound | null {
  const agent = currentRequestAgent()
  if (agent === null) return null
  try { return boundOfAgent(state.conn, agent) } catch (error) {
    if (error instanceof DelegationRefused) throw new HttpError(403, error.message, error.code)
    throw error
  }
}

/** A keyed dispatch's intent, as a fingerprint: the same key with another intent is refused (409 key_conflict). */
export function intentOf(parts: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(parts)).digest('hex')
}

export function intQuery(c: Context, name: string, fallback: number): number {
  const raw = c.req.query(name)
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value)) throw new HttpError(422, `${name} must be an integer`)
  return value
}

export function boolQuery(c: Context, name: string, fallback = false): boolean {
  const raw = c.req.query(name)
  if (raw === undefined) return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
}

/** A run as the API sends it from the list routes: everything but the manifest (the detail route carries it). */
export function withoutManifest(run: Run): Record<string, unknown> {
  const { manifest: _manifest, ...rest } = run
  return rest
}

const USAGE_KEYS = ['requests', 'tool_calls', 'input_tokens', 'output_tokens', 'total_tokens', 'cache_read_tokens', 'cache_write_tokens']

/** The context the run stood at, as the provider counted its last request (the context anchor): a card shows it, not
 *  the input summed over every request. */
function contextOf(usage: Record<string, unknown>): { context_tokens?: number } {
  const anchor = usage.context_anchor
  const tokens = anchor !== null && typeof anchor === 'object' ? (anchor as Record<string, unknown>).input_tokens : null
  return typeof tokens === 'number' && Number.isInteger(tokens) && tokens > 0 ? { context_tokens: tokens } : {}
}

/** A run as the outline's row: parent_run_id is the tree, the rest is what a row shows. */
export function treeRow(run: Run, live?: RunHandle | null): Record<string, unknown> {
  const usage = run.usage ?? {}
  const receipt = run.receipt && typeof run.receipt === 'object' ? run.receipt : {}
  const mechanical = receipt.mechanical && typeof receipt.mechanical === 'object' ? (receipt.mechanical as Record<string, unknown>) : {}
  const trimmed = plainAgentMentions(run.user_text).trim()
  return {
    id: run.id, session_id: run.session_id, parent_run_id: run.parent_run_id, resumes_run_id: run.resumes_run_id,
    spawned_by: run.spawned_by, label: run.label, model: run.model || null, status: run.status,
    live: live !== undefined && live !== null && !live.done, created_at: run.created_at, finished_at: run.finished_at,
    workspace_id: run.workspace_id, user_text: run.user_text,
    user_text_head: trimmed ? trimmed.split(/\r?\n/)[0]!.slice(0, 160) : '',
    work_order: run.work_order, receipt: Object.keys(receipt).length ? receipt : null,
    error: run.error,
    usage: { ...Object.fromEntries(USAGE_KEYS.filter((k) => Number.isInteger(usage[k])).map((k) => [k, usage[k]])), ...contextOf(usage) },
    depth: 0, relay_id: run.relay_id, relay_step: run.relay_step, interaction_id: run.interaction_id, interaction_node: run.interaction_node,
    // the plan's fields, empty on a run of its own (the tree's plan rows fill them in)
    plan_node_id: null, participant_id: null, participant_alias: null, participant_index: null, participant_name: null, depends_on: [], scheduled_by: null, kind: 'run',
  }
}
