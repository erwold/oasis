import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { ACTIVE_RUN_STATUSES, agentMentionsOf, ChatBodySchema, isThreadRun, MentionSchema, participantsOf, ResumeBodySchema, SteerBodySchema, THINKING_LEVELS, toolMentionsOf } from '@oasis-code/contract'
import { RelayInvalid, RelayManager } from '../agent/relay.ts'
import { inheritedMessageCount, rebuildTranscript, toolCallOf } from '../agent/transcript.ts'
import { narrowOrder, OrderWidened, parseWorkOrder, WorkOrderInvalid } from '../agent/work_orders.ts'
import * as repo from '../db/repo.ts'
import { resolveMentions, type Mention } from '../workspace/entities.ts'
import { PathPolicy } from '../workspace/paths.ts'
import { cutPatch, isDirect } from '../workspace/service.ts'
import { agentBound, HttpError, intentOf, parseBody, requestOrigin, type Api } from './common.ts'
import { widerThanBound } from '../policy/delegation.ts'
import { collabOfRuns, prepareHandover, type Handover } from '../agent/collab.ts'
import { asHttpError, continueParticipant, runAnswer } from './collaboration.ts'
import { requireSession } from './state.ts'
import { attachmentsFor } from './attachments.ts'
import { attachmentRefusal } from '@oasis-code/contract'
import { findModel } from '../llm/catalog.ts'
import { GitError } from '../workspace/git.ts'
import { holderEnds, WorkspaceBusy } from '../workspace/locks.ts'
import { busyHttp } from './folder_lock.ts'
import { markerOf, snapshotUnavailable } from '../agent/attribution.ts'
import { newId } from '../ids.ts'

export function thinkingOr400(value: string | null | undefined): string | null {
  if (value !== null && value !== undefined && !(THINKING_LEVELS as readonly string[]).includes(value)) {
    throw new HttpError(400, `thinking must be one of ${THINKING_LEVELS.join(', ')}`)
  }
  return value ?? null
}

/** Each participant's own thinking effort, by its id in the message, every level checked. */
export function participantThinkingOr400(given: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(given).map(([id, level]) => [id, thinkingOr400(level)!]))
}

