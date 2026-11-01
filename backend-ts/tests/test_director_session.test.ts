/** The director session: the harness holds the conversation with a director and continues it — a native director
 *  (a model route of this harness with the director tools in process) dispatches a run and is woken with a task
 *  event when it ends; the outbox delivers each event once, survives a restart and never repeats a dispatch; the
 *  bridge transport submits to a (fake) ChatGPT bridge and takes the answer from its poll or from the MCP
 *  connector; the workspace-agent transport triggers with a conversation key and an idempotency key; the API and
 *  the turn stream; the pure parts (the task-event message, the run ids a tool result names, the history trim);
 *  the reasoning mode on the Responses body. */

import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { agentMentionToken, type DirectorDetail, type DirectorTurn } from '@oasis-code/contract'
import { ModelConfig } from '../src/config.ts'
import * as repo from '../src/db/repo.ts'
import { Harness } from '../src/director/harness.ts'
import { runIdsOf, taskEventMessage } from '../src/director/outbox.ts'
import { buildServer } from '../src/director/server.ts'
import { bridgeAnswerTimeoutS } from '../src/director/transports/bridge.ts'
import { ChatGptBridge, SEND_TIMEOUT_MS } from '../src/llm/chatgpt_web.ts'
import * as store from '../src/director/store.ts'
import { NATIVE_EXCLUDED_TOOLS } from '../src/director/tools.ts'
import { NATIVE_INSTRUCTIONS } from '../src/director/manual.ts'
import { ContextKeeper, isCompaction } from '../src/agent/history.ts'
import { countTokens } from '../src/agent/context.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import { isRequest, isUserPrompt, lastToolReturn, loadJson, modelRequest, modelResponse, textPart, toolCallPart, userPrompt, userText, userTexts, type ModelMessage } from '../src/llm/messages.ts'
import { OpenAIResponsesModel } from '../src/llm/providers/openai_responses.ts'
import { ModelHTTPError } from '../src/llm/model.ts'
import type { AgentInfo } from '../src/llm/scripted.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp, parseSse } from './api_harness.ts'
import { buggyRepo, scriptedModel, setModel, sleep, steps, waitDone } from './harness.ts'
import { rec } from './tree_helpers.ts'
import { asLegacyV1 } from './director_surface_fixtures.ts'

type Rec = Record<string, unknown>

let app: App | null = null
let mcp: McpClient | null = null
afterEach(async () => {
  if (mcp) await mcp.close()
  mcp = null
  if (app) await app.close()
  app = null
  delete process.env.OPENAI_API_KEY
})

const fixingScript = () => steps(
  [toolCallPart('read_file', { path: 'calc.py' }, '')],
  [toolCallPart('edit_file', { path: 'calc.py', old_string: 'a - b   # the bug: this should add', new_string: 'a + b' }, '')],
  [textPart('Patched calc.py; run python3 -m unittest to confirm.')],
)

