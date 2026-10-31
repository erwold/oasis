/** Run alone after npm run build. Real isolated backend, real SSE, scripted summary, headless Chrome only. */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium, type BrowserContext } from 'playwright-core'

const base = 'http://127.0.0.1:8399'
const dist = fileURLToPath(new URL('../dist', import.meta.url))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function portFree(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE' ? resolve(false) : reject(error))
    probe.listen(8399, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-oasis-code-token': 'e2e-token', origin: base, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  assert.ok(response.ok, `${path}: ${response.status} ${text}`)
  return JSON.parse(text) as T
}

test('automatic compaction is visible outside folded work, settles in place with token counts, and replays once', { timeout: 180_000 }, async () => {
  assert.ok(existsSync(join(dist, 'index.html')), 'Build the frontend before e2e')
  const shots = process.env.OASIS_CODE_COMPACTION_ARTIFACTS || mkdtempSync(join(tmpdir(), 'compaction-shots-'))
  mkdirSync(shots, { recursive: true })
  const deadline = Date.now() + 120_000
  while (!await portFree()) {
    console.log('8399 occupied; waiting without touching its owner')
    if (Date.now() > deadline) throw new Error('8399 still busy; retry when free')
    await pause(1000)
  }
  const root = mkdtempSync(join(process.env.OASIS_CODE_E2E_TMP || tmpdir(), 'compaction-e2e-'))
  const data = join(root, 'data'), home = join(root, 'home')
  mkdirSync(data); mkdirSync(home)
  let server: ChildProcess | undefined, browser: BrowserContext | undefined
  const backendLog = join(shots, 'backend.log')
  writeFileSync(backendLog, 'COMMAND: bun run scripts/compaction_e2e_server.ts\n')
  try {
    // Fresh data/auth/HOME; remove inherited route overrides and credentials before starting the fixture.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: root, LANG: 'en_US.UTF-8',
      OASIS_CODE_E2E_ROOT: root, OASIS_CODE_DATA: data, OASIS_CODE_AUTH_DIR: data, OASIS_CODE_FRONTEND_DIST: dist }
    server = spawn('bun', ['run', 'scripts/compaction_e2e_server.ts'], { cwd: fileURLToPath(new URL('../../backend-ts', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'] })
    writeFileSync(join(shots, 'backend.pid'), `${server.pid}\n`)
    console.log(`independent backend PID=${server.pid}; artifacts=${shots}`)
    server.stderr!.on('data', (chunk) => appendFileSync(backendLog, chunk))
    await new Promise<void>((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error('Backend startup timeout')), 30_000)
      server!.stdout!.on('data', (chunk) => {
        appendFileSync(backendLog, chunk); buffer += String(chunk)
        if (buffer.split('\n').some((line) => line.startsWith('{') && line.includes('"ready":true'))) { clearTimeout(timer); resolve() }
      })
      server!.once('error', (error) => { clearTimeout(timer); reject(error) })
      server!.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Backend exited ${code}`)) })
    })
    const meta = await api<{ ui_build: string }>('/api/meta/build')
    assert.equal(meta.ui_build, JSON.parse(readFileSync(join(dist, 'build.json'), 'utf8')).ui_build)
    const project = await api<{ id: string }>('/api/projects', { no_folder: true })
    const session = await api<{ id: string }>(`/api/projects/${project.id}/sessions`, { title: 'Compaction progress', model: 'scripted:a' })
    const executablePath = process.env.OASIS_CODE_E2E_BROWSER
    browser = await chromium.launchPersistentContext(join(root, 'chrome'), { headless: true, viewport: { width: 1200, height: 850 },
      ...(executablePath ? { executablePath } : { channel: 'chrome' }) })
    const page = browser.pages()[0] ?? await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${base}/?token=e2e-token`)
    await page.getByTestId(`session-${session.id}`).click()
    await page.getByTestId('thread-composer').waitFor()
    const run = await api<{ id: string }>(`/api/sessions/${session.id}/chat`, { text: 'Inspect the folder and report when done.' })
    const turn = page.getByTestId(`run-${run.id}`)
    const row = turn.getByTestId('context-compaction')
    await row.locator('.compaction-spinner').waitFor()
    assert.equal(await row.innerText(), 'Compacting context')
    assert.equal(await row.evaluate((el) => el.closest('.work') === null), true)
    const animation = await row.locator('.compaction-spinner').evaluate((el) => getComputedStyle(el).animationName)
    assert.equal(animation, 'compaction-spin')
    // Even a user-folded work group cannot hide maintenance. Save the original DOM node to prove in-place completion.
    for (const head of await turn.locator('.work-head[aria-expanded="true"]').all()) await head.click()
    assert.equal(await row.isVisible(), true)
    await row.evaluate((el) => { Object.assign(window, { compactionNode: el }) })
    await page.screenshot({ path: join(shots, 'compaction-running.png') })
    // Reconnect while held: persisted start appears once and remains live.
    await page.reload()
    await page.getByTestId(`session-${session.id}`).click()
    await row.locator('.compaction-spinner').waitFor()
    assert.equal(await row.count(), 1)
    await row.evaluate((el) => { Object.assign(window, { compactionNode: el }) })
    const release = await fetch(`${base}/e2e/compaction-release`, { method: 'POST', headers: { authorization: 'Bearer e2e-token' } })
    assert.deepEqual(await release.json(), { released: true })
    await page.waitForSelector(`[data-testid="run-${run.id}"][data-status="done"]`)
    assert.equal(await row.count(), 1)
    assert.equal(await row.locator('.compaction-spinner').count(), 0)
    assert.equal(await row.evaluate((el) => el === (window as unknown as { compactionNode: Element }).compactionNode), true)
    const text = await row.innerText()
    assert.match(text, /^Context compacted · ~[\d,]+ → ~[\d,]+ tokens$/)
    const [before, after] = [...text.matchAll(/~([\d,]+)/g)].map((match) => Number(match[1].replaceAll(',', '')))
    assert.ok(after < before)
    for (const head of await turn.locator('.work-head[aria-expanded="true"]').all()) await head.click()
    assert.equal(await row.isVisible(), true)
    await page.screenshot({ path: join(shots, 'compaction-completed.png') })
    await page.reload()
    await page.getByTestId(`session-${session.id}`).click()
    await row.waitFor()
    assert.equal(await row.count(), 1)
    assert.equal(await row.innerText(), text)
    assert.equal(await row.locator('.compaction-spinner').count(), 0)
    await page.screenshot({ path: join(shots, 'compaction-replayed.png') })
    assert.deepEqual(errors, [])
    writeFileSync(join(shots, 'assertions.json'), JSON.stringify({ run_id: run.id, text, before, after, animation, ui_build: meta.ui_build, browser: browser.browser()?.version(), page_errors: errors }, null, 2))
  } finally {
    await browser?.close()
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>((resolve) => server!.once('exit', (code, signal) => {
        appendFileSync(backendLog, `EXIT_CODE: ${code}; SIGNAL: ${signal}; cleaned PID: ${server!.pid}\n`); resolve()
      }))
      server.kill('SIGTERM') // this child PID only, never a name/pattern or an existing port owner
      await exited
    }
    rmSync(root, { recursive: true, force: true })
  }
})
