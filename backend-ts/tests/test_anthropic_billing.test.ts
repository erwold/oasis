/** Offline provider -> meter -> storage/receipt coverage. No credentials or live HTTP. */
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { PricingSchema, ReceiptSchema, type ModelRequestRecord } from '@oasis-code/contract'
import { DEFAULT_MODELS, ModelConfig } from '../src/config.ts'
import { connect } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { AnthropicModel, mapUsage } from '../src/llm/providers/anthropic.ts'
import { UsageMeter, estimateRequestCost } from '../src/llm/usage.ts'
import { Route, sse, tempDir } from './helpers.ts'
import { appState, buggyRepo, closeState, openSession, testConfig, waitDone } from './harness.ts'

const config = (model = 'claude-sonnet-5-5', extra: Record<string, unknown> = {}) => new ModelConfig({
  ...DEFAULT_MODELS.find(m => m.id === `anthropic-api:${model}`), cache_ttl: '1h', ...extra,
} as never)
const params = { function_tools: [], allow_text_output: true, thinking: null }
const searchParams = { ...params, builtin_tools: [{ kind: 'web_search' as const, max_uses: 5 }] }
const base = { input_tokens: 25, output_tokens: 15 }
const mixed = { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 10_000,
  cache_creation: { ephemeral_5m_input_tokens: 6_000, ephemeral_1h_input_tokens: 4_000 }, server_tool_use: { web_search_requests: 2 } }
const searchError = { type: 'web_search_tool_result', tool_use_id: 'fixture_tool', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } }
const searchCall = { type: 'server_tool_use', id: 'fixture_tool', name: 'web_search', input: { query: 'fixture' } }
const provider = (route: Route, cfg = config()) => new AnthropicModel(cfg.model, {
  apiKey: ['offline', 'synthetic', 'fixture'].join('-'), baseUrl: 'https://fixture.invalid', fetchImpl: route.fetch, maxRetries: 0,
})
const response = (usage: unknown, blocks: unknown[] = [], stop_reason = 'end_turn') => JSON.stringify({ model: 'fixture-model', usage,
  content: [...blocks, { type: 'text', text: 'offline answer' }], stop_reason })
const event = (type: string, data: Record<string, unknown> = {}): [string, unknown] => [type, { type, ...data }]
function streamBody(start: unknown, deltas: unknown[], end = true, blocks: unknown[] = []): string {
  return sse([event('message_start', { message: { model: 'fixture-model', usage: start } }),
    ...blocks.map((content_block, index) => event('content_block_start', { index: index + 1, content_block })),
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ...deltas.map(usage => event('message_delta', { usage })),
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'offline answer' } }),
    event('content_block_stop', { index: 0 }),
    ...(end ? [event('message_delta', { delta: { stop_reason: 'end_turn' } }), event('message_stop')] : [])])
}
async function metered(usage: unknown, options: { cfg?: ModelConfig; blocks?: unknown[]; search?: boolean; stop?: string } = {}) {
  const cfg = options.cfg ?? config(), rows: ModelRequestRecord[] = []
  const model = provider(new Route([response(usage, options.blocks, options.stop)], 'application/json'), cfg)
  const meter = new UsageMeter(model, cfg, 'fixture', r => rows.push(r), () => {})
  const result = await meter.request([], {}, options.search ? searchParams : params)
  return { row: rows[0]!, meter, result }
}

test('all five API lists declare search prices; optional schema and OAuth remain compatible', () => {
  const routes = DEFAULT_MODELS.filter(m => String(m.id).startsWith('anthropic-api:')).map(m => new ModelConfig(m as never))
  expect(routes).toHaveLength(5)
  expect(routes.every(m => m.pricing?.web_search_per_request === .01)).toBe(true)
  for (const m of DEFAULT_MODELS.filter(m => String(m.id).startsWith('anthropic:'))) expect(new ModelConfig(m as never).pricing).toBeNull()
  expect(PricingSchema.parse({ input_per_mtok: 1, output_per_mtok: 2, source: 'fixture', version: '1' }).web_search_per_request).toBeUndefined()
  expect(PricingSchema.safeParse({ ...config().pricing, web_search_per_request: -1 }).success).toBe(false)
})

