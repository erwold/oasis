/** The live UI demo (`?demo=live-ui`) in real Chrome against the built UI (frontend/dist), served by this file on
 *  port 8399 (OASIS_CODE_E2E_PORT; the port every e2e shares — it refuses to start when something listens there).
 *  No backend runs: every /api request is answered 503 and recorded, and the test asserts there are none — the demo's
 *  data is simulated in the page, its cards read an in-memory data source, its stores' actions are swapped in memory.
 *
 *  What it proves: the app without the demo flag never loads the demo's code; the demo draws the product's own
 *  components (surfaces, outline, cards, timeline) and they move — steps, revisions, runs — at 2 Hz, with pause,
 *  1x/4x, reset and the skin switch working; every tab of every card opens, a card expands and comes back, an outline
 *  row is picked, the agents view shows the desk; the layout does not jump while data moves and nothing is wider than
 *  the window at 1440, 1280 and 390; and the person's storage is exactly as it was after the demo leaves. */

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { createConnection } from 'node:net'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'

const PORT = Number(process.env.OASIS_CODE_E2E_PORT || 8399)
const BASE = `http://127.0.0.1:${PORT}`
const DIST = resolve(process.cwd(), 'dist')
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' }
const requests: { method: string; path: string }[] = []
let server: Server
let browser: Browser

const SENTINEL: Record<string, string> = {
  'oasis-code.stackMode': 'cascade', 'oasis-code.desk.s_person': '{"windows":{"run:run_x":{"kind":"run","z":3,"min":false}},"stackCorner":"bl"}',
  'oasis-code.sidebarWidth': '301', 'oasis-code.token': 'tok-sentinel', 'unrelated.key': 'kept',
}

const portFree = () => new Promise<boolean>((r) => { const s = createConnection({ host: '127.0.0.1', port: PORT }); s.once('connect', () => { s.destroy(); r(false) }); s.once('error', () => r(true)) })

before(async () => {
  assert.ok(existsSync(join(DIST, 'index.html')), 'frontend/dist is missing: npm run build first')
  assert.ok(await portFree(), `port ${PORT} is in use: another e2e owns it`)
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', BASE)
    requests.push({ method: req.method ?? 'GET', path: url.pathname })
    if (url.pathname.startsWith('/api/')) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"detail":"no backend in this e2e"}'); return }
    if (url.pathname === '/__blank') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>blank</title>'); return }
    let file = join(DIST, decodeURIComponent(url.pathname))
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html')
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r))
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  browser = await chromium.launch(executablePath ? { executablePath, headless: true, args: ['--no-sandbox'] } : { channel: 'chrome', headless: true })
})

after(async () => {
  await browser?.close()
  await new Promise((r) => server?.close(r))
})

const demoUrl = (extra = '') => `${BASE}/?demo=live-ui&seed=14${extra}`
const data = (page: Page) => page.evaluate(() => {
  const el = document.querySelector<HTMLElement>('[data-testid="live-demo"]')!
  return { step: Number(el.dataset.step), revision: Number(el.dataset.revision), points: Number(el.dataset.points), specChars: Number(el.dataset.specChars), paused: el.dataset.paused, speed: Number(el.dataset.speed) }
})
const apiSince = (from: number) => requests.slice(from).filter((r) => r.path.startsWith('/api/'))

async function openDemo(ctx: BrowserContext, extra = ''): Promise<Page> {
  const page = await ctx.newPage()
  page.on('pageerror', (e) => { throw e })
  await page.goto(demoUrl(extra))
  await page.waitForSelector('[data-testid="live-demo"]')
  await page.waitForSelector('[data-testid="ui-surface-training_metrics"]')
  return page
}

test('the app without the flag never loads the demo', async () => {
  const from = requests.length
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(`${BASE}/`)
  await page.waitForTimeout(1500)
  assert.ok(!requests.slice(from).some((r) => /liveEntry/.test(r.path)), 'no demo chunk')
  assert.equal(await page.locator('[data-testid="live-demo"]').count(), 0)
  await ctx.close()
})

