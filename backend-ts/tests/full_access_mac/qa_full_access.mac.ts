/** QA (agent-qa) fixture tests for Full access, real processes only. Run by qa/run-product-fixture.sh, which builds the
 *  fixture (private HOME with zsh rc files, private TMPDIR, fresh SSH key in a private ssh-agent, a loopback SSH server
 *  that verifies the agent's signature) and starts bun with that environment, as a desktop app or terminal would start
 *  the backend. The test is copied into <tree>/backend-ts/tests/ of a COPY of the baseline or the candidate; nothing
 *  here edits product code.
 *
 *  What is asserted is observable behaviour (the command's HOME/PATH/TMPDIR/SSH_AUTH_SOCK/UID, the rc files' own log,
 *  the SSH server's signature check, files outside the workspace, process liveness, HTTP status), so on the baseline
 *  (no Full access) the full-access cases fail by behaviour, not by a missing module.
 *
 *  Kept as tests/full_access_mac/qa_full_access.mac.ts (not picked up by `bun test`); run-product-fixture.sh copies it
 *  into a tree copy's tests/ as qa_full_access.test.ts. Env (set by the runner): QA_FX fixture dir; QA_SOCK socket dir; QA_REFERENCE the terminal reference dump file;
 *  QA_V27_DATA a v27 data dir made by the baseline (optional). */

import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as repo from '../src/db/repo.ts'
import * as gate from '../src/policy/gate.ts'
import { connect } from '../src/db/database.ts'
import { modelResponse, textPart, toolCallPart, userTexts, type ModelMessage } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { domainState, FAKE_FULL, PassthroughRuntime, scriptedModel, setModel, sleep, testSettings, waitDone, type DomainState } from './harness.ts'
import { tempDir } from './helpers.ts'

const FX = process.env.QA_FX ?? ''
const SOCK = process.env.QA_SOCK ?? ''
const ENABLED = FX !== '' && existsSync(join(FX, 'dump.sh'))
if (!ENABLED) console.warn('[qa_full_access] QA_FX not set or fixture missing: run tests/full_access_mac/run-product-fixture.sh (these tests need the fixture)')

// canaries: the backend's own control credentials, present in its environment, must never reach a command
const CANARY_SESSION = 'qa-canary-session-token-7f3a91'
const CANARY_DIRECTOR = 'qa-canary-director-token-c0ffee'

