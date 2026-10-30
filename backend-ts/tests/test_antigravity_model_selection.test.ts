/** Synthetic regressions for logical model selection and private replay ownership. No live credentials/network. */
import '../src/main.ts'
import { expect, test } from 'bun:test'
import { ContextView } from '../src/agent/history.ts'
import { Deferred } from '../src/auth/callback.ts'
import { parseCatalog, resolveAntigravityModel, SUPPORTED_MODELS } from '../src/auth/antigravity_catalog.ts'
import { ANTIGRAVITY_USER_AGENT, CONTROL_ENDPOINTS, isRecord } from '../src/auth/oauth_antigravity.ts'
import { OAuthCredential } from '../src/auth/store.ts'
import { modelRequest, modelResponse, toolCallPart, toolReturn, userPrompt, type ModelMessage } from '../src/llm/messages.ts'
import type { ModelRequestParameters } from '../src/llm/model.ts'
import { AntigravityModel, STREAM_URL } from '../src/llm/providers/antigravity.ts'

const flash = 'gemini-3.8-flash-tiered'
const argon = 'gemini-4-argon'
const input = [modelRequest([userPrompt('read one value')])]
const grant = () => new OAuthCredential({ access: 'synthetic-access', refresh: 'synthetic-refresh', account_id: 'A', project_id: 'P', authorization_id: 'G', expires_ms: Date.now() + 3600_000 })
const manager = { access: async () => grant(), store: { read: () => grant() } }
const params: ModelRequestParameters = { thinking: null, allow_text_output: true, function_tools: [{ name: 'lookup', description: 'Lookup one value', parameters_json_schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false } }] }
const catalog = () => ({ models: Object.fromEntries(Object.values(SUPPORTED_MODELS).flatMap(m => Object.values(m.upstream)).map(id => [id, { supportsThinking: true, maxOutputTokens: 65536 }])) })
const sse = (parts: unknown[]) => new Response('data: ' + JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } })

test('official selection covers the independently observed 13 upstream IDs and four wire strategies', () => {
  // Independent protocol fixture: no expected IDs or strategies are derived from the implementation registry.
  const observed = [
    [flash, 'low', 'gemini-3.8-flash-low', { includeThoughts: true, thinkingBudget: 1000 }],
    [flash, 'medium', 'gemini-3.8-flash-medium', { includeThoughts: true, thinkingBudget: 4000 }],
    [flash, 'high', 'gemini-3.8-flash-high', { includeThoughts: true, thinkingBudget: -1 }],
    [argon, 'low', 'gemini-4-argon-low', { includeThoughts: true, thinkingLevel: 'LOW' }],
    [argon, 'medium', 'gemini-4-argon-medium', { includeThoughts: true, thinkingLevel: 'MEDIUM' }],
    [argon, 'high', 'gemini-4-argon-high', { includeThoughts: true, thinkingLevel: 'HIGH' }],
    ['claude-opus-5-5-high', 'low', 'claude-opus-5-5-low', { includeThoughts: true, thinkingLevel: 'LOW' }],
    ['claude-opus-5-5-high', 'medium', 'claude-opus-5-5-medium', { includeThoughts: true, thinkingLevel: 'MEDIUM' }],
    ['claude-opus-5-5-high', 'high', 'claude-opus-5-5-high', { includeThoughts: true, thinkingLevel: 'HIGH' }],
    ['claude-sonnet-5-5-high', 'low', 'claude-sonnet-5-5-low', { includeThoughts: true, thinkingLevel: 'LOW' }],
    ['claude-sonnet-5-5-high', 'medium', 'claude-sonnet-5-5-medium', { includeThoughts: true, thinkingLevel: 'MEDIUM' }],
    ['claude-sonnet-5-5-high', 'high', 'claude-sonnet-5-5-high', { includeThoughts: true, thinkingLevel: 'HIGH' }],
    ['gpt-oss-120b-medium', 'medium', 'gpt-oss-120b-medium', { includeThoughts: true, thinkingBudget: 8192 }],
  ] as const
  for (const [id, effort, upstream, config] of observed) {
    const adapter = new AntigravityModel(id, manager)
    const body = adapter.body(input, {}, { ...params, thinking: effort }, grant()) as any
    expect(resolveAntigravityModel(id, effort).upstreamId).toBe(upstream)
    expect(body.model).toBe(upstream)
    expect(body.request.generationConfig.thinkingConfig).toEqual(config)
    expect(body.request.generationConfig.thinkingConfig.includeRawThoughts).toBeUndefined()
    expect(body.request.generationConfig.thinkingConfig.enableThinking).toBeUndefined()
  }
  for (const [id, upstream] of [[flash, 'gemini-3.8-flash-medium'], [argon, 'gemini-4-argon-low'], ['claude-opus-5-5-high', 'claude-opus-5-5-medium'], ['claude-sonnet-5-5-high', 'claude-sonnet-5-5-medium'], ['gpt-oss-120b-medium', 'gpt-oss-120b-medium']]) expect(resolveAntigravityModel(id!).upstreamId).toBe(upstream!)
  expect(new Set(observed.map(row => row[2])).size).toBe(13)
  expect(() => resolveAntigravityModel('gpt-oss-120b-medium', 'low')).toThrow('unsupported')
  expect(() => resolveAntigravityModel(argon, 'MAX')).toThrow('unsupported')
  expect(() => resolveAntigravityModel(argon, false)).toThrow('unsupported')
  expect(() => resolveAntigravityModel('unknown')).toThrow('unsupported')
})

