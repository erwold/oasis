import { expect, test } from 'bun:test'
import { ModelConfig, STANDARD_CN_MODELS, harnessConfig } from '../src/config.ts'
import { catalogEntries } from '../src/llm/catalog.ts'
import { KEY_PROVIDERS } from '../src/auth/keys.ts'
import { DeepSeekModel, ZhipuModel, buildModel, providerSystem } from '../src/llm/providers.ts'
import { modelRequest, modelResponse, userPrompt, toolReturn, toolCallPart, isThinking, isToolCall, type ModelMessage } from '../src/llm/messages.ts'
import type { ModelRequestParameters } from '../src/llm/model.ts'
import { portableHistory } from '../src/llm/handoff.ts'
import { estimateCost, estimateRequestCost } from '../src/llm/usage.ts'
import { probeTools } from '../scripts/standard_provider_probe.ts'
import { parametersSchema, specs } from '../src/agent/tools/registry.ts'
import { credentialStore } from '../src/auth/store.ts'
import { Route, privateAuthDir } from './helpers.ts'

const tools = probeTools()
const params: ModelRequestParameters = { function_tools: tools, allow_text_output: true, thinking: null }
const messages = [modelRequest([userPrompt('Read probe.txt')], 'Keep exact history')]
const sse = (data: unknown[]) => data.map((row) => `data: ${JSON.stringify(row)}\n\n`).join('')
const reasoning = { type: 'reasoning', id: 'r1', content: [{ type: 'reasoning_text', text: 'raw\n reasoning  ' }] }
const call = { type: 'function_call', id: 'f1', call_id: 'c1', name: 'read_file', arguments: '{"path":"probe.txt"}' }
const finalItem = { type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }
const responseUsage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 700 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 80 } }
function responsesStream(tool: boolean) {
  const item = tool ? call : finalItem
  return sse([
    { type: 'response.created', response: { id: 'resp', model: 'reported-version' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'r1' } },
    { type: 'response.reasoning_text.delta', output_index: 0, delta: 'raw\n ' },
    { type: 'response.reasoning_text.delta', output_index: 0, delta: 'reasoning  ' },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item: { ...item, arguments: '' } },
    ...(tool ? [{ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"probe.txt"}' }]
      : [{ type: 'response.output_text.delta', output_index: 1, delta: 'done' }]),
    { type: 'response.output_item.done', output_index: 1, item },
    { type: 'response.completed', response: { id: 'resp', model: 'reported-version', usage: responseUsage } },
  ])
}
function chatStream(tool: boolean) {
  const chunk = (delta: unknown, finish_reason: string | null = null, usage?: unknown) => ({ model: 'reported-glm', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })
  return sse([
    chunk({ reasoning_content: 'raw\n ' }), chunk({ reasoning_content: 'reasoning  ' }),
    ...(tool ? [chunk({ tool_calls: [{ index: 1, id: 'c1', function: { name: 'read_file', arguments: '{"path":' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '"probe.txt"}' } }] })] : [chunk({ content: 'done' })]),
    // Usage on a nonempty final choices chunk, not the OpenAI empty-choices convention.
    chunk({}, tool ? 'tool_calls' : 'stop', { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 700 }, completion_tokens: 100 }),
  ]) + 'data: [DONE]\n\n'
}

test('five first-party routes: exact metadata, key accounts, capabilities, no subscription or native search', () => {
  const auth = privateAuthDir()
  try {
    const routes = STANDARD_CN_MODELS.map((raw) => new ModelConfig(raw as never))
    const entries = catalogEntries(harnessConfig({ models: routes }))
    expect(routes).toHaveLength(5)
    expect(KEY_PROVIDERS.deepseek!.env).toBe('DEEPSEEK_API_KEY')
    expect(KEY_PROVIDERS.zhipu!.env).toBe('ZHIPU_API_KEY')
    for (const cfg of routes) {
      expect(cfg.context_window).toBe(1048576)
      expect(cfg.auth).toBe('api_key')
      expect(cfg.max_tokens).toBe(cfg.provider === 'deepseek' ? 393216 : 131072)
      expect(cfg.capabilities.images).toBe(cfg.model.includes('flash'))
      expect(cfg.capabilities.pdf).toBe(false)
      expect(cfg.reasoning_efforts).toEqual(cfg.provider === 'deepseek' ? ['none', 'low', 'high', 'max'] : ['low', 'high', 'max'])
      expect(entries.find((e) => e.id === cfg.id)!.account).toBe(cfg.provider)
      expect(providerSystem(cfg)).toBe(cfg.provider)
      expect(() => new ModelConfig({ ...cfg.dump(), auth: 'oauth' } as never)).toThrow('no subscription sign-in')
    }
  } finally { auth.done() }
})

