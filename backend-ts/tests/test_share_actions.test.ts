/** Share snapshot V2 (src/share/snapshot.ts): action rows (a connector's or the person's command, checkpoint, checks,
 *  integration, approval) as `action` items with the thread's what / by / head / outcome; their bounded, provenance-
 *  checked output preview (details only); sensitive sources withheld; group notes (MemberWords) and the dedup of the
 *  internal steer that carried them; V1 compatibility. Synthetic rows only. */

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SHARE_LIMITS, SHARE_LIMITS_V1_KEYS, ShareActionItemSchema, ShareSnapshotResponseSchema, ShareSnapshotSchema, ShareSnapshotV1Schema, ShareSnapshotV2Schema,
  threadActionRecord, type ShareItem, type ShareSnapshotResponse, type SteerRecord,
} from '@oasis-code/contract'
import { Settings } from '../src/config.ts'
import * as repo from '../src/db/repo.ts'
import { recordHumanRun } from '../src/agent/human_runs.ts'
import type { App } from '../src/main.ts'
import type { AppState } from '../src/api/state.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo, FAKE_FULL, PassthroughRuntime } from './harness.ts'
import { tempDir } from './helpers.ts'

// a synthetic user's name, put into its home path at run time: the committed source holds no literal home path for the
// repository's privacy scan to find (scripts/oss/lib/scan.mjs)
const SYNTH = 'synth'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

type Rec = Record<string, unknown>
type Session = NonNullable<ReturnType<typeof repo.getSession>>
const SECRET = 'SYNTH-SECRET-VALUE-42'
const GH = 'ghp_' + 'Q'.repeat(36)
const V1_FIXTURE = join(import.meta.dir, 'fixtures', 'share_snapshot_v1.json')

async function open(c: Client): Promise<Session> {
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'Share actions demo' }))
  return repo.getSession(app!.state.conn, session.id as string)!
}

async function snapshot(c: Client, sessionId: string, body: Rec = {}): Promise<ShareSnapshotResponse> {
  return ShareSnapshotResponseSchema.parse(await json(await c.post(`/api/sessions/${sessionId}/share-snapshot`, body)))
}
const itemsOf = <K extends ShareItem['kind']>(s: ShareSnapshotResponse, kind: K) => s.snapshot.items.filter((i): i is Extract<ShareItem, { kind: K }> => i.kind === kind)
const keyOf = (s: ShareSnapshotResponse, runId: string) => s.selection.runs.find((r) => r.run_id === runId)!.key

/** A finished execution of the folder with its sealed log assets (as processes.ts seals them). */
function execution(state: AppState, session: Session, o: {
  command: string; cwd?: string; workspace_id?: string | null; run_id?: string | null; stdout?: string; stderr?: string; status?: string; exit_code?: number | null
  stdout_asset?: (xid: string) => string | null
}): string {
  const ws = repo.getWorkspace(state.conn, session.workspace_id!)!
  const x = repo.insertExecution(state.conn, {
    run_id: o.run_id ?? null, workspace_id: o.workspace_id === undefined ? ws.id : o.workspace_id, tool_call_id: null, kind: 'command', command: o.command,
    cwd: o.cwd ?? ws.path, isolation: { runtime: 'passthrough' }, network: false,
  })
  const seal = (stream: 'stdout' | 'stderr', text: string | undefined) => (text === undefined ? null
    : state.store.save(state.conn, session.project_id, 'log', text, { ext: 'log', meta: { execution_id: x.id, stream, truncated: false, run_id: o.run_id ?? null } }).id)
  const status = o.status ?? 'succeeded'
  if (status === 'running') { repo.startExecution(state.conn, x.id); return x.id }
  repo.finishExecution(state.conn, x.id, {
    status, exit_code: o.exit_code === undefined ? 0 : o.exit_code, timed_out: false, cancelled: false, truncated: false,
    stdout_asset_id: o.stdout_asset ? o.stdout_asset(x.id) : seal('stdout', o.stdout), stderr_asset_id: seal('stderr', o.stderr),
    stdout_bytes: o.stdout?.length ?? 0, stderr_bytes: o.stderr?.length ?? 0, duration_ms: 12,
  })
  return x.id
}

/** A connector's command row as the route records it (api/workspace.ts). */
function command(state: AppState, session: Session, cmd: string, o: { client?: string | null; xid?: string | null; running?: boolean; exit?: number } = {}): string {
  const xid = o.xid === undefined ? null : o.xid
  const outcome = o.running ? `running (${xid ?? 'x_000000000000'})` : `exit ${o.exit ?? 0}`
  return recordHumanRun(state.conn, {
    session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, label: `command (${o.client === undefined ? 'ChatGPT' : o.client ?? 'connector'})`,
    kind: 'command', text: `$ ${cmd}\n→ ${outcome}`, produced: { workspace_id: session.workspace_id, executions: xid ? [xid] : [] },
  })!
}

/** Counts the bounded reads of stored assets the snapshot makes. */
function countReads(state: AppState): { n: number } {
  const counter = { n: 0 }
  const store = state.store as unknown as { readRange: (...a: unknown[]) => unknown }
  const original = store.readRange.bind(store)
  store.readRange = (...a: unknown[]) => { counter.n++; return original(...a) }
  return counter
}

