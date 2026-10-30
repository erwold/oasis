/** In-run steering (docs/in-run-steering-design.md): the person's words sent while a run works reach its model at the
 *  run's next request boundary — after every return of the step before, word for word, once — and never by
 *  cancelling a request or a tool under way. A final answer that finds words waiting goes on in the same run; with
 *  none, the run's intake closes in the same tick. Stop, failure, the budget, a crash: what was queued ends
 *  undelivered and never enters the conversation. Zero cloud calls: every model is scripted. */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentMentionToken, steersFromEvents, type SteerRecord } from '@oasis-code/contract'
import { countTokens, ESTIMATE_FACTOR } from '../src/agent/context.ts'
import { ContextKeeper, isCompaction, PERSON_SHARE, type RequestSeam } from '../src/agent/history.ts'
import { steerHeader, steerPart } from '../src/agent/steering.ts'
import { rebuildTranscript } from '../src/agent/transcript.ts'
import * as repo from '../src/db/repo.ts'
import {
  emptyUsage, isRequest, isUserPrompt, loadValue, modelRequest, modelResponse, textPart, toolCallPart, toolReturn, userPrompt, userText,
  type ModelMessage, type ModelRequest, type ModelResponse,
} from '../src/llm/messages.ts'
import { TransportError, type ModelRequestParameters } from '../src/llm/model.ts'
import { AnthropicModel, GoogleModel, OpenAIChatModel, OpenAIResponsesModel } from '../src/llm/providers.ts'
import { ScriptedModel, scriptedModel } from '../src/llm/scripted.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import { CONNECTOR_HEADER } from '../src/api/auth.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { appState, buggyRepo, closeState, openSession, setModel, sleep, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
const closers: (() => Promise<void>)[] = []
const prior = process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS
beforeEach(() => { delete process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS })
afterEach(async () => {
  if (prior === undefined) delete process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS; else process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = prior
  if (state) await closeState(state)
  state = null
  for (const close of closers.splice(0)) await close()
})

function gate() {
  let open!: () => void
  const promise = new Promise<void>((r) => { open = r })
  return { promise, open }
}

/** What each request carried, as the provider got it (copied: the record goes on growing). */
interface Seen { messages: ModelMessage[]; tools: string; instructions: string | null }

/** A scripted route that records every request and answers it with the step at its index. */
function recording(steps: ((messages: ModelMessage[], n: number) => ModelResponse | Promise<ModelResponse>)[], seen: Seen[]) {
  return new ScriptedModel(async (messages, info) => {
    const n = seen.length
    seen.push({
      messages: JSON.parse(JSON.stringify(messages)) as ModelMessage[],
      tools: JSON.stringify(info.function_tools), instructions: (messages.findLast(isRequest) as ModelRequest | undefined)?.instructions ?? null,
    })
    const step = steps[Math.min(n, steps.length - 1)]!
    return step(messages, n)
  }, { modelName: 'scripted-a' })
}

const lastRequest = (s: Seen) => s.messages[s.messages.length - 1] as ModelRequest
const steerParts = (m: ModelRequest) => m.parts.filter((p) => isUserPrompt(p) && typeof (p as { steer_id?: unknown }).steer_id === 'string')
const occurrences = (messages: ModelMessage[], id: string) => JSON.stringify(messages).split(`"steer_id":"${id}"`).length - 1
const events = (runId: string) => repo.listEvents(state!.conn, runId)
const ok = (out: ReturnType<AppState['runs']['steer']>): SteerRecord => {
  if ('refusal' in out) throw new Error(`refused: ${out.refusal} ${out.detail}`)
  return out.steer
}
const refusalOf = (out: ReturnType<AppState['runs']['steer']>) => ('refusal' in out ? out.refusal : null)

/** Words with what a careless pipeline would change: edge whitespace, tabs, CRLF, quotes, a lone @, CJK, emoji. */
const VERBATIM = '  先别改测试 —— keep the API.\r\n\t"exact" `words` @not-a-mention 🚦 \n\n'

async function session() {
  state = await appState()
  return (await openSession(state, buggyRepo())).session
}

test('a steer sent during a step of two tool calls reaches the next request after both returns, word for word, once', async () => {
  const seen: Seen[] = []
  const g = gate()
  const entered = gate()
  const s = await session()
  setModel(state!, 'scripted:a', recording([
    async () => { entered.open(); await g.promise; return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, 'c1'), toolCallPart('read_file', { path: 'test_calc.py' }, 'c2')]) },
    () => modelResponse([textPart('I kept the API.')]),
  ], seen))
  const run = await state!.runs.start(s, 'fix add')
  await entered.promise
  const steer = ok(state!.runs.steer(run.id, VERBATIM, 'key-tools-1'))
  expect(steer.status).toBe('queued')
  g.open()
  const done = await waitDone(state!, run.id)
  expect(done.status).toBe('done')
  expect(seen).toHaveLength(2)
  // the request after the step: both returns first (every call paired), then the app's line, then the words
  const tail = lastRequest(seen[1]!)
  expect(tail.parts.map((p) => p.part_kind)).toEqual(['tool-return', 'tool-return', 'user-prompt', 'user-prompt'])
  expect(tail.parts.slice(0, 2).map((p) => (p as { tool_call_id: string }).tool_call_id)).toEqual(['c1', 'c2'])
  expect(userText(tail.parts[2] as never)).toBe(PROMPT_TEXT['app.steer'])
  expect((tail.parts[2] as { origin?: string }).origin).toBe('app')
  const words = tail.parts[3] as { content: unknown; origin?: string; steer_id?: string }
  expect(words.content).toBe(VERBATIM)
  expect(words.origin).toBe('person')
  expect(words.steer_id).toBe(steer.id)
  // what the first request carried is the second's prefix, unchanged; the tools and instructions are the same
  expect(JSON.stringify(seen[1]!.messages.slice(0, seen[0]!.messages.length))).toBe(JSON.stringify(seen[0]!.messages))
  expect(seen[1]!.tools).toBe(seen[0]!.tools)
  expect(seen[1]!.instructions).toBe(seen[0]!.instructions)
  // the events: queued while the request ran, delivered after both results and before the next words
  const evs = events(run.id)
  const at = (name: string, pred: (e: (typeof evs)[number]) => boolean = () => true) => evs.find((e) => e.event === name && pred(e))!.seq
  const delivered = steersFromEvents(evs)[0]!
  expect(delivered).toMatchObject({ id: steer.id, status: 'delivered', text: VERBATIM, request_index: 2, reason: null })
  expect(at('steer_queued')).toBeLessThan(at('tool_result'))
  const results = evs.filter((e) => e.event === 'tool_result').map((e) => e.seq)
  expect(delivered.delivered_seq!).toBeGreaterThan(Math.max(...results))
  expect(delivered.delivered_seq!).toBeLessThan(at('text_block', (e) => e.data.text === 'I kept the API.'))
  // the record keeps the words once, as sent; the transcript shows them as the person's, where they were delivered
  const history = repo.getRunHistory(state!.conn, run.id)!
  expect(occurrences(loadValue(JSON.parse(history)), steer.id)).toBe(1)
  const entries = rebuildTranscript(history, 0, 'done', [], [], state!.runs.steersOf(run.id))
  const user = entries.find((e) => e.steer_id === steer.id)!
  expect(user).toMatchObject({ kind: 'user', text: VERBATIM, seq: delivered.delivered_seq! })
  expect(entries.some((e) => e.kind === 'note' && e.text === PROMPT_TEXT['app.steer'])).toBe(false)
})

