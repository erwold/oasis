import { Hono } from 'hono'
import { z } from '@oasis-code/contract'
import { HttpError, parseBody, type Api } from './common.ts'
import { isLocal } from './accounts.ts'
import { SEARCH_ENGINES, readSearchSettings, saveSearchSettings } from '../search/settings.ts'

export function searchRoutes({ state }: Api): Hono {
  const app = new Hono()
  app.use('/api/settings/web-search', async (c, next) => { await next(); c.header('Cache-Control', 'no-store') })
  app.get('/api/settings/web-search', (c) => c.json(readSearchSettings(state.store)))
  app.put('/api/settings/web-search', async (c) => {
    if (!isLocal(c)) throw new HttpError(403, 'change settings from the machine that runs the backend')
    const body = await parseBody(c, z.object({ engine: z.enum(SEARCH_ENGINES) }).strict())
    return c.json(saveSearchSettings(state.store, body))
  })
  return app
}
