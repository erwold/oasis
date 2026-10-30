/** Gemini 4 Argon long decode on a streamed request, offline: every provider answer is a scripted fetch (the suite's
 *  network guard stays on; no key, no cloud). The rules asserted are the long-decode guide's (updated 2026-10-13, not
 *  probed online): past the first 32,768 tokens a stream carries a checkpoint token every 5,000 tokens; what came after
 *  the last one is pending — never shown, never a call — and a drop discards it and sends the same body again with
 *  only the latest token; before the first checkpoint there is nothing to resume from. A resume whose own request fails
 *  stays on the same checkpoint and counts against the same budget; a spent budget ends the answer without the
 *  runner sending it all again from the start; a Stop ends it at once. CONTINUATION hops only with an explicit total
 *  above one stream's cap, each from the token its own end carried; MAX_TOKENS never continues. Usage: each stream's
 *  last committed count, the streams' output summed, the first stream's prompt as the context, the later streams'
 *  prompts priced through details. Bun's socket idle deadline on Argon only, and Bun's reset error read by its code. */

import { afterEach, expect, test } from 'bun:test'
import { classifyError, transientTransportError } from '../src/agent/runner.ts'
import { diagnose } from '../src/agent/diagnosis.ts'
import { DEFAULT_MODELS, ModelConfig } from '../src/config.ts'
import { modelRequest, modelResponse, textPart, toolCallPart, userPrompt, isText, isToolCall, type ModelMessage } from '../src/llm/messages.ts'
import { CancellationToken, LongDecodeInterrupted, ModelAPIError, TransportError, type ModelRequestParameters, type StreamEvent } from '../src/llm/model.ts'
import { postJson } from '../src/llm/http.ts'
import { GoogleModel, joinUsage, type GoogleOptions } from '../src/llm/providers/google.ts'
import { estimateCost, UsageMeter } from '../src/llm/usage.ts'
import type { ModelRequestRecord } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { appState, buggyRepo, closeState, openSession, testConfig, waitDone, type AppState } from './harness.ts'
import { geminiChunk } from './providers_fixtures.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

const SIG = Buffer.from('argon-signature-committed').toString('base64')
const params = (tools = false): ModelRequestParameters => ({
  function_tools: tools ? [{ name: 'read_file', description: 'Read a file', parameters_json_schema: { type: 'object', properties: { path: { type: 'string' } } } }] : [],
  allow_text_output: true, thinking: 'high',
})
const hello = (): ModelMessage[] => [modelRequest([userPrompt('prove it')], 'be rigorous')]

function chunk(parts: Record<string, unknown>[], opts: { finish?: string; usage?: Record<string, number>; token?: string; id?: string } = {}): Record<string, unknown> {
  const c = geminiChunk(parts, opts)
  ;(c as { modelVersion: string }).modelVersion = 'gemini-4-argon'
  if (opts.id) (c as { responseId: string }).responseId = opts.id
  if (opts.token) ((c.candidates as Record<string, unknown>[])[0]!).continuationToken = opts.token
  return c
}
const usage = (prompt: number, out: number, cached = 0) => ({ promptTokenCount: prompt, candidatesTokenCount: out, totalTokenCount: prompt + out, cachedContentTokenCount: cached })
const sse = (c: Record<string, unknown>) => `data: ${JSON.stringify(c)}\r\n\r\n`

/** Bun's own shape for a peer that closed the socket (checked on Bun 1.4.0 over loopback by the audit step). */
function bunReset(): Error {
  const error = new TypeError('The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()')
  ;(error as unknown as { code: string }).code = 'ECONNRESET'
  return error
}

type Step =
  | { chunks: Record<string, unknown>[]; drop?: boolean }      // a 200 stream: its chunks, then a clean end or a reset
  | { reset: true }                                            // the request itself fails before any header
  | { status: number }                                         // the provider answers with a status

/** A provider played from a script, one step per physical request; every request body is kept. */
class Script {
  readonly bodies: Record<string, unknown>[] = []
  readonly inits: Record<string, unknown>[] = []
  constructor(readonly steps: Step[]) {}
  fetch = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
    this.inits.push(init as unknown as Record<string, unknown>)
    this.bodies.push(JSON.parse(String(init?.body ?? '{}')))
    const step = this.steps[Math.min(this.bodies.length - 1, this.steps.length - 1)]!
    if ('reset' in step) throw bunReset()
    if ('status' in step) return new Response(JSON.stringify({ error: { code: step.status, message: 'scripted', status: 'UNAVAILABLE' } }), { status: step.status })
    const encoder = new TextEncoder()
    // one chunk per read, then the end: a reset only once every chunk was read (an error raised earlier would empty
    // the queue — the way a real socket's bytes already read are never taken back)
    let i = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < step.chunks.length) { controller.enqueue(encoder.encode(sse(step.chunks[i++]!))); return }
        if (step.drop) controller.error(bunReset())
        else controller.close()
      },
    }, { highWaterMark: 0 })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
}

const argon = (script: Script, extra: GoogleOptions = {}) =>
  new GoogleModel('gemini-4-argon', { apiKey: 'test-key-argon', baseUrl: 'http://gemini.mock', maxRetries: 0, resumeBackoffMs: [0], fetchImpl: script.fetch, ...extra })

async function drain(model: GoogleModel, messages = hello(), settings = {}, p = params(), signal?: AbortSignal) {
  const stream = await model.requestStream(messages, settings, p, signal ? { signal } : undefined)
  const events: StreamEvent[] = []
  let error: unknown = null
  try { for await (const e of stream.events()) events.push(e) } catch (e) { error = e }
  const shown = events.filter((e) => e.type === 'part_delta').map((e) => (e as { delta: { content_delta?: string } }).delta.content_delta ?? '').join('')
  return { stream, events, error, shown }
}

/** The committed run of a long answer: live words, the first checkpoint, a held piece, the next checkpoint. */
const firstCheckpoint = (prompt = 1000) => [
  chunk([{ text: 'Thinking hard.', thought: true }], { usage: usage(prompt, 20_000), id: 'resp-1' }),
  chunk([{ text: ' Still thinking.', thought: true }], { usage: usage(prompt, 32_768), token: 'TOKEN-A', id: 'resp-1' }),
]