test('a steer that arrives while the final answer forms makes the run go on in the same run: both answers kept, the last one is final', async () => {
  const seen: Seen[] = []
  const g = gate()
  const entered = gate()
  const s = await session()
  setModel(state!, 'scripted:a', recording([
    async () => { entered.open(); await g.promise; return modelResponse([textPart('first answer')]) },
    () => modelResponse([textPart('second answer, with the steer')]),
  ], seen))
  const run = await state!.runs.start(s, 'explain add')
  await entered.promise
  const steer = ok(state!.runs.steer(run.id, 'also mention mul', 'key-final-1'))
  g.open()
  const done = await waitDone(state!, run.id)
  expect(done.status).toBe('done')
  expect(seen).toHaveLength(2)
  const msgs = seen[1]!.messages
  expect((msgs[msgs.length - 2] as ModelResponse).parts.map((p) => (p as { content?: unknown }).content)).toEqual(['first answer'])
  const tail = lastRequest(seen[1]!)
  expect(tail.parts.map((p) => (p as { content: unknown }).content)).toEqual([PROMPT_TEXT['app.steer'], 'also mention mul'])
  expect(done.receipt.final_text ?? (done.receipt as { final_text?: string }).final_text).toBe('second answer, with the steer')
  const texts = events(run.id).filter((e) => e.event === 'text_block').map((e) => e.data.text)
  expect(texts).toEqual(['first answer', 'second answer, with the steer'])
  expect(state!.runs.steersOf(run.id)[0]).toMatchObject({ id: steer.id, status: 'delivered', request_index: 2 })
  // no empty request was ever written into the record
  const history = loadValue(JSON.parse(repo.getRunHistory(state!.conn, run.id)!))
  expect(history.some((m) => isRequest(m) && m.parts.length === 0)).toBe(false)
})

test('a whole final answer at the end of the request budget: a steer that came while it formed ends undelivered (budget), not failed; the run stays done', async () => {
  const seen: Seen[] = []
  const g = gate()
  const entered = gate()
  const s = await session()
  setModel(state!, 'scripted:a', recording([
    async () => { entered.open(); await g.promise; return modelResponse([textPart('the only answer')]) },
    () => modelResponse([textPart('never asked')]),
  ], seen))
  const run = await state!.runs.start(s, 'explain add', { budget: { requests: 1 } })
  await entered.promise
  const steer = ok(state!.runs.steer(run.id, 'one more thing', 'budget-final-key'))
  g.open()
  const done = await waitDone(state!, run.id)
  expect(done.status).toBe('done')
  expect(seen).toHaveLength(1)
  expect(state!.runs.steersOf(run.id)[0]).toMatchObject({ id: steer.id, status: 'undelivered', reason: 'budget', delivered_seq: null })
  expect(occurrences(loadValue(JSON.parse(repo.getRunHistory(state!.conn, run.id)!)), steer.id)).toBe(0)
})

test('the intake closes in the same tick the final answer is decided: a later steer is refused run_finishing, never queued and lost', async () => {
  const s = await session()
  setModel(state!, 'scripted:a', scriptedModel(() => modelResponse([textPart('all done')])))
  const run = await state!.runs.start(s, 'say done')
  const handle = state!.runs.handles.get(run.id)!
  const refusals: (string | null)[] = []
  const close = handle.steer.close.bind(handle.steer)
  handle.steer.close = (reason: string) => { close(reason); refusals.push(refusalOf(state!.runs.steer(run.id, 'too late', `late-${refusals.length}-key`))) }
  const done = await waitDone(state!, run.id)
  expect(done.status).toBe('done')
  expect(refusals[0]).toBe('run_finishing')
  expect(state!.runs.steersOf(run.id)).toEqual([])
  expect(refusalOf(state!.runs.steer(run.id, 'after the end', 'after-end-key'))).toBe('run_not_live')
})

