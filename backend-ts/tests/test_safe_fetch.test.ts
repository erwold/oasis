/** safeFetch, the backend's one door for outbound HTTP while the runtime's Brotli decoder carries CVE-2026-111497
 *  (src/safe_fetch.ts, docs/brotli-cve-2026-111497.md). Real sockets: the server is its own process
 *  (fixtures/encoded_server.ts) speaking chosen Content-Encodings with synthetic bytes on the loopback.
 *
 *  What is shown where: the byte-exact raw option and the refusals show the body reached this process undecoded; the
 *  child-process check shows the native decoder's own error report — present for plain fetch on the same bytes — is
 *  absent for safeFetch and for representative product paths (fetch_url's pinnedFetch, the providers' postJson).
 *  That is evidence read from the native side's output that the decoder did not run on those bodies; it is not a hit
 *  counter on the decoder's entry point (the installed binary is stripped). The other default transports are covered
 *  by the code audit (docs/brotli-cve-2026-111497.md) and by the syntactic check at the end of this file, which finds
 *  `fetch` identifiers used as values outside safe_fetch.ts — a guard against regressions, not a proof. */

import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { Subprocess } from 'bun'
import ts from 'typescript'
import * as web from '../src/agent/tools/web.ts'
import * as repo from '../src/db/repo.ts'
import { postJson, readSse } from '../src/llm/http.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart } from '../src/llm/messages.ts'
import { ACCEPT_ENCODING, assertBunRuntime, codingPlan, ContentEncodingRefused, CVE, inflating, safeFetch, zlibHeader } from '../src/safe_fetch.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, waitDone, type AppState } from './harness.ts'

interface Fixture { port: number; plain: string; gzip: string; deflate: string; br: string; br_invalid: string }
let server: Subprocess<'ignore', 'pipe', 'pipe'> | null = null
let fx: Fixture
let base = ''

beforeAll(async () => {
  server = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', 'encoded_server.ts')], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const reader = server.stdout.getReader()
  let line = ''
  while (!line.includes('\n')) {
    const piece = await reader.read()
    if (piece.done) throw new Error('the fixture server ended before it said its port')
    line += new TextDecoder().decode(piece.value)
  }
  reader.releaseLock()
  fx = JSON.parse(line.slice(0, line.indexOf('\n'))) as Fixture
  base = `http://127.0.0.1:${fx.port}`
})
afterAll(() => { server?.kill() })

const original = { ...web.hooks }
let state: AppState | null = null
afterEach(async () => {
  web.setWebHooks(original)
  web.forgetMissingIcons()
  if (state) await closeState(state)
  state = null
})

async function refusal(run: () => Promise<unknown>): Promise<ContentEncodingRefused> {
  try { await run() } catch (error) {
    expect(error).toBeInstanceOf(ContentEncodingRefused)
    return error as ContentEncodingRefused
  }
  throw new Error('expected a ContentEncodingRefused, got a response')
}

/** What the fixture saw clients let go of, waited for (the cancel reaches the peer over the socket). */
async function released(entry: string, timeoutMs = 5000): Promise<string[]> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const seen = await (await fetch(`${base}/__released`)).json() as string[]
    if (seen.some((s) => s.startsWith(entry)) || Date.now() > until) return seen
    await Bun.sleep(50)
  }
}

const hitsOf = async (path: string): Promise<number> => ((await (await fetch(`${base}/__hits`)).json()) as Record<string, number>)[path] ?? 0

// --- the coding plan, alone ---

