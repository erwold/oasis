/** The harness's question before the first Full access command on a machine not confirmed for it, in real Chrome
 *  against the scripted backend started unconfirmed: the command waits where it was asked for, one line and two
 *  answers in the conversation. Use the sandbox: the session goes to the sandbox and the command runs there, the
 *  machine stays unconfirmed. Allow full access: the command runs as the user, and a later session asks nothing. */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright-core'
import { bypassDirector } from './agent-entry.ts'

let server: ChildProcess, browser: Browser, page: Page
let base: string
let info: { token: string; isolation: string }
const failures: string[] = []

before(async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const listener = createServer(); listener.on('error', reject)
    listener.listen(Number(process.env.OASIS_CODE_E2E_PORT || 0), '127.0.0.1', () => { const address = listener.address(); const p = typeof address === 'object' && address ? address.port : 0; listener.close(() => resolve(p)) })
  })
  base = `http://127.0.0.1:${port}`
  console.info(`e2e app port: ${port}`)
  server = spawn('bun', ['run', 'scripts/e2e_server.ts', String(port), '--full-access-unconfirmed'], { cwd: `${process.cwd()}/../backend-ts`, stdio: ['ignore', 'pipe', 'pipe'] })
  info = await new Promise((resolve, reject) => {
    let stdout = '', stderr = ''
    const timeout = setTimeout(() => reject(new Error(`scripted backend did not start: ${stderr}`)), 30_000)
    server.stdout!.on('data', (d) => { stdout += String(d); const line = stdout.split('\n')[0]; if (line.trim().startsWith('{')) { clearTimeout(timeout); resolve(JSON.parse(line)) } })
    server.stderr!.on('data', (d) => { stderr = (stderr + String(d)).slice(-8000) })
    server.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`scripted backend exited ${code}: ${stderr}`)) })
  })
  assert.equal(info.isolation, 'full', 'do not lower sandbox enforcement to run the acceptance path')
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  browser = await chromium.launch(executablePath ? { executablePath, headless: true, args: ['--no-sandbox'] } : { channel: 'chrome', headless: true })
  page = await browser.newPage({ viewport: { width: 1680, height: 1050 } })
  page.on('pageerror', (e) => failures.push(e.message))
}, { timeout: 60_000 })

after(async () => { await browser?.close(); server?.kill('SIGTERM'); assert.deepEqual(failures, []) })

const api = async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
  const res = await fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json', 'x-oasis-code-token': info.token }, body: init.body === undefined ? undefined : JSON.stringify(init.body) })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

/** A new session (Full access, as the app makes them), opened, its words sent to the model that runs one command. */
async function sendInNewSession(title: string): Promise<string> {
  const project = await api<{ id: string }>('/api/projects', { method: 'POST', body: { no_folder: true } })
  const sid = (await api<{ id: string; access_mode: string }>(`/api/projects/${project.id}/sessions`, { method: 'POST', body: { title } })).id
  await page.goto(`${base}/?token=${info.token}`)
  await page.getByTestId(`session-${sid}`).click()
  await bypassDirector(page)
  await page.click('[data-testid="model-picker"]')
  await page.click('[data-testid="model-option-scripted:cmd"]')
  await page.fill('[data-testid="composer"]', 'run it')
  await page.click('[data-testid="send"]')
  return sid
}

type Executions = { runs: { id: string }[] }
const executionsOf = async (sid: string) => {
  const runs = (await api<Executions>(`/api/sessions/${sid}`)).runs
  const out: { isolation: Record<string, unknown> }[] = []
  for (const r of runs) out.push(...(await api<{ executions: { isolation: Record<string, unknown> }[] }>(`/api/runs/${r.id}`)).executions)
  return out
}

test('Use the sandbox: the command waits in the conversation, then runs in the sandbox; the session goes to the sandbox and the machine stays unconfirmed', async () => {
  const sid = await sendInNewSession('to the sandbox')
  // the question waits over the composer, the command it holds shown under it
  const ask = page.locator('[data-testid="full-access-capsule"][data-state="pending"]')
  await ask.waitFor({ timeout: 20_000 })
  assert.match(await ask.innerText(), /Run commands as you on this computer\?/)
  assert.ok((await ask.getByTestId('full-access-command').innerText()).trim().length > 0)
  assert.equal(await page.locator('[data-testid="full-access-ask"]').count(), 0, 'not twice: the thread keeps only the answer')
  assert.equal(await page.locator('dialog[open]').count(), 0, 'asked in the conversation, never a dialog')
  assert.deepEqual(await executionsOf(sid), [], 'the command waits: nothing ran')
  await ask.getByTestId('full-access-sandbox').click()
  await page.waitForSelector('[data-testid="full-access-ask"][data-status="submitted"]')
  assert.equal((await page.getByTestId('full-access-answer').innerText()).trim(), 'Sandbox')
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 30_000 })
  await page.waitForFunction(() => document.querySelector('[data-testid="access-chip"]')?.getAttribute('data-access') === 'sandbox')
  const [ran] = await executionsOf(sid)
  assert.equal(ran!.isolation.access_mode, 'sandbox')
})

test('Allow full access: the command runs as the user, and the next session asks nothing', async () => {
  const sid = await sendInNewSession('allowed')
  const ask = page.locator('[data-testid="full-access-capsule"][data-state="pending"]')
  await ask.waitFor({ timeout: 20_000 })
  await ask.getByTestId('full-access-allow').click()
  await page.waitForSelector('[data-testid="full-access-ask"][data-status="submitted"]')
  assert.equal((await page.getByTestId('full-access-answer').innerText()).trim(), 'Full access')
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 30_000 })
  const [ran] = await executionsOf(sid)
  assert.equal(ran!.isolation.access_mode, 'full')
  assert.equal(ran!.isolation.runtime, 'host')
  // confirmed on this machine: another session's command runs at once
  const next = await sendInNewSession('no question')
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 30_000 })
  assert.equal(await page.locator('[data-testid="full-access-ask"], [data-testid="full-access-capsule"]').count(), 0)
  assert.equal((await executionsOf(next))[0]!.isolation.access_mode, 'full')
})