type Dump = Record<string, string>
function parseDump(text: string): Dump {
  const begin = text.indexOf('QA_DUMP_BEGIN'); const end = text.indexOf('QA_DUMP_END')
  if (begin < 0 || end < 0) return {}
  const out: Dump = {}
  for (const line of text.slice(begin, end).split('\n').slice(1)) {
    const i = line.indexOf('='); if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).replace(/\r$/, '')
  }
  return out
}
const reference = (): Dump => parseDump(readFileSync(process.env.QA_REFERENCE!, 'utf8'))
const rcLines = (): string[] => readFileSync(join(FX, 'logs/rc-runs.log'), 'utf8').split('\n').filter(Boolean)
/** pids whose command line carries `pattern` (pgrep: /bin/ps is setuid and cannot be executed in this QA sandbox) */
function pidsWith(pattern: string): number[] {
  const r = spawnSync('pgrep', ['-f', '--', pattern], { encoding: 'utf8' })
  return (r.stdout ?? '').split('\n').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 1 && n !== process.pid)
}
async function noneWith(pattern: string, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) { if (pidsWith(pattern).length === 0) return true; await sleep(50) }
  return pidsWith(pattern).length === 0
}
/** cleanup of this test's own fixture processes only: matched by a nonce no other process carries */
function killNonce(nonce: string): void {
  if (!/^qa[0-9a-f]{12}$/.test(nonce)) throw new Error('bad nonce')
  for (const pid of pidsWith(nonce)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
}
const newNonce = (): string => `qa${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('')}`

const FULL_ENV_KEYS = ['HOME', 'PATH', 'TMPDIR', 'SSH_AUTH_SOCK', 'QA_ZSHENV_MARK', 'QA_ZPROFILE_MARK', 'QA_ZSHRC_MARK', 'UID', 'GID', 'TOOL_ZPROFILE', 'TOOL_ZSHRC', 'XDG_CONFIG_HOME', 'ZDOTDIR', 'BASH_ENV', 'ENV']
function expectTerminalEquivalent(got: Dump): void {
  const ref = reference()
  expect(ref.HOME).toBe(join(FX, 'home'))                                     // the reference itself is the fixture's
  for (const key of FULL_ENV_KEYS) {
    if (key === 'QA_ZSHENV_MARK') { expect(got[key]?.startsWith('zshenv-')).toBe(true); continue }   // carries a pid
    expect({ key, value: got[key] }).toEqual({ key, value: ref[key] })
  }
  expect(Number(got.UID)).toBe(process.getuid!())
  expect(got.UID).not.toBe('0')
}

let app: App | null = null
let domain: DomainState | null = null
afterEach(async () => {
  if (app) await app.close(); app = null
  if (domain) await domain.close(); domain = null
  rmSync(join(FX, 'slow-rc'), { force: true })
})

/** The app the desktop app would run (REST + runner); sandbox commands through the passthrough runtime: the OS
 *  confinement cannot nest here (outer sandbox), so sandbox-side *denials* are not observable in this file. */
async function qaApp(): Promise<{ c: Client; app: App }> {
  process.env.OASIS_CODE_SESSION_TOKEN = CANARY_SESSION
  process.env.OASIS_CODE_DIRECTOR_TOKEN = CANARY_DIRECTOR
  app = await makeApp(null, { probe: false, runtime: new PassthroughRuntime(), isolation: { ...FAKE_FULL, runtime: 'passthrough' } })
  return { c: new Client(app), app }
}
async function directSession(c: Client, body: Record<string, unknown> = {}) {
  const folder = tempDir('qa-ws-')
  writeFileSync(join(folder, 'README.md'), '# qa\n')
  const project = await json(await c.post('/api/projects', { source_path: folder, mode: 'direct' }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'qa', ...body }))
  return { folder, project, sid: s.id as string, session: s, ws: s.workspace as Record<string, unknown> }
}
/** One agent bash call through the runner (the agent's Bash path), then 'done'; the execution and the first prompt. */
async function agentBash(a: App, sid: string, command: string, opts: { timeout_s?: number } = {}) {
  let firstPrompt = ''
  let issued = false                                                          // one bash call per run (a continued
  setModel(a.state, 'scripted:a', scriptedModel((m: ModelMessage[]) => {      // conversation carries earlier returns)
    if (!firstPrompt) firstPrompt = userTexts(m).join('\n')
    if (issued) return modelResponse([textPart('done')])
    issued = true
    return modelResponse([toolCallPart('bash', { command, ...(opts.timeout_s ? { timeout_s: opts.timeout_s } : {}) }, '')])
  }))
  const session = repo.getSession(a.state.conn, sid)!
  const run = await waitDone(a.state, (await a.state.runs.start(session, 'run it')).id, 120_000)
  const xs = repo.listExecutions(a.state.conn, { run_id: run.id })
  const x = xs[0]
  const summary = x ? a.state.processes.summary(x.id) : null
  return { run, x, summary, out: String(summary?.stdout ?? ''), firstPrompt }
}

