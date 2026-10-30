/** The message model: the persisted JSON reads back through the contract's schema (histories the first backend
 *  stored included), a request is a byte-identical prefix extension of the previous one until the archive fires,
 *  and the handoff strips exactly the provider-owned fields and counts them. */

import { expect, test } from 'bun:test'
import { ModelMessagesSchema } from '@oasis-code/contract'
import { handoffNote, noteOnFirstRequest, portableHistory } from '../src/llm/handoff.ts'
import {
  dumpJson, isRequest, isResponse, isThinking, isToolCall, isUserPrompt, loadJson, modelRequest, modelResponse, textPart,
  thinkingPart, toolCallPart, toolReturn, userPrompt, type RequestPart,
} from '../src/llm/messages.ts'

/** A history as pydantic-ai (the first backend) stored it: every field it writes, in its names. */
const LEGACY = JSON.stringify([
  { parts: [{ content: 'User request: read calc.py', timestamp: '2026-09-26T08:00:00.000Z', part_kind: 'user-prompt' }],
    instructions: 'You are an oasis-code agent', kind: 'request' },
  { parts: [{ content: 'private', id: null, signature: 'sig-a', provider_name: 'anthropic', provider_details: null, part_kind: 'thinking' },
    { tool_name: 'read_file', args: { path: 'calc.py' }, tool_call_id: 'toolu_01', id: null, provider_name: 'anthropic', provider_details: null, part_kind: 'tool-call' }],
    usage: { input_tokens: 10, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 7, input_audio_tokens: 0, cache_audio_read_tokens: 0, output_audio_tokens: 0, details: {} },
    model_name: 'claude-x', timestamp: '2026-09-26T08:00:01.000Z', provider_name: 'anthropic', provider_details: null, provider_response_id: 'msg_a1',
    provider_url: null, finish_reason: 'tool_call', run_id: 'run_1', kind: 'response' },
  { parts: [{ tool_name: 'read_file', content: { status: 'ok', path: 'calc.py', sha256: 'ab'.repeat(32) }, tool_call_id: 'toolu_01', metadata: null,
    timestamp: '2026-09-26T08:00:02.000Z', part_kind: 'tool-return' }], instructions: 'You are an oasis-code agent', kind: 'request' },
  { parts: [{ content: 'A read calc.py', id: null, provider_name: 'anthropic', provider_details: null, part_kind: 'text' },
    { part_kind: 'builtin-tool-call', tool_name: 'web_search', args: {}, tool_call_id: 'srvtoolu_1', provider_name: 'anthropic' }],
    usage: { input_tokens: 20, output_tokens: 3 }, model_name: 'claude-x', timestamp: '2026-09-26T08:00:03.000Z', provider_name: 'anthropic',
    provider_details: null, provider_response_id: 'msg_a2', kind: 'response' },
])

test('a history the first backend stored reads back with every field kept', () => {
  const messages = loadJson(LEGACY)
  expect(messages).toHaveLength(4)
  const response = messages[1]!
  expect(isResponse(response) && response.provider_response_id).toBe('msg_a1')
  expect(isResponse(response) && response.parts[0]!.part_kind).toBe('thinking')
  expect((response as { run_id?: string }).run_id).toBe('run_1')
  const foreign = (messages[3] as { parts: { part_kind: string }[] }).parts[1]!
  expect(foreign.part_kind).toBe('builtin-tool-call')
  expect(JSON.parse(dumpJson(messages))).toEqual(JSON.parse(LEGACY))
  expect(ModelMessagesSchema.safeParse([{ kind: 'nonsense' }]).success).toBe(false)
})

test('appending a message leaves the earlier bytes untouched', () => {
  const first = [modelRequest([userPrompt('one')], 'inst')]
  const second = [...first, modelResponse([toolCallPart('read_file', { path: 'a' }, 'tc1')]), modelRequest([toolReturn('read_file', { ok: 1 }, 'tc1')], 'inst')]
  const a = dumpJson(first)
  const b = dumpJson(second)
  expect(b.startsWith(a.slice(0, -1))).toBe(true)
})

test('the handoff strips foreign reasoning and references, keeps text and calls, and says so once', () => {
  const messages = loadJson(LEGACY)
  const [portable, report] = portableHistory(messages, 'openai')
  expect(report).toEqual({ foreign_responses: 2, dropped_thinking_parts: 1, stripped_item_ids: 0, foreign_models: ['claude-x'], target: 'openai' })
  const responses = portable.filter(isResponse)
  expect(responses.every((m) => m.provider_name === null && m.provider_response_id === null)).toBe(true)
  expect(responses.some((m) => m.parts.some(isThinking))).toBe(false)
  const call = responses[0]!.parts.find(isToolCall)!
  expect(call.tool_name).toBe('read_file')
  expect(call.provider_name).toBeNull()
  expect(JSON.stringify(responses[1]!.parts)).toContain('[Earlier builtin-tool-call content is unavailable.]')
  // the same provider passes untouched, the same objects
  const [same, none] = portableHistory(messages, 'anthropic')
  expect(none.foreign_responses).toBe(0)
  expect(same[1]).toBe(messages[1]!)
  const note = handoffNote(report, 'anthropic:claude-x', 'openai:gpt')!
  expect(note).toContain('App note: Earlier turns came from')
  expect(note).toContain('unavailable parts are marked')
  expect(handoffNote(none, null, 'x')).toBeNull()
  // the history ends with a response: the note becomes a request of its own; ending with a request, it joins that request
  const noted = noteOnFirstRequest(portable, note)
  expect(noted).toHaveLength(portable.length + 1)
  expect(noted.slice(0, -1)).toEqual(portable)
  const joined = noteOnFirstRequest([...portable, modelRequest([userPrompt('next')])], note)
  const last = joined[joined.length - 1]!
  expect(isRequest(last) && last.parts.length).toBe(2)
  expect(joined.slice(0, -1).map((m) => dumpJson([m]))).toEqual(portable.map((m) => dumpJson([m])))
  const asked = noteOnFirstRequest([modelResponse([textPart('x')])], 'note')
  expect(isRequest(asked[asked.length - 1]!) && isUserPrompt((asked[1] as unknown as { parts: RequestPart[] }).parts[0]!)).toBe(true)
})

test('a thinking part keeps its signature', () => {
  expect(thinkingPart('t', { signature: 's' }).signature).toBe('s')
})
