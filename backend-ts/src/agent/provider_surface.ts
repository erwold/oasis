/** The provider frame of a conversation: the tool list a provider actually receives (the function definitions in their
 *  order, with descriptions and schemas, and the provider-run tools with their settings) and the static instructions,
 *  byte for byte, as the conversation's first real request carried them. Recorded once, before that request goes
 *  out, in the conversation's `tool_snapshot_json` under its own `provider_frame` key (the other keys untouched);
 *  every later request of the conversation — main, continuation, compaction summary, a later run — carries exactly
 *  it. A frame whose provider-run tool can no longer go (the route does not offer it, the order or the session no
 *  longer lets the network through: a search the provider runs never passes the harness's gate) refuses the request
 *  before it is made; it is never swapped for another list nor sent beyond the grant.
 *
 *  A newly introduced/different participant (a recorded group_start/participant_change fork) establishes its own
 *  provider frame on its first request. Other conversations without a frame take one from their history, never
 *  silently from today's grant or route:
 *  the run's ancestors along `resumes_run_id` (as the runner reloads history: past runs that never made a request),
 *  then the run its conversation forked from, then its conversation's other runs. The first ancestor whose
 *  conversation holds a frame hands that frame on (a fork with history inherits it); the first that made a model
 *  request (a request on record, or a response in its stored history) is the evidence, rebuilt only from what its
 *  record proves — the instructions by its manifest's `instructions_sha256` (the text this build has, or the text its
 *  stored history carried), the tools by the function-only fingerprint its last request recorded (the harness's
 *  `web_search` in, or out in favour of the provider's search at the baseline's 5 searches). What cannot be proven
 *  is refused; only a run with no such ancestor at all starts a frame of its own. A stored frame is checked (version,
 *  shape, fingerprints) before it is used; a damaged one is refused, never rebuilt. */

import { searchEngineForRun } from '../search/settings.ts'
import { createHash } from 'node:crypto'
import type { Conn } from '../db/database.ts'
import type { ToolSnapshot } from '../db/collab_repo.ts'
import type { BuiltinTool, Model, ModelRequestParameters, ToolDefinition } from '../llm/model.ts'
import { canonicalJson, toolSchemaFingerprint } from '../llm/usage.ts'
import { isChatGptWeb } from '../llm/chatgpt_web.ts'
import { networkGranted } from '../policy/permissions.ts'
import { refreshSession, type AgentDeps } from './deps.ts'

export const PROVIDER_FRAME_VERSION = 1
/** The provider search's per-response limit every baseline build sent (agent.ts BUILTIN_SEARCHES_PER_RESPONSE). */
export const LEGACY_BUILTIN_MAX_USES = 5

export interface ProviderFrame {
  version: number
  /** sha256 over the canonical JSON of {version, instructions, function_tools (in order), builtin_tools (in order)} */
  sha256: string
  instructions: string
  instructions_sha256: string
  function_tools: ToolDefinition[]
  builtin_tools: BuiltinTool[]
  /** what the frame was taken from: this conversation's first request, an earlier record that proves it, or the
   *  frame of the conversation this one forked from with its history */
  basis: 'recorded' | 'legacy-proven' | 'inherited'
  recorded: { run_id: string | null; model: string; system: string | null; route: string | null; profile_builtin_tools: string[]; at: string }
  /** basis inherited: the conversation and run the frame came from; legacy-proven: the run whose record proved it */
  source?: { conversation_id: string | null; run_id: string } | null
}

/** The conversation snapshot as stored, with this module's own key beside the rest. */
export type ToolSnapshotWithFrame = ToolSnapshot & { provider_frame?: ProviderFrame }

export interface FrameRequest { instructions: string; params: ModelRequestParameters; offered: ToolDefinition[] }

/** A request refused because the conversation's frame cannot be carried (or proven) now. */
export class ProviderFrameRefused extends Error {
  readonly code = 'provider_frame_refused'
  constructor(readonly reason: string, readonly conversation_id: string | null) {
    super(`provider frame refused: ${reason}${conversation_id ? ` (conversation ${conversation_id})` : ''}. The conversation's tools and instructions stay as its first request had them; continuing needs that frame allowed again, or a new conversation.`)
    this.name = 'ProviderFrameRefused'
  }
}

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export function frameFingerprint(f: Pick<ProviderFrame, 'instructions' | 'function_tools' | 'builtin_tools'>): string {
  return sha(canonicalJson({
    version: PROVIDER_FRAME_VERSION, instructions: f.instructions,
    function_tools: f.function_tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters_json_schema })),
    builtin_tools: f.builtin_tools.map((b) => ({ ...b })),
  }))
}

