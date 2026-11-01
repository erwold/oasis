/** Full access (schema v28): where a session's commands run, beside its mode. A new session the app or the REST API
 *  makes runs its commands as the user — the user's login and interactive shell, its HOME, TMPDIR, PATH, functions and
 *  SSH_AUTH_SOCK — and a session from before (or one set to it) keeps the sandbox. Plan runs no command and reads no
 *  startup file; Ask proposes first and the approval runs no wider than the proposal; a director of surface v1–v5
 *  keeps the sandbox for everything it starts; the access changes only while nothing of the session is outstanding.
 *
 *  Every host here is a fixture: its own HOME with its own startup files, never the person's. The isolation runtime is
 *  unavailable in these apps (probe off), so a command that would run in the sandbox is refused — the difference
 *  between the two accesses is what runs at all. */

import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseUiInputRequest, type Run, type UiInputRecord } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { modelResponse, textPart, toolCallPart, toolReturns, type ModelMessage } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { scriptedModel, setModel, sleep, waitDone } from './harness.ts'
import { tempDir } from './helpers.ts'
import { fullAccessConfirmed, fullAccessRequest } from '../src/agent/ui_inputs.ts'

type Rec = Record<string, unknown>
const MODEL = 'scripted:a'
let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

/** A host of the fixture's: a HOME whose login and interactive startup files say they ran, put a tool of the HOME's on
 *  PATH and define a function; a TMPDIR of its own; the harness's own token in the environment it was started with. */
function fixtureHost(): { env: Record<string, string>; home: string; tmp: string } {
  const root = tempDir('oasis-host-')
  const home = join(root, 'home')
  const tmp = join(root, 'tmp')
  mkdirSync(join(home, 'bin'), { recursive: true })
  mkdirSync(tmp, { recursive: true })
  writeFileSync(join(home, '.zprofile'), 'export FX_PROFILE=login\nexport PATH="$HOME/bin:$PATH"\n')
  writeFileSync(join(home, '.zshrc'), 'export FX_RC=interactive\nfxfn() { echo fn-from-rc; }\n')
  writeFileSync(join(home, 'bin', 'fxtool'), '#!/bin/sh\necho tool-from-home-bin\n')
  chmodSync(join(home, 'bin', 'fxtool'), 0o755)
  const env = {
    HOME: home, TMPDIR: tmp, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', USER: process.env.USER ?? 'fixture', LOGNAME: process.env.USER ?? 'fixture',
    LANG: 'en_US.UTF-8', SSH_AUTH_SOCK: join(root, 'agent.sock'), KEEP_ME: 'a variable the user exported',
    OASIS_CODE_SESSION_TOKEN: 'the-harness-token', OASIS_CODE_DIRECTOR_TOKEN: 'the-director-token', PWD: '/the/backend/cwd',
  }
  return { env, home, tmp }
}

function playing(steps: ((messages: ModelMessage[]) => ReturnType<typeof modelResponse>)[]) {
  let n = 0
  return (messages: ModelMessage[]) => { const step = steps[n] ?? (() => modelResponse([textPart('done')])); n += 1; return step(messages) }
}

/** The bash results the model saw in its latest request, newest first (a continued conversation carries earlier ones). */
function bashResults(messages: ModelMessage[][]): Rec[] {
  const last = messages.at(-1) ?? []
  return toolReturns(last).filter((p) => p.tool_name === 'bash').map((p) => p.content as Rec).reverse()
}

/** A model that runs `command` with bash, then answers; what it was sent is kept. */
function runsCommand(command: string, seen: ModelMessage[][], extra: Rec = {}) {
  return scriptedModel(playing([
    (m) => { seen.push(m); return modelResponse([toolCallPart('bash', { command, wait_s: 30, ...extra }, 'b1')]) },
    (m) => { seen.push(m); return modelResponse([textPart('ran it')]) },
  ]))
}

async function openApp(host = fixtureHost()) {
  app = await makeApp(null, { probe: false })
  // the fixture's host, never the person's (a build without access modes ignores the field)
  ;(app.state.processes as unknown as { hostEnvironment: () => Record<string, string> }).hostEnvironment = () => ({ ...host.env })
  const c = new Client(app)
  const folder = tempDir('oasis-folder-')
  writeFileSync(join(folder, 'README.md'), 'a folder\n')
  const project = await json(await c.post('/api/projects', { source_path: folder, mode: 'direct' }))
  return { c, host, folder, project }
}

const V5 = { 'x-oasis-tool-surface': 'director.v5' }
const V6 = { 'x-oasis-tool-surface': 'director.v6' }

// ---- a new session: Full access -------------------------------------------------------------------------------

test('a session the app makes runs its commands as the user: the login and interactive shell of the HOME, its TMPDIR, the harness tokens withheld; the record says host, no enforcement', async () => {
  const { c, host, folder, project } = await openApp()
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'full' }))
  expect(session.access_mode).toBe('full')
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('echo "home=$HOME tmp=$TMPDIR prof=$FX_PROFILE rc=$FX_RC keep=$KEEP_ME sock=$SSH_AUTH_SOCK tok=${OASIS_CODE_SESSION_TOKEN:-none} dtok=${OASIS_CODE_DIRECTOR_TOKEN:-none} xid=${OASIS_CODE_EXECUTION_ID:+set}"; fxfn; fxtool; pwd', seen))
  const run = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'run it' }))).id)
  expect(run.status).toBe('done')
  const [result] = bashResults(seen)
  expect(result!.status, JSON.stringify(result)).toBe('succeeded')
  const out = String(result!.stdout)
  expect(out).toContain(`home=${host.home} tmp=${host.tmp} prof=login rc=interactive keep=a variable the user exported sock=${host.env.SSH_AUTH_SOCK} tok=none dtok=none xid=set`)
  expect(out).toContain('fn-from-rc')
  expect(out).toContain('tool-from-home-bin')
  expect(out.trim().split('\n').at(-1)).toBe(folder)                       // the working folder, as for any command
  expect(result!.isolation).toBe('none')
  const execution = repo.listExecutions(app!.state.conn, { run_id: run.id })[0]!
  expect(execution.isolation).toMatchObject({ runtime: 'host', enforcement: 'none', access_mode: 'full', shell: '/bin/zsh' })
  expect(JSON.stringify(execution.isolation)).not.toContain('the-harness-token')
  expect(execution.network).toBe(true)
  // the run's record says where its commands ran: the host, no enforcement — never the sandbox runtime's word
  expect((repo.getRun(app!.state.conn, run.id)!.manifest as Rec).access).toEqual({ mode: 'full', runtime: 'host', enforcement: 'none' })
})

