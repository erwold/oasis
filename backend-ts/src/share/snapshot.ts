/** The share snapshot of one quiescent session (contract/src/share.ts): every row read at one cut (one SQLite read
 *  transaction), projected field by field into the strict DTO, every exported string through one ShareSanitizer at
 *  the moment it becomes a DTO field (after continuation joining; nothing raw is ever copied across).
 *
 *  Sources, and what is taken from each:
 *  - a run's own conversation record (`history_json` from `inheritedMessageCount` on, as /api/runs/:id/transcript):
 *    the assistant's words (text parts; a continued answer — output limit, a reconnect's kept partial, a stopped
 *    answer's partial — joined as one), the tool calls' names and ids, where a steer was delivered. Thinking, system
 *    and app prompts, compaction summaries, retry prompts, provider fields and raw arguments / returns are never
 *    exported (they are counted).
 *  - the run's persisted events: tool results (status, allowlisted fields, a cut preview), the steer records (by, client,
 *    status), and — for a run with no readable record — its text blocks and where its steers were delivered.
 *  - the run row (`user_text` as the opening words, only when the run's origin says they are someone's message), the
 *    collaboration graph (participants, roles, origins, groups), relays' and interactions' own messages, director turns
 *    and notes.
 *  - images: the session's own attachment assets (PNG / JPEG / WebP), re-validated against their records and bytes.
 *
 *  Assembly is incremental and bounded: items are appended one at a time against the item and character budgets, and
 *  nothing past a full budget is built. Stored records past their byte bounds are not parsed (the events stand in). */

import { ACTIVE_DIRECTOR_TURN_STATUSES, ACTIVE_INTERACTION_STATUSES, ACTIVE_RELAY_STATUSES, ACTIVE_RUN_STATUSES, IMAGE_MEDIA_TYPES, LIVE_SHARE_FORMAT, LIVE_SHARE_VERSION,
  SHARE_ACTION_KINDS, SHARE_FORMAT, SHARE_LIMITS, SHARE_OMISSION_KEYS, SHARE_VERSION, participantNames, plainAgentMentions, steersFromEvents, threadActionLabel, threadActionLines,
  TOOL_CALL_METADATA_KEYS, type Attachment, type CollaborationGraph, type DirectorNote, type DirectorTurn, type Execution, type ImageAttachment, type Interaction,
  type InteractionNote, type LiveImageRef, type LiveRun, type LiveSnapshot, type Run, type RunCollab, type Session, type ShareItem, type ShareSnapshotRequest,
  type ShareSnapshotResponse, type ShareStats, type SteerRecord } from '@oasis-code/contract'
import { createHash } from 'node:crypto'
import { homedir, userInfo } from 'node:os'
import { isAbsolute, join, normalize, sep } from 'node:path'
import type { HarnessConfig } from '../config.ts'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { getDirectorSession, getTurn } from '../director/store.ts'
import { graphOf } from '../agent/collab.ts'
import { closeDanglingToolCalls } from '../agent/runner.ts'
import { builtinResult } from '../agent/events.ts'
import { assetAttachment, attachmentReader } from '../llm/attachments.ts'
import { answerText, isModelMessages, type BuiltinToolReturnPart, type ResponsePart } from '../llm/messages.ts'
import { findModel } from '../llm/catalog.ts'
import { PROMPT_TEXT } from '../prompt_texts.ts'
import { HttpError, requireSession, type AppState } from '../api/state.ts'
import { ShareSanitizer, stripInvisible, type SanitizerContext } from './sanitize.ts'
import { sensitiveTool } from './sensitive.ts'
import { copyRelativePath } from './path_alias.ts'
import { isGeneratedParticipantId, shareParticipantNames } from './names.ts'
import { stableOpenText } from './live/stream_text.ts'
import { projectTeam, type TeamOutput } from './team.ts'
import type { ProgressSamples } from './progress.ts'

/** The session has work under way: only a quiescent session is exported. */
export class ShareActive extends Error {
  constructor(readonly reasons: string[]) { super(`the session has work under way (${reasons.join(', ')}); export it once it has finished`); this.name = 'ShareActive' }
}

/** What the projection reads, and nothing more: the app's state gives it (appShareSource), and so does the live share's
 *  worker with its own read-only connection (share/live/projector_worker.ts) — no runner, no credential store. */
export interface ShareSource {
  conn: Conn
  progressSamples?: ProgressSamples
  /** the model routes (for their labels only) */
  config: HarnessConfig
  store: { read(path: string): Uint8Array; readRange(path: string, offset: number, length: number): { bytes: Uint8Array; total: number } }
  settings: { data_dir: string; workspaces_dir: string }
  /** the app's session token, for the sanitizer only (masked wherever it appears; never logged) */
  session_token: string
  /** the collaboration graph of a session */
  graph: (sessionId: string) => CollaborationGraph
  /** the account's home and name for the sanitizer (default: read here) */
  account?: { home: string | null; name: string | null }
}

export function appShareSource(state: AppState): ShareSource {
  return { conn: state.conn, config: state.config, store: state.store, settings: state.settings, session_token: state.session_token, graph: (id) => graphOf(state, id) }
}

/** A run the live share watches while it works, as the app took it from the run's handle at one moment: its status, the
 *  last event seq it had emitted then (its persisted events are read up to it: the record and the open answer are one
 *  cut; null: every persisted event), and the words of the answer it was writing then (null: none open). */
export interface LiveRunInput { run_id: string; status: 'queued' | 'running'; bound_seq: number | null; open_text: string | null }
export type LiveImageOutcome = { resource: string; bytes: number; media_type: LiveImageRef['media_type']; width: number; height: number } | { omitted: 'damaged' | 'unsupported' }
export interface LiveInput {
  runs: ReadonlyMap<string, LiveRunInput>
  /** a picture of the session, its metadata stripped and given its opaque resource id — or why it is left out */
  image: (assetId: string, img: ImageAttachment, bytes: Uint8Array) => LiveImageOutcome
}
export interface LiveProjection {
  snapshot: LiveSnapshot
  /** resource id → asset id: the pictures this projection may serve (never sent to a viewer) */
  images: Map<string, string>
}
export interface LiveOptions { include_tool_details: boolean; include_images: boolean; exclude_run_ids: string[] }
/** the cut toolCallMetadata (agent/events.ts) puts on an event's metadata strings: one this long may have been cut */
const EVENT_META_CUT = 300
/** the metadata keys that name what a tool read or ran */
const SOURCE_KEYS = ['path', 'command', 'cwd', 'url'] as const

type Omitted = Record<(typeof SHARE_OMISSION_KEYS)[number], number>
type Rec = Record<string, unknown>
type Ev = { seq: number; event: string; data: Rec; t: string }
type NewItem = Omit<ShareItem, 'key'>
const rec = (v: unknown): Rec => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const isObj = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v)

/** the result fields a tool's details may carry (scalars only) */
const DETAIL_FIELDS = ['exit_code', 'duration_ms', 'total_lines', 'lines', 'count', 'truncated', 'results', 'http_status', 'bytes', 'returned_bytes', 'stopped', 'running',
  'kind', 'media_type', 'width', 'height', 'revision', 'code', 'timed_out', 'output_complete', 'engine', 'operation', 'offset', 'next_offset']
/** the strings of a tool result a cut preview is made of (details only) */
const PREVIEW_FIELDS = ['stdout', 'stderr', 'diff']
/** how much of a preview's source is sanitized before the cut (far past the cut: a masked value never straddles it) */
const PREVIEW_SOURCE_CHARS = 64_000
const STATUS_LABELS: Record<string, string> = { done: 'Done', cancelled: 'Stopped', error: 'Failed', queued: 'Queued', running: 'Running' }
const TURN_STATUS_LABELS: Record<string, string> = { done: 'Answered', error: 'Failed', cancelled: 'Cancelled' }
const MAX_LABEL = 160
const ACTIVE_TURNS = ['queued', ...ACTIVE_DIRECTOR_TURN_STATUSES]
const POLLING_TOOLS = new Set(['bash_output', 'stop_command'])
const TASK_EVENT_QUESTION = 'oasis-code told the director that runs finished'
/** An action row (agent/human_runs.ts): a person's or a connector's own write, recorded as a finished run, no model ran. */
const HUMAN_ACTION = 'human_action'
type ActionKind = (typeof SHARE_ACTION_KINDS)[number]
/** The outcome line the command route writes after the command (api/workspace.ts): only this exact last line is the
 *  harness's; any other `→` line is the command's own words. */
const GENERATED_OUTCOME = /^→ (?:exit (?:-?\d+|null|undefined)|running \([^()\n]*\)|running)$/
/** An outcome said without anything of the command: what a withheld action may still show. */
const SAFE_OUTCOME = /^→ (?:exit -?\d+|running)$/
/** A harness reference (checkpoint, proposal asset, run, execution: newId's `prefix_` + 12 hex) in a generated text. */
const HARNESS_REF = /\b[a-z]{1,8}_[0-9a-f]{12}\b/g
/** A participant id the harness generated (newParticipantId), as a harness-written text names it. */
const GENERATED_PARTICIPANT_REF = /\bpt_[0-9a-f]{6}\b/g
const FINAL_EXECUTION = new Set(['succeeded', 'failed', 'timeout', 'cancelled'])
const ASSET_ID = /^[A-Za-z0-9_-]{1,128}$/
/** The words the harness adds when it asks for the REST of an answer it kept (the output limit; a reconnect that kept a
 *  partial): only such a prompt joins the answers on either side of it. Any other app prompt (an empty or failed answer
 *  asked again — app.no_answer —, a reconnect with nothing kept, a note) starts a new answer, as the live thread does. */
