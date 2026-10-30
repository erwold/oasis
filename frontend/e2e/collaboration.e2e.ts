/** The collaboration model in the browser (docs/multi-agent-frontend-implementation.md), in real Chrome against the
 *  scripted backend (no model is called; the provider is the backend's scripted fixture): a separate task from the
 *  composer is summarised in the thread — how many, each one's state — and a click brings its card forward, taken back
 *  from the shelf; its card is continued; the relations a harness records (a run cited and a run handed over, never
 *  one for the other) are read from GET /api/sessions/:id/collaboration — here answered by the page's own route
 *  handler with a fixture over the session's real run ids, since this backend may predate the route; a backend
 *  without it (404) falls back silently, a failing one (500) is said once and the page stays usable. */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type Page, type Route } from 'playwright-core'
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
  server = spawn('bun', ['run', 'scripts/e2e_server.ts', String(port)], { cwd: `${process.cwd()}/../backend-ts`, stdio: ['ignore', 'pipe', 'pipe'] })
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
  // every toast the page shows, in order (a toast hides itself after a while)
  await page.addInitScript(() => {
    const seen: string[] = []
    Object.assign(window, { e2eToasts: seen })
    new MutationObserver(() => { for (const el of document.querySelectorAll('.toast')) { const t = el.textContent ?? ''; if (seen.at(-1) !== t) seen.push(t) } })
      .observe(document, { childList: true, subtree: true, characterData: true })
  })
}, { timeout: 60_000 })

after(async () => { await browser?.close(); server?.kill('SIGTERM'); assert.deepEqual(failures, []) })

const api = async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
  const res = await fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json', 'x-oasis-code-token': info.token }, body: init.body === undefined ? undefined : JSON.stringify(init.body) })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}
const toasts = () => page.evaluate(() => [...(window as unknown as { e2eToasts: string[] }).e2eToasts])

async function openSession(sid: string) {
  await page.goto(`${base}/?token=${info.token}`)
  await page.getByTestId(`session-${sid}`).click()
  await bypassDirector(page)
}

async function pickModel(id: string) {
  await page.click('[data-testid="model-picker"]')
  await page.click(`[data-testid="model-option-${id}"]`)
}

async function separateTask(words: string): Promise<string> {
  const before = new Set(await page.locator('[data-testid="agents-relations"] [data-latest-run]').evaluateAll((els) => els.map((el) => el.getAttribute('data-latest-run'))))
  await page.click('[data-testid="send-as-chip"]')
  await page.click('[data-testid="send-as-separate"]')
  assert.equal(await page.getAttribute('[data-testid="send-as-chip"]', 'data-way'), 'separate')
  await page.click('[data-testid="composer"]')
  await page.keyboard.type(words)
  await page.click('[data-testid="send"]')
  // the default is the main agent again: the next message goes on in the thread
  await page.waitForSelector('[data-testid="send-as-chip"][data-way="main"]')
  const handle = await page.waitForFunction((seen) => [...document.querySelectorAll('[data-testid="agents-relations"] [data-latest-run]')].map((el) => el.getAttribute('data-latest-run')!).find((id) => !seen.includes(id)) ?? null, [...before], { timeout: 20_000 })
  return String(await handle.jsonValue())
}

let sid = ''
let runA = '', runB = '', runC = ''

