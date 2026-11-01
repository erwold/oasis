/** Intelligent UI's interaction end to end on the backend (contract/src/ui_interaction.ts), with the real RunManager
 *  and scripted models over the app's own routes:
 *
 *  - request_input holds the run at its call: no model request is made until the person answers; the answer is the
 *    same call's result (same tool_call_id) and the same run goes on — no new run, no /chat. A Stop (or the run's
 *    wall-clock line) ends the wait; a form a dead process left is closed at startup with its event.
 *  - a surface's `run` action starts a task: the mode survives present_ui, the person's values and the page's input
 *    are in the run's message, the task is bound to its run before the first model request, return_ui_result's data
 *    is saved and streamed at once, the final answer is the task's text, and the task's end is on the stream before
 *    run_finished — succeeded, failed (agent_reported, run_error, start_failed) or cancelled. A task waits behind the
 *    conversation's live run and starts when it ends. The draft actions stay as they were.
 *  - a v21 database comes to the current schema and equals a fresh one. */

import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  buildUiActionPrompt, parseUiInputRequest, parseUiSurfaceSpec, SCHEMA_VERSION, TOOL_CALL_METADATA_KEYS, UI_TASK_LIMITS, UiInputRecordSchema, UiTaskRecordSchema, uiTaskResult,
  type Session, type UiInputRecord, type UiSurfaceRecord, type UiTaskRecord,
} from '@oasis-code/contract'
import type { RunEvent } from '../src/agent/runner.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import { connect, type Conn } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart, userTexts, type ModelMessage, type ModelResponse } from '../src/llm/messages.ts'
import { createApp, type App } from '../src/main.ts'
import { Client, json, parseSse } from './api_harness.ts'
import { buggyRepo, collectEvents, scriptedModel, setModel, testConfig, testSettings, waitDone } from './harness.ts'
import { tempDir } from './helpers.ts'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

type Rec = Record<string, unknown>
type Step = (messages: ModelMessage[]) => ModelResponse | Promise<ModelResponse>

/** One script for every run of the session: its steps in order, each from what that request is sent; every request
 *  counted (`requests`), with what the request's last user text was. */
function scripted(steps: Step[]) {
  const seen: { n: number; last_user: string }[] = []
  let n = 0
  const model = scriptedModel(async (messages) => {
    const texts = userTexts(messages)
    seen.push({ n, last_user: texts[texts.length - 1] ?? '' })
    const step = steps[n] ?? (() => modelResponse([textPart('done')]))
    n += 1
    return step(messages)
  })
  return { model, seen }
}

async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function open(c: Client): Promise<Session> {
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 't', model: 'scripted:a' }))
  return repo.getSession(app!.state.conn, String(session.id))!
}

const FORM: Rec = {
  title: 'Shipping', message: 'Where should it go?', root: 'f',
  elements: {
    f: { type: 'stack', children: ['city', 'speed', 'gift'] },
    city: { type: 'input', props: { label: 'City', key: 'city', inputType: 'text' } },
    speed: { type: 'select', props: { label: 'Speed', key: 'speed', options: [{ label: 'Normal', value: 'normal' }, { label: 'Fast', value: 'fast' }] } },
    gift: { type: 'checkbox', props: { label: 'Gift', key: 'gift' } },
  },
  initial_state: { speed: 'normal' }, required: ['city'], submit_label: 'Send',
}

const pendingOf = async (c: Client, session: Session): Promise<UiInputRecord[]> =>
  (await json(await c.get(`/api/sessions/${session.id}/ui-inputs`, { status: 'pending' }))).inputs as UiInputRecord[]

// -- request_input -----------------------------------------------------------------------------------------------------

test('request_input holds its run: no model request until the person submits; the same call returns the values and the same run goes on', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await open(c)
  let returned: Rec | null = null
  const { model, seen } = scripted([
    () => modelResponse([textPart('I need the address.'), toolCallPart('request_input', FORM, 'ri1')]),
    (m) => { returned = lastToolReturn(m, 'request_input') as Rec; return modelResponse([textPart(`Shipping to ${String((returned.values as Rec).city)}.`)]) },
  ])
  setModel(app.state, 'scripted:a', model)
  const run = await app.state.runs.start(session, 'ship it')
  await until('the pending form', async () => (await pendingOf(c, session)).length === 1)
  const [pending] = await pendingOf(c, session)
  expect(UiInputRecordSchema.safeParse(pending).success).toBe(true)
  expect(pending!).toMatchObject({ run_id: run.id, tool_call_id: 'ri1', status: 'pending', values: null, closed_reason: null })
  expect(pending!.request.title).toBe('Shipping')
  // the run is held at the call: still running, one request made, however long the person takes
  await sleep(300)
  expect(seen).toHaveLength(1)
  expect(repo.getRun(app.state.conn, run.id)!.status).toBe('running')
  expect(app.state.runs.handles.get(run.id)!.done).toBe(false)
  // an answer the form refuses changes nothing: the call still waits
  const refused = await json(await c.post(`/api/sessions/${session.id}/ui-inputs/${pending!.id}/submit`, { values: { city: '  ' } }), 400)
  expect(refused.error).toBe('invalid_values')
  expect(String(refused.detail)).toContain('values.city: required')
  expect((await json(await c.post(`/api/sessions/${session.id}/ui-inputs/${pending!.id}/submit`, { values: { speed: 'warp' } }), 400)).error).toBe('invalid_values')
  await sleep(100)
  expect(seen).toHaveLength(1)
  // the person's answer: merged over the form's defaults, written, then the waiting call woken
  const answered = await json(await c.post(`/api/sessions/${session.id}/ui-inputs/${pending!.id}/submit`, { values: { city: 'Lisbon', gift: true }, request_id: 'answer-0001' }))
  expect((answered.input as UiInputRecord)).toMatchObject({ status: 'submitted', values: { city: 'Lisbon', speed: 'normal', gift: true } })
  // the same request id again is answered as it stands; another answer is refused
  expect(((await json(await c.post(`/api/sessions/${session.id}/ui-inputs/${pending!.id}/submit`, { values: { city: 'Lisbon', gift: true }, request_id: 'answer-0001' }))).input as UiInputRecord).status).toBe('submitted')
  const again = await json(await c.post(`/api/sessions/${session.id}/ui-inputs/${pending!.id}/submit`, { values: { city: 'Porto' }, request_id: 'answer-0002' }), 409)
  expect(again.error).toBe('not_pending')
  expect((again.input as UiInputRecord).values!.city).toBe('Lisbon')
  expect((await json(await c.post(`/api/sessions/${session.id}/ui-inputs/${pending!.id}/dismiss`, {}), 409)).error).toBe('not_pending')
  const done = await waitDone(app.state, run.id)
  expect(done.status).toBe('done')
  // the same run went on: one run in the session, the second request is this run's, the call's own result
  expect(repo.listRuns(app.state.conn, session.id).map((r) => r.id)).toEqual([run.id])
  expect(seen).toHaveLength(2)
  expect(returned!).toEqual({ status: 'submitted', input_id: pending!.id, values: { city: 'Lisbon', speed: 'normal', gift: true } })
  expect(done.receipt.final_text).toBe('Shipping to Lisbon.')
  // the stream: the call (its title as metadata), the form pending, then answered, then the call's result
  const events = await collectEvents(app.state, run.id)
  const at = (pred: (e: RunEvent) => boolean) => events.findIndex(pred)
  const call = events.find((e) => e.event === 'tool_call' && e.data.tool === 'request_input')!
  expect(TOOL_CALL_METADATA_KEYS.request_input).toEqual(['title'])
  expect(call.data.title).toBe('Shipping')
  expect(String(call.data.summary).length).toBeLessThanOrEqual(241)                      // the arguments' bounded preview, as every call's
  const inputs = events.filter((e) => e.event === 'ui_input').map((e) => (e.data as { input: UiInputRecord }).input)
  expect(inputs.map((i) => i.status)).toEqual(['pending', 'submitted'])
  expect(inputs[1]!.updated_at > inputs[0]!.updated_at).toBe(true)
  const result = at((e) => e.event === 'tool_result' && e.data.tool === 'request_input')
  expect(at((e) => e.event === 'ui_input' && (e.data as { input: UiInputRecord }).input.status === 'submitted')).toBeLessThan(result)
  expect(events[result]!.data).toMatchObject({ tool_call_id: 'ri1', status: 'submitted', input_id: pending!.id })
  // a page reloaded later reads the form as it ended, by the run or by its id
  expect(((await json(await c.get(`/api/sessions/${session.id}/ui-inputs/${pending!.id}`))).input as UiInputRecord).status).toBe('submitted')
  expect(((await json(await c.get(`/api/sessions/${session.id}/ui-inputs`, { run_id: run.id }))).inputs as UiInputRecord[]).map((i) => i.id)).toEqual([pending!.id])
  expect(await pendingOf(c, session)).toEqual([])
  // the transcript of the ended run names the form, never its answer's values in the tool row
  const transcript = (await json(await c.get(`/api/runs/${run.id}/transcript`))).entries as Rec[]
  const row = transcript.find((e) => e.kind === 'activity' && e.tool === 'request_input')!
  expect(row.result).toEqual({ status: 'submitted', input_id: pending!.id })
})