test('a key is one steer: the same words again answer with it (also after the run ended); other words under it are a key_conflict', async () => {
  const seen: Seen[] = []
  const g = gate()
  const entered = gate()
  const s = await session()
  setModel(state!, 'scripted:a', recording([async () => { entered.open(); await g.promise; return modelResponse([textPart('ok')]) }, () => modelResponse([textPart('ok again')])], seen))
  const run = await state!.runs.start(s, 'go')
  await entered.promise
  const first = ok(state!.runs.steer(run.id, 'one', 'same-key-1'))
  const again = ok(state!.runs.steer(run.id, 'one', 'same-key-1'))
  expect(again.id).toBe(first.id)
  expect(refusalOf(state!.runs.steer(run.id, 'two', 'same-key-1'))).toBe('key_conflict')
  const second = ok(state!.runs.steer(run.id, 'two', 'other-key-2'))
  g.open()
  await waitDone(state!, run.id)
  expect(events(run.id).filter((e) => e.event === 'steer_queued')).toHaveLength(2)
  // FIFO: both in one boundary, in the order sent
  expect(steerParts(lastRequest(seen[1]!)).map((p) => (p as { content: unknown }).content)).toEqual(['one', 'two'])
  expect(state!.runs.steersOf(run.id).map((x) => x.id)).toEqual([first.id, second.id])
  // after the end, from the stored events
  const after = ok(state!.runs.steer(run.id, 'one', 'same-key-1'))
  expect(after).toMatchObject({ id: first.id, status: 'delivered' })
  expect(refusalOf(state!.runs.steer(run.id, 'changed', 'same-key-1'))).toBe('key_conflict')
})

test('Stop: a queued steer ends undelivered (stopped) and never enters the record; a steer after the Stop is refused; Stop is unchanged', async () => {
  const s = await session()
  const entered = gate()
  setModel(state!, 'scripted:a', new ScriptedModel(async () => { entered.open(); await new Promise(() => {}); return modelResponse([textPart('never')]) }, { modelName: 'scripted-a' }))
  const run = await state!.runs.start(s, 'think long')
  await entered.promise
  const steer = ok(state!.runs.steer(run.id, 'change course', 'stop-key-1'))
  expect(state!.runs.cancel(run.id)).toBe(true)
  // the race: words sent right after the Stop are refused, not queued behind it
  expect(refusalOf(state!.runs.steer(run.id, 'and this', 'stop-key-2'))).toBe('run_finishing')
  const done = await waitDone(state!, run.id)
  expect(done.status).toBe('cancelled')
  const [record] = state!.runs.steersOf(run.id)
  expect(record).toMatchObject({ id: steer.id, status: 'undelivered', reason: 'stopped', delivered_seq: null })
  const evs = events(run.id)
  expect(evs.find((e) => e.event === 'steer_undelivered')!.seq).toBeLessThan(evs.find((e) => e.event === 'run_finished')!.seq)
  expect(repo.getRunHistory(state!.conn, run.id) ?? '').not.toContain('change course')
  expect(evs.filter((e) => e.event === 'steer_queued')).toHaveLength(1)
})

test('a transport failure after the commit: the recovery resends the record that holds the steer — the same steer_id once, never appended again', async () => {
  const seen: Seen[] = []
  const entered = gate()
  const g = gate()
  const s = await session()
  state!.runs.transport_backoff_s = [0, 0, 0]
  setModel(state!, 'scripted:a', recording([
    async () => { entered.open(); await g.promise; return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, 'c1')]) },
    () => { throw new TransportError('ReadError', 'connection reset by peer') },
    () => modelResponse([textPart('recovered')]),
  ], seen))
  const run = await state!.runs.start(s, 'read it')
  await entered.promise
  const steer = ok(state!.runs.steer(run.id, 'note this', 'net-key-1'))
  g.open()
  const done = await waitDone(state!, run.id)
  expect(done.status).toBe('done')
  expect(seen).toHaveLength(3)
  expect(occurrences(seen[1]!.messages, steer.id)).toBe(1)
  expect(occurrences(seen[2]!.messages, steer.id)).toBe(1)
  expect(events(run.id).filter((e) => e.event === 'steer_delivered')).toHaveLength(1)
  expect(occurrences(loadValue(JSON.parse(repo.getRunHistory(state!.conn, run.id)!)), steer.id)).toBe(1)
})

test('a crash: a delivered steer stands with the record that holds it; a queued one ends interrupted at startup and is not sent again', async () => {
  const entered = [gate(), gate()]
  const g = gate()
  let n = 0
  const s = await session()
  setModel(state!, 'scripted:a', new ScriptedModel(async () => {
    n += 1
    if (n === 1) { entered[0]!.open(); await g.promise; return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, 'c1')]) }
    entered[1]!.open()
    await new Promise(() => {})
    return modelResponse([textPart('never')])
  }, { modelName: 'scripted-a' }))
  const run = await state!.runs.start(s, 'read it')
  await entered[0]!.promise
  const delivered = ok(state!.runs.steer(run.id, 'first words', 'crash-key-1'))
  g.open()
  await entered[1]!.promise
  const queued = ok(state!.runs.steer(run.id, 'second words', 'crash-key-2'))
  // the process dies here: its handle is gone, its rows and events stay as they were written
  expect(repo.getRunHistory(state!.conn, run.id)).toContain('first words')
  state!.runs.handles.delete(run.id)
  await state!.runs.reconcile()
  const records = steersFromEvents(events(run.id))
  expect(records.find((r) => r.id === delivered.id)).toMatchObject({ status: 'delivered', request_index: 2 })
  expect(records.find((r) => r.id === queued.id)).toMatchObject({ status: 'undelivered', reason: 'interrupted' })
  expect(repo.getRunHistory(state!.conn, run.id)).not.toContain('second words')
  const evs = events(run.id)
  expect(evs.find((e) => e.event === 'steer_undelivered')!.seq).toBeLessThan(evs.find((e) => e.event === 'run_finished')!.seq)
})

