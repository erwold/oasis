/** The Gemini 4 Argon stream probe (scripts/argon_probe.ts, docs/argon-probe-runbook.md), offline: every "provider"
 *  here is a loopback Bun.serve or a scripted fetch, under the suite's network guard (left as it is). What is held:
 *  importing the command changes nothing; its flags are a whitelist; the real key goes only to the exact official
 *  origin (and is never even read otherwise); a dry run makes no request; the budget takes a seat before every
 *  physical request — the app's own retries and the resume hops included — and past it aborts the main signal so no
 *  retry loop waits on; a drop like the user's ("The socket connection was closed unexpectedly") is measured (gaps,
 *  silence at the end, checkpoints) and resumed from the last continuationToken with the identical body; the pinned
 *  mode sends the file's body through the app's own requestStream unchanged; the app mode sends what buildModel
 *  builds, signatures included, and refuses when it differs from the expected wire; redirects are never followed; no
 *  summary holds a key, token, signature, prompt or error text; the idle endpoint really answers a request and logs a
 *  client that went away. */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import * as lib from '../scripts/argon_probe_lib.ts'
import { postJson } from '../src/llm/http.ts'
import { GoogleModel } from '../src/llm/providers.ts'
import type { ModelMessage } from '../src/llm/messages.ts'
import { rememberTempDir } from './temp_dirs.ts'

type Cli = typeof import('../scripts/argon_probe.ts')
let cli: Cli

const root = (() => { const d = mkdtempSync(join(tmpdir(), 'argon-probe-test-')); rememberTempDir(d); chmodSync(d, 0o700); return d })()
const SIG = 'U0lHTkFUVVJFLWZvci1hcmdvbi1wcm9iZS0xMjM0NTY3OA=='
const TOKENS = ['CT-checkpoint-one-0123456789abcdef', 'CT-checkpoint-two-0123456789abcdef']
const PROMPT = 'Please review the attached calc.py file for bugs very carefully'
const REAL_KEY = 'REAL-KEY-must-never-be-read-or-sent-1234'
const SYNTHETIC = 'argon-probe-synthetic-key-not-real'

function googleBody(): Record<string, unknown> {
  return {
    contents: [
      { role: 'user', parts: [{ text: PROMPT }] },
      { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'read_file', args: { path: 'calc.py' } }, thoughtSignature: SIG }] },
      { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'read_file', response: { text: 'def add(a, b):\n    return a - b\n' } } }] },
    ],
    systemInstruction: { parts: [{ text: 'You are an oasis-code agent working carefully.' }] },
    tools: [{ functionDeclarations: [{ name: 'read_file', description: 'Read a file', parametersJsonSchema: { type: 'object', properties: { path: { type: 'string' } } } }] }],
    generationConfig: { maxOutputTokens: 65_536, thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } },
  }
}

let fileSeq = 0
function privateFile(value: unknown): string {
  const path = join(root, `in-${++fileSeq}.json`)
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
  return path
}
function outDir(): string { const d = join(root, `out-${++fileSeq}`); return d }

const sse = (c: unknown) => `data: ${JSON.stringify(c)}\r\n\r\n`
const chunk = (parts: Record<string, unknown>[], extra: { finish?: string; token?: string; usage?: Record<string, number> } = {}) => {
  const candidate: Record<string, unknown> = { content: { role: 'model', parts }, index: 0 }
  if (extra.finish) candidate.finishReason = extra.finish
  if (extra.token) candidate.continuationToken = extra.token
  return { candidates: [candidate], modelVersion: 'gemini-4-argon', responseId: 'r1', ...(extra.usage ? { usageMetadata: extra.usage } : {}) }
}

interface Seen { headers: Headers; body: Record<string, unknown> }
type Plan = { pieces: string[]; drop?: boolean; status?: number; headers?: Record<string, string>; gapMs?: number }

