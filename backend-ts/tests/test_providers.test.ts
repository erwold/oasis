/** The three real provider paths through their mappings against a scripted fetch that speaks each provider's
 *  streaming protocol: text deltas, a tool call, the tool result on the next request, usage — and a session
 *  continued from one provider to another, both ways, through the handoff (reasoning and provider references
 *  removed, everything portable kept, one explicit note). The wire shapes here are the contract with each API. */

import { expect, test } from 'bun:test'
import { z } from '@oasis-code/contract'
import { ContextView } from '../src/agent/history.ts'
import { Agent } from '../src/agent/loop.ts'
import { ModelConfig } from '../src/config.ts'
import { handoffNote, noteOnFirstRequest, portableHistory, responseRoute } from '../src/llm/handoff.ts'
import { postJson, readSse } from '../src/llm/http.ts'
import { isResponse, isThinking, isToolCall, modelRequest, modelResponse, textPart, userPrompt, type ModelMessage } from '../src/llm/messages.ts'
import { ModelHTTPError, TransportError } from '../src/llm/model.ts'
import { AnthropicModel, buildModel, CredentialUnavailable, GoogleModel, OpenAIChatModel, OpenAIResponsesModel, providerSystem } from '../src/llm/providers.ts'
import { claudeThinking, thinkingFields } from '../src/llm/providers/anthropic.ts'
import { Route, runAgent, zodTool } from './helpers.ts'
import {
  anthropicResponses, anthropicStream, GEMINI_SIGNATURE, geminiChunk, geminiResponses, geminiStream, geminiUsage, openaiResponses, openaiStream, READ_CALC,
} from './providers_fixtures.ts'

const INSTRUCTIONS = 'You are an oasis-code agent. Read before you patch.'

function agent(): Agent<null> {
  return new Agent<null>({
    instructions: INSTRUCTIONS,
    tools: [
      zodTool<null, z.ZodType>('read_file', 'Read a file', z.object({ path: z.string() }), (_d, args) => ({ status: 'ok', path: (args as { path: string }).path, sha256: 'ab'.repeat(32), text: 'def add(a, b):\n    return a - b\n' })),
      zodTool<null, z.ZodType>('apply_patch', 'Apply a patch', z.object({ patch: z.string() }), () => ({ status: 'ok' })),
      zodTool<null, z.ZodType>('run_command', 'Run a command', z.object({ command: z.string() }), () => ({ status: 'ok' })),
      zodTool<null, z.ZodType>('checkpoint', 'Checkpoint', z.object({ message: z.string() }), () => ({ status: 'ok' })),
    ],
  })
}

function itemText(item: Record<string, unknown>): string {
  const content = item.content
  if (typeof content === 'string') return content
  return ((content as Record<string, unknown>[]) ?? []).map((c) => (typeof c.text === 'string' ? c.text : '')).join(' ')
}

