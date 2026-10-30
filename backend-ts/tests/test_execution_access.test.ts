/** Where an agent's command runs and why, said in its result (2026-10-16). Each result carries requested_access,
 *  effective_access and access_reasons (a code, what holds, and how to proceed), plus restrictions (what the command
 *  was held to). A Full session's restriction stays on the host with only that restriction: a network turned off, a
 *  work order's read-only bound, an approval's pinned network. A cap (director v1–v5) still means the sandbox, and the
 *  result says so.
 *
 *  Every host is a fixture's own HOME and startup files. RecordingRuntime is NOT an OS sandbox. It records the
 *  restrictions and runs the command as it is (routing, environment and reports, never enforcement; the OS test is
 *  tests/test_host_profile.test.ts). This file imports only what the build before it had, so against that build it
 *  fails on assertions. */

import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Run } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import type { HostRestrictions, Sandbox } from '../src/execution/isolation.ts'
import { modelResponse, textPart, toolCallPart, toolReturns, type ModelMessage } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { FAKE_FULL, PassthroughRuntime, scriptedModel, setModel, waitDone } from './harness.ts'
import { tempDir } from './helpers.ts'

type Rec = Record<string, unknown>
const MODEL = 'scripted:a'
const V5 = { 'x-oasis-tool-surface': 'director.v5', 'x-oasis-code-token': 'test-token', origin: 'http://localhost' }
let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

/** Not an OS sandbox: records the restrictions it is handed and runs the command as it is. */
class RecordingRuntime extends PassthroughRuntime {
  readonly restrictions: HostRestrictions[] = []
  readonly boxes: Sandbox[] = []
  override command(argv: string[], box: Sandbox, profile: string): string[] { this.boxes.push(box); return super.command(argv, box, profile) }
  hostCommand(argv: string[], restrictions: HostRestrictions, profilePath: string): string[] {
    writeFileSync(profilePath, ';; recorded, not applied\n')
    this.restrictions.push(restrictions)
    return argv
  }
}

function fixtureHost(): { env: Record<string, string>; home: string } {
  const root = tempDir('oasis-host-')
  const home = join(root, 'home')
  mkdirSync(join(home, 'bin'), { recursive: true })
  mkdirSync(join(root, 'tmp'), { recursive: true })
  writeFileSync(join(home, '.zshrc'), 'export FX_RC=interactive\n')
  writeFileSync(join(home, 'bin', 'fxtool'), '#!/bin/sh\necho tool-from-home-bin\n')
  chmodSync(join(home, 'bin', 'fxtool'), 0o755)
  const env = {
    HOME: home, ZDOTDIR: home, TMPDIR: join(root, 'tmp'), SHELL: '/bin/zsh', PATH: `${join(home, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`, USER: process.env.USER ?? 'fixture',
    LANG: 'en_US.UTF-8', SSH_AUTH_SOCK: join(root, 'agent.sock'), OASIS_CODE_SESSION_TOKEN: 'the-harness-token',
  }
  return { env, home }
}

async function openApp(runtime: PassthroughRuntime | null = null) {
  app = await makeApp(null, runtime ? { runtime, isolation: { ...FAKE_FULL, runtime: runtime.name } } : { probe: false })
  const host = fixtureHost()
  ;(app.state.processes as unknown as { hostEnvironment: () => Record<string, string> }).hostEnvironment = () => ({ ...host.env })
  const c = new Client(app)
  const folder = tempDir('oasis-folder-')
  writeFileSync(join(folder, 'README.md'), 'a folder\n')
  const project = await json(await c.post('/api/projects', { source_path: folder, mode: 'direct' }))
  return { c, host, folder, project }
}

function playing(steps: ((messages: ModelMessage[]) => ReturnType<typeof modelResponse>)[]) {
  let n = 0
  return (messages: ModelMessage[]) => { const step = steps[n] ?? (() => modelResponse([textPart('done')])); n += 1; return step(messages) }
}

function runsCommand(command: string, seen: ModelMessage[][], extra: Rec = {}) {
  return scriptedModel(playing([
    (m) => { seen.push(m); return modelResponse([toolCallPart('bash', { command, wait_s: 30, ...extra }, 'b1')]) },
    (m) => { seen.push(m); return modelResponse([textPart('ran it')]) },
  ]))
}

function lastBash(seen: ModelMessage[][]): Rec {
  return toolReturns(seen.at(-1) ?? []).filter((p) => p.tool_name === 'bash').map((p) => p.content as Rec).at(-1)!
}

const codes = (r: Rec) => ((r.access_reasons ?? []) as Rec[]).map((x) => x.code)