const CUT_OFF = PROMPT_TEXT['app.cut_off']

type ActionInfo = {
  kind: ActionKind
  label: { what: string; by: string | null }
  /** the row's text as the thread shows it, raw (sanitized when emitted), its execution id and harness references out */
  text: string
  /** a sensitive source: head, text and details withheld */
  sensitive: boolean
  /** the command's own execution row, when provably this command's */
  exec: Execution | null
  exec_ids: string[]
}
type MessageDraft = { kind: 'message'; at: string | null; author: 'person' | 'director' | 'connector' | 'agent' | 'assistant' | 'unattributed'; author_label: string; source: 'opening' | 'steer' | 'answer'; text: string; steer: { status: 'queued' | 'delivered' | 'undelivered'; by: 'person' | 'director' | 'connector' | 'unrecorded'; client: string | null; reason: string | null } | null }
type ToolDraft = { kind: 'tool'; at: string | null; id: string; name: string; args: Rec; result: Rec | null; status: string | null }
/** A run's items before they are sanitized and keyed; every string here is still raw. */
type Draft =
  | MessageDraft
  | ToolDraft
  | { kind: 'image'; at: string | null; origin: 'attachment' | 'screenshot' | 'generated'; asset_id: string }
  | { kind: 'notice'; at: string | null; code: 'context_compacted' | 'woken_by_watch' | 'run_failed' | 'run_stopped' | 'history_unavailable'; text: string }
  | { kind: 'steer_slot'; at: string | null; steer_id: string; text: string }

interface Rows {
  session: Session
  runs: Run[]
  graph: CollaborationGraph
  events: Map<string, Ev[]>
  histories: Map<string, string | null>
  notes: DirectorNote[]
  turns: DirectorTurn[]
  relays: ReturnType<typeof repo.listRelays>
  interactions: Interaction[]
  /** each interaction's notes (the person's words to its members), by interaction id */
  notes_of: Map<string, InteractionNote[]>
  project_dirs: string[]
}

/** What still runs in the session (empty: it is quiescent): a live or queued/running run, ANY director turn of the
 *  session queued, generating or awaiting its answer (whether or not it is a director's current turn), a running relay,
 *  an active interaction. */
export function activeWork(state: AppState, sessionId: string): string[] {
  const reasons: string[] = []
  if (state.runs.activeRunsOfSession(sessionId).length) reasons.push('a run is live')
  return [...reasons, ...activeInRecords(state.conn, sessionId)]
}

/** What the records say still runs in the session (activeWork without the runner's own handles). */
export function activeInRecords(conn: Conn, sessionId: string): string[] {
  const reasons: string[] = []
  if (repo.listRuns(conn, sessionId).some((r) => (ACTIVE_RUN_STATUSES as readonly string[]).includes(r.status))) reasons.push('a run is queued or running')
  const marks = ACTIVE_TURNS.map(() => '?').join(',')
  const turns = Number(rec(conn.get(`SELECT COUNT(*) AS n FROM director_turns WHERE session_id=? AND status IN (${marks})`, [sessionId, ...ACTIVE_TURNS])).n ?? 0)
  if (turns > 0) reasons.push('a director turn is queued or under way')
  if (repo.listRelays(conn, sessionId).some((r) => (ACTIVE_RELAY_STATUSES as readonly string[]).includes(r.status))) reasons.push('a relay is running')
  if (repo.listInteractions(conn, sessionId).some((i) => (ACTIVE_INTERACTION_STATUSES as readonly string[]).includes(i.status))) reasons.push('an interaction is running')
  return reasons
}

function readRows(state: ShareSource, session: Session, live: LiveInput | null, taskDirs = false): Rows {
  const runs = repo.listRuns(state.conn, session.id)
  const events = new Map<string, Ev[]>()
  for (const e of repo.listSessionEvents(state.conn, session.id)) {
    let list = events.get(e.run_id)
    if (list === undefined) { list = []; events.set(e.run_id, list) }
    list.push(e)
  }
  for (const list of events.values()) list.sort((a, b) => a.seq - b.seq)
  // a watched run's events up to the seq its open answer was taken at (one cut with it)
  if (live !== null) {
    for (const [runId, w] of live.runs) {
      const list = events.get(runId)
      if (list !== undefined && w.bound_seq !== null) events.set(runId, list.filter((e) => e.seq <= w.bound_seq!))
    }
  }
  // the raw records only: what each run inherited is counted later, under the parse budget (never parsed unbounded here)
  const histories = new Map(runs.map((r) => [r.id, repo.getRunHistory(state.conn, r.id)]))
  const project_dirs = taskDirs ? taskProjectDirs(state.conn, session) : projectDirsOf(state.conn, session)
  const turns = state.conn.all('SELECT id FROM director_turns WHERE session_id=? ORDER BY created_at, seq', [session.id])
    .map((row) => getTurn(state.conn, str(rec(row).id))).filter((t): t is DirectorTurn => t !== null)
  const interactions = repo.listInteractions(state.conn, session.id)
  return {
    session, runs, graph: state.graph(session.id), events, histories, notes: repo.listDirectorNotes(state.conn, session.id), turns,
    relays: repo.listRelays(state.conn, session.id), interactions, project_dirs,
    notes_of: new Map(interactions.map((ix) => [ix.id, repo.listInteractionNotes(state.conn, ix.id)])),
  }
}

/** The folders a session's text may name that the sanitizer makes relative: its workspaces, its project's source and
 *  base, its roots. */
function projectDirsOf(conn: Conn, session: Session): string[] {
  const project = repo.getProject(conn, session.project_id)
  return [...repo.workspacesOfSession(conn, session.id).map((w) => w.path), ...(session.workspace_id ? [repo.getWorkspace(conn, session.workspace_id)?.path ?? ''] : []),
    project?.source_path ?? '', project?.base_repo_path ?? '', ...(session.roots ?? []).map((r) => r.path)].filter((p) => p.length > 1)
}

/** V3 / live v2: the folders of EVERY session of the session's task (deleted ones too, any project): a session's words
 *  that name another member's project folder are masked as well (the task is shared together). */
function taskProjectDirs(conn: Conn, session: Session): string[] {
  const root = session.task_root_id ?? session.id
  const ids = conn.all('SELECT id FROM sessions WHERE id=? OR task_root_id=? OR id=? ORDER BY created_at, rowid', [root, root, session.id]).map((r) => String(rec(r).id))
  const out = new Set<string>(projectDirsOf(conn, session))
  for (const id of ids) {
    const other = id === session.id ? null : repo.getSession(conn, id)
    if (other) for (const d of projectDirsOf(conn, other)) out.add(d)
  }
  return [...out]
}

/** What a V3 / live v2 projection's sanitizer depends on beyond the session's own rows: the folders of every session
 *  of its task (taskProjectDirs), as one key. A live part made under another key is never sent (share/live/service.ts). */
export function taskContextKey(conn: Conn, session: Session): string {
  return createHash('sha256').update([...new Set(taskProjectDirs(conn, session))].sort().join('\0')).digest('hex')
}

/** The account's home and name, read as two values (never by listing the environment). */
function accountOf(): { home: string | null; name: string | null } {
  let home: string | null = null
  let name: string | null = null
  try { home = homedir() || null } catch { home = null }
  try { name = userInfo().username || null } catch { name = null }
  return { home, name }
}

/** The snapshot and the dialog's run choice. Throws ShareActive while work is under way. */
export function buildShareSnapshot(state: AppState, sessionId: string, req: ShareSnapshotRequest, now: () => Date = () => new Date(), progressSamples?: ProgressSamples): ShareSnapshotResponse {
  // the session row is read inside the same cut as everything else (its title, its folders)
  const src = { ...appShareSource(state), progressSamples }
  return state.conn.transaction(() => {
    const session = requireSession(state, sessionId)
    const reasons = activeWork(state, session.id)
    if (reasons.length) throw new ShareActive(reasons)
    return project(src, readRows(src, session, null), req, now, null) as ShareSnapshotResponse
  })
}

/** V3 / live v2: one session's projection with the extras (share/team.ts), its sanitizer over every folder of its
 *  task, counted against `extras.budget`. In the caller's read transaction. */
export function projectShareSession(src: ShareSource, session: Session, req: ShareSnapshotRequest, now: () => Date, live: LiveInput | null, extras: ProjectExtras):
  (ShareSnapshotResponse | LiveProjection) & { extra?: ProjectedExtra } {
  return project(src, readRows(src, session, live, true), req, now, live, extras)
}

/** The live share's projection of a session that may be at work (contract/src/live_share.ts): the same projection as
 *  the snapshot — the same rows at one cut, the same whitelist, the same sanitizer and sensitive-source rules — with the
 *  watched runs read from their persisted events (up to their cut) and their open answers' stable parts, pictures as
 *  stripped refs. Throws HttpError 404 for a session that is gone. */
export function buildLiveSnapshot(src: ShareSource, sessionId: string, options: LiveOptions, live: LiveInput, now: () => Date = () => new Date()): LiveProjection {
  return src.conn.transaction(() => {
    const session = repo.getSession(src.conn, sessionId)
    if (session === null || session.status === repo.DELETED_SESSION) throw new HttpError(404, 'session not found')
    const req: ShareSnapshotRequest = { include_tool_details: options.include_tool_details, include_images: options.include_images, exclude_run_ids: [...options.exclude_run_ids] }
    return project(src, readRows(src, session, live), req, now, live) as LiveProjection
  })
}

/** What V3 / live v2 count across sessions: the snapshot's budgets (SHARE_LIMITS), shared by every session of one share
 *  (V1 / V2 / live v1: a fresh one, so each counts as it always did). */
