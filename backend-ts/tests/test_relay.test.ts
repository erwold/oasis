/** The relay: one message to several agents who take turns on it. What is pinned here: the order (a later turn
 *  starts only after the earlier run is finished and written), what the later agent actually receives at its
 *  provider's boundary (its own conversation from the relay's base; the earlier agent's answer, one line per tool
 *  call and the measured facts as a packet in its own message — never the earlier agent's raw tool results or
 *  reasoning), that a participant's later turn continues its own earlier one, that nothing follows a stop, a
 *  failure, a budget line, a turn waiting for the person, or a restart; the idempotency key; the rounds; the
 *  checks before anything starts; and that a message to one model is a run as before. */

import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentMentionToken } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { isRequest, isResponse, isText, isUserPrompt, loadValue, modelResponse, textPart, toolCallPart, toolReturns, userTexts, type ModelMessage } from '../src/llm/messages.ts'
import { ModelHTTPError } from '../src/llm/model.ts'
import { stampedModel } from '../src/llm/scripted.ts'
import type { App } from '../src/main.ts'
import { applySessionMode } from '../src/policy/modes.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, sleep, testSettings, waitDone, type AppState } from './harness.ts'
import { rec } from './tree_helpers.ts'

let app: App | null = null
let state: AppState | null = null
let release: () => void = () => {}
afterEach(async () => {
  release()
  if (app) await app.close()
  if (state) await closeState(state)
  app = null; state = null
})

const A = 'scripted:a'
const B = 'scripted:b'
const MARKER = 'RELAY_MARKER_7f3a'
const TEXT = `测试衣物模拟的方案，${agentMentionToken('Scripted A', A)} 来执行，${agentMentionToken('Scripted B', B)} 来监督并给予反馈`
const userPrompts = (messages: ModelMessage[]) => messages.filter(isRequest).flatMap((m) => m.parts).filter(isUserPrompt).map((p) => (typeof p.content === 'string' ? p.content : p.content.filter((c): c is string => typeof c === 'string').join('\n')))
const responseTexts = (messages: ModelMessage[]) => messages.filter(isResponse).flatMap((m) => m.parts).filter(isText).map((p) => p.content)

/** The executor: reads calc.py, answers with a marker the reviewer must see. */
function executorScript() {
  return (messages: ModelMessage[]) => {
    if (!toolReturns(messages).some((p) => p.tool_name === 'read_file')) return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, '')])
    return modelResponse([textPart(`${MARKER}: add() subtracts — calc.py line 2 says \`return a - b\`.`)])
  }
}

/** The reviewer: says what it was handed at its provider's boundary (A's answer and A's read of calc.py as a
 *  packet line in its own message), and keeps the messages for the test. */
function reviewerScript(seen: { messages: ModelMessage[] | null; aRow: ReturnType<typeof repo.getRun> }, conn: () => AppState['conn'], aRunId: () => string) {
  return (messages: ModelMessage[]) => {
    seen.messages = messages
    seen.aRow = repo.getRun(conn(), aRunId())
    const prompts = userPrompts(messages)
    const marker = prompts.some((t) => t.includes(MARKER))
    const read = prompts.some((t) => t.includes('[read_file calc.py → ok'))
    return modelResponse([textPart(marker && read ? 'REVIEW_CONTEXT_OK: Scripted A read calc.py and found the bug; change a - b to a + b.' : `REVIEW_CONTEXT_MISSING: marker ${marker} read ${read}`)])
  }
}

async function relaySession(models: Record<string, ReturnType<typeof scriptedModel>>) {
  app = await makeApp()
  for (const [id, model] of Object.entries(models)) setModel(app.state, id, model)
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'relay' }))
  return { c, session: session.id as string, project: project.id as string }
}

/** Wait until the relay reaches one of the statuses (its turns finished in between). */
async function waitRelay(st: AppState, relayId: string, statuses: string[], timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const relay = repo.getRelay(st.conn, relayId)!
    if (statuses.includes(relay.status)) {
      for (const step of relay.steps) if (step.run_id && st.runs.handles.get(step.run_id) && !st.runs.handles.get(step.run_id)!.done) await waitDone(st, step.run_id)
      return repo.getRelay(st.conn, relayId)!
    }
    if (Date.now() > end) throw new Error(`relay ${relayId} is ${relay.status} (${relay.reason ?? ''}), not ${statuses.join('|')}`)
    await sleep(20)
  }
}

