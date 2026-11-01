import { bypassDirector } from './agent-entry.ts'
/** A persistent panel in the real app, end to end: one session-scoped surface (present_ui scope `session`) that the
 *  session's main thread keeps up to date across runs — its own forecast, two forecasts handed back by a relay's two
 *  turns, then FIXTURE market data collected on two timed wakes — and that the page shows as ONE block, at the run
 *  that created it, through live updates, a reload, leaving and coming back, and a page closed while a wake ran.
 *
 *  What runs: the real backend (createApp — RunManager, the registered tools present_ui / read_ui / fetch_url / watch,
 *  SQLite, REST, SSE, the WatchService, the built UI from frontend/dist), started by
 *  backend-ts/scripts/persistent_ui_e2e_server.ts on a free loopback port with a fresh temporary data directory, and a
 *  separate headless Chromium with its own temporary profile (OASIS_CODE_E2E_BROWSER names a Chromium executable;
 *  without it, channel chrome). The quotes come from a local HTTP fixture server through the real fetch_url (see the
 *  server's header for the one seam it uses). Nothing is routed, fulfilled or written to the database by the test:
 *  the person's messages go through the page's composer or the app's own REST API, the wakes are the WatchService's,
 *  and the test reads the server's REST API (and its read-only /e2e routes) to check what it holds.
 *
 *  The "models" are SCRIPTED and the market data is a FIXTURE (frontend/e2e/persistent-panel-fixtures.ts says what
 *  each is). This proves the harness's path, not what a real model would choose, and nothing about any market.
 *
 *  Waiting: on visible states (a block's data-revision on the page) and server states, never on how fast a frame or
 *  the host answers. The wake that must be seen mid-way is held at a named gate the test releases.
 *
 *  Locators: the thread's surface block `ui-surface-<id>` (data-run = the anchor run, data-revision), a run's block
 *  `run-<id>`, the session list's `session-<id>`, `new-task`, the composers `hero-composer` / `thread-composer` /
 *  `composer`, `send`, `model-picker`, `model-option-<id>`, `model-current`. The panel's own content is read as text
 *  (its tables, metrics and the chart's legend / accessible values). */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { after, before, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { parseUiSurfaceSpec, splitUiPublishArgs, uiChartPointCount, UI_LIMITS } from '@oasis-code/contract'
import {
  AGENT_KEYS, applyOutcomes, CHART_POINTS_MAX, emptyModel, forecastBlock, forecastSeriesJson, forecastsIn, GATES, HORIZONS_MS, iso, makeForecast, MARK, modelOfSpec, PANEL_ID, publishArgs, RESULT,
  maeOf, REALIZED_MAX, SYMBOL, TICKS, UNIT, withForecast, WORDS, type AgentKey,
} from './persistent-panel-fixtures.ts'

let server: ChildProcess
let serverLog = ''
let info: { port: number; token: string; data: string; isolation: string; fixture_port: number }
let BASE = ''
let browser: Browser

before(async () => {
  server = spawn('bun', ['run', 'scripts/persistent_ui_e2e_server.ts'], { cwd: `${process.cwd()}/../backend-ts`, stdio: ['ignore', 'pipe', 'pipe'] })
  info = await new Promise((resolve, reject) => {
    let buf = ''
    server.stdout!.on('data', (d) => {
      buf += String(d)
      const line = buf.split('\n')[0]!
      if (buf.includes('\n') && line.trim().startsWith('{')) resolve(JSON.parse(line))
    })
    server.stderr!.on('data', (d) => { serverLog = (serverLog + String(d)).slice(-20_000) })
    server.on('exit', (code) => reject(new Error(`persistent ui e2e server exited ${code}: ${serverLog.slice(-4_000)}`)))
  })
  assert.notEqual(info.port, 8321, 'never the owner app\'s port')
  BASE = `http://127.0.0.1:${info.port}`
  console.info(`e2e app port: ${info.port}`)
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/meta/build`)).ok) break } catch { /* not yet */ }
    await sleep(100)
  }
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  browser = await chromium.launch(executablePath ? { executablePath, headless: true, args: ['--no-sandbox'] } : { channel: 'chrome', headless: true })
})

after(async () => {
  await browser?.close()
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r))
    server.kill('SIGTERM')
    await Promise.race([exited, sleep(10_000)])
  }
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- the server, read from the test process

async function serverCall<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const r = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'x-oasis-code-token': info.token, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  return { status: r.status, body: (await r.json().catch(() => null)) as T }
}
async function serverGet<T>(path: string): Promise<T> {
  const r = await serverCall<T>(path)
  assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`)
  return r.body
}
async function e2e<T>(path: string, method = 'GET'): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${info.token}` } })
  assert.equal(r.status, 200, path)
  return r.json() as Promise<T>
}
/** Poll the server until `ok(value)` (a server state, never a timing of the page); the last value on failure. */
async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  let v = await read()
  while (!ok(v)) {
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v).slice(0, 2_000)}\n${serverLog.slice(-2_000)}`)
    await sleep(200)
    v = await read()
  }
  return v
}

