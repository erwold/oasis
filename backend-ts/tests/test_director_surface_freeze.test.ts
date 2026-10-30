/** The director tool surfaces are frozen per conversation. director.v1 is the bytes of main 3d06c7b (the snapshot was
 *  generated from the baseline's git objects; its sha256 values are the ones docs/multi-agent-director-plan.md §2.2
 *  measured there): a director session from before surfaces — a row whose config names none — gets exactly those
 *  tools, schemas, descriptions and instructions on every request, across turns, a compaction, a change of route and a
 *  restart. director.v2 is its own committed snapshot (what the code registers must equal it: a change is a new
 *  surface), which a new director session holds across config and model edits; a client cannot set or change the
 *  surface. The connector serves v1 on /<token>/mcp and v2 on /<token>/mcp/v2. Scripted models only, no network. */

import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CURRENT_DIRECTOR_TOOL_SURFACE, ScheduleNodeSchema, z, type DirectorDetail, type DirectorTurn } from '@oasis-code/contract'
import { buildHttpApp } from '../src/director/app.ts'
import { Harness } from '../src/director/harness.ts'
import { NATIVE_INSTRUCTIONS, SERVER_INSTRUCTIONS } from '../src/director/manual.ts'
import { taskEventMessage, personRunsMessage } from '../src/director/outbox.ts'
import { buildServer } from '../src/director/server.ts'
import * as store from '../src/director/store.ts'
import { NATIVE_EXCLUDED_BY_SURFACE, snapshotOf, surfaceDigest, WRITE_TOOLS, type SurfaceSnapshot } from '../src/director/surfaces/index.ts'
import { cleanSchema } from '../src/llm/http.ts'
import { modelResponse, textPart, type ModelMessage } from '../src/llm/messages.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import type { App } from '../src/main.ts'
import { GOLDEN_EVENTS } from '../scripts/director_surface_snapshot.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { asLegacyV1 } from './director_surface_fixtures.ts'
import { buggyRepo, scriptedModel, setModel, sleep, testSettings } from './harness.ts'

type Rec = Record<string, unknown>
let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

const sha = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')

async function listed(server: ReturnType<typeof buildServer>): Promise<{ tools: Rec[]; instructions: string }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new McpClient({ name: 'freeze', version: '1' })
  await client.connect(clientSide)
  const { tools } = await client.listTools()
  const instructions = client.getInstructions() ?? ''
  await client.close()
  await server.close()
  return { tools: tools as Rec[], instructions }
}
const unusedHarness = () => Harness.connect('http://127.0.0.1:9', 'unused')
const nativeOf = (tools: Rec[]) => tools.map((t) => ({ name: t.name, description: t.description ?? t.name, parameters_json_schema: cleanSchema((t.inputSchema ?? { type: 'object', properties: {} }) as Rec) }))

// ---- the snapshots ------------------------------------------------------------------------------------------------

test('director.v1 is the baseline bytes: the plan\'s measured sha256 values, 18 connector tools, 11 native, the frozen instructions', async () => {
  const v1 = snapshotOf('director.v1')
  // measured on main 3d06c7b with the baseline's own code (docs/multi-agent-director-plan.md §2.2)
  expect(sha(v1.connector.tools)).toBe('b25e8f63457c19650bc165b4defb26f6d6f0ae22de12068dbe23f211b3b71186')
  expect(sha(v1.connector.instructions)).toBe('083b7bc4bd90e31c0c0857c8e61acf653e38805a1a212cca74be4ef15c6d9550')
  expect(sha(v1.native.tools)).toBe('a35991c1bef7514b5bd623c3d361f0d5353c6f8dd7c8e1d31853acb66d6bf8ff')
  expect(sha(v1.native.instructions)).toBe('56324c0e94b337c49cf9d527c62439ee6263fe2191d90efb54dbf53f10521034')
  for (const [part, value] of Object.entries({ connector_tools: v1.connector.tools, connector_instructions: v1.connector.instructions, native_tools: v1.native.tools, native_instructions: v1.native.instructions, templates: v1.templates, golden: v1.golden })) {
    expect(surfaceDigest(value), part).toBe(v1.sha256[part]!)
  }
  expect(v1.connector.tools).toHaveLength(18)
  expect(v1.native.tools.map((t) => t.name)).toEqual(['list_models', 'set_project_config', 'get_session', 'start_run', 'get_run', 'cancel_run', 'get_workspace', 'read_file', 'start_interaction', 'schedule', 'integrate'])
  // the exported texts are the snapshot's (the contract test pins them by digest too)
  expect(v1.native.instructions).toBe(NATIVE_INSTRUCTIONS)
  expect(v1.connector.instructions).toBe(SERVER_INSTRUCTIONS)
  // what the v1 code registers today is still the snapshot (served from the snapshot either way)
  const generated = await listed(buildServer(unusedHarness(), { surface: 'director.v1', frozen: false }))
  expect(generated.tools).toEqual(v1.connector.tools)
  expect(nativeOf(generated.tools.filter((t) => !NATIVE_EXCLUDED_BY_SURFACE['director.v1'].has(String(t.name))))).toEqual(v1.native.tools)
  // the harness-written texts of a v1 conversation are the baseline's, rendered as the baseline rendered them
  expect(taskEventMessage('s_golden', GOLDEN_EVENTS as never)).toBe(v1.golden.task_event_message!)
  expect(personRunsMessage(GOLDEN_EVENTS.slice(0, 1) as never)).toBe(v1.golden.person_runs_message!)
  for (const [key, value] of Object.entries(v1.templates)) if (key in PROMPT_TEXT) expect(PROMPT_TEXT[key as keyof typeof PROMPT_TEXT] as string, key).toBe(value)
})