test('request_input: a dismissal is the call\'s result; arguments that are no form answer invalid at once; another session cannot answer', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await open(c)
  const other = await open(c)
  const returns: Rec = {}
  const { model, seen } = scripted([
    () => modelResponse([toolCallPart('request_input', { ...FORM, elements: { ...(FORM.elements as Rec), go: { type: 'button', props: { label: 'Go', action: 'x' } } } }, 'bad1')]),
    (m) => { returns.button = lastToolReturn(m, 'request_input'); return modelResponse([toolCallPart('request_input', { title: 'Nothing', root: 't', elements: { t: { type: 'text', props: { text: 'hi' } } } }, 'bad2')]) },
    (m) => { returns.no_input = lastToolReturn(m, 'request_input'); return modelResponse([toolCallPart('request_input', FORM, 'ri2')]) },
    (m) => { returns.dismissed = lastToolReturn(m, 'request_input'); return modelResponse([textPart('ok, no shipping')]) },
  ])
  setModel(app.state, 'scripted:a', model)
  const run = await app.state.runs.start(session, 'ship it')
  await until('the pending form', async () => (await pendingOf(c, session)).length === 1)
  const [pending] = await pendingOf(c, session)
  // a button and a form without an input are refused by the full check, at once, by name; nothing is shown
  expect(returns.button).toMatchObject({ status: 'invalid' })
  expect(((returns.button as Rec).errors as string[]).join()).toContain('elements.go: request_input has no buttons')
  expect(String(returns.no_input && (returns.no_input as Rec).status)).toBe('invalid')
  expect(((returns.no_input as Rec).errors as string[]).join()).toContain('no input')
  expect(repo.listUiInputs(app.state.conn, session.id).map((i) => i.tool_call_id)).toEqual(['ri2'])
  // another session's form is not found there
  expect((await json(await c.post(`/api/sessions/${other.id}/ui-inputs/${pending!.id}/dismiss`, {}), 404)).error).toBe('not_found')
  expect((await json(await c.get(`/api/sessions/${other.id}/ui-inputs/${pending!.id}`), 404)).error).toBe('not_found')
  const dismissed = await json(await c.post(`/api/sessions/${session.id}/ui-inputs/${pending!.id}/dismiss`, { request_id: 'dismiss-001' }))
  expect((dismissed.input as UiInputRecord).status).toBe('dismissed')
  expect(((await json(await c.post(`/api/sessions/${session.id}/ui-inputs/${pending!.id}/dismiss`, { request_id: 'dismiss-001' }))).input as UiInputRecord).status).toBe('dismissed')
  const done = await waitDone(app.state, run.id)
  expect(done.status).toBe('done')
  expect(returns.dismissed).toEqual({ status: 'dismissed', input_id: pending!.id })
  expect(seen.length).toBeGreaterThanOrEqual(4)
})

test('request_input: Stop ends the wait (closed, cancelled) and the run; nothing answers it after; the run is not continued by the form', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await open(c)
  const { model, seen } = scripted([() => modelResponse([toolCallPart('request_input', FORM, 'ri3')])])
  setModel(app.state, 'scripted:a', model)
  const run = await app.state.runs.start(session, 'ship it')
  await until('the pending form', async () => (await pendingOf(c, session)).length === 1)
  const [pending] = await pendingOf(c, session)
  expect((await json(await c.post(`/api/runs/${run.id}/cancel`, {}))).cancelled).toBe(true)
  const done = await waitDone(app.state, run.id)
  expect(done.status).toBe('cancelled')
  expect(seen).toHaveLength(1)
  const closed = repo.getUiInput(app.state.conn, pending!.id)!
  expect(closed).toMatchObject({ status: 'closed', closed_reason: 'cancelled' })
  const late = await json(await c.post(`/api/sessions/${session.id}/ui-inputs/${pending!.id}/submit`, { values: { city: 'Lisbon' } }), 409)
  expect(late.error).toBe('not_pending')
  const events = await collectEvents(app.state, run.id)
  const inputs = events.filter((e) => e.event === 'ui_input').map((e) => (e.data as { input: UiInputRecord }).input)
  expect(inputs.map((i) => [i.status, i.closed_reason])).toEqual([['pending', null], ['closed', 'cancelled']])
  expect(events.find((e) => e.event === 'tool_result' && e.data.tool === 'request_input')!.data).toMatchObject({ status: 'closed' })
  expect(events.at(-1)!.event).toBe('run_finished')
})

test('request_input: the run\'s wall-clock line ends the wait as closed (budget), its time counted while it waited', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await open(c)
  const { model } = scripted([() => modelResponse([toolCallPart('request_input', FORM, 'ri4')])])
  setModel(app.state, 'scripted:a', model)
  const run = await app.state.runs.start(session, 'ship it', { budget: { wall_clock_s: 1 } })
  const done = await waitDone(app.state, run.id)
  expect(done.status).toBe('error')
  expect(done.error).toContain('budget_exceeded')
  const [input] = repo.listUiInputs(app.state.conn, session.id)
  expect(input).toMatchObject({ status: 'closed', closed_reason: 'budget' })
})

