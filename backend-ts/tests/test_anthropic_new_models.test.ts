/** Official declarations checked 2026-10-25 by the project; injected fetch only, never a live probe. */
import { expect, test } from 'bun:test'
import { PricingSchema, type ModelRequestRecord } from '@oasis-code/contract'
import { saveKey, forgetKey } from '../src/auth/keys.ts'
import { DEFAULT_MODELS, ModelConfig } from '../src/config.ts'
import { supportedThinking } from '../src/llm/catalog.ts'
import { buildModel } from '../src/llm/providers.ts'
import { mapUsage, thinkingFields } from '../src/llm/providers/anthropic.ts'
import { modelRequest, userPrompt, modelResponse, textPart } from '../src/llm/messages.ts'
import { estimateRequestCost, UsageMeter } from '../src/llm/usage.ts'
import { ScriptedModel } from '../src/llm/scripted.ts'
import { privateAuthDir, Route } from './helpers.ts'

const cfg = (model: string) => new ModelConfig(DEFAULT_MODELS.find(m => m.id === `anthropic-api:${model}`) as never)
const adaptive = { type: 'adaptive', display: 'summarized' }

for (const name of ['claude-fable-5-1', 'claude-haiku-5-5']) {
  test(`${name}: API-only addition, official capability evidence and isolated key routing / thinking wire`, async () => {
    const auth = privateAuthDir()
    const key = ['offline', 'synthetic', 'stored', '1234'].join('-')
    const envKey = ['offline', 'synthetic', 'env', '5678'].join('-')
    process.env.ANTHROPIC_API_KEY = envKey
    try {
      await saveKey('anthropic-api', key)
      const config = cfg(name)
      expect(config.auth).toBe('api_key')
      expect(config.key_env).toBe('ANTHROPIC_API_KEY')
      expect(config.context_window).toBe(1_000_000)
      expect(config.max_tokens).toBe(128_000)
      expect(config.capabilities).toMatchObject({ images: true, pdf: true })
      for (const source of [config.window_source, config.capability_source]) {
        expect(source).toContain('https://platform.claude.com/docs/en/models/overview')
        expect(source).toContain('checked 2026-10-25')
        expect(source).toContain('not live probed')
      }
      const mock = new Route([JSON.stringify({ id: 'fixture', model: name, stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 1 } })], 'application/json')
      const model = buildModel(config, { fetchImpl: mock.fetch, maxRetries: 0 })
      for (const thinking of [null, 'medium', 'off', 'low', 'high', 'xhigh', 'max'] as const) {
        await model.request([modelRequest([userPrompt('hi')], 'be brief')], { max_tokens: config.max_tokens }, {
          function_tools: [], allow_text_output: true, thinking,
        })
        const body = mock.requests.at(-1)!
        expect(body.model).toBe(name)
        expect(body.max_tokens).toBe(128_000)
        expect(body.thinking).toEqual(thinking === 'off' && name === 'claude-haiku-5-5' ? { type: 'disabled' } : adaptive)
        expect(body.output_config).toEqual(thinking === null || (thinking === 'off' && name === 'claude-haiku-5-5')
          ? undefined : { effort: thinking === 'off' ? 'low' : thinking })
        expect(JSON.stringify(body)).not.toContain('budget_tokens')
        expect(JSON.stringify(body.system)).not.toMatch(/Claude Code|billing-header|oauth/i)
        const headers = mock.headers.at(-1)!
        // Compare booleans so even assertion failures do not print a key.
        expect(headers.get('x-api-key') === key).toBe(true)
        expect(headers.get('authorization')).toBeNull()
        expect(headers.get('anthropic-beta') ?? '').not.toContain('oauth')
        expect(headers.get('anthropic-version')).toBe('2023-06-01')
        expect(mock.urls.at(-1)).toBe('https://api.anthropic.com/v1/messages')
      }
      await forgetKey('anthropic-api')
      await model.request([], {}, { function_tools: [], allow_text_output: true, thinking: null })
      expect(mock.headers.at(-1)!.get('x-api-key') === envKey).toBe(true)
    } finally { delete process.env.ANTHROPIC_API_KEY; auth.done() }
  })
}

