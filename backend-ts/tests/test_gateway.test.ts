/** The standing MCP gateway (src/gateway): its files and their modes, the host it accepts, the URL that does not move
 *  when a token inside this Mac does, the tools it serves while the backend is away (and the error a call gets then),
 *  the session token read again on every request, the tunnel commands (no secret on a command line, no ambient
 *  environment, no default config of the person's, ngrok's inspector off), the public probe's rate and its refusal to
 *  follow a redirect, and the CLI end to end on a port of its own (no provider: needs_setup, never a quick tunnel).
 *  Everything runs in temporary data directories; nothing reaches the network but the loopback. */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { HEADER } from '../src/api/auth.ts'
import { snapshotOf } from '../src/director/surfaces/index.ts'
import { BACKEND_UNAVAILABLE, buildGatewayApp, GATEWAY_SERVER } from '../src/gateway/app.ts'
import { CURRENT_DIRECTOR_TOOL_SURFACE, DIRECTOR_TOOL_SURFACES } from '@oasis-code/contract'
import { ensureSecret, GATEWAY_ALIASES, gatewayDir, normalizeHost, readConfig, readSecret, rotateSecret, writeConfig, writeProviderToken } from '../src/gateway/config.ts'
import { publicUrl } from '../src/gateway/main.ts'
import { ProbeScheduler, probeOnce } from '../src/gateway/probe.ts'
import { CLOUDFLARED_BINS, NGROK_BINS, tunnelCommand, tunnelEnv } from '../src/gateway/tunnel.ts'
import { tempDir } from './helpers.ts'

type Rec = Record<string, unknown>
const JSONRPC = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }
const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' }
const CALL = (name: string, args: Rec = {}) => ({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })
const mode = (p: string) => statSync(p).mode & 0o777

test('a host is a public DNS name and nothing more; anything that could carry a path, a port, a user or a private name is refused', () => {
  for (const [input, host] of [['mcp.example.com', 'mcp.example.com'], ['https://MCP.Example.com', 'mcp.example.com'], ['https://mcp.example.com/', 'mcp.example.com'], ['a-b.ngrok-free.dev', 'a-b.ngrok-free.dev'], ['mac.tail1234.ts.net.', 'mac.tail1234.ts.net']] as const) {
    expect(normalizeHost(input).host, input).toBe(host)
  }
  for (const bad of ['', 'localhost', 'example', 'http://mcp.example.com', 'https://mcp.example.com:8443', 'https://u:p@mcp.example.com', 'https://mcp.example.com/x', 'https://mcp.example.com/?a=1',
    'https://mcp.example.com#f', 'mcp.example.com/path', 'mcp.example.com:443', 'user@mcp.example.com', '127.0.0.1', '10.0.0.5', '[::1]', 'printer.local', 'nas.lan', 'box.internal', 'x.home.arpa',
    'abc.trycloudflare.com', '-bad.example.com', 'a..example.com', 'mcp.example.com\\evil', 'mcp example.com', 'ftp://mcp.example.com']) {
    expect(normalizeHost(bad).host, bad).toBeNull()
  }
})

test('the external secret, the config and a provider token are private files (0700 folder, 0600 files); the secret is 256 bits and only a revoke replaces it', () => {
  const data = tempDir('gw-files-')
  const s1 = ensureSecret(data)
  expect(s1).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(ensureSecret(data)).toBe(s1)
  expect(mode(gatewayDir(data))).toBe(0o700)
  expect(mode(join(gatewayDir(data), 'secret'))).toBe(0o600)
  writeConfig(data, { provider: 'cloudflare', host: 'https://MCP.example.com' })
  expect(readConfig(data)).toEqual({ version: 1, provider: 'cloudflare', host: 'mcp.example.com' })
  expect(mode(join(gatewayDir(data), 'config.json'))).toBe(0o600)
  expect(readFileSync(join(gatewayDir(data), 'config.json'), 'utf8')).not.toContain(s1)
  writeProviderToken(data, 'cloudflare', 'eyJhIjoiYWJjIiwidCI6ImRlZiIsInMiOiJnaGkifQ==')
  expect(mode(join(gatewayDir(data), 'cloudflared-token'))).toBe(0o600)
  expect(() => writeProviderToken(data, 'cloudflare', 'short')).toThrow()
  expect(() => writeProviderToken(data, 'cloudflare', 'has spaces in it and is long enough')).toThrow()
  expect(() => writeConfig(data, { provider: 'cloudflare', host: 'https://mcp.example.com/evil' })).toThrow()
  expect(readConfig(data)!.host).toBe('mcp.example.com')
  const s2 = rotateSecret(data)
  expect(s2).not.toBe(s1)
  expect(readSecret(data)).toBe(s2)
})

