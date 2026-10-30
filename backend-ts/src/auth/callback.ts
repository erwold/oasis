/** Bounded loopback OAuth callback, with exact state matching and no token output. */

import { timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { NativeAuthError } from './errors.ts'

const PAGE = '<!doctype html><meta charset="utf-8"><title>oasis-code login</title><h2>{title}</h2><p>{body}</p>'

export interface CallbackResult { code: string; state: string }

/** A promise settled from outside (the callback, the paste, the cancel). */
export class Deferred<T> {
  readonly promise: Promise<T>
  private resolveFn!: (value: T) => void
  private rejectFn!: (error: unknown) => void
  settled = false

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => { this.resolveFn = resolve; this.rejectFn = reject })
    this.promise.catch(() => {})          // a rejection nobody awaited yet is never "unhandled"
  }

  resolve(value: T): void { if (!this.settled) { this.settled = true; this.resolveFn(value) } }
  reject(error: unknown): void { if (!this.settled) { this.settled = true; this.rejectFn(error) } }
}

export class LoginCancelled extends Error { constructor() { super('sign-in cancelled'); this.name = 'LoginCancelled' } }

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}

function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function single(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key)
  return values.length === 1 ? values[0]! : null
}

export function parseAuthorizationInput(text: string): [string | null, string | null] {
  const value = text.trim()
  let query: URLSearchParams
  if (value.includes('://')) {
    try { query = new URL(value).searchParams } catch { return [null, null] }
  } else if (value.includes('code=')) {
    query = new URLSearchParams(value)
  } else if (value.includes('#')) {
    const at = value.indexOf('#')
    return [value.slice(0, at) || null, value.slice(at + 1) || null]
  } else {
    return [value || null, null]
  }
  const code = single(query, 'code')
  const state = single(query, 'state')
  if (code === null || state === null) return [null, null]
  return [code, state]
}

export function validatedInput(text: string, expectedState: string): CallbackResult {
  const [code, state] = parseAuthorizationInput(text)
  if (!code || !state || !sameState(state, expectedState)) {
    throw new NativeAuthError('paste the complete redirect URL or code#state from this login (state must match)')
  }
  return { code, state }
}

function isLoopback(host: string): boolean {
  const kind = isIP(host)
  if (kind === 4) return host.startsWith('127.')
  if (kind === 6) return host === '::1'
  return false
}

export class CallbackServer {
  readonly host: string
  readonly port: number
  readonly path: string
  readonly expected_state: string
  private server: ReturnType<typeof Bun.serve> | null = null
  private result: Deferred<CallbackResult> | null = null

  constructor(opts: { host: string; port: number; path: string; expected_state: string }) {
    if (!isLoopback(opts.host)) throw new NativeAuthError('OAuth callback must bind to a loopback address')
    if (!opts.expected_state) throw new NativeAuthError('OAuth state must not be empty')
    this.host = opts.host; this.port = opts.port; this.path = opts.path; this.expected_state = opts.expected_state
  }

  /** Bind the loopback port (throws when it is taken: the caller falls back to pasting). */
  async start(): Promise<void> {
    this.result = new Deferred<CallbackResult>()
    this.server = Bun.serve({
      hostname: this.host, port: this.port, idleTimeout: 10,
      fetch: (request) => {
        const url = new URL(request.url)
        const [status, title, body] = this.respond(`${request.method} ${url.pathname}${url.search} HTTP/1.1`)
        const page = PAGE.replace('{title}', escapeHtml(title)).replace('{body}', escapeHtml(body))
        return new Response(page, {
          status: Number(status.split(' ')[0]),
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'", Connection: 'close' },
        })
      },
    })
  }

  get bound_port(): number {
    if (this.server === null) throw new Error('the callback server is not running')
    return this.server.port ?? this.port
  }

  wait(timeoutMs?: number): Promise<CallbackResult> {
    if (this.result === null) throw new Error('the callback server is not running')
    if (timeoutMs === undefined) return this.result.promise
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs)
      this.result!.promise.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
    })
  }

  async close(): Promise<void> {
    if (this.server !== null) {
      this.server.stop(true)
      this.server = null
    }
    if (this.result !== null) this.result.reject(new LoginCancelled())
  }

  /** The answer to one redirect: the status line, the page title and its body. Only a GET on the callback path with
   *  this login's state is looked at; the code is taken once. */
  respond(requestLine: string): [string, string, string] {
    const parts = requestLine.split(/\s+/)
    if (parts.length !== 3 || parts[0] !== 'GET') return ['405 Method Not Allowed', 'Invalid callback', 'Only a browser redirect is accepted.']
    let url: URL
    try { url = new URL(parts[1]!, 'http://localhost') } catch { return ['400 Bad Request', 'Invalid callback', 'The redirect could not be read.'] }
    if (url.pathname !== this.path) return ['404 Not Found', 'Invalid callback', 'This is not the callback path.']
    const query = url.searchParams
    const states = query.getAll('state')
    if (states.length !== 1 || !sameState(states[0]!, this.expected_state)) {
      return ['400 Bad Request', 'State mismatch', 'This redirect does not belong to the current login.']
    }
    if (this.result === null || this.result.settled) return ['409 Conflict', 'Callback already handled', 'Return to the terminal.']
    if (query.has('error')) {
      this.result.reject(new NativeAuthError('login was declined or failed at the provider'))
      return ['400 Bad Request', 'Login declined', 'Return to the terminal to try again.']
    }
    const codes = query.getAll('code')
    if (codes.length !== 1 || !codes[0]) return ['400 Bad Request', 'Missing code', 'The redirect carried no authorization code.']
    this.result.resolve({ code: codes[0], state: states[0]! })
    return ['200 OK', 'Authorization received', 'Return to the terminal to check the login result.']
  }
}
