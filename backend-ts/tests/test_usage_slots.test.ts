/** The wrappers every route runs under: the usage meter (one record per request, totals, cost as estimated or
 *  unknown — never $0.00 by default), the request slot (N in flight per scope, slot_wait every time a run waits,
 *  a queued run stopped before its request is made), and the schema fingerprint both the manifest and the
 *  records use. */

import { expect, test } from 'bun:test'
import type { ModelRequestRecord } from '@oasis-code/contract'
import { DEFAULT_MODELS, ModelConfig } from '../src/config.ts'
import { modelResponse, textPart, toolCallPart } from '../src/llm/messages.ts'
import { ModelHTTPError } from '../src/llm/model.ts'
import { ScriptedModel, steps } from '../src/llm/scripted.ts'
import { ModelSlot, QueueCancelled, Serialized, SlotRegistry } from '../src/llm/slots.ts'
import { UsageMeter, estimateCost, schemaRowsFingerprint, toolSchemaFingerprint } from '../src/llm/usage.ts'
import { Agent } from '../src/agent/loop.ts'
import { runAgent } from './helpers.ts'

const PRICED = new ModelConfig({ id: 'claude', provider: 'anthropic', model: 'claude-x', api_key_env: 'K', pricing: { input_per_mtok: 3.0, output_per_mtok: 15.0, source: 'test list', version: '2026-01' } })
const UNPRICED = new ModelConfig({ id: 'gpt', provider: 'openai', model: 'gpt-y', api_key_env: 'K' })

test('cost is estimated from the price list, with the cached parts at their own rates, or unknown', () => {
  expect(estimateCost({ input_tokens: 10, output_tokens: 7 }, PRICED.pricing)).toEqual([Math.round((10 / 1e6 * 3 + 7 / 1e6 * 15) * 1e6) / 1e6, 'estimated', 'test list@2026-01'])
  expect(estimateCost({ input_tokens: 10, output_tokens: 7 }, null)).toEqual([null, 'unknown', null])
  const cached = { input_per_mtok: 3.0, output_per_mtok: 15.0, cache_read_per_mtok: 0.3, cache_write_per_mtok: 3.75, cache_write_1h_per_mtok: null, source: 's', version: 'v' }
  const [usd] = estimateCost({ input_tokens: 100, cache_read_tokens: 50, cache_write_tokens: 20, output_tokens: 0 }, cached)
  expect(usd).toBeCloseTo((30 / 1e6) * 3 + (50 / 1e6) * 0.3 + (20 / 1e6) * 3.75, 9)
})

test('the schema fingerprint is order-insensitive and shared by the manifest and the records', () => {
  const a = schemaRowsFingerprint([{ name: 'b', description: 'B', parameters: { type: 'object', properties: { x: { type: 'string' } } } }, { name: 'a', description: 'A', parameters: {} }])
  const b = schemaRowsFingerprint([{ name: 'a', description: 'A' }, { name: 'b', description: 'B', parameters: { properties: { x: { type: 'string' } }, type: 'object' } }])
  expect(a).toBe(b)
  expect(a).toMatch(/^[0-9a-f]{64}$/)
  expect(schemaRowsFingerprint([{ name: 'a', description: 'changed' }])).not.toBe(schemaRowsFingerprint([{ name: 'a', description: 'A' }]))
  const short = toolSchemaFingerprint({ function_tools: [{ name: 'a', description: 'A', parameters_json_schema: {} }], allow_text_output: true, thinking: null })
  expect(short).toBe(schemaRowsFingerprint([{ name: 'a', description: 'A', parameters: {} }]).slice(0, 16))
  // the canonical form matches Python's json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=True)
  expect(schemaRowsFingerprint([{ name: 'é', description: 'ü' }])).toBe(schemaRowsFingerprint([{ name: 'é', description: 'ü' }]))
})

