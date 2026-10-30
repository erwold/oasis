import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CHATGPT_WEB_ID, type InteractionDetail } from '@oasis-code/contract'
import { activeInteraction, activeInteractions, nextRound, notableInteraction, adoptable, interactionAskOf, boardLine, interactionWay, stripWaves, usageLine, continueInteractionLabel, groupStatusLine, handoverLine, handoverManifest, interactionHeaderLine, interactionItems, interactionLine, interactionReason, interactionsBehind, interactionsChanged, interactionTurnOf, continuedParticipant, nodeCopy, nodeFacts, nodeInstructions, nodeReads, nodeState, noteLanding, noteState, orchestrationChipText, orchestrationHint, orchestrationLabel, planLines, waves, type InteractionItem } from '../src/state/interaction.ts'
import { keyFor, signatureOf } from '../src/state/sendKey.ts'

const node = (id: string, participant: string, over: Partial<InteractionDetail['nodes'][number]> = {}): InteractionDetail['nodes'][number] => ({
  id, interaction_id: 'ix_1', seq: 1, participant, instruction: null, depends_on: [], receives: [], workspace: 'own', status: 'queued', run_id: null, run_ids: [], workspace_id: null, revision: 1, wave: 1, created_at: 't', updated_at: 't', ...over,
})
const interaction = (over: Partial<InteractionDetail> = {}): InteractionDetail => ({
  workspace_policy: 'legacy', source_turn_id: null, id: 'ix_1', session_id: 's', status: 'running', user_text: 'go', controller: 'director', template: null, then: 'stop', revision: 1,
  participants: [{ id: 'A', label: 'Claude Opus 5.5', model: 'anthropic:claude-opus-5-5' }, { id: 'B', label: 'Claude Opus 5.5', model: 'anthropic:claude-opus-5-5' }],
  budget: { max_runs: 6, concurrency: 2 }, runs_started: 2, base_checkpoint_id: 'cp_1', fresh: false, resumes_run_id: null, director_session_id: 'dir_1', director_turn_id: null,
  reason: null, attachments: [], client_request_id: null, created_at: 't0', updated_at: 't1', finished_at: null,
  nodes: [node('a1', 'A', { status: 'done', run_id: 'run_a', run_ids: ['run_a'], workspace_id: 'ws_a' }), node('b1', 'B', { status: 'running', run_id: 'run_b', run_ids: ['run_b'], workspace_id: 'ws_b', depends_on: ['a1'], receives: ['a1'], workspace: 'a1', wave: 2 })],
  events: [], notes: [], live: true, in_place: false, ...over,
})

test('a run is read as its node: who, which step, the first run of it, the newest of the whole', () => {
  const ix = interaction()
  const a = interactionTurnOf([ix], { id: 'run_a', interaction_id: 'ix_1', interaction_node: 'a1' })!
  assert.equal(a.participant.label, 'Claude Opus 5.5')
  assert.equal(a.node.participant, 'A')
  assert.equal(a.first, true)
  assert.equal(a.latest, false)
  const b = interactionTurnOf([ix], { id: 'run_b', interaction_id: 'ix_1', interaction_node: 'b1' })!
  assert.equal(b.latest, true)
  assert.equal(interactionTurnOf([ix], { id: 'run_x', interaction_id: null, interaction_node: null }), null)
  assert.equal(interactionTurnOf([], { id: 'run_a', interaction_id: 'ix_1', interaction_node: 'a1' }), null)
  // a node run again: its second run is not the first
  const again = interaction({ nodes: [node('a1', 'A', { status: 'running', run_id: 'run_a2', run_ids: ['run_a', 'run_a2'] })] })
  assert.equal(interactionTurnOf([again], { id: 'run_a2', interaction_id: 'ix_1', interaction_node: 'a1' })!.first, false)
})

