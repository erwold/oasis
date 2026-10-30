import { measureImage, ImageRefused } from '../llm/images.ts'
/** The director's tools, thin over the harness's REST API, one per thing a director reads or does — a session's
 *  state with its runs, a run's result or its steps, a working folder with its saved versions and its changes, a file
 *  or a folder, a command in it; a run started, continued or set apart; an integration. Each is one endpoint (or one
 *  plus a bounded read of what it returned); the harness's refusal is the tool's error, word for word. Reads are
 *  marked read-only so a client (ChatGPT's developer mode, say) confirms only the calls that change something. What
 *  the person keeps for themselves — permissions, approvals, the checks and protected paths a project already has —
 *  no tool changes.
 *
 *  One server per tool surface (surfaces/): director.v1 registers the baseline's tools exactly as they were and
 *  answers `tools/list` and `initialize` from the committed snapshot; director.v2 adds what the collaboration model
 *  brings (citations and handed-over answers, isolated separate tasks, relays, director-planned interactions, the
 *  collaboration record). The behaviour fixes (a follow-up never lands in another session than the one named, an
 *  original message never silently re-targets a dispatch, a separate task never inherits a follow-up through its
 *  constraints, one request key never stands for two requests) hold on both. */

import { realpathSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ListToolsRequestSchema, type CallToolResult, type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import {
  CitationSchema, InteractionTemplateSchema, MAX_CITATIONS, MAX_INTERACTION_PARTICIPANTS, MAX_RELAY_PARTICIPANTS, MAX_RELAY_ROUNDS, MAX_SCHEDULE_NODES,
  ACTIVE_RUN_STATUSES, CheckConfigSchema, InteractionThenSchema, MAX_DIRECTED_TITLE, PARTICIPANT_ID, ReceiveRunIdsSchema, ScheduleNodeSchema, ScheduleNodeV2Schema,
  uiInputText, uiSurfaceText, z, type DirectorToolSurface,
} from '@oasis-code/contract'
import { PROMPT_TEXT } from '../prompt_texts.ts'
import { newId } from '../ids.ts'
import { expandUser } from '../config.ts'
import { Harness, HarnessError } from './harness.ts'
import { SERVER_INSTRUCTIONS } from './manual.ts'
import { connectorInstructionsFor, connectorToolsFor } from './surfaces/index.ts'

export const SERVER_NAME = 'oasis-code director'
// a client's tool call has to come back in time (ChatGPT's connectors allow about a minute); a longer wait is
// several calls, each returning `finished: false`
export const MAX_WAIT_S = 55
export const POLL_MS = 1000
export const PATCH_CAP = 60_000
export const TEXT_CAP = 6000
export const TRANSCRIPT_TAIL_MAX = 200
/** How many of a run's steps one get_run(view=events) page holds. */
export const EVENTS_PAGE = 40
/** How many items of each list one get_collaboration page holds by default, and at most. */
export const COLLAB_PAGE = 50
export const COLLAB_PAGE_MAX = 100
const USAGE_KEYS = ['requests', 'tool_calls', 'input_tokens', 'output_tokens', 'total_tokens', 'cache_read_tokens', 'cache_write_tokens']

export const READ: ToolAnnotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
/** a shell command: it may change anything the sandbox lets it, and reach the network the session grants */
export const COMMAND: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }

/** The `_meta` key under which the in-process native director passes its call's context (director session, turn,
 *  tool call). Read only by a server built for the native audience — one only the harness itself connects to, over
 *  an in-memory transport; a server on HTTP ignores it, so no outside client can claim a director's turn. */
export const NATIVE_CALL_META = 'oasis-code/director-call'

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const pick = (source: unknown, keys: string[]): Rec => Object.fromEntries(keys.map((k) => [k, rec(source)[k] ?? null]))
const active = (status: unknown) => (ACTIVE_RUN_STATUSES as readonly string[]).includes(String(status))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** A tool error: the harness's refusal, or a director-side check, as the client sees it. */
export class ToolError extends Error { constructor(message: string) { super(message); this.name = 'ToolError' } }

/** A tool's answer as MCP content blocks of its own (an image beside its text), not one JSON text. */
class ToolContent { constructor(readonly content: CallToolResult['content']) {} }

function structured(payload: Rec): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload }
}

/** The idempotency key a tool that starts something takes: the same key again is the same project, session or run. */
const REQUEST_ID = z.string().min(8).max(100).nullable().optional()
  .describe('your key for this request (8+ characters, e.g. a UUID): if a call times out or errors and you send the very same request again, reuse it — the harness answers with what the first one made instead of making it twice')
void REQUEST_ID

const T = PROMPT_TEXT
const P = (key: string): string => PROMPT_TEXT[`connector_parameter.${key}` as keyof typeof PROMPT_TEXT]
const T2 = (key: string): string => PROMPT_TEXT[`connector.v2.${key}` as keyof typeof PROMPT_TEXT]
const P2 = (key: string): string => PROMPT_TEXT[`connector_parameter.v2.${key}` as keyof typeof PROMPT_TEXT]

/** One line per tool call for the director's log: the tool, its arguments (each string cut short, a message's words
 *  left out), how it ended and how long it took — what a client did, readable afterwards when it reports trouble. */
export function callLine(name: string, args: unknown, ms: number, error: string | null): string {
  const shown = Object.fromEntries(Object.entries(rec(args)).map(([k, v]) => [k, k === 'text' ? `(${String(v).length} chars)` : typeof v === 'string' && v.length > 80 ? `${v.slice(0, 80)}…` : v]))
  return `[director] call ${name} ${JSON.stringify(shown)} → ${error === null ? 'ok' : `error: ${error.slice(0, 200)}`} (${Math.round(ms)} ms)`
}

export interface ServerOptions {
  /** the tool surface this server is (default: director.v1, the baseline's) */
  surface?: DirectorToolSurface
  /** connector (an MCP client over HTTP or stdio) or native (the harness's own director, in process) */
  audience?: 'connector' | 'native'
  log?: (line: string) => void
  /** answer tools/list and initialize from the surface's committed snapshot (default: true; the snapshot script
   *  turns it off to see what the code registers) */
  frozen?: boolean
}

/** What one call's handler reaches the harness with: a copy of the harness carrying this call's context headers. */
interface Cx {
  call(method: 'GET' | 'POST' | 'PUT', endpoint: string, opts?: { params?: Rec; body?: Rec }): Promise<unknown>
  upload(endpoint: string, bytes: Uint8Array, params: Rec): Promise<unknown>
  waiting(): Promise<Rec[]>
  sessionOf(given: string | null | undefined): Promise<string>
}

/** v10 open_project's worktree: a new branch of a local repository, its base and its folder. */
interface WorktreeArgs { branch: string; base?: string | null; folder?: string | null }

