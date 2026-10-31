import { afterEach, expect, test } from 'bun:test'
import { ContextKeeper, type RequestSeam } from '../src/agent/history.ts'
import { isRequest, isUserPrompt, modelRequest, modelResponse, textPart, toolCallPart, userPrompt, userText } from '../src/llm/messages.ts'
import { scriptedModel } from '../src/llm/scripted.ts'
import { rebuildTranscript } from '../src/agent/transcript.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import * as repo from '../src/db/repo.ts'
import { appState, buggyRepo, closeState, openSession, setModel, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

const messages = [modelRequest([userPrompt('Read calc.py')])]
const seam = (): RequestSeam => ({ model: scriptedModel(() => modelResponse([textPart('Summary')])), settings: {}, params: { function_tools: [], allow_text_output: true, thinking: null }, instructions: '', observed: null })

test('start is called only at the summary request, not below threshold, in backoff, on an invalid tail or with no request budget', async () => {
  let starts = 0
  const onStart = () => { starts++ }
  const keeper = new ContextKeeper({ window: 120_000, output_reserve: 16_000 })
  await keeper.maybeCompact(messages, seam(), [], onStart)
  expect(starts).toBe(0)
  const over = { ...seam(), observed: { input_tokens: 100_000, messages: 1 } }
  const backedOff = new ContextKeeper({ window: 120_000, output_reserve: 16_000, trigger: 104_000 })
  expect((await backedOff.maybeCompact(messages, over, [], onStart))[1]).toBeNull()
  const [, skipped] = await keeper.maybeCompact(messages, { ...over, requests_left: 0 }, [], onStart)
  expect(skipped?.status).toBe('skipped')
  await keeper.maybeCompact([...messages, modelResponse([textPart('end')])], over, [], onStart)
  expect(starts).toBe(0)
  const observed: string[] = []
  const model = scriptedModel(() => { observed.push('request'); return modelResponse([textPart('Summary')]) })
  const [, done] = await keeper.maybeCompact(messages, { ...over, model }, [], () => { starts++; observed.push('start') })
  expect(starts).toBe(1)
  expect(observed).toEqual(['start', 'request'])
  expect(done?.status).toBe('compacted')
})

for (const outcome of ['compacted', 'failed', 'cancelled'] as const) {
  test(`the runner persists a matching start/end pair while the summary is ${outcome}`, async () => {
    state = await appState()
    const { session } = await openSession(state, buggyRepo())
    let entered!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    let normal = 0
    setModel(state, 'scripted:a', scriptedModel(async (history) => {
      const tail = history.at(-1)!
      if (isRequest(tail) && tail.parts.some((p) => isUserPrompt(p) && userText(p) === PROMPT_TEXT['compaction.request'])) {
        entered()
        await held
        if (outcome === 'failed') throw new Error('synthetic summary failure')
        return modelResponse([textPart('<summary>Read calc.py; explain add.</summary>')])
      }
      normal++
      return normal === 1
        ? modelResponse([toolCallPart('read_file', { path: 'calc.py' }, 'read')], { usage: { input_tokens: 100_000, output_tokens: 10 } as never })
        : modelResponse([textPart('Done')])
    }))
    const run = await state.runs.start(session, 'Read calc.py')
    try {
      await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('summary not entered')), 10_000))])
      const progress = repo.listEvents(state.conn, run.id).filter((e) => e.event.startsWith('context_compact'))
      expect(progress.map((e) => e.event)).toEqual(['context_compacting'])
      expect(progress[0]!.data.compaction_id).toBeString()
      if (outcome === 'cancelled') state.runs.cancel(run.id)
      else release()
      const done = await waitDone(state, run.id)
      expect(done.status).toBe(outcome === 'cancelled' ? 'cancelled' : 'done')
      const events = repo.listEvents(state.conn, run.id).filter((e) => e.event.startsWith('context_compact'))
      expect(events.map((e) => e.event)).toEqual(['context_compacting', 'context_compacted'])
      expect(events[1]!.data.compaction_id).toBe(events[0]!.data.compaction_id)
      expect(events[1]!.data.status).toBe(outcome)
      const hydrated = rebuildTranscript(repo.getRunHistory(state.conn, run.id), 0, done.status, [], [], [], repo.listCompactionEvents(state.conn, run.id))
      const maintenance = hydrated.filter((entry) => entry.kind === 'compaction')
      expect(maintenance).toHaveLength(1)
      expect(maintenance[0]!.compaction?.status).toBe(outcome)
      expect(maintenance[0]!.running).toBe(false)
      expect(JSON.stringify(hydrated)).not.toContain('The conversation so far was summarized')
      if (outcome === 'compacted') expect(events[1]!.data.after_tokens as number).toBeLessThan(events[1]!.data.estimate_tokens as number)
    } finally { release() }
  })
}


test('transcript hydration pairs reports at their absolute history boundary, keeps failures without markers, and closes orphan starts', () => {
  const history = JSON.stringify([
    modelRequest([userPrompt('inherited')]), modelResponse([textPart('old answer')]),
    modelRequest([userPrompt('new task')]), modelResponse([textPart('new answer')]),
  ])
  const events: repo.StoredEvent[] = [
    { seq: 2, event: 'context_compacting', data: { compaction_id: 'c1', covers: 3 } },
    { seq: 3, event: 'context_compacted', data: { compaction_id: 'c1', covers: 3, status: 'failed' } },
    { seq: 4, event: 'context_compacting', data: { compaction_id: 'c2', covers: 4 } },
  ]
  const entries = rebuildTranscript(history, 2, 'error', [], [], [], events)
  expect(entries.map((entry) => entry.kind)).toEqual(['user', 'compaction', 'agent', 'compaction'])
  expect(entries.filter((entry) => entry.kind === 'compaction').map((entry) => [entry.compaction?.status, entry.running])).toEqual([['failed', false], ['interrupted', false]])
  expect(JSON.stringify(entries)).not.toContain('old answer')
  expect(rebuildTranscript(null, 0, 'cancelled', [], [], [], events).filter((entry) => entry.kind === 'compaction')).toHaveLength(2)
})
