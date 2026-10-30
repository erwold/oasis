/** The Action Gate (adapted from oasis tests/test_action_gate.py, see NOTICE): effect metadata complete, gating
 *  semantics, run control append-only and scoped, a gated write persisted as a proposal (nothing written), the
 *  person-only decision executing through the tool's own write path, drift refused, a rejection reaching the next
 *  run, invalid calls never proposed. No coroutine is suspended — a gated run winds down and a fresh run reads the
 *  decision. */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { specs } from '../src/agent/tools/registry.ts'
import * as repo from '../src/db/repo.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart, userTexts, type ModelMessage } from '../src/llm/messages.ts'
import * as gate from '../src/policy/gate.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, waitDone, type AppState } from './harness.ts'
import { rec } from './tree_helpers.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

test('every tool has an effect and every gateable tool an executor', () => {
  for (const spec of specs()) expect(gate.EFFECT_TAGS.has(spec.effect)).toBe(true)
  const names = new Set(specs().map((s) => s.name))
  for (const name of gate.GATEABLE_TOOLS) expect(names.has(name)).toBe(true)
  expect(new Set(Object.keys(gate.ARG_MODELS))).toEqual(gate.GATEABLE_TOOLS)
  // a command no longer asks for the network: it follows the session's grant, so its only effect is execution
  expect(gate.effectsFor('bash')).toEqual(new Set(['isolated_code_execution']))
  expect(gate.effectsFor('edit_file')).toEqual(new Set(['workspace_write']))
})

test('should_gate semantics', () => {
  const pausedAny = { desired_state: 'pause', gate_effects: [] }
  const pausedExec = { desired_state: 'pause', gate_effects: ['isolated_code_execution'] }
  const running = { desired_state: 'run', gate_effects: [] }
  const write = new Set(['workspace_write']); const run = new Set(['isolated_code_execution']); const read = new Set(['read'])
  expect(gate.shouldGate(read, pausedAny)).toBe(false)              // observation is never gated
  expect(gate.shouldGate(write, pausedAny)).toBe(true)
  expect(gate.shouldGate(run, pausedAny)).toBe(true)
  expect(gate.shouldGate(run, pausedExec)).toBe(true)
  expect(gate.shouldGate(write, pausedExec)).toBe(false)
  expect(gate.shouldGate(write, running)).toBe(false)
})

test('run control is append-only and scoped', async () => {
  state = await appState()
  const { session } = await openSession(state, buggyRepo())
  expect(gate.effectiveControl(state.conn, session.id)).toEqual({ desired_state: 'run', gate_effects: [] })
  gate.recordRunControl(state.conn, session.id, 'pause', ['workspace_write'])
  expect(gate.effectiveControl(state.conn, session.id).desired_state).toBe('pause')
  gate.recordRunControl(state.conn, session.id, 'run')
  expect(gate.effectiveControl(state.conn, session.id).desired_state).toBe('run')
  gate.recordRunControl(state.conn, session.id, 'pause', ['isolated_code_execution'], 'run_parent01')
  expect(gate.effectiveControl(state.conn, session.id, 'run_other').desired_state).toBe('run')
  expect(gate.effectiveControl(state.conn, session.id, 'run_parent01').desired_state).toBe('pause')
  expect(gate.effectiveControl(state.conn, session.id, 'run_child', 'run_parent01').desired_state).toBe('pause')
  expect(() => gate.recordRunControl(state!.conn, session.id, 'pause', ['nonsense'])).toThrow('unknown gate effects')
  expect(repo.listGovernance(state.conn, session.id, gate.CONTROL)).toHaveLength(3)          // every entry kept
})

function fixingEdit() {
  return modelResponse([toolCallPart('edit_file', { path: 'calc.py', old_string: '    return a - b   # the bug: this should add', new_string: '    return a + b' }, '')])
}

