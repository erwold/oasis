import { PROMPT_TEXT } from '../src/prompt_texts.ts'
/** Regressions for H1–H4 and M1. Synthetic credentials/network only. */
import '../src/main.ts'
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { antigravityToolSchema, isAntigravityArgumentCarrier, originalToolArguments, wireToolArguments } from '../src/llm/providers/antigravity_schema.ts'
import { resolveAntigravityModel } from '../src/auth/antigravity_catalog.ts'
import { AntigravityModel, STREAM_URL } from '../src/llm/providers/antigravity.ts'
import { parametersSchema, specs } from '../src/agent/tools/registry.ts'
import { modelRequest, modelResponse, systemPrompt, textPart, toolReturn, userPrompt, type ModelMessage } from '../src/llm/messages.ts'
import { CredentialStore, OAuthCredential, TokenManager } from '../src/auth/store.ts'
import { UsageService } from '../src/auth/usage.ts'
import { Deferred } from '../src/auth/callback.ts'
import { tempDir } from './helpers.ts'
import type { ModelRequestParameters } from '../src/llm/model.ts'

const id = 'gemini-3.8-flash-tiered'
const grant = (generation = 'A') => new OAuthCredential({ access: 'synthetic-access', refresh: 'synthetic-refresh', account_id: generation, authorization_id: generation, project_id: `project-${generation}`, email: `${generation}@example.invalid`, expires_ms: Date.now() + 3600_000 })
const manager = { access: async () => grant() }
const input = [modelRequest([userPrompt('hello')])]
const parameters: ModelRequestParameters = { function_tools: [], allow_text_output: true, thinking: 'medium' }
const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required })
const frame = (parts: unknown[], finishReason?: string) => ({ response: { candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }] } })
function stream(frames: unknown[]): Response {
  const bytes = new TextEncoder().encode(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join(''))
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); c.close() } }))
}

