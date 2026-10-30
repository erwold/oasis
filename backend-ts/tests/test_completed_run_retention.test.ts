/** A finished run's handle stays (late streams, Stop answers, the session's replay) but lets go of what only a live
 *  run reads: its usage meter (and with it the model chain and the callbacks the meter holds) once its end is written,
 *  and no serialized copy of the record beside the database's. Each terminal path — done, a provider's failure, a Stop,
 *  a budget line — is checked for that structure and for what the run wrote and answers: the record, the usage, the
 *  context anchor, the model requests, the receipt, GET /api/runs/:id, the transcript, the context report, and the
 *  events — the late run stream, the events page, the saved rows and the session stream's replay, payloads included.
 *  A run still going on the same route keeps its meter, and the route's shared model is never closed. */

import { afterEach, expect, test } from 'bun:test'
import * as repo from '../src/db/repo.ts'
import type { RunEvent, RunHandle } from '../src/agent/runner.ts'
import type { App } from '../src/main.ts'
import { loadValue, modelResponse, textPart, toolCallPart, userTexts, type ModelMessage } from '../src/llm/messages.ts'
import { ModelHTTPError } from '../src/llm/model.ts'
import { ScriptedModel, type Script } from '../src/llm/scripted.ts'
import { Client, json, makeApp, parseSse } from './api_harness.ts'
import { buggyRepo, collectEvents, openSession, setModel, waitDone } from './harness.ts'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

const MODEL = 'scripted:a'
type Rec = Record<string, unknown>

/** The route's model, shared by every run on it: a close would end it for all of them. */
class SharedModel extends ScriptedModel {
  closes = 0
  constructor(script: Script) { super(script, { modelName: 'scripted' }) }
  async close(): Promise<void> { this.closes += 1 }
}

/** A request that waits: `entered` once the model has it, answered after `release` (always called in a finally). */
function requestGate() {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((r) => { enter = r })
  const released = new Promise<void>((r) => { release = r })
  return { entered, enter, released, release }
}

const counted = (input: number, output = 5) => ({ usage: { input_tokens: input, output_tokens: output } as never })
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const handleOf = (runId: string): RunHandle => app!.state.runs.handles.get(runId)!
/** whether each live (not finished) run holds its meter, as a model request sees them */
const liveMeters = (): boolean[] => [...app!.state.runs.handles.values()].filter((h) => !h.done).map((h) => h.meter !== null)
const record = (runId: string): ModelMessage[] => loadValue(JSON.parse(repo.getRunHistory(app!.state.conn, runId) ?? 'null')) as ModelMessage[]

async function setup(script: Script) {
  app = await makeApp()
  const model = new SharedModel(script)
  setModel(app.state, MODEL, model)
  return { c: new Client(app), model }
}

/** A finished handle: kept, with its task, its events and its end, without the meter or a stash copy. */
function expectReleased(runId: string): RunHandle {
  const h = handleOf(runId)
  expect(h.done).toBe(true)
  expect(h.task).not.toBeNull()
  expect(h.meter).toBeNull()
  expect('stash_json' in h).toBe(false)
  expect(h.events.at(-1)!.event).toBe('run_finished')
  expect(h.queues).toHaveLength(0)
  return h
}

