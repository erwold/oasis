/** Work an agent starts on an SSH host is never wider than the run that starts it (policy/delegation.ts): a session in
 *  "Ask before changes" opens an "Ask before changes" session there whose commands are really gated; a sandboxed run,
 *  a run under a work order, a run under a run-scoped pause each get what holds (refused, or gated), never an auto/full
 *  session; the API knows the in-process requests for the agent's (its run in the origin and the record), never the
 *  person's, and refuses a header that does not check out. The hosts are an owned loopback sshd (tests/remote): no
 *  saved host of the person, no credential, no provider call (scripted models), no 8399. */
import { afterEach, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inferMode } from '@oasis-code/contract/modes'
import { LoopbackSshd } from './remote/loopback_sshd.ts'
import { Client, HEADERS, json, makeApp } from './api_harness.ts'
import { buggyRepo, domainState, setModel, waitDone, type DomainState } from './harness.ts'
import { tempDir } from './helpers.ts'
import { scriptedModel } from '../src/llm/scripted.ts'
import { isRequest, isToolReturn, modelResponse, textPart, toolCallPart, userTexts, type ModelMessage } from '../src/llm/messages.ts'
import { AGENT_RUN_HEADER, CONNECTOR_HEADER } from '../src/api/auth.ts'
import * as repo from '../src/db/repo.ts'
import { effectiveControl, recordRunControl } from '../src/policy/gate.ts'
import { applySessionMode } from '../src/policy/modes.ts'
import { delegationBound, DelegationRefused, narrowGrants } from '../src/policy/delegation.ts'
import { loopTools } from '../src/agent/tools/registry.ts'
import { workOrder } from '../src/agent/work_orders.ts'

type Rec = Record<string, unknown>
type App = Awaited<ReturnType<typeof makeApp>>

function returned(messages: ModelMessage[], tool: string): Rec | null {
  const parts = messages.flatMap((m) => (isRequest(m) ? m.parts.filter(isToolReturn) : [])).filter((p) => p.tool_name === tool)
  const last = parts.at(-1)
  if (!last) return null
  return (typeof last.content === 'string' ? JSON.parse(last.content) : last.content) as Rec
}

const historyOf = (app: App, runId: string): string => (app.state.conn.get('SELECT history_json FROM runs WHERE id=?', [runId]) as { history_json: string }).history_json
const originOf = (app: App, runId: string): Rec => JSON.parse((app.state.conn.get('SELECT origin_json FROM run_collab WHERE run_id=?', [runId]) as { origin_json: string }).origin_json) as Rec
const governance = (app: App, sessionId: string, kind: string) => app.state.conn.all('SELECT actor, run_id, params_json FROM governance_log WHERE session_id=? AND kind=? ORDER BY id', [sessionId, kind]) as { actor: string; run_id: string | null; params_json: string }[]

/** The local conversation opens a session on the host; the remote one tries a command that would write a file. */
function script(targetId: () => string, workspace: string) {
  return scriptedModel((messages: ModelMessage[]) => {
    const words = userTexts(messages).join('\n')
    if (words.includes('REMOTE_WRITE')) {
      const ran = returned(messages, 'bash')
      if (!ran) return modelResponse([toolCallPart('bash', { command: 'echo made > made.txt' }, 'b')])
      return modelResponse([textPart(`REMOTE_DONE ${String(ran.status)}`)])
    }
    if (words.includes('HOLD')) {
      if (!returned(messages, 'request_input')) return modelResponse([toolCallPart('request_input', { title: 'hold', root: 'a', elements: { a: { type: 'input', props: { label: 'x', key: 'x', inputType: 'text' } } } }, 'h')])
      return modelResponse([textPart('HELD_DONE')])
    }
    const opened = returned(messages, 'open_ssh_session')
    if (!opened) return modelResponse([toolCallPart('open_ssh_session', { target_id: targetId(), path: workspace, message: 'REMOTE_WRITE the file' }, 'o')])
    return modelResponse([textPart(`LOCAL_DONE ${JSON.stringify(opened)}`)])
  })
}