test('A then B: B starts after A is finished and written, and reads A\'s answer and its tool-call lines in its own message — never A\'s raw tool results', async () => {
  const seen: { messages: ModelMessage[] | null; aRow: ReturnType<typeof repo.getRun> } = { messages: null, aRow: null }
  let aRunId = ''
  const models = {
    [A]: stampedModel(executorScript(), 'anthropic', 'claude-x'),
    [B]: stampedModel(reviewerScript(seen, () => app!.state.conn, () => aRunId), 'openai', 'gpt-y'),
  }
  const { c, session } = await relaySession(models)
  const before = (await json(await c.get(`/api/sessions/${session}`))).model as string
  const first = await json(await c.post(`/api/sessions/${session}/chat`, { text: TEXT, agents: [{ model: A }, { model: B }], client_request_id: 'relay-0001-first' }))
  aRunId = first.id as string
  expect(first.model).toBe(A)
  expect(first.relay_id).toStartWith('relay_')
  expect(first.relay_step).toBe(0)
  expect(first.user_text).toBe(TEXT)                                                   // the person's words, once, as written
  // the session lists the relay with its plan: two turns, the first running
  const detail = await json(await c.get(`/api/sessions/${session}`))
  const listed = (detail.relays as Record<string, unknown>[])[0]!
  expect(listed.id).toBe(first.relay_id)
  expect((listed.participants as Record<string, unknown>[]).map((p) => [p.model, p.label, p.id])).toEqual([[A, 'Scripted A', 'A'], [B, 'Scripted B', 'B']])
  expect((listed.steps as Record<string, unknown>[]).map((s) => s.status)).toEqual(['running', 'queued'])
  const relay = await waitRelay(app!.state, first.relay_id as string, ['done', 'error', 'cancelled'])
  expect(relay.status).toBe('done')
  expect(relay.reason).toBeNull()
  expect(relay.finished_at).not.toBeNull()
  expect(relay.steps.map((s) => s.status)).toEqual(['done', 'done'])
  const [aRun, bRun] = relay.steps.map((s) => repo.getRun(app!.state.conn, s.run_id!)!)
  expect(aRun!.id).toBe(aRunId)
  expect(bRun!.model).toBe(B)
  expect(bRun!.relay_step).toBe(1)
  expect(bRun!.resumes_run_id).toBeNull()                                              // B's own conversation, from the relay's base (none here)
  expect(bRun!.status).toBe('done')
  expect((bRun!.receipt.final_text as string)).toStartWith('REVIEW_CONTEXT_OK')
  // B started after A had ended and its row was written: when B's model was asked, A was done with its history and receipt on disk
  expect(seen.aRow!.status).toBe('done')
  expect(seen.aRow!.finished_at).not.toBeNull()
  expect(Object.keys(seen.aRow!.receipt).length).toBeGreaterThan(0)
  expect(repo.getRunHistory(app!.state.conn, aRun!.id)).toContain(MARKER)
  expect(bRun!.created_at >= aRun!.finished_at!).toBe(true)
  // what B was handed: its own conversation — one message of the harness's: the roster, the turn note, the person's
  // request as written, and A's turn as a packet (A's answer, one line per tool call, the measured facts); nothing
  // of A's raw tool results or words as messages
  const msgs = seen.messages!
  expect(toolReturns(msgs)).toHaveLength(0)
  expect(responseTexts(msgs)).toHaveLength(0)
  expect(msgs).toHaveLength(1)
  const prompts = userPrompts(msgs)
  const opening = prompts.join('\n')
  expect(opening).toContain('Participants:\nA: Scripted A (scripted:a)\nB: Scripted B (scripted:b)\nSpeaking order: A, B.')   // the roster, once; no roles
  expect(opening).toContain('App note:\nTurn 2 of 2. Speaker: B.\nEarlier turns: A.\nNext speaker: none.')
  expect(opening).toContain("The user's request:\n测试衣物模拟的方案，@A 来执行，@B 来监督并给予反馈")   // the person's words, as written, the agents by the letters the roster explains
  expect(opening).not.toMatch(/executor|reviewer|User request:/)
  expect(opening).toContain(`Turn 1 (A, run ${aRun!.id}):`)
  expect(opening).toContain(MARKER)                                                   // A's answer, as A wrote it
  expect(opening).toMatch(/Tool calls \(1;[^\n]*\n\[read_file calc\.py → ok/)              // A's read, as a line with the ids that read it again
  expect(opening).toContain('Measured: status done; 1 tool call(s).')                  // a count of nothing is left out
  expect(opening).not.toContain('def add(')                                           // A's raw tool result (the file) is not copied
  expect(bRun!.user_text).toStartWith('App note:\nTurn 2 of 2. Speaker: B.')          // B's row holds the harness's message, so the thread can show it as such
  expect(opening).toContain(bRun!.user_text)
  // A's own message carried the roster and the person's words as before
  const aHistory = loadValue(JSON.parse(repo.getRunHistory(app!.state.conn, aRun!.id)!))
  const aOpening = userPrompts(aHistory)[0]!
  expect(aOpening).toContain('App note:\nTurn 1 of 2. Speaker: A.\nEarlier turns: none.\nNext speaker: B.')
  expect(aOpening).toEndWith('测试衣物模拟的方案，@A 来执行，@B 来监督并给予反馈')
  // the session's own model is untouched by the turns; the thread lists both runs in order
  const after = await json(await c.get(`/api/sessions/${session}`))
  expect(after.model).toBe(before)
  expect((after.runs as Record<string, unknown>[]).map((r) => [r.model, r.relay_step])).toEqual([[A, 0], [B, 1]])
  expect((await json(await c.get(`/api/relays/${relay.id}`))).live).toBe(false)
  expect(((await json(await c.get(`/api/sessions/${session}/relays`))).relays as unknown[]).length).toBe(1)
})

test('Stop stops the whole chain: A is cancelled, B never starts; the relay says so', async () => {
  const held = new Promise<void>((resolve) => { release = resolve })
  const bCalls = { n: 0 }
  const { c, session } = await relaySession({
    [A]: scriptedModel(async (_m, info) => { await held; if (info.model_settings) { /* released by the test */ } return modelResponse([textPart('never')]) }),
    [B]: scriptedModel(() => { bCalls.n += 1; return modelResponse([textPart('never')]) }),
  })
  const first = await json(await c.post(`/api/sessions/${session}/chat`, { text: TEXT, agents: [{ model: A }, { model: B }] }))
  expect((await json(await c.get(`/api/relays/${first.relay_id}`))).live).toBe(true)
  const stopped = await json(await c.post(`/api/relays/${first.relay_id}/cancel`))
  expect(stopped.cancelled).toBe(true)
  await waitDone(app!.state, first.id as string)
  const relay = await waitRelay(app!.state, first.relay_id as string, ['cancelled'])
  expect(relay.status).toBe('cancelled')
  expect(relay.reason).toContain("stopped by the person during Scripted A's turn")
  expect(relay.steps.map((s) => s.status)).toEqual(['cancelled', 'queued'])
  expect(repo.getRun(app!.state.conn, first.id as string)!.status).toBe('cancelled')
  await sleep(50)
  expect(bCalls.n).toBe(0)
  expect(repo.listRunsOfRelay(app!.state.conn, first.relay_id as string)).toHaveLength(1)
  // a cancelled relay is over: not continued, not stopped again
  await json(await c.post(`/api/relays/${first.relay_id}/continue`), 409)
  expect((await json(await c.post(`/api/relays/${first.relay_id}/cancel`))).cancelled).toBe(false)
})

test('a turn that fails, or runs out of budget, ends the chain; the next agent never starts', async () => {
  const bCalls = { n: 0 }
  const { c, session } = await relaySession({
    [A]: scriptedModel(() => { throw new ModelHTTPError(500, 'scripted-a', { error: { message: 'boom' } }) }),
    [B]: scriptedModel(() => { bCalls.n += 1; return modelResponse([textPart('never')]) }),
  })
  app!.state.runs.outage_backoff_s = [0.01]
  const first = await json(await c.post(`/api/sessions/${session}/chat`, { text: TEXT, agents: [{ model: A }, { model: B }] }))
  const relay = await waitRelay(app!.state, first.relay_id as string, ['error', 'done'], 60_000)
  expect(relay.status).toBe('error')
  expect(relay.reason).toContain("Scripted A's turn failed")
  expect(relay.steps.map((s) => s.status)).toEqual(['error', 'queued'])
  expect(bCalls.n).toBe(0)
  // the budget line: a hard stop of A's turn is the chain's end too
  setModel(app!.state, A, scriptedModel(async () => { await sleep(3000); return modelResponse([textPart('too late')]) }))
  const second = await json(await c.post(`/api/sessions/${session}/chat`, { text: TEXT, agents: [{ model: A }, { model: B }], budget: { wall_clock_s: 1 } }))
  const relay2 = await waitRelay(app!.state, second.relay_id as string, ['error', 'done'], 60_000)
  expect(relay2.status).toBe('error')
  expect(relay2.reason).toContain('budget_exceeded')
  expect(bCalls.n).toBe(0)
})

test("a turn that ends waiting for the person's decision does not count as done: the chain waits, then continues on the person's word", async () => {
  const seenB: string[] = []
  const { c, session, project } = await relaySession({
    [A]: scriptedModel((messages: ModelMessage[]) => {
      const prompts = userPrompts(messages)
      if (prompts.some((t) => t.includes('Continue turn 1 as A.'))) return modelResponse([textPart('A_DONE_AFTER_APPROVAL: the note is written.')])
      if (!toolReturns(messages).some((p) => p.tool_name === 'write_file')) return modelResponse([toolCallPart('write_file', { path: 'NOTES.md', content: 'reviewed before written\n' }, '')])
      return modelResponse([textPart('The note waits for your approval.')])
    }),
    [B]: scriptedModel((messages: ModelMessage[]) => { seenB.push(userPrompts(messages).at(-1)!); return modelResponse([textPart('B reviewed')]) }),
  })
  applySessionMode(app!.state.conn, repo.getSession(app!.state.conn, session)!, 'approve')
  const first = await json(await c.post(`/api/sessions/${session}/chat`, { text: TEXT, agents: [{ model: A }, { model: B }] }))
  const relay = await waitRelay(app!.state, first.relay_id as string, ['waiting', 'done', 'error'])
  expect(relay.status).toBe('waiting')
  expect(relay.reason).toContain("Scripted A's turn ended waiting for your decision on 1 proposed action")
  expect(relay.steps.map((s) => s.status)).toEqual(['waiting', 'queued'])
  expect(seenB).toHaveLength(0)
  // not continued while the decision is pending
  const refused = await json(await c.post(`/api/relays/${relay.id}/continue`), 409)
  expect(refused.detail).toContain('still waits for your decision')
  const proposals = await json(await c.get(`/api/sessions/${session}/action-proposals`))
  const pending = (proposals.proposals as Record<string, unknown>[]).find((p) => p.status === 'pending')!
  await json(await c.post(`/api/action-proposals/${pending.proposal_asset_id}/decide`, { decision: 'approve', reason: 'fine' }))
  expect(repo.getProject(app!.state.conn, project)).not.toBeNull()
  const continued = await json(await c.post(`/api/relays/${relay.id}/continue`))
  expect(continued.status).toBe('running')
  expect(continued.current_step).toBe(0)                                                // A again, on its own record
  const done = await waitRelay(app!.state, relay.id, ['done', 'error', 'waiting'])
  expect(done.status).toBe('done')
  expect(done.steps[0]!.run_ids).toHaveLength(2)
  expect(done.steps[0]!.run_id).toBe(done.steps[0]!.run_ids[1]!)
  const rerun = repo.getRun(app!.state.conn, done.steps[0]!.run_id!)!
  expect(rerun.resumes_run_id).toBe(first.id as string)
  expect(rerun.user_text).toBe('App note: Continue turn 1 as A.')                      // the same turn, the same speaker; no invented request
  const rerunPrompt = userTexts(loadValue(JSON.parse(repo.getRunHistory(app!.state.conn, rerun.id)!))).find((t) => t.includes('Continue turn 1 as A.'))!
  expect(rerunPrompt).toMatch(/Proposal a_[0-9a-f]+: completed\. Result: .*Do not repeat the call\./)   // the decision, as the proposal's own state line
  expect(rerun.receipt.final_text).toContain('A_DONE_AFTER_APPROVAL')
  expect(seenB).toHaveLength(1)
  expect(seenB[0]).toContain('Turn 2 of 2. Speaker: B.\nEarlier turns: A.')
  expect(seenB[0]).toContain('A_DONE_AFTER_APPROVAL')                                   // A's answer after the approval, in the packet B is handed
})

test('the same key again is the same relay and the same first run; a message to one agent is a run on that model, no relay', async () => {
  const held = new Promise<void>((resolve) => { release = resolve })
  const { c, session } = await relaySession({
    [A]: scriptedModel(async () => { await held; return modelResponse([textPart('A done')]) }),
    [B]: scriptedModel(() => modelResponse([textPart('B done')])),
  })
  const body = { text: TEXT, agents: [{ model: A }, { model: B }], client_request_id: 'relay-0002-resend' }
  const [x, y] = await Promise.all([c.post(`/api/sessions/${session}/chat`, body), c.post(`/api/sessions/${session}/chat`, body)])
  const [first, again] = [await json(x), await json(y)]
  expect(again.id).toBe(first.id)
  expect(again.relay_id).toBe(first.relay_id)
  expect(repo.listRelays(app!.state.conn, session)).toHaveLength(1)
  expect((await json(await c.post(`/api/sessions/${session}/chat`, body))).id).toBe(first.id)
  // a different message while the chain runs is refused as before
  expect((await c.post(`/api/sessions/${session}/chat`, { text: 'another', agents: [{ model: A }, { model: B }] })).status).toBe(409)
  release()
  await waitRelay(app!.state, first.relay_id as string, ['done'])
  expect((await json(await c.post(`/api/sessions/${session}/chat`, body))).id).toBe(first.id)          // and after it ended
  expect(repo.listRelays(app!.state.conn, session)).toHaveLength(1)
  // one agent named: the run's model, no relay row, the session's model as before
  const one = await json(await c.post(`/api/sessions/${session}/chat`, { text: `${agentMentionToken('Scripted B', B)} say hi`, agents: [{ model: B }] }))
  expect(one.model).toBe(B)
  expect(one.relay_id).toBeNull()
  await waitDone(app!.state, one.id as string)
  expect(repo.listRelays(app!.state.conn, session)).toHaveLength(1)
  const plain = await json(await c.post(`/api/sessions/${session}/chat`, { text: 'plain words' }))
  expect(plain.relay_id).toBeNull()
  expect(plain.relay_step).toBeNull()
  await waitDone(app!.state, plain.id as string)
})

test('every participant is checked before anything starts: an unknown route, a route without a credential, a route that takes no images', async () => {
  const { c, session } = await relaySession({ [A]: scriptedModel(() => modelResponse([textPart('A')])) })
  expect((await json(await c.post(`/api/sessions/${session}/chat`, { text: TEXT, agents: [{ model: A }, { model: 'nope:x' }] }), 400)).detail).toContain('unknown model: nope:x')
  // scripted:b is configured but has no key in this process and no test override
  expect((await json(await c.post(`/api/sessions/${session}/chat`, { text: TEXT, agents: [{ model: A }, { model: B }] }), 400)).detail).toContain('Scripted B has no credential here')
  expect((await json(await c.post(`/api/sessions/${session}/chat`, { text: TEXT, agents: [{ model: A }], rounds: 9 }), 422)).detail).toContain('rounds')
  setModel(app!.state, B, scriptedModel(() => modelResponse([textPart('B')])))
  const png = readFileSync(join(import.meta.dir, 'fixtures', 'images', 'red-7x5.png'))
  const uploaded = await json(await app!.app.request(`http://localhost/api/sessions/${session}/attachments?name=red.png`, { method: 'POST', body: png, headers: { ...c.headers, 'content-type': 'application/octet-stream' } }))
  const refused = await json(await c.post(`/api/sessions/${session}/chat`, { text: TEXT, agents: [{ model: A }, { model: B }], attachments: [uploaded.asset_id] }), 400)
  expect(refused.detail).toContain('is not configured to take images')
  expect(repo.listRelays(app!.state.conn, session)).toHaveLength(0)
  expect(repo.listRuns(app!.state.conn, session)).toHaveLength(0)
})

test('a restart interrupts a running relay; the person continues it: the next turn starts, or the cut-off turn carries on', async () => {
  const settings = testSettings()
  let started!: () => void
  const startedPromise = new Promise<void>((r) => { started = r })
  state = await appState({ settings, models: {
    [A]: scriptedModel(async () => { started(); await sleep(3_600_000); return modelResponse([textPart('never')]) }),
    [B]: scriptedModel(() => modelResponse([textPart('B done')])),
  } })
  const { session } = await openSession(state, buggyRepo())
  const plan = state.relays.plan([{ model: A }, { model: B }], 1, [])
  const { relay, run } = await state.relays.start(session, { text: TEXT, plan, mentions: [], attachments: [], thinking: null, budget: null, client_request_id: null })
  await startedPromise
  // the process dies during A's turn
  const dead = state
  state = null
  dead.runs.handles.get(run.id)!.done = true
  dead.conn.close()
  state = await appState({ settings, models: {
    [A]: scriptedModel((messages: ModelMessage[]) => modelResponse([textPart(userPrompts(messages).at(-1)!.includes('Continue turn 1 as A.') ? 'A carried on after the restart' : 'A fresh')])),
    [B]: scriptedModel((messages: ModelMessage[]) => modelResponse([textPart(userPrompts(messages).some((t) => t.includes('carried on')) ? 'B saw A carry on' : 'B saw nothing')])),
  } })
  await state.runs.reconcile()
  const counts = state.relays.reconcile()
  expect(counts.interrupted).toEqual([relay.id])
  const interrupted = repo.getRelay(state.conn, relay.id)!
  expect(interrupted.status).toBe('interrupted')
  expect(interrupted.reason).toContain("Scripted A's turn was cut off by a restart")
  expect(interrupted.steps.map((s) => s.status)).toEqual(['error', 'queued'])
  expect(repo.listRunsOfRelay(state.conn, relay.id)).toHaveLength(1)                   // nothing started on its own
  const continued = await state.relays.continue(relay.id)
  expect(continued.status).toBe('running')
  expect(continued.steps[0]!.run_ids).toHaveLength(2)
  const done = await waitRelay(state, relay.id, ['done', 'error'])
  expect(done.status).toBe('done')
  expect(repo.getRun(state.conn, done.steps[0]!.run_id!)!.receipt.final_text).toBe('A carried on after the restart')
  expect(repo.getRun(state.conn, done.steps[1]!.run_id!)!.receipt.final_text).toBe('B saw A carry on')
  dead.runs.handles.get(run.id)!.token.cancel()

  // the process dies between A's end and B's start: the relay is interrupted, continue starts B
  const settings2 = testSettings()
  const st2 = await appState({ settings: settings2, models: { [A]: scriptedModel(() => modelResponse([textPart('A done')])), [B]: scriptedModel(() => modelResponse([textPart('B done')])) } })
  const opened = await openSession(st2, buggyRepo())
  const r2 = await st2.relays.start(opened.session, { text: TEXT, plan, mentions: [], attachments: [], thinking: null, budget: null, client_request_id: null })
  await waitDone(st2, r2.run.id)
  await waitRelay(st2, r2.relay.id, ['done'])
  // rewind the record to the moment between the turns: A done, B never started
  const rewound = repo.getRelay(st2.conn, r2.relay.id)!
  for (const table of ['run_events', 'model_requests', 'executions', 'checkpoints', 'checks']) st2.conn.run(`DELETE FROM ${table} WHERE run_id=?`, [rewound.steps[1]!.run_id!])
  st2.conn.run('DELETE FROM runs WHERE id=?', [rewound.steps[1]!.run_id!])
  repo.updateRelay(st2.conn, rewound.id, { status: 'running', steps: rewound.steps.map((s, i) => (i === 1 ? { ...s, status: 'queued', run_id: null, run_ids: [] } : s)), current_step: 0, finished_at: null })
  st2.conn.close()
  const st3 = await appState({ settings: settings2, models: { [A]: scriptedModel(() => modelResponse([textPart('A again?')])), [B]: scriptedModel(() => modelResponse([textPart('B done later')])) } })
  try {
    await st3.runs.reconcile()
    expect(st3.relays.reconcile().interrupted).toEqual([rewound.id])
    const between = repo.getRelay(st3.conn, rewound.id)!
    expect(between.status).toBe('interrupted')
    expect(between.reason).toContain("restarted before Scripted B's turn started")
    await st3.relays.continue(rewound.id)
    const finished = await waitRelay(st3, rewound.id, ['done', 'error'])
    expect(finished.status).toBe('done')
    expect(repo.listRunsOfRelay(st3.conn, rewound.id).map((r) => r.receipt.final_text)).toEqual(['A done', 'B done later'])
  } finally { await closeState(st3) }
})

test('rounds: with two, A speaks again after B, on the conversation as it stands; a finished relay gets one more round on request, never past the line', async () => {
  const prompts: Record<string, string[]> = { a: [], b: [] }
  const { c, session } = await relaySession({
    [A]: scriptedModel((messages: ModelMessage[]) => { prompts.a.push(userPrompts(messages).at(-1)!); return modelResponse([textPart(`A speaks (turn ${prompts.a.length})`)]) }),
    [B]: scriptedModel((messages: ModelMessage[]) => { prompts.b.push(userPrompts(messages).at(-1)!); return modelResponse([textPart(`B_FEEDBACK_${prompts.b.length}: do better`)]) }),
  })
  const first = await json(await c.post(`/api/sessions/${session}/chat`, { text: TEXT, agents: [{ model: A }, { model: B }], rounds: 2 }))
  const relay = await waitRelay(app!.state, first.relay_id as string, ['done', 'error'])
  expect(relay.status).toBe('done')
  expect(relay.rounds).toBe(2)
  expect(relay.round).toBe(2)
  expect(relay.steps.map((s) => [s.round, s.participant, s.status])).toEqual([[1, 0, 'done'], [1, 1, 'done'], [2, 0, 'done'], [2, 1, 'done']])
  const runs = repo.listRunsOfRelay(app!.state.conn, relay.id)
  expect(runs.map((r) => r.model)).toEqual([A, B, A, B])
  expect(runs[2]!.resumes_run_id).toBe(runs[0]!.id)                                    // A's second turn continues A's own first
  expect(runs[3]!.resumes_run_id).toBe(runs[1]!.id)
  expect(prompts.a[1]).toContain('Turn 3 of 4. Speaker: A.\nEarlier turns: A, B.\nNext speaker: B.')
  expect(prompts.a[1]).toContain('B_FEEDBACK_1')                                       // B's turn reaches A as a packet in A's message
  expect(prompts.a[1]).not.toContain("The user's request:")                            // A had the request in its first turn
  expect(prompts.b[1]).toContain('Turn 4 of 4. Speaker: B.\nEarlier turns: A, B, A.\nNext speaker: none.')
  expect(prompts.b[1]).toContain('A speaks (turn 2)')
  expect(prompts.b[1]).not.toContain('A speaks (turn 1)')                              // only the turns since B last spoke
  // one more round on request
  const more = await json(await c.post(`/api/relays/${relay.id}/continue`, {}))
  expect(more.status).toBe('running')
  expect(more.rounds).toBe(3)
  expect((more.steps as unknown[]).length).toBe(6)
  const again = await waitRelay(app!.state, relay.id, ['done', 'error'])
  expect(again.status).toBe('done')
  expect(repo.listRunsOfRelay(app!.state.conn, relay.id)).toHaveLength(6)
  // the line: five rounds in all
  expect((await json(await c.post(`/api/relays/${relay.id}/continue`, { rounds: 3 }), 400)).detail).toContain('at most 5 rounds')
  expect((await c.post(`/api/relays/${relay.id}/continue`, { rounds: 2 })).status).toBe(200)
  await waitRelay(app!.state, relay.id, ['done', 'error'])
  expect((await json(await c.post(`/api/relays/${relay.id}/continue`, {}), 400)).detail).toContain('at most 5 rounds')
  expect(repo.listRunsOfRelay(app!.state.conn, relay.id)).toHaveLength(10)
})

test('a new message of the person supersedes a waiting relay; a running one refuses it', async () => {
  const { c, session } = await relaySession({
    [A]: scriptedModel((messages: ModelMessage[]) => {
      if (!toolReturns(messages).some((p) => p.tool_name === 'write_file')) return modelResponse([toolCallPart('write_file', { path: 'NOTES.md', content: 'x\n' }, '')])
      return modelResponse([textPart('waiting')])
    }),
    [B]: scriptedModel(() => modelResponse([textPart('B')])),
  })
  applySessionMode(app!.state.conn, repo.getSession(app!.state.conn, session)!, 'approve')
  const first = await json(await c.post(`/api/sessions/${session}/chat`, { text: TEXT, agents: [{ model: A }, { model: B }] }))
  const relay = await waitRelay(app!.state, first.relay_id as string, ['waiting', 'done', 'error'])
  expect(relay.status).toBe('waiting')
  const plain = await json(await c.post(`/api/sessions/${session}/chat`, { text: 'never mind, do something else' }))
  await waitDone(app!.state, plain.id as string)
  const after = repo.getRelay(app!.state.conn, relay.id)!
  expect(after.status).toBe('cancelled')
  expect(after.reason).toBe('superseded by a new message')
  expect(repo.listRunsOfRelay(app!.state.conn, relay.id)).toHaveLength(1)
})

// ---- the acceptance round's findings, pinned ---------------------------------------------------------------------

test("a turn that stopped at its budget line is not handed on: the run says done, its receipt says budget reached, the chain ends there", async () => {
  const bCalls = { n: 0 }
  const { c, session } = await relaySession({
    [A]: scriptedModel((messages: ModelMessage[]) => (userPrompts(messages).at(-1)!.includes('No tools are available') ? modelResponse([textPart('Budget reached; task incomplete')]) : modelResponse([toolCallPart('read_file', { path: 'calc.py' }, '')]))),
    [B]: scriptedModel(() => { bCalls.n += 1; return modelResponse([textPart('B ran')]) }),
  })
  const first = await json(await c.post(`/api/sessions/${session}/chat`, { text: 'read repeatedly', agents: [{ model: A }, { model: B }], budget: { tool_calls: 1 } }))
  const relay = await waitRelay(app!.state, first.relay_id as string, ['done', 'error', 'cancelled'])
  const aRun = repo.getRun(app!.state.conn, first.id as string)!
  expect(aRun.status).toBe('done')
  expect(rec(rec(aRun.receipt).mechanical).budget_reached).toBe('tool_calls 1 of 1')
  expect(relay.status).toBe('error')
  expect(relay.reason).toContain("Scripted A's turn stopped at its budget line (tool_calls 1 of 1)")
  expect(relay.steps.map((s) => s.status)).toEqual(['error', 'queued'])
  expect(bCalls.n).toBe(0)
  expect(repo.listRunsOfRelay(app!.state.conn, relay.id)).toHaveLength(1)
  // the same at startup: a chain left running whose turn had stopped at its line is ended, not resumed
  repo.updateRelay(app!.state.conn, relay.id, { status: 'running', steps: relay.steps.map((s, i) => (i === 0 ? { ...s, status: 'done' } : s)), finished_at: null, reason: null })
  expect(app!.state.relays.reconcile().finished).toEqual([relay.id])
  expect(repo.getRelay(app!.state.conn, relay.id)!.status).toBe('error')
  expect(bCalls.n).toBe(0)
})

test('a finished relay the conversation moved on from is not continued: the person\'s later words would be rewound past; a new message names the agents', async () => {
  const seen: string[] = []
  const { c, session } = await relaySession({
    [A]: scriptedModel((messages: ModelMessage[]) => { seen.push(userPrompts(messages).join('\n')); return modelResponse([textPart('A answer')]) }),
    [B]: scriptedModel(() => modelResponse([textPart('B feedback')])),
  })
  const first = await json(await c.post(`/api/sessions/${session}/chat`, { text: 'initial request', agents: [{ model: A }, { model: B }] }))
  await waitRelay(app!.state, first.relay_id as string, ['done'])
  const human = await json(await c.post(`/api/sessions/${session}/chat`, { text: 'NEW_HUMAN_CONSTRAINT_9b12: only analyze, never edit files' }))
  await waitDone(app!.state, human.id as string)
  const refused = await json<{ detail: string }>(await c.post(`/api/relays/${first.relay_id}/continue`, {}), 409)
  expect(refused.detail).toContain('the conversation moved on since this relay')
  expect(refused.detail).toContain(human.id as string)
  expect(repo.listRunsOfRelay(app!.state.conn, first.relay_id as string)).toHaveLength(2)
  expect(repo.getRelay(app!.state.conn, first.relay_id as string)!.status).toBe('done')
  // a new relay after the later words carries them (the conversation continues from its latest run)
  const next = await json(await c.post(`/api/sessions/${session}/chat`, { text: 'now with the constraint', agents: [{ model: A }, { model: B }] }))
  expect(next.resumes_run_id).toBe(human.id as string)
  await waitRelay(app!.state, next.relay_id as string, ['done'])
  expect(seen.at(-1)).toContain('NEW_HUMAN_CONSTRAINT_9b12')
  // and a relay that is the latest thing in the thread still takes one more round
  expect((await c.post(`/api/relays/${next.relay_id}/continue`, {})).status).toBe(200)
  await waitRelay(app!.state, next.relay_id as string, ['done'])
  expect(repo.listRunsOfRelay(app!.state.conn, next.relay_id as string)).toHaveLength(4)
})

test('fresh starts the relay on a new conversation; resumes_run_id names the run it continues; both are checked before anything starts', async () => {
  const seen: string[] = []
  const { c, session } = await relaySession({
    [A]: scriptedModel((messages: ModelMessage[]) => { seen.push(userPrompts(messages).join('\n')); return modelResponse([textPart('A answer')]) }),
    [B]: scriptedModel(() => modelResponse([textPart('B feedback')])),
  })
  const old = await json(await c.post(`/api/sessions/${session}/chat`, { text: 'OLD_HISTORY_SECRET_57ab' }))
  await waitDone(app!.state, old.id as string)
  const older = await json(await c.post(`/api/sessions/${session}/chat`, { text: 'EVEN_OLDER_2c4e', fresh: true }))
  await waitDone(app!.state, older.id as string)
  const fresh = await json(await c.post(`/api/sessions/${session}/chat`, { text: 'new clean task', agents: [{ model: A }, { model: B }], fresh: true }))
  expect(fresh.resumes_run_id).toBeNull()
  await waitRelay(app!.state, fresh.relay_id as string, ['done'])
  expect(seen.at(-1)).not.toContain('OLD_HISTORY_SECRET_57ab')
  expect(seen.at(-1)).toContain('new clean task')
  const named = await json(await c.post(`/api/sessions/${session}/chat`, { text: 'continue the old one', agents: [{ model: A }, { model: B }], resumes_run_id: old.id }))
  expect(named.resumes_run_id).toBe(old.id as string)
  await waitRelay(app!.state, named.relay_id as string, ['done'])
  expect(seen.at(-1)).toContain('OLD_HISTORY_SECRET_57ab')
  expect(seen.at(-1)).not.toContain('EVEN_OLDER_2c4e')
  expect((await json(await c.post(`/api/sessions/${session}/chat`, { text: 'x', agents: [{ model: A }, { model: B }], resumes_run_id: 'run_nope' }), 400)).detail).toContain('resumes_run_id is not a run of this session')
  expect(repo.listRelays(app!.state.conn, session)).toHaveLength(2)
})

test('continue, continue and a new relay at once: one chain moves, the others are refused', async () => {
  const { c, session } = await relaySession({
    [A]: scriptedModel(async () => { await sleep(30); return modelResponse([textPart('A answer')]) }),
    [B]: scriptedModel(() => modelResponse([textPart('B feedback')])),
  })
  const first = await json(await c.post(`/api/sessions/${session}/chat`, { text: 'initial request', agents: [{ model: A }, { model: B }] }))
  await waitRelay(app!.state, first.relay_id as string, ['done'])
  const responses = await Promise.all([
    c.post(`/api/relays/${first.relay_id}/continue`, {}), c.post(`/api/relays/${first.relay_id}/continue`, {}),
    c.post(`/api/sessions/${session}/chat`, { text: 'second request', agents: [{ model: A }, { model: B }] }),
  ])
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409, 409])
  await waitRelay(app!.state, first.relay_id as string, ['done'])
  expect(repo.listRunsOfRelay(app!.state.conn, first.relay_id as string)).toHaveLength(4)
  expect(repo.listRelays(app!.state.conn, session)).toHaveLength(1)
})

