/** The work-order layer, offline (adapted from oasis tests/test_work_orders.py, see NOTICE): the order is validated,
 *  it bounds what a run may call (tools seen, read-only, scope, execution policy — refused before the workspace, the
 *  sandbox or the session gate), the runner measures the receipt's mechanical side from the run's own records, and
 *  budgets stop a run with a closing turn that has no tool. */

import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkCounts, inScope, judgeAcceptance, mechanical, orderRefusal, parseWorkOrder, WorkOrderInvalid,
  type WorkOrder } from '../src/agent/work_orders.ts'
import * as repo from '../src/db/repo.ts'
import { isRequest, isUserPrompt, lastToolReturn, modelResponse, textPart, toolCallPart, userText, userTexts, type ModelMessage } from '../src/llm/messages.ts'
import type { Script } from '../src/llm/scripted.ts'
import { appState, buggyRepo, closeState, collectEvents, openSession, scriptedModel, setModel, sleep, type AppState } from './harness.ts'
import { CHILD_MODEL, rec, toolNames } from './tree_helpers.ts'
import type { Session, Workspace } from '@oasis-code/contract'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

const wo = (raw: Record<string, unknown>) => parseWorkOrder(raw)

test('the order validates its boundaries', () => {
  const order = wo({ prompt: 'count', tools: ['read_file', 'bash'], scope: { write: ['src/**'] } })
  expect(order.model).toBeNull()
  expect(order.version).toBe(3)
  expect(order.read_only).toBe(false)
  expect(order.workspace.base).toBe('parent')
  expect(() => wo({ prompt: '' })).toThrow(WorkOrderInvalid)
  expect(() => wo({ prompt: 'x', tools: ['no_such_tool'] })).toThrow(WorkOrderInvalid)
  expect(() => wo({ prompt: 'x', acceptance: [{ metric: 'checks_failed', op: '~', value: 0 }] })).toThrow(WorkOrderInvalid)
  expect(() => wo({ prompt: 'x', budget: { tool_calls: 0 } })).toThrow(WorkOrderInvalid)
})

test('scope globs', () => {
  expect(inScope('src/a/b.py', ['src/**'])).toBe(true)
  expect(inScope('src/a/b.py', ['src'])).toBe(true)
  expect(inScope('src', ['src/**'])).toBe(true)
  expect(inScope('tests/x.py', ['src/**'])).toBe(false)
  expect(inScope('srcx/a.py', ['src'])).toBe(false)
  expect(inScope('README.md', ['*.md'])).toBe(true)
  expect(inScope('docs/a.md', ['README.md'])).toBe(false)
  expect(inScope('.', ['**'])).toBe(true)
  expect(inScope('.', ['src/**'])).toBe(false)
})

test('order refusal rules', () => {
  const order = wo({ prompt: 'x', tools: ['read_file', 'edit_file', 'bash'], scope: { read: ['src/**', 'README.md'], write: ['src/**'] } })
  expect(orderRefusal(null, 'edit_file', 'workspace_write', { path: 'anything' })).toBeNull()
  expect(orderRefusal(order, 'read_file', 'read', { path: 'src/a.py' })).toBeNull()
  expect(orderRefusal(order, 'read_file', 'read', { path: 'tests/a.py' })).toContain('readable paths')
  expect(orderRefusal(order, 'edit_file', 'workspace_write', { path: 'src/a.py' })).toBeNull()
  expect(orderRefusal(order, 'edit_file', 'workspace_write', { path: 'README.md' })).toContain('writable paths')
  expect(orderRefusal(order, 'web_search', 'network')).toContain('not available in this run')
  const ro = wo({ prompt: 'x', read_only: true })
  expect(orderRefusal(ro, 'edit_file', 'workspace_write', { path: 'a' })).toContain('read-only')
  expect(orderRefusal(ro, 'bash', 'isolated_code_execution')).toBeNull()               // commands stay: the worktree is the child's own
  expect(orderRefusal(wo({ prompt: 'x', execution: { commands: false } }), 'bash', 'isolated_code_execution')).toContain('no command')
  // the network is on by default; an order that withholds it refuses the web tools (its commands run offline)
  expect(orderRefusal(wo({ prompt: 'x', execution: { network: false } }), 'web_search', 'network')).toContain('Network access is off')
  expect(orderRefusal(wo({ prompt: 'x', execution: { network: false } }), 'bash', 'isolated_code_execution')).toBeNull()
  expect(orderRefusal(wo({ prompt: 'x' }), 'web_search', 'network')).toBeNull()
})

