/** How an answer ends decides whether it is the answer. A normal stop with words is one request; words cut at the
 *  output limit are asked for their rest (bounded, counted, within the request line); a response with no answer
 *  text is asked once more; a filter or refusal is taken as it is. Past the bounds the run keeps the words and says
 *  it has no complete answer. A stream that closes without its protocol's end is not a response (its calls never
 *  run). Arguments that are not JSON are said to the model with the parser's reason, paired to their call. Scripted
 *  models, a mock fetch per provider protocol; no command runs, no real model. */

import { afterEach, expect, test } from 'bun:test'
import { z } from '@oasis-code/contract'
import { Agent, EMPTY_ANSWER_RETRIES, OUTPUT_LIMIT_CONTINUATIONS } from '../src/agent/loop.ts'
import * as repo from '../src/db/repo.ts'
import {
  isRequest, isRetryPrompt, isToolReturn, isUserPrompt, loadValue, modelRequest, modelResponse, textPart, thinkingPart, toolCallPart, userPrompt,
  type ModelMessage,
} from '../src/llm/messages.ts'
import type { Model } from '../src/llm/model.ts'
import { ModelAPIError } from '../src/llm/model.ts'
import { AnthropicModel, GoogleModel, OpenAIChatModel } from '../src/llm/providers.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, waitDone, type AppState } from './harness.ts'
import { Route, runAgent, zodTool } from './helpers.ts'
import { anthropicStream, geminiChunk, geminiStream } from './providers_fixtures.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

const requestTexts = (messages: ModelMessage[]) =>
  messages.filter(isRequest).flatMap((m) => m.parts.filter(isUserPrompt).map((p) => (typeof p.content === 'string' ? p.content : '')))

async function runWith(script: (messages: ModelMessage[], n: number) => ReturnType<typeof modelResponse>, budget?: { requests?: number }) {
  state = await appState()
  const { session } = await openSession(state, buggyRepo())
  let n = 0
  const seen: ModelMessage[][] = []
  setModel(state, 'scripted:a', scriptedModel((messages) => { seen.push(messages); n += 1; return script(messages, n) }))
  const run = await waitDone(state, (await state.runs.start(session, 'explain calc.py', budget ? { budget } : {})).id)
  const history = loadValue(JSON.parse(repo.getRunHistory(state.conn, run.id) ?? '[]'))
  const events = repo.listEvents(state.conn, run.id)
  return { run, seen, history, events, requests: n }
}

test('a normal stop with words: one request, no tool, done, nothing said about its end', async () => {
  const r = await runWith(() => modelResponse([textPart('add() subtracts; it should add.')], { finish_reason: 'stop' }))
  expect(r.requests).toBe(1)
  expect(r.run.status).toBe('done')
  expect(r.run.receipt.final_text).toBe('add() subtracts; it should add.')
  expect((r.run.receipt.mechanical as Record<string, unknown>).answer_end).toBeNull()
  expect(r.events.filter((e) => e.event === 'run_continued')).toHaveLength(0)
})

test('words cut at the output limit are asked for their rest: the halves are one answer, the record keeps each response', async () => {
  const r = await runWith((_m, n) => (n === 1
    ? modelResponse([textPart('The bug is in add(): it ret')], { finish_reason: 'length' })
    : modelResponse([textPart('urns a - b instead of a + b.')], { finish_reason: 'stop' })))
  expect(r.requests).toBe(2)
  expect(r.run.status).toBe('done')
  expect(r.run.receipt.final_text).toBe('The bug is in add(): it returns a - b instead of a + b.')
  expect((r.run.receipt.mechanical as Record<string, unknown>).answer_end).toBeNull()
  expect(requestTexts(r.seen[1]!).some((t) => t.includes('reached the output limit') && t.includes('without repeating'))).toBe(true)
  const continued = r.events.filter((e) => e.event === 'run_continued')
  expect(continued.map((e) => [e.data.reason, e.data.attempt, e.data.of])).toEqual([['output_limit', 1, OUTPUT_LIMIT_CONTINUATIONS]])
  expect(Number(continued[0]!.data.kept_chars)).toBe('The bug is in add(): it ret'.length)
  expect(r.history.filter((m) => m.kind === 'response')).toHaveLength(2)
})

