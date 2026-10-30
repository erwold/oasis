/** The frontend of the 2026-10-16 friction cleanup in real Chrome, against a stand-in backend (friction-ui-stub.ts: a
 *  loopback port of its own, no model, no data directory, no provider call):
 *  12 — a session joined to another session's task stands under it in the rail, its folder named;
 *  13 — a run waiting for the folder's writer says what it waits for (never thinking) and is cancelled by its id;
 *  17 — with two groups, the To chip names the group first (none chosen for the person), the note goes to it; the
 *       group stopped, the note is refused, never sent to the director;
 *   8 — a command that ran narrower than asked shows where it ran, the harness's reasons on hover;
 *  roots — the session's further folders: added with the access chosen, a refusal says why and how to go on.
 *
 *  Run only by the final integrator, after `npm run build`, one file at a time. OASIS_CODE_E2E_DIST names another
 *  built UI; OASIS_CODE_E2E_BROWSER another Chromium executable. */

import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright-core'
import { IDS, startFrictionStub, type FrictionStub } from './friction-ui-stub.ts'

const DIST = realpathSync(resolve(process.env.OASIS_CODE_E2E_DIST ?? join(process.cwd(), 'dist')))
const WAIT_MS = 8_000
let stub: FrictionStub
let browser: Browser
let page: Page
let base: string
const errors: string[] = []

before(async () => {
  stub = await startFrictionStub(DIST)
  base = `http://127.0.0.1:${stub.port}`
  console.info(`e2e app port: ${stub.port}`)
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  browser = await chromium.launch(executablePath ? { executablePath, headless: true, args: ['--no-sandbox'] } : { channel: 'chrome', headless: true })
  page = await browser.newPage()
  // the desktop shell's folder panel, as far as the roots go: it answers one folder
  await page.addInitScript(() => { Object.assign(window, { oasisCodeDesktop: { pickDirectory: async () => '/fixture/extra' } }) })
  page.on('pageerror', (e) => { errors.push(e.message) })
})

after(async () => {
  await browser?.close()
  await stub?.close()
})

const posted = (path: string) => stub.requests.filter((r) => r.method !== 'GET' && r.path === path)
async function eventually(check: () => boolean | Promise<boolean>, what: string) {
  const until = Date.now() + WAIT_MS
  while (Date.now() < until) { if (await check()) return; await new Promise((r) => setTimeout(r, 100)) }
  assert.fail(`not within ${WAIT_MS} ms: ${what}`)
}

test('12: the docs session of the task stands under its first session, its folder in its title; not under its own folder', async () => {
  await page.goto(`${base}/?token=stub`)
  await page.waitForSelector(`[data-testid="rail-task-${IDS.root}"]`)
  const task = page.getByTestId(`rail-task-${IDS.root}`)
  assert.equal(await task.getByTestId(`session-${IDS.docs}`).count(), 1)
  // the folder it works in is said on hover (its path under the title), not as words on the row
  assert.match(String(await task.getByTestId(`session-${IDS.docs}`).getAttribute('title')), /\n.*docs$/)
  assert.equal(await task.getByTestId(`session-folder-${IDS.docs}`).count(), 0)
  const docsFolder = page.locator('.rail-project', { has: page.getByTestId(`project-${IDS.projectDocs}`) })
  assert.equal(await docsFolder.getByTestId(`session-${IDS.docs}`).count(), 0)
  // one row of it in the whole rail
  assert.equal(await page.getByTestId(`session-${IDS.docs}`).count(), 1)
})

test('13: the waiting run says what it waits for, never thinking; Cancel stops that run by its id', async () => {
  await page.getByTestId(`session-${IDS.root}`).click()
  await page.waitForSelector('[data-testid="live-line"][data-state="waiting"]')
  const line = (await page.getByTestId('live-line').first().innerText()).trim()
  assert.match(line, new RegExp(`Waiting for run ${IDS.writerRun}`))
  assert.doesNotMatch(line, /thinking|queued for its model/)
  assert.match(await page.getByTestId('thread-state').innerText(), new RegExp(`Waiting for run ${IDS.writerRun}`))
  await page.getByTestId('waiting-cancel').first().click()
  await eventually(() => posted(`/api/runs/${IDS.queuedRun}/cancel`).length === 1, 'the waiting run cancelled by its id')
})

test('17: two groups: the group is chosen first (none for the person), the note goes to it; stopped, the note is refused', async () => {
  await page.getByTestId(`session-${IDS.groups}`).click()
  await page.getByTestId('to-chip').click()
  await page.waitForSelector('[data-testid="to-menu"]')
  assert.equal(await page.getByTestId(`to-group-${IDS.groupA}`).count(), 1)
  assert.equal(await page.getByTestId(`to-group-${IDS.groupB}`).count(), 1)
  // no recipient offered before a group is: the first group is not taken for the person
  assert.equal(await page.getByTestId('to-option-everyone').count(), 0)
  await page.getByTestId(`to-group-${IDS.groupB}`).click()
  await page.getByTestId('to-option-everyone').click()
  assert.match(await page.getByTestId('to-chip').innerText(), /everyone · review the docs/)
  await page.fill('[data-testid="composer"]', 'a note for the second group')
  await page.getByTestId('send').click()
  await eventually(() => posted(`/api/interactions/${IDS.groupB}/notes`).length === 1, 'the note to the group chosen')
  assert.equal(posted(`/api/interactions/${IDS.groupA}/notes`).length, 0)
  // the group stops (the page reads it on its next session read): the chip says so, the send is held, nothing goes to
  // the director or to the other group
  const director = stub.requests.filter((r) => r.path.endsWith('/director/messages')).length
  stub.stopGroupB()
  await page.waitForSelector('[data-testid="to-chip"][data-gone="true"]', { timeout: WAIT_MS })
  await page.fill('[data-testid="composer"]', 'held')
  assert.equal(await page.getByTestId('send').isDisabled(), true)
  assert.equal(stub.requests.filter((r) => r.path.endsWith('/director/messages')).length, director)
  assert.equal(posted(`/api/interactions/${IDS.groupA}/notes`).length, 0)
})

test('the session\'s further folders are not shown on the workspace card (they stay with the agent and the connector); the page never asks their route', async () => {
  await page.getByTestId(`session-${IDS.root}`).click()
  await page.waitForSelector('[data-testid="live-line"][data-state="waiting"]')
  await page.click('[data-testid="card-workspace"] .desk-title')
  await page.waitForSelector('[data-testid="card-workspace"].front')
  await page.waitForSelector('[data-testid="evidence"]')
  assert.equal(await page.locator('[data-testid="session-roots"], [data-testid="root-add"]').count(), 0)
  assert.equal(stub.requests.filter((r) => r.path === `/api/sessions/${IDS.root}/roots`).length, 0)
})

test('8: the command that ran in the sandbox where full access was asked says so, its reason on hover', async () => {
  await page.getByTestId(`session-${IDS.cmd}`).click()
  await page.waitForFunction(() => document.body.innerText.includes('Built.'), undefined, { timeout: WAIT_MS })
  // the round folded: opened (its rows are what is checked)
  if (!(await page.getByTestId('command-access').count())) await page.locator('.work-head').first().click()
  await page.waitForSelector('[data-testid="command-access"]')
  const pill = page.getByTestId('command-access').first()
  assert.equal((await pill.innerText()).trim(), 'Sandbox')
  assert.equal(await pill.getAttribute('title'), 'Requested Full access · ran in Sandbox\nthe session has no network grant — grant the network to run it with full access')
  assert.deepEqual(errors, [])
})