test('director.v2 is its committed snapshot: what the code registers equals it, 20 connector tools and 14 native', async () => {
  const v2 = snapshotOf('director.v2')
  for (const [part, value] of Object.entries({ connector_tools: v2.connector.tools, connector_instructions: v2.connector.instructions, native_tools: v2.native.tools, native_instructions: v2.native.instructions, templates: v2.templates, golden: v2.golden })) {
    expect(surfaceDigest(value), part).toBe(v2.sha256[part]!)
  }
  const connector = await listed(buildServer(unusedHarness(), { surface: 'director.v2', audience: 'connector', frozen: false }))
  const native = await listed(buildServer(unusedHarness(), { surface: 'director.v2', audience: 'native', frozen: false }))
  expect(connector.tools).toEqual(v2.connector.tools)
  expect(connector.instructions).toBe(v2.connector.instructions)
  expect(nativeOf(native.tools)).toEqual(v2.native.tools)
  expect(v2.native.instructions).toBe(PROMPT_TEXT['director.v2.native'])
  expect(v2.connector.tools.map((t) => t.name).sort()).toEqual(['attach_image', 'bash', 'cancel_run', 'create_session', 'current_session', 'get_collaboration', 'get_run', 'get_session', 'get_workspace',
    'integrate', 'list_models', 'list_projects', 'open_project', 'post_director_note', 'read_file', 'schedule', 'set_project_config', 'start_interaction', 'start_relay', 'start_run'])
  expect(v2.native.tools.map((t) => t.name).sort()).toEqual(['cancel_run', 'create_session', 'get_collaboration', 'get_run', 'get_session', 'get_workspace', 'integrate', 'list_models',
    'read_file', 'schedule', 'set_project_config', 'start_interaction', 'start_relay', 'start_run'])
  expect(taskEventMessage('s_golden', GOLDEN_EVENTS as never, 'director.v2')).toBe(v2.golden.task_event_message!)
  // the native get_run has no wait at all; the connector's keeps its objective limit
  const nativeGetRun = v2.native.tools.find((t) => t.name === 'get_run')!
  expect(Object.keys(nativeGetRun.parameters_json_schema.properties as Rec)).toEqual(['run_id', 'view', 'cursor'])
  const connectorGetRun = v2.connector.tools.find((t) => t.name === 'get_run')! as { inputSchema: { properties: Rec } }
  expect(Object.keys(connectorGetRun.inputSchema.properties)).toContain('wait_s')
  // a report-only turn refuses every native tool that starts or changes something, the new ones included
  const nativeNames = new Set(v2.native.tools.map((t) => t.name))
  const writing = v2.connector.tools.filter((t) => nativeNames.has(String(t.name)) && (t.annotations as Rec).readOnlyHint === false).map((t) => String(t.name)).sort()
  expect(writing).toEqual(['cancel_run', 'create_session', 'integrate', 'schedule', 'set_project_config', 'start_interaction', 'start_relay', 'start_run'])
  for (const name of writing) expect(WRITE_TOOLS.has(name), name).toBe(true)
})