test('a connector command: the thread\'s line by default (full sanitized text), measured fields and a bounded output preview with details', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const session = await open(c)
  // the project's own folder (outside the app's data folder): a path in it is said project-relative
  const ws = { path: repo.getProject(state.conn, session.project_id)!.source_path! }
  const tail = 'TAIL-PAST-THE-BOUND'
  const xid = execution(state, session, {
    command: `git status --short ${ws.path}/src`, stdout: `M src/calc.py\nOUT-CANARY token=${SECRET} ${GH}\n${'o'.repeat(70_000)}${tail}`, stderr: 'ERR-CANARY warning\n',
  })
  const run = command(state, session, `git status --short ${ws.path}/src`, { xid })
  const reads = countReads(state)

  const off = await snapshot(c, session.id)
  const all = JSON.stringify(off.snapshot)
  const [action] = itemsOf(off, 'action')
  expect(action).toEqual({
    kind: 'action', key: action!.key, run: keyOf(off, run), at: action!.at, action: 'command', actor: 'connector', what: 'command', by: 'ChatGPT',
    head: '$ git status --short src', outcome: '→ exit 0', text: '$ git status --short src\n→ exit 0', details: null, withheld: null,
  })
  // nothing else of the row: no opening, no notice; its run is the record's
  expect(off.snapshot.items.filter((i) => i.run === action!.run).length).toBe(1)
  expect(itemsOf(off, 'notice').length).toBe(0)
  expect(off.snapshot.runs.find((r) => r.key === action!.run)).toMatchObject({ surface: 'record', request: 'action', label: 'command (ChatGPT)', error: null })
  for (const hidden of ['OUT-CANARY', 'ERR-CANARY', xid, ws.path]) expect(all).not.toContain(hidden)
  expect(off.snapshot.stats.omitted.tool_details).toBe(1)
  expect(reads.n).toBe(0)
  // the app's own reading of the same row says the same what / by / head / outcome
  const app_ = threadActionRecord('command (ChatGPT)', '$ git status --short src\n→ exit 0')
  expect({ what: action!.what, by: action!.by, head: action!.head, outcome: action!.outcome }).toEqual(app_)

  const on = await snapshot(c, session.id, { include_tool_details: true })
  const onAll = JSON.stringify(on.snapshot)
  const d = itemsOf(on, 'action')[0]!.details!
  expect(d.fields).toEqual([{ name: 'exit_code', value: 0 }, { name: 'duration_ms', value: 12 }, { name: 'truncated', value: false }, { name: 'timed_out', value: false }])
  expect(d.preview!.length).toBeLessThanOrEqual(SHARE_LIMITS.max_tool_preview_chars)
  expect(d.preview).toContain('OUT-CANARY token=[redacted]')
  expect(d.preview_truncated).toBe(true)
  for (const hidden of [SECRET, GH, tail, xid, ws.path]) expect(onAll).not.toContain(hidden)
  expect(reads.n).toBe(2)
  expect(ShareSnapshotV2Schema.safeParse(on.snapshot).success).toBe(true)

  // a short output: stdout and stderr both in the preview, not cut
  const x2 = execution(state, session, { command: 'ls', stdout: 'one\ntwo\n', stderr: 'ERR-2\n' })
  command(state, session, 'ls', { xid: x2 })
  const short = itemsOf(await snapshot(c, session.id, { include_tool_details: true }), 'action').at(-1)!.details!
  expect(short.preview).toBe('one\ntwo\n\n[stderr]\nERR-2\n')
  expect(short.preview_truncated).toBe(false)
})

test('the command\'s own lines are kept (CRLF, its own → lines), only the route\'s last outcome is the outcome; running loses its execution id', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const session = await open(c)
  command(state, session, 'echo a\r\n→ not generated\necho b')
  const running = command(state, session, 'sleep 30', { xid: 'x_abc123def456', running: true })
  command(state, session, 'make', { exit: 2, client: null })
  const s = await snapshot(c, session.id)
  const [multi, run, made] = itemsOf(s, 'action')
  expect(multi!.head).toBe('$ echo a …')
  expect(multi!.outcome).toBe('→ exit 0')
  expect(multi!.text).toBe('$ echo a\r\n→ not generated\necho b\n→ exit 0')
  expect(run).toMatchObject({ run: keyOf(s, running), head: '$ sleep 30', outcome: '→ running', text: '$ sleep 30\n→ running' })
  expect(made).toMatchObject({ by: 'connector', actor: 'connector', outcome: '→ exit 2' })
  expect(JSON.stringify(s.snapshot)).not.toContain('x_abc123def456')
})

test('secrets in a command\'s words are redacted in head and text; the session token and the project path never appear', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const session = await open(c)
  const ws = { path: repo.getProject(state.conn, session.project_id)!.source_path! }
  // (an Authorization header's value is masked to the end of its line: it stands last)
  command(state, session, `curl -o ${ws.path}/a.txt https://api.example.test/x?token=QSECRET9 --token ${GH} test-token -H "Authorization: Bearer SYNTHBEARER123"`)
  for (const details of [false, true]) {
    const s = await snapshot(c, session.id, { include_tool_details: details })
    const all = JSON.stringify(s.snapshot)
    for (const hidden of ['SYNTHBEARER123', 'QSECRET9', GH, ws.path, 'test-token']) expect(all).not.toContain(hidden)
    const a = itemsOf(s, 'action')[0]!
    expect(a.text).toContain('a.txt')
    expect(a.head).toContain('curl -o a.txt https://api.example.test/x?token=[redacted]')
  }
})

