/** Codex returns failures inside HTTP 200 SSE. These are ordinary ModelAPIErrors, not synthetic HTTP 400s.
 * The official client maps context_length_exceeded to ContextWindowExceeded:
 * https://github.com/openai/codex/blob/6a6e2fb1f0e9122464a75929c58356cb7af9e0cc/codex-rs/codex-api/src/sse/responses_error.rs
 * Messages here are fixtures, not recovered text from the owner's failed requests. */
import { expect, test } from 'bun:test'
import { isContextError } from '../src/agent/context.ts'
import { classifyError } from '../src/agent/runner.ts'
import { modelRequest, userPrompt } from '../src/llm/messages.ts'
import { ModelAPIError, ModelHTTPError } from '../src/llm/model.ts'
import { OpenAIResponsesModel } from '../src/llm/providers/openai_responses.ts'

const shapes = {
  failed: (error: unknown) => ({ type: 'response.failed', response: { error } }),
  nested: (error: unknown) => ({ type: 'error', error }),
  top: (error: unknown) => ({ type: 'error', ...error as object }),
}
const params = { function_tools: [], allow_text_output: true, thinking: null }
const messages = [modelRequest([userPrompt('hello')])]

for (const [shape, envelope] of Object.entries(shapes)) {
  test(`Codex ${shape}: code/message survive, credentials and other response fields do not`, async () => {
    const signedToken = 'opaque-signed-credential-42'
    const secrets = [signedToken, 'sk-proj-fakecredential12345', 'fake-bearer-credential', 'named-refresh-credential', 'eyJabcdefghijk.abcdefghijk.abcdefghijk']
    const error = { code: 'context_length_exceeded', message: `Input exceeds the context window; ${signedToken}; ${secrets[1]}; Bearer ${secrets[2]}; refresh_token=${secrets[3]}; ${secrets[4]}`, debug: 'PRIVATE-RESPONSE-FIELD' }
    const event = { ...envelope(error), request: { token: 'PRIVATE-REQUEST-FIELD' } }
    const model = new OpenAIResponsesModel('gpt-6-astra', {
      codex: true, baseUrl: 'https://codex.invalid',
      // Native subscription auth is injected here, not in opts.apiKey. It can be echoed without a Bearer prefix.
      beforeSend: ({ headers }) => { headers.set('authorization', `Bearer ${signedToken}`) },
      fetchImpl: async () => new Response(`data: ${JSON.stringify(event)}\n\n`),
    })
    const caught = await model.request(messages, {}, params).catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(ModelAPIError)
    expect(caught).not.toBeInstanceOf(ModelHTTPError)
    const text = (caught as Error).message
    expect(text).toContain('context_length_exceeded')
    expect(text).toContain('Input exceeds the context window')
    for (const secret of [...secrets, 'PRIVATE-RESPONSE-FIELD', 'PRIVATE-REQUEST-FIELD']) expect(text).not.toContain(secret)
    expect(isContextError(caught)).toBe(true)
    expect(classifyError(caught)).toBe('context_overflow')
  })
}

for (const [error, expected] of [
  [{ code: 'context_length_exceeded' }, 'context_overflow'],
  [{ code: 'context_window_exceeded' }, 'context_overflow'],
  [{ message: 'Your input exceeds the context window of this model.' }, 'context_overflow'],
  [{ code: 'server_error', message: 'Try again later' }, 'transport'],
  [{ code: 'server_error', message: 'request took too long' }, 'transport'],
  [{ code: 'server_error', message: 'context window lookup took too long' }, 'transport'],
  [{ code: 'rate_limit_exceeded', message: 'too many tokens per minute for this context window' }, 'other'],
  [{ code: 'invalid_api_key', message: 'context window access denied; token is invalid' }, 'other'],
  [{ code: 'authentication_error', message: 'context token validation took too long' }, 'other'],
  [{ code: 'insufficient_quota', message: 'too many tokens requested for this context window' }, 'other'],
  [{ code: 'context_length_exceeded', message: 'stream error: request rejected' }, 'context_overflow'],
  [{ code: 'invalid_request_error', message: 'Your input exceeds the context window of this model.' }, 'context_overflow'],
  [{ code: 'invalid_request_error', message: 'Unknown parameter: foo' }, 'other'],
  [{}, 'other'],
] as const) {
  test(`Codex failure ${JSON.stringify(error)} is classified as ${expected}`, async () => {
    const model = new OpenAIResponsesModel('gpt-6-astra', { codex: true, fetchImpl: async () => new Response(`data: ${JSON.stringify(shapes.failed(error))}\n\n`) })
    const caught = await model.request(messages, {}, params).catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(ModelAPIError)
    expect(classifyError(caught)).toBe(expected)
    expect(classifyError(new Error('wrapped', { cause: caught }))).toBe(expected)
    expect(isContextError(caught)).toBe(expected === 'context_overflow')
    if ('message' in error) expect((caught as Error).message).toContain(error.message)
    if (!Object.keys(error).length) expect((caught as Error).message).toBe('Codex response failed; check provider access and limits')
  })
}

test('Codex diagnostics mask opaque credentials in code as well as message, including the structured code', async () => {
  const token = 'opaque-api-credential-fixture'
  const event = shapes.failed({ code: token, message: `Rejected ${token}` })
  const model = new OpenAIResponsesModel('gpt-6-astra', {
    codex: true, apiKey: () => token, fetchImpl: async () => new Response(`data: ${JSON.stringify(event)}\n\n`),
  })
  const caught = await model.request(messages, {}, params).catch((e: unknown) => e)
  expect(caught).toBeInstanceOf(ModelAPIError)
  expect((caught as ModelAPIError).provider_code).toBe('…')
  expect((caught as Error).message).toContain('Rejected …')
  expect(JSON.stringify(caught)).not.toContain(token)
})

test('Codex malformed diagnostic fields do not serialize the error envelope', async () => {
  const event = shapes.failed({ code: { token: 'PRIVATE-CODE' }, message: { request: 'PRIVATE-MESSAGE' } })
  const model = new OpenAIResponsesModel('gpt-6-astra', { codex: true, fetchImpl: async () => new Response(`data: ${JSON.stringify(event)}\n\n`) })
  const caught = await model.request(messages, {}, params).catch((e: unknown) => e)
  expect(caught).toBeInstanceOf(ModelAPIError)
  expect((caught as Error).message).toBe('Codex response failed; check provider access and limits')
  expect((caught as ModelAPIError).provider_code).toBeNull()
})

test('context SSE classification follows causes and precedes generic stream recovery, without reclassifying HTTP auth or unrelated errors', () => {
  const overflow = new ModelAPIError('astra', 'Codex response failed: context_length_exceeded: stream error')
  expect(classifyError(new Error('wrapped', { cause: overflow }))).toBe('context_overflow')
  expect(classifyError(new Error('local operation took too long'))).toBe('other')
  expect(classifyError(new ModelHTTPError(401, 'astra', { error: { message: 'context window access denied' } }))).toBe('auth')
  expect(classifyError(new ModelHTTPError(429, 'astra', { error: { message: 'too many tokens per minute' } }))).toBe('rate_limit')
})
