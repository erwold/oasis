// Load the application graph statically before the registry's lazy require() modules (Bun text SQL imports).
import '../src/main.ts'
import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from './helpers.ts'
import { CredentialStore, OAuthCredential, TokenManager, setDefaultAuthDir } from '../src/auth/store.ts'
import { Deferred } from '../src/auth/callback.ts'
import { LoginManager } from '../src/auth/web_login.ts'
import * as oauth from '../src/auth/oauth_antigravity.ts'
import { authorizationKey, parseCatalog, resolveAntigravityModel, SUPPORTED_MODELS } from '../src/auth/antigravity_catalog.ts'
import { AntigravityModel, antigravitySigner, antigravityUsage, STREAM_URL } from '../src/llm/providers/antigravity.ts'
import { antigravityToolSchema } from '../src/llm/providers/antigravity_schema.ts'
import { modelRequest, toolReturn, userPrompt, type ModelMessage } from '../src/llm/messages.ts'
import { parametersSchema, specs } from '../src/agent/tools/registry.ts'
import { parseAntigravity, UsageService } from '../src/auth/usage.ts'
import { AuthProviderIdSchema } from '@oasis-code/contract'
import type { FetchLike } from '../src/auth/http.ts'
import type { ModelRequestParameters } from '../src/llm/model.ts'

// a synthetic OAuth client: the real one is never in the source (oauthClient reads it at run time)
process.env.OASIS_CODE_ANTIGRAVITY_CLIENT_ID = 'synthetic-client.apps.googleusercontent.com'
process.env.OASIS_CODE_ANTIGRAVITY_CLIENT_SECRET = 'synthetic-client-secret'
const MODEL = 'gemini-3.8-flash-tiered'
const UPSTREAM = 'gemini-3.8-flash-medium'
const EXPECTED_USER_AGENT = 'oasis-code/antigravity-oauth (compatible; antigravity/hub/2.23.0)'
const upstreamIds = () => Object.values(SUPPORTED_MODELS).flatMap(m => Object.values(m.upstream))
const grant = () => new OAuthCredential({ access: 'synthetic-access', refresh: 'synthetic-refresh', expires_ms: Date.now() + 3600_000, project_id: 'synthetic-project', account_id: 'synthetic-account', authorization_id: 'synthetic-generation', authorized_at_ms: 1 })
const manager = () => ({ access: async () => grant() })
const params: ModelRequestParameters = { function_tools: [{ name: 'lookup', description: 'Look up', parameters_json_schema: { type: 'object', properties: { x: { type: ['string', 'null'] } } } }], allow_text_output: true, thinking: 'medium' }
const messages = [modelRequest([userPrompt('hello')])]
function sse(frames: unknown[], chunk = 7): Response {
  const data = new TextEncoder().encode(frames.map(f => `data: ${JSON.stringify(f)}\r\n\r\n`).join(''))
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < data.length; i += chunk) c.enqueue(data.slice(i, i + chunk)); c.close() } }), { headers: { 'content-type': 'text/event-stream' } })
}
const frame = (parts: unknown[], finish?: string, usage?: unknown) => ({ response: { candidates: [{ content: { role: 'model', parts }, ...(finish ? { finishReason: finish } : {}) }], ...(usage ? { usageMetadata: usage } : {}) } })
function fakeApi(frames: unknown[], inspect?: (body: Record<string, any>) => void): FetchLike {
  return async (url, init) => {
    expect(init?.redirect).toBe('manual')
    expect(new Headers(init?.headers).get('user-agent')).toBe(EXPECTED_USER_AGENT)
    if (String(url).endsWith(':fetchAvailableModels')) return Response.json({ models: Object.fromEntries(upstreamIds().map(id => [id, {}])) })
    expect(String(url)).toBe(STREAM_URL)
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBeNull()
    inspect?.(JSON.parse(String(init?.body)))
    return sse(frames)
  }
}
const logins: LoginManager[] = []
afterEach(async () => { for (const login of logins.splice(0)) await login.close(); setDefaultAuthDir(tempDir('ag-isolated-')) })

test('OAuth URL uses offline consent, PKCE, state, fixed endpoint and loopback redirect', () => {
  const url = new URL(oauth.authorizeUrl({ state: 'nonce', challenge: 'challenge' }))
  expect(url.origin).toBe('https://accounts.google.com')
  expect(url.searchParams.get('access_type')).toBe('offline')
  expect(url.searchParams.get('prompt')).toBe('consent')
  expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  expect(url.searchParams.get('state')).toBe('nonce')
  for (const redirect_uri of ['https://evil.invalid/oauth-callback', 'http://localhost:51121/other', 'http://localhost:51121/oauth-callback?x=1']) expect(() => oauth.authorizeUrl({ state: 's', redirect_uri })).toThrow()
  expect(AuthProviderIdSchema.parse('antigravity')).toBe('antigravity')
})

test('the OAuth client comes from the environment, else from the data folder; with neither, signing in says what is missing', () => {
  const saved = { id: process.env.OASIS_CODE_ANTIGRAVITY_CLIENT_ID, secret: process.env.OASIS_CODE_ANTIGRAVITY_CLIENT_SECRET }
  try {
    expect(new URL(oauth.authorizeUrl({ state: 's' })).searchParams.get('client_id')).toBe('synthetic-client.apps.googleusercontent.com')
    delete process.env.OASIS_CODE_ANTIGRAVITY_CLIENT_ID; delete process.env.OASIS_CODE_ANTIGRAVITY_CLIENT_SECRET
    const dir = tempDir('ag-client-')
    setDefaultAuthDir(dir)
    expect(() => oauth.authorizeUrl({ state: 's' })).toThrow(oauth.CLIENT_FILE)
    writeFileSync(join(dir, oauth.CLIENT_FILE), JSON.stringify({ client_id: 'file-client.apps.googleusercontent.com', client_secret: 'file-secret' }))
    expect(oauth.oauthClient()).toEqual({ id: 'file-client.apps.googleusercontent.com', secret: 'file-secret' })
    expect(new URL(oauth.authorizeUrl({ state: 's' })).searchParams.get('client_id')).toBe('file-client.apps.googleusercontent.com')
  } finally {
    process.env.OASIS_CODE_ANTIGRAVITY_CLIENT_ID = saved.id; process.env.OASIS_CODE_ANTIGRAVITY_CLIENT_SECRET = saved.secret
  }
})

