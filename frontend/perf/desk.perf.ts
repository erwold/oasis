import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { build } from 'vite'
import { benchData, type BenchData } from './fixtures.ts'

/** The desk (the right-hand cards and the Agent Teams outline) in a real browser on a session of 100 and of 300
 *  agents: the bench page (perf/bench.tsx) built into a temporary folder, served from the page's own routes (no port,
 *  no backend: the API is answered here and every request counted), Chrome headless on a profile of its own in that
 *  folder. Run: `node --test perf/desk.perf.ts` (in frontend); `OASIS_CODE_E2E_BROWSER` names a browser other than
 *  the installed Chrome. `BENCH_OUT` names a file the measures are written to (JSON). */

const here = dirname(fileURLToPath(import.meta.url))
const ORIGIN = 'http://desk-bench.invalid'
const SIZES = [100, 300]
const LIVE = 3
const ENTRIES = 30
const STREAM_EVENTS = 100
const TREE_RELOADS = 20
const CLOCK_TICKS = 3

let dir = ''
let browser: Browser
const measures: Record<string, unknown> = {}

before(async () => {
  dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'desk-bench-'))
  await build({ configFile: join(here, 'vite.perf.config.ts'), build: { outDir: join(dir, 'dist') } })
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { channel: 'chrome', headless: true })
})

after(async () => {
  await browser?.close()
  if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, JSON.stringify(measures, null, 2))
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }

interface Requests { transcript: string[]; tree: number; events: string[]; runDetail: number; other: string[] }

async function openBench(data: BenchData): Promise<{ page: Page; requests: Requests; lastAnswer: () => number; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors: string[] = []
  const requests: Requests = { transcript: [], tree: 0, events: [], runDetail: 0, other: [] }
  let last = 0
  page.on('pageerror', (e) => { errors.push(String(e)) })
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (!path.startsWith('/api/')) {
      const file = join(dir, 'dist', path === '/' ? 'bench.html' : path)
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' })
      return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
    }
    const transcript = /^\/api\/runs\/([^/]+)\/transcript$/.exec(path)
    if (transcript) {
      requests.transcript.push(transcript[1]!)
      last = Date.now()
      const body = data.transcripts[transcript[1]!]
      return route.fulfill({ status: body ? 200 : 404, contentType: 'application/json', body: JSON.stringify(body ?? { detail: 'no run' }) })
    }
    if (/^\/api\/runs\/[^/]+\/events/.test(path)) { requests.events.push(path); return }  // a live stream: left open
    if (/\/runs\/tree$/.test(path)) { requests.tree += 1; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session_id: 'ses_bench', runs: data.tree }) }) }
    if (/^\/api\/runs\/[^/]+$/.test(path)) requests.runDetail += 1
    else requests.other.push(path)
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'not in the bench' }) })
  })
  await page.goto(`${ORIGIN}/bench.html`)
  await page.waitForFunction(() => '__bench' in window)
  return { page, requests, lastAnswer: () => last, errors }
}

type Snapshot = { counts: Record<string, number>; commits: number; renderMs: number; domNodes: number; outlineRows: number; railPaths: number; depEdges: number; cards: number; runViews: number; childThreads: number; childThreadRows: number; heapMB: number }
const snap = (page: Page) => page.evaluate(() => (window as unknown as { __bench: { snapshot(): Snapshot } }).__bench.snapshot())
const reset = (page: Page) => page.evaluate(() => (window as unknown as { __bench: { reset(): void } }).__bench.reset())

/** until no request has come for `quiet` ms (an open stream does not count) */
async function settle(page: Page, requests: Requests, quiet = 800): Promise<void> {
  const count = () => requests.transcript.length + requests.tree + requests.runDetail + requests.other.length
  let seen = -1, since = Date.now()
  for (;;) {
    await page.waitForTimeout(100)
    const now = count()
    if (now !== seen) { seen = now; since = Date.now() }
    else if (Date.now() - since >= quiet) return
  }
}

