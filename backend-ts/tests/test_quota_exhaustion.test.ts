import { expect, test } from 'bun:test'
import { diagnose } from '../src/agent/diagnosis.ts'
import { classifyError } from '../src/agent/runner.ts'
import { postJson } from '../src/llm/http.ts'
import { ModelHTTPError, providerQuotaExhausted } from '../src/llm/model.ts'
import { AnthropicModel } from '../src/llm/providers/anthropic.ts'
import { modelResponse, textPart } from '../src/llm/messages.ts'
import * as repo from '../src/db/repo.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, waitDone } from './harness.ts'
import { anthropicStream } from './providers_fixtures.ts'

const balance = 'Your credit balance is too low to access the Anthropic API.'
const envelope = (message: string) => ({ error: { type: 'invalid_request_error', message } })
const refusal = (status: number, message: string) => new Response(JSON.stringify(envelope(message)), { status, headers: { 'retry-after': '0' } })

for (const status of [400, 402, 403, 429, 503]) {
  test(`explicit spent balance on HTTP ${status} makes exactly one physical fetch and diagnoses quota`, async () => {
    let calls = 0
    const model = new AnthropicModel('claude-sonnet-5-5', {
      apiKey: ['offline', 'fixture'].join('-'), baseUrl: 'https://provider.invalid',
      fetchImpl: async () => { calls += 1; return refusal(status, balance) },
    })
    let error: unknown
    try { await model.request([], {}, { function_tools: [], allow_text_output: true, thinking: null }) } catch (e) { error = e }
    expect(error instanceof ModelHTTPError).toBe(true)
    expect(calls).toBe(1)
    expect(classifyError(error)).toBe('quota')
    expect(diagnose(error)).toEqual({ kind: 'quota', status_code: status })
  })
}

test('quota matching is explicit, preserves auth, and ignores request echoes and generic billing words', () => {
  for (const [status, body] of [
    [402, {}], [400, envelope(balance)], [403, envelope('Your credits are depleted')],
    [429, { error: { code: 'insufficient_quota' } }],
    [503, envelope('Insufficient quota for this context request')],
    [429, envelope('You exceeded your current quota, please check your plan and billing details')],
    [429, envelope('The usage limit has been reached for this period')],
  ] as const) expect(providerQuotaExhausted(status, body)).toBe(true)
  for (const message of ['billing parameter is invalid', 'credit balance lookup unavailable', 'quota service unavailable', 'Rate limit reached for requests per minute']) {
    for (const status of [400, 403, 429, 503]) expect(providerQuotaExhausted(status, envelope(message))).toBe(false)
  }
  expect(providerQuotaExhausted(401, envelope(balance))).toBe(false)
  expect(providerQuotaExhausted(429, { message: 'slow down', request: { prompt: balance } })).toBe(false)
  expect(classifyError(new ModelHTTPError(429, 'fixture', { request: { prompt: balance } }))).toBe('rate_limit')
  const late = new ModelHTTPError(503, 'fixture', envelope(`${'diagnostic prefix '.repeat(40)}${balance}`))
  expect(classifyError(new Error('wrapped', { cause: late }))).toBe('quota')
  expect(diagnose(late).kind).toBe('quota')
})

for (const [status, message, kind, attempts] of [
  [400, 'billing parameter is invalid', 'bad_request', 1],
  [401, balance, 'auth', 1],
  [403, 'permission denied', 'auth', 1],
  [404, 'model not found', 'model_unavailable', 1],
  [429, 'Rate limit reached for requests per minute', 'rate_limit', 3],
  [500, 'internal server error', 'outage', 3],
  [503, 'billing service unavailable', 'outage', 3],
] as const) {
  test(`ordinary HTTP ${status} retains classification and default retry count`, async () => {
    let calls = 0
    let error: unknown
    try {
      await postJson('https://provider.invalid', {}, {}, 'fixture', {
        fetchImpl: async () => { calls += 1; return refusal(status, message) },
      })
    } catch (e) { error = e }
    expect(calls).toBe(attempts)
    expect(diagnose(error)).toEqual({ kind, status_code: status })
  })
}