test('Google refresh preserves omitted refresh token, accepts rotation, and redacts rejection bodies', async () => {
  for (const rotate of [false, true]) {
    const result = await oauth.refreshToken(async (url, init) => {
      expect(String(url)).toBe(oauth.TOKEN_URL); expect(init?.redirect).toBe('manual')
      expect(new URLSearchParams(String(init?.body)).get('grant_type')).toBe('refresh_token')
      return Response.json({ access_token: 'new-synthetic', expires_in: 3600, ...(rotate ? { refresh_token: 'rotated-synthetic' } : {}) })
    }, 'old-synthetic')
    expect(result.refresh).toBe(rotate ? 'rotated-synthetic' : 'old-synthetic')
    expect(JSON.stringify(result)).not.toContain('synthetic')
  }
  await expect(oauth.refreshToken(async () => Response.json({ error: 'invalid_grant', secret: 'do-not-show' }, { status: 400 }), 'r')).rejects.toThrow('login required')
})

test('login exact redirect/state validation, identity/project, private storage and logout', async () => {
  const store = new CredentialStore(join(tempDir('ag-login-'), 'auth.json'))
  const seen: string[] = []
  const login = new LoginManager(store, { callback_ports: { antigravity: 0 }, fetchImpl: async (url, init) => {
    seen.push(String(url)); expect(init?.redirect).toBe('manual')
    if (String(url) === oauth.TOKEN_URL) return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600 })
    if (String(url) === oauth.USERINFO_URL) return Response.json({ id: 'account', email: 'a@example.invalid' })
    return Response.json({ cloudaicompanionProject: { id: 'project' } })
  } }); logins.push(login)
  const session = await login.start('antigravity')
  await expect(login.submit(session.id, `https://evil.invalid/oauth-callback?code=x&state=${session.state_token}`)).rejects.toThrow('does not match')
  await expect(login.submit(session.id, `${session.redirect_uri}?code=x&state=wrong`)).rejects.toThrow('state must match')
  await login.submit(session.id, `${session.redirect_uri}?code=x&state=${session.state_token}`); await session.task
  expect(session.state).toBe('done')
  expect(store.read('antigravity')?.project_id).toBe('project')
  expect(store.read('antigravity')?.authorization_id).toBeTruthy()
  expect(seen).toHaveLength(3)
  expect(JSON.stringify(login.accounts())).not.toContain('synthetic-access')
  await login.logout('antigravity'); expect(store.read('antigravity')).toBeNull()
})

test('cancel during token exchange never stores the late result', async () => {
  const store = new CredentialStore(join(tempDir('ag-cancel-'), 'auth.json'))
  const started = new Deferred<void>(), finish = new Deferred<Response>()
  const login = new LoginManager(store, { callback_ports: { antigravity: 0 }, fetchImpl: async url => {
    if (String(url) === oauth.TOKEN_URL) { started.resolve(); return finish.promise }
    if (String(url) === oauth.USERINFO_URL) return Response.json({ id: 'account' })
    return Response.json({ cloudaicompanionProject: 'project' })
  } }); logins.push(login)
  const session = await login.start('antigravity')
  await login.submit(session.id, `${session.redirect_uri}?code=x&state=${session.state_token}`); await started.promise
  const cancelled = login.cancel(session.id)
  finish.resolve(Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }))
  await cancelled
  expect(session.state).toBe('cancelled'); expect(store.read('antigravity')).toBeNull()
})

test('refresh concurrency and logout preserve the account generation and never resurrect a login', async () => {
  const store = new CredentialStore(join(tempDir('ag-refresh-'), 'auth.json'))
  const old = grant().with({ expires_ms: 1 })
  await store.modify('antigravity', async () => old)
  const entered = new Deferred<void>(), finish = new Deferred<OAuthCredential>(); let calls = 0
  const tm = new TokenManager(store, { antigravity: async () => { calls++; entered.resolve(); return finish.promise } })
  const first = tm.access('antigravity'); await entered.promise
  const second = tm.access('antigravity')
  finish.resolve(grant().with({ refresh: 'rotated', project_id: null, authorization_id: null }))
  const [a, b] = await Promise.all([first, second])
  expect(calls).toBe(1); expect(a.project_id).toBe(old.project_id); expect(b.authorization_id).toBe(old.authorization_id)
  expect(authorizationKey(a)).toBe(authorizationKey(old))
  await store.modify('antigravity', async () => old)
  const entered2 = new Deferred<void>(), finish2 = new Deferred<OAuthCredential>()
  const tm2 = new TokenManager(store, { antigravity: async () => { entered2.resolve(); return finish2.promise } })
  const access = tm2.access('antigravity'); await entered2.promise
  const logout = store.delete('antigravity'); finish2.resolve(grant()); await access; await logout
  expect(store.read('antigravity')).toBeNull(); await expect(tm2.access('antigravity')).rejects.toThrow('no usable')
}, 10_000)