test('ordinary response and explicit 0/1/multiple searches: only usage counter bills, never content blocks', async () => {
  expect((await metered(base)).row).toMatchObject({ cost_usd: .0002, cost_status: 'estimated' })
  for (const count of [0, 1, 3]) {
    // Hidden results do not remove charges; a pause_turn call block does not create one.
    const { row, result } = await metered({ ...base, server_tool_use: { web_search_requests: count } }, { search: true,
      blocks: count === 0 ? [searchCall] : [], stop: count === 0 ? 'pause_turn' : 'end_turn' })
    expect(row.cost_usd).toBeCloseTo(.0002 + count * .01, 6)
    expect(row.cost_source).toContain(`web_search_requests=${count}`)
    expect(result.usage?.details?.web_search_requests).toBe(count)
  }
  const missing = await metered(base, { blocks: [searchCall], stop: 'pause_turn' })
  expect(missing.row.cost_status).toBe('unknown')
  expect(missing.row.cost_source).toContain('not billing counts')
})

test('custom rates/currency are authoritative; missing search price and OAuth are unknown, not zero', async () => {
  const pricing = { ...config().pricing!, web_search_per_request: undefined }
  const usage = { ...base, server_tool_use: { web_search_requests: 2 } }
  expect((await metered(usage, { cfg: config(undefined, { pricing }) })).row).toMatchObject({ cost_usd: null, cost_status: 'unknown' })
  expect((await metered({ ...base, server_tool_use: { web_search_requests: 0 } }, { cfg: config(undefined, { pricing }) })).row.cost_usd).toBe(.0002)
  const custom = config(undefined, { pricing: { ...pricing, currency: 'CNY', web_search_per_request: .7 } })
  expect((await metered(usage, { cfg: custom })).row).toMatchObject({ cost_usd: null, cost_cny: 1.4002, cost_status: 'estimated' })
  const oauth = new ModelConfig(DEFAULT_MODELS.find(m => m.id === 'anthropic:claude-sonnet-5-5') as never)
  expect((await metered(usage, { cfg: oauth })).row).toMatchObject({ cost_usd: null, cost_cny: null, cost_status: 'unknown', cost_source: null })
})

test('JSON response -> UsageMeter -> actual model_requests roundtrip retains mixed TTL/search basis without migration', async () => {
  const db = connect(join(tempDir(), 'billing.db'))
  try {
    db.run("INSERT INTO projects (id,name,base_repo_path,created_at,updated_at) VALUES ('p','p','/fixture','t','t')")
    db.run("INSERT INTO sessions (id,project_id,title,model,created_at,updated_at) VALUES ('s','p','s','m','t','t')")
    db.run("INSERT INTO runs (id,session_id,project_id,model,user_text,status,created_at) VALUES ('r','s','p','m','hi','done','t')")
    const cfg = config(), model = provider(new Route([response(mixed)], 'application/json'))
    const meter = new UsageMeter(model, cfg, 'r', r => repo.insertModelRequest(db, r), () => {})
    await meter.request([], {}, searchParams)
    const row = repo.listModelRequests(db, 'r')[0]!
    expect(row).toMatchObject({ input_tokens: 40_000, cache_read_tokens: 20_000, cache_write_tokens: 10_000, output_tokens: 1_000,
      cost_usd: .083, cost_cny: null, cost_status: 'estimated' })
    expect(row.cost_source).toContain('ephemeral_5m_input_tokens=6000')
    expect(row.cost_source).toContain('ephemeral_1h_input_tokens=4000')
    expect(meter.totalsWithTokens().cost_usd).toBe(.083)
  } finally { db.close() }
})

test('SSE cumulative/nested merging -> persisted run, request event and receipt totals', async () => {
  const cfg = config()
  const wire = streamBody({ ...mixed, output_tokens: 1, server_tool_use: { web_search_requests: 0 } }, [
    { output_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 6_000 } },
    { output_tokens: 500, server_tool_use: { web_search_requests: 1 } },
    { output_tokens: 1_000, input_tokens: null, cache_creation: { ephemeral_1h_input_tokens: null }, server_tool_use: { web_search_requests: 2 } },
    { output_tokens: null, server_tool_use: {} },
  ])
  const state = await appState({ config: testConfig([cfg]), models: { [cfg.id]: provider(new Route([wire])) } })
  try {
    const { session } = await openSession(state, buggyRepo(), cfg.id)
    const run = await waitDone(state, (await state.runs.start(session, 'hello')).id)
    expect(run.status).toBe('done')
    expect(run.usage).toMatchObject({ input_tokens: 40_000, output_tokens: 1_000, cost_usd: .083, cost_status: 'estimated' })
    expect(ReceiptSchema.parse(run.receipt).mechanical).toMatchObject({ cost_usd: .083, cost_cny: null, cost_status: 'estimated' })
    expect(repo.listModelRequests(state.conn, run.id)[0]).toMatchObject({ cost_usd: .083, cost_status: 'estimated' })
    expect(repo.listEvents(state.conn, run.id).find(e => e.event === 'model_request')!.data.cost_usd).toBe(.083)
  } finally { await closeState(state) }
})

