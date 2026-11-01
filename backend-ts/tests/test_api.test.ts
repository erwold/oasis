/** The HTTP surface: token + origin protection, project import, session, chat, SSE events with a cursor, transcript,
 *  approvals, workspace evidence; the run tree, work orders, the gate, the context report, the replay and the folder
 *  browser over the API. */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ROUTES } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { CONNECTOR_HEADER } from '../src/api/auth.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart, userTexts } from '../src/llm/messages.ts'
import { treeRow } from '../src/api/common.ts'
import { servedUiBuild } from '../src/api/meta.ts'
import { ModelConfig, defaultMaxTokens } from '../src/config.ts'
import { createApp, type App } from '../src/main.ts'
import { Client, HEADERS, json, makeApp, parseSse } from './api_harness.ts'
import { buggyRepo, collectEvents, git, scriptedModel, setModel, steps, testConfig, testSettings, waitDone } from './harness.ts'
import { CHILD_MODEL, childScript, PARENT_MODEL, rec, toolNames } from './tree_helpers.ts'
import { tempDir } from './helpers.ts'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

async function openOverApi(c: Client, repoPath: string, title = 'tree') {
  const project = await json(await c.post('/api/projects', { source_path: repoPath }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title }))
  return { project, session }
}

const fixingScript = () => steps(
  [toolCallPart('read_file', { path: 'calc.py' }, '')],
  [toolCallPart('edit_file', { path: 'calc.py', old_string: 'a - b   # the bug: this should add', new_string: 'a + b' }, '')],
  [textPart('Patched calc.py (unverified: no command ran).')],
)

test('the route table is served: every frozen route answers something other than 404', async () => {
  app = await makeApp()
  const c = new Client(app)
  for (const route of ROUTES) {
    const path = route.path.replace(/:[a-z_]+/g, 'x_nope')
    const res = await c.request(route.method, path, { json: route.method === 'GET' ? undefined : {} })
    // a route that exists refuses or answers; only an unknown path is the app's generic 404
    if (res.status === 404) expect((await json(res, 404)).detail).not.toBe('Not Found')
  }
  expect((await json(await c.get('/api/nope'), 404)).detail).toBe('Not Found')
})

test('auth and origin', async () => {
  app = await makeApp()
  const c = new Client(app, { headers: {} })
  expect((await c.get('/api/projects')).status).toBe(401)
  expect((await c.get('/api/meta/build')).status).toBe(200)                                   // the handshake is public
  expect((await c.get('/api/projects', undefined, { 'x-oasis-code-token': 'wrong' })).status).toBe(401)
  expect((await c.get('/api/projects', undefined, HEADERS)).status).toBe(200)
  expect((await c.post('/api/projects', { name: 'x' }, { ...HEADERS, origin: 'http://evil.example' })).status).toBe(403)
  expect((await c.post('/api/projects', { name: 'x' }, { 'x-oasis-code-token': 'test-token', 'sec-fetch-site': 'cross-site' })).status).toBe(403)
  // the cookie route: the startup token logs the browser in with an HttpOnly cookie
  const r = await c.get('/api/auth/session', { token: 'test-token' })
  expect(r.status).toBe(303)
  const cookie = r.headers.get('set-cookie') ?? ''
  expect(cookie).toContain('oasis_code_session')
  expect(cookie).toContain('HttpOnly')
  expect((await c.get('/api/auth/session', { token: 'nope' })).status).toBe(401)
  expect((await c.get('/api/projects', undefined, { cookie: 'oasis_code_session=test-token' })).status).toBe(200)
})

test("test_agent_browser_refused: what the agent's browser sends never reaches the API — not with the cookie, not the sign-in, not a decision", async () => {
  app = await makeApp()
  const c = new Client(app, { headers: {} })
  const mark = { 'x-oasis-code-agent-browser': '1' }
  const cookie = { cookie: 'oasis_code_session=test-token' }
  const refused = async (res: Response) => {
    expect(res.status).toBe(403)
    expect(String((await res.json() as Record<string, unknown>).detail)).toContain("the agent's browser")
  }
  await refused(await c.get('/api/projects', undefined, { ...cookie, ...mark }))
  await refused(await c.get('/api/projects', undefined, { ...HEADERS, ...mark }))
  await refused(await c.get('/api/auth/session', { token: 'test-token' }, mark))
  await refused(await c.post('/api/action-proposals/a_1/decide', { decision: 'approve' }, { ...cookie, ...mark, origin: 'http://localhost' }))
  await refused(await c.post('/api/approvals/ap_1', { approve: true }, { ...cookie, ...mark, origin: 'http://localhost' }))
  // the app window and the person's own browser carry no mark: the same requests go through
  expect((await c.get('/api/projects', undefined, cookie)).status).toBe(200)
  expect((await c.get('/api/auth/session', { token: 'test-token' })).status).toBe(303)
})

test('a percent-encoded path is the path the router matches: it needs the token and the same origin too', async () => {
  app = await makeApp()
  const c = new Client(app, { headers: {} })
  for (const path of ['/%61pi/projects', '/api/%70rojects', '/%61%70%69/projects']) {
    expect((await c.get(path)).status).toBe(401)
    expect((await c.post(path, { name: 'x' }, { origin: 'http://evil.example' })).status).toBe(401)
    expect((await c.post(path, { name: 'x' }, { ...HEADERS, origin: 'http://evil.example' })).status).toBe(403)
    expect((await c.get(path, undefined, HEADERS)).status).toBe(200)
  }
  expect((await c.get('/api/auth/sessionx')).status).toBe(401)                        // a public route is a path, not a prefix
  expect((await c.get('/api/meta/build%2F..%2F..%2Fprojects')).status).not.toBe(200)
})

