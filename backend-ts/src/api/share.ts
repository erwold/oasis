/** The offline session share (contract/src/share.ts): the strict snapshot of a quiescent session the page turns into
 *  one self-contained HTML file. The person's page only: an agent run's request is refused. */

import { Hono } from 'hono'
import { SHARE_ACTIVE_CODE, SHARE_TOO_LARGE_CODE, ShareSnapshotRequestSchema, ShareSnapshotResponseSchema, ShareSnapshotV3RequestSchema, ShareSnapshotV3ResponseSchema } from '@oasis-code/contract'
import { currentRequestAgent } from '../policy/access.ts'
import { buildShareSnapshot, ShareActive } from '../share/snapshot.ts'
import { buildShareSnapshotV3, ShareTooLarge } from '../share/task.ts'
import { HttpError, parseBody, type Api } from './common.ts'
import { requireSession } from './state.ts'

export function shareRoutes(api: Api): Hono {
  const app = new Hono()
  const { state } = api

  app.post('/api/sessions/:session_id/share-snapshot', async (c) => {
    if (currentRequestAgent() !== null) throw new HttpError(403, 'an agent run may not export a session; that is the person\'s, in oasis-code', 'agent_route')
    const sessionId = c.req.param('session_id')
    requireSession(state, sessionId)
    const body = await parseBody(c, ShareSnapshotRequestSchema)
    // the snapshot reads the session again inside its one transaction (no stale row across the await)
    let answer
    try { answer = buildShareSnapshot(state, sessionId, body) } catch (error) {
      if (error instanceof ShareActive) throw new HttpError(409, error.message, SHARE_ACTIVE_CODE, { reasons: error.reasons })
      throw error
    }
    // the answer is checked against its strict schema before it leaves: a field the contract does not name never does
    const checked = ShareSnapshotResponseSchema.parse(answer)
    return c.json(checked, 200, { 'cache-control': 'no-store' })
  })

  /** V3 (contract/src/share.ts): the Agent Teams card, the turns' faces, and — `include_task_sessions` — every session
   *  of this session's task that is not deleted. The route above keeps answering V2 as it always did. */
  app.post('/api/sessions/:session_id/share-snapshot/v3', async (c) => {
    if (currentRequestAgent() !== null) throw new HttpError(403, 'an agent run may not export a session; that is the person\'s, in oasis-code', 'agent_route')
    const sessionId = c.req.param('session_id')
    requireSession(state, sessionId)
    const body = await parseBody(c, ShareSnapshotV3RequestSchema)
    let answer
    try { answer = buildShareSnapshotV3(state, sessionId, body) } catch (error) {
      if (error instanceof ShareActive) throw new HttpError(409, error.message, SHARE_ACTIVE_CODE, { reasons: error.reasons })
      if (error instanceof ShareTooLarge) throw new HttpError(413, error.message, SHARE_TOO_LARGE_CODE)
      throw error
    }
    const checked = ShareSnapshotV3ResponseSchema.parse(answer)
    return c.json(checked, 200, { 'cache-control': 'no-store' })
  })

  return app
}
