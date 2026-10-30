/** The director HTTP app's extensions the gateway uses, asserted as behaviour (they run against the baseline too and
 *  fail there on what they check, not on a missing module): an explicit alias `/mcp/current` that is director.v6 byte
 *  for byte, the frozen paths unchanged beside it, the same token / Host / Origin checks on the alias, and a token
 *  read on every request (a replaced one stops the old path at once). No network: requests go to the Hono app. */

import { expect, test } from 'bun:test'
import { buildHttpApp } from '../src/director/app.ts'
import { Harness } from '../src/director/harness.ts'
import { buildServer } from '../src/director/server.ts'
import { snapshotOf } from '../src/director/surfaces/index.ts'

type Rec = Record<string, unknown>
const JSONRPC = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }
const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' }
const unused = () => Harness.connect('http://127.0.0.1:9', 'unused')

function app(token: string | (() => string | null), hosts: string[] = []) {
  // the fifth argument is the extension under test; the baseline's buildHttpApp ignores it
  return (buildHttpApp as unknown as (...a: unknown[]) => { request: (u: string, i?: RequestInit) => Promise<Response> })(
    (_client: string | null, surface: never) => buildServer(unused(), { surface }), token, hosts, () => {}, { aliases: { current: 'director.v6' } })
}
const post = (http: ReturnType<typeof app>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  http.request(`http://127.0.0.1:8322${path}`, { method: 'POST', headers: { ...JSONRPC, ...headers }, body: JSON.stringify(body) })

test('/<token>/mcp/current answers initialize and tools/list exactly as /<token>/mcp/v6 (the committed director.v6 snapshot)', async () => {
  const http = app('s3cret')
  const current = await post(http, '/s3cret/mcp/current', INITIALIZE)
  expect(current.status).toBe(200)
  const v6 = await post(http, '/s3cret/mcp/v6', INITIALIZE)
  const a = (await current.json() as Rec).result as Rec
  const b = (await v6.json() as Rec).result as Rec
  expect(a).toEqual(b)
  expect((a.serverInfo as Rec).version).toBe('6')
  expect(a.instructions).toBe(snapshotOf('director.v6').connector.instructions)
  const tc = await (await post(http, '/s3cret/mcp/current', LIST)).text()
  const tv = await (await post(http, '/s3cret/mcp/v6', LIST)).text()
  expect(tc).toBe(tv)
  expect(JSON.stringify((JSON.parse(tc) as { result: { tools: unknown } }).result.tools)).toBe(JSON.stringify(snapshotOf('director.v6').connector.tools))
})

test('the frozen paths keep their own surfaces beside the alias: /mcp v1, /mcp/v2 … /mcp/v6', async () => {
  const http = app('s3cret')
  for (const [path, surface] of [['/s3cret/mcp', 'director.v1'], ['/s3cret/mcp/v2', 'director.v2'], ['/s3cret/mcp/v3', 'director.v3'], ['/s3cret/mcp/v4', 'director.v4'], ['/s3cret/mcp/v5', 'director.v5'], ['/s3cret/mcp/v6', 'director.v6']] as const) {
    const init = (await (await post(http, path, INITIALIZE)).json() as Rec).result as Rec
    expect(init.instructions, path).toBe(snapshotOf(surface).connector.instructions)
    const tools = ((await (await post(http, path, LIST)).json() as Rec).result as Rec).tools
    expect(JSON.stringify(tools), path).toBe(JSON.stringify(snapshotOf(surface).connector.tools))
  }
})

test('the alias keeps every check: wrong token 404, foreign Host 421, foreign Origin 403; the named host and its origin admitted', async () => {
  const http = app('s3cret', ['mcp.example.com'])
  expect((await post(http, '/s3cret/mcp/current', INITIALIZE)).status).toBe(200)
  expect((await post(http, '/wrong/mcp/current', INITIALIZE)).status).toBe(404)
  expect((await post(http, '/s3cre/mcp/current', INITIALIZE)).status).toBe(404)
  expect((await post(http, '/mcp/current', INITIALIZE)).status).toBe(404)
  expect((await post(http, '/s3cret/mcp/current', INITIALIZE, { host: 'evil.example' })).status).toBe(421)
  expect((await post(http, '/s3cret/mcp/current', INITIALIZE, { host: 'mcp.example.com' })).status).toBe(200)
  expect((await post(http, '/s3cret/mcp/current', INITIALIZE, { host: 'mcp.example.com', origin: 'https://evil.example' })).status).toBe(403)
  expect((await post(http, '/s3cret/mcp/current', INITIALIZE, { host: 'mcp.example.com', origin: 'https://mcp.example.com' })).status).toBe(200)
  // an unknown alias is nothing
  expect((await post(http, '/s3cret/mcp/latest', INITIALIZE)).status).toBe(404)
})

test('a token given as a function is read on every request: a replaced one stops the old path at once, none at all is 404', async () => {
  let token: string | null = 'first-secret-value-aaaaaaaaaaaaaaaaaaaa'
  const http = app(() => token)
  expect((await post(http, `/${token}/mcp/current`, INITIALIZE)).status).toBe(200)
  const old = token
  token = 'second-secret-value-bbbbbbbbbbbbbbbbbbb'
  expect((await post(http, `/${old}/mcp/current`, INITIALIZE)).status).toBe(404)
  expect((await post(http, `/${token}/mcp/current`, INITIALIZE)).status).toBe(200)
  expect((await post(http, `/${token}/mcp`, INITIALIZE)).status).toBe(200)
  token = null
  expect((await post(http, '/null/mcp/current', INITIALIZE)).status).toBe(404)
  expect((await post(http, `/${old}/mcp`, INITIALIZE)).status).toBe(404)
})

test('an alias may not shadow a frozen path or name an unknown surface', () => {
  const build = buildHttpApp as unknown as (...a: unknown[]) => unknown
  const f = (_c: string | null, surface: never) => buildServer(unused(), { surface })
  expect(() => build(f, 's3cret', [], () => {}, { aliases: { v2: 'director.v6' } })).toThrow()
  expect(() => build(f, 's3cret', [], () => {}, { aliases: { 'a/b': 'director.v6' } })).toThrow()
  expect(() => build(f, 's3cret', [], () => {}, { aliases: { current: 'director.v99' } })).toThrow()
})
