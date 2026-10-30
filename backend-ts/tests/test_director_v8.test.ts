import { expect, test } from 'bun:test'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CURRENT_DIRECTOR_TOOL_SURFACE, DIRECTOR_TOOL_SURFACES } from '@oasis-code/contract'
import { Harness } from '../src/director/harness.ts'
import { buildServer } from '../src/director/server.ts'
import { snapshotOf, surfaceDigest, composeNativeInstructions } from '../src/director/surfaces/index.ts'
import { cleanSchema } from '../src/llm/http.ts'
import { GOLDEN_EVENTS } from '../scripts/director_surface_snapshot.ts'
import { taskEventMessage } from '../src/director/outbox.ts'

async function listed(audience: 'connector' | 'native') {
  const server = buildServer(Harness.connect('http://127.0.0.1:9', 'unused'), { surface: 'director.v8', audience, frozen: false })
  const client = new McpClient({ name: 'v8-freeze', version: '1' })
  const [a,b] = InMemoryTransport.createLinkedPair()
  await server.connect(b); await client.connect(a)
  try { return { tools: (await client.listTools()).tools, instructions: client.getInstructions() } }
  finally { await client.close(); await server.close() }
}

test('v8 registry, generated tools, instructions and second-pass golden are frozen independently of v1-v7 and v9', async () => {
  const frozen = snapshotOf('director.v8')
  expect(DIRECTOR_TOOL_SURFACES).toContain('director.v8')
  expect(frozen.sha256.connector_tools).toBe('17fcfba3a00f20ea25a0b6d6de4e19b86d63b8f25a6b535fb335fbc116855315')
  expect(frozen.sha256.native_instructions).toBe('1447b4dc2268ae5f82bc251c930db862c2c1cf92279da4d6d7254da6d321face')
  for (const [key,value] of Object.entries({connector_tools:frozen.connector.tools,connector_instructions:frozen.connector.instructions,native_tools:frozen.native.tools,native_instructions:frozen.native.instructions,templates:frozen.templates,golden:frozen.golden})) expect(surfaceDigest(value)).toBe(frozen.sha256[key]!)
  const connector = await listed('connector'), native = await listed('native')
  expect(connector.tools as unknown[]).toEqual(frozen.connector.tools)
  expect(connector.instructions).toBe(frozen.connector.instructions)
  expect(native.tools.map(t => ({ name:t.name, description:t.description ?? t.name, parameters_json_schema:cleanSchema(t.inputSchema) }))).toEqual(frozen.native.tools)
  // frozen since director.v9: the native instructions are read from the snapshot, which v9 composes the same
  expect(composeNativeInstructions(CURRENT_DIRECTOR_TOOL_SURFACE)).toBe(frozen.native.instructions)
  expect(taskEventMessage('s_golden', GOLDEN_EVENTS as never, 'director.v8')).toBe(frozen.golden.task_event_message!)
  expect(frozen.connector.tools).toHaveLength(24)
  // v7's connector instructions (a session is one task) and the SSH lines after them
  expect(frozen.connector.instructions.startsWith(snapshotOf('director.v7').connector.instructions + '\n\n')).toBe(true)
  expect(frozen.connector.instructions).toContain('A session is one task')
  const old = snapshotOf('director.v6').connector.tools
  expect(old.some(t => t.name === 'list_ssh_targets')).toBe(false)
  expect(frozen.connector.tools.some(t => t.name === 'forward_port')).toBe(true)
})

test('v8 remote open_project sends target identity untouched and does not reuse same local path', async () => {
  const calls: {path:string;body:Record<string,unknown>}[]=[]
  const harness = new Harness('http://127.0.0.1:9','unused', async (input,init) => {
    const url=new URL(String(input)), body=JSON.parse(String(init?.body ?? '{}'))
    calls.push({path:url.pathname,body})
    if (init?.method === 'GET') return Response.json([{id:'local',name:'local',kind:'direct',source_path:'/same/path',target:{kind:'local'},sessions:[]}])
    return Response.json({id:'remote',name:'remote',kind:'direct',source_path:'/same/path',target:{kind:'ssh',target_id:'ssh_test'},remote:{root_id:'root',generation:'g'},sessions:[]})
  })
  const server=buildServer(harness,{surface:'director.v8'}), client=new McpClient({name:'v8',version:'1'}), [a,b]=InMemoryTransport.createLinkedPair()
  await server.connect(b); await client.connect(a)
  try {
    const result=await client.callTool({name:'open_project',arguments:{path:'/same/path',target_id:'ssh_test',mode:'direct'}})
    expect(result.isError).not.toBe(true)
    expect(calls.at(-1)!.body.target).toEqual({kind:'ssh',target_id:'ssh_test'})
    expect(calls.at(-1)!.body.source_path).toBe('/same/path')
  } finally {await client.close(); await server.close()}
})
