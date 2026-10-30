/** The director endpoint over HTTP: the MCP server's Streamable HTTP transport under a secret path segment, on the
 *  loopback. A tunnel carries it to a client that cannot reach this machine (ChatGPT's developer mode, say). Two
 *  things keep that private: the token in the path (a request without it is a 404), and the Host check, which admits
 *  the loopback and only the tunnel hostnames the operator named — a request that arrives under any other name is a
 *  421 before the endpoint sees it. The transport is stateless (one request, one answer) so a relay in between needs
 *  no session affinity. */

import { Hono } from 'hono'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import type { DirectorToolSurface } from '@oasis-code/contract'
import { tokensMatch } from '../api/auth.ts'
import { buildProbeServer } from './probe_image.ts'

export const MCP_PATH = '/mcp'
/** The connector's surfaces by path: `/<token>/mcp` keeps director.v1 — a ChatGPT connector configured with it keeps
 *  the tools it was given, whenever ChatGPT reads the list again —, `/<token>/mcp/v2` serves director.v2, `/<token>/mcp/v3` director.v3, `/<token>/mcp/v4` director.v4, `/<token>/mcp/v5` director.v5, `/<token>/mcp/v6` director.v6, `/<token>/mcp/v7` director.v7, `/<token>/mcp/v8` director.v8, `/<token>/mcp/v9` director.v9, `/<token>/mcp/v10` director.v10, `/<token>/mcp/v11` director.v11. Which one a
 *  ChatGPT conversation uses is the URL its connector was configured with; the harness cannot see or change that. */
export const MCP_PATHS: Record<DirectorToolSurface, string> = { 'director.v1': MCP_PATH, 'director.v2': `${MCP_PATH}/v2`, 'director.v3': `${MCP_PATH}/v3`, 'director.v4': `${MCP_PATH}/v4`, 'director.v5': `${MCP_PATH}/v5`, 'director.v6': `${MCP_PATH}/v6`, 'director.v7': `${MCP_PATH}/v7`, 'director.v8': `${MCP_PATH}/v8`, 'director.v9': `${MCP_PATH}/v9`, 'director.v10': `${MCP_PATH}/v10`, 'director.v11': `${MCP_PATH}/v11` }
export const LOOPBACK_HOSTS = ['127.0.0.1:*', 'localhost:*', '[::1]:*'] as const
export const LOOPBACK_ORIGINS = ['http://127.0.0.1:*', 'http://localhost:*', 'http://[::1]:*'] as const

export interface TransportSecurity { enable_dns_rebinding_protection: boolean; allowed_hosts: string[]; allowed_origins: string[] }

/** The loopback, plus the hostnames the operator named (a tunnel's, as the client presents it — with its port when
 *  the client sends one). A name matches exactly, or `name:*` for any port. */
export function transportSecurity(allowedHosts: readonly string[] = []): TransportSecurity {
  const named = allowedHosts.map((h) => (h ?? '').trim()).filter(Boolean)
  return { enable_dns_rebinding_protection: true, allowed_hosts: [...LOOPBACK_HOSTS, ...named], allowed_origins: [...LOOPBACK_ORIGINS, ...named.map((h) => `https://${h}`)] }
}

/** `pattern` is a host (`name` or `name:port`) or `name:*` (any port, or none). */
export function hostMatches(value: string, patterns: readonly string[]): boolean {
  const bare = value.replace(/:\d+$/, '')
  for (const pattern of patterns) {
    if (pattern === value) return true
    if (pattern.endsWith(':*') && pattern.slice(0, -2) === bare) return true
  }
  return false
}

function originMatches(origin: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === origin) return true
    if (pattern.endsWith(':*') && (origin === pattern.slice(0, -2) || origin.startsWith(pattern.slice(0, -1)))) return true
  }
  return false
}

/** `log` hears every request the endpoint turns away and why (never the token): a client that cannot connect —
 *  an unsupported MCP-Protocol-Version, a host or an origin — shows up in the director's log instead of only in the
 *  client's error. */
/** Who a request comes from, by its user agent: the name the person knows the client by (ChatGPT's connector says
 *  `openai-mcp/…`), else a generic one. */
export function clientName(userAgent: string | undefined): string {
  if (/openai/i.test(userAgent ?? '')) return 'ChatGPT'
  if (/claude|anthropic/i.test(userAgent ?? '')) return 'Claude'
  return 'MCP client'
}

/** Options of an HTTP app beyond the director's own: `aliases` serves a surface under one more name
 *  (`/<token>/mcp/<alias>`), each explicitly mapped — the gateway's `current` is the newest surface the contract lists;
 *  any other alias names its own. The checks (token, Host, Origin) are the same on every path. */
export interface HttpAppOptions { aliases?: Readonly<Record<string, DirectorToolSurface>> }

/** The image probe's path (probe_image.ts): no surface, the same checks. */
export const PROBE_IMAGE_PATH = `${MCP_PATH}/probe-image`

const ALIAS = /^[a-z][a-z0-9-]{0,31}$/

