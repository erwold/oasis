import { realpathSync } from 'node:fs'
/** The director tools as a native director's tools: the very MCP server ChatGPT talks to, connected in process
 *  over an in-memory transport, so a director the harness runs itself sees the surface (names, schemas, descriptions,
 *  the harness's refusals word for word) an outside director of the same surface sees — one manual, one vocabulary.
 *  The tool list a model is given is the surface's committed snapshot (surfaces/), the same bytes for every request of
 *  the conversation; the calls go to a server of that surface built for the native audience, which tells the API
 *  which director turn and tool call each request is. Every call is held to the director's reach before the server
 *  sees it (see scope.ts): a session, run, workspace, checkpoint or attachment of a session the director does not
 *  reach is refused, whatever argument names it; a session the director's own create_session made joins its reach. */

import { createHash } from 'node:crypto'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Tool, ToolContext } from '../agent/loop.ts'
import { TOOL_CALL_METADATA_KEYS, type DirectorSayBody, type DirectorToolSurface } from '@oasis-code/contract'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import type { Harness } from './harness.ts'
import { scopeRefusal } from './scope.ts'
import { buildServer, NATIVE_CALL_META } from './server.ts'
import { addAuthorizedSession, authorizedSessionsOf, getDirectorSession } from './store.ts'
import { NATIVE_EXCLUDED_BY_SURFACE, nativeToolDefs, surfaceText, WRITE_TOOLS } from './surfaces/index.ts'

type Rec = Record<string, unknown>

/** The director tools a native director of director.v1 never had: it is bound to one session already (no project or
 *  session to open), and the harness records its answers (no notes). director.v2 adds create_session (in its own
 *  project) — see NATIVE_EXCLUDED_BY_SURFACE. */
export const NATIVE_EXCLUDED_TOOLS = new Set(NATIVE_EXCLUDED_BY_SURFACE['director.v1'])
/** Held back unless the director session's config says allow_destructive. */
export const DESTRUCTIVE_TOOLS = new Set(['cancel_run'])
/** The tools that start something: without a request_id of the model's, each call gets a key of its own. */
const STARTING_TOOLS = new Set(['start_run', 'start_relay', 'start_interaction', 'create_session', 'steer_run'])

export interface DirectorToolDeps {
  session_id: string
  /** the director session whose tool calls these are (its reach: the bound session and the sessions it created) */
  director_session_id?: string
  turn_id?: string
  envelope?: DirectorSayBody | null
  report_only?: boolean
  allow_destructive: boolean
  /** called with each tool's result (the controller reads the runs a call started) */
  onResult(name: string, args: Rec, result: unknown, isError: boolean, toolCallId?: string): void
  cancelled(): boolean
}

export interface DirectorToolset {
  surface: DirectorToolSurface
  tools: Tool<DirectorToolDeps>[]
  close(): Promise<void>
}

const TEXT_CAP = 60_000

function resultText(content: unknown): string {
  const parts = Array.isArray(content) ? content : []
  return parts.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('')
}

/** The request key of a native tool call that starts something and names no key of its own: one per tool call (the
 *  turn and the call's id, stable in the conversation's record), so two calls of one turn are two requests and the
 *  same call sent again is the same one. */
export function nativeRequestKey(turnId: string, toolCallId: string): string {
  return `dtc_${createHash('sha256').update(`${turnId}\u0000${toolCallId}`).digest('hex').slice(0, 40)}`
}

/** The surface's tools, from its snapshot, as the agent loop's tools; each call scoped to the calling director's
 *  reach through `conn`, then sent to a server of that surface in process. */