for (const claude of [false, true]) {
  test(`H1 actual return_ui_result.data retains every JSON type (${claude ? 'Claude' : 'Gemini'})`, () => {
    const spec = specs().find(s => s.name === 'return_ui_result')!
    const raw = parametersSchema(spec)
    const wire = antigravityToolSchema(raw, claude)
    const field = (raw.properties as Record<string, unknown>).data
    const fieldWire = antigravityToolSchema(closed({ data: field }), claude) as any
    expect(fieldWire.properties.data.description).toContain('JSON TEXT CARRIER')
    for (const data of [{ answer: 42, __oasis_reason: '业务键' }, [0, false, null, { a: [] }], 42, 0, false, null, '', 'null', '{"not":"an object"}']) {
      const args = { data }
      expect(originalToolArguments(wireToolArguments(args, wire), wire)).toEqual(args)
      expect(spec.schema.parse(originalToolArguments(wireToolArguments(args, wire), wire))).toEqual(args)
      // Hand-built wire fixture, not an encoder/decoder self-consistency assertion.
      expect(originalToolArguments({ data: JSON.stringify(data) }, fieldWire)).toEqual(args)
    }
    // A normal string declaration is never guessed to contain encoded JSON.
    expect(originalToolArguments({ text: '{"answer":42}' }, antigravityToolSchema(closed({ text: { type: 'string' } }), claude))).toEqual({ text: '{"answer":42}' })
  })

  test(`H1/H2 actual present_ui initial_state/elements/props and reserved business names roundtrip (${claude})`, () => {
    const spec = specs().find(s => s.name === 'present_ui')!
    const raw = parametersSchema(spec)
    const wire = antigravityToolSchema(raw, claude) as any
    const args = { version: 1, surface_id: 'review', title: 'review', fallback: 'review', kind: 'native', root: 'root', initial_state: { __oasis_reason: 'keep', zero: 0, no: false, nil: null }, elements: { root: { type: 'text', props: { text: 'value', __oasis_reason: 'nested', arbitrary: { __oasis_json: false, list: [0, null] } } } }, __oasis_json: { business: true } }
    expect(wire.properties.__oasis_json.description).toContain('JSON TEXT CARRIER')
    const encoded = wireToolArguments(args, wire)
    expect(encoded).toEqual({ __oasis_json: JSON.stringify(args) })
    const decoded = originalToolArguments(encoded, wire)
    expect(decoded).toEqual(args)
    expect(spec.schema.parse(decoded)).toEqual(args)
    // Exercise these actual registry field definitions independently, including nested map props.
    const props = raw.properties as Record<string, unknown>
    for (const key of ['initial_state', 'elements']) {
      const fieldWire = antigravityToolSchema(closed({ [key]: props[key] }), claude)
      const value = args[key as 'initial_state' | 'elements']
      expect(originalToolArguments({ [key]: JSON.stringify(value) }, fieldWire)).toEqual({ [key]: value })
    }
  })

  test(`H1 nullable refs, unresolved/recursive refs, unions and unconstrained array items (${claude})`, () => {
    const wire = antigravityToolSchema({ ...closed({ n: { anyOf: [{ $ref: '#/$defs/num' }, { type: 'null' }] }, u: { anyOf: [{ type: 'string' }, { type: 'object' }] }, list: { type: 'array' }, unresolved: { $ref: '#/$defs/missing' }, recursive: { $ref: '#/$defs/recursive' } }), $defs: { num: { type: 'number' }, recursive: { $ref: '#/$defs/recursive' } } }, claude) as any
    expect(wire.properties.n).toMatchObject({ type: 'NUMBER', nullable: true })
    expect(wire.properties.u.description).toContain('JSON TEXT CARRIER')
    const original = { n: null, u: { __oasis_reason: 'keep' }, list: [0, false, null, { key: 3 }, 'null'], unresolved: { x: 4 }, recursive: { child: null } }
    expect(originalToolArguments({ n: null, u: '{"__oasis_reason":"keep"}', list: ['0', 'false', 'null', '{"key":3}', '"null"'], unresolved: '{"x":4}', recursive: '{"child":null}' }, wire)).toEqual(original)
    expect(originalToolArguments(wireToolArguments({ ...original, n: 0, u: 'literal' }, wire), wire)).toEqual({ ...original, n: 0, u: 'literal' })
  })
}

test('H1 malformed carrier fails explicitly, never guesses native values or leaks carrier text', () => {
  const wire = antigravityToolSchema(closed({ data: {} }), false)
  for (const data of ['not JSON secret', '{"a":1,}', '{"a":1,"a":2}', '{"a":1,"\\u0061":2}', 'NaN', '1e9999', '9007199254740993', 'null trailing', '```json\n{}\n```', { a: 1 }, null, false, 0]) {
    expect(() => originalToolArguments({ data }, wire)).toThrow('JSON carrier is malformed')
  }
  for (const data of [undefined, Number.NaN, Number.POSITIVE_INFINITY, { omitted: undefined }]) expect(() => wireToolArguments({ data }, wire)).toThrow('JSON carrier is malformed')
  const native = antigravityToolSchema(closed({ value: { anyOf: [{ type: 'string' }, { type: 'number' }] } }), false) as any
  expect(native.properties.value.anyOf).toEqual([{ type: 'STRING' }, { type: 'NUMBER' }])
  expect(originalToolArguments({ value: '0' }, native)).toEqual({ value: '0' })
  expect(originalToolArguments({ value: 0 }, native)).toEqual({ value: 0 })
  const root = antigravityToolSchema({ type: 'object', additionalProperties: {} }, true)
  expect(() => originalToolArguments({ __oasis_json: '{}', __oasis_reason: 'business' }, root)).toThrow('JSON carrier is malformed')
  expect(() => originalToolArguments({ __oasis_json: 'null' }, root)).toThrow('JSON carrier is malformed')
  const business = JSON.parse('{"__proto__":{"keep":true},"constructor":0,"__oasis_reason":false}')
  expect(originalToolArguments({ data: JSON.stringify(business) }, wire)).toEqual({ data: business })
})