test('the meter records every request as it completes, totals, and files errors without tokens', async () => {
  const records: ModelRequestRecord[] = []
  const events: [string, Record<string, unknown>][] = []
  const scripted = new ScriptedModel(steps([toolCallPart('noop', {}, 'c1')], [textPart('done')]), { modelName: 'claude-x', usage: { input_tokens: 10, output_tokens: 7, cache_read_tokens: 0, cache_write_tokens: 0 } })
  const meter = new UsageMeter(scripted, PRICED, 'run_1', (r) => records.push(r), (e, d) => events.push([e, d]), null, (m) => m.length * 100)
  const agent = new Agent<null>({ instructions: 'x', tools: [{ name: 'noop', description: 'nothing', parameters_json_schema: { type: 'object', properties: {} }, validate: (v) => ({ value: v }), fn: () => 'ok' }] })
  const run = await runAgent(agent, meter, 'go', null)
  expect(run.result.output).toBe('done')
  expect(records).toHaveLength(2)
  expect(records.map((r) => r.seq)).toEqual([1, 2])
  expect(records[0]).toMatchObject({ run_id: 'run_1', model_id: 'claude', configured_model: 'claude-x', provider_reported_model: 'claude-x', status: 'ok', error: null, input_tokens: 10, output_tokens: 7, cost_status: 'estimated', cost_source: 'test list@2026-01', message_count: 1, context_estimate_tokens: 100 })
  expect(records[0]!.cost_usd).toBeCloseTo(10 / 1e6 * 3 + 7 / 1e6 * 15, 9)
  expect(records[0]!.tool_schema_sha256).toHaveLength(16)
  expect(records[1]!.message_count).toBe(3)
  expect(meter.totals).toMatchObject({ requests: 2, input_tokens: 20, output_tokens: 14, cost_status: 'estimated', provider_models: ['claude-x'] })
  expect(meter.totalsWithTokens().total_tokens).toBe(34)
  expect(events.filter(([e]) => e === 'model_request').map(([, d]) => d.seq)).toEqual([1, 2])
  expect(events[0]![1]).toMatchObject({ model: 'claude', provider_reported_model: 'claude-x', cost_status: 'estimated', status: 'ok' })
  // no price list: unknown, never 0; totals resumed from a previous segment keep counting
  const unknownMeter = new UsageMeter(scripted, UNPRICED, 'run_2', (r) => records.push(r), () => {}, { requests: 3, input_tokens: 5 })
  expect(unknownMeter.seq).toBe(3)
  await runAgent(new Agent<null>({ instructions: 'x', tools: [] }), unknownMeter, 'go', null)
  expect(records.at(-1)).toMatchObject({ seq: 4, cost_usd: null, cost_status: 'unknown', cost_source: null })
  expect(unknownMeter.totals).toMatchObject({ requests: 4, input_tokens: 15, cost_usd: null, cost_status: 'unknown' })
  // a request that fails before a stream opens: an error record, no tokens, the error re-raised
  const failing = new ScriptedModel(() => { throw new ModelHTTPError(529, 'claude-x', { error: 'overloaded' }) }, { modelName: 'claude-x' })
  const errorMeter = new UsageMeter(failing, PRICED, 'run_3', (r) => records.push(r), () => {})
  await expect(runAgent(new Agent<null>({ instructions: 'x', tools: [] }), errorMeter, 'go', null)).rejects.toThrow(ModelHTTPError)
  expect(records.at(-1)).toMatchObject({ status: 'error', input_tokens: 0, output_tokens: 0, provider_reported_model: null })
  expect(records.at(-1)!.error).toStartWith('ModelHTTPError: status_code: 529')
})

test('a slot admits N requests per scope, a waiting run says so every time, a stopped run leaves the queue', async () => {
  const registry = new SlotRegistry()
  expect(registry.slotFor('scope', null)).toBeNull()
  const slot = registry.slotFor('anthropic:oauth', 1)!
  expect(registry.slotFor('anthropic:oauth', 1)).toBe(slot)
  const release: (() => void)[] = []
  const slow = new ScriptedModel(async () => { await new Promise<void>((r) => release.push(r)); return modelResponse([textPart('ok')]) })
  const events: [string, string, Record<string, unknown>][] = []
  const model = (runId: string, cancelled = () => false) => new Serialized(slow, slot, runId, cancelled, (e, d) => events.push([runId, e, d]))
  const first = runAgent(new Agent<null>({ instructions: '', tools: [] }), model('run_a'), 'hi', null)
  await new Promise((r) => setTimeout(r, 20))
  expect(slot.holders).toEqual(['run_a'])
  const second = runAgent(new Agent<null>({ instructions: '', tools: [] }), model('run_b'), 'hi', null)
  await new Promise((r) => setTimeout(r, 20))
  expect(slot.waiters).toEqual(['run_b'])
  expect(events).toEqual([['run_b', 'slot_wait', { scope: 'anthropic:oauth', limit: 1, behind: ['run_a'] }]])
  let stopped = false
  const third = runAgent(new Agent<null>({ instructions: '', tools: [] }), model('run_c', () => stopped), 'hi', null)
  await new Promise((r) => setTimeout(r, 20))
  expect(slot.busyFor('run_c')).toEqual(['run_a', 'run_b'])
  stopped = true
  await expect(third).rejects.toThrow(QueueCancelled)
  expect(slot.waiters).toEqual(['run_b'])
  release.shift()!()
  await first
  await new Promise((r) => setTimeout(r, 20))
  expect(slot.holders).toEqual(['run_b'])
  expect(events.at(-1)).toEqual(['run_b', 'slot_acquired', { scope: 'anthropic:oauth' }])
  release.shift()!()
  await second
  expect(slot.holders).toEqual([])
  expect(slot.waiters).toEqual([])
  expect(events.filter(([r]) => r === 'run_a')).toEqual([])
})