test('a separate task from the composer: the thread lists it with its state, never as a turn; a click brings its card forward, also from the shelf; its card is continued', { timeout: 120_000 }, async () => {
  const project = await api<{ id: string }>('/api/projects', { method: 'POST', body: { no_folder: true } })
  sid = (await api<{ id: string }>(`/api/projects/${project.id}/sessions`, { method: 'POST', body: { title: 'collaboration e2e', mode: 'auto' } })).id
  await openSession(sid)
  await pickModel('scripted:c')
  runA = await separateTask('Inventory: list the repository files and report how many there are.')
  const summary = page.getByTestId('agents-board')
  await page.waitForFunction((id) => document.querySelector(`[data-testid="agents-relations"] [data-latest-run="${id}"]`)?.getAttribute('data-state') === 'done', runA, { timeout: 30_000 })
  assert.match(await summary.getByTestId('agents-line').innerText(), /^1 agent · 1 done/)
  assert.equal(await page.locator(`[data-testid="run-${runA}"]`).count(), 0)                   // the task's run is never a thread turn
  assert.ok(['legacy', 'graph'].includes(String(await summary.getAttribute('data-source'))))    // projected, or the harness's graph where it has one
  // its card: shelved, then brought back by the summary at its run
  const card = page.locator(`[data-testid="card-${runA}"]`)
  await card.waitFor({ timeout: 20_000 })
  await card.getByTestId('card-shelve').click()
  await card.waitFor({ state: 'detached' })
  await page.locator(`[data-testid=\"agents-relations\"] [data-latest-run=\"${runA}\"]`).click()
  await card.waitFor()
  await page.waitForSelector(`[data-testid="card-${runA}"].front`)
  await card.getByTestId(`card-run-${runA}`).waitFor()

  // a second task, then a follow-up of the first (sent as a director would: its run continued)
  runC = await separateTask('Inventory: list the repository files and report how many there are.')
  await page.waitForFunction((id) => document.querySelector(`[data-testid="agents-relations"] [data-latest-run="${id}"]`)?.getAttribute('data-state') === 'done', runC, { timeout: 30_000 })
  await page.locator(`[data-testid=\"agents-relations\"] [data-latest-run=\"${runA}\"]`).click()
  await page.waitForSelector(`[data-testid="card-${runA}"].front`)
  await page.evaluate(async (id) => {
    const res = await fetch(`/api/runs/${id}/resume`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-oasis-code-token': localStorage.getItem('oasis-code.token') ?? '' }, body: JSON.stringify({ text: 'Count them again, please.' }) })
    if (!res.ok) throw new Error(`resume: ${res.status} ${await res.text()}`)
  }, runA)
  await page.waitForFunction((id) => document.querySelectorAll(`[data-testid="card-${id}"] [data-testid^="card-run-"]`).length === 2, runA, { timeout: 30_000 })
  runB = (await card.locator('[data-testid^="card-run-"]').nth(1).getAttribute('data-run-id'))!
  assert.notEqual(runB, runA)
  // the session's agents are one board, one chip per agent as its latest run stands: the first task's chip is now its
  // follow-up, and a click finds it on the first task's card
  await page.waitForSelector(`[data-testid=\"agents-relations\"] [data-latest-run=\"${runB}\"]`, { timeout: 20_000 })
  await page.waitForFunction((id) => document.querySelector(`[data-testid="agents-relations"] [data-latest-run="${id}"]`)?.getAttribute('data-state') === 'done', runB, { timeout: 30_000 })
  const board = page.getByTestId('agents-board')
  assert.match(await board.getByTestId('agents-line').innerText(), /^2 agents · 2 done/)
  assert.equal(await board.locator(`[data-latest-run=\"${runC}\"]`).count(), 1)
  assert.equal(await page.locator(`[data-testid=\"agents-relations\"] [data-latest-run=\"${runA}\"]`).count(), 0)
  assert.equal(await page.locator(`[data-testid="card-${runB}"]`).count(), 0)                // never a card of its own
  // reload: the session opens with its finished cards on the shelf; the summary brings one back
  await openSession(sid)
  await page.waitForSelector(`[data-testid=\"agents-relations\"] [data-latest-run=\"${runC}\"]`)
  await page.locator(`[data-testid="card-${runC}"]`).waitFor({ state: 'detached', timeout: 10_000 })   // finished: on the shelf
  await page.locator(`[data-testid=\"agents-relations\"] [data-latest-run=\"${runC}\"]`).click()
  await page.waitForSelector(`[data-testid="card-${runC}"].front`)
  assert.deepEqual(failures, [])
})

/** A graph over the session's real runs: A and C separate tasks, B a follow-up of A that was handed C's answer and
 *  cites A's — one cited, one received, on the same run. */
function fixture(revision: string) {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 14, 3, 0, s)).toISOString()
  const origin = (request: string) => ({ actor: 'person', request, client: null, director_session_id: null, director_turn_id: null, tool_call_id: null, interaction_id: null, relay_id: null, watch_id: null, ui_task_id: null, parent_run_id: null, basis: 'recorded' })
  const run = (id: string, pid: string, seq: number, s: number) => ({ id, status: 'done', live: false, model: 'scripted:c', label: 'Inventory', created_at: at(s), finished_at: at(s + 1), workspace_id: null, resumes_run_id: null, interaction_id: null, interaction_node: null, relay_id: null, relay_step: null, user_text_head: 'Inventory', final_text_chars: 1234, error: null,
    collab: { participant_id: pid, participant_role: 'separate', conversation_id: `cv_${pid.slice(3)}`, conversation_seq: seq, origin: origin(seq > 1 ? 'resume' : 'separate'), placement: { surface: 'card', group: null, anchor: null }, basis: 'recorded' } })
  const participant = (id: string, latest: string) => ({ id, session_id: sid, role: 'separate', alias: null, label: `Task ${id.slice(3, 4)}`, model: 'scripted:c', group: null, introduced_by: null, current_conversation_id: `cv_${id.slice(3)}`, latest_run_id: latest, state: 'idle', run_count: 1, basis: 'recorded', created_at: at(1) })
  const entry = (id: string, pid: string) => ({ run_id: id, participant_id: pid, label: 'Inventory', model: 'scripted:c', status: 'done', surface: 'card', user_text_head: 'Inventory', finished_at: at(9), focus: { participant_id: pid, run_id: id } })
  const A = 'pa_aaaaaaaaaaaaaaaa', C = 'pa_cccccccccccccccc'
  return {
    session_id: sid, revision, main_participant_id: null, actors: [{ kind: 'person' }],
    participants: [participant(A, runB), participant(C, runC)], conversations: [], groups: [], nodes: [],
    runs: [run(runA, A, 1, 1), run(runC, C, 1, 3), run(runB, A, 2, 5)],
    edges: [
      { id: 'eg_cont', kind: 'continues', from: { kind: 'run', id: runA }, to: { kind: 'run', id: runB }, basis: 'recorded', created_at: at(5), meta: { conversation_id: `cv_${A.slice(3)}` } },
      { id: 'eg_recv', kind: 'received', from: { kind: 'run', id: runC }, to: { kind: 'run', id: runB }, basis: 'recorded', created_at: at(5), meta: { via: 'dispatch', packet: 'whole', answer_chars: 1234, handed_chars: 1234, node: null, content_delivered: true } },
      { id: 'eg_cite', kind: 'cited', from: { kind: 'run', id: runA }, to: { kind: 'run', id: runB }, basis: 'recorded', created_at: at(5), meta: { by: 'person', director_turn_id: null, note: 'the first count', content_delivered: false } },
    ],
    thread_items: [{ kind: 'dispatch', id: 'ti_graph', at: at(3), anchor: null, origin: origin('separate'), entries: [entry(runA, A), entry(runC, C)], counts: { queued: 0, running: 0, done: 2, error: 0, cancelled: 0, total: 2 } }],
    legacy: { projected_runs: 0, inferred_facts: 0, notes: [] },
  }
}