test('director.v3 is its committed snapshot: what the code registers equals it — v2 with steer_run, a follow-up out of the budget, the same harness texts', async () => {
  const v3 = snapshotOf('director.v3')
  const v2 = snapshotOf('director.v2')
  for (const [part, value] of Object.entries({ connector_tools: v3.connector.tools, connector_instructions: v3.connector.instructions, native_tools: v3.native.tools, native_instructions: v3.native.instructions, templates: v3.templates, golden: v3.golden })) {
    expect(surfaceDigest(value), part).toBe(v3.sha256[part]!)
  }
  const connector = await listed(buildServer(unusedHarness(), { surface: 'director.v3', audience: 'connector', frozen: false }))
  const native = await listed(buildServer(unusedHarness(), { surface: 'director.v3', audience: 'native', frozen: false }))
  expect(connector.tools).toEqual(v3.connector.tools)
  expect(connector.instructions).toBe(v3.connector.instructions)
  expect(nativeOf(native.tools)).toEqual(v3.native.tools)
  expect(v3.native.instructions).toBe(PROMPT_TEXT['director.v3.native'])
  expect(v3.connector.tools).toHaveLength(21)
  expect(v3.native.tools).toHaveLength(15)
  // v2's tools, each as v2 has it, but start_run's resume_run_id; and steer_run beside them, for both audiences
  const names = (tools: readonly { name?: unknown }[]) => tools.map((t) => String(t.name))
  expect(names(v3.connector.tools).filter((n) => n !== 'steer_run')).toEqual(names(v2.connector.tools))
  expect(names(v3.native.tools).filter((n) => n !== 'steer_run')).toEqual(names(v2.native.tools))
  for (const t of v3.connector.tools) {
    if (t.name === 'steer_run' || t.name === 'start_run') continue
    expect(JSON.stringify(t), String(t.name)).toBe(JSON.stringify(v2.connector.tools.find((x) => x.name === t.name)))
  }
  const resume = (snap: SurfaceSnapshot) => String(((snap.connector.tools.find((t) => t.name === 'start_run') as { inputSchema: { properties: Rec } }).inputSchema.properties.resume_run_id as Rec).description)
  expect(resume(v2)).toContain('counted in its budget')
  expect(resume(v3)).toContain('not counted in its budget')
  const steer = v3.connector.tools.find((t) => t.name === 'steer_run') as { inputSchema: { properties: Rec; required?: string[] }; annotations: Rec }
  expect(Object.keys(steer.inputSchema.properties).sort()).toEqual(['request_id', 'run_id', 'text'])
  expect(steer.annotations.readOnlyHint).toBe(false)
  expect(WRITE_TOOLS.has('steer_run')).toBe(true)
  // the harness-written texts of a conversation are v2's, and so is a task event's rendering
  expect(v3.templates).toEqual(v2.templates)
  expect(v3.golden).toEqual(v2.golden)
  expect(v3.connector.instructions).toContain('steer_run')
  expect(v3.native.instructions).toContain('steer_run')
})

test('the v1 schedule node is frozen without cites; v2 schedule and start_run name cited runs and handed-over answers', () => {
  const v1Node = z.toJSONSchema(ScheduleNodeSchema) as { properties: Rec }
  expect(Object.keys(v1Node.properties)).not.toContain('cites')
  expect(Object.keys(v1Node.properties)).not.toContain('receive_runs')
  const schemaOf = (snap: SurfaceSnapshot, name: string) => snap.native.tools.find((t) => t.name === name)!.parameters_json_schema as { properties: Rec }
  const v1Schedule = JSON.stringify(schemaOf(snapshotOf('director.v1'), 'schedule'))
  expect(v1Schedule).not.toContain('cites')
  expect(v1Schedule).not.toContain('receive_runs')
  const v2Schedule = JSON.stringify(schemaOf(snapshotOf('director.v2'), 'schedule'))
  expect(v2Schedule).toContain('"cites"')
  expect(v2Schedule).toContain('"receive_runs"')
  const v2Start = schemaOf(snapshotOf('director.v2'), 'start_run')
  expect(Object.keys(v2Start.properties)).toEqual(expect.arrayContaining(['cites', 'receive_run_ids', 'source_turn_id', 'separate', 'resume_run_id', 'expected_head_run_id']))
  const v1Start = schemaOf(snapshotOf('director.v1'), 'start_run')
  expect(Object.keys(v1Start.properties)).not.toContain('cites')
  expect(Object.keys(v1Start.properties)).not.toContain('receive_run_ids')
})