/** A loopback "Gemini": each request gets the plan for its number; a drop ends the body as a cut socket does. */
function fakeGemini(plan: (n: number, body: Record<string, unknown>) => Plan) {
  const seen: Seen[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0, idleTimeout: 0,
    error() { return new Response(null, { status: 500 }) },
    async fetch(req) {
      const body = await req.json() as Record<string, unknown>
      seen.push({ headers: req.headers, body })
      const p = plan(seen.length, body)
      if (p.status && p.status !== 200) return new Response(p.pieces.join(''), { status: p.status, headers: p.headers })
      let i = 0
      return new Response(new ReadableStream({
        async pull(c) {
          await Bun.sleep(p.gapMs ?? 5)
          if (i < p.pieces.length) c.enqueue(new TextEncoder().encode(p.pieces[i++]!))
          else if (p.drop) c.error(new Error('cut'))   // the fake's intended drop: Bun prints it as "error: cut"
          else c.close()
        },
      }), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { server, seen, base: `http://127.0.0.1:${server.port}` }
}

function capture() {
  const out: string[] = [], err: string[] = []
  return { io: { out: (s: string) => { out.push(s) }, err: (s: string) => { err.push(s) }, sleep: async () => {} }, out, err, json: () => JSON.parse(out.join('')) as Record<string, any> }
}

const probeAppDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('argon-probe-app-'))

beforeAll(() => { process.env.ARGON_PROBE_API_KEY = REAL_KEY })
afterAll(() => { delete process.env.ARGON_PROBE_API_KEY })

// -- import, flags, origins ----------------------------------------------------------------------------------------

test('importing the command creates no folder and changes no environment variable or global fetch', async () => {
  const env = JSON.stringify(process.env)
  const dirs = probeAppDirs()
  const fetchBefore = globalThis.fetch
  cli = await import('../scripts/argon_probe.ts')
  expect(JSON.stringify(process.env)).toBe(env)
  expect(probeAppDirs()).toEqual(dirs)
  expect(globalThis.fetch).toBe(fetchBefore)
  expect(typeof cli.main).toBe('function')
})

test('flags are a whitelist per command: a misspelt budget or mode flag, a duplicate, a stray word are refused', () => {
  expect(() => cli.parseArgs(['gemini', '--max-fetch', '3'])).toThrow(/unknown flag --max-fetch/)
  expect(() => cli.parseArgs(['gemini', '--mode', 'raw', '--mode', 'app'])).toThrow(/twice/)
  expect(() => cli.parseArgs(['gemini', '--port', '1'])).toThrow(/unknown flag/)
  expect(() => cli.parseArgs(['gemini', 'live'])).toThrow(/unexpected argument/)
  expect(() => cli.parseArgs(['gemini', '--out'])).toThrow(/needs a value/)
  expect(() => cli.parseArgs(['fetch-everything'])).toThrow(/unknown command/)
  const a = cli.parseArgs(['gemini', '--live', '--max-fetches', '2', '--out', 'x'])
  expect(a.bools.has('live')).toBe(true)
  expect(a.flags.get('max-fetches')).toBe('2')
})

test('the real key goes only to the exact official origin: https, default port, no user info, no path', () => {
  expect(lib.isOfficialGoogleOrigin('https://generativelanguage.googleapis.com')).toBe(true)
  expect(lib.isOfficialGoogleOrigin('https://generativelanguage.googleapis.com:443/')).toBe(true)
  for (const u of ['http://generativelanguage.googleapis.com', 'https://generativelanguage.googleapis.com:8443', 'https://u:p@generativelanguage.googleapis.com',
    'https://generativelanguage.googleapis.com.evil.example', 'https://generativelanguage.googleapis.com/proxy', 'http://127.0.0.1:9', 'not a url']) {
    expect(lib.isOfficialGoogleOrigin(u)).toBe(false)
  }
})

// -- budget and errors ---------------------------------------------------------------------------------------------

test('the budget takes a seat before each request; past it the main signal is aborted, so postJson\'s retry stops at once', async () => {
  let inner = 0
  const fake = async () => { inner += 1; return new Response('busy', { status: 503 }) }
  const budget = new lib.FetchBudget(1, fake, new AbortController())
  const t0 = Date.now()
  const error = await postJson('http://gemini.mock/x', { a: 1 }, {}, 'gemini-4-argon', { fetchImpl: budget.fetch, maxRetries: 2 }, budget.controller.signal).catch((e) => e)
  expect(inner).toBe(1)                                   // the retry asked again and was refused before any byte
  expect(error).toBeInstanceOf(lib.ProbeBudgetError)
  expect(budget.controller.signal.aborted).toBe(true)
  expect(budget.attempted).toBe(1)
  expect(budget.refused).toBe(1)
  expect(Date.now() - t0).toBeLessThan(3_000)              // one 500 ms backoff, never the 1 s and 2 s ones after it
  expect(() => new lib.FetchBudget(lib.ABSOLUTE_MAX_FETCHES + 1, fake, new AbortController())).toThrow(lib.ProbeUsageError)
})

test('a cancel aborts the request in flight and refuses every later one', async () => {
  let seenSignal: AbortSignal | undefined
  const hang = (_i: string | URL, init?: RequestInit) => new Promise<Response>((_r, reject) => { seenSignal = init?.signal ?? undefined; init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))) })
  const budget = new lib.FetchBudget(3, hang, new AbortController())
  const pending = budget.fetch('http://gemini.mock/x', {}).catch((e) => e)
  budget.cancel()
  expect(await pending).toBeInstanceOf(Error)
  expect(seenSignal?.aborted).toBe(true)
  expect(await budget.fetch('http://gemini.mock/y', {}).catch((e) => e)).toBeInstanceOf(lib.ProbeCancelledError)
  expect(budget.attempted).toBe(1)
})

test('errors are summarized by whitelist: a name, a code, a category — never their text', () => {
  const parse = new SyntaxError(`Unexpected token in JSON at position 3: {"contents":"${PROMPT}"}`)
  const s = lib.errorSummary(parse)
  expect(JSON.stringify(s)).not.toContain('calc.py')
  expect(s).toMatchObject({ name: 'SyntaxError', category: 'other' })
  const drop = Object.assign(new TypeError('The socket connection was closed unexpectedly. For more information, pass `verbose: true`'), { code: 'ECONNRESET' })
  expect(lib.errorSummary(drop)).toEqual({ name: 'TypeError', kind: null, code: 'ECONNRESET', status: null, category: 'socket_closed_unexpectedly' })
  const odd = Object.assign(new Error('x'), { name: `Weird ${PROMPT}`, code: 'has spaces in it' })
  expect(lib.errorSummary(odd)).toMatchObject({ name: 'other', code: null })
})