test('a sensitive source — env dumps, credential files, any variable printed, shell -c, quoted / escaped fragments, invisible characters, a sensitive cwd — is withheld in both modes, its output never read', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const session = await open(c)
  const longTail = `echo ${'harmless '.repeat(30_000)}\ncat .env`
  const commands = [
    'env', 'set', 'export', '/usr/bin/env -0 | sort', 'command env', 'printenv', 'env -i SYNTH_ONLY=1 printenv', 'cat .env', 'cat ".env.local"', 'cat .e"nv"', "cat '.en'v", 'cat .en\\v',
    'echo $HOME', 'echo $my_custom_var', "printf '%s\\n' \"$custom_lower\"", 'printf "%s" "${AWS_PROFILE}"', "sh -c 'env'", 'bash -lc "printenv | sort"',
    'node -e "console.log(process[\'env\'])"', 'pri\u200Bntenv', longTail,
    'env SHARE_TEST=ordinary', 'env -i foo=bar', 'SHARE_TEST=1 env', 'FOO="a b" /usr/bin/env | sort', 'env -u PATH X=1 > out.txt',
  ]
  const xids: string[] = []
  commands.forEach((cmd, i) => {
    const xid = execution(state, session, { command: cmd, stdout: `OPAQUE-CANARY-${i} ${SECRET}\n` })
    xids.push(xid)
    command(state, session, cmd, { xid })
  })
  // a harmless command in a credential folder (the execution's cwd decides), and in a credential folder that is a
  // session root of its own (its place is read whole, never relative to itself)
  const awsX = execution(state, session, { command: 'cat config', cwd: `/home/${SYNTH}/.aws`, stdout: `aws_secret=${SECRET}\n` })
  command(state, session, 'cat config', { xid: awsX })
  repo.setSessionRoots(state.conn, session.id, [{ path: `/home/${SYNTH}/.ssh`, access: 'read' }])
  const sshX = execution(state, session, { command: 'ls -la', cwd: `/home/${SYNTH}/.ssh/keys`, stdout: `ssh_secret=${SECRET}\n` })
  command(state, session, 'ls -la', { xid: sshX })
  // an agent polls one of the withheld executions: withheld too
  const poll = repo.insertRun(state.conn, { session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, model: 'scripted:a', model_config: {}, user_text: 'poll', status: 'running', budget: {} })
  repo.finishRun(state.conn, poll.id, 'done', {
    history_json: JSON.stringify([{ kind: 'request', parts: [{ part_kind: 'user-prompt', content: 'poll', origin: 'person' }] },
      { kind: 'response', parts: [{ part_kind: 'tool-call', tool_name: 'bash_output', args: { execution_id: xids[0] }, tool_call_id: 'p1' }] },
      { kind: 'request', parts: [{ part_kind: 'tool-return', tool_name: 'bash_output', content: { status: 'ok', stdout: `OPAQUE-POLL ${SECRET}` }, tool_call_id: 'p1' }] }]),
    usage: {}, error: null, receipt: {}, saved_seq: 0,
  })
  const reads = countReads(state)
  for (const details of [false, true]) {
    const s = await snapshot(c, session.id, { include_tool_details: details })
    const all = JSON.stringify(s.snapshot)
    const actions = itemsOf(s, 'action')
    expect(actions.length).toBe(commands.length + 2)
    for (const a of actions) {
      expect(a).toMatchObject({ withheld: 'sensitive_source', head: null, text: null, details: null, outcome: '→ exit 0', what: 'command', by: 'ChatGPT' })
    }
    for (const hidden of [SECRET, 'OPAQUE', 'my_custom_var', 'custom_lower', 'AWS_PROFILE', 'printenv', '.e"nv"', '.en\\\\v', 'harmless', '.aws', 'process[', 'SHARE_TEST', 'foo=bar', 'X=1']) expect(all).not.toContain(hidden)
    expect(itemsOf(s, 'tool').map((t) => [t.name, t.withheld])).toEqual([['bash_output', 'sensitive_source']])
    expect(s.snapshot.stats.omitted.sensitive_tool_content).toBe(commands.length + 3)
    expect(s.snapshot.stats.omitted.tool_details).toBe(0)
  }
  expect(reads.n).toBe(0)
})

