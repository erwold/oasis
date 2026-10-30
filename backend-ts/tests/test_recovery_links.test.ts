/** What a restart leaves consistent: a run that continues a run cut off before its first request continues the
 *  conversation that one was continuing; a relay's turn inserted before the relay recorded it is recorded as an
 *  attempt of its step; a director event left "delivering" is delivered when a finished turn answered it, and back
 *  in the outbox otherwise. Nothing is run again. (The real SIGKILL windows are Codex's qa_v2_relay_crash_recovery.) */

import { afterEach, expect, test } from 'bun:test'
import * as repo from '../src/db/repo.ts'
import * as store from '../src/director/store.ts'
import { modelResponse, textPart, toolCallPart, toolReturns } from '../src/llm/messages.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

test('a run continuing a run with no history of its own gets the history that run was continuing', async () => {
  state = await appState({ sandbox: true })
  const { session, ws } = await openSession(state, buggyRepo())
  let n = 0
  setModel(state, 'scripted:a', scriptedModel(() => (n++ === 0 ? modelResponse([toolCallPart('write_file', { path: 'once.txt', content: 'ONCE' }, 'w1')]) : modelResponse([textPart('A done')]))))
  const a = await waitDone(state, (await state.runs.start(session, 'A writes once')).id)
  // the run a restart cut off before its first request: a row that continues A, with nothing of its own
  const cut = repo.insertRun(state.conn, { session_id: session.id, project_id: session.project_id, workspace_id: ws.id, model: 'scripted:a', model_config: {}, user_text: 'B', status: 'error', budget: {}, resumes_run_id: a.id })
  let seen: unknown[] = []
  setModel(state, 'scripted:a', scriptedModel((messages) => { seen = toolReturns(messages).map((p) => p.tool_call_id); return modelResponse([textPart('B read the record')]) }))
  const b = await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'B continues', { resumes_run_id: cut.id })).id)
  expect(b.status).toBe('done')
  expect(seen).toContain('w1')                                                       // A's recorded write, not repeated
})

test('a relay turn inserted before the relay recorded it is recorded as an attempt of its step at startup', async () => {
  state = await appState()
  const { session, ws } = await openSession(state, buggyRepo())
  const relay = repo.insertRelay(state.conn, {
    session_id: session.id, user_text: 'go', participants: [{ model: 'scripted:a', label: 'A', id: 'A' }, { model: 'scripted:b', label: 'B', id: 'B' }],
    steps: [{ seq: 0, round: 1, participant: 0, status: 'running', run_id: null, run_ids: [] }, { seq: 1, round: 1, participant: 1, status: 'queued', run_id: null, run_ids: [] }],
    rounds: 1, thinking: null, budget: {}, mentions: [], attachments: [], client_request_id: null,
  })
  const a = repo.insertRun(state.conn, { session_id: session.id, project_id: session.project_id, workspace_id: ws.id, model: 'scripted:a', model_config: {}, user_text: 'go', status: 'done', budget: {}, relay_id: relay.id, relay_step: 0 } as never)
  repo.updateRelay(state.conn, relay.id, { steps: [{ seq: 0, round: 1, participant: 0, status: 'running', run_id: a.id, run_ids: [a.id] }, { seq: 1, round: 1, participant: 1, status: 'queued', run_id: null, run_ids: [] }] })
  const b = repo.insertRun(state.conn, { session_id: session.id, project_id: session.project_id, workspace_id: ws.id, model: 'scripted:b', model_config: {}, user_text: 'note', status: 'error', budget: {}, relay_id: relay.id, relay_step: 1, resumes_run_id: a.id } as never)
  state.relays.reconcile()
  const after = repo.getRelay(state.conn, relay.id)!
  expect(after.steps[1]!.run_ids).toEqual([b.id])
  expect(after.steps[0]!.run_ids).toEqual([a.id])
  expect(after.status).toBe('interrupted')                                           // the person continues it
})

test('a director event left delivering is delivered when a finished turn answered it, back to pending otherwise', async () => {
  state = await appState()
  const { session } = await openSession(state, buggyRepo())
  const ds = store.insertDirectorSession(state.conn, { session_id: session.id, transport: 'native', model: 'scripted:b', label: 'D', config: {} })
  const event = (ref: string) => store.enqueueEvent(state!.conn, { director_session_id: ds.id, session_id: session.id, kind: 'run_finished', ref_id: ref, dedupe_key: `run_finished:${ref}`, cause_turn_id: null, payload: {} }).event
  const answered = event('run_a')
  const orphan = event('run_b')
  const turn = store.insertTurn(state.conn, { director_session_id: ds.id, session_id: session.id, kind: 'task_event', input: 'x', event_ids: [answered.id] })
  store.updateTurn(state.conn, turn.id, { status: 'done', output: 'read' })
  store.markEvents(state.conn, [answered.id, orphan.id], { status: 'delivering' })
  // the session is not driven afterwards: the repair itself is what is checked
  state.director.kick = () => {}
  await state.director.reconcile()
  expect(store.getEvent(state.conn, answered.id)).toMatchObject({ status: 'delivered', delivered_turn_id: turn.id })
  expect(store.getEvent(state.conn, orphan.id)!.status).toBe('pending')
  expect(store.listTurns(state.conn, ds.id)).toHaveLength(1)                         // nothing re-sent to the director
})