test('project, session, chat, events, transcript', async () => {
  app = await makeApp()
  const { state } = app
  setModel(state, 'scripted:a', scriptedModel(fixingScript()))
  const c = new Client(app)
  const src = buggyRepo()
  const project = await json(await c.post('/api/projects', { source_path: src, instructions: 'Run python3 -m unittest.' }))
  expect((rec(project.import_report).basis as string)).toStartWith('the committed HEAD')
  expect(rec(project.config).instructions).toBeTruthy()
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'fix add' }))
  expect(rec(session.workspace).path).toBeTruthy()
  expect(rec(session.grants).network).toBe(true)                                  // the network is part of the default grant
  const models = await json(await c.get('/api/models'))
  // the configured routes, and ChatGPT on the web (the desktop app's page)
  expect(new Set((models.models as Record<string, unknown>[]).map((m) => m.id))).toEqual(new Set(['scripted:a', 'scripted:b', 'chatgpt:web']))
  expect((models.models as Record<string, unknown>[]).every((m) => m.credential === 'unavailable' && (m.cost_basis as string).startsWith('unknown'))).toBe(true)
  const run = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'fix add()' }))
  expect((await c.post(`/api/sessions/${session.id}/chat`, { text: 'again' })).status).toBe(409)
  // the event stream, then again from a cursor
  const stream = await c.get(`/api/runs/${run.id}/events`)
  expect(stream.status).toBe(200)
  expect(stream.headers.get('content-type')).toContain('text/event-stream')
  const events = parseSse(await stream.text())
  const names = events.map((e) => e.event)
  expect(names[0]).toBe('run_started')
  expect(names.at(-1)).toBe('run_finished')
  expect(names).toContain('tool_call')
  expect(names).toContain('tool_result')
  // payloads arrive as objects, encoded exactly once
  expect(events[0]!.data.model).toBe('scripted:a')
  expect(events.filter((e) => e.event === 'tool_call').map((e) => e.data.tool)).toEqual(['read_file', 'edit_file'])
  expect(events.filter((e) => e.event === 'checkpoint').map((e) => e.data.final)).toEqual([true])      // the harness pinned the final state
  expect(events.some((e) => e.event === 'text_block' && (e.data.text as string).startsWith('Patched'))).toBe(true)
  const ids = events.map((e) => e.id)
  expect(ids).toEqual([...ids].sort((a, b) => a - b))
  expect(new Set(ids).size).toBe(ids.length)
  const cursor = ids[3]!
  const replay = parseSse(await (await c.get(`/api/runs/${run.id}/events`, undefined, { 'last-event-id': String(cursor) })).text())
  expect(replay.length).toBeGreaterThan(0)
  expect(replay.every((e) => e.id > cursor)).toBe(true)
  const byQuery = parseSse(await (await c.get(`/api/runs/${run.id}/events`, { after: cursor })).text())
  expect(byQuery.map((e) => e.id)).toEqual(replay.map((e) => e.id))
  expect((await c.get('/api/runs/run_nope/events')).status).toBe(404)
  await waitDone(state, run.id as string)
  const detail = await json(await c.get(`/api/runs/${run.id}`))
  expect(detail.status).toBe('done')
  expect(rec(rec(detail.receipt).mechanical).tool_calls).toBe(2)
  expect((detail.requests as Record<string, unknown>[])[0]!.cost_status).toBe('unknown')
  expect((rec(detail.manifest).project_instruction_sources as string[])[0]).toStartWith('project settings')
  const transcript = await json(await c.get(`/api/runs/${run.id}/transcript`))
  const entries = transcript.entries as Record<string, unknown>[]
  const kinds = entries.map((e) => e.kind)
  expect(kinds[0]).toBe('user')
  expect(entries[0]!.text).toBe('fix add()')
  expect(kinds.filter((k) => k === 'activity')).toHaveLength(2)
  expect(kinds.at(-1)).toBe('agent')
  // a row opened: the call as its model saw it — the file it read (numbered lines), the change it made — not a summary
  const [readRow, editRow] = entries.filter((e) => e.kind === 'activity')
  const readCall = await json(await c.get(`/api/runs/${run.id}/calls/${readRow!.toolCallId}`))
  expect([readCall.tool, rec(readCall.args).path, readCall.cut]).toEqual(['read_file', 'calc.py', false])
  expect(rec(readCall.result).content as string).toMatch(/^1\tdef add\(a, b\):/)
  expect(readRow!.result as object).not.toHaveProperty('content')                       // the row itself keeps the summary
  const editCall = await json(await c.get(`/api/runs/${run.id}/calls/${editRow!.toolCallId}`))
  expect(rec(editCall.result).diff as string).toContain('+    return a + b')
  expect((await json(await c.get(`/api/runs/${run.id}/calls/toolu_nope`), 404)).detail).toContain('no tool call toolu_nope')
  // evidence: the diff (with new-file support and review flags), the checkpoint list, the status
  const wsId = rec(session.workspace).id as string
  const diff = await json(await c.get(`/api/workspaces/${wsId}/diff`))
  expect(diff.patch as string).toContain('+    return a + b')
  expect(diff.review_flags).toEqual([])
  expect(diff.patch_cut).toBeNull()                                                      // small enough to send whole
  expect((diff.files as Record<string, unknown>[])[0]!.path).toBe('calc.py')
  // full=1: the file whole, its unchanged lines as context — the context and added lines are the file as it stands
  const whole = (patch: string) => patch.split('\n').filter((l) => /^[ +](?!\+\+ )/.test(l)).map((l) => l.slice(1)).join('\n')
  const onDisk = readFileSync(join(rec(session.workspace).path as string, 'calc.py'), 'utf8').replace(/\n$/, '')
  expect(whole((await json(await c.get(`/api/workspaces/${wsId}/diff?path=calc.py&full=1`))).patch as string)).toBe(onDisk)
  expect(whole((await json(await c.get(`/api/runs/${run.id}/diff?path=calc.py&full=1`))).patch as string)).toBe(onDisk)
  const ws = await json(await c.get(`/api/workspaces/${wsId}`))
  expect(ws.checkpoints as unknown[]).toHaveLength(1)
  expect(rec(ws.status).modified).toEqual(['calc.py'])
  expect(ws.lock_owner).toBeNull()
  const sess = await json(await c.get(`/api/sessions/${session.id}`))
  expect((sess.runs as Record<string, unknown>[])[0]!.status).toBe('done')
  expect(sess.active_run).toBeNull()
  const projects = await json<Record<string, unknown>[]>(await c.get('/api/projects'))
  expect((projects[0]!.sessions as Record<string, unknown>[])[0]!.id).toBe(session.id)
  // the workspace's files and one file, as a run's tools see them; the entity picker; an asset's text
  const listing = await json(await c.get(`/api/workspaces/${wsId}/files`))
  expect(new Set((listing.entries as Record<string, unknown>[]).map((e) => e.path))).toEqual(new Set(['.gitignore', 'README.md', 'calc.py', 'test_calc.py']))
  const file = await json(await c.get(`/api/workspaces/${wsId}/file`, { path: 'calc.py', limit_lines: 2 }))
  expect(file.truncated).toBe(true)
  expect(file.sha256).toBeTruthy()
  expect((await json(await c.get(`/api/workspaces/${wsId}/file`, { path: '../x' }), 400)).detail as string).toContain("'..' is refused")
  const entities = await json(await c.get(`/api/workspaces/${wsId}/entities`, { q: 'add' }))
  expect((entities.symbols as Record<string, unknown>[]).some((s) => s.name === 'add')).toBe(true)
  expect((await c.get('/api/assets/a_nope')).status).toBe(404)
  // the project's config: checks are validated, instructions kept
  const configured = await json(await c.put(`/api/projects/${project.id}/config`, { checks: [{ id: 'unit', command: 'python3 -m unittest -q', parser: 'exit_code', timeout_s: 60 }] }))
  expect((rec(configured.config).checks as Record<string, unknown>[])[0]!.id).toBe('unit')
  expect(rec(configured.config).instructions).toBe('Run python3 -m unittest.')
  expect((await c.put(`/api/projects/${project.id}/config`, { checks: [{ id: 'x' }] })).status).toBe(422)
  expect((await c.get('/api/projects/p_nope')).status).toBe(404)
})