test('the plan for a Content-Encoding: identity passes, gzip / x-gzip / deflate decode, Brotli and the rest are refused', () => {
  expect(codingPlan(null)).toEqual({ kind: 'identity' })
  expect(codingPlan('')).toEqual({ kind: 'identity' })
  expect(codingPlan(' Identity ')).toEqual({ kind: 'identity' })
  expect(codingPlan('gzip')).toEqual({ kind: 'decode', coding: 'gzip' })
  expect(codingPlan('X-GZIP')).toEqual({ kind: 'decode', coding: 'gzip' })
  expect(codingPlan(' deflate ')).toEqual({ kind: 'decode', coding: 'deflate' })
  for (const h of ['br', 'BR', ' br ', 'gzip, br', 'br, gzip', 'identity,br', 'gzip,,BR']) expect(codingPlan(h)).toEqual({ kind: 'refuse', brotli: true })
  for (const h of ['zstd', 'compress', 'identity, gzip', 'gzip, gzip', 'gzip, deflate', 'brotli', 'x-br', 'identity, identity']) expect(codingPlan(h)).toEqual({ kind: 'refuse', brotli: false })
})

test('a zlib header is told from raw deflate by its first two bytes, as RFC 1950 writes it', () => {
  const z = Buffer.from(require('node:zlib').deflateSync(Buffer.from('x')))
  expect(zlibHeader(z[0]!, z[1]!)).toBe(true)
  expect(zlibHeader(0x78, 0x9c)).toBe(true)
  expect(zlibHeader(0x78, 0x9d)).toBe(false)  // check bits wrong
  expect(zlibHeader(0x79, 0x9c)).toBe(false)  // not method 8
})

test('safeFetch runs on Bun only: anywhere else it throws before any request', () => {
  expect(() => assertBunRuntime({ node: '24.22.0' })).toThrow(/Bun only/)
  expect(() => assertBunRuntime({ bun: '1.4.0', node: '24' })).not.toThrow()
  expect(() => assertBunRuntime()).not.toThrow()
})

// --- what passes and what is decoded ---

test('an identity body is handed on as fetch gave it', async () => {
  for (const path of ['/identity', '/identity-named']) {
    const r = await safeFetch(`${base}${path}`)
    expect(await r.text()).toBe(fx.plain)
  }
})

test('gzip, x-gzip, deflate (zlib-wrapped and raw), a spaced or upper-case coding and multi-member gzip decode to the page', async () => {
  for (const path of ['/gzip', '/x-gzip', '/gzip-spaced', '/deflate', '/deflate-raw', '/gzip-multi']) {
    const r = await safeFetch(`${base}${path}`)
    expect(r.status).toBe(200)
    expect(await r.text(), path).toBe(fx.plain)
    // the headers are the server's, as fetch's own decoding keeps them
    expect(r.headers.get('content-encoding')).toBeTruthy()
    expect(r.url).toBe(`${base}${path}`)
  }
})

test('an empty gzip body is an empty body, not an error', async () => {
  expect(await (await safeFetch(`${base}/gzip-empty`)).text()).toBe('')
})

test('the raw option hands on the exact bytes the server sent, with their header', async () => {
  const r = await safeFetch(`${base}/gzip`, { decompress: false })
  expect(r.headers.get('content-encoding')).toBe('gzip')
  expect(Buffer.from(await r.arrayBuffer()).equals(Buffer.from(fx.gzip, 'base64'))).toBe(true)
  const d = await safeFetch(`${base}/deflate`, { decompress: false })
  expect(Buffer.from(await d.arrayBuffer()).equals(Buffer.from(fx.deflate, 'base64'))).toBe(true)
})

// --- what is refused, and that nothing turns native decoding back on ---

test('Brotli is refused in any spelling or list, naming the CVE and the origin only', async () => {
  for (const path of ['/br', '/br-invalid', '/br-upper', '/gzip-br']) {
    const e = await refusal(() => safeFetch(`${base}${path}`))
    expect(e.brotli).toBe(true)
    expect(e.code).toBe('ERR_CONTENT_ENCODING_REFUSED')
    expect(e.message).toContain(CVE)
    expect(e.message).toContain(base)
    expect(e.message).not.toContain(path)
  }
})

test('a coding this client does not decode, or a list of codings, is refused undecoded', async () => {
  for (const path of ['/zstd', '/compress', '/identity-gzip']) {
    const e = await refusal(() => safeFetch(`${base}${path}`))
    expect(e.brotli).toBe(false)
    expect(e.message).toMatch(/does not decode/)
  }
})

