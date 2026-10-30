/** The director's view of a running harness: its REST API over the loopback with the session token (the one the
 *  page and the desktop shell use). Nothing here decides anything — an error is the API's answer, carried to the
 *  director word for word. */

import { AGENT_RUN_HEADER, CONNECTOR_HEADER, HEADER } from '../api/auth.ts'
import { safeFetch } from '../safe_fetch.ts'
import { API_VERSION } from '../version.ts'

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

/** The harness refused or could not be reached; `detail` is what it said. */
export class HarnessError extends Error {
  constructor(readonly status: number, readonly detail: string) { super(detail); this.name = 'HarnessError' }
}

// checks and integrations can take minutes; the connect timeout stays short so an absent harness fails fast
const REQUEST_TIMEOUT_MS = 900_000

/** The headers a director tool call's requests carry, so the API records who started what (a run's origin): the
 *  director session and turn whose tool call it is, the call's id, and the tool surface the call came through. The
 *  API checks them against its own records before it believes them (a director session must exist and hold that turn);
 *  a request without them is the connector's or the person's, as before. */
export const DIRECTOR_SESSION_HEADER = 'x-oasis-director-session-id'
export const DIRECTOR_TURN_HEADER = 'x-oasis-director-turn-id'
export const DIRECTOR_TOOL_CALL_HEADER = 'x-oasis-director-tool-call-id'
export const TOOL_SURFACE_HEADER = 'x-oasis-tool-surface'
export const DIRECTOR_CONTEXT_HEADERS = [DIRECTOR_SESSION_HEADER, DIRECTOR_TURN_HEADER, DIRECTOR_TOOL_CALL_HEADER, TOOL_SURFACE_HEADER] as const

/** What one director tool call is, as its requests say it (every field optional: a connector call knows its surface only). */
export interface DirectorCallContext {
  director_session_id?: string | null
  turn_id?: string | null
  tool_call_id?: string | null
  surface?: string | null
  /** a run's own tool calling in process (open_ssh_session): the run, so the API holds what it starts to that run's
   *  bounds and records it as the agent's (policy/delegation.ts) */
  agent_run_id?: string | null
}

export function contextHeaders(context: DirectorCallContext | null): Record<string, string> {
  if (!context) return {}
  const out: Record<string, string> = {}
  if (context.director_session_id) out[DIRECTOR_SESSION_HEADER] = context.director_session_id
  if (context.turn_id) out[DIRECTOR_TURN_HEADER] = context.turn_id
  // a provider's call id may be anything: what goes in a header is kept to its printable ASCII
  if (context.tool_call_id !== null && context.tool_call_id !== undefined) out[DIRECTOR_TOOL_CALL_HEADER] = context.tool_call_id.replace(/[^\x21-\x7e]/g, '').slice(0, 200)
  if (context.surface) out[TOOL_SURFACE_HEADER] = context.surface
  if (context.agent_run_id) out[AGENT_RUN_HEADER] = context.agent_run_id
  return out
}

export class Harness {
  constructor(readonly base_url: string, private readonly token: string, private readonly fetchImpl: FetchLike = (input, init) => safeFetch(input, init),
              private readonly client: string | null = null, readonly context: DirectorCallContext | null = null) {}

  /** The same harness, its requests saying which MCP client they come through (the runs they start say so). */
  as(client: string | null): Harness {
    return new Harness(this.base_url, this.token, this.fetchImpl, client, this.context)
  }

  /** The same harness for one tool call: a copy whose requests carry the call's context headers. The original is
   *  never changed, so calls under way side by side each keep their own. */
  with(context: DirectorCallContext): Harness {
    return new Harness(this.base_url, this.token, this.fetchImpl, this.client, { ...(this.context ?? {}), ...context })
  }

  static connect(baseUrl: string, token: string, opts: { fetchImpl?: FetchLike } = {}): Harness {
    return new Harness(baseUrl.replace(/\/+$/, ''), token, opts.fetchImpl)
  }

  async close(): Promise<void> { /* nothing is held open */ }

  get(endpoint: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.send('GET', endpoint, { params: Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null && v !== undefined)) })
  }

  post(endpoint: string, body: Record<string, unknown> | null = null): Promise<unknown> {
    return this.send('POST', endpoint, { json: body ?? {} })
  }

  put(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
    return this.send('PUT', endpoint, { json: body })
  }

  /** A file's bytes as the request body (an image for a session). */
  upload(endpoint: string, bytes: Uint8Array, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.send('POST', endpoint, { bytes, params })
  }

  /** The build handshake (public) and one authenticated call: a harness of this API answers, and the token is the
   *  one it minted. Throws HarnessError with the reason otherwise. */
  async probe(): Promise<Record<string, unknown>> {
    const build = (await this.get('/api/meta/build')) as Record<string, unknown>
    if (build.api_version !== API_VERSION) throw new HarnessError(0, `${this.base_url} serves API ${JSON.stringify(build.api_version)}, this director speaks ${API_VERSION}`)
    await this.get('/api/models')
    return build
  }

  private async send(method: string, endpoint: string, opts: { params?: Record<string, unknown>; json?: unknown; bytes?: Uint8Array }): Promise<unknown> {
    const url = new URL(this.base_url + endpoint)
    for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, String(v))
    const headers: Record<string, string> = { [HEADER]: this.token, accept: 'application/json', origin: url.origin, ...(this.client ? { [CONNECTOR_HEADER]: this.client } : {}), ...contextHeaders(this.context) }
    let init: RequestInit = { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
    if (opts.json !== undefined) init = { ...init, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(opts.json) }
    if (opts.bytes !== undefined) init = { ...init, headers: { ...headers, 'content-type': 'application/octet-stream' }, body: opts.bytes }
    let response: Response
    try {
      response = await this.fetchImpl(url.toString(), init)
    } catch (error) {
      const name = (error as Error).name
      if (name === 'TimeoutError' || name === 'AbortError') throw new HarnessError(0, `the harness at ${this.base_url} did not answer ${method} ${endpoint} in time (${name})`)
      throw new HarnessError(0, `the harness is not reachable at ${this.base_url} (${(error as Error).message}); start it with \`cd backend-ts && bun run start\``)
    }
    if (response.status >= 400) {
      let detail = await detailOf(response)
      if (response.status === 401) {
        detail = 'the harness rejected the session token: read <data dir>/session-token of the running harness or set OASIS_CODE_SESSION_TOKEN to the one it prints at startup'
      }
      throw new HarnessError(response.status, detail)
    }
    const text = await response.text()
    if (!text) return null
    try { return JSON.parse(text) } catch { return text }
  }
}

async function detailOf(response: Response): Promise<string> {
  const text = await response.text()
  let body: unknown
  try { body = JSON.parse(text) } catch { return text.slice(0, 500) || `HTTP ${response.status}` }
  if (body && typeof body === 'object' && !Array.isArray(body) && (body as Record<string, unknown>).detail !== null && (body as Record<string, unknown>).detail !== undefined) {
    const detail = (body as Record<string, unknown>).detail
    return typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 500)
  }
  return JSON.stringify(body).slice(0, 500)
}
