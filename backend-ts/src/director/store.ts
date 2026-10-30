/** Row access for the director session (schema v8): the session that binds an oasis-code session to a director
 *  conversation, its turns, and the outbox of task events. Every write goes through here; the JSON columns are
 *  decoded into the contract's models on the way out. */

import { directorToolSurfaceOf, type DirectorSayBody, type DirectorOutboxEvent, type DirectorSession, type DirectorState, type DirectorToolCall, type DirectorTransport, type DirectorTurn, type DirectorTurnKind, type DirectorTurnStatus } from '@oasis-code/contract'
import type { Conn, Row } from '../db/database.ts'
import { noteSessionActivity, touchSession } from '../db/repo.ts'
import { newId } from '../ids.ts'
import { nowIso } from '../timebase.ts'

function j(value: unknown): string { return JSON.stringify(value ?? null) }
function d<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || !text) return fallback
  try { return JSON.parse(text) as T } catch { return fallback }
}
const s = (v: unknown): string => String(v)
const sn = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const n = (v: unknown): number => Number(v)

// -- director sessions -------------------------------------------------------

function directorSession(row: Row): DirectorSession {
  const history = d<{ kind?: string; parts?: { part_kind?: string }[] }[]>(row.history_json, [])
  // a turn of the director's own conversation starts at a request made of the person's (or the harness's) words alone
  const turns = Array.isArray(history) ? history.filter((m) => m?.kind === 'request' && Array.isArray(m.parts) && m.parts.length > 0 && m.parts.every((p) => p?.part_kind === 'user-prompt')).length : 0
  const config = d<Record<string, unknown>>(row.config_json, {})
  return {
    id: s(row.id), session_id: s(row.session_id), transport: s(row.transport) as DirectorTransport, model: s(row.model ?? ''), label: s(row.label ?? ''),
    state: s(row.state) as DirectorState, config, external_ref: sn(row.external_ref), current_turn_id: sn(row.current_turn_id),
    last_error: sn(row.last_error), history_turns: turns,
    // the surface its conversation holds: the config's, else v1 (a row from before surfaces existed)
    tool_surface: directorToolSurfaceOf(config),
    created_at: s(row.created_at), updated_at: s(row.updated_at), closed_at: sn(row.closed_at),
  }
}