// -- resume from the last checkpoint -----------------------------------------------------------------------------

test('a drop past a checkpoint: the held part is never shown nor a call; the same body goes again with only the latest token; the answer joins', async () => {
  const route = argon(new Script([])).route
  const history: ModelMessage[] = [
    ...hello(),
    modelResponse([textPart('Reading.'), toolCallPart('read_file', { path: 'a.py' }, 'fc_1')], { provider_name: 'google', provider_details: { route } }),
  ]
  // a signed call in the history: its signature goes back on every request of the answer, unchanged
  ;(history[1] as { parts: Record<string, unknown>[] }).parts[1]!.provider_details = { thought_signature: SIG, call_id: 'fc_1' }
  history.push(modelRequest([{ part_kind: 'tool-return', tool_name: 'read_file', content: 'x = 1', tool_call_id: 'fc_1', timestamp: new Date().toISOString() }]))
  const script = new Script([
    { chunks: [
      ...firstCheckpoint(),
      chunk([{ text: 'HELD-WORDS' }], { usage: usage(1000, 36_000) }),
      chunk([{ functionCall: { id: 'fc_held', name: 'read_file', args: { path: 'held.py' } } }], { usage: usage(1000, 37_000) }),
    ], drop: true },
    { chunks: [chunk([{ text: 'The proof.' }], { finish: 'STOP', usage: usage(1100, 4_000, 1000), id: 'resp-2' })] },
  ])
  const { stream, error, shown } = await drain(argon(script), history, { max_tokens: 65_536 }, params(true))
  expect(error).toBeNull()
  expect(script.bodies).toHaveLength(2)
  const { continuationToken, ...resent } = script.bodies[1]!
  expect(continuationToken).toBe('TOKEN-A')
  expect(resent).toEqual(script.bodies[0]!)                         // contents, tools, config, signatures: the same body
  expect('continuationToken' in script.bodies[0]!).toBe(false)
  expect(JSON.stringify(script.bodies[1])).toContain(SIG)
  expect(shown).not.toContain('HELD-WORDS')
  const response = stream.get()
  expect(response.parts.filter(isToolCall)).toEqual([])             // the held call was never a call
  expect(response.parts.filter(isText).map((p) => p.content).join('')).toBe('The proof.')
  expect(response.finish_reason).toBe('stop')
  expect(response.provider_response_id).toBe('resp-1')
  // usage: the dropped stream up to its checkpoint (32,768, not the held 37,000), the resumed stream's own; the
  // prompt as the context; the second prompt priced through details
  expect(response.usage).toEqual({
    input_tokens: 1000, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 32_768 + 4_000,
    details: { long_decode_streams: 2, long_decode_resumes: 1, long_decode_hops: 0, long_decode_extra_input_tokens: 1100, long_decode_extra_cache_read_tokens: 1000 },
  })
})

test('a resume whose own request fails (a reset before headers, a 503) stays on the same checkpoint, one request each, within the same budget', async () => {
  const script = new Script([
    { chunks: [...firstCheckpoint(), chunk([{ text: 'more', thought: true }], { usage: usage(1000, 37_768), token: 'TOKEN-B' })], drop: true },
    { reset: true },
    { status: 503 },
    { chunks: [chunk([{ text: 'Done.' }], { finish: 'STOP', usage: usage(1000, 100) })] },
  ])
  // postJson's own retries are not taken on a resume: the route's maxRetries 2 still means one request per resume
  const { stream, error } = await drain(argon(script, { maxRetries: 2, maxResumes: 3 }))
  expect(error).toBeNull()
  expect(script.bodies.map((b) => b.continuationToken ?? null)).toEqual([null, 'TOKEN-B', 'TOKEN-B', 'TOKEN-B'])
  expect(stream.get().finish_reason).toBe('stop')
  expect(stream.get().usage?.details).toMatchObject({ long_decode_resumes: 3, long_decode_streams: 2 })
})

test('a spent budget ends the answer: LongDecodeInterrupted (never a transport error to the runner), held part dropped, exactly 1 + maxResumes requests', async () => {
  const script = new Script([
    { chunks: [...firstCheckpoint(), chunk([{ text: 'HELD' }], { usage: usage(1000, 34_000) })], drop: true },
    { chunks: [chunk([{ text: 'HELD-AGAIN' }], { usage: usage(1000, 1_000) })], drop: true },
  ])
  const { stream, error, shown } = await drain(argon(script, { maxResumes: 2 }))
  expect(error).toBeInstanceOf(LongDecodeInterrupted)
  expect(script.bodies).toHaveLength(3)
  expect(script.bodies.slice(1).map((b) => b.continuationToken)).toEqual(['TOKEN-A', 'TOKEN-A'])
  expect(shown).not.toContain('HELD')
  expect(String((error as Error).message)).toMatch(/interrupted after 1 checkpoint, 2 resumes and 0 hops .*the resumes from the last checkpoint \(2\) are spent; last failure: ReadError$/)
  expect(classifyError(error)).not.toBe('transport')
  expect(transientTransportError(error)).toBeNull()
  expect(diagnose(error)).toEqual({ kind: 'disconnect', status_code: null })
  // billed up to the checkpoint only: the held 34,000 and the resumed streams' uncommitted parts are not counted
  expect(stream.usage()?.output_tokens).toBe(32_768)
  // EOF without a finishReason past a checkpoint is a drop as well (no held part flushed on the way out)
  const eof = new Script([{ chunks: [...firstCheckpoint(), chunk([{ text: 'HELD-EOF' }])] }])
  const ended = await drain(argon(eof, { maxResumes: 1 }))
  expect(ended.error).toBeInstanceOf(LongDecodeInterrupted)
  expect(eof.bodies).toHaveLength(2)
  expect(ended.shown).not.toContain('HELD-EOF')
})

