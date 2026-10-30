/** What a director's start_run reaches through the API: one run per client key on every branch (a lost answer,
 *  a concurrent resend, a resend after the end, a changed payload under the same key), a follow-up that inherits the
 *  order it continues and only narrows it, a native director held to its session for the constraints it names,
 *  the thinking level and the images carried to the run's model, and a project configuration that only grows under
 *  two directors adding at once. Scripted models, temporary projects; no OS confinement claimed. */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CheckConfigSchema, type WorkOrder } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { namedThings } from '../src/director/scope.ts'
import { narrowOrder, OrderWidened } from '../src/agent/work_orders.ts'
import { isRequest, isUserPrompt, lastToolReturn, modelResponse, textPart, toolCallPart, type ModelMessage } from '../src/llm/messages.ts'
import { isImagePiece } from '../src/llm/images.ts'
import { ModelConfig } from '../src/config.ts'
import { createApp, type App } from '../src/main.ts'
import { Client, json } from './api_harness.ts'
import { buggyRepo, FAKE_FULL, PassthroughRuntime, scriptedModel, setModel, sleep, testConfig, testSettings, waitDone } from './harness.ts'

type R = Record<string, unknown>
let app: App | null = null
afterEach(async () => { await app?.close(); app = null })

async function setup() {
  const config = testConfig()
  config.models = config.models.map((m) => new ModelConfig({ ...m.dump(), capabilities: { images: true } } as never))
  app = await createApp(testSettings(), config, { probe: false, runtime: new PassthroughRuntime(), isolation: FAKE_FULL })
  const c = new Client(app)
  const st = app.state
  setModel(st, 'scripted:a', scriptedModel(() => modelResponse([textPart('done')]), 'qa-a', { supports_thinking: true }))
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'orders', model: 'scripted:a' }))
  return { c, st, project, session }
}
const runsOf = (st: App['state'], sessionId: unknown) => repo.listRuns(st.conn, String(sessionId))
const workspacesOf = (st: App['state'], projectId: unknown) => repo.listWorkspaces(st.conn, String(projectId)).length

test('a work order under a client key starts once: a resend after a lost answer, a concurrent resend and a resend after the end all get the first run', async () => {
  const { c, st, project, session } = await setup()
  let requests = 0
  let release = (): void => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  setModel(st, 'scripted:a', scriptedModel(async () => { requests += 1; await held; return modelResponse([textPart('once')]) }))
  const body = { work_order: { prompt: 'one task' }, client_request_id: 'qa-order-key-0001' }
  const before = workspacesOf(st, project.id)
  const [first, second] = await Promise.all([json(await c.post(`/api/sessions/${session.id}/work-orders`, body)), json(await c.post(`/api/sessions/${session.id}/work-orders`, body))])
  expect(second.id).toBe(first.id)
  const third = await json(await c.post(`/api/sessions/${session.id}/work-orders`, body))          // while it runs
  expect(third.id).toBe(first.id)
  release()
  await waitDone(st, String(first.id))
  // schema v25 (docs/multi-agent-core-implementation.md): the same key with another payload is refused (key_conflict)
  // instead of answering with the first request's run — a caller is never told another intent's run is its own
  const fourth = await c.post(`/api/sessions/${session.id}/work-orders`, { ...body, work_order: { prompt: 'another payload, same key' } })
  expect(fourth.status).toBe(409)
  expect((await fourth.json() as Record<string, unknown>).code).toBe('key_conflict')
  expect(runsOf(st, session.id).filter((r) => r.work_order !== null)).toHaveLength(1)
  expect(workspacesOf(st, project.id) - before).toBe(1)
  expect(requests).toBe(1)
  expect(repo.runForClientRequest(st.conn, String(session.id), 'qa-order-key-0001')?.id).toBe(String(first.id))
  // another key is another run; another session's same key is that session's own
  const other = await json(await c.post(`/api/sessions/${session.id}/work-orders`, { work_order: { prompt: 'one task' }, client_request_id: 'qa-order-key-0002' }))
  expect(other.id).not.toBe(first.id)
}, 20_000)