test('H2 placeholder only for a proven closed empty top-level argument object', () => {
  const empty = antigravityToolSchema(closed({}), true) as any
  expect(empty.required).toEqual(['__oasis_reason'])
  expect(originalToolArguments({ __oasis_reason: 'invoke' }, empty)).toEqual({})
  for (const raw of [{ type: 'object', additionalProperties: {} }, { type: 'object', properties: {} }, closed({ optional: { type: 'string' } }, [])]) {
    const wire = antigravityToolSchema(raw, true) as any
    expect(wire.required).not.toContain('__oasis_reason')
    const original = { __oasis_reason: '合法业务', answer: 42, nested: { __oasis_reason: false } }
    expect(originalToolArguments(wireToolArguments(original, wire), wire)).toEqual(original)
  }
  const declared = antigravityToolSchema(closed({ __oasis_reason: { type: 'string' }, map: { type: 'object', additionalProperties: {} } }), true)
  expect(originalToolArguments({ __oasis_reason: 'business', map: '{"__oasis_reason":"nested","zero":0}' }, declared)).toEqual({ __oasis_reason: 'business', map: { __oasis_reason: 'nested', zero: 0 } })
})

test('H1 complete registry declarations retained; actual carrier call reaches runtime args and signed replay', async () => {
  const all = specs().map(s => ({ name: s.name, description: s.description, parameters_json_schema: parametersSchema(s) }))
  for (const modelId of ['gemini-3.8-flash-tiered', 'claude-opus-5-5-high', 'claude-sonnet-5-5-high']) {
    const p = { ...parameters, function_tools: all }
    const actual = specs().find(s => s.name === 'return_ui_result')!
    const args = { data: { answer: 42, __oasis_reason: false, array: [0, null] } }
    let wireArgs: unknown
    const model = new AntigravityModel(modelId, manager, { fetchImpl: async (url, init) => {
      if (String(url) !== STREAM_URL) return Response.json({ models: { [resolveAntigravityModel(modelId).upstreamId]: {} } })
      const body = JSON.parse(String(init?.body))
      expect(body.request.tools[0].functionDeclarations.map((d: any) => d.name)).toEqual(all.map(t => t.name))
      const bound = antigravityToolSchema(parametersSchema(actual), modelId.startsWith('claude'))
      wireArgs = wireToolArguments(args, bound)
      return stream([frame([{ functionCall: { name: actual.name, id: 'call-ui', args: wireArgs }, thoughtSignature: 'scoped-signature' }], 'STOP')])
    } })
    const response = await model.request(input, {}, p)
    expect(response.parts[0]).toMatchObject({ part_kind: 'tool-call', args, provider_details: { wire_args: wireArgs } })
    const replay = model.body([...input, response, modelRequest([toolReturn(actual.name, { ok: true }, 'call-ui')])], {}, p, grant()) as any
    expect(replay.request.contents[1].parts[0].functionCall.args).toEqual(wireArgs)
    expect(actual.schema.parse((response.parts[0] as any).args)).toEqual(args)
  }
})