/** The session stream's replay from cursor 0 up to its ready frame: each run event as { run_id, seq, event, data }. */
async function sessionReplay(c: Client, sessionId: string): Promise<{ run_id: string; seq: number; event: string; data: Rec }[]> {
  const res = await c.get(`/api/sessions/${sessionId}/events`, { after: 0 })
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  const out: { run_id: string; seq: number; event: string; data: Rec }[] = []
  let buf = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return out
      buf += dec.decode(chunk.value, { stream: true })
      let at: number
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, at + 2)
        buf = buf.slice(at + 2)
        for (const f of parseSse(block)) {
          if (f.event === 'stream_ready') return out
          const d = f.data as { run_id: string; seq: number; data: Rec }
          out.push({ run_id: d.run_id, seq: d.seq, event: f.event, data: d.data })
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/** Every way the finished run's events are read answers what the live stream carried, payloads included: the late
 *  stream from memory (whole events), the run's SSE, the events page (from the held handle), the saved rows and the
 *  session replay (each the live event of the same seq). */
async function expectReplays(c: Client, runId: string, sessionId: string, live: RunEvent[]): Promise<void> {
  expect(live.at(-1)!.event).toBe('run_finished')
  const late = await collectEvents(app!.state, runId)
  expect(late).toEqual(live)
  const bySeq = new Map(live.map((e) => [e.seq, { seq: e.seq, event: e.event, data: plain(e.data) }]))
  const sse = parseSse(await (await c.get(`/api/runs/${runId}/events`)).text())
  expect(sse).toEqual(live.map((e) => ({ event: e.event, id: e.seq, data: plain(e.data) })))
  const page = await json<{ events: { seq: number; event: string; data: Rec }[] }>(await c.get(`/api/runs/${runId}/events/page`, { after: -1, limit: 1000 }))
  expect(page.events).toEqual([...bySeq.values()])
  const saved = repo.listEvents(app!.state.conn, runId)
  expect(saved.length).toBeGreaterThan(0)
  expect(saved.at(-1)!.event).toBe('run_finished')
  expect(saved.map((e) => ({ seq: e.seq, event: e.event, data: plain(e.data) }))).toEqual(saved.map((e) => bySeq.get(e.seq)!))
  const frames = (await sessionReplay(c, sessionId)).filter((f) => f.run_id === runId)
  expect(frames.map((f) => f.seq)).toEqual(expect.arrayContaining(saved.map((e) => e.seq)))
  expect(frames.map(({ seq, event, data }) => ({ seq, event, data }))).toEqual(frames.map((f) => bySeq.get(f.seq)!))
}

/** GET /api/runs/:id is the row as written (status, usage, receipt, error) and its model requests, not live; the
 *  receipt route answers the same receipt. */
async function expectRunAnswer(c: Client, runId: string): Promise<Rec> {
  const row = repo.getRun(app!.state.conn, runId)!
  const got = await json(await c.get(`/api/runs/${runId}`))
  expect(got.live).toBe(false)
  expect({ status: got.status, usage: got.usage, receipt: got.receipt, error: got.error }).toEqual(plain({ status: row.status, usage: row.usage, receipt: row.receipt, error: row.error }))
  expect(got.requests).toEqual(plain(repo.listModelRequests(app!.state.conn, runId)))
  const receipt = await json(await c.get(`/api/runs/${runId}/receipt`))
  expect(receipt.receipt).toEqual(plain(row.receipt))
  return got
}

test('a finished run lets go of its meter and keeps no stash copy; its record, usage, anchor, requests, receipt, reads and the next run are as before', async () => {
  const during: boolean[][] = []
  const prompts: number[] = []
  let n = 0
  const { c, model } = await setup((m) => {
    during.push(liveMeters())
    prompts.push(m.length)
    n += 1
    if (n === 1) return modelResponse([textPart('Looking.'), toolCallPart('read_file', { path: 'calc.py' }, 'r1')], counted(900))
    if (n === 2) return modelResponse([textPart('Done.')], counted(1200))
    return modelResponse([textPart('Again.')], counted(1500))
  })
  const { session } = await openSession(app!.state, buggyRepo())
  const started = await app!.state.runs.start(session, 'read calc.py')
  const live = collectEvents(app!.state, started.id)
  const run = await waitDone(app!.state, started.id)
  const liveEvents = await live
  expect(during).toEqual([[true], [true]])                                    // each request saw its run holding the meter
  expect(run.status).toBe('done')
  expectReleased(run.id)
  // the record, the meter's totals and the anchor the next run starts from
  const messages = record(run.id)
  expect(messages).toHaveLength(4)
  expect(JSON.stringify(messages[2])).toContain('read_file')
  expect(JSON.stringify(messages[3])).toContain('Done.')
  expect(run.usage).toMatchObject({ requests: 2, tool_calls: 1, input_tokens: 2100, output_tokens: 10, model: MODEL })
  expect(Number(run.usage.history_bytes)).toBe(Buffer.byteLength(repo.getRunHistory(app!.state.conn, run.id)!, 'utf8'))
  expect(run.usage.context_anchor).toMatchObject({ input_tokens: 1200 })
  expect(run.receipt).toMatchObject({ status: 'done', final_text: 'Done.' })
  expect((run.receipt.mechanical as Rec).tool_calls).toBe(1)
  const got = await expectRunAnswer(c, run.id)
  expect((got.requests as Rec[]).map((r) => [r.input_tokens, r.output_tokens, r.status])).toEqual([[900, 5, 'ok'], [1200, 5, 'ok']])
  const transcript = await json(await c.get(`/api/runs/${run.id}/transcript`))
  expect(transcript.status).toBe('done')
  expect(JSON.stringify(transcript.entries)).toContain('Done.')
  expect(JSON.stringify(transcript.entries)).toContain('read_file')
  // the session's context report reads the finished run's anchor (the provider's count of its last request)
  const report = await json(await c.get(`/api/sessions/${session.id}/context`))
  expect(String(report.estimate_basis)).toContain("provider's count of the last run's last request")
  expect(liveEvents.some((e) => e.event === 'text_delta')).toBe(true)        // a transient event, in every in-memory replay
  await expectReplays(c, run.id, session.id, liveEvents)
  // the next run continues the conversation from the record, and lets go in turn
  const next = await waitDone(app!.state, (await app!.state.runs.start(repo.getSession(app!.state.conn, session.id)!, 'and again')).id)
  expect(next.status).toBe('done')
  expect(next.resumes_run_id).toBe(run.id)
  expect(prompts[2]!).toBeGreaterThan(messages.length)
  expect(record(next.id).slice(0, 4)).toEqual(messages)
  expect(userTexts(record(next.id)).some((t) => t.includes('and again'))).toBe(true)
  expectReleased(next.id)
  expect(model.closes).toBe(0)
})

test('a run on the same route still in its request keeps its meter while another finishes; the shared model is not closed', async () => {
  const slowGate = requestGate()
  let slowSaw: boolean[] = []
  const { c, model } = await setup(async (messages) => {
    if (JSON.stringify(messages).includes('the slow one')) {
      slowGate.enter()
      await slowGate.released
      slowSaw = liveMeters()
      return modelResponse([textPart('slow done')], counted(700))
    }
    return modelResponse([textPart('fast done')], counted(600))
  })
  try {
    const a = await openSession(app!.state, buggyRepo())
    const b = await openSession(app!.state, buggyRepo())
    const slow = await app!.state.runs.start(b.session, 'the slow one')
    const slowLive = collectEvents(app!.state, slow.id)
    await slowGate.entered
    const started = await app!.state.runs.start(a.session, 'the fast one')
    const fastLive = collectEvents(app!.state, started.id)
    const fast = await waitDone(app!.state, started.id)
    expect(fast.status).toBe('done')
    expectReleased(fast.id)
    await expectRunAnswer(c, fast.id)
    await expectReplays(c, fast.id, a.session.id, await fastLive)
    // the slow run, still in its request, holds its own
    expect(handleOf(slow.id).done).toBe(false)
    expect(handleOf(slow.id).meter).not.toBeNull()
    slowGate.release()
    const ended = await waitDone(app!.state, slow.id)
    expect(ended.status).toBe('done')
    expect(slowSaw).toEqual([true])
    expect(ended.usage).toMatchObject({ requests: 1, input_tokens: 700 })
    expect(ended.receipt.final_text).toBe('slow done')
    expectReleased(slow.id)
    await expectRunAnswer(c, slow.id)
    await expectReplays(c, slow.id, b.session.id, await slowLive)
    expect(model.closes).toBe(0)
  } finally {
    slowGate.release()
  }
})

test('a provider failure ends the run with its record, usage and error written, then lets go of the meter', async () => {
  let n = 0
  const { c, model } = await setup(() => {
    n += 1
    if (n === 1) return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, 'r1')], counted(800))
    throw new ModelHTTPError(401, 'scripted', { error: { message: 'invalid api key' } })
  })
  const { session } = await openSession(app!.state, buggyRepo())
  const started = await app!.state.runs.start(session, 'read calc.py')
  const live = collectEvents(app!.state, started.id)
  const run = await waitDone(app!.state, started.id)
  expect(run.status).toBe('error')
  expect(run.error).toContain('401')
  expectReleased(run.id)
  expect(run.usage).toMatchObject({ tool_calls: 1, model: MODEL })
  expect(run.receipt.status).toBe('error')
  // the record keeps the call and its return (the stash written at the failure)
  const messages = record(run.id)
  expect(messages.length).toBeGreaterThanOrEqual(3)
  expect(JSON.stringify(messages.slice(1))).toContain('read_file')
  expect(Number(run.usage.history_bytes)).toBe(Buffer.byteLength(repo.getRunHistory(app!.state.conn, run.id)!, 'utf8'))
  await expectRunAnswer(c, run.id)
  const liveEvents = await live
  expect(liveEvents.find((e) => e.event === 'error')!.data).toMatchObject({ kind: 'auth', model: MODEL })
  await expectReplays(c, run.id, session.id, liveEvents)
  expect(model.closes).toBe(0)
})