test("a follow-up that resumes a participant's run is that participant, through any number of follow-ups", () => {
  const ix = interaction()
  const runs = [
    { id: 'run_a', resumes_run_id: null, interaction_id: 'ix_1', interaction_node: 'a1' },
    { id: 'run_b', resumes_run_id: null, interaction_id: 'ix_1', interaction_node: 'b1' },
    { id: 'run_f1', resumes_run_id: 'run_b', interaction_id: null, interaction_node: null },
    { id: 'run_f2', resumes_run_id: 'run_f1', interaction_id: null, interaction_node: null },
    { id: 'run_solo', resumes_run_id: null, interaction_id: null, interaction_node: null },
    { id: 'run_loop', resumes_run_id: 'run_loop', interaction_id: null, interaction_node: null },
  ]
  assert.equal(continuedParticipant([ix], runs, runs[2]!)!.participant.id, 'B')
  assert.equal(continuedParticipant([ix], runs, runs[3]!)!.participant.id, 'B')            // a follow-up of a follow-up
  assert.equal(continuedParticipant([ix], runs, runs[4]!), null)                           // a run of its own
  assert.equal(continuedParticipant([ix], runs, runs[5]!), null)                           // a cycle ends
  assert.equal(continuedParticipant([ix], runs, runs[0]!), null)                           // a node's own run is its node
  assert.equal(continuedParticipant([], runs, runs[2]!), null)                             // the interaction not loaded
})

test("the board's words: each step's state, where it works, what it reads, the interaction's line, the header's", () => {
  const ix = interaction()
  assert.equal(nodeState(ix.nodes[0]!), 'done')
  assert.equal(nodeState(ix.nodes[1]!), 'working')
  assert.equal(nodeState(node('c1', 'A', { depends_on: ['a1', 'b1'] })), 'waits for a1, b1')
  assert.equal(nodeState(node('c1', 'A', { status: 'waiting' })), 'waiting for your decision')
  assert.equal(nodeCopy(ix.nodes[0]!), 'own copy')
  assert.equal(nodeCopy(ix.nodes[1]!), "a1's copy")
  assert.equal(nodeCopy(node('c1', 'A', { workspace: 'shared' })), 'the session folder')
  assert.equal(nodeReads(ix.nodes[0]!), 'alone')
  assert.equal(nodeReads(ix.nodes[1]!), 'reads a1')
  assert.equal(interactionLine(ix), 'Running · 1 of 2 steps done')
  assert.equal(interactionLine(interaction({ status: 'planning', nodes: [] })), 'The director is planning the steps…')
  const paused = interaction({ status: 'waiting', reason: 'step a1 (A) did not end well; continue runs the failed step again, or stop the interaction' })
  assert.equal(interactionLine(paused), 'Paused · 1 of 2 steps done')                                           // the reason stands on its own line
  assert.equal(interactionReason(paused), 'step a1 (A) did not end well; continue runs the failed step again, or stop the interaction')
  assert.equal(interactionReason(interaction({ status: 'waiting', reason: null })), 'waiting for you')
  assert.equal(interactionReason(interaction({ status: 'running' })), null)
  assert.equal(interactionLine(interaction({ status: 'done' })), 'Done · 1 of 2 steps done')
  assert.equal(interactionLine(interaction({ status: 'cancelled', reason: 'stopped by the person' })), 'Stopped · 1 of 2 steps done')
  assert.equal(interactionReason(interaction({ status: 'cancelled', reason: 'stopped by the person' })), 'stopped by the person')
  assert.equal(interactionHeaderLine(ix), 'wave 2 of 2 · B working')        // two on one model: each its own id
  assert.equal(interactionHeaderLine(interaction({ status: 'planning', nodes: [] })), 'the director plans the steps')
  assert.deepEqual(planLines(ix), ['a1: A, alone, on own copy', "b1: B after a1, reads a1, on a1's copy"])
  assert.equal(orchestrationLabel('turns'), 'Take turns')
  assert.equal(orchestrationChipText('turns', 2, 2, 6), 'Take turns · 4 runs')
  assert.equal(orchestrationChipText('independent', 3, 1, 9), 'Independently · 3 runs')
  assert.equal(orchestrationChipText('director', 2, 1, 6), 'Guided · up to 6 runs')
})