test('catalog publishes only supported exact IDs, no image/search models; quota missing is unknown', () => {
  const routes = parseCatalog({ models: { [UPSTREAM]: { maxTokens: 1048576 }, 'new-unknown': {}, 'gemini-3.1-flash-image': {} } })
  expect(routes.map(r => r.id)).toEqual([`antigravity:${MODEL}`]); expect(routes[0]!.context_window).toBe(1048576)
  expect(routes[0]!.window_source).toBe('Antigravity fetchAvailableModels')
  const claudeFallback = parseCatalog({ models: { 'claude-opus-5-5-high': {} } })[0]!
  expect(claudeFallback.context_window).toBe(1000000)
  expect(claudeFallback.window_source).toContain('not official')
  expect(parseCatalog({ models: {} })).toEqual([]); expect(() => parseCatalog({})).toThrow()
  expect(parseAntigravity({ models: { [UPSTREAM]: {}, 'claude-opus-5-5-medium': { quotaInfo: { remainingFraction: .25, resetTime: '2026-10-19T00:00:00Z' } }, 'claude-sonnet-5-5-medium': { quotaInfo: { remainingFraction: -1 } } } }).map(w => w.used_percent)).toEqual([null, 75, null])
})

test('endpoint isolation refuses credentials before asking token manager', async () => {
  let accesses = 0
  for (const url of ['https://evil.invalid/v1internal:streamGenerateContent?alt=sse', `${STREAM_URL}&extra=1`, STREAM_URL.replace('https:', 'http:'), STREAM_URL.replace('daily-cloudcode-pa.', 'cloudcode-pa.'), STREAM_URL.replace('googleapis.com', 'sandbox.googleapis.com'), STREAM_URL.replace('streamGenerateContent', 'generateContent'), `${STREAM_URL}#fragment`, STREAM_URL.replace('daily-cloudcode-pa.googleapis.com', '127.0.0.1')]) {
    await expect(antigravitySigner({ access: async () => { accesses++; return grant() } }, { url: new URL(url), headers: new Headers() })).rejects.toThrow('unexpected endpoint')
  }
  expect(accesses).toBe(0)
})

test('every supported route sends the complete registry tools and maps parallel calls/results with signed boundaries', async () => {
  const all: ModelRequestParameters = { ...params, function_tools: specs().map(s => ({ name: s.name, description: s.summary, parameters_json_schema: parametersSchema(s) })) }
  expect(all.function_tools.length).toBeGreaterThan(20)
  for (const id of Object.keys(SUPPORTED_MODELS)) {
    const calls = [{ functionCall: { name: 'lookup', id: 'native-1', args: { type: 'data', enum: [1], properties: 'business' } }, thoughtSignature: 'signature-call' }, { functionCall: { name: 'lookup', id: 'native-2', args: { x: 2 } } }]
    const model = new AntigravityModel(id, manager(), { fetchImpl: fakeApi([
      frame([{ text: '思考', thought: true, thoughtSignature: 'signature-thinking' }]), frame([{ text: '你好', thoughtSignature: 'signature-text' }, ...calls], 'STOP', { promptTokenCount: 100, cachedContentTokenCount: 20, candidatesTokenCount: 7, thoughtsTokenCount: 3 }),
    ], body => { expect(body.request.tools[0].functionDeclarations).toHaveLength(all.function_tools.length); expect(body.request.tools[0].functionDeclarations[0].parameters).toBeDefined(); expect(JSON.stringify(body)).not.toContain('parametersJsonSchema'); expect(body.request.continuationToken).toBeUndefined() }) })
    const response = await model.request(messages, {}, all)
    expect(response.parts.filter(p => p.part_kind === 'tool-call')).toHaveLength(2)
    expect(response.usage).toMatchObject({ input_tokens: 100, cache_read_tokens: 20, output_tokens: 10 })
    const history: ModelMessage[] = [...messages, response, modelRequest([toolReturn('lookup', { ok: 1 }, 'native-1'), toolReturn('lookup', { ok: 2 }, 'native-2')])]
    const own = model.body(history, {}, all, grant()) as any
    expect(own.request.contents[1].parts).toHaveLength(4)
    expect(own.request.contents[1].parts[2].functionCall.args).toEqual({ type: 'data', enum: [1], properties: 'business' })
    expect(own.request.contents[2].parts.map((p: any) => p.functionResponse.id)).toEqual(['native-1', 'native-2'])
    expect(JSON.stringify(own)).toContain('signature-thinking')
    for (const changed of [grant().with({ account_id: 'other' }), grant().with({ authorization_id: 'new' })]) expect(JSON.stringify(model.body(history, {}, all, changed))).not.toContain('signature-')
    const other = new AntigravityModel(id === MODEL ? 'claude-opus-5-5-high' : MODEL, manager())
    expect(JSON.stringify(other.body(history, {}, all, grant()))).not.toContain('signature-')
  }
}, 10_000)

test('schema nullable and refs remain native; complex unions use explicit reversible carriers', () => {
  const raw = { type: 'object', additionalProperties: false, required: ['type'], properties: { type: { type: ['string', 'null'] }, enum: { enum: [1, 2], type: 'integer' }, u: { anyOf: [{ type: 'string' }, { type: 'object', properties: { a: { type: 'boolean' } } }] }, r: { $ref: '#/$defs/thing' } }, $defs: { thing: { type: 'number' } } }
  const before = JSON.stringify(raw)
  const gemini = antigravityToolSchema(raw, false) as any, claude = antigravityToolSchema(raw, true) as any
  expect(gemini.properties.type).toMatchObject({ type: 'STRING', nullable: true })
  expect(gemini.properties.u.description).toContain('JSON TEXT CARRIER')
  expect(claude.properties.u.anyOf).toBeUndefined(); expect(claude.properties.u.description).toContain('JSON TEXT CARRIER')
  expect(gemini.properties.r.type).toBe('NUMBER'); expect(gemini.properties.enum.type).toBe('INTEGER')
  expect(JSON.stringify(raw)).toBe(before)
})

