/** Report worker scheduling/lifecycle tests plus pure synthetic equivalence. No server, browser, user DB or bench. */
import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { computeContextReport, finishInstalledCounter, type ContextReportInput, type ContextReportResult } from '../src/agent/context_report_compute.ts'
import { ContextReportWorker, contextReportWorkerEntry, type ContextReportWorkerOptions, type ReportWorkerPort } from '../src/agent/context_report_worker_client.ts'
import { countTokens, ESTIMATE_FACTOR, estimateMessages, imageCount, IMAGE_TOKENS, strippedRecord, wireText } from '../src/agent/context.ts'
import { ContextKeeper, workingView } from '../src/agent/history.ts'
import { routeFileCost } from '../src/agent/runner.ts'
import { ModelConfig } from '../src/config.ts'
import { modelRequest, userPrompt, type ModelMessage } from '../src/llm/messages.ts'
import { attachmentMessages, reportInput, reportMessages } from './context_report_fixture.ts'

const clients: ContextReportWorker[] = []
afterEach(() => { for (const client of clients.splice(0)) client.close() })
function client(options: ContextReportWorkerOptions = {}) {
  const made = new ContextReportWorker(options)
  clients.push(made)
  return made
}

class FakeWorker extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  posted: { id: number; input: ContextReportInput }[] = []
  terminated = false
  throwPost = false
  postMessage(data: { id: number; input: ContextReportInput }) {
    if (this.throwPost) throw new Error('synthetic post failure')
    this.posted.push(data)
  }
  terminate() { this.terminated = true }
  emit(data: unknown) { this.onmessage?.(new MessageEvent('message', { data })) }
  ready() { this.emit({ type: 'ready' }) }
  reply(index = 0, ok = true) {
    const job = this.posted[index]!
    // Scheduler tests must not initialize a tokenizer or do CPU work in this fake worker.
    const result = { report: { session_id: job.input.sessionId, model_id: job.input.modelId, tools: [...job.input.names] }, counterTexts: null } as unknown as ContextReportResult
    this.emit({ type: 'reply', id: job.id, ok, result })
  }
}
function fakeClient(options: ContextReportWorkerOptions = {}) {
  const workers: FakeWorker[] = []
  const made = client({ entry: 'synthetic-worker', createWorker: () => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker as unknown as ReportWorkerPort
  }, ...options })
  return { made, workers }
}
const outcome = <T>(promise: Promise<T>) => promise.then((value) => ({ value, error: null }), (error: Error) => ({ value: null, error }))

test('source worker entry resolves, same snapshots coalesce, and caller results do not alias', async () => {
  expect(contextReportWorkerEntry()).toBe(join(import.meta.dir, '../src/agent/context_report_worker.ts'))
  const { made, workers } = fakeClient()
  const input = reportInput()
  const a = made.compute(input)
  const b = made.compute(structuredClone(input))
  expect(workers).toHaveLength(1)
  expect(workers[0]!.posted).toHaveLength(0) // ready handshake, no lost startup messages
  workers[0]!.ready()
  expect(workers[0]!.posted).toHaveLength(1)
  workers[0]!.reply()
  const [first, second] = await Promise.all([a, b])
  expect(first).toEqual(second)
  first.report.tools.push('mutated')
  expect(second.report.tools).not.toContain('mutated')
  const next = made.compute(input)
  expect(workers[0]!.posted).toHaveLength(2) // no completed-result cache
  workers[0]!.reply(1)
  expect((await next).report.tools).not.toContain('mutated')
})