for (const name of ['deepseek-flash', 'deepseek-v4-pro']) test(`${name}: full tools, raw reasoning + tool roundtrip, reported model, cache subset`, async () => {
  const route = new Route([responsesStream(true), responsesStream(false)])
  const model = new DeepSeekModel(name, { apiKey: 'synthetic-test-key', fetchImpl: route.fetch })
  const stream = await model.requestStream(messages, { max_tokens: 393216, cache_key: 'not-sent' }, params)
  const events = []
  for await (const event of stream.events()) events.push(event)
  const first = stream.get()
  expect(first.provider_name).toBe('deepseek')
  expect(first.parts.every((p) => p.provider_name === 'deepseek')).toBe(true)
  expect(first.model_name).toBe('reported-version')
  expect(first.parts.find(isThinking)!.content).toBe('raw\n reasoning  ')
  expect(first.parts.find(isToolCall)!.args).toEqual({ path: 'probe.txt' })
  expect(first.usage).toMatchObject({ input_tokens: 1000, cache_read_tokens: 700, output_tokens: 100, details: { reasoning_tokens: 80 } })
  expect(events.some((e) => e.type === 'part_delta' && e.delta.part_kind === 'thinking')).toBe(true)
  await model.request([...messages, first, modelRequest([toolReturn('read_file', 'fixture', 'c1')])], {}, params)
  expect(route.urls[0]).toBe('https://api.deepseek.com/responses')
  const body = route.requests[0]!
  expect((body.tools as unknown[]).length).toBe(tools.length)
  expect(body.reasoning).toEqual({ effort: 'high' })
  for (const key of ['store', 'previous_response_id', 'conversation', 'include', 'prompt_cache_key', 'prompt_cache_retention']) expect(body).not.toHaveProperty(key)
  expect(route.requests[1]!.input).toContainEqual(reasoning)
  expect(route.requests[1]!.input).toContainEqual({ type: 'function_call_output', call_id: 'c1', output: 'fixture' })
  // Raw reasoning from a non-tool turn also survives, independently of edited display text.
  const second = await new DeepSeekModel(name, { fetchImpl: new Route([responsesStream(false)]).fetch }).request(messages, {}, params)
  second.parts.find(isThinking)!.content = 'display edited'
  expect(model.mapMessages([second])[1]).toContainEqual(reasoning)
  expect(new DeepSeekModel('other').mapMessages([first])[1].some((i) => i.type === 'reasoning')).toBe(false)
  expect(portableHistory([first], 'openai')[1].dropped_thinking_parts).toBe(1)
})

for (const name of ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx']) test(`${name}: preserved thinking, indexed arguments, full tools, nonempty final usage`, async () => {
  const route = new Route([chatStream(true), chatStream(false)])
  const model = new ZhipuModel(name, { fetchImpl: route.fetch })
  const first = await model.request(messages, { max_tokens: 131072 }, params)
  expect(first.provider_name).toBe('zhipu')
  expect(first.parts.every((p) => p.provider_name === 'zhipu')).toBe(true)
  expect(first.parts.find(isToolCall)!.args).toEqual({ path: 'probe.txt' })
  expect(first.usage).toMatchObject({ input_tokens: 1000, cache_read_tokens: 700, output_tokens: 100 })
  first.parts.find(isThinking)!.content = 'display changed'
  await model.request([...messages, first, modelRequest([toolReturn('read_file', 'fixture', 'c1')])], {}, params)
  expect(route.urls[0]).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')
  expect(route.requests[0]).toMatchObject({ thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: 'max', tool_stream: true, tool_choice: 'auto', max_tokens: 131072 })
  expect(route.requests[0]).not.toHaveProperty('max_completion_tokens')
  expect((route.requests[0]!.tools as unknown[]).length).toBe(tools.length)
  const turns = route.requests[1]!.messages as Record<string, unknown>[]
  expect(turns.find((m) => m.role === 'assistant')!.reasoning_content).toBe('raw\n reasoning  ')
  expect(turns.find((m) => m.role === 'tool')!.tool_call_id).toBe('c1')
  expect(new ZhipuModel('other').mapMessages([first])[0]).not.toHaveProperty('reasoning_content')
})

