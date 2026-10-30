/** The agent's tool surface: twenty tools (the SSH tools a host connected on the person's yes, generate_image an image made or edited by the subscription, present_ui the surface the person sees, read_ui it read back, request_input the form it waits on,
 *  watch what wakes its conversation), and return_ui_result (a UI task's data) under no order; the
 *  instructions and the descriptions naming only those, a write over an
 *  existing file only at the version the run read, and the final state pinned by the harness, not by the model. */

import { afterEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIRECTOR_ONLY_METADATA_TOOLS, TOOL_CALL_METADATA_KEYS } from '@oasis-code/contract'
import { mapStreamEvent } from '../src/agent/events.ts'
import { INSTRUCTIONS } from '../src/agent/instructions.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import { parametersSchema, specs, visibleToolNames } from '../src/agent/tools/registry.ts'
import * as repo from '../src/db/repo.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart, type ModelMessage } from '../src/llm/messages.ts'
import { appState, buggyRepo, closeState, collectEvents, openSession, scriptedModel, setModel, type AppState } from './harness.ts'
import { rec } from './tree_helpers.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

const SURFACE = ['bash', 'bash_output', 'computer_act', 'computer_observe', 'edit_file', 'fetch_url', 'forward_port', 'generate_image', 'open_ssh_session', 'present_ui', 'read_file', 'read_ui', 'request_input', 'ssh_connect', 'ssh_directories', 'ssh_hosts', 'stop_command', 'watch', 'web_search', 'write_file']
const THREAD_ONLY = ['return_ui_result']
const RETIRED = ['apply_patch', 'run_command', 'list_files', 'search_code', 'inspect_workspace', 'read_resource', 'read_process_output', 'stop_process',
  'git_diff', 'git_status', 'read_artifact', 'read_skill', 'read_manual', 'expected_sha256', 'submit_self_report', 'dispatch_work_order']

test('a run is given twenty tools, and return_ui_result under no order (twenty-one in all); an order may name fewer', () => {
  expect(specs()).toHaveLength(21)
  expect([...visibleToolNames({ order: null })].sort()).toEqual([...SURFACE, ...THREAD_ONLY].sort())
  expect([...visibleToolNames({ order: { tools: null } })].sort()).toEqual(SURFACE)                        // a run under an order: its own conversation
  expect([...visibleToolNames({ order: { tools: ['read_file', 'bash'] } })].sort()).toEqual(['bash', 'read_file'])
  expect([...visibleToolNames({ order: { tools: ['no_such_tool'] } })]).toEqual([])
  const effects = Object.fromEntries(specs().map((s) => [s.name, s.effect]))
  expect(effects).toEqual({
    read_file: 'read', write_file: 'workspace_write', edit_file: 'workspace_write', bash: 'isolated_code_execution', bash_output: 'read',
    stop_command: 'state_change', web_search: 'network', fetch_url: 'network', generate_image: 'network', watch: 'state_change', computer_observe: 'read', computer_act: 'state_change',
    present_ui: 'read',                                                              // a surface in the conversation: no file, command or network
    request_input: 'read', return_ui_result: 'read',                                 // a form, a task's data: in the conversation only
    read_ui: 'read',                                                                 // a surface as stored: changes nothing
    ssh_connect: 'state_change', open_ssh_session: 'state_change', forward_port: 'state_change',   // a host saved and connected, a session started, a port bound
    ssh_hosts: 'read', ssh_directories: 'read',                                      // the saved hosts, a host's folders: change nothing
  })
})

test('every text the app puts before a model names only tools that exist; the system text is short and says where the answer goes', () => {
  const texts = [INSTRUCTIONS, ...specs().map((s) => `${s.summary}\n${s.description}`), ...Object.values(PROMPT_TEXT)]
  for (const text of texts) for (const name of RETIRED) expect(new RegExp(`\\b${name}\\b`).test(text), `${name} in: ${text.slice(0, 80)}`).toBe(false)
  expect(INSTRUCTIONS).toBe(PROMPT_TEXT.system)
  expect(INSTRUCTIONS.length).toBe(505)
  expect(INSTRUCTIONS).toContain('Put the answer in the chat.')
  expect(INSTRUCTIONS).not.toMatch(/coding agent|git worktree|Verify your work|Keep going|report/)
  for (const s of specs()) expect(s.description).toBe(PROMPT_TEXT[`tool.${s.name}` as keyof typeof PROMPT_TEXT])
})

