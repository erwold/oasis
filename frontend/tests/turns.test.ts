import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ReceiptSchema } from '@oasis-code/contract'
import type { Receipt } from '../src/api/types'
import type { ThreadEntry } from '../src/state/thread.ts'
import { cacheNote, cachedShare, connectorOf, contextTokens, tokenCountsText, turnFooter, turnParts } from '../src/state/turns.ts'

// the receipt as the runner writes it: parsed through its schema, every default filled
const receipt = (over: Partial<Receipt['mechanical']> = {}): Receipt => ReceiptSchema.parse({ version: 2, run_id: 'r', status: 'done', error: null, final_text: '', finished_at: null,
  mechanical: { requests: 3, tool_calls: 1, refused_calls: 0, gated_calls: 0, segments: 1, usage: { input_tokens: 12000, output_tokens: 800, cache_read_tokens: 9000 },
    cost_usd: null, cost_status: 'unknown', cost_source: null, provider_models: [], executions: [], checkpoints: [], budget_exceeded: null, budget_reached: null, ...over } })

test('the footer names requests, tools, tokens with the cached share and money as a word; no verdict', () => {
  assert.equal(cachedShare({ input_tokens: 12000, cache_read_tokens: 9000 }), 0.75)
  assert.equal(cachedShare({ input_tokens: 0, cache_read_tokens: 0 }), null)
  const text = turnFooter(receipt())
  assert.match(text, /^3 requests · 1 tool · 12k in \(75% cached\) \/ 800 out · cost unknown/)
  assert.doesNotMatch(text, /verdict/)
  assert.doesNotMatch(turnFooter(receipt({ usage: { input_tokens: 500, output_tokens: 5 } })), /cached/)
  assert.doesNotMatch(turnFooter(receipt()), /\$0\.00/)
})

test('a route that counts nothing (ChatGPT on the web) reads as such: no 0 in / 0 out, its plan named as the cost', () => {
  const chat = turnFooter(receipt({ requests: 1, tool_calls: 0, usage: { input_tokens: null, output_tokens: null }, cost_source: 'the ChatGPT plan, not metered here' }))
  assert.equal(chat, '1 request · 0 tools · tokens not reported · cost unknown (the ChatGPT plan, not metered here)')
})

test('a run partly counted says how many requests were not, and one counted not at all says the provider reported none', () => {
  const partial = turnFooter(receipt({ requests: 3, usage: { input_tokens: 500, output_tokens: 5, uncounted_requests: 1 }, cost_usd: 0.002, cost_status: 'partial' }))
  assert.equal(partial, '3 requests · 1 tool · 500 in / 5 out (1 of 3 requests not counted) · cost at least $0.0020 (1 of 3 requests not counted)')
  const none = turnFooter(receipt({ requests: 2, usage: { input_tokens: null, output_tokens: null, uncounted_requests: 2 } }))
  assert.equal(none, '2 requests · 1 tool · tokens not reported · cost unknown (the provider reported no counts)')
})

test("the follow-up's token words: unknown is never 0", () => {
  assert.equal(tokenCountsText({ input_tokens: 12000, output_tokens: 800 }), '12k input / 800 output tokens')
  assert.equal(tokenCountsText({ input_tokens: null, output_tokens: null, uncounted_requests: 2 }), 'tokens not reported')
  assert.equal(tokenCountsText({}), 'tokens not reported')
  assert.equal(tokenCountsText({ requests: 4, input_tokens: 900, output_tokens: 10, uncounted_requests: 1 }), '900 input / 10 output tokens (1 of 4 requests not counted)')
})

test('a turn stands in the order it happened: words said between tool calls part the work, the calls after them come after', () => {
  const call = (id: string): ThreadEntry => ({ kind: 'activity', runId: 'r', toolCallId: id, tool: 'bash' })
  const said = (text: string): ThreadEntry => ({ kind: 'agent', runId: 'r', text })
  const parts = turnParts([call('a'), call('b'), said('Copy into repo, patch worker, build.'), call('c'), said('done')])
  assert.deepEqual(parts.map((p) => (p.kind === 'work' ? p.entries.map((e) => e.toolCallId) : p.entry.text)),
    [['a', 'b'], 'Copy into repo, patch worker, build.', ['c'], 'done'])
  assert.deepEqual(turnParts([]), [])
  assert.deepEqual(turnParts([said('only words')]).map((p) => p.kind), ['agent'])
})