test('a session made in the sandbox, and one from before access modes, keep the sandbox: the command is refused where the sandbox cannot be had, and no startup file runs', async () => {
  const { c, project } = await openApp()
  let hostReads = 0
  const processes = app!.state.processes as unknown as { hostEnvironment: () => Record<string, string> }
  const original = processes.hostEnvironment
  processes.hostEnvironment = () => { hostReads += 1; return original() }
  const made = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'boxed', access_mode: 'sandbox' }))
  expect(made.access_mode).toBe('sandbox')
  // a session row as an older build wrote it (no access named): the sandbox
  const legacy = repo.createSession(app!.state.conn, String(project.id), 'older', MODEL)
  repo.setSessionWorkspace(app!.state.conn, legacy.id, repo.getSession(app!.state.conn, String(made.id))!.workspace_id!)
  expect(repo.getSession(app!.state.conn, legacy.id)!.access_mode).toBe('sandbox')
  for (const sid of [String(made.id), legacy.id]) {
    const seen: ModelMessage[][] = []
    setModel(app!.state, MODEL, runsCommand('echo should-not-run', seen))
    await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: 'run it' }))).id)
    const [result] = bashResults(seen)
    expect(result!.status).toBe('refused')
    expect(result!.isolation).toBe('unavailable')
  }
  expect(hostReads).toBe(0)
})

