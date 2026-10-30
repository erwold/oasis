/** The HTTP surface in process: the whole app over Hono's `request` (no socket), a client that carries the session
 *  token and an origin, and the peer address a route may ask for. */

import { expect } from 'bun:test'
import { createApp, type App, type CreateOptions } from '../src/main.ts'
import type { Settings } from '../src/config.ts'
import { testConfig, testSettings, useFixtureHost } from './harness.ts'

export const HEADERS: Record<string, string> = { 'x-oasis-code-token': 'test-token', origin: 'http://localhost' }
export const BASE = 'http://localhost'

export async function makeApp(settings?: Settings | null, opts: CreateOptions = {}): Promise<App> {
  const app = await createApp(settings ?? testSettings(), testConfig(), { probe: false, ...opts })
  // a Full access command of a test never reads the person's startup files: a HOME of the test's own
  useFixtureHost(app.state.processes)
  return app
}

export interface ClientOptions { headers?: Record<string, string>; ip?: string | null }

/** A client of the app: JSON in, Response out; `ip` is what the server reports as the peer address (none: an
 *  in-process caller, which the accounts routes count as remote). */
export class Client {
  readonly headers: Record<string, string>
  readonly ip: string | null

  constructor(readonly app: App, opts: ClientOptions = {}) {
    this.headers = opts.headers ?? HEADERS
    this.ip = opts.ip === undefined ? null : opts.ip
  }

  request(method: string, path: string, opts: { json?: unknown; params?: Record<string, string | number>; headers?: Record<string, string> } = {}): Promise<Response> {
    const url = new URL(path, BASE)
    for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, String(v))
    const headers: Record<string, string> = { ...this.headers, ...(opts.headers ?? {}) }
    const init: RequestInit = { method, headers }
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(opts.json)
    }
    const env = this.ip === null ? undefined : { server: { requestIP: () => ({ address: this.ip, family: 'IPv4', port: 4321 }) } }
    return Promise.resolve(this.app.app.request(url.toString(), init, env))
  }

  get(path: string, params?: Record<string, string | number>, headers?: Record<string, string>) { return this.request('GET', path, { params, headers }) }
  post(path: string, json?: unknown, headers?: Record<string, string>) { return this.request('POST', path, { json: json ?? {}, headers }) }
  put(path: string, json: unknown, headers?: Record<string, string>) { return this.request('PUT', path, { json, headers }) }
  delete(path: string, headers?: Record<string, string>) { return this.request('DELETE', path, { headers }) }
}

export async function json<T = Record<string, unknown>>(response: Response, status = 200): Promise<T> {
  const text = await response.text()
  expect(response.status, `${response.status} ${text.slice(0, 300)}`).toBe(status)
  return JSON.parse(text) as T
}

export interface SseFrame { event: string; id: number; data: Record<string, unknown> }

/** The frames of an SSE body (the whole stream, read to its end). */
export function parseSse(text: string): SseFrame[] {
  const frames: SseFrame[] = []
  let current: Partial<SseFrame> = {}
  for (const line of text.split('\n')) {
    if (line.startsWith('event:')) current.event = line.slice(6).trim()
    else if (line.startsWith('id:')) current.id = Number(line.slice(3).trim())
    else if (line.startsWith('data:')) current.data = JSON.parse(line.slice(5).trim()) as Record<string, unknown>
    else if (line === '' && current.event !== undefined) { frames.push(current as SseFrame); current = {} }
  }
  return frames
}
