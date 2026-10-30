import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DirectorNote, DirectorSession, DirectorTurn } from '@oasis-code/contract'
import { bridgeConfig, repeatedQuestions, directorStateLine, eventRunIds, openTurns, targetOf, turnQuestion, turnStatusLine, callRejected, outcomeReasons, planOf, directorTarget, turnAttachments, wordsSaidToDirector } from '../src/state/director.ts'

const ds = (extra: Partial<DirectorSession> = {}): DirectorSession => ({
  id: 'dir_1', session_id: 's', transport: 'native', model: 'openai:gpt-6-astra', label: 'GPT-6 Astra', state: 'idle', config: {}, external_ref: null,
  current_turn_id: null, last_error: null, history_turns: 0, created_at: 't', updated_at: 't', closed_at: null, ...extra,
})
const turn = (id: string, status: DirectorTurn['status'], extra: Partial<DirectorTurn> = {}): DirectorTurn => ({
  id, director_session_id: 'dir_1', session_id: 's', seq: 1, kind: 'user', input: 'hi', output: '', status, model: '', usage: {}, tool_calls: [], event_ids: [],
  envelope: null, dispatched_interaction_ids: [], dispatched_run_ids: [], note_id: null, error: null, external_ref: null, created_at: 't', started_at: null, finished_at: null, ...extra,
})
const note = (id: string, turn_id: string | null): DirectorNote => ({ id, session_id: 's', source: 'oasis-code', model: 'x', question: 'q', answer: 'a', turn_id, created_at: 't' })

test('the header line follows the state, naming the tool the director runs and the runs it waits for', () => {
  assert.equal(directorStateLine(null, null), null)
  assert.equal(directorStateLine(ds(), null), 'director: idle')
  assert.equal(directorStateLine(ds({ last_error: 'the model is down' }), null), 'director: idle (last turn failed: the model is down)')
  assert.equal(directorStateLine(ds({ state: 'generating' }), null), 'director: thinking…')
  assert.equal(directorStateLine(ds({ state: 'generating' }), { tool_calls: [{ name: 'get_run', summary: '', status: 'ok' }, { name: 'send_message', summary: '', status: 'running' }] }), 'director: send_message…')
  assert.equal(directorStateLine(ds({ state: 'waiting_for_tasks' }), null, 2), 'director: waiting for 2 runs')
  assert.equal(directorStateLine(ds({ state: 'waiting_for_tasks' }), null, 1), 'director: waiting for 1 run')
  assert.equal(directorStateLine(ds({ state: 'needs_login' }), null), 'director: sign in to ChatGPT on its card')
  assert.equal(directorStateLine(ds({ state: 'paused' }), null), 'director: paused')
  assert.equal(directorStateLine(ds({ state: 'closed' }), null), null)
})

test('the thread shows the turns no note closed: queued, live, failed — never the done ones', () => {
  const turns = [turn('t1', 'done', { note_id: 'n1' }), turn('t2', 'generating'), turn('t3', 'queued'), turn('t4', 'error', { error: 'boom' }), turn('t5', 'done')]
  assert.deepEqual(openTurns(turns, [note('n1', 't1'), note('n5', 't5')]).map((t) => t.id), ['t2', 't3', 't4'])
  assert.equal(turnStatusLine(turn('t', 'queued'), 'native'), 'queued — the director takes it next')
  assert.equal(turnStatusLine(turn('t', 'generating'), 'native'), 'the director is thinking…')
  assert.equal(turnStatusLine(turn('t', 'generating'), 'bridge'), 'sending to the director…')
  assert.equal(turnStatusLine(turn('t', 'awaiting_answer'), 'bridge'), 'sent to ChatGPT — waiting for its answer')
  assert.equal(turnStatusLine(turn('t', 'awaiting_answer'), 'native'), 'sent — waiting for the answer through the connector')
  assert.equal(turnStatusLine(turn('t', 'error', { error: 'boom' }), 'native'), 'failed: boom')
  assert.equal(turnStatusLine(turn('t', 'cancelled'), 'native'), 'cancelled')
})