test('the prompt says where commands run: Full access and its temporary folder for a Full session; nothing new for a session from before; the change said when the person switches', async () => {
  const { c, project } = await openApp()
  const full = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'full' }))
  const sentFull: ModelMessage[][] = []
  setModel(app!.state, MODEL, scriptedModel(playing([(m) => { sentFull.push(m); return modelResponse([textPart('hi')]) }])))
  await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${full.id}/chat`, { text: 'hello' }))).id)
  const firstFull = JSON.stringify(sentFull[0])
  expect(firstFull).toContain("Commands run as the user without a sandbox, in the user's login shell environment (its HOME, PATH and TMPDIR), with the user's files and network. Checkpoints and undo cover the working folder only.")
  expect(firstFull).toMatch(/Temporary folder: [^"]*\. Files here remain available/)
  expect(firstFull).not.toContain('($TMPDIR)')
  // a session from before access modes: told nothing about access, its temporary folder as $TMPDIR as before
  const legacy = repo.createSession(app!.state.conn, String(project.id), 'older', MODEL)
  repo.setSessionWorkspace(app!.state.conn, legacy.id, repo.getSession(app!.state.conn, String(full.id))!.workspace_id!)
  const sentLegacy: ModelMessage[][] = []
  setModel(app!.state, MODEL, scriptedModel(playing([(m) => { sentLegacy.push(m); return modelResponse([textPart('hi')]) }])))
  await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${legacy.id}/chat`, { text: 'hello' }))).id)
  const firstLegacy = JSON.stringify(sentLegacy[0])
  expect(firstLegacy).not.toContain('Commands run')
  expect(firstLegacy).toContain('($TMPDIR)')
  // the person moves the Full session to the sandbox: its next run is told, in the permissions' change
  await json(await c.put(`/api/sessions/${full.id}/access`, { access_mode: 'sandbox' }))
  const sentAfter: ModelMessage[][] = []
  setModel(app!.state, MODEL, scriptedModel(playing([(m) => { sentAfter.push(m); return modelResponse([textPart('hi')]) }])))
  await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${full.id}/chat`, { text: 'again' }))).id)
  const after = JSON.stringify(sentAfter[0].at(-1))
  expect(after).toContain('App note:')
  expect(after).toContain('Commands run in a sandbox')
})

// ---- Plan and Ask -------------------------------------------------------------------------------------------------

test('Plan in a Full session runs no command and never starts the login shell', async () => {
  const { c, project } = await openApp()
  let hostReads = 0
  const processes = app!.state.processes as unknown as { hostEnvironment: () => Record<string, string> }
  const original = processes.hostEnvironment
  processes.hostEnvironment = () => { hostReads += 1; return original() }
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'plan', mode: 'plan' }))
  expect(session.access_mode).toBe('full')
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('echo should-not-run > ran.txt', seen))
  const run = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'run it' }))).id)
  const [result] = bashResults(seen)
  expect(result!.status).toBe('blocked')
  expect(result!.reason).toBe('plan_mode')
  expect(repo.listExecutions(app!.state.conn, { run_id: run.id })).toHaveLength(0)
  expect(hostReads).toBe(0)
})

test('Ask before changes in a Full session: the command is proposed first (nothing of the user\'s shell runs), pinned to Full access, holds the access while undecided, and runs on the host only once the person approves', async () => {
  const { c, project, host } = await openApp()
  let hostReads = 0
  const processes = app!.state.processes as unknown as { hostEnvironment: () => Record<string, string> }
  const original = processes.hostEnvironment
  processes.hostEnvironment = () => { hostReads += 1; return original() }
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'ask', mode: 'approve' }))
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('echo "approved home=$HOME"', seen))
  await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'run it' }))).id)
  const [gated] = bashResults(seen)
  expect(gated!.status).toBe('action_gated')
  expect(hostReads).toBe(0)
  const proposalId = String(gated!.proposal_asset_id)
  const proposal = await json(await c.get(`/api/action-proposals/${proposalId}`))
  expect((proposal.payload as Rec).pinned).toMatchObject({ access_mode: 'full' })
  // undecided, it holds the session's access
  const held = await json(await c.get(`/api/sessions/${session.id}/access`))
  expect(held.switchable).toBe(false)
  expect((held.blocked_by as Rec).approvals).toBe(1)
  const refused = await json<Rec>(await c.put(`/api/sessions/${session.id}/access`, { access_mode: 'sandbox' }), 409)
  expect(refused.code).toBe('access_blocked')
  // a director surface v1–v5 cannot approve a Full access command (it describes commands as sandboxed): nothing runs
  const viaV5 = await c.post(`/api/action-proposals/${proposalId}/decide`, { decision: 'approve' }, { ...{ 'x-oasis-code-token': 'test-token', origin: 'http://localhost' }, ...V5 })
  expect(viaV5.status).toBeGreaterThanOrEqual(400)
  expect(hostReads).toBe(0)
  // the person approves: it runs on the host
  const decided = await json(await c.post(`/api/action-proposals/${proposalId}/decide`, { decision: 'approve' }))
  const result = (decided.result as Rec)
  expect(result.status, JSON.stringify(result)).toBe('succeeded')
  expect(String(result.stdout)).toContain(`approved home=${host.home}`)
  expect(hostReads).toBe(1)
})

// ---- switching ------------------------------------------------------------------------------------------------

test('the access changes only while nothing of the session is outstanding: a command still running holds it (nothing is stopped), and it changes once that command ends', async () => {
  const { c, project } = await openApp()
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'live' }))
  const idle = await json(await c.get(`/api/sessions/${session.id}/access`))
  expect(idle).toMatchObject({ access_mode: 'full', switchable: true, blocked_by: { runs: 0, executions: 0, approvals: 0 } })
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('sleep 30', seen, { wait_s: 1 }))
  const run = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'start it' }))).id)
  const xid = repo.listExecutions(app!.state.conn, { run_id: run.id })[0]!.id
  expect(app!.state.processes.isRunning(xid)).toBe(true)
  const blocked = await json<Rec>(await c.put(`/api/sessions/${session.id}/access`, { access_mode: 'sandbox' }), 409)
  expect(blocked.code).toBe('access_blocked')
  expect((blocked.blocked_by as Rec).executions).toBe(1)
  expect(repo.getSession(app!.state.conn, String(session.id))!.access_mode).toBe('full')
  expect(app!.state.processes.isRunning(xid)).toBe(true)                      // never stopped by the refusal
  // a director or a connector's client never changes it
  expect((await c.put(`/api/sessions/${session.id}/access`, { access_mode: 'sandbox' }, { 'x-oasis-code-token': 'test-token', origin: 'http://localhost', ...V6 })).status).toBe(403)
  app!.state.processes.stop(xid)
  await app!.state.processes.wait(xid, 10)
  const changed = await json(await c.put(`/api/sessions/${session.id}/access`, { access_mode: 'sandbox' }))
  expect(changed).toMatchObject({ access_mode: 'sandbox', switchable: true })
  expect((changed.session as Rec).access_mode).toBe('sandbox')
})

test('a command being started counts from the moment its access is read: the change waits for it', async () => {
  const { c, project } = await openApp()
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'race' }))
  const ws = repo.getSession(app!.state.conn, String(session.id))!.workspace_id!
  let reads = 0
  // started, not awaited: by the time start() first waits, the start is counted as the session's
  const started = app!.state.processes.start({
    command: 'sleep 5', cwd: tempDir(), sandbox: { writable: [], write_deny: [], read_deny: [], read_allow: [], network: true },
    project_id: String(project.id), workspace_id: ws, access: () => { reads += 1; return 'full' },
  } as never)
  expect(reads).toBe(1)
  expect(app!.state.processes.runningForSession(String(session.id)).length).toBe(1)
  const blocked = await json<Rec>(await c.put(`/api/sessions/${session.id}/access`, { access_mode: 'sandbox' }), 409)
  expect(blocked.code).toBe('access_blocked')
  const execution = await started
  expect(execution.isolation).toMatchObject({ runtime: 'host', access_mode: 'full' })
  expect(reads).toBe(1)                                                        // read once, at the start
  app!.state.processes.stop(execution.id)
  await app!.state.processes.wait(execution.id, 10)
  expect(app!.state.processes.runningForSession(String(session.id)).length).toBe(0)
})

test('a connector command that waited for the folder is decided again when it starts: switched to Plan meanwhile, nothing runs and no startup file is read', async () => {
  const { c, project } = await openApp()
  let hostReads = 0
  const processes = app!.state.processes as unknown as { hostEnvironment: () => Record<string, string> }
  const original = processes.hostEnvironment
  processes.hostEnvironment = () => { hostReads += 1; return original() }
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'late' }))
  const ws = repo.getSession(app!.state.conn, String(session.id))!.workspace_id!
  // the folder's adoption held open until the test lets it go
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const workspaces = app!.state.workspaces as unknown as { adopt: (...a: unknown[]) => Promise<unknown> }
  const adopt = workspaces.adopt.bind(workspaces)
  workspaces.adopt = async (...a: unknown[]) => { await gate; return adopt(...a) }
  const pending = c.post(`/api/workspaces/${ws}/commands`, { command: 'echo ran > late.txt', access: 'session', wait_s: 5 }, { 'x-oasis-code-token': 'test-token', origin: 'http://localhost', ...V6 })
  await sleep(50)
  // while it waits, the person puts the session in Plan (no run is active: the mode changes)
  await json(await c.put(`/api/sessions/${session.id}/mode`, { mode: 'plan' }))
  release()
  const response = await pending
  expect(response.status).toBeGreaterThanOrEqual(400)
  expect(await response.text()).toContain('Plan mode')
  expect(hostReads).toBe(0)
  expect(repo.listExecutions(app!.state.conn, { workspace_id: ws })).toHaveLength(0)
})

// ---- director surfaces --------------------------------------------------------------------------------------------

test('director.v1–v5 keep the sandbox for what they start — a session, a command, a run, a relay — while director.v6 and the person get the session\'s access', async () => {
  const { c, project } = await openApp()
  const auth = { 'x-oasis-code-token': 'test-token', origin: 'http://localhost' }
  // sessions
  const viaV5 = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'v5' }, { ...auth, ...V5 }))
  const viaV6 = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'v6' }, { ...auth, ...V6 }))
  expect(viaV5.access_mode).toBe('sandbox')
  expect(viaV6.access_mode).toBe('full')
  const full = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'person' }))
  const ws = repo.getSession(app!.state.conn, String(full.id))!.workspace_id!
  // the connector's command route: v5 (no access asked) in the sandbox — refused here — and v6 asking the session's
  // access on the host. (Three sessions share this folder: v6 names the one it runs under.)
  const v5Command = await c.post(`/api/workspaces/${ws}/commands`, { command: 'echo v5' }, { ...auth, ...V5 })
  expect(v5Command.status).toBe(400)
  expect(await v5Command.text()).toContain('full enforcement')
  const v6Command = await json(await c.post(`/api/workspaces/${ws}/commands`, { command: 'echo v6-on-host', access: 'session', session_id: full.id }, { ...auth, ...V6 }))
  expect(String(v6Command.stdout)).toContain('v6-on-host')
  expect(v6Command.isolation).toBe('none')
  // a v5 director asking for the session's access is still held to the sandbox
  const v5Asks = await c.post(`/api/workspaces/${ws}/commands`, { command: 'echo v5-asks', access: 'session', session_id: full.id }, { ...auth, ...V5 })
  expect(v5Asks.status).toBe(400)
  // runs: a v5 director's run in a Full session is capped; the person's next message is not
  const seenV5: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('echo from-v5-run', seenV5))
  const capped = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${full.id}/chat`, { text: 'from v5' }, { ...auth, ...V5 }))).id)
  expect(bashResults(seenV5)[0]!.status).toBe('refused')
  expect(repo.runAccessCap(app!.state.conn, capped.id)).toBe('sandbox')
  const seenPerson: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('echo from-person', seenPerson))
  const mine = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${full.id}/chat`, { text: 'from me' }))).id)
  expect(bashResults(seenPerson)[0]!.status, JSON.stringify(bashResults(seenPerson)[0])).toBe('succeeded')
  expect(repo.runAccessCap(app!.state.conn, mine.id)).toBeNull()
  // a v5 follow-up of the person's run is capped too
  const seenResume: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('echo resumed', seenResume))
  const resumed = await json<Run>(await c.post(`/api/runs/${mine.id}/resume`, { text: 'go on' }, { ...auth, ...V5 }))
  await waitDone(app!.state, resumed.id)
  expect(bashResults(seenResume)[0]!.status).toBe('refused')
  // a relay a v5 director starts: every turn capped, the later one too (started by the harness after the first ends)
  const turns: ModelMessage[][] = []
  const turn = () => scriptedModel(playing([
    (m) => { turns.push(m); return modelResponse([toolCallPart('bash', { command: 'echo relay-turn', wait_s: 30 }, 'b1')]) },
    (m) => { turns.push(m); return modelResponse([textPart('turn done')]) },
  ]))
  setModel(app!.state, 'scripted:a', turn())
  setModel(app!.state, 'scripted:b', turn())
  const relayRun = await json<Run>(await c.post(`/api/sessions/${full.id}/chat`, { text: 'relay', agents: [{ model: 'scripted:a' }, { model: 'scripted:b' }] }, { ...auth, ...V5 }))
  await waitDone(app!.state, relayRun.id)
  for (let i = 0; i < 100 && repo.listRelays(app!.state.conn, String(full.id)).some((r) => r.status === 'running'); i += 1) await sleep(50)
  const relay = repo.listRelays(app!.state.conn, String(full.id))[0]!
  expect(repo.relayAccessCap(app!.state.conn, relay.id)).toBe('sandbox')
  const relayRuns = repo.listRuns(app!.state.conn, String(full.id)).filter((r) => r.relay_id === relay.id)
  expect(relayRuns.length).toBe(2)
  for (const r of relayRuns) {
    expect(repo.runAccessCap(app!.state.conn, r.id)).toBe('sandbox')
    expect(repo.listExecutions(app!.state.conn, { run_id: r.id }).filter((x) => (x.isolation as Rec).runtime === 'host')).toHaveLength(0)
  }
})

test('an interaction a director.v5 starts holds the sandbox for every node (the later ones started by the harness); the person\'s own runs on the host', async () => {
  const { c, project } = await openApp()
  const auth = { 'x-oasis-code-token': 'test-token', origin: 'http://localhost' }
  const full = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'group' }))
  const node = () => scriptedModel(playing([
    () => modelResponse([toolCallPart('bash', { command: 'echo node', wait_s: 30 }, 'b1')]),
    () => modelResponse([textPart('node done')]),
  ]))
  setModel(app!.state, 'scripted:a', node())
  setModel(app!.state, 'scripted:b', node())
  const settle = async (id: string) => { for (let i = 0; i < 200 && ['planning', 'running'].includes(String(repo.getInteraction(app!.state.conn, id)?.status)); i += 1) await sleep(50) }
  const body = { text: 'two alone', participants: [{ model: 'scripted:a' }, { model: 'scripted:b' }], plan: { template: 'independent' }, concurrency: 1 }
  const viaV5 = await json<Rec>(await c.post(`/api/sessions/${full.id}/interactions`, body, { ...auth, ...V5 }))
  await settle(String(viaV5.id))
  expect(repo.interactionAccessCap(app!.state.conn, String(viaV5.id))).toBe('sandbox')
  const capped = repo.listRunsOfInteraction(app!.state.conn, String(viaV5.id))
  expect(capped.length).toBe(2)
  for (const r of capped) {
    expect(repo.runAccessCap(app!.state.conn, r.id)).toBe('sandbox')
    expect(repo.listExecutions(app!.state.conn, { run_id: r.id }).some((x) => (x.isolation as Rec).runtime === 'host')).toBe(false)
  }
  setModel(app!.state, 'scripted:a', node())
  setModel(app!.state, 'scripted:b', node())
  const mine = await json<Rec>(await c.post(`/api/sessions/${full.id}/interactions`, body))
  await settle(String(mine.id))
  expect(repo.interactionAccessCap(app!.state.conn, String(mine.id))).toBeNull()
  const runs = repo.listRunsOfInteraction(app!.state.conn, String(mine.id))
  expect(runs.length).toBe(2)
  for (const r of runs) expect(repo.listExecutions(app!.state.conn, { run_id: r.id }).map((x) => (x.isolation as Rec).runtime)).toEqual(['host'])
})

// changed 2026-10-16 (execution limits): the network off no longer moves a Full session's command into the whole
// sandbox (before: the sandbox, refused here as unavailable). It stays on the host with only the network denied by
// the OS. Where the runtime cannot hold that (this app has no probe), it is refused and says so, with no fallback.
test('the network turned off keeps a Full session\'s commands on the host with only the network denied — refused, and said, where the OS cannot hold it', async () => {
  const { c, project } = await openApp()
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'offline' }))
  await json(await c.put(`/api/sessions/${session.id}/grants`, { network: false }))
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('echo offline', seen))
  await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'run it' }))).id)
  const [result] = bashResults(seen)
  expect(result!.status).toBe('refused')
  expect(result!.isolation).toBe('unavailable')
  expect(result!.code).toBe('restriction_unavailable')
  expect(result!.effective_access).toBe('full')
  expect((result!.access_reasons as Rec[]).map((r) => r.code)).toEqual(['network_off', 'restriction_unavailable'])
  // the run was told where its commands run: Full access, not a sandbox
  expect(JSON.stringify(seen[0])).toContain('Commands run as the user without a sandbox')
})

test('a v27 database upgrades to v28: every session runs with full access from then on, once (a session set to the sandbox after stays so), the caps table is made, the copy before the upgrade is kept, and it equals a fresh database', async () => {
  const { connect } = await import('../src/db/database.ts')
  const { SCHEMA_VERSION } = await import('@oasis-code/contract')
  const { existsSync } = await import('node:fs')
  const structure = (conn: ReturnType<typeof connect>) => Object.fromEntries(conn.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => [r.name, conn.all(`PRAGMA table_info(${String(r.name)})`).map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk])]))
  const base = tempDir('oasis-v27-')
  const path = join(base, 'old', 'index.db')
  const made = connect(path)                                                    // a fresh database …
  made.exec('DROP TRIGGER sessions_clear_pin')
  made.exec('DROP INDEX sessions_by_pin_order')
  made.exec('ALTER TABLE sessions DROP COLUMN pin_order')                       // v36's, absent at v27
  made.exec('DROP TABLE session_roots')                                         // v29's, absent at v27
  made.exec('ALTER TABLE sessions DROP COLUMN task_root_id')
  made.exec('DROP TABLE access_caps')
  made.exec('ALTER TABLE sessions DROP COLUMN access_mode')
  made.exec('DROP INDEX IF EXISTS runs_read; PRAGMA user_version = 27')                                         // … as v27 had it
  made.run("INSERT INTO projects (id, name, base_repo_path, created_at, updated_at) VALUES ('p_1','legacy','/x','t','t')")
  made.run("INSERT INTO sessions (id, project_id, title, model, grants_json, created_at, updated_at, last_activity_at) VALUES ('s_old','p_1','old','m','{\"run_commands\":true}','t','t','t')")
  made.close()
  expect(SCHEMA_VERSION).toBe(37)                                               // v28's step, then v29's (the sessions' task and roots); v30: SSH targets; v31: SSH connect intent; v32: CNY costs, v33 read-path indexes, v34 live links, v35 their protocol and task
  const migrated = connect(path)
  const fresh = connect(join(base, 'fresh', 'index.db'))
  try {
    expect(migrated.get('PRAGMA user_version')!.user_version).toBe(37)
    expect(structure(migrated)).toEqual(structure(fresh))
    expect(repo.getSession(migrated, 's_old')!.access_mode).toBe('full')
    expect(repo.getSession(migrated, 's_old')!.grants.run_commands).toBe(true)
    expect(existsSync(`${path}.v27.bak`)).toBe(true)
    // a session made after the upgrade by a caller that names no access: the sandbox (least access, as before)
    expect(repo.createSession(migrated, 'p_1', 'internal', 'm').access_mode).toBe('sandbox')
  } finally { migrated.close(); fresh.close() }
  // the person sets it to the sandbox; the upgrade, were it to run again, leaves it so
  const again = connect(path)
  try {
    repo.setSessionAccess(again, 's_old', 'sandbox')
    again.exec('DROP INDEX IF EXISTS runs_read; PRAGMA user_version = 27')
  } finally { again.close() }
  const rerun = connect(path)
  try { expect(repo.getSession(rerun, 's_old')!.access_mode).toBe('sandbox') } finally { rerun.close() }
})

test('two sessions in one folder edited in place: a director.v6 command never borrows the other session\'s access or mode — ambiguous unless named, refused for the Plan one, on the host for the Full one', async () => {
  const { c, project } = await openApp()
  const auth = { 'x-oasis-code-token': 'test-token', origin: 'http://localhost' }
  const planned = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'plan, sandbox', mode: 'plan', access_mode: 'sandbox' }))
  const full = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'auto, full' }))
  const ws = repo.getSession(app!.state.conn, String(planned.id))!.workspace_id!
  expect(repo.getSession(app!.state.conn, String(full.id))!.workspace_id).toBe(ws)        // one workspace for the folder
  expect(repo.getWorkspace(app!.state.conn, ws)!.session_id).toBe(String(planned.id))     // owned by the first
  const ambiguous = await json<Rec>(await c.post(`/api/workspaces/${ws}/commands`, { command: 'echo which', access: 'session' }, { ...auth, ...V6 }), 409)
  expect(ambiguous.code).toBe('session_ambiguous')
  const plan = await c.post(`/api/workspaces/${ws}/commands`, { command: 'echo plan', access: 'session', session_id: planned.id }, { ...auth, ...V6 })
  expect(plan.status).toBe(409)
  const stranger = await json<Rec>(await c.post(`/api/workspaces/${ws}/commands`, { command: 'echo who', access: 'session', session_id: 's_nope' }, { ...auth, ...V6 }), 403)
  expect(stranger.code).toBe('session_not_in_workspace')
  const host = await json(await c.post(`/api/workspaces/${ws}/commands`, { command: 'echo full-session', access: 'session', session_id: full.id }, { ...auth, ...V6 }))
  expect(String(host.stdout)).toContain('full-session')
  // the route as v1–v5 use it (no access asked) is unchanged: the folder's own session decides — Plan: none
  expect((await c.post(`/api/workspaces/${ws}/commands`, { command: 'echo v5' }, { ...auth, ...V5 })).status).toBe(409)
})

// ---- what keeps the sandbox inside a Full session -----------------------------------------------------------------

// changed 2026-10-16 (execution limits): an order's read-only bound or network off no longer moves the command into
// the whole sandbox. The command stays on the host with that bound held by the OS (refused here, where this app's
// runtime cannot hold it, and said so).
test('inside a Full session a work order with a read-only bound or the network off keeps Full access with the bound held by the OS (refused, and said, where it cannot be), and a plain separate task runs on the host', async () => {
  const { c, project } = await openApp()
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'orders' }))
  const results: Rec[] = []
  const child = () => scriptedModel(playing([
    () => modelResponse([toolCallPart('bash', { command: 'echo child', wait_s: 30 }, 'b1')]),
    (m) => { results.push(bashResults([m])[0]!); return modelResponse([textPart('child done')]) },
  ]))
  for (const order of [{ prompt: 'read only', model: MODEL, read_only: true }, { prompt: 'offline', model: MODEL, execution: { network: false } }, { prompt: 'plain', model: MODEL }]) {
    setModel(app!.state, MODEL, child())
    const run = await json<Run>(await c.post(`/api/sessions/${session.id}/work-orders`, { work_order: order }))
    await waitDone(app!.state, run.id)
  }
  expect(results.map((r) => r.status)).toEqual(['refused', 'refused', 'succeeded'])
  expect(results.map((r) => r.code ?? null)).toEqual(['restriction_unavailable', 'restriction_unavailable', null])
  expect(results.map((r) => r.effective_access)).toEqual(['full', 'full', 'full'])
  expect(results.map((r) => (r.access_reasons as Rec[]).map((x) => x.code))).toEqual([['order_bounds', 'restriction_unavailable'], ['network_off', 'restriction_unavailable'], []])
})

/** A model that runs each command with bash in turn, then answers; what it was sent is kept. */
function runsCommands(commands: string[], seen: ModelMessage[][]) {
  return scriptedModel(playing([
    ...commands.map((command, i) => (m: ModelMessage[]) => { seen.push(m); return modelResponse([toolCallPart('bash', { command, wait_s: 30 }, `b${i + 1}`)]) }),
    (m: ModelMessage[]) => { seen.push(m); return modelResponse([textPart('ran them')]) },
  ]))
}

test("what a startup file prints or asks never reaches a command: the login shell's snapshot is taken once, then each command runs in a plain shell from it, with the functions and without the aliases (ls is ls)", async () => {
  const host = fixtureHost()
  // an update prompt as oh-my-zsh prints it, on both streams, and a read of the answer; each reading of the file counted
  writeFileSync(join(host.home, '.zshrc'), [
    'export FX_RC=interactive', 'fxfn() { echo fn-from-rc; }', "alias fxal='echo alias-from-rc'", "alias ls='echo ls-was-replaced'",
    'echo x >> "$HOME/rc-reads"', "echo '[oh-my-zsh] Would you like to update? [Y/n] '", "echo 'greeting on stderr' >&2", 'read -r answer', '',
  ].join('\n'))
  const { c, project } = await openApp(host)
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'quiet' }))
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommands(['echo "rc=$FX_RC prof=$FX_PROFILE"; fxfn; fxtool; type fxal >/dev/null 2>&1 || echo no-alias; ls -d /', 'echo second'], seen))
  const run = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'run them' }))).id)
  expect(run.status).toBe('done')
  const [second, first] = bashResults(seen)
  expect(first!.status, JSON.stringify(first)).toBe('succeeded')
  expect(String(first!.stdout).trim().split('\n')).toEqual(['rc=interactive prof=login', 'fn-from-rc', 'tool-from-home-bin', 'no-alias', '/'])
  expect(String(first!.stderr ?? '')).toBe('')
  expect(String(second!.stdout).trim()).toBe('second')
  expect(String(second!.stderr ?? '')).toBe('')
  // the startup files ran once, for the snapshot; both commands started from it
  expect(readFileSync(join(host.home, 'rc-reads'), 'utf8')).toBe('x\n')
  expect(repo.listExecutions(app!.state.conn, { run_id: run.id }).map((e) => (e.isolation as Rec).shell_start)).toEqual(['snapshot', 'snapshot'])
})

test('a snapshot that cannot be taken leaves the command to run in the login and interactive shell itself, and its record says so', async () => {
  const host = fixtureHost()
  // the startup file fails only while a snapshot is being written: the command's own login shell reads it fine
  writeFileSync(join(host.home, '.zshrc'), 'export FX_RC=interactive\nfxfn() { echo fn-from-rc; }\n[ -n "$OASIS_CODE_SNAPSHOT_ENV" ] && exit 7\n')
  const { c, project } = await openApp(host)
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'no snapshot' }))
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('echo "rc=$FX_RC"; fxfn', seen))
  const run = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'run it' }))).id)
  const [result] = bashResults(seen)
  expect(result!.status, JSON.stringify(result)).toBe('succeeded')
  expect(String(result!.stdout).trim().split('\n')).toEqual(['rc=interactive', 'fn-from-rc'])
  expect((repo.listExecutions(app!.state.conn, { run_id: run.id })[0]!.isolation as Rec).shell_start).toBe('login')
})

test('a timeout stops the user\'s shell and what it started', async () => {
  const { c, project } = await openApp()
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'timeout' }))
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('sleep 60 & echo "child=$!"; wait', seen, { timeout_s: 2, wait_s: 10 }))
  await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'hang' }))).id)
  const [result] = bashResults(seen)
  expect(result!.timed_out).toBe(true)
  const child = Number(/child=(\d+)/.exec(String(result!.stdout))?.[1])
  expect(child).toBeGreaterThan(1)
  let alive = true
  for (let i = 0; i < 40 && alive; i += 1) { try { process.kill(child, 0); await sleep(50) } catch { alive = false } }
  expect(alive).toBe(false)
})

test('a login shell this build cannot run as one refuses the command: no other environment stands in', async () => {
  const host = fixtureHost()
  const { c, project } = await openApp({ ...host, env: { ...host.env, SHELL: '/bin/tcsh' } })
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'odd shell' }))
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('echo should-not-run', seen))
  const run = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'run it' }))).id)
  const [result] = bashResults(seen)
  expect(result!.status).toBe('refused')
  expect(String(result!.reason)).toContain('/bin/tcsh')
  expect(repo.listExecutions(app!.state.conn, { run_id: run.id })).toHaveLength(0)
})

// ---- the first Full access command on a machine not confirmed for it asks, in the conversation -------------------

/** The harness's question a run waits on, once it is asked. */
async function askOf(runId: string): Promise<UiInputRecord> {
  for (let i = 0; i < 300; i += 1) {
    const row = app!.state.conn.get("SELECT id FROM ui_inputs WHERE run_id = ? AND status = 'pending'", [runId])
    if (row !== null) return repo.getUiInput(app!.state.conn, String(row.id))!
    await sleep(10)
  }
  throw new Error(`no question asked in ${runId}`)
}

async function unconfirmed() {
  const opened = await openApp()
  app!.state.config.full_access_confirmed = false
  return opened
}

test('on a machine not confirmed for Full access, the first command waits in the conversation: yes runs it as the user and confirms the machine, and the next command asks nothing', async () => {
  const { c, project } = await unconfirmed()
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'full' }))
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('echo ran-as-user', seen))
  const started = await json<Run>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'run it' }))
  const ask = await askOf(started.id)
  expect((ask.request as Rec).harness).toBe('full_access')
  expect(repo.listExecutions(app!.state.conn, { run_id: started.id })).toEqual([])          // nothing ran yet
  expect(repo.getRun(app!.state.conn, started.id)!.status).toBe('running')
  await json(await c.post(`/api/sessions/${session.id}/ui-inputs/${ask.id}/submit`, { values: { access: 'full' } }))
  const run = await waitDone(app!.state, started.id)
  expect(run.status).toBe('done')
  const [result] = bashResults(seen)
  expect(result!.status, JSON.stringify(result)).toBe('succeeded')
  expect(String(result!.stdout)).toContain('ran-as-user')
  expect(repo.listExecutions(app!.state.conn, { run_id: run.id })[0]!.isolation).toMatchObject({ runtime: 'host', access_mode: 'full' })
  expect(fullAccessConfirmed(app!.state.conn, false)).toBe(true)
  // confirmed: the next command of any session runs with no question
  const other = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'again' }))
  const again: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('echo no-question', again))
  const second = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${other.id}/chat`, { text: 'run it' }))).id)
  expect(String(bashResults(again)[0]!.stdout)).toContain('no-question')
  expect(app!.state.conn.get('SELECT COUNT(*) AS n FROM ui_inputs WHERE run_id = ?', [second.id])!.n).toBe(0)
})

