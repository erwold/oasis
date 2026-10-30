import { expect, test } from 'bun:test'
import { runSearchProbe } from '../scripts/deepseek_search_probe.ts'

test('Search dry-run passes through network gate before credential lookup or fetch', async () => {
  let keys = 0, requests = 0
  const result = await runSearchProbe(false, { key: () => { keys++; throw new Error('no key access') }, fetch: async () => { requests++; throw new Error('no network') } })
  expect(result).toMatchObject({ live: false, ok: true, status: 'refused_by_policy' })
  expect(keys).toBe(0); expect(requests).toBe(0)
})
test('Search live branch mocked: one attempt, safe diagnostics, no upstream body or retry', async () => {
  let requests = 0
  const result = await runSearchProbe(true, { key: () => 'synthetic-probe-key', sleep: async () => {}, fetch: async () => {
    requests++; return new Response('upstream synthetic-probe-key', { status: 429 })
  } })
  expect(requests).toBe(1)
  expect(result).toMatchObject({ ok: false, status: 'error', http_statuses: [429] })
  expect(JSON.stringify(result)).not.toContain('synthetic-probe-key')
})
test('Search live branch mocked: safe official URLs and independent usage only', async () => {
  const result = await runSearchProbe(true, { key: () => 'synthetic-probe-key', sleep: async () => {}, fetch: async () => Response.json({ results: [
    { title: 'not printed', snippet: 'not printed', summary: 'not printed', url: 'https://api-docs.deepseek.com/guides/search/?private=not-printed#fragment' },
    { title: 'not printed', snippet: 'not printed', summary: 'not printed', url: 'https://example.com/not-printed' },
  ] }) })
  expect(result.urls).toEqual(['https://api-docs.deepseek.com/guides/search/'])
  expect(result.result_count).toBe(2)
  expect(result.usage?.estimated_cost_cny).toBe(.005)
  expect(JSON.stringify(result)).not.toMatch(/not.printed|synthetic-probe-key/)
})