test('H3 STOP then signature-only then usage is retained and sent in the actual second request', async () => {
  for (const modelId of [id, 'claude-opus-5-5-high']) {
    let round = 0
    const model = new AntigravityModel(modelId, manager, { fetchImpl: async (url, init) => {
      if (String(url) !== STREAM_URL) return Response.json({ models: { [resolveAntigravityModel(modelId).upstreamId]: {} } })
      if (++round === 1) return stream([frame([{ functionCall: { name: 'test', id: 'call-1', args: { value: 42 } } }], 'STOP'), frame([{ thoughtSignature: 'tail-signature' }]), { response: { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } } }])
      const replay = JSON.parse(String(init?.body)).request.contents.find((c: any) => c.role === 'model')
      expect(replay.parts).toEqual([{ functionCall: { name: 'test', id: 'call-1', args: { value: 42 } } }, { thoughtSignature: 'tail-signature' }])
      return stream([frame([{ text: 'done' }], 'STOP')])
    } })
    const first = await model.request(input, {}, parameters)
    expect(first.usage).toMatchObject({ input_tokens: 10, output_tokens: 2 })
    expect(first.parts[1]).toMatchObject({ provider_details: { thought_signature: 'tail-signature', signature_only: true } })
    await model.request([...input, first, modelRequest([toolReturn('test', { value: 42 }, 'call-1')])], {}, parameters)
    expect(round).toBe(2)
  }
})

test('H3 finish does not discard pending Claude thinking; non-signature content after finish rejects', async () => {
  const make = (frames: unknown[]) => new AntigravityModel('claude-opus-5-5-high', manager, { fetchImpl: async url => String(url) === STREAM_URL ? stream(frames) : Response.json({ models: { 'claude-opus-5-5-medium': {} } }) })
  const response = await make([frame([{ thought: true, text: 'whole thought' }], 'STOP'), frame([{ thoughtSignature: 'late' }])]).request(input, {}, parameters)
  expect(response.parts[0]).toMatchObject({ content: 'whole thought', provider_details: { thought_signature: 'late' } })
  for (const part of [{ text: 'late new answer' }, { functionCall: { name: 'late', args: {} } }]) await expect(make([frame([{ text: 'answer' }], 'STOP'), frame([part])]).request(input, {}, parameters)).rejects.toThrow('after its finish reason')
})

test('H4 only latest nonempty instructions once; real system parts retain original order', () => {
  const model = new AntigravityModel(id, manager)
  const systemOf = (history: ModelMessage[]) => (model.body(history, {}, parameters, grant()) as any).request.systemInstruction?.parts[0].text
  expect(systemOf([modelRequest([userPrompt('new')], 'first')])).toBe('first')
  expect(systemOf([modelRequest([userPrompt('one')], 'same'), modelResponse([textPart('reply')]), modelRequest([userPrompt('two')], 'same')])).toBe('same')
  expect(systemOf([modelRequest([systemPrompt('system one'), userPrompt('one')], 'old'), modelResponse([textPart('reply')]), modelRequest([systemPrompt('system two'), userPrompt('two')], 'new')])).toBe('new\n\nsystem one\n\nsystem two')
  expect(systemOf([modelRequest([userPrompt('one')], 'keep'), modelRequest([userPrompt('two')], '')])).toBe('keep')
  expect(systemOf(input)).toBeUndefined()
})

test('M1 queued A report cannot acquire B quota; cached A report is fenced before read', async () => {
  const store = new CredentialStore(join(tempDir('ag-usage-review-'), 'auth.json'))
  await store.modify('antigravity', async () => grant())
  let calls = 0
  const service = new UsageService(new TokenManager(store, {}), null, { fetchImpl: async url => { if (String(url).endsWith(':loadCodeAssist')) return Response.json({}); calls++; return Response.json({ models: { [resolveAntigravityModel(id).upstreamId]: { quotaInfo: { remainingFraction: .25 } } } }) } })
  const a = service.accounts().find(a => a.provider === 'antigravity')!
  expect((await service.report(a)).status).toBe('ok'); expect(calls).toBe(1)
  await store.modify('antigravity', async () => grant('B'))
  const obsolete = await service.report(a)
  expect(obsolete).toMatchObject({ error: 'account_changed', windows: [], plan: null })
  expect(calls).toBe(1)
  const b = service.accounts().find(a => a.provider === 'antigravity')!
  expect((await service.report(b)).account_label).toBe('B@example.invalid'); expect(calls).toBe(2)
})