test('answered Sandbox, the session goes to the sandbox and the command runs there (refused here, with no sandbox in this app); the machine stays unconfirmed', async () => {
  const { c, project } = await unconfirmed()
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'full' }))
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('echo should-not-run-on-host', seen))
  const started = await json<Run>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'run it' }))
  const ask = await askOf(started.id)
  await json(await c.post(`/api/sessions/${session.id}/ui-inputs/${ask.id}/submit`, { values: { access: 'sandbox' } }))
  await waitDone(app!.state, started.id)
  expect(repo.getSession(app!.state.conn, String(session.id))!.access_mode).toBe('sandbox')
  const [result] = bashResults(seen)
  expect(result!.status).toBe('refused')
  expect(JSON.stringify(result)).not.toContain('should-not-run-on-host')
  // the newest change of the session's access: the person's answer to this question
  expect(repo.listGovernance(app!.state.conn, String(session.id), 'session_access')[0]!.params).toMatchObject({ access_mode: 'sandbox', asked: ask.id })
  expect(fullAccessConfirmed(app!.state.conn, false)).toBe(false)
})

test('stopped while it waits for the answer: nothing runs, and the question is closed', async () => {
  const { c, project } = await unconfirmed()
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'full' }))
  setModel(app!.state, MODEL, runsCommand('echo never', []))
  const started = await json<Run>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'run it' }))
  const ask = await askOf(started.id)
  expect(app!.state.runs.cancel(started.id)).toBe(true)
  const run = await waitDone(app!.state, started.id)
  expect(run.status).toBe('cancelled')
  expect(repo.getUiInput(app!.state.conn, ask.id)!.status).toBe('closed')
  expect(repo.listExecutions(app!.state.conn, { run_id: started.id })).toEqual([])
})

