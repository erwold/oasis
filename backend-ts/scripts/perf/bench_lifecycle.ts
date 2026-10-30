/** Item 6 — many short runs through the API (in-process app.request): success, provider failure (HTTP 400 from the
 *  stub) and Stop, each with an SSE subscriber on the run's stream and one session stream open throughout. Every
 *  `--sample` runs: heap/RSS/FDs after full GC, JSC object count, the runner's retained handles and their events,
 *  live subscriber queues. Warm-up runs (the first --warmup) are excluded from the trend; the trend is a least-squares
 *  slope per run over the post-warm-up samples (cache warm-up flattens; a leak keeps the slope).
 *
 *  The provider stub is a Bun.serve on 127.0.0.1 port 0 (a real socket; --in-process for the fetch interceptor).
 *  bun run scripts/perf/bench_lifecycle.ts [--runs 300] [--warmup 30] [--sample 25] [--in-process]
 *  long history: bun run scripts/perf/bench_lifecycle.ts --long-history 500 --long-runs 20 [--long-warmup 2] [--window 2000000] */

import { PERF_ROOT } from './lib/env.ts'
import { heapStats } from 'bun:jsc'
import * as repo from '../../src/db/repo.ts'
import { buildHistory } from './lib/fixtures.ts'
import { anthropicText, perfApp, perfSession, ProviderStub, request, streamResponse, syntheticRepo } from './lib/app.ts'
import { AnthropicModel } from '../../src/llm/providers.ts'
import { argNum, argValue, hasFlag, linreg, memory, meta, round, sha, sleep, summarize, writeResult } from './lib/stats.ts'

const runs = argNum('runs', 300)
const warmup = argNum('warmup', 30)
const sampleEvery = argNum('sample', 25)
/** long-history scenario (a coverage scenario, not the default config): a synthetic record of this many turns
 *  (3 tool calls each) as the session's head run, then --long-runs successful POST /chat continuing it; the stub
 *  route's window is --window tokens (2M: the record never crosses the compaction threshold) */
const longTurns = argNum('long-history', 0)
const longRuns = argNum('long-runs', 20)
const longWarmup = argNum('long-warmup', 2)
const windowTokens = argNum('window', 2_000_000)

type Outcome = 'success' | 'failure' | 'cancel'
/** a handle's serialized-stash copy where a build still keeps one (type only: a build without it reads undefined) */
type LegacyStash = { stash_json?: string | null }
let mode: Outcome = 'success'
const ANSWER = anthropicText('A short synthetic answer of a few words. '.repeat(4))
/** cancel: the stream opens (message_start) and then stays open until the client goes away — a Stop mid-stream */
function hangingStream(signal: AbortSignal | null): Response {
  const head = ANSWER.slice(0, ANSWER.indexOf('\n\n') + 2)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(head))
      const end = () => { try { controller.close() } catch { /* closed */ } }
      if (signal?.aborted) end(); else signal?.addEventListener('abort', end, { once: true })
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const stub = new ProviderStub(async (call) => {
  if (mode === 'failure') return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'synthetic refusal' } }), { status: 400, headers: { 'content-type': 'application/json' } })
  if (mode === 'cancel') return hangingStream(call.signal)
  return streamResponse(longTurns > 0 ? anthropicText('A short synthetic answer of a few words. '.repeat(4), Math.min(windowTokens - 100_000, Math.ceil(call.bytes / 4))) : ANSWER)
})
// the provider over a real loopback socket (Bun.serve on port 0, the global fetch) unless --in-process
let server: ReturnType<typeof Bun.serve> | null = null
let providerModel = stub.model()
if (!hasFlag('in-process')) {
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: async (req) => stub.fetch(req.url, { method: 'POST', body: await req.text(), signal: req.signal }) })
  providerModel = new AnthropicModel('stub-model', { apiKey: 'perf-not-a-key', baseUrl: `http://127.0.0.1:${server.port}`, maxRetries: 0 })
}
const app = await perfApp({ models: { 'stub:anthropic': providerModel }, ...(longTurns > 0 ? { context_window: windowTokens } : {}) })
await app.start()
const state = app.state
const { session } = await perfSession(app, syntheticRepo())

