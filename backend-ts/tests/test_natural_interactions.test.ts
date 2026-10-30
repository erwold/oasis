/** Natural-language routing, real repeated-model participants, original envelopes and live-source isolation.
 * All data here is synthetic in the suite's temp directory. No cloud, user credentials or research folder. */
import { afterEach, expect, test } from 'bun:test'
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DirectorSayBodySchema, type DirectorTurn, type InteractionDetail } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import * as dstore from '../src/director/store.ts'
import { expandTemplate } from '../src/agent/interactions.ts'
import { PathPolicy } from '../src/workspace/paths.ts'
import { workspaceAttached } from '../src/workspace/service.ts'
import { sandboxForWorkspace } from '../src/workspace/sandbox.ts'
import { modelSettings } from '../src/agent/runner.ts'
import { ModelConfig } from '../src/config.ts'
import { thinkingFields } from '../src/llm/providers/anthropic.ts'
import { lastToolReturn, loadJson, modelResponse, textPart, toolCallPart, userTexts, type ModelMessage } from '../src/llm/messages.ts'
import { connect } from '../src/db/database.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { legacyV1Director } from './director_surface_fixtures.ts'
import { FAKE_FULL, scriptedModel, setModel, sleep, steps, waitDone } from './harness.ts'
import { tempDir } from './helpers.ts'
import { SeatbeltRuntime, buildRuntime, orderRules, type Sandbox } from '../src/execution/isolation.ts'
import { ProcessManager } from '../src/execution/processes.ts'
import { executeCommand } from '../src/agent/tools/commands.ts'
import { lockSpec } from '../src/policy/locks.ts'
import { parseWorkOrder } from '../src/agent/work_orders.ts'
import { runChecks } from '../src/verify/checks.ts'
import { naturalFixtureRoutes, NATURAL_DIRECTOR, NATURAL_FABLE, GAN_BATTLE_SENTENCE, INDEPENDENT_SENTENCE, SOURCE_NAME } from '../scripts/natural_interaction_fixture.ts'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })
const DIRECTOR = 'scripted:b'
const AGENT = 'scripted:a'
const original = '  让几个独立 agent 根据原始实验数据和数学理论 battle 出稳定训练的方法。\n不要修改来源。  '
async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean): Promise<T> {
  const end = Date.now() + 25000
  for (;;) { const v = await read(); if (ok(v)) return v; if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v).slice(0, 1000)}`); await sleep(20) }
}
async function open(mode: 'direct' | 'attached' = 'direct', name = 'research_source') {
  app = await makeApp()
  const c = new Client(app)
  const root = join(tempDir(), name)
  mkdirSync(root)
  writeFileSync(join(root, 'experiment.jsonl'), '{"seed":7,"loss":0.125}\n')
  setModel(app.state, DIRECTOR, scriptedModel(() => modelResponse([textPart('router only')]), 'director'))
  const p = await json(await c.post('/api/projects', { source_path: root, mode }))
  const s = await json(await c.post(`/api/projects/${p.id}/sessions`, { model: DIRECTOR, title: 'natural interaction' }))
  return { c, sid: String(s.id), root, project: repo.getProject(app.state.conn, String(p.id))!, ws: repo.getWorkspace(app.state.conn, String(s.workspace_id))! }
}
async function interactionDone(id: string) {
  return until(() => app!.state.interactions.detail(repo.getInteraction(app!.state.conn, id)!), (ix) => ['done', 'waiting', 'error', 'cancelled'].includes(ix.status) && !ix.live)
}

for (const mode of ['direct', 'attached'] as const) test(`${mode}: one natural message creates three real independent contexts, then full peer answers; source stays read-only`, async () => {
  const { c, sid, root, project } = await open(mode)
  legacyV1Director(app!.state, sid)   // a pre-surface director row (director.v1): this test pins v1's implicit original-message binding; v2's own is in test_director_v2
  const seen: { me: string; cross: boolean; text: string; thinking: unknown }[] = []
  setModel(app!.state, AGENT, scriptedModel((messages: ModelMessage[], info) => {
    const text = userTexts(messages).join('\n')
    const me = /You are (pt_[a-z0-9]+)\./.exec(text)?.[1] ?? '?'
    const cross = text.includes('Step cross-1-')
    seen.push({ me, cross, text, thinking: info.model_settings.thinking })
    // A long tail proves peers receive more than MAX_ANSWER_CHARS, without normalization.
    return modelResponse([textPart(cross ? `reply:${me}` : `answer:${me}\n${'x'.repeat(26000)}\nTAIL:${me}`)])
  }, 'participant', { supports_thinking: true }))
  setModel(app!.state, DIRECTOR, scriptedModel(steps(
    [toolCallPart('start_interaction', { participants: Array.from({ length: 3 }, () => ({ model: AGENT, thinking: 'xhigh' })), mode: 'discussion', text: 'WRONG MODEL PARAPHRASE' }, '')],
    [textPart('dispatched actual interaction')],
    [textPart('execution index received; choose a result')],
  ), 'director'))
  const body = { text: original, thinking: 'xhigh', budget: { requests: 8 }, client_request_id: `natural-${mode}-0001` }
  const started = performance.now()
  const turn = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, body))
  const same = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, body))
  expect(same.id).toBe(turn.id)
  expect(turn.input).toBe(original)
  expect(turn.envelope?.text).toBe(original)
  const routed = await until(() => dstore.getTurn(app!.state.conn, turn.id)!, (t) => t.status === 'done' || t.status === 'error')
  expect(routed.status, routed.error ?? '').toBe('done')
  expect(routed.tool_calls).toHaveLength(1)
  expect(routed.dispatched_interaction_ids).toHaveLength(1)
  const ix = await interactionDone(routed.dispatched_interaction_ids[0]!)
  expect(ix.status, ix.reason ?? '').toBe('done')
  expect(ix.workspace_policy).toBe('isolated')
  expect(ix.in_place).toBe(false)
  expect(ix.source_turn_id).toBe(turn.id)
  expect(ix.user_text).toBe(original)
  expect(ix.nodes).toHaveLength(6)
  expect(ix.runs_started).toBe(6)
  expect(new Set(ix.participants.map((p) => p.id)).size).toBe(3)
  expect(ix.participants.every((p) => p.id.startsWith('pt_') && p.thinking === 'xhigh')).toBe(true)
  expect(new Set(ix.nodes.map((n) => n.workspace_id)).size).toBe(3)
  const roots = ix.nodes.filter((n) => !n.depends_on.length)
  const cross = ix.nodes.filter((n) => n.depends_on.length)
  for (const first of roots) {
    const run = repo.getRun(app!.state.conn, first.run_id!)!
    expect(run.resumes_run_id).toBeNull()
    expect(run.user_text).toBe(original)
    expect(run.budget.requests).toBe(8)
    const own = seen.find((s) => s.me === first.participant && !s.cross)!
    expect(own).toBeDefined()
    expect(own.thinking).toBe('xhigh')
    expect(own.text).toContain(original)
    expect(own.text).not.toContain('WRONG MODEL PARAPHRASE')
    for (const peer of roots.filter((p) => p.participant !== first.participant)) expect(own.text).not.toContain(`TAIL:${peer.participant}`)
    const ws = repo.getWorkspace(app!.state.conn, first.workspace_id!)!
    expect(ws.path).not.toBe(root)
    expect(ws.source_mount).toEqual({ root, name: basename(root), readonly: true })
    expect(existsSync(join(root, '.git'))).toBe(false)
    const policy = PathPolicy.forWorkspace(ws.path, [], workspaceAttached(project, ws, { writable: true }))
    expect(readFileSync(policy.resolveRead(`${basename(root)}/experiment.jsonl`)[1], 'utf8')).toContain('0.125')
    expect(() => policy.resolveWrite(`${basename(root)}/experiment.jsonl`)).toThrow('never written')
    const box = sandboxForWorkspace(app!.state.settings.data_dir, project, ws, { network: false, attached_write: true })
    expect(box.read_allow).toContain(root)
    expect(box.write_deny).toContain(root)
    expect(box.writable).not.toContain(root)
    expect(box.deny_hardlinks).toBe(true)
    expect((await app!.state.workspaces.snapshot(ws)).file_count).toBe(0)
    const adopted = await c.post(`/api/interactions/${ix.id}/adopt`, { node_id: first.id })
    expect(adopted.status).toBe(409)
  }
  for (const second of cross) {
    expect(second.depends_on).toHaveLength(3)
    expect(second.receives).toHaveLength(2)
    const first = roots.find((n) => n.participant === second.participant)!
    const run = repo.getRun(app!.state.conn, second.run_id!)!
    expect(run.resumes_run_id).toBe(first.run_id)
    expect(run.workspace_id).toBe(first.workspace_id)
    const own = seen.find((s) => s.me === second.participant && s.cross)!
    for (const peer of roots.filter((p) => p.participant !== second.participant)) expect(own.text).toContain(`TAIL:${peer.participant}`)
    expect(own.text).not.toContain('more characters')
  }
  await until(() => dstore.listTurns(app!.state.conn, routed.director_session_id), (ts) => ts.length === 2 && ts[1]!.status === 'done')
  app!.state.director.interactionFinished(ix.id)
  app!.state.director.interactionFinished(ix.id)
  const events = dstore.listEvents(app!.state.conn, routed.director_session_id)
  expect(events).toHaveLength(1)
  expect(events[0]!.kind).toBe('interaction_finished')
  expect((events[0]!.payload.nodes as unknown[]).length).toBe(6)
  expect(dstore.getTurn(app!.state.conn, turn.id)!.dispatched_run_ids).toHaveLength(6)
  expect(readFileSync(join(root, 'experiment.jsonl'), 'utf8')).toBe('{"seed":7,"loss":0.125}\n')
  console.log(`natural scripted ${mode}: ${Math.round(performance.now() - started)} ms; participant runs=6; director requests=${dstore.listTurns(app!.state.conn, routed.director_session_id).reduce((n, t) => n + (t.usage.requests ?? 0), 0)}`)
})

test('independent template stops at N; discussion expands N*(1+R), all cross waves own and unassigned', () => {
  const ps = Array.from({ length: 3 }, (_, i) => ({ id: `pt_${i}`, label: 'same model', model: AGENT }))
  expect(expandTemplate('independent', ps).nodes).toHaveLength(3)
  const plan = expandTemplate('discussion', ps, 2)
  expect(plan.nodes).toHaveLength(9)
  expect(plan.then).toBe('stop')
  expect(plan.nodes.every((n) => n.instruction === null && n.workspace === 'own')).toBe(true)
  expect(() => expandTemplate('discussion', ps, 5)).toThrow('cross_rounds')
})

test('lazy director does not silently resume or reopen; explicit chat remains bypass; web default must be native', async () => {
  const { c, sid } = await open()
  const first = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'hello' }))
  await until(() => dstore.getTurn(app!.state.conn, first.id)!, (t) => t.status === 'done')
  await c.put(`/api/sessions/${sid}/director`, { paused: true })
  expect((await c.post(`/api/sessions/${sid}/director/messages`, { text: 'still paused' })).status).toBe(409)
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('direct bypass')]), 'agent'))
  const direct = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'bypass', model: AGENT }))
  await waitDone(app!.state, String(direct.id))
  expect(dstore.listTurns(app!.state.conn, first.director_session_id)).toHaveLength(1)
  await c.delete(`/api/sessions/${sid}/director`)
  expect((await c.post(`/api/sessions/${sid}/director/messages`, { text: 'stay closed' })).status).toBe(409)
  expect((await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: DIRECTOR })).status).toBe(200)
})

test('source-mounted policy survives serialization; symlink and inode aliases cannot write the source, even with a write grant', async () => {
  const { sid, root, project, ws: source } = await open()
  const ws = await app!.state.workspaces.createSourceWorkspace(project, sid, source)
  const reread = repo.getWorkspace(app!.state.conn, ws.id)!
  repo.setSessionGrants(app!.state.conn, sid, { ...repo.getSession(app!.state.conn, sid)!.grants, attached_write: true })
  const policy = PathPolicy.forWorkspace(reread.path, [], workspaceAttached(project, reread, { writable: true }))
  symlinkSync(join(root, 'experiment.jsonl'), join(ws.path, 'alias'))
  linkSync(join(root, 'experiment.jsonl'), join(ws.path, 'hard-alias'))
  expect(() => policy.resolveWrite('alias')).toThrow('outside')
  expect(() => policy.resolveWrite('hard-alias')).toThrow('hard links')
  const path = join(ws.path, 'own.txt')
  writeFileSync(policy.resolveWrite('own.txt')[1], 'own outputs')
  expect(readFileSync(path, 'utf8')).toBe('own outputs')
  expect(readFileSync(join(root, 'experiment.jsonl'), 'utf8')).toContain('0.125')
})

test('isolated policy refuses shared/node workspaces before dispatch and on schedule', async () => {
  const { c, sid } = await open()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('done')]), 'agent'))
  const common = { text: 'independent', participants: [{ model: AGENT, id: 'pt_a' }, { model: AGENT, id: 'pt_b' }], workspace_policy: 'isolated' }
  for (const workspace of ['shared', 'a1']) {
    const r = await c.post(`/api/sessions/${sid}/interactions`, { ...common, plan: { nodes: [{ id: 'a1', participant: 'pt_a', workspace }] } })
    expect(r.status).toBe(400)
  }
  expect(repo.listInteractions(app!.state.conn, sid)).toHaveLength(0)
  const ix = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { ...common, plan: { template: 'independent' } }))
  await interactionDone(ix.id)
  expect((await c.post(`/api/interactions/${ix.id}/schedule`, { nodes: [{ id: 'bad', participant: 'pt_a', workspace: 'shared' }], then: 'stop' })).status).toBe(400)
})

test('xhigh/max map consistently to supported route efforts and Fable adaptive effort, not silently to medium', () => {
  const route = new ModelConfig({ id: 'anthropic:claude-fable-5-1', provider: 'anthropic', model: 'claude-fable-5-1', reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] })
  for (const effort of ['xhigh', 'max']) {
    const settings = modelSettings(route, effort)
    expect(settings.thinking).toBe(effort)
    expect(thinkingFields(route.model, settings.thinking!, 65536).output_config).toEqual({ effort })
  }
  expect(modelSettings(new ModelConfig({ id: 'limited', provider: 'openai', model: 'limited', reasoning_efforts: ['low', 'high'] }), 'max').thinking).toBe('high')
})

test('v24 migration preserves a legacy workspace and envelope/idempotency defaults; reopen keeps the source mount', () => {
  const file = join(tempDir(), 'index.db')
  let db = connect(file)
  db.run("INSERT INTO projects(id,name,base_repo_path,created_at,updated_at) VALUES('p','p','/fixture','t','t')")
  db.run("INSERT INTO sessions(id,project_id,title,model,created_at,updated_at) VALUES('s','p','s','scripted:a','t','t')")
  const ws = repo.insertWorkspace(db, 'ws_old', 'p', 's', '/fixture', '', '', 'direct')
  expect(ws.source_mount).toBeNull()
  const ds = dstore.insertDirectorSession(db, { session_id: 's', transport: 'native', model: AGENT, label: 'agent', config: {} })
  const envelope = DirectorSayBodySchema.parse({ text: original, thinking: 'xhigh', client_request_id: 'original-001' })
  const turn = dstore.insertTurn(db, { session_id: 's', director_session_id: ds.id, kind: 'user', input: original, envelope })
  repo.insertWorkspace(db, 'ws_source', 'p', 's', '/outputs', 'b', 'commit', 'child', { root: '/fixture', name: 'fixture', readonly: true })
  db.close()
  db = connect(file)
  expect(dstore.turnForClientRequest(db, 's', 'original-001')!.id).toBe(turn.id)
  expect(dstore.getTurn(db, turn.id)!.envelope).toEqual(envelope)
  expect(repo.getWorkspace(db, 'ws_source')!.source_mount?.readonly).toBe(true)
  db.close()
})

for (const mode of ['direct', 'attached'] as const) test(`${mode}: scoped resume cannot override source or metadata hard denies; outputs remain writable in the profile`, async () => {
  const { sid, root, project, ws: source } = await open(mode)
  const ws = await app!.state.workspaces.createSourceWorkspace(project, sid, source)
  for (const scope of [['**'], [`${basename(root)}/**`]]) {
    const box = sandboxForWorkspace(app!.state.settings.data_dir, project, ws, { network: false, attached_write: true,
      attached: workspaceAttached(project, ws, { writable: true }), order: { read_only: false, read: ['**'], write: scope, protected: [] } })
    const rules = orderRules(box.bounds)
    const allows = [...rules.matchAll(/\(allow file-write\*\n\s+([^\n]+)/g)].map((m) => m[1]).join('\n')
    expect(allows).not.toContain(`"${root}"`)
    const profile = new SeatbeltRuntime().profile(box)
    const tail = profile.slice(profile.indexOf(';; immutable workspace denies'))
    expect(profile.indexOf(';; immutable workspace denies')).toBeGreaterThan(profile.lastIndexOf('(allow file-write*'))
    expect(tail).toContain(root)
    expect(tail).toContain(join(ws.path, '.git'))
    expect(tail).toContain('(deny file-link)')
    expect(box.writable).toContain(ws.path)
    expect(box.writable).not.toContain(root)
  }
})

test('source/data overlap (both directions, equality and a symlink alias) is refused before any workspace side effect', async () => {
  const { sid, project, ws } = await open()
  const data = app!.state.settings.data_dir
  const nested = join(data, 'nested-source')
  mkdirSync(nested)
  const alias = join(tempDir(), 'alias')
  symlinkSync(data, alias)
  const before = repo.listWorkspaces(app!.state.conn, project.id).map((w) => w.id)
  const directoryBefore = existsSync(app!.state.settings.workspaces_dir) ? readdirSync(app!.state.settings.workspaces_dir) : []
  for (const root of [data, dirname(data), nested, alias, app!.state.settings.workspaces_dir]) {
    if (!existsSync(root)) mkdirSync(root, { recursive: true })
    const candidate = { ...ws, kind: 'child', source_mount: { root, name: 'source', readonly: true as const } }
    await expect(app!.state.workspaces.createSourceWorkspace(project, sid, candidate)).rejects.toThrow()
  }
  expect(repo.listWorkspaces(app!.state.conn, project.id).map((w) => w.id)).toEqual(before)
  expect(readdirSync(app!.state.settings.workspaces_dir)).toEqual(directoryBefore)
  // Segment boundaries: a similarly named but disjoint sibling is allowed, not a prefix false positive.
  const sibling = `${data}-source`
  mkdirSync(sibling)
  const safe = await app!.state.workspaces.createSourceWorkspace(project, sid, { ...ws, path: sibling })
  expect(safe.source_mount!.root).toBe(sibling)
})

for (const action of ['pause', 'cancel', 'failure'] as const) test(`preparation race: ${action} during the first workspace preparation starts no selected later participant`, async () => {
  const { c, sid } = await open()
  let calls = 0
  setModel(app!.state, AGENT, scriptedModel(() => { calls++; return modelResponse([textPart('done')]) }))
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const create = app!.state.workspaces.createSourceWorkspace.bind(app!.state.workspaces)
  let preparing = false
  app!.state.workspaces.createSourceWorkspace = async (...args) => { preparing = true; await gate; if (action === 'failure') throw new Error('fixture preparation failed'); return create(...args) }
  const request = c.post(`/api/sessions/${sid}/interactions`, { text: 'two independent candidates', participants: [{ model: AGENT }, { model: AGENT }], workspace_policy: 'isolated', plan: { template: 'independent' } })
  await until(() => preparing, Boolean)
  const ix = repo.listInteractions(app!.state.conn, sid)[0]!
  if (action !== 'failure') await c.post(`/api/interactions/${ix.id}/${action}`, {})
  release()
  await json(await request)
  await sleep(40)
  expect(calls).toBe(0)
  expect(repo.listRunsOfInteraction(app!.state.conn, ix.id)).toHaveLength(0)
  expect(repo.getInteraction(app!.state.conn, ix.id)!.status).toBe(action === 'cancel' ? 'cancelled' : 'waiting')
  if (action === 'pause') {
    app!.state.workspaces.createSourceWorkspace = create
    await c.post(`/api/interactions/${ix.id}/continue`, {})
    expect((await interactionDone(ix.id)).status).toBe('done')
    expect(calls).toBe(2)
  }
})

test('recovery rebuilds count and all original-turn dispatch IDs from an orphan run; continued budget cannot undercount', async () => {
  const { c, sid } = await open()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('done')])) )
  const ds = app!.state.director.open(repo.getSession(app!.state.conn, sid)!, { transport: 'native', model: DIRECTOR, config: {} })
  app!.state.director.update(sid, { paused: true })
  const turn = dstore.insertTurn(app!.state.conn, { session_id: sid, director_session_id: ds.id, kind: 'user', input: original, envelope: DirectorSayBodySchema.parse({ text: original }) })
  const ix = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { source_turn_id: turn.id, text: 'not the source', participants: [{ model: AGENT }, { model: AGENT }], workspace_policy: 'isolated', max_runs: 2, plan: { template: 'independent' } }))
  await interactionDone(ix.id)
  const recorded = repo.listRunsOfInteraction(app!.state.conn, ix.id)
  repo.updateInteraction(app!.state.conn, ix.id, { status: 'running', runs_started: 0 })
  for (const n of ix.nodes) repo.updateNode(app!.state.conn, ix.id, n.id, { status: 'queued', run_id: null, run_ids: [], workspace_id: null })
  dstore.updateTurn(app!.state.conn, turn.id, { dispatched_run_ids: [], dispatched_interaction_ids: [] })
  app!.state.interactions.reconcile()
  const repaired = repo.getInteraction(app!.state.conn, ix.id)!
  expect(repaired.runs_started).toBe(2)
  expect(dstore.getTurn(app!.state.conn, turn.id)!.dispatched_run_ids).toEqual(recorded.map((r) => r.id))
  expect(repo.listNodes(app!.state.conn, ix.id).every((n) => n.run_ids.length === 1)).toBe(true)
  // A failed attempt is still a run charged to the total budget: the person's continue grows the budget from every
  // run recorded (2), so the step run again is the third, never a recount from zero.
  repo.updateNode(app!.state.conn, ix.id, ix.nodes[0]!.id, { status: 'error' })
  await c.post(`/api/interactions/${ix.id}/continue`, {})
  expect(repo.getInteraction(app!.state.conn, ix.id)!.budget.max_runs).toBe(3)
  await interactionDone(ix.id)
  expect(repo.listRunsOfInteraction(app!.state.conn, ix.id)).toHaveLength(3)
})

test("the director hands the original message to a participant's finished run it chose: that run's conversation and copy go on", async () => {
  const { c, sid } = await open()
  legacyV1Director(app!.state, sid)   // a pre-surface director row (director.v1): this test pins v1's implicit original-message binding; v2's own is in test_director_v2
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('answer')])))
  const ix = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: 'battle', participants: [{ model: AGENT }, { model: AGENT }], workspace_policy: 'isolated', plan: { template: 'independent' } }))
  const done = await interactionDone(ix.id)
  const a = done.nodes[0]!
  setModel(app!.state, DIRECTOR, scriptedModel(steps([toolCallPart('start_run', { model: AGENT, resume_run_id: a.run_id }, 'to-a')], [textPart('handed to A')], [textPart('read')])))
  const t = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: original }))
  const turn = await until(() => dstore.getTurn(app!.state.conn, t.id)!, (t) => t.status === 'done')
  expect(turn.tool_calls[0]!.args?.resume_run_id).toBe(a.run_id)
  expect(turn.dispatched_run_ids).toHaveLength(1)
  const run = repo.getRun(app!.state.conn, turn.dispatched_run_ids[0]!)!
  expect(run.resumes_run_id).toBe(a.run_id)
  expect(run.workspace_id).toBe(a.workspace_id)
  expect(run.user_text).toBe(original)   // v25: a follow-up keeps the words exactly as sent (the baseline trimmed them on /resume)
  expect(run.workspace_id).not.toBe(repo.getSession(app!.state.conn, sid)!.workspace_id)
})

test('native separate is refused, not downgraded; a new ordinary direct message still dispatches the exact original once', async () => {
  const { c, sid, root } = await open()
  legacyV1Director(app!.state, sid)   // a pre-surface director row (director.v1): this test pins v1's implicit original-message binding; v2's own is in test_director_v2
  setModel(app!.state, DIRECTOR, scriptedModel(steps(
    [toolCallPart('start_run', { model: AGENT, separate: true, text: 'paraphrase' }, 'separate-call')],
    [textPart('separate refused')],
  )))
  const first = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: original }))
  const refused = await until(() => dstore.getTurn(app!.state.conn, first.id)!, (t) => t.status === 'done')
  expect(refused.tool_calls).toHaveLength(1)
  expect(refused.tool_calls[0]!.status).toBe('refused')
  expect(refused.tool_calls[0]!.outcome).toContain('start_interaction')
  expect(repo.listRuns(app!.state.conn, sid)).toHaveLength(0)
  setModel(app!.state, AGENT, scriptedModel(steps([toolCallPart('write_file', { path: 'explicit.txt', content: 'explicit direct work' }, '')], [textPart('done')])))
  setModel(app!.state, DIRECTOR, scriptedModel(steps(
    [toolCallPart('start_run', { model: AGENT, text: 'SHORTENED' }, 'stable-call')], [textPart('sent')], [textPart('receipt read')],
  )))
  const second = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'write explicit.txt', client_request_id: 'stable-call-0001' }))
  const done = await until(() => dstore.getTurn(app!.state.conn, second.id)!, (t) => t.status === 'done')
  expect(done.tool_calls).toHaveLength(1)
  expect(done.tool_calls[0]!.tool_call_id).toBe('stable-call')
  expect(done.tool_calls[0]!.args?.text).toBe('write explicit.txt')
  expect(done.dispatched_run_ids).toHaveLength(1)
  await waitDone(app!.state, done.dispatched_run_ids[0]!)
  expect(readFileSync(join(root, 'explicit.txt'), 'utf8')).toBe('explicit direct work')
})

test('isolated completion cannot dispatch a main summary writer, another group, schedule or integration', async () => {
  const { c, sid, root } = await open()
  legacyV1Director(app!.state, sid)   // a pre-surface director row (director.v1): this test pins v1's implicit original-message binding; v2's own is in test_director_v2
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('candidate')])) )
  setModel(app!.state, DIRECTOR, scriptedModel(steps(
    [toolCallPart('start_interaction', { participants: [{ model: AGENT }, { model: AGENT }], mode: 'independent' }, 'start-group')],
    [textPart('started')],
    [toolCallPart('start_run', { model: AGENT, text: 'write summary into source' }, 'bad-summary'), toolCallPart('start_interaction', { participants: [{ model: AGENT }, { model: AGENT }] }, 'bad-loop')],
    [textPart('raw result index only')],
  )))
  const t = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'independent candidates' }))
  const turns = await until(() => dstore.listTurns(app!.state.conn, t.director_session_id), (ts) => ts.length === 2 && ts[1]!.status === 'done')
  expect(turns[1]!.tool_calls.map((c) => c.status)).toEqual(['refused', 'refused'])
  expect(repo.listInteractions(app!.state.conn, sid)).toHaveLength(1)
  expect(repo.listRuns(app!.state.conn, sid)).toHaveLength(2)
  expect(existsSync(join(root, 'summary.md'))).toBe(false)
  expect(dstore.listEvents(app!.state.conn, t.director_session_id)).toHaveLength(1)
})

test('verification is refused in core and API for source-mounted checkpoints before any checkout, even with no checks', async () => {
  const { c, sid, project, ws: source } = await open()
  const ws = await app!.state.workspaces.createSourceWorkspace(project, sid, source)
  const cp = await app!.state.workspaces.checkpoint(ws, null, 'fixture')
  expect((await c.post(`/api/workspaces/${ws.id}/verify`, { checkpoint_id: cp.id })).status).toBe(409)
  await expect(runChecks(app!.state.conn, app!.state.workspaces, app!.state.processes, project, cp, { checks: [] })).rejects.toThrow('source-mounted')
  expect((await c.post(`/api/workspaces/${source.id}/integrate`, { checkpoint_ids: [cp.id] })).status).toBe(409)
})

for (const mode of ['direct', 'attached'] as const) test(`${mode}: hard-lock postcheck compares output trees in their own repo (test command double, not a kernel test)`, async () => {
  const { sid, project, ws: source } = await open(mode)
  const ws = await app!.state.workspaces.createSourceWorkspace(project, sid, source)
  writeFileSync(join(ws.path, 'locked.txt'), 'before')
  await app!.state.workspaces.checkpoint(ws, null, 'before command')
  const processes = {
    start: async () => { writeFileSync(join(ws.path, 'locked.txt'), 'after'); return { id: 'test-command' } },
    wait: async () => null, summary: () => ({ running: false, status: 'succeeded', exit_code: 0 }),
  } as unknown as ProcessManager
  const [result] = await executeCommand({ processes, workspaces: app!.state.workspaces, config: app!.state.config, project, workspace: ws,
    policy: PathPolicy.forWorkspace(ws.path, [], workspaceAttached(project, ws)), locks: [lockSpec({ path: 'locked.txt', mode: 'read_only' })],
    run_id: null, tool_call_id: null, command: 'fixture double writes locked.txt' })
  expect(result.lock_violations).toHaveLength(1)
})

test('ProcessManager propagates immutable deny_hardlinks and write_deny to the runtime (capture only, executes nothing)', async () => {
  const { sid, project, ws: source } = await open()
  const ws = await app!.state.workspaces.createSourceWorkspace(project, sid, source)
  let captured: Sandbox | null = null
  const runtime = { name: 'capture-only', fingerprint: () => 'test', probe: async () => FAKE_FULL,
    command: (_a: string[], box: Sandbox) => { captured = box; throw new Error('CAPTURE_ONLY_NO_EXECUTION') } }
  const pm = new ProcessManager(app!.state.settings, app!.state.conn, app!.state.store, runtime, FAKE_FULL)
  const box = sandboxForWorkspace(app!.state.settings.data_dir, project, ws, { network: false })
  await expect(pm.start({ command: 'never executed', cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id })).rejects.toThrow('CAPTURE_ONLY')
  expect((captured as Sandbox | null)?.deny_hardlinks).toBe(true)
  expect((captured as Sandbox | null)?.write_deny).toContain(ws.source_mount!.root)
})

for (const sentence of [GAN_BATTLE_SENTENCE, INDEPENDENT_SENTENCE]) test(`e2e scripted fixture routes the original no-@ first sentence: ${sentence}`, async () => {
  const { c, sid } = await open('direct', SOURCE_NAME)
  const fixture = naturalFixtureRoutes()
  app!.state.config.models.push(...fixture.config)
  for (const [id, model] of Object.entries(fixture.models)) setModel(app!.state, id, model)
  await c.put(`/api/sessions/${sid}/model`, { model: NATURAL_DIRECTOR })
  legacyV1Director(app!.state, sid)   // a pre-surface director row (director.v1): this test pins v1's implicit original-message binding; v2's own is in test_director_v2
  const t = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: sentence }))
  const turn = await until(() => dstore.getTurn(app!.state.conn, t.id)!, (t) => t.status === 'done')
  expect(turn.dispatched_interaction_ids).toHaveLength(1)
  const ix = await interactionDone(turn.dispatched_interaction_ids[0]!)
  expect(ix.status, ix.reason ?? '').toBe('done')
  expect(fixture.config.find((m) => m.id === NATURAL_FABLE)!.reasoning_efforts).toBeNull()
  expect(turn.envelope?.thinking).toBeUndefined()
  const effort = null                                  // no effort named in the words or chosen: each model's default
  expect(ix.participants.every((p) => p.model === NATURAL_FABLE && (p.thinking ?? null) === effort)).toBe(true)
  expect(ix.nodes).toHaveLength(sentence === GAN_BATTLE_SENTENCE ? 6 : 3)
  for (const n of ix.nodes) {
    const run = repo.getRun(app!.state.conn, n.run_id!)!
    expect(run.model_config_snapshot.thinking).toBe(effort)
    expect(run.model_config_snapshot.thinking_sent).toBe(effort)
    expect(run.receipt.final_text).toContain(n.depends_on.length ? 'PEER_INPUT_OK' : 'INDEPENDENT_OK')
    expect(run.receipt.final_text).not.toContain('MISSING')
  }
})

test('original attachment-only envelope and pinned mentions reach every participant; unknown routes and foreign attachments fail before runs', async () => {
  const { c, sid } = await open()
  legacyV1Director(app!.state, sid)   // a pre-surface director row (director.v1): this test pins v1's implicit original-message binding; v2's own is in test_director_v2
  const response = await c.app.app.request(`http://localhost/api/sessions/${sid}/attachments?name=raw.md`, { method: 'POST', body: 'EXPERIMENT_ORIGINAL\nseed=7\n', headers: { ...c.headers, 'content-type': 'text/markdown' } })
  const asset = await json(response)
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('read original material')])) )
  setModel(app!.state, DIRECTOR, scriptedModel(steps(
    [toolCallPart('start_interaction', { participants: [{ model: AGENT }, { model: AGENT }], text: 'summary without attachments' }, 'original-files')],
    [textPart('sent')], [textPart('indexed')],
  )))
  const t = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: '', attachments: [asset.asset_id], mentions: [{ path: 'experiment.jsonl' }], thinking: 'max' }))
  const turn = await until(() => dstore.getTurn(app!.state.conn, t.id)!, (t) => t.status === 'done')
  expect(turn.envelope!.attachments).toEqual([String(asset.asset_id)])
  const ix = await interactionDone(turn.dispatched_interaction_ids[0]!)
  expect(ix.status).toBe('done')
  for (const n of ix.nodes) {
    const run = repo.getRun(app!.state.conn, n.run_id!)!
    expect(run.user_text).toBe('')
    expect(run.attachments.map((a) => a.asset_id)).toEqual([String(asset.asset_id)])
    expect(run.model_config_snapshot.thinking).toBe('max')
    const history = repo.getRunHistory(app!.state.conn, run.id)!
    expect(history).toContain(String(asset.asset_id))
    expect(history).toContain('research_source/experiment.jsonl')
  }
  expect((await c.post(`/api/sessions/${sid}/interactions`, { text: 'bad route', participants: [{ model: AGENT }, { model: 'no:route' }], workspace_policy: 'isolated', plan: { template: 'independent' } })).status).toBe(400)
  expect((await c.post(`/api/sessions/${sid}/director/messages`, { text: 'bad attachment', attachments: ['a_missing'] })).status).not.toBe(200)
  expect(repo.listRuns(app!.state.conn, sid)).toHaveLength(2)
})

for (const scope of [['**'], ['research_source/**']]) test(`source-mounted resume with work_order scope.write=${scope} keeps file-tools read-only and scratch output distinct`, async () => {
  const { c, sid, root, project, ws: source } = await open()
  const ws = await app!.state.workspaces.createSourceWorkspace(project, sid, source)
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('initial')])) )
  const initial = await app!.state.runs.start(repo.getSession(app!.state.conn, sid)!, 'initial', { workspace_id: ws.id, model_id: AGENT, fresh: true, work_order: parseWorkOrder({ prompt: 'initial' }), spawned_by: 'connector', interaction: { id: 'ix_fixture', node: 'root', note: null, harness_message: false } })
  await waitDone(app!.state, initial.id)
  setModel(app!.state, AGENT, scriptedModel(steps(
    [toolCallPart('write_file', { path: 'research_source/experiment.jsonl', content: 'BAD' }, '')],
    [textPart('source refused')],
  )))
  const resumed = await json(await c.post(`/api/runs/${initial.id}/resume`, { text: 'continue without changing the source', work_order: { scope: { write: scope } } }))
  await waitDone(app!.state, String(resumed.id))
  const result = repo.getRun(app!.state.conn, String(resumed.id))!
  expect(result.workspace_id).toBe(ws.id)
  expect(readFileSync(join(root, 'experiment.jsonl'), 'utf8')).toContain('0.125')
  const history = loadJson(repo.getRunHistory(app!.state.conn, result.id)!)
  expect(JSON.stringify(lastToolReturn(history, 'write_file'))).toContain('never written')
  // Even the explicit chat API must not move a source-mounted resumed conversation to the writable main folder.
  // schema v25 (audit P6): a thread message naming a separate task's run (this one is under an order) is refused
  // outright — it would continue that conversation without its order — so nothing starts, anywhere; the order's own
  // follow-up (above) is the way on, on its source-mounted copy
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('continued safely')])) )
  const runsBefore = repo.listRuns(app!.state.conn, sid).length
  const follow = await json<{ detail: string }>(await c.post(`/api/sessions/${sid}/chat`, { text: 'continue', model: AGENT, resumes_run_id: initial.id }), 400)
  expect(follow.detail).toContain('separate task')
  expect(repo.listRuns(app!.state.conn, sid)).toHaveLength(runsBefore)
  expect(result.workspace_id).toBe(ws.id)
})

test('real-kernel conditional controls: source/sibling/metadata/hardlink negatives and scratch positive after scoped resume', async () => {
  const { c, sid, root, project, ws: source } = await open()
  // the kernel's controls are the sandbox's: a Full access session's commands run as the person, the read-only source
  // bounding the file tools only
  repo.setSessionAccess(app!.state.conn, sid, 'sandbox')
  const ws = await app!.state.workspaces.createSourceWorkspace(project, sid, source)
  const runtime = buildRuntime()
  const report = await runtime.probe(app!.state.settings.data_dir)
  if (report.enforcement !== 'full') {
    console.warn(`KERNEL_NOT_VERIFIED natural source controls: ${JSON.stringify(report)}`)
    // The unavailable runtime must fail closed, never substitute PassthroughRuntime.
    const pm = new ProcessManager(app!.state.settings, app!.state.conn, app!.state.store, runtime, report)
    await expect(pm.start({ command: 'echo MUST_NOT_RUN', cwd: ws.path, project_id: project.id, workspace_id: ws.id,
      sandbox: sandboxForWorkspace(app!.state.settings.data_dir, project, ws, { network: false }) })).rejects.toThrow()
    await pm.shutdown()
    expect(readFileSync(join(root, 'experiment.jsonl'), 'utf8')).toContain('0.125')
    return
  }
  const pm = new ProcessManager(app!.state.settings, app!.state.conn, app!.state.store, runtime, report)
  const originalPm = app!.state.processes
  app!.state.processes = pm
  try {
    setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('initial')])) )
    const initial = await app!.state.runs.start(repo.getSession(app!.state.conn, sid)!, 'initial', { workspace_id: ws.id, model_id: AGENT, fresh: true, work_order: parseWorkOrder({ prompt: 'initial' }), interaction: { id: 'ix_kernel', node: 'root', note: null, harness_message: false } })
    await waitDone(app!.state, initial.id)
    const sibling = await app!.state.workspaces.createSourceWorkspace(project, sid, source)
    writeFileSync(join(sibling.path, 'private.txt'), 'sibling-private')
    const command = `printf OK > own.txt; test "$(cat research_source/experiment.jsonl)" != ''; if printf BAD >> research_source/experiment.jsonl; then exit 81; fi; if printf BAD >> .git; then exit 82; fi; if ln research_source/experiment.jsonl hard; then exit 83; fi; if cat '${sibling.path}/private.txt'; then exit 84; fi; echo KERNEL_CONTROLS_OK`
    setModel(app!.state, AGENT, scriptedModel(steps([toolCallPart('bash', { command, wait_s: 10 }, '')], [textPart('controls complete')])))
    const resumed = await json(await c.post(`/api/runs/${initial.id}/resume`, { text: 'kernel controls', work_order: { scope: { write: ['**'] }, tools: ['bash'] } }))
    await waitDone(app!.state, String(resumed.id))
    const payload = lastToolReturn(loadJson(repo.getRunHistory(app!.state.conn, String(resumed.id))!), 'bash') as Record<string, unknown>
    expect(payload.exit_code).toBe(0)
    expect(payload.stdout).toContain('KERNEL_CONTROLS_OK')
    expect(readFileSync(join(ws.path, 'own.txt'), 'utf8')).toBe('OK')
    expect(readFileSync(join(root, 'experiment.jsonl'), 'utf8')).toContain('0.125')
    console.log('KERNEL_VERIFIED natural source scoped resume negative and positive controls')
  } finally { app!.state.processes = originalPm; await pm.shutdown() }
})

test('a genuine v23-shaped fixture migrates to v24 without changing legacy source/turn meaning', () => {
  const file = join(tempDir(), 'v23.db')
  let db = connect(file)
  db.run("INSERT INTO projects(id,name,base_repo_path,created_at,updated_at) VALUES('p','p','/fixture','t','t')")
  db.run("INSERT INTO sessions(id,project_id,title,model,created_at,updated_at) VALUES('s','p','s','m','t','t')")
  repo.insertWorkspace(db, 'ws_legacy', 'p', 's', '/fixture', '', '', 'direct')
  const ds = dstore.insertDirectorSession(db, { session_id: 's', transport: 'native', model: 'm', label: 'm', config: {} })
  const turn = dstore.insertTurn(db, { session_id: 's', director_session_id: ds.id, kind: 'user', input: original })
  db.exec(`DROP INDEX director_turns_by_client_request;
    ALTER TABLE director_turns DROP COLUMN dispatched_interactions_json;
    ALTER TABLE director_turns DROP COLUMN client_request_id;
    ALTER TABLE director_turns DROP COLUMN envelope_json;
    ALTER TABLE workspaces DROP COLUMN source_mount_json;
    ALTER TABLE interactions DROP COLUMN source_turn_id;
    ALTER TABLE interactions DROP COLUMN workspace_policy;
    PRAGMA user_version=23;`)
  db.close()
  db = connect(file)
  expect(db.get('PRAGMA user_version')!.user_version).toBe(35)  // v25: the collaboration model's migration runs after v24's (v26, the session cursor, v27, the sessions' latest activity, v28, the sessions' access, and v29, the sessions' task and roots, after it); v30: SSH targets; v31: SSH connect intent; v32: CNY costs, v33 read-path indexes
  expect(existsSync(`${file}.v23.bak`)).toBe(true)
  expect(repo.getWorkspace(db, 'ws_legacy')!.source_mount).toBeNull()
  expect(repo.getWorkspace(db, 'ws_legacy')!.kind).toBe('direct')
  expect(dstore.getTurn(db, turn.id)!.input).toBe(original)
  expect(dstore.getTurn(db, turn.id)!.envelope).toBeNull()
  expect(dstore.getTurn(db, turn.id)!.dispatched_interaction_ids).toEqual([])
  db.close()
})

for (const mode of ['direct', 'attached'] as const) test(`${mode} recorded source replaced by sibling symlink is refused before scratch creation`, async () => {
  const { sid, root, project, ws } = await open(mode)
  const moved = `${root}-approved`, sibling = `${root}-sibling`
  renameSync(root, moved)
  mkdirSync(sibling)
  writeFileSync(join(sibling, 'untouched'), 'sibling')
  symlinkSync(sibling, root)
  const before = repo.listWorkspaces(app!.state.conn, project.id)
  const folders = existsSync(app!.state.settings.workspaces_dir) ? readdirSync(app!.state.settings.workspaces_dir) : []
  await expect(app!.state.workspaces.createSourceWorkspace(project, sid, ws)).rejects.toThrow('link now')
  expect(repo.listWorkspaces(app!.state.conn, project.id)).toEqual(before)
  expect(existsSync(app!.state.settings.workspaces_dir) ? readdirSync(app!.state.settings.workspaces_dir) : []).toEqual(folders)
  expect(readdirSync(sibling)).toEqual(['untouched'])
  expect(readFileSync(join(moved, 'experiment.jsonl'), 'utf8')).toContain('0.125')
})

for (const history of ['direct-explicit', 'isolated-explicit', 'direct-default', 'chat-explicit', 'chat-default', 'fresh'] as const) test(`isolated roots fork full fixed previous history, never current peer answers: ${history}`, async () => {
  const { c, sid } = await open()
  const followup = `ordinary continuation material\n${'followup-data '.repeat(2000)}\nFOLLOWUP_TAIL`
  const common = `original research material\n${'raw-data '.repeat(3500)}\nCOMMON_TAIL`
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('COMMON_ANSWER')]), 'participant'))
  let prior: string
  if (history.startsWith('direct-')) {
    const r = await json(await c.post(`/api/sessions/${sid}/chat`, { text: common, model: AGENT, fresh: true }))
    prior = String(r.id); await waitDone(app!.state, prior)
  } else {
    const group = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: common, workspace_policy: 'isolated', fresh: true, participants: [{ model: AGENT }, { model: AGENT }], plan: { template: 'independent' } }))
    await interactionDone(group.id)
    prior = (await interactionDone(group.id)).nodes[0]!.run_id!
    // A normal explicit wider-write target remains forbidden even though safe group forks are allowed.
    await expect(app!.state.runs.start(repo.getSession(app!.state.conn, sid)!, 'unsafe wider resume', { model_id: AGENT, resumes_run_id: prior, workspace_id: repo.getSession(app!.state.conn, sid)!.workspace_id })).rejects.toThrow('cannot resume')
  }
  // schema v25 (integration): a thread message can no longer name a group member's run (it would make the main agent
  // carry that member's conversation); the member's own continuation is its follow-up — a step of its group, on its
  // own source-mounted copy (the same fork checks below apply to it)
  if (history.startsWith('chat-')) {
    const old = repo.getRun(app!.state.conn, prior)!
    const refused = await c.post(`/api/sessions/${sid}/chat`, { text: followup, model: AGENT, resumes_run_id: prior })
    expect(refused.status).toBe(400)
    const resumed = await json(await c.post(`/api/runs/${prior}/resume`, { text: followup, model: AGENT }))
    prior = String(resumed.id)
    await waitDone(app!.state, prior)
    const continuation = repo.getRun(app!.state.conn, prior)!
    expect(continuation.interaction_id).toBe(old.interaction_id)
    expect(continuation.interaction_node).toStartWith('fu-')
    expect(continuation.workspace_id).toBe(old.workspace_id)
    await expect(app!.state.runs.start(repo.getSession(app!.state.conn, sid)!, 'unsafe wider continuation', { model_id: AGENT, resumes_run_id: prior, workspace_id: repo.getSession(app!.state.conn, sid)!.workspace_id })).rejects.toThrow('cannot resume')
  }
  const seen: string[] = []
  setModel(app!.state, AGENT, scriptedModel((messages) => {
    seen.push(JSON.stringify(messages))
    return modelResponse([textPart(`CURRENT_PEER_ANSWER_${seen.length}`)])
  }, 'participant'))
  const started = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, {
    text: 'independent first candidates', workspace_policy: 'isolated', participants: [{ model: AGENT }, { model: AGENT }, { model: AGENT }],
    concurrency: 1, plan: { template: 'independent' }, ...(!history.endsWith('-default') ? { resumes_run_id: prior } : {}), fresh: history === 'fresh',
  }))
  const ix = await interactionDone(started.id)
  expect(ix.status, ix.reason ?? '').toBe('done')
  expect(seen).toHaveLength(3)
  // chat-default: the member's follow-up is that member's (audit P2, corrected): never the thread's head, so a group
  // with no named starting point starts from the thread — which has no run of its own here — like a fresh one
  const startsFresh = history === 'fresh' || history === 'chat-default'
  for (const messages of seen) {
    if (startsFresh) { expect(messages).not.toContain('COMMON_TAIL'); expect(messages).not.toContain('COMMON_ANSWER') }
    else { expect(messages).toContain(common.replaceAll('\n', '\\n')); expect(messages).toContain('COMMON_ANSWER') }
    if (history === 'chat-explicit') expect(messages).toContain(followup.replaceAll('\n', '\\n'))
    if (history === 'chat-default') expect(messages).not.toContain('FOLLOWUP_TAIL')
    expect(messages).not.toContain('CURRENT_PEER_ANSWER_')
  }
  for (const n of ix.nodes) expect(repo.getRun(app!.state.conn, n.run_id!)!.resumes_run_id).toBe(startsFresh ? null : prior)
})

test('paused with two active nodes survives runner restart without auto-start, then explicit continue progresses', async () => {
  const { c, sid } = await open()
  setModel(app!.state, AGENT, scriptedModel(async () => { await sleep(250); return modelResponse([textPart('slow first')]) }))
  const ix = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: 'pause before crash', workspace_policy: 'isolated', participants: [{ model: AGENT }, { model: AGENT }], plan: { template: 'independent' }, max_runs: 6 }))
  expect(ix.nodes.filter((n) => n.status === 'running')).toHaveLength(2)
  await c.post(`/api/interactions/${ix.id}/pause`, {})
  const settings = app!.state.settings
  const runs = ix.nodes.map((n) => n.run_id!)
  await app!.close(); app = null
  // Reconstitute the persisted crash boundary (rather than leaving real in-process tasks behind).
  const db = connect(settings.db_path)
  for (const id of runs) db.run("UPDATE runs SET status='running', finished_at=NULL WHERE id=?", [id])
  for (const n of ix.nodes) repo.updateNode(db, ix.id, n.id, { status: 'running' })
  repo.updateInteraction(db, ix.id, { status: 'waiting', reason: 'paused by the person' })
  db.close()
  app = await makeApp(settings)
  await app.state.runs.reconcile()
  app.state.interactions.reconcile()
  setModel(app.state, AGENT, scriptedModel(() => modelResponse([textPart('continued')])) )
  const repaired = app.state.interactions.detail(repo.getInteraction(app.state.conn, ix.id)!)
  expect(repaired.status).toBe('waiting')
  expect(repaired.nodes.every((n) => n.status === 'error')).toBe(true)
  expect(runs.every((id) => repo.getRun(app!.state.conn, id)!.status === 'error')).toBe(true)
  expect(repaired.runs_started).toBe(2)
  await sleep(60)
  expect(repo.listRunsOfInteraction(app.state.conn, ix.id)).toHaveLength(2)
  await json(await new Client(app).post(`/api/interactions/${ix.id}/continue`, {}))
  expect((await interactionDone(ix.id)).status).toBe('done')
  expect(repo.listRunsOfInteraction(app.state.conn, ix.id)).toHaveLength(4)
})

test('continue right after a pause, while steps of the interaction still end: accepted, and the plan goes on once', async () => {
  const { c, sid } = await open()
  setModel(app!.state, AGENT, scriptedModel(async () => { await sleep(250); return modelResponse([textPart('answer')]) }))
  const ix = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: 'pause and continue at once', workspace_policy: 'isolated', participants: [{ model: AGENT }, { model: AGENT }], plan: { template: 'discussion', cross_rounds: 1 }, max_runs: 6 }))
  expect(ix.nodes.filter((n) => n.status === 'running')).toHaveLength(2)
  await c.post(`/api/interactions/${ix.id}/pause`, {})
  const continued = await c.post(`/api/interactions/${ix.id}/continue`, {})
  expect(continued.status).toBe(200)
  const done = await interactionDone(ix.id)
  expect(done.status).toBe('done')
  expect(repo.listRunsOfInteraction(app!.state.conn, ix.id)).toHaveLength(4)
  expect(new Set(done.nodes.flatMap((n) => n.run_ids)).size).toBe(4)
})

for (const identity of ['explicit', 'bind-order', 'one-token'] as const) test(`original same-model IDs and efforts override invented director efforts: ${identity}`, async () => {
  const { c, sid } = await open()
  legacyV1Director(app!.state, sid)   // a pre-surface director row (director.v1): this test pins v1's implicit original-message binding; v2's own is in test_director_v2
  const fixture = naturalFixtureRoutes()
  app!.state.config.models.push(...fixture.config)
  const count = identity === 'one-token' ? 1 : 2
  const words = Array.from({ length: count }, (_, i) => `@[Fable ${i}](agent:${NATURAL_FABLE}#pt_original${i})`).join(' ') + ' 请让三个 agent battle。'
  const supplied = Array.from({ length: 3 }, (_, i) => ({ model: NATURAL_FABLE, thinking: 'xhigh', ...(identity === 'explicit' && i < count ? { id: `pt_original${i}` } : {}) }))
  setModel(app!.state, NATURAL_FABLE, scriptedModel(() => modelResponse([textPart('answer')]), 'participant', { supports_thinking: true }))
  setModel(app!.state, DIRECTOR, scriptedModel(steps([toolCallPart('start_interaction', { participants: supplied, mode: 'discussion', thinking: 'xhigh' }, '')], [textPart('dispatched')], [textPart('index')])))
  const originalBody = { text: words, thinking: 'high', participant_thinking: { pt_original0: 'max', ...(count === 2 ? { pt_original1: 'off' } : {}) } }
  const t = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, originalBody))
  const turn = await until(() => dstore.getTurn(app!.state.conn, t.id)!, (t) => ['done', 'error'].includes(t.status))
  expect(turn.status, turn.error ?? '').toBe('done')
  expect(turn.dispatched_interaction_ids).toHaveLength(1)
  expect(turn.envelope).toEqual(DirectorSayBodySchema.parse(originalBody))
  const ix = await interactionDone(turn.dispatched_interaction_ids[0]!)
  expect(ix.status, ix.reason ?? '').toBe('done')
  expect(ix.participants).toHaveLength(3)
  expect(ix.participants[0]!.id).toBe('pt_original0')
  expect(ix.participants[0]!.thinking).toBe('max')
  if (count === 2) { expect(ix.participants[1]!.id).toBe('pt_original1'); expect(ix.participants[1]!.thinking).toBe('off') }
  expect(ix.participants[2]!.thinking).toBe('high')
  for (const n of ix.nodes) {
    const expected = ix.participants.find((p) => p.id === n.participant)!.thinking
    const run = repo.getRun(app!.state.conn, n.run_id!)!
    expect(run.model_config_snapshot.thinking).toBe(expected)
    expect(run.model_config_snapshot.thinking_sent).toBe(expected)
  }
})

test('source-bound roster rejects original identity/model mismatch before any run', async () => {
  const { c, sid } = await open()
  const ds = app!.state.director.open(repo.getSession(app!.state.conn, sid)!, { transport: 'native', model: DIRECTOR, config: {} })
  const envelope = DirectorSayBodySchema.parse({ text: `@[A](agent:${AGENT}#pt_fixed) battle`, participant_thinking: { pt_fixed: 'max' } })
  const t = dstore.insertTurn(app!.state.conn, { session_id: sid, director_session_id: ds.id, kind: 'user', input: envelope.text, envelope })
  const r = await c.post(`/api/sessions/${sid}/interactions`, { text: 'overridden', source_turn_id: t.id, participants: [{ id: 'pt_fixed', model: DIRECTOR }, { model: AGENT }], plan: { template: 'discussion' } })
  expect(r.status).toBe(400)
  expect(await r.text()).toContain('different model')
  expect(repo.listRuns(app!.state.conn, sid)).toHaveLength(0)
})

for (const policy of [
  { label: 'known xhigh support adds no effort nobody chose', model: 'claude-fable-5-1', efforts: null, mode: 'discussion', workspace: 'isolated', expected: null },
  { label: 'explicit config wins', model: 'claude-fable-5-1', efforts: ['high' as const], mode: 'discussion', workspace: 'isolated', expected: null },
  { label: 'unknown Anthropic proxy alias with null efforts', model: 'unknown-model', efforts: null, mode: 'discussion', workspace: 'isolated', expected: null },
  { label: 'independent unchanged', model: 'claude-fable-5-1', efforts: null, mode: 'independent', workspace: 'isolated', expected: null },
  { label: 'legacy unchanged', model: 'claude-fable-5-1', efforts: null, mode: 'discussion', workspace: 'legacy', expected: null },
  { label: 'custom schedule unchanged', model: 'claude-fable-5-1', efforts: null, mode: 'custom', workspace: 'isolated', expected: null },
  { label: 'director explicit global', model: 'claude-fable-5-1', efforts: null, mode: 'discussion', workspace: 'isolated', expected: null, global: 'high' },
  { label: 'director explicit participant', model: 'claude-fable-5-1', efforts: null, mode: 'discussion', workspace: 'isolated', expected: 'off', global: 'high', participant: 'off' },
]) test(`creation-time effort policy: ${policy.label}`, async () => {
  const { c, sid } = await open()
  const cfg = new ModelConfig({ id: 'scripted:effort', provider: 'anthropic', model: policy.model, reasoning_efforts: policy.efforts, api_key_env: 'OASIS_TEST_KEY_A' })
  app!.state.config.models.push(cfg)
  setModel(app!.state, cfg.id, scriptedModel(() => modelResponse([textPart('answer')]), 'effort', { supports_thinking: true }))
  const ix = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, {
    text: 'effort fixture', workspace_policy: policy.workspace, thinking: policy.global,
    participants: ['pt_a', 'pt_b'].map((id) => ({ id, model: cfg.id, thinking: policy.participant })),
    plan: policy.mode === 'custom' ? { nodes: ['pt_a', 'pt_b'].map((p) => ({ id: p, participant: p, depends_on: [], receives: [], workspace: 'own' })), then: 'stop' } : { template: policy.mode },
  }))
  const done = await interactionDone(ix.id)
  expect(done.status, done.reason ?? '').toBe('done')
  expect(done.participants.map((p) => p.thinking ?? null)).toEqual([policy.expected, policy.expected])
  for (const n of done.nodes) expect(repo.getRun(app!.state.conn, n.run_id!)!.model_config_snapshot.thinking).toBe(policy.participant ?? policy.global ?? policy.expected)
})


for (const boundary of ['source-root', 'mount-name', 'previous-session', 'target-session'] as const) test(`ordinary continuation history cannot fork across ${boundary}`, async () => {
  const { c, sid, root } = await open()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('original answer')])) )
  const first = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: 'original', workspace_policy: 'isolated', participants: [{ model: AGENT }, { model: AGENT }], plan: { template: 'independent' } }))
  const earlier = (await interactionDone(first.id)).nodes[0]!
  // schema v25 (integration): the member's continuation is its own follow-up (a thread message naming its run is refused)
  const r = await json(await c.post(`/api/runs/${earlier.run_id}/resume`, { text: 'ordinary continuation', model: AGENT }))
  await waitDone(app!.state, String(r.id))
  const conn = app!.state.conn
  const foreign = await json(await c.post(`/api/projects/${repo.getSession(conn, sid)!.project_id}/sessions`, { model: AGENT }))
  const create = app!.state.workspaces.createSourceWorkspace.bind(app!.state.workspaces)
  app!.state.workspaces.createSourceWorkspace = async (...args) => {
    const target = await create(...args)
    if (boundary === 'previous-session') conn.run('UPDATE workspaces SET session_id=? WHERE id=?', [String(foreign.id), earlier.workspace_id])
    else if (boundary === 'target-session') conn.run('UPDATE workspaces SET session_id=? WHERE id=?', [String(foreign.id), target.id])
    else {
      const mount = { ...target.source_mount! }
      if (boundary === 'mount-name') mount.name = 'different-name'
      else { mount.root = `${root}-other-source`; mkdirSync(mount.root) }
      conn.run('UPDATE workspaces SET source_mount_json=? WHERE id=?', [JSON.stringify(mount), target.id])
    }
    return repo.getWorkspace(conn, target.id)!
  }
  const group = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: 'new group', resumes_run_id: r.id, workspace_policy: 'isolated', participants: [{ model: AGENT }, { model: AGENT }], plan: { template: 'independent' } }))
  const stopped = await interactionDone(group.id)
  expect(stopped.status).toBe('waiting')
  expect(stopped.reason).toContain('cannot resume')
  expect(repo.listRunsOfInteraction(conn, group.id)).toHaveLength(0)
})
