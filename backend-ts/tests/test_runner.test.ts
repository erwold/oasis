/** Run lifecycle under faults: persisted events with a monotonic seq and cursor replay, Stop now killing the run's
 *  processes, transport recovery that replays nothing, hard budgets with one report-only closing turn, restart
 *  reconciliation, and session history continuation. */

import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as repo from '../src/db/repo.ts'
import { NOT_STARTED_REASON } from '../src/agent/loop.ts'
import { rebuildTranscript } from '../src/agent/transcript.ts'
import { isRequest, isResponse, isThinking, isToolCall, isUserPrompt, loadValue, modelResponse, textPart, thinkingPart, toolCallPart, userTexts, type ModelMessage } from '../src/llm/messages.ts'
import { ModelHTTPError, TransportError } from '../src/llm/model.ts'
import { stampedModel } from '../src/llm/scripted.ts'
import { appState, buggyRepo, closeState, collectEvents, openSession, scriptedModel, sleep, steps, testSettings, toolReturns, waitDone, type AppState } from './harness.ts'
import { AnthropicModel } from '../src/llm/providers.ts'
import type { FetchLike } from '../src/llm/http.ts'
import { anthropicStream } from './providers_fixtures.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

test('events persist, replay by cursor and dedupe', async () => {
  state = await appState({ models: { 'scripted:a': scriptedModel(steps([textPart('Looking.'), toolCallPart('read_file', { path: 'calc.py' }, '')], [textPart('Done reading.')])) } })
  const { session } = await openSession(state, buggyRepo())
  let run = await state.runs.start(session, 'read calc.py')
  const live = await collectEvents(state, run.id)
  run = await waitDone(state, run.id)
  const seqs = live.map((e) => e.seq)
  expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b))
  expect(live[0]!.event).toBe('run_started')
  expect(live[live.length - 1]!.event).toBe('run_finished')
  expect(live.some((e) => e.event === 'text_delta')).toBe(true)
  expect(live.some((e) => e.event === 'text_block')).toBe(true)
  const stored = repo.listEvents(state.conn, run.id)
  expect(stored.every((e) => e.event !== 'text_delta' && e.event !== 'thinking_delta')).toBe(true)          // deltas coalesced into blocks
  expect(stored.filter((e) => e.event === 'text_block').map((e) => e.data.text)).toEqual(['Looking.', 'Done reading.'])
  const storedSeqs = stored.map((e) => e.seq)
  expect(storedSeqs).toEqual([...storedSeqs].sort((a, b) => a - b))
  expect(storedSeqs.every((s) => seqs.includes(s))).toBe(true)
  // a cursor replays only what follows it — from memory while the handle lives, from the table after
  const cursor = storedSeqs[2]!
  const replay = await collectEvents(state, run.id, { after: cursor })
  expect(replay.length).toBeGreaterThan(0)
  expect(replay.every((e) => e.seq > cursor)).toBe(true)
  expect(replay[replay.length - 1]!.event).toBe('run_finished')
  state.runs.handles.delete(run.id)
  const fromDb = await collectEvents(state, run.id, { after: cursor })
  expect(fromDb.map((e) => e.seq)).toEqual(storedSeqs.filter((s) => s > cursor))
  // the saved_seq the client resubscribes after covers everything persisted
  expect(run.saved_seq).toBeGreaterThanOrEqual(Math.max(...storedSeqs))
})

test('session runs continue the history and fresh starts over', async () => {
  const prompts: number[] = []
  state = await appState({ models: { 'scripted:a': scriptedModel((messages) => { prompts.push(messages.length); return modelResponse([textPart(`turn with ${messages.length} messages`)]) }) } })
  const { session } = await openSession(state, buggyRepo())
  const r1 = await waitDone(state, (await state.runs.start(session, 'one')).id)
  const r2 = await waitDone(state, (await state.runs.start(session, 'two')).id)
  const r3 = await waitDone(state, (await state.runs.start(session, 'three', { fresh: true })).id)
  expect(r2.resumes_run_id).toBe(r1.id)
  expect(r3.resumes_run_id).toBeNull()
  expect(prompts[1]!).toBeGreaterThan(prompts[0]!)
  expect(prompts[2]).toBe(prompts[0]!)
  // two runs in one session never overlap (one writer per workspace)
  state.model_overrides.set('scripted:a', scriptedModel(steps([toolCallPart('read_file', { path: 'calc.py' }, '')], [textPart('ok')])))
  const r4 = await state.runs.start(session, 'four')
  await expect(state.runs.start(session, 'five')).rejects.toThrow('already has an active run')
  await waitDone(state, r4.id)
})