test('catalog exposes true disabled, never mislabels between-tools / lowest-effort as off', () => {
  expect(supportedThinking(cfg('claude-haiku-5-5'))).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max'])
  expect(supportedThinking(cfg('claude-sonnet-5'))).toContain('off')
  for (const model of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5']) expect(supportedThinking(cfg(model))).not.toContain('off')
  expect(DEFAULT_MODELS.some(m => m.id === 'anthropic:claude-haiku-5-5')).toBe(false)
  expect(thinkingFields('claude-haiku-5-5', false, 128_000)).toEqual({ thinking: { type: 'disabled' } })
})

for (const prompt of [99_999, 100_000, 100_001]) {
  for (const ttl of ['5m', '1h'] as const) {
    test(`Haiku inclusive prompt ${prompt}, ${ttl}: all categories use the selected whole-request tariff`, () => {
      // Caches alone reach the threshold; adding them twice would misprice the <=100k cases.
      const usage = mapUsage({ input_tokens: 0, cache_read_input_tokens: 40_000,
        cache_creation_input_tokens: prompt - 40_000, output_tokens: 20_000 })!
      expect(usage.input_tokens).toBe(prompt)
      const high = prompt > 100_000
      const expected = Math.round((40_000 * (high ? .05 : .01) + (prompt - 40_000) *
        (ttl === '1h' ? (high ? 1 : .2) : (high ? .625 : .125)) + 20_000 * (high ? 2.5 : .5))) / 1e6
      const cost = estimateRequestCost(usage, cfg('claude-haiku-5-5').pricing, ttl)
      expect(cost).toMatchObject({ cost_usd: expected, cost_cny: null, status: 'estimated' })
      expect(cost.source).toContain(high ? 'prompt >100000; long-context whole-request rates' : 'prompt <=100000; base whole-request rates')
      const uncached = estimateRequestCost({ input_tokens: prompt, output_tokens: 20_000 }, cfg('claude-haiku-5-5').pricing, ttl)
      expect(uncached.cost_usd).toBe(Math.round(prompt * (high ? .5 : .1) + 20_000 * (high ? 2.5 : .5)) / 1e6)
    })
  }
}

test('request records retain their own tariff; later long prompts do not reprice earlier requests', async () => {
  const config = cfg('claude-haiku-5-5')
  const records: ModelRequestRecord[] = []
  for (const input_tokens of [100_000, 100_001, 99_999]) {
    const model = new ScriptedModel(() => modelResponse([textPart('ok')]), { usage: { input_tokens, output_tokens: 20_000, cache_read_tokens: 0, cache_write_tokens: 0 } })
    const meter = new UsageMeter(model, config, 'fixture', r => records.push(r), () => {})
    await meter.request([], {}, { function_tools: [], allow_text_output: true, thinking: null })
  }
  expect(records.map(r => r.cost_usd)).toEqual([.02, .100001, .02])
  expect(records.map(r => r.cost_source?.includes('long-context'))).toEqual([false, true, false])
})

test('Fable rates, optional schema compatibility, generic currency separation and dated replacement', () => {
  const pricing = cfg('claude-fable-5-1').pricing!
  expect(pricing).toMatchObject({ input_per_mtok: 10, output_per_mtok: 50, cache_read_per_mtok: .25, cache_write_per_mtok: 12.5, cache_write_1h_per_mtok: 20 })
  const usage = { input_tokens: 100_000, cache_read_tokens: 30_000, cache_write_tokens: 20_000, output_tokens: 10_000 }
  expect(estimateRequestCost(usage, pricing, '5m').cost_usd).toBe(1.2575)
  expect(estimateRequestCost(usage, pricing, '1h').cost_usd).toBe(1.4075)
  expect(Object.hasOwn(PricingSchema.parse({ input_per_mtok: 1, output_per_mtok: 2, source: 'fixture', version: '1' }), 'long_context')).toBe(false)
  const haiku = cfg('claude-haiku-5-5').pricing!
  expect(estimateRequestCost({ input_tokens: 100_001 }, { ...haiku, currency: 'CNY' })).toMatchObject({ cost_usd: null, cost_cny: .050001, status: 'estimated' })
  const next = { from: '2026-11-01', input_per_mtok: 1, output_per_mtok: 2, cache_read_per_mtok: null, cache_write_per_mtok: null, version: 'next' }
  const result = estimateRequestCost({ input_tokens: 100_001 }, { ...haiku, next }, '5m', new Date('2026-11-01T00:00:00Z'))
  expect(result.cost_usd).toBe(.100001)
  expect(result.source).not.toContain('long-context')
})