test('a reloaded thread rebuilds each form where its call was, as it ended — submitted, dismissed, closed — only in its own run; a director reads it as words', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await open(c)
  const { model } = scripted([
    () => modelResponse([textPart('Two questions.'), toolCallPart('request_input', FORM, 'q1')]),
    () => modelResponse([toolCallPart('request_input', { ...FORM, title: 'Wrapping' }, 'q2')]),
    () => modelResponse([textPart('Noted.')]),
    // the next run of the conversation: one form, then stopped while it waits
    () => modelResponse([toolCallPart('request_input', { ...FORM, title: 'Later' }, 'q3')]),
  ])
  setModel(app.state, 'scripted:a', model)
  const first = await app.state.runs.start(session, 'ask me')
  await until('the first form', async () => (await pendingOf(c, session)).length === 1)
  await json(await c.post(`/api/sessions/${session.id}/ui-inputs/${(await pendingOf(c, session))[0]!.id}/submit`, { values: { city: 'Lisbon', gift: true } }))
  await until('the second form', async () => (await pendingOf(c, session)).some((i) => i.request.title === 'Wrapping'))
  await json(await c.post(`/api/sessions/${session.id}/ui-inputs/${(await pendingOf(c, session))[0]!.id}/dismiss`, {}))
  await waitDone(app.state, first.id)
  const second = await app.state.runs.start(session, 'again')
  await until('the third form', async () => (await pendingOf(c, session)).length === 1)
  await json(await c.post(`/api/runs/${second.id}/cancel`, {}))
  await waitDone(app.state, second.id)
  type Entry = { kind: string; tool?: string; toolCallId?: string; text?: string; input?: UiInputRecord; result?: Rec }
  const transcriptOf = async (runId: string) => (await json(await c.get(`/api/runs/${runId}/transcript`))).entries as Entry[]
  const shape = (es: Entry[]) => es.map((e) => (e.kind === 'activity' ? `call:${e.toolCallId}` : e.kind === 'input' ? `input:${e.toolCallId}:${e.input!.status}` : e.kind))
  const a = await transcriptOf(first.id)
  expect(shape(a)).toEqual(['user', 'agent', 'call:q1', 'input:q1:submitted', 'call:q2', 'input:q2:dismissed', 'agent'])
  const submitted = a.find((e) => e.kind === 'input' && e.toolCallId === 'q1')!.input!
  expect(UiInputRecordSchema.safeParse(submitted).success).toBe(true)
  expect(submitted).toMatchObject({ run_id: first.id, status: 'submitted', values: { city: 'Lisbon', speed: 'normal', gift: true } })
  expect(submitted.request.elements.city).toBeDefined()                                   // the form whole: the page renders it again
  // the next run continues the conversation: its transcript holds its own form only, closed by the Stop
  const b = await transcriptOf(second.id)
  expect(shape(b)).toEqual(['user', 'call:q3', 'input:q3:closed'])
  expect(b.find((e) => e.kind === 'input')!.input).toMatchObject({ run_id: second.id, closed_reason: 'cancelled' })
  // a director reads a form as words — title, status, the answer — never its elements or the record
  const { boundedEntry } = await import('../src/director/server.ts')
  const words = boundedEntry(a.find((e) => e.kind === 'input' && e.toolCallId === 'q1')! as Rec)
  expect(words).toEqual({ kind: 'input', run_id: first.id, input_id: submitted.id, status: 'submitted', text: `[UI input "Shipping" (${submitted.id}, submitted)] Where should it go? speed: normal; city: Lisbon; gift: true` })
  const closed = boundedEntry(b.find((e) => e.kind === 'input')! as Rec)
  expect(String(closed.text)).toContain('closed: cancelled')
  expect(JSON.stringify(closed)).not.toContain('elements')
  expect(String(boundedEntry(a.find((e) => e.kind === 'input' && e.toolCallId === 'q2')! as Rec).text)).toStartWith('[UI input "Wrapping"')
})

// -- UI tasks ----------------------------------------------------------------------------------------------------------

const PANEL = (over: Rec = {}): Rec => ({
  version: 1, surface_id: 'panel', title: 'Panel', fallback: 'A panel that totals the amount.', kind: 'native',
  actions: [
    { id: 'total', label: 'Total', prompt: 'Total the amount and return it.', mode: 'run' },
    { id: 'note', label: 'Note', prompt: 'Write a note about the amount.' },
    { id: 'drafted', label: 'Drafted', prompt: 'Draft it.', mode: null },
  ],
  root: 'r',
  elements: {
    r: { type: 'stack', children: ['amount', 'go', 'write'] },
    amount: { type: 'input', props: { label: 'Amount', key: 'amount', inputType: 'number' } },
    go: { type: 'button', props: { label: 'Total', action: 'total' } },
    write: { type: 'button', props: { label: 'Note', action: 'note' } },
  },
  ...over,
})

const taskIdOf = (messages: ModelMessage[]): string => {
  const texts = userTexts(messages)
  const m = /UI task (uit_[0-9a-f]+)/.exec(texts[texts.length - 1] ?? '')
  if (!m) throw new Error('not a task run')
  return m[1]!
}