test('the public URL is made of the configured host and the external secret only: a new director token or session token leaves it as it is', () => {
  const data = tempDir('gw-url-')
  writeConfig(data, { provider: 'external', host: 'mcp.example.com' })
  const secret = ensureSecret(data)
  const before = publicUrl(readConfig(data)!.host, readSecret(data)!)
  expect(before).toBe(`https://mcp.example.com/${secret}/mcp/current`)
  writeFileSync(join(data, 'director-token'), 'a-brand-new-director-token-0000000000')
  writeFileSync(join(data, 'session-token'), 'a-brand-new-session-token-1111111111')
  expect(publicUrl(readConfig(data)!.host, readSecret(data)!)).toBe(before)
  rotateSecret(data)
  expect(publicUrl(readConfig(data)!.host, readSecret(data)!)).not.toBe(before)
})

function gateway(data: string, fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>, host: string | null = 'mcp.example.com') {
  const app = buildGatewayApp({ dataDir: data, harnessPort: 8391, host: () => host, instance: 'inst-1', env: {}, ...(fetchImpl ? { fetchImpl } : {}) })
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    Promise.resolve(app.fetch(new Request(`http://127.0.0.1:8394${path}`, { method: 'POST', headers: { ...JSONRPC, ...headers }, body: JSON.stringify(body) })))
  return { app, post }
}

test('with no backend and no session token: initialize and tools/list answer from the current surface\'s snapshot; a tool call is an error that says the backend is unavailable', async () => {
  const data = tempDir('gw-nobackend-')
  const secret = ensureSecret(data)
  let calls = 0
  const { post } = gateway(data, async () => { calls += 1; throw new TypeError('fetch failed') })
  const init = await post(`/${secret}/mcp/current`, INITIALIZE)
  expect(init.status).toBe(200)
  expect(((await init.json() as Rec).result as Rec).instructions).toBe(snapshotOf(CURRENT_DIRECTOR_TOOL_SURFACE).connector.instructions)
  const list = await (await post(`/${secret}/mcp/current`, LIST)).json() as Rec
  expect(JSON.stringify((list.result as Rec).tools)).toBe(JSON.stringify(snapshotOf(CURRENT_DIRECTOR_TOOL_SURFACE).connector.tools))
  const call = await (await post(`/${secret}/mcp/current`, CALL('list_models'))).json() as Rec
  const result = call.result as Rec
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('oasis-code backend unavailable')
  // no session token: nothing was sent anywhere
  expect(calls).toBe(0)
  // a session token, but the backend does not answer: the same plain error
  writeFileSync(join(data, 'session-token'), 'sess-token-one-xxxxxxxxxxxxxxxx')
  const again = await (await post(`/${secret}/mcp/current`, CALL('list_models'))).json() as Rec
  expect(JSON.stringify((again.result as Rec).content)).toContain(BACKEND_UNAVAILABLE.slice(0, 40))
  expect(calls).toBe(1)
})

test('every request reads the session token as the data directory holds it now: a backend that minted a new one is reached with it, never with the stale one', async () => {
  const data = tempDir('gw-session-')
  const secret = ensureSecret(data)
  const seen: string[] = []
  const fake = async (_input: string | URL, init?: RequestInit) => {
    seen.push(String((init?.headers as Record<string, string>)[HEADER]))
    return Response.json({ models: [], default_model: null })
  }
  const { post } = gateway(data, fake)
  writeFileSync(join(data, 'session-token'), 'sess-token-one-xxxxxxxxxxxxxxxx')
  await post(`/${secret}/mcp/current`, CALL('list_models'))
  writeFileSync(join(data, 'session-token'), 'sess-token-two-yyyyyyyyyyyyyyyy\n')
  await post(`/${secret}/mcp/current`, CALL('list_models'))
  expect(seen).toEqual(['sess-token-one-xxxxxxxxxxxxxxxx', 'sess-token-two-yyyyyyyyyyyyyyyy'])
})

