/** Run only after npm run build, serially with other e2e files. No real OAuth/provider calls.
 * Optional private PNG: OASIS_CODE_ANTIGRAVITY_SCREENSHOT=/absolute/new/path.png
 * Uses the real app and built assets, not mocked Accounts responses or a development server. */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext } from 'playwright-core'
import { bypassDirector } from './agent-entry.ts'
import type { ModelEntry } from '../src/api/types.ts'

const BASE = 'http://127.0.0.1:8399'
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function bounded<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })]) }
  finally { clearTimeout(timer) }
}
async function waitForPort(): Promise<void> {
  const deadline = Date.now() + 90_000
  for (;;) {
    const free = await new Promise<boolean>((resolve, reject) => {
      const listener = createServer()
      listener.once('error', (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE' ? resolve(false) : reject(error))
      listener.listen(8399, '127.0.0.1', () => listener.close(() => resolve(true)))
    })
    if (free) return
    if (Date.now() >= deadline) throw new Error('8399 is busy after 90 seconds; retry this file later. Its owner was not touched.')
    await pause(500)
  }
}
async function stopOwnServer(server: ChildProcess | undefined): Promise<void> {
  if (!server?.pid || server.exitCode !== null || server.signalCode !== null) return
  const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()))
  server.kill('SIGTERM')
  try { await bounded(exited, 5000, 'Accounts fixture did not stop') }
  catch {
    // Only this exact child, never the owner of the port or a process found by name.
    server.kill('SIGKILL')
    await bounded(exited, 2000, 'Could not stop the Accounts fixture child')
  }
}
async function ready(server: ChildProcess): Promise<void> {
  let buffer = ''
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); server.stdout!.off('data', data); server.off('exit', exit); server.off('error', error) }
    const data = (chunk: Buffer) => {
      buffer = (buffer + String(chunk)).slice(-4096)
      if (buffer.split('\n').includes('ANTIGRAVITY_ACCOUNTS_READY')) { cleanup(); resolve() }
    }
    const exit = () => { cleanup(); reject(new Error('Isolated Accounts backend exited before readiness; a port race also fails closed')) }
    const error = () => { cleanup(); reject(new Error('Could not launch bun for the isolated Accounts backend')) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('Isolated Accounts backend startup timed out')) }, 30_000)
    server.stdout!.on('data', data)
    server.once('exit', exit)
    server.once('error', error)
  })
  server.stdout!.resume()
}