test('an answer still cut after the continuations: the words are kept, the run says it has no complete answer, bounded requests', async () => {
  const r = await runWith((_m, n) => modelResponse([textPart(`part${n} `)], { finish_reason: 'length' }))
  expect(r.requests).toBe(1 + OUTPUT_LIMIT_CONTINUATIONS)
  expect(r.run.status).toBe('error')
  expect(r.run.error).toContain('incomplete_answer: the answer reached the output limit')
  expect(r.run.receipt.final_text).toBe('part1 part2 part3 ')
  expect((r.run.receipt.mechanical as Record<string, unknown>).answer_end).toEqual({ reason: 'length', attempts: OUTPUT_LIMIT_CONTINUATIONS })
  expect(r.events.find((e) => e.event === 'error')!.data.kind).toBe('incomplete')
})

test('the request budget leaves no room to continue: no further request, the cut words kept, said as incomplete', async () => {
  const r = await runWith(() => modelResponse([textPart('half an answer')], { finish_reason: 'length' }), { requests: 1 })
  expect(r.requests).toBe(1)
  expect(r.run.status).toBe('error')
  expect(r.run.receipt.final_text).toBe('half an answer')
  expect((r.run.receipt.mechanical as Record<string, unknown>).answer_end).toEqual({ reason: 'length', attempts: 0 })
})

test('a response with no answer text is asked once more; an answer then ends the run normally', async () => {
  const r = await runWith((_m, n) => (n === 1 ? modelResponse([thinkingPart('thinking only')], { finish_reason: 'stop' }) : modelResponse([textPart('The answer.')], { finish_reason: 'stop' })))
  expect(r.requests).toBe(2)
  expect(r.run.status).toBe('done')
  expect(r.run.receipt.final_text).toBe('The answer.')
  expect(requestTexts(r.seen[1]!).some((t) => t.includes('contained no answer text'))).toBe(true)
  expect(r.events.filter((e) => e.event === 'run_continued').map((e) => e.data.reason)).toEqual(['no_answer'])
})

test('no answer text again after the retry: bounded, and the run says the model gave no answer', async () => {
  const r = await runWith(() => modelResponse([], { finish_reason: 'stop' }))
  expect(r.requests).toBe(1 + EMPTY_ANSWER_RETRIES)
  expect(r.run.status).toBe('error')
  expect(r.run.error).toContain('the model gave no answer text')
  expect((r.run.receipt.mechanical as Record<string, unknown>).answer_end).toEqual({ reason: 'no_final_output', attempts: EMPTY_ANSWER_RETRIES })
})

test('a provider error end without a call is asked once more, then said as such', async () => {
  const r = await runWith(() => modelResponse([], { finish_reason: 'error' }))
  expect(r.requests).toBe(1 + EMPTY_ANSWER_RETRIES)
  expect((r.run.receipt.mechanical as Record<string, unknown>).answer_end).toEqual({ reason: 'provider_error', attempts: EMPTY_ANSWER_RETRIES })
})

test('a filter or refusal is taken as it is: one request, not asked again, its end recorded', async () => {
  const r = await runWith(() => modelResponse([textPart('I can’t help with that.')], { finish_reason: 'content_filter' }))
  expect(r.requests).toBe(1)
  expect(r.run.status).toBe('done')
  expect(r.run.receipt.final_text).toBe('I can’t help with that.')
  expect((r.run.receipt.mechanical as Record<string, unknown>).answer_end).toEqual({ reason: 'content_filter', attempts: 0 })
  // the run's end says it too, for the page to show beside the words: not an answer that ended as asked
  const finished = r.events.find((e) => e.event === 'run_finished')!
  expect(finished.data.answer_end).toEqual({ reason: 'content_filter', attempts: 0 })
})

test('words that promise work are not judged: a stop with "I will do it now" ends the run as an answer', async () => {
  const r = await runWith(() => modelResponse([textPart('I will fix it now.')], { finish_reason: 'stop' }))
  expect(r.requests).toBe(1)
  expect(r.run.status).toBe('done')
})

// ---- the protocols' ends -------------------------------------------------------------------------------------

const readTool = (calls: string[]) => new Agent<null>({
  instructions: 'x', retries: 3,
  tools: [zodTool<null, z.ZodType>('read_file', 'Read', z.object({ path: z.string() }), (_d, a) => { calls.push((a as { path: string }).path); return { status: 'ok' } })],
})