test('outcomes keep the transport and the response apart; a tool call or a STOP is not a judged final answer', () => {
  const base = (scan: Partial<lib.StreamScan>, end: lib.WireRecord['end'] = 'eof', first: number | null = 10): lib.WireRecord => ({
    seq: 1, label: 'x', url_origin_path: '', request_bytes: 0, body_hash_canonical: null, resume_token_hash: null, socket_idle_timeout: 'bun-default', status: 200,
    headers_ms: 1, first_byte_ms: first, last_byte_ms: first, end, end_ms: 20, silence_at_end_ms: 10, bytes: 1, reads: 1, max_gap_ms: 1, top_gaps_ms: [], gaps_over_s: { '30': 0, '45': 0, '55': 0, '60': 0, '75': 0 },
    error: null, scan: { sse_events: 1, error_event_status: null, finish_reason: null, usage: null, text_chars: 0, thought_chars: 0, function_calls: 0, signatures: 0, checkpoints: [], ...scan },
  })
  // the user's small high request: MAX_TOKENS with thinking at the cap and three tokens of words — not an answer
  expect(lib.outcomeOf(base({ finish_reason: 'MAX_TOKENS', text_chars: 12 }))).toEqual({ transport: 'clean_eof', response: 'max_tokens', final_answer: 'manual_review_needed' })
  expect(lib.outcomeOf(base({ finish_reason: 'STOP', function_calls: 1 })).response).toBe('stop_tool_call')
  expect(lib.outcomeOf(base({ finish_reason: 'STOP', text_chars: 3 })).response).toBe('stop_without_text')
  expect(lib.outcomeOf(base({ finish_reason: 'STOP', text_chars: 400 })).response).toBe('stop_text_candidate')
  expect(lib.outcomeOf(base({ finish_reason: 'CONTINUATION' })).response).toBe('continuation')
  expect(lib.outcomeOf(base({}, 'error'))).toMatchObject({ transport: 'dropped_mid_stream', response: 'no_finish' })
  expect(lib.outcomeOf(base({}, 'error', null)).transport).toBe('dropped_before_first_byte')
})

test('the cost figure is a rough estimate, never a limit, priced for the date it runs', () => {
  const shape = lib.bodyShape(googleBody())
  const oct = lib.costEstimate(shape, 3, new Date('2026-10-14T00:00:00Z'))
  const dec = lib.costEstimate(shape, 3, new Date('2026-12-01T00:00:00Z'))
  expect(oct).toMatchObject({ price_version: '2026-10', physical_requests: 3, max_output_tokens_per_request: 65_536 })
  expect(dec.price_version).toBe('2026-12')
  expect(dec.rough_estimate_usd as number).toBeGreaterThan(oct.rough_estimate_usd as number)
  expect(oct.hard_limit).toMatch(/only the number of physical requests/)
  expect(Object.keys(oct).some((k) => /worst|max_usd|limit_usd/.test(k))).toBe(false)
})

test('the output folder must be private; the request file must be the person\'s alone; parse errors quote nothing', () => {
  const open = join(root, 'open-dir')
  mkdirSync(open, { mode: 0o755 })
  chmodSync(open, 0o755)
  expect(() => lib.prepareOutputDir(open)).toThrow(/open to others/)
  const shared = join(root, 'shared.json')
  writeFileSync(shared, JSON.stringify(googleBody()), { mode: 0o644 })
  chmodSync(shared, 0o644)
  expect(() => lib.loadGoogleBody(shared)).toThrow(/chmod 600/)
  const broken = join(root, 'broken.json')
  writeFileSync(broken, `{"contents": "${PROMPT}`, { mode: 0o600 })
  let message = ''
  try { lib.loadGoogleBody(broken) } catch (e) { message = (e as Error).message }
  expect(message).toBe('the Google body file is not valid JSON')
  expect(() => lib.loadGoogleBody(privateFile({ ...googleBody(), continuationToken: 'x' }))).toThrow(/continuationToken/)
})

// -- dry run -------------------------------------------------------------------------------------------------------

test('a dry run (the default) sends nothing, reads no key, writes a private summary without secrets, and puts everything back', async () => {
  const env = JSON.stringify(process.env)
  const dirs = probeAppDirs()
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = Object.assign(async () => { calls += 1; throw new Error('no network in a dry run') }, { preconnect: () => {} }) as typeof fetch
  const c = capture()
  try {
    const code = await cli.main(['gemini', '--body', privateFile(googleBody()), '--out', outDir(), '--mode', 'both'], c.io)
    expect(code).toBe(0)
  } finally {
    expect(calls).toBe(0)
    globalThis.fetch = original
  }
  const s = c.json()
  expect(s).toMatchObject({ live: false, mode: 'both', network_requests: 0, real_key_used: false, official_endpoint: true })
  expect(s.input).toMatchObject({ kind: 'google-body', roles: 'UMU', thinking_level: 'high', max_output_tokens: 65_536 })
  expect(s.transport_config.raw).toMatchObject({ bun_socket_idle_timeout_ms: lib.RAW_SOCKET_IDLE_MS, whole_deadline_ms: lib.RAW_WHOLE_DEADLINE_MS })
  expect(s.transport_config.raw.whole_deadline_ms).toBeGreaterThanOrEqual(lib.ARGON_SERVER_STREAM_LIMIT_MS)
  expect(s.app_adapter).toEqual({ timeout_ms: 20 * 60_000, idle_timeout_ms: 20 * 60_000 })
  const text = c.out.join('')
  for (const secret of [REAL_KEY, SIG, PROMPT]) expect(text).not.toContain(secret)
  expect(JSON.stringify(process.env)).toBe(env)
  expect(probeAppDirs()).toEqual(dirs)
  expect(globalThis.fetch).toBe(original)
})

