import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CollaborationGraphSchema, type CollaborationGraph, type RunTreeRow } from '@oasis-code/contract'
import {
  causalOrder, countStatuses, edgeLine, edgesOfRun, graphAt, handoverOf, headOf, legacyGraph,
  participantOfRun, type CollabEdge, type DispatchItem } from '../src/state/collab.ts'
import { answerOf, EMPTY_COLLAB, openCollab, reduceCollab, wantsReload } from '../src/state/collabSync.ts'
import { cardIdForRun, cardOfParticipant, foldAgents } from '../src/state/lineage.ts'
import { cardsAtRest, REVEAL_WAIT_MS, settleReveals } from '../src/state/desk.ts'
import { botFor, CHATGPT_BOT, identityKey, sessionBots } from '../src/state/outline.ts'
import { continuedParticipant } from '../src/state/interaction.ts'
import { signatureOf } from '../src/state/sendKey.ts'

// ---- fixtures ------------------------------------------------------------------------------------------------------

const row = (id: string, over: Partial<RunTreeRow> = {}): RunTreeRow => ({
  id, session_id: 's', parent_run_id: null, resumes_run_id: null, spawned_by: 'human', label: null, model: 'scripted:a', status: 'done', live: false,
  created_at: `2026-10-14T03:00:${id.slice(-2).padStart(2, '0')}.000Z`, finished_at: `2026-10-14T03:00:${id.slice(-2).padStart(2, '0')}.500Z`, workspace_id: 'ws_session',
  user_text: `do ${id}`, user_text_head: `do ${id}`, work_order: null, receipt: null, error: null, usage: {}, depth: 0, relay_id: null, relay_step: null,
  interaction_id: null, interaction_node: null, plan_node_id: null, participant_id: null, participant_alias: null, participant_index: null, participant_name: null,
  depends_on: [], scheduled_by: null, kind: 'run', ...over,
})
const order = (label: string) => ({ label, prompt: label }) as unknown as RunTreeRow['work_order']

const recorded = (o: Record<string, unknown> = {}) => ({ actor: 'person', request: 'message', basis: 'recorded', ...o })
const collab = (pid: string | null, role: string | null, surface: string, o: Record<string, unknown> = {}, anchor: unknown = null) => ({
  participant_id: pid, participant_role: role, conversation_id: pid ? `cv_${pid.slice(3)}` : null, conversation_seq: 1, origin: recorded(o), placement: { surface, group: null, anchor }, basis: 'recorded',
})
const crun = (id: string, pid: string | null, role: string | null, surface: string, over: Record<string, unknown> = {}) => ({
  id, status: 'done', live: false, model: 'scripted:a', label: null, created_at: `2026-10-14T03:00:${id.slice(-2)}.000Z`, finished_at: null, workspace_id: null, resumes_run_id: null,
  interaction_id: null, interaction_node: null, relay_id: null, relay_step: null, user_text_head: `do ${id}`, final_text_chars: 100, error: null,
  collab: collab(pid, role, surface), ...over,
})
const participant = (id: string, role: string, over: Record<string, unknown> = {}) => ({
  id, session_id: 's', role, alias: null, label: id, model: 'scripted:a', group: null, introduced_by: null, current_conversation_id: `cv_${id.slice(3)}`, latest_run_id: null,
  state: 'idle', run_count: 1, basis: 'recorded', created_at: '2026-10-14T03:00:00.000Z', ...over,
})
const edge = (kind: string, from: string, to: string, meta: Record<string, unknown>, basis = 'recorded') =>
  ({ id: `eg_${kind}_${from}_${to}`, kind, from: { kind: 'run', id: from }, to: { kind: 'run', id: to }, basis, created_at: '2026-10-14T03:00:30.000Z', meta })

function graph(over: Partial<Record<keyof CollaborationGraph, unknown>> = {}): CollaborationGraph {
  return CollaborationGraphSchema.parse({
    session_id: 's', revision: 'r1', main_participant_id: 'pa_1111111111111111', actors: [{ kind: 'person' }],
    participants: [participant('pa_1111111111111111', 'main'), participant('pa_2222222222222222', 'member'), participant('pa_3333333333333333', 'separate', { latest_run_id: 'run_13' })],
    conversations: [{ id: 'cv_3333333333333333', session_id: 's', participant_id: 'pa_3333333333333333', forked_from_run_id: null, root_run_id: 'run_12', head_run_id: 'run_13', run_ids: ['run_12', 'run_13'], tool_surface: 'agent.v1', basis: 'recorded', created_at: '2026-10-14T03:00:12.000Z' }],
    groups: [], nodes: [],
    runs: [crun('run_10', 'pa_1111111111111111', 'main', 'thread'), crun('run_11', 'pa_2222222222222222', 'member', 'group'), crun('run_12', 'pa_3333333333333333', 'separate', 'card'), crun('run_13', 'pa_3333333333333333', 'separate', 'card')],
    edges: [
      edge('received', 'run_11', 'run_12', { via: 'dispatch', packet: 'whole', answer_chars: 5120, handed_chars: 5120, node: null, content_delivered: true }),
      edge('cited', 'run_10', 'run_12', { by: 'director', director_turn_id: 'dt_9', note: 'the failing test list', content_delivered: false }),
      edge('received', 'run_10', 'run_13', { via: 'relay_turn', packet: 'cut', answer_chars: 30000, handed_chars: 24000, node: null, content_delivered: true }),
      edge('after', 'run_11', 'run_13', { interaction_id: null, from_node: null, to_node: null }),
    ],
    thread_items: [{
      kind: 'dispatch', id: 'ti_dt_9', at: '2026-10-14T03:00:12.000Z', anchor: { kind: 'director_turn', id: 'dt_9' }, origin: { actor: 'director', request: 'separate', director_turn_id: 'dt_9' },
      entries: ['run_12', 'run_14'].map((id, i) => ({ run_id: id, participant_id: 'pa_3333333333333333', label: `task ${i}`, model: 'scripted:a', status: i ? 'running' : 'done', surface: 'card', user_text_head: 'x', finished_at: null, focus: { participant_id: 'pa_3333333333333333', run_id: id } })),
      counts: { queued: 0, running: 1, done: 1, error: 0, cancelled: 0, total: 2 },
    }, { kind: 'group', id: 'ti_ix', at: '2026-10-14T03:00:11.000Z', anchor: null, group: { kind: 'interaction', id: 'ix_1' }, status: 'done', counts: { queued: 0, running: 0, done: 1, error: 0, cancelled: 0, total: 1 } }],
    legacy: { projected_runs: 0, inferred_facts: 0, notes: [] },
    ...over,
  })
}

