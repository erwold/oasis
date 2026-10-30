// Raw MCP Streamable-HTTP probe over the real network: initialize, notifications/initialized, tools/list.
// Usage: bun mcp_probe.ts <url> [--repo <clone>] [--surface director.v6] [--out file.json]
// Prints status, protocol version, server name, tool count and the tools sha256 vs the frozen snapshot (never the URL secret).
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeFetch } from '../../src/safe_fetch.ts'

const argv = process.argv.slice(2)
const url = argv[0]
if (!url) { console.error('usage: bun mcp_probe.ts <url> [--repo dir] [--surface s] [--out f]'); process.exit(2) }
const at = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
const surface = at('--surface') ?? 'director.v6'
const repo = at('--repo')
const shown = url.replace(/(https?:\/\/[^/]+\/)[^/]+(\/)/, '$1<secret>$2')
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')

async function call(method: string, id: number | null, params: unknown = {}) {
  const t0 = Date.now()
  const res = await safeFetch(url, { method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', 'user-agent': 'openai-mcp/qa-probe' },
    body: JSON.stringify(id === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }) })
  const text = await res.text()
  let body: any = text
  try { body = JSON.parse(text) } catch { const m = /^data: (.*)$/m.exec(text); if (m) try { body = JSON.parse(m[1]!) } catch { /* raw */ } }
  return { status: res.status, ms: Date.now() - t0, body, cfRay: res.headers.get('cf-ray') }
}

const out: Record<string, unknown> = { url: shown, at: new Date().toISOString(), surface }
const init = await call('initialize', 1, { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qa-probe', version: '1' } })
out.initialize = { status: init.status, ms: init.ms, cf_ray: init.cfRay, protocol: init.body?.result?.protocolVersion, server: init.body?.result?.serverInfo, error: init.body?.error ?? (init.status >= 400 ? init.body : undefined) }
const note = await call('notifications/initialized', null)
out.initialized = { status: note.status }
const list = await call('tools/list', 2)
const tools = list.body?.result?.tools
out.tools_list = { status: list.status, ms: list.ms, cf_ray: list.cfRay, count: Array.isArray(tools) ? tools.length : null, names: Array.isArray(tools) ? tools.map((t: any) => t.name) : null, sha256: tools ? sha(tools) : null, error: list.body?.error }
if (repo && tools) {
  const snap = JSON.parse(readFileSync(join(repo, 'backend-ts/src/director/surfaces', `${surface}.json`), 'utf8'))
  out.snapshot_sha256 = sha(snap.connector.tools)
  out.matches_snapshot = out.snapshot_sha256 === (out.tools_list as any).sha256
}
const s = JSON.stringify(out, null, 2)
console.log(s)
if (at('--out')) writeFileSync(at('--out')!, s)
process.exit(init.status === 200 && list.status === 200 && Array.isArray(tools) ? 0 : 1)