test("a task-event turn's question is the event's head lines, a person's turn their words", () => {
  assert.equal(turnQuestion(turn('t', 'queued', { kind: 'user', input: 'make add() add' })), 'make add() add')
  assert.equal(turnQuestion(turn('t', 'queued', { kind: 'interaction', input: 'App note: Plan interaction ix_1.\nThe user addressed…' })), "oasis-code asks for the interaction's plan")
  assert.equal(turnQuestion(turn('t', 'queued', { kind: 'interaction', input: 'App note: Interaction ix_1: every step of the plan ended.\n- step a1' })), 'oasis-code asks what comes next in the interaction')
  const input = '[oasis-code task event — a message from the harness, not a new instruction from the person]\nsession: s\n2 runs finished since your last turn:\n- run run_1 "fix" on m — started by your instruction (turn t1)\n  status: done; checks 1 passed / 0 failed / 0 unknown / 0 not run\n- run run_2 on m — started by the person\n  status: error\n\nRead each receipt…'
  assert.equal(turnQuestion(turn('t', 'queued', { kind: 'task_event', input })), 'oasis-code task event\n2 runs finished since your last turn:\n- run run_1 "fix" on m — started by your instruction (turn t1)\n- run run_2 on m — started by the person')
})

test('the bridge config', () => {
  assert.deepEqual(bridgeConfig({ url: 'http://127.0.0.1:8323', token: 'x' }), { bridge_url: 'http://127.0.0.1:8323', bridge_token: 'x' })
  assert.deepEqual(bridgeConfig({ url: 'http://127.0.0.1:8323' }), { bridge_url: 'http://127.0.0.1:8323' })
})

test('a note repeating the question of the note before it shows only its answer', () => {
  const n = (id: string, question: string, at: string) => ({ id, question, created_at: `2026-09-27T00:00:${at}Z` })
  assert.deepEqual([...repeatedQuestions([n('a', 'draw a cat', '01'), n('b', 'draw a cat ', '09'), n('c', 'now a dog', '12'), n('d', 'draw a cat', '20')])], ['b'])
  assert.deepEqual([...repeatedQuestions([n('x', '', '01'), n('y', '', '02')])], [])
})

test("a director's calls read plainly: a rejection's reasons one per line, a schedule call's plan as rows", () => {
  assert.equal(callRejected({ status: 'error' }), true)
  assert.equal(callRejected({ status: 'refused' }), true)
  assert.equal(callRejected({ status: 'ok' }), false)
  const refusal = 'the harness refused (400): the plan is not sound: node final: receives a1, which it does not depend on; participant A cannot move between copies: its nodes name own, a1'
  assert.deepEqual(outcomeReasons(refusal), { lead: 'the harness refused (400): the plan is not sound', reasons: ['node final: receives a1, which it does not depend on', 'participant A cannot move between copies: its nodes name own, a1'] })
  assert.deepEqual(outcomeReasons('run not found'), { lead: 'run not found', reasons: [] })
  const plan = planOf({ name: 'schedule', args: { then: 'stop', nodes: [{ id: 'a1', participant: 'A', workspace: 'own', instruction: '独立给出推荐' }, { id: 'final', participant: 'A', depends_on: ['a1', 'b1'], receives: ['a1', 'b1'] }] } })
  assert.deepEqual(plan, { then: 'stop', steps: [
    { id: 'a1', participant: 'A', after: [], receives: [], workspace: 'own', instruction: '独立给出推荐' },
    { id: 'final', participant: 'A', after: ['a1', 'b1'], receives: ['a1', 'b1'], workspace: 'own', instruction: '' },
  ] })
  assert.equal(planOf({ name: 'get_run', args: { run_id: 'run_1' } }), null)
  assert.equal(planOf({ name: 'schedule', args: null }), null)                 // arguments not kept: no table
})

