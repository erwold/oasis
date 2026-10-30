/** A run's event stream over time: a subscriber that goes away while the run is quiet is let go at once (not at the
 *  run's next event), a quiet stream says it is alive, and a subscriber that falls too far behind is ended so its
 *  client resubscribes from its cursor instead of a queue growing without bound. */

import { afterEach, expect, test } from 'bun:test'
import { SUBSCRIBER_BACKLOG } from '../src/agent/runner.ts'
import { modelResponse, textPart } from '../src/llm/messages.ts'
import { createApp, type App } from '../src/main.ts'
import { Client, json } from './api_harness.ts'
import { buggyRepo, scriptedModel, setModel, testConfig, testSettings, waitDone } from './harness.ts'

let app: App | null = null
let release: () => void = () => {}
afterEach(async () => { release(); if (app) await app.close(); app = null })

/** An app whose model holds its first request until released: a run that stays quiet as long as the test likes —
 *  answered once the run is quiet: its first request has reached the model (run_started is written before that
 *  request, after the run's admission, which may take its folder's baseline first). */
async function quietRun(heartbeatMs = 15_000) {
  app = await createApp(testSettings(), testConfig(), { probe: false, sse_heartbeat_ms: heartbeatMs })
  const held = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => { entered = resolve })
  setModel(app.state, 'scripted:a', scriptedModel(async () => { entered(); await held; return modelResponse([textPart('done')]) }))
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'quiet' }))
  const run = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'wait' }))
  await waiting
  return { c, runId: run.id as string, handle: app.state.runs.handles.get(run.id as string)! }
}

const tick = () => new Promise((r) => setTimeout(r, 20))

test('a subscriber aborted while the run is quiet is removed at once', async () => {
  const { runId, handle } = await quietRun()
  const gone = new AbortController()
  const events = app!.state.runs.subscribe(runId, { signal: gone.signal })
  const seen: string[] = []
  const reading = (async () => { for await (const e of events) seen.push(e.event) })()
  while (handle.queues.length === 0) await tick()
  await tick()                                                                 // replayed what there was; now waiting
  expect(handle.queues.length).toBe(1)
  gone.abort()
  await reading                                                                // ends without the run sending anything
  expect(handle.queues.length).toBe(0)
  expect(seen).toContain('run_started')
  const late = app!.state.runs.subscribe(runId, { signal: gone.signal })       // already aborted: nothing, nothing kept
  expect((await late.next()).done).toBe(true)
  expect(handle.queues.length).toBe(0)
})

test('over HTTP a quiet stream sends keep-alive comments, and a client that goes away is let go', async () => {
  const { c, runId, handle } = await quietRun(40)
  const response = await c.get(`/api/runs/${runId}/events`)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const until = Date.now() + 3000
  while (!text.includes(': keep-alive') && Date.now() < until) text += decoder.decode((await reader.read()).value ?? new Uint8Array(), { stream: true })
  expect(text).toContain('event: run_started')
  expect(text).toContain(': keep-alive')
  expect(handle.queues.length).toBe(1)
  await reader.cancel()
  const deadline = Date.now() + 2000
  while (handle.queues.length && Date.now() < deadline) await tick()
  expect(handle.queues.length).toBe(0)
  release()
  await waitDone(app!.state, runId)
})

test('a subscriber too far behind is ended; its client resubscribes after its cursor and misses nothing', async () => {
  const { runId, handle } = await quietRun()
  const events = app!.state.runs.subscribe(runId)
  const first = await events.next()                                            // one read, then the reader stalls
  const cursor = first.value!.seq
  while (handle.queues.length === 0) await tick()
  const emit = (app!.state.runs as unknown as { emit: (h: typeof handle, e: string, d: Record<string, unknown>) => void }).emit.bind(app!.state.runs)
  for (let i = 0; i < SUBSCRIBER_BACKLOG + 10; i += 1) emit(handle, 'text_delta', { text: String(i) })
  // what the stalled subscriber still yields is what it had replayed before; then it ends instead of growing
  let rest = 0
  for await (const e of events) { void e; rest += 1 }
  expect(rest).toBeLessThan(SUBSCRIBER_BACKLOG)
  expect(handle.queues.length).toBe(0)
  const again: number[] = []
  const gone = new AbortController()
  const resumed = (async () => { for await (const e of app!.state.runs.subscribe(runId, { after_seq: cursor, signal: gone.signal })) again.push(e.seq) })()
  while (again.length < handle.events.length - cursor - 1) await tick()
  gone.abort()
  await resumed
  expect(again[0]).toBe(cursor + 1)
  expect(again.at(-1)).toBe(handle.events.at(-1)!.seq)
  expect(new Set(again).size).toBe(again.length)
})