test('the selected live effort is gated without substituting another available variant, including a missing default', async () => {
  let inferences = 0
  const model = new AntigravityModel(argon, manager, { fetchImpl: async url => {
    if (String(url) === CONTROL_ENDPOINTS.fetchAvailableModels) return Response.json({ models: { 'gemini-4-argon-high': {} } })
    inferences++
    return sse([{ text: 'ok' }])
  } })
  expect(parseCatalog({ models: { 'gemini-4-argon-high': {} } })[0]!.reasoning_efforts).toEqual(['high'])
  await expect(model.request(input, {}, params)).rejects.toThrow('not available')
  await expect(model.request(input, {}, { ...params, thinking: 'medium' })).rejects.toThrow('not available')
  expect(inferences).toBe(0)
  await model.request(input, {}, { ...params, thinking: 'high' })
  expect(inferences).toBe(1)
  let accesses = 0
  const gpt = new AntigravityModel('gpt-oss-120b-medium', { access: async () => { accesses++; return grant() } })
  await expect(gpt.request(input, {}, { ...params, thinking: 'low' })).rejects.toThrow('unsupported')
  expect(accesses).toBe(0)
})

test('catalog metadata is conservative across variants but actual output validation uses the selected upstream', async () => {
  const models = {
    'gemini-4-argon-low': { maxTokens: 8000, maxOutputTokens: 4096, supportsImages: true },
    'gemini-4-argon-high': { maxTokens: 6000, maxOutputTokens: 1024, supportsImages: false },
  }
  const cfg = parseCatalog({ models })[0]!
  expect(cfg).toMatchObject({ context_window: 6000, max_tokens: 1024, reasoning_efforts: ['low', 'high'] })
  expect(cfg.capabilities).toMatchObject({ images: false, max_output_tokens: 1024, provider_max_output_tokens: 1024 })
  const sent: string[] = []
  const model = new AntigravityModel(argon, manager, { fetchImpl: async (url, init) => {
    if (String(url) === CONTROL_ENDPOINTS.fetchAvailableModels) return Response.json({ models })
    sent.push(JSON.parse(String(init?.body)).model)
    return sse([{ text: 'ok' }])
  } })
  await model.request(input, { max_tokens: 2048 }, { ...params, thinking: 'low' })
  await expect(model.request(input, { max_tokens: 2048 }, { ...params, thinking: 'high' })).rejects.toThrow('1024')
  expect(sent).toEqual(['gemini-4-argon-low'])
})