async function hostApp(): Promise<{ app: App; f: LoopbackSshd; c: Client; targetId: string }> {
  const f = await LoopbackSshd.start({ parent: tmpdir() })
  const knownHosts = join(tempDir('ssh-deleg-known-'), 'known_hosts')
  writeFileSync(knownHosts, '')
  const app = await makeApp(null, { remote_transport: { config_file: f.configFile, known_hosts_file: knownHosts, rpc_timeout_ms: 10_000 } })
  // the person's yes, given directly: the host saved and connected (ssh_connect's own question is test_ssh_connect_ask's)
  const target = await app.state.ssh.apply(await app.state.ssh.plan({ destination: f.alias, identity_file: f.clientKey, name: 'Fixture host' }))
  expect(target.state).toBe('ready')
  const c = new Client(app)
  setModel(app.state, 'scripted:a', script(() => target.id, f.workspace))
  return { app, f, c, targetId: target.id }
}

async function remoteRunOf(app: App, targetId: string): Promise<{ sessionId: string; runId: string } | null> {
  const row = app.state.conn.get('SELECT r.id AS run_id, s.id AS session_id FROM runs r JOIN sessions s ON s.id=r.session_id JOIN projects p ON p.id=s.project_id WHERE p.target_id=?', [targetId]) as { run_id: string; session_id: string } | null
  return row ? { sessionId: row.session_id, runId: row.run_id } : null
}

test('"Ask before changes": open_ssh_session opens an "Ask before changes" session on the host, recorded as the agent\'s; its command is gated there, not run', async () => {
  const { app, f, c, targetId } = await hostApp()
  try {
    const project = await json(await c.post('/api/projects', { no_folder: true }))
    const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'Local', model: 'scripted:a', mode: 'approve' }))
    const chat = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'open the host' }))
    const local = await waitDone(app.state, String(chat.id))
    expect(local.status, local.error ?? '').toBe('done')
    expect(historyOf(app, local.id)).toContain('\\"status\\":\\"started\\"')
    const remote = (await remoteRunOf(app, targetId))!
    expect(remote).not.toBeNull()
    // the session on the host: Full access (the only one there), "Ask before changes" — the caller's mode, not auto
    const made = repo.getSession(app.state.conn, remote.sessionId)!
    expect(made.access_mode).toBe('full')
    expect(inferMode(made.grants, effectiveControl(app.state.conn, made.id))).toBe('approve')
    // recorded as the agent's: the calling run named, never the person
    for (const kind of ['session_access', 'session_mode', 'run_control', 'session_delegation']) expect(governance(app, made.id, kind).map((g) => g.actor)).toEqual(['agent'])
    expect(JSON.parse(governance(app, made.id, 'session_delegation')[0]!.params_json).caller_run_id).toBe(local.id)
    const origin = originOf(app, remote.runId)
    expect(origin.actor).toBe('agent')
    expect(origin.parent_run_id).toBe(local.id)
    // the remote run's command was proposed for the person's review on the host, not executed
    const done = await waitDone(app.state, remote.runId)
    expect(done.status, done.error ?? '').toBe('done')
    expect(historyOf(app, done.id)).toContain('REMOTE_DONE action_gated')
    expect(existsSync(join(f.workspace, 'made.txt'))).toBe(false)
  } finally {
    await app.close()
    await f.close()
  }
}, 120_000)