export function insertDirectorSession(conn: Conn, o: { session_id: string; transport: DirectorTransport; model: string; label: string; config: Record<string, unknown> }): DirectorSession {
  const id = newId('dir')
  const t = nowIso()
  conn.run('INSERT INTO director_sessions (id, session_id, transport, model, label, state, config_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, o.session_id, o.transport, o.model, o.label, 'idle', j(o.config), t, t])
  touchSession(conn, o.session_id)
  return getDirectorSession(conn, id)!
}

export function getDirectorSession(conn: Conn, id: string): DirectorSession | null {
  const row = conn.get('SELECT * FROM director_sessions WHERE id=?', [id])
  return row ? directorSession(row) : null
}

/** The open director session of an oasis-code session (one at most: closing one is the way to open another). */
export function openDirectorSessionOf(conn: Conn, sessionId: string): DirectorSession | null {
  const row = conn.get("SELECT * FROM director_sessions WHERE session_id=? AND state<>'closed' ORDER BY created_at DESC LIMIT 1", [sessionId])
  return row ? directorSession(row) : null
}

export function listOpenDirectorSessions(conn: Conn): DirectorSession[] {
  return conn.all("SELECT * FROM director_sessions WHERE state<>'closed' ORDER BY created_at").map(directorSession)
}

export function updateDirectorSession(conn: Conn, id: string, patch: {
  state?: DirectorState; model?: string; label?: string; config?: Record<string, unknown>; external_ref?: string | null; current_turn_id?: string | null
  last_error?: string | null; closed_at?: string | null
}): DirectorSession {
  const sets: string[] = []
  const params: (string | null)[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    sets.push(`${key === 'config' ? 'config_json' : key}=?`)
    params.push(key === 'config' ? j(value) : (value as string | null))
  }
  sets.push('updated_at=?')
  params.push(nowIso())
  conn.run(`UPDATE director_sessions SET ${sets.join(', ')} WHERE id=?`, [...params, id])
  return getDirectorSession(conn, id)!
}

/** The config keys the harness keeps for itself on a director session: the surface its conversation holds and the
 *  sessions its own create_session calls made. A client neither sets nor changes them (DirectorService refuses). */
export const DIRECTOR_HELD_CONFIG_KEYS = ['tool_surface', 'authorized_session_ids'] as const

/** The sessions a director session's own create_session calls made (its reach beyond the session it is bound to). */
export function authorizedSessionsOf(ds: DirectorSession): string[] {
  const ids = ds.config.authorized_session_ids
  return Array.isArray(ids) ? ids.filter((v): v is string => typeof v === 'string' && v.length > 0) : []
}

/** A session this director session created joins its reach: written on the director session's own row, read back by
 *  the scope on every later call (a restart included). */
export function addAuthorizedSession(conn: Conn, directorSessionId: string, sessionId: string): DirectorSession | null {
  const ds = getDirectorSession(conn, directorSessionId)
  if (!ds || sessionId === ds.session_id) return ds
  const ids = authorizedSessionsOf(ds)
  if (ids.includes(sessionId)) return ds
  return updateDirectorSession(conn, ds.id, { config: { ...ds.config, authorized_session_ids: [...ids, sessionId] } })
}

/** The open director sessions that reach an oasis-code session: the one bound to it, and those that created it. */
export function directorsReaching(conn: Conn, sessionId: string): DirectorSession[] {
  return listOpenDirectorSessions(conn).filter((ds) => ds.session_id === sessionId || authorizedSessionsOf(ds).includes(sessionId))
}

/** The director's own conversation (native: the model messages kept between turns), as stored JSON. */
export function getDirectorHistory(conn: Conn, id: string): string | null {
  const row = conn.get('SELECT history_json FROM director_sessions WHERE id=?', [id])
  return row ? sn(row.history_json) : null
}

export function setDirectorHistory(conn: Conn, id: string, historyJson: string | null): void {
  conn.run('UPDATE director_sessions SET history_json=?, updated_at=? WHERE id=?', [historyJson, nowIso(), id])
}

// -- turns -------------------------------------------------------------------

function turn(row: Row): DirectorTurn {
  return {
    id: s(row.id), director_session_id: s(row.director_session_id), session_id: s(row.session_id), seq: n(row.seq), kind: s(row.kind) as DirectorTurnKind,
    envelope: d(row.envelope_json, null), dispatched_interaction_ids: d(row.dispatched_interactions_json, []),
    input: s(row.input), output: s(row.output ?? ''), status: s(row.status) as DirectorTurnStatus, model: s(row.model ?? ''),
    usage: d(row.usage_json, {}), tool_calls: d<DirectorToolCall[]>(row.tool_calls_json, []), event_ids: d<string[]>(row.event_ids_json, []),
    dispatched_run_ids: d<string[]>(row.dispatched_json, []), note_id: sn(row.note_id), error: sn(row.error), external_ref: sn(row.external_ref),
    created_at: s(row.created_at), started_at: sn(row.started_at), finished_at: sn(row.finished_at),
  }
}

export function insertTurn(conn: Conn, o: { director_session_id: string; session_id: string; kind: DirectorTurnKind; input: string; event_ids?: string[]; model?: string; envelope?: DirectorSayBody | null }): DirectorTurn {
  const id = newId('turn')
  const seq = n(conn.get('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM director_turns WHERE director_session_id=?', [o.director_session_id])!.seq)
  conn.run('INSERT INTO director_turns (id, director_session_id, session_id, seq, kind, input, status, model, event_ids_json, created_at, envelope_json, client_request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, o.director_session_id, o.session_id, seq, o.kind, o.input, 'queued', o.model ?? '', j(o.event_ids ?? []), nowIso(), o.envelope ? j(o.envelope) : null, o.envelope?.client_request_id ?? null])
  const made = getTurn(conn, id)!
  // the person's call to the director is the session's activity; a turn the harness opens itself (its task report, an
  // interaction's plan or decision, a restart's sweep) is not
  if (o.kind === 'user') noteSessionActivity(conn, o.session_id, made.created_at)
  return made
}

export function turnForClientRequest(conn: Conn, sessionId: string, key: string): DirectorTurn | null {
  const row = conn.get('SELECT * FROM director_turns WHERE session_id=? AND client_request_id=?', [sessionId, key])
  return row ? turn(row) : null
}

export function hasClosedDirector(conn: Conn, sessionId: string): boolean {
  return !!conn.get("SELECT id FROM director_sessions WHERE session_id=? AND state='closed' LIMIT 1", [sessionId])
}

export function getTurn(conn: Conn, id: string): DirectorTurn | null {
  const row = conn.get('SELECT * FROM director_turns WHERE id=?', [id])
  return row ? turn(row) : null
}

export function listTurns(conn: Conn, directorSessionId: string, opts: { tail?: number } = {}): DirectorTurn[] {
  const rows = conn.all('SELECT * FROM director_turns WHERE director_session_id=? ORDER BY seq', [directorSessionId]).map(turn)
  return opts.tail !== undefined ? rows.slice(-opts.tail) : rows
}

export function nextQueuedTurn(conn: Conn, directorSessionId: string): DirectorTurn | null {
  const row = conn.get("SELECT * FROM director_turns WHERE director_session_id=? AND status='queued' ORDER BY seq LIMIT 1", [directorSessionId])
  return row ? turn(row) : null
}

export function activeTurns(conn: Conn, directorSessionId: string): DirectorTurn[] {
  return conn.all("SELECT * FROM director_turns WHERE director_session_id=? AND status IN ('generating', 'awaiting_answer') ORDER BY seq", [directorSessionId]).map(turn)
}

/** Every turn that is still generating or awaiting an answer, across director sessions (what a restart finds). */
export function listUnfinishedTurns(conn: Conn): DirectorTurn[] {
  return conn.all("SELECT * FROM director_turns WHERE status IN ('queued', 'generating', 'awaiting_answer') ORDER BY created_at").map(turn)
}

export function updateTurn(conn: Conn, id: string, patch: {
  status?: DirectorTurnStatus; output?: string; model?: string; usage?: Record<string, number>; tool_calls?: DirectorToolCall[]; event_ids?: string[]
  dispatched_interaction_ids?: string[]; dispatched_run_ids?: string[]; note_id?: string | null; error?: string | null; external_ref?: string | null; started_at?: string | null; finished_at?: string | null
}): DirectorTurn {
  const columns: Record<string, string> = { usage: 'usage_json', tool_calls: 'tool_calls_json', event_ids: 'event_ids_json', dispatched_run_ids: 'dispatched_json', dispatched_interaction_ids: 'dispatched_interactions_json' }
  const sets: string[] = []
  const params: (string | null)[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const column = columns[key]
    sets.push(`${column ?? key}=?`)
    params.push(column ? j(value) : (value as string | null))
  }
  if (!sets.length) return getTurn(conn, id)!
  conn.run(`UPDATE director_turns SET ${sets.join(', ')} WHERE id=?`, [...params, id])
  return getTurn(conn, id)!
}

/** The turn of a director session that started this run (its tool call returned the run), or null. */
export function turnThatDispatched(conn: Conn, directorSessionId: string, runId: string): DirectorTurn | null {
  for (const row of conn.all('SELECT * FROM director_turns WHERE director_session_id=? AND dispatched_json LIKE ? ORDER BY seq DESC', [directorSessionId, `%${runId}%`])) {
    const t = turn(row)
    if (t.dispatched_run_ids.includes(runId)) return t
  }
  return null
}

// -- the outbox --------------------------------------------------------------

function event(row: Row): DirectorOutboxEvent {
  return {
    id: s(row.id), director_session_id: s(row.director_session_id), session_id: s(row.session_id), seq: n(row.seq), kind: s(row.kind), ref_id: s(row.ref_id),
    dedupe_key: s(row.dedupe_key), cause_turn_id: sn(row.cause_turn_id), payload: d(row.payload_json, {}), status: s(row.status) as DirectorOutboxEvent['status'],
    attempts: n(row.attempts), delivered_turn_id: sn(row.delivered_turn_id), error: sn(row.error), created_at: s(row.created_at), delivered_at: sn(row.delivered_at),
  }
}

/** Enqueue an event; one with the same dedupe key already there (in any state) is returned unchanged with `fresh: false`. */
export function enqueueEvent(conn: Conn, o: { director_session_id: string; session_id: string; kind: string; ref_id: string; dedupe_key: string; cause_turn_id: string | null; payload: Record<string, unknown> }): { event: DirectorOutboxEvent; fresh: boolean } {
  const existing = conn.get('SELECT * FROM director_outbox WHERE director_session_id=? AND dedupe_key=?', [o.director_session_id, o.dedupe_key])
  if (existing) return { event: event(existing), fresh: false }
  const id = newId('dev')
  const seq = n(conn.get('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM director_outbox WHERE director_session_id=?', [o.director_session_id])!.seq)
  conn.run('INSERT INTO director_outbox (id, director_session_id, session_id, seq, kind, ref_id, dedupe_key, cause_turn_id, payload_json, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, o.director_session_id, o.session_id, seq, o.kind, o.ref_id, o.dedupe_key, o.cause_turn_id, j(o.payload), 'pending', nowIso()])
  return { event: getEvent(conn, id)!, fresh: true }
}

export function getEvent(conn: Conn, id: string): DirectorOutboxEvent | null {
  const row = conn.get('SELECT * FROM director_outbox WHERE id=?', [id])
  return row ? event(row) : null
}

export function pendingEvents(conn: Conn, directorSessionId: string): DirectorOutboxEvent[] {
  return conn.all("SELECT * FROM director_outbox WHERE director_session_id=? AND status='pending' ORDER BY seq", [directorSessionId]).map(event)
}

export function listEvents(conn: Conn, directorSessionId: string, opts: { status?: string } = {}): DirectorOutboxEvent[] {
  if (opts.status) return conn.all('SELECT * FROM director_outbox WHERE director_session_id=? AND status=? ORDER BY seq', [directorSessionId, opts.status]).map(event)
  return conn.all('SELECT * FROM director_outbox WHERE director_session_id=? ORDER BY seq', [directorSessionId]).map(event)
}

export function markEvents(conn: Conn, ids: string[], patch: { status: DirectorOutboxEvent['status']; delivered_turn_id?: string | null; error?: string | null; bump_attempts?: boolean; delivered?: boolean }): void {
  if (!ids.length) return
  const marks = ids.map(() => '?').join(',')
  const sets = ['status=?']
  const params: (string | null)[] = [patch.status]
  if (patch.delivered_turn_id !== undefined) { sets.push('delivered_turn_id=?'); params.push(patch.delivered_turn_id) }
  if (patch.error !== undefined) { sets.push('error=?'); params.push(patch.error) }
  if (patch.bump_attempts) sets.push('attempts=attempts+1')
  if (patch.delivered) { sets.push('delivered_at=?'); params.push(nowIso()) }
  conn.run(`UPDATE director_outbox SET ${sets.join(', ')} WHERE id IN (${marks})`, [...params, ...ids])
}