test('Anthropic: streaming, a tool call and its result on the wire, usage with the cache share', async () => {
  const route = new Route(anthropicResponses())
  const model = new AnthropicModel('claude-x', { apiKey: 'test-key-a', baseUrl: 'http://anthropic.mock', fetchImpl: route.fetch })
  const run = await runAgent(agent(), model, 'User request: read calc.py', null, { settings: { max_tokens: 4096 } })
  expect(run.result.output).toBe('calc.py has a bug in add().')
  // the wire: the official Messages API shape with our tools, streaming, the instructions as system text
  expect(route.urls[0]).toBe('http://anthropic.mock/v1/messages')
  expect(route.headers[0]!.get('x-api-key')).toBe('test-key-a')
  expect(route.headers[0]!.get('anthropic-version')).toBe('2023-06-01')
  const first = route.requests[0]!
  expect(first.model).toBe('claude-x')
  expect(first.stream).toBe(true)
  const tools = first.tools as { name: string; input_schema: unknown }[]
  expect(new Set(tools.map((t) => t.name))).toEqual(new Set(['read_file', 'apply_patch', 'run_command', 'checkpoint']))
  expect(tools[0]!.input_schema).toBeDefined()
  expect(JSON.stringify(first.system)).toContain('oasis-code agent')
  // the prompt cache is asked for on every request: the automatic breakpoint on the conversation, an explicit one on
  // the last system block (tools and system as one entry), the default 5-minute TTL when the route names none
  expect(first.cache_control).toEqual({ type: 'ephemeral' })
  const systemBlocks = first.system as { text: string; cache_control?: unknown }[]
  expect(systemBlocks[systemBlocks.length - 1]!.cache_control).toEqual({ type: 'ephemeral' })
  expect(systemBlocks.slice(0, -1).every((b) => b.cache_control === undefined)).toBe(true)
  expect(JSON.stringify((first.messages as unknown[])[0])).toContain('User request: read calc.py')
  expect(JSON.stringify(first.messages)).not.toContain('cache_control')
  // the second request carries the thinking block with its signature, the tool_use and our tool_result
  const second = route.requests[1]!
  const messages = second.messages as { role: string; content: Record<string, unknown>[] }[]
  const assistant = messages.filter((m) => m.role === 'assistant').at(-1)!
  expect(assistant.content.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use'])
  expect(assistant.content[0]!.signature).toBe('sig-claude-1')
  expect(assistant.content[2]!.id).toBe('toolu_01')
  expect(assistant.content[2]!.input).toEqual(READ_CALC)
  const results = messages.filter((m) => m.role === 'user').flatMap((m) => m.content).filter((b) => b.type === 'tool_result')
  expect(results[0]!.tool_use_id).toBe('toolu_01')
  expect(JSON.stringify(results[0]!.content)).toContain('sha256')
  // the events: streamed text, thinking, the tool call keyed by the provider's id
  expect(run.texts.join('')).toStartWith('Let me read calc.py.')
  const call = run.events.find((e) => e.type === 'tool_call')!
  expect(call.type === 'tool_call' && call.part.tool_name).toBe('read_file')
  expect(call.type === 'tool_call' && call.part.tool_call_id).toBe('toolu_01')
  expect(run.events.some((e) => e.type === 'part_delta' && e.delta.part_kind === 'thinking')).toBe(true)
  // usage: reported tokens per response, the cache share on the second
  const responses = run.result.allMessages().filter(isResponse)
  expect(responses.map((r) => r.model_name)).toEqual(['claude-x', 'claude-x'])
  expect(responses[0]!.usage).toMatchObject({ input_tokens: 10, output_tokens: 7 })
  expect(responses[1]!.usage).toMatchObject({ input_tokens: 14, cache_read_tokens: 4 })
  expect(responses[0]!.provider_name).toBe('anthropic')
  expect(responses[0]!.provider_response_id).toBe('msg_1')
  expect(responses[0]!.finish_reason).toBe('tool_call')
  expect(run.result.usage.requests).toBe(2)
})

test('OpenAI Responses: streaming, function_call / function_call_output by call_id, reasoning kept for its owner', async () => {
  const route = new Route(openaiResponses())
  const model = new OpenAIResponsesModel('gpt-y', { apiKey: 'test-key-b', baseUrl: 'http://openai.mock/v1', fetchImpl: route.fetch })
  const run = await runAgent(agent(), model, 'User request: read calc.py', null)
  expect(run.result.output).toBe('add() subtracts.')
  expect(route.urls[0]).toBe('http://openai.mock/v1/responses')
  expect(route.headers[0]!.get('authorization')).toBe('Bearer test-key-b')
  const first = route.requests[0]!
  expect(first.model).toBe('gpt-y')
  expect(first.stream).toBe(true)
  const tools = first.tools as { type: string; name: string }[]
  expect(new Set(tools.filter((t) => t.type === 'function').map((t) => t.name))).toEqual(new Set(['read_file', 'apply_patch', 'run_command', 'checkpoint']))
  expect(JSON.stringify(first.instructions)).toContain('oasis-code agent')
  expect(first.include).toEqual(['reasoning.encrypted_content'])
  expect(first.store).toBe(false)
  expect('prompt_cache_key' in first).toBe(false)                                          // none named: none sent
  const second = route.requests[1]!
  const input = second.input as Record<string, unknown>[]
  const types = input.map((i) => i.type)
  expect(types).toContain('function_call')
  expect(types).toContain('function_call_output')
  // the provider's own reasoning item travels back to it with the encrypted content and its id
  const reasoning = input.find((i) => i.type === 'reasoning')!
  expect(reasoning.id).toBe('rs_1')
  expect(reasoning.encrypted_content).toBe('ENCRYPTED-REASONING')
  const call = input.find((i) => i.type === 'function_call')!
  const out = input.find((i) => i.type === 'function_call_output')!
  expect(call.call_id).toBe('call_01')
  expect(call.id).toBe('fc_1')
  expect(out.call_id).toBe('call_01')
  expect(out.output as string).toContain('"sha256"')
  expect(run.texts.join('')).toStartWith('Reading calc.py.')
  const callEvent = run.events.find((e) => e.type === 'tool_call')!
  expect(callEvent.type === 'tool_call' && callEvent.part.tool_call_id).toBe('call_01')
  const responses = run.result.allMessages().filter(isResponse)
  expect(responses[0]!.usage).toMatchObject({ input_tokens: 11, output_tokens: 6 })
  expect(responses[1]!.usage).toMatchObject({ cache_read_tokens: 3 })
  expect(responses[0]!.parts.find(isThinking)!.content).toBe('Reading first.')
  expect(responses[0]!.parts.find(isToolCall)!.args).toEqual(READ_CALC)
})

test('Gemini: streamGenerateContent with the key in a header, a thought signature sent back, usage with the cached share', async () => {
  const route = new Route(geminiResponses())
  const model = new GoogleModel('gemini-z', { apiKey: 'test-key-gemini', baseUrl: 'http://gemini.mock', fetchImpl: route.fetch })
  const run = await runAgent(agent(), model, 'User request: read calc.py', null)
  expect(run.result.output).toBe('add() subtracts; that is the bug.')
  expect(route.urls[0]).toStartWith('http://gemini.mock/')
  expect(route.urls[0]).toContain('models/gemini-z:streamGenerateContent')
  expect(route.urls.every((u) => !u.includes('test-key-gemini'))).toBe(true)
  expect(route.headers[0]!.get('x-goog-api-key')).toBe('test-key-gemini')
  const first = route.requests[0]!
  const declared = new Set((first.tools as { functionDeclarations: { name: string }[] }[]).flatMap((t) => t.functionDeclarations.map((f) => f.name)))
  expect(declared).toEqual(new Set(['read_file', 'apply_patch', 'run_command', 'checkpoint']))
  expect(JSON.stringify(first.systemInstruction)).toContain('oasis-code agent')
  const partsOf = (body: Record<string, unknown>, role: string) =>
    (body.contents as { role: string; parts: Record<string, unknown>[] }[]).filter((c) => c.role === role).flatMap((c) => c.parts)
  expect(JSON.stringify(partsOf(first, 'user'))).toContain('User request: read calc.py')
  const second = route.requests[1]!
  const call = partsOf(second, 'model').find((p) => 'functionCall' in p)!
  expect((call.functionCall as { name: string }).name).toBe('read_file')
  expect(call.thoughtSignature).toBe(GEMINI_SIGNATURE)
  const responses = partsOf(second, 'user').filter((p) => 'functionResponse' in p).map((p) => p.functionResponse as { name: string; response: unknown })
  expect(responses[0]!.name).toBe('read_file')
  expect(JSON.stringify(responses[0]!.response)).toContain('sha256')
  expect(run.events.some((e) => e.type === 'part_delta' && e.delta.part_kind === 'thinking')).toBe(true)
  expect(run.texts.join('')).toStartWith('Reading calc.py.')
  const history = run.result.allMessages().filter(isResponse)
  expect(history.map((r) => r.model_name)).toEqual(['gemini-z', 'gemini-z'])
  expect(history[0]!.usage).toMatchObject({ input_tokens: 12, output_tokens: 5 })
  expect(history[1]!.usage).toMatchObject({ cache_read_tokens: 8 })
  expect(history[0]!.parts.find(isToolCall)!.tool_call_id).toMatch(/^call_/)
})

test('OpenAI Chat Completions: messages by role, tool_calls by id, chunk stream with usage', async () => {
  const chunks = (pieces: string[], calls: Record<string, unknown>[] | null, usage: Record<string, unknown>) => {
    const out: string[] = []
    for (const piece of pieces) out.push(`data: ${JSON.stringify({ id: 'chat_1', model: 'gpt-c', choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`)
    if (calls) {
      out.push(`data: ${JSON.stringify({ id: 'chat_1', model: 'gpt-c', choices: [{ index: 0, delta: { tool_calls: calls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: '' } })) }, finish_reason: null }] })}\n\n`)
      calls.forEach((c, i) => out.push(`data: ${JSON.stringify({ id: 'chat_1', model: 'gpt-c', choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: JSON.stringify(c.args) } }] }, finish_reason: null }] })}\n\n`))
    }
    out.push(`data: ${JSON.stringify({ id: 'chat_1', model: 'gpt-c', choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }] })}\n\n`)
    out.push(`data: ${JSON.stringify({ id: 'chat_1', model: 'gpt-c', choices: [], usage })}\n\n`)
    out.push('data: [DONE]\n\n')
    return out.join('')
  }
  const route = new Route([
    chunks(['Reading ', 'it.'], [{ id: 'call_c1', name: 'read_file', args: READ_CALC }], { prompt_tokens: 9, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } }),
    chunks(['done'], null, { prompt_tokens: 20, completion_tokens: 1 }),
  ])
  const model = new OpenAIChatModel('gpt-c', { apiKey: 'k', baseUrl: 'http://chat.mock/v1', fetchImpl: route.fetch })
  const run = await runAgent(agent(), model, 'read calc.py', null)
  expect(run.result.output).toBe('done')
  expect(route.urls[0]).toBe('http://chat.mock/v1/chat/completions')
  const first = route.requests[0]!
  expect((first.messages as { role: string }[])[0]!.role).toBe('system')
  expect(first.stream_options).toEqual({ include_usage: true })
  expect((first.tools as { function: { name: string } }[]).map((t) => t.function.name)).toContain('read_file')
  const second = route.requests[1]!.messages as Record<string, unknown>[]
  const assistant = second.find((m) => m.role === 'assistant')!
  expect((assistant.tool_calls as { id: string; function: { name: string; arguments: string } }[])[0]).toMatchObject({ id: 'call_c1', function: { name: 'read_file', arguments: JSON.stringify(READ_CALC) } })
  const toolMessage = second.find((m) => m.role === 'tool')!
  expect(toolMessage.tool_call_id).toBe('call_c1')
  const responses = run.result.allMessages().filter(isResponse)
  expect(responses[0]!.usage).toMatchObject({ input_tokens: 9, output_tokens: 4, cache_read_tokens: 2 })
  expect(responses[0]!.finish_reason).toBe('tool_call')
})