test('a relay left without its first run (a crash, or a refused start) is started by a resend with the same key — never a second relay, never superseded', async () => {
  const { c, session } = await relaySession({
    [A]: scriptedModel(() => modelResponse([textPart('A answer')])),
    [B]: scriptedModel(() => modelResponse([textPart('B feedback')])),
  })
  const key = 'independent-crash-key-0001'
  const plan = app!.state.relays.plan([{ model: A }, { model: B }], 1, [])
  // the record as a process left it between the relay's row and its first run
  const orphan = repo.insertRelay(app!.state.conn, {
    session_id: session, user_text: 'first request', participants: plan.participants, steps: [{ seq: 0, round: 1, participant: 0, status: 'queued', run_id: null, run_ids: [] }, { seq: 1, round: 1, participant: 1, status: 'queued', run_id: null, run_ids: [] }],
    rounds: 1, thinking: null, budget: {}, mentions: [], attachments: [], client_request_id: key,
  })
  expect(app!.state.relays.reconcile().interrupted).toEqual([orphan.id])
  expect(repo.getRelay(app!.state.conn, orphan.id)!.status).toBe('interrupted')
  const replayed = await json(await c.post(`/api/sessions/${session}/chat`, { text: 'first request', agents: [{ model: A }, { model: B }], client_request_id: key }))
  expect(replayed.relay_id).toBe(orphan.id)
  expect(replayed.relay_step).toBe(0)
  expect(repo.runForClientRequest(app!.state.conn, session, key)!.id).toBe(replayed.id as string)
  const relay = await waitRelay(app!.state, orphan.id, ['done', 'error', 'cancelled'])
  expect(relay.status).toBe('done')
  expect(repo.listRelays(app!.state.conn, session)).toHaveLength(1)
  expect(repo.listRunsOfRelay(app!.state.conn, orphan.id).map((r) => r.model)).toEqual([A, B])
  // sent again after it ran: the same first run, as any resend
  expect((await json(await c.post(`/api/sessions/${session}/chat`, { text: 'first request', agents: [{ model: A }, { model: B }], client_request_id: key }))).id).toBe(replayed.id)
  // the same through continue, for a relay still interrupted with no run
  const orphan2 = repo.insertRelay(app!.state.conn, {
    session_id: session, user_text: 'second request', participants: plan.participants, steps: [{ seq: 0, round: 1, participant: 0, status: 'queued', run_id: null, run_ids: [] }, { seq: 1, round: 1, participant: 1, status: 'queued', run_id: null, run_ids: [] }],
    rounds: 1, thinking: null, budget: {}, mentions: [], attachments: [], client_request_id: 'independent-crash-key-0002',
  })
  app!.state.relays.reconcile()
  expect((await json(await c.post(`/api/relays/${orphan2.id}/continue`, {}))).status).toBe('running')
  expect((await waitRelay(app!.state, orphan2.id, ['done', 'error'])).status).toBe('done')
})

