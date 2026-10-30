/** What the rail reads of every session's agents without opening it (contract SessionActivitySchema,
 *  GET /api/session-activity): the runs in line or at work now, with what their own rows would say (a request waiting
 *  for its slot, a form waiting for the person), the open director's state, and how many of the session's agent runs
 *  and director turns have ended. Facts only — the page reads them with its own bot rules (frontend
 *  state/presence.ts), so nothing here decides "running" or "unread". A handful of queries for every session at once
 *  (the page asks every few seconds while it is in view). */

import { Hono } from 'hono'
import type { SessionActivity } from '@oasis-code/contract'
import * as repo from '../db/repo.ts'
import { getTurn, listOpenDirectorSessions } from '../director/store.ts'
import type { Api } from './common.ts'
import type { AppState } from './state.ts'

/** Runs that are not an agent's (frontend presence.ts isAgentRun): a person's action, a plan's placeholder. */
const NOT_AGENT_SPAWNERS = ['human_action', 'plan'] as const
/** The ends of a run and of a director turn: once there, never left (no row goes back to live, none is removed). */
const ENDED = ['done', 'error', 'cancelled'] as const

export function sessionActivities(state: AppState): Record<string, SessionActivity> {
  const out: Record<string, SessionActivity> = {}
  for (const r of state.conn.all('SELECT id FROM sessions WHERE status<>?', [repo.DELETED_SESSION])) out[String(r.id)] = { live: [], director: null, ended: 0, agents: [] }
  const of = (sessionId: string): SessionActivity | undefined => out[sessionId]

  // what this process runs now: a run waiting for a request slot is in a slot's waiters; a form waits in ui_inputs
  const slotWaiting = new Set<string>()
  for (const slot of state.slots.slots.values()) for (const id of slot.waiters) slotWaiting.add(id)
  const pendingInput = new Set(state.conn.all("SELECT DISTINCT run_id FROM ui_inputs WHERE status='pending'").map((r) => String(r.run_id)))
  for (const h of state.runs.handles.values()) {
    if (h.done) continue
    of(h.session_id)?.live.push({
      id: h.run_id, status: h.status, spawned_by: h.spawned_by, model: h.model_id ?? null,
      slot_waiting: slotWaiting.has(h.run_id), pending_input: pendingInput.has(h.run_id),
    })
  }

  // how many ended: every agent run's end and every director turn's end counts once, two in one millisecond as two
  const ends = ENDED.map(() => '?').join(',')
  const spawners = NOT_AGENT_SPAWNERS.map(() => '?').join(',')
  const counted = [
    ...state.conn.all(`SELECT session_id, COUNT(*) AS n FROM runs WHERE status IN (${ends}) AND spawned_by NOT IN (${spawners}) GROUP BY session_id`, [...ENDED, ...NOT_AGENT_SPAWNERS]),
    ...state.conn.all(`SELECT session_id, COUNT(*) AS n FROM director_turns WHERE status IN (${ends}) GROUP BY session_id`, [...ENDED]),
  ]
  for (const r of counted) { const a = of(String(r.session_id)); if (a) a.ended += Number(r.n) }

  // the open director of each session (the newest, as openDirectorSessionOf reads it) and its current turn
  const directors = new Map<string, ReturnType<typeof listOpenDirectorSessions>[number]>()
  for (const d of listOpenDirectorSessions(state.conn)) directors.set(d.session_id, d) // oldest first: the newest stays
  for (const [sessionId, d] of directors) {
    const a = of(sessionId)
    if (!a) continue
    const turn = d.current_turn_id ? getTurn(state.conn, d.current_turn_id) : null
    a.director = { state: d.state, turn: turn ? { id: turn.id, status: turn.status, finished_at: turn.finished_at ?? null } : null }
  }
  // who took part: the main agent (an agent run of no other participant: a run from before participants were kept
  // is the main agent's), the other participants by their first run, ChatGPT's commands through a connector, a director
  const spawned = NOT_AGENT_SPAWNERS.map(() => '?').join(',')
  const agents = new Map<string, NonNullable<SessionActivity['agents']>>()
  const add = (sessionId: string, agent: NonNullable<SessionActivity['agents']>[number]) => { if (out[sessionId]) agents.set(sessionId, [...(agents.get(sessionId) ?? []), agent]) }
  for (const r of state.conn.all(`SELECT DISTINCT r.session_id FROM runs r LEFT JOIN run_collab rc ON rc.run_id = r.id LEFT JOIN participants p ON p.id = rc.participant_id
      WHERE r.spawned_by NOT IN (${spawned}) AND (p.role IS NULL OR p.role = 'main')`, [...NOT_AGENT_SPAWNERS])) add(String(r.session_id), { kind: 'main', participant_id: null, model: null })
  for (const r of state.conn.all(`SELECT rc.session_id, rc.participant_id, p.model, MIN(r.created_at) AS first FROM run_collab rc JOIN participants p ON p.id = rc.participant_id
      JOIN runs r ON r.id = rc.run_id WHERE p.role <> 'main' GROUP BY rc.session_id, rc.participant_id ORDER BY first, rc.participant_id`)) {
    add(String(r.session_id), { kind: 'participant', participant_id: String(r.participant_id), model: r.model === null ? null : String(r.model) })
  }
  for (const r of state.conn.all("SELECT DISTINCT session_id FROM runs WHERE spawned_by = 'human_action' AND label = 'command (ChatGPT)'")) add(String(r.session_id), { kind: 'chatgpt', participant_id: null, model: null })
  for (const r of state.conn.all('SELECT DISTINCT session_id FROM director_sessions')) add(String(r.session_id), { kind: 'director', participant_id: null, model: null })
  for (const [sessionId, list] of agents) out[sessionId]!.agents = list
  return out
}