test('neither the caller nor its Request can turn the runtime\'s decoding back on, and the raw option still refuses Brotli', async () => {
  // fetch's own decoding of these bytes would fail as a BrotliDecompressionError TypeError: a refusal means it never ran
  await refusal(() => safeFetch(`${base}/br-invalid`, { decompress: true }))
  await refusal(() => safeFetch(new Request(`${base}/br-invalid`, { decompress: true } as RequestInit)))
  await refusal(() => safeFetch(new Request(`${base}/br-invalid`), { decompress: true }))
  const raw = await refusal(() => safeFetch(`${base}/br-invalid`, { decompress: false }))
  expect(raw.brotli).toBe(true)
})

test('a redirect whose own body is Brotli: refused when the caller reads redirects itself, never decoded when fetch follows', async () => {
  await refusal(() => safeFetch(`${base}/redirect-br-body`, { redirect: 'manual' }))
  const followed = await safeFetch(`${base}/redirect-br-body`)
  expect(followed.redirected).toBe(true)
  expect(await followed.text()).toBe(fx.plain)
})

test('a refused body is let go at once: the peer holding it open sees the client leave, and the refusal is not delayed', async () => {
  const started = Date.now()
  await refusal(() => safeFetch(`${base}/br-held`))
  expect(Date.now() - started).toBeLessThan(3000)
  expect(await released('/br-held')).toEqual(expect.arrayContaining([expect.stringMatching(/^\/br-held /)]))
})