test('the cwd is read relative only inside a harness-managed copy: a direct project in the data folder, a root equal to it, a path leaving the copy are read whole', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const session = await open(c)
  const dataDir = state.settings.data_dir
  const copy = repo.getWorkspace(state.conn, session.workspace_id!)!
  // the session's own workspace is a managed copy at <workspaces_dir>/<id>
  expect(copy.path).toBe(join(state.settings.workspaces_dir, copy.id))
  // a session root equal to the data folder: a command run there, an opaque secret in its sealed output
  repo.setSessionRoots(state.conn, session.id, [{ path: dataDir, access: 'read' }])
  const atRoot = execution(state, session, { command: 'cat account.txt', cwd: dataDir, stdout: 'ROOT-DATA-CANARY\n' })
  command(state, session, 'cat account.txt', { xid: atRoot })
  // a path that leaves the copy (`..`) into the data folder
  const escaped = execution(state, session, { command: 'cat notes.txt', cwd: join(copy.path, '..', '..', 'private'), stdout: 'ESCAPE-CANARY\n' })
  command(state, session, 'cat notes.txt', { xid: escaped })
  // an ordinary command inside the copy still exports, its output with details
  const inside = execution(state, session, { command: 'ls', cwd: join(copy.path, 'src'), stdout: 'COPY-OUT\n' })
  command(state, session, 'ls', { xid: inside })

  // a direct project whose folder is inside the data folder (synthetic rows: <data_dir>/private)
  const privateDir = join(dataDir, 'private')
  mkdirSync(privateDir, { recursive: true })
  const direct = repo.createProject(state.conn, 'direct in data', { kind: 'direct', source_path: privateDir, base_repo_path: '', base_commit: null, base_branch: null, import_report: {} })
  const dSession = repo.createSession(state.conn, direct.id, 'direct', 'scripted:a')
  const dWs = repo.insertWorkspace(state.conn, 'ws_directindata', direct.id, dSession.id, privateDir, '', '', 'direct')
  state.conn.run('UPDATE sessions SET workspace_id=? WHERE id=?', [dWs.id, dSession.id])
  const dS = repo.getSession(state.conn, dSession.id)!
  const dx = execution(state, dS, { command: 'cat account.txt', cwd: privateDir, stdout: 'DIRECT-DATA-CANARY\n' })
  command(state, dS, 'cat account.txt', { xid: dx })
  // the same, with the data folder itself as the direct project's folder
  const whole = repo.createProject(state.conn, 'direct is data', { kind: 'direct', source_path: dataDir, base_repo_path: '', base_commit: null, base_branch: null, import_report: {} })
  const wSession = repo.createSession(state.conn, whole.id, 'whole', 'scripted:a')
  const wWs = repo.insertWorkspace(state.conn, 'ws_directisdata', whole.id, wSession.id, dataDir, '', '', 'direct')
  state.conn.run('UPDATE sessions SET workspace_id=? WHERE id=?', [wWs.id, wSession.id])
  const wS = repo.getSession(state.conn, wSession.id)!
  const wx = execution(state, wS, { command: 'cat account.txt', cwd: dataDir, stdout: 'WHOLE-DATA-CANARY\n' })
  command(state, wS, 'cat account.txt', { xid: wx })

  const reads = countReads(state)
  for (const details of [false, true]) {
    for (const [sid, canaries] of [[session.id, ['ROOT-DATA-CANARY', 'ESCAPE-CANARY']], [dS.id, ['DIRECT-DATA-CANARY']], [wS.id, ['WHOLE-DATA-CANARY']]] as const) {
      const s = await snapshot(c, sid, { include_tool_details: details })
      const all = JSON.stringify(s.snapshot)
      for (const canary of canaries) expect(all).not.toContain(canary)
      expect(all).not.toContain('account.txt')
      const withheld = itemsOf(s, 'action').filter((a) => a.withheld === 'sensitive_source')
      expect(withheld.length).toBe(canaries.length)
      for (const a of withheld) expect(a).toMatchObject({ head: null, text: null, details: null, outcome: '→ exit 0' })
      if (sid === session.id) {
        const ls = itemsOf(s, 'action').find((a) => a.head === '$ ls')!
        expect(ls.withheld).toBeNull()
        if (details) expect(ls.details!.preview).toBe('COPY-OUT\n')
        else expect(ls.details).toBeNull()
      }
    }
  }
  // the only stored output read: the managed copy's ordinary command, with details (one stream)
  expect(reads.n).toBe(1)
})

test('an excluded sensitive command still withholds an agent\'s polling of its execution; an unknown connector execution polled stays withheld', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const session = await open(c)
  const sensitiveX = execution(state, session, { command: 'printenv', stdout: `X=${SECRET}` })
  const action = command(state, session, 'printenv', { xid: sensitiveX })
  const safeX = execution(state, session, { command: 'ls', stdout: 'listing' })
  command(state, session, 'ls', { xid: safeX })
  const run = repo.insertRun(state.conn, { session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, model: 'scripted:a', model_config: {}, user_text: 'poll both', status: 'running', budget: {} })
  repo.finishRun(state.conn, run.id, 'done', {
    history_json: JSON.stringify([{ kind: 'request', parts: [{ part_kind: 'user-prompt', content: 'poll both', origin: 'person' }] },
      { kind: 'response', parts: [{ part_kind: 'tool-call', tool_name: 'bash_output', args: { execution_id: sensitiveX }, tool_call_id: 'a' }, { part_kind: 'tool-call', tool_name: 'bash_output', args: { execution_id: safeX }, tool_call_id: 'b' }] },
      { kind: 'request', parts: [{ part_kind: 'tool-return', tool_name: 'bash_output', content: { status: 'ok', stdout: `X=${SECRET}` }, tool_call_id: 'a' }, { part_kind: 'tool-return', tool_name: 'bash_output', content: { status: 'ok', stdout: 'listing' }, tool_call_id: 'b' }] }]),
    usage: {}, error: null, receipt: {}, saved_seq: 0,
  })
  const s = await snapshot(c, session.id, { include_tool_details: true, exclude_run_ids: [action] })
  expect(itemsOf(s, 'action').length).toBe(1)
  expect(s.snapshot.stats.omitted.runs_excluded).toBe(1)
  // both polls fail closed: the connector's executions are never made known to an agent's polling
  expect(itemsOf(s, 'tool').map((t) => t.withheld)).toEqual(['sensitive_source', 'sensitive_source'])
  expect(JSON.stringify(s.snapshot)).not.toContain(SECRET)
})