test('the gateway answers under its own secret only (not the director token), keeps the frozen paths, refuses foreign hosts, and a revoke stops the old URL at once', async () => {
  const data = tempDir('gw-secret-')
  writeFileSync(join(data, 'director-token'), 'director-token-zzzzzzzzzzzzzzzzzz')
  const secret = ensureSecret(data)
  const { post, app } = gateway(data, async () => { throw new TypeError('fetch failed') })
  expect((await post('/director-token-zzzzzzzzzzzzzzzzzz/mcp/current', INITIALIZE)).status).toBe(404)
  expect((await post(`/${secret}/mcp/current`, INITIALIZE, { host: 'mcp.example.com' })).status).toBe(200)
  expect((await post(`/${secret}/mcp/current`, INITIALIZE, { host: 'evil.example' })).status).toBe(421)
  expect((await post(`/${secret}/mcp/current`, INITIALIZE, { host: 'mcp.example.com', origin: 'https://evil.example' })).status).toBe(403)
  for (const [path, surface] of [['/mcp', 'director.v1'], ['/mcp/v5', 'director.v5'], ['/mcp/v6', 'director.v6']] as const) {
    const tools = ((await (await post(`/${secret}${path}`, LIST)).json() as Rec).result as Rec).tools
    expect(JSON.stringify(tools), path).toBe(JSON.stringify(snapshotOf(surface).connector.tools))
  }
  const health = await (await app.fetch(new Request('http://127.0.0.1:8394/healthz'))).text()
  expect(JSON.parse(health)).toEqual({ ok: true, server: GATEWAY_SERVER, instance: 'inst-1' })
  expect(health).not.toContain(secret)
  expect(health).not.toContain('example.com')
  const fresh = rotateSecret(data)
  expect((await post(`/${secret}/mcp/current`, INITIALIZE)).status).toBe(404)
  expect((await post(`/${fresh}/mcp/current`, INITIALIZE)).status).toBe(200)
})

test('tunnel commands: tokens stay in 0600 files (never an argument), the tool runs with an environment of its own and a config of its own, ngrok without its inspector', () => {
  const data = tempDir('gw-tunnel-')
  const exists = (p: string) => p === CLOUDFLARED_BINS[0] || p === NGROK_BINS[0]
  const cfToken = 'eyJhIjoiY2YtYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0='
  const ngToken = '2abcDEFghiJKLmnoPQRstuVWXyz_0123456789ABCDEF'
  expect(tunnelCommand('cloudflare', { dataDir: data, port: 8394, host: 'mcp.example.com', exists }).why).toBe('no Cloudflare tunnel token saved')
  writeProviderToken(data, 'cloudflare', cfToken)
  const cf = tunnelCommand('cloudflare', { dataDir: data, port: 8394, host: 'mcp.example.com', exists }).cmd!
  expect(cf.command).toBe(CLOUDFLARED_BINS[0])
  expect(cf.args).toEqual(['tunnel', '--config', join(gatewayDir(data), 'cloudflared.yml'), '--no-autoupdate', 'run', '--token-file', join(gatewayDir(data), 'cloudflared-token')])
  expect(cf.args.join(' ')).not.toContain(cfToken)
  expect(readFileSync(join(gatewayDir(data), 'cloudflared.yml'), 'utf8')).not.toContain(cfToken)
  writeProviderToken(data, 'ngrok', ngToken)
  const ng = tunnelCommand('ngrok', { dataDir: data, port: 8394, host: 'abc.ngrok-free.dev', exists }).cmd!
  expect(ng.args).toEqual(['http', 'http://127.0.0.1:8394', '--url', 'https://abc.ngrok-free.dev', '--config', join(gatewayDir(data), 'ngrok.yml'), '--inspect=false', '--log', 'stdout', '--log-format', 'logfmt'])
  expect(ng.args.join(' ')).not.toContain(ngToken)
  expect(readFileSync(join(gatewayDir(data), 'ngrok.yml'), 'utf8')).toContain(ngToken)
  expect(mode(join(gatewayDir(data), 'ngrok.yml'))).toBe(0o600)
  // external: the gateway starts nothing
  expect(tunnelCommand('external', { dataDir: data, port: 8394, host: 'mcp.example.com', exists })).toEqual({ cmd: null, why: null })
  // nothing of the caller's environment reaches the tool: an ambient TUNNEL_TOKEN would outrank --token-file
  const env = tunnelEnv(data)
  expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'PATH'])
  expect(env.HOME).toBe(gatewayDir(data))
  // no tool installed: said so, nothing started
  expect(tunnelCommand('ngrok', { dataDir: data, port: 8394, host: 'abc.ngrok-free.dev', exists: () => false }).why).toContain('not installed')
})