test('Stop now kills the model request and the process', async () => {
  state = await appState({ sandbox: true, models: { 'scripted:a': scriptedModel(steps([toolCallPart('bash', { command: 'echo START; sleep 60; echo END', wait_s: 30 }, '')], [textPart('should never be reached')])) } })
  const { session, ws } = await openSession(state, buggyRepo())
  const run = await state.runs.start(session, 'run something long')
  for (let i = 0; i < 200; i += 1) {
    await sleep(50)
    if (repo.listExecutions(state.conn, { run_id: run.id }).length) break
  }
  const xs = repo.listExecutions(state.conn, { run_id: run.id })
  expect(xs.length).toBeGreaterThan(0)
  expect(state.processes.isRunning(xs[0]!.id)).toBe(true)
  for (let i = 0; i < 200; i += 1) {                      // the shell has printed START: the process is really under way
    if (state.processes.readOutput(xs[0]!.id, 'stdout', 0, 100).text.includes('START')) break
    await sleep(50)
  }
  expect(state.runs.cancel(run.id)).toBe(true)
  const row = await waitDone(state, run.id, 15_000)
  expect(row.status).toBe('cancelled')
  const x = repo.getExecution(state.conn, xs[0]!.id)!
  expect(x.status).toBe('cancelled')
  expect(state.processes.isRunning(x.id)).toBe(false)
  expect(state.store.read(repo.getAsset(state.conn, x.stdout_asset_id!)!.storage_path).toString()).not.toContain('END')
  expect(repo.listEvents(state.conn, run.id).at(-1)!.data.status).toBe('cancelled')
  expect(state.locks.holder(ws.id)).toBeNull()
})

test('a transport drop resumes from the stash without replaying tools', async () => {
  let calls = 0
  const script = (messages: ModelMessage[]) => {
    calls += 1
    if (calls === 1) return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, '')])
    if (calls === 2) throw new TransportError('ReadTimeout', 'stream dropped')
    const returns = toolReturns(messages).filter((p) => p.tool_name === 'read_file')
    return modelResponse([textPart(`resumed with ${returns.length} read result(s)`)])
  }
  state = await appState({ models: { 'scripted:a': scriptedModel(script) } })
  state.runs.transport_backoff_s = [0.01, 0.01, 0.01]
  const { session } = await openSession(state, buggyRepo())
  const run = await waitDone(state, (await state.runs.start(session, 'go')).id)
  expect(run.status).toBe('done')
  expect(run.receipt.final_text).toBe('resumed with 1 read result(s)')
  const events = repo.listEvents(state.conn, run.id)
  const cont = events.filter((e) => e.event === 'run_continued')
  expect(cont).toHaveLength(1)
  expect(cont[0]!.data.reason).toBe('transport_error')
  expect(cont[0]!.data.recovery).toBe(1)
  expect(events.filter((e) => e.event === 'tool_call')).toHaveLength(1)                  // the tool ran once
  const reqs = repo.listModelRequests(state.conn, run.id)
  expect(reqs.map((r) => r.status)).toEqual(['ok', 'error', 'ok'])
  expect(reqs[1]!.error).toContain('ReadTimeout')
})

test('transport recovery is bounded', async () => {
  let calls = 0
  state = await appState({ models: { 'scripted:a': scriptedModel(() => { calls += 1; if (calls === 1) return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, '')]); throw new TransportError('ConnectError', 'gone') }) } })
  state.runs.transport_backoff_s = [0.01]
  const { session } = await openSession(state, buggyRepo())
  const run = await waitDone(state, (await state.runs.start(session, 'go')).id)
  expect(run.status).toBe('error')
  expect(run.error).toContain('ConnectError')
  expect(repo.listEvents(state.conn, run.id).filter((e) => e.event === 'run_continued')).toHaveLength(3)
  expect(repo.getRunHistory(state.conn, run.id)).toBeTruthy()                                    // the stash was kept
})

test('an auth error is not retried', async () => {
  state = await appState({ models: { 'scripted:a': scriptedModel(() => { throw new ModelHTTPError(401, 'scripted-a', { error: { message: 'invalid api key' } }) }) } })
  const { session } = await openSession(state, buggyRepo())
  const run = await waitDone(state, (await state.runs.start(session, 'go')).id)
  expect(run.status).toBe('error')
  expect(run.error).toContain('401')
  const events = repo.listEvents(state.conn, run.id)
  expect(events.some((e) => e.event === 'run_continued')).toBe(false)
  expect(events.find((e) => e.event === 'error')!.data.kind).toBe('auth')
})

