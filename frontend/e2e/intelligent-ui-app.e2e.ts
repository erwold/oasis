import { bypassDirector } from './agent-entry.ts'
/** Intelligent UI interaction in the real app, end to end: a surface's `run` action starts an agent task (a native
 *  button, or an html page's oasisUI.run inside its own frame), its progress and result come back to the surface that
 *  asked; request_input shows a form and its run waits until the person answers, then goes on with the answer.
 *
 *  What runs: the real backend (createApp — RunManager, the tools, SQLite, REST, SSE — and the built UI from
 *  frontend/dist), started by backend-ts/scripts/ui_e2e_server.ts on a free loopback port with a fresh temporary data
 *  directory, and a separate headless Chromium with its own temporary profile (OASIS_CODE_E2E_BROWSER names a Chromium
 *  executable; without it, channel chrome). Nothing is routed, fulfilled or written to the database by the test: every
 *  request the page makes reaches the real server, and the test reads the server's REST API to check what it holds.
 *
 *  The "models" are SCRIPTED (FIXTURES, frontend/e2e/intelligent-ui-fixtures.ts and the server's scripts): their tool
 *  calls — present_ui, return_ui_result, request_input — are real tool calls through the real loop, and each next
 *  request reads the tool's actual return. This proves the harness's paths; it does not prove that a real model would
 *  choose these tools, and it is not a test of the OS sandbox: the server does not probe isolation (the report is
 *  `unavailable`, asserted below) and runs no command. frontend/e2e/ui.e2e.ts keeps its own gate on a full sandbox.
 *
 *  Waiting: no assertion depends on how fast the frame or the host answers (the frame may or may not share the host
 *  page's thread). Runs that must be seen mid-way are held at named gates the test releases; waits are for a visible
 *  state or a server state, with generous limits.
 *
 *  Locators (docs/intelligent-ui.md §11.3): the frontend's own test ids — a surface `ui-surface-<id>` in the thread;
 *  an action's button `ui-action-<id>` (data-mode="run" for a run action); a task's block `ui-task` (data-status,
 *  data-task-id) with `ui-task-status/text/answer/tools/error/data/stop`; request_input's form `ui-input`
 *  (data-status, data-input-id, data-tool-call) with `ui-input-submit`, `ui-input-dismiss`, `ui-input-state`; the
 *  run's Stop `stop`. Fields are found by their labels. */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection, createServer, type Socket } from 'node:net'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page } from 'playwright-core'
import { parseUiInputRequest, parseUiSurfaceSpec, uiActionMode, validateUiInputValues, UI_LIMITS, type UiInputRecord, type UiTaskRecord } from '@oasis-code/contract'
import {
  ASK_ESTIMATE_FORM, FORM_SUBMIT, FORM_TITLE, GATES, grpoEstimate, HTML_SURFACE, htmlDemoSpec, htmlDemoSpecOnDisk, KL_LIMIT, MARK, NATIVE_SURFACE,
  nativePlannerSpec, requestInputForm, WORDS,
} from './intelligent-ui-fixtures.ts'

let server: ChildProcess
let serverLog = ''
let info: { port: number; token: string; data: string; isolation: string }
let BASE = ''
let browser: Browser

before(async () => {
  server = spawn('bun', ['run', 'scripts/ui_e2e_server.ts'], { cwd: `${process.cwd()}/../backend-ts`, stdio: ['ignore', 'pipe', 'pipe'] })
  info = await new Promise((resolve, reject) => {
    let buf = ''
    server.stdout!.on('data', (d) => {
      buf += String(d)
      const line = buf.split('\n')[0]!
      if (buf.includes('\n') && line.trim().startsWith('{')) resolve(JSON.parse(line))
    })
    server.stderr!.on('data', (d) => { serverLog = (serverLog + String(d)).slice(-20_000) })
    server.on('exit', (code) => reject(new Error(`ui e2e server exited ${code}: ${serverLog.slice(-4_000)}`)))
  })
  BASE = `http://127.0.0.1:${info.port}`
  console.info(`e2e app port: ${info.port}`)
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/meta/build`)).ok) break } catch { /* not yet */ }
    await sleep(100)
  }
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  browser = await chromium.launch(executablePath ? { executablePath, headless: true, args: ['--no-sandbox'] } : { channel: 'chrome', headless: true })
})

after(async () => {
  await browser?.close()
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r))
    server.kill('SIGTERM')
    await Promise.race([exited, sleep(10_000)])
  }
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- the server, read from the test process

async function serverCall<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const r = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'x-oasis-code-token': info.token, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  return { status: r.status, body: (await r.json().catch(() => null)) as T }
}
async function serverGet<T>(path: string): Promise<T> {
  const r = await serverCall<T>(path)
  assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`)
  return r.body
}

/** Poll the server until `ok(value)` (a server state, never a timing of the page); the last value on failure. */
async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  let v = await read()
  while (!ok(v)) {
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v).slice(0, 2_000)}`)
    await sleep(100)
    v = await read()
  }
  return v
}

interface RunView { id: string; status: string }
const sessionDetail = (sid: string) => serverGet<{ runs: RunView[]; active_run: { id: string } | null }>(`/api/sessions/${sid}`)
const runStatus = async (runId: string) => (await serverGet<{ status: string }>(`/api/runs/${runId}`)).status
const waitRun = (runId: string, status: string) => until(`run ${runId} ${status}`, () => runStatus(runId), (s) => s === status)
const getTask = async (sid: string, taskId: string) => (await serverGet<{ task: UiTaskRecord }>(`/api/sessions/${sid}/ui-tasks/${taskId}`)).task
const waitTask = (sid: string, taskId: string, ok: (t: UiTaskRecord) => boolean, what = 'task') => until(`${what} ${taskId}`, () => getTask(sid, taskId), ok)
const surfaceTasks = async (sid: string, runId: string, surfaceId: string) =>
  (await serverGet<{ tasks: UiTaskRecord[] }>(`/api/sessions/${sid}/ui-tasks?run_id=${runId}&surface_id=${surfaceId}`)).tasks
const inputsOf = async (sid: string, runId: string, status?: string) =>
  (await serverGet<{ inputs: UiInputRecord[] }>(`/api/sessions/${sid}/ui-inputs?run_id=${runId}${status ? `&status=${status}` : ''}`)).inputs
const getInput = async (sid: string, id: string) => (await serverGet<{ input: UiInputRecord }>(`/api/sessions/${sid}/ui-inputs/${id}`)).input

interface Seen { model: string; kind: 'task' | 'ask'; action_id?: string; values?: Record<string, unknown>; input?: unknown; prompt_has_values?: boolean; tool_call_id?: string; result?: Record<string, unknown> }
async function seen(): Promise<Seen[]> {
  const r = await fetch(`${BASE}/e2e/seen`, { headers: { authorization: `Bearer ${info.token}` } })
  return r.json() as Promise<Seen[]>
}
async function gate(name: string, op: 'arm' | 'disarm'): Promise<void> {
  const r = await fetch(`${BASE}/e2e/gate?name=${name}&op=${op}`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` } })
  assert.equal(r.status, 200)
}
/** Release a held run: asked until the run is at its gate (its model call may not have begun yet). */
async function release(name: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    const r = await fetch(`${BASE}/e2e/gate?name=${name}&op=release`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` } })
    if (((await r.json()) as { released: boolean }).released) return
    await sleep(100)
  }
  throw new Error(`no run reached the gate ${name}`)
}
/** Let go of a gate a stopped run left (its script was abandoned there) — nothing is waiting for the answer. */
const releaseIfHeld = (name: string) => fetch(`${BASE}/e2e/gate?name=${name}&op=release`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` } }).then(() => undefined)

// ---------------------------------------------------------------- the page

interface App { context: BrowserContext; page: Page; errors: Error[]; base: string }