test('a follow-up under a client key starts once and never repeats the model request', async () => {
  const { c, st, session } = await setup()
  const seed = await json(await c.post(`/api/sessions/${session.id}/work-orders`, { work_order: { prompt: 'seed' } }))
  await waitDone(st, String(seed.id))
  let requests = 0
  setModel(st, 'scripted:a', scriptedModel(async () => { requests += 1; await sleep(100); return modelResponse([textPart('followed')]) }))
  const body = { text: 'follow up', client_request_id: 'qa-resume-key-0001' }
  const [a, b] = await Promise.all([json(await c.post(`/api/runs/${seed.id}/resume`, body)), json(await c.post(`/api/runs/${seed.id}/resume`, body))])
  expect(b.id).toBe(a.id)
  await waitDone(st, String(a.id))
  expect((await json(await c.post(`/api/runs/${seed.id}/resume`, body))).id).toBe(a.id)
  expect(requests).toBe(1)
  expect(runsOf(st, session.id)).toHaveLength(2)
}, 20_000)

const OLD: R = { read_only: true, tools: ['read_file', 'write_file'], scope: { read: ['README.md', 'calc.py'], write: ['README.md'] }, execution: { commands: false, network: false }, protected_paths: ['calc.py'] }

test('narrowOrder: a field left out is inherited, a narrower one applies, a wider one is refused as a whole', () => {
  const previous = { ...OLD, prompt: 'seed' }
  const narrowed = narrowOrder(previous, { scope: { read: ['README.md'] } })
  expect(narrowed).toMatchObject({ read_only: true, tools: ['read_file', 'write_file'], scope: { read: ['README.md'], write: ['README.md'] }, execution: { commands: false, network: false }, protected_paths: ['calc.py'] })
  expect(narrowOrder(previous, { tools: ['read_file'], protected_paths: ['README.md'] })).toMatchObject({ tools: ['read_file'], protected_paths: ['calc.py', 'README.md'] })
  expect(narrowOrder(previous, { scope: { write: [] } })).toMatchObject({ scope: { read: ['README.md', 'calc.py'], write: [] } })
  expect(narrowOrder({ ...previous, scope: { read: ['src/**'], write: null } }, { scope: { read: ['src/lib/*.py'], write: ['src/lib'] } })).toMatchObject({ scope: { read: ['src/lib/*.py'], write: ['src/lib'] } })
  for (const widening of [
    { read_only: false }, { tools: null }, { tools: ['read_file', 'bash'] }, { scope: { read: null } }, { scope: { read: ['README.md', 'test_calc.py'] } },
    { scope: { write: ['calc.py'] } }, { execution: { commands: true } }, { execution: { network: true } },
  ]) expect(() => narrowOrder(previous, widening)).toThrow(OrderWidened)
  // a glob's fixed prefix inside the old scope proves nothing: src/a/** reaches past src/?; a real subset narrows
  expect(() => narrowOrder({ ...previous, scope: { read: ['src/?'], write: null } }, { scope: { read: ['src/a/**'] } })).toThrow(OrderWidened)
  expect(narrowOrder({ ...previous, scope: { read: ['*.ts'], write: null } }, { scope: { read: ['foo*.ts'] } })).toMatchObject({ scope: { read: ['foo*.ts'] } })
  // protected paths and locks only grow; the goal and the label follow the patch
  expect(narrowOrder(previous, { protected_paths: [], goal: 'new goal', label: 'L' })).toMatchObject({ protected_paths: ['calc.py'], goal: 'new goal', label: 'L' })
})

