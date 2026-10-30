/** Local HTTP protection: a session token (`<data dir>/session-token`, minted at first start, or
 *  OASIS_CODE_SESSION_TOKEN) carried as an HttpOnly SameSite=Strict cookie after one visit to
 *  /api/auth/session?token=…, or in the `x-oasis-code-token` header for programmatic use; state-changing requests
 *  must be same-origin. A client that holds the token can check that a listener holds it too before handing it over
 *  (attachProof). A client cannot submit history, tool results or approvals as a run — those are the runner's; the
 *  API only starts, stops, continues and decides.
 *
 *  The agent's own browser (computer use) is a browser on this machine too: once the person opened the app's link
 *  there, it would carry the same cookie, and the agent could approve its own proposals or widen its own grants. The
 *  desktop app marks every request that browser sends to this machine's own addresses (AGENT_BROWSER_HEADER, set below
 *  the page, where no page script can remove it), and no request so marked reaches the API — not even the sign-in. */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'

export const COOKIE = 'oasis_code_session'
export const HEADER = 'x-oasis-code-token'
/** The MCP client a request comes through, as the connector names it (`ChatGPT`): the runs it starts say so. */
export const CONNECTOR_HEADER = 'x-oasis-code-connector'
/** The agent run a request comes from: a run's own tool calling the app's API in process (open_ssh_session). Checked
 *  against the live runs and held to that run's bounds (policy/delegation.ts); it only ever narrows. */
export const AGENT_RUN_HEADER = 'x-oasis-agent-run-id'
export const COOKIE_MAX_AGE_S = 30 * 24 * 3600
/** The mark the desktop app puts on what the agent's browser sends to the loopback (desktop/shell.js agentBrowserHeaders). */
export const AGENT_BROWSER_HEADER = 'x-oasis-code-agent-browser'
export const PUBLIC_PREFIXES = ['/api/auth/session', '/api/meta/build']

/** The explicit token, else the one in `<data dir>/<filename>`, else a fresh one written there (0600). */
export function loadOrMintToken(explicit: string | null | undefined, dataDir: string, filename = 'session-token'): string {
  if (explicit) return explicit
  const path = join(dataDir, filename)
  try {
    if (existsSync(path)) {
      const token = readFileSync(path, 'utf8').trim()
      if (token) return token
    }
  } catch { /* unreadable: mint a new one */ }
  const token = randomBytes(24).toString('base64url')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(path, token)
  chmodSync(path, 0o600)
  return token
}

/** A token as a startup line prints it: whole when the line goes to a terminal the person reads (`bun run start` in a
 *  shell, where the link is what they came for), `<token>` anywhere else — a pipe the desktop app copies into its
 *  log, a redirected file — where it would sit at rest as a full-access credential. Masked, the line says where the
 *  token is kept (`where`), so the link can still be made. */
export function printedToken(token: string, where: { explicit: boolean; env: string; dataDir: string; filename: string }, tty: boolean): { token: string; note: string | null } {
  if (tty) return { token, note: null }
  return { token: '<token>', note: where.explicit ? `the token is the one set in ${where.env}` : `the token is in ${join(where.dataDir, where.filename)}` }
}

/** What a client may send to /api/meta/build as `challenge`: a fresh random value, base64url, 16 to 128 characters. */
export const ATTACH_CHALLENGE = /^[A-Za-z0-9_-]{16,128}$/

/** The answer to an attach challenge: an HMAC of the challenge and the port the harness listens on, keyed by its
 *  session token. A client that holds the token of its data directory (the desktop app) computes the same value and
 *  sends the token only when they agree, so a listener of another data directory, or one that is not oasis-code at
 *  all, is never handed it; the port in the message keeps a listener on the client's port from relaying the
 *  challenge to the real harness on another. The token itself never leaves; the answer is useless without it. */
export function attachProof(token: string, port: number | string, challenge: string): string {
  return createHmac('sha256', token).update(`oasis-code attach v1\n${port}\n${challenge}`).digest('base64url')
}

export function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

export function requestHost(c: Context): string {
  return c.req.header('host') ?? new URL(c.req.url).host
}

export function sessionAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    // the path the router matches (percent-decoded), not the raw one: `/%61pi/runs` is routed as `/api/runs`
    const path = c.req.path
    if (!path.startsWith('/api/')) return next()
    if (c.req.header(AGENT_BROWSER_HEADER) !== undefined) {
      return c.json({ detail: "refused: this request comes from the agent's browser; oasis-code is used, and its approvals and permissions decided, in the app window or your own browser" }, 403)
    }
    if (PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return next()
    const presented = getCookie(c, COOKIE) || c.req.header(HEADER) || ''
    if (!presented || !tokensMatch(presented, token)) {
      return c.json({ detail: 'not authenticated: open the URL with ?token=… printed at startup' }, 401)
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin')
      const fetchSite = c.req.header('sec-fetch-site')
      const host = requestHost(c)
      if (origin !== undefined) {
        if (origin !== `http://${host}` && origin !== `https://${host}`) {
          return c.json({ detail: `cross-origin request refused (origin ${origin})` }, 403)
        }
      } else if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
        return c.json({ detail: 'cross-site request refused' }, 403)
      }
    }
    return next()
  }
}

export function sessionLogin(c: Context, token: string, expected: string): Response {
  if (!tokensMatch(token || '', expected)) return c.json({ detail: 'bad token' }, 401)
  // the cookie outlives the browser session: the token file is stable across restarts, so the person opens
  // 127.0.0.1:<port> plainly for a month before the link with ?token= is needed again
  setCookie(c, COOKIE, expected, { httpOnly: true, sameSite: 'Strict', secure: false, path: '/', maxAge: COOKIE_MAX_AGE_S })
  return c.redirect('/', 303)
}
