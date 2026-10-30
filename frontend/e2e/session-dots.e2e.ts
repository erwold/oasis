/** The rail's session dots in real headless Chrome against the scripted e2e backend (backend-ts/scripts/e2e_server.ts):
 *  a background session's agent runs (blue), ends while the person reads another session (green), is opened (no dot)
 *  — every state the harness's own records produce, never a dot put into the page. The run is the scripted:steer
 *  route held at its test gate (POST /e2e/ui-release?gate=steer), so the running state lasts until the test lets it
 *  go. Then the page's marks across a restart of the browser on the same temporary profile (seen stays seen; an end
 *  while the browser was closed is green), and a fresh temporary profile (old history never turns green). The dot's
 *  colour is read in each theme (blue, green). Screenshots — the whole window and the rail cropped — of the three
 *  states go to OASIS_CODE_DOTS_SHOTS (default: a new folder under the OS temp folder, printed).
 *
 *  Run alone, after `npm run build`: OASIS_CODE_E2E_PORT=8399 node --test e2e/session-dots.e2e.ts — the backend it
 *  starts serves this checkout's frontend/dist (OASIS_CODE_FRONTEND_DIST set explicitly, whatever the shell holds).
 *  A port in use is waited for (never taken or killed). Each browser profile is a temporary folder of this test. */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { chromium, type BrowserContext, type Page } from 'playwright-core'

const PORT = Number(process.env.OASIS_CODE_E2E_PORT ?? 8399)
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = process.env.OASIS_CODE_DOTS_SHOTS || mkdtempSync(join(tmpdir(), 'oasis-dots-shots-'))
/** The UI this checkout built: the backend serves it whatever OASIS_CODE_FRONTEND_DIST the shell carries (another
 *  checkout's dist would test another build). */
const DIST = fileURLToPath(new URL('../dist', import.meta.url))
const MODEL = 'scripted:steer'
const HELD_WORDS = 'STEER_CASE_TEXT session dots'
let server: ChildProcess
let token = ''
const profiles: string[] = []
const contexts: BrowserContext[] = []

/** Whether nothing listens on the port (a listen that succeeds is closed at once). */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