test('a run action starts a task: the mode survives present_ui, values and input reach the prompt, data streams back, the final answer is the result; draft actions unchanged', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const state = app.state
  const c = new Client(app)
  const session = await open(c)
  const atFirstRequest: { task: UiTaskRecord | null; events: string[] } = { task: null, events: [] }
  const returns: Rec = {}
  const { model, seen } = scripted([
    () => modelResponse([toolCallPart('present_ui', PANEL(), 'p1')]),
    () => modelResponse([textPart('Here is the panel.')]),
    // the task's run
    (m) => {
      const id = taskIdOf(m)
      const task = repo.getUiTask(state.conn, id)!
      atFirstRequest.task = task
      atFirstRequest.events = state.runs.handles.get(task.agent_run_id!)!.events.map((e) => e.event)
      return modelResponse([toolCallPart('return_ui_result', { data: { total: 42 } }, 'r1')])
    },
    (m) => { returns.first = lastToolReturn(m, 'return_ui_result'); return modelResponse([toolCallPart('return_ui_result', { data: { total: 1042, rows: [1, 2] }, ok: true, message: null }, 'r2')]) },
    () => modelResponse([textPart('The total is 1042.')]),
  ])
  setModel(state, 'scripted:a', model)
  const first = await state.runs.start(session, 'show a panel')
  await waitDone(state, first.id)
  // the stored spec keeps the run mode; an action without one (or with null) has no mode key: it reads as a draft
  const surface = repo.getUiSurface(state.conn, session.id, first.id, 'panel')!
  expect(surface.spec.actions).toEqual([
    { id: 'total', label: 'Total', prompt: 'Total the amount and return it.', mode: 'run' },
    { id: 'note', label: 'Note', prompt: 'Write a note about the amount.' },
    { id: 'drafted', label: 'Drafted', prompt: 'Draft it.' },
  ])
  expect(parseUiSurfaceSpec(surface.spec).ok).toBe(true)
  // a draft action is prepared as before (no run, the same prompt as the contract builds); a run action can be too
  const draft = await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/panel/actions`, { revision: 1, action_id: 'note', state: { amount: 5 }, request_id: 'draft-0001' }))
  expect(draft.prompt).toBe(buildUiActionPrompt({ run_id: first.id, surface_id: 'panel', revision: 1, title: 'Panel', action: { id: 'note', label: 'Note', prompt: 'Write a note about the amount.' }, state: { amount: 5 } }))
  expect((await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/panel/actions`, { revision: 1, action_id: 'total', state: {}, request_id: 'draft-0002' }))).status).toBe('prepared')
  expect(repo.listRuns(state.conn, session.id)).toHaveLength(1)
  // a draft action starts no task
  const notRun = await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/panel/tasks`, { revision: 1, action_id: 'note', state: {}, request_id: 'task-00001' }), 400)
  expect(notRun.error).toBe('not_a_run_action')
  expect((await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/panel/tasks`, { revision: 1, action_id: 'nope', state: {}, request_id: 'task-00002' }), 400)).error).toBe('unknown_action')
  expect((await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/panel/tasks`, { revision: 2, action_id: 'total', state: {}, request_id: 'task-00003' }), 409)).error).toBe('stale_revision')
  expect((await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/panel/tasks`, { revision: 1, action_id: 'total', state: { amount: 'x' }, request_id: 'task-00004' }), 400)).error).toBe('invalid_state')
  expect((await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/panel/tasks`, { revision: 1, action_id: 'total', state: {}, request_id: 'task-00005', input: 'x'.repeat(UI_TASK_LIMITS.inputChars + 1) }), 400)).error).toBe('invalid_input')
  expect((await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/nope/tasks`, { revision: 1, action_id: 'total', state: {}, request_id: 'task-00006' }), 404)).error).toBe('not_found')
  expect(repo.listUiTasks(state.conn, session.id)).toEqual([])
  // the press: the values saved, the task started now (the conversation is free) and already bound to its run
  const body = { revision: 1, action_id: 'total', state: { amount: 1000 }, request_id: 'task-00010', input: { rows: [1, 2], note: '</ui_input>' } }
  const started = await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/panel/tasks`, body), 202)
  const task = started.task as UiTaskRecord
  expect(UiTaskRecordSchema.safeParse(task).success).toBe(true)
  expect(task).toMatchObject({ session_id: session.id, surface_run_id: first.id, surface_id: 'panel', revision: 1, action_id: 'total', request_id: 'task-00010', status: 'running', input: body.input, text: '', data: null, error: null })
  expect(task.id).toStartWith('uit_')
  expect(task.agent_run_id).not.toBeNull()
  expect((started.surface as UiSurfaceRecord).state.amount).toBe(1000)
  // the same request again is the same task; another payload under it is a conflict; the surface has one task at a time
  expect(((await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/panel/tasks`, body))).task as UiTaskRecord).id).toBe(task.id)
  expect((await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/panel/tasks`, { ...body, input: { rows: [3] } }), 409)).error).toBe('request_conflict')
  const busy = await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/panel/tasks`, { ...body, request_id: 'task-00011' }), 409)
  expect(busy.error).toBe('task_active')
  expect((busy.task as UiTaskRecord).id).toBe(task.id)
  const runId = task.agent_run_id!
  const done = await waitDone(state, runId)
  expect(done.status).toBe('done')
  // the task's run: a person's thread run that continues the conversation, its message the action's prompt
  expect(done).toMatchObject({ spawned_by: 'human', resumes_run_id: first.id })
  expect(repo.runForClientRequest(state.conn, session.id, `ui-task:${task.id}`)!.id).toBe(runId)
  expect(done.user_text).toContain('[UI action] "Total" (action total)')
  expect(done.user_text).toContain('"amount":1000')
  expect(done.user_text).toContain(`UI task ${task.id}`)
  expect(done.user_text).toContain('<ui_input>\n{"rows":[1,2],"note":"\\u003c/ui_input>"}\n</ui_input>')
  expect(seen[2]!.last_user).toEndWith(done.user_text)                                   // the model reads it after the run's context lines
  // bound before the first model request: running, its run named, its first event on the stream already
  expect(atFirstRequest.task).toMatchObject({ status: 'running', agent_run_id: runId })
  expect(atFirstRequest.events).toEqual(['run_started', 'ui_task'])
  expect(returns.first).toEqual({ status: 'ok', task_id: task.id })
  // the stream: running, each return_ui_result's data at once, the end — before run_finished, the last event
  const events = await collectEvents(state, runId)
  const tasks = events.filter((e) => e.event === 'ui_task').map((e) => (e.data as { task: UiTaskRecord }).task)
  expect(tasks.map((t) => [t.status, t.data])).toEqual([
    ['running', null], ['running', { total: 42 }], ['running', { total: 1042, rows: [1, 2] }], ['succeeded', { total: 1042, rows: [1, 2] }],
  ])
  for (let i = 1; i < tasks.length; i += 1) expect(tasks[i]!.updated_at > tasks[i - 1]!.updated_at).toBe(true)
  expect(events.at(-1)!.event).toBe('run_finished')
  expect(events.at(-2)!.event).toBe('ui_task')
  expect(events.filter((e) => e.event === 'tool_call' && e.data.tool === 'return_ui_result').map((e) => e.data.ok)).toEqual([undefined, true])
  const ended = repo.getUiTask(state.conn, task.id)!
  expect(ended).toMatchObject({ status: 'succeeded', text: 'The total is 1042.', data: { total: 1042, rows: [1, 2] }, error: null })
  expect(ended.finished_at).not.toBeNull()
  expect(uiTaskResult(ended)).toEqual({ ok: true, task_id: task.id, status: 'succeeded', text: 'The total is 1042.', data: { total: 1042, rows: [1, 2] }, error: null })
  // the lists and the record over the API; the persisted stream carries the task's events for a reconnect
  const listed = (await json(await c.get(`/api/sessions/${session.id}/ui-tasks`, { run_id: first.id, surface_id: 'panel' }))).tasks as UiTaskRecord[]
  expect(listed.map((t) => t.id)).toEqual([task.id])
  expect((await json(await c.get(`/api/sessions/${session.id}/ui-tasks`, { active: '1' }))).tasks).toEqual([])
  expect(((await json(await c.get(`/api/sessions/${session.id}/ui-tasks/${task.id}`))).task as UiTaskRecord).status).toBe('succeeded')
  const sse = parseSse(await (await c.get(`/api/runs/${runId}/events`, { after: -1 })).text())
  expect(sse.filter((f) => f.event === 'ui_task').map((f) => (f.data.task as UiTaskRecord).status)).toEqual(['running', 'running', 'running', 'succeeded'])
  // an ended task's cancel answers it as it stands
  const cancelled = await c.post(`/api/sessions/${session.id}/ui-tasks/${task.id}/cancel`, {})
  expect(cancelled.status).toBe(200)
  expect(((await cancelled.json()) as { task: UiTaskRecord }).task.status).toBe('succeeded')
  // the conversation holds the task as one of its turns: the next run continues from it
  expect(repo.latestRunOfSession(state.conn, session.id)!.id).toBe(runId)
})