test('provider effort mapping never disables GLM; DeepSeek off and max remain available', () => {
  const ds = new DeepSeekModel('deepseek-flash'), glm = new ZhipuModel('glm-5.3')
  for (const value of [false, 'off', 'none'] as const) {
    expect(ds.body(messages, {}, { ...params, thinking: value }).reasoning).toEqual({ effort: 'none' })
    expect(glm.body(messages, {}, { ...params, thinking: value })).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'low' })
  }
  for (const level of ['low', 'high', 'max']) {
    expect(ds.body(messages, {}, { ...params, thinking: level }).reasoning).toEqual({ effort: level })
    expect(glm.body(messages, {}, { ...params, thinking: level }).reasoning_effort).toBe(level)
  }
  expect((glm.body(messages, {}, { ...params, function_tools: Array.from({ length: 128 }, (_, i) => ({ ...tools[0]!, name: `t${i}` })) }).tools as unknown[]).length).toBe(128)
  expect(() => glm.body(messages, {}, { ...params, function_tools: Array(129).fill(tools[0]) })).toThrow('128')
  expect(() => glm.body(messages, {}, { ...params, function_tools: [{ ...tools[0]!, name: 'x'.repeat(65) }] })).toThrow('1–64')
})

test('synthetic inserted tool history survives stateless Responses without invented reasoning', () => {
  const history: ModelMessage[] = [...messages, modelResponse([toolCallPart('read_file', { path: 'inserted.txt' }, 'inserted')]), modelRequest([toolReturn('read_file', 'app result', 'inserted'), userPrompt('steer')])]
  const body = new DeepSeekModel('deepseek-flash').body(history, {}, params)
  expect(body.input).toContainEqual({ type: 'function_call', call_id: 'inserted', name: 'read_file', arguments: '{"path":"inserted.txt"}' })
  expect(body.input).toContainEqual({ type: 'function_call_output', call_id: 'inserted', output: 'app result' })
  expect((body.input as Record<string, unknown>[]).some((i) => i.type === 'reasoning')).toBe(false)
})

test('native currencies never mix: CNY remains unknown USD, cached input charged once, peak uncertainty a range', () => {
  const cfg = (name: string) => new ModelConfig(STANDARD_CN_MODELS.find((r) => r.model === name) as never)
  const usage = { input_tokens: 1_000_000, cache_read_tokens: 250_000, output_tokens: 100_000 }
  const weekend = new Date('2026-10-18T02:00:00Z'), peak = new Date('2026-10-19T02:00:00Z')
  expect(estimateCost(usage, cfg('deepseek-flash').pricing, '5m', weekend).slice(0, 2)).toEqual([.17325, 'estimated'])
  expect(estimateCost(usage, cfg('deepseek-flash').pricing, '5m', peak)[0]).toBe(.3465)
  const range = estimateCost(usage, cfg('deepseek-flash').pricing, '5m', new Date('2027-10-18T02:00:00Z'))
  expect(range.slice(0, 2)).toEqual([null, 'unknown'])
  expect(range[2]).toContain('USD 0.17325–0.3465')
  const cny = estimateCost(usage, cfg('glm-5.3').pricing, '5m', weekend)
  expect(cny.slice(0, 2)).toEqual([null, 'unknown'])
  expect(cny[2]).toContain('estimated CNY 9.3')
  expect(cny[2]).toContain('no FX conversion')
  expect(estimateRequestCost(usage, cfg('glm-5.3').pricing, '5m', weekend)).toMatchObject({ cost_cny: 9.3, cost_usd: null, status: 'estimated' })
  for (const date of ['2026-10-01T02:00:00Z', '2026-10-10T02:00:00Z', '2026-10-19T04:00:00Z', '2026-10-19T10:00:00Z'])
    expect(estimateCost(usage, cfg('deepseek-flash').pricing, '5m', new Date(date))[0]).toBe(.17325)
})

test('probe tools exactly match production input schemas, not a miniature test toolset', () => {
  expect(tools.length).toBe(21)
  expect(tools).toEqual(specs().map((s) => ({ name: s.name, description: s.description, parameters_json_schema: parametersSchema(s) })))
})