test('a gated edit becomes a proposal and the person approves it', async () => {
  state = await appState()
  const { project, session, ws } = await openSession(state, buggyRepo())
  gate.recordRunControl(state.conn, session.id, 'pause', ['workspace_write'])
  const box: Record<string, unknown> = {}
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    if (!lastToolReturn(messages, 'read_file')) return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, '')])
    if (!lastToolReturn(messages, 'edit_file')) return fixingEdit()
    box.gated = lastToolReturn(messages, 'edit_file')
    return modelResponse([textPart('Proposed the fix; waiting for your approval.')])
  }))
  const run = await waitDone(state, (await state.runs.start(session, 'fix add()')).id)
  expect(run.status).toBe('done')
  expect(rec(box.gated).status).toBe('action_gated')
  const proposalId = rec(box.gated).proposal_asset_id as string
  expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toContain('return a - b')       // nothing was written
  const events = repo.listEvents(state.conn, run.id)
  expect(events.filter((e) => e.event === 'action_gated').map((e) => e.data.proposal_asset_id)).toEqual([proposalId])
  expect(rec(run.receipt.mechanical).gated_calls).toBe(1)
  const proposals = gate.listProposals(state.conn, project.id, session.id)
  expect(proposals.map((p) => p.status)).toEqual(['pending'])
  expect(proposals[0]!.tool_name).toBe('edit_file')
  const payload = gate.loadProposal(state.conn, state.store, proposalId)
  expect(rec(payload.validated_args).new_string).toBe('    return a + b')
  expect(payload.effects).toEqual(['workspace_write'])
  expect(new Set((payload.base_fingerprints as Record<string, unknown>[]).map((f) => f.kind))).toEqual(new Set(['workspace_tree', 'file']))

  await expect(gate.decideProposal(state, proposalId, 'approve', '', 'agent')).rejects.toThrow('only the person')
  const result = await gate.decideProposal(state, proposalId, 'approve', 'looks right')
  expect(result.status).toBe('approved')
  expect(rec(result.result).status).toBe('ok')
  expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toContain('return a + b')       // executed through the write path
  await expect(gate.decideProposal(state, proposalId, 'reject')).rejects.toThrow('already decided')
  expect(repo.listRuns(state.conn, session.id).some((r) => r.spawned_by === 'human_action' && r.label === 'approved edit_file')).toBe(true)

  // the continuation run reads the decision in its first message
  const seen: Record<string, string> = {}
  gate.recordRunControl(state.conn, session.id, 'run')
  setModel(state, 'scripted:a', scriptedModel((messages) => { seen.text = userTexts(messages).at(-1)!; return modelResponse([textPart('continued')]) }))
  await waitDone(state, (await state.runs.start(session, 'go on', { fresh: true })).id)
  expect(seen.text).toContain(proposalId)
  expect(seen.text).toMatch(new RegExp(`Proposal ${proposalId}: completed\\. Result: .*Do not repeat the call\\.`))
})

test('a rejected proposal reaches the next run and invalid calls are never proposed', async () => {
  state = await appState()
  const { project, session, ws } = await openSession(state, buggyRepo())
  gate.recordRunControl(state.conn, session.id, 'pause', [])
  setModel(state, 'scripted:a', scriptedModel((m) => (!lastToolReturn(m, 'write_file')
    ? modelResponse([toolCallPart('write_file', { path: 'NOTES.md', content: 'n\n' }, '')]) : modelResponse([textPart('waiting')]))))
  await waitDone(state, (await state.runs.start(session, 'add notes')).id)
  const proposalId = gate.listProposals(state.conn, project.id, session.id)[0]!.proposal_asset_id
  expect((await gate.decideProposal(state, proposalId, 'reject', 'no notes file — use the README')).status).toBe('rejected')
  const note = gate.proposalPromptNote(state.conn, project.id, session.id)
  expect(note).toContain('reject')
  expect(note).toContain('use the README')
  expect(note).toContain('Do not repeat it or use another tool for the same action')
  expect(existsSync(join(ws.path, 'NOTES.md'))).toBe(false)
  const ctx = { tool_call_id: 'tc_x', deps: { conn: state.conn, session, run_id: 'run_x', parent_run_id: null } } as unknown as gate.GateContext
  await expect(gate.checkActionGate(ctx, 'bash', { command: '   ' })).rejects.toThrow('empty')
  expect(gate.listProposals(state.conn, project.id, session.id)).toHaveLength(1)
})

test('approval refuses on base drift', async () => {
  state = await appState()
  const { project, session, ws } = await openSession(state, buggyRepo())
  gate.recordRunControl(state.conn, session.id, 'pause', [])
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    if (!lastToolReturn(messages, 'read_file')) return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, '')])
    if (!lastToolReturn(messages, 'edit_file')) return fixingEdit()
    return modelResponse([textPart('proposed')])
  }))
  await waitDone(state, (await state.runs.start(session, 'fix')).id)
  const proposalId = gate.listProposals(state.conn, project.id, session.id)[0]!.proposal_asset_id
  writeFileSync(join(ws.path, 'calc.py'), readFileSync(join(ws.path, 'calc.py'), 'utf8') + '\n# edited by hand\n')
  await expect(gate.decideProposal(state, proposalId, 'approve')).rejects.toThrow('drifted')
  expect((await gate.decideProposal(state, proposalId, 'reject', 'stale')).status).toBe('rejected')
})