test('a task waits behind the conversation\'s live run and starts at its end; a queued one is cancelled at once; the queue is bounded', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const state = app.state
  const c = new Client(app)
  const session = await open(c)
  const panels = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']
  const { model } = scripted([
    () => modelResponse(panels.map((id, i) => toolCallPart('present_ui', PANEL({ surface_id: id }), `s${i}`))),
    () => modelResponse([textPart('Panels.')]),
    // the run that holds the conversation: it waits on the person
    () => modelResponse([toolCallPart('request_input', FORM, 'hold')]),
    () => modelResponse([textPart('Held, then released.')]),
    // the queued task's run, once the conversation is free
    (m) => modelResponse([toolCallPart('return_ui_result', { data: { from: taskIdOf(m) } }, 'r1')]),
    () => modelResponse([textPart('Done after the wait.')]),
  ])
  setModel(state, 'scripted:a', model)
  const first = await state.runs.start(session, 'show panels')
  await waitDone(state, first.id)
  const holder = await state.runs.start(session, 'ask me')
  await until('the pending form', async () => (await pendingOf(c, session)).length === 1)
  const press = (surface: string, request: string) => c.post(`/api/sessions/${session.id}/ui/${first.id}/${surface}/tasks`, { revision: 1, action_id: 'total', state: { amount: 7 }, request_id: request })
  const queued = (await json(await press('p1', 'queue-0001'), 202)).task as UiTaskRecord
  expect(queued).toMatchObject({ status: 'queued', agent_run_id: null, started_at: null })
  // four wait at most; the fifth is refused
  const others: UiTaskRecord[] = []
  for (const [i, p] of ['p2', 'p3', 'p4'].entries()) others.push((await json(await press(p, `queue-000${i + 2}`), 202)).task as UiTaskRecord)
  expect((await json(await press('p5', 'queue-0005'), 409)).error).toBe('queue_full')
  expect(((await json(await c.get(`/api/sessions/${session.id}/ui-tasks`, { active: '1' }))).tasks as UiTaskRecord[]).map((t) => t.id)).toEqual([...others].reverse().map((t) => t.id).concat(queued.id))
  // a queued task cancelled: it ends now, no run ever starts for it
  for (const t of others) {
    const r = await c.post(`/api/sessions/${session.id}/ui-tasks/${t.id}/cancel`, {})
    expect(r.status).toBe(200)
    expect(((await r.json()) as { task: UiTaskRecord }).task).toMatchObject({ status: 'cancelled', agent_run_id: null, error: null })
  }
  expect(uiTaskResult(repo.getUiTask(state.conn, others[0]!.id)!)!.status).toBe('cancelled')
  // still waiting while the conversation is taken
  await sleep(200)
  expect(repo.getUiTask(state.conn, queued.id)!.status).toBe('queued')
  // the conversation frees: the queued task starts as the holder's next turn
  const [form] = await pendingOf(c, session)
  await json(await c.post(`/api/sessions/${session.id}/ui-inputs/${form!.id}/submit`, { values: { city: 'Rome' } }))
  await waitDone(state, holder.id)
  await until('the queued task to start', () => repo.getUiTask(state.conn, queued.id)!.agent_run_id !== null)
  const taskRun = repo.getUiTask(state.conn, queued.id)!.agent_run_id!
  const done = await waitDone(state, taskRun)
  expect(done.status).toBe('done')
  expect(done.resumes_run_id).toBe(holder.id)
  const ended = repo.getUiTask(state.conn, queued.id)!
  expect(ended).toMatchObject({ status: 'succeeded', text: 'Done after the wait.', data: { from: queued.id } })
  expect(ended.started_at! >= ended.created_at).toBe(true)
  // only the one task ran: the cancelled ones have no run
  expect(repo.listRuns(state.conn, session.id).map((r) => r.id).filter((id) => id !== first.id && id !== holder.id)).toEqual([taskRun])
  for (const t of others) expect(repo.runForClientRequest(state.conn, session.id, `ui-task:${t.id}`)).toBeNull()
})