test('live needs an explicit budget and path label; a misspelt flag never becomes a default budget', async () => {
  const body = privateFile(googleBody())
  for (const argv of [
    ['gemini', '--body', body, '--out', outDir(), '--live'],
    ['gemini', '--body', body, '--out', outDir(), '--live', '--max-fetches', '7', '--path-label', 'x'],
    ['gemini', '--body', body, '--out', outDir(), '--live', '--max-fetches', '1'],
    ['gemini', '--body', body, '--out', outDir(), '--live', '--max-fetchs', '1', '--path-label', 'x'],
    ['gemini', '--body', body, '--out', outDir(), '--max-fetches', '1'],
  ]) {
    const c = capture()
    expect(await cli.main(argv, c.io)).toBe(2)
    expect(c.out.join('')).toBe('')
  }
})

// -- live, against loopback fakes ----------------------------------------------------------------------------------

test('raw: a drop after two checkpoints is measured and resumed with the last token and the identical body; the real key is never sent off the official origin', async () => {
  const fake = fakeGemini((n) => n === 1
    ? { pieces: [
      sse(chunk([{ text: 'thinking…', thought: true }], { usage: { promptTokenCount: 900, thoughtsTokenCount: 32_768 } })),
      sse(chunk([{ text: '', thoughtSignature: SIG }], { token: TOKENS[0], usage: { promptTokenCount: 900, thoughtsTokenCount: 32_800 } })),
      sse(chunk([{ text: 'more…', thought: true }], { token: TOKENS[1], usage: { promptTokenCount: 900, thoughtsTokenCount: 37_800 } })),
    ], drop: true }
    : { pieces: [sse(chunk([{ text: 'The bug: add() subtracts. Change `a - b` to `a + b` and add a test for it.' }], { finish: 'STOP', usage: { promptTokenCount: 900, candidatesTokenCount: 20, thoughtsTokenCount: 40_000 } }))] })
  try {
    const c = capture()
    const code = await cli.main(['gemini', '--body', privateFile(googleBody()), '--out', outDir(), '--base-url', fake.base, '--live', '--max-fetches', '2', '--path-label', 'loopback', '--raw-resume', '--yes'], c.io)
    expect(code).toBe(0)
    expect(fake.seen).toHaveLength(2)
    for (const s of fake.seen) expect(s.headers.get('x-goog-api-key')).toBe(SYNTHETIC)
    const [first, second] = fake.seen
    expect('continuationToken' in first!.body).toBe(false)
    expect(second!.body.continuationToken).toBe(TOKENS[1])
    const { continuationToken: _, ...rest } = second!.body
    expect(lib.canonicalJson(rest)).toBe(lib.canonicalJson(first!.body))
    expect(lib.canonicalJson(first!.body)).toBe(lib.canonicalJson(googleBody()))

    const s = c.json()
    expect(s.real_key_used).toBe(false)
    expect(s.budget).toMatchObject({ max: 2, physical_requests: 2, refused: 0 })
    const [r1, r2] = s.requests
    expect(r1).toMatchObject({ label: 'raw#0', same_body_as_input: true, socket_idle_timeout: false, end: 'error', outcome: { transport: 'dropped_mid_stream', response: 'no_finish' } })
    expect(r1.error).toMatchObject({ code: 'ECONNRESET', category: 'socket_closed_unexpectedly' })
    expect(r1.scan.checkpoints).toHaveLength(2)
    expect(r1.scan.checkpoints[1]).toMatchObject({ token_len: TOKENS[1]!.length, output_tokens: 37_800 })
    expect(r1.scan.signatures).toBe(1)
    expect(r1.silence_at_end_ms).toBeGreaterThanOrEqual(0)
    expect(r2).toMatchObject({ label: 'raw#1', same_body_as_input: true, outcome: { transport: 'clean_eof', response: 'stop_text_candidate', final_answer: 'manual_review_needed' } })
    expect(r2.resume_token_hash).toBe(r1.scan.checkpoints[1].token_hash)
    const text = c.out.join('') + readFileSync(join(dirname(c.err.find((l) => l.startsWith('summary: '))!.slice(9)), 'summary.json'), 'utf8')
    for (const secret of [REAL_KEY, SYNTHETIC, SIG, PROMPT, ...TOKENS, 'subtracts']) expect(text).not.toContain(secret)
  } finally { fake.server.stop(true) }
})

test('raw: the budget is hard — with one request allowed, a resumable drop is not resumed', async () => {
  const fake = fakeGemini(() => ({ pieces: [sse(chunk([{ text: 'x', thought: true }], { token: TOKENS[0] }))], drop: true }))
  try {
    const c = capture()
    expect(await cli.main(['gemini', '--body', privateFile(googleBody()), '--out', outDir(), '--base-url', fake.base, '--live', '--max-fetches', '1', '--path-label', 'loopback', '--raw-resume', '--yes'], c.io)).toBe(0)
    expect(fake.seen).toHaveLength(1)
    expect(c.json().budget).toMatchObject({ physical_requests: 1 })
  } finally { fake.server.stop(true) }
})