test('acceptance is judged only on what the runner measured', () => {
  const order = wo({ prompt: 'x', acceptance: [
    { metric: 'checks_failed', op: '==', value: 0 }, { metric: 'blocked_calls', op: '<=', value: 0 }, { metric: 'coverage_pct', op: '>=', value: 90 },
  ] })
  expect(judgeAcceptance(order, { checks_failed: 0, blocked_calls: 2, tool_calls: 3 })).toEqual({ 'checks_failed == 0': 'pass', 'blocked_calls <= 0': 'fail', 'coverage_pct >= 90': 'unknown' })
  expect(judgeAcceptance(order, { checks_failed: null })['checks_failed == 0']).toBe('unknown')
  // two clauses on one metric are two lines, each judged, in either order: a pass never overwrites a fail
  const twice = [{ metric: 'files_changed', op: '>=', value: 1 }, { metric: 'files_changed', op: '<=', value: 3 }]
  const forward = judgeAcceptance(wo({ prompt: 'x', acceptance: twice }), { files_changed: 0 })
  const reverse = judgeAcceptance(wo({ prompt: 'x', acceptance: [...twice].reverse() }), { files_changed: 0 })
  expect(forward).toEqual({ 'files_changed >= 1': 'fail', 'files_changed <= 3': 'pass' })
  expect(reverse).toEqual(forward)
})

test('the checks are counted as they went, the configured ones that did not run among them; nothing is a verdict on the task', () => {
  const ran = [{ status: 'pass', check_id: 'unit' }, { status: 'fail', check_id: 'lint' }, { status: 'unknown', check_id: 'e2e' }]
  expect(checkCounts(ran, ['unit', 'lint', 'e2e', 'types'])).toEqual({ passed: 1, failed: 1, unknown: 1, not_run: 1 })
  expect(checkCounts([], ['unit'])).toEqual({ passed: 0, failed: 0, unknown: 0, not_run: 1 })
  expect(checkCounts(ran)).toEqual({ passed: 1, failed: 1, unknown: 1, not_run: 0 })
  const m = mechanical({ checks: checkCounts(ran, ['unit', 'lint', 'e2e', 'types']), acceptance: { 'files_changed >= 1': 'pass' } })
  expect(Object.keys(m)).not.toContain('verdict')
  expect(Object.keys(m)).not.toContain('verified')
  expect(m.checks.not_run).toBe(1)
})

// -- the runner under an order -----------------------------------------------------------

/** A person dispatches an order (the API's path, without HTTP): a child worktree from the session workspace's pinned
 *  state, a run under the validated order. */
async function startOrder(st: AppState, session: Session, ws: Workspace, order: Record<string, unknown>, script: Script, model = CHILD_MODEL) {
  setModel(st, model, scriptedModel(script))
  const project = repo.getProject(st.conn, session.project_id)!
  const validated: WorkOrder = parseWorkOrder({ ...order, model })
  const base = await st.workspaces.checkpoint(ws, null, 'base')
  const childWs = await st.workspaces.createWorkspace(project, session.id, { kind: 'child', base_commit: base.commit_sha })
  const run = await st.runs.start(session, validated.prompt, { spawned_by: 'human', label: validated.label, work_order: validated, workspace_id: childWs.id })
  return { run, childWs }
}

test("a run under an order sees the order's tools and its boundaries", async () => {
  state = await appState()
  const seen: Record<string, unknown> = {}
  const { session, ws } = await openSession(state, buggyRepo())
  const order = { label: '盘点', prompt: 'count things', tools: ['read_file', 'bash'], read_only: true, goal: 'an inventory', deliverables: ['numbers only'],
    budget: { tool_calls: 5 }, context_refs: ['calc.py'] }
  const { run, childWs } = await startOrder(state, session, ws, order, (messages, info) => { seen.tools = toolNames(info); seen.prompt = userTexts(messages)[0]; return modelResponse([textPart('looked')]) })
  const events = await collectEvents(state, run.id)
  expect(seen.tools).toEqual(['bash', 'read_file'])
  const prompt = seen.prompt as string
  for (const s of ['Writable paths: none in the working folder (this run is read-only', 'Goal: an inventory', 'Deliverables: numbers only', 'Context in this project: calc.py', 'Run limit: tool_calls 5.']) expect(prompt).toContain(s)
  expect(prompt).not.toMatch(/WORK ORDER|work order|User request:/)                   // no preface, no heading: the task as the person's words and its lines
  expect(prompt.trimEnd()).toEndWith('count things\nGoal: an inventory\nDeliverables: numbers only\nContext in this project: calc.py')
  const started = events.find((e) => e.event === 'run_started')!.data
  expect(started.tools).toEqual(['bash', 'read_file'])
  expect(rec(started.work_order).label).toBe('盘点')
  const row = repo.getRun(state.conn, run.id)!
  expect(row.work_order!.read_only).toBe(true)
  expect(row.work_order!.tools).toEqual(['read_file', 'bash'])
  expect(row.workspace_id).toBe(childWs.id)
  expect(row.budget.tool_calls).toBe(5)
  expect(rec(row.receipt.mechanical).checks).toEqual({ passed: 0, failed: 0, unknown: 0, not_run: 0 })
  expect('self_report' in row.receipt).toBe(false)
  // measured against the run's own baseline (the tree it was let in on), the integration base beside it
  expect(rec(row.receipt.mechanical).diff).toEqual({ files: 0, added: 0, removed: 0, tree_sha: rec(row.receipt.produced).tree_sha, base_commit: childWs.base_commit, base_tree_sha: expect.any(String), attribution: 'exact' })
  expect(row.manifest.tools).toEqual(['bash', 'read_file'])
  expect(rec(row.manifest.work_order).label).toBe('盘点')
  expect(repo.latestRunOfSession(state.conn, session.id)).toBeNull()             // never the thread
})

