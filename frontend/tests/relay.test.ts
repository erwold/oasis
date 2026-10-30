import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RelayParticipantSchema, type Relay } from '@oasis-code/contract'
import { activeRelay, continueLabel, latestRunOfRelay, relayHeaderLine, relayIsLatest, relayLine, relaysChanged, relayTurnOf, stepState } from '../src/state/relay.ts'
import { keyFor, signatureOf } from '../src/state/sendKey.ts'

const relay = (over: Partial<Relay> = {}): Relay => ({
  id: 'relay_1', session_id: 's', status: 'running', user_text: 'do it',
  participants: [{ model: 'anthropic:claude-opus-5-5', label: 'Claude Opus 5.5', id: 'A' }, { model: 'openai:gpt-6-astra', label: 'GPT-6 Astra', id: 'B' }],
  steps: [{ seq: 0, round: 1, participant: 0, status: 'done', run_id: 'run_a', run_ids: ['run_a'] }, { seq: 1, round: 1, participant: 1, status: 'running', run_id: 'run_b', run_ids: ['run_b'] }],
  rounds: 1, round: 1, current_step: 1, reason: null, client_request_id: null, created_at: 't0', updated_at: 't1', finished_at: null, ...over,
})

test('a run is read as its relay turn: who, which turn, the first (the words stand over it), the newest (the board stands under it)', () => {
  const r = relay()
  const a = relayTurnOf([r], { id: 'run_a', relay_id: 'relay_1', relay_step: 0 })!
  assert.equal(a.participant.label, 'Claude Opus 5.5')
  assert.equal(a.first, true)
  assert.equal(a.latest, false)
  assert.equal(a.rerun, false)
  const b = relayTurnOf([r], { id: 'run_b', relay_id: 'relay_1', relay_step: 1 })!
  assert.equal(b.participant.id, 'B')
  assert.equal(b.first, false)
  assert.equal(b.latest, true)
  assert.equal(relayTurnOf([r], { id: 'run_x', relay_id: null, relay_step: null }), null)
  assert.equal(relayTurnOf([], { id: 'run_a', relay_id: 'relay_1', relay_step: 0 }), null)
  // a turn run again after the person's decision: the second run of the same step is a rerun, and the newest
  const again = relay({ status: 'running', steps: [{ seq: 0, round: 1, participant: 0, status: 'running', run_id: 'run_a2', run_ids: ['run_a', 'run_a2'] }, { seq: 1, round: 1, participant: 1, status: 'queued', run_id: null, run_ids: [] }], current_step: 0 })
  const rerun = relayTurnOf([again], { id: 'run_a2', relay_id: 'relay_1', relay_step: 0 })!
  assert.equal(rerun.first, false)
  assert.equal(rerun.rerun, true)
  assert.equal(rerun.latest, true)
  assert.equal(relayTurnOf([again], { id: 'run_a', relay_id: 'relay_1', relay_step: 0 })!.first, true)
})

test("the board's words: each turn's state, the chain's line, the header's line, what the person can do", () => {
  const r = relay()
  assert.equal(stepState(r.steps[0]!, r.participants[0]!), 'done')
  assert.equal(stepState(r.steps[1]!, r.participants[1]!), 'working')                 // no roles: every turn works
  assert.equal(stepState({ ...r.steps[1]!, status: 'running' }, r.participants[0]!), 'working')
  assert.equal(stepState({ ...r.steps[1]!, status: 'waiting' }, r.participants[1]!), 'waiting for your decision')
  assert.equal(relayLine(r), 'Relay · GPT-6 Astra working')
  assert.equal(relayHeaderLine(r), 'GPT-6 Astra (turn 2 of 2)')
  // an earlier record without ids: its participants are still named by their labels
  const legacy = relay({ participants: [{ model: 'm', label: 'One', role: 'executor' }, { model: 'm', label: 'Two', role: 'reviewer' }].map((p) => RelayParticipantSchema.parse(p)) })
  assert.deepEqual(legacy.participants.map((p) => p.id), ['', ''])
  assert.equal(relayHeaderLine(legacy), 'Two (turn 2 of 2)')
  assert.equal(relayLine(relay({ status: 'done', rounds: 2, round: 2 })), 'Relay done · 2 rounds')
  assert.equal(relayLine(relay({ status: 'waiting', reason: 'decide, then continue' })), 'Relay · paused: decide, then continue')
  assert.equal(relayLine(relay({ status: 'cancelled', reason: 'stopped by the person' })), 'Relay stopped · stopped by the person')
  assert.equal(relayLine(relay({ status: 'error', reason: 'x failed' })), 'Relay failed · x failed')
  assert.equal(continueLabel(relay({ status: 'waiting' }), 5), 'Continue')
  assert.equal(continueLabel(relay({ status: 'interrupted' }), 5), 'Continue')
  assert.equal(continueLabel(relay({ status: 'done', rounds: 1 }), 5), 'One more round')
  assert.equal(continueLabel(relay({ status: 'done', rounds: 5 }), 5), null)
  assert.equal(continueLabel(relay({ status: 'running' }), 5), null)
  assert.equal(continueLabel(relay({ status: 'cancelled' }), 5), null)
  assert.equal(activeRelay([relay({ status: 'done' }), relay({ id: 'relay_2' })])?.id, 'relay_2')
  assert.equal(activeRelay([relay({ status: 'waiting' })]), null)
})

test('the page notices a relay moving; the send key tells two messages apart by their agents, their order and the rounds', () => {
  const r = relay()
  assert.equal(relaysChanged([r], [r]), false)
  assert.equal(relaysChanged([r], [relay({ status: 'done' })]), true)
  assert.equal(relaysChanged([], [r]), true)
  const ab = 'x @[A](agent:a) @[B](agent:b)'
  const ba = 'x @[B](agent:b) @[A](agent:a)'
  const one = keyFor(null, 's', signatureOf(ab, [], 1))
  assert.equal(keyFor(one, 's', signatureOf(ab, [], 1)), one)                       // the same message again: the same key
  assert.notEqual(keyFor(one, 's', signatureOf(ba, [], 1)).key, one.key)            // the other order: another message
  assert.notEqual(keyFor(one, 's', signatureOf(ab, [], 2)).key, one.key)            // more rounds: another message
  assert.equal(signatureOf('t', ['i']), JSON.stringify(['t', ['i']]))               // a plain message's signature as before
})

test('the chain is continued only while it is the latest thing said; afterwards the board says the conversation moved on', () => {
  const done = relay({ status: 'done' })
  assert.equal(latestRunOfRelay(done), 'run_b')
  assert.equal(relayIsLatest(done, 'run_b'), true)
  assert.equal(relayIsLatest(done, null), true)                                       // nothing known yet: no claim
  assert.equal(relayIsLatest(done, 'run_later'), false)
  assert.equal(continueLabel(done, 5, 'run_b'), 'One more round')
  assert.equal(continueLabel(done, 5, 'run_later'), null)
  assert.equal(continueLabel(relay({ status: 'waiting' }), 5, 'run_later'), null)
  assert.equal(continueLabel(relay({ status: 'interrupted' }), 5, 'run_b'), 'Continue')
  // a relay whose first turn never ran has no run to compare: still the person's to continue
  const unstarted = relay({ status: 'interrupted', current_step: 0, steps: [{ seq: 0, round: 1, participant: 0, status: 'queued', run_id: null, run_ids: [] }, { seq: 1, round: 1, participant: 1, status: 'queued', run_id: null, run_ids: [] }] })
  assert.equal(continueLabel(unstarted, 5, 'run_other'), 'Continue')
})