test('a grant the person withheld asks them; approvals are bound to parameters', async () => {
  app = await makeApp()
  const { state } = app
  setModel(state, 'scripted:a', scriptedModel(steps(
    [toolCallPart('bash', { command: 'curl https://example.com' }, '')],
    (m) => modelResponse([textPart(JSON.stringify(lastToolReturn(m, 'bash')))]),
  )))
  const c = new Client(app)
  const { session } = await openOverApi(c, buggyRepo())
  // without isolation the command is refused before any grant matters; refuse commands so the gate speaks first
  const grants = rec((await json(await c.put(`/api/sessions/${session.id}/grants`, { run_commands: false }))).grants)
  expect(grants.run_commands).toBe(false)
  const run = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'fetch' }))
  await waitDone(state, run.id as string)
  const result = JSON.parse(state.runs.handles.get(run.id as string)!.final_text) as Record<string, unknown>
  expect(result.status).toBe('refused_by_policy')
  expect(result.action).toBe('run_command')
  expect(result.approval_id).toBeTruthy()
  const pending = (await json(await c.get(`/api/sessions/${session.id}`))).pending_approvals as Record<string, unknown>[]
  expect(pending).toHaveLength(1)
  expect(rec(pending[0]!.params).command).toBe('curl https://example.com')
  const gated = state.runs.handles.get(run.id as string)!.events.filter((e) => e.event === 'action_gated')
  expect(gated.length).toBeGreaterThan(0)
  expect(gated[0]!.data.approval_id).toBe(pending[0]!.id)
  // deciding it, and a second decision on the same approval is refused
  expect((await json(await c.post(`/api/approvals/${pending[0]!.id}`, { approve: true }))).status).toBe('approved')
  expect((await c.post(`/api/approvals/${pending[0]!.id}`, { approve: true })).status).toBe(409)
  expect((await c.post('/api/approvals/a_nope', { approve: true })).status).toBe(404)
  // an approval for other parameters does not unlock this action: a different command is refused again
  const sess = repo.getSession(state.conn, session.id as string)!
  expect(rec(state.gate.check(sess, 'run_command', { command: 'rm -rf /' }, { run_id: null, tool_call_id: null })).status).toBe('refused_by_policy')
  expect(state.gate.check(sess, 'run_command', { command: 'curl https://example.com' }, { run_id: null, tool_call_id: null })).toBeNull()      // consumed once
  expect(rec(state.gate.check(sess, 'run_command', { command: 'curl https://example.com' }, { run_id: null, tool_call_id: null })).status).toBe('refused_by_policy')
  // the network grant with a duration, the session model, a thinking level the API refuses
  const granted = await json(await c.put(`/api/sessions/${session.id}/grants`, { network: true, network_minutes: 5, network_reason: 'docs' }))
  expect(rec(granted.grants).network).toBe(true)
  expect(rec(granted.grants).network_until).toBeTruthy()
  expect((await json(await c.put(`/api/sessions/${session.id}/model`, { model: 'scripted:b' }))).model).toBe('scripted:b')
  expect((await c.put(`/api/sessions/${session.id}/model`, { model: 'nope' })).status).toBe(400)
  expect((await c.post(`/api/sessions/${session.id}/chat`, { text: 'x', thinking: 'ultra' })).status).toBe(400)
  expect((await c.post(`/api/sessions/${session.id}/chat`, { text: '  ' })).status).toBe(400)
  expect((await c.post(`/api/sessions/${session.id}/chat`, { text: 'x', model: 'nope' })).status).toBe(400)
})