test('the order refuses calls before anything runs', async () => {
  state = await appState()
  let n = 0
  const box: Record<string, Record<string, unknown>> = {}
  const script: Script = (messages) => {
    n += 1
    if (n === 1) return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, '')])
    if (n === 2) { box.read = rec(lastToolReturn(messages, 'read_file')); return modelResponse([toolCallPart('edit_file', { path: 'calc.py', old_string: 'a - b', new_string: 'a + b' }, '')]) }
    if (n === 3) { box.patch = rec(lastToolReturn(messages, 'edit_file')); return modelResponse([toolCallPart('bash', { command: 'echo hi' }, '')]) }
    if (n === 4) { box.command = rec(lastToolReturn(messages, 'bash')); return modelResponse([toolCallPart('read_file', { path: 'test_calc.py' }, '')]) }
    if (n === 5) box.outside = rec(lastToolReturn(messages, 'read_file'))
    return modelResponse([textPart('stopped by the order')])
  }
  const { session, ws } = await openSession(state, buggyRepo())
  const { run, childWs } = await startOrder(state, session, ws, { label: 'narrow', prompt: 'try things', read_only: true, execution: { commands: false }, scope: { read: ['calc.py'] } }, script)
  const events = await collectEvents(state, run.id)
  expect(box.read!.status).toBe('ok')
  expect(box.patch!.status).toBe('refused_by_work_order')
  expect(box.patch!.reason as string).toContain('read-only')
  expect(box.command!.status).toBe('refused_by_work_order')
  expect(box.command!.reason as string).toContain('no command')
  expect(box.outside!.status).toBe('refused_by_work_order')
  expect(box.outside!.reason as string).toContain('readable paths')
  const refusals = events.filter((e) => e.event === 'tool_result' && e.data.status === 'refused_by_work_order')
  expect(refusals).toHaveLength(3)
  expect(refusals.every((e) => e.data.tool_call_id)).toBe(true)
  expect(readFileSync(join(childWs.path, 'calc.py'), 'utf8')).toContain('return a - b')       // nothing reached the worktree
  expect(repo.listExecutions(state.conn, { run_id: run.id })).toEqual([])                     // nothing reached the sandbox
  expect(events.filter((e) => e.event === 'action_gated')).toEqual([])                        // nothing reached the session gate
  const receipt = repo.getRun(state.conn, run.id)!.receipt
  expect(rec(receipt.mechanical).blocked_calls).toBe(3)
  expect(rec(receipt.mechanical).refused_calls).toBe(3)
  expect(Object.keys(rec(receipt.mechanical))).not.toContain('verdict')
})

test('at the budget the run gets a closing turn that keeps the tools described and runs none', async () => {
  state = await appState()
  const seen: string[][] = []
  const notes: string[] = []
  const script: Script = (messages, info) => {
    seen.push(toolNames(info))
    const last = messages[messages.length - 1]!
    if (isRequest(last)) for (const part of last.parts) if (isUserPrompt(part) && userText(part).includes('This run reached')) notes.push(userText(part))
    if (seen.length <= 2) return modelResponse([toolCallPart('read_file', { path: 'README.md' }, '')])
    return modelResponse([textPart('two files read; the budget is spent')])
  }
  const { session, ws } = await openSession(state, buggyRepo())
  const { run } = await startOrder(state, session, ws, { label: 'spendthrift', prompt: 'look forever', budget: { tool_calls: 2 } }, script)
  const events = await collectEvents(state, run.id)
  expect(events.filter((e) => e.event === 'budget_closing')).toHaveLength(1)
  expect(seen[2]).toEqual(seen[0])                                       // the closing turn carries the same tool descriptions (the cache prefix)
  expect(notes.length).toBeGreaterThan(0)
  expect(notes[0]).toContain('tool_calls 2 of 2')
  const finished = events.at(-1)!.data
  expect(finished.status).toBe('done')
  expect(rec(finished.receipt).status).toBe('done')
  expect(rec(finished.receipt).final_text).toBe('two files read; the budget is spent')
  expect(rec(rec(rec(finished.receipt).mechanical).budget).exceeded).toBeNull()
  expect(rec(rec(finished.receipt).mechanical).budget_reached).toBe('tool_calls 2 of 2')
  const row = repo.getRun(state.conn, run.id)!
  expect(row.status).toBe('done')
  expect(row.usage.tool_calls).toBe(2)
})

