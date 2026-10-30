import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RunTreeRow } from '../src/api/types'
import { agentOf, entriesOfRun, foldAgents, foldLineages, isThreadRow, withDependencies } from '../src/state/lineage.ts'

const row = (id: string, at: string, extra: Partial<RunTreeRow> = {}): RunTreeRow => ({
  id, session_id: 's', parent_run_id: null, resumes_run_id: null, spawned_by: 'human', label: null, model: 'm', status: 'done', live: false,
  created_at: at, finished_at: at, workspace_id: null, user_text: `words of ${id}`, user_text_head: `words of ${id}`, work_order: null,
  receipt: null, error: null, usage: {}, depth: 0, relay_id: null, relay_step: null, interaction_id: null, interaction_node: null, plan_node_id: null, participant_id: null, participant_alias: null, participant_index: null, participant_name: null, depends_on: [], scheduled_by: null, kind: 'run', ...extra,
})

test('runs that continue each other fold into one lineage wearing the newest run', () => {
  const rows = [
    row('a', '2026-09-26T10:00:00Z'),
    row('b', '2026-09-26T10:05:00Z', { resumes_run_id: 'a', status: 'running', model: 'm2', label: 'later' }),
    row('c', '2026-09-26T10:01:00Z', { parent_run_id: 'a', spawned_by: 'run:a', label: 'child' }),
  ]
  const lineages = foldLineages(rows)
  assert.deepEqual(lineages.map((l) => l.id), ['a', 'c'])
  const a = lineages[0]
  assert.equal(a.status, 'running')                                 // the newest run's state
  assert.equal(a.model, 'm2')
  assert.equal(a.user_text, 'words of a')                           // the root's identity
  assert.deepEqual(a.lineage.map((r) => r.id), ['a', 'b'])
  assert.equal(a.latest.id, 'b')
  assert.ok(isThreadRow(rows[0]) && !isThreadRow(rows[2]))
})

test('a run\'s rows come from its own watched stream first, then the thread\'s', () => {
  const child = [{ kind: 'agent' as const, text: 'child' }]
  const main = [{ kind: 'agent' as const, text: 'main' }]
  assert.equal(entriesOfRun('x', { x: child }, { x: main })[0].text, 'child')
  assert.equal(entriesOfRun('x', {}, { x: main })[0].text, 'main')
  assert.deepEqual(entriesOfRun('x', {}, {}), [])
})

const A = { participant_id: 'ix:pt_3f2a9c', participant_alias: 'pt_3f2a9c', participant_index: 0, participant_name: 'pt_3f2a9c' }

test("a plan node is a row of its own: a step run again folds into its row, a participant's later step stands apart from the run it continues, a plain follow-up folds as before; a dependency names the row", () => {
  const rows = [
    row('a1', '2026-09-26T10:00:00Z', { plan_node_id: 'ix:a1', ...A }),
    row('a1b', '2026-09-26T10:02:00Z', { plan_node_id: 'ix:a1', ...A, resumes_run_id: 'a1', status: 'running' }),      // the step, run again after the person's decision
    row('a2', '2026-09-26T10:05:00Z', { plan_node_id: 'ix:a2', ...A, resumes_run_id: 'a1b', depends_on: ['a1b'] }),   // A's next step continues A's conversation
    row('f', '2026-09-26T10:09:00Z', { resumes_run_id: 'a2' }),                                                        // the person's plain follow-up
  ]
  const lineages = withDependencies(foldLineages(rows))
  assert.deepEqual(lineages.map((l) => [l.id, l.lineage.map((r) => r.id), l.status]), [['a1', ['a1', 'a1b'], 'running'], ['a2', ['a2', 'f'], 'done']])
  assert.deepEqual(lineages[1].depends_on, ['a1'])                                                                    // the dependency on a1b names a1's row
  // the row a plain follow-up folded into keeps its participant: its place (the badge, the bot) and its name
  assert.deepEqual([lineages[1].participant_alias, lineages[1].participant_index, lineages[1].participant_name], ['pt_3f2a9c', 0, 'pt_3f2a9c'])
})

test("the desk folds by participant: one card per agent holding every step it ran, a plain follow-up with it; a plan's own rows carry no card", () => {
  const rows = [
    row('a1', '2026-09-26T10:00:00Z', { plan_node_id: 'ix:a1', participant_id: 'ix:A', participant_alias: 'A' }),
    row('b1', '2026-09-26T10:00:01Z', { plan_node_id: 'ix:b1', participant_id: 'ix:B', participant_alias: 'B' }),
    row('a2', '2026-09-26T10:05:00Z', { plan_node_id: 'ix:a2', participant_id: 'ix:A', participant_alias: 'A', resumes_run_id: 'a1' }),
    row('b2', '2026-09-26T10:05:01Z', { plan_node_id: 'ix:b2', participant_id: 'ix:B', participant_alias: 'B', resumes_run_id: 'b1', status: 'running' }),
    row('ix:a3', '2026-09-26T10:06:00Z', { plan_node_id: 'ix:a3', participant_id: 'ix:A', participant_alias: 'A', spawned_by: 'plan', status: 'queued' }),
    row('ix', '2026-09-26T09:59:00Z', { kind: 'plan', spawned_by: 'plan', status: 'waiting' }),
    row('f', '2026-09-26T10:09:00Z', { resumes_run_id: 'a2' }),
  ]
  const agents = foldAgents(rows)
  assert.deepEqual(agents.map((a) => [a.id, a.lineage.map((r) => r.id), a.status, a.participant_alias]), [['a1', ['a1', 'a2', 'f'], 'done', 'A'], ['b1', ['b1', 'b2'], 'running', 'B']])
  assert.equal(agentOf(agents, 'a2'), 'a1')
  assert.equal(agentOf(agents, 'b2'), 'b1')
  assert.equal(agentOf(agents, 'ix:a3'), null)
  assert.deepEqual(foldLineages(rows).map((l) => l.id), ['a1', 'b1', 'a2', 'b2', 'ix:a3', 'ix'])                          // the outline keeps a row per step
})
