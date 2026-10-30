/** The outline's plan rows (the Agent Teams hand-off): a relay's steps and an interaction's nodes as one row each —
 *  a run's row decorated where the node has one, a placeholder while it has none — the director's plan row its nodes
 *  hang under, the decision that is the person's. Pure: fixtures stand for what the harness persisted. */

import { expect, test } from 'bun:test'
import type { Interaction, InteractionNode, Relay } from '@oasis-code/contract'
import { planRows, stampDepths, type TreeRow } from '../src/api/tree.ts'

const run = (id: string, over: TreeRow = {}): TreeRow => ({
  id, session_id: 's', parent_run_id: null, resumes_run_id: null, spawned_by: 'human', label: null, model: 'm', status: 'done', live: false,
  created_at: '2026-09-29T00:00:00.000Z', finished_at: '2026-09-29T00:01:00.000Z', workspace_id: 'ws', user_text: 'go', user_text_head: 'go',
  work_order: null, receipt: null, error: null, usage: {}, depth: 0, relay_id: null, relay_step: null, interaction_id: null, interaction_node: null, ...over,
})
const pick = (rows: TreeRow[], keys: string[]) => rows.map((r) => keys.map((k) => r[k]))

test('a relay half way: the runs decorated with the letter and the step before; the steps not started as queued placeholders, never live', () => {
  const relay: Relay = {
    id: 'relay_1', session_id: 's', status: 'running', user_text: 'go @[A](agent:m#A) then @[B](agent:n#B)',
    participants: [{ model: 'm', label: 'A', id: 'A' }, { model: 'n', label: 'B', id: 'B' }],
    steps: [
      { seq: 0, round: 1, participant: 0, status: 'done', run_id: 'run_a1', run_ids: ['run_a1'] },
      { seq: 1, round: 1, participant: 1, status: 'done', run_id: 'run_b1', run_ids: ['run_b1'] },
      { seq: 2, round: 2, participant: 0, status: 'running', run_id: 'run_a2', run_ids: ['run_a2'] },
      { seq: 3, round: 2, participant: 1, status: 'queued', run_id: null, run_ids: [] },
    ],
    rounds: 2, round: 2, current_step: 2, reason: null, client_request_id: null, created_at: 't0', updated_at: 't0', finished_at: null,
  }
  const rows = planRows([run('run_a1', { relay_id: 'relay_1', relay_step: 0 }), run('run_b1', { relay_id: 'relay_1', relay_step: 1, model: 'n' }), run('run_a2', { relay_id: 'relay_1', relay_step: 2, status: 'running', live: true })], [relay], [])
  expect(pick(rows, ['id', 'plan_node_id', 'participant_id', 'participant_alias', 'depends_on', 'status', 'live', 'spawned_by', 'kind'])).toEqual([
    ['run_a1', 'relay_1:0', 'relay_1:A', 'A', [], 'done', false, 'human', 'run'],
    ['run_b1', 'relay_1:1', 'relay_1:B', 'B', ['run_a1'], 'done', false, 'human', 'run'],
    ['run_a2', 'relay_1:2', 'relay_1:A', 'A', ['run_b1'], 'running', true, 'human', 'run'],
    ['relay_1:3', 'relay_1:3', 'relay_1:B', 'B', ['run_a2'], 'queued', false, 'plan', 'run'],
  ])
  const placeholder = rows[3]!
  expect([placeholder.model, placeholder.receipt, placeholder.relay_id, placeholder.relay_step, placeholder.user_text_head, placeholder.created_at]).toEqual(['n', null, 'relay_1', 3, 'go @A then @B', 't0'])
  expect(rows.map((r) => r.user_text_head)).toEqual(['go @A then @B', 'go @A then @B', 'go @A then @B', 'go @A then @B'])      // named by the request, not by the handover a turn opened with
  // a relay that ended never runs its rest: the placeholder reads cancelled
  const stopped = planRows([run('run_a1', { relay_id: 'relay_1', relay_step: 0 })], [{ ...relay, status: 'cancelled', steps: relay.steps.slice(0, 2).map((s, i) => (i ? { ...s, status: 'cancelled', run_id: null, run_ids: [] } : s)) }], [])
  expect(pick(stopped, ['id', 'status'])).toEqual([['run_a1', 'done'], ['relay_1:1', 'cancelled']])
})

const interaction = (over: Partial<Interaction> = {}): Interaction => ({
  workspace_policy: 'legacy', source_turn_id: null,
  id: 'ix_1', session_id: 's', status: 'running', user_text: 'go', participants: [{ id: 'A', label: 'A', model: 'm' }, { id: 'B', label: 'B', model: 'm' }],
  controller: 'director', template: null, then: 'stop', revision: 1, budget: { max_runs: 6, concurrency: 2 }, runs_started: 2, base_checkpoint_id: 'cp_1',
  fresh: false, resumes_run_id: null, director_session_id: 'ds_1', director_turn_id: null, reason: null, attachments: [], client_request_id: null,
  created_at: 't0', updated_at: 't0', finished_at: null, ...over,
})
const node = (id: string, participant: string, over: Partial<InteractionNode> = {}): InteractionNode => ({
  id, interaction_id: 'ix_1', seq: 1, participant, instruction: null, depends_on: [], receives: [], workspace: 'own', status: 'queued', run_id: null, run_ids: [],
  workspace_id: null, revision: 1, wave: 1, created_at: 't1', updated_at: 't1', ...over,
})

