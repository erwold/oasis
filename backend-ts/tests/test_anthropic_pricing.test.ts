import { expect, test } from 'bun:test'
import type { ModelRequestRecord } from '@oasis-code/contract'
import { DEFAULT_MODELS, ModelConfig } from '../src/config.ts'
import { mapUsage } from '../src/llm/providers/anthropic.ts'
import { estimateRequestCost, UsageMeter } from '../src/llm/usage.ts'
import { ScriptedModel } from '../src/llm/scripted.ts'
import { modelResponse, textPart } from '../src/llm/messages.ts'

const route = (id: string, cache_ttl: '5m' | '1h' = '5m') => {
  const entry = DEFAULT_MODELS.find((m) => m.id === id)
  expect(entry).toBeDefined()
  return new ModelConfig({ ...entry, cache_ttl } as ConstructorParameters<typeof ModelConfig>[0])
}
const source = 'https://platform.claude.com/docs/en/about-claude/pricing@2026-10-25'
const millionReads = mapUsage({ input_tokens: 0, cache_read_input_tokens: 1_000_000, output_tokens: 0 })!

test('Sonnet 5.5 million cache reads cost USD 0.10, without changing Sonnet 5 or Opus 5.5', () => {
  const cfg = route('anthropic-api:claude-sonnet-5-5')
  expect(cfg.pricing).toMatchObject({ input_per_mtok: 2, output_per_mtok: 10, cache_read_per_mtok: .1,
    cache_write_per_mtok: 2.5, cache_write_1h_per_mtok: 4, version: '2026-10-25' })
  expect(estimateRequestCost(millionReads, cfg.pricing)).toEqual({ cost_usd: .1, cost_cny: null, status: 'estimated', source })
  for (const id of ['anthropic-api:claude-sonnet-5', 'anthropic-api:claude-opus-5-5']) {
    expect(estimateRequestCost(millionReads, route(id).pricing)).toMatchObject({ cost_usd: .2, status: 'estimated' })
  }
})

// Anthropic reports uncached input separately; exercise its inclusive mapping before pricing.
const mixed = mapUsage({ input_tokens: 20_000, cache_read_input_tokens: 300_000,
  cache_creation_input_tokens: 40_000, output_tokens: 5_000 })!
for (const [ttl, dollars] of [['5m', .22], ['1h', .28]] as const) {
  test(`Sonnet 5.5 ${ttl} mixed usage reaches USD request records, events and totals; OAuth stays unknown`, async () => {
    expect(mixed.input_tokens).toBe(360_000)
    // 20k * $2 + 300k * $0.10 + 40k * ($2.50 or $4) + 5k * $10, per million.
    for (const api of [true, false]) {
      const cfg = route(`${api ? 'anthropic-api' : 'anthropic'}:claude-sonnet-5-5`, ttl)
      if (!api) expect(cfg.pricing).toBeNull()
      const records: ModelRequestRecord[] = [], events: Record<string, unknown>[] = []
      const model = new ScriptedModel(() => modelResponse([textPart('offline fixture')]), { usage: mixed })
      const meter = new UsageMeter(model, cfg, 'fixture_run', (r) => records.push(r), (_event, data) => events.push(data))
      await meter.request([], {}, { function_tools: [], allow_text_output: true, thinking: null })
      const expected = { cost_usd: api ? dollars : null, cost_cny: null,
        cost_status: api ? 'estimated' : 'unknown', cost_source: api ? `${source}; Anthropic cache_creation_input_tokens=40000; cache write configured ${ttl} TTL fallback (breakdown absent)` : null }
      expect(records).toHaveLength(1)
      const { details: _details, ...tokens } = mixed
      expect(records[0]).toMatchObject({ ...expected, ...tokens })
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject(expected)
      expect(meter.totalsWithTokens()).toMatchObject(expected)
    }
  })
}