test('build handshake and surface', async () => {
  app = await makeApp()
  const c = new Client(app)
  const build = await json(await c.get('/api/meta/build'))
  expect(build.api_version).toBe('code-v1')
  expect((build.source_fingerprint as string).length).toBe(12)
  expect(rec(build.isolation).enforcement).toBe('unavailable')
  expect(build.schema_version).toBe(37)                                           // v29: the sessions' task and roots; v28: the sessions' access and the access caps; v27: the sessions' latest activity; v26: the session cursor; v25: the collaboration model; v21: the UI surfaces and their action receipts; v22: the UI tasks and input requests; v23: session-scoped surfaces, the publication journal; v30: SSH targets; v31: SSH connect intent; v32: CNY costs, v33 read-path indexes
  expect(build.ui_build).toBe(servedUiBuild())
  const surface = await json(await c.get('/api/agent/surface'))
  const names = new Set((surface.tools as Record<string, unknown>[]).map((t) => t.name))
  expect([...names].sort()).toEqual(['bash', 'bash_output', 'computer_act', 'computer_observe', 'edit_file', 'fetch_url', 'forward_port', 'generate_image', 'open_ssh_session', 'present_ui', 'read_file', 'read_ui', 'request_input', 'return_ui_result', 'ssh_connect', 'ssh_directories', 'ssh_hosts', 'stop_command', 'watch', 'web_search', 'write_file'])
  expect(names.size).toBe(21)
  expect((surface.tools as Record<string, unknown>[]).every((t) => t.renderer)).toBe(true)
  expect((await json(await c.get('/api/meta/isolation'))).enforcement).toBe('unavailable')
})

// -- the run tree over the API ------------------------------------------------------------------

test('an order run over the API: tree, receipt, resume and cancel', async () => {
  app = await makeApp()
  const { state } = app
  setModel(state, PARENT_MODEL, scriptedModel(steps([textPart('thread done')])))
  setModel(state, CHILD_MODEL, scriptedModel(childScript('tree child done')))
  const c = new Client(app)
  const { session } = await openOverApi(c, buggyRepo())
  const run = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'root via api', model: PARENT_MODEL }))
  await collectEvents(state, run.id as string)
  const child = await json(await c.post(`/api/sessions/${session.id}/work-orders`, { work_order: { label: '盘点', prompt: 'count the files and report the number', model: CHILD_MODEL } }))
  const childId = child.id as string
  await collectEvents(state, childId)
  const tree = await json(await c.get(`/api/sessions/${session.id}/runs/tree`))
  const rows = Object.fromEntries((tree.runs as Record<string, unknown>[]).map((row) => [row.id as string, row]))
  expect(rows[run.id as string]!.parent_run_id).toBeNull()
  expect(rows[run.id as string]!.status).toBe('done')
  expect(rows[childId]!.parent_run_id).toBeNull()                                 // runs dispatch no runs: an order run stands beside the thread
  expect(rows[childId]!.spawned_by).toBe('human')
  expect(rows[childId]!.label).toBe('盘点')
  expect(rows[childId]!.model).toBe(CHILD_MODEL)
  expect(Object.keys(rows[childId]!)).not.toContain('verdict')
  // a run of its own carries the plan's fields empty: the outline reads them on every row
  expect([rows[childId]!.plan_node_id, rows[childId]!.participant_alias, rows[childId]!.depends_on, rows[childId]!.scheduled_by, rows[childId]!.kind]).toEqual([null, null, [], null, 'run'])
  expect(rec(rows[childId]!.work_order).prompt as string).toStartWith('count')
  expect(rec(rows[childId]!.receipt).final_text).toBe('tree child done')
  expect(rows[childId]!.user_text_head as string).toStartWith('count the files')
  // the thread shows its own run only
  const sess = await json(await c.get(`/api/sessions/${session.id}`))
  expect((sess.runs as Record<string, unknown>[]).map((r) => r.id)).toEqual([run.id])
  const receipt = await json(await c.get(`/api/runs/${childId}/receipt`))
  expect(receipt.status).toBe('done')
  expect(rec(receipt.receipt).run_id).toBe(childId)
  expect(rec(receipt.receipt).version).toBe(3)
  expect('self_report' in rec(receipt.receipt)).toBe(false)
  expect((await c.get('/api/runs/run_nope/receipt')).status).toBe(404)
  const transcript = await json(await c.get(`/api/runs/${childId}/transcript`))
  expect((transcript.entries as Record<string, unknown>[])[0]!.kind).toBe('user')
  expect((transcript.entries as Record<string, unknown>[])[0]!.text as string).toStartWith('count the files')
  // a follow-up to the finished order run: a new run on its worktree, continuing its conversation
  const seen: Record<string, unknown> = {}
  setModel(state, CHILD_MODEL, scriptedModel((messages, info) => { seen.texts = userTexts(messages); seen.tools = toolNames(info); return modelResponse([textPart('child continued')]) }))
  const resumed = await json(await c.post(`/api/runs/${childId}/resume`, { text: 'and now count the lines' }))
  expect(resumed.resumes_run_id).toBe(childId)
  expect(resumed.parent_run_id).toBeNull()
  expect(resumed.spawned_by).toBe('human')
  expect(resumed.label).toBe('盘点')
  expect(resumed.workspace_id).toBe(rows[childId]!.workspace_id)
  expect(rec(resumed.work_order).prompt).toBe('and now count the lines')
  await collectEvents(state, resumed.id as string)
  const texts = seen.texts as string[]
  expect(texts.some((t) => t.includes('count the files'))).toBe(true)
  expect(texts.some((t) => t.includes('count the lines'))).toBe(true)
  expect(texts.some((t) => t.includes('root via api'))).toBe(false)
  expect(seen.tools as string[]).toContain('read_file')
  expect(repo.getRun(state.conn, resumed.id as string)!.receipt.final_text).toBe('child continued')
  expect((await c.post('/api/runs/run_nope/resume', { text: 'x' })).status).toBe(404)
  expect((await c.post(`/api/runs/${childId}/resume`, { text: '  ' })).status).toBe(400)
  expect((await c.post(`/api/runs/${childId}/resume`, { text: 'x', model: 'nope:model' })).status).toBe(400)
  // the follow-up did not touch the session's conversation
  expect(repo.latestRunOfSession(state.conn, session.id as string)!.id).toBe(run.id as string)
  // schema v25 (docs/multi-agent-unification-design.md §5.2): a thread run is resumed as the main agent's own next run —
  // the old 400 ("continue it from the thread") is gone by design; the thread's conversation continues from it
  const threadResume = await json(await c.post(`/api/runs/${run.id}/resume`, { text: 'x' }))
  expect(threadResume.resumes_run_id).toBe(run.id as string)
  expect(rec(threadResume.collab).participant_role).toBe('main')
  await collectEvents(state, threadResume.id as string)
  // a live order run cannot be resumed; it shows beside the thread and Stop ends it
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  setModel(state, CHILD_MODEL, scriptedModel(async () => { await gate; return modelResponse([textPart('late')]) }))
  const live = await json(await c.post(`/api/sessions/${session.id}/work-orders`, { work_order: { prompt: 'take your time', model: CHILD_MODEL } }))
  const liveId = live.id as string
  expect((await c.post(`/api/runs/${liveId}/resume`, { text: 'hurry' })).status).toBe(409)
  const sess2 = await json(await c.get(`/api/sessions/${session.id}`))
  expect(sess2.active_run).toBeNull()
  expect((sess2.active_children as Record<string, unknown>[]).map((h) => h.id)).toEqual([liveId])
  expect((await json(await c.post(`/api/runs/${liveId}/cancel`))).cancelled).toBe(true)
  await waitDone(state, liveId, 5000)
  expect(repo.getRun(state.conn, liveId)!.status).toBe('cancelled')
  release()
  expect((await c.post('/api/runs/run_nope/cancel')).status).toBe(404)
})

