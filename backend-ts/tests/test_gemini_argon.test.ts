/** Gemini 4 Argon (`gemini-4-argon`) on the Gemini API's streamGenerateContent, offline: every provider answer here is
 *  a scripted fetch (the suite's network guard stays on; no key, no cloud). What is asserted is the wire as the official
 *  pages describe it (docs/gemini-4-argon.md, checked 2026-10-14, the model published 2026-10-13) — none of it was
 *  probed online. The route and catalogue; the three thinking levels, the default and the nearest-level mapping with
 *  what the run records; the output cap and the timeouts; thought signatures on the part boundary they came on (text,
 *  empty text, thought summary, call) surviving the record's JSON; the provider's own call ids paired with their
 *  results, retries and interrupted-call notes — also when the loop renamed the local id (`dup` → `dup_2`) — a harness
 *  id never sent as one; images a tool returned after the results; PDF / video MIME; usage with the cached share and
 *  thinking counted once; CONTINUATION as an unfinished answer; the newer FinishReasons (provider failures an error,
 *  filters a filter) and a blocked prompt taken once as a filter; max_tokens above one stream's cap refused on the
 *  route; and Gemini 3.6 left as it was. */

import { afterEach, expect, test } from 'bun:test'
import { candidateKind, z } from '@oasis-code/contract'
import * as keys from '../src/auth/keys.ts'
import { closeDanglingToolCalls, modelSettings } from '../src/agent/runner.ts'
import { Agent } from '../src/agent/loop.ts'
import { DEFAULT_MODELS, GEMINI_ARGON_MAX_TOKENS, ModelConfig, ModelConfigSchema, type HarnessConfig } from '../src/config.ts'
import { catalogEntries } from '../src/llm/catalog.ts'
import { portableHistory } from '../src/llm/handoff.ts'
import {
  dumpJson, isText, isThinking, isToolCall, loadJson, modelRequest, modelResponse, retryPrompt, textPart, thinkingPart, toolCallPart, toolReturn, userPrompt,
  type ModelMessage, type ModelResponse,
} from '../src/llm/messages.ts'
import type { ModelRequestParameters } from '../src/llm/model.ts'
import { buildModel, CredentialUnavailable, GoogleModel } from '../src/llm/providers.ts'
import { ARGON_STREAM_OUTPUT_CAP, ARGON_TIMEOUT_MS, argonThinkingLevel, geminiProfile, takesFunctionResponseImages } from '../src/llm/providers/google.ts'
import { estimateCost } from '../src/llm/usage.ts'
import { toolSchemaRows, visibleToolNames } from '../src/agent/tools/registry.ts'
import { cleanSchema } from '../src/llm/http.ts'
import { appState, buggyRepo, closeState, openSession, testConfig, waitDone, type AppState } from './harness.ts'
import { privateAuthDir, Route, runAgent, zodTool } from './helpers.ts'
import { geminiChunk, geminiStream, geminiUsage } from './providers_fixtures.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

const ARGON_ID = 'google:gemini-4-argon'
const argonRaw = () => DEFAULT_MODELS.find((m) => m.id === ARGON_ID)!
const argonCfg = () => new ModelConfig(argonRaw() as never)
const argon = (route?: Route, extra: Record<string, unknown> = {}) =>
  new GoogleModel('gemini-4-argon', { apiKey: 'test-key-argon', baseUrl: 'http://gemini.mock', maxRetries: 0, fetchImpl: route?.fetch, ...extra })
const params = (thinking: ModelRequestParameters['thinking'] = null): ModelRequestParameters => ({ function_tools: [], allow_text_output: true, thinking })
const hello = (): ModelMessage[] => [modelRequest([userPrompt('hi')], 'be brief')]
const gen = (body: Record<string, unknown>) => body.generationConfig as Record<string, unknown>
const contentsOf = (body: Record<string, unknown>) => body.contents as { role: string; parts: Record<string, unknown>[] }[]
const SIG_T = Buffer.from('argon-signature-thought').toString('base64')
const SIG_X = Buffer.from('argon-signature-text').toString('base64')
const SIG_A = Buffer.from('argon-signature-call').toString('base64')
const SIG_E = Buffer.from('argon-signature-empty-text').toString('base64')

function chunk(parts: Record<string, unknown>[], opts: { finish?: string; usage?: Record<string, number>; continuationToken?: string } = {}): Record<string, unknown> {
  const c = geminiChunk(parts, opts)
  ;(c as { modelVersion: string }).modelVersion = 'gemini-4-argon'
  if (opts.continuationToken) ((c.candidates as Record<string, unknown>[])[0]!).continuationToken = opts.continuationToken
  return c
}

function agent(): Agent<null> {
  return new Agent<null>({
    instructions: 'You are an oasis-code agent.',
    tools: [zodTool<null, z.ZodType>('read_file', 'Read a file', z.object({ path: z.string() }), (_d, args) => ({ status: 'ok', path: (args as { path: string }).path, text: 'def add(a, b):\n    return a - b\n' }))],
  })
}

// -- the route ---------------------------------------------------------------------------------------------------

