/** The provider's own web search (Anthropic's `web_search` and OpenAI's, each run on its side). Pinned here, over recorded-shape
 *  streams: the request declares it in place of the harness's `web_search` tool; its call, its results and the
 *  citations on the words come back as parts of their own, and go back to Anthropic exactly as they came; the
 *  answer reads as one text with the cited pages as links, however many text blocks the citations split it into; a
 *  turn the provider paused is resumed with nothing added; another provider reads the words with their links and a
 *  marker for the search; the runner declares it only while the network is granted outright (a network that asks
 *  keeps the harness's tool, whose calls ask), and the thread and the transcript read it as a tool row and one
 *  answer. */

import { afterEach, expect, test } from 'bun:test'
import { z } from 'zod'
import { GrantsSchema } from '@oasis-code/contract'
import { RunEventMapper } from '../src/agent/events.ts'
import { Agent, type AgentEvent } from '../src/agent/loop.ts'
import { rebuildTranscript } from '../src/agent/transcript.ts'
import * as repo from '../src/db/repo.ts'
import { portableHistory } from '../src/llm/handoff.ts'
import { answerText, isBuiltinCall, isBuiltinReturn, isText, modelResponse, textPart, type ModelMessage } from '../src/llm/messages.ts'
import { AnthropicModel, WEB_SEARCH_TOOL } from '../src/llm/providers/anthropic.ts'
import { OpenAIResponsesModel } from '../src/llm/providers/openai_responses.ts'
import { CODEX_CLIENT_VERSION, codexModel } from '../src/auth/models.ts'
import { appState, buggyRepo, closeState, openSession, setModel, waitDone, type AppState } from './harness.ts'
import { Route, zodTool } from './helpers.ts'
import { anthropicStream } from './providers_fixtures.ts'

let state: AppState | null = null
afterEach(async () => {
  if (state) await closeState(state)
  state = null
})

type Rec = Record<string, unknown>

const RESULT_BLOCK = {
  type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1',
  content: [
    { type: 'web_search_result', title: '[2505.05470] Flow-GRPO', url: 'https://arxiv.org/abs/2505.05470', encrypted_content: 'ENC_ONE', page_age: 'October 27, 2025' },
    { type: 'web_search_result', title: 'Paper page - Flow-GRPO', url: 'https://huggingface.co/papers/2505.05470', encrypted_content: 'ENC_TWO' },
  ],
}
const CITATION = { type: 'web_search_result_location', cited_text: 'We propose Flow-GRPO, the first method…', url: 'https://arxiv.org/abs/2505.05470', title: '[2505.05470] Flow-GRPO', encrypted_index: 'IDX_ONE' }

/** A searched answer as Anthropic streamed it (2026-09-29): the search, its results, then the words split at the citation. */
function searchedAnswer(stop = 'end_turn'): string {
  return anthropicStream({ model: 'claude-x', stop, blocks: [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'arXiv 2505.05470' } },
    RESULT_BLOCK,
    { type: 'text', pieces: ['arXiv 2505.05470 is ', '"Flow-GRPO," which '] },
    { type: 'text', citations: [CITATION], pieces: ['is the first method to ', 'integrate online RL into flow matching'] },
    { type: 'text', pieces: ['.'] },
  ] })
}

function localSearch() {
  return zodTool<null, z.ZodType>('web_search', 'Search the web', z.object({ query: z.string() }), () => ({ status: 'ok', results: [] }))
}

function searchingAgent(declare = true): Agent<null> {
  return new Agent<null>({
    instructions: 'Answer with sources.',
    tools: [localSearch(), zodTool<null, z.ZodType>('read_file', 'Read a file', z.object({ path: z.string() }), () => ({ status: 'ok' }))],
    builtinTools: () => (declare ? [{ kind: 'web_search', max_uses: 5 }] : []),
  })
}

async function run(agent: Agent<null>, model: AnthropicModel | OpenAIResponsesModel, prompt: string, history: ModelMessage[] | null = null): Promise<{ events: AgentEvent[]; output: string; messages: ModelMessage[] }> {
  const events: AgentEvent[] = []
  let output = ''
  let messages: ModelMessage[] = []
  for await (const event of agent.runStreamEvents({ prompt, deps: null, model, messageHistory: history })) {
    events.push(event)
    if (event.type === 'result') { output = event.result.output; messages = event.result.allMessages() }
  }
  return { events, output, messages }
}

