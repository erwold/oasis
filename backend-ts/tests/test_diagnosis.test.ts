/** A failed run says which kind of failure it was — credentials, a spent quota or a moment's rate limit, a
 *  conversation too long for the window, a model the route does not have, the provider down, a stall or a dropped
 *  connection — and its message never carries a credential. */

import { afterEach, expect, test } from 'bun:test'
import { diagnose } from '../src/agent/diagnosis.ts'
import { redactSecrets } from '../src/llm/redact.ts'
import { LoginRequired } from '../src/auth/errors.ts'
import * as repo from '../src/db/repo.ts'
import { ModelHTTPError, TransportError } from '../src/llm/model.ts'
import { appState, buggyRepo, closeState, collectEvents, openSession, scriptedModel, setModel, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

const http = (status: number, message: string) => new ModelHTTPError(status, 'model-x', { error: { message } })

test('each failure is named by what it means', () => {
  const cases: [unknown, string][] = [
    [http(401, 'invalid x-api-key'), 'auth'],
    [new LoginRequired('sign in again'), 'auth'],
    [http(429, 'You exceeded your current quota, please check your plan and billing details'), 'quota'],
    [http(429, 'The usage limit has been reached for this period'), 'quota'],
    [http(402, 'payment required'), 'quota'],
    [http(429, 'Rate limit reached for requests per minute'), 'rate_limit'],
    [http(400, 'prompt is too long: 1020000 tokens > 1000000 maximum'), 'context_overflow'],
    [http(404, 'model gpt-9 does not exist'), 'model_unavailable'],
    [http(400, 'The requested model is not available on this route'), 'model_unavailable'],
    [http(400, 'tools.0.name: invalid characters'), 'bad_request'],
    [http(503, 'upstream overloaded'), 'outage'],
    [new TransportError('TimeoutException', 'no response from model-x within 300 s'), 'timeout'],
    [new TransportError('ReadError', 'the stream dropped: socket hang up'), 'disconnect'],
    [new Error('something else entirely'), 'other'],
  ]
  for (const [error, kind] of cases) expect(`${(error as Error).message} → ${diagnose(error).kind}`).toBe(`${(error as Error).message} → ${kind}`)
  expect(diagnose(http(429, 'slow down')).status_code).toBe(429)
  expect(diagnose(new Error('x')).status_code).toBeNull()
})

test('credentials in a message are masked; the harness ids stay readable', () => {
  const text = redactSecrets('401 for key sk-ant-api03-AbCdEfGhIjKlMnOp and sk-proj-1234567890abcdef, header Bearer eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM, '
    + 'google AIzaSyA1234567890abcdefghij, token=ghp_abcdefghijkl run run_57d1cd47838a cp_006d43bd743f')
  for (const secret of ['AbCdEfGhIjKlMnOp', '1234567890abcdef', 'eyJhbGciOi', 'AIzaSyA1234567890', 'ghp_abcdefghijkl']) expect(text).not.toContain(secret)
  expect(text).toContain('sk-…')
  expect(text).toContain('Bearer …')
  expect(text).toContain('token=…')
  expect(text).toContain('run_57d1cd47838a')
  expect(text).toContain('cp_006d43bd743f')
})

test('a run failing on its credentials records the kind and a masked message', async () => {
  state = await appState()
  const { session } = await openSession(state, buggyRepo())
  setModel(state, 'scripted:a', scriptedModel(() => { throw http(401, 'invalid x-api-key: sk-ant-api03-SECRETSECRETSECRET') }))
  const run = await waitDone(state, (await state.runs.start(session, 'hello')).id)
  expect(run.status).toBe('error')
  expect(run.error).not.toContain('SECRETSECRET')
  const events = await collectEvents(state, run.id)
  const error = events.find((e) => e.event === 'error')!.data
  expect(error.kind).toBe('auth')
  expect(error.status_code).toBe(401)
  expect(error.model).toBe('scripted:a')
  expect(String(error.message)).not.toContain('SECRETSECRET')
  expect(JSON.stringify(repo.listEvents(state.conn, run.id))).not.toContain('SECRETSECRET')
  expect(JSON.stringify(state.conn.all('SELECT * FROM model_requests WHERE run_id=?', [run.id]))).not.toContain('SECRETSECRET')
})
