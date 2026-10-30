/** Screenshots and a short recording of the NORMAL app in Atelier (no demo query, no in-memory adapter): the real
 *  backend from backend-ts/scripts/atelier_e2e_server.ts (scripted models: a live native surface republished every
 *  500 ms, an html surface, three separate tasks) on 127.0.0.1:8399, one headless Chrome with a fresh profile.
 *
 *      npm run build && node scripts/capture-atelier-app.ts <outdir>
 *
 *  Writes <outdir>/app-main-1440x960.png, app-board-1440x960.png, app-teams-1440x960.png, app-dark-1440x960.png, app-live-15s.mp4 (ffmpeg,
 *  from the page's CDP screencast frames) and capture.json (what was on the page at each shot). Nothing here is a measurement of
 *  speed; every number on the page is the scripted model's simulation. */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium, type Page } from 'playwright-core'
import { bypassDirector } from '../e2e/agent-entry.ts'
import { showTeams } from '../e2e/natural-language-driver.ts'

const out = resolve(process.argv[2] ?? 'atelier-captures')
mkdirSync(out, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env, OASIS_CODE_E2E_PORT: '8399', OASIS_CODE_FRONTEND_DIST: resolve('dist') }
delete env.OASIS_CODE_DATA; delete env.OASIS_CODE_PORT; delete env.OASIS_CODE_AUTH_DIR
const server = spawn('bun', ['run', 'scripts/atelier_e2e_server.ts'], { cwd: resolve('../backend-ts'), stdio: ['ignore', 'pipe', 'inherit'], env })
const info = await new Promise<{ port: number; token: string }>((ok, bad) => {
  let buf = ''
  server.stdout!.on('data', (d) => { buf += String(d); const line = buf.split('\n')[0]!; if (buf.includes('\n') && line.startsWith('{')) ok(JSON.parse(line)) })
  server.on('exit', (c) => bad(new Error(`server exited ${c}`)))
})
const BASE = `http://127.0.0.1:${info.port}`
const api = async <T>(path: string, body?: unknown): Promise<T> => {
  const r = await fetch(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-oasis-code-token': info.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`)
  return r.json() as Promise<T>
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
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const record: Record<string, unknown> = { base: BASE, entry: '/?token=…', started: new Date().toISOString() }
const errors: string[] = []
const state = (page: Page) => page.evaluate(() => ({
  url: location.pathname + location.search.replace(/token=[^&]+/, 'token=…'),
  demo: document.querySelector('.live-demo') !== null || document.documentElement.dataset.liveTheme !== undefined,
  revision: Number(document.querySelector('[data-testid="ui-surface-training_metrics"]')?.getAttribute('data-revision') ?? 0),
  agents: document.querySelector('[data-testid="agents-line"]')?.textContent ?? null,
  cards: document.querySelectorAll('.desk-win').length,
  scheme: getComputedStyle(document.documentElement).colorScheme,
}))

/** The person's own tidying, through the page's controls: every card on the desk put on the shelf (its Shelve button) */
async function shelveCards(page: Page) {
  for (let i = 0; i < 20; i++) {
    const shelve = page.locator('.desk-win [data-testid="card-shelve"]')
    if (!(await shelve.count())) return
    await shelve.first().click()
    await sleep(150)
  }
}
/** every open round of tool calls in the thread folded (its own fold button), so the thread reads as turns */
async function foldRounds(page: Page) {
  for (let i = 0; i < 40; i++) {
    const open = page.locator('.work.open > button.work-head').filter({ has: page.locator('xpath=.') })
    const inThread = await open.evaluateAll((els) => els.findIndex((e) => !e.closest('.desk-win')))
    if (inThread < 0) return
    await open.nth(inThread).click()
    await sleep(100)
  }
}
const centre = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => el.scrollIntoView({ block: 'center' }))
/** whether every chart of the metrics surface is in view and no card lies over it */
const clearView = (page: Page) => page.evaluate(() => {
  const plots = [...document.querySelectorAll('[data-testid="ui-surface-training_metrics"]')].filter((e) => !e.closest('.desk-win'))[0]?.querySelectorAll('.uis-card') ?? []
  const cards = [...document.querySelectorAll('.desk-win')].map((e) => e.getBoundingClientRect())
  const hit = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  const rects = [...plots].map((p) => p.getBoundingClientRect())
  return { charts: rects.length, inView: rects.every((r) => r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth), covered: rects.some((r) => cards.some((c) => hit(r, c))), openRounds: [...document.querySelectorAll('.work.open')].filter((e) => !e.closest('.desk-win')).length }
})
const nowClear = (page: Page) => page.evaluate(() => {
  const now = document.querySelector('[data-testid="rg-now"] text')?.getBoundingClientRect()
  if (!now) return { now: false, overlaps: 0 }
  const ticks = [...document.querySelectorAll('.rg-tick text')].map((t) => t.getBoundingClientRect())
  return { now: true, overlaps: ticks.filter((t) => t.left < now.right && now.left < t.right && t.top < now.bottom && now.top < t.bottom).length }
})

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'light' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
  await page.click('[data-testid="model-picker"]')
  await page.click('[data-testid="model-option-scripted:report"]')
  await page.fill('[data-testid="composer"]', "Summarise yesterday's training log")
  await page.click('[data-testid="send"]')
  await page.waitForSelector('[data-testid="thread-composer"]')
  const sid = (await page.locator('[aria-current="page"][data-testid^="session-"]').getAttribute('data-testid'))!.slice('session-'.length)
  for (let i = 0; i < 100; i++) { const d = await api<{ active_run: unknown }>(`/api/sessions/${sid}`); if (d.active_run === null) break; await sleep(200) }
  for (const [model, words] of [['scripted:report', 'Draft the run report from the latest eval'], ['scripted:eval', 'Evaluate checkpoint 2,000 on the held-out set'], ['scripted:data', 'Audit the next data shard for duplicates']]) {
    await dispatch(sid, model!, words!)
  }
  for (let tries = 0; ; tries++) {
    const r = await fetch(`${BASE}/api/sessions/${sid}/chat`, { method: 'POST', headers: { 'x-oasis-code-token': info.token, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Keep the training metrics on screen while the agents work', model: 'scripted:trainer' }) })
    if (r.ok) break
    if (r.status !== 409 || tries > 100) throw new Error(`chat: ${r.status} ${await r.text()}`)
    await sleep(300)
  }
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="ui-surface-training_metrics"]')?.getAttribute('data-revision') ?? 0) >= 1, null, { timeout: 60_000 })
  // the recording first: a run writes at most 60 revisions (MAX_UI_REVISIONS_PER_RUN), about 30 s at 2 a second, so
  // the clip is taken while the trainer's run is young — 15 s of the page's own frames (CDP screencast of this
  // headless Chrome, each frame held until the next one came), from the moment the curves are drawn
  const vctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'light' })
  const vpage = await vctx.newPage()
  vpage.on('pageerror', (e) => errors.push(e.message))
  await vpage.goto(`${BASE}/?token=${info.token}`)
  await vpage.click(`[data-testid="session-${sid}"]`)
  await vpage.waitForSelector('[data-testid="ui-surface-training_metrics"] [data-testid="ui-chart-latest"]')
  await shelveCards(vpage)
  await foldRounds(vpage)
  await centre(vpage, '[data-testid="ui-surface-training_metrics"]')
  await sleep(500)
  const frames: { at: number; file: string }[] = []
  const fdir = join(out, 'frames'); mkdirSync(fdir, { recursive: true })
  const cdp = await vctx.newCDPSession(vpage)
  cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    const file = join(fdir, `f${String(frames.length).padStart(5, '0')}.jpg`)
    writeFileSync(file, Buffer.from(f.data, 'base64'))
    frames.push({ at: f.metadata.timestamp ?? Date.now() / 1000, file })
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined)
  })
  const v0 = { ...(await state(vpage)), view: await clearView(vpage) }
  const vStart = Date.now()
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1440, maxHeight: 960, everyNthFrame: 1 })
  // the cadence: the surface's revision and its latest x, once a second through the clip (taken from the page)
  const cadence: { t_ms: number; revision: number; latest_x: number | null }[] = []
  for (let i = 0; i <= 15; i++) {
    const at = vStart + i * 1000
    if (at > Date.now()) await sleep(at - Date.now())
    cadence.push({ t_ms: Date.now() - vStart, ...(await vpage.evaluate(() => {
      const s = [...document.querySelectorAll('[data-testid="ui-surface-training_metrics"]')].find((e) => !e.closest('.desk-win'))
      const f = s?.querySelector<HTMLElement>('[data-testid="ui-chart-series"]')
      return { revision: Number(s?.getAttribute('data-revision') ?? 0), latest_x: f?.dataset.latestX ? Number(f.dataset.latestX) : null }
    })) })
  }
  await cdp.send('Page.stopScreencast')
  const vEnd = Date.now()
  const third = cadence.filter((c) => c.t_ms >= 10_000)
  record.cadence = { samples: cadence, last_third_advances: third.length > 1 && third.at(-1)!.revision > third[0]!.revision, revisions_in_last_third: third.length ? third.at(-1)!.revision - third[0]!.revision : 0 }
  record.video = { before: v0, after: { ...(await state(vpage)), view: await clearView(vpage) }, ms: vEnd - vStart, frames: frames.length, started: new Date(vStart).toISOString(), ended: new Date(vEnd).toISOString(), source: 'CDP Page.screencast of the normal app in headless Chrome, frames held until the next, ffmpeg libx264 30 fps' }
  await vctx.close()
  // the concat list: each frame for as long as it stood, the last one to the end of the 15 s
  const end = frames.length ? frames[0]!.at + 15 : 0
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, ((frames[i + 1]?.at ?? end) - f.at)).toFixed(4)}`).join('\n') + (frames.length ? `\nfile '${frames.at(-1)!.file}'\n` : '')
  writeFileSync(join(out, 'frames.txt'), `ffconcat version 1.0\n${list}`)
  const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(out, 'frames.txt'), '-vf', 'scale=1440:960:flags=lanczos,fps=30', '-t', '15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(out, 'app-live-15s.mp4')])
  record.ffmpeg = { status: ff.status, stderr: String(ff.stderr ?? '').slice(0, 500) }

  await page.waitForFunction(() => Number(document.querySelector('[data-testid="ui-surface-training_metrics"]')?.getAttribute('data-revision') ?? 0) >= 24, null, { timeout: 60_000 })
  await page.locator('[data-testid="ui-surface-run_notes"] [data-testid="intelligent-html-run"]').first().click()
  await page.waitForSelector('[data-testid="agents-board"]')
  // the main view: the cards on the shelf, the rounds folded, the metrics in the middle of the window
  await shelveCards(page)
  await foldRounds(page)
  await centre(page, '[data-testid="ui-surface-training_metrics"]')
  await sleep(800)
  await page.screenshot({ path: join(out, 'app-main-1440x960.png') })
  record.main = { ...(await state(page)), view: await clearView(page) }
  // the board: the session's agents on the timeline, under the thread's surfaces
  await foldRounds(page)
  await centre(page, '[data-testid="agents-board"]')
  await sleep(600)
  await page.screenshot({ path: join(out, 'app-board-1440x960.png') })
  record.board = { ...(await state(page)), now: await nowClear(page) }
  // the team: two agents' cards taken out through their lanes, the Agent Teams outline beside them
  const lanes = page.locator('[data-testid="agents-board"] .rg-lane-name.opens')
  for (let i = 1; i < Math.min(3, await lanes.count()); i++) await lanes.nth(i).click()
  await showTeams(page)
  await foldRounds(page)
  await centre(page, '[data-testid="agents-board"]')
  await sleep(1000)
  record.narrow = await page.evaluate(() => {
    const el = [...document.querySelectorAll<HTMLElement>('.desk-win')].find((e) => e.querySelector('.desk-sub'))
    if (!el) return null
    const was = el.style.width
    el.style.transition = 'none'
    el.style.width = '300px'
    const title = el.querySelector<HTMLElement>('.desk-title')!
    const r = { title: title.getBoundingClientRect().width, container: getComputedStyle(title).containerType, sub: getComputedStyle(el.querySelector('.desk-sub')!).display }
    el.style.width = was
    el.style.transition = ''
    return r
  })
  await sleep(400)
  await page.screenshot({ path: join(out, 'app-teams-1440x960.png') })
  record.teams = { ...(await state(page)), now: await nowClear(page) }
  await ctx.close()

  // dark: the same page with the system dark
  const dctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'dark' })
  const dpage = await dctx.newPage()
  dpage.on('pageerror', (e) => errors.push(e.message))
  await dpage.goto(`${BASE}/?token=${info.token}`)
  await dpage.click(`[data-testid="session-${sid}"]`)
  await dpage.waitForSelector('[data-testid="ui-surface-training_metrics"] [data-testid="ui-chart-latest"]')
  await dpage.locator('[data-testid="ui-surface-run_notes"] [data-testid="intelligent-html-run"]').first().click()
  await shelveCards(dpage)
  await foldRounds(dpage)
  await centre(dpage, '[data-testid="ui-surface-training_metrics"]')
  await sleep(1200)
  await dpage.screenshot({ path: join(out, 'app-dark-1440x960.png') })
  record.dark = { ...(await state(dpage)), view: await clearView(dpage) }
  await dctx.close()
} finally {
  record.errors = errors
  record.finished = new Date().toISOString()
  writeFileSync(join(out, 'capture.json'), JSON.stringify(record, null, 2))
  await browser.close()
  server.kill('SIGTERM')
}
console.log(JSON.stringify(record, null, 2))
