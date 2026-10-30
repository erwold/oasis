/** Actual Chrome + actual product API + actual loopback system sshd. No HTTP transport mocks.
 * Model calls use conversation markers, never shared/global steps. No pod/user key/token involved. */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright-core'
import { bypassDirector } from './agent-entry.ts'
const require = createRequire(import.meta.url)
require('./ssh-qa-process-guard.cjs')
const BASE = 'http://127.0.0.1:8399'
let server: ChildProcess, browser: Browser, page: Page
let info: { port: number; root: string; remote_path: string; destination: string; ssh_port: number; identity_file: string; token: string }
let targetId: string
const evidence = join(process.env.OASIS_CODE_E2E_TMP ?? '/tmp', 'ssh-remote-browser-evidence')
const pageErrors: string[] = []
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-oasis-code-token': info.token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const value = await response.json()
  return { status: response.status, value }
}
before(async () => {
  mkdirSync(evidence, { recursive: true })
  server = spawn('bun', ['run', 'scripts/ssh_qa_e2e_server.ts'], { cwd: `${process.cwd()}/../backend-ts`, stdio: ['ignore', 'pipe', 'pipe'] })
  info = await new Promise((resolve, reject) => {
    let stdout = '', stderr = ''
    const timer = setTimeout(() => reject(new Error(`QA SSH server startup timeout: ${stderr.slice(-3000)}`)), 30_000)
    server.stdout!.on('data', (d) => { stdout += String(d); const line = stdout.split('\n')[0]!; if (line.startsWith('{')) { clearTimeout(timer); resolve(JSON.parse(line)) } })
    server.stderr!.on('data', (d) => { stderr += String(d) })
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`QA SSH server exited ${code}: ${stderr.slice(-3000)}`)) })
  })
  assert.equal(info.port, 8399)
  browser = await chromium.launch({ executablePath: process.env.OASIS_CODE_E2E_BROWSER ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(`${BASE}/api/auth/session?token=${info.token}`) // fixture token only; never used for real Jupyter
  await page.getByTestId('composer').waitFor()
}, { timeout: 45_000 })
after(async () => {
  if (page) await page.screenshot({ path: join(evidence, 'final.png') }).catch(() => {})
  await browser?.close()
  if (server && server.exitCode === null) {
    const ended = new Promise<void>((resolve) => server.once('exit', () => resolve()))
    server.kill('SIGTERM') // preload verifies recorded PID/start/full command before signaling
    await ended
  }
  assert.deepEqual(pageErrors, [])
})

async function doneRun(runId: string) {
  let run = (await api('GET', `/api/runs/${runId}`)).value
  for (let i = 0; i < 150 && !['done', 'failed', 'stopped', 'error', 'cancelled'].includes(run.status); i++) {
    await new Promise((r) => setTimeout(r, 200))
    run = (await api('GET', `/api/runs/${runId}`)).value
  }
  return run
}
let remoteProjectId: string

test("an agent connects real sshd on the person's Connect and opens a session in a folder there; that session's command runs on the host; Disconnect and Reconnect stay target-scoped", async () => {
  await bypassDirector(page)
  await page.getByTestId('composer').fill('QA_REMOTE_CONNECT')
  await page.getByTestId('send').click()
  // the question waits over the composer; its name (the title's) is under the host
  const ask = page.getByTestId('ssh-connect-capsule')
  await ask.waitFor({ timeout: 20_000 })
  assert.match(await ask.innerText(), /QA real SSH/)
  assert.equal((await api('GET', '/api/ssh/targets')).value.length, 0, 'nothing saved before the yes')
  await page.getByTestId('ssh-connect-allow').click()
  await page.getByTestId('opened-session').waitFor({ timeout: 30_000 })
  const hosts = await api('GET', '/api/ssh/targets')
  assert.equal(hosts.value.length, 1); assert.equal(hosts.value[0].state, 'ready')
  targetId = hosts.value[0].id
  const remoteProject = (await api('GET', '/api/projects')).value.find((p: { target?: { kind: string; target_id?: string } }) => p.target?.kind === 'ssh' && p.target.target_id === targetId)
  assert.ok(remoteProject, 'the agent opened a project on the host')
  remoteProjectId = remoteProject.id
  const remoteSession = remoteProject.sessions[0]
  await page.getByTestId('opened-session').click()
  await page.locator(`[aria-current="page"][data-testid="session-${remoteSession.id}"]`).waitFor()
  await page.getByTestId('remote-identity').first().waitFor()
  const detail = (await api('GET', `/api/sessions/${remoteSession.id}`)).value
  assert.equal(detail.workspace.target.target_id, targetId)
  const run = await doneRun(detail.runs[0].id)
  writeFileSync(join(evidence, 'remote-run.json'), JSON.stringify(run, null, 2))
  assert.equal(run.status, 'done')
  assert.equal(run.executions.length, 1, 'actual agent bash must create an execution, not just final prose')
  assert.equal(run.executions[0].exit_code, 0)
  await page.screenshot({ path: join(evidence, 'remote-agent.png') })
  await api('POST', `/api/ssh/targets/${targetId}/disconnect`, {})
  await page.locator('[data-testid="ssh-connection"][data-state="disconnected"]').first().waitFor({ timeout: 12_000 })
  const refused = await api('GET', `/api/ssh/targets/${targetId}/dirs?path=${encodeURIComponent(info.remote_path)}`)
  assert.ok(refused.status >= 400, 'manual Disconnect must not implicitly reconnect')
  const unavailable = await api('GET', `/api/workspaces/${detail.workspace.id}/file?path=proof.txt`)
  assert.equal(unavailable.status, 503)
  await page.locator('[data-testid="ssh-connection"]').first().getByRole('button', { name: 'Reconnect' }).click()
  await page.locator('[data-testid="ssh-connection"][data-state="ready"]').first().waitFor()
  await page.screenshot({ path: join(evidence, 'remote-agent-reconnected.png') })
}, { timeout: 60_000 })

test("a new task in that remote project, picked in the rail: the start screen shows the host's connection and no environment picker; the task is a session of that project on the host", async () => {
  assert.ok(targetId && remoteProjectId, 'the first test opened the remote project')
  await page.getByTestId('new-task').click()
  await page.getByTestId(`project-${remoteProjectId}`).click()
  await page.locator('[data-testid="ssh-connection"][data-state="ready"]').waitFor({ timeout: 20_000 })
  assert.equal(await page.locator('[data-testid="execution-target"]').count(), 0)
  await bypassDirector(page)
  const sessionResponse = page.waitForResponse((r) => r.request().method() === 'POST' && /^\/api\/projects\/[^/]+\/sessions$/.test(new URL(r.url()).pathname))
  const runResponse = page.waitForResponse((r) => r.request().method() === 'POST' && /^\/api\/sessions\/[^/]+\/chat$/.test(new URL(r.url()).pathname))
  await page.getByTestId('composer').fill('QA_REMOTE_READ')
  await page.getByTestId('send').click()
  const made = await (await sessionResponse).json()
  assert.equal(made.project_id, remoteProjectId)
  assert.equal(made.workspace.target.target_id, targetId)
  const run = await doneRun((await (await runResponse).json()).id)
  assert.equal(run.status, 'done')
  // the host's proof.txt (one line), read through the session's own workspace there
  const transcript = await api('GET', `/api/runs/${run.id}/transcript`)
  const read = transcript.value.entries.find((e: { tool?: string }) => e.tool === 'read_file')
  assert.deepEqual([read.result.status, read.result.path, read.result.total_lines], ['ok', 'proof.txt', 1])
}, { timeout: 60_000 })
