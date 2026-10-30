/** The director's outbox is rows, not a hook in memory: a run's end still reaches the director when the process
 *  died before the event was written (a run cut off by a restart, a run that ended in the hook's window), and a run
 *  ChatGPT starts through the connector (spawned_by connector) wakes its bridge director like the person's would. */

import { afterEach, expect, test } from 'bun:test'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { DirectorDetail, DirectorSession, DirectorTurn } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { clientName } from '../src/director/app.ts'
import { Harness } from '../src/director/harness.ts'
import { buildServer } from '../src/director/server.ts'
import * as store from '../src/director/store.ts'
import { BridgeTransport, SENDING_RETRY_FOR_S } from '../src/director/transports/bridge.ts'
import type { TurnContext } from '../src/director/transports/types.ts'
import { SEND_TIMEOUT_MS } from '../src/llm/chatgpt_web.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart, type ModelMessage } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo, scriptedModel, setModel, sleep, testSettings, waitDone } from './harness.ts'

type Rec = Record<string, unknown>
let app: App | null = null
let mcp: McpClient | null = null
const cleanups: (() => void)[] = []
afterEach(async () => {
  for (const f of cleanups.splice(0)) { try { f() } catch { /* already gone */ } }
  if (mcp) await mcp.close()
  mcp = null
  if (app) await app.close()
  app = null
})