export interface ShareBudget { items: number; text: number; images: number; image_bytes: number; history_bytes: number }
export const freshBudget = (): ShareBudget => ({ items: 0, text: 0, images: 0, image_bytes: 0, history_bytes: 0 })
/** V3 / live v2: the shared budget, and the card's row keys a live producer keeps (absent: positional). */
export interface ProjectExtras { budget: ShareBudget; rowKeys?: Map<string, string> }
/** What V3 / live v2 add to a session's projection (share/team.ts), with the run keys the projection gave. */
export interface ProjectedExtra { team: TeamOutput['team']; faces: TeamOutput['faces']; bots: TeamOutput['bots']; runKey: Map<string, string>; excluded: Set<string> }

function project(state: ShareSource, rows: Rows, req: ShareSnapshotRequest, now: () => Date, live: LiveInput | null, extras: ProjectExtras | null = null): (ShareSnapshotResponse | LiveProjection) & { extra?: ProjectedExtra } {
  const budget = extras?.budget ?? freshBudget()
  const account = state.account ?? accountOf()
  const dataDirs = [state.settings.data_dir].filter((d): d is string => typeof d === 'string' && d.length > 1)
  const sanCtx: SanitizerContext = { token: state.session_token, project_dirs: rows.project_dirs, data_dirs: dataDirs, home_dirs: account.home ? [account.home] : [], username: account.name }
  const san = new ShareSanitizer(sanCtx)
  const omitted = Object.fromEntries(SHARE_OMISSION_KEYS.map((k) => [k, 0])) as Omitted
  const modelLabel = (model: string | null | undefined): string => san.label(model ? (findModel(state.config, model)?.label || model) : 'unknown model', 80)
  const L = SHARE_LIMITS

  // ---- the stored records, parsed once, within their byte bounds ------------------------------------------------------
  const runsById = new Map(rows.runs.map((r) => [r.id, r]))
  /** a run's whole record as parsed (null: none, unreadable, or past the budget — counted once) */
  const full = new Map<string, Rec[] | null>()
  const parseWhole = (runId: string): Rec[] | null => {
    if (full.has(runId)) return full.get(runId)!
    let json: string | null
    if (rows.histories.has(runId)) json = rows.histories.get(runId) ?? null
    else json = repo.getRunHistory(state.conn, runId)
    let out: Rec[] | null = null
    if (json && json !== '[]') {
      if (json.length > L.max_history_bytes || budget.history_bytes + json.length > L.max_total_history_bytes) omitted.histories_over_budget++
      else {
        budget.history_bytes += json.length
        let messages: unknown = null
        try { messages = JSON.parse(json) } catch { messages = null }
        if (Array.isArray(messages) && messages.every(isObj)) out = messages as Rec[]
        else omitted.histories_unreadable++
      }
    }
    full.set(runId, out)
    return out
  }
  /** How many messages at the head of a run's record it inherited (as inheritedMessageCount counts them, back along the
   *  chain to the first run that kept a record), or null when an ancestor's record could not be read within the budget. */
  const inherited = (run: Run): number | null => {
    let from: string | null = run.resumes_run_id
    const walked = new Set<string>()
    while (from !== null && !walked.has(from)) {
      walked.add(from)
      const raw = rows.histories.has(from) ? rows.histories.get(from) ?? null : repo.getRunHistory(state.conn, from)
      if (raw && raw !== '[]') {
        const parent = parseWhole(from)
        if (parent === null) return null
        return isModelMessages(parent) ? closeDanglingToolCalls(parent).length : 0
      }
      from = runsById.get(from)?.resumes_run_id ?? repo.getRun(state.conn, from)?.resumes_run_id ?? null
    }
    return 0
  }
  /** live: a run watched now, or one the records call queued or running — its record lags its events, which stand in */
  const isLiveRun = (r: Run): boolean => live !== null && (live.runs.has(r.id) || (ACTIVE_RUN_STATUSES as readonly string[]).includes(r.status))
  const parsed = new Map<string, Rec[] | null>()
  for (const run of rows.runs) {
    if (isLiveRun(run)) { parsed.set(run.id, null); continue }
    const whole = parseWhole(run.id)
    if (whole === null) { parsed.set(run.id, null); continue }
    const from = inherited(run)
    // an ancestor that does not read, or a record shorter than what the run inherited: the events stand in (never the
    // whole record taken as the run's own)
    if (from === null || from > whole.length) { if (from !== null) omitted.histories_unreadable++; parsed.set(run.id, null); continue }
    parsed.set(run.id, from > 0 ? whole.slice(from) : whole)
  }

  // ---- what each command execution was, across the whole session (excluded runs included) -----------------------------
  const knownExec = new Set<string>()
  const sensitiveExec = new Set<string>()
  const norm = (v: unknown) => (typeof v === 'string' ? stripInvisible(v).text : null)
  for (const run of rows.runs) {
    // `whole`: the call's own arguments (its record); `unknown`: an event's metadata that may be cut (toolCallMetadata
    // keeps 300 characters) or names no command at all — a command known only so is treated as a sensitive source
    const commands = new Map<string, { command: string; cwd: string; whole: boolean; unknown: boolean }[]>()
    const addCommand = (id: string, form: { command: string; cwd: string; whole: boolean; unknown: boolean }) => { const list = commands.get(id) ?? []; list.push(form); commands.set(id, list) }
    const execs = new Map<string, string>()
    for (const e of rows.events.get(run.id) ?? []) {
      if (e.event === 'tool_call' && str(e.data.tool) === 'bash' && str(e.data.tool_call_id)) addCommand(str(e.data.tool_call_id), { command: str(e.data.command), cwd: str(e.data.cwd), whole: false,
        unknown: str(e.data.command) === '' || str(e.data.command).length >= EVENT_META_CUT || str(e.data.cwd).length >= EVENT_META_CUT })
      if (e.event === 'tool_result' && str(e.data.tool) === 'bash' && str(e.data.execution_id) && str(e.data.tool_call_id)) execs.set(str(e.data.tool_call_id), str(e.data.execution_id))
    }
    for (const m of parsed.get(run.id) ?? []) {
      for (const part of Array.isArray(m.parts) ? m.parts : []) {
        if (!isObj(part)) continue
        if (part.part_kind === 'tool-call' && part.tool_name === 'bash') {
          let args: unknown = part.args
          if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = {} } }
          if (str(rec(args).command)) addCommand(str(part.tool_call_id), { command: str(rec(args).command), cwd: str(rec(args).cwd), whole: true, unknown: false })
        }
        if (part.part_kind === 'tool-return' && part.tool_name === 'bash' && str(rec(part.content).execution_id)) execs.set(str(part.tool_call_id), str(rec(part.content).execution_id))
      }
    }
    for (const [callId, exec] of execs) {
      knownExec.add(exec)
      const forms = commands.get(callId)
      // a command this session's records do not hold is treated as a sensitive source; any form of it that is one makes it one
      // a command this session's records do not hold whole (only a possibly cut event) is one too: its output, wherever
      // it is polled, is withheld (the safe-looking start of a cut command says nothing of what follows the cut)
      if (forms === undefined || (forms.some((f) => f.unknown) && !forms.some((f) => f.whole))
        || forms.some((f) => sensitiveTool('bash', { command: norm(f.command), cwd: norm(f.cwd) || null }, dataDirs))) sensitiveExec.add(exec)
    }
  }

  // ---- action rows (a connector's or the person's command, checkpoint, checks, integration, approval) ---------------
  // read once, excluded ones included: a sensitive command's executions are withheld wherever they appear (an agent's
  // polling of them included); their executions are never made known (polling of them stays withheld)
  const collabOf = new Map(rows.graph.runs.map((r) => [r.id, r.collab]))
  /** The cwd forms a command's execution is classified by. Only inside a harness-managed copy — a workspace row that is
   *  not the person's folder (`direct`), local, at exactly `<workspaces_dir>/<its id>` (where the harness makes copies),
   *  never the data folder itself — is the cwd read relative to the copy (its place in the data folder is not a source;
   *  what it names below the copy is), with a live source mounted in it read at its own root too. Anywhere else — a
   *  direct project's folder, a project source or base, a session root, the data folder, a path that leaves the copy —
   *  the cwd is read whole, so the data-folder rule and every other rule still apply. */
  const workspacesDir = normalize(state.settings.workspaces_dir).replace(/[\\/]+$/, '')
  const dataRoots = dataDirs.map((d) => normalize(d).replace(/[\\/]+$/, ''))
  const cwdForms = (x: Execution): string[] => {
    const cwd = x.cwd
    const ws = x.workspace_id ? repo.getWorkspace(state.conn, x.workspace_id) : null
    if (ws === null || ws.kind === 'direct' || ws.target?.kind === 'ssh' || ws.remote || !ASSET_ID.test(ws.id) || !isAbsolute(ws.path) || !isAbsolute(cwd)) return [cwd]
    // inside the copy, at a path boundary (`<root>_x` is not), `..` resolved — the copy's other spelling taken as the
    // same place on macOS only (path_alias.ts copyRelativePath: the app stores a copy at `<workspaces_dir>/<id>` as
    // configured while its execution records the real path it ran at, /tmp ↔ /private/tmp); anywhere else — a path
    // that leaves the copy, the data folder under any spelling — the cwd is read whole
    const rel = copyRelativePath({ cwd, root: ws.path, id: ws.id, workspacesDir, dataRoots })
    if (rel === null) return [cwd]
    const forms = [rel]
    const mount = ws.source_mount
    if (mount) {
      const [first, ...rest] = rel.split(sep)
      if (first === mount.name) forms.push(join(mount.root, ...rest))
    }
    return forms
  }
  /** V3 / live v2: the generated participant ids a harness-written text names, as the share names those participants
   *  (this session's groups; one no group lists: `a participant`) — the text of an action row only, never prose */
  let sharedNames: Map<string, string> | null = null
  const shareGeneratedIds = (text: string): string => text.replace(GENERATED_PARTICIPANT_REF, (id) => {
    if (sharedNames === null) {
      sharedNames = new Map()
      for (const ix of rows.interactions) for (const [pid, name] of shareParticipantNames(ix.participants)) if (isGeneratedParticipantId(pid) && !sharedNames.has(pid)) sharedNames.set(pid, name)
    }
    return sharedNames.get(id) ?? 'a participant'
  })
  const progressActionExec = new Set<string>()
  const actions = new Map<string, ActionInfo>()
  for (const run of rows.runs) {
    const info = actionOf(run)
    if (info === null) continue
    actions.set(run.id, info)
    if (info.exec !== null && !info.sensitive) progressActionExec.add(info.exec.id)
    if (info.sensitive) for (const x of info.exec_ids) sensitiveExec.add(x)
  }

  /** The action a row records, read from its own text and receipt (the run_finished event's receipt when the row's is
   *  empty) and — a command only — its execution's own row, when that row is provably this command's. */
  function actionOf(run: Run): ActionInfo | null {
    const c = collabOf.get(run.id) ?? run.collab ?? null
    if (run.spawned_by !== HUMAN_ACTION && c?.origin.request !== 'action') return null
    let receipt = rec(run.receipt)
    if (Object.keys(receipt).length === 0) {
      const finished = (rows.events.get(run.id) ?? []).filter((e) => e.event === 'run_finished').at(-1)
      receipt = rec(finished?.data.receipt)
    }
    const label = threadActionLabel(run.label)
    const recorded = str(rec(receipt.mechanical).human_action)
    const word = label.what.split(' ')[0] ?? ''
    const kind: ActionKind = (SHARE_ACTION_KINDS as readonly string[]).includes(recorded) && recorded !== 'other' ? recorded as ActionKind
      : word === 'command' ? 'command' : word === 'checkpoint' ? 'checkpoint' : word === 'checks' ? 'verify'
        : word === 'integration' || word === 'adopt' ? 'integrate' : word === 'approved' ? 'approve_proposal' : 'other'
    const raw = run.user_text || str(receipt.final_text)
    const execIds = (Array.isArray(rec(receipt.produced).executions) ? rec(receipt.produced).executions as unknown[] : [])
      .filter((x): x is string => typeof x === 'string' && ASSET_ID.test(x))
    // a text the command route wrote (`$ …`) is read as a command whatever the row's kind says (fail closed)
    if (kind !== 'command' && !raw.startsWith('$ ')) {
      // a generated text: the harness's references masked, nothing else of it is a source; V3 / live v2: a participant
      // it names by its generated id (an adoption's `(pt_…)`) named as the share names it (share/names.ts)
      const generated = raw.replace(HARNESS_REF, '[id]')
      return { kind, label, text: extras !== null ? shareGeneratedIds(generated) : generated, sensitive: false, exec: null, exec_ids: execIds }
    }
    // the command as sent: the text without the route's `$ ` and its own last outcome line (the command's own lines,
    // `→` ones and CRs included, kept); its execution id is never exported
    let body = raw
    let outcome: string | null = null
    const nl = raw.lastIndexOf('\n')
    if (nl >= 0 && GENERATED_OUTCOME.test(raw.slice(nl + 1))) { outcome = raw.slice(nl + 1); body = raw.slice(0, nl) }
    const command = body.startsWith('$ ') ? body.slice(2) : body
    if (outcome !== null && outcome.startsWith('→ running')) outcome = '→ running'
    const text = outcome === null ? body : `${body}\n${outcome}`
    // the execution's row is this command's only when it is of this action's folder, of no run (or this one), and holds
    // the same command; only then are its cwd, its measured fields and (details) its sealed output read
    let exec: Execution | null = null
    const xid = execIds[0]
    if (xid !== undefined) {
      const x = repo.getExecution(state.conn, xid)
      if (x !== null && x.workspace_id !== null && run.workspace_id !== null && x.workspace_id === run.workspace_id
        && (x.run_id === null || x.run_id === run.id) && x.command === command) exec = x
    }
    // detection reads the whole command before any cut or redaction, as sent and as exported (NFC, invisible out), with
    // the execution's cwd (cwdForms)
    const cwds = exec === null ? [null] : cwdForms(exec)
    const forms = cwds.flatMap((cwd) => [{ command, cwd }, { command: norm(command), cwd: norm(cwd) }])
    const sensitive = forms.some((f) => sensitiveTool('bash', { command: f.command, cwd: f.cwd || null }, dataDirs))
    return { kind, label, text, sensitive, exec, exec_ids: execIds }
  }

  // ---- keys -------------------------------------------------------------------------------------------------------------
  const runKey = new Map(rows.runs.map((r, i) => [r.id, `r${i + 1}`]))
  const excluded = new Set(req.exclude_run_ids.filter((id) => runKey.has(id)))
  omitted.runs_excluded = excluded.size
  const partKey = new Map(rows.graph.participants.map((p, i) => [p.id, `p${i + 1}`]))
  const partLabel = new Map(rows.graph.participants.map((p) => [p.id, p.label]))
  const groupList = [...rows.relays.map((g) => ({ id: g.id, at: g.created_at })), ...rows.interactions.map((g) => ({ id: g.id, at: g.created_at }))]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  const groupKey = new Map(groupList.map((g, i) => [g.id, `g${i + 1}`]))
  // the person's words a director turn handed on unchanged: said once, over the director's turn (baseline thread)
  const saidToDirector = new Map<string, string>()
  for (const t of rows.turns) {
    if (t.kind !== 'user' || !t.envelope) continue
    for (const id of [...t.dispatched_interaction_ids, ...t.dispatched_run_ids]) saidToDirector.set(id, t.envelope.text)
  }

  // the main participant runs on whatever model each of its runs used (its graph label/model are the session's current
  // ones): it is named by its role, each run carries its own model_label
  const participants = rows.graph.participants.map((p) => p.role === 'main'
    ? { key: partKey.get(p.id)!, role: p.role, label: 'Main agent', model_label: null }
    : { key: partKey.get(p.id)!, role: p.role, label: san.label(p.label, 80), model_label: p.model ? modelLabel(p.model) : null })
  const runStatus = (r: Run) => ((r.status === 'done' || r.status === 'cancelled' || r.status === 'error') ? r.status : 'error' as const)
  /** live: a watched run is as its handle said; a run the records call queued or running is so; the rest as runStatus */
  const liveStatus = (r: Run): LiveRun['status'] => live?.runs.get(r.id)?.status ?? (r.status === 'queued' || r.status === 'running' ? r.status : runStatus(r))
  const runs = rows.runs.filter((r) => !excluded.has(r.id)).map((r) => {
    const c = collabOf.get(r.id) ?? r.collab ?? null
    const status = live !== null ? liveStatus(r) : runStatus(r)
    const keyOf = (id: string | null | undefined) => (id && runKey.has(id) && !excluded.has(id) ? runKey.get(id)! : null)
    const groupId = c?.placement.group?.id ?? r.relay_id ?? r.interaction_id ?? null
    return {
      key: runKey.get(r.id)!, parent: keyOf(r.parent_run_id), continues: keyOf(r.resumes_run_id),
      participant: c?.participant_id ? partKey.get(c.participant_id) ?? null : null, role: c?.participant_role ?? null,
      surface: c?.placement.surface ?? 'thread', group: groupId ? groupKey.get(groupId) ?? null : null,
      started_by: c?.origin.actor ?? 'person', request: c?.origin.request ?? 'message',
      client: c?.origin.client ? san.label(c.origin.client, 40) : null,
      label: r.label ? san.label(r.label, 120) : null, model_label: modelLabel(r.model), status, status_label: STATUS_LABELS[status]!,
      started_at: r.created_at, finished_at: r.finished_at, error: status === 'error' && r.error && !actions.has(r.id) ? san.text(r.error, 500) : null,
    }
  })

  // ---- the bounded sink: items appended one at a time; once full nothing more is built ---------------------------------
  const items: ShareItem[] = []
  let sinkFull = false
  const emit = (item: NewItem): boolean => {
    if (sinkFull) return false
    // every string of the item counts, its key included
    const key = `i${items.length + 1}`
    const size = textSize(item) + key.length
    if (budget.items >= L.max_items || budget.text + size > L.max_total_text_chars) { sinkFull = true; return false }
    budget.text += size
    budget.items++
    items.push({ ...item, key } as ShareItem)
    return true
  }

  // images: the session's own attachment assets only, validated against record and bytes; one item per asset
  const images: ShareSnapshotResponse['snapshot']['images'] = []
  // live: the stripped pictures' refs, and which asset each resource is (for the image route; never sent)
  const liveRefs: LiveImageRef[] = []
  const liveImages = new Map<string, string>()
  type Omission = 'missing' | 'damaged' | 'unsupported' | 'over_budget'
  const shownAssets = new Set<string>()
  const read = attachmentReader((id) => repo.getAsset(state.conn, id), (p) => state.store.read(p), rows.session.project_id, rows.session.id)
  const OMIT_COUNT = { missing: 'images_missing', damaged: 'images_damaged', unsupported: 'images_unsupported', over_budget: 'images_over_budget' } as const
  /** An image's bytes, validated — not yet kept: they are kept only once its item has been accepted. */
  const resolveImage = (assetId: string): { img: ImageAttachment; bytes: Uint8Array } | { omitted: Omission } => {
    const asset = /^[A-Za-z0-9_-]{1,128}$/.test(assetId) ? repo.getAsset(state.conn, assetId) : null
    // another session's or project's asset named in this session's record is never read: it is missing here
    if (asset === null || asset.project_id !== rows.session.project_id || asset.meta.session_id !== rows.session.id || asset.meta.role !== 'attachment' || asset.kind !== 'image') return { omitted: 'missing' }
    let attachment: Attachment | null = null
    try { attachment = assetAttachment(asset) } catch { attachment = null }
    if (attachment === null || 'file_kind' in attachment || 'representation' in attachment || !(IMAGE_MEDIA_TYPES as readonly string[]).includes(attachment.media_type)) return { omitted: 'unsupported' }
    const img = attachment as ImageAttachment
    if (img.bytes > L.max_image_bytes || Math.max(img.width, img.height) > L.max_image_side || img.width * img.height > L.max_image_pixels
      || budget.images >= L.max_images || budget.image_bytes + img.bytes > L.max_total_image_bytes) return { omitted: 'over_budget' }
    const bytes = read(img)
    if (bytes === null) return { omitted: 'damaged' }
    return { img, bytes }
  }
  /** One image item per asset (an attachment handed to several runs stands once, where it first stands). The item and
   *  its bytes are committed together: bytes are kept only when the item was accepted by the item and text budgets. */
  const emitImage = (run: string | null, at: string | null, origin: 'attachment' | 'screenshot' | 'generated', assetId: string): void => {
    if (sinkFull || shownAssets.has(assetId)) return
    if (budget.items >= L.max_items) { sinkFull = true; return }
    shownAssets.add(assetId)
    if (!req.include_images) {
      if (emit({ kind: 'image', run, at, origin, image: null, omitted: 'images_off' } as NewItem)) omitted.images_off++
      return
    }
    const r = resolveImage(assetId)
    if ('omitted' in r) {
      if (emit({ kind: 'image', run, at, origin, image: null, omitted: r.omitted } as NewItem)) omitted[OMIT_COUNT[r.omitted]]++
      return
    }
    if (live !== null) {
      // the stripped bytes, never the source's: the item names the picture's opaque resource id
      const out = live.image(assetId, r.img, r.bytes)
      if ('omitted' in out) {
        if (emit({ kind: 'image', run, at, origin, image: null, omitted: out.omitted } as NewItem)) omitted[OMIT_COUNT[out.omitted]]++
        return
      }
      if (!emit({ kind: 'image', run, at, origin, image: out.resource, omitted: null } as unknown as NewItem)) return
      if (!liveImages.has(out.resource)) {
        liveImages.set(out.resource, assetId)
        liveRefs.push({ resource: out.resource, media_type: out.media_type, width: out.width, height: out.height, bytes: out.bytes })
        budget.images++
      }
      budget.image_bytes += r.bytes.length
      return
    }
    const key = `img${images.length + 1}`
    if (!emit({ kind: 'image', run, at, origin, image: key, omitted: null } as NewItem)) return
    images.push({ key, media_type: r.img.media_type, width: r.img.width, height: r.img.height, bytes: r.bytes.length, data_base64: Buffer.from(r.bytes).toString('base64') })
    budget.images++
    budget.image_bytes += r.bytes.length
  }

  // ---- the timeline: groups, director exchanges and runs by time; a run's items stay together ---------------------------
  type Block = { at: string; order: number; build: () => void }
  const blocks: Block[] = []
  let order = 0
  for (const relay of rows.relays) {
    const g = rows.graph.groups.find((x) => x.id === relay.id) ?? null
    blocks.push({ at: relay.created_at, order: order++, build: () => groupItems('relay', relay.id, relay.user_text, relay.status, relay.created_at, g, repo.relayInputs(state.conn, relay.id).attachments) })
  }
  for (const ix of rows.interactions) {
    const g = rows.graph.groups.find((x) => x.id === ix.id) ?? null
    blocks.push({ at: ix.created_at, order: order++, build: () => groupItems('interaction', ix.id, ix.user_text, ix.status, ix.created_at, g, repo.interactionInputs(state.conn, ix.id).attachments) })
  }
  // director turns with their answers (a failed or cancelled one keeps its question); a note no turn closed stands alone
  const notesByTurn = new Map<string, DirectorNote>()
  for (const n of rows.notes) if (n.turn_id) notesByTurn.set(n.turn_id, n)
  const turnIds = new Set(rows.turns.map((t) => t.id))
  for (const turn of rows.turns) blocks.push({ at: turn.created_at, order: order++, build: () => directorTurnItem(turn) })
  for (const note of rows.notes) {
    if (note.turn_id && turnIds.has(note.turn_id)) continue
    blocks.push({ at: note.created_at, order: order++, build: () => directorNoteItem(note) })
  }
  // the person's words to an interaction's members (MemberWords), where the thread shows them; the steer that carried
  // one into a run is the harness's handover of these words, never said again
  const noteSteers = new Set<string>()
  for (const ix of rows.interactions) {
    if (!groupKey.has(ix.id)) continue
    for (const n of rows.notes_of.get(ix.id) ?? []) {
      noteSteers.add(`note:${n.id}`)
      blocks.push({ at: n.created_at, order: order++, build: () => groupNoteItem(ix, n) })
    }
  }
  for (const run of rows.runs) {
    if (excluded.has(run.id)) continue
    blocks.push({ at: run.created_at, order: order++, build: () => (actions.has(run.id) ? actionItem(run, actions.get(run.id)!) : runItems(run)) })
  }
  blocks.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order))
  for (const b of blocks) { if (sinkFull) break; b.build() }

  function groupItems(kind: 'relay' | 'interaction', id: string, text: string, status: string, at: string, g: CollaborationGraph['groups'][number] | null, attachments: unknown[]): void {
    const origin = g?.origin ?? null
    const author = origin?.actor === 'director' ? 'director' : origin?.actor === 'connector' ? 'connector' : 'person'
    const client = origin?.actor === 'connector' && origin.client ? san.label(origin.client, 40) : null
    const said = saidToDirector.get(id) === text
    emit({
      kind: 'group', run: null, at, group: groupKey.get(id)!, group_kind: kind, author, client,
      author_label: author === 'connector' ? (client ?? 'Connector') : author === 'director' ? 'Director' : 'Person',
      text: said ? '' : san.text(plainAgentMentions(text), L.max_text_chars), status_label: san.label(status, 40),
      participants: (g?.participant_ids ?? []).map((p) => partKey.get(p)).filter((k): k is string => k !== undefined),
    } as NewItem)
    if (!said) for (const a of imageAttachments(attachments)) emitImage(null, at, 'attachment', a)
  }

  function groupNoteItem(ix: Interaction, n: InteractionNote): void {
    // V3 / live v2: never a harness-generated participant id (share/names.ts); V1 / V2 as they always named them
    const names = extras !== null ? shareParticipantNames(ix.participants) : participantNames(ix.participants)
    // a participant the group no longer lists: its id, as the app says it — in a V3 / v2 share never a generated one
    const nameOf = (id: string) => names.get(id) ?? (extras !== null && isGeneratedParticipantId(id) ? 'a participant' : id)
    emit({
      kind: 'group_note', run: null, at: n.created_at, group: groupKey.get(ix.id)!, to: n.to === 'everyone' ? null : san.label(nameOf(n.to), 80),
      text: san.text(plainAgentMentions(n.text), L.max_text_chars), status: n.status,
      delivered_to: Object.keys(n.delivered).map(nameOf).sort().map((name) => san.label(name, 80)),
    } as NewItem)
  }

  /** An action row: one action item, as the thread's action line shows it. Nothing else of the row is an item (its text
   *  is said once, here: no opening, notice, steer or error of it). */
  function actionItem(run: Run, info: ActionInfo): void {
    const withheld = info.sensitive
    const lines = threadActionLines(info.text)
    let details: Extract<ShareItem, { kind: 'action' }>['details'] = null
    if (withheld) omitted.sensitive_tool_content++
    else if (info.exec_ids.length && (info.kind === 'command' || info.exec !== null)) {
      if (!req.include_tool_details) omitted.tool_details++
      else if (info.exec !== null) details = actionDetails(run, info.exec)
    }
    emit({
      kind: 'action', run: runKey.get(run.id)!, at: run.created_at, action: info.kind, actor: info.label.by === null ? 'person' : 'connector',
      what: san.label(info.label.what, 60), by: info.label.by === null ? null : san.label(info.label.by, 40),
      head: withheld ? null : san.label(lines.head, 400),
      outcome: lines.outcome === null ? null : withheld ? (SAFE_OUTCOME.test(lines.outcome) ? lines.outcome : null) : san.label(lines.outcome, MAX_LABEL),
      text: withheld ? null : san.text(info.text, L.max_text_chars), details, withheld: withheld ? 'sensitive_source' : null,
    } as NewItem)
  }

  /** A verified command's details: its measured fields once it ended, and a cut preview of its sealed local output —
   *  the stored log assets only (this project's, kind log, sealed for this execution and stream), read in a bounded
   *  range; never a live log, a remote one, or a process. */
  function actionDetails(run: Run, x: Execution): NonNullable<Extract<ShareItem, { kind: 'action' }>['details']> | null {
    if (!FINAL_EXECUTION.has(x.status) || x.finished_at === null) return null
    const record: Rec = { exit_code: x.exit_code, duration_ms: x.duration_ms, timed_out: x.timed_out, truncated: x.truncated }
    let cut = false
    if (x.target?.kind === 'local') {
      for (const stream of ['stdout', 'stderr'] as const) {
        const id = stream === 'stdout' ? x.stdout_asset_id : x.stderr_asset_id
        if (id === null || !ASSET_ID.test(id)) continue
        const asset = repo.getAsset(state.conn, id)
        const meta = rec(asset?.meta)
        if (asset === null || asset.project_id !== rows.session.project_id || asset.kind !== 'log' || meta.execution_id !== x.id || meta.stream !== stream
          || !(meta.run_id === null || meta.run_id === undefined || meta.run_id === run.id)) continue
        try {
          const page = state.store.readRange(asset.storage_path, 0, PREVIEW_SOURCE_CHARS)
          record[stream] = new TextDecoder('utf-8').decode(page.bytes)
          if (page.total > page.bytes.length) cut = true
        } catch { /* unreadable: no preview of it */ }
      }
    }
    return detailsOf({}, record, cut)
  }

  function directorLabels(turn: DirectorTurn | null, note: DirectorNote | null): { source: string; model: string } {
    const ds = turn ? getDirectorSession(state.conn, turn.director_session_id) : null
    const source = note?.source || ds?.label || ds?.transport || 'director'
    const model = note?.model || turn?.model || ds?.model || ''
    return { source: san.label(source, 60), model: model ? modelLabel(model) : 'director' }
  }

  function directorTurnItem(turn: DirectorTurn): void {
    const note = notesByTurn.get(turn.id) ?? (turn.note_id ? rows.notes.find((n) => n.id === turn.note_id) ?? null : null)
    const labels = directorLabels(turn, note)
    const person = turn.kind === 'user'
    if (!person) omitted.app_notes++
    const question = person ? san.text(turn.envelope?.text ?? turn.input, L.max_text_chars)
      : turn.kind === 'interaction' ? 'oasis-code asked the director about an interaction' : TASK_EVENT_QUESTION
    const answer = note?.answer ?? (turn.status === 'done' && turn.output ? turn.output : null)
    emit({
      kind: 'director_note', run: null, at: turn.created_at, source_label: labels.source, model_label: labels.model, asker: person ? 'person' : 'app',
      question, answer: answer === null ? null : san.text(answer, L.max_text_chars), status_label: TURN_STATUS_LABELS[turn.status] ?? san.label(turn.status, 40),
    } as NewItem)
    // the images the person sent the director with the question (answered, failed or cancelled alike): the session's
    // own attachment assets only, through the same validation; a run or group the words were handed to does not repeat them
    if (person) for (const id of turn.envelope?.attachments ?? []) if (typeof id === 'string') emitImage(null, turn.created_at, 'attachment', id)
  }

  function directorNoteItem(note: DirectorNote): void {
    const labels = directorLabels(null, note)
    const event = note.question.startsWith('oasis-code task event')
    if (event) omitted.app_notes++
    emit({
      kind: 'director_note', run: null, at: note.created_at, source_label: labels.source, model_label: labels.model, asker: event ? 'app' : 'person',
      question: event ? TASK_EVENT_QUESTION : san.text(note.question, L.max_text_chars), answer: san.text(note.answer, L.max_text_chars), status_label: 'Answered',
    } as NewItem)
  }

  /** The opening words of a run, attributed by its origin — or a notice, or nothing (a group's turn: the group says it). */
  function opening(run: Run, c: RunCollab | null, out: Draft[]): void {
    const actor = c?.origin.actor ?? (run.spawned_by === 'wake' ? 'watch' : 'person')
    const request = c?.origin.request ?? 'message'
    if (actor === 'watch' || request === 'wake' || run.spawned_by === 'wake') { out.push({ kind: 'notice', at: run.created_at, code: 'woken_by_watch', text: 'Woken by a watch the agent set' }); omitted.app_notes++; return }
    // an action row is an action item (actionItem): it never reaches here; a row that says it is one but is not read
    // as one says nothing of itself
    if (request === 'action') { omitted.app_notes++; return }
    // a relay's or an interaction's turn: its words are the harness's handover; the group carries the message once
    if ((run.relay_id || run.interaction_id) && request !== 'followup') { omitted.app_notes++; return }
    if (actor === 'scheduler' || actor === 'harness') { omitted.app_notes++; return }
    // the person's words a director handed on unchanged stand once, over the director's turn
    if (saidToDirector.get(run.id) === run.user_text) return
    const text = plainAgentMentions(run.user_text).trim()
    const author = actor === 'director' ? 'director' : actor === 'connector' ? 'connector' : actor === 'agent' ? 'agent' : 'person'
    const label = author === 'director' ? 'Director' : author === 'connector' ? (c?.origin.client || 'Connector')
      : author === 'agent' ? 'Parent agent' : actor === 'ui_task' ? 'Person (surface action)' : 'Person'
    if (text) out.push({ kind: 'message', at: run.created_at, author, author_label: label, source: 'opening', text, steer: null })
    for (const a of imageAttachments(run.attachments)) out.push({ kind: 'image', at: run.created_at, origin: 'attachment', asset_id: a })
  }

  function runItems(run: Run): void {
    const c = collabOf.get(run.id) ?? run.collab ?? null
    const runEvents = rows.events.get(run.id) ?? []
    // the main participant's graph label is the session's CURRENT model (collab_projection labelOf(session.model)): a
    // main run is named by the model that ran it, never by whichever model the session uses now
    const ownLabel = c?.participant_id && c.participant_role !== 'main' ? partLabel.get(c.participant_id) : null
    const assistant = san.label(ownLabel || (findModel(state.config, run.model)?.label ?? run.model) || 'Assistant', 80)
    // a run's drafts are bounded by what the sink can still take (each draft is at least one item)
    const cap = L.max_items - budget.items + 1
    const drafts: Draft[] = []
    opening(run, c, drafts)
    const own = parsed.get(run.id) ?? null
    if (own !== null) fromHistory(own, drafts, cap)
    else fromEvents(runEvents, drafts, cap)
    const results = new Map<string, Rec>()
    const calls = new Map<string, Rec>()
    for (const e of runEvents) {
      if (e.event === 'tool_result' && str(e.data.tool_call_id)) results.set(str(e.data.tool_call_id), e.data)
      if (e.event === 'tool_call' && str(e.data.tool_call_id)) calls.set(str(e.data.tool_call_id), e.data)
      if (e.event === 'ui_surface') omitted.ui_surfaces++
      if (e.event === 'ui_input') omitted.ui_inputs++
    }
    // steers: one record per id (the latest), placed where they were delivered, the rest after the run's items
    const steers = new Map(steersFromEvents(runEvents).map((s) => [s.id, s]))
    const placed = new Set<string>()
    const key = runKey.get(run.id)!
    /** live: the run's handle as taken now (null: not watched) */
    const watched = live?.runs.get(run.id) ?? null
    // every message string is sanitized here, after continuation joining, as it becomes a DTO field
    const emitMessage = (d: MessageDraft) => emit({
      kind: 'message', run: key, at: d.at, author: d.author, source: d.source, text: san.text(d.text, L.max_text_chars),
      author_label: d.author === 'assistant' ? assistant : san.label(d.author_label, 80),
      steer: d.steer === null ? null : { status: d.steer.status, by: d.steer.by, client: d.steer.client, reason: d.steer.reason === null ? null : san.label(d.steer.reason, 120) },
    } as NewItem)
    const emitSteer = (record: SteerRecord | undefined, text: string, at: string | null) => {
      // a group note handed into this run: the note says it, once, as the person's words to the members
      if (record !== undefined && noteSteers.has(record.client_request_id)) { omitted.app_notes++; return }
      const by = record === undefined ? 'unrecorded' : (record.by ?? 'person')
      const client = record?.client ? san.label(record.client, 40) : null
      emitMessage({
        kind: 'message', at, author: by === 'unrecorded' ? 'unattributed' : by, source: 'steer', text: record?.text ?? text,
        author_label: by === 'person' ? 'Person' : by === 'director' ? 'Director' : by === 'connector' ? (client ?? 'Connector') : 'Words sent while it worked',
        steer: { status: record?.status ?? 'delivered', by, client, reason: record?.reason ?? null },
      })
    }
    for (const d of drafts) {
      if (sinkFull) return
      if (d.kind === 'steer_slot') {
        if (placed.has(d.steer_id)) continue
        placed.add(d.steer_id)
        emitSteer(steers.get(d.steer_id), d.text, d.at)
      } else if (d.kind === 'message') emitMessage(d)
      else if (d.kind === 'notice') emit({ kind: 'notice', run: key, at: d.at, code: d.code, text: san.text(d.text, 500) } as NewItem)
      else if (d.kind === 'image') emitImage(key, d.at, d.origin, d.asset_id)
      else emitTool(run, key, d, results.get(d.id) ?? null, calls.get(d.id) ?? {})
    }
    // the answer being written: its completed lines that are proven stable (live/stream_text.ts), through this sanitizer
    if (watched !== null && watched.open_text !== null) {
      const shown = stableOpenText(watched.open_text, sanCtx)
      emit({ kind: 'message_open', run: key, at: null, author: 'assistant', author_label: assistant, text: san.text(shown, L.max_text_chars),
        withheld_tail: shown.length < watched.open_text.length } as unknown as NewItem)
    }
    for (const s of steers.values()) if (!placed.has(s.id)) emitSteer(s, s.text, s.delivered_at ?? s.queued_at)
    if (watched !== null) return
    if (run.status === 'error') emit({ kind: 'notice', run: key, at: run.finished_at, code: 'run_failed', text: run.error ? san.text(run.error, 500) : 'The run failed' } as NewItem)
    if (run.status === 'cancelled') emit({ kind: 'notice', run: key, at: run.finished_at, code: 'run_stopped', text: 'Stopped before it finished' } as NewItem)
  }

  function emitTool(run: Run, key: string, d: ToolDraft, event: Rec | null, call: Rec): void {
    // the event (what the thread showed: status, summary, fields) and the record's return (what the model got: a
    // command's output) are read side by side — only allowlisted fields of either, never the objects themselves
    const record = d.result
    // the record's arguments are the call as made (whole); the event's metadata is a preview (cut at 300 characters):
    // each is classified on its own, so a sensitive part past the preview's cut still withholds the call
    const argsMeta = metadataOf(d.name, d.args)
    const eventMeta = pick(call, TOOL_CALL_METADATA_KEYS[d.name] ?? ['path', 'command', 'cwd', 'url'])
    const meta = { ...argsMeta, ...eventMeta }
    const execId = str(meta.execution_id) || str(event?.execution_id) || str(record?.execution_id)
    const sensitive = (m: Rec) => sensitiveTool(d.name, { path: norm(m.path), command: norm(m.command), cwd: norm(m.cwd), url: norm(m.url) }, dataDirs)
    // detection reads the text as it is exported (NFC, invisible characters out); a command execution the session-wide
    // scan found sensitive is withheld wherever it appears — the call itself and any polling of its output; polling of an
    // execution whose command this session's records do not hold is withheld too
    // live: a call read from its event alone (no record of its arguments) whose metadata may have been cut is withheld
    const cutMeta = live !== null && Object.keys(argsMeta).length === 0 && Object.values(eventMeta).some((v) => typeof v === 'string' && v.length >= EVENT_META_CUT)
    // live: a tool that reads a source (its metadata names a path, command, cwd or url) whose call says none of them —
    // no record, no call event — is withheld: what it read cannot be classified
    const sourceKeys = (TOOL_CALL_METADATA_KEYS[d.name] ?? SOURCE_KEYS).filter((k) => (SOURCE_KEYS as readonly string[]).includes(k))
    const missingMeta = live !== null && sourceKeys.length > 0 && !sourceKeys.some((k) => str(argsMeta[k]) !== '' || str(eventMeta[k]) !== '')
    const withheld = cutMeta || missingMeta || sensitive(argsMeta) || sensitive(eventMeta)
      || (execId !== '' && sensitiveExec.has(execId) && (d.name === 'bash' || POLLING_TOOLS.has(d.name)))
      || (POLLING_TOOLS.has(d.name) && (!execId || !knownExec.has(execId)))
    if (withheld) omitted.sensitive_tool_content++
    const status = san.label(str(event?.status) || d.status || str(record?.status) || (run.status === 'cancelled' ? 'cancelled' : event || record ? 'ok' : isLiveRun(run) ? 'running' : 'unknown'), 40)
    let details: Extract<ShareItem, { kind: 'tool' }>['details'] = null
    if (!withheld && (event || record)) {
      if (req.include_tool_details) details = detailsOf(event ?? {}, record ?? {})
      else omitted.tool_details++
    }
    let target = withheld ? null : targetOf(d.name, meta)
    if (!withheld && d.name === 'present_ui' && status === 'ok') {
      const surfaceId = str(rec(d.args).surface_id) || str(record?.surface_id) || str(event?.surface_id)
      const samples = (state.progressSamples?.get(run.id) ?? []).filter((p) => {
        if (p.surface_id !== surfaceId || excluded.has(p.writer_id) || excluded.has(p.run_id) || p.revision !== (record?.revision ?? event?.revision)) return false
        if (p.execution_id && ((!knownExec.has(p.execution_id) && !progressActionExec.has(p.execution_id)) || sensitiveExec.has(p.execution_id))) return false
        const current = repo.getUiSurface(state.conn, p.session_id, p.run_id, p.surface_id)
        return current?.revision === p.revision && (current.updated_by_run_id ?? current.run_id) === p.writer_id
      })
      if (samples.length) {
        const notSampled = samples.filter((s) => s.availability === 'not_sampled').length
        target = san.text((notSampled ? `${notSampled} sources not sampled; ` : '') + samples.map((s) => {
          const p = s.progress
          const execution = s.execution?.status
          const status = execution && ['failed', 'succeeded', 'cancelled'].includes(execution) ? execution : p.status ?? execution ?? 'unknown'
          const count = p.completed === undefined ? '' : ` · ${p.completed}${p.total === undefined ? '' : ` / ${p.total}`}`
          return `${s.title}: ${status}${count}${p.rate === undefined ? '' : ` · ${p.rate}/s`}${p.eta === undefined || ['succeeded', 'failed', 'cancelled'].includes(status) ? '' : ` · ETA ${p.eta}s`} — progress snapshot ${s.at} (${s.availability})`
        }).join('\n'), 1000)
        if (req.include_tool_details) {
          const logs = samples.flatMap((s) => s.progress.logs).join('\n')
          details = { summary: target, fields: [], preview: san.text(logs, 4000), preview_truncated: logs.length > 4000 || samples.some((s) => s.progress.logsTruncated === true) }
        }
      }
    }
    if (!emit({ kind: 'tool', run: key, at: d.at, name: san.label(d.name, 60), status, target, details, withheld: withheld ? 'sensitive_source' : null } as NewItem)) return
    // the images the call showed: a look's screenshot (its display copy when kept), a generated image
    if (!withheld) for (const img of toolImages(d.name, event ?? {}, record ?? {})) emitImage(key, d.at, img.origin, img.asset_id)
  }

  /** The run's own conversation record as drafts (raw: sanitized when emitted). */
  function fromHistory(own: Rec[], out: Draft[], cap: number): void {
    const calls = new Map<string, ToolDraft>()
    let openingSeen = false
    // the index of the last answer while only app prompts followed it (a continuation joins it), else -1
    let joinable = -1
    const pushAnswer = (text: string, at: string | null) => {
      if (!text) return
      if (joinable >= 0) { (out[joinable] as MessageDraft).text += text; return }
      out.push({ kind: 'message', at, author: 'assistant', author_label: '', source: 'answer', text, steer: null })
      joinable = out.length - 1
    }
    for (const message of own) {
      if (out.length > cap) return
      const parts = (Array.isArray(message.parts) ? message.parts : []).filter(isObj)
      if (message.kind === 'request' && isObj(message.compaction)) {
        omitted.compaction_summaries++
        out.push({ kind: 'notice', at: str(message.compaction.at) || null, code: 'context_compacted', text: 'Earlier context was summarized for the model' })
        joinable = -1
        continue
      }
      if (message.kind === 'request') {
        for (const part of parts) {
          const pk = part.part_kind
          if (pk === 'system-prompt') { omitted.system_prompts++; continue }
          if (pk === 'user-prompt') {
            if (typeof part.steer_id === 'string' && part.steer_id) {
              out.push({ kind: 'steer_slot', at: str(part.timestamp) || null, steer_id: part.steer_id, text: typeof part.content === 'string' ? part.content : '' })
              joinable = -1
              continue
            }
            // the opening words are the run row's (already said); any other prompt is the app's or the harness's
            if (!openingSeen && part.origin !== 'app') { openingSeen = true; joinable = -1; continue }
            omitted.app_notes++
            const said = typeof part.content === 'string' ? part.content : Array.isArray(part.content) ? part.content.filter((x): x is string => typeof x === 'string').join(' ') : ''
            if (!said.includes(CUT_OFF)) joinable = -1
            continue
          }
          if (pk === 'tool-return') {
            const call = calls.get(str(part.tool_call_id))
            const content = rec(part.content)
            if (call) { call.result = content; call.status = str(content.status) || 'ok' }
            if (part.tool_name === 'read_file' && content.kind === 'image') omitted.images_workspace_files++
            joinable = -1
            continue
          }
          if (pk === 'retry-prompt') {
            omitted.retry_prompts++
            const call = calls.get(str(part.tool_call_id))
            if (call) call.status = 'retry'
            joinable = -1
            continue
          }
          omitted.unknown_parts++
        }
        continue
      }
      if (message.kind !== 'response') { omitted.unknown_parts++; continue }
      const at = str(message.timestamp) || null
      let words: Rec[] = []
      const close = () => { if (words.length) pushAnswer(answerText(words as unknown as ResponsePart[]), at); words = [] }
      for (const part of parts) {
        const pk = part.part_kind
        if (pk === 'text') { if (typeof part.content === 'string') words.push(part); continue }
        if (pk === 'thinking') { omitted.thinking++; continue }
        close()
        if (pk === 'tool-call' || pk === 'builtin-tool-call') {
          let args = part.args
          if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = {} } }
          const draft: ToolDraft = { kind: 'tool', at, id: str(part.tool_call_id), name: str(part.tool_name) || 'tool', args: rec(args), result: null, status: null }
          calls.set(draft.id, draft)
          out.push(draft)
          joinable = -1
          continue
        }
        if (pk === 'builtin-tool-return') {
          const call = calls.get(str(part.tool_call_id))
          const r = builtinResult(part as unknown as BuiltinToolReturnPart)
          if (call) { call.result = r; call.status = str(r.status) || 'ok' }
          joinable = -1
          continue
        }
        omitted.unknown_parts++
      }
      close()
    }
  }

  /** A run without a readable record: its persisted events — text blocks (a kept continuation joined), tool calls and
   *  results, and where each steer was delivered (so the words stand before the answer they led to). */
  function fromEvents(events: Ev[], out: Draft[], cap: number): void {
    const calls = new Map<string, ToolDraft>()
    let continued = false
    let lastAnswer = -1
    for (const e of events) {
      if (out.length > cap) return
      const d = e.data
      if (e.event === 'text_block') {
        const text = str(d.text)
        if (!text) continue
        if (continued && lastAnswer >= 0) (out[lastAnswer] as MessageDraft).text += text
        else { out.push({ kind: 'message', at: e.t, author: 'assistant', author_label: '', source: 'answer', text, steer: null }); lastAnswer = out.length - 1 }
        continued = false
      } else if (e.event === 'run_continued') {
        continued = Number(d.kept_chars) > 0
      } else if (e.event === 'thinking_block') {
        omitted.thinking++
      } else if (e.event === 'steer_delivered') {
        const id = str(rec(d.steer).id)
        if (id) { out.push({ kind: 'steer_slot', at: e.t, steer_id: id, text: '' }); lastAnswer = -1 }
      } else if (e.event === 'tool_call') {
        const draft: ToolDraft = { kind: 'tool', at: e.t, id: str(d.tool_call_id), name: str(d.tool) || 'tool', args: {}, result: null, status: null }
        if (draft.id) calls.set(draft.id, draft)
        out.push(draft)
        lastAnswer = -1
      } else if (e.event === 'tool_result') {
        const call = calls.get(str(d.tool_call_id))
        if (call) call.status = str(d.status) || 'ok'
        else out.push({ kind: 'tool', at: e.t, id: str(d.tool_call_id), name: str(d.tool) || 'tool', args: {}, result: null, status: str(d.status) || 'ok' })
        lastAnswer = -1
      } else if (e.event === 'context_compacted') {
        omitted.compaction_summaries++
        out.push({ kind: 'notice', at: e.t, code: 'context_compacted', text: 'Earlier context was summarized for the model' })
        lastAnswer = -1
      }
    }
  }

  /** The allowlisted metadata of a call's arguments (the same keys its tool_call event keeps). */
  function metadataOf(tool: string, args: Rec): Rec {
    // a tool the contract does not list (an MCP server's) is read for the keys that say what it touched
    return pick(args, TOOL_CALL_METADATA_KEYS[tool] ?? ['path', 'command', 'cwd', 'url'])
  }

  /** What a call worked on, as one sanitized line. */
  function targetOf(tool: string, meta: Rec): string | null {
    const url = (v: unknown) => { const s = str(v); if (!s) return ''; try { const u = new URL(s); return `${u.protocol}//${u.host}${u.pathname}` } catch { return s.split(/[?#]/)[0]! } }
    let t = ''
    if (str(meta.path)) t = str(meta.path)
    else if (str(meta.command)) t = str(meta.command).split(/\r?\n/)[0]!
    else if (str(meta.query)) t = str(meta.query)
    else if (str(meta.url)) t = url(meta.url)
    else if (tool.startsWith('computer_')) t = [str(meta.action) || str(meta.surface), url(meta.url)].filter(Boolean).join(' ')
    else if (str(meta.title)) t = str(meta.title)
    else if (str(meta.prompt)) t = str(meta.prompt)
    else if (str(meta.kind)) t = str(meta.kind)
    return t ? san.label(t, MAX_LABEL) : null
  }

  /** A tool's details: allowlisted scalar fields (the event's first, then the record's), the event's short summary, and
   *  a cut PREVIEW of the output strings (the event's when it kept any, else the record's return). */
  function detailsOf(event: Rec, record: Rec, sourceCut = false): NonNullable<Extract<ShareItem, { kind: 'tool' }>['details']> {
    const fields: { name: string; value: string | number | boolean }[] = []
    for (const k of DETAIL_FIELDS) {
      const v = event[k] !== undefined && event[k] !== null && event[k] !== '' ? event[k] : record[k]
      if (typeof v === 'number' && Number.isFinite(v)) fields.push({ name: k, value: v })
      else if (typeof v === 'boolean') fields.push({ name: k, value: v })
      else if (typeof v === 'string' && v) fields.push({ name: k, value: san.label(v, 80) })
    }
    const summary = str(event.summary) ? san.label(str(event.summary), 200) : null
    const previewOf = (r: Rec): string => {
      const pieces: string[] = []
      for (const k of PREVIEW_FIELDS) { const v = r[k]; if (typeof v === 'string' && v.trim()) pieces.push(k === 'stdout' ? v : `[${k}]\n${v}`) }
      if (Array.isArray(r.urls)) pieces.push((r.urls as unknown[]).slice(0, 10).map((u) => str(u).split(/[?#]/)[0]).filter(Boolean).join('\n'))
      return pieces.join('\n')
    }
    const raw = previewOf(event) || previewOf(record)
    if (!raw) return { summary, fields, preview: null, preview_truncated: sourceCut }
    // sanitized whole (within a bound far past the cut), then cut: a masked value never straddles the cut
    const cleaned = san.text(raw.length > PREVIEW_SOURCE_CHARS ? raw.slice(0, PREVIEW_SOURCE_CHARS) : raw)
    const cut = sourceCut || cleaned.length > L.max_tool_preview_chars || raw.length > PREVIEW_SOURCE_CHARS
    return { summary, fields, preview: cut ? cleaned.slice(0, L.max_tool_preview_chars) : cleaned, preview_truncated: cut }
  }

  // ---- V3 / live v2: the Agent Teams card, the faces, the rail's bots (share/team.ts) -----------------------------------
  let extra: ProjectedExtra | undefined
  if (extras !== null) {
    const projected = projectTeam({
      conn: state.conn, session_id: rows.session.id, runs: rows.runs, graph: rows.graph, relays: rows.relays, interactions: rows.interactions, excluded,
      runKey: (id) => (runKey.has(id) && !excluded.has(id) ? runKey.get(id)! : null),
      statusOf: (r) => (live !== null ? liveStatus(r) : r.status), label: (t, max) => san.label(t, max), modelLabel: (m) => modelLabel(m), rowKeys: extras.rowKeys,
    })
    extra = { ...projected, runKey, excluded }
  }

  // ---- the answer -------------------------------------------------------------------------------------------------------
  if (live !== null) {
    const title = san.label(rows.session.title, 200) || 'Session'
    const sessionModel = modelLabel(rows.session.model)
    const stats: ShareStats = { omitted, redacted: { ...san.redacted }, truncated_fields: san.truncated, items_truncated: sinkFull }
    const active = live.runs.size > 0 || activeInRecords(state.conn, rows.session.id).length > 0
    const snapshot = {
      format: LIVE_SHARE_FORMAT, version: LIVE_SHARE_VERSION, generated_at: now().toISOString(), title,
      session: { created_at: rows.session.created_at, last_activity_at: rows.session.last_activity_at ?? null, model_label: sessionModel, active },
      options: { include_tool_details: req.include_tool_details, include_images: req.include_images },
      participants, runs, items, images: liveRefs, stats, limits: { ...L },
    } as unknown as LiveSnapshot
    return { snapshot, images: liveImages, ...(extra ? { extra } : {}) }
  }
  const selection = { runs: rows.runs.map((r) => ({ run_id: r.id, key: runKey.get(r.id)!, label: san.label(r.label || `${modelLabel(r.model)} · ${r.created_at.slice(0, 16).replace('T', ' ')}`, 120), status: runStatus(r) })) }
  const title = san.label(rows.session.title, 200) || 'Session'
  const sessionModel = modelLabel(rows.session.model)
  // the statistics are read after the last string was sanitized
  const stats: ShareStats = { omitted, redacted: { ...san.redacted }, truncated_fields: san.truncated, items_truncated: sinkFull }
  const snapshot = {
    format: SHARE_FORMAT, version: SHARE_VERSION, generated_at: now().toISOString(), title,
    session: { created_at: rows.session.created_at, last_activity_at: rows.session.last_activity_at ?? null, model_label: sessionModel },
    options: { include_tool_details: req.include_tool_details, include_images: req.include_images },
    participants, runs, items, images, stats, limits: { ...L },
  }
  // live is null here: every run's status is runStatus's (done, cancelled, error); the route checks the strict V2 schema
  return { snapshot, selection, ...(extra ? { extra } : {}) } as ShareSnapshotResponse & { extra?: ProjectedExtra }
}

function pick(source: Rec, keys: readonly string[]): Rec {
  const out: Rec = {}
  for (const k of keys) {
    const v = source[k]
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }
  return out
}

/** The image asset ids of a list of attachments (images only: text, PDF and video references are never exported). */
function imageAttachments(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const a of list) {
    if (!isObj(a) || typeof a.asset_id !== 'string' || a.file_kind !== undefined || a.representation !== undefined) continue
    if ((IMAGE_MEDIA_TYPES as readonly string[]).includes(str(a.media_type))) out.push(a.asset_id)
  }
  return out
}

/** The images a tool call showed: a computer look's screenshot (the display copy when kept), generate_image's image. */
function toolImages(tool: string, event: Rec, record: Rec): { origin: 'screenshot' | 'generated'; asset_id: string }[] {
  if (tool === 'generate_image') {
    const shown = Array.isArray(event.shown) ? (event.shown as unknown[]).map(rec).map((s) => str(s.asset_id)).filter(Boolean) : []
    const id = shown[0] || (str(record.status) === 'ok' ? str(record.asset_id) : '')
    return id ? [{ origin: 'generated', asset_id: id }] : []
  }
  if (tool.startsWith('computer_')) {
    const id = str(event.screenshot_display_asset_id) || str(record.screenshot_display_asset_id) || str(event.screenshot_asset_id) || str(rec(record.screenshot).asset_id)
    return id ? [{ origin: 'screenshot', asset_id: id }] : []
  }
  return []
}

/** The characters of every string an item carries (its text, labels, targets, details, notices): what the total text
 *  budget bounds. Image bytes are not items' strings; they are bounded by the image limits. */
function textSize(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) { let n = 0; for (const v of value) n += textSize(v); return n }
  if (value !== null && typeof value === 'object') { let n = 0; for (const v of Object.values(value)) n += textSize(v); return n }
  return 0
}