test('a Full session\'s command says where it ran and what held it: requested and effective Full, no reason, the host\'s environment, no deadline, no cap, no limit', async () => {
  const { c, project, host } = await openApp()
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'full' }))
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('echo "home=$HOME"; fxtool', seen))
  const run = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'run it' }))).id)
  const result = lastBash(seen)
  expect(result.status, JSON.stringify(result)).toBe('succeeded')
  expect(String(result.stdout)).toContain(`home=${host.home}`)
  expect([result.requested_access, result.effective_access, codes(result)]).toEqual(['full', 'full', []])
  expect(result.restrictions).toEqual({
    environment: 'host', enforced_by: 'none', network: 'allowed', filesystem: 'none', write_denied: [], order_bounds: null,
    resource_limits: null, timeout_s: null, timeout_source: null, output_cap_bytes: null,
  })
  expect(result.timeout_s).toBeNull()
  // the run's events say it too
  const started = repo.listEvents(app!.state.conn, run.id).find((e) => e.event === 'execution_started')
  expect(started?.data).toMatchObject({ effective_access: 'full', requested_access: 'full', timeout_s: null })
})

test('a director v1–v5 run in a Full session: the sandbox, and the result says why and how to proceed', async () => {
  const { c, project } = await openApp()
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'capped' }))
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('echo capped', seen))
  await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'from v5' }, V5))).id)
  const result = lastBash(seen)
  expect(result.status).toBe('refused')                                          // the sandbox is unavailable in this app
  expect([result.requested_access, result.effective_access]).toEqual(['full', 'sandbox'])
  expect(codes(result)).toEqual(['run_cap', 'sandbox_unavailable'])
  for (const r of result.access_reasons as Rec[]) expect(String(r.next_step).length).toBeGreaterThan(10)
})

test('the network off in a Full session keeps the command on the host — the user\'s HOME, PATH and startup files — with only the network denied, and the prompt says Full access', async () => {
  const runtime = new RecordingRuntime()
  const { c, project, host } = await openApp(runtime)
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'offline' }))
  await json(await c.put(`/api/sessions/${session.id}/grants`, { network: false }))
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('echo "home=$HOME rc=$FX_RC"; fxtool', seen))
  await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'run it' }))).id)
  const result = lastBash(seen)
  expect(result.status, JSON.stringify(result)).toBe('succeeded')
  expect(String(result.stdout)).toContain(`home=${host.home} rc=interactive`)
  expect(String(result.stdout)).toContain('tool-from-home-bin')
  expect(runtime.boxes).toHaveLength(0)
  expect(runtime.restrictions).toEqual([{ network: false, write_deny: [], bounds: null }])
  expect([result.effective_access, codes(result), result.network]).toEqual(['full', ['network_off'], false])
  expect(result.restrictions).toMatchObject({ environment: 'host', network: 'denied', resource_limits: null })
  const prompt = JSON.stringify(seen[0])
  expect(prompt).toContain('Commands run as the user without a sandbox')
  expect(prompt).not.toContain('Commands run in a sandbox')
})

test('a work order\'s read-only bound in a Full session: on the host, the bound held there, said as order_bounds', async () => {
  const runtime = new RecordingRuntime()
  const { c, project, host } = await openApp(runtime)
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'orders' }))
  const results: Rec[] = []
  setModel(app!.state, MODEL, scriptedModel(playing([
    () => modelResponse([toolCallPart('bash', { command: 'echo "home=$HOME"', wait_s: 30 }, 'b1')]),
    (m) => { results.push(lastBash([m])); return modelResponse([textPart('child done')]) },
  ])))
  const run = await json<Run>(await c.post(`/api/sessions/${session.id}/work-orders`, { work_order: { prompt: 'read only', model: MODEL, read_only: true } }))
  await waitDone(app!.state, run.id)
  const [result] = results
  expect(result!.status, JSON.stringify(result)).toBe('succeeded')
  expect(String(result!.stdout)).toContain(`home=${host.home}`)
  expect(runtime.restrictions[0]?.bounds?.read_only).toBe(true)
  expect([result!.effective_access, codes(result!)]).toEqual(['full', ['order_bounds']])
  expect(result!.restrictions).toMatchObject({ environment: 'host', filesystem: 'restricted', order_bounds: { read_only: true, read: null, write: null } })
})

test('Ask in a Full session with the network off: the proposal pins Full access and no network apart; approved, it runs on the host with the network denied', async () => {
  const runtime = new RecordingRuntime()
  const { c, project, host } = await openApp(runtime)
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'ask', mode: 'approve' }))
  await json(await c.put(`/api/sessions/${session.id}/grants`, { network: false }))
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, runsCommand('echo "approved home=$HOME"', seen))
  await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'run it' }))).id)
  const gated = lastBash(seen)
  expect(gated.status).toBe('action_gated')
  const proposal = await json(await c.get(`/api/action-proposals/${String(gated.proposal_asset_id)}`))
  expect((proposal.payload as Rec).pinned).toMatchObject({ access_mode: 'full', network: false })
  const decided = await json(await c.post(`/api/action-proposals/${String(gated.proposal_asset_id)}/decide`, { decision: 'approve' }))
  const result = decided.result as Rec
  expect(result.status, JSON.stringify(result)).toBe('succeeded')
  expect(String(result.stdout)).toContain(`approved home=${host.home}`)
  expect([result.effective_access, codes(result)]).toEqual(['full', ['network_off']])
  expect(runtime.restrictions.at(-1)).toMatchObject({ network: false })
})