test('the budget line: the intake closes as the closing turn begins; a queued steer ends undelivered (budget) and never joins the report', async () => {
  const seen: Seen[] = []
  const entered = gate()
  const g = gate()
  const s = await session()
  setModel(state!, 'scripted:a', recording([
    async () => { entered.open(); await g.promise; return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, 'c1')]) },
    () => modelResponse([textPart('the report')]),
  ], seen))
  const run = await state!.runs.start(s, 'read it', { budget: { tool_calls: 1 } })
  await entered.promise
  const steer = ok(state!.runs.steer(run.id, 'more work', 'budget-key-1'))
  g.open()
  await waitDone(state!, run.id)
  expect(state!.runs.steersOf(run.id)[0]).toMatchObject({ id: steer.id, status: 'undelivered', reason: 'budget' })
  for (const r of seen) expect(JSON.stringify(r.messages)).not.toContain('more work')
  expect(refusalOf(state!.runs.steer(run.id, 'more', 'budget-key-2'))).toBe('run_not_live')
})

test('every run on a conversation of its own takes steers — the thread\'s, a relay turn, a group member, a separate task; a UI task and ChatGPT on the web refuse', async () => {
  const entered = gate()
  const s = await session()
  setModel(state!, 'scripted:a', new ScriptedModel(async () => { entered.open(); await new Promise(() => {}); return modelResponse([textPart('x')]) }, { modelName: 'scripted-a' }))
  const run = await state!.runs.start(s, 'wait', { spawned_by: 'director' })
  await entered.promise
  const handle = state!.runs.handles.get(run.id)!
  // a director's dispatch on the thread and a watch's wake are the thread's runs: they take steers
  expect(state!.runs.steerRefusal(handle)).toBeNull()
  handle.wake = true
  expect(state!.runs.steerRefusal(handle)).toBeNull()
  const takes: [string, () => void, () => void][] = [
    ['relay', () => { handle.relay = { id: 'r', step: 0, note: null, harness_message: false } }, () => { handle.relay = null }],
    ['interaction', () => { handle.interaction = { id: 'i', node: 'n', note: null, harness_message: false } }, () => { handle.interaction = null }],
    ['work order', () => { handle.work_order = {} as never }, () => { handle.work_order = null }],
    ['member', () => { (handle as { participant_role: string | null }).participant_role = 'member' }, () => { (handle as { participant_role: string | null }).participant_role = null }],
  ]
  for (const [name, set, unset] of takes) { set(); expect(state!.runs.steerRefusal(handle), name).toBeNull(); unset() }
  const refuses: [string, () => void, () => void][] = [
    ['ui task', () => { handle.ui_task = 'task_1' }, () => { handle.ui_task = null }],
    ['chatgpt web', () => { (handle as { model_id: string }).model_id = 'chatgpt:web' }, () => { (handle as { model_id: string }).model_id = 'scripted:a' }],
  ]
  for (const [name, set, unset] of refuses) {
    set()
    expect(refusalOf(state!.runs.steer(run.id, 'hi', `route-${name.replace(' ', '-')}-key`)), name).toBe('not_steerable')
    unset()
  }
  expect(state!.runs.steersOf(run.id)).toEqual([])
  state!.runs.cancel(run.id)
  await waitDone(state!, run.id)
})

test("a director's words are said to be the director's: one boundary carries the person's and the director's apart, each after its own line", async () => {
  const seen: Seen[] = []
  const g = gate()
  const entered = gate()
  const s = await session()
  setModel(state!, 'scripted:a', recording([
    async () => { entered.open(); await g.promise; return modelResponse([textPart('first answer')]) },
    () => modelResponse([textPart('second answer')]),
  ], seen))
  const run = await state!.runs.start(s, 'explain add')
  await entered.promise
  const mine = ok(state!.runs.steer(run.id, 'also mention mul', 'key-mixed-1'))
  const theirs = ok(state!.runs.steer(run.id, 'and keep it short', 'key-mixed-2', 'director'))
  g.open()
  expect((await waitDone(state!, run.id)).status).toBe('done')
  const tail = lastRequest(seen[1]!)
  expect(tail.parts.map((p) => (p as { content: unknown }).content)).toEqual([PROMPT_TEXT['app.steer'], 'also mention mul', PROMPT_TEXT['app.steer_director'], 'and keep it short'])
  const [a, b] = state!.runs.steersOf(run.id)
  expect(a).toMatchObject({ id: mine.id, status: 'delivered' })
  expect(a!.by).toBeUndefined()
  expect(b).toMatchObject({ id: theirs.id, status: 'delivered', by: 'director' })
  // the transcript shows both as words sent while it worked, neither line as a note
  const entries = rebuildTranscript(repo.getRunHistory(state!.conn, run.id), 0, 'done', [], [], state!.runs.steersOf(run.id))
  expect(entries.filter((e) => e.kind === 'user' && (e as { steer_id?: string }).steer_id).map((e) => (e as { text?: string }).text)).toEqual(['also mention mul', 'and keep it short'])
  const lines: string[] = [PROMPT_TEXT['app.steer'], PROMPT_TEXT['app.steer_director']]
  expect(entries.some((e) => e.kind === 'note' && lines.includes((e as { text?: string }).text ?? ''))).toBe(false)
})