test('HEAD and 204 carry no body: they are handed on whatever their Content-Encoding says', async () => {
  const head = await safeFetch(`${base}/br`, { method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(head.headers.get('content-encoding')).toBe('br')
  const headRequest = await safeFetch(new Request(`${base}/br`, { method: 'HEAD' }))
  expect(headRequest.status).toBe(200)
  const none = await safeFetch(`${base}/nocontent`)
  expect(none.status).toBe(204)
})

// --- the request as the caller made it ---

test('the request asks for gzip and deflate only, whatever the caller asked; a Request keeps its headers unless init gives others', async () => {
  const plain = await (await safeFetch(`${base}/headers`)).json() as Record<string, string>
  expect(plain['accept-encoding']).toBe(ACCEPT_ENCODING)
  const asked = await (await safeFetch(`${base}/headers`, { headers: { 'accept-encoding': 'br, zstd', 'x-mine': 'kept' } })).json() as Record<string, string>
  expect(asked['accept-encoding']).toBe(ACCEPT_ENCODING)
  expect(asked['x-mine']).toBe('kept')
  const request = new Request(`${base}/headers`, { headers: { 'x-from-request': 'r' } })
  const fromRequest = await (await safeFetch(request)).json() as Record<string, string>
  expect(fromRequest['x-from-request']).toBe('r')
  expect(fromRequest['accept-encoding']).toBe(ACCEPT_ENCODING)
  const replaced = await (await safeFetch(new Request(`${base}/headers`, { headers: { 'x-from-request': 'r' } }), { headers: { 'x-from-init': 'i' } })).json() as Record<string, string>
  expect(replaced['x-from-request']).toBeUndefined()
  expect(replaced['x-from-init']).toBe('i')
})

test('a decoded response says where it landed and that it was redirected, and so does its clone', async () => {
  const r = await safeFetch(`${base}/redirect-gzip`)
  expect(r.url).toBe(`${base}/gzip`)
  expect(r.redirected).toBe(true)
  const copy = r.clone()
  expect(copy.url).toBe(`${base}/gzip`)
  expect(copy.redirected).toBe(true)
  expect(await copy.text()).toBe(fx.plain)
  expect(await r.text()).toBe(fx.plain)
})

// --- ending a decoded body: every way lets the raw body go ---

test('a malformed gzip or deflate body the server keeps open: the read fails and the server sees the client let it go', async () => {
  for (const path of ['/gzip-malformed-held', '/deflate-malformed-held']) {
    const r = await safeFetch(`${base}${path}`)
    await expect(r.text()).rejects.toThrow()
    expect(await released(path), path).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^${path} `))]))
  }
}, 15000)

test('a cancel while the inflater waits for its second byte ends the read and the server sees the client let go', async () => {
  const r = await safeFetch(`${base}/gzip-silent-held`)
  const reader = r.body!.getReader()
  const pending = reader.read()
  await Bun.sleep(100)
  await reader.cancel('enough')
  expect((await pending).done).toBe(true)
  expect(await released('/gzip-silent-held')).toEqual(expect.arrayContaining([expect.stringMatching(/^\/gzip-silent-held /)]))
}, 15000)

test('a cancel during inflation lets the raw body go; an abort during it fails the read', async () => {
  const r = await safeFetch(`${base}/gzip-partial-held`)
  const reader = r.body!.getReader()
  const first = await reader.read()
  expect(first.done).toBe(false)
  expect(new TextDecoder().decode(first.value).startsWith('synthetic plaintext')).toBe(true)
  await reader.cancel('enough')
  expect(await released('/gzip-partial-held')).toEqual(expect.arrayContaining([expect.stringMatching(/^\/gzip-partial-held /)]))
  const stop = new AbortController()
  const aborted = await safeFetch(`${base}/gzip-partial-held`, { signal: stop.signal })
  const r2 = aborted.body!.getReader()
  await r2.read()
  const next = r2.read()
  stop.abort()
  await expect(next).rejects.toThrow()
}, 15000)

/** A raw body under the test's own control: what it was asked, and whether it was cancelled. */
function controlled(chunks: Uint8Array[], keepOpen: boolean) {
  const seen = { cancelled: false, reason: undefined as unknown, pulls: 0 }
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      seen.pulls += 1
      if (sent < chunks.length) { controller.enqueue(chunks[sent++]!); return }
      if (!keepOpen) { controller.close(); return }
      return new Promise<void>(() => {})
    },
    cancel(reason) { seen.cancelled = true; seen.reason = reason },
  }, { highWaterMark: 0 })
  return { stream, seen }
}

test('inflating: bytes the inflater refuses, from a source kept open, fail the read and cancel the source', async () => {
  const { stream, seen } = controlled([new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3, 0xff, 0xff, 0xff, 0xff])], true)
  await expect(new Response(inflating(stream, 'gzip')).text()).rejects.toThrow()
  for (let i = 0; i < 50 && !seen.cancelled; i++) await Bun.sleep(10)
  expect(seen.cancelled).toBe(true)
})

test('inflating: a cancel while it waits for the first bytes cancels the source and makes no inflater', async () => {
  const { stream, seen } = controlled([], true)
  const decoded = inflating(stream, 'deflate').getReader()
  const pending = decoded.read()
  await Bun.sleep(20)
  await decoded.cancel('stop')
  expect((await pending).done).toBe(true)
  expect(seen.cancelled).toBe(true)
})

test('inflating: a cancel mid-stream cancels the source; a whole stream split byte by byte decodes; one byte of deflate is an error', async () => {
  const gz = gzipSync(Buffer.from('abc'.repeat(2000)))
  const mid = controlled([gz.subarray(0, 200)], true)
  const reader = inflating(mid.stream, 'gzip').getReader()
  expect((await reader.read()).done).toBe(false)
  await reader.cancel('stop')
  expect(mid.seen.cancelled).toBe(true)
  const bytewise = controlled([...gz].map((b) => new Uint8Array([b])), false)
  expect(await new Response(inflating(bytewise.stream, 'gzip')).text()).toBe('abc'.repeat(2000))
  const one = controlled([new Uint8Array([0x78])], false)
  await expect(new Response(inflating(one.stream, 'deflate')).text()).rejects.toThrow()
})

// --- the process-level check ---

function child(mode: 'safe' | 'native-control') {
  const run = Bun.spawnSync([process.execPath, '--preload', './tests/preload.ts', join(import.meta.dir, 'safe_fetch_client_child.ts'), mode, base], { cwd: join(import.meta.dir, '..'), timeout: 60_000 })
  return { stdout: run.stdout.toString(), stderr: run.stderr.toString(), exitCode: run.exitCode }
}

test('process level: the native decoder\'s own error report, present for plain fetch, is absent for safeFetch and representative product paths', () => {
  const control = child('native-control')
  expect(control.exitCode, control.stderr).toBe(0)
  // the positive control: the same invalid bytes through fetch's own decoding — the native side reports its decoder
  expect(control.stderr).toMatch(/Decompression error: BrotliDecompressionError/)
  expect(JSON.parse(control.stdout).native_br_invalid).toMatchObject({ ok: false, code: 'BrotliDecompressionError' })

  const safe = child('safe')
  expect(safe.exitCode, safe.stderr).toBe(0)
  expect(safe.stderr).not.toMatch(/Decompression error|BrotliDecompressionError/)
  // what it does write instead: the refusals, said (origin only)
  expect(safe.stderr).toContain(`ContentEncodingRefused: ${CVE}: a Brotli-encoded response from ${base} was refused undecoded`)
  const out = JSON.parse(safe.stdout) as Record<string, Record<string, unknown>>
  for (const name of ['br_invalid', 'br_valid', 'br_upper', 'gzip_br', 'redirect_br_body_manual', 'caller_decompress_true', 'request_decompress_true', 'raw_option_br', 'br_held_open', 'pinned_fetch', 'post_json']) {
    expect(out[name], name).toMatchObject({ ok: false, name: 'ContentEncodingRefused', brotli: true })
  }
  // Bun followed the redirect itself (its Brotli body not decoded) and the page it landed on is gzip
  expect(out.redirect_br_body_follow).toMatchObject({ ok: true, status: 200 })
}, 120_000)

// --- the product's own doors ---

test('a provider route with no injected fetch: gzip JSON and gzip SSE are read; Brotli is refused as it is, once, not retried', async () => {
  const json = await (await postJson(`${base}/json-gzip`, {}, {}, 'fixture-model')).json() as { ok: boolean }
  expect(json.ok).toBe(true)
  const events: string[] = []
  for await (const m of readSse(await postJson(`${base}/sse-gzip`, {}, {}, 'fixture-model'), 'fixture-model')) events.push(m.data)
  expect(events).toEqual(['{"n":1}', '{"n":2}'])
  const before = await hitsOf('/br-invalid')
  await refusal(() => postJson(`${base}/br-invalid`, {}, {}, 'fixture-model', { maxRetries: 2 }))
  expect(await hitsOf('/br-invalid')).toBe(before + 1)
})

let lastProjectId = ''
async function fetchUrlTool(url: string): Promise<Record<string, unknown>> {
  state = await appState()
  const { session, project } = await openSession(state, buggyRepo())
  lastProjectId = project.id
  let output: Record<string, unknown> = {}
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    const ret = lastToolReturn(messages, 'fetch_url')
    if (!ret) return modelResponse([toolCallPart('fetch_url', { url }, '')])
    output = ret as Record<string, unknown>
    return modelResponse([textPart('done')])
  }))
  await waitDone(state, (await state.runs.start(session, 'read a synthetic page')).id)
  return output
}

/** fetch_url's real transport (pinnedFetch → safeFetch) on the loopback fixture: the public name resolves to a public
 *  address and passes the checks; the hop is then pinned to 127.0.0.1 at the fixture's port, the name kept in the Host
 *  header and in the response's url (as pinnedFetch does for the address it was checked at). */
function viaFixture(path: string, iconPath: string | null = null): void {
  web.setWebHooks({
    resolve: async () => ['93.184.216.34'],
    fetchImpl: (input, init) => {
      const asked = new URL(String(input))
      if (asked.pathname === '/favicon.ico' && iconPath === null) return Promise.resolve(new Response('', { status: 404 }))
      return web.pinnedFetch(`http://${asked.hostname}:${fx.port}${asked.pathname === '/favicon.ico' ? iconPath : path}`, { ...init, address: '127.0.0.1' })
    },
  })
}

test('a Brotli site icon: the page reads as before, no icon is kept, and the refusal is said once on stderr (origin only)', async () => {
  const warned: string[] = []
  const spy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(' ')) })
  try {
    viaFixture('/gzip', '/br-invalid')
    const read = await fetchUrlTool('http://qa-public.example.test/page')
    expect(read.status).toBe('ok')
    expect(String(read.text)).toContain('synthetic plaintext for the Content-Encoding fixture')
    expect(repo.listAssetsWithRole(state!.conn, lastProjectId, 'image', web.SITE_ICON_ROLE)).toEqual([])
    const refusals = warned.filter((w) => w.includes('ContentEncodingRefused'))
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toContain(CVE)
    // pinnedFetch connects to the address the name was checked at, and safeFetch screens that connection: the origin
    // named is the checked address's (here the fixture's loopback stand-in), never a path
    expect(refusals[0]).toContain(`http://127.0.0.1:${fx.port}`)
    for (const leak of ['/favicon.ico', '/br-invalid', '/page', 'user-agent', 'synthetic plaintext']) expect(refusals[0]).not.toContain(leak)
  } finally { spy.mockRestore() }
}, 60_000)

