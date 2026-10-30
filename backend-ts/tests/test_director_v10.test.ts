/** director.v10: v9 whose open_project makes a new Git worktree of a local repository, on a new branch, and opens it
 *  as a direct project; the REST route behind it makes the worktree with the repository's own `git worktree add`.
 *  Fixture repositories only; no provider is called. */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo, git } from './harness.ts'
import { tempDir } from './helpers.ts'

type Rec = Record<string, unknown>
let app: App | null = null
const clients: McpClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  if (app) await app.close()
  app = null
})

async function listed(harness: Harness, audience: 'connector' | 'native') {
  const server = buildServer(harness, { surface: 'director.v10', audience, frozen: false })
  const client = new McpClient({ name: 'v10-freeze', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b); await client.connect(a)
  try { return { tools: (await client.listTools()).tools, instructions: client.getInstructions() } }
  finally { await client.close(); await server.close() }
}

async function directing(): Promise<McpClient> {
  if (!app) app = await makeApp()
  const harness = Harness.connect('http://localhost', 'test-token', { fetchImpl: (input, init) => Promise.resolve(app!.app.request(input, init)) })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await buildServer(harness, { surface: 'director.v10' }).connect(serverTransport)
  const client = new McpClient({ name: 't', version: '0' })
  await client.connect(clientTransport)
  clients.push(client)
  return client
}

async function call(c: McpClient, name: string, args: Rec = {}): Promise<Rec> {
  const result = await c.callTool({ name, arguments: args })
  const text = ((result.content as { text?: string }[] | undefined) ?? []).map((p) => p.text ?? '').join('')
  if (result.isError) return { error: text }
  return (result.structuredContent as Rec | undefined) ?? JSON.parse(text)
}

const real = (p: string) => realpathSync(p)

test("director.v10 is its committed snapshot: v9 with open_project's worktree; everything else v9's; served on /<token>/mcp/v10", async () => {
  const v10 = snapshotOf('director.v10'), v9 = snapshotOf('director.v9')
  expect(DIRECTOR_TOOL_SURFACES).toContain('director.v10')
  for (const [part, value] of Object.entries({ connector_tools: v10.connector.tools, connector_instructions: v10.connector.instructions, native_tools: v10.native.tools, native_instructions: v10.native.instructions, templates: v10.templates, golden: v10.golden })) {
    expect(surfaceDigest(value), part).toBe(v10.sha256[part]!)
  }
  const unused = Harness.connect('http://127.0.0.1:9', 'unused')
  const connector = await listed(unused, 'connector'), native = await listed(unused, 'native')
  expect(connector.tools as unknown[]).toEqual(v10.connector.tools)
  expect(connector.instructions).toBe(v10.connector.instructions)
  expect(native.tools.map((t) => ({ name: t.name, description: t.description ?? t.name, parameters_json_schema: cleanSchema(t.inputSchema) }))).toEqual(v10.native.tools)
  // frozen since director.v11: the native instructions and the templates are read from the snapshot, which v11 composes the same
  expect(composeNativeInstructions(CURRENT_DIRECTOR_TOOL_SURFACE)).toBe(v10.native.instructions)
  expect(composeTemplates(CURRENT_DIRECTOR_TOOL_SURFACE)).toEqual(v10.templates)
  expect(taskEventMessage('s_golden', GOLDEN_EVENTS as never, 'director.v10')).toBe(v10.golden.task_event_message!)
  // the same tools in the same order; open_project alone changed: its description and the worktree parameter
  expect(v10.connector.tools.map((t) => t.name)).toEqual(v9.connector.tools.map((t) => t.name))
  for (const tool of v10.connector.tools) if (tool.name !== 'open_project') expect(tool).toEqual(v9.connector.tools.find((t) => t.name === tool.name)!)
  const open10 = v10.connector.tools.find((t) => t.name === 'open_project') as Rec, open9 = v9.connector.tools.find((t) => t.name === 'open_project') as Rec
  expect(open10.description).toBe(PROMPT_TEXT['connector.v10.open_project'])
  const props10 = rec(rec(open10.inputSchema).properties), props9 = rec(rec(open9.inputSchema).properties)
  expect(Object.keys(props10).filter((k) => !(k in props9))).toEqual(['worktree'])
  for (const k of Object.keys(props9)) expect(props10[k]).toEqual(props9[k])
  expect(v10.connector.instructions).toBe(v9.connector.instructions)
  expect(v10.native.tools).toEqual(v9.native.tools)
  expect(v10.native.instructions).toBe(v9.native.instructions)
  expect(v10.templates).toEqual(v9.templates)
  const http = buildHttpApp((_client, surface) => buildServer(unused, { surface }), 's3cret')
  const init = ((await (await http.request('http://127.0.0.1:8322/s3cret/mcp/v10', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) })).json()) as Rec).result as Rec
  expect((init.serverInfo as Rec).version).toBe('10')
})