test('usage cumulative snapshots do not sum twice; malformed counts remain unknown', async () => {
  const usage = { promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 2, cachedContentTokenCount: 3 }
  const model = new AntigravityModel(MODEL, manager(), { fetchImpl: fakeApi([frame([{ text: 'a' }], undefined, usage), frame([{ text: 'b' }], 'STOP', usage), { response: { usageMetadata: usage } }]) })
  expect((await model.request(messages, {}, params)).usage).toMatchObject({ input_tokens: 12, output_tokens: 7, cache_read_tokens: 3 })
  expect(antigravityUsage({})).toBeNull(); expect(antigravityUsage({ promptTokenCount: -1 })).toBeNull(); expect(antigravityUsage({ promptTokenCount: 1, cachedContentTokenCount: 2 })).toBeNull()
})

test('incomplete/error streams and HTTP refusal are not a successful response or secret leak', async () => {
  for (const frames of [[frame([{ text: 'partial' }])], [{ error: { message: 'synthetic-secret' } }], [frame([{ inlineData: { data: 'unsupported' } }], 'STOP')]]) {
    await expect(new AntigravityModel(MODEL, manager(), { fetchImpl: fakeApi(frames) }).request(messages, {}, params)).rejects.toThrow('Antigravity')
  }
  for (const status of [302, 403, 429]) {
    const http = fakeApi([])
    const model = new AntigravityModel(MODEL, manager(), { fetchImpl: async (url, init) => String(url) === STREAM_URL ? Response.json({ error: { message: 'synthetic-secret' } }, { status }) : http(url, init) })
    try { await model.request(messages, {}, params); throw new Error('expected rejection') } catch (error) { expect(String(error)).not.toContain('synthetic-secret'); expect(String(error)).toContain(String(status)) }
  }
})

test('usage and control requests keep the fixed catalog-compatible user agent and never ChatGPT identity header', async () => {
  expect(oauth.ANTIGRAVITY_USER_AGENT).toBe(EXPECTED_USER_AGENT)
  const store = new CredentialStore(join(tempDir('ag-usage-'), 'auth.json')); await store.modify('antigravity', async () => grant())
  const service = new UsageService(new TokenManager(store, {}), null, { fetchImpl: async (url, init) => {
    expect(new Headers(init?.headers).get('user-agent')).toBe(EXPECTED_USER_AGENT)
    if (String(url) === oauth.CONTROL_ENDPOINTS.loadCodeAssist) {
      expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('manual')
      expect(new Headers(init?.headers).has('chatgpt-account-id')).toBe(false)
      expect(JSON.parse(String(init?.body))).toEqual({ metadata: { ideType: 'ANTIGRAVITY' } })
      return Response.json({})
    }
    expect(String(url)).toBe(oauth.CONTROL_ENDPOINTS.fetchAvailableModels)
    expect(init?.method).toBe('POST'); expect(new Headers(init?.headers).has('chatgpt-account-id')).toBe(false)
    expect(JSON.parse(String(init?.body))).toEqual({ project: 'synthetic-project' })
    return Response.json({ models: { [UPSTREAM]: {} } })
  } })
  const result = await service.snapshot() as any
  const ag = result.accounts.find((a: any) => a.provider === 'antigravity')
  expect(ag.windows[0].used_percent).toBeNull(); expect(ag.plan).toBeNull()
})

test('onboarding uses only one server-authorized default, bounded polling, and no credits', async () => {
  let calls = 0
  const http: FetchLike = async (url, init) => {
    calls++
    expect(String(url)).toBe(oauth.CONTROL_ENDPOINTS.onboardUser)
    expect(init?.redirect).toBe('manual')
    expect(JSON.parse(String(init?.body))).toEqual({ tier_id: 'server-default', metadata: { ide_type: 'ANTIGRAVITY', ide_name: 'antigravity' } })
    return Response.json(calls === 2 ? { done: true, response: { cloudaicompanionProject: { id: 'new-project' } } } : { done: false })
  }
  expect(await oauth.onboardDefault(http, 'fake', { allowedTiers: [{ id: 'do-not-select' }, { id: 'server-default', isDefault: true }] }, { pollMs: 1 })).toBe('new-project')
  expect(calls).toBe(2)
  await expect(oauth.onboardDefault(http, 'fake', { allowedTiers: [{ id: 'do-not-select' }] })).rejects.toThrow('authorized default')
  expect(calls).toBe(2)
  let polls = 0
  await expect(oauth.onboardDefault(async () => { polls++; return Response.json({ done: false }) }, 'fake', { allowedTiers: [{ id: 'x', isDefault: true }] }, { pollMs: 1 })).rejects.toThrow('five polls')
  expect(polls).toBe(5)
})

test('split usage fields and total-only tail preserve preceding cumulative counts', async () => {
  const model = new AntigravityModel(MODEL, manager(), { fetchImpl: fakeApi([
    frame([{ text: 'a' }], undefined, { promptTokenCount: 20, cachedContentTokenCount: 4 }),
    frame([{ text: 'b' }], 'STOP', { candidatesTokenCount: 3, thoughtsTokenCount: 2 }),
    { response: { usageMetadata: { totalTokenCount: 25 } } },
  ]) })
  expect((await model.request(messages, {}, params)).usage).toMatchObject({ input_tokens: 20, cache_read_tokens: 4, output_tokens: 5 })
  expect(antigravityUsage({ totalTokenCount: 25 })).toBeNull()
  expect(antigravityUsage({ promptTokenCount: 20 })).toBeNull()
})

test('image mapping is available, native PDF/video fails closed, API-key Argon remains a different provider', async () => {
  const { GoogleModel } = await import('../src/llm/providers/google.ts')
  const model = new AntigravityModel(MODEL, manager())
  const image = modelRequest([userPrompt([{ kind: 'image', asset_id: 'a_img', bytes: 4, sha256: 'ab'.repeat(32), width: 1, height: 1, name: 'test.png', data: 'AAAA', media_type: 'image/png' }])])
  expect(JSON.stringify(model.body([image], {}, params, grant()))).toContain('inline_data')
  const pdf = modelRequest([userPrompt([{ kind: 'file', asset_id: 'a_pdf', bytes: 4, sha256: 'ab'.repeat(32), name: 'test.pdf', file_kind: 'pdf', representation: 'native-v1', data: 'AAAA', media_type: 'application/pdf' }])])
  expect(() => model.body([pdf], {}, params, grant())).toThrow('not verified')
  expect(new GoogleModel('gemini-4-argon').system).toBe('google')
  expect(new GoogleModel('gemini-4-argon').gemini).not.toBeNull()
  expect(model.system).toBe('antigravity')
})

