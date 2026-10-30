import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RunTreeRow } from '../src/api/types'
import type { Relay } from '../src/api/types'
import { clock, isThreadRow, relaysAt, rowAt, stateAt, type ReplayEvent } from '../src/state/replayState.ts'
import { applyEvent, type ThreadEntry } from '../src/state/thread.ts'

const row = (id: string, over: Partial<RunTreeRow> = {}): RunTreeRow => ({
  id, session_id: 's', parent_run_id: null, resumes_run_id: null, spawned_by: 'human', label: null, model: 'm', status: 'done', live: false,
  created_at: '2026-09-26T10:00:00.000Z', finished_at: '2026-09-26T10:00:10.000Z', workspace_id: 'ws', user_text: 'go', user_text_head: 'go',
  work_order: null, receipt: null, error: null, usage: {}, depth: 0, relay_id: null, relay_step: null, interaction_id: null, interaction_node: null, plan_node_id: null, participant_id: null, participant_alias: null, participant_index: null, participant_name: null, depends_on: [], scheduled_by: null, kind: 'run', ...over,
})
const ev = (run_id: string, seq: number, event: string, t: string, data: Record<string, unknown> = {}): ReplayEvent => ({ run_id, seq, event, data, t })

test('a moment shows the thread runs that existed, as they stood, with the rows the live reducer made', () => {
  const runs = [row('r1'), row('c1', { parent_run_id: 'r1', spawned_by: 'run:r1', created_at: '2026-09-26T10:00:02.000Z' }),
    row('h1', { spawned_by: 'human_action', created_at: '2026-09-26T10:00:20.000Z', finished_at: '2026-09-26T10:00:20.000Z' }),
    row('r2', { created_at: '2026-09-26T10:00:30.000Z', finished_at: '2026-09-26T10:00:40.000Z' })]
  const events = [
    ev('r1', 0, 'run_started', '2026-09-26T10:00:00.100Z', { model: 'm' }),
    ev('r1', 1, 'tool_call', '2026-09-26T10:00:01.000Z', { tool: 'read_file', tool_call_id: 'c1', summary: 'x' }),
    ev('c1', 0, 'run_started', '2026-09-26T10:00:02.100Z', { model: 'm' }),
    ev('r1', 2, 'tool_result', '2026-09-26T10:00:03.000Z', { tool: 'read_file', tool_call_id: 'c1', status: 'ok' }),
    ev('r1', 3, 'text_block', '2026-09-26T10:00:09.000Z', { text: 'done reading' }),
    ev('r1', 4, 'run_finished', '2026-09-26T10:00:10.000Z', { status: 'done' }),
  ]
  const early = stateAt({ runs, events }, Date.parse('2026-09-26T10:00:02.000Z'))
  assert.deepEqual(early.runs.map((r) => [r.id, r.status]), [['r1', 'running']])
  assert.equal(early.liveRunId, 'r1')
  assert.equal(early.threads.r1.length, 2)                   // run started + the running tool row
  assert.equal(early.threads.r1[1].running, true)
  const later = stateAt({ runs, events }, Date.parse('2026-09-26T10:00:25.000Z'))
  assert.deepEqual(later.runs.map((r) => [r.id, r.status]), [['r1', 'done']])   // a child and a human action are not thread runs
  assert.equal(later.liveRunId, null)
  assert.equal(later.threads.r1.find((e) => e.kind === 'activity')?.running, false)
  assert.equal(later.threads.r1.find((e) => e.kind === 'agent')?.text, 'done reading')
  assert.equal(stateAt({ runs, events }, Date.parse('2026-09-26T10:00:35.000Z')).runs.length, 2)
  assert.equal(isThreadRow(runs[1]), false)
  assert.equal(clock(65_000), '1:05')
  assert.equal(clock(3_723_000), '1:02:03')
})

test('a replayed relay turn keeps its relay identity, so the thread shows roles and handovers rather than a second user message', () => {
  const runs = [row('a1', { relay_id: 'relay_1', relay_step: 0, user_text: 'do it, both of you' }),
    row('b1', { relay_id: 'relay_1', relay_step: 1, user_text: '[oasis-code relay — a message from the harness, not from the person] …', created_at: '2026-09-26T10:00:11.000Z', finished_at: '2026-09-26T10:00:20.000Z' })]
  const moment = stateAt({ runs, events: [] }, Date.parse('2026-09-26T10:00:30.000Z'))
  assert.deepEqual(moment.runs.map((r) => [r.id, r.relay_id, r.relay_step]), [['a1', 'relay_1', 0], ['b1', 'relay_1', 1]])
  assert.deepEqual(stateAt({ runs: [row('p1')], events: [] }, Date.now()).runs.map((r) => [r.relay_id, r.relay_step]), [[null, null]])
})

