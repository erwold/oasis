import { Hono } from 'hono'
import { ACTIVE_RUN_STATUSES, type BackgroundCommand, type RunCollab, DecisionBodySchema, DirectorNoteBodySchema, GrantsBodySchema, ModelBodySchema, SessionBodySchema, SessionUpdateBodySchema, SessionPinBodySchema, WorkOrderBodySchema, type Session } from '@oasis-code/contract'
import { contextReportAsync } from '../agent/context_report.ts'
import { ContextReportUnavailable } from '../agent/context_report_worker_client.ts'
import { narrowOrder, OrderWidened, parseWorkOrder, WorkOrderInvalid } from '../agent/work_orders.ts'
import * as repo from '../db/repo.ts'
import { findModel } from '../llm/catalog.ts'
import { NotFound } from '../policy/permissions.ts'
import { applySessionMode } from '../policy/modes.ts'
import { DEFAULT_ACCESS_MODE, narrowestAccess } from '@oasis-code/contract/modes'
import { currentRequestCap } from '../policy/access.ts'
import { getDirectorSession, openDirectorSessionOf } from '../director/store.ts'
import { GitError } from '../workspace/git.ts'
import { isDirect } from '../workspace/service.ts'
import { thinkingOr400 } from './runs.ts'
import { underFolderLock } from './folder_lock.ts'
import { holderEnds } from '../workspace/locks.ts'
import { planRows, stampDepths, type InteractionRows } from './tree.ts'
import { agentBound, HttpError, intentOf, parseBody, requestOrigin, treeRow, withoutManifest, type Api } from './common.ts'
import { narrowGrants, stricterMode } from '../policy/delegation.ts'
import { collabOfRuns, prepareHandover, revisionOf, type Handover } from '../agent/collab.ts'
import { mainKey } from '../agent/collab_projection.ts'
import { participantIdOf } from '../db/collab_repo.ts'
import { asHttpError, runAnswer } from './collaboration.ts'
import { requireProject, requireSession, type AppState } from './state.ts'
import { checkedRoots } from './roots.ts'
import { launcherOf } from '../execution/processes.ts'

export function sessionDetail(state: AppState, session: Session): Record<string, unknown> {
  // first, before any run is read: a run live below is either live now (its events all after the cursor) or started
  // after it; one that ended before it reads as ended (its transcript)
  const eventCursor = state.runs.sessionCursor(session.id)
  const ws = session.workspace_id ? repo.getWorkspace(state.conn, session.workspace_id) : null
  // the thread (schema v25): the runs placed in it — the main agent's and a relay's turns, each with its collab; an
  // interaction's steps are on its board, a separate task's runs on their cards (runs/tree, /collaboration)
  const collab = collabOfRuns(state, session.id)
  const runs = repo.listRuns(state.conn, session.id).filter((r) => collab.get(r.id)?.placement.surface === 'thread')
  const active = state.runs.activeRunOfSession(session.id)
  const live = state.runs.activeRunsOfSession(session.id)
  const others = live.filter((h) => active === null || h.run_id !== active.run_id)
  // schema v29: every session of its task, this one included (sessions of one task may be in other projects)
  const task_sessions = repo.sessionsOfTask(state.conn, session.task_root_id ?? session.id)
    .map((s) => ({ id: s.id, project_id: s.project_id, title: s.title, status: s.status, last_activity_at: s.last_activity_at ?? s.created_at }))
  return {
    ...session, workspace: ws, task_sessions, runs: runs.map((r) => ({ ...withoutManifest(r), collab: collab.get(r.id) ?? null })),
    director_notes: repo.listDirectorNotes(state.conn, session.id),
    director: openDirectorSessionOf(state.conn, session.id),
    active_run: active ? { id: active.run_id, status: active.status, saved_seq: active.saved_seq, steerable: state.runs.steerRefusal(active) === null } : null,
    relays: repo.listRelays(state.conn, session.id),
    interactions: state.interactions.listDetails(session.id),
    watches: repo.listWatches(state.conn, session.id).slice(0, 50),
    wake_events: repo.listWakeEvents(state.conn, session.id, 50),
    active_children: others.map((h) => ({ id: h.run_id, status: h.status, label: h.label })),
    run_count: repo.countRuns(state.conn, session.id),
    pending_approvals: state.gate.listPending(session.id),
    main_participant_id: participantIdOf(session.id, mainKey()),
    active_runs: live.map((h) => {
      const c = collab.get(h.run_id)
      return { id: h.run_id, status: h.status, label: h.label, model: h.model_id, participant_id: c?.participant_id ?? h.participant_id, participant_role: c?.participant_role ?? h.participant_role, surface: c?.placement.surface ?? h.surface }
    }),
    collaboration_revision: revisionOf(state, session.id),
    event_cursor: eventCursor,
    background_commands: backgroundCommandsOf(state, session.id, collab),
  }
}