test('a shutdown while a turn runs starts nothing after it: the turn is recorded, the chain reads interrupted at the next start, and the person continues it', async () => {
  const settings = testSettings()
  let releaseA!: () => void
  const heldA = new Promise<void>((r) => { releaseA = r })
  const bCalls = { n: 0 }
  state = await appState({ settings, models: {
    [A]: scriptedModel(async () => { await heldA; return modelResponse([textPart('A done at the end')]) }),
    [B]: scriptedModel(() => { bCalls.n += 1; return modelResponse([textPart('B')]) }),
  } })
  const { session } = await openSession(state, buggyRepo())
  const plan = state.relays.plan([{ model: A }, { model: B }], 1, [])
  const { relay, run } = await state.relays.start(session, { text: TEXT, plan, mentions: [], attachments: [], thinking: null, budget: null, client_request_id: null })
  // the process begins to shut down as A's turn ends: A's record is written, B never starts, nothing touches a closed connection
  state.relays.shutdown()
  releaseA()
  await waitDone(state, run.id)
  await sleep(50)
  expect(repo.getRun(state.conn, run.id)!.status).toBe('done')
  expect(bCalls.n).toBe(0)
  const left = repo.getRelay(state.conn, relay.id)!
  expect(left.status).toBe('running')
  expect(left.steps.map((s) => s.status)).toEqual(['done', 'queued'])
  await closeState(state)
  state = null
  // the next start: interrupted, and continued on the person's word
  state = await appState({ settings, models: { [A]: scriptedModel(() => modelResponse([textPart('A again')])), [B]: scriptedModel(() => { bCalls.n += 1; return modelResponse([textPart('B after the restart')]) }) } })
  await state.runs.reconcile()
  expect(state.relays.reconcile().interrupted).toEqual([relay.id])
  expect(repo.getRelay(state.conn, relay.id)!.reason).toContain("restarted before Scripted B's turn started")
  await state.relays.continue(relay.id)
  const done = await waitRelay(state, relay.id, ['done', 'error'])
  expect(done.status).toBe('done')
  expect(repo.listRunsOfRelay(state.conn, relay.id).map((r) => r.receipt.final_text)).toEqual(['A done at the end', 'B after the restart'])
  expect(bCalls.n).toBe(1)
  // closing the app right after a turn was started is quiet too: the run is stopped and waited for, and the chain
  // reads interrupted (the harness shut down: not the person's Stop)
  const c2 = await makeApp()
  setModel(c2.state, A, scriptedModel(async () => { await sleep(200); return modelResponse([textPart('A')]) }))
  setModel(c2.state, B, scriptedModel(() => modelResponse([textPart('B')])))
  const client = new Client(c2)
  const project = await json(await client.post('/api/projects', { source_path: buggyRepo() }))
  const s2 = await json(await client.post(`/api/projects/${project.id}/sessions`, { title: 'closing' }))
  const first = await json(await client.post(`/api/sessions/${s2.id}/chat`, { text: TEXT, agents: [{ model: A }, { model: B }] }))
  await c2.close()
  const conn2 = (await appState({ settings: new (await import('../src/config.ts')).Settings({ data_dir: c2.state.settings.data_dir, host: '127.0.0.1', port: 0, session_token: 'test-token' }) }))
  try {
    expect(repo.getRun(conn2.conn, first.id as string)!.status).toBe('cancelled')
    expect(repo.getRelay(conn2.conn, first.relay_id as string)!.status).toBe('interrupted')
    expect(repo.listRunsOfRelay(conn2.conn, first.relay_id as string)).toHaveLength(1)
  } finally { await closeState(conn2) }
})

