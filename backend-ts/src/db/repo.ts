/** Row access. Every write goes through here; JSON columns are decoded into the models on the way out. */

import type {
  Approval, Asset, Budget, CheckResult, Checkpoint, DirectorNote, Execution, Grants, Attachment, Interaction, InteractionEvent, InteractionNode, InteractionNote,
  InteractionParticipant, ModelRequestRecord, Project, Relay, RelayParticipant, RelayStep, Run, Session, SessionRoot, Snapshot, Workspace,
  SessionTitleSource, WakeEvent, Watch, WatchSpec, WatchStatus, JournalEntry, UiState, UiSurfaceRecord,
  UiInputClosedReason, UiInputRecord, UiInputStatus, UiTaskError, UiTaskRecord, UiTaskStatus,
} from '@oasis-code/contract'
import { THREAD_SPAWNERS, RemoteWorkspaceBindingSchema, type RemoteWorkspaceBinding } from '@oasis-code/contract'
import { accessOf, LEGACY_ACCESS_MODE, type AccessMode } from '@oasis-code/contract/modes'
import { writeHistoryProjection } from './history_projection.ts'
import { newId } from '../ids.ts'
import { budgetLines, parseBudget, parseGrants } from '../models.ts'
import { nowIso } from '../timebase.ts'
import type { Conn, Param, Row } from './database.ts'

export type { Conn }

function j(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function d<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || !text) return fallback
  try { return JSON.parse(text) as T } catch { return fallback }
}

const s = (v: unknown): string => String(v)
const sn = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const n = (v: unknown): number => Number(v)
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const b = (v: unknown): boolean => Boolean(Number(v))

// -- projects ---------------------------------------------------------------

function remoteFields(row: Row): Pick<Project, 'target' | 'remote'> {
  if (row.target_id == null) {
    if (row.remote_binding_json != null) throw new Error('remote binding without a target; local fallback refused')
    return { target: { kind: 'local' }, remote: null }
  }
  const binding = RemoteWorkspaceBindingSchema.parse(d(row.remote_binding_json, null))
  if (binding.target_id !== row.target_id) throw new Error('remote binding target mismatch; local fallback refused')
  return { target: { kind: 'ssh', target_id: String(row.target_id) }, remote: binding }
}

function project(row: Row): Project {
  return {
    ...remoteFields(row),
    id: s(row.id), name: s(row.name), kind: (row.kind === 'attached' || row.kind === 'direct' ? row.kind : 'snapshot'), source_path: sn(row.source_path), base_repo_path: s(row.base_repo_path),
    base_commit: sn(row.base_commit), base_branch: sn(row.base_branch), import_report: d(row.import_report_json, {}),
    default_model: sn(row.default_model), config: d(row.config_json, {}), created_at: s(row.created_at), updated_at: s(row.updated_at),
    last_activity_at: activityOf(row.session_activity, row.created_at),
  }
}

/** Folder activity is derived on every read: a pinned session keeps its own activity but contributes none here.
 *  Pin/unpin immediately changes the aggregate, including activity from before pinning; no backfill is needed.
 *  Archived sessions participate as before (only open sessions can be pinned); deleted sessions never do. */
const PROJECT_ROW = "SELECT p.*, (SELECT MAX(s.last_activity_at) FROM sessions s WHERE s.project_id=p.id AND s.status<>'deleted' AND NOT (s.status='open' AND s.pin_order IS NOT NULL AND s.pin_order>0)) AS session_activity FROM projects p"

export function createProject(conn: Conn, name: string, opts: {
  source_path: string | null; base_repo_path: string; base_commit: string | null; base_branch: string | null;
  import_report: Record<string, unknown>; default_model?: string | null; config?: Record<string, unknown> | null; id?: string
  kind?: 'snapshot' | 'attached' | 'direct'; remote?: RemoteWorkspaceBinding | null
}): Project {
  const pid = opts.id ?? newId('p')
  const t = nowIso()
  conn.run(
    'INSERT INTO projects (id, name, source_path, base_repo_path, base_commit, base_branch, import_report_json,'
    + ' default_model, config_json, created_at, updated_at, kind, target_id, remote_binding_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [pid, name, opts.source_path, opts.base_repo_path, opts.base_commit, opts.base_branch, j(opts.import_report),
      opts.default_model ?? null, j(opts.config ?? {}), t, t, opts.kind ?? 'snapshot', opts.remote?.target_id ?? null, opts.remote ? j(RemoteWorkspaceBindingSchema.parse(opts.remote)) : null])
  return getProject(conn, pid)!
}

export function getProject(conn: Conn, projectId: string): Project | null {
  const row = conn.get(`${PROJECT_ROW} WHERE p.id=?`, [projectId])
  return row ? project(row) : null
}

/** The projects, the latest activity first (their sessions', else their making); equal times by the later made, then id. */
export function listProjects(conn: Conn): Project[] {
  return conn.all(`${PROJECT_ROW} ORDER BY MAX(p.created_at, COALESCE(session_activity, '')) DESC, p.created_at DESC, p.id DESC`).map(project)
}

export function touchProject(conn: Conn, projectId: string): void {
  conn.run('UPDATE projects SET updated_at=? WHERE id=?', [nowIso(), projectId])
}

export function updateProject(conn: Conn, projectId: string, opts: {
  base_commit?: string | null; config?: Record<string, unknown> | null; default_model?: string | null
}): void {
  if (opts.base_commit != null) conn.run('UPDATE projects SET base_commit=? WHERE id=?', [opts.base_commit, projectId])
  if (opts.config != null) conn.run('UPDATE projects SET config_json=? WHERE id=?', [j(opts.config), projectId])
  if (opts.default_model != null) conn.run('UPDATE projects SET default_model=? WHERE id=?', [opts.default_model, projectId])
  touchProject(conn, projectId)
}

// -- sessions ---------------------------------------------------------------

function titleSourceOf(value: unknown): SessionTitleSource {
  return value === 'director' || value === 'person' ? value : 'auto'
}

function session(row: Row, roots: SessionRoot[] = []): Session {
  return {
    id: s(row.id), project_id: s(row.project_id), title: s(row.title), title_source: titleSourceOf(row.title_source), workspace_id: sn(row.workspace_id), model: s(row.model),
    grants: parseGrants(d(row.grants_json, {})), access_mode: accessOf(row.access_mode), task_root_id: sn(row.task_root_id ?? null), roots,
    status: s(row.status), created_at: s(row.created_at), updated_at: s(row.updated_at),
    last_activity_at: activityOf(row.last_activity_at, row.created_at),
    pin_order: row.pin_order == null ? null : Number(row.pin_order),
  }
}

/** A session row with its roots (schema v29), read beside it. */
function sessionWithRoots(conn: Conn, row: Row): Session {
  return session(row, listSessionRoots(conn, s(row.id)).map((r) => ({ path: r.path, access: r.access })))
}

// -- session roots and tasks (schema v29) -------------------------------------

/** A session's roots, by path. */
export function listSessionRoots(conn: Conn, sessionId: string): (SessionRoot & { created_at: string })[] {
  return conn.all('SELECT path, access, created_at FROM session_roots WHERE session_id=? ORDER BY path', [sessionId])
    .map((r) => ({ path: s(r.path), access: r.access === 'write' ? 'write' as const : 'read' as const, created_at: s(r.created_at) }))
}

/** A session's roots replaced whole (validated by the caller: api/roots.ts); in the caller's transaction when it holds one. */
export function setSessionRoots(conn: Conn, sessionId: string, roots: readonly SessionRoot[]): void {
  const t = nowIso()
  const kept = new Map(listSessionRoots(conn, sessionId).map((r) => [`${r.path}\u0000${r.access}`, r.created_at]))
  conn.run('DELETE FROM session_roots WHERE session_id=?', [sessionId])
  for (const root of roots) {
    conn.run('INSERT INTO session_roots (session_id, path, access, created_at) VALUES (?,?,?,?)', [sessionId, root.path, root.access, kept.get(`${root.path}\u0000${root.access}`) ?? t])
  }
  conn.run('UPDATE sessions SET updated_at=? WHERE id=?', [t, sessionId])
}

/** The task a session joins: the first session of `taskSession`'s task (its own id when it is that first). */
export function setSessionTask(conn: Conn, sessionId: string, taskRootId: string): void {
  conn.run('UPDATE sessions SET task_root_id=?, updated_at=? WHERE id=?', [taskRootId, nowIso(), sessionId])
}

/** Every session (not deleted) of a task, by its first session's id — that one included — oldest first. */
export function sessionsOfTask(conn: Conn, taskRootId: string): Session[] {
  return conn.all(`SELECT * FROM sessions WHERE status<>'${DELETED_SESSION}' AND (id=? OR task_root_id=?) ORDER BY created_at, rowid`, [taskRootId, taskRootId]).map((r) => sessionWithRoots(conn, r))
}

/** The stored activity time, else (a row no activity reached yet) the time the row was made. */
function activityOf(stored: unknown, created: unknown): string {
  return typeof stored === 'string' && stored !== '' ? stored : s(created)
}

/** A session row. `access` is where its commands run; a caller that names none gets the sandbox — the least access,
 *  and what every session had before access modes existed (an internal path, an older caller). The product's own
 *  entry points choose the product default (DEFAULT_ACCESS_MODE, full) themselves: api/sessions.ts. */
export function createSession(conn: Conn, projectId: string, title: string, model: string, grants?: Grants, access: AccessMode = LEGACY_ACCESS_MODE): Session {
  const sid = newId('s')
  const t = nowIso()
  conn.run('INSERT INTO sessions (id, project_id, title, workspace_id, model, grants_json, status, created_at, updated_at, last_activity_at, access_mode)'
    + ' VALUES (?,?,?,?,?,?,?,?,?,?,?)', [sid, projectId, title, null, model, j(grants ?? parseGrants({})), 'open', t, t, t, accessOf(access)])
  touchProject(conn, projectId)
  return getSession(conn, sid)!
}

/** The project a request with this key made, if any. */
export function projectForClientRequest(conn: Conn, clientRequestId: string): Project | null {
  const row = conn.get('SELECT id FROM projects WHERE client_request_id=?', [clientRequestId])
  return row ? getProject(conn, String(row.id)) : null
}

export function setProjectClientRequest(conn: Conn, projectId: string, clientRequestId: string): void {
  conn.run('UPDATE projects SET client_request_id=? WHERE id=?', [clientRequestId, projectId])
}

/** The session a request with this key made in the project, if any. */
export function sessionForClientRequest(conn: Conn, projectId: string, clientRequestId: string): Session | null {
  const row = conn.get('SELECT id FROM sessions WHERE project_id=? AND client_request_id=?', [projectId, clientRequestId])
  return row ? getSession(conn, String(row.id)) : null
}

export function setSessionClientRequest(conn: Conn, sessionId: string, clientRequestId: string): void {
  conn.run('UPDATE sessions SET client_request_id=? WHERE id=?', [clientRequestId, sessionId])
}

/** The run a chat with this key already started in the session, if any. */
export function runForClientRequest(conn: Conn, sessionId: string, clientRequestId: string): Run | null {
  const row = conn.get(`SELECT ${RUN_COLUMNS} FROM runs WHERE session_id=? AND client_request_id=?`, [sessionId, clientRequestId])
  return row ? run(row) : null
}

export function getSession(conn: Conn, sessionId: string): Session | null {
  const row = conn.get('SELECT * FROM sessions WHERE id=?', [sessionId])
  return row ? sessionWithRoots(conn, row) : null
}

/** A deleted session's status: out of every list and of the API; its rows stay, so nothing that points at it breaks. */
export const DELETED_SESSION = 'deleted'

/** A project's sessions, the latest activity first (schema v27: `last_activity_at`, never `updated_at`, which a rename,
 *  a setting or a restart's recovery moves); equal times by the later made, then by id — the same order every time. */
export function listSessions(conn: Conn, projectId: string): Session[] {
  return conn.all('SELECT * FROM sessions WHERE project_id=? AND status<>? ORDER BY last_activity_at DESC, created_at DESC, id DESC', [projectId, DELETED_SESSION]).map((r) => sessionWithRoots(conn, r))
}

/** The person names a session: theirs from then on (a director's title never replaces it). */
export function renameSession(conn: Conn, sessionId: string, title: string): void {
  conn.run("UPDATE sessions SET title=?, title_source='person', updated_at=? WHERE id=?", [title, nowIso(), sessionId])
}

/** A director's title for a session still named from its first words; whether it took (the person's own name, or
 *  a director's given before, stays). */
export function titleSessionByDirector(conn: Conn, sessionId: string, title: string): boolean {
  return conn.run("UPDATE sessions SET title=?, title_source='director', updated_at=? WHERE id=? AND title_source='auto'", [title, nowIso(), sessionId]).changes > 0
}

/** A single SQLite write allocates the next free append position under the write lock. Repeating a Pin keeps its
 *  position; Unpin followed by Pin appends. Neither timestamp changes, including for older clients' sorting. */
export function setSessionPinned(conn: Conn, sessionId: string, pinned: boolean): void {
  if (pinned) {
    conn.run(`UPDATE sessions SET pin_order=(SELECT COALESCE(MAX(pin_order), 0)+1 FROM sessions)
      WHERE id=? AND status='open' AND pin_order IS NULL`, [sessionId])
  } else {
    conn.run('UPDATE sessions SET pin_order=NULL WHERE id=? AND pin_order IS NOT NULL', [sessionId])
  }
}

export function deleteSession(conn: Conn, sessionId: string): void {
  conn.run('UPDATE sessions SET status=?, updated_at=? WHERE id=?', [DELETED_SESSION, nowIso(), sessionId])
}

export function setSessionWorkspace(conn: Conn, sessionId: string, workspaceId: string): void {
  conn.run('UPDATE sessions SET workspace_id=?, updated_at=? WHERE id=?', [workspaceId, nowIso(), sessionId])
}

/** The sessions (not deleted) that work in a workspace: its own and every one whose workspace it is (a folder edited
 *  in place is one workspace, shared by its project's sessions). */
