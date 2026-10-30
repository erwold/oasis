#!/usr/bin/env node
/* Captures the live UI demo (?demo=live-ui) from the built UI (frontend/dist): screenshots, a 15 s recording per skin,
 * and what the page measured while it ran. Nothing of the app's backend runs: the script serves dist itself on a free
 * loopback port (never 8321-8324 or 8399), answers every /api request 503 and records it, and drives a headless
 * Chrome (playwright-core, channel chrome) with a fresh temporary profile. No system screenshot, no user profile.
 *
 *   node scripts/capture-live-ui.mjs --out <dir> [--themes atelier,signal] [--seconds 15] [--warm 12] [--no-video] [--package]
 *
 * Writes into <dir>: <theme>-1440x960.png (paused at the same step for every skin), <theme>-agents-1440x960.png,
 * <theme>-1280x800.png, <theme>-390.png (full page), <theme>-15s.mp4, measurements.json, and with --package a
 * <file>.b64.txt (base64, 120 columns) beside every png/mp4 and manifest.json (absolute path, bytes, sha256).
 * Exit 1 when a check failed (chart SVGs remounted, the run did not move, overflow, a page error, an /api request).
 *
 * What is measured, and what it is not:
 * - frames: requestAnimationFrame callback intervals and Long Task entries over 10 s — how often the browser gave the
 *   page a frame and how many tasks ran over 50 ms. Not React commit time, not chart redraw time, not an FPS claim.
 * - mutations: DOM mutation records (MutationObserver) a second — how much of the page changes while data moves; with
 *   the page visible, and with document.visibilityState emulated 'hidden' (a property override plus the event).
 * - nodes_kept: whether each chart's SVG element is the same node after 4 s of revisions (redrawn in place).
 * - reduced_motion: the running CSS animations (document.getAnimations) under prefers-reduced-motion: reduce.
 * - the recording: CDP screencast frames (JPEG q90) at the times Chrome produced them, encoded to H.264 CRF 28 on a
 *   30 fps output timeline. 30 fps is an encoding parameter, not the page's refresh rate. */

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, existsSync, statSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { join, extname, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const dist = resolve(here, '../dist')
const args = process.argv.slice(2)
const arg = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d }
const flag = (name) => args.includes(`--${name}`)
const out = resolve(arg('out', join(tmpdir(), 'live-ui-capture')))
const themes = arg('themes', 'atelier,signal').split(',')
const seconds = Number(arg('seconds', '15'))
// warm 12: the pictures stand inside an eval (one agent queued behind it, others running and done)
const warm = Number(arg('warm', '12'))
const seed = Number(arg('seed', '14'))
const video = !flag('no-video')
if (!existsSync(join(dist, 'index.html'))) { console.error('frontend/dist is missing: npm run build first'); process.exit(2) }
mkdirSync(out, { recursive: true })

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' }
const requests = []
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  requests.push({ method: req.method, path: url.pathname })
  if (url.pathname.startsWith('/api/')) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"detail":"no backend in the demo capture"}'); return }
  let file = join(dist, decodeURIComponent(url.pathname))
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html')
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})
const RESERVED = new Set([8321, 8322, 8323, 8324, 8399])
let port = 0
for (;;) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  port = server.address().port
  if (!RESERVED.has(port)) break
  await new Promise((r) => server.close(r))
}
const base = `http://127.0.0.1:${port}`
const executablePath = process.env.OASIS_CODE_E2E_BROWSER
const browser = await chromium.launch(executablePath ? { executablePath, headless: true, args: ['--no-sandbox'] } : { channel: 'chrome', headless: true })
const measurements = { started_at: new Date().toISOString(), chrome: browser.version(), base_port: port, seed, warm, definitions: 'see the header of frontend/scripts/capture-live-ui.mjs', themes: {} }
const urlOf = (theme, extra = '') => `${base}/?demo=live-ui&theme=${theme}&seed=${seed}&warm=${warm}${extra}`
const problems = []

/** what the page holds now: the run's step and revision, the points the charts were given and drew, the nodes */
const snapshot = (page) => page.evaluate(() => {
  const root = document.querySelector('[data-testid="live-demo"]')
  const metrics = document.querySelector('[data-testid="ui-surface-training_metrics"]')
  const charts = [...document.querySelectorAll('[data-testid="ui-surface-training_metrics"] [data-testid="ui-chart-series"]')].map((f) => ({
    points: Number(f.dataset.points), drawn: Number(f.dataset.drawn), marks: Number(f.dataset.marks), latest_x: Number(f.dataset.latestX),
  }))
  return {
    step: Number(root?.dataset.step), tick: Number(root?.dataset.tick), revision: Number(root?.dataset.revision), points_given: Number(root?.dataset.points), spec_chars: Number(root?.dataset.specChars),
    charts, dom_nodes: document.getElementsByTagName('*').length, metrics_nodes: metrics ? metrics.getElementsByTagName('*').length : 0,
    svg_paths: metrics ? metrics.querySelectorAll('path').length : 0, svg_circles: metrics ? metrics.querySelectorAll('circle').length : 0,
    lanes: document.querySelectorAll('[data-testid="agents-relations"] .rg-lane-name').length,
    outline_rows: document.querySelectorAll('.ol-node').length, cards: document.querySelectorAll('.live-card-slot .desk-win, [data-testid="desk"] .desk-win').length,
    running_animations: document.getAnimations().filter((a) => a.playState === 'running').length,
    overflow_x: document.documentElement.scrollWidth > window.innerWidth || (document.querySelector('.live-demo')?.scrollWidth ?? 0) > window.innerWidth,
  }
})