test("the app closing while a turn runs (the desktop app, a SIGTERM) is not the person's Stop: reopened, the chain reads interrupted and continues; a Stop stays final", async () => {
  let entered!: () => void
  const inModel = new Promise<void>((r) => { entered = r })
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  const bCalls = { n: 0 }
  const { c, session } = await relaySession({
    [A]: scriptedModel(async () => { entered(); await held; return modelResponse([textPart('A')]) }),
    [B]: scriptedModel(() => { bCalls.n += 1; return modelResponse([textPart('B')]) }),
  })
  const settings = app!.state.settings
  const first = await json(await c.post(`/api/sessions/${session}/chat`, { text: 'test a normal application shutdown', agents: [{ model: A }, { model: B }] }))
  await inModel
  await app!.close()
  app = null
  release()
  const reopened = await makeApp(settings)
  try {
    setModel(reopened.state, A, scriptedModel((messages: ModelMessage[]) => modelResponse([textPart(userPrompts(messages).at(-1)!.includes('Continue turn 1 as A.') ? 'A carried on' : 'A fresh')])))
    setModel(reopened.state, B, scriptedModel(() => { bCalls.n += 1; return modelResponse([textPart('B after the restart')]) }))
    await reopened.start()
    const left = repo.getRelay(reopened.state.conn, first.relay_id as string)!
    expect(left.status).toBe('interrupted')
    expect(left.reason).toContain("Scripted A's turn was cut off when the harness shut down")
    expect(repo.getRun(reopened.state.conn, first.id as string)!.status).toBe('cancelled')
    expect(bCalls.n).toBe(0)
    const rc = new Client(reopened)
    const continued = await json(await rc.post(`/api/relays/${first.relay_id}/continue`, {}))
    expect(continued.status).toBe('running')
    const done = await waitRelay(reopened.state, first.relay_id as string, ['done', 'error'])
    expect(done.status).toBe('done')
    const texts = repo.listRunsOfRelay(reopened.state.conn, first.relay_id as string).map((r) => [r.status, String(r.receipt.final_text ?? '')])
    expect(texts).toEqual([['cancelled', ''], ['done', 'A carried on'], ['done', 'B after the restart']])
    // the person's Stop, by contrast, is final across a restart too
    setModel(reopened.state, A, scriptedModel(async () => { await sleep(3_600_000); return modelResponse([textPart('never')]) }))
    const second = await json(await rc.post(`/api/sessions/${session}/chat`, { text: 'and stop this one', agents: [{ model: A }, { model: B }] }))
    await sleep(30)
    expect((await json(await rc.post(`/api/relays/${second.relay_id}/cancel`))).cancelled).toBe(true)
    await waitDone(reopened.state, second.id as string)
    expect(repo.getRelay(reopened.state.conn, second.relay_id as string)!.status).toBe('cancelled')
  } finally { await reopened.close() }
  const reopenedAgain = await makeApp(settings)
  try {
    await reopenedAgain.start()
    const stopped = repo.listRelays(reopenedAgain.state.conn, session).at(-1)!
    expect(stopped.status).toBe('cancelled')
    await json(await new Client(reopenedAgain).post(`/api/relays/${stopped.id}/continue`, {}), 409)
  } finally { await reopenedAgain.close() }
})