test('one yes answers the same question waiting in another session: the machine is confirmed once', async () => {
  const { c, project } = await unconfirmed()
  // two folders: a folder edited in place takes one writer at a time, and the run that waits holds its folder
  const second = tempDir('oasis-folder-')
  const projectB = await json(await c.post('/api/projects', { source_path: second, mode: 'direct' }))
  const a = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'a' }))
  const b = await json(await c.post(`/api/projects/${projectB.id}/sessions`, { title: 'b' }))
  setModel(app!.state, MODEL, scriptedModel((m: ModelMessage[]) => toolReturns(m).some((p) => p.tool_name === 'bash') ? modelResponse([textPart('ran it')]) : modelResponse([toolCallPart('bash', { command: 'echo both', wait_s: 30 }, 'b1')])))
  const ra = await json<Run>(await c.post(`/api/sessions/${a.id}/chat`, { text: 'run it' }))
  const rb = await json<Run>(await c.post(`/api/sessions/${b.id}/chat`, { text: 'run it' }))
  const askA = await askOf(ra.id)
  const askB = await askOf(rb.id)
  await json(await c.post(`/api/sessions/${a.id}/ui-inputs/${askA.id}/submit`, { values: { access: 'full' } }))
  expect((await waitDone(app!.state, ra.id)).status).toBe('done')
  expect((await waitDone(app!.state, rb.id)).status).toBe('done')
  expect(repo.getUiInput(app!.state.conn, askB.id)!.status).toBe('submitted')
  for (const id of [ra.id, rb.id]) expect(repo.listExecutions(app!.state.conn, { run_id: id })[0]!.isolation).toMatchObject({ access_mode: 'full' })
})