test('the output is read only for this command\'s own sealed, final, local execution of this folder and project', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const session = await open(c)
  const other = repo.getSession(state.conn, (await json(await c.post(`/api/projects/${session.project_id}/sessions`, { title: 'other' }))).id as string)!
  const otherProject = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const someRun = repo.insertRun(state.conn, { session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, model: 'scripted:a', model_config: {}, user_text: 'x', status: 'running', budget: {} })
  repo.finishRun(state.conn, someRun.id, 'done', { history_json: null, usage: {}, error: null, receipt: {}, saved_seq: 0 })
  const cases: [string, string][] = [
    ['wrong workspace', execution(state, session, { command: 'echo w1', workspace_id: other.workspace_id, stdout: 'CANARY-WS' })],
    ['no workspace', execution(state, session, { command: 'echo w2', workspace_id: null, stdout: 'CANARY-NULLWS' })],
    ['another run', execution(state, session, { command: 'echo w3', run_id: someRun.id, stdout: 'CANARY-RUN' })],
    ['another command', execution(state, session, { command: 'echo something else', stdout: 'CANARY-CMD' })],
    ['not final', execution(state, session, { command: 'echo w5', status: 'running' })],
    ['missing asset', execution(state, session, { command: 'echo w6', stdout_asset: () => 'a_missing00000' })],
    ['other project asset', execution(state, session, { command: 'echo w7', stdout_asset: (x) => state.store.save(state.conn, otherProject.id as string, 'log', 'CANARY-PROJECT', { ext: 'log', meta: { execution_id: x, stream: 'stdout', run_id: null } }).id })],
    ['wrong kind asset', execution(state, session, { command: 'echo w8', stdout_asset: (x) => state.store.save(state.conn, session.project_id, 'text', 'CANARY-KIND', { meta: { execution_id: x, stream: 'stdout', run_id: null } }).id })],
    ['another execution\'s asset', execution(state, session, { command: 'echo w9', stdout_asset: () => state.store.save(state.conn, session.project_id, 'log', 'CANARY-META', { ext: 'log', meta: { execution_id: 'x_other0000000', stream: 'stdout', run_id: null } }).id })],
    ['stderr as stdout', execution(state, session, { command: 'echo w10', stdout_asset: (x) => state.store.save(state.conn, session.project_id, 'log', 'CANARY-STREAM', { ext: 'log', meta: { execution_id: x, stream: 'stderr', run_id: null } }).id })],
  ]
  const commands = ['echo w1', 'echo w2', 'echo w3', 'echo w4', 'echo w5', 'echo w6', 'echo w7', 'echo w8', 'echo w9', 'echo w10']
  cases.forEach(([, xid], i) => command(state, session, commands[i]!, { xid }))
  // a remote execution (ssh): never read
  const remote = execution(state, session, { command: 'echo r', stdout: 'CANARY-REMOTE' })
  state.conn.run("UPDATE executions SET isolation_json=json_set(isolation_json, '$.runtime', 'ssh') WHERE id=?", [remote])
  command(state, session, 'echo r', { xid: remote })
  const reads = countReads(state)
  const s = await snapshot(c, session.id, { include_tool_details: true })
  const all = JSON.stringify(s.snapshot)
  for (const canary of ['CANARY-WS', 'CANARY-NULLWS', 'CANARY-RUN', 'CANARY-CMD', 'CANARY-PROJECT', 'CANARY-KIND', 'CANARY-META', 'CANARY-STREAM', 'CANARY-REMOTE']) expect(all).not.toContain(canary)
  expect(reads.n).toBe(0)
  const byHead = new Map(itemsOf(s, 'action').map((a) => [a.head, a.details]))
  // not this command's execution (folder, run, command): no details at all
  for (const cmd of ['echo w1', 'echo w2', 'echo w3', 'echo w4']) expect(byHead.get(`$ ${cmd}`)).toBeNull()
  // still running: nothing measured yet
  expect(byHead.get('$ echo w5')).toBeNull()
  // this command's, ended, its output not available here: the measured fields, no preview
  for (const cmd of ['echo w6', 'echo w7', 'echo w8', 'echo w9', 'echo w10', 'echo r']) expect(byHead.get(`$ ${cmd}`)).toMatchObject({ preview: null, fields: expect.arrayContaining([{ name: 'exit_code', value: 0 }]) })
})

test('the run_finished receipt stands in for an empty row receipt; an empty text falls back to the receipt\'s final text', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const session = await open(c)
  const xid = execution(state, session, { command: 'ls', stdout: 'FROM-EVENT-RECEIPT\n' })
  const run = command(state, session, 'ls', { xid })
  const receipt = repo.getRun(state.conn, run)!.receipt
  repo.insertEvent(state.conn, run, 1, 'run_finished', { status: 'done', usage: {}, error: null, receipt, reconciled: true })
  state.conn.run("UPDATE runs SET receipt_json='{}', user_text='' WHERE id=?", [run])
  const s = await snapshot(c, session.id, { include_tool_details: true })
  const a = itemsOf(s, 'action')[0]!
  expect(a).toMatchObject({ action: 'command', head: '$ ls', outcome: '→ exit 0', text: '$ ls\n→ exit 0' })
  expect(a.details!.preview).toBe('FROM-EVENT-RECEIPT\n')
  // no receipt anywhere and no text: an action still, said from its label
  const bare = recordHumanRun(state.conn, { session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, label: 'mystery (by hand)', kind: 'x', text: '', produced: {} })!
  state.conn.run("UPDATE runs SET receipt_json='{}' WHERE id=?", [bare])
  const s2 = await snapshot(c, session.id)
  const b = itemsOf(s2, 'action').find((i) => i.run === keyOf(s2, bare))
  expect(b).toMatchObject({ action: 'other', actor: 'person', what: 'mystery', by: null, head: '', outcome: null, text: '' })
})