test('Claude VALIDATED placeholder is wire-only, and only this generation may replay original wire arguments', async () => {
  const id = 'claude-sonnet-5-5-high'
  const p = { ...params, function_tools: [{ name: 'empty', description: 'empty', parameters_json_schema: { type: 'object', properties: {}, additionalProperties: false } }] }
  const model = new AntigravityModel(id, manager(), { fetchImpl: fakeApi([frame([{ functionCall: { name: 'empty', args: { __oasis_reason: 'why' } } }], 'STOP')], body => {
    expect(body.request.toolConfig.functionCallingConfig.mode).toBe('VALIDATED')
    expect(body.request.tools[0].functionDeclarations[0].parameters.required).toEqual(['__oasis_reason'])
  }) })
  const response = await model.request(messages, {}, p)
  expect(response.parts[0]).toMatchObject({ part_kind: 'tool-call', args: {} })
  expect(JSON.stringify(model.body([...messages, response], {}, p, grant()))).toContain('"__oasis_reason":"why"')
  expect(JSON.stringify(model.body([...messages, response], {}, p, grant().with({ authorization_id: 'other' })))).not.toContain('"__oasis_reason":"why"')
})

test('dynamic catalog completion after logout cannot publish stale routes', async () => {
  const { credentialStore } = await import('../src/auth/store.ts')
  const { discoveredRoutes, refreshCatalog } = await import('../src/auth/antigravity_catalog.ts')
  setDefaultAuthDir(tempDir('ag-catalog-'))
  const store = credentialStore(); await store.modify('antigravity', async () => grant())
  const entered = new Deferred<void>(), finish = new Deferred<Response>()
  const refresh = refreshCatalog(async () => { entered.resolve(); return finish.promise })
  await entered.promise; await store.delete('antigravity')
  finish.resolve(Response.json({ models: { [UPSTREAM]: {} } })); await refresh
  expect(discoveredRoutes()).toEqual([])
  await store.modify('antigravity', async () => grant().with({ authorization_id: 'next' }))
  await refreshCatalog(async () => Response.json({ models: { [UPSTREAM]: {} } }))
  expect(discoveredRoutes()).toHaveLength(1)
  await store.delete('antigravity'); expect(discoveredRoutes()).toEqual([])
})

test('account switch during discovery blocks inference, cancel propagates to the HTTP signal', async () => {
  let reads = 0, requests = 0
  const model = new AntigravityModel(MODEL, { access: async () => grant().with({ authorization_id: ++reads === 1 ? 'old' : 'new' }) }, { fetchImpl: async () => { requests++; return Response.json({ models: { [UPSTREAM]: {} } }) } })
  await expect(model.request(messages, {}, params)).rejects.toThrow('account changed')
  expect(requests).toBe(1)
  const abort = new AbortController(); abort.abort()
  const cancelled = new AntigravityModel(MODEL, manager(), { fetchImpl: async (_url, init) => { init?.signal?.throwIfAborted(); throw new Error('unexpected') } })
  await expect(cancelled.request(messages, {}, params, { signal: abort.signal })).rejects.toThrow('cancelled')
})

test('Claude thinking text deltas and standalone signature replay as one complete signed block', async () => {
  const model = new AntigravityModel('claude-opus-5-5-high', manager(), { fetchImpl: fakeApi([
    frame([{ thought: true, text: 'first ' }]), frame([{ thought: true, text: 'second' }]),
    frame([{ thoughtSignature: 'whole-block-signature' }, { text: 'answer' }], 'STOP'),
  ]) })
  const response = await model.request(messages, {}, params)
  expect(response.parts[0]).toMatchObject({ part_kind: 'thinking', content: 'first second', provider_details: { thought_signature: 'whole-block-signature' } })
  const body = model.body([...messages, response], {}, params, grant()) as any
  expect(body.request.contents[1].parts[0]).toEqual({ thought: true, text: 'first second', thoughtSignature: 'whole-block-signature' })
})


test('logical catalog keeps unknown metadata unknown and exposes only present upstream efforts', async () => {
  const { credentialStore } = await import('../src/auth/store.ts')
  const { refreshCatalog } = await import('../src/auth/antigravity_catalog.ts')
  const { catalogEntries } = await import('../src/llm/catalog.ts')
  const { harnessConfig } = await import('../src/config.ts')
  const observed = { models: { [UPSTREAM]: {}, 'gemini-3.8-flash-high': {}, 'gemini-4-argon-low': {}, 'image-model': {} } }
  const parsed = parseCatalog(observed)
  expect(parsed.map(m => m.model)).toEqual([MODEL, 'gemini-4-argon'])
  expect(parsed[0]!.context_window).toBeNull()
  expect(parsed[0]!.capabilities.images).toBe('unknown')
  expect(parsed[0]!.reasoning_efforts).toEqual(['medium', 'high'])
  expect(parsed[1]!.reasoning_efforts).toEqual(['low'])
  const adapter = new AntigravityModel(MODEL, manager())
  const all = { ...params, function_tools: specs().map(s => ({ name: s.name, description: s.description, parameters_json_schema: parametersSchema(s) })) }
  for (const effort of ['low', 'medium', 'high'] as const) {
    const body = adapter.body(messages, {}, { ...all, thinking: effort }, grant()) as any
    expect(body.model).toBe('gemini-3.8-flash-' + effort)
    expect(body.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: { low: 1000, medium: 4000, high: -1 }[effort] })
    expect(body.request.tools[0].functionDeclarations.map((t: any) => t.name)).toEqual(all.function_tools.map(t => t.name))
  }
  expect(() => adapter.body(messages, {}, { ...all, thinking: false }, grant())).toThrow('unsupported Antigravity thinking effort')
  expect((adapter.body(messages, {}, { ...all, thinking: null }, grant()) as any).model).toBe(UPSTREAM)
  setDefaultAuthDir(tempDir('ag-observed-catalog-'))
  await credentialStore().modify('antigravity', async () => grant())
  await refreshCatalog(async () => Response.json(observed))
  const entries = catalogEntries(harnessConfig()).filter(e => e.provider === 'antigravity')
  expect(entries.map(e => e.id)).toEqual(['antigravity:' + MODEL, 'antigravity:gemini-4-argon'])
  expect(entries[0]!.supported_thinking).toEqual(['medium', 'high'])
  expect(entries.every(e => e.credential === 'available')).toBe(true)
  expect(entries.some(e => e.id === 'antigravity:gemini-3.8-flash-high')).toBe(false)
})