test('auto / Full access: open_ssh_session still opens an auto session on the host and its command runs there', async () => {
  const { app, f, c, targetId } = await hostApp()
  try {
    const project = await json(await c.post('/api/projects', { no_folder: true }))
    const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'Local', model: 'scripted:a' }))
    const chat = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'open the host' }))
    const local = await waitDone(app.state, String(chat.id))
    expect(local.status, local.error ?? '').toBe('done')
    const remote = (await remoteRunOf(app, targetId))!
    const made = repo.getSession(app.state.conn, remote.sessionId)!
    expect(inferMode(made.grants, effectiveControl(app.state.conn, made.id))).toBe('auto')
    expect(originOf(app, remote.runId).actor).toBe('agent')
    const done = await waitDone(app.state, remote.runId)
    expect(done.status, done.error ?? '').toBe('done')
    expect(historyOf(app, done.id)).toContain('REMOTE_DONE')
    expect(existsSync(join(f.workspace, 'made.txt'))).toBe(true)
  } finally {
    await app.close()
    await f.close()
  }
}, 120_000)

test('a Sandbox session: open_ssh_session is refused before anything is made on the host', async () => {
  const { app, f, c, targetId } = await hostApp()
  try {
    const project = await json(await c.post('/api/projects', { no_folder: true }))
    const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'Local', model: 'scripted:a', access_mode: 'sandbox' }))
    const chat = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'open the host' }))
    const local = await waitDone(app.state, String(chat.id))
    expect(local.status, local.error ?? '').toBe('done')
    expect(historyOf(app, local.id)).toContain('sandbox_unavailable')
    expect(app.state.conn.all('SELECT id FROM projects WHERE target_id=?', [targetId])).toHaveLength(0)
    expect(await remoteRunOf(app, targetId)).toBeNull()
    expect(existsSync(join(f.workspace, 'made.txt'))).toBe(false)
  } finally {
    await app.close()
    await f.close()
  }
}, 120_000)

// ---- the API's side: the header checked, the route bounded, a session made held to the caller ----------------------

async function heldRun(app: App, c: Client, body: Rec): Promise<{ sessionId: string; runId: string; projectId: string }> {
  const project = await json(await c.post('/api/projects', { no_folder: true }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'Caller', model: 'scripted:a', ...body }))
  const chat = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'HOLD' }))
  for (let i = 0; i < 200; i++) {
    if (app.state.conn.get("SELECT id FROM ui_inputs WHERE run_id=? AND status='pending'", [String(chat.id)])) break
    await new Promise((r) => setTimeout(r, 25))
  }
  return { sessionId: String(session.id), runId: String(chat.id), projectId: String(project.id) }
}

test('the agent header: a run that is not live is refused; an agent may not reach the person\'s routes; a session it makes is held to its run; it may not message a wider session', async () => {
  const app = await makeApp()
  const c = new Client(app)
  try {
    setModel(app.state, 'scripted:a', script(() => 'none', '/none'))
    const caller = await heldRun(app, c, { mode: 'approve' })
    const agent = new Client(app, { headers: { ...HEADERS, [AGENT_RUN_HEADER]: caller.runId } })
    // a run id that is not a live run, or the header beside another caller's: refused, never read as the person's
    const ghost = await new Client(app, { headers: { ...HEADERS, [AGENT_RUN_HEADER]: 'run_doesnotexist' } }).post(`/api/projects/${caller.projectId}/sessions`, { model: 'scripted:a' })
    expect(ghost.status).toBe(403)
    expect(((await ghost.json()) as Rec).code).toBe('invalid_agent_context')
    const mixed = await agent.post(`/api/projects/${caller.projectId}/sessions`, { model: 'scripted:a' }, { [CONNECTOR_HEADER]: 'ChatGPT' })
    expect(mixed.status).toBe(403)
    // the person's routes: a grant, a mode, an access
    for (const [method, path, body] of [['PUT', `/api/sessions/${caller.sessionId}/grants`, { network: true }], ['PUT', `/api/sessions/${caller.sessionId}/mode`, { mode: 'auto' }], ['PUT', `/api/sessions/${caller.sessionId}/access`, { access_mode: 'full' }]] as const) {
      const res = await agent.request(method, path, { json: body })
      expect(res.status, path).toBe(403)
      expect(((await res.json()) as Rec).code).toBe('agent_route')
    }
    expect(inferMode(repo.getSession(app.state.conn, caller.sessionId)!.grants, effectiveControl(app.state.conn, caller.sessionId))).toBe('approve')
    // a session it makes asking for auto is "Ask before changes" (the caller's), and the agent's in the record
    const made = await json(await agent.post(`/api/projects/${caller.projectId}/sessions`, { model: 'scripted:a', mode: 'auto' }))
    expect(inferMode(repo.getSession(app.state.conn, String(made.id))!.grants, effectiveControl(app.state.conn, String(made.id)))).toBe('approve')
    expect(governance(app, String(made.id), 'session_mode')).toEqual([{ actor: 'agent', run_id: null, params_json: JSON.stringify({ mode: 'approve' }) }])
    // folders beside its working folder are the person's to give
    expect((await agent.post(`/api/projects/${caller.projectId}/sessions`, { model: 'scripted:a', roots: [{ path: tempDir('deleg-root-'), access: 'write' }] })).status).toBe(403)
    // a message to a session wider than the caller (the person's auto session): refused; to the one it made: the agent's run
    const wide = await json(await c.post(`/api/projects/${caller.projectId}/sessions`, { title: 'Wide', model: 'scripted:a' }))
    const refusedChat = await agent.post(`/api/sessions/${wide.id}/chat`, { text: 'HELD_DONE please' })
    expect(refusedChat.status).toBe(403)
    expect(((await refusedChat.json()) as Rec).code).toBe('wider_than_caller')
    expect(repo.listRuns(app.state.conn, String(wide.id))).toHaveLength(0)
    const run = await json(await agent.post(`/api/sessions/${made.id}/chat`, { text: 'say done' }))
    expect(originOf(app, String(run.id))).toMatchObject({ actor: 'agent', parent_run_id: caller.runId })
    await waitDone(app.state, String(run.id))
  } finally {
    await app.close()
  }
}, 60_000)