export function buildServer(harness: Harness, options: ServerOptions | ((line: string) => void) = {}): McpServer {
  const opts: ServerOptions = typeof options === 'function' ? { log: options } : options
  const surface: DirectorToolSurface = opts.surface ?? 'director.v1'
  const audience = opts.audience ?? 'connector'
  const frozen = opts.frozen ?? true
  const log = opts.log ?? (() => {})
  // v2 and every surface after it: what v2 changed stays; v3 adds steer_run and its own descriptions; v4 is v3 with
  // a note's rendering said; v5 is v4 asking the connector's client to record its final answer in the thread
  const v2 = surface !== 'director.v1'
  // v6 is v5 with its commands, sessions and dispatches under the session's access (full or sandbox): its bash says so
  // and asks the command route for the session's access; v1–v5 keep the sandbox they describe (policy/access.ts)
  // v7 is v6 saying a session is one task again (task_session_id only links a session into another's task); v8 is v7
  // with SSH targets: projects on a saved target, its directories, port forwards, and a remote binding on each workspace
  // v9 is v8 whose SSH hosts are saved and connected by connect_ssh, on the person's yes in the app
  // v10 is v9 whose open_project makes a new Git worktree of a local repository, on a new branch, as a direct project
  // v11 is v10 whose read_file shows the connector's model a PNG, JPEG or WebP file as an image
  const v11 = surface === 'director.v11'
  const v10 = surface === 'director.v10' || v11
  const v9 = surface === 'director.v9' || v10
  const v8 = surface === 'director.v8' || v9
  const v7 = surface === 'director.v7' || v8
  const v6 = surface === 'director.v6' || v7
  const v5 = surface === 'director.v5' || v6
  const v4 = surface === 'director.v4' || v5
  const v3 = surface === 'director.v3' || v4
  const native = audience === 'native'
  const instructions = frozen && !native ? connectorInstructionsFor(surface) : v9 && !native ? T['connector.v7.instructions'] + '\n\n' + T['connector.v9.remote'] : v8 && !native ? T['connector.v7.instructions'] + '\n\n' + T['connector.v8.remote'] : v7 && !native ? T['connector.v7.instructions'] : v6 && !native ? T['connector.v6.instructions'] : v5 && !native ? T['connector.v5.instructions'] : v3 ? T['connector.v3.instructions'] : v2 ? T['connector.v2.instructions'] : SERVER_INSTRUCTIONS
  const server = new McpServer({ name: SERVER_NAME, version: v11 ? '11' : v10 ? '10' : v9 ? '9' : v8 ? '8' : v7 ? '7' : v6 ? '6' : v5 ? '5' : v4 ? '4' : v3 ? '3' : v2 ? '2' : '1' }, { instructions })
  /** a v2-family text: the surface's own when it names one (v10 down to v3), else v2's */
  const TS = (key: string): string => (v10 ? PROMPT_TEXT[`connector.v10.${key}` as keyof typeof PROMPT_TEXT] : undefined)
    ?? (v9 ? PROMPT_TEXT[`connector.v9.${key}` as keyof typeof PROMPT_TEXT] : undefined)
    ?? (v8 ? PROMPT_TEXT[`connector.v8.${key}` as keyof typeof PROMPT_TEXT] : undefined)
    ?? (v7 ? PROMPT_TEXT[`connector.v7.${key}` as keyof typeof PROMPT_TEXT] : undefined)
    ?? (v6 ? PROMPT_TEXT[`connector.v6.${key}` as keyof typeof PROMPT_TEXT] : undefined)
    ?? (v5 ? PROMPT_TEXT[`connector.v5.${key}` as keyof typeof PROMPT_TEXT] : undefined)
    ?? (v4 ? PROMPT_TEXT[`connector.v4.${key}` as keyof typeof PROMPT_TEXT] : undefined)
    ?? (v3 ? PROMPT_TEXT[`connector.v3.${key}` as keyof typeof PROMPT_TEXT] : undefined) ?? T2(key)
  const P6 = (key: string): string => PROMPT_TEXT[`connector_parameter.v6.${key}` as keyof typeof PROMPT_TEXT]
  const PS = (key: string): string => (v8 ? PROMPT_TEXT[`connector_parameter.v8.${key}` as keyof typeof PROMPT_TEXT] : undefined)
    ?? (v6 ? PROMPT_TEXT[`connector_parameter.v6.${key}` as keyof typeof PROMPT_TEXT] : undefined)
    ?? (v3 ? PROMPT_TEXT[`connector_parameter.v3.${key}` as keyof typeof PROMPT_TEXT] : undefined) ?? P2(key)

  /** The call's harness: the surface always, and — on the native audience only — the director call it is. */
  function cxOf(extra: unknown): Cx {
    const meta = native ? rec(rec(rec(extra)._meta)[NATIVE_CALL_META]) : {}
    const h = harness.with({ surface, director_session_id: str(meta.director_session_id), turn_id: str(meta.turn_id), tool_call_id: typeof meta.tool_call_id === 'string' ? meta.tool_call_id : null })
    const call = async (method: 'GET' | 'POST' | 'PUT', endpoint: string, o: { params?: Rec; body?: Rec } = {}): Promise<unknown> => {
      try {
        if (method === 'GET') return await h.get(endpoint, o.params ?? {})
        if (method === 'PUT') return await h.put(endpoint, o.body ?? {})
        return await h.post(endpoint, o.body ?? null)
      } catch (error) {
        if (error instanceof HarnessError) {
          // one key for two requests, refused by the harness before anything started: said as this tool says it
          const conflict = error.status === 409 ? /client_request_id (\S+) was already used for another request \((?:run )?([^)]+)\)/.exec(error.detail) : null
          if (conflict) throw new ToolError(`request_id ${conflict[1]} already started run ${conflict[2]} for a different request; nothing new was started. A different request takes a different request_id.`)
          throw new ToolError(error.status === 0 ? error.detail : `the harness refused (${error.status}): ${error.detail}`)
        }
        throw error
      }
    }
    /** The sessions an oasis-code director turn waits on now: the person's words reach the ChatGPT page with nothing
     *  else (no session id), so the session to work in is asked of the harness. */
    const waiting = async (): Promise<Rec[]> => list(rec(await call('GET', '/api/director/waiting')).waiting).map(rec)
    return {
      call, waiting,
      upload: (endpoint, bytes, params) => h.upload(endpoint, bytes, params),
      /** The session named, else the one oasis-code waits on (exactly one); otherwise the director is told what to pass. */
      sessionOf: async (given) => {
        if (given) return given
        const w = await waiting()
        if (w.length === 1) return String(w[0]!.session_id)
        if (!w.length) throw new ToolError('session_id is required: no oasis-code session is waiting on you (list_projects shows the sessions)')
        throw new ToolError(`session_id is required: oasis-code waits on you in ${w.length} sessions — ${w.map((x) => `${String(x.session_id)} ("${String(x.title)}")`).join(', ')}`)
      },
    }
  }

  /** The original user turn whose stored message a dispatch takes: the one named; on v1 only, else the user turn the
   *  session's director waits on (v1's connector instructions promise that binding). */
  async function originalTurn(cx: Cx, sessionId: string, turnId: string | null | undefined, implicit: boolean): Promise<Rec | null> {
    const held = turnId || (implicit ? (await cx.waiting()).find((w) => w.session_id === sessionId && w.turn_kind === 'user')?.turn_id : null)
    if (!held) return null
    const turn = rec(await cx.call('GET', `/api/director-turns/${String(held)}`))
    if (turn.session_id !== sessionId || !turn.envelope || (turn.kind !== undefined && turn.kind !== 'user')) throw new ToolError('source_turn_id must name an original user turn of this session')
    return turn
  }

  /** registerTool with the thrown error as the tool's error text (the SDK's own catch keeps the message). */
  const tool = <S extends z.ZodRawShape>(name: string, description: string, annotations: ToolAnnotations, shape: S, fn: (args: z.infer<z.ZodObject<S>>, cx: Cx) => Promise<Rec | string | ToolContent>) => {
    server.registerTool(name, { description, inputSchema: shape as never, annotations }, (async (args: unknown, extra: unknown) => {
      const began = performance.now()
      try {
        const result = await fn(args as z.infer<z.ZodObject<S>>, cxOf(extra))
        log(callLine(name, args, performance.now() - began, null))
        return typeof result === 'string' ? { content: [{ type: 'text', text: result }] } : result instanceof ToolContent ? { content: result.content } : structured(result)
      } catch (error) {
        log(callLine(name, args, performance.now() - began, (error as Error).message))
        throw error
      }
    }) as never)
  }

  if (v2) registerV2(); else registerV1()

  // the surface's committed list, byte for byte, whatever zod or the SDK would make of the shapes today
  if (frozen && !native) {
    const tools = connectorToolsFor(surface)
    if (tools.length) server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: tools as never }))
  }
  return server

  // ---- shared handlers ------------------------------------------------------------------------------------------

  async function currentSession(cx: Cx): Promise<Rec> {
    const w = await cx.waiting()
    return { app_reads_chat: w.length > 0, session: w.length === 1 ? w[0]! : null, sessions: w.length > 1 ? w : undefined }
  }

  async function listModels(cx: Cx): Promise<Rec> {
    const data = rec(await cx.call('GET', '/api/models'))
    return { default: data.default ?? null, models: list(data.models).map((m) => pick(m, ['id', 'label', 'provider', 'auth', 'account_label', 'credential', 'credential_hint', 'context_window', 'window_source', 'default', 'supported_thinking', 'capabilities'])) }
  }

  async function openProject(cx: Cx, a: { path: string; name?: string | null; instructions?: string | null; reuse: boolean; mode: string; request_id?: string | null }, refuseWhileHeld: boolean): Promise<Rec> {
    if (refuseWhileHeld) {
      const held = (await cx.waiting())[0]
      if (held) throw new ToolError(`the person is writing to you from oasis-code session ${String(held.session_id)} ("${String(held.title)}"): work there and answer in this chat`)
    }
    const wanted = real(a.path)
    if (a.reuse) {
      for (const p of list(await cx.call('GET', '/api/projects'))) {
        const source = rec(p).source_path
        if (rec(rec(p).target).kind !== 'ssh' && typeof source === 'string' && source && real(source) === wanted) return { ...projectSummary(p), reused: true }
      }
    }
    const body: Rec = { source_path: a.path, mode: a.mode }
    if (a.request_id) body.client_request_id = a.request_id
    if (a.name) body.name = a.name
    if (a.instructions) body.instructions = a.instructions
    const project = rec(await cx.call('POST', '/api/projects', { body }))
    return { ...projectSummary({ ...project, sessions: [] }), reused: false, import_report: project.import_report ?? null }
  }

  /** v6 open_project: reuse by folder and kind; the folder made first on request (its last component only); the
   *  project for tasks without a folder; arguments that ask two things refused before anything is done. */
  async function openProjectV6(cx: Cx, a: { path?: string | null; name?: string | null; instructions?: string | null; reuse: boolean; mode: string; create_directory?: boolean; no_folder?: boolean; request_id?: string | null }): Promise<Rec> {
    const path = str(a.path)
    if (a.no_folder) {
      const with_ = [path ? 'path' : '', a.create_directory ? 'create_directory' : '', a.mode !== 'direct' ? 'mode' : ''].filter(Boolean)
      if (with_.length) throw new ToolError(`no_folder is not combined with ${with_.join(', ')}: no_folder returns the project for tasks without a folder; a folder is opened with path (and mode, create_directory) and without no_folder. Nothing was opened.`)
      const existed = list(await cx.call('GET', '/api/projects')).map(rec).some((p) => rec(p.config).no_folder === true)
      const project = rec(await cx.call('POST', '/api/projects', { body: { no_folder: true } }))
      return { ...projectSummary({ ...project, sessions: list(project.sessions) }), no_folder: true, reused: existed }
    }
    if (!path) throw new ToolError('path is required: the absolute path of the folder to open (create_directory makes it first), or no_folder for the project of tasks without a folder. Nothing was opened.')
    const wanted = real(path)
    const same = list(await cx.call('GET', '/api/projects')).map(rec).filter((p) => rec(p.target).kind !== 'ssh' && typeof p.source_path === 'string' && p.source_path && real(p.source_path) === wanted)
    const kindOf = (p: Rec) => String(p.kind ?? 'snapshot')
    if (a.reuse) {
      const hit = same.find((p) => kindOf(p) === a.mode)
      if (hit) return { ...projectSummary(hit), reused: true, directory_created: false, same_folder_projects: same.filter((p) => p.id !== hit.id).map((p) => ({ id: p.id ?? null, kind: kindOf(p) })) }
    }
    const body: Rec = { source_path: path, mode: a.mode }
    if (a.create_directory) body.create_directory = true
    if (a.request_id) body.client_request_id = a.request_id
    if (a.name) body.name = a.name
    if (a.instructions) body.instructions = a.instructions
    const project = rec(await cx.call('POST', '/api/projects', { body }))
    return {
      ...projectSummary({ ...project, sessions: [] }), reused: false, import_report: project.import_report ?? null, directory_created: project.directory_created === true,
      same_folder_projects: same.filter((p) => p.id !== project.id).map((p) => ({ id: p.id ?? null, kind: kindOf(p) })),
    }
  }

  async function openProjectV8(cx: Cx, a: Parameters<typeof openProjectV6>[1] & { target_id?: string | null; remote_state_path?: string | null }): Promise<Rec> {
    if (!a.target_id) {
      if (a.remote_state_path) throw new ToolError('remote_state_path requires target_id')
      return openProjectV6(cx, a)
    }
    if (!a.path || a.mode !== 'direct' || a.no_folder || a.create_directory) throw new ToolError('A remote project requires an existing absolute path and direct mode; no_folder and create_directory are unavailable.')
    if (a.reuse) {
      const hit = list(await cx.call('GET', '/api/projects')).map(rec).find(p => rec(p.target).kind === 'ssh' && rec(p.target).target_id === a.target_id && p.kind === 'direct' && (p.source_path === a.path || rec(p.import_report).requested_path === a.path) && (!a.remote_state_path || rec(p.remote).state_path === a.remote_state_path))
      if (hit) return { ...projectSummary(hit), target: hit.target, remote: hit.remote, reused: true }
    }
    const project = rec(await cx.call('POST', '/api/projects', { body: { source_path: a.path, target: { kind: 'ssh', target_id: a.target_id }, mode: 'direct',
      ...(a.remote_state_path ? { remote_state_path: a.remote_state_path } : {}), ...(a.name ? { name: a.name } : {}), ...(a.instructions ? { instructions: a.instructions } : {}), ...(a.request_id ? { client_request_id: a.request_id } : {}) } }))
    return { ...projectSummary(project), target: project.target, remote: project.remote, reused: false, import_report: project.import_report }
  }

  /** v10 open_project with worktree: the project already open on the repository's branch when reuse, else a new
   *  worktree made by the harness (`git worktree add -b`) and opened in direct mode. */
  async function openWorktreeProject(cx: Cx, a: Parameters<typeof openProjectV8>[1], wt: WorktreeArgs): Promise<Rec> {
    const also = [a.target_id ? 'target_id' : '', a.no_folder ? 'no_folder' : '', a.create_directory ? 'create_directory' : '', a.mode !== 'direct' ? `mode ${a.mode}` : ''].filter(Boolean)
    if (also.length) throw new ToolError(`worktree is not combined with ${also.join(', ')}: a worktree is made of a local repository and opened in direct mode. Nothing was opened.`)
    const path = str(a.path)
    if (!path) throw new ToolError('path is required with worktree: a folder of the local repository. Nothing was opened.')
    if (a.reuse) {
      const wanted = real(path)
      const hit = list(await cx.call('GET', '/api/projects')).map(rec).find((p) => {
        const made = rec(rec(p.import_report).worktree)
        return typeof made.repository === 'string' && (wanted === made.repository || wanted.startsWith(`${made.repository}/`)) && made.branch === wt.branch
      })
      if (hit) return { ...projectSummary(hit), worktree: rec(hit.import_report).worktree, reused: true }
    }
    const body: Rec = { source_path: path, mode: 'direct', worktree: { branch: wt.branch, base: wt.base ?? null, folder: wt.folder ?? null } }
    if (a.request_id) body.client_request_id = a.request_id
    if (a.name) body.name = a.name
    if (a.instructions) body.instructions = a.instructions
    const project = rec(await cx.call('POST', '/api/projects', { body }))
    return { ...projectSummary({ ...project, sessions: [] }), worktree: rec(project.import_report).worktree ?? null, reused: false, import_report: project.import_report ?? null }
  }

  async function setProjectConfig(cx: Cx, a: { project_id: string; instructions?: string | null; checks?: Rec[] | null; protected_paths?: string[] | null; default_model?: string | null }): Promise<Rec> {
    const { project_id, instructions, checks, protected_paths, default_model } = a
    const body: Rec = {}
    for (const [k, v] of [['instructions', instructions], ['checks', checks], ['protected_paths', protected_paths], ['default_model', default_model]] as const) {
      if (v !== null && v !== undefined) body[k] = v
    }
    if (!Object.keys(body).length) throw new ToolError('nothing to set: pass instructions, checks, protected_paths or default_model')
    // the checks and the protected paths a project has are the person's: a director may add to them, never take
    // them away or change what they check (the app is where the person changes those)
    if (checks || protected_paths) {
      const current = rec(list(await cx.call('GET', '/api/projects')).map(rec).find((p) => p.id === project_id)?.config)
      if (checks) {
        const before = list(current.checks).map((c) => CheckConfigSchema.safeParse(c)).filter((r) => r.success).map((r) => r.data!)
        const after = checks.map((c) => CheckConfigSchema.safeParse(c)).filter((r) => r.success).map((r) => r.data!)
        const kept = before.every((b) => after.some((x) => JSON.stringify(x) === JSON.stringify(b)))
        if (!kept) throw new ToolError("the project's checks are the person's: a director may add checks, not remove or change the ones the project has; the person changes them in the app")
      }
      if (protected_paths) {
        const before = list(current.protected_paths).map(String)
        if (!before.every((path) => protected_paths.includes(path))) throw new ToolError("the project's protected paths are the person's: a director may add paths, not remove the ones the project protects; the person changes them in the app")
      }
    }
    // added in one step on the harness's side: what another director added meanwhile stays too
    return projectSummary({ ...rec(await cx.call('POST', `/api/projects/${project_id}/config/additions`, { body })), sessions: [] })
  }

  async function createSession(cx: Cx, a: { project_id?: string | null; title: string; model?: string | null; request_id?: string | null; task_session_id?: string | null; roots?: Rec[] | null }, refuseWhileHeld: boolean): Promise<Rec> {
    let projectId = a.project_id ?? null
    if (refuseWhileHeld) {
      const held = (await cx.waiting())[0]
      if (held) throw new ToolError(`the person is writing to you from oasis-code session ${String(held.session_id)} ("${String(held.title)}"): work there and answer in this chat`)
    } else if (!projectId) {
      const w = await cx.waiting()
      if (w.length === 1 && typeof w[0]!.project_id === 'string') projectId = w[0]!.project_id
    }
    if (!projectId) throw new ToolError('project_id is required: no single waiting session names a project (list_projects shows them)')
    const body: Rec = { title: a.title }
    if (a.model) body.model = a.model
    if (a.request_id) body.client_request_id = a.request_id
    // v6: the task it joins and its folders besides the working folder
    if (v6 && a.task_session_id) body.task_session_id = a.task_session_id
    if (v6 && Array.isArray(a.roots) && a.roots.length) body.roots = a.roots
    const made = await cx.call('POST', `/api/projects/${projectId}/sessions`, { body })
    return v6 ? sessionSummaryV6(made) : sessionSummary(made)
  }

  async function postNote(cx: Cx, a: { session_id: string; question: string; answer: string; model: string; source: string }): Promise<Rec> {
    if ((await cx.waiting()).some((w) => w.session_id === a.session_id)) {
      return { recorded: false, note: 'oasis-code shows your answer from this chat: no note is needed' }
    }
    const note = await cx.call('POST', `/api/sessions/${a.session_id}/director-notes`, { body: { source: a.source, model: a.model, question: a.question, answer: a.answer } })
    return pick(note, ['id', 'session_id', 'source', 'model', 'created_at'])
  }

  async function attachImage(cx: Cx, a: { session_id?: string | null; name: string; data_base64: string }): Promise<Rec> {
    const bytes = new Uint8Array(Buffer.from(a.data_base64.replace(/^data:[^,]*,/, ''), 'base64'))
    if (!bytes.length) throw new ToolError('data_base64 decodes to nothing')
    try {
      // Keep attach_image an image-only compatibility tool; generic uploads use the session attachment API.
      measureImage(bytes)
      return rec(await cx.upload(`/api/sessions/${await cx.sessionOf(a.session_id)}/attachments`, bytes, { name: a.name }))
    } catch (error) {
      if (error instanceof ImageRefused) throw new ToolError(`attachment refused (415): ${error.message}`)
      if (error instanceof HarnessError) throw new ToolError(error.status === 0 ? error.detail : `the harness refused (${error.status}): ${error.detail}`)
      throw error
    }
  }

  /** A run's ended result, a page of its final answer at a time. v1 reads the answer off the run's transcript (as the
   *  baseline did); v2 reads the receipt's final_text of that exact run, the transcript only when a receipt holds none. */
  async function finished(cx: Cx, run: Rec, cursor: string | null | undefined): Promise<Rec> {
    const summary = summaryOf(run)
    let whole: string
    const receiptText = rec(run.receipt).final_text
    if (v2 && typeof receiptText === 'string' && receiptText) whole = receiptText
    else whole = finalText(list(rec(await cx.call('GET', `/api/runs/${String(run.id)}/transcript`)).entries))
    // the final answer a page at a time: the cursor is where the page starts
    const start = Math.max(0, Math.min(whole.length, Math.trunc(Number(cursor ?? 0)) || 0))
    const end = Math.min(whole.length, start + TEXT_CAP)
    summary.final_text = whole.slice(start, end)
    summary.final_text_chars = whole.length
    summary.next_cursor = end < whole.length ? String(end) : null
    summary.executions = list(run.executions).slice(0, 50).map((x) => pick(x, ['id', 'command', 'status', 'exit_code', 'duration_ms', 'timed_out']))
    if (v2) {
      summary.final_text_source = typeof receiptText === 'string' && receiptText ? 'receipt.final_text' : 'transcript'
      summary.edges = await runEdges(cx, String(run.id))
    }
    // the director read the receipt itself: a task event about this run needs no turn of its own
    try { await cx.call('POST', `/api/runs/${String(run.id)}/director-ack`) } catch { /* not a directed session, or an older harness */ }
    return summary
  }

  async function getRun(cx: Cx, a: { run_id: string; view: 'result' | 'events'; cursor?: string | null; wait_s?: number }): Promise<Rec> {
    const { run_id, view, cursor } = a
    const wait_s = a.wait_s ?? 0
    if (view === 'events') {
      const data = rec(await cx.call('GET', `/api/runs/${run_id}/transcript`))
      const entries = list(data.entries)
      const start = Math.max(0, Math.min(entries.length, Math.trunc(Number(cursor ?? 0)) || 0))
      const page = entries.slice(start, start + EVENTS_PAGE)
      return { run_id, status: data.status ?? null, model: data.model ?? null, total_entries: entries.length, entries: page.map((e) => boundedEntry(rec(e))), next_cursor: start + EVENTS_PAGE < entries.length ? String(start + EVENTS_PAGE) : null }
    }
    const deadline = Date.now() + Math.max(0, Math.min(wait_s, MAX_WAIT_S)) * 1000
    for (;;) {
      const run = rec(await cx.call('GET', `/api/runs/${run_id}`))
      if (!active(run.status)) return finished(cx, run, cursor)
      if (Date.now() >= deadline) {
        // v6: a run queued behind another writer of its folder says what it waits for
        const waiting = v6 ? rec(run.waiting) : {}
        const behind = Object.keys(waiting).length ? ` behind ${String(waiting.blocking_kind ?? 'a writer')} ${String(waiting.blocking_run_id ?? waiting.blocking_owner ?? '')}`.trimEnd() + ` of ${String(waiting.workspace_id ?? 'its folder')} (position ${String(waiting.position ?? '?')})` : ''
        return { ...summaryOf(run), note: wait_s ? `still ${String(run.status)}${behind} after ${wait_s} s; call get_run again` : `still ${String(run.status)}${behind}` }
      }
      await sleep(POLL_MS)
    }
  }

  /** The edges into and out of one run (v2), bounded; null when the harness serves no collaboration record. */
  async function runEdges(cx: Cx, runId: string): Promise<Rec | null> {
    let data: Rec
    try { data = rec(await cx.call('GET', `/api/runs/${runId}/collaboration`)) } catch { return null }
    const edge = (e: unknown) => boundedValue(pick(e, ['id', 'kind', 'from', 'to', 'basis', 'meta', 'created_at']))
    return { incoming: list(data.incoming).slice(0, 20).map(edge), outgoing: list(data.outgoing).slice(0, 20).map(edge), incoming_total: list(data.incoming).length, outgoing_total: list(data.outgoing).length }
  }

  async function workspace(cx: Cx, a: { workspace_id: string; include_diff: boolean; path?: string | null; cursor?: string | null }): Promise<Rec> {
    const { workspace_id, include_diff, path, cursor } = a
    const ws = rec(await cx.call('GET', `/api/workspaces/${workspace_id}`))
    const out: Rec = {
      ...pick(ws, ['id', 'project_id', 'session_id', 'kind', 'path', 'branch', 'base_commit', 'source_mount', 'status', 'lock_owner']),
      checkpoints: list(ws.checkpoints).map((c) => pick(c, v6 ? ['id', 'run_id', 'commit_sha', 'note', 'created_at', 'excluded_nested_repositories'] : ['id', 'run_id', 'commit_sha', 'note', 'created_at'])),
      checks: list(ws.checks).map((c) => pick(c, ['id', 'check_id', 'status', 'exit_code', 'counts', 'reason', 'stale', 'created_at'])),
    }
    if (v6) out.effective_roots = list(ws.effective_roots)
    if (v8) { out.target = ws.target; out.remote = ws.remote }
    if (include_diff) {
      const diff = rec(await cx.call('GET', `/api/workspaces/${workspace_id}/diff`, { params: path ? { path } : {} }))
      const patch = typeof diff.patch === 'string' ? diff.patch : ''
      const start = Math.max(0, Math.min(patch.length, Math.trunc(Number(cursor ?? 0)) || 0))
      const end = Math.min(patch.length, start + PATCH_CAP)
      out.diff = { ...pick(diff, ['base_commit', 'tree_sha', 'files', 'review_flags', 'external_changes']), patch: patch.slice(start, end), patch_truncated: end < patch.length, next_cursor: end < patch.length ? String(end) : null, patch_bytes: patch.length }
    }
    return out
  }

  async function readFile(cx: Cx, a: { workspace_id: string; path: string; offset: number; limit: number }): Promise<Rec | ToolContent> {
    const { workspace_id, path, offset, limit } = a
    try {
      const file = rec(await cx.call('GET', `/api/workspaces/${workspace_id}/file`, { params: { path, offset_line: offset, limit_lines: limit } }))
      return { ...file, next_offset: file.next_offset_line ?? null }
    } catch (error) {
      // v11, to a connector: a file the text read refuses as binary or as over its size may be an image to show
      if (v11 && !native && error instanceof ToolError && /binary|up to 2 MiB|the read cap is/.test(error.message)) return readImage(cx, workspace_id, path)
      // a folder: its entries, paged the same way
      if (!(error instanceof ToolError) || !/is not a file/.test(error.message)) throw error
      const listing = rec(await cx.call('GET', `/api/workspaces/${workspace_id}/files`, { params: { path, offset: offset - 1, max_entries: limit } }))
      const entries = list(listing.entries)
      return { ...listing, kind: 'directory', next_offset: listing.truncated ? offset + entries.length : null }
    }
  }

  /** The image a file is, as an MCP image block (fitted by the harness) after its text: where it is and its size. */
  async function readImage(cx: Cx, workspaceId: string, path: string): Promise<ToolContent> {
    const { data_base64, ...seen } = rec(await cx.call('GET', `/api/workspaces/${workspaceId}/image`, { params: { path } }))
    return new ToolContent([{ type: 'text', text: JSON.stringify(seen) }, { type: 'image', data: String(data_base64), mimeType: String(rec(seen.sent).media_type) }])
  }

  async function bash(cx: Cx, a: { workspace_id: string; session_id?: string | null; command?: string | null; execution_id?: string | null; cwd?: string | null; wait_s: number; timeout_s?: number | null; read_only?: boolean }): Promise<Rec> {
    const { workspace_id, command, execution_id, cwd, wait_s, timeout_s } = a
    if (!command === !execution_id) throw new ToolError('send a command, or the execution_id of one still running')
    const body: Rec = {
      wait_s, ...(command ? { command } : { execution_id }), ...(cwd ? { cwd } : {}), ...(timeout_s ? { timeout_s } : {}),
      ...(v6 && command ? { access: 'session', ...(a.session_id ? { session_id: a.session_id } : {}), ...(a.read_only === true ? { read_only: true } : {}) } : {}),
    }
    const out = rec(await cx.call('POST', `/api/workspaces/${workspace_id}/commands`, { body }))
    const picked = pick(out, ['status', 'execution_id', 'exit_code', 'duration_ms', 'stdout', 'stdout_shown', 'stderr', 'stderr_shown', 'truncated_at_cap', 'note'])
    if (!v6) return picked
    // v6: where it ran and what held it, its whole output's size and whether all of it was kept, why it stopped, and
    // — queued behind another writer of the folder — what it waits for (each when the harness answers it)
    for (const key of BASH_V6_KEYS) if (out[key] !== undefined) picked[key] = out[key]
    return picked
  }

  async function schedule(cx: Cx, a: { interaction_id: string; title?: string; nodes: Rec[]; then: string; expected_revision?: number | null }): Promise<Rec> {
    const { interaction_id, title, nodes, then, expected_revision } = a
    const body: Rec = { nodes, then, ...(title?.trim() ? { title: title.trim() } : {}) }
    if (expected_revision !== null && expected_revision !== undefined) body.expected_revision = expected_revision
    const detail = rec(await cx.call('POST', `/api/interactions/${interaction_id}/schedule`, { body }))
    return {
      interaction_id: detail.id ?? interaction_id, status: detail.status ?? null, revision: detail.revision ?? null, then: detail.then ?? null,
      budget: detail.budget ?? null, runs_started: detail.runs_started ?? null,
      nodes: list(detail.nodes).map((n) => pick(n, v2 ? ['id', 'participant', 'depends_on', 'receives', 'workspace', 'status', 'run_id', 'kind', 'cites', 'receive_runs'] : ['id', 'participant', 'depends_on', 'receives', 'workspace', 'status', 'run_id'])),
    }
  }

  async function integrate(cx: Cx, a: { workspace_id: string; checkpoint_ids: string[]; note: string }): Promise<Rec> {
    return rec(await cx.call('POST', `/api/workspaces/${a.workspace_id}/integrate`, { body: { checkpoint_ids: a.checkpoint_ids, note: a.note, verify: true } }))
  }

  /** A run the API answered for a request with a key: it must be the request made. One key for two requests is
   *  refused here whatever the harness behind does (an older one answers the first run for the key, in silence). */
  function sameRequest(run: Rec, key: string | null | undefined, expected: { session_id: string; resumes_run_id?: string | null; user_text?: string | null; prompt?: string | null }): Rec {
    if (!key) return run
    const differs: string[] = []
    if (typeof run.session_id === 'string' && run.session_id !== expected.session_id) differs.push(`session ${String(run.session_id)}`)
    if (expected.resumes_run_id !== undefined && (run.resumes_run_id ?? null) !== (expected.resumes_run_id ?? null)) differs.push(`continues ${String(run.resumes_run_id ?? 'nothing')}`)
    if (expected.user_text !== undefined && expected.user_text !== null && typeof run.user_text === 'string' && run.user_text !== expected.user_text) differs.push('another message')
    if (expected.prompt !== undefined && expected.prompt !== null && typeof rec(run.work_order).prompt === 'string' && rec(run.work_order).prompt !== expected.prompt) differs.push('another task')
    if (differs.length) throw new ToolError(`request_id ${key} already started run ${String(run.id)} for a different request (${differs.join(', ')}); nothing new was started. A different request takes a different request_id.`)
    return run
  }

  /** start_run on either surface. v1: the baseline's arguments; an original turn is the one named or, unnamed, the
   *  one the director waits on. v2: an original turn only when named, cites and received answers, isolated separate
   *  tasks. Both: a follow-up runs in the session named or not at all; an original message never re-targets the run
   *  the call names; constraints never carry a follow-up. */
  async function startRun(cx: Cx, a: Rec): Promise<Rec> {
    let text = typeof a.text === 'string' ? a.text : ''
    let attachments = list(a.attachments).map(String)
    let mentions = list(a.mentions).map(rec)
    let thinking = str(a.thinking)
    let fresh = a.fresh === true
    let resumeRunId = str(a.resume_run_id)
    const separate = a.separate === true
    const model = str(a.model)
    const requestId = str(a.request_id)
    const baseCheckpoint = str(a.base_checkpoint_id)
    const sessionGiven = str(a.session_id)
    const cites = v2 && Array.isArray(a.cites) && a.cites.length ? a.cites : undefined
    const receive = v2 && Array.isArray(a.receive_run_ids) && a.receive_run_ids.length ? a.receive_run_ids : undefined
    const expectedHead = v2 ? str(a.expected_head_run_id) : null
    // a follow-up runs in its run's session: a session named beside it must be that one
    let sid: string
    if (resumeRunId) {
      const owner = String(rec(await cx.call('GET', `/api/runs/${resumeRunId}`)).session_id)
      if (sessionGiven && sessionGiven !== owner) throw new ToolError(`resume_run_id ${resumeRunId} is not a run of session ${sessionGiven}: a follow-up continues in its own run's session. Nothing was started.`)
      sid = owner
    } else sid = await cx.sessionOf(sessionGiven)
    const original = await originalTurn(cx, sid, str(a.source_turn_id), !v2)
    const envelope = original ? rec(original.envelope) : null
    const budget = envelope?.budget
    let envelopeResume: string | null = null
    if (envelope) {
      if (!v2 && separate) throw new ToolError('an original director message cannot silently become a main-folder run: separate requires safe isolation; use start_interaction for multiple isolated participants')
      if (v2 && (text.trim() || attachments.length || mentions.length)) throw new ToolError('source_turn_id supplies the message, its attachments and mentions: text, attachments and mentions are not given with it. Nothing was started.')
      envelopeResume = typeof envelope.resumes_run_id === 'string' ? envelope.resumes_run_id : null
      // the original message continues a run, the call names another: two targets, neither taken in silence
      if (envelopeResume && resumeRunId && resumeRunId !== envelopeResume) throw new ToolError(`the original message (turn ${String(original!.id)}) continues run ${envelopeResume}; this call names run ${resumeRunId}. Nothing was started.`)
      text = String(envelope.text ?? '')
      attachments = list(envelope.attachments).map(String)
      mentions = list(envelope.mentions).map(rec)
      thinking = typeof envelope.thinking === 'string' ? envelope.thinking : thinking
      fresh = envelope.fresh === true
      resumeRunId = envelopeResume ?? resumeRunId
    }
    if (v2 && !envelope && !text.trim() && !attachments.length) throw new ToolError('text is required unless source_turn_id is given')
    // the original message handed to a finished run the caller chose (an interaction participant's, a separate one's):
    // that run's conversation and files go on, as a follow-up
    const followUp = !!resumeRunId && !envelopeResume
    if (separate && resumeRunId) throw new ToolError('separate and resume_run_id cannot be combined: a separate run starts afresh, a follow-up continues a finished run')
    if (baseCheckpoint && !separate) throw new ToolError('base_checkpoint_id applies to a separate run only (separate=true)')
    const restrictions: Rec = { ...rec(a.constraints) }
    delete restrictions.budget                                              // the person and the configuration set limits
    delete restrictions.prompt
    if ('resumes_run_id' in restrictions) throw new ToolError('constraints cannot name resumes_run_id: a follow-up is named by resume_run_id, and a separate run starts afresh. Nothing was started.')
    // v6: the answers handed over may be other sessions' ended runs (named with their session and run)
    const linked = (body: Rec) => { if (cites) body.cites = cites; if (receive) { body.receive_run_ids = receive; if (v6) body.receive_across_sessions = true } return body }
    if (followUp) {
      // a follow-up of a finished run: its conversation and its files go on, under its constraints unless narrowed here
      const body: Rec = { text }
      if (model) body.model = model
      if (thinking) body.thinking = thinking
      if (attachments.length) body.attachments = attachments
      if (requestId) body.client_request_id = requestId
      if (Object.keys(restrictions).length) body.work_order = restrictions
      if (expectedHead) body.expected_head_run_id = expectedHead
      const answer = rec(await cx.call('POST', `/api/runs/${resumeRunId}/resume`, { body: linked(body) }))
      // a group member's follow-up that waits in its interaction's queue (HTTP 202): no run yet — the step it is
      if (answer.queued === true) return queuedFollowup(answer, resumeRunId!, requestId)
      return summaryOf(sameRequest(answer, requestId, { session_id: sid, resumes_run_id: resumeRunId }))
    }
    if (separate) {
      if (attachments.length) throw new ToolError('attachments go with a message to the session; a separate run takes its text and constraints')
      const order: Rec = { ...restrictions, prompt: text }
      if (model) order.model = model
      if (baseCheckpoint) order.workspace = { base: baseCheckpoint }
      const body: Rec = { work_order: order }
      if (thinking) body.thinking = thinking
      if (requestId) body.client_request_id = requestId
      // v2: a workspace of its own whatever the project's kind (a direct folder is mounted read-only beside its output)
      if (v2) body.workspace_policy = 'isolated'
      const run = rec(await cx.call('POST', `/api/sessions/${sid}/work-orders`, { body: linked(body) }))
      return summaryOf(sameRequest(run, requestId, { session_id: sid, prompt: text }))
    }
    if (Object.keys(restrictions).length) throw new ToolError('constraints apply to a separate run (separate=true) or to the follow-up of one (resume_run_id); a message to the session runs under its own permissions')
    const body: Rec = { text, fresh, mentions, resumes_run_id: resumeRunId, ...(budget ? { budget } : {}) }
    if (attachments.length) body.attachments = attachments
    if (requestId) body.client_request_id = requestId
    if (model) body.model = model
    if (thinking) body.thinking = thinking
    const run = rec(await cx.call('POST', `/api/sessions/${sid}/chat`, { body: linked(body) }))
    return summaryOf(sameRequest(run, requestId, { session_id: sid, user_text: text }))
  }

  function summaryOf(run: Rec): Rec { return v6 ? runSummaryV6(run) : v2 ? runSummaryV2(run) : runSummary(run) }

  /** The answer of a follow-up the harness took but could not start yet (202): the interaction step it waits as. It
   *  names no run — there is none yet; the step's run starts when the interaction's queue reaches it, as that same
   *  participant's next run, and its end is told like any run this call started. */
  function queuedFollowup(answer: Rec, resumes: string, requestId: string | null): Rec {
    return {
      status: 'queued', queued: true, run_id: null, resumes_run_id: resumes, interaction_id: str(answer.interaction_id), node_id: str(answer.node_id),
      participant_id: str(answer.participant_id), request_id: requestId,
      note: `queued as step ${String(answer.node_id)} of interaction ${String(answer.interaction_id)}: no run has started yet; it starts when that interaction's queue reaches it`,
    }
  }

  // ---- director.v1: the baseline's tools, registered as they were ---------------------------------------------

  function registerV1(): void {
    const SESSION_ID = z.string().nullable().optional().describe(P('common.session_id'))
    const REQUEST_ID = z.string().min(8).max(100).nullable().optional().describe(P('common.request_id'))
    const MODEL = z.string().nullable().optional().describe(P('common.model'))

    tool('current_session', T['connector.current_session'], READ, {}, async (_a, cx) => currentSession(cx))
    tool('list_models', T['connector.list_models'], READ, {}, async (_a, cx) => listModels(cx))
    tool('list_projects', T['connector.list_projects'], READ, {}, async (_a, cx) => ({ projects: list(await cx.call('GET', '/api/projects')).map(projectSummary) }))
    tool('open_project', T['connector.open_project'], WRITE, {
      path: z.string().describe("an absolute folder path on the person's machine"),
      name: z.string().nullable().optional().describe("the project's name; default: the folder's name"),
      instructions: z.string().nullable().optional().describe('standing instructions every run of this project reads first'),
      reuse: z.boolean().default(true).describe('return the existing project of this folder instead of opening it again'),
      mode: z.enum(['direct', 'snapshot', 'attached']).default('direct').describe(P('open_project.mode')),
      request_id: REQUEST_ID,
    }, async (a, cx) => openProject(cx, a, true))
    tool('set_project_config', T['connector.set_project_config'], WRITE, {
      project_id: z.string(),
      instructions: z.string().nullable().optional().describe('standing instructions every run of the project reads first'),
      checks: z.array(z.record(z.string(), z.unknown())).nullable().optional().describe('[{id, command, parser: pytest|node_test|exit_code, timeout_s, required}]; the checks the project has stay as they are'),
      protected_paths: z.array(z.string()).nullable().optional().describe('globs no run may write; the paths the project protects stay protected'),
      default_model: z.string().nullable().optional().describe('the model new sessions of this project use'),
    }, async (a, cx) => setProjectConfig(cx, a))
    tool('create_session', T['connector.create_session'], WRITE, {
      project_id: z.string(),
      title: z.string().default('New task').describe('what this session is for; the person sees it in oasis-code'),
      model: MODEL,
      request_id: REQUEST_ID,
    }, async (a, cx) => createSession(cx, a, true))
    tool('get_session', T['connector.get_session'], READ, { session_id: z.string() }, async ({ session_id }, cx) => {
      const summary = sessionSummary(await cx.call('GET', `/api/sessions/${session_id}`))
      const tree = rec(await cx.call('GET', `/api/sessions/${session_id}/runs/tree`))
      summary.runs = list(tree.runs).map((r) => pick(r, ['id', 'parent_run_id', 'resumes_run_id', 'spawned_by', 'label', 'model', 'status', 'live', 'error', 'workspace_id', 'user_text_head', 'created_at', 'finished_at']))
      return summary
    })
    tool('post_director_note', T['connector.post_director_note'], WRITE, {
      session_id: z.string(),
      question: z.string().describe(P('post_director_note.question')),
      answer: z.string().describe(P('post_director_note.answer')),
      model: z.string().default('').describe('the model that answered, as the chat shows it (e.g. GPT-6 Pro)'),
      source: z.string().default('chatgpt').describe('where the conversation is held'),
    }, async (a, cx) => postNote(cx, a))
    tool('start_run', T['connector.start_run'], WRITE, {
      session_id: SESSION_ID,
      text: z.string().describe(P('start_run.text')),
      request_id: REQUEST_ID,
      model: MODEL,
      thinking: z.string().nullable().optional().describe("reasoning effort: off, minimal, low, medium, high, xhigh or max; default: the model's"),
      attachments: z.array(z.string()).nullable().optional().describe(P('start_run.attachments')),
      fresh: z.boolean().default(false).describe('start without earlier conversation history'),
      mentions: z.array(z.record(z.string(), z.unknown())).default([]).describe('file or symbol references supplied with the message'),
      source_turn_id: z.string().nullable().optional().describe('original user turn of this session; its stored envelope supplies the message and limits'),
      separate: z.boolean().default(false).describe(P('start_run.separate')),
      resume_run_id: z.string().nullable().optional().describe(P('start_run.resume_run_id')),
      base_checkpoint_id: z.string().nullable().optional().describe(P('start_run.base_checkpoint_id')),
      constraints: z.record(z.string(), z.unknown()).nullable().optional().describe(P('start_run.constraints')),
    }, async (a, cx) => startRun(cx, a as Rec))
    tool('attach_image', T['connector.attach_image'], WRITE, {
      session_id: SESSION_ID,
      name: z.string().default('image').describe('a label for the image, shown in the thread'),
      data_base64: z.string().describe("the image's bytes, base64 (a data: URL prefix is accepted)"),
    }, async (a, cx) => attachImage(cx, a))
    tool('get_run', T['connector.get_run'], READ, {
      run_id: z.string(),
      view: z.enum(['result', 'events']).default('result').describe(P('get_run.view')),
      cursor: z.string().nullable().optional().describe(P('get_run.cursor')),
      wait_s: z.coerce.number().int().min(0).max(MAX_WAIT_S).default(0).describe(P('get_run.wait_s')),
    }, async (a, cx) => getRun(cx, a))
    tool('cancel_run', T['connector.cancel_run'], DESTRUCTIVE, { run_id: z.string() }, async ({ run_id }, cx) => rec(await cx.call('POST', `/api/runs/${run_id}/cancel`)))
    tool('get_workspace', T['connector.get_workspace'], READ, {
      workspace_id: z.string(),
      include_diff: z.boolean().default(false).describe(P('get_workspace.include_diff')),
      path: z.string().nullable().optional().describe(P('get_workspace.path')),
      cursor: z.string().nullable().optional().describe(P('get_workspace.cursor')),
    }, async (a, cx) => workspace(cx, a))
    tool('read_file', T['connector.read_file'], READ, {
      workspace_id: z.string(),
      path: z.string().default('.').describe(P('read_file.path')),
      // numbers read from a string too: a chat model sends "401" as often as 401, and a refusal there ends its paging
      offset: z.coerce.number().int().min(1).default(1).describe(P('read_file.offset')),
      limit: z.coerce.number().int().min(1).max(2000).default(400).describe('Maximum lines or folder entries. Default: 400; folder pages are capped at 500.'),
    }, async (a, cx) => readFile(cx, a))
    tool('bash', T['connector.bash'], COMMAND, {
      workspace_id: z.string(),
      command: z.string().nullable().optional().describe(P('bash.command')),
      execution_id: z.string().nullable().optional().describe(P('bash.execution_id')),
      cwd: z.string().nullable().optional().describe(P('read_file.path')),
      wait_s: z.coerce.number().int().min(0).max(MAX_WAIT_S).default(30).describe(P('bash.wait_s')),
      timeout_s: z.coerce.number().int().min(1).nullable().optional().describe(P('bash.timeout_s')),
    }, async (a, cx) => bash(cx, a))
    tool('start_interaction', T['connector.start_interaction'], WRITE, {
      session_id: SESSION_ID,
      text: z.string().default('').describe('the original message'),
      participants: z.array(z.object({ model: z.string(), thinking: z.string().nullable().optional() })).min(2).max(MAX_INTERACTION_PARTICIPANTS),
      mode: InteractionTemplateSchema.default('independent'),
      cross_rounds: z.number().int().min(1).max(4).default(1),
      thinking: z.string().nullable().optional(),
      attachments: z.array(z.string()).max(8).default([]),
      mentions: z.array(z.record(z.string(), z.unknown())).default([]),
      max_runs: z.number().int().min(1).max(30).nullable().optional(),
      concurrency: z.number().int().min(1).max(4).nullable().optional(),
      source_turn_id: z.string().nullable().optional().describe('original user turn of the same session; its stored message supplies dispatch input'),
      request_id: REQUEST_ID,
    }, async ({ session_id, mode, cross_rounds, request_id, ...input }, cx) => {
      const sid = await cx.sessionOf(session_id)
      const original = await originalTurn(cx, sid, input.source_turn_id, true)
      if (original) input.source_turn_id = String(original.id)
      const detail = rec(await cx.call('POST', `/api/sessions/${sid}/interactions`, {
        body: { ...input, workspace_policy: 'isolated', plan: { template: mode, cross_rounds }, client_request_id: request_id },
      }))
      return { ...detail, interaction_id: detail.id }
    })
    tool('schedule', T['connector.schedule'], WRITE, {
      interaction_id: z.string().describe(P('schedule.interaction_id')),
      title: z.string().max(MAX_DIRECTED_TITLE).optional().describe(P('schedule.title')),
      nodes: z.array(ScheduleNodeSchema).min(1).describe(P('schedule.nodes')),
      then: InteractionThenSchema.default('stop').describe(P('schedule.then')),
      expected_revision: z.number().int().nullable().optional().describe(P('schedule.expected_revision')),
    }, async (a, cx) => schedule(cx, a as never))
    tool('integrate', T['connector.integrate'], WRITE, {
      workspace_id: z.string().describe(P('integrate.workspace_id')),
      checkpoint_ids: z.array(z.string()).min(1).describe(P('integrate.checkpoint_ids')),
      note: z.string().default('integration by the director'),
    }, async (a, cx) => integrate(cx, a))
  }

  // ---- director.v2 ---------------------------------------------------------------------------------------------

  function registerV2(): void {
    const SESSION_ID = z.string().nullable().optional().describe(PS(native ? 'common.session_id_native' : 'common.session_id'))
    const REQUEST_ID = z.string().min(8).max(100).nullable().optional().describe(PS('common.request_id'))
    const MODEL = z.string().nullable().optional().describe(PS('common.model'))
    const THINKING = z.string().nullable().optional().describe(PS('common.thinking'))
    const ATTACHMENTS = z.array(z.string()).nullable().optional().describe(PS('common.attachments'))
    const MENTIONS = z.array(z.record(z.string(), z.unknown())).default([]).describe(PS('common.mentions'))
    const SOURCE_TURN = z.string().nullable().optional().describe(PS('common.source_turn_id'))
    const CITES = z.array(CitationSchema).max(MAX_CITATIONS).nullable().optional().describe(PS('common.cites'))
    const RECEIVE = ReceiveRunIdsSchema.nullable().optional().describe(PS('common.receive_run_ids'))
    const RUN_ID = z.string().describe(PS('run_id'))

    if (!native) tool('current_session', TS('current_session'), READ, {}, async (_a, cx) => currentSession(cx))
    tool('list_models', TS('list_models'), READ, {}, async (_a, cx) => listModels(cx))
    if (!native) tool('list_projects', TS('list_projects'), READ, {}, async (_a, cx) => ({ projects: list(await cx.call('GET', '/api/projects')).map(p => v8 ? { ...projectSummary(p), target: rec(p).target, remote: rec(p).remote, ...(v10 && rec(rec(p).import_report).worktree ? { worktree: rec(rec(p).import_report).worktree } : {}) } : projectSummary(p)) }))
    if (!native && !v6) tool('open_project', TS('open_project'), WRITE, {
      path: z.string().describe(PS('open_project.path')),
      name: z.string().nullable().optional().describe(PS('open_project.name')),
      instructions: z.string().nullable().optional().describe(PS('open_project.instructions')),
      reuse: z.boolean().default(true).describe(PS('open_project.reuse')),
      mode: z.enum(['direct', 'snapshot', 'attached']).default('direct').describe(PS('open_project.mode')),
      request_id: REQUEST_ID,
    }, async (a, cx) => openProject(cx, a, false))
    // v6: reuse by folder and kind, a folder made on request, the project for tasks without a folder
    if (!native && v6) tool('open_project', TS('open_project'), WRITE, {
      path: z.string().nullable().optional().describe(PS('open_project.path')),
      name: z.string().nullable().optional().describe(PS('open_project.name')),
      instructions: z.string().nullable().optional().describe(PS('open_project.instructions')),
      reuse: z.boolean().default(true).describe(PS('open_project.reuse')),
      mode: z.enum(['direct', 'snapshot', 'attached']).default('direct').describe(PS('open_project.mode')),
      create_directory: z.boolean().default(false).describe(PS('open_project.create_directory')),
      no_folder: z.boolean().default(false).describe(PS('open_project.no_folder')),
      ...(v8 ? { target_id: z.string().min(1).nullable().optional().describe(T['connector_parameter.v8.target_id']), remote_state_path: z.string().nullable().optional().describe(T['connector_parameter.v8.remote_state_path']) } : {}),
      ...(v10 ? { worktree: z.object({
        branch: z.string().min(1).max(200).describe(T['connector_parameter.v10.worktree.branch']),
        base: z.string().min(1).max(200).nullable().optional().describe(T['connector_parameter.v10.worktree.base']),
        folder: z.string().nullable().optional().describe(T['connector_parameter.v10.worktree.folder']),
      }).nullable().optional().describe(T['connector_parameter.v10.worktree']) } : {}),
      request_id: REQUEST_ID,
    }, async (a, cx) => {
      const wt = (a as { worktree?: WorktreeArgs | null }).worktree
      if (wt) return openWorktreeProject(cx, a as Parameters<typeof openProjectV8>[1], wt)
      return v8 ? openProjectV8(cx, a as Parameters<typeof openProjectV8>[1]) : openProjectV6(cx, a)
    })
    if (!native && v8) {
      tool('list_ssh_targets', T['connector.v8.list_ssh_targets'], READ, {}, async (_a, cx) => ({ targets: await cx.call('GET', '/api/ssh/targets') }))
      // v9: a host saved and connected on the person's yes in the app; the same call again waits on the same question
      if (v9) tool('connect_ssh', T['connector.v9.connect_ssh'], WRITE, {
        destination: z.string().min(1).nullable().optional().describe(T['connector_parameter.v9.destination']),
        port: z.number().int().min(1).max(65535).nullable().optional().describe(T['connector_parameter.v9.port']),
        identity_file: z.string().min(1).nullable().optional().describe(T['connector_parameter.v9.identity_file']),
        name: z.string().min(1).max(200).nullable().optional().describe(T['connector_parameter.v9.name']),
        target_id: z.string().min(1).nullable().optional().describe(T['connector_parameter.v9.target_id']),
        wait_s: z.number().min(0).max(110).default(50).describe(T['connector_parameter.v9.wait_s']),
      }, async (a, cx) => rec(await cx.call('POST', '/api/ssh/asks', { body: a })))
      tool('ssh_directories', v9 ? T['connector.v9.ssh_directories'] : T['connector.v8.ssh_directories'], READ, {
        target_id: z.string().min(1).describe(T['connector_parameter.v8.target_id']), path: z.string().default('/').describe(v9 ? T['connector_parameter.v9.ssh_directories.path'] : PS('open_project.path')),
      }, async (a, cx) => rec(await cx.call('GET', `/api/ssh/targets/${encodeURIComponent(a.target_id)}/dirs`, { params: { path: a.path } })))
      tool('forward_port', T['connector.v8.forward_port'], WRITE, {
        session_id: SESSION_ID, remote_port: z.number().int().min(1).max(65535).describe(T['connector_parameter.v8.remote_port']),
      }, async (a, cx) => {
        const session = rec(await cx.call('GET', `/api/sessions/${await cx.sessionOf(a.session_id)}`))
        const ws = rec(session.workspace), target = rec(ws.target)
        if (target.kind !== 'ssh' || typeof target.target_id !== 'string') throw new ToolError('This session does not have an SSH workspace.')
        return rec(await cx.call('POST', `/api/ssh/targets/${encodeURIComponent(target.target_id)}/forwards`, { body: { workspace_id: ws.id, remote_port: a.remote_port, remote_host: '127.0.0.1' } }))
      })
    }
    tool('set_project_config', TS('set_project_config'), WRITE, {
      project_id: z.string().describe(PS('set_project_config.project_id')),
      instructions: z.string().nullable().optional().describe(PS('set_project_config.instructions')),
      checks: z.array(z.record(z.string(), z.unknown())).nullable().optional().describe(PS('set_project_config.checks')),
      protected_paths: z.array(z.string()).nullable().optional().describe(PS('set_project_config.protected_paths')),
      default_model: z.string().nullable().optional().describe(PS('set_project_config.default_model')),
    }, async (a, cx) => setProjectConfig(cx, a))
    tool('create_session', TS('create_session'), WRITE, {
      project_id: z.string().nullable().optional().describe(PS('create_session.project_id')),
      title: z.string().default('New task').describe(PS('create_session.title')),
      model: MODEL,
      request_id: REQUEST_ID,
      ...(v6 ? {
        task_session_id: z.string().nullable().optional().describe(PS('create_session.task_session_id')),
        roots: z.array(z.object({ path: z.string().min(1), access: z.enum(['read', 'write']) })).nullable().optional().describe(PS('create_session.roots')),
      } : {}),
    }, async (a, cx) => createSession(cx, a as Parameters<typeof createSession>[1], false))
    tool('get_session', TS('get_session'), READ, { session_id: SESSION_ID }, async ({ session_id }, cx) => {
      const sid = await cx.sessionOf(session_id)
      const read = await cx.call('GET', `/api/sessions/${sid}`)
      const summary = v6 ? sessionSummaryV6(read) : sessionSummary(read)
      if (v8) { const ws = rec(rec(read).workspace); summary.target = ws.target; summary.remote = ws.remote }
      const tree = rec(await cx.call('GET', `/api/sessions/${sid}/runs/tree`))
      summary.runs = list(tree.runs).map((r) => {
        const row = pick(r, ['id', 'parent_run_id', 'resumes_run_id', 'spawned_by', 'label', 'model', 'status', 'live', 'error', 'workspace_id', 'interaction_id', 'relay_id', 'user_text_head', 'created_at', 'finished_at'])
        row.collab = collabOf(rec(r).collab)
        return row
      })
      summary.collaboration = await collaborationSummary(cx, sid)
      return summary
    })
    tool('get_collaboration', TS('get_collaboration'), READ, {
      session_id: SESSION_ID.describe(PS('get_collaboration.session_id')),
      run_id: z.string().nullable().optional().describe(PS('get_collaboration.run_id')),
      participant_id: z.string().nullable().optional().describe(PS('get_collaboration.participant_id')),
      cursor: z.string().nullable().optional().describe(PS('get_collaboration.cursor')),
      limit: z.coerce.number().int().min(1).max(COLLAB_PAGE_MAX).default(COLLAB_PAGE).describe(PS('get_collaboration.limit')),
    }, async (a, cx) => getCollaboration(cx, a))
    if (!native) tool('post_director_note', TS('post_director_note'), WRITE, {
      session_id: z.string().describe(PS('post_director_note.session_id')),
      question: z.string().describe(PS('post_director_note.question')),
      answer: z.string().describe(PS('post_director_note.answer')),
      model: z.string().default('').describe(PS('post_director_note.model')),
      source: z.string().default('chatgpt').describe(PS('post_director_note.source')),
    }, async (a, cx) => postNote(cx, a))
    tool('start_run', TS('start_run'), WRITE, {
      session_id: SESSION_ID,
      text: z.string().nullable().optional().describe(PS('start_run.text')),
      source_turn_id: SOURCE_TURN,
      request_id: REQUEST_ID,
      model: MODEL,
      thinking: THINKING,
      attachments: ATTACHMENTS,
      fresh: z.boolean().default(false).describe(PS('start_run.fresh')),
      mentions: MENTIONS,
      separate: z.boolean().default(false).describe(PS('start_run.separate')),
      resume_run_id: z.string().nullable().optional().describe(PS('start_run.resume_run_id')),
      expected_head_run_id: z.string().nullable().optional().describe(PS('start_run.expected_head_run_id')),
      base_checkpoint_id: z.string().nullable().optional().describe(PS('start_run.base_checkpoint_id')),
      constraints: z.record(z.string(), z.unknown()).nullable().optional().describe(PS('start_run.constraints')),
      cites: CITES,
      receive_run_ids: RECEIVE,
    }, async (a, cx) => startRun(cx, a as Rec))
    tool('start_relay', TS('start_relay'), WRITE, {
      session_id: SESSION_ID,
      text: z.string().nullable().optional().describe(PS('start_relay.text')),
      source_turn_id: SOURCE_TURN,
      agents: z.array(z.object({ model: z.string().min(1) })).min(2).max(MAX_RELAY_PARTICIPANTS).describe(PS('start_relay.agents')),
      rounds: z.coerce.number().int().min(1).max(MAX_RELAY_ROUNDS).default(1).describe(PS('start_relay.rounds')),
      thinking: THINKING,
      attachments: ATTACHMENTS,
      mentions: MENTIONS,
      fresh: z.boolean().default(false).describe(PS('start_relay.fresh')),
      resume_run_id: z.string().nullable().optional().describe(PS('start_relay.resume_run_id')),
      request_id: REQUEST_ID,
      cites: CITES,
      receive_run_ids: RECEIVE,
    }, async (a, cx) => startRelay(cx, a as Rec))
    if (!native) tool('attach_image', TS('attach_image'), WRITE, {
      session_id: SESSION_ID,
      name: z.string().default('image').describe(PS('attach_image.name')),
      data_base64: z.string().describe(PS('attach_image.data_base64')),
    }, async (a, cx) => attachImage(cx, a))
    tool('get_run', TS(native ? 'get_run_native' : 'get_run'), READ, {
      run_id: RUN_ID,
      view: z.enum(['result', 'events']).default('result').describe(PS('get_run.view')),
      cursor: z.string().nullable().optional().describe(PS('get_run.cursor')),
      // a native director's turn never waits: the parameter is not on its list at all
      ...(native ? {} : { wait_s: z.coerce.number().int().min(0).max(MAX_WAIT_S).default(0).describe(PS('get_run.wait_s')) }),
    }, async (a, cx) => getRun(cx, a as never))
    tool('cancel_run', TS('cancel_run'), DESTRUCTIVE, { run_id: RUN_ID }, async ({ run_id }, cx) => rec(await cx.call('POST', `/api/runs/${run_id}/cancel`)))
    if (v3) tool('steer_run', TS('steer_run'), WRITE, {
      run_id: RUN_ID, text: z.string().min(1).max(20_000).describe(PS('steer_run.text')), request_id: REQUEST_ID,
    }, async ({ run_id, text, request_id }, cx) => rec(await cx.call('POST', `/api/runs/${run_id}/steer`, { body: { text, client_request_id: request_id ?? newId('steer') } })))
    tool('get_workspace', TS('get_workspace'), READ, {
      workspace_id: z.string().describe(PS('get_workspace.workspace_id')),
      include_diff: z.boolean().default(false).describe(PS('get_workspace.include_diff')),
      path: z.string().nullable().optional().describe(PS('get_workspace.path')),
      cursor: z.string().nullable().optional().describe(PS('get_workspace.cursor')),
    }, async (a, cx) => workspace(cx, a))
    tool('read_file', v11 && !native ? T['connector.v11.read_file'] : TS('read_file'), READ, {
      workspace_id: z.string().describe(PS('get_workspace.workspace_id')),
      path: z.string().default('.').describe(PS('read_file.path')),
      offset: z.coerce.number().int().min(1).default(1).describe(PS('read_file.offset')),
      limit: z.coerce.number().int().min(1).max(2000).default(400).describe(PS('read_file.limit')),
    }, async (a, cx) => readFile(cx, a))
    if (!native) tool('bash', TS('bash'), COMMAND, {
      workspace_id: z.string().describe(PS('get_workspace.workspace_id')),
      ...(v6 ? { session_id: z.string().nullable().optional().describe(P6('bash.session_id')) } : {}),
      command: z.string().nullable().optional().describe(PS('bash.command')),
      execution_id: z.string().nullable().optional().describe(PS('bash.execution_id')),
      cwd: z.string().nullable().optional().describe(PS('bash.cwd')),
      wait_s: z.coerce.number().int().min(0).max(MAX_WAIT_S).default(30).describe(PS('bash.wait_s')),
      timeout_s: z.coerce.number().int().min(1).nullable().optional().describe(PS('bash.timeout_s')),
      ...(v6 ? { read_only: z.boolean().default(false).describe(P6('bash.read_only')) } : {}),
    }, async (a, cx) => bash(cx, a as Parameters<typeof bash>[1]))
    tool('start_interaction', TS('start_interaction'), WRITE, {
      session_id: SESSION_ID,
      text: z.string().nullable().optional().describe(PS('start_interaction.text')),
      source_turn_id: SOURCE_TURN,
      participants: z.array(z.object({ model: z.string(), thinking: z.string().nullable().optional(), id: z.string().regex(PARTICIPANT_ID).nullable().optional() })).min(2).max(MAX_INTERACTION_PARTICIPANTS).describe(PS('start_interaction.participants')),
      mode: z.enum(['independent', 'discussion', 'director']).nullable().optional().describe(PS('start_interaction.mode')),
      cross_rounds: z.number().int().min(1).max(4).default(1).describe(PS('start_interaction.cross_rounds')),
      nodes: z.array(ScheduleNodeV2Schema).min(1).max(MAX_SCHEDULE_NODES).nullable().optional().describe(PS('start_interaction.nodes')),
      then: InteractionThenSchema.nullable().optional().describe(PS('start_interaction.then')),
      thinking: THINKING,
      attachments: z.array(z.string()).max(8).default([]).describe(PS('common.attachments')),
      mentions: MENTIONS,
      max_runs: z.number().int().min(1).max(30).nullable().optional().describe(PS('start_interaction.max_runs')),
      concurrency: z.number().int().min(1).max(4).nullable().optional().describe(PS('start_interaction.concurrency')),
      request_id: REQUEST_ID,
      cites: CITES,
    }, async (a, cx) => startInteraction(cx, a as Rec))
    tool('schedule', TS('schedule'), WRITE, {
      interaction_id: z.string().describe(PS('schedule.interaction_id')),
      title: z.string().max(MAX_DIRECTED_TITLE).optional().describe(PS('schedule.title')),
      nodes: z.array(ScheduleNodeV2Schema).min(1).describe(PS('schedule.nodes')),
      then: InteractionThenSchema.default('stop').describe(PS('schedule.then')),
      expected_revision: z.number().int().nullable().optional().describe(PS('schedule.expected_revision')),
    }, async (a, cx) => schedule(cx, a as never))
    tool('integrate', TS('integrate'), WRITE, {
      workspace_id: z.string().describe(PS('integrate.workspace_id')),
      checkpoint_ids: z.array(z.string()).min(1).describe(PS('integrate.checkpoint_ids')),
      note: z.string().default('integration by the director').describe(PS('integrate.note')),
    }, async (a, cx) => integrate(cx, a))
  }

  /** v2 start_relay: the composer's relay (POST …/chat with agents and rounds — the relay table, its turns on the
   *  session's folder, each reading the earlier ones), not a plan of isolated steps. */
  async function startRelay(cx: Cx, a: Rec): Promise<Rec> {
    let text = typeof a.text === 'string' ? a.text : ''
    let attachments = list(a.attachments).map(String)
    let mentions = list(a.mentions).map(rec)
    let thinking = str(a.thinking)
    let fresh = a.fresh === true
    let resumeRunId = str(a.resume_run_id)
    const requestId = str(a.request_id)
    let sid: string
    if (resumeRunId) {
      const owner = String(rec(await cx.call('GET', `/api/runs/${resumeRunId}`)).session_id)
      if (str(a.session_id) && str(a.session_id) !== owner) throw new ToolError(`resume_run_id ${resumeRunId} is not a run of session ${String(a.session_id)}. Nothing was started.`)
      sid = owner
    } else sid = await cx.sessionOf(str(a.session_id))
    const original = await originalTurn(cx, sid, str(a.source_turn_id), false)
    const envelope = original ? rec(original.envelope) : null
    let participantThinking: Rec = {}
    if (envelope) {
      if (text.trim() || attachments.length || mentions.length) throw new ToolError('source_turn_id supplies the message, its attachments and mentions: text, attachments and mentions are not given with it. Nothing was started.')
      const envelopeResume = typeof envelope.resumes_run_id === 'string' ? envelope.resumes_run_id : null
      if (envelopeResume && resumeRunId && envelopeResume !== resumeRunId) throw new ToolError(`the original message (turn ${String(original!.id)}) continues run ${envelopeResume}; this call names run ${resumeRunId}. Nothing was started.`)
      text = String(envelope.text ?? '')
      attachments = list(envelope.attachments).map(String)
      mentions = list(envelope.mentions).map(rec)
      thinking = typeof envelope.thinking === 'string' ? envelope.thinking : thinking
      fresh = envelope.fresh === true
      resumeRunId = envelopeResume ?? resumeRunId
      participantThinking = rec(envelope.participant_thinking)
    }
    if (!text.trim() && !attachments.length) throw new ToolError('text is required unless source_turn_id is given')
    const body: Rec = { text, agents: list(a.agents).map((x) => ({ model: String(rec(x).model) })), rounds: a.rounds ?? 1, fresh, mentions, resumes_run_id: resumeRunId }
    if (envelope?.budget) body.budget = envelope.budget
    if (Object.keys(participantThinking).length) body.participant_thinking = participantThinking
    if (attachments.length) body.attachments = attachments
    if (thinking) body.thinking = thinking
    if (requestId) body.client_request_id = requestId
    if (Array.isArray(a.cites) && a.cites.length) body.cites = a.cites
    if (Array.isArray(a.receive_run_ids) && a.receive_run_ids.length) { body.receive_run_ids = a.receive_run_ids; if (v6) body.receive_across_sessions = true }
    const run = sameRequest(rec(await cx.call('POST', `/api/sessions/${sid}/chat`, { body })), requestId, { session_id: sid, user_text: text })
    if (typeof run.relay_id !== 'string' || !run.relay_id) throw new ToolError(`the harness started run ${String(run.id)} without a relay: a relay needs two or more agents and a harness that runs relays`)
    const out = summaryOf(run)
    try {
      const relay = rec(await cx.call('GET', `/api/relays/${run.relay_id}`))
      out.relay = { ...pick(relay, ['id', 'status', 'rounds', 'round', 'current_step', 'reason']), participants: list(relay.participants).map((p) => pick(p, ['id', 'model', 'label', 'thinking'])) }
    } catch { out.relay = { id: run.relay_id } }
    return out
  }

  /** v2 start_interaction: a template, the director's own plan (mode director: the interaction asks this session's
   *  director in a turn of its own), or the steps given (nodes). */
  async function startInteraction(cx: Cx, a: Rec): Promise<Rec> {
    const sid = await cx.sessionOf(str(a.session_id))
    const mode = str(a.mode)
    const nodes = Array.isArray(a.nodes) && a.nodes.length ? a.nodes : null
    if (mode && nodes) throw new ToolError('mode and nodes cannot be combined: the plan is a mode or the steps given. Nothing was started.')
    if (!nodes && a.then !== null && a.then !== undefined) throw new ToolError('then applies to nodes. Nothing was started.')
    const original = await originalTurn(cx, sid, str(a.source_turn_id), false)
    const text = typeof a.text === 'string' ? a.text : ''
    if (original && (text.trim() || list(a.attachments).length || list(a.mentions).length)) throw new ToolError('source_turn_id supplies the message, its attachments and mentions: text, attachments and mentions are not given with it. Nothing was started.')
    if (!original && !text.trim() && !list(a.attachments).length) throw new ToolError('text is required unless source_turn_id is given')
    const plan = nodes ? { nodes, then: a.then ?? 'stop' } : mode === 'director' ? null : { template: mode ?? 'independent', cross_rounds: a.cross_rounds ?? 1 }
    const body: Rec = {
      text, participants: list(a.participants).map((p) => Object.fromEntries(Object.entries(rec(p)).filter(([, v]) => v !== null && v !== undefined))),
      workspace_policy: 'isolated', plan, mentions: list(a.mentions), attachments: list(a.attachments),
    }
    if (original) body.source_turn_id = String(original.id)
    for (const key of ['thinking', 'max_runs', 'concurrency'] as const) if (a[key] !== null && a[key] !== undefined) body[key] = a[key]
    if (str(a.request_id)) body.client_request_id = a.request_id
    if (Array.isArray(a.cites) && a.cites.length) body.cites = a.cites
    const detail = rec(await cx.call('POST', `/api/sessions/${sid}/interactions`, { body }))
    return { ...detail, interaction_id: detail.id }
  }

  async function collaborationSummary(cx: Cx, sessionId: string): Promise<Rec | null> {
    let graph: Rec
    try { graph = rec(await cx.call('GET', `/api/sessions/${sessionId}/collaboration`)) } catch { return null }
    const edges = list(graph.edges).map(rec)
    const byKind: Record<string, number> = {}
    for (const e of edges) byKind[String(e.kind)] = (byKind[String(e.kind)] ?? 0) + 1
    return {
      revision: graph.revision ?? null, main_participant_id: graph.main_participant_id ?? null,
      participants: list(graph.participants).slice(0, COLLAB_PAGE).map((p) => pick(p, ['id', 'role', 'alias', 'label', 'model', 'state', 'latest_run_id', 'run_count'])),
      participants_total: list(graph.participants).length, groups: list(graph.groups).length, edges: byKind, thread_items: list(graph.thread_items).length,
      read_more_with: 'get_collaboration',
    }
  }

  async function getCollaboration(cx: Cx, a: { session_id?: string | null; run_id?: string | null; participant_id?: string | null; cursor?: string | null; limit: number }): Promise<Rec> {
    const targets = [a.run_id, a.participant_id].filter((v) => typeof v === 'string' && v)
    if (targets.length > 1) throw new ToolError('name one of run_id and participant_id (or neither, for the session)')
    const limit = Math.max(1, Math.min(COLLAB_PAGE_MAX, Math.trunc(a.limit) || COLLAB_PAGE))
    if (a.participant_id) {
      const detail = rec(await cx.call('GET', `/api/participants/${a.participant_id}`, { params: { limit, before: a.cursor ?? undefined } }))
      const participant = rec(detail.participant)
      return boundedValue({
        session_id: participant.session_id ?? detail.session_id ?? null, participant: Object.keys(participant).length ? participant : pick(detail, ['id', 'role', 'alias', 'label', 'model', 'state']),
        conversations: list(detail.conversations), runs: list(detail.runs).map((r) => collabRun(r)), next_cursor: detail.next_before ?? null,
      }) as Rec
    }
    if (a.run_id) {
      const data = rec(await cx.call('GET', `/api/runs/${a.run_id}/collaboration`))
      const start = Math.max(0, Math.trunc(Number(a.cursor ?? 0)) || 0)
      const page = (v: unknown) => list(v).slice(start, start + limit)
      const more = [data.incoming, data.outgoing, data.related_runs].some((v) => list(v).length > start + limit)
      return boundedValue({
        session_id: rec(data.run).session_id ?? null, run: collabRun(data.run), participant: data.participant ?? null, conversation: data.conversation ?? null,
        incoming: page(data.incoming), outgoing: page(data.outgoing), related_runs: page(data.related_runs).map((r) => collabRun(r)), next_cursor: more ? String(start + limit) : null,
      }) as Rec
    }
    const sid = await cx.sessionOf(a.session_id)
    const graph = rec(await cx.call('GET', `/api/sessions/${sid}/collaboration`))
    const start = Math.max(0, Math.trunc(Number(a.cursor ?? 0)) || 0)
    const lists = ['participants', 'conversations', 'groups', 'runs', 'nodes', 'edges', 'thread_items'] as const
    const out: Rec = { session_id: graph.session_id ?? sid, revision: graph.revision ?? null, main_participant_id: graph.main_participant_id ?? null, actors: list(graph.actors), legacy: graph.legacy ?? null }
    let more = false
    for (const key of lists) {
      const items = list(graph[key])
      out[key] = items.slice(start, start + limit).map((x) => (key === 'runs' ? collabRun(x) : x))
      out[`${key}_total`] = items.length
      if (items.length > start + limit) more = true
    }
    out.next_cursor = more ? String(start + limit) : null
    return boundedValue(out) as Rec
  }
}

