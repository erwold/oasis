/** The agent mention token with its participant's id (`pt_3f2a9c`; an earlier message's letter still reads as one):
 *  a participant named twice is one, two participants on one model are two, a token without an id is a participant
 *  of its own at each occurrence; what a person reads (`@Label`, the names that tell two alike apart) and what a model
 *  reads beside a roster (`@<id>`). */

import { expect, test } from 'bun:test'
import { agentMentionToken, agentMentionsOf, agentSegments, aliasedAgentMentions, newParticipantId, nextParticipantId, participantNames, participantsOf, plainAgentMentions, routedAgentMentions } from '@oasis-code/contract'

const OPUS = 'anthropic:claude-opus-5-5'
const a = agentMentionToken('Claude Opus 5.5', OPUS, 'A')
const b = agentMentionToken('Claude Opus 5.5', OPUS, 'B')
const legacy = agentMentionToken('GPT-6 Astra', 'openai:gpt-6-astra')

test('the token carries the alias; the same participant named again is one, two on one model are two', () => {
  expect(a).toBe('@[Claude Opus 5.5](agent:anthropic:claude-opus-5-5#A)')
  const text = `${a} fix it. ${b} fix it too, alone. ${a} then compare.`
  expect(agentMentionsOf(text).map((m) => [m.model, m.alias])).toEqual([[OPUS, 'A'], [OPUS, 'B'], [OPUS, 'A']])
  expect(participantsOf(text)).toEqual([{ id: 'A', label: 'Claude Opus 5.5', model: OPUS }, { id: 'B', label: 'Claude Opus 5.5', model: OPUS }])
  expect(nextParticipantId(text)).toMatch(/^pt_[0-9a-f]{6}$/)                         // a new participant: an id like the harness's others
  // the segments name the alias too (the chip wears it)
  const chips = agentSegments(text).filter((s) => 'agent' in s).map((s) => ('agent' in s ? s.agent.alias : null))
  expect(chips).toEqual(['A', 'B', 'A'])
})

test('a token without an alias is a participant of its own at each occurrence, given the letters no one holds', () => {
  expect(participantsOf(`${legacy} then ${legacy}`).map((p) => p.id)).toEqual(['A', 'B'])
  expect(participantsOf(`${b} and ${legacy}`).map((p) => [p.id, p.model])).toEqual([['B', OPUS], ['A', 'openai:gpt-6-astra']])
  expect(agentMentionsOf(legacy)[0]!.alias).toBeNull()
})

test('a person reads the labels; a model beside a roster reads the letters — unless there is one participant', () => {
  const text = `${a} and ${b}: ${a} fixes, ${b} reviews`
  expect(plainAgentMentions(text)).toBe('@Claude Opus 5.5 and @Claude Opus 5.5: @Claude Opus 5.5 fixes, @Claude Opus 5.5 reviews')
  expect(aliasedAgentMentions(text)).toBe('@A and @B: @A fixes, @B reviews')
  expect(aliasedAgentMentions(`${a} say hi, ${a}`)).toBe('@Claude Opus 5.5 say hi, @Claude Opus 5.5')       // one participant: its name
  expect(aliasedAgentMentions(`${legacy} then ${legacy}`)).toBe('@A then @B')                                 // two legacy tokens: two letters, in order
  expect(aliasedAgentMentions(`${b} and ${legacy}`)).toBe('@B and @A')
  expect(aliasedAgentMentions('no agents here @alice')).toBe('no agents here @alice')
})

test("a participant's id is a string like the harness's others: new ones never repeat a message's, and read back as written", () => {
  const taken = ['pt_000000', 'pt_000001']
  for (let i = 0; i < 50; i += 1) expect(taken).not.toContain(newParticipantId(taken))
  const p = agentMentionToken('Claude Opus 5.5', OPUS, 'pt_3f2a9c')
  const q = agentMentionToken('Claude Opus 5.5', OPUS, 'pt_8c1d4e')
  expect(p).toBe('@[Claude Opus 5.5](agent:anthropic:claude-opus-5-5#pt_3f2a9c)')
  const text = `${p} and ${q}, then ${p} compares`
  expect(participantsOf(text).map((x) => x.id)).toEqual(['pt_3f2a9c', 'pt_8c1d4e'])
  expect(aliasedAgentMentions(text)).toBe('@pt_3f2a9c and @pt_8c1d4e, then @pt_3f2a9c compares')     // what the model reads
  expect(plainAgentMentions(text)).toBe('@Claude Opus 5.5 and @Claude Opus 5.5, then @Claude Opus 5.5 compares')
  // what a chat client's director reads (typed into ChatGPT's page): the name and the route start_run takes
  expect(routedAgentMentions(`${p} 看看这个`)).toBe('@Claude Opus 5.5 (anthropic:claude-opus-5-5) 看看这个')
  // what the person reads: the label — or, when two share it, each its own id (a place number would say nothing of it)
  expect([...participantNames([{ id: 'pt_3f2a9c', label: 'Claude Opus 5.5' }, { id: 'pt_8c1d4e', label: 'Claude Opus 5.5' }, { id: 'pt_aa0001', label: 'GPT-6' }])]).toEqual([
    ['pt_3f2a9c', 'pt_3f2a9c'], ['pt_8c1d4e', 'pt_8c1d4e'], ['pt_aa0001', 'GPT-6'],
  ])
})
