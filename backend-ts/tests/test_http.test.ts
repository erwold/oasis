/** The model transport's deadlines and pauses: a request that gets no headers in time is a TimeoutException
 *  (retried like any transient failure, never mistaken for the person's Stop), a streamed answer silent too long is
 *  cancelled as a TimeoutException, and a provider's Retry-After is waited out when short and handed back when long. */

import { expect, test } from 'bun:test'
import { postJson, readSse, retryAfterMs, type FetchLike } from '../src/llm/http.ts'
import { ModelHTTPError, TransportError } from '../src/llm/model.ts'

/** A fetch that never answers, but gives up when its signal is aborted (as a real fetch does). */
const hanging: FetchLike = (_input, init) => new Promise((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted')), { once: true })
})

async function failure(p: Promise<unknown>): Promise<unknown> {
  try { await p; return null } catch (error) { return error }
}

test('no headers within the deadline is a TimeoutException, retried like a transient failure', async () => {
  const started = Date.now()
  const error = await failure(postJson('http://m.mock/v1', {}, {}, 'model-x', { fetchImpl: hanging, timeoutMs: 40, maxRetries: 0 }))
  expect(error).toBeInstanceOf(TransportError)
  expect((error as TransportError).kind).toBe('TimeoutException')
  expect((error as Error).message).toContain('no response from model-x')
  expect(Date.now() - started).toBeLessThan(1000)
  let calls = 0
  const thenAnswers: FetchLike = (input, init) => { calls += 1; return calls === 1 ? hanging(input, init) : Promise.resolve(new Response('{}', { status: 200 })) }
  const response = await postJson('http://m.mock/v1', {}, {}, 'model-x', { fetchImpl: thenAnswers, timeoutMs: 40, maxRetries: 1 })
  expect(response.status).toBe(200)
  expect(calls).toBe(2)
})

test("the person's Stop is reported as the stop, not as a timeout", async () => {
  const stop = new AbortController()
  const reason = new Error('the person stopped the run')
  setTimeout(() => stop.abort(reason), 20)
  const error = await failure(postJson('http://m.mock/v1', {}, {}, 'model-x', { fetchImpl: hanging, timeoutMs: 5000, maxRetries: 2 }, stop.signal))
  expect(error).toBe(reason)
})

test('a streamed answer silent past the idle limit is cancelled as a TimeoutException, after what did arrive', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('event: a\ndata: {"n":1}\n\n')) },
    cancel() { cancelled = true },
  })
  const seen: string[] = []
  const error = await failure((async () => { for await (const m of readSse(new Response(body), 'model-x', 40)) seen.push(m.data) })())
  expect(seen).toEqual(['{"n":1}'])
  expect(error).toBeInstanceOf(TransportError)
  expect((error as TransportError).kind).toBe('TimeoutException')
  expect((error as Error).message).toContain('silent for')
  expect(cancelled).toBe(true)
})

test("Retry-After: read as seconds or a date; a short one waited out, a long one handed back at once", async () => {
  expect(retryAfterMs('2')).toBe(2000)
  expect(retryAfterMs('0.5')).toBe(500)
  expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6_000)
  expect(retryAfterMs(null)).toBeNull()
  expect(retryAfterMs('soon')).toBeNull()
  let calls = 0
  const busyOnce: FetchLike = () => { calls += 1; return Promise.resolve(calls === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '1' } }) : new Response('{}', { status: 200 })) }
  const started = Date.now()
  expect((await postJson('http://m.mock/v1', {}, {}, 'model-x', { fetchImpl: busyOnce, maxRetries: 2 })).status).toBe(200)
  expect(Date.now() - started).toBeGreaterThanOrEqual(950)                      // the provider's second, not the 500 ms backoff
  calls = 0
  const busyLong: FetchLike = () => { calls += 1; return Promise.resolve(new Response('{"error":"slow down"}', { status: 429, headers: { 'retry-after': '3600' } })) }
  const error = await failure(postJson('http://m.mock/v1', {}, {}, 'model-x', { fetchImpl: busyLong, maxRetries: 2 }))
  expect(error).toBeInstanceOf(ModelHTTPError)
  expect((error as ModelHTTPError).status_code).toBe(429)
  expect(calls).toBe(1)
})