/** This session's commands still running (a remote one whose end is not known yet too) after the run that started
 *  them ended — not another session's of a shared folder, not the connector's (no run started those). The conversation
 *  is named only for a command its run's own tool started: that is what a later run of the conversation works beside. */
export function backgroundCommandsOf(state: AppState, sessionId: string, collab: Map<string, RunCollab>): BackgroundCommand[] {
  const out: BackgroundCommand[] = []
  const seen = new Set<string>()
  for (const xid of state.processes.runningForSession(sessionId)) {
    if (seen.has(xid)) continue
    seen.add(xid)
    const x = repo.getExecution(state.conn, xid)
    if (x === null || x.run_id === null || x.workspace_id === null) continue
    const run = repo.getRun(state.conn, x.run_id)
    if (run === null || run.session_id !== sessionId) continue
    const handle = state.runs.handles.get(run.id)
    if ((handle !== undefined && !handle.done) || (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) continue
    out.push({
      execution_id: x.id, run_id: run.id, workspace_id: x.workspace_id, command: x.command.slice(0, 500), status: x.status,
      conversation_id: launcherOf(x) === 'run' ? collab.get(run.id)?.conversation_id ?? null : null,
    })
  }
  return out
}

export function sessionRoutes(api: Api): Hono {
  const app = new Hono()
  const { state } = api
  const knownModel = (model: string) => findModel(state.config, model) !== null || state.model_overrides.has(model)

  // the person cancels a watch the session's agent set (it wakes no one after this)
  app.post('/api/watches/:watch_id/cancel', (c) => {
    const watch = repo.getWatch(state.conn, c.req.param('watch_id'))
    if (watch === null) throw new HttpError(404, `watch not found: ${c.req.param('watch_id')}`)
    requireSession(state, watch.session_id)
    const cancelled = state.watches.cancel(watch.id, 'person')
    return c.json({ cancelled, watch: repo.getWatch(state.conn, watch.id) })
  })

  app.post('/api/projects/:project_id/sessions', async (c) => {
    const projectId = c.req.param('project_id')
    const project = requireProject(state, projectId)
    const body = await parseBody(c, SessionBodySchema)
    // an agent run's request (open_ssh_session): the session it makes is held to that run's bounds — its mode at least
    // as strict, its grants no wider — and its record says the agent made it (policy/delegation.ts)
    const bound = agentBound(state)
    if (bound !== null && body.roots?.length) throw new HttpError(403, 'an agent run may not give a session folders besides its working folder; that is the person\'s, in oasis-code', 'agent_roots')
    const actor = bound !== null ? 'agent' : currentRequestCap() === null ? 'user' : 'director'
    if (project.target?.kind === 'ssh' && narrowestAccess(body.access_mode ?? DEFAULT_ACCESS_MODE, currentRequestCap()) !== 'full') throw new HttpError(409, 'Sandbox enforcement is not available on this SSH target.', 'sandbox_unavailable')
    // the start screen's key: a request sent again answers with the session it made
    const key = body.client_request_id ?? null
    const made = key !== null ? repo.sessionForClientRequest(state.conn, projectId, key) : null
    if (made !== null) return c.json(sessionDetail(state, made))
    const model = body.model || project.default_model || state.config.default_model
    if (!model || !knownModel(model)) throw new HttpError(400, `unknown model: ${model}`)
    // schema v29: the task it joins (that task's first session; a session of no task is its own task's first) and
    // its folders besides the working folder — checked before anything is made: a refusal makes nothing
    let taskRoot: string | null = null
    if (body.task_session_id) {
      const joined = repo.getSession(state.conn, body.task_session_id)
      if (joined === null || joined.status === repo.DELETED_SESSION) throw new HttpError(404, `no session ${body.task_session_id} to join; name a session that exists, or leave task_session_id out for a task of its own`, 'task_session_not_found', { next_step: 'name a session that exists (list_projects shows them), or leave task_session_id out for a task of its own' })
      taskRoot = joined.task_root_id ?? joined.id
    }
    const roots = body.roots?.length ? checkedRoots(state, project, null, body.roots) : []
    let session
    try {
      session = state.conn.transaction(() => {
        // the product's default access (full) unless the request names another; a request holding a cap (a director
        // of surface v1–v5, a connector's client) makes a sandbox session, as those surfaces describe (policy/access.ts)
        const access = narrowestAccess(body.access_mode ?? DEFAULT_ACCESS_MODE, currentRequestCap())
        const created = repo.createSession(state.conn, projectId, body.title, model, undefined, access)
        repo.logGovernance(state.conn, created.id, 'session_access', { actor, params: { access_mode: access, requested: body.access_mode ?? null }, run_id: bound?.run_id ?? null })
        if (key !== null) repo.setSessionClientRequest(state.conn, created.id, key)
        if (bound !== null) {
          const mode = stricterMode(body.mode ?? null, bound.mode)
          applySessionMode(state.conn, created, mode, 'agent')
          const grants = narrowGrants(repo.getSession(state.conn, created.id)!.grants, bound.grants)
          repo.setSessionGrants(state.conn, created.id, grants)
          repo.logGovernance(state.conn, created.id, 'session_delegation', { actor: 'agent', run_id: bound.run_id, params: { caller_run_id: bound.run_id, caller_session_id: bound.session_id, mode, requested_mode: body.mode ?? null, grants } })
        } else if (body.mode) applySessionMode(state.conn, created, body.mode)
        if (taskRoot !== null) repo.setSessionTask(state.conn, created.id, taskRoot)
        if (roots.length) {
          repo.setSessionRoots(state.conn, created.id, roots)
          repo.logGovernance(state.conn, created.id, 'session_roots', { actor, params: { roots, previous: [] } })
        }
        return created
      })
    } catch (error) {
      // the same request racing itself: the other one holds the key (the transaction left nothing behind)
      const raced = key !== null ? repo.sessionForClientRequest(state.conn, projectId, key) : null
      if (raced !== null) return c.json(sessionDetail(state, raced))
      throw error
    }
    let ws
    try {
      ws = await state.workspaces.createWorkspace(project, session.id)
    } catch (error) {
      if (error instanceof GitError) throw new HttpError(500, `could not open a workspace: ${error.message}`)
      throw error
    }
    repo.setSessionWorkspace(state.conn, session.id, ws.id)
    return c.json(sessionDetail(state, repo.getSession(state.conn, session.id)!))
  })

  app.get('/api/sessions/:session_id', (c) => c.json(sessionDetail(state, requireSession(state, c.req.param('session_id')))))

  app.put('/api/sessions/:session_id', async (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    const body = await parseBody(c, SessionUpdateBodySchema)
    repo.renameSession(state.conn, session.id, body.title)
    return c.json(sessionDetail(state, repo.getSession(state.conn, session.id)!))
  })

  app.put('/api/sessions/:session_id/pin', async (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    const body = await parseBody(c, SessionPinBodySchema)
    if (body.pinned && session.status !== 'open') throw new HttpError(409, 'only an open session can be pinned')
    repo.setSessionPinned(state.conn, session.id, body.pinned)
    return c.json(repo.getSession(state.conn, session.id)!)
  })

  // a session with work under way is not deleted from under it: its runs are stopped first; an open director is
  // closed with it (its queued turns cancelled)
  app.delete('/api/sessions/:session_id', (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    const live = state.runs.activeRunsOfSession(session.id)
    if (live.length) throw new HttpError(409, `the session has ${live.length} run${live.length === 1 ? '' : 's'} under way: stop ${live.length === 1 ? 'it' : 'them'} first`)
    // a folder edited in place is every session's of its project: its workspace (and the HOME and temporary folder
    // beside it) stays with the folder, whichever session made it
    const workspaces = repo.workspacesOfSession(state.conn, session.id).filter((ws) => !isDirect(ws))
    const busy = workspaces.filter((ws) => state.processes.liveForWorkspace(ws.id))
    if (busy.length) throw new HttpError(409, `a command of the session is still running (workspace ${busy[0]!.id}): stop it first`)
    if (openDirectorSessionOf(state.conn, session.id)) state.director.close(session.id)
    repo.deleteSession(state.conn, session.id)
    state.runs.sessions.end(session.id)
    state.watches.sessionDeleted(session.id)
    state.ui_tasks.sessionDeleted(session.id)
    // what its commands and tools kept beside the worktrees goes with the session
    for (const ws of workspaces) state.processes.removeSandbox(ws.id)
    return c.json({ deleted: true, session_id: session.id })
  })

  /** Every run of the session as the outline's rows — parent_run_id is the tree, the rest is what a row shows — and
   *  the plans' rows with them: a relay's steps and an interaction's nodes one row each (a run's row where the node
   *  has one, a placeholder while it has none), a director's plan row its nodes hang under, the decision that is the
   *  person's. */
  app.get('/api/sessions/:session_id/runs/tree', (c) => {
    const sessionId = c.req.param('session_id')
    requireSession(state, sessionId)
    const collab = collabOfRuns(state, sessionId)
    const runs = repo.listRuns(state.conn, sessionId).map((run) => ({ ...treeRow(run, state.runs.handles.get(run.id)), collab: collab.get(run.id) ?? null }))
    const interactions: InteractionRows[] = repo.listInteractions(state.conn, sessionId).map((interaction) => ({
      interaction, nodes: repo.listNodes(state.conn, interaction.id),
      director_model: interaction.director_session_id ? getDirectorSession(state.conn, interaction.director_session_id)?.model ?? null : null,
      adopted: repo.listInteractionEvents(state.conn, interaction.id).some((e) => e.kind === 'adopted'),
    }))
    const rows = planRows(runs, repo.listRelays(state.conn, sessionId), interactions)
    stampDepths(rows)
    return c.json({ session_id: sessionId, runs: rows })
  })

  /** What the session thread's next request would carry: tokens (counted for a route whose tokenizer is at hand, else
   *  the last run's labelled calibration), bytes, the window and the budget, the last run's prompt-cache series. */
  app.get('/api/sessions/:session_id/context', async (c) => {
    const sessionId = c.req.param('session_id')
    requireSession(state, sessionId)
    const model = c.req.query('model') ?? null
    if (model !== null && !state.runs.knowsModel(model)) throw new HttpError(400, `unknown model: ${model}`)
    try { return c.json(await contextReportAsync(state, sessionId, model)) }
    catch (error) {
      if (error instanceof ContextReportUnavailable) throw new HttpError(503, error.message)
      throw error
    }
  })

  /** The replay (adapted from oasis's project replay, see NOTICE): every run of the session as a tree row and every
   *  persisted event of every run with the moment it was written, merged in time order. */
  app.get('/api/sessions/:session_id/replay', (c) => {
    const sessionId = c.req.param('session_id')
    requireSession(state, sessionId)
    const collab = collabOfRuns(state, sessionId)
    const rows: Record<string, unknown>[] = repo.listRuns(state.conn, sessionId).map((run) => ({ ...treeRow(run), collab: collab.get(run.id) ?? null }))
    const events = repo.listSessionEvents(state.conn, sessionId)
    const times = [...rows.map((r) => r.created_at as string), ...rows.filter((r) => r.finished_at).map((r) => r.finished_at as string), ...events.map((e) => e.t)]
    times.sort()
    return c.json({ session_id: sessionId, runs: rows, events, t0: times.length ? times[0] : null, t1: times.length ? times[times.length - 1] : null })
  })

  /** Mirror one exchange of a conversation held outside this program (ChatGPT as the director) into the session's
   *  thread. No run starts; the runs the director then sends stand beside the note in the thread. */
  app.post('/api/sessions/:session_id/director-notes', async (c) => {
    const sessionId = c.req.param('session_id')
    requireSession(state, sessionId)
    const body = await parseBody(c, DirectorNoteBodySchema)
    if (!body.answer.trim()) throw new HttpError(400, 'answer is required')
    if (!body.source.trim()) throw new HttpError(400, 'source is required')
    return c.json(repo.insertDirectorNote(state.conn, sessionId, { source: body.source.trim(), model: body.model.trim(), question: body.question.trim(), answer: body.answer.trim() }))
  })

  app.get('/api/sessions/:session_id/director-notes', (c) => {
    const sessionId = c.req.param('session_id')
    requireSession(state, sessionId)
    return c.json({ session_id: sessionId, notes: repo.listDirectorNotes(state.conn, sessionId) })
  })

  /** Interactive mode: a person dispatches a work order — a run of its own (fresh context: the order's prompt; the
   *  order's model, tools, scope, execution policy, budget) on its own worktree started from the session workspace's
   *  state now (pinned as a checkpoint) or from the checkpoint the order names, spawned_by=human, whose receipt comes
   *  back to the person. It never joins the session thread's conversation. */
  app.post('/api/sessions/:session_id/work-orders', async (c) => {
    const sessionId = c.req.param('session_id')
    const session = requireSession(state, sessionId)
    const project = requireProject(state, session.project_id)
    const body = await parseBody(c, WorkOrderBodySchema)
    if (project.target?.kind === 'ssh' && body.workspace_policy === 'isolated') throw new HttpError(409, 'Remote isolated workspaces are unavailable; no work order was started.', 'capability_unavailable')
    const asked = requestOrigin(c, state, sessionId, typeof body.work_order.resumes_run_id === 'string' && body.work_order.resumes_run_id ? 'resume' : 'separate')
    // an order continues a separate task's run only: a thread's or a member's conversation never goes on under an
    // order (it would work where that conversation works, with another tool list) — whichever way it is asked
    {
      const named = typeof body.work_order.resumes_run_id === 'string' && body.work_order.resumes_run_id ? repo.getRun(state.conn, body.work_order.resumes_run_id) : null
      if (named !== null && named.session_id === sessionId) {
        const role = collabOfRuns(state, sessionId).get(named.id)?.participant_role ?? null
        if (named.work_order === null || (role !== null && role !== 'separate')) throw new HttpError(400, `resumes_run_id names a run that is not a separate task's (${named.id}): a work order continues only a separate task's run; a participant's conversation is continued with POST /api/runs/${named.id}/resume`)
      }
    }
    let handover: Handover
    try { handover = prepareHandover(state, session, { cites: body.cites, receive_run_ids: body.receive_run_ids, by: asked.origin, across_sessions: body.receive_across_sessions === true }) } catch (error) { throw asHttpError(error) }
    const isolated = body.workspace_policy === 'isolated'
    const intent = body.client_request_id ? intentOf({ route: 'work_order', session: sessionId, work_order: body.work_order, thinking: body.thinking ?? null, workspace_policy: body.workspace_policy ?? 'legacy', cites: body.cites ?? [], receive_run_ids: body.receive_run_ids ?? [], ...(body.receive_across_sessions ? { receive_across_sessions: true } : {}) }) : null
    let order
    try {
      // an order that continues an earlier run of the session inherits that run's order and may only narrow it —
      // the same rule as a follow-up through /resume, whichever way the continuation is asked for
      const raw = body.work_order
      const resumes = typeof raw.resumes_run_id === 'string' && raw.resumes_run_id ? repo.getRun(state.conn, raw.resumes_run_id) : null
      if (resumes !== null && resumes.session_id === sessionId && resumes.work_order !== null) {
        // the continued run's worktree is the one it runs in: a base is no part of what narrows
        const patch = Object.fromEntries(Object.entries(raw).filter(([key]) => !['prompt', 'resumes_run_id', 'workspace'].includes(key)))
        order = parseWorkOrder({ ...narrowOrder(resumes.work_order, patch), prompt: raw.prompt, resumes_run_id: raw.resumes_run_id })
      } else order = parseWorkOrder(raw)
    } catch (error) {
      if (error instanceof OrderWidened) throw new HttpError(400, error.message)
      if (error instanceof WorkOrderInvalid) throw new HttpError(400, `invalid work order: ${error.message}`)
      throw error
    }
    if (order.model !== null && !state.runs.knowsModel(order.model)) throw new HttpError(400, `unknown model: ${order.model}`)
    if (session.workspace_id === null) throw new HttpError(409, 'the session has no workspace')
    const ws = repo.getWorkspace(state.conn, session.workspace_id)!
    const thinking = thinkingOr400(body.thinking)
    let run
    try {
      run = await state.runs.startOnce(session.id, body.client_request_id, async () => {
      let wsId: string
      if (order.resumes_run_id !== null) {
        const previous = repo.getRun(state.conn, order.resumes_run_id)
        if (previous === null || previous.session_id !== sessionId || previous.workspace_id === null) {
          throw new HttpError(400, `resumes_run_id is not a run of this session: ${order.resumes_run_id}`)
        }
        if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(previous.status)) throw new HttpError(409, `run ${order.resumes_run_id} is still ${previous.status}`)
        wsId = previous.workspace_id
      } else if (isolated && (isDirect(ws) || ws.source_mount !== null || project.kind === 'attached')) {
        // isolated (v25): an output folder of its own, the source folder mounted live and read-only beside it — never
        // the folder itself, whatever the project's kind
        if (order.workspace.base !== 'parent') throw new HttpError(400, 'an isolated work order over a direct or attached folder starts from the folder as it is (workspace.base: parent)')
        try { wsId = (await state.workspaces.createSourceWorkspace(project, session.id, ws)).id } catch (error) {
          if (error instanceof GitError) throw new HttpError(409, error.message)
          throw error
        }
      } else if (isDirect(ws)) {
        // a folder edited in place: the order's run works in it, after the thread's writer (the workspace lock)
        if (order.workspace.base !== 'parent') throw new HttpError(400, 'a folder edited in place has no checkpoints: a work order there starts from the folder as it is (workspace.base: parent)')
        wsId = ws.id
      } else {
        try {
          let baseCommit: string
          if (order.workspace.base === 'parent') {
            // pinned as the folder's writer: refused while another writer holds it, naming it and the latest checkpoint
            const latest = repo.latestCheckpoint(state.conn, ws.id)
            baseCommit = (await underFolderLock(state, ws.id, 'work_order_base', () => state.workspaces.checkpoint(ws, null, `base for work order ${order.label ?? ''}`.trimEnd()),
              (h) => latest ? `name a checkpoint as workspace.base (the latest is ${latest.id}), or send it again ${holderEnds(h)}` : `send it again ${holderEnds(h)}, or name a checkpoint as workspace.base`,
              { latest_checkpoint_id: latest?.id ?? null })).commit_sha
          } else {
            const cp = repo.getCheckpoint(state.conn, order.workspace.base)
            const cpWs = cp ? repo.getWorkspace(state.conn, cp.workspace_id) : null
            if (cp === null || cpWs === null || cpWs.project_id !== project.id) {
              throw new HttpError(400, `workspace.base names no checkpoint of this project: ${order.workspace.base}`)
            }
            baseCommit = cp.commit_sha
          }
          // the child's repository reads the view of that checkpoint — not the rest of the workspace that pinned it
          wsId = (await state.workspaces.createWorkspace(project, session.id, { kind: 'child', base_commit: baseCommit })).id
        } catch (error) {
          if (error instanceof GitError) throw new HttpError(409, error.message)
          throw error
        }
      }
        const created = repo.getWorkspace(state.conn, wsId)
        const wsEdge = order.resumes_run_id !== null ? [{ kind: 'workspace', from: { kind: 'run', id: order.resumes_run_id }, meta: { mode: 'same_workspace', workspace_id: wsId, checkpoint_id: null } }]
          : wsId === ws.id ? [{ kind: 'workspace', from: { kind: 'workspace', id: ws.id }, meta: { mode: 'session_folder', workspace_id: wsId, checkpoint_id: null } }]
          : created?.source_mount ? [{ kind: 'workspace', from: { kind: 'workspace', id: ws.id }, meta: { mode: 'source_mount', workspace_id: wsId, checkpoint_id: null } }]
          : [{ kind: 'workspace', from: { kind: 'workspace', id: ws.id }, meta: { mode: 'checkpoint_copy', workspace_id: wsId, checkpoint_id: order.workspace.base === 'parent' ? null : order.workspace.base } }]
        return state.runs.start(session, order.prompt, {
          spawned_by: asked.spawned_by, label: order.label ?? asked.via, work_order: order, resumes_run_id: order.resumes_run_id, workspace_id: wsId, thinking,
          client_request_id: body.client_request_id ?? null,
          collab: { origin: asked.origin, edges: [...wsEdge, ...handover.edges], lines: handover.lines, handover: handover.lines.length ? { received: handover.received, cited: handover.cited } : null, intent_sha: intent },
        })
      }, intent)
    } catch (error) {
      const known = asHttpError(error)
      if (known instanceof HttpError) throw known
      throw new HttpError(409, (error as Error).message)
    }
    return c.json(runAnswer(state, run))
  })

  app.put('/api/sessions/:session_id/grants', async (c) => {
    const sessionId = c.req.param('session_id')
    const session = requireSession(state, sessionId)
    const body = await parseBody(c, GrantsBodySchema)
    const grants = { ...session.grants }
    if (body.workspace_write !== null && body.workspace_write !== undefined) grants.workspace_write = body.workspace_write
    if (body.run_commands !== null && body.run_commands !== undefined) grants.run_commands = body.run_commands
    if (body.attached_write !== null && body.attached_write !== undefined) grants.attached_write = body.attached_write
    if (body.network !== null && body.network !== undefined) {
      grants.network = body.network
      grants.network_reason = body.network_reason ?? null
      if (body.network && body.network_minutes) grants.network_until = new Date(Date.now() + body.network_minutes * 60_000).toISOString()
      else if (!body.network) grants.network_until = null
    }
    repo.setSessionGrants(state.conn, sessionId, grants)
    return c.json(sessionDetail(state, repo.getSession(state.conn, sessionId)!))
  })

  app.put('/api/sessions/:session_id/model', async (c) => {
    const sessionId = c.req.param('session_id')
    requireSession(state, sessionId)
    const body = await parseBody(c, ModelBodySchema)
    if (!knownModel(body.model)) throw new HttpError(400, `unknown model: ${body.model}`)
    repo.setSessionModel(state.conn, sessionId, body.model)
    return c.json(sessionDetail(state, repo.getSession(state.conn, sessionId)!))
  })

  app.post('/api/approvals/:approval_id', async (c) => {
    const approvalId = c.req.param('approval_id')
    const body = await parseBody(c, DecisionBodySchema)
    try {
      return c.json(state.gate.decide(approvalId, body.approve))
    } catch (error) {
      if (error instanceof NotFound) throw new HttpError(404, `approval not found: ${approvalId}`)
      throw new HttpError(409, (error as Error).message)
    }
  })

  return app
}