test('a resend with the same key never revives a relay the person stopped before it ran: 409, no run', async () => {
  const aCalls = { n: 0 }
  const { c, session } = await relaySession({
    [A]: scriptedModel(() => { aCalls.n += 1; return modelResponse([textPart('A')]) }),
    [B]: scriptedModel(() => modelResponse([textPart('B')])),
  })
  const key = 'cancelled-crash-key-001'
  const plan = app!.state.relays.plan([{ model: A }, { model: B }], 1, [])
  const orphan = repo.insertRelay(app!.state.conn, {
    session_id: session, user_text: 'first request', participants: plan.participants, steps: [{ seq: 0, round: 1, participant: 0, status: 'queued', run_id: null, run_ids: [] }, { seq: 1, round: 1, participant: 1, status: 'queued', run_id: null, run_ids: [] }],
    rounds: 1, thinking: null, budget: {}, mentions: [], attachments: [], client_request_id: key,
  })
  app!.state.relays.reconcile()
  expect((await json(await c.post(`/api/relays/${orphan.id}/cancel`))).cancelled).toBe(true)
  const refused = await json<{ detail: string }>(await c.post(`/api/sessions/${session}/chat`, { text: 'first request', agents: [{ model: A }, { model: B }], client_request_id: key }), 409)
  expect(refused.detail).toContain('the earlier request with this key was stopped')
  await sleep(100)
  expect(aCalls.n).toBe(0)
  expect(repo.getRelay(app!.state.conn, orphan.id)!.status).toBe('cancelled')
  expect(repo.listRunsOfRelay(app!.state.conn, orphan.id)).toHaveLength(0)
  expect(repo.listRelays(app!.state.conn, session)).toHaveLength(1)
  // the same words with a new key are a new relay
  const fresh = await json(await c.post(`/api/sessions/${session}/chat`, { text: 'first request', agents: [{ model: A }, { model: B }], client_request_id: 'cancelled-crash-key-002' }))
  expect(fresh.relay_id).not.toBe(orphan.id)
  await waitRelay(app!.state, fresh.relay_id as string, ['done'])
  expect(aCalls.n).toBe(1)
})