test('the agent header of a Sandbox run: the API refuses to make a session for it (its cap is the run\'s, not the person\'s none)', async () => {
  const app = await makeApp()
  const c = new Client(app)
  try {
    setModel(app.state, 'scripted:a', script(() => 'none', '/none'))
    const caller = await heldRun(app, c, { access_mode: 'sandbox' })
    const agent = new Client(app, { headers: { ...HEADERS, [AGENT_RUN_HEADER]: caller.runId } })
    const before = app.state.conn.all('SELECT id FROM sessions').length
    const res = await agent.post(`/api/projects/${caller.projectId}/sessions`, { model: 'scripted:a', access_mode: 'full' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as Rec).code).toBe('sandbox_unavailable')
    expect(app.state.conn.all('SELECT id FROM sessions')).toHaveLength(before)
  } finally {
    await app.close()
  }
}, 60_000)

// ---- the tools through the registry's dispatch (fake ports that record every request; no host, no API) --------------

let state: DomainState | null = null
afterEach(async () => { await state?.close(); state = null })

async function dispatch(tool: string, args: Rec, o: { mode?: 'auto' | 'approve' | 'plan'; order?: unknown; rowOrder?: Rec; budget?: Rec; access?: 'full' | 'sandbox'; runControl?: boolean; network?: boolean; ssh_workspace?: boolean } = {}) {
  state = domainState()
  const project = await state.workspaces.importProject('calc', buggyRepo())
  let session = repo.createSession(state.conn, project.id, 't', 'scripted:a', undefined, o.access ?? 'full')
  applySessionMode(state.conn, session, o.mode ?? 'auto')
  if (o.network === false) repo.setSessionGrants(state.conn, session.id, { ...repo.getSession(state.conn, session.id)!.grants, network: false })
  if (o.runControl) recordRunControl(state.conn, session.id, 'pause', ['isolated_code_execution'], 'run_local')
  session = repo.getSession(state.conn, session.id)!
  // the calling run as the server records it: its budget and order are what the bounds read, not the deps'
  repo.insertRun(state.conn, { id: 'run_local', session_id: session.id, project_id: project.id, workspace_id: null, model: 'scripted:a', model_config: {}, user_text: 'x', status: 'running', budget: (o.budget ?? {}) as never, work_order: o.rowOrder ?? null })
  const posts: { path: string; body: unknown; agent: unknown }[] = []
  const calls: string[] = []
  const api = (context: Rec = {}) => ({
    with: (more: Rec) => api({ ...context, ...more }),
    get: async () => [],
    post: async (path: string, body: unknown) => {
      posts.push({ path, body, agent: context.agent_run_id ?? null })
      return path === '/api/projects' ? { id: 'p_remote', source_path: '/srv/x' } : path.endsWith('/sessions') ? { id: 's_remote' } : { id: 'run_remote' }
    },
  })
  const deps = {
    conn: state.conn, session, run_id: 'run_local', closing: () => null, tool_allowed: null, blocked_calls: 0, tool_calls: 0,
    work_order: o.order ?? null, model_cfg: { id: 'scripted:a' }, emit: () => {}, policy: { isTemp: () => false, normalize: (p: string) => p },
    workspace: o.ssh_workspace ? { id: 'ws_remote', target: { kind: 'ssh', target_id: 't1' }, remote: { root: '/srv/x' } } : { id: 'ws_local', target: null },
    ssh: {
      hosts: { plan: async () => { calls.push('plan'); return { ready: true, target_id: 't1', label: 'host' } } },
      remote: {
        target: () => ({ id: 't1', label: 'host', destination: 'h', state: 'ready' }), isReady: () => true,
        listDirs: async () => { calls.push('listDirs'); return { path: '/', parent: null, entries: [], truncated: false } },
        request: async () => { calls.push('request') }, openForward: async () => { calls.push('openForward'); return { state: 'open', local_url: 'http://127.0.0.1:1', remote_port: 80 } },
      },
      api: () => api(),
    },
  }
  const spec = loopTools().find((t) => t.name === tool)!
  const out = await spec.fn({ deps, tool_call_id: 'c1' } as never, args as never) as Rec
  return { out, posts, calls }
}

