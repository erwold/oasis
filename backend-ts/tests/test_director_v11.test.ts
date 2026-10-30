/** director.v11: v10 whose read_file shows a connector's model a PNG, JPEG or WebP file as an MCP image block (fitted
 *  to 2048 px on its long side) instead of refusing it as binary; a remote folder's images are read up to 5 MB (other
 *  files still 2 MiB). A native director's read_file is v10's. Fixture folders only; no provider is called. */

import { afterEach, expect, test } from 'bun:test'
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CURRENT_DIRECTOR_TOOL_SURFACE, DIRECTOR_TOOL_SURFACES, type Workspace } from '@oasis-code/contract'
import { buildHttpApp } from '../src/director/app.ts'
import { Harness } from '../src/director/harness.ts'
import { buildServer } from '../src/director/server.ts'
import { composeNativeInstructions, composeTemplates, snapshotOf, surfaceDigest } from '../src/director/surfaces/index.ts'
import { cleanSchema } from '../src/llm/http.ts'
import { measureImage } from '../src/llm/images.ts'
import { GOLDEN_EVENTS } from '../scripts/director_surface_snapshot.ts'
import { taskEventMessage } from '../src/director/outbox.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import { RemoteFiles } from '../src/workspace/remote_files.ts'
import type { App } from '../src/main.ts'
import { makeApp } from './api_harness.ts'
import { tempDir } from './helpers.ts'
import { noisyPng, solidPng } from './png_fixture.ts'

type Rec = Record<string, unknown>
let app: App | null = null
const clients: McpClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  if (app) await app.close()
  app = null
})

async function listed(harness: Harness, audience: 'connector' | 'native') {
  const server = buildServer(harness, { surface: 'director.v11', audience, frozen: false })
  const client = new McpClient({ name: 'v11-freeze', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b); await client.connect(a)
  try { return { tools: (await client.listTools()).tools, instructions: client.getInstructions() } }
  finally { await client.close(); await server.close() }
}

async function directing(surface: 'director.v10' | 'director.v11'): Promise<McpClient> {
  if (!app) app = await makeApp()
  const harness = Harness.connect('http://localhost', 'test-token', { fetchImpl: (input, init) => Promise.resolve(app!.app.request(input, init)) })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await buildServer(harness, { surface }).connect(serverTransport)
  const client = new McpClient({ name: 't', version: '0' })
  await client.connect(clientTransport)
  clients.push(client)
  return client
}

test('director.v11 is its committed snapshot: v10 with read_file seeing images; everything else v10\'s; served on /<token>/mcp/v11', async () => {
  const v11 = snapshotOf('director.v11'), v10 = snapshotOf('director.v10')
  expect(CURRENT_DIRECTOR_TOOL_SURFACE).toBe('director.v11')
  expect(DIRECTOR_TOOL_SURFACES.at(-1)).toBe('director.v11')
  for (const [part, value] of Object.entries({ connector_tools: v11.connector.tools, connector_instructions: v11.connector.instructions, native_tools: v11.native.tools, native_instructions: v11.native.instructions, templates: v11.templates, golden: v11.golden })) {
    expect(surfaceDigest(value), part).toBe(v11.sha256[part]!)
  }
  const unused = Harness.connect('http://127.0.0.1:9', 'unused')
  const connector = await listed(unused, 'connector'), native = await listed(unused, 'native')
  expect(connector.tools as unknown[]).toEqual(v11.connector.tools)
  expect(connector.instructions).toBe(v11.connector.instructions)
  expect(native.tools.map((t) => ({ name: t.name, description: t.description ?? t.name, parameters_json_schema: cleanSchema(t.inputSchema) }))).toEqual(v11.native.tools)
  expect(composeNativeInstructions('director.v11')).toBe(v11.native.instructions)
  expect(composeTemplates('director.v11')).toEqual(v11.templates)
  expect(taskEventMessage('s_golden', GOLDEN_EVENTS as never, 'director.v11')).toBe(v11.golden.task_event_message!)
  // the same tools in the same order; read_file's description alone changed
  expect(v11.connector.tools.map((t) => t.name)).toEqual(v10.connector.tools.map((t) => t.name))
  for (const tool of v11.connector.tools) {
    const before = v10.connector.tools.find((t) => t.name === tool.name)!
    if (tool.name === 'read_file') expect({ ...tool, description: before.description } as Rec).toEqual(before)
    else expect(tool).toEqual(before)
  }
  expect((v11.connector.tools.find((t) => t.name === 'read_file') as Rec).description).toBe(PROMPT_TEXT['connector.v11.read_file'])
  expect(v11.connector.instructions).toBe(v10.connector.instructions)
  expect(v11.native.tools).toEqual(v10.native.tools)
  expect(v11.native.instructions).toBe(v10.native.instructions)
  expect(v11.templates).toEqual(v10.templates)
  const http = buildHttpApp((_client, surface) => buildServer(unused, { surface }), 's3cret')
  const init = ((await (await http.request('http://127.0.0.1:8322/s3cret/mcp/v11', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) })).json()) as Rec).result as Rec
  expect((init.serverInfo as Rec).version).toBe('11')
})