test('a Stop during a request ends the run cancelled with what it had, then lets go of the meter', async () => {
  const gate = requestGate()
  let saw: boolean[] = []
  let n = 0
  const { c, model } = await setup(async () => {
    n += 1
    if (n === 1) return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, 'r1')], counted(800))
    saw = liveMeters()
    gate.enter()
    await gate.released
    return modelResponse([textPart('too late')], counted(900))
  })
  try {
    const { session } = await openSession(app!.state, buggyRepo())
    const started = await app!.state.runs.start(session, 'read calc.py')
    const live = collectEvents(app!.state, started.id)
    await gate.entered
    expect(saw).toEqual([true])
    expect(app!.state.runs.cancel(started.id)).toBe(true)
    const run = await waitDone(app!.state, started.id)
    expect(run.status).toBe('cancelled')
    expectReleased(run.id)
    expect(app!.state.runs.cancel(run.id)).toBe(false)                         // a finished run answers a Stop as before
    expect(run.usage).toMatchObject({ tool_calls: 1, model: MODEL })
    expect(run.receipt.status).toBe('cancelled')
    expect(JSON.stringify(record(run.id))).toContain('read_file')
    await expectRunAnswer(c, run.id)
    await expectReplays(c, run.id, session.id, await live)
    expect(model.closes).toBe(0)
  } finally {
    gate.release()
  }
})