const frames = (page, ms) => page.evaluate((ms) => new Promise((resolve) => {
  const deltas = []
  let longTasks = 0, longTaskMs = 0
  let po = null
  try { po = new PerformanceObserver((l) => { for (const e of l.getEntries()) { longTasks++; longTaskMs += e.duration } }); po.observe({ type: 'longtask', buffered: false }) } catch { /* not supported */ }
  let last = performance.now()
  const end = last + ms
  const tick = (t) => { deltas.push(t - last); last = t; if (t < end) requestAnimationFrame(tick); else { po?.disconnect(); deltas.sort((a, b) => a - b); const q = (p) => deltas[Math.min(deltas.length - 1, Math.floor(p * deltas.length))]; resolve({ raf_callbacks: deltas.length, raf_interval_p50_ms: q(0.5), raf_interval_p95_ms: q(0.95), raf_interval_max_ms: deltas.at(-1), raf_intervals_over_50ms: deltas.filter((d) => d > 50).length, long_tasks: longTasks, long_task_ms: Math.round(longTaskMs) }) } }
  requestAnimationFrame(tick)
}), ms)

/** DOM mutation records a second over `ms`, with the page visible or (emulated) hidden */
const mutations = (page, ms, hidden) => page.evaluate(async ({ ms, hidden }) => {
  if (hidden) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  }
  let n = 0
  const mo = new MutationObserver((l) => { n += l.length })
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
  await new Promise((r) => setTimeout(r, ms))
  mo.disconnect()
  if (hidden) {
    delete document.visibilityState; delete document.hidden
    document.dispatchEvent(new Event('visibilitychange'))
  }
  return { records: n, per_second: Math.round((n / ms) * 1000) }
}, { ms, hidden })

const sameNodes = async (page, ms) => {
  await page.evaluate(() => { window.__liveSvgs = [...document.querySelectorAll('[data-testid="ui-surface-training_metrics"] svg')] })
  const r0 = await page.evaluate(() => Number(document.querySelector('[data-testid="live-demo"]').dataset.revision))
  await page.waitForTimeout(ms)
  return page.evaluate((r0) => ({ svgs_before: window.__liveSvgs.length, svgs_kept_after: window.__liveSvgs.filter((s) => s.isConnected).length, revisions_between: Number(document.querySelector('[data-testid="live-demo"]').dataset.revision) - r0 }), r0)
}

/** a recording from CDP screencast frames, encoded to H.264 */
async function record(page, file, secs) {
  const dir = `${file}.frames`
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
  const cdp = await page.context().newCDPSession(page)
  const shots = []
  cdp.on('Page.screencastFrame', async (f) => {
    const name = join(dir, `${String(shots.length).padStart(5, '0')}.jpg`)
    writeFileSync(name, Buffer.from(f.data, 'base64'))
    shots.push({ name, t: f.metadata.timestamp })
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }) } catch { /* closing */ }
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1440, maxHeight: 960, everyNthFrame: 1 })
  await page.waitForTimeout(secs * 1000 + 400)
  await cdp.send('Page.stopScreencast')
  await cdp.detach()
  if (shots.length < 2) return { error: `only ${shots.length} frames` }
  const t0 = shots[0].t, end = t0 + secs
  const used = shots.filter((s) => s.t <= end)
  const lines = ['ffconcat version 1.0']
  used.forEach((s, i) => { lines.push(`file '${s.name}'`, `duration ${Math.max(0.001, (used[i + 1]?.t ?? end) - s.t).toFixed(4)}`) })
  lines.push(`file '${used.at(-1).name}'`)
  writeFileSync(join(dir, 'list.txt'), lines.join('\n'))
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '28', '-tune', 'stillimage', '-movflags', '+faststart', '-t', String(secs), file], { stdio: 'inherit' })
  rmSync(dir, { recursive: true, force: true })
  return r.status === 0 ? { file, bytes: statSync(file).size, screencast_frames: used.length, encoder: 'libx264 CRF 28, preset slow, 30 fps output timeline' } : { error: `ffmpeg exited ${r.status}` }
}