test("Anthropic's own search: declared in place of the harness's tool, read back as parts, sent back exactly as it came", async () => {
  const route = new Route([searchedAnswer(), anthropicStream({ model: 'claude-x', stop: 'end_turn', blocks: [{ type: 'text', pieces: ['Yes.'] }] })])
  const model = new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://anthropic.mock', fetchImpl: route.fetch })
  const first = await run(searchingAgent(), model, 'What is arXiv 2505.05470?')
  // the request: the provider's search where the harness's would be (a request cannot name both), the rest as they were
  const tools = route.requests[0]!.tools as Rec[]
  expect(tools.map((t) => t.name)).toEqual(['read_file', 'web_search'])
  expect(tools[1]).toEqual({ type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: 5 })
  expect(WEB_SEARCH_TOOL).toBe('web_search_20250305')
  // the response: the call with its query, the results as titles and addresses (the provider's block kept whole), the words
  const response = first.messages.at(-1)!
  expect(response.kind).toBe('response')
  const parts = (response as { parts: Rec[] }).parts
  expect(parts.map((p) => p.part_kind)).toEqual(['builtin-tool-call', 'builtin-tool-return', 'text', 'text', 'text'])
  const call = parts.find((p) => isBuiltinCall(p as never))!
  expect(call).toMatchObject({ tool_name: 'web_search', tool_call_id: 'srvtoolu_1', args: { query: 'arXiv 2505.05470' }, provider_name: 'anthropic' })
  const results = parts.find((p) => isBuiltinReturn(p as never))!
  expect(results.content).toEqual({ status: 'ok', results: [
    { title: '[2505.05470] Flow-GRPO', url: 'https://arxiv.org/abs/2505.05470', page_age: 'October 27, 2025' },
    { title: 'Paper page - Flow-GRPO', url: 'https://huggingface.co/papers/2505.05470' },
  ] })
  expect((results.provider_details as Rec).block).toEqual(RESULT_BLOCK)
  expect((parts[3]!.provider_details as Rec).citations).toEqual([CITATION])
  // the words: one answer, the cited page as a link right after the words it stands on
  expect(first.output).toBe('arXiv 2505.05470 is "Flow-GRPO," which is the first method to integrate online RL into flow matching ([\\[2505.05470\\] Flow-GRPO](https://arxiv.org/abs/2505.05470)).')
  // the next request carries the search as Anthropic sent it: the call, the result block with what only it reads, the citations
  await run(searchingAgent(), model, 'Is it about RL?', first.messages)
  const assistant = (route.requests[1]!.messages as Rec[]).find((m) => m.role === 'assistant')!.content as Rec[]
  expect(assistant.map((b) => b.type)).toEqual(['server_tool_use', 'web_search_tool_result', 'text', 'text', 'text'])
  expect(assistant[0]).toEqual({ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'arXiv 2505.05470' } })
  expect(assistant[1]).toEqual(RESULT_BLOCK)
  expect(assistant[2]).toEqual({ type: 'text', text: 'arXiv 2505.05470 is "Flow-GRPO," which ' })
  expect(assistant[3]).toEqual({ type: 'text', text: 'is the first method to integrate online RL into flow matching', citations: [CITATION] })
  // a model or a run that does not declare it: the harness's tool, as before
  const plain = new Route([anthropicStream({ model: 'claude-x', stop: 'end_turn', blocks: [{ type: 'text', pieces: ['ok'] }] })])
  await run(searchingAgent(false), new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://anthropic.mock', fetchImpl: plain.fetch }), 'hi')
  expect((plain.requests[0]!.tools as Rec[]).map((t) => [t.name, t.type ?? null])).toEqual([['web_search', null], ['read_file', null]])
})

test('a turn the provider paused in its own search is resumed with nothing added, and its words join the rest', async () => {
  const route = new Route([
    anthropicStream({ model: 'claude-x', stop: 'pause_turn', blocks: [{ type: 'text', pieces: ['Searching. '] }, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'q' } }, RESULT_BLOCK] }),
    anthropicStream({ model: 'claude-x', stop: 'end_turn', blocks: [{ type: 'text', pieces: ['Found it.'] }] }),
  ])
  const model = new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://anthropic.mock', fetchImpl: route.fetch })
  const done = await run(searchingAgent(), model, 'find it')
  expect(route.requests).toHaveLength(2)
  const second = route.requests[1]!.messages as Rec[]
  expect(second.map((m) => m.role)).toEqual(['user', 'assistant'])                 // the paused turn last, no word of the harness's after it
  expect(((second[1]!.content as Rec[]).map((b) => b.type))).toEqual(['text', 'server_tool_use', 'web_search_tool_result'])
  expect(done.output).toBe('Searching. Found it.')
  expect(done.events.filter((e) => e.type === 'continued').map((e) => (e as { reason: string }).reason)).toEqual(['paused'])
})