test("a director's plan: its row asleep while the nodes run, the nodes under it, a node not started as a placeholder waiting for the rows before it, the decision queued behind the last step", () => {
  const nodes = [
    node('a1', 'A', { status: 'done', run_id: 'run_a1', run_ids: ['run_a1'], workspace_id: 'ws_a' }),
    node('b1', 'B', { status: 'running', run_id: 'run_b1', run_ids: ['run_b1'], workspace_id: 'ws_b' }),
    node('a2', 'A', { depends_on: ['a1', 'b1'], receives: ['b1'], instruction: 'compare the two', wave: 2 }),
  ]
  const rows = planRows([run('run_a1', { interaction_id: 'ix_1', interaction_node: 'a1' }), run('run_b1', { interaction_id: 'ix_1', interaction_node: 'b1', status: 'running', live: true })], [], [{ interaction: interaction(), nodes, director_model: 'd', adopted: false }])
  stampDepths(rows)
  expect(pick(rows, ['id', 'kind', 'status', 'participant_alias', 'depends_on', 'scheduled_by', 'spawned_by', 'depth'])).toEqual([
    ['run_a1', 'run', 'done', 'A', [], 'ix_1', 'human', 1],
    ['run_b1', 'run', 'running', 'B', [], 'ix_1', 'human', 1],
    ['ix_1', 'plan', 'waiting', null, [], null, 'plan', 0],
    ['ix_1:a2', 'run', 'queued', 'A', ['run_a1', 'run_b1'], 'ix_1', 'plan', 1],
    ['ix_1:decide', 'decision', 'queued', null, ['ix_1:a2'], 'ix_1', 'plan', 1],
  ])
  const plan = rows[2]!, a2 = rows[3]!, decide = rows[4]!
  expect([plan.model, plan.label, plan.interaction_id, plan.live]).toEqual(['d', 'Plan · 3 steps', 'ix_1', false])
  expect([a2.model, a2.label, a2.user_text_head, a2.interaction_node, a2.participant_id, a2.created_at]).toEqual(['m', 'compare the two', 'compare the two', 'a2', 'ix_1:A', 't1'])
  expect([rows[0]!.user_text_head, rows[1]!.user_text_head]).toEqual(['go', 'go'])                                                 // a step's run is named by the request, not by the harness's message
  expect([decide.model, decide.label]).toEqual([null, 'Your choice: keep A · ask for a synthesis'])
  // the plan being made: the director's row thinks, no node yet, no decision yet
  expect(pick(planRows([], [], [{ interaction: interaction({ status: 'planning' }), nodes: [], director_model: 'd', adopted: false }]), ['id', 'kind', 'status', 'label'])).toEqual([['ix_1', 'plan', 'running', 'Plan · 0 steps']])
})

test("every step ended: the decision is the person's (needs you) until something was kept, then done; a fixed template has no plan row; an ended interaction's unstarted node reads cancelled", () => {
  const done = [node('a1', 'A', { status: 'done', run_id: 'run_a1', run_ids: ['run_a1'] }), node('b1', 'B', { status: 'done', run_id: 'run_b1', run_ids: ['run_b1'] })]
  const runs = () => [run('run_a1'), run('run_b1')]
  const waiting = planRows(runs(), [], [{ interaction: interaction({ status: 'done', finished_at: 't9' }), nodes: done, director_model: 'd', adopted: false }])
  expect(pick(waiting, ['id', 'kind', 'status', 'depends_on'])).toEqual([['run_a1', 'run', 'done', []], ['run_b1', 'run', 'done', []], ['ix_1', 'plan', 'done', []], ['ix_1:decide', 'decision', 'waiting', ['run_a1', 'run_b1']]])
  expect(waiting[3]!.label).toBe('Your choice: keep A · keep B · ask for a synthesis')
  const kept = planRows(runs(), [], [{ interaction: interaction({ status: 'done', finished_at: 't9' }), nodes: done, director_model: 'd', adopted: true }])
  expect([kept[3]!.status, kept[3]!.finished_at]).toEqual(['done', 't9'])
  const fixed = planRows(runs(), [], [{ interaction: interaction({ controller: 'fixed', template: 'independent', status: 'done' }), nodes: done, director_model: null, adopted: false }])
  expect(pick(fixed, ['id', 'kind', 'scheduled_by'])).toEqual([['run_a1', 'run', null], ['run_b1', 'run', null], ['ix_1:decide', 'decision', null]])
  const stopped = planRows([run('run_a1')], [], [{ interaction: interaction({ status: 'cancelled', then: 'director' }), nodes: [done[0]!, node('b1', 'B')], director_model: 'd', adopted: false }])
  expect(pick(stopped, ['id', 'kind', 'status'])).toEqual([['run_a1', 'run', 'done'], ['ix_1', 'plan', 'cancelled'], ['ix_1:b1', 'run', 'cancelled']])   // then: director — no decision row
})
