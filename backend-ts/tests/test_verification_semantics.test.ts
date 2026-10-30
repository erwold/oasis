/** Results and checks apart, end to end: a receipt counts its checks as they went — passed, failed, unknown, and
 *  the configured ones that did not run — and carries no verdict on the task; a required check that could not be
 *  judged keeps a composition out of the workspace, an optional one never blocks it. PassthroughRuntime: real Git
 *  and real processes; no OS isolation is claimed here. */
import { afterEach, expect, test } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CheckConfigSchema } from '@oasis-code/contract'
import { checkCounts, humanReceipt } from '../src/agent/work_orders.ts'
import * as repo from '../src/db/repo.ts'
import type { App } from '../src/main.ts'
import { runChecks } from '../src/verify/checks.ts'
import { integrate } from '../src/workspace/integrate.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo, FAKE_FULL, openSession, PassthroughRuntime } from './harness.ts'
import { rec } from './tree_helpers.ts'

const mechanicalOf = (run: { receipt: Record<string, unknown> }) => rec(run.receipt.mechanical)

let app: App | null = null
afterEach(async () => { await app?.close(); app = null })
async function fixture() {
  app = await makeApp(null, { runtime: new PassthroughRuntime(), isolation: FAKE_FULL })
  const opened = await openSession(app.state, buggyRepo())
  return { ...opened, state: app.state, client: new Client(app) }
}
const pass = CheckConfigSchema.parse({ id: 'positive', command: 'true', parser: 'exit_code', required: true })
const unknown = CheckConfigSchema.parse({ id: 'required-unknown', command: 'printf "# tests 0\\n# pass 0\\n# fail 0\\n"', parser: 'node_test', required: true })
const optionalUnknown = CheckConfigSchema.parse({ id: 'optional-unknown', command: 'printf "# tests 0\\n# pass 0\\n# fail 0\\n"', parser: 'node_test', required: false })

test('a receipt counts the checks as they went and judges nothing: the domain, a verify by hand, a checkpoint by hand', async () => {
  const { state, client, project, session, ws } = await fixture()
  const checkpoint = await state.workspaces.checkpoint(ws, null, 'to verify')
  const results = await runChecks(state.conn, state.workspaces, state.processes, project, checkpoint, { checks: [pass, unknown] })
  expect(results.map((r) => r.status)).toEqual(['pass', 'unknown'])
  expect(checkCounts(results, ['positive', 'required-unknown', 'never-ran'])).toEqual({ passed: 1, failed: 0, unknown: 1, not_run: 1 })
  const receipt = humanReceipt('run_x', { label: 'checks (by hand)', kind: 'verify', produced: {}, text: 't', finished_at: 'now', checks: checkCounts(results, ['positive', 'required-unknown']) })
  expect(receipt.mechanical.checks).toEqual({ passed: 1, failed: 0, unknown: 1, not_run: 0 })
  expect(Object.keys(receipt.mechanical)).not.toContain('verified')
  expect(Object.keys(receipt.mechanical)).not.toContain('verdict')
  // the same through the API: the human run's receipt carries the counts, an unknown stays unknown
  repo.updateProject(state.conn, project.id, { config: { checks: [pass, unknown] } })
  const result = await json(await client.post(`/api/workspaces/${ws.id}/verify`, { checkpoint_id: checkpoint.id }))
  expect((result.results as Record<string, unknown>[]).map((x) => x.status)).toEqual(['pass', 'unknown'])
  const run = repo.listRuns(state.conn, session.id).find((r) => r.label === 'checks (by hand)')!
  expect(mechanicalOf(run).checks).toEqual({ passed: 1, failed: 0, unknown: 1, not_run: 0 })
  expect(mechanicalOf(run).human_action).toBe('verify')
  // a person's checkpoint ran no check: zero counts, still no verdict
  const pinned = humanReceipt('run_y', { label: 'checkpoint (by hand)', kind: 'checkpoint', produced: {}, text: 't', finished_at: 'now' })
  expect(pinned.mechanical.checks).toEqual({ passed: 0, failed: 0, unknown: 0, not_run: 0 })
  expect(Object.keys(pinned.mechanical)).not.toContain('verified')
})

test('a run that ran none of the configured checks counts them as not run, never as failed or passed', async () => {
  const { state, client, project, session } = await fixture()
  repo.updateProject(state.conn, project.id, { config: { checks: [pass, unknown] } })
  const { setModel, scriptedModel, waitDone } = await import('./harness.ts')
  const { modelResponse, textPart } = await import('../src/llm/messages.ts')
  setModel(state, 'scripted:a', scriptedModel(() => modelResponse([textPart('answered without running anything')])))
  const run = await json(await client.post(`/api/sessions/${session.id}/chat`, { text: 'a plain question' }))
  const finished = await waitDone(state, run.id as string)
  expect(finished.status).toBe('done')
  expect(mechanicalOf(finished).checks).toEqual({ passed: 0, failed: 0, unknown: 0, not_run: 2 })
  expect(Object.keys(mechanicalOf(finished))).not.toContain('verdict')
})