test('the default Argon route: the exact model id, the unified window, the stream cap, three levels, the key path, the paid price list', () => {
  const cfg = argonCfg()
  expect(cfg).toMatchObject({ provider: 'google', model: 'gemini-4-argon', auth: 'api_key', api: 'responses', context_window: 1_048_576, max_tokens: 262_144, base_url: null })
  expect(cfg.pricing).toMatchObject({ input_per_mtok: 2, output_per_mtok: 10, cache_read_per_mtok: 0.1, version: '2026-10',
    next: { from: '2026-12-01', input_per_mtok: 4, output_per_mtok: 20, cache_read_per_mtok: 0.2, version: '2026-12' } })
  expect(cfg.max_tokens).toBe(262_144)
  expect(cfg.key_env).toBe('GEMINI_API_KEY')
  expect(cfg.reasoning_efforts).toEqual(['low', 'medium', 'high'])
  expect(cfg.capabilities).toEqual({ images: true, pdf: true, video: ['video/mp4', 'video/webm', 'video/quicktime'] })
  expect('audio' in cfg.capabilities).toBe(false)                                      // the model takes audio; this app has no audio path
  expect(candidateKind('voice.mp3', 'audio/mpeg')).toBeNull()
  for (const text of [cfg.window_source, cfg.capability_source]) {
    expect(text).toContain('checked 2026-10-14')
    expect(text).toContain('not probed online')
    expect(text).not.toContain('verified')
  }
  expect(cfg.capability_source).toContain('https://ai.google.dev/gemini-api/docs/models/gemini-4-argon')
  // images, PDF and video each name the Argon model page, the day it was read and that nothing was probed; nothing
  // about the machine the build ran on
  expect(cfg.capability_source).toContain('images: official Argon model page https://ai.google.dev/gemini-api/docs/models/gemini-4-argon, checked 2026-10-14')
  const pdfVideo = cfg.capability_source.slice(cfg.capability_source.indexOf('PDF/video:'), cfg.capability_source.indexOf('; audio'))
  expect(pdfVideo).toStartWith('PDF/video: official declaration https://ai.google.dev/gemini-api/docs/models/gemini-4-argon;')
  expect(pdfVideo).toContain('checked 2026-10-14')
  expect(pdfVideo).toEndWith('not probed online')
  expect(cfg.capability_source).not.toContain("the model family's documented image input")
  for (const text of [cfg.window_source, cfg.capability_source]) expect(text).not.toMatch(/no Gemini key|key here|this machine/i)
  // Argon is the one default Google route
  expect(DEFAULT_MODELS.filter((m) => m.provider === 'google').map((m) => m.id)).toEqual([ARGON_ID])
  // only the exact documented id has the Argon profile
  expect(geminiProfile('gemini-4-argon')).not.toBeNull()
  for (const id of ['gemini-4-argon-preview', 'models/gemini-4-argon', 'gemini-4-flash', 'gemini-3.6-flash', 'gemini-4']) expect(geminiProfile(id)).toBeNull()
})

test('the catalogue: generateContent, the three levels, the window and its source; no key is unavailable and builds nothing', async () => {
  const auth = privateAuthDir()
  delete process.env.GEMINI_API_KEY
  try {
    const cfg = { models: DEFAULT_MODELS.map((m) => new ModelConfig(m as never)), default_model: null, context_window_fallback_tokens: 0, protected_paths: [], command_env_passthrough: [], checks: [] } as unknown as HarnessConfig
    const entry = catalogEntries(cfg).find((e) => e.id === ARGON_ID)!
    expect(entry).toMatchObject({ provider: 'google', configured_model: 'gemini-4-argon', api: 'generateContent', endpoint: 'https://generativelanguage.googleapis.com',
      account: 'gemini', credential: 'unavailable', credential_env: 'GEMINI_API_KEY', context_window: 1_048_576, supported_thinking: ['low', 'medium', 'high'] })
    expect(entry.cost_basis).toBe('estimated from the configured price list')
    const route = cfg.models.find((m) => m.id === ARGON_ID)!
    expect(() => buildModel(route)).toThrow(CredentialUnavailable)
    await keys.saveKey('gemini', 'AIza-test-argon-key-0007')
    expect(catalogEntries(cfg).find((e) => e.id === ARGON_ID)!.credential).toBe('available')
    const model = buildModel(route) as GoogleModel
    expect(model).toBeInstanceOf(GoogleModel)
    expect(model.model_name).toBe('gemini-4-argon')
    expect(model.url(true)).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse')
    expect(model.http).toMatchObject({ timeoutMs: ARGON_TIMEOUT_MS, idleTimeoutMs: ARGON_TIMEOUT_MS })
  } finally {
    auth.done()
  }
})

// -- thinking ----------------------------------------------------------------------------------------------------

test('thinking: low / medium / high as thinkingLevel; the default sends no level; off, minimal, xhigh, max go as the nearest; never a budget', () => {
  const cfg = argonCfg()
  const expected: Record<string, string | undefined> = { low: 'low', medium: 'medium', high: 'high', minimal: 'low', off: 'low', xhigh: 'high', max: 'high' }
  const model = argon()
  for (const [asked, sent] of Object.entries(expected)) {
    // the runner's own normalization (what the run records as thinking_sent) …
    const settings = modelSettings(cfg, asked)
    expect(settings.thinking).toBe(sent)
    // … and the wire for it
    const body = model.body(hello(), settings, params(settings.thinking ?? null))
    expect(gen(body).thinkingConfig).toEqual({ thinkingLevel: sent, includeThoughts: true })
    expect(JSON.stringify(body)).not.toContain('thinkingBudget')
  }
  // the provider's default: no level (the model's own medium), thought summaries asked for
  const settings = modelSettings(cfg, null)
  expect(settings.thinking).toBeUndefined()
  expect(gen(model.body(hello(), settings, params(null))).thinkingConfig).toEqual({ includeThoughts: true })
  // the adapter holds the line on its own (a route configured without reasoning_efforts sends the level as asked)
  expect(argonThinkingLevel(false)).toBe('low')
  expect(argonThinkingLevel('minimal')).toBe('low')
  expect(argonThinkingLevel('max')).toBe('high')
  expect(argonThinkingLevel('turbo')).toBeNull()
  expect(argonThinkingLevel(null)).toBeNull()
  for (const level of ['minimal', 'xhigh', 'max', false] as const) {
    expect(JSON.stringify(gen(model.body(hello(), {}, params(level))).thinkingConfig)).not.toMatch(/minimal|xhigh|max|thinkingBudget/)
  }
})

test('a run on the Argon route records the level asked and the level sent, and the wire carries the one sent', async () => {
  const cfg = argonCfg()
  const route = new Route([geminiStream([chunk([{ text: 'ok' }], { finish: 'STOP', usage: geminiUsage(5, 1) })])])
  state = await appState({ config: { ...testConfig([cfg]), default_model: cfg.id }, models: { [cfg.id]: argon(route) } })
  const { session } = await openSession(state, buggyRepo(), cfg.id)
  const run = await waitDone(state, (await state.runs.start(session, 'hi', { thinking: 'off' })).id)
  expect(run.status).toBe('done')
  expect(run.model_config_snapshot.thinking).toBe('off')
  expect(run.model_config_snapshot.thinking_sent).toBe('low')
  expect(gen(route.requests[0]!).thinkingConfig).toEqual({ thinkingLevel: 'low', includeThoughts: true })
  expect(gen(route.requests[0]!).maxOutputTokens).toBe(262_144)
  const max = await waitDone(state, (await state.runs.start(session, 'again', { thinking: 'max' })).id)
  expect(max.model_config_snapshot.thinking_sent).toBe('high')
  expect(gen(route.requests.at(-1)!).thinkingConfig).toEqual({ thinkingLevel: 'high', includeThoughts: true })
})