for (const status of [400, 402, 403, 429, 503]) {
  test(`runner stops on spent balance ${status} after a tool, without recovery or route switching; records are redacted`, async () => {
    let calls = 0, refusedCalls = 0, otherRouteCalls = 0
    // Sensitive shapes are assembled only at runtime, never logged or used for real authentication.
    const key = ['sk', 'ant', 'api03', 'OFFLINE'.repeat(4)].join('-')
    const bearer = ['Bearer', 'FIXTURE'.repeat(4)].join(' ')
    const token = ['token=', 'PRIVATE'.repeat(4)].join('')
    const model = new AnthropicModel('claude-sonnet-5-5', {
      apiKey: key, baseUrl: 'https://provider.invalid',
      fetchImpl: async () => {
        calls += 1
        if (calls === 1) return new Response(anthropicStream({ model: 'claude-sonnet-5-5', stop: 'tool_use',
          blocks: [{ type: 'tool_use', id: 'fixture_read', name: 'read_file', input: { path: 'calc.py' } }] }),
          { headers: { 'content-type': 'text/event-stream' } })
        refusedCalls += 1
        return refusal(status, `${balance} ${key} ${bearer} ${token}`)
      },
    })
    const state = await appState({ models: {
      'scripted:a': model,
      'scripted:b': scriptedModel(() => { otherRouteCalls += 1; return modelResponse([textPart('unexpected fallback')]) }),
    } })
    try {
      state.runs.transport_backoff_s = [0]
      state.runs.outage_backoff_s = [0]
      const { session } = await openSession(state, buggyRepo())
      const run = await waitDone(state, (await state.runs.start(session, 'read the fixture')).id)
      const events = repo.listEvents(state.conn, run.id)
      const records = repo.listModelRequests(state.conn, run.id)
      expect(run.status).toBe('error')
      expect(run.model).toBe('scripted:a')
      expect(refusedCalls).toBe(1)
      expect(calls).toBe(2) // one successful tool request, then exactly one refused physical fetch
      expect(otherRouteCalls).toBe(0)
      expect(events.filter((e) => e.event === 'run_continued').length).toBe(0)
      expect(events.filter((e) => e.event === 'tool_call').length).toBe(1)
      const diagnosis = events.find((e) => e.event === 'error')?.data
      expect(diagnosis?.kind).toBe('quota')
      expect(diagnosis?.status_code).toBe(status)
      expect(records.map((r) => r.status)).toEqual(['ok', 'error'])
      expect(repo.getRunHistory(state.conn, run.id)).toBeTruthy()
      const persisted = JSON.stringify({ run, events, records })
      // Boolean assertions ensure even a regression's failure output cannot print the credential-shaped fixture.
      for (const secret of [key, bearer, token, 'OFFLINE'.repeat(4), 'FIXTURE'.repeat(4), 'PRIVATE'.repeat(4)]) {
        expect(persisted.includes(secret)).toBe(false)
      }
      expect(run.error?.includes(balance)).toBe(true)
    } finally { await closeState(state) }
  })
}

for (const message of [
  'Quota exceeded for requests per minute. Please retry in 1 second.',
  'Insufficient quota for requests per minute',
  'Insufficient quota for tokens per second',
  'Insufficient quota: RPM limit reached',
  'Insufficient quota: TPM limit reached',
  'You exceeded your quota for tokens per second.',
  'Quota exceeded: RPM limit reached.',
  'You exceeded your quota: TPM limit reached.',
  'Quota exceeded for requests/min.',
  'Quota exceeded for tokens/sec.',
]) {
  test(`short-cycle quota remains retryable: ${message}`, async () => {
    const body = envelope(message)
    expect(providerQuotaExhausted(429, body)).toBe(false)
    const error = new ModelHTTPError(429, 'fixture', body)
    expect(classifyError(error)).toBe('rate_limit')
    expect(diagnose(error)).toEqual({ kind: 'rate_limit', status_code: 429 })
    let calls = 0
    const response = await postJson('https://provider.invalid', {}, {}, 'fixture', {
      fetchImpl: async () => ++calls === 1 ? refusal(429, message) : new Response('{}'),
    })
    expect(response.status).toBe(200)
    expect(calls).toBe(2)
    // Strong exhaustion evidence must not be hidden by rate vocabulary.
    for (const strong of [balance, 'insufficient_quota', 'insufficient credits', 'insufficient funds', 'payment required', 'Your credits are exhausted']) {
      expect(providerQuotaExhausted(429, envelope(`${message} ${strong}`))).toBe(true)
    }
    expect(providerQuotaExhausted(429, { error: { code: 'insufficient_quota', message } })).toBe(true)
    expect(providerQuotaExhausted(402, body)).toBe(true)
    expect(providerQuotaExhausted(401, envelope(`${message} insufficient_quota`))).toBe(false)
  })
}

test('request echo cannot suppress exhaustion or promote a short-cycle refusal', () => {
  expect(providerQuotaExhausted(503, { error: { message: 'quota exceeded' }, request: { message: 'requests per minute' } })).toBe(true)
  expect(providerQuotaExhausted(429, { error: { message: 'Quota exceeded for tokens per minute' }, request: { code: 'insufficient_quota' } })).toBe(false)
})
