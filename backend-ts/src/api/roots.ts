/** A session's roots (schema v29): folders besides its working folder, each read or write. Registered with the session
 *  (POST …/sessions `roots`) or replaced whole by the person (PUT /api/sessions/:id/roots) while nothing of the session
 *  is under way — a run holds the roots it started with, so a change waits for it, as an access change does. */

import { Hono, type Context } from 'hono'
import { RootsBodySchema, type Project, type Session, type SessionRoot } from '@oasis-code/contract'
import * as repo from '../db/repo.ts'
import { currentRequestCap } from '../policy/access.ts'
import * as gate from '../policy/gate.ts'
import { checkRoots, rootContext, RootRefused } from '../workspace/roots.ts'
import { connectorOf, DIRECTOR_SESSION_HEADER, HttpError, parseBody, TOOL_SURFACE_HEADER, type Api } from './common.ts'
import { requireSession, type AppState } from './state.ts'

/** The roots a request names, checked against the project and the session's working folder (refused as an HttpError
 *  400 with its code, detail and next step). */
export function checkedRoots(state: AppState, project: Project, session: Session | null, given: readonly { path: string; access: 'read' | 'write' }[]): SessionRoot[] {
  if (project.target?.kind === 'ssh') {
    if (given.length) throw new HttpError(409, 'Additional remote roots are not supported; the pinned project is the file-tool boundary.', 'capability_unavailable')
    return []
  }
  const ws = session?.workspace_id ? repo.getWorkspace(state.conn, session.workspace_id) : null
  try {
    return checkRoots(given, rootContext(state.settings, project, ws))
  } catch (error) {
    if (error instanceof RootRefused) throw new HttpError(400, `${error.message}; ${error.next_step}`, error.code, { next_step: error.next_step, path: error.path })
    throw error
  }
}

/** What keeps a session's roots from changing now: its runs, relays and interactions under way, its commands running,
 *  its approvals and proposals waiting (the counting of an access change, api/gate.ts). */
function blockersOf(state: AppState, session: Session): { runs: number; executions: number; approvals: number } {
  const runs = state.runs.activeRunsOfSession(session.id).length
    + repo.listRelays(state.conn, session.id).filter((r) => r.status === 'running').length
    + repo.listInteractions(state.conn, session.id).filter((i) => i.status === 'running' || i.status === 'planning' || i.status === 'deciding').length
  const executions = state.processes.runningForSession(session.id).length
  const approvals = repo.listApprovals(state.conn, session.id, 'pending').length
    + gate.listProposals(state.conn, session.project_id, session.id).filter((p) => p.status === 'pending' || p.status === 'executing').length
  return { runs, executions, approvals }
}

function snapshotOf(state: AppState, session: Session): Record<string, unknown> {
  const blocked_by = blockersOf(state, session)
  return { session_id: session.id, roots: repo.listSessionRoots(state.conn, session.id), changeable: blocked_by.runs + blocked_by.executions + blocked_by.approvals === 0, blocked_by }
}

/** Whether a request comes from a director, a connector's client or a surface (not the person in the app). */
export function directorRequest(c: Context): boolean {
  return currentRequestCap() !== null || connectorOf(c) !== null || !!(c.req.header(TOOL_SURFACE_HEADER) ?? '').trim() || !!(c.req.header(DIRECTOR_SESSION_HEADER) ?? '').trim()
}

export function rootRoutes(api: Api): Hono {
  const app = new Hono()
  const { state } = api

  app.get('/api/sessions/:session_id/roots', (c) => c.json(snapshotOf(state, requireSession(state, c.req.param('session_id')))))

  app.put('/api/sessions/:session_id/roots', async (c) => {
    const body = await parseBody(c, RootsBodySchema)
    // a session's folders are the person's to change; a director names them only when it makes a session
    if (directorRequest(c)) throw new HttpError(403, "only the user changes a session's folders, in oasis-code; a director names them when it creates a session", 'roots_person_only', { next_step: 'ask the user to change the folders in oasis-code, or create a session with the folders it needs' })
    const session = requireSession(state, c.req.param('session_id'))
    const project = repo.getProject(state.conn, session.project_id)
    if (project === null) throw new HttpError(404, `project not found: ${session.project_id}`)
    const roots = checkedRoots(state, project, session, body.roots)
    // from here to the write nothing awaits: what is read below is what the write is decided on
    const blocked_by = blockersOf(state, session)
    if (blocked_by.runs + blocked_by.executions + blocked_by.approvals > 0) {
      throw new HttpError(409, `the session's folders stay as they are while ${[blocked_by.runs ? `${blocked_by.runs} run(s)` : '', blocked_by.executions ? `${blocked_by.executions} command(s)` : '', blocked_by.approvals ? `${blocked_by.approvals} approval(s)` : ''].filter(Boolean).join(', ')} of it are outstanding; change them when those end`, 'roots_blocked', { blocked_by, next_step: 'change them when those end (a run holds the folders it started with)' })
    }
    state.conn.transaction(() => {
      repo.setSessionRoots(state.conn, session.id, roots)
      repo.logGovernance(state.conn, session.id, 'session_roots', { actor: 'user', params: { roots, previous: session.roots ?? [] } })
    })
    return c.json(snapshotOf(state, requireSession(state, session.id)))
  })

  return app
}