/** A script that plays its steps in order, each from what the run has seen so far. */
function playing(steps: ((messages: ModelMessage[]) => ReturnType<typeof modelResponse>)[]) {
  let n = 0
  return (messages: ModelMessage[]) => {
    const step = steps[n] ?? (() => modelResponse([textPart('done')]))
    n += 1
    return step(messages)
  }
}

test('a write over an existing file needs this run to have read it, at the version it is now', async () => {
  state = await appState({ sandbox: true })
  const out: Record<string, Record<string, unknown>> = {}
  const take = (key: string, tool: string) => (messages: ModelMessage[]) => { out[key] = rec(lastToolReturn(messages, tool)); return null }
  const edit = { path: 'calc.py', old_string: 'return a - b   # the bug: this should add', new_string: 'return a + b' }
  setModel(state, 'scripted:a', scriptedModel(playing([
    () => modelResponse([toolCallPart('edit_file', edit, '')]),
    (m) => { take('unread', 'edit_file')(m); return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, '')]) },
    (m) => { take('read', 'read_file')(m); return modelResponse([toolCallPart('bash', { command: 'echo "# touched" >> calc.py' }, '')]) },
    () => modelResponse([toolCallPart('edit_file', edit, '')]),
    (m) => { take('stale', 'edit_file')(m); return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, '')]) },
    () => modelResponse([toolCallPart('edit_file', edit, '')]),
    (m) => { take('edited', 'edit_file')(m); return modelResponse([toolCallPart('edit_file', { ...edit, old_string: 'return a + b', new_string: 'return b + a' }, '')]) },
    (m) => { take('again', 'edit_file')(m); return modelResponse([toolCallPart('write_file', { path: 'README.md', content: '# replaced\n' }, '')]) },
    (m) => { take('unread_write', 'write_file')(m); return modelResponse([toolCallPart('write_file', { path: 'docs/notes.md', content: '# notes\n' }, '')]) },
    (m) => { take('created', 'write_file')(m); return modelResponse([toolCallPart('read_file', { path: 'docs' }, '')]) },
    (m) => { take('listing', 'read_file')(m); return modelResponse([textPart('done')]) },
  ])))
  const { session, ws } = await openSession(state, buggyRepo())
  const run = await state.runs.start(session, 'fix add')
  await collectEvents(state, run.id)
  expect(out.unread!.status).toBe('refused')
  expect(out.unread!.reason as string).toContain('Read calc.py with read_file in this run before replacing it.')
  expect(out.read!.content as string).toContain('return a - b')
  expect('sha256' in out.read!).toBe(false)                                        // the version stays with the harness
  expect(out.stale!.status).toBe('refused')
  expect(out.stale!.reason as string).toContain('changed after your last read')
  expect(out.edited!.status).toBe('ok')
  expect(out.edited!.action).toBe('edited')
  expect(out.edited!.diff as string).toMatch(/\n\+\s+return a \+ b/)
  expect(out.again!.status).toBe('ok')                                             // its own write is the version it knows
  expect(out.unread_write!.status).toBe('refused')
  expect(out.created!.status).toBe('ok')
  expect(out.created!.action).toBe('created')
  expect(out.listing!.kind).toBe('directory')
  expect(out.listing!.files).toEqual(['docs/notes.md'])
  expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toContain('return b + a')
  expect(readFileSync(join(ws.path, 'README.md'), 'utf8')).toStartWith('# calc')
})

