/** The browser e2e's second relay participant proves what its provider was handed, and nothing less: the packet of
 *  the first participant's turn with its marker and the line of its successful read_file of calc.py, the roster
 *  naming it B after A, and the note opening its turn with B speaking right after A. Each of them missing — the
 *  record of the read above all — is REVIEW_CONTEXT_MISSING; the retired role sentences count for nothing. */

import { expect, test } from 'bun:test'
import { modelRequest, modelResponse, textPart, userPrompt, type ModelMessage } from '../src/llm/messages.ts'
import { callLine } from '../src/agent/peer_packet.ts'
import { text } from '../src/prompt_texts.ts'
import { RELAY_MARKER, relayReviewerScript } from '../scripts/e2e_server.ts'

// the participants' ids are the ones the person's chips carry: the reviewer reads them off the roster
const [A, B] = ['pt_a1a1a1', 'pt_b2b2b2']
const ROSTER = text('relay.roster', { participants: `${A}: Scripted Relay A (scripted:relay-a)\n${B}: Scripted Relay B (scripted:relay-b)`, order: `${A}, ${B}` })
const TURN_2 = text('relay.turn', { turn: 2, total: 2, speaker: B, authors: A, next: 'none' })
const READ_OK = callLine('read_file', { path: 'calc.py' }, { part_kind: 'tool-return', tool_name: 'read_file', tool_call_id: 'c1', content: { status: 'ok', path: 'calc.py' } } as never)
const READ_REFUSED = callLine('read_file', { path: 'calc.py' }, { part_kind: 'tool-return', tool_name: 'read_file', tool_call_id: 'c1', content: { status: 'refused', reason: 'outside' } } as never)
const packet = (o: { speaker?: string; answer?: string; calls?: string | null } = {}) => text('packet.body', {
  heading: text('packet.turn', { turn: 1, speaker: o.speaker ?? A, run_id: 'run_0123456789ab' }),
  answer: o.answer ?? `${RELAY_MARKER}: add() subtracts.`, calls: o.calls === null ? '' : text('packet.calls', { count: 1, lines: o.calls ?? READ_OK }), measured: 'status done.',
})

function conversation(o: { packet?: string; roster?: string; note?: string } = {}): ModelMessage[] {
  return [modelRequest([userPrompt([`Working folder: /ws\n${o.roster ?? ROSTER}`, o.packet ?? packet(), o.note ?? TURN_2, 'Inspect calc.py together.'])])]
}

const answer = (messages: ModelMessage[]) => relayReviewerScript()(messages).parts.map((p) => ('content' in p ? String(p.content) : '')).join('')

test('with the packet (marker and the successful read), the roster and the turn note it says REVIEW_CONTEXT_OK', () => {
  expect(READ_OK).toStartWith('[read_file calc.py → ok')
  expect(answer(conversation())).toStartWith('REVIEW_CONTEXT_OK')
})

test('without the record of the read — no line, a refused read, or another speaker\'s — it does not pass', () => {
  expect(answer(conversation({ packet: packet({ calls: null }) }))).toBe('REVIEW_CONTEXT_MISSING — marker true, read_file false, roster true, turn true')   // no calls: no calls section
  expect(answer(conversation({ packet: packet({ calls: READ_REFUSED }) }))).toContain('read_file false')
  expect(answer(conversation({ packet: packet({ speaker: 'pt_c3c3c3' }) }))).toContain('marker false, read_file false')
})

test('the marker, the roster and the turn order are each required; the retired role sentences do not count', () => {
  expect(answer(conversation({ packet: packet({ answer: 'add() subtracts.' }) }))).toContain('marker false')
  expect(answer(conversation({ roster: 'You are Scripted Relay B (scripted:relay-b), the reviewer.' }))).toContain('roster false')
  expect(answer(conversation({ note: "the assistant turns before this message are Scripted Relay A's" }))).toContain('turn false')
  expect(answer(conversation({ note: text('relay.turn', { turn: 2, total: 2, speaker: A, authors: B, next: 'none' }) }))).toContain('turn false')
  // a second round: the last note counts, A spoke just before
  const round2 = [...conversation(), modelResponse([textPart('REVIEW_CONTEXT_OK')]), modelRequest([userPrompt([text('relay.turn', { turn: 4, total: 4, speaker: B, authors: `${A}, ${B}, ${A}`, next: 'none' })])])]
  expect(answer(round2)).toStartWith('REVIEW_CONTEXT_OK')
})