async function fixture(t: TestContext, withModels = false) {
  const dist = fileURLToPath(new URL('../dist', import.meta.url))
  assert.ok(existsSync(join(dist, 'index.html')), 'Run npm run build before this test')
  await waitForPort() // Never connect to an existing app on this port.
  const root = mkdtempSync(join(process.env.OASIS_CODE_E2E_TMP || tmpdir(), 'antigravity-accounts-'))
  const home = join(root, 'home'), data = join(root, 'data'), profile = join(root, 'chrome'), temp = join(root, 'tmp')
  for (const path of [home, data, profile, temp]) mkdirSync(path, { mode: 0o700 })
  let server: ChildProcess | undefined, context: BrowserContext | undefined
  t.after(async () => {
    const errors: unknown[] = []
    let chromeClosed = !context, serverClosed = false
    try { await bounded(context?.close() ?? Promise.resolve(), 8000, 'Temporary Chrome context did not close'); chromeClosed = true } catch (error) { errors.push(error) }
    try { await stopOwnServer(server); serverClosed = true } catch (error) { errors.push(error) }
    if (chromeClosed && serverClosed) rmSync(root, { recursive: true, force: true })
    if (errors.length) throw new AggregateError(errors, 'Accounts fixture cleanup failed; only its own temporary files were retained')
  }, { timeout: 20_000 })
  // Allowlist instead of inheriting real account/proxy/config variables. All data and HOME are new and empty.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, LANG: 'en_US.UTF-8', TZ: 'UTC', HOME: home, TMPDIR: temp,
    OASIS_CODE_E2E_ROOT: root, OASIS_CODE_DATA: data, OASIS_CODE_AUTH_DIR: data, OASIS_CODE_FRONTEND_DIST: dist,
  }
  server = spawn('bun', ['run', fileURLToPath(new URL('./antigravity-accounts-server.ts', import.meta.url)), ...(withModels ? ['--models'] : [])], {
    cwd: fileURLToPath(new URL('../../backend-ts/', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stderr!.resume() // No credentials, account files or backend diagnostics copied to the report.
  await ready(server)
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  context = await chromium.launchPersistentContext(profile, {
    ...(executablePath ? { executablePath } : { channel: 'chrome' }), headless: true,
    viewport: { width: 1120, height: 1000 }, timeout: 30_000, serviceWorkers: 'block',
  })
  let externalRequests = 0, oauthRequests = 0
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== BASE) { externalRequests++; await route.abort(); return }
    if (url.pathname.startsWith('/api/auth/login/')) { oauthRequests++; await route.abort(); return }
    await route.continue()
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(`${BASE}/api/auth/session?token=e2e-token`, { waitUntil: 'domcontentloaded' })
  return { page, assertSafe: () => {
    assert.deepEqual(pageErrors, [])
    assert.equal(externalRequests, 0, 'no browser request may leave the fixture origin')
    assert.equal(oauthRequests, 0, 'acceptance never starts real OAuth')
  } }
}

test('built Accounts shows Antigravity as the third signed-out subscription, independently of the Gemini API key', { timeout: 240_000 }, async (t) => {
  const screenshot = process.env.OASIS_CODE_ANTIGRAVITY_SCREENSHOT
  if (screenshot) {
    assert.ok(isAbsolute(screenshot), 'Screenshot path must be absolute')
    assert.equal(existsSync(screenshot), false, 'Refusing to overwrite an existing report')
  }
  const { page, assertSafe } = await fixture(t)
  await page.getByTestId('settings').click()
  await page.getByTestId('settings-tab-accounts').click()
  await page.getByTestId('sign-in-antigravity').waitFor()
  const dialog = page.getByTestId('settings-dialog')
  const panel = page.getByTestId('settings-panel-accounts')
  const subscriptions = panel.locator('section[aria-label="Subscriptions"]')
  const rows = subscriptions.locator('.acct-row2')
  assert.deepEqual(await rows.locator('.acct-row2-id strong').allTextContents(), ['Codex', 'Claude', 'Antigravity'])
  for (const [index, id] of ['openai-codex', 'anthropic', 'antigravity'].entries()) {
    const row = rows.nth(index)
    assert.equal(await row.locator('.acct-pill-status').innerText(), 'Not signed in')
    assert.equal(await row.getByTestId(`sign-in-${id}`).isEnabled(), true)
    assert.equal(await row.getByRole('button', { name: 'Sign out', exact: true }).count(), 0)
    await row.locator('img').evaluate((image: HTMLImageElement) => image.decode())
  }
  const logo = rows.nth(2).locator('img')
  const logoInfo = await logo.evaluate((image: HTMLImageElement) => ({ src: image.currentSrc, width: image.naturalWidth, height: image.naturalHeight }))
  assert.equal(logoInfo.width, 128)
  assert.equal(logoInfo.height, 128)
  assert.equal(new URL(logoInfo.src).origin, BASE)
  const imageResponse = await page.request.get(logoInfo.src)
  assert.equal(imageResponse.ok(), true)
  const expected = createHash('sha256').update(readFileSync(fileURLToPath(new URL('../src/assets/logo-antigravity.png', import.meta.url)))).digest('hex')
  assert.equal(createHash('sha256').update(await imageResponse.body()).digest('hex'), expected, 'built app serves the exact approved logo')
  const keys = panel.locator('section[aria-label="API keys"]')
  const gemini = keys.locator('.acct-row2').filter({ has: page.getByTestId('add-key-gemini') })
  assert.equal(await gemini.count(), 1)
  assert.equal(await gemini.locator('.acct-pill-status').innerText(), 'No key')
  assert.equal(await gemini.getByTestId('add-key-gemini').isEnabled(), true)
  assert.equal(await keys.getByTestId('sign-in-antigravity').count(), 0)
  assert.equal(await subscriptions.getByTestId('add-key-gemini').count(), 0)
  const response = await page.request.get(`${BASE}/api/auth/accounts`)
  assert.equal(response.ok(), true)
  const accounts = await response.json() as { providers: { provider: string; status: string; account_label: string | null }[] }
  assert.ok(accounts.providers.some((p) => p.provider === 'antigravity' && p.status === 'signed_out' && p.account_label === null), 'real backend also exposes the new signed-out account')
  assertSafe()
  if (screenshot) {
    // Capture all of the scrollable Accounts content, not just the first viewport. This capture-only expansion
    // leaves the production layout above tested unchanged; no system screenshot or existing Chrome profile.
    await page.addStyleTag({ content: '.settings-dialog { height: auto; max-height: none; } .settings-dialog .acct-body { overflow: visible; flex: none; }' })
    const height = Math.ceil(await dialog.evaluate((element) => element.getBoundingClientRect().height))
    await page.setViewportSize({ width: 1120, height: Math.max(1000, height + 80) })
    mkdirSync(dirname(screenshot), { recursive: true, mode: 0o700 })
    const png = await dialog.screenshot({ type: 'png', animations: 'disabled', timeout: 15_000 })
    writeFileSync(screenshot, png, { flag: 'wx', mode: 0o600 })
  }
})


test('the real catalog presents five Antigravity groups with their own efforts and keeps the Gemini API route independent', { timeout: 240_000 }, async (t) => {
  const { page, assertSafe } = await fixture(t, true)
  const cases = [
    { id: 'antigravity:gemini-4-argon', efforts: ['low', 'medium', 'high'] },
    { id: 'antigravity:gemini-3.8-flash-tiered', efforts: ['low', 'medium', 'high'] },
    { id: 'antigravity:claude-opus-5-5-high', efforts: ['low', 'medium', 'high'] },
    { id: 'antigravity:claude-sonnet-5-5-high', efforts: ['low', 'medium', 'high'] },
    { id: 'antigravity:gpt-oss-120b-medium', efforts: ['medium'] },
    { id: 'google:gemini-4-argon', efforts: ['low', 'medium', 'high'] },
  ]
  const response = await page.request.get(`${BASE}/api/models`)
  assert.equal(response.ok(), true)
  const { models } = await response.json() as { models: ModelEntry[] }
  const antigravity = models.filter((model) => model.account === 'antigravity')
  assert.deepEqual(antigravity.map((model) => model.id).sort(), cases.slice(0, 5).map((entry) => entry.id).sort())
  for (const entry of cases) {
    const model = models.find((model) => model.id === entry.id)
    assert.ok(model, entry.id)
    assert.equal(model.credential, 'available')
    assert.deepEqual(model.supported_thinking, entry.efforts, entry.id)
    assert.equal(model.account, entry.id.startsWith('antigravity:') ? 'antigravity' : 'gemini')
    assert.equal(model.auth, entry.id.startsWith('antigravity:') ? 'oauth' : 'api_key')
  }
  await bypassDirector(page)
  await page.getByTestId('model-picker').click()
  const groups = page.locator('.picker-group')
  assert.deepEqual((await groups.locator('.picker-group-head').allTextContents()).sort(), ['Antigravity', 'Google Gemini'].sort())
  assert.equal(await groups.filter({ has: page.locator('.picker-group-head', { hasText: /^Antigravity$/ }) }).getByRole('option').count(), 5)
  assert.equal(await groups.filter({ has: page.locator('.picker-group-head', { hasText: /^Google Gemini$/ }) }).getByRole('option').count(), 1)
  await page.getByTestId('model-option-google:gemini-4-argon').click()
  for (const entry of cases) {
    await page.getByTestId('model-picker').click()
    await page.getByTestId(`model-option-${entry.id}`).click()
    await page.getByTestId('thinking-chip').click()
    assert.deepEqual(await page.locator('[data-testid^="thinking-option-"]').evaluateAll((options) => options.map((option) => option.getAttribute('data-testid'))), [
      'thinking-option-default', ...entry.efforts.map((effort) => `thinking-option-${effort}`),
    ], entry.id)
    for (const effort of entry.efforts) {
      await page.getByTestId(`thinking-option-${effort}`).click()
      assert.equal(await page.getByTestId('thinking-current').innerText(), `Thinking: ${effort}`)
      await page.getByTestId('thinking-chip').click()
    }
    await page.getByTestId('thinking-option-default').click()
    assert.equal(await page.getByTestId('thinking-current').innerText(), 'Thinking: default')
  }
  // The mention menu has a second effort control; it must honor each route's catalog too.
  await page.getByTestId('composer').click()
  await page.keyboard.type('@')
  await page.getByTestId('entity-picker').waitFor()
  for (const entry of cases) {
    await page.getByTestId(`mention-effort-${entry.id}`).click()
    const effortMenu = page.getByTestId('mention-effort-menu')
    assert.deepEqual(await effortMenu.getByRole('option').evaluateAll((options) => options.map((option) => option.getAttribute('data-testid'))), [
      'mention-effort-default', ...entry.efforts.map((effort) => `mention-effort-${effort}`),
    ], `mention ${entry.id}`)
    await page.getByTestId('mention-effort-medium').click()
    assert.equal(await page.getByTestId(`mention-effort-${entry.id}`).innerText(), 'medium')
  }
  assertSafe()
})
