/** The thinking level the person picks reaches the model and the records. */

import { afterEach, expect, test } from 'bun:test'
import * as repo from '../src/db/repo.ts'
import { modelResponse, textPart } from '../src/llm/messages.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

function capturing(seen: Record<string, unknown>[], thinks = true) {
  return scriptedModel((messages, info) => { seen.push({ ...info.model_settings, thinking: info.model_request_parameters.thinking }); return modelResponse([textPart('ok')]) }, 'scripted', { supports_thinking: thinks })
}

test('the thinking level reaches the model and the records', async () => {
  const seen: Record<string, unknown>[] = []
  state = await appState({ models: { 'scripted:a': capturing(seen) } })
  const { session } = await openSession(state, buggyRepo())
  const run = await waitDone(state, (await state.runs.start(session, 'say ok', { thinking: 'high' })).id)
  expect(run.status).toBe('done')
  expect(seen[0]!.thinking).toBe('high')
  expect(seen[0]!.max_tokens as number).toBeGreaterThan(0)
  expect(run.model_config_snapshot.thinking).toBe('high')
  expect((run.manifest.model as Record<string, unknown>).thinking).toBe('high')
  expect(repo.listEvents(state.conn, run.id).find((e) => e.event === 'run_started')!.data.thinking).toBe('high')
  seen.length = 0
  const off = await waitDone(state, (await state.runs.start(session, 'again', { thinking: 'off' })).id)
  expect(off.status).toBe('done')
  expect(seen[0]!.thinking).toBe(false)
  expect(off.model_config_snapshot.thinking).toBe('off')
  seen.length = 0
  const plain = await waitDone(state, (await state.runs.start(session, 'once more')).id)
  expect(plain.status).toBe('done')
  expect(seen[0]!.thinking).toBeNull()
  expect(plain.model_config_snapshot.thinking).toBeNull()
  // a model that cannot think: the level is dropped before the request; the record still says what was asked
  state.model_overrides.set('scripted:a', capturing(seen, false))
  seen.length = 0
  const deaf = await waitDone(state, (await state.runs.start(session, 'and again', { thinking: 'high' })).id)
  expect(deaf.status).toBe('done')
  expect(seen[0]!.thinking).toBeNull()
  expect(deaf.model_config_snapshot.thinking).toBe('high')
})