const OPEN = { target_id: 't1', path: '/srv/x', message: 'rm -rf build && make deploy' }

test('open_ssh_session through the dispatch: approve carries "approve" in the session it asks for and names its run; auto carries "auto"', async () => {
  const approve = await dispatch('open_ssh_session', OPEN, { mode: 'approve' })
  expect(approve.out.status).toBe('started')
  expect(approve.out.mode).toBe('approve')
  expect(approve.posts.find((p) => p.path.endsWith('/sessions'))!.body).toMatchObject({ mode: 'approve' })
  expect(approve.posts.every((p) => p.agent === 'run_local')).toBe(true)
  await state!.close(); state = null
  const auto = await dispatch('open_ssh_session', OPEN, { mode: 'auto' })
  expect(auto.out.status).toBe('started')
  expect(auto.posts.find((p) => p.path.endsWith('/sessions'))!.body).toMatchObject({ mode: 'auto' })
})

test('open_ssh_session through the dispatch: a run-scoped pause, a work order, the sandbox, the network off — what holds, and no request at all when refused', async () => {
  // a pause scoped to this run (the session itself is auto): the session asked for is "Ask before changes"
  const scoped = await dispatch('open_ssh_session', OPEN, { mode: 'auto', runControl: true })
  expect(scoped.posts.find((p) => p.path.endsWith('/sessions'))!.body).toMatchObject({ mode: 'approve' })
  await state!.close(); state = null
  for (const [o, code] of [
    [{ order: workOrder({ prompt: 'x', execution: { commands: false, network: true } }) }, 'work_order_bounds'],
    [{ order: workOrder({ prompt: 'x' }) }, 'work_order_bounds'],
    [{ access: 'sandbox' }, 'sandbox_unavailable'],
  ] as const) {
    const r = await dispatch('open_ssh_session', OPEN, o)
    expect(r.out.status, JSON.stringify(o)).toBe('refused')
    expect(r.out.code).toBe(code)
    expect(r.posts).toEqual([])
    await state!.close(); state = null
  }
  const offline = await dispatch('open_ssh_session', OPEN, { network: false })
  expect(offline.out.status).toBe('refused')
  expect(offline.posts).toEqual([])
  await state!.close(); state = null
  // Plan: the registry's own block (state_change), before the tool
  const plan = await dispatch('open_ssh_session', OPEN, { mode: 'plan' })
  expect(plan.out.status).toBe('blocked')
  expect(plan.posts).toEqual([])
})

