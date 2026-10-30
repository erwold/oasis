/** The person's live-share management (contract/src/live_share.ts): the listener's settings and a session's links.
 *  Owner-only, GET included (an agent may GET anything else): a request from an agent run, a connector, a director's
 *  tool surface or session / turn, or the agent's browser is refused, and so is any peer that is not this machine. The
 *  capability leaves only in a POST's answer (create, reveal), never in a list. Nothing here is the share listener's:
 *  that one serves only its five paths (share/live/service.ts). */

import { Hono, type Context } from 'hono'
import { LiveShareSettingsResponseSchema, LiveShareSettingsSchema, ShareLinkCreateRequestSchema, ShareLinkCreateV2RequestSchema, ShareLinkListResponseSchema,
  ShareLinkRevokeResponseSchema, ShareLinkSecretResponseSchema, ShareLinkV2ListResponseSchema, ShareLinkV2RevokeResponseSchema, ShareLinkV2SecretResponseSchema } from '@oasis-code/contract'
import { currentRequestAgent } from '../policy/access.ts'
import { AGENT_BROWSER_HEADER, AGENT_RUN_HEADER, CONNECTOR_HEADER } from './auth.ts'
import { isLocal } from './accounts.ts'
import { DIRECTOR_SESSION_HEADER, DIRECTOR_TURN_HEADER, HttpError, TOOL_SURFACE_HEADER, parseBody, type Api } from './common.ts'
import { requireSession } from './state.ts'

/** The caller headers that say a request is not the person's own page. */
export const NOT_THE_PERSON = [CONNECTOR_HEADER, TOOL_SURFACE_HEADER, DIRECTOR_SESSION_HEADER, DIRECTOR_TURN_HEADER, AGENT_RUN_HEADER, AGENT_BROWSER_HEADER]

/** The person's own request on this machine, or a 403. `local`: also refuse a peer that is not the loopback. */
export function requirePerson(c: Context, what: string, local: boolean): void {
  if (currentRequestAgent() !== null || NOT_THE_PERSON.some((h) => (c.req.header(h) ?? '').trim() !== '')) {
    throw new HttpError(403, `${what} is the person's own, in oasis-code: an agent, a director or a connector may not do it`, 'share_owner_only')
  }
  if (local && !isLocal(c)) throw new HttpError(403, `${what} is done from the machine that runs oasis-code`, 'share_owner_only')
}

export function liveShareRoutes(api: Api): Hono {
  const app = new Hono()
  const { state } = api
  const live = () => {
    if (!state.live_share) throw new HttpError(503, 'live sharing is not available in this app')
    return state.live_share
  }
  app.use('/api/settings/live-share', async (c, next) => { await next(); c.header('Cache-Control', 'no-store') })
  app.use('/api/share-links/*', async (c, next) => { await next(); c.header('Cache-Control', 'no-store') })
  app.use('/api/sessions/:session_id/share-links', async (c, next) => { await next(); c.header('Cache-Control', 'no-store') })
  app.use('/api/sessions/:session_id/share-links/v2', async (c, next) => { await next(); c.header('Cache-Control', 'no-store') })

  app.get('/api/settings/live-share', (c) => {
    requirePerson(c, 'live sharing', true)
    const s = live()
    return c.json(LiveShareSettingsResponseSchema.parse({ settings: s.getSettings(), status: s.status() }))
  })

  app.put('/api/settings/live-share', async (c) => {
    requirePerson(c, 'live sharing', true)
    const body = await parseBody(c, LiveShareSettingsSchema)
    return c.json(LiveShareSettingsResponseSchema.parse(await live().applySettings(body)))
  })

  app.post('/api/sessions/:session_id/share-links', async (c) => {
    requirePerson(c, 'a live link', true)
    const sessionId = c.req.param('session_id')
    requireSession(state, sessionId)
    const body = await parseBody(c, ShareLinkCreateRequestSchema)
    return c.json(ShareLinkSecretResponseSchema.parse(live().createLink(sessionId, body)), 201)
  })

  app.get('/api/sessions/:session_id/share-links', (c) => {
    requirePerson(c, 'a live link', true)
    return c.json(ShareLinkListResponseSchema.parse({ links: live().listLinks(c.req.param('session_id')) }))
  })

  app.post('/api/share-links/:id/reveal', (c) => {
    requirePerson(c, 'a live link', true)
    return c.json(ShareLinkSecretResponseSchema.parse(live().reveal(c.req.param('id'))))
  })

  app.post('/api/share-links/:id/revoke', (c) => {
    requirePerson(c, 'a live link', true)
    return c.json(ShareLinkRevokeResponseSchema.parse({ link: live().revoke(c.req.param('id')) }))
  })

  // ---- protocol 2 (live state v2: the Agent Teams card, the faces, a task's sessions) ------------------------------------
  // the same owner-only rule as v1, GET included

  app.post('/api/sessions/:session_id/share-links/v2', async (c) => {
    requirePerson(c, 'a live link', true)
    const sessionId = c.req.param('session_id')
    requireSession(state, sessionId)
    const body = await parseBody(c, ShareLinkCreateV2RequestSchema)
    return c.json(ShareLinkV2SecretResponseSchema.parse(live().createLinkV2(sessionId, body)), 201)
  })

  app.get('/api/sessions/:session_id/share-links/v2', (c) => {
    requirePerson(c, 'a live link', true)
    return c.json(ShareLinkV2ListResponseSchema.parse({ links: live().listLinksV2(c.req.param('session_id')) }))
  })

  app.post('/api/share-links/:id/v2/reveal', (c) => {
    requirePerson(c, 'a live link', true)
    return c.json(ShareLinkV2SecretResponseSchema.parse(live().revealV2(c.req.param('id'))))
  })

  app.post('/api/share-links/:id/v2/revoke', (c) => {
    requirePerson(c, 'a live link', true)
    return c.json(ShareLinkV2RevokeResponseSchema.parse({ link: live().revokeV2(c.req.param('id')) }))
  })

  return app
}