test('a folder edited in place: every step, own included, reads as working in the session folder, never as a copy', () => {
  // what the harness answers for a direct project: no starting point pinned, both own steps on the session's folder
  const ix = interaction({
    status: 'done', in_place: true, base_checkpoint_id: null, controller: 'fixed', template: 'independent',
    nodes: [
      node('a1', 'A', { status: 'done', run_id: 'run_a', run_ids: ['run_a'], workspace_id: 'ws_session' }),
      node('b1', 'B', { status: 'done', run_id: 'run_b', run_ids: ['run_b'], workspace_id: 'ws_session' }),
    ],
  })
  assert.equal(nodeCopy(ix.nodes[0]!, true), 'the session folder')
  assert.deepEqual(planLines(ix), ['a1: A, alone, on the session folder', 'b1: B, alone, on the session folder'])
  assert.equal(handoverLine(ix, ix.nodes[0]!), 'starts alongside B · the session folder · sees your words only')
  assert.equal(handoverManifest(ix, ix.nodes[0]!, true), "Handed: your request.\nNot handed: b1's answer.")
  const words = [...planLines(ix), handoverLine(ix, ix.nodes[0]!), handoverManifest(ix, ix.nodes[0]!, true), orchestrationHint('independent', true)].join('\n')
  assert.doesNotMatch(words, /cop(y|ies) of|own copy|'s copy|other copies/)
  assert.match(orchestrationHint('independent', true), /in place/)
  assert.match(orchestrationHint('independent'), /a separate copy of the files each/)
})

test('what the person can do: continue while waiting or interrupted, adopt a step that ended well on a copy, stop while under way', () => {
  assert.equal(continueInteractionLabel(interaction({ status: 'waiting' })), 'Continue')
  assert.equal(continueInteractionLabel(interaction({ status: 'waiting', nodes: [] })), 'Ask the director again')
  assert.equal(continueInteractionLabel(interaction({ status: 'interrupted' })), 'Continue')
  assert.equal(continueInteractionLabel(interaction({ status: 'running' })), null)
  assert.equal(continueInteractionLabel(interaction({ status: 'done' })), null)
  const done = interaction({ status: 'done', nodes: [node('a1', 'A', { status: 'done', run_id: 'run_a', run_ids: ['run_a'], workspace_id: 'ws_a' }), node('c1', 'A', { status: 'done', run_id: 'run_c', run_ids: ['run_c'], workspace_id: 'ws_session', workspace: 'shared' })] })
  assert.equal(adoptable(done, done.nodes[0]!, 'ws_session'), true)
  assert.equal(adoptable(done, done.nodes[1]!, 'ws_session'), false)                                // it worked on the session's folder already
  assert.equal(adoptable(interaction(), interaction().nodes[0]!, 'ws_session'), false)              // not while the interaction runs
  assert.equal(activeInteraction([interaction({ status: 'done' }), interaction({ id: 'ix_2', status: 'planning' })])?.id, 'ix_2')
  assert.equal(activeInteraction([interaction({ status: 'waiting' })]), null)
  const ix = interaction()
  assert.equal(interactionsChanged([ix], [ix]), false)
  assert.equal(interactionsChanged([ix], [interaction({ status: 'done' })]), true)
  assert.equal(interactionsChanged([], [ix]), true)
})

test("the send key tells two messages apart by how their agents work together", () => {
  const ab = 'x @[A](agent:a#A) @[B](agent:b#B)'
  const guided = keyFor(null, 's', signatureOf(ab, [], ['director', null]))
  assert.equal(keyFor(guided, 's', signatureOf(ab, [], ['director', null])), guided)
  assert.notEqual(keyFor(guided, 's', signatureOf(ab, [], ['independent', null])).key, guided.key)
  assert.notEqual(keyFor(guided, 's', signatureOf(ab, [], ['turns', 2])).key, guided.key)
})

test("the interaction's items stand in reading order: the request first, the director's plan right after it, the board after the newest run; its turns' notes leave the conversation", () => {
  const ix = interaction({
    created_at: '2026-09-28T17:55:09.055Z',
    events: [{ seq: 1, kind: 'created', actor: 'person', payload: {}, created_at: 't' }, { seq: 2, kind: 'plan_asked', actor: 'harness', payload: { turn_id: 'turn_plan' }, created_at: 't' }, { seq: 3, kind: 'decision_asked', actor: 'harness', payload: { turn_id: 'turn_decide' }, created_at: 't' }],
  })
  const runs = [
    { id: 'run_a', interaction_id: 'ix_1', created_at: '2026-09-28T17:56:01.433Z' }, { id: 'run_b', interaction_id: 'ix_1', created_at: '2026-09-28T17:56:02.035Z' },
    { id: 'run_plain', interaction_id: null, created_at: '2026-09-28T17:50:00.000Z' },
  ]
  const note = (id: string, turn_id: string | null, created_at: string) => ({ id, session_id: 's', source: 'oasis-code', model: 'Claude', question: 'App note: Plan interaction ix_1.', answer: 'the plan', turn_id, created_at })
  const notes = [note('note_plan', 'turn_plan', '2026-09-28T17:56:10.955Z'), note('note_decide', 'turn_decide', '2026-09-28T17:59:30.000Z'), note('note_user', 'turn_user', '2026-09-28T17:52:00.000Z')]
  const turns = [{ id: 'turn_plan', kind: 'interaction' as const }, { id: 'turn_decide', kind: 'interaction' as const }, { id: 'turn_user', kind: 'user' as const }]
  const { items, noteIds } = interactionItems([ix], runs, notes, turns)
  assert.deepEqual([...noteIds], ['note_plan', 'note_decide'])                                  // the person's own director note stays the conversation's
  const order = [...items, ...runs.map((r) => ({ kind: 'run', at: r.created_at, id: r.id }))].sort((a, b) => a.at.localeCompare(b.at)).map((i) => (i.kind === 'run' ? (i as { id: string }).id : i.kind))
  assert.deepEqual(order, ['run_plain', 'interaction_request', 'interaction_note', 'run_a', 'run_b', 'interaction_board', 'interaction_note'])
  const noteItems = items.filter((i): i is Extract<InteractionItem, { kind: 'interaction_note' }> => i.kind === 'interaction_note')
  assert.equal(noteItems.find((i) => i.asked === 'plan')!.note.id, 'note_plan')
  assert.equal(noteItems.find((i) => i.asked === 'decision')!.at, '2026-09-28T17:59:30.000Z')
  // no run yet (the director is planning): the board follows the request and the plan
  const planning = interactionItems([interaction({ status: 'planning', nodes: [], created_at: '2026-09-28T18:00:00.000Z', events: ix.events })], [], notes, turns).items
  assert.deepEqual(planning.map((i) => i.kind), ['interaction_request', 'interaction_note', 'interaction_note', 'interaction_board'])
  assert.ok(planning[0]!.at < planning[1]!.at && planning[1]!.at < planning[3]!.at)
})

test("an interaction the person's message to the director started with their words unchanged does not repeat them: the director's turn already shows them", () => {
  const ix = interaction({ created_at: '2026-10-13T04:41:37.076Z', user_text: 'battle it out' })
  const said = (text: string, ids: string[]) => [{ id: 'turn_user', kind: 'user' as const, dispatched_interaction_ids: ids, envelope: { text, attachments: [], mentions: [], fresh: false, participant_thinking: {} } }]
  assert.deepEqual(interactionItems([ix], [], [], said('battle it out', ['ix_1'])).items.map((i) => i.kind), ['interaction_board'])
  assert.deepEqual(interactionItems([ix], [], [], said('battle it out', [])).items.map((i) => i.kind), ['interaction_request', 'interaction_board'])
  assert.deepEqual(interactionItems([ix], [], [], said('other words', ['ix_1'])).items.map((i) => i.kind), ['interaction_request', 'interaction_board'])   // words of its own stand
})

test("the strip groups the steps by wave in their order and stands the playhead over the lowest wave at work, else the lowest waiting", () => {
  const n = (id: string, wave: number, seq: number, status: 'queued' | 'running' | 'done') => node(id, 'A', { wave, seq, status })
  const ix = interaction({ nodes: [n('c2', 2, 5, 'queued'), n('a1', 1, 1, 'done'), n('b2', 2, 4, 'running'), n('b1', 1, 2, 'done'), n('a3', 3, 6, 'queued')] })
  const strip = stripWaves(ix)
  assert.deepEqual(strip.waves.map((w) => [w.wave, w.nodes.map((x) => x.id)]), [[1, ['a1', 'b1']], [2, ['b2', 'c2']], [3, ['a3']]])
  assert.equal(strip.current, 2)
  assert.equal(stripWaves(interaction({ nodes: [n('a1', 1, 1, 'done'), n('a2', 2, 2, 'queued')] })).current, 2)
  // a step stopped in wave 1 holds the later waves: the playhead stands where continue starts again
  const held = interaction({ nodes: [n('a1', 1, 1, 'done'), node('b1', 'B', { wave: 1, seq: 2, status: 'cancelled' }), n('a2', 2, 3, 'queued')] })
  assert.equal(stripWaves(held).current, 1)
  assert.deepEqual(waves(held), { total: 2, current: 1 })                                                        // the words say the wave the playhead shows
  assert.equal(stripWaves(interaction({ nodes: [n('a1', 1, 1, 'done')] })).current, null)
  assert.deepEqual(stripWaves(interaction({ nodes: [] })).waves, [])
})

test("notes go to the interaction under way, else to one paused or interrupted; never to one that ended", () => {
  const ix = (id: string, status: InteractionDetail['status']) => interaction({ id, status })
  assert.equal(notableInteraction([ix('ix_done', 'done'), ix('ix_run', 'running')])?.id, 'ix_run')
  assert.equal(notableInteraction([ix('ix_done', 'done'), ix('ix_paused', 'waiting')])?.id, 'ix_paused')
  assert.equal(notableInteraction([ix('ix_cut', 'interrupted')])?.id, 'ix_cut')
  assert.equal(notableInteraction([ix('ix_stopped', 'cancelled'), ix('ix_failed', 'error')]), null)
  // the session's latest ended well: a note to it starts another round; an earlier one that ended well takes none
  const at = (id: string, status: InteractionDetail['status'], created_at: string) => interaction({ id, status, created_at })
  assert.equal(notableInteraction([at('ix_old', 'done', '2026-10-13T01:00:00Z'), at('ix_new', 'done', '2026-10-13T02:00:00Z')])?.id, 'ix_new')
  assert.equal(notableInteraction([at('ix_old', 'done', '2026-10-13T01:00:00Z'), at('ix_new', 'cancelled', '2026-10-13T02:00:00Z')]), null)
})

test("another round: each addressee answers after every participant's latest step, handed the others' latest answers; ids follow the last round", () => {
  const done = (id: string, participant: string, seq: number) => node(id, participant, { seq, status: 'done' })
  const ix = interaction({
    status: 'done',
    participants: [{ id: 'A', label: 'Fable', model: 'm' }, { id: 'B', label: 'Fable', model: 'm' }, { id: 'C', label: 'Fable', model: 'm' }],
    nodes: [done('solo-1', 'A', 1), done('solo-2', 'B', 2), done('solo-3', 'C', 3), done('cross-1-1', 'A', 4), done('cross-1-2', 'B', 5), done('cross-1-3', 'C', 6), done('synth-1', 'A', 7)],
  })
  const all = nextRound(ix, 'everyone')
  assert.deepEqual(all.map((n) => n.id), ['cross-2-1', 'cross-2-2', 'cross-2-3'])
  assert.deepEqual(all[1]!.depends_on, ['synth-1', 'cross-1-2', 'cross-1-3'])
  assert.deepEqual(all[1]!.receives, ['synth-1', 'cross-1-3'])
  assert.ok(all.every((n) => n.workspace === 'own' && n.instruction === null))
  assert.deepEqual(nextRound(ix, 'C').map((n) => [n.id, n.participant]), [['cross-2-3', 'C']])
  assert.deepEqual(nextRound(interaction({ ...ix, nodes: [...ix.nodes, done('cross-2-3', 'C', 8)] }), 'C').map((n) => n.id), ['cross-3-3'])
  assert.equal(noteLanding(ix, 'everyone'), 'another round as this is sent · A, B, C answer again')
  assert.equal(noteLanding(ix, 'B'), 'another round as this is sent · B answers again')
})

test("the handover says what a step comes after, where it works and what it received; the manifest says what was handed and what was not; the waves; the board's line; where a note lands", () => {
  const ix = interaction({
    base_checkpoint_id: 'cp_8a91ffff', budget: { max_runs: 6, concurrency: 2 }, runs_started: 3, revision: 1,
    nodes: [
      node('a1', 'A', { status: 'done', run_id: 'run_a', run_ids: ['run_a'], workspace_id: 'ws_a' }),
      node('b1', 'B', { status: 'done', run_id: 'run_b', run_ids: ['run_b'], workspace_id: 'ws_b' }),
      node('c1', 'C', { status: 'running', run_id: 'run_c', run_ids: ['run_c'], depends_on: ['a1', 'b1'], receives: ['a1'], workspace: 'shared', wave: 2, workspace_id: 'ws_session' }),
    ],
    participants: [{ id: 'A', label: 'Claude', model: 'm' }, { id: 'B', label: 'Claude', model: 'm' }, { id: 'C', label: 'GPT', model: 'g' }],
  })
  assert.equal(handoverLine(ix, ix.nodes[0]!), 'starts alongside B · its own copy from cp_8a91 · sees your words only')
  assert.equal(handoverLine(ix, ix.nodes[2]!), "after a1, b1 · the session folder · received a1's answer and tool calls, not b1's")
  assert.equal(handoverManifest(ix, ix.nodes[2]!, true), "Handed: your request; a1's packet (the answer as written, one line per tool call, the measured facts).\nNot handed: b1's answer.")
  assert.equal(handoverManifest(ix, ix.nodes[0]!, true), "Handed: your request.\nNot handed: b1's answer; c1's answer; the other copies' files.")
  assert.deepEqual(waves(ix), { total: 2, current: 2 })
  assert.deepEqual(waves(interaction({ nodes: [] })), { total: 0, current: 0 })
  const runs = [
    { id: 'run_a', status: 'done' as const, usage: { requests: 2, input_tokens: 1000, output_tokens: 50 } },
    { id: 'run_b', status: 'done' as const, usage: { requests: 1, input_tokens: 500, output_tokens: 20 } },
    { id: 'run_c', status: 'running' as const, usage: {} },
  ]
  assert.equal(interactionWay(ix), 'guided')
  assert.equal(boardLine(ix), 'wave 2 of 2 · 2 at a time · 3 of 6 runs')                                          // who works shows on the strip
  assert.equal(usageLine(ix, runs), 'participants: 3 requests · 1500 in / 70 out tokens · 1 run not yet counted · director usage not included · rev 1')
  // a run whose provider counted nothing adds no 0 to the sums, and its requests are named as not counted
  const unknown = [runs[0]!, { id: 'run_b', status: 'done' as const, usage: { requests: 2, input_tokens: null, output_tokens: null, uncounted_requests: 2 } }, runs[2]!]
  assert.equal(usageLine(ix, unknown), 'participants: 4 requests · 1000 in / 50 out tokens (2 of 4 requests not counted) · 1 run not yet counted · director usage not included · rev 1')
  const none = [{ id: 'run_a', status: 'done' as const, usage: { requests: 1, input_tokens: null, output_tokens: null, uncounted_requests: 1 } }]
  assert.equal(usageLine(ix, none), 'participants: 1 request · tokens not reported · director usage not included · rev 1')
  // A and B ended every step while the plan runs: the words go on in their conversations at once
  assert.equal(noteLanding(ix, 'everyone'), 'A: goes on now, in its own conversation · B: goes on now, in its own conversation · GPT: c1, at its next request')
  const withNext = interaction({ nodes: [...ix.nodes, node('a2', 'A', { depends_on: ['c1'], wave: 3 })], participants: ix.participants })
  assert.equal(noteLanding(withNext, 'A'), 'A: next run (a2)')
  // a step in flight takes the words at its next request; ChatGPT on the web takes nothing while it works
  assert.equal(noteLanding(interaction({ nodes: [node('a1', 'A', { status: 'running', run_id: 'r' }), node('a2', 'A', { depends_on: ['a1'] })] }), 'A'), 'A: a1, at its next request')
  const web = interaction({ nodes: [node('a1', 'A', { status: 'running', run_id: 'r' }), node('a2', 'A', { depends_on: ['a1'] })] })
  assert.equal(noteLanding({ ...web, participants: web.participants.map((p) => (p.id === 'A' ? { ...p, model: CHATGPT_WEB_ID } : p)) }, 'A'), 'A: queued behind a1')
  assert.equal(noteLanding(interaction({ nodes: [node('a1', 'A', { status: 'done' })] }), 'A'), 'A: no run left; the director may plan one')
  // a stopped step runs again first, the note sent continuing the interaction: the note goes with it, not with the step after
  assert.equal(noteLanding(interaction({ status: 'waiting', nodes: [node('a1', 'A', { status: 'cancelled', run_id: 'r' }), node('a2', 'A', { depends_on: ['a1'] })] }), 'A'), 'A: a1 runs again as this is sent')
  const note = (status: 'queued' | 'partly' | 'delivered' | 'undelivered', delivered: Record<string, string>) => ({ id: 'n', interaction_id: 'ix_1', to: 'everyone', text: 't', status, delivered, created_at: 't', updated_at: 't' })
  assert.equal(noteState(note('queued', {})), 'queued')
  assert.equal(noteState(note('partly', { B: 'run_b' })), 'delivered to B; queued for the rest')
  assert.equal(noteState(note('delivered', { A: 'r', B: 'r' })), 'delivered to A, B')
  assert.equal(noteState(note('undelivered', {})), 'not delivered: the interaction ended first')
})

test("the facts after the cost words say files, checks and the checkpoint", () => {
  assert.equal(nodeFacts(null), '')
  assert.equal(nodeFacts({ mechanical: { checks: null }, produced: { files_changed: [], final_checkpoint_id: null } }), '0 files changed')
  assert.equal(nodeFacts({ mechanical: { checks: { passed: 12, failed: 0, unknown: 1 } }, produced: { files_changed: [{}, {}], final_checkpoint_id: 'cp_9b02aa11' } }), '2 files changed · 12 passed · 1 unknown · cp_9b02')
  assert.equal(nodeFacts({ mechanical: { checks: { passed: 0, failed: 2, unknown: 0 } }, produced: { files_changed: [{}], final_checkpoint_id: null } }), '1 file changed · 0 passed · 2 failed')
})

test("a director turn an interaction asked stands where its answer will — the plan's right under the request — while the director still works", () => {
  const ix = interaction({
    created_at: '2026-09-28T17:55:09.055Z',
    events: [{ seq: 1, kind: 'plan_asked', actor: 'harness', payload: { turn_id: 'turn_plan' }, created_at: '2026-09-28T17:55:10.000Z' },
      { seq: 2, kind: 'decision_asked', actor: 'harness', payload: { turn_id: 'turn_decide' }, created_at: '2026-09-28T18:10:00.000Z' }],
  })
  assert.deepEqual(interactionAskOf([ix], 'turn_plan'), { interaction: ix, asked: 'plan', at: '2026-09-28T17:55:09.055Z~1' })
  assert.deepEqual(interactionAskOf([ix], 'turn_decide'), { interaction: ix, asked: 'decision', at: '2026-09-28T18:10:00.000Z' })
  assert.equal(interactionAskOf([ix], 'turn_other'), null)
})


test('isolated workspace policy is not proof of a source mount: Keep waits for actual workspace metadata', () => {
  const ix = { ...interaction({ status: 'done' }), workspace_policy: 'isolated' as const }
  const n = ix.nodes[0]!
  assert.equal(adoptable(ix, n, 'session'), false)
  assert.equal(adoptable(ix, n, 'session', { source_mount: null }), true)
  assert.equal(adoptable(ix, n, 'session', { source_mount: { root: '/fixture/research', name: 'research', readonly: true } }), false)
  assert.equal(adoptable(ix, n, 'session', { source_mount: {} }), false)
  assert.equal(adoptable(ix, n, 'session', {}), false)
  assert.match(handoverLine(ix, n), /its own workspace/)
  assert.doesNotMatch(handoverLine(ix, n), /source read-only|session folder/)
})

test('several interactions may be under way in one session: every one of them is', () => {
  const list = [interaction({ id: 'ix_1', status: 'running' }), interaction({ id: 'ix_2', status: 'done' }), interaction({ id: 'ix_3', status: 'deciding' })]
  assert.deepEqual(activeInteractions(list).map((ix) => ix.id), ['ix_1', 'ix_3'])
  assert.deepEqual(activeInteractions([interaction({ status: 'waiting' })]), [])
})

test('a step waiting on its watch says so: in its row, in the header beside those working, and its wave is the current one', () => {
  assert.equal(nodeState(node('d1', 'A', { status: 'watching' })), 'waits on its watch')
  const ix = interaction({ status: 'running', nodes: [node('a1', 'A', { status: 'running' }), node('b1', 'B', { status: 'watching' }), node('c1', 'A', { status: 'queued', depends_on: ['a1', 'b1'], wave: 2 })] })
  assert.match(interactionHeaderLine(ix), /^wave 1 of 2 · .+ working · .+ waiting on a watch$/)
  const only = interaction({ status: 'running', nodes: [node('a1', 'A', { status: 'done' }), node('b1', 'B', { status: 'watching' })] })
  assert.match(interactionHeaderLine(only), /^wave 1 of 1 · .+ waiting on a watch$/)
  assert.equal(stripWaves(only).current, 1)
})

test("each step's own words beside the shared task, in plan order; the step named when one participant was given several", () => {
  const ix = interaction({ nodes: [
    node('a1', 'A', { instruction: '  only direction A  ', seq: 1 }), node('b1', 'B', { instruction: null, seq: 2 }),
    node('c1', 'C', { instruction: 'only direction C', seq: 3 }), node('c2', 'C', { instruction: 'C again', seq: 4 }), node('d1', 'D', { instruction: '   ', seq: 5 }),
  ] })
  assert.deepEqual(nodeInstructions(ix), [
    { node: 'a1', who: 'A', text: 'only direction A' },
    { node: 'c1', who: 'C · c1', text: 'only direction C' },
    { node: 'c2', who: 'C · c2', text: 'C again' },
  ])
})

test("the person's words to the members stand in the thread at the time they were said, beside the group's request and board", () => {
  const n = (id: string, at: string) => ({ id, interaction_id: 'ix_1', to: 'A', text: `words ${id}`, status: 'queued' as const, delivered: {}, created_at: at, updated_at: at })
  const ix = interaction({ created_at: '2026-10-15T10:00:00Z', notes: [n('n1', '2026-10-15T10:05:00Z'), n('n2', '2026-10-15T10:09:00Z')] } as Partial<InteractionDetail>)
  const items = interactionItems([ix], [], [], []).items
  assert.deepEqual(items.filter((i) => i.kind === 'interaction_words').map((i) => [i.kind === 'interaction_words' ? i.note.id : '', i.at]), [['n1', '2026-10-15T10:05:00Z'], ['n2', '2026-10-15T10:09:00Z']])
})

test("a group's line says where it stands in a few words: its state, the steps done, who failed, stopped, waits or watches — the rest on hover", () => {
  const ix = (status: InteractionDetail['status'], nodes: InteractionDetail['nodes']) => interaction({ status, nodes })
  assert.equal(groupStatusLine(ix('waiting', [node('a1', 'A', { status: 'done' }), node('b1', 'B', { status: 'error' })])), 'Paused · 1 of 2 done · B failed')
  assert.equal(groupStatusLine(ix('running', [node('a1', 'A', { status: 'running' }), node('b1', 'B', { status: 'watching' })])), 'Running · 0 of 2 done · B waiting on a watch')
  assert.equal(groupStatusLine(ix('done', [node('a1', 'A', { status: 'done' }), node('b1', 'B', { status: 'done' })])), 'Done · 2 of 2 done')
  assert.equal(groupStatusLine(ix('cancelled', [node('a1', 'A', { status: 'cancelled' })])), 'Stopped · 0 of 1 done')
  assert.equal(groupStatusLine(ix('interrupted', [node('a1', 'A', { status: 'queued' })])), 'Interrupted · 0 of 1 done · cut off by a restart')
  assert.equal(groupStatusLine(ix('planning', [])), 'The director is planning the steps…')
})

test("a group step's run the page's record of its group does not know yet: the record is behind", () => {
  const ix = interaction()
  assert.equal(interactionsBehind([ix], [{ id: 'run_a', interaction_id: 'ix_1', interaction_node: 'a1' }, { id: 'run_b', interaction_id: 'ix_1', interaction_node: 'b1' }]), false)
  // a run of no group says nothing of them
  assert.equal(interactionsBehind([ix], [{ id: 'run_x', interaction_id: null, interaction_node: null }]), false)
  // the step ran again, the group started, the step was added since the record was read
  assert.equal(interactionsBehind([ix], [{ id: 'run_a2', interaction_id: 'ix_1', interaction_node: 'a1' }]), true)
  assert.equal(interactionsBehind([ix], [{ id: 'run_c', interaction_id: 'ix_2', interaction_node: 'c1' }]), true)
  assert.equal(interactionsBehind([ix], [{ id: 'run_c', interaction_id: 'ix_1', interaction_node: 'c1' }]), true)
})
