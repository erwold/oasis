import { bypassDirector } from './agent-entry.ts'
/** A chart read from a file a training script keeps appending to, end to end in the real app.
 *
 *  What runs: the real backend (createApp — RunManager, the tools, SQLite, REST, SSE — and the built UI from
 *  frontend/dist), started by backend-ts/scripts/file_chart_e2e_server.ts on OASIS_CODE_E2E_PORT with a fresh temporary
 *  data directory; a separate headless Chrome with its own temporary profile (OASIS_CODE_E2E_BROWSER names a Chromium
 *  executable; without it, channel chrome), recording a video of the page; and a real writer process (python3) that
 *  appends JSON Lines to a file in the session's working folder, burst after burst, for tens of seconds — far past the
 *  inline chart's 2048 points and the spec's 100,000 characters, and past 2 MiB.
 *
 *  The "model" is SCRIPTED: its one present_ui call is a real tool call through the real loop (the server's script),
 *  made once, before the file has any line; the run ends there. Every point the chart shows afterwards is read by the
 *  app from the file (GET …/sources/:element_id), never through the model or a new revision — the test checks the
 *  surface stays at revision 1 and the session has that one run.
 *
 *  What is measured while the writer writes (not only at the end): the chart's latest step, seen moving several times;
 *  its points and what it draws (bounded by the plot's width); the page's frames (requestAnimationFrame gaps), its long
 *  tasks (PerformanceObserver), and how long a hover takes to read a raw point. At the end: the exact point count, the
 *  legend's raw latest values, the red hollow ring on the last step, both spikes (up and down) drawn and read raw on
 *  hover, the dashed validation line, and an atomic replace of the file read from its start.
 *
 *  Artifacts (screenshots, the video, the measures): OASIS_CODE_E2E_ARTIFACTS (else a temporary folder), printed. */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright-core'

let server: ChildProcess
let serverLog = ''
let info: { port: number; token: string; data: string }
let BASE = ''
let browser: Browser
const ARTIFACTS = process.env.OASIS_CODE_E2E_ARTIFACTS || mkdtempSync(join(tmpdir(), 'oasis-file-chart-artifacts-'))
mkdirSync(ARTIFACTS, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** the processes this file started (and only those are stopped by it) */
const owned: ChildProcess[] = []

before(async () => {
  server = spawn('bun', ['run', 'scripts/file_chart_e2e_server.ts'], { cwd: `${process.cwd()}/../backend-ts`, stdio: ['ignore', 'pipe', 'pipe'] })
  owned.push(server)
  info = await new Promise((resolve, reject) => {
    let buf = ''
    server.stdout!.on('data', (d) => { buf += String(d); const line = buf.split('\n')[0]!; if (buf.includes('\n') && line.trim().startsWith('{')) resolve(JSON.parse(line)) })
    server.stderr!.on('data', (d) => { serverLog = (serverLog + String(d)).slice(-20_000) })
    server.on('exit', (code) => reject(new Error(`file chart e2e server exited ${code}: ${serverLog.slice(-4_000)}`)))
  })
  BASE = `http://127.0.0.1:${info.port}`
  console.info(`e2e app port: ${info.port}`)
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/api/meta/build`)).ok) break } catch { /* not yet */ } await sleep(100) }
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  browser = await chromium.launch(executablePath ? { executablePath, headless: true, args: ['--no-sandbox'] } : { channel: 'chrome', headless: true })
})

after(async () => {
  await browser?.close()
  for (const p of owned) {
    if (p.exitCode !== null || p.signalCode !== null) continue
    const exited = new Promise((r) => p.once('exit', r))
    p.kill('SIGTERM')
    await Promise.race([exited, sleep(10_000)])
  }
})

async function api<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { headers: { 'x-oasis-code-token': info.token } })
  assert.equal(r.status, 200, path)
  return r.json() as Promise<T>
}
async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, ms = 60_000): Promise<T> {
  const end = Date.now() + ms
  let v = await read()
  while (!ok(v)) {
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v).slice(0, 1000)}`)
    await sleep(100)
    v = await read()
  }
  return v
}

