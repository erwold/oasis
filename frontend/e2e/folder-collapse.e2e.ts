/** Run alone after npm run build. Headless installed Chrome with a persistent temporary profile and backend/DB.
 *  Wait for 8399 without touching its owner. Only the exact child PIDs recorded here may be stopped/restarted. */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { bypassDirector } from './agent-entry.ts'

const PORT = Number(process.env.OASIS_CODE_E2E_PORT ?? 8399)
assert.ok(![8321, 8324].includes(PORT), 'never use a user listener')
const BASE = `http://127.0.0.1:${PORT}`
const DIST = fileURLToPath(new URL('../dist', import.meta.url))
const ARTIFACTS = process.env.OASIS_CODE_COLLAPSE_ARTIFACTS ?? mkdtempSync(join(tmpdir(), 'collapse-artifacts-'))
mkdirSync(ARTIFACTS, { recursive: true })
const ROOT = mkdtempSync(join(tmpdir(), 'collapse-backend-'))
const PROFILE = mkdtempSync(join(tmpdir(), 'collapse-profile-'))
const TOKEN = 'pin-e2e-token'
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (line: string) => { console.log(`[collapse] ${line}`); appendFileSync(join(ARTIFACTS, 'lifecycle.log'), `${new Date().toISOString()} ${line}\n`) }
let child: ChildProcess | undefined
let browser: BrowserContext | undefined

function portFree(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(PORT, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}
async function start(): Promise<{ folder: string }> {
  while (!(await portFree())) { log(`port ${PORT} occupied; waiting, owner untouched`); await pause(2000) }
  const owned = spawn('bun', ['run', 'scripts/pin_sessions_server.ts', String(PORT), ROOT], {
    cwd: fileURLToPath(new URL('../../backend-ts', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OASIS_CODE_FRONTEND_DIST: DIST },
  })
  child = owned
  assert.ok(owned.pid)
  log(`START owned PID=${owned.pid} port=${PORT} root=${ROOT}`)
  appendFileSync(join(ARTIFACTS, 'pids.log'), `${owned.pid}\n`)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('temporary backend not ready in 30s')), 30_000)
    let buffer = ''
    owned.stdout!.on('data', (chunk) => {
      appendFileSync(join(ARTIFACTS, 'backend.log'), chunk)
      buffer += String(chunk)
      for (;;) {
        const end = buffer.indexOf('\n')
        if (end < 0) break
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (line.startsWith('{')) {
          const info = JSON.parse(line)
          if (info.ready) { clearTimeout(timer); assert.equal(info.pid, owned.pid); resolve(info) }
        }
      }
    })
    owned.stderr!.on('data', (chunk) => appendFileSync(join(ARTIFACTS, 'backend.log'), chunk))
    owned.once('error', (e) => { clearTimeout(timer); reject(e) })
    owned.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`temporary backend exited ${code}/${signal}`)) })
  })
}
async function stop(): Promise<void> {
  const owned = child
  if (!owned?.pid) return
  const pid = owned.pid
  if (owned.exitCode === null && owned.signalCode === null) {
    log(`STOP owned PID=${pid} SIGTERM`)
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { log(`STOP owned PID=${pid} SIGKILL after grace`); owned.kill('SIGKILL') }, 10_000)
      owned.once('exit', () => { clearTimeout(timeout); resolve() })
      owned.kill('SIGTERM')
    })
  }
  assert.throws(() => process.kill(pid, 0), (e: NodeJS.ErrnoException) => e.code === 'ESRCH')
  log(`CLEANED owned PID=${pid} exit=${owned.exitCode} signal=${owned.signalCode}; kill(pid,0)=ESRCH`)
  child = undefined
}
async function api<T = Record<string, any>>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-oasis-code-token': TOKEN, origin: BASE, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  assert.ok(res.ok, `${path}: ${res.status} ${text}`)
  return JSON.parse(text)
}
const pinnedIds = (page: Page) => page.locator('[data-testid="rail-pinned"] .rail-session').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid')!.slice('session-'.length)))
async function expectPins(page: Page, ids: string[]) {
  await page.waitForFunction((ids) => JSON.stringify([...document.querySelectorAll('[data-testid="rail-pinned"] .rail-session')].map((r) => r.getAttribute('data-testid')!.slice('session-'.length))) === JSON.stringify(ids), ids, { timeout: 45_000 })
  assert.deepEqual(await pinnedIds(page), ids)
  for (const id of ids) assert.equal(await page.getByTestId(`session-${id}`).count(), 1)
}
async function pinMenu(page: Page, id: string, rightClick: boolean, label: 'Pin' | 'Unpin') {
  const row = page.getByTestId(`session-${id}`)
  if (rightClick) await row.click({ button: 'right' })
  else { await row.hover(); await page.getByTestId(`session-more-${id}`).click() }
  await page.getByRole('menuitem', { name: label, exact: true }).click()
}