/** A fresh context (its own storage: a temporary profile of the separate browser process), the app opened with the
 *  token. `base` lets a test reach the server through a relay it can cut. */
async function openApp(base = BASE): Promise<App> {
  const context = await browser.newContext({ viewport: { width: 1680, height: 1050 } })
  const page = await context.newPage()
  const errors: Error[] = []
  page.on('pageerror', (e) => errors.push(e))
  await page.goto(`${base}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]', { timeout: 30_000 })
  return { context, page, errors, base }
}
async function closeApp(app: App): Promise<void> {
  const errors = app.errors.map((e) => e.message)
  await app.context.close()
  assert.deepEqual(errors, [], 'no uncaught error on the page')
}

async function pickModel(page: Page, id: string) {
  await bypassDirector(page)
  await page.click('[data-testid="model-picker"]')
  const label = (await page.locator(`[data-testid="model-option-${id}"] .picker-label`).innerText()).trim()
  await page.click(`[data-testid="model-option-${id}"]`)
  await page.waitForFunction((want) => (document.querySelector('[data-testid="model-current"]')?.textContent ?? '').trim() === want, label, { timeout: 5_000 })
}
const currentSession = async (page: Page) => (await page.locator('[aria-current="page"][data-testid^="session-"]').getAttribute('data-testid'))!.slice('session-'.length)

/** A new task with no folder (the product's own working folder), on a route, through the start screen's composer. */
async function startSession(app: App, model: string, words: string): Promise<string> {
  const { page } = app
  if (await page.locator('[data-testid="folder-clear"]').count()) await page.click('[data-testid="folder-clear"]')
  await pickModel(page, model)
  await page.fill('[data-testid="composer"]', words)
  await page.click('[data-testid="send"]')
  await page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
  return currentSession(page)
}
/** Words sent in the open session's thread composer. */
async function send(page: Page, words: string) {
  await bypassDirector(page)
  await page.fill('[data-testid="composer"]', words)
  await page.click('[data-testid="send"]')
}
/** A hard reload, then the session opened again: everything shown is read back from the server. */
async function reloadInto(page: Page, sessionId: string) {
  await page.reload()
  await page.waitForSelector(`[data-testid="session-${sessionId}"]`, { timeout: 30_000 })
  await page.click(`[data-testid="session-${sessionId}"]`)
  await page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
  await bypassDirector(page)
}
const composerText = (page: Page) => page.locator('[data-testid="composer"]').evaluate((el) => (el.textContent ?? '').replace(/\u00a0/g, ' '))

const surfaceIn = (page: Page, id: string) => page.locator(`[data-testid="thread"] [data-testid="ui-surface-${id}"]`)
/** an action's button (the label checked: the person presses what they read) */
const actionButton = (surface: Locator, id: string, label: string) => surface.locator(`[data-testid="ui-action-${id}"]`).filter({ hasText: label })
/** a task's block on its surface, and the block in a given state */
const taskBlock = (surface: Locator, taskId: string, status?: string) =>
  surface.locator(`[data-testid="ui-task"][data-task-id="${taskId}"]${status ? `[data-status="${status}"]` : ''}`)
const taskStop = (surface: Locator) => surface.locator('[data-testid="ui-task-stop"]')

async function frameIn(surface: Locator): Promise<Frame> {
  const handle = await surface.locator('[data-testid="intelligent-html-frame"]').elementHandle({ timeout: 30_000 })
  const frame = await handle!.contentFrame()
  assert.ok(frame, 'the preview frame')
  return frame
}

/** Every POST the page sends from now on, by path. */
function watchPosts(page: Page) {
  const posts: string[] = []
  const on = (r: { method: () => string; url: () => string }) => { if (r.method() === 'POST') posts.push(new URL(r.url()).pathname) }
  page.on('request', on)
  return { posts, stop: () => page.off('request', on) }
}
const tasksPost = (page: Page, runId: string, surfaceId: string) =>
  page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/ui/${runId}/${surfaceId}/tasks`), { timeout: 30_000 })

/** The present_ui run of a fresh session: its surface in the thread, the run done (a task always comes after it). */
async function presented(app: App, words: string, surfaceId: string) {
  const sessionId = await startSession(app, 'scripted:ui-run', words)
  const surface = surfaceIn(app.page, surfaceId)
  await surface.waitFor({ timeout: 30_000 })
  const surfaceRun = (await surface.getAttribute('data-run'))!
  await waitRun(surfaceRun, 'done')
  await app.page.waitForSelector(`[data-testid="run-${surfaceRun}"][data-status="done"]`, { timeout: 30_000 })
  return { sessionId, surface, surfaceRun }
}

// ---------------------------------------------------------------- the fixtures are the contract's

test('intelligent ui app: the docs demos are what the contract takes (run actions declared, the html under its limit, the form valid)', () => {
  const native = parseUiSurfaceSpec(nativePlannerSpec())
  assert.ok(native.ok, JSON.stringify(!native.ok && native.errors))
  assert.deepEqual(native.value.actions!.map((a) => [a.id, uiActionMode(a)]), [['estimate', 'run'], ['ask_estimate', 'run'], ['sweep', 'run'], ['check', 'run'], ['explain', 'draft']])
  const html = parseUiSurfaceSpec(htmlDemoSpec())
  assert.ok(html.ok, JSON.stringify(!html.ok && html.errors))
  assert.ok(html.value.html!.length < UI_LIMITS.htmlChars)
  assert.deepEqual(html.value.actions!.map((a) => [a.id, uiActionMode(a)]), [['recompute', 'run'], ['ask_recompute', 'run']])
  assert.equal(htmlDemoSpecOnDisk().html_file, 'flow-grpo.html', 'the docs spec names its document, it does not repeat it')
  const form = parseUiInputRequest(requestInputForm())
  assert.ok(form.ok, JSON.stringify(!form.ok && form.errors))
  assert.equal(form.value.title, FORM_TITLE)
  assert.equal(form.value.submit_label, FORM_SUBMIT)
  assert.deepEqual(validateUiInputValues(form.value, {}), { ok: false, errors: ['values.methods: required'] })
  const asking = parseUiInputRequest(ASK_ESTIMATE_FORM)
  assert.ok(asking.ok, JSON.stringify(!asking.ok && asking.errors))
  // the html action's prompt states the data the page reads (a real model has no other way to know it)
  const prompt = String((htmlDemoSpecOnDisk().actions as { prompt: string }[])[0]!.prompt)
  for (const field of ['rollouts_per_step', 'sde_evals_per_step', 'gpu_hours', 'focus', 'phases', 'sampling', 'reward', 'update', '0.05', '0.02', '0.03', '3600']) assert.ok(prompt.includes(field), field)
})

test('intelligent ui app: the server is the real app with no sandbox claimed (isolation unavailable)', () => {
  assert.equal(info.isolation, 'unavailable', 'probe:false — no fake runtime, no fake isolation report')
})

// ---------------------------------------------------------------- html: oasisUI.run inside the frame

