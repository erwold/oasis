import { DIRECTOR_ONLY_METADATA_TOOLS, TOOL_CALL_METADATA_KEYS } from '@oasis-code/contract'
/** The director endpoint: an MCP client (ChatGPT through a tunnel, or any other) directs the harness — projects,
 *  sessions, messages, work orders, receipts, diffs, verification, integration — through tools that are thin over
 *  the REST API; the harness's own refusals reach the director as tool errors; the read-only endpoint behind
 *  read_file sees exactly what a run's tools see; a conversation held outside is mirrored as director
 *  notes; the command refuses to start without a harness; the HTTP endpoint answers under its token for its hosts. */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadOrMintToken } from '../src/api/auth.ts'
import * as repo from '../src/db/repo.ts'
import { isThreadRun } from '@oasis-code/contract'
import { buildHttpApp, clientName, transportSecurity } from '../src/director/app.ts'
import { Harness, HarnessError } from '../src/director/harness.ts'
import { DIRECTOR_MANUAL } from '../src/director/manual.ts'
import { buildServer, callLine } from '../src/director/server.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart } from '../src/llm/messages.ts'
import { createApp, type App } from '../src/main.ts'
import { ModelConfig, type HarnessConfig } from '../src/config.ts'
import { isImagePiece } from '../src/llm/images.ts'
import { isRequest, isUserPrompt, type ModelMessage } from '../src/llm/messages.ts'
import { makeApp } from './api_harness.ts'
import { buggyRepo, scriptedModel, setModel, steps, testConfig, testSettings, waitDone } from './harness.ts'
import { rec, toolNames } from './tree_helpers.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import { applySessionMode } from '../src/policy/modes.ts'
import { buildRuntime } from '../src/execution/isolation.ts'
import { tempDir } from './helpers.ts'

export const READ_TOOLS = new Set(['current_session', 'list_models', 'list_projects', 'get_session', 'get_run', 'get_workspace', 'read_file'])
// no tool decides for the person: approvals, action proposals and grants are theirs, in oasis-code
export const WRITE_TOOLS = new Set(['open_project', 'set_project_config', 'create_session', 'post_director_note', 'start_run', 'attach_image', 'cancel_run', 'integrate', 'schedule', 'bash', 'start_interaction'])

let app: App | null = null
let client: McpClient | null = null
afterEach(async () => {
  if (client) await client.close()
  client = null
  if (app) await app.close()
  app = null
})

/** A harness app (scripted models, no socket), the director's own client to it, and an MCP client connected in
 *  process to a director over it. */
async function directing(config?: HarnessConfig, log?: (line: string) => void, isolated = false) {
  // isolated: the OS sandbox probed and in force (commands run only so)
  app = config ? await createApp(testSettings(), config, { probe: false }) : await makeApp(null, isolated ? { runtime: buildRuntime(), probe: true } : {})
  const harness = Harness.connect('http://localhost', 'test-token', { fetchImpl: (input, init) => Promise.resolve(app!.app.request(input, init)) })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = buildServer(harness, log)
  await server.connect(serverTransport)
  client = new McpClient({ name: 't', version: '0' })
  await client.connect(clientTransport)
  return { client, state: app.state, harness }
}