async function launch(): Promise<Page> {
  browser = await chromium.launchPersistentContext(PROFILE, { headless: true, channel: 'chrome', viewport: { width: 1200, height: 800 } })
  log(`START owned Chrome persistent context profile=${PROFILE}`)
  return browser.pages()[0] ?? await browser.newPage()
}
async function closeBrowser() {
  if (!browser) return
  await browser.close()
  browser = undefined
  log(`CLOSED owned Chrome persistent context profile=${PROFILE}`)
}
async function gate(mode: 'hold' | 'release') {
  const response = await fetch(`${BASE}/e2e/pins/gate?mode=${mode}`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })
  assert.equal(response.status, 200)
}
async function expectCollapsed(page: Page, ids: string[]) {
  for (const id of ids) {
    const header = page.getByTestId(`project-${id}`)
    await header.waitFor()
    assert.equal(await header.getAttribute('aria-expanded'), 'false')
    const group = page.locator('.rail-project', { has: header })
    assert.equal(await group.locator('.rail-session').count(), 0)
    assert.equal(await header.locator('[data-dot], .rail-dot').count(), 0, 'no project-level running badge added')
  }
}
async function projectPoll(page: Page) {
  const response = await page.waitForResponse((r) => new URL(r.url()).pathname === '/api/projects' && r.request().method() === 'GET', { timeout: 45_000 })
  return await response.json() as { id: string; sessions: { id: string }[] }[]
}
async function shot(page: Page, name: string) {
  await page.mouse.move(600, 600) // do not cover the ordinary counts with hover actions
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`) })
}

while (!(await portFree())) { log(`port ${PORT} occupied; waiting, owner untouched`); await pause(2000) }

test('folder disclosure persists across a real Chrome/profile and owned backend restart without hiding pins or changing the current conversation', { timeout: 240_000 }, async () => {
  const errors: string[] = []
  let page: Page | undefined
  try {
    assert.ok(existsSync(join(DIST, 'index.html')), 'build this worktree first')
    const info = await start()
    const meta = await api('/api/meta/build')
    assert.equal(meta.ui_build, JSON.parse(readFileSync(join(DIST, 'build.json'), 'utf8')).ui_build)
    assert.equal(meta.schema_version, 37)
    log(`verified build=${meta.ui_build} schema=${meta.schema_version}`)
    const folder = await api('/api/projects', { source_path: info.folder, mode: 'direct', name: 'A long project name for checking the compact disclosure and new task button' })
    const noFolder = await api('/api/projects', { no_folder: true })
    const current = await api(`/api/projects/${folder.id}/sessions`, { title: 'Current conversation stays open', model: 'scripted:a' })
    const pin = await api(`/api/projects/${folder.id}/sessions`, { title: 'Always visible pin', model: 'scripted:a' })
    const member = await api(`/api/projects/${noFolder.id}/sessions`, { title: 'Cross-folder task member', model: 'scripted:a', task_session_id: current.id })
    const own = await api(`/api/projects/${noFolder.id}/sessions`, { title: 'No folder conversation', model: 'scripted:a' })
    const ids = [folder.id, noFolder.id]
    const attach = (p: Page) => { p.on('pageerror', (e) => { errors.push(e.message); log(`PAGE ERROR ${e.message}`) }) }
    page = await launch(); attach(page)
    await page.goto(`${BASE}/?token=${TOKEN}`)
    await page.getByTestId(`session-${current.id}`).waitFor()
    for (const id of ids) assert.equal(await page.getByTestId(`project-${id}`).getAttribute('aria-expanded'), 'true')
    await pinMenu(page, pin.id, false, 'Pin'); await expectPins(page, [pin.id])
    await page.getByTestId(`session-${current.id}`).click()
    await page.locator(`[data-testid="session-${current.id}"][aria-current="page"]`).waitFor()
    assert.equal(await page.locator('.thread-title').innerText(), current.title)
    await shot(page, 'expanded')

    // Hover/focus actions share a reserved slot with the ordinary count, including a long name and No folder.
    for (const id of ids) {
      const header = page.getByTestId(`project-${id}`), plus = page.getByTestId(`project-new-${id}`)
      await header.hover()
      await page.waitForFunction((id) => { const e = document.querySelector(`[data-testid="project-new-${id}"]`); return e && getComputedStyle(e).opacity === '1' }, id)
      const label = (await header.locator('.nav-label').boundingBox())!, action = (await plus.boundingBox())!
      assert.ok(label.x + label.width <= action.x, 'the name cannot extend under the new-task action')
      await plus.focus()
      await page.waitForFunction((id) => { const e = document.querySelector(`[data-testid="project-new-${id}"]`); return e && getComputedStyle(e).opacity === '1' }, id)
      assert.equal(await header.evaluate((e) => e.getBoundingClientRect().height), 32)
    }
    await page.getByTestId(`project-${folder.id}`).hover()
    await page.screenshot({ path: join(ARTIFACTS, 'long-name-hover.png') })

    await page.getByTestId(`project-${noFolder.id}`).click()
    assert.equal(await page.getByTestId(`session-${own.id}`).count(), 0)
    assert.equal(await page.getByTestId(`session-${member.id}`).count(), 1, 'physical No folder collapse leaves the member in its displayed root group')
    await page.getByTestId(`project-${folder.id}`).click()
    await expectCollapsed(page, ids); await expectPins(page, [pin.id])
    assert.equal(await page.locator('.thread-title').innerText(), current.title)
    // Native button keyboard behavior, with no nested buttons and no custom key handlers.
    await page.getByTestId(`project-${folder.id}`).focus(); await page.keyboard.press('Enter')
    assert.equal(await page.getByTestId(`session-${member.id}`).count(), 1)
    await page.keyboard.press('Space')
    await expectCollapsed(page, ids)
    await shot(page, 'collapsed')

    await bypassDirector(page)
    await gate('hold')
    const message = 'A new message while this folder is collapsed'
    const started = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/sessions/${current.id}/chat` && r.request().method() === 'POST')
    await page.getByTestId('composer').fill(message); await page.getByTestId('composer').press('Enter')
    const response = await started
    assert.equal(response.status(), 200)
    const run = await response.json()
    await page.locator('.thread-header [data-testid="stop"]').waitFor()
    await projectPoll(page)
    assert.equal((await api(`/api/runs/${run.id}`)).status, 'running')
    await expectCollapsed(page, ids); await expectPins(page, [pin.id])
    assert.equal(await page.locator('.thread-title').innerText(), current.title)
    await page.getByText(message, { exact: true }).first().waitFor()
    await shot(page, 'running-collapsed')
    await gate('release')
    const deadline = Date.now() + 30_000
    while ((await api(`/api/runs/${run.id}`)).status === 'running' && Date.now() < deadline) await pause(100)
    assert.equal((await api(`/api/runs/${run.id}`)).status, 'done')
    await page.locator('.thread-header [data-testid="stop"]').waitFor({ state: 'detached' })
    const added = await api(`/api/projects/${noFolder.id}/sessions`, { title: 'Arrived while No folder was collapsed', model: 'scripted:a' })
    const rows = await projectPoll(page)
    assert.ok(rows.find((p) => p.id === noFolder.id)!.sessions.some((s) => s.id === added.id))
    await expectCollapsed(page, ids); await expectPins(page, [pin.id])
    assert.equal(await page.locator('.thread-title').innerText(), current.title)
    await shot(page, 'completed-collapsed')
    await page.reload()
    await expectCollapsed(page, ids); await expectPins(page, [pin.id])
    log('running, new message, completion, new session and page reload never expanded either group; main conversation stayed open while toggling')

    // Close the actual Chrome process/context, not just the page, and relaunch against the same on-disk profile.
    await closeBrowser()
    await stop(); await start()
    page = await launch(); attach(page)
    await page.goto(`${BASE}/?token=${TOKEN}`)
    await expectCollapsed(page, ids); await expectPins(page, [pin.id])
    await shot(page, 'restarted')
    log(`real Chrome and owned backend restart retained both collapsed folders; profile=${PROFILE}`)
    await page.getByTestId(`project-${folder.id}`).click()
    await page.getByTestId(`project-${noFolder.id}`).click()
    for (const s of [current, member, own, added]) assert.equal(await page.getByTestId(`session-${s.id}`).count(), 1)
    await expectPins(page, [pin.id])
    await shot(page, 'expanded-after-restart')

    // From an open A conversation, the independent + creates in B, not A, and leaves B collapsed.
    await page.getByTestId(`session-${current.id}`).click()
    await page.locator(`[data-testid="session-${current.id}"][aria-current="page"]`).waitFor()
    await page.getByTestId(`project-${noFolder.id}`).click()
    const plus = page.getByTestId(`project-new-${noFolder.id}`)
    await plus.focus(); await page.keyboard.press('Enter')
    assert.equal(await page.locator('.thread-title').count(), 0)
    await expectCollapsed(page, [noFolder.id])
    await bypassDirector(page)
    const made = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/projects/${noFolder.id}/sessions` && r.request().method() === 'POST')
    await page.getByTestId('composer').fill('Created using No folder plus'); await page.getByTestId('composer').press('Enter')
    const created = await made
    assert.equal(created.status(), 200)
    assert.equal((await created.json()).project_id, noFolder.id)
    await expectCollapsed(page, [noFolder.id]); await expectPins(page, [pin.id])
    assert.deepEqual(errors, [])
    log('expanded rows return; + chooses the requested folder after closing another session; no page errors')
  } catch (error) {
    log(`FAILED ${String(error)}; pageErrors=${JSON.stringify(errors)}`)
    await page?.screenshot({ path: join(ARTIFACTS, 'failure.png') }).catch(() => undefined)
    throw error
  } finally {
    try { await closeBrowser() } finally {
      await stop()
      log(`port ${PORT} free=${await portFree()}; artifacts=${ARTIFACTS}; temporary backend root=${ROOT}; profile=${PROFILE}`)
    }
  }
})