test('intelligent ui app: the Flow-GRPO html demo asks the agent from its own frame; progress, data and the answer come back to that frame, its page kept', async () => {
  const app = await openApp()
  const { page } = app
  try {
    const { sessionId, surface, surfaceRun } = await presented(app, WORDS.html, HTML_SURFACE)
    const runsBefore = (await sessionDetail(sessionId)).runs.map((r) => r.id)
    await page.click('[data-testid="composer"]')
    await page.keyboard.type('MY_DRAFT_WORDS')

    await surface.locator('[data-testid="intelligent-html-run"]').click()
    const frame = await frameIn(surface)
    await frame.waitForSelector('#recompute:not([disabled])', { timeout: 30_000 })
    // an empty or fractional count is not computed, saved or sent (no Number('') = 0): said on the page
    await frame.fill('#group_size', '')
    await frame.locator('#fg-invalid').waitFor()
    assert.equal(await frame.textContent('#local_rollouts'), '—')
    assert.equal(await frame.locator('#recompute').isDisabled(), true)
    await frame.fill('#group_size', '2.5')
    assert.equal(await frame.locator('#recompute').isDisabled(), true)
    // the schedule's axis is fixed (0–3): doubling a doubles the bars that are under the cap
    const heights = () => frame.locator('#schedule rect').evaluateAll((rs) => rs.map((r) => [Number(r.getAttribute('height')), r.getAttribute('class')]))
    await frame.fill('#group_size', '24')
    assert.equal(await frame.locator('#fg-invalid').isHidden(), true)
    const at07 = await heights()
    await frame.fill('#noise', '1.4')
    const at14 = await heights()
    const last = at07.length - 1
    assert.ok(at07[last]![1] === null && at14[last]![1] === null, 'the smallest σ is under the cap at both levels')
    assert.ok(Math.abs(at14[last]![0] as number / (at07[last]![0] as number) - 2) < 0.05, JSON.stringify({ at07, at14 }))
    await frame.fill('#noise', '0.7')
    // the page computes locally and holds things of its own (not state): they must outlive the task
    assert.equal(await frame.textContent('#local_rollouts'), String(24 * 32))
    await frame.fill('#scratch', 'notes only this page has')
    await frame.selectOption('#focus', 'stability')
    await frame.evaluate(() => { (window as unknown as { samePage: string }).samePage = 'kept' })
    const scheduleBars = await frame.locator('#schedule rect').count()

    const posts = watchPosts(page)
    await gate(GATES.afterData, 'arm')
    const posted = tasksPost(page, surfaceRun, HTML_SURFACE)
    await frame.click('#recompute')                                    // the person's own click in the frame
    const res = await posted
    assert.equal(res.status(), 202, await res.text())
    const sent = res.request().postDataJSON()
    assert.equal(sent.action_id, 'recompute')
    assert.equal(sent.state.group_size, 24, 'the state on show goes with the task')
    assert.equal(sent.state.focus, 'stability')
    assert.deepEqual(sent.input, { focus: 'stability' }, 'the page\'s input goes with it')
    const started = (await res.json()).task as UiTaskRecord

    // progress: the data arrives in the frame while the agent run is still running (held before its answer). The frame
    // is polled on a timer: it is an opaque-origin frame that may lie below the fold, where Chromium does not run its
    // animation frames (waitForFunction's default polling), however its DOM changes
    const values = { group_size: 24, prompts: 32, sde_steps: 10, noise: 0.7, kl_beta: 0.04, focus: 'stability' }
    const expected = grpoEstimate(values, { focus: 'stability' })
    await frame.waitForFunction((n) => document.getElementById('agent_rollouts')?.textContent === String(n), expected.rollouts_per_step, { timeout: 30_000, polling: 100 })
    const mid = await getTask(sessionId, started.id)
    assert.equal(mid.status, 'running', 'the data came before the task ended')
    assert.ok(mid.agent_run_id)
    assert.equal(await frame.textContent('#agent_gpu'), String(expected.gpu_hours))
    assert.deepEqual(await frame.locator('#phases rect').evaluateAll((rs) => rs.map((r) => [r.getAttribute('data-label'), Number(r.getAttribute('data-value'))])),
      expected.phases.map((p) => [p.label, p.value]), 'the chart is redrawn from the agent\'s data')
    assert.match(await frame.textContent('#fg-status') ?? '', /running/)
    assert.equal(await frame.getAttribute('#agent', 'data-fresh'), 'data', 'the new data, not an old result')
    assert.equal(await frame.textContent('#agent_evals'), String(expected.sde_evals_per_step))
    assert.equal(await frame.locator('#recompute').isDisabled(), true, 'busy while the task runs')

    await release(GATES.afterData)
    await frame.waitForFunction(() => /^succeeded/.test(document.getElementById('fg-status')?.textContent ?? ''), undefined, { timeout: 30_000, polling: 100 })
    const answer = await frame.textContent('#agent_text') ?? ''
    assert.match(answer, new RegExp(`${MARK.estimate} group_size=24 prompts=32 sde_steps=10 focus=stability rollouts=${expected.rollouts_per_step}`))
    // the page's own log of the updates it received: the tool call, the data and the end, each once
    const updateLog = (await frame.textContent('#fg-log')) ?? ''
    assert.equal(updateLog.match(/^tool return_ui_result: /gm)?.length, 1, updateLog)
    assert.equal(updateLog.split('\n').filter((l) => l === `data from ${started.id}`).length, 1, updateLog)
    assert.equal(updateLog.split('\n').filter((l) => l === 'done succeeded').length, 1, updateLog)
    assert.equal(await frame.locator('#recompute').isDisabled(), false, 'not busy after it ends')

    // the same document, its own things kept
    assert.equal(await frame.evaluate(() => (window as unknown as { samePage?: string }).samePage), 'kept', 'the frame was never reloaded')
    assert.equal(await frame.inputValue('#scratch'), 'notes only this page has')
    assert.equal(await frame.inputValue('#group_size'), '24')
    assert.equal(await frame.locator('#schedule rect').count(), scheduleBars)

    // what the server holds, and what the model was handed
    const done = await waitTask(sessionId, started.id, (t) => t.status === 'succeeded')
    assert.deepEqual(done.data, expected)
    assert.equal(done.error, null)
    assert.ok(done.text.includes(MARK.estimate), done.text)
    assert.equal(await runStatus(done.agent_run_id!), 'done')
    const handed = (await seen()).filter((s) => s.kind === 'task' && s.action_id === 'recompute').at(-1)!
    assert.equal(handed.values!.group_size, 24)
    assert.deepEqual(handed.input, { focus: 'stability' })
    // one run more in the conversation (the task's), shown in the thread; the draft untouched; nothing else sent
    const runsAfter = (await sessionDetail(sessionId)).runs.map((r) => r.id)
    assert.deepEqual(runsAfter.filter((id) => !runsBefore.includes(id)), [done.agent_run_id])
    await page.locator(`[data-testid="run-${done.agent_run_id}"]`).waitFor({ timeout: 30_000 })
    assert.equal(await composerText(page), 'MY_DRAFT_WORDS', 'the draft is the person\'s, untouched')
    posts.stop()
    assert.deepEqual(posts.posts.filter((p) => /\/(actions|chat)$/.test(p)), [], 'no draft action, no message sent')
    assert.equal(posts.posts.filter((p) => p.endsWith('/tasks')).length, 1)

    // a reload: the frame (run again) finds its last task's result through oasisUI.tasks(); nothing is started again
    const tasksBefore = (await surfaceTasks(sessionId, surfaceRun, HTML_SURFACE)).length
    const again = watchPosts(page)
    await reloadInto(page, sessionId)
    await surface.locator('[data-testid="intelligent-html-run"]').click()
    const reloaded = await frameIn(surface)
    await reloaded.waitForFunction((n) => document.getElementById('agent_rollouts')?.textContent === String(n), expected.rollouts_per_step, { timeout: 30_000, polling: 100 })
    assert.match(await reloaded.textContent('#fg-status') ?? '', /succeeded/)
    again.stop()
    assert.deepEqual(again.posts.filter((p) => p.endsWith('/tasks')), [], 'no task started by a reload')
    assert.equal((await surfaceTasks(sessionId, surfaceRun, HTML_SURFACE)).length, tasksBefore)
    await page.fill('[data-testid="composer"]', '')
  } finally {
    await gate(GATES.afterData, 'disarm')
    await closeApp(app)
  }
})

// ---------------------------------------------------------------- native: a run button