test('the public probe: at start, after a reconnect, else every five minutes; reconnect storms never probe more than once per 30 s', async () => {
  let now = 0
  const timers: { at: number; fn: () => void; id: number }[] = []
  let nextId = 0
  const runs: number[] = []
  const sched = new ProbeScheduler({
    run: async () => { runs.push(now) }, now: () => now,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn, id: nextId++ }; timers.push(t); return t.id },
    clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) },
  })
  const advance = async (to: number) => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const t = timers[0]
      if (!t || t.at > to) break
      timers.shift()
      now = t.at
      t.fn()
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    }
    now = to
  }
  sched.start()
  await advance(60 * 60_000)
  // first at 5 s, then every 5 min: 12 probes in the first hour (5 s … 55 min 5 s), never closer than 5 min apart
  expect(runs[0]).toBe(5_000)
  expect(runs.length).toBe(12)
  for (let i = 1; i < runs.length; i += 1) expect(runs[i]! - runs[i - 1]!).toBe(5 * 60_000)
  // a reconnect brings one forward, a storm of reconnects does not multiply them
  runs.length = 0
  const t0 = now
  for (let i = 0; i < 50; i += 1) { sched.kick(); await advance(now + 100) }
  await advance(t0 + 60_000)
  expect(runs.length).toBeLessThanOrEqual(2)
  for (let i = 1; i < runs.length; i += 1) expect(runs[i]! - runs[i - 1]!).toBeGreaterThanOrEqual(30_000)
  sched.stop()
  const before = runs.length
  await advance(now + 60 * 60_000)
  expect(runs.length).toBe(before)
})

test('a probe believes only this gateway\'s own answer, and never follows a redirect', async () => {
  const seen: RequestInit[] = []
  const ok = await probeOnce('mcp.example.com', 'inst-1', async (_u, init) => { seen.push(init!); return Response.json({ ok: true, server: GATEWAY_SERVER, instance: 'inst-1' }) })
  expect(ok).toEqual({ ok: true })
  expect(seen[0]!.redirect).toBe('manual')
  const redirected = await probeOnce('mcp.example.com', 'inst-1', async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/healthz' } }))
  expect(redirected.ok).toBe(false)
  const other = await probeOnce('mcp.example.com', 'inst-1', async () => Response.json({ ok: true, server: GATEWAY_SERVER, instance: 'someone-else' }))
  expect(other.ok).toBe(false)
  const down = await probeOnce('mcp.example.com', 'inst-1', async () => { throw new TypeError('fetch failed') })
  expect(down.ok).toBe(false)
})

// ---- the CLI, as launchd starts it ------------------------------------------------------------------------------

const children: Bun.Subprocess[] = []
afterEach(async () => { for (const c of children.splice(0)) { c.kill('SIGTERM'); await c.exited } })

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)) })
  })
}

function isolatedEnv(data: string, harnessPort: number): Record<string, string> {
  // nothing of the person's: a data directory, a profile and ports of the test's own; no tunnel or provider variable
  const keep = ['PATH', 'TMPDIR', 'LANG']
  const env: Record<string, string> = {}
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!
  return { ...env, HOME: data, OASIS_CODE_DATA: data, OASIS_CODE_USER_DATA: join(data, 'electron'), OASIS_CODE_PORT: String(harnessPort), OASIS_CODE_DIRECTOR_PORT: '1', OASIS_CODE_BRIDGE_PORT: '1', OASIS_CODE_GATEWAY_PORT: '1' }
}

