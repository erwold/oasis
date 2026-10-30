/** Commands that outlive their run, in real Chrome against a stand-in backend (background-commands-stub.ts: no model,
 *  no data directory, no network). The thread header's terminal count shows the session's background commands; its
 *  list shows each one's state and latest output, opens its run, stops it, and closes on Escape; the composer stays
 *  free — a message sent starts the next run beside them, the count stays while that run works, and goes with the last
 *  command's end. A run that worked beside a background command shows its changes as partial, and its Undo is refused
 *  with the reason. The command's output is read only while its row is open.
 *
 *  Run alone, after `npm run build`: node --test e2e/background-commands.e2e.ts (port OASIS_CODE_E2E_PORT, default
 *  8399: a port in use is waited for, never taken). Screenshots go to OASIS_CODE_BG_SHOTS (default: handoff/bg-ui-shots
 *  at the checkout's root, kept out of git). OASIS_CODE_E2E_DIST names another built UI; OASIS_CODE_E2E_BROWSER another
 *  Chromium executable. Each browser profile is a temporary folder of this test. */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { BG_COMMAND, BG_SESSION, OVERLAP_RUN, REMOTE_COMMAND, startBgStub, UNATTRIBUTED_RUN, type BgStub } from './background-commands-stub.ts'

const PORT = Number(process.env.OASIS_CODE_E2E_PORT ?? 8399)
const BASE = `http://127.0.0.1:${PORT}`
const DIST = realpathSync(resolve(process.env.OASIS_CODE_E2E_DIST ?? fileURLToPath(new URL('../dist', import.meta.url))))
const SHOTS = resolve(process.env.OASIS_CODE_BG_SHOTS ?? fileURLToPath(new URL('../../handoff/bg-ui-shots', import.meta.url)))
const WAIT_MS = 10_000

let stub: BgStub
let browser: Browser
let context: BrowserContext
let page: Page
let profile: string
const pageErrors: string[] = []

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer()
    probe.once('error', () => done(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)))
  })
}

before(async () => {
  assert.ok(existsSync(join(DIST, 'index.html')), `no built UI at ${DIST}: run npm run build first`)
  // the port is shared: wait for it, never take it from whoever holds it
  for (let i = 0; !(await portFree(PORT)); i += 1) {
    if (i % 30 === 0) console.log(`[background-commands] port ${PORT} is in use; waiting`)
    await new Promise((r) => setTimeout(r, 2000))
  }
  mkdirSync(SHOTS, { recursive: true })
  console.log(`[background-commands] screenshots: ${SHOTS}`)
  stub = await startBgStub(PORT, DIST)
  profile = mkdtempSync(join(tmpdir(), 'oasis-e2e-bg-'))
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  browser = await chromium.launch(executablePath ? { executablePath, headless: true, args: ['--no-sandbox'] } : { channel: 'chrome', headless: true })
  context = await browser.newContext({ viewport: { width: 1360, height: 860 } })
  page = await context.newPage()
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.log(`page error: ${e.message}`) })
})

after(async () => {
  await browser?.close()
  await stub?.close()
  if (profile) rmSync(profile, { recursive: true, force: true })
})

const shot = async (name: string, selector?: string) => {
  const path = join(SHOTS, `${name}.png`)
  if (selector) await page.locator(selector).first().screenshot({ path })
  else await page.screenshot({ path })
}
const badge = '[data-testid="background-commands"]'
const menu = '[data-testid="background-commands-menu"]'
const outputReads = () => stub.requests.filter((r) => r.path.startsWith('/api/executions/') && r.path.endsWith('/output')).length