test('the subscription routes queue no request: none of the OpenAI or Claude sign-in routes takes a slot', () => {
  const registry = new SlotRegistry()
  const signedIn = DEFAULT_MODELS.map((m) => new ModelConfig(m as never)).filter((m) => m.auth === 'oauth')
  expect(signedIn.map((m) => m.id)).toContain('openai:gpt-6-astra')
  for (const m of signedIn) expect([m.id, registry.slotFor(m.scope, m.concurrency)]).toEqual([m.id, null])
})

test('a slot of two lets two run at once and queues the third', async () => {
  const slot = new ModelSlot('s', 2)
  const order: string[] = []
  const hold = (id: string, ms: number) => slot.hold(id, () => false, null, async () => { order.push(`start ${id}`); await new Promise((r) => setTimeout(r, ms)); order.push(`end ${id}`) })
  await Promise.all([hold('a', 40), hold('b', 40), hold('c', 10)])
  expect(order.slice(0, 2)).toEqual(['start a', 'start b'])
  expect(order.indexOf('start c')).toBeGreaterThan(Math.min(order.indexOf('end a'), order.indexOf('end b')))
})

test('a streamed request takes the slot once, in its turn, and holds it to the stream\'s end; queued, a Stop takes it out', async () => {
  const slot = new ModelSlot('s', 1)
  const release: (() => void)[] = []
  const made: string[] = []
  const slow = new ScriptedModel(async (m) => {
    made.push(JSON.stringify(m).match(/who:(\w)/)![1]!)
    await new Promise<void>((r) => release.push(r))
    return modelResponse([textPart('ok')])
  })
  const stops: Record<string, boolean> = {}
  const ask = (runId: string) => runAgent(new Agent<null>({ instructions: '', tools: [] }), new Serialized(slow, slot, runId, () => stops[runId] === true, () => {}), `who:${runId.slice(-1)}`, null)
  const tick = () => new Promise((r) => setTimeout(r, 20))
  const a = ask('run_a')
  await tick()
  const b = ask('run_b')
  await tick()
  const c = ask('run_c')
  await tick()
  const d = ask('run_d')
  await tick()
  expect(slot.waiters).toEqual(['run_b', 'run_c', 'run_d'])
  // the one in flight ends: the next in line makes its request — never one queued behind it
  release.shift()!()
  await a
  await tick()
  expect(made).toEqual(['a', 'b'])
  expect(slot.holders).toEqual(['run_b'])
  // a queued run stopped leaves the queue, whatever the stream did before
  stops.run_c = true
  await expect(c).rejects.toThrow(QueueCancelled)
  release.shift()!()
  await b
  await tick()
  release.shift()!()
  await d
  expect(made).toEqual(['a', 'b', 'd'])
  expect(slot.holders).toEqual([])
  expect(slot.waiters).toEqual([])
  expect(slot.locked).toBe(false)
})