async function cli(args: string[], env: Record<string, string>, stdin = ''): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(['bun', 'run', 'src/index.ts', 'gateway', ...args], { cwd: join(import.meta.dir, '..'), env, stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited]
  return { code, out, err }
}

test('the CLI: setup takes the token on stdin (never an argument), refuses a bad host leaving the setup as it was; url and revoke; nothing printed holds a token', async () => {
  const data = tempDir('gw-cli-')
  const env = isolatedEnv(data, await freePort())
  const token = 'eyJhIjoiY2YtYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0='
  expect((await cli(['setup', '--provider', 'cloudflare', '--host', 'mcp.example.com'], env)).code).toBe(2)   // no token
  const set = await cli(['setup', '--provider', 'cloudflare', '--host', 'https://mcp.example.com'], env, token)
  expect(set.code, set.err).toBe(0)
  expect(JSON.parse(set.out)).toEqual({ provider: 'cloudflare', host: 'mcp.example.com', token_set: true })
  expect(set.out + set.err).not.toContain(token)
  const bad = await cli(['setup', '--provider', 'external', '--host', 'https://mcp.example.com/../x'], env)
  expect(bad.code).toBe(2)
  expect(readConfig(data)).toEqual({ version: 1, provider: 'cloudflare', host: 'mcp.example.com' })
  const url = JSON.parse((await cli(['url'], env)).out) as { url: string }
  expect(url.url).toBe(`https://mcp.example.com/${readSecret(data)}/mcp/current`)
  const revoked = JSON.parse((await cli(['revoke'], env)).out) as { url: string }
  expect(revoked.url).not.toBe(url.url)
  expect(revoked.url).toBe(`https://mcp.example.com/${readSecret(data)}/mcp/current`)
})

test('the gateway process with an external tunnel: serves the loopback, starts no tunnel of its own, metadata without a backend, a status file that is 0600 and holds no URL or secret', async () => {
  const data = tempDir('gw-run-')
  mkdirSync(data, { recursive: true })
  const env = isolatedEnv(data, await freePort())
  expect((await cli(['setup', '--provider', 'external', '--host', 'gw-run.invalid'], env)).code).toBe(0)
  const p = Bun.spawn(['bun', 'run', 'src/index.ts', 'gateway', '--port', '0'], { cwd: join(import.meta.dir, '..'), env, stdout: 'pipe', stderr: 'pipe' })
  children.push(p)
  const statusPath = join(gatewayDir(data), 'status.json')
  let status: Rec | null = null
  for (let i = 0; i < 200 && !(status && status.backend !== 'unknown'); i += 1) {
    await Bun.sleep(50)
    try { status = JSON.parse(readFileSync(statusPath, 'utf8')) as Rec } catch { status = null }
  }
  expect(status).not.toBeNull()
  expect(status!.pid).toBe(p.pid)
  expect(status!.public).toBe('starting')
  expect(status!.provider).toBe('external')
  expect(status!.backend).toBe('down')
  expect(mode(statusPath)).toBe(0o600)
  const secret = readSecret(data)!
  const raw = readFileSync(statusPath, 'utf8')
  expect(raw).not.toContain(secret)
  expect(raw).not.toContain('/mcp')
  const port = status!.port as number
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json() as Rec
  expect(health.server).toBe(GATEWAY_SERVER)
  expect(health.instance).toBe(status!.instance)
  const list = await (await fetch(`http://127.0.0.1:${port}/${secret}/mcp/current`, { method: 'POST', headers: JSONRPC, body: JSON.stringify(LIST) })).json() as Rec
  expect(JSON.stringify((list.result as Rec).tools)).toBe(JSON.stringify(snapshotOf(CURRENT_DIRECTOR_TOOL_SURFACE).connector.tools))
  p.kill('SIGTERM')
  expect(await p.exited).toBe(0)
  const err = await new Response(p.stderr).text()
  expect(err).not.toContain(secret)
  expect(err).not.toMatch(/cloudflared|trycloudflare/)
  expect(existsSync(join(gatewayDir(data), 'cloudflared.yml'))).toBe(false)
})