test('background commands: a count in the header, their output and Stop, the composer free beside them, gone with the last one; partial changes and a refused Undo', async () => {
  await page.goto(`${BASE}/?token=stub`)
  await page.click(`[data-testid="session-${BG_SESSION}"]`)

  // the count: two commands of earlier runs, one whose end is not known
  await page.waitForSelector(`${badge}[data-count="2"]`, { timeout: WAIT_MS })
  assert.equal(await page.getAttribute(badge, 'aria-label'), '2 background commands from earlier runs (1 with an end not known yet)')
  assert.equal((await page.textContent(badge))?.trim(), '2')
  // one compact control: no explanatory paragraph in the header
  const header = await page.textContent('.thread-header')
  assert.ok(!/background/i.test(header ?? ''), `the header's words: ${header}`)
  await shot('01-header-badge', '.thread-header')

  // the run that worked beside the watcher: its changes partial (the path left out in its details), its Undo refused
  const mark = page.locator('[data-testid="attribution-mark"][data-attribution="partial"]').first()
  await mark.waitFor({ timeout: WAIT_MS })
  assert.match((await mark.getAttribute('title')) ?? '', /src\/gap\.ts/)
  const undo = page.locator(`.turn-footer:has([data-testid="records-${OVERLAP_RUN}"]) [data-testid="undo-run"]`)
  await undo.waitFor({ timeout: WAIT_MS })
  assert.equal(await undo.getAttribute('aria-disabled'), 'true')
  assert.match((await undo.getAttribute('title')) ?? '', /No automatic undo/)
  // aria-disabled (not disabled): its title stays readable and a press says why — Playwright counts it as not enabled,
  // so the press is forced, as a person's click would land
  await undo.click({ force: true })
  console.log(`[background-commands] toast: ${JSON.stringify(await page.locator('.toast').allTextContents())}; unanswered: ${JSON.stringify([...new Set(stub.requests.filter((r) => (r.status ?? 200) >= 400).map((r) => `${r.method} ${r.path} ${r.status}`))])}`)
  await page.waitForFunction(() => document.body.innerText.includes('No automatic undo'), null, { timeout: WAIT_MS })
  assert.ok(!stub.requests.some((r) => r.path.endsWith('/undo')), 'a refused Undo sends nothing')
  await shot('02-thread-partial-undo-refused')

  // a run whose changes cannot be told apart (its receipt's counts are 0, its run diff refused): its round says "not
  // attributable" with the reason, and nothing reads as "no change" — no "workspace unchanged", no 0 or +0, no Undo
  const unattributed = page.locator(`[data-testid="run-${UNATTRIBUTED_RUN}"]`)
  await unattributed.waitFor({ timeout: WAIT_MS })
  await unattributed.locator('.work-head').first().click()
  const unavailable = unattributed.locator('[data-testid="attribution-mark"][data-attribution="unavailable"]')
  await unavailable.waitFor({ timeout: WAIT_MS })
  assert.equal((await unavailable.textContent())?.trim(), 'not attributable')
  assert.match((await unavailable.getAttribute('title')) ?? '', /not the same as no change/)
  const said = await unattributed.innerText()
  assert.ok(!/workspace unchanged|changed no file|\b0 files?\b|\+0\b|−0\b/.test(said), `the unavailable run's words: ${said}`)
  assert.equal(await unattributed.locator('[data-testid="undo-run"]').count(), 0)
  assert.equal(await unattributed.locator('[data-testid="change-chip"]').count(), 0)
  await unattributed.screenshot({ path: join(SHOTS, '02b-unavailable-attribution.png') })

  // no command's output is read while the list is closed
  const closedReads = outputReads()
  assert.equal(closedReads, 0)

  // the list: each command with its state; the watcher's output on asking
  await page.click(badge)
  await page.waitForSelector(menu, { timeout: WAIT_MS })
  assert.equal(await page.getAttribute(`[data-testid="background-command-${BG_COMMAND}"]`, 'data-status'), 'running')
  assert.match((await page.textContent(`[data-testid="background-command-${REMOTE_COMMAND}"]`)) ?? '', /end not known/)
  await page.click(`[data-testid="background-command-${BG_COMMAND}"] [data-testid="background-command-output-toggle"]`)
  await page.waitForFunction(() => /\[watch\] rebuilt/.test(document.querySelector('[data-testid="background-command-output"] pre')?.textContent ?? ''), null, { timeout: WAIT_MS })
  await shot('03-popover-output')
  const [badgeBox, menuBox] = [await page.locator(badge).boundingBox(), await page.locator(menu).boundingBox()]
  assert.ok(badgeBox && menuBox && menuBox.x >= badgeBox.x - 1 && menuBox.y >= badgeBox.y + badgeBox.height - 1, `the list opens under the badge: ${JSON.stringify({ badgeBox, menuBox })}`)
  assert.ok(menuBox!.x + menuBox!.width <= 1360, 'the list stays inside the window')
  // its output is read again while it is open — about one read per two seconds, one command only
  const openedAt = outputReads()
  await page.waitForTimeout(5_000)
  const during = outputReads() - openedAt
  console.log(`[background-commands] output reads in 5 s while open: ${during}`)
  assert.ok(during >= 1 && during <= 5, `output reads in 5 s: ${during}`)
  assert.ok(stub.requests.every((r) => !r.path.includes(`/executions/${REMOTE_COMMAND}/output`)), 'the closed row is never read')
  // Escape closes the list; nothing is read after
  await page.keyboard.press('Escape')
  await page.waitForSelector(menu, { state: 'detached', timeout: WAIT_MS })
  const afterClose = outputReads()
  await page.waitForTimeout(2_500)
  assert.equal(outputReads(), afterClose, 'no output read once the list is closed')

  // the composer is free: a message starts the next run beside the commands
  const send = page.locator('[data-testid="send"]')
  await page.fill('[data-testid="composer"]', 'keep going while the watcher runs')
  assert.equal(await send.isDisabled(), false)
  await send.click()
  const deadline = Date.now() + WAIT_MS
  while (stub.started.length === 0 && Date.now() < deadline) await page.waitForTimeout(100)
  assert.equal(stub.started.length, 1, 'the message started a run')
  const started = stub.started[0]!
  await page.waitForFunction(() => /running/.test(document.querySelector('[data-testid="thread-state"]')?.textContent ?? ''), null, { timeout: WAIT_MS })
  // the count stays while the new run works
  assert.equal(await page.getAttribute(badge, 'data-count'), '2')
  // the pointer off the composer (its context ring's hover card is not this test's)
  await page.mouse.move(700, 300)
  // nothing of the stub's own gaps is on the page (the context ring reads a report it serves)
  assert.ok(!(await page.locator('body').innerText()).includes('the stub does not serve'), 'no stub 404 on the page')
  await shot('04-new-run-beside-badge')

  // Stop on one command: the count follows at once (the session is read again on the stop)
  await page.click(badge)
  await page.click(`[data-testid="background-command-${REMOTE_COMMAND}"] [data-testid="background-command-stop"]`)
  await page.waitForSelector(`${badge}[data-count="1"]`, { timeout: WAIT_MS })
  assert.ok(stub.requests.some((r) => r.method === 'POST' && r.path === `/api/executions/${REMOTE_COMMAND}/stop`))
  await page.keyboard.press('Escape')

  // the new run ends; the remaining command keeps the count
  stub.finishRun(started)
  await page.waitForFunction(() => /idle/.test(document.querySelector('[data-testid="thread-state"]')?.textContent ?? ''), null, { timeout: WAIT_MS })
  assert.equal(await page.getAttribute(badge, 'data-count'), '1')
  // the watcher ends on its own: the count goes on the session's next read (its ticker), idle
  stub.endCommand(BG_COMMAND)
  await page.waitForSelector(badge, { state: 'detached', timeout: WAIT_MS })
  await shot('05-after-last-command', '.thread-header')
  assert.deepEqual(pageErrors, [])
})