/** v2 says what tools do and their limits: no example, no default headcount, no role or routing instruction. */
test('director.v4 is its committed snapshot: v3 with one change — a note posted to a thread says how the thread renders it', async () => {
  const v4 = snapshotOf('director.v4')
  const v3 = snapshotOf('director.v3')
  for (const [part, value] of Object.entries({ connector_tools: v4.connector.tools, connector_instructions: v4.connector.instructions, native_tools: v4.native.tools, native_instructions: v4.native.instructions, templates: v4.templates, golden: v4.golden })) {
    expect(surfaceDigest(value), part).toBe(v4.sha256[part]!)
  }
  const connector = await listed(buildServer(unusedHarness(), { surface: 'director.v4', audience: 'connector', frozen: false }))
  const native = await listed(buildServer(unusedHarness(), { surface: 'director.v4', audience: 'native', frozen: false }))
  expect(connector.tools).toEqual(v4.connector.tools)
  expect(connector.instructions).toBe(v4.connector.instructions)
  expect(nativeOf(native.tools)).toEqual(v4.native.tools)
  // every tool as v3 has it but post_director_note, whose description now says Markdown and LaTeX math
  for (const t of v4.connector.tools) {
    const before = v3.connector.tools.find((x) => x.name === t.name)
    if (t.name === 'post_director_note') {
      expect(String(t.description)).toBe(PROMPT_TEXT['connector.v4.post_director_note'])
      expect(String(t.description)).toContain('$…$')
      expect(JSON.stringify({ ...t, description: null })).toBe(JSON.stringify({ ...before, description: null }))
    } else expect(JSON.stringify(t), String(t.name)).toBe(JSON.stringify(before))
  }
  expect(v4.connector.tools.map((t) => t.name)).toEqual(v3.connector.tools.map((t) => t.name))
  expect(v4.connector.instructions).toBe(v3.connector.instructions)
  expect(v4.native.tools).toEqual(v3.native.tools)
  expect(v4.native.instructions).toBe(v3.native.instructions)
  expect(v4.templates).toEqual(v3.templates)
})

test("director.v5 is its committed snapshot: v4 asking the connector's client (ChatGPT on the web) to record its final answer in the thread, at the person's request; a native director's surface is v4's", async () => {
  const v5 = snapshotOf('director.v5')
  const v4 = snapshotOf('director.v4')
  for (const [part, value] of Object.entries({ connector_tools: v5.connector.tools, connector_instructions: v5.connector.instructions, native_tools: v5.native.tools, native_instructions: v5.native.instructions, templates: v5.templates, golden: v5.golden })) {
    expect(surfaceDigest(value), part).toBe(v5.sha256[part]!)
  }
  const connector = await listed(buildServer(unusedHarness(), { surface: 'director.v5', audience: 'connector', frozen: false }))
  const native = await listed(buildServer(unusedHarness(), { surface: 'director.v5', audience: 'native', frozen: false }))
  expect(connector.tools).toEqual(v5.connector.tools)
  expect(connector.instructions).toBe(v5.connector.instructions)
  expect(nativeOf(native.tools)).toEqual(v5.native.tools)
  // the person's request, said once in the instructions and once on the tool it names; nothing else of v4 changes
  const ask = "When this chat's final answer to the user's request is written, record the request and that answer in the session's thread"
  expect(v5.connector.instructions).toBe(`${v4.connector.instructions}\n\n${ask} with post_director_note: the user follows the session in oasis-code.`)
  for (const t of v5.connector.tools) {
    const before = v4.connector.tools.find((x) => x.name === t.name)
    if (t.name === 'post_director_note') {
      expect(String(t.description)).toBe(`${String(before!.description)} ${ask} with it.`)
      expect(JSON.stringify({ ...t, description: null })).toBe(JSON.stringify({ ...before, description: null }))
    } else expect(JSON.stringify(t), String(t.name)).toBe(JSON.stringify(before))
  }
  expect(v5.connector.tools.map((t) => t.name)).toEqual(v4.connector.tools.map((t) => t.name))
  expect(v5.native.tools).toEqual(v4.native.tools)
  expect(v5.native.instructions).toBe(v4.native.instructions)
  expect(v5.templates).toEqual(v4.templates)
})