test('every influence is part of the in-flight key; queued input is detached from caller mutation', async () => {
  const { made, workers } = fakeClient({ maxJobs: 32 })
  const base = reportInput()
  const variants = [
    base, reportInput({ historyJson: '[]' }), reportInput({ modelId: 'another:model' }),
    reportInput({ seed: { anchor: { messages: 1, input_tokens: 1000 }, trigger: null } }),
    reportInput({ seed: { anchor: null, trigger: 110_000 } }), reportInput({ reserve: 32_000 }),
    reportInput({ resolved: { ...base.resolved, window: 200_000 } }),
    reportInput({ route: { ...base.route!, capabilities: { pdf: false } } }),
    reportInput({ fileLimits: { ...base.fileLimits!, request_bytes: 100 } }),
    reportInput({ installedLabel: 'counter-a' }), reportInput({ installedLabel: 'counter-b' }),
    reportInput({ text: 'new instructions' }), reportInput({ schemaEstimateText: '[]' }),
    reportInput({ payloads: ['different display schemas'] }),
    reportInput({ lastRun: { last_request_context_estimate: 999 } }), reportInput({ runModel: 'different:run' }),
  ]
  const pending = variants.map((input) => made.compute(input))
  base.route!.capabilities.pdf = false
  base.seed.trigger = 42
  base.names.push('changed after snapshot')
  const worker = workers[0]!
  worker.ready()
  expect(worker.posted[0]!.input.route!.capabilities.pdf).toBe(true)
  expect(worker.posted[0]!.input.seed.trigger).toBeNull()
  expect(worker.posted[0]!.input.names).not.toContain('changed after snapshot')
  for (let i = 0; i < variants.length; i += 1) {
    expect(worker.posted).toHaveLength(i + 1) // never dispatch all queued work into the worker mailbox
    worker.reply(i)
  }
  await Promise.all(pending)
})

test('job/caller backlog limits reject deterministically; an oversized session can run alone and coalesce', async () => {
  const { made, workers } = fakeClient({ maxBytes: 1, maxJobs: 2, maxCallers: 2 })
  const input = reportInput({ historyJson: JSON.stringify(reportMessages()) })
  const a = made.compute(input) // much bigger than the byte budget: admitted while empty, never truncated
  await expect(made.compute(reportInput({ sessionId: 'different' }))).rejects.toThrow('queue full')
  const b = made.compute(input)
  await expect(made.compute(input)).rejects.toThrow('queue full')
  workers[0]!.ready()
  expect(workers[0]!.posted[0]!.input.historyJson).toBe(input.historyJson)
  workers[0]!.reply()
  await Promise.all([a, b])
  const c = made.compute(reportInput({ sessionId: 'next' }))
  workers[0]!.reply(1)
  await c
  const limited = fakeClient({ maxJobs: 1 })
  const held = outcome(limited.made.compute(reportInput()))
  await expect(limited.made.compute(reportInput({ sessionId: 'queued' }))).rejects.toThrow('queue full')
  limited.made.close()
  expect((await held).error).not.toBeNull()
})

for (const failure of ['error', 'close', 'reply', 'post'] as const) {
  test(`${failure}: all coalesced callers settle; queued work recovers, old-worker replies cannot poison it`, async () => {
    const { made, workers } = fakeClient()
    const a = outcome(made.compute(reportInput()))
    const duplicate = outcome(made.compute(reportInput()))
    const queued = made.compute(reportInput({ modelId: 'queued:model' }))
    const worker = workers[0]!
    worker.throwPost = failure === 'post'
    worker.ready()
    if (failure === 'error') worker.onerror?.()
    if (failure === 'close') worker.dispatchEvent(new Event('close'))
    if (failure === 'reply') worker.reply(0, false)
    expect((await a).error).not.toBeNull()
    expect((await duplicate).error).not.toBeNull()
    const recovered = failure === 'reply' ? worker : workers[1]!
    if (failure !== 'reply') {
      expect(worker.terminated).toBe(true)
      // A stale ready/error/reply belongs to the old worker, even with a fabricated matching request id.
      worker.ready()
      worker.onerror?.()
      worker.emit({ type: 'reply', id: 2, ok: true, result: { report: { model_id: 'stale' } } })
      recovered.ready()
    }
    recovered.reply(failure === 'reply' ? 1 : 0)
    expect((await queued).report.model_id).toBe('queued:model')
    const after = made.compute(reportInput({ modelId: 'later:model' }))
    recovered.reply(failure === 'reply' ? 2 : 1)
    expect((await after).report.model_id).toBe('later:model')
  })
}