test('another provider reads the words with their links and a marker for the search', () => {
  const searched = modelResponse([
    { part_kind: 'builtin-tool-call', tool_name: 'web_search', args: { query: 'q' }, tool_call_id: 'srvtoolu_1', provider_name: 'anthropic', provider_details: null },
    { part_kind: 'builtin-tool-return', tool_name: 'web_search', tool_call_id: 'srvtoolu_1', content: { status: 'ok', results: [] }, provider_name: 'anthropic', provider_details: { block: RESULT_BLOCK } },
    textPart('It is Flow-GRPO', { provider_name: 'anthropic', provider_details: { citations: [CITATION] } }),
  ], { provider_name: 'anthropic', model_name: 'claude-x' })
  const [portable] = portableHistory([searched], 'openai')
  const parts = (portable[0] as { parts: Rec[] }).parts
  expect(parts.every((p) => p.part_kind === 'text')).toBe(true)
  expect(parts.map((p) => p.content).join('\n')).toContain('It is Flow-GRPO ([\\[2505.05470\\] Flow-GRPO](https://arxiv.org/abs/2505.05470))')
  expect(JSON.stringify(portable)).not.toContain('ENC_ONE')                          // what only Anthropic reads stays with Anthropic
  expect(answerText(searched.parts)).toBe('It is Flow-GRPO ([\\[2505.05470\\] Flow-GRPO](https://arxiv.org/abs/2505.05470))')
  expect(searched.parts.filter(isText)).toHaveLength(1)
})

test('the thread reads one answer and a search row; the transcript of a saved run reads the same', async () => {
  const route = new Route([searchedAnswer()])
  const model = new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://anthropic.mock', fetchImpl: route.fetch })
  const done = await run(searchingAgent(), model, 'What is arXiv 2505.05470?')
  const mapper = new RunEventMapper()
  const wire = done.events.flatMap((e) => mapper.map(e))
  const names = wire.map(([name]) => name)
  expect(names.filter((n) => n === 'text_block')).toHaveLength(1)                  // three text parts, one answer
  expect(names.filter((n) => n === 'text_delta')).toHaveLength(8)                  // each part's start (empty) and its five pieces
  expect(wire.filter(([n, d]) => n === 'text_delta' && d.start === true)).toHaveLength(1)
  expect(wire.find(([n]) => n === 'text_block')![1].text).toBe(done.output)
  expect(wire.find(([n]) => n === 'tool_call')![1]).toMatchObject({ tool: 'web_search', tool_call_id: 'srvtoolu_1', query: 'arXiv 2505.05470', provider: 'anthropic' })
  expect(wire.find(([n]) => n === 'tool_result')![1]).toMatchObject({ tool: 'web_search', status: 'ok', results: 2, engine: 'anthropic', urls: ['https://arxiv.org/abs/2505.05470', 'https://huggingface.co/papers/2505.05470'] })
  const entries = rebuildTranscript(JSON.stringify(done.messages))
  expect(entries.map((e) => e.kind)).toEqual(['user', 'activity', 'agent'])
  expect(entries[1]).toMatchObject({ tool: 'web_search', running: false, result: { status: 'ok', results: 2, engine: 'anthropic' } })
  expect(entries[2]!.text).toBe(done.output)
})