// one session stream open for the whole bench (what a page holds)
const sessionStop = new AbortController()
const sessionRes = await request(app, 'GET', `/api/sessions/${session.id}/events`)
let sessionFrames = 0
const sessionReading = (async () => {
  const reader = sessionRes.body!.getReader()
  sessionStop.signal.addEventListener('abort', () => { void reader.cancel().catch(() => {}) }, { once: true })
  const dec = new TextDecoder()
  for (;;) { let c; try { c = await reader.read() } catch { return } if (c.done) return; sessionFrames += (dec.decode(c.value).match(/\n\n/g) ?? []).length }
})()

async function consumeRun(runId: string): Promise<number> {
  const res = await request(app, 'GET', `/api/runs/${runId}/events`)
  const text = await res.text()
  return (text.match(/\nevent:|^event:/g) ?? []).length
}

const sub = () => {
  const hub = state.runs.sessions as unknown as { queues: Map<string, Set<unknown>> }
  let n = 0; for (const s of hub.queues.values()) n += s.size
  return n
}
const retained = () => {
  const hs = [...state.runs.handles.values()]
  return { handles: hs.length, handle_events: hs.reduce((a, h) => a + h.events.length, 0), live_run_queues: hs.reduce((a, h) => a + h.queues.length, 0), stash_json_mb: round(hs.reduce((a, h) => a + ((h as unknown as LegacyStash).stash_json?.length ?? 0), 0) / 2 ** 20, 3), transient_events: hs.reduce((a, h) => a + h.events.filter((e) => e.cursor === null || e.cursor === undefined).length, 0), session_queues: sub(), built_models: state.runs.built_models.size }
}

