import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyEvent, fromTranscript, type ThreadEntry } from '../src/state/thread.ts'
import { queuedSteers, turnParts } from '../src/state/turns.ts'
import {
  activeRunMoved, applySteer, enterSends, isSteerRecord, putBackDraft, STEER_EVENTS, steerErrorText, steerLabel, steerRefusal, steerSender, steerTarget, type SteerFacts, type SteerRecord,
} from '../src/state/steer.ts'
import type { TranscriptEntry } from '../src/api/types.ts'
import { readPendingSteers, steerRoute, takesPlace, writePendingSteers } from '../src/state/steer.ts'

const steer = (over: Partial<SteerRecord> = {}): SteerRecord => ({
  id: 'st_1', run_id: 'r1', session_id: 's', text: '  keep  this\n\n  exactly  ', client_request_id: 'key-0001', status: 'queued',
  queued_at: '2026-10-13T00:00:00Z', queued_seq: 5, delivered_at: null, delivered_seq: null, request_index: null, reason: null, ...over,
})
const ev = (event: string, data: Record<string, unknown>, id?: string) => ({ event, data, id })
const kinds = (rows: ThreadEntry[]) => rows.map((e) => (e.kind === 'user' ? `steer:${e.steer?.id}:${e.steer?.status}` : e.kind === 'activity' ? `tool:${e.toolCallId}` : `${e.kind}:${e.text ?? ''}`))

test('a steer record is read by its shape; anything else is not words', () => {
  assert.ok(isSteerRecord(steer()))
  assert.ok(isSteerRecord(steer({ status: 'undelivered', reason: 'stopped' })))
  assert.equal(isSteerRecord({ ...steer(), status: 'sent' }), false)
  assert.equal(isSteerRecord({ ...steer(), queued_seq: '5' }), false)
  assert.equal(isSteerRecord({ ...steer(), text: 7 }), false)
  assert.equal(isSteerRecord(null), false)
  assert.deepEqual([...STEER_EVENTS], ['steer_queued', 'steer_delivered', 'steer_undelivered'])
})

test('queued at the tail, delivered moves after the tool results it followed and before the next words; never back', () => {
  let t: ThreadEntry[] = []
  t = applyEvent(t, 'r1', ev('tool_call', { tool: 'bash', tool_call_id: 'c1', summary: '' }, '3'))
  t = applyEvent(t, 'r1', ev('steer_queued', { steer: steer() }, '4'))
  t = applyEvent(t, 'r1', ev('tool_result', { tool: 'bash', tool_call_id: 'c1', status: 'ok' }, '6'))
  assert.deepEqual(kinds(t), ['tool:c1', 'steer:st_1:queued'])
  // the queued one stands at the tail, out of the flow
  assert.deepEqual(turnParts(t).map((p) => p.kind), ['work'])
  assert.equal(queuedSteers(t).length, 1)
  t = applyEvent(t, 'r1', ev('steer_delivered', { steer: steer({ status: 'delivered', delivered_seq: 7, delivered_at: 'x', request_index: 2 }) }, '7'))
  t = applyEvent(t, 'r1', ev('text_block', { text: 'I read it' }, '8'))
  assert.deepEqual(kinds(t), ['tool:c1', 'steer:st_1:delivered', 'agent:I read it'])
  assert.deepEqual(turnParts(t).map((p) => p.kind), ['work', 'steer', 'agent'])
  assert.equal(queuedSteers(t).length, 0)
  // the stream read again from its start (or the send's own answer): the queued word never moves it back, one row per id
  const again = applyEvent(applyEvent(t, 'r1', ev('steer_queued', { steer: steer() }, '4')), 'r1', ev('steer_delivered', { steer: steer({ status: 'delivered' }) }, '7'))
  assert.deepEqual(kinds(again), kinds(t))
  assert.equal(again.filter((e) => e.steer).length, 1)
  // the first end stands: an undelivered word after a delivery changes nothing
  assert.deepEqual(kinds(applySteer(t, 'r1', steer({ status: 'undelivered', reason: 'stopped' }))), kinds(t))
  // the words are the record's, exactly
  assert.equal(t[1]!.steer!.text, '  keep  this\n\n  exactly  ')
})

