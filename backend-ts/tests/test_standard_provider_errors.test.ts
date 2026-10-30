import { expect, test } from 'bun:test'
import { classifyError, OUTAGE_RECOVERY_MAX } from '../src/agent/runner.ts'
import { diagnose } from '../src/agent/diagnosis.ts'
import { ModelHTTPError } from '../src/llm/model.ts'
import { DeepSeekModel, ZhipuModel } from '../src/llm/providers.ts'
import * as repo from '../src/db/repo.ts'
import { appState, buggyRepo, closeState, openSession, waitDone } from './harness.ts'
import { Route } from './helpers.ts'
import { openaiStream } from './providers_fixtures.ts'

const params = { function_tools: [], allow_text_output: true, thinking: null }
const envelope = (message: string) => ({ error: { message } })
const makeModel = (provider: string, route: Route) => {
  const opts = { apiKey: ['offline', 'fixture'].join('-'), baseUrl: 'https://provider.invalid', fetchImpl: route.fetch, maxRetries: 0 }
  return provider === 'deepseek' ? new DeepSeekModel('deepseek-flash', opts) : new ZhipuModel('glm-5.3', opts)
}

for (const provider of ['deepseek', 'zhipu']) {
  for (const [status, body, kind] of [
    [400, envelope('Your credit balance is too low'), 'quota'],
    [429, { error: { code: 'insufficient_quota' } }, 'quota'],
    [503, envelope('Your credits are depleted'), 'quota'],
    [503, { error: { code: 'insufficient_quota', message: 'Insufficient quota for this context request' } }, 'quota'],
    [402, envelope('context request rejected'), 'quota'],
    [401, { error: { code: 'insufficient_quota', message: 'Insufficient quota for this context request' } }, 'auth'],
    [429, envelope('Quota exceeded for requests per minute. Please retry in 1 second.'), 'rate_limit'],
    [503, envelope(`${'diagnostic prefix '.repeat(40)}quota exceeded`), 'quota'],
    [402, envelope('payment refused'), 'quota'],
    [503, envelope('billing service unavailable'), 'outage'],
    [503, envelope('credit balance lookup unavailable'), 'outage'],
    [503, envelope('temporarily unavailable'), 'outage'],
    [503, {}, 'outage'],
    [429, envelope('quota service unavailable'), 'rate_limit'],
    [429, envelope('Insufficient quota for requests per minute'), 'rate_limit'],
    [429, { error: { code: 'insufficient_quota', message: 'Insufficient quota for requests per minute in this context request' } }, 'quota'],
    [401, envelope('quota exceeded'), 'auth'],
    [400, envelope('maximum context tokens exceeded'), 'context_overflow'],
    [404, envelope('model not found'), 'model_unavailable'],
  ] as const) {
    test(`${provider} HTTP ${status}: ${kind} uses only error fields`, async () => {
      const secret = ['private', 'request', 'fixture'].join('-')
      const route = new Route([JSON.stringify({ ...body, request: { prompt: `explain quota exceeded ${secret}`, api_key: secret } })])
      route.status = status
      let caught: unknown
      try { await makeModel(provider, route).request([], {}, params) } catch (error) { caught = error }
      expect(caught instanceof ModelHTTPError).toBe(true)
      expect(route.requests).toHaveLength(1)
      expect(diagnose(caught)).toEqual({ kind, status_code: status })
      expect(classifyError(caught)).toBe(kind === 'model_unavailable' ? 'other' : kind)
      expect(caught).not.toHaveProperty('cause')
      const diagnostic = String(caught) + JSON.stringify(caught)
      expect(diagnostic.includes(secret)).toBe(false)
      expect(diagnostic.includes('explain')).toBe(false)
      const contextAuth = status === 401 && 'error' in body && 'message' in body.error && body.error.message.includes('context')
      const reason = kind === 'quota' ? 'quota exceeded'
        : kind === 'context_overflow' || contextAuth ? 'context window exceeded'
        : kind === 'model_unavailable' ? 'model not available'
        : 'request rejected; check standard API credentials, limits and request parameters'
      expect((caught as ModelHTTPError).body).toEqual({ error: { message: `${provider} ${reason}` } })
    })
  }

  for (const message of ['billing service unavailable', 'quota service unavailable', 'quota exceeded']) {
    test(`${provider} SSE: ${message} does not promote generic billing to quota`, async () => {
      const error = { message, request: { prompt: 'explain quota exceeded' } }
      const event = provider === 'deepseek' ? { type: 'response.failed', response: { error } } : { error }
      const route = new Route([`data: ${JSON.stringify(event)}\n\n`])
      let caught: unknown
      try { await makeModel(provider, route).request([], {}, params) } catch (error) { caught = error }
      expect(caught instanceof Error).toBe(true)
      expect(classifyError(caught) === 'quota').toBe(message === 'quota exceeded')
      expect(route.requests).toHaveLength(1)
      expect(caught).not.toHaveProperty('cause')
      expect((String(caught) + JSON.stringify(caught)).includes('explain')).toBe(false)
    })
  }

  test(`${provider}: request echo cannot leak into persisted outage diagnosis`, async () => {
    const secret = ['private', 'echo', 'fixture'].join('-')
    const route = new Route([JSON.stringify({ error: { message: 'billing service unavailable' }, request: { prompt: `explain quota exceeded ${secret}` } })])
    route.status = 503
    const state = await appState({ models: { 'scripted:a': makeModel(provider, route) } })
    try {
      state.runs.outage_backoff_s = [0]
      const { session } = await openSession(state, buggyRepo())
      const run = await waitDone(state, (await state.runs.start(session, 'offline fixture')).id)
      const events = repo.listEvents(state.conn, run.id)
      const records = repo.listModelRequests(state.conn, run.id)
      expect(run.status).toBe('error')
      expect(route.requests).toHaveLength(1 + OUTAGE_RECOVERY_MAX)
      expect(events.filter((e) => e.event === 'run_continued')).toHaveLength(OUTAGE_RECOVERY_MAX)
      expect(events.find((e) => e.event === 'error')?.data).toMatchObject({ kind: 'outage', status_code: 503 })
      expect(records.map((r) => r.status)).toEqual(Array(1 + OUTAGE_RECOVERY_MAX).fill('error'))
      const persisted = JSON.stringify({ run, events, records })
      expect(persisted.includes(secret)).toBe(false)
      expect(persisted.includes('explain quota exceeded')).toBe(false)
      expect(persisted.includes('billing service unavailable')).toBe(false)
    } finally { await closeState(state) }
  })
}