interface RunView { id: string; status: string; model: string; spawned_by: string; relay_id: string | null; created_at: string }
interface Relay { id: string; status: string }
interface SurfaceRecord {
  session_id: string; run_id: string; surface_id: string; scope?: string; updated_by_run_id?: string; revision: number; model: string | null
  spec: Record<string, unknown>; updated_at: string
}
interface StoredEvent { seq: number; event: string; data: Record<string, unknown> }
interface Seen { model: string; turn: string; statuses: { tool: string; status: unknown; revision: unknown; current_revision: unknown }[] }

const sessionDetail = (sid: string) => serverGet<{ runs: RunView[]; relays: Relay[]; active_run: { id: string } | null; watches: { id: string; status: string; note: string }[] }>(`/api/sessions/${sid}`)
const panelsOf = async (sid: string) => (await serverGet<{ surfaces: SurfaceRecord[] }>(`/api/sessions/${sid}/ui`)).surfaces.filter((s) => s.surface_id === PANEL_ID)
const finalText = async (runId: string) => String(((await serverGet<{ receipt: { final_text?: string } | null }>(`/api/runs/${runId}/receipt`)).receipt ?? {}).final_text ?? '')
const uiEvents = (runId: string) => e2e<{ events: StoredEvent[] }>(`/e2e/ui-events?run_id=${runId}`).then((r) => r.events)
const published = async (runId: string) => (await uiEvents(runId)).filter((e) => e.event === 'ui_surface').map((e) => e.data.surface as SurfaceRecord)
const resultsOf = async (runId: string, tool: string) => (await uiEvents(runId)).filter((e) => e.event === 'tool_result' && e.data.tool === tool).map((e) => e.data)
const seen = () => e2e<Seen[]>('/e2e/seen')
const stage = (n: number) => e2e(`/e2e/fixture/stage?n=${n}`, 'POST')
async function release(name: string): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    if ((await e2e<{ released: boolean }>(`/e2e/gate?name=${name}&op=release`, 'POST')).released) return
    await sleep(200)
  }
  throw new Error(`no run reached the gate ${name}`)
}
const waitRunDone = (runId: string) => until(`run ${runId} done`, () => serverGet<{ status: string }>(`/api/runs/${runId}`), (r) => r.status !== 'queued' && r.status !== 'running', 60_000)
  .then((r) => assert.equal(r.status, 'done', `run ${runId} ended ${r.status}`))

// ---------------------------------------------------------------- the page

interface App { context: BrowserContext; page: Page; errors: Error[] }

/** A fresh context (its own storage: a temporary profile of the separate browser process), the app opened with the token. */
async function openApp(): Promise<App> {
  const context = await browser.newContext({ viewport: { width: 1680, height: 1050 } })
  const page = await context.newPage()
  const errors: Error[] = []
  page.on('pageerror', (e) => errors.push(e))
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]', { timeout: 30_000 })
  return { context, page, errors }
}
async function closeApp(app: App): Promise<void> {
  const errors = app.errors.map((e) => e.message)
  await app.context.close()
  assert.deepEqual(errors, [], 'no uncaught error on the page')
}
async function pickModel(page: Page, id: string) {
  await bypassDirector(page)
  await page.click('[data-testid="model-picker"]')
  const label = (await page.locator(`[data-testid="model-option-${id}"] .picker-label`).innerText()).trim()
  await page.click(`[data-testid="model-option-${id}"]`)
  await page.waitForFunction((want) => (document.querySelector('[data-testid="model-current"]')?.textContent ?? '').trim() === want, label, { timeout: 5_000 })
}
const currentSession = async (page: Page) => (await page.locator('[aria-current="page"][data-testid^="session-"]').getAttribute('data-testid'))!.slice('session-'.length)
async function openSession(page: Page, sid: string) {
  await page.click(`[data-testid="session-${sid}"]`)
  await page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
  await bypassDirector(page)
}

