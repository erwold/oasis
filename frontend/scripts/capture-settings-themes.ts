/** Screenshots of Settings (each tab, in Light, Dark and Claude) and of one information-dense main view (the live
 *  native surface with its charts, the agents' board, a card, the Agent Teams outline) in Light, Dark and Claude. The
 *  real app from frontend/dist against backend-ts/scripts/atelier_e2e_server.ts (scripted models only — no provider is
 *  reached, no sign-in exists), one headless Chrome on a temporary profile directory made for this run and deleted
 *  after. Remote access is the desktop shell's: a stand-in shell answers with a placeholder address (no real tunnel).
 *
 *      npm run build && node scripts/capture-settings-themes.ts <outdir>
 *
 *  The server listens on a free port (OASIS_CODE_E2E_PORT unset); themes are chosen through Settings › Appearance. */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Page } from 'playwright-core'
import { bypassDirector } from '../e2e/agent-entry.ts'
import { showTeams } from '../e2e/natural-language-driver.ts'

const out = resolve(process.argv[2] ?? 'settings-themes-captures')
mkdirSync(out, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const env: NodeJS.ProcessEnv = { ...process.env, OASIS_CODE_FRONTEND_DIST: resolve('dist') }
delete env.OASIS_CODE_DATA; delete env.OASIS_CODE_PORT; delete env.OASIS_CODE_AUTH_DIR; delete env.OASIS_CODE_E2E_PORT
const server = spawn('bun', ['run', 'scripts/atelier_e2e_server.ts'], { cwd: resolve('../backend-ts'), stdio: ['ignore', 'pipe', 'inherit'], env })
const info = await new Promise<{ port: number; token: string }>((ok, bad) => {
  let buf = ''
  server.stdout!.on('data', (d) => { buf += String(d); const line = buf.split('\n')[0]!; if (buf.includes('\n') && line.startsWith('{')) ok(JSON.parse(line)) })
  server.on('exit', (c) => bad(new Error(`server exited ${c}`)))
})
const BASE = `http://127.0.0.1:${info.port}`
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/api/meta/build`)).ok) break } catch { /* not yet */ } await sleep(100) }
const api = async <T>(path: string): Promise<T> => (await fetch(`${BASE}${path}`, { headers: { 'x-oasis-code-token': info.token } })).json() as Promise<T>
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

const profile = mkdtempSync(join(tmpdir(), 'oasis-settings-themes-chrome-'))
const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, viewport: { width: 1440, height: 960 }, colorScheme: 'light' })
const record: Record<string, unknown> = { base: 'http://127.0.0.1:<free port>', profile: 'temporary, deleted after', shots: [] as unknown[] }
const errors: string[] = []
try {
  const page = context.pages()[0] ?? await context.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  // the desktop shell's Remote access, stood in for (placeholder address; nothing is installed or reached)
  await page.addInitScript(() => {
    const status = { state: 'connected', enabled: true, keep_awake: true, provider: 'quick', host: 'example-tunnel.trycloudflare.com', url: 'https://example-tunnel.trycloudflare.com/PLACEHOLDER-not-a-key/mcp/current', error: null, token_set: null, gateway_origin: 'http://127.0.0.1:18499' }
    const ok = async () => status
    Object.assign(window, { oasisCodeDesktop: { platform: 'darwin', remoteStatus: ok, setRemote: ok, configureRemote: ok, rotateRemote: ok } })
  })
  const shot = async (name: string, what: string) => {
    const file = join(out, `${name}.png`)
    await page.screenshot({ path: file })
    ;(record.shots as unknown[]).push({ file: `${name}.png`, what, theme: await page.evaluate(() => document.documentElement.dataset.theme), stored: await page.evaluate(() => localStorage.getItem('oasis-code.theme')) })
  }
  const openSettings = async (tab: 'accounts' | 'appearance' | 'connections') => {
    if (!(await page.locator('[data-testid="settings-dialog"][open]').count())) await page.click('[data-testid="settings"]')
    await page.click(`[data-testid="settings-tab-${tab}"]`)
    if (tab === 'accounts') await page.waitForSelector('[data-testid="sign-in-openai-codex"]')
    if (tab === 'connections') await page.waitForSelector('[data-testid="remote-url"]')
    await sleep(300)
  }
  const closeSettings = async () => { await page.keyboard.press('Escape'); await page.waitForSelector('[data-testid="settings-dialog"]', { state: 'detached' }) }
  const choose = async (theme: 'light' | 'dark' | 'claude') => {
    await openSettings('appearance')
    await page.click(`[data-testid="theme-${theme}"]`)
    await closeSettings()
  }

  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]', { timeout: 30_000 })
  await bypassDirector(page)
  await page.click('[data-testid="model-picker"]')
  await page.click('[data-testid="model-option-scripted:report"]')
  await page.fill('[data-testid="composer"]', 'Open the run log, hold 1s')
  await page.click('[data-testid="send"]')
  await page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
  const sid = (await page.locator('[aria-current="page"][data-testid^="session-"]').getAttribute('data-testid'))!.slice('session-'.length)
  for (let i = 0; i < 150; i++) { const d = await api<{ active_run: unknown; runs: unknown[] }>(`/api/sessions/${sid}`); if (d.runs.length === 1 && d.active_run === null) break; await sleep(200) }
  for (const [model, words] of [['scripted:eval', 'Evaluate the latest checkpoint, hold 300s'], ['scripted:data', 'Audit the next data shard, hold 300s'], ['scripted:report', 'Write the run report, hold 2s']]) await dispatch(sid, model!, words!)
  for (let tries = 0; ; tries++) {
    const r = await fetch(`${BASE}/api/sessions/${sid}/chat`, { method: 'POST', headers: { 'x-oasis-code-token': info.token, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Keep the training metrics on screen #short', model: 'scripted:trainer' }) })
    if (r.ok) break
    if (r.status !== 409 || tries > 100) throw new Error(`chat: ${r.status} ${await r.text()}`)
    await sleep(300)
  }
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="ui-surface-training_metrics"]')?.getAttribute('data-revision') ?? 0) >= 6, null, { timeout: 60_000 })
  await page.waitForSelector('[data-testid="agents-board"] [data-testid="agents-relations"]', { timeout: 30_000 })
  // the html surface running, one agent's card open, the Agent Teams outline shown
  const notes = page.locator('[data-testid="ui-surface-run_notes"]').first()
  if (await notes.count()) { await notes.locator('[data-testid="intelligent-html-run"]').click().catch(() => undefined) }
  await page.locator('[data-testid="agents-board"] .rg-lane-name.opens').first().click()
  await page.locator('.desk-win').first().waitFor({ timeout: 15_000 })
  await showTeams(page)
  await page.locator('[data-testid="ui-surface-training_metrics"]').first().scrollIntoViewIfNeeded()

  for (const theme of ['light', 'dark', 'claude'] as const) {
    await choose(theme)
    await sleep(800)
    await shot(`main-${theme}`, `the session: live surface with charts, agents board, a card, the Agent Teams outline (${theme})`)
    for (const tab of ['accounts', 'appearance', 'connections'] as const) {
      await openSettings(tab)
      await shot(`settings-${tab}-${theme}`, `Settings › ${tab} (${theme})`)
    }
    await closeSettings()
  }
  record.errors = errors
  writeFileSync(join(out, 'capture.json'), JSON.stringify(record, null, 2))
  console.log(JSON.stringify(record, null, 2))
} finally {
  await context.close()
  rmSync(profile, { recursive: true, force: true })
  server.kill('SIGTERM')
}