test('words queued while an answer streams never split it: the rest joins the same row, the block closes it once', () => {
  let t: ThreadEntry[] = []
  t = applyEvent(t, 'r1', ev('text_delta', { text: 'Phase one: ', start: true }))
  t = applyEvent(t, 'r1', ev('steer_queued', { steer: steer() }, '4'))
  t = applyEvent(t, 'r1', ev('text_delta', { text: 'blocked' }))
  assert.deepEqual(kinds(t), ['agent:Phase one: blocked', 'steer:st_1:queued'])
  t = applyEvent(t, 'r1', ev('text_block', { text: 'Phase one: blocked.' }, '8'))
  t = applyEvent(t, 'r1', ev('steer_delivered', { steer: steer({ status: 'delivered', delivered_seq: 9, delivered_at: 'x', request_index: 2 }) }, '9'))
  assert.deepEqual(kinds(t), ['agent:Phase one: blocked.', 'steer:st_1:delivered'])
  assert.equal(t.filter((e) => e.running).length, 0)
})

test('a steer names the client its request came through, after a replay and at its end: ChatGPT keeps its mark, an older record says connector', () => {
  let t: ThreadEntry[] = []
  t = applyEvent(t, 'r1', ev('steer_queued', { steer: steer({ by: 'connector', client: 'Claude' }) }, '4'))
  t = applyEvent(t, 'r1', ev('steer_queued', { steer: steer({ id: 'st_2', queued_seq: 5, by: 'connector', client: 'ChatGPT' }) }, '5'))
  t = applyEvent(t, 'r1', ev('steer_undelivered', { steer: steer({ by: 'connector', client: 'Claude', status: 'undelivered', reason: 'interrupted' }) }, '9'))
  const senders = t.filter((e) => e.steer).map((e) => steerSender(e.steer!))
  assert.deepEqual(senders, [{ kind: 'connector', name: 'ChatGPT', chatgpt: true }, { kind: 'connector', name: 'Claude', chatgpt: false }])
  // a record from before the client was kept: neutral, never ChatGPT
  assert.deepEqual(steerSender(steer({ by: 'connector' })), { kind: 'connector', name: 'connector', chatgpt: false })
  assert.deepEqual(steerSender(steer({ by: 'director', client: 'ChatGPT' })), { kind: 'director' })
  assert.deepEqual(steerSender(steer()), { kind: 'person' })
})

test('an undelivered steer stands at the run\'s end with its reason; another run\'s record is never this run\'s', () => {
  let t: ThreadEntry[] = []
  t = applyEvent(t, 'r1', ev('steer_queued', { steer: steer() }, '4'))
  t = applyEvent(t, 'r1', ev('tool_call', { tool: 'bash', tool_call_id: 'c1', summary: '' }, '5'))
  t = applyEvent(t, 'r1', ev('steer_undelivered', { steer: steer({ status: 'undelivered', reason: 'stopped' }) }, '9'))
  assert.deepEqual(kinds(t), ['tool:c1', 'steer:st_1:undelivered'])
  assert.match(steerLabel(t[1]!.steer!), /not delivered · the run was stopped first/)
  assert.deepEqual(applySteer([], 'r2', steer()), [])
  // a record the page cannot read is said, never shown as words
  const odd = applyEvent([], 'r1', ev('steer_queued', { steer: { id: 'x' } }, '4'))
  assert.equal(odd[0]!.kind, 'note')
  assert.equal(odd[0]!.steer, undefined)
})

test('cold: a finished run\'s transcript shows only the steers — at their place, with their state — never the opening words or the harness prompts', () => {
  const entries = [
    { kind: 'user', text: 'the opening words' },
    { kind: 'activity', tool: 'bash', toolCallId: 'c1', result: { status: 'ok' } },
    { kind: 'user', text: 'Continue.' },
    { kind: 'user', text: 'as the history joined it', steer_id: 'st_1' },
    { kind: 'agent', text: 'I read it' },
  ] as unknown as TranscriptEntry[]
  const records = [
    steer({ id: 'st_3', queued_seq: 30, status: 'queued' }),
    steer({ id: 'st_1', status: 'delivered', delivered_seq: 7 }),
    steer({ id: 'st_2', queued_seq: 20, status: 'undelivered', reason: 'stopped', text: 'too late ' }),
    steer({ id: 'st_other', run_id: 'r9' }),
  ]
  const rows = fromTranscript('r1', entries, () => true, records)
  assert.deepEqual(kinds(rows), ['tool:c1', 'steer:st_1:delivered', 'agent:I read it', 'steer:st_2:undelivered', 'steer:st_3:queued'])
  assert.equal(rows[1]!.steer!.text, '  keep  this\n\n  exactly  ')            // the record's words, exactly
  // an older transcript without the list: a delivered steer still stands where its words are
  const bare = fromTranscript('r1', entries)
  assert.deepEqual(kinds(bare), ['tool:c1', 'steer:st_1:delivered', 'agent:I read it'])
  assert.equal(bare[1]!.steer!.text, 'as the history joined it')
  // and a transcript without steers is as before: no user rows at all
  assert.deepEqual(kinds(fromTranscript('r1', entries.filter((e) => !(e as { steer_id?: string }).steer_id))), ['tool:c1', 'agent:I read it'])
})

