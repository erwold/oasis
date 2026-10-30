/** The gateway's HTTP app: the director's own (buildHttpApp, buildServer, the committed tool surfaces) under the
 *  external secret instead of the director token, the public hostname the only one besides the loopback, and
 *  `/<secret>/mcp/current` (the newest surface) beside the frozen `/mcp` (v1) and `/mcp/v2`…`/mcp/v6`.
 *
 *  Nothing here needs the backend to answer: `initialize` and `tools/list` come from the committed snapshots. Each
 *  request builds its own Harness from the session token as the data directory holds it now, so a backend that
 *  restarted (or minted a new token) is reached again without restarting the gateway; a tool call while the backend
 *  is away is a tool error that says so. `/healthz` names this gateway's instance and nothing else (no URL, no
 *  token): the app on this Mac, and the gateway itself through the public name, tell this gateway from another. */

import type { Hono } from 'hono'
import type { DirectorToolSurface } from '@oasis-code/contract'
import { buildHttpApp } from '../director/app.ts'
import { Harness, type FetchLike } from '../director/harness.ts'
import { buildServer } from '../director/server.ts'
import { ContentEncodingRefused, safeFetch } from '../safe_fetch.ts'
import { GATEWAY_ALIASES, readSecret, readSessionToken } from './config.ts'

export const GATEWAY_SERVER = 'oasis-code gateway'
export const BACKEND_UNAVAILABLE = 'oasis-code backend unavailable: the oasis-code app on this Mac is not running (or its backend is restarting); open it and try again'

export interface GatewayAppOptions {
  dataDir: string
  /** the backend on this Mac: always the loopback (the gateway forwards nowhere else) */
  harnessPort: number
  /** the public hostname (null: loopback only), read on every request (a quick test tunnel learns it late) */
  host: () => string | null
  instance: string
  log?: (line: string) => void
  env?: Record<string, string | undefined>
  fetchImpl?: FetchLike
}

/** A fetch whose failure to connect says the backend is not there (the Harness carries it to the tool call). */
export function backendFetch(fetchImpl: FetchLike = (input, init) => safeFetch(input, init)): FetchLike {
  return async (input, init) => {
    try {
      return await fetchImpl(input, init)
    } catch (error) {
      const name = (error as Error).name
      if (name === 'TimeoutError' || name === 'AbortError' || error instanceof ContentEncodingRefused) throw error
      throw new Error(BACKEND_UNAVAILABLE)
    }
  }
}

const noBackend: FetchLike = async () => { throw new Error(BACKEND_UNAVAILABLE) }

export function buildGatewayApp(opts: GatewayAppOptions): { fetch: (request: Request) => Response | Promise<Response> } {
  const log = opts.log ?? (() => {})
  const base = `http://127.0.0.1:${opts.harnessPort}`
  const fetchImpl = backendFetch(opts.fetchImpl)
  const factory = (client: string | null, surface: DirectorToolSurface) => {
    const token = readSessionToken(opts.dataDir, opts.env)
    const harness = token ? Harness.connect(base, token, { fetchImpl }) : Harness.connect(base, 'none', { fetchImpl: noBackend })
    return buildServer(client ? harness.as(client) : harness, { surface, log })
  }
  // the app is rebuilt when the public name changes (only a quick test tunnel's does, once)
  let builtFor: string | null | undefined
  let app: Hono | null = null
  const current = (): Hono => {
    const host = opts.host()
    if (app === null || builtFor !== host) {
      app = buildHttpApp(factory, () => readSecret(opts.dataDir), host ? [host] : [], log, { aliases: GATEWAY_ALIASES })
      builtFor = host
    }
    return app
  }
  return {
    fetch(request: Request) {
      const url = new URL(request.url)
      if (url.pathname === '/healthz' && (request.method === 'GET' || request.method === 'HEAD')) {
        return Response.json({ ok: true, server: GATEWAY_SERVER, instance: opts.instance })
      }
      return current().fetch(request)
    },
  }
}
