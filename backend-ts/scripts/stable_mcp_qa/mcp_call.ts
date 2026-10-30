// One MCP tools/call over the real network (initialize first; stateless server). Prints JSON with status, isError and
// the head of the text content; the URL's secret segment is never printed.
// Usage: bun mcp_call.ts <url> <tool> [json-args] [--origin O]
import { safeFetch } from '../../src/safe_fetch.ts'
const [url, tool, rawArgs] = process.argv.slice(2)
if (!url || !tool) { console.error('usage: bun mcp_call.ts <url> <tool> [json-args] [--origin O]'); process.exit(2) }
const oi = process.argv.indexOf('--origin')
const origin = oi > 0 ? process.argv[oi + 1] : undefined
const args = rawArgs && !rawArgs.startsWith('--') ? JSON.parse(rawArgs) : {}
const shown = url.replace(/(https?:\/\/[^/]+\/)[^/]+(\/)/, '$1<secret>$2')
async function call(method: string, id: number, params: unknown) {
  const t0 = Date.now()
  const res = await safeFetch(url, { method: 'POST', signal: AbortSignal.timeout(60_000), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', 'user-agent': 'openai-mcp/qa-call', ...(origin ? { origin } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
  const text = await res.text()
  let body: any = text; try { body = JSON.parse(text) } catch { const m = /^data: (.*)$/m.exec(text); if (m) try { body = JSON.parse(m[1]!) } catch { /* raw */ } }
  return { status: res.status, ms: Date.now() - t0, body }
}
const init = await call('initialize', 1, { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qa-call', version: '1' } })
const r = await call('tools/call', 2, { name: tool, arguments: args })
const content = r.body?.result?.content
const text = Array.isArray(content) ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') : ''
const out = { url: shown, at: new Date().toISOString(), tool, initialize_status: init.status, status: r.status, ms: r.ms, isError: r.body?.result?.isError ?? null, rpc_error: r.body?.error ?? (typeof r.body === 'string' ? r.body.slice(0, 300) : null), text_head: text.slice(0, 600) }
console.log(JSON.stringify(out, null, 2))
process.exit(r.status === 200 && r.body?.result && !r.body.result.isError ? 0 : 1)

export {}