before(async () => {
  mkdirSync(SHOTS, { recursive: true })
  // the port is the director's to share: wait for it, never take it from whoever holds it
  for (let i = 0; !(await portFree(PORT)); i += 1) {
    if (i % 30 === 0) console.log(`[session-dots] port ${PORT} is in use; waiting`)
    await new Promise((r) => setTimeout(r, 2000))
  }
  assert.ok(existsSync(join(DIST, 'index.html')), `no built UI at ${DIST}: run npm run build first`)
  console.log(`[session-dots] OASIS_CODE_FRONTEND_DIST=${DIST}`)
  server = spawn('bun', ['run', 'scripts/e2e_server.ts', String(PORT)], {
    cwd: fileURLToPath(new URL('../../backend-ts', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OASIS_CODE_FRONTEND_DIST: DIST },
  })
  const info = await new Promise<{ token: string }>((resolve, reject) => {
    let buf = ''
    server.stdout!.on('data', (d) => { buf += String(d); const line = buf.split('\n')[0]; if (line.trim().startsWith('{')) resolve(JSON.parse(line)) })
    server.on('exit', (code) => reject(new Error(`e2e server exited ${code}`)))
  })
  token = info.token
  let meta: { ui_build?: string | null } = {}
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/api/meta/build`); if (r.ok) { meta = await r.json() as typeof meta; break } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  // the served UI is this checkout's build
  const built = (JSON.parse(readFileSync(join(DIST, 'build.json'), 'utf8')) as { ui_build: string }).ui_build
  console.log(`[session-dots] ui_build served=${meta.ui_build} built=${built}`)
  assert.equal(meta.ui_build, built)
  console.log(`[session-dots] screenshots: ${SHOTS}`)
})

after(async () => {
  for (const c of contexts.splice(0)) await c.close().catch(() => undefined)
  server?.kill('SIGTERM')
  for (const p of profiles) rmSync(p, { recursive: true, force: true })
})

/** The harness's API from the test process, with the session token (same-origin, as the page's client). */
async function api<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-oasis-code-token': token, origin: BASE, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  assert.ok(res.ok, `${path}: ${res.status} ${text.slice(0, 200)}`)
  return JSON.parse(text) as T
}

/** Let the held scripted:steer run go (asked until it is at its gate). */
async function release(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const r = await fetch(`${BASE}/e2e/ui-release?gate=steer`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    if (((await r.json()) as { released: boolean }).released) return
    await new Promise((res) => setTimeout(res, 100))
  }
  throw new Error('the held run never reached its gate')
}

async function runEnds(runId: string): Promise<string> {
  for (let i = 0; i < 300; i += 1) {
    const { status } = await api<{ status: string }>(`/api/runs/${runId}`)
    if (!['queued', 'running'].includes(status)) return status
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`run ${runId} did not end`)
}

/** A headless Chrome on a profile folder of this test's own (a new one unless named): the page opened with the token. */
async function openBrowser(profile?: string): Promise<{ context: BrowserContext; page: Page; profile: string }> {
  const dir = profile ?? mkdtempSync(join(tmpdir(), 'oasis-dots-profile-'))
  if (!profile) profiles.push(dir)
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  const context = await chromium.launchPersistentContext(dir, {
    headless: true, viewport: { width: 1280, height: 800 },
    ...(executablePath ? { executablePath, args: ['--no-sandbox'] } : { channel: 'chrome' }),
  })
  contexts.push(context)
  const page = context.pages()[0] ?? await context.newPage()
  page.on('pageerror', (e) => { throw e })
  // the rail's activity reads the page got answered: a state is checked again only after the reads that follow it
  reads.set(page, 0)
  page.on('response', (r) => { if (r.url().includes('/api/session-activity') && r.ok()) reads.set(page, (reads.get(page) ?? 0) + 1) })
  await page.goto(`${BASE}/?token=${token}`)
  await page.waitForSelector('[data-testid="rail"]')
  return { context, page, profile: dir }
}

async function closeBrowser(context: BrowserContext): Promise<void> {
  contexts.splice(contexts.indexOf(context), 1)
  await context.close()
}

const dot = (page: Page, sessionId: string) => page.locator(`[data-testid="rail-dot-${sessionId}"]`)
async function dotState(page: Page, sessionId: string): Promise<string | null> {
  const d = dot(page, sessionId)
  return (await d.count()) ? d.getAttribute('data-dot') : null
}
async function waitDot(page: Page, sessionId: string, state: 'running' | 'unread' | null, timeout = 20_000): Promise<void> {
  await page.waitForFunction(([id, want]) => {
    const el = document.querySelector(`[data-testid="rail-dot-${id}"]`)
    return want === null ? el === null : el?.getAttribute('data-dot') === want
  }, [sessionId, state] as const, { timeout })
}

const reads = new Map<Page, number>()
/** Wait until the page has had `n` more activity answers than now (each a full read of every session's state). */
async function afterReads(page: Page, n: number): Promise<number> {
  const from = reads.get(page) ?? 0
  for (let i = 0; i < 300 && (reads.get(page) ?? 0) < from + n; i += 1) await page.waitForTimeout(100)
  const now = reads.get(page) ?? 0
  assert.ok(now >= from + n, `only ${now - from} of ${n} activity reads came`)
  return now
}

/** The session's row as the DOM has it now: its label, whether it is the open one, its dot (state, class, name, the
 *  colour and opacity the browser computes). */
async function rowState(page: Page, sessionId: string) {
  return page.evaluate((id) => {
    const button = document.querySelector(`[data-testid="session-${id}"]`)!
    const el = document.querySelector(`[data-testid="rail-dot-${id}"]`)
    const style = el ? getComputedStyle(el) : null
    return {
      label: button.textContent, current: button.getAttribute('aria-current'),
      dot: el ? { state: el.getAttribute('data-dot'), className: el.className, ariaLabel: el.getAttribute('aria-label'), background: style!.backgroundColor, width: style!.width, height: style!.height } : null,
    }
  }, sessionId)
}

/** Saturated blue and green pixels of a screenshot inside a box (decoded by the browser on a blank page). */
async function colourPixels(context: BrowserContext, png: Buffer, box: { x: number; y: number; width: number; height: number }): Promise<{ blue: number; green: number }> {
  const blank = await context.newPage()
  try {
    return await blank.evaluate(async ([b64, b]) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.width; canvas.height = img.height
      const g = canvas.getContext('2d')!
      g.drawImage(img, 0, 0)
      const data = g.getImageData(b.x, b.y, b.width, b.height).data
      let blue = 0, green = 0
      for (let i = 0; i < data.length; i += 4) {
        const [r, gg, bb] = [data[i]!, data[i + 1]!, data[i + 2]!]
        if (gg > r + 40 && gg > bb + 20) green += 1
        else if (bb > r + 60 && bb > gg + 30) blue += 1
      }
      return { blue, green }
    }, [png.toString('base64'), box] as const)
  } finally { await blank.close() }
}

/** The whole window and the rail, taken once the dot is as `want` says in the DOM; then the pixels of the session's
 *  row end are counted in the window's picture and must say the same (blue, green, or neither); the DOM, the pixels
 *  and the read count are kept beside the pictures. */
async function shoot(context: BrowserContext, page: Page, name: string, sessionId: string, want: 'running' | 'unread' | null): Promise<void> {
  await page.mouse.move(900, 400) // off the rail: a hovered row hides its dot behind the "…"
  await waitDot(page, sessionId, want)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  const before = await rowState(page, sessionId)
  const png = await page.screenshot({ path: join(SHOTS, `${name}-window.png`) })
  await page.locator('[data-testid="rail"]').screenshot({ path: join(SHOTS, `${name}-rail.png`) })
  const after = await rowState(page, sessionId)
  const row = (await page.locator(`[data-testid="session-${sessionId}"]`).boundingBox())!
  const box = { x: Math.round(row.x + row.width - 34), y: Math.round(row.y), width: 34, height: Math.round(row.height) }
  const pixels = await colourPixels(context, png, box)
  writeFileSync(join(SHOTS, `${name}-state.json`), JSON.stringify({ want, before, after, box, pixels, activity_reads: reads.get(page) ?? 0 }, null, 2))
  assert.equal(before.dot?.state ?? null, want, `${name}: the DOM before the picture`)
  assert.equal(after.dot?.state ?? null, want, `${name}: the DOM after the picture`)
  if (want === 'running') assert.ok(pixels.blue > 0 && pixels.green === 0, `${name}: ${JSON.stringify(pixels)}`)
  else if (want === 'unread') assert.ok(pixels.green > 0 && pixels.blue === 0, `${name}: ${JSON.stringify(pixels)}`)
  else assert.deepEqual(pixels, { blue: 0, green: 0 }, `${name}: no dot in the picture`)
}

/** The dot's colour in each theme: blue while running, green unread (an oklch hue, or the rgb channel that leads). */
async function themeColours(page: Page, sessionId: string): Promise<Record<string, string>> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="rail-dot-${id}"]`)!
    const root = document.documentElement
    const before = root.getAttribute('data-theme')
    const out: Record<string, string> = {}
    for (const theme of ['light', 'claude', 'dark']) {
      root.setAttribute('data-theme', theme)
      out[theme] = getComputedStyle(el).backgroundColor
    }
    if (before === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', before)
    return out
  }, sessionId)
}
function hueOf(colour: string): 'blue' | 'green' | 'other' {
  const ok = /^oklch\(\s*[\d.]+%?\s+[\d.]+\s+([\d.]+)/.exec(colour)
  if (ok) { const h = Number(ok[1]); return h > 220 && h < 290 ? 'blue' : h > 120 && h < 180 ? 'green' : 'other' }
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(colour)
  if (rgb) { const [r, g, b] = rgb.slice(1).map(Number) as [number, number, number]; return b > r && b > g ? 'blue' : g > r && g > b ? 'green' : 'other' }
  return 'other'
}

test('the rail\'s dots: running, ended unseen, seen — across a restart of the browser and on a fresh profile', async () => {
  const project = await api<{ id: string }>('/api/projects', { no_folder: true })
  const reading = await api<{ id: string }>(`/api/projects/${project.id}/sessions`, { title: 'Reading here', model: MODEL })
  const background = await api<{ id: string }>(`/api/projects/${project.id}/sessions`, { title: 'Background task', model: MODEL })
  const colours: Record<string, Record<string, string>> = {}

  const first = await openBrowser()
  const page = first.page
  // the person reads one session; the other works in the background
  await page.click(`[data-testid="session-${reading.id}"]`)
  await page.waitForSelector(`[aria-current="page"][data-testid="session-${reading.id}"]`)
  // a row's … button sits in the middle of the row, as wide a margin above as below
  const readingRow = page.locator('.rail-session-row', { has: page.locator(`[data-testid="session-${reading.id}"]`) })
  await readingRow.hover()
  const [rowBox, moreBox] = [await readingRow.boundingBox(), await page.locator(`[data-testid="session-more-${reading.id}"]`).boundingBox()]
  assert.ok(rowBox && moreBox)
  assert.ok(Math.abs((moreBox.y - rowBox.y) - (rowBox.y + rowBox.height - moreBox.y - moreBox.height)) <= 0.5, `… button off centre: ${JSON.stringify({ rowBox, moreBox })}`)
  const run1 = await api<{ id: string }>(`/api/sessions/${background.id}/chat`, { text: HELD_WORDS })

  // 1. running: blue at the row's end, no words added to the row
  await waitDot(page, background.id, 'running')
  assert.equal((await page.locator(`[data-testid="session-${background.id}"]`).innerText()).trim(), 'Background task')
  colours.running = await themeColours(page, background.id)
  for (const [theme, c] of Object.entries(colours.running)) assert.equal(hueOf(c), 'blue', `${theme}: ${c}`)
  await shoot(first.context, page, '1-running', background.id, 'running')

  // 2. ended while the person reads another session: green
  await release()
  assert.equal(await runEnds(run1.id), 'done')
  await waitDot(page, background.id, 'unread')
  colours.unread = await themeColours(page, background.id)
  for (const [theme, c] of Object.entries(colours.unread)) assert.equal(hueOf(c), 'green', `${theme}: ${c}`)
  assert.equal(await dotState(page, reading.id), null)
  await shoot(first.context, page, '2-ended-unread', background.id, 'unread')

  // 3. opened: seen, the dot goes; back to the other session it stays gone
  await page.click(`[data-testid="session-${background.id}"]`)
  await waitDot(page, background.id, null)
  await page.click(`[data-testid="session-${reading.id}"]`)
  await page.waitForSelector(`[aria-current="page"][data-testid="session-${reading.id}"]`)
  // several of the rail's reads after it was seen: none brings the dot back
  await afterReads(page, 3)
  assert.equal(await dotState(page, background.id), null)
  await shoot(first.context, page, '3-seen', background.id, null)
  await afterReads(page, 3)
  assert.equal(await dotState(page, background.id), null, 'the reads after the picture never bring the dot back')

  // a restart of the browser on the same profile: what was seen stays seen
  await closeBrowser(first.context)
  let again = await openBrowser(first.profile)
  await afterReads(again.page, 3)
  assert.equal(await dotState(again.page, background.id), null)
  await shoot(again.context, again.page, '3b-seen-after-restart', background.id, null)
  // an end while the browser is closed: green when it comes back
  await closeBrowser(again.context)
  const run2 = await api<{ id: string }>(`/api/sessions/${background.id}/chat`, { text: HELD_WORDS })
  await release()
  await runEnds(run2.id)
  again = await openBrowser(first.profile)
  await waitDot(again.page, background.id, 'unread')
  await shoot(again.context, again.page, '4-restart-unread', background.id, 'unread')
  await closeBrowser(again.context)

  // a fresh profile: the history it finds is laid as seen — no green anywhere
  const fresh = await openBrowser()
  await afterReads(fresh.page, 3)
  assert.equal(await fresh.page.locator('[data-testid^="rail-dot-"]').count(), 0)
  await closeBrowser(fresh.context)

  writeFileSync(join(SHOTS, 'colours.json'), JSON.stringify(colours, null, 2))
})
