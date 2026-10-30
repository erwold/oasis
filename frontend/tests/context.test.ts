import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ContextReport } from '../src/api/types'
import { contextGauge, tokensText } from '../src/state/context.ts'

const base = (over: Partial<ContextReport> = {}): ContextReport => ({
  schema_version: 'context_report.v2', session_id: 's', model_id: 'r:a', total_bytes: 20480, total_tokens: 5000, tokenizer: 'o200k_base',
  tokens_basis: 'counted', context_window: 1_000_000, context_window_source: 'configured', budget_tokens: 500_000, budget_source: 'x',
  budget_note: 'n', bytes_basis: 'b', tokens_est: 6000, estimate_basis: 'the keeper', segments: [], per_message: [],
  tools: [],
  history: { messages: 0, raw_bytes: 0, content_bytes: 0, wire_bytes: 0, wire_tokens: 0, compactions: 0, tool_returns: 0, model_turns: 0, user_turns: 0, bytes_basis: '' },
  last_run: null, ...over,
})
const seg = (key: string, tokens_est: number) => ({ key, label: `${key} (detail)`, bytes: 1, tokens: null, tokens_est, share: 0, sent: '' })

test('token words', () => {
  assert.equal(tokensText(950), '950')
  assert.equal(tokensText(166_541), '166.5k')
  assert.equal(tokensText(null), '—')
})

test("the gauge measures the keeper's prediction against the window and the compaction threshold", () => {
  const g = contextGauge(base({ total_tokens: 1, tokens_est: 500_000, budget_tokens: 900_000, segments: [seg('instructions', 100_000), seg('history', 400_000)] }))
  assert.equal(g.headline, '≈500.0k / 1.0M (50%)')                       // the prediction, not the o200k count of the text
  assert.equal(g.share, 0.5)
  assert.equal(g.level, 'ok')
  assert.deepEqual(g.rows.map((r) => [r.key, r.label, r.size, r.share]), [
    ['instructions', 'instructions', '≈100.0k', 0.1], ['history', 'history', '≈400.0k', 0.4],
    ['free', 'Free space', '400.0k', 0.4], ['buffer', 'Compaction buffer', '100.0k', 0.1],
  ])
  assert.equal(contextGauge(base({ tokens_est: 700_000, budget_tokens: 900_000 })).level, 'warm')
  assert.equal(contextGauge(base({ tokens_est: 850_000, budget_tokens: 900_000 })).level, 'high')
})

test('without a window the gauge has no ring share and no room rows; segments are shares of the request', () => {
  const g = contextGauge(base({ context_window: null, tokens_est: 4000, segments: [seg('instructions', 1000), seg('history', 3000)] }))
  assert.equal(g.share, null)
  assert.match(g.headline, /^≈4\.0k \/ window unknown/)
  assert.deepEqual(g.rows.map((r) => [r.key, r.share]), [['instructions', 0.25], ['history', 0.75]])
})