test('output-only deltas preserve input/cache; explicit zero replaces any prior count, never max/add/truthy', async () => {
  for (const [start, deltas, expected] of [
    [{ input_tokens: 25, output_tokens: 1 }, [{ output_tokens: 10 }, { output_tokens: 15 }], { input_tokens: 25, output_tokens: 15, cache_read_tokens: 0, cache_write_tokens: 0 }],
    [{ input_tokens: 25, output_tokens: 1, cache_read_input_tokens: 100 },
      [{ input_tokens: 10682, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 510, server_tool_use: { web_search_requests: 1 } }],
      { input_tokens: 10682, output_tokens: 510, cache_read_tokens: 0, cache_write_tokens: 0 }],
    [mixed, [{ output_tokens: 200 }, { output_tokens: 300 }], { input_tokens: 40_000, output_tokens: 300, cache_read_tokens: 20_000, cache_write_tokens: 10_000 }],
    [mixed, [{ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, server_tool_use: { web_search_requests: 0 } }, { output_tokens: 1 }],
      { input_tokens: 0, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 }],
  ] as const) {
    const rows: ModelRequestRecord[] = [], cfg = config()
    const meter = new UsageMeter(provider(new Route([streamBody(start, [...deltas])])), cfg, 'fixture', r => rows.push(r), () => {})
    const stream = await meter.requestStream([], {}, params)
    for await (const _ of stream.events()) { /* drain */ }
    expect(stream.usage()).toMatchObject(expected)
    expect(stream.get().usage).toMatchObject(expected)
    expect(rows[0]).toMatchObject({ ...expected, cost_status: 'estimated' })
    if (expected.input_tokens === 0) {
      expect(stream.usage()?.details?.web_search_requests).toBe(0)
      expect(rows[0]!.cost_usd).toBe(.00001)
    }
  }
})

test('valid TTL split beats configured TTL, including Haiku inclusive 100k threshold', async () => {
  for (const prompt of [100_000, 100_001]) {
    const usage = { input_tokens: prompt - 90_000, output_tokens: 20_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 40_000,
      cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 30_000 } }
    const expected = prompt === 100_000 ? .01875 : .093751
    for (const cache_ttl of ['5m', '1h']) {
      const { row } = await metered(usage, { cfg: config('claude-haiku-5-5', { cache_ttl }) })
      expect(row.cost_usd).toBe(expected)
      expect(row.cost_source).toContain(prompt === 100_000 ? 'base whole-request' : 'long-context whole-request')
    }
  }
})


test('all-zero server counters alone do not turn a single Haiku prompt into multi-iteration billing', async () => {
  for (const prompt of [100_000, 100_001]) {
    // No blocks, iterations or TTL breakdown; zeros explicitly rule out these tool executions.
    const raw = { input_tokens: prompt - 90_000, output_tokens: 20_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 40_000,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 } }
    const { row } = await metered(raw, { cfg: config('claude-haiku-5-5'), search: true })
    expect(row).toMatchObject({ cost_status: 'estimated', cost_usd: prompt === 100_000 ? .0195 : .097501 })
    expect(row.cost_source).toContain(prompt === 100_000 ? 'base whole-request' : 'long-context whole-request')
    expect(row.cost_source).toContain('configured 1h TTL fallback')
    expect((await metered({ ...raw, server_tool_use: { web_search_requests: 0, unknown_requests: 1 } },
      { cfg: config('claude-haiku-5-5') })).row.cost_status).toBe('unknown')
  }
  const declaredOnly = await metered(base, { search: true })
  expect(declaredOnly.row.cost_source).toContain('web_search_requests missing')
  expect(declaredOnly.row.cost_status).toBe('unknown')
})

test('partial/invalid/inconsistent TTL splits and absent aggregate never masquerade as exact billing', async () => {
  const plain = { input_tokens: 25, output_tokens: 15, cache_creation_input_tokens: 100 }
  for (const split of [{}, { ephemeral_5m_input_tokens: 100 }, { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 30 },
    ...['40', -1, .5, {}, true].map(value => ({ ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: value }))]) {
    expect((await metered({ ...plain, cache_creation: split })).row).toMatchObject({ cost_usd: null, cost_status: 'unknown' })
  }
  expect((await metered({ ...base, cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40 } })).row.cost_status).toBe('unknown')
  for (const bad of [NaN, Infinity]) {
    expect(estimateRequestCost(mapUsage({ ...plain, cache_creation: { ephemeral_5m_input_tokens: bad, ephemeral_1h_input_tokens: 0 } })!, config().pricing).status).toBe('unknown')
  }
  const old = await metered(plain)
  expect(old.row.cost_status).toBe('estimated')
  expect(old.row.cost_source).toContain('configured 1h TTL fallback')
  const tool = await metered({ ...plain, server_tool_use: { web_search_requests: 1 } })
  expect(tool.row.cost_status).toBe('unknown')
  expect(tool.row.cost_source).toContain('TTL breakdown missing')
})

