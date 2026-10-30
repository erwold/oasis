// Semantic probes of the director HTTP surface against the BASELINE API (backend-ts/src/director/{app,main,server}.ts).
// Assertions state the NEW required behaviour; on baseline they must fail on behaviour, not on import.
// Run from the clone's backend-ts (so bun resolves deps):  QA_REPO=<clone> bun test <abs path to this file>
// No listener is opened: requests go to app.fetch in-process; the "offline backend" is a closed loopback port.
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = process.env.QA_REPO
if (!REPO) throw new Error('set QA_REPO')
const B = join(REPO, 'backend-ts', 'src')
let mods: Record<string, any>
try {
  mods = {
    app: await import(join(B, 'director/app.ts')), server: await import(join(B, 'director/server.ts')),
    harness: await import(join(B, 'director/harness.ts')), main: await import(join(B, 'director/main.ts')),
    surfaces: await import(join(B, 'director/surfaces/index.ts')), config: await import(join(B, 'config.ts')),
  }
} catch (e) { console.error(`IMPORT-ERROR (not a behaviour result): ${(e as Error).message}`); process.exit(3) }

const SECRET = 'qaSecret_' + 'x'.repeat(24)
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const offline = () => mods.harness.Harness.connect('http://127.0.0.1:9', 'unused') // port 9 (discard): nothing listens
const baselineApp = () => mods.app.buildHttpApp((client: string | null, surface: string) => mods.server.buildServer(offline(), { surface }), SECRET, [])

async function rpc(app: { fetch: (r: Request) => Promise<Response> | Response }, path: string, method: string, id = 1, headers: Record<string, string> = {}) {
  const res = await app.fetch(new Request(`http://127.0.0.1:1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qa', version: '1' } } : {} }) }))
  const text = await res.text()
  let body: any = null; try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

test('B1 /<secret>/mcp/current exists and serves exactly director.v6 tools', async () => {
  const app = baselineApp()
  const init = await rpc(app, `/${SECRET}/mcp/current`, 'initialize')
  expect(init.status).toBe(200)
  const list = await rpc(app, `/${SECRET}/mcp/current`, 'tools/list', 2)
  expect(list.status).toBe(200)
  expect(sha(list.body.result.tools)).toBe(sha(mods.surfaces.snapshotOf('director.v6').connector.tools))
})

test('B2 control (expected PASS on baseline and after): old paths keep their frozen surfaces; wrong secret is 404; foreign Host 421; foreign Origin 403', async () => {
  const app = baselineApp()
  for (const [p, s] of [['/mcp', 'director.v1'], ['/mcp/v2', 'director.v2'], ['/mcp/v3', 'director.v3'], ['/mcp/v4', 'director.v4'], ['/mcp/v5', 'director.v5'], ['/mcp/v6', 'director.v6']] as const) {
    const list = await rpc(app, `/${SECRET}${p}`, 'tools/list')
    expect(list.status, p).toBe(200)
    expect(sha(list.body.result.tools), p).toBe(sha(mods.surfaces.snapshotOf(s).connector.tools))
  }
  expect((await rpc(app, `/wrong/mcp/v6`, 'tools/list')).status).toBe(404)
  expect((await rpc(app, `/${SECRET}/mcp/v6`, 'tools/list', 1, { host: 'evil.example' })).status).toBe(421)
  expect((await rpc(app, `/${SECRET}/mcp/v6`, 'tools/list', 1, { origin: 'https://evil.example' })).status).toBe(403)
})

test('B3 metadata (initialize/tools/list) is available while the backend is offline: the endpoint process starts without a live harness', async () => {
  const data = mkdtempSync(join(tmpdir(), 'qa-dir-'))
  const settings = new mods.config.Settings({ data_dir: data, session_token: 'qa-session', port: 9, director_port: 0, director_token: SECRET })
  // baseline serve() probes the harness before listening: with the backend offline it throws and never serves
  let threw: string | null = null
  const run = mods.main.serve({ transport: 'streamable-http', port: 0, harness: 'http://127.0.0.1:9', allow_host: [], surface: 'director.v1' }, settings).catch((e: Error) => { threw = e.message })
  await Promise.race([run, new Promise((r) => setTimeout(r, 3000))])
  expect(threw, `endpoint refused to start with backend offline: ${threw}`).toBeNull()
  process.kill(process.pid, 'SIGTERM') // only reached if it started: stop our own in-process server (baseline handler)
})
