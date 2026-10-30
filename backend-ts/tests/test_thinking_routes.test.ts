/** A thinking level a route does not take is sent as the nearest one it does, and the records say what was sent:
 *  gpt-6.1-sol refused effort 'none' (it takes low, medium, high, xhigh, max), and OpenAI refuses effort 'minimal'
 *  beside its own web search — every run with Thinking off or minimal on that route ended in a 400. A route whose
 *  efforts are not known is sent the level as asked. */
import { afterEach, expect, test } from 'bun:test'
import * as repo from '../src/db/repo.ts'
import { DEFAULT_MODELS, ModelConfig } from '../src/config.ts'
import { modelSettings } from '../src/agent/runner.ts'
import { modelRequest, modelResponse, textPart, userPrompt } from '../src/llm/messages.ts'
import { OpenAIResponsesModel } from '../src/llm/providers.ts'
import { routeThinking } from '../src/llm/providers/common.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, testConfig, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

const SOL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

test('a level outside the route\'s efforts maps to the nearest one inside; unknown efforts leave it as asked', () => {
  expect(routeThinking('off', [...SOL_EFFORTS], false)).toBe('low')
  expect(routeThinking('minimal', [...SOL_EFFORTS], false)).toBe('low')
  for (const level of ['low', 'medium', 'high', 'xhigh']) expect(routeThinking(level, [...SOL_EFFORTS], false)).toBe(level)
  expect(routeThinking('xhigh', ['low', 'medium', 'high'], false)).toBe('high')
  expect(routeThinking('medium', ['none', 'high'], false)).toBe('high')             // two as near: the higher
  expect(routeThinking(null, [...SOL_EFFORTS], true)).toBeNull()                       // the provider's default stays alone
  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']) expect(routeThinking(level, null, false)).toBe(level)
  expect(routeThinking('high', ['max'], false)).toBe('max')                           // max is a supported unified level
})

test('beside the provider\'s web search, minimal is raised to low; nothing else changes', () => {
  expect(routeThinking('minimal', null, true)).toBe('low')
  expect(routeThinking('off', null, true)).toBe('off')
  expect(routeThinking('high', null, true)).toBe('high')
  const gpt = new OpenAIResponsesModel('gpt-y', { apiKey: 'k', baseUrl: 'http://openai.mock/v1' })
  const messages = [modelRequest([userPrompt('hi')], 'be brief')]
  const search = { function_tools: [], allow_text_output: true, thinking: 'minimal' as const, builtin_tools: [{ kind: 'web_search' as const, max_uses: 3 }] }
  expect(gpt.body(messages, {}, search).reasoning).toEqual({ effort: 'low', summary: 'auto' })
  expect(gpt.body(messages, {}, { ...search, builtin_tools: [] }).reasoning).toEqual({ effort: 'minimal', summary: 'auto' })
})

test('the default gpt-6.1-sol route carries its efforts; routes without evidence carry none', () => {
  const sol = new ModelConfig(DEFAULT_MODELS.find((m) => m.id === 'openai:gpt-6.1-sol') as never)
  expect(sol.reasoning_efforts).toEqual([...SOL_EFFORTS])
  expect(modelSettings(sol, 'off').thinking).toBe('low')
  expect(modelSettings(sol, 'minimal').thinking).toBe('low')
  expect(modelSettings(sol, 'high').thinking).toBe('high')
  // Gemini 4 Argon carries the three levels its official thinking guide names (checked 2026-10-14): asserted in
  // test_gemini_argon.test.ts
  for (const raw of DEFAULT_MODELS.filter((m) => m.id !== 'openai:gpt-6.1-sol' && m.id !== 'google:gemini-4-argon' && m.provider !== 'deepseek' && m.provider !== 'zhipu')) {
    const cfg = new ModelConfig(raw as never)
    expect(cfg.reasoning_efforts).toBeNull()
    expect(modelSettings(cfg, 'off').thinking).toBe(false)
  }
})

function capturing(seen: unknown[], profile: Record<string, unknown> = {}) {
  return scriptedModel((_m, info) => { seen.push(info.model_request_parameters.thinking); return modelResponse([textPart('ok')]) }, 'scripted', { supports_thinking: true, ...profile })
}

test('a run records the level asked and the level sent', async () => {
  const sol = new ModelConfig({ id: 'openai:sol', provider: 'openai', model: 'gpt-6.1-sol', auth: 'oauth', reasoning_efforts: [...SOL_EFFORTS] })
  const seen: unknown[] = []
  state = await appState({ config: { ...testConfig([sol]), default_model: sol.id }, models: { [sol.id]: capturing(seen) } })
  const { session } = await openSession(state, buggyRepo(), sol.id)
  const run = await waitDone(state, (await state.runs.start(session, 'hi', { thinking: 'off' })).id)
  expect(run.status).toBe('done')
  expect(seen[0]).toBe('low')
  expect(run.model_config_snapshot.thinking).toBe('off')
  expect(run.model_config_snapshot.thinking_sent).toBe('low')
  expect((run.manifest.model as Record<string, unknown>).thinking_sent).toBe('low')
  expect(repo.listEvents(state.conn, run.id).find((e) => e.event === 'run_started')!.data.thinking_sent).toBe('low')
})

test('on a route with the provider\'s web search, minimal is sent and recorded as low', async () => {
  const luna = new ModelConfig({ id: 'openai:luna', provider: 'openai', model: 'gpt-6-luna', auth: 'oauth' })
  const seen: unknown[] = []
  state = await appState({ config: { ...testConfig([luna]), default_model: luna.id }, models: { [luna.id]: capturing(seen, { builtin_tools: ['web_search'] }) } })
  const { session } = await openSession(state, buggyRepo(), luna.id)
  const run = await waitDone(state, (await state.runs.start(session, 'hi', { thinking: 'minimal' })).id)
  expect(seen[0]).toBe('low')
  expect(run.model_config_snapshot.thinking_sent).toBe('low')
  // A new conversation without the provider's search sends the same level as asked; the old conversation's
  // provider-tool frame cannot be silently changed when its route profile changes.
  state.model_overrides.set(luna.id, capturing(seen))
  seen.length = 0
  const again = await waitDone(state, (await state.runs.start(session, 'again', { thinking: 'minimal', fresh: true })).id)
  expect(seen[0]).toBe('minimal')
  expect(again.model_config_snapshot.thinking_sent).toBe('minimal')
})