test('a moment\'s tree, child rows and relays stand where they stood: a run not yet started is absent, one not yet over is running with no receipt, an answer not yet given is not there', () => {
  const runs = [
    row('a1', { relay_id: 'relay_1', relay_step: 0, receipt: { final_text: 'A said this at the end' } as never, finished_at: '2026-09-26T10:00:10.000Z', usage: { requests: 3 } }),
    row('c1', { parent_run_id: 'a1', spawned_by: 'run:a1', created_at: '2026-09-26T10:00:02.000Z', finished_at: '2026-09-26T10:00:06.000Z', receipt: { final_text: 'the child said' } as never }),
    row('b1', { relay_id: 'relay_1', relay_step: 1, created_at: '2026-09-26T10:00:11.000Z', finished_at: '2026-09-26T10:00:20.000Z', receipt: { final_text: 'B reviewed' } as never }),
  ]
  const events = [
    ev('a1', 0, 'run_started', '2026-09-26T10:00:00.100Z', { model: 'm' }),
    ev('c1', 0, 'run_started', '2026-09-26T10:00:02.100Z', { model: 'm' }),
    ev('c1', 1, 'text_block', '2026-09-26T10:00:05.000Z', { text: 'the child said' }),
    ev('c1', 2, 'run_finished', '2026-09-26T10:00:06.000Z', { status: 'done' }),
    ev('a1', 1, 'text_block', '2026-09-26T10:00:09.000Z', { text: 'A said this at the end' }),
    ev('a1', 2, 'run_finished', '2026-09-26T10:00:10.000Z', { status: 'done' }),
    ev('b1', 0, 'run_started', '2026-09-26T10:00:11.100Z', { model: 'm' }),
    ev('b1', 1, 'run_finished', '2026-09-26T10:00:20.000Z', { status: 'done' }),
  ]
  const relay: Relay = { id: 'relay_1', session_id: 's', status: 'done', user_text: 'both', participants: [{ model: 'm', label: 'A', id: 'A' }, { model: 'm', label: 'B', id: 'B' }],
    steps: [{ seq: 0, round: 1, participant: 0, status: 'done', run_id: 'a1', run_ids: ['a1'] }, { seq: 1, round: 1, participant: 1, status: 'done', run_id: 'b1', run_ids: ['b1'] }],
    rounds: 1, round: 1, current_step: 1, reason: null, client_request_id: null, created_at: '2026-09-26T10:00:00.000Z', updated_at: '2026-09-26T10:00:20.000Z', finished_at: '2026-09-26T10:00:20.000Z' }
  // 0:00 — only A, running, with nothing said; the child does not exist yet; the relay is running with A on
  const start = stateAt({ runs, events }, Date.parse('2026-09-26T10:00:00.500Z'), [relay])
  assert.deepEqual(start.tree.map((r) => [r.id, r.status, r.finished_at, r.receipt, r.live]), [['a1', 'running', null, null, true]])
  assert.deepEqual(Object.keys(start.childThreads), [])
  assert.equal(start.threads.a1.some((e) => e.kind === 'agent'), false)
  assert.deepEqual(start.relays.map((r) => [r.status, r.current_step, r.steps.map((s) => [s.status, s.run_ids])]), [['running', 0, [['running', ['a1']], ['queued', []]]]])
  // 0:03 — the child exists and runs, its rows so far; A still running
  const mid = stateAt({ runs, events }, Date.parse('2026-09-26T10:00:03.000Z'), [relay])
  assert.deepEqual(mid.tree.map((r) => [r.id, r.status]), [['a1', 'running'], ['c1', 'running']])
  assert.equal(mid.childThreads.c1.length, 1)
  assert.equal(mid.childThreads.c1.some((e) => e.kind === 'agent'), false)
  // 0:07 — the child is over with its answer and receipt; A not yet; B not yet started; the relay still on A
  const later = stateAt({ runs, events }, Date.parse('2026-09-26T10:00:07.000Z'), [relay])
  assert.deepEqual(later.tree.map((r) => [r.id, r.status, (r.receipt as { final_text?: string } | null)?.final_text ?? null]), [['a1', 'running', null], ['c1', 'done', 'the child said']])
  assert.equal(later.childThreads.c1.find((e) => e.kind === 'agent')?.text, 'the child said')
  assert.equal(later.relays[0].status, 'running')
  // 0:12 — A over (its receipt, its usage), B running: the relay's turn 2 on, still running
  const second = stateAt({ runs, events }, Date.parse('2026-09-26T10:00:12.000Z'), [relay])
  assert.deepEqual(second.tree.filter((r) => r.id !== 'c1').map((r) => [r.id, r.status, r.receipt !== null, r.usage.requests ?? null]), [['a1', 'done', true, 3], ['b1', 'running', false, null]])
  assert.deepEqual(second.relays.map((r) => [r.status, r.current_step, r.round, r.steps.map((s) => s.status)]), [['running', 1, 1, ['done', 'running']]])
  assert.equal(second.runs.find((r) => r.id === 'a1')?.receipt.final_text, 'A said this at the end')
  // the end — everything as recorded
  const end = stateAt({ runs, events }, Date.parse('2026-09-26T10:00:20.000Z'), [relay])
  assert.deepEqual(end.relays.map((r) => [r.status, r.steps.map((s) => s.status)]), [['done', ['done', 'done']]])
  assert.equal(end.tree.length, 3)
  // a relay none of whose turns had started is not there; a turn run twice (a decision, a restart) counts the runs that existed
  assert.deepEqual(relaysAt([relay], []), [])
  const twice: Relay = { ...relay, status: 'waiting', steps: [{ seq: 0, round: 1, participant: 0, status: 'waiting', run_id: 'a2', run_ids: ['a1', 'a2'] }] }
  assert.deepEqual(relaysAt([twice], [rowAt(runs[0], Date.parse('2026-09-26T10:00:12.000Z'))]).map((r) => [r.status, r.steps[0].status, r.steps[0].run_ids]), [['running', 'done', ['a1']]])
})