test('a task\'s end: the last return_ui_result ok false → failed (agent_reported); a later ok clears it; a run error → failed (run_error)', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const state = app.state
  const c = new Client(app)
  const session = await open(c)
  const { model } = scripted([
    () => modelResponse([toolCallPart('present_ui', PANEL(), 'p1')]),
    () => modelResponse([textPart('Panel.')]),
    // task 1: reports failure last
    () => modelResponse([toolCallPart('return_ui_result', { data: { partial: true } }, 'a1')]),
    () => modelResponse([toolCallPart('return_ui_result', { ok: false, message: 'the amount is missing' }, 'a2')]),
    () => modelResponse([textPart('Could not total it.')]),
    // task 2: failure, then success
    () => modelResponse([toolCallPart('return_ui_result', { ok: false, message: 'first try failed' }, 'b1')]),
    () => modelResponse([toolCallPart('return_ui_result', { data: { total: 3 } }, 'b2')]),
    () => modelResponse([textPart('Totalled on the second try.')]),
    // task 3: the provider fails
    () => { throw new Error('the scripted provider broke') },
  ])
  setModel(state, 'scripted:a', model)
  const first = await state.runs.start(session, 'panel')
  await waitDone(state, first.id)
  const run = async (request: string): Promise<UiTaskRecord> => {
    const t = (await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/panel/tasks`, { revision: 1, action_id: 'total', state: {}, request_id: request }), 202)).task as UiTaskRecord
    await waitDone(state, t.agent_run_id!)
    return repo.getUiTask(state.conn, t.id)!
  }
  const reported = await run('fail-00001')
  expect(reported).toMatchObject({ status: 'failed', error: { code: 'agent_reported', message: 'the amount is missing' }, text: 'Could not total it.', data: null })
  expect(repo.getRun(state.conn, reported.agent_run_id!)!.status).toBe('done')
  expect(uiTaskResult(reported)).toMatchObject({ ok: false, status: 'failed', error: { code: 'agent_reported' } })
  const cleared = await run('fail-00002')
  expect(cleared).toMatchObject({ status: 'succeeded', error: null, data: { total: 3 } })
  const broken = await run('fail-00003')
  expect(broken.status).toBe('failed')
  expect(broken.error!.code).toBe('run_error')
  expect(broken.error!.message).toContain('the scripted provider broke')
  const events = await collectEvents(state, broken.agent_run_id!)
  expect(events.at(-2)!.event).toBe('ui_task')
  expect(events.at(-1)!.event).toBe('run_finished')
})

test('a running task stopped from its surface: its run is cancelled (202), the task ends cancelled before run_finished; Stop on the run does the same', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const state = app.state
  const c = new Client(app)
  const session = await open(c)
  const { model } = scripted([
    () => modelResponse([toolCallPart('present_ui', PANEL(), 'p1')]),
    () => modelResponse([textPart('Panel.')]),
    // each task's run waits on the person
    () => modelResponse([toolCallPart('return_ui_result', { data: { step: 1 } }, 'w0'), toolCallPart('request_input', FORM, 'w1')]),
    () => modelResponse([toolCallPart('request_input', FORM, 'w2')]),
  ])
  setModel(state, 'scripted:a', model)
  const first = await state.runs.start(session, 'panel')
  await waitDone(state, first.id)
  const t = (await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/panel/tasks`, { revision: 1, action_id: 'total', state: {}, request_id: 'stop-00001' }), 202)).task as UiTaskRecord
  await until('the task run\'s form', async () => (await pendingOf(c, session)).length === 1)
  const r = await c.post(`/api/sessions/${session.id}/ui-tasks/${t.id}/cancel`, {})
  expect(r.status).toBe(202)
  await waitDone(state, t.agent_run_id!)
  const ended = repo.getUiTask(state.conn, t.id)!
  expect(ended).toMatchObject({ status: 'cancelled', error: null, data: { step: 1 } })
  expect(uiTaskResult(ended)).toMatchObject({ ok: false, status: 'cancelled', task_id: t.id })
  const events = await collectEvents(state, t.agent_run_id!)
  expect(events.at(-2)!.event).toBe('ui_task')
  expect((events.at(-2)!.data as { task: UiTaskRecord }).task.status).toBe('cancelled')
  expect(events.at(-1)!.event).toBe('run_finished')
  // the thread's own Stop of a task's run ends the task the same way
  const t2 = (await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/panel/tasks`, { revision: 1, action_id: 'total', state: {}, request_id: 'stop-00002' }), 202)).task as UiTaskRecord
  await until('the second form', async () => (await pendingOf(c, session)).length === 1)
  expect((await json(await c.post(`/api/runs/${t2.agent_run_id}/cancel`, {}))).cancelled).toBe(true)
  await waitDone(state, t2.agent_run_id!)
  expect(repo.getUiTask(state.conn, t2.id)!.status).toBe('cancelled')
})

test('return_ui_result answers invalid outside a task\'s run and for data past its bounds; a task that cannot start fails start_failed', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const state = app.state
  const c = new Client(app)
  const session = await open(c)
  const returns: Rec = {}
  const deep: Rec = {}
  let at = deep
  for (let i = 0; i < UI_TASK_LIMITS.dataDepth + 2; i += 1) { at.x = {}; at = at.x as Rec }
  const { model } = scripted([
    () => modelResponse([toolCallPart('return_ui_result', { data: { a: 1 } }, 'n1')]),
    (m) => { returns.outside = lastToolReturn(m, 'return_ui_result'); return modelResponse([toolCallPart('present_ui', PANEL(), 'p1')]) },
    () => modelResponse([textPart('Panel.')]),
    () => modelResponse([toolCallPart('return_ui_result', { data: deep }, 'd1')]),
    (m) => { returns.deep = lastToolReturn(m, 'return_ui_result'); return modelResponse([toolCallPart('return_ui_result', { data: 'y'.repeat(UI_TASK_LIMITS.dataChars + 1) }, 'd2')]) },
    (m) => { returns.big = lastToolReturn(m, 'return_ui_result'); return modelResponse([textPart('nothing sent')]) },
  ])
  setModel(state, 'scripted:a', model)
  const first = await state.runs.start(session, 'panel')
  await waitDone(state, first.id)
  expect((returns.outside as Rec).status).toBe('invalid')
  expect(((returns.outside as Rec).errors as string[]).join()).toContain('not started by a UI task')
  const t = (await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/panel/tasks`, { revision: 1, action_id: 'total', state: {}, request_id: 'data-00001' }), 202)).task as UiTaskRecord
  await waitDone(state, t.agent_run_id!)
  expect((returns.deep as Rec).status).toBe('invalid')
  expect(((returns.deep as Rec).errors as string[]).join()).toContain('nested deeper than 16')
  expect((returns.big as Rec).status).toBe('invalid')
  expect(repo.getUiTask(state.conn, t.id)).toMatchObject({ status: 'succeeded', data: null })
  // a task whose run cannot be made (the session's model is gone): failed start_failed, the queue moves on
  repo.setSessionModel(state.conn, session.id, 'no-such-model')
  const failed = (await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/panel/tasks`, { revision: 1, action_id: 'total', state: {}, request_id: 'data-00002' }), 202)).task as UiTaskRecord
  await until('the start to fail', () => repo.getUiTask(state.conn, failed.id)!.status !== 'queued')
  expect(repo.getUiTask(state.conn, failed.id)).toMatchObject({ status: 'failed', agent_run_id: null, error: { code: 'start_failed' } })
  expect(repo.getUiTask(state.conn, failed.id)!.error!.message).toContain('unknown model')
})

test('the new tools are described by mechanism, parameters and limits only', async () => {
  for (const key of ['tool.request_input', 'tool.return_ui_result', 'parameter.request_input.required', 'parameter.return_ui_result.ok', 'ui.task', 'ui.task_input'] as const) {
    const t = PROMPT_TEXT[key]
    expect(t).not.toMatch(/\b(e\.g\.|for instance|such as|ideal for|useful for|good for|use it (?:for|to)|example)\b/i)
  }
  expect(PROMPT_TEXT['tool.request_input']).toContain('wall-clock limit keeps counting')
  expect(PROMPT_TEXT['tool.request_input']).toContain('20 calls per run')
  expect(PROMPT_TEXT['tool.return_ui_result']).toContain('in any other run it answers invalid')
  expect(PROMPT_TEXT['tool.return_ui_result']).toContain('at most 60,000 characters as JSON and nesting 16')
  // return_ui_result: what clears the data and the failure, and what the call answers
  for (const x of ['data absent or null clears it', 'ok false makes the task end as failed when the run ends', 'a later call with ok true or absent clears that', '{status: ok, task_id} or {status: invalid, errors}'])
    expect(PROMPT_TEXT['tool.return_ui_result'], x).toContain(x)
  // request_input stands alone (a work order may give it without present_ui): the element syntax the form takes is its own
  const ri = PROMPT_TEXT['tool.request_input']
  expect(ri).not.toMatch(/as present_ui|present_ui's/)
  for (const x of ['root names the top element', 'children: a list of ids', 'stack, row, card (title?)', 'input (label, key, inputType: text or number', 'select (label, key, options: [{label, value}], multiple?)',
    'slider (label, key, min, max, step?)', 'checkbox (label, key)', 'holds its value under its key', 'No buttons',
    // the rest of the catalog the form takes (every native type but button) and the bounded value expressions
    'metric (label, value, unit?)', 'table (columns: [{key, label}], rows: objects by column key', 'chart (kind: bar or line, data: [{label, value}], label?)',
    'image (src: an https URL or a data:image/png, jpeg, gif or webp base64 URL, alt)', 'divider', '{"state": "key"}',
    '{"op": "add|subtract|multiply|divide|min|max|round", "args": [values]}', 'an expression nests at most 8 deep with at most 8 args per op and 64 parts',
    'nesting 12', '200 elements', 'the whole request under 100,000 characters as JSON'])
    expect(ri, x).toContain(x)
  // what the text says the form takes, the contract takes: all thirteen types and an expression; a button never
  const named = ['stack', 'row', 'card', 'text', 'metric', 'table', 'chart', 'input', 'select', 'slider', 'checkbox', 'image', 'divider']
  for (const t of named) expect(ri, t).toMatch(new RegExp(`\\b${t} \\(|\\b${t}[,;.]`))
  const all = parseUiInputRequest({
    title: 'All types', root: 'main', required: ['qty'],
    elements: {
      main: { type: 'stack', children: ['r', 'c', 'd'] },
      r: { type: 'row', children: ['qty', 'price', 'pick', 'on'] },
      c: { type: 'card', props: { title: 'Readout' }, children: ['t', 'm', 'tab', 'ch', 'img'] },
      d: { type: 'divider' },
      qty: { type: 'input', props: { label: 'Qty', key: 'qty', inputType: 'number', min: 0, max: 10 } },
      price: { type: 'slider', props: { label: 'Price', key: 'price', min: 0, max: 100, step: 5 } },
      pick: { type: 'select', props: { label: 'Pick', key: 'pick', options: [{ label: 'A', value: 'a' }] } },
      on: { type: 'checkbox', props: { label: 'On', key: 'on' } },
      t: { type: 'text', props: { text: { state: 'pick' } } },
      m: { type: 'metric', props: { label: 'Total', value: { op: 'round', args: [{ op: 'multiply', args: [{ state: 'qty' }, { state: 'price' }] }, 2] }, unit: 'USD' } },
      tab: { type: 'table', props: { columns: [{ key: 'k', label: 'K' }], rows: [{ k: 1 }, { k: null }], caption: 'cap' } },
      ch: { type: 'chart', props: { kind: 'bar', data: [{ label: 'q', value: { state: 'qty' } }, { label: 'p', value: { op: 'divide', args: [{ state: 'price' }, 2] } }] } },
      img: { type: 'image', props: { src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'dot' } },
    },
    initial_state: { qty: 1, price: 10, pick: 'a', on: false },
  })
  expect(all.ok, JSON.stringify(all)).toBe(true)
})

test('a cancel that comes once the task\'s run is writing its end is refused (409 task_finishing), not accepted and lost; the task ends as its run does', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const state = app.state
  const c = new Client(app)
  const session = await open(c)
  const { model } = scripted([
    () => modelResponse([toolCallPart('present_ui', PANEL(), 'p1')]),
    () => modelResponse([textPart('Panel.')]),
    () => modelResponse([toolCallPart('return_ui_result', { data: { total: 9 } }, 'r1')]),
    () => modelResponse([textPart('The total is 9.')]),
  ])
  setModel(state, 'scripted:a', model)
  const first = await state.runs.start(session, 'panel')
  await waitDone(state, first.id)
  // the run's end held at its final snapshot (finalize has taken the run's status; the snapshot and receipt follow)
  let reached = false
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const snapshot = state.workspaces.snapshot.bind(state.workspaces)
  // only the snapshot a UI task's run takes while writing its end is held (its admission baseline goes through)
  const finishing = () => [...state.runs.handles.values()].some((h) => h.ui_task !== null && h.finalizing && !h.done)
  state.workspaces.snapshot = (async (ws: Parameters<typeof snapshot>[0]) => {
    if (!finishing()) return snapshot(ws)
    reached = true
    await gate
    return snapshot(ws)
  }) as typeof state.workspaces.snapshot
  const t = (await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/panel/tasks`, { revision: 1, action_id: 'total', state: {}, request_id: 'late-00001' }), 202)).task as UiTaskRecord
  await until('the run to write its end', () => reached)
  expect(state.runs.handles.get(t.agent_run_id!)!.finalizing).toBe(true)
  expect(state.runs.canStop(t.agent_run_id!)).toBe(false)
  const late = await json(await c.post(`/api/sessions/${session.id}/ui-tasks/${t.id}/cancel`, {}), 409)
  expect(late.error).toBe('task_finishing')
  expect((late.task as UiTaskRecord)).toMatchObject({ id: t.id, status: 'running' })
  release()
  await waitDone(state, t.agent_run_id!)
  // what the refusal said: the task ended as its run did
  expect(repo.getUiTask(state.conn, t.id)).toMatchObject({ status: 'succeeded', text: 'The total is 9.', data: { total: 9 } })
  expect(repo.getRun(state.conn, t.agent_run_id!)!.status).toBe('done')
})

