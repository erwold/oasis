/** The director session over HTTP: open, read, pause, close; the person's messages as turns; a turn as it streams
 *  (SSE); an answer delivered from outside (the bridge, the MCP connector); a director's own read of a receipt
 *  acknowledged so the outbox does not repeat it. */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { ACTIVE_DIRECTOR_TURN_STATUSES, DirectorOpenBodySchema, DirectorSayBodySchema, DirectorUpdateBodySchema } from '@oasis-code/contract'
import * as repo from '../db/repo.ts'
import * as dstore from '../director/store.ts'
import { DirectorError } from '../director/controller.ts'
import { HttpError, parseBody, requestOrigin, type Api } from './common.ts'
import { requireSession } from './state.ts'
import { attachmentsFor } from './attachments.ts'
import { thinkingOr400, participantThinkingOr400 } from './runs.ts'

function lift<T>(fn: () => T): T {
  try { return fn() } catch (error) {
    if (error instanceof DirectorError) throw new HttpError(error.status, error.message)
    throw error
  }
}

export function directorRoutes(api: Api): Hono {
  const app = new Hono()
  const { state } = api
  const director = () => state.director

  app.get('/api/sessions/:session_id/director', (c) => {
    const sessionId = c.req.param('session_id')
    requireSession(state, sessionId)
    return c.json(director().detail(sessionId))
  })

  app.post('/api/sessions/:session_id/director', async (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    const body = await parseBody(c, DirectorOpenBodySchema)
    lift(() => director().open(session, body))
    return c.json(director().detail(session.id))
  })

  app.put('/api/sessions/:session_id/director', async (c) => {
    const sessionId = c.req.param('session_id')
    requireSession(state, sessionId)
    const body = await parseBody(c, DirectorUpdateBodySchema)
    lift(() => director().update(sessionId, body))
    return c.json(director().detail(sessionId))
  })

  app.delete('/api/sessions/:session_id/director', (c) => {
    const sessionId = c.req.param('session_id')
    requireSession(state, sessionId)
    const closed = lift(() => director().close(sessionId))
    return c.json({ closed: true, director: closed })
  })

  app.post('/api/sessions/:session_id/director/messages', async (c) => {
    const sessionId = c.req.param('session_id')
    const session = requireSession(state, sessionId)
    const body = await parseBody(c, DirectorSayBodySchema)
    const prior = body.client_request_id ? dstore.turnForClientRequest(state.conn, sessionId, body.client_request_id) : null
    if (prior) return c.json(prior)
    attachmentsFor(state, session, body.attachments)
    thinkingOr400(body.thinking)
    participantThinkingOr400(body.participant_thinking)
    if (body.model && !state.runs.knowsModel(body.model)) throw new HttpError(400, `unknown model: ${body.model}`)
    if (body.resumes_run_id && repo.getRun(state.conn, body.resumes_run_id)?.session_id !== sessionId) throw new HttpError(400, 'resumes_run_id is not a run of this session')
    lift(() => director().ensure(session))
    return c.json(lift(() => director().say(sessionId, body)))
  })

  // the sessions a ChatGPT director turn waits on now (a message the person wrote in oasis-code, or a task event, is
  // with the director): where a director that is not told its session — the page receives the person's words alone —
  // is to work
  app.get('/api/director/waiting', (c) => {
    const waiting = []
    for (const ds of dstore.listOpenDirectorSessions(state.conn)) {
      const turn = ds.current_turn_id ? dstore.getTurn(state.conn, ds.current_turn_id) : null
      if (ds.transport !== 'bridge' || !turn || !(ACTIVE_DIRECTOR_TURN_STATUSES as readonly string[]).includes(turn.status)) continue
      const session = repo.getSession(state.conn, ds.session_id)
      if (!session || session.status === repo.DELETED_SESSION) continue
      const project = repo.getProject(state.conn, session.project_id)
      waiting.push({
        session_id: session.id, title: session.title, project_id: session.project_id, project_name: project?.name ?? null, project_path: project?.source_path ?? null,
        turn_id: turn.id, turn_kind: turn.kind,
      })
    }
    return c.json({ waiting })
  })

  app.get('/api/director-turns/:turn_id', (c) => {
    const turnId = c.req.param('turn_id')
    const turn = state.director.turn(turnId)
    if (!turn) throw new HttpError(404, `director turn not found: ${turnId}`)
    return c.json(turn)
  })

  app.get('/api/director-turns/:turn_id/events', (c) => {
    const turnId = c.req.param('turn_id')
    if (!state.director.turn(turnId)) throw new HttpError(404, `director turn not found: ${turnId}`)
    let after = -1
    for (const candidate of [c.req.header('last-event-id'), c.req.query('after')]) {
      if (candidate === undefined) continue
      const value = Number(candidate)
      if (Number.isInteger(value)) { after = value; break }
    }
    const gone = new AbortController()
    const events = director().subscribe(turnId, { after_seq: after, signal: gone.signal })
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => gone.abort())
      const beat = setInterval(() => { void stream.write(': keep-alive\n\n').catch(() => gone.abort()) }, state.sse_heartbeat_ms)
      try {
        for await (const item of events) await stream.writeSSE({ data: JSON.stringify(item.data), event: item.event, id: String(item.seq) })
      } finally {
        clearInterval(beat)
      }
    })
  })

  app.post('/api/director-turns/:turn_id/cancel', (c) => c.json(lift(() => director().cancelTurn(c.req.param('turn_id')))))


  /** The director read this run's receipt itself: its pending task event needs no turn. */
  app.post('/api/runs/:run_id/director-ack', (c) => {
    const runId = c.req.param('run_id')
    const run = repo.getRun(state.conn, runId)
    if (run === null) throw new HttpError(404, `run not found: ${runId}`)
    // the director that read it: the one its checked headers name (its session, a turn of it, reach over the run's
    // session) — a header that does not check out is refused, never read as another director's
    const asked = requestOrigin(c, state, run.session_id, 'message')
    return c.json({ run_id: runId, acknowledged: director().acknowledgeRun(runId, asked.origin.director_session_id) })
  })

  return app
}
