/** A director's tool calls as the person reads them under its answer: a plan's steps in one line, the arguments it
 *  passed, what came back — a refusal's reason in full — and the turns recorded before this, completed once from the
 *  native director's own conversation. */

import { afterEach, expect, test } from 'bun:test'
import type { DirectorToolCall } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { backfillCallDetails } from '../src/director/call_details.ts'
import * as store from '../src/director/store.ts'
import { callOutcome, callSummary, keptArgs, MAX_KEPT_ARGS_CHARS } from '../src/director/tools.ts'
import { buggyRepo, domainState, type DomainState } from './harness.ts'

let state: DomainState | null = null
afterEach(async () => { if (state) await state.close(); state = null })

const BAD = { interaction_id: 'ix_1', then: 'stop', nodes: [{ id: 'a1', participant: 'A', workspace: 'own' }, { id: 'final', participant: 'A', depends_on: ['a1'], receives: ['a1', 'b1'], workspace: 'a1' }] }
const GOOD = { interaction_id: 'ix_1', then: 'stop', nodes: [{ id: 'a1', participant: 'A', workspace: 'own' }, { id: 'b1', participant: 'B', workspace: 'own' }] }
const REFUSAL = 'the harness refused (400): the plan is not sound: node final: receives b1, which it does not depend on; participant A cannot move between copies: its nodes name own, a1'

test("a plan's call reads as its steps; what came back is the refusal's whole reason, else one line; arguments are kept while small", () => {
  expect(callSummary('schedule', BAD)).toBe('2 steps: a1(A) final(A) · then stop')
  expect(callSummary('get_run', { run_id: 'run_1' })).toBe('run_id=run_1')
  expect(callOutcome({ status: 'error', error: REFUSAL }, true)).toBe(REFUSAL)
  expect(callOutcome({ status: 'refused', reason: 'destructive calls need the person' }, false)).toBe('destructive calls need the person')
  expect(callOutcome({ id: 'ix_1', status: 'running' }, false)).toBe('ix_1 · running')
  expect(callOutcome({ interaction_id: 'ix_1', status: 'running', revision: 1, nodes: [{}, {}, {}] }, false)).toBe('plan accepted for ix_1 · running · revision 1 · 3 steps')
  expect(keptArgs(GOOD)).toEqual(GOOD)
  expect(keptArgs({ text: 'x'.repeat(MAX_KEPT_ARGS_CHARS) })).toBeNull()
})

test("the turns recorded before are completed once from the native director's own conversation; a turn no longer in it keeps what it has", async () => {
  state = domainState()
  const project = await state.workspaces.importProject('calc', buggyRepo())
  const session = repo.createSession(state.conn, project.id, 'plan', 'scripted:a')
  const ds = store.insertDirectorSession(state.conn, { session_id: session.id, transport: 'native', model: 'scripted:b', label: 'Director', config: {} })
  const input = 'App note: Plan interaction ix_1.\nThe user addressed one request to 2 participants.'
  store.setDirectorHistory(state.conn, ds.id, JSON.stringify([
    { kind: 'request', parts: [{ part_kind: 'user-prompt', content: [`Session: ${session.id}.`, input] }] },
    { kind: 'response', parts: [{ part_kind: 'tool-call', tool_name: 'schedule', args: BAD, tool_call_id: 'c1' }] },
    { kind: 'request', parts: [{ part_kind: 'tool-return', tool_name: 'schedule', tool_call_id: 'c1', content: { status: 'error', error: REFUSAL } }] },
    { kind: 'response', parts: [{ part_kind: 'tool-call', tool_name: 'schedule', args: JSON.stringify(GOOD), tool_call_id: 'c2' }] },
    { kind: 'request', parts: [{ part_kind: 'tool-return', tool_name: 'schedule', tool_call_id: 'c2', content: { id: 'ix_1', status: 'running' } }] },
    { kind: 'response', parts: [{ part_kind: 'text', content: 'Planned.' }] },
  ]))
  const old = [{ name: 'schedule', summary: '', status: 'error' }, { name: 'schedule', summary: '', status: 'ok' }] as unknown as DirectorToolCall[]
  const planned = store.insertTurn(state.conn, { director_session_id: ds.id, session_id: session.id, kind: 'interaction', input })
  store.updateTurn(state.conn, planned.id, { status: 'done', tool_calls: old })
  const gone = store.insertTurn(state.conn, { director_session_id: ds.id, session_id: session.id, kind: 'user', input: 'words compacted away long ago' })
  store.updateTurn(state.conn, gone.id, { status: 'done', tool_calls: [{ name: 'get_run', summary: 'run_id=run_9', status: 'ok' }] as unknown as DirectorToolCall[] })

  expect(backfillCallDetails(state.conn)).toBe(1)
  const calls = store.getTurn(state.conn, planned.id)!.tool_calls
  expect(calls.map((c) => [c.name, c.status, c.summary])).toEqual([['schedule', 'error', '2 steps: a1(A) final(A) · then stop'], ['schedule', 'ok', '2 steps: a1(A) b1(B) · then stop']])   // the summary a plan's call has now
  expect(calls[0]!.args).toEqual(BAD)
  expect(calls[0]!.outcome).toBe(REFUSAL)
  expect(calls[1]!.args).toEqual(GOOD)                                                     // arguments the model sent as a JSON string, read as an object
  expect(calls[1]!.outcome).toBe('ix_1 · running')
  expect(store.getTurn(state.conn, gone.id)!.tool_calls).toEqual([{ name: 'get_run', summary: 'run_id=run_9', status: 'ok' }] as unknown as DirectorToolCall[])
  expect(backfillCallDetails(state.conn)).toBe(0)                                          // once: a completed turn is left alone
  // a turn completed before summaries were filled in: its arguments known, its summary empty — it gets the summary alone
  const halfway = store.insertTurn(state.conn, { director_session_id: ds.id, session_id: session.id, kind: 'interaction', input: 'App note: Plan interaction ix_2.' })
  store.updateTurn(state.conn, halfway.id, { status: 'done', tool_calls: [{ name: 'schedule', summary: '', status: 'ok', args: GOOD, outcome: 'plan accepted for ix_2' }] })
  expect(backfillCallDetails(state.conn)).toBe(1)
  expect(store.getTurn(state.conn, halfway.id)!.tool_calls).toEqual([{ name: 'schedule', summary: '2 steps: a1(A) b1(B) · then stop', status: 'ok', args: GOOD, outcome: 'plan accepted for ix_2' }])
})