test('closing the app ends a task still queued (failed interrupted) as it ends the running ones: no task reads as queued after', async () => {
  const settings = testSettings()
  app = await createApp(settings, testConfig(), { probe: false })
  const state = app.state
  const c = new Client(app)
  const session = await open(c)
  const { model } = scripted([
    () => modelResponse([toolCallPart('present_ui', PANEL(), 'p1')]),
    () => modelResponse([textPart('Panel.')]),
    () => modelResponse([toolCallPart('request_input', FORM, 'hold')]),
  ])
  setModel(state, 'scripted:a', model)
  const first = await state.runs.start(session, 'panel')
  await waitDone(state, first.id)
  const holder = await state.runs.start(session, 'ask me')
  await until('the holder\'s form', async () => (await pendingOf(c, session)).length === 1)
  const queued = (await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/panel/tasks`, { revision: 1, action_id: 'total', state: {}, request_id: 'close-0001' }), 202)).task as UiTaskRecord
  expect(queued.status).toBe('queued')
  const closing = app.close()
  app = null
  await closing
  const reopened = connect(settings.db_path)
  try {
    const ended = repo.getUiTask(reopened, queued.id)!
    expect(ended).toMatchObject({ status: 'failed', agent_run_id: null, error: { code: 'interrupted' } })
    expect(ended.finished_at).not.toBeNull()
    expect(uiTaskResult(ended)).toMatchObject({ ok: false, status: 'failed', error: { code: 'interrupted' } })
    expect(repo.listUiTasks(reopened, session.id, { active: true })).toEqual([])
    // the conversation's own run was cut off too: its form closed interrupted, the run cancelled, no task started for it
    expect(repo.getRun(reopened, holder.id)!.status).toBe('cancelled')
    expect(repo.listUiInputs(reopened, session.id)[0]).toMatchObject({ status: 'closed', closed_reason: 'interrupted' })
    expect(repo.runForClientRequest(reopened, session.id, `ui-task:${queued.id}`)).toBeNull()
  } finally {
    reopened.close()
  }
})

// -- restart -------------------------------------------------------------------------------------------------------------

test('a restart closes what a dead process left: its form interrupted and its task failed (interrupted), their events before run_finished; a queued task fails too', async () => {
  const settings = testSettings()
  app = await createApp(settings, testConfig(), { probe: false })
  const c = new Client(app)
  const session = await open(c)
  const conn = app.state.conn
  // a run the last process left running, with a form pending and the task it was doing; and a task left queued
  const surfaceRun = repo.insertRun(conn, { session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, model: 'scripted:a', model_config: {}, user_text: 'panel', status: 'done', budget: {} })
  const dead = repo.insertRun(conn, { session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, model: 'scripted:a', model_config: {}, user_text: 'task', status: 'running', budget: {} })
  repo.insertEvent(conn, dead.id, 0, 'run_started', {})
  const base = { session_id: session.id, surface_run_id: surfaceRun.id, surface_id: 'panel', revision: 1, action_id: 'total', payload_sha: 'x', prompt: 'p', input: null }
  repo.insertUiTask(conn, { ...base, id: 'uit_running0001', request_id: 'restart-001' })
  expect(repo.bindUiTask(conn, 'uit_running0001', dead.id)).toBe(true)
  repo.insertUiTask(conn, { ...base, id: 'uit_queued00001', surface_id: 'other', request_id: 'restart-002' })
  const form = repo.insertUiInput(conn, { session_id: session.id, run_id: dead.id, tool_call_id: 'x1', request: { title: 'Left' } })
  await app.close()
  app = await createApp(settings, testConfig(), { probe: false })
  const counts = await app.start()
  expect(counts.dead_runs).toEqual([dead.id])
  const conn2 = app.state.conn
  expect(repo.getUiInput(conn2, form.id)).toMatchObject({ status: 'closed', closed_reason: 'interrupted' })
  expect(repo.getUiTask(conn2, 'uit_running0001')).toMatchObject({ status: 'failed', error: { code: 'interrupted' } })
  expect(repo.getUiTask(conn2, 'uit_queued00001')).toMatchObject({ status: 'failed', error: { code: 'interrupted' } })
  const events = repo.listEvents(conn2, dead.id).map((e) => e.event)
  expect(events).toEqual(['run_started', 'ui_input', 'ui_task', 'run_finished'])
  // and the answer of a form nobody waits on any more is refused
  expect((await json(await new Client(app).post(`/api/sessions/${session.id}/ui-inputs/${form.id}/submit`, { values: {} }), 409)).error).toBe('not_pending')
})

test('the app shutting down while a task waits on the person: the form closed interrupted, the task failed interrupted — not a Stop of the person', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const state = app.state
  const c = new Client(app)
  const session = await open(c)
  let returned: unknown = null
  const { model } = scripted([
    () => modelResponse([toolCallPart('present_ui', PANEL(), 'p1')]),
    () => modelResponse([textPart('Panel.')]),
    () => modelResponse([toolCallPart('request_input', FORM, 'w1')]),
    (m) => { returned = lastToolReturn(m, 'request_input'); return modelResponse([textPart('never')]) },
  ])
  setModel(state, 'scripted:a', model)
  const first = await state.runs.start(session, 'panel')
  await waitDone(state, first.id)
  const t = (await json(await c.post(`/api/sessions/${session.id}/ui/${first.id}/panel/tasks`, { revision: 1, action_id: 'total', state: {}, request_id: 'shut-00001' }), 202)).task as UiTaskRecord
  await until('the form', async () => (await pendingOf(c, session)).length === 1)
  const [form] = await pendingOf(c, session)
  const closing = app.close()
  app = null
  await closing
  // read back from the closed app's database file
  const reopened = connect(state.settings.db_path)
  try {
    expect(repo.getUiInput(reopened, form!.id)).toMatchObject({ status: 'closed', closed_reason: 'interrupted' })
    expect(repo.getUiTask(reopened, t.id)).toMatchObject({ status: 'failed', error: { code: 'interrupted' } })
    expect(repo.getRun(reopened, t.agent_run_id!)!.status).toBe('cancelled')
    const events = repo.listEvents(reopened, t.agent_run_id!).map((e) => e.event)
    expect(events.slice(-2)).toEqual(['ui_task', 'run_finished'])
  } finally {
    reopened.close()
  }
  expect(returned).toBeNull()
})

// -- schema ----------------------------------------------------------------------------------------------------------------

function structure(conn: Conn): Record<string, unknown> {
  const tables = conn.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name as string).sort()
  const out: Record<string, unknown> = {}
  for (const t of tables) {
    out[t] = {
      columns: conn.all(`PRAGMA table_info(${t})`).map((r) => [r.name, r.type, r.notnull, r.dflt_value, r.pk]),
      indexes: conn.all(`PRAGMA index_list(${t})`).map((r) => [r.name, r.unique]).filter(([n]) => !String(n).startsWith('sqlite_')).sort(),
    }
  }
  return out
}

/** ui_surfaces as v21 and v22 had it (before v23's scope, updated_by_run_id and the journal). */
const UI_SURFACES_V22 = `
CREATE TABLE ui_surfaces (
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  run_id      TEXT NOT NULL REFERENCES runs(id),
  surface_id  TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  spec_json   TEXT NOT NULL,
  state_json  TEXT NOT NULL DEFAULT '{}',
  model       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (session_id, run_id, surface_id)
);
CREATE INDEX ui_surfaces_by_session ON ui_surfaces(session_id, created_at);
`

test('a v21 database comes to the current schema: the tasks and the forms added, its surfaces kept (scope run), the same structure as a fresh one', () => {
  expect(SCHEMA_VERSION).toBe(38)  // v26: the session cursor; v27: the sessions' latest activity; v28: the sessions' access; v29: the sessions' task and roots; v30: SSH targets; v31: SSH connect intent; v32: CNY costs; v33: read-path indexes
  const base = tempDir()
  const fresh = connect(join(base, 'fresh', 'index.db'))
  const path = join(base, 'old', 'index.db')
  const made = connect(path)
  made.exec('DROP TABLE ui_inputs')
  made.exec('DROP TABLE ui_tasks')
  made.exec('DROP TABLE ui_publications')
  made.exec('DROP TABLE ui_surfaces')
  made.exec(UI_SURFACES_V22)
  made.exec('DROP INDEX IF EXISTS runs_read; PRAGMA user_version = 21')
  made.run("INSERT INTO projects (id, name, base_repo_path, created_at, updated_at) VALUES ('p_1','legacy','/x','t','t')")
  made.run("INSERT INTO sessions (id, project_id, title, model, created_at, updated_at) VALUES ('s_1','p_1','t','m','t','t')")
  made.run("INSERT INTO runs (id, session_id, project_id, model, user_text, status, created_at) VALUES ('run_1','s_1','p_1','m','hi','done','t')")
  made.run("INSERT INTO ui_surfaces (session_id, run_id, surface_id, revision, spec_json, state_json, model, created_at, updated_at) VALUES ('s_1','run_1','panel',1,?, '{\"amount\":3}', 'm', 't', 't')",
    [JSON.stringify(PANEL())])
  made.close()
  const migrated = connect(path)
  try {
    expect(migrated.get('PRAGMA user_version')!.user_version).toBe(38)
    expect(structure(migrated)).toEqual(structure(fresh))
    const s = structure(migrated) as Record<string, { indexes: unknown[][] }>
    expect(s.ui_tasks!.indexes).toContainEqual(['ui_tasks_by_request', 1])
    expect(s.ui_tasks!.indexes).toContainEqual(['ui_tasks_by_surface', 0])
    const kept = repo.getUiSurface(migrated, 's_1', 'run_1', 'panel')!
    expect(kept.state).toEqual({ amount: 3 })
    expect([kept.scope, kept.updated_by_run_id]).toEqual(['run', 'run_1'])
    expect((kept.spec.actions as { mode?: string }[])[0]!.mode).toBe('run')
    // the new tables take their rows; the request id is unique in a session
    const t = repo.insertUiTask(migrated, { id: 'uit_000000000001', session_id: 's_1', surface_run_id: 'run_1', surface_id: 'panel', revision: 1, action_id: 'total', request_id: 'req-000001', payload_sha: 'x', prompt: 'p', input: { a: 1 } })
    expect(t.record).toMatchObject({ status: 'queued', input: { a: 1 }, data: null, error: null })
    expect(() => repo.insertUiTask(migrated, { id: 'uit_000000000002', session_id: 's_1', surface_run_id: 'run_1', surface_id: 'panel', revision: 1, action_id: 'total', request_id: 'req-000001', payload_sha: 'x', prompt: 'p', input: null })).toThrow()
    const i = repo.insertUiInput(migrated, { session_id: 's_1', run_id: 'run_1', tool_call_id: 'c1', request: { title: 'T' } })
    expect(UiInputRecordSchema.safeParse(i).success).toBe(true)
  } finally {
    migrated.close()
    fresh.close()
  }
})
