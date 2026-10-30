/** Sign-in and keys from the page (carried from oasis api/auth.py). Anything that starts, completes or removes a
 *  grant, or saves a key, answers only requests from the machine the backend runs on; reading the state is fine from
 *  anywhere the session token reaches. */

import { isIP } from 'node:net'
import { Hono, type Context } from 'hono'
import { getConnInfo } from 'hono/bun'
import { PastedKeySchema, PastedRedirectSchema } from '@oasis-code/contract'
import * as keys from '../auth/keys.ts'
import { NativeAuthError } from '../auth/store.ts'
import { HttpError, boolQuery, parseBody, type Api } from './common.ts'

function isLoopback(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0]!
  const kind = isIP(bare)
  if (kind === 4) return bare.startsWith('127.')
  if (kind === 6) return bare === '::1' || /^::ffff:127\./i.test(bare)
  return false
}

/** Whether the request came from this machine: the server's view of the peer address (none when the app is driven
 *  in process, which counts as remote). */
export function isLocal(c: Context): boolean {
  try {
    const address = getConnInfo(c).remote.address
    return typeof address === 'string' && isLoopback(address)
  } catch { return false }
}

function requireLocal(c: Context): void {
  if (!isLocal(c)) throw new HttpError(403, 'sign in from the machine that runs the backend')
}

export function accountRoutes(api: Api): Hono {
  const app = new Hono()
  const { logins, usage } = api
  app.use('/api/auth/*', async (c, next) => { await next(); c.header('Cache-Control', 'no-store') })

  app.get('/api/auth/accounts', async (c) => {
    await logins.ensureIdentity()
    return c.json({ local: isLocal(c), providers: logins.accounts(), keys: keys.keyRows() })
  })

  app.get('/api/auth/usage', async (c) => c.json(await usage.snapshot({ refresh: boolQuery(c, 'refresh') })))

  app.put('/api/auth/keys/:provider', async (c) => {
    requireLocal(c)
    const body = await parseBody(c, PastedKeySchema)
    try {
      return c.json(await keys.saveKey(c.req.param('provider'), body.key, { label: body.label ?? null, env: body.env ?? null }))
    } catch (error) {
      if (error instanceof NativeAuthError) throw new HttpError(error.message.startsWith('unknown') ? 404 : 400, error.message)
      throw error
    }
  })

  app.delete('/api/auth/keys/:provider', async (c) => {
    requireLocal(c)
    const provider = c.req.param('provider')
    try {
      return c.json({ provider, removed: await keys.forgetKey(provider) })
    } catch (error) {
      if (error instanceof NativeAuthError) throw new HttpError(404, error.message)
      throw error
    }
  })

  app.post('/api/auth/login/:provider', async (c) => {
    requireLocal(c)
    try {
      return c.json((await logins.start(c.req.param('provider'))).public())
    } catch (error) {
      if (error instanceof NativeAuthError) throw new HttpError(404, error.message)
      throw error
    }
  })

  app.get('/api/auth/login/:login_id', (c) => {
    const session = logins.find(c.req.param('login_id'))
    if (session === null) throw new HttpError(404, 'no such sign-in')
    return c.json(session.public())
  })

  app.post('/api/auth/login/:login_id/code', async (c) => {
    requireLocal(c)
    const body = await parseBody(c, PastedRedirectSchema)
    const loginId = c.req.param('login_id')
    if (logins.find(loginId) === null) throw new HttpError(404, 'no such sign-in')
    try {
      return c.json((await logins.submit(loginId, body.input)).public())
    } catch (error) {
      if (error instanceof NativeAuthError) throw new HttpError(400, error.message)
      throw error
    }
  })

  app.delete('/api/auth/login/:login_id', async (c) => {
    requireLocal(c)
    const loginId = c.req.param('login_id')
    if (logins.find(loginId) === null) throw new HttpError(404, 'no such sign-in')
    return c.json((await logins.cancel(loginId)).public())
  })

  app.delete('/api/auth/accounts/:provider', async (c) => {
    requireLocal(c)
    const provider = c.req.param('provider')
    try {
      return c.json({ provider, removed: await logins.logout(provider) })
    } catch (error) {
      if (error instanceof NativeAuthError) throw new HttpError(404, error.message)
      throw error
    }
  })

  return app
}
