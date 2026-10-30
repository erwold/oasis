/** A Chat Completions route that names its reasoning field gets back, on every assistant turn of the history, what
 *  arrived under that field — whole, from the same endpoint and model only: DeepSeek-style `reasoning_content`
 *  through a tool turn, the next person's turn and a record saved and loaded again; MiniMax-style
 *  `reasoning_details` merged as it streamed. A route that names none (the official API's default) sends no such
 *  field; another model's, another endpoint's or the Responses API's reasoning never rides along; the reasoning is
 *  never folded into the visible content. Mock fetch speaking the chunk protocol; proves the wire only, not any
 *  provider's model. */

import { expect, test } from 'bun:test'
import { z } from '@oasis-code/contract'
import { Agent } from '../src/agent/loop.ts'
import { ModelConfig } from '../src/config.ts'
import { dumpJson, loadJson, modelResponse, textPart, thinkingPart, type ModelMessage } from '../src/llm/messages.ts'
import { buildModel, OpenAIChatModel } from '../src/llm/providers.ts'
import { Route, runAgent, zodTool } from './helpers.ts'

const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'c', model: 'deep-x', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

const toolTurn = (field: 'reasoning_content' | 'reasoning_details') => [
  field === 'reasoning_content' ? chunk({ reasoning_content: 'Let me ' }) : chunk({ reasoning_details: [{ type: 'reasoning.text', id: 'rd1', index: 0, format: 'MiniMax-response-v1', text: 'Let me ' }] }),
  field === 'reasoning_content' ? chunk({ reasoning_content: 'read it.' }) : chunk({ reasoning_details: [{ index: 0, text: 'read it.' }] }),
  chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"calc.py"}' } }] }),
  chunk({}, 'tool_calls'), 'data: [DONE]\n\n',
].join('')

const answerTurn = (field: 'reasoning_content' | 'reasoning_details', words: string) => [
  field === 'reasoning_content' ? chunk({ reasoning_content: 'Now answer.' }) : chunk({ reasoning_details: [{ type: 'reasoning.text', id: 'rd2', index: 0, text: 'Now answer.' }] }),
  chunk({ content: words }), chunk({}, 'stop'), 'data: [DONE]\n\n',
].join('')

const agent = () => new Agent<null>({
  instructions: 'x', retries: 3,
  tools: [zodTool<null, z.ZodType>('read_file', 'Read a file', z.object({ path: z.string() }), () => ({ status: 'ok', text: 'def add(a, b): return a - b' }))],
})

type Wire = { role: string; content?: unknown; tool_calls?: unknown; reasoning_content?: unknown; reasoning_details?: unknown }
const assistants = (body: Record<string, unknown>) => (body.messages as Wire[]).filter((m) => m.role === 'assistant')

test('reasoning_content: kept whole and sent back on the tool turn, on the next person\'s turn, and after the record is saved and loaded', async () => {
  const route = new Route([toolTurn('reasoning_content'), answerTurn('reasoning_content', 'It subtracts.'), answerTurn('reasoning_content', 'Yes.')])
  const model = new OpenAIChatModel('deep-x', { apiKey: 'k', baseUrl: 'http://deep.mock/v1', fetchImpl: route.fetch, reasoningReplay: 'reasoning_content' })
  const first = await runAgent(agent(), model, 'read calc.py', null)
  expect(first.result.output).toBe('It subtracts.')
  // the tool turn's request carries the reasoning back beside the call, never inside the content
  const [toolAssistant] = assistants(route.requests[1]!)
  expect(toolAssistant!.reasoning_content).toBe('Let me read it.')
  expect(toolAssistant!.content).toBeNull()
  expect((toolAssistant!.tool_calls as unknown[]).length).toBe(1)
  // saved and loaded again, then the next turn: both assistant turns carry theirs
  const reloaded = loadJson(dumpJson(first.result.allMessages()))
  await runAgent(agent(), model, 'are you sure?', null, { history: reloaded })
  const both = assistants(route.requests[2]!)
  expect(both.map((m) => m.reasoning_content)).toEqual(['Let me read it.', 'Now answer.'])
  expect(both[1]!.content).toBe('It subtracts.')
  expect(JSON.stringify(route.requests[2]!.messages)).not.toContain('Now answer.It subtracts')
})

test('reasoning_details: merged by index as it streamed, sent back whole with the route\'s own switch in the body', async () => {
  const route = new Route([toolTurn('reasoning_details'), answerTurn('reasoning_details', 'Done.')])
  const model = new OpenAIChatModel('mini-x', { apiKey: 'k', baseUrl: 'http://mini.mock/v1', fetchImpl: route.fetch, reasoningReplay: 'reasoning_details', extraBody: { reasoning_split: true } })
  const run = await runAgent(agent(), model, 'read calc.py', null)
  expect(run.result.output).toBe('Done.')
  expect(route.requests[0]!.reasoning_split).toBe(true)
  const [toolAssistant] = assistants(route.requests[1]!)
  expect(toolAssistant!.reasoning_details).toEqual([{ type: 'reasoning.text', id: 'rd1', index: 0, format: 'MiniMax-response-v1', text: 'Let me read it.' }])
  expect(toolAssistant!.reasoning_content).toBeUndefined()
  // the shown thinking is the details' text
  const thinking = run.events.filter((e) => e.type === 'part_end' && e.part.part_kind === 'thinking').map((e) => (e as { part: { content: string } }).part.content)
  expect(thinking[0]).toBe('Let me read it.')
})