test('raw: a redirect is never followed (the request carries the key)', async () => {
  const fake = fakeGemini(() => ({ pieces: [''], status: 302, headers: { location: 'http://127.0.0.1:9/elsewhere' } }))
  try {
    const c = capture()
    expect(await cli.main(['gemini', '--body', privateFile(googleBody()), '--out', outDir(), '--base-url', fake.base, '--live', '--max-fetches', '2', '--path-label', 'loopback', '--yes'], c.io)).toBe(0)
    expect(fake.seen).toHaveLength(1)
    expect(c.json().requests[0]).toMatchObject({ status: 302, outcome: { transport: 'http_status' } })
  } finally { fake.server.stop(true) }
})

test('pinned: the file body goes out unchanged through the app\'s own requestStream; the drop surfaces as the app reports it', async () => {
  const fake = fakeGemini(() => ({ pieces: [sse(chunk([{ text: 'x', thought: true }], { token: TOKENS[0], usage: { promptTokenCount: 900, thoughtsTokenCount: 32_800 } }))], drop: true }))
  const dirs = probeAppDirs()
  try {
    const c = capture()
    expect(await cli.main(['gemini', '--body', privateFile(googleBody()), '--out', outDir(), '--mode', 'pinned', '--base-url', fake.base, '--live', '--max-fetches', '1', '--path-label', 'loopback', '--yes'], c.io)).toBe(0)
    expect(fake.seen).toHaveLength(1)
    expect(lib.canonicalJson(fake.seen[0]!.body)).toBe(lib.canonicalJson(googleBody()))
    expect(fake.seen[0]!.headers.get('x-goog-api-key')).toBe(SYNTHETIC)
    const s = c.json()
    expect(s.requests[0]).toMatchObject({ label: 'pinned#0', same_body_as_input: true, socket_idle_timeout: false, outcome: { transport: 'dropped_mid_stream' } })   // the candidate's Argon init: Bun's idle off
    // the candidate's adapter resumes from the checkpoint: that resume is the second fetch call, refused by the budget
    // of 1 before any byte — one physical request, two adapter calls
    expect(s.outcomes.pinned).toMatchObject({ outcome: 'threw', physical_requests: 1, adapter_fetch_calls: 2, error: { name: 'ProbeBudgetExhausted', category: 'probe_budget' } })
    expect(s.budget).toMatchObject({ max: 1, physical_requests: 1, refused: 1 })
    expect(c.out.join('')).not.toContain(TOKENS[0])
  } finally { fake.server.stop(true) }
  expect(probeAppDirs()).toEqual(dirs)
  expect(process.env.OASIS_CODE_AUTH_DIR).toBeUndefined()
})

test('app: an app-native request goes out as buildModel builds it — signatures and provider call ids included — and a different expected wire refuses', async () => {
  const fake = fakeGemini(() => ({ pieces: [sse(chunk([{ functionCall: { id: 'c2', name: 'read_file', args: { path: 'test_calc.py' } }, thoughtSignature: SIG }], { finish: 'STOP', usage: { promptTokenCount: 900, candidatesTokenCount: 5, thoughtsTokenCount: 50 } }))] }))
  try {
    const route = new GoogleModel('gemini-4-argon', { baseUrl: fake.base, apiKey: 'x' }).route
    const messages = [
      { kind: 'request', parts: [{ part_kind: 'user-prompt', content: PROMPT, timestamp: '2026-10-14T00:00:00Z' }], instructions: 'You are an oasis-code agent working carefully.' },
      { kind: 'response', parts: [{ part_kind: 'tool-call', tool_name: 'read_file', args: { path: 'calc.py' }, tool_call_id: 'c1', id: null, provider_name: 'google', provider_details: { thought_signature: SIG, call_id: 'c1' } }],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, model_name: 'gemini-4-argon', timestamp: '2026-10-14T00:00:01Z', provider_name: 'google', provider_details: { route }, provider_response_id: null },
      { kind: 'request', parts: [{ part_kind: 'tool-return', tool_name: 'read_file', content: { text: 'def add(a, b):\n    return a - b\n' }, tool_call_id: 'c1', timestamp: '2026-10-14T00:00:02Z' }] },
    ] as unknown as ModelMessage[]
    const settings = { max_tokens: 65_536 }
    const params = { function_tools: [{ name: 'read_file', description: 'Read a file', parameters_json_schema: { type: 'object', properties: { path: { type: 'string' } } } }], allow_text_output: true, thinking: 'high' }
    const expected = new GoogleModel('gemini-4-argon', { baseUrl: fake.base, apiKey: 'x' }).body(messages, settings, params)
    expect(lib.canonicalJson(expected)).toBe(lib.canonicalJson(googleBody()))   // the fixture is the app's own wire
    const request = (exp: unknown) => privateFile({ format: lib.APP_REQUEST_FORMAT, messages, settings, params, expected_body: exp })

    const wrong = capture()
    expect(await cli.main(['gemini', '--app-request', request({ ...expected, generationConfig: { maxOutputTokens: 32_768 } }), '--out', outDir(), '--base-url', fake.base, '--live', '--max-fetches', '1', '--path-label', 'loopback', '--yes'], wrong.io)).toBe(2)
    expect(fake.seen).toHaveLength(0)

    const dry = capture()
    expect(await cli.main(['gemini', '--app-request', request(expected), '--out', outDir(), '--base-url', fake.base], dry.io)).toBe(0)
    expect(dry.json().app_body_check).toEqual({ expected_body_given: true, matches_expected: true, diff_paths_expected_vs_app: [], app_body_signatures: 1 })

    const c = capture()
    expect(await cli.main(['gemini', '--app-request', request(expected), '--out', outDir(), '--base-url', fake.base, '--live', '--max-fetches', '1', '--path-label', 'loopback', '--yes'], c.io)).toBe(0)
    expect(fake.seen).toHaveLength(1)
    expect(lib.canonicalJson(fake.seen[0]!.body)).toBe(lib.canonicalJson(expected))
    const s = c.json()
    expect(s.requests[0]).toMatchObject({ label: 'app#0', same_body_as_input: true, outcome: { transport: 'clean_eof', response: 'stop_tool_call', final_answer: 'manual_review_needed' } })
    expect(s.outcomes.app).toMatchObject({ outcome: 'returned', finish_reason: 'tool_call', physical_requests: 1 })
    for (const secret of [SIG, PROMPT, REAL_KEY]) expect(c.out.join('')).not.toContain(secret)
  } finally { fake.server.stop(true) }
})