test('intelligent ui app: the html page\'s own button starts a task whose run asks with request_input; the form is answered in the thread, and the result comes back to the same frame', async () => {
  const app = await openApp()
  const { page } = app
  try {
    const { sessionId, surface, surfaceRun } = await presented(app, WORDS.html, HTML_SURFACE)
    await surface.locator('[data-testid="intelligent-html-run"]').click()
    const frame = await frameIn(surface)
    await frame.waitForSelector('#ask_recompute:not([disabled])', { timeout: 30_000 })
    await frame.fill('#scratch', 'kept while the agent asks')
    await frame.evaluate(() => { (window as unknown as { samePage: string }).samePage = 'kept' })

    const posted = tasksPost(page, surfaceRun, HTML_SURFACE)
    await frame.click('#ask_recompute')                                // the person's own click in the frame
    const res = await posted
    assert.equal(res.status(), 202, await res.text())
    const task = (await res.json()).task as UiTaskRecord
    assert.equal(task.action_id, 'ask_recompute')
    const running = await waitTask(sessionId, task.id, (t) => t.status === 'running' && t.agent_run_id !== null)
    const taskRun = running.agent_run_id!
    const [input] = await until('the task\'s pending input', () => inputsOf(sessionId, taskRun, 'pending'), (l) => l.length === 1)
    assert.equal(input!.run_id, taskRun, 'the form is the task run\'s')
    // the form shows in the thread, under the task's run, and takes an answer; the frame says the task runs meanwhile
    const form = page.locator(`[data-testid="run-${taskRun}"] [data-testid="ui-input"][data-input-id="${input!.id}"][data-status="pending"]`)
    await form.waitFor({ timeout: 30_000 })
    await drawnWhole(form)
    await frame.waitForFunction(() => document.getElementById('fg-status')?.textContent === 'running', undefined, { timeout: 30_000, polling: 100 })
    assert.equal(await frame.locator('#ask_recompute').isDisabled(), true, 'busy while its task waits on the person')
    await form.getByLabel('Prompts per step for this estimate', { exact: true }).fill('64')
    await form.getByRole('radiogroup', { name: 'Focus', exact: true }).getByRole('radio', { name: 'Stability', exact: true }).click()
    const submitted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/ui-inputs/${input!.id}/submit`))
    await form.locator('[data-testid="ui-input-submit"]').click()
    assert.equal((await submitted).status(), 200)

    // the result in the same frame: the data drawn, the answer, the page's own things kept
    const expected = grpoEstimate({ group_size: 16, prompts: 64, sde_steps: 10, noise: 0.7, kl_beta: 0.04, focus: 'cost' }, { focus: 'stability' })
    await frame.waitForFunction((n) => document.getElementById('agent_rollouts')?.textContent === String(n), expected.rollouts_per_step, { timeout: 30_000, polling: 100 })
    await frame.waitForFunction(() => /^succeeded/.test(document.getElementById('fg-status')?.textContent ?? ''), undefined, { timeout: 30_000, polling: 100 })
    assert.equal(await frame.textContent('#agent_focus'), 'stability')
    assert.deepEqual(await frame.locator('#phases rect').evaluateAll((rs) => rs.map((r) => [r.getAttribute('data-label'), Number(r.getAttribute('data-value'))])),
      expected.phases.map((p) => [p.label, p.value]))
    assert.match(await frame.textContent('#agent_text') ?? '', new RegExp(`asked=${input!.id} call=${input!.tool_call_id} task=${task.id}`))
    assert.equal(await frame.evaluate(() => (window as unknown as { samePage?: string }).samePage), 'kept', 'the frame was never reloaded')
    assert.equal(await frame.inputValue('#scratch'), 'kept while the agent asks')

    const done = await waitTask(sessionId, task.id, (t) => t.status === 'succeeded')
    assert.equal(done.agent_run_id, taskRun, 'the same run went on after the answer')
    assert.deepEqual(done.data, expected)
    assert.equal((await getInput(sessionId, input!.id)).status, 'submitted')
    const handed = (await seen()).filter((x) => x.kind === 'ask' && x.tool_call_id === input!.tool_call_id)
    assert.equal(handed.length, 1)
    assert.deepEqual(handed[0]!.result!.values, { prompts: 64, focus: 'stability' })
    assert.equal((await surfaceTasks(sessionId, surfaceRun, HTML_SURFACE)).length, 1, 'one task')
  } finally {
    await closeApp(app)
  }
})

test('intelligent ui app: a native run button starts the agent at once — progress, text and result on the card; the edit just made reaches the model; the draft untouched; the draft button still drafts', async () => {
  const app = await openApp()
  const { page } = app
  try {
    const { sessionId, surface, surfaceRun } = await presented(app, WORDS.native, NATIVE_SURFACE)
    const runsBefore = (await sessionDetail(sessionId)).runs.map((r) => r.id)
    await page.click('[data-testid="composer"]')
    await page.keyboard.type('KEEP_DRAFT')

    assert.equal(await actionButton(surface, 'estimate', 'Estimate with agent').getAttribute('data-mode'), 'run')
    assert.notEqual(await actionButton(surface, 'explain', 'Explain in draft').getAttribute('data-mode'), 'run')
    const posts = watchPosts(page)
    await gate(GATES.afterData, 'arm')
    const posted = tasksPost(page, surfaceRun, NATIVE_SURFACE)
    await surface.getByLabel('Group size', { exact: true }).fill('32')
    const estimateButton = actionButton(surface, 'estimate', 'Estimate with agent')
    await estimateButton.scrollIntoViewIfNeeded()
    const pressedAt = (await estimateButton.boundingBox())!.y
    await estimateButton.click()     // at once: no wait for the save
    const res = await posted
    assert.equal(res.status(), 202, await res.text())
    const sent = res.request().postDataJSON()
    assert.equal(sent.action_id, 'estimate')
    assert.equal(sent.state.group_size, 32, 'the value typed just before the press goes with it')
    const started = (await res.json()).task as UiTaskRecord

    // progress on the card itself: the streamed words and a Stop while it runs
    const block = taskBlock(surface, started.id)
    await taskBlock(surface, started.id, 'running').waitFor({ timeout: 30_000 })
    await block.locator('[data-testid="ui-task-text"]').filter({ hasText: 'Estimating group size 32' }).waitFor({ timeout: 30_000 })
    await taskStop(surface).waitFor({ timeout: 30_000 })
    await waitTask(sessionId, started.id, (t) => t.status === 'running' && t.data !== null)
    // the task's card grows under the action row: the button pressed stays in view above the composer (the rows above
    // the surface may settle by a line as the turn before it stops being the newest), the card below the row
    const footer = surface.locator('footer.uis-foot')
    const stays = async (when: string) => {
      const [btn, f, card] = [await estimateButton.boundingBox(), await footer.boundingBox(), await block.boundingBox()]
      assert.ok(btn && f && card, when)
      const view = await page.locator('[data-testid="thread"]').evaluate((el) => el.getBoundingClientRect().top)
      const dockTop = await page.locator('.composer-dock').evaluate((el) => el.getBoundingClientRect().top)
      assert.ok(btn.y >= view && btn.y + btn.height <= dockTop && Math.abs(btn.y - pressedAt) <= 80,
        `${when}: the button pressed at y=${pressedAt} is at y=${btn.y} (view ${view}..${dockTop})`)
      assert.ok(card.y >= f.y + f.height - 1, `${when}: the task card (y=${card.y}) is under the action row (ends y=${f.y + f.height})`)
    }
    await stays('running, with data')
    await release(GATES.afterData)

    // the result on the same card
    const expected = grpoEstimate({ group_size: 32, prompts: 32, sde_steps: 10, kl_beta: 0.04, noise: 0.7 })
    await taskBlock(surface, started.id, 'succeeded').waitFor({ timeout: 30_000 })
    await block.locator('[data-testid="ui-task-answer"]').filter({ hasText: new RegExp(`${MARK.estimate} group_size=32 prompts=32 sde_steps=10 focus=null rollouts=${expected.rollouts_per_step}`) }).waitFor({ timeout: 30_000 })
    assert.match(await block.locator('[data-testid="ui-task-data"]').innerText(), new RegExp(numRe(expected.sde_evals_per_step)), 'the returned data is on the card')
    await taskStop(surface).waitFor({ state: 'detached', timeout: 30_000 })
    assert.equal(await actionButton(surface, 'estimate', 'Estimate with agent').isEnabled(), true, 'not busy after it ends')
    await stays('done')
    const done = await waitTask(sessionId, started.id, (t) => t.status === 'succeeded')
    assert.deepEqual(done.data, expected)
    const handed = (await seen()).filter((s) => s.kind === 'task' && s.action_id === 'estimate').at(-1)!
    assert.equal(handed.values!.group_size, 32, 'the model was handed the new value')
    assert.equal(handed.prompt_has_values, true)

    // a run of the conversation (shown in the thread), started without the draft
    const runsAfter = (await sessionDetail(sessionId)).runs.map((r) => r.id)
    assert.deepEqual(runsAfter.filter((id) => !runsBefore.includes(id)), [done.agent_run_id])
    await page.locator(`[data-testid="run-${done.agent_run_id}"]`).waitFor({ timeout: 30_000 })
    // its message (the action's prompt with every value as JSON) is folded to a few lines under a one-line source
    const turn = page.locator(`[data-testid="run-${done.agent_run_id}"]`)
    await turn.locator('[data-testid="run-ui-task"]').filter({ hasText: `action estimate on ${NATIVE_SURFACE}` }).waitFor({ timeout: 30_000 })
    const words = turn.locator('[data-testid="run-ui-task-words"]')
    assert.match(await words.getAttribute('class') ?? '', /\bfolded\b/)
    const folded = await words.evaluate((el) => ({ shown: el.getBoundingClientRect().height, whole: el.scrollHeight }))
    assert.ok(folded.shown <= 80 && folded.whole > folded.shown, JSON.stringify(folded))
    assert.equal(await composerText(page), 'KEEP_DRAFT', 'the run button did not touch the draft')
    assert.deepEqual(posts.posts.filter((p) => /\/(actions|chat)$/.test(p)), [], 'no draft action, no message')
    posts.stop()

    // the draft button still drafts — and starts nothing
    const drafted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/ui/${surfaceRun}/${NATIVE_SURFACE}/actions`))
    await actionButton(surface, 'explain', 'Explain in draft').click()
    const action = await drafted
    assert.equal(action.status(), 200)
    assert.equal(action.request().postDataJSON().state.group_size, 32)
    await surface.locator('[data-testid="ui-action-drafted"]').waitFor()
    const draft = await composerText(page)
    assert.ok(draft.startsWith('KEEP_DRAFT') && draft.includes('Explain how these Flow-GRPO values'), draft)
    await sleep(1_000)
    assert.equal((await sessionDetail(sessionId)).runs.length, runsAfter.length, 'a draft action starts no run')
    await page.fill('[data-testid="composer"]', '')
  } finally {
    await gate(GATES.afterData, 'disarm')
    await closeApp(app)
  }
})

