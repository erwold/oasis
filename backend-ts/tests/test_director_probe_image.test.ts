/** The image probe at `/<token>/mcp/probe-image`: one tool whose answer is an MCP image block (a real PNG of what it
 *  drew) beside text that names neither the digits nor the colour; what it drew is in the log only. The token and
 *  the frozen surfaces' paths are as they were. No network: requests go to the Hono app. */

import { expect, test } from 'bun:test'
import { buildHttpApp } from '../src/director/app.ts'
import { Harness } from '../src/director/harness.ts'
import { buildServer } from '../src/director/server.ts'
import { measureImage } from '../src/llm/images.ts'

type Rec = Record<string, unknown>
const JSONRPC = { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28' }
const unused = () => Harness.connect('http://127.0.0.1:9', 'unused')
const app = (log: (line: string) => void) => buildHttpApp((_client, surface) => buildServer(unused(), { surface }), 's3cret', [], log)
const post = (http: ReturnType<typeof app>, path: string, body: unknown) =>
  http.request(`http://127.0.0.1:8322/${path}`, { method: 'POST', headers: JSONRPC, body: JSON.stringify(body) })

test('probe_image answers with a PNG image block of what it drew, said in the log only', async () => {
  const lines: string[] = []
  const http = app((l) => lines.push(l))
  const list = (await (await post(http, 's3cret/mcp/probe-image', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as { result: { tools: Rec[] } }
  expect(list.result.tools.map((t) => t.name)).toEqual(['probe_image'])
  const res = await post(http, 's3cret/mcp/probe-image', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'probe_image', arguments: {} } })
  expect(res.status).toBe(200)
  const content = ((await res.json()) as { result: { content: Rec[] } }).result.content
  expect(content.map((c) => c.type)).toEqual(['text', 'image'])
  expect(content[1]!.mimeType).toBe('image/png')
  const size = measureImage(new Uint8Array(Buffer.from(String(content[1]!.data), 'base64')))
  expect([size.width, size.height]).toEqual([480, 240])
  const drew = lines.find((l) => l.startsWith('[probe-image] drew '))!
  const [, digits, colour] = /drew (\d{4}) on (\w+)/.exec(drew)!
  expect(String(content[0]!.text)).not.toContain(digits!)
  expect(String(content[0]!.text)).not.toContain(colour!)
})

test('the probe takes the token like every other path', async () => {
  const res = await post(app(() => {}), 'wrong/mcp/probe-image', { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  expect(res.status).toBe(404)
})