test('director.v6 is its committed snapshot: v5 with commands under the session\'s access, a task across sessions and folders (open_project by folder and kind, create_directory, no_folder; create_session task_session_id and roots; receive_run_ids across sessions; bash read_only; get_run waiting); every other tool as v5 has it; served on /<token>/mcp/v6', async () => {
  const v6 = snapshotOf('director.v6')
  const v5 = snapshotOf('director.v5')
  for (const [part, value] of Object.entries({ connector_tools: v6.connector.tools, connector_instructions: v6.connector.instructions, native_tools: v6.native.tools, native_instructions: v6.native.instructions, templates: v6.templates, golden: v6.golden })) {
    expect(surfaceDigest(value), part).toBe(v6.sha256[part]!)
  }
  const connector = await listed(buildServer(unusedHarness(), { surface: 'director.v6', audience: 'connector', frozen: false }))
  const native = await listed(buildServer(unusedHarness(), { surface: 'director.v6', audience: 'native', frozen: false }))
  expect(connector.tools).toEqual(v6.connector.tools)
  expect(connector.instructions).toBe(v6.connector.instructions)
  expect(nativeOf(native.tools)).toEqual(v6.native.tools)
  // the connector's instructions say a session is a working folder (with roots), the sessions of a task linked across
  // projects; the native director's instructions, the harness-written texts and their rendering stay v5's
  expect(v6.connector.instructions).toBe(PROMPT_TEXT['connector.v6.instructions'])
  expect(v6.connector.instructions).not.toBe(v5.connector.instructions)
  expect(v5.connector.instructions).toContain('A session is one task')
  expect(v6.connector.instructions).not.toContain('A session is one task')
  expect(v6.native.instructions).toBe(v5.native.instructions)
  expect(v6.templates).toEqual(v5.templates)
  expect(v6.golden).toEqual(v5.golden)
  // the same tools in the same order; the ones v6 changed, and only those, differ from v5
  const changed = ['open_project', 'create_session', 'get_session', 'start_run', 'start_relay', 'get_run', 'get_workspace', 'bash', 'start_interaction']
  expect(v6.connector.tools.map((t) => t.name)).toEqual(v5.connector.tools.map((t) => t.name))
  expect(v6.native.tools.map((t) => t.name)).toEqual(v5.native.tools.map((t) => t.name))
  for (const t of v6.connector.tools) {
    const before = v5.connector.tools.find((x) => x.name === t.name)!
    if (!changed.includes(String(t.name))) { expect(JSON.stringify(t), String(t.name)).toBe(JSON.stringify(before)); continue }
    expect(JSON.stringify(t), String(t.name)).not.toBe(JSON.stringify(before))
  }
  for (const t of v6.native.tools) {
    const before = v5.native.tools.find((x) => x.name === t.name)!
    if (!changed.includes(String(t.name))) expect(JSON.stringify(t), String(t.name)).toBe(JSON.stringify(before))
  }
  const props = (snap: SurfaceSnapshot, name: string) => Object.keys(((snap.connector.tools.find((t) => t.name === name) as { inputSchema: { properties: Rec } }).inputSchema.properties))
  const bash = v6.connector.tools.find((t) => t.name === 'bash')!
  expect(String(bash.description)).toBe(PROMPT_TEXT['connector.v6.bash'])
  expect(String(v5.connector.tools.find((t) => t.name === 'bash')!.description)).toContain('sandboxed as an agent\'s command is')
  expect(props(v6, 'bash')).toEqual(['workspace_id', 'session_id', ...props(v5, 'bash').filter((k) => k !== 'workspace_id'), 'read_only'])
  expect(props(v6, 'open_project')).toEqual([...props(v5, 'open_project').filter((k) => k !== 'request_id'), 'create_directory', 'no_folder', 'request_id'])
  expect(((v6.connector.tools.find((t) => t.name === 'open_project') as { inputSchema: { required?: string[] } }).inputSchema.required ?? [])).not.toContain('path')
  expect(props(v6, 'create_session')).toEqual([...props(v5, 'create_session'), 'task_session_id', 'roots'])
  for (const name of ['start_run', 'start_relay']) {
    expect(props(v6, name), name).toEqual(props(v5, name))
    const receive = ((v6.connector.tools.find((t) => t.name === name) as { inputSchema: { properties: Rec } }).inputSchema.properties.receive_run_ids as Rec).description
    expect(String(receive)).toBe(PROMPT_TEXT['connector_parameter.v6.common.receive_run_ids'])
  }
  // served on its own path, v1–v5 on theirs as before
  const http = buildHttpApp((_client, surface) => buildServer(unusedHarness(), { surface }), 's3cret')
  const post = async (path: string, body: unknown) => (await http.request(`http://127.0.0.1:8322${path}`, { method: 'POST', headers: JSONRPC, body: JSON.stringify(body) })).json() as Promise<Rec>
  for (const [path, surface] of [['/s3cret/mcp/v5', 'director.v5'], ['/s3cret/mcp/v6', 'director.v6']] as const) {
    const init = (await post(path, INITIALIZE)).result as Rec
    expect((init.serverInfo as Rec).version, path).toBe(surface.slice(-1))
    expect(init.instructions, path).toBe(snapshotOf(surface).connector.instructions)
    const tools = ((await post(path, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).result as Rec).tools
    expect(JSON.stringify(tools), path).toBe(JSON.stringify(snapshotOf(surface).connector.tools))
  }
  // every v6 text the model reads states capabilities, mechanisms and limits only
  for (const text of [v6.connector.instructions, ...[...v6.connector.tools, ...v6.native.tools].map((t) => JSON.stringify(t))]) {
    for (const pattern of FORBIDDEN) expect(pattern.test(text), `${String(pattern)} in ${text.slice(0, 80)}`).toBe(false)
  }
})

test('director.v7 is its committed snapshot: v6 whose connector instructions say a session is one task again (task_session_id only links a session into another\'s task); every tool, the native director\'s instructions and the harness-written texts as v6 has them; served on /<token>/mcp/v7', async () => {
  const v7 = snapshotOf('director.v7')
  const v6 = snapshotOf('director.v6')
  for (const [part, value] of Object.entries({ connector_tools: v7.connector.tools, connector_instructions: v7.connector.instructions, native_tools: v7.native.tools, native_instructions: v7.native.instructions, templates: v7.templates, golden: v7.golden })) {
    expect(surfaceDigest(value), part).toBe(v7.sha256[part]!)
  }
  const connector = await listed(buildServer(unusedHarness(), { surface: 'director.v7', audience: 'connector', frozen: false }))
  const native = await listed(buildServer(unusedHarness(), { surface: 'director.v7', audience: 'native', frozen: false }))
  expect(connector.tools).toEqual(v7.connector.tools)
  expect(connector.instructions).toBe(v7.connector.instructions)
  expect(nativeOf(native.tools)).toEqual(v7.native.tools)
  expect(v7.connector.instructions).toBe(PROMPT_TEXT['connector.v7.instructions'])
  expect(v7.connector.instructions).toContain('A session is one task')
  expect(v7.connector.instructions).not.toContain('The sessions of one task are linked')
  expect(v7.connector.instructions).toContain('task_session_id')
  expect(v7.connector.tools).toEqual(v6.connector.tools)
  expect(v7.native.tools).toEqual(v6.native.tools)
  expect(v7.native.instructions).toBe(v6.native.instructions)
  expect(v7.templates).toEqual(v6.templates)
  expect(v7.golden).toEqual(v6.golden)
  const http = buildHttpApp((_client, surface) => buildServer(unusedHarness(), { surface }), 's3cret')
  const init = ((await (await http.request('http://127.0.0.1:8322/s3cret/mcp/v7', { method: 'POST', headers: JSONRPC, body: JSON.stringify(INITIALIZE) })).json()) as Rec).result as Rec
  expect((init.serverInfo as Rec).version).toBe('7')
  expect(init.instructions).toBe(v7.connector.instructions)
  for (const pattern of FORBIDDEN) expect(pattern.test(v7.connector.instructions), String(pattern)).toBe(false)
})

const FORBIDDEN = [/\be\.g\./i, /for example/i, /such as/i, /例如/, /比如/, /You are the router/i, /not a participant and not an author/i, /Use start_run when/i, /Do not wait for runs/i,
  /never an angle, a position/i, /Answer in the user's language/i, /Reuse an existing project unless/i, /work there and answer in this chat/i, /Never a position/i, /\byou decide only\b/i, /\bshould\b/i, /GPT-6 Pro/]
for (const surface of ['director.v2', 'director.v3', 'director.v4'] as const) test(`every ${surface} text the model reads states capabilities, mechanisms and limits only`, () => {
  const v2 = snapshotOf(surface)
  const texts: [string, string][] = [['native.instructions', v2.native.instructions], ['connector.instructions', v2.connector.instructions], ...Object.entries(v2.templates).map(([k, v]) => [`template ${k}`, v] as [string, string])]
  const walk = (where: string, value: unknown) => {
    if (typeof value === 'string') { texts.push([where, value]); return }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(`${where}[${i}]`, v)); return }
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value as Rec)) if (k === 'description' || typeof v === 'object') walk(`${where}.${k}`, v)
  }
  walk('connector', v2.connector.tools)
  walk('native', v2.native.tools)
  expect(texts.length).toBeGreaterThan(100)
  for (const [where, text] of texts) for (const pattern of FORBIDDEN) expect(pattern.test(text), `${where}: ${pattern} in ${text.slice(0, 120)}`).toBe(false)
  // and it does not carry v1's routing paragraphs, extended or not
  for (const v1Key of ['director.manual', 'director.native', 'director.native_interactions', 'director.native_routing'] as const) expect(v2.native.instructions).not.toContain(PROMPT_TEXT[v1Key].slice(0, 60))
})