for (const provider of ['deepseek', 'zhipu']) {
  for (const [error, kind, status] of [
    [{ code: 'insufficient_quota', message: 'Insufficient quota for this context request' }, 'quota', 402],
    [{ message: 'Your credit balance is too low; rate limit for this context request' }, 'quota', 402],
    [{ message: 'maximum context tokens exceeded' }, 'context_overflow', 400],
    [{ message: 'Insufficient quota for requests per minute' }, 'rate_limit', 429],
    [{ code: 'insufficient_quota', message: 'Insufficient quota for requests per minute in this context request' }, 'quota', 402],
    [{ message: 'Quota exceeded for requests per minute. Please retry in 1 second.' }, 'rate_limit', 429],
    [{ message: 'Quota exceeded for tokens per second in this context request' }, 'rate_limit', 429],
    [{ message: 'You exceeded your quota: TPM limit reached' }, 'rate_limit', 429],
  ] as const) {
    test(`${provider} SSE precedence: ${error.message}`, async () => {
      const secret = ['private', 'sse', 'fixture'].join('-')
      const raw = { ...error, message: `${error.message} ${secret}`, request: { code: 'insufficient_quota', prompt: 'context request echo' } }
      const event = provider === 'deepseek' ? { type: 'response.failed', response: { error: raw } } : { error: raw }
      const route = new Route([`data: ${JSON.stringify(event)}\n\n`])
      let caught: unknown
      try { await makeModel(provider, route).request([], {}, params) } catch (e) { caught = e }
      expect(classifyError(caught)).toBe(kind)
      expect(diagnose(caught)).toEqual({ kind, status_code: status })
      expect(route.requests).toHaveLength(1)
      expect(caught).not.toHaveProperty('cause')
      const diagnostic = String(caught) + JSON.stringify(caught)
      expect(diagnostic.includes(secret)).toBe(false)
      expect(diagnostic.includes('request echo')).toBe(false)
      expect((caught as ModelHTTPError).body).toEqual({ error: { message: `${provider} ${kind === 'quota' ? 'quota exceeded' : kind === 'rate_limit' ? 'rate limit exceeded' : 'context window exceeded'}` } })
    })
  }

  for (const stream of [false, true]) {
    test(`${provider} context plus explicit quota stops runner without recovery (${stream ? 'SSE' : 'HTTP 503'})`, async () => {
      const secret = ['private', 'quota', 'fixture'].join('-')
      const error = { code: 'insufficient_quota', message: `Insufficient quota for this context request ${secret}` }
      const event = provider === 'deepseek' ? { type: 'response.failed', response: { error } } : { error }
      let calls = 0
      const opts = {
        apiKey: ['offline', 'fixture'].join('-'), baseUrl: 'https://provider.invalid',
        fetchImpl: async () => {
          calls += 1
          return stream ? new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
            : new Response(JSON.stringify({ error }), { status: 503, headers: { 'retry-after': '0' } })
        },
      }
      const model = provider === 'deepseek' ? new DeepSeekModel('deepseek-flash', opts) : new ZhipuModel('glm-5.3', opts)
      const state = await appState({ models: { 'scripted:a': model } })
      try {
        state.runs.outage_backoff_s = [0]
        const { session } = await openSession(state, buggyRepo())
        const run = await waitDone(state, (await state.runs.start(session, 'offline fixture')).id)
        const events = repo.listEvents(state.conn, run.id)
        const records = repo.listModelRequests(state.conn, run.id)
        expect(run.status).toBe('error')
        expect(calls).toBe(1)
        expect(events.filter((e) => e.event === 'run_continued')).toHaveLength(0)
        expect(events.find((e) => e.event === 'error')?.data).toMatchObject({ kind: 'quota', status_code: stream ? 402 : 503 })
        expect(records.map((r) => r.status)).toEqual(['error'])
        expect(JSON.stringify({ run, events, records }).includes(secret)).toBe(false)
      } finally { await closeState(state) }
    })
  }
}