test('a tool-call budget ends with a report-only closing turn: the tools stay described (the cache prefix), none runs', async () => {
  const seenTools: string[][] = []
  const script = (m: ModelMessage[], info: { function_tools: { name: string }[] }) => {
    seenTools.push(info.function_tools.map((t) => t.name))
    const closing = userTexts(m).some((t) => t.includes('No tools are available'))
    if (!closing) return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, '')])
    return modelResponse([textPart('closing report: 2 reads done, nothing patched')])
  }
  state = await appState({ models: { 'scripted:a': scriptedModel(script) } })
  const { session } = await openSession(state, buggyRepo())
  const run = await waitDone(state, (await state.runs.start(session, 'loop forever', { budget: { tool_calls: 2 } })).id)
  expect(run.status).toBe('done')
  expect(run.receipt.final_text as string).toStartWith('closing report')
  expect(seenTools[seenTools.length - 1]).toEqual(seenTools[0])                                // the closing turn carried the same tool descriptions
  expect(seenTools[0]!.length).toBeGreaterThan(0)
  const events = repo.listEvents(state.conn, run.id)
  expect(events.filter((e) => e.event === 'tool_call')).toHaveLength(2)
  expect(events.some((e) => e.event === 'budget_closing')).toBe(true)
  expect((run.receipt.mechanical as Record<string, unknown>).tool_calls).toBe(2)
})

test('a closing turn that calls a tool anyway runs nothing: the call is stopped at the line or refused, and the run ends at its budget line', async () => {
  // a tool-call line: the loop's own limit stops the call before it runs
  state = await appState({ models: { 'scripted:a': scriptedModel(() => modelResponse([toolCallPart('read_file', { path: 'calc.py' }, '')])) } })
  const { session } = await openSession(state, buggyRepo())
  const run = await waitDone(state, (await state.runs.start(session, 'loop forever', { budget: { tool_calls: 2 } })).id)
  expect(run.status).toBe('error')
  expect(run.error).toContain('budget_exceeded: tool_calls 2 of 2')
  expect(run.error).toContain('filed no report')
  const events = repo.listEvents(state.conn, run.id)
  expect(events.filter((e) => e.event === 'tool_call')).toHaveLength(3)
  expect(events.filter((e) => e.event === 'tool_result')).toHaveLength(2)                     // the closing turn's call never ran
  // a token line: the closing turn still describes the tools; the registry refuses the call the model makes anyway
  const tokens = await waitDone(state, (await state.runs.start(session, 'loop again', { budget: { total_tokens: 20 }, fresh: true })).id)
  expect(tokens.status).toBe('error')
  expect(tokens.error).toContain('budget_exceeded: total_tokens')
  expect(tokens.error).toContain('filed no report')
  const results = repo.listEvents(state.conn, tokens.id).filter((e) => e.event === 'tool_result')
  const refused = results.filter((e) => e.data.status === 'refused')
  expect(refused).toHaveLength(1)
  expect(refused[0]!.data.summary).toBe('refused: the run is closing')
  expect(results.filter((e) => e.data.status === 'ok').length).toBeGreaterThan(0)
  expect((tokens.receipt.mechanical as Record<string, unknown>).refused_calls).toBe(1)
})

test('the wall-clock budget is a hard stop', async () => {
  state = await appState({ models: { 'scripted:a': scriptedModel(async () => { await sleep(5000); return modelResponse([textPart('too late')]) }) } })
  const { session } = await openSession(state, buggyRepo())
  const run = await waitDone(state, (await state.runs.start(session, 'go', { budget: { wall_clock_s: 1 } })).id, 20_000)
  expect(run.status).toBe('error')
  expect(run.error).toContain('budget_exceeded: wall_clock_s')
})

test('a restart reconciles dead runs and lost executions', async () => {
  const settings = testSettings()
  let started!: () => void
  const startedPromise = new Promise<void>((r) => { started = r })
  state = await appState({ settings, models: { 'scripted:a': scriptedModel(async () => { started(); await sleep(3_600_000); return modelResponse([textPart('never')]) }) } })
  const { session, ws } = await openSession(state, buggyRepo())
  const run = await state.runs.start(session, 'hang')
  await startedPromise
  const x = repo.insertExecution(state.conn, { run_id: run.id, workspace_id: ws.id, tool_call_id: 't1', kind: 'command', command: 'sleep 100', cwd: ws.path, isolation: {}, network: false })
  repo.startExecution(state.conn, x.id)
  // the process dies: no finalize runs; a new process opens the same data directory
  const dead = state
  state = null
  dead.runs.handles.get(run.id)!.done = true          // the old handle never finalizes
  dead.conn.close()
  const state2 = await appState({ settings })
  const counts = await state2.runs.reconcile()
  expect(counts.dead_runs as string[]).toContain(run.id)
  expect(counts.lost_executions as string[]).toContain(x.id)
  const row = repo.getRun(state2.conn, run.id)!
  expect(row.status).toBe('error')
  expect(row.error).toContain('process exited')
  expect(repo.getExecution(state2.conn, x.id)!.status).toBe('lost')
  expect(repo.getExecution(state2.conn, x.id)!.effect_state).toBe('unknown')
  const events = repo.listEvents(state2.conn, run.id)
  expect(events[events.length - 1]!.event).toBe('run_finished')
  expect(events[events.length - 1]!.data.reconciled).toBe(true)
  dead.runs.handles.get(run.id)!.token.cancel()
  state2.conn.close()
})