test('a follow-up through the API inherits the order: a partial constraint narrows, an explicit widening is refused with no run', async () => {
  const { c, st, session } = await setup()
  const seed = await json(await c.post(`/api/sessions/${session.id}/work-orders`, { work_order: { ...OLD, prompt: 'seed' } }))
  await waitDone(st, String(seed.id))
  const workspace = repo.getWorkspace(st.conn, String(seed.workspace_id))!
  const before = readFileSync(join(workspace.path, 'README.md'), 'utf8')
  const seen: R = {}
  let step = 0
  setModel(st, 'scripted:a', scriptedModel((messages, info) => {
    seen.tools ??= info.function_tools.map((t) => t.name)
    if (step === 1) seen.read = lastToolReturn(messages, 'read_file')
    if (step === 2) seen.write = lastToolReturn(messages, 'write_file')
    if (step === 3) seen.calc = lastToolReturn(messages, 'read_file')
    const actions = [[toolCallPart('read_file', { path: 'README.md' }, '')], [toolCallPart('write_file', { path: 'README.md', content: 'X' }, '')], [toolCallPart('read_file', { path: 'calc.py' }, '')], [textPart('done')]]
    return modelResponse(actions[Math.min(step++, 3)]!)
  }))
  const narrowed = await json(await c.post(`/api/runs/${seed.id}/resume`, { text: 'follow up', work_order: { scope: { read: ['README.md'] } } }))
  await waitDone(st, String(narrowed.id))
  const order = repo.getRun(st.conn, String(narrowed.id))!.work_order as WorkOrder
  expect(order).toMatchObject({ read_only: true, tools: ['read_file', 'write_file'], scope: { read: ['README.md'], write: ['README.md'] }, execution: { commands: false, network: false }, protected_paths: ['calc.py'] })
  expect(seen.tools).toEqual(['read_file', 'write_file'])
  expect((seen.read as R).status).toBe('ok')
  expect((seen.write as R).status).toBe('refused_by_work_order')                     // still read-only
  expect((seen.calc as R).status).toBe('refused_by_work_order')                      // the narrowed scope
  expect(readFileSync(join(workspace.path, 'README.md'), 'utf8')).toBe(before)
  const runsBefore = runsOf(st, session.id).length
  const widened = await c.post(`/api/runs/${seed.id}/resume`, { text: 'more', work_order: { read_only: false, tools: null, execution: { commands: true, network: true }, protected_paths: [] } })
  expect(widened.status).toBe(400)
  expect((await widened.json() as R).detail).toContain('may narrow the order it continues, not widen it')
  expect(runsOf(st, session.id)).toHaveLength(runsBefore)
  expect(readFileSync(join(workspace.path, 'README.md'), 'utf8')).toBe(before)
}, 20_000)

test('a native director names things in constraints too: a checkpoint or a run of another session is refused before the harness is asked', () => {
  const named = namedThings({ session_id: 's1', separate: true, constraints: { workspace: { base: 'cp_other' }, resumes_run_id: 'run_other' }, work_order: { resumes_run_id: 'run_x' } })
  expect(named).toContainEqual(['checkpoint', 'cp_other', 'constraints.workspace.base'])
  expect(named).toContainEqual(['run', 'run_other', 'constraints.resumes_run_id'])
  expect(named).toContainEqual(['run', 'run_x', 'work_order.resumes_run_id'])
  expect(namedThings({ constraints: { workspace: { base: 'parent' } } })).toEqual([])
})

test('the thinking level of a separate run and the images of a follow-up reach the model', async () => {
  const { c, st, session } = await setup()
  const seen: R[] = []
  setModel(st, 'scripted:a', scriptedModel((messages: ModelMessage[], info) => {
    const images = messages.flatMap((m) => (isRequest(m) ? m.parts : [])).filter(isUserPrompt).flatMap((p) => (Array.isArray(p.content) ? p.content : [])).filter(isImagePiece)
    seen.push({ thinking: info.model_settings.thinking ?? null, images: images.map((i) => i.name) })
    return modelResponse([textPart('probe')])
  }, 'qa-a', { supports_thinking: true }))
  const separate = await json(await c.post(`/api/sessions/${session.id}/work-orders`, { work_order: { prompt: 'think' }, thinking: 'medium' }))
  await waitDone(st, String(separate.id))
  expect(seen.at(-1)!.thinking).toBe('medium')
  const png = readFileSync(join(import.meta.dir, 'fixtures/images/red-7x5.png'))
  const upload = new Request(`http://localhost/api/sessions/${session.id}/attachments?name=qa-red.png`, { method: 'POST', headers: { 'x-oasis-code-token': 'test-token', origin: 'http://localhost', 'content-type': 'image/png' }, body: png })
  const uploaded = await app!.app.request(upload)
  expect(uploaded.status).toBe(200)
  const asset = await uploaded.json() as R
  const followed = await json(await c.post(`/api/runs/${separate.id}/resume`, { text: 'look', attachments: [asset.asset_id] }))
  await waitDone(st, String(followed.id))
  expect(seen.at(-1)!.images).toEqual(['qa-red.png'])
  expect(repo.getRun(st.conn, String(followed.id))!.attachments.map((a) => a.name)).toEqual(['qa-red.png'])
}, 20_000)