test('intelligent ui app: a stopped, a failed and a queued task each end the card\'s busy state (the surface\'s run long done)', async () => {
  const app = await openApp()
  const { page } = app
  try {
    const { sessionId, surface, surfaceRun } = await presented(app, WORDS.native, NATIVE_SURFACE)
    const sweep = actionButton(surface, 'sweep', 'Noise sweep')
    const estimate = actionButton(surface, 'estimate', 'Estimate with agent')

    // Stop: the sweep holds after its first data until stopped
    let posted = tasksPost(page, surfaceRun, NATIVE_SURFACE)
    await sweep.click()
    const sweepTask = (await (await posted).json()).task as UiTaskRecord
    await taskBlock(surface, sweepTask.id).locator('[data-testid="ui-task-text"]').filter({ hasText: MARK.sweepStarted }).waitFor({ timeout: 30_000 })
    const running = await waitTask(sessionId, sweepTask.id, (t) => t.status === 'running' && t.data !== null)
    const cancelled = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/ui-tasks/${sweepTask.id}/cancel`))
    await taskStop(surface).click()
    assert.ok([200, 202].includes((await cancelled).status()))
    const stopped = await waitTask(sessionId, sweepTask.id, (t) => t.status === 'cancelled')
    assert.equal(stopped.error, null)
    assert.equal(await runStatus(running.agent_run_id!), 'cancelled')
    await taskStop(surface).waitFor({ state: 'detached', timeout: 30_000 })
    await taskBlock(surface, sweepTask.id, 'cancelled').waitFor({ timeout: 30_000 })
    assert.equal(await sweep.isEnabled(), true)
    await releaseIfHeld(GATES.sweep)

    // a failure the agent reports: KL beta to its maximum (over the fixture's limit), then Check limits
    const kl = surface.getByLabel('KL beta', { exact: true })
    await kl.focus()
    await page.keyboard.press('End')
    posted = tasksPost(page, surfaceRun, NATIVE_SURFACE)
    await actionButton(surface, 'check', 'Check limits').click()
    const checkRes = await posted
    assert.equal(checkRes.request().postDataJSON().state.kl_beta, 1)
    const checkTask = (await checkRes.json()).task as UiTaskRecord
    const failed = await waitTask(sessionId, checkTask.id, (t) => t.status === 'failed')
    assert.equal(failed.error?.code, 'agent_reported')
    assert.match(failed.error!.message, new RegExp(`over the planner's limit ${KL_LIMIT}`))
    await taskBlock(surface, checkTask.id, 'failed').locator('[data-testid="ui-task-error"]').filter({ hasText: /over the planner's limit/ }).waitFor({ timeout: 30_000 })
    await taskStop(surface).waitFor({ state: 'detached', timeout: 30_000 })
    assert.equal(await estimate.isEnabled(), true)

    // queued behind the conversation's own run: cancelled while queued (never started), then queued again and run
    await send(page, WORDS.holdTurn)
    const turn = await until('the held turn', () => sessionDetail(sessionId), (d) => d.active_run !== null)
    posted = tasksPost(page, surfaceRun, NATIVE_SURFACE)
    await estimate.click()
    const q1res = await posted
    assert.equal(q1res.status(), 202)
    const q1 = (await q1res.json()).task as UiTaskRecord
    assert.equal(q1.status, 'queued')
    assert.equal(q1.agent_run_id, null)
    await taskBlock(surface, q1.id, 'queued').waitFor({ timeout: 30_000 })
    await taskStop(surface).click()
    const q1end = await waitTask(sessionId, q1.id, (t) => t.status === 'cancelled')
    assert.equal(q1end.agent_run_id, null, 'a queued task stopped never ran')
    await taskStop(surface).waitFor({ state: 'detached', timeout: 30_000 })

    posted = tasksPost(page, surfaceRun, NATIVE_SURFACE)
    await estimate.click()
    const q2 = (await (await posted).json()).task as UiTaskRecord
    assert.equal(q2.status, 'queued')
    await sleep(1_500)
    assert.equal((await getTask(sessionId, q2.id)).status, 'queued', 'it waits while the conversation is busy')
    await release(GATES.turn)
    await waitRun(turn.active_run!.id, 'done')
    const q2end = await waitTask(sessionId, q2.id, (t) => t.status === 'succeeded')
    assert.ok(q2end.agent_run_id && q2end.agent_run_id !== turn.active_run!.id)
    await taskBlock(surface, q2.id, 'succeeded').locator('[data-testid="ui-task-answer"]').filter({ hasText: new RegExp(`${MARK.estimate} .*task=${q2.id}`) }).waitFor({ timeout: 30_000 })
    await taskStop(surface).waitFor({ state: 'detached', timeout: 30_000 })
    assert.equal(await estimate.isEnabled(), true)
    // all of them answered to the surface that asked: one surface, its run done since the start
    assert.equal(await runStatus(surfaceRun), 'done')
    const all = await surfaceTasks(sessionId, surfaceRun, NATIVE_SURFACE)
    assert.deepEqual(all.map((t) => [t.action_id, t.status]), [['estimate', 'succeeded'], ['estimate', 'cancelled'], ['check', 'failed'], ['sweep', 'cancelled']])
  } finally {
    await releaseIfHeld(GATES.turn)
    await releaseIfHeld(GATES.sweep)
    await closeApp(app)
  }
})

/** A TCP relay to the server that the test can cut: every connection through it is destroyed and new ones refused
 *  until it is mended — a real break for the page behind it (as in ui.e2e.ts's reconnect test). */
async function cuttableRelay(port: number): Promise<{ port: number; cut: () => void; mend: () => void; close: () => Promise<void> }> {
  const open = new Set<Socket>()
  let broken = false
  const relay = createServer((client) => {
    if (broken) { client.destroy(); return }
    const upstream = createConnection({ host: '127.0.0.1', port })
    open.add(client); open.add(upstream)
    const drop = () => { client.destroy(); upstream.destroy(); open.delete(client); open.delete(upstream) }
    client.on('error', drop); upstream.on('error', drop); client.on('close', drop); upstream.on('close', drop)
    client.pipe(upstream); upstream.pipe(client)
  })
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  return {
    port: (relay.address() as { port: number }).port,
    cut: () => { broken = true; for (const s of [...open]) s.destroy(); open.clear() },
    mend: () => { broken = false },
    close: () => new Promise<void>((resolve) => { for (const s of open) s.destroy(); relay.close(() => resolve()) }),
  }
}

test('intelligent ui app: a hard reload and a broken connection while a task runs neither restart it nor lose its result', async () => {
  const relay = await cuttableRelay(info.port)
  const app = await openApp(`http://127.0.0.1:${relay.port}`)
  const { page, context } = app
  try {
    const { sessionId, surface, surfaceRun } = await presented(app, WORDS.native, NATIVE_SURFACE)
    const posts = watchPosts(page)
    await gate(GATES.afterData, 'arm')
    const posted = tasksPost(page, surfaceRun, NATIVE_SURFACE)
    await actionButton(surface, 'estimate', 'Estimate with agent').click()
    const task = (await (await posted).json()).task as UiTaskRecord
    const live = await waitTask(sessionId, task.id, (t) => t.status === 'running' && t.data !== null)
    const handedBefore = (await seen()).filter((s) => s.kind === 'task').length
    const runsBefore = (await sessionDetail(sessionId)).runs.length

    // a hard reload: the card finds its running task again (its Stop), nothing is started
    await reloadInto(page, sessionId)
    await surface.waitFor({ timeout: 30_000 })
    await taskBlock(surface, task.id, 'running').waitFor({ timeout: 30_000 })
    await taskStop(surface).waitFor({ timeout: 30_000 })
    assert.equal((await surfaceTasks(sessionId, surfaceRun, NATIVE_SURFACE)).length, 1)

    // the connection cut; the task finishes meanwhile (released from the test process); the page comes back
    relay.cut()
    await context.setOffline(true)
    await release(GATES.afterData)
    await waitTask(sessionId, task.id, (t) => t.status === 'succeeded')
    await sleep(1_000)
    relay.mend()
    await context.setOffline(false)
    await taskBlock(surface, task.id, 'succeeded').locator('[data-testid="ui-task-answer"]').filter({ hasText: new RegExp(`${MARK.estimate} .*task=${task.id}`) }).waitFor({ timeout: 30_000 })
    await taskStop(surface).waitFor({ state: 'detached', timeout: 30_000 })

    posts.stop()
    assert.equal(posts.posts.filter((p) => p.endsWith('/tasks')).length, 1, 'one start, by the press')
    assert.equal((await surfaceTasks(sessionId, surfaceRun, NATIVE_SURFACE)).length, 1, 'one task')
    assert.equal((await seen()).filter((s) => s.kind === 'task').length, handedBefore, 'the model was not asked again')
    assert.equal((await sessionDetail(sessionId)).runs.length, runsBefore, 'no run started again')
    assert.equal(await runStatus(live.agent_run_id!), 'done')
  } finally {
    await gate(GATES.afterData, 'disarm')
    await closeApp(app)
    await relay.close()
  }
})

// ---------------------------------------------------------------- request_input

/** A request's form, by the input's id (the page may show it in the thread and in its list of pending inputs: the
 *  first is used). */
const formFor = (page: Page, inputId: string) => page.locator(`[data-testid="ui-input"][data-input-id="${inputId}"]`).first()
/** Everything the form shows, its fields' values included (an input's value is not its text). */
const formShows = (form: Locator) => form.evaluate((el) => [el.textContent ?? '', ...[...el.querySelectorAll('input, select, textarea')].map((f) => {
  if (f instanceof HTMLSelectElement) return [...f.selectedOptions].map((o) => o.value).join(',')
  if (f instanceof HTMLInputElement && f.type === 'checkbox') return f.checked ? 'checked' : 'unchecked'
  return (f as HTMLInputElement).value
}),
// a choice drawn as chips: the values of the chosen ones
...[...el.querySelectorAll('.uis-choices')].map((g) => [...g.querySelectorAll('[aria-checked="true"]')].map((c) => c.getAttribute('data-value') ?? '').join(','))].join(' | '))
/** A form drawn whole: its box as tall as what it holds (no style of another element squeezes or clips it). */
async function drawnWhole(form: Locator) {
  const box = await form.evaluate((el) => ({ height: el.getBoundingClientRect().height, content: el.scrollHeight }))
  assert.ok(box.height >= box.content - 1 && box.height > 120, `the form is drawn whole: ${JSON.stringify(box)}`)
}
/** the forms with this input id in the thread (an answered or closed one is never shown twice) */
const formsIn = (page: Page, inputId: string) => page.locator(`[data-testid="thread"] [data-testid="ui-input"][data-input-id="${inputId}"]`)
/** The answered form, once, under its own run, after the call that showed it and before the answer that followed it. */
async function answeredInPlace(page: Page, runId: string, input: UiInputRecord, answer: string) {
  const turn = page.locator(`[data-testid="run-${runId}"]`)
  const form = turn.locator(`[data-testid="ui-input"][data-input-id="${input.id}"]`)
  await form.waitFor({ timeout: 30_000 })
  assert.equal(await formsIn(page, input.id).count(), 1)
  assert.equal(await form.getAttribute('data-status'), 'submitted')
  await drawnWhole(form)
  assert.equal(await form.getAttribute('data-tool-call'), input.tool_call_id)
  assert.equal(await form.locator('[data-testid="ui-input-submit"]:enabled').count(), 0)
  const shows = await formShows(form)
  for (const v of ['flow-grpo', 'dpo', '12', 'compare at equal compute', 'checked']) assert.ok(shows.includes(v), `${v} in: ${shows}`)
  const words = turn.getByText(answer).first()
  await words.waitFor({ timeout: 30_000 })
  assert.ok(await form.evaluate((f, w) => !!(f.compareDocumentPosition(w as Node) & Node.DOCUMENT_POSITION_FOLLOWING), await words.elementHandle()),
    'the answer the run went on with comes after the form')
}
/** A second session (the start screen, then a message of its own): the page leaves the one on show. */
async function openOtherSession(app: App): Promise<string> {
  await app.page.click('[data-testid="new-task"]')
  await app.page.waitForSelector('[data-testid="hero-composer"]', { timeout: 30_000 })
  const id = await startSession(app, 'scripted:ui-run', WORDS.native)
  await surfaceIn(app.page, NATIVE_SURFACE).waitFor({ timeout: 30_000 })
  return id
}
/** numbers as a page may print them: 10240 or 10,240 */
const numRe = (n: number) => String(n).split('').join('[,\\s]?')

async function askingRun(sessionId: string): Promise<{ runId: string; input: UiInputRecord }> {
  const runId = (await until('a running ask', () => sessionDetail(sessionId), (d) => d.active_run !== null)).active_run!.id
  const [input] = await until('a pending input', () => inputsOf(sessionId, runId, 'pending'), (l) => l.length === 1)
  return { runId, input: input! }
}

test('intelligent ui app: request_input waits for the person; the pending form survives a hard reload; the submitted values are the same call\'s result, the same run goes on, and a reload after it shows the answered form', async () => {
  const app = await openApp()
  const { page } = app
  try {
    const sessionId = await startSession(app, 'scripted:ui-ask', WORDS.ask)
    const { runId, input } = await askingRun(sessionId)
    assert.equal(input.request.title, FORM_TITLE)
    const pendingForm = page.locator(`[data-testid="ui-input"][data-input-id="${input.id}"][data-status="pending"]`).first()
    await pendingForm.waitFor({ timeout: 30_000 })
    assert.equal(await pendingForm.getAttribute('data-tool-call'), input.tool_call_id)
    await drawnWhole(pendingForm)
    const runsBefore = (await sessionDetail(sessionId)).runs.length
    // it waits: nothing moves until the person answers
    await sleep(1_500)
    assert.equal(await runStatus(runId), 'running')
    assert.equal((await getInput(sessionId, input.id)).status, 'pending')
    assert.deepEqual((await seen()).filter((s) => s.kind === 'ask' && s.tool_call_id === input.tool_call_id), [], 'the model has had no answer')

    // values the form refuses (a required key empty) are refused by the server, and the request stays pending
    const refused = await serverCall<{ error: string; errors: string[] }>(`/api/sessions/${sessionId}/ui-inputs/${input.id}/submit`, { method: 'POST', body: { values: { methods: [] } } })
    assert.equal(refused.status, 400)
    assert.equal(refused.body.error, 'invalid_values')
    assert.equal((await getInput(sessionId, input.id)).status, 'pending')

    // a hard reload: the pending form is drawn again from the server (its defaults; edits not submitted are not kept)
    await reloadInto(page, sessionId)
    const form = formFor(page, input.id)
    await form.waitFor({ timeout: 30_000 })
    assert.equal(await form.getAttribute('data-status'), 'pending')
    // the same request: its input id, its run and its call; one form, none made again
    assert.equal(await form.getAttribute('data-run'), runId)
    assert.equal(await form.getAttribute('data-tool-call'), input.tool_call_id)
    assert.equal(await formsIn(page, input.id).count(), 1)
    assert.deepEqual((await inputsOf(sessionId, runId)).map((i) => [i.id, i.tool_call_id]), [[input.id, input.tool_call_id]])
    const methods = form.getByRole('group', { name: 'Methods', exact: true })
    await methods.getByRole('checkbox', { name: 'Flow-GRPO', exact: true }).click()
    await methods.getByRole('checkbox', { name: 'DPO', exact: true }).click()
    await form.getByLabel('Group size', { exact: true }).fill('12')
    await form.getByLabel('Note', { exact: true }).fill('compare at equal compute')
    await form.getByLabel('Use KL penalty', { exact: true }).check()
    const submit = form.locator('[data-testid="ui-input-submit"]')
    assert.match(await submit.innerText(), new RegExp(FORM_SUBMIT))
    const submitted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/ui-inputs/${input.id}/submit`))
    await submit.click()
    const res = await submitted
    assert.equal(res.status(), 200, await res.text())

    // the same run goes on: its answer quotes the call's own result (the scripted model only echoes the values)
    const want = `${MARK.ask} submitted call=${input.tool_call_id} input=${input.id} methods=flow-grpo,dpo group_size=12 note="compare at equal compute" use_kl=true`
    await page.locator('[data-testid="thread"]').getByText(want).first().waitFor({ timeout: 30_000 })
    await waitRun(runId, 'done')
    assert.equal((await sessionDetail(sessionId)).runs.length, runsBefore, 'no new run: the waiting one went on')
    const answered = await getInput(sessionId, input.id)
    assert.equal(answered.status, 'submitted')
    assert.equal(answered.run_id, runId)
    const values = { methods: ['flow-grpo', 'dpo'], group_size: 12, note: 'compare at equal compute', use_kl: true }
    assert.deepEqual(answered.values, values)
    const handed = (await seen()).filter((s) => s.kind === 'ask' && s.tool_call_id === input.tool_call_id)
    assert.equal(handed.length, 1)
    assert.deepEqual(handed[0]!.result, { status: 'submitted', input_id: input.id, values })
    // answered: it takes nothing more
    assert.equal((await serverCall(`/api/sessions/${sessionId}/ui-inputs/${input.id}/submit`, { method: 'POST', body: { values: { methods: ['ppo'], group_size: 4 } } })).status, 409)

    // the run is over; a hard reload shows the same request (its input id and call id) as answered, with the values
    await reloadInto(page, sessionId)
    const after = formFor(page, input.id)
    await after.waitFor({ timeout: 30_000 })
    assert.equal(await after.getAttribute('data-status'), 'submitted')
    assert.equal(await after.getAttribute('data-tool-call'), input.tool_call_id)
    const shows = await formShows(after)
    for (const v of ['flow-grpo', 'dpo', '12', 'compare at equal compute']) assert.ok(shows.includes(v), `${v} in: ${shows}`)
    assert.equal(await after.locator('[data-testid="ui-input-submit"]:enabled').count(), 0, 'an answered form cannot be sent again')
    await answeredInPlace(page, runId, input, want)

    // another session opened, then this one again (no reload): the same one form, where it was, as answered
    const other = await openOtherSession(app)
    assert.equal(await formsIn(page, input.id).count(), 0, 'not in another session')
    await page.click(`[data-testid="session-${sessionId}"]`)
    await page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
    await answeredInPlace(page, runId, input, want)
    assert.notEqual(other, sessionId)

    // the conversation goes on: the next run (it inherits the history) asks with a form of its own; the earlier form
    // stays once, under its own run — not repeated under the next one
    await send(page, WORDS.ask)
    const next = await until('the next ask', () => askingRun(sessionId), (a) => a.runId !== runId)
    const nextForm = formFor(page, next.input.id)
    await nextForm.waitFor({ timeout: 30_000 })
    assert.equal(await page.locator(`[data-testid="run-${next.runId}"] [data-testid="ui-input"]`).count(), 1, 'the next run shows its own form only')
    assert.equal(await page.locator(`[data-testid="run-${next.runId}"] [data-testid="ui-input"][data-input-id="${input.id}"]`).count(), 0)
    await nextForm.locator('[data-testid="ui-input-dismiss"]').click()
    await waitRun(next.runId, 'done')
    await reloadInto(page, sessionId)
    await answeredInPlace(page, runId, input, want)
    await page.locator(`[data-testid="run-${next.runId}"] [data-testid="ui-input"][data-input-id="${next.input.id}"][data-status="dismissed"]`).waitFor({ timeout: 30_000 })
    assert.equal(await formsIn(page, next.input.id).count(), 1)
  } finally {
    await closeApp(app)
  }
})

test('intelligent ui app: request_input declined answers "dismissed" to its call; a Stop while it waits closes it and nothing answers it after', async () => {
  const app = await openApp()
  const { page } = app
  try {
    const sessionId = await startSession(app, 'scripted:ui-ask', WORDS.ask)
    const asked = await askingRun(sessionId)
    const first = formFor(page, asked.input.id)
    await first.waitFor({ timeout: 30_000 })
    const dismissed = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/ui-inputs/${asked.input.id}/dismiss`))
    await first.locator('[data-testid="ui-input-dismiss"]').click()
    assert.equal((await dismissed).status(), 200)
    await page.locator('[data-testid="thread"]').getByText(`${MARK.ask} dismissed call=${asked.input.tool_call_id} input=${asked.input.id}`).first().waitFor({ timeout: 30_000 })
    await waitRun(asked.runId, 'done')
    assert.equal((await getInput(sessionId, asked.input.id)).status, 'dismissed')
    await page.locator(`[data-testid="ui-input"][data-input-id="${asked.input.id}"][data-status="dismissed"]`).first().waitFor({ timeout: 30_000 })

    // asked again, then the run is stopped while it waits
    await send(page, WORDS.ask)
    const again = await until('the second ask', () => askingRun(sessionId), (a) => a.runId !== asked.runId)
    await formFor(page, again.input.id).waitFor({ timeout: 30_000 })
    await page.click('[data-testid="stop"]')
    await waitRun(again.runId, 'cancelled')
    const closed = await until('the closed input', () => getInput(sessionId, again.input.id), (i) => i.status !== 'pending')
    assert.equal(closed.status, 'closed')
    assert.equal(closed.closed_reason, 'cancelled')
    await page.locator(`[data-testid="ui-input"][data-input-id="${again.input.id}"][data-status="closed"]`).first().waitFor({ timeout: 30_000 })
    assert.equal(await formFor(page, again.input.id).locator('[data-testid="ui-input-submit"]:enabled').count(), 0)
    const late = await serverCall<{ error: string }>(`/api/sessions/${sessionId}/ui-inputs/${again.input.id}/submit`, { method: 'POST', body: { values: { methods: ['ppo'], group_size: 4 } } })
    assert.equal(late.status, 409)
    assert.equal(late.body.error, 'not_pending')
    assert.deepEqual((await seen()).filter((s) => s.kind === 'ask' && s.tool_call_id === again.input.tool_call_id), [], 'the stopped run asked the model nothing more')

    // a hard reload: each form once, under its own run, as it ended — neither takes an answer
    await reloadInto(page, sessionId)
    for (const [asking, status] of [[asked, 'dismissed'], [again, 'closed']] as const) {
      const shown = page.locator(`[data-testid="run-${asking.runId}"] [data-testid="ui-input"][data-input-id="${asking.input.id}"][data-status="${status}"]`)
      await shown.waitFor({ timeout: 30_000 })
      assert.equal(await formsIn(page, asking.input.id).count(), 1)
      assert.equal(await shown.getAttribute('data-tool-call'), asking.input.tool_call_id)
      assert.equal(await shown.locator('[data-testid="ui-input-submit"]:enabled').count(), 0)
      assert.equal(await shown.locator('[data-testid="ui-input-dismiss"]:enabled').count(), 0)
    }
  } finally {
    await closeApp(app)
  }
})

