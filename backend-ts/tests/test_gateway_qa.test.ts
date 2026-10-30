/** QA regressions for the gateway (independent review of 4978168):
 *  1. `backend: up` only when the backend accepts THIS data directory's session token — the public /api/meta/build
 *     answering is not enough (a backend of another data directory, or a rotated token, would show a false green).
 *     Driven through the real `gateway run` process against a loopback stand-in backend, so it runs unchanged on the
 *     candidate before the fix (behavioural FAIL) and after (PASS).
 *  2. The quick test tunnel's cloudflared config is a valid, non-empty YAML document (cloudflared logged
 *     "ERR Configuration file … was empty" on every start) and still names no token.
 *  The quick-tunnel host re-learn after a tunnel restart is checked live (a real cloudflared: docs/stable-mcp-qa.md);
 *  its pure part is pinned here through `quickHostAfter`. */

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gatewayDir } from '../src/gateway/config.ts'
import { tunnelCommand } from '../src/gateway/tunnel.ts'
import { tempDir } from './helpers.ts'

const children: Bun.Subprocess[] = []
const servers: { stop: (force?: boolean) => void }[] = []
afterEach(async () => {
  for (const c of children.splice(0)) { c.kill('SIGTERM'); await c.exited }
  for (const s of servers.splice(0)) s.stop(true)
})

/** A loopback backend: /api/meta/build public; every other /api/ path wants `token` in x-oasis-code-token. */
function standInBackend(token: string): number {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/api/meta/build') return Response.json({ api_version: 'any', build: 'stand-in' })
    if (req.headers.get('x-oasis-code-token') !== token) return Response.json({ detail: 'not authenticated' }, { status: 401 })
    return Response.json([])
  } })
  servers.push(server)
  return server.port!
}

async function backendSeen(data: string, harnessPort: number): Promise<string | null> {
  const env: Record<string, string> = {}
  for (const k of ['PATH', 'TMPDIR', 'LANG']) if (process.env[k]) env[k] = process.env[k]!
  Object.assign(env, { HOME: data, OASIS_CODE_DATA: data, OASIS_CODE_USER_DATA: join(data, 'electron'), OASIS_CODE_PORT: String(harnessPort), OASIS_CODE_DIRECTOR_PORT: '1', OASIS_CODE_BRIDGE_PORT: '1', OASIS_CODE_GATEWAY_PORT: '1' })
  const p = Bun.spawn(['bun', 'run', 'src/index.ts', 'gateway', '--port', '0'], { cwd: join(import.meta.dir, '..'), env, stdout: 'pipe', stderr: 'pipe' })
  children.push(p)
  const statusPath = join(gatewayDir(data), 'status.json')
  for (let i = 0; i < 200; i += 1) {
    await Bun.sleep(50)
    try { const s = JSON.parse(readFileSync(statusPath, 'utf8')) as { backend: string }; if (s.backend !== 'unknown') return s.backend } catch { /* not yet */ }
  }
  return null
}

test('backend is "up" only when it accepts this data directory\'s session token; a 401 behind a public /api/meta/build is not up', async () => {
  const data = tempDir('gw-qa-auth-')
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'session-token'), 'stale-or-foreign-token')
  expect(await backendSeen(data, standInBackend('the-real-token'))).toBe('down')
})

test('control: the backend accepting the session token is "up"', async () => {
  const data = tempDir('gw-qa-auth-ok-')
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'session-token'), 'the-real-token')
  expect(await backendSeen(data, standInBackend('the-real-token'))).toBe('up')
})

test('the quick test tunnel\'s cloudflared config is a non-empty YAML document with no token in it', () => {
  const data = tempDir('gw-qa-cfcfg-')
  const { cmd } = tunnelCommand('quick', { dataDir: data, port: 1, host: null, exists: (p) => p.endsWith('cloudflared') })
  expect(cmd).not.toBeNull()
  const text = readFileSync(join(gatewayDir(data), 'cloudflared.yml'), 'utf8')
  // a YAML document with at least one key: not only comments or blank lines
  expect(text.split('\n').some((l) => /^[a-z][a-z0-9-]*:\s*\S/.test(l))).toBe(true)
  expect(text).not.toMatch(/token\s*:/i)
  // the edge over TCP 443, which networks that block QUIC's UDP still let through
  expect(text).toMatch(/^protocol: http2$/m)
})

test('a quick tunnel that came back under a new name is followed (the name is never fixed)', async () => {
  const tunnel = await import('../src/gateway/tunnel.ts') as Record<string, unknown>
  const after = tunnel.quickHostAfter as ((current: string | null, text: string) => string | null) | undefined
  expect(typeof after).toBe('function')
  expect(after!(null, 'INF |  https://a-b.trycloudflare.com  |')).toBe('a-b.trycloudflare.com')
  expect(after!('a-b.trycloudflare.com', 'INF |  https://c-d.trycloudflare.com  |')).toBe('c-d.trycloudflare.com')
  expect(after!('a-b.trycloudflare.com', 'INF Registered tunnel connection')).toBe('a-b.trycloudflare.com')
})