test('factory uses independently identified models and rereads saved credentials after rotation', async () => {
  const auth = privateAuthDir()
  try {
    for (const provider of ['deepseek', 'zhipu']) {
      const cfg = new ModelConfig(STANDARD_CN_MODELS.find((m) => m.provider === provider) as never)
      await credentialStore().setApiKey(provider, 'synthetic-key-one')
      const route = new Route([provider === 'deepseek' ? responsesStream(false) : chatStream(false)])
      const model = buildModel(cfg, { fetchImpl: route.fetch })
      expect(model.system).toBe(provider)
      expect(model.profile.builtin_tools).toBeUndefined()
      await model.request(messages, {}, params)
      await credentialStore().setApiKey(provider, 'synthetic-key-two')
      await model.request(messages, {}, params)
      expect(route.headers.map((h) => h.get('authorization'))).toEqual(['Bearer synthetic-key-one', 'Bearer synthetic-key-two'])
      await credentialStore().deleteApiKey(provider)
      await expect(model.request(messages, {}, params)).rejects.toThrow('no key')
      expect(route.requests).toHaveLength(2)
    }
  } finally { auth.done() }
})

test('new providers redact upstream errors, reject truncated streams and honor pre-request cancellation', async () => {
  for (const kind of ['deepseek', 'zhipu']) {
    const make = (r: Route) => kind === 'deepseek' ? new DeepSeekModel('deepseek-flash', { fetchImpl: r.fetch, maxRetries: 0 }) : new ZhipuModel('glm-5.3', { fetchImpl: r.fetch, maxRetries: 0 })
    const bad = new Route([JSON.stringify({ error: { message: 'synthetic-key-that-must-not-escape' } })])
    bad.status = 401
    try { await make(bad).request(messages, {}, params); throw new Error('expected rejection') }
    catch (error) {
      expect(String(error)).toContain('request rejected')
      expect(JSON.stringify(error)).not.toContain('synthetic-key-that-must-not-escape')
    }
    const truncated = new Route([kind === 'deepseek' ? sse([{ type: 'response.created', response: {} }]) : sse([{ choices: [{ delta: { content: 'unfinished' } }] }])])
    await expect(make(truncated).request(messages, {}, params)).rejects.toThrow('stream')
    const cancelled = new Route([''])
    await expect(make(cancelled).request(messages, {}, params, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled')
    expect(cancelled.requests).toHaveLength(0)
  }
})

test('image serializers use documented image shapes; metadata advertises only supported routes', () => {
  const image = { kind: 'image' as const, asset_id: 'img', media_type: 'image/png' as const, name: 'fixture.png', bytes: 3, sha256: 'a'.repeat(64), width: 1, height: 1, data: 'AAAA' }
  const history = [modelRequest([userPrompt(['look', image])])]
  const ds = new DeepSeekModel('deepseek-flash').body(history, {}, params)
  expect(JSON.stringify(ds.input)).toContain('"type":"input_image","image_url":"data:image/png;base64,AAAA"')
  for (const name of ['glm-5.3-flash', 'glm-5.3-flashx']) {
    const body = new ZhipuModel(name).body(history, {}, params)
    expect(JSON.stringify(body.messages)).toContain('"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}')
  }
})

test('safe errors retain context/quota diagnosis, and GLM finish reasons do not masquerade as success', async () => {
  const { isContextError } = await import('../src/agent/context.ts')
  for (const message of ['maximum context tokens exceeded synthetic-secret', 'quota exceeded synthetic-secret']) {
    const route = new Route([JSON.stringify({ error: { message } })]); route.status = 400
    try { await new DeepSeekModel('deepseek-flash', { fetchImpl: route.fetch, maxRetries: 0 }).request(messages, {}, params) }
    catch (error) {
      expect(String(error)).not.toContain('synthetic-secret')
      expect(String(error)).toContain(message.startsWith('maximum') ? 'context window exceeded' : 'quota exceeded')
      if (message.startsWith('maximum')) expect(isContextError(error)).toBe(true)
    }
  }
  for (const finish of ['model_context_window_exceeded', 'network_error']) {
    const route = new Route([sse([{ choices: [{ delta: {}, finish_reason: finish }] }])])
    await expect(new ZhipuModel('glm-5.3', { fetchImpl: route.fetch }).request(messages, {}, params)).rejects.toThrow(finish === 'network_error' ? 'network error' : 'context window')
  }
  const { routeLimits } = await import('../src/llm/catalog.ts')
  expect(routeLimits(new ModelConfig(STANDARD_CN_MODELS[0] as never)).request_bytes).toBe(48 * 1024 * 1024)
})

test('HTTP 200 stream failures keep safe context/quota/rate-limit diagnoses without raw secrets', async () => {
  const { ModelHTTPError, ModelAPIError } = await import('../src/llm/model.ts')
  const { isContextError } = await import('../src/agent/context.ts')
  const { safeProbeFailure } = await import('../scripts/standard_provider_probe.ts')
  for (const variant of ['deepseek-failed', 'deepseek-error', 'zhipu']) {
    for (const [code, status, category] of [['context_length_exceeded', 400, 'context_overflow'], ['insufficient_quota', 402, 'quota'], ['rate_limit_exceeded', 429, 'rate_limit'], ['opaque', null, 'protocol']] as const) {
      const error = { code, message: 'arbitrary.fixture-secret-do-not-log', details: { key: 'arbitrary.fixture-secret-do-not-log' } }
      const event = variant === 'deepseek-failed' ? { type: 'response.failed', response: { error } }
        : variant === 'deepseek-error' ? { type: 'error', ...error } : { error }
      const route = new Route([sse([event])])
      const model = variant === 'zhipu' ? new ZhipuModel('glm-5.3', { fetchImpl: route.fetch }) : new DeepSeekModel('deepseek-flash', { fetchImpl: route.fetch })
      const stream = await model.requestStream(messages, {}, params)
      let caught: unknown
      try { for await (const _event of stream.events()) { /* drain, not only open */ } } catch (e) { caught = e }
      expect(caught).toBeInstanceOf(status === null ? ModelAPIError : ModelHTTPError)
      expect(safeProbeFailure(caught)).toEqual({ status, category })
      expect(isContextError(caught)).toBe(category === 'context_overflow')
      expect(String(caught)).not.toContain('fixture-secret')
      expect(JSON.stringify(caught)).not.toContain('fixture-secret')
      expect(caught).not.toHaveProperty('cause')
    }
  }
})

test('GLM function limit accepts 128 and refuses 129 without a request or truncation', async () => {
  const route = new Route([chatStream(false)])
  const model = new ZhipuModel('glm-5.3', { fetchImpl: route.fetch })
  const functions = Array.from({ length: 129 }, (_, i) => ({ ...tools[0]!, name: `tool_${i}` }))
  expect((model.body(messages, {}, { ...params, function_tools: functions.slice(0, 128) }).tools as unknown[]).length).toBe(128)
  await expect(model.request(messages, {}, { ...params, function_tools: functions })).rejects.toThrow('128')
  expect(route.requests).toHaveLength(0)
})

for (const raw of STANDARD_CN_MODELS) test(`${raw.id}: two successive tool rounds and endpoint/provider isolation`, async () => {
  const cfg = new ModelConfig(raw as never)
  const ds = cfg.provider === 'deepseek'
  const route = new Route(ds ? [responsesStream(true), responsesStream(true), responsesStream(false)] : [chatStream(true), chatStream(true), chatStream(false)])
  const model = ds ? new DeepSeekModel(cfg.model, { fetchImpl: route.fetch }) : new ZhipuModel(cfg.model, { fetchImpl: route.fetch })
  const history: ModelMessage[] = [...messages]
  for (let i = 0; i < 2; i++) {
    const response = await model.request(history, {}, params)
    const call = response.parts.find(isToolCall)!
    expect(call.tool_name).toBe('read_file')
    history.push(response, modelRequest([toolReturn('read_file', 'fixture', call.tool_call_id)]))
  }
  const final = await model.request(history, {}, params)
  expect(final.parts.some(isToolCall)).toBe(false)
  expect(route.requests).toHaveLength(3)
  const foreign = ds ? new DeepSeekModel(cfg.model, { baseUrl: 'https://other.example' }) : new ZhipuModel(cfg.model, { baseUrl: 'https://other.example' })
  const foreignBody = JSON.stringify(foreign.body(history, {}, params))
  expect(foreignBody).not.toContain('raw\\n reasoning')
  const other = ds ? new ZhipuModel('glm-5.3') : new DeepSeekModel('deepseek-flash')
  expect(JSON.stringify(other.body(history, {}, params))).not.toContain('raw\\n reasoning')
})