test('--save-text (off by default) writes only the returned response\'s words, privately; raw writes no merged text', async () => {
  const ANSWER = 'The bug is in add(): it subtracts. Change `a - b` to `a + b`.'
  const fake = fakeGemini(() => ({ pieces: [
    sse(chunk([{ text: 'secret chain of thought here', thought: true }])),
    sse(chunk([{ text: ANSWER, thoughtSignature: SIG }], { finish: 'STOP', usage: { promptTokenCount: 900, candidatesTokenCount: 20, thoughtsTokenCount: 50 } })),
  ] }))
  const runDirOf = (c: ReturnType<typeof capture>) => dirname(c.err.find((l) => l.startsWith('summary: '))!.slice(9))
  try {
    const both = capture()
    expect(await cli.main(['gemini', '--body', privateFile(googleBody()), '--out', outDir(), '--mode', 'both', '--base-url', fake.base, '--live', '--max-fetches', '2', '--path-label', 'loopback', '--save-text', '--yes'], both.io)).toBe(0)
    const s = both.json()
    expect(s.requests[0].outcome).toEqual({ transport: 'clean_eof', response: 'stop_text_candidate', final_answer: 'manual_review_needed' })
    expect(s.answer_text).toMatch(/pinned run only/)
    expect(s.outcomes.pinned).toMatchObject({ outcome: 'returned', finish_reason: 'stop', final_answer: 'manual_review_needed', answer_file: { name: 'answer-pinned.private.txt', chars: ANSWER.length } })
    const file = join(runDirOf(both), 'answer-pinned.private.txt')
    expect(readFileSync(file, 'utf8')).toBe(ANSWER)                       // the words only: no thought, no signature
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(runDirOf(both)).filter((n) => n.startsWith('answer-'))).toEqual(['answer-pinned.private.txt'])
    expect(both.out.join('')).not.toContain('subtracts')

    const raw = capture()
    expect(await cli.main(['gemini', '--body', privateFile(googleBody()), '--out', outDir(), '--base-url', fake.base, '--live', '--max-fetches', '1', '--path-label', 'loopback', '--save-text', '--yes'], raw.io)).toBe(0)
    expect(raw.json().answer_text).toMatch(/^not written: raw mode/)
    expect(readdirSync(runDirOf(raw))).toEqual(['summary.json'])

    const off = capture()
    expect(await cli.main(['gemini', '--body', privateFile(googleBody()), '--out', outDir(), '--mode', 'pinned', '--base-url', fake.base, '--live', '--max-fetches', '1', '--path-label', 'loopback', '--yes'], off.io)).toBe(0)
    expect(readdirSync(runDirOf(off))).toEqual(['summary.json'])
  } finally { fake.server.stop(true) }
})

// -- Brotli through the probe's own transport (CVE-2026-111497) -----------------------------------------------------

/** A loopback "Gemini" whose stream comes with a chosen Content-Encoding: gzip of a real SSE answer, or bytes a Brotli
 *  decoder rejects at once (had fetch's own decoder run on them, the error would be its BrotliDecompressionError). */
function encodedGemini(encoding: 'gzip' | 'br') {
  const answer = sse(chunk([{ text: 'Fixed: add() now adds.' }], { finish: 'STOP', usage: { promptTokenCount: 10, candidatesTokenCount: 5 } }))
  const body = encoding === 'gzip' ? Bun.gzipSync(new TextEncoder().encode(answer)) : new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 1, 2, 3])
  let hits = 0
  const seenEncodings: (string | null)[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(req) {
    hits += 1
    seenEncodings.push(req.headers.get('accept-encoding'))
    await req.arrayBuffer()
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'content-encoding': encoding } })
  } })
  return { server, base: `http://127.0.0.1:${server.port}`, hits: () => hits, seenEncodings }
}