test('a closing turn that still calls a tool ends as budget_exceeded', async () => {
  state = await appState()
  const { session, ws } = await openSession(state, buggyRepo())
  const { run } = await startOrder(state, session, ws, { label: 'loop', prompt: 'never stop', budget: { tool_calls: 2 } },
    () => modelResponse([toolCallPart('read_file', { path: 'README.md' }, '')]))
  const events = await collectEvents(state, run.id)
  expect(events.at(-1)!.data.status).toBe('error')
  const row = repo.getRun(state.conn, run.id)!
  expect(row.error!).toStartWith('budget_exceeded: tool_calls 2 of 2')
  expect(row.receipt.status).toBe('budget_exceeded')
  expect(row.receipt.status).toBe('budget_exceeded')
})

test('the wall-clock budget stops an order run', async () => {
  state = await appState()
  const { session, ws } = await openSession(state, buggyRepo())
  const { run } = await startOrder(state, session, ws, { label: 'slow', prompt: 'take forever', budget: { wall_clock_s: 1 } }, async () => { await sleep(200); return modelResponse([toolCallPart('read_file', { path: 'README.md' }, '')]) })
  const events = await collectEvents(state, run.id)
  expect(rec(events.at(-1)!.data.receipt).status).toBe('budget_exceeded')
  expect(repo.getRun(state.conn, run.id)!.error).toContain('wall_clock_s')
})

test('measured acceptance makes an ok receipt', async () => {
  state = await appState()
  let n = 0
  const script: Script = (messages) => {
    n += 1
    if (n === 1) return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, '')])
    if (n === 2) return modelResponse([toolCallPart('edit_file', { path: 'calc.py', old_string: '    return a - b   # the bug: this should add', new_string: '    return a + b' }, '')])
    return modelResponse([textPart('fixed')])
  }
  const { session, ws } = await openSession(state, buggyRepo())
  const order: Record<string, unknown> = { label: 'fix', prompt: 'fix add()', acceptance: [
    { metric: 'blocked_calls', op: '==', value: 0 }, { metric: 'files_changed', op: '==', value: 1 }, { metric: 'checkpoints', op: '>=', value: 1 }, { metric: 'coverage_pct', op: '>=', value: 90 },
  ] }
  const { run, childWs } = await startOrder(state, session, ws, order, script)
  const events = await collectEvents(state, run.id)
  const receipt = rec(events.at(-1)!.data.receipt)
  expect(rec(receipt.mechanical).acceptance).toEqual({ 'blocked_calls == 0': 'pass', 'files_changed == 1': 'pass', 'checkpoints >= 1': 'pass', 'coverage_pct >= 90': 'unknown' })
  expect(Object.keys(rec(receipt.mechanical))).not.toContain('verdict')     // the receipt measures; it does not judge the task
  expect(rec(receipt.mechanical).tool_calls).toBe(2)
  expect(rec(rec(receipt.mechanical).diff).files).toBe(1)
  expect(rec(rec(receipt.mechanical).diff).added).toBe(1)
  expect(rec(receipt.produced).files_changed).toEqual(['calc.py'])
  expect((rec(receipt.produced).checkpoints as string[]).length).toBe(1)
  expect(rec(receipt.produced).final_checkpoint_id).toBe((rec(receipt.produced).checkpoints as string[])[0])
  expect(receipt.final_text).toBe('fixed')
  expect(receipt.status).toBe('done')
  expect(readFileSync(join(childWs.path, 'calc.py'), 'utf8')).toContain('return a + b')
  expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toContain('return a - b')
  // the same order without the unmeasurable line: every line measured and passing
  order.acceptance = (order.acceptance as unknown[]).slice(0, 3)
  n = 0
  const second = await startOrder(state, session, ws, order, script)
  const events2 = await collectEvents(state, second.run.id)
  expect(rec(rec(events2.at(-1)!.data.receipt).mechanical).acceptance).toEqual({ 'blocked_calls == 0': 'pass', 'files_changed == 1': 'pass', 'checkpoints >= 1': 'pass' })
})