test("an agent's own form cannot pass for the harness's question: request_input's arguments carry no `harness`", () => {
  const form = fullAccessRequest()
  delete form.harness
  expect(parseUiInputRequest(form).ok).toBe(true)
  expect(parseUiInputRequest({ ...form, harness: 'full_access' }).ok).toBe(false)
})

test('Ask before changes on a machine not confirmed for Full access: the Full access question comes before any approval card, and the card is made only after the yes, pinned to Full', async () => {
  const { c, project, host } = await unconfirmed()
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'ask', mode: 'approve' }))
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('echo "approved home=$HOME"', seen))
  const started = await json<Run>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'run it' }))
  const ask = await askOf(started.id)
  expect((ask.request as Rec).harness).toBe('full_access')
  expect((await json(await c.get(`/api/sessions/${session.id}/action-proposals`))).proposals).toEqual([])   // no card before the yes
  await json(await c.post(`/api/sessions/${session.id}/ui-inputs/${ask.id}/submit`, { values: { access: 'full' } }))
  await waitDone(app!.state, started.id)
  const [gated] = bashResults(seen)
  expect(gated!.status).toBe('action_gated')
  const proposalId = String(gated!.proposal_asset_id)
  expect(((await json(await c.get(`/api/action-proposals/${proposalId}`))).payload as Rec).pinned).toMatchObject({ access_mode: 'full' })
  const decided = await json(await c.post(`/api/action-proposals/${proposalId}/decide`, { decision: 'approve' }))
  expect(String((decided.result as Rec).stdout)).toContain(`approved home=${host.home}`)
})

test('an approval card pinned to Full access on a machine that has not confirmed it runs nothing when approved, and says why', async () => {
  const { c, project } = await openApp()
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'ask', mode: 'approve' }))
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('echo should-not-run', seen))
  const run = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'run it' }))).id)
  const proposalId = String(bashResults(seen)[0]!.proposal_asset_id)
  // a card made while the machine counted as confirmed (by the operator's setting), approved after that setting is gone
  app!.state.config.full_access_confirmed = false
  const decided = await json(await c.post(`/api/action-proposals/${proposalId}/decide`, { decision: 'approve' }))
  const result = decided.result as Rec
  expect(result.status, JSON.stringify(result)).toBe('refused')
  expect(String(result.reason)).toContain('Full access is not confirmed on this computer')
  expect(repo.listExecutions(app!.state.conn, { run_id: run.id })).toEqual([])
})