test('which run the composer steers: the session\'s own live run, words for the agent, never a relay / interaction / order / task / child / ChatGPT web', () => {
  const run = { id: 'r1', status: 'running', parent_run_id: null, work_order: null, relay_id: null, interaction_id: null, model: 'scripted:a' }
  const base: SteerFacts = { run, activeRun: null, uiTask: false, relayLive: false, interactionLive: false, destination: 'agent', replaying: false }
  assert.equal(steerTarget(base), 'r1')
  assert.equal(steerTarget({ ...base, run: { ...run, status: 'queued' } }), 'r1')
  assert.equal(steerTarget({ ...base, run: { ...run, status: 'done' } }), null)
  assert.equal(steerTarget({ ...base, run: undefined }), null)
  assert.equal(steerTarget({ ...base, destination: 'director' }), null)             // the director's queue, as before
  assert.equal(steerTarget({ ...base, destination: 'note' }), null)                 // a participant's note, as before
  assert.equal(steerTarget({ ...base, relayLive: true }), null)
  assert.equal(steerTarget({ ...base, interactionLive: true }), null)
  assert.equal(steerTarget({ ...base, replaying: true }), null)
  assert.equal(steerTarget({ ...base, uiTask: true }), null)
  assert.equal(steerTarget({ ...base, run: { ...run, relay_id: 'rl' } }), null)
  assert.equal(steerTarget({ ...base, run: { ...run, interaction_id: 'ix' } }), null)
  assert.equal(steerTarget({ ...base, run: { ...run, parent_run_id: 'p' } }), null)
  assert.equal(steerTarget({ ...base, run: { ...run, work_order: {} } }), null)
  assert.equal(steerTarget({ ...base, run: { ...run, model: 'chatgpt:web' } }), null)
  // the harness's word, when it named this run, decides either way
  assert.equal(steerTarget({ ...base, activeRun: { id: 'r1', steerable: false } }), null)
  assert.equal(steerTarget({ ...base, run: { ...run, relay_id: 'rl' }, activeRun: { id: 'r1', steerable: true } }), 'r1')
  // a word about another run (stale) or none (an older harness) falls back to what the page knows
  assert.equal(steerTarget({ ...base, activeRun: { id: 'r0', steerable: false } }), 'r1')
  assert.equal(steerTarget({ ...base, activeRun: { id: 'r1' } }), 'r1')
  assert.equal(activeRunMoved({ id: 'r1', status: 'running' }, { id: 'r1', status: 'running', steerable: true }), true)
  assert.equal(activeRunMoved(null, null), false)
})

test('the draft steers as words: files and @ chips are refused and kept, a plain @ is words', () => {
  assert.equal(steerRefusal('use the staging db @ 5pm, mail me at a@b.co', 0), null)
  assert.equal(steerRefusal('see @src/calc.py please', 0), null)
  assert.match(steerRefusal('look', 1)!, /Files cannot join/)
  assert.match(steerRefusal('ask @[Claude](agent:anthropic:claude#pt_1) too', 0)!, /agent or tool/)
  assert.match(steerRefusal('use @[Computer](tool:computer)', 0)!, /agent or tool/)
})

test('Enter sends; Shift+Enter is a new line; a key an input method composes never sends', () => {
  assert.equal(enterSends({ key: 'Enter', shiftKey: false, isComposing: false }), true)
  assert.equal(enterSends({ key: 'Enter', shiftKey: true, isComposing: false }), false)
  assert.equal(enterSends({ key: 'Enter', shiftKey: false, isComposing: true }), false)
  assert.equal(enterSends({ key: 'Tab', shiftKey: false, isComposing: false }), false)
  assert.equal(enterSends({ key: 'Escape', shiftKey: false, isComposing: false }), false)
})

test('words put back never replace a draft and are never trimmed', () => {
  assert.equal(putBackDraft('', '  a\n b  '), '  a\n b  ')
  assert.equal(putBackDraft('new words', '  a  '), 'new words\n\n  a  ')
  assert.equal(putBackDraft('new words\n', 'a'), 'new words\n\na')
})

test('every refusal keeps the draft and never starts a run', () => {
  const refused = (code: string, status = 409) => Object.assign(new Error('x'), { status, detail: 'd', body: { detail: 'd', code } })
  for (const code of ['run_not_live', 'run_finishing']) assert.match(steerErrorText(refused(code)), /ended before your words could join it\. Your draft is kept/)
  assert.match(steerErrorText(refused('not_steerable')), /does not take words while it works/)
  assert.match(steerErrorText(refused('key_conflict')), /draft is kept/)
  assert.match(steerErrorText(refused('steer_agents', 400)), /Agents named/)
  assert.match(steerErrorText(refused('other', 404)), /^d\. Your draft is kept/)
  assert.match(steerErrorText(new TypeError('Failed to fetch')), /may not have reached the harness .*sending it again is safe/)
})