test("with no choice made, a session's words go to the director it has open, else to the agent; calling the director in names ChatGPT's page or its own", () => {
  assert.equal(targetOf(ds()), 'director')
  assert.equal(targetOf(ds({ transport: 'bridge' })), 'chatgpt')
  assert.equal(targetOf(ds({ state: 'closed' })), 'agent')
  assert.equal(targetOf(null), 'agent')
  assert.equal(targetOf(undefined), 'agent')
  assert.equal(targetOf(ds({ transport: 'bridge', state: 'closed' })), 'agent')
  assert.equal(directorTarget(null), 'director')
  assert.equal(directorTarget(ds()), 'director')
  assert.equal(directorTarget(ds({ transport: 'bridge' })), 'chatgpt')
  assert.equal(directorTarget(ds({ transport: 'bridge', state: 'closed' })), 'director')
})

test('a task event names its runs — in a note\'s question and in a turn\'s words — and words someone wrote are none', () => {
  assert.deepEqual(eventRunIds('oasis-code task event:\n- run run_fe493d9d2c66 finished: done'), ['run_fe493d9d2c66'])
  assert.deepEqual(eventRunIds('oasis-code task events:\n- run run_a1 (label) finished: done\n- run run_b2 finished: error'), ['run_a1', 'run_b2'])
  assert.deepEqual(eventRunIds('App note: Runs finished: run_d8cd04ef5d95, run_0a.\nRead their results with get_run.\n- run run_d8cd04ef5d95 on m — started by your instruction (turn turn_1)'), ['run_d8cd04ef5d95', 'run_0a'])
  assert.equal(eventRunIds('想让 Fable 5.1 来做 run_fe493d9d2c66'), null)
  assert.equal(eventRunIds('App note: Plan interaction ix_1.'), null)
})

test("the files sent to the director are found on what its turn started, in the order they were sent", () => {
  const file = (asset_id: string) => ({ asset_id, name: `${asset_id}.txt`, media_type: 'text/plain', file_kind: 'text', bytes: 10 }) as never
  const envelope = { text: 'hi', attachments: ['a_2', 'a_1', 'a_gone'], mentions: [], fresh: false, participant_thinking: {} }
  const interactions = [{ id: 'ix_1', attachments: [file('a_1')] }, { id: 'ix_other', attachments: [file('a_2')] }]
  const runs = [{ id: 'run_node', interaction_id: 'ix_1', attachments: [file('a_2')] }, { id: 'run_else', interaction_id: null, attachments: [file('a_gone')] }]
  const started = turn('t1', 'done', { envelope, dispatched_interaction_ids: ['ix_1'] })
  assert.deepEqual(turnAttachments(started, interactions, runs).map((a) => a.asset_id), ['a_2', 'a_1'])   // what nothing it started carries is left out
  assert.deepEqual(turnAttachments(turn('t2', 'done', { envelope, dispatched_run_ids: ['run_else'] }), interactions, runs).map((a) => a.asset_id), ['a_gone'])
  assert.deepEqual(turnAttachments(turn('t3', 'done'), interactions, runs), [])
})

test("the person's words to the director are known by what its turns started with them; a task event's or an envelope-less turn's are not", () => {
  const envelope = { text: 'go', attachments: [], mentions: [], fresh: false, participant_thinking: {} }
  const words = wordsSaidToDirector([
    turn('t1', 'done', { envelope, dispatched_run_ids: ['run_a'], dispatched_interaction_ids: ['ix_a'] }),
    turn('t2', 'done', { kind: 'task_event', envelope, dispatched_run_ids: ['run_b'] }),
    turn('t3', 'done', { dispatched_run_ids: ['run_c'] }),
  ])
  assert.deepEqual([...words], [['ix_a', 'go'], ['run_a', 'go']])
})