test("a person's checkpoint is a node and never the thread", async () => {
  app = await makeApp()
  const { state } = app
  setModel(state, PARENT_MODEL, scriptedModel(steps([textPart('hi')])))
  const c = new Client(app)
  const { session } = await openOverApi(c, buggyRepo())
  const wsId = rec(session.workspace).id as string
  writeFileSync(join(rec(session.workspace).path as string, 'notes.md'), 'by hand\n')
  const cp = await json(await c.post(`/api/workspaces/${wsId}/checkpoint`, { note: 'my own note' }))
  const tree = (await json(await c.get(`/api/sessions/${session.id}/runs/tree`))).runs as Record<string, unknown>[]
  const human = tree.filter((r) => r.spawned_by === 'human_action')
  expect(human).toHaveLength(1)
  expect(human[0]!.label).toBe('checkpoint (by hand)')
  expect(human[0]!.status).toBe('done')
  expect(human[0]!.model).toBeNull()
  expect(rec(rec(human[0]!.receipt).produced).checkpoints).toEqual([cp.id])
  expect(rec(rec(human[0]!.receipt).mechanical).human_action).toBe('checkpoint')
  expect(rec(rec(human[0]!.receipt).produced).files_changed).toEqual(['notes.md'])
  // the same action carried by a connector says whose it was: not the person's hand
  writeFileSync(join(rec(session.workspace).path as string, 'notes.md'), 'by the director\n')
  await json(await c.post(`/api/workspaces/${wsId}/checkpoint`, { note: 'the director\'s note' }, { [CONNECTOR_HEADER]: 'ChatGPT' }))
  const after = ((await json(await c.get(`/api/sessions/${session.id}/runs/tree`))).runs as Record<string, unknown>[]).filter((r) => r.spawned_by === 'human_action')
  expect(after.map((r) => r.label).sort()).toEqual(['checkpoint (ChatGPT)', 'checkpoint (by hand)'])
  expect(rec(rec(human[0]!.receipt).mechanical).checks).toEqual({ passed: 0, failed: 0, unknown: 0, not_run: 0 })
  // the thread is untouched: no run to continue, the next chat starts the conversation
  const sess = await json(await c.get(`/api/sessions/${session.id}`))
  expect(sess.runs).toEqual([])
  expect(repo.latestRunOfSession(state.conn, session.id as string)).toBeNull()
  const run = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'hello', model: PARENT_MODEL }))
  await collectEvents(state, run.id as string)
  expect(run.resumes_run_id).toBeNull()
  expect((await c.post(`/api/runs/${human[0]!.id}/resume`, { text: 'x' })).status).toBe(400)
  // verify with no checks configured; the checkpoint and the check rows are on the workspace
  const verdict = await json(await c.post(`/api/workspaces/${wsId}/verify`, {}))
  expect(verdict.results).toEqual([])
  expect(verdict.note).toBe('no checks configured for this project')
  expect((await c.post('/api/workspaces/ws_nope/checkpoint', { note: 'x' })).status).toBe(404)
  expect((await c.post(`/api/workspaces/${wsId}/integrate`, { checkpoint_ids: [] })).status).toBe(400)
})