export function sessionsOfWorkspace(conn: Conn, workspaceId: string): Session[] {
  return conn.all(`SELECT * FROM sessions WHERE status<>'${DELETED_SESSION}' AND (workspace_id=? OR id=(SELECT session_id FROM workspaces WHERE id=?)) ORDER BY created_at, rowid`, [workspaceId, workspaceId]).map((r) => sessionWithRoots(conn, r))
}

export function setSessionAccess(conn: Conn, sessionId: string, access: AccessMode): void {
  conn.run('UPDATE sessions SET access_mode=?, updated_at=? WHERE id=?', [accessOf(access), nowIso(), sessionId])
}

/** The access cap of a run, a relay or an interaction (schema v28, table access_caps): 'sandbox', or null for none. A
 *  stored cap this build cannot read is the sandbox (fail closed). */
type CapSubject = 'run' | 'relay' | 'interaction'
function capOf(conn: Conn, kind: CapSubject, id: string): AccessMode | null {
  const row = conn.get('SELECT cap FROM access_caps WHERE subject_kind=? AND subject_id=?', [kind, id])
  return row ? 'sandbox' : null
}
function setCap(conn: Conn, kind: CapSubject, id: string, cap: AccessMode | null | undefined): void {
  if (cap !== 'sandbox') return
  conn.run('INSERT OR REPLACE INTO access_caps (subject_kind, subject_id, cap, created_at) VALUES (?,?,?,?)', [kind, id, 'sandbox', nowIso()])
}
export function runAccessCap(conn: Conn, runId: string): AccessMode | null { return capOf(conn, 'run', runId) }
export function relayAccessCap(conn: Conn, relayId: string): AccessMode | null { return capOf(conn, 'relay', relayId) }
export function interactionAccessCap(conn: Conn, interactionId: string): AccessMode | null { return capOf(conn, 'interaction', interactionId) }

export function setSessionGrants(conn: Conn, sessionId: string, grants: Grants): void {
  conn.run('UPDATE sessions SET grants_json=?, updated_at=? WHERE id=?', [j(grants), nowIso(), sessionId])
}

export function setSessionModel(conn: Conn, sessionId: string, model: string): void {
  conn.run('UPDATE sessions SET model=?, updated_at=? WHERE id=?', [model, nowIso(), sessionId])
}

/** Something happened in the session that the person counts as its activity (schema v27): a run started or finished,
 *  a message to agents in turn or to a group, words sent to a run, to a group, to its director, the director's answer.
 *  `at` is when it happened; the time only moves forward, and a deleted session takes none. A restart's recovery (a run
 *  marked lost, a relay or interaction interrupted, a director turn failed or re-armed) never calls this: what it
 *  writes is no one's activity. */
export function noteSessionActivity(conn: Conn, sessionId: string, at: string): void {
  conn.run('UPDATE sessions SET last_activity_at=? WHERE id=? AND status<>? AND last_activity_at<?', [at, sessionId, DELETED_SESSION, at])
}

/** schema v27's backfill: each session's latest activity from what its rows already hold — the runs it started, the
 *  runs that finished (not the finish a restart wrote for a run it found lost, nor a cancel by the harness shutting
 *  down — receipt.interrupted; a receipt from before that mark was kept cannot tell, and counts), the messages to
 *  agents in turn and to groups, the words sent to its runs and its groups, the calls to its director and their
 *  answers (not the answers to the harness's own task reports). Never earlier than the session's own making; never
 *  moves a time back (running it again changes nothing). */
export function backfillSessionActivity(conn: Conn): number {
  const latest = conn.run(`WITH activity(session_id, at) AS (
      SELECT session_id, created_at FROM runs
      UNION ALL SELECT session_id, finished_at FROM runs WHERE finished_at IS NOT NULL AND (error IS NULL OR error<>?)
        AND COALESCE(CASE WHEN json_valid(receipt_json) THEN json_extract(receipt_json, '$.interrupted') END, 0) <> 1
      UNION ALL SELECT session_id, created_at FROM relays
      UNION ALL SELECT session_id, created_at FROM interactions
      UNION ALL SELECT r.session_id, e.created_at FROM run_events e JOIN runs r ON r.id=e.run_id WHERE e.event='steer_queued'
      UNION ALL SELECT i.session_id, n.created_at FROM interaction_notes n JOIN interactions i ON i.id=n.interaction_id
      UNION ALL SELECT session_id, created_at FROM director_turns WHERE kind='user'
      UNION ALL SELECT n.session_id, n.created_at FROM director_notes n LEFT JOIN director_turns t ON t.id=n.turn_id WHERE n.turn_id IS NULL OR t.kind='user'
    ), latest(session_id, at) AS (SELECT session_id, MAX(at) FROM activity GROUP BY session_id)
    UPDATE sessions SET last_activity_at=MAX(sessions.created_at, latest.at) FROM latest
    WHERE latest.session_id=sessions.id AND sessions.last_activity_at < MAX(sessions.created_at, latest.at)`, [LOST_RUN_ERROR]).changes
  return latest + conn.run("UPDATE sessions SET last_activity_at=created_at WHERE last_activity_at < created_at").changes
}

export function touchSession(conn: Conn, sessionId: string): void {
  const row = conn.get('SELECT project_id FROM sessions WHERE id=?', [sessionId])
  conn.run('UPDATE sessions SET updated_at=? WHERE id=?', [nowIso(), sessionId])
  if (row) touchProject(conn, s(row.project_id))
}

// -- director notes ---------------------------------------------------------

function directorNote(row: Row): DirectorNote {
  return {
    id: s(row.id), session_id: s(row.session_id), source: s(row.source), model: s(row.model), question: s(row.question),
    answer: s(row.answer), turn_id: sn(row.turn_id), created_at: s(row.created_at),
  }
}

export function insertDirectorNote(conn: Conn, sessionId: string, opts: { source: string; model: string; question: string; answer: string; turn_id?: string | null }): DirectorNote {
  const nid = newId('note')
  conn.run('INSERT INTO director_notes (id, session_id, source, model, question, answer, created_at, turn_id) VALUES (?,?,?,?,?,?,?,?)',
    [nid, sessionId, opts.source, opts.model, opts.question, opts.answer, nowIso(), opts.turn_id ?? null])
  touchSession(conn, sessionId)
  // the director's answer to the person's call, or a note a director mirrored itself; an answer to the harness's own
  // task report (a turn the director was handed, after a restart too) is no one's activity
  const note = directorNote(conn.get('SELECT * FROM director_notes WHERE id=?', [nid])!)
  const kind = note.turn_id ? conn.get('SELECT kind FROM director_turns WHERE id=?', [note.turn_id])?.kind : 'user'
  if (kind === 'user') noteSessionActivity(conn, sessionId, note.created_at)
  return note
}

export function listDirectorNotes(conn: Conn, sessionId: string): DirectorNote[] {
  return conn.all('SELECT * FROM director_notes WHERE session_id=? ORDER BY created_at, id', [sessionId]).map(directorNote)
}

// -- workspaces -------------------------------------------------------------

function workspace(row: Row): Workspace {
  return {
    ...remoteFields(row),
    id: s(row.id), project_id: s(row.project_id), session_id: sn(row.session_id), path: s(row.path), branch: s(row.branch),
    base_commit: s(row.base_commit), kind: s(row.kind), created_at: s(row.created_at), source_mount: d(row.source_mount_json, null),
  }
}

export function workspacesOfSession(conn: Conn, sessionId: string): Workspace[] {
  return conn.all('SELECT * FROM workspaces WHERE session_id=? ORDER BY created_at', [sessionId]).map(workspace)
}