test('OpenAI Chat Completions: a call\'s name streamed in pieces is the whole name, and an id that comes after its first chunk is the call\'s', async () => {
  const delta = (d: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: 'chat_1', model: 'gpt-c', choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`
  const call = (fn: Record<string, unknown>, id?: string) => ({ tool_calls: [{ index: 0, ...(id ? { id, type: 'function' } : {}), function: fn }] })
  const route = new Route([
    delta(call({ name: 'read' })) + delta(call({ name: '_fi' }, 'call_late')) + delta(call({ name: 'le', arguments: JSON.stringify(READ_CALC) })) + delta({}, 'tool_calls') + 'data: [DONE]\n\n',
    delta({ content: 'done' }) + delta({}, 'stop') + 'data: [DONE]\n\n',
  ])
  const model = new OpenAIChatModel('gpt-c', { apiKey: 'k', baseUrl: 'http://chat.mock/v1', fetchImpl: route.fetch })
  const run = await runAgent(agent(), model, 'read calc.py', null)
  expect(run.result.output).toBe('done')
  const called = run.result.allMessages().filter(isResponse)[0]!.parts.filter(isToolCall)
  expect(called.map((p) => [p.tool_name, p.tool_call_id])).toEqual([['read_file', 'call_late']])
  const toolMessage = (route.requests[1]!.messages as Record<string, unknown>[]).find((m) => m.role === 'tool')!
  expect(toolMessage.tool_call_id).toBe('call_late')
})

/** A session's history after the first run on a route (what the next run continues from). */
async function historyAfter(model: AnthropicModel | OpenAIResponsesModel | GoogleModel): Promise<ModelMessage[]> {
  const run = await runAgent(agent(), model, 'User request: read calc.py', null)
  return run.result.allMessages()
}

function continued(history: ModelMessage[], targetSystem: string, fromModel: string, toModel: string): [ModelMessage[], ReturnType<typeof portableHistory>[1]] {
  const [portable, report] = portableHistory(history, targetSystem)
  const note = handoffNote(report, fromModel, toModel)
  return [note ? noteOnFirstRequest(portable, note) : portable, report]
}

test('Claude then GPT: reasoning stays home, the call/result pair and the texts travel, one note', async () => {
  const a = new Route(anthropicResponses())
  const history = await historyAfter(new AnthropicModel('claude-x', { apiKey: 'a', baseUrl: 'http://anthropic.mock', fetchImpl: a.fetch }))
  const b = new Route([openaiStream({ model: 'gpt-y', items: [{ type: 'message', id: 'msg_9', pieces: ['GPT: it subtracts; I will fix it next.'] }] })])
  const [portable, report] = continued(history, 'openai', 'anthropic:claude-x', 'openai:gpt')
  const run = await runAgent(agent(), new OpenAIResponsesModel('gpt-y', { apiKey: 'b', baseUrl: 'http://openai.mock/v1', fetchImpl: b.fetch }), 'what is wrong?', null, { history: portable })
  expect(run.result.output).toBe('GPT: it subtracts; I will fix it next.')
  const body = b.requests[0]!
  const dumped = JSON.stringify(body)
  expect(dumped).not.toContain('sig-claude-1')                 // Claude's reasoning stays home
  expect(dumped).not.toContain('I should read the file first')
  expect(dumped).toContain('toolu_01')                         // the call/result pair is kept
  const items = body.input as Record<string, unknown>[]
  expect(items.filter((i) => i.type === 'function_call' || i.type === 'function_call_output').map((i) => i.type)).toEqual(['function_call', 'function_call_output'])
  expect(items.some((i) => i.type === 'reasoning')).toBe(false)
  const userTexts = items.filter((i) => i.role === 'user').map(itemText)
  expect(userTexts.some((t) => t.includes('User request: read calc.py'))).toBe(true)
  expect(userTexts.some((t) => t.includes('what is wrong?'))).toBe(true)
  expect(userTexts.some((t) => t.includes('Earlier turns came from') && t.includes('unavailable parts are marked'))).toBe(true)   // one explicit handoff note
  expect(items.filter((i) => i.role === 'assistant').map(itemText).some((t) => t.includes('has a bug in add()'))).toBe(true)
  expect('previous_response_id' in body).toBe(false)
  expect(report.dropped_thinking_parts).toBe(1)
  expect(report.foreign_models).toEqual(['claude-x'])
})

test('GPT then Claude: encrypted reasoning and item ids stay home, the tool_use keeps its call id', async () => {
  const b = new Route(openaiResponses())
  const history = await historyAfter(new OpenAIResponsesModel('gpt-y', { apiKey: 'b', baseUrl: 'http://openai.mock/v1', fetchImpl: b.fetch }))
  const a = new Route([anthropicStream({ model: 'claude-x', stop: 'end_turn', blocks: [{ type: 'text', pieces: ['Claude: fixing next.'] }] })])
  const [portable, report] = continued(history, 'anthropic', 'openai:gpt-y', 'anthropic:claude')
  const run = await runAgent(agent(), new AnthropicModel('claude-x', { apiKey: 'a', baseUrl: 'http://anthropic.mock', fetchImpl: a.fetch }), 'and now?', null, { history: portable })
  expect(run.result.output).toBe('Claude: fixing next.')
  const body = a.requests[0]!
  const dumped = JSON.stringify(body)
  for (const foreign of ['ENCRYPTED-REASONING', 'Reading first.', 'rs_1']) expect(dumped).not.toContain(foreign)
  const messages = body.messages as { role: string; content: Record<string, unknown>[] }[]
  const assistantBlocks = messages.filter((m) => m.role === 'assistant').flatMap((m) => m.content)
  expect(assistantBlocks.some((b) => b.type === 'thinking')).toBe(false)
  const toolUse = assistantBlocks.filter((b) => b.type === 'tool_use')
  expect(toolUse[0]).toMatchObject({ id: 'call_01', name: 'read_file' })
  const results = messages.filter((m) => m.role === 'user').flatMap((m) => m.content).filter((b) => b.type === 'tool_result')
  expect(results[0]!.tool_use_id).toBe('call_01')
  expect(dumped).toContain('Earlier turns came from')
  expect(dumped).toContain('unavailable parts are marked')
  expect(assistantBlocks.some((b) => JSON.stringify(b).includes('add() subtracts'))).toBe(true)
  expect(report.foreign_models).toEqual(['gpt-y'])
})

test('Claude then Gemini and Gemini then GPT: signatures never cross providers, the note names the target', async () => {
  const a = new Route(anthropicResponses())
  const claudeHistory = await historyAfter(new AnthropicModel('claude-x', { apiKey: 'a', baseUrl: 'http://anthropic.mock', fetchImpl: a.fetch }))
  const g = new Route([geminiStream([geminiChunk([{ text: 'Gemini: it subtracts.' }], { finish: 'STOP', usage: geminiUsage(30, 4) })])])
  const [toGemini, report] = continued(claudeHistory, 'google', 'anthropic:claude-x', 'google:gemini')
  const run = await runAgent(agent(), new GoogleModel('gemini-z', { apiKey: 'g', baseUrl: 'http://gemini.mock', fetchImpl: g.fetch }), 'what is wrong?', null, { history: toGemini })
  expect(run.result.output).toBe('Gemini: it subtracts.')
  const body = g.requests[0]!
  const dumped = JSON.stringify(body)
  expect(dumped).not.toContain('sig-claude-1')
  expect(dumped).not.toContain('I should read the file first')
  const partsOf = (b: Record<string, unknown>, role: string) => (b.contents as { role: string; parts: Record<string, unknown>[] }[]).filter((c) => c.role === role).flatMap((c) => c.parts)
  const modelParts = partsOf(body, 'model')
  const calls = modelParts.filter((p) => 'functionCall' in p)
  expect((calls[0]!.functionCall as { name: string }).name).toBe('read_file')
  expect(calls[0]!.thoughtSignature).toBeUndefined()
  expect(modelParts.some((p) => String(p.text ?? '').includes('has a bug in add()'))).toBe(true)
  const userText = JSON.stringify(partsOf(body, 'user'))
  expect(userText).toContain('Earlier turns came from')
  expect(userText).toContain('unavailable parts are marked')
  expect(report.foreign_models).toEqual(['claude-x'])
  expect(report.dropped_thinking_parts).toBe(1)
  // and from Gemini on to GPT
  const g2 = new Route(geminiResponses())
  const geminiHistory = await historyAfter(new GoogleModel('gemini-z', { apiKey: 'g', baseUrl: 'http://gemini.mock', fetchImpl: g2.fetch }))
  const b = new Route([openaiStream({ model: 'gpt-y', items: [{ type: 'message', id: 'msg_7', pieces: ['GPT: fixing next.'] }] })])
  const [toGpt, report2] = continued(geminiHistory, 'openai', 'google:gemini-z', 'openai:gpt')
  const run2 = await runAgent(agent(), new OpenAIResponsesModel('gpt-y', { apiKey: 'b', baseUrl: 'http://openai.mock/v1', fetchImpl: b.fetch }), 'and now?', null, { history: toGpt })
  expect(run2.result.output).toBe('GPT: fixing next.')
  const dumped2 = JSON.stringify(b.requests[0])
  expect(dumped2).not.toContain(GEMINI_SIGNATURE)
  expect(dumped2).not.toContain('Weighing where to look.')
  const items = b.requests[0]!.input as Record<string, unknown>[]
  expect(items.filter((i) => i.type === 'function_call' || i.type === 'function_call_output').map((i) => i.type)).toEqual(['function_call', 'function_call_output'])
  expect(dumped2).toContain('Earlier turns came from')
  expect(report2.foreign_models).toEqual(['gemini-z'])
})

test('one vendor, another route: reasoning, signatures and item ids go back only to the endpoint and model that made them', async () => {
  const onwards = async (history: ModelMessage[], model: AnthropicModel | OpenAIResponsesModel | OpenAIChatModel, route: Route) => {
    await runAgent(agent(), new ContextView(model, model.system), 'and now?', null, { history })
    return JSON.stringify(route.requests[0])
  }
  const claudeText = () => new Route([anthropicStream({ model: 'claude-x', stop: 'end_turn', blocks: [{ type: 'text', pieces: ['ok'] }] })])
  const claudeHistory = await historyAfter(new AnthropicModel('claude-x', { apiKey: 'a', baseUrl: 'http://anthropic.mock', fetchImpl: new Route(anthropicResponses()).fetch }))
  expect(claudeHistory.filter(isResponse).map((m) => responseRoute(m))).toEqual(['anthropic http://anthropic.mock/v1/messages claude-x', 'anthropic http://anthropic.mock/v1/messages claude-x'])
  // the same route continues with its own signed thinking
  let r = claudeText()
  expect(await onwards(claudeHistory, new AnthropicModel('claude-x', { apiKey: 'a', baseUrl: 'http://anthropic.mock', fetchImpl: r.fetch }), r)).toContain('sig-claude-1')
  // another Claude model, or the same model behind another endpoint, gets none of it
  r = claudeText()
  const toOtherModel = await onwards(claudeHistory, new AnthropicModel('claude-other', { apiKey: 'a', baseUrl: 'http://anthropic.mock', fetchImpl: r.fetch }), r)
  expect(toOtherModel).not.toContain('sig-claude-1')
  expect(toOtherModel).not.toContain('I should read the file first')
  expect(toOtherModel).toContain('toolu_01')
  r = claudeText()
  expect(await onwards(claudeHistory, new AnthropicModel('claude-x', { apiKey: 'a', baseUrl: 'http://gateway.mock', fetchImpl: r.fetch }), r)).not.toContain('sig-claude-1')

  const gptText = () => new Route([openaiStream({ model: 'gpt-y', items: [{ type: 'message', id: 'msg_9', pieces: ['ok'] }] })])
  const gptHistory = await historyAfter(new OpenAIResponsesModel('gpt-y', { apiKey: 'b', baseUrl: 'http://openai.mock/v1', fetchImpl: new Route(openaiResponses()).fetch }))
  let g = gptText()
  const toSame = await onwards(gptHistory, new OpenAIResponsesModel('gpt-y', { apiKey: 'b', baseUrl: 'http://openai.mock/v1', fetchImpl: g.fetch }), g)
  expect(toSame).toContain('ENCRYPTED-REASONING')
  expect(toSame).toContain('"rs_1"')
  g = gptText()
  const toOtherGpt = await onwards(gptHistory, new OpenAIResponsesModel('gpt-other', { apiKey: 'b', baseUrl: 'http://openai.mock/v1', fetchImpl: g.fetch }), g)
  for (const own of ['ENCRYPTED-REASONING', '"rs_1"', '"fc_1"', '"msg_1"']) expect(toOtherGpt, own).not.toContain(own)
  expect(toOtherGpt).toContain('call_01')
  g = gptText()
  expect(await onwards(gptHistory, new OpenAIResponsesModel('gpt-y', { apiKey: 'b', baseUrl: 'http://codex.mock/backend', fetchImpl: g.fetch }), g)).not.toContain('ENCRYPTED-REASONING')
  const chat = new Route([`data: ${JSON.stringify({ id: 'c', model: 'gpt-y', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`])
  expect(await onwards(gptHistory, new OpenAIChatModel('gpt-y', { apiKey: 'c', baseUrl: 'http://openai.mock/v1', fetchImpl: chat.fetch, reasoningReplay: 'reasoning_content' }), chat)).not.toContain('ENCRYPTED-REASONING')

  // the handoff counts another route's responses as foreign, so the note is written; a response stamped with no route
  // (a record from before routes were stamped) stays with its provider
  const otherRoute = 'openai http://openai.mock/v1/responses gpt-other'
  expect(portableHistory(gptHistory, 'openai', otherRoute)[1].foreign_responses).toBe(2)
  expect(portableHistory(gptHistory, 'openai', gptHistory.filter(isResponse).map((m) => responseRoute(m))[0]!)[1].foreign_responses).toBe(0)
  const unstamped = gptHistory.map((m) => (isResponse(m) ? { ...m, provider_details: null } : m))
  expect(portableHistory(unstamped, 'openai', otherRoute)[1].foreign_responses).toBe(0)
})

test('each Claude model gets thinking the way it takes it: an effort on the current ones, its own way to be off, a budget on the older ones', () => {
  const on = { type: 'adaptive', display: 'summarized' }
  // Sonnet 5.5: "off" is its own lowest setting (disabled is refused); omitted, it already thinks adaptively
  expect(thinkingFields('claude-sonnet-5-5', false, 16_000)).toEqual({ thinking: { type: 'between_tools' } })
  expect(thinkingFields('claude-sonnet-5-5', 'minimal', 16_000)).toEqual({ thinking: on, output_config: { effort: 'low' } })
  expect(thinkingFields('claude-sonnet-5-5', 'xhigh', 16_000)).toEqual({ thinking: on, output_config: { effort: 'xhigh' } })
  expect(thinkingFields('claude-sonnet-5-5', null, 16_000)).toEqual({ thinking: on })
  expect(thinkingFields('anthropic.claude-sonnet-5-5', false, 16_000)).toEqual({ thinking: { type: 'between_tools' } })
  // Opus 5.5 and the Fable models cannot turn thinking off: the lowest effort stands for it
  for (const model of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-mythos-5-1']) {
    expect(thinkingFields(model, false, 16_000)).toEqual({ thinking: on, output_config: { effort: 'low' } })
    expect(thinkingFields(model, 'medium', 16_000)).toEqual({ thinking: on, output_config: { effort: 'medium' } })
    expect(thinkingFields(model, null, 16_000)).toEqual({ thinking: on })
  }
  // Sonnet 5, Opus 5 and Opus 4.7/4.8 take the disabled type; 4.7/4.8 and 4.6 do not think unless asked
  expect(thinkingFields('claude-sonnet-5', false, 16_000)).toEqual({ thinking: { type: 'disabled' } })
  expect(thinkingFields('claude-opus-5', null, 16_000)).toEqual({ thinking: on })
  expect(thinkingFields('claude-opus-4-8', null, 16_000)).toEqual({})
  expect(thinkingFields('claude-opus-4-7-20260301', 'high', 16_000)).toEqual({ thinking: on, output_config: { effort: 'high' } })
  // 4.6 has no xhigh: the level below it
  expect(thinkingFields('claude-sonnet-4-6', 'xhigh', 16_000)).toEqual({ thinking: on, output_config: { effort: 'high' } })
  // the models before 4.6 keep a thinking budget, the output cap raised above it
  expect(thinkingFields('claude-haiku-4-5', 'high', 1000)).toEqual({ thinking: { type: 'enabled', budget_tokens: 16384 }, max_tokens: 16384 + 4096 })
  expect(thinkingFields('claude-3-7-sonnet-20250219', 'low', 64_000)).toEqual({ thinking: { type: 'enabled', budget_tokens: 2048 } })
  expect(thinkingFields('claude-haiku-4-5', false, 16_000)).toEqual({})
  expect(claudeThinking('claude-sonnet-5-5').mode).toBe('effort')
})

test('thinking levels reach each provider in its own vocabulary, and only when asked', async () => {
  const a = new Route([anthropicStream({ model: 'claude-x', stop: 'end_turn', blocks: [{ type: 'text', pieces: ['ok'] }] })])
  const claude = new AnthropicModel('claude-x', { apiKey: 'a', baseUrl: 'http://anthropic.mock', fetchImpl: a.fetch })
  // a Claude name not in the model table reads as a current model: adaptive thinking at an effort, never a budget
  await runAgent(agent(), claude, 'hi', null, { settings: { thinking: 'high', max_tokens: 1000 } })
  expect(a.requests[0]!.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
  expect(a.requests[0]!.output_config).toEqual({ effort: 'high' })
  expect(a.requests[0]!.max_tokens).toBe(1000)
  await runAgent(agent(), claude, 'hi', null, { settings: { thinking: 'off' as never } })
  expect(a.requests[1]!.thinking).toBeUndefined()
  await runAgent(agent(), claude, 'hi', null)
  expect(a.requests[2]!.thinking).toBeUndefined()
  const b = new Route([openaiStream({ model: 'gpt-y', items: [{ type: 'message', id: 'm', pieces: ['ok'] }] })])
  const gpt = new OpenAIResponsesModel('gpt-y', { apiKey: 'b', baseUrl: 'http://openai.mock/v1', fetchImpl: b.fetch })
  await runAgent(agent(), gpt, 'hi', null, { settings: { thinking: 'low', max_tokens: 500 } })
  expect(b.requests[0]!.reasoning).toEqual({ effort: 'low', summary: 'auto' })
  expect(b.requests[0]!.max_output_tokens).toBe(500)
  await runAgent(agent(), gpt, 'hi', null, { settings: { thinking: false } })
  expect(b.requests[1]!.reasoning).toEqual({ effort: 'none' })
  const g = new Route([geminiStream([geminiChunk([{ text: 'ok' }], { finish: 'STOP', usage: geminiUsage(1, 1) })])])
  const gemini = new GoogleModel('gemini-z', { apiKey: 'g', baseUrl: 'http://gemini.mock', fetchImpl: g.fetch })
  await runAgent(agent(), gemini, 'hi', null, { settings: { thinking: 'medium' } })
  expect((g.requests[0]!.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingBudget: 8192, includeThoughts: true })
  // a model that cannot think never sees the level
  const deaf = new AnthropicModel('claude-x', { apiKey: 'a', baseUrl: 'http://anthropic.mock', fetchImpl: a.fetch, profile: { supports_thinking: false } })
  await runAgent(agent(), deaf, 'hi', null, { settings: { thinking: 'high' } })
  expect(a.requests[3]!.thinking).toBeUndefined()
})

test('HTTP: a provider status is a ModelHTTPError, a retryable one is retried, a dropped connection is a TransportError', async () => {
  let calls = 0
  const flaky = async () => {
    calls += 1
    if (calls === 1) return new Response(JSON.stringify({ error: { type: 'overloaded_error' } }), { status: 529 })
    return new Response('{"ok":true}', { status: 200 })
  }
  const ok = await postJson('http://x.mock/v1', {}, {}, 'm', { fetchImpl: flaky as never, maxRetries: 2 })
  expect(await ok.json()).toEqual({ ok: true })
  expect(calls).toBe(2)
  const refused = async () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad thinking' } }), { status: 400 })
  const error = await postJson('http://x.mock/v1', {}, {}, 'm', { fetchImpl: refused as never }).catch((e) => e)
  expect(error).toBeInstanceOf(ModelHTTPError)
  expect(error.status_code).toBe(400)
  expect(error.body).toMatchObject({ error: { message: 'bad thinking' } })
  const dropped = async () => { throw new Error('ECONNRESET: socket hang up') }
  const transport = await postJson('http://x.mock/v1', {}, {}, 'm', { fetchImpl: dropped as never, maxRetries: 0 }).catch((e) => e)
  expect(transport).toBeInstanceOf(TransportError)
  expect(transport.kind).toBe('ReadError')
  // the SSE reader: CRLF lines, multi-line data, comments, a trailing message without its blank line
  const body = 'event: a\r\ndata: 1\r\ndata: 2\r\n\r\n: comment\ndata: {"x":1}\n\ndata: tail'
  const seen: unknown[] = []
  for await (const m of readSse(new Response(body), 'm')) seen.push(m)
  expect(seen).toEqual([{ event: 'a', data: '1\n2', id: null }, { event: null, data: '{"x":1}', id: null }, { event: null, data: 'tail', id: null }])
})

test('buildModel: the route decides the mapping, the key comes from the variable it names, never from the URL', () => {
  process.env.OASIS_TEST_KEY_A = 'test-key-a'
  try {
    const cfg = new ModelConfig({ id: 'claude', provider: 'anthropic', model: 'claude-x', api_key_env: 'OASIS_TEST_KEY_A', base_url: 'http://anthropic.mock' })
    const model = buildModel(cfg)
    expect(model).toBeInstanceOf(AnthropicModel)
    expect(model.model_name).toBe('claude-x')
    expect(providerSystem(cfg)).toBe('anthropic')
    const chat = buildModel(new ModelConfig({ id: 'c', provider: 'openai', model: 'x', api: 'chat', api_key_env: 'OASIS_TEST_KEY_A', base_url: 'http://o.mock/v1' }))
    expect(chat).toBeInstanceOf(OpenAIChatModel)
    expect(buildModel(new ModelConfig({ id: 'r', provider: 'openai', model: 'x', api_key_env: 'OASIS_TEST_KEY_A' }))).toBeInstanceOf(OpenAIResponsesModel)
    expect(buildModel(new ModelConfig({ id: 'g', provider: 'google', model: 'x', api_key_env: 'OASIS_TEST_KEY_A' }))).toBeInstanceOf(GoogleModel)
    delete process.env.OASIS_TEST_KEY_A
    expect(() => buildModel(cfg)).toThrow(CredentialUnavailable)
    expect(() => buildModel(cfg)).toThrow('no key for OASIS_TEST_KEY_A')
  } finally {
    delete process.env.OASIS_TEST_KEY_A
  }
})

test('the cache fields each route sends: the TTL and the key, the official endpoint only, and a redacted thinking block sent back whole', () => {
  const params = { function_tools: [], allow_text_output: true, thinking: null }
  const messages = [modelRequest([userPrompt('hi')], 'the instructions')]
  const claude = new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://anthropic.mock' })
  const hour = claude.body(messages, { cache_ttl: '1h' }, params, true)
  expect(hour.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  expect((hour.system as { cache_control?: unknown }[]).at(-1)!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  expect(claude.body(messages, { cache_ttl: '5m' }, params, true).cache_control).toEqual({ type: 'ephemeral' })
  expect(claude.body([modelRequest([userPrompt('hi')])], {}, params, true).system).toBeUndefined()
  // a redacted thinking block travels back as it came, only to its provider
  const redacted = [
    ...messages,
    modelResponse([{ part_kind: 'thinking', content: '', id: null, signature: null, provider_name: 'anthropic', provider_details: { redacted_data: 'REDACTED-BLOB' } }, textPart('ok')], { provider_name: 'anthropic' }),
    modelRequest([userPrompt('more')], 'the instructions'),
  ]
  const assistant = (claude.body(redacted, {}, params, true).messages as { role: string; content: Record<string, unknown>[] }[]).find((m) => m.role === 'assistant')!
  expect(assistant.content[0]).toEqual({ type: 'redacted_thinking', data: 'REDACTED-BLOB' })
  const gpt = new OpenAIResponsesModel('gpt-y', { apiKey: 'k', baseUrl: 'http://openai.mock/v1' })
  expect(gpt.body(messages, { cache_key: 'oasis:session:s_1' }, params).prompt_cache_key).toBe('oasis:session:s_1')
  const codex = new OpenAIResponsesModel('gpt-6-astra', { codex: true, baseUrl: 'https://chatgpt.com/backend-api/codex' })
  expect(codex.body(messages, { cache_key: 'oasis:session:s_1' }, params).prompt_cache_key).toBe('oasis:session:s_1')
  // the Codex backend routes by the headers that name the thread; the API route is sent none of them
  const thread = { 'session-id': 'oasis:session:s_1', 'thread-id': 'oasis:session:s_1', 'x-client-request-id': 'oasis:session:s_1' }
  expect(codex.headers({ cache_key: 'oasis:session:s_1' })).toEqual(thread)
  expect(codex.headers({})).toEqual({})
  expect(gpt.headers({ cache_key: 'oasis:session:s_1' })).toEqual({ authorization: 'Bearer k' })
  const official = new OpenAIChatModel('gpt-y', { apiKey: 'k' })
  expect(official.body(messages, { cache_key: 'oasis:session:s_1' }, params).prompt_cache_key).toBe('oasis:session:s_1')
  const compatible = new OpenAIChatModel('local-y', { apiKey: 'k', baseUrl: 'http://llm.local/v1' })
  expect('prompt_cache_key' in compatible.body(messages, { cache_key: 'oasis:session:s_1' }, params)).toBe(false)
  const gemini = new GoogleModel('gemini-z', { apiKey: 'k', baseUrl: 'http://gemini.mock' })
  expect(JSON.stringify(gemini.body(messages, { cache_key: 'oasis:session:s_1', cache_ttl: '1h' }, params))).not.toContain('cache')   // implicit caching: nothing to send
})