for (const n of SIZES) {
  test(`a session of ${n} agents: the desk reads only the conversations it shows, and one agent's stream redraws only its own card`, async () => {
    const data = benchData(n, LIVE, ENTRIES)
    const { page, requests, lastAnswer, errors } = await openBench(data)
    const t0 = Date.now()
    await page.evaluate((d) => (window as unknown as { __bench: { open(d: unknown): void } }).__bench.open(d), { session: data.session, tree: data.tree, threadRun: data.threadRun })
    await page.waitForSelector('[data-testid="outline"]')
    await settle(page, requests)
    const open = { ...(await snap(page)), transcriptRequests: requests.transcript.length, eventStreams: requests.events.length, treeReads: requests.tree, runDetails: requests.runDetail,
                   lastTranscriptMs: requests.transcript.length ? lastAnswer() - t0 : 0 }

    // one live agent, its card brought to the front (its conversation drawn), streams: what redraws
    await page.evaluate((id) => (window as unknown as { __bench: { reveal(id: string): void } }).__bench.reveal(id), data.liveIds[0]!)
    await page.waitForSelector(`[data-testid="card-${data.liveIds[0]}"].front [data-testid="agent-view-${data.liveIds[0]}"]`)
    await reset(page)
    await page.evaluate(([id, k]) => (window as unknown as { __bench: { stream(id: string, k: number): Promise<void> } }).__bench.stream(id as string, k as number), [data.liveIds[0]!, STREAM_EVENTS] as const)
    const stream = await snap(page)

    // the tree read again, nothing in it changed
    await reset(page)
    await page.evaluate((k) => (window as unknown as { __bench: { reloadTree(k: number): Promise<void> } }).__bench.reloadTree(k), TREE_RELOADS)
    const reload = await snap(page)

    // three ticks of the page's clocks (three agents live): each second the desk and the outline read the time
    await reset(page)
    const clocks = await page.evaluate((k) => (window as unknown as { __bench: { tick(k: number): Promise<number> } }).__bench.tick(k), CLOCK_TICKS)
    const clock = { ...(await snap(page)), clocks }

    // what must still work: a finished agent picked in the outline comes to the front with its conversation, read
    // then (once); a row folds its children away and back; the dependency lines stand
    await reset(page)
    const picked = data.finishedIds[2]!
    const before = requests.transcript.filter((id) => id === picked).length
    await page.click(`[data-testid="ol-${picked}"]`)
    await page.waitForSelector(`[data-testid="card-${picked}"] [data-testid="card-run-${picked}"] .prose`, { timeout: 10_000 })
    await settle(page, requests, 400)
    const reads = requests.transcript.filter((id) => id === picked).length - before
    const front = await page.evaluate(() => document.querySelector('.desk-win.kind-run.front')?.getAttribute('data-testid'))
    const depEdges = (await snap(page)).depEdges
    await page.click('[data-testid="ol-run_main"] .ol-caret')
    const folded = (await snap(page)).outlineRows
    await page.click('[data-testid="ol-run_main"] .ol-caret')
    const unfolded = (await snap(page)).outlineRows
    await page.close()

    const per = (v: number, k: number) => Math.round((v / k) * 100) / 100
    measures[`n${n}`] = { open, stream, reload, clock, perEvent: { RunView: per(stream.counts.RunView ?? 0, STREAM_EVENTS), FloatingWindow: per(stream.counts.FloatingWindow ?? 0, STREAM_EVENTS), AgentOutline: per(stream.counts.AgentOutline ?? 0, STREAM_EVENTS), commits: per(stream.commits, STREAM_EVENTS), renderMs: per(stream.renderMs, STREAM_EVENTS) },
                          perReload: { FloatingWindow: per(reload.counts.FloatingWindow ?? 0, TREE_RELOADS), RunView: per(reload.counts.RunView ?? 0, TREE_RELOADS), renderMs: per(reload.renderMs, TREE_RELOADS) },
                          pick: { reads, front, depEdges, folded, unfolded } }
    console.log(`BENCH n=${n} ${JSON.stringify(measures[`n${n}`])}`)

    // the behaviour kept
    assert.deepEqual(errors, [], 'the page threw')
    assert.equal(front, `card-${picked}`, 'the picked agent is the front card')
    assert.equal(reads <= 1 && requests.transcript.includes(picked), true, 'its conversation is read, once')
    assert.ok(depEdges > 0, 'the dependency lines are drawn')
    assert.equal(folded, 1, 'folding the thread row hides every agent under it (the row itself stays)')
    assert.ok(unfolded > 0, 'unfolding shows them again')
    // the budget, every line of it checked (a run over budget says each line it broke)
    const over: string[] = []
    const budget = (ok: boolean, what: string) => { if (!ok) over.push(what) }
    // the budget: the conversations read at open are the cards' in view, not every agent's
    budget(open.transcriptRequests <= 10, `transcripts read at open: ${open.transcriptRequests} of ${n} agents`)
    // the outline draws the rows in its view, not every row of the session
    budget(open.outlineRows <= 80, `outline rows in the DOM: ${open.outlineRows} of ${n}`)
    // one agent's stream redraws its own card's conversation once an event, and nothing else: no other card, not the
    // desk, not the outline (the clocks do not run during the stream: what redraws is the stream's)
    budget(stream.counts.RunView! <= STREAM_EVENTS, `card conversations redrawn: ${stream.counts.RunView} for ${STREAM_EVENTS} events`)
    budget((stream.counts.FloatingWindow ?? 0) === 0, `cards redrawn ${stream.counts.FloatingWindow} times by one agent's ${STREAM_EVENTS} events`)
    budget((stream.counts.AgentOutline ?? 0) === 0, `outline redrawn ${stream.counts.AgentOutline} times by one agent's ${STREAM_EVENTS} events`)
    // the tree read again unchanged redraws no card's conversation
    budget((reload.counts.RunView ?? 0) === 0, `card conversations redrawn ${reload.counts.RunView} times by ${TREE_RELOADS} unchanged trees`)
    // a tick of the clock redraws no conversation (a finished card's bot no longer changes with the time, a live
    // one's is its stream's)
    budget((clock.counts.RunView ?? 0) === 0, `card conversations redrawn ${clock.counts.RunView} times by ${CLOCK_TICKS} ticks of the clock`)
    assert.deepEqual(over, [], 'over budget')
  })
}

