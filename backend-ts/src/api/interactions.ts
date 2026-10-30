import { Hono } from 'hono'
import { AdoptBodySchema, InteractionBodySchema, InteractionContinueBodySchema, InteractionNoteBodySchema, MentionSchema, participantsOf, ScheduleBodySchema } from '@oasis-code/contract'
import { InteractionInvalid } from '../agent/interactions.ts'
import * as repo from '../db/repo.ts'
import * as dstore from '../director/store.ts'
import { resolveMentions, type Mention } from '../workspace/entities.ts'
import { PathPolicy } from '../workspace/paths.ts'
import { workspaceAttached, isDirect } from '../workspace/service.ts'
import { attachmentsFor } from './attachments.ts'
import { HttpError, intentOf, parseBody, requestOrigin, type Api } from './common.ts'
import { prepareHandover } from '../agent/collab.ts'
import { asHttpError } from './collaboration.ts'
import { participantThinkingOr400, thinkingOr400 } from './runs.ts'
import { requireSession } from './state.ts'

/** The interaction over the API: start one in a session (a template's plan, a fixed graph, or the director's —
 *  asked), read it, give it its plan (the director's tool), stop it, continue it, adopt a node's result. */
export function interactionRoutes(api: Api): Hono {
  const app = new Hono()
  const { state } = api
  const lift = <T>(fn: () => T): T => {
    try { return fn() } catch (error) {
      if (error instanceof InteractionInvalid) throw new HttpError(error.status, error.message, error.code, error.extra)
      throw error
    }
  }
  const liftAsync = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn() } catch (error) {
      if (error instanceof InteractionInvalid) throw new HttpError(error.status, error.message, error.code, error.extra)
      if (error instanceof HttpError) throw error
      const message = (error as Error).message
      throw new HttpError(/already has an active run|is still|being written|under way/.test(message) ? 409 : 400, message)
    }
  }
  const requireInteraction = (id: string) => {
    const interaction = repo.getInteraction(state.conn, id)
    if (interaction === null) throw new HttpError(404, `interaction not found: ${id}`)
    requireSession(state, interaction.session_id)
    return interaction
  }

  app.post('/api/sessions/:session_id/interactions', async (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    const body = await parseBody(c, InteractionBodySchema)
    let originalThinking: string | null = null
    if (body.source_turn_id) {
      const turn = dstore.getTurn(state.conn, body.source_turn_id)
      if (!turn || turn.session_id !== session.id || !turn.envelope) throw new HttpError(400, 'source_turn_id must name an original user turn of this session')
      const original = turn.envelope
      originalThinking = original.thinking ?? null
      Object.assign(body, { text: original.text, attachments: original.attachments, mentions: original.mentions,
        thinking: original.thinking ?? body.thinking, participant_thinking: original.participant_thinking,
        budget: original.budget, fresh: original.fresh, resumes_run_id: original.resumes_run_id,
        client_request_id: `director:${turn.id}`, workspace_policy: 'isolated' })
    }
    if (!body.text.trim() && !body.attachments.length) throw new HttpError(400, 'text is required unless the message carries an attachment')
    // a resend of a request the harness already took: the interaction it started
    const key = body.client_request_id ?? null
    // the request's intent (everything it asks with): the same key with another one is refused, never answered with
    // the first request's interaction
    const intent = key !== null ? intentOf({
      route: 'interaction', session: session.id, text: body.text, participants: body.participants, plan: body.plan ?? null, director_model: body.director_model ?? null,
      mentions: body.mentions, attachments: body.attachments, thinking: body.thinking ?? null, participant_thinking: body.participant_thinking, budget: body.budget ?? null,
      max_runs: body.max_runs ?? null, concurrency: body.concurrency ?? null, fresh: body.fresh, resumes_run_id: body.resumes_run_id ?? null,
      workspace_policy: body.workspace_policy ?? null, source_turn_id: body.source_turn_id ?? null, cites: body.cites ?? [],
    }) : null
    const earlier = key !== null ? repo.interactionForClientRequest(state.conn, session.id, key) : null
    if (earlier !== null) {
      // a stopped one is never revived by its key, whatever the resend says; a live or ended one answers only the same intent
      if (earlier.status === 'cancelled') throw new HttpError(409, `the earlier request with this key was stopped (${earlier.reason ?? 'cancelled'}); send it as a new message`)
      try { state.interactions.checkIntent(earlier, key!, intent) } catch (error) { throw asHttpError(error) }
      return c.json(state.interactions.detail(earlier))
    }
    // the participants: the message's own tokens, else the ones the body names
    const named = participantsOf(body.text)
    const own = participantThinkingOr400(body.participant_thinking)
    const roster = body.participants.map((p) => ({ ...p }))
    if (body.source_turn_id) {
      const claimed = new Set(roster.map((p) => p.id).filter(Boolean))
      for (const p of roster) {
        if (p.id) {
          const original = named.find((n) => n.id === p.id)
          if (original && original.model !== p.model) throw new HttpError(400, `original participant ${p.id} has a different model`)
        } else {
          // Preserve distinct same-model identities in original order; do not replace a natural roster
          // with the @ tokens (a single @ may still request three independent instances).
          const original = named.find((n) => n.model === p.model && !claimed.has(n.id))
          if (original) { p.id = original.id; claimed.add(original.id) }
        }
      }
      if (named.some((n) => !roster.some((p) => p.id === n.id && p.model === n.model))) throw new HttpError(400, 'the roster must retain each original named participant and model')
    }
    const agents = (named.length && !body.source_turn_id ? named : roster)
      .map((a) => ({ ...a, thinking: (a.id ? own.get(a.id) : null) ?? originalThinking ?? ('thinking' in a ? thinkingOr400(a.thinking as string | null) : null) }))
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
      try { mentions = resolveMentions(PathPolicy.forWorkspace(ws.path, [], workspaceAttached(repo.getProject(state.conn, session.project_id)!, ws), { pinned: isDirect(ws) }), parsed) } catch (error) { throw new HttpError(400, (error as Error).message) }
    }
    const attachments = attachmentsFor(state, session, body.attachments)
    const thinking = thinkingOr400(body.thinking)
    const participants = lift(() => state.interactions.plan(agents, attachments))
    if (body.director_model && !state.runs.knowsModel(body.director_model)) throw new HttpError(400, `unknown model: ${body.director_model}`)
    if (body.resumes_run_id) {
      const previous = repo.getRun(state.conn, body.resumes_run_id)
      if (previous === null || previous.session_id !== session.id) throw new HttpError(400, `resumes_run_id is not a run of this session: ${body.resumes_run_id}`)
    }
    // who asks (schema v25): the group's origin, and the runs the request cites — checked before anything is superseded
    const asked = requestOrigin(c, state, session.id, 'message')
    if (body.cites?.length) {
      try { prepareHandover(state, session, { cites: body.cites, by: asked.origin }) } catch (error) { throw asHttpError(error) }
    }
    state.relays.supersede(session.id)
    state.interactions.supersede(session.id)
    const detail = await liftAsync(async () => {
      try {
        return await state.interactions.start(session, {
          workspace_policy: body.workspace_policy, source_turn_id: body.source_turn_id,
          text: body.text, participants, plan: body.plan ?? null, director_model: body.director_model ?? null, mentions: mentions ?? [], attachments, thinking,
          budget: body.budget ?? null, max_runs: body.max_runs ?? null, concurrency: body.concurrency ?? null, client_request_id: key, fresh: body.fresh, resumes_run_id: body.resumes_run_id ?? null,
          origin: asked.origin, cites: body.cites ?? null, intent_sha: intent,
        })
      } catch (error) {
        // the same request racing itself: the first one holds the key
        const raced = key !== null ? repo.interactionForClientRequest(state.conn, session.id, key) : null
        if (raced !== null) { state.interactions.checkIntent(raced, key!, intent); return state.interactions.detail(raced) }
        throw error
      }
    })
    return c.json(detail)
  })

  app.get('/api/sessions/:session_id/interactions', (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    return c.json({ session_id: session.id, interactions: state.interactions.listDetails(session.id) })
  })

  app.get('/api/interactions/:interaction_id', (c) => c.json(state.interactions.detail(requireInteraction(c.req.param('interaction_id')))))

  /** The plan, or more of it: the director's tool (or a client with a graph of its own). */
  app.post('/api/interactions/:interaction_id/schedule', async (c) => {
    const interaction = requireInteraction(c.req.param('interaction_id'))
    const body = await parseBody(c, ScheduleBodySchema)
    return c.json(await liftAsync(() => state.interactions.schedule(interaction.id, body, 'director')))
  })

  /** Steps the person asks for (another round, a synthesis): the budget grows to fit them. */
  app.post('/api/interactions/:interaction_id/steps', async (c) => {
    const interaction = requireInteraction(c.req.param('interaction_id'))
    const body = await parseBody(c, ScheduleBodySchema)
    return c.json(await liftAsync(() => state.interactions.schedule(interaction.id, body, 'person')))
  })

  app.post('/api/interactions/:interaction_id/cancel', (c) => {
    const interaction = requireInteraction(c.req.param('interaction_id'))
    const cancelled = state.interactions.cancel(interaction.id)
    return c.json({ cancelled, interaction: state.interactions.detail(requireInteraction(interaction.id)) })
  })

  app.post('/api/interactions/:interaction_id/continue', async (c) => {
    const interaction = requireInteraction(c.req.param('interaction_id'))
    await parseBody(c, InteractionContinueBodySchema)
    return c.json(await liftAsync(() => state.interactions.continue(interaction.id)))
  })

  app.post('/api/interactions/:interaction_id/pause', (c) => {
    const interaction = requireInteraction(c.req.param('interaction_id'))
    return c.json(lift(() => state.interactions.pause(interaction.id)))
  })

  /** The person's words to everyone or one participant while the interaction runs: queued, handed at the next run —
   *  or, to a member none of whose steps is still to come, its follow-up now. */
  app.post('/api/interactions/:interaction_id/notes', async (c) => {
    const interaction = requireInteraction(c.req.param('interaction_id'))
    const body = await parseBody(c, InteractionNoteBodySchema)
    return c.json(await liftAsync(() => state.interactions.note(interaction.id, body.to, body.text)))
  })

  /** A node's final state composed into the session's working folder (the integration's own honesty: composed,
   *  checked, and written only when the folder still stands at the base — each said apart). */
  app.post('/api/interactions/:interaction_id/adopt', async (c) => {
    const interaction = requireInteraction(c.req.param('interaction_id'))
    const body = await parseBody(c, AdoptBodySchema)
    return c.json(await liftAsync(() => state.interactions.adopt(interaction.id, body.node_id)))
  })

  return app
}