test("a run's transcript is its own record: the conversation it inherited shows under the runs that made it, while its model context stays whole", async () => {
  const { c, session } = await relaySession({
    [A]: stampedModel(executorScript(), 'anthropic', 'claude-x'),
    [B]: stampedModel((messages: ModelMessage[]) => modelResponse([textPart(`B saw ${userPrompts(messages).filter((t) => t.includes(MARKER)).length} marker(s): REVIEW_CONTEXT_OK`)]), 'openai', 'gpt-y'),
  })
  const first = await json(await c.post(`/api/sessions/${session}/chat`, { text: TEXT, agents: [{ model: A }, { model: B }] }))
  const relay = await waitRelay(app!.state, first.relay_id as string, ['done'])
  const [aRun, bRun] = relay.steps.map((s) => s.run_id!)
  const a = await json<{ entries: Record<string, unknown>[] }>(await c.get(`/api/runs/${aRun}/transcript`))
  const b = await json<{ entries: Record<string, unknown>[] }>(await c.get(`/api/runs/${bRun}/transcript`))
  expect(a.entries.map((e) => e.kind)).toEqual(['user', 'activity', 'agent'])
  expect((a.entries[2]!.text as string)).toContain(MARKER)
  // B's record: its own request (the harness's message with A's packet), no tool, one answer — A's read is A's
  expect(b.entries.map((e) => e.kind)).toEqual(['user', 'agent'])
  expect(b.entries[0]!.text as string).toContain('App note:\nTurn 2 of 2. Speaker: B.')
  expect((b.entries[1]!.text as string)).toBe('B saw 1 marker(s): REVIEW_CONTEXT_OK')
  expect(b.entries.some((e) => e.kind === 'activity')).toBe(false)
  // the model context B was handed held A's marker (the answer says so), in the packet its own history holds
  expect(repo.getRunHistory(app!.state.conn, bRun)).toContain(MARKER)
  // a plain follow-up in the thread likewise shows only its own turn
  const plain = await json(await c.post(`/api/sessions/${session}/chat`, { text: 'and a plain follow-up', model: B }))
  await waitDone(app!.state, plain.id as string)
  const p = await json<{ entries: Record<string, unknown>[] }>(await c.get(`/api/runs/${plain.id}/transcript`))
  expect(p.entries.map((e) => e.kind)).toEqual(['user', 'agent'])
  expect(p.entries[0]!.text).toBe('and a plain follow-up')
  // a fresh run inherits nothing: its transcript is whole
  const alone = await json(await c.post(`/api/sessions/${session}/chat`, { text: 'alone', model: B, fresh: true }))
  await waitDone(app!.state, alone.id as string)
  expect((await json<{ entries: Record<string, unknown>[] }>(await c.get(`/api/runs/${alone.id}/transcript`))).entries.map((e) => e.kind)).toEqual(['user', 'agent'])
})