test("whose words a steer carries, the request's origin says: the person's none, the connector's its own; the body cannot name it", async () => {
  const entered = gate()
  const g = gate()
  const app = await makeApp(null, { model_overrides: { 'scripted:a': new ScriptedModel(async () => { entered.open(); await g.promise; return modelResponse([textPart('fine')]) }, { modelName: 'scripted-a' }) } })
  closers.push(() => closeState(app.state))
  const client = new Client(app)
  const { session: s } = await openSession(app.state, buggyRepo())
  const run = await app.state.runs.start(s, 'go')
  await entered.promise
  const mine = await json<{ steer: SteerRecord }>(await client.post(`/api/runs/${run.id}/steer`, { text: 'mine', client_request_id: 'k-src-0001' }))
  expect(mine.steer.by).toBeUndefined()
  expect((await client.post(`/api/runs/${run.id}/steer`, { text: 'hi', client_request_id: 'k-src-0002', by: 'director' })).status).toBe(400)
  const viaConnector = await json<{ steer: SteerRecord }>(await client.post(`/api/runs/${run.id}/steer`, { text: 'from the connector', client_request_id: 'k-src-0003' }, { [CONNECTOR_HEADER]: 'ChatGPT' }))
  expect(viaConnector.steer).toMatchObject({ text: 'from the connector', status: 'queued', by: 'connector' })
  g.open()
  await waitDone(app.state, run.id)
  expect(app.state.runs.steersOf(run.id).map((x) => [x.text, x.status, x.by ?? 'person'])).toEqual([['mine', 'delivered', 'person'], ['from the connector', 'delivered', 'connector']])
})

test("the connector's client a steer came through is its record's for good: the request names it, the body cannot; delivered, listed, read back from the events, ended by a restart", async () => {
  const entered = [gate(), gate()]
  const g = gate()
  let n = 0
  const app = await makeApp(null, { model_overrides: { 'scripted:a': new ScriptedModel(async () => {
    n += 1
    if (n === 1) { entered[0]!.open(); await g.promise; return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, 'c1')]) }
    entered[1]!.open()
    await new Promise(() => {})
    return modelResponse([textPart('never')])
  }, { modelName: 'scripted-a' }) } })
  closers.push(() => closeState(app.state))
  const client = new Client(app)
  const { session: s } = await openSession(app.state, buggyRepo())
  const run = await app.state.runs.start(s, 'go')
  await entered[0]!.promise
  // a body that names a client is refused whole (strict); the name is the request's header, nothing else
  expect((await client.post(`/api/runs/${run.id}/steer`, { text: 'hi', client_request_id: 'k-cli-0000', client: 'ChatGPT' }, { [CONNECTOR_HEADER]: 'Claude' })).status).toBe(400)
  const claude = await json<{ steer: SteerRecord }>(await client.post(`/api/runs/${run.id}/steer`, { text: 'from claude', client_request_id: 'k-cli-0001' }, { [CONNECTOR_HEADER]: 'Claude' }))
  expect(claude.steer).toMatchObject({ by: 'connector', client: 'Claude', status: 'queued' })
  const mine = await json<{ steer: SteerRecord }>(await client.post(`/api/runs/${run.id}/steer`, { text: 'mine', client_request_id: 'k-cli-0002' }))
  expect(mine.steer.client).toBeUndefined()
  // the same key again, from anywhere: the steer it made, its client as recorded
  expect((await json<{ steer: SteerRecord }>(await client.post(`/api/runs/${run.id}/steer`, { text: 'from claude', client_request_id: 'k-cli-0001' }, { [CONNECTOR_HEADER]: 'ChatGPT' }))).steer).toMatchObject({ id: claude.steer.id, client: 'Claude' })
  g.open()
  await entered[1]!.promise
  const queued = await json<{ steer: SteerRecord }>(await client.post(`/api/runs/${run.id}/steer`, { text: 'late words', client_request_id: 'k-cli-0003' }, { [CONNECTOR_HEADER]: 'ChatGPT' }))
  expect(queued.steer).toMatchObject({ client: 'ChatGPT', status: 'queued' })
  const live = (await json<{ steers: SteerRecord[] }>(await client.get(`/api/runs/${run.id}/steers`))).steers
  expect(live.map((x) => [x.text, x.status, x.client ?? null])).toEqual([['from claude', 'delivered', 'Claude'], ['mine', 'delivered', null], ['late words', 'queued', 'ChatGPT']])
  // the process dies: what is read back is the events' — and the restart ends the queued one with its client kept
  app.state.runs.handles.delete(run.id)
  await app.state.runs.reconcile()
  const read = (await json<{ steers: SteerRecord[] }>(await client.get(`/api/runs/${run.id}/steers`))).steers
  expect(read.map((x) => [x.text, x.status, x.client ?? null])).toEqual([['from claude', 'delivered', 'Claude'], ['mine', 'delivered', null], ['late words', 'undelivered', 'ChatGPT']])
  for (const e of repo.listEvents(app.state.conn, run.id).filter((e) => e.event.startsWith('steer_'))) {
    const record = (e.data as { steer: SteerRecord }).steer
    expect(record.client ?? null).toBe(record.text === 'mine' ? null : record.text === 'from claude' ? 'Claude' : 'ChatGPT')
  }
})