export function runRoutes(api: Api): Hono {
  const app = new Hono()
  const { state } = api
  const requireRun = (runId: string) => {
    const run = repo.getRun(state.conn, runId)
    if (run === null) throw new HttpError(404, `run not found: ${runId}`)
    return run
  }

  app.post('/api/sessions/:session_id/chat', async (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    const body = await parseBody(c, ChatBodySchema)
    // an agent run's message (open_ssh_session) goes only to a session no wider than that run (policy/delegation.ts)
    const bound = agentBound(state)
    if (bound !== null) {
      const wider = widerThanBound(state.conn, session, bound)
      if (wider !== null) throw new HttpError(403, `an agent run may not start work in session ${session.id}: ${wider}`, 'wider_than_caller')
    }
    // a message is words, images, or both
    if (!body.text.trim() && !body.attachments.length) throw new HttpError(400, 'text is required unless the message carries an attachment')
    // who asks (schema v25): a director's turn (its checked headers), a connector's client, or the person
    const asked = requestOrigin(c, state, session.id, 'message')
    // a resend of a message the harness already took (its answer was lost on the way back): the run it started — the
    // same key for another message (another target, words, model, citation…) is refused, never answered with that run
    const key = body.client_request_id ?? null
    const intent = key !== null ? intentOf({
      route: 'chat', session: session.id, text: body.text, model: body.model ?? null, thinking: body.thinking ?? null, participant_thinking: body.participant_thinking,
      budget: body.budget ?? null, agents: body.agents, rounds: body.rounds ?? null, attachments: body.attachments,
      mentions: body.mentions, resumes_run_id: body.resumes_run_id ?? null, fresh: body.fresh, cites: body.cites ?? [], receive_run_ids: body.receive_run_ids ?? [],
      ...(body.receive_across_sessions ? { receive_across_sessions: true } : {}),
    }) : null
    const earlier = key !== null ? repo.runForClientRequest(state.conn, session.id, key) : null
    if (earlier !== null) {
      try { state.runs.checkIntent(key!, earlier.id, intent) } catch (error) { throw asHttpError(error) }
      return c.json(runAnswer(state, earlier))
    }
    if (key !== null) { try { state.runs.checkKeyFree(session.id, key) } catch (error) { throw asHttpError(error) } }
    // a message to the thread continues the main agent's conversation, or — named — another participant's history; a
    // separate task's run is continued under its order (its own follow-up), never by a thread message that would drop it
    if (body.resumes_run_id) {
      const named = repo.getRun(state.conn, body.resumes_run_id)
      if (named !== null && named.session_id === session.id) {
        const collab = collabOfRuns(state, session.id).get(named.id) ?? null
        const role = collab?.participant_role ?? null
        if (role === 'separate' || role === 'child' || named.work_order !== null) throw new HttpError(400, `resumes_run_id names a separate task's run (${named.id}): its follow-up goes through POST /api/runs/${named.id}/resume, under its order`)
        // an interaction member's run: its conversation goes on as a step of its group (budget, board, its own
        // workspace) — a thread message naming it would take it over as the main agent's; it is refused, not re-routed
        if (role === 'member' && collab?.placement.group?.kind === 'interaction') {
          throw new HttpError(400, `resumes_run_id names a run of a participant of interaction ${collab.placement.group.id} (${named.id}): its follow-up goes through POST /api/runs/${named.id}/resume or POST /api/participants/${collab.participant_id}/messages, as a step of that interaction`)
        }
      }
    }
    let handover: Handover
    try { handover = prepareHandover(state, session, { cites: body.cites, receive_run_ids: body.receive_run_ids, by: asked.origin, across_sessions: body.receive_across_sessions === true }) } catch (error) { throw asHttpError(error) }
    let mentions = null
    if (body.mentions.length) {
      const ws = session.workspace_id ? repo.getWorkspace(state.conn, session.workspace_id) : null
      if (ws === null) throw new HttpError(409, 'the session has no workspace')
      const parsed: Mention[] = []
      for (const m of body.mentions) {
        const result = MentionSchema.safeParse(m)
        if (!result.success) throw new HttpError(400, result.error.issues.map((i) => i.message).join('; '))
        parsed.push(result.data)
      }
      try {
        mentions = resolveMentions(PathPolicy.forWorkspace(ws.path, [], null, { pinned: isDirect(ws) }), parsed)
      } catch (error) {
        throw new HttpError(400, (error as Error).message)
      }
    }
    const attachments = attachmentsFor(state, session, body.attachments)
    const thinking = thinkingOr400(body.thinking)
    const own = participantThinkingOr400(body.participant_thinking)
    // an interaction under way (its runs side by side, or its director planning) takes the session: a message to the
    // agents waits for it, or stops it
    const interaction = state.interactions.active(session.id)
    if (interaction !== null) throw new HttpError(409, `an interaction is under way in this session (${interaction.id}, ${interaction.status}); stop it first`)
    // two or more agents named: a relay — they take turns on the message, in the order named; every participant is
    // checked before anything starts (the route, its credential, image input when images ride along)
    if (body.agents.length >= 2) {
      // a resend of a relay whose first turn never started (a crash or a refused start between its row and its first
      // run): the same intent, started now — not a second relay, not superseded
      const earlierRelay = key !== null ? repo.relayForClientRequest(state.conn, session.id, key) : null
      if (earlierRelay !== null) {
        if (!RelayManager.unstarted(earlierRelay)) {
          const first = repo.listRunsOfRelay(state.conn, earlierRelay.id)[0]
          if (first) return c.json(runAnswer(state, first))
        }
        // stopped by the person (or superseded by their later message) before it ran: that intent is over; a resend
        // never undoes a Stop — the words go as a new message with a new key
        if (earlierRelay.status === 'cancelled') throw new HttpError(409, `the earlier request with this key was stopped (${earlierRelay.reason ?? 'cancelled'}); send it as a new message`)
        try {
          repo.updateRelay(state.conn, earlierRelay.id, { status: 'running', reason: null, finished_at: null })
          return c.json(runAnswer(state, await state.relays.startFirst(repo.getRelay(state.conn, earlierRelay.id)!, { handover, intent_sha: intent, origin: asked.origin })))
        } catch (error) {
          const raced = repo.runForClientRequest(state.conn, session.id, key!)
          if (raced !== null) return c.json(runAnswer(state, raced))
          if (error instanceof RelayInvalid) throw new HttpError(error.status, error.message)
          const message = (error as Error).message
          throw new HttpError(/already has an active run|is still|being written/.test(message) ? 409 : 400, message)
        }
      }
      // the participants' aliases and labels are the message's own when its tokens carry them (the same agents, in order)
      const named = participantsOf(body.text)
      const agents = named.length === body.agents.length && named.every((p, i) => p.model === body.agents[i]!.model)
        ? named.map((p) => ({ ...p, thinking: own.get(p.id) ?? null }))
        : body.agents
      let plan
      try { plan = state.relays.plan(agents, body.rounds, attachments) } catch (error) {
        if (error instanceof RelayInvalid) throw new HttpError(error.status, error.message)
        throw error
      }
      if (body.resumes_run_id) {
        const previous = repo.getRun(state.conn, body.resumes_run_id)
        if (previous === null || previous.session_id !== session.id) throw new HttpError(400, `resumes_run_id is not a run of this session: ${body.resumes_run_id}`)
      }
      state.relays.supersede(session.id)
      state.interactions.supersede(session.id)
      try {
        const started = await state.relays.start(session, {
          text: body.text, plan, mentions: mentions ?? [], attachments, thinking, budget: body.budget ?? null, client_request_id: key,
          fresh: body.fresh, resumes_run_id: body.resumes_run_id ?? null, handover, intent_sha: intent, origin: asked.origin,
        })
        return c.json(runAnswer(state, started.run))
      } catch (error) {
        const raced = key !== null ? repo.runForClientRequest(state.conn, session.id, key) : null
        if (raced !== null) return c.json(runAnswer(state, raced))
        if (error instanceof RelayInvalid) throw new HttpError(error.status, error.message)
        const message = (error as Error).message
        throw new HttpError(/already has an active run|is still|being written/.test(message) ? 409 : 400, message)
      }
    }
    // one agent named: the model of this run
    const model = body.agents.length === 1 ? body.agents[0]!.model : (body.model ?? null)
    // the one agent named: its own effort, when the person chose one for it
    const [one] = participantsOf(body.text)
    const runThinking = body.agents.length === 1 && one?.model === model ? own.get(one.id) ?? thinking : thinking
    if (model !== null && !state.runs.knowsModel(model)) throw new HttpError(400, `unknown model: ${model}`)
    if (attachments.length) {
      // an image is never dropped in silence or sent where it cannot be read: a route that does not declare image
      // input is refused before anything starts (the words stay with the person, the images too)
      const cfg = findModel(state.config, model || session.model)
      const refusal = cfg && attachmentRefusal(cfg.capabilities, attachments, cfg.label || cfg.id)
      if (refusal) throw new HttpError(400, refusal)
    }
    // a waiting or interrupted relay (or interaction) is the person's to continue; a new message of theirs supersedes it
    state.relays.supersede(session.id)
    state.interactions.supersede(session.id)
    let run
    try {
      run = await state.runs.start(session, body.text, {
        model_id: model, budget: body.budget ?? null, resumes_run_id: body.resumes_run_id ?? null, fresh: body.fresh,
        mentions, thinking: runThinking, attachments, client_request_id: key, spawned_by: asked.spawned_by, label: asked.via,
        collab: { origin: asked.origin, edges: handover.edges, lines: handover.lines, handover: handover.lines.length ? { received: handover.received, cited: handover.cited } : null, intent_sha: intent },
      })
    } catch (error) {
      const known = asHttpError(error)
      if (known instanceof HttpError) throw known
      // the same message racing itself: the first one started the run (and made the session busy, or took the key)
      const raced = key !== null ? repo.runForClientRequest(state.conn, session.id, key) : null
      if (raced !== null) {
        try { state.runs.checkIntent(key!, raced.id, intent) } catch (conflict) { throw asHttpError(conflict) }
        return c.json(runAnswer(state, raced))
      }
      const message = (error as Error).message
      throw new HttpError(/already has an active run|is still|being written/.test(message) ? 409 : 400, message)
    }
    return c.json(runAnswer(state, run))
  })

  app.get('/api/runs/:run_id', (c) => {
    const runId = c.req.param('run_id')
    const run = requireRun(runId)
    const handle = state.runs.handles.get(runId)
    return c.json({
      ...run, live: handle !== undefined && !handle.done, saved_seq: handle ? handle.saved_seq : run.saved_seq, collab: collabOfRuns(state, run.session_id).get(run.id) ?? null,
      requests: repo.listModelRequests(state.conn, runId), executions: repo.listExecutions(state.conn, { run_id: runId }),
      // a queued run: the folder it waits for, who holds it and its place in line (null when it waits for none)
      waiting: state.runs.waitingOf(runId),
    })
  })

  app.get('/api/runs/:run_id/receipt', (c) => {
    const runId = c.req.param('run_id')
    const run = requireRun(runId)
    return c.json({ run_id: runId, status: run.status, receipt: Object.keys(run.receipt).length ? run.receipt : null })
  })

  // what the run's receipt measured, as a patch: its worktree's tree when it finished against the workspace's base;
  // `path` narrows it to one file (a file chip's preview); `full=1` gives each file whole around its changes
  app.get('/api/runs/:run_id/diff', async (c) => {
    const runId = c.req.param('run_id')
    const run = requireRun(runId)
    const produced = (run.receipt as { produced?: { workspace_id?: string | null; tree_sha?: string | null } }).produced
    const measured = ((run.receipt as { mechanical?: { diff?: Record<string, unknown> } }).mechanical?.diff ?? {}) as { attribution?: string; base_tree_sha?: string | null }
    const ws = produced?.workspace_id ? repo.getWorkspace(state.conn, produced.workspace_id) : null
    const path = c.req.query('path')
    const full = c.req.query('full') === '1'
    const marker = markerOf(run.manifest)
    const beside = marker !== null && marker.background_execution_ids.length ? { background_execution_ids: [...marker.background_execution_ids] } : {}
    // in place, the journal is the record whatever the receipt holds (a run that died has one that measured nothing)
    const own = run.workspace_id ? repo.getWorkspace(state.conn, run.workspace_id) : null
    if (own && isDirect(own)) {
      // in place: the run's own file-tool writes, from the journal (its first "before" against its last "after") — a path
      // another hand wrote between two of its writes is not shown as the run's, and named
      const attributed = state.workspaces.journal.runAttributed(runId)
      const result = state.workspaces.journal.diffOf(attributed.changes.filter((ch) => !path || ch.path === path), full)
      const shown = path ? { patch: result.patch, cut: null } : cutPatch(result.patch)
      const attribution = marker?.overlapped || attributed.unattributed.length ? 'partial' : 'exact'
      return c.json({ run_id: runId, base_commit: '', tree_sha: '', files: result.files, patch: shown.patch, patch_cut: shown.cut, in_place: true, attribution,
        ...(attributed.unattributed.length ? { unattributed_paths: attributed.unattributed } : {}), ...beside })
    }
    // a snapshot workspace's run with no baseline of its own: nothing is shown as its change (which is not "none")
    if (snapshotUnavailable(marker) || measured.attribution === 'unavailable') {
      throw new HttpError(409, `run ${runId} has no reliable baseline: it worked beside commands of an earlier run of its conversation, or left its own running, so no change is attributed to it; the workspace's own diff shows the folder as it stands`,
        'attribution_unavailable', { run_id: runId, background_execution_ids: marker?.background_execution_ids ?? [] })
    }
    if (!ws || !produced?.tree_sha) throw new HttpError(409, `run ${runId} has no measured change to show`)
    try {
      // against the run's own baseline (taken as it was let in), else — a run from before baselines — the workspace's base
      const from = typeof measured.base_tree_sha === 'string' ? measured.base_tree_sha : null
      const result = await state.workspaces.diff(ws, { tree: produced.tree_sha, paths: path ? [path] : null, full, from })
      const files = path ? result.files.filter((f) => f.path === path) : result.files
      const shown = path ? { patch: result.patch, cut: null } : cutPatch(result.patch)
      return c.json({ run_id: runId, base_commit: result.base_commit, tree_sha: result.tree_sha, files, patch: shown.patch, patch_cut: shown.cut, ...(from !== null ? { attribution: 'exact' } : {}) })
    } catch (error) {
      if (error instanceof GitError) throw new HttpError(409, error.message)
      throw error
    }
  })

  /** A run's file changes undone, in a folder edited in place: each file its tools wrote put back as it was before
   *  the run, or removed when the run created it — a file changed since (the person's edit, a later run's) is left
   *  alone and named. Refused while a run writes the folder. A command's writes are not undone (they are not kept). */
  app.post('/api/runs/:run_id/undo', async (c) => {
    const runId = c.req.param('run_id')
    const run = requireRun(runId)
    if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) throw new HttpError(409, `run ${runId} is still ${run.status}`)
    const ws = run.workspace_id ? repo.getWorkspace(state.conn, run.workspace_id) : null
    if (ws === null || !isDirect(ws)) throw new HttpError(409, `run ${runId} did not work in a folder edited in place: its changes are on its own worktree`)
    // a run that worked beside commands of an earlier run of its conversation: which bytes its tools left cannot be told
    // from theirs (a write of the same bytes, one undone before it was seen) — no whole-run undo, even after they ended;
    // nothing is touched
    const marker = markerOf(run.manifest)
    if (marker?.overlapped) {
      throw new HttpError(409, `run ${runId} worked beside commands an earlier run of its conversation left running (${marker.background_execution_ids.join(', ')}); its changes cannot be told apart from theirs, so it cannot be undone as a whole — nothing was changed`,
        'attribution_unavailable', { run_id: runId, background_execution_ids: marker.background_execution_ids })
    }
    // the folder is taken for the undo, and held until it is done (a remote undo awaits its writes): the run itself
    // may still hold it a moment after it finished (its lock goes last) — then under its own hold; never while anyone
    // else holds it, the commands a run left running included
    const owner = state.locks.holder(ws.id) === runId && state.locks.busy(ws.id, 'undo', null, runId) === null ? runId : `operation:undo:${newId('op')}`
    try {
      state.locks.acquireNow(ws.id, owner, { kind: owner === runId ? 'run' : 'operation', operation: 'undo' }, (h) => `undo ${holderEnds(h)}`)
    } catch (error) {
      if (error instanceof WorkspaceBusy) throw busyHttp(error)
      throw error
    }
    try {
      // a command outlives the run that started it: while one runs in the folder, a file put back could be written
      // again under the undo, and the undo would report what no longer holds
      const running = state.processes.runningInWorkspace(ws.id)
      if (running.length) {
        const next = `stop it (POST /api/executions/${running[0]}/stop), then undo`
        throw new HttpError(409, `a command is still running in the folder (execution ${running.join(', ')}); ${next}`, 'workspace_busy', {
          workspace_id: ws.id, operation: 'undo', blocking_owner: repo.getExecution(state.conn, running[0]!)?.run_id ?? `execution:${running[0]}`, blocking_kind: 'command',
          blocking_run_id: repo.getExecution(state.conn, running[0]!)?.run_id ?? null, blocking_session_id: null, blocking_execution_ids: running, blocking_proposal_id: null,
          blocking_since: repo.getExecution(state.conn, running[0]!)?.created_at ?? null, queued: state.locks.state(ws.id).waiters.length, next_step: next,
        })
      }
      if (ws.target?.kind === 'ssh') return c.json(await state.workspaces.requireRemoteFiles().undo(ws, runId, run.session_id))
      return c.json(state.workspaces.journal.undoRun(ws, runId, run.session_id))
    } finally {
      state.locks.release(ws.id, owner)
    }
  })

  /** The run's own transcript: its history holds the whole conversation it continued (the model's context, kept
   *  whole), but the record shown for this run begins where the inherited conversation ends. */
  app.get('/api/runs/:run_id/transcript', (c) => {
    const runId = c.req.param('run_id')
    const run = requireRun(runId)
    const ended = ACTIVE_RUN_STATUSES.includes(run.status) ? null : run.status
    const steers = state.runs.steersOf(runId)
    const entries = rebuildTranscript(repo.getRunHistory(state.conn, runId), inheritedMessageCount(state.conn, run), ended, repo.listUiSurfaces(state.conn, run.session_id, runId),
      repo.listUiInputs(state.conn, run.session_id, { run_id: runId, limit: 1_000 }), steers, repo.listCompactionEvents(state.conn, runId))
    return c.json({ run_id: runId, status: run.status, model: run.model, entries, steers })
  })

  // one tool call as its model saw it: the arguments and the whole return, asked when the person opens its row
  app.get('/api/runs/:run_id/calls/:tool_call_id', (c) => {
    const runId = c.req.param('run_id')
    requireRun(runId)
    const call = toolCallOf(repo.getRunHistory(state.conn, runId), c.req.param('tool_call_id'))
    if (call === null) throw new HttpError(404, `no tool call ${c.req.param('tool_call_id')} in run ${runId}`)
    return c.json({ run_id: runId, tool_call_id: c.req.param('tool_call_id'), ...call })
  })

  app.get('/api/runs/:run_id/events', (c) => {
    const runId = c.req.param('run_id')
    requireRun(runId)
    let after = -1
    for (const candidate of [c.req.header('last-event-id'), c.req.query('after')]) {
      if (candidate === undefined) continue
      const value = Number(candidate)
      if (Number.isInteger(value)) { after = value; break }
    }
    const gone = new AbortController()
    const events = state.runs.subscribe(runId, { after_seq: after, signal: gone.signal })
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => gone.abort())
      // a comment line now and then: a quiet run (thinking, or a long command) keeps its connection through the
      // server's idle timeout and a tunnel's, and a client that went away is noticed when the write fails
      const beat = setInterval(() => { void stream.write(': keep-alive\n\n').catch(() => gone.abort()) }, state.sse_heartbeat_ms)
      try {
        for await (const item of events) {
          // the payload goes as JSON once; the id is the cursor a client resubscribes after
          await stream.writeSSE({ data: JSON.stringify(item.data), event: item.event, id: String(item.seq) })
        }
      } finally {
        clearInterval(beat)
      }
    })
  })

  /** A page of a run's events after `after` (at most `limit`, 1–1000): what a page following the session's one stream
   *  lacks of a run (its start before the stream's cursor, what it let go) is read here, a bounded read, never a
   *  stream of the run's own. */
  app.get('/api/runs/:run_id/events/page', (c) => {
    const runId = c.req.param('run_id')
    const run = requireRun(runId)
    const after = Number(c.req.query('after') ?? -1)
    const limit = Number(c.req.query('limit') ?? 500)
    if (!Number.isSafeInteger(after) || after < -1) throw new HttpError(400, 'after: an integer, -1 or more', 'invalid_input')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new HttpError(400, 'limit: an integer from 1 to 1000', 'invalid_input')
    return c.json({ run_id: runId, session_id: run.session_id, events: state.runs.eventsPage(runId, after, limit) })
  })

  /** Every run of a session on one stream (agent/session_events.ts): a page holds one connection however many runs work
   *  (a browser keeps at most six per host over HTTP/1.1; a stream per run left none for the page's own requests). The
   *  id of each frame is the session cursor; a client resumes with Last-Event-ID or `after` (a session detail's
   *  event_cursor); with neither it begins at the cursor a detail read now would name. */
  app.get('/api/sessions/:session_id/events', (c) => {
    const sessionId = c.req.param('session_id')
    requireSession(state, sessionId)
    let after: number | null = null
    for (const candidate of [c.req.header('last-event-id'), c.req.query('after')]) {
      if (candidate === undefined || candidate === '') continue
      const value = Number(candidate)
      if (Number.isSafeInteger(value)) { after = value; break }
    }
    const gone = new AbortController()
    const frames = state.runs.subscribeSession(sessionId, { after: after ?? state.runs.sessionCursor(sessionId), signal: gone.signal })
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => gone.abort())
      const beat = setInterval(() => { void stream.write(': keep-alive\n\n').catch(() => gone.abort()) }, state.sse_heartbeat_ms)
      try {
        for await (const frame of frames) await stream.writeSSE({ data: frame.data, event: frame.event, id: String(frame.id) })
      } finally {
        clearInterval(beat)
        gone.abort()
      }
    })
  })

  /** Words to a live run — the person's, a director's or the connector's — handed to its model at the run's next request
   *  boundary (contract/src/steering.ts). Plain text only, kept exactly as sent; the same key again answers with the
   *  steer it made, and with other words is refused (key_conflict). */
  app.post('/api/runs/:run_id/steer', async (c) => {
    const runId = c.req.param('run_id')
    let raw: unknown
    try { raw = await c.req.json() } catch { throw new HttpError(400, 'the body must be JSON: { text, client_request_id }', 'invalid_input') }
    if (raw && typeof raw === 'object' && ('attachments' in raw || 'mentions' in raw)) {
      throw new HttpError(400, 'a message to a running agent is plain text: attachments and mentions go with your next message', 'invalid_input')
    }
    const parsed = SteerBodySchema.safeParse(raw)
    if (!parsed.success) {
      const empty = raw && typeof raw === 'object' && (raw as { text?: unknown }).text === ''
      throw new HttpError(400, empty ? 'text is required' : parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), empty ? 'empty_text' : 'invalid_input')
    }
    const body = parsed.data
    if (!body.text.trim()) throw new HttpError(400, 'text is required', 'empty_text')
    if (agentMentionsOf(body.text).length || toolMentionsOf(body.text).length) {
      throw new HttpError(400, 'a message to a running agent names no agent or tool: send it as plain words, or as your next message', 'steer_agents')
    }
    const run = requireRun(runId)
    // whose words: the request's own origin says — a director's call (checked against its session and turn), the
    // connector's client (its name from the request's header, never the body: the body is strict), else the person
    const { origin } = requestOrigin(c, state, run.session_id, 'message')
    const by = origin.actor === 'director' ? 'director' : origin.actor === 'connector' ? 'connector' : 'person'
    const out = state.runs.steer(runId, body.text, body.client_request_id, by, origin.client)
    if ('refusal' in out) throw new HttpError(409, out.detail, out.refusal)
    return c.json({ run_id: runId, steer: out.steer })
  })

  app.get('/api/runs/:run_id/steers', (c) => {
    const runId = c.req.param('run_id')
    requireRun(runId)
    return c.json({ steers: state.runs.steersOf(runId) })
  })

  /** Stop a run and every child run under it. */
  app.post('/api/runs/:run_id/cancel', (c) => {
    const runId = c.req.param('run_id')
    requireRun(runId)
    return c.json({ cancelled: state.runs.cancel(runId) })
  })

  /** A follow-up message to a run that has ended: a NEW run of the same participant (schema v25) — the main agent's
   *  thread continued from that run (a branch when it is not the latest), a member's next step in its interaction
   *  (counted in its budget, its board's), a relay member's own conversation, a separate task's next run under its
   *  order (what the body gives narrows it, nothing widens it). Answers the Run; 202 with the step when a member's
   *  follow-up waits in its interaction's queue. */
  app.post('/api/runs/:run_id/resume', async (c) => {
    const runId = c.req.param('run_id')
    const previous = requireRun(runId)
    if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(previous.status)) throw new HttpError(409, `run ${runId} is still ${previous.status}; a follow-up needs it finished`)
    const body = await parseBody(c, ResumeBodySchema)
    const out = await continueParticipant(api, c, previous, body)
    if ('queued' in out) return c.json({ queued: true, ...out.queued }, 202)
    return c.json(runAnswer(state, out.run))
  })

  return app
}
