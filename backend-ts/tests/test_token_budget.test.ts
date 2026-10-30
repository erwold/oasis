/** A run's token budget is the whole run's: a recovery that starts a new segment (a dropped connection) does not
 *  start the count again, and a summary the context keeper asked for spends it like any request. Once the spend
 *  reaches the line, no request but the one report-only closing request is made. */

import { afterEach, expect, test } from 'bun:test'
import * as repo from '../src/db/repo.ts'
import { ModelConfig } from '../src/config.ts'
import { modelResponse, textPart, toolCallPart, userTexts, type ModelMessage } from '../src/llm/messages.ts'
import { TransportError } from '../src/llm/model.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, testConfig, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

const u = (input: number, output: number) => ({ input_tokens: input, output_tokens: output, cache_read_tokens: 0, cache_write_tokens: 0 })
const isSummary = (m: ModelMessage[]) => userTexts(m).some((t) => t.includes('Summarize the conversation so far'))
const isClosing = (m: ModelMessage[]) => userTexts(m).some((t) => t.includes('No tools are available'))

/** The requests the run made after its recorded spend reached the line. */
function requestsPastTheLine(runId: string, line: number): number {
  const rows = state!.conn.all('SELECT input_tokens, output_tokens FROM model_requests WHERE run_id = ? ORDER BY seq', [runId]) as { input_tokens: number; output_tokens: number }[]
  let total = 0
  let crossed = -1
  rows.forEach((r, i) => { total += r.input_tokens + r.output_tokens; if (crossed < 0 && total >= line) crossed = i })
  return crossed < 0 ? 0 : rows.length - crossed - 1
}

test('a dropped connection does not start the token count again: the line is met where the whole run reaches it', async () => {
  let n = 0
  const kinds: string[] = []
  state = await appState({ models: { 'scripted:a': scriptedModel((m) => {
    n += 1
    if (isClosing(m)) { kinds.push('closing'); return modelResponse([textPart('closing report')], { usage: u(25, 5) }) }
    if (n === 3) { kinds.push('dropped'); throw new TransportError('ReadTimeout', 'stream dropped') }
    kinds.push('read')
    return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, `r${n}`)], { usage: u(25, 5) })
  }) } })
  ;(state.runs as unknown as { transport_backoff_s: number[] }).transport_backoff_s = [0, 0, 0]
  const { session } = await openSession(state, buggyRepo())
  const run = await waitDone(state, (await state.runs.start(session, 'read on', { budget: { total_tokens: 100 } })).id)
  // 30 tokens a response: the fourth reaches 120 and its call is not run; then the closing report, and nothing more
  expect(kinds).toEqual(['read', 'read', 'dropped', 'read', 'read', 'closing'])
  expect(repo.listEvents(state.conn, run.id).filter((e) => e.event === 'tool_result' && e.data.status === 'ok')).toHaveLength(3)
  expect(requestsPastTheLine(run.id, 100)).toBe(1)
  expect(run.receipt.final_text).toBe('closing report')
}, 30_000)

test('a summary spends the token budget: a request past the line it reached is not made, the closing one aside', async () => {
  const config = testConfig([new ModelConfig({ id: 'scripted:a', label: 'A', provider: 'anthropic', model: 'a', api_key_env: 'OASIS_TEST_KEY_A', context_window: 12_000, window_source: 'test' })])
  const kinds: string[] = []
  let n = 0
  state = await appState({ config, models: { 'scripted:a': scriptedModel((m) => {
    n += 1
    if (isSummary(m)) { kinds.push('summary'); return modelResponse([textPart('<summary>read big.txt</summary>')], { usage: u(9000, 100) }) }
    if (isClosing(m)) { kinds.push('closing'); return modelResponse([textPart('closing report')], { usage: u(500, 10) }) }
    kinds.push('read')
    return modelResponse([toolCallPart('read_file', { path: 'big.txt' }, `r${n}`)], { usage: u(3000 * n, 10) })
  }) } })
  const { session, ws } = await openSession(state, buggyRepo())
  await Bun.write(`${ws.path}/big.txt`, Array.from({ length: 390 }, (_, i) => `line ${i} ${'lorem ipsum dolor sit amet '.repeat(4)}`).join('\n'))
  const run = await waitDone(state, (await state.runs.start(session, 'read big', { budget: { total_tokens: 9_000 } })).id, 30_000)
  expect(kinds).toContain('summary')
  expect(kinds.at(-1)).toBe('closing')
  // the summary took the spend over the line: the next request is the closing one, and it is the last
  expect(kinds.slice(kinds.indexOf('summary') + 1)).toEqual(['closing'])
  expect(requestsPastTheLine(run.id, 9_000)).toBe(1)
}, 30_000)