/** The training script: appends one record per step in bursts (flushed whole lines), a validation loss every 100 steps,
 *  an upward spike at SPIKE_UP and a downward one at SPIKE_DOWN, an explicit null (a gap) at GAP; prints DONE and the
 *  exact last values when it is through. Deterministic (seeded), so the test knows each value. */
const STEPS = 26_000, BURST = 65, EVERY_MS = 100, SPIKE_UP = 7_777, SPIKE_DOWN = 15_555, GAP = 20_000
const WRITER = String.raw`
import json, math, random, sys, time
path, steps, burst, every = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4]) / 1000
up, down, gap = int(sys.argv[5]), int(sys.argv[6]), int(sys.argv[7])
rnd = random.Random(1234)
last = {}
with open(path, 'a', encoding='utf-8') as f:
    for start in range(0, steps, burst):
        lines = []
        for i in range(start, min(steps, start + burst)):
            loss = 2.5 * math.exp(-i / 8000) + 0.3 + 0.05 * math.sin(i / 37) + rnd.uniform(-0.02, 0.02)
            if i == up: loss = 25.0
            if i == down: loss = -20.0
            rec = {'step': i, 'loss': None if i == gap else round(loss, 9), 'lr': round(3e-4 * min(1, i / 2000) * math.cos(i / steps), 12),
                   'grad_norm': round(1 + rnd.random(), 6), 'tokens': i * 4096, 'note': 'warmup' if i < 2000 else 'train'}
            if i % 100 == 0: rec['val_loss'] = round(loss + 0.1 + rnd.uniform(0, 0.01), 9)
            lines.append(json.dumps(rec) + '\n')
            if rec['loss'] is not None: last['loss'] = (i, rec['loss'])
            if 'val_loss' in rec: last['val'] = (i, rec['val_loss'])
        f.write(''.join(lines)); f.flush()
        time.sleep(every)
print('DONE ' + json.dumps({'loss': last['loss'], 'val': last['val']}), flush=True)
`

/** The page's own frames (Chrome's screencast of this headless page — never the screen), encoded with a system
 *  ffmpeg when there is one; else the frames stay as JPEGs. */
async function screencast(page: Page): Promise<{ stop: () => Promise<string> }> {
  const dir = join(ARTIFACTS, 'file-chart-frames')
  mkdirSync(dir, { recursive: true })
  const cdp = await page.context().newCDPSession(page)
  const frames: { file: string; at: number }[] = []
  cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    const file = join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`)
    writeFileSync(file, Buffer.from(f.data, 'base64'))
    frames.push({ file, at: f.metadata.timestamp ?? Date.now() / 1000 })
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined)
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1440, maxHeight: 1000, everyNthFrame: 2 })
  return {
    stop: async () => {
      await cdp.send('Page.stopScreencast').catch(() => undefined)
      if (frames.length < 2) return dir
      const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.02, Math.min(2, (frames[i + 1]?.at ?? f.at + 0.1) - f.at)).toFixed(3)}`).join('\n') + `\nfile '${frames.at(-1)!.file}'\n`
      const listFile = join(dir, 'frames.txt')
      writeFileSync(listFile, list)
      const out = join(ARTIFACTS, 'file-chart-live.mp4')
      try {
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-pix_fmt', 'yuv420p', '-fps_mode', 'vfr', out])
        return out
      } catch { return dir }
    },
  }
}