test('a refusal of an unknown coding is not a Brotli warning; a Brotli refusal warns once per response', async () => {
  const warned: string[] = []
  const spy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(' ')) })
  try {
    await refusal(() => safeFetch(`${base}/zstd`))
    expect(warned).toEqual([])
    await refusal(() => safeFetch(`${base}/br`))
    expect(warned).toEqual([`ContentEncodingRefused: ${CVE}: a Brotli-encoded response from ${base} was refused undecoded`])
  } finally { spy.mockRestore() }
})

test('fetch_url: a Brotli page is refused, said so (CVE named), and nothing is saved; a gzip page reads as before', async () => {
  viaFixture('/br-invalid')
  const refused = await fetchUrlTool('http://qa-public.example.test/page')
  expect(refused.status).toBe('refused')
  expect(String(refused.reason)).toContain('Content-Encoding: br')
  expect(String(refused.reason)).toContain(CVE)
  expect(refused.source_id).toBeUndefined()
  if (state) await closeState(state)
  state = null
  viaFixture('/gzip')
  const read = await fetchUrlTool('http://qa-public.example.test/page')
  expect(read.status).toBe('ok')
  expect(String(read.text)).toContain('synthetic plaintext for the Content-Encoding fixture')
}, 60_000)

// --- the rule, kept (a syntactic regression guard, not a proof) ---

