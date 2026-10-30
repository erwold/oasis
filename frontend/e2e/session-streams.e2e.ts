/** 24 agents at work in one session, in real Chrome over HTTP/1.1 (a stand-in backend, session-streams-stub.ts: no
 *  model, no data directory). A browser keeps at most six connections per host over HTTP/1.1: a page that held an
 *  event stream per run had none left for its own requests — a diff, a card's transcript, a message sent waited for
 *  ever. The page now holds one stream for the session; this checks it at the server (the streams and sockets it
 *  holds), in the page (every agent's words arrive) and by the page's own requests, each of which must complete.
 *
 *  OASIS_CODE_E2E_DIST names another built UI to serve (the same test against an older build); OASIS_CODE_E2E_BROWSER
 *  another Chromium executable. */

import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { AGENTS, agentRun, startStub, STUB_SESSION, type Stub } from './session-streams-stub.ts'

const PORT = 8399
const BASE = `http://127.0.0.1:${PORT}`
const DIST = realpathSync(resolve(process.env.OASIS_CODE_E2E_DIST ?? join(process.cwd(), 'dist')))
const WAIT_MS = 8_000

let stub: Stub
let browser: Browser
let context: BrowserContext
let page: Page
let profile: string

before(async () => {
  stub = await startStub(PORT, DIST)
  profile = mkdtempSync(join(tmpdir(), 'oasis-e2e-streams-'))
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  browser = await chromium.launch(executablePath ? { executablePath, headless: true, args: ['--no-sandbox'] } : { channel: 'chrome', headless: true })
  context = await browser.newContext()
  page = await context.newPage()
  page.on('pageerror', (e) => console.log(`page error: ${e.message}`))
})

after(async () => {
  await browser?.close()
  await stub?.close()
  if (profile) rmSync(profile, { recursive: true, force: true })
})

/** A request of the page's own, as its code makes them (fetch, same origin): its status, or 'timeout'. */
async function pageRequest(path: string, init: RequestInit = {}): Promise<{ status: number | 'timeout'; ms: number }> {
  return page.evaluate(async ({ path, init, wait }) => {
    const started = performance.now()
    const status = await Promise.race([
      fetch(path, init).then((r) => r.status),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), wait)),
    ])
    return { status, ms: Math.round(performance.now() - started) }
  }, { path, init: init as Record<string, unknown>, wait: WAIT_MS })
}

test(`${AGENTS} live agents: one event stream, every agent heard, and the page's own requests go through`, async () => {
  await page.goto(`${BASE}/?token=stub`)
  await page.click(`[data-testid="session-${STUB_SESSION}"]`)
  // the streams settle (the old page asks for one per run at once; the browser opens six)
  await page.waitForTimeout(2_500)
  const counts = { ...stub.counts, requests: stub.counts.requests.length }
  console.log(`streams open ${counts.streamsOpen} (peak ${counts.streamsPeak}); sockets open ${counts.socketsOpen} (peak ${counts.socketsPeak}); stream paths ${JSON.stringify([...new Set(counts.streamPaths)].slice(0, 4))}…`)

  // the page's own requests while every agent talks: a card's transcript, a diff, the run itself, a message sent
  const results: Record<string, { status: number | 'timeout'; ms: number }> = {}
  results.transcript = await pageRequest(`/api/runs/${agentRun(23)}/transcript`)
  results.diff = await pageRequest(`/api/runs/${agentRun(5)}/diff`)
  results.run = await pageRequest(`/api/runs/${agentRun(17)}`)
  results.message = await pageRequest(`/api/sessions/${STUB_SESSION}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'one more thing' }) })
  console.log(`page requests: ${JSON.stringify(results)}`)

  assert.equal(counts.streamsOpen, 1, `event streams the page holds for ${AGENTS} agents: ${counts.streamsOpen}`)
  assert.deepEqual([...new Set(counts.streamPaths.map((p) => p.split('?')[0]))], [`/api/sessions/${STUB_SESSION}/events`])
  for (const [name, r] of Object.entries(results)) assert.equal(r.status, 200, `${name}: ${r.status} after ${r.ms} ms`)

  // in the page: the last agent's words arrive (on a stream per run, the 7th agent on was never connected)
  await page.waitForFunction((needle) => document.body.innerText.includes(needle), 'agent-23 says', { timeout: WAIT_MS })
  await page.waitForFunction((needle) => document.body.innerText.includes(needle), 'agent-00 says', { timeout: WAIT_MS })

  // the composer: a message sent the way the person sends one (to a run at work: its steer) reaches the backend while
  // the agents talk
  const sent = () => stub.counts.requests.filter((r) => r.method === 'POST' && (r.path.endsWith('/chat') || r.path.endsWith('/steer'))).length
  const before = sent()
  await page.fill('[data-testid="composer"]', 'and a message from the composer')
  await page.click('[data-testid="send"]')
  const deadline = Date.now() + WAIT_MS
  while (sent() === before && Date.now() < deadline) await page.waitForTimeout(100)
  assert.equal(sent(), before + 1, 'the composer\'s message reached the backend')
  assert.ok(stub.counts.socketsPeak <= 6, `sockets at once: ${stub.counts.socketsPeak}`)
  assert.equal(stub.counts.streamsOpen, 1)
})