async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 600)}`)
    await sleep(25)
  }
}

const detailOf = async (c: Client, sid: string) => json<DirectorDetail>(await c.get(`/api/sessions/${sid}/director`))

async function directed(settings = testSettings()) {
  app = await makeApp(settings)
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'outbox recovery', model: 'scripted:a' }))
  return { c, sid: session.id as string, settings }
}

/** The director: a person turn starts one run and ends; any later turn just answers. */
function oneDispatchDirector(sid: () => string, counter: { starts: number; turns: string[] }) {
  return scriptedModel((m: ModelMessage[]) => {
    const texts = JSON.stringify(m)
    if (!lastToolReturn(m, 'start_run') && !texts.includes('App note: Runs finished')) {
      counter.starts += 1
      return modelResponse([toolCallPart('start_run', { session_id: sid(), text: 'look at calc.py', model: 'scripted:a' }, '')])
    }
    counter.turns.push(texts.includes('App note: Runs finished') ? 'event' : 'after-start')
    return modelResponse([textPart('ok')])
  }, 'scripted-b')
}

test('a run the director started and a restart cut off reaches the director as a task event, and is not started again', async () => {
  const { c, sid, settings } = await directed()
  const counter = { starts: 0, turns: [] as string[] }
  let inModel!: () => void
  const reached = new Promise<void>((r) => { inModel = r })
  setModel(app!.state, 'scripted:a', scriptedModel(async () => { inModel(); await sleep(3_600_000); return modelResponse([textPart('never')]) }))
  setModel(app!.state, 'scripted:b', oneDispatchDirector(() => sid, counter))
  await json(await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: 'scripted:b' }))
  const t1 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'please look' }))
  const done1 = await waitFor(async () => json<DirectorTurn>(await c.get(`/api/director-turns/${t1.id}`)), (t) => t.status === 'done', 'turn 1')
  const runId = done1.dispatched_run_ids[0]!
  expect(runId).toStartWith('run_')
  expect(repo.getRun(app!.state.conn, runId)!.status).toBe('running')
  await reached
  // the process dies while the run is with its model
  const dead = app!
  app = null
  dead.state.runs.handles.get(runId)!.done = true
  dead.state.conn.close()
  cleanups.push(() => { dead.state.runs.handles.get(runId)?.token.cancel() })
  app = await makeApp(settings)
  setModel(app.state, 'scripted:a', scriptedModel(() => modelResponse([textPart('fresh')])))
  setModel(app.state, 'scripted:b', oneDispatchDirector(() => sid, counter))
  await app.start()
  const c2 = new Client(app)
  expect(repo.getRun(app.state.conn, runId)!.status).toBe('error')                  // the run reads lost
  await sleep(1500)
  const ds = app.state.director.requireOpen(sid)
  const events = store.listEvents(app.state.conn, ds.id)
  const detail = await detailOf(c2, sid)
  expect({ events: events.map((e) => [e.kind, e.ref_id, e.status]), turns: detail.turns.map((t) => t.kind) }).toEqual({
    events: [['run_finished', runId, 'delivered']], turns: ['user', 'task_event'],
  })
  expect(counter.starts).toBe(1)                                                    // never started twice
}, 60_000)

test('a run that ended before its outbox row was written (the process died in the hook\'s window) is delivered after the restart', async () => {
  const { c, sid, settings } = await directed()
  const counter = { starts: 0, turns: [] as string[] }
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  cleanups.push(() => release())
  setModel(app!.state, 'scripted:a', scriptedModel(async () => { await gate; return modelResponse([textPart('done here')]) }))
  setModel(app!.state, 'scripted:b', oneDispatchDirector(() => sid, counter))
  await json(await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: 'scripted:b' }))
  const t1 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'please look' }))
  const done1 = await waitFor(async () => json<DirectorTurn>(await c.get(`/api/director-turns/${t1.id}`)), (t) => t.status === 'done', 'turn 1')
  const runId = done1.dispatched_run_ids[0]!
  // the crash window: the director stops hearing (as a dead process would) before the run's end is written
  ;(app!.state.director as unknown as { stopping: boolean }).stopping = true
  release()
  await waitDone(app!.state, runId)
  await sleep(50)
  const dsId = app!.state.director.requireOpen(sid).id
  expect(store.listEvents(app!.state.conn, dsId)).toHaveLength(0)                  // the window: run done, no event row
  expect(repo.getRun(app!.state.conn, runId)!.status).toBe('done')
  const dead = app!
  app = null
  dead.state.conn.close()
  app = await makeApp(settings)
  setModel(app.state, 'scripted:a', scriptedModel(() => modelResponse([textPart('fresh')])))
  setModel(app.state, 'scripted:b', oneDispatchDirector(() => sid, counter))
  await app.start()
  await sleep(1500)
  const events = store.listEvents(app.state.conn, dsId)
  expect(events.map((e) => [e.kind, e.ref_id])).toEqual([['run_finished', runId]])
  expect(counter.starts).toBe(1)
}, 60_000)

/** The remote connector exactly as director/main.ts builds it for an HTTP client (user agent openai-mcp). */
async function remoteConnector(a: App, userAgent = 'openai-mcp/1.0.0'): Promise<McpClient> {
  const harness = Harness.connect('http://localhost', 'test-token', { fetchImpl: (input, init) => Promise.resolve(a.app.request(input, init)) })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await buildServer(harness.as(clientName(userAgent))).connect(serverTransport)
  const client = new McpClient({ name: 't', version: '0' })
  await client.connect(clientTransport)
  return client
}

async function callTool(c: McpClient, name: string, args: Rec = {}): Promise<Rec> {
  const result = await c.callTool({ name, arguments: args })
  const text = ((result.content as { text?: string }[] | undefined) ?? []).map((p) => p.text ?? '').join('')
  if (result.isError) return { error: text }
  return (result.structuredContent as Rec | undefined) ?? (JSON.parse(text) as Rec)
}

/** A bridge that takes every message (`drop_after`: the sends after that many reach the page, then the connection
 *  drops before the reply; `hang`: a send never comes back, as with a process that died — unless its caller gives up,
 *  as fetch does; `hang_matching`: only a send whose words hold this hangs, taken by the page; `on_way`: turns the
 *  bridge still has on their way, answered `sending`), and answers what `answers` holds for a turn (a whole reply,
 *  `status` included, when it has one). Every /send asked is in `asked`. */
function fakeBridge() {
  const state = { sent: [] as Rec[], asked: [] as Rec[], answers: new Map<string, Rec>(), drop_after: Infinity, hang: false, hang_matching: '', on_way: new Set<string>() }
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    if (url.pathname === '/state') return Response.json({ ok: true, logged_in: true, generating: false, conversation: null, model: 'GPT-6 Pro' })
    if (url.pathname === '/send') {
      const body = JSON.parse(String(init?.body)) as Rec
      state.asked.push(body)
      if (state.on_way.has(String(body.turn_id))) return Response.json({ accepted: false, reason: 'sending' })
      const hang = state.hang || (state.hang_matching !== '' && String(body.text).includes(state.hang_matching))
      if (hang) {
        if (state.hang_matching) state.sent.push(body)
        return new Promise<Response>((_, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }) })
      }
      // a turn sent before answers as it did
      const before = state.sent.findIndex((b) => b.turn_id === body.turn_id)
      if (before >= 0) return Response.json({ accepted: true, message_id: `m${before + 1}`, conversation: { url: 'https://chatgpt.com/c/abc' }, repeat: true })
      state.sent.push(body)
      if (state.sent.length > state.drop_after) throw Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
      return Response.json({ accepted: true, message_id: `m${state.sent.length}`, conversation: { url: 'https://chatgpt.com/c/abc', title: 't' } })
    }
    if (url.pathname === '/answer') {
      const answer = state.answers.get(url.searchParams.get('turn_id') ?? '')
      return Response.json(answer ? { status: 'done', ...answer } : { status: 'generating' })
    }
    return new Response('nf', { status: 404 })
  }
  return { state, fetchImpl }
}

test('a run ChatGPT starts through the connector (spawned_by connector) ends as a task event that wakes the bridge director', async () => {
  const bridge = fakeBridge()
  app = await makeApp(null, { director: { fetchImpl: bridge.fetchImpl, probe_interval_ms: 50 } })
  const c = new Client(app)
  setModel(app.state, 'scripted:a', scriptedModel(() => modelResponse([textPart('fixed')])))
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'bridge', model: 'scripted:a' }))
  const sid = s.id as string
  await json<DirectorDetail>(await c.post(`/api/sessions/${sid}/director`, { transport: 'bridge', model: 'GPT-6 Pro', config: { bridge_url: 'http://bridge.test/', bridge_token: 'bridge-secret', poll_interval_s: 1 } }))
  const t1 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'fix add()' }))
  await waitFor(async () => json<DirectorTurn>(await c.get(`/api/director-turns/${t1.id}`)), (t) => t.status === 'awaiting_answer', 'awaiting')
  mcp = await remoteConnector(app)
  const run = await callTool(mcp, 'start_run', { session_id: sid, text: 'fix add()', model: 'scripted:a' })
  expect(repo.getRun(app.state.conn, run.id as string)!.spawned_by).toBe('connector')
  bridge.state.answers.set(t1.id, { text: 'sent the agent', model: 'GPT-6 Pro' })
  await waitFor(async () => json<DirectorTurn>(await c.get(`/api/director-turns/${t1.id}`)), (t) => t.status === 'done', 'answer 1')
  await waitDone(app.state, run.id as string)
  await sleep(800)
  const ds = app.state.director.requireOpen(sid)
  const events = store.listEvents(app.state.conn, ds.id)
  expect(events.map((e) => e.ref_id)).toEqual([run.id as string])
  expect(bridge.state.sent.length).toBe(2)
  expect(String(bridge.state.sent[1]!.text)).toContain(`run ${String(run.id)}`)
}, 30_000)

async function bridgeDirected(bridge: ReturnType<typeof fakeBridge>, settings = testSettings(), config: Rec = {}) {
  app = await makeApp(settings, { director: { fetchImpl: bridge.fetchImpl, probe_interval_ms: 50 } })
  const c = new Client(app)
  setModel(app.state, 'scripted:a', scriptedModel(() => modelResponse([textPart('fixed')])))
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'bridge', model: 'scripted:a' }))
  const sid = s.id as string
  await json<DirectorDetail>(await c.post(`/api/sessions/${sid}/director`, { transport: 'bridge', model: 'GPT-6 Pro', config: { bridge_url: 'http://bridge.test/', bridge_token: 'bridge-secret', poll_interval_s: 1, ...config } }))
  return { c, sid, settings }
}

test('a task event whose send lost its connection after the bridge took it is not sent again under a new turn: the event fails, shown', async () => {
  const bridge = fakeBridge()
  const { c, sid } = await bridgeDirected(bridge)
  const t1 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'fix add()' }))
  await waitFor(async () => json<DirectorTurn>(await c.get(`/api/director-turns/${t1.id}`)), (t) => t.status === 'awaiting_answer', 'awaiting')
  bridge.state.drop_after = 1
  mcp = await remoteConnector(app!)
  const run = await callTool(mcp, 'start_run', { session_id: sid, text: 'fix add()', model: 'scripted:a' })
  bridge.state.answers.set(t1.id, { text: 'sent the agent', model: 'GPT-6 Pro' })
  await waitFor(async () => json<DirectorTurn>(await c.get(`/api/director-turns/${t1.id}`)), (t) => t.status === 'done', 'answer 1')
  await waitDone(app!.state, run.id as string)
  const detail = await waitFor(() => detailOf(c, sid), (d) => d.pending_events.some((e) => e.status === 'failed'), 'the event failed')
  await sleep(1500)
  expect(bridge.state.sent.filter((b) => String(b.text).includes(String(run.id)))).toHaveLength(1)
  const event = detail.pending_events.find((e) => e.ref_id === run.id)!
  expect(event.error).toContain('may have reached the director')
  const turn = detail.turns.find((t) => t.kind === 'task_event')!
  expect([turn.status, turn.error]).toEqual(['error', expect.stringContaining('may have taken the message')])
}, 30_000)

for (const [label, reply, said] of [
  ['the desktop app restarted since the message went', { status: 'lost', reason: 'restarted', detail: 'the message went at 12:00, before the desktop app restarted' }, 'before the desktop app restarted'],
  ['the bridge does not know the message', { status: 'unknown' }, 'no longer knows this message'],
] as const) {
  test(`a turn whose answer the bridge cannot have (${label}) ends at once with why, not at its deadline`, async () => {
    const bridge = fakeBridge()
    const { c, sid } = await bridgeDirected(bridge)
    const t1 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'hello' }))
    bridge.state.answers.set(t1.id, reply)
    const ended = await waitFor(async () => json<DirectorTurn>(await c.get(`/api/director-turns/${t1.id}`)), (t) => t.status !== 'queued' && t.status !== 'generating' && t.status !== 'awaiting_answer', 'the turn ended', 8_000)
    expect(ended.status).toBe('error')
    expect(ended.error).toContain(said)
    expect(bridge.state.sent).toHaveLength(1)
  }, 30_000)
}

test("a bridge turn the harness stopped while it went goes again under its own id: the bridge answers it as it did", async () => {
  const bridge = fakeBridge()
  const { c, sid, settings } = await bridgeDirected(bridge)
  bridge.state.hang = true
  const t1 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'hello' }))
  await waitFor(async () => json<DirectorTurn>(await c.get(`/api/director-turns/${t1.id}`)), (t) => t.status === 'generating', 'going')
  // the process dies while the send is with the bridge (which took it)
  bridge.state.sent.push({ turn_id: t1.id, text: 'hello' })
  const dead = app!
  app = null
  dead.state.conn.close()
  bridge.state.hang = false
  bridge.state.answers.set(t1.id, { text: 'hi there', model: 'GPT-6 Pro' })
  app = await makeApp(settings, { director: { fetchImpl: bridge.fetchImpl, probe_interval_ms: 50 } })
  await app.start()
  const c2 = new Client(app)
  const done = await waitFor(async () => json<DirectorTurn>(await c2.get(`/api/director-turns/${t1.id}`)), (t) => t.status === 'done', 'answered', 10_000)
  expect(done.output).toContain('hi there')
  expect(bridge.state.sent.map((b) => b.turn_id)).toEqual([t1.id])
  expect((await detailOf(c2, sid)).turns.map((t) => t.id)).toEqual([t1.id])
}, 30_000)

test("a turn the bridge is still sending is asked again past the usual tries, as long as the bridge's longest send: answered once it went, never sent under another turn", async () => {
  const bridge = fakeBridge()
  // asked again every second: a dozen tries end in about 12 s, the bridge's send outlasts them
  const { c, sid, settings } = await bridgeDirected(bridge, testSettings(), { busy_retry_s: 1 })
  bridge.state.hang = true
  const t1 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'hello' }))
  await waitFor(async () => json<DirectorTurn>(await c.get(`/api/director-turns/${t1.id}`)), (t) => t.status === 'generating', 'going')
  // the harness dies while the bridge has the send on its way (it uploads for a while before the words go)
  bridge.state.sent.push({ turn_id: t1.id, text: 'hello' })
  const dead = app!
  app = null
  dead.state.conn.close()
  bridge.state.hang = false
  bridge.state.on_way.add(t1.id)
  const sentAt = Date.now()
  setTimeout(() => bridge.state.on_way.delete(t1.id), 15_000)
  bridge.state.answers.set(t1.id, { text: 'hi there', model: 'GPT-6 Pro' })
  app = await makeApp(settings, { director: { fetchImpl: bridge.fetchImpl, probe_interval_ms: 50 } })
  await app.start()
  const c2 = new Client(app)
  const done = await waitFor(async () => json<DirectorTurn>(await c2.get(`/api/director-turns/${t1.id}`)), (t) => t.status !== 'generating' && t.status !== 'queued' && t.status !== 'awaiting_answer', 'the turn ended', 30_000)
  expect([done.status, done.error, done.output]).toEqual(['done', null, expect.stringContaining('hi there')])
  expect(Date.now() - sentAt).toBeGreaterThanOrEqual(15_000)
  const asked = bridge.state.asked.filter((b) => b.turn_id === t1.id).length
  expect(asked).toBeGreaterThan(13)                                                   // past the usual dozen tries
  expect(new Set(bridge.state.asked.map((b) => b.turn_id))).toEqual(new Set([t1.id]))
  expect(bridge.state.sent.map((b) => b.turn_id)).toEqual([t1.id])
  expect((await detailOf(c2, sid)).turns.map((t) => t.id)).toEqual([t1.id])
}, 60_000)

test("the bridge's `sending` is asked again for as long as the bridge's longest send, with slack", async () => {
  expect(SENDING_RETRY_FOR_S).toBeGreaterThan(SEND_TIMEOUT_MS / 1000)
  const transport = new BridgeTransport({ fetchImpl: async () => Response.json({ accepted: false, reason: 'sending' }) })
  const director = { config: { bridge_url: 'http://bridge.test', busy_retry_s: 5 }, external_ref: null } as unknown as DirectorSession
  const outcome = await transport.send({ director, turn: { id: 'dt_1', input: 'hi' }, signal: new AbortController().signal } as unknown as TurnContext)
  expect(outcome).toEqual({ kind: 'busy', reason: 'the bridge is still sending this message to ChatGPT', retry_in_s: 5, may_have_sent: true, retry_for_s: SENDING_RETRY_FOR_S })
  // another busy (the page answering an earlier message) keeps the usual tries
  const generating = new BridgeTransport({ fetchImpl: async () => Response.json({ accepted: false, reason: 'generating' }) })
  expect('retry_for_s' in (await generating.send({ director, turn: { id: 'dt_2', input: 'hi' }, signal: new AbortController().signal } as unknown as TurnContext))).toBe(false)
})

/** A bridge director whose task-event turn is with the bridge, its /send not back (the page took its words): the
 *  person's turn answered, a connector run finished, its event's turn going. */
async function eventTurnGoing(bridge: ReturnType<typeof fakeBridge>) {
  const { c, sid, settings } = await bridgeDirected(bridge)
  const t1 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'fix add()' }))
  await waitFor(async () => json<DirectorTurn>(await c.get(`/api/director-turns/${t1.id}`)), (t) => t.status === 'awaiting_answer', 'awaiting')
  mcp = await remoteConnector(app!)
  const run = await callTool(mcp, 'start_run', { session_id: sid, text: 'fix add()', model: 'scripted:a' })
  const runId = String(run.id)
  bridge.state.hang_matching = runId
  bridge.state.answers.set(t1.id, { text: 'sent the agent', model: 'GPT-6 Pro' })
  await waitDone(app!.state, runId)
  const going = await waitFor(() => detailOf(c, sid), (d) => d.turns.some((t) => t.kind === 'task_event' && t.status === 'generating'), 'the event turn going')
  await waitFor(() => bridge.state.sent.filter((b) => String(b.text).includes(runId)).length, (n) => n === 1, 'the event at the bridge')
  await mcp.close()
  mcp = null
  return { c, sid, settings, runId, turnId: going.turns.find((t) => t.kind === 'task_event')!.id }
}

/** The harness started again on the same data: the event's turn is asked again under its own id. */
async function restarted(bridge: ReturnType<typeof fakeBridge>, settings: ReturnType<typeof testSettings>, sid: string, runId: string, turnId: string) {
  app = await makeApp(settings, { director: { fetchImpl: bridge.fetchImpl, probe_interval_ms: 50 } })
  await app.start()
  const c2 = new Client(app)
  const done = await waitFor(async () => json<DirectorTurn>(await c2.get(`/api/director-turns/${turnId}`)), (t) => t.status === 'done', 'the event turn answered', 15_000)
  await sleep(1200)
  const detail = await detailOf(c2, sid)
  const ds = app.state.director.requireOpen(sid)
  return {
    done,
    page_sends: bridge.state.sent.filter((b) => String(b.text).includes(runId)).length,
    turns: detail.turns.map((t) => [t.kind, t.status]),
    events: store.listEvents(app.state.conn, ds.id).map((e) => [e.ref_id, e.status, e.delivered_turn_id]),
  }
}

test('a task-event turn whose send the bridge still has when the harness dies is asked again under its own id: `sending` waited out, the event sent once', async () => {
  const bridge = fakeBridge()
  const { sid, settings, runId, turnId } = await eventTurnGoing(bridge)
  const dead = app!
  app = null
  dead.state.conn.close()
  // the bridge still has the send on its way for a moment after the restart, then has it as sent
  bridge.state.hang_matching = ''
  bridge.state.on_way.add(turnId)
  setTimeout(() => bridge.state.on_way.delete(turnId), 1500)
  bridge.state.answers.set(turnId, { text: 'saw the run', model: 'GPT-6 Pro' })
  const seen = await restarted(bridge, settings, sid, runId, turnId)
  expect(bridge.state.asked.filter((b) => b.turn_id === turnId).length).toBeGreaterThanOrEqual(3)  // the first, a `sending`, the repeat
  expect(new Set(bridge.state.asked.filter((b) => String(b.text).includes(runId)).map((b) => b.turn_id))).toEqual(new Set([turnId]))
  expect(seen).toEqual({ done: expect.objectContaining({ output: expect.stringContaining('saw the run') }), page_sends: 1, turns: [['user', 'done'], ['task_event', 'done']], events: [[runId, 'delivered', turnId]] })
}, 45_000)

test('a task-event turn whose send is with the bridge when the harness closes is left for the next start: not failed, not sent under another turn', async () => {
  const bridge = fakeBridge()
  const { sid, settings, runId, turnId } = await eventTurnGoing(bridge)
  const closing = app!
  app = null
  await closing.close()                                                              // the send is given up, not waited for
  bridge.state.hang_matching = ''
  bridge.state.answers.set(turnId, { text: 'saw the run', model: 'GPT-6 Pro' })
  const seen = await restarted(bridge, settings, sid, runId, turnId)
  expect(new Set(bridge.state.asked.filter((b) => String(b.text).includes(runId)).map((b) => b.turn_id))).toEqual(new Set([turnId]))
  expect(seen).toEqual({ done: expect.objectContaining({ output: expect.stringContaining('saw the run'), error: null }), page_sends: 1, turns: [['user', 'done'], ['task_event', 'done']], events: [[runId, 'delivered', turnId]] })
}, 45_000)

test('a task-event turn the person cancels while its send is with the bridge ends cancelled: the send given up, the event not sent again, the turn not revived', async () => {
  const bridge = fakeBridge()
  const { c, sid, runId, turnId } = await eventTurnGoing(bridge)
  const cancelled = await json<DirectorTurn>(await c.post(`/api/director-turns/${turnId}/cancel`, {}))
  expect(['generating', 'cancelled']).toContain(cancelled.status)
  const ended = await waitFor(async () => json<DirectorTurn>(await c.get(`/api/director-turns/${turnId}`)), (t) => t.status === 'cancelled', 'the turn cancelled', 5_000)
  expect(ended.error).toContain('may have taken the message')
  await sleep(1500)
  const detail = await detailOf(c, sid)
  expect(detail.turns.map((t) => [t.kind, t.status])).toEqual([['user', 'done'], ['task_event', 'cancelled']])
  const event = detail.pending_events.find((e) => e.ref_id === runId)!
  expect([event.status, event.error]).toEqual(['failed', expect.stringContaining('may have reached the director')])
  expect(bridge.state.asked.filter((b) => String(b.text).includes(runId))).toHaveLength(1)
}, 30_000)