test('other actions: kind, who, generated references masked; by time among the runs; exclusion drops and counts them', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const session = await open(c)
  const base = { session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, produced: {} }
  const before = repo.insertRun(state.conn, { session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, model: 'scripted:a', model_config: {}, user_text: 'first words', status: 'running', budget: {} })
  repo.finishRun(state.conn, before.id, 'done', { history_json: null, usage: {}, error: null, receipt: {}, saved_seq: 0 })
  const cp = recordHumanRun(state.conn, { ...base, label: 'checkpoint (by hand)', kind: 'checkpoint', text: 'checkpoint cp_0123456789ab: tidy up' })!
  const checks = recordHumanRun(state.conn, { ...base, label: 'checks (ChatGPT)', kind: 'verify', text: 'checks on cp_0123456789ab: lint pass, test fail' })!
  const integ = recordHumanRun(state.conn, { ...base, label: 'integration (by hand)', kind: 'integrate', text: 'integration of cp_aaaaaaaaaaaa, cp_bbbbbbbbbbbb: applied' })!
  const adopt = recordHumanRun(state.conn, { ...base, label: 'adopt n1', kind: 'integrate', text: 'adoption of step n1 (A, checkpoint cp_cccccccccccc): applied' })!
  const approved = recordHumanRun(state.conn, { ...base, label: 'approved bash', kind: 'approve_proposal', text: 'approved proposal a_dddddddddddd: ok' })!
  const conn_ = command(state, session, 'ls', { client: null })
  const after = repo.insertRun(state.conn, { session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, model: 'scripted:a', model_config: {}, user_text: 'last words', status: 'running', budget: {} })
  repo.finishRun(state.conn, after.id, 'done', { history_json: null, usage: {}, error: null, receipt: {}, saved_seq: 0 })
  // explicit times: the actions between the two runs
  const order = [before.id, cp, checks, integ, adopt, approved, conn_, after.id]
  order.forEach((id, i) => state.conn.run('UPDATE runs SET created_at=? WHERE id=?', [`2026-10-01T07:0${i}:00.000Z`, id]))
  const s = await snapshot(c, session.id)
  const all = JSON.stringify(s.snapshot)
  expect(all).not.toMatch(/cp_[0-9a-f]{12}|a_dddddddddddd/)
  expect(itemsOf(s, 'action').map((a) => [a.action, a.actor, a.what, a.by, a.head])).toEqual([
    ['checkpoint', 'person', 'checkpoint', null, 'checkpoint [id]: tidy up'],
    ['verify', 'connector', 'checks', 'ChatGPT', 'checks on [id]: lint pass, test fail'],
    ['integrate', 'person', 'integration', null, 'integration of [id], [id]: applied'],
    ['integrate', 'person', 'adopt n1', null, 'adoption of step n1 (A, checkpoint [id]): applied'],
    ['approve_proposal', 'person', 'approved bash', null, 'approved proposal [id]: ok'],
    ['command', 'connector', 'command', 'connector', '$ ls'],
  ])
  const firstAt = s.snapshot.items.findIndex((i) => i.kind === 'message' && i.text === 'first words')
  const lastAt = s.snapshot.items.findIndex((i) => i.kind === 'message' && i.text === 'last words')
  const actionAt = s.snapshot.items.map((i, n) => (i.kind === 'action' ? n : -1)).filter((n) => n >= 0)
  expect(actionAt.every((n) => n > firstAt && n < lastAt)).toBe(true)
  // non-command actions have no details to count
  expect(s.snapshot.stats.omitted.tool_details).toBe(0)
  // a row of no known kind whose text is a command's is classified as one (fail closed)
  const odd = recordHumanRun(state.conn, { ...base, label: 'mystery', kind: 'x', text: '$ printenv\n→ exit 0' })!
  state.conn.run('UPDATE runs SET created_at=? WHERE id=?', ['2026-10-01T07:09:00.000Z', odd])
  const withOdd = await snapshot(c, session.id)
  expect(itemsOf(withOdd, 'action').at(-1)).toMatchObject({ action: 'other', what: 'mystery', head: null, text: null, withheld: 'sensitive_source', outcome: '→ exit 0' })
  expect(JSON.stringify(withOdd.snapshot)).not.toContain('printenv')
  const ex = await snapshot(c, session.id, { exclude_run_ids: [cp, approved, odd] })
  expect(itemsOf(ex, 'action').map((a) => a.action)).toEqual(['verify', 'integrate', 'integrate', 'command'])
  expect(ex.snapshot.stats.omitted.runs_excluded).toBe(3)
})