for (const provider of ['deepseek', 'zhipu']) {
  for (const [status, message] of [
    [429, 'Quota exceeded for requests per minute. Please retry in 1 second.'],
    [429, 'Insufficient quota for requests per minute'],
    [503, 'billing service unavailable'],
  ] as const) {
    test(`${provider} transient HTTP ${status} recovers with exactly two physical fetches`, async () => {
      let calls = 0
      const success = provider === 'deepseek'
        ? openaiStream({ model: 'deepseek-flash', items: [{ type: 'message', id: 'fixture', pieces: ['done'] }] })
        : `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
      const opts = {
        apiKey: ['offline', 'fixture'].join('-'), baseUrl: 'https://provider.invalid',
        fetchImpl: async () => ++calls === 1
          ? new Response(JSON.stringify(envelope(message)), { status, headers: { 'retry-after': '0' } })
          : new Response(success, { headers: { 'content-type': 'text/event-stream' } }),
      }
      const model = provider === 'deepseek' ? new DeepSeekModel('deepseek-flash', opts) : new ZhipuModel('glm-5.3', opts)
      const result = await model.request([], {}, params)
      expect(result.parts.some((part) => part.part_kind === 'text' && part.content === 'done')).toBe(true)
      expect(calls).toBe(2)
    })
  }
}