test('cross-model continuation in a session', async () => {
  /** Claude -> GPT (and back) within one session: the second run sees the first run's user goal, tool call and tool
   *  result, without the first provider's reasoning or references, plus one explicit handoff note. */
  const seen: { messages?: ModelMessage[] } = {}
  const aScript = (messages: ModelMessage[]) => {
    if (!toolReturns(messages).length) {
      return modelResponse([thinkingPart('private', { signature: 'sig-a', provider_name: 'anthropic' }), toolCallPart('read_file', { path: 'calc.py' }, '', { provider_name: 'anthropic' })],
        { provider_name: 'anthropic', provider_response_id: 'msg_a1', model_name: 'claude-x' })
    }
    return modelResponse([textPart('A read calc.py')], { provider_name: 'anthropic', model_name: 'claude-x' })
  }
  const bScript = (messages: ModelMessage[]) => { seen.messages = messages; return modelResponse([textPart('B continues')], { provider_name: 'openai', model_name: 'gpt-y' }) }
  state = await appState({ models: { 'scripted:a': stampedModel(aScript, 'anthropic', 'claude-x'), 'scripted:b': stampedModel(bScript, 'openai', 'gpt-y') } })
  const { session } = await openSession(state, buggyRepo())
  const r1 = await waitDone(state, (await state.runs.start(session, 'read calc.py')).id)
  expect(r1.status).toBe('done')
  const stored = repo.getRunHistory(state.conn, r1.id)!
  expect(stored).toContain('"thinking"')
  expect(stored).toContain('"anthropic"')
  expect(stored).toContain('sig-a')          // the archive keeps the provider's record
  const r2 = await waitDone(state, (await state.runs.start(session, 'now summarize', { model_id: 'scripted:b' })).id)
  expect(r2.status).toBe('done')
  expect(r2.model).toBe('scripted:b')
  expect(r2.resumes_run_id).toBe(r1.id)
  const msgs = seen.messages!
  const texts = msgs.filter(isRequest).flatMap((m) => m.parts).filter(isUserPrompt).map((p) => p.content as string)
  expect(texts.some((t) => t.includes('read calc.py'))).toBe(true)
  expect(texts.some((t) => t.includes('now summarize'))).toBe(true)
  expect(texts.some((t) => t.includes('Earlier turns came from') && t.includes('unavailable parts are marked'))).toBe(true)      // the handoff note
  const responses = msgs.filter(isResponse)
  expect(responses.some((m) => m.parts.some(isThinking))).toBe(false)
  expect(responses.every((m) => m.provider_response_id === null && m.provider_name === null)).toBe(true)
  const calls = responses.flatMap((m) => m.parts).filter(isToolCall)
  expect(calls[0]!.tool_name).toBe('read_file')
  expect(calls[0]!.provider_name).toBeNull()
  const returns = toolReturns(msgs).filter((p) => p.tool_name === 'read_file')
  expect((returns[0]!.content as Record<string, unknown>).path).toBe('calc.py')
  expect((r2.manifest.handoff as Record<string, unknown>).dropped_thinking_parts).toBe(1)
  expect((r2.manifest.handoff as Record<string, unknown>).foreign_responses).toBe(2)
  const events = repo.listEvents(state.conn, r2.id)
  expect((events[0]!.data.handoff as Record<string, unknown>).foreign_models).toEqual(['claude-x'])
})