export function insertWorkspace(conn: Conn, wsId: string, projectId: string, sessionId: string | null, path: string, branch: string,
  baseCommit: string, kind = 'task', sourceMount: Workspace['source_mount'] = null, remote: RemoteWorkspaceBinding | null = null): Workspace {
  const projectTarget = conn.get('SELECT target_id FROM projects WHERE id=?', [projectId])?.target_id ?? null
  if (projectTarget !== (remote?.target_id ?? null)) throw new Error('workspace target differs from its project; local fallback refused')
  if (remote && (kind !== 'direct' || sourceMount || path !== remote.path)) throw new Error('remote workspaces must be direct and bound to their recorded root')
  conn.run('INSERT INTO workspaces (id, project_id, session_id, path, branch, base_commit, kind, created_at, source_mount_json, target_id, remote_binding_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [wsId, projectId, sessionId, path, branch, baseCommit, kind, nowIso(), sourceMount ? j(sourceMount) : null, remote?.target_id ?? null, remote ? j(RemoteWorkspaceBindingSchema.parse(remote)) : null])
  return getWorkspace(conn, wsId)!
}

export function getWorkspace(conn: Conn, wsId: string): Workspace | null {
  const row = conn.get('SELECT * FROM workspaces WHERE id=?', [wsId])
  return row ? workspace(row) : null
}

export function listWorkspaces(conn: Conn, projectId: string): Workspace[] {
  return conn.all('SELECT * FROM workspaces WHERE project_id=? ORDER BY created_at', [projectId]).map(workspace)
}

// -- runs -------------------------------------------------------------------

function run(row: Row): Run {
  return {
    id: s(row.id), session_id: s(row.session_id), project_id: s(row.project_id), workspace_id: sn(row.workspace_id),
    parent_run_id: sn(row.parent_run_id), resumes_run_id: sn(row.resumes_run_id), spawned_by: s(row.spawned_by), label: sn(row.label),
    model: s(row.model), model_config_snapshot: d(row.model_config_json, {}), user_text: s(row.user_text),
    status: s(row.status) as Run['status'], usage: d(row.usage_json, {}), manifest: d(row.manifest_json, {}),
    budget: parseBudget(d(row.budget_json, {})), receipt: d(row.receipt_json, {}), error: sn(row.error), created_at: s(row.created_at),
    finished_at: sn(row.finished_at), saved_seq: n(row.saved_seq), work_order: d<Record<string, unknown> | null>(row.work_order_json, null),
    attachments: d<Run['attachments']>(row.attachments_json, []),
    relay_id: sn(row.relay_id), relay_step: nn(row.relay_step),
    interaction_id: sn(row.interaction_id), interaction_node: sn(row.interaction_node),
  }
}

/** The columns a run row is read with: every column of runs but history_json, which `run` never reads (a conversation's
 *  history, megabytes for a long one, is read by getRunHistory alone). RUN_COLUMNS_R names them of the alias `r`. */
const RUN_COLUMN_NAMES = [
  'id', 'session_id', 'project_id', 'workspace_id', 'parent_run_id', 'resumes_run_id', 'spawned_by', 'label', 'model',
  'model_config_json', 'user_text', 'status', 'usage_json', 'manifest_json', 'budget_json', 'receipt_json', 'error',
  'created_at', 'finished_at', 'saved_seq', 'work_order_json', 'attachments_json', 'client_request_id', 'relay_id',
  'relay_step', 'interaction_id', 'interaction_node',
] as const
export const RUN_COLUMNS = RUN_COLUMN_NAMES.join(', ')
export const RUN_COLUMNS_R = RUN_COLUMN_NAMES.map((c) => `r.${c}`).join(', ')

export function insertRun(conn: Conn, opts: {
  /** the run's id when the caller made it beforehand (schema v25: its participant and edges name it before the row) */
  id?: string
  session_id: string; project_id: string; workspace_id: string | null; model: string; model_config: Record<string, unknown>;
  user_text: string; status: string; budget: Budget; parent_run_id?: string | null; resumes_run_id?: string | null; spawned_by?: string;
  label?: string | null; work_order?: Record<string, unknown> | null
  attachments?: Run['attachments']
  client_request_id?: string | null
  relay_id?: string | null
  relay_step?: number | null
  interaction_id?: string | null
  interaction_node?: string | null
  /** schema v25: who the run belongs to, why it started, where it is shown, what a keyed dispatch asked for */
  participant_id?: string | null
  conversation_id?: string | null
  origin?: Record<string, unknown> | null
  placement?: Record<string, unknown> | null
  intent_sha?: string | null
  /** schema v28: the access cap the run holds ('sandbox': its commands never run with full access) */
  access_cap?: AccessMode | null
}): Run {
  const rid = opts.id ?? newId('run')
  conn.run(
    'INSERT INTO runs (id, session_id, project_id, workspace_id, parent_run_id, resumes_run_id, spawned_by, label,'
    + ' model, model_config_json, user_text, status, budget_json, created_at, work_order_json,'
    + ' attachments_json, client_request_id, relay_id, relay_step, interaction_id, interaction_node) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [rid, opts.session_id, opts.project_id, opts.workspace_id, opts.parent_run_id ?? null, opts.resumes_run_id ?? null,
      opts.spawned_by ?? 'human', opts.label ?? null, opts.model, j(opts.model_config), opts.user_text, opts.status,
      j(budgetLines(opts.budget)), nowIso(), opts.work_order != null ? j(opts.work_order) : null,
      j(opts.attachments ?? []), opts.client_request_id ?? null, opts.relay_id ?? null, opts.relay_step ?? null, opts.interaction_id ?? null, opts.interaction_node ?? null])
  setCap(conn, 'run', rid, opts.access_cap)
  if (opts.participant_id && opts.conversation_id && opts.origin && opts.placement) {
    conn.run('INSERT INTO run_collab (run_id, session_id, participant_id, conversation_id, origin_json, placement_json, intent_sha, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [rid, opts.session_id, opts.participant_id, opts.conversation_id, j(opts.origin), j(opts.placement), opts.intent_sha ?? null, nowIso()])
  }
  touchSession(conn, opts.session_id)
  const made = getRun(conn, rid)!
  noteSessionActivity(conn, opts.session_id, made.created_at)
  return made
}

export function getRun(conn: Conn, runId: string): Run | null {
  const row = conn.get(`SELECT ${RUN_COLUMNS} FROM runs WHERE id=?`, [runId])
  return row ? run(row) : null
}

/** The transcript route needs no receipt, manifest, budget or usage. These columns precede history_json in the
 * stored row, so reading them does not walk a long conversation's overflow chain to reach later columns. */
export function getTranscriptRun(conn: Conn, runId: string): Pick<Run, 'id' | 'session_id' | 'resumes_run_id' | 'model' | 'status'> | null {
  const row = conn.get('SELECT id, session_id, resumes_run_id, model, status FROM runs WHERE id=?', [runId])
  return row ? { id: s(row.id), session_id: s(row.session_id), resumes_run_id: sn(row.resumes_run_id), model: s(row.model), status: s(row.status) as Run['status'] } : null
}

export function countRuns(conn: Conn, sessionId: string): number {
  return Number((conn.get('SELECT COUNT(*) AS n FROM runs WHERE session_id=?', [sessionId]) as { n: number }).n)
}

export function listRuns(conn: Conn, sessionId: string): Run[] {
  return conn.all(`SELECT ${RUN_COLUMNS} FROM runs WHERE session_id=? ORDER BY created_at, rowid`, [sessionId]).map(run)
}

/** Session detail displays only thread placements and never the manifest. Filter BEFORE reading wide rows
 * (not after parsing every child/task's metadata). The public/full readers above keep all their fields. */
export function listDisplayRuns(conn: Conn, sessionId: string, ids: string[]): Omit<Run, 'manifest'>[] {
  if (!ids.length) return []
  const columns = RUN_COLUMN_NAMES.filter((c) => c !== 'manifest_json').join(', ')
  return conn.all(`SELECT ${columns} FROM runs INDEXED BY runs_display WHERE session_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid`,
    [sessionId, JSON.stringify(ids)]).map((row) => { const { manifest: _manifest, ...rest } = run(row); return rest })
}

export function listRunsWithStatus(conn: Conn, statuses: string[]): Run[] {
  const marks = statuses.map(() => '?').join(',')
  return conn.all(`SELECT ${RUN_COLUMNS} FROM runs INDEXED BY runs_by_status WHERE status IN (${marks}) ORDER BY created_at`, statuses).map(run)
}

/** The session's own conversation is made of its thread runs: started by a thread spawner (the person, a watch, the
 *  connector's client — the contract's one list), under no order (a child run, a run under an order, and a recorded
 *  human action each have a row but never the thread). */
const THREAD_SPAWNED = `spawned_by IN (${THREAD_SPAWNERS.map((s) => `'${s}'`).join(',')})`
export const THREAD_RUN_WHERE = `parent_run_id IS NULL AND work_order_json IS NULL AND ${THREAD_SPAWNED}`

/** The session's conversation as it stands: its latest thread run on the session's own workspace — a run of an
 *  interaction on a copy of its own (or on another node's) is that participant's conversation, not the thread's. */
export function latestRunOfSession(conn: Conn, sessionId: string, options: { sourceContinuations?: boolean } = {}): Run | null {
  // A new isolated group may also fork an ordinary continuation kept on its read-only source
  // workspace. Never pick an arbitrary participant answer as the session's common conversation.
  const continuation = options.sourceContinuations ? ` OR (r.interaction_id IS NULL AND EXISTS (
    SELECT 1 FROM workspaces w WHERE w.id=r.workspace_id AND w.session_id=s.id AND w.project_id=s.project_id AND w.source_mount_json IS NOT NULL))` : ''
  const row = conn.get(`SELECT ${RUN_COLUMNS_R} FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.session_id=? AND r.parent_run_id IS NULL AND r.work_order_json IS NULL AND r.${THREAD_SPAWNED}`
    + ` AND (r.workspace_id IS NULL OR s.workspace_id IS NULL OR r.workspace_id = s.workspace_id${continuation}) ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`, [sessionId])
  return row ? run(row) : null
}

export function listThreadRuns(conn: Conn, sessionId: string): Run[] {
  return conn.all(`SELECT ${RUN_COLUMNS} FROM runs WHERE session_id=? AND ${THREAD_RUN_WHERE} ORDER BY created_at, rowid`, [sessionId]).map(run)
}

export function getRunReceipt(conn: Conn, runId: string): Record<string, unknown> | null {
  const row = conn.get('SELECT receipt_json FROM runs WHERE id=?', [runId])
  if (!row) return null
  const value = d<unknown>(row.receipt_json, {})
  return value && typeof value === 'object' && Object.keys(value as object).length ? (value as Record<string, unknown>) : null
}

export function setRunReceipt(conn: Conn, runId: string, receipt: Record<string, unknown>): void {
  conn.run('UPDATE runs SET receipt_json=? WHERE id=?', [j(receipt), runId])
}

export function getRunHistory(conn: Conn, runId: string): string | null {
  const row = conn.get('SELECT history_json FROM runs WHERE id=?', [runId])
  return row ? sn(row.history_json) : null
}

export function setRunStatus(conn: Conn, runId: string, status: string): void {
  conn.run('UPDATE runs SET status=? WHERE id=?', [status, runId])
}

export function setRunManifest(conn: Conn, runId: string, manifest: Record<string, unknown>): void {
  conn.run('UPDATE runs SET manifest_json=? WHERE id=?', [j(manifest), runId])
}

export function saveRunProgress(conn: Conn, runId: string, historyJson: string | null, usage: Record<string, unknown>, savedSeq: number): void {
  conn.run('UPDATE runs SET history_json=COALESCE(?, history_json), usage_json=?, saved_seq=? WHERE id=?',
    [historyJson, j(usage), savedSeq, runId])
}

export function finishRun(conn: Conn, runId: string, status: string, opts: {
  history_json: string | null; usage: Record<string, unknown>; error: string | null; receipt: Record<string, unknown>; saved_seq: number
}): void {
  conn.run('UPDATE runs SET status=?, history_json=COALESCE(?, history_json), usage_json=?, error=?, receipt_json=?,'
    + ' finished_at=?, saved_seq=? WHERE id=?',
    [status, opts.history_json, j(opts.usage), opts.error, j(opts.receipt), nowIso(), opts.saved_seq, runId])
  const row = conn.get('SELECT session_id, finished_at FROM runs WHERE id=?', [runId])
  if (row) {
    touchSession(conn, s(row.session_id))
    // a run this process ran to its end (markDeadRuns, a restart's word on a run it found lost, never comes here); a
    // run the harness cancelled as it shut down (receipt.interrupted, written in the same statement) is no one's
    if (opts.receipt.interrupted !== true) noteSessionActivity(conn, s(row.session_id), s(row.finished_at))
  }
  // Optional derived data must never turn a successfully persisted completion into a failed run. A missing row
  // falls back to the original history reader; the derived table is part of the supported v38 schema.
  try { writeHistoryProjection(conn, runId) } catch { /* source is intact; read-side fallback */ }

}

export const LOST_RUN_ERROR = 'process exited while the run was running; the saved conversation stands'

/** Every run of a relay, oldest first. */
export function listRunsOfRelay(conn: Conn, relayId: string): Run[] {
  return conn.all(`SELECT ${RUN_COLUMNS} FROM runs WHERE relay_id=? ORDER BY created_at, rowid`, [relayId]).map(run)
}

/** Every run of an interaction, oldest first. */
export function listRunsOfInteraction(conn: Conn, interactionId: string): Run[] {
  return conn.all(`SELECT ${RUN_COLUMNS} FROM runs WHERE interaction_id=? ORDER BY created_at, rowid`, [interactionId]).map(run)
}

/** Startup: runs a dead process left running are errors now (their saved history stands); waiting ones are the reconciler's. */
/** Runs whose row ended (done, error, cancelled) but whose run_finished event never got written: a crash between
 *  the row and the event. */
export function runsWithoutFinishEvent(conn: Conn): Run[] {
  return conn.all(`SELECT ${RUN_COLUMNS_R} FROM runs r WHERE r.status IN ('done','error','cancelled')`
    + " AND NOT EXISTS (SELECT 1 FROM run_events e WHERE e.run_id=r.id AND e.event='run_finished') ORDER BY r.created_at").map(run)
}

export function markDeadRuns(conn: Conn): string[] {
  // queued: a run waiting for its route's one page (ChatGPT on the web) when the process died
  const ids = conn.all("SELECT id FROM runs WHERE status IN ('queued','running')").map((r) => s(r.id))
  for (const rid of ids) conn.run("UPDATE runs SET status='error', error=?, finished_at=? WHERE id=?", [LOST_RUN_ERROR, nowIso(), rid])
  return ids
}

// -- relays -----------------------------------------------------------------

function relay(row: Row): Relay {
  return {
    id: s(row.id), session_id: s(row.session_id), status: s(row.status) as Relay['status'], user_text: s(row.user_text),
    participants: d<RelayParticipant[]>(row.participants_json, []), steps: d<Partial<RelayStep>[]>(row.steps_json, []).map((step) => ({ ...step, run_ids: step.run_ids ?? [] }) as RelayStep),
    rounds: n(row.rounds), round: n(row.round), current_step: n(row.current_step), reason: sn(row.reason),
    client_request_id: sn(row.client_request_id), created_at: s(row.created_at), updated_at: s(row.updated_at), finished_at: sn(row.finished_at),
  }
}

/** What the relay's first turn was sent with (a re-run of a turn carries none of it: the conversation already holds it). */
export interface RelayInputs {
  thinking: string | null; budget: Budget; mentions: Record<string, unknown>[]; attachments: Attachment[]
  /** the first turn starts a new conversation (no earlier history) */
  fresh: boolean
  /** the run the first turn continues (null: the session's latest thread run) */
  resumes_run_id: string | null
}

export function insertRelay(conn: Conn, opts: {
  session_id: string; user_text: string; participants: RelayParticipant[]; steps: RelayStep[]; rounds: number; thinking: string | null;
  budget: Budget; mentions: Record<string, unknown>[]; attachments: Attachment[]; client_request_id: string | null
  fresh?: boolean; resumes_run_id?: string | null
  /** schema v28: the access cap every turn of it holds */
  access_cap?: AccessMode | null
}): Relay {
  const id = newId('relay')
  const t = nowIso()
  conn.run('INSERT INTO relays (id, session_id, status, user_text, participants_json, steps_json, rounds, round, current_step, reason, thinking,'
    + ' budget_json, fresh, resumes_run_id, mentions_json, attachments_json, client_request_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, opts.session_id, 'running', opts.user_text, j(opts.participants), j(opts.steps), opts.rounds, 1, 0, null, opts.thinking,
      j(budgetLines(opts.budget)), opts.fresh ? 1 : 0, opts.resumes_run_id ?? null, j(opts.mentions), j(opts.attachments), opts.client_request_id, t, t])
  setCap(conn, 'relay', id, opts.access_cap)
  touchSession(conn, opts.session_id)
  noteSessionActivity(conn, opts.session_id, t)          // a message to several agents in turn (a restart never makes one)
  return getRelay(conn, id)!
}

export function getRelay(conn: Conn, relayId: string): Relay | null {
  const row = conn.get('SELECT * FROM relays WHERE id=?', [relayId])
  return row ? relay(row) : null
}

export function relayInputs(conn: Conn, relayId: string): RelayInputs {
  const row = conn.get('SELECT thinking, budget_json, fresh, resumes_run_id, mentions_json, attachments_json FROM relays WHERE id=?', [relayId])
  if (!row) return { thinking: null, budget: {}, mentions: [], attachments: [], fresh: false, resumes_run_id: null }
  return {
    thinking: sn(row.thinking), budget: parseBudget(d(row.budget_json, {})), mentions: d(row.mentions_json, []), attachments: d(row.attachments_json, []),
    fresh: b(row.fresh), resumes_run_id: sn(row.resumes_run_id),
  }
}

export function listRelays(conn: Conn, sessionId: string): Relay[] {
  return conn.all('SELECT * FROM relays WHERE session_id=? ORDER BY created_at, rowid', [sessionId]).map(relay)
}

export function listRelaysWithStatus(conn: Conn, statuses: string[]): Relay[] {
  const marks = statuses.map(() => '?').join(',')
  return conn.all(`SELECT * FROM relays WHERE status IN (${marks}) ORDER BY created_at, rowid`, statuses).map(relay)
}

/** The relay a chat with this key already started in the session, if any. */
export function relayForClientRequest(conn: Conn, sessionId: string, clientRequestId: string): Relay | null {
  const row = conn.get('SELECT * FROM relays WHERE session_id=? AND client_request_id=?', [sessionId, clientRequestId])
  return row ? relay(row) : null
}

export function updateRelay(conn: Conn, relayId: string, patch: {
  status?: Relay['status']; steps?: RelayStep[]; rounds?: number; round?: number; current_step?: number; reason?: string | null; finished_at?: string | null
}): void {
  const sets: string[] = ['updated_at=?']
  const params: (string | number | null)[] = [nowIso()]
  if (patch.status !== undefined) { sets.push('status=?'); params.push(patch.status) }
  if (patch.steps !== undefined) { sets.push('steps_json=?'); params.push(j(patch.steps)) }
  if (patch.rounds !== undefined) { sets.push('rounds=?'); params.push(patch.rounds) }
  if (patch.round !== undefined) { sets.push('round=?'); params.push(patch.round) }
  if (patch.current_step !== undefined) { sets.push('current_step=?'); params.push(patch.current_step) }
  if (patch.reason !== undefined) { sets.push('reason=?'); params.push(patch.reason) }
  if (patch.finished_at !== undefined) { sets.push('finished_at=?'); params.push(patch.finished_at) }
  params.push(relayId)
  conn.run(`UPDATE relays SET ${sets.join(', ')} WHERE id=?`, params)
  const row = conn.get('SELECT session_id FROM relays WHERE id=?', [relayId])
  if (row) touchSession(conn, s(row.session_id))
}

// -- interactions -----------------------------------------------------------

function interaction(row: Row): Interaction {
  const budget = d<Record<string, unknown>>(row.budget_json, {})
  return {
    id: s(row.id), session_id: s(row.session_id), status: s(row.status) as Interaction['status'], user_text: s(row.user_text),
    participants: d<InteractionParticipant[]>(row.participants_json, []), controller: s(row.controller) as Interaction['controller'],
    workspace_policy: (row.workspace_policy ?? 'legacy') as Interaction['workspace_policy'], source_turn_id: sn(row.source_turn_id),
    template: sn(row.template), then: s(row.then_action) as Interaction['then'], revision: n(row.revision),
    budget: { max_runs: n(budget.max_runs ?? 1), concurrency: n(budget.concurrency ?? 1) }, runs_started: n(row.runs_started),
    base_checkpoint_id: sn(row.base_checkpoint_id), fresh: b(row.fresh), resumes_run_id: sn(row.resumes_run_id),
    director_session_id: sn(row.director_session_id), director_turn_id: sn(row.director_turn_id), reason: sn(row.reason),
    attachments: d<Attachment[]>(row.attachments_json, []),
    client_request_id: sn(row.client_request_id), created_at: s(row.created_at), updated_at: s(row.updated_at), finished_at: sn(row.finished_at),
  }
}

