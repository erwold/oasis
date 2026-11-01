/** Atelier in the normal app, end to end: the page opened as a person opens it (no demo query, no in-memory adapter —
 *  the real backend from backend-ts/scripts/atelier_e2e_server.ts, its SCRIPTED models publishing a live native
 *  surface through present_ui and running three separate tasks) draws the intelligent-UI surface, the agents' board,
 *  the Agent Teams outline and the desk's cards in Atelier when the person chooses Claude in Settings › Appearance; in
 *  the neutral light palette (no Atelier warmth) by default; and in the app's dark ramp when Dark is chosen or System
 *  follows a dark system. A choice is kept across a reload and drawn from the first paint; a running HTML surface
 *  takes a change of theme in place. What is read is what the browser computed for the product's own elements;
 *  nothing is routed or faked.
 *
 *  One server on OASIS_CODE_E2E_PORT (8399 in the serial runner), one headless Chrome with its own profile. */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright-core'
import { bypassDirector } from './agent-entry.ts'
import { showTeams } from './natural-language-driver.ts'

let server: ChildProcess
let serverLog = ''
let info: { port: number; token: string; isolation: string }
let BASE = ''
let browser: Browser
let sid = ''

before(async () => {
  server = spawn('bun', ['run', 'scripts/atelier_e2e_server.ts'], { cwd: `${process.cwd()}/../backend-ts`, stdio: ['ignore', 'pipe', 'pipe'] })
  info = await new Promise((resolve, reject) => {
    let buf = ''
    server.stdout!.on('data', (d) => { buf += String(d); const line = buf.split('\n')[0]!; if (buf.includes('\n') && line.trim().startsWith('{')) resolve(JSON.parse(line)) })
    server.stderr!.on('data', (d) => { serverLog = (serverLog + String(d)).slice(-20_000) })
    server.on('exit', (code) => reject(new Error(`atelier e2e server exited ${code}: ${serverLog.slice(-4_000)}`)))
  })
  BASE = `http://127.0.0.1:${info.port}`
  console.info(`e2e app port: ${info.port}`)
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/meta/build`)).ok) break } catch { /* not yet */ }
    await sleep(100)
  }
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  browser = await chromium.launch(executablePath ? { executablePath, headless: true, args: ['--no-sandbox'] } : { channel: 'chrome', headless: true })
}, { timeout: 60_000 })

after(async () => {
  await browser?.close()
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r))
    server.kill('SIGTERM')
    await Promise.race([exited, sleep(10_000)])
  }
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const api = async <T>(path: string, body?: unknown): Promise<T> => {
  const r = await fetch(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-oasis-code-token': info.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`)
  return r.json() as Promise<T>
}
async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  let v = await read()
  while (!ok(v)) {
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v).slice(0, 1_000)}`)
    await sleep(200)
    v = await read()
  }
  return v
}
/** a separate task of the session (the composer's "separate" way, its REST route); a folder another run of the session
 *  is writing is said busy (409 workspace_busy): sent again after a moment, as the route says, for up to 30 s */
async function dispatch(sid: string, model: string, words: string): Promise<void> {
  const end = Date.now() + 30_000
  for (;;) {
    const r = await fetch(`${BASE}/api/sessions/${sid}/work-orders`, { method: 'POST', headers: { 'x-oasis-code-token': info.token, 'content-type': 'application/json' }, body: JSON.stringify({ work_order: { prompt: words, model } }) })
    if (r.ok) return
    const body = await r.text()
    if (r.status !== 409 || !body.includes('workspace_busy') || Date.now() > end) throw new Error(`work order: ${r.status} ${body}`)
    await sleep(300)
  }
}
const VERMILION = 'rgb(226, 64, 31)'
const INK = 'rgb(34, 34, 34)'
/** the light palette's ink and hairline (index.css :root, as 126e2ca had it), as the browser computes them */
const LIGHT_INK = 'oklch(0.247 0.006 258.361)'
const WARM_LINE = 'rgb(233, 229, 222)'

/** Settings › Appearance › Theme, as a person picks it (the launcher, the tab, the option), then closed */
async function chooseTheme(page: Page, theme: 'light' | 'dark' | 'claude' | 'system') {
  await page.click('[data-testid="settings"]')
  await page.waitForSelector('[data-testid="settings-dialog"][open]')
  await page.click('[data-testid="settings-tab-appearance"]')
  await page.click(`[data-testid="theme-${theme}"]`)
  assert.equal(await page.locator(`[data-testid="theme-${theme}"]`).isChecked(), true)
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="settings-dialog"]', { state: 'detached' })
}
/** every value data-theme took on the root from before the page's first script (an init script runs before it; the
 *  observer is on the document, so it sees the root as the parser makes it), and the value when the body first stood
 *  (nothing paints before there is a body) */
const recordThemes = (page: Page) => page.addInitScript(() => {
  const seen: Array<string | null> = []
  const rec = { seen, atBody: undefined as string | null | undefined }
  ;(window as unknown as { __themes: typeof rec }).__themes = rec
  const read = () => {
    const v = document.documentElement?.getAttribute('data-theme') ?? null
    if (v !== null && seen[seen.length - 1] !== v) seen.push(v)
    if (rec.atBody === undefined && document.body) rec.atBody = v
  }
  new MutationObserver(read).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-theme'] })
})
const themesSeen = (page: Page) => page.evaluate(() => { const r = (window as unknown as { __themes: { seen: Array<string | null>; atBody: string | null | undefined } }).__themes; return { seen: r.seen, atBody: r.atBody ?? null } })

/** what the browser computed for the first element of `sel` */
const css = (page: Page, sel: string, props: string[]) => page.evaluate(([s, ps]) => {
  const el = document.querySelector(s as string)
  if (!el) return null
  const c = getComputedStyle(el)
  return Object.fromEntries((ps as string[]).map((p) => [p, c.getPropertyValue(p)]))
}, [sel, props] as const)


/** the html surface `run_notes` run in its frame: what its own document computed for its body, its field and a cell */
async function notesFrame(page: Page) {
  const block = page.locator('[data-testid="ui-surface-run_notes"]').first()
  await block.locator('[data-testid="intelligent-html-run"]').click()
  const frame = block.frameLocator('[data-testid="intelligent-html-frame"]')
  const button = frame.locator('#cmp')
  await button.waitFor({ timeout: 20_000 })
  // the theme posted after ready settles in the frame's own rule: wait for its face, then read
  await page.waitForTimeout(300)
  return button.evaluate((b) => {
    const c = getComputedStyle(document.getElementById('step')!), d = getComputedStyle(document.body), cell = getComputedStyle(document.querySelector('td')!)
    return { family: d.fontFamily, ink: d.color, bg: d.backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme, radius: c.borderTopLeftRadius, cellLine: cell.borderBottomColor }
  })
}

test('atelier app: the normal page, Claude chosen in Settings — the live surface, the board, the outline and the cards in Atelier', { timeout: 180_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'light' })
  const page = await context.newPage()
  const errors: string[] = []
  const paths: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('request', (r) => paths.push(new URL(r.url()).pathname))
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]', { timeout: 30_000 })
  assert.equal(new URL(page.url()).searchParams.get('demo'), null)
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light', 'a first start is light')
  await chooseTheme(page, 'claude')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'claude')
  await bypassDirector(page)
  await page.click('[data-testid="model-picker"]')
  await page.click('[data-testid="model-option-scripted:report"]')
  await page.fill('[data-testid="composer"]', 'Open the run log, hold 1s')
  await page.click('[data-testid="send"]')
  await page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
  sid = (await page.locator('[aria-current="page"][data-testid^="session-"]').getAttribute('data-testid'))!.slice('session-'.length)
  await until('the first run', () => api<{ active_run: unknown; runs: unknown[] }>(`/api/sessions/${sid}`), (d) => d.runs.length === 1 && d.active_run === null)
  // three separate tasks of the session, then the main agent publishes its surfaces beside them
  for (const [model, words] of [['scripted:eval', 'Evaluate the latest checkpoint, hold 90s'], ['scripted:data', 'Audit the next data shard, hold 90s'], ['scripted:report', 'Write the run report, hold 2s']]) {
    await dispatch(sid, model!, words!)
  }
  for (let tries = 0; ; tries++) {
    const r = await fetch(`${BASE}/api/sessions/${sid}/chat`, { method: 'POST', headers: { 'x-oasis-code-token': info.token, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Keep the training metrics on screen #short', model: 'scripted:trainer' }) })
    if (r.ok) break
    if (r.status !== 409 || tries > 100) throw new Error(`chat: ${r.status} ${await r.text()}`)
    await sleep(300)
  }
  const surface = page.locator('[data-testid="ui-surface-training_metrics"]')
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="ui-surface-training_metrics"]')?.getAttribute('data-revision') ?? 0) >= 6, null, { timeout: 60_000 })
  await page.waitForSelector('[data-testid="agents-board"] [data-testid="agents-relations"]', { timeout: 30_000 })

  // the normal entry: no demo chunk, no demo skin on the document
  assert.ok(!paths.some((p) => /liveEntry|LiveDemo/.test(p)), 'no demo chunk was loaded')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.liveTheme ?? null), null)
  assert.equal(await page.locator('.live-demo').count(), 0)
  // the page is this checkout's build: the stylesheet it loaded is the one frontend/dist/index.html names
  const builtCss = /assets\/index-[\w-]+\.css/.exec(readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8'))![0]
  assert.ok(paths.some((p) => p.endsWith(builtCss)), `the served stylesheet is ${builtCss}`)
  // what the page serves, for the record
  const served = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement), uis = getComputedStyle(document.querySelector('.uis')!)
    const v = (s: CSSStyleDeclaration, n: string) => s.getPropertyValue(n).trim()
    return { page: v(root, '--page'), ink: v(root, '--ink'), ink2: v(root, '--ink-2'), line: v(root, '--line'), accent: v(root, '--accent'), uisLatest: v(uis, '--uis-latest'),
      uisSeries0: v(uis, '--uis-series-0'), uisFont: v(uis, '--font-body'), uisRadiusMd: v(uis, '--radius-md'), uisAccent: v(uis, '--accent'), agentLive: v(uis, '--agent-live') }
  })
  console.info(`served (claude): ${builtCss} ${JSON.stringify(served)}`)
  assert.deepEqual([served.page, served.ink, served.ink2, served.line, served.uisLatest, served.uisAccent], ['#fff', '#222', '#655e53', '#e9e5de', '#e2401f', '#222'])

  // The surface blends into the conversation; typography and curve colors still follow the selected theme.
  const uis = (await css(page, '[data-testid="ui-surface-training_metrics"]', ['background-color', 'border-radius', 'font-family', 'box-shadow']))!
  assert.equal(uis['background-color'], 'rgba(0, 0, 0, 0)')
  assert.equal(uis['border-radius'], '0px')
  assert.match(uis['font-family']!, /^"Helvetica Neue"/)
  assert.equal(uis['box-shadow'], 'none')
  assert.equal((await css(page, '[data-testid="ui-surface-training_metrics"] [data-testid="ui-chart-latest"]', ['stroke']))!.stroke, VERMILION)
  assert.equal((await css(page, '[data-testid="ui-surface-training_metrics"] .uis-series.c0 .uis-series-line', ['stroke']))!.stroke, INK)
  // the small multiples line up: four plots, one baseline, whatever their legends wrap to
  const plots = await surface.locator('.uis-row > .uis-card .uis-plot').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))
  const legends = await surface.locator('.uis-row > .uis-card .uis-legend').evaluateAll((els) => els.map((e) => Math.round(e.scrollHeight)))
  assert.equal(plots.length, 4)
  assert.ok(Math.max(...plots) - Math.min(...plots) <= 1, `plot tops ${plots} (legends ${legends})`)

  // the board: the agents' timeline on Atelier's hairline frame
  const rg = (await css(page, '[data-testid="agents-board"] .rg-body', ['border-top-left-radius', 'border-top-color']))!
  assert.equal(rg['border-top-left-radius'], '8px')
  assert.equal(rg['border-top-color'], 'rgb(233, 229, 222)')
  assert.match((await css(page, '[data-testid="agents-board"]', ['font-family']))!['font-family']!, /^"Helvetica Neue"/)
  assert.match((await css(page, '[data-testid="agents-board"] .ab-label', ['font-family']))!['font-family']!, /^"Helvetica Neue"/)

  // the html surface: its frame gets the same look through the host theme's allowlisted tokens (face, radii, ink)
  const notes = await notesFrame(page)
  assert.match(notes.family, /^"Helvetica Neue"/, JSON.stringify(notes))
  assert.equal(notes.radius, '8px', JSON.stringify(notes))
  assert.equal(notes.ink, INK, JSON.stringify(notes))
  assert.equal(notes.scheme, 'light')

  // a card: the app's card radius, Atelier's ring; its title says the name and the state; the model steps out only when narrow
  await page.locator('[data-testid="agents-board"] .rg-lane-name.opens').first().click()
  const card = page.locator('.desk-win.kind-run, .desk-win[data-testid^="card-"]').first()
  await card.waitFor({ timeout: 15_000 })
  const win = (await css(page, '.desk-win', ['border-top-left-radius', 'background-color', 'font-family']))!
  assert.equal(win['border-top-left-radius'], '14px')
  assert.equal(win['background-color'], 'rgb(255, 255, 255)')
  assert.match(win['font-family']!, /^"Helvetica Neue"/)
  const subShown = (w: number) => page.evaluate((width) => {
    const el = [...document.querySelectorAll<HTMLElement>('.desk-win')].find((e) => e.querySelector('.desk-sub'))
    if (!el) return null
    const was = el.style.width
    el.style.transition = 'none'   // the card's width eases; the test reads the width it is set to
    el.style.width = `${width}px`
    const sub = el.querySelector('.desk-sub')!
    const shown = getComputedStyle(sub).display !== 'none'
    const word = getComputedStyle(el.querySelector('.desk-word')!).display !== 'none'
    el.style.width = was
    el.style.transition = ''
    return { shown, word }
  }, w)
  assert.deepEqual(await subShown(300), { shown: false, word: true }, 'a narrow card: the name and the state word, the model out')
  assert.deepEqual(await subShown(460), { shown: true, word: true }, 'a wide card keeps the model')

  // the Agent Teams outline: a row behind the selected one stays legible
  await showTeams(page)
  const nodes = page.locator('[data-testid="graph-dock"] .ol-node:not(.folder)')
  await nodes.first().waitFor()
  if (await page.locator('[data-testid="graph-dock"] .ol-node.dim').count() === 0) await nodes.first().click()
  await page.waitForSelector('[data-testid="graph-dock"] .ol-node.dim', { timeout: 10_000 })
  assert.equal((await css(page, '[data-testid="graph-dock"] .ol-node.dim', ['opacity']))!.opacity, '0.74')
  assert.equal((await css(page, '[data-testid="graph-dock"] .ol-node', ['height']))!.height, '24px', 'the outline row keeps its 24px (virtualised)')
  assert.equal((await css(page, '[data-testid="graph-dock"] .desk-title', ['height']))!.height, '34px', 'the card title keeps its 34px')
  // the choice is kept: the app opened again draws Claude from its first paint (no light frame before it)
  await recordThemes(page)
  await page.reload()
  await page.waitForSelector('[data-testid="ui-surface-training_metrics"] [data-testid="ui-chart-latest"]', { timeout: 30_000 }).catch(() => undefined)
  assert.deepEqual(await themesSeen(page), { seen: ['claude'], atBody: 'claude' }, 'the root took claude once, before the body stood')
  assert.equal(await page.evaluate(() => localStorage.getItem('oasis-code.theme')), 'claude')
  assert.deepEqual(errors, [])
  await context.close()
})

test('atelier app: the default is the neutral light palette — no Atelier warmth on the page, the surface, the board or the frame', { timeout: 90_000 }, async () => {
  assert.ok(sid, 'the first test made the session')
  // a fresh profile, the system dark: still light (light is the default; System is a choice, not the default)
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'dark' })
  const page = await context.newPage()
  await recordThemes(page)
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.click(`[data-testid="session-${sid}"]`)
  await page.waitForSelector('[data-testid="ui-surface-training_metrics"] [data-testid="ui-chart-latest"]', { timeout: 30_000 })
  assert.deepEqual(await themesSeen(page), { seen: ['light'], atBody: 'light' })
  assert.equal(await page.evaluate(() => localStorage.getItem('oasis-code.theme')), null, 'nothing written for a default')
  const served = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement), uis = getComputedStyle(document.querySelector('.uis')!)
    const v = (st: CSSStyleDeclaration, n: string) => st.getPropertyValue(n).trim()
    return { scheme: root.colorScheme, page: v(root, '--page'), ink: v(root, '--ink'), line: v(root, '--line'), accent: v(root, '--accent'), uisLatest: v(uis, '--uis-latest'), uisAccent: v(uis, '--accent'), agentLive: v(uis, '--agent-live') }
  })
  // the 126e2ca values (the build's minifier may write the same oklch as `oklch(62.6% .205 254.947)`: compared as numbers)
  const ok = (v: string) => { const m = /^oklch\(([\d.]+)(%?) ([\d.]+) ([\d.]+)\)$/.exec(v); return m ? [Number(m[1]) / (m[2] ? 100 : 1), Number(m[3]), Number(m[4])].map((n) => n.toFixed(4)).join(' ') : v }
  const norm = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, ok(v)]))
  const accent = 'oklch(0.626 0.205 254.947)'
  assert.deepEqual(norm(served), norm({ scheme: 'light', page: 'oklch(0.985 0.001 286.376)', ink: LIGHT_INK, line: 'oklch(0.946 0.003 264.542)', accent, uisLatest: '', uisAccent: accent, agentLive: '' }))
  const uis = (await css(page, '[data-testid="ui-surface-training_metrics"]', ['color', 'font-family', 'box-shadow', 'border-radius']))!
  assert.equal(uis.color, await page.evaluate((l) => { const el = document.createElement('div'); el.style.color = l; document.body.append(el); const v = getComputedStyle(el).color; el.remove(); return v }, LIGHT_INK))
  assert.equal(uis['box-shadow'], 'none', 'no outer shadow in either theme')
  assert.match(uis['font-family']!, /^"Helvetica Neue"/, 'the components keep their face in every theme')
  assert.equal(uis['border-radius'], '0px', 'no outer card in either theme')
  assert.notEqual((await css(page, '[data-testid="ui-surface-training_metrics"] [data-testid="ui-chart-latest"]', ['stroke']))!.stroke, VERMILION)
  assert.notEqual((await css(page, '[data-testid="ui-surface-training_metrics"] .uis-series.c0 .uis-series-line', ['stroke']))!.stroke, INK)
  assert.notEqual((await css(page, '[data-testid="agents-board"] .rg-body', ['border-top-color']))!['border-top-color'], WARM_LINE)
  const notes = await notesFrame(page)
  assert.equal(notes.scheme, 'light', JSON.stringify(notes))
  assert.notEqual(notes.ink, INK, 'the frame\'s ink is the neutral one')
  assert.doesNotMatch(notes.cellLine, /233, 229, 222/)
  await context.close()
})

test('atelier app: Dark, or System on a dark system, keeps the app\'s dark ramp; a running frame follows a change made in Settings in place', { timeout: 90_000 }, async () => {
  assert.ok(sid, 'the first test made the session')
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'dark' })
  const page = await context.newPage()
  await page.goto(`${BASE}/?token=${info.token}`)
  await chooseTheme(page, 'system')
  await page.click(`[data-testid="session-${sid}"]`)
  await page.waitForSelector('[data-testid="ui-surface-training_metrics"] [data-testid="ui-chart-latest"]', { timeout: 30_000 })
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
  assert.equal(await page.evaluate(() => localStorage.getItem('oasis-code.theme')), 'system', 'System is kept as System, never as what it resolved to')
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark')
  const uis = (await css(page, '[data-testid="ui-surface-training_metrics"]', ['background-color', 'font-family']))!
  assert.notEqual(uis['background-color'], 'rgb(255, 255, 255)')
  assert.match(uis['font-family']!, /^"Helvetica Neue"/, 'the face and radii are the components\' in every theme')
  assert.notEqual((await css(page, '[data-testid="ui-surface-training_metrics"] [data-testid="ui-chart-latest"]', ['stroke']))!.stroke, VERMILION)
  assert.notEqual((await css(page, '[data-testid="agents-board"] .rg-body', ['background-color']))!['background-color'], 'rgb(255, 255, 255)')
  const notes = await notesFrame(page)
  assert.equal(notes.scheme, 'dark', JSON.stringify(notes))
  assert.match(notes.family, /^"Helvetica Neue"/, JSON.stringify(notes))
  assert.notEqual(notes.ink, INK, 'the frame\'s ink is the dark ramp\'s')
  // the system goes light: System follows, and the running frame with it, its document the same
  const frameEl = page.locator('[data-testid="ui-surface-run_notes"] [data-testid="intelligent-html-frame"]').first()
  const srcdoc = await frameEl.getAttribute('srcdoc')
  const frame = page.locator('[data-testid="ui-surface-run_notes"]').first().frameLocator('[data-testid="intelligent-html-frame"]')
  const frameScheme = () => frame.locator('body').evaluate(() => getComputedStyle(document.documentElement).colorScheme)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await expectSoon(frameScheme, 'light')
  // Claude chosen in Settings while it runs: the frame takes Atelier's ink in place; the system then changes nothing
  await chooseTheme(page, 'claude')
  await expectSoon(() => frame.locator('body').evaluate(() => getComputedStyle(document.body).color), INK)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(300)
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'claude', 'an explicit choice is not the system\'s to change')
  assert.equal(await frameScheme(), 'light')
  // Dark chosen: the dark ramp, the same document all along
  await chooseTheme(page, 'dark')
  await expectSoon(frameScheme, 'dark')
  assert.equal(await frameEl.getAttribute('srcdoc'), srcdoc, 'the frame was never rebuilt')
  await context.close()
})

async function expectSoon<T>(read: () => Promise<T>, want: T, ms = 5_000) {
  const end = Date.now() + ms
  let got = await read()
  while (got !== want && Date.now() < end) { await sleep(100); got = await read() }
  assert.equal(got, want)
}