// ---- the connector endpoints --------------------------------------------------------------------------------------

const JSONRPC = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }
const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }

test('the connector serves director.v1 on /<token>/mcp, director.v2 on /<token>/mcp/v2, director.v3 on /<token>/mcp/v3, director.v4 on /<token>/mcp/v4 and director.v5 on /<token>/mcp/v5, each its snapshot byte for byte', async () => {
  const seenSurfaces: string[] = []
  const http = buildHttpApp((client, surface) => { seenSurfaces.push(surface); return buildServer(unusedHarness(), { surface }) }, 's3cret')
  const post = async (path: string, body: unknown) => (await http.request(`http://127.0.0.1:8322${path}`, { method: 'POST', headers: JSONRPC, body: JSON.stringify(body) })).json() as Promise<Rec>
  for (const [path, surface] of [['/s3cret/mcp', 'director.v1'], ['/s3cret/mcp/v2', 'director.v2'], ['/s3cret/mcp/v3', 'director.v3'], ['/s3cret/mcp/v4', 'director.v4'], ['/s3cret/mcp/v5', 'director.v5']] as const) {
    const init = (await post(path, INITIALIZE)).result as Rec
    expect(init.instructions, path).toBe(snapshotOf(surface).connector.instructions)
    expect((init.serverInfo as Rec).version, path).toBe(surface.slice(-1))
    const tools = ((await post(path, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).result as Rec).tools
    expect(JSON.stringify(tools), path).toBe(JSON.stringify(snapshotOf(surface).connector.tools))
  }
  expect(seenSurfaces).toContain('director.v2')
  expect(seenSurfaces).toContain('director.v3')
  expect(seenSurfaces).toContain('director.v4')
  expect(seenSurfaces).toContain('director.v5')
  // the default server (no surface named) is v1, as every caller of buildServer(harness) had it
  expect((await listed(buildServer(unusedHarness()))).tools).toEqual(snapshotOf('director.v1').connector.tools)
})

// ---- native: one surface per conversation -------------------------------------------------------------------------

interface Seen { tools: Rec[][]; instructions: string[]; requests: ModelMessage[][] }
function probe(a: App, id: string, seen: Seen): void {
  const model = a.state.model_overrides.get(id)!
  const original = model.requestStream.bind(model)
  model.requestStream = (messages, settings, params, ctx) => {
    if (params.function_tools.length) {
      seen.tools.push(params.function_tools.map((t) => ({ name: t.name, description: t.description, parameters_json_schema: t.parameters_json_schema })))
      const last = messages[messages.length - 1] as { instructions?: string | null }
      seen.instructions.push(last.instructions ?? '')
      seen.requests.push(messages)
    }
    return original(messages, settings, params, ctx)
  }
}

async function waitTurn(c: Client, id: string): Promise<DirectorTurn> {
  for (let i = 0; i < 800; i += 1) {
    const turn = await json<DirectorTurn>(await c.get(`/api/director-turns/${id}`))
    if (['done', 'error', 'cancelled'].includes(turn.status)) return turn
    await sleep(25)
  }
  throw new Error(`turn ${id} did not end`)
}

test('a pre-surface director row holds director.v1 on every request: across turns, a compaction, a change of route and a restart', async () => {
  const saved = process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS
  process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = '60000'
  const settings = testSettings()
  const seen: Seen = { tools: [], instructions: [], requests: [] }
  const LONG = 'the quick brown fox jumps over the lazy dog '.repeat(1100)
  const answering = () => scriptedModel((messages: ModelMessage[]) => {
    const last = JSON.stringify(messages[messages.length - 1])
    if (last.includes(PROMPT_TEXT['compaction.request'].slice(0, 40))) return modelResponse([textPart('<summary>q1 to q3 were asked and answered.</summary>')])
    return modelResponse([textPart(`noted. ${LONG}`)])
  }, 'scripted-b')
  try {
    app = await makeApp(settings)
    const c = new Client(app)
    setModel(app.state, 'scripted:b', answering())
    setModel(app.state, 'scripted:a', answering())
    probe(app, 'scripted:b', seen)
    probe(app, 'scripted:a', seen)
    const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
    const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'legacy', model: 'scripted:a' }))
    const sid = String(session.id)
    const opened = await json<DirectorDetail>(await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: 'scripted:b' }))
    const ds = asLegacyV1(app.state.conn, opened.director!.id)
    expect(ds.tool_surface).toBe('director.v1')
    for (const q of ['q1', 'q2', 'q3', 'q4']) {
      const turn = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: q }))
      expect((await waitTurn(c, turn.id)).status).toBe('done')
    }
    // a change of route and of config: the surface stays (the row still names none)
    await json(await c.put(`/api/sessions/${sid}/director`, { model: 'scripted:a', config: { thinking: 'high' } }))
    expect(store.getDirectorSession(app.state.conn, ds.id)!.config.tool_surface).toBeUndefined()
    const t5 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'q5' }))
    expect((await waitTurn(c, t5.id)).status).toBe('done')
    // a restart: a new process, the same rows
    await app.close()
    app = await makeApp(settings)
    setModel(app.state, 'scripted:a', answering())
    probe(app, 'scripted:a', seen)
    await app.start()
    const c2 = new Client(app)
    const t6 = await json<DirectorTurn>(await c2.post(`/api/sessions/${sid}/director/messages`, { text: 'q6 after restart' }))
    expect((await waitTurn(c2, t6.id)).status).toBe('done')
    const v1 = snapshotOf('director.v1')
    expect(seen.tools.length).toBeGreaterThanOrEqual(6)
    for (const [i, tools] of seen.tools.entries()) expect(JSON.stringify(tools), `request ${i}`).toBe(JSON.stringify(v1.native.tools))
    for (const [i, instructions] of seen.instructions.entries()) expect(instructions, `request ${i}`).toBe(v1.native.instructions)
    // a compaction happened, and the request after it still held v1
    const record = JSON.stringify(seen.requests.at(-1))
    expect(record).toContain('q6 after restart')
    expect(seen.requests.some((m) => JSON.stringify(m).includes('App note: The conversation so far was summarized'))).toBe(true)
  } finally {
    if (saved === undefined) delete process.env['OASIS_CODE_CONTEXT_WINDOW_TOKENS' as string]
    else process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = saved
  }
}, 120_000)