test('on the app: a spent budget is one model request record, its error named, and the runner does not send the whole request again', async () => {
  const cfg = new ModelConfig(DEFAULT_MODELS.find((m) => m.id === 'google:gemini-4-argon')! as never)
  const script = new Script([{ chunks: firstCheckpoint(), drop: true }, { chunks: [], drop: true }])
  state = await appState({ config: { ...testConfig([cfg]), default_model: cfg.id }, models: { [cfg.id]: argon(script, { maxResumes: 2 }) } })
  state.runs.transport_backoff_s = [0, 0, 0]
  const { session } = await openSession(state, buggyRepo(), cfg.id)
  const run = await waitDone(state, (await state.runs.start(session, 'prove it')).id)
  expect(run.status).toBe('error')
  expect(script.bodies).toHaveLength(3)                             // 1 + 2 resumes; no runner restart from the start
  expect(script.bodies.filter((b) => !('continuationToken' in b))).toHaveLength(1)
  const records = repo.listModelRequests(state.conn, run.id)
  expect(records).toHaveLength(1)
  expect(records[0]!.status).toBe('error')
  expect(records[0]!.error).toContain('LongDecodeInterrupted')
  expect(records[0]!.output_tokens).toBe(32_768)
})

test('a Stop during the wait before a resume ends it at once: no further request', async () => {
  const script = new Script([{ chunks: firstCheckpoint(), drop: true }, { chunks: [chunk([{ text: 'x' }], { finish: 'STOP' })] }])
  const token = new CancellationToken()
  const model = argon(script, { resumeBackoffMs: [5_000] })
  const started = Date.now()
  setTimeout(() => token.cancel(), 30)
  const { error } = await drain(model, hello(), {}, params(), token.signal)
  expect(classifyError(error)).toBe('cancelled')
  expect(Date.now() - started).toBeLessThan(2_000)
  expect(script.bodies).toHaveLength(1)
})

test('a stream whose finishReason came is whole: a reset after it is no drop, nothing is sent again', async () => {
  const script = new Script([{ chunks: [...firstCheckpoint(), chunk([{ text: 'Q.E.D.' }], { finish: 'STOP', usage: usage(1000, 33_000) })], drop: true }])
  const { stream, error } = await drain(argon(script))
  expect(error).toBeNull()
  expect(script.bodies).toHaveLength(1)
  expect(stream.get().finish_reason).toBe('stop')
  expect(stream.get().usage).toEqual({ input_tokens: 1000, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 33_000 })
})

test('before the first checkpoint nothing resumes: a transport error as before (the runner\'s recovery), no count kept, the streamed figure named', async () => {
  const script = new Script([{ chunks: [chunk([{ text: 'Thinking.', thought: true }], { usage: usage(1000, 32_587) })], drop: true }])
  const { stream, error } = await drain(argon(script, { maxRetries: 2 }))
  expect(error).toBeInstanceOf(TransportError)
  expect((error as TransportError).kind).toBe('ReadError')          // Bun's ECONNRESET, read by its code
  expect(String((error as Error).message)).toContain('32587 output tokens streamed, none committed')
  expect(classifyError(error)).toBe('transport')
  expect(script.bodies).toHaveLength(1)                             // a drop after the headers: one request (postJson retries only before them)
  expect(stream.usage()).toBeNull()                                 // the guide: a drop before 32K costs $0 — not counted as spent
})

// -- what a long decode ends with ----------------------------------------------------------------------------------

test('CONTINUATION: a hop only with an explicit total above one stream\'s cap, from the token its own end carried; hops and resumes counted apart', async () => {
  const hop1 = { chunks: [...firstCheckpoint(), chunk([{ text: 'Half.' }], { finish: 'CONTINUATION', token: 'TOKEN-HOP', usage: usage(1000, 65_536) })] }
  const hop2 = { chunks: [chunk([{ text: ' Whole.' }], { finish: 'STOP', usage: usage(66_536, 10_000, 60_000) })] }
  const script = new Script([hop1, hop2])
  const { stream, error } = await drain(argon(script, { maxResumes: 0 }), hello(), { max_tokens: 262_144 })
  expect(error).toBeNull()
  expect(script.bodies.map((b) => b.continuationToken ?? null)).toEqual([null, 'TOKEN-HOP'])
  for (const body of script.bodies) expect((body.generationConfig as Record<string, unknown>).maxOutputTokens).toBe(262_144)   // the same total on every hop
  expect(stream.get().finish_reason).toBe('stop')
  expect(stream.get().parts.filter(isText).map((p) => p.content).join('')).toBe('Half. Whole.')
  expect(stream.get().usage).toMatchObject({ input_tokens: 1000, output_tokens: 75_536, details: { long_decode_hops: 1, long_decode_resumes: 0, long_decode_extra_input_tokens: 66_536, long_decode_extra_cache_read_tokens: 60_000 } })
  // the default total (one stream's cap): CONTINUATION is an unfinished answer, nothing more is sent
  const capped = new Script([hop1])
  const one = await drain(argon(capped), hello(), {})
  expect(capped.bodies).toHaveLength(1)
  expect(one.stream.get().finish_reason).toBe('length')
  // a CONTINUATION end without its own token never hops on an older checkpoint's (that would say the hop again), and is
  // no answer cut at its limit either (the loop would ask for "the rest" in a whole new request): the long decode ends
  const tokenless = new Script([{ chunks: [...firstCheckpoint(), chunk([{ text: 'Half.' }], { finish: 'CONTINUATION', usage: usage(1000, 65_536) })] }])
  const cut = await drain(argon(tokenless), hello(), { max_tokens: 262_144 })
  expect(tokenless.bodies).toHaveLength(1)
  expect(cut.error).toBeInstanceOf(LongDecodeInterrupted)
  expect(String((cut.error as Error).message)).toContain('CONTINUATION came without its continuationToken')
  expect(classifyError(cut.error)).toBe('other')
  // the hop budget spent: the same, after exactly 1 + maxHops requests
  const looping = new Script([hop1])
  const capHops = await drain(argon(looping, { maxHops: 2 }), hello(), { max_tokens: 262_144 })
  expect(looping.bodies).toHaveLength(3)
  expect(capHops.error).toBeInstanceOf(LongDecodeInterrupted)
  expect(String((capHops.error as Error).message)).toContain('the hop budget (2) is spent')
  // on the app: the loop does not turn it into an output-limit continuation (one record, no request without a token
  // after the first)
  const cfg = new ModelConfig({ ...DEFAULT_MODELS.find((m) => m.id === 'google:gemini-4-argon')!, max_tokens: 262_144 } as never)
  const appScript = new Script([{ chunks: [...firstCheckpoint(), chunk([{ text: 'Half.' }], { finish: 'CONTINUATION', usage: usage(1000, 65_536) })] }])
  state = await appState({ config: { ...testConfig([cfg]), default_model: cfg.id }, models: { [cfg.id]: argon(appScript) } })
  const { session } = await openSession(state, buggyRepo(), cfg.id)
  const run = await waitDone(state, (await state.runs.start(session, 'prove it')).id)
  expect(run.status).toBe('error')
  expect(appScript.bodies).toHaveLength(1)
})