for (const theme of themes) {
  const m = { requests_before: requests.length }
  const errors = []
  const watch = (page) => { page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) }) }
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  watch(page)
  await page.goto(urlOf(theme))
  await page.waitForSelector('[data-testid="ui-surface-training_metrics"] [data-testid="ui-chart-series"]')
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(1500)
  m.first = await snapshot(page)
  m.nodes_kept = await sameNodes(page, 4000)
  if (m.nodes_kept.svgs_before === 0 || m.nodes_kept.svgs_kept_after !== m.nodes_kept.svgs_before || m.nodes_kept.revisions_between < 4) problems.push(`${theme}: chart SVGs not kept across revisions ${JSON.stringify(m.nodes_kept)}`)
  m.frames_10s = await frames(page, 10_000)
  m.mutations_visible_3s = await mutations(page, 3000, false)
  m.mutations_hidden_3s = await mutations(page, 3000, true)
  m.after = await snapshot(page)
  if (!(m.after.step > m.first.step && m.after.revision > m.first.revision)) problems.push(`${theme}: the run did not move`)
  // the main picture: paused at the same step for every skin (the same seed and warm, paused from the first frame)
  await page.goto(urlOf(theme, '&paused=1'))
  await page.waitForSelector('[data-testid="ui-surface-training_metrics"] [data-testid="ui-chart-series"]')
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(1200)
  m.shot = await snapshot(page)
  await page.screenshot({ path: join(out, `${theme}-1440x960.png`) })
  await page.click('[data-testid="live-tab-agents"]')
  await page.waitForTimeout(1500)
  m.shot_agents = await snapshot(page)
  await page.screenshot({ path: join(out, `${theme}-agents-1440x960.png`) })
  await page.click('[data-testid="live-tab-run"]')
  for (const [w, h, name] of [[1280, 800, '1280x800'], [390, 844, '390']]) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(1000)
    m[`shot_${name}`] = await snapshot(page)
    if (m[`shot_${name}`].overflow_x) problems.push(`${theme}: overflow at ${name}`)
    await page.screenshot({ path: join(out, `${theme}-${name}.png`), fullPage: name === '390' })
  }
  await ctx.close()
  // reduced motion: the same page, how many CSS animations run
  const rctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' })
  const rpage = await rctx.newPage()
  watch(rpage)
  await rpage.goto(urlOf(theme))
  await rpage.waitForSelector('[data-testid="ui-chart-series"]')
  await rpage.waitForTimeout(2500)
  m.reduced_motion = await snapshot(rpage)
  await rctx.close()
  if (video) {
    const vctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 })
    const vpage = await vctx.newPage()
    watch(vpage)
    await vpage.goto(urlOf(theme))
    await vpage.waitForSelector('[data-testid="ui-chart-series"]')
    await vpage.evaluate(() => document.fonts.ready)
    await vpage.waitForTimeout(800)
    const s0 = await snapshot(vpage)
    m.video = await record(vpage, join(out, `${theme}-${seconds}s.mp4`), seconds)
    const s1 = await snapshot(vpage)
    Object.assign(m.video, { step_from: s0.step, step_to: s1.step, revision_from: s0.revision, revision_to: s1.revision })
    if (m.video.error) problems.push(`${theme}: video ${m.video.error}`)
    await vctx.close()
  }
  m.page_errors = errors
  if (errors.length) problems.push(`${theme}: ${errors.length} page error(s)`)
  m.api_requests = requests.slice(m.requests_before).filter((r) => r.path.startsWith('/api/'))
  if (m.api_requests.length) problems.push(`${theme}: ${m.api_requests.length} /api request(s)`)
  measurements.themes[theme] = m
}

await browser.close()
await new Promise((r) => server.close(r))
measurements.api_requests_total = requests.filter((r) => r.path.startsWith('/api/')).length
measurements.problems = problems
writeFileSync(join(out, 'measurements.json'), JSON.stringify(measurements, null, 2))

if (flag('package')) {
  const files = readdirSync(out).filter((f) => /\.(png|mp4|json|log)$/.test(f) && f !== 'manifest.json').sort()
  const manifest = { created_at: new Date().toISOString(), dir: out, files: [] }
  for (const f of files) {
    const abs = join(out, f)
    const buf = readFileSync(abs)
    const entry = { file: f, path: abs, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') }
    if (/\.(png|mp4)$/.test(f)) {
      const b64 = buf.toString('base64').replace(/(.{120})/g, '$1\n')
      writeFileSync(`${abs}.b64.txt`, b64.endsWith('\n') ? b64 : `${b64}\n`)
      entry.b64 = { path: `${abs}.b64.txt`, bytes: statSync(`${abs}.b64.txt`).size, columns: 120 }
    }
    manifest.files.push(entry)
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2))
}
console.log(JSON.stringify({ out, problems, api_requests_total: measurements.api_requests_total }, null, 1))
process.exit(problems.length ? 1 : 0)
