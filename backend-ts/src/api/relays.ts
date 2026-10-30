import { Hono } from 'hono'
import { RelayContinueBodySchema } from '@oasis-code/contract'
import { RelayInvalid } from '../agent/relay.ts'
import * as repo from '../db/repo.ts'
import { HttpError, parseBody, type Api } from './common.ts'
import { requireSession } from './state.ts'

/** The relay over the API: read it, stop the whole chain, continue it. Starting one is the chat route's (a message
 *  that names two or more agents). */
export function relayRoutes(api: Api): Hono {
  const app = new Hono()
  const { state } = api
  const requireRelay = (relayId: string) => {
    const relay = repo.getRelay(state.conn, relayId)
    if (relay === null) throw new HttpError(404, `relay not found: ${relayId}`)
    requireSession(state, relay.session_id)
    return relay
  }
  const withLive = (relay: ReturnType<typeof requireRelay>) => {
    const step = relay.steps[relay.current_step]
    const handle = step?.run_id ? state.runs.handles.get(step.run_id) : undefined
    return { ...relay, live: handle !== undefined && !handle.done }
  }

  app.get('/api/sessions/:session_id/relays', (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    return c.json({ session_id: session.id, relays: repo.listRelays(state.conn, session.id).map(withLive) })
  })

  app.get('/api/relays/:relay_id', (c) => c.json(withLive(requireRelay(c.req.param('relay_id')))))

  app.post('/api/relays/:relay_id/cancel', (c) => {
    const relay = requireRelay(c.req.param('relay_id'))
    const cancelled = state.relays.cancel(relay.id)
    return c.json({ cancelled, relay: withLive(requireRelay(relay.id)) })
  })

  app.post('/api/relays/:relay_id/continue', async (c) => {
    const relay = requireRelay(c.req.param('relay_id'))
    const body = await parseBody(c, RelayContinueBodySchema)
    try {
      return c.json(withLive(await state.relays.continue(relay.id, { rounds: body.rounds ?? null }) as ReturnType<typeof requireRelay>))
    } catch (error) {
      if (error instanceof RelayInvalid) throw new HttpError(error.status, error.message)
      throw new HttpError(/already has an active run/.test((error as Error).message) ? 409 : 400, (error as Error).message)
    }
  })

  return app
}