test('paidTier ID takes precedence as a raw label, without changing default onboarding or inferring subscription', () => {
  expect(oauth.reportedTierId({ currentTier: { id: 'free-tier' }, paidTier: { id: 'paid-tier-observed' } })).toBe('paid-tier-observed')
  expect(oauth.reportedTierId({ currentTier: { id: 'free-tier' } })).toBe('free-tier')
  expect(oauth.reportedTierId({ currentTier: { id: 'free-tier' }, paidTier: { id: ' ' } })).toBe('free-tier')
  expect(oauth.reportedTierId({ paidTier: { id: 123 } })).toBeNull()
  expect(oauth.reportedTierId({})).toBeNull()
})

test('actual account maxTokens/supportsImages/maxOutputTokens drive catalog and production request limits', async () => {
  // Only the safe fields returned by the director's read-only control-plane diagnostic.
  const observed: Record<string, Record<string, unknown>> = {
    'gemini-3.8-flash-medium': { maxTokens: 1048576, maxOutputTokens: 65536, supportsThinking: true, supportsImages: true },
  }
  const routes = parseCatalog({ models: observed })
  for (const cfg of routes) {
    const metadata = observed[resolveAntigravityModel(cfg.model, params.thinking).upstreamId]!
    const limit = metadata.maxOutputTokens as number
    expect(cfg.context_window).toBe(1048576)
    expect(cfg.window_source).toBe('Antigravity fetchAvailableModels')
    expect(cfg.capabilities).toMatchObject({ images: true, thinking: true, max_output_tokens: limit, provider_max_output_tokens: limit })
    expect(cfg.max_tokens).toBe(8192)
    expect(cfg.reasoning_efforts).toEqual(['medium'])
    let sent = 0, requested = 8192
    const model = new AntigravityModel(cfg.model, manager(), { fetchImpl: async (url, init) => {
      if (String(url).endsWith(':fetchAvailableModels')) return Response.json({ models: observed })
      sent++
      const body = JSON.parse(String(init?.body))
      expect(body.request.generationConfig.maxOutputTokens).toBe(requested)
      expect(body.request.generationConfig.thinkingConfig.thinkingBudget).toBe(4000)
      return sse([frame([{ text: 'ok' }], 'STOP')])
    } })
    await model.request(messages, {}, params)
    requested = limit
    await model.request(messages, { max_tokens: limit }, params)
    await expect(model.request(messages, { max_tokens: limit + 1 }, params)).rejects.toThrow('effective catalog/adapter cap')
    expect(sent).toBe(2) // Reject before inference; never silently exceed the reported per-request cap.
  }
  const falseWins = parseCatalog({ models: { 'gemini-3.8-flash-medium': { maxTokens: 160000, contextWindow: 320000, inputTokenLimit: 640000, maxOutputTokens: 4096, supportsImages: false, supportedInputModalities: ['image'] } } })[0]!
  expect(falseWins.context_window).toBe(160000)
  expect(falseWins.capabilities.images).toBe(false)
  expect(falseWins.max_tokens).toBe(4096)
  const model = new AntigravityModel(falseWins.model, manager())
  expect((model.body(messages, {}, params, grant(), { maxOutputTokens: 4096 }) as any).request.generationConfig.maxOutputTokens).toBe(4096)
  // A future lower cap on a retained ID is enforced too; this is a synthetic regression, not a new observation.
  expect(() => model.body(messages, { max_tokens: 65536 }, params, grant(), { maxOutputTokens: 65535 })).toThrow('65535')
  expect((model.body(messages, { max_tokens: 65535 }, params, grant(), { maxOutputTokens: 65535 }) as any).request.generationConfig.maxOutputTokens).toBe(65535)
  const absent = parseCatalog({ models: { 'gemini-3.8-flash-medium': {} } })[0]!
  expect(absent.context_window).toBeNull()
  expect(absent.capabilities.images).toBe('unknown')
})

test('usage refresh overrides old free-tier with current paidTier without changing the stored grant', async () => {
  const store = new CredentialStore(join(tempDir('ag-paid-tier-'), 'auth.json'))
  const old = grant().with({ tier_id: 'free-tier' })
  await store.modify('antigravity', async () => old)
  const calls: string[] = []
  const service = new UsageService(new TokenManager(store, {}), null, { fetchImpl: async (url, init) => {
    calls.push(String(url))
    expect(init?.redirect).toBe('manual')
    expect(new Headers(init?.headers).has('chatgpt-account-id')).toBe(false)
    if (String(url).endsWith(':fetchAvailableModels')) return Response.json({ models: { [UPSTREAM]: { quotaInfo: { remainingFraction: 1 } } } })
    expect(String(url)).toBe(oauth.CONTROL_ENDPOINTS.loadCodeAssist)
    expect(JSON.parse(String(init?.body))).toEqual({ metadata: { ideType: 'ANTIGRAVITY' } })
    return Response.json({ currentTier: { id: 'free-tier' }, paidTier: { id: 'g1-pro-tier' } })
  } })
  const report = await service.report(service.accounts().find(a => a.provider === 'antigravity')!, { refresh: true })
  expect(report).toMatchObject({ status: 'ok', plan: 'g1-pro-tier' })
  expect((report.windows as any[])[0].used_percent).toBe(0)
  expect(calls).toEqual([oauth.CONTROL_ENDPOINTS.fetchAvailableModels, oauth.CONTROL_ENDPOINTS.loadCodeAssist])
  expect(store.read('antigravity')!.equals(old)).toBe(true)
})