test('the tree shows the relay as plan rows: one per step, the letter on each, the step before as what it waits for; a step not started is a queued placeholder, never live', async () => {
  let letB: (() => void) | null = null
  const gate = new Promise<void>((resolve) => { letB = resolve })
  let bTurns = 0
  const { c, session } = await relaySession({
    [A]: scriptedModel(() => modelResponse([textPart('A speaks')])),
    [B]: scriptedModel(async () => { bTurns += 1; if (bTurns === 1) await gate; return modelResponse([textPart('B speaks')]) }),
  })
  const first = await json(await c.post(`/api/sessions/${session}/chat`, { text: TEXT, agents: [{ model: A }, { model: B }], rounds: 2 }))
  const relayId = first.relay_id as string
  // B's first turn is held at its model: A's row is done, B's runs, the second round stands as placeholders
  for (let i = 0; i < 500 && bTurns < 1; i += 1) await sleep(10)
  expect(bTurns).toBe(1)
  const tree = await json(await c.get(`/api/sessions/${session}/runs/tree`))
  const rows = (tree.runs as Record<string, unknown>[]).filter((r) => r.relay_id === relayId)
  expect(rows.map((r) => [r.plan_node_id, r.participant_alias, r.participant_id, r.status, r.live, r.spawned_by, r.kind])).toEqual([
    [`${relayId}:0`, 'A', `${relayId}:A`, 'done', false, 'human', 'run'],
    [`${relayId}:1`, 'B', `${relayId}:B`, 'running', true, 'human', 'run'],
    [`${relayId}:2`, 'A', `${relayId}:A`, 'queued', false, 'plan', 'run'],
    [`${relayId}:3`, 'B', `${relayId}:B`, 'queued', false, 'plan', 'run'],
  ])
  expect(rows.map((r) => r.id).slice(2)).toEqual([`${relayId}:2`, `${relayId}:3`])
  expect(rows.map((r) => r.depends_on)).toEqual([[], [rows[0]!.id], [rows[1]!.id], [`${relayId}:2`]])
  expect([rows[2]!.model, rows[2]!.receipt, rows[2]!.depth]).toEqual([A, null, 0])
  expect(rows[2]!.user_text_head as string).toStartWith('测试衣物模拟的方案')
  letB!()
  const relay = await waitRelay(app!.state, relayId, ['done', 'error'])
  expect(relay.status).toBe('done')
  const after = ((await json(await c.get(`/api/sessions/${session}/runs/tree`))).runs as Record<string, unknown>[]).filter((r) => r.relay_id === relayId)
  expect(after.map((r) => [r.participant_alias, r.status, r.spawned_by])).toEqual([['A', 'done', 'human'], ['B', 'done', 'human'], ['A', 'done', 'human'], ['B', 'done', 'human']])
  expect(after.map((r) => r.depends_on)).toEqual([[], [after[0]!.id], [after[1]!.id], [after[2]!.id]])
})

test("each agent runs at the effort the person chose for it; one without runs at the message's; one agent named, its own", async () => {
  const efforts: Record<string, (string | boolean | null)[]> = { [A]: [], [B]: [] }
  const record = (id: string) => scriptedModel((_m: ModelMessage[], info) => {
    efforts[id]!.push(info.model_settings.thinking ?? null)
    return modelResponse([textPart(`${id} done`)])
  }, id, { supports_thinking: true })
  const { c, session } = await relaySession({ [A]: record(A), [B]: record(B) })
  const text = `${agentMentionToken('Scripted A', A, 'pt_aaaaaa')} does it, ${agentMentionToken('Scripted B', B, 'pt_bbbbbb')} reviews`
  const first = await json(await c.post(`/api/sessions/${session}/chat`, { text, agents: [{ model: A }, { model: B }], thinking: 'low', participant_thinking: { pt_aaaaaa: 'xhigh' } }))
  const relay = await waitRelay(app!.state, first.relay_id as string, ['done'])
  expect(relay.participants.map((p) => p.thinking ?? null)).toEqual(['xhigh', null])
  expect(efforts[A]).toEqual(['xhigh'])
  expect(efforts[B]).toEqual(['low'])
  const one = await json(await c.post(`/api/sessions/${session}/chat`, { text: `${agentMentionToken('Scripted B', B, 'pt_cccccc')} again`, agents: [{ model: B }], thinking: 'low', participant_thinking: { pt_cccccc: 'high' } }))
  await waitDone(app!.state, one.id as string)
  expect(efforts[B]!.at(-1)).toBe('high')
  expect((await json(await c.post(`/api/sessions/${session}/chat`, { text, agents: [{ model: A }, { model: B }], participant_thinking: { pt_aaaaaa: 'huge' } }), 400)).detail).toContain('thinking must be one of')
})