const PANEL = `[data-testid="thread"] [data-testid="ui-surface-${PANEL_ID}"]`
/** The panel at a revision, as the page shows it (a visible state: the block's own attribute). */
async function panelAt(page: Page, revision: number, ms = 30_000) {
  await page.waitForSelector(`${PANEL}[data-revision="${revision}"]`, { timeout: ms })
  return page.locator(PANEL)
}
/** Exactly one block of the panel in the thread, inside the run that created it (data-run stays the anchor), marked
 *  live (the frontend's `data-live`, its `ui-live` mark reading "Live"); with `writer`, the block names the run that
 *  wrote the revision shown (`data-updated-by`) and its time (`data-updated-at`, as the server holds it). */
async function oneBlockAt(page: Page, anchorRun: string, writer?: { run: string; updated_at: string }) {
  assert.equal(await page.locator(PANEL).count(), 1, 'one block of the panel in the thread')
  assert.equal(await page.locator(`[data-testid="run-${anchorRun}"] [data-testid="ui-surface-${PANEL_ID}"]`).count(), 1, 'the block sits at the run that created it')
  const block = page.locator(PANEL)
  assert.equal(await block.getAttribute('data-run'), anchorRun)
  assert.equal(await block.getAttribute('data-live'), 'true')
  const mark = block.getByTestId('ui-live')
  assert.ok(await mark.count() >= 1, 'the live mark')
  assert.match((await mark.first().textContent()) ?? '', /\bLive\b/)
  if (writer) {
    assert.equal(await block.getAttribute('data-updated-by'), writer.run)
    assert.equal(await block.getAttribute('data-updated-at'), writer.updated_at)
  }
}
/** The chart's series block: its axis, how many series and points it draws, its legend's entries and their style. */
async function chartOf(page: Page) {
  const chart = page.locator(PANEL).locator('[data-testid="ui-chart-series"]')
  assert.equal(await chart.count(), 1, 'one series chart in the panel')
  const legend = await chart.locator('[data-series]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-series'), e.getAttribute('data-style')]))
  return {
    chart,
    axis: await chart.getAttribute('data-x-axis'), series: Number(await chart.getAttribute('data-series-count')), points: Number(await chart.getAttribute('data-points')),
    legend: Object.fromEntries(legend) as Record<string, string | null>,
  }
}

// ---------------------------------------------------------------- the fixture's panels, as the contract reads them