/** The stream's own verdict: null when it ended as its protocol says, else the error it ended with. */
async function streamFails(model: Model): Promise<{ error: unknown }> {
  const stream = await model.requestStream([modelRequest([userPrompt('hi')], 'x')], {}, { function_tools: [], allow_text_output: true, thinking: null })
  try { for await (const _ of stream.events()) { /* drain */ } return { error: null } } catch (error) { return { error } }
}

const cut = (text: string, marker: string) => text.slice(0, text.indexOf(marker))

test('Anthropic: message_stop (or the stop_reason just before it) ends a response; a stream closed before either is cut', async () => {
  const whole = anthropicStream({ model: 'claude-x', stop: 'end_turn', blocks: [{ type: 'text', pieces: ['Hello'] }] })
  const ok = await streamFails(new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://a.mock', fetchImpl: new Route([whole]).fetch }))
  expect(ok.error).toBeNull()
  const beforeDelta = cut(whole, 'event: message_delta')
  const bad = await streamFails(new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://a.mock', fetchImpl: new Route([beforeDelta]).fetch }))
  expect(bad.error).toBeInstanceOf(ModelAPIError)
  expect(String((bad.error as Error).message)).toContain('stream ended before message_stop')
  const noStop = cut(whole, 'event: message_stop')                                     // the stop_reason came: taken
  expect((await streamFails(new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://a.mock', fetchImpl: new Route([noStop]).fetch }))).error).toBeNull()
})

const chatChunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

test('Chat: a finish_reason or [DONE] ends a response; a stream closed with neither is cut — and its half tool call never runs', async () => {
  const chat = (body: string) => new OpenAIChatModel('m', { apiKey: 'k', baseUrl: 'http://c.mock', fetchImpl: new Route([body]).fetch })
  expect((await streamFails(chat(chatChunk({ content: 'Hi' }) + chatChunk({}, 'stop')))).error).toBeNull()
  expect((await streamFails(chat(chatChunk({ content: 'Hi' }) + 'data: [DONE]\n\n'))).error).toBeNull()
  const bad = await streamFails(chat(chatChunk({ content: 'Hi' })))
  expect(String((bad.error as Error).message)).toContain('stream ended without a finish_reason or [DONE]')
  // a tool call whose stream was cut is not run: the loop fails the request (a transport failure the runner recovers from)
  const calls: string[] = []
  const halfCall = chatChunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"calc.py"}' } }] })
  const error = await runAgent(readTool(calls), chat(halfCall), 'read it', null).then(() => null, (e: unknown) => e)
  expect(error).toBeInstanceOf(ModelAPIError)
  expect(calls).toEqual([])
})

test('Gemini: the candidate\'s finishReason ends a response; a stream closed before it is cut', async () => {
  const gemini = (body: string) => new GoogleModel('gemini-z', { apiKey: 'k', baseUrl: 'http://g.mock', fetchImpl: new Route([body]).fetch })
  expect((await streamFails(gemini(geminiStream([geminiChunk([{ text: 'Hi' }], { finish: 'STOP' })])))).error).toBeNull()
  const bad = await streamFails(gemini(geminiStream([geminiChunk([{ text: 'Hi' }])])))
  expect(String((bad.error as Error).message)).toContain('stream ended without a finishReason')
})

test('a cut stream is a transport failure the runner recovers from once: the kept words and the rest are one answer', async () => {
  state = await appState()
  const { session } = await openSession(state, buggyRepo())
  let n = 0
  setModel(state, 'scripted:a', scriptedModel(() => {
    n += 1
    if (n === 1) return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, 'r1')])
    if (n === 2) throw new ModelAPIError('m', 'the chat completion stream ended without a finish_reason or [DONE]')
    return modelResponse([textPart('done reading')])
  }))
  ;(state.runs as unknown as { transport_backoff_s: number[] }).transport_backoff_s = [0, 0, 0]
  const run = await waitDone(state, (await state.runs.start(session, 'read')).id)
  expect(run.status).toBe('done')
  expect(repo.listEvents(state.conn, run.id).filter((e) => e.event === 'tool_result')).toHaveLength(1)   // read once, not again
  expect(repo.listEvents(state.conn, run.id).filter((e) => e.event === 'run_continued').map((e) => e.data.reason)).toEqual(['transport_error'])
})

// ---- arguments the model sends wrong ------------------------------------------------------------------------------

test('arguments that are not JSON are answered with the parser\'s reason under the same call id; nothing runs until they are right, then once', async () => {
  const calls: string[] = []
  const seen: ModelMessage[][] = []
  let n = 0
  const model = scriptedModel((messages) => {
    seen.push(messages)
    n += 1
    if (n === 1) return modelResponse([toolCallPart('read_file', '{"path": "calc.py"', 'bad1')])
    if (n === 2) return modelResponse([toolCallPart('read_file', {}, 'bad2')])
    if (n === 3) return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, 'good')])
    return modelResponse([textPart('read')])
  })
  const run = await runAgent(readTool(calls), model, 'read calc.py', null)
  expect(run.result.output).toBe('read')
  expect(calls).toEqual(['calc.py'])                                                   // one execution, the right one
  const retries = seen[3]!.filter(isRequest).flatMap((m) => m.parts.filter(isRetryPrompt))
  expect(retries.map((p) => p.tool_call_id)).toEqual(['bad1', 'bad2'])
  expect(String(retries[0]!.content)).toContain('not valid JSON')
  expect(String(retries[0]!.content)).toContain('{"path": "calc.py"')
  expect(String(retries[1]!.content)).toContain('path')                                // the schema's field
  // the wrong calls are answered by their retry prompts only; the one return is the right call's
  expect(seen[3]!.filter(isRequest).flatMap((m) => m.parts.filter(isToolReturn)).map((p) => p.tool_call_id)).toEqual(['good'])
})