test('the harness pins the final state of a run that changed something, once', async () => {
  state = await appState()
  setModel(state, 'scripted:a', scriptedModel(playing([
    () => modelResponse([toolCallPart('write_file', { path: 'NOTES.md', content: '# notes\n' }, '')]),
    () => modelResponse([textPart('wrote the notes')]),
  ])))
  const { session, ws } = await openSession(state, buggyRepo())
  const first = await state.runs.start(session, 'write notes')
  const events = await collectEvents(state, first.id)
  const pinned = events.filter((e) => e.event === 'checkpoint')
  expect(pinned).toHaveLength(1)
  expect(pinned[0]!.data.final).toBe(true)
  const receipt = repo.getRun(state.conn, first.id)!.receipt
  const cpId = rec(receipt.produced).final_checkpoint_id as string
  expect(cpId).toBe(pinned[0]!.data.checkpoint_id as string)
  expect(repo.getCheckpoint(state.conn, cpId)!.run_id).toBe(first.id)
  // a run that leaves the worktree as the last checkpoint has it pins nothing new
  setModel(state, 'scripted:a', scriptedModel(() => modelResponse([textPart('nothing to do')])))
  const second = await state.runs.start(session, 'look around')
  expect((await collectEvents(state, second.id)).some((e) => e.event === 'checkpoint')).toBe(false)
  expect(rec(repo.getRun(state.conn, second.id)!.receipt.produced).final_checkpoint_id).toBeNull()
  // a change nobody's tool made between runs is pinned as the workspace's state before the next run (a checkpoint of
  // no run): it is never the next run's — which, changing nothing itself, pins nothing of its own
  writeFileSync(join(ws.path, 'NOTES.md'), '# notes, edited by hand\n')
  const third = await state.runs.start(session, 'look again')
  expect((await collectEvents(state, third.id)).filter((e) => e.event === 'checkpoint')).toHaveLength(0)
  const latest = repo.latestCheckpoint(state.conn, ws.id)!
  expect(latest.run_id).toBeNull()
  expect(latest.parent_checkpoint_id).toBe(cpId)
  const thirdRow = repo.getRun(state.conn, third.id)!
  expect(rec(thirdRow.receipt.produced).final_checkpoint_id).toBeNull()
  expect(rec(thirdRow.receipt.produced).files_changed).toEqual([])
  expect(rec(rec(thirdRow.receipt.mechanical).diff)).toMatchObject({ files: 0, attribution: 'exact', base_tree_sha: repo.getSnapshot(state.conn, latest.snapshot_id)!.tree_sha })
  // a run on an untouched worktree pins nothing
  const fresh = await openSession(state, buggyRepo())
  const quiet = await state.runs.start(fresh.session, 'hello')
  expect((await collectEvents(state, quiet.id)).some((e) => e.event === 'checkpoint')).toBe(false)
})

test("every tool's call names what it works on to the thread while it runs: each has its summarised keys, each key one of its arguments", () => {
  expect(Object.keys(TOOL_CALL_METADATA_KEYS).filter((name) => !(DIRECTOR_ONLY_METADATA_TOOLS as readonly string[]).includes(name)).sort()).toEqual(specs().map((s) => s.name).sort())
  for (const spec of specs()) {
    const keys = TOOL_CALL_METADATA_KEYS[spec.name]
    expect(keys, spec.name).toBeDefined()
    const args = Object.keys((parametersSchema(spec).properties ?? {}) as Record<string, unknown>)
    // the provider's own search names its page actions under the harness's tool name (OpenAI's open_page and find)
    const providers = spec.name === 'web_search' ? ['action', 'url', 'pattern'] : []
    for (const key of keys!) expect([...args, ...providers], `${spec.name}.${key}`).toContain(key)
  }
  // a bash call streams its command (the row reads "<command> · exit 0", not "exit 0" alone)
  const [name, data] = mapStreamEvent({ type: 'tool_call', part: toolCallPart('bash', '{"command":"ls -la","wait_s":120}', 'c1') })!
  expect(name).toBe('tool_call')
  expect(data).toMatchObject({ tool: 'bash', command: 'ls -la' })
})