test('tier lookup failure leaves successful quota usable and plan unknown, never old free-tier', async () => {
  for (const status of [403, 429, 500]) {
    const store = new CredentialStore(join(tempDir('ag-tier-failure-'), 'auth.json'))
    await store.modify('antigravity', async () => grant().with({ tier_id: 'free-tier' }))
    const service = new UsageService(new TokenManager(store, {}), null, { fetchImpl: async url => String(url).endsWith(':loadCodeAssist')
      ? Response.json({ secret: 'do-not-surface' }, { status })
      : Response.json({ models: { [UPSTREAM]: { quotaInfo: { remainingFraction: .5 } } } }) })
    const report = await service.report(service.accounts().find(a => a.provider === 'antigravity')!)
    expect(report).toMatchObject({ status: 'ok', plan: null })
    expect((report.windows as any[])[0].used_percent).toBe(50)
    expect(JSON.stringify(report)).not.toContain('do-not-surface')
  }
})

test('tier response after account switch/logout is discarded with quota; never published or cached', async () => {
  for (const logout of [false, true]) {
    const store = new CredentialStore(join(tempDir('ag-tier-race-'), 'auth.json'))
    await store.modify('antigravity', async () => grant().with({ tier_id: 'free-tier' }))
    const entered = new Deferred<void>(), finish = new Deferred<Response>()
    let tierCalls = 0
    const service = new UsageService(new TokenManager(store, {}), null, { fetchImpl: async url => {
      if (String(url).endsWith(':fetchAvailableModels')) return Response.json({ models: { [UPSTREAM]: { quotaInfo: { remainingFraction: 1 } } } })
      if (++tierCalls === 1) { entered.resolve(); return finish.promise }
      return Response.json({ paidTier: { id: 'fresh-paid-tier' } })
    } })
    const report = service.report(service.accounts().find(a => a.provider === 'antigravity')!)
    await entered.promise
    if (logout) await store.delete('antigravity')
    else await store.modify('antigravity', async () => grant().with({ authorization_id: 'other', account_id: 'other', email: 'other@example.invalid' }))
    finish.resolve(Response.json({ currentTier: { id: 'free-tier' }, paidTier: { id: 'g1-pro-tier' } }))
    expect(await report).toMatchObject({ status: 'unavailable', error: 'account_changed', windows: [], checked_at: null, plan: null })
    if (logout) await store.modify('antigravity', async () => grant().with({ authorization_id: 'next' }))
    const next = await service.report(service.accounts().find(a => a.provider === 'antigravity')!)
    expect(next).toMatchObject({ status: 'ok', plan: 'fresh-paid-tier' })
    expect(tierCalls).toBe(2)
  }
})


test('five logical routes expose the official effort families and defaults without duplicate rows', () => {
  const all = parseCatalog({ models: Object.fromEntries(upstreamIds().map(id => [id, {}])) })
  expect(all).toHaveLength(5)
  expect(upstreamIds()).toHaveLength(13)
  for (const cfg of all) {
    const model = new AntigravityModel(cfg.model, manager())
    expect(cfg.reasoning_efforts).toEqual(cfg.model === 'gpt-oss-120b-medium' ? ['medium'] : ['low', 'medium', 'high'])
    const defaultBody = model.body(messages, {}, { ...params, thinking: null }, grant()) as any
    expect(defaultBody.model).toBe(resolveAntigravityModel(cfg.model).upstreamId)
    for (const effort of cfg.reasoning_efforts!) {
      const body = model.body(messages, {}, { ...params, thinking: effort }, grant()) as any
      expect(body.model).toBe(resolveAntigravityModel(cfg.model, effort).upstreamId)
    }
  }
})

test('fresh paid tier metadata never masks a quota HTTP 429', async () => {
  const store = new CredentialStore(join(tempDir('ag-tier-quota-'), 'auth.json'))
  await store.modify('antigravity', async () => grant().with({ tier_id: 'free-tier' }))
  const service = new UsageService(new TokenManager(store, {}), null, { fetchImpl: async url => String(url).endsWith(':loadCodeAssist')
    ? Response.json({ currentTier: { id: 'free-tier' }, paidTier: { id: 'g1-pro-tier' } })
    : Response.json({ error: 'quota check refused' }, { status: 429 }) })
  const report = await service.report(service.accounts().find(a => a.provider === 'antigravity')!)
  expect(report).toMatchObject({ status: 'unavailable', error: 'rate_limited', plan: 'g1-pro-tier', windows: [] })
})