/** Who took part in ONE session, as sessionActivities lists it for every session (the same queries, for one session):
 *  the share's rail bots (contract bots.ts sessionBots) read it. */
export function sessionAgentsOf(conn: AppState['conn'], sessionId: string): NonNullable<SessionActivity['agents']> {
  const spawned = NOT_AGENT_SPAWNERS.map(() => '?').join(',')
  const out: NonNullable<SessionActivity['agents']> = []
  if (conn.get(`SELECT 1 AS x FROM runs r LEFT JOIN run_collab rc ON rc.run_id = r.id LEFT JOIN participants p ON p.id = rc.participant_id
      WHERE r.session_id = ? AND r.spawned_by NOT IN (${spawned}) AND (p.role IS NULL OR p.role = 'main') LIMIT 1`, [sessionId, ...NOT_AGENT_SPAWNERS]) !== null) out.push({ kind: 'main', participant_id: null, model: null })
  for (const r of conn.all(`SELECT rc.participant_id, p.model, MIN(r.created_at) AS first FROM run_collab rc JOIN participants p ON p.id = rc.participant_id
      JOIN runs r ON r.id = rc.run_id WHERE rc.session_id = ? AND p.role <> 'main' GROUP BY rc.session_id, rc.participant_id ORDER BY first, rc.participant_id`, [sessionId])) {
    out.push({ kind: 'participant', participant_id: String(r.participant_id), model: r.model === null ? null : String(r.model) })
  }
  if (conn.get("SELECT 1 AS x FROM runs WHERE session_id = ? AND spawned_by = 'human_action' AND label = 'command (ChatGPT)' LIMIT 1", [sessionId]) !== null) out.push({ kind: 'chatgpt', participant_id: null, model: null })
  if (conn.get('SELECT 1 AS x FROM director_sessions WHERE session_id = ? LIMIT 1', [sessionId]) !== null) out.push({ kind: 'director', participant_id: null, model: null })
  return out
}

export function sessionActivityRoutes(api: Api): Hono {
  const app = new Hono()
  app.get('/api/session-activity', (c) => c.json({ sessions: sessionActivities(api.state) }))
  return app
}