test('MAX_TOKENS with a token is the end: no continuation, no larger total', async () => {
  const script = new Script([{ chunks: [...firstCheckpoint(), chunk([{ text: 'cut' }], { finish: 'MAX_TOKENS', token: 'TOKEN-MAX', usage: usage(1000, 65_536) })] }])
  const { stream } = await drain(argon(script), hello(), { max_tokens: 262_144 })
  expect(script.bodies).toHaveLength(1)
  expect(stream.get().finish_reason).toBe('length')
})

test('a filter or the provider\'s failure past a checkpoint: held words shown, a held call never; a passing in-stream error resumes, any other ends', async () => {
  const held = chunk([{ text: 'held words' }, { functionCall: { id: 'fc_x', name: 'read_file', args: { path: 'x' } } }], { usage: usage(1000, 34_000) })
  for (const reason of ['SAFETY', 'MALFORMED_FUNCTION_CALL']) {
    const script = new Script([{ chunks: [...firstCheckpoint(), held, chunk([], { finish: reason, usage: usage(1000, 34_100) })] }])
    const { stream, shown } = await drain(argon(script), hello(), {}, params(true))
    expect(shown).toContain('held words')
    expect(stream.get().parts.filter(isToolCall)).toEqual([])
    expect(stream.get().finish_reason).toBe(reason === 'SAFETY' ? 'content_filter' : 'error')
  }
  // a normal STOP commits the held call (it is the answer's)
  const stop = new Script([{ chunks: [...firstCheckpoint(), held, chunk([], { finish: 'STOP', usage: usage(1000, 34_100) })] }])
  expect((await drain(argon(stop), hello(), {}, params(true))).stream.get().parts.filter(isToolCall)).toHaveLength(1)
  // an in-stream error: INVALID_ARGUMENT ends the long decode (named, the held call not committed); UNAVAILABLE resumes
  const bad = new Script([{ chunks: [...firstCheckpoint(), held, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'no' } }] }])
  const ended = await drain(argon(bad), hello(), {}, params(true))
  expect(ended.error).toBeInstanceOf(LongDecodeInterrupted)
  expect((ended.error as LongDecodeInterrupted).detail.failure).toEqual({ name: 'ModelAPIError', transport_kind: null, status_code: 400, provider_status: 'INVALID_ARGUMENT', reason: null })
  expect(diagnose(ended.error)).toEqual({ kind: 'bad_request', status_code: 400 })
  expect(classifyError(ended.error)).toBe('other')
  expect(ended.stream.get().parts.filter(isToolCall)).toEqual([])
  expect(bad.bodies).toHaveLength(1)
  const busy = new Script([
    { chunks: [...firstCheckpoint(), held, { error: { code: 503, status: 'UNAVAILABLE', message: 'overloaded' } }] },
    { chunks: [chunk([{ text: 'ok' }], { finish: 'STOP', usage: usage(1000, 10) })] },
  ])
  const resumed = await drain(argon(busy), hello(), {}, params(true))
  expect(resumed.error).toBeNull()
  expect(busy.bodies.map((b) => b.continuationToken ?? null)).toEqual([null, 'TOKEN-A'])
})

test('every model but Argon is as it was: a continuationToken in a chunk is not a checkpoint, a drop is one request and a transport error', async () => {
  const script = new Script([{ chunks: firstCheckpoint(), drop: true }])
  const flash = new GoogleModel('gemini-3.6-flash', { apiKey: 'k', baseUrl: 'http://gemini.mock', maxRetries: 0, fetchImpl: script.fetch })
  const stream = await flash.requestStream(hello(), {}, params())
  let error: unknown = null
  try { for await (const _ of stream.events()) { /* drain */ } } catch (e) { error = e }
  expect(error).toBeInstanceOf(TransportError)
  expect(script.bodies).toHaveLength(1)
  expect(stream.usage()).toEqual({ input_tokens: 1000, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 32_768 })
  expect('timeout' in script.inits[0]!).toBe(false)                // Bun's socket default untouched
})

// -- usage and price ---------------------------------------------------------------------------------------------

test('the meter prices the later streams\' prompts (details) while the record\'s input stays the context\'s', async () => {
  expect(joinUsage([{ input_tokens: 5, output_tokens: 7, cache_read_tokens: 0, cache_write_tokens: 0 }])).toEqual({ input_tokens: 5, output_tokens: 7, cache_read_tokens: 0, cache_write_tokens: 0 })
  const pricing = { input_per_mtok: 2, output_per_mtok: 10, cache_read_per_mtok: 0.1, cache_write_per_mtok: null, cache_write_1h_per_mtok: null, source: 'test list', version: 't' }
  const cfg = new ModelConfig({ ...DEFAULT_MODELS.find((m) => m.id === 'google:gemini-4-argon')!, pricing } as never)
  const script = new Script([
    { chunks: firstCheckpoint(), drop: true },
    { chunks: [chunk([{ text: 'Done.' }], { finish: 'STOP', usage: usage(1100, 4_000, 1000) })] },
  ])
  const records: ModelRequestRecord[] = []
  const meter = new UsageMeter(argon(script), cfg, 'run_x', (r) => records.push(r), () => {})
  const stream = await meter.requestStream(hello(), {}, params())
  for await (const _ of stream.events()) { /* drain */ }
  expect(records).toHaveLength(1)
  expect(records[0]!).toMatchObject({ input_tokens: 1000, output_tokens: 36_768, status: 'ok' })
  const [expected] = estimateCost({ input_tokens: 2100, cache_read_tokens: 1000, output_tokens: 36_768, cache_write_tokens: 0 }, pricing)
  expect(records[0]!.cost_usd).toBeCloseTo(expected!, 9)
})