test('configuration additions land together: an older add-only call cannot drop what another added meanwhile; a changed check is refused; the person still replaces', async () => {
  const { c, project } = await setup()
  const baseline = CheckConfigSchema.parse({ id: 'existing', command: 'true', required: true, timeout_s: 5 })
  await json(await c.put(`/api/projects/${project.id}/config`, { checks: [baseline], protected_paths: ['calc.py'] }))
  const additions = (body: R) => c.post(`/api/projects/${project.id}/config/additions`, body)
  // both callers read the same state; the second commits first
  const second = CheckConfigSchema.parse({ id: 'second', command: 'false', required: true, timeout_s: 5 })
  await json(await additions({ checks: [baseline, second], protected_paths: ['calc.py', 'second.txt'] }))
  const first = CheckConfigSchema.parse({ id: 'first', command: 'true', required: true, timeout_s: 5 })
  const stale = await json(await additions({ checks: [baseline, first], protected_paths: ['calc.py', 'first.txt'] }))
  const config = stale.config as { checks: R[]; protected_paths: string[] }
  expect(config.checks.map((x) => x.id)).toEqual(['existing', 'second', 'first'])
  expect(config.protected_paths).toEqual(['calc.py', 'second.txt', 'first.txt'])
  // an existing check under its id must be that check
  const changed = await additions({ checks: [{ ...baseline, command: 'false' }] })
  expect(changed.status).toBe(409)
  expect(((await json(await c.get(`/api/projects/${project.id}`))).config as R).checks).toHaveLength(3)
  // an invalid check is a 422; the same list again adds nothing
  expect((await additions({ checks: [{ id: 'x' }] })).status).toBe(422)
  const again = await json(await additions({ checks: [baseline, first], protected_paths: ['calc.py'] }))
  expect((again.config as R).checks).toHaveLength(3)
  // the person's own route replaces
  const human = await json(await c.put(`/api/projects/${project.id}/config`, { checks: [], protected_paths: [] }))
  expect((human.config as R).checks).toEqual([])
  expect((human.config as R).protected_paths).toEqual([])
})

test('a work order that continues an earlier run inherits its order: omitted fields stay, a widening is refused with no run', async () => {
  const { c, st, session } = await setup()
  const seed = await json(await c.post(`/api/sessions/${session.id}/work-orders`, { work_order: { ...OLD, prompt: 'seed' } }))
  await waitDone(st, String(seed.id))
  const inherited = await json(await c.post(`/api/sessions/${session.id}/work-orders`, { work_order: { prompt: 'continue', resumes_run_id: seed.id } }))
  await waitDone(st, String(inherited.id))
  expect(repo.getRun(st.conn, String(inherited.id))!.work_order).toMatchObject({ read_only: true, tools: ['read_file', 'write_file'], execution: { commands: false, network: false }, protected_paths: ['calc.py'] })
  const runs = runsOf(st, session.id).length
  const widened = await c.post(`/api/sessions/${session.id}/work-orders`, { work_order: { prompt: 'widen', resumes_run_id: seed.id, read_only: false } })
  expect(widened.status).toBe(400)
  expect(runsOf(st, session.id)).toHaveLength(runs)
}, 20_000)

test('a follow-up with images on a route that takes none is refused before anything starts', async () => {
  const { c, st, session } = await setup()
  const seed = await json(await c.post(`/api/sessions/${session.id}/work-orders`, { work_order: { prompt: 'seed' } }))
  await waitDone(st, String(seed.id))
  const png = readFileSync(join(import.meta.dir, 'fixtures/images/red-7x5.png'))
  const uploaded = await app!.app.request(new Request(`http://localhost/api/sessions/${session.id}/attachments?name=qa.png`, { method: 'POST', headers: { 'x-oasis-code-token': 'test-token', origin: 'http://localhost', 'content-type': 'image/png' }, body: png }))
  const asset = await uploaded.json() as R
  st.config.models = st.config.models.map((m) => (m.id === 'scripted:a' ? new ModelConfig({ ...m.dump(), capabilities: { images: false } } as never) : m))
  const runs = runsOf(st, session.id).length
  const refused = await c.post(`/api/runs/${seed.id}/resume`, { text: 'look', attachments: [asset.asset_id] })
  expect(refused.status).toBe(400)
  expect(((await refused.json()) as R).detail).toContain('is not configured to take images')
  expect(runsOf(st, session.id)).toHaveLength(runs)
}, 20_000)
