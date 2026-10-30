import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WakeEvent, Watch } from '@oasis-code/contract'
import { reportRuns, undeliveredReports, untilLabel, waitingWatches, watchesChanged, watchLabel, watchOwners } from '../src/state/watches.ts'
import { isThreadRow } from '../src/state/lineage.ts'
import { isThreadRow as isReplayThreadRow } from '../src/state/replayState.ts'
import type { RunTreeRow } from '@oasis-code/contract'

const NOW = Date.parse('2026-09-30T12:00:00.000Z')
const spec = { kind: 'metric' as const, execution_id: 'x_1', at: null, every_s: null, pattern: null, field: 'step', op: '>=' as const, value: 100, stream: 'both' as const, silence_s: null }
const watch = (over: Partial<Watch> = {}): Watch => ({
  id: 'w_1', session_id: 's', run_id: 'run_1', spec, note: 'run the eval', summary: 'step >= 100 in x_1', status: 'active', repeat: false, cooldown_s: 0,
  max_fires: 1, fires: 0, last_fired_at: null, expires_at: '2026-10-07T12:00:00.000Z', ended_reason: null, created_at: 't0', updated_at: 't0', ...over,
})
const event = (over: Partial<WakeEvent> = {}): WakeEvent => ({
  id: 'wev_1', watch_id: 'w_1', session_id: 's', kind: 'fired', detail: 'step = 120', payload: {}, status: 'pending', run_id: null, created_at: 't1', delivered_at: null, ...over,
})

test('the strip shows the watches still waiting, oldest first, and the reports that wait for the conversation', () => {
  // the session lists them newest first
  const session = { watches: [watch({ id: 'w_3' }), watch({ id: 'w_2', status: 'done' }), watch({ id: 'w_1' })], wake_events: [event(), event({ id: 'wev_2', status: 'delivered', run_id: 'run_2' })] }
  assert.deepEqual(waitingWatches(session).map((w) => w.id), ['w_1', 'w_3'])
  assert.deepEqual(undeliveredReports(session).map((e) => e.id), ['wev_1'])
  assert.deepEqual(waitingWatches(null), [])
  assert.deepEqual(undeliveredReports({}), [])
})

test("the page takes the harness's word when a watch is set, reports, ends or is cancelled, or an event is delivered", () => {
  const a = { watches: [watch()], wake_events: [] as WakeEvent[] }
  assert.equal(watchesChanged(a, { watches: [watch()], wake_events: [] }), false)
  assert.equal(watchesChanged(a, { watches: [watch({ status: 'cancelled' })], wake_events: [] }), true)
  assert.equal(watchesChanged(a, { watches: [watch({ fires: 1 })], wake_events: [] }), true)
  assert.equal(watchesChanged(a, { watches: [watch(), watch({ id: 'w_2' })], wake_events: [] }), true)
  assert.equal(watchesChanged({ watches: [], wake_events: [event()] }, { watches: [], wake_events: [event({ status: 'delivered' })] }), true)
  assert.equal(watchesChanged(undefined, { watches: [], wake_events: [] }), false)
})

test('a timer says when it comes; a condition says what it waits for', () => {
  assert.equal(untilLabel('2026-09-30T12:00:40.000Z', NOW), 'in 40 s')
  assert.equal(untilLabel('2026-09-30T12:12:00.000Z', NOW), 'in 12 min')
  assert.equal(untilLabel('2026-09-30T15:00:00.000Z', NOW), 'in 3 h')
  assert.equal(untilLabel('2026-10-03T12:00:00.000Z', NOW), 'in 3 d')
  assert.equal(untilLabel('2026-09-30T11:00:00.000Z', NOW), 'now')
  assert.equal(untilLabel(null, NOW), '')
  assert.equal(watchLabel(watch(), NOW), 'step >= 100 in x_1')
  const timer = watch({ spec: { ...spec, kind: 'timer', execution_id: null, field: null, op: null, value: null, at: '2026-09-30T12:30:00.000Z' }, summary: 'at …' })
  assert.equal(watchLabel(timer, NOW), 'timer · in 30 min')
  const every = watch({ spec: { ...spec, kind: 'timer', execution_id: null, field: null, op: null, value: null, at: '2026-09-30T11:00:00.000Z', every_s: 1800 }, fires: 2, last_fired_at: '2026-09-30T11:50:00.000Z', repeat: true })
  assert.equal(watchLabel(every, NOW), 'every 30 min · in 20 min')
})

test('a run a watch woke is of the thread: the outline and the replay read it as the conversation, not beside it', () => {
  const row = (spawned_by: string) => ({ parent_run_id: null, work_order: null, spawned_by }) as unknown as RunTreeRow
  assert.equal(isThreadRow(row('wake')), true)
  assert.equal(isThreadRow(row('human')), true)
  assert.equal(isThreadRow(row('plan')), false)
  assert.equal(isReplayThreadRow(row('wake')), true)
})

test('the strip names who waits: a member by its own id, the main agent as such, each once; a report by the agent whose watch it was', () => {
  const rows = [
    { id: 'run_1', label: 'implement-lock', user_text_head: 'add the lock', participant_alias: 'lock', collab: { participant_role: 'member' } },
    { id: 'run_2', label: 'implement-task', user_text_head: 'the task model', participant_alias: 'task', collab: { participant_role: 'member' } },
    { id: 'run_3', label: null, user_text_head: 'fix it', participant_alias: null, collab: { participant_role: 'main' } },
  ] as unknown as Parameters<typeof watchOwners>[1]
  assert.deepEqual(watchOwners(['run_1', 'run_3', 'run_1'], rows), ['lock', 'Main agent'])
  assert.deepEqual(watchOwners(['run_unknown'], rows), [])
  const session = { watches: [watch({ id: 'w_1', run_id: 'run_1' }), watch({ id: 'w_2', run_id: 'run_2' })], wake_events: [event({ id: 'e1', watch_id: 'w_1' }), event({ id: 'e2', watch_id: 'w_2' })] }
  assert.deepEqual(watchOwners(reportRuns(undeliveredReports(session), session), rows), ['lock', 'task'])
})