test('a budget line ends the run through its closing turn, or at the line when the closing turn files no report, then lets go of the meter', async () => {
  // two reads, then the closing request (the third, carrying the closing note) answers with the report
  const closingNotes: boolean[] = []
  let n = 0
  const { c, model } = await setup((messages) => {
    n += 1
    if (n <= 2) return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, '')], counted(400))
    closingNotes.push(userTexts(messages).some((t) => t.includes('tool_calls 2 of 2')))
    return modelResponse([textPart('closing report: 2 reads done')], counted(500))
  })
  const { session } = await openSession(app!.state, buggyRepo())
  const started = await app!.state.runs.start(session, 'loop', { budget: { tool_calls: 2 } })
  const live = collectEvents(app!.state, started.id)
  const run = await waitDone(app!.state, started.id)
  expect(run.status).toBe('done')
  expect(closingNotes).toEqual([true])
  expect(run.receipt.final_text).toBe('closing report: 2 reads done')
  expect((run.receipt.mechanical as Rec).budget_reached).toBe('tool_calls 2 of 2')
  expect(run.usage).toMatchObject({ requests: 3, tool_calls: 2 })
  expectReleased(run.id)
  await expectRunAnswer(c, run.id)
  const liveEvents = await live
  expect(liveEvents.filter((e) => e.event === 'budget_closing').map((e) => e.data)).toEqual([{ reason: 'tool_calls 2 of 2' }])
  await expectReplays(c, run.id, session.id, liveEvents)
  // a closing turn that keeps calling the tool files no report: the run ends at its line
  const looping = new SharedModel(() => modelResponse([toolCallPart('read_file', { path: 'calc.py' }, '')], counted(400)))
  setModel(app!.state, MODEL, looping)
  const overStarted = await app!.state.runs.start(repo.getSession(app!.state.conn, session.id)!, 'loop again', { budget: { tool_calls: 2 }, fresh: true })
  const overLive = collectEvents(app!.state, overStarted.id)
  const over = await waitDone(app!.state, overStarted.id)
  expect(over.status).toBe('error')
  expect(over.error).toContain('budget_exceeded: tool_calls 2 of 2')
  expect(over.error).toContain('filed no report')
  expect(over.receipt.status).toBe('budget_exceeded')
  // the closing turn's call is counted as called (3) but never run (2 results), as test_runner holds
  expect(over.usage).toMatchObject({ requests: 3, tool_calls: 3 })
  expectReleased(over.id)
  await expectRunAnswer(c, over.id)
  const overEvents = await overLive
  expect(overEvents.filter((e) => e.event === 'tool_call')).toHaveLength(3)
  expect(overEvents.filter((e) => e.event === 'tool_result')).toHaveLength(2)
  expect(overEvents.find((e) => e.event === 'error')!.data).toMatchObject({ kind: 'budget' })
  await expectReplays(c, over.id, session.id, overEvents)
  expect(model.closes).toBe(0)
  expect(looping.closes).toBe(0)
})