/** `factory(client, surface)` builds the MCP server of one request: the surface is the path's (`/mcp` v1, `/mcp/v2`
 *  v2); a factory that takes one argument serves its own server on both paths, as it always did. `token` is the path
 *  segment, or a function read on every request (the gateway's secret, which a revoke replaces while it runs): a
 *  function that gives no usable token answers every MCP path with 404. */
export function buildHttpApp(factory: (client: string | null, surface: DirectorToolSurface) => McpServer, token: string | (() => string | null), allowedHosts: readonly string[] = [], log: (line: string) => void = () => {}, opts: HttpAppOptions = {}): Hono {
  if (typeof token === 'string' && (!token || token.includes('/'))) throw new Error('the director token must be a non-empty path segment')
  if (typeof token !== 'string' && typeof token !== 'function') throw new Error('the director token must be a non-empty path segment')
  const expected = (): string | null => {
    if (typeof token === 'string') return token
    let t: string | null = null
    try { t = token() } catch { t = null }
    return t && !t.includes('/') ? t : null
  }
  const paths: [DirectorToolSurface, string][] = Object.entries(MCP_PATHS) as [DirectorToolSurface, string][]
  for (const [alias, surface] of Object.entries(opts.aliases ?? {})) {
    if (!ALIAS.test(alias) || paths.some(([, p]) => p === `${MCP_PATH}/${alias}`)) throw new Error(`alias ${alias} is not a free path name`)
    if (!(surface in MCP_PATHS)) throw new Error(`alias ${alias} names an unknown surface ${String(surface)}`)
    paths.push([surface, `${MCP_PATH}/${alias}`])
  }
  const security = transportSecurity(allowedHosts)
  const name = (factory(null, 'director.v1') as unknown as { server: { getVersion?: () => { name: string } } }).server.getVersion?.().name ?? 'oasis-code director'
  const app = new Hono()
  app.get('/healthz', (c) => c.json({ ok: true, server: name }))
  const bySurface = new Map(paths.map(([surface, path]) => [path, surface]))
  for (const path of [...bySurface.keys(), PROBE_IMAGE_PATH]) app.all(`/:token${path}`, async (c) => {
    const want = expected()
    if (!want || !tokensMatch(c.req.param('token'), want)) return c.json({ detail: 'Not Found' }, 404)
    const host = c.req.header('host') ?? new URL(c.req.url).host
    if (!hostMatches(host, security.allowed_hosts)) {
      log(`[director] refused: Invalid Host header: ${host}`)
      return c.json({ jsonrpc: '2.0', error: { code: -32000, message: `Invalid Host header: ${host}` }, id: null }, 421)
    }
    const origin = c.req.header('origin')
    if (origin !== undefined && !originMatches(origin, security.allowed_origins)) {
      log(`[director] refused: Invalid Origin header: ${origin}`)
      return c.json({ jsonrpc: '2.0', error: { code: -32000, message: `Invalid Origin header: ${origin}` }, id: null }, 403)
    }
    // stateless: one server and one transport per request, closed once the answer is out
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    transport.onerror = (error) => log(`[director] refused: ${error.message} (${c.req.method}, client ${c.req.header('user-agent') ?? 'unnamed'})`)
    const surface = bySurface.get(path)
    const server = surface === undefined ? buildProbeServer(log) : factory(clientName(c.req.header('user-agent')), surface)
    await server.connect(transport)
    try {
      return await transport.handleRequest(withKnownProtocolVersion(c.req.raw))
    } finally {
      void transport.close().catch(() => {})
      void server.close().catch(() => {})
    }
  })
  return app
}

/** Published MCP versions newer than the SDK knows whose clients are answered anyway: 2026-07-28, the stateless one —
 *  its client (ChatGPT's) sends tools/list and tools/call without an initialize and, on a new conversation, does not
 *  fall back when refused. Any other unknown version is refused (400), as the specification asks. */
export const ANSWERED_NEWER_PROTOCOL_VERSIONS: readonly string[] = ['2026-07-28']

/** A request whose MCP-Protocol-Version header names one of those versions is handed on without that header: the SDK
 *  takes such a request as it takes one without a header (the version negotiated at initialize, by default) and
 *  answers it as it answers every other — an answer the newer client reads or does not, never a 400 for the header
 *  alone. A known version, any other unknown one and a request without one pass unchanged. */
export function withKnownProtocolVersion(req: Request): Request {
  const version = req.headers.get('mcp-protocol-version')
  if (version === null || SUPPORTED_PROTOCOL_VERSIONS.includes(version) || !ANSWERED_NEWER_PROTOCOL_VERSIONS.includes(version)) return req
  const headers = new Headers(req.headers)
  headers.delete('mcp-protocol-version')
  return new Request(req, { headers })
}

export function mcpUrl(host: string, port: number, token: string, surface: DirectorToolSurface = 'director.v1'): string {
  return `http://${host}:${port}/${token}${MCP_PATHS[surface]}`
}