test('the demo moves: steps, revisions and runs at 2 Hz, drawn by the product\'s components, each chart redrawn in place', async () => {
  const from = requests.length
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  const page = await openDemo(ctx)
  // the product's own pieces: four aligned charts, the checkpoint table, the team, three cards, four lanes
  assert.equal(await page.locator('[data-testid="ui-surface-training_metrics"] [data-testid="ui-chart-series"]').count(), 4)
  assert.equal(await page.locator('[data-testid="ui-surface-checkpoint_evals"] table').count(), 1)
  assert.ok(await page.locator('.live-outline .ol-node').count() >= 4)
  assert.equal(await page.locator('.live-card-slot .desk-win').count(), 3)
  assert.equal(await page.locator('[data-testid="agents-relations"]').count(), 1)
  await assert.doesNotReject(page.locator('[data-testid="live-simulated"]').waitFor())
  const counts = await page.locator('[data-testid="live-counts"]').innerText()
  assert.match(counts, /running/); assert.match(counts, /queued/); assert.match(counts, /done/)
  // the very nodes the charts draw into, held by reference (test instrumentation): after new revisions they must be
  // the same nodes, still in the page, with newer data in them
  const before = await page.evaluate(() => {
    const surface = document.querySelector('[data-testid="ui-surface-training_metrics"]')!
    const figures = [...surface.querySelectorAll<HTMLElement>('[data-testid="ui-chart-series"]')]
    const svgs = figures.flatMap((f) => [...f.querySelectorAll('svg')])
    ;(window as unknown as { __liveRefs: unknown }).__liveRefs = { surface, figures, svgs }
    return { revision: Number(surface.getAttribute('data-revision')), svgs: svgs.length, latest: figures.map((f) => Number(f.dataset.latestX)), values: figures.map((f) => [...f.querySelectorAll('[data-testid="ui-chart-value"]')].map((v) => v.textContent).join('|')) }
  })
  assert.ok(before.svgs >= 4 && before.latest.every((x) => Number.isFinite(x)))
  const a = await data(page)
  // the layout holds still while the data moves
  const boxes = () => page.evaluate(() => ['.live-metrics', '.live-cards', '.live-board', '.live-side'].map((s) => { const r = document.querySelector(s)!.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width)] }))
  const b0 = await boxes()
  await page.waitForTimeout(20_000)
  const b = await data(page)
  assert.ok(b.step - a.step >= 4 * 34, `steps ${a.step} → ${b.step}`)
  assert.ok(b.revision - a.revision >= 34, `revisions ${a.revision} → ${b.revision}`)
  assert.ok(b.points > 1_000 && b.specChars < 100_000, `points ${b.points}, spec ${b.specChars}`)
  const kept = await page.evaluate(() => {
    const refs = (window as unknown as { __liveRefs: { surface: Element; figures: HTMLElement[]; svgs: Element[] } }).__liveRefs
    const surface = document.querySelector('[data-testid="ui-surface-training_metrics"]')!
    const figures = [...surface.querySelectorAll<HTMLElement>('[data-testid="ui-chart-series"]')]
    return {
      sameSurface: refs.surface === surface,
      figuresKept: refs.figures.filter((f, i) => f.isConnected && figures[i] === f).length,
      svgsKept: refs.svgs.filter((s) => s.isConnected && surface.contains(s)).length,
      revision: Number(surface.getAttribute('data-revision')),
      latest: refs.figures.map((f) => Number(f.dataset.latestX)),
      values: refs.figures.map((f) => [...f.querySelectorAll('[data-testid="ui-chart-value"]')].map((v) => v.textContent).join('|')),
    }
  })
  assert.ok(kept.sameSurface, 'the surface is the same node')
  assert.equal(kept.figuresKept, 4, 'every chart is the same node')
  assert.equal(kept.svgsKept, before.svgs, 'every chart SVG is the same node')
  assert.ok(kept.revision > before.revision)
  kept.latest.forEach((x, i) => assert.ok(x > before.latest[i]!, `chart ${i}: latest x ${before.latest[i]} → ${x}`))
  assert.ok(kept.values.some((v, i) => v !== before.values[i]), 'a legend value moved')
  assert.deepEqual(await boxes(), b0, 'no jump')
  // the regions are all in the first view at 1440×960
  const tops = await page.evaluate(() => ['.live-metrics', '.live-cards', '.live-board', '.live-outline'].map((s) => document.querySelector(s)!.getBoundingClientRect().top))
  for (const t of tops) assert.ok(t < 960 - 120, `a region starts below the fold (${t})`)
  assert.deepEqual(apiSince(from), [])
  await ctx.close()
})