test('a setup that is refused (a bad host, a bad token) writes nothing: the token and the config before it stay as they were', async () => {
  const data = tempDir('gw-setup-atomic-')
  const env = isolatedEnv(data, await freePort())
  const first = 'eyJhIjoiZmlyc3QtdG9rZW4tdmFsdWUiLCJ0IjoiMSJ9'
  expect((await cli(['setup', '--provider', 'cloudflare', '--host', 'mcp.example.com'], env, first)).code).toBe(0)
  const token = () => readFileSync(join(gatewayDir(data), 'cloudflared-token'), 'utf8')
  // a valid new token with a host that is refused: neither is kept
  const bad = await cli(['setup', '--provider', 'cloudflare', '--host', 'https://mcp.example.com/../evil'], env, 'eyJhIjoic2Vjb25kLXRva2VuLXZhbHVlIiwidCI6IjIifQ==')
  expect(bad.code).toBe(2)
  expect(token()).toBe(first)
  expect(readConfig(data)).toEqual({ version: 1, provider: 'cloudflare', host: 'mcp.example.com' })
  // a malformed token with a good host: neither is kept
  expect((await cli(['setup', '--provider', 'cloudflare', '--host', 'other.example.com'], env, 'not a token')).code).toBe(2)
  expect(token()).toBe(first)
  expect(readConfig(data)!.host).toBe('mcp.example.com')
  // ngrok without a token at all: refused, the Cloudflare setup untouched
  expect((await cli(['setup', '--provider', 'ngrok', '--host', 'abc.ngrok-free.dev'], env)).code).toBe(2)
  expect(readConfig(data)!.provider).toBe('cloudflare')
  expect(existsSync(join(gatewayDir(data), 'ngrok-authtoken'))).toBe(false)
})

/** A fake child: emits what the test says, records the signals it got. */
function fakeChild(opts: { exitsOnTerm?: boolean } = {}) {
  const handlers: Record<string, ((...a: unknown[]) => void)[]> = {}
  const child = {
    signals: [] as string[],
    stdout: { on: () => undefined }, stderr: { on: () => undefined },
    on(event: string, fn: (...a: unknown[]) => void) { (handlers[event] ??= []).push(fn); return child },
    emit(event: string, ...a: unknown[]) { for (const fn of handlers[event] ?? []) fn(...a) },
    kill(signal?: string) { child.signals.push(signal ?? 'SIGTERM'); if (opts.exitsOnTerm !== false && signal !== 'SIGKILL') queueMicrotask(() => child.emit('exit', null, signal)); return true },
  }
  return child
}

function fakeTimers() {
  let now = 0
  const list: { at: number; fn: () => void; id: number }[] = []
  let id = 0
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { list.push({ at: now + ms, fn, id: ++id }); return id },
    clearTimer: (t: unknown) => { const i = list.findIndex((x) => x.id === t); if (i >= 0) list.splice(i, 1) },
    async advance(ms: number) {
      const to = now + ms
      for (;;) { list.sort((a, b) => a.at - b.at); const t = list[0]; if (!t || t.at > to) break; list.shift(); now = t.at; t.fn(); await Promise.resolve(); await Promise.resolve() }
      now = to
    },
    pending: () => list.length,
  }
}