interface Sample { t: number; latest: number | null; points: number; drawn: number; marks: number; plotW: number; svgNodes: number; status: string | null }
const sample = (page: Page, t0: number): Promise<Sample> => page.evaluate((t0) => {
  const fig = document.querySelector('[data-testid="ui-surface-training"] [data-testid="ui-chart-series"]')
  const n = (k: string) => Number(fig?.getAttribute(k) ?? 0)
  return { t: Date.now() - t0, latest: fig?.hasAttribute('data-latest-x') ? n('data-latest-x') : null, points: n('data-points'), drawn: n('data-drawn'), marks: n('data-marks'),
    plotW: n('data-plot-width'), svgNodes: fig?.querySelector('.uis-plot svg')?.querySelectorAll('*').length ?? 0, status: fig?.getAttribute('data-source-status') ?? null }
}, t0)

/** a pointer move over the plot at `frac` of its width: ms until the cursor shows a raw point there (or -1) */
const hoverLatency = (page: Page, frac: number): Promise<number> => page.evaluate((frac) => new Promise<number>((resolve) => {
  const fig = document.querySelector('[data-testid="ui-surface-training"] [data-testid="ui-chart-series"]')!
  const svg = fig.querySelector('.uis-plot svg')!
  const r = svg.getBoundingClientRect()
  // the plot's own origin: the svg's left plus the room the y axis' words take (never the words' box)
  const g = { left: r.left + Number(fig.getAttribute('data-plot-left')), top: r.top }
  const plotW = Number(fig.getAttribute('data-plot-width'))
  // the pointer leaves first (the cursor goes), then comes in at frac: timed from the move to the raw point shown
  svg.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
  const start = () => {
    if (fig.getAttribute('data-cursor') !== null) return requestAnimationFrame(start)
    const t = performance.now()
    svg.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: g.left + plotW * frac, clientY: g.top + 40 }))
    const check = () => {
      if (fig.getAttribute('data-cursor') !== null) {
        const took = performance.now() - t
        // and leaves again: the legend goes back to the latest values
        svg.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
        return resolve(took)
      }
      if (performance.now() - t > 2000) return resolve(-1)
      requestAnimationFrame(check)
    }
    check()
  }
  requestAnimationFrame(start)
}), frac)