test('group notes: the person\'s words to members with their delivery, named as the app names them; the steer that carried one is not said again', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const session = await open(c)
  const ix = repo.insertInteraction(state.conn, {
    session_id: session.id, status: 'done', user_text: 'compare the fixes', participants: [{ id: 'A', label: 'Scripted A', model: 'scripted:a' }, { id: 'B', label: 'Twin', model: 'scripted:b' }, { id: 'C', label: 'Twin', model: 'scripted:a' }],
    controller: 'harness' as never, template: null, then: 'stop', budget: { max_runs: 3, concurrency: 1 }, run_budget: {}, base_checkpoint_id: null, fresh: false, resumes_run_id: null,
    thinking: null, mentions: [], attachments: [], director_session_id: null, client_request_id: null,
  })
  const run = repo.insertRun(state.conn, { session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, model: 'scripted:a', model_config: {}, user_text: 'step', status: 'running', budget: {}, interaction_id: ix.id })
  const queued = repo.insertInteractionNote(state.conn, { interaction_id: ix.id, to: 'everyone', text: `queued words ${GH}` })
  const partly = repo.insertInteractionNote(state.conn, { interaction_id: ix.id, to: 'everyone', text: 'partly words' })
  repo.updateInteractionNote(state.conn, partly.id, { status: 'partly', delivered: { A: run.id } })
  const delivered = repo.insertInteractionNote(state.conn, { interaction_id: ix.id, to: 'B', text: 'delivered words' })
  repo.updateInteractionNote(state.conn, delivered.id, { status: 'delivered', delivered: { B: run.id } })
  const lost = repo.insertInteractionNote(state.conn, { interaction_id: ix.id, to: 'A', text: 'undelivered words' })
  repo.updateInteractionNote(state.conn, lost.id, { status: 'undelivered' })
  const steerOf = (id: string, text: string, key: string): SteerRecord => ({ id, run_id: run.id, session_id: session.id, text, client_request_id: key, status: 'delivered', by: 'person',
    queued_at: new Date().toISOString(), queued_seq: 1, delivered_at: new Date().toISOString(), delivered_seq: 2, request_index: 1, reason: null })
  const internal = steerOf('st_note', `App note: The user wrote while the steps ran, to B:\ndelivered words`, `note:${delivered.id}`)
  const genuine = steerOf('st_real', 'a genuine steer', 'k-12345678')
  repo.insertEvent(state.conn, run.id, 1, 'steer_delivered', { steer: internal })
  repo.insertEvent(state.conn, run.id, 2, 'steer_delivered', { steer: genuine })
  repo.finishRun(state.conn, run.id, 'done', {
    history_json: JSON.stringify([{ kind: 'request', parts: [{ part_kind: 'user-prompt', content: 'step', origin: 'app' }] },
      { kind: 'request', parts: [{ part_kind: 'user-prompt', content: internal.text, steer_id: 'st_note' }, { part_kind: 'user-prompt', content: genuine.text, steer_id: 'st_real' }] },
      { kind: 'response', parts: [{ part_kind: 'text', content: 'step answer' }] }]),
    usage: {}, error: null, receipt: {}, saved_seq: 2,
  })
  const s = await snapshot(c, session.id)
  const all = JSON.stringify(s.snapshot)
  const notes = itemsOf(s, 'group_note')
  const g = itemsOf(s, 'group')[0]!.group
  expect(notes.map(({ key: _k, at: _a, ...n }) => n)).toEqual([
    { kind: 'group_note', run: null, group: g, to: null, text: 'queued words [redacted]', status: 'queued', delivered_to: [] },
    { kind: 'group_note', run: null, group: g, to: null, text: 'partly words', status: 'partly', delivered_to: ['Scripted A'] },
    { kind: 'group_note', run: null, group: g, to: 'B', text: 'delivered words', status: 'delivered', delivered_to: ['B'] },
    { kind: 'group_note', run: null, group: g, to: 'Scripted A', text: 'undelivered words', status: 'undelivered', delivered_to: [] },
  ])
  expect(all).not.toContain('App note')
  expect(all).not.toContain('inote_')
  expect(all).not.toContain(run.id)
  const steers = itemsOf(s, 'message').filter((m) => m.source === 'steer')
  expect(steers.map((m) => m.text)).toEqual(['a genuine steer'])
  expect(s.snapshot.stats.omitted.app_notes).toBeGreaterThanOrEqual(1)
})

test('versions: an old V1 snapshot still reads; V1 stays its six kinds; V2 and the reader refuse what they do not know', async () => {
  const v1 = JSON.parse(readFileSync(V1_FIXTURE, 'utf8'))
  expect(ShareSnapshotV1Schema.safeParse(v1).success).toBe(true)
  const read = ShareSnapshotSchema.parse(v1)
  expect(read.version).toBe(1)
  expect(ShareSnapshotV2Schema.safeParse(v1).success).toBe(false)
  // V1 never takes the new kinds
  const action = { kind: 'action', key: 'i9', run: 'r2', at: null, action: 'command', actor: 'connector', what: 'command', by: 'ChatGPT', head: '$ ls', outcome: '→ exit 0', text: '$ ls\n→ exit 0', details: null, withheld: null }
  expect(ShareActionItemSchema.safeParse(action).success).toBe(true)
  expect(ShareSnapshotV1Schema.safeParse({ ...v1, items: [...v1.items, action] }).success).toBe(false)
  const v2 = { ...v1, version: 2, items: [...v1.items.slice(0, 3), action] }
  expect(ShareSnapshotV2Schema.safeParse(v2).success).toBe(true)
  expect(ShareSnapshotV1Schema.safeParse(v2).success).toBe(false)
  expect(ShareSnapshotSchema.parse(v2).version).toBe(2)
  // strict: an unknown field of an item, an unknown kind, a future version
  expect(ShareSnapshotV2Schema.safeParse({ ...v2, items: [{ ...action, command: 'ls' }] }).success).toBe(false)
  expect(ShareSnapshotV2Schema.safeParse({ ...v2, items: [{ ...action, kind: 'shell' }] }).success).toBe(false)
  expect(ShareSnapshotSchema.safeParse({ ...v2, version: 3 }).success).toBe(false)
  // the answer is the latest version only
  expect(ShareSnapshotResponseSchema.safeParse({ snapshot: v1, selection: { runs: [] } }).success).toBe(false)
  expect(ShareSnapshotResponseSchema.safeParse({ snapshot: v2, selection: { runs: [] } }).success).toBe(true)
  expect([...SHARE_LIMITS_V1_KEYS] as string[]).toEqual(Object.keys(v1.limits))
  expect([...SHARE_LIMITS_V1_KEYS] as string[]).toEqual(Object.keys(SHARE_LIMITS))
})