/** What the interaction's runs are started with (every node's run: the same limits, the same thinking; a shared
 *  node's first run: the mentions and the images). */
export interface InteractionInputs {
  thinking: string | null; budget: Budget; mentions: Record<string, unknown>[]; attachments: Attachment[]
}

export function insertInteraction(conn: Conn, opts: {
  session_id: string; status: Interaction['status']; user_text: string; participants: InteractionParticipant[]; controller: Interaction['controller']
  template: string | null; then: Interaction['then']; budget: Interaction['budget']; run_budget: Budget; base_checkpoint_id: string | null
  fresh: boolean; resumes_run_id: string | null; thinking: string | null; mentions: Record<string, unknown>[]; attachments: Attachment[]
  director_session_id: string | null; client_request_id: string | null
  workspace_policy?: Interaction['workspace_policy']; source_turn_id?: string | null
  /** schema v28: the access cap every run of it holds */
  access_cap?: AccessMode | null
}): Interaction {
  const id = newId('ix')
  const t = nowIso()
  conn.run('INSERT INTO interactions (id, session_id, status, user_text, participants_json, controller, template, then_action, revision, budget_json, run_budget_json,'
    + ' runs_started, base_checkpoint_id, fresh, resumes_run_id, thinking, mentions_json, attachments_json, director_session_id, director_turn_id, reason, client_request_id,'
    + ' created_at, updated_at, workspace_policy, source_turn_id) VALUES (?,?,?,?,?,?,?,?,0,?,?,0,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?)',
    [id, opts.session_id, opts.status, opts.user_text, j(opts.participants), opts.controller, opts.template, opts.then, j(opts.budget), j(budgetLines(opts.run_budget)),
      opts.base_checkpoint_id, opts.fresh ? 1 : 0, opts.resumes_run_id, opts.thinking, j(opts.mentions), j(opts.attachments), opts.director_session_id, opts.client_request_id, t, t, opts.workspace_policy ?? 'legacy', opts.source_turn_id ?? null])
  setCap(conn, 'interaction', id, opts.access_cap)
  touchSession(conn, opts.session_id)
  noteSessionActivity(conn, opts.session_id, t)          // a message to a group, before any of its runs (a restart never makes one)
  return getInteraction(conn, id)!
}

export function getInteraction(conn: Conn, id: string): Interaction | null {
  const row = conn.get('SELECT * FROM interactions WHERE id=?', [id])
  return row ? interaction(row) : null
}

export function interactionInputs(conn: Conn, id: string): InteractionInputs {
  const row = conn.get('SELECT thinking, run_budget_json, mentions_json, attachments_json FROM interactions WHERE id=?', [id])
  if (!row) return { thinking: null, budget: {}, mentions: [], attachments: [] }
  return { thinking: sn(row.thinking), budget: parseBudget(d(row.run_budget_json, {})), mentions: d(row.mentions_json, []), attachments: d(row.attachments_json, []) }
}

export function listInteractions(conn: Conn, sessionId: string): Interaction[] {
  return conn.all('SELECT * FROM interactions WHERE session_id=? ORDER BY created_at, rowid', [sessionId]).map(interaction)
}

export function listInteractionsWithStatus(conn: Conn, statuses: string[]): Interaction[] {
  const marks = statuses.map(() => '?').join(',')
  return conn.all(`SELECT * FROM interactions WHERE status IN (${marks}) ORDER BY created_at, rowid`, statuses).map(interaction)
}

/** The interaction a request with this key already started in the session, if any. */
export function interactionForClientRequest(conn: Conn, sessionId: string, clientRequestId: string): Interaction | null {
  const row = conn.get('SELECT * FROM interactions WHERE session_id=? AND client_request_id=?', [sessionId, clientRequestId])
  return row ? interaction(row) : null
}

/** The interaction a director turn was made for (its planning turn, a decision turn), if any. */
export function interactionOfDirectorTurn(conn: Conn, turnId: string): Interaction | null {
  const row = conn.get('SELECT * FROM interactions WHERE director_turn_id=?', [turnId])
  return row ? interaction(row) : null
}

export function updateInteraction(conn: Conn, id: string, patch: {
  status?: Interaction['status']; then?: Interaction['then']; revision?: number; runs_started?: number; base_checkpoint_id?: string | null
  director_session_id?: string | null; director_turn_id?: string | null; reason?: string | null; finished_at?: string | null
  budget?: Interaction['budget']
}): void {
  const sets: string[] = ['updated_at=?']
  const params: (string | number | null)[] = [nowIso()]
  const columns: Record<string, string> = { then: 'then_action', budget: 'budget_json' }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    sets.push(`${columns[key] ?? key}=?`)
    params.push(key === 'budget' ? j(value) : value as string | number | null)
  }
  params.push(id)
  conn.run(`UPDATE interactions SET ${sets.join(', ')} WHERE id=?`, params)
  const row = conn.get('SELECT session_id FROM interactions WHERE id=?', [id])
  if (row) touchSession(conn, s(row.session_id))
}

function interactionNode(row: Row): InteractionNode {
  return {
    id: s(row.id), interaction_id: s(row.interaction_id), seq: n(row.seq), participant: s(row.participant), instruction: sn(row.instruction),
    depends_on: d<string[]>(row.depends_on_json, []), receives: d<string[]>(row.receives_json, []), workspace: s(row.workspace) as InteractionNode['workspace'],
    status: s(row.status) as InteractionNode['status'], run_id: sn(row.run_id), run_ids: d<string[]>(row.run_ids_json, []), workspace_id: sn(row.workspace_id),
    revision: n(row.revision), wave: 1, created_at: s(row.created_at), updated_at: s(row.updated_at),
    kind: row.kind === 'followup' ? 'followup' : 'plan', message: d<InteractionNode['message']>(row.message_json, null),
    cites: d<string[]>(row.cites_json, []), receive_runs: d<string[]>(row.receive_runs_json, []),
  }
}

export function insertNode(conn: Conn, opts: {
  interaction_id: string; id: string; participant: string; instruction: string | null; depends_on: string[]; receives: string[]; workspace: string; revision: number
  /** schema v25: a follow-up step (its message, who sent it), the runs its instruction cites, the runs it is handed */
  kind?: 'plan' | 'followup'; message?: InteractionNode['message']; cites?: string[]; receive_runs?: string[]; workspace_id?: string | null
}): InteractionNode {
  const seq = n(conn.get('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM interaction_nodes WHERE interaction_id=?', [opts.interaction_id])!.seq)
  const t = nowIso()
  conn.run('INSERT INTO interaction_nodes (interaction_id, id, seq, participant, instruction, depends_on_json, receives_json, workspace, status, run_id, run_ids_json, workspace_id, revision, created_at, updated_at, kind, message_json, cites_json, receive_runs_json)'
    + " VALUES (?,?,?,?,?,?,?,?,'queued',NULL,'[]',?,?,?,?,?,?,?,?)",
    [opts.interaction_id, opts.id, seq, opts.participant, opts.instruction, j(opts.depends_on), j(opts.receives), opts.workspace, opts.workspace_id ?? null, opts.revision, t, t,
      opts.kind ?? 'plan', opts.message ? j(opts.message) : null, j(opts.cites ?? []), j(opts.receive_runs ?? [])])
  return getNode(conn, opts.interaction_id, opts.id)!
}

export function getNode(conn: Conn, interactionId: string, nodeId: string): InteractionNode | null {
  const row = conn.get('SELECT * FROM interaction_nodes WHERE interaction_id=? AND id=?', [interactionId, nodeId])
  return row ? interactionNode(row) : null
}

export function listNodes(conn: Conn, interactionId: string): InteractionNode[] {
  return conn.all('SELECT * FROM interaction_nodes WHERE interaction_id=? ORDER BY seq', [interactionId]).map(interactionNode)
}

export function updateNode(conn: Conn, interactionId: string, nodeId: string, patch: {
  status?: InteractionNode['status']; run_id?: string | null; run_ids?: string[]; workspace_id?: string | null
}): void {
  const sets: string[] = ['updated_at=?']
  const params: (string | null)[] = [nowIso()]
  if (patch.status !== undefined) { sets.push('status=?'); params.push(patch.status) }
  if (patch.run_id !== undefined) { sets.push('run_id=?'); params.push(patch.run_id) }
  if (patch.run_ids !== undefined) { sets.push('run_ids_json=?'); params.push(j(patch.run_ids)) }
  if (patch.workspace_id !== undefined) { sets.push('workspace_id=?'); params.push(patch.workspace_id) }
  params.push(interactionId, nodeId)
  conn.run(`UPDATE interaction_nodes SET ${sets.join(', ')} WHERE interaction_id=? AND id=?`, params)
}

function interactionEvent(row: Row): InteractionEvent {
  return { seq: n(row.seq), kind: s(row.kind), actor: s(row.actor), payload: d(row.payload_json, {}), created_at: s(row.created_at) }
}

/** Append one event to the interaction's record (never rewritten). */
export function appendInteractionEvent(conn: Conn, interactionId: string, kind: string, actor: string, payload: Record<string, unknown> = {}): InteractionEvent {
  const seq = n(conn.get('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM interaction_events WHERE interaction_id=?', [interactionId])!.seq)
  const t = nowIso()
  conn.run('INSERT INTO interaction_events (interaction_id, seq, kind, actor, payload_json, created_at) VALUES (?,?,?,?,?,?)', [interactionId, seq, kind, actor, j(payload), t])
  return { seq, kind, actor, payload, created_at: t }
}

export function listInteractionEvents(conn: Conn, interactionId: string): InteractionEvent[] {
  return conn.all('SELECT * FROM interaction_events WHERE interaction_id=? ORDER BY seq', [interactionId]).map(interactionEvent)
}

function interactionNote(row: Row): InteractionNote {
  return {
    id: s(row.id), interaction_id: s(row.interaction_id), to: s(row.to_participant), text: s(row.text), status: s(row.status) as InteractionNote['status'],
    delivered: d<Record<string, string>>(row.delivered_json, {}), created_at: s(row.created_at), updated_at: s(row.updated_at),
  }
}

export function insertInteractionNote(conn: Conn, opts: { interaction_id: string; to: string; text: string }): InteractionNote {
  const id = newId('inote')
  const t = nowIso()
  conn.run("INSERT INTO interaction_notes (id, interaction_id, to_participant, text, status, delivered_json, created_at, updated_at) VALUES (?,?,?,?,'queued','{}',?,?)",
    [id, opts.interaction_id, opts.to, opts.text, t, t])
  const owner = conn.get('SELECT session_id FROM interactions WHERE id=?', [opts.interaction_id])
  if (owner) noteSessionActivity(conn, s(owner.session_id), t)
  return interactionNote(conn.get('SELECT * FROM interaction_notes WHERE id=?', [id])!)
}

export function listInteractionNotes(conn: Conn, interactionId: string): InteractionNote[] {
  return conn.all('SELECT * FROM interaction_notes WHERE interaction_id=? ORDER BY created_at, rowid', [interactionId]).map(interactionNote)
}

export function updateInteractionNote(conn: Conn, id: string, patch: { status?: InteractionNote['status']; delivered?: Record<string, string> }): void {
  const sets = ['updated_at=?']
  const params: string[] = [nowIso()]
  if (patch.status !== undefined) { sets.push('status=?'); params.push(patch.status) }
  if (patch.delivered !== undefined) { sets.push('delivered_json=?'); params.push(j(patch.delivered)) }
  conn.run(`UPDATE interaction_notes SET ${sets.join(', ')} WHERE id=?`, [...params, id])
}

// -- run events -------------------------------------------------------------

export interface StoredEvent { seq: number; event: string; data: Record<string, unknown> }

/** The event written, with the session cursor it took (schema v26): the counter's next value, in the same transaction
 *  as the row. null: the row was there already (the same run and seq), nothing written. */
export function insertEvent(conn: Conn, runId: string, seq: number, event: string, data: Record<string, unknown>): number | null {
  return conn.transaction(() => {
    const cursor = n(conn.get('INSERT INTO event_cursor (id, last) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET last = last + 1 RETURNING last')!.last)
    const { changes } = conn.run('INSERT OR IGNORE INTO run_events (run_id, seq, version, event, data_json, created_at, cursor, session_id)'
      + ' VALUES (?,?,1,?,?,?,?,(SELECT session_id FROM runs WHERE id=?))', [runId, seq, event, j(data), nowIso(), cursor, runId])
    return changes ? cursor : null
  })
}

/** The cursor the last event written took (0: none yet). */
export function lastEventCursor(conn: Conn): number {
  const row = conn.get('SELECT last FROM event_cursor WHERE id=1')
  return row ? n(row.last) : 0
}

export interface CursorEvent extends StoredEvent { run_id: string; cursor: number }

/** A session's persisted events after the cursor (up to `upTo`), in cursor order, at most `limit` (a page: the caller asks again after
 *  the last one's cursor). One range of the (session, cursor) index: a page costs what it returns, never a run's whole
 *  history nor another session's events. */
export function sessionEventsAfter(conn: Conn, sessionId: string, after: number, upTo: number, limit: number): CursorEvent[] {
  return conn.all('SELECT run_id, seq, event, data_json, cursor FROM run_events'
    + ' WHERE session_id = ? AND cursor > ? AND cursor <= ? ORDER BY cursor LIMIT ?', [sessionId, after, upTo, limit])
    .map((r) => ({ run_id: s(r.run_id), seq: n(r.seq), event: s(r.event), data: d(r.data_json, {}), cursor: n(r.cursor) }))
}