test('the tunnel supervisor: a spawn that fails (ENOENT: an error, never an exit) is retried up the ladder, one child at a time; error then exit counts once', async () => {
  const { TunnelSupervisor } = await import('../src/gateway/tunnel.ts')
  const timers = fakeTimers()
  const children: ReturnType<typeof fakeChild>[] = []
  const ended: string[] = []
  const sup = new TunnelSupervisor({
    command: () => ({ cmd: { command: '/nope/cloudflared', args: [] }, why: null }),
    spawn: () => { const c = fakeChild(); children.push(c); return c as never },
    onEnded: (why, wait) => ended.push(`${wait}:${why}`), ...timers, ladder: [2_000, 5_000], stableMs: 60_000,
  })
  sup.start()
  sup.start()   // already running: no second child
  expect(children.length).toBe(1)
  children[0]!.emit('error', Object.assign(new Error('spawn /nope/cloudflared ENOENT'), { code: 'ENOENT' }))
  children[0]!.emit('exit', -2, null)   // a child that errors and then exits is one end, not two
  expect(ended).toEqual(['2000:the tunnel did not start or failed (spawn /nope/cloudflared ENOENT)'])
  expect(sup.running).toBe(false)
  await timers.advance(1_999)
  expect(children.length).toBe(1)
  await timers.advance(1)
  expect(children.length).toBe(2)
  children[1]!.emit('error', new Error('spawn ENOENT'))
  await timers.advance(5_000)
  expect(children.length).toBe(3)
  expect(ended.map((e) => e.split(':')[0])).toEqual(['2000', '5000'])
  // stop: no restart after it; a child that exits on SIGTERM resolves it at once
  const stopped = sup.stop()
  await stopped
  expect(children[2]!.signals).toEqual(['SIGTERM'])
  await timers.advance(60_000)
  expect(children.length).toBe(3)
  expect(timers.pending()).toBe(0)
})

test('the tunnel supervisor: stop resolves even when the child ignores SIGTERM and never exits (SIGKILL, then given up on after the grace)', async () => {
  const { TunnelSupervisor } = await import('../src/gateway/tunnel.ts')
  const timers = fakeTimers()
  const child = fakeChild({ exitsOnTerm: false })
  const sup = new TunnelSupervisor({ command: () => ({ cmd: { command: 'x', args: [] }, why: null }), spawn: () => child as never, ...timers, killMs: 3_000, graceMs: 1_000 })
  sup.start()
  let done = false
  void sup.stop().then(() => { done = true })
  await timers.advance(2_999)
  expect(done).toBe(false)
  await timers.advance(1)
  expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
  await timers.advance(1_000)
  await Promise.resolve()
  expect(done).toBe(true)
  // nothing restarts it
  await timers.advance(120_000)
  expect(timers.pending()).toBe(0)
})

test('/mcp/current is the newest tool surface the contract lists: a new surface moves it without another edit', () => {
  expect(GATEWAY_ALIASES.current).toBe(DIRECTOR_TOOL_SURFACES[DIRECTOR_TOOL_SURFACES.length - 1]!)
})

test('quick is the tunnel when nothing is set up: setup --provider quick drops a stable setup (its token stays), and url / revoke give the quick name the running gateway wrote', async () => {
  const data = tempDir('gw-quick-')
  const env = isolatedEnv(data, await freePort())
  expect((await cli(['setup', '--provider', 'external', '--host', 'mcp.example.com'], env)).code).toBe(0)
  const back = await cli(['setup', '--provider', 'quick'], env)
  expect(back.code).toBe(0)
  expect(JSON.parse(back.out)).toEqual({ provider: 'quick', host: null, token_set: null })
  expect(readConfig(data)).toBeNull()
  // no name yet (the gateway has not written one): no URL
  expect(JSON.parse((await cli(['url'], env)).out)).toEqual({ url: null, provider: 'quick', host: null })
  writeFileSync(join(gatewayDir(data), 'status.json'), JSON.stringify({ provider: 'quick', host: 'aa-bb.trycloudflare.com' }))
  expect(JSON.parse((await cli(['url'], env)).out)).toEqual({ url: `https://aa-bb.trycloudflare.com/${readSecret(data)}/mcp/current`, provider: 'quick', host: 'aa-bb.trycloudflare.com' })
  const revoked = JSON.parse((await cli(['revoke'], env)).out) as { url: string }
  expect(revoked.url).toBe(`https://aa-bb.trycloudflare.com/${readSecret(data)}/mcp/current`)
  // a quick name typed as a fixed host is refused: it is the quick tunnel's to follow
  const typed = await cli(['setup', '--provider', 'external', '--host', 'aa-bb.trycloudflare.com'], env)
  expect(typed.code).toBe(2)
  expect(typed.err).toContain('choose the quick tunnel')
})