async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value).slice(0, 500)}`)
    await sleep(25)
  }
}

async function openOverApi(c: Client, title = 'directed') {
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title, model: 'scripted:a' }))
  return { project, session }
}

const detailOf = async (c: Client, sid: string) => json<DirectorDetail>(await c.get(`/api/sessions/${sid}/director`))
const turnOf = async (c: Client, id: string) => json<DirectorTurn>(await c.get(`/api/director-turns/${id}`))

/** An MCP client of the director endpoint over this app (what ChatGPT's connector is: its requests name their client,
 *  so the runs it starts are the connector's). */
async function connector(a: App): Promise<McpClient> {
  const harness = Harness.connect('http://localhost', 'test-token', { fetchImpl: (input, init) => Promise.resolve(a.app.request(input, init)) }).as('ChatGPT')
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await buildServer(harness).connect(serverTransport)
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

// ---- the native director: dispatch, be woken, judge ------------------------------------------------------------

test('a native director dispatches a run, ends its turn, and is woken with the task event when the run ends', async () => {
  app = await makeApp()
  const c = new Client(app)
  const st = app.state
  setModel(st, 'scripted:a', scriptedModel(fixingScript()))
  const seen: { tools: string[][]; requests: ModelMessage[][]; instructions: string[] } = { tools: [], requests: [], instructions: [] }
  let sessionId = ''
  // the director: turn 1 sends a message and answers; turn 2 (the task event) reads the run and answers
  setModel(st, 'scripted:b', scriptedModel(steps(
    (m: ModelMessage[]) => { seen.requests.push(m); return modelResponse([toolCallPart('start_run', { session_id: sessionId, text: 'fix add() so it adds; run python3 -m unittest; checkpoint', model: 'scripted:a' }, '')]) },
    (m: ModelMessage[]) => { seen.requests.push(m); return modelResponse([textPart('I sent the fix to the agent; I will judge the receipt when it lands.')]) },
    (m: ModelMessage[]) => { seen.requests.push(m); return modelResponse([toolCallPart('get_run', { run_id: String(rec(lastToolReturn(m, 'start_run')).id) }, '')]) },
    (m: ModelMessage[]) => { seen.requests.push(m); return modelResponse([textPart('The run finished: calc.py patched, a checkpoint pinned. Nothing left to do.')]) },
  ), 'scripted-b'))
  // what the director sees: the instructions and the tool surface, from the model's side
  const probe = st.model_overrides.get('scripted:b')!
  const original = probe.requestStream.bind(probe)
  probe.requestStream = (messages, settings, params, ctx) => {
    seen.tools.push(params.function_tools.map((t) => t.name).sort())
    const last = messages[messages.length - 1] as { instructions?: string | null }
    if (last.instructions) seen.instructions.push(last.instructions)
    return original(messages, settings, params, ctx)
  }
  const { session } = await openOverApi(c)
  sessionId = session.id as string
  // nothing yet: the transports and their readiness
  const empty = await detailOf(c, sessionId)
  expect(empty.director).toBeNull()
  expect(empty.transports.map((t) => t.id)).toEqual(['native', 'bridge'])
  expect(empty.transports.find((t) => t.id === 'native')!.ready).toBe(true)
  // open a native director on the scripted route
  const opened = await json<DirectorDetail>(await c.post(`/api/sessions/${sessionId}/director`, { transport: 'native', model: 'scripted:b', config: { thinking: 'high' } }))
  expect(opened.director!.transport).toBe('native')
  expect(opened.director!.model).toBe('scripted:b')
  expect(opened.director!.label).toBe('Scripted B')
  expect(opened.director!.state).toBe('idle')
  expect(opened.director!.config).toMatchObject({ thinking: 'high', reasoning_mode: null, allow_destructive: false, max_requests_per_turn: 40 })
  expect((await c.post(`/api/sessions/${sessionId}/director`, { transport: 'native', model: 'scripted:b' })).status).toBe(409)
  asLegacyV1(st.conn, opened.director!.id)   // a pre-surface director row: this test pins director.v1's list and words (v2: test_director_surface_freeze)
  // the session detail names it
  expect(rec(rec(await json(await c.get(`/api/sessions/${sessionId}`))).director).id).toBe(opened.director!.id)
  // the person writes to the director
  const turn1 = await json<DirectorTurn>(await c.post(`/api/sessions/${sessionId}/director/messages`, { text: 'make add() add' }))
  expect(turn1.kind).toBe('user')
  expect(['queued', 'generating']).toContain(turn1.status)
  const done1 = await waitFor(() => turnOf(c, turn1.id), (t) => t.status === 'done', 'turn 1')
  expect(done1.output).toStartWith('I sent the fix')
  expect(done1.model).toBe('scripted:b')
  expect(done1.tool_calls.map((t) => [t.name, t.status])).toEqual([['start_run', 'ok']])
  expect(done1.dispatched_run_ids).toHaveLength(1)
  expect(done1.usage.requests).toBe(2)
  expect(done1.note_id as string).toStartWith('note_')
  const runId = done1.dispatched_run_ids[0]!
  // the director's tools: the endpoint's own, minus the waits, the notes and the session openers; the manual is its instructions
  expect(seen.tools[0]).toEqual(['cancel_run', 'get_run', 'get_session', 'get_workspace', 'integrate', 'list_models', 'read_file', 'schedule', 'set_project_config', 'start_interaction', 'start_run'])
  for (const name of NATIVE_EXCLUDED_TOOLS) expect(seen.tools[0], name).not.toContain(name)
  // the instructions are the manual and the native note, the same for every director; the session is the turn's context
  expect(seen.instructions[0]).toBe(NATIVE_INSTRUCTIONS)
  expect(seen.instructions[0]).toContain('An agent run handles one message.')
  expect(seen.instructions[0]).toContain('Do not wait for runs or post notes.')
  expect(seen.instructions[0]).not.toContain(sessionId)
  expect(userTexts(seen.requests[0]!)[0]).toStartWith(`Session: ${sessionId}. Project: `)
  expect(userTexts(seen.requests[0]!)[0]).toEndWith('make add() add')
  // the answer stands in the thread as a director note that closes the turn
  const notes = repo.listDirectorNotes(st.conn, sessionId)
  expect(notes).toHaveLength(1)
  expect(notes[0]!.source).toBe('oasis-code')
  expect(notes[0]!.model).toBe('Scripted B')
  expect(notes[0]!.question).toBe('make add() add')
  expect(notes[0]!.answer).toStartWith('I sent the fix')
  expect(notes[0]!.turn_id).toBe(turn1.id)
  // the run ends: a task event, delivered by a second turn the harness starts on its own
  await waitDone(st, runId)
  const second = await waitFor(() => detailOf(c, sessionId), (d) => d.turns.length === 2 && d.turns[1]!.status === 'done', 'the task-event turn')
  const turn2 = second.turns[1]!
  expect(turn2.kind).toBe('task_event')
  expect(turn2.input).toStartWith('App note: Runs finished:')
  expect(turn2.input).toContain(`run ${runId}`)
  expect(turn2.input).toContain('started by your instruction')
  expect(turn2.input).toContain(`(turn ${turn1.id})`)
  expect(turn2.input).toContain('checks 0 passed / 0 failed / 0 unknown')
  expect(turn2.output).toStartWith('The run finished')
  expect(turn2.tool_calls.map((t) => t.name)).toEqual(['get_run'])
  expect(turn2.event_ids).toHaveLength(1)
  expect(second.pending_events).toEqual([])
  expect(second.director!.state).toBe('idle')
  expect(second.director!.current_turn_id).toBeNull()
  expect(second.director!.history_turns).toBe(2)
  const event = store.getEvent(st.conn, turn2.event_ids[0]!)!
  expect(event.status).toBe('delivered')
  expect(event.delivered_turn_id).toBe(turn2.id)
  expect(event.cause_turn_id).toBe(turn1.id)
  expect(event.dedupe_key).toBe(`run_finished:${runId}`)
  expect(rec(rec(event.payload).checks).not_run).toBeDefined()
  // the second turn continued the director's own conversation: its history holds the first turn
  const third = seen.requests[2]!
  const texts = userTexts(third)
  expect(texts[0]).toEndWith('make add() add')                                    // the person's words, after the turn's context line
  expect(texts[0]).toStartWith(`Session: ${sessionId}. Project: `)
  expect(texts[texts.length - 1]).toStartWith(`Session: ${sessionId}. Project: `)   // every turn's context line first
  expect(texts[texts.length - 1]).toContain('\nApp note: Runs finished:')
  // the note of the task-event turn names the event, not the person
  const after = repo.listDirectorNotes(st.conn, sessionId)
  expect(after).toHaveLength(2)
  expect(after[1]!.question).toStartWith('oasis-code task event')
  expect(after[1]!.turn_id).toBe(turn2.id)
  // the same run ending twice is one event
  const again = store.enqueueEvent(st.conn, { director_session_id: opened.director!.id, session_id: sessionId, kind: 'run_finished', ref_id: runId, dedupe_key: `run_finished:${runId}`, cause_turn_id: null, payload: {} })
  expect(again.fresh).toBe(false)
  expect(again.event.id).toBe(event.id)
  // the turn's stream, read after the end: what was said, in order
  const frames = parseSse(await (await c.get(`/api/director-turns/${turn1.id}/events`)).text())
  expect(frames.map((f) => f.event)).toEqual(['turn_started', 'tool_call', 'tool_result', 'text_delta', 'text_delta', 'turn_finished'])
  expect(frames[1]!.data.name).toBe('start_run')
  expect(rec(frames[frames.length - 1]!.data).status).toBe('done')
  expect((await c.get('/api/director-turns/turn_nope/events')).status).toBe(404)
  // close: the session's director is gone; a new one may open
  const closed = await json(await c.delete(`/api/sessions/${sessionId}/director`))
  expect(closed.closed).toBe(true)
  expect(rec(closed.director).state).toBe('closed')
  expect((await detailOf(c, sessionId)).director).toBeNull()
  expect((await c.post(`/api/sessions/${sessionId}/director/messages`, { text: 'hello?' })).status).toBe(409)
}, 60_000)

test("a run the person sends themselves wakes no native director: it rides with the director's next turn, and reading its receipt through the connector delivers it without one", async () => {
  app = await makeApp()
  const c = new Client(app)
  const st = app.state
  setModel(st, 'scripted:a', scriptedModel(() => modelResponse([textPart('looked around')])))
  const told: ModelMessage[][] = []
  setModel(st, 'scripted:b', scriptedModel((m: ModelMessage[]) => { told.push(m); return modelResponse([textPart('noted')]) }))
  const { session } = await openOverApi(c)
  const sid = session.id as string
  await json(await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: 'scripted:b' }))
  const dsId = (await detailOf(c, sid)).director!.id
  asLegacyV1(st.conn, dsId)   // a pre-surface director row: this test pins director.v1's words
  // paused: nothing is sent, events queue up
  await json(await c.put(`/api/sessions/${sid}/director`, { paused: true }))
  expect((await detailOf(c, sid)).director!.state).toBe('paused')
  const run = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'look around', model: 'scripted:a' }))
  await waitDone(st, run.id as string)
  const queued = await waitFor(() => detailOf(c, sid), (d) => d.pending_events.length === 1, 'the event')
  expect(queued.pending_events[0]!.status).toBe('pending')
  expect(queued.pending_events[0]!.cause_turn_id).toBeNull()
  expect(queued.turns).toEqual([])
  // the director reads the receipt itself (the connector's get_run): the event is delivered, no turn repeats it
  mcp = await connector(app)
  const read = await callTool(mcp, 'get_run', { run_id: run.id as string })
  expect(read.finished).toBe(true)
  expect(store.getEvent(st.conn, queued.pending_events[0]!.id)!.status).toBe('delivered')
  expect((await detailOf(c, sid)).pending_events).toEqual([])
  // resumed: still nothing to say (the event was read); a second run the person sends while the director is free
  // wakes it neither — the person talked to the agent, not to the director — and the director does not wait on it
  await json(await c.put(`/api/sessions/${sid}/director`, { paused: false }))
  const run2 = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'look again', model: 'scripted:a' }))
  expect((await detailOf(c, sid)).director!.state).toBe('idle')
  await waitDone(st, run2.id as string)
  const held = await waitFor(() => detailOf(c, sid), (d) => d.pending_events.length === 1, 'the held event')
  await sleep(200)
  expect((await detailOf(c, sid)).turns).toEqual([])
  expect(held.pending_events[0]!.ref_id).toBe(run2.id as string)
  expect(held.director!.state).toBe('idle')
  // the person's next words to the director carry it: a block before their words, delivered with the turn
  const turn = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'what did the agent find?' }))
  const answered = await waitFor(() => turnOf(c, turn.id), (t) => t.status === 'done', 'the person\'s turn')
  expect(answered.kind).toBe('user')
  expect(answered.event_ids).toEqual([held.pending_events[0]!.id])
  const words = userTexts(told[told.length - 1]!)
  expect(words[0]).toStartWith(`Session: ${sid}. Project: `)
  expect(words[0]).toContain(`\nApp note: Since your last turn the user also ran agents directly, not through you: ${run2.id as string}.`)
  expect(words[0]).toContain('started by the person from oasis-code (not by you)')
  expect(words[0]).toEndWith('what did the agent find?')
  expect(repo.listDirectorNotes(st.conn, sid).at(-1)!.question).toBe('what did the agent find?')         // the note is the person's question
  const status = await detailOf(c, sid)
  expect(status.director!.id).toBe(dsId)
  expect(status.director!.state).toBe('idle')
  expect(status.turns.map((t) => t.kind)).toEqual(['user'])
  expect(status.pending_events).toEqual([])
  expect(store.getEvent(st.conn, held.pending_events[0]!.id)!.delivered_turn_id).toBe(turn.id)
}, 60_000)

test('destructive tools wait for the person unless the session allows them; a turn can be cancelled', async () => {
  app = await makeApp()
  const c = new Client(app)
  const st = app.state
  setModel(st, 'scripted:b', scriptedModel(steps(
    [toolCallPart('cancel_run', { run_id: 'run_000000000000' }, '')],
    (m: ModelMessage[]) => modelResponse([textPart(`refused: ${String(rec(lastToolReturn(m, 'cancel_run')).status)}`)]),
  ), 'scripted-b'))
  const { session } = await openOverApi(c)
  const sid = session.id as string
  // a finished run of this session, from before the director (so no task event of it reaches the director)
  setModel(st, 'scripted:a', scriptedModel(() => modelResponse([textPart('done already')])))
  const finished = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'a run to name' }))
  await waitDone(st, finished.id as string)
  await sleep(50)                                                     // the run's end-of-run tick passes with no director to tell
  await json(await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: 'scripted:b' }))
  const t1 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'cancel that run' }))
  const done = await waitFor(() => turnOf(c, t1.id), (t) => t.status === 'done', 'the turn')
  expect(done.output).toBe('refused: refused')
  expect(done.tool_calls[0]!.status).toBe('refused')
  expect(done.tool_calls[0]!.summary).toContain('run_id=run_000000000000')
  // allowed: the call on a run of this session goes through to the harness, whose own answer (already finished:
  // nothing to cancel) comes back; a run id that names nothing of this session stays refused, allowed or not
  await json(await c.put(`/api/sessions/${sid}/director`, { config: { allow_destructive: true } }))
  setModel(st, 'scripted:b', scriptedModel(steps(
    [toolCallPart('cancel_run', { run_id: finished.id }, '')],
    () => modelResponse([toolCallPart('cancel_run', { run_id: 'run_000000000000' }, '')]),
    (m: ModelMessage[]) => modelResponse([textPart(`harness said: ${String(rec(lastToolReturn(m, 'cancel_run')).status)}`)]),
  ), 'scripted-b'))
  const t2 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'cancel it, I allow it' }))
  const done2 = await waitFor(() => turnOf(c, t2.id), (t) => t.status === 'done', 'the second turn')
  expect(done2.output).toBe('harness said: refused')
  expect(done2.tool_calls.map((t) => t.status)).toEqual(['ok', 'refused'])
  expect(done2.tool_calls[0]!.summary).toContain(`run_id=${finished.id}`)
  // a turn with a model that never answers is cancelled by the person
  setModel(st, 'scripted:b', scriptedModel(() => new Promise(() => { /* never */ }), 'scripted-b'))
  const t3 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'think forever' }))
  await waitFor(() => turnOf(c, t3.id), (t) => t.status === 'generating', 'generating')
  expect((await detailOf(c, sid)).director!.state).toBe('generating')
  await json(await c.post(`/api/director-turns/${t3.id}/cancel`))
  const cancelled = await waitFor(() => turnOf(c, t3.id), (t) => t.status === 'cancelled', 'cancelled')
  expect(cancelled.error).toBeTruthy()
  expect((await detailOf(c, sid)).director!.state).toBe('idle')
  expect(repo.listDirectorNotes(st.conn, sid)).toHaveLength(2)      // a cancelled turn writes no note
}, 60_000)

test('a restart marks the turn that was with the model and delivers its events again, once', async () => {
  app = await makeApp()
  const c = new Client(app)
  const st = app.state
  setModel(st, 'scripted:b', scriptedModel(() => modelResponse([textPart('read it')]), 'scripted-b'))
  const { session } = await openOverApi(c)
  const sid = session.id as string
  await json(await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: 'scripted:b' }))
  const ds = st.director.requireOpen(sid)
  // what a crash leaves: an event being delivered by a turn that was generating (of a run an earlier turn started:
  // a native director is woken by its own runs)
  const { event } = store.enqueueEvent(st.conn, { director_session_id: ds.id, session_id: sid, kind: 'run_finished', ref_id: 'run_dead', dedupe_key: 'run_finished:run_dead', cause_turn_id: 'turn_earlier', payload: { status: 'done' } })
  const stale = store.insertTurn(st.conn, { director_session_id: ds.id, session_id: sid, kind: 'task_event', input: taskEventMessage(sid, [event]), event_ids: [event.id] })
  store.updateTurn(st.conn, stale.id, { status: 'generating', started_at: '2026-09-26T00:00:00.000Z' })
  store.markEvents(st.conn, [event.id], { status: 'delivering' })
  store.updateDirectorSession(st.conn, ds.id, { state: 'generating', current_turn_id: stale.id })
  const report = await st.director.reconcile()
  expect(report.interrupted).toEqual([stale.id])
  expect(store.getTurn(st.conn, stale.id)!.status).toBe('error')
  expect(store.getTurn(st.conn, stale.id)!.error).toContain('interrupted')
  const redelivered = await waitFor(() => detailOf(c, sid), (d) => d.turns.length === 2 && d.turns[1]!.status === 'done', 'the redelivery')
  expect(redelivered.turns[1]!.kind).toBe('task_event')
  expect(redelivered.turns[1]!.event_ids).toEqual([event.id])
  const delivered = store.getEvent(st.conn, event.id)!
  expect(delivered.status).toBe('delivered')
  expect(delivered.attempts).toBe(1)
  expect(delivered.delivered_turn_id).toBe(redelivered.turns[1]!.id)
  expect(redelivered.director!.last_error).toBeNull()
  // an event that failed three times is kept out of the next turn and shown as failed
  const { event: doomed } = store.enqueueEvent(st.conn, { director_session_id: ds.id, session_id: sid, kind: 'run_finished', ref_id: 'run_doom', dedupe_key: 'run_finished:run_doom', cause_turn_id: 'turn_earlier', payload: {} })
  setModel(st, 'scripted:b', scriptedModel(() => { throw new Error('the model is down') }, 'scripted-b'))
  st.director.kick(ds.id)
  const failed = await waitFor(() => store.getEvent(st.conn, doomed.id)!, (e) => e.status === 'failed', 'three failed attempts', 30_000)
  expect(failed.attempts).toBe(3)
  expect(failed.error).toContain('the model is down')
  const detail = await detailOf(c, sid)
  expect(detail.pending_events.map((e) => e.status)).toEqual(['failed'])
  expect(detail.director!.last_error).toContain('the model is down')
  expect(detail.director!.state).toBe('idle')
})

// ---- the bridge: the ChatGPT web app behind a bridge --------------------------------------------------------------

/** A bridge as the desktop shell would serve it: records what was sent, answers what the test sets. */
function fakeBridge() {
  const state = { logged_in: true, generating: false, inUse: null as string | null, sent: [] as Rec[], answers: new Map<string, Rec>(), progress: new Map<string, Rec>(), calls: [] as string[], hosts: [] as string[] }
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    state.calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
    state.hosts.push(url.host)
    const token = new Headers(init?.headers as Record<string, string>).get('authorization')
    if (token !== 'Bearer bridge-secret') return new Response(JSON.stringify({ detail: 'bad token' }), { status: 401 })
    if (url.pathname === '/state') return Response.json({ ok: true, logged_in: state.logged_in, generating: state.generating, conversation: null, model: 'GPT-6 Pro' })
    if (url.pathname === '/send') {
      const body = JSON.parse(String(init?.body)) as Rec
      if (!state.logged_in) return Response.json({ accepted: false, reason: 'needs_login' })
      if (state.generating) return Response.json({ accepted: false, reason: 'generating' })
      if (state.inUse) return Response.json({ accepted: false, reason: 'page_in_use', detail: state.inUse })
      state.sent.push(body)
      return Response.json({ accepted: true, message_id: `m${state.sent.length}`, conversation: { url: 'https://chatgpt.com/c/abc', title: 'directed' } })
    }
    if (url.pathname === '/answer') {
      const id = url.searchParams.get('turn_id') ?? ''
      const answer = state.answers.get(id)
      const progress = state.progress.get(id)
      return Response.json(answer ? { status: 'done', ...answer } : { status: 'generating', ...(progress ? { progress } : {}) })
    }
    return new Response('not found', { status: 404 })
  }
  return { state, fetchImpl }
}

test("a ChatGPT answer may take an hour and a half: the web app's longest thinking runs up to an hour", () => {
  expect(new ChatGptBridge('/nonexistent').timeout_ms).toBe(90 * 60_000)
  expect(bridgeAnswerTimeoutS({})).toBe(5400)
  // the former default, kept in the config of every bridge director opened before, is read as today's
  expect(bridgeAnswerTimeoutS({ poll_timeout_s: 1800 })).toBe(5400)
  // one chosen is kept
  expect(bridgeAnswerTimeoutS({ poll_timeout_s: 10 })).toBe(10)
  expect(bridgeAnswerTimeoutS({ poll_timeout_s: 7200 })).toBe(7200)
})

test('the bridge: the message is typed into ChatGPT as the person wrote it; the answer is read from the page', async () => {
  const bridge = fakeBridge()
  app = await makeApp(null, { director: { fetchImpl: bridge.fetchImpl, probe_interval_ms: 50 } })
  const c = new Client(app)
  const st = app.state
  setModel(st, 'scripted:a', scriptedModel(fixingScript()))
  const { session } = await openOverApi(c)
  const sid = session.id as string
  expect((await c.post(`/api/sessions/${sid}/director`, { transport: 'bridge', config: {} })).status).toBe(400)   // no bridge_url
  const opened = await json<DirectorDetail>(await c.post(`/api/sessions/${sid}/director`, { transport: 'bridge', model: 'GPT-6 Pro', config: { bridge_url: 'http://bridge.test/', bridge_token: 'bridge-secret', poll_interval_s: 1, busy_retry_s: 1 } }))
  expect(opened.director!.config).toMatchObject({ bridge_url: 'http://bridge.test', poll_interval_s: 1, poll_timeout_s: 5400, new_conversation: true, busy_retry_s: 1 })
  expect(opened.director!.label).toBe('GPT-6 Pro')
  asLegacyV1(st.conn, opened.director!.id)   // a pre-surface director row: this test pins director.v1's task-event words
  // the person writes: the bridge gets it, with the turn id, in a new conversation
  const t1 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: `why does add() subtract? ask ${agentMentionToken('Scripted A', 'scripted:a', 'pt_aaaaaa')}` }))
  const waiting = await waitFor(() => turnOf(c, t1.id), (t) => t.status === 'awaiting_answer', 'awaiting')
  expect(bridge.state.sent).toHaveLength(1)
  // the person's words go as they wrote them — no preface, no turn id; the connector says where to work (current_session);
  // an agent they named reads as its name and the route start_run takes, not as the chip's token
  expect(bridge.state.sent[0]).toEqual({ text: 'why does add() subtract? ask @Scripted A (scripted:a)', turn_id: t1.id, new_conversation: true })
  mcp = await connector(app)
  const current = await callTool(mcp, 'current_session', {})
  expect(current.app_reads_chat).toBe(true)
  expect(rec(current.session)).toMatchObject({ session_id: sid, turn_id: t1.id })
  expect(await callTool(mcp, 'post_director_note', { session_id: sid, question: 'why?', answer: 'a note' })).toMatchObject({ recorded: false })
  expect(repo.listDirectorNotes(st.conn, sid)).toHaveLength(0)
  // a new project or session while the person writes from oasis-code's window: the director is sent to the waiting one
  expect((await callTool(mcp, 'create_session', { project_id: String(session.project_id), title: 'a cat' })).error as string).toContain(`from oasis-code session ${sid}`)
  expect((await callTool(mcp, 'open_project', { path: buggyRepo() })).error as string).toContain(`from oasis-code session ${sid}`)
  expect(waiting.external_ref).toBe('https://chatgpt.com/c/abc')
  expect((await detailOf(c, sid)).director!.state).toBe('generating')
  expect((await detailOf(c, sid)).director!.external_ref).toBe('https://chatgpt.com/c/abc')
  // ChatGPT (with the connector) dispatches the fix in the session waiting on it — no session_id needed — and answers
  // in the chat, where the bridge reads it
  const run = await callTool(mcp, 'start_run', { text: 'fix add()', model: 'scripted:a' })
  expect(run.session_id).toBe(sid)
  bridge.state.answers.set(t1.id, { text: 'It subtracts; I sent the agent to fix it.', model: 'GPT-6 Pro' })
  const done1 = await waitFor(() => turnOf(c, t1.id), (t) => t.status === 'done', 'the first answer', 10_000)
  expect(done1.output).toBe('It subtracts; I sent the agent to fix it.')
  expect(done1.model).toBe('GPT-6 Pro')
  const notes = repo.listDirectorNotes(st.conn, sid)
  expect(notes).toHaveLength(1)
  expect(notes[0]!.source).toBe('chatgpt')
  expect(notes[0]!.turn_id).toBe(t1.id)
  // the run ends: a task event goes to the same conversation (not a new one)
  await waitDone(st, run.id as string)
  const t2 = await waitFor(() => detailOf(c, sid), (d) => d.turns.length === 2 && d.turns[1]!.status === 'awaiting_answer', 'the task-event turn').then((d) => d.turns[1]!)
  expect(bridge.state.sent[1]!.new_conversation).toBe(false)
  expect(bridge.state.sent[1]!.conversation_url).toBe('https://chatgpt.com/c/abc')      // its own conversation, whatever the page shows
  expect(String(bridge.state.sent[1]!.text)).toStartWith('App note: Runs finished:')
  expect(String(bridge.state.sent[1]!.text)).toContain(`run ${run.id}`)
  expect(bridge.state.sent[1]!.turn_id).toBe(t2.id)
  bridge.state.answers.set(t2.id, { text: 'Verdict ok: calc.py patched and checkpointed.', model: 'GPT-6 Pro' })
  const done2 = await waitFor(() => turnOf(c, t2.id), (t) => t.status === 'done', 'the poll', 10_000)
  expect(done2.output).toBe('Verdict ok: calc.py patched and checkpointed.')
  expect(bridge.state.calls.some((call) => call.startsWith(`GET /answer?turn_id=${t2.id}`))).toBe(true)
  expect((await detailOf(c, sid)).director!.state).toBe('idle')
  // signed out: the turn waits, the session says so, and it goes out once the bridge is signed in again
  bridge.state.logged_in = false
  const t3 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'and now?' }))
  await waitFor(() => detailOf(c, sid), (d) => d.director!.state === 'needs_login', 'needs_login')
  expect((await json<DirectorTurn>(await c.get(`/api/director-turns/${t3.id}`))).status).toBe('queued')
  expect((await detailOf(c, sid)).director!.last_error).toContain('not signed in')
  bridge.state.logged_in = true
  await waitFor(() => turnOf(c, t3.id), (t) => t.status === 'awaiting_answer', 'sent after the sign-in', 10_000)
  expect(bridge.state.sent).toHaveLength(3)
  // busy: the page is still answering an earlier message; the send is retried
  bridge.state.answers.set(t3.id, { text: 'done', model: 'GPT-6 Pro' })
  await waitFor(() => turnOf(c, t3.id), (t) => t.status === 'done', 'answered', 10_000)
  bridge.state.generating = true
  const t4 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'one more' }))
  await waitFor(() => bridge.state.calls.filter((call) => call.startsWith('POST /send')).length, (n) => n >= 4, 'the first send attempt')
  bridge.state.generating = false
  await waitFor(() => turnOf(c, t4.id), (t) => t.status === 'awaiting_answer', 'sent after the retry', 15_000)
  expect(bridge.state.sent).toHaveLength(4)
  // closing cancels what waits
  await json(await c.delete(`/api/sessions/${sid}/director`))
  expect((await json<DirectorTurn>(await c.get(`/api/director-turns/${t4.id}`))).status).toBe('cancelled')
}, 60_000)

test("the bridge: ChatGPT's reasoning, tool calls and words stream into the turn as they form; its images land in the session", async () => {
  const bridge = fakeBridge()
  app = await makeApp(null, { director: { fetchImpl: bridge.fetchImpl, probe_interval_ms: 50 } })
  const c = new Client(app)
  const { session } = await openOverApi(c)
  const sid = session.id as string
  await json(await c.post(`/api/sessions/${sid}/director`, { transport: 'bridge', model: 'GPT-6 Pro', config: { bridge_url: 'http://bridge.test', bridge_token: 'bridge-secret' } }))
  expect((await detailOf(c, sid)).director!.config.poll_interval_s).toBe(1)                // live progress: a poll a second
  const turn = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'draw a cat' }))
  await waitFor(() => turnOf(c, turn.id), (t) => t.status === 'awaiting_answer', 'awaiting')
  const seen: { event: string; data: Rec }[] = []
  const gone = new AbortController()
  const reading = (async () => { for await (const e of app!.state.director.subscribe(turn.id, { signal: gone.signal })) seen.push({ event: e.event, data: e.data }) })()
  bridge.state.progress.set(turn.id, { thinking: 'Planning the cat', text: '', steps: [] })
  await waitFor(() => detailOf(c, sid), (d) => d.live?.thinking === 'Planning the cat', 'the reasoning')
  bridge.state.progress.set(turn.id, { thinking: 'Planning the cat; Opus draws it', text: '画', steps: [{ kind: 'call', name: 'api_tool.call_tool', summary: 'send_message' }, { kind: 'result', name: 'api_tool.call_tool', summary: 'run started', status: 'finished_successfully' }] })
  const live = await waitFor(() => detailOf(c, sid), (d) => d.live?.text === '画', 'the words')
  expect(live.live!.thinking).toBe('Planning the cat; Opus draws it')
  expect(live.live!.tool_calls).toEqual([{ name: 'api_tool.call_tool', summary: 'send_message', status: 'ok', args: null, outcome: 'run started' }])   // the page's summary of the result is what came back
  bridge.state.progress.set(turn.id, { thinking: 'Rethought', text: '画好了', steps: [] })   // the reasoning replaced, the words grown
  await waitFor(() => detailOf(c, sid), (d) => d.live?.thinking === 'Rethought' && d.live?.text === '画好了', 'the replaced reasoning')
  const png = readFileSync(join(import.meta.dir, 'fixtures', 'images', 'red-7x5.png')).toString('base64')
  bridge.state.answers.set(turn.id, {
    text: '画好了：\n\n![橘白猫](sandbox:/mnt/data/cat.png)\n\n[下载 PNG](sandbox:/mnt/data/cat.png)', model: 'GPT-6 Pro',
    images: [{ name: 'cat.png', media_type: 'image/png', data_base64: png }, { name: 'extra.png', media_type: 'image/png', data_base64: png }, { name: 'bad.png', media_type: 'image/png', data_base64: 'bm90IGFuIGltYWdl' }],
  })
  const done = await waitFor(() => turnOf(c, turn.id), (t) => t.status === 'done', 'the answer')
  gone.abort()
  await reading
  const deltas = seen.filter((e) => e.event === 'thinking_delta').map((e) => e.data)
  expect(deltas).toEqual([{ text: 'Planning the cat' }, { text: '; Opus draws it' }, { text: 'Rethought', start: true }])
  expect(seen.filter((e) => e.event === 'text_delta').map((e) => e.data)).toEqual([{ text: '画' }, { text: '好了' }])
  const assets = [...done.output.matchAll(/\/api\/sessions\/[^/]+\/attachments\/([\w-]+)/g)].map((m) => m[1]!)
  expect(assets).toHaveLength(2)
  expect(done.output).toContain(`![橘白猫](/api/sessions/${sid}/attachments/${assets[0]})`)
  expect(done.output).toContain('[下载 PNG](sandbox:/mnt/data/cat.png)')                    // a link stays a link
  expect(done.output.trimEnd()).toEndWith(`![extra.png](/api/sessions/${sid}/attachments/${assets[1]})`)
  const image = await c.get(`/api/sessions/${sid}/attachments/${assets[0]}`)
  expect(image.headers.get('content-type')).toBe('image/png')
  expect(Buffer.from(await image.arrayBuffer()).toString('base64')).toBe(png)
  expect(repo.listDirectorNotes(app.state.conn, sid)[0]!.answer).toBe(done.output)
})

test('the bridge: every message goes with the model and the connector set when the director opens or later', async () => {
  const bridge = fakeBridge()
  app = await makeApp(null, { director: { fetchImpl: bridge.fetchImpl, probe_interval_ms: 50 } })
  const c = new Client(app)
  const { session } = await openOverApi(c)
  const sid = session.id as string
  const config = { bridge_url: 'http://bridge.test', bridge_token: 'bridge-secret' }
  const refused = await c.post(`/api/sessions/${sid}/director`, { transport: 'bridge', config: { ...config, mention: '@oasis-code' } })
  expect(refused.status).toBe(400)
  expect(((await refused.json()) as Rec).detail as string).toContain('[$oasis-code](app://')
  expect((await c.post(`/api/sessions/${sid}/director`, { transport: 'bridge', config: { ...config, chatgpt_model: 'gpt 6 pro' } })).status).toBe(400)
  await json(await c.post(`/api/sessions/${sid}/director`, { transport: 'bridge', config: { ...config, chatgpt_model: 'gpt-6-pro' } }))
  const t1 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'hello' }))
  await waitFor(() => turnOf(c, t1.id), (t) => t.status === 'awaiting_answer', 'awaiting')
  expect('mention' in bridge.state.sent[0]!).toBe(false)                                     // none set: none sent
  expect(bridge.state.sent[0]!.model).toBe('gpt-6-pro')
  bridge.state.answers.set(t1.id, { text: 'hi', model: 'GPT-6 Pro' })
  await waitFor(() => turnOf(c, t1.id), (t) => t.status === 'done', 'the first answer')
  const mention = '[$oasis-code](app://asdk_app_6ab76cd077ec8191b06a2100bf24b186)'
  expect((await c.put(`/api/sessions/${sid}/director`, { config: { mention: 'app://x' } })).status).toBe(400)
  const updated = await json<DirectorDetail>(await c.put(`/api/sessions/${sid}/director`, { config: { mention: `  ${mention} ` } }))
  expect(updated.director!.config.mention).toBe(mention)
  const t2 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: '让 claude opus5.5 画一只猫' }))
  await waitFor(() => turnOf(c, t2.id), (t) => t.status === 'awaiting_answer', 'awaiting')
  expect(bridge.state.sent[1]!.mention).toBe(mention)
  expect(String(bridge.state.sent[1]!.text)).toStartWith('让 claude opus5.5 画一只猫')      // the words stay the words
})

test('the bridge: a wrong token, an unreachable bridge, and an answer that never comes', async () => {
  const bridge = fakeBridge()
  app = await makeApp(null, { director: { fetchImpl: bridge.fetchImpl } })
  const c = new Client(app)
  const { session } = await openOverApi(c)
  const sid = session.id as string
  await json(await c.post(`/api/sessions/${sid}/director`, { transport: 'bridge', config: { bridge_url: 'http://bridge.test', bridge_token: 'wrong', poll_timeout_s: 10 } }))
  const t1 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'hello' }))
  const failed = await waitFor(() => turnOf(c, t1.id), (t) => t.status === 'error', 'the refusal')
  expect(failed.error).toContain('the bridge refused POST /send (401)')
  expect((await detailOf(c, sid)).director!.last_error).toContain('401')
  // fixed token; the turn's answer never comes: the deadline ends it, the session goes on
  await json(await c.put(`/api/sessions/${sid}/director`, { config: { bridge_token: 'bridge-secret', poll_timeout_s: 10, poll_interval_s: 1 } }))
  const t2 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'hello again' }))
  await waitFor(() => turnOf(c, t2.id), (t) => t.status === 'awaiting_answer', 'sent')
  // the deadline is measured from the turn's start: move it into the past instead of waiting ten seconds
  store.updateTurn(app.state.conn, t2.id, { started_at: new Date(Date.now() - 60_000).toISOString() })
  await app.state.director.reconcile()
  const timedOut = await waitFor(() => turnOf(c, t2.id), (t) => t.status === 'error', 'the deadline', 10_000)
  expect(timedOut.error).toContain('no answer from the director in 10 s')
  expect((await detailOf(c, sid)).director!.state).toBe('idle')
})

// ---- the workspace agent ---------------------------------------------------------------------------------------------

test('the task-event message names the run, its cause and the measured facts; tool results name the runs they started', () => {
  const event = {
    id: 'dev_1', director_session_id: 'dir_1', session_id: 's_1', seq: 1, kind: 'run_finished', ref_id: 'run_abc', dedupe_key: 'run_finished:run_abc', cause_turn_id: 'turn_9',
    payload: { label: 'fix', model: 'anthropic:claude-opus-5-5', status: 'done', tool_calls: 7, refused_calls: 1, lock_violations: 1,
      checks: { passed: 2, failed: 0, unknown: 0, not_run: 1 }, files_changed: 1, lines_added: 3, lines_removed: 1, final_checkpoint_id: 'cp_1', user_text_head: 'fix add()', final_text_head: 'Patched.' },
    status: 'pending' as const, attempts: 0, delivered_turn_id: null, error: null, created_at: 't', delivered_at: null,
  }
  const text = taskEventMessage('s_1', [event, { ...event, id: 'dev_2', ref_id: 'run_def', cause_turn_id: null, payload: { ...event.payload, is_thread_run: true, status: 'error', error: 'budget_exceeded: requests > 3' } }])
  expect(text).toStartWith('App note: Runs finished: run_abc, run_def.\nRead their results with get_run. These are completed runs, not new requests.')
  expect(text).toContain('session: s_1')
  expect(text).toContain('run run_abc "fix" on anthropic:claude-opus-5-5 — started by your instruction (turn turn_9)')
  expect(text).toContain('status: done; checks 2 passed / 0 failed / 0 unknown / 1 not run; 1 lock violation(s)')
  expect(text).toContain('7 tool calls, 1 refused; 1 file(s) changed (+3 −1); checkpoint: cp_1')
  expect(text).toContain('run run_def "fix" on anthropic:claude-opus-5-5 — started by the person from oasis-code (not by you)')
  expect(text).toContain('status: error (error: budget_exceeded: requests > 3)')
  expect(text).toContain('These are completed runs, not new requests.')
  expect(runIdsOf('start_run', { id: 'run_1a2b3c4d5e6f', status: 'running' })).toEqual(['run_1a2b3c4d5e6f'])
  expect(runIdsOf('get_run', { id: 'run_1a2b3c4d5e6f' })).toEqual([])
  expect(runIdsOf('start_run', { error: 'refused' })).toEqual([])
}, 60_000)

test("the director's conversation is kept whole between turns and compacted only near its route's window — the first turn summarized, never dropped", async () => {
  const saved = process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS
  process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = '60000'                              // threshold: 60 000 − 16 000 (output) − 8 000 (margin) = 36 000
  try {
    app = await makeApp()
    const c = new Client(app)
    const st = app.state
    st.config.models = st.config.models.map((cfg) => cfg.id === 'scripted:b' ? new ModelConfig({ ...cfg.dump(), id: cfg.id, provider: cfg.provider, model: cfg.model, max_tokens: 16_000 }) : cfg)
    const sizing = new ContextKeeper({ window: 60_000, output_reserve: 16_000 })
    const estimates: number[] = []
    const seen: ModelMessage[][] = []
    const LONG = 'the quick brown fox jumps over the lazy dog '.repeat(900)           // q3 below 36k; q4 + summary prompt below 44k
    expect(countTokens(`noted. ${LONG}`)).toBeLessThanOrEqual(16_000)
    setModel(st, 'scripted:b', scriptedModel((messages, info) => {
      seen.push(messages)
      const instructions = messages.findLast(isRequest)?.instructions ?? ''
      const estimate = sizing.predict(messages, { instructions, params: info.model_request_parameters }).tokens
      estimates.push(estimate)
      expect(info.model_settings.max_tokens).toBe(16_000)
      expect(estimate).toBeLessThanOrEqual(sizing.inputLimit)
      const last = messages[messages.length - 1]!
      const asked = isRequest(last) && last.parts.some((p) => isUserPrompt(p) && userText(p) === PROMPT_TEXT['compaction.request'])
      if (asked) return modelResponse([textPart('<summary>The person asked q1, q2 and q3; each got a long note.</summary>')])
      return modelResponse([textPart(`noted. ${LONG}`)])
    }, 'scripted-b'))
    const { session } = await openOverApi(c)
    const sid = session.id as string
    await json(await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: 'scripted:b' }))
    for (const q of ['q1', 'q2', 'q3', 'q4']) {
      const turn = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: q }))
      await waitFor(() => turnOf(c, turn.id), (t) => t.status === 'done', `turn ${q}`)
    }
    const ds = st.director.requireOpen(sid)
    const record = loadJson(store.getDirectorHistory(st.conn, ds.id)!)
    // the record holds every turn (q1 first) and one compaction; the model's view after it starts at the summary
    expect(userTexts(record)[0]).toEndWith('q1')
    const markers = record.filter(isCompaction)
    expect(markers).toHaveLength(1)
    const at = record.indexOf(markers[0]!)
    expect(at).toBeGreaterThan(0)
    expect(userText(markers[0]!.parts[0] as never)).toContain('The person asked q1, q2 and q3')
    // the requests the model saw: up to the summary request every one extends the one before; then the view begins anew
    const summaryAt = seen.findIndex((m) => { const last = m[m.length - 1]!; return isRequest(last) && last.parts.some((p) => isUserPrompt(p) && userText(p) === PROMPT_TEXT['compaction.request']) })
    expect(summaryAt).toBeGreaterThan(0)
    expect(summaryAt).toBe(3)
    expect(estimates.slice(0, summaryAt).every((n) => n < sizing.threshold)).toBe(true)
    expect(estimates[summaryAt]!).toBeGreaterThan(sizing.threshold)
    for (let i = 1; i <= summaryAt; i += 1) {
      const previous = seen[i - 1]!
      const current = seen[i]!
      for (let k = 0; k < previous.length - 1; k += 1) expect(JSON.stringify(current[k])).toBe(JSON.stringify(previous[k]))
    }
    const after = seen[summaryAt + 1]!
    expect(after).toHaveLength(1)
    expect(userText((after[0] as { parts: unknown[] }).parts[0] as never)).toStartWith('App note: The conversation so far was summarized')
    expect(JSON.stringify(after)).not.toContain('noted. the quick')                    // the long answers are summarized, not replayed
    expect(JSON.stringify(after)).not.toContain('"q2"')
    expect(JSON.stringify(after)).toContain('q4')                                      // the pending turn rides in the compaction request
    expect((await detailOf(c, sid)).director!.state).toBe('idle')
  } finally {
    if (saved === undefined) delete process.env['OASIS_CODE_CONTEXT_WINDOW_TOKENS' as string]
    else process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = saved
  }
}, 60_000)

test("the director's moved compaction line outlives its turn: the next turn on the same route does not summarize the summary at once", async () => {
  const saved = process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS
  process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = '60000'                              // threshold 36 000, half of it 18 000, window less output 44 000
  try {
    app = await makeApp()
    const c = new Client(app)
    const st = app.state
    st.config.models = st.config.models.map((cfg) => cfg.id === 'scripted:b' ? new ModelConfig({ ...cfg.dump(), id: cfg.id, provider: cfg.provider, model: cfg.model, max_tokens: 16_000 }) : cfg)
    const sizing = new ContextKeeper({ window: 60_000, output_reserve: 16_000 })
    const estimates: number[] = []
    let calls = 0
    let summaries = 0
    const WORDS = 'the quick brown fox jumps over the lazy dog '
    // Native turns seed only the moved line, not an input anchor. A large q2 (kept verbatim after compaction)
    // puts q2 over 36k but below 44k and leaves q3 between those lines, without replies exceeding the 16k output cap.
    const q2 = `q2\n${'context '.repeat(21_500)}`
    const kinds: string[] = []
    setModel(st, 'scripted:b', scriptedModel((messages, info) => {
      const instructions = messages.findLast(isRequest)?.instructions ?? ''
      const estimate = sizing.predict(messages, { instructions, params: info.model_request_parameters }).tokens
      estimates.push(estimate)
      expect(info.model_settings.max_tokens).toBe(16_000)
      expect(estimate).toBeLessThanOrEqual(sizing.inputLimit)
      const last = messages[messages.length - 1]!
      const countedText = (text: string) => {
        const output = countTokens(text)
        expect(output).toBeLessThanOrEqual(16_000)
        return modelResponse([textPart(text)], { usage: { input_tokens: estimate, output_tokens: output } as never })
      }
      if (isRequest(last) && last.parts.some((p) => isUserPrompt(p) && userText(p) === PROMPT_TEXT['compaction.request'])) {
        summaries += 1
        kinds.push('summary')
        return countedText('<summary>The person asked q1 and q2.</summary>')
      }
      calls += 1
      kinds.push(`q${calls}`)
      if (calls === 1) return countedText(`noted. ${WORDS.repeat(150)}`)
      if (calls === 2) return countedText(`noted. ${WORDS.repeat(200)}`)
      return countedText('noted.')
    }, 'scripted-b'))
    const { session } = await openOverApi(c)
    const sid = session.id as string
    await json(await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: 'scripted:b' }))
    const turns: DirectorTurn[] = []
    for (const q of ['q1', 'q2', 'q3']) {
      const turn = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: q === 'q2' ? q2 : q }))
      turns.push(await waitFor(() => turnOf(c, turn.id), (t) => t.status === 'done', `turn ${q}`))
    }
    expect(kinds).toEqual(['q1', 'summary', 'q2', 'q3'])
    expect(estimates[0]!).toBeLessThan(sizing.threshold)
    expect(estimates.slice(1).every((n) => n > sizing.threshold && n < sizing.inputLimit)).toBe(true)
    expect(turns[0]!.usage.context_trigger).toBeUndefined()
    expect(turns[1]!.usage.context_trigger).toBe(44_000)
    // the third turn's prediction is over the threshold but under the moved line: no second summary
    expect(summaries).toBe(1)
    expect(turns[2]!.usage.context_trigger).toBe(44_000)
    const ds = st.director.requireOpen(sid)
    expect(loadJson(store.getDirectorHistory(st.conn, ds.id)!).filter(isCompaction)).toHaveLength(1)
  } finally {
    if (saved === undefined) delete process.env['OASIS_CODE_CONTEXT_WINDOW_TOKENS' as string]
    else process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = saved
  }
}, 60_000)

test('the reasoning mode rides beside the effort on the Responses body — the API route only', () => {
  const api = new OpenAIResponsesModel('gpt-6-astra', { apiKey: 'k', baseUrl: 'http://openai.mock/v1' })
  const params = { function_tools: [], allow_text_output: true, thinking: 'high' as const }
  const pro = api.body([modelRequest([userPrompt('hi')])], { reasoning_mode: 'pro', thinking: 'high' }, params)
  expect(pro.reasoning).toEqual({ effort: 'high', summary: 'auto', mode: 'pro' })
  const alone = api.body([modelRequest([userPrompt('hi')])], { reasoning_mode: 'pro' }, { ...params, thinking: null })
  expect(alone.reasoning).toEqual({ mode: 'pro' })
  expect(api.body([modelRequest([userPrompt('hi')])], {}, params).reasoning).toEqual({ effort: 'high', summary: 'auto' })
  const codex = new OpenAIResponsesModel('gpt-6-astra', { codex: true, baseUrl: 'https://chatgpt.com/backend-api/codex' })
  expect(codex.body([modelRequest([userPrompt('hi')])], { reasoning_mode: 'pro', thinking: 'high' }, params).reasoning).toEqual({ effort: 'high', summary: 'auto' })
  // a route declares it; only an OpenAI Responses route with a key may
  const route = new ModelConfig({ id: 'openai-api:gpt-6-pro', provider: 'openai', model: 'gpt-6-astra', api_key_env: 'OPENAI_API_KEY', reasoning_mode: 'pro' })
  expect(route.reasoning_mode).toBe('pro')
  expect(route.dump().reasoning_mode).toBe('pro')
  expect(() => new ModelConfig({ id: 'openai:gpt-6-astra', provider: 'openai', model: 'gpt-6-astra', auth: 'oauth', reasoning_mode: 'pro' })).toThrow(/Codex subscription route does not take it/)
  expect(() => new ModelConfig({ id: 'x', provider: 'anthropic', model: 'claude', reasoning_mode: 'pro' })).toThrow(/reasoning_mode/)
}, 60_000)

test('a native director session refuses the pro mode on a route that cannot take it, and takes it on one that can', async () => {
  app = await makeApp()
  const c = new Client(app)
  const { session } = await openOverApi(c)
  const sid = session.id as string
  // a route without a credential cannot direct
  const noKey = await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: 'scripted:a' })
  expect(noKey.status).toBe(409)
  expect((await json(noKey, 409)).detail).toContain('scripted:a has no credential')
  setModel(app.state, 'scripted:a', scriptedModel(() => modelResponse([textPart('ok')])))
  const refused = await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: 'scripted:a', config: { reasoning_mode: 'pro' } })
  expect(refused.status).toBe(400)
  expect((await json(refused, 400)).detail).toContain('reasoning_mode pro needs an OpenAI API route')
  expect((await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: 'scripted:a', config: { thinking: 'loud' } })).status).toBe(400)
  expect((await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: 'nope:x' })).status).toBe(400)
  expect((await c.post(`/api/sessions/${sid}/director`, { transport: 'teleport' })).status).toBe(422)
  // scripted:b is an openai responses api_key route: the mode is accepted and reaches the settings
  const seen: AgentInfo[] = []
  setModel(app.state, 'scripted:b', scriptedModel((_m, info) => { seen.push(info); return modelResponse([textPart('ok')]) }, 'scripted-b'))
  const opened = await json<DirectorDetail>(await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: 'scripted:b', config: { reasoning_mode: 'pro', thinking: 'xhigh' } }))
  expect(opened.director!.config).toMatchObject({ reasoning_mode: 'pro', thinking: 'xhigh' })
  const t = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'think hard' }))
  await waitFor(() => turnOf(c, t.id), (x) => x.status === 'done', 'the turn')
  expect(seen[0]!.model_settings.reasoning_mode).toBe('pro')
  expect(seen[0]!.model_settings.thinking).toBe('xhigh')
}, 60_000)

test("a director turn that fails keeps the reason, never the key the provider's error quoted", async () => {
  app = await makeApp()
  const c = new Client(app)
  setModel(app.state, 'scripted:b', scriptedModel(() => { throw new ModelHTTPError(400, 'scripted-b', { error: { message: 'bad request for key sk-ant-api03-DIRSECRETDIRSECRET' } }) }, 'scripted-b'))
  const { session } = await openOverApi(c)
  const sid = session.id as string
  await json(await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: 'scripted:b' }))
  const said = await json<Rec>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'hello' }))
  const turnId = String(rec(said.turn ?? said).id)
  const turn = await waitFor(() => turnOf(c, turnId), (t) => t.status === 'error', 'the failed turn')
  expect(turn.error).toContain('bad request for key sk-…')
  expect(turn.error).not.toContain('DIRSECRET')
  expect(JSON.stringify(await detailOf(c, sid))).not.toContain('DIRSECRET')
})

test('the bridge: a send may take as long as the page takes to upload and send (not the 30 s of a read); an agent on the page is a busy page', async () => {
  const bridge = fakeBridge()
  app = await makeApp(null, { director: { fetchImpl: bridge.fetchImpl, probe_interval_ms: 50 } })
  const c = new Client(app)
  const { session } = await openOverApi(c)
  const sid = session.id as string
  await json(await c.post(`/api/sessions/${sid}/director`, { transport: 'bridge', config: { bridge_url: 'http://bridge.test/', bridge_token: 'bridge-secret', busy_retry_s: 1 } }))
  const asked: number[] = []
  const timeout = AbortSignal.timeout
  AbortSignal.timeout = (ms: number) => { asked.push(ms); return timeout.call(AbortSignal, ms) }
  try {
    bridge.state.inUse = 'run_agent'
    const t1 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'hello' }))
    await waitFor(() => bridge.state.calls.filter((call) => call.startsWith('POST /send')).length, (n) => n >= 1, 'the first send attempt')
    expect((await turnOf(c, t1.id)).status).not.toBe('failed')
    expect(bridge.state.sent).toHaveLength(0)
    bridge.state.inUse = null
    await waitFor(() => turnOf(c, t1.id), (t) => t.status === 'awaiting_answer', 'sent once the agent let go', 15_000)
    expect(bridge.state.sent).toHaveLength(1)
  } finally { AbortSignal.timeout = timeout }
  expect(asked).toContain(SEND_TIMEOUT_MS)
}, 60_000)

test("the desktop bridge's live token comes from the data directory: a director opened in an earlier run still reaches it", async () => {
  const bridge = fakeBridge()
  app = await makeApp(null, { director: { fetchImpl: bridge.fetchImpl, local_bridge_token: () => 'bridge-secret' } })
  const c = new Client(app)
  const { session } = await openOverApi(c)
  const sid = session.id as string
  // opened with the token of an app run that has ended; the bridge on the loopback answers to the file's token
  await json(await c.post(`/api/sessions/${sid}/director`, { transport: 'bridge', config: { bridge_url: 'http://127.0.0.1:8323', bridge_token: 'stale-from-last-run' } }))
  const t1 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'hello' }))
  await waitFor(() => turnOf(c, t1.id), (t) => t.status === 'awaiting_answer', 'sent through the live token')
  expect(bridge.state.sent).toHaveLength(1)
})

test("the desktop bridge's live address comes from the data directory too: the app started it on another port since", async () => {
  const bridge = fakeBridge()
  app = await makeApp(null, { director: { fetchImpl: bridge.fetchImpl, local_bridge_token: () => 'bridge-secret', local_bridge_url: () => 'http://127.0.0.1:8343' } })
  const c = new Client(app)
  const { session } = await openOverApi(c)
  const sid = session.id as string
  await json(await c.post(`/api/sessions/${sid}/director`, { transport: 'bridge', config: { bridge_url: 'http://127.0.0.1:8323', bridge_token: 'stale-from-last-run' } }))
  const t1 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'hello' }))
  await waitFor(() => turnOf(c, t1.id), (t) => t.status === 'awaiting_answer', 'sent to the live address')
  expect(bridge.state.sent).toHaveLength(1)
  expect(new Set(bridge.state.hosts)).toEqual(new Set(['127.0.0.1:8343']))
})

test('a bridge elsewhere keeps the token its director was opened with, whatever the local file says', async () => {
  const bridge = fakeBridge()
  app = await makeApp(null, { director: { fetchImpl: bridge.fetchImpl, local_bridge_token: () => 'bridge-secret' } })
  const c = new Client(app)
  const { session } = await openOverApi(c)
  const sid = session.id as string
  await json(await c.post(`/api/sessions/${sid}/director`, { transport: 'bridge', config: { bridge_url: 'http://bridge.test', bridge_token: 'its-own', poll_timeout_s: 10 } }))
  const t1 = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'hello' }))
  const failed = await waitFor(() => turnOf(c, t1.id), (t) => t.status === 'error', 'the refusal')
  expect(failed.error).toContain('(401)')
})