// ---- summaries ---------------------------------------------------------------------------------------------------

function real(path: string): string {
  const expanded = expandUser(path)
  try { return realpathSync(expanded) } catch { return expanded.replace(/\/+$/, '') }
}

export function projectSummary(p: unknown): Rec {
  const project = rec(p)
  const config = rec(project.config)
  return {
    id: project.id ?? null, name: project.name ?? null, kind: project.kind ?? 'snapshot', source_path: project.source_path ?? null, base_commit: project.base_commit ?? null,
    default_model: project.default_model ?? null, instructions: config.instructions ?? null,
    checks: list(config.checks).map((c) => rec(c).id ?? null), created_at: project.created_at ?? null,
    sessions: list(project.sessions).map((s) => pick(s, ['id', 'title', 'model', 'workspace_id', 'status', 'created_at'])),
  }
}

export function sessionSummary(s: unknown): Rec {
  const session = rec(s)
  const ws = rec(session.workspace)
  return {
    id: session.id ?? null, project_id: session.project_id ?? null, title: session.title ?? null, model: session.model ?? null,
    workspace_id: session.workspace_id ?? null, workspace_path: ws.path ?? null, grants: session.grants ?? null,
    runs: list(session.runs).map(runSummary),
    director_notes: list(session.director_notes).map((n) => ({ id: rec(n).id ?? null, model: rec(n).model ?? null, created_at: rec(n).created_at ?? null, question_head: head(rec(n).question) })),
    active_run: session.active_run ?? null, active_children: list(session.active_children), pending_approvals: list(session.pending_approvals),
  }
}