test('the panel the scenario publishes is a spec the contract accepts, within the chart bound at its fullest', () => {
  let m = withForecast(applyOutcomes(emptyModel(), [{ kind: 'quote', at: 't0', source: 's0', quote: TICKS[0]! }]), makeForecast('owner', TICKS[0]!, 't0'))
  const check = (args: Record<string, unknown>, expected: number) => {
    const { options, spec } = splitUiPublishArgs(args)
    assert.deepEqual(options, { ok: true, value: { scope: 'session', expected_revision: expected } })
    const parsed = parseUiSurfaceSpec(spec)
    assert.ok(parsed.ok, JSON.stringify(parsed))
    return spec
  }
  check(publishArgs(m, 0), 0)
  // An instruction naming an unclosed <forecast> tag must not consume the next valid agent answer.
  const relayAnswers = ['A', 'B'].map((k) => forecastBlock(makeForecast(k as 'A' | 'B', TICKS[0]!, 't1'))).join('\n')
  assert.deepEqual(forecastsIn(WORDS.relay + '\n' + relayAnswers).map((f) => f.agent), ['A', 'B'])
  for (const k of ['A', 'B'] as const) m = withForecast(m, makeForecast(k, TICKS[0]!, 't1'))
  // a window full of actual points: 88 actual + 3 × 4 forecast points = the contract's 100, never more
  for (let i = 1; i <= REALIZED_MAX + 20; i += 1) {
    m = applyOutcomes(m, [{ kind: 'quote', at: `t${i}`, source: `s${i}`, quote: { symbol: SYMBOL, unit: UNIT, asof_ms: TICKS[0]!.asof_ms + i * 60_000, price: 100 + i / 100 } }])
  }
  assert.equal(m.realized.length, REALIZED_MAX)
  assert.equal(m.realized.at(-1)!.x, TICKS[0]!.asof_ms + (REALIZED_MAX + 20) * 60_000, 'the actual tail advances beyond capacity')
  for (const x of HORIZONS_MS) assert.ok(m.realized.some((p) => p.x === x), 'comparison actuals survive the window bound')
  assert.equal(maeOf(m, 'A').n, HORIZONS_MS.length, 'completed comparisons remain scored after the bound')
  const full = check(publishArgs(m, 7), 7)
  const chart = (full.elements as Record<string, { props: Parameters<typeof uiChartPointCount>[0] }>).chart!.props
  // the scenario's own window (its producer keeps the chart at CHART_POINTS_MAX), within the contract's bound
  assert.equal(uiChartPointCount(chart), CHART_POINTS_MAX)
  assert.ok(CHART_POINTS_MAX <= UI_LIMITS.chartPoints)
  // the score: only forecast points after the common origin, against actual points at exactly their time — the origin
  // (where every forecast equals the actual by construction) is drawn but never scored
  let scored = withForecast(applyOutcomes(emptyModel(), [{ kind: 'quote', at: 'a0', source: 'q0', quote: TICKS[0]! }]), makeForecast('A', TICKS[0]!, 'a0'))
  assert.deepEqual(maeOf(scored, 'A'), { value: null, n: 0 }, 'the origin alone is no score')
  scored = applyOutcomes(scored, [{ kind: 'quote', at: 'a1', source: 'q1', quote: TICKS[1]! }])
  assert.deepEqual(maeOf(scored, 'A'), { value: 0.4, n: 1 }, '|100.4 − 100.8| at 01:35 only, not averaged with the origin\'s 0')
  // the docs' examples are the fixture's own calls
  const doc = JSON.parse(readFileSync(new URL('../../docs/intelligent-ui-demos/persistent-panel.tool-calls.json', import.meta.url), 'utf8')) as { calls: { tool: string; args: Record<string, unknown> }[] }
  for (const c of doc.calls.filter((c) => c.tool === 'present_ui' && 'surface_id' in c.args)) check(c.args, c.args.expected_revision as number)
})

// ---------------------------------------------------------------- the scenario