// -- tools --------------------------------------------------------------------------------------------------------

test("the tools go as parametersJsonSchema, the agent's own schemas as they are: a nullable field's type list is kept (`parameters` refused it with a 400 on 2026-10-14)", () => {
  const rows = toolSchemaRows([...visibleToolNames({ order: null })].sort())
  const function_tools = rows.map((row) => ({ name: row.name, description: row.description, parameters_json_schema: row.parameters }))
  // the surface has nullable fields: the shape the API's OpenAPI subset does not take
  expect(JSON.stringify(rows.map((r) => r.parameters))).toMatch(/"type":\[[^\]]*"null"/)
  for (const model of [argon(), new GoogleModel('gemini-3.6-flash', { apiKey: 'k', baseUrl: 'http://gemini.mock' })]) {
    const body = model.body(hello(), {}, { ...params(), function_tools })
    const declared = (body.tools as { functionDeclarations: Record<string, unknown>[] }[])[0]!.functionDeclarations
    expect(declared.map((d) => d.name)).toEqual(rows.map((r) => r.name))
    for (const [i, d] of declared.entries()) {
      expect(d).not.toHaveProperty('parameters')
      expect(d.parametersJsonSchema).toEqual(cleanSchema(rows[i]!.parameters))
    }
  }
})

// -- the price list -----------------------------------------------------------------------------------------------

test('a request is priced at the rates of its day: the October list, then the one published for 2026-12-01', () => {
  const usage = { input_tokens: 1_000_000, cache_read_tokens: 400_000, cache_write_tokens: 0, output_tokens: 100_000 }
  const pricing = argonCfg().pricing!
  // 600k uncached at $2, 400k cached at $0.10, 100k out at $10
  expect(estimateCost(usage, pricing, '5m', new Date('2026-11-30T23:59:59Z'))).toEqual([2.24, 'estimated', expect.stringContaining('@2026-10')])
  expect(estimateCost(usage, pricing, '5m', new Date('2026-12-01T00:00:00Z'))).toEqual([4.48, 'estimated', expect.stringContaining('@2026-12')])
})

// -- caps, sampling, timeouts ------------------------------------------------------------------------------------

test('the output total: one stream\'s 65,536 unless the route names its own (above it: the explicit long-decode opt-in, at most the window); no sampling fields, cache names or continuation token go out', () => {
  const model = argon()
  expect(gen(model.body(hello(), { max_tokens: 1_048_576 }, params()))!.maxOutputTokens).toBe(1_048_576)   // named explicitly: sent as named
  expect(gen(model.body(hello(), { max_tokens: 262_144 }, params()))!.maxOutputTokens).toBe(262_144)
  expect(gen(model.body(hello(), { max_tokens: 2_000_000 }, params()))!.maxOutputTokens).toBe(1_048_576)   // never past the unified window
  expect(gen(model.body(hello(), { max_tokens: 32_768 }, params()))!.maxOutputTokens).toBe(32_768)   // a lower cap is the person's
  expect(gen(model.body(hello(), {}, params()))!.maxOutputTokens).toBe(65_536)                        // named even when unset
  const body = model.body(hello(), { max_tokens: 4096, temperature: 0.2, cache_key: 'oasis:session:s', cache_ttl: '1h' }, params('medium'))
  const wire = JSON.stringify(body)
  for (const field of ['temperature', 'topP', 'topK', 'candidateCount', 'cachedContent', 'continuationToken', 'thinkingBudget', 'cache']) expect(wire).not.toContain(field)
  expect(Object.keys(body).sort()).toEqual(['contents', 'generationConfig', 'systemInstruction'])
})