// -- transport: Bun's socket deadline and its reset ----------------------------------------------------------------

test('Bun\'s socket idle deadline: off on Argon (the 20-minute timers are the client\'s; a route\'s own value kept), never passed for another model', async () => {
  const script = new Script([{ chunks: [chunk([{ text: 'hi' }], { finish: 'STOP', usage: usage(1, 1) })] }])
  const model = argon(script)
  await drain(model)
  expect(script.inits[0]!.timeout).toBe(false)
  expect(model.http.timeoutMs).toBe(20 * 60_000)
  expect(model.http.idleTimeoutMs).toBe(20 * 60_000)
  await drain(argon(script, { timeoutMs: 1_000, idleTimeoutMs: 2_000 }))
  expect(script.inits[1]!.timeout).toBe(false)
  await drain(argon(script, { socketIdleTimeoutMs: 90_000 }))
  expect(script.inits[2]!.timeout).toBe(90_000)
  const flash = new GoogleModel('gemini-3.6-flash', { apiKey: 'k', baseUrl: 'http://gemini.mock', maxRetries: 0, fetchImpl: script.fetch })
  await (await flash.requestStream(hello(), {}, params())).events().next()
  expect('timeout' in script.inits[3]!).toBe(false)
})

test('Bun\'s reset (TypeError, code ECONNRESET, "socket connection was closed") is a ReadError, before the headers (retried by postJson) and after', async () => {
  const script = new Script([{ reset: true }])
  const error = await postJson('http://gemini.mock/x', {}, {}, 'm', { fetchImpl: script.fetch, maxRetries: 2 }).catch((e) => e)
  expect(error).toBeInstanceOf(TransportError)
  expect((error as TransportError).kind).toBe('ReadError')
  expect(script.bodies).toHaveLength(3)                             // a first request's own retries: 1 + maxRetries before any header
  const plain = Object.assign(new Error('unable to connect'), { code: 'ECONNREFUSED' })
  const refused = await postJson('http://gemini.mock/x', {}, {}, 'm', { fetchImpl: async () => { throw plain }, maxRetries: 0 }).catch((e) => e)
  expect((refused as TransportError).kind).toBe('ConnectError')
})

test('Argon end states: a filtered or failed answer keeps no call (in its own chunk, before a checkpoint, committed earlier)', async () => {
  const call = { functionCall: { id: 'fc_y', name: 'read_file', args: { path: 'y' } } }
  // the call in the very chunk that ends filtered, no checkpoint at all
  const same = new Script([{ chunks: [chunk([{ text: 'words ' }, call], { finish: 'SAFETY', usage: usage(10, 5) })] }])
  const one = await drain(argon(same), hello(), {}, params(true))
  expect(one.stream.get().parts.filter(isToolCall)).toEqual([])
  expect(one.stream.get().finish_reason).toBe('content_filter')
  // a call shown before the first checkpoint, the answer then ending as the provider's failure
  const early = new Script([{ chunks: [chunk([call], { usage: usage(10, 5) }), ...firstCheckpoint(), chunk([], { finish: 'MALFORMED_FUNCTION_CALL', usage: usage(10, 33_000) })] }])
  const two = await drain(argon(early), hello(), {}, params(true))
  expect(two.events.some((e) => e.type === 'part_end' && e.part.part_kind === 'tool-call')).toBe(true)   // it was shown as it came
  expect(two.stream.get().parts.filter(isToolCall)).toEqual([])                                           // but is no call to run
  expect(two.stream.get().finish_reason).toBe('error')
})

test('Argon end states: a blocked prompt past a checkpoint is the filter\'s end (no resume); after a finishReason only a count is taken', async () => {
  const blocked = { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: usage(1000, 33_000), modelVersion: 'gemini-4-argon' }
  const script = new Script([{ chunks: [...firstCheckpoint(), chunk([{ text: 'HELD' }]), blocked] }])
  const { stream, error } = await drain(argon(script))
  expect(error).toBeNull()
  expect(script.bodies).toHaveLength(1)
  expect(stream.get().finish_reason).toBe('content_filter')
  const late = new Script([{ chunks: [
    chunk([{ text: 'Done.' }], { finish: 'STOP', usage: usage(10, 5) }),
    chunk([{ text: ' LATE WORDS' }, { functionCall: { id: 'fc_late', name: 'read_file', args: {} } }], { usage: usage(10, 6) }),
  ] }])
  const after = await drain(argon(late), hello(), {}, params(true))
  expect(after.shown).not.toContain('LATE')
  expect(after.stream.get().parts.filter(isToolCall)).toEqual([])
  expect(after.stream.get().usage?.output_tokens).toBe(6)
})

