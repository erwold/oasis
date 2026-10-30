import { expect, test } from 'bun:test'
import { deepseekSearch, type SearchDependencies } from '../src/search/deepseek.ts'
const result = { title: 'Title', url: 'https://example.com/a', snippet: 'short', summary: 'long summary', date: null }
function fixture(responses: Response[]) {
  const requests: RequestInit[] = [], waits: number[] = []
  const deps: SearchDependencies = { key: () => 'synthetic-placeholder', sleep: async (ms) => { waits.push(ms) }, fetch: async (url, init) => {
    expect(url).toBe('https://api.deepseek.com/v1/tools/search'); requests.push(init)
    const response = responses.shift(); if (!response) throw new Error('unexpected request'); return response
  } }
  return { deps, requests, waits }
}
const signal = () => new AbortController().signal

test('uses independent endpoint, Unicode query intact, common results, both list-price estimates', async () => {
  const f = fixture([Response.json({ results: [result] })])
  const q = '😀'.repeat(128)
  const out = await deepseekSearch(q, 8, signal(), f.deps)
  expect(out.status).toBe('ok'); expect(out.results).toEqual([result])
  expect(out.usage).toEqual({ successful_requests: 1, estimated_cost_usd: 0.00075, estimated_cost_cny: 0.005 })
  expect(JSON.parse(f.requests[0]!.body as string)).toEqual({ query: q, count: 8, need_content: false })
  expect(f.requests[0]!.redirect).toBe('error')
  expect(JSON.stringify(out)).not.toContain('synthetic-placeholder')
})
test('rejects oversized and blank queries without truncation or calls; rejects count outside harness range', async () => {
  const f = fixture([])
  for (const q of ['😀'.repeat(129), '  ']) expect((await deepseekSearch(q, 8, signal(), f.deps)).status).toBe('error')
  for (const count of [0, 21, 1.5, NaN]) expect((await deepseekSearch('q', count, signal(), f.deps)).status).toBe('error')
  expect(f.requests).toHaveLength(0)
})
test('no key, empty results, malformed results and private credentials never cause fallback', async () => {
  const f = fixture([Response.json({ results: [] }), Response.json({ wrong: [] }), Response.json({ results: [{ ...result, url: 'https://secret@example.com' }] })])
  const empty = await deepseekSearch('q', 8, signal(), f.deps)
  expect(empty.status).toBe('no_results'); expect(empty.usage?.estimated_cost_usd).toBe(0)
  expect((await deepseekSearch('q', 8, signal(), f.deps)).status).toBe('error')
  expect((await deepseekSearch('q', 8, signal(), f.deps)).status).toBe('error')
  expect((await deepseekSearch('q', 8, signal(), { ...f.deps, key: () => null })).error).toContain('Settings')
  expect(f.requests).toHaveLength(3)
})
test('408,429,5xx wait and retry; other 4xx do not; upstream error text is never returned', async () => {
  for (const status of [408, 429, 500, 504, 400, 401, 402, 403, 413]) {
    const f = fixture([new Response('synthetic-secret-echo', { status, headers: { 'retry-after': '2' } }), Response.json({ results: [result] })])
    const out = await deepseekSearch('q', 8, signal(), f.deps)
    const retry = [408, 429, 500, 504].includes(status)
    expect(f.requests.length).toBe(retry ? 2 : 1)
    expect(out.status).toBe(retry ? 'ok' : 'error')
    if (retry) expect(f.waits).toContain(2000)
    expect(JSON.stringify(out)).not.toContain('synthetic-secret-echo')
  }
})
test('retry budget is bounded and failures have no billed estimate', async () => {
  const f = fixture(Array.from({ length: 3 }, () => new Response('', { status: 429 })))
  const out = await deepseekSearch('q', 8, signal(), f.deps)
  expect(f.requests).toHaveLength(3); expect(out.status).toBe('error'); expect(out.usage).toBeUndefined()
})
test('cancel before dispatch and during retry; transport errors are sanitized', async () => {
  const stop = new AbortController(); stop.abort()
  const f = fixture([])
  expect((await deepseekSearch('q', 8, stop.signal, f.deps)).status).toBe('cancelled'); expect(f.requests).toHaveLength(0)
  const active = new AbortController()
  const out = await deepseekSearch('q', 8, active.signal, { ...f.deps, sleep: async () => {}, fetch: async () => { active.abort(); throw new Error('secret') } })
  expect(out.status).toBe('cancelled'); expect(JSON.stringify(out)).not.toContain('secret')
  const failed = await deepseekSearch('q', 8, signal(), { ...f.deps, fetch: async () => { throw new Error('credential echo') } })
  expect(JSON.stringify(failed)).not.toContain('credential echo')
})