test('an approved command runs through the runtime and a moved tree refuses it', async () => {
  state = await appState({ sandbox: true })
  const { project, session, ws } = await openSession(state, buggyRepo())
  gate.recordRunControl(state.conn, session.id, 'pause', ['isolated_code_execution'])
  setModel(state, 'scripted:a', scriptedModel((m) => (!lastToolReturn(m, 'bash')
    ? modelResponse([toolCallPart('bash', { command: 'python3 -m unittest 2>&1; echo DONE' }, '')]) : modelResponse([textPart('proposed the test run')]))))
  const run = await waitDone(state, (await state.runs.start(session, 'run the tests')).id)
  expect(repo.listExecutions(state.conn, { run_id: run.id })).toEqual([])
  const first = gate.listProposals(state.conn, project.id, session.id)[0]!.proposal_asset_id
  const result = await gate.decideProposal(state, first, 'approve')
  expect(rec(result.result).exit_code).toBe(0)
  expect(rec(result.result).execution_id).toBeTruthy()
  const executions = repo.listExecutions(state.conn, { run_id: run.id })
  expect(executions).toHaveLength(1)
  expect(executions[0]!.isolation.enforcement).toBe('full')
  // a second proposal, then the tree moves: the command was proposed against another state
  await waitDone(state, (await state.runs.start(session, 'again', { fresh: true })).id)
  const second = gate.listProposals(state.conn, project.id, session.id).filter((p) => p.status === 'pending')[0]!.proposal_asset_id
  writeFileSync(join(ws.path, 'extra.txt'), 'x\n')
  await expect(gate.decideProposal(state, second, 'approve')).rejects.toThrow('workspace moved')
})

/** A session paused before writes and a run that proposes the calc.py fix: the proposal, pending. */
async function proposedFix() {
  state = await appState()
  const { project, session, ws } = await openSession(state, buggyRepo())
  gate.recordRunControl(state.conn, session.id, 'pause', ['workspace_write'])
  const box: Record<string, unknown> = {}
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    if (!lastToolReturn(messages, 'read_file')) return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, '')])
    if (!lastToolReturn(messages, 'edit_file')) return fixingEdit()
    box.gated = lastToolReturn(messages, 'edit_file')
    return modelResponse([textPart('waiting')])
  }))
  await waitDone(state, (await state.runs.start(session, 'fix add()')).id)
  return { project, session, ws, proposalId: rec(box.gated).proposal_asset_id as string }
}

test('two approvals of one proposal at once: one executes, the other is refused, the patch lands once', async () => {
  const { project, session, ws, proposalId } = await proposedFix()
  const [a, b] = await Promise.allSettled([gate.decideProposal(state!, proposalId, 'approve'), gate.decideProposal(state!, proposalId, 'approve')])
  expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected'])
  expect(String((b.status === 'rejected' ? b : a as PromiseRejectedResult).reason)).toContain('being decided')
  expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toContain('return a + b')
  expect(repo.listRuns(state!.conn, session.id).filter((r) => r.label === 'approved edit_file')).toHaveLength(1)
  expect(gate.listProposals(state!.conn, project.id, session.id).map((p) => [p.status, p.decision?.outcome])).toEqual([['approve', 'done']])
})

test('an approval the harness stopped inside reads interrupted and is never executed again', async () => {
  const { project, session, ws, proposalId } = await proposedFix()
  // what a process that died inside the action leaves: the intent on record, no result
  repo.logGovernance(state!.conn, session.id, gate.DECISION, { actor: 'user', ref: proposalId, params: { decision: 'approve', reason: '', outcome: 'executing' } })
  expect(gate.listProposals(state!.conn, project.id, session.id).map((p) => p.status)).toEqual(['interrupted'])
  await expect(gate.decideProposal(state!, proposalId, 'approve')).rejects.toThrow('already decided (interrupted)')
  expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toContain('return a - b')
})

test('an approval whose action fails is recorded as failed, not left executing', async () => {
  const { project, session, proposalId } = await proposedFix()
  // the stored proposal no longer validates when it is executed (validated again at the moment of execution)
  const asset = repo.getAsset(state!.conn, proposalId)!
  const payload = JSON.parse(state!.store.read(asset.storage_path).toString('utf8')) as Record<string, unknown>
  writeFileSync(state!.store.abspath(asset.storage_path), JSON.stringify({ ...payload, validated_args: { ...(payload.validated_args as object), replace_all: 'bogus' } }))
  await expect(gate.decideProposal(state!, proposalId, 'approve')).rejects.toThrow('no longer validates')
  const [row] = gate.listProposals(state!.conn, project.id, session.id)
  expect([row!.status, row!.decision?.outcome, row!.decision?.result_status]).toEqual(['approve', 'failed', 'error'])
})
