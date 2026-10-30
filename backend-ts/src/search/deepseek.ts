/** DeepSeek's independent Search API, not a model tool or an HTML scrape. */
import { keyForEnv } from '../auth/keys.ts'
import { ContentEncodingRefused, safeFetch } from '../safe_fetch.ts'

export interface SearchResult { title: string; url: string; snippet: string; summary?: string; date?: string | null }
export interface SearchReply {
  status: 'ok' | 'no_results' | 'error' | 'cancelled'
  query: string
  engine: 'deepseek'
  source: 'web'
  results: SearchResult[]
  attempts: { engine: string; http_status?: number; results: number; error?: string }[]
  error?: string
  /** Published list-price estimate, not a bill or a currency conversion. */
  usage?: { successful_requests: number; estimated_cost_usd: number; estimated_cost_cny: number }
}
export interface SearchDependencies {
  fetch: (input: string, init: RequestInit) => Promise<Response>
  key: () => string | null
  maxAttempts?: 1 | 2 | 3
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}
const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  signal.throwIfAborted()
  const abort = () => { clearTimeout(timer); reject(signal.reason) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
  signal.addEventListener('abort', abort, { once: true })
})
const defaults: SearchDependencies = { fetch: (...args) => safeFetch(...args), key: () => keyForEnv('DEEPSEEK_API_KEY')[0], sleep }
// Spread calls made by this process; the account-wide limit may still yield 429 (other clients/keys).
let nextStart = 0
export async function deepseekSearch(query: string, count: number, cancel: AbortSignal, injected: Partial<SearchDependencies> = {}): Promise<SearchReply> {
  const deps = { ...defaults, ...injected }
  const reply: SearchReply = { status: 'error', query, engine: 'deepseek', source: 'web', results: [], attempts: [] }
  const fail = (error: string) => ({ ...reply, error })
  if (!query.trim() || [...query].length > 128) return fail('DeepSeek Search requires 1–128 Unicode characters; shorten the query and retry')
  if (!Number.isInteger(count) || count < 1 || count > 20) return fail('max_results must be an integer from 1 to 20')
  if (cancel.aborted) return { ...reply, status: 'cancelled', error: 'Search cancelled' }
  const key = deps.key()
  if (!key) return fail('Save a DeepSeek API key in Settings before using DeepSeek Search')
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(30_000)])
  try {
    for (let attempt = 0; attempt < (deps.maxAttempts ?? 3); attempt++) {
      const now = Date.now()
      const start = Math.max(now, nextStart)
      nextStart = start + 210
      if (start > now) await deps.sleep(start - now, signal)
      signal.throwIfAborted()
      const response = await deps.fetch('https://api.deepseek.com/v1/tools/search', {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, count, need_content: false }),
      })
      if (response.status !== 200) {
        // Never return/log upstream text: it may echo credentials or request headers.
        reply.attempts.push({ engine: 'deepseek', http_status: response.status, results: 0 })
        await response.body?.cancel()
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500
        if (!retryable || attempt === (deps.maxAttempts ?? 3) - 1) return fail(`DeepSeek Search returned HTTP ${response.status}`)
        const retryAfter = response.headers.get('retry-after')
        const seconds = retryAfter ? Number(retryAfter) : NaN
        const requested = Number.isFinite(seconds) ? seconds * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : 0
        await deps.sleep(Math.min(30_000, Math.max(500 * 2 ** attempt, requested || 0)), signal)
        continue
      }
      // Bound the response as well as its lifetime; do not ingest arbitrarily large upstream bodies.
      const reader = response.body?.getReader()
      if (!reader) return fail('DeepSeek Search returned an invalid response')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          signal.throwIfAborted()
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 4 * 1024 * 1024) { await reader.cancel(); return fail('DeepSeek Search response exceeded the size limit') }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!body || typeof body !== 'object' || !('results' in body) || !Array.isArray(body.results)) return fail('DeepSeek Search returned an invalid response')
      const results: SearchResult[] = []
      for (const row of body.results.slice(0, count)) {
        if (!row || typeof row.title !== 'string' || typeof row.url !== 'string' || typeof row.snippet !== 'string' || typeof row.summary !== 'string') return fail('DeepSeek Search returned an invalid result')
        let url: URL
        try { url = new URL(row.url) } catch { return fail('DeepSeek Search returned an invalid result URL') }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return fail('DeepSeek Search returned an invalid result URL')
        results.push({ title: row.title, url: row.url, snippet: row.snippet, summary: row.summary || row.snippet, date: typeof row.date === 'string' ? row.date : null })
      }
      reply.attempts.push({ engine: 'deepseek', http_status: 200, results: results.length })
      return { ...reply, status: results.length ? 'ok' : 'no_results', results,
        usage: { successful_requests: results.length ? 1 : 0, estimated_cost_usd: results.length ? 0.00075 : 0, estimated_cost_cny: results.length ? 0.005 : 0 } }
    }
  } catch (error) {
    if (cancel.aborted) return { ...reply, status: 'cancelled', error: 'Search cancelled' }
    if (error instanceof ContentEncodingRefused) return fail(error.message)
    return fail(signal.aborted ? 'DeepSeek Search timed out' : 'DeepSeek Search failed; check the connection and retry')
  }
  return fail('DeepSeek Search failed')
}
