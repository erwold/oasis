/** A saved API key is read at every request: forgotten or replaced on the Accounts page, it stops being sent from the
 *  next request on — the next run's and a run already going. And a key goes only to the endpoint its route names:
 *  a redirect from there is reported with its target, never followed with the key. Fake providers on loopback. */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { forgetKey, saveKey } from '../src/auth/keys.ts'
import { ModelConfig } from '../src/config.ts'
import * as repo from '../src/db/repo.ts'
import { modelRequest, userPrompt } from '../src/llm/messages.ts'
import { ModelHTTPError } from '../src/llm/model.ts'
import { AnthropicModel, GoogleModel, OpenAIChatModel, OpenAIResponsesModel } from '../src/llm/providers.ts'
import { appState, buggyRepo, closeState, openSession, testConfig, waitDone, type AppState } from './harness.ts'
import { anthropicStream } from './providers_fixtures.ts'

const seen: { port: number; key: string | null; auth: string | null; goog: string | null }[] = []
let provider: ReturnType<typeof Bun.serve>
let other: ReturnType<typeof Bun.serve>
let redirector: ReturnType<typeof Bun.serve>
/** what the provider does before it answers a request (the test's hook into "meanwhile") */
let beforeAnswer: ((n: number) => Promise<void>) | null = null

function record(port: number, req: Request): void {
  seen.push({ port, key: req.headers.get('x-api-key'), auth: req.headers.get('authorization'), goog: req.headers.get('x-goog-api-key') })
}
const sse = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
const answer = () => sse(anthropicStream({ model: 'claude-x', stop: 'end_turn', blocks: [{ type: 'text', pieces: ['ok'] }] }))
const readCall = () => sse(anthropicStream({ model: 'claude-x', stop: 'tool_use', blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'calc.py' } }] }))

beforeAll(() => {
  provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    record(provider.port!, req)
    const n = seen.filter((s) => s.port === provider.port).length
    if (beforeAnswer) { await beforeAnswer(n); return n === 1 ? readCall() : answer() }
    return answer()
  } })
  other = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) { record(other.port!, req); return answer() } })
  redirector = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    record(redirector.port!, req)
    const url = new URL(req.url)
    return new Response(null, { status: 307, headers: { location: `http://localhost:${other.port}${url.pathname}?q=secret` } })
  } })
})
afterAll(() => { provider.stop(true); other.stop(true); redirector.stop(true) })

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null; beforeAnswer = null; seen.length = 0 })

function config() {
  return { ...testConfig(), models: [new ModelConfig({ id: 'key:claude', label: 'Key Claude', provider: 'anthropic', model: 'claude-x', api_key_env: 'ANTHROPIC_API_KEY', base_url: `http://127.0.0.1:${provider.port}` })], default_model: 'key:claude' }
}

async function runOnce(s: AppState, prompt = 'hi') {
  const { session } = await openSession(s, buggyRepo(), 'key:claude')
  return waitDone(s, (await s.runs.start(session, prompt)).id)
}

test('a key forgotten on the Accounts page is not sent by the next run, which ends asking for a credential', async () => {
  state = await appState({ config: config() })
  await saveKey('anthropic-api', 'test-synthetic-key-AAAA1111')
  expect((await runOnce(state)).status).toBe('done')
  expect(seen.map((s) => s.key)).toEqual(['test-synthetic-key-AAAA1111'])
  expect(await forgetKey('anthropic-api')).toBe(true)
  seen.length = 0
  const second = await runOnce(state)
  expect(seen).toEqual([])
  expect(second.status).toBe('error')
  expect(repo.listEvents(state.conn, second.id).find((e) => e.event === 'error')?.data.kind).toBe('auth')
})

test('a key replaced on the Accounts page is the one the next run sends', async () => {
  state = await appState({ config: config() })
  await saveKey('anthropic-api', 'test-synthetic-key-OLD00000')
  await runOnce(state)
  await saveKey('anthropic-api', 'test-synthetic-key-NEW11111')
  seen.length = 0
  await runOnce(state)
  expect(seen.map((s) => s.key)).toEqual(['test-synthetic-key-NEW11111'])
})

test('a key forgotten while a run is going: the request already sent keeps it, the next request is not sent', async () => {
  state = await appState({ config: config() })
  await saveKey('anthropic-api', 'test-synthetic-key-LIVE2222')
  // the first request is answered with a tool call after the key is forgotten; the run's next request would follow
  beforeAnswer = async (n) => { if (n === 1) await forgetKey('anthropic-api') }
  const run = await runOnce(state, 'read calc.py')
  expect(seen.map((s) => s.key)).toEqual(['test-synthetic-key-LIVE2222'])
  expect(run.status).toBe('error')
  expect(repo.listEvents(state.conn, run.id).find((e) => e.event === 'error')?.data.kind).toBe('auth')
})

test('a redirect from the configured endpoint is reported with its target and not followed: no mapping sends its key on', async () => {
  const base = `http://127.0.0.1:${redirector.port}`
  const models = [
    new AnthropicModel('claude-x', { apiKey: 'test-synthetic-key-anth', baseUrl: base, maxRetries: 0 }),
    new OpenAIResponsesModel('gpt-x', { apiKey: 'test-synthetic-key-resp', baseUrl: `${base}/v1`, maxRetries: 0 }),
    new OpenAIChatModel('chat-x', { apiKey: 'test-synthetic-key-chat', baseUrl: `${base}/v1`, maxRetries: 0 }),
    new GoogleModel('gemini-x', { apiKey: 'test-synthetic-key-goog', baseUrl: base, maxRetries: 0 }),
  ]
  for (const model of models) {
    seen.length = 0
    const error = await model.requestStream([modelRequest([userPrompt('hi')])], {}, { function_tools: [], allow_text_output: true, thinking: null })
      .then(async (s) => { for await (const _ of s.events()) { /* drain */ } return null }, (e) => e)
    expect(seen.map((s) => s.port)).toEqual([redirector.port!])
    expect(error).toBeInstanceOf(ModelHTTPError)
    expect((error as ModelHTTPError).status_code).toBe(307)
    // the target is named (origin and path); its query is not repeated
    expect((error as ModelHTTPError).message).toContain(`http://localhost:${other.port}/`)
    expect((error as ModelHTTPError).message).not.toContain('secret')
  }
})