/** A run's persisted events after `afterSeq`, at most `limit` (-1: all), by its key (run_id, seq). */
export function listEvents(conn: Conn, runId: string, afterSeq = -1, limit = -1): StoredEvent[] {
  return conn.all('SELECT seq, event, data_json FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?', [runId, afterSeq, limit])
    .map((r) => ({ seq: n(r.seq), event: s(r.event), data: d(r.data_json, {}) }))
}

/** Maintenance records for transcript hydration, without reading every tool result's potentially large payload. */
export function listCompactionEvents(conn: Conn, runId: string): StoredEvent[] {
  return conn.all("SELECT seq, event, data_json FROM run_events WHERE run_id=? AND event IN ('context_compacting','context_compacted') ORDER BY seq", [runId])
    .map((r) => ({ seq: n(r.seq), event: s(r.event), data: d(r.data_json, {}) }))
}

export function maxEventSeq(conn: Conn, runId: string): number {
  const row = conn.get('SELECT MAX(seq) AS m FROM run_events WHERE run_id=?', [runId])
  return row && row.m !== null && row.m !== undefined ? n(row.m) : -1
}

// -- model requests ---------------------------------------------------------

export function insertModelRequest(conn: Conn, r: ModelRequestRecord): void {
  conn.run(
    'INSERT INTO model_requests (id, run_id, seq, model_id, configured_model, provider_reported_model, endpoint,'
    + ' started_at, latency_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,'
    + ' cost_status, cost_source, status, error, tool_schema_sha256, message_count, context_estimate_tokens, cost_cny)'
    + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [r.id, r.run_id, r.seq, r.model_id, r.configured_model, r.provider_reported_model, r.endpoint, r.started_at, r.latency_ms,
      r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, r.cost_usd, r.cost_status, r.cost_source, r.status,
      r.error, r.tool_schema_sha256, r.message_count, r.context_estimate_tokens, r.cost_cny ?? null])
}

export function listModelRequests(conn: Conn, runId: string): ModelRequestRecord[] {
  return conn.all('SELECT * FROM model_requests WHERE run_id=? ORDER BY seq', [runId]).map((r) => ({
    id: s(r.id), run_id: s(r.run_id), seq: n(r.seq), model_id: s(r.model_id), configured_model: s(r.configured_model),
    provider_reported_model: sn(r.provider_reported_model), endpoint: s(r.endpoint), started_at: s(r.started_at), latency_ms: nn(r.latency_ms),
    input_tokens: n(r.input_tokens), output_tokens: n(r.output_tokens), cache_read_tokens: n(r.cache_read_tokens),
    cache_write_tokens: n(r.cache_write_tokens), cost_usd: nn(r.cost_usd), cost_cny: nn(r.cost_cny), cost_status: s(r.cost_status) as ModelRequestRecord['cost_status'],
    cost_source: sn(r.cost_source), status: s(r.status), error: sn(r.error), tool_schema_sha256: sn(r.tool_schema_sha256),
    message_count: n(r.message_count), context_estimate_tokens: nn(r.context_estimate_tokens),
  }))
}

// -- executions -------------------------------------------------------------

function execution(row: Row): Execution {
  const isolation = d<Record<string, unknown>>(row.isolation_json, {})
  const targetId = sn(row.remote_target_id) ?? (typeof isolation.target_id === 'string' ? isolation.target_id : null)
  const rootId = sn(row.remote_root_id) ?? (typeof isolation.root_id === 'string' ? isolation.root_id : '')
  const generation = sn(row.remote_generation) ?? (typeof isolation.generation === 'string' ? isolation.generation : '')
  return {
    ...(targetId ? { target: { kind: 'ssh' as const, target_id: targetId }, remote: { target_id: targetId, root_id: rootId, generation, job_id: sn(row.remote_job_id) },
      connection_state: (row.remote_connection_state === 'connected' ? 'connected' : row.remote_connection_state === 'unknown' ? 'unknown' : 'disconnected') as 'connected' | 'unknown' | 'disconnected',
      remote_status: (['starting','running','exited'].includes(String(row.remote_job_state)) ? row.remote_job_state : 'unknown') as 'starting' | 'running' | 'exited' | 'unknown' }
      : isolation.runtime === 'ssh' ? {} : { target: { kind: 'local' as const }, remote: null }),
    id: s(row.id), run_id: sn(row.run_id), workspace_id: sn(row.workspace_id), tool_call_id: sn(row.tool_call_id), kind: s(row.kind),
    command: s(row.command), cwd: s(row.cwd), status: s(row.status) as Execution['status'],
    effect_state: s(row.effect_state) as Execution['effect_state'], exit_code: nn(row.exit_code), timed_out: b(row.timed_out),
    cancelled: b(row.cancelled), truncated: b(row.truncated), stdout_asset_id: sn(row.stdout_asset_id), stderr_asset_id: sn(row.stderr_asset_id),
    stdout_bytes: n(row.stdout_bytes), stderr_bytes: n(row.stderr_bytes), started_at: sn(row.started_at), finished_at: sn(row.finished_at),
    duration_ms: nn(row.duration_ms), isolation: d(row.isolation_json, {}), network: b(row.network), created_at: s(row.created_at),
  }
}

export function insertExecution(conn: Conn, opts: {
  run_id: string | null; workspace_id: string | null; tool_call_id: string | null; kind: string; command: string; cwd: string;
  isolation: Record<string, unknown>; network: boolean
}): Execution {
  const xid = newId('x')
  conn.run('INSERT INTO executions (id, run_id, workspace_id, tool_call_id, kind, command, cwd, status, effect_state,'
    + " isolation_json, network, created_at) VALUES (?,?,?,?,?,?,?,'queued','not_started',?,?,?)",
    [xid, opts.run_id, opts.workspace_id, opts.tool_call_id, opts.kind, opts.command, opts.cwd, j(opts.isolation), opts.network ? 1 : 0, nowIso()])
  return getExecution(conn, xid)!
}

export function startExecution(conn: Conn, xid: string): void {
  conn.run("UPDATE executions SET status='running', effect_state='unknown', started_at=? WHERE id=?", [nowIso(), xid])
}

export function finishExecution(conn: Conn, xid: string, opts: {
  status: string; exit_code: number | null; timed_out: boolean; cancelled: boolean; truncated: boolean; stdout_asset_id: string | null;
  stderr_asset_id: string | null; stdout_bytes: number; stderr_bytes: number; duration_ms: number
}): void {
  const effect = opts.exit_code !== null || opts.timed_out || opts.cancelled ? 'applied' : 'unknown'
  conn.run('UPDATE executions SET status=?, effect_state=?, exit_code=?, timed_out=?, cancelled=?, truncated=?,'
    + ' stdout_asset_id=?, stderr_asset_id=?, stdout_bytes=?, stderr_bytes=?, finished_at=?, duration_ms=? WHERE id=?',
    [opts.status, effect, opts.exit_code, opts.timed_out ? 1 : 0, opts.cancelled ? 1 : 0, opts.truncated ? 1 : 0, opts.stdout_asset_id,
      opts.stderr_asset_id, opts.stdout_bytes, opts.stderr_bytes, nowIso(), opts.duration_ms, xid])
}

export function setExecutionNotApplied(conn: Conn, xid: string): void {
  conn.run("UPDATE executions SET effect_state='not_applied' WHERE id=?", [xid])
}

/** The command's process — its pid, what tells it from a later process of that pid, and its kernel unique id
 *  (macOS) — for a restart to find it and what it left behind. */
export function noteExecutionRoot(conn: Conn, xid: string, root: { pid: number; identity: string; uniqueid: string | null }): void {
  conn.run("UPDATE executions SET isolation_json=json_set(isolation_json, '$.root_pid', ?, '$.root_identity', ?, '$.root_uniqueid', ?) WHERE id=?",
    [root.pid, root.identity, root.uniqueid, xid])
}

/** How the command's descendants are followed: by the fork watcher, or by the lineage tick alone. */
export function noteExecutionLineage(conn: Conn, xid: string, how: string): void {
  conn.run("UPDATE executions SET isolation_json=json_set(isolation_json, '$.lineage', ?) WHERE id=?", [how, xid])
}

/** How many processes the command left running were killed once its own process was gone. */
export function noteExecutionStrays(conn: Conn, xid: string, killed: number): void {
  conn.run("UPDATE executions SET isolation_json=json_set(isolation_json, '$.stray_processes_killed', ?) WHERE id=?", [killed, xid])
}

/** What the command wrote and what of it was kept (execution/processes.ts): the bytes each stream wrote, the bytes its
 *  log kept, why any were not kept, and the retention cap. */
export function noteExecutionOutput(conn: Conn, xid: string, output: Record<string, unknown>): void {
  conn.run("UPDATE executions SET isolation_json=json_set(isolation_json, '$.output', json(?)) WHERE id=?", [j(output), xid])
}

const EXECUTION_ROW = 'SELECT e.*, r.target_id AS remote_target_id, r.root_id AS remote_root_id, r.generation AS remote_generation, r.job_id AS remote_job_id, r.state AS remote_job_state, r.connection_state AS remote_connection_state FROM executions e LEFT JOIN remote_jobs r ON r.execution_id=e.id'
export function getExecution(conn: Conn, xid: string): Execution | null {
  const row = conn.get(`${EXECUTION_ROW} WHERE e.id=?`, [xid])
  return row ? execution(row) : null
}

export function listExecutions(conn: Conn, opts: { run_id?: string | null; workspace_id?: string | null }): Execution[] {
  const rows = opts.run_id != null
    ? conn.all(`${EXECUTION_ROW} WHERE e.run_id=? ORDER BY e.created_at`, [opts.run_id])
    : conn.all(`${EXECUTION_ROW} WHERE e.workspace_id=? ORDER BY e.created_at`, [opts.workspace_id ?? null])
  return rows.map(execution)
}

export function markLostExecutions(conn: Conn): string[] {
  const ids = conn.all("SELECT id FROM executions WHERE status IN ('queued','running') AND NOT EXISTS (SELECT 1 FROM remote_jobs WHERE execution_id=executions.id)").map((r) => s(r.id))
  for (const xid of ids) conn.run("UPDATE executions SET status='lost', effect_state='unknown', finished_at=? WHERE id=?", [nowIso(), xid])
  return ids
}

// The two reads of the remote commands, in the order v32's plan gave them (it scanned executions in rowid order): the
// order a start's recovery takes the workspaces' locks in (src/main.ts) and runningInWorkspace lists the commands in.
// v32 stated no order, and executions_by_workspace (v33) would give another; the order is now said, not left to a plan.
/** The workspaces with a command on a remote host, each once, by its first command (NULL, a command of no workspace,
 *  is one of them as it was). */
export const REMOTE_EXECUTION_WORKSPACES_SQL = 'SELECT e.workspace_id FROM executions e JOIN remote_jobs r ON r.execution_id=e.id GROUP BY e.workspace_id ORDER BY min(e.rowid)'
/** The remote commands of a workspace (its one parameter), in the order they were written. */
export const REMOTE_EXECUTIONS_OF_WORKSPACE_SQL = 'SELECT r.execution_id FROM remote_jobs r JOIN executions e ON e.id=r.execution_id WHERE e.workspace_id=? ORDER BY e.rowid'

// -- snapshots / checkpoints / checks ---------------------------------------

function snapshot(row: Row): Snapshot {
  return {
    id: s(row.id), workspace_id: s(row.workspace_id), base_commit: s(row.base_commit), tree_sha: s(row.tree_sha), file_count: n(row.file_count),
    untracked: d(row.untracked_json, []), excluded_rules: d(row.excluded_json, []), changed_paths: d(row.changed_json, []),
    created_at: s(row.created_at),
  }
}

export function insertSnapshot(conn: Conn, workspaceId: string, baseCommit: string, treeSha: string, fileCount: number,
  untracked: string[], excluded: string[], changed: string[]): Snapshot {
  const sid = newId('snap')
  conn.run('INSERT INTO snapshots (id, workspace_id, base_commit, tree_sha, file_count, untracked_json, excluded_json,'
    + ' changed_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [sid, workspaceId, baseCommit, treeSha, fileCount, j(untracked), j(excluded), j(changed), nowIso()])
  return getSnapshot(conn, sid)!
}

export function getSnapshot(conn: Conn, sid: string): Snapshot | null {
  const row = conn.get('SELECT * FROM snapshots WHERE id=?', [sid])
  return row ? snapshot(row) : null
}

export function latestSnapshot(conn: Conn, workspaceId: string): Snapshot | null {
  const row = conn.get('SELECT * FROM snapshots WHERE workspace_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', [workspaceId])
  return row ? snapshot(row) : null
}

function checkpoint(row: Row): Checkpoint {
  return {
    id: s(row.id), workspace_id: s(row.workspace_id), run_id: sn(row.run_id), snapshot_id: s(row.snapshot_id), commit_sha: s(row.commit_sha),
    ref: s(row.ref), parent_checkpoint_id: sn(row.parent_checkpoint_id), note: s(row.note), created_at: s(row.created_at),
  }
}

export function insertCheckpoint(conn: Conn, cpId: string, workspaceId: string, runId: string | null, snapshotId: string, commitSha: string,
  ref: string, parentCheckpointId: string | null, note: string): Checkpoint {
  conn.run('INSERT INTO checkpoints (id, workspace_id, run_id, snapshot_id, commit_sha, ref, parent_checkpoint_id, note,'
    + ' created_at) VALUES (?,?,?,?,?,?,?,?,?)', [cpId, workspaceId, runId, snapshotId, commitSha, ref, parentCheckpointId, note, nowIso()])
  return getCheckpoint(conn, cpId)!
}

export function getCheckpoint(conn: Conn, cpId: string): Checkpoint | null {
  const row = conn.get('SELECT * FROM checkpoints WHERE id=?', [cpId])
  return row ? checkpoint(row) : null
}

export function listCheckpoints(conn: Conn, workspaceId: string): Checkpoint[] {
  return conn.all('SELECT * FROM checkpoints WHERE workspace_id=? ORDER BY created_at', [workspaceId]).map(checkpoint)
}

/** Every checkpoint a run pinned, in any workspace (its own, or an integration worktree). */
export function listCheckpointsOfRun(conn: Conn, runId: string): Checkpoint[] {
  return conn.all('SELECT * FROM checkpoints WHERE run_id=? ORDER BY created_at, rowid', [runId]).map(checkpoint)
}

/** The checkpoints that pin a commit (one, as a rule; an integration's composition may be pinned once more). */
export function listCheckpointsByCommit(conn: Conn, commitSha: string): Checkpoint[] {
  return conn.all('SELECT * FROM checkpoints WHERE commit_sha=? ORDER BY created_at, rowid', [commitSha]).map(checkpoint)
}

export function latestCheckpoint(conn: Conn, workspaceId: string): Checkpoint | null {
  const row = conn.get('SELECT * FROM checkpoints WHERE workspace_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', [workspaceId])
  return row ? checkpoint(row) : null
}

function check(row: Row): CheckResult {
  return {
    id: s(row.id), run_id: sn(row.run_id), workspace_id: s(row.workspace_id), snapshot_id: s(row.snapshot_id), check_id: s(row.check_id),
    command: s(row.command), exit_code: nn(row.exit_code), duration_ms: nn(row.duration_ms), log_asset_id: sn(row.log_asset_id),
    parser: s(row.parser), parser_version: s(row.parser_version), counts: d(row.counts_json, {}), status: s(row.status) as CheckResult['status'],
    reason: s(row.reason), created_at: s(row.created_at),
  }
}

export function insertCheck(conn: Conn, r: CheckResult): void {
  conn.run('INSERT INTO checks (id, run_id, workspace_id, snapshot_id, check_id, command, exit_code, duration_ms,'
    + ' log_asset_id, parser, parser_version, counts_json, status, reason, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [r.id, r.run_id, r.workspace_id, r.snapshot_id, r.check_id, r.command, r.exit_code, r.duration_ms, r.log_asset_id, r.parser,
      r.parser_version, j(r.counts), r.status, r.reason, r.created_at])
}

