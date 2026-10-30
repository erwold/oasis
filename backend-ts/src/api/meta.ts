import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { surface } from '../agent/tools/registry.ts'
import { SCHEMA_VERSION } from '../db/database.ts'
import { refreshCatalog } from '../auth/antigravity_catalog.ts'
import { catalogEntries } from '../llm/catalog.ts'
import { backendIdentity, FRONTEND_DIST } from '../version.ts'
import { ATTACH_CHALLENGE, attachProof, sessionLogin } from './auth.ts'
import type { Api } from './common.ts'

/** The build id of the UI the backend serves (frontend/dist/build.json, written by the vite build); null without one. */
export function servedUiBuild(): string | null {
  const path = join(FRONTEND_DIST, 'build.json')
  try {
    if (!existsSync(path)) return null
    const value = (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>).ui_build
    return typeof value === 'string' ? value : null
  } catch { return null }
}

export function metaRoutes(api: Api): Hono {
  const app = new Hono()
  const { state } = api

  // public, so a client can ask before it holds a session; with `?challenge=` it also answers whether this harness
  // holds the client's session token (attachProof), without the token crossing the wire
  app.get('/api/meta/build', (c) => {
    const challenge = c.req.query('challenge')
    return c.json({
      ...backendIdentity(), schema_version: SCHEMA_VERSION, ui_build: servedUiBuild(),
      isolation: { runtime: state.isolation.runtime, enforcement: state.isolation.enforcement },
      host: state.settings.host, port: state.settings.port,
      ...(challenge !== undefined && ATTACH_CHALLENGE.test(challenge) ? { attach_proof: attachProof(state.session_token, state.settings.port, challenge) } : {}),
    })
  })

  app.get('/api/auth/session', (c) => sessionLogin(c, c.req.query('token') ?? '', state.session_token))

  app.get('/api/models', async (c) => {
    // Catalog failure never breaks other providers; no stale entitlement is published.
    await refreshCatalog().catch(() => {})
    return c.json({ models: catalogEntries(state.config), default: state.config.default_model })
  })

  app.get('/api/meta/isolation', (c) => c.json(state.isolation))

  app.get('/api/agent/surface', (c) => c.json({
    tools: surface(),
  }))

  return app
}