test('a new director session holds the current surface across config and model edits; a client neither sets nor changes it; a v1 and a current director side by side keep their own lists', async () => {
  app = await makeApp()
  const c = new Client(app)
  const seen: Record<string, Seen> = { a: { tools: [], instructions: [], requests: [] }, b: { tools: [], instructions: [], requests: [] } }
  setModel(app.state, 'scripted:a', scriptedModel(() => modelResponse([textPart('a answers')]), 'scripted-a'))
  setModel(app.state, 'scripted:b', scriptedModel(() => modelResponse([textPart('b answers')]), 'scripted-b'))
  probe(app, 'scripted:a', seen.a!)
  probe(app, 'scripted:b', seen.b!)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const s1 = String((await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'v3', model: 'scripted:a' }))).id)
  const s2 = String((await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'v1', model: 'scripted:a' }))).id)
  // a client cannot name the surface or a reach when it opens one
  expect((await c.post(`/api/sessions/${s1}/director`, { transport: 'native', model: 'scripted:b', config: { tool_surface: 'director.v1' } })).status).toBe(409)
  expect((await c.post(`/api/sessions/${s1}/director`, { transport: 'native', model: 'scripted:b', config: { authorized_session_ids: [s2] } })).status).toBe(409)
  const opened = await json<DirectorDetail>(await c.post(`/api/sessions/${s1}/director`, { transport: 'native', model: 'scripted:b' }))
  expect(opened.director!.config.tool_surface).toBe(CURRENT_DIRECTOR_TOOL_SURFACE)
  expect(opened.director!.tool_surface).toBe(CURRENT_DIRECTOR_TOOL_SURFACE)
  // the same director's v1 neighbour: a pre-surface row in another session, on the same route
  const legacy = asLegacyV1(app.state.conn, (await json<DirectorDetail>(await c.post(`/api/sessions/${s2}/director`, { transport: 'native', model: 'scripted:b' }))).director!.id)
  const say = async (sid: string, text: string) => { const t = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text })); expect((await waitTurn(c, t.id)).status).toBe('done') }
  await say(s1, 'v3 first')
  await say(s2, 'v1 first')
  // config and route edits: the surface stays; an edit that names another surface or a reach is refused; one that
  // sends the same surface back changes nothing
  expect((await c.put(`/api/sessions/${s1}/director`, { config: { tool_surface: 'director.v1' } })).status).toBe(409)
  expect((await c.put(`/api/sessions/${s1}/director`, { config: { authorized_session_ids: [s2] } })).status).toBe(409)
  expect((await c.put(`/api/sessions/${s1}/director`, { config: { tool_surface: CURRENT_DIRECTOR_TOOL_SURFACE, thinking: 'low' } })).status).toBe(200)
  await json(await c.put(`/api/sessions/${s1}/director`, { model: 'scripted:a', config: { allow_destructive: true, max_requests_per_turn: 12 } }))
  await json(await c.put(`/api/sessions/${s2}/director`, { model: 'scripted:a', config: { thinking: 'high' } }))
  expect(store.getDirectorSession(app.state.conn, opened.director!.id)!.tool_surface).toBe(CURRENT_DIRECTOR_TOOL_SURFACE)
  expect(store.getDirectorSession(app.state.conn, legacy.id)!.tool_surface).toBe('director.v1')
  await say(s1, 'v3 after edits')
  await say(s2, 'v1 after edits')
  const v1 = snapshotOf('director.v1')
  const v3 = snapshotOf(CURRENT_DIRECTOR_TOOL_SURFACE)
  const all = [...seen.a!.tools.map((t, i) => [t, seen.a!.instructions[i]] as const), ...seen.b!.tools.map((t, i) => [t, seen.b!.instructions[i]] as const)]
  expect(all).toHaveLength(4)
  const v3Seen = all.filter(([, instr]) => instr === v3.native.instructions)
  const v1Seen = all.filter(([, instr]) => instr === v1.native.instructions)
  expect(v3Seen).toHaveLength(2)
  expect(v1Seen).toHaveLength(2)
  for (const [tools] of v3Seen) expect(JSON.stringify(tools)).toBe(JSON.stringify(v3.native.tools))
  for (const [tools] of v1Seen) expect(JSON.stringify(tools)).toBe(JSON.stringify(v1.native.tools))
}, 60_000)