test('the relations a harness records: a card says who it cited and whose answer it was handed — two kinds, never one', { timeout: 60_000 }, async () => {
  assert.ok(runA && runB && runC, 'the first test made the runs')
  const reads: string[] = []
  await page.route('**/api/sessions/*/collaboration*', async (route: Route) => {
    reads.push(route.request().url())
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture('r1')) })
  })
  await openSession(sid)
  const summary = page.getByTestId('agents-board')
  await summary.waitFor()
  assert.equal(await summary.getAttribute('data-source'), 'graph')
  assert.match(await summary.getByTestId('agents-line').innerText(), /^2 agents · 2 done/)
  // on B's card (A's latest run): handed C's answer, cites A's — said apart
  await page.locator(`[data-testid=\"agents-relations\"] [data-latest-run=\"${runB}\"]`).click()
  const card = page.locator(`[data-testid="card-${runA}"]`)
  await page.waitForSelector(`[data-testid="card-${runA}"].front`)
  const received = card.getByTestId(`edge-received-${runB}-${runC}`)
  const cited = card.getByTestId(`edge-cited-${runB}-${runA}`)
  await received.waitFor()
  assert.equal(await received.getAttribute('data-delivered'), 'true')
  assert.match(await received.innerText(), /received .* answer in full \(1,234 chars\)/)
  assert.equal(await cited.getAttribute('data-delivered'), 'false')
  assert.match(await cited.innerText(), /not handed over/)
  assert.doesNotMatch(await cited.innerText(), /received/)
  assert.ok(reads.length >= 1)
  await page.unroute('**/api/sessions/*/collaboration*')
})

test('a harness that answers the graph with 500: said once, the page stays usable and retries; a harness without the route (404): silently the projection', { timeout: 60_000 }, async () => {
  let failing = 0
  await page.route('**/api/sessions/*/collaboration*', async (route: Route) => {
    failing += 1
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'graph store unavailable' }) })
  })
  await openSession(sid)
  await page.waitForSelector(`[data-testid=\"agents-relations\"] [data-latest-run=\"${runC}\"]`)                        // the projection stands in
  await page.waitForFunction(() => (window as unknown as { e2eToasts: string[] }).e2eToasts.some((t) => /relations \(500\)/.test(t)))
  // the sync tick retries; nothing more is said
  const deadline = Date.now() + 15_000
  while (failing < 3 && Date.now() < deadline) await page.waitForTimeout(500)
  assert.ok(failing >= 3, `retried (${failing} reads)`)
  assert.equal((await toasts()).filter((t) => /relations \(500\)/.test(t)).length, 1)
  // the thread's summary stands on the page's own projection meanwhile
  assert.equal(await page.getByTestId('agents-board').getAttribute('data-source'), 'legacy')
  await page.unroute('**/api/sessions/*/collaboration*')

  let absent = 0
  await page.route('**/api/sessions/*/collaboration*', async (route: Route) => { absent += 1; await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'Not Found' }) }) })
  await openSession(sid)
  await page.waitForSelector(`[data-testid=\"agents-relations\"] [data-latest-run=\"${runC}\"]`)
  await page.waitForTimeout(7_000)                                                            // two sync ticks
  assert.equal(absent, 1)                                                                      // an older harness is asked once
  assert.equal((await toasts()).filter((t) => /relations/.test(t)).length, 0)                  // the page was loaded anew: nothing of the relations said
  assert.equal(await page.getByTestId('agents-board').getAttribute('data-source'), 'legacy')
  await page.unroute('**/api/sessions/*/collaboration*')
  assert.deepEqual(failures, [])
})