describe.skipIf(!ENABLED)('Full access on the fixture (real login shell, real ssh, real processes)', () => {
  test('[A] ProcessManager: a full command sees what the terminal sees; the rc runs inside the supervised process', async () => {
    process.env.OASIS_CODE_SESSION_TOKEN = CANARY_SESSION
    process.env.OASIS_CODE_DIRECTOR_TOKEN = CANARY_DIRECTOR
    domain = domainState()
    const cwd = tempDir('qa-pm-')
    const project = await domain.workspaces.importProject('qa-pm', cwd, { mode: 'direct' })   // a real project row
    const before = rcLines().length
    const x = await domain.processes.start({
      command: `sh ${join(FX, 'dump.sh')}; env`, cwd, project_id: project.id, workspace_id: null, timeout_s: 60,
      sandbox: { writable: [cwd], write_deny: [], read_deny: [], read_allow: [cwd], network: true },
      access: 'full',
    } as never)
    await domain.processes.wait(x.id, 65)
    const s = domain.processes.summary(x.id)
    const out = String(s.stdout)
    expectTerminalEquivalent(parseDump(out))
    const rec = repo.getExecution(domain.conn, x.id)!
    expect(rec.isolation).toMatchObject({ runtime: 'host', access_mode: 'full' })
    expect(rec.stdout_asset_id).toBeTruthy()                                  // the output is kept (sealed as an asset)
    // the rc files ran in the command's own process (login + interactive), carrying this execution's id: not an
    // earlier, unsupervised shell
    const added = rcLines().slice(before)
    expect(added.some((l) => l.startsWith('zprofile ') && l.includes(`xid=${x.id}`))).toBe(true)
    expect(added.some((l) => l.startsWith('zshrc ') && l.includes(`xid=${x.id}`))).toBe(true)
    expect(added.every((l) => l.includes(`xid=${x.id}`))).toBe(true)
    // the harness's own credentials never reach a command
    expect(out).not.toContain(CANARY_SESSION)
    expect(out).not.toContain(CANARY_DIRECTOR)
    expect(out).not.toContain('test-token')
  })

  test('[A] REST default session is Full; the agent Bash path sees the terminal environment; the prompt does not misname $TMPDIR', async () => {
    const { c, app: a } = await qaApp()
    const { sid, session } = await directSession(c)
    expect(session.access_mode).toBe('full')
    const r = await agentBash(a, sid, `sh ${join(FX, 'dump.sh')}`)
    expect(r.x).toBeDefined()
    expectTerminalEquivalent(parseDump(r.out))
    // context.temp: "Temporary folder: <path> ($TMPDIR)" may only name $TMPDIR when it is that folder
    const m = /Temporary folder: (\S+) \(\$TMPDIR\)/.exec(r.firstPrompt)
    if (m) expect(m[1]!.replace(/\/$/, '')).toBe(parseDump(r.out).TMPDIR!.replace(/\/$/, ''))
  })

  test('[B] ssh through the agent Bash path: the fixture agent signs, the server verifies; a Sandbox session has no agent', async () => {
    const { c, app: a } = await qaApp()
    const full = await directSession(c)
    const serverLog = join(FX, 'logs/sshserver.log')
    const agentLog = join(FX, 'logs/ssh-agent.log')
    const serverBefore = readFileSync(serverLog, 'utf8').split('\n').length
    const signsBefore = (readFileSync(agentLog, 'utf8').match(/process_sign_request2: good signature/g) ?? []).length
    const r = await agentBash(a, full.sid, join(FX, 'ssh/handshake.sh'))
    expect(r.out).toContain('QA_SSH_EXIT=0')
    expect(r.out).toMatch(/Authenticated to 127\.0\.0\.1 \(\[127\.0\.0\.1\]:\d+\) using "publickey"/)
    expect(r.out).toContain('explicit agent')                                  // the key offered is the agent's
    const serverAdded = readFileSync(serverLog, 'utf8').split('\n').slice(serverBefore - 1).join('\n')
    expect(serverAdded).toMatch(/publickey signature .* verified=true -> accept/)
    expect(serverAdded).toContain('QA_SSH_AUTHENTICATED')
    expect((readFileSync(agentLog, 'utf8').match(/process_sign_request2: good signature/g) ?? []).length).toBeGreaterThan(signsBefore)
    // the same command in a Sandbox session: no SSH_AUTH_SOCK reaches it (the guard refuses before ssh runs)
    const boxed = await directSession(c, { access_mode: 'sandbox' })
    const rb = await agentBash(a, boxed.sid, join(FX, 'ssh/handshake.sh'))
    expect(rb.out).toContain('QA_SSH_NO_FIXTURE_AGENT')
  })

  test('[C] Full writes outside the workspace; the Sandbox side is recorded, its denial needs real Seatbelt', async () => {
    const { c, app: a } = await qaApp()
    const { sid } = await directSession(c)
    const target = join(FX, 'outside', `full-${newNonce()}.txt`)
    const r = await agentBash(a, sid, `echo written-by-full > ${target} && echo WROTE`)
    expect(r.out).toContain('WROTE')
    expect(readFileSync(target, 'utf8')).toBe('written-by-full\n')
    expect(r.x!.isolation).toMatchObject({ access_mode: 'full' })
    // sandbox: recorded as the sandbox (the denial itself is test_isolation_probe's, on a host where Seatbelt nests)
    const boxed = await directSession(c, { access_mode: 'sandbox' })
    const rb = await agentBash(a, boxed.sid, 'echo SANDBOX_RAN')
    expect(rb.x!.isolation).toMatchObject({ access_mode: 'sandbox' })
    expect(rb.x!.isolation.runtime).not.toBe('host')
  })

  test('[Plan/Ask] no rc file runs for Plan, for a proposal, for reading or creating; it runs once approved, in the approved command', async () => {
    const { c, app: a } = await qaApp()
    const { sid } = await directSession(c)
    const n0 = rcLines().length
    await json(await c.get(`/api/sessions/${sid}`))
    await c.get(`/api/sessions/${sid}/access`)
    expect(rcLines().length).toBe(n0)                                          // creating / reading: nothing ran
    await json(await c.put(`/api/sessions/${sid}/mode`, { mode: 'plan' }))
    const plan = await agentBash(a, sid, `sh ${join(FX, 'dump.sh')}`)
    expect(plan.x).toBeUndefined()
    expect(rcLines().length).toBe(n0)                                          // Plan: no command, no rc
    await json(await c.put(`/api/sessions/${sid}/mode`, { mode: 'approve' }))
    const ask = await agentBash(a, sid, `sh ${join(FX, 'dump.sh')}`)
    expect(ask.x).toBeUndefined()
    expect(rcLines().length).toBe(n0)                                          // Ask: proposed, nothing ran yet
    const project = repo.getSession(a.state.conn, sid)!.project_id
    const pending = gate.listProposals(a.state.conn, project, sid).filter((p) => p.status === 'pending')
    expect(pending.length).toBe(1)
    // a pending proposal holds the access where it is
    const blocked = await c.put(`/api/sessions/${sid}/access`, { access_mode: 'sandbox' })
    expect(blocked.status).toBe(409)
    expect(rcLines().length).toBe(n0)
    const decided = await gate.decideProposal(a.state, pending[0]!.proposal_asset_id, 'approve')
    const xid = String((decided.result as Record<string, unknown>).execution_id)
    const x = repo.getExecution(a.state.conn, xid)!
    expect(x.isolation).toMatchObject({ access_mode: 'full', runtime: 'host' })
    const added = rcLines().slice(n0)
    expect(added.length).toBeGreaterThan(0)
    expect(added.every((l) => l.includes(`xid=${xid}`))).toBe(true)
  })

  test('[idle-only] a running command blocks an access change (409, unchanged); stop ends only its own tree; the other session runs on', async () => {
    const { c, app: a } = await qaApp()
    const A = await directSession(c)
    const B = await directSession(c)
    const na = newNonce(); const nb = newNonce()
    const escape = join(FX, 'escape.py')
    writeFileSync(escape, [
      'import os,subprocess,sys,time',
      'n=sys.argv[1]',
      // a grandchild that leaves the process group and clears its environment (no execution id to find it by)
      "subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)',n+'-child'],env={'PATH':'/usr/bin:/bin'},start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)",
      'print("STARTED",flush=True)',
      'time.sleep(120)',
    ].join('\n'))
    const start = async (sid: string, ws: Record<string, unknown>, nonce: string) => {
      const session = repo.getSession(a.state.conn, sid)!
      return a.state.processes.start({
        command: `python3 ${escape} ${nonce}`, cwd: String(ws.path), project_id: session.project_id, workspace_id: String(ws.id), timeout_s: 120,
        sandbox: { writable: [String(ws.path)], write_deny: [], read_deny: [], read_allow: [String(ws.path)], network: true }, access: 'full',
      } as never)
    }
    try {
      const xa = await start(A.sid, A.ws, na)
      const xb = await start(B.sid, B.ws, nb)
      const until = Date.now() + 10_000
      while ((pidsWith(`${na}-child`).length === 0 || pidsWith(`${nb}-child`).length === 0) && Date.now() < until) await sleep(50)
      expect(pidsWith(`${na}-child`).length).toBe(1)
      expect(pidsWith(`${nb}-child`).length).toBe(1)
      // the switch is refused while A's command runs, and says why; nothing changed
      const refused = await c.put(`/api/sessions/${A.sid}/access`, { access_mode: 'sandbox' })
      expect(refused.status).toBe(409)
      const body = await refused.json() as Record<string, unknown>
      expect((body.blocked_by as Record<string, number>).executions).toBeGreaterThanOrEqual(1)
      expect((await json(await c.get(`/api/sessions/${A.sid}`))).access_mode).toBe('full')
      // stop A: its command and the escaped grandchild end; B's tree is untouched
      expect(a.state.processes.stop(xa.id)).toBe(true)
      await a.state.processes.wait(xa.id, 10)
      expect(await noneWith(na)).toBe(true)
      expect(pidsWith(`${nb}-child`).length).toBe(1)
      expect(a.state.processes.isRunning(xb.id)).toBe(true)
      // A idle now: the switch lands; B (Full) keeps running as it started
      const switched = await json(await c.put(`/api/sessions/${A.sid}/access`, { access_mode: 'sandbox' }))
      expect(switched.access_mode).toBe('sandbox')
      expect(pidsWith(`${nb}-child`).length).toBe(1)
      a.state.processes.stop(xb.id)
      await a.state.processes.wait(xb.id, 10)
      expect(await noneWith(nb)).toBe(true)
    } finally { killNonce(na); killNonce(nb) }
  })

  test('[timeout] a slow rc counts in the command timeout and is stopped with it (no sleep left behind)', async () => {
    domain = domainState()
    const cwd = tempDir('qa-pm-')
    const project = await domain.workspaces.importProject('qa-pm', cwd, { mode: 'direct' })
    const length = `29.${Math.floor(Math.random() * 9000 + 1000)}`
    writeFileSync(join(FX, 'slow-rc'), length)
    try {
      const x = await domain.processes.start({
        command: 'echo NEVER_REACHED', cwd, project_id: project.id, workspace_id: null, timeout_s: 3,
        sandbox: { writable: [cwd], write_deny: [], read_deny: [], read_allow: [cwd], network: true }, access: 'full',
      } as never)
      await domain.processes.wait(x.id, 15)
      const s = domain.processes.summary(x.id)
      expect(s.status).toBe('timeout')
      expect(String(s.stdout)).not.toContain('NEVER_REACHED')
      expect(await noneWith(`sleep ${length}`)).toBe(true)
    } finally {
      rmSync(join(FX, 'slow-rc'), { force: true })
      for (const pid of pidsWith(`sleep ${length}`)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    }
  })

  test('[director] connector commands: no access field or a v5 surface keep the sandbox; v6 with access=session follows the session', async () => {
    const { c } = await qaApp()
    const { ws } = await directSession(c)
    const dump = `sh ${join(FX, 'dump.sh')}`
    const plain = await json(await c.post(`/api/workspaces/${ws.id}/commands`, { command: dump, wait_s: 60 }))
    expect(parseDump(String(plain.stdout)).HOME).not.toBe(join(FX, 'home'))
    const v5 = await json(await c.post(`/api/workspaces/${ws.id}/commands`, { command: dump, wait_s: 60, access: 'session' }, { 'x-oasis-tool-surface': 'director.v5' }))
    expect(parseDump(String(v5.stdout)).HOME).not.toBe(join(FX, 'home'))
    const v6 = await json(await c.post(`/api/workspaces/${ws.id}/commands`, { command: dump, wait_s: 60, access: 'session' }, { 'x-oasis-tool-surface': 'director.v6' }))
    expectTerminalEquivalent(parseDump(String(v6.stdout)))
  })
})

describe.skipIf(!process.env.QA_V27_DATA)('migration from a v27 database (made by the baseline)', () => {
  test('[v27] every existing session reads as Full access after the upgrade, its mode (Auto, Plan) and grants kept; a new REST session is Full', async () => {
    const copy = tempDir('qa-v27-')
    cpSync(process.env.QA_V27_DATA!, copy, { recursive: true })
    const settings = testSettings()
    mkdirSync(settings.data_dir, { recursive: true })
    cpSync(copy, settings.data_dir, { recursive: true })
    const conn = connect(settings.db_path)
    const sessions = conn.all('SELECT id FROM sessions') as { id: string }[]
    expect(sessions.length).toBe(2)
    for (const { id } of sessions) expect(repo.getSession(conn, id)!.access_mode).toBe('full')
    // the baseline set one session in Auto and one in Plan (make_v27_db.ts, its applySessionMode): both kept as they were
    const before = JSON.parse(readFileSync(join(settings.data_dir, 'v27-fixture.json'), 'utf8')) as { auto: string; plan: string; sessions: Record<string, { grants: Record<string, unknown>; control: { desired_state: string; gate_effects: string[] }; mode: string }> }
    const { inferMode } = await import('@oasis-code/contract/modes')
    for (const [id, was] of Object.entries(before.sessions)) {
      const now = repo.getSession(conn, id)!
      const control = gate.effectiveControl(conn, id)
      expect(now.grants).toEqual(was.grants as never)
      expect({ desired_state: control.desired_state, gate_effects: control.gate_effects }).toEqual(was.control)
      expect(inferMode(now.grants, control)).toBe(was.mode as never)
    }
    expect(before.sessions[before.plan]!.mode).toBe('plan')
    expect(before.sessions[before.auto]!.mode).toBe('auto')
    conn.close()
    app = await makeApp(settings, { probe: false, runtime: new PassthroughRuntime(), isolation: { ...FAKE_FULL, runtime: 'passthrough' } })
    const c = new Client(app)
    for (const { id } of sessions) expect((await json(await c.get(`/api/sessions/${id}`))).access_mode).toBe('full')
    const project = repo.listProjects(app.state.conn)[0]!
    const fresh = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'new' }))
    expect(fresh.access_mode).toBe('full')
  })
})
