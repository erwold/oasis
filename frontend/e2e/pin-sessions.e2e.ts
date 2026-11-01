/** Run alone after npm run build. Headless installed Chrome, two independent contexts, real temporary backend/DB.
 *  Wait for 8399 without touching its owner. Only the exact child PIDs recorded here may be stopped/restarted. */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright-core'
import { bypassDirector } from './agent-entry.ts'

const PORT = Number(process.env.OASIS_CODE_E2E_PORT ?? 8399)
assert.ok(![8321, 8324].includes(PORT), 'never use a user listener')
const BASE = `http://127.0.0.1:${PORT}`
const DIST = fileURLToPath(new URL('../dist', import.meta.url))
const ARTIFACTS = process.env.OASIS_CODE_PIN_ARTIFACTS ?? mkdtempSync(join(tmpdir(), 'pin-artifacts-'))
mkdirSync(ARTIFACTS, { recursive: true })
const ROOT = mkdtempSync(join(tmpdir(), 'pin-backend-'))
const TOKEN = 'pin-e2e-token'
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (line: string) => { console.log(`[pins] ${line}`); appendFileSync(join(ARTIFACTS, 'lifecycle.log'), `${new Date().toISOString()} ${line}\n`) }
let child: ChildProcess | undefined
let browser: Browser | undefined

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
async function state(id: string, status: string) {
  const res = await fetch(`${BASE}/e2e/pins/status?id=${id}&status=${status}`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })
  assert.equal(res.status, 200)
}

// Wait before starting the timed scenario: an occupied shared port is not a reason to terminate its owner.
while (!(await portFree())) { log(`port ${PORT} occupied; waiting, owner untouched`); await pause(2000) }