const legacyInput = (tree: RunTreeRow[], over: Record<string, unknown> = {}) => ({ sessionId: 's', sessionWorkspaceId: 'ws_session', tree, runs: [], interactions: [], relays: [], turns: [], ...over }) as Parameters<typeof legacyGraph>[0]

// ---- cited is never received ---------------------------------------------------------------------------------------

test('a cited run and a received run are two lists, never one; the cited words never say received, the received words say how much', () => {
  const g = graph()
  const { received, cited } = handoverOf(g, 'run_12')
  assert.deepEqual(received.map((e) => e.from.id), ['run_11'])
  assert.deepEqual(cited.map((e) => e.from.id), ['run_10'])
  const name = (e: { id: string }) => e.id
  const citedLine = edgeLine(cited[0]!, name)
  assert.match(citedLine, /cites run_10's answer/)
  assert.match(citedLine, /not handed over/)
  assert.doesNotMatch(citedLine, /received|in full/)
  assert.match(citedLine, /the failing test list/)
  assert.match(edgeLine(received[0]!, name), /received run_11's answer in full \(5,120 chars\)/)
  const cut = handoverOf(g, 'run_13').received[0]!
  assert.match(edgeLine(cut, name), /cut to 24,000 of 30,000 chars/)
  // scheduling is said as scheduling: nothing handed over
  const after = g.edges.find((e) => e.kind === 'after')!
  assert.match(edgeLine(after, name), /scheduling only, nothing handed over/)
  assert.equal(handoverOf(g, 'run_13').cited.length, 0)
  // a basis other than recorded is said
  assert.match(edgeLine({ ...after, basis: 'inferred' } as CollabEdge, name), /inferred$/)
  assert.match(edgeLine({ ...after, basis: 'projected' } as CollabEdge, name), /from older records$/)
  const io = edgesOfRun(g, 'run_11')
  assert.equal(io.outgoing.length, 2)
  assert.equal(io.incoming.length, 0)
})

// ---- the projection of older rows ----------------------------------------------------------------------------------

test('older rows: separate tasks and their follow-ups are one participant each, on cards, summarised in the thread; nothing is cited or received', () => {
  const tree = [
    row('run_01'),
    row('run_02', { work_order: order('lint'), workspace_id: 'ws_a', status: 'running', finished_at: null, live: true }),
    row('run_03', { work_order: order('docs'), workspace_id: 'ws_b' }),
    row('run_04', { work_order: order('docs'), workspace_id: 'ws_b', resumes_run_id: 'run_03' }),
    row('run_05', { spawned_by: 'human_action', model: null }),
  ]
  const g = legacyGraph(legacyInput(tree))
  const sep = g.participants.filter((p) => p.role === 'separate')
  assert.equal(sep.length, 2)
  assert.equal(participantOfRun(g, 'run_04')?.id, participantOfRun(g, 'run_03')?.id)       // the follow-up is the same participant
  assert.equal(participantOfRun(g, 'run_05'), null)                                        // a person's action: a record, no participant
  assert.equal(g.runs.find((r) => r.id === 'run_05')!.collab.placement.surface, 'record')
  assert.equal(g.runs.find((r) => r.id === 'run_02')!.collab.placement.surface, 'card')
  assert.ok(g.edges.some((e) => e.kind === 'continues' && e.from.id === 'run_03' && e.to.id === 'run_04'))
  assert.ok(!g.edges.some((e) => e.kind === 'cited' || e.kind === 'received'), 'an older record never yields a citation or a handover')
  // a person's dispatches: one item each, at its own time, counted by state
  const items = g.thread_items.filter((t): t is DispatchItem => t.kind === 'dispatch')
  assert.deepEqual(items.map((i) => i.entries.map((e) => e.run_id)), [['run_02'], ['run_03'], ['run_04']])
  assert.deepEqual([items[0]!.counts.running, items[2]!.counts.done, items[2]!.origin.request], [1, 1, 'resume'])
  assert.equal(headOf(g, participantOfRun(g, 'run_03')!.id), 'run_04')
})

test("older rows: a director turn's dispatches are one summary at the turn, counted by state; the turn is the anchor", () => {
  const tree = [row('run_01'), row('run_02', { work_order: order('a') }), row('run_03', { work_order: order('b'), status: 'error' }), row('run_04', { work_order: order('c'), status: 'queued', finished_at: null })]
  const g = legacyGraph(legacyInput(tree, { turns: [{ id: 'dt_1', dispatched_run_ids: ['run_02', 'run_03', 'run_04'], created_at: '2026-10-14T03:00:01.500Z' }] }))
  const [item] = g.thread_items.filter((t): t is DispatchItem => t.kind === 'dispatch')
  assert.equal(item!.anchor?.kind, 'director_turn')
  assert.equal(item!.origin.actor, 'director')
  assert.deepEqual(item!.counts, { queued: 1, running: 0, done: 1, error: 1, cancelled: 0, total: 3 })
  assert.ok(g.edges.some((e) => e.kind === 'dispatched' && e.from.kind === 'director_turn' && e.to.id === 'run_03'))
})

test("older rows: a group's steps are its members; a step after another is scheduling (after), never a handover", () => {
  const ix = {
    id: 'ix_1', status: 'done', controller: 'fixed', template: 'discussion', then: 'stop', workspace_policy: 'legacy', participants: [{ id: 'A', label: 'A', model: 'scripted:a' }, { id: 'B', label: 'B', model: 'scripted:a' }],
    created_at: '2026-10-14T03:00:00.000Z', finished_at: null, reason: null, runs_started: 3, budget: { max_runs: 6, concurrency: 2 },
    nodes: [
      { id: 'a1', participant: 'A', depends_on: [], receives: [], run_ids: ['run_02'], run_id: 'run_02', status: 'done', workspace: 'own', wave: 1 },
      { id: 'b1', participant: 'B', depends_on: [], receives: [], run_ids: ['run_03'], run_id: 'run_03', status: 'done', workspace: 'own', wave: 1 },
      { id: 'a2', participant: 'A', depends_on: ['a1', 'b1'], receives: ['b1'], run_ids: ['run_05'], run_id: 'run_05', status: 'done', workspace: 'a1', wave: 2 },
      { id: 'b2', participant: 'B', depends_on: ['b1'], receives: [], run_ids: [], run_id: null, status: 'queued', workspace: 'b1', wave: 2 },
    ],
  }
  const node = (id: string, n: string, alias: string, ws: string) => row(id, { interaction_id: 'ix_1', interaction_node: n, participant_alias: alias, participant_id: `ix_1:${alias}`, workspace_id: ws })
  const tree = [row('run_01'), node('run_02', 'a1', 'A', 'ws_a'), node('run_03', 'b1', 'B', 'ws_b'), node('run_05', 'a2', 'A', 'ws_a')]
  const g = legacyGraph(legacyInput(tree, { interactions: [ix] }))
  const a = participantOfRun(g, 'run_02')!
  assert.equal(a.role, 'member')
  assert.equal(participantOfRun(g, 'run_05')!.id, a.id)                                       // the same member across its steps
  assert.notEqual(participantOfRun(g, 'run_03')!.id, a.id)                                    // never merged by model
  const after = g.edges.filter((e) => e.kind === 'after').map((e) => `${e.from.id}>${e.to.id}`).sort()
  assert.deepEqual(after, ['run_02>run_05', 'run_03>run_05'])
  assert.ok(!g.edges.some((e) => e.kind === 'received'))                                       // receives b1 is not projected as a handover
  assert.deepEqual(g.nodes.filter((n) => n.run_ids.length === 0).map((n) => n.node_id), ['b2'])  // the queued step is visible, not a run
  assert.equal(g.runs.find((r) => r.id === 'run_02')!.collab.placement.surface, 'group')
})

test("older rows: the thread's next message after a member's run (the session folder) stays the main agent's; a /resume follow-up in the member's own folder is the member's, inferred", () => {
  const node = row('run_02', { interaction_id: 'ix_1', interaction_node: 'a1', participant_alias: 'A', participant_id: 'ix_1:A', workspace_id: 'ws_a' })
  const tree = [row('run_01'), node, row('run_03', { resumes_run_id: 'run_02', workspace_id: 'ws_session' }), row('run_04', { resumes_run_id: 'run_02', workspace_id: 'ws_a' })]
  const g = legacyGraph(legacyInput(tree))
  assert.equal(participantOfRun(g, 'run_03')!.role, 'main')
  assert.ok(g.edges.some((e) => e.kind === 'forks' && e.to.id === 'run_03'))
  const follow = g.runs.find((r) => r.id === 'run_04')!
  assert.equal(follow.collab.participant_id, participantOfRun(g, 'run_02')!.id)
  assert.equal(follow.collab.basis, 'inferred')
  const cont = g.edges.find((e) => e.kind === 'continues' && e.to.id === 'run_04')!
  assert.equal(cont.basis, 'inferred')
})

test('a row that carries collab keeps what it says (a v25 tree whose graph route failed)', () => {
  const tree = [row('run_01', { collab: collab('pa_1111111111111111', 'main', 'thread') as RunTreeRow['collab'] }), row('run_02', { work_order: order('x'), collab: collab('pa_3333333333333333', 'separate', 'card') as RunTreeRow['collab'] })]
  const g = legacyGraph(legacyInput(tree))
  assert.equal(participantOfRun(g, 'run_02')!.id, 'pa_3333333333333333')
  assert.equal(g.main_participant_id, 'pa_1111111111111111')
})

test('followups in the three shapes keep the participant: no interaction id; an interaction id without a node; a follow-up node', () => {
  const ix = { id: 'ix_1', participants: [{ id: 'A', label: 'A', model: 'm' }], nodes: [{ id: 'a1', participant: 'A', run_ids: ['run_a'], run_id: 'run_a' }, { id: 'fu-1', participant: 'A', kind: 'followup', run_ids: ['run_f'], run_id: 'run_f' }] } as never
  const runs = [
    { id: 'run_a', resumes_run_id: null, interaction_id: 'ix_1', interaction_node: 'a1' },
    { id: 'run_old', resumes_run_id: 'run_a', interaction_id: null, interaction_node: null },
    { id: 'run_mid', resumes_run_id: 'run_a', interaction_id: 'ix_1', interaction_node: null },
  ]
  assert.equal(continuedParticipant([ix], runs, runs[1]!)!.participant.id, 'A')
  assert.equal(continuedParticipant([ix], runs, runs[2]!)!.participant.id, 'A')
})

test("a participant's later run is on its first run's card (not a card of its own); the stable participant joins groups; two on one model stay two", () => {
  const steps = [
    row('run_01'),
    row('run_02', { interaction_id: 'ix_1', interaction_node: 'a1', participant_id: 'ix_1:A', participant_alias: 'A', participant_index: 0 }),
    row('run_03', { interaction_id: 'ix_1', interaction_node: 'a2', participant_id: 'ix_1:A', participant_alias: 'A', participant_index: 0 }),
    row('run_04', { interaction_id: 'ix_1', interaction_node: 'b1', participant_id: 'ix_1:B', participant_alias: 'B', participant_index: 1 }),
  ]
  const agents = foldAgents(steps)
  assert.equal(cardIdForRun(agents, 'run_03'), 'run:run_02')                                    // the bug: not run:run_03
  assert.equal(cardIdForRun(agents, 'run_04'), 'run:run_04')
  assert.equal(cardIdForRun(agents, 'run_99'), null)                                            // not in the tree yet: waits
  // v25: the stable participant is the key — one card across two groups when the harness names the same id
  const pa = (id: string) => collab(id, 'member', 'group') as RunTreeRow['collab']
  const stable = [
    row('run_05', { interaction_id: 'ix_1', participant_id: 'ix_1:A', collab: pa('pa_aaaaaaaaaaaaaaaa') }),
    row('run_06', { interaction_id: 'ix_2', participant_id: 'ix_2:A', collab: pa('pa_aaaaaaaaaaaaaaaa') }),
    row('run_07', { interaction_id: 'ix_2', participant_id: 'ix_2:B', collab: pa('pa_bbbbbbbbbbbbbbbb') }),
  ]
  const cards = foldAgents(stable)
  assert.equal(cardIdForRun(cards, 'run_06'), 'run:run_05')
  assert.equal(cardIdForRun(cards, 'run_07'), 'run:run_07')                                    // same model, another id: its own card
  assert.equal(cardOfParticipant(cards, 'pa_bbbbbbbbbbbbbbbb'), 'run:run_07')
})

test('a separate task wears one bot across its runs (keyed by its participant); the main agent the session\'s', () => {
  const sep = collab('pa_3333333333333333', 'separate', 'card') as RunTreeRow['collab']
  const a = row('run_02', { work_order: order('x'), collab: sep })
  const b = row('run_03', { work_order: order('x'), collab: sep })
  assert.equal(botFor(a), botFor(b))
  assert.equal(identityKey(a), 'participant:pa_3333333333333333')
  assert.equal(identityKey(row('run_04', { collab: collab('pa_1', 'main', 'thread') as RunTreeRow['collab'] })), 'session:s')
  assert.equal(identityKey(row('run_05', { work_order: order('y') })), 'run_05')               // an older row: its own id
})

test('a jump that comes before its card waits for it, shows it as soon as it exists, and is given up after a while; a card a jump brought back is not shelved', () => {
  const pending = { run_new: 1000, run_old: 0 }
  const none = settleReveals(pending, () => null, 2000)
  assert.deepEqual(none, { show: [], expired: [] })
  const later = settleReveals(pending, (id) => (id === 'run_new' ? 'run:run_root' : null), REVEAL_WAIT_MS + 1)
  assert.deepEqual(later.show, [{ runId: 'run_new', windowId: 'run:run_root' }])
  assert.deepEqual(later.expired, ['run_old'])
  const windows = { 'run:a': { id: 'run:a', kind: 'run' as const, runId: 'a', z: 1, min: false }, 'run:b': { id: 'run:b', kind: 'run' as const, runId: 'b', z: 2, min: false } }
  assert.deepEqual(cardsAtRest(windows, () => true, { 'run:b': 1 }), ['run:a'])
})

// ---- replay -------------------------------------------------------------------------------------------------------

test("the replay's relations: what existed by the cursor, states from the replayed rows, summaries counted again", () => {
  const g = graph()
  const at = graphAt(g, Date.parse('2026-10-14T03:00:12.000Z'), (id) => (id === 'run_12' ? 'running' : undefined))
  assert.deepEqual(at.runs.map((r) => r.id), ['run_10', 'run_11', 'run_12'])
  assert.equal(at.runs.find((r) => r.id === 'run_12')!.status, 'running')
  assert.ok(!at.edges.some((e) => e.to.id === 'run_13'))
  assert.equal(at.edges.length, 0)                                                              // edges recorded later are not shown earlier
  const item = at.thread_items.find((t) => t.kind === 'dispatch')!
  assert.equal(item.kind === 'dispatch' && item.entries.length, 1)
  assert.equal(item.kind === 'dispatch' && item.counts.running, 1)
})

// ---- reading the graph: 304, an older harness, a failure --------------------------------------------------------

test('the graph read: 304 keeps it; 404/405/501 is an older harness, silently; 500 keeps what was read, said once, retried; another session\'s answer is dropped', () => {
  const g = graph()
  let s = openCollab('s')
  const first = reduceCollab(s, 's', answerOf({ ok: true, value: g }))
  s = first.state
  assert.equal(s.status, 'graph')
  assert.equal(s.revision, 'r1')
  s = reduceCollab(s, 's', answerOf({ ok: true, value: { unchanged: true } })).state
  assert.equal(s.graph, g)
  const fail1 = reduceCollab(s, 's', answerOf({ ok: false, status: 500, message: 'boom' }))
  assert.equal(fail1.state.graph, g)                                                          // nothing on show is cleared
  assert.match(fail1.tell!, /\(500\): boom/)
  const fail2 = reduceCollab(fail1.state, 's', answerOf({ ok: false, status: 500, message: 'boom' }))
  assert.equal(fail2.tell, null)                                                              // said once, not on every retry
  assert.equal(wantsReload(fail2.state, 'r1', false), true)                                   // a failed read is retried on the tick
  const ok = reduceCollab(fail2.state, 's', answerOf({ ok: true, value: { ...g, revision: 'r2' } }))
  assert.equal(ok.state.error, null)
  assert.equal(ok.state.told, false)
  const net = reduceCollab(ok.state, 's', answerOf({ ok: false, status: null, message: 'fetch failed' }))
  assert.equal(net.tell, null)                                                                // the connection's to say
  for (const status of [404, 405, 501]) {
    const old = reduceCollab(openCollab('s'), 's', answerOf({ ok: false, status, message: 'not found' }))
    assert.equal(old.state.status, 'legacy')
    assert.equal(old.tell, null)
    assert.equal(wantsReload(old.state, 'r9', true), false)                                   // an older harness is not asked again
  }
  const other = reduceCollab(openCollab('s2'), 's', answerOf({ ok: true, value: g }))
  assert.equal(other.state.graph, null)                                                       // an answer for a session left
  assert.equal(wantsReload(EMPTY_COLLAB, 'r1', true), false)
  assert.equal(wantsReload(ok.state, 'r2', false), false)                                     // the revision held: nothing to read
  assert.equal(wantsReload(ok.state, 'r3', false), true)
  assert.equal(wantsReload(ok.state, undefined, true), true)                                  // no revision field: on change
  assert.equal(wantsReload(ok.state, undefined, false), false)
})

test('a separate task, a main message and a discussion are three keys for the same words; the same message again is the same key', () => {
  const main = signatureOf('fix it', [], ['agent', 'scripted:a', null, {}, undefined, null, null])
  const sep = signatureOf('fix it', [], ['separate', 'scripted:a', null, 'isolated'])
  const discussion1 = signatureOf('fix it', [], ['agent', 'scripted:a', null, {}, undefined, 'discussion', 1])
  const discussion2 = signatureOf('fix it', [], ['agent', 'scripted:a', null, {}, undefined, 'discussion', 2])
  assert.equal(new Set([main, sep, discussion1, discussion2]).size, 4)
  assert.equal(sep, signatureOf('fix it', [], ['separate', 'scripted:a', null, 'isolated']))
})

test('the discussion way: its label, its chip counts the first answers and each exchange, its hint says how answers move', async () => {
  const { ORCHESTRATIONS, orchestrationChipText, orchestrationHint, orchestrationLabel } = await import('../src/state/interaction.ts')
  assert.deepEqual(ORCHESTRATIONS, ['director', 'independent', 'discussion', 'turns'])
  assert.equal(orchestrationLabel('discussion'), 'Discuss')
  assert.equal(orchestrationChipText('discussion', 2, 1, 6), 'Discuss · 1 exchange · 4 runs')
  assert.equal(orchestrationChipText('discussion', 3, 2, 6), 'Discuss · 2 exchanges · 9 runs')
  assert.match(orchestrationHint('discussion'), /own copy/)
  assert.match(orchestrationHint('discussion', true), /in place/)
})

test("the desk's reveal: a shelved card comes back, to the front, its run in focus; asked again it scrolls again; a waiting jump is dropped once shown", async () => {
  const { useDesk } = await import('../src/state/desk.ts')
  const desk = useDesk.getState()
  desk.openSession('s-reveal')
  desk.ensure('run:run_a', 'run', 'run_a')
  desk.ensure('run:run_b', 'run', 'run_b')
  desk.setMin('run:run_a', true)
  desk.waitReveal('run_a2', 1)
  useDesk.getState().reveal('run:run_a', 'run_a2')
  const after = useDesk.getState()
  assert.equal(after.windows['run:run_a']!.min, false)
  assert.equal(after.windows['run:run_a']!.z, after.zTop)                                      // at the front
  assert.deepEqual({ ...after.focused, nonce: 0 }, { windowId: 'run:run_a', runId: 'run_a2', nonce: 0 })
  assert.equal('run_a2' in after.pendingReveal, false)
  assert.ok('run:run_a' in after.revealed)
  const nonce = after.focused!.nonce
  useDesk.getState().reveal('run:run_a', 'run_a2')
  assert.equal(useDesk.getState().focused!.nonce, nonce + 1)
  // a card that does not exist yet is made (the jump knows its window)
  useDesk.getState().reveal('run:run_c', 'run_c')
  assert.equal(useDesk.getState().windows['run:run_c']!.runId, 'run_c')
  useDesk.getState().openSession('s-other')
  assert.equal(useDesk.getState().focused, null)                                               // another session: nothing carried over
})

// ---- older rows: conversations by the resume chain ------------------------------------------------------------------

test('older rows: a fresh message opens its own conversation; resuming the head continues it; resuming an earlier run branches; the main agent is never merged with a member by name', () => {
  const tree = [
    row('run_01'),
    row('run_02', { resumes_run_id: 'run_01' }),                                               // continues
    row('run_03'),                                                                              // fresh: a new conversation
    row('run_04', { resumes_run_id: 'run_01' }),                                               // an earlier run: a branch
    row('run_05', { interaction_id: 'ix_1', interaction_node: 'a1', participant_alias: 'A', participant_id: 'ix_1:A', participant_name: 'the session\'s agent', workspace_id: 'ws_a' }),
  ]
  const g = legacyGraph(legacyInput(tree))
  const conv = (id: string) => g.runs.find((r) => r.id === id)!.collab.conversation_id
  assert.equal(conv('run_02'), conv('run_01'))
  assert.notEqual(conv('run_03'), conv('run_01'))
  assert.notEqual(conv('run_04'), conv('run_01'))
  assert.notEqual(conv('run_04'), conv('run_03'))
  const branch = g.edges.find((e) => e.to.id === 'run_04')!
  assert.equal(branch.kind, 'forks')
  assert.equal(branch.kind === 'forks' && branch.meta.reason, 'branch')
  assert.equal(g.conversations.find((c) => c.id === conv('run_04'))!.forked_from_run_id, 'run_01')
  assert.equal(g.conversations.find((c) => c.id === conv('run_03'))!.forked_from_run_id, null)
  // every run's conversation is one of the graph's conversations, in order
  for (const r of g.runs) if (r.collab.conversation_id) assert.ok(g.conversations.find((c) => c.id === r.collab.conversation_id)!.run_ids.includes(r.id))
  assert.deepEqual(g.conversations.find((c) => c.id === conv('run_01'))!.run_ids, ['run_01', 'run_02'])
  // a member named like the main agent stays a member of its own
  assert.equal(participantOfRun(g, 'run_05')!.role, 'member')
  assert.notEqual(participantOfRun(g, 'run_05')!.id, participantOfRun(g, 'run_01')!.id)
  // the page's ids are its own, never a harness's
  for (const p of g.participants) assert.match(p.id, /^legacy:/)
  for (const c of g.conversations) assert.doesNotMatch(c.id, /^cv_/)
})

test('older rows: two runs that resumed one run in the same millisecond: one continues, the other is a branch — inferred, the record cannot say which came first', () => {
  const tree = [row('run_01'), row('run_02', { resumes_run_id: 'run_01', created_at: '2026-10-14T03:00:09.000Z' }), row('run_03', { resumes_run_id: 'run_01', created_at: '2026-10-14T03:00:09.000Z' })]
  const g = legacyGraph(legacyInput(tree))
  const fork = g.edges.find((e) => e.kind === 'forks')!
  assert.equal(fork.basis, 'inferred')
  assert.equal(g.edges.filter((e) => e.kind === 'continues').length, 1)
})

test('older rows read out of order (a follow-up stamped before its run): the resume chain goes first, never the clock', () => {
  const ordered = [row('run_01'), row('run_02', { resumes_run_id: 'run_01' }), row('run_03', { resumes_run_id: 'run_02' })]
  const skewed = [{ ...ordered[2]!, created_at: '2026-10-14T03:00:00.000Z' }, ordered[1]!, ordered[0]!]
  assert.deepEqual(causalOrder(skewed).map((r) => r.id), ['run_01', 'run_02', 'run_03'])
  const g = legacyGraph(legacyInput(skewed))
  const conv = g.conversations.find((c) => c.run_ids.includes('run_01'))!
  assert.deepEqual(conv.run_ids, ['run_01', 'run_02', 'run_03'])
  assert.equal(conv.head_run_id, 'run_03')
  assert.deepEqual(g.edges.filter((e) => e.kind === 'continues').map((e) => e.to.id).sort(), ['run_02', 'run_03'])
})

test('rows that carry collab while the graph route is missing: their participant, role, conversation, group and basis stand as said', () => {
  const c = (pid: string, role: string, cv: string, basis: string, group: unknown = null) => ({ ...collab(pid, role, 'card'), conversation_id: cv, basis, placement: { surface: role === 'member' ? 'group' : 'card', group, anchor: null } }) as RunTreeRow['collab']
  const tree = [
    row('run_01', { work_order: order('x'), collab: c('pa_3333333333333333', 'separate', 'cv_aaaaaaaaaaaaaaaa', 'recorded') }),
    row('run_02', { work_order: order('x'), resumes_run_id: 'run_01', collab: c('pa_3333333333333333', 'separate', 'cv_aaaaaaaaaaaaaaaa', 'recorded') }),
    row('run_03', { work_order: order('x'), resumes_run_id: 'run_01', collab: c('pa_3333333333333333', 'separate', 'cv_bbbbbbbbbbbbbbbb', 'recorded') }),
    row('run_04', { interaction_id: 'ix_1', collab: c('pa_4444444444444444', 'member', 'cv_cccccccccccccccc', 'inferred', { kind: 'interaction', id: 'ix_1' }) }),
  ]
  const g = legacyGraph(legacyInput(tree))
  assert.deepEqual(g.conversations.map((x) => x.id).sort(), ['cv_aaaaaaaaaaaaaaaa', 'cv_bbbbbbbbbbbbbbbb', 'cv_cccccccccccccccc'])
  assert.deepEqual(g.conversations.find((x) => x.id === 'cv_aaaaaaaaaaaaaaaa')!.run_ids, ['run_01', 'run_02'])
  assert.equal(g.conversations.find((x) => x.id === 'cv_bbbbbbbbbbbbbbbb')!.forked_from_run_id, 'run_01')
  const fork = g.edges.find((e) => e.to.id === 'run_03')!
  assert.equal(fork.kind === 'forks' && fork.meta.reason, 'branch')
  const member = g.participants.find((p) => p.id === 'pa_4444444444444444')!
  assert.equal(member.basis, 'inferred')
  assert.deepEqual(member.group, { kind: 'interaction', id: 'ix_1' })
  assert.equal(g.participants.find((p) => p.id === 'pa_3333333333333333')!.basis, 'recorded')
  assert.equal(headOf(g, 'pa_3333333333333333'), 'run_03')                                    // its latest conversation's head
  assert.equal(g.legacy.projected_runs, 0)                                                     // nothing projected by the page
})

test("older rows: who ran after whom is read off a step's run list as it is now — inferred; a message from 'human' is the person's, inferred; two groups' A on one model are two participants", () => {
  const node = (id: string, ix: string, n: string) => row(id, { interaction_id: ix, interaction_node: n, participant_alias: 'A', participant_id: `${ix}:A`, workspace_id: `ws_${id}` })
  const ix = (id: string, nodes: unknown[]) => ({ id, status: 'done', controller: 'fixed', template: null, then: 'stop', workspace_policy: 'legacy', participants: [{ id: 'A', label: 'A', model: 'scripted:a' }], created_at: 't', finished_at: null, reason: null, runs_started: 1, budget: { max_runs: 4, concurrency: 2 }, nodes })
  const n = (id: string, runs: string[], deps: string[] = []) => ({ id, participant: 'A', depends_on: deps, receives: [], run_ids: runs, run_id: runs.at(-1) ?? null, status: 'done', workspace: 'own', wave: 1 })
  const tree = [row('run_01'), node('run_02', 'ix_1', 'a1'), node('run_03', 'ix_1', 'a2'), node('run_04', 'ix_2', 'a1')]
  const g = legacyGraph(legacyInput(tree, { interactions: [ix('ix_1', [n('a1', ['run_02']), n('a2', ['run_03'], ['a1'])]), ix('ix_2', [n('a1', ['run_04'])])] }))
  const after = g.edges.find((e) => e.kind === 'after')!
  assert.equal(after.basis, 'inferred')
  assert.match(edgeLine(after, (e) => e.id), /inferred$/)
  const person = g.runs.find((r) => r.id === 'run_01')!.collab.origin
  assert.equal(person.actor, 'person')
  assert.equal(person.basis, 'inferred')
  assert.notEqual(participantOfRun(g, 'run_02')!.id, participantOfRun(g, 'run_04')!.id)
  assert.equal(participantOfRun(g, 'run_02')!.id, participantOfRun(g, 'run_03')!.id)
})

// ---- one identity everywhere ----------------------------------------------------------------------------------------

test("a participant the harness names keeps one bot across groups and any place in them; two participants on one model are two bots; without ids a member wears the bot its handle picks", async () => {
  const { identityTable, setIdentities, memberBot, participantBotOf, BOTS } = await import('../src/state/outline.ts')
  const m = (pid: string, ix: string) => ({ ...collab(pid, 'member', 'group'), placement: { surface: 'group', group: { kind: 'interaction', id: ix }, anchor: null } }) as RunTreeRow['collab']
  const rows = [
    row('run_01', { collab: collab('pa_1111111111111111', 'main', 'thread') as RunTreeRow['collab'] }),
    row('run_02', { interaction_id: 'ix_1', participant_alias: 'A', participant_index: 0, collab: m('pa_aaaaaaaaaaaaaaaa', 'ix_1') }),
    row('run_03', { interaction_id: 'ix_1', participant_alias: 'B', participant_index: 1, collab: m('pa_bbbbbbbbbbbbbbbb', 'ix_1') }),
    // the same participant in a second group, at another place there
    row('run_04', { interaction_id: 'ix_2', participant_alias: 'C', participant_index: 1, collab: m('pa_aaaaaaaaaaaaaaaa', 'ix_2') }),
    row('run_05', { interaction_id: 'ix_2', participant_alias: 'D', participant_index: 0, collab: m('pa_dddddddddddddddd', 'ix_2') }),
  ]
  setIdentities(identityTable(rows, 's'))
  try {
    const bot = (id: string) => botFor(rows.find((r) => r.id === id)!)
    // the rail draws the same bots the thread does, from the session's agents in the order they joined
    assert.deepEqual(sessionBots('s', [
      { kind: 'main', participant_id: null, model: null },
      ...['pa_aaaaaaaaaaaaaaaa', 'pa_bbbbbbbbbbbbbbbb', 'pa_dddddddddddddddd'].map((id) => ({ kind: 'participant' as const, participant_id: id, model: 'scripted:a' })),
      { kind: 'chatgpt', participant_id: null, model: null },
    ]), [bot('run_01'), bot('run_02'), bot('run_03'), bot('run_05'), CHATGPT_BOT])
    assert.deepEqual(sessionBots('s', undefined), [bot('run_01')])                              // nothing known: the main agent's
    assert.equal(bot('run_02'), bot('run_04'))                                                 // one participant, one bot
    assert.equal(participantBotOf('pa_aaaaaaaaaaaaaaaa'), bot('run_02'))
    assert.equal(memberBot({ kind: 'interaction', id: 'ix_1' }, 'A', 'scripted:a'), bot('run_02'))   // the strip's bot, by alias
    // the same participant read through its second group's strip (another alias, another place there): the same bot,
    // not the bot of its place in that group
    assert.equal(memberBot({ kind: 'interaction', id: 'ix_2' }, 'C', 'scripted:a'), bot('run_02'))
    assert.equal(memberBot({ kind: 'interaction', id: 'ix_2' }, 'D', 'scripted:a'), bot('run_05'))
    assert.notEqual(bot('run_02'), bot('run_03'))                                              // two participants, one model: two bots
    assert.notEqual(bot('run_04'), bot('run_05'))
    assert.equal(new Set(['run_02', 'run_03', 'run_05'].map(bot)).size, 3)
    assert.notEqual(bot('run_02'), bot('run_01'))                                              // never the main agent's
    // a later participant never moves an earlier one's bot
    const before = bot('run_03')
    setIdentities(identityTable([...rows, row('run_06', { interaction_id: 'ix_3', participant_alias: 'A', participant_index: 0, collab: m('pa_eeeeeeeeeeeeeeee', 'ix_3') })], 's'))
    assert.equal(bot('run_03'), before)
    // no stable id: a bot of the pool its handle in its group picks, the same each time
    setIdentities(null)
    const loose = memberBot({ kind: 'interaction', id: 'ix_9' }, 'A', 'scripted:a')
    assert.ok(BOTS.includes(loose as typeof BOTS[number]))
    assert.equal(memberBot({ kind: 'interaction', id: 'ix_9' }, 'A', 'scripted:a'), loose)
  } finally { setIdentities(null) }
})

test("participants' bots are picked by their own ids from the pool: none twice, never the main agent's, each of a colour family none other wears while one is left; the same ids pick the same bots", async () => {
  const { identityTable, colourFamily, BOTS } = await import('../src/state/outline.ts')
  const member = (i: number) => row(`run_${String(i).padStart(2, '0')}`, { created_at: `2026-10-18T00:00:${String(i).padStart(2, '0')}.000Z`, interaction_id: 'ix_1', participant_alias: `p${i}`, participant_index: i,
    collab: { ...collab(`pa_${String(i).padStart(16, '0')}`, 'member', 'group'), placement: { surface: 'group', group: { kind: 'interaction', id: 'ix_1' }, anchor: null } } as RunTreeRow['collab'] })
  const main = row('run_main', { collab: collab('pa_main000000000000', 'main', 'thread') as RunTreeRow['collab'] })
  const six = [main, ...Array.from({ length: 6 }, (_, i) => member(i + 1))]
  const table = identityTable(six, 's_colour')
  const bots = [...table.byParticipant.values()]
  assert.equal(bots.length, 6)
  assert.equal(new Set(bots).size, 6)
  const mainBot = botFor({ ...main, session_id: 's_colour' })
  assert.ok(mainBot && !bots.includes(mainBot), `${mainBot} is the main agent's`)
  assert.equal(new Set(bots.map(colourFamily)).size, 6, 'six participants, six colour families')
  assert.deepEqual([...identityTable(six, 's_colour').byParticipant.values()], bots)
  // more participants than bots: every bot worn once before any is worn again
  const many = [main, ...Array.from({ length: BOTS.length + 2 }, (_, i) => member(i + 1))]
  const all = [...identityTable(many, 's_colour').byParticipant.values()]
  assert.equal(new Set(all.slice(0, BOTS.length - 1)).size, BOTS.length - 1)
})

// ---- a director's call: what it cited, what it handed over --------------------------------------------------------

test("a director's call: the runs it cites and the runs it hands over, apart — at the top and per step; any other shape is ignored, the call untouched", async () => {
  const { callReferences, hasCallReferences } = await import('../src/state/director.ts')
  const args = {
    text: 'go', cites: [{ run_id: 'run_a1', note: 'the list' }, 'run_b2', { run_id: 'not a run' }, 7, null], receive_run_ids: ['run_c3', 42, 'latest'],
    nodes: [{ id: 'x1', cites: ['run_d4'], receive_runs: ['run_e5'] }, { id: 'x2', receive_run_ids: ['run_f6'] }, { id: 'x3' }, 'junk'],
  }
  const frozen = JSON.stringify(args)
  const refs = callReferences({ args })
  assert.deepEqual(refs.cites, [{ run_id: 'run_a1', note: 'the list' }, { run_id: 'run_b2', note: null }])
  assert.deepEqual(refs.receives, ['run_c3'])
  assert.deepEqual(refs.steps, [{ step: 'x1', cites: [{ run_id: 'run_d4', note: null }], receives: ['run_e5'] }, { step: 'x2', cites: [], receives: ['run_f6'] }])
  assert.equal(JSON.stringify(args), frozen)
  for (const odd of [null, undefined, {}, { cites: 'run_a1' }, { nodes: 'x' }]) assert.equal(hasCallReferences(callReferences({ args: odd as never })), false)
})

// ---- a card brings the asked run into view ------------------------------------------------------------------------

test("a card's focus: on the asked run as soon as its turn is there, once more when the turns above it are read, never again for that ask; a new ask starts over", async () => {
  const { focusStep } = await import('../src/state/desk.ts')
  const ask = { windowId: 'run:run_01', runId: 'run_02', nonce: 4 }
  assert.equal(focusStep(null, ask, false, false), null)                                      // not on the card yet: wait
  assert.equal(focusStep(null, ask, true, false), 'first')
  assert.equal(focusStep({ nonce: 4, phase: 'first' }, ask, true, false), null)                // a stream growing: nothing
  assert.equal(focusStep({ nonce: 4, phase: 'first' }, ask, true, true), 'settled')            // the transcripts read: once more
  assert.equal(focusStep({ nonce: 4, phase: 'settled' }, ask, true, true), null)
  assert.equal(focusStep(null, ask, true, true), 'settled')                                   // all there already: one scroll
  assert.equal(focusStep({ nonce: 4, phase: 'settled' }, { ...ask, nonce: 5 }, true, true), 'settled')
  assert.equal(focusStep(null, null, true, true), null)
  // an older resume chain: the follow-up is on its root's card, and the jump asks for the follow-up itself, not the newest
  const agents = foldAgents([row('run_01', { work_order: order('x') }), row('run_02', { work_order: order('x'), resumes_run_id: 'run_01' }), row('run_03', { work_order: order('x'), resumes_run_id: 'run_02' })])
  assert.equal(cardIdForRun(agents, 'run_02'), 'run:run_01')
  const { useDesk } = await import('../src/state/desk.ts')
  useDesk.getState().openSession('s-focus')
  useDesk.getState().reveal('run:run_01', 'run_02')
  assert.equal(useDesk.getState().focused!.runId, 'run_02')
  // a jump waiting for its card is not carried to another session
  useDesk.getState().waitReveal('run_99', Date.now())
  useDesk.getState().openSession('s-focus-2')
  assert.deepEqual(useDesk.getState().pendingReveal, {})
  assert.equal(useDesk.getState().focused, null)
})

test('the workspace policy words: what each means for this project — never isolated for a shared folder', async () => {
  const { groupPolicyHint, groupPolicyLabel } = await import('../src/state/interaction.ts')
  assert.equal(groupPolicyLabel('legacy', 'direct'), 'Shared folder')
  assert.match(groupPolicyHint('legacy', 'direct'), /in this folder, edited in place/)
  assert.doesNotMatch(groupPolicyHint('legacy', 'direct'), /isolat/i)
  assert.match(groupPolicyHint('isolated', 'direct'), /output folder of its own.*read-only.*Keep cannot apply/)
  assert.match(groupPolicyHint('isolated', 'attached'), /attached folder live, read-only/)
  assert.match(groupPolicyHint('legacy', 'snapshot'), /copy of its own/)
  assert.match(groupPolicyHint('isolated', 'snapshot'), /copy of its own, made from the session's checkpoint/)
})


test("statuses counted as the thread counts them: a step waiting for a decision is under none of the five", () => {
  assert.deepEqual(countStatuses(['done', 'waiting', 'cancelled']), { queued: 0, running: 0, done: 1, error: 0, cancelled: 1, total: 3 })
})