for (const ready of [false, true]) {
  test(`deadline covers ${ready ? 'computation' : 'startup'} AND queued callers; next request recovers`, async () => {
    const { made, workers } = fakeClient({ timeoutMs: 25 })
    const a = outcome(made.compute(reportInput()))
    const b = outcome(made.compute(reportInput()))
    const queued = outcome(made.compute(reportInput({ modelId: 'queued' })))
    if (ready) workers[0]!.ready()
    const results = await Promise.all([a, b, queued])
    expect(results.every((r) => r.error?.message === 'context report timed out')).toBe(true)
    expect(workers.every((w) => w.terminated)).toBe(true)
    const after = made.compute(reportInput())
    const fresh = workers.at(-1)!
    fresh.ready()
    fresh.reply()
    expect((await after).report.model_id).toBe('openai:synthetic')
  })
}

test('missing entry/start failure and close settle promises; failed creation can be retried', async () => {
  await expect(client({ entry: null }).compute(reportInput())).rejects.toThrow('not in this build')
  const worker = new FakeWorker()
  let attempts = 0
  const made = client({ entry: 'synthetic', createWorker: () => {
    if (++attempts === 1) throw new Error('synthetic startup failure')
    return worker as unknown as ReportWorkerPort
  } })
  await expect(made.compute(reportInput())).rejects.toThrow('unavailable')
  const retry = made.compute(reportInput())
  worker.ready()
  worker.reply()
  await retry
  const pending = outcome(made.compute(reportInput()))
  const queued = outcome(made.compute(reportInput({ modelId: 'queued' })))
  made.close()
  expect((await pending).error?.message).toContain('closed')
  expect((await queued).error?.message).toContain('closed')
  await expect(made.compute(reportInput())).rejects.toThrow('closed')
})

test('real worker: cold initialization yields to timers and every report field matches synchronous arithmetic', async () => {
  const made = client()
  const messages = reportMessages()
  const marker = { ...modelRequest([userPrompt('synthetic summary')]), compaction: { covers: messages.length, tokens_before: 100, summary_input_tokens: 20, model: 'synthetic', at: 'synthetic-time' } }
  const compacted: ModelMessage[] = [...messages, marker, ...attachmentMessages()]
  const variants = [
    reportInput(), reportInput({ historyJson: '[]' }), reportInput({ historyJson: JSON.stringify(messages) }),
    reportInput({ historyJson: JSON.stringify(compacted) }),
    reportInput({ historyJson: JSON.stringify(compacted), seed: { anchor: { input_tokens: 20_000, messages: 6 }, trigger: 110_000 } }),
    reportInput({ historyJson: JSON.stringify(compacted), seed: { anchor: { input_tokens: 20_000, messages: 1 }, trigger: null } }),
    reportInput({ historyJson: JSON.stringify(messages), lastRun: { last_request_context_estimate: 41_234, last_request_input_tokens: 40_000 } }),
    reportInput({ historyJson: JSON.stringify(messages), runModel: 'other', lastRun: { last_request_context_estimate: 41_234 } }),
    reportInput({ route: { id: 'anthropic:synthetic', provider: 'anthropic', capabilities: {} } }),
    reportInput({ route: { id: 'google:synthetic', provider: 'google', capabilities: {} } }),
    reportInput({ route: null, fileLimits: null }),
  ]
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 1)
  let first: ContextReportResult
  try { first = await made.compute(variants[0]!) } finally { clearInterval(timer) }
  expect(ticks).toBeGreaterThan(0) // scheduling assertion, not a timing/throughput benchmark
  expect(first!).toEqual(computeContextReport(variants[0]!))
  for (const input of variants.slice(1)) expect(await made.compute(input)).toEqual(computeContextReport(input))
  // Invalid history is not a synchronous API parse, and failure does not wedge the following job.
  // Await the transport before asserting: Bun 1.4's pending .rejects.toThrow matcher can starve worker message
  // delivery (a raw await receives this rejection immediately; the matcher instead waits for the job deadline).
  const invalid = await outcome(made.compute(reportInput({ historyJson: '{invalid' })))
  expect(invalid.error?.message).toContain('computation failed')
  expect(await made.compute(reportInput())).toEqual(computeContextReport(reportInput()))
})