test('a request that failed or was stopped before anything was counted has an unknown cost, never an estimated 0', async () => {
  const records: ModelRequestRecord[] = []
  const failing = new ScriptedModel(() => { throw new ModelHTTPError(529, 'claude-x', { error: 'overloaded' }) }, { modelName: 'claude-x' })
  const meter = new UsageMeter(failing, PRICED, 'run_1', (r) => records.push(r), () => {})
  await expect(runAgent(new Agent<null>({ instructions: 'x', tools: [] }), meter, 'go', null)).rejects.toThrow(ModelHTTPError)
  expect(records.at(-1)).toMatchObject({ status: 'error', cost_usd: null, cost_status: 'unknown', cost_source: null })
  expect(meter.totals).toMatchObject({ cost_usd: null, cost_status: 'unknown' })
  // after a priced request, the total is at least what was priced: partly unknown
  const priced = new ScriptedModel(steps([textPart('ok')]), { modelName: 'claude-x', usage: { input_tokens: 10, output_tokens: 7, cache_read_tokens: 0, cache_write_tokens: 0 } })
  const mixed = new UsageMeter(priced, PRICED, 'run_2', (r) => records.push(r), () => {})
  await runAgent(new Agent<null>({ instructions: 'x', tools: [] }), mixed, 'go', null)
  expect(mixed.totals.cost_status).toBe('estimated')
  const failAfter = new UsageMeter(failing, PRICED, 'run_2', (r) => records.push(r), () => {}, mixed.totals)
  await expect(runAgent(new Agent<null>({ instructions: 'x', tools: [] }), failAfter, 'go', null)).rejects.toThrow(ModelHTTPError)
  expect(failAfter.totals.cost_status).toBe('partial')
  expect(failAfter.totals.cost_usd).toBeCloseTo(10 / 1e6 * 3 + 7 / 1e6 * 15, 9)
})

test('a count the route\'s window could not hold is filed as not reported, never priced, and the loop does not count it', async () => {
  const WINDOWED = new ModelConfig({ id: 'claude', provider: 'anthropic', model: 'claude-x', api_key_env: 'K', context_window: 200_000, window_source: 'test', pricing: PRICED.pricing })
  const records: ModelRequestRecord[] = []
  const reporting = (usage: { input_tokens: number; output_tokens: number }) =>
    new ScriptedModel(steps([textPart('ok')]), { modelName: 'claude-x', usage: { ...usage, cache_read_tokens: 0, cache_write_tokens: 0 } })
  for (const usage of [{ input_tokens: 5_000_000, output_tokens: 7 }, { input_tokens: 10, output_tokens: 300_000 }]) {
    const meter = new UsageMeter(reporting(usage), WINDOWED, 'run_1', (r) => records.push(r), () => {})
    const run = await runAgent(new Agent<null>({ instructions: 'x', tools: [] }), meter, 'go', null)
    expect(records.at(-1)).toMatchObject({ status: 'ok', input_tokens: 0, output_tokens: 0, cost_usd: null, cost_status: 'unknown' })
    expect(meter.totals).toMatchObject({ requests: 1, uncounted_requests: 1, cost_usd: null, cost_status: 'unknown' })
    expect(meter.totalsWithTokens().total_tokens).toBeNull()
    expect(run.result.usage.input_tokens ?? 0).toBe(0)
    expect(run.result.usage.output_tokens ?? 0).toBe(0)
  }
  // a count at the window is one; a route whose window is not configured is not judged against an assumed one
  const atWindow = new UsageMeter(reporting({ input_tokens: 200_000, output_tokens: 7 }), WINDOWED, 'run_2', (r) => records.push(r), () => {})
  await runAgent(new Agent<null>({ instructions: 'x', tools: [] }), atWindow, 'go', null)
  expect(records.at(-1)).toMatchObject({ input_tokens: 200_000, cost_status: 'estimated' })
  const unwindowed = new UsageMeter(reporting({ input_tokens: 5_000_000, output_tokens: 7 }), PRICED, 'run_3', (r) => records.push(r), () => {})
  await runAgent(new Agent<null>({ instructions: 'x', tools: [] }), unwindowed, 'go', null)
  expect(records.at(-1)).toMatchObject({ input_tokens: 5_000_000, cost_status: 'estimated' })
})

test("a cache write is priced at its entry's lifetime; Claude routes keep an hour by default and price it so", () => {
  const pricing = { input_per_mtok: 4, output_per_mtok: 20, cache_read_per_mtok: 0.2, cache_write_per_mtok: 5, cache_write_1h_per_mtok: 8, source: 's', version: 'v' }
  const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000 }
  expect(estimateCost(usage, pricing, '5m')[0]).toBe(5)
  expect(estimateCost(usage, pricing, '1h')[0]).toBe(8)
  expect(estimateCost(usage, { ...pricing, cache_write_1h_per_mtok: null }, '1h')[0]).toBe(5)        // a list without the hour's rate
  const claude = DEFAULT_MODELS.map((m) => new ModelConfig(m as never)).filter((m) => m.provider === 'anthropic')
  expect(claude.length).toBeGreaterThan(0)
  for (const m of claude) expect(m.cache_ttl).toBe('1h')
  for (const m of claude.filter((c) => c.pricing)) expect(m.pricing!.cache_write_1h_per_mtok).toBe(m.pricing!.input_per_mtok * 2)
})