test('the HTTP surface: strict body, codes beside detail, steerable on the session, the list and the transcript', async () => {
  const entered = gate()
  const g = gate()
  const app = await makeApp(null, { model_overrides: { 'scripted:a': new ScriptedModel(async () => { entered.open(); await g.promise; return modelResponse([textPart('fine')]) }, { modelName: 'scripted-a' }) } })
  closers.push(() => closeState(app.state))
  const client = new Client(app)
  const { session: s } = await openSession(app.state, buggyRepo())
  const run = await app.state.runs.start(s, 'go')
  await entered.promise
  const post = (body: unknown) => client.post(`/api/runs/${run.id}/steer`, body)
  const expectCode = async (body: unknown, status: number, code: string) => {
    const out = await json<{ detail: string; code: string }>(await post(body), status)
    expect(out.code).toBe(code)
    expect(typeof out.detail).toBe('string')
  }
  await expectCode({ text: '', client_request_id: 'k-empty-1' }, 400, 'empty_text')
  await expectCode({ text: '   \n', client_request_id: 'k-empty-2' }, 400, 'empty_text')
  await expectCode({ text: 'hi', client_request_id: 'short' }, 400, 'invalid_input')
  await expectCode({ text: 'hi', client_request_id: 'k-extra-1', thinking: 'high' }, 400, 'invalid_input')
  await expectCode({ text: 'hi', client_request_id: 'k-attach-1', attachments: ['a_1'] }, 400, 'invalid_input')
  await expectCode({ text: `ask ${agentMentionToken('Claude', 'scripted:b')} too`, client_request_id: 'k-agent-1' }, 400, 'steer_agents')
  await expectCode({ text: 'x'.repeat(20_001), client_request_id: 'k-long-1' }, 400, 'invalid_input')
  expect((await client.post('/api/runs/run_000000000000/steer', { text: 'hi', client_request_id: 'k-404-0001' })).status).toBe(404)
  const detail = await json<{ active_run: { id: string; steerable: boolean } }>(await client.get(`/api/sessions/${s.id}`))
  expect(detail.active_run).toMatchObject({ id: run.id, steerable: true })
  const sent = await json<{ run_id: string; steer: SteerRecord }>(await post({ text: 'email me @ 5pm', client_request_id: 'k-ok-0001' }))
  expect(sent.run_id).toBe(run.id)
  expect(sent.steer).toMatchObject({ text: 'email me @ 5pm', status: 'queued', run_id: run.id, session_id: s.id })
  await expectCode({ text: 'other words', client_request_id: 'k-ok-0001' }, 409, 'key_conflict')
  g.open()
  await waitDone(app.state, run.id)
  const listed = await json<{ steers: SteerRecord[] }>(await client.get(`/api/runs/${run.id}/steers`))
  expect(listed.steers.map((x) => [x.id, x.status])).toEqual([[sent.steer.id, 'delivered']])
  const again = await json<{ steer: SteerRecord }>(await post({ text: 'email me @ 5pm', client_request_id: 'k-ok-0001' }))
  expect(again.steer).toMatchObject({ id: sent.steer.id, status: 'delivered' })
  await expectCode({ text: 'new words', client_request_id: 'k-late-0001' }, 409, 'run_not_live')
  const transcript = await json<{ entries: { kind: string; text?: string; steer_id?: string; seq?: number }[]; steers: SteerRecord[] }>(await client.get(`/api/runs/${run.id}/transcript`))
  expect(transcript.steers.map((x) => x.id)).toEqual([sent.steer.id])
  expect(transcript.entries.find((e) => e.steer_id === sent.steer.id)).toMatchObject({ kind: 'user', text: 'email me @ 5pm', seq: listed.steers[0]!.delivered_seq! })
})

// ---- the wire: four providers, the returns before the words ------------------------------------------------------

test('the four providers carry the step\'s returns first and the steer\'s words after, unchanged; the prefix and the tools stay as they were', () => {
  const record: SteerRecord = { id: 'st_1', run_id: 'r', session_id: 's', text: VERBATIM, client_request_id: 'k', status: 'queued', queued_at: '', queued_seq: 1, delivered_at: null, delivered_seq: null, request_index: null, reason: null }
  const before: ModelMessage[] = [
    modelRequest([userPrompt('fix add', { origin: 'person' })], 'sys'),
    modelResponse([toolCallPart('read_file', { path: 'a' }, 'c1'), toolCallPart('read_file', { path: 'b' }, 'c2')]),
  ]
  const returns = modelRequest([toolReturn('read_file', 'A', 'c1'), toolReturn('read_file', 'B', 'c2')], 'sys')
  const plain = [...before, returns]
  const steered = [...before, { ...returns, parts: [...returns.parts, steerHeader(), steerPart(record)] }]
  const params: ModelRequestParameters = { function_tools: [{ name: 'read_file', description: 'd', parameters_json_schema: { type: 'object' } }], allow_text_output: true, thinking: null }
  // Anthropic: one user turn, tool_result blocks first, then the two texts
  const anthropic = new AnthropicModel('claude-x')
  const [, a] = anthropic.mapMessages(steered, params)
  const lastA = a[a.length - 1] as { role: string; content: { type: string; text?: string }[] }
  expect(lastA.role).toBe('user')
  expect(lastA.content.map((b) => b.type)).toEqual(['tool_result', 'tool_result', 'text', 'text'])
  expect(lastA.content[3]!.text).toBe(VERBATIM)
  const [, a0] = anthropic.mapMessages(plain, params)
  expect(JSON.stringify(a.slice(0, a0.length - 1))).toBe(JSON.stringify(a0.slice(0, -1)))
  expect(JSON.stringify(anthropic.body(steered, {}, params, true).tools)).toBe(JSON.stringify(anthropic.body(plain, {}, params, true).tools))
  // OpenAI Responses: the outputs, then the user messages
  const responses = new OpenAIResponsesModel('gpt-x')
  const [, r] = responses.mapMessages(steered)
  const tailR = r.slice(-4) as { type?: string; role?: string; content?: { text: string }[] }[]
  expect(tailR.map((i) => i.type ?? i.role)).toEqual(['function_call_output', 'function_call_output', 'user', 'user'])
  expect(tailR[3]!.content![0]!.text).toBe(VERBATIM)
  expect(JSON.stringify(r.slice(0, -2))).toBe(JSON.stringify(responses.mapMessages(plain)[1]))
  // OpenAI Chat: the tool messages right after the assistant's calls, then the user messages
  const chat = new OpenAIChatModel('gpt-c')
  const c = chat.mapMessages(steered).slice(-4) as { role: string; content: unknown }[]
  expect(c.map((m) => m.role)).toEqual(['tool', 'tool', 'user', 'user'])
  expect(c[3]!.content).toBe(VERBATIM)
  // Gemini: one user content, the function responses first
  const google = new GoogleModel('gemini-x')
  const [, gm] = google.mapMessages(steered)
  const lastG = gm[gm.length - 1] as { role: string; parts: Record<string, unknown>[] }
  expect(lastG.role).toBe('user')
  expect(lastG.parts.map((p) => Object.keys(p)[0])).toEqual(['functionResponse', 'functionResponse', 'text', 'text'])
  expect(lastG.parts[3]!.text).toBe(VERBATIM)
})