test('arguments wrong again and again end the loop at the retry bound, having run nothing', async () => {
  const calls: string[] = []
  let n = 0
  const model = scriptedModel(() => { n += 1; return modelResponse([toolCallPart('read_file', '{oops', `bad${n}`)]) })
  const error = await runAgent(readTool(calls), model, 'read', null).then(() => null, (e: unknown) => e)
  expect(String((error as Error).message)).toContain('exceeded max retries count of 3')
  expect(n).toBe(4)
  expect(calls).toEqual([])
})

test('a call cut at the output limit is said to be cut, with how much of it came, and is not run; the next call runs', async () => {
  const fragment = '{"path":"NOTES.md","content":"# Notes\\nhalf of a long docu'
  const r = await runWith((_m, n) => (n === 1
    ? modelResponse([textPart('Writing it.'), toolCallPart('write_file', fragment, 'call_cut')], { finish_reason: 'length' })
    : n === 2
      ? modelResponse([toolCallPart('write_file', { path: 'NOTES.md', content: '# Notes\n' }, 'call_ok')], { finish_reason: 'tool_call' })
      : modelResponse([textPart('Written.')], { finish_reason: 'stop' })))
  expect(r.run.status).toBe('done')
  const told = r.seen[1]!.filter(isRequest).flatMap((m) => m.parts.filter(isRetryPrompt)).find((p) => p.tool_call_id === 'call_cut')
  expect(told).toBeDefined()
  const said = typeof told!.content === 'string' ? told!.content : JSON.stringify(told!.content)
  expect(said).toContain('output limit')
  expect(said).toContain(`${fragment.length} characters`)
  expect(said).toContain('It was not run')
  // the cut call wrote nothing; the whole one that followed did
  const results = r.events.filter((e) => e.event === 'tool_result' && e.data.tool === 'write_file')
  expect(results.map((e) => e.data.tool_call_id)).toEqual(['call_ok'])
})

test('a call whose arguments the provider could not decode is not run: the model is told why and its next call runs', async () => {
  const calls: string[] = []
  const told: string[] = []
  const model = scriptedModel((messages) => {
    const last = messages[messages.length - 1]!
    const retry = isRequest(last) ? last.parts.find(isRetryPrompt) : undefined
    if (retry) told.push(String(retry.content))
    if (isRequest(last) && last.parts.some(isToolReturn)) return modelResponse([textPart('read')])
    if (retry) return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, 'c2')])
    return modelResponse([toolCallPart('read_file', {}, 'c1', { provider_details: { args_problem: 'the carrier did not decode' } })])
  })
  const run = await runAgent(readTool(calls), model, 'read calc.py', null)
  expect(calls).toEqual(['calc.py'])
  expect(told).toEqual(['the carrier did not decode'])
  expect(run.result?.output).toBe('read')
})