test('a stream broken mid-answer keeps the words that arrived and asks for the rest, not the whole answer again', async () => {
  const cut = anthropicStream({ model: 'claude-x', blocks: [{ type: 'text', pieces: ['The bug is ', 'in add(): it subtr'] }], stop: 'end_turn' }).split('event: content_block_stop')[0]!
  const rest = anthropicStream({ model: 'claude-x', blocks: [{ type: 'text', pieces: ['acts instead of adding.'] }], stop: 'end_turn' })
  const sent: Record<string, unknown>[] = []
  const fetchImpl: FetchLike = async (_input, init) => {
    sent.push(JSON.parse(String(init?.body)))
    if (sent.length === 1) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(cut)); setTimeout(() => controller.error(new Error('socket hang up')), 5) },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response(rest, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  state = await appState({ models: { 'scripted:a': new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://anthropic.mock', fetchImpl }) } })
  state.runs.transport_backoff_s = [0.01]
  const { session } = await openSession(state, buggyRepo())
  const run = await waitDone(state, (await state.runs.start(session, 'what is wrong?')).id)
  expect(run.status).toBe('done')
  expect(sent).toHaveLength(2)
  // the second request carries the first answer's words as the model's own, then the ask for the rest
  const messages = sent[1]!.messages as { role: string; content: { type: string; text?: string }[] }[]
  const assistant = messages.filter((m) => m.role === 'assistant').at(-1)!
  expect(assistant.content.map((c) => c.text).join('')).toBe('The bug is in add(): it subtr')
  expect(JSON.stringify(messages.at(-1))).toContain('Continue the cut-off answer from its last word without repeating it.')
  const cont = repo.listEvents(state.conn, run.id).filter((e) => e.event === 'run_continued')
  expect(cont.map((e) => e.data.kept_chars)).toEqual(['The bug is in add(): it subtr'.length])
  expect(run.receipt.final_text).toBe('The bug is in add(): it subtracts instead of adding.')           // one answer, both halves
})

/** A Stop while a tool runs: what happened stays in the record — the model's call, the tool's cancelled return with
 *  the output that had arrived — so the run's own transcript shows it and the next model (another provider) reads
 *  it; the cancelled command is never run again by the harness, and nothing it would have written appears. */
test('Stop during a tool keeps the accepted call and its cancelled return in the history, for the transcript and the next model', async () => {
  const command = 'python3 -c "import sys, time; print(\'STOP_READY\', flush=True); time.sleep(3); open(\'after-stop.txt\', \'w\').write(\'LATE_WRITE\')"'
  const seenB: ModelMessage[][] = []
  state = await appState({ sandbox: true, models: {
    'scripted:a': stampedModel(steps([toolCallPart('bash', { command, wait_s: 30 }, '')], [textPart('should never be reached')]), 'anthropic', 'claude-x'),
    'scripted:b': stampedModel((messages: ModelMessage[]) => { seenB.push(messages); return modelResponse([textPart('B read the record')]) }, 'openai', 'gpt-y'),
  } })
  const { session, ws } = await openSession(state, buggyRepo())
  const run = await state.runs.start(session, 'run the long command')
  let xs = repo.listExecutions(state.conn, { run_id: run.id })
  for (let i = 0; i < 200 && !xs.length; i += 1) { await sleep(50); xs = repo.listExecutions(state.conn, { run_id: run.id }) }
  expect(xs.length).toBe(1)
  for (let i = 0; i < 200; i += 1) {
    if (state.processes.readOutput(xs[0]!.id, 'stdout', 0, 100).text.includes('STOP_READY')) break
    await sleep(50)
  }
  expect(state.runs.cancel(run.id)).toBe(true)
  const row = await waitDone(state, run.id, 15_000)
  expect(row.status).toBe('cancelled')
  // the history: the request, the response with its bash call, the request with the call's cancelled return
  const history = loadValue(JSON.parse(repo.getRunHistory(state.conn, run.id)!))
  expect(history.map((m) => m.kind)).toEqual(['request', 'response', 'request'])
  const call = history[1]!.parts.find(isToolCall)!
  expect(call.tool_name).toBe('bash')
  const ret = toolReturns(history).find((p) => p.tool_call_id === call.tool_call_id)!
  const content = ret.content as Record<string, unknown>
  expect(content.status).toBe('cancelled')
  expect(content.execution_id).toBe(xs[0]!.id)
  expect(String(content.stdout)).toContain('STOP_READY')
  expect((row.usage as Record<string, unknown>).history_messages).toBe(3)
  // the run's own transcript: its request, the call with its cancelled result
  const transcript = rebuildTranscript(repo.getRunHistory(state.conn, run.id))
  expect(transcript.map((e) => e.kind)).toEqual(['user', 'activity'])
  expect(transcript[1]!.result?.status).toBe('cancelled')
  expect(transcript[1]!.running).toBe(false)
  // nothing late, nothing run again: the file the command would have written never appears
  await sleep(4000)
  expect(existsSync(join(ws.path, 'after-stop.txt'))).toBe(false)
  expect(repo.listExecutions(state.conn, { run_id: run.id })).toHaveLength(1)
  // the next model, on another provider, reads the call and its cancelled return with the output that had arrived
  const next = await waitDone(state, (await state.runs.start(session, 'what happened to my command?', { model_id: 'scripted:b' })).id)
  expect(next.status).toBe('done')
  const msgs = seenB[0]!
  const calls = msgs.filter(isResponse).flatMap((m) => m.parts).filter(isToolCall)
  expect(calls.map((c) => c.tool_name)).toEqual(['bash'])
  const returns = toolReturns(msgs).filter((p) => p.tool_name === 'bash')
  expect(returns).toHaveLength(1)
  expect((returns[0]!.content as Record<string, unknown>).status).toBe('cancelled')
  expect(String((returns[0]!.content as Record<string, unknown>).stdout)).toContain('STOP_READY')
  expect(repo.listExecutions(state.conn, { run_id: next.id })).toHaveLength(0)
  expect(existsSync(join(ws.path, 'after-stop.txt'))).toBe(false)
}, 15_000)   // it waits four seconds on purpose (nothing may be written late): the default five leave no room

test('the app closing while a tool runs keeps the same record: reopened, the run reads cancelled with its call and the cancelled return', async () => {
  const settings = testSettings()
  const command = 'python3 -c "import sys, time; print(\'STOP_READY\', flush=True); time.sleep(3); open(\'after-stop.txt\', \'w\').write(\'LATE_WRITE\')"'
  state = await appState({ settings, sandbox: true, models: { 'scripted:a': scriptedModel(steps([toolCallPart('bash', { command, wait_s: 30 }, '')], [textPart('never')])) } })
  const { session, ws } = await openSession(state, buggyRepo())
  const run = await state.runs.start(session, 'run the long command')
  let xs = repo.listExecutions(state.conn, { run_id: run.id })
  for (let i = 0; i < 200 && !xs.length; i += 1) { await sleep(50); xs = repo.listExecutions(state.conn, { run_id: run.id }) }
  for (let i = 0; i < 200; i += 1) {
    if (state.processes.readOutput(xs[0]!.id, 'stdout', 0, 100).text.includes('STOP_READY')) break
    await sleep(50)
  }
  await closeState(state)
  state = null
  const reopened = await appState({ settings, sandbox: true })
  try {
    await reopened.runs.reconcile()
    const row = repo.getRun(reopened.conn, run.id)!
    expect(row.status).toBe('cancelled')
    const history = loadValue(JSON.parse(repo.getRunHistory(reopened.conn, run.id)!))
    expect(history.map((m) => m.kind)).toEqual(['request', 'response', 'request'])
    expect((toolReturns(history)[0]!.content as Record<string, unknown>).status).toBe('cancelled')
    expect(rebuildTranscript(repo.getRunHistory(reopened.conn, run.id)).map((e) => e.kind)).toEqual(['user', 'activity'])
    expect(repo.getExecution(reopened.conn, xs[0]!.id)!.status).toBe('cancelled')
    await sleep(3500)
    expect(existsSync(join(ws.path, 'after-stop.txt'))).toBe(false)
  } finally { await closeState(reopened) }
}, 30_000) // 3.5 s deliberate late-write check, plus setup/reopen and bounded run/process shutdown (10 s / 5 s)

/** A Stop between two calls of one response: the first call's return stands, the second — never started — is
 *  answered as not executed, so the record pairs every call and nothing is run later; reopened, the run's own
 *  transcript shows no call running; the next model, on another provider, reads both pairs. */
test('Stop between two calls of one response: the unstarted call reads cancelled (not executed), never runs, and no row spins after reopening', async () => {
  const settings = testSettings()
  const seenB: ModelMessage[][] = []
  const executed: string[] = []
  const modelB = stampedModel((messages: ModelMessage[]) => { seenB.push(messages); return modelResponse([textPart('B read the record')]) }, 'openai', 'gpt-y')
  state = await appState({ settings, models: {
    'scripted:a': stampedModel(() => modelResponse([toolCallPart('read_file', { path: 'calc.py' }, 'first-read'), toolCallPart('read_file', { path: 'README.md' }, 'second-read')]), 'anthropic', 'claude-x'),
    'scripted:b': modelB,
  } })
  const { session } = await openSession(state, buggyRepo())
  const tool = state.runs.agent.tools.get('read_file')!
  const read = tool.fn
  // the stop lands right after the first read returned — the production cancel — before the loop reaches the second
  state.runs.agent.tools.set('read_file', { ...tool, fn: async (ctx, args) => {
    executed.push(ctx.tool_call_id)
    const result = await read(ctx, args)
    expect(state!.runs.cancel(ctx.deps.run_id)).toBe(true)
    return result
  } })
  const run = await waitDone(state, (await state.runs.start(session, 'read calc.py, then README.md')).id)
  expect(run.status).toBe('cancelled')
  expect(executed).toEqual(['first-read'])
  const history = loadValue(JSON.parse(repo.getRunHistory(state.conn, run.id)!))
  expect(history.map((m) => m.kind)).toEqual(['request', 'response', 'request'])
  const returns = toolReturns(history)
  expect(returns.map((r) => [r.tool_call_id, (r.content as Record<string, unknown>).status])).toEqual([['first-read', 'ok'], ['second-read', 'cancelled']])
  expect((returns[0]!.content as Record<string, unknown>).path).toBe('calc.py')
  expect((returns[1]!.content as Record<string, unknown>).reason).toBe(NOT_STARTED_REASON)
  // the events: one call started, both answered — the second's answer says cancelled
  const events = repo.listEvents(state.conn, run.id)
  expect(events.filter((e) => e.event === 'tool_call').map((e) => e.data.tool_call_id)).toEqual(['first-read'])
  expect(events.filter((e) => e.event === 'tool_result').map((e) => [e.data.tool_call_id, e.data.status])).toEqual([['first-read', 'ok'], ['second-read', 'cancelled']])
  // the transcript from the record alone: nothing running, the second call cancelled
  const transcript = rebuildTranscript(repo.getRunHistory(state.conn, run.id))
  expect(transcript.filter((e) => e.kind === 'activity').map((e) => [e.toolCallId, e.result?.status, e.running])).toEqual([['first-read', 'ok', false], ['second-read', 'cancelled', false]])
  // reopened from the database, as the page reads it after a reload: the same
  await closeState(state)
  state = await appState({ settings, models: { 'scripted:b': modelB } })
  const row = repo.getRun(state.conn, run.id)!
  expect(row.status).toBe('cancelled')
  const again = rebuildTranscript(repo.getRunHistory(state.conn, run.id), 0, row.status)
  expect(again.filter((e) => e.kind === 'activity').map((e) => [e.toolCallId, e.result?.status, e.running])).toEqual([['first-read', 'ok', false], ['second-read', 'cancelled', false]])
  // the next model, on another provider, reads both calls with both returns; nothing is read again
  const next = await waitDone(state, (await state.runs.start(session, 'and then?', { model_id: 'scripted:b' })).id)
  expect(next.status).toBe('done')
  const calls = seenB[0]!.filter(isResponse).flatMap((m) => m.parts).filter(isToolCall)
  expect(calls.map((c) => c.tool_call_id)).toEqual(['first-read', 'second-read'])
  expect(toolReturns(seenB[0]!).map((r) => [r.tool_call_id, (r.content as Record<string, unknown>).status])).toEqual([['first-read', 'ok'], ['second-read', 'cancelled']])
  expect(repo.listEvents(state.conn, next.id).filter((e) => e.event === 'tool_call')).toHaveLength(0)
})

/** A Stop under the second of three calls: the first return stands, the stopped tool reads cancelled with the output
 *  that had arrived, the third — never started — reads not executed; nothing late, nothing run again. */
test('Stop during the second of three calls: ok, cancelled with output, not executed; nothing late, nothing run again', async () => {
  const command = 'python3 -c "import time; print(\'PARTIAL_READY\', flush=True); time.sleep(3); open(\'late.txt\', \'w\').write(\'bad\')"'
  const seenB: ModelMessage[][] = []
  state = await appState({ sandbox: true, models: {
    'scripted:a': stampedModel(steps([
      toolCallPart('read_file', { path: 'calc.py' }, 'read-first'),
      toolCallPart('bash', { command, wait_s: 30 }, 'long-second'),
      toolCallPart('write_file', { path: 'should-not-exist.txt', content: 'bad' }, 'write-third'),
    ], [textPart('not expected')]), 'anthropic', 'claude-x'),
    'scripted:b': stampedModel((messages: ModelMessage[]) => { seenB.push(messages); return modelResponse([textPart('observed')]) }, 'openai', 'gpt-y'),
  } })
  const { session, ws } = await openSession(state, buggyRepo())
  const run = await state.runs.start(session, 'three calls')
  let xs = repo.listExecutions(state.conn, { run_id: run.id })
  for (let i = 0; i < 200 && !xs.length; i += 1) { await sleep(50); xs = repo.listExecutions(state.conn, { run_id: run.id }) }
  expect(xs).toHaveLength(1)
  for (let i = 0; i < 200; i += 1) {
    if (state.processes.readOutput(xs[0]!.id, 'stdout', 0, 100).text.includes('PARTIAL_READY')) break
    await sleep(50)
  }
  expect(state.runs.cancel(run.id)).toBe(true)
  const finished = await waitDone(state, run.id, 15_000)
  expect(finished.status).toBe('cancelled')
  const history = loadValue(JSON.parse(repo.getRunHistory(state.conn, run.id)!))
  const returns = toolReturns(history)
  expect(returns.map((r) => [r.tool_name, (r.content as Record<string, unknown>).status])).toEqual([['read_file', 'ok'], ['bash', 'cancelled'], ['write_file', 'cancelled']])
  expect(String((returns[1]!.content as Record<string, unknown>).stdout)).toContain('PARTIAL_READY')
  expect((returns[2]!.content as Record<string, unknown>).reason).toBe(NOT_STARTED_REASON)
  expect(existsSync(join(ws.path, 'should-not-exist.txt'))).toBe(false)
  const transcript = rebuildTranscript(repo.getRunHistory(state.conn, run.id))
  expect(transcript.filter((e) => e.kind === 'activity').map((e) => [e.tool, e.result?.status, e.running])).toEqual([['read_file', 'ok', false], ['bash', 'cancelled', false], ['write_file', 'cancelled', false]])
  const events = repo.listEvents(state.conn, run.id)
  expect(events.filter((e) => e.event === 'tool_call').map((e) => e.data.tool)).toEqual(['read_file', 'bash'])
  expect(events.filter((e) => e.event === 'tool_result').map((e) => [e.data.tool, e.data.status])).toEqual([['read_file', 'ok'], ['bash', 'cancelled'], ['write_file', 'cancelled']])
  // the next model reads three pairs; nothing runs again, nothing late
  const next = await waitDone(state, (await state.runs.start(session, 'report only', { model_id: 'scripted:b' })).id)
  expect(next.status).toBe('done')
  const calls = seenB[0]!.filter(isResponse).flatMap((m) => m.parts).filter(isToolCall)
  const inherited = toolReturns(seenB[0]!)
  expect(calls.map((c) => c.tool_name)).toEqual(['read_file', 'bash', 'write_file'])
  expect(inherited.map((r) => r.tool_call_id)).toEqual(calls.map((c) => c.tool_call_id))
  expect(inherited.map((r) => (r.content as Record<string, unknown>).status)).toEqual(['ok', 'cancelled', 'cancelled'])
  expect(repo.listExecutions(state.conn, { run_id: next.id })).toHaveLength(0)
  await sleep(3500)
  expect(existsSync(join(ws.path, 'late.txt'))).toBe(false)
  expect(existsSync(join(ws.path, 'should-not-exist.txt'))).toBe(false)
})

test('a run whose row ended but whose run_finished event never got written gets the event at the next startup, from the row', async () => {
  const settings = testSettings()
  state = await appState({ settings, models: { 'scripted:a': scriptedModel(() => modelResponse([textPart('done')])) } })
  const { session } = await openSession(state, buggyRepo())
  const run = await waitDone(state, (await state.runs.start(session, 'finish')).id)
  expect(run.status).toBe('done')
  // the crash between the row and the event: the row stands, the event is not there
  state.conn.run("DELETE FROM run_events WHERE run_id=? AND event='run_finished'", [run.id])
  expect(repo.listEvents(state.conn, run.id).some((e) => e.event === 'run_finished')).toBe(false)
  await closeState(state)
  state = null
  const reopened = await appState({ settings })
  try {
    const counts = await reopened.runs.reconcile()
    expect(counts.unfinished_events).toEqual([run.id])
    const finished = repo.listEvents(reopened.conn, run.id).filter((e) => e.event === 'run_finished')
    expect(finished).toHaveLength(1)
    expect(finished[0]!.data).toMatchObject({ status: 'done', reconciled: true })
    expect((finished[0]!.data.receipt as Record<string, unknown>).status).toBe('done')
    expect(finished[0]!.seq).toBe(repo.maxEventSeq(reopened.conn, run.id))
    const row = repo.getRun(reopened.conn, run.id)!
    expect(row.status).toBe('done')                                                   // the row is what it was
    expect(row.receipt).toEqual(run.receipt)
    // the replay of the run ends with it, and a second startup adds nothing
    const replayed: string[] = []
    for await (const event of reopened.runs.subscribe(run.id)) replayed.push(event.event)
    expect(replayed.filter((e) => e === 'run_finished')).toHaveLength(1)
    expect((await reopened.runs.reconcile()).unfinished_events).toEqual([])
    expect(repo.listEvents(reopened.conn, run.id).filter((e) => e.event === 'run_finished')).toHaveLength(1)
  } finally {
    await closeState(reopened)
  }
})