// ---- compaction: the turn's words, whole ---------------------------------------------------------------------------

const PARAMS: ModelRequestParameters = { function_tools: [], allow_text_output: true, thinking: null }
const seam = (model: RequestSeam['model'], observed: RequestSeam['observed']): RequestSeam => ({ model, settings: { max_tokens: 500 }, params: PARAMS, instructions: 'sys', observed })
const asksSummary = (messages: ModelMessage[]) => {
  const last = messages[messages.length - 1]!
  return isRequest(last) && last.parts.some((p) => isUserPrompt(p) && userText(p) === PROMPT_TEXT['compaction.request'])
}

/** A steer longer than PERSON_SHARE of the keeper's threshold (the cap the opening words are held to in a copy). */
function longWords(keeper: ContextKeeper): string {
  const unit = 'Keep the public API of calc.py exactly as it is; 不要改公开接口. '
  let text = unit
  while (countTokens(text) * ESTIMATE_FACTOR < keeper.threshold * PERSON_SHARE * 1.3) text += unit
  return `${text}END-OF-STEER`
}

test('a compaction after a steer carries the turn\'s opening words and the steer whole — even past PERSON_SHARE — in the threshold and the overflow path', async () => {
  const keeper = new ContextKeeper({ window: 30_000, output_reserve: 500 })
  const words = longWords(keeper)
  const record: SteerRecord = { id: 'st_long', run_id: 'r', session_id: 's', text: words, client_request_id: 'k', status: 'delivered', queued_at: '', queued_seq: 1, delivered_at: '', delivered_seq: 2, request_index: 2, reason: null }
  const asked: ModelMessage[][] = []
  const model = scriptedModel((m) => { asked.push(m); return modelResponse([textPart('<summary>Reading calc.py and its tests.</summary>')]) })
  const messages: ModelMessage[] = [
    modelRequest([userPrompt(['App context: working folder /w', 'fix add without touching the API'], { origin: 'person', app_pieces: [0] })], 'sys'),
    modelResponse([toolCallPart('read_file', { path: 'calc.py' }, 'c1')]),
    // what a summary can take the place of: the file read before the steer (the steer itself is carried whole)
    modelRequest([toolReturn('read_file', `def add(a, b): ...\n${'x = 1\n'.repeat(1_500)}`, 'c1'), steerHeader(), steerPart(record)], 'sys'),
    modelResponse([toolCallPart('read_file', { path: 'test_calc.py' }, 'c2')]),
    modelRequest([toolReturn('read_file', 'y '.repeat(3_000), 'c2')], 'sys'),
  ]
  const frozen = JSON.stringify(messages)
  const [out, report] = await keeper.maybeCompact(messages, seam(model, { input_tokens: keeper.threshold + 100, messages: 3 }))
  expect(report!.status).toBe('compacted')
  expect(JSON.stringify(out.slice(0, messages.length))).toBe(frozen)                      // nothing sent is rewritten
  const marker = out[out.length - 1] as ModelRequest
  expect(isCompaction(marker)).toBe(true)
  const carried = marker.parts.filter((p) => (p as { steer_id?: string }).steer_id === 'st_long')
  expect(carried).toHaveLength(1)
  expect((carried[0] as { content: unknown }).content).toBe(words)                          // whole: no cut, no note
  expect(JSON.stringify(marker)).toContain('fix add without touching the API')
  // after a refusal for size: the summary request and the compaction carry the steer whole too
  keeper.recoverFromOverflow('prompt is too long')
  asked.length = 0
  const [again] = await keeper.maybeCompact(messages, seam(model, null))
  expect(asked.some((m) => JSON.stringify(m).includes(JSON.stringify(words)))).toBe(true)
  const marker2 = again[again.length - 1] as ModelRequest
  expect(marker2.parts.filter((p) => (p as { content?: unknown }).content === words)).toHaveLength(1)
})

test('words waiting for the request count toward the compaction decision: pending steers alone can call for room', async () => {
  const keeper = new ContextKeeper({ window: 30_000, output_reserve: 500 })
  const words = longWords(keeper)
  const model = scriptedModel(() => modelResponse([textPart('<summary>s</summary>')]))
  const messages: ModelMessage[] = [modelRequest([userPrompt('go', { origin: 'person' })], 'sys'), modelResponse([toolCallPart('read_file', { path: 'a' }, 'c1')]), modelRequest([toolReturn('read_file', 'z '.repeat(9_000), 'c1')], 'sys')]
  const record: SteerRecord = { id: 'st_p', run_id: 'r', session_id: 's', text: words.repeat(3), client_request_id: 'k', status: 'queued', queued_at: '', queued_seq: 1, delivered_at: null, delivered_seq: null, request_index: null, reason: null }
  const [, without] = await keeper.maybeCompact(messages, seam(model, null))
  expect(without).toBeNull()
  const [, withPending] = await keeper.maybeCompact(messages, seam(model, null), [steerHeader(), steerPart(record)])
  expect(withPending?.status).toBe('compacted')
})