export function makeFrame(req: Pick<FrameRequest, 'instructions' | 'params'>, model: Model, runId: string | null, basis: ProviderFrame['basis'] = 'recorded'): ProviderFrame {
  const function_tools = req.params.function_tools.map((t) => structuredClone(t))
  const builtin_tools = (req.params.builtin_tools ?? []).map((b) => ({ ...b }))
  return {
    version: PROVIDER_FRAME_VERSION, sha256: frameFingerprint({ instructions: req.instructions, function_tools, builtin_tools }),
    instructions: req.instructions, instructions_sha256: sha(req.instructions), function_tools, builtin_tools, basis,
    recorded: { run_id: runId, model: model.model_name, system: model.system, route: model.route ?? null, profile_builtin_tools: [...(model.profile.builtin_tools ?? [])], at: new Date().toISOString() },
  }
}

// -- where a frame is kept ----------------------------------------------------------------------------------------

export function conversationOfRun(conn: Conn, runId: string): string | null {
  const row = conn.get('SELECT conversation_id FROM run_collab WHERE run_id=?', [runId])
  return row && typeof row.conversation_id === 'string' ? row.conversation_id : null
}

function snapshotJson(conn: Conn, conversationId: string): Record<string, unknown> | null | undefined {
  const row = conn.get('SELECT tool_snapshot_json FROM conversations WHERE id=?', [conversationId])
  if (!row) return undefined
  if (row.tool_snapshot_json === null || row.tool_snapshot_json === undefined) return null
  try {
    const v = JSON.parse(String(row.tool_snapshot_json))
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch { return null }
}

/** What is wrong with a stored frame (null: it is whole and its fingerprints hold). */
export function frameProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not an object'
  const f = raw as Record<string, unknown>
  if (f.version !== PROVIDER_FRAME_VERSION) return `version ${String(f.version)} is not ${PROVIDER_FRAME_VERSION}`
  if (typeof f.instructions !== 'string' || typeof f.instructions_sha256 !== 'string' || typeof f.sha256 !== 'string') return 'instructions or fingerprints missing'
  if (!['recorded', 'legacy-proven', 'inherited'].includes(String(f.basis))) return `unknown basis ${String(f.basis)}`
  if (!f.recorded || typeof f.recorded !== 'object') return 'no record of where it was taken'
  if (!Array.isArray(f.function_tools) || !f.function_tools.every((t) => t && typeof t === 'object' && typeof (t as ToolDefinition).name === 'string'
    && typeof (t as ToolDefinition).description === 'string' && !!(t as ToolDefinition).parameters_json_schema && typeof (t as ToolDefinition).parameters_json_schema === 'object')) return 'function tools malformed'
  if (!Array.isArray(f.builtin_tools) || !f.builtin_tools.every((b) => b && typeof b === 'object' && (b as BuiltinTool).kind === 'web_search'
    && Number.isInteger((b as BuiltinTool).max_uses) && (b as BuiltinTool).max_uses > 0)) return 'provider tools malformed'
  if (sha(f.instructions) !== f.instructions_sha256) return 'instructions do not match their fingerprint'
  if (frameFingerprint(f as unknown as ProviderFrame) !== f.sha256) return 'tools and instructions do not match the frame fingerprint'
  return null
}

/** The conversation's frame as the database holds it now (never a copy a run loaded earlier); null when it has
 *  none; a refusal when the stored one is damaged (it is neither used nor replaced). */
export function readProviderFrame(conn: Conn, conversationId: string): ProviderFrame | null {
  const snap = snapshotJson(conn, conversationId)
  if (!snap || !('provider_frame' in snap) || snap.provider_frame === undefined || snap.provider_frame === null) return null
  const problem = frameProblem(snap.provider_frame)
  if (problem !== null) throw new ProviderFrameRefused(`the stored provider frame is damaged (${problem})`, conversationId)
  return snap.provider_frame as ProviderFrame
}

/** Record the frame if the conversation has none yet, in one transaction that re-reads the stored JSON and adds only
 *  `provider_frame` (every other key as it is then). The first frame stands: a frame already there is returned.
 *  Null when the conversation has no stored snapshot to add to (nothing is written then). */
