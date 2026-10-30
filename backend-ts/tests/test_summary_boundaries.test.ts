/** The summary request is one of the run's requests: it goes with the run's Stop (the request aborted, the run
 *  cancelled, nothing after it) and counts toward the run's request budget (a budget reached by a summary leaves
 *  the one report-only closing request, never another request whose tools run). (Real HTTP: Codex's
 *  qa_main_summary_boundaries.) */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as repo from '../src/db/repo.ts'
import { isRequest, isUserPrompt, loadValue, modelResponse, toolReturns, textPart, toolCallPart, userText, userTexts, type ModelMessage } from '../src/llm/messages.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import { ModelHTTPError } from '../src/llm/model.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, sleep, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
const prior = process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS
// a 40 000-token window: the threshold is 40 000 − 4 096 − 8 000; a first request counted at 31 000 is over it
beforeEach(() => { process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = '40000' })
afterEach(async () => {
  if (prior === undefined) delete process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS; else process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = prior
  if (state) await closeState(state)
  state = null
})

const asksSummary = (messages: ModelMessage[]) => {
  const last = messages[messages.length - 1]!
  return isRequest(last) && last.parts.some((p) => isUserPrompt(p) && userText(p) === PROMPT_TEXT['compaction.request'])
}
const counted = (parts: Parameters<typeof modelResponse>[0]) => modelResponse(parts, { usage: { input_tokens: 31_000, output_tokens: 10 } as never })

test('a Stop during the summary request aborts it and ends the run cancelled; nothing runs after it', async () => {
  state = await appState({ sandbox: true })
  const { session, ws } = await openSession(state, buggyRepo())
  let summaryStarted = false
  let after = 0
  setModel(state, 'scripted:a', scriptedModel(async (messages) => {
    if (asksSummary(messages)) { summaryStarted = true; await sleep(30_000); return modelResponse([textPart('<summary>too late</summary>')]) }
    if (summaryStarted) { after += 1; return modelResponse([toolCallPart('write_file', { path: 'after-stop.txt', content: 'LATE' }, 'late')]) }
    return counted([toolCallPart('read_file', { path: 'calc.py' }, 'r1')])
  }))
  const run = await state.runs.start(session, 'read, then more')
  for (let i = 0; i < 200 && !summaryStarted; i += 1) await sleep(10)
  expect(summaryStarted).toBe(true)
  const stoppedAt = Date.now()
  expect(state.runs.cancel(run.id)).toBe(true)
  const done = await waitDone(state, run.id, 5_000)
  expect(Date.now() - stoppedAt).toBeLessThan(3_000)                             // not the summary's 30 s
  expect(done.status).toBe('cancelled')
  expect(after).toBe(0)
  expect(existsSync(join(ws.path, 'after-stop.txt'))).toBe(false)
})

test('a request budget reached by the summary leaves only the report-only closing request: no tool of a later request runs', async () => {
  state = await appState({ sandbox: true })
  const { session, ws } = await openSession(state, buggyRepo())
  const kinds: string[] = []
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    if (asksSummary(messages)) { kinds.push('summary'); return modelResponse([textPart('<summary>calc.py was read.</summary>')]) }
    const closing = userTexts(messages).some((t) => t.includes('No tools are available'))
    if (closing) { kinds.push('closing'); return modelResponse([textPart('closing report')]) }
    kinds.push('ordinary')
    return kinds.length === 1 ? counted([toolCallPart('read_file', { path: 'calc.py' }, 'r1')]) : modelResponse([toolCallPart('write_file', { path: 'after-budget.txt', content: 'OVER' }, 'w1')])
  }))
  const run = await waitDone(state, (await state.runs.start(session, 'read then write', { budget: { requests: 2 } })).id)
  expect(kinds).toEqual(['ordinary', 'summary', 'closing'])
  expect(existsSync(join(ws.path, 'after-budget.txt'))).toBe(false)
  expect((run.receipt.mechanical as Record<string, unknown>).budget_reached).toBe('requests 2 of 2')
  expect(run.receipt.final_text).toBe('closing report')
  expect(repo.listEvents(state.conn, run.id).some((e) => e.event === 'context_compacted')).toBe(true)
})