export function listChecks(conn: Conn, workspaceId: string): CheckResult[] {
  return conn.all('SELECT * FROM checks WHERE workspace_id=? ORDER BY created_at', [workspaceId]).map(check)
}

// -- assets -----------------------------------------------------------------

function asset(row: Row): Asset {
  return {
    id: s(row.id), project_id: s(row.project_id), kind: s(row.kind), sha256: s(row.sha256), byte_size: n(row.byte_size),
    storage_path: s(row.storage_path), meta: d(row.meta_json, {}), created_at: s(row.created_at),
  }
}

export function insertAsset(conn: Conn, projectId: string, kind: string, sha256: string, byteSize: number, storagePath: string,
  meta: Record<string, unknown>): Asset {
  const aid = newId('a')
  conn.run('INSERT INTO assets (id, project_id, kind, sha256, byte_size, storage_path, meta_json, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [aid, projectId, kind, sha256, byteSize, storagePath, j(meta), nowIso()])
  return getAsset(conn, aid)!
}

/** Metadata is the one mutable part of an asset (acceptances of a contract, say); the bytes never change. */
export function setAssetMeta(conn: Conn, aid: string, meta: Record<string, unknown>): void {
  conn.run('UPDATE assets SET meta_json=? WHERE id=?', [j(meta), aid])
}

export function getAsset(conn: Conn, aid: string): Asset | null {
  const row = conn.get('SELECT * FROM assets WHERE id=?', [aid])
  return row ? asset(row) : null
}

export function listAssetsWithRole(conn: Conn, projectId: string, kind: string, role: string): Asset[] {
  return conn.all("SELECT * FROM assets WHERE project_id=? AND kind=? AND json_extract(meta_json, '$.role')=? ORDER BY created_at, rowid",
    [projectId, kind, role]).map(asset)
}

// -- approvals --------------------------------------------------------------

function approval(row: Row): Approval {
  return {
    id: s(row.id), session_id: s(row.session_id), run_id: sn(row.run_id), tool_call_id: sn(row.tool_call_id), action: s(row.action),
    params: d(row.params_json, {}), params_sha256: s(row.params_sha256), status: s(row.status) as Approval['status'],
    created_at: s(row.created_at), decided_at: sn(row.decided_at),
  }
}

export function insertApproval(conn: Conn, sessionId: string, runId: string | null, toolCallId: string | null, action: string,
  params: Record<string, unknown>, paramsSha256: string): Approval {
  const aid = newId('ap')
  conn.run('INSERT INTO approvals (id, session_id, run_id, tool_call_id, action, params_json, params_sha256, status, created_at)'
    + " VALUES (?,?,?,?,?,?,?,'pending',?)", [aid, sessionId, runId, toolCallId, action, j(params), paramsSha256, nowIso()])
  return getApproval(conn, aid)!
}

export function getApproval(conn: Conn, aid: string): Approval | null {
  const row = conn.get('SELECT * FROM approvals WHERE id=?', [aid])
  return row ? approval(row) : null
}

export function listApprovals(conn: Conn, sessionId: string, status?: string | null): Approval[] {
  const rows = status
    ? conn.all('SELECT * FROM approvals WHERE session_id=? AND status=? ORDER BY created_at', [sessionId, status])
    : conn.all('SELECT * FROM approvals WHERE session_id=? ORDER BY created_at', [sessionId])
  return rows.map(approval)
}

export function decideApproval(conn: Conn, aid: string, status: string): void {
  conn.run('UPDATE approvals SET status=?, decided_at=? WHERE id=?', [status, nowIso(), aid])
}

// -- governance log (append-only) -----------------------------------------------

export interface GovernanceEntry {
  id: number; session_id: string; kind: string; run_id: string | null; ref: string | null; actor: string;
  params: Record<string, unknown>; created_at: string
}

function governance(r: Row): GovernanceEntry {
  return {
    id: n(r.id), session_id: s(r.session_id), kind: s(r.kind), run_id: sn(r.run_id), ref: sn(r.ref), actor: s(r.actor),
    params: d(r.params_json, {}), created_at: s(r.created_at),
  }
}

export function logGovernance(conn: Conn, sessionId: string, kind: string, opts: {
  actor: string; params: Record<string, unknown>; run_id?: string | null; ref?: string | null
}): number {
  const result = conn.run('INSERT INTO governance_log (session_id, kind, run_id, ref, actor, params_json, created_at) VALUES (?,?,?,?,?,?,?)',
    [sessionId, kind, opts.run_id ?? null, opts.ref ?? null, opts.actor, j(opts.params), nowIso()])
  return result.lastInsertRowid
}

/** Every entry of one kind for a session, newest first. */
export function listGovernance(conn: Conn, sessionId: string, kind: string): GovernanceEntry[] {
  return conn.all('SELECT * FROM governance_log WHERE session_id=? AND kind=? ORDER BY id DESC', [sessionId, kind]).map(governance)
}

export function governanceForRef(conn: Conn, kind: string, ref: string): GovernanceEntry | null {
  const row = conn.get('SELECT * FROM governance_log WHERE kind=? AND ref=? ORDER BY id DESC LIMIT 1', [kind, ref])
  return row ? governance(row) : null
}

export interface SessionEvent { run_id: string; seq: number; event: string; data: Record<string, unknown>; t: string }

/** Every persisted event of every run of a session with the moment it was written, in time order (a replay). */
export function listSessionEvents(conn: Conn, sessionId: string): SessionEvent[] {
  return conn.all('SELECT e.run_id, e.seq, e.event, e.data_json, e.created_at FROM run_events e JOIN runs r ON r.id = e.run_id'
    + ' WHERE r.session_id=? ORDER BY e.created_at, e.rowid', [sessionId])
    .map((r) => ({ run_id: s(r.run_id), seq: n(r.seq), event: s(r.event), data: d(r.data_json, {}), t: s(r.created_at) }))
}

// -- watches (schema v18) -------------------------------------------------------

function watch(row: Row): Watch {
  return {
    id: s(row.id), session_id: s(row.session_id), run_id: s(row.run_id), spec: d<WatchSpec>(row.spec_json, {} as WatchSpec), note: s(row.note),
    summary: s(row.summary), status: s(row.status) as WatchStatus, repeat: b(row.repeats), cooldown_s: n(row.cooldown_s), max_fires: n(row.max_fires),
    fires: n(row.fires), last_fired_at: sn(row.last_fired_at), expires_at: s(row.expires_at), ended_reason: sn(row.ended_reason),
    created_at: s(row.created_at), updated_at: s(row.updated_at),
  }
}

export function insertWatch(conn: Conn, o: { session_id: string; run_id: string; spec: WatchSpec; note: string; summary: string; repeat: boolean; cooldown_s: number; max_fires: number; expires_at: string }): Watch {
  const id = newId('w')
  const t = nowIso()
  conn.run(`INSERT INTO watches (id, session_id, run_id, spec_json, note, summary, status, repeats, cooldown_s, max_fires, fires, expires_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,'active',?,?,?,0,?,?,?)`, [id, o.session_id, o.run_id, j(o.spec), o.note, o.summary, o.repeat ? 1 : 0, o.cooldown_s, o.max_fires, o.expires_at, t, t])
  return getWatch(conn, id)!
}

export function getWatch(conn: Conn, id: string): Watch | null {
  const row = conn.get('SELECT * FROM watches WHERE id=?', [id])
  return row ? watch(row) : null
}

/** The session's watches, newest first. */
export function listWatches(conn: Conn, sessionId: string): Watch[] {
  return conn.all('SELECT * FROM watches WHERE session_id=? ORDER BY created_at DESC, rowid DESC', [sessionId]).map(watch)
}

export function listActiveWatches(conn: Conn): Watch[] {
  return conn.all("SELECT * FROM watches WHERE status='active' ORDER BY created_at, rowid").map(watch)
}

export function updateWatch(conn: Conn, id: string, patch: { status?: WatchStatus; fires?: number; last_fired_at?: string | null; ended_reason?: string | null }): void {
  const sets = ['updated_at=?']
  const params: (string | number | null)[] = [nowIso()]
  if (patch.status !== undefined) { sets.push('status=?'); params.push(patch.status) }
  if (patch.fires !== undefined) { sets.push('fires=?'); params.push(patch.fires) }
  if (patch.last_fired_at !== undefined) { sets.push('last_fired_at=?'); params.push(patch.last_fired_at) }
  if (patch.ended_reason !== undefined) { sets.push('ended_reason=?'); params.push(patch.ended_reason) }
  conn.run(`UPDATE watches SET ${sets.join(', ')} WHERE id=?`, [...params, id])
}

function wakeEvent(row: Row): WakeEvent {
  return {
    id: s(row.id), watch_id: s(row.watch_id), session_id: s(row.session_id), kind: s(row.kind) as WakeEvent['kind'], detail: s(row.detail),
    payload: d<Record<string, unknown>>(row.payload_json, {}), status: s(row.status) as WakeEvent['status'], run_id: sn(row.run_id),
    created_at: s(row.created_at), delivered_at: sn(row.delivered_at),
  }
}

export function insertWakeEvent(conn: Conn, o: { watch_id: string; session_id: string; kind: WakeEvent['kind']; detail: string; payload?: Record<string, unknown> }): WakeEvent {
  const id = newId('wev')
  conn.run("INSERT INTO wake_events (id, watch_id, session_id, kind, detail, payload_json, status, created_at) VALUES (?,?,?,?,?,?,'pending',?)",
    [id, o.watch_id, o.session_id, o.kind, o.detail, j(o.payload ?? {}), nowIso()])
  return wakeEvent(conn.get('SELECT * FROM wake_events WHERE id=?', [id])!)
}

/** The session's wake events, newest first (at most `limit`). */
export function listWakeEvents(conn: Conn, sessionId: string, limit = 50): WakeEvent[] {
  return conn.all('SELECT * FROM wake_events WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?', [sessionId, limit]).map(wakeEvent)
}

/** The events not yet delivered, oldest first: of one session, or of every session. */
export function listPendingWakeEvents(conn: Conn, sessionId: string | null = null): WakeEvent[] {
  return (sessionId === null
    ? conn.all("SELECT * FROM wake_events WHERE status='pending' ORDER BY created_at, rowid")
    : conn.all("SELECT * FROM wake_events WHERE status='pending' AND session_id=? ORDER BY created_at, rowid", [sessionId])).map(wakeEvent)
}

export function settleWakeEvents(conn: Conn, ids: string[], status: 'delivered' | 'dropped', runId: string | null): void {
  const t = nowIso()
  for (const id of ids) conn.run("UPDATE wake_events SET status=?, run_id=?, delivered_at=? WHERE id=? AND status='pending'", [status, runId, t, id])
}

/** How many runs of the session a spawner started since `sinceIso` (the watches' hourly limit). */
export function countRunsSince(conn: Conn, sessionId: string, spawnedBy: string, sinceIso: string): number {
  return Number(conn.get('SELECT count(*) AS n FROM runs WHERE session_id=? AND spawned_by=? AND created_at>=?', [sessionId, spawnedBy, sinceIso])!.n)
}

// -- the journal of a folder edited in place (schema v19) ---------------------------

/** Every column of file_journal but the two blobs, which `journalEntry` never reads (journalBytes reads one when asked).
 *  Used where it was measured to help — one entry by id, and the prepared / unsettled entries, a few rows picked out of
 *  many — and not by listJournal / listJournalUndos, which return the rows they visit and measured no faster with it. */
export const JOURNAL_COLUMNS = ['id', 'workspace_id', 'session_id', 'run_id', 'tool_call_id', 'path', 'action', 'state', 'before_exists',
  'before_sha', 'after_sha', 'undone_by', 'created_at', 'intended_sha'].join(', ')

function journalEntry(row: Row): JournalEntry {
  return {
    id: s(row.id), workspace_id: s(row.workspace_id), session_id: sn(row.session_id), run_id: sn(row.run_id), tool_call_id: sn(row.tool_call_id),
    path: s(row.path), action: s(row.action) as JournalEntry['action'], state: s(row.state) as JournalEntry['state'], before_exists: b(row.before_exists),
    before_sha: sn(row.before_sha), after_sha: sn(row.after_sha), intended_sha: sn(row.intended_sha), undone_by: sn(row.undone_by), created_at: s(row.created_at),
  }
}

/** A write about to happen, kept first: the file as it is (null: not there) and the sha of what the write means to
 *  leave (null: a removal). An undo names the entries it takes back (`undoes`): they are marked in the same
 *  transaction, so wherever a stop falls they stay with an entry that is settled like any other write. */
export function prepareJournalEntry(conn: Conn, o: {
  workspace_id: string; session_id: string | null; run_id: string | null; tool_call_id: string | null; path: string; action: JournalEntry['action'];
  before: Uint8Array | null; before_sha: string | null; intended_sha: string | null; undoes?: string[]
}): JournalEntry {
  const id = newId('fj')
  conn.transaction(() => {
    conn.run(`INSERT INTO file_journal (id, workspace_id, session_id, run_id, tool_call_id, path, action, state, before_exists, before_blob, before_sha, intended_sha, created_at)
      VALUES (?,?,?,?,?,?,?,'prepared',?,?,?,?,?)`, [id, o.workspace_id, o.session_id, o.run_id, o.tool_call_id, o.path, o.action, o.before === null ? 0 : 1, o.before, o.before_sha, o.intended_sha, nowIso()])
    for (const undone of o.undoes ?? []) conn.run('UPDATE file_journal SET undone_by=? WHERE id=? AND undone_by IS NULL', [id, undone])
  })
  return getJournalEntry(conn, id)!
}

/** The write happened: the file as written (null: removed). */
export function applyJournalEntry(conn: Conn, id: string, after: Uint8Array | null, afterSha: string | null): void {
  conn.run("UPDATE file_journal SET state='applied', after_blob=?, after_sha=? WHERE id=?", [after, afterSha, id])
}

/** A kept write settled as not the harness's: abandoned (it did not happen) or unsettled (the file is neither as kept
 *  nor as meant). The entries an undo had marked stand again: it did not take them back. */
export function settleJournalEntry(conn: Conn, id: string, state: 'abandoned' | 'unsettled'): void {
  conn.transaction(() => {
    const changed = conn.run("UPDATE file_journal SET state=? WHERE id=? AND state='prepared'", [state, id]).changes
    if (changed) conn.run('UPDATE file_journal SET undone_by=NULL WHERE undone_by=?', [id])
  })
}

export function getJournalEntry(conn: Conn, id: string): JournalEntry | null {
  const row = conn.get(`SELECT ${JOURNAL_COLUMNS} FROM file_journal WHERE id=?`, [id])
  return row ? journalEntry(row) : null
}

/** A journal entry's bytes: the file before the write, or as written (null when there was none). */
export function journalBytes(conn: Conn, id: string, which: 'before' | 'after'): Uint8Array | null {
  const row = conn.get(`SELECT ${which === 'before' ? 'before_blob' : 'after_blob'} AS data FROM file_journal WHERE id=?`, [id])
  const data = row?.data
  return data === null || data === undefined ? null : data instanceof Uint8Array ? data : new Uint8Array(Buffer.from(data as ArrayBuffer))
}

/** The writes that happened (applied) — of a run, or of a workspace — oldest first. */
export function listJournal(conn: Conn, o: { run_id?: string; workspace_id?: string }): JournalEntry[] {
  if (o.run_id !== undefined) return conn.all("SELECT * FROM file_journal WHERE run_id=? AND state='applied' ORDER BY created_at, rowid", [o.run_id]).map(journalEntry)
  return conn.all("SELECT * FROM file_journal WHERE workspace_id=? AND state='applied' ORDER BY created_at, rowid", [o.workspace_id ?? '']).map(journalEntry)
}

/** Writes kept but never marked as written or abandoned (the harness stopped between the two): of a run, or all. */
export function listPreparedJournal(conn: Conn, runId?: string): JournalEntry[] {
  if (runId !== undefined) return conn.all(`SELECT ${JOURNAL_COLUMNS} FROM file_journal WHERE state='prepared' AND run_id=? ORDER BY created_at, rowid`, [runId]).map(journalEntry)
  return conn.all(`SELECT ${JOURNAL_COLUMNS} FROM file_journal WHERE state='prepared' ORDER BY created_at, rowid`).map(journalEntry)
}

/** A run's writes the harness stopped in the middle of and found neither undone nor as meant (state unsettled). */
export function listUnsettledJournal(conn: Conn, runId: string): JournalEntry[] {
  return conn.all(`SELECT ${JOURNAL_COLUMNS} FROM file_journal WHERE state='unsettled' AND run_id=? ORDER BY created_at, rowid`, [runId]).map(journalEntry)
}

/** The undos in a workspace from a moment on (a person's, over the API): each file put back or removed, oldest first.
 *  From the moment itself: an undo is refused while the run it follows still writes, so one stamped in the same
 *  millisecond came after it. */
export function listJournalUndos(conn: Conn, workspaceId: string, sinceIso: string): JournalEntry[] {
  return conn.all("SELECT * FROM file_journal WHERE workspace_id=? AND run_id IS NULL AND state='applied' AND created_at>=? ORDER BY created_at, rowid", [workspaceId, sinceIso]).map(journalEntry)
}

// -- Intelligent UI (schema v21) ---------------------------------------------

/** A surface's spec as stored, or (a row that no longer reads) an envelope that renders as its fallback. */
function uiSpecOf(row: Row): UiSurfaceRecord['spec'] {
  const spec = d<unknown>(row.spec_json, null)
  if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    const o = spec as Record<string, unknown>
    if (typeof o.version === 'number' && typeof o.title === 'string' && typeof o.fallback === 'string' && typeof o.kind === 'string') return o as UiSurfaceRecord['spec']
  }
  return { version: 0, surface_id: s(row.surface_id), title: s(row.surface_id), fallback: 'This surface could not be read.', kind: 'unknown' }
}