/** Every write to the page's storage, recorded (test instrumentation: the calls still happen, nothing is swallowed). */
const WATCH_STORAGE = () => {
  const w = window as unknown as { __storageWrites: string[] }
  w.__storageWrites = []
  const proto = Storage.prototype
  const setItem = proto.setItem, removeItem = proto.removeItem, clear = proto.clear
  proto.setItem = function (k: string, v: string) { w.__storageWrites.push(`set ${k}`); return setItem.call(this, k, v) }
  proto.removeItem = function (k: string) { w.__storageWrites.push(`remove ${k}`); return removeItem.call(this, k) }
  proto.clear = function () { w.__storageWrites.push('clear'); return clear.call(this) }
}
const writes = (page: Page) => page.evaluate(() => (window as unknown as { __storageWrites: string[] }).__storageWrites)
const storageNow = (page: Page) => page.evaluate(() => Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => [localStorage.key(i)!, localStorage.getItem(localStorage.key(i)!)!])))

test('every control the page shows works in memory: pause, 1x/4x, reset, skins, every card tab, Stop, expand, shelve, close, drag, resize, unmount — no request, no storage write', async () => {
  const from = requests.length
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  // the person's storage, with keys the app itself uses
  const blank = await ctx.newPage()
  await blank.goto(`${BASE}/__blank`)
  await blank.evaluate((s) => { localStorage.clear(); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v) }, SENTINEL)
  await blank.close()
  await ctx.addInitScript(WATCH_STORAGE)
  const page = await openDemo(ctx)

  // pause: nothing moves, the header says so; resume; 4x; reset; the revision never goes back
  await page.click('[data-testid="live-pause"]')
  const p0 = await data(page)
  await page.waitForTimeout(2_000)
  const p1 = await data(page)
  assert.equal(p1.paused, 'true'); assert.equal(p1.step, p0.step); assert.equal(p1.revision, p0.revision)
  assert.match(await page.locator('[data-testid="live-status"]').innerText(), /PAUSED/i)
  await page.click('[data-testid="live-pause"]')
  await page.click('[data-testid="live-speed"] button:has-text("4×")')
  const f0 = await data(page)
  await page.waitForTimeout(3_000)
  const f1 = await data(page)
  assert.equal(f1.speed, 4)
  assert.ok(f1.step - f0.step >= 16 * 4, `4x: ${f0.step} → ${f1.step}`)
  await page.click('[data-testid="live-speed"] button:has-text("1×")')
  await page.click('[data-testid="live-reset"]')
  await page.waitForTimeout(300)
  assert.ok((await data(page)).step <= 6_040 + 4 * 2, 'reset goes back to the start')
  assert.ok((await data(page)).revision > f1.revision, 'a revision never goes back')
  // the skins: the page's own tokens re-pointed, the address keeps the choice
  await page.click('[data-testid="live-theme"] button:has-text("Signal")')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.liveTheme), 'signal')
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.live-demo')!).backgroundColor)
  assert.match(bg, /^rgb\((1[0-9]|[0-9]), (1[0-9]|[0-9]), (1[0-9]|[0-9])\)$/, `a dark page: ${bg}`)
  assert.match(page.url(), /theme=signal/)
  await page.click('[data-testid="live-theme"] button:has-text("Atelier")')
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.live-demo')!).backgroundColor), 'rgb(255, 255, 255)')

  // every tab of every card: selected, and the real view's content from the demo's data source
  const latestOf = (slot: string) => page.locator(`.live-card-slot[data-testid="live-card-${slot}"] [data-testid^="card-run-"]`).last().getAttribute('data-testid')
  for (const [slot, terminal] of [['trainer', /step\s+\d+ \| loss/], ['evaluator', /eval batch/], ['reporter', /ran no command/]] as const) {
    const card = page.locator(`.live-card-slot[data-testid="live-card-${slot}"]`)
    const runId = (await latestOf(slot))!.replace('card-run-', '')
    const tab = async (name: string) => {
      await card.locator(`[data-testid="card-tab-${name}"]`).click()
      assert.match((await card.locator(`[data-testid="card-tab-${name}"]`).getAttribute('class')) ?? '', /\bon\b/, `${slot}: ${name} selected`)
    }
    await tab('terminal')
    await card.locator('.card-view').getByText(terminal).first().waitFor({ timeout: 5_000 })
    await tab('records')
    await card.locator(`[data-testid="run-detail"]:not([data-loading])`).waitFor({ timeout: 5_000 })
    assert.equal(await card.locator('[data-testid="run-detail"] .rd-name').first().innerText(), runId, `${slot}: the records are its latest run's`)
    for (const name of ['changes', 'checks']) {
      await tab(name)
      await card.locator('.card-view').getByText('No worktree.').waitFor({ timeout: 5_000 })
    }
    await tab('thread')
    await card.locator('[data-testid^="agent-view-"]').waitFor({ timeout: 5_000 })
  }
  // Stop on a live card: asked of the page's store, answered in memory (the run goes on in the simulation)
  await page.locator('.live-card-slot[data-testid="live-card-trainer"] [data-testid="card-stop"]').click()
  // expand and back
  await page.locator('.live-card-slot').first().locator('[data-testid="card-expand"]').click()
  assert.equal(await page.locator('.desk-win.expanded').count(), 1)
  await page.locator('.desk-win.expanded [data-testid="card-expand"]').click()
  assert.equal(await page.locator('.desk-win.expanded').count(), 0)
  // an outline row picked: its card comes forward
  await page.locator('.live-outline .ol-node').nth(1).click()

  // the agents view: the whole desk, four cards; shelve one and take it back; close the finished one; drag and resize
  await page.click('[data-testid="live-tab-agents"]')
  await page.waitForSelector('[data-testid="desk"]')
  const deskCards = page.locator('[data-testid="desk"] .desk-win')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="desk"] .desk-win').length === 4, null, { timeout: 5_000 })
  await deskCards.first().locator('[data-testid="card-shelve"]').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="desk"] .desk-win').length === 3, null, { timeout: 5_000 })
  await page.click('[data-testid="desk-shelf"]')
  await page.locator('[data-testid="desk"] .desk-chip').first().click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="desk"] .desk-win').length === 4, null, { timeout: 5_000 })
  const front = deskCards.first()
  const title = front.locator('.desk-title')
  const tb = (await title.boundingBox())!
  await page.mouse.move(tb.x + 60, tb.y + tb.height / 2); await page.mouse.down(); await page.mouse.move(tb.x - 120, tb.y + 140, { steps: 8 }); await page.mouse.up()
  const edge = page.locator('[data-testid="desk"] .desk-resize-se').first()
  if (await edge.count()) {
    const eb = (await edge.boundingBox())!
    await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2); await page.mouse.down(); await page.mouse.move(eb.x + 60, eb.y + 40, { steps: 6 }); await page.mouse.up()
  }
  const closable = page.locator('[data-testid="desk"] [data-testid="card-close"]')
  assert.ok(await closable.count() >= 1, 'the finished agent can be closed')
  await closable.first().click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="desk"] .desk-win').length === 3, null, { timeout: 5_000 })
  for (const name of ['terminal', 'records']) await page.locator(`[data-testid="desk"] [data-testid="card-tab-${name}"]`).first().click()
  await page.click('[data-testid="live-tab-run"]')
  await page.waitForTimeout(1_000)

  // the demo leaves: both stores back, the skin gone, the storage exactly as it was and never written meanwhile
  await page.evaluate(() => window.dispatchEvent(new Event('oasis-live-demo:unmount')))
  assert.equal(await page.evaluate(() => document.getElementById('root')!.dataset.liveDemo), 'unmounted')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.liveTheme ?? null), null)
  assert.deepEqual(await writes(page), [], 'no storage write during the whole visit')
  assert.deepEqual(await storageNow(page), SENTINEL, 'every key and value as it was')
  assert.deepEqual(apiSince(from), [], 'no request reached /api')
  await ctx.close()
})

test('nothing is wider than the window at 1440, 1280 and 390', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  const page = await openDemo(ctx)
  for (const [w, h] of [[1440, 960], [1280, 800], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(800)
    const wide = await page.evaluate(() => {
      const root = document.querySelector('.live-demo')!
      const out: string[] = []
      if (root.scrollWidth > window.innerWidth + 1) out.push(`page ${root.scrollWidth}`)
      for (const el of document.querySelectorAll('.live-head, .live-metrics, .live-cards, .live-side, .live-side > *, .live-board')) {
        const r = el.getBoundingClientRect()
        if (r.right > window.innerWidth + 1) out.push(`${el.className} ${Math.round(r.right)}`)
      }
      return out
    })
    assert.deepEqual(wide, [], `${w}px`)
  }
  await ctx.close()
})