test('M1 switch while waiting for access and logout/switch during response discard quota without caching', async () => {
  for (const change of ['B', 'logout']) {
    const store = new CredentialStore(join(tempDir('ag-usage-review-'), 'auth.json'))
    await store.modify('antigravity', async () => grant())
    const entered = new Deferred<void>(), answer = new Deferred<Response>()
    let requests = 0
    const service = new UsageService(new TokenManager(store, {}), null, { fetchImpl: async url => { if (String(url).endsWith(':loadCodeAssist')) return Response.json({}); requests++; if (requests === 1) { entered.resolve(); return answer.promise }; return Response.json({ models: {} }) } })
    const a = service.accounts().find(a => a.provider === 'antigravity')!
    const inflight = service.report(a); await entered.promise
    const queued = service.report(a)
    if (change === 'logout') await store.delete('antigravity'); else await store.modify('antigravity', async () => grant('B'))
    answer.resolve(Response.json({ models: { [resolveAntigravityModel(id).upstreamId]: { quotaInfo: { remainingFraction: .1 } } } }))
    for (const report of [await inflight, await queued]) expect(report).toMatchObject({ error: 'account_changed', windows: [], checked_at: null, plan: null })
    expect(requests).toBe(1)
    await store.modify('antigravity', async () => grant('C'))
    expect((await service.report(service.accounts().find(a => a.provider === 'antigravity')!)).status).toBe('ok')
    expect(requests).toBe(2)
  }
  const store = new CredentialStore(join(tempDir('ag-usage-access-'), 'auth.json'))
  await store.modify('antigravity', async () => grant())
  const entered = new Deferred<void>(), release = new Deferred<void>()
  const tm = new TokenManager(store, {})
  tm.access = async () => { entered.resolve(); await release.promise; return store.read('antigravity')! }
  let requests = 0
  const service = new UsageService(tm, null, { fetchImpl: async () => { requests++; return Response.json({ models: {} }) } })
  const report = service.report(service.accounts().find(a => a.provider === 'antigravity')!); await entered.promise
  await store.modify('antigravity', async () => grant('B')); release.resolve()
  expect(await report).toMatchObject({ error: 'account_changed', windows: [] }); expect(requests).toBe(0)
})


const gptCarrierInstruction = 'When calling a tool, follow its declared wire parameter schema. A tool whose parameters require __oasis_json takes exactly one argument named __oasis_json: a string containing the entire original argument object as JSON. The original schema quoted in the description describes the contents of that string, not the outer function arguments. Never put the original properties alongside __oasis_json or replace the envelope with them.'

test('GPT full registry carrier guidance preserves existing system instructions, declarations and output cap', () => {
  const all = specs().map(s => ({ name: s.name, description: s.description, parameters_json_schema: parametersSchema(s) }))
  const p = { ...parameters, function_tools: all }
  const history = [modelRequest([systemPrompt('first system'), userPrompt('one')], 'old instructions'), modelResponse([textPart('reply')]), modelRequest([systemPrompt('second system'), userPrompt('two')], 'current instructions')]
  const expectedOriginal = 'current instructions\n\nfirst system\n\nsecond system'
  const gpt = new AntigravityModel('gpt-oss-120b-medium', manager).body(history, {}, p, grant()) as any
  expect(all.length).toBe(21)
  expect(gpt.request.systemInstruction.parts).toEqual([{ text: expectedOriginal + '\n\n' + gptCarrierInstruction }])
  expect(gpt.request.generationConfig).toEqual({ maxOutputTokens: 8192, thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 } })
  expect(gpt.request.tools[0].functionDeclarations).toEqual(all.map(t => ({ name: t.name, description: t.description, parameters: antigravityToolSchema(t.parameters_json_schema, false) })))
  for (const modelId of ['gemini-3.8-flash-tiered', 'gemini-4-argon', 'claude-opus-5-5-high', 'claude-sonnet-5-5-high']) {
    const body = new AntigravityModel(modelId, manager).body(history, {}, p, grant()) as any
    expect(body.request.systemInstruction.parts).toEqual([{ text: expectedOriginal }])
  }
})

