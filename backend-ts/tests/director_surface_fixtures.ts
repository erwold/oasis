/** Director sessions as rows written before tool surfaces existed (schema ≤ v24): the config names no `tool_surface`,
 *  so the session holds director.v1 — the baseline's tools, instructions and texts, byte for byte. A test that pins a
 *  v1 behaviour (the implicit original-message binding, the native refusal of `separate`, v1's words) runs on such a
 *  row; the same capability on director.v2 is tested on its own (test_director_surface_freeze, test_director_v2). */

import type { DirectorSession, DirectorToolSurface } from '@oasis-code/contract'
import type { AppState } from '../src/api/state.ts'
import * as repo from '../src/db/repo.ts'
import * as store from '../src/director/store.ts'
import type { Conn } from '../src/db/database.ts'

/** The director session as a pre-surface row: its config without `tool_surface` (and without a reach of its own). */
export function asLegacyV1(conn: Conn, directorSessionId: string): DirectorSession {
  const ds = store.getDirectorSession(conn, directorSessionId)
  if (!ds) throw new Error(`no director session ${directorSessionId}`)
  const config = { ...ds.config }
  delete config.tool_surface
  delete config.authorized_session_ids
  return store.updateDirectorSession(conn, ds.id, { config })
}

/** The session's director as the composer opens it (`ensure`, or `open` with the body given), then made a pre-surface row. */
export function legacyV1Director(state: AppState, sessionId: string, body?: { transport: 'native' | 'bridge'; model?: string | null; config?: Record<string, unknown> }): DirectorSession {
  const session = repo.getSession(state.conn, sessionId)
  if (!session) throw new Error(`no session ${sessionId}`)
  const ds = state.director.openOf(sessionId) ?? (body ? state.director.open(session, { transport: body.transport, model: body.model ?? null, config: body.config ?? {} }) : state.director.ensure(session))
  return asLegacyV1(state.conn, ds.id)
}

/** The director session held on `surface` (a conversation opened before a newer surface existed keeps its own): a
 *  test of that surface's behaviour runs on such a row, whatever a new session opens on now. */
export function onSurface(conn: Conn, directorSessionId: string, surface: DirectorToolSurface): DirectorSession {
  const ds = store.getDirectorSession(conn, directorSessionId)
  if (!ds) throw new Error(`no director session ${directorSessionId}`)
  return store.updateDirectorSession(conn, ds.id, { config: { ...ds.config, tool_surface: surface } })
}