test('raw, through the budget and the meter: a gzip stream is read as before; a Brotli one is refused undecoded, once', async () => {
  const gz = encodedGemini('gzip')
  try {
    const c = capture()
    expect(await cli.main(['gemini', '--body', privateFile(googleBody()), '--out', outDir(), '--base-url', gz.base, '--live', '--max-fetches', '1', '--path-label', 'loopback', '--yes'], c.io)).toBe(0)
    const s = c.json()
    // decoded here: the scanner read the SSE event and its 22 characters of text (gzip bytes would not parse as SSE)
    expect(s.requests[0]).toMatchObject({ status: 200, end: 'eof', outcome: { transport: 'clean_eof' }, scan: { sse_events: 1, finish_reason: 'STOP', text_chars: 'Fixed: add() now adds.'.length } })
    expect(gz.seenEncodings).toEqual(['gzip, deflate'])
  } finally { gz.server.stop(true) }
  const br = encodedGemini('br')
  try {
    const c = capture()
    expect(await cli.main(['gemini', '--body', privateFile(googleBody()), '--out', outDir(), '--base-url', br.base, '--live', '--max-fetches', '2', '--path-label', 'loopback', '--raw-resume', '--yes'], c.io)).toBe(0)
    const s = c.json()
    expect(s.outcomes.raw.hops[0].error).toMatchObject({ name: 'ContentEncodingRefused', code: 'ERR_CONTENT_ENCODING_REFUSED' })
    expect(JSON.stringify(s)).not.toContain('BrotliDecompressionError')
    expect(s.budget).toMatchObject({ physical_requests: 1 })
    expect(br.hits()).toBe(1)
  } finally { br.server.stop(true) }
})

test('pinned, through the app\'s own requestStream on the probe\'s budget: a Brotli stream is refused, not retried', async () => {
  const br = encodedGemini('br')
  try {
    const c = capture()
    expect(await cli.main(['gemini', '--body', privateFile(googleBody()), '--out', outDir(), '--mode', 'pinned', '--base-url', br.base, '--live', '--max-fetches', '2', '--path-label', 'loopback', '--app-max-retries', '2', '--yes'], c.io)).toBe(0)
    const s = c.json()
    expect(s.outcomes.pinned).toMatchObject({ outcome: 'threw', error: { name: 'ContentEncodingRefused', code: 'ERR_CONTENT_ENCODING_REFUSED' }, physical_requests: 1 })
    expect(br.hits()).toBe(1)
  } finally { br.server.stop(true) }
})

test('idle-client: a Brotli answer from the --url host is refused undecoded', async () => {
  const br = encodedGemini('br')
  process.env.IDLE_PROBE_SECRET = 'a-long-shared-secret-0123'
  try {
    const c = capture()
    expect(await cli.main(['idle-client', '--url', `${br.base}/idle`, '--out', outDir(), '--gaps', '0', '--live', '--path-label', 'loopback'], c.io)).toBe(0)
    const s = c.json()
    expect(s.results[0]).toMatchObject({ survived: false, error: { name: 'ContentEncodingRefused', code: 'ERR_CONTENT_ENCODING_REFUSED' } })
  } finally { delete process.env.IDLE_PROBE_SECRET; br.server.stop(true) }
})

test('safeFetchVia reaches the transport it was given while a wrapper holds the global fetch (no loop), decompress: false last', async () => {
  const { safeFetchVia } = await import('../src/safe_fetch.ts')
  const br = encodedGemini('br')
  const captured = globalThis.fetch.bind(globalThis)
  const inits: RequestInit[] = []
  const via = safeFetchVia((input, init) => { inits.push(init!); return captured(input, init) })
  const original = globalThis.fetch
  let wrapped = 0
  globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => { wrapped += 1; return via(input instanceof Request ? input.url : input, init) }, { preconnect: () => {} }) as typeof fetch
  try {
    await expect(fetch(br.base, { method: 'POST', body: '{}', decompress: true } as RequestInit)).rejects.toMatchObject({ name: 'ContentEncodingRefused' })
    expect(wrapped).toBe(1)
    expect(inits).toHaveLength(1)
    expect((inits[0] as { decompress?: unknown }).decompress).toBe(false)
  } finally { globalThis.fetch = original; br.server.stop(true) }
})

// -- the idle endpoint ---------------------------------------------------------------------------------------------

test('idle selftest: a real request, headers at once, a planned silence, a done chunk — on the loopback only', async () => {
  const c = capture()
  expect(await cli.main(['idle-selftest', '--gaps', '0.3,0.1', '--heartbeat', '0.1'], c.io)).toBe(0)
  const s = c.json()
  expect(s.results.map((r: { survived: boolean }) => r.survived)).toEqual([true, true])
  expect(s.results[0].bun_socket_idle_timeout).toBe(false)
  expect(s.results[0].whole_deadline_ms).toBeGreaterThanOrEqual(lib.ARGON_SERVER_STREAM_LIMIT_MS)
  expect(c.err.some((l) => l.includes('"ev":"done"'))).toBe(true)
})

test('idle server: a wrong secret is refused; a client that goes away mid-silence is logged on the server side', async () => {
  const events: Record<string, unknown>[] = []
  const secret = 'a-long-shared-secret-0123'
  const handler = lib.idleHandler({ secret, log: (e) => { events.push(e) } })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: (req) => handler(req, null) })
  try {
    const url = `http://127.0.0.1:${server.port}/idle`
    expect((await fetch(url, { method: 'POST', headers: { 'x-idle-probe-secret': 'wrong-secret-xxxxxxxxx' }, body: '{}' })).status).toBe(403)
    const abort = new AbortController()
    const res = await fetch(url, { method: 'POST', headers: { 'x-idle-probe-secret': secret }, body: JSON.stringify({ plan: { gaps_s: [5] } }), signal: abort.signal })
    const reader = res.body!.getReader()
    await reader.read()                                     // the first chunk, then the planned silence
    abort.abort()
    for (let i = 0; i < 50 && !events.some((e) => e.ev === 'client_gone'); i++) await Bun.sleep(20)
    expect(events.map((e) => e.ev)).toEqual(expect.arrayContaining(['request', 'headers_sent', 'client_gone']))
    expect(events.some((e) => e.ev === 'done')).toBe(false)
  } finally { server.stop(true) }
})