test('ssh_connect, ssh_directories and forward_port: an order with the network off (or a read scope) and a session without the network reach no host', async () => {
  const noNet = workOrder({ prompt: 'x', execution: { commands: true, network: false } })
  for (const [tool, args, extra] of [
    ['ssh_connect', { target_id: 't1' }, {}],
    ['ssh_directories', { target_id: 't1', path: '/' }, {}],
    ['forward_port', { remote_port: 80 }, { ssh_workspace: true }],
  ] as const) {
    const byOrder = await dispatch(tool, args, { ...extra, order: noNet })
    expect(byOrder.out.status, tool).toBe('refused_by_work_order')
    expect(byOrder.calls, tool).toEqual([])
    await state!.close(); state = null
    const byGrant = await dispatch(tool, args, { ...extra, network: false })
    expect(byGrant.out.status, tool).toBe('refused')
    expect(byGrant.calls, tool).toEqual([])
    await state!.close(); state = null
    const ok = await dispatch(tool, args, extra)
    expect(String(ok.out.status ?? ''), tool).not.toMatch(/refused|blocked/)
    expect(ok.calls.length, tool).toBeGreaterThan(0)
    await state!.close(); state = null
  }
  const scoped = await dispatch('ssh_directories', { target_id: 't1', path: '/' }, { order: workOrder({ prompt: 'x', scope: { read: ['src'], write: null } }) })
  expect(scoped.out.status).toBe('refused_by_work_order')
  expect(scoped.calls).toEqual([])
})

test('delegationBound / narrowGrants: the grants of what is made are the caller\'s at most, the network until the earlier expiry', async () => {
  state = domainState()
  const project = await state.workspaces.importProject('calc', buggyRepo())
  const session = repo.createSession(state.conn, project.id, 't', 'scripted:a', undefined, 'full')
  applySessionMode(state.conn, session, 'auto')
  const until = new Date(Date.now() + 3_600_000).toISOString()
  repo.setSessionGrants(state.conn, session.id, { ...repo.getSession(state.conn, session.id)!.grants, run_commands: false, network_until: until })
  repo.insertRun(state.conn, { id: 'run_x', session_id: session.id, project_id: project.id, workspace_id: null, model: 'scripted:a', model_config: {}, user_text: 'x', status: 'running', budget: {} })
  const bound = delegationBound(state.conn, { run_id: 'run_x', session_id: session.id, work_order: null })
  const narrowed = narrowGrants({ workspace_write: true, run_commands: true, attached_write: true, network: true, network_until: null, network_reason: null }, bound.grants)
  expect(narrowed).toMatchObject({ workspace_write: true, run_commands: false, network: true, network_until: until })
  expect(() => delegationBound(state!.conn, { run_id: 'run_x', session_id: session.id, work_order: { prompt: 'x' } })).toThrow(DelegationRefused)
  // a run that is not on record (or of another session) has no bounds to read: refused, never read as unbounded
  expect(() => delegationBound(state!.conn, { run_id: 'run_unknown', session_id: session.id })).toThrow(DelegationRefused)
})

// ---- a hard budget on a run without an order (read from the run's row) ----------------------------------------------