test('a training log appended for 26,000 steps: the chart follows the file, bounded, responsive, exact', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const recording = await screencast(page)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const sourceRequests: { offset: number; verify: boolean; at: number }[] = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.pathname.includes('/sources/')) sourceRequests.push({ offset: Number(u.searchParams.get('offset')), verify: u.searchParams.get('verify') === '1', at: Date.now() })
  })
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]', { timeout: 30_000 })
  if (await page.locator('[data-testid="folder-clear"]').count()) await page.click('[data-testid="folder-clear"]')
  await bypassDirector(page)
  await page.fill('[data-testid="composer"]', 'chart train/metrics.jsonl')
  await page.click('[data-testid="send"]')
  await page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
  const sid = (await page.locator('[aria-current="page"][data-testid^="session-"]').getAttribute('data-testid'))!.slice('session-'.length)
  const surface = page.locator('[data-testid="thread"] [data-testid="ui-surface-training"]')
  await surface.waitFor({ timeout: 30_000 })
  // the floating cards (the workspace's) shelved: the chart is seen whole in the screenshots and the video
  for (let i = 0; i < 4 && (await page.locator('[data-testid="card-shelve"]').count()); i += 1) await page.locator('[data-testid="card-shelve"]').first().click()
  // the run that presented it has ended before the file has a single line
  const detail = await until('the run ends', () => api<{ runs: { id: string; status: string }[]; workspace_id: string }>(`/api/sessions/${sid}`), (d) => d.runs.length === 1 && d.runs[0]!.status === 'done')
  const ws = await api<{ path: string }>(`/api/workspaces/${detail.workspace_id}`)
  const status = () => page.locator('[data-testid="ui-surface-training"]').evaluate((el) => ({
    status: el.querySelector('[data-testid="ui-chart-series"]')?.getAttribute('data-source-status') ?? null,
    note: el.querySelector('[data-testid="ui-chart-source-status"]')?.textContent ?? null, valid: el.getAttribute('data-valid'), text: (el.textContent ?? '').slice(0, 300),
  }))
  await until('the chart waits for its file', status, (v) => v.status === 'missing', 15_000)

  // the page's frames and long tasks, from now on
  await page.evaluate(() => {
    const w = window as unknown as { __perf: { longtasks: number[]; gaps: number[] } }
    w.__perf = { longtasks: [], gaps: [] }
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__perf.longtasks.push(e.duration) }).observe({ type: 'longtask', buffered: false }) } catch { /* not supported */ }
    let last = performance.now()
    const frame = (t: number) => { w.__perf.gaps.push(t - last); last = t; requestAnimationFrame(frame) }
    requestAnimationFrame(frame)
  })

  mkdirSync(join(ws.path, 'train'), { recursive: true })
  const file = join(ws.path, 'train/metrics.jsonl')
  const writerScript = join(ARTIFACTS, 'train_writer.py')
  writeFileSync(writerScript, WRITER)
  const writer = spawn('python3', [writerScript, file, String(STEPS), String(BURST), String(EVERY_MS), String(SPIKE_UP), String(SPIKE_DOWN), String(GAP)], { stdio: ['ignore', 'pipe', 'pipe'] })
  owned.push(writer)
  let writerOut = ''
  writer.stdout!.on('data', (d) => { writerOut += String(d) })
  writer.stderr!.on('data', (d) => { writerOut += String(d) })
  const writerDone = new Promise<number>((r) => writer.once('exit', (code) => r(code ?? -1)))
  const t0 = Date.now()

  // while it writes: the latest step moves, again and again; what is drawn stays bounded; a hover reads a raw point
  const samples: Sample[] = []
  const hovers: number[] = []
  let midShot = false
  let exited: number | null = null
  let writerEndedAt = 0
  void writerDone.then((c) => { writerEndedAt = Date.now(); exited = c })
  while (exited === null) {
    await sleep(1000)
    const s = await sample(page, t0)
    samples.push(s)
    if (samples.length % 2 === 0) hovers.push(await hoverLatency(page, 0.2 + 0.6 * Math.random()))
    await page.mouse.move(5, 5)
    if (!midShot && (s.latest ?? 0) > STEPS / 2) {
      midShot = true
      await surface.screenshot({ path: join(ARTIFACTS, 'file-chart-mid-write.png') })
    }
    if (Date.now() - t0 > 180_000) throw new Error(`the writer is still writing after 180 s: ${writerOut.slice(-2000)}`)
  }
  // the page's frames and long tasks while the writer wrote, frozen as soon as it is through (nothing after it counts)
  const perf = await page.evaluate(() => { const p = (window as unknown as { __perf: { longtasks: number[]; gaps: number[] } }).__perf; return { longtasks: [...p.longtasks], gaps: [...p.gaps] } })
  const writeSeconds = (writerEndedAt - t0) / 1000
  assert.equal(exited, 0, writerOut)
  const done = JSON.parse(/DONE (.*)/.exec(writerOut)![1]!) as { loss: [number, number]; val: [number, number] }
  const latestSeen = [...new Set(samples.map((s) => s.latest).filter((x): x is number => x !== null))]
  assert.ok(latestSeen.length >= 8, `the latest step moved while the file grew: ${latestSeen.join(', ')}`)
  assert.ok(latestSeen.every((x, i) => i === 0 || x > latestSeen[i - 1]!), 'it only moves forward')
  for (const s of samples) {
    if (!s.plotW) continue
    assert.ok(s.drawn <= s.plotW * 10 * 2 + 20, `drawn ${s.drawn} for ${s.points} points in ${s.plotW} px`)
    assert.ok(s.svgNodes < 200, `svg nodes ${s.svgNodes} for ${s.points} points`)
  }
  const grown = samples.filter((s) => s.points > 2048)
  assert.ok(grown.length > 3, 'measured past the inline bound while writing')

  // the end: every point, exact (no cursor: the legend reads each series' latest)
  const fig = page.locator('[data-testid="ui-surface-training"] [data-testid="ui-chart-series"]')
  await until('no cursor', () => fig.getAttribute('data-cursor'), (c) => c === null, 5_000)
  await until('the last step drawn', () => fig.getAttribute('data-latest-x'), (x) => x === String(STEPS - 1), 30_000)
  const valCount = Math.ceil(STEPS / 100)
  assert.equal(await fig.getAttribute('data-points'), String(STEPS + valCount))
  const legend = await page.locator('[data-testid="ui-surface-training"] [data-testid="ui-chart-value"]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-x'), e.getAttribute('data-value')]))
  assert.deepEqual(legend, [[String(done.loss[0]), String(done.loss[1])], [String(done.val[0]), String(done.val[1])]], 'the raw latest of each series')
  const ring = page.locator('[data-testid="ui-surface-training"] g[data-series="loss"] [data-testid="ui-chart-latest"]')
  assert.equal(await ring.getAttribute('data-x'), String(STEPS - 1))
  const ringStyle = await ring.evaluate((el) => { const cs = getComputedStyle(el); return { stroke: cs.stroke, fill: cs.fill } })
  // the default Light theme: the ring is its series' own colour; Claude (chosen in Settings) rings it in vermilion
  const lineStroke = await page.locator('[data-testid="ui-surface-training"] g[data-series="loss"] path').first().evaluate((el) => getComputedStyle(el).stroke)
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
  assert.equal(ringStyle.stroke, lineStroke, 'light: the latest ring is the series colour')
  assert.notEqual(ringStyle.stroke, 'rgb(226, 64, 31)', 'light: no Atelier vermilion')
  assert.notEqual(ringStyle.fill, ringStyle.stroke, 'hollow')
  await page.click('[data-testid="settings"]')
  await page.click('[data-testid="settings-tab-appearance"]')
  await page.click('[data-testid="theme-claude"]')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="settings-dialog"]', { state: 'detached' })
  const claudeRing = await ring.evaluate((el) => { const cs = getComputedStyle(el); return { stroke: cs.stroke, fill: cs.fill } })
  assert.equal(claudeRing.stroke, 'rgb(226, 64, 31)', 'claude: the latest ring is red')
  assert.notEqual(claudeRing.fill, claudeRing.stroke, 'hollow')
  assert.equal(await page.locator('[data-testid="ui-surface-training"] g[data-series="val"]').getAttribute('data-style'), 'dashed')
  assert.ok(await page.locator('[data-testid="ui-surface-training"] g[data-series="val"] path').evaluate((p) => p.getAttribute('stroke-dasharray')), 'the validation line is dashed')
  // both spikes are drawn: the path reaches the highest and the lowest value's places
  const ys = await page.locator('[data-testid="ui-surface-training"] g[data-series="loss"] path').evaluate((p) => (p.getAttribute('d')!.match(/[ML]-?[\d.]+ -?[\d.]+/g) ?? []).map((m) => Number(m.split(' ')[1])))
  assert.ok(Math.min(...ys) < 12, `the upward spike is drawn (top y ${Math.min(...ys)})`)
  assert.ok(Math.max(...ys) > 136, `the downward spike is drawn (bottom y ${Math.max(...ys)})`)
  // a hover reads the raw spike: the pointer to its column, then the arrow keys to its very step
  const readAt = async (step: number): Promise<{ x: string | null; value: string | null }> => {
    const geo = await fig.evaluate((f) => { const r = f.querySelector('.uis-plot svg')!.getBoundingClientRect(); return { plotW: Number(f.getAttribute('data-plot-width')), left: r.left + Number(f.getAttribute('data-plot-left')), top: r.top } })
    await page.mouse.move(geo.left + (step / (STEPS - 1)) * geo.plotW, geo.top + 60)
    await until('a cursor', () => fig.getAttribute('data-cursor'), (c) => c !== null, 5_000)
    let at = Number(await fig.getAttribute('data-cursor'))
    await fig.locator('.uis-plot').evaluate((el) => (el as HTMLElement).focus())
    for (let k = 0; k < 80 && at !== step; k += 1) {
      await page.keyboard.press(at < step ? 'ArrowRight' : 'ArrowLeft')
      at = Number(await fig.getAttribute('data-cursor'))
    }
    const v = page.locator('[data-testid="ui-surface-training"] li[data-series="loss"] [data-testid="ui-chart-value"]')
    return { x: await v.getAttribute('data-x'), value: await v.getAttribute('data-value') }
  }
  // an ordinary step the drawing does not keep (not the first, last, lowest or highest of its pixel column): a pointer
  // at its exact place reads it raw from the file — the hover never reads only what is drawn
  const raw = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { step: number; loss: number | null })
  const plotW = Number(await fig.getAttribute('data-plot-width'))
  const colOf = (step: number) => Math.floor(Math.round((step / (STEPS - 1)) * plotW * 100) / 100)
  const ordinary = (() => {
    for (let s = 12_000; s < 13_000; s += 1) {
      const col = raw.filter((r) => colOf(r.step) === colOf(s) && r.loss !== null)
      if (col.length < 6) continue
      const ys = col.map((r) => r.loss!)
      const kept = new Set([col[0]!.step, col.at(-1)!.step, col[ys.indexOf(Math.min(...ys))]!.step, col[ys.indexOf(Math.max(...ys))]!.step])
      if (!kept.has(s) && raw[s]!.loss !== null) return s
    }
    throw new Error('no ordinary step found')
  })()
  const exact = await fig.evaluate((f, { step, steps }) => {
    const svg = f.querySelector('.uis-plot svg')!
    const r = svg.getBoundingClientRect()
    const x = r.left + Number(f.getAttribute('data-plot-left')) + (step / (steps - 1)) * Number(f.getAttribute('data-plot-width'))
    svg.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: r.top + 60 }))
    return new Promise<{ cursor: string | null; x: string | null; value: string | null }>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const v = f.querySelector('li[data-series="loss"] [data-testid="ui-chart-value"]')
      resolve({ cursor: f.getAttribute('data-cursor'), x: v?.getAttribute('data-x') ?? null, value: v?.getAttribute('data-value') ?? null })
    })))
  }, { step: ordinary, steps: STEPS })
  assert.deepEqual(exact, { cursor: String(ordinary), x: String(ordinary), value: String(raw[ordinary]!.loss) }, `the raw point at step ${ordinary}`)
  await page.mouse.move(5, 5)
  assert.deepEqual(await readAt(SPIKE_DOWN), { x: String(SPIKE_DOWN), value: '-20' })
  assert.deepEqual(await readAt(SPIKE_UP), { x: String(SPIKE_UP), value: '25' })
  await surface.screenshot({ path: join(ARTIFACTS, 'file-chart-final-spike-hover.png') })
  await page.mouse.move(5, 5)
  await fig.locator('.uis-plot').evaluate((el) => (el as HTMLElement).blur())
  await surface.screenshot({ path: join(ARTIFACTS, 'file-chart-final-latest.png') })
  await page.screenshot({ path: join(ARTIFACTS, 'file-chart-final-page.png') })

  // never through the model: one run, one revision; the file was read forward (one generation, offsets that only grow)
  const surfaces = await api<{ surfaces: { surface_id: string; revision: number; spec: unknown }[] }>(`/api/sessions/${sid}/ui`)
  const rec = surfaces.surfaces.find((s) => s.surface_id === 'training')!
  assert.equal(rec.revision, 1)
  assert.ok(JSON.stringify(rec.spec).length < 2_000, 'the spec holds no point')
  assert.equal((await api<{ runs: unknown[] }>(`/api/sessions/${sid}`)).runs.length, 1)
  assert.equal(await fig.getAttribute('data-source-generation'), '0')
  const offsets = sourceRequests.map((r) => r.offset)
  assert.ok(offsets.every((o, i) => i === 0 || o >= offsets[i - 1]!), 'read forward, never again from the start')
  const size = readFileSync(file).length
  assert.ok(size > 2 * 1024 * 1024, `the file is past 2 MiB (${size} bytes)`)

  // the measures
  const sorted = (a: number[]) => [...a].sort((x, y) => x - y)
  const pct = (a: number[], p: number) => (a.length ? sorted(a)[Math.min(a.length - 1, Math.floor(a.length * p))]! : 0)
  const goodHovers = hovers.filter((h) => h >= 0)
  const measures = {
    steps: STEPS, file_bytes: size, write_seconds: Math.round(writeSeconds * 10) / 10, samples: samples.length, latest_seen: latestSeen.length,
    max_points_sampled: Math.max(...samples.map((s) => s.points)), max_drawn: Math.max(...samples.map((s) => s.drawn)), plot_width: samples.at(-1)!.plotW,
    max_svg_nodes: Math.max(...samples.map((s) => s.svgNodes)), source_requests: sourceRequests.length, verify_requests: sourceRequests.filter((r) => r.verify).length,
    frames: perf.gaps.length, frame_gap_p50_ms: Math.round(pct(perf.gaps, 0.5)), frame_gap_p95_ms: Math.round(pct(perf.gaps, 0.95)), frame_gap_max_ms: Math.round(Math.max(0, ...perf.gaps)),
    long_tasks: perf.longtasks.length, long_task_max_ms: Math.round(Math.max(0, ...perf.longtasks)), long_task_total_ms: Math.round(perf.longtasks.reduce((a, b) => a + b, 0)),
    hovers: hovers.length, hover_p50_ms: Math.round(pct(goodHovers, 0.5)), hover_max_ms: Math.round(Math.max(0, ...goodHovers)), hover_missed: hovers.length - goodHovers.length,
  }
  writeFileSync(join(ARTIFACTS, 'file-chart-measures.json'), JSON.stringify({ measures, samples }, null, 1))
  console.info(`FILE_CHART_MEASURES ${JSON.stringify(measures)}`)
  assert.ok(goodHovers.length >= 5 && measures.hover_missed === 0, `every hover was read: ${JSON.stringify(hovers)}`)
  assert.ok(measures.hover_max_ms < 500, `a hover reads its point within 500 ms (max ${measures.hover_max_ms})`)
  assert.ok(measures.frame_gap_p95_ms < 100, `frames keep coming while the file grows (p95 gap ${measures.frame_gap_p95_ms} ms)`)
  assert.ok(measures.long_task_max_ms < 500, `no long task over 500 ms (max ${measures.long_task_max_ms})`)

  // the file replaced by another (a rename over it): read again from its start, the old points gone
  const next = join(ws.path, 'train/metrics.next.jsonl')
  writeFileSync(next, '{"step":0,"loss":1.5}\n{"step":1,"loss":1.25,"val_loss":1.4}\n{"step":2,"loss":1.0}\n')
  renameSync(next, file)
  await until('the replaced file read', () => fig.getAttribute('data-latest-x'), (x) => x === '2', 30_000)
  assert.equal(await fig.getAttribute('data-points'), '4')
  assert.equal(await fig.getAttribute('data-source-generation'), '1')
  await surface.screenshot({ path: join(ARTIFACTS, 'file-chart-after-replace.png') })

  const video = await recording.stop()
  await context.close()
  console.info(`FILE_CHART_VIDEO ${video}`)
  console.info(`FILE_CHART_ARTIFACTS ${ARTIFACTS}`)
  assert.deepEqual(errors, [], 'no uncaught error on the page')
})