test('through the runner: a steer queued before a compaction and one that arrives while its summary is written both go whole after the compaction', async () => {
  process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = '38000'                                // threshold 14 000, the route's output cap 16 000
  state = await appState({ sandbox: true })
  const { session: s, ws } = await openSession(state, buggyRepo())
  writeFileSync(join(ws.path, 'big1.txt'), 'BIGLINE some large tool output near the line, and a little more of it\n'.repeat(1_400))
  const keeperThreshold = 14_000
  const longer = 'Do not edit test_calc.py; 保持测试不变. '.repeat(Math.ceil((keeperThreshold * PERSON_SHARE * 1.2 * 4) / 40))
  const seen: Seen[] = []
  const entered = gate()
  const g = gate()
  let midSummary: SteerRecord | null = null
  let runId = ''
  setModel(state, 'scripted:a', new ScriptedModel(async (m, info) => {
    seen.push({ messages: JSON.parse(JSON.stringify(m)) as ModelMessage[], tools: JSON.stringify(info.function_tools), instructions: null })
    const usage = { ...emptyUsage(), input_tokens: Math.ceil(JSON.stringify(m).length / 4), output_tokens: 10 }
    if (asksSummary(m)) {
      midSummary = ok(state!.runs.steer(runId, 'arrived during the summary', 'mid-summary-key'))
      await sleep(5)
      return modelResponse([textPart('<summary>big1.txt was read.</summary>')], { usage })
    }
    if (seen.length === 1) { entered.open(); await g.promise; return modelResponse([toolCallPart('read_file', { path: 'big1.txt' }, 'b1')], { usage }) }
    return modelResponse([textPart('done')], { usage })
  }, { modelName: 'scripted-a', usage: emptyUsage() }))
  const run = await state.runs.start(s, 'read big1')
  runId = run.id
  await entered.promise
  const early = ok(state.runs.steer(run.id, longer, 'early-key-0001'))
  g.open()
  const done = await waitDone(state, run.id)
  expect(done.status).toBe('done')
  expect(events(run.id).filter((e) => e.event === 'context_compacted').map((e) => e.data.status)).toContain('compacted')
  const after = seen.findLast((x) => !asksSummary(x.messages))!
  const tail = after.messages[after.messages.length - 1] as ModelRequest
  expect(isCompaction(tail)).toBe(true)
  const contents = steerParts(tail).map((p) => (p as { content: unknown }).content)
  expect(contents).toEqual([longer, 'arrived during the summary'])
  const records = state.runs.steersOf(run.id)
  expect(records.map((r) => [r.id, r.status])).toEqual([[early.id, 'delivered'], [midSummary!.id, 'delivered']])
  // the summary request itself never carried words that were not yet delivered
  for (const x of seen.filter((y) => asksSummary(y.messages))) expect(JSON.stringify(x.messages)).not.toContain('arrived during the summary')
})

test('words that cannot fit the window are never cut: left in order for the next boundary, then refused (context) once a compaction counted them', async () => {
  const entered = gate()
  const s = await session()
  setModel(state!, 'scripted:a', new ScriptedModel(async () => { entered.open(); await new Promise(() => {}); return modelResponse([textPart('x')]) }, { modelName: 'scripted-a' }))
  const run = await state!.runs.start(s, 'wait')
  await entered.promise
  const handle = state!.runs.handles.get(run.id)!
  const keeper = new ContextKeeper({ window: 4_000, output_reserve: 500 })
  const commits: ModelMessage[][] = []
  type Port = { pending(): boolean; peek(): unknown[]; deliver(m: ModelMessage[], s: RequestSeam, must: boolean): ModelMessage[] }
  const port = (state!.runs as unknown as { steeringPort: (...a: unknown[]) => Port }).steeringPort(handle, keeper, (out: ModelMessage[], write: () => void) => { commits.push(out); write() }, () => 7)
  const big = ok(state!.runs.steer(run.id, 'too long for the window. '.repeat(800), 'ctx-key-0001'))
  const small = ok(state!.runs.steer(run.id, 'short and after it', 'ctx-key-0002'))
  const messages: ModelMessage[] = [modelRequest([userPrompt('go', { origin: 'person' })], 'sys')]
  const sm = seam(scriptedModel(() => modelResponse([textPart('s')])), null)
  // not counted by a compaction yet: both wait, in order (the small one never jumps the queue)
  expect(port.deliver(messages, sm, false)).toBe(messages)
  expect(state!.runs.steersOf(run.id).map((x) => x.status)).toEqual(['queued', 'queued'])
  // counted (peeked) and still too big: refused whole, the next one goes
  port.peek()
  const out = port.deliver(messages, sm, false)
  expect(commits).toHaveLength(1)
  expect(steerParts(out[out.length - 1] as ModelRequest).map((p) => (p as { content: unknown }).content)).toEqual(['short and after it'])
  const records = state!.runs.steersOf(run.id)
  expect(records.find((r) => r.id === big.id)).toMatchObject({ status: 'undelivered', reason: 'context' })
  expect(records.find((r) => r.id === small.id)).toMatchObject({ status: 'delivered', request_index: 7 })
  expect(JSON.stringify(out)).not.toContain('too long for the window')
  state!.runs.cancel(run.id)
  await waitDone(state!, run.id)
})