test("a run an MCP client started is the client's words, named; the person's own are theirs", () => {
  assert.equal(connectorOf({ spawned_by: 'connector', label: 'ChatGPT' }), 'ChatGPT')
  assert.equal(connectorOf({ spawned_by: 'connector', label: null }), 'MCP client')
  assert.equal(connectorOf({ spawned_by: 'human', label: 'ChatGPT' }), null)
  assert.equal(connectorOf({ spawned_by: 'wake', label: null }), null)
})

test('the cache in words: the share read; none read but some written says so (an expired cache); nothing reported, nothing said', () => {
  assert.equal(cacheNote({ input_tokens: 12000, cache_read_tokens: 9000, cache_write_tokens: 100 }), '75% cached')
  assert.equal(cacheNote({ input_tokens: 75129, cache_read_tokens: 0, cache_write_tokens: 75125 }), '0% cached, 75k written to cache')
  assert.equal(cacheNote({ input_tokens: 5000, cache_read_tokens: 0, cache_write_tokens: 0 }), null)
  assert.equal(cacheNote({ input_tokens: 0, cache_write_tokens: 10 }), null)
  const footer = turnFooter({ mechanical: { requests: 1, tool_calls: 0, usage: { input_tokens: 75129, output_tokens: 1819, cache_read_tokens: 0, cache_write_tokens: 75125 }, cost_usd: null, cost_status: 'unknown', cost_source: null } } as never)
  assert.match(footer, /^1 request · 0 tools · 75k in \(0% cached, 75k written to cache\) \/ 1\.8k out · cost unknown/)
})

test("the footer says the context the run stood at of the model's window, not the input summed over its requests", () => {
  const long = receipt({ requests: 47, tool_calls: 46, usage: { input_tokens: 19_325_995, output_tokens: 70_654, cache_read_tokens: 19_180_154 } })
  assert.equal(contextTokens({ input_tokens: 19_325_995, context_anchor: { input_tokens: 474_268, messages: 239 } }), 474_268)
  assert.equal(contextTokens({ input_tokens: 5 }), null)
  assert.equal(contextTokens({ input_tokens: 18_100_000, context_tokens: 312_000 }), 312_000)            // an outline row's (an agent's card)
  // the cache's share of the input stays beside the context
  assert.equal(turnFooter(long, { tokens: 474_268, window: 1_000_000 }), '47 requests · 46 tools · context 474k / 1M (99% cached) · 71k out · cost unknown (no price list)')
  assert.equal(turnFooter(long, { tokens: 474_268, window: null }), '47 requests · 46 tools · context 474k (99% cached) · 71k out · cost unknown (no price list)')
  const uncached = receipt({ requests: 1, tool_calls: 0, usage: { input_tokens: 9_000, output_tokens: 10 } })
  assert.equal(turnFooter(uncached, { tokens: 9_000, window: 1_000_000 }), '1 request · 0 tools · context 9k / 1M · 10 out · cost unknown (no price list)')
  assert.match(turnFooter(long), /^47 requests · 46 tools · 19\.3M in \(99% cached\) \/ 71k out/)                       // no anchor recorded: the sums
})

test('the turn footer consumes CNY totals and never converts a mixed-currency run', () => {
  const cny = receipt({ cost_usd: null, cost_status: 'estimated' })
  Object.assign(cny.mechanical, { cost_cny: 0.42 })
  assert.match(turnFooter(cny), /cost ≈ ¥0\.4200 CNY/)
  assert.doesNotMatch(turnFooter(cny), /\$/)
  cny.mechanical.cost_usd = 0.1
  assert.match(turnFooter(cny), /cost ≈ \$0\.1000 \+ ¥0\.4200 CNY/)
  cny.mechanical.cost_status = 'partial'
  assert.match(turnFooter(cny), /cost at least \$0\.1000 \+ ¥0\.4200 CNY/)
})