export function recordProviderFrame(conn: Conn, conversationId: string, frame: ProviderFrame): ProviderFrame | null {
  return conn.transaction(() => {
    const snap = snapshotJson(conn, conversationId)
    if (!snap) return null
    const existing = snap.provider_frame
    if (existing !== undefined && existing !== null) {
      const problem = frameProblem(existing)
      if (problem !== null) throw new ProviderFrameRefused(`the stored provider frame is damaged (${problem})`, conversationId)
      return existing as ProviderFrame
    }
    conn.run('UPDATE conversations SET tool_snapshot_json=? WHERE id=?', [JSON.stringify({ ...snap, provider_frame: frame }), conversationId])
    return frame
  })
}

// -- where a frame without a record comes from ---------------------------------------------------------------------

interface RunFacts { id: string; model: string | null; resumes_run_id: string | null; manifest: Record<string, unknown> | null; history: string | null; requests: number; last_tool_sha: string | null; conversation_id: string | null }

function factsOf(conn: Conn, runId: string): RunFacts | null {
  const row = conn.get(
    'SELECT r.id AS id, r.model AS model, r.resumes_run_id AS resumes_run_id, r.manifest_json AS manifest_json, r.history_json AS history_json,'
    + ' (SELECT count(*) FROM model_requests m WHERE m.run_id = r.id) AS requests,'
    + ' (SELECT m.tool_schema_sha256 FROM model_requests m WHERE m.run_id = r.id ORDER BY m.seq DESC LIMIT 1) AS tool_sha,'
    + ' (SELECT rc.conversation_id FROM run_collab rc WHERE rc.run_id = r.id) AS conversation_id FROM runs r WHERE r.id=?', [runId])
  if (!row) return null
  let manifest: Record<string, unknown> | null = null
  try {
    const m = JSON.parse(String(row.manifest_json ?? 'null'))
    if (m && typeof m === 'object' && !Array.isArray(m)) manifest = m as Record<string, unknown>
  } catch { manifest = null }
  return {
    id: String(row.id), model: typeof row.model === 'string' ? row.model : null, resumes_run_id: typeof row.resumes_run_id === 'string' ? row.resumes_run_id : null, manifest,
    history: typeof row.history_json === 'string' ? row.history_json : null, requests: Number(row.requests ?? 0),
    last_tool_sha: typeof row.tool_sha === 'string' ? row.tool_sha : null, conversation_id: typeof row.conversation_id === 'string' ? row.conversation_id : null,
  }
}

const RESPONSE_MARK = '"kind":"response"'
/** Whether the run made a model request: one on record, or a response in its stored history. */
const madeRequest = (r: RunFacts): boolean => !isChatGptWeb(r.model) && (r.requests > 0 || (r.history ?? '').includes(RESPONSE_MARK))
// A ChatGPT web exchange contains responses but no harness tool declarations. Its API successor looks through it
// for any earlier API frame; pure web history establishes no prior harness tool list to restore.

/** The instructions the last request of a stored history carried (the provider reads the last request's). */
function historyInstructions(history: string | null): string | null {
  if (!history) return null
  try {
    const messages = JSON.parse(history) as { kind?: string; instructions?: unknown }[]
    if (!Array.isArray(messages)) return null
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m && m.kind === 'request' && typeof m.instructions === 'string' && m.instructions) return m.instructions
    }
  } catch { return null }
  return null
}

export type FrameOrigin =
  | { kind: 'fresh' }
  | { kind: 'inherit'; frame: ProviderFrame; conversation_id: string; run_id: string }
  | { kind: 'evidence'; run: RunFacts }

/** Where a conversation without a frame takes one from (see the module's note). */
export function frameOrigin(conn: Conn, runId: string, conversationId: string | null): FrameOrigin {
  const seen = new Set<string>([runId])
  const starts: (string | null)[] = [factsOf(conn, runId)?.resumes_run_id ?? null]
  if (conversationId !== null) {
    const conv = conn.get('SELECT forked_from_run_id FROM conversations WHERE id=?', [conversationId])
    starts.push(conv && typeof conv.forked_from_run_id === 'string' ? conv.forked_from_run_id : null)
  }
  for (const start of starts) {
    let at = start
    while (at !== null && !seen.has(at)) {
      seen.add(at)
      const r = factsOf(conn, at)
      if (r === null) break
      if (r.conversation_id !== null && r.conversation_id !== conversationId) {
        const frame = readProviderFrame(conn, r.conversation_id)
        if (frame !== null) return { kind: 'inherit', frame, conversation_id: r.conversation_id, run_id: r.id }
      }
      if (madeRequest(r)) return { kind: 'evidence', run: r }
      at = r.resumes_run_id
    }
  }
  // the conversation's own earlier runs (one continued without naming its predecessor)
  if (conversationId !== null) {
    const rows = conn.all('SELECT rc.run_id AS id FROM run_collab rc JOIN runs r ON r.id = rc.run_id WHERE rc.conversation_id=? AND rc.run_id<>? ORDER BY r.created_at DESC, r.rowid DESC', [conversationId, runId])
    for (const row of rows) {
      const r = factsOf(conn, String(row.id))
      if (r !== null && madeRequest(r)) return { kind: 'evidence', run: r }
    }
  }
  return { kind: 'fresh' }
}