test("a run declares the provider's search while the network is granted outright; a network that asks keeps the harness's tool", async () => {
  state = await appState()
  const route = new Route([searchedAnswer()])
  setModel(state, 'scripted:a', new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://anthropic.mock', fetchImpl: route.fetch }))
  let { session } = await openSession(state, buggyRepo())
  repo.setSessionGrants(state.conn, session.id, { ...GrantsSchema.parse({}), network: true })
  session = repo.getSession(state.conn, session.id)!
  const run1 = await waitDone(state, (await state.runs.start(session, 'What is arXiv 2505.05470?')).id)
  expect(run1.status).toBe('done')
  const declared = (route.requests[0]!.tools as Rec[]).filter((t) => t.name === 'web_search')
  expect(declared).toEqual([{ type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: 5 }])
  // the run's answer and its events: one text with the link, the search as a tool row counted as a call
  expect(run1.receipt.final_text).toBe('arXiv 2505.05470 is "Flow-GRPO," which is the first method to integrate online RL into flow matching ([\\[2505.05470\\] Flow-GRPO](https://arxiv.org/abs/2505.05470)).')
  const events = repo.listEvents(state.conn, run1.id, -1)
  expect(events.filter((e) => e.event === 'text_block').map((e) => e.data.text)).toEqual([run1.receipt.final_text])
  expect(events.filter((e) => e.event === 'tool_result').map((e) => [e.data.tool, e.data.engine])).toEqual([['web_search', 'anthropic']])
  expect((run1.receipt.mechanical as Rec).tool_calls).toBe(1)
  // the network asks the person first: the harness's own tool, whose call asks
  repo.setSessionGrants(state.conn, session.id, { ...GrantsSchema.parse({}), network: false })
  route.responses = [anthropicStream({ model: 'claude-x', stop: 'end_turn', blocks: [{ type: 'text', pieces: ['ok'] }] })]
  await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'and again', { fresh: true })).id)
  const second = route.requests.at(-1)!.tools as Rec[]
  expect(second.filter((t) => t.name === 'web_search').map((t) => t.type ?? 'function')).toEqual(['function'])
})

// -- OpenAI's own search (the Codex route, recorded 2026-09-30 on gpt-6.1-sol) ------------------------------------

const WS_ITEM = {
  id: 'ws_1', type: 'web_search_call', status: 'completed',
  action: { type: 'search', queries: ['bun latest release', 'site:github.com/oven-sh/bun releases'], query: 'bun latest release',
    sources: [{ type: 'url', url: 'https://github.com/oven-sh/bun/releases' }, { type: 'url', url: 'https://bun.sh/blog' }] },
}
const ANNOTATION = { type: 'url_citation', start_index: 36, end_index: 64, title: 'Blog | Bun', url: 'https://bun.sh/blog?utm_source=openai' }
const OPENAI_WORDS = 'The latest stable Bun is **v1.4.2**. ([bun.sh](https://bun.sh/blog?utm_source=openai))'

function sseOf(events: Rec[]): string {
  return events.map((e, i) => `event: ${String(e.type)}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`).join('')
}

/** A searched answer as the Codex route streamed it: the search item (no action until it is done), then the words
 *  with their links inline and the annotations beside them. */
function openaiSearchedAnswer(item: Rec = WS_ITEM): string {
  const message = { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', phase: 'final_answer',
    content: [{ type: 'output_text', annotations: [ANNOTATION], logprobs: [], text: OPENAI_WORDS }] }
  const response = { id: 'resp_1', model: 'gpt-6.1-sol' }
  return sseOf([
    { type: 'response.created', response },
    { type: 'response.output_item.added', output_index: 0, item: { id: item.id, type: 'web_search_call', status: 'searching' } },
    { type: 'response.web_search_call.in_progress', output_index: 0, item_id: item.id },
    { type: 'response.web_search_call.completed', output_index: 0, item_id: item.id },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.output_item.added', output_index: 1, item: { ...message, content: [] } },
    { type: 'response.output_text.delta', output_index: 1, item_id: 'msg_1', content_index: 0, delta: OPENAI_WORDS },
    { type: 'response.output_text.annotation.added', output_index: 1, item_id: 'msg_1', content_index: 0, annotation_index: 0, annotation: ANNOTATION },
    { type: 'response.output_item.done', output_index: 1, item: message },
    { type: 'response.completed', response: { ...response, status: 'completed', usage: { input_tokens: 12, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } } },
  ])
}

