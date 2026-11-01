/** Rows of the collaboration model (schema v25): participants, conversations, typed edges, and the runs' v25 columns.
 *  Additive only: nothing here updates a row written before v25 (an older run's participant and conversation are
 *  projected when read, agent/collab_projection.ts); a participant or conversation a new run joins is written with the
 *  same deterministic id the projection gives it. */

import type { Origin, Placement } from '@oasis-code/contract'
import { createHash } from 'node:crypto'
import { nowIso } from '../timebase.ts'
import type { Conn, Row } from './database.ts'
import { DbReadCache, jsonWeight } from './read_cache.ts'

const j = (value: unknown): string => JSON.stringify(value)
function d<T>(text: unknown, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback
  try { return JSON.parse(String(text)) as T } catch { return fallback }
}
const s = (v: unknown): string => String(v)
const sn = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

export function sha16(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** A participant's id: the same for a projected (pre-v25) participant and the row a later run of it writes. */
export function participantIdOf(sessionId: string, key: string): string {
  return `pa_${sha16(`${sessionId}|${key}`)}`
}

/** A conversation's id, from its participant and its first run. */
export function conversationIdOf(sessionId: string, participantId: string, firstRunId: string): string {
  return `cv_${sha16(`${sessionId}|${participantId}|${firstRunId}`)}`
}

/** An edge's id: one per (kind, from, to). */
export function edgeIdOf(kind: string, fromKind: string, fromId: string, toKind: string, toId: string): string {
  return `eg_${sha16(`${kind}|${fromKind}:${fromId}|${toKind}:${toId}`)}`
}

// -- participants ------------------------------------------------------------------------------------------------------

export interface ParticipantRow {
  id: string; session_id: string; role: string; alias: string | null; label: string; model: string | null
  group_kind: string | null; group_id: string | null; legacy_key: string; introduced_by: Origin | null; created_at: string; updated_at: string
}

function participant(row: Row): ParticipantRow {
  return {
    id: s(row.id), session_id: s(row.session_id), role: s(row.role), alias: sn(row.alias), label: s(row.label ?? ''), model: sn(row.model),
    group_kind: sn(row.group_kind), group_id: sn(row.group_id), legacy_key: s(row.legacy_key), introduced_by: d<Origin | null>(row.introduced_by_json, null),
    created_at: s(row.created_at), updated_at: s(row.updated_at),
  }
}

export function getParticipant(conn: Conn, id: string): ParticipantRow | null {
  const row = conn.get('SELECT * FROM participants WHERE id=?', [id])
  return row ? participant(row) : null
}

export function listParticipants(conn: Conn, sessionId: string): ParticipantRow[] {
  return conn.all('SELECT * FROM participants WHERE session_id=? ORDER BY created_at, rowid', [sessionId]).map(participant)
}

/** The participant's row, written once (a second write of the same id keeps the first and refreshes model/label). */
export function ensureParticipant(conn: Conn, p: Omit<ParticipantRow, 'created_at' | 'updated_at'> & { created_at?: string }): ParticipantRow {
  const t = nowIso()
  const existing = getParticipant(conn, p.id)
  if (existing === null) {
    conn.run('INSERT INTO participants (id, session_id, role, alias, label, model, group_kind, group_id, legacy_key, introduced_by_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [p.id, p.session_id, p.role, p.alias, p.label, p.model, p.group_kind, p.group_id, p.legacy_key, p.introduced_by ? j(p.introduced_by) : null, p.created_at ?? t, t])
  } else {
    conn.run('UPDATE participants SET model=COALESCE(?, model), updated_at=? WHERE id=?', [p.model, t, p.id])
  }
  return getParticipant(conn, p.id)!
}

// -- conversations -----------------------------------------------------------------------------------------------------

export interface ToolSnapshot {
  /** the agent tool surface the snapshot is of */
  surface: string
  /** recorded: made by this conversation's first run (v25+); reconstructed: an older conversation's list rebuilt from
   *  its last run's manifest and matching its recorded schema fingerprint; legacy-unpinned: an older conversation whose
   *  recorded list could not be matched byte for byte — the names its record lists, as the registry describes them now
   *  (no tool it did not have is added) */
  basis: 'recorded' | 'reconstructed' | 'legacy-unpinned'
  names: string[]
  rows: { name: string; description: string; parameters: Record<string, unknown> }[]
  sha256: string
}

export interface ConversationRow {
  id: string; session_id: string; participant_id: string; forked_from_run_id: string | null; fork_reason: string | null
  root_run_id: string | null; head_run_id: string | null; tool_surface: string | null; tool_snapshot: ToolSnapshot | null; created_at: string; updated_at: string
}

function conversation(row: Row): ConversationRow {
  return {
    id: s(row.id), session_id: s(row.session_id), participant_id: s(row.participant_id), forked_from_run_id: sn(row.forked_from_run_id),
    fork_reason: sn(row.fork_reason), root_run_id: sn(row.root_run_id), head_run_id: sn(row.head_run_id), tool_surface: sn(row.tool_surface),
    tool_snapshot: d<ToolSnapshot | null>(row.tool_snapshot_json, null), created_at: s(row.created_at), updated_at: s(row.updated_at),
  }
}

export function getConversation(conn: Conn, id: string): ConversationRow | null {
  const row = conn.get('SELECT * FROM conversations WHERE id=?', [id])
  return row ? conversation(row) : null
}

export function listConversations(conn: Conn, sessionId: string): ConversationRow[] {
  return conn.all('SELECT * FROM conversations WHERE session_id=? ORDER BY created_at, rowid', [sessionId]).map(conversation)
}

export function ensureConversation(conn: Conn, c: Omit<ConversationRow, 'created_at' | 'updated_at'> & { created_at?: string }): ConversationRow {
  const existing = getConversation(conn, c.id)
  if (existing !== null) return existing
  const t = nowIso()
  conn.run('INSERT INTO conversations (id, session_id, participant_id, forked_from_run_id, fork_reason, root_run_id, head_run_id, tool_surface, tool_snapshot_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [c.id, c.session_id, c.participant_id, c.forked_from_run_id, c.fork_reason, c.root_run_id, c.head_run_id, c.tool_surface, c.tool_snapshot ? j(c.tool_snapshot) : null, c.created_at ?? t, t])
  return getConversation(conn, c.id)!
}

export function setConversationHead(conn: Conn, id: string, runId: string): void {
  conn.run('UPDATE conversations SET head_run_id=?, root_run_id=COALESCE(root_run_id, ?), updated_at=? WHERE id=?', [runId, runId, nowIso(), id])
}

export function setConversationSnapshot(conn: Conn, id: string, surface: string, snapshot: ToolSnapshot): void {
  conn.run('UPDATE conversations SET tool_surface=COALESCE(tool_surface, ?), tool_snapshot_json=COALESCE(tool_snapshot_json, ?), updated_at=? WHERE id=?', [surface, j(snapshot), nowIso(), id])
}

// -- edges -------------------------------------------------------------------------------------------------------------

export interface EdgeRow {
  id: string; session_id: string; kind: string; from_kind: string; from_id: string; to_kind: string; to_id: string; meta: Record<string, unknown>; created_at: string
}

function edge(row: Row): EdgeRow {
  return {
    id: s(row.id), session_id: s(row.session_id), kind: s(row.kind), from_kind: s(row.from_kind), from_id: s(row.from_id),
    to_kind: s(row.to_kind), to_id: s(row.to_id), meta: d<Record<string, unknown>>(row.meta_json, {}), created_at: s(row.created_at),
  }
}

export interface NewEdge { kind: string; from: { kind: string; id: string }; to: { kind: string; id: string }; meta: Record<string, unknown> }

/** An edge written once: the same (kind, from, to) again is the edge already there. */
export function insertEdge(conn: Conn, sessionId: string, e: NewEdge): EdgeRow {
  const id = edgeIdOf(e.kind, e.from.kind, e.from.id, e.to.kind, e.to.id)
  conn.run('INSERT OR IGNORE INTO collab_edges (id, session_id, kind, from_kind, from_id, to_kind, to_id, meta_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, sessionId, e.kind, e.from.kind, e.from.id, e.to.kind, e.to.id, j(e.meta), nowIso()])
  return edge(conn.get('SELECT * FROM collab_edges WHERE id=?', [id])!)
}

export function listEdges(conn: Conn, sessionId: string): EdgeRow[] {
  return conn.all('SELECT * FROM collab_edges WHERE session_id=? ORDER BY created_at, rowid', [sessionId]).map(edge)
}

export function edgesOfRun(conn: Conn, runId: string): EdgeRow[] {
  return conn.all("SELECT * FROM collab_edges WHERE (from_kind='run' AND from_id=?) OR (to_kind='run' AND to_id=?) ORDER BY created_at, rowid", [runId, runId]).map(edge)
}

// -- the runs' v25 columns ------------------------------------------------------------------------------------------------

/** A run as the collaboration model reads it: no history, manifest or usage (a session's every run is read at once). */
export interface RunMeta {
  id: string; session_id: string; project_id: string; workspace_id: string | null; parent_run_id: string | null; resumes_run_id: string | null
  spawned_by: string; label: string | null; model: string; user_text: string; status: string; error: string | null
  created_at: string; finished_at: string | null; work_order: Record<string, unknown> | null; client_request_id: string | null
  relay_id: string | null; relay_step: number | null; interaction_id: string | null; interaction_node: string | null
  final_text_chars: number | null; history_empty: boolean
  participant_id: string | null; conversation_id: string | null; origin: Origin | null; placement: Placement | null; intent_sha: string | null
}

// octet_length(column) uses SQLite's stored byte count without materializing the history's overflow pages.
// CASE short-circuits; AND/OR need not. Keep the original equality for small values (including invalid JSON,
// whitespace and BLOBs). Four bytes also covers '[]' in a UTF-16 database; a longer value cannot be empty.
const META_COLUMNS = `r.id, r.session_id, r.project_id, r.workspace_id, r.parent_run_id, r.resumes_run_id, r.spawned_by, r.label, r.model, r.user_text, r.status, r.error,
  r.created_at, r.finished_at, r.work_order_json, r.client_request_id, r.relay_id, r.relay_step, r.interaction_id, r.interaction_node,
  length(json_extract(CASE WHEN json_valid(r.receipt_json) THEN r.receipt_json ELSE '{}' END, '$.final_text')) AS final_text_chars,
  (CASE WHEN octet_length(r.history_json) > 4 THEN 0
    ELSE (r.history_json IS NULL OR r.history_json = '' OR r.history_json = '[]') END) AS history_empty,
  c.participant_id, c.conversation_id, c.origin_json, c.placement_json, c.intent_sha`
const META_FROM = 'runs r LEFT JOIN run_collab c ON c.run_id = r.id'

function runMeta(row: Row): RunMeta {
  return {
    id: s(row.id), session_id: s(row.session_id), project_id: s(row.project_id), workspace_id: sn(row.workspace_id), parent_run_id: sn(row.parent_run_id),
    resumes_run_id: sn(row.resumes_run_id), spawned_by: s(row.spawned_by), label: sn(row.label), model: s(row.model), user_text: s(row.user_text),
    status: s(row.status), error: sn(row.error), created_at: s(row.created_at), finished_at: sn(row.finished_at),
    work_order: d<Record<string, unknown> | null>(row.work_order_json, null), client_request_id: sn(row.client_request_id),
    relay_id: sn(row.relay_id), relay_step: nn(row.relay_step), interaction_id: sn(row.interaction_id), interaction_node: sn(row.interaction_node),
    final_text_chars: nn(row.final_text_chars), history_empty: Boolean(Number(row.history_empty)),
    participant_id: sn(row.participant_id), conversation_id: sn(row.conversation_id), origin: d<Origin | null>(row.origin_json, null),
    placement: d<Placement | null>(row.placement_json, null), intent_sha: sn(row.intent_sha),
  }
}

// Only DB rows/fingerprints, not assignments, live handles, config labels, or permission decisions. Any DB write
// invalidates these; callers receive their own objects. No history blobs are retained.
const sessionMetas = new DbReadCache<RunMeta[]>(8, 8 * 1024 * 1024, jsonWeight)
const fingerprints = new DbReadCache<string>(128, 32 * 1024, (value) => value.length * 2)

/** Every run of a session as the collaboration model reads it, oldest first (rowid breaks a tie of times). */
export function listRunMetas(conn: Conn, sessionId: string): RunMeta[] {
  return structuredClone(sessionMetas.read(conn, sessionId, () =>
    conn.all(`SELECT ${META_COLUMNS} FROM runs r INDEXED BY runs_read LEFT JOIN run_collab c ON c.run_id = r.id WHERE r.session_id=? ORDER BY r.created_at, r.rowid`, [sessionId]).map(runMeta)))
}

export function getRunMeta(conn: Conn, runId: string): RunMeta | null {
  const row = conn.get(`SELECT ${META_COLUMNS} FROM ${META_FROM} WHERE r.id=?`, [runId])
  return row ? runMeta(row) : null
}

export function runIntentSha(conn: Conn, runId: string): string | null {
  const row = conn.get('SELECT intent_sha FROM run_collab WHERE run_id=?', [runId])
  return row ? sn(row.intent_sha) : null
}

/** A cheap fingerprint of everything the session's collaboration graph is read from: it moves whenever a run starts,
 *  changes status or ends, a group or its steps change, an edge or a participant is written, a director turn moves. */
export function collaborationFingerprint(conn: Conn, sessionId: string): string {
  return fingerprints.read(conn, sessionId, () => readCollaborationFingerprint(conn, sessionId))
}

function readCollaborationFingerprint(conn: Conn, sessionId: string): string {
  const parts: unknown[] = []
  parts.push(conn.get(`SELECT count(*) AS n, max(created_at) AS c, max(coalesce(finished_at, '')) AS f,
    group_concat(status, ',') AS st FROM (SELECT created_at, finished_at, status FROM runs INDEXED BY runs_read WHERE session_id=? ORDER BY created_at, rowid)`, [sessionId]))
  parts.push(conn.get('SELECT count(*) AS n, max(updated_at) AS u FROM interactions WHERE session_id=?', [sessionId]))
  parts.push(conn.get('SELECT count(*) AS n, max(n.updated_at) AS u, group_concat(n.status, \',\') AS st FROM interaction_nodes n JOIN interactions i ON i.id = n.interaction_id WHERE i.session_id=?', [sessionId]))
  parts.push(conn.get('SELECT count(*) AS n, max(updated_at) AS u FROM relays WHERE session_id=?', [sessionId]))
  parts.push(conn.get('SELECT count(*) AS n, max(created_at) AS c FROM collab_edges WHERE session_id=?', [sessionId]))
  parts.push(conn.get('SELECT count(*) AS n, max(updated_at) AS u FROM participants WHERE session_id=?', [sessionId]))
  parts.push(conn.get('SELECT count(*) AS n, max(updated_at) AS u FROM director_sessions WHERE session_id=?', [sessionId]))
  parts.push(conn.get("SELECT count(*) AS n, max(coalesce(finished_at, started_at, created_at)) AS u, group_concat(status, ',') AS st FROM director_turns WHERE session_id=?", [sessionId]))
  parts.push(conn.get('SELECT count(*) AS n, max(n.updated_at) AS u FROM interaction_notes n JOIN interactions i ON i.id = n.interaction_id WHERE i.session_id=?', [sessionId]))
  return `r_${sha16(JSON.stringify(parts))}`
}

/** A follow-up step that holds a client key and has not started its run yet (it waits in its interaction's queue):
 *  its interaction, its id and the intent it was asked with. A key held so is taken: another request under it is
 *  refused (KeyConflict), the same follow-up again is that step. */
export function queuedStepWithKey(conn: Conn, sessionId: string, key: string): { interaction_id: string; node_id: string; intent_sha: string | null } | null {
  const row = conn.get(`SELECT n.interaction_id, n.id, json_extract(n.message_json, '$.intent_sha') AS intent_sha FROM interaction_nodes n JOIN interactions i ON i.id = n.interaction_id
    WHERE i.session_id=? AND n.kind='followup' AND n.run_id IS NULL AND json_valid(n.message_json) AND json_extract(n.message_json, '$.client_request_id')=? LIMIT 1`, [sessionId, key])
  return row ? { interaction_id: s(row.interaction_id), node_id: s(row.id), intent_sha: sn(row.intent_sha) } : null
}