test('with room in the budget the summary is made and the run goes on with its tools', async () => {
  state = await appState({ sandbox: true })
  const { session } = await openSession(state, buggyRepo())
  const kinds: string[] = []
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    if (asksSummary(messages)) { kinds.push('summary'); return modelResponse([textPart('<summary>calc.py was read.</summary>')]) }
    kinds.push('ordinary')
    return kinds.length === 1 ? counted([toolCallPart('read_file', { path: 'calc.py' }, 'r1')]) : modelResponse([textPart('done')])
  }))
  const run = await waitDone(state, (await state.runs.start(session, 'read', { budget: { requests: 6 } })).id)
  expect(kinds).toEqual(['ordinary', 'summary', 'ordinary'])
  expect(run.status).toBe('done')
  expect((run.receipt.mechanical as Record<string, unknown>).budget_reached ?? null).toBeNull()
})

test('a budget with no request left asks no summary: the closing request is made as it is', async () => {
  state = await appState({ sandbox: true })
  const { session } = await openSession(state, buggyRepo())
  const kinds: string[] = []
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    if (asksSummary(messages)) { kinds.push('summary'); return modelResponse([textPart('<summary>x</summary>')]) }
    if (userTexts(messages).some((t) => t.includes('No tools are available'))) { kinds.push('closing'); return modelResponse([textPart('closing report')]) }
    kinds.push('ordinary')
    return counted([toolCallPart('read_file', { path: 'calc.py' }, 'r1')])
  }))
  const run = await waitDone(state, (await state.runs.start(session, 'read', { budget: { requests: 1 } })).id)
  expect(kinds).toEqual(['ordinary', 'closing'])
  expect((run.receipt.mechanical as Record<string, unknown>).budget_reached).toBe('requests 1 of 1')
})

test('a summary the provider refuses is a request spent: the next is the closing one, and nothing of it runs', async () => {
  state = await appState({ sandbox: true })
  const { session, ws } = await openSession(state, buggyRepo())
  const kinds: string[] = []
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    if (asksSummary(messages)) { kinds.push('summary'); throw new ModelHTTPError(400, 'scripted-a', { error: { message: 'summary refused' } }) }
    if (userTexts(messages).some((t) => t.includes('No tools are available'))) { kinds.push('closing'); return modelResponse([toolCallPart('write_file', { path: 'after-budget.txt', content: 'OVER' }, 'w2')]) }
    kinds.push('ordinary')
    return kinds.length === 1 ? counted([toolCallPart('read_file', { path: 'calc.py' }, 'r1')]) : modelResponse([toolCallPart('write_file', { path: 'after-budget.txt', content: 'OVER' }, 'w1')])
  }))
  const run = await waitDone(state, (await state.runs.start(session, 'read then write', { budget: { requests: 2 } })).id)
  expect(kinds).toEqual(['ordinary', 'summary', 'closing'])
  expect(existsSync(join(ws.path, 'after-budget.txt'))).toBe(false)                // the closing turn's call is refused too
  expect((run.receipt.mechanical as Record<string, unknown>).budget_reached).toBe('requests 2 of 2')
})

test('a tool-call budget of one runs that one call; a second call of the same response is refused', async () => {
  state = await appState({ sandbox: true })
  const { session, ws } = await openSession(state, buggyRepo())
  let n = 0
  setModel(state, 'scripted:a', scriptedModel(() => (n++ === 0
    ? modelResponse([toolCallPart('write_file', { path: 'first.txt', content: '中文🙂' }, 'w1'), toolCallPart('write_file', { path: 'second.txt', content: 'NO' }, 'w2')])
    : modelResponse([textPart('closing report')]))))
  const run = await waitDone(state, (await state.runs.start(session, 'write', { budget: { tool_calls: 1 } })).id)
  expect(readFileSync(join(ws.path, 'first.txt'), 'utf8')).toBe('中文🙂')
  expect(existsSync(join(ws.path, 'second.txt'))).toBe(false)
  const results = repo.listEvents(state.conn, run.id).filter((e) => e.event === 'tool_result').map((e) => [e.data.tool_call_id, e.data.status])
  expect(results[0]).toEqual(['w1', 'ok'])
  // the second call never ran: in the record it is answered as not run
  const returns = toolReturns(loadValue(JSON.parse(repo.getRunHistory(state.conn, run.id)!)))
  const second = returns.find((p) => p.tool_call_id === 'w2')
  expect(second === undefined || (second.content as Record<string, unknown>).status !== 'ok').toBe(true)
  expect((run.receipt.mechanical as Record<string, unknown>).budget_reached).toBe('tool_calls 1 of 1')
})