for (const n of SIZES) {
  test(`a session of ${n} agents all at work: the desk draws the cards in view, and one agent's stream redraws only its own card`, async () => {
    const data = benchData(n, n, ENTRIES)
    const { page, requests, errors } = await openBench(data)
    await page.evaluate((d) => (window as unknown as { __bench: { open(d: unknown): void } }).__bench.open(d), { session: data.session, tree: data.tree, threadRun: data.threadRun })
    await page.waitForSelector('[data-testid="outline"]')
    await settle(page, requests)
    // every live run's stream is subscribed (one each: the store's watchChild; how many connections that is, is the
    // stream layer's, not the desk's) — recorded, not judged here
    const open = { ...(await snap(page)), transcriptRequests: requests.transcript.length, eventStreams: requests.events.length }
    const id = data.liveIds[0]!
    await page.evaluate((runId) => (window as unknown as { __bench: { reveal(id: string): void } }).__bench.reveal(runId), id)
    await page.waitForSelector(`[data-testid="card-${id}"].front [data-testid="agent-view-${id}"]`)
    await reset(page)
    await page.evaluate(([runId, k]) => (window as unknown as { __bench: { stream(id: string, k: number): Promise<void> } }).__bench.stream(runId as string, k as number), [id, STREAM_EVENTS] as const)
    const stream = await snap(page)
    await page.close()
    measures[`live${n}`] = { open, stream }
    console.log(`BENCH live n=${n} ${JSON.stringify(measures[`live${n}`])}`)
    assert.deepEqual(errors, [], 'the page threw')
    const over: string[] = []
    const budget = (ok: boolean, what: string) => { if (!ok) over.push(what) }
    // a column shows the front card and 8 strips: the cards under the deepest strip are not drawn
    budget(open.cards <= 12, `cards in the DOM at open: ${open.cards} of ${n} agents`)
    budget(open.runViews <= 10, `card conversations drawn at open: ${open.runViews} of ${n} cards`)
    budget(open.outlineRows <= 80, `outline rows in the DOM: ${open.outlineRows} of ${n}`)
    budget(stream.counts.RunView! <= STREAM_EVENTS, `card conversations redrawn: ${stream.counts.RunView} for ${STREAM_EVENTS} events`)
    budget((stream.counts.FloatingWindow ?? 0) === 0, `cards redrawn ${stream.counts.FloatingWindow} times by one agent's ${STREAM_EVENTS} events`)
    budget((stream.counts.AgentOutline ?? 0) === 0, `outline redrawn ${stream.counts.AgentOutline} times by one agent's ${STREAM_EVENTS} events`)
    assert.deepEqual(over, [], 'over budget')
  })
}