export function runSummary(r: unknown): Rec {
  const run = rec(r)
  const usage = rec(run.usage)
  const receipt = rec(run.receipt)
  const mechanical = rec(receipt.mechanical)
  const status = run.status ?? null
  return {
    id: run.id ?? null, session_id: run.session_id ?? null, workspace_id: run.workspace_id ?? null, parent_run_id: run.parent_run_id ?? null,
    resumes_run_id: run.resumes_run_id ?? null, label: run.label ?? null, model: run.model || null, status, finished: !active(status),
    checks: mechanical.checks ?? null, error: run.error ?? null, created_at: run.created_at ?? null, finished_at: run.finished_at ?? null,
    usage: Object.fromEntries(USAGE_KEYS.filter((k) => Number.isInteger(usage[k])).map((k) => [k, usage[k]])),
    receipt: Object.keys(receipt).length ? receipt : null,
  }
}

/** A run as v2 answers it: v1's summary with where it belongs — its group, its participant, origin and placement. */
export function runSummaryV2(r: unknown): Rec {
  const run = rec(r)
  return { ...runSummary(run), interaction_id: run.interaction_id ?? null, interaction_node: run.interaction_node ?? null, relay_id: run.relay_id ?? null, collab: collabOf(run.collab) }
}

/** A run as v6 answers it: v2's summary with what a queued run waits for (the harness's `waiting`: the workspace
 *  lock, its blocking owner, kind and run, since when and the position), null when it waits for nothing. */
