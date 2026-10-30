/** The app as the perf benches drive it: createApp (the real Hono app, routes, state, runner, watches) over an
 *  isolated data directory, requests made in process (app.request: no socket), models that are the real provider
 *  mappings over an in-process fetch interceptor (the "provider stub"), and a synthetic Git repository. Commands
 *  run through the test suite's passthrough runtime in sandbox mode (the product gives them their own HOME; this
 *  harness never sets HOME itself). */

import { PERF_ROOT, assertIsolated } from './env.ts'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ModelConfig, Settings } from '../../../src/config.ts'
import * as repo from '../../../src/db/repo.ts'
import type { FetchLike } from '../../../src/llm/http.ts'
import type { Model } from '../../../src/llm/model.ts'
import { AnthropicModel } from '../../../src/llm/providers.ts'
import { createApp, type App } from '../../../src/main.ts'
import type { WatchServiceOptions } from '../../../src/agent/watches/service.ts'
import { FAKE_FULL, PassthroughRuntime, testConfig } from '../../../tests/harness.ts'

export const TOKEN = 'perf-token'
export const HEADERS: Record<string, string> = { 'x-oasis-code-token': TOKEN, origin: 'http://localhost', 'content-type': 'application/json' }
export const MODEL_ID = 'stub:anthropic'

let n = 0
export function freshDataDir(): string {
  const dir = join(PERF_ROOT, `app-${++n}`)
  assertIsolated(dir)
  mkdirSync(dir, { recursive: true })
  return dir
}

export async function perfApp(opts: { watches?: WatchServiceOptions; models?: Record<string, Model>; sse_heartbeat_ms?: number; context_window?: number } = {}): Promise<App> {
  const settings = new Settings({ data_dir: join(freshDataDir(), 'data'), host: '127.0.0.1', port: 0, session_token: TOKEN })
  const config = testConfig([new ModelConfig({ id: MODEL_ID, label: 'Stub Anthropic', provider: 'anthropic', model: 'stub-model', api_key_env: 'OASIS_PERF_NO_KEY', context_window: opts.context_window ?? 200_000, window_source: 'perf' })])
  config.default_model = MODEL_ID
  return createApp(settings, config, {
    probe: false, runtime: new PassthroughRuntime(), isolation: { ...FAKE_FULL, runtime: 'passthrough' }, model_overrides: opts.models ?? {},
    ...(opts.watches ? { watches: opts.watches } : {}), ...(opts.sse_heartbeat_ms ? { sse_heartbeat_ms: opts.sse_heartbeat_ms } : {}),
  })
}

let repos = 0
/** a synthetic repository (no global/system git config read; HOME untouched) */
export function syntheticRepo(files = 20): string {
  const base = join(PERF_ROOT, `repo-${++repos}`)
  mkdirSync(base)
  const src = join(base, 'userrepo')
  mkdirSync(join(src, 'src'), { recursive: true })
  for (let i = 0; i < files; i++) writeFileSync(join(src, 'src', `mod_${i}.ts`), `export const v${i} = ${i}\n`.repeat(20))
  writeFileSync(join(src, 'README.md'), '# synthetic perf fixture\n')
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'perf', GIT_AUTHOR_EMAIL: 'perf@invalid', GIT_COMMITTER_NAME: 'perf', GIT_COMMITTER_EMAIL: 'perf@invalid' }
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'fixture']]) {
    const r = spawnSync('git', args, { cwd: src, env, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }
  return src
}

export async function perfSession(app: App, repoPath: string) {
  const state = app.state
  const project = await state.workspaces.importProject('perf', repoPath)
  const session = repo.createSession(state.conn, project.id, 'perf', MODEL_ID)
  const ws = await state.workspaces.createWorkspace(project, session.id)
  repo.setSessionWorkspace(state.conn, session.id, ws.id)
  return { project, session: repo.getSession(state.conn, session.id)!, ws }
}

export function request(app: App, method: string, path: string, json?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: HEADERS }
  if (json !== undefined) init.body = JSON.stringify(json)
  return Promise.resolve(app.app.request(new URL(path, 'http://localhost').toString(), init))
}

// ---- the provider stub -------------------------------------------------------------------------------------

export function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

export function anthropicText(text: string, inputTokens = 100): string {
  return sse([
    { type: 'message_start', message: { id: 'msg_perf', type: 'message', role: 'assistant', model: 'stub-model', content: [], stop_reason: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...chunk(text, 64).map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: Math.ceil(text.length / 4) } },
    { type: 'message_stop' },
  ])
}

export function anthropicToolUse(id: string, name: string, input: Record<string, unknown>, inputTokens = 100): string {
  return sse([
    { type: 'message_start', message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'stub-model', content: [], stop_reason: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading the file next.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ])
}

function chunk(s: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out.length ? out : ['']
}

export interface StubCall { at: number; bytes: number; messages: number; signal: AbortSignal | null }
/** The provider played in process: every call is timestamped (performance.now()) as the mapping hands it over. */
export class ProviderStub {
  readonly calls: StubCall[] = []
  constructor(public answer: (call: StubCall, body: Record<string, unknown>) => Response | Promise<Response>) {}
  fetch: FetchLike = async (_input, init) => {
    const at = performance.now()
    const raw = String(init?.body ?? '{}')
    const body = JSON.parse(raw) as Record<string, unknown>
    const call: StubCall = { at, bytes: Buffer.byteLength(raw), messages: Array.isArray(body.messages) ? body.messages.length : 0, signal: (init?.signal as AbortSignal | undefined) ?? null }
    // only numbers are kept per call (no body, no signal, no request): the stub holds nothing of a request after it
    this.calls.push({ at: call.at, bytes: call.bytes, messages: call.messages, signal: null })
    return this.answer(call, body)
  }
  model(): AnthropicModel {
    return new AnthropicModel('stub-model', { apiKey: 'perf-not-a-key', baseUrl: 'http://provider.stub.invalid', fetchImpl: this.fetch, maxRetries: 0 })
  }
}

export const streamResponse = (body: string, status = 200): Response => new Response(body, { status, headers: { 'content-type': status === 200 ? 'text/event-stream' : 'application/json' } })