test('timeouts: 20 minutes for the headers and for the stream\'s silences on Argon only, a route\'s own figures kept', async () => {
  expect(argon().http).toMatchObject({ timeoutMs: 20 * 60_000, idleTimeoutMs: 20 * 60_000 })
  expect(argon(undefined, { timeoutMs: 1000, idleTimeoutMs: 2000 }).http).toMatchObject({ timeoutMs: 1000, idleTimeoutMs: 2000 })
  const flash = new GoogleModel('gemini-3.6-flash', { apiKey: 'k', baseUrl: 'http://gemini.mock' })
  expect(flash.http.timeoutMs).toBeUndefined()            // the shared defaults (http.ts) stay the 3.6 route's
  expect(flash.http.idleTimeoutMs).toBeUndefined()
  // the idle figure is the one the stream is read with: a stalled stream ends as a transport timeout
  const stalled = async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk([{ text: 'a' }]))}\r\n\r\n`)) } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const model = argon(undefined, { fetchImpl: stalled, idleTimeoutMs: 30 })
  const stream = await model.requestStream(hello(), {}, params())
  await expect((async () => { for await (const _ of stream.events()) { /* drain */ } })()).rejects.toThrow('silent')
})

// -- thought signatures and call ids -----------------------------------------------------------------------------

function signedTurns(): string[] {
  return [
    geminiStream([
      chunk([{ text: 'Weighing where to look.', thought: true }]),
      chunk([{ text: ' Signed thought.', thought: true, thoughtSignature: SIG_T }]),
      chunk([{ text: 'Reading ' }]),
      chunk([{ text: 'two files.', thoughtSignature: SIG_X }]),
      chunk([
        { functionCall: { id: 'fc_native_1', name: 'read_file', args: { path: 'calc.py' } }, thoughtSignature: SIG_A },
        { functionCall: { id: 'fc_native_2', name: 'read_file', args: { path: 'util.py' } } },     // a parallel call: no signature
      ], { finish: 'STOP', usage: geminiUsage(100, 20) }),
    ]),
    geminiStream([chunk([{ text: 'add() subtracts.' }]), chunk([{ text: '', thoughtSignature: SIG_E }], { finish: 'STOP', usage: geminiUsage(200, 5) })]),
    geminiStream([chunk([{ text: 'Done.' }], { finish: 'STOP', usage: geminiUsage(220, 2) })]),
  ]
}

test('signatures go back on the part boundary they came on — thought, text, call, empty text — with the provider\'s call ids; nothing made up', async () => {
  const route = new Route(signedTurns())
  const run = await runAgent(agent(), argon(route), 'read calc.py and util.py', null)
  expect(run.result.output).toBe('add() subtracts.')
  const history = run.result.allMessages()
  const first = history.find((m): m is ModelResponse => m.kind === 'response')!
  // the record: each signed part a part of its own, the unsigned words before it kept apart
  expect(first.parts.map((p) => [p.part_kind, (p as { content?: string }).content ?? (p as { tool_name?: string }).tool_name, (p.provider_details as Record<string, unknown> | null) ?? null])).toEqual([
    ['thinking', 'Weighing where to look.', null],
    ['thinking', ' Signed thought.', { thought_signature: SIG_T }],
    ['text', 'Reading ', null],
    ['text', 'two files.', { thought_signature: SIG_X }],
    ['tool-call', 'read_file', { thought_signature: SIG_A, call_id: 'fc_native_1' }],
    ['tool-call', 'read_file', { call_id: 'fc_native_2' }],
  ])
  expect(first.parts.filter(isToolCall).map((p) => p.tool_call_id)).toEqual(['fc_native_1', 'fc_native_2'])
  // the second request: the model turn as it came (the unsigned thought summary stays home), then both results
  const second = contentsOf(route.requests[1]!)
  expect(second.map((c) => c.role)).toEqual(['user', 'model', 'user'])
  expect(second[1]!.parts).toEqual([
    { text: ' Signed thought.', thought: true, thoughtSignature: SIG_T },
    { text: 'Reading ' },
    { text: 'two files.', thoughtSignature: SIG_X },
    { functionCall: { id: 'fc_native_1', name: 'read_file', args: { path: 'calc.py' } }, thoughtSignature: SIG_A },
    { functionCall: { id: 'fc_native_2', name: 'read_file', args: { path: 'util.py' } } },
  ])
  const results = second[2]!.parts.map((p) => p.functionResponse as Record<string, unknown>)
  expect(results.map((r) => [r.id, r.name])).toEqual([['fc_native_1', 'read_file'], ['fc_native_2', 'read_file']])
  expect(JSON.stringify(route.requests)).not.toContain('skip_thought_signature_validator')
  expect(JSON.stringify(route.requests)).not.toContain('context_engineering_is_the_way_to_go')
  // a later run: the empty text part that carried the answer's signature goes back as it came
  await runAgent(agent(), argon(route), 'thanks', null, { history })
  const third = contentsOf(route.requests[2]!)
  const answerTurn = third.filter((c) => c.role === 'model').at(-1)!
  expect(answerTurn.parts).toEqual([{ text: 'add() subtracts.' }, { text: '', thoughtSignature: SIG_E }])
  // the record's JSON, saved and loaded, makes the same request bytes
  const loaded = loadJson(dumpJson(history))
  const model = argon()
  expect(JSON.stringify(model.body(loaded, {}, params()))).toBe(JSON.stringify(model.body(history, {}, params())))
  expect(dumpJson(history)).toContain(SIG_E)
})

test('a call without a provider id keeps the harness\'s id at home; a retry answers the provider\'s id; another route\'s signatures and ids never go', async () => {
  // no id from the provider: the harness names the call, and that name is never sent as the provider's
  const route = new Route([
    geminiStream([chunk([{ functionCall: { name: 'read_file', args: { path: 'calc.py' } }, thoughtSignature: SIG_A }], { finish: 'STOP', usage: geminiUsage(10, 3) })]),
    geminiStream([chunk([{ text: 'ok' }], { finish: 'STOP', usage: geminiUsage(20, 1) })]),
  ])
  const run = await runAgent(agent(), argon(route), 'read calc.py', null)
  const call = run.result.allMessages().flatMap((m) => (m.kind === 'response' ? m.parts : [])).find(isToolCall)!
  expect(call.tool_call_id).toMatch(/^call_/)
  expect(call.provider_details).toEqual({ thought_signature: SIG_A })
  const second = contentsOf(route.requests[1]!)
  expect(second[1]!.parts).toEqual([{ functionCall: { name: 'read_file', args: { path: 'calc.py' } }, thoughtSignature: SIG_A }])
  expect(second[2]!.parts).toEqual([{ functionResponse: { name: 'read_file', response: expect.objectContaining({ status: 'ok' }) } }])
  // arguments the tool refuses: the retry is the call's functionResponse under the provider's id
  const retry = new Route([
    geminiStream([chunk([{ functionCall: { id: 'fc_bad', name: 'read_file', args: {} }, thoughtSignature: SIG_A }], { finish: 'STOP', usage: geminiUsage(10, 3) })]),
    geminiStream([chunk([{ text: 'ok' }], { finish: 'STOP', usage: geminiUsage(20, 1) })]),
  ])
  await runAgent(agent(), argon(retry), 'read', null)
  const answered = contentsOf(retry.requests[1]!)[2]!.parts[0]!.functionResponse as Record<string, unknown>
  expect(answered.id).toBe('fc_bad')
  expect(answered.name).toBe('read_file')
  expect(JSON.stringify(answered.response)).toContain('call_error')
  // a Gemini 3.6 response handed to Argon unfiltered: its signature and id stay off the wire (another route); through
  // the handoff it arrives stripped as well
  const flashRoute = new GoogleModel('gemini-3.6-flash', { apiKey: 'k', baseUrl: 'http://gemini.mock' }).route
  const foreign: ModelMessage[] = [
    modelRequest([userPrompt('look')]),
    modelResponse([textPart('looking', { provider_name: 'google', provider_details: { thought_signature: SIG_X } }),
      toolCallPart('read_file', { path: 'a' }, 'fc_other', { provider_name: 'google', provider_details: { thought_signature: SIG_A, call_id: 'fc_other' } })],
    { provider_name: 'google', model_name: 'gemini-3.6-flash', provider_details: { route: flashRoute } }),
    modelRequest([toolReturn('read_file', { status: 'ok' }, 'fc_other')]),
  ]
  const model = argon()
  const wire = JSON.stringify(model.body(foreign, {}, params()))
  expect(wire).not.toContain(SIG_A)
  expect(wire).not.toContain(SIG_X)
  expect(wire).not.toContain('fc_other')
  const [portable] = portableHistory(foreign, 'google', model.route)
  expect(JSON.stringify(model.body(portable, {}, params()))).not.toContain(SIG_A)
  // the own route's response, same shape: both go
  const own = foreign.map((m) => (m.kind === 'response' ? { ...m, model_name: 'gemini-4-argon', provider_details: { route: model.route } } : m))
  const ownWire = JSON.stringify(model.body(own, {}, params()))
  expect(ownWire).toContain(SIG_A)
  expect(ownWire).toContain('"id":"fc_other"')
})

test('a response without a route stamp (an older 3.6 record, an unknown one) is not Argon\'s own: no signature, no provider id goes; its words and calls do', () => {
  const model = argon()
  const turn = (details: Record<string, unknown> | null, model_name: string): ModelMessage[] => [
    modelRequest([userPrompt('look')]),
    modelResponse([thinkingPart('weighing', { provider_name: 'google', provider_details: { thought_signature: SIG_T } }),
      textPart('looking', { provider_name: 'google', provider_details: { thought_signature: SIG_X } }),
      toolCallPart('read_file', { path: 'a' }, 'fc_old', { provider_name: 'google', provider_details: { thought_signature: SIG_A, call_id: 'fc_old' } })],
    { provider_name: 'google', model_name, provider_details: details }),
    modelRequest([toolReturn('read_file', { status: 'ok' }, 'fc_old')]),
  ]
  for (const unstamped of [turn(null, 'gemini-3.6-flash'), turn({}, 'gemini-3.6-flash'), turn(null, 'unknown-model'), turn(null, 'gemini-4-argon')]) {
    const contents = contentsOf(model.body(unstamped, {}, params()))
    const wire = JSON.stringify(contents)
    for (const leaked of [SIG_A, SIG_X, SIG_T, 'fc_old', 'thoughtSignature', 'weighing']) expect(wire).not.toContain(leaked)
    expect(contents[1]!.parts).toEqual([{ text: 'looking' }, { functionCall: { name: 'read_file', args: { path: 'a' } } }])
    expect(contents[2]!.parts).toEqual([{ functionResponse: { name: 'read_file', response: { status: 'ok' } } }])
  }
  // the same turn stamped with this route goes whole: every signature on its boundary, the provider's id on the call and its result
  const own = contentsOf(model.body(turn({ route: model.route }, 'gemini-4-argon'), {}, params()))
  expect(own[1]!.parts).toEqual([
    { text: 'weighing', thought: true, thoughtSignature: SIG_T },
    { text: 'looking', thoughtSignature: SIG_X },
    { functionCall: { id: 'fc_old', name: 'read_file', args: { path: 'a' } }, thoughtSignature: SIG_A },
  ])
  expect(own[2]!.parts).toEqual([{ functionResponse: { id: 'fc_old', name: 'read_file', response: { status: 'ok' } } }])
})

test('a provider id the loop renamed (`dup` reused → `dup_2`, `dup_3`) goes back as the provider\'s own on the call, its result and its retry', async () => {
  // the provider reuses its id across turns; the loop gives each later call a local id of its own (uniqueCallIds) and
  // the record keeps the provider's id beside it — the wire carries the provider's, never the local rename
  const route = new Route([
    geminiStream([chunk([{ functionCall: { id: 'dup', name: 'read_file', args: { path: 'calc.py' } }, thoughtSignature: SIG_A }], { finish: 'STOP', usage: geminiUsage(10, 3) })]),
    geminiStream([chunk([{ functionCall: { id: 'dup', name: 'read_file', args: { path: 'util.py' } }, thoughtSignature: SIG_A }], { finish: 'STOP', usage: geminiUsage(20, 3) })]),
    geminiStream([chunk([{ functionCall: { id: 'dup', name: 'read_file', args: {} }, thoughtSignature: SIG_A }], { finish: 'STOP', usage: geminiUsage(30, 3) })]),
    geminiStream([chunk([{ text: 'done' }], { finish: 'STOP', usage: geminiUsage(40, 1) })]),
  ])
  const run = await runAgent(agent(), argon(route), 'read both', null)
  expect(run.result.output).toBe('done')
  const history = run.result.allMessages()
  const calls = history.flatMap((m) => (m.kind === 'response' ? m.parts : [])).filter(isToolCall)
  expect(calls.map((c) => [c.tool_call_id, (c.provider_details as Record<string, unknown>).call_id])).toEqual([['dup', 'dup'], ['dup_2', 'dup'], ['dup_3', 'dup']])
  expect(route.requests).toHaveLength(4)
  const last = contentsOf(route.requests[3]!)
  expect(last.map((c) => c.role)).toEqual(['user', 'model', 'user', 'model', 'user', 'model', 'user'])
  for (const turn of [1, 3, 5]) expect((last[turn]!.parts[0]!.functionCall as Record<string, unknown>).id).toBe('dup')
  const answers = [2, 4, 6].map((turn) => last[turn]!.parts[0]!.functionResponse as Record<string, unknown>)
  expect(answers.map((a) => a.id)).toEqual(['dup', 'dup', 'dup'])
  expect(JSON.stringify(answers[1]!.response)).toContain('"status":"ok"')       // the plain result of dup_2
  expect(JSON.stringify(answers[2]!.response)).toContain('call_error')          // the retry of dup_3
  for (const body of route.requests) expect(JSON.stringify(body)).not.toMatch(/"id":"dup_\d/)
  // the record's JSON, saved and loaded, makes the same bytes: the mapping comes from the record, not from memory
  const model = argon()
  const loaded = loadJson(dumpJson(history))
  expect(JSON.stringify(model.body(loaded, {}, params()))).toBe(JSON.stringify(model.body(history, {}, params())))
})

test('a reloaded record: local id_2 with the provider\'s id_ — the result, the retry and the interrupted-call note all answer the provider\'s id', () => {
  const model = argon()
  const own = { provider_name: 'google', model_name: 'gemini-4-argon', provider_details: { route: model.route } }
  const history: ModelMessage[] = [
    modelRequest([userPrompt('go')]),
    modelResponse([toolCallPart('read_file', { path: 'a' }, 'id_2', { provider_name: 'google', provider_details: { thought_signature: SIG_A, call_id: 'id' } })], own),
    modelRequest([toolReturn('read_file', { status: 'ok' }, 'id_2')]),
    modelResponse([toolCallPart('read_file', {}, 'id_3', { provider_name: 'google', provider_details: { thought_signature: SIG_A, call_id: 'id' } })], own),
    modelRequest([retryPrompt('path: required', 'read_file', 'id_3')]),
    // a call the provider gave no id: the harness's local id stays home
    modelResponse([toolCallPart('read_file', { path: 'b' }, 'call_local', { provider_name: 'google', provider_details: { thought_signature: SIG_A } }),
      toolCallPart('read_file', { path: 'c' }, 'id_4', { provider_name: 'google', provider_details: { call_id: 'id' } })], own),
  ]
  // the run ended before the last calls were answered: the runner closes them with its note
  const closed = loadJson(dumpJson(closeDanglingToolCalls(history)))
  const contents = contentsOf(model.body(closed, {}, params()))
  const calls = contents.filter((c) => c.role === 'model').flatMap((c) => c.parts).map((p) => p.functionCall as Record<string, unknown>)
  expect(calls.map((c) => c.id ?? null)).toEqual(['id', 'id', null, 'id'])
  const answers = contents.filter((c) => c.role === 'user').flatMap((c) => c.parts).filter((p) => p.functionResponse).map((p) => p.functionResponse as Record<string, unknown>)
  expect(answers.map((a) => a.id ?? null)).toEqual(['id', 'id', null, 'id'])
  expect(JSON.stringify(answers[1]!.response)).toContain('call_error')
  const wire = JSON.stringify(contents)
  expect(wire).not.toMatch(/"id":"(id_\d|call_local)"/)
  // an empty recorded id is no provider id
  const empty: ModelMessage[] = [modelRequest([userPrompt('go')]), modelResponse([toolCallPart('read_file', { path: 'a' }, 'x_2', { provider_name: 'google', provider_details: { call_id: '' } })], own), modelRequest([toolReturn('read_file', { status: 'ok' }, 'x_2')])]
  expect(JSON.stringify(model.body(empty, {}, params()))).not.toContain('"id"')
})

// -- images, PDF, video ------------------------------------------------------------------------------------------

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const IMAGE = { asset_id: 'a_img', media_type: 'image/png', bytes: PNG.length, sha256: 'ab'.repeat(32), width: 1, height: 1, name: 'render.png', kind: 'image', data: PNG.toString('base64') }

test('images a tool returned: after both parallel results, in order, never nested in a functionResponse (documented for Gemini 3 only)', () => {
  expect(takesFunctionResponseImages('gemini-3.6-flash')).toBe(true)
  expect(takesFunctionResponseImages('gemini-4-argon')).toBe(false)
  expect(takesFunctionResponseImages('gemini-2.5-pro')).toBe(false)
  const model = argon()
  const history: ModelMessage[] = [
    modelRequest([userPrompt('look at both renders')]),
    modelResponse([
      toolCallPart('read_file', { path: 'out/a.png' }, 'fc_1', { provider_name: 'google', provider_details: { thought_signature: SIG_A, call_id: 'fc_1' } }),
      toolCallPart('read_file', { path: 'out/b.png' }, 'fc_2', { provider_name: 'google', provider_details: { call_id: 'fc_2' } }),
    ], { provider_name: 'google', model_name: 'gemini-4-argon', provider_details: { route: model.route } }),
    modelRequest([
      toolReturn('read_file', { status: 'ok', path: 'out/a.png', image: { ...IMAGE, name: 'a.png' } }, 'fc_1'),
      toolReturn('read_file', { status: 'ok', path: 'out/b.png', image: { ...IMAGE, name: 'b.png' } }, 'fc_2'),
    ]),
  ]
  const contents = contentsOf(model.body(history, {}, params()))
  const last = contents.at(-1)!
  expect(last.role).toBe('user')
  expect(last.parts.map((p) => Object.keys(p)[0])).toEqual(['functionResponse', 'functionResponse', 'text', 'inline_data', 'text', 'inline_data'])
  expect(last.parts.slice(0, 2).map((p) => (p.functionResponse as Record<string, unknown>).id)).toEqual(['fc_1', 'fc_2'])
  for (const p of last.parts.slice(0, 2)) {
    expect((p.functionResponse as Record<string, unknown>).parts).toBeUndefined()
    expect(JSON.stringify(p)).not.toContain(IMAGE.data)                                   // the reference stays, the bytes move
  }
  expect(last.parts[2]).toEqual({ text: 'Image from tool call fc_1 (out/a.png):' })
  expect(last.parts[4]).toEqual({ text: 'Image from tool call fc_2 (out/b.png):' })
  expect(last.parts.filter((p) => 'inline_data' in p)).toEqual([{ inline_data: { mime_type: 'image/png', data: IMAGE.data } }, { inline_data: { mime_type: 'image/png', data: IMAGE.data } }])
})

test('PDF and video go as inlineData; a QuickTime video is video/quicktime on Argon and video/mov on 3.6 as before', () => {
  const file = (media: string, name: string, kind: 'pdf' | 'video') => ({ asset_id: `a_${name}`, media_type: media, bytes: 4, sha256: 'cd'.repeat(32), name, file_kind: kind, representation: 'native-v1', kind: 'file', data: 'AAAA' })
  const history = (): ModelMessage[] => [modelRequest([userPrompt(['look', file('application/pdf', 'proof.pdf', 'pdf'), file('video/quicktime', 'clip.mov', 'video'), file('video/mp4', 'clip.mp4', 'video')])])]
  const parts = (model: GoogleModel) => contentsOf(model.body(history(), {}, params()))[0]!.parts
  expect(parts(argon())).toEqual([
    { text: 'look' },
    { inlineData: { mimeType: 'application/pdf', data: 'AAAA' } },
    { inlineData: { mimeType: 'video/quicktime', data: 'AAAA' } },
    { inlineData: { mimeType: 'video/mp4', data: 'AAAA' } },
  ])
  expect(parts(new GoogleModel('gemini-3.6-flash', { apiKey: 'k', baseUrl: 'http://gemini.mock' }))[2]).toEqual({ inlineData: { mimeType: 'video/mov', data: 'AAAA' } })
})

// -- usage and the end of a response -----------------------------------------------------------------------------

test('usage: the last cumulative count of the stream, cached input inside the input, thinking added to output once', async () => {
  const route = new Route([geminiStream([
    chunk([{ text: 'Thinking it over.', thought: true }], { usage: { promptTokenCount: 10_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 0, thoughtsTokenCount: 600, totalTokenCount: 10_600 } }),
    chunk([{ text: 'Answer.' }], { finish: 'STOP', usage: { promptTokenCount: 10_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 300, thoughtsTokenCount: 1_200, totalTokenCount: 11_500 } }),
  ])])
  const response = await argon(route).request(hello(), {}, params())
  expect(response.usage).toEqual({ input_tokens: 10_000, cache_read_tokens: 8_000, cache_write_tokens: 0, output_tokens: 1_500 })
  expect(response.finish_reason).toBe('stop')
  // priced with a person's configured list: uncached input, cached input and output (thinking inside it) each once
  const pricing = { input_per_mtok: 2, output_per_mtok: 10, cache_read_per_mtok: 0.1, cache_write_per_mtok: null, cache_write_1h_per_mtok: null, source: 'test list', version: 't' }
  const [usd] = estimateCost(response.usage!, pricing)
  expect(usd).toBeCloseTo((2_000 * 2 + 8_000 * 0.1 + 1_500 * 10) / 1e6, 9)
})

test('CONTINUATION at the default total is an unfinished answer (length), its token neither kept nor sent; past a checkpoint the loop does not ask the whole request again — below one it asks for the rest as for any cut answer', async () => {
  const cut = geminiStream([
    chunk([{ text: 'The first half' }], { continuationToken: 'CHECKPOINT-TOKEN-1' }),
    chunk([{ text: ' of it' }], { finish: 'CONTINUATION', continuationToken: 'CONTINUATION-TOKEN-2', usage: geminiUsage(50, 65_536) }),
  ])
  const response = await argon(new Route([cut])).request(hello(), {}, params())
  expect(response.finish_reason).toBe('length')
  expect(JSON.stringify(response)).not.toContain('TOKEN')
  // past a checkpoint (long decode): a new request without the token would think it all again — the answer ends, cut
  const route = new Route([cut, geminiStream([chunk([{ text: ' and the rest.' }], { finish: 'STOP', usage: geminiUsage(60, 4) })])])
  const run = await runAgent(agent(), argon(route), 'write it', null)
  expect(run.events.find((e) => e.type === 'continued')).toBeUndefined()
  expect(route.requests).toHaveLength(1)
  expect(run.result.incomplete).toMatchObject({ reason: 'length', attempts: 0 })
  for (const body of route.requests) expect(JSON.stringify(body)).not.toMatch(/continuationToken|TOKEN-/)
  expect(JSON.stringify(run.result.allMessages())).not.toContain('TOKEN-')
  // no checkpoint (words cut at a small total): the loop's output-limit continuation, as for any model
  const small = geminiStream([chunk([{ text: 'The first half' }], { finish: 'MAX_TOKENS', usage: geminiUsage(50, 4_000) })])
  const route2 = new Route([small, geminiStream([chunk([{ text: ' and the rest.' }], { finish: 'STOP', usage: geminiUsage(60, 4) })])])
  const run2 = await runAgent(agent(), argon(route2), 'write it', null)
  expect(run2.events.find((e) => e.type === 'continued')).toMatchObject({ reason: 'output_limit', finish_reason: 'length' })
  expect(route2.requests).toHaveLength(2)
  // MAX_TOKENS stays length as well
  const max = await argon(new Route([geminiStream([chunk([{ text: 'cut' }], { finish: 'MAX_TOKENS', usage: geminiUsage(5, 5) })])])).request(hello(), {}, params())
  expect(max.finish_reason).toBe('length')
})

test('the newer FinishReasons: a provider failure is an error even with words (never the answer); ESCALATION / PUP_LIMITED_DISABLED a filter', async () => {
  for (const reason of ['MISSING_THOUGHT_SIGNATURE', 'MALFORMED_RESPONSE', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS', 'MALFORMED_FUNCTION_CALL']) {
    const stream = geminiStream([chunk([{ text: 'Here is the answer, apparently.' }], { finish: reason, usage: geminiUsage(5, 6) })])
    const response = await argon(new Route([stream])).request(hello(), {}, params())
    expect(response.finish_reason).toBe('error')
    // through the loop: the words are not taken as the answer — asked again, then said as the provider's error
    const run = await runAgent(agent(), argon(new Route([stream])), 'answer', null)
    expect(run.result.incomplete?.reason).toBe('provider_error')
    expect(run.events.some((e) => e.type === 'continued' && e.reason === 'no_answer')).toBe(true)
  }
  for (const reason of ['ESCALATION', 'PUP_LIMITED_DISABLED', 'SAFETY']) {
    const route = new Route([geminiStream([chunk([{ text: 'Partial words.' }], { finish: reason, usage: geminiUsage(5, 2) })])])
    expect((await argon(route).request(hello(), {}, params())).finish_reason).toBe('content_filter')
    const run = await runAgent(agent(), argon(new Route([geminiStream([chunk([{ text: 'Partial words.' }], { finish: reason, usage: geminiUsage(5, 2) })])])), 'answer', null)
    expect(run.result.incomplete).toEqual({ reason: 'content_filter', attempts: 0 })
  }
  // the mapping is shared: the 3.6 route takes the new reasons the same way
  const flash = new GoogleModel('gemini-3.6-flash', { apiKey: 'k', baseUrl: 'http://gemini.mock', maxRetries: 0, fetchImpl: new Route([geminiStream([chunk([{ text: 'x' }], { finish: 'MALFORMED_RESPONSE' })])]).fetch })
  expect((await flash.request(hello(), {}, params())).finish_reason).toBe('error')
})

test('a blocked prompt (promptFeedback.blockReason, no candidate) is a filter\'s answer: one request, usage kept, never retried as a cut stream', async () => {
  const blocked = (reason: string) => `data: ${JSON.stringify({ promptFeedback: { blockReason: reason }, usageMetadata: { promptTokenCount: 12, totalTokenCount: 12 }, modelVersion: 'gemini-4-argon', responseId: 'resp-blocked' })}\r\n\r\n`
  const response = await argon(new Route([blocked('PROHIBITED_CONTENT')])).request(hello(), {}, params())
  expect(response.finish_reason).toBe('content_filter')
  expect(response.parts).toEqual([])
  expect(response.usage).toEqual({ input_tokens: 12, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 })
  // a whole run on the app: exactly one request goes out, and the run says it was filtered
  const cfg = argonCfg()
  const route = new Route([blocked('SAFETY')])
  state = await appState({ config: { ...testConfig([cfg]), default_model: cfg.id }, models: { [cfg.id]: argon(route) } })
  const { session } = await openSession(state, buggyRepo(), cfg.id)
  const run = await waitDone(state, (await state.runs.start(session, 'hi')).id)
  expect(route.requests).toHaveLength(1)
  expect((run.receipt.mechanical as Record<string, unknown>).answer_end).toEqual({ reason: 'content_filter', attempts: 0 })
  // BLOCK_REASON_UNSPECIFIED names no block: the stream is still one that ended without a finishReason
  await expect(argon(new Route([blocked('BLOCK_REASON_UNSPECIFIED')])).request(hello(), {}, params())).rejects.toThrow('without a finishReason')
})

test('max_tokens on the exact Argon route: the default stays 65,536; above it only as the route names it (long decode), at most the window; other models untouched', () => {
  expect(GEMINI_ARGON_MAX_TOKENS).toBe(ARGON_STREAM_OUTPUT_CAP)
  const route = (model: string, max_tokens?: number | null, provider = 'google') => ({ id: `x:${model}`, provider, model, ...(max_tokens === undefined ? {} : { max_tokens }) })
  expect(ModelConfigSchema.parse(route('gemini-4-argon', 65_537)).max_tokens).toBe(65_537)                 // the person's explicit opt-in
  expect(new ModelConfig(route('gemini-4-argon', 262_144) as never).max_tokens).toBe(262_144)
  expect(new ModelConfig(route('gemini-4-argon', 1_048_576) as never).max_tokens).toBe(1_048_576)
  expect(() => ModelConfigSchema.parse(route('gemini-4-argon', 1_048_577))).toThrow(/above Gemini 4 Argon's unified window of 1048576/)
  expect(() => new ModelConfig({ ...route('gemini-4-argon', 600_000), context_window: 500_000 } as never)).toThrow(/unified window of 500000/)
  expect(new ModelConfig(route('gemini-4-argon', 65_536) as never).max_tokens).toBe(65_536)
  expect(new ModelConfig(route('gemini-4-argon', 8_192) as never).max_tokens).toBe(8_192)
  expect(new ModelConfig(route('gemini-4-argon') as never).max_tokens).toBe(16_000)                     // the shared default, unchanged
  expect(new ModelConfig({ ...route('gemini-4-argon'), context_window: 1_048_576 } as never).max_tokens).toBe(64_000)
  expect(argonCfg().max_tokens).toBe(262_144)
  for (const other of [route('gemini-3.6-flash', 100_000), route('gemini-4-argon-preview', 100_000), route('gemini-4-argon', 100_000, 'openai')]) {
    expect(ModelConfigSchema.parse(other).max_tokens).toBe(100_000)
  }
  // the wire sends what the route names (no harness raise): the default route's 262,144, an explicit 200,000 as named
  expect(gen(argon().body(hello(), { max_tokens: argonCfg().max_tokens }, params())).maxOutputTokens).toBe(262_144)
  expect(gen(argon().body(hello(), { max_tokens: 200_000 }, params())).maxOutputTokens).toBe(200_000)
})

// -- Gemini 3.6, as it was ---------------------------------------------------------------------------------------

test('Gemini 3.6 Flash keeps its mapping: a budget, temperature, the cap as given, merged words, no call ids, signatures on calls only', async () => {
  const flash = (route?: Route) => new GoogleModel('gemini-3.6-flash', { apiKey: 'k', baseUrl: 'http://gemini.mock', fetchImpl: route?.fetch })
  const body = flash().body(hello(), { max_tokens: 100_000, temperature: 0.3 }, params('medium'))
  expect(gen(body)).toEqual({ maxOutputTokens: 100_000, temperature: 0.3, thinkingConfig: { thinkingBudget: 8192, includeThoughts: true } })
  expect(gen(flash().body(hello(), {}, params(false)))).toEqual({ thinkingConfig: { thinkingBudget: 0 } })
  expect(flash().body(hello(), {}, params(null)).generationConfig).toBeUndefined()
  const route = new Route([geminiStream([
    chunk([{ text: 'Reading ' }]),
    chunk([{ text: 'it.', thoughtSignature: SIG_X }]),
    chunk([{ functionCall: { id: 'fc_flash', name: 'read_file', args: { path: 'calc.py' } }, thoughtSignature: SIG_A }], { finish: 'STOP', usage: geminiUsage(10, 3) }),
  ]), geminiStream([chunk([{ text: 'ok' }], { finish: 'STOP', usage: geminiUsage(20, 1) })])])
  const run = await runAgent(agent(), flash(route), 'read', null)
  const first = run.result.allMessages().find((m): m is ModelResponse => m.kind === 'response')!
  expect(first.parts.filter(isText).map((p) => p.content)).toEqual(['Reading it.'])        // one merged text part
  expect(first.parts.find(isToolCall)!.provider_details).toEqual({ thought_signature: SIG_A })   // no call_id recorded
  const second = contentsOf(route.requests[1]!)
  expect(second[1]!.parts).toEqual([{ text: 'Reading it.' }, { functionCall: { name: 'read_file', args: { path: 'calc.py' } }, thoughtSignature: SIG_A }])
  expect(second[2]!.parts).toEqual([{ functionResponse: { name: 'read_file', response: expect.objectContaining({ status: 'ok' }) } }])
  // thought summaries never go back on 3.6, signed or not
  const withThought: ModelMessage[] = [...hello(), modelResponse([thinkingPart('t', { provider_name: 'google', provider_details: { thought_signature: SIG_T } }), textPart('a')], { provider_name: 'google' })]
  expect(JSON.stringify(flash().body(withThought, {}, params()))).not.toContain(SIG_T)
  expect(first.parts.some(isThinking)).toBe(false)
})
