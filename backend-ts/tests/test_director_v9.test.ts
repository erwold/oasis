import { expect, test } from 'bun:test'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CURRENT_DIRECTOR_TOOL_SURFACE, DIRECTOR_TOOL_SURFACES } from '@oasis-code/contract'
import { buildHttpApp } from '../src/director/app.ts'
import { Harness } from '../src/director/harness.ts'
import { buildServer } from '../src/director/server.ts'
import { composeNativeInstructions, composeTemplates, snapshotOf, surfaceDigest } from '../src/director/surfaces/index.ts'
import { cleanSchema } from '../src/llm/http.ts'
import { GOLDEN_EVENTS } from '../scripts/director_surface_snapshot.ts'
import { taskEventMessage } from '../src/director/outbox.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'

type Rec = Record<string, unknown>

async function listed(harness: Harness, audience: 'connector' | 'native') {
  const server = buildServer(harness, { surface: 'director.v9', audience, frozen: false })
  const client = new McpClient({ name: 'v9-freeze', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b); await client.connect(a)
  try { return { tools: (await client.listTools()).tools, instructions: client.getInstructions() } }
  finally { await client.close(); await server.close() }
}

test("director.v9 is its committed snapshot: v8 with connect_ssh (a host saved and connected on the person's yes in the app) and the SSH lines saying so; the native director's tools, instructions and the templates are v8's; served on /<token>/mcp/v9", async () => {
  const v9 = snapshotOf('director.v9'), v8 = snapshotOf('director.v8')
  expect(DIRECTOR_TOOL_SURFACES).toContain('director.v9')
  for (const [part, value] of Object.entries({ connector_tools: v9.connector.tools, connector_instructions: v9.connector.instructions, native_tools: v9.native.tools, native_instructions: v9.native.instructions, templates: v9.templates, golden: v9.golden })) {
    expect(surfaceDigest(value), part).toBe(v9.sha256[part]!)
  }
  const unused = Harness.connect('http://127.0.0.1:9', 'unused')
  const connector = await listed(unused, 'connector'), native = await listed(unused, 'native')
  expect(connector.tools as unknown[]).toEqual(v9.connector.tools)
  expect(connector.instructions).toBe(v9.connector.instructions)
  expect(native.tools.map((t) => ({ name: t.name, description: t.description ?? t.name, parameters_json_schema: cleanSchema(t.inputSchema) }))).toEqual(v9.native.tools)
  // frozen since director.v10: the native instructions and the templates are read from the snapshot, which v10 composes the same
  expect(composeNativeInstructions(CURRENT_DIRECTOR_TOOL_SURFACE)).toBe(v9.native.instructions)
  expect(composeTemplates(CURRENT_DIRECTOR_TOOL_SURFACE)).toEqual(v9.templates)
  expect(taskEventMessage('s_golden', GOLDEN_EVENTS as never, 'director.v9')).toBe(v9.golden.task_event_message!)
  // v8 plus one tool; ssh_directories says connect_ssh reconnects; the rest of v8's tools as they were
  expect(v9.connector.tools.map((t) => t.name)).toEqual([...v8.connector.tools.map((t) => t.name).flatMap((n) => n === 'list_ssh_targets' ? [n, 'connect_ssh'] : [n])])
  for (const tool of v9.connector.tools) if (tool.name !== 'connect_ssh' && tool.name !== 'ssh_directories') expect(tool).toEqual(v8.connector.tools.find((t) => t.name === tool.name)!)
  expect(String((v9.connector.tools.find((t) => t.name === 'ssh_directories') as Rec).description)).toContain('connect_ssh')
  expect(v9.connector.instructions).toBe(PROMPT_TEXT['connector.v7.instructions'] + '\n\n' + PROMPT_TEXT['connector.v9.remote'])
  expect(v9.native.tools).toEqual(v8.native.tools)
  expect(v9.native.instructions).toBe(v8.native.instructions)
  expect(v9.templates).toEqual(v8.templates)
  const http = buildHttpApp((_client, surface) => buildServer(unused, { surface }), 's3cret')
  const init = ((await (await http.request('http://127.0.0.1:8322/s3cret/mcp/v9', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) })).json()) as Rec).result as Rec
  expect((init.serverInfo as Rec).version).toBe('9')
  expect(init.instructions).toBe(v9.connector.instructions)
})

test("connect_ssh asks through the app's question route with the arguments as given; the call's answer is the route's", async () => {
  const calls: { method: string; path: string; body: Rec }[] = []
  const harness = new Harness('http://127.0.0.1:9', 'unused', async (input, init) => {
    const url = new URL(String(input))
    calls.push({ method: String(init?.method), path: url.pathname, body: JSON.parse(String(init?.body ?? '{}')) })
    return Response.json({ id: 'sshask_1', status: 'pending', title: 'Connect to box?', lines: ['root@box:2222'] })
  })
  const server = buildServer(harness, { surface: 'director.v9' }), client = new McpClient({ name: 'v9', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b); await client.connect(a)
  try {
    const result = await client.callTool({ name: 'connect_ssh', arguments: { destination: 'root@box', port: 2222, identity_file: '~/.ssh/id_ed25519' } })
    expect(result.isError).not.toBe(true)
    expect(calls).toEqual([{ method: 'POST', path: '/api/ssh/asks', body: { destination: 'root@box', port: 2222, identity_file: '~/.ssh/id_ed25519', wait_s: 50 } }])
    expect(JSON.stringify(result.content)).toContain('pending')
  } finally { await client.close(); await server.close() }
})