function uiSurface(row: Row): UiSurfaceRecord {
  const state = d<unknown>(row.state_json, {})
  return {
    session_id: s(row.session_id), run_id: s(row.run_id), surface_id: s(row.surface_id),
    // a row written before v23 has no scope (`run`) and no writer (its own run)
    scope: row.scope === 'session' ? 'session' : 'run',
    updated_by_run_id: typeof row.updated_by_run_id === 'string' && row.updated_by_run_id !== '' ? row.updated_by_run_id : s(row.run_id),
    revision: n(row.revision),
    spec: uiSpecOf(row), state: state && typeof state === 'object' && !Array.isArray(state) ? (state as UiState) : {},
    model: sn(row.model), created_at: s(row.created_at), updated_at: s(row.updated_at),
  }
}

/** The row at (session, run, surface_id) whatever its scope: the routes' path names a session surface by its anchor
 *  run, so the person's values, actions and tasks reach both kinds (each still checked on its revision). */
export function getUiSurface(conn: Conn, sessionId: string, runId: string, surfaceId: string): UiSurfaceRecord | null {
  const row = conn.get('SELECT * FROM ui_surfaces WHERE session_id=? AND run_id=? AND surface_id=?', [sessionId, runId, surfaceId])
  return row ? uiSurface(row) : null
}

/** A run's own `run` surface: a session surface anchored at the same run is never read as one. */
export function getRunUiSurface(conn: Conn, sessionId: string, runId: string, surfaceId: string): UiSurfaceRecord | null {
  const row = conn.get("SELECT * FROM ui_surfaces WHERE session_id=? AND run_id=? AND surface_id=? AND scope='run'", [sessionId, runId, surfaceId])
  return row ? uiSurface(row) : null
}

/** A session's `session` surface by its id (one per session and id), whichever run anchors it. */
export function getSessionUiSurface(conn: Conn, sessionId: string, surfaceId: string): UiSurfaceRecord | null {
  const row = conn.get("SELECT * FROM ui_surfaces WHERE session_id=? AND surface_id=? AND scope='session'", [sessionId, surfaceId])
  return row ? uiSurface(row) : null
}

/** How many `session` surfaces a session holds. */
export function countSessionUiSurfaces(conn: Conn, sessionId: string): number {
  return n(conn.get("SELECT count(*) AS c FROM ui_surfaces WHERE session_id=? AND scope='session'", [sessionId])?.c ?? 0)
}

/** A session's surfaces (or the ones a run anchors), in the order they were first presented. */
export function listUiSurfaces(conn: Conn, sessionId: string, runId?: string): UiSurfaceRecord[] {
  if (runId !== undefined) return conn.all('SELECT * FROM ui_surfaces WHERE session_id=? AND run_id=? ORDER BY created_at, rowid', [sessionId, runId]).map(uiSurface)
  return conn.all('SELECT * FROM ui_surfaces WHERE session_id=? ORDER BY created_at, rowid', [sessionId]).map(uiSurface)
}

/** What a run published, from the journal (its own writes only, of either scope — never the revisions other runs
 *  wrote to a session surface it updated): the surfaces it wrote to and the revisions it wrote. */
export function countUiRevisions(conn: Conn, runId: string): { surfaces: number; revisions: number } {
  const row = conn.get('SELECT count(DISTINCT session_id || char(31) || anchor_run_id || char(31) || surface_id) AS c, count(*) AS r FROM ui_publications WHERE writer_run_id=?', [runId])
  return { surfaces: n(row?.c ?? 0), revisions: n(row?.r ?? 0) }
}

/** Whether a run has written a revision of this surface (anchor run + id) before. */
export function hasUiPublication(conn: Conn, writerRunId: string, sessionId: string, anchorRunId: string, surfaceId: string): boolean {
  return conn.get('SELECT 1 AS x FROM ui_publications WHERE writer_run_id=? AND session_id=? AND anchor_run_id=? AND surface_id=? LIMIT 1', [writerRunId, sessionId, anchorRunId, surfaceId]) !== null
}

export interface UiPublicationRow { session_id: string; anchor_run_id: string; surface_id: string; revision: number; writer_run_id: string; created_at: string }

/** One revision published: written in the transaction that writes the revision (a revision is journalled once — the
 *  key is the surface and its revision). */
export function insertUiPublication(conn: Conn, r: Omit<UiPublicationRow, 'created_at'>): void {
  conn.run('INSERT INTO ui_publications (session_id, anchor_run_id, surface_id, revision, writer_run_id, created_at) VALUES (?,?,?,?,?,?)',
    [r.session_id, r.anchor_run_id, r.surface_id, r.revision, r.writer_run_id, nowIso()])
}

export function listUiPublications(conn: Conn, sessionId: string, surfaceId?: string): UiPublicationRow[] {
  const rows = surfaceId === undefined
    ? conn.all('SELECT * FROM ui_publications WHERE session_id=? ORDER BY created_at, rowid', [sessionId])
    : conn.all('SELECT * FROM ui_publications WHERE session_id=? AND surface_id=? ORDER BY created_at, rowid', [sessionId, surfaceId])
  return rows.map((row) => ({
    session_id: s(row.session_id), anchor_run_id: s(row.anchor_run_id), surface_id: s(row.surface_id), revision: n(row.revision),
    writer_run_id: s(row.writer_run_id), created_at: s(row.created_at),
  }))
}

/** A row's next updated_at: now, or — when now is not later than the row's last stamp (the same millisecond, a clock
 *  set back) — one millisecond after it. Every write of a surface row takes one, inside its transaction, so the
 *  stamps of one surface strictly increase (ISO 8601 UTC: string order is time order). */
function laterUiStamp(conn: Conn, sessionId: string, runId: string, surfaceId: string): string {
  const now = nowIso()
  const row = conn.get('SELECT updated_at FROM ui_surfaces WHERE session_id=? AND run_id=? AND surface_id=?', [sessionId, runId, surfaceId])
  const prev = row ? s(row.updated_at) : null
  if (prev === null || now > prev) return now
  const t = Date.parse(prev)
  return Number.isFinite(t) ? new Date(t + 1).toISOString() : now
}

/** Write a `run` surface's revision (insert the first, replace the spec and the state of a later one); the updated_at
 *  it was written with (later than any before it for this surface), or null when the row at that key is a session
 *  surface (never overwritten from here: it changes only through its own revision check). */
export function putUiSurface(conn: Conn, r: UiSurfaceRecord): string | null {
  const stamp = laterUiStamp(conn, r.session_id, r.run_id, r.surface_id)
  const changes = conn.run(
    'INSERT INTO ui_surfaces (session_id, run_id, surface_id, revision, spec_json, state_json, model, created_at, updated_at, scope, updated_by_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    + ' ON CONFLICT(session_id, run_id, surface_id) DO UPDATE SET revision=excluded.revision, spec_json=excluded.spec_json,'
    + " state_json=excluded.state_json, model=excluded.model, updated_at=excluded.updated_at, updated_by_run_id=excluded.updated_by_run_id WHERE ui_surfaces.scope='run'",
    [r.session_id, r.run_id, r.surface_id, r.revision, j(r.spec), j(r.state), r.model, r.created_at, stamp, 'run', r.run_id]).changes
  return changes === 1 ? stamp : null
}

/** Create a `session` surface (its first revision): false when the session has one of that id already, or the anchor
 *  run has a surface of that id (the keys are unique; nothing is written then). */
