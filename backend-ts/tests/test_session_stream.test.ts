/** The session's one stream over HTTP (GET /api/sessions/:id/events): the detail's event_cursor, every run of the
 *  session on one connection — one live at the snapshot heard whole, one started later heard without a new request —
 *  each frame naming its run and seq with the session cursor as its id, a resume after Last-Event-ID that repeats
 *  nothing, and the run's own stream (GET /api/runs/:id/events) unchanged beside it. */

import { afterEach, expect, test } from 'bun:test'
import { SESSION_STREAM_READY } from '@oasis-code/contract'
import { modelResponse, textPart } from '../src/llm/messages.ts'
import { createApp, type App } from '../src/main.ts'
import { Client, json, parseSse } from './api_harness.ts'
import { buggyRepo, scriptedModel, setModel, testConfig, testSettings, waitDone } from './harness.ts'

let app: App | null = null
let release: () => void = () => {}
afterEach(async () => { release(); if (app) await app.close(); app = null })

/** Reads an SSE body until `done` says the frames so far are enough (or the time runs out). */
async function readUntil(response: Response, done: (frames: ReturnType<typeof parseSse>) => boolean, ms = 5000) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const until = Date.now() + ms
  while (Date.now() < until) {
    const frames = parseSse(text)
    if (done(frames)) { await reader.cancel(); return frames }
    const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), until - Date.now()))])
    if (chunk === null || chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }
  await reader.cancel()
  return parseSse(text)
}

async function heldSession() {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  let gates: (() => void)[] = []
  release = () => { for (const g of gates) g(); gates = [] }
  // a handshake: the model call has entered its gate (a release before that would free nothing and the run would hang)
  let onEntered: (() => void) | null = null
  const entered = () => new Promise<void>((r) => { if (gates.length > 0) r(); else onEntered = r })
  setModel(app.state, 'scripted:a', scriptedModel(async () => {
    await new Promise<void>((r) => { gates.push(r); onEntered?.(); onEntered = null })
    return modelResponse([textPart('done')])
  }))
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'one stream' }))
  return { c, sessionId: session.id as string, entered }
}

test('one connection hears a run live at the snapshot whole and a run started later, each frame with its run, seq and cursor', async () => {
  const { c, sessionId, entered } = await heldSession()
  const first = await json(await c.post(`/api/sessions/${sessionId}/chat`, { text: 'first' }))
  const detail = await json(await c.get(`/api/sessions/${sessionId}`))
  expect(typeof detail.event_cursor).toBe('number')
  const stream = await c.get(`/api/sessions/${sessionId}/events`, { after: detail.event_cursor as number })
  expect(stream.status).toBe(200)
  expect(stream.headers.get('content-type')).toContain('text/event-stream')
  const reading = readUntil(stream, (frames) => frames.some((f) => f.event === 'run_finished' && f.data.run_id !== first.id), 20_000)
  // the first run ends; the second starts after the stream was opened: no other request is needed to hear it
  const deadline = Date.now() + 5000
  while (app!.state.runs.sessions.subscribers(sessionId) === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  await entered()
  release()
  await waitDone(app!.state, first.id as string)
  const second = await json(await c.post(`/api/sessions/${sessionId}/chat`, { text: 'second' }))
  const wait = setInterval(() => release(), 20)
  try { await waitDone(app!.state, second.id as string) } finally { clearInterval(wait) }
  const frames = await reading
  const of = (runId: unknown) => frames.filter((f) => f.data.run_id === runId)
  expect(of(first.id)[0]).toMatchObject({ event: 'run_started', data: { run_id: first.id, seq: 0 } })
  expect(of(first.id).map((f) => f.event)).toContain('run_finished')
  expect(of(second.id)[0]).toMatchObject({ event: 'run_started', data: { run_id: second.id, seq: 0 } })
  expect(frames.filter((f) => f.event === SESSION_STREAM_READY)).toHaveLength(1)
  for (const runId of [first.id, second.id]) {
    const seqs = of(runId).map((f) => f.data.seq as number)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  }
  for (let i = 1; i < frames.length; i += 1) expect(frames[i]!.id).toBeGreaterThanOrEqual(frames[i - 1]!.id)
  // the run's own stream is still there, as it was
  const own = parseSse(await (await c.get(`/api/runs/${second.id}/events`)).text())
  expect(own.map((f) => f.event)).toEqual(of(second.id).map((f) => f.event))
  expect(own.at(-1)!.event).toBe('run_finished')
})

test('a resume after Last-Event-ID repeats nothing the client had; an unknown session is 404', async () => {
  const { c, sessionId } = await heldSession()
  const run = await json(await c.post(`/api/sessions/${sessionId}/chat`, { text: 'one' }))
  const wait = setInterval(() => release(), 20)
  try { await waitDone(app!.state, run.id as string) } finally { clearInterval(wait) }
  const whole = await readUntil(await c.get(`/api/sessions/${sessionId}/events`, { after: 0 }), (f) => f.some((x) => x.event === SESSION_STREAM_READY))
  const events = whole.filter((f) => f.event !== SESSION_STREAM_READY)
  expect(events.at(-1)!.event).toBe('run_finished')
  const cut = events[Math.floor(events.length / 2)]!
  const again = await readUntil(await c.get(`/api/sessions/${sessionId}/events`, undefined, { 'last-event-id': String(cut.id) }), (f) => f.some((x) => x.event === SESSION_STREAM_READY))
  const keyOf = (f: { data: Record<string, unknown> }) => `${f.data.run_id}#${f.data.seq}`
  const had = new Set(events.filter((f) => f.id <= cut.id).map(keyOf))
  const resumed = again.filter((f) => f.event !== SESSION_STREAM_READY)
  // only a delta after the last written event at the cursor comes again (the client drops it by seq)
  expect(resumed.filter((f) => had.has(keyOf(f))).every((f) => f.event.endsWith('_delta') || f.event === 'tool_call_progress')).toBe(true)
  expect(new Set([...had, ...resumed.map(keyOf)])).toEqual(new Set(events.map(keyOf)))
  expect((await c.get('/api/sessions/s_missing/events')).status).toBe(404)
})

test('a run\'s record in pages: bounded, in seq order, the same events as its stream; a bad page is refused', async () => {
  const { c, sessionId } = await heldSession()
  const run = await json(await c.post(`/api/sessions/${sessionId}/chat`, { text: 'one' }))
  const wait = setInterval(() => release(), 20)
  try { await waitDone(app!.state, run.id as string) } finally { clearInterval(wait) }
  const own = parseSse(await (await c.get(`/api/runs/${run.id}/events`)).text())
  const read: { seq: number; event: string }[] = []
  for (let after = -1; ;) {
    const page = await json<{ events: { seq: number; event: string }[] }>(await c.get(`/api/runs/${run.id}/events/page`, { after, limit: 2 }))
    expect(page.events.length).toBeLessThanOrEqual(2)
    read.push(...page.events)
    if (page.events.length < 2) break
    after = page.events.at(-1)!.seq
  }
  expect(read.map((e) => e.event)).toEqual(own.map((f) => f.event))
  expect((await c.get(`/api/runs/${run.id}/events/page`, { limit: 5000 })).status).toBe(400)
  expect((await c.get('/api/runs/run_missing/events/page')).status).toBe(404)
})
