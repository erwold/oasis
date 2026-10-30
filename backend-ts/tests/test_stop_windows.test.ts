/** A Stop in the windows where a failure could pass for the run's own: while the model's answer streams (the
 *  provider breaks the stream on the Stop) and while the run waits to recover from a dropped connection. The run
 *  ends cancelled, not in error; no request is made after the Stop; the words the answer had shown stay in its
 *  record. */

import { afterEach, expect, test } from 'bun:test'
import * as repo from '../src/db/repo.ts'
import { emptyUsage, modelResponse, textPart, toolCallPart, type ModelMessage, type ModelResponse } from '../src/llm/messages.ts'
import { TransportError, type Model, type ModelRequestParameters, type ModelSettings, type RequestContext, type StreamEvent, type StreamedResponse } from '../src/llm/model.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, sleep, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting'); await sleep(10) }
}

/** A model whose first answer streams its words, then waits until the run's Stop breaks the stream (as a provider's
 *  connection does when the request is aborted); a second request, were one made, would say so. */
class StoppedMidAnswer implements Model {
  readonly model_name = 'mid'
  readonly system = null
  readonly profile = { supports_thinking: false }
  calls = 0
  waiting = false
  async request(): Promise<ModelResponse> { throw new Error('stream only') }
  async requestStream(_m: ModelMessage[], _s: ModelSettings, _p: ModelRequestParameters, ctx?: RequestContext): Promise<StreamedResponse> {
    this.calls += 1
    const response = modelResponse([textPart('Words shown before the stop.'), toolCallPart('write_file', { path: 'x.txt', content: 'x' }, 'w1')])
    const self = this
    let shown = modelResponse([])
    const events = async function* (): AsyncGenerator<StreamEvent, void, undefined> {
      const words = response.parts[0]!
      yield { type: 'part_start', index: 0, part: words }
      yield { type: 'part_end', index: 0, part: words }
      shown = modelResponse([words])
      self.waiting = true
      await new Promise<void>((_resolve, reject) => ctx?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    }
    return { model_name: 'mid', usage: () => emptyUsage(), get: () => shown, events }
  }
}

test('a Stop that breaks the streaming answer ends the run cancelled; the words it had shown stay in the record, no call runs', async () => {
  const model = new StoppedMidAnswer()
  state = await appState({ models: { 'scripted:a': model } })
  const { session, ws } = await openSession(state, buggyRepo())
  const run = await state.runs.start(session, 'go')
  await until(() => model.waiting)
  state.runs.cancel(run.id)
  const row = await waitDone(state, run.id)
  expect(row.status).toBe('cancelled')
  expect(model.calls).toBe(1)
  expect(repo.getRunHistory(state.conn, run.id) ?? '').toContain('Words shown before the stop.')
  expect(await Bun.file(`${ws.path}/x.txt`).exists()).toBe(false)
})

test('a Stop while the run waits to recover from a dropped connection ends it cancelled, with no request after the Stop', async () => {
  let calls = 0
  state = await appState({ models: { 'scripted:a': scriptedModel(() => {
    calls += 1
    if (calls === 1) return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, 'r1')])
    throw new TransportError('ReadTimeout', 'dropped')
  }) } })
  ;(state.runs as unknown as { transport_backoff_s: number[] }).transport_backoff_s = [2, 2, 2]
  const { session } = await openSession(state, buggyRepo())
  const run = await state.runs.start(session, 'go')
  await until(() => calls === 2)
  await sleep(100)
  state.runs.cancel(run.id)
  const row = await waitDone(state, run.id)
  await sleep(2200)
  expect(row.status).toBe('cancelled')
  expect(row.error).toBeNull()
  expect(calls).toBe(2)
}, 20_000)

test('a Stop while its command is still being started (the sandbox warming its tools) kills the command once it is made', async () => {
  let release!: () => void
  const warming = new Promise<void>((resolve) => { release = resolve })
  state = await appState({ sandbox: true, models: { 'scripted:a': scriptedModel((messages: ModelMessage[]) =>
    messages.length < 3 ? modelResponse([toolCallPart('bash', { command: 'echo START; sleep 30; echo END', wait_s: 60 }, 'b1')]) : modelResponse([textPart('done')])) } })
  let warmingNow = false
  state.processes.xcrun.warm = async () => { warmingNow = true; await warming; return [] }
  const { session } = await openSession(state, buggyRepo())
  const run = await state.runs.start(session, 'go')
  await until(() => warmingNow)
  expect(repo.listExecutions(state.conn, { run_id: run.id })).toEqual([])          // no process yet: it is being started
  state.runs.cancel(run.id)
  release()
  const row = await waitDone(state, run.id)
  expect(row.status).toBe('cancelled')
  const executions = repo.listExecutions(state.conn, { run_id: run.id })
  expect(executions).toHaveLength(1)
  await until(() => !state!.processes.isRunning(executions[0]!.id))
  expect(repo.listExecutions(state.conn, { run_id: run.id })[0]!.cancelled).toBe(true)
}, 20_000)