test('a person dispatches an order over the API', async () => {
  app = await makeApp()
  const { state } = app
  const seen: Record<string, unknown> = {}
  setModel(state, PARENT_MODEL, scriptedModel(steps([textPart('thread')])))
  setModel(state, CHILD_MODEL, scriptedModel((messages, info) => { seen.tools = toolNames(info); seen.texts = userTexts(messages); return modelResponse([textPart('inventory done')]) }))
  const c = new Client(app)
  const { session } = await openOverApi(c, buggyRepo(), 'orders')
  const sid = session.id as string
  const wsId = rec(session.workspace).id as string
  const thread = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'hello thread', model: PARENT_MODEL }))
  await collectEvents(state, thread.id as string)
  for (const bad of [{ prompt: 'x', tools: ['no_such'] }, { prompt: 'x', model: 'nope:model' }, { prompt: 'x', workspace: { base: 'cp_nope' } }]) {
    expect((await c.post(`/api/sessions/${sid}/work-orders`, { work_order: bad })).status, JSON.stringify(bad)).toBe(400)
  }
  const order = { label: '盘点', prompt: 'count the files', model: CHILD_MODEL, tools: ['read_file'], read_only: true }
  const run = await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: order }))
  expect(run.spawned_by).toBe('human')
  expect(run.parent_run_id).toBeNull()
  expect(run.label).toBe('盘点')
  expect(rec(run.work_order).read_only).toBe(true)
  expect(rec(run.work_order).model).toBe(CHILD_MODEL)
  expect(run.workspace_id).not.toBe(wsId)
  await collectEvents(state, run.id as string)
  expect(seen.tools).toEqual(['read_file'])
  expect((seen.texts as string[]).some((t) => t.includes('hello thread'))).toBe(false)             // an order run starts from its own context
  const childWs = repo.getWorkspace(state.conn, run.workspace_id as string)!
  expect(childWs.kind).toBe('child')
  expect(childWs.session_id).toBe(sid)
  expect(repo.listCheckpoints(state.conn, wsId).map((cp) => cp.commit_sha)).toContain(childWs.base_commit)
  // the thread's conversation is untouched by the order run; the tree shows both
  const sess = await json(await c.get(`/api/sessions/${sid}`))
  expect((sess.runs as Record<string, unknown>[]).map((r) => r.id)).toEqual([thread.id])
  expect(sess.active_run).toBeNull()
  const tree = (await json(await c.get(`/api/sessions/${sid}/runs/tree`))).runs as Record<string, unknown>[]
  const row = tree.find((r) => r.id === run.id)!
  expect(row.model).toBe(CHILD_MODEL)
  expect(rec(row.receipt).final_text).toBe('inventory done')
  expect(Object.keys(row)).not.toContain('verdict')
  expect(new Set(tree.map((r) => r.id))).toEqual(new Set([thread.id, run.id]))
  const receipt = await json(await c.get(`/api/runs/${run.id}/receipt`))
  expect(rec(rec(receipt.receipt).produced).workspace_id).toBe(childWs.id)
  // an order may start from a named checkpoint instead of the workspace's state now
  const base = repo.listCheckpoints(state.conn, wsId)[0]!
  const pinned = await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { ...order, workspace: { base: base.id } } }))
  expect(repo.getWorkspace(state.conn, pinned.workspace_id as string)!.base_commit).toBe(base.commit_sha)
  await collectEvents(state, pinned.id as string)
  // while the thread's run writes the workspace, an order from its state now is refused (409); a checkpoint base is not
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  setModel(state, PARENT_MODEL, scriptedModel(async () => { await gate; return modelResponse([textPart('held')]) }))
  const live = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'hold', model: PARENT_MODEL }))
  for (let i = 0; i < 100 && state.locks.holder(wsId) === null; i += 1) await new Promise((r) => setTimeout(r, 20))
  expect((await c.post(`/api/sessions/${sid}/work-orders`, { work_order: order })).status).toBe(409)
  const beside = await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { ...order, workspace: { base: base.id } } }))
  await collectEvents(state, beside.id as string)
  release()
  await collectEvents(state, live.id as string)
})