export function runSummaryV6(r: unknown): Rec {
  const run = rec(r)
  return { ...runSummaryV2(run), waiting: run.waiting && typeof run.waiting === 'object' ? run.waiting : null }
}

/** A session as v6 answers it: v1's summary with its task (task_root_id, task_sessions) and its roots. */
export function sessionSummaryV6(s: unknown): Rec {
  const session = rec(s)
  return {
    ...sessionSummary(session), task_root_id: session.task_root_id ?? null, roots: list(session.roots).map((r) => pick(r, ['path', 'access'])),
    task_sessions: list(session.task_sessions).map((t) => pick(t, ['id', 'project_id', 'title', 'status', 'last_activity_at'])),
  }
}

/** What a v6 bash answer carries beside v1–v5's, each when the harness gives it: the access asked for and had, why,
 *  the restrictions held, the whole output's size and whether it was all kept, why the command stopped, and what a
 *  command queued behind another writer of the folder waits for. */
export const BASH_V6_KEYS = ['requested_access', 'effective_access', 'access_reasons', 'restrictions', 'stdout_total_bytes', 'stderr_total_bytes', 'output_complete', 'output_cap_bytes', 'stop_reason', 'stdout_bytes', 'stderr_bytes', 'code', 'reason', 'waiting'] as const

