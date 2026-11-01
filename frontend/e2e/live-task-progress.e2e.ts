/** Real ProcessManager Python writers, real API, headless Chrome. No provider calls, private data or product ports. */
import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright-core'
import { bypassDirector } from './agent-entry.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const artifacts = process.env.OASIS_CODE_E2E_ARTIFACTS || mkdtempSync(join(tmpdir(), 'progress-audit-'))
mkdirSync(artifacts, { recursive: true })

const fullDemo = process.env.OASIS_CODE_E2E_PROGRESS_CASE !== 'fail'
test(fullDemo ? '142-second training updates after run end with zero model calls, then a batch crashes without terminal JSON' : 'batch crash and offline progress snapshot against the current build', { timeout: 240_000 }, async () => {
  const server: ChildProcess = spawn('bun', ['run', 'scripts/file_chart_e2e_server.ts'], { cwd: `${process.cwd()}/../backend-ts`, env: { ...process.env, OASIS_CODE_FRONTEND_DIST: join(process.cwd(), 'dist') }, stdio: ['ignore', 'pipe', 'pipe'] })
  const ledger: unknown[] = [{ kind: 'server', pid: server.pid }]
  let serverLog = ''
  server.stderr!.on('data', (b) => { serverLog += String(b) })
  let browser: Browser | undefined
  let page: Page | undefined
  const errors: string[] = []
  try {
    const info = await new Promise<{ port: number; token: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 20_000)
      server.once('error', (error) => { clearTimeout(timer); reject(error) })
      let text = ''
      server.stdout!.on('data', (b) => { text += String(b); if (text.includes('\n')) { try { resolve(JSON.parse(text.split('\n')[0]!)); clearTimeout(timer) } catch { /* waiting */ } } })
      server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exit ${code}: ${serverLog}`)) })
    })
    const base = `http://127.0.0.1:${info.port}`
    const api = async (path: string) => { const r = await fetch(base + path, { headers: { 'x-oasis-code-token': info.token } }); assert.equal(r.status, 200); return r.json() as Promise<any> }
    const servedBuild = await api('/build.json')
    assert.deepEqual(servedBuild, JSON.parse(readFileSync(join(process.cwd(), 'dist/build.json'), 'utf8')))
    writeFileSync(join(artifacts, 'build-identity.json'), JSON.stringify(servedBuild))
    const calls = async () => (await api('/__test/model-calls')).modelCalls as number
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.on('pageerror', (e) => errors.push(e.message))
    let sourceRequests = 0; page.on('request', (r) => { if (r.url().includes('/sources/')) sourceRequests++ })
    const measures: unknown[] = []
    for (const mode of (fullDemo ? ['train', 'fail'] as const : ['fail'] as const)) {
      await page.goto(`${base}/?token=${info.token}`)
      await page.waitForSelector('[data-testid="hero-composer"]')
      if (await page.locator('[data-testid="folder-clear"]').count()) await page.click('[data-testid="folder-clear"]')
      await bypassDirector(page)
      await page.fill('[data-testid="composer"]', `progress ${mode} train/${mode}.jsonl`)
      await page.click('[data-testid="send"]')
      await page.waitForSelector('[data-testid="thread-composer"]')
      const sid = (await page.locator('[aria-current="page"][data-testid^="session-"]').getAttribute('data-testid'))!.slice('session-'.length)
      const surface = page.locator('[data-testid="thread"] [data-testid="ui-surface-training"]')
      await surface.waitFor({ timeout: 30_000 })
      for (let i = 0; i < 4 && await page.locator('[data-testid="card-shelve"]').count(); i++) await page.locator('[data-testid="card-shelve"]').first().click()
      const progress = surface.getByTestId('ui-task-progress')
      await surface.screenshot({ path: join(artifacts, `${mode}-surface-start.png`) })
      console.info('surface-start', await surface.innerText(), 'errors', errors)
      await progress.waitFor()
      let detail = await api(`/api/sessions/${sid}`)
      for (let i = 0; i < 100 && detail.runs[0].status !== 'done'; i++) { await sleep(100); detail = await api(`/api/sessions/${sid}`) }
      assert.equal(detail.runs.length, 1); assert.equal(detail.runs[0].status, 'done')
      const running = (await api(`/api/runs/${detail.runs[0].id}`)).executions
      ledger.push(...running.map((e: any) => ({ kind: `${mode}-start`, pid: e.isolation?.root_pid, execution_id: e.id, status: e.status })))
      writeFileSync(join(artifacts, 'pids.json'), JSON.stringify(ledger, null, 2))
      const baselineCalls = await calls(), started = Date.now()
      const sample = async (name: string) => {
        await surface.screenshot({ path: join(artifacts, `${name}.png`) })
        const text = await progress.innerText()
        const m = { name, elapsed_ms: Date.now() - started, modelCalls: await calls(), baselineCalls, sourceRequests, text }
        measures.push(m); assert.equal(m.modelCalls, baselineCalls)
        writeFileSync(join(artifacts, 'measures.json'), JSON.stringify(measures, null, 2))
      }
      await sample(`${mode}-early`)
      if (mode === 'train') {
        await sleep(65_000); await sample('train-middle')
        assert.match(await progress.innerText(), /3[0-9] \/ 70/)
      }
      await page.waitForSelector(`[data-testid="ui-task-progress"][data-task-status="${mode === 'train' ? 'succeeded' : 'failed'}"]`, { timeout: 100_000 })
      await sleep(2000); await sample(mode === 'train' ? 'train-completed' : 'batch-failed')
      if (mode === 'train') { assert.match(await progress.innerText(), /70 \/ 70/); assert.match(await progress.innerText(), /checkpoint saved/) }
      else { assert.equal(await surface.getByTestId('ui-chart-series').count(), 0); assert.match(await progress.innerText(), /exit 7/) }
      const stopAt = sourceRequests; await sleep(3000); assert.equal(sourceRequests, stopAt, 'terminal feed stops')
      const final = await api(`/api/sessions/${sid}`)
      assert.equal(final.runs.length, 1)
      const surfaces = await api(`/api/sessions/${sid}/ui`)
      assert.equal(surfaces.surfaces[0].revision, 1)
      const executions = (await api(`/api/runs/${final.runs[0].id}`)).executions
      assert.equal(executions.length, 1)
      for (const e of executions) {
        const pid = e.isolation?.root_pid
        let alive = false
        if (pid) { try { execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid=']); alive = true } catch { /* finished */ } }
        ledger.push({ kind: mode, execution_id: e.id, pid, status: e.status, exit_code: e.exit_code, alive })
        assert.equal(alive, false)
      }
      assert.equal(await calls(), baselineCalls)
      // A real offline export carries a read-only sampled progress summary, not a live private file source.
      if (mode === 'fail') {
        await page.click('[data-testid="share-open"]')
        await page.click('[data-testid="share-mode-html"]')
        await page.waitForSelector('[data-testid="share-dialog"][data-phase="ready"]', { timeout: 30_000 })
        const srcdoc = await page.locator('[data-testid="share-preview"]').getAttribute('srcdoc')
        assert.ok(srcdoc?.includes('progress snapshot'))
        writeFileSync(join(artifacts, 'progress-share.html'), srcdoc!)
        const frame = await (await page.waitForSelector('[data-testid="share-preview"]')).contentFrame()
        assert.ok(frame)
        await frame.waitForSelector('[data-testid="share-thread"]')
        await page.locator('[data-testid="share-dialog"]').screenshot({ path: join(artifacts, 'share-snapshot.png') })
        assert.equal(await calls(), baselineCalls)
        await page.click('[data-testid="share-close"]')
      }
    }
    // The shared outer surface is frameless for native AND HTML, not a demo-specific skin.
    const visual: unknown[] = []
    for (const kind of ['native', 'html'] as const) {
      await page.goto(`${base}/?token=${info.token}`)
      await page.waitForSelector('[data-testid="hero-composer"]')
      if (await page.locator('[data-testid="folder-clear"]').count()) await page.click('[data-testid="folder-clear"]')
      await bypassDirector(page)
      await page.fill('[data-testid="composer"]', `surface ${kind}`)
      await page.click('[data-testid="send"]')
      const surface = page.locator('[data-testid="thread"] [data-testid="ui-surface-visual"]')
      await surface.waitFor()
      for (let i = 0; i < 4 && await page.locator('[data-testid="card-shelve"]').count(); i++) await page.locator('[data-testid="card-shelve"]').first().click()
      if (kind === 'html') {
        await surface.getByTestId('intelligent-html-run').click()
        await surface.getByTestId('intelligent-html-frame').waitFor()
        const frame = await (await surface.getByTestId('intelligent-html-frame').elementHandle())!.contentFrame()
        assert.ok(frame)
        await frame.getByText('Mark reviewed').click()
        await frame.getByText('Reviewed', { exact: true }).waitFor()
      } else await surface.getByLabel('Batch size').fill('32')
      const css = await surface.evaluate((el) => {
        const root = getComputedStyle(el), head = getComputedStyle(el.querySelector('.uis-head')!)
        return { background: root.backgroundColor, shadow: root.boxShadow, border: root.borderTopWidth, radius: root.borderRadius, headerBackground: head.backgroundColor, headerBorder: head.borderBottomWidth }
      })
      assert.deepEqual(css, { background: 'rgba(0, 0, 0, 0)', shadow: 'none', border: '0px', radius: '0px', headerBackground: 'rgba(0, 0, 0, 0)', headerBorder: '0px' })
      visual.push({ kind, css })
      await page.locator('[data-testid="thread"]').screenshot({ path: join(artifacts, `frameless-${kind}.png`) })
      if (kind === 'html') {
        await surface.getByTestId('intelligent-html-stop').click()
        assert.equal(await surface.getByTestId('intelligent-html-frame').count(), 0)
      }
    }
    writeFileSync(join(artifacts, 'frameless-styles.json'), JSON.stringify(visual, null, 2))
    assert.deepEqual(errors, [])
  } finally {
    writeFileSync(join(artifacts, 'browser-errors.json'), JSON.stringify(errors))
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(artifacts, 'last-page.png') }).catch(() => {})
      writeFileSync(join(artifacts, 'last-page.txt'), await page.locator('body').innerText().catch(() => 'unavailable'))
    }
    await browser?.close().catch(() => {})
    if (server.exitCode === null && server.signalCode === null) {
      const ended = new Promise((r) => server.once('exit', r))
      server.kill('SIGTERM'); await Promise.race([ended, sleep(10_000)])
    }
    ledger.push({ kind: 'server-cleanup', pid: server.pid, exitCode: server.exitCode, signal: server.signalCode })
    writeFileSync(join(artifacts, 'pids.json'), JSON.stringify(ledger, null, 2))
    writeFileSync(join(artifacts, 'server.log'), serverLog)
    assert.ok(server.exitCode !== null || server.signalCode !== null, `owned fixture backend PID ${server.pid} did not exit within 10 seconds after SIGTERM; cleanup is incomplete`)
  }
})
