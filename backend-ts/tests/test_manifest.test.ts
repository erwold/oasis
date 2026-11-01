/** The run manifest: sealed before the first request, it names the exact tool schemas the model saw and every input
 *  the run was pointed at. */

import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { parseWorkOrder } from '../src/agent/work_orders.ts'
import * as repo from '../src/db/repo.ts'
import { modelResponse, textPart } from '../src/llm/messages.ts'
import * as gate from '../src/policy/gate.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, waitDone, type AppState } from './harness.ts'
import { rec } from './tree_helpers.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

test('the manifest seals the schemas the model saw and every input', async () => {
  state = await appState()
  const { project, session, ws } = await openSession(state, buggyRepo())
  repo.updateProject(state.conn, project.id, { config: { instructions: 'Run python3 -m unittest.' } })
  gate.recordLocks(state.conn, session.id, [{ path: 'test_calc.py', mode: 'read_only' }])
  const cp = await state.workspaces.checkpoint(ws, null, 'a base')
  setModel(state, 'scripted:b', scriptedModel(() => modelResponse([textPart('ok')])))
  const order = parseWorkOrder({ prompt: 'look at add()', model: 'scripted:b', tools: ['read_file', 'bash'], context_refs: [cp.id, 'run_nope'], workspace: { base: cp.id } })
  const childWs = await state.workspaces.createWorkspace(project, session.id, { kind: 'child', base_commit: cp.commit_sha })
  const run = await waitDone(state, (await state.runs.start(session, order.prompt, { spawned_by: 'human', work_order: order, workspace_id: childWs.id })).id)
  const m = run.manifest
  expect(m.version).toBe('run_manifest.v4')
  expect(m.request_sha256).toBe(sha('look at add()'))
  expect((m.instructions_sha256 as string).length).toBe(64)
  expect((m.prompt_sha256 as string).length).toBe(64)
  const record = repo.listModelRequests(state.conn, run.id)[0]!
  expect((m.tool_schema_sha256 as string).slice(0, 16)).toBe(record.tool_schema_sha256!)         // the manifest seals the schemas the request carried
  const inputs = new Map((m.inputs as Record<string, unknown>[]).map((i) => [`${i.kind}:${i.id ?? i.source}`, i]))
  expect(inputs.get(`checkpoint:${cp.id}`)!.commit).toBe(cp.commit_sha)
  expect(inputs.get('reference:run_nope')!.resolved).toBe(false)
  expect(inputs.get("instruction_file:project settings")!.sha256).toBe(sha('Run python3 -m unittest.'))
  expect(m.locks).toEqual([{ path: 'test_calc.py', symbol: null, mode: 'read_only', label: null }])
  expect(rec(m.host).git as string).toStartWith('git version')
  expect(rec(m.host).bun).toBeTruthy()
  expect(rec(m.build).api_version).toBe('code-v1')
  expect(m.api_version).toBe('code-v1')
  expect(m.schema_version_db).toBe(38)                                            // v29: the sessions' task and roots; v28: the sessions' access and the access caps; v27: the sessions' latest activity; v26: the session cursor; v25: the collaboration model; v21: the UI surfaces and their action receipts; v22: the UI tasks and input requests; v23: session-scoped surfaces, the publication journal; v30: SSH targets; v31: SSH connect intent; v32: CNY costs, v33 read-path indexes
  expect(JSON.stringify(m.model)).not.toContain('api_key')
  // the thread's next run sees more tools (the order named two): another fingerprint, again equal to its requests'
  setModel(state, 'scripted:a', scriptedModel(() => modelResponse([textPart('hi')])))
  const thread = await waitDone(state, (await state.runs.start(session, 'hello')).id)
  expect(thread.manifest.tool_schema_sha256).not.toBe(m.tool_schema_sha256)
  expect((thread.manifest.tool_schema_sha256 as string).slice(0, 16)).toBe(repo.listModelRequests(state.conn, thread.id)[0]!.tool_schema_sha256!)
})