test('estimates keep runner file/image costs and anchor delta; display and estimate schemas remain distinct', async () => {
  const made = client()
  const messages = [...reportMessages(), ...attachmentMessages()]
  for (const pdf of [false, true]) {
    const input = reportInput({ historyJson: JSON.stringify(messages) })
    input.route!.capabilities.pdf = pdf
    const cfg = new ModelConfig({ id: input.modelId, provider: 'openai', model: 'synthetic', capabilities: input.route!.capabilities })
    const fileCost = routeFileCost(cfg)
    const fixed = countTokens(input.text) + countTokens(input.schemaEstimateText)
    const keeper = new ContextKeeper({ window: input.resolved.window, output_reserve: input.reserve, file_cost: fileCost })
    const report = (await made.compute(input)).report
    expect(report.tokens_est).toBe(keeper.estimate(messages, () => fixed).tokens)
    expect(report.tokens_est).toBe(Math.ceil((fixed + estimateMessages(messages, fileCost)) * ESTIMATE_FACTOR) + imageCount(messages) * IMAGE_TOKENS)
    expect(report.history.content_bytes).toBe(Buffer.byteLength(strippedRecord(messages), 'utf8'))
    expect(report.history.wire_tokens).toBe(countTokens(wireText(workingView(messages))))
    const schema = report.segments.find((s) => s.key === 'tool_schemas')!
    expect(schema.tokens).toBe(countTokens(input.payloads.join('\n')))
    expect(schema.tokens_est).toBe(Math.ceil(countTokens(input.schemaEstimateText) * ESTIMATE_FACTOR))
    expect(input.payloads.join('\n')).not.toBe(input.schemaEstimateText)
    input.seed.anchor = { input_tokens: 30_000, messages: 4 }
    const anchored = (await made.compute(input)).report
    const delta = messages.slice(4)
    expect(anchored.tokens_est).toBe(30_000 + Math.ceil(estimateMessages(delta, fileCost) * ESTIMATE_FACTOR) + imageCount(delta) * IMAGE_TOKENS)
  }
})

test('installed counters remain realm-local, ordered, stateful, and independent even when worker jobs coalesce', async () => {
  const made = client()
  for (const historyJson of [null, '[]', JSON.stringify(reportMessages())]) {
    const input = reportInput({ historyJson, installedLabel: 'synthetic-installed' })
    const texts: string[] = []
    const expected = computeContextReport(input, (text) => { texts.push(text); return texts.length * 17 }).report
    const [a, b] = await Promise.all([made.compute(input), made.compute(input)])
    const seen: string[] = []
    const actual = finishInstalledCounter(a, (text) => { seen.push(text); return seen.length * 17 })
    expect(seen).toEqual(texts)
    expect(actual).toEqual(expected)
    const zero = finishInstalledCounter(b, () => 0)
    expect(zero.total_tokens).toBe(0)
    expect(zero.segments.map((s) => s.share)).toEqual(zero.segments.map((s) => zero.total_bytes ? Math.round(s.bytes / zero.total_bytes * 1e4) / 1e4 : 0))
    expect(actual.total_tokens).not.toBe(zero.total_tokens)
    const failed = await made.compute(input)
    expect(() => finishInstalledCounter(failed, () => { throw new Error('counter failure') })).toThrow('counter failure')
  }
})