test('pinned runs never reorder folders; pins sync between live clients and survive only our backend restart', { timeout: 240_000 }, async () => {
  const errors: string[] = []
  try {
    assert.ok(existsSync(join(DIST, 'index.html')), 'build this worktree first')
    const info = await start()
    const meta = await api('/api/meta/build')
    const built = JSON.parse(readFileSync(join(DIST, 'build.json'), 'utf8'))
    assert.equal(meta.ui_build, built.ui_build)
    assert.equal(meta.schema_version, 37)
    log(`verified build=${meta.ui_build} schema=${meta.schema_version}`)
    const folder = await api('/api/projects', { source_path: info.folder, mode: 'direct' })
    const noFolder = await api('/api/projects', { no_folder: true })
    const a = await api(`/api/projects/${folder.id}/sessions`, { title: 'Folder pin', model: 'scripted:a' })
    const member = await api(`/api/projects/${noFolder.id}/sessions`, { title: 'Unpinned task member', model: 'scripted:a', task_session_id: a.id })
    const b = await api(`/api/projects/${noFolder.id}/sessions`, { title: 'No folder pin', model: 'scripted:a' })
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    const left = await browser.newContext({ viewport: { width: 1200, height: 800 } })
    const right = await browser.newContext({ viewport: { width: 1200, height: 800 } })
    const page = await left.newPage(), peer = await right.newPage()
    for (const p of [page, peer]) {
      p.on('pageerror', (e) => { errors.push(e.message); log(`PAGE ERROR ${e.message}`) })
      await p.goto(`${BASE}/?token=${TOKEN}`)
      await p.getByTestId(`session-${a.id}`).waitFor()
    }
    // Both clients are already open. The peer is never reloaded for these synchronization assertions.
    await pinMenu(page, a.id, true, 'Pin')
    await expectPins(page, [a.id]); await expectPins(peer, [a.id])
    const anchor = page.getByTestId(`rail-task-${a.id}`)
    assert.equal(await anchor.getByTestId(`session-${member.id}`).count(), 1)
    assert.equal(await anchor.locator('..').getAttribute('class'), 'rail-project')
    await pinMenu(page, b.id, false, 'Pin')
    await expectPins(page, [a.id, b.id]); await expectPins(peer, [a.id, b.id])
    log('two already-open independent contexts synchronized Pin via normal project polling')


    // A = No folder (pinned b), B = the folder. B has newer ordinary work and must stay first while b runs.
    await api(`/api/projects/${folder.id}/sessions`, { title: 'B newer ordinary work', model: 'scripted:a' })
    const projectIds = [folder.id, noFolder.id]
    const expectProjects = async (p: Page, ids = projectIds) => {
      await p.waitForFunction((ids) => JSON.stringify([...document.querySelectorAll('.rail-project-head')].map((r) => r.getAttribute('data-testid')!.slice('project-'.length))) === JSON.stringify(ids), ids, { timeout: 45_000 })
      assert.deepEqual(await p.locator('.rail-project-head').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid')!.slice('project-'.length))), ids)
    }
    const gate = async (mode: 'hold' | 'release') => {
      const res = await fetch(`${BASE}/e2e/pins/gate?mode=${mode}`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })
      assert.equal(res.status, 200)
    }
    const pollProjects = async (p: Page) => {
      const response = await p.waitForResponse((r) => new URL(r.url()).pathname === '/api/projects' && r.request().method() === 'GET', { timeout: 45_000 })
      const rows = await response.json()
      assert.deepEqual(rows.map((r: { id: string }) => r.id), projectIds)
      await expectProjects(p)
    }
    await expectProjects(page); await expectProjects(peer)
    await page.getByTestId(`session-${b.id}`).click()
    await page.locator(`[data-testid="session-${b.id}"][aria-current="page"]`).waitFor()
    await bypassDirector(page)
    await page.getByTestId('rail').screenshot({ path: join(ARTIFACTS, 'before.png') })
    const before = await api(`/api/sessions/${b.id}`)
    await gate('hold')
    const started = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/sessions/${b.id}/chat` && r.request().method() === 'POST')
    await page.getByTestId('composer').fill('Run the pinned No folder session without moving its folder')
    await page.getByTestId('composer').press('Enter')
    const response = await started
    assert.equal(response.status(), 200)
    const run = await response.json()
    await page.getByTestId(`session-${b.id}`).locator('[data-dot="running"]').waitFor()
    await peer.getByTestId(`session-${b.id}`).locator('[data-dot="running"]').waitFor()
    // Real post-send project refreshes on both clients, no reload and no intercepted API responses.
    await pollProjects(page); await pollProjects(peer)
    await expectPins(page, [a.id, b.id]); await expectPins(peer, [a.id, b.id])
    assert.equal((await api(`/api/runs/${run.id}`)).status, 'running')
    const running = await api(`/api/sessions/${b.id}`)
    assert.ok(running.last_activity_at > before.last_activity_at)
    assert.equal(running.pin_order, before.pin_order)
    await page.getByTestId('rail').screenshot({ path: join(ARTIFACTS, 'running.png') })
    log(`running pinned session=${b.id} run=${run.id}: B remains before No folder across both clients' polling`)
    await gate('release')
    const deadline = Date.now() + 30_000
    while ((await api(`/api/runs/${run.id}`)).status === 'running' && Date.now() < deadline) await pause(100)
    assert.equal((await api(`/api/runs/${run.id}`)).status, 'done')
    await page.getByTestId(`session-${b.id}`).locator('[data-dot="running"]').waitFor({ state: 'detached' })
    await pollProjects(page); await pollProjects(peer)
    await page.getByTestId('rail').screenshot({ path: join(ARTIFACTS, 'after.png') })
    for (const p of [page, peer]) {
      await p.reload()
      await expectProjects(p); await expectPins(p, [a.id, b.id])
    }
    await page.getByTestId('rail').screenshot({ path: join(ARTIFACTS, 'after-refresh.png') })
    // Unpin restores all of b's recorded activity immediately; pin removes it again (without a reload).
    await pinMenu(page, b.id, true, 'Unpin')
    await expectProjects(page, [noFolder.id, folder.id]); await expectProjects(peer, [noFolder.id, folder.id])
    await pinMenu(page, b.id, false, 'Pin')
    await expectProjects(page); await expectProjects(peer)
    await expectPins(page, [a.id, b.id]); await expectPins(peer, [a.id, b.id])
    log('pinned completion, refresh and immediate unpin/re-pin folder ordering verified')

    await page.getByTestId(`project-new-${noFolder.id}`).click()
    await bypassDirector(page)
    await page.getByTestId('composer').fill('Newest No folder task')
    await page.getByTestId('composer').press('Enter')
    await page.waitForFunction(() => [...document.querySelectorAll('.rail-session')].some((r) => r.textContent === 'Newest No folder task'), undefined, { timeout: 30_000 })
    await expectPins(page, [a.id, b.id]); await expectPins(peer, [a.id, b.id])
    assert.equal(await page.locator('.rail-session').first().getAttribute('data-testid'), `session-${a.id}`)
    assert.equal(await page.locator('.rail-project-head').first().getAttribute('data-testid'), `project-${noFolder.id}`)
    assert.equal((await api(`/api/sessions/${a.id}`)).updated_at, a.updated_at)
    assert.equal((await api(`/api/sessions/${a.id}`)).last_activity_at, a.last_activity_at)
    await page.locator('[data-testid="rail"]').screenshot({ path: join(ARTIFACTS, 'rail-pinned.png') })
    await page.getByTestId(`session-${a.id}`).hover()
    await page.getByTestId(`session-more-${a.id}`).click()
    await page.getByRole('menuitem', { name: 'Unpin', exact: true }).waitFor()
    const rail = (await page.getByTestId('rail').boundingBox())!, menu = (await page.getByRole('menu').boundingBox())!
    await page.screenshot({ path: join(ARTIFACTS, 'rail-unpin-menu.png'), clip: { x: rail.x, y: rail.y, width: Math.ceil(Math.max(rail.x + rail.width, menu.x + menu.width) - rail.x), height: rail.height } })
    await page.locator('.picker-backdrop').click({ position: { x: 900, y: 500 } })
    log(`new No folder task did not move pins; rail-only screenshots=${ARTIFACTS}`)

    await stop()
    await start() // same temporary DB, new recorded PID; never the user's service
    for (const p of [page, peer]) await p.goto(`${BASE}/?token=${TOKEN}`)
    await expectPins(page, [a.id, b.id]); await expectPins(peer, [a.id, b.id])
    log('both contexts reopened against restarted temporary backend: pin order persisted')
    await pinMenu(page, a.id, false, 'Unpin')
    await expectPins(page, [b.id]); await expectPins(peer, [b.id])
    assert.equal(await page.getByTestId(`rail-task-${a.id}`).getByTestId(`session-${a.id}`).count(), 1)
    await pinMenu(page, a.id, true, 'Pin')
    await expectPins(page, [b.id, a.id]); await expectPins(peer, [b.id, a.id])
    await state(a.id, 'archived')
    await expectPins(page, [b.id]); await expectPins(peer, [b.id])
    assert.equal((await api(`/api/sessions/${a.id}`)).pin_order, null)
    await state(a.id, 'open')
    assert.equal((await api(`/api/sessions/${a.id}`)).pin_order, null)
    await expectPins(page, [b.id]); await expectPins(peer, [b.id])
    await page.getByTestId(`session-${b.id}`).hover()
    await page.getByTestId(`session-more-${b.id}`).click()
    await page.getByTestId('session-delete').click()
    await page.getByTestId('session-delete').click()
    await expectPins(page, []); await expectPins(peer, [])
    assert.equal(await page.getByTestId(`session-${b.id}`).count(), 0)
    assert.equal(await peer.getByTestId(`session-${b.id}`).count(), 0)
    assert.deepEqual(errors, [])
    log('Unpin returns to original task; re-pin appends; archive/restore never revives pin; UI delete syncs; no page errors')
  } catch (error) {
    log(`FAILED ${String(error)}; pageErrors=${JSON.stringify(errors)}`)
    for (const [i, context] of (browser?.contexts() ?? []).entries()) {
      const page = context.pages()[0]
      if (page) await page.screenshot({ path: join(ARTIFACTS, `failure-${i}.png`) }).catch(() => undefined)
    }
    throw error
  } finally {
    try { await browser?.close() } finally {
      await stop()
      log(`port ${PORT} free=${await portFree()}; artifacts=${ARTIFACTS}; temporary backend root=${ROOT}`)
    }
  }
})