test('the gate over the API', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const { session } = await openOverApi(c, buggyRepo())
  const sid = session.id as string
  const control = await json(await c.get(`/api/sessions/${sid}/agent-control`))
  expect(rec(control.control).desired_state).toBe('run')
  expect(control.effect_tags as string[]).toContain('workspace_write')
  const paused = await json(await c.post(`/api/sessions/${sid}/agent-control`, { desired_state: 'pause', gate_effects: ['workspace_write'] }))
  expect(rec(paused.control).desired_state).toBe('pause')
  expect((await c.post(`/api/sessions/${sid}/agent-control`, { desired_state: 'maybe' })).status).toBe(400)
  setModel(state, 'scripted:a', scriptedModel((m) => (!lastToolReturn(m, 'write_file')
    ? modelResponse([toolCallPart('write_file', { path: 'NEW.md', content: 'hi\n' }, '')]) : modelResponse([textPart('proposed')]))))
  const run = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'add a file' }))
  await waitDone(state, run.id as string)
  const proposals = (await json(await c.get(`/api/sessions/${sid}/action-proposals`))).proposals as Record<string, unknown>[]
  expect(proposals.map((p) => p.status)).toEqual(['pending'])
  const pid = proposals[0]!.proposal_asset_id as string
  const detail = await json(await c.get(`/api/action-proposals/${pid}`))
  expect(rec(detail.payload).tool_name).toBe('write_file')
  expect(detail.decision).toBeNull()
  const decided = await json(await c.post(`/api/action-proposals/${pid}/decide`, { decision: 'approve' }))
  expect(rec(decided.result).status).toBe('ok')
  expect(readFileSync(join(rec(session.workspace).path as string, 'NEW.md'), 'utf8')).toBe('hi\n')
  expect((await c.post(`/api/action-proposals/${pid}/decide`, { decision: 'approve' })).status).toBe(409)
  expect((await c.get('/api/action-proposals/a_nope')).status).toBe(404)
  expect((await c.post('/api/action-proposals/a_nope/decide', { decision: 'approve' })).status).toBe(404)
  // the hard locks: recorded, listed, validated
  expect((await json(await c.get(`/api/sessions/${sid}/locks`))).locks).toEqual([])
  const locks = await json(await c.put(`/api/sessions/${sid}/locks`, { locks: [{ path: 'test_calc.py', mode: 'read_only' }] }))
  expect((locks.locks as Record<string, unknown>[])[0]!.path).toBe('test_calc.py')
  expect((await c.put(`/api/sessions/${sid}/locks`, { locks: [{ path: 'x', mode: 'nonsense' }] })).status).toBe(400)
})

test('the replay merges every run of the session in time order', async () => {
  app = await makeApp()
  const { state } = app
  setModel(state, PARENT_MODEL, scriptedModel(steps([textPart('thread done')])))
  setModel(state, CHILD_MODEL, scriptedModel((m) => (!lastToolReturn(m, 'read_file') ? modelResponse([toolCallPart('read_file', { path: '.' }, '')]) : modelResponse([textPart('3 files')]))))
  const c = new Client(app)
  const { session } = await openOverApi(c, buggyRepo())
  const sid = session.id as string
  const run = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'hello', model: PARENT_MODEL }))
  await collectEvents(state, run.id as string)
  const child = await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'count', model: CHILD_MODEL } }))
  const childId = child.id as string
  await collectEvents(state, childId)
  await c.post(`/api/workspaces/${rec(session.workspace).id}/checkpoint`, { note: 'by hand' })
  const body = await json(await c.get(`/api/sessions/${sid}/replay`))
  expect((await c.get('/api/sessions/s_nope/replay')).status).toBe(404)
  const rows = Object.fromEntries((body.runs as Record<string, unknown>[]).map((r) => [r.id as string, r]))
  expect(run.id as string in rows).toBe(true)
  expect(childId in rows).toBe(true)
  expect(Object.values(rows).some((r) => r.spawned_by === 'human_action')).toBe(true)
  const events = body.events as Record<string, unknown>[]
  expect(events.map((e) => e.t)).toEqual([...events.map((e) => e.t as string)].sort())
  const byRun: Record<string, string[]> = {}
  for (const e of events) (byRun[e.run_id as string] ??= []).push(e.event as string)
  expect(byRun[run.id as string]![0]).toBe('run_started')
  expect(byRun[run.id as string]!.at(-1)).toBe('run_finished')
  expect(byRun[childId]![0]).toBe('run_started')
  expect(byRun[childId]).toContain('tool_call')
  expect(byRun[childId]!.at(-1)).toBe('run_finished')
  // the thread run ended before the order run started
  const order = events.map((e) => `${e.run_id}:${e.event}`)
  expect(order.indexOf(`${run.id}:run_finished`)).toBeLessThan(order.indexOf(`${childId}:run_started`))
  expect(events.some((e) => e.event === 'text_delta')).toBe(false)          // deltas were never persisted; their blocks were
  expect(body.t0).toBe([...(body.runs as Record<string, unknown>[]).map((r) => r.created_at as string)].sort()[0])
  expect((body.t1 as string) >= (events.at(-1)!.t as string)).toBe(true)
})

test('the context report over the API and the catalog names the window', async () => {
  const settings = testSettings()
  const config = testConfig([
    new ModelConfig({ id: 'scripted:a', label: 'Scripted A', provider: 'anthropic', model: 'scripted-a', api_key_env: 'OASIS_TEST_KEY_A' }),
    new ModelConfig({ id: 'scripted:b', label: 'Scripted B', provider: 'openai', model: 'scripted-b', api_key_env: 'OASIS_TEST_KEY_B', context_window: 400_000, window_source: 'the docs' }),
  ])
  app = await createApp(settings, config, { probe: false })
  const c = new Client(app)
  const { session } = await openOverApi(c, buggyRepo())
  const r = await json(await c.get(`/api/sessions/${session.id}/context`))
  expect(r.model_id).toBe('scripted:a')
  expect(r.context_window).toBeNull()                                                   // scripted:a has no window: assumed, not claimed
  expect(r.context_window_source as string).toContain('assumed')
  const body = await json(await c.get(`/api/sessions/${session.id}/context`, { model: 'scripted:b' }))
  expect(body.context_window).toBe(400_000)
  expect(body.budget_tokens).toBe(Math.min(Math.floor(400_000 * 0.97), 400_000 - defaultMaxTokens(400_000) - 8_000))   // the compaction threshold, the route's output reserved
  expect(body.context_window_source as string).toContain('configured (the docs)')
  expect((await c.get(`/api/sessions/${session.id}/context`, { model: 'nope' })).status).toBe(400)
  expect((await c.get('/api/sessions/s_nope/context')).status).toBe(404)
  const models = Object.fromEntries(((await json(await c.get('/api/models'))).models as Record<string, unknown>[]).map((m) => [m.id as string, m]))
  expect(models['scripted:b']!.context_window).toBe(400_000)
  expect(models['scripted:b']!.window_source as string).toContain('configured (the docs)')
  expect(models['scripted:a']!.context_window).toBeNull()
})