function collabOf(c: unknown): Rec | null {
  const collab = rec(c)
  if (!Object.keys(collab).length) return null
  return pick(collab, ['participant_id', 'participant_role', 'conversation_id', 'conversation_seq', 'origin', 'placement', 'basis'])
}

function collabRun(r: unknown): Rec {
  const run = rec(r)
  const row = pick(run, ['id', 'participant_id', 'conversation_id', 'status', 'label', 'model', 'created_at', 'finished_at'])
  for (const key of ['origin', 'placement', 'user_text_head', 'final_text_head', 'interaction_id', 'relay_id']) if (run[key] !== undefined) row[key] = run[key]
  if (run.collab !== undefined) row.collab = collabOf(run.collab)
  return row
}

/** Every string of an answer cut to TEXT_CAP: a collaboration record carries text heads, never a whole answer. */
function boundedValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return cap(value)
  if (depth > 8) return null
  if (Array.isArray(value)) return value.map((v) => boundedValue(v, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Rec).map(([k, v]) => [k, boundedValue(v, depth + 1)]))
  return value
}

function head(text: unknown): string {
  const lines = String(text ?? '').trim().split(/\r?\n/)
  return lines[0] ? lines[0].slice(0, 120) : ''
}

function finalText(entries: unknown[]): string {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = rec(entries[i])
    if (entry.kind === 'agent' && typeof entry.text === 'string' && entry.text.trim()) return entry.text
  }
  return ''
}