test('v11 read_file: an image is an MCP image block fitted to 2048 px after its text (path, size, what was sent); a small one goes as it is; text and other binaries as before; v10 still refuses an image', async () => {
  const dir = realpathSync(tempDir())
  writeFileSync(join(dir, 'wide.png'), solidPng(3000, 1500, [20, 140, 40]))
  writeFileSync(join(dir, 'huge.png'), noisyPng(1400, 1400))
  writeFileSync(join(dir, 'small.png'), solidPng(64, 32, [200, 30, 30]))
  writeFileSync(join(dir, 'notes.txt'), 'one\ntwo\n')
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 0, 255, 254]))
  const v11 = await directing('director.v11')
  const project = (await v11.callTool({ name: 'open_project', arguments: { path: dir } })).structuredContent as Rec
  const session = (await v11.callTool({ name: 'create_session', arguments: { project_id: project.id, title: 'images', model: 'scripted:a' } })).structuredContent as Rec
  const ws = String(session.workspace_id)
  const read = (path: string, c = v11) => c.callTool({ name: 'read_file', arguments: { workspace_id: ws, path } })

  const wide = await read('wide.png')
  expect(wide.isError, JSON.stringify(wide.content).slice(0, 300)).toBeFalsy()
  const [text, image] = wide.content as Rec[]
  expect([text!.type, image!.type, image!.mimeType]).toEqual(['text', 'image', 'image/png'])
  const seen = JSON.parse(String(text!.text)) as Rec
  expect([seen.path, seen.kind, seen.width, seen.height]).toEqual(['wide.png', 'image', 3000, 1500])
  const sent = measureImage(new Uint8Array(Buffer.from(String(image!.data), 'base64')))
  expect([sent.width, sent.height]).toEqual([2048, 1024])
  expect(seen.sent).toEqual({ media_type: 'image/png', width: 2048, height: 1024, bytes: Buffer.from(String(image!.data), 'base64').length })
  expect(String(text!.text)).not.toContain(String(image!.data).slice(0, 40))

  const small = await read('small.png')
  const smallBytes = Buffer.from(String((small.content as Rec[])[1]!.data), 'base64')
  expect(createHash('sha256').update(smallBytes).digest('hex')).toBe(createHash('sha256').update(solidPng(64, 32, [200, 30, 30])).digest('hex'))

  // over the 5 MB an image is read up to: said, nothing sent
  const huge = await read('huge.png')
  expect(huge.isError).toBe(true)
  expect(String((huge.content as Rec[])[0]!.text)).toContain('images are read up to 5 MB')

  const notes = await read('notes.txt')
  expect((notes.structuredContent as Rec).content).toBe('1\tone\n2\ttwo')
  const blob = await read('blob.bin')
  expect(blob.isError).toBe(true)
  expect(String((blob.content as Rec[])[0]!.text)).toContain('not a PNG, JPEG or WebP image')

  const v10 = await directing('director.v10')
  const refused = await read('wide.png', v10)
  expect(refused.isError).toBe(true)
  expect(String((refused.content as Rec[])[0]!.text)).toContain('binary')
})

test('a remote folder\'s image is read up to 5 MB (its first bytes say it is one); any other file over 2 MiB is refused as before', async () => {
  const ws = { id: 'ws_r', path: '/srv/p', target: { kind: 'ssh', target_id: 't_1' }, remote: { target_id: 't_1', path: '/srv/p', state_path: '/srv/p/.oasis-remote' } } as unknown as Workspace
  const fileOf: Record<string, Buffer> = {}
  const request = async (_root: unknown, method: string, p: Rec) => {
    if (method === 'files.resolve') return { path: p.path, absolute_path: `/srv/p/${String(p.path)}` }
    const data = fileOf[String(p.path)]!
    if (method === 'files.stat') return { kind: 'file', size: data.length, sha256: createHash('sha256').update(data).digest('hex') }
    if (method === 'files.read') {
      const from = Number(p.byte_offset), page = data.subarray(from, from + Number(p.limit))
      return { data: page.toString('base64'), next_offset: from + page.length, eof: from + page.length >= data.length }
    }
    throw new Error(method)
  }
  const files = new RemoteFiles({ request, conn: null, policy: { settle_ms: 0 } } as never)
  const png = Buffer.concat([Buffer.from(solidPng(8, 8, [1, 2, 3])), Buffer.alloc(3 * 1024 * 1024)])
  fileOf['big.png'] = png
  fileOf['big.txt'] = Buffer.alloc(3 * 1024 * 1024, 'a')
  expect((await files.raw(ws, 'big.png', 5 * 1024 * 1024)).length).toBe(png.length)
  await expect(files.raw(ws, 'big.png')).rejects.toThrow('up to 2 MiB')
  await expect(files.raw(ws, 'big.txt', 5 * 1024 * 1024)).rejects.toThrow('up to 2 MiB, and PNG, JPEG or WebP images up to 5 MB')
  fileOf['huge.png'] = Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)])
  await expect(files.raw(ws, 'huge.png', 5 * 1024 * 1024)).rejects.toThrow('images up to 5 MB')
})