test('intelligent ui app: a run action\'s agent asks with request_input mid-task; the person\'s answer goes to that task\'s own run, and its result comes back to the surface that started it', async () => {
  const app = await openApp()
  const { page } = app
  try {
    const { sessionId, surface, surfaceRun } = await presented(app, WORDS.native, NATIVE_SURFACE)
    const runsBefore = (await sessionDetail(sessionId)).runs.length
    const posted = tasksPost(page, surfaceRun, NATIVE_SURFACE)
    await actionButton(surface, 'ask_estimate', 'Ask, then estimate').click()
    const res = await posted
    assert.equal(res.status(), 202, await res.text())
    const task = (await res.json()).task as UiTaskRecord
    const running = await waitTask(sessionId, task.id, (t) => t.status === 'running' && t.agent_run_id !== null)
    const taskRun = running.agent_run_id!
    const [input] = await until('the task\'s pending input', () => inputsOf(sessionId, taskRun, 'pending'), (l) => l.length === 1)
    assert.equal(input!.run_id, taskRun, 'the form belongs to the task\'s run')
    assert.equal(input!.request.title, ASK_ESTIMATE_FORM.title)
    await taskBlock(surface, task.id, 'running').waitFor({ timeout: 30_000 })

    const form = formFor(page, input!.id)
    await form.waitFor({ timeout: 30_000 })
    await form.getByLabel('Prompts per step for this estimate', { exact: true }).fill('64')
    await form.getByRole('radiogroup', { name: 'Focus', exact: true }).getByRole('radio', { name: 'Stability', exact: true }).click()
    const submitted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/ui-inputs/${input!.id}/submit`))
    await form.locator('[data-testid="ui-input-submit"]').click()
    assert.equal((await submitted).status(), 200)

    const expected = grpoEstimate({ group_size: 16, prompts: 64, sde_steps: 10, kl_beta: 0.04, noise: 0.7 }, { focus: 'stability' })
    const done = await waitTask(sessionId, task.id, (t) => t.status === 'succeeded')
    assert.equal(done.agent_run_id, taskRun, 'the same run went on')
    assert.deepEqual(done.data, expected)
    await taskBlock(surface, task.id, 'succeeded').locator('[data-testid="ui-task-answer"]')
      .filter({ hasText: new RegExp(`${MARK.estimate} group_size=16 prompts=64 .*asked=${input!.id} call=${input!.tool_call_id} task=${task.id}`) }).waitFor({ timeout: 30_000 })
    assert.match(await taskBlock(surface, task.id).locator('[data-testid="ui-task-data"]').innerText(), new RegExp(numRe(expected.sde_evals_per_step)))
    assert.equal((await sessionDetail(sessionId)).runs.length, runsBefore + 1, 'one run: the task\'s')
    assert.equal((await getInput(sessionId, input!.id)).status, 'submitted')
    const handed = (await seen()).filter((s) => s.kind === 'ask' && s.tool_call_id === input!.tool_call_id)
    assert.equal(handed.length, 1)
    assert.deepEqual((handed[0]!.result!.values as Record<string, unknown>), { prompts: 64, focus: 'stability' })
  } finally {
    await closeApp(app)
  }
})

test('intelligent ui app: a work order\'s run (a subagent) asks with request_input and its own call gets the answer', async (t) => {
  const app = await openApp()
  const { page } = app
  try {
    const { sessionId } = await presented(app, WORDS.native, NATIVE_SURFACE)
    const ordered = await serverCall<{ id: string }>(`/api/sessions/${sessionId}/work-orders`, {
      method: 'POST', body: { work_order: { label: 'Ask child', prompt: WORDS.ask, model: 'scripted:ui-ask', tools: ['request_input'] } },
    })
    assert.equal(ordered.status, 200, JSON.stringify(ordered.body))
    const child = ordered.body.id
    const [input] = await until('the child\'s pending input', () => inputsOf(sessionId, child, 'pending'), (l) => l.length === 1)
    assert.equal(input!.run_id, child)
    // a run outside the thread (a work order's): its pending form stands in the dock above the composer, answered there
    const docked = page.locator(`[data-testid="pending-inputs"] [data-testid="ui-input"][data-input-id="${input!.id}"][data-status="pending"]`)
    await docked.waitFor({ timeout: 30_000 })
    t.diagnostic(`child request_input forms on the page: ${await page.locator(`[data-testid="ui-input"][data-input-id="${input!.id}"]`).count()}`)
    assert.equal(await docked.getAttribute('data-run'), child)
    await docked.getByRole('group', { name: 'Methods', exact: true }).getByRole('checkbox', { name: 'PPO', exact: true }).click()
    await docked.getByLabel('Group size', { exact: true }).fill('6')
    const answered = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/ui-inputs/${input!.id}/submit`))
    await docked.locator('[data-testid="ui-input-submit"]').click()
    assert.equal((await answered).status(), 200)
    await waitRun(child, 'done')
    const handed = (await seen()).filter((s) => s.kind === 'ask' && s.tool_call_id === input!.tool_call_id)
    assert.equal(handed.length, 1)
    assert.equal(handed[0]!.result!.status, 'submitted')
    assert.deepEqual((handed[0]!.result!.values as Record<string, unknown>).methods, ['ppo'])
  } finally {
    await closeApp(app)
  }
})