export function boundedEntry(entry: Rec): Rec {
  // a surface the run showed the person: its words (title, fallback), never its spec or document
  if (entry.kind === 'ui') {
    const surface = rec(entry.surface)
    const spec = rec(surface.spec)
    return { kind: 'ui', run_id: surface.run_id ?? null, surface_id: surface.surface_id ?? null, revision: surface.revision ?? null,
      text: cap(uiSurfaceText({ surface_id: String(surface.surface_id ?? ''), revision: Number(surface.revision ?? 0), spec: { title: String(spec.title ?? ''), fallback: String(spec.fallback ?? ''), kind: String(spec.kind ?? '') } })) }
  }
  // a form the run asked the person to fill: its words, status and answer as text, never its elements
  if (entry.kind === 'input') {
    const input = rec(entry.input)
    const request = rec(input.request)
    return { kind: 'input', run_id: input.run_id ?? null, input_id: input.id ?? null, status: input.status ?? null,
      text: cap(uiInputText({ id: String(input.id ?? ''), status: String(input.status ?? ''), closed_reason: typeof input.closed_reason === 'string' ? input.closed_reason : null,
        values: input.values && typeof input.values === 'object' && !Array.isArray(input.values) ? (input.values as Record<string, unknown>) : null,
        request: { title: String(request.title ?? ''), ...(typeof request.message === 'string' ? { message: request.message } : {}) } })) }
  }
  const out: Rec = { ...entry }
  if (entry.tool === 'present_ui' && out.args && typeof out.args === 'object') out.args = pick(out.args, ['surface_id', 'title', 'kind', 'scope', 'expected_revision'])
  if (entry.tool === 'read_ui' && out.args && typeof out.args === 'object') out.args = pick(out.args, ['surface_id', 'scope'])
  // a form request and a task's data: their words, never the form's elements or the data's JSON
  if (entry.tool === 'request_input' && out.args && typeof out.args === 'object') out.args = pick(out.args, ['title', 'message'])
  if (entry.tool === 'return_ui_result' && out.args && typeof out.args === 'object') out.args = pick(out.args, ['ok', 'message'])
  for (const key of ['text', 'args']) if (typeof out[key] === 'string') out[key] = cap(out[key] as string)
  if (out.args && typeof out.args === 'object' && !Array.isArray(out.args)) {
    out.args = Object.fromEntries(Object.entries(out.args as Rec).map(([k, v]) => [k, typeof v === 'string' ? cap(v) : v]))
  }
  return out
}

function cap(text: string): string {
  return text.length <= TEXT_CAP ? text : `${text.slice(0, TEXT_CAP)}… [${text.length - TEXT_CAP} more chars]`
}