test('through the real command route: a connector\'s command and its sealed output; a sensitive one withheld whole', async () => {
  const folder = join(tempDir('oasis-share-cmd-'), 'folder')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'README.md'), '# synthetic\n')
  const settings = new Settings({ data_dir: join(tempDir('oasis-data-'), 'data'), host: '127.0.0.1', port: 0, session_token: 'test-token' })
  app = await makeApp(settings, { probe: false, runtime: new PassthroughRuntime(), isolation: { ...FAKE_FULL, runtime: 'passthrough' } })
  await app.start()
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: folder, mode: 'direct' }))
  const s0 = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'route' }))
  const wsId = (s0.workspace as { id: string }).id
  const connector = { 'x-oasis-code-connector': 'ChatGPT' }
  const ok = await json(await c.post(`/api/workspaces/${wsId}/commands`, { command: "printf 'ROUTE-OUT\\n'; printf 'ROUTE-ERR\\n' >&2", wait_s: 20 }, connector))
  expect(ok.exit_code).toBe(0)
  const bad = await json(await c.post(`/api/workspaces/${wsId}/commands`, { command: 'env -i SYNTH_ONLY=ROUTE-ENV-CANARY printenv', wait_s: 20 }, connector))
  expect(bad.exit_code).toBe(0)
  for (const details of [false, true]) {
    const s = await snapshot(c, s0.id as string, { include_tool_details: details })
    const all = JSON.stringify(s.snapshot)
    const [first, second] = itemsOf(s, 'action')
    expect(first).toMatchObject({ actor: 'connector', by: 'ChatGPT', head: "$ printf 'ROUTE-OUT\\n'; printf 'ROUTE-ERR\\n' >&2", outcome: '→ exit 0', withheld: null })
    expect(second).toMatchObject({ withheld: 'sensitive_source', head: null, text: null, details: null, outcome: '→ exit 0' })
    expect(all).not.toContain('ROUTE-ENV-CANARY')
    expect(all).not.toContain(String(ok.execution_id))
    if (details) expect(first!.details!.preview).toBe('ROUTE-OUT\n\n[stderr]\nROUTE-ERR\n')
    else { expect(first!.details).toBeNull(); expect(all).not.toContain('ROUTE-OUT\n') }
  }
}, 60_000)

test('a command run in the session\'s copy, its cwd recorded under the other spelling of the copy (/tmp ↔ /private/tmp): shown; the data folder, a way out of the copy or a longer name under either spelling: withheld', async () => {
  // the data folder as configured under /tmp (macOS's real path of it is /private/tmp/…): the copy is stored as
  // `<data>/workspaces/<id>` so, while a command's execution records the real path it ran at
  const base = mkdtempSync('/tmp/oasis-share-cwd-')
  try {
    app = await makeApp(new Settings({ data_dir: join(base, 'data'), host: '127.0.0.1', port: 0, session_token: 'test-token' }))
    const c = new Client(app)
    const session = await open(c)
    const ws = repo.getWorkspace(app.state.conn, session.workspace_id!)!
    expect(ws.kind).not.toBe('direct')
    expect(ws.path).toBe(join(app.state.settings.workspaces_dir, ws.id))
    const data = app.state.settings.data_dir
    const flip = (p: string) => (p.startsWith('/private/') ? p.slice('/private'.length) : `/private${p}`)
    for (const direction of ['stored /tmp, executed /private/tmp', 'stored /private/tmp, executed /tmp'] as const) {
      // the other direction: the copy's row under the real spelling, its execution under the configured one
      const stored = direction.startsWith('stored /tmp') ? ws.path : flip(ws.path)
      app.state.conn.run('UPDATE workspaces SET path=? WHERE id=?', [stored, ws.id])
      expect(stored.startsWith(direction.startsWith('stored /tmp') ? '/tmp/' : '/private/tmp/')).toBe(true)
      const ran = flip(stored)                                                     // where the command ran, as recorded
      const tag = direction.startsWith('stored /tmp') ? 'a' : 'b'
      const cases: [string, string, boolean][] = [
        [`printf ${tag}-root`, ran, false],                                         // the copy itself
        [`printf ${tag}-sub`, `${ran}/src`, false],                                 // inside it
        [`printf ${tag}-same`, stored, false],                                      // the spelling it is stored under
        [`printf ${tag}-data`, flip(data), true],                                   // the data folder, the other spelling
        [`printf ${tag}-data-same`, data, true],                                    // … and as configured
        [`printf ${tag}-escape`, `${ran}/../..`, true],                             // out of the copy, into the data folder
        [`printf ${tag}-prefix`, `${ran}_evil`, true],                              // a longer name that starts the same
        [`cat ${data}/notes/plain-${tag}.txt`, ran, true],                          // an argument naming the data folder
        [`cat ${flip(data)}/notes/plain-${tag}.txt`, ran, true],                    // … under the other spelling
      ]
      for (const [cmd, cwd] of cases) command(app.state, session, cmd, { xid: execution(app.state, session, { command: cmd, cwd, stdout: `${cmd} out\n` }) })
      // macOS: /tmp and /private/tmp are one place, so the copy's other spelling is the copy. Elsewhere they are not
      // promised to be: only a copy stored as configured, and a cwd under that very spelling, is read as inside it —
      // the rest is read whole (and is under a spelling of the data folder: withheld)
      if (process.platform !== 'darwin') {
        for (const k of cases) k[2] = k[2] || stored !== ws.path || !(k[1] === ws.path || k[1].startsWith(`${ws.path}/`))
      }
      const s = await snapshot(c, session.id)
      const actions = itemsOf(s, 'action')
      for (const [cmd, , withheld] of cases) {
        const item = actions.find((a) => (withheld ? a.withheld === 'sensitive_source' && a.outcome === '→ exit 0' && a.head === null : a.head === `$ ${cmd}`)
          && s.selection.runs.find((r) => r.key === a.run)!.label === 'command (ChatGPT)' && repo.getRun(app!.state.conn, s.selection.runs.find((r) => r.key === a.run)!.run_id)!.user_text.startsWith(`$ ${cmd}\n`))
        expect({ direction, cmd, found: item !== undefined }).toEqual({ direction, cmd, found: true })
      }
      // nothing of a withheld command or of either spelling of the data folder or the copy reaches the snapshot
      const body = JSON.stringify(s.snapshot)
      for (const p of [data, flip(data), stored, ran]) expect(body).not.toContain(p)
      for (const [cmd, , withheld] of cases) if (withheld) expect(body).not.toContain(cmd)
      if (process.platform === 'darwin') expect(cases.filter((k) => !k[2]).length).toBe(3)
    }
  } finally {
    if (app) { await app.close(); app = null }
    rmSync(base, { recursive: true, force: true })
  }
})