/** The frame an earlier run's record proves, or the reason it proves none. */
export function legacyFrame(rec: RunFacts, req: FrameRequest, model: Model, runId: string): ProviderFrame | string {
  // the instructions: the text this build has or the text the run's history carried, whichever the manifest's
  // fingerprint names; with no fingerprint on record, only the text its history carried
  const recorded = typeof rec.manifest?.instructions_sha256 === 'string' ? rec.manifest.instructions_sha256 as string : null
  const stored = historyInstructions(rec.history)
  let instructions: string | null = null
  if (recorded !== null) instructions = [req.instructions, stored].find((t): t is string => t !== null && sha(t) === recorded) ?? null
  else instructions = stored
  if (instructions === null) {
    return recorded === null
      ? `run ${rec.id} records neither an instructions fingerprint nor the instructions its requests carried`
      : `run ${rec.id} ran on instructions (sha256 ${recorded.slice(0, 12)}) neither this build nor its stored history has`
  }
  if (rec.requests === 0) return `run ${rec.id} has responses in its history but no request on record, so the tools it was sent are unknown`
  if (rec.last_tool_sha === null) return `run ${rec.id}'s last request records no tool fingerprint`
  const all = req.offered
  const candidates: { function_tools: ToolDefinition[]; builtin_tools: BuiltinTool[] }[] = [{ function_tools: all, builtin_tools: [] }]
  if (all.some((t) => t.name === 'web_search')) candidates.push({ function_tools: all.filter((t) => t.name !== 'web_search'), builtin_tools: [{ kind: 'web_search', max_uses: LEGACY_BUILTIN_MAX_USES }] })
  const hit = candidates.filter((c) => toolSchemaFingerprint({ function_tools: c.function_tools, allow_text_output: true, thinking: null }) === rec.last_tool_sha)
  if (hit.length !== 1) return `run ${rec.id}'s last request carried tools (fingerprint ${rec.last_tool_sha}) this conversation's list does not reproduce`
  const c = hit[0]!
  // the parameters rebuilt from the candidate alone: whatever the request now would declare is not carried over
  const { builtin_tools: _now, ...rest } = req.params
  const params: ModelRequestParameters = { ...rest, function_tools: c.function_tools, ...(c.builtin_tools.length ? { builtin_tools: c.builtin_tools } : {}) }
  return { ...makeFrame({ instructions, params }, model, runId, 'legacy-proven'), source: { conversation_id: rec.conversation_id, run_id: rec.id } }
}

// -- the hook -----------------------------------------------------------------------------------------------------

/** Frames of runs with no conversation on record (a unit's deps): kept for that deps' life only, never across runs. */
const unpersisted = new WeakMap<object, ProviderFrame>()

/** Why the frame's provider-run tools cannot go on this request (null: they can). A provider's own tool runs past the
 *  harness's gate, so every limit the harness's namesake would meet is checked here: the route offers it, the run's
 *  tools include it (the order's list, the run's allowed set), the order and the session let the network through. */
export function builtinBlocked(deps: AgentDeps, model: Model, frame: ProviderFrame): string | null {
  for (const b of frame.builtin_tools) {
    const selected = searchEngineForRun(deps)
    if (b.kind === 'web_search' && selected !== 'automatic') return `Web Search is set to ${selected}, but this conversation's frozen frame uses provider-native search; start a new conversation or set Web Search to Automatic`
    if (!(model.profile.builtin_tools ?? []).includes(b.kind)) return `the route no longer offers the provider's ${b.kind} this conversation was started with`
    if (deps.tool_allowed !== null && !deps.tool_allowed.has(b.kind)) return `the run's tools no longer include ${b.kind}, and the provider's ${b.kind} would bypass that`
    if (deps.work_order !== null && deps.work_order.tools !== null && !deps.work_order.tools.includes(b.kind)) return `the order's tools do not include ${b.kind}, and the provider's ${b.kind} would bypass that`
    if (deps.work_order !== null && !deps.work_order.execution.network) return `the order does not allow the network the provider's ${b.kind} uses`
    if (!networkGranted(refreshSession(deps).grants)) return `the session no longer grants the network outright, and the provider's ${b.kind} would bypass the approval`
  }
  return null
}