test('director notes over the API', async () => {
  app = await makeApp()
  const c = new Client(app)
  const { session } = await openOverApi(c, buggyRepo())
  const note = await json(await c.post(`/api/sessions/${session.id}/director-notes`, { question: 'why?', answer: 'because.', model: 'GPT-6 Pro' }))
  expect(note.source).toBe('chatgpt')
  expect(note.id as string).toStartWith('note_')
  expect(((await json(await c.get(`/api/sessions/${session.id}/director-notes`))).notes as Record<string, unknown>[]).map((n) => n.id)).toEqual([note.id])
  expect((await c.post(`/api/sessions/${session.id}/director-notes`, { question: 'q', answer: '  ' })).status).toBe(400)
  expect((await c.post(`/api/sessions/${session.id}/director-notes`, { question: 'q', answer: 'a', source: ' ' })).status).toBe(400)
  expect((await c.post('/api/sessions/s_nope/director-notes', { question: 'q', answer: 'a' })).status).toBe(404)
})

// -- the folder browser -------------------------------------------------------------------------

test('the folder browser lists folders only with repositories marked', async () => {
  app = await makeApp()
  const c = new Client(app)
  const tree = join(realpathSync(tempDir('oasis-fs-')), 'tree')      // the endpoint answers with the real path (macOS: /var → /private/var)
  mkdirSync(join(tree, 'beta'), { recursive: true })
  mkdirSync(join(tree, 'Alpha'))
  mkdirSync(join(tree, '.hidden'))
  writeFileSync(join(tree, 'notes.txt'), 'x')
  mkdirSync(join(tree, 'repo'))
  git(['init', '-q'], join(tree, 'repo'))
  const body = await json(await c.get('/api/fs/dirs', { path: tree }))
  expect((body.entries as Record<string, unknown>[]).map((e) => e.name)).toEqual(['Alpha', 'beta', 'repo'])       // sorted without case, no file, no hidden
  expect((body.entries as Record<string, unknown>[]).map((e) => e.repository)).toEqual([false, false, true])
  expect(body.path).toBe(tree)
  expect(body.parent).toBe(join(tree, '..').replace(/\/$/, ''))
  expect(body.truncated).toBe(false)
  expect((body.favorites as Record<string, unknown>[]).some((f) => f.label === 'Home' && f.path === homedir())).toBe(true)
  const sub = await json(await c.get('/api/fs/dirs', { path: join(tree, 'Alpha') }))
  expect(sub.entries).toEqual([])
  expect(sub.name).toBe('Alpha')
  const root = await json(await c.get('/api/fs/dirs', { path: '/' }))
  expect(root.parent).toBeNull()
  const home = await json(await c.get('/api/fs/dirs'))
  expect(home.path).toBe(homedir())
  expect((await c.get('/api/fs/dirs', { path: join(tree, 'notes.txt') })).status).toBe(400)
  expect((await c.get('/api/fs/dirs', { path: join(tree, 'missing') })).status).toBe(400)
  expect((await new Client(app, { headers: {} }).get('/api/fs/dirs')).status).toBe(401)
  expect(existsSync(join(tree, '.hidden'))).toBe(true)
})

test('a task needs no folder: the one project for such tasks is made once and found after; a session in it writes in a working folder of its own', async () => {
  app = await makeApp()
  const c = new Client(app)
  const [first, second] = await Promise.all([json(await c.post('/api/projects', { no_folder: true })), json(await c.post('/api/projects', { no_folder: true }))])
  expect(first.id).toBe(second.id)                                                        // two starts at once: one project
  expect([first.name, first.source_path, rec(first.config).no_folder]).toEqual(['No folder', null, true])
  expect((await json(await c.post('/api/projects', { no_folder: true }))).id).toBe(first.id)
  const session = await json(await c.post(`/api/projects/${first.id}/sessions`, { title: 'hotels' }))
  const ws = repo.getWorkspace(app.state.conn, session.workspace_id as string)!
  writeFileSync(join(ws.path, 'shortlist.md'), 'Hotel Musse Ginza')                        // the working folder is the session's own
  const status = await json(await c.get(`/api/workspaces/${ws.id}`))
  expect(rec(status.status).untracked).toContain('shortlist.md')
  expect(repo.listProjects(app.state.conn).filter((p) => p.config.no_folder === true)).toHaveLength(1)
})

test("an outline row carries the context the run stood at, not only its input summed over every request", () => {
  const run = { id: 'run_x', session_id: 's', parent_run_id: null, resumes_run_id: null, spawned_by: 'run:p', label: null, model: 'm', status: 'done',
    created_at: '', finished_at: null, workspace_id: null, user_text: 'go', work_order: null, receipt: {}, error: null, relay_id: null, relay_step: null,
    interaction_id: null, interaction_node: null,
    usage: { requests: 47, input_tokens: 18_100_000, output_tokens: 101_000, context_anchor: { input_tokens: 312_000, messages: 239 } } }
  const usage = treeRow(run as never).usage as Record<string, unknown>
  expect(usage.context_tokens).toBe(312_000)
  expect(usage.input_tokens).toBe(18_100_000)
  expect(usage.context_anchor).toBeUndefined()
  expect((treeRow({ ...run, usage: { input_tokens: 5 } } as never).usage as Record<string, unknown>).context_tokens).toBeUndefined()
})
