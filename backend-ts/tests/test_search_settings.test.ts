import { afterEach, expect, test } from 'bun:test'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { GrantsSchema } from '@oasis-code/contract'
import { searchRoutes } from '../src/api/search.ts'
import type { Api } from '../src/api/common.ts'
import { readSearchSettings, saveSearchSettings } from '../src/search/settings.ts'
import { AnthropicModel, WEB_SEARCH_TOOL } from '../src/llm/providers/anthropic.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart } from '../src/llm/messages.ts'
import * as repo from '../src/db/repo.ts'
import { appState, buggyRepo, closeState, openSession, setModel, scriptedModel, testConfig, waitDone, type AppState } from './harness.ts'
import { ModelConfig } from '../src/config.ts'
import { Route } from './helpers.ts'
import { anthropicStream } from './providers_fixtures.ts'
let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

test('settings are atomic, nonsecret, persistent and invalid saved values fail closed', async () => {
  state = await appState()
  expect(readSearchSettings(state.store)).toEqual({ engine: 'automatic' })
  saveSearchSettings(state.store, { engine: 'deepseek' })
  expect(readSearchSettings(state.store)).toEqual({ engine: 'deepseek' })
  const path = join(dirname(state.store.root), 'web-search.json')
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ engine: 'deepseek' })
  expect(statSync(path).mode & 0o777).toBe(0o600)
  writeFileSync(path, '{broken')
  expect(() => readSearchSettings(state!.store)).toThrow('could not be read')
})
test('settings API local-only writes, strict enum and no-store reads', async () => {
  state = await appState()
  const app = searchRoutes({ state } as Api)
  app.onError((e, c) => c.json({ error: e.message }, ('status' in e ? e.status : 500) as 400))
  const req = (body: unknown, local: boolean) => app.request('/api/settings/web-search', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, { requestIP: () => ({ address: local ? '127.0.0.1' : '192.0.2.1' }) })
  expect((await req({ engine: 'deepseek' }, false)).status).toBe(403)
  expect((await req({ engine: 'other' }, true)).status).toBe(422)
  expect((await req({ engine: 'deepseek', key: 'not-accepted' }, true)).status).toBe(422)
  expect((await req({ engine: 'deepseek' }, true)).status).toBe(200)
  const response = await app.request('/api/settings/web-search')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual({ engine: 'deepseek' })
})
test('explicit engine overrides native search only in new frames; existing native frame refuses mismatched selection', async () => {
  state = await appState()
  const words = anthropicStream({ model: 'claude-x', stop: 'end_turn', blocks: [{ type: 'text', pieces: ['done'] }] })
  const route = new Route([words, words, words, words])
  setModel(state, 'scripted:a', new AnthropicModel('claude-x', { apiKey: 'placeholder', baseUrl: 'http://anthropic.mock', fetchImpl: route.fetch }))
  const { session } = await openSession(state, buggyRepo())
  repo.setSessionGrants(state.conn, session.id, { ...GrantsSchema.parse({}), network: true })
  const current = () => repo.getSession(state!.conn, session.id)!
  const start = async (fresh = false) => waitDone(state!, (await state!.runs.start(current(), 'hello', { fresh })).id)
  expect((await start()).status).toBe('done')
  saveSearchSettings(state.store, { engine: 'deepseek' })
  const refused = await start()
  expect(refused.status).toBe('error')
  expect(refused.error).toContain('Web Search is set to deepseek')
  expect(route.requests).toHaveLength(1)
  saveSearchSettings(state.store, { engine: 'automatic' })
  expect((await start()).status).toBe('done')
  expect(route.requests[1]!.tools).toEqual(route.requests[0]!.tools)
  saveSearchSettings(state.store, { engine: 'deepseek' })
  expect((await start(true)).status).toBe('done')
  saveSearchSettings(state.store, { engine: 'web' })
  expect((await start(true)).status).toBe('done')
  const hasNative = (i: number) => (route.requests[i]!.tools as { type?: string }[]).some((t) => t.type === WEB_SEARCH_TOOL)
  expect([0, 1, 2, 3].map(hasNative)).toEqual([true, true, false, false])
})
test('DeepSeek keeps network gate and returns explicit validation error without HTML fallback', async () => {
  state = await appState(); saveSearchSettings(state.store, { engine: 'deepseek' })
  const { session } = await openSession(state, buggyRepo())
  let out: Record<string, unknown> = {}
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    const result = lastToolReturn(messages, 'web_search')
    if (!result) return modelResponse([toolCallPart('web_search', { query: 'q'.repeat(129), max_results: 8 }, '')])
    out = result as Record<string, unknown>; return modelResponse([textPart('done')])
  }))
  repo.setSessionGrants(state.conn, session.id, { ...GrantsSchema.parse({}), network: false })
  await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'search')).id)
  expect(out.status).toBe('refused_by_policy')
  repo.setSessionGrants(state.conn, session.id, { ...GrantsSchema.parse({}), network: true })
  await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'search', { fresh: true })).id)
  expect(out.status).toBe('error'); expect(out.engine).toBe('deepseek')
  expect(out.attempts).toEqual([])
})

test('Automatic: a DeepSeek route searches with DeepSeek Search; another route without a search of its own uses the result pages', async () => {
  state = await appState({ config: testConfig([
    new ModelConfig({ id: 'scripted:a', label: 'Scripted A', provider: 'anthropic', model: 'scripted-a', api_key_env: 'OASIS_TEST_KEY_A' }),
    new ModelConfig({ id: 'deepseek:scripted', label: 'Scripted DeepSeek', provider: 'deepseek', model: 'scripted-ds', api_key_env: 'OASIS_TEST_KEY_DS' }),
  ]) })
  expect(readSearchSettings(state.store)).toEqual({ engine: 'automatic' })
  const { session } = await openSession(state, buggyRepo(), 'deepseek:scripted')
  repo.setSessionGrants(state.conn, session.id, { ...GrantsSchema.parse({}), network: true })
  let out: Record<string, unknown> = {}
  const searching = scriptedModel((messages) => {
    const result = lastToolReturn(messages, 'web_search')
    if (!result) return modelResponse([toolCallPart('web_search', { query: 'q'.repeat(129), max_results: 8 }, '')])
    out = result as Record<string, unknown>; return modelResponse([textPart('done')])
  })
  setModel(state, 'deepseek:scripted', searching)
  await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'search')).id)
  // the oversized query is DeepSeek Search's own refusal: no result page was fetched
  expect(out.engine).toBe('deepseek'); expect(out.status).toBe('error'); expect(out.attempts).toEqual([])
  setModel(state, 'scripted:a', searching)
  repo.setSessionModel(state.conn, session.id, 'scripted:a')
  out = {}
  await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'search', { fresh: true })).id)
  expect((out.attempts as { engine: string }[])[0]?.engine).toBe('duckduckgo')
})