test('one persistent panel: three forecasts from three runs, two timed wakes of fixture data, CAS conflicts merged, one block throughout', { timeout: 480_000 }, async () => {
  assert.equal(info.isolation, 'unavailable', 'the server does not probe the OS sandbox (no command runs here)')

  // ---- 1. the main thread creates the panel with its own forecast (typed in the real composer)
  let app = await openApp()
  await pickModel(app.page, 'scripted:pf-owner')
  await app.page.fill('[data-testid="composer"]', WORDS.start)
  await app.page.click('[data-testid="send"]')
  await app.page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
  const sid = await currentSession(app.page)
  const r1 = (await until('the first run', () => sessionDetail(sid), (d) => d.runs.length === 1)).runs[0]!.id
  await waitRunDone(r1)
  let panel = await panelAt(app.page, 1)
  await oneBlockAt(app.page, r1)
  const rev1Text = await panel.innerText()
  assert.match(rev1Text, /FIXTURE/)
  assert.match(rev1Text, /等待提交/, 'A and B have not answered yet')
  let c = await chartOf(app.page)
  assert.deepEqual([c.axis, c.series, c.points], ['time', 4, 1 + 4], 'actual (1) + the owner\'s forecast (origin + 3); A and B empty')
  let [rec] = await panelsOf(sid)
  assert.equal((await panelsOf(sid)).length, 1)
  assert.deepEqual([rec!.scope, rec!.run_id, rec!.revision, rec!.updated_by_run_id ?? rec!.run_id], ['session', r1, 1, r1])
  assert.match(await finalText(r1), new RegExp(MARK.created))

  // ---- 2. two more forecasters, as a relay's two turns (no write to the panel; their answers carry the forecasts)
  const relayStart = await serverCall<{ id: string; relay_id: string | null }>(`/api/sessions/${sid}/chat`, {
    method: 'POST', body: { text: WORDS.relay, agents: [{ model: 'scripted:pf-a' }, { model: 'scripted:pf-b' }] },
  })
  assert.equal(relayStart.status, 200, JSON.stringify(relayStart.body))
  const relayId = relayStart.body.relay_id!
  await until('the relay', () => sessionDetail(sid), (d) => d.relays.some((r) => r.id === relayId && r.status !== 'running') && d.active_run === null, 60_000)
  const relayRuns = (await sessionDetail(sid)).runs.filter((r) => r.relay_id === relayId)
  assert.deepEqual(relayRuns.map((r) => [r.model, r.status]), [['scripted:pf-a', 'done'], ['scripted:pf-b', 'done']])
  // the relay turns reached nothing of the panel: a session read refused, a run read not found, a publication refused
  const probes = (await seen()).filter((s) => s.turn.startsWith('relay-'))
  assert.equal(probes.length, 2)
  for (const p of probes) {
    assert.deepEqual(p.statuses.slice(0, 2).map((s) => [s.tool, s.status]), [['read_ui', 'refused'], ['read_ui', 'not_found']], JSON.stringify(p))
    assert.equal(p.statuses[2]!.tool, 'present_ui')
    assert.notEqual(p.statuses[2]!.status, 'ok', 'a relay turn cannot publish the session panel')
  }
  for (const r of relayRuns) assert.deepEqual(await published(r.id), [], `relay run ${r.id} published nothing`)
  assert.equal((await panelsOf(sid))[0]!.revision, 1, 'the panel is as the main thread left it')

  // ---- 3. the main thread aggregates (the relay's answers are in its conversation) and sets a timer watch
  const agg = await serverCall<{ id: string }>(`/api/sessions/${sid}/chat`, { method: 'POST', body: { text: WORDS.aggregate, model: 'scripted:pf-owner' } })
  assert.equal(agg.status, 200, JSON.stringify(agg.body))
  const r3 = agg.body.id
  await waitRunDone(r3)
  const aggregateText = await finalText(r3)
  assert.ok(aggregateText.includes(MARK.aggregated), aggregateText)
  assert.equal((await panelsOf(sid))[0]?.revision, 2, aggregateText)
  panel = await panelAt(app.page, 2)                                      // live: the page streams the new run
  await oneBlockAt(app.page, r1)
  const rev2Text = await panel.innerText()
  assert.doesNotMatch(rev2Text, /等待提交/)
  for (const v of ['100.4', '99.75', '101.2', '99.25']) assert.ok(rev2Text.includes(v), `forecast value ${v} on the page`)
  assert.equal((await seen()).find((s) => s.turn === 'aggregate')!.statuses[0]!.status, 'not_found', 'a session read of an id that does not exist')
  // three forecasts, three runs on three routes: the panel holds exactly what each run answered
  rec = (await panelsOf(sid))[0]!
  const m2 = modelOfSpec(rec.spec)
  const answered: Record<AgentKey, string> = {
    owner: await finalText(r1), A: await finalText(relayRuns[0]!.id), B: await finalText(relayRuns[1]!.id),
  }
  for (const k of AGENT_KEYS) {
    const theirs = forecastsIn(answered[k]).find((f) => f.agent === k)
    assert.ok(theirs, `run of ${k} answered a forecast`)
    assert.deepEqual(m2.forecasts[k], theirs, `the panel's forecast ${k} is the one its run answered`)
  }
  assert.equal(new Set([r1, relayRuns[0]!.id, relayRuns[1]!.id]).size, 3)
  const frozen = forecastSeriesJson(rec.spec)
  const watchSet = (await sessionDetail(sid)).watches.find((w) => w.status === 'active')
  assert.ok(watchSet, 'a timer watch waits')

  // ---- 4. the page is closed; the first wake runs meanwhile (fixture stage 1: a new quote, then the same again)
  await stage(1)
  await closeApp(app)
  const wakes1 = await until('the first wake', () => sessionDetail(sid), (d) => d.runs.some((r) => r.spawned_by === 'wake' && r.status === 'done') && d.active_run === null, 150_000)
  const w1 = wakes1.runs.find((r) => r.spawned_by === 'wake')!.id
  rec = (await panelsOf(sid))[0]!
  assert.deepEqual([rec.revision, rec.run_id, rec.updated_by_run_id], [3, r1, w1], 'the wake updated the panel in place: same anchor, the wake as writer')
  // the wake published once; its retry of the same publication conflicted and, read again, needed nothing more
  const w1Pub = await published(w1)
  assert.deepEqual(w1Pub.map((s) => [s.revision, s.run_id, s.updated_by_run_id]), [[3, r1, w1]])
  assert.deepEqual((await resultsOf(w1, 'present_ui')).map((d) => d.status), ['ok', 'conflict'])
  assert.equal((await resultsOf(w1, 'read_ui')).length, 2, 'read again after the conflict')
  let m = modelOfSpec(rec.spec)
  assert.deepEqual(m.realized.map((p) => p.x), [TICKS[0]!.asof_ms, TICKS[1]!.asof_ms], 'the repeated collection appended one point')
  assert.deepEqual(m.log.map((r) => r.result), [RESULT.appended, RESULT.appended, RESULT.duplicate])

  // ---- 5. a new page: the panel as the wake left it, one block, at its first run
  app = await openApp()
  await openSession(app.page, sid)
  panel = await panelAt(app.page, 3)
  await oneBlockAt(app.page, r1, { run: w1, updated_at: rec.updated_at })
  const rev3Text = await panel.innerText()
  for (const v of ['100.8', '0.8', '0.4', '1.05']) assert.ok(rev3Text.includes(v), `${v} on the page after the first wake`)
  assert.match(rev3Text, /暂无/, 'the points not reached yet have no error')

  // ---- 6. the second wake (stage 2: a 503, a stale quote, then a new one), held after its first publication
  await e2e(`/e2e/gate?name=${GATES.afterFailure}&op=arm`, 'POST')
  await stage(2)
  // a reload while waiting for it
  await app.page.reload()
  await app.page.waitForSelector(`[data-testid="session-${sid}"]`, { timeout: 30_000 })
  await openSession(app.page, sid)
  panel = await panelAt(app.page, 4, 150_000)                            // live: the wake's publication streams in
  await oneBlockAt(app.page, r1)
  const rev4Text = await panel.innerText()
  assert.match(rev4Text, /HTTP 503/, 'the failed collection is shown')
  assert.match(rev4Text, /过旧/, 'the stale quote is shown as such')
  assert.ok(rev4Text.includes(iso(TICKS[1]!.asof_ms)), 'the last successful as-of is kept')
  m = modelOfSpec((await panelsOf(sid))[0]!.spec)
  assert.equal(m.last_success!.asof_ms, TICKS[1]!.asof_ms)
  assert.equal(m.realized.length, 2, 'neither the failure nor the stale quote added a point')
  // leave the session and come back while the wake is held
  await app.page.click('[data-testid="new-task"]')
  await app.page.waitForSelector('[data-testid="hero-composer"]', { timeout: 30_000 })
  await openSession(app.page, sid)
  await panelAt(app.page, 4)
  await oneBlockAt(app.page, r1)
  await release(GATES.afterFailure)
  panel = await panelAt(app.page, 5, 60_000)
  await oneBlockAt(app.page, r1)
  const w2 = (await until('the second wake', () => sessionDetail(sid), (d) => d.runs.filter((r) => r.spawned_by === 'wake' && r.status === 'done').length === 2 && d.active_run === null, 60_000))
    .runs.filter((r) => r.spawned_by === 'wake').map((r) => r.id).find((id) => id !== w1)!
  // A revision is data readiness, not a promise that this old turn is still in the viewport after a wake.
  for (const v of ['100.3', '0.55', '0.45', '0.925']) {
    const value = panel.getByText(v, { exact: true }).first()
    await value.scrollIntoViewIfNeeded()
    await value.evaluate(el => {
      const scroller = el.closest<HTMLElement>('.thread-scroll')!, r = el.getBoundingClientRect(), view = scroller.getBoundingClientRect()
      const bottom = Math.min(view.bottom, document.querySelector('.composer-dock')!.getBoundingClientRect().top)
      scroller.scrollTop += r.top - view.top - (bottom - view.top - r.height) / 2
    })
    await until(`${v} is rendered in the readable viewport, not behind the composer`, async () => {
      await app.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const state = await value.evaluate(el => {
        const r = el.getBoundingClientRect(), view = el.closest('.thread-scroll')!.getBoundingClientRect(), dock = document.querySelector('.composer-dock')!.getBoundingClientRect()
        return { text: (el as HTMLElement).innerText, visible: el.checkVisibility({ contentVisibilityAuto: true }),
          readable: r.width > 0 && r.height > 0 && r.top >= view.top && r.bottom <= Math.min(view.bottom, dock.top) }
      })
      return state.readable && state.visible && state.text === v
    }, readable => readable, 5_000)
    assert.equal(await value.innerText(), v)
  }
  const rev5Text = await panel.innerText()
  for (const v of ['100.3', '0.55', '0.45', '0.925']) assert.ok(rev5Text.includes(v), `${v} on the page after the second wake`)

  // ---- 7. what the server holds: one row, its anchor, its writers, the CAS conflict merged (not replayed)
  const rows = await panelsOf(sid)
  assert.equal(rows.length, 1, 'one session panel, never a copy per run')
  rec = rows[0]!
  assert.deepEqual([rec.scope, rec.run_id, rec.revision, rec.updated_by_run_id], ['session', r1, 5, w2])
  const w2Pub = await published(w2)
  assert.deepEqual(w2Pub.map((s) => [s.revision, s.run_id, s.updated_by_run_id]), [[4, r1, w2], [5, r1, w2]])
  const w2Present = await resultsOf(w2, 'present_ui')
  assert.deepEqual(w2Present.map((d) => d.status), ['ok', 'conflict', 'ok'], 'the stale write conflicted; the merged one went through')
  m = modelOfSpec(rec.spec)
  assert.deepEqual(m.realized.map((p) => p.x), TICKS.map((t) => t.asof_ms), 'one point per market time, in order')
  // the stale write lacked the 503 and stale rows of revision 4; the published revision 5 has them: it was merged
  assert.ok(m.log.some((r) => r.result.includes('HTTP 503')) && m.log.some((r) => r.result === RESULT.stale), JSON.stringify(m.log))
  assert.equal(m.last_success!.asof_ms, TICKS[2]!.asof_ms)
  // every forecast byte for byte as first published, through both wakes and the repeated collection
  const all = [...(await published(r1)), ...(await published(r3)), ...w1Pub, ...w2Pub]
  assert.deepEqual(all.map((s) => s.revision), [1, 2, 3, 4, 5])
  for (const s of all.slice(1)) assert.deepEqual(forecastSeriesJson(s.spec), frozen, `revision ${s.revision}: the forecasts are unchanged`)
  assert.equal(forecastSeriesJson(all[0]!.spec).owner, frozen.owner)
  for (const s of all) assert.equal(s.run_id, r1, 'every publication names the anchor')
  // two different wake runs, both the WatchService's
  const wakeRuns = (await sessionDetail(sid)).runs.filter((r) => r.spawned_by === 'wake')
  assert.deepEqual(wakeRuns.map((r) => r.id).sort(), [w1, w2].sort())
  // the fixture market answered what the scenario expects, every request through fetch_url
  const fx = await e2e<{ log: { stage: number; reply: string }[] }>('/e2e/fixture/log')
  assert.deepEqual(fx.log.map((h) => h.stage), [0, 0, 0, 1, 1, 2, 2, 2], JSON.stringify(fx.log))
  assert.match(fx.log[5]!.reply, /HTTP 503/)

  // ---- 8. the chart: four lines on one time axis (3 actual + 3 × 4 forecast points), nothing drawn from a non-finite number
  await oneBlockAt(app.page, r1, { run: w2, updated_at: rec.updated_at })
  await panel.getByTestId('ui-chart-series').scrollIntoViewIfNeeded()
  c = await chartOf(app.page)
  assert.deepEqual([c.axis, c.series, c.points], ['time', 4, 3 + 3 * 4])
  assert.deepEqual(c.legend, { actual: 'solid', fc_owner: 'dashed', fc_A: 'dashed', fc_B: 'dashed' })
  assert.doesNotMatch(await c.chart.evaluate((el) => el.outerHTML), /NaN|Infinity/, 'no non-finite coordinate')

  // ---- 9. one last reload: still one block, the last revision
  await app.page.reload()
  await app.page.waitForSelector(`[data-testid="session-${sid}"]`, { timeout: 30_000 })
  await openSession(app.page, sid)
  await panelAt(app.page, 5)
  await oneBlockAt(app.page, r1)
  await closeApp(app)
})