test('GPT guidance is triggered by exact root codec ownership, never by a business field or schema text', () => {
  const adapter = new AntigravityModel('gpt-oss-120b-medium', manager)
  const business = closed({ __oasis_json: { type: 'string' }, data: { type: 'object', additionalProperties: {} } })
  const declaration = antigravityToolSchema(business, false)
  const rootCarrier = antigravityToolSchema({ type: 'object', properties: {} }, false)
  expect(isAntigravityArgumentCarrier(rootCarrier)).toBe(true)
  expect(isAntigravityArgumentCarrier(JSON.parse(JSON.stringify(rootCarrier)))).toBe(false)
  expect(isAntigravityArgumentCarrier(declaration)).toBe(false)
  expect(isAntigravityArgumentCarrier((declaration.properties as any).data)).toBe(false)
  expect(originalToolArguments({ __oasis_json: '{"business":true}', data: '{"key":0}' }, declaration)).toEqual({ __oasis_json: '{"business":true}', data: { key: 0 } })
  for (const tools of [[], [{ name: 'business', description: 'Uses __oasis_json as ordinary business text', parameters_json_schema: business }]]) {
    const p = { ...parameters, function_tools: tools }
    const body = adapter.body([modelRequest([systemPrompt('keep system'), userPrompt('one')], 'keep instructions')], {}, p, grant()) as any
    expect(body.request.systemInstruction.parts).toEqual([{ text: 'keep instructions\n\nkeep system' }])
    const noSystem = adapter.body(input, {}, p, grant()) as any
    expect(noSystem.request.systemInstruction).toBeUndefined()
  }
})

test('GPT carrier guidance keeps strict streaming decode and lossless original arguments; a call that does not decode comes back unrun with the reason', async () => {
  const all = specs().map(s => ({ name: s.name, description: s.description, parameters_json_schema: parametersSchema(s) }))
  const original = { path: 'synthetic-path', offset: 1, limit: 1, __oasis_json: 'business value', zero: 0, no: false, nil: null }
  for (const [wireArgs, valid] of [
    [{ __oasis_json: JSON.stringify(original) }, true],
    [original, false],
    [{ __oasis_json: JSON.stringify(original), path: 'synthetic-path' }, false],
    [{ __oasis_json: '{"path":"synthetic-secret","path":"duplicate"}' }, false],
  ] as const) {
    const model = new AntigravityModel('gpt-oss-120b-medium', manager, { fetchImpl: async (url, init) => {
      if (String(url) !== STREAM_URL) return Response.json({ models: { 'gpt-oss-120b-medium': {} } })
      const body = JSON.parse(String(init?.body))
      expect(body.request.systemInstruction.parts).toEqual([{ text: gptCarrierInstruction }])
      expect(body.request.tools[0].functionDeclarations.length).toBe(21)
      return stream([frame([{ functionCall: { name: 'read_file', args: wireArgs } }], 'STOP')])
    } })
    const response = model.request(input, {}, { ...parameters, function_tools: all })
    const part = (await response).parts[0] as { args: unknown; provider_details: Record<string, unknown> }
    if (valid) {
      expect(part).toMatchObject({ part_kind: 'tool-call', tool_name: 'read_file', args: original, provider_details: { wire_args: wireArgs } })
      expect(part.provider_details.args_problem).toBeUndefined()
    } else {
      // not run and never guessed: no arguments, the reason for the model, and nothing of the carrier in the reason
      expect(part).toMatchObject({ part_kind: 'tool-call', tool_name: 'read_file', args: {}, provider_details: { wire_args: wireArgs, args_problem: PROMPT_TEXT['app.carrier_malformed'] } })
      expect(String(part.provider_details.args_problem)).not.toContain('synthetic')
    }
  }
})