export async function directorToolset(harness: Harness, conn: Conn, surface: DirectorToolSurface = 'director.v1'): Promise<DirectorToolset> {
  const server = buildServer(harness, { surface, audience: 'native' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new McpClient({ name: 'oasis-code native director', version: '1' })
  await client.connect(clientTransport)
  // v2 and every surface after it: what v2 changed stays
  const v2 = surface !== 'director.v1'
  const tools: Tool<DirectorToolDeps>[] = []
  for (const t of nativeToolDefs(surface)) {
    const schema = t.parameters_json_schema
    const properties = (schema.properties ?? {}) as Rec
    tools.push({
      name: t.name, description: t.description, parameters_json_schema: schema,
      validate: (args) => (args && typeof args === 'object' && !Array.isArray(args) ? { value: args } : { error: 'the arguments must be a JSON object' }),
      fn: async (ctx: ToolContext<DirectorToolDeps>, args: never) => {
        const a = { ...(args as Rec) }
        const deps = ctx.deps
        const notify = (payload: unknown, error = false) => deps.onResult(t.name, a, payload, error, ctx.tool_call_id)
        const refuse = (reason: string) => { const payload = { status: 'refused', reason }; notify(payload); return payload }
        const ds = deps.director_session_id ? getDirectorSession(conn, deps.director_session_id) : null
        const reach = ds ? authorizedSessionsOf(ds) : []
        const bound = repo.getSession(conn, deps.session_id)
        // create_session names a project, never a session: its own project only, the bound one when left out
        if (t.name === 'create_session') {
          if (!bound) return refuse(`this director's session ${deps.session_id} is gone`)
          if (a.project_id === undefined || a.project_id === null || a.project_id === '') a.project_id = bound.project_id
          if (a.project_id !== bound.project_id) return refuse(surfaceText(surface, 'director.project_refusal', { project_id: bound.project_id }))
          // a native director's new session reaches no folder its own session does not: each root one of the bound
          // session's, with no more access than it has there
          if (Array.isArray(a.roots) && a.roots.length) {
            const held = new Map((bound.roots ?? []).map((r) => [r.path, r.access]))
            for (const root of a.roots as Rec[]) {
              let real = String(root?.path ?? '')
              try { real = realpathSync(real) } catch { /* named as given: not one of the bound session's */ }
              const has = held.get(real)
              if (has === undefined || (root?.access === 'write' && has !== 'write')) {
                return refuse(`roots: ${String(root?.path ?? '')} (${String(root?.access ?? '')}) is not a folder this director's session ${bound.id} reaches with that access; a native director's new session names only those (${(bound.roots ?? []).map((r) => `${r.path} ${r.access}`).join(', ') || 'none'})`)
              }
            }
          }
        }
        const rawScope = scopeRefusal(conn, deps.session_id, t.name, a, reach, surface)
        if (rawScope) return refuse(rawScope)
        if (deps.cancelled()) return { status: 'cancelled', reason: 'the director turn was cancelled' }
        if (deps.report_only && WRITE_TOOLS.has(t.name)) {
          return refuse(v2 ? surfaceText(surface, 'director.report_only_refusal')
            : 'this isolated interaction completion turn is read-only: return the participant execution/result index; a new dispatch requires a new explicit user message')
        }
        // v1: a native separate run would share a direct project's folder — refused; v2's is isolated (its own output
        // folder, the project's folder read-only), so it goes
        if (!v2 && t.name === 'start_run' && a.separate === true) return refuse('native separate runs are not routed to the main folder; isolated multi-participant work is available through start_interaction')
        // a tool that takes the session names this director's when the model leaves it out
        if ('session_id' in properties && (a.session_id === undefined || a.session_id === null || a.session_id === '')) a.session_id = deps.session_id
        // v1: the person's original message goes with the turn's first dispatches (v1's instructions say so); a
        // dispatch that names another run to continue than the message does is refused by the server, never re-targeted
        const original = deps.envelope
        if (!v2 && original && (t.name === 'start_run' || t.name === 'start_interaction')) {
          Object.assign(a, { text: original.text, attachments: original.attachments, mentions: original.mentions, thinking: original.thinking ?? a.thinking })
          a.source_turn_id = deps.turn_id
          if (t.name === 'start_run') {
            a.fresh = original.fresh
            if (!a.model && original.model) a.model = original.model
          }
        }
        // one key per tool call: two dispatches of one turn are two requests, the same call again the same one
        // (a call without an id of its own gets no key: one made up from the turn alone would be shared by every such
        // call of the turn — the second a conflict of the first — so none is invented)
        if (STARTING_TOOLS.has(t.name) && 'request_id' in properties && !(typeof a.request_id === 'string' && a.request_id) && deps.turn_id && ctx.tool_call_id) {
          a.request_id = nativeRequestKey(deps.turn_id, ctx.tool_call_id)
        }
        const outside = scopeRefusal(conn, deps.session_id, t.name, a, reach, surface)
        if (outside !== null) return refuse(outside)
        // a turn never waits: the harness wakes the director when a run it started ends
        if (t.name === 'get_run' && a.wait_s !== undefined && a.wait_s !== null && Number(a.wait_s) > 0) return refuse(surfaceText(surface, 'director.native_wait_refusal'))
        if (v2) delete a.wait_s
        if (DESTRUCTIVE_TOOLS.has(t.name) && !deps.allow_destructive) {
          return refuse(v2 ? surfaceText(surface, 'director.destructive_refusal', { tool: t.name })
            : `${t.name} needs the person's decision: this director session does not allow destructive calls; say in your answer what you want cancelled and why, and the person decides`)
        }
        const result = await client.callTool({ name: t.name, arguments: a, _meta: { [NATIVE_CALL_META]: { director_session_id: deps.director_session_id ?? null, turn_id: deps.turn_id ?? null, tool_call_id: ctx.tool_call_id ?? null } } })
        const text = resultText(result.content)
        let payload: unknown
        if (result.isError) payload = { status: 'error', error: text.slice(0, TEXT_CAP) }
        else if (result.structuredContent !== undefined && result.structuredContent !== null) payload = result.structuredContent
        else {
          try { payload = JSON.parse(text) } catch { payload = text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}… [${text.length - TEXT_CAP} more chars]` : text }
        }
        if (!result.isError) {
          const r = payload && typeof payload === 'object' ? (payload as Rec) : {}
          // a record read by participant names its session only in the answer: one outside the reach is withheld whole
          if (t.name === 'get_collaboration' && typeof a.participant_id === 'string' && a.participant_id) {
            const owner = typeof r.session_id === 'string' ? r.session_id : null
            if (owner === null || !(owner === deps.session_id || reach.includes(owner))) return refuse(scopeRefusal(conn, deps.session_id, t.name, { session_id: owner ?? 's_000000000000' }, reach, surface) ?? 'outside')
          }
          // a session this director created joins its reach, recorded on the director session (never from an argument)
          if (t.name === 'create_session' && typeof r.id === 'string' && deps.director_session_id) addAuthorizedSession(conn, deps.director_session_id, r.id)
        }
        notify(payload, !!result.isError)
        return payload
      },
    })
  }
  return {
    surface, tools,
    close: async () => {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    },
  }
}

/** One line about a tool call for the turn's record and the thread: the arguments that name things, cut short. */
export function callSummary(name: string, args: Rec): string {
  // a plan: its steps by id and participant, and what follows the last
  if (name === 'schedule' && Array.isArray(args.nodes)) {
    const steps = (args.nodes as Rec[]).map((n) => `${String(n?.id ?? '?')}(${String(n?.participant ?? '?')})`)
    return `${steps.length} step${steps.length === 1 ? '' : 's'}: ${steps.join(' ')} · then ${String(args.then ?? 'stop')}`.slice(0, 300)
  }
  const keys = TOOL_CALL_METADATA_KEYS[name] ?? ['run_id', 'session_id', 'workspace_id', 'proposal_id', 'approval_id', 'path', 'checkpoint_id', 'model', 'label', 'text', 'prompt', 'note', 'decision', 'status', 'kind']
  const bits: string[] = []
  for (const key of keys) {
    const v = args[key]
    if (v === undefined || v === null || v === '') continue
    const text = typeof v === 'string' ? v : JSON.stringify(v)
    bits.push(`${key}=${text.length > 80 ? `${text.slice(0, 80)}…` : text}`)
  }
  // what a v2 call links: the runs it cites and the answers it hands over, by run (never their content)
  for (const key of ['cites', 'receive_run_ids'] as const) {
    if (!Array.isArray(args[key]) || !(args[key] as unknown[]).length || keys.includes(key)) continue
    const ids = (args[key] as unknown[]).map((c) => (typeof c === 'string' ? c : String((c as Rec)?.run_id ?? '?')))
    bits.push(`${key}=${ids.join(',')}`)
  }
  const order = args.work_order && typeof args.work_order === 'object' ? (args.work_order as Rec) : null
  if (order && typeof order.label === 'string') bits.push(`label=${order.label}`)
  return bits.join(' ').slice(0, 300)
}

/** A call's arguments as the turn's record keeps them: whole while they stay small, else not at all. */
export const MAX_KEPT_ARGS_CHARS = 16_000
export function keptArgs(args: Rec): Rec | null {
  try { return JSON.stringify(args).length <= MAX_KEPT_ARGS_CHARS ? args : null } catch { return null }
}

/** What a call's result said, as the person reads it under the call: an error's or a refusal's reason in full (the
 *  director acted on it), else the one line `resultSummary` makes. */
export function callOutcome(result: unknown, isError: boolean): string {
  const r = result && typeof result === 'object' && !Array.isArray(result) ? (result as Rec) : {}
  const failed = isError || r.status === 'error' || (typeof r.status === 'string' && /^refused/.test(r.status))
  if (failed) return String(r.error ?? r.reason ?? '').slice(0, 2000)
  // a plan taken: which interaction, at which revision, how many steps it holds now
  const bits = [resultSummary(result, false).summary]
  if (typeof r.interaction_id === 'string') bits.unshift(`plan accepted for ${r.interaction_id}`)
  if (typeof r.revision === 'number') bits.push(`revision ${r.revision}`)
  if (Array.isArray(r.nodes)) bits.push(`${r.nodes.length} step${r.nodes.length === 1 ? '' : 's'}`)
  return bits.filter(Boolean).join(' · ')
}

/** One line about a tool's result: its status, a run id it started, a count it returned. */
export function resultSummary(result: unknown, isError: boolean): { status: string; summary: string } {
  const r = result && typeof result === 'object' && !Array.isArray(result) ? (result as Rec) : {}
  if (isError) return { status: 'error', summary: String(r.error ?? r.reason ?? '').slice(0, 200) }
  // the call's own status: refused (by the harness or this session), else ok — a run's status in the payload is a fact about the run
  const status = typeof r.status === 'string' && /^refused/.test(r.status) ? 'refused' : 'ok'
  const bits: string[] = []
  if (typeof r.id === 'string') bits.push(r.id)
  if (status === 'ok' && typeof r.status === 'string' && r.status !== 'ok') bits.push(r.status)
  if (typeof r.finished === 'boolean') bits.push(r.finished ? 'finished' : 'still running')
  if (typeof r.reason === 'string') bits.push(r.reason.slice(0, 120))
  for (const key of ['runs', 'files', 'entries', 'results', 'proposals', 'models']) if (Array.isArray(r[key])) bits.push(`${(r[key] as unknown[]).length} ${key}`)
  return { status, summary: bits.join(' · ').slice(0, 200) }
}
