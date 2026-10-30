/** A client of a published protocol version newer than the SDK knows (2026-07-28, stateless: no initialize, its version in a
 *  header on every request) is answered, not refused with a 400 for the header: on a new ChatGPT conversation that
 *  client does not fall back to the older handshake, so the refusal was the connector failing outright. A known
 *  version and a request without one are as they were. No network: requests go to the Hono app. */

import { expect, test } from 'bun:test'
import { buildHttpApp, withKnownProtocolVersion } from '../src/director/app.ts'
import { Harness } from '../src/director/harness.ts'
import { buildServer } from '../src/director/server.ts'
import { snapshotOf } from '../src/director/surfaces/index.ts'

type Rec = Record<string, unknown>
const JSONRPC = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' }
const unused = () => Harness.connect('http://127.0.0.1:9', 'unused')

function app(log: (line: string) => void = () => {}) {
  return buildHttpApp((_client, surface) => buildServer(unused(), { surface }), 's3cret', [], log, { aliases: { current: 'director.v6' } })
}
const post = (http: ReturnType<typeof app>, body: unknown, headers: Record<string, string> = {}) =>
  http.request('http://127.0.0.1:8322/s3cret/mcp/current', { method: 'POST', headers: { ...JSONRPC, ...headers }, body: JSON.stringify(body) })

test('tools/list with no initialize and the 2026-07-28 header is answered with the surface\'s tools, nothing logged as refused', async () => {
  const lines: string[] = []
  const res = await post(app((l) => lines.push(l)), LIST, { 'mcp-protocol-version': '2026-07-28' })
  expect(res.status).toBe(200)
  const tools = (JSON.parse(await res.text()) as { result: { tools: unknown } }).result.tools
  expect(JSON.stringify(tools)).toBe(JSON.stringify(snapshotOf('director.v6').connector.tools))
  expect(lines.filter((l) => l.includes('refused'))).toEqual([])
})

test('a known version, and no version header at all, are handed on unchanged and answered as before', async () => {
  const http = app()
  for (const headers of [{ 'mcp-protocol-version': '2025-06-18' }, {}] as Record<string, string>[]) {
    const res = await post(http, LIST, headers)
    expect(res.status).toBe(200)
    expect(((await res.json()) as Rec).result).toBeDefined()
  }
  const kept = new Request('http://x/', { method: 'POST', headers: { 'mcp-protocol-version': '2025-06-18' }, body: '{}' })
  expect(withKnownProtocolVersion(kept)).toBe(kept)
  const bare = new Request('http://x/', { method: 'POST', body: '{}' })
  expect(withKnownProtocolVersion(bare)).toBe(bare)
})

test('any other unknown version is still refused with a 400, and logged with its reason, as the specification asks', async () => {
  const lines: string[] = []
  const res = await post(app((l) => lines.push(l)), LIST, { 'mcp-protocol-version': '2099-01-01' })
  expect(res.status).toBe(400)
  expect(lines.some((l) => l.includes('Unsupported protocol version: 2099-01-01'))).toBe(true)
  const odd = new Request('http://x/', { method: 'POST', headers: { 'mcp-protocol-version': '2099-01-01' }, body: '{}' })
  expect(withKnownProtocolVersion(odd)).toBe(odd)
})

test('an unknown version loses only its version header: the body, method and other headers go on', async () => {
  const req = new Request('http://x/p', { method: 'POST', headers: { 'mcp-protocol-version': '2026-07-28', 'user-agent': 'openai-mcp/1.0.0', ...JSONRPC }, body: JSON.stringify(LIST) })
  const out = withKnownProtocolVersion(req)
  expect(out.headers.get('mcp-protocol-version')).toBeNull()
  expect(out.headers.get('user-agent')).toBe('openai-mcp/1.0.0')
  expect(out.method).toBe('POST')
  expect(JSON.parse(await out.text())).toEqual(LIST)
})