test('a data frame that is no JSON: past a checkpoint a drop (resumed, its held part gone); before one a broken stream, never a seemingly whole answer', async () => {
  const enc = new TextEncoder()
  const raw = (frames: string[], close = true) => async () => new Response(new ReadableStream<Uint8Array>({ start(c) { for (const f of frames) c.enqueue(enc.encode(f)); if (close) c.close() } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const bodies: Record<string, unknown>[] = []
  const answers = [
    raw([...firstCheckpoint().map(sse), sse(chunk([{ text: 'HELD' }])), 'data: {"candidates": [ {"content": \r\n\r\n', sse(chunk([{ text: ' tail' }], { finish: 'STOP' }))]),
    raw([sse(chunk([{ text: 'Resumed.' }], { finish: 'STOP', usage: usage(1000, 10) }))]),
  ]
  const fetchImpl = async (_u: string | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return answers[bodies.length - 1]!() }
  const { stream, error, shown } = await drain(argon(new Script([]), { fetchImpl }))
  expect(error).toBeNull()
  expect(bodies.map((b) => b.continuationToken ?? null)).toEqual([null, 'TOKEN-A'])
  expect(shown).not.toContain('HELD')
  expect(shown).not.toContain('tail')
  expect(stream.get().parts.filter(isText).map((p) => p.content).join('')).toBe('Resumed.')
  const before = raw([sse(chunk([{ text: 'a' }])), 'data: {not json\r\n\r\n', sse(chunk([{ text: 'b' }], { finish: 'STOP' }))])
  const broken = await drain(argon(new Script([]), { fetchImpl: before }))
  expect(broken.error).toBeInstanceOf(ModelAPIError)
  expect(classifyError(broken.error)).toBe('transport')             // the runner's recovery, as for any broken stream before a checkpoint
})

test('a resume refused (a key, a request too large): the long decode ends named — no runner recovery from the start, the diagnosis the refusal\'s', async () => {
  for (const [status, body, kind] of [
    [401, { error: { code: 401, message: 'API key not valid', status: 'UNAUTHENTICATED' } }, 'auth'],
    [400, { error: { code: 400, message: 'The input token count exceeds the maximum number of tokens allowed (context)', status: 'INVALID_ARGUMENT' } }, 'context_overflow'],
  ] as const) {
    const fetches: number[] = []
    const script = new Script([{ chunks: firstCheckpoint(), drop: true }])
    const fetchImpl = async (u: string | URL, init?: RequestInit) => { fetches.push(1); return fetches.length === 1 ? script.fetch(u, init) : new Response(JSON.stringify(body), { status }) }
    const { error } = await drain(argon(script, { fetchImpl, maxResumes: 5 }))
    expect(fetches).toHaveLength(2)                                  // refused once: not tried again
    expect(error).toBeInstanceOf(LongDecodeInterrupted)
    expect(classifyError(error)).toBe('other')                       // neither the runner's transport, outage nor context recovery
    expect(diagnose(error).kind).toBe(kind)
    expect(diagnose(error).status_code).toBe(status)
  }
})

// -- integration closing checks (stale end, redaction, no restart from the start, Bun's real socket) ----------------

test('a CONTINUATION\'s end is no end of the next hop: a hop that closes cleanly with no finishReason and no checkpoint is a drop, never a whole answer', async () => {
  const hop1 = { chunks: [...firstCheckpoint(), chunk([{ text: 'Half.' }], { finish: 'CONTINUATION', token: 'TOKEN-HOP', usage: usage(1000, 65_536) })] }
  // the next hop: words, no checkpoint, no finishReason, a clean close
  const silentEnd = { chunks: [chunk([{ text: ' HOP-WORDS' }], { usage: usage(66_536, 2_000) })] }
  const none = new Script([hop1, silentEnd])
  const cut = await drain(argon(none, { maxResumes: 0 }), hello(), { max_tokens: 262_144 })
  expect(none.bodies).toHaveLength(2)
  expect(cut.error).toBeInstanceOf(LongDecodeInterrupted)          // not the first hop's 'length' taken as the answer's end
  expect(cut.shown).not.toContain('HOP-WORDS')
  expect(cut.stream.get().finish_reason).toBeNull()
  expect(cut.stream.usage()?.output_tokens).toBe(65_536)           // the first hop's own count; the uncommitted hop none
  // with one resume: the same hop token again, and the answer ends on the hop's own STOP
  const again = new Script([hop1, silentEnd, { chunks: [chunk([{ text: ' Whole.' }], { finish: 'STOP', usage: usage(66_536, 3_000) })] }])
  const whole = await drain(argon(again, { maxResumes: 1 }), hello(), { max_tokens: 262_144 })
  expect(whole.error).toBeNull()
  expect(again.bodies.map((b) => b.continuationToken ?? null)).toEqual([null, 'TOKEN-HOP', 'TOKEN-HOP'])
  expect(whole.stream.get().finish_reason).toBe('stop')
  expect(whole.stream.get().parts.filter(isText).map((p) => p.content).join('')).toBe('Half. Whole.')
})

test('a long token or signature a failure quotes back never reaches the error, the record or the run\'s events', async () => {
  const bigToken = 'TKN' + Buffer.from(new Uint8Array(110_000).map((_, i) => (i * 7919) % 251)).toString('base64')   // ~150k chars
  const marker = bigToken.slice(0, 48)
  // a resume refused by a 400 that quotes the token and a signature
  const quoted = { error: { code: 400, status: 'INVALID_ARGUMENT', message: `Invalid continuation_token ${bigToken.slice(0, 5_000)} near ${SIG}${SIG}` } }
  const fetches: number[] = []
  const first = new Script([{ chunks: [...firstCheckpoint().slice(0, 1), chunk([{ text: 'x', thought: true }], { usage: usage(1000, 32_768), token: bigToken })], drop: true }])
  const fetchImpl = async (u: string | URL, init?: RequestInit) => { fetches.push(1); return fetches.length === 1 ? first.fetch(u, init) : new Response(JSON.stringify(quoted), { status: 400 }) }
  const { error } = await drain(argon(first, { fetchImpl }))
  expect(error).toBeInstanceOf(LongDecodeInterrupted)
  const message = String((error as Error).message)
  expect(message).not.toContain(marker)
  expect(message).not.toContain(SIG)
  expect(message).not.toContain('Invalid continuation_token')       // facts only: no provider words at all
  expect(message).toMatch(/a resume was refused; last failure: ModelHTTPError \(status 400, INVALID_ARGUMENT\)$/)
  // the error as a whole, serialized: facts only — no raw error object, no provider body, no token, no signature
  const serialized = JSON.stringify(error) + JSON.stringify((error as LongDecodeInterrupted).detail)
  expect(serialized).not.toContain(marker)
  expect(serialized).not.toContain(SIG)
  expect(serialized).not.toContain('Invalid continuation_token TKN')
  expect((error as LongDecodeInterrupted).detail.failure).toEqual({ name: 'ModelHTTPError', transport_kind: null, status_code: 400, provider_status: 'INVALID_ARGUMENT', reason: null })
  expect('underlying' in (error as LongDecodeInterrupted).detail).toBe(false)
  // on the app: the record's error and the events hold neither
  const cfg = new ModelConfig(DEFAULT_MODELS.find((m) => m.id === 'google:gemini-4-argon')! as never)
  const fetches2: number[] = []
  const script = new Script([{ chunks: [...firstCheckpoint().slice(0, 1), chunk([{ text: 'x', thought: true }], { usage: usage(1000, 32_768), token: bigToken })], drop: true }])
  const appFetch = async (u: string | URL, init?: RequestInit) => { fetches2.push(1); return fetches2.length === 1 ? script.fetch(u, init) : new Response(JSON.stringify(quoted), { status: 400 }) }
  state = await appState({ config: { ...testConfig([cfg]), default_model: cfg.id }, models: { [cfg.id]: argon(script, { fetchImpl: appFetch }) } })
  state.runs.transport_backoff_s = [0, 0, 0]
  const { session } = await openSession(state, buggyRepo(), cfg.id)
  const run = await waitDone(state, (await state.runs.start(session, 'prove it')).id)
  expect(run.status).toBe('error')
  expect(fetches2).toHaveLength(2)
  const recorded = JSON.stringify(repo.listModelRequests(state.conn, run.id)) + JSON.stringify(repo.listEvents(state.conn, run.id))
  expect(recorded).not.toContain(marker)
  expect(recorded).not.toContain(SIG)
})

test('past a checkpoint, a passing provider error that keeps coming (its words the runner would read as transient) ends with the resumes spent: no restart from the start', async () => {
  for (const words of ['overloaded', 'connection reset by peer', 'stream ended unexpectedly']) {
    const busy = new Script([
      { chunks: [...firstCheckpoint(), { error: { code: 503, status: 'UNAVAILABLE', message: words } }] },
      { chunks: [{ error: { code: 503, status: 'UNAVAILABLE', message: words } }] },
    ])
    const { error } = await drain(argon(busy, { maxResumes: 2 }))
    expect(error).toBeInstanceOf(LongDecodeInterrupted)
    expect(busy.bodies).toHaveLength(3)
    expect(classifyError(error)).toBe('other')
    expect(transientTransportError(error)).toBeNull()
  }
  // on the app: one record, 1 + maxResumes requests, every later one with the token, no run_continued transport_error
  const cfg = new ModelConfig(DEFAULT_MODELS.find((m) => m.id === 'google:gemini-4-argon')! as never)
  const script = new Script([
    { chunks: [...firstCheckpoint(), { error: { code: 503, status: 'UNAVAILABLE', message: 'overloaded' } }] },
    { status: 503 },
  ])
  state = await appState({ config: { ...testConfig([cfg]), default_model: cfg.id }, models: { [cfg.id]: argon(script, { maxResumes: 2, maxRetries: 2 }) } })
  state.runs.transport_backoff_s = [0, 0, 0]
  state.runs.outage_backoff_s = [0, 0, 0]
  const { session } = await openSession(state, buggyRepo(), cfg.id)
  const run = await waitDone(state, (await state.runs.start(session, 'prove it')).id)
  expect(run.status).toBe('error')
  expect(script.bodies).toHaveLength(3)                             // the resumes' 503s: one request each (postJson's retries off)
  expect(script.bodies.filter((b) => !('continuationToken' in b))).toHaveLength(1)
  expect(repo.listModelRequests(state.conn, run.id)).toHaveLength(1)
  expect(repo.listEvents(state.conn, run.id).filter((e) => e.event === 'run_continued')).toEqual([])
})

test('on Bun\'s own socket (loopback, a child with BUN_CONFIG_HTTP_IDLE_TIMEOUT=3): Argon outlives a 6 s silence, another model does not, a Stop still ends Argon at once', async () => {
  const enc = new TextEncoder()
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0, idleTimeout: 0,
    fetch: () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(sse(chunk([{ text: 'Thinking.', thought: true }], { usage: usage(5, 1) }))))
          timer = setTimeout(() => {
            try { c.enqueue(enc.encode(sse(chunk([{ text: 'Done.' }], { finish: 'STOP', usage: usage(5, 2) })))); c.close() } catch { /* the client left */ }
          }, 6_000)
        },
        cancel() { clearTimeout(timer) },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const src = new URL('../src/', import.meta.url).pathname
    const code = `
      import { GoogleModel } from '${src}llm/providers/google.ts'
      import { modelRequest, userPrompt } from '${src}llm/messages.ts'
      const base = process.env.LOOP_BASE
      const p = { function_tools: [], allow_text_output: true, thinking: 'high' }
      async function run(model, signal) {
        const t = Date.now()
        try {
          const s = await model.requestStream([modelRequest([userPrompt('x')])], {}, p, signal ? { signal } : undefined)
          for await (const _ of s.events()) {}
          return { ok: true, finish: s.get().finish_reason, ms: Date.now() - t }
        } catch (e) { return { ok: false, name: e?.name, kind: e?.kind ?? null, ms: Date.now() - t } }
      }
      const out = {}
      out.argon = await run(new GoogleModel('gemini-4-argon', { apiKey: 'k', baseUrl: base, maxRetries: 0 }))
      out.other = await run(new GoogleModel('gemini-3.6-flash', { apiKey: 'k', baseUrl: base, maxRetries: 0 }))
      const stop = new AbortController()
      setTimeout(() => stop.abort(new Error('stopped')), 1_500)
      out.stop = await run(new GoogleModel('gemini-4-argon', { apiKey: 'k', baseUrl: base, maxRetries: 0 }), stop.signal)
      console.log(JSON.stringify(out))
    `
    const child = Bun.spawn([process.execPath, '-e', code], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp', BUN_CONFIG_HTTP_IDLE_TIMEOUT: '3', LOOP_BASE: `http://127.0.0.1:${server.port}` },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ exit, err: exit === 0 ? '' : err.slice(0, 400) }).toEqual({ exit: 0, err: '' })
    const result = JSON.parse(out.trim().split('\n').pop()!)
    expect(result.argon).toMatchObject({ ok: true, finish: 'stop' })           // timeout: false — Bun's 3 s idle did not cut it
    expect(result.argon.ms).toBeGreaterThanOrEqual(5_900)
    expect(result.other.ok).toBe(false)                                         // the control: the env's 3 s idle is in force
    expect(result.other.kind).toBe('TimeoutException')
    expect(result.other.ms).toBeLessThan(5_900)
    expect(result.stop.ok).toBe(false)                                          // a Stop is no timeout and ends it at once
    expect(result.stop.ms).toBeLessThan(3_000)
  } finally {
    server.stop(true)
  }
}, 40_000)

test('a stream left early on Argon (a frame that is no JSON, the provider\'s passing error) has its body cancelled before the resume: the old request does not go on', async () => {
  const enc = new TextEncoder()
  for (const bad of ['data: {"candidates": [ {"content": \r\n\r\n', sse({ error: { code: 503, status: 'UNAVAILABLE', message: 'overloaded' } })]) {
    let cancelled = 0
    let served = 0
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = async (_u: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      if (bodies.length > 1) return new Response(sse(chunk([{ text: 'Resumed.' }], { finish: 'STOP', usage: usage(1000, 10) })), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      const frames = [...firstCheckpoint().map(sse), bad]
      // after the bad frame the old stream stays open (more would come): only a cancel ends it
      return new Response(new ReadableStream<Uint8Array>({
        pull(c) { if (served < frames.length) c.enqueue(enc.encode(frames[served++]!)); else return new Promise(() => {}) },
        cancel() { cancelled += 1 },
      }, { highWaterMark: 0 }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const { stream, error } = await drain(argon(new Script([]), { fetchImpl }))
    expect(error).toBeNull()
    expect(bodies.map((b) => b.continuationToken ?? null)).toEqual([null, 'TOKEN-A'])
    expect(cancelled).toBe(1)
    expect(stream.get().finish_reason).toBe('stop')
  }
  // every other model is as it was: its stream is not touched by this (an in-stream error still throws as before)
  let otherCancelled = 0
  const flashFetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode(sse({ error: { code: 503, status: 'UNAVAILABLE', message: 'overloaded' } }))) },
    cancel() { otherCancelled += 1 },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const flash = new GoogleModel('gemini-3.6-flash', { apiKey: 'k', baseUrl: 'http://gemini.mock', maxRetries: 0, fetchImpl: flashFetch })
  const s = await flash.requestStream(hello(), {}, params())
  await expect((async () => { for await (const _ of s.events()) { /* drain */ } })()).rejects.toThrow('UNAVAILABLE')
  expect(otherCancelled).toBe(0)
})

test('after the answer\'s end only a count is taken: a late error frame after STOP, MAX_TOKENS or CONTINUATION takes nothing away', async () => {
  const late = { error: { code: 503, status: 'UNAVAILABLE', message: 'late' } }
  const stop = new Script([{ chunks: [...firstCheckpoint(), chunk([{ text: 'Q.E.D.' }], { finish: 'STOP', usage: usage(1000, 33_000) }), late] }])
  const a = await drain(argon(stop))
  expect(a.error).toBeNull()
  expect(stop.bodies).toHaveLength(1)
  expect(a.stream.get().finish_reason).toBe('stop')
  expect(a.stream.get().parts.filter(isText).map((p) => p.content).join('')).toBe('Q.E.D.')
  const max = new Script([{ chunks: [...firstCheckpoint(), chunk([{ text: 'cut' }], { finish: 'MAX_TOKENS', usage: usage(1000, 65_536) }), late] }])
  const b = await drain(argon(max))
  expect(b.error).toBeNull()
  expect(max.bodies).toHaveLength(1)
  expect(b.stream.get().finish_reason).toBe('length')
  const hop = new Script([
    { chunks: [...firstCheckpoint(), chunk([{ text: 'Half.' }], { finish: 'CONTINUATION', token: 'TOKEN-HOP', usage: usage(1000, 65_536) }), late] },
    { chunks: [chunk([{ text: ' Whole.' }], { finish: 'STOP', usage: usage(66_536, 100) })] },
  ])
  const c = await drain(argon(hop), hello(), { max_tokens: 262_144 })
  expect(c.error).toBeNull()
  expect(hop.bodies.map((x) => x.continuationToken ?? null)).toEqual([null, 'TOKEN-HOP'])
  expect(c.stream.get().finish_reason).toBe('stop')
  expect(c.stream.get().provider_details).toMatchObject({ long_decode: { checkpoints: 1, hops: 1, resumes: 0 } })
})

test('on the app: a long decode past its checkpoints that ends at its total (MAX_TOKENS with a few words) or without words is not asked again by the loop; below a checkpoint the loop is as it was', async () => {
  const cfg = new ModelConfig(DEFAULT_MODELS.find((m) => m.id === 'google:gemini-4-argon')! as never)
  const runOnce = async (script: Script) => {
    state = await appState({ config: { ...testConfig([cfg]), default_model: cfg.id }, models: { [cfg.id]: argon(script) } })
    state.runs.transport_backoff_s = [0, 0, 0]
    const { session } = await openSession(state, buggyRepo(), cfg.id)
    const run = await waitDone(state, (await state.runs.start(session, 'prove it')).id)
    const continued = repo.listEvents(state.conn, run.id).filter((e) => e.event === 'run_continued' || (e.event === 'continued'))
    const records = repo.listModelRequests(state.conn, run.id)
    await closeState(state); state = null
    return { run, continued, records }
  }
  // the user's case: 65,536 nearly all thinking, three words of answer, MAX_TOKENS — one request, no output-limit continuation
  const capped = new Script([{ chunks: [...firstCheckpoint(), chunk([{ text: 'So x' }], { finish: 'MAX_TOKENS', usage: usage(1000, 65_536) })] }])
  const one = await runOnce(capped)
  expect(capped.bodies).toHaveLength(1)
  expect(one.records).toHaveLength(1)
  expect(one.run.status).not.toBe('running')
  // past a checkpoint, STOP without words, and the provider's failure: no retry either
  const empty = new Script([{ chunks: [...firstCheckpoint(), chunk([], { finish: 'STOP', usage: usage(1000, 40_000) })] }])
  await runOnce(empty)
  expect(empty.bodies).toHaveLength(1)
  const failed = new Script([{ chunks: [...firstCheckpoint(), chunk([{ text: 'words' }], { finish: 'MALFORMED_FUNCTION_CALL', usage: usage(1000, 40_000) })] }])
  await runOnce(failed)
  expect(failed.bodies).toHaveLength(1)
  // control: no checkpoint (a short answer cut at its limit): the loop's output-limit continuation as before
  const short = new Script([{ chunks: [chunk([{ text: 'Partial' }], { finish: 'MAX_TOKENS', usage: usage(1000, 8_000) })] }])
  await runOnce(short)
  expect(short.bodies.length).toBeGreaterThan(1)
  expect(short.bodies.every((b) => !('continuationToken' in b))).toBe(true)
})