async function call(c: McpClient, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown> | string> {
  const result = await c.callTool({ name, arguments: args })
  const content = (result.content as { type: string; text?: string }[] | undefined) ?? []
  const text = content.map((part) => part.text ?? '').join('')
  if (result.isError) return { error: text }
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent as Record<string, unknown>
  return text.startsWith('{') || text.startsWith('[') ? (JSON.parse(text) as Record<string, unknown>) : text
}

const fixingScript = () => steps(
  [toolCallPart('read_file', { path: 'calc.py' }, '')],
  [toolCallPart('edit_file', { path: 'calc.py', old_string: 'a - b   # the bug: this should add', new_string: 'a + b' }, '')],
  [textPart('Patched calc.py; run python3 -m unittest to confirm.')],
)

test('the surface and the manual', async () => {
  const { client: c } = await directing()
  const { tools } = await c.listTools()
  const names = new Set(tools.map((t) => t.name))
  expect(names).toEqual(new Set([...READ_TOOLS, ...WRITE_TOOLS]))
  expect(tools).toHaveLength(18)                                               // no grants, approvals, checkpoints or checks from the director
  const interaction = rec(tools.find((t) => t.name === 'start_interaction')!.inputSchema.properties)
  const participant = rec(rec(interaction.participants).items)
  expect(Object.keys(rec(participant.properties)).sort()).toEqual(['model', 'thinking'])                   // ids and names are the harness's
  expect(participant.required).toEqual(['model'])
  const startRun = tools.find((t) => t.name === 'start_run')!
  const params = Object.keys((startRun.inputSchema as { properties: Record<string, unknown> }).properties)
  expect(params).not.toContain('budget')
  expect(params).toEqual(['session_id', 'text', 'request_id', 'model', 'thinking', 'attachments', 'fresh', 'mentions', 'source_turn_id', 'separate', 'resume_run_id', 'base_checkpoint_id', 'constraints'])
  expect(Object.keys((tools.find((t) => t.name === 'integrate')!.inputSchema as { properties: Record<string, unknown> }).properties)).not.toContain('verify')   // no switch past the checks
  for (const t of tools) {
    expect(t.description, t.name).toBe(PROMPT_TEXT[`connector.${t.name}` as keyof typeof PROMPT_TEXT])
    expect(t.annotations, t.name).toBeTruthy()
    expect(t.annotations!.readOnlyHint, t.name).toBe(READ_TOOLS.has(t.name))
  }
  for (const name of DIRECTOR_ONLY_METADATA_TOOLS) {
    const t = tools.find((t) => t.name === name)!
    const keys = Object.keys((t.inputSchema as { properties: Record<string, unknown> }).properties)
    for (const key of TOOL_CALL_METADATA_KEYS[name]!) expect(keys).toContain(key)
  }
  // the connector's own instructions, not the native director's manual: facts about the tools and their limits for a
  // chat model that may be the person's only way to their computer — never which way it should work (the owner:
  // ChatGPT decides what it reads, runs or hands to an agent)
  const instructions = c.getInstructions()!
  expect(instructions).toBe(PROMPT_TEXT['connector.instructions'])
  expect(instructions).not.toContain(DIRECTOR_MANUAL)
  expect(instructions).toContain('Agents see nothing of this chat')
  expect(instructions).toContain('A run outlasts a tool call')
  for (const steer of ['do not wait', 'end your turn', "agent's job", 'only reads it']) expect(instructions).not.toContain(steer)
  expect(instructions.length).toBeLessThan(1000)
})

test('direct a fix from folder to checkpoint', async () => {
  const { client: c, state } = await directing()
  setModel(state, 'scripted:a', scriptedModel(fixingScript()))
  const src = buggyRepo()
  const models = rec(await call(c, 'list_models'))
  expect(new Set((models.models as Record<string, unknown>[]).map((m) => m.id))).toEqual(new Set(['scripted:a', 'scripted:b', 'chatgpt:web']))
  expect(models.default).toBe('scripted:a')
  const project = rec(await call(c, 'open_project', { path: src, mode: 'snapshot', instructions: 'Run python3 -m unittest.' }))
  expect(project.reused).toBe(false)
  expect(project.instructions).toBe('Run python3 -m unittest.')
  expect(project.sessions).toEqual([])
  const again = rec(await call(c, 'open_project', { path: `${src}/` }))
  expect(again.reused).toBe(true)
  expect(again.id).toBe(project.id as string)
  expect((rec(await call(c, 'list_projects')).projects as Record<string, unknown>[]).map((p) => p.id)).toEqual([project.id])
  const configured = rec(await call(c, 'set_project_config', { project_id: project.id, checks: [{ id: 'unit', command: 'python3 -m unittest -q', parser: 'exit_code', timeout_s: 60 }] }))
  expect(configured.checks).toEqual(['unit'])
  const session = rec(await call(c, 'create_session', { project_id: project.id, title: 'fix add', model: 'scripted:a' }))
  expect(session.workspace_id).toBeTruthy()
  expect(rec(session.grants).network).toBe(true)
  expect(session.runs).toEqual([])
  expect(session.director_notes).toEqual([])
  const run = rec(await call(c, 'start_run', { session_id: session.id, text: 'fix add()' }))
  expect(run.finished).toBe(false)
  expect(['queued', 'running']).toContain(run.status as string)
  const done = rec(await call(c, 'get_run', { run_id: run.id, wait_s: 30 }))
  expect(done.finished).toBe(true)
  expect(done.status).toBe('done')
  expect(done.error).toBeNull()
  expect(done.final_text as string).toStartWith('Patched calc.py')
  expect(rec(done.usage).tool_calls).toBe(2)
  expect(rec(rec(done.receipt).mechanical).tool_calls).toBe(2)
  expect((rec(rec(done.receipt).produced).checkpoints as string[]).length).toBeGreaterThan(0)
  const detail = rec(await call(c, 'get_session', { session_id: session.id }))
  expect((detail.runs as Record<string, unknown>[]).map((r) => [r.status, r.user_text_head, r.parent_run_id])).toEqual([['done', 'fix add()', null]])   // every run, with its relations
  expect(readFileSync(join(src, 'calc.py'), 'utf8')).toContain('a - b')                // the person's folder is never written
  const withDiff = rec(await call(c, 'get_workspace', { workspace_id: session.workspace_id, include_diff: true }))
  const diff = rec(withDiff.diff)
  expect(diff.patch as string).toContain('+    return a + b')
  expect((diff.files as Record<string, unknown>[])[0]!.path).toBe('calc.py')
  expect(diff.patch_truncated).toBe(false)
  expect(diff.next_cursor).toBeNull()
  const listing = rec(await call(c, 'read_file', { workspace_id: session.workspace_id, path: '.' }))
  expect(listing.kind).toBe('directory')
  expect(new Set((listing.entries as Record<string, unknown>[]).map((e) => e.path))).toEqual(new Set(['.gitignore', 'README.md', 'calc.py', 'test_calc.py']))
  const page = rec(await call(c, 'read_file', { workspace_id: session.workspace_id, path: '.', offset: 2, limit: 2 }))
  expect((page.entries as Record<string, unknown>[]).map((e) => e.path)).toEqual(['README.md', 'calc.py'])
  expect(page.next_offset).toBe(4)
  const calc = rec(await call(c, 'read_file', { workspace_id: session.workspace_id, path: 'calc.py', limit: 2 }))
  expect(calc.total_lines).toBe(6)
  expect(calc.to_line).toBe(2)
  expect(calc.truncated).toBe(true)
  expect(calc.next_offset).toBe(3)
  expect(calc.content as string).toContain('a + b')
  expect(rec(await call(c, 'read_file', { workspace_id: session.workspace_id, path: '../x' })).error as string).toContain("'..' is refused")
  const ws = rec(await call(c, 'get_workspace', { workspace_id: session.workspace_id }))
  expect(ws.checkpoints as unknown[]).toHaveLength(1)
  expect((ws.checkpoints as Record<string, unknown>[])[0]!.note).toBe('the final state of the run')
  expect(ws.lock_owner).toBeNull()
  expect(ws.diff).toBeUndefined()
  const events = rec(await call(c, 'get_run', { run_id: run.id, view: 'events', cursor: '2' }))
  expect(events.total_entries).toBe(4)
  expect((events.entries as Record<string, unknown>[]).map((e) => e.kind)).toEqual(['activity', 'agent'])
  expect(events.next_cursor).toBeNull()
  expect(rec(await call(c, 'get_run', { run_id: run.id, view: 'events' })).next_cursor).toBeNull()
  expect(detail.active_run).toBeNull()
  expect(detail.pending_approvals).toEqual([])
})

test('dispatch an order and resume it', async () => {
  const { client: c, state } = await directing()
  const seen: Record<string, unknown> = {}
  setModel(state, 'scripted:b', scriptedModel((_m, info) => { seen.tools ??= toolNames(info); return modelResponse([textPart('counted 2 files')]) }))
  const project = rec(await call(c, 'open_project', { path: buggyRepo(), mode: 'snapshot' }))
  const session = rec(await call(c, 'create_session', { project_id: project.id }))
  const run = rec(await call(c, 'start_run', { session_id: session.id, text: 'count the files', model: 'scripted:b', separate: true,
    constraints: { label: 'inventory', read_only: true, tools: ['read_file', 'bash'], budget: { tool_calls: 5 } } }))
  expect(run.label).toBe('inventory')
  expect(run.workspace_id).not.toBe(session.workspace_id)                                          // its own file copy
  // the director caps no run: a budget among the constraints is left out (the limits a director set stopped runs after a request)
  expect(state.conn.get('SELECT budget_json FROM runs WHERE id=?', [String(run.id)])).toEqual({ budget_json: '{}' })
  const done = rec(await call(c, 'get_run', { run_id: run.id, wait_s: 30 }))
  expect(done.status).toBe('done')
  expect(done.final_text).toBe('counted 2 files')
  expect(rec(rec(done.receipt).mechanical).checks).toEqual({ passed: 0, failed: 0, unknown: 0, not_run: 0 })
  expect(seen.tools).toEqual(['bash', 'read_file'])                                               // the constraints' two tools
  const follow = rec(await call(c, 'start_run', { resume_run_id: run.id, text: 'count again' }))
  expect(follow.resumes_run_id).toBe(run.id)
  expect(follow.workspace_id).toBe(run.workspace_id)
  expect(rec(await call(c, 'get_run', { run_id: follow.id, wait_s: 30 })).status).toBe('done')
  const detail = rec(await call(c, 'get_session', { session_id: session.id }))
  expect((detail.runs as Record<string, unknown>[]).map((r) => [r.label, r.status, r.resumes_run_id])).toEqual([['inventory', 'done', null], ['inventory', 'done', run.id]])
  expect(rec(await call(c, 'start_run', { session_id: session.id, text: '', separate: true })).error as string).toContain('invalid work order')
  expect(rec(await call(c, 'start_run', { session_id: session.id, text: 'x', separate: true, resume_run_id: run.id })).error as string).toContain('cannot be combined')
  expect(rec(await call(c, 'start_run', { session_id: session.id, text: 'x', base_checkpoint_id: 'cp_x' })).error as string).toContain('separate run only')
  expect(rec(await call(c, 'start_run', { session_id: session.id, text: 'x', constraints: { read_only: true } })).error as string).toContain('constraints apply to a separate run')
})

test('a conversation is mirrored as director notes', async () => {
  const { client: c, state, harness } = await directing()
  setModel(state, 'scripted:a', scriptedModel(fixingScript()))
  const project = rec(await call(c, 'open_project', { path: buggyRepo() }))
  const session = rec(await call(c, 'create_session', { project_id: project.id, title: 'add() returns the wrong sum' }))
  const note = rec(await call(c, 'post_director_note', { session_id: session.id, question: 'Why does add() return the wrong sum?',
    answer: 'It subtracts. Replace `a - b` with `a + b` and run the unit tests.', model: 'GPT-6 Pro' }))
  expect(note.source).toBe('chatgpt')
  expect(note.model).toBe('GPT-6 Pro')
  expect(note.id as string).toStartWith('note_')
  const run = rec(await call(c, 'start_run', { session_id: session.id, text: 'fix add()' }))
  expect(rec(await call(c, 'get_run', { run_id: run.id, wait_s: 30 })).status).toBe('done')
  // the note stands in the session as it was, before the run; nothing ran for it
  const notes = repo.listDirectorNotes(state.conn, session.id as string)
  expect(notes).toHaveLength(1)
  expect(notes[0]!.question).toStartWith('Why does')
  expect(notes[0]!.answer).toStartWith('It subtracts')
  expect(notes[0]!.created_at <= (run.created_at as string)).toBe(true)
  expect(repo.listRuns(state.conn, session.id as string)).toHaveLength(1)
  const listed = rec(await harness.get(`/api/sessions/${session.id}/director-notes`))
  expect((listed.notes as Record<string, unknown>[]).map((n) => n.id)).toEqual([note.id])
  const detail = rec(await harness.get(`/api/sessions/${session.id}`))
  expect((detail.director_notes as Record<string, unknown>[]).map((n) => [n.id, n.source, n.model])).toEqual([[note.id, 'chatgpt', 'GPT-6 Pro']])
  const summary = rec(await call(c, 'get_session', { session_id: session.id }))
  expect(summary.director_notes).toEqual([{ id: note.id, model: 'GPT-6 Pro', created_at: note.created_at, question_head: 'Why does add() return the wrong sum?' }])
  expect(rec(await call(c, 'post_director_note', { session_id: session.id, question: 'q', answer: '  ' })).error as string).toContain('answer is required')
  expect(rec(await call(c, 'post_director_note', { session_id: 'nope', question: 'q', answer: 'a' })).error as string).toContain('session not found')
})

test('wait returns unfinished and cancel stops', async () => {
  const { client: c, state } = await directing()
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  setModel(state, 'scripted:a', scriptedModel(async () => { await gate; return modelResponse([textPart('late')]) }))
  const project = rec(await call(c, 'open_project', { path: buggyRepo() }))
  const session = rec(await call(c, 'create_session', { project_id: project.id }))
  const run = rec(await call(c, 'start_run', { session_id: session.id, text: 'take your time' }))
  const waited = rec(await call(c, 'get_run', { run_id: run.id, wait_s: 1 }))
  expect(waited.finished).toBe(false)
  expect(waited.status).toBe('running')
  expect(waited.note as string).toContain('call get_run again')
  expect(rec(await call(c, 'get_run', { run_id: run.id })).note as string).toBe('still running')
  expect(rec(await call(c, 'cancel_run', { run_id: run.id })).cancelled).toBe(true)
  release()
  const ended = rec(await call(c, 'get_run', { run_id: run.id, wait_s: 30 }))
  expect(ended.finished).toBe(true)
  expect(ended.status).toBe('cancelled')
})

test("a long final answer is read a page at a time: the cursor where the page starts, the whole length beside it", async () => {
  const { client: c, state } = await directing()
  const answer = Array.from({ length: 13_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')
  setModel(state, 'scripted:a', scriptedModel(() => modelResponse([textPart(answer)])))
  const project = rec(await call(c, 'open_project', { path: buggyRepo() }))
  const session = rec(await call(c, 'create_session', { project_id: project.id }))
  const run = rec(await call(c, 'start_run', { session_id: session.id, text: 'a long derivation' }))
  const first = rec(await call(c, 'get_run', { run_id: run.id, wait_s: 30 }))
  expect(first.final_text_chars).toBe(13_000)
  expect((first.final_text as string).length).toBe(6000)
  expect(first.next_cursor).toBe('6000')
  const second = rec(await call(c, 'get_run', { run_id: run.id, cursor: first.next_cursor }))
  expect(second.next_cursor).toBe('12000')
  const last = rec(await call(c, 'get_run', { run_id: run.id, cursor: second.next_cursor }))
  expect(last.next_cursor).toBeNull()
  expect(`${first.final_text}${second.final_text}${last.final_text}`).toBe(answer)
})

test("the harness's refusals are the tool's errors", async () => {
  const { client: c } = await directing()
  expect(rec(await call(c, 'get_run', { run_id: 'nope' })).error as string).toContain('run not found: nope')
  expect(rec(await call(c, 'create_session', { project_id: 'nope' })).error as string).toContain('project not found')
  const project = rec(await call(c, 'open_project', { path: buggyRepo() }))
  const session = rec(await call(c, 'create_session', { project_id: project.id }))
  expect(rec(await call(c, 'start_run', { session_id: session.id, text: '  ' })).error as string).toContain('text is required')
  expect(rec(await call(c, 'start_run', { session_id: session.id, text: 'x', model: 'no:such' })).error as string).toContain('unknown model')
  expect(rec(await call(c, 'set_project_config', { project_id: project.id })).error as string).toContain('nothing to set')
})

test('a dead harness and a wrong token are named', async () => {
  const dead = Harness.connect('http://127.0.0.1:9', 't', { fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  await expect(dead.probe()).rejects.toThrow('not reachable')
  await dead.close()
  app = await makeApp()
  const fetchImpl = (input: string | URL, init?: RequestInit) => Promise.resolve(app!.app.request(input, init))
  const wrong = Harness.connect('http://localhost', 'wrong', { fetchImpl })
  await expect(wrong.probe()).rejects.toThrow('rejected the session token')
  const right = Harness.connect('http://localhost', 'test-token', { fetchImpl })
  expect((await right.probe()).api_version).toBe('code-v1')
  try { await right.get('/api/runs/nope') } catch (error) { expect(error).toBeInstanceOf(HarnessError); expect((error as HarnessError).status).toBe(404) }
  // the director's own token: minted once, 0600, stable, beside the session token
  const dir = tempDir('oasis-token-')
  const first = loadOrMintToken(null, dir, 'director-token')
  expect(first).toBe(loadOrMintToken(null, dir, 'director-token'))
  expect(first.length).toBeGreaterThanOrEqual(32)
  expect(statSync(join(dir, 'director-token')).mode & 0o777).toBe(0o600)
  expect(loadOrMintToken('given', dir, 'director-token')).toBe('given')
})

test('the command refuses to start without a harness', async () => {
  const data = tempDir('oasis-director-')
  const env = { ...process.env, OASIS_CODE_DATA: data, OASIS_CODE_PORT: '9', OASIS_CODE_SESSION_TOKEN: 't', NO_PROXY: '*', no_proxy: '*' }
  const first = Bun.spawnSync(['bun', 'run', 'src/director/main.ts'], { env, cwd: join(import.meta.dir, '..') })
  expect(first.exitCode).toBe(1)
  expect(first.stderr.toString()).toContain('not reachable at http://127.0.0.1:9')
  expect(first.stdout.toString()).toBe('')
  delete (env as Record<string, string | undefined>).OASIS_CODE_SESSION_TOKEN
  const second = Bun.spawnSync(['bun', 'run', 'src/director/main.ts', '--transport', 'stdio'], { env, cwd: join(import.meta.dir, '..') })
  expect(second.exitCode).toBe(1)
  expect(second.stderr.toString()).toContain('no session token')
  expect(second.stderr.toString()).toContain('start the harness first')
}, 60_000)

// -- the HTTP endpoint ---------------------------------------------------------------------------

const JSONRPC_HEADERS = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }
const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }

test('transport security admits the loopback and the named hosts only', () => {
  const security = transportSecurity(['abc.trycloudflare.com', ' ', ''])
  expect(security.enable_dns_rebinding_protection).toBe(true)
  expect(security.allowed_hosts).toEqual(['127.0.0.1:*', 'localhost:*', '[::1]:*', 'abc.trycloudflare.com'])
  expect(security.allowed_origins.at(-1)).toBe('https://abc.trycloudflare.com')
})

test('the HTTP endpoint answers under its token for its hosts', async () => {
  app = await makeApp()
  const harness = Harness.connect('http://localhost', 'test-token', { fetchImpl: (input, init) => Promise.resolve(app!.app.request(input, init)) })
  const http = buildHttpApp(() => buildServer(harness), 's3cret', ['tunnel.example'])
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    http.request(`http://127.0.0.1:8322${path}`, { method: 'POST', headers: { ...JSONRPC_HEADERS, ...headers }, body: JSON.stringify(body) })
  expect(await (await http.request('http://127.0.0.1:8322/healthz')).json()).toEqual({ ok: true, server: 'oasis-code director' })
  let r = await post('/s3cret/mcp', INITIALIZE)
  expect(r.status, await r.clone().text()).toBe(200)
  expect(rec(rec((await r.json() as Record<string, unknown>).result).serverInfo).name).toBe('oasis-code director')
  r = await post('/s3cret/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' })
  expect(r.status).toBe(200)
  expect(new Set((rec((await r.json() as Record<string, unknown>).result).tools as { name: string }[]).map((t) => t.name))).toEqual(new Set([...READ_TOOLS, ...WRITE_TOOLS]))
  r = await post('/s3cret/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {} } })
  expect(r.status).toBe(200)
  expect(rec((await r.json() as Record<string, unknown>).result).structuredContent).toEqual({ projects: [] })
  // the tunnel's hostname is admitted; any other name is not; the wrong path is nothing
  expect((await post('/s3cret/mcp', INITIALIZE, { host: 'tunnel.example' })).status).toBe(200)
  expect((await post('/s3cret/mcp', INITIALIZE, { host: 'evil.example' })).status).toBe(421)
  expect((await post('/wrong/mcp', INITIALIZE)).status).toBe(404)
  expect((await post('/mcp', INITIALIZE)).status).toBe(404)
  // only the whole token opens it: a prefix, a longer one or another case is nothing (compared in constant time)
  for (const near of ['s3cre', 's3crett', 'S3CRET']) expect((await post(`/${near}/mcp`, INITIALIZE)).status, near).toBe(404)
  await harness.close()
  expect(() => buildHttpApp(() => buildServer(harness), 'a/b')).toThrow()
})

test('a request the endpoint turns away is logged with its reason, never with the token', async () => {
  app = await makeApp()
  const harness = Harness.connect('http://localhost', 'test-token', { fetchImpl: (input, init) => Promise.resolve(app!.app.request(input, init)) })
  const lines: string[] = []
  const http = buildHttpApp(() => buildServer(harness), 's3cret', [], (line) => lines.push(line))
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    http.request('http://127.0.0.1:8322/s3cret/mcp', { method: 'POST', headers: { ...JSONRPC_HEADERS, ...headers }, body: JSON.stringify(body) })
  expect((await post(INITIALIZE)).status).toBe(200)
  expect(lines).toEqual([])
  // a protocol version this SDK does not know is refused, as the specification asks, and the log says which
  const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': '2099-01-01', 'user-agent': 'probe/1' })
  expect(r.status).toBe(400)
  expect((await post(INITIALIZE, { host: 'evil.example' })).status).toBe(421)
  expect(lines.length).toBe(2)
  expect(lines[0]).toContain('Unsupported protocol version: 2099-01-01')
  expect(lines[0]).toContain('probe/1')
  expect(lines[1]).toContain('Invalid Host header: evil.example')
  expect(lines.join('\n')).not.toContain('s3cret')
  await harness.close()
})

test('open_project works in the folder itself by default, attaches one on request, and says which kind a project is', async () => {
  const { client: c } = await directing()
  const inPlace = rec(await call(c, 'open_project', { path: buggyRepo() }))
  expect(inPlace.kind).toBe('direct')
  const src = buggyRepo()
  const attached = rec(await call(c, 'open_project', { path: src, mode: 'attached' }))
  expect(attached.kind).toBe('attached')
  expect(attached.reused).toBe(false)
  const again = rec(await call(c, 'open_project', { path: src, mode: 'snapshot' }))
  expect(again.reused).toBe(true)
  expect(again.kind).toBe('attached')                     // the folder's existing project, whatever its kind
})

test("an attached folder is found by listing and read by pages, numbers sent as strings too; every call goes to the log", async () => {
  const logged: string[] = []
  const { client: c } = await directing(undefined, (line) => logged.push(line))
  const src = buggyRepo()
  const project = rec(await call(c, 'open_project', { path: src, mode: 'attached' }))
  const session = rec(await call(c, 'create_session', { project_id: project.id, title: 'read it' }))
  const ws = String(rec(session).workspace_id)
  // the session's working folder holds the attached folder as a link: its root listing names it first
  const root = rec(await call(c, 'read_file', { workspace_id: ws, path: '.' }))
  expect((root.entries as Record<string, unknown>[])[0]).toEqual({ path: 'userrepo/', bytes: null, attached: true })
  // a page of a file inside it, the offset and the limit as a chat model may send them
  const page = rec(await call(c, 'read_file', { workspace_id: ws, path: 'userrepo/calc.py', offset: '2', limit: '1' }))
  expect(page.from_line).toBe(2)
  expect(page.to_line).toBe(2)
  expect(page.next_offset).toBe(3)
  const lines = logged.filter((l) => l.startsWith('[director] call '))
  expect(lines.some((l) => l.startsWith('[director] call read_file {"workspace_id":') && l.includes('"offset":2') && / → ok \(\d+ ms\)$/.test(l))).toBe(true)
  expect(rec(await call(c, 'read_file', { workspace_id: ws, path: '/etc/hosts' })).error).toContain('the harness refused (400)')
  expect(logged.at(-1)).toMatch(/^\[director\] call read_file .* → error: the harness refused \(400\)/)
})

test('bash runs a command in the session folder as an agent\'s runs, waits on a long one again, keeps to the session\'s mode, and leaves a record', async () => {
  const { client: c, state } = await directing(undefined, undefined, true)
  const src = buggyRepo()
  const project = rec(await call(c, 'open_project', { path: src, mode: 'attached' }))
  const session = rec(await call(c, 'create_session', { project_id: project.id, title: 'look' }))
  const ws = String(session.workspace_id)
  // the attached folder searched with the shell, as the person's own tools would
  const found = rec(await call(c, 'bash', { workspace_id: ws, command: 'grep -rn "the bug" userrepo/' }))
  expect(found.exit_code).toBe(0)
  expect(String(found.stdout)).toContain('userrepo/calc.py')
  // read-only there: the sandbox refuses a write into it
  const wrote = rec(await call(c, 'bash', { workspace_id: ws, command: 'echo x > userrepo/new.txt' }))
  expect(wrote.exit_code).not.toBe(0)
  expect(existsSync(join(src, 'new.txt'))).toBe(false)
  // a long one: its id now, its end on the next call
  const slow = rec(await call(c, 'bash', { workspace_id: ws, command: 'sleep 1; echo done', wait_s: '0' }))
  expect(slow.status).toBe('running')
  const later = rec(await call(c, 'bash', { workspace_id: ws, execution_id: slow.execution_id, wait_s: 10 }))
  expect(later.exit_code).toBe(0)
  expect(String(later.stdout)).toContain('done')
  expect(rec(await call(c, 'bash', { workspace_id: ws })).error).toContain('send a command')
  // each command stands in the session as the person's action through the connector
  const rows = repo.listRuns(state.conn, String(session.id)).filter((r) => r.spawned_by === 'human_action')
  expect(rows.map((r) => r.label)).toEqual(['command (connector)', 'command (connector)', 'command (connector)'])   // no client named in process
  expect(rows[0]!.user_text).toStartWith('$ grep -rn "the bug" userrepo/\n→ exit 0')
  // Plan mode runs none; "ask before changes" is the person's to answer in the app
  for (const [mode, refusal] of [['plan', 'runs no commands'], ['approve', 'asks the user before a command runs']] as const) {
    applySessionMode(state.conn, repo.getSession(state.conn, String(session.id))!, mode)
    expect(rec(await call(c, 'bash', { workspace_id: ws, command: 'true' })).error).toContain(refusal)
  }
})

test('what the connector starts says so: its runs are the thread\'s own, started by ChatGPT; its commands too', async () => {
  const { client: plain, state, harness } = await directing()
  setModel(state, 'scripted:a', scriptedModel(() => modelResponse([textPart('looked')])))
  const project = rec(await call(plain, 'open_project', { path: buggyRepo() }))
  const session = rec(await call(plain, 'create_session', { project_id: project.id, title: 'from the phone' }))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await buildServer(harness.as('ChatGPT')).connect(serverTransport)
  const c = new McpClient({ name: 'chatgpt', version: '0' })
  await c.connect(clientTransport)
  const run = rec(await call(c, 'start_run', { session_id: session.id, text: 'look at calc.py' }))
  const row = repo.getRun(state.conn, String(run.id))!
  expect(row.spawned_by).toBe('connector')
  expect(row.label).toBe('ChatGPT')
  expect(isThreadRun(row)).toBe(true)                                              // the session's conversation, as the person's
  await waitDone(state, row.id)
  // the session's thread holds it (the page loads it there), and the next message goes on from it
  expect(repo.listThreadRuns(state.conn, String(session.id)).map((r) => r.id)).toEqual([row.id])
  expect(repo.latestRunOfSession(state.conn, String(session.id))!.id).toBe(row.id)
  // the person's own message is still theirs, and continues ChatGPT's turn
  const own = rec(await call(plain, 'start_run', { session_id: session.id, text: 'and now?' }))
  const ownRow = repo.getRun(state.conn, String(own.id))!
  expect(ownRow.spawned_by).toBe('human')
  expect(ownRow.resumes_run_id).toBe(row.id)
  await c.close()
})

test('the connector names its client by the user agent', () => {
  expect(clientName('openai-mcp/1.0.0')).toBe('ChatGPT')
  expect(clientName('claude-ai/2')).toBe('Claude')
  expect(clientName(undefined)).toBe('MCP client')
})

test('a call line cuts long strings and leaves a message\'s words out', () => {
  const line = callLine('start_run', { session_id: 's_1', text: 'secret words here', title: 'x'.repeat(100) }, 12.4, null)
  expect(line).toBe(`[director] call start_run {"session_id":"s_1","text":"(17 chars)","title":"${'x'.repeat(80)}…"} → ok (12 ms)`)
})

test('the director keys what it starts: the same request_id again is the same project, session and run', async () => {
  const { client: c, state } = await directing()
  setModel(state, 'scripted:a', scriptedModel(() => modelResponse([textPart('done')])))
  const src = buggyRepo()
  const p1 = rec(await call(c, 'open_project', { path: src, reuse: false, request_id: 'dir-0001/project' }))
  const p2 = rec(await call(c, 'open_project', { path: src, reuse: false, request_id: 'dir-0001/project' }))
  expect(p2.id).toBe(p1.id)
  const s1 = rec(await call(c, 'create_session', { project_id: p1.id, title: 'x', request_id: 'dir-0001/session' }))
  const s2 = rec(await call(c, 'create_session', { project_id: p1.id, title: 'x', request_id: 'dir-0001/session' }))
  expect(s2.id).toBe(s1.id)
  const r1 = rec(await call(c, 'start_run', { session_id: s1.id, text: 'go', request_id: 'dir-0001/message' }))
  const r2 = rec(await call(c, 'start_run', { session_id: s1.id, text: 'go', request_id: 'dir-0001/message' }))
  expect(r2.id ?? r2.run_id).toBe(r1.id ?? r1.run_id)
  expect(repo.listRuns(state.conn, s1.id as string)).toHaveLength(1)
})

test('the director attaches an image and the run is handed it', async () => {
  const config = testConfig()
  config.models = [new ModelConfig({ id: 'scripted:a', label: 'Scripted A', provider: 'anthropic', model: 'scripted-a', api_key_env: 'OASIS_TEST_KEY_A', capabilities: { images: true } })]
  const { client: c, state } = await directing(config)
  const seen: string[] = []
  setModel(state, 'scripted:a', scriptedModel((messages: ModelMessage[]) => {
    for (const m of messages) if (isRequest(m)) for (const p of m.parts) if (isUserPrompt(p) && Array.isArray(p.content)) for (const x of p.content) if (isImagePiece(x)) seen.push(`${x.name} ${typeof x.data === 'string' ? 'with bytes' : 'without'}`)
    return modelResponse([textPart('red')])
  }))
  const png = readFileSync(join(import.meta.dir, 'fixtures', 'images', 'red-7x5.png'))
  const project = rec(await call(c, 'open_project', { path: buggyRepo() }))
  const session = rec(await call(c, 'create_session', { project_id: project.id }))
  const image = rec(await call(c, 'attach_image', { session_id: session.id, name: 'red.png', data_base64: `data:image/png;base64,${png.toString('base64')}` }))
  expect([image.media_type, image.width, image.height]).toEqual(['image/png', 7, 5])
  const run = rec(await call(c, 'start_run', { session_id: session.id, text: 'what colour?', attachments: [image.asset_id] }))
  await waitDone(state, (run.id ?? run.run_id) as string)
  expect(seen).toEqual(['red.png with bytes'])
  const refused = rec(await call(c, 'attach_image', { session_id: session.id, data_base64: Buffer.from('<svg/>').toString('base64') }))
  expect(String(refused.error)).toContain('415')
})

test('connector start_run accepts text asset IDs, attach_image remains image-only, separate runs refuse files', async () => {
  const { saveFileAttachment } = await import('../src/api/attachments.ts')
  const { pdfFixture } = await import('./file_fixtures.ts')
  const { client: c, state } = await directing()
  let received = ''
  setModel(state, 'scripted:a', scriptedModel((messages) => { received = JSON.stringify(messages); return modelResponse([textPart('done')]) }))
  const project = rec(await call(c, 'open_project', { path: buggyRepo() }))
  const made = rec(await call(c, 'create_session', { project_id: project.id }))
  const session = repo.getSession(state.conn, String(made.id))!
  const file = saveFileAttachment(state, session, Buffer.from('PKCE connector text'), 'notes.md')
  for (const bytes of [pdfFixture(), Buffer.from('ordinary text')]) {
    const refused = rec(await call(c, 'attach_image', { session_id: session.id, name: 'notes.md', data_base64: bytes.toString('base64') }))
    expect(String(refused.error)).toContain('415')
  }
  const separate = rec(await call(c, 'start_run', { session_id: session.id, text: 'separate', separate: true, attachments: [file.asset_id] }))
  expect(String(separate.error)).toContain('separate run')
  const run = rec(await call(c, 'start_run', { session_id: session.id, text: '', attachments: [file.asset_id] }))
  await waitDone(state, String(run.id ?? run.run_id))
  expect(received).toContain('PKCE connector text')
  expect(received).toContain('attached UTF-8 file v1')
})
