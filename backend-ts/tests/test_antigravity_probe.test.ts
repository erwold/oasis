import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { SUPPORTED_MODELS } from '../src/auth/antigravity_catalog.ts'
import { OAuthCredential } from '../src/auth/store.ts'
import { CONTROL_ENDPOINTS } from '../src/auth/oauth_antigravity.ts'
import { AntigravityCarrierError, antigravityToolSchema, wireToolArguments } from '../src/llm/providers/antigravity_schema.ts'
import { STREAM_URL } from '../src/llm/providers/antigravity.ts'
import { ModelAPIError, ModelHTTPError, TransportError } from '../src/llm/model.ts'
import type { FetchLike } from '../src/llm/http.ts'
import { buildAgent } from '../src/agent/agent.ts'
import { parseProbeOptions, runAntigravityProbe, safeAntigravityProbeFailure, SafeSseObserver } from '../scripts/antigravity_probe.ts'

const modelIds = () => Object.keys(SUPPORTED_MODELS)
const upstreamIds = () => Object.values(SUPPORTED_MODELS).flatMap(m => Object.values(m.upstream))
const route = () => 'antigravity:' + modelIds()[0]!
const grant = () => new OAuthCredential({ access: 'secret-access', refresh: 'secret-refresh', account_id: 'secret-account', project_id: 'secret-project', email: 'secret-email@example.invalid', authorization_id: 'secret-generation', expires_ms: Date.now() + 3600_000 })
const live = (...extra: string[]) => ['--live', '--auth-dir', '/synthetic-auth-do-not-read', ...extra]
const frame = (parts: unknown[], finish?: string, usage?: unknown) => ({ response: { responseId: 'secret-response-id', modelVersion: 'secret-model-version', candidates: [{ content: { role: 'model', parts }, ...(finish ? { finishReason: finish } : {}) }], ...(usage ? { usageMetadata: usage } : {}) } })
function sse(data: string, chunk = 7): Response {
  const bytes = new TextEncoder().encode(data)
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk)); c.close() } }), { headers: { 'content-type': 'text/event-stream' } })
}
const frames = (values: unknown[]) => sse(values.map(v => 'data: ' + JSON.stringify(v) + '\r\n\r\n').join(''))
type Failure = 'tool' | 'path' | 'offset' | 'nonce' | 'http' | 'metadata' | 'malformed' | 'network'
function fixture(failure?: Failure) {
  const bodies: Record<string, any>[] = []
  const paths: string[] = []
  const markers: string[] = []
  let accesses = 0
  let managers = 0
  const http: FetchLike = async (url, init) => {
    expect(init?.redirect).toBe('manual')
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBeNull()
    if (String(url) === CONTROL_ENDPOINTS.fetchAvailableModels) return Response.json({ models: Object.fromEntries(upstreamIds().map(id => [id, { supportsThinking: true, maxOutputTokens: 65536 }])) })
    expect(String(url)).toBe(STREAM_URL)
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    const declarations = body.request.tools[0].functionDeclarations
    expect(declarations.map((t: any) => t.name)).toEqual(buildAgent().toolDefinitions().map(t => t.name))
    expect(declarations.length).toBeGreaterThanOrEqual(21)
    if (failure === 'http') return Response.json({ error: { message: 'secret-refusal-echo secret-access secret-project' } }, { status: 429 })
    if (failure === 'network') throw new Error('secret-network-echo secret-access')
    if (failure === 'malformed') return sse('data: secret-invalid-json\n\n')
    if (failure === 'metadata') {
      const base = 'data: ' + JSON.stringify({ response: { traceId: '' } }) + '\n\n'
      return sse(base.replace('""', '"' + 'x'.repeat(192 - Buffer.byteLength(base)) + '"'))
    }
    const parts = body.request.contents.flatMap((c: any) => c.parts)
    const result = parts.find((p: any) => p.functionResponse)?.functionResponse?.response
    if (result) {
      const nonce = result.content
      expect(typeof nonce).toBe('string')
      markers.push(nonce)
      return frames([frame([{ text: failure === 'nonce' ? 'secret-wrong-answer' : nonce, thoughtSignature: 'secret-second-signature' }], 'STOP', { promptTokenCount: 130, candidatesTokenCount: 10, thoughtsTokenCount: 2, cachedContentTokenCount: 50 })])
    }
    const text = parts.filter((p: any) => typeof p.text === 'string').map((p: any) => p.text).join('\n')
    const path = JSON.parse(/Fixture path: ("[^\n]+")\n/.exec(text)![1]!)
    paths.push(path)
    expect(existsSync(path)).toBe(true)
    const name = failure === 'tool' ? 'write_file' : 'read_file'
    const schema = antigravityToolSchema(buildAgent().toolDefinitions().find(t => t.name === name)!.parameters_json_schema, body.model.startsWith('claude'))
    const callArgs = wireToolArguments({ path: failure === 'path' ? '/never-read-this-secret-path' : path, offset: failure === 'offset' ? 2 : 1, limit: 1 }, schema)
    return frames([
      frame([{ text: 'secret-thought-中文', thought: true, thoughtSignature: 'secret-first-signature' }]),
      frame([{ functionCall: { name, id: 'secret-native-id', args: callArgs }, thoughtSignature: 'secret-tool-signature' }], 'STOP'),
      { response: { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, thoughtsTokenCount: 3, cachedContentTokenCount: 0 } }, 'secret-unexpected-key': 'secret-unexpected-value' },
    ])
  }
  return {
    bodies, paths, markers,
    dependencies: {
      manager: (authDir: string) => { managers++; expect(authDir).toBe('/synthetic-auth-do-not-read'); return { access: async () => { accesses++; return grant() } } },
      fetchImpl: http,
    },
    counts: () => ({ accesses, managers }),
  }
}

