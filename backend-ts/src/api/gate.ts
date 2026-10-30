/** Session modes, action review and advanced locks. Existing APIs remain compatible. */
import { Hono } from 'hono'
import { z, AccessBodySchema, ControlBodySchema, DecideBodySchema, LocksBodySchema, LockSpecSchema, type AccessBlockers, type Session } from '@oasis-code/contract'
import { HARNESS_MODES, inferMode } from '@oasis-code/contract/modes'
import * as repo from '../db/repo.ts'
import { currentRequestCap } from '../policy/access.ts'
import * as gate from '../policy/gate.ts'
import { applySessionMode } from '../policy/modes.ts'
import { connectorOf, DIRECTOR_SESSION_HEADER, HttpError, parseBody, TOOL_SURFACE_HEADER, type Api } from './common.ts'
import { requireSession } from './state.ts'
import { WorkspaceBusy } from '../workspace/locks.ts'
import { busyHttp } from './folder_lock.ts'
import { sessionDetail } from './sessions.ts'

const ModeBodySchema = z.object({ mode: z.enum(HARNESS_MODES) }).strict()
export function gateRoutes(api: Api): Hono {
  const app = new Hono()
  const { state } = api
  const modeSnapshot = (sessionId: string) => {
    const session = requireSession(state, sessionId)
    const control = gate.effectiveControl(state.conn, sessionId)
    return { mode: inferMode(session.grants, control), session: sessionDetail(state, session), control }
  }
  /** What keeps the session's access from changing now (all read synchronously, with the write that follows them in
   *  the same turn of the event loop: nothing of the session starts in between) — its active runs and running relays
   *  or interactions, its commands running or being started in any workspace of it (ProcessManager.runningForSession),
   *  and its approvals and proposed actions not decided (or being carried out). */
  const accessBlockers = (session: Session): AccessBlockers => {
    const runs = state.runs.activeRunsOfSession(session.id).length
      + repo.listRelays(state.conn, session.id).filter((r) => r.status === 'running').length
      + repo.listInteractions(state.conn, session.id).filter((i) => i.status === 'running' || i.status === 'planning' || i.status === 'deciding').length
    const executions = state.processes.runningForSession(session.id).length
    const approvals = repo.listApprovals(state.conn, session.id, 'pending').length
      + gate.listProposals(state.conn, session.project_id, session.id).filter((p) => p.status === 'pending' || p.status === 'executing').length
    return { runs, executions, approvals }
  }
  const accessSnapshot = (session: Session) => {
    const blocked_by = accessBlockers(session)
    return { access_mode: session.access_mode, switchable: blocked_by.runs + blocked_by.executions + blocked_by.approvals === 0, blocked_by, session: sessionDetail(state, session) }
  }
  app.get('/api/sessions/:session_id/access', (c) => c.json(accessSnapshot(requireSession(state, c.req.param('session_id')))))
  app.put('/api/sessions/:session_id/access', async (c) => {
    const body = await parseBody(c, AccessBodySchema)
    const sessionId = c.req.param('session_id')
    // the person's choice: a director or a connector's client never changes where commands run
    if (currentRequestCap() !== null || connectorOf(c) !== null || (c.req.header(TOOL_SURFACE_HEADER) ?? '').trim() || (c.req.header(DIRECTOR_SESSION_HEADER) ?? '').trim()) throw new HttpError(403, 'only the user changes where a session\'s commands run, in oasis-code', 'access_person_only')
    // from here to the write nothing awaits: what is read below is what the write is decided on
    const session = requireSession(state, sessionId)
    if (body.access_mode === 'sandbox' && repo.getProject(state.conn, session.project_id)?.target?.kind === 'ssh') throw new HttpError(409, 'Remote sandbox enforcement is unavailable; access was not changed.', 'sandbox_unavailable')
    if (session.access_mode === body.access_mode) return c.json(accessSnapshot(session))
    const blocked_by = accessBlockers(session)
    if (blocked_by.runs + blocked_by.executions + blocked_by.approvals > 0) {
      // nothing is stopped and nothing changes: a run, a command or an approval keeps the access it has
      throw new HttpError(409, `the session's access stays ${session.access_mode} while ${[blocked_by.runs ? `${blocked_by.runs} run(s)` : '', blocked_by.executions ? `${blocked_by.executions} command(s)` : '', blocked_by.approvals ? `${blocked_by.approvals} approval(s)` : ''].filter(Boolean).join(', ')} of it are outstanding; change it when they end`, 'access_blocked', { blocked_by })
    }
    state.conn.transaction(() => {
      repo.setSessionAccess(state.conn, sessionId, body.access_mode)
      repo.logGovernance(state.conn, sessionId, 'session_access', { actor: 'user', params: { access_mode: body.access_mode, previous: session.access_mode } })
    })
    return c.json(accessSnapshot(requireSession(state, sessionId)))
  })
  app.get('/api/sessions/:session_id/mode', (c) => c.json(modeSnapshot(c.req.param('session_id'))))
  app.put('/api/sessions/:session_id/mode', async (c) => {
    const body = await parseBody(c, ModeBodySchema)
    const sessionId = c.req.param('session_id')
    const session = requireSession(state, sessionId)
    // Running agents hold a grants snapshot. Never present a new mode while an old snapshot is executing.
    if (state.runs.activeRunsOfSession(sessionId).length) throw new HttpError(409, 'Stop the active runs before changing mode.')
    state.conn.transaction(() => applySessionMode(state.conn, session, body.mode))
    // Existing proposals, project protections and locks are intentionally untouched.
    return c.json(modeSnapshot(sessionId))
  })
  app.get('/api/sessions/:session_id/agent-control', (c) => {
    const sessionId = c.req.param('session_id')
    requireSession(state, sessionId)
    return c.json({ control: gate.effectiveControl(state.conn, sessionId), effect_tags: [...gate.EFFECT_TAGS].sort(), gateable_tools: [...gate.GATEABLE_TOOLS].sort() })
  })
  app.post('/api/sessions/:session_id/agent-control', async (c) => {
    const sessionId = c.req.param('session_id')
    requireSession(state, sessionId)
    const body = await parseBody(c, ControlBodySchema)
    try { gate.recordRunControl(state.conn, sessionId, body.desired_state, body.gate_effects, body.run_id ?? null) }
    catch (error) { throw new HttpError(400, (error as Error).message) }
    return c.json({ control: gate.effectiveControl(state.conn, sessionId, body.run_id ?? null) })
  })
  app.get('/api/sessions/:session_id/action-proposals', (c) => {
    const sessionId = c.req.param('session_id')
    const session = requireSession(state, sessionId)
    return c.json({ proposals: gate.listProposals(state.conn, session.project_id, sessionId) })
  })
  app.get('/api/action-proposals/:proposal_id', (c) => {
    const proposalId = c.req.param('proposal_id')
    let payload
    try { payload = gate.loadProposal(state.conn, state.store, proposalId) }
    catch (error) {
      if (error instanceof gate.NotFoundError) throw new HttpError(404, error.message)
      throw error
    }
    return c.json({ proposal_asset_id: proposalId, payload, decision: gate.decisionFor(state.conn, proposalId) })
  })
  app.post('/api/action-proposals/:proposal_id/decide', async (c) => {
    const proposalId = c.req.param('proposal_id')
    const body = await parseBody(c, DecideBodySchema)
    try { return c.json(await gate.decideProposal(state, proposalId, body.decision, body.reason, 'user')) }
    catch (error) {
      if (error instanceof gate.NotFoundError) throw new HttpError(404, error.message)
      // a busy folder names its writer and how to go on; the proposal's own reasons have codes of their own
      if (error instanceof WorkspaceBusy) throw busyHttp(error)
      if (error instanceof gate.ProposalConflict) throw new HttpError(409, error.message, error.code)
      throw new HttpError(409, (error as Error).message)
    }
  })
  app.get('/api/sessions/:session_id/locks', (c) => {
    const sessionId = c.req.param('session_id')
    requireSession(state, sessionId)
    return c.json({ locks: gate.sessionLocks(state.conn, sessionId) })
  })
  app.put('/api/sessions/:session_id/locks', async (c) => {
    const sessionId = c.req.param('session_id')
    requireSession(state, sessionId)
    const body = await parseBody(c, LocksBodySchema)
    const locks = []
    for (const raw of body.locks) {
      const parsed = LockSpecSchema.safeParse(raw)
      if (!parsed.success) throw new HttpError(400, `invalid lock: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
      locks.push(parsed.data)
    }
    gate.recordLocks(state.conn, sessionId, locks)
    return c.json({ locks: gate.sessionLocks(state.conn, sessionId) })
  })
  return app
}