test('REST worktree: a new branch of the repository checked out in a new folder beside it (or the one named), opened in direct mode; an existing branch or folder, a bad base, a folder that is no repository and other modes are refused', async () => {
  app = await makeApp()
  const c = new Client(app)
  const src = real(buggyRepo())
  const head = git(['rev-parse', 'HEAD'], src).trim()
  writeFileSync(join(src, 'README.md'), 'uncommitted\n')
  const made = await json(await c.post('/api/projects', { source_path: src, worktree: { branch: 'feat/x' }, instructions: 'only this branch' }))
  const folder = `${src}-wt-feat-x`
  expect(made.kind).toBe('direct')
  expect(made.source_path).toBe(folder)
  expect(made.name).toBe('userrepo · feat/x')
  expect(rec(made.import_report).worktree).toEqual({ repository: src, branch: 'feat/x', base_commit: head })
  expect(rec(made.config).instructions).toBe('only this branch')
  expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], folder).trim()).toBe('feat/x')
  expect(git(['rev-parse', 'HEAD'], folder).trim()).toBe(head)
  expect(git(['worktree', 'list', '--porcelain'], src)).toContain(`worktree ${folder}`)
  // the repository's uncommitted change stays where it is: the worktree has the commit
  expect(await Bun.file(join(folder, 'README.md')).text()).toContain('# calc')
  // the source checkout is left on its branch
  expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], src).trim()).toBe('main')

  // a base of its own, a folder of its own (a subfolder of the repository names the repository)
  git(['commit', '-qam', 'second'], src)
  const named = join(real(tempDir('oasis-wt-')), 'elsewhere')
  mkdirSync(join(src, 'sub'))
  const second = await json(await c.post('/api/projects', { source_path: join(src, 'sub'), mode: 'direct', name: 'second', worktree: { branch: 'fix-y', base: 'HEAD~1', folder: named } }))
  expect(second.source_path).toBe(named)
  expect(second.name).toBe('second')
  expect(rec(second.import_report).worktree).toEqual({ repository: src, branch: 'fix-y', base_commit: head })

  const refused = async (body: Rec, status = 400) => (await json(await c.post('/api/projects', body), status)) as Rec
  expect(String((await refused({ source_path: src, worktree: { branch: 'feat/x', folder: join(real(tempDir('oasis-wt-')), 'z') } })).detail)).toContain('the branch feat/x exists')
  expect(String((await refused({ source_path: src, worktree: { branch: 'new-one', folder } })).detail)).toContain('exists: a worktree is made in a new folder')
  expect(String((await refused({ source_path: src, worktree: { branch: 'bad..name' } })).detail)).toContain('not a valid branch name')
  expect(String((await refused({ source_path: src, worktree: { branch: 'b2', base: 'no-such-ref' } })).detail)).toContain('names no commit')
  expect(String((await refused({ source_path: real(tempDir('oasis-plain-')), worktree: { branch: 'b3' } })).detail)).toContain('is not in a Git repository')
  expect((await refused({ source_path: src, worktree: { branch: 'b4', folder: join(app.state.settings.data_dir, 'inside') } })).code).toBe('create_refused')
  expect(String((await refused({ source_path: src, mode: 'snapshot', worktree: { branch: 'b5' } })).detail)).toContain('not combined with mode snapshot')
  expect(String((await refused({ source_path: src, create_directory: true, worktree: { branch: 'b6' } })).detail)).toContain('not combined with create_directory')
  expect(String((await refused({ worktree: { branch: 'b7' } })).detail)).toContain('source_path')
  for (const branch of ['b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'new-one']) expect(git(['branch', '--list', branch], src).trim()).toBe('')
  expect(existsSync(join(app.state.settings.data_dir, 'inside'))).toBe(false)
})

test("director.v10 open_project worktree makes the worktree project, reuses it for the repository's branch, and refuses what a worktree is not", async () => {
  const v10 = await directing()
  const src = real(buggyRepo())
  const made = await call(v10, 'open_project', { path: src, worktree: { branch: 'task-1' }, instructions: 'task one', request_id: 'wt-task-1-0001' })
  expect(made.kind).toBe('direct')
  expect(made.reused).toBe(false)
  expect(made.worktree).toEqual({ repository: src, branch: 'task-1', base_commit: git(['rev-parse', 'HEAD'], src).trim() })
  expect(made.instructions).toBe('task one')
  // the same branch of the same repository again: that project, from the repository or a folder inside it
  mkdirSync(join(src, 'docs'))
  const again = await call(v10, 'open_project', { path: join(src, 'docs'), worktree: { branch: 'task-1' } })
  expect(again.reused).toBe(true)
  expect(again.id).toBe(made.id)
  // the same request key: the project it made
  expect((await call(v10, 'open_project', { path: src, worktree: { branch: 'task-1' }, reuse: false, request_id: 'wt-task-1-0001' })).id).toBe(made.id)
  // without reuse, the branch is there: refused by the harness, nothing made
  expect(String((await call(v10, 'open_project', { path: src, worktree: { branch: 'task-1' }, reuse: false })).error)).toContain('the branch task-1 exists')
  // a plain open of the repository is not the worktree's project
  const plain = await call(v10, 'open_project', { path: src })
  expect(plain.id).not.toBe(made.id)
  expect(plain.source_path).toBe(src)
  for (const extra of [{ mode: 'snapshot' }, { no_folder: true, path: null }, { create_directory: true }, { target_id: 'ssh_x' }]) {
    expect(String((await call(v10, 'open_project', { path: src, worktree: { branch: 'task-2' }, ...extra })).error)).toContain('worktree is not combined with')
  }
  expect(String((await call(v10, 'open_project', { worktree: { branch: 'task-2' } })).error)).toContain('path is required with worktree')
  expect(git(['branch', '--list', 'task-2'], src).trim()).toBe('')
})

function rec(v: unknown): Rec { return v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : {} }