export function insertSessionUiSurface(conn: Conn, r: UiSurfaceRecord & { updated_by_run_id: string }): string | null {
  const stamp = laterUiStamp(conn, r.session_id, r.run_id, r.surface_id)
  try {
    conn.run(
      'INSERT INTO ui_surfaces (session_id, run_id, surface_id, revision, spec_json, state_json, model, created_at, updated_at, scope, updated_by_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [r.session_id, r.run_id, r.surface_id, r.revision, j(r.spec), j(r.state), r.model, r.created_at, stamp, 'session', r.updated_by_run_id])
  } catch (error) {
    if (String((error as { code?: unknown }).code ?? '').startsWith('SQLITE_CONSTRAINT')) return null
    throw error
  }
  return stamp
}

/** Write the next revision of a `session` surface, only while it is at `expected` (compare and set): the updated_at
 *  it was written with, or null when it is not (nothing written). */
export function updateSessionUiSurface(conn: Conn, r: UiSurfaceRecord & { updated_by_run_id: string }, expected: number): string | null {
  const stamp = laterUiStamp(conn, r.session_id, r.run_id, r.surface_id)
  const changes = conn.run(
    "UPDATE ui_surfaces SET revision=?, spec_json=?, state_json=?, model=?, updated_at=?, updated_by_run_id=? WHERE session_id=? AND run_id=? AND surface_id=? AND scope='session' AND revision=?",
    [r.revision, j(r.spec), j(r.state), r.model, stamp, r.updated_by_run_id, r.session_id, r.run_id, r.surface_id, expected]).changes
  return changes === 1 ? stamp : null
}

/** The person's values, at the revision they were entered on (a surface republished since keeps its own). */
export function setUiSurfaceState(conn: Conn, sessionId: string, runId: string, surfaceId: string, revision: number, state: UiState): boolean {
  return conn.transaction(() => conn.run('UPDATE ui_surfaces SET state_json=?, updated_at=? WHERE session_id=? AND run_id=? AND surface_id=? AND revision=?',
    [j(state), laterUiStamp(conn, sessionId, runId, surfaceId), sessionId, runId, surfaceId, revision]).changes === 1)
}

export interface UiActionReceiptRow {
  id: string; session_id: string; run_id: string; surface_id: string; request_id: string; revision: number; action_id: string
  payload_sha: string; state: UiState; prompt: string; created_at: string
}

function uiReceipt(row: Row): UiActionReceiptRow {
  return {
    id: s(row.id), session_id: s(row.session_id), run_id: s(row.run_id), surface_id: s(row.surface_id), request_id: s(row.request_id),
    revision: n(row.revision), action_id: s(row.action_id), payload_sha: s(row.payload_sha), state: d(row.state_json, {}),
    prompt: s(row.prompt), created_at: s(row.created_at),
  }
}

export function getUiActionReceipt(conn: Conn, sessionId: string, requestId: string): UiActionReceiptRow | null {
  const row = conn.get('SELECT * FROM ui_action_receipts WHERE session_id=? AND request_id=?', [sessionId, requestId])
  return row ? uiReceipt(row) : null
}

export function insertUiActionReceipt(conn: Conn, r: Omit<UiActionReceiptRow, 'id' | 'created_at'>): UiActionReceiptRow {
  const id = newId('uia')
  conn.run('INSERT INTO ui_action_receipts (id, session_id, run_id, surface_id, request_id, revision, action_id, payload_sha, state_json, prompt, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, r.session_id, r.run_id, r.surface_id, r.request_id, r.revision, r.action_id, r.payload_sha, j(r.state), r.prompt, nowIso()])
  return uiReceipt(conn.get('SELECT * FROM ui_action_receipts WHERE id=?', [id])!)
}

// -- Intelligent UI interaction (schema v22) ------------------------------------

/** A row's next updated_at in `table` (ui_tasks, ui_inputs): now, or one millisecond after its last stamp when now is
 *  not later — the stamps of one row strictly increase. */
function laterRowStamp(conn: Conn, table: 'ui_tasks' | 'ui_inputs', id: string): string {
  const now = nowIso()
  const row = conn.get(`SELECT updated_at FROM ${table} WHERE id=?`, [id])
  const prev = row ? s(row.updated_at) : null
  if (prev === null || now > prev) return now
  const t = Date.parse(prev)
  return Number.isFinite(t) ? new Date(t + 1).toISOString() : now
}

/** A task as stored: the contract's record, and what the server keeps beside it (the request's payload hash, the
 *  prompt its run is sent, the last ok / message return_ui_result reported). */
export interface UiTaskRow {
  record: UiTaskRecord
  payload_sha: string
  prompt: string
  reported_ok: boolean | null
  reported_message: string | null
}

function uiTaskRow(row: Row): UiTaskRow {
  const error = d<unknown>(row.error_json, null)
  const record: UiTaskRecord = {
    id: s(row.id), session_id: s(row.session_id), surface_run_id: s(row.surface_run_id), surface_id: s(row.surface_id), revision: n(row.revision),
    action_id: s(row.action_id), request_id: s(row.request_id), agent_run_id: sn(row.agent_run_id), status: s(row.status) as UiTaskStatus,
    input: row.input_json === null || row.input_json === undefined ? null : d<unknown>(row.input_json, null),
    text: s(row.text ?? ''), data: row.data_json === null || row.data_json === undefined ? null : d<unknown>(row.data_json, null),
    error: error && typeof error === 'object' && typeof (error as UiTaskError).code === 'string' ? { code: String((error as UiTaskError).code), message: String((error as UiTaskError).message ?? '') } : null,
    created_at: s(row.created_at), started_at: sn(row.started_at), finished_at: sn(row.finished_at), updated_at: s(row.updated_at),
  }
  return { record, payload_sha: s(row.payload_sha), prompt: s(row.prompt), reported_ok: row.reported_ok === null || row.reported_ok === undefined ? null : b(row.reported_ok), reported_message: sn(row.reported_message) }
}

export function insertUiTask(conn: Conn, t: {
  id: string; session_id: string; surface_run_id: string; surface_id: string; revision: number; action_id: string; request_id: string
  payload_sha: string; prompt: string; input: unknown
}): UiTaskRow {
  const now = nowIso()
  conn.run('INSERT INTO ui_tasks (id, session_id, surface_run_id, surface_id, revision, action_id, request_id, payload_sha, prompt, agent_run_id, status, input_json,'
    + " text, data_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,'queued',?,'',NULL,?,?)",
    [t.id, t.session_id, t.surface_run_id, t.surface_id, t.revision, t.action_id, t.request_id, t.payload_sha, t.prompt, t.input === undefined || t.input === null ? null : j(t.input), now, now])
  return getUiTaskRow(conn, t.id)!
}

export function getUiTaskRow(conn: Conn, taskId: string): UiTaskRow | null {
  const row = conn.get('SELECT * FROM ui_tasks WHERE id=?', [taskId])
  return row ? uiTaskRow(row) : null
}

export function getUiTask(conn: Conn, taskId: string): UiTaskRecord | null {
  return getUiTaskRow(conn, taskId)?.record ?? null
}

export function getUiTaskByRequest(conn: Conn, sessionId: string, requestId: string): UiTaskRow | null {
  const row = conn.get('SELECT * FROM ui_tasks WHERE session_id=? AND request_id=?', [sessionId, requestId])
  return row ? uiTaskRow(row) : null
}

/** The task a run is doing (null: the run is no task's). */
export function uiTaskOfRun(conn: Conn, runId: string): UiTaskRecord | null {
  const row = conn.get('SELECT * FROM ui_tasks WHERE agent_run_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', [runId])
  return row ? uiTaskRow(row).record : null
}

/** A session's tasks, newest first: all, one surface's, the active ones. */
export function listUiTasks(conn: Conn, sessionId: string, o: { surface_run_id?: string; surface_id?: string; active?: boolean; limit?: number } = {}): UiTaskRecord[] {
  const where = ['session_id=?']
  const params: Param[] = [sessionId]
  if (o.surface_run_id !== undefined) { where.push('surface_run_id=?'); params.push(o.surface_run_id) }
  if (o.surface_id !== undefined) { where.push('surface_id=?'); params.push(o.surface_id) }
  if (o.active) where.push("status IN ('queued','running')")
  params.push(o.limit ?? 50)
  return conn.all(`SELECT * FROM ui_tasks WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`, params).map((r) => uiTaskRow(r).record)
}

/** The session's oldest queued task (the next to start), or null. */
export function nextQueuedUiTask(conn: Conn, sessionId: string): UiTaskRow | null {
  const row = conn.get("SELECT * FROM ui_tasks WHERE session_id=? AND status='queued' ORDER BY created_at, rowid LIMIT 1", [sessionId])
  return row ? uiTaskRow(row) : null
}

export function countQueuedUiTasks(conn: Conn, sessionId: string): number {
  return n(conn.get("SELECT count(*) AS c FROM ui_tasks WHERE session_id=? AND status='queued'", [sessionId])?.c ?? 0)
}

/** The sessions with a queued task. */
export function sessionsWithQueuedUiTasks(conn: Conn): string[] {
  return conn.all("SELECT DISTINCT session_id FROM ui_tasks WHERE status='queued'").map((r) => s(r.session_id))
}

/** A queued task taken by its run: running, the run's id, started now. False when it was no longer queued. */
export function bindUiTask(conn: Conn, taskId: string, runId: string): boolean {
  return conn.transaction(() => {
    const t = nowIso()
    return conn.run("UPDATE ui_tasks SET status='running', agent_run_id=?, started_at=?, updated_at=? WHERE id=? AND status='queued'",
      [runId, t, laterRowStamp(conn, 'ui_tasks', taskId), taskId]).changes === 1
  })
}

/** return_ui_result: the running task's data replaced, and what it reported (ok, message). False when the task is
 *  not that run's running task. */
export function setUiTaskResult(conn: Conn, taskId: string, runId: string, data: unknown, ok: boolean, message: string | null): boolean {
  return conn.transaction(() => conn.run("UPDATE ui_tasks SET data_json=?, reported_ok=?, reported_message=?, updated_at=? WHERE id=? AND agent_run_id=? AND status='running'",
    [data === undefined || data === null ? null : j(data), ok ? 1 : 0, message, laterRowStamp(conn, 'ui_tasks', taskId), taskId, runId]).changes === 1)
}

/** A task's end: its terminal status, text and error. `from` names the statuses it may end from (a terminal task
 *  never changes again); `runId`, when given, must be the run doing it. False when nothing was written. */
export function endUiTask(conn: Conn, taskId: string, end: { status: 'succeeded' | 'failed' | 'cancelled'; text?: string; error: UiTaskError | null; from: ('queued' | 'running')[]; run_id?: string }): boolean {
  return conn.transaction(() => {
    const where = [`id=?`, `status IN (${end.from.map(() => '?').join(',')})`]
    const params: Param[] = [end.status, end.text ?? '', end.error === null ? null : j(end.error), nowIso(), laterRowStamp(conn, 'ui_tasks', taskId), taskId, ...end.from]
    if (end.run_id !== undefined) { where.push('agent_run_id=?'); params.push(end.run_id) }
    return conn.run(`UPDATE ui_tasks SET status=?, text=?, error_json=?, finished_at=?, updated_at=? WHERE ${where.join(' AND ')}`, params).changes === 1
  })
}

/** Startup: tasks left queued or running by a process that died. */
export function activeUiTasks(conn: Conn): UiTaskRow[] {
  return conn.all("SELECT * FROM ui_tasks WHERE status IN ('queued','running') ORDER BY created_at, rowid").map(uiTaskRow)
}

/** A request_input as stored: the contract's record and the request id its answer came with. */
export interface UiInputRow { record: UiInputRecord; answer_request_id: string | null }

function uiInputRow(row: Row): UiInputRow {
  const values = row.values_json === null || row.values_json === undefined ? null : d<unknown>(row.values_json, null)
  const reason = sn(row.closed_reason)
  const record: UiInputRecord = {
    id: s(row.id), session_id: s(row.session_id), run_id: s(row.run_id), tool_call_id: s(row.tool_call_id),
    request: d<UiInputRecord['request']>(row.request_json, { title: '' } as UiInputRecord['request']), status: s(row.status) as UiInputStatus,
    values: values && typeof values === 'object' && !Array.isArray(values) ? (values as UiState) : null,
    closed_reason: reason === 'cancelled' || reason === 'budget' || reason === 'interrupted' ? reason : null,
    created_at: s(row.created_at), answered_at: sn(row.answered_at), updated_at: s(row.updated_at),
  }
  return { record, answer_request_id: sn(row.answer_request_id) }
}

export function insertUiInput(conn: Conn, r: { session_id: string; run_id: string; tool_call_id: string; request: unknown }): UiInputRecord {
  const id = newId('uin')
  const now = nowIso()
  conn.run("INSERT INTO ui_inputs (id, session_id, run_id, tool_call_id, request_json, status, created_at, updated_at) VALUES (?,?,?,?,?,'pending',?,?)",
    [id, r.session_id, r.run_id, r.tool_call_id, j(r.request), now, now])
  return getUiInput(conn, id)!
}

export function getUiInputRow(conn: Conn, inputId: string): UiInputRow | null {
  const row = conn.get('SELECT * FROM ui_inputs WHERE id=?', [inputId])
  return row ? uiInputRow(row) : null
}

export function getUiInput(conn: Conn, inputId: string): UiInputRecord | null {
  return getUiInputRow(conn, inputId)?.record ?? null
}

export function listUiInputs(conn: Conn, sessionId: string, o: { run_id?: string; status?: UiInputStatus; limit?: number } = {}): UiInputRecord[] {
  const where = ['session_id=?']
  const params: Param[] = [sessionId]
  if (o.run_id !== undefined) { where.push('run_id=?'); params.push(o.run_id) }
  if (o.status !== undefined) { where.push('status=?'); params.push(o.status) }
  params.push(o.limit ?? 50)
  return conn.all(`SELECT * FROM ui_inputs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`, params).map((r) => uiInputRow(r).record)
}

export function countUiInputsOfRun(conn: Conn, runId: string): number {
  return n(conn.get('SELECT count(*) AS c FROM ui_inputs WHERE run_id=?', [runId])?.c ?? 0)
}

/** A pending request answered (submitted with its values, dismissed) or closed (with its reason). False when it
 *  was no longer pending. */
export function answerUiInput(conn: Conn, inputId: string, a: { status: 'submitted' | 'dismissed' | 'closed'; values?: UiState | null; closed_reason?: UiInputClosedReason | null; request_id?: string | null }): boolean {
  return conn.transaction(() => {
    const t = nowIso()
    return conn.run("UPDATE ui_inputs SET status=?, values_json=?, closed_reason=?, answer_request_id=?, answered_at=?, updated_at=? WHERE id=? AND status='pending'",
      [a.status, a.values ? j(a.values) : null, a.closed_reason ?? null, a.request_id ?? null, t, laterRowStamp(conn, 'ui_inputs', inputId), inputId]).changes === 1
  })
}

/** Startup: the requests a process that died left waiting. */
export function pendingUiInputs(conn: Conn): UiInputRecord[] {
  return conn.all("SELECT * FROM ui_inputs WHERE status='pending' ORDER BY created_at, rowid").map((r) => uiInputRow(r).record)
}