test('open_ssh_session through the dispatch: any finite budget line on the run\'s row refuses it before any request; no budget, all-null lines go on', async () => {
  for (const budget of [{ requests: 1 }, { total_tokens: 100_000 }, { wall_clock_s: 3600 }, { tool_calls: 50 }, { requests: null, total_tokens: null, wall_clock_s: 600, tool_calls: null }]) {
    const r = await dispatch('open_ssh_session', OPEN, { budget })
    expect(r.out.status, JSON.stringify(budget)).toBe('refused')
    expect(r.out.code).toBe('run_budget')
    expect(String(r.out.reason)).toContain('Nothing was started on the host')
    expect(r.posts).toEqual([])
    await state!.close(); state = null
  }
  for (const budget of [{}, { requests: null, total_tokens: null, wall_clock_s: null, tool_calls: null }, { requests: undefined }]) {
    const r = await dispatch('open_ssh_session', OPEN, { budget })
    expect(r.out.status, JSON.stringify(budget)).toBe('started')
    await state!.close(); state = null
  }
  // an order on the run's row, whatever the deps say (null): refused
  const rowOrder = await dispatch('open_ssh_session', OPEN, { rowOrder: { prompt: 'x' } })
  expect(rowOrder.out.code).toBe('work_order_bounds')
  expect(rowOrder.posts).toEqual([])
})

test('a run with a finite budget on the loopback host: open_ssh_session is refused, nothing is made there', async () => {
  const { app, f, c, targetId } = await hostApp()
  try {
    const project = await json(await c.post('/api/projects', { no_folder: true }))
    const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'Local', model: 'scripted:a' }))
    const chat = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'open the host', budget: { tool_calls: 20 } }))
    expect(repo.getRun(app.state.conn, String(chat.id))!.budget.tool_calls).toBe(20)
    const sessionsBefore = app.state.conn.all('SELECT id FROM sessions').length
    const local = await waitDone(app.state, String(chat.id))
    expect(local.status, local.error ?? '').toBe('done')
    expect(historyOf(app, local.id)).toContain('run_budget')
    expect(app.state.conn.all('SELECT id FROM projects WHERE target_id=?', [targetId])).toHaveLength(0)
    expect(app.state.conn.all('SELECT id FROM sessions')).toHaveLength(sessionsBefore)
    expect(await remoteRunOf(app, targetId)).toBeNull()
    expect(existsSync(join(f.workspace, 'made.txt'))).toBe(false)
  } finally {
    await app.close()
    await f.close()
  }
}, 120_000)

test('the agent header of a run with a finite budget: the API makes no project, no session and no run for it', async () => {
  const app = await makeApp()
  const c = new Client(app)
  try {
    setModel(app.state, 'scripted:a', script(() => 'none', '/none'))
    const project = await json(await c.post('/api/projects', { no_folder: true }))
    const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'Caller', model: 'scripted:a' }))
    const chat = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'HOLD', budget: { requests: 40 } }))
    for (let i = 0; i < 200 && !app.state.conn.get("SELECT id FROM ui_inputs WHERE run_id=? AND status='pending'", [String(chat.id)]); i++) await new Promise((r) => setTimeout(r, 25))
    const target = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'Target', model: 'scripted:a' }))
    const agent = new Client(app, { headers: { ...HEADERS, [AGENT_RUN_HEADER]: String(chat.id) } })
    const count = (table: string) => app.state.conn.all(`SELECT id FROM ${table}`).length
    const before = { projects: count('projects'), sessions: count('sessions'), runs: count('runs') }
    for (const [path, body] of [
      ['/api/projects', { source_path: '/srv/x', mode: 'direct', target: { kind: 'ssh', target_id: 'ssh_none' } }],
      [`/api/projects/${project.id}/sessions`, { model: 'scripted:a' }],
      [`/api/sessions/${target.id}/chat`, { text: 'say done' }],
    ] as const) {
      const res = await agent.post(path, body)
      expect(res.status, path).toBe(403)
      const answer = (await res.json()) as Rec
      expect(answer.code, path).toBe('run_budget')
      expect(String(answer.detail)).toContain('Nothing was started on the host')
    }
    expect({ projects: count('projects'), sessions: count('sessions'), runs: count('runs') }).toEqual(before)
  } finally {
    await app.close()
  }
}, 60_000)