function openaiAnswer(text: string): string {
  const message = { id: 'msg_2', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', annotations: [], text }] }
  return sseOf([
    { type: 'response.created', response: { id: 'resp_2', model: 'gpt-6.1-sol' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_2', content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: { id: 'resp_2', model: 'gpt-6.1-sol', status: 'completed', usage: { input_tokens: 3, output_tokens: 1 } } },
  ])
}

function searchingOpenAI(route: Route): OpenAIResponsesModel {
  return new OpenAIResponsesModel('gpt-6.1-sol', { apiKey: 'k', baseUrl: 'http://openai.mock', fetchImpl: route.fetch, profile: { builtin_tools: ['web_search'] } })
}

test("OpenAI's own search: declared in place of the harness's tool, read back as a call and its sources, sent back as the item it came as", async () => {
  const route = new Route([openaiSearchedAnswer(), openaiAnswer('It was the Bun blog.')])
  const model = searchingOpenAI(route)
  const first = await run(searchingAgent(), model, 'What is the latest Bun?')
  // the request: the provider's search where the harness's would be, and its sources asked for
  const body = route.requests[0]!
  expect((body.tools as Rec[]).map((t) => t.name ?? t.type)).toEqual(['read_file', 'web_search'])
  expect((body.tools as Rec[])[1]).toEqual({ type: 'web_search' })
  expect(body.include).toEqual(['reasoning.encrypted_content', 'web_search_call.action.sources'])
  // the response: the call with its queries, the pages it found, the words as they came (their links already inline)
  const parts = (first.messages.at(-1) as { parts: Rec[] }).parts
  expect(parts.map((p) => p.part_kind)).toEqual(['builtin-tool-call', 'builtin-tool-return', 'text'])
  expect(parts[0]).toMatchObject({ tool_name: 'web_search', tool_call_id: 'ws_1', provider_name: 'openai',
    args: { query: 'bun latest release', queries: ['bun latest release', 'site:github.com/oven-sh/bun releases'] }, provider_details: { item: WS_ITEM } })
  expect(parts[1]).toMatchObject({ tool_name: 'web_search', tool_call_id: 'ws_1', provider_name: 'openai',
    content: { status: 'ok', results: [{ title: '', url: 'https://github.com/oven-sh/bun/releases' }, { title: '', url: 'https://bun.sh/blog' }] } })
  expect(parts[2]!.provider_details).toEqual({ annotations: [ANNOTATION] })
  expect(first.output).toBe(OPENAI_WORDS)                                            // the link once, where the model put it
  // the next request carries the search item as it came, then the words with their annotations
  await run(searchingAgent(), model, 'Which page was it?', first.messages)
  const input = route.requests[1]!.input as Rec[]
  expect(input.map((i) => i.type ?? i.role)).toEqual(['user', 'web_search_call', 'message', 'user'])
  expect(input[1]).toEqual(WS_ITEM)
  expect(input[2]).toMatchObject({ id: 'msg_1', content: [{ type: 'output_text', text: OPENAI_WORDS, annotations: [ANNOTATION] }] })
  // a request that does not declare it: the harness's tool alone, no sources asked for
  const plain = new Route([openaiAnswer('ok')])
  await run(searchingAgent(false), searchingOpenAI(plain), 'hi')
  expect((plain.requests[0]!.tools as Rec[]).map((t) => [t.name, t.type])).toEqual([['web_search', 'function'], ['read_file', 'function']])
  expect(plain.requests[0]!.include).toEqual(['reasoning.encrypted_content'])
})

test("OpenAI's search reads as a search row and one answer; another provider gets the words and a marker, never the item", async () => {
  const route = new Route([openaiSearchedAnswer()])
  const done = await run(searchingAgent(), searchingOpenAI(route), 'What is the latest Bun?')
  const mapper = new RunEventMapper()
  const wire = done.events.flatMap((e) => mapper.map(e))
  expect(wire.find(([n]) => n === 'tool_call')![1]).toMatchObject({ tool: 'web_search', tool_call_id: 'ws_1', query: 'bun latest release', provider: 'openai' })
  expect(wire.find(([n]) => n === 'tool_result')![1]).toMatchObject({ tool: 'web_search', status: 'ok', results: 2, engine: 'openai',
    urls: ['https://github.com/oven-sh/bun/releases', 'https://bun.sh/blog'] })
  expect(wire.filter(([n]) => n === 'text_block').map(([, d]) => d.text)).toEqual([OPENAI_WORDS])
  const entries = rebuildTranscript(JSON.stringify(done.messages))
  expect(entries.map((e) => e.kind)).toEqual(['user', 'activity', 'agent'])
  expect(entries[1]).toMatchObject({ tool: 'web_search', running: false, result: { status: 'ok', results: 2, engine: 'openai' } })
  // Anthropic reads the words with their links and a marker in place of the search; the item stays with OpenAI
  const [portable] = portableHistory(done.messages, 'anthropic')
  const response = portable.find((m) => m.kind === 'response') as { parts: Rec[] }
  expect(response.parts.every((p) => p.part_kind === 'text')).toBe(true)
  expect(response.parts.at(-1)!.content).toBe(OPENAI_WORDS)
  expect(JSON.stringify(portable)).not.toContain('ws_1')
  const anthropic = new Route([anthropicStream({ model: 'claude-x', stop: 'end_turn', blocks: [{ type: 'text', pieces: ['ok'] }] })])
  await run(searchingAgent(), new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://anthropic.mock', fetchImpl: anthropic.fetch }), 'and?', done.messages)
  const assistant = (anthropic.requests[0]!.messages as Rec[]).find((m) => m.role === 'assistant')!.content as Rec[]
  expect(assistant).toEqual([{ type: 'text', text: OPENAI_WORDS }])
})

test("OpenAI's search opening a page or finding in one reads as that action, never as a search that found nothing", async () => {
  const opened = { id: 'ws_2', type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://arxiv.org/abs/2505.05470' } }
  const found = { id: 'ws_3', type: 'web_search_call', status: 'completed', action: { type: 'find', url: 'https://arxiv.org/abs/2505.05470', pattern: 'GRPO' } }
  for (const [item, args] of [[opened, { action: 'open_page', url: 'https://arxiv.org/abs/2505.05470' }],
    [found, { action: 'find', url: 'https://arxiv.org/abs/2505.05470', pattern: 'GRPO' }]] as const) {
    const route = new Route([openaiSearchedAnswer(item)])
    const done = await run(searchingAgent(), searchingOpenAI(route), 'Read the paper.')
    const parts = (done.messages.at(-1) as { parts: Rec[] }).parts
    expect(parts[0]).toMatchObject({ tool_name: 'web_search', args })
    expect(parts[1]!.content).toEqual({ status: 'ok', action: args.action })
    const mapper = new RunEventMapper()
    const wire = done.events.flatMap((e) => mapper.map(e))
    expect(wire.find(([n]) => n === 'tool_call')![1]).toMatchObject({ tool: 'web_search', provider: 'openai', ...args })
    const result = wire.find(([n]) => n === 'tool_result')![1]
    expect(result).toMatchObject({ tool: 'web_search', status: 'ok', engine: 'openai', action: args.action, summary: args.action })
    expect(result).not.toHaveProperty('results')
    const entries = rebuildTranscript(JSON.stringify(done.messages))
    expect(entries[1]).toMatchObject({ tool: 'web_search', running: false, args, result: { status: 'ok', engine: 'openai', action: args.action } })
    expect(entries[1]!.result).not.toHaveProperty('results')
  }
})

test('the Codex route offers the search and names the client version its models are served to', async () => {
  const seen: Headers[] = []
  const grants = { access: async () => ({ access: 'fake-access', account_id: 'acct_1' }) } as unknown as Parameters<typeof codexModel>[1]
  const model = codexModel('gpt-6.1-sol', grants, { fetchImpl: async (_url, init) => {
    seen.push(new Headers(init?.headers as Headers))
    return new Response(openaiAnswer('ready'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  } })
  expect(model.profile.builtin_tools).toEqual(['web_search'])
  expect(CODEX_CLIENT_VERSION).toBe('0.159.0')
  const done = await run(new Agent<null>({ instructions: '', tools: [] }), model, 'Say ready')
  expect(done.output).toBe('ready')
  expect(seen[0]!.get('version')).toBe('0.159.0')
})

test("a search the model asked for after a call of ours ended its turn was never run: it does not go back to Anthropic, which refuses a call without its result", async () => {
  const route = new Route([
    anthropicStream({ model: 'claude-x', stop: 'tool_use', blocks: [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'q' } }, RESULT_BLOCK,
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.md' } },
      { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: { query: 'never run' } },
    ] }),
    anthropicStream({ model: 'claude-x', stop: 'end_turn', blocks: [{ type: 'text', pieces: ['Done.'] }] }),
  ])
  const model = new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://anthropic.mock', fetchImpl: route.fetch })
  const done = await run(searchingAgent(), model, 'read and search')
  expect(done.output).toBe('Done.')
  const assistant = (route.requests[1]!.messages as Rec[]).find((m) => m.role === 'assistant')!.content as Rec[]
  expect(assistant.map((b) => [b.type, b.id ?? b.tool_use_id])).toEqual([['server_tool_use', 'srvtoolu_1'], ['web_search_tool_result', 'srvtoolu_1'], ['tool_use', 'toolu_1']])
  // the record keeps the response as it came
  const parts = (done.messages.find((m) => m.kind === 'response') as { parts: Rec[] }).parts
  expect(parts.filter((p) => isBuiltinCall(p as never)).map((p) => p.tool_call_id)).toEqual(['srvtoolu_1', 'srvtoolu_2'])
})