// ---- comparable fingerprints: what a later (fixed) version must answer the same ---------------------------------
/** ids (`<prefix>_<12 hex>`), ISO times and clock-derived numbers normalized away; the rest is hashed as is */
function normalized(value: unknown): string {
  // an SSE frame's data is JSON text: parsed first, so the numbers inside it are normalized too
  const parsed = (v: unknown): unknown => { if (typeof v !== 'string' || !/^[[{]/.test(v)) return v; try { return JSON.parse(v) } catch { return v } }
  const text = JSON.stringify(value, (key, v) => { const p = key === 'data' ? parsed(v) : v; return typeof p === 'number' && /(_ms|_s|_at|duration|elapsed|latency)$/.test(key) ? 0 : p })
  // this process's temp root and the random names made under it (mkdtemp suffixes) are not part of the answer
  return text.split(PERF_ROOT).join('ROOT').replace(/\b(x|http)-[A-Za-z0-9]{6}\b/g, '$1-X').replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:PORT').replace(/\b([a-z]+)_[0-9a-f]{12}(?:[0-9a-f]{4})?\b/g, '$1_ID').replace(/\b[0-9a-f]{64}\b/g, 'SHA256').replace(/\b[0-9a-f]{40}\b/g, 'SHA').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, 'T')
}
async function sseFrames(path: string, untilEvent: string | null): Promise<{ event: string; data: string }[]> {
  const res = await request(app, 'GET', path)
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  const out: { event: string; data: string }[] = []
  let buf = ''
  for (;;) {
    const c = await reader.read()
    if (c.done) break
    buf += dec.decode(c.value, { stream: true })
    let at
    while ((at = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, at); buf = buf.slice(at + 2)
      let event = '', data = ''
      for (const line of frame.split('\n')) { if (line.startsWith('event:')) event = line.slice(6).trim(); else if (line.startsWith('data:')) data += line.slice(5).trim() }
      if (event) out.push({ event, data })
      if (untilEvent !== null && event === untilEvent) { await reader.cancel().catch(() => {}); return out }
    }
  }
  return out
}
const typeCounts = (events: { event: string }[]) => events.reduce<Record<string, number>>((a, e) => { a[e.event] = (a[e.event] ?? 0) + 1; return a }, {})
/** every read a finished run answers: the record, GET /api/runs/:id, the late run SSE replay, the events page, the
 *  transcript, and the session stream's replay from cursor 0 (to its ready frame) */
async function fingerprints(runId: string): Promise<Record<string, unknown>> {
  const dump = process.env.PERF_FP_DUMP
  const h = (name: string, text: string): string => { if (dump) { const fs = require('node:fs') as typeof import('node:fs'); fs.mkdirSync(dump, { recursive: true }); fs.writeFileSync(`${dump}/${runId === seedIdForDump ? 'seed' : 'last'}_${name}.txt`, text) } return sha(text) }
  const record = repo.getRunHistory(state.conn, runId) ?? ''
  const run = await (await request(app, 'GET', `/api/runs/${runId}`)).json()
  const replay = await sseFrames(`/api/runs/${runId}/events`, null)
  const page = await (await request(app, 'GET', `/api/runs/${runId}/events/page?after=-1&limit=1000`)).json() as { events: { event: string }[] }
  const transcript = await (await request(app, 'GET', `/api/runs/${runId}/transcript`)).json()
  const sessionReplay = await sseFrames(`/api/sessions/${session.id}/events?after=0`, 'stream_ready')
  return {
    record_bytes: Buffer.byteLength(record), record_sha: h('record', normalized(JSON.parse(record || 'null'))),
    get_run_sha: h('get_run', normalized(run)), run_sse_replay: { frames: replay.length, types: typeCounts(replay), sha: h('run_sse', normalized(replay)) },
    events_page: { events: page.events.length, types: typeCounts(page.events), sha: h('page', normalized(page.events)) },
    transcript_sha: h('transcript', normalized(transcript)), session_replay: { frames: sessionReplay.length, types: typeCounts(sessionReplay), sha: h('session', normalized(sessionReplay.filter((f) => f.event !== 'stream_ready'))) },
  }
}
let seedIdForDump = ''
const persistedRecordBytes = (): number => Number(state.conn.get('SELECT COALESCE(SUM(LENGTH(CAST(history_json AS BLOB))), 0) AS n FROM runs WHERE session_id=?', [session.id])?.n ?? 0)
const retainedBytes = () => {
  const hs = [...state.runs.handles.values()]
  return { stash_json_bytes: hs.reduce((a, h) => a + ((h as unknown as LegacyStash).stash_json ? Buffer.byteLength((h as unknown as LegacyStash).stash_json!) : 0), 0), handles_with_stash: hs.filter((h) => (h as unknown as LegacyStash).stash_json).length }
}

/** Diagnostic counterfactuals in THIS bench process only (after every fingerprint is taken; the product's code is
 *  untouched): heap after GC as measured, then with every handle's stash_json dropped, then with the finished handles
 *  let go as well — the memory each actually holds. Plus each handle field's JSON size (a lower bound of its share). */
async function attribution(): Promise<Record<string, unknown>> {
  const fieldBytes: Record<string, number> = {}
  for (const h of state.runs.handles.values()) for (const [k, v] of Object.entries(h)) {
    let n = 0
    try { n = typeof v === 'string' ? Buffer.byteLength(v) : Buffer.byteLength(JSON.stringify(v) ?? '') } catch { n = -1 }
    fieldBytes[k] = (fieldBytes[k] ?? 0) + n
  }
  const top = Object.fromEntries(Object.entries(fieldBytes).sort((a, b) => b[1] - a[1]).slice(0, 12))
  const gc = async () => { await memory(); return memory() }   // two full-GC rounds before every reading
  const base = await gc()
  const steps: { cleared: string; heap_used_mb: number; freed_mb: number; objects: number }[] = []
  let prev = base
  // one field at a time, cumulatively, on finished handles only; then the finished handles themselves
  // the model wrapper chain under each finished handle's meter: every own property of every level, one at a time
  // (by class name and property), deepest first, so the level that actually holds the memory is named
  const chains = [...state.runs.handles.values()].filter((h) => h.done && h.meter).map((h) => {
    const levels: Record<string, unknown>[] = []
    let cur: unknown = (h.meter as unknown as { wrapped: unknown }).wrapped
    while (cur && typeof cur === 'object' && levels.length < 8) { levels.push(cur as Record<string, unknown>); cur = (cur as { wrapped?: unknown }).wrapped }
    return levels
  })
  const depth = Math.max(0, ...chains.map((c) => c.length))
  for (let d = depth - 1; d >= 0; d--) {
    const names = new Set<string>()
    for (const c of chains) if (c[d]) for (const k of Object.keys(c[d]!)) if (k !== 'wrapped') names.add(k)
    for (const k of names) {
      for (const c of chains) if (c[d] && k in c[d]!) c[d]![k] = null
      const m = await gc()
      steps.push({ cleared: `meter.wrapped^${d} ${chains.find((c) => c[d])?.[d]?.constructor?.name}.${k}`, heap_used_mb: m.heap_used_mb, freed_mb: round(prev.heap_used_mb - m.heap_used_mb, 2), objects: m.objects })
      prev = m
    }
  }
  for (const sub of ['contextEstimate', 'record', 'emit', 'wrapped']) {
    for (const h of state.runs.handles.values()) if (h.done && h.meter) (h.meter as unknown as Record<string, unknown>)[sub] = null
    const m = await gc()
    steps.push({ cleared: `meter.${sub}`, heap_used_mb: m.heap_used_mb, freed_mb: round(prev.heap_used_mb - m.heap_used_mb, 2), objects: m.objects })
    prev = m
  }
  for (const field of ['stash_json', 'task', 'meter', 'steer', 'token', 'tool_snapshot', 'events', 'cfg', 'collab', 'budget', 'work_order', 'mentions', 'produced', 'handover', 'queues', 'final_text']) {
    for (const h of state.runs.handles.values()) if (h.done) (h as unknown as Record<string, unknown>)[field] = null
    const m = await gc()
    steps.push({ cleared: field, heap_used_mb: m.heap_used_mb, freed_mb: round(prev.heap_used_mb - m.heap_used_mb, 2), objects: m.objects })
    prev = m
  }
  const done = [...state.runs.handles.entries()].filter(([, h]) => h.done).map(([id]) => id)
  for (const id of done) state.runs.handles.delete(id)
  const noHandles = await gc()
  steps.push({ cleared: 'finished handles (map entries)', heap_used_mb: noHandles.heap_used_mb, freed_mb: round(prev.heap_used_mb - noHandles.heap_used_mb, 2), objects: noHandles.objects })
  return {
    note: 'counterfactual, bench process only, after fingerprints; not a product behavior',
    handle_field_json_bytes_total: top, heap_measured: base, steps, heap_without_finished_handles: noHandles,
    freed_total_mb: round(base.heap_used_mb - noHandles.heap_used_mb, 2), rss_after_mb: noHandles.rss_mb, finished_handles_dropped: done.length,
  }
}

if (longTurns > 0) {
  const seedRun = await app.state.runs.start(session, 'seed run', {})
  seedIdForDump = seedRun.id
  await state.runs.handles.get(seedRun.id)!.task
  const json = JSON.stringify(buildHistory({ turns: longTurns, tool_calls_per_turn: 3, seed: 42 }))
  repo.saveRunProgress(state.conn, seedRun.id, json, {}, repo.getRun(state.conn, seedRun.id)!.saved_seq ?? 0)
  const longSamples: Record<string, unknown>[] = []
  const wall: number[] = [], submit: number[] = [], statusesLong: Record<string, number> = {}
  let lastRun = seedRun.id
  for (let i = 1; i <= longWarmup + longRuns; i++) {
    const before = stub.calls.length
    const ts = performance.now()
    const res = await request(app, 'POST', `/api/sessions/${session.id}/chat`, { text: `synthetic follow-up ${i}` })
    const body = await res.json() as { id?: string }
    if (!body.id) throw new Error(`chat ${res.status}: ${JSON.stringify(body).slice(0, 300)}`)
    const consuming = consumeRun(body.id)
    await state.runs.handles.get(body.id)!.task
    await consuming
    if (stub.calls.length > before) submit.push(stub.calls[before]!.at - ts)
    wall.push(performance.now() - ts)
    const run = repo.getRun(state.conn, body.id)!
    statusesLong[run.status] = (statusesLong[run.status] ?? 0) + 1
    if (run.resumes_run_id !== lastRun) throw new Error(`run ${i} did not continue the record (resumes ${run.resumes_run_id})`)
    lastRun = body.id
    if (i === longWarmup || (i > longWarmup && ((i - longWarmup) % 5 === 0 || i === longWarmup + longRuns))) {
      const m = await memory()
      const r = retained()
      longSamples.push({ run: i - longWarmup, ...m, ...r, ...retainedBytes(), persisted_record_bytes: persistedRecordBytes(), provider_requests: stub.calls.length, last_request_bytes: stub.calls.at(-1)?.bytes ?? 0 })
      console.log(`long run ${i - longWarmup}: heap=${m.heap_used_mb}MB rss=${m.rss_mb}MB stash=${round(retainedBytes().stash_json_bytes / 2 ** 20, 2)}MB handles=${r.handles} events=${r.handle_events} persisted=${round(persistedRecordBytes() / 2 ** 20, 2)}MB`)
    }
  }
  const first = longSamples[0]!, last = longSamples.at(-1)!
  const delta = (k: string) => round((last[k] as number) - (first[k] as number), 3)
  sessionStop.abort()
  await sessionReading.catch(() => {})
  writeResult(argValue('name', 'lifecycle_long')!, {
    bench: 'lifecycle_long', ...meta(), scenario: 'coverage: long synthetic record + consecutive successful continuations (window raised so no compaction triggers); not the default configuration',
    level: `POST /chat + GET run SSE + session SSE over in-process app.request; real AnthropicModel mapping to ${server ? 'a loopback HTTP stub (Bun.serve port 0)' : 'an in-process fetch stub'}`,
    params: { long_history_turns: longTurns, long_runs: longRuns, warmup_runs: longWarmup, window_tokens: windowTokens, seed_record_bytes: Buffer.byteLength(json) },
    statuses: statusesLong, compactions: Number(state.conn.get("SELECT COUNT(*) AS n FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE session_id=?) AND event = 'context_compacted'", [session.id])?.n ?? NaN),
    submit_to_provider_ms: summarize(submit.slice(longWarmup)), run_wall_ms: summarize(wall.slice(longWarmup)),
    growth_over_measured_runs: { runs: longRuns, heap_used_mb: delta('heap_used_mb'), rss_mb: delta('rss_mb'), stash_json_mb: round(delta('stash_json_bytes') / 2 ** 20, 3), persisted_record_mb: round(delta('persisted_record_bytes') / 2 ** 20, 3), handle_events: delta('handle_events'), handles: delta('handles') },
    samples: longSamples, fingerprints_last_run: await fingerprints(lastRun), fingerprints_seed_run: await fingerprints(seedRun.id),
    retention_attribution: await attribution(),
  })
  await app.close()
  server?.stop(true)
  process.exit(0)
}

const samples: Record<string, unknown>[] = []
const typesAtWarm: Record<string, number> = {}
const submitMs: Record<Outcome, number[]> = { success: [], failure: [], cancel: [] }
const runMs: Record<Outcome, number[]> = { success: [], failure: [], cancel: [] }
const statuses: Record<string, number> = {}
const t0 = performance.now()
for (let i = 1; i <= runs; i++) {
  mode = (['success', 'failure', 'cancel'] as const)[i % 3]!
  const before = stub.calls.length
  const ts = performance.now()
  const res = await request(app, 'POST', `/api/sessions/${session.id}/chat`, { text: `synthetic short task ${i}`, fresh: true })
  const body = await res.json() as { id?: string; run?: { id: string }; detail?: string }
  const runId = body.id ?? body.run?.id
  if (!runId) throw new Error(`chat ${res.status}: ${JSON.stringify(body).slice(0, 300)}`)
  const consuming = consumeRun(runId)
  while (stub.calls.length === before && !state.runs.handles.get(runId)?.done) await sleep(1)
  if (stub.calls.length > before) submitMs[mode].push(stub.calls[before]!.at - ts)
  if (mode === 'cancel') { await sleep(2); await request(app, 'POST', `/api/runs/${runId}/cancel`, {}) }
  await state.runs.handles.get(runId)!.task
  await consuming
  runMs[mode].push(performance.now() - ts)
  const st = (await (await request(app, 'GET', `/api/runs/${runId}`)).json() as { status: string }).status
  statuses[`${mode}:${st}`] = (statuses[`${mode}:${st}`] ?? 0) + 1
  if (i % sampleEvery === 0 || i === 1 || i === warmup) {
    const m = await memory()
    const types = heapStats().objectTypeCounts as Record<string, number>
    if (i === warmup) Object.assign(typesAtWarm, types)
    samples.push({ run: i, t_s: round((performance.now() - t0) / 1000, 1), ...m, ...retained(), session_frames: sessionFrames })
    console.log(`run ${i}: heap=${m.heap_used_mb}MB rss=${m.rss_mb}MB objects=${m.objects} fds=${m.fds} ${JSON.stringify(retained())}`)
  }
}
const typesEnd = heapStats().objectTypeCounts as Record<string, number>
const typeGrowth = Object.entries(typesEnd).map(([k, v]) => [k, v - (typesAtWarm[k] ?? 0)] as const).filter(([, d]) => d > 0).sort((a, b) => b[1] - a[1]).slice(0, 25)
const post = samples.filter((s) => (s.run as number) >= warmup)
const trend = Object.fromEntries(['heap_used_mb', 'rss_mb', 'objects', 'fds', 'handles', 'handle_events', 'transient_events', 'stash_json_mb', 'live_run_queues', 'session_queues'].map((k) => {
  const r = linreg(post.map((s) => s.run as number), post.map((s) => s[k] as number))
  return [k, { per_run: round(r.slope, 5), per_1000_runs: round(r.slope * 1000, 2), r2: round(r.r2, 3) }]
}))
sessionStop.abort()
await sessionReading.catch(() => {})
writeResult('lifecycle', {
  bench: 'lifecycle', ...meta(), level: `POST /chat + GET run SSE + session SSE over in-process app.request; real AnthropicModel mapping to ${server ? 'a loopback HTTP stub (Bun.serve port 0)' : 'an in-process fetch stub'}`,
  params: { runs, warmup, sample_every: sampleEvery, cycle: ['cancel', 'success', 'failure'] }, statuses,
  submit_to_provider_ms: Object.fromEntries(Object.entries(submitMs).map(([k, v]) => [k, summarize(v)])),
  run_wall_ms: Object.fromEntries(Object.entries(runMs).map(([k, v]) => [k, summarize(v)])),
  trend_post_warmup: trend, samples, object_type_growth_since_warmup: Object.fromEntries(typeGrowth),
})
await app.close()
server?.stop(true)
process.exit(0)