test('consumer control method mapping is fixed: Prod load, non-sandbox Daily catalog/onboard; snake_case tier_id', async () => {
  // Handwritten from pinned constants.go/auth.go; do not derive expectations from exported constants.
  const fixtures = [
    ['loadCodeAssist', 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } }],
    ['fetchAvailableModels', 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', { project: 'synthetic-project' }],
  ] as const
  for (const [method, expected, body] of fixtures) {
    let calls = 0
    await oauth.control(async (url, init) => {
      calls++
      expect(String(url)).toBe(expected)
      expect(init?.redirect).toBe('manual')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('user-agent')).toBe(EXPECTED_USER_AGENT)
      expect(JSON.parse(String(init?.body))).toEqual(body)
      return Response.json({})
    }, 'synthetic-access', method, body)
    expect(calls).toBe(1)
  }
  const project = await oauth.onboardDefault(async (url, init) => {
    expect(String(url)).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser')
    expect(new Headers(init?.headers).get('user-agent')).toBe(EXPECTED_USER_AGENT)
    expect(init?.redirect).toBe('manual')
    expect(JSON.parse(String(init?.body))).toEqual({ tier_id: 'allowed-default', metadata: { ide_type: 'ANTIGRAVITY', ide_name: 'antigravity' } })
    expect(JSON.parse(String(init?.body)).tierId).toBeUndefined()
    return Response.json({ done: true, response: { cloudaicompanionProject: 'synthetic-project' } })
  }, 'synthetic-access', { allowedTiers: [{ id: 'allowed-default', isDefault: true }] })
  expect(project).toBe('synthetic-project')
  expect(Object.isFrozen(oauth.CONTROL_ENDPOINTS)).toBe(true)
  expect(Object.isFrozen(oauth.INFERENCE_ENDPOINTS)).toBe(true)
  for (const method of ['generateContent', '__proto__', 'constructor', '../fetchAvailableModels']) {
    let calls = 0
    await expect(oauth.control(async () => { calls++; return Response.json({}) }, 'synthetic-access', method as never, {})).rejects.toThrow('unsupported Antigravity control operation')
    expect(calls).toBe(0)
  }
})

test('consumer inference and signature scope use Daily exclusively; Prod/refused routes never trigger fallback', async () => {
  const { ModelConfig } = await import('../src/config.ts')
  const { routeEndpoint } = await import('../src/llm/catalog.ts')
  const { modelResponse, toolCallPart } = await import('../src/llm/messages.ts')
  expect(STREAM_URL).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse')
  expect(oauth.INFERENCE_ENDPOINTS.generateContent).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent')
  const cfg = parseCatalog({ models: { [UPSTREAM]: {} } })[0]!
  expect(cfg.endpoint).toBe('https://daily-cloudcode-pa.googleapis.com')
  expect(routeEndpoint(cfg)).toBe('https://daily-cloudcode-pa.googleapis.com')
  expect(() => new ModelConfig({ id: `antigravity:${MODEL}`, provider: 'antigravity', model: MODEL, auth: 'oauth', base_url: 'https://cloudcode-pa.googleapis.com' })).toThrow()
  const model = new AntigravityModel(MODEL, manager())
  const dailyRoute = model.routeForGrant(grant())
  expect(dailyRoute).toContain('https://daily-cloudcode-pa.googleapis.com')
  const old = modelResponse([toolCallPart('lookup', {}, 'old', { provider_name: 'antigravity', provider_details: { thought_signature: 'prod-signature', call_id: 'old-id' } })], { provider_name: 'antigravity', provider_details: { route: dailyRoute.replace('daily-cloudcode-pa.', 'cloudcode-pa.') } })
  expect(JSON.stringify(model.body([...messages, old], {}, params, grant()))).not.toContain('prod-signature')
  for (const status of [403, 429]) {
    const calls: string[] = []
    const adapter = new AntigravityModel(MODEL, manager(), { maxRetries: 5, fetchImpl: async url => {
      calls.push(String(url))
      if (String(url) === 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels') return Response.json({ models: { [UPSTREAM]: {} } })
      expect(String(url)).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse')
      return Response.json({ error: 'refused' }, { status })
    } })
    await expect(adapter.request(messages, {}, params)).rejects.toThrow(String(status))
    expect(calls).toEqual(['https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse'])
  }
})

test('the five stable identities survive effort selection and unknown/internal upstream IDs never auto-enable', () => {
  const approved = ['gemini-3.8-flash-tiered', 'claude-opus-5-5-high', 'claude-sonnet-5-5-high', 'gemini-4-argon', 'gpt-oss-120b-medium']
  const excluded = ['gemini-3-flash-agent', 'gemini-3.6-flash-high', 'gemini-3.1-pro-high', 'gemini-chat', 'gemini-tab', 'gemini-image']
  expect(Object.keys(SUPPORTED_MODELS)).toEqual(approved)
  const data = { models: Object.fromEntries([...upstreamIds(), ...excluded].map(id => [id, {}])) }
  expect(parseCatalog(data).map(m => m.model)).toEqual(approved)
  expect(parseAntigravity(data).map(w => w.id)).toEqual(approved)
  for (const id of excluded) expect(() => new AntigravityModel(id, { access: async () => { throw new Error('must not read credentials') } })).toThrow('unsupported Antigravity text/tool model')
  expect(parseCatalog({ models: Object.fromEntries(excluded.map(id => [id, {}])) })).toEqual([])
})

test('quota shows one explicitly labeled default-effort observation per logical model without inventing shared buckets', () => {
  const quota = { remainingFraction: .25, resetTime: '2026-10-19T00:00:00Z' }
  const data = { models: Object.fromEntries(upstreamIds().map(id => [id, { displayName: 'untrusted effort-specific label', quotaInfo: quota }])) }
  data.models['gemini-4-argon-high'] = { displayName: 'Argon High', quotaInfo: { ...quota, remainingFraction: .01 } }
  const result = parseAntigravity(data)
  expect(result).toHaveLength(5)
  expect(result.map(w => w.label)).toEqual(['Gemini 3.8 Flash (medium default)', 'Claude Opus 5.5 (medium default)', 'Claude Sonnet 5.5 (medium default)', 'Gemini 4 Argon (low default)', 'GPT-OSS 120B (medium default)'])
  expect(result.map(w => w.used_percent)).toEqual([75, 75, 75, 75, 75])
  expect(parseAntigravity({ models: { 'gemini-4-argon-high': { quotaInfo: quota } } })[0]).toMatchObject({ label: 'Gemini 4 Argon (low default)', used_percent: null })
  expect(parseAntigravity({ models: { 'claude-opus-5-5-medium': { quotaInfo: { remainingFraction: -1 } } } })[0]!.used_percent).toBeNull()
})