test('the probe reaches no app entry point, server, director or database connection (its import closure)', () => {
  const t = new Bun.Transpiler({ loader: 'ts' })
  const seen = new Set<string>()
  const walk = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const i of t.scanImports(readFileSync(file, 'utf8'))) {
      if (!i.path.startsWith('.')) continue
      const p = resolve(dirname(file), i.path)
      if (existsSync(p)) walk(p)
    }
  }
  walk(resolve(import.meta.dir, '../scripts/argon_probe.ts'))
  const rel = [...seen].map((p) => p.slice(resolve(import.meta.dir, '..').length + 1))
  expect(rel).toContain('src/llm/providers/google.ts')
  for (const forbidden of ['src/index.ts', 'src/main.ts', 'src/db/database.ts', 'src/agent/runner.ts']) expect(rel).not.toContain(forbidden)
  expect(rel.filter((p) => p.startsWith('src/api/') || p.startsWith('src/director/'))).toEqual([])
})

// -- closing checks: long decode through the probe -----------------------------------------------------------------

test('pinned with a file total above one stream\'s cap: the adapter takes the CONTINUATION hop (the file body decides, not the probe\'s route)', async () => {
  const body = { ...googleBody(), generationConfig: { maxOutputTokens: 262_144, thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } } }
  const fake = fakeGemini((n) => n === 1
    ? { pieces: [sse(chunk([{ text: 'x', thought: true }], { token: TOKENS[0], usage: { promptTokenCount: 900, thoughtsTokenCount: 32_800 } })), sse(chunk([{ text: 'Half.' }], { finish: 'CONTINUATION', token: TOKENS[1], usage: { promptTokenCount: 900, thoughtsTokenCount: 65_000, candidatesTokenCount: 536 } }))] }
    : { pieces: [sse(chunk([{ text: ' Whole answer here.' }], { finish: 'STOP', usage: { promptTokenCount: 900, candidatesTokenCount: 10 } }))] })
  try {
    const c = capture()
    expect(await cli.main(['gemini', '--body', privateFile(body), '--out', outDir(), '--mode', 'pinned', '--base-url', fake.base, '--live', '--max-fetches', '2', '--path-label', 'loopback', '--yes'], c.io)).toBe(0)
    expect(fake.seen).toHaveLength(2)
    expect(fake.seen[1]!.body.continuationToken).toBe(TOKENS[1])
    const { continuationToken: _t, ...rest } = fake.seen[1]!.body
    expect(lib.canonicalJson(rest)).toBe(lib.canonicalJson(body))
    const s = c.json()
    expect(s.outcomes.pinned).toMatchObject({ outcome: 'returned', finish_reason: 'stop', physical_requests: 2, adapter_fetch_calls: 2 })
    expect(c.out.join('')).not.toContain(TOKENS[1])
  } finally { fake.server.stop(true) }
  // dry: the file's total is shown (a run at 65,536 cannot take a hop: the adapter hops only above one stream's cap)
  const dry = capture()
  expect(await cli.main(['gemini', '--body', privateFile(body), '--out', outDir(), '--mode', 'pinned'], dry.io)).toBe(0)
  expect(dry.json().input.max_output_tokens).toBe(262_144)
})

test('a LongDecodeInterrupted is summarised by its counts and failure facts only; a live run refuses Bun\'s verbose fetch', async () => {
  const { LongDecodeInterrupted } = await import('../src/llm/model.ts')
  const e = new LongDecodeInterrupted('gemini-4-argon', `Gemini long decode interrupted after 2 checkpoints … ${PROMPT}`, {
    resumes: 5, checkpoints: 2, hops: 0, last_error: `quoted ${PROMPT}`,
    failure: { name: 'ReadError', transport_kind: 'ReadError', status_code: null, provider_status: null, reason: null },
  })
  const summary = lib.errorSummary(e)
  expect(summary).toEqual({ name: 'LongDecodeInterrupted', kind: null, code: null, status: null, category: 'long_decode_interrupted',
    long_decode: { resumes: 5, checkpoints: 2, hops: 0, failure: { name: 'ReadError', transport_kind: 'ReadError', status_code: null, provider_status: null, reason: null } } })
  expect(JSON.stringify(summary)).not.toContain(PROMPT)
  expect(lib.verboseFetchOn(undefined)).toBe(false)
  for (const v of ['', '0', 'false']) expect(lib.verboseFetchOn(v)).toBe(false)
  for (const v of ['1', 'true', 'curl']) expect(lib.verboseFetchOn(v)).toBe(true)
  const fake = fakeGemini(() => ({ pieces: [sse(chunk([{ text: 'x' }], { finish: 'STOP' }))] }))
  const before = process.env.BUN_CONFIG_VERBOSE_FETCH
  process.env.BUN_CONFIG_VERBOSE_FETCH = 'curl'
  try {
    const c = capture()
    expect(await cli.main(['gemini', '--body', privateFile(googleBody()), '--out', outDir(), '--base-url', fake.base, '--live', '--max-fetches', '1', '--path-label', 'loopback', '--yes'], c.io)).toBe(2)
    expect(fake.seen).toHaveLength(0)
  } finally {
    if (before === undefined) delete process.env.BUN_CONFIG_VERBOSE_FETCH
    else process.env.BUN_CONFIG_VERBOSE_FETCH = before
    fake.server.stop(true)
  }
})