test('a route that names no reasoning field sends none back (the official API\'s default); the reasoning is still shown', async () => {
  const route = new Route([toolTurn('reasoning_content'), answerTurn('reasoning_content', 'ok')])
  const model = new OpenAIChatModel('gpt-x', { apiKey: 'k', fetchImpl: route.fetch })
  const run = await runAgent(agent(), model, 'read calc.py', null)
  const [toolAssistant] = assistants(route.requests[1]!)
  expect(toolAssistant!.reasoning_content).toBeUndefined()
  expect(toolAssistant!.reasoning_details).toBeUndefined()
  expect(run.events.some((e) => e.type === 'part_end' && e.part.part_kind === 'thinking')).toBe(true)
})

test('another model, another endpoint or the Responses API: their reasoning never rides along', async () => {
  const route = new Route([toolTurn('reasoning_content'), answerTurn('reasoning_content', 'ok')])
  const deep = new OpenAIChatModel('deep-x', { apiKey: 'k', baseUrl: 'http://deep.mock/v1', fetchImpl: route.fetch, reasoningReplay: 'reasoning_content' })
  const record = (await runAgent(agent(), deep, 'read calc.py', null)).result.allMessages()
  // a Responses-API reasoning part (same provider name, no Chat reasoning of its own) on another turn
  const responses: ModelMessage = modelResponse([thinkingPart('summary', { provider_name: 'openai', provider_details: { encrypted_content: 'enc' } }), textPart('earlier')], { provider_name: 'openai' })
  const history = [...record.slice(0, 1), responses, ...record.slice(1)]
  for (const [name, base] of [['deep-y', 'http://deep.mock/v1'], ['deep-x', 'http://other.mock/v1']] as const) {
    const next = new Route([answerTurn('reasoning_content', 'fine')])
    const other = new OpenAIChatModel(name, { apiKey: 'k', baseUrl: base, fetchImpl: next.fetch, reasoningReplay: 'reasoning_content' })
    await runAgent(agent(), other, 'go on', null, { history })
    expect(assistants(next.requests[0]!).map((m) => m.reasoning_content)).toEqual([undefined, undefined, undefined])
  }
  // the same route again: its own turns carry theirs, the Responses part does not
  const same = new Route([answerTurn('reasoning_content', 'fine')])
  const again = new OpenAIChatModel('deep-x', { apiKey: 'k', baseUrl: 'http://deep.mock/v1', fetchImpl: same.fetch, reasoningReplay: 'reasoning_content' })
  await runAgent(agent(), again, 'go on', null, { history })
  expect(assistants(same.requests[0]!).map((m) => m.reasoning_content)).toEqual([undefined, 'Let me read it.', 'Now answer.'])
})

test('the route config: reasoning_replay and extra_body belong to Chat routes, and extra_body cannot set what the harness sets', () => {
  const base = { id: 'r', provider: 'openai', model: 'deep-x', api: 'chat', base_url: 'http://deep.mock/v1', api_key_env: 'DEEP_KEY' } as const
  const ok = new ModelConfig({ ...base, reasoning_replay: 'reasoning_content', extra_body: { thinking: { type: 'enabled' } } })
  expect(ok.dump()).toMatchObject({ reasoning_replay: 'reasoning_content', extra_body: { thinking: { type: 'enabled' } } })
  expect(() => new ModelConfig({ ...base, provider: 'anthropic', api: 'responses', reasoning_replay: 'reasoning_content' })).toThrow('for OpenAI Chat Completions routes')
  expect(() => new ModelConfig({ ...base, api: 'responses', reasoning_replay: 'reasoning_details' })).toThrow('for OpenAI Chat Completions routes')
  expect(() => new ModelConfig({ ...base, extra_body: { model: 'other', messages: [] } })).toThrow('extra_body may not set model, messages')
  // built from the config, the route carries its field and its switches
  process.env.DEEP_KEY = 'k'
  try {
    const built = buildModel(new ModelConfig({ ...base, reasoning_replay: 'reasoning_details', extra_body: { reasoning_split: true } })) as OpenAIChatModel
    expect(built.opts.reasoningReplay).toBe('reasoning_details')
    expect(built.body([], {}, { function_tools: [], allow_text_output: true, thinking: null }).reasoning_split).toBe(true)
  } finally {
    delete process.env.DEEP_KEY
  }
})