test('ContextView retains same-group history but adapter replays private data only for the exact selected upstream', async () => {
  for (const id of [flash, 'claude-opus-5-5-high', 'claude-sonnet-5-5-high', argon, 'gpt-oss-120b-medium']) {
    const ownEffort = id === 'gpt-oss-120b-medium' ? 'medium' : 'high'
    const requests: any[] = []
    const adapter = new AntigravityModel(id, manager, { fetchImpl: async (url, init) => {
      expect(new Headers(init?.headers).get('user-agent')).toBe(ANTIGRAVITY_USER_AGENT)
      if (String(url) === CONTROL_ENDPOINTS.fetchAvailableModels) return Response.json(catalog())
      const body = JSON.parse(String(init?.body)); requests.push(body)
      return requests.length === 1
        ? sse([{ functionCall: { name: 'lookup', id: 'native-call', args: { n: 1 } }, thoughtSignature: 'private-signature' }])
        : sse([{ text: 'done' }])
    } })
    const view = new ContextView(adapter, 'antigravity')
    const first = await view.request(input, {}, { ...params, thinking: ownEffort })
    expect(first.provider_details).toMatchObject({ route: adapter.routeForGrant(grant()), signature_route: adapter.signatureRouteForGrant(grant(), resolveAntigravityModel(id, ownEffort).upstreamId) })
    // A synthetic wire projection difference makes private-wire versus portable-argument replay observable.
    const wireOwned = { ...first, parts: first.parts.map(p => p.part_kind === 'tool-call' ? { ...p, provider_details: { ...(isRecord(p.provider_details) ? p.provider_details : {}), wire_args: { n: 701 } } } : p) }
    const history = [...input, wireOwned, modelRequest([toolReturn('lookup', { n: 2 }, 'native-call')])]
    await view.request(history, {}, { ...params, thinking: ownEffort })
    expect(JSON.stringify(requests[1])).toContain('private-signature')
    expect(requests[1].request.contents.find((c: any) => c.role === 'model').parts[0].functionCall).toMatchObject({ id: 'native-call', args: { n: 701 } })
    expect(requests[1].request.contents.find((c: any) => c.parts.some((p: any) => p.functionResponse)).parts[0].functionResponse.id).toBe('native-call')
    if (id !== 'gpt-oss-120b-medium') {
      await view.request(history, {}, { ...params, thinking: 'low' })
      expect(JSON.stringify(requests[2])).not.toContain('private-signature')
      expect(requests[2].request.contents.find((c: any) => c.role === 'model').parts[0].functionCall.id).toBeUndefined()
      expect(requests[2].request.contents.find((c: any) => c.role === 'model').parts[0].functionCall.args).toEqual({ n: 1 })
      expect(requests[2].request.contents.find((c: any) => c.parts.some((p: any) => p.functionResponse)).parts[0].functionResponse.id).toBeUndefined()
    }
    const otherGrant = grant().with({ authorization_id: 'other' })
    expect(JSON.stringify(adapter.body(history, {}, { ...params, thinking: ownEffort }, otherGrant))).not.toContain('private-signature')
  }
})

test('old exact-route signatures remain usable on the matching Claude high variant, never another effort or the old Flash tiered alias', () => {
  for (const id of [flash, 'claude-opus-5-5-high']) {
    const adapter = new AntigravityModel(id, manager)
    const legacy = modelResponse([toolCallPart('lookup', { n: 1 }, 'local', { provider_name: 'antigravity', provider_details: { thought_signature: 'legacy-signature', call_id: 'legacy-wire-id', wire_args: { n: 1 } } })], { provider_name: 'antigravity', provider_details: { route: adapter.routeForGrant(grant()) } })
    const history = [...input, legacy]
    const high = JSON.stringify(adapter.body(history, {}, { ...params, thinking: 'high' }, grant()))
    if (id.startsWith('claude')) expect(high).toContain('legacy-signature')
    else expect(high).not.toContain('legacy-signature')
    expect(JSON.stringify(adapter.body(history, {}, { ...params, thinking: 'medium' }, grant()))).not.toContain('legacy-signature')
    const forged = { ...legacy, provider_details: { route: 'wrong-outer-route', signature_route: adapter.signatureRouteForGrant(grant(), resolveAntigravityModel(id, 'high').upstreamId) } }
    expect(JSON.stringify(adapter.body([...input, forged], {}, { ...params, thinking: 'high' }, grant()))).not.toContain('legacy-signature')
  }
})