test('an answer continued at the output limit: one row live and from the saved blocks alone, once or twice, nothing left waiting', () => {
  const parts = ['第一段 A；', '第二段 B；', '第三段 C。']
  for (const count of [1, 2]) {
    const pieces = parts.slice(0, count + 1)
    const saved: ReplayEvent[] = [ev('r1', 0, 'run_started', '2026-09-26T10:00:00.100Z', { model: 'm' })]
    pieces.forEach((text, i) => {
      if (i > 0) saved.push(ev('r1', saved.length, 'run_continued', `2026-09-26T10:00:0${2 * i}.000Z`, { reason: 'output_limit', attempt: i, of: 2, kept_chars: pieces.slice(0, i).join('').length }))
      saved.push(ev('r1', saved.length, 'text_block', `2026-09-26T10:00:0${2 * i + 1}.000Z`, { text }))
    })
    saved.push(ev('r1', saved.length, 'run_finished', '2026-09-26T10:00:09.000Z', { status: 'done' }))
    // the saved blocks alone (the deltas are not kept)
    const reopened = stateAt({ runs: [row('r1')], events: JSON.parse(JSON.stringify(saved)) as ReplayEvent[] }, Date.parse('2026-09-26T10:00:10.000Z'))
    const answers = reopened.threads.r1.filter((e) => e.kind === 'agent')
    assert.deepEqual(answers.map((e) => e.text), [pieces.join('')], `blocks, ${count}`)
    assert.equal(answers[0].running, false)
    assert.equal('continues' in answers[0] || 'prefix' in answers[0], false)
    assert.equal(reopened.threads.r1.filter((e) => e.kind === 'note' && e.eventName === 'run_continued').length, count)
    // live, with the deltas: the same row
    let live: ThreadEntry[] = []
    for (const e of saved) {
      if (e.event === 'text_block') live = applyEvent(live, 'r1', { event: 'text_delta', data: { text: e.data.text, start: true } })
      live = applyEvent(live, 'r1', { event: e.event, data: e.data, id: String(e.seq) })
    }
    assert.deepEqual(live.filter((e) => e.kind === 'agent').map((e) => [e.text, e.running, 'continues' in e]), [[pieces.join(''), false, false]], `live, ${count}`)
    // part way: the first part only
    const early = stateAt({ runs: [row('r1')], events: saved }, Date.parse('2026-09-26T10:00:01.500Z'))
    assert.deepEqual(early.threads.r1.filter((e) => e.kind === 'agent').map((e) => e.text), [pieces[0]])
  }
})

test('a continuation that never came: the run\'s end leaves no row waiting', () => {
  let t: ThreadEntry[] = []
  t = applyEvent(t, 'r1', { event: 'text_block', data: { text: 'cut' }, id: '1' })
  t = applyEvent(t, 'r1', { event: 'run_continued', data: { reason: 'output_limit', attempt: 1, of: 2, kept_chars: 3 }, id: '2' })
  assert.equal(t.find((e) => e.kind === 'agent')!.continues, true)
  t = applyEvent(t, 'r1', { event: 'run_finished', data: { status: 'error', error: 'incomplete_answer: the answer reached the output limit' }, id: '3' })
  const answer = t.find((e) => e.kind === 'agent')!
  assert.deepEqual([answer.text, answer.running, 'continues' in answer, 'prefix' in answer], ['cut', false, false, false])
})