test('a snapshot\'s end is provisional: the stream\'s own word places the steer between the tool result and the answer, once', () => {
  // the send's answer (or the run's list) said delivered before the stream got there: a row with no event id
  let t: ThreadEntry[] = applySteer([], 'r1', steer({ status: 'delivered', delivered_seq: 7 }))
  t = applyEvent(t, 'r1', ev('steer_queued', { steer: steer() }, '4'))                        // older: no move back
  t = applyEvent(t, 'r1', ev('tool_call', { tool: 'bash', tool_call_id: 'c1', summary: '' }, '5'))
  t = applyEvent(t, 'r1', ev('tool_result', { tool: 'bash', tool_call_id: 'c1', status: 'ok' }, '6'))
  assert.deepEqual(kinds(t), ['steer:st_1:delivered', 'tool:c1'])
  t = applyEvent(t, 'r1', ev('steer_delivered', { steer: steer({ status: 'delivered', delivered_seq: 7 }) }, '7'))
  t = applyEvent(t, 'r1', ev('text_block', { text: 'I read it' }, '8'))
  assert.deepEqual(kinds(t), ['tool:c1', 'steer:st_1:delivered', 'agent:I read it'])
  assert.equal(t[1]!.eventId, '7')
  // repeats and older words never move it again, never a second row
  for (const [name, seq, status] of [['steer_delivered', '7', 'delivered'], ['steer_queued', '4', 'queued']] as const) t = applyEvent(t, 'r1', ev(name, { steer: steer({ status }) }, seq))
  t = applySteer(t, 'r1', steer({ status: 'delivered' }))                                    // a snapshot again
  assert.deepEqual(kinds(t), ['tool:c1', 'steer:st_1:delivered', 'agent:I read it'])
  // two ends in contradiction: the persisted order decides — the stream's beats a snapshot, the earlier seq the later
  assert.equal(takesPlace(steer({ status: 'undelivered' }), undefined, steer({ status: 'delivered' }), '7'), true)
  assert.equal(takesPlace(steer({ status: 'delivered' }), '7', steer({ status: 'undelivered', reason: 'stopped' }), '9'), false)
  assert.equal(takesPlace(steer({ status: 'undelivered' }), '9', steer({ status: 'delivered' }), '7'), true)
  assert.equal(takesPlace(steer({ status: 'delivered' }), '7', steer({ status: 'delivered' }), undefined), false)
  assert.equal(takesPlace(steer({ status: 'delivered' }), undefined, steer({ status: 'queued' }), '4'), false)
})

test('the road of the words: a lost steer\'s very words first, then the live run; never the director\'s or a note\'s', () => {
  const pending = { session_id: 's', run_id: 'r_old', key: 'k-123456', text: '  w  ' }
  assert.deepEqual(steerRoute({ destination: 'agent', draft: '  w  ', pending, liveTarget: 'r_new' }), { run_id: 'r_old', key: 'k-123456' })
  assert.deepEqual(steerRoute({ destination: 'agent', draft: '  w  ', pending, liveTarget: null }), { run_id: 'r_old', key: 'k-123456' })
  assert.deepEqual(steerRoute({ destination: 'agent', draft: 'w', pending, liveTarget: 'r_new' }), { run_id: 'r_new', key: null })   // other words
  assert.equal(steerRoute({ destination: 'agent', draft: 'w', pending, liveTarget: null }), null)
  assert.equal(steerRoute({ destination: 'director', draft: '  w  ', pending, liveTarget: 'r_new' }), null)
  assert.equal(steerRoute({ destination: 'note', draft: '  w  ', pending, liveTarget: 'r_new' }), null)
  const box = new Map<string, string>()
  const storage = { getItem: (k: string) => box.get(k) ?? null, setItem: (k: string, v: string) => { box.set(k, v) } }
  writePendingSteers(storage, { s: pending })
  assert.deepEqual(readPendingSteers(storage), { s: pending })
  box.set('oasis-code.pendingSteers', '{"s":{"session_id":"other","run_id":"r","key":"k","text":"t"},"x":"bad"}')
  assert.deepEqual(readPendingSteers(storage), {})
  box.set('oasis-code.pendingSteers', 'not json')
  assert.deepEqual(readPendingSteers(storage), {})
})