test('a cached adapter supports concurrent efforts without sharing selected upstream or signature state', async () => {
  const gates = { low: new Deferred<Response>(), high: new Deferred<Response>() }
  const bothEntered = new Deferred<void>()
  let pending = 0
  const bodies: any[] = []
  const adapter = new AntigravityModel(argon, manager, { fetchImpl: async (url, init) => {
    if (String(url) === CONTROL_ENDPOINTS.fetchAvailableModels) return Response.json(catalog())
    const body = JSON.parse(String(init?.body)); bodies.push(body)
    if (bodies.length > 2) return sse([{ text: 'done' }])
    const effort = body.model.endsWith('-low') ? 'low' : 'high'
    if (++pending === 2) bothEntered.resolve()
    return gates[effort].promise
  } })
  const lowTask = adapter.request(input, {}, { ...params, thinking: 'low' })
  const highTask = adapter.request(input, {}, { ...params, thinking: 'high' })
  await bothEntered.promise
  gates.high.resolve(sse([{ functionCall: { name: 'lookup', id: 'high-call', args: { n: 2 } }, thoughtSignature: 'high-signature' }]))
  const high = await highTask
  gates.low.resolve(sse([{ functionCall: { name: 'lookup', id: 'low-call', args: { n: 1 } }, thoughtSignature: 'low-signature' }]))
  const low = await lowTask
  expect(high.provider_details?.upstream_model).toBe('gemini-4-argon-high')
  expect(low.provider_details?.upstream_model).toBe('gemini-4-argon-low')
  const history: ModelMessage[] = [...input, low, modelRequest([toolReturn('lookup', {}, 'low-call')]), high, modelRequest([toolReturn('lookup', {}, 'high-call')])]
  await Promise.all(['low', 'high'].map(thinking => adapter.request(history, {}, { ...params, thinking })))
  for (const body of bodies.slice(2)) {
    const own = body.model.endsWith('-low') ? 'low' : 'high', other = own === 'low' ? 'high' : 'low'
    expect(JSON.stringify(body)).toContain(own + '-signature')
    expect(JSON.stringify(body)).not.toContain(other + '-signature')
  }
})


test('effort is captured before catalog awaits, so a caller mutation cannot bypass the selected upstream gate', async () => {
  const entered = new Deferred<void>(), release = new Deferred<Response>()
  const mutable: ModelRequestParameters = { ...params, thinking: 'low' }
  let body: any
  const model = new AntigravityModel(argon, manager, { fetchImpl: async (url, init) => {
    if (String(url) === CONTROL_ENDPOINTS.fetchAvailableModels) { entered.resolve(); return release.promise }
    body = JSON.parse(String(init?.body))
    return sse([{ text: 'done' }])
  } })
  const request = model.request(input, {}, mutable)
  await entered.promise
  mutable.thinking = 'high'
  release.resolve(Response.json({ models: { 'gemini-4-argon-low': { maxOutputTokens: 4096 } } }))
  const response = await request
  expect(body.model).toBe('gemini-4-argon-low')
  expect(body.request.generationConfig).toEqual({ maxOutputTokens: 4096, thinkingConfig: { includeThoughts: true, thinkingLevel: 'LOW' } })
  expect(response.provider_details?.upstream_model).toBe('gemini-4-argon-low')
  expect(response.provider_details?.thinking_effort).toBe('low')
})