test('invalid search counters and untrusted nested fields are bounded numeric evidence only', async () => {
  for (const bad of ['1', -1, .5, {}, true]) {
    const { row } = await metered({ ...base, server_tool_use: { web_search_requests: bad } })
    expect(row).toMatchObject({ cost_status: 'unknown', cost_usd: null })
  }
  const usage = mapUsage({ ...base, cache_creation: { unexpected: { secret: 'not retained' } },
    server_tool_use: { web_search_requests: 1 }, unexpected: 'not retained' })!
  expect(usage.details).toEqual({ anthropic_usage: 1, anthropic_cache_creation: 1, anthropic_server_tool_usage: 1, web_search_requests: 1 })
})

test('HTTP200 search errors retain original counts, never subtract blocks or claim precise charge', async () => {
  const { row, result } = await metered({ ...base, server_tool_use: { web_search_requests: 2 } }, { blocks: [searchError] })
  expect(row).toMatchObject({ status: 'ok', cost_status: 'unknown', cost_usd: null })
  expect(row.cost_source).toContain('web_search_requests=2')
  expect(row.cost_source).toContain('no error-block subtraction')
  expect(result.usage?.details).toMatchObject({ web_search_requests: 2, anthropic_search_error: 1 })
  const rows: ModelRequestRecord[] = []
  const meter = new UsageMeter(provider(new Route([streamBody(base, [{ server_tool_use: { web_search_requests: 2 } }], true, [searchError])])),
    config(), 'fixture', r => rows.push(r), () => {})
  const stream = await meter.requestStream([], {}, searchParams)
  for await (const _ of stream.events()) { /* drain */ }
  expect(rows[0]).toMatchObject({ cost_status: 'unknown', cost_usd: null })
  expect(rows[0]!.cost_source).toContain('web_search_requests=2')
})

test('complex iterations and server-tool Haiku aggregates do not invent a whole-request tariff', async () => {
  const usage = { input_tokens: 120_000, output_tokens: 15, iterations: [{ input_tokens: 60_000 }, { input_tokens: 60_000 }] }
  for (const model of ['claude-sonnet-5-5', 'claude-haiku-5-5']) {
    const { row } = await metered(usage, { cfg: config(model) })
    expect(row).toMatchObject({ input_tokens: 120_000, cost_usd: null, cost_status: 'unknown' })
    expect(row.cost_source).toContain('no iteration totals added')
  }
  const beyondWindow = await metered({ ...usage, input_tokens: 1_200_000 })
  expect(beyondWindow.row.cost_source).toContain('no iteration totals added')
  expect(beyondWindow.row.cost_status).toBe('unknown')
  const haiku = await metered({ ...mixed, input_tokens: 90_000 }, { cfg: config('claude-haiku-5-5') })
  expect(haiku.row.cost_status).toBe('unknown')
  expect(haiku.row.cost_source).toContain('aggregate input is not a single prompt')
})

test('truncated, provider-error and early-consumer-stop streams keep costs unknown; mixed totals become partial', async () => {
  const bodies = [streamBody(base, []), streamBody(base, [], false),
    streamBody(base, [], false) + sse([event('error', { error: { type: 'overloaded_error' } })]), streamBody(base, []),
    streamBody(base, [], false) + sse([event('message_delta', { delta: { stop_reason: 'end_turn' } })])]
  const rows: ModelRequestRecord[] = [], cfg = config()
  const meter = new UsageMeter(provider(new Route(bodies)), cfg, 'fixture', r => rows.push(r), () => {})
  for (let i = 0; i < bodies.length; i++) {
    const stream = await meter.requestStream([], {}, params)
    const consume = async () => { for await (const _ of stream.events()) { if (i === 3) break } }
    if (i === 1 || i === 2) await expect(consume()).rejects.toThrow()
    else await consume()
    expect(rows[i]!.cost_status).toBe(i === 0 ? 'estimated' : 'unknown')
    if (i > 0) expect(rows[i]!.cost_source).toContain('incomplete Anthropic stream')
  }
  expect(meter.totalsWithTokens()).toMatchObject({ cost_status: 'partial', cost_usd: .0002 })
})
