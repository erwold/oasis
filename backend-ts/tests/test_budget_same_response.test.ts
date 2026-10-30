/** Two calls in one response, a tool-call budget of one: the first runs, the second is answered as not run, and the
 *  closing request — not yet made when the line was reached — is made, once; the run ends with its report. The
 *  record keeps every call paired with its return, so the next message of the session reads a whole history.
 *  (Codex's budget-same-response observation on the new main.) */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as repo from '../src/db/repo.ts'
import { isToolCall, isToolReturn, loadValue, modelResponse, textPart, toolCallPart, userTexts, type ModelMessage } from '../src/llm/messages.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

const pairs = (messages: ModelMessage[]) => ({
  calls: messages.flatMap((m) => (m.kind === 'response' ? m.parts.filter(isToolCall).map((p) => p.tool_call_id) : [])),
  returns: messages.flatMap((m) => (m.kind === 'request' ? m.parts.filter(isToolReturn).map((p) => p.tool_call_id) : [])),
})

test('w1 + w2 in one response under tool_calls 1: w1 runs, w2 is answered as not run, the closing request is made and its report ends the run; the next message reads a paired history', async () => {
  state = await appState()
  const { session, ws } = await openSession(state, buggyRepo())
  const seen: { closing: boolean; messages: ModelMessage[] }[] = []
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    const closing = userTexts(messages).some((t) => t.includes('No tools are available'))
    seen.push({ closing, messages })
    if (closing) return modelResponse([textPart('closing report')])
    if (seen.length === 1) {
      return modelResponse([toolCallPart('write_file', { path: 'first.txt', content: 'FIRST' }, 'w1'), toolCallPart('write_file', { path: 'second.txt', content: 'SECOND' }, 'w2')])
    }
    return modelResponse([textPart('next answer')])
  }))
  const run = await waitDone(state, (await state.runs.start(session, 'write two', { budget: { tool_calls: 1 } })).id)
  expect(run.status).toBe('done')
  expect(readFileSync(join(ws.path, 'first.txt'), 'utf8')).toBe('FIRST')
  expect(existsSync(join(ws.path, 'second.txt'))).toBe(false)
  expect(seen.map((s) => s.closing)).toEqual([false, true])                        // the closing request was made, once
  expect(pairs(seen[1]!.messages).returns).toEqual(['w1', 'w2'])                   // it reads both calls answered
  expect(run.receipt.final_text).toBe('closing report')
  expect((run.receipt.mechanical as Record<string, unknown>).budget_reached).toBe('tool_calls 1 of 1')

  const history = loadValue(JSON.parse(repo.getRunHistory(state.conn, run.id)!))
  const { calls, returns } = pairs(history)
  expect(calls).toEqual(['w1', 'w2'])
  expect(returns).toEqual(calls)                                                   // every call paired in the record
  const w2 = history.flatMap((m) => (m.kind === 'request' ? m.parts.filter(isToolReturn) : [])).find((p) => p.tool_call_id === 'w2')!
  expect(JSON.stringify(w2.content)).toContain('was not run')

  // the next message of the session builds on that record
  const next = await waitDone(state, (await state.runs.start(session, 'and now?')).id)
  expect(next.status).toBe('done')
  const read = pairs(seen.at(-1)!.messages)
  expect(read.calls).toEqual(['w1', 'w2'])
  expect(read.returns).toEqual(read.calls)
})