function apply(frame: ProviderFrame, req: FrameRequest): { instructions: string; params: ModelRequestParameters } {
  const { builtin_tools: _drop, ...rest } = req.params
  return {
    instructions: frame.instructions,
    params: { ...rest, function_tools: frame.function_tools.map((t) => structuredClone(t)), ...(frame.builtin_tools.length ? { builtin_tools: frame.builtin_tools.map((b) => ({ ...b })) } : {}) },
  }
}

/** The frame a conversation without one takes (inherited, proven, or its own first), or a refusal. */
function firstFrame(deps: AgentDeps, model: Model, req: FrameRequest, conversationId: string | null): ProviderFrame {
  if (conversationId !== null && deps.run_id) {
    const conv = deps.conn.get('SELECT root_run_id, fork_reason FROM conversations WHERE id=?', [conversationId])
    const count = deps.conn.get('SELECT count(*) AS n FROM model_requests WHERE run_id=?', [deps.run_id])
    // A different/new participant has its own explicit conversation boundary (and a persisted fork edge). It may
    // use another provider's tools on its FIRST request; subsequent runs/rounds still replay its recorded frame.
    // A same-participant branch or materialised legacy continuation does not get this exception.
    if (conv?.root_run_id === deps.run_id && Number(count?.n ?? 0) === 0
      && (conv.fork_reason === 'group_start' || conv.fork_reason === 'participant_change')) {
      return makeFrame(req, model, deps.run_id)
    }
  }
  const origin: FrameOrigin = deps.run_id ? frameOrigin(deps.conn, deps.run_id, conversationId) : { kind: 'fresh' }
  if (origin.kind === 'inherit') {
    // a fork carries its history, so it carries the frame that history was sent with — if this conversation's own
    // list is that list; a fork whose list is another cannot carry it, and is not given a new one silently
    const names = origin.frame.function_tools.map((t) => t.name).join(',')
    const offered = req.offered.filter((t) => !origin.frame.builtin_tools.some((b) => b.kind === t.name)).map((t) => t.name).join(',')
    if (names !== offered) throw new ProviderFrameRefused(`this conversation continues the history of run ${origin.run_id} (conversation ${origin.conversation_id}) but its tool list is not the one that history was sent with`, conversationId)
    return { ...origin.frame, basis: 'inherited', source: { conversation_id: origin.conversation_id, run_id: origin.run_id }, recorded: { ...origin.frame.recorded } }
  }
  if (origin.kind === 'evidence') {
    const proven = legacyFrame(origin.run, req, model, deps.run_id)
    if (typeof proven === 'string') throw new ProviderFrameRefused(`this conversation continues history from before provider frames were recorded, and its record does not prove the frame it ran with: ${proven}`, conversationId)
    return proven
  }
  return makeFrame(req, model, deps.run_id || null)
}

/** The agent's per-request hook: the request's instructions and parameters with the conversation's frame in place
 *  (recorded first when it has none), or a refusal before the request is made. */
export function freezeProviderFrame(deps: AgentDeps, model: Model, req: FrameRequest): { instructions: string; params: ModelRequestParameters } {
  const conversationId = deps.run_id ? conversationOfRun(deps.conn, deps.run_id) : null
  let frame: ProviderFrame | null = conversationId !== null ? readProviderFrame(deps.conn, conversationId) : unpersisted.get(deps) ?? null
  if (frame === null) frame = unpersisted.get(deps) ?? null
  if (frame === null) {
    const first = firstFrame(deps, model, req, conversationId)
    const stored = conversationId !== null ? recordProviderFrame(deps.conn, conversationId, first) : null
    if (stored === null) unpersisted.set(deps, first)
    frame = stored ?? first
  }
  const blocked = builtinBlocked(deps, model, frame)
  if (blocked !== null) throw new ProviderFrameRefused(blocked, conversationId)
  return apply(frame, req)
}