/** Where a source uses the global `fetch` as a value — called, passed, assigned, or read as globalThis / self / window
 *  .fetch — as `line: text`. Parsed with TypeScript, so comments, strings, templates and regex literals are never
 *  read as code; a `fetch` that is a property or method name (`app.fetch`, a server's `fetch(req) {}` handler, a
 *  `fetch:` key) or a type (`typeof fetch`) is not a use. It does not follow aliases (`const f = globalThis; f.fetch`)
 *  or computed access (`globalThis['fetch']`): a guard for the habits this code base has, not a proof. */
function nativeFetchUses(source: string): string[] {
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true)
  const uses: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'fetch') {
      const parent = node.parent
      let use = true
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) use = ts.isIdentifier(parent.expression) && ['globalThis', 'self', 'window'].includes(parent.expression.text)
      else if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) use = false
      else if (ts.isTypeQueryNode(parent) || ts.isQualifiedName(parent)) use = false
      // a parameter or a local of that name declares its own `fetch` (a server handler, a callback): not the global
      else if ((ts.isParameter(parent) || ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === node) use = false
      if (use) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line
        uses.push(`${line + 1}: ${source.split('\n')[line]!.trim()}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return uses
}

test('the guard sees a call, a value, a shorthand and globalThis.fetch, and not a handler, a key, a type, a comment, a string or a regex', () => {
  for (const flagged of ['await fetch(url)', 'const f = opts.fetchImpl ?? fetch', 'refreshWith(fetch, token)', 'globalThis.fetch(u)', 'x = fetch', 'const deps = { fetch }']) expect(nativeFetchUses(flagged), flagged).toHaveLength(1)
  for (const clean of ['const o = { fetch(request: Request) { return request } }', 'class A { async fetch(req: Request) { return req } }', 'Bun.serve({ fetch: app.fetch })', '// fetch(url)', "throw new Error('no icon to fetch')",
    'let t: typeof fetch = safeFetch', 'await safeFetch(url)', '/* fetch(u) */', 'const s = `await fetch(${u})`', 'const r = /failed to fetch|fetch(/i']) expect(nativeFetchUses(clean), clean).toEqual([])
})

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })
}

test('no product source uses the global fetch as a value but safe_fetch.ts', () => {
  const src = join(import.meta.dir, '..', 'src')
  const offenders = sources(src).filter((p) => p !== join(src, 'safe_fetch.ts')).flatMap((p) => nativeFetchUses(readFileSync(p, 'utf8')).map((use) => `${p.slice(src.length + 1)}:${use}`))
  expect(offenders).toEqual([])
  // and safe_fetch.ts itself turns the runtime's decoding off in fetch's own second argument, last
  const own = readFileSync(join(src, 'safe_fetch.ts'), 'utf8')
  expect(own).not.toMatch(/\bglobalThis\.fetch\s*=/)
  expect(own).toMatch(/await transport\(input, \{ \.\.\.rest, headers, decompress: false \}/)
  expect(own).toMatch(/fetchThrough\(\(i, o\) => globalThis\.fetch\(i, o\), input, init\)/)
})

/** The dev and QA scripts' uses of the global fetch that stay, each with why (docs/brotli-cve-2026-111497.md). A new
 *  one fails the test below until it goes through safeFetch / safeFetchVia or is added here with its reason. */
const SCRIPT_USES: { file: string; line: string; why: string }[] = [
  { file: 'argon_probe.ts', line: 'const original = globalThis.fetch', why: 'withGlobalFetch saves the global to put it back' },
  { file: 'argon_probe.ts', line: 'globalThis.fetch = Object.assign(replacement', why: 'withGlobalFetch installs the budget (or the dry run\'s refusal) in the global\'s place' },
  { file: 'argon_probe.ts', line: 'finally { globalThis.fetch = original }', why: 'withGlobalFetch puts the global back' },
  { file: 'argon_probe.ts', line: 'safeFetchVia(globalThis.fetch.bind(globalThis))', why: 'the live and idle-client transports: Bun\'s fetch captured for safeFetchVia' },
  { file: 'perf_storage/guard_preload.ts', line: 'globalThis.fetch = (() =>', why: 'the benchmark guard replaces the global with a refusal: no network at all' },
  { file: 'persistent_ui_e2e_server.ts', line: 'await fetch(`http://127.0.0.1:${port}', why: 'test-only e2e server: proxies the browser to its own backend on the loopback' },
  { file: 'e2e_server.ts', line: 'Bun.serve({ hostname: \'127.0.0.1\', port, fetch,', why: 'a server handler named fetch, given to Bun.serve (a listener, not a client)' },
]

test('the scripts reach the global fetch only where the list says why', () => {
  const scripts = join(import.meta.dir, '..', 'scripts')
  const unexplained = sources(scripts).flatMap((p) => nativeFetchUses(readFileSync(p, 'utf8')).map((use) => ({ file: p.slice(scripts.length + 1), use })))
    .filter(({ file, use }) => !SCRIPT_USES.some((u) => u.file === file && use.includes(u.line)))
    .map(({ file, use }) => `${file}:${use}`)
  expect(unexplained).toEqual([])
})