test('Antigravity probe dry-run declares the full current tool surface without requesting credentials or network', async () => {
  const result = await runAntigravityProbe([], {
    manager: () => { throw new Error('credential access during dry-run') },
    fetchImpl: async () => { throw new Error('network during dry-run') },
  })
  expect(result.exitCode).toBe(0)
  expect(result.report.live).toBe(false)
  expect(result.report.selected_routes).toEqual(modelIds().map(id => 'antigravity:' + id))
  expect(result.report.tool_names).toEqual(buildAgent().toolDefinitions().map(t => t.name))
  expect(result.report.tools).toBeGreaterThanOrEqual(21)
  expect(result.report.tool_schema_sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(result.report.results).toEqual([])
  const withPath = await runAntigravityProbe(['--dry-run', '--auth-dir', '/must-not-read', '--route', route(), '--thinking', 'medium'], { manager: () => { throw new Error('must not instantiate') } })
  expect(withPath.report.requested_thinking).toBe('medium')
  expect(withPath.report.selected_routes).toEqual([route()])
})

test('Antigravity probe requires explicit absolute auth directory for live and validates route/effort before credentials', async () => {
  for (const args of [['--live'], ['--live', '--auth-dir', 'relative'], live('--dry-run'), live('--thinking', 'max'), live('--route', 'antigravity:unknown'), live('--timeout-ms', '1'), ['--secret-invalid-argument']]) {
    await expect(runAntigravityProbe(args, { manager: () => { throw new Error('unexpected credential access') } })).rejects.toThrow()
  }
  for (const thinking of ['default', 'low', 'medium', 'high'] as const) expect(parseProbeOptions(['--thinking', thinking]).thinking).toBe(thinking)
})

test('Antigravity probe uses the actual adapter for every route, full tools, two streams, nonce and private fixture cleanup', async () => {
  const fx = fixture()
  const result = await runAntigravityProbe(live('--thinking', 'medium'), fx.dependencies)
  expect(result.exitCode).toBe(0)
  expect(result.report.results).toHaveLength(modelIds().length)
  expect(fx.bodies).toHaveLength(2 * modelIds().length)
  expect(fx.counts().managers).toBe(1)
  expect(fx.counts().accesses).toBeGreaterThan(0)
  for (let i = 0; i < fx.bodies.length; i += 2) expect(fx.bodies[i]!.request.sessionId).toBe(fx.bodies[i + 1]!.request.sessionId)
  expect(new Set(fx.bodies.map(b => b.request.sessionId)).size).toBe(modelIds().length)
  for (const r of result.report.results) {
    expect(r).toMatchObject({ ok: true, stage: 'continuation_validation', tool_executed: true, nonce_verified: true })
    expect(r.rounds).toHaveLength(2)
    for (const round of r.rounds) {
      expect(round.http.map(h => h.operation)).toEqual(['catalog', 'inference'])
      expect(round.http.map(h => h.status)).toEqual([200, 200])
      expect(round.http[1]!.request).toMatchObject({ tools: result.report.tools, generationConfig: { maxOutputTokens: 8192 } })
      expect(round.http[1]!.sse?.complete).toBe(true)
      expect(round.http[1]!.sse!.bytes).toBeGreaterThan(0)
      expect(round.response?.finish_reason).toBe('stop')
    }
    const first = r.rounds[0]!, second = r.rounds[1]!
    expect(first.stream_events.thinking_delta).toBeGreaterThan(0)
    expect(first.stream_events.tool_delta).toBe(1)
    expect(first.http[1]!.sse).toMatchObject({ frames: 3, thought_parts: 1, tool_calls: 1, signatures: 2, invalid_json_frames: 0 })
    expect(first.response?.usage).toMatchObject({ input_tokens: 100, output_tokens: 8, cache_read_tokens: 0 })
    expect(second.stream_events.text_delta).toBe(1)
    expect(second.response?.usage).toMatchObject({ input_tokens: 130, output_tokens: 12, cache_read_tokens: 50 })
  }
  const output = JSON.stringify(result.report)
  expect(output).not.toContain('secret-')
  expect(output).not.toContain('/synthetic-auth')
  for (const path of fx.paths) { expect(existsSync(path)).toBe(false); expect(output).not.toContain(path) }
  for (const marker of fx.markers) expect(output).not.toContain(marker)
})

test('Antigravity probe accepts every documented effort without rewriting the production adapter settings', async () => {
  for (const thinking of ['default', 'low', 'medium', 'high'] as const) {
    const fx = fixture()
    const result = await runAntigravityProbe(live('--route', route(), '--thinking', thinking), fx.dependencies)
    expect(result.exitCode).toBe(0)
    expect(result.report.requested_thinking).toBe(thinking)
    const summary = result.report.results[0]!.rounds[0]!.http[1]!.request!.generationConfig
    expect(summary.maxOutputTokens).toBe(fx.bodies[0]!.request.generationConfig.maxOutputTokens)
    const wire = fx.bodies[0]!.request.generationConfig.thinkingConfig
    expect(summary.thinkingConfig?.thinkingLevel).toBe(wire.thinkingLevel ?? null)
    expect(summary.thinkingConfig?.thinkingBudget).toBe(wire.thinkingBudget ?? null)
  }
})

test('Antigravity probe refuses any tool or file outside its private read contract and never makes a second request', async () => {
  for (const failure of ['tool', 'path', 'offset'] as const) {
    const fx = fixture(failure)
    const result = await runAntigravityProbe(live('--route', route()), fx.dependencies)
    expect(result.exitCode).toBe(1)
    expect(fx.bodies).toHaveLength(1)
    expect(result.report.results[0]).toMatchObject({ ok: false, stage: 'tool_validation', tool_executed: false, nonce_verified: false, failure: { category: 'probe_contract' } })
    for (const path of fx.paths) expect(existsSync(path)).toBe(false)
    expect(JSON.stringify(result.report)).not.toContain('secret')
  }
})

test('Antigravity probe does not report a successful tool roundtrip unless the second answer proves nonce receipt', async () => {
  const fx = fixture('nonce')
  const result = await runAntigravityProbe(live('--route', route()), fx.dependencies)
  expect(result.exitCode).toBe(1)
  expect(fx.bodies).toHaveLength(2)
  expect(result.report.results[0]).toMatchObject({ stage: 'continuation_validation', tool_executed: true, nonce_verified: false, failure: { category: 'probe_contract' } })
  expect(JSON.stringify(result.report)).not.toContain('secret')
})

test('Antigravity probe diagnoses a metadata-only 192-byte SSE frame as incomplete, never as model success', async () => {
  const fx = fixture('metadata')
  const result = await runAntigravityProbe(live('--route', route()), fx.dependencies)
  expect(result.exitCode).toBe(1)
  const r = result.report.results[0]!
  expect(r).toMatchObject({ ok: false, stage: 'first_request', failure: { category: 'protocol' } })
  expect(r.rounds[0]!.http[1]!.sse).toMatchObject({ bytes: 192, frames: 1, candidates: 0, complete: true })
  expect(r.rounds[0]!.http[1]!.sse!.structures[0]).toMatchObject({ envelope: { keys: ['response'] }, response: { keys: ['traceId'] } })
  expect(fx.bodies).toHaveLength(1)
})

test('Antigravity probe preserves safe HTTP/network/invalid-stream diagnostics without rejection-body or error leakage', async () => {
  for (const [failure, category, status] of [['http', 'rate_limit', 429], ['network', 'transport', null], ['malformed', 'protocol', null]] as const) {
    const fx = fixture(failure)
    const result = await runAntigravityProbe(live('--route', route()), fx.dependencies)
    expect(result.exitCode).toBe(1)
    expect(result.report.results[0]!.failure).toEqual({ category, status })
    expect(fx.bodies).toHaveLength(1)
    expect(JSON.stringify(result.report)).not.toContain('secret')
    const http = result.report.results[0]!.rounds[0]!.http[1]!
    if (failure === 'http') expect(http.status).toBe(429)
    if (failure === 'network') expect(http.transport_error).toBe(true)
    if (failure === 'malformed') expect(http.sse!.invalid_json_frames).toBe(1)
  }
  expect(safeAntigravityProbeFailure(new AntigravityCarrierError())).toEqual({ status: null, category: 'tool_encoding' })
  for (const error of [new AntigravityCarrierError(), new Error('secret'), new ModelAPIError('secret-model', 'secret'), new TransportError('secret-kind', 'secret'), new ModelHTTPError(403, 'secret-model', 'secret')]) expect(JSON.stringify(safeAntigravityProbeFailure(error))).not.toContain('secret')
})

test('safe SSE structure observer handles UTF-8 splits, final un-delimited data, malformed/unknown frames and bounded unknown keys', () => {
  const observer = new SafeSseObserver()
  const text = [
    ': heartbeat\n\n',
    'data: ' + JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: '私密', thought: true, thoughtSignature: 'secret-signature' }] }, finishReason: 'secret-unrecognized-reason' }], 'secret-key': 'secret-value' } }) + '\r\n\r\n',
    'data: broken-secret-json\n\n',
    'data: []\n\n',
    'data: [DONE]\n\n',
    'data: ' + JSON.stringify({ error: { message: 'secret-error' } }),
  ].join('')
  const bytes = new TextEncoder().encode(text)
  for (let i = 0; i < bytes.length; i++) observer.feed(bytes.slice(i, i + 1))
  observer.end()
  expect(observer.result).toMatchObject({ bytes: bytes.length, frames: 5, done_frames: 1, invalid_json_frames: 1, non_object_frames: 1, thought_parts: 1, signatures: 1, error_frames: 1, complete: true, finish_reasons: { unknown: 1 } })
  expect(observer.result.structures[0]!.response!.unknown_keys).toBe(1)
  expect(JSON.stringify(observer.result)).not.toContain('secret')
  expect(JSON.stringify(observer.result)).not.toContain('私密')
})



test('safe SSE observer bounds oversized frames and resumes at the real blank line across CRLF byte boundaries', () => {
  const observer = new SafeSseObserver()
  const oversized = 'data: ' + 'x'.repeat(1_048_577)
  observer.feed(new TextEncoder().encode(oversized))
  observer.feed(new TextEncoder().encode('\r'))
  observer.feed(new TextEncoder().encode('\n'))
  observer.feed(new TextEncoder().encode('data: still-same-secret-frame\r\n'))
  observer.feed(new TextEncoder().encode('\r'))
  observer.feed(new TextEncoder().encode('\n'))
  observer.feed(new TextEncoder().encode('data: {"response":{"usageMetadata":{}}}\n\n'))
  observer.end()
  expect(observer.result).toMatchObject({ frames: 2, oversized_frames: 1, invalid_json_frames: 0, complete: true })
  expect(observer.result.structures).toHaveLength(1)
  expect(observer.result.structures[0]!.response!.keys).toEqual(['usageMetadata'])
  expect(JSON.stringify(observer.result)).not.toContain('secret')
})