test('a verified integration is written only when every required check passed; an optional one never blocks it', async () => {
  const { state, project, session, ws } = await fixture()
  const original = readFileSync(join(ws.path, 'calc.py'), 'utf8')
  const compose = async (checks: unknown[], content: string) => {
    repo.updateProject(state.conn, project.id, { config: { checks } })
    const child = await state.workspaces.createWorkspace(project, session.id, { kind: 'child', base_commit: ws.base_commit })
    writeFileSync(join(child.path, 'calc.py'), content)
    state.workspaces.noteWrite(child)
    const cp = await state.workspaces.checkpoint(child, null, 'a change')
    return integrate(state, ws, [cp.id], { run_id: null, note: 'QA', protected: [], verify: true })
  }
  const held = await compose([pass, unknown], 'SYNTHETIC_UNVERIFIED_INTEGRATION\n')
  expect(held.status).toBe('integrated')
  expect(held.checks.map((x) => x.status)).toEqual(['pass', 'unknown'])
  expect(held.applied_to_workspace).toBe(false)
  expect(held.reason as string).toContain('required-unknown unknown')
  expect(held.composed_checkpoint_id).toBeTruthy()                       // the composition stays as the deliverable
  expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toBe(original)
  const failed = await compose([{ ...pass, command: 'exit 1' }], 'SYNTHETIC_FAILING_INTEGRATION\n')
  expect(failed.applied_to_workspace).toBe(false)
  expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toBe(original)
  const landed = await compose([pass, optionalUnknown], 'SYNTHETIC_VERIFIED_INTEGRATION\n')
  expect(landed.checks.map((x) => x.status)).toEqual(['pass', 'unknown'])
  expect(landed.applied_to_workspace).toBe(true)
  expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toBe('SYNTHETIC_VERIFIED_INTEGRATION\n')
})

test('a required node check whose tests were all skipped did not pass: the composition stays out of the workspace', async () => {
  const { state, project, session, ws } = await fixture()
  const allSkipped = CheckConfigSchema.parse({ id: 'skipped-suite', required: true, parser: 'node_test',
    command: 'printf "TAP version 13\\nok 1 - a # SKIP\\n1..1\\n# tests 1\\n# pass 0\\n# fail 0\\n# skipped 1\\n"' })
  repo.updateProject(state.conn, project.id, { config: { checks: [allSkipped] } })
  const original = readFileSync(join(ws.path, 'calc.py'), 'utf8')
  const child = await state.workspaces.createWorkspace(project, session.id, { kind: 'child', base_commit: ws.base_commit })
  writeFileSync(join(child.path, 'calc.py'), 'SYNTHETIC_ALL_SKIPPED\n')
  state.workspaces.noteWrite(child)
  const cp = await state.workspaces.checkpoint(child, null, 'a change')
  const result = await integrate(state, ws, [cp.id], { run_id: null, note: 'QA', protected: [], verify: true })
  expect(result.checks.map((x) => x.status)).toEqual(['unknown'])
  expect(result.applied_to_workspace).toBe(false)
  expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toBe(original)
})

test('an integration asked not to verify, where required checks are configured, is kept as a checkpoint and not written', async () => {
  const { state, project, session, ws } = await fixture()
  const original = readFileSync(join(ws.path, 'calc.py'), 'utf8')
  const compose = async (checks: unknown[], content: string) => {
    repo.updateProject(state.conn, project.id, { config: { checks } })
    const child = await state.workspaces.createWorkspace(project, session.id, { kind: 'child', base_commit: ws.base_commit })
    writeFileSync(join(child.path, 'calc.py'), content)
    state.workspaces.noteWrite(child)
    const cp = await state.workspaces.checkpoint(child, null, 'a change')
    return integrate(state, ws, [cp.id], { run_id: null, note: 'QA', protected: [], verify: false })
  }
  const held = await compose([{ ...pass, command: 'exit 1' }], 'SYNTHETIC_UNCHECKED_INTEGRATION\n')
  expect(held.status).toBe('integrated')
  expect(held.checks).toEqual([])
  expect(held.applied_to_workspace).toBe(false)
  expect(held.reason as string).toContain('required checks not run')
  expect(held.reason as string).toContain('positive')
  expect(held.composed_checkpoint_id).toBeTruthy()
  expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toBe(original)
  // only optional checks configured: nothing required goes unrun, the composition is written
  const landed = await compose([optionalUnknown], 'SYNTHETIC_OPTIONAL_ONLY\n')
  expect(landed.applied_to_workspace).toBe(true)
  expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toBe('SYNTHETIC_OPTIONAL_ONLY\n')
})

test('a check log whose file is gone reads as unavailable evidence (410), not as an internal error', async () => {
  const { state, client, project, ws } = await fixture()
  const echo = CheckConfigSchema.parse({ id: 'echo', command: 'echo SYNTHETIC-LOG-LINE; true', parser: 'exit_code', required: true })
  repo.updateProject(state.conn, project.id, { config: { checks: [echo] } })
  const checkpoint = await state.workspaces.checkpoint(ws, null, 'to verify')
  const verified = await json(await client.post(`/api/workspaces/${ws.id}/verify`, { checkpoint_id: checkpoint.id }))
  const logId = String((verified.results as Record<string, unknown>[])[0]!.log_asset_id)
  expect(await (await client.get(`/api/assets/${logId}`)).text()).toContain('SYNTHETIC-LOG-LINE')
  rmSync(state.store.abspath(repo.getAsset(state.conn, logId)!.storage_path))
  const gone = await client.get(`/api/assets/${logId}`)
  expect(gone.status).toBe(410)
  expect(((await gone.json()) as { detail: string }).detail).toContain('evidence unavailable')
  expect((await client.get('/api/assets/a_nosuchasset')).status).toBe(404)
})
