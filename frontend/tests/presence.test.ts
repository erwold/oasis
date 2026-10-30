import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyEvent, type ThreadEntry } from '../src/state/thread.ts'
import { endingOf, runAfterQueueEvents } from '../src/state/outline.ts'
import { directorPresence, directorSettlesIn, endedRecord, factsFor, mergeTree, nodePresence, nodeRunOf, planPresence, planStatusFor, presenceIndex, presenceOf, rowAfter, runSignals, settlesIn, treeAfter, type HeadRow } from '../src/state/presence.ts'
import type { SSEItem } from '../src/api/types.ts'

// The bot's state (state/presence.ts) read off the rows the thread reducer makes of a run's real events.
const NOW = Date.parse('2026-10-18T10:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const rows = (events: [string, Record<string, unknown>][], runId = 'run_a'): ThreadEntry[] =>
  events.reduce<ThreadEntry[]>((t, [event, data], i) => applyEvent(t, runId, { event, data, id: String(i + 1) } as SSEItem), [])
const running = { id: 'run_a', status: 'running', finished_at: null }
const input = (status: string) => ({ id: 'in_1', session_id: 's', run_id: 'run_a', tool_call_id: 'tc_in', status, closed_reason: null, request: { title: 'Pick', root: 'r', elements: { r: { type: 'input', props: { label: 'x', key: 'x', inputType: 'text' } } } }, values: null, created_at: iso(NOW), updated_at: iso(NOW + (status === 'pending' ? 0 : 1)) })

test('a live run: thinking while its model answers or still writes a call; working while any call runs; waiting in line', () => {
  const started: [string, Record<string, unknown>][] = [['run_started', { model: 'm' }]]
  assert.equal(presenceOf(running, rows(started)), 'thinking')
  assert.equal(presenceOf(running, rows([...started, ['thinking_delta', { text: 'hm', start: true }]])), 'thinking')
  assert.equal(presenceOf(running, rows([...started, ['text_delta', { text: 'Hello', start: true }]])), 'thinking')
  // the model writes a call's arguments: nothing runs yet (forming is no work), however many
  const forming = rows([...started, ['tool_call_progress', { tool_call_id: 'tc_1', tool: 'write_file', chars: 300 }], ['tool_call_progress', { tool_call_id: 'tc_2', tool: 'bash', chars: 10 }]])
  assert.equal(runSignals(forming).openTools, 0)
  assert.equal(presenceOf(running, forming), 'thinking')
  // the calls came: they run
  const two = rows([...started, ['tool_call_progress', { tool_call_id: 'tc_1', tool: 'bash', chars: 30 }], ['tool_call', { tool_call_id: 'tc_1', tool: 'bash', summary: 'sleep 5' }],
    ['tool_call', { tool_call_id: 'tc_2', tool: 'web_search', summary: 'q' }]])
  assert.equal(runSignals(two).openTools, 2)
  assert.equal(presenceOf(running, two), 'working')
  // one answered, the other still runs (the latest row is no longer an open call): still working
  const one = rows([...started, ['tool_call', { tool_call_id: 'tc_1', tool: 'bash', summary: 'sleep 5' }], ['tool_call', { tool_call_id: 'tc_2', tool: 'web_search', summary: 'q' }],
    ['tool_result', { tool_call_id: 'tc_2', tool: 'web_search', status: 'ok' }]])
  assert.equal(presenceOf(running, one), 'working')
  // both answered: the model is asked again
  const none = rows([...started, ['tool_call', { tool_call_id: 'tc_1', tool: 'bash', summary: 'false' }], ['tool_result', { tool_call_id: 'tc_1', tool: 'bash', status: 'error', exit_code: 1 }]])
  assert.equal(presenceOf(running, none), 'thinking', 'a command that exited non-zero blocks nothing: the model goes on')
  // a request waiting for its slot, then the slot taken
  const slot = rows([...started, ['slot_wait', { scope: 'provider:x', behind: ['run_b'] }]])
  assert.equal(presenceOf(running, slot), 'waiting')
  assert.equal(presenceOf(running, rows([...started, ['slot_wait', { scope: 'provider:x', behind: [] }], ['slot_acquired', { scope: 'provider:x' }]])), 'thinking')
  // in line for its folder (the run's record queued), then going on
  assert.equal(presenceOf({ ...running, status: 'queued' }, []), 'waiting')
  const queued = rows([['run_queued', { reason: 'workspace_lock', blocking_owner: 'run_w', blocking_run_id: 'run_w' }]])
  assert.equal(presenceOf(running, queued), 'waiting')
  assert.equal(presenceOf(running, rows([['run_queued', { reason: 'model' }]])), 'waiting', 'in line for its model: waiting, whatever it names')
  assert.equal(presenceOf(running, rows([['run_queued', { reason: 'workspace_lock', blocking_owner: 'run_w' }], ['slot_acquired', { scope: 'workspace:ws' }], ['run_started', { model: 'm' }]])), 'thinking')
})

test('a form the run waits on blocks it; answered, the same run goes on', () => {
  const asked = rows([['run_started', { model: 'm' }], ['tool_call', { tool_call_id: 'tc_in', tool: 'request_input', summary: 'Pick' }], ['ui_input', { input: input('pending') }]])
  assert.equal(presenceOf(running, asked), 'blocked')
  // the store heard the form before the row (another client's stream): blocked too
  assert.equal(presenceOf(running, rows([['run_started', { model: 'm' }]]), { pendingInput: true }), 'blocked')
  const answered = [...asked]
  const after = applyEvent(applyEvent(answered, 'run_a', { event: 'ui_input', data: { input: input('submitted') }, id: '9' } as SSEItem), 'run_a',
    { event: 'tool_result', data: { tool_call_id: 'tc_in', tool: 'request_input', status: 'ok' }, id: '10' } as SSEItem)
  assert.equal(presenceOf(running, after), 'thinking')
})

test('an ending plays a moment, then the still icon: done 25 s, the person\'s stop idle, an error or a refusal blocked 40 s', () => {
  const ended = (status: string, receipt: unknown = null, ago = 1_000) => ({ id: 'run_a', status, finished_at: iso(NOW - ago), receipt })
  assert.equal(presenceOf(ended('done'), [], {}, NOW), 'done')
  assert.equal(presenceOf(ended('done', null, 26_000), [], {}, NOW), 'static')
  assert.equal(presenceOf(ended('cancelled'), [], {}, NOW), 'idle', 'stopped by the person: idle, neither done nor blocked')
  assert.equal(presenceOf(ended('cancelled', null, 26_000), [], {}, NOW), 'static')
  assert.equal(presenceOf(ended('cancelled', { interrupted: true }), [], {}, NOW), 'blocked', 'the app quit: no one chose to stop it')
  assert.equal(presenceOf(ended('error'), [], {}, NOW), 'blocked')
  assert.equal(presenceOf(ended('error', null, 39_000), [], {}, NOW), 'blocked')
  assert.equal(presenceOf(ended('error', null, 41_000), [], {}, NOW), 'static')
  assert.equal(presenceOf(ended('done', { mechanical: { answer_end: { reason: 'content_filter', attempts: 0 } } }), [], {}, NOW), 'blocked')
  assert.equal(presenceOf(ended('done', { mechanical: { failed_executions: 3 } }), [], {}, NOW), 'done', 'commands that failed along the way: still done')
  // its end said by the receipt alone still plays
  assert.equal(presenceOf({ id: 'run_a', status: 'done', finished_at: null, receipt: { finished_at: iso(NOW - 1_000) } }, [], {}, NOW), 'done')
  // when the ending settles, and what never settles by the time
  assert.equal(settlesIn(ended('done', null, 5_000), {}, NOW), 20_000)
  assert.equal(settlesIn(ended('error', null, 5_000), {}, NOW), 35_000)
  assert.equal(settlesIn(ended('done', null, 5_000), { watching: true }, NOW), null)
  assert.equal(settlesIn(ended('done', null, 5_000), { pendingApproval: true }, NOW), null)
  assert.equal(settlesIn(running, {}, NOW), null)
})

test('what waits for the agent outlasts the moment: a watch waits, the person blocks, never wiped by the time', () => {
  const old = { id: 'run_a', status: 'done', finished_at: iso(NOW - 3_600_000), receipt: null }
  assert.equal(presenceOf(old, [], { watching: true }, NOW), 'waiting')
  assert.equal(presenceOf(old, [], { pendingApproval: true }, NOW), 'blocked')
  assert.equal(presenceOf({ ...old, status: 'error', finished_at: iso(NOW - 1_000) }, [], { watching: true }, NOW), 'blocked', 'its error first, a moment')
  assert.equal(presenceOf({ ...old, status: 'error' }, [], { watching: true }, NOW), 'waiting', 'then the watch it still waits on')
  // a live run's own state wins over its agent's facts (a successor runs)
  assert.equal(presenceOf(running, rows([['run_started', { model: 'm' }]]), { watching: true }, NOW), 'thinking')
})

const row = (id: string, over: Partial<HeadRow> & { at?: number } = {}): HeadRow =>
  ({ id, session_id: 's', created_at: iso(over.at ?? NOW), parent_run_id: null, resumes_run_id: null, work_order: null, model: 'm', spawned_by: 'human', collab: { participant_role: 'main', participant_id: 'pa_main' }, ...over })

test("a watch, an approval or a proposal is shown on its agent's current run alone; an older answer, another agent never", () => {
  // the main conversation: run_1 set the watch, run_2 continued it later; a separate agent beside it
  const world = {
    rows: [row('run_1', { at: NOW - 60_000 }), row('run_2', { at: NOW - 30_000 }), row('run_x', { collab: { participant_role: 'separate', participant_id: 'pa_x' } })],
    watches: [{ id: 'w_1', run_id: 'run_1', status: 'active' }],
  }
  const index = presenceIndex(world)
  assert.deepEqual(factsFor(index, 'run_2'), { pendingInput: false, pendingApproval: false, watching: true }, 'the head of its conversation waits')
  assert.equal(factsFor(index, 'run_1').watching, false, 'the older answer that set it: its own result')
  assert.equal(factsFor(index, 'run_x').watching, false, 'another agent: untouched')
  // the watch reported and waits to be delivered (the conversation busy): still waiting
  const reported = presenceIndex({ ...world, watches: [{ id: 'w_1', run_id: 'run_1', status: 'done' }], wakeEvents: [{ watch_id: 'w_1', status: 'pending' }] })
  assert.equal(factsFor(reported, 'run_2').watching, true)
  // delivered, or cancelled: nothing waits
  assert.equal(factsFor(presenceIndex({ ...world, watches: [{ id: 'w_1', run_id: 'run_1', status: 'cancelled' }], wakeEvents: [{ watch_id: 'w_1', status: 'delivered' }] }), 'run_2').watching, false)
  // the wake run delivered it: it is the head now, live, its own state
  const woken = presenceIndex({ ...world, rows: [...world.rows, row('run_3', { at: NOW })] })
  assert.equal(factsFor(woken, 'run_3').watching, true)
  assert.equal(presenceOf({ id: 'run_3', status: 'running' }, rows([['run_started', { model: 'm' }]], 'run_3'), factsFor(woken, 'run_3'), NOW), 'thinking')
  assert.equal(factsFor(woken, 'run_2').watching, false)

  // a proposal pending for the separate agent: its current run blocked; decided: no longer
  const proposed = presenceIndex({ ...world, watches: [], proposals: [{ run_id: 'run_x', status: 'pending' }] })
  assert.equal(factsFor(proposed, 'run_x').pendingApproval, true)
  assert.equal(factsFor(proposed, 'run_2').pendingApproval, false)
  assert.equal(factsFor(presenceIndex({ ...world, proposals: [{ run_id: 'run_x', status: 'approved' }] }), 'run_x').pendingApproval, false)

  // a session grant's approval reused: its record names run_1, the call refused now is run_2's — run_2 is told its id
  const refused = rows([['tool_call', { tool_call_id: 'tc', tool: 'bash', summary: 'push' }], ['tool_result', { tool_call_id: 'tc', tool: 'bash', status: 'refused_by_policy', approval_id: 'ap_1' }]], 'run_x2')
  const separate = { participant_role: 'separate', participant_id: 'pa_y' }
  const reused = presenceIndex({
    rows: [row('run_y1', { at: NOW - 60_000, collab: separate }), row('run_x2', { at: NOW - 10_000, collab: { participant_role: 'separate', participant_id: 'pa_z' } })],
    approvals: [{ id: 'ap_1', run_id: 'run_y1' }],
    entriesOf: (id) => (id === 'run_x2' ? refused : undefined),
  })
  assert.equal(factsFor(reused, 'run_x2').pendingApproval, true, 'the agent whose call the approval refused now')
  assert.equal(factsFor(reused, 'run_y1').pendingApproval, true, 'and the one that first asked, its head')

  // a run without a participant: followed back through the run it continues
  const chain = presenceIndex({ rows: [row('run_p', { at: NOW - 9_000, collab: null, parent_run_id: 'run_root' }), row('run_q', { at: NOW, collab: null, parent_run_id: 'run_root', resumes_run_id: 'run_p' })], watches: [{ id: 'w', run_id: 'run_p', status: 'active' }] })
  assert.equal(factsFor(chain, 'run_q').watching, true)
  assert.equal(factsFor(chain, 'run_p').watching, false)
})

test('a run that ended is never brought back to the queue by the words its stream replays', () => {
  const ended = { status: 'done', waiting: null }
  assert.equal(runAfterQueueEvents(ended, [{ event: 'run_queued', data: { reason: 'workspace_lock', blocking_owner: 'run_w' } }]), ended)
  const live = runAfterQueueEvents({ status: 'running', waiting: null }, [{ event: 'run_queued', data: { reason: 'workspace_lock', blocking_owner: 'run_w' } }])
  assert.equal(live.status, 'queued')
  assert.equal(runAfterQueueEvents(live, [{ event: 'slot_acquired', data: {} }]).status, 'running')
})

test("the director: in line waits, with its model (or the ChatGPT page answering) thinks, its tool works, a sign-in blocks", () => {
  assert.equal(directorPresence({ status: 'queued' }, 'generating'), 'waiting')
  assert.equal(directorPresence({ status: 'generating' }, 'generating'), 'thinking')
  assert.equal(directorPresence({ status: 'generating' }, 'generating', [{ status: 'ok' }, { status: 'running' }]), 'working')
  assert.equal(directorPresence({ status: 'awaiting_answer' }, 'generating'), 'thinking', 'submitted to the ChatGPT page: its model answers')
  assert.equal(directorPresence({ status: 'queued' }, 'needs_login'), 'blocked')
  assert.equal(directorPresence({ status: 'error', finished_at: iso(NOW - 1_000) }, 'idle', [], NOW), 'blocked')
  assert.equal(directorPresence({ status: 'error', finished_at: iso(NOW - 60_000) }, 'idle', [], NOW), 'static')
  assert.equal(directorPresence({ status: 'cancelled', finished_at: iso(NOW - 1_000) }, 'idle', [], NOW), 'idle')
  // a turn of its history is never read with the director's state now
  assert.equal(directorPresence({ status: 'done', finished_at: iso(NOW - 600_000) }, 'needs_login', [], NOW, false), 'static')
  assert.equal(directorPresence({ status: 'generating' }, 'needs_login', [], NOW, false), 'thinking')
  // no turn: its own state
  assert.equal(directorPresence(null, 'waiting_for_tasks'), 'waiting')
  assert.equal(directorPresence(null, 'needs_login'), 'blocked')
  assert.equal(directorPresence(null, 'idle'), 'idle')
  assert.equal(directorPresence(null, 'paused'), 'idle')
  assert.equal(directorPresence(null, 'closed'), 'static')
  assert.equal(directorSettlesIn({ status: 'error', finished_at: iso(NOW - 10_000) }, NOW), 30_000)
  assert.equal(directorSettlesIn({ status: 'generating' }, NOW), null)
})

test("an interaction's step: its current run while in line or at work; else a decision owed blocks, a watch or the line waits", () => {
  assert.equal(nodePresence({ status: 'waiting' }, { status: 'done', state: 'done' }), 'blocked')
  assert.equal(nodePresence({ status: 'watching' }, { status: 'done', state: 'static' }), 'waiting')
  assert.equal(nodePresence({ status: 'queued' }, null), 'waiting')
  assert.equal(nodePresence({ status: 'running' }, { status: 'running', state: 'working' }), 'working')
  assert.equal(nodePresence({ status: 'running' }, null), 'thinking')
  assert.equal(nodePresence({ status: 'done' }, { status: 'done', state: 'done' }), 'done')
  assert.equal(nodePresence({ status: 'error' }, null), 'blocked')
  assert.equal(nodePresence({ status: 'cancelled' }, null), 'static')
  // the node's record lags its run's stream: the watch woke it, or the approval let it go on — the run that runs wins
  assert.equal(nodePresence({ status: 'watching' }, { status: 'running', state: 'thinking' }), 'thinking')
  assert.equal(nodePresence({ status: 'waiting' }, { status: 'running', state: 'working' }), 'working')
  assert.equal(nodePresence({ status: 'waiting' }, { status: 'queued', state: 'waiting' }), 'waiting')
  // its current run: the newest of its runs the page knows, ahead of a run_id the record has not moved yet
  const node = { id: 'n1', run_id: 'run_1', run_ids: ['run_1'] }
  const tree = [{ id: 'run_1', created_at: iso(NOW - 9_000), interaction_id: 'ix', interaction_node: 'n1' }, { id: 'run_2', created_at: iso(NOW), interaction_id: 'ix', interaction_node: 'n1' },
    { id: 'run_other', created_at: iso(NOW + 1_000), interaction_id: 'ix', interaction_node: 'n2' }]
  assert.equal(nodeRunOf(node, 'ix', tree), 'run_2')
  assert.equal(nodeRunOf(node, 'ix', []), 'run_1')
  assert.equal(nodeRunOf({ id: 'n3', run_id: null }, 'ix', tree), null)
  // the thread's runs and the tree's rows, read without a copy of either
  assert.equal(nodeRunOf(node, 'ix', tree.slice(0, 1), tree.slice(1)), 'run_2')
})

test("a person's action (a command, a checkpoint) is no agent's current run: it never takes the main agent's watch away", () => {
  const index = presenceIndex({
    rows: [row('run_1', { at: NOW - 60_000, spawned_by: 'human', model: 'm' }), row('run_cmd', { at: NOW, collab: null, spawned_by: 'human_action', model: null }),
      row('ix:plan', { at: NOW, kind: 'plan', collab: null, model: 'd' }), row('ix:decide', { at: NOW, kind: 'decision', collab: null, model: null })],
    watches: [{ id: 'w', run_id: 'run_1', status: 'active' }], proposals: [{ run_id: 'run_1', status: 'pending' }],
  })
  assert.deepEqual(factsFor(index, 'run_1'), { pendingInput: false, pendingApproval: true, watching: true })
})

test("the page's records after a run's stream: its end at once (its time, its filtered answer), never live again", () => {
  const ended = endedRecord({ status: 'done', receipt: { finished_at: iso(NOW - 2_000), mechanical: {} }, answer_end: { reason: 'content_filter', attempts: 0 } }, iso(NOW))
  assert.equal(ended.finished_at, iso(NOW - 2_000))
  assert.equal(endingOf({ status: ended.status, receipt: ended.receipt }), 'blocked', "the event's answer_end kept on a receipt that lacked it")
  assert.equal(endedRecord({ status: 'error', error: 'boom' }, iso(NOW)).finished_at, iso(NOW), 'no time said: the moment the page heard it')
  const tree = [{ id: 'run_a', status: 'running', live: true, finished_at: null as string | null, receipt: null as unknown, error: null as string | null }, { id: 'run_b', status: 'running', live: true, finished_at: null as string | null, receipt: null as unknown, error: null as string | null }]
  const after = treeAfter(tree, 'run_a', [{ event: 'run_finished', data: { status: 'cancelled', receipt: { finished_at: iso(NOW) } } }])
  assert.equal(after[0]!.status, 'cancelled')
  assert.equal(after[0]!.live, false)
  assert.equal(after[1], tree[1])
  assert.equal(treeAfter(tree, 'run_a', [{ event: 'text_delta', data: {} }]), tree, 'nothing changed: the same tree')
  // a tree read before that end comes back still running: the end the page heard stands; the harness's own end is taken whole
  const stale = [{ ...tree[0]! }, { ...tree[1]! }]
  const merged = mergeTree(after, stale)
  assert.equal(merged[0]!.status, 'cancelled')
  assert.equal(merged[0]!.finished_at, iso(NOW))
  assert.equal(merged[1], stale[1])
  const fresh = [{ ...tree[0]!, status: 'error', live: false, finished_at: iso(NOW + 5), error: 'lost' }]
  assert.equal(mergeTree(after, fresh), fresh)
  assert.equal(rowAfter({ status: 'done', waiting: null }, [{ event: 'run_queued', data: { blocking_owner: 'run_w' } }]).status, 'done')
})

test("a director's plan row reads its interaction's own status: a restart's interruption blocks, the person's decision blocks, its steps at work leave it idle", () => {
  // the tree says `waiting` for all three (backend api/tree.ts); the interaction says which
  const planRow = { id: 'ix_1', status: 'waiting', finished_at: null }
  assert.equal(presenceOf(planRow, [], { groupStatus: 'interrupted' }), 'blocked')
  assert.equal(presenceOf(planRow, [], { groupStatus: 'waiting' }), 'blocked')
  assert.equal(presenceOf(planRow, [], { groupStatus: 'running' }), 'idle')
  assert.equal(presenceOf({ ...planRow, status: 'running' }, [], { groupStatus: 'planning' }), 'thinking')
  assert.equal(presenceOf({ ...planRow, status: 'running' }, [], { groupStatus: 'deciding' }), 'thinking')
  // ended: as a run ends (its row's own status and time)
  assert.equal(presenceOf({ id: 'ix_1', status: 'done', finished_at: iso(NOW - 1_000) }, [], { groupStatus: 'done' }, NOW), 'done')
  assert.equal(presenceOf({ id: 'ix_1', status: 'error', finished_at: iso(NOW - 1_000) }, [], { groupStatus: 'error' }, NOW), 'blocked')
  assert.equal(presenceOf(planRow, [], {}), 'idle', 'no interaction known: the row as it says')
  assert.equal(planPresence('done'), null)
})

test("a plan's placeholder for a step not yet run is no agent's current run", () => {
  const index = presenceIndex({
    rows: [row('run_1', { at: NOW - 60_000 }), row('ix:n1', { at: NOW, collab: null, spawned_by: 'plan', model: 'm' })],
    watches: [{ id: 'w', run_id: 'run_1', status: 'active' }],
  })
  assert.equal(factsFor(index, 'run_1').watching, true)
})

test("a replay never reads today's interaction into a past plan row: the row stands as it stood at the cursor", () => {
  const plan = { id: 'ix_1', kind: 'plan', interaction_id: 'ix_1', status: 'waiting', finished_at: null }
  const now = [{ id: 'ix_1', status: 'interrupted' }]
  assert.equal(planStatusFor(plan, now, false), 'interrupted')
  assert.equal(presenceOf(plan, [], { groupStatus: planStatusFor(plan, now, false) }), 'blocked')
  // replaying: no interaction status laid on it — the cursor's row alone (a plan row waiting: the director asleep)
  assert.equal(planStatusFor(plan, now, true), null)
  assert.equal(presenceOf(plan, [], { groupStatus: planStatusFor(plan, now, true) }), 'idle')
  assert.equal(planStatusFor({ kind: 'run', interaction_id: 'ix_1' }, now, false), null, 'only a plan row')
})
