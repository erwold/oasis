import { verifyRoutedSimulationIsolation } from './routed-simulation-regression.ts'
import { openRoutedSimulation } from './routed-simulation.ts'
import { bypassDirector } from './agent-entry.ts'
import { showTeams } from './natural-language-driver.ts'
import { pdfFixture, mp4Fixture } from '../../backend-ts/tests/file_fixtures.ts'
/** The browser path, in real Chrome (playwright-core, channel chrome — no
 * download) against a scripted backend: import a repository, send a task,
 * watch the run, read the diff, the command log and the checks, stop a
 * long run, reload and find everything again, continue the session. */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright-core'

const PORT = 8399
const BASE = `http://127.0.0.1:${PORT}`
let server: ChildProcess
let info: { port: number; repo: string; stuff: string; token: string; data: string; isolation: string; chatgpt_bridge: string; bridge_token: string }
let browser: Browser
let page: Page

before(async () => {
  // the TypeScript backend on Bun
  server = spawn('bun', ['run', 'scripts/e2e_server.ts', String(PORT)], { cwd: `${process.cwd()}/../backend-ts`, stdio: ['ignore', 'pipe', 'pipe'] })
  info = await new Promise((resolve, reject) => {
    let buf = ''
    server.stdout!.on('data', (d) => { buf += String(d); const line = buf.split('\n')[0]; if (line.trim().startsWith('{')) resolve(JSON.parse(line)) })
    server.stderr!.on('data', (d) => { if (/Traceback|^error:/m.test(String(d))) reject(new Error(String(d))) })
    server.on('exit', (code) => reject(new Error(`e2e server exited ${code}`)))
  })
  // the OS sandbox's enforcement (isolation probe), not the session's Full access: a Sandbox session needs it
  assert.equal(info.isolation, 'full', 'the e2e needs the OS sandbox')
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/api/meta/build`); if (r.ok) break } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  // real Chrome by default; OASIS_CODE_E2E_BROWSER names another Chromium executable (a CI container without Chrome)
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  browser = await chromium.launch(executablePath ? { executablePath, headless: true, args: ['--no-sandbox'] } : { channel: 'chrome', headless: true })
  page = await browser.newPage()
  page.on('pageerror', (e) => { throw e })
})

after(async () => {
  await browser?.close()
  server?.kill('SIGTERM')
})

/** The desktop app's shell as far as ChatGPT goes: where its bridge listens (the e2e server plays the bridge — the
 *  backend reaches it itself) and what the page's status reads, which the test changes. */
async function standInShell(status: { started: boolean; logged_in: boolean | null; connector: string | null; model: string | null; journal?: Record<string, unknown> }) {
  await page.exposeFunction('e2eChatGptStatus', () => status)
  // resuming after a damaged send log: the log usable again
  await page.exposeFunction('e2eResumeSending', () => { status.journal = { state: 'usable' }; return { resumed: true, journal: status.journal } })
  await page.evaluate(([url, token]) => {
    const shell = {
      platform: 'darwin', placeChatGpt: () => undefined,
      openChatGptBridge: async () => ({ url, token }),
      chatGptStatus: () => (window as unknown as { e2eChatGptStatus: () => Promise<unknown> }).e2eChatGptStatus(),
      resumeChatGptSending: () => (window as unknown as { e2eResumeSending: () => Promise<unknown> }).e2eResumeSending(),
      offerChatGptConnector: async (m: string) => m,
    }
    Object.assign(window, { oasisCodeDesktop: shell })
  }, [info.chatgpt_bridge, info.bridge_token])
}

/** What the stand-in bridge was sent. */
async function bridgeSent(): Promise<Record<string, unknown>[]> {
  return (await fetch(`${info.chatgpt_bridge}/e2e/sent`, { headers: { authorization: `Bearer ${info.bridge_token}` } })).json() as Promise<Record<string, unknown>[]>
}

/** The workspace card to the front of the desk's stack (a strip behind the front card hides its body). */
async function raiseWorkspace() {
  await page.click('[data-testid="card-workspace"] .desk-title')
  await page.waitForSelector('[data-testid="card-workspace"].front')
}

/** The thread's own agent has no card until asked for: its row in Agent Teams opens it. */
async function openOwnCard() {
  await showTeams(page)
  await page.locator('[data-testid^="ol-run_"]').first().click()
  await page.waitForSelector('[data-testid^="card-run_"]')
}

/** The composer's words as the editor holds them (a contenteditable: no input value; a chip reads as its name). */
async function composerText(): Promise<string> {
  return page.locator('[data-testid="composer"]').evaluate((el) => (el.textContent ?? '').replace(/\u00a0/g, ' '))
}

/** The start screen's folder: the fixture repository through the page's folder dialog, one folder at a time. */
async function pickRepoFolder() {
  await page.click('[data-testid="folder-chip"]')
  await page.waitForSelector('[data-testid="folder-dialog"][open]')
  await page.click(process.platform === 'darwin' ? '[data-testid="fs-fav-macintosh-hd"]' : '[data-testid="fs-fav-root"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="fs-crumbs"]')?.textContent === '/')
  for (const segment of info.repo.split('/').filter(Boolean)) {
    await page.click(`[data-testid="fs-dir-${segment}"]`)
    await page.waitForFunction((name) => document.querySelector('[data-testid="fs-crumbs"] .fs-crumb.current')?.textContent === name, segment)
  }
  await page.click('[data-testid="fs-open"]')
  await page.waitForSelector('[data-testid="folder-dialog"][open]', { state: 'detached' })
  await page.waitForFunction(() => /userrepo$/.test(document.querySelector('[data-testid="folder-chip"]')?.textContent ?? ''))
}

/** The model picker: open it, pick a route. */
async function pickModel(id: string) {
  await bypassDirector(page)
  await page.click('[data-testid="model-picker"]')
  const label = (await page.locator(`[data-testid="model-option-${id}"] .picker-label`).innerText()).trim()
  await page.click(`[data-testid="model-option-${id}"]`)
  await page.waitForFunction((want) => (document.querySelector('[data-testid="model-current"]')?.textContent ?? '').trim() === want, label, { timeout: 5_000 })
}

test('start a task in a folder, run it, read the evidence, stop, reload, continue', async () => {
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero"]')
  // the built page carries the app's one page policy (frame-src 'none': a preview frame cannot load a URL) and
  // everything below still works under it
  assert.equal(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), "frame-src 'none'")
  // the cookie was set by the redirect; the page can call the API
  // the start screen: the folder through the page's folder dialog (the desktop shell shows the system's panel
  // instead) — from the root, one folder at a time, then Open; then the model, the thinking level, the words
  await page.click('[data-testid="folder-chip"]')
  await page.waitForSelector('[data-testid="folder-dialog"][open]')
  await page.click(process.platform === 'darwin' ? '[data-testid="fs-fav-macintosh-hd"]' : '[data-testid="fs-fav-root"]')   // the root favourite, named per platform
  await page.waitForFunction(() => document.querySelector('[data-testid="fs-crumbs"]')?.textContent === '/')
  for (const segment of info.repo.split('/').filter(Boolean)) {
    await page.click(`[data-testid="fs-dir-${segment}"]`)
    await page.waitForFunction((name) => document.querySelector('[data-testid="fs-crumbs"] .fs-crumb.current')?.textContent === name, segment)
  }
  await page.click('[data-testid="fs-open"]')
  await page.waitForSelector('[data-testid="folder-dialog"][open]', { state: 'detached' })
  await page.waitForFunction(() => /userrepo$/.test(document.querySelector('[data-testid="folder-chip"]')?.textContent ?? ''))
  await pickModel('scripted:a')
  assert.equal(await page.locator('[data-testid="model-current"]').innerText(), 'Scripted A')            // the name alone
  await page.click('[data-testid="thinking-chip"]')
  await page.click('[data-testid="thinking-option-high"]')
  await page.waitForFunction(() => /high/.test(document.querySelector('[data-testid="thinking-current"]')?.textContent ?? ''))
  await page.fill('[data-testid="composer"]', 'add() returns the wrong result; fix it and run the tests')
  await page.click('[data-testid="send"]')
  await page.waitForSelector('[data-testid="thread-composer"]')
  // the session opened on the folder itself, in place (the workspace card on the desk); the cookie was set by the redirect
  await page.waitForSelector('[data-testid="card-workspace"]')
  await raiseWorkspace()
  assert.match(await page.locator('.ev-workspace').getAttribute('title') ?? '', /\/userrepo$/)          // the path, on hover: the person's own
  assert.match(await page.locator('[data-testid="in-place"]').innerText(), /Editing in place/)
  assert.match(await page.locator('[data-testid^="session-"][aria-current]').innerText(), /add\(\) returns the wrong result/)
  await page.waitForSelector('[data-testid="stop"]')
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 60_000 })
  const turn = page.locator('[data-testid^="run-run_"]').first()
  assert.match(await turn.innerText(), /Fixed add\(\)/)
  // the thinking level travelled with the run and is on record
  const firstRun = (await turn.getAttribute('data-testid'))!.slice(4)
  const firstDetail = await page.evaluate(async (id) => (await fetch(`/api/runs/${id}`)).json(), firstRun)
  assert.equal(firstDetail.model_config_snapshot.thinking, 'high')
  assert.equal(firstDetail.manifest.model.thinking, 'high')
  const tools = await turn.locator('.row.activity').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-tool')))
  assert.deepEqual(tools, ['read_file', 'read_file', 'edit_file', 'bash'])
  assert.equal(await turn.locator('.row.activity[data-tool="bash"]').getAttribute('data-status'), 'succeeded')
  assert.match(await turn.locator('.turn-foot').innerText(), /5 requests · 4 tools .* cost unknown/)
  // an opened row shows what the call handed the model: the folder's entries, the file's numbered lines, the change,
  // the command and its output — and its JSON on a click
  const rowOf = (tool: string, nth = 0) => turn.locator(`.row.activity[data-tool="${tool}"]`).nth(nth)
  const opened = async (tool: string, nth: number, view: string) => {
    await rowOf(tool, nth).locator('.activity-line').click()
    const detail = rowOf(tool, nth).locator(`[data-testid="call-detail"][data-view="${view}"]`)
    await detail.waitFor({ timeout: 10_000 })
    return detail
  }
  assert.match(await (await opened('read_file', 0, 'directory')).innerText(), /calc\.py/)
  const code = await opened('read_file', 1, 'file')
  assert.match(await code.locator('.cv-line').first().innerText(), /^1\s+def add\(a, b\):/)
  const change = await opened('edit_file', 0, 'change')
  assert.match(await change.locator('.cv-line.add').first().innerText(), /return a \+ b/)
  await change.locator('[data-testid="call-raw"]').click()
  assert.match(await change.locator('.activity-detail').innerText(), /"diff"/)
  assert.match(await (await opened('bash', 0, 'command')).innerText(), /\$\s*python3 -m unittest[\s\S]*exit 0/)

  // evidence: the changed file whole, the fix marked in it (the journal's: the file before the tool's write against
  // it now); the panel offers no checkpoint, no command log and no checks (the run card's terminal has the log)
  await raiseWorkspace()
  await page.waitForFunction(() => /return a \+ b/.test(document.querySelector('[data-testid="code-view"]')?.textContent ?? ''), undefined, { timeout: 10_000 })
  assert.match(await page.locator('[data-testid="code-view"] .cv-line.add').first().innerText(), /return a \+ b/)
  assert.match(await page.locator('[data-testid="code-view"] .cv-line.del').first().innerText(), /return a - b/)
  assert.match(await page.locator('[data-testid="changes"]').innerText(), /1 file\(s\) changed by the agent's file tools/)
  for (const gone of ['checkpoint', 'tab-commands', 'tab-checks', 'run-checks']) assert.equal(await page.locator(`[data-testid="${gone}"]`).count(), 0)
  // the run card's terminal: the test runner wrote its report on stderr, as they do — the card shows that stream on
  // its own, names the bytes on each, and switches between them
  await openOwnCard()
  const doneCard = page.locator('[data-testid^="card-run_"]').filter({ has: page.locator('.desk-state', { hasText: /done/ }) }).first()
  await doneCard.locator('.desk-title').click()
  await doneCard.locator('[data-testid="card-tab-terminal"]').click()
  const terminal = doneCard.locator('[data-testid="card-terminal"]')
  await terminal.waitFor()
  await page.waitForFunction(() => /Ran 2 tests/.test(document.querySelector('[data-testid="card-terminal"] pre')?.textContent ?? ''), undefined, { timeout: 10_000 })
  assert.equal(await terminal.getAttribute('data-stream'), 'stderr')
  assert.match(await terminal.locator('[data-testid="card-terminal-stdout"]').innerText(), /stdout · 0 B/)
  assert.match(await terminal.locator('[data-testid="card-terminal-stderr"]').innerText(), /stderr · [1-9]\d* B/)
  await terminal.locator('[data-testid="card-terminal-stdout"]').click()
  await page.waitForFunction(() => /nothing on stdout; \d+ B on stderr/.test(document.querySelector('[data-testid="card-terminal"] pre')?.textContent ?? ''), undefined, { timeout: 5_000 })
  await terminal.locator('[data-testid="card-terminal-stderr"]').click()
  await page.waitForFunction(() => /\bOK\b/.test(document.querySelector('[data-testid="card-terminal"] pre')?.textContent ?? ''), undefined, { timeout: 5_000 })
  await doneCard.locator('[data-testid="card-tab-thread"]').click()

  // stop now: a long command dies with the run
  await pickModel('scripted:b')
  await page.fill('[data-testid="composer"]', 'run something long')
  await page.click('[data-testid="send"]')
  await page.waitForSelector('.row.activity[data-tool="bash"].running', { timeout: 20_000 })
  await new Promise((r) => setTimeout(r, 800))
  await page.click('[data-testid="stop"]')
  await page.waitForSelector('[data-testid^="run-run_"][data-status="cancelled"]', { timeout: 20_000 })

  // reload: the session, both runs, their rows and the evidence are back from the records
  await page.reload()
  await page.waitForSelector('[data-testid^="session-"]')
  await page.click('[data-testid^="session-"]')
  await page.waitForSelector('[data-testid="thread-composer"]')
  await bypassDirector(page)
  await page.waitForSelector('[data-testid^="run-run_"][data-status="cancelled"]')
  const runs = page.locator('[data-testid^="run-run_"]')
  assert.equal(await runs.count(), 2)
  assert.match(await runs.first().innerText(), /Fixed add\(\)/)
  await runs.first().locator('.fold').click()                       // earlier turns fold their work; open it
  const replayedTools = await runs.first().locator('.row.activity').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-tool')))
  assert.deepEqual(replayedTools, ['read_file', 'read_file', 'edit_file', 'bash'])
  // the round's file chip: its own counts, and on hover the file's measured patch
  const fileChip = runs.first().locator('[data-testid="change-chip"]', { hasText: 'calc.py' })
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="change-chip"]')].some((el) => /calc\.py\s*\+1\s*−1/.test((el as HTMLElement).innerText)), undefined, { timeout: 5_000 })
  await fileChip.hover()
  await page.waitForSelector('[data-testid="change-preview"]')
  assert.match(await page.locator('[data-testid="change-preview"]').innerText(), /return a - b[\s\S]*return a \+ b/)
  await page.mouse.move(5, 5)
  await page.waitForSelector('[data-testid="change-preview"]', { state: 'detached' })
  // pressed, the chip opens the file on the Workspace card as that run left it; Now shows it as it stands
  await fileChip.click()
  await page.waitForSelector('[data-testid="card-workspace"] [data-testid="scope-run"]')
  await page.waitForFunction(() => /calc\.py[\s\S]*return a \+ b/.test(document.querySelector('[data-testid="code-view"]')?.textContent ?? ''), undefined, { timeout: 10_000 })
  assert.match(await page.locator('[data-testid="changes"] .chg-summary').innerText(), /1 file\(s\) this run changed/)
  await page.click('[data-testid="scope-now"]')
  await page.waitForSelector('[data-testid="scope-run"]', { state: 'detached' })
  assert.match(await page.locator('[data-testid="code-view"] .code-path').innerText(), /calc\.py/)

  // continue the session (the scripted model answers again from the start of its script)
  await pickModel('scripted:a')
  await page.fill('[data-testid="composer"]', 'and now confirm')
  await page.click('[data-testid="send"]')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="run-run_"][data-status="done"]').length === 2, undefined, { timeout: 60_000 })
  assert.equal(await runs.count(), 3)

  // the run detail names configured vs reported model and keeps cost unknown
  await runs.last().locator('[data-testid^="records-"]').click()
  await page.waitForSelector('[data-testid="run-detail"]:not([data-loading])')
  const detail = await page.locator('[data-testid="run-detail"]').innerText()
  assert.match(detail, /configured\s+scripted-a/)
  assert.match(detail, /unknown \(no price list\)/)
  await page.click('[data-testid="records-back"]')
  await page.waitForSelector('[data-testid="thread"]')
  // the fix is in the person's own folder: it was edited in place
  assert.match(readFileSync(`${info.repo}/calc.py`, 'utf8'), /return a \+ b/)

  // the ring round the send button: hovering it shows what the next request carries of the window
  const ring = page.locator('[data-testid="thread-composer"] [data-testid="context-ring"]')
  assert.equal(await page.locator('[data-testid="context-toggle"]').count(), 0)  // no Context chip in the composer any more
  await ring.hover()
  await page.waitForSelector('[data-testid="context-panel"]:not([data-loading])')
  const panel = await page.locator('[data-testid="context-panel"]').innerText()
  assert.match(panel, /Context window/)
  assert.match(panel, /Fixed instructions/)
  assert.match(panel, /Tool schemas · 21/)                                       // read, write, edit, bash (+ output, stop), web search, fetch, watch, computer (observe, act), present_ui, read_ui, request_input, return_ui_result, generate_image, the five SSH tools
  assert.match(panel, /Conversation/)
  assert.match(panel, /Prompt cache · \d+% read on the last run/)
  await page.mouse.move(0, 0)
  await page.waitForSelector('[data-testid="context-panel"]', { state: 'detached' })

  // the replay: the session played back from its persisted events, then back to live (the agent's card taken out
  // again: the reload put it away)
  await openOwnCard()
  await page.click('[data-testid="replay"]')
  await page.waitForSelector('[data-testid="replay-bar"]')
  await page.click('[data-testid="replay-play"]').catch(() => undefined)
  await page.locator('[data-testid="replay-scrub"]').fill('1000')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="run-run_"]').length === 3)
  assert.match(await page.locator('[data-testid="replay-clock"]').innerText(), /events/)
  await page.locator('[data-testid="replay-scrub"]').fill('0')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="run-run_"]').length <= 1)
  // the desk at 0:00 stands where the run stood: its card not done, no answer in it, the worktree's live panels held back
  const cardState = () => page.locator('[data-testid^="card-run_"] .desk-state').first().innerText()
  assert.doesNotMatch(await cardState(), /done/)
  assert.equal(await page.locator('[data-testid^="agent-view-"] .turn-agent').count(), 0)
  assert.equal(await page.locator('[data-testid="card-tab-changes"]').count(), 0)
  assert.equal(await page.locator('[data-testid="workspace-replay-note"]').count(), 1)
  assert.equal(await page.locator('[data-testid="card-stop"]').count(), 0)                  // the card running at 0:00 stops nothing
  await page.click('[data-testid="replay-exit"]')
  await page.waitForSelector('[data-testid="composer"]')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="run-run_"]').length === 3)
  await page.waitForFunction(() => document.querySelector('[data-testid^="card-run_"] .desk-state')?.textContent?.includes('done'))
  assert.equal(await page.locator('[data-testid="card-tab-changes"]').count(), 1)
  assert.equal(await page.locator('[data-testid="workspace-replay-note"]').count(), 0)

  // a work order beside the thread (what a director dispatches): its own worktree and card, its receipt, and the
  // thread's conversation untouched
  await page.evaluate(async () => {
    const id = document.querySelector('[aria-current="page"][data-testid^="session-"]')!.getAttribute('data-testid')!.slice('session-'.length)
    const res = await fetch(`/api/sessions/${id}/work-orders`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-oasis-code-token': localStorage.getItem('oasis-code.token') ?? '' },
      body: JSON.stringify({ work_order: { label: 'Inventory', prompt: 'Inventory: list the repository files and report how many there are.', model: 'scripted:c' } }) })
    if (!res.ok) throw new Error(`work order: ${res.status}`)
  })
  await showTeams(page)
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid^="ol-run_"]')].some((el) => /Inventory/.test(el.textContent ?? '') && el.getAttribute('data-status') === 'done'), undefined, { timeout: 20_000 })
  assert.match(await page.locator('[data-testid="outline"]').innerText(), /Inventory/)
  const card = page.locator('[data-testid^="card-run_"]').filter({ has: page.locator('.desk-name', { hasText: /^Inventory$/ }) })
  await card.waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="card-receipt"]')].some((el) => /not run/.test(el.textContent ?? '')), undefined, { timeout: 10_000 })
  const receipt = await card.locator('[data-testid="card-receipt"]').innerText()
  assert.match(receipt, /measured[\s\S]*2 requests · 1 tool/)                                  // what was measured, no verdict
  assert.match(receipt, /checks[\s\S]*0 passed · 0 failed · 0 unknown · 1 not run/)            // the configured check did not run: counted, not judged
  assert.doesNotMatch(receipt, /verdict|verified/)
  assert.match(await card.innerText(), /read_file/)
  assert.match(await card.innerText(), /files listed/)
  // the card's conversation as it happened: the words said before the tool call, the call, then the answer
  assert.ok(await card.evaluate((el) => {
    const view = el.querySelector('[data-testid^="agent-view-"]')!
    const words = [...view.querySelectorAll('.turn-agent')]
    const first = words.find((w) => (w.textContent ?? '').includes('Listing the files first.'))
    const last = words.find((w) => (w.textContent ?? '').includes('files listed'))
    const call = [...view.querySelectorAll('.work')].find((w) => (w.textContent ?? '').includes('read_file'))
    const before = (a?: Element, b?: Element) => !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    return before(first, call) && before(call, last)
  }), 'the card keeps its words where they were said, between the tool calls')
  // a replay shows the record: no card stops anything
  await page.click('[data-testid="replay"]')
  await page.waitForSelector('[data-testid="replay-bar"]')
  await page.locator('[data-testid="replay-scrub"]').fill('1000')
  await card.waitFor({ timeout: 10_000 })
  assert.equal(await page.locator('[data-testid="card-stop"]').count(), 0)
  await page.click('[data-testid="replay-exit"]')
  await page.waitForSelector('[data-testid="composer"]')
  await card.locator('[data-testid="card-close"]').click()
  assert.equal(await page.locator('[data-testid^="run-run_"]').count(), 3)            // the order run never joins the thread

  // Ask before changes (the composer offers no modes; the director or the API sets one): the agent's note is held;
  // approved in the workspace, it is written; the Workspace card brings the session back to Auto
  await page.evaluate(async () => {
    const id = document.querySelector('[aria-current="page"][data-testid^="session-"]')!.getAttribute('data-testid')!.slice('session-'.length)
    const res = await fetch(`/api/sessions/${id}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-oasis-code-token': localStorage.getItem('oasis-code.token') ?? '' }, body: JSON.stringify({ mode: 'approve' }) })
    if (!res.ok) throw new Error(`mode: ${res.status}`)
  })
  await page.reload()
  await page.waitForSelector('[data-testid^="session-"]')
  await page.click('[data-testid^="session-"]')
  await page.waitForSelector('[data-testid="thread-composer"]')
  await bypassDirector(page)
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]')
  await raiseWorkspace()
  await page.waitForFunction(() => /Ask before changes/.test(document.querySelector('[data-testid="permissions-mode"]')?.textContent ?? ''))
  await pickModel('scripted:g')
  await page.fill('[data-testid="composer"]', 'write a note')
  await page.click('[data-testid="send"]')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="run-run_"][data-status="done"]').length === 3, undefined, { timeout: 20_000 })
  assert.match(await page.locator('[data-testid^="run-run_"]').last().innerText(), /waits for your approval/)
  await raiseWorkspace()
  await page.waitForSelector('[data-testid="approvals"] [data-testid="approve-proposal"]')
  assert.match(await page.locator('[data-testid="approvals"]').innerText(), /write_file/)
  await page.click('[data-testid="approve-proposal"]')
  await page.waitForSelector('[data-testid="approvals"]', { state: 'detached' })
  await page.waitForFunction(() => /NOTES\.md/.test(document.querySelector('[data-testid="changes"]')?.textContent ?? ''), undefined, { timeout: 10_000 })
  await page.click('[data-testid="permissions-auto"]')
  await page.waitForSelector('[data-testid="permissions-mode"]', { state: 'detached' })
  assert.equal(await page.locator('[data-testid="grant-network"]').count(), 0)             // Auto includes the network: nothing to turn on
  await pickModel('scripted:e')

  // Settings › Accounts: the subscriptions are not signed in, a key saved on the page is kept and masked
  assert.equal(await page.locator('[data-testid="settings"]').getAttribute('aria-label'), 'Settings')
  assert.match(await page.locator('[data-testid="settings"]').innerText(), /^Settings/)
  await page.click('[data-testid="settings"]')
  await page.waitForSelector('[data-testid="settings-dialog"][open]')
  const dialog = page.locator('[data-testid="settings-dialog"]')
  assert.equal(await dialog.locator('h2').innerText(), 'Settings')
  // no desktop shell here: Connections still holds Live sharing (Remote access is the shell's only); Accounts opens first
  assert.deepEqual(await dialog.locator('[role="tab"]').allInnerTexts(), ['Accounts', 'Appearance', 'Web Search', 'Connections'])
  assert.equal(await dialog.locator('[role="tab"][aria-selected="true"]').innerText(), 'Accounts')
  await page.waitForSelector('[data-testid="sign-in-openai-codex"]')
  assert.match(await dialog.innerText(), /Codex[\s\S]*Not signed in[\s\S]*Claude[\s\S]*Not signed in/)
  assert.match(await dialog.innerText(), /Anthropic API[\s\S]*No key/)
  await page.click('[data-testid="add-key-anthropic-api"]')
  await page.fill('[data-testid="key-input-anthropic-api"]', 'sk-ant-e2e-saved-key-0001')
  // a change of tab by keyboard keeps the half-typed key (the panels stay mounted), and the footer goes with Accounts
  await dialog.locator('[data-testid="settings-tab-accounts"]').focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'settings-tab-appearance')
  assert.equal(await dialog.locator('[data-testid="settings-panel-appearance"]').isVisible(), true)
  assert.equal(await dialog.locator('[data-testid="settings-panel-accounts"]').isVisible(), false)
  assert.equal(await dialog.locator('.acct-foot').count(), 0)
  await page.keyboard.press('ArrowLeft')
  assert.equal(await dialog.locator('[role="tab"][aria-selected="true"]').innerText(), 'Accounts')
  assert.equal(await page.inputValue('[data-testid="key-input-anthropic-api"]'), 'sk-ant-e2e-saved-key-0001')
  await page.click('[data-testid="save-key-anthropic-api"]')
  await page.waitForFunction(() => /Saved/.test(document.querySelector('[data-testid="settings-dialog"]')?.textContent ?? ''), undefined, { timeout: 10_000 })
  const after = await dialog.innerText()
  assert.match(after, /sk-…0001/)
  assert.doesNotMatch(after, /e2e-saved-key/)
  const stored = JSON.parse(readFileSync(`${info.data}/auth.json`, 'utf8'))
  assert.equal(stored['anthropic-api'].key, 'sk-ant-e2e-saved-key-0001')
  // leave it on Appearance: a failed run's "Open Accounts" (the next test) must still land on Accounts
  await page.click('[data-testid="settings-tab-appearance"]')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="settings-dialog"]', { state: 'detached' })
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'settings', null, { timeout: 2_000 }).catch(() => undefined)
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'settings', 'the focus goes back to the launcher')

  // @ points at a file: the picker offers the workspace's files, the choice becomes a chip and a resolved mention
  await page.click('[data-testid="composer"]')
  await page.keyboard.type('look at @calc')
  await page.waitForSelector('[data-testid="entity-picker"] li')
  assert.match(await page.locator('[data-testid="entity-picker"]').innerText(), /calc\.py/)
  await page.keyboard.press('Enter')
  assert.match(await composerText(), /^look at @calc\.py /)
  await page.click('[data-testid="send"]')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="run-run_"][data-status="done"]').length === 4, undefined, { timeout: 30_000 })
  const chip = page.locator('[data-testid^="run-run_"]').last().locator('[data-testid="entity-chip"]')
  assert.equal(await chip.locator('.entity-label').innerText(), 'calc.py')
  assert.equal(await chip.getAttribute('title'), 'calc.py')
  const lastRun = await page.locator('[data-testid^="run-run_"]').last().getAttribute('data-testid')
  const mentioned = await page.evaluate(async (id) => (await fetch(`/api/runs/${id}`)).json(), lastRun!.slice(4))
  assert.ok(mentioned.manifest.inputs.some((i: { kind: string; path?: string }) => i.kind === "mention" && i.path === "calc.py"))

  // the rail: a session is renamed in place from its "…", and deleted (asked twice) back to the start screen
  const sid = (await page.locator('[aria-current="page"][data-testid^="session-"]').getAttribute('data-testid'))!.slice('session-'.length)
  await page.hover(`[data-testid="session-${sid}"]`)
  await page.click(`[data-testid="session-more-${sid}"]`)
  await page.click('[data-testid="session-rename"]')
  await page.fill(`[data-testid="rename-${sid}"]`, 'calc fixes')
  await page.keyboard.press('Enter')
  await page.waitForFunction((id) => document.querySelector(`[data-testid="session-${id}"]`)?.textContent === 'calc fixes', sid)
  assert.equal(await page.locator('.thread-title').innerText(), 'calc fixes')
  await page.hover(`[data-testid="session-${sid}"]`)
  await page.click(`[data-testid="session-more-${sid}"]`)
  await page.click('[data-testid="session-delete"]')
  assert.match(await page.locator('[data-testid="session-delete"]').innerText(), /click again/)
  await page.click('[data-testid="session-delete"]')
  await page.waitForSelector(`[data-testid="session-${sid}"]`, { state: 'detached' })
  await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
  assert.equal((await (await page.evaluate(async (id) => (await fetch(`/api/sessions/${id}`, { headers: { 'x-oasis-code-token': localStorage.getItem('oasis-code.token') ?? '' } })).status, sid))), 404)
})

test('a folder opens in place at once, however big: the run works in it, and its file change is undone from the thread', async () => {
  // back to the start screen; the plain folder through the dialog, as before
  await page.click('[data-testid="new-task"]')
  await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
  await page.click('[data-testid="folder-chip"]')
  await page.waitForSelector('[data-testid="folder-dialog"][open]')
  await page.click(process.platform === 'darwin' ? '[data-testid="fs-fav-macintosh-hd"]' : '[data-testid="fs-fav-root"]')
  for (const segment of info.stuff.split('/').filter(Boolean)) {
    await page.click(`[data-testid="fs-dir-${segment}"]`)
    await page.waitForFunction((seg) => document.querySelector('[data-testid="fs-crumbs"]')?.textContent?.includes(seg), segment)
  }
  await page.click('[data-testid="fs-open"]')
  await page.waitForSelector('[data-testid="folder-dialog"][open]', { state: 'detached' })
  await page.waitForFunction(() => /stuff$/.test(document.querySelector('[data-testid="folder-chip"]')?.textContent ?? ''))
  await pickModel('scripted:d')
  await page.fill('[data-testid="composer"]', 'what does a.txt say? note it down')
  await page.click('[data-testid="send"]')
  // over the copy's limit (the fixture's is 2 files), yet no refusal: nothing is copied; the session opens at once
  await page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
  assert.equal(await page.locator('[data-testid="import-refusal"]').count(), 0)
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 60_000 })
  const turn = page.locator('[data-testid^="run-run_"]').first()
  assert.ok((await turn.innerText()).includes('hello attached'))
  // the note is in the folder itself, and the run says it changed it
  assert.equal(readFileSync(`${info.stuff}/found.md`, 'utf8'), 'a.txt says: hello attached\n')
  await page.waitForSelector('[data-testid="work-changes"]')
  assert.ok((await page.locator('[data-testid="work-changes"]').innerText()).includes('found.md'))
  assert.ok((await page.locator('[data-testid="rail"]').innerText()).includes('stuff'))
  // undone from the thread: the file the run made goes, and the page says what went (the button's own handler: the
  // run's card floats over the thread's right side here)
  // (a toast the last test left — its approval — is dismissed first: a notice waits under a toast)
  while (await page.locator('.toast:not(.notice)').count()) await page.locator('.toast:not(.notice)').first().click()
  await page.locator('[data-testid="undo-run"]').dispatchEvent('click')
  await page.waitForSelector('.toast.notice')
  const said = await page.locator('.toast.notice').innerText()
  assert.match(said, /removed 1 file the run had made/i, said)
  assert.equal(existsSync(`${info.stuff}/found.md`), false)
  assert.equal(readFileSync(`${info.stuff}/a.txt`, 'utf8'), 'hello attached\n')
})

test('images go with the words: chosen, sent, handed to a model that takes them, shown in the thread; refused elsewhere and kept', async () => {
  const images = `${process.cwd()}/../backend-ts/tests/fixtures/images`
  const composerImages = () => page.locator('[data-testid="composer-image"]').count()
  // the session of the folder stays open; a route that takes images reads what it is handed
  await pickModel('scripted:e')
  await page.setInputFiles('[data-testid="attach-input"]', [`${images}/red-7x5.png`, `${images}/dot.svg`])
  await page.waitForSelector('.toast')
  assert.match(await page.locator('.toast').innerText(), /dot\.svg: unsupported format/)  // the SVG never joins
  assert.equal(await composerImages(), 1)
  const done = await page.locator('[data-testid^="run-run_"][data-status="done"]').count()
  await page.fill('[data-testid="composer"]', 'what is in this picture?')
  await page.click('[data-testid="send"]')
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="run-run_"][data-status="done"]').length === n + 1, done, { timeout: 30_000 })
  const turn = page.locator('[data-testid^="run-run_"]').last()
  assert.match(await turn.innerText(), /I was handed 1 image\(s\): red-7x5\.png 7x5 with 86 bytes/)
  // the thread shows the image, read back from the session's own route
  await page.waitForFunction(() => {
    const img = [...document.querySelectorAll('[data-testid="turn-images"] img')].at(-1) as HTMLImageElement | undefined
    return !!img && img.complete && img.naturalWidth === 7
  })
  assert.equal(await composerImages(), 0)
  // a HEIC photo — an iPhone's, here once under a .JPG name and once under its own — is made a JPEG as it joins:
  // its thumbnail draws, and the model is handed JPEGs (beside the conversation's earlier image)
  await page.setInputFiles('[data-testid="attach-input"]', [`${images}/heic-named.JPG`, `${images}/red-7x5.heic`])
  await page.waitForFunction(() => {
    const thumbs = [...document.querySelectorAll('[data-testid="composer-image"] img')] as HTMLImageElement[]
    return thumbs.length === 2 && thumbs.every((img) => img.complete && img.naturalWidth === 7)
  }, undefined, { timeout: 10_000 })
  assert.deepEqual(await page.locator('[data-testid="composer-image"]').evaluateAll((els) => els.map((el) => el.getAttribute('title'))), ['heic-named.JPG', 'red-7x5.jpg'])
  await page.fill('[data-testid="composer"]', 'and these photos?')
  await page.click('[data-testid="send"]')
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="run-run_"][data-status="done"]').length === n + 2, done, { timeout: 30_000 })
  assert.match(await page.locator('[data-testid^="run-run_"]').last().innerText(), /I was handed 3 image\(s\): red-7x5\.png 7x5 with 86 bytes; heic-named\.JPG 7x5 with \d+ bytes; red-7x5\.jpg 7x5 with \d+ bytes\./)
  assert.equal(await composerImages(), 0)
  // a route that does not take images: said in the composer before sending (send held); the words and the image stay
  await pickModel('scripted:d')
  await page.setInputFiles('[data-testid="attach-input"]', `${images}/red-7x5.jpg`)
  await page.fill('[data-testid="composer"]', 'and this one?')
  await page.waitForSelector('[data-testid="images-unsupported"]')
  assert.match(await page.locator('[data-testid="images-unsupported"]').innerText(), /Scripted D is not configured to take images/)
  assert.equal(await page.locator('[data-testid="send"]').isDisabled(), true)
  assert.equal(await page.locator('[data-testid^="run-run_"]').count(), done + 2)
  assert.equal(await composerText(), 'and this one?')
  assert.equal(await composerImages(), 1)
  await page.locator('[data-testid="composer-image"] button').click()
  assert.equal(await composerImages(), 0)
  await page.waitForSelector('[data-testid="images-unsupported"]', { state: 'detached' })
  assert.equal(await page.locator('[data-testid="send"]').isDisabled(), false)
  await page.fill('[data-testid="composer"]', '')
})

test('a run refused its credentials says so plainly, points at Settings › Accounts, and never shows the key', async () => {
  // This is an auth regression, not an incompatible replay of the preceding image history.
  await page.click('[data-testid="new-task"]')
  await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
  await pickRepoFolder()
  await pickModel('scripted:x')
  const done = await page.locator('[data-testid^="run-run_"]').count()
  await page.fill('[data-testid="composer"]', 'hello?')
  await page.click('[data-testid="send"]')
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="run-run_"]').length === n + 1 && document.querySelector('[data-testid="failure-card"]'), done, { timeout: 20_000 })
  const card = page.locator('[data-testid="failure-card"]').last()
  assert.equal(await card.getAttribute('data-kind'), 'auth')
  assert.match(await card.innerText(), /The model route refused the credentials/)
  assert.match(await card.innerText(), /Scripted Locked · HTTP 401/)
  assert.doesNotMatch(await page.locator('body').innerText(), /E2ESECRET/)
  await card.locator('details summary').click()
  assert.match(await card.locator('pre').innerText(), /invalid x-api-key: sk-…/)
  assert.equal(await page.locator('.turn-footer .err').count(), 0, "the failure's words are on its card only, not again under the turn")
  await card.locator('[data-testid="failure-accounts"]').click()
  await page.waitForSelector('[data-testid="settings-dialog"][open]')
  assert.equal(await page.locator('[data-testid="settings-dialog"] [role="tab"][aria-selected="true"]').innerText(), 'Accounts', 'Open Accounts opens Settings at Accounts')
  await page.locator('[data-testid="sign-in-openai-codex"]').waitFor({ state: 'visible', timeout: 10_000 })
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="settings-dialog"]', { state: 'detached' })
  await pickModel('scripted:e')
})

test('the start screen can name ChatGPT with @: it answers as a participant on its page; from its card it can direct the session', async () => {
  await page.click('[data-testid="new-task"]')
  await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
  await pickRepoFolder()
  // ChatGPT named with @ before any session (the desktop app holds the page: here a stand-in shell; the e2e server
  // plays its bridge)
  const status = { started: true, logged_in: true as boolean | null, connector: '[$oasis-code](app://asdk_app_e2e)', model: 'gpt-6-pro', journal: { state: 'usable' } as Record<string, unknown> }
  await standInShell(status)
  await page.fill('[data-testid="composer"]', '@')
  await page.dispatchEvent('[data-testid="composer"]', 'keyup', { key: '@' })
  await page.waitForSelector('[data-testid="mention-chatgpt"] [data-testid="mention-chatgpt-connected"]')
  await page.click('[data-testid="mention-chatgpt"]')
  // a participant's chip in the words, like any agent's: no chip at the head, the pickers stay
  assert.deepEqual(await composerAgents(), ['chatgpt:web'])
  assert.equal(await page.locator('[data-testid="hero-composer"] [data-testid="chatgpt-chip"]').count(), 0)
  assert.equal(await page.locator('[data-testid="hero-composer"] [data-testid="model-picker"]').count(), 1)
  await page.keyboard.type('plan how to fix add()')
  await page.click('[data-testid="send"]')
  // the session opened; ChatGPT's answer stands in the thread as a participant's, over it its name
  await page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
  const turn = page.locator('[data-testid^="run-run_"]').filter({ hasText: 'CHATGPT_ANSWER' })
  await turn.waitFor({ timeout: 30_000 })
  assert.match(await turn.locator('.turn-agent .turn-who').first().innerText(), /^ChatGPT$/i)
  assert.match(await turn.innerText(), /CHATGPT_ANSWER: I read "@ChatGPT plan how to fix add\(\)"\./)
  await page.waitForFunction(() => /tokens not reported/.test(document.querySelector('[data-testid^="run-run_"]')?.textContent ?? ''), undefined, { timeout: 10_000 })
  // the page was sent the words as written — no connector, nothing of the folders — in a conversation of its own
  const sent = await bridgeSent()
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.text, '@ChatGPT plan how to fix add()')
  assert.equal(sent[0]!.new_conversation, true)
  assert.equal('mention' in sent[0]!, false)
  // the outline and the desk: its row done (the thread's own agent: no card until asked for), and the ChatGPT page's
  // own card
  await showTeams(page)
  assert.match(await page.locator('[data-testid="outline"]').innerText(), /plan how to fix add/)
  await page.waitForSelector('[data-testid^="ol-run_"][data-status="done"]', { timeout: 10_000 })
  assert.equal(await page.locator('[data-testid^="card-run_"]').count(), 0)
  await page.waitForSelector('[data-testid="card-chatgpt"]')
  await page.click('[data-testid="card-chatgpt"] .desk-title')
  // a damaged send log: the card says sending is paused, above the page; resumed there, the notice goes
  assert.equal(await page.locator('[data-testid="chatgpt-send-log"]').count(), 0)
  status.journal = { state: 'damaged', file: 'bridge-turns.damaged-2026-10-01T08-30-00.000Z.json', at: '2026-10-01T08:30:00.000Z' }
  const notice = page.locator('[data-testid="card-chatgpt"] [data-testid="chatgpt-send-log"]')
  await notice.waitFor({ timeout: 10_000 })
  assert.equal(await notice.locator('span').innerText(), 'The send log was damaged; sending is paused. Check the ChatGPT page for messages that may have gone, then resume.')
  await notice.locator('[data-testid="chatgpt-resume-sending"]').click()
  await notice.waitFor({ state: 'detached', timeout: 5_000 })
  assert.deepEqual(status.journal, { state: 'usable' })
  // from that card, ChatGPT directs the session: the words then go to its page with the connector and the model
  await page.click('[data-testid="card-chatgpt"] [data-testid="chatgpt-direct"]')
  await page.waitForSelector('[data-testid="thread-composer"] [data-testid="chatgpt-chip"]')
  assert.equal(await page.locator('[data-testid="thread-composer"] [data-testid="model-picker"]').count(), 0)   // ChatGPT picks the models
  await page.fill('[data-testid="composer"]', 'who should fix it?')
  await page.click('[data-testid="send"]')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid^="note-"]')].some((el) => /CHATGPT_DIRECTED/.test(el.textContent ?? '')), undefined, { timeout: 30_000 })
  const directed = (await bridgeSent()).at(-1)!
  assert.deepEqual([directed.text, directed.mention, directed.model, directed.new_conversation], ['who should fix it?', '[$oasis-code](app://asdk_app_e2e)', 'gpt-6-pro', true])
  // the chip taken away: the words are the agents' again, with their pickers
  await page.click('[data-testid="thread-composer"] [data-testid="chatgpt-chip-remove"]')
  await page.waitForSelector('[data-testid="thread-composer"] [data-testid="model-picker"]')
  // signed out: the @ menu's row says so, and Connect opens the page in the middle of the window
  status.logged_in = false
  await page.fill('[data-testid="composer"]', '@chat')
  await page.dispatchEvent('[data-testid="composer"]', 'keyup', { key: 't' })
  await page.click('[data-testid="mention-chatgpt-connect"]')
  await page.waitForSelector('[data-testid="chatgpt-sheet"]')
  await page.waitForFunction(() => /Sign in to ChatGPT/.test(document.querySelector('[data-testid="chatgpt-sheet-say"]')?.textContent ?? ''), undefined, { timeout: 5_000 })
  await page.click('[data-testid="chatgpt-sheet-close"]')
  await page.waitForSelector('[data-testid="chatgpt-sheet"]', { state: 'detached' })
  await page.fill('[data-testid="composer"]', '')
})

/** What the thread shows per turn: its participant's short id, who is named as speaking, how many answer blocks,
 *  how many tool rows (every fold opened first, so a folded round counts too). */
async function turnShapes(): Promise<[string | null, string, number, number][]> {
  await page.evaluate(() => { for (const el of document.querySelectorAll('[data-testid^="run-run_"] .work-head[aria-expanded="false"]')) (el as HTMLButtonElement).click() })
  return page.locator('[data-testid^="run-run_"]').evaluateAll((els) => els.map((el) => [
    el.getAttribute('data-relay-participant'), (el.querySelector('.turn-agent .turn-who')?.textContent ?? '').trim(),
    el.querySelectorAll('.turn-agent').length, el.querySelectorAll('.row.activity').length,
  ] as [string | null, string, number, number]))
}

/** The chips of the composer: the agents named, by route id. */
async function composerAgents(): Promise<string[]> {
  return page.locator('[data-testid="composer"] [data-testid="agent-chip"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-agent') ?? ''))
}

test('two agents named with @ take turns on one message: the first does it, the second reviews with the first\'s record in hand; the chain survives a reload and can be given one more round', async () => {
  // from the start screen (a fresh page: this test stands on its own)
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
  await pickRepoFolder()
  // the @ menu lists the catalogue's routes; a name with spaces is searched as typed, after a Chinese comma too
  await page.click('[data-testid="composer"]')
  await page.keyboard.type('审查衣物模拟的方案，@scripted rel')
  await page.waitForSelector('[data-testid="mention-agent-scripted:relay-a"]')
  await page.waitForSelector('[data-testid="mention-agent-scripted:relay-b"]')
  await page.waitForSelector('[data-testid="mention-agent-scripted:relay-slow"]')
  assert.equal(await page.locator('[data-testid="entity-picker"] [data-testid^="mention-agent-"]').count(), 3)   // the three "Scripted Relay …" routes
  // a model's own thinking effort, on its row: the composer's until chosen; choosing keeps the menu and the words
  assert.equal(await page.locator('[data-testid="mention-effort-scripted:relay-a"]').innerText(), 'default')
  await page.click('[data-testid="mention-effort-scripted:relay-a"]')
  await page.click('[data-testid="mention-effort-menu"] [data-testid="mention-effort-high"]')
  await page.waitForSelector('[data-testid="mention-effort-menu"]', { state: 'detached' })
  assert.equal(await page.locator('[data-testid="mention-effort-scripted:relay-a"]').innerText(), 'high')
  assert.equal(await page.locator('[data-testid="mention-effort-scripted:relay-b"]').innerText(), 'default')
  await page.waitForSelector('[data-testid="mention-agent-scripted:relay-a"][aria-selected="true"]')
  await page.keyboard.press('Enter')                                                   // the first match: Scripted Relay A
  assert.deepEqual(await composerAgents(), ['scripted:relay-a'])
  assert.equal(await composerText(), '审查衣物模拟的方案，Scripted Relay A ')
  // the second by the keyboard: Scripted Relay A stands in the words, so its row comes first — the first participant
  // named again — then, under "Add a participant", the routes as new participants (Scripted Relay A itself would join
  // as a second one); ArrowDown twice steps over the heading to Scripted Relay B, Enter; the next query then starts at
  // the top again
  await page.keyboard.type('来执行，@relay')
  await page.waitForSelector('[data-testid="mention-agent-scripted:relay-b"]')
  await page.waitForSelector('[data-testid="mention-again-scripted:relay-a-1"][aria-selected="true"]')
  assert.deepEqual(await page.locator('[data-testid="entity-picker"] .mention-agent').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid'))),
    ['mention-again-scripted:relay-a-1', 'mention-agent-scripted:relay-a', 'mention-agent-scripted:relay-b', 'mention-agent-scripted:relay-slow'])
  assert.deepEqual(await page.locator('[data-testid="entity-picker"] .mention-head').allInnerTexts(), ['In this session', 'Add a participant'])
  // before the message is sent a participant has no bot yet (it is given one by its id once it runs): the rows wear
  // their provider's logo
  for (const id of ['mention-again-scripted:relay-a-1', 'mention-agent-scripted:relay-b']) {
    assert.doesNotMatch(await page.locator(`[data-testid="${id}"] .mention-icon img`).getAttribute('src') ?? '', /\/bots\//, id)
  }
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.waitForSelector('[data-testid="mention-agent-scripted:relay-b"][aria-selected="true"]')
  await page.keyboard.press('Enter')
  assert.deepEqual(await composerAgents(), ['scripted:relay-a', 'scripted:relay-b'])
  await page.keyboard.type('来监督并给予反馈')
  // a third chip after a keyboard choice (the index once ran past the options here), then Backspace takes it away as one:
  // the route is a participant already, so the menu offers it named again first, then the route joining as a third
  await page.keyboard.type(' @relay a')
  await page.waitForSelector('[data-testid="mention-again-scripted:relay-a-1"][aria-selected="true"]')
  assert.equal(await page.locator('[data-testid="entity-picker"] .mention-agent').count(), 2)
  assert.match(await page.locator('[data-testid="mention-agent-scripted:relay-a"]').innerText(), /a new participant · its own conversation/)
  await page.keyboard.press('ArrowDown')
  await page.waitForSelector('[data-testid="mention-agent-scripted:relay-a"][aria-selected="true"]')
  await page.keyboard.press('Enter')
  assert.deepEqual(await composerAgents(), ['scripted:relay-a', 'scripted:relay-b', 'scripted:relay-a'])
  // each chip carries its participant's id (a string like the harness's others) and wears its provider's logo (a
  // participant is given its bot once it runs): the two on one route share the logo and differ by their ids; their
  // words stay the route's name
  const chips = await page.locator('[data-testid="composer"] [data-testid="agent-chip"]').evaluateAll((els) => els.map((el) => [el.getAttribute('data-alias') ?? '', el.querySelector('img')?.getAttribute('src') ?? '', el.textContent ?? '']))
  for (const [id] of chips) assert.match(id!, /^pt_[0-9a-f]{6}$/)
  assert.equal(new Set(chips.map(([id]) => id)).size, 3)
  for (const [, logo] of chips) assert.doesNotMatch(logo!, /\/bots\//)
  assert.equal(chips[0]![1], chips[2]![1])                                                                         // one route, one logo
  assert.deepEqual(chips.map(([, , text]) => text), ['Scripted Relay A', 'Scripted Relay B', 'Scripted Relay A'])  // no place number
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  assert.deepEqual(await composerAgents(), ['scripted:relay-a', 'scripted:relay-b'])
  await page.keyboard.press('Backspace')                                               // the space before the chip: ordinary text
  assert.equal(await composerText(), '审查衣物模拟的方案，Scripted Relay A 来执行，Scripted Relay B 来监督并给予反馈')
  // copy and paste keep the agents: select all, copy, paste — the chips are back as chips, not as names
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('ControlOrMeta+C')
  await page.keyboard.press('ControlOrMeta+V')
  assert.deepEqual(await composerAgents(), ['scripted:relay-a', 'scripted:relay-b'])
  assert.equal(await composerText(), '审查衣物模拟的方案，Scripted Relay A 来执行，Scripted Relay B 来监督并给予反馈')
  // cut empties the composer (the rounds chip goes with the agents), paste brings it all back
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('ControlOrMeta+X')
  assert.deepEqual(await composerAgents(), [])
  await page.waitForSelector('[data-testid="hero-composer"] [data-testid="rounds-chip"]', { state: 'detached' })
  await page.keyboard.press('ControlOrMeta+V')
  assert.deepEqual(await composerAgents(), ['scripted:relay-a', 'scripted:relay-b'])
  assert.equal(await composerText(), '审查衣物模拟的方案，Scripted Relay A 来执行，Scripted Relay B 来监督并给予反馈')
  // two agents named: the rounds chip stands where the model picker was, counting the turns a round makes
  await page.waitForSelector('[data-testid="hero-composer"] [data-testid="rounds-chip"]')
  assert.equal(await page.locator('[data-testid="hero-composer"] [data-testid="model-picker"]').count(), 0)
  // two agents named work together as the chip says: the director's plan by default; this scenario takes turns (a relay)
  assert.match(await page.locator('[data-testid="orchestration-current"]').innerText(), /Guided · up to \d+ runs/)
  await page.click('[data-testid="hero-composer"] [data-testid="rounds-chip"]')
  await page.click('[data-testid="orchestration-option-turns"]')
  await page.click('[data-testid="rounds-option-1"]')
  assert.match(await page.locator('[data-testid="orchestration-current"]').innerText(), /Take turns · 2 runs/)
  // Scripted Relay A runs at the effort chosen for it; B at the composer's
  const relayA = await page.locator('[data-testid="composer"] [data-testid="agent-chip"]').first().getAttribute('data-alias')
  const sent = page.waitForRequest((r) => r.method() === 'POST' && /\/chat$/.test(new URL(r.url()).pathname))
  await page.click('[data-testid="send"]')
  assert.deepEqual((await sent).postDataJSON().participant_thinking, { [relayA!]: 'high' })
  await page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
  // A's turn, then B's — the person's words once, over the first; the board under the newest
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="run-run_"][data-status="done"]').length === 2 && document.querySelector('[data-testid="relay-board"]')?.getAttribute('data-status') === 'done', undefined, { timeout: 60_000 })
  const turns = page.locator('[data-testid^="run-run_"]')
  assert.equal(await turns.count(), 2)
  // each turn wears its participant's id — the one its chip carries in the person's words
  const [pa, pb] = await turns.first().locator('.turn-user [data-testid="agent-chip"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-alias') ?? ''))
  assert.match(pa!, /^pt_[0-9a-f]{6}$/)
  assert.match(pb!, /^pt_[0-9a-f]{6}$/)
  assert.deepEqual(await turns.evaluateAll((els) => els.map((el) => [el.getAttribute('data-relay-participant'), el.getAttribute('data-relay-step'), el.querySelectorAll('.turn-user').length])), [[pa, '0', 1], [pb, '1', 0]])
  assert.deepEqual(await turns.first().locator('.turn-user [data-testid="agent-chip"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-agent'))), ['scripted:relay-a', 'scripted:relay-b'])
  assert.match(await turns.first().innerText(), /RELAY_MARKER_7f3a/)
  assert.match(await turns.first().locator('.turn-who').first().innerText(), /^Scripted Relay A$/i)          // the CSS shows it in capitals
  const review = await turns.last().innerText()
  assert.match(review, /REVIEW_CONTEXT_OK/)
  assert.doesNotMatch(review, /REVIEW_CONTEXT_MISSING/)
  assert.match(await turns.last().locator('[data-testid="relay-handover"]').innerText(), /Scripted Relay B.*turn 2 of 2.*speaks after Scripted Relay A/s)
  assert.match(await turns.last().locator('.turn-who').first().innerText(), /^Scripted Relay B$/i)
  assert.deepEqual(await page.locator('[data-testid="relay-step"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-step-status'))), ['done', 'done'])
  assert.match(await page.locator('[data-testid="relay-line"]').innerText(), /^Relay done/)
  assert.match(await page.locator('[data-testid="thread-state"]').innerText(), /idle/)
  // the harness's note that opened the second turn, on a click: which turn, who speaks, who spoke before — by the
  // participants' ids, the names the model reads beside its roster — no role
  await turns.last().locator('[data-testid="relay-handover"] button').click()
  const note = await turns.last().locator('.relay-message').innerText()
  assert.match(note, new RegExp(`Turn 2 of 2\\. Speaker: ${pb}\\.[\\s\\S]*Earlier turns: ${pa}\\.[\\s\\S]*Next speaker: none\\.`))
  assert.doesNotMatch(note, /executor|reviewer/i)
  // the relay's runs read back from the records: both turns with the same structure after a reload — each turn its
  // own words, its own speaker and its own tools (B inherited A's conversation as context, not as
  // its record)
  const live = await turnShapes()
  assert.deepEqual(live, [[pa, 'Scripted Relay A', 1, 1], [pb, 'Scripted Relay B', 1, 0]])
  const sid = (await page.locator('[aria-current="page"][data-testid^="session-"]').getAttribute('data-testid'))!.slice('session-'.length)
  await page.reload()
  await page.waitForSelector(`[data-testid="session-${sid}"]`)
  await page.click(`[data-testid="session-${sid}"]`)
  await page.waitForSelector('[data-testid="thread-composer"]')
  await bypassDirector(page)
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="run-run_"][data-status="done"]').length === 2, undefined, { timeout: 30_000 })
  assert.deepEqual(await turnShapes(), live)
  assert.deepEqual(await page.locator('[data-testid^="run-run_"]').evaluateAll((els) => els.map((el) => [el.getAttribute('data-relay-participant'), el.querySelectorAll('.turn-user').length])), [[pa, 1], [pb, 0]])
  assert.doesNotMatch(await page.locator('[data-testid^="run-run_"]').last().innerText(), /RELAY_MARKER_7f3a/)   // A's words are not B's
  assert.equal(await page.locator('[data-testid^="run-run_"]').first().locator('.turn-user [data-testid="agent-chip"]').count(), 2)
  assert.match(await page.locator('[data-testid="relay-line"]').innerText(), /^Relay done/)
  assert.match(await page.locator('[data-testid^="run-run_"]').last().innerText(), /REVIEW_CONTEXT_OK/)
  // one more round: A takes the feedback, B reviews again (the person's message says so); the board counts the rounds — an
  // ordinary click at the default window size (the button stands at the left, clear of the desk's dock)
  await page.click('[data-testid="relay-continue"]')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="run-run_"][data-status="done"]').length === 4 && document.querySelector('[data-testid="relay-board"]')?.getAttribute('data-status') === 'done', undefined, { timeout: 60_000 })
  assert.deepEqual(await page.locator('[data-testid^="run-run_"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-relay-participant'))), [pa, pb, pa, pb])
  assert.match(await page.locator('[data-testid="relay-line"]').innerText(), /Relay done · 2 rounds/)
  assert.match(await page.locator('[data-testid^="run-run_"]').nth(2).locator('[data-testid="relay-handover"]').innerText(), /Scripted Relay A.*turn 3 of 4 · round 2.*speaks after Scripted Relay B/s)
  assert.match(await page.locator('[data-testid^="run-run_"]').last().innerText(), /REVIEW_CONTEXT_OK/)
  // four turns as they streamed: then the same four after a switch to another session and back, and after a replay
  // played to its end and left — and the replay offers no continue and starts nothing
  const fourLive = await turnShapes()
  // round 2's A reads nothing again (its conversation already holds calc.py): one answer, no tool of its own
  assert.deepEqual(fourLive.map((t) => [t[0], t[2], t[3]]), [[pa, 1, 1], [pb, 1, 0], [pa, 1, 0], [pb, 1, 0]])
  await page.click('[data-testid="new-task"]')
  await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
  await page.click(`[data-testid="session-${sid}"]`)
  await page.waitForSelector('[data-testid="thread-composer"]')
  await bypassDirector(page)
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="run-run_"][data-status="done"]').length === 4, undefined, { timeout: 30_000 })
  assert.deepEqual(await turnShapes(), fourLive)
  const runsBefore = (await page.evaluate(async (id) => (await fetch(`/api/sessions/${id}`, { headers: { 'x-oasis-code-token': localStorage.getItem('oasis-code.token') ?? '' } })).json(), sid)).run_count
  await page.click('[data-testid="replay"]')
  await page.waitForSelector('[data-testid="replay-bar"]')
  await page.locator('[data-testid="replay-scrub"]').fill('1000')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="run-run_"]').length === 4)
  await page.waitForSelector('[data-testid="relay-board"]')
  assert.equal(await page.locator('[data-testid="relay-continue"]').count(), 0)                                  // nothing to click from the replay
  assert.equal(await page.locator('[data-testid="stop"]').count(), 0)
  assert.deepEqual((await turnShapes()).map((t) => t[0]), [pa, pb, pa, pb])           // the participants stand in the replay too
  await page.click('[data-testid="replay-exit"]')
  await page.waitForSelector('[data-testid="composer"]')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="run-run_"][data-status="done"]').length === 4, undefined, { timeout: 30_000 })
  assert.deepEqual(await turnShapes(), fourLive)
  assert.equal((await page.evaluate(async (id) => (await fetch(`/api/sessions/${id}`, { headers: { 'x-oasis-code-token': localStorage.getItem('oasis-code.token') ?? '' } })).json(), sid)).run_count, runsBefore)
  await page.waitForSelector('[data-testid="relay-continue"]')
  // the person's own words, with the chips, come back into the composer with "ask again"
  await page.locator('[data-testid^="run-run_"]').first().locator('.turn-action[title^="Put the words"]').click()
  assert.deepEqual(await composerAgents(), ['scripted:relay-a', 'scripted:relay-b'])
  assert.equal(await composerText(), '审查衣物模拟的方案，Scripted Relay A 来执行，Scripted Relay B 来监督并给予反馈')
  await page.fill('[data-testid="composer"]', '')
  // live again is the session opened anew: its composer is back on the director; this plain follow-up goes to the agent
  await bypassDirector(page)
  // a file named after a Chinese comma is a mention all the way: the menu, the token, the chip in the turn, the pinned input
  await page.click('[data-testid="composer"]')
  await page.keyboard.type('看，@calc')
  await page.waitForSelector('[data-testid="entity-picker"] li')
  await page.keyboard.press('Tab')
  assert.equal(await composerText(), '看，@calc.py ')
  await page.click('[data-testid="send"]')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="run-run_"][data-status="done"]').length === 5, undefined, { timeout: 30_000 })
  const plainTurn = page.locator('[data-testid^="run-run_"]').last()
  assert.equal(await plainTurn.locator('.turn-user [data-testid="entity-chip"] .entity-label').innerText(), 'calc.py')
  const plainRun = (await plainTurn.getAttribute('data-testid'))!.slice(4)
  const plainDetail = await page.evaluate(async (id) => (await fetch(`/api/runs/${id}`)).json(), plainRun)
  assert.ok(plainDetail.manifest.inputs.some((i: { kind: string; path?: string }) => i.kind === 'mention' && i.path === 'calc.py'))
  // the conversation moved on past the relay: it is not continued from here (a new message names the agents)
  assert.equal(await page.locator('[data-testid="relay-continue"]').count(), 0)
  assert.match(await page.locator('[data-testid="relay-line"]').innerText(), /the conversation moved on since/)
  // the Agent Teams outline: one row per turn, each wearing its participant's place on its bot (the plain follow-up
  // folded into B's last turn, which keeps its place); a lane at the right edge from each turn to the one that waited
  // for it; picking B's first turn lights the lane into it from A and the lane out of it into A's second turn
  await showTeams(page)
  assert.deepEqual(await page.locator('[data-testid="outline"] .ol-alias').allInnerTexts(), ['1', '2', '1', '2'])
  assert.equal(await page.locator('[data-testid="outline"] .ol-dep').count(), 3)
  await page.locator(`[data-testid="outline"] .ol-node[data-alias="${pb}"]`).first().click()
  await page.waitForSelector('[data-testid="outline"] .ol-dep.lit', { state: 'attached' })                    // a lane is a zero-width path: attached, not "visible"
  assert.equal(await page.locator('[data-testid="outline"] .ol-dep.lit').count(), 2)
  assert.equal(await page.locator('[data-testid="outline"] .ol-node.dim').count(), 1)                          // A's second turn waits for B's first: lit; B's second stands apart
  // each turn's part is enclosed by a line in its participant's bot colour (A's on both of A's turns, B's another);
  // the click on B's row brought B's first turn into view and lit its line
  const spans = page.locator('[data-testid^="run-run_"][data-relay] [data-testid="agent-span"]')
  const colours = await spans.evaluateAll((els) => els.map((el) => (el as HTMLElement).style.getPropertyValue('--agent')))
  assert.equal(colours.length, 4)
  assert.ok(/^#[0-9A-F]{6}$/i.test(colours[0]!) && /^#[0-9A-F]{6}$/i.test(colours[1]!), JSON.stringify(colours))
  assert.notEqual(colours[0], colours[1])
  assert.deepEqual([colours[2], colours[3]], [colours[0], colours[1]])
  await page.waitForSelector(`[data-testid^="run-run_"][data-relay-participant="${pb}"] .agent-span.flash`, { state: 'attached', timeout: 5_000 })
  // the card the click raised is the participant's: titled by its own id (its model is the line beside the title)
  await page.waitForFunction((id) => [...document.querySelectorAll('.desk-name')].some((el) => el.textContent === id), pb, { timeout: 5_000 })
})

test('a turn that ends waiting for an approval pauses the chain; approved in the workspace, Continue (a real click) lets the same agent carry on and the second agent follow', async () => {
  // Ask before changes: the first agent's note is held for approval
  await page.evaluate(async () => {
    const id = document.querySelector('[aria-current="page"][data-testid^="session-"]')!.getAttribute('data-testid')!.slice('session-'.length)
    const res = await fetch(`/api/sessions/${id}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-oasis-code-token': localStorage.getItem('oasis-code.token') ?? '' }, body: JSON.stringify({ mode: 'approve' }) })
    if (!res.ok) throw new Error(`mode: ${res.status}`)
  })
  const before = await page.locator('[data-testid^="run-run_"]').count()
  await page.click('[data-testid="composer"]')
  await page.keyboard.type('write a note，@scripted note')
  await page.waitForSelector('[data-testid="mention-agent-scripted:g"]')
  await page.keyboard.press('Enter')
  await page.keyboard.type('然后 @relay b')
  await page.waitForSelector('[data-testid="mention-agent-scripted:relay-b"]')
  await page.keyboard.press('Enter')
  assert.deepEqual(await composerAgents(), ['scripted:g', 'scripted:relay-b'])
  // a relay (turns), not the director's plan: the chip says so before the send (the reload put it back to the default)
  await page.click('[data-testid="thread-composer"] [data-testid="rounds-chip"]')
  await page.click('[data-testid="orchestration-option-turns"]')
  await page.click('[data-testid="rounds-option-1"]')
  await page.click('[data-testid="send"]')
  // the newest relay's board (the earlier relay of this session keeps its own, finished, above)
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="run-run_"]').length === n + 1 && [...document.querySelectorAll('[data-testid="relay-board"]')].at(-1)?.getAttribute('data-status') === 'waiting', before, { timeout: 30_000 })
  const board = page.locator('[data-testid="relay-board"]').last()
  assert.equal(await page.locator('[data-testid^="run-run_"]').count(), before + 1)         // the second agent waits
  assert.match(await board.locator('[data-testid="relay-line"]').innerText(), /paused: Scripted Note's turn ended waiting for your decision/)
  assert.deepEqual(await board.locator('[data-testid="relay-step"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-step-status'))), ['waiting', 'queued'])
  // the header reads the gate on its own refresh, a few milliseconds after the board: waited for, not raced
  await page.waitForFunction(() => /approval request/.test(document.querySelector('[data-testid="thread-state"]')?.textContent ?? ''), null, { timeout: 10_000 })
  // approved (through the harness's own route: the workspace card's approval path is the first test's; here the
  // outline dock of a long session covers the card's title); then Continue, a real click: the same agent carries on
  // from its record, the second agent follows
  await page.evaluate(async () => {
    const id = document.querySelector('[aria-current="page"][data-testid^="session-"]')!.getAttribute('data-testid')!.slice('session-'.length)
    const headers = { 'content-type': 'application/json', 'x-oasis-code-token': localStorage.getItem('oasis-code.token') ?? '' }
    const listed = await (await fetch(`/api/sessions/${id}/action-proposals`, { headers })).json()
    const pending = listed.proposals.find((p: { status: string }) => p.status === 'pending')
    if (!pending) throw new Error('no pending proposal')
    const res = await fetch(`/api/action-proposals/${pending.proposal_asset_id}/decide`, { method: 'POST', headers, body: JSON.stringify({ decision: 'approve', reason: 'fine' }) })
    if (!res.ok) throw new Error(`decide: ${res.status}`)
  })
  await board.locator('[data-testid="relay-continue"]').click()
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="run-run_"][data-status="done"]').length === n + 3 && [...document.querySelectorAll('[data-testid="relay-board"]')].at(-1)?.getAttribute('data-status') === 'done', before, { timeout: 60_000 })
  const turns = page.locator('[data-testid^="run-run_"]')
  const lastThree = await turns.evaluateAll((els) => els.slice(-3).map((el) => [el.getAttribute('data-relay-participant'), el.getAttribute('data-relay-step'), el.querySelectorAll('.turn-user').length]))
  const [note, noteAgain, reviewer] = lastThree.map((t) => t[0])
  assert.equal(noteAgain, note)                                                          // the same participant carries on
  assert.notEqual(reviewer, note)
  assert.deepEqual(lastThree.map((t) => [t[1], t[2]]), [['0', 1], ['0', 0], ['1', 0]])
  assert.match(await turns.nth(before + 1).locator('[data-testid="relay-handover"]').innerText(), /carries on after your decision/)
  assert.match(await page.locator('[data-testid="relay-board"]').last().locator('[data-testid="relay-line"]').innerText(), /^Relay done/)
  await page.evaluate(async () => {
    const id = document.querySelector('[aria-current="page"][data-testid^="session-"]')!.getAttribute('data-testid')!.slice('session-'.length)
    await fetch(`/api/sessions/${id}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-oasis-code-token': localStorage.getItem('oasis-code.token') ?? '' }, body: JSON.stringify({ mode: 'auto' }) })
  })
})

test('Stop stops the whole chain: the first agent\'s long command dies with its run and the second agent never starts', async () => {
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
  await pickRepoFolder()
  await page.click('[data-testid="composer"]')
  await page.keyboard.type('run something long, then review: @relay slow')
  await page.waitForSelector('[data-testid="mention-agent-scripted:relay-slow"]')
  await page.keyboard.press('Enter')
  await page.keyboard.type('@relay b')
  await page.waitForSelector('[data-testid="mention-agent-scripted:relay-b"]')
  await page.keyboard.press('Enter')
  assert.deepEqual(await composerAgents(), ['scripted:relay-slow', 'scripted:relay-b'])
  // a relay (turns), not the director's plan: the chip says so before the send
  await page.click('[data-testid="hero-composer"] [data-testid="rounds-chip"]')
  await page.click('[data-testid="orchestration-option-turns"]')
  await page.click('[data-testid="rounds-option-1"]')
  const before = 0
  await page.click('[data-testid="send"]')
  await page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
  await page.waitForSelector('.row.activity[data-tool="bash"].running', { timeout: 20_000 })
  await page.waitForFunction(() => /Scripted Relay Slow \(turn 1 of 2\)/.test(document.querySelector('[data-testid="thread-state"]')?.textContent ?? ''))
  // while its command runs, the live line is the agent's bot at work and says so — the word its card and the outline say
  const liveLine = page.locator('[data-testid="live-line"][data-state="working"]').first()
  await liveLine.waitFor({ timeout: 10_000 })
  assert.match((await liveLine.locator('img').getAttribute('src'))!, /^\/bots\/anim\/working\/.+\.webp$/)
  assert.match(await liveLine.innerText(), /working…/)
  await new Promise((r) => setTimeout(r, 800))
  await page.click('[data-testid="stop"]')
  await page.waitForSelector('[data-testid^="run-run_"][data-status="cancelled"]', { timeout: 20_000 })
  await page.waitForFunction(() => document.querySelector('[data-testid="relay-board"]')?.getAttribute('data-status') === 'cancelled', undefined, { timeout: 10_000 })
  assert.equal(await page.locator('[data-testid^="run-run_"]').count(), before + 1)         // the second agent never started
  assert.deepEqual(await page.locator('[data-testid="relay-step"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-step-status'))), ['cancelled', 'queued'])
  assert.match(await page.locator('[data-testid="relay-line"]').innerText(), /Relay stopped · stopped by the person during Scripted Relay Slow's turn/)
  await page.waitForFunction(() => /idle/.test(document.querySelector('[data-testid="thread-state"]')?.textContent ?? ''))
  assert.equal(await page.locator('[data-testid="relay-continue"]').count(), 0)
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(await page.locator('[data-testid^="run-run_"]').count(), before + 1)         // and still not, later
})

test('a task that needs no folder starts without one: its session still writes in a working folder of its own, and the next such task joins the same project', async () => {
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
  assert.equal((await page.locator('[data-testid="folder-chip"]').innerText()).trim(), 'No folder')
  // a folder picked and then not wanted: the chip's clear button puts it back to none
  await pickRepoFolder()
  await page.click('[data-testid="folder-clear"]')
  await page.waitForFunction(() => (document.querySelector('[data-testid="folder-chip"]')?.textContent ?? '').trim() === 'No folder')
  assert.equal(await page.locator('[data-testid="folder-clear"]').count(), 0)
  const noFolderProjects = () => page.evaluate(async () => {
    const projects = await (await fetch('/api/projects', { headers: { 'x-oasis-code-token': localStorage.getItem('oasis-code.token') ?? '' } })).json()
    return (projects as { id: string; name: string; source_path: string | null }[]).filter((p) => p.name === 'No folder' && p.source_path === null).map((p) => p.id)
  })
  const start = async (words: string) => {
    await page.click('[data-testid="new-task"]')
    await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
    await pickModel('scripted:g')
    await page.fill('[data-testid="composer"]', words)
    assert.equal(await page.locator('[data-testid="send"]').isDisabled(), false)          // no folder is no reason to wait
    await page.click('[data-testid="send"]')
    await page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
    await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 30_000 })
    return (await page.locator('[aria-current="page"][data-testid^="session-"]').getAttribute('data-testid'))!.slice('session-'.length)
  }
  // the note is written in the session's own working folder: the turn says so and its changes name the file
  const first = await start('write a note')
  assert.match(await page.locator('[data-testid^="run-run_"]').last().innerText(), /The note is written\./)
  await page.waitForSelector('[data-testid="work-changes"]')
  assert.ok((await page.locator('[data-testid="work-changes"]').innerText()).includes('NOTES.md'))
  const [project] = await noFolderProjects()
  assert.ok(project)
  assert.match(await page.locator(`[data-testid="project-${project}"]`).innerText(), /No folder/)
  // a second task without a folder: another session in the same project, never a second project
  const second = await start('write a note again')
  assert.notEqual(second, first)
  assert.deepEqual(await noFolderProjects(), [project])
  assert.equal((await page.locator(`[data-testid="project-${project}"] .nav-meta`).innerText()).trim(), '2')
})

test('computer use is named with @ where the desktop app holds the pages: a chip in the words, gone with one Backspace, and a chip in the thread', async () => {
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
  await pickModel('scripted:m')
  // a plain browser holds no pages: the @ menu offers no tool
  await page.click('[data-testid="composer"]')
  await page.keyboard.type('@com')
  assert.equal(await page.locator('[data-testid="mention-tool-computer"]').count(), 0)
  // the desktop app's shell (a stand-in: the agent's browser has a place): the menu offers Computer
  await page.evaluate(() => { Object.assign(window, { oasisCodeDesktop: { platform: 'darwin', placeBrowser: () => undefined, browserStatus: async () => null } }) })
  await page.keyboard.press('Backspace')
  await page.keyboard.type('m')
  await page.waitForSelector('[data-testid="mention-tool-computer"][aria-selected="true"]')
  assert.match(await page.locator('[data-testid="mention-tool-computer"]').innerText(), /Computer\s+computer use/)
  await page.keyboard.press('Enter')
  const chips = page.locator('[data-testid="composer"] [data-testid="tool-chip"]')
  assert.deepEqual(await chips.evaluateAll((els) => els.map((el) => [el.getAttribute('data-tool'), el.textContent, !!el.querySelector('img')])), [['computer', 'Computer', true]])
  assert.equal(await composerText(), 'Computer ')
  // the chip goes as one: the space after it, then the chip
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  assert.equal(await chips.count(), 0)
  assert.equal(await composerText(), '')
  // found by what it goes by too; the words after the chip
  await page.keyboard.type('@browser')
  await page.click('[data-testid="mention-tool-computer"]')
  await page.keyboard.type('open the page')
  assert.equal(await composerText(), 'Computer open the page')
  await page.click('[data-testid="send"]')
  await page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 30_000 })
  const said = page.locator('[data-testid^="run-run_"]').last().locator('[data-testid="tool-chip"]')
  assert.equal(await said.innerText(), 'Computer')
  assert.equal(await said.getAttribute('title'), 'The agent is asked to use computer_observe and computer_act')
  // the run keeps the words as written; the session is named by them as a person reads them
  const runId = (await page.locator('[data-testid^="run-run_"]').last().getAttribute('data-testid'))!.slice(4)
  const run = await page.evaluate(async (id) => (await fetch(`/api/runs/${id}`, { headers: { 'x-oasis-code-token': localStorage.getItem('oasis-code.token') ?? '' } })).json(), runId)
  assert.equal(run.user_text, '@[Computer](tool:computer) open the page')
  assert.match(await page.locator('[aria-current="page"][data-testid^="session-"]').innerText(), /@Computer open the page/)
  await page.evaluate(() => { delete (window as { oasisCodeDesktop?: unknown }).oasisCodeDesktop })
})

test('computer use is a window in the thread: live while the agent acts on the page — the picture as it is now, the pointer, what it does — then the looks it kept, stepped through', async () => {
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
  // the desktop app's shell (a stand-in): the tab the run asked for — its own — as it is now, with the agent's pointer;
  // asked for no run (the Browser card's way), it answers the tab the person shows, another run's
  const picture = readFileSync(`${process.cwd()}/../backend-ts/tests/fixtures/images/red-7x5.jpg`).toString('base64')
  await page.evaluate((data) => {
    const asked: [string, string | null][] = []
    const surfaceFrame = async (surface: string, owner?: string | null) => {
      asked.push([surface, owner ?? null])
      const tab = owner ? { holder: owner, url: 'https://shop.e2e.example/cart', title: 'Cart', tab_id: `tab-of-${owner}` } : { holder: 'run_other0000', url: 'https://other.e2e.example/', title: 'Other', tab_id: 'tab-other' }
      return {
        surface, holder: tab.holder, last: { owner: tab.holder, party: tab.holder }, tab_id: tab.tab_id,
        doing: { action: 'click', target: 'e7', since: 1 }, pointer: { x: 320, y: 600, action: 'click', at: 1 },
        image: { media_type: 'image/jpeg', data_base64: data, width: 7, height: 5 }, url: tab.url, title: tab.title, viewport: { width: 1280, height: 800 },
      }
    }
    Object.assign(window, { e2eFramesAsked: asked, oasisCodeDesktop: { platform: 'darwin', surfaceFrame } })
  }, picture)
  await pickModel('scripted:screen')
  await page.fill('[data-testid="composer"]', 'press the button')
  await page.click('[data-testid="send"]')
  // while the click is under way: the live picture, the pointer at a quarter across and three quarters down
  const screen = page.locator('[data-testid^="run-run_"]').last().locator('[data-testid="computer-screen"]')
  await page.waitForSelector('[data-testid="computer-screen"][data-live="yes"]', { timeout: 30_000 })
  assert.equal((await screen.locator('[data-testid="screen-live"]').innerText()).trim(), 'Live')
  assert.equal(await screen.locator('.screen-site').innerText(), 'shop.e2e.example')
  assert.equal(await screen.locator('[data-testid="screen-caption"]').innerText(), 'click e7')
  assert.match(await screen.locator('.screen-view img').getAttribute('src') ?? '', /^data:image\/jpeg;base64,/)
  assert.deepEqual(await screen.locator('[data-testid="screen-pointer"]').evaluate((el) => [(el as HTMLElement).style.left, (el as HTMLElement).style.top]), ['25%', '75%'])
  assert.equal(await screen.locator('.screen-ripple').count(), 1)
  // the thread asked for its own run's tab, by the run's id — never the tab the person shows
  const liveRun = (await page.locator('[data-testid^="run-run_"]').last().getAttribute('data-testid'))!.slice(4)
  const asked = await page.evaluate(() => (window as unknown as { e2eFramesAsked: [string, string | null][] }).e2eFramesAsked)
  assert.ok(asked.length > 0)
  assert.deepEqual([...new Set(asked.map(([surface, owner]) => `${surface} ${owner}`))], [`browser ${liveRun}`])
  // the run over: the window keeps the looks — the latest shown, the one before a click away
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 30_000 })
  await page.waitForSelector('[data-testid="computer-screen"][data-live="no"]')
  assert.equal(await page.locator('[data-testid^="run-run_"]').last().locator('[data-testid="computer-screen"]').count(), 1)
  assert.equal((await screen.locator('[data-testid="screen-steps"]').innerText()).replace(/\s+/g, ' ').trim(), '2 / 2')
  assert.match(await screen.locator('[data-testid="screen-caption"]').innerText(), /^click e7 on browser · Thank you$/)
  const shot = screen.locator('.screen-view img')
  assert.match(await shot.getAttribute('src') ?? '', /^\/api\/sessions\/s_[0-9a-f]+\/attachments\/a_[0-9a-f]+/)
  await page.waitForFunction((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0, await shot.elementHandle(), { timeout: 5_000 })
  await screen.locator('[aria-label="The look before"]').click()
  assert.equal((await screen.locator('[data-testid="screen-steps"]').innerText()).replace(/\s+/g, ' ').trim(), '1 / 2')
  assert.match(await screen.locator('[data-testid="screen-caption"]').innerText(), /^look at browser · Cart$/)
  assert.equal(await screen.locator('[aria-label="The look before"]').isDisabled(), true)
  assert.match(await page.locator('[data-testid^="run-run_"]').last().innerText(), /SCREEN_DONE/)
  await page.evaluate(() => { delete (window as { oasisCodeDesktop?: unknown }).oasisCodeDesktop })
})

test("the Browser card clears the agent browser's data after asking, never while a run holds the browser", async () => {
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
  // the desktop app's shell (a stand-in): the agent's browser, held by a run until the test lets it go
  await page.evaluate(() => {
    const e2e = { cleared: 0, holder: 'run_e2e' as string | null }
    Object.assign(window, {
      e2eBrowser: e2e,
      oasisCodeDesktop: {
        platform: 'darwin', placeBrowser: () => undefined,
        browserStatus: async () => ({ opened: true, url: 'https://shop.e2e.example/cart', title: 'Cart', holder: e2e.holder }),
        clearBrowserData: async () => { e2e.cleared += 1; return { cleared: true } },
      },
    })
  })
  type E2eBrowser = { e2eBrowser: { cleared: number; holder: string | null } }
  await pickModel('scripted:screen')
  await page.fill('[data-testid="composer"]', 'press the button')
  await page.click('[data-testid="send"]')
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 30_000 })
  // the agent used the browser: its card, with Clear data — held back while a run holds the browser
  await page.waitForSelector('[data-testid="card-browser"]', { timeout: 10_000 })
  await page.click('[data-testid="card-browser"] .desk-name')
  const clear = page.locator('[data-testid="card-browser"] [data-testid="browser-clear-data"]')
  await page.waitForFunction(() => (document.querySelector('[data-testid="browser-clear-data"]') as HTMLButtonElement | null)?.disabled === true)
  assert.match(await clear.getAttribute('title') ?? '', /agent is using the browser/)
  await page.evaluate(() => { (window as unknown as E2eBrowser).e2eBrowser.holder = null })
  await page.waitForFunction(() => (document.querySelector('[data-testid="browser-clear-data"]') as HTMLButtonElement | null)?.disabled === false, undefined, { timeout: 5_000 })
  // asked first: it signs every project out; dismissed, nothing is cleared
  let asked = ''
  page.once('dialog', (d) => { asked = d.message(); void d.dismiss() })
  await clear.click()
  assert.match(asked, /every project and session/)
  assert.equal(await page.evaluate(() => (window as unknown as E2eBrowser).e2eBrowser.cleared), 0)
  page.once('dialog', (d) => { void d.accept() })
  await clear.click()
  await page.waitForFunction(() => (window as unknown as E2eBrowser).e2eBrowser.cleared === 1, undefined, { timeout: 5_000 })
  await page.evaluate(() => { delete (window as { oasisCodeDesktop?: unknown }).oasisCodeDesktop })
})

test("the Browser card's tabs carry the agent each belongs to: the person shows any of them and acts on it, Clear data waits for every run", async () => {
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
  // the desktop app's shell (a stand-in, not Electron): two agents' runs each on its own tab, a third run's tab it let
  // go of, and a tab of the person's own; the pages are fixture pictures drawn here
  await page.evaluate(() => {
    const paint = (accent: string, site: string, heading: string, lines: string[]) => {
      const c = document.createElement('canvas'); c.width = 1280; c.height = 800
      const g = c.getContext('2d')!
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 1280, 800)
      g.fillStyle = accent; g.fillRect(0, 0, 1280, 72)
      g.fillStyle = '#ffffff'; g.font = '600 28px system-ui, sans-serif'; g.fillText(site, 40, 46)
      g.fillStyle = '#1f2328'; g.font = '700 46px system-ui, sans-serif'; g.fillText(heading, 40, 160)
      g.font = '26px system-ui, sans-serif'; g.fillStyle = '#57606a'
      lines.forEach((line, i) => g.fillText(line, 40, 230 + i * 48))
      g.fillStyle = '#eef1f4'; for (let i = 0; i < 3; i += 1) g.fillRect(40 + i * 410, 450, 380, 260)
      g.fillStyle = accent; g.fillRect(40, 730, 220, 48)
      return c.toDataURL('image/jpeg', 0.92).split(',')[1]!
    }
    const tabs = [
      { id: 'tab-a', url: 'https://flights.fixture.example/sin-nrt', title: 'Flights SIN → NRT', loading: false, active: false, owner: 'run_3f9a2c1b0d4e', session: 's_aa11bb22cc33', owner_label: 'Researcher', holder: 'run_3f9a2c1b0d4e' },
      { id: 'tab-b', url: 'https://code.fixture.example/pull/482', title: 'Pull request #482', loading: false, active: false, owner: 'run_b7e41d09a2f6', session: 's_dd44ee55ff66', owner_label: 'Reviewer', holder: 'run_b7e41d09a2f6' },
      { id: 'tab-c', url: 'https://status.fixture.example/', title: 'Service status', loading: false, active: false, owner: 'run_9c1d7e2f3a4b', session: 's_aa11bb22cc33', owner_label: null, holder: null },
      { id: 'tab-p', url: 'https://docs.fixture.example/handbook', title: 'Agent handbook', loading: false, active: true, owner: null, session: null, owner_label: null, holder: null },
    ]
    const pictures: Record<string, string> = {
      'tab-a': paint('#0b6bcb', 'flights.fixture.example', 'Singapore → Tokyo Narita', ['Fri 6 Nov · 1 adult · Economy', '14 results · sorted by price']),
      'tab-b': paint('#24292f', 'code.fixture.example', 'Pull request #482: per-run tabs', ['3 files changed · 2 checks passed', 'Review requested']),
      'tab-c': paint('#1a7f37', 'status.fixture.example', 'All systems operational', ['Last checked 2 minutes ago']),
      'tab-p': paint('#8250df', 'docs.fixture.example', 'Agent handbook', ['The person\'s own tab: no agent has it']),
    }
    // hold: the card's reads are answered only when the test lets them go, with the browser as it was when asked
    const e2e = { hold: false, held: [] as (() => void)[], heldStatus: 0, heldFrames: 0, tabCalls: [] as unknown[], frameOwners: [] as (string | null)[], inputs: [] as Record<string, unknown>[], shows: 1, cleared: 0, status: {
      opened: true, url: tabs[3]!.url, title: tabs[3]!.title, loading: false, holder: null as string | null, can_go_back: false, can_go_forward: false,
      active_tab: 'tab-p', shown_page: 'tab-p#1', can_clear_data: false, tabs,
    } }
    const status = () => JSON.parse(JSON.stringify(e2e.status))
    const frameOf = (t: typeof tabs[number], page: string | null) => ({
      surface: 'browser', holder: t.holder, last: t.owner ? { owner: t.owner, party: `session:${t.session}` } : null, doing: null, pointer: null, page, tab_id: t.id,
      image: { media_type: 'image/jpeg', data_base64: pictures[t.id]!, width: 1280, height: 800 }, url: t.url, title: t.title, viewport: { width: 1280, height: 800 },
    })
    Object.assign(window, {
      e2eBrowser: e2e,
      oasisCodeDesktop: {
        platform: 'darwin', placeBrowser: () => undefined,
        browserStatus: async () => {
          const then = status()
          if (!e2e.hold) return then
          e2e.heldStatus += 1
          return new Promise((answer) => { e2e.held.push(() => answer(then)) })
        },
        browserInput: async (input: Record<string, unknown>) => { e2e.inputs.push(input); return { ok: true } },
        clearBrowserData: async () => { e2e.cleared += 1; return { cleared: true } },
        // the card asks for no run: the tab the person shows; a run asks for its own tab
        surfaceFrame: async (_surface: string, owner?: string | null) => {
          e2e.frameOwners.push(owner ?? null)
          if (owner) { const own = e2e.status.tabs.find((t) => t.owner === owner); return own ? frameOf(own, null) : null }
          const then = frameOf(e2e.status.tabs.find((t) => t.id === e2e.status.active_tab)!, e2e.status.shown_page)
          if (!e2e.hold) return then
          e2e.heldFrames += 1
          return new Promise((answer) => { e2e.held.push(() => answer(then)) })
        },
        browserTab: async (change: { action: string; id?: string }) => {
          e2e.tabCalls.push(change)
          if (change.action === 'switch') {
            const t = e2e.status.tabs.find((x) => x.id === change.id)!
            e2e.shows += 1
            Object.assign(e2e.status, { active_tab: t.id, shown_page: `${t.id}#${e2e.shows}`, url: t.url, title: t.title, holder: t.holder })
            e2e.status.tabs.forEach((x) => { x.active = x.id === t.id })
          }
          return { ok: true, status: status() }
        },
        browserNavigate: async () => ({ ok: true, status: status() }),
        pickBrowserElement: async () => null,
        cancelBrowserPick: async () => true,
      },
    })
  })
  type Tab = { id: string; url: string; title: string; loading: boolean; active: boolean; owner: string | null; session: string | null; owner_label: string | null; holder: string | null }
  type E2e = { e2eBrowser: { hold: boolean; held: (() => void)[]; heldStatus: number; heldFrames: number; tabCalls: unknown[]; frameOwners: (string | null)[]; inputs: Record<string, unknown>[]; cleared: number; status: { url: string; can_clear_data: boolean; tabs: Tab[] } } }
  const e2e = () => page.evaluate(() => (window as unknown as E2e).e2eBrowser)
  await pickModel('scripted:screen')
  await page.fill('[data-testid="composer"]', 'press the button')
  await page.click('[data-testid="send"]')
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 30_000 })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForSelector('[data-testid="card-browser"]', { timeout: 10_000 })
  await page.click('[data-testid="card-browser"] .desk-name')
  const card = page.locator('[data-testid="card-browser"]')
  await page.waitForSelector('[data-testid="card-browser"] [data-testid="browser-page"][data-shown="yes"]', { timeout: 10_000 })
  // each tab's agent: its trusted name (else its run's short id), a live dot while its run holds the tab; the person's
  // own tab carries none, whatever its title says
  const badges = () => card.locator('[data-testid="browser-tab"]').evaluateAll((els) => els.map((el) => {
    const b = el.querySelector('[data-testid="browser-tab-owner"]')
    return [el.querySelector('.browser-tab-title')?.textContent, b?.textContent ?? null, b?.getAttribute('data-live') ?? null, el.getAttribute('data-active')]
  }))
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="card-browser"] [data-testid="browser-tab"]').length === 4)
  assert.deepEqual(await badges(), [
    ['Flights SIN → NRT', 'Researcher', 'yes', 'no'], ['Pull request #482', 'Reviewer', 'yes', 'no'],
    ['Service status', 'run 9c1d', 'no', 'no'], ['Agent handbook', null, null, 'yes'],
  ])
  assert.match(await card.locator('[data-testid="browser-tab-owner"]').first().getAttribute('title') ?? '', /Researcher · using this tab\nrun run_3f9a2c1b0d4e\nsession s_aa11bb22cc33/)
  assert.equal(await card.locator('[data-testid="browser-meta"]').innerText(), '2 agents are using it')
  // the tab shown is free, but other runs hold theirs: Clear data waits (the shell's can_clear_data, not the tab shown)
  const clear = card.locator('[data-testid="browser-clear-data"]')
  await page.waitForFunction(() => (document.querySelector('[data-testid="browser-clear-data"]') as HTMLButtonElement | null)?.disabled === true)
  assert.match(await clear.getAttribute('title') ?? '', /agent is using the browser/)
  // the card as it usually sits (not expanded), with twelve agents' tabs: each tab keeps its badge readable, the strip
  // scrolls sideways, and New tab stays in reach
  await page.evaluate(() => {
    const s = (window as unknown as E2e).e2eBrowser.status
    for (let i = 0; i < 8; i += 1) s.tabs.splice(3, 0, { id: `tab-x${i}`, url: `https://w${i}.fixture.example/`, title: `Work item ${i + 1}`, loading: false, active: false, owner: `run_${(0xa0 + i).toString(16)}00c0ffee00`, session: 's_aa11bb22cc33', owner_label: `Worker ${i + 1}`, holder: i % 2 ? null : `run_${(0xa0 + i).toString(16)}00c0ffee00` })
  })
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="card-browser"] [data-testid="browser-tab"]').length === 12, undefined, { timeout: 5_000 })
  const strip = await card.evaluate((el) => {
    const tabs = el.querySelector('[data-testid="browser-tabs"]')!
    const box = el.getBoundingClientRect()
    const add = el.querySelector('[data-testid="browser-new-tab"]')!.getBoundingClientRect()
    const hit = document.elementFromPoint(add.left + add.width / 2, add.top + add.height / 2)
    return {
      card: box.width, scroll: tabs.scrollWidth, client: tabs.clientWidth,
      tabs: [...el.querySelectorAll('[data-testid="browser-tab"]')].map((t) => Math.round(t.getBoundingClientRect().width)),
      heights: [...new Set([...el.querySelectorAll('[data-testid="browser-tab"]')].map((t) => Math.round(t.getBoundingClientRect().height)))],
      labels: [...el.querySelectorAll('[data-testid="browser-tab-owner"] > span')].map((b) => Math.round(b.getBoundingClientRect().width)),
      addInCard: add.left >= box.left && add.right <= box.right && add.width > 0, addHit: !!hit?.closest('[data-testid="browser-new-tab"]'),
    }
  })
  assert.ok(strip.card < 900, `a card not expanded: ${strip.card}`)
  assert.ok(strip.scroll > strip.client, JSON.stringify(strip))
  assert.ok(strip.tabs.every((w) => w >= 80), JSON.stringify(strip))
  assert.equal(strip.labels.length, 11)
  assert.ok(strip.labels.every((w) => w >= 30), JSON.stringify(strip))
  assert.deepEqual(strip.heights, [24])
  assert.ok(strip.addInCard && strip.addHit, JSON.stringify(strip))
  const shots = `${process.cwd()}/../handoff`
  mkdirSync(shots, { recursive: true })
  await card.screenshot({ path: `${shots}/browser-agent-tabs-card.png` })
  await page.evaluate(() => { const s = (window as unknown as E2e).e2eBrowser.status; s.tabs = s.tabs.filter((t) => !t.id.startsWith('tab-x')) })
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="card-browser"] [data-testid="browser-tab"]').length === 4, undefined, { timeout: 5_000 })
  // the person shows the Reviewer's tab while a read of the browser and a picture, both asked before, are still out:
  // when they come, they are of the tab shown before and change nothing
  const picture = card.locator('.browser-stand-in')
  await picture.waitFor()
  const personPicture = await picture.getAttribute('src')
  await page.evaluate(() => { (window as unknown as E2e).e2eBrowser.hold = true })
  await page.waitForFunction(() => { const b = (window as unknown as E2e).e2eBrowser; return b.heldStatus > 0 && b.heldFrames > 0 }, undefined, { timeout: 5_000 })
  await card.locator('[data-testid="browser-tab"] .browser-tab-name').nth(1).click()
  await page.waitForSelector('[data-testid="card-browser"] [data-testid="browser-tab"][data-active="yes"]:has-text("Pull request #482")')
  // what the card shows, every frame, from before the late answers come until well after
  await page.evaluate((before) => {
    const seen = new Set<string>()
    const look = () => {
      const card = document.querySelector('[data-testid="card-browser"]')
      const address = (card?.querySelector('[data-testid="browser-address"]') as HTMLInputElement | null)?.value ?? ''
      const active = card?.querySelector('[data-testid="browser-tab"][data-active="yes"] .browser-tab-title')?.textContent ?? ''
      const old = card?.querySelector('.browser-stand-in')?.getAttribute('src') === before
      seen.add(`${address} | ${active}${old ? ' | old picture' : ''}`)
      if ((window as unknown as { e2eLooking?: boolean }).e2eLooking !== false) requestAnimationFrame(look)
    }
    Object.assign(window, { e2eSeen: seen, e2eLooking: true })
    look()
  }, personPicture)
  await page.evaluate(() => { const b = (window as unknown as E2e).e2eBrowser; b.hold = false; b.held.splice(0).forEach((let_go) => let_go()) })
  await page.waitForFunction((before) => { const src = document.querySelector('[data-testid="card-browser"] .browser-stand-in')?.getAttribute('src'); return !!src && src !== before }, personPicture, { timeout: 5_000 })
  await page.waitForTimeout(1500)
  const seen = await page.evaluate(() => { Object.assign(window, { e2eLooking: false }); return [...(window as unknown as { e2eSeen: Set<string> }).e2eSeen] })
  assert.deepEqual(seen, ['https://code.fixture.example/pull/482 | Pull request #482'])
  // an agent's navigating on the tab shown is no switch of the person's: the next read brings it
  await page.evaluate(() => { const s = (window as unknown as E2e).e2eBrowser.status; s.url = 'https://code.fixture.example/pull/482/files'; s.tabs[1]!.url = s.url })
  await page.waitForFunction(() => (document.querySelector('[data-testid="card-browser"] [data-testid="browser-address"]') as HTMLInputElement).value === 'https://code.fixture.example/pull/482/files', undefined, { timeout: 5_000 })
  await card.locator('[data-testid="card-expand"]').click()
  await page.waitForFunction(() => (document.querySelector('[data-testid="browser-page"]') as HTMLElement).offsetHeight > 400, undefined, { timeout: 5_000 })
  await card.evaluate(async (el) => { await Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))) })
  await page.waitForTimeout(300)
  const box = (await picture.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForFunction(() => (window as unknown as E2e).e2eBrowser.inputs.some((i) => i.type === 'mouseDown'))
  const down = (await e2e()).inputs.find((i) => i.type === 'mouseDown')!
  assert.equal(down.page, 'tab-b#2')
  assert.deepEqual((await e2e()).tabCalls, [{ action: 'switch', id: 'tab-b' }])
  assert.ok((await e2e()).frameOwners.includes(null), 'the card asks for the tab the person shows')
  // the whole card, for the hand-off (headless Chrome; a stand-in shell, fixture pages)
  await card.evaluate(async (el) => { await Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))) })
  await card.screenshot({ path: `${shots}/browser-agent-tabs.png` })
  // every run let go: the badges stay (who had the tab last) without the live dot, and Clear data is offered
  await page.evaluate(() => { const s = (window as unknown as E2e).e2eBrowser.status; s.tabs.forEach((t) => { t.holder = null }); s.can_clear_data = true })
  await page.waitForFunction(() => (document.querySelector('[data-testid="browser-clear-data"]') as HTMLButtonElement | null)?.disabled === false, undefined, { timeout: 5_000 })
  assert.deepEqual((await badges()).map((b) => b.slice(1, 3)), [['Researcher', 'no'], ['Reviewer', 'no'], ['run 9c1d', 'no'], [null, null]])
  page.once('dialog', (d) => { void d.accept() })
  await clear.click()
  await page.waitForFunction(() => (window as unknown as E2e).e2eBrowser.cleared === 1, undefined, { timeout: 5_000 })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.evaluate(() => { delete (window as { oasisCodeDesktop?: unknown }).oasisCodeDesktop })
})

test("the Browser card mirrors the complete fixed desktop page, scales input coordinates and retains its live frames, controls and picker", async () => {
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
  // the desktop app's shell (a stand-in): where the page is placed, what the card's controls ask, every picture asked
  const picture = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 800; const context = canvas.getContext('2d')!; context.fillStyle = '#fff'; context.fillRect(0, 0, 1280, 800); context.fillStyle = '#369'; context.fillRect(0, 0, 1280, 12); return canvas.toDataURL('image/jpeg').split(',')[1]! })
  await page.evaluate((data) => {
    const e2e = {
      places: [] as { x: number; y: number; width: number; height: number; visible: boolean }[], frames: 0, inputs: [] as Record<string, unknown>[], tabCalls: [] as unknown[], navCalls: [] as unknown[], picks: 0,
      status: { opened: true, url: 'https://shop.e2e.example/cart', title: 'Cart', loading: false, holder: null as string | null, can_go_back: false, can_go_forward: false, active_tab: 'tab-1',
        tabs: [{ id: 'tab-1', url: 'https://shop.e2e.example/cart', title: 'Cart', loading: false, active: true }, { id: 'tab-2', url: 'https://docs.e2e.example/', title: 'Docs', loading: false, active: false }] },
    }
    const status = () => JSON.parse(JSON.stringify(e2e.status))
    Object.assign(window, {
      e2eBrowser: e2e,
      oasisCodeDesktop: {
        platform: 'darwin',
        placeBrowser: (p: { x: number; y: number; width: number; height: number; visible: boolean }) => { e2e.places.push(p) },
        browserStatus: async () => status(),
        browserInput: async (input: Record<string, unknown>) => { e2e.inputs.push(input); return { ok: true } },
        clearBrowserData: async () => ({ cleared: true }),
        surfaceFrame: async (surface: string) => { e2e.frames += 1; return { surface, holder: null, last: null, doing: null, pointer: null, image: { media_type: 'image/jpeg', data_base64: data, width: 1280, height: 800 }, url: e2e.status.url, title: 'Cart', viewport: { width: 1280, height: 800 } } },
        browserTab: async (change: { action: string; id?: string }) => {
          e2e.tabCalls.push(change)
          if (change.action === 'switch') { e2e.status.active_tab = change.id!; e2e.status.tabs.forEach((t) => { t.active = t.id === change.id }) }
          return { ok: true, status: status() }
        },
        browserNavigate: async (change: { action: string; url?: string }) => {
          e2e.navCalls.push(change)
          if (change.action === 'go' && change.url === 'not an address') return { ok: false, reason: 'not an address', status: status() }
          if (change.action === 'go') { e2e.status.url = `https://${change.url}/`; e2e.status.can_go_back = true }
          return { ok: true, status: status() }
        },
        pickBrowserElement: async () => { e2e.picks += 1; return { tag: 'button', selector: '#buy', role: null, text: 'Buy now', url: 'https://shop.e2e.example/cart' } },
        cancelBrowserPick: async () => true,
      },
    })
  }, picture)
  type E2e = { e2eBrowser: { places: { x: number; y: number; width: number; height: number; visible: boolean }[]; frames: number; inputs: Record<string, unknown>[]; tabCalls: unknown[]; navCalls: unknown[]; picks: number } }
  const e2e = () => page.evaluate(() => (window as unknown as E2e).e2eBrowser)
  await pickModel('scripted:screen')
  await page.fill('[data-testid="composer"]', 'press the button')
  await page.click('[data-testid="send"]')
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 30_000 })
  await page.waitForSelector('[data-testid="card-browser"]', { timeout: 10_000 })
  await page.click('[data-testid="card-browser"] .desk-name')
  const card = page.locator('[data-testid="card-browser"]')
  // The card is a live mirror of the fixed desktop page, available as soon as it is expanded.
  assert.equal(await card.locator('[data-testid="browser-take-over"]').count(), 0)
  await page.waitForSelector('[data-testid="card-browser"] [data-testid="browser-page"][data-shown="yes"]', { timeout: 10_000 })
  const body = async () => card.locator('[data-testid="browser-page"]').evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: (el as HTMLElement).offsetWidth, height: (el as HTMLElement).offsetHeight } })
  const last = async () => (await e2e()).places.at(-1)!
  assert.deepEqual(await last(), { ...(await body()), visible: true })
  // The visible card is a live mirror, fitted like Claude's panel: reduced only, centred horizontally, at the top.
  const mirror = card.locator('.browser-stand-in')
  await mirror.waitFor()
  const checkFit = async () => {
    await card.evaluate(async (el) => { await Promise.all(el.getAnimations().map((animation) => animation.finished.catch(() => undefined))) })
    // Placement and fitted dimensions update on animation frames after the card changes size.
    await page.waitForFunction(() => {
      const bounds = document.querySelector('[data-testid="card-browser"] [data-testid="browser-page"]')?.getBoundingClientRect()
      const image = document.querySelector('[data-testid="card-browser"] .browser-stand-in')?.getBoundingClientRect()
      if (!bounds || !image) return false
      const scale = Math.min(1, bounds.width / 1280, bounds.height / 800)
      return Math.abs(image.width - Math.round(1280 * scale)) <= 1
        && Math.abs(image.height - Math.round(800 * scale)) <= 1
        && Math.abs(image.x - (bounds.x + (bounds.width - image.width) / 2)) <= 1
        && Math.abs(image.y - bounds.y) <= 1
    }, undefined, { timeout: 5000 })
    const bounds = await card.locator('[data-testid="browser-page"]').boundingBox()
    const image = await mirror.boundingBox()
    assert.ok(bounds && image)
    const scale = Math.min(1, bounds.width / 1280, bounds.height / 800)
    assert.ok(Math.abs(image.width - Math.round(1280 * scale)) <= 1)
    assert.ok(Math.abs(image.height - Math.round(800 * scale)) <= 1)
    assert.ok(Math.abs(image.x - (bounds.x + (bounds.width - image.width) / 2)) <= 1)
    assert.ok(Math.abs(image.y - bounds.y) <= 1)
    return { bounds, image }
  }
  await checkFit() // even the initially short card contains the entire page
  // Expand through the visible card control before clicking page corners. In the initial 46 px body,
  // the bottom 2% is inside the card's 6 px resize handle, which is card chrome rather than page content.
  await card.locator('[data-testid="card-expand"]').click()
  await page.waitForFunction(() => (document.querySelector('[data-testid="browser-page"]') as HTMLElement).offsetHeight > 220)
  let fitted = await checkFit()
  const expandedHeight = (await body()).height
  // Record the coordinates Chromium actually delivered. The protocol may round fractional screen positions;
  // compare the forwarded point with that event and the image's current rect, not an assumed subpixel position.
  await page.evaluate(() => {
    document.addEventListener('pointerdown', (event) => {
      const image = document.querySelector('[data-testid="browser-page"] .browser-stand-in')
      if (!image || !(event.target instanceof Element) || !event.target.closest('[data-testid="browser-page"]')) return
      const rect = image.getBoundingClientRect()
      Object.assign(window, { e2ePagePointer: { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, width: rect.width, height: rect.height } })
    }, true)
  })
  const before = (await e2e()).frames
  await page.waitForTimeout(400)
  assert.ok((await e2e()).frames > before, 'uncovered cards keep receiving complete page frames')
  fitted = await checkFit()
  const centre = { x: fitted.image.x + fitted.image.width / 2, y: fitted.image.y + fitted.image.height / 2 }
  const centreHit = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return { tag: el?.tagName, className: el?.className, testId: el?.getAttribute('data-testid') } }, centre)
  assert.match(String(centreHit.className), /browser-stand-in/, JSON.stringify({ centre, centreHit, fitted }))
  await page.mouse.click(centre.x, centre.y)
  let clicked = (await e2e()).inputs.findLast((input) => input.type === 'mouseDown')!
  assert.ok(clicked, JSON.stringify({ centre, centreHit, fitted, inputs: (await e2e()).inputs }))
  assert.ok(Math.abs(Number(clicked.x) - 640) <= 1 && Math.abs(Number(clicked.y) - 400) <= 1)
  for (const [fractionX, fractionY] of [[0.02, 0.02], [0.98, 0.02], [0.02, 0.98], [0.98, 0.98]]) {
    fitted = await checkFit()
    const target = { x: fitted.image.x + fitted.image.width * fractionX!, y: fitted.image.y + fitted.image.height * fractionY! }
    const hit = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return { tag: el?.tagName, className: el?.className } }, target)
    assert.match(String(hit.className), /browser-stand-in/, JSON.stringify({ target, hit, fitted }))
    await page.mouse.click(target.x, target.y)
    clicked = (await e2e()).inputs.findLast((input) => input.type === 'mouseDown')!
    const pointer = await page.evaluate(() => (window as unknown as { e2ePagePointer: { x: number; y: number; left: number; top: number; width: number; height: number } }).e2ePagePointer)
    const expected = { x: Math.floor((pointer.x - pointer.left) * 1280 / pointer.width), y: Math.floor((pointer.y - pointer.top) * 800 / pointer.height) }
    assert.deepEqual({ x: clicked.x, y: clicked.y }, expected, JSON.stringify({ fractionX, fractionY, clicked, expected, pointer, fitted, hit }))
  }
  const blank = fitted.bounds.height - fitted.image.height > 8
    ? { x: fitted.bounds.x + fitted.bounds.width / 2, y: fitted.image.y + fitted.image.height + (fitted.bounds.height - fitted.image.height) / 2 }
    : { x: (fitted.bounds.x + fitted.image.x) / 2, y: fitted.image.y + fitted.image.height / 2 }
  assert.ok(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-testid="browser-page"]'), blank), 'the margin click belongs to the page body, not the resize handle')
  const downBefore = (await e2e()).inputs.filter((input) => input.type === 'mouseDown').length
  await page.mouse.click(blank.x, blank.y)
  assert.equal((await e2e()).inputs.filter((input) => input.type === 'mouseDown').length, downBefore, 'blank space around the page is not a page click')
  await page.mouse.click(fitted.image.x + fitted.image.width / 2, fitted.image.y + fitted.image.height / 2)
  await page.keyboard.type('flight')
  await page.keyboard.insertText('上海')
  await page.keyboard.press('Enter')
  await page.mouse.wheel(0, 240)
  await page.waitForFunction(() => (window as unknown as E2e).e2eBrowser.inputs.some((input) => input.type === 'mouseWheel'))
  const inputCalls = (await e2e()).inputs
  assert.equal(inputCalls.filter((input) => input.type === 'text').map((input) => input.text).join(''), 'flight上海')
  assert.ok(inputCalls.some((input) => input.type === 'keyDown' && input.keyCode === 'Enter'))
  assert.ok(inputCalls.some((input) => input.type === 'mouseWheel' && input.deltaY === 240))
  // Return to the small card before testing the remaining card controls and resize gesture.
  await card.locator('[data-testid="card-expand"]').click()
  await page.waitForFunction((tall) => (document.querySelector('[data-testid="browser-page"]') as HTMLElement).offsetHeight < tall, expandedHeight)
  await checkFit()
  // Display dimensions follow direct resize gestures without eased width or height.
  assert.doesNotMatch(await card.evaluate((el) => getComputedStyle(el).transitionProperty), /width|height/)
  // DOM overlays cover only their own pixels; the mirror and its remaining visible content stay live.
  const size = await body()
  await card.locator('[data-testid="browser-page"]').evaluate((el) => {
    const r = el.getBoundingClientRect()
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.id = 'e2e-menu'
    Object.assign(menu.style, { position: 'fixed', left: `${r.right - 40}px`, top: `${r.top + 20}px`, width: '120px', height: '60px', zIndex: '5000', background: 'white' })
    document.body.appendChild(menu)
  })
  await page.waitForSelector('[data-testid="card-browser"] [data-testid="browser-page"][data-shown="yes"]')
  assert.deepEqual(await last(), { ...size, visible: true })
  await page.waitForSelector('[data-testid="card-browser"] .browser-stand-in')
  assert.ok((await e2e()).frames > before)
  await page.evaluate(() => document.getElementById('e2e-menu')!.remove())
  await page.waitForSelector('[data-testid="card-browser"] [data-testid="browser-page"][data-shown="yes"]')
  assert.deepEqual(await last(), { ...size, visible: true })
  // anything else over any part of it (here a bit of a floating element over an inner point): the same
  await card.locator('[data-testid="browser-page"]').evaluate((el) => {
    const r = el.getBoundingClientRect()
    const chip = document.createElement('div')
    chip.id = 'e2e-chip'
    Object.assign(chip.style, { position: 'fixed', left: `${r.left + 6 + (r.width - 12) / 4 - 4}px`, top: `${r.top + 6 + (r.height - 12) * 3 / 4 - 4}px`, width: '8px', height: '8px', zIndex: '5000' })
    document.body.appendChild(chip)
  })
  await page.waitForSelector('[data-testid="card-browser"] [data-testid="browser-page"][data-shown="yes"]')
  await page.evaluate(() => document.getElementById('e2e-chip')!.remove())
  await page.waitForSelector('[data-testid="card-browser"] [data-testid="browser-page"][data-shown="yes"]')
  // Resize the card again: its mirror follows the new body while the source viewport stays fixed (the stack is
  // at the desk's top right, so its left edge is the one with room).
  const edge = card.locator('.desk-resize-w')
  const box = (await edge.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  for (let i = 1; i <= 6; i += 1) await page.mouse.move(box.x + box.width / 2 - i * 10, box.y + box.height / 2)
  await page.mouse.up()
  const resized = await body()
  assert.notEqual(resized.width, size.width)
  await page.waitForFunction((want) => { const p = (window as unknown as E2e).e2eBrowser.places.at(-1)!; return p.height === want.height && p.width === want.width && p.visible }, resized)
  await checkFit()
  // its tabs and address bar: the person's own controls, handed to the shell
  assert.deepEqual(await card.locator('[data-testid="browser-tab"]').evaluateAll((els) => els.map((el) => [el.textContent, el.getAttribute('data-active')])), [['Cart', 'yes'], ['Docs', 'no']])
  await card.locator('[data-testid="browser-tab"] .browser-tab-name').nth(1).click()
  await page.waitForSelector('[data-testid="card-browser"] [data-testid="browser-tab"][data-active="yes"]:has-text("Docs")')
  await card.locator('[data-testid="browser-new-tab"]').click()
  assert.equal(await card.locator('[data-testid="browser-back"]').isDisabled(), true)
  await card.locator('[data-testid="browser-address"]').fill('not an address')
  await card.locator('[data-testid="browser-address"]').press('Enter')
  await page.waitForSelector('[data-testid="card-browser"] [data-testid="browser-address"][aria-invalid="true"]')
  await card.locator('[data-testid="browser-address"]').fill('docs.e2e.example/guide')
  await card.locator('[data-testid="browser-address"]').press('Enter')
  await page.waitForFunction(() => !(document.querySelector('[data-testid="card-browser"] [data-testid="browser-back"]') as HTMLButtonElement).disabled)
  const calls = await e2e()
  assert.deepEqual(calls.tabCalls, [{ action: 'switch', id: 'tab-2' }, { action: 'new' }])
  assert.deepEqual(calls.navCalls, [{ action: 'go', url: 'not an address' }, { action: 'go', url: 'docs.e2e.example/guide' }])
  // the element picker: what the person picked is a line of their message
  await card.locator('[data-testid="browser-pick"]').click()
  await page.waitForFunction(() => /The element `#buy` \(<button> "Buy now"\) on https:\/\/shop\.e2e\.example\/cart/.test(document.querySelector('[data-testid="composer"]')?.textContent ?? ''), undefined, { timeout: 5_000 })
  assert.equal((await e2e()).picks, 1)
  // covered again, then put away: no picture is asked for a card that is not on screen
  await card.locator('[data-testid="browser-page"]').evaluate((el) => {
    const r = el.getBoundingClientRect()
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.id = 'e2e-menu-2'
    Object.assign(menu.style, { position: 'fixed', left: `${r.left + 10}px`, top: `${r.top + 10}px`, width: '60px', height: '30px', zIndex: '5000' })
    document.body.appendChild(menu)
  })
  await page.waitForSelector('[data-testid="card-browser"] [data-testid="browser-page"][data-shown="yes"]')
  await card.locator('[data-testid="card-shelve"]').click()
  await page.waitForSelector('[data-testid="card-browser"]', { state: 'detached' })
  const shelved = (await e2e()).frames
  await page.waitForTimeout(1000)
  assert.equal((await e2e()).frames, shelved)
  assert.equal((await e2e()).places.at(-1)!.visible, false)
  await page.evaluate(() => { document.getElementById('e2e-menu-2')?.remove(); delete (window as { oasisCodeDesktop?: unknown }).oasisCodeDesktop })
})

test('math in an answer is typeset: a line of $$…$$, a \\[…\\] block, \\(…\\) and $…$ inline — and a price and a code span stay as written', async () => {
  await page.click('[data-testid="new-task"]')
  await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
  await pickModel('scripted:m')
  await page.fill('[data-testid="composer"]', 'explain the coverage bound')
  await page.click('[data-testid="send"]')
  await page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 30_000 })
  const answer = page.locator('[data-testid^="run-run_"]').last().locator('.turn-agent .prose')
  assert.equal(await answer.locator('.katex-display').count(), 2)                                // the owner's formula and the \[…\] block
  assert.equal(await answer.locator('.katex').count(), 4)                                        // those two, and x_i and L(θ) inline
  assert.equal(await answer.locator('.katex-error').count(), 0)                                  // \rm, \mathcal and Chinese in \text{} all read
  assert.equal(await answer.locator('.katex [style*="color"]').count(), 0)                      // and no command left red: the markdown-escaped star is a star
  assert.match(await answer.innerText(), /A room costs \$120–\$180 per night/)
  assert.equal(await answer.locator('code').last().innerText(), 'echo $x$')
})

test("a session's own director takes the composer's words: it has an agent do the work, its answer stands before that run, the run's end is one line; the agent named directly wakes it not", async () => {
  // No warm-up agent run and no POST /director: the person calls the director in, and the first message to it opens it.
  const api = (method: string, path: string, body?: unknown) => page.evaluate(async ({ method, path, body }) => {
    const res = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-oasis-code-token': localStorage.getItem('oasis-code.token') ?? '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!res.ok) throw new Error(`${path}: ${res.status}`)
    return res.json()
  }, { method, path, body })
  const project = await api('POST', '/api/projects', { no_folder: true })
  const created = await api('POST', `/api/projects/${project.id}/sessions`, { model: 'scripted:dir', title: 'director first message' })
  const sid = created.id
  await page.reload()
  await page.waitForSelector(`[data-testid="session-${sid}"]`)
  await page.click(`[data-testid="session-${sid}"]`)
  // a session's words go to its agent until the director is called in; then its chip heads them, the agent's model
  // picker steps aside
  await page.click('[data-testid="thread-composer"] [data-testid="restore-director"]')
  await page.waitForSelector('[data-testid="thread-composer"] [data-testid="director-chip"]')
  assert.equal(await page.locator('[data-testid="thread-composer"] [data-testid="model-picker"]').count(), 0)
  // an agent named in words for the director: its chip keeps none of the first line's indent (the director's chip
  // stands before the words), and an @ right after Chinese opens the menu again
  await page.click('[data-testid="composer"]')
  await page.keyboard.type('@scripted wor')
  await page.waitForSelector('[data-testid="mention-agent-scripted:w"]')
  await page.keyboard.press('Enter')
  assert.notEqual(await page.locator('[data-testid="composer"]').evaluate((el) => (el as HTMLElement).style.textIndent), '')
  assert.deepEqual(await page.locator('[data-testid="composer"] [data-testid="agent-chip"]').evaluate((el) => [getComputedStyle(el).textIndent, getComputedStyle(el.querySelector('.agent-chip-label')!).textIndent]), ['0px', '0px'])
  await page.keyboard.type('的地方@')
  await page.waitForSelector('[data-testid="entity-picker"] .mention-agent')                     // the menu opens, with the agents
  await page.keyboard.press('Escape')
  await page.fill('[data-testid="composer"]', '')
  await page.fill('[data-testid="composer"]', 'have someone do the work')
  await page.click('[data-testid="send"]')
  await page.waitForFunction(() => document.body.innerText.includes('DIRECTOR_JUDGED'), undefined, { timeout: 60_000 })
  // the order: the person's words to the director, its answer, then the run it started (its words said to come from
  // the director), the run's end as one line — never a bubble of the person's — then the director's word on it
  const order = await page.locator('[data-testid="thread"] > *').evaluateAll((els) => els.map((el) => {
    const id = el.getAttribute('data-testid') ?? ''
    const text = (el as HTMLElement).innerText
    return id.startsWith('run-run_') ? (text.includes('WORK_DONE') ? 'run:worker' : 'run:other')
      : text.includes('DIRECTOR_HANDED') ? 'director:handed' : text.includes('DIRECTOR_JUDGED') ? 'director:judged' : text.includes('have someone do the work') ? 'you' : id
  }))
  const at = (x: string) => order.indexOf(x)
  assert.ok(at('you') >= 0 && at('you') <= at('director:handed'), order.join(' '))
  assert.ok(at('director:handed') < at('run:worker') && at('run:worker') < at('director:judged'), order.join(' '))
  const worker = page.locator('[data-testid^="run-run_"]').filter({ hasText: 'WORK_DONE' })
  assert.match(await worker.locator('[data-testid="run-from-director"]').innerText(), /Scripted Director · director → Scripted Worker/i)                      // the CSS shows it in capitals
  assert.match(await page.locator('[data-testid="director-event"]').last().innerText(), /Scripted Worker finished — the director reads the result/)
  assert.equal(await page.locator('.turn-user').filter({ hasText: 'task event' }).count(), 0)
  // the chip taken away: the words go to the agent; its run ends and the director stays asleep
  const turns = (await api('GET', `/api/sessions/${sid}/director`)).turns.length
  await page.click('[data-testid="director-chip-remove"]')
  await page.waitForSelector('[data-testid="thread-composer"] [data-testid="model-picker"]')
  const done = await page.locator('[data-testid^="run-run_"][data-status="done"]').count()
  await pickModel('scripted:g')
  await page.fill('[data-testid="composer"]', 'write a note')
  await page.click('[data-testid="send"]')
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="run-run_"][data-status="done"]').length === n + 1, done, { timeout: 30_000 })
  await new Promise((r) => setTimeout(r, 1500))
  const after = await api('GET', `/api/sessions/${sid}/director`)
  assert.equal(after.turns.length, turns)
  assert.equal(after.pending_events.length, 1)                                                   // held for its next turn
  await api('DELETE', `/api/sessions/${sid}/director`)
})

test("a link's chip wears the site's own icon — kept from a page the run read, or asked of a site only cited — and a site with none keeps its letter", async () => {
  await page.click('[data-testid="new-task"]')
  await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
  await pickModel('scripted:f')
  await page.fill('[data-testid="composer"]', 'read the guide')
  await page.click('[data-testid="send"]')
  await page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 30_000 })
  const turn = page.locator('[data-testid^="run-run_"]').last()
  const fetched = turn.locator('a.source-chip[href="https://docs.e2e.example/guide"]')
  const cited = turn.locator('a.source-chip[href="https://other.e2e.example/"]')
  // the icon is the session's own route, and the image it answers is drawn (the page's cookie reads it)
  const icon = fetched.locator('[data-testid="source-icon"]')
  await icon.waitFor()
  assert.match(await icon.getAttribute('src') ?? '', /^\/api\/sessions\/s_[0-9a-f]+\/site-icons\/a_[0-9a-f]+$/)
  await page.waitForFunction((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0, await icon.elementHandle(), { timeout: 5_000 })
  // a site only cited: its icon asked of the site itself through the harness (no icon service), once it loaded
  const named = turn.locator('a.source-chip[href="https://cited.e2e.example/news"] [data-testid="source-icon"]')
  await named.waitFor({ timeout: 10_000 })
  assert.match(await named.getAttribute('src') ?? '', /^\/api\/sessions\/s_[0-9a-f]+\/site-icons\/by-host\/cited\.e2e\.example$/)
  // a site with no icon to give keeps its letter (and shows no broken picture meanwhile)
  await page.waitForTimeout(1500)
  assert.equal(await cited.locator('[data-testid="source-icon"]').count(), 0)
  assert.equal(await cited.locator('.source-mark').innerText(), 'O')
  // the sources under the answer wear them too
  await turn.locator('.sources-toggle').click()
  assert.equal(await turn.locator('.sources-list [data-testid="source-icon"]').count(), 2)
})

test('links that open nothing are words, not clicks: the page stays and the unsent draft with it; a web link opens outside', async () => {
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
  await pickRepoFolder()
  await pickModel('scripted:l')
  await page.fill('[data-testid="composer"]', 'show me some links')
  await page.click('[data-testid="send"]')
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 30_000 })
  const turn = page.locator('[data-testid^="run-run_"]').last()
  await turn.locator('[data-testid="link-inert"]').first().waitFor()
  assert.equal(await turn.locator('a[href=""]').count(), 0)                                   // no empty target to follow
  assert.deepEqual(await turn.locator('[data-testid="link-inert"]').allInnerTexts(), ['JS sentinel', 'Data sentinel', 'File sentinel', 'relative'])
  const web = turn.locator('a.source-chip')
  assert.equal(await web.getAttribute('href'), 'https://example.com/page')
  assert.equal(await web.getAttribute('target'), '_blank')
  // a draft typed and not sent, then every inert link clicked: same page, same session, the draft still there
  const url = page.url()
  const session = await page.locator('[aria-current="page"][data-testid^="session-"]').getAttribute('data-testid')
  await page.click('[data-testid="composer"]')
  await page.keyboard.type('QA_DRAFT_UNSENT')
  for (const link of await turn.locator('[data-testid="link-inert"]').all()) await link.click()
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(page.url(), url)
  assert.equal(await page.locator('[aria-current="page"][data-testid^="session-"]').getAttribute('data-testid'), session)
  assert.equal(await composerText(), 'QA_DRAFT_UNSENT')
  await page.fill('[data-testid="composer"]', '')
})

test("a run's pictures show in the thread: the image a tool handed the model under its row, a picture the answer names on hover and whole on a click", async () => {
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]')
  await pickRepoFolder()
  await pickModel('scripted:media')
  await page.fill('[data-testid="composer"]', 'render a shot')
  await page.click('[data-testid="send"]')
  await page.waitForSelector('[data-testid^="run-"][data-status="done"]', { timeout: 30_000 })
  const turn = page.locator('[data-testid^="run-"]').last()
  // the round, opened: the read_file row carries the picture it handed the model, served by the session
  const head = turn.locator('.work-head')
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click()
  const thumb = turn.locator('.row.activity[data-tool="read_file"] [data-testid="shown-images"] img')
  await thumb.waitFor()
  assert.match(await thumb.getAttribute('src') ?? '', /^\/api\/sessions\/[\w-]+\/attachments\/[\w-]+$/)
  assert.equal(await thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), 1)
  await thumb.click()
  await page.waitForSelector('[data-testid="media-viewer"] img')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="media-viewer"]', { state: 'detached' })
  // the answer: the path in code is a chip that shows the picture on hover, the markdown image is the picture
  const chip = turn.locator('.prose [data-testid="media-chip"]', { hasText: 'shot.png' })
  assert.equal(await chip.innerText(), 'shot.png')
  await chip.hover()
  const hovered = page.locator('[data-testid="media-hover"] img')
  await hovered.waitFor()
  assert.match(await hovered.getAttribute('src') ?? '', /^\/api\/workspaces\/[\w-]+\/media\?path=shot\.png$/)
  await page.waitForFunction(() => { const img = document.querySelector('[data-testid="media-hover"] img') as HTMLImageElement | null; return !!img && img.complete && img.naturalWidth === 1 })
  await page.mouse.move(0, 0)
  const pictured = turn.locator('.prose [data-testid="workspace-image"] img')
  await page.waitForFunction(() => { const img = document.querySelector('.prose [data-testid="workspace-image"] img') as HTMLImageElement | null; return !!img && img.complete && img.naturalWidth === 1 })
  await pictured.click()
  await page.waitForSelector('[data-testid="media-viewer"] img')
  await page.keyboard.press('Escape')
  // a picture named by its file name alone, its folder said a line above: the one file of the workspace by that name
  await turn.locator('.prose [data-testid="media-chip"]', { hasText: 'frame.png' }).hover()
  await page.waitForFunction(() => { const img = document.querySelector('[data-testid="media-hover"] img') as HTMLImageElement | null; return !!img && img.complete && img.naturalWidth === 1 })
  await page.mouse.move(0, 0)
  // a name the workspace has no file for: no broken picture — the chip goes back to the words
  await turn.locator('.prose [data-testid="media-chip"]', { hasText: 'gone.png' }).hover()
  const goneChip = turn.locator('.prose [data-testid="media-chip"]', { hasText: 'gone.png' })
  await goneChip.waitFor({ state: 'detached' })
  assert.equal(await page.locator('[data-testid="media-hover"]').count(), 0)
  assert.equal(await turn.locator('.prose code', { hasText: 'gone.png' }).count(), 1)
})

test('a narrow window (the desktop app allows 720 wide): the cards and the dock stay inside the desk, one above the other, and the workspace card\'s controls take an ordinary click', async () => {
  // the session of the previous test is open (cards for the workspace and the relay's agent, the dock)
  await showTeams(page)
  await page.setViewportSize({ width: 651, height: 763 })
  try {
    await page.waitForFunction(() => {
      const desk = document.querySelector('[data-testid="desk"]')?.getBoundingClientRect()
      const wins = [...document.querySelectorAll('.desk-win:not(.expanded)')].map((el) => el.getBoundingClientRect())
      return !!desk && wins.length > 0 && wins.every((r) => r.left >= desk.left - 1 && r.right <= desk.right + 1 && r.top >= desk.top - 1 && r.bottom <= desk.bottom + 1)
    }, undefined, { timeout: 5_000 })
    const shapes = await page.evaluate(() => {
      const desk = document.querySelector('[data-testid="desk"]')!.getBoundingClientRect()
      const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { l: r.left - desk.left, t: r.top - desk.top, r: r.right - desk.left, b: r.bottom - desk.top, w: r.width, h: r.height } }
      const dock = document.querySelector('[data-testid="graph-dock"]')
      const cards = [...document.querySelectorAll('.desk-win:not(.expanded):not(.kind-graph)')]
      const composer = document.querySelector('.composer-dock > *')
      return { desk: { w: desk.width, h: desk.height }, dock: dock ? rect(dock) : null, cards: cards.map((c) => ({ id: c.getAttribute('data-testid'), ...rect(c) })), composer: composer ? rect(composer) : null }
    })
    assert.ok(shapes.desk.w < 420, `a narrow desk: ${shapes.desk.w}`)
    assert.ok(shapes.dock, 'the dock is shown')
    for (const c of shapes.cards) {
      assert.ok(c.w <= shapes.desk.w, `card ${c.id} fits the desk: ${c.w} <= ${shapes.desk.w}`)
      const overlaps = !(c.r <= shapes.dock!.l + 1 || c.l >= shapes.dock!.r - 1 || c.b <= shapes.dock!.t + 1 || c.t >= shapes.dock!.b - 1)
      assert.equal(overlaps, false, `card ${c.id} clear of the dock`)
    }
    if (shapes.composer) assert.ok(shapes.dock!.b <= shapes.composer.t + 1, 'the dock stays above the composer')
    // the workspace card's Shelve and Expand are the elements under their own centres, and an ordinary click works
    const workspace = page.locator('[data-testid="card-workspace"]')
    await workspace.locator('.desk-title').click()
    for (const control of ['card-shelve', 'card-expand']) {
      const hit = await workspace.locator(`[data-testid="${control}"]`).evaluate((el) => {
        const r = el.getBoundingClientRect()
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return at === el || !!(at && el.contains(at))
      })
      assert.equal(hit, true, `${control} is what the pointer meets`)
    }
    await workspace.locator('[data-testid="card-expand"]').click()
    await page.waitForSelector('[data-testid="card-workspace"].expanded')
    await page.locator('[data-testid="card-workspace"] [data-testid="card-expand"]').click()
    await page.waitForSelector('[data-testid="card-workspace"].expanded', { state: 'detached' })
    await workspace.locator('[data-testid="card-shelve"]').click()
    await page.waitForSelector('[data-testid="card-workspace"]', { state: 'detached' })
    await page.click('[data-testid="desk-shelf"]')
    await page.click('.desk-tail-list .desk-chip:has-text("Workspace")')
    await page.waitForSelector('[data-testid="card-workspace"]')
    // the composer still takes words
    await page.click('[data-testid="composer"]')
    await page.keyboard.type('narrow words')
    assert.equal(await composerText(), 'narrow words')
    await page.fill('[data-testid="composer"]', '')
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 })
  }
})

// ---------------------------------------------------------------- Intelligent UI (present_ui → DB → SSE → native block)

/** The scripted:ui-* routes (backend-ts/scripts/e2e_server.ts) present the calculator through the real present_ui
 *  tool; words carrying this marker keep the run running after the surface is shown until uiRelease(). */
const UI_HOLD = 'UI_HOLD_LIVE'
/** …and this one keeps it running before it presents anything, until uiRelease('before') */
const UI_HOLD_BEFORE = 'UI_HOLD_BEFORE'
/** The calculator's blocks in the thread (a run's card on the desk may show the same surface: a second view of it) */
const THREAD_CALC = '[data-testid="thread"] [data-testid="ui-surface-calc"]'

interface UiRecordView { run_id: string; surface_id: string; revision: number; state: Record<string, unknown>; spec: { title: string } }

/** A JSON call of the page's own API, with the page's token (what the app's client sends). */
async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  return page.evaluate(async ([p, method, body]) => {
    const res = await fetch(p, { method, headers: { 'content-type': 'application/json', 'x-oasis-code-token': localStorage.getItem('oasis-code.token') ?? '' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }, [path, init.method ?? 'GET', init.body] as const) as Promise<{ status: number; body: T }>
}
const currentSession = async () => (await page.locator('[aria-current="page"][data-testid^="session-"]').getAttribute('data-testid'))!.slice('session-'.length)
const surfacesOf = async (sessionId: string) => (await api<{ surfaces: UiRecordView[] }>(`/api/sessions/${sessionId}/ui`)).body.surfaces
const threadRunCount = async (sessionId: string) => ((await api<{ runs: unknown[] }>(`/api/sessions/${sessionId}`)).body.runs).length
const runStatus = async (runId: string) => (await api<{ status: string }>(`/api/runs/${runId}`)).body.status

/** Release a held ui run: asked until the run is at its gate (its last model call may not have begun yet). */
async function uiRelease(gate: 'after' | 'before' = 'after') {
  for (let i = 0; i < 100; i += 1) {
    const r = await fetch(`${BASE}/e2e/ui-release?gate=${gate}`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` } })
    if (((await r.json()) as { released: boolean }).released) return
    await new Promise((res) => setTimeout(res, 100))
  }
  throw new Error('the ui run never reached its gate')
}

/** A new task with no folder, on a route, through the start screen's real composer; the session's id. */
async function startUiTask(model: string, words: string, base = BASE): Promise<string> {
  await page.goto(`${base}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
  if (await page.locator('[data-testid="folder-clear"]').count()) await page.click('[data-testid="folder-clear"]')
  await pickModel(model)
  await page.fill('[data-testid="composer"]', words)
  await page.click('[data-testid="send"]')
  await page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
  return currentSession()
}

/** A reload of the page (the start screen), then the session opened again: everything shown is read back. */
async function reloadInto(sessionId: string) {
  await page.reload()
  await page.waitForSelector(`[data-testid="session-${sessionId}"]`)
  await page.click(`[data-testid="session-${sessionId}"]`)
  await page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
  await bypassDirector(page)
}

/** The next PUT of a surface's state the page sends (its URL names session, run and surface), and its answer. */
const nextStatePut = (runId: string) => page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes(`/ui/${runId}/calc/state`), { timeout: 10_000 })

/** Every surface request the page sends from now on (PUT state, POST actions), to prove none was sent. */
function watchSurfaceRequests() {
  const seen: string[] = []
  const on = (r: { method: () => string; url: () => string }) => { if (/\/ui\/[^/]+\/[^/]+\/(state|actions)$/.test(new URL(r.url()).pathname)) seen.push(`${r.method()} ${new URL(r.url()).pathname}`) }
  page.on('request', on)
  return { seen, stop: () => page.off('request', on) }
}

test('intelligent ui: a surface arrives live, computes locally, saves (cleared too), survives a reload; an action only fills the draft', async () => {
  const sessionId = await startUiTask('scripted:ui-a', `show me the price calculator ${UI_HOLD}`)
  const surface = page.locator(THREAD_CALC)
  await surface.waitFor({ timeout: 30_000 })
  const runId = (await surface.getAttribute('data-run'))!
  // it came over the live stream: the run is still running (held at its gate) while the block is on the page
  assert.equal(await runStatus(runId), 'running')
  assert.equal(await surface.getAttribute('data-kind'), 'native')
  assert.equal(await surface.getAttribute('data-revision'), '1')
  assert.match(await surface.locator('.uis-name').innerText(), /Price calculator A/)
  const qty = surface.getByLabel('Quantity', { exact: true })
  const total = surface.locator('.uis-metric-value')
  assert.equal(await qty.inputValue(), '3')
  assert.match(await total.innerText(), /^12\s*USD$/)

  // an edit computes at once (no request needed for the total), then is saved after the pause
  const put5 = nextStatePut(runId)
  await qty.fill('5')
  assert.match(await total.innerText(), /^20\s*USD$/)
  const saved5 = await put5
  assert.equal(saved5.status(), 200)
  assert.deepEqual(saved5.request().postDataJSON().state.qty, 5)
  assert.equal((await surfacesOf(sessionId)).find((s) => s.run_id === runId)!.state.qty, 5)
  // a number cleared is written as null (not left at its old value, not dropped)
  const putCleared = nextStatePut(runId)
  await qty.fill('')
  const cleared = await putCleared
  assert.equal(cleared.status(), 200)
  assert.equal(cleared.request().postDataJSON().state.qty, null)
  assert.equal((await surfacesOf(sessionId)).find((s) => s.run_id === runId)!.state.qty, null)
  const put6 = nextStatePut(runId)
  await qty.fill('6')
  assert.equal((await put6).status(), 200)
  await surface.locator('[data-testid="ui-save"][data-state="saved"]').waitFor()

  // the run ends: the surface stays one block (the live one becomes the transcript's), at its saved value
  await uiRelease()
  await page.waitForSelector(`[data-testid="run-${runId}"][data-status="done"]`, { timeout: 30_000 })
  assert.equal(await page.locator(`${THREAD_CALC}[data-run="${runId}"]`).count(), 1, 'the thread shows the surface once')
  const transcript = (await api<{ entries: { kind: string; surface?: UiRecordView }[] }>(`/api/runs/${runId}/transcript`)).body.entries
  const uiEntries = transcript.filter((e) => e.kind === 'ui')
  assert.equal(uiEntries.length, 1, 'the transcript shows the surface once')
  assert.equal(uiEntries[0]!.surface!.state.qty, 6)
  assert.equal(await qty.inputValue(), '6')

  // a reload reads it back from the database
  await reloadInto(sessionId)
  await surface.waitFor({ timeout: 30_000 })
  assert.equal(await page.locator(THREAD_CALC).count(), 1)
  assert.equal(await qty.inputValue(), '6')
  assert.match(await total.innerText(), /^24\s*USD$/)

  // an action: prepared by the harness, put after the person's own draft — never sent, no run started
  await page.waitForSelector('[data-testid="thread-composer"]')
  await page.click('[data-testid="composer"]')
  await page.keyboard.type('KEEP_THIS_DRAFT')
  assert.equal(await composerText(), 'KEEP_THIS_DRAFT')
  const runsBefore = await threadRunCount(sessionId)
  const sends: string[] = []
  const onRequest = (r: { method: () => string; url: () => string }) => { if (r.method() === 'POST' && /\/(chat|messages|runs)\b/.test(new URL(r.url()).pathname)) sends.push(r.url()) }
  page.on('request', onRequest)
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/ui/${runId}/calc/actions`))
  await surface.locator('[data-testid="ui-action-order"]').click()
  const action = await posted
  assert.equal(action.status(), 200)
  const sent = action.request().postDataJSON()
  assert.equal(sent.action_id, 'order')
  assert.equal(sent.state.qty, 6, 'the press carries the value on show')
  const prompt = String((await action.json()).prompt)
  assert.ok(prompt.includes(`from run ${runId}`), prompt)
  await surface.locator('[data-testid="ui-action-drafted"]').waitFor()
  const draft = await composerText()
  assert.ok(draft.startsWith('KEEP_THIS_DRAFT'), `the person's words stay first: ${draft}`)
  assert.ok(draft.includes('Order the items'), `the action's words follow: ${draft}`)
  await page.waitForTimeout(1_000)
  page.off('request', onRequest)
  assert.deepEqual(sends, [], 'nothing was sent')
  assert.equal(await threadRunCount(sessionId), runsBefore, 'no run was started')
  assert.equal(await page.locator('[data-testid="stop"]').count(), 0)

  // the block drawn again while its save is on its way (Text version, then Show surface): the save lands first, the
  // press after it, with the value on show — the queue is the surface's, not the unmounted component's
  const order: string[] = []
  const statePath = `/ui/${runId}/calc/state`
  await page.route(`**${statePath}`, async (route) => {
    order.push(`PUT ${String(route.request().postDataJSON().state.qty)} start`)
    await new Promise((r) => setTimeout(r, 1_500))           // a slow harness: the save is still on its way below
    const response = await route.fetch()
    order.push(`PUT ${response.status()} end`)
    await route.fulfill({ response })
  })
  // the run's own card on the desk (a second view of the surface) is put away: the thread's block is then the queue's
  // only view — unmounted and drawn again, nothing of the queue's may be lost
  const runCard = page.locator(`[data-testid="card-${runId}"]`)
  if (await runCard.count()) {
    await runCard.locator('[data-testid="card-close"]').click()
    await runCard.waitFor({ state: 'detached' })
  }
  try {
    const onPost = (r: { method: () => string; url: () => string; postDataJSON: () => { state: { qty: unknown } } }) => {
      if (r.method() === 'POST' && r.url().includes(`/ui/${runId}/calc/actions`)) order.push(`POST ${String(r.postDataJSON().state.qty)}`)
    }
    page.on('request', onPost)
    const sentPut = page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes(statePath))
    await qty.fill('7')
    await sentPut
    // by keyboard (the desk's cards lie over the block's header at this window size): focus, Enter
    const toggle = surface.locator('[data-testid="ui-text-toggle"]')
    await toggle.focus(); await page.keyboard.press('Enter')
    await surface.locator('[data-testid="ui-fallback"]').waitFor()
    assert.equal(await surface.locator('input').count(), 0, 'the surface is gone: its component unmounted')
    await toggle.focus(); await page.keyboard.press('Enter')
    await qty.waitFor()
    assert.equal(await qty.inputValue(), '7', 'drawn again, it shows the edit still on its way')
    const posted2 = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/ui/${runId}/calc/actions`))
    await surface.locator('[data-testid="ui-action-order"]').click()
    assert.equal((await posted2).status(), 200)
    page.off('request', onPost)
    assert.deepEqual(order, ['PUT 7 start', 'PUT 200 end', 'POST 7'], 'one request at a time, in the order made, across the redraw')
    assert.equal((await surfacesOf(sessionId)).find((s) => s.run_id === runId)!.state.qty, 7)
  } finally {
    await page.unroute(`**${statePath}`)
  }
  await page.fill('[data-testid="composer"]', '')
})

test('intelligent ui: two runs of one session present the same surface id; each is its own surface, saved and pressed as its own', async () => {
  const sessionId = await startUiTask('scripted:ui-a', 'show me the price calculator')
  const runA = (await page.locator(THREAD_CALC).first().waitFor({ timeout: 30_000 }).then(() => page.locator(THREAD_CALC).first().getAttribute('data-run')))!
  await page.waitForSelector(`[data-testid="run-${runA}"][data-status="done"]`, { timeout: 30_000 })
  // the second run, on the other route, in the same session
  await pickModel('scripted:ui-b')
  await page.fill('[data-testid="composer"]', 'show me the price calculator again')
  await page.click('[data-testid="send"]')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="thread"] [data-testid="ui-surface-calc"]').length === 2, undefined, { timeout: 30_000 })
  const runB = (await page.locator(THREAD_CALC).nth(1).getAttribute('data-run'))!
  assert.notEqual(runA, runB)
  await page.waitForSelector(`[data-testid="run-${runB}"][data-status="done"]`, { timeout: 30_000 })
  const a = page.locator(`${THREAD_CALC}[data-run="${runA}"]`)
  const b = page.locator(`${THREAD_CALC}[data-run="${runB}"]`)
  assert.match(await a.locator('.uis-name').innerText(), /Price calculator A/)
  assert.match(await b.locator('.uis-name').innerText(), /Price calculator B/)

  const putA = nextStatePut(runA)
  await a.getByLabel('Quantity', { exact: true }).fill('7')
  assert.equal((await putA).status(), 200)
  const putB = nextStatePut(runB)
  await b.getByLabel('Quantity', { exact: true }).fill('9')
  assert.equal((await putB).status(), 200)
  assert.match(await a.locator('.uis-metric-value').innerText(), /^28\s*USD$/)
  assert.match(await b.locator('.uis-metric-value').innerText(), /^36\s*USD$/)
  const owners = (await surfacesOf(sessionId)).filter((s) => s.surface_id === 'calc').map((s) => [s.run_id, s.state.qty]).sort()
  assert.deepEqual(owners, [[runA, 7], [runB, 9]].sort(), 'two owners, each with its own values')

  await reloadInto(sessionId)
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="thread"] [data-testid="ui-surface-calc"]').length === 2, undefined, { timeout: 30_000 })
  assert.equal(await a.getByLabel('Quantity', { exact: true }).inputValue(), '7')
  assert.equal(await b.getByLabel('Quantity', { exact: true }).inputValue(), '9')

  // a press on B's surface goes to B's owner, with B's values; A is untouched
  await page.waitForSelector('[data-testid="thread-composer"]')
  await page.fill('[data-testid="composer"]', '')
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/ui\/[^/]+\/calc\/actions$/.test(r.url()))
  await b.locator('[data-testid="ui-action-explain"]').click()
  const action = await posted
  assert.equal(action.status(), 200)
  assert.ok(action.url().includes(`/api/sessions/${sessionId}/ui/${runB}/calc/actions`), action.url())
  assert.equal(action.request().postDataJSON().state.qty, 9)
  const prompt = String((await action.json()).prompt)
  assert.ok(prompt.includes(`from run ${runB}`) && prompt.includes('Price calculator B') && !prompt.includes(runA), prompt)
  await b.locator('[data-testid="ui-action-drafted"]').waitFor()
  assert.equal(await a.locator('[data-testid="ui-action-drafted"]').count(), 0)
  assert.ok((await composerText()).includes('Explain the price'))
  await page.fill('[data-testid="composer"]', '')
})

test('intelligent ui: a child run\'s surface shows on its card; the replay shows surfaces read-only and sends nothing; live again after', async () => {
  const sessionId = await startUiTask('scripted:ui-a', 'show me the price calculator')
  const thread = page.locator(THREAD_CALC).first()
  await thread.waitFor({ timeout: 30_000 })
  const threadRun = (await thread.getAttribute('data-run'))!
  await page.waitForSelector(`[data-testid="run-${threadRun}"][data-status="done"]`, { timeout: 30_000 })
  // a work order (what a director dispatches) whose child presents the calculator too
  const ordered = await api<{ run_id?: string; run?: { id: string } }>(`/api/sessions/${sessionId}/work-orders`, {
    method: 'POST', body: { work_order: { label: 'UI child', prompt: 'show the price calculator', model: 'scripted:ui-a', tools: ['present_ui'] } },
  })
  assert.equal(ordered.status, 200, JSON.stringify(ordered.body))
  const card = page.locator('[data-testid^="card-run_"]').filter({ has: page.locator('.desk-name', { hasText: /^UI child$/ }) })
  await card.waitFor({ timeout: 20_000 })
  const child = card.locator('[data-testid="ui-surface-calc"]')
  await child.waitFor({ timeout: 20_000 })
  const childRun = (await child.getAttribute('data-run'))!
  assert.notEqual(childRun, threadRun)
  await showTeams(page)
  await page.waitForFunction((id) => document.querySelector(`[data-testid="ol-${id}"]`)?.getAttribute('data-status') === 'done', childRun, { timeout: 20_000 })
  // its values, saved for real
  const put = nextStatePut(childRun)
  await child.getByLabel('Quantity', { exact: true }).fill('8')
  assert.equal((await put).status(), 200)
  const putThread = nextStatePut(threadRun)
  await thread.getByLabel('Quantity', { exact: true }).fill('2')
  assert.equal((await putThread).status(), 200)
  await child.locator('[data-testid="ui-save"][data-state="saved"]').waitFor()
  await thread.locator('[data-testid="ui-save"][data-state="saved"]').waitFor()

  // the replay: the surfaces are there, read-only; nothing a person does there (or a seek) writes or prepares anything
  const requests = watchSurfaceRequests()
  try {
    await page.click('[data-testid="replay"]')
    await page.waitForSelector('[data-testid="replay-bar"]')
    if ((await page.locator('[data-testid="replay-play"]').innerText()) === 'Pause') await page.click('[data-testid="replay-play"]')
    await page.locator('[data-testid="replay-scrub"]').fill('1000')
    await thread.waitFor({ timeout: 10_000 })
    await card.waitFor({ timeout: 10_000 })
    await child.waitFor({ timeout: 10_000 })
    for (const s of [thread, child]) {
      assert.equal(await s.getByLabel('Quantity', { exact: true }).isDisabled(), true)
      assert.equal(await s.locator('[data-testid="ui-action-order"]').isDisabled(), true)
      assert.equal(await s.locator('[data-testid="ui-action-explain"]').isDisabled(), true)
      await s.locator('[data-testid="ui-action-order"]').click({ force: true }).catch(() => undefined)
    }
    await page.locator('[data-testid="replay-scrub"]').fill('0')
    await page.locator('[data-testid="replay-scrub"]').fill('1000')
    await thread.waitFor({ timeout: 10_000 })
    await page.waitForTimeout(800)                               // longer than the save's pause
    assert.deepEqual(requests.seen, [], 'the replay sent no state and prepared no action')
    await page.click('[data-testid="replay-exit"]')
    await page.waitForSelector('[data-testid="composer"]')
  } finally {
    requests.stop()
  }
  // live again: the persisted values, and the surfaces take edits
  await page.waitForFunction(([t, c]) => {
    const q = (run: string) => (document.querySelector(`[data-testid="thread"] [data-testid="ui-surface-calc"][data-run="${run}"] input.uis-input, [data-testid^="card-run_"] [data-testid="ui-surface-calc"][data-run="${run}"] input.uis-input`) as HTMLInputElement | null)
    return q(t)?.value === '2' && !q(t)!.disabled && q(c)?.value === '8' && !q(c)!.disabled
  }, [threadRun, childRun] as const, { timeout: 10_000 })
  const again = nextStatePut(childRun)
  await child.getByLabel('Quantity', { exact: true }).fill('4')
  assert.equal((await again).status(), 200)
  const records = await surfacesOf(sessionId)
  assert.equal(records.find((s) => s.run_id === childRun)!.state.qty, 4)
  assert.equal(records.find((s) => s.run_id === threadRun)!.state.qty, 2)
})

/** A TCP relay to the e2e server that the test can cut: every connection through it is destroyed and new ones are
 *  refused until it is mended — a real network break for the page behind it (Chromium's emulated offline alone
 *  leaves an open event stream flowing). */
async function cuttableRelay(): Promise<{ port: number; cut: () => void; mend: () => void; close: () => Promise<void> }> {
  const open = new Set<Socket>()
  let broken = false
  const relay = createServer((client) => {
    if (broken) { client.destroy(); return }
    const upstream = createConnection({ host: '127.0.0.1', port: PORT })
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

/** The harness's API read from the test process itself (never through the page, which may be offline). */
async function serverGet<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { headers: { 'x-oasis-code-token': info.token } })
  assert.equal(r.status, 200, path)
  return r.json() as Promise<T>
}

test('intelligent ui: reconnect — a surface published while the page is offline comes back over the session\'s reconnected stream, once', async () => {
  // a context of its own: its network goes off and on without touching the page the other tests use
  // the page talks to the server through a relay the test can cut (a real break of its connections), and its context
  // is also put offline meanwhile (the page's own 'online' signal on the way back)
  const shared = page
  const relay = await cuttableRelay()
  const context = await browser.newContext()
  page = await context.newPage()
  page.on('pageerror', (e) => { throw e })
  try {
    // what the browser itself saw: every events request (its after= cursor, a Last-Event-ID header), every SSE message
    // (by CDP, the browser's own record), every read of the session's surfaces
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    const t0 = Date.now()
    const sse: { event: string; id: string; at: number }[] = []
    cdp.on('Network.eventSourceMessageReceived', (m) => sse.push({ event: m.eventName, id: m.eventId, at: Date.now() - t0 }))
    const streams: { url: string; lastEventId: string | null; at: number }[] = []
    const surfaceReads: number[] = []
    const transcriptReads: number[] = []
    page.on('request', (r) => {
      const u = new URL(r.url())
      if (/^\/api\/(runs|sessions)\/[^/]+\/events$/.test(u.pathname)) streams.push({ url: `${u.pathname}${u.search}`, lastEventId: r.headers()['last-event-id'] ?? null, at: Date.now() - t0 })
      if (r.method() === 'GET' && /^\/api\/sessions\/[^/]+\/ui$/.test(u.pathname)) surfaceReads.push(Date.now() - t0)
      if (/^\/api\/runs\/[^/]+\/transcript$/.test(u.pathname)) transcriptReads.push(Date.now() - t0)
    })

    const sessionId = await startUiTask('scripted:ui-a', `show me the price calculator ${UI_HOLD_BEFORE}`, `http://127.0.0.1:${relay.port}`)
    // the page is never loaded again from here: a mark on its window must survive to the end
    await page.evaluate(() => { (window as unknown as { e2eSamePage: boolean }).e2eSamePage = true })
    // the run is live and this page hears it on the session's one stream, never a stream of the run's own (held before present_ui)
    let runId = ''
    for (let i = 0; i < 100 && !runId; i += 1) {
      runId = (await serverGet<{ active_run: { id: string } | null }>(`/api/sessions/${sessionId}`)).active_run?.id ?? ''
      if (!runId) await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(runId, 'a running run')
    await page.waitForFunction((id) => !!document.querySelector(`[data-testid="run-${id}"]`), runId)
    await page.waitForFunction(() => /running/.test(document.querySelector('[data-testid="thread"]')?.textContent ?? ''), undefined, { timeout: 10_000 })
    for (let i = 0; i < 100 && !sse.some((m) => m.id !== ''); i += 1) await new Promise((r) => setTimeout(r, 100))
    assert.ok(streams.some((s) => s.url.startsWith(`/api/sessions/${sessionId}/events?after=`)), `the page streams the session: ${JSON.stringify(streams)}`)
    assert.ok(!streams.some((s) => s.url.startsWith(`/api/runs/${runId}/events`)), `no stream of the run's own: ${JSON.stringify(streams)}`)
    assert.ok(sse.length > 0, 'events came over the stream before the cut')
    assert.equal(await page.locator(THREAD_CALC).count(), 0, 'nothing presented yet')

    // the cut: the page's connections are broken and it is offline; its stream drops and says so
    relay.cut()
    await context.setOffline(true)
    const tOff = Date.now() - t0
    await page.getByText('reconnecting — the run may still be active').waitFor({ timeout: 15_000 })
    const lastBefore = Math.max(...sse.map((m) => Number(m.id)).filter(Number.isFinite))

    // meanwhile, from the test process: the run presents the surface for real and finishes
    await uiRelease('before')
    for (let i = 0; i < 200; i += 1) {
      if ((await serverGet<{ status: string }>(`/api/runs/${runId}`)).status === 'done') break
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.equal((await serverGet<{ status: string }>(`/api/runs/${runId}`)).status, 'done', 'the run finished while the page was offline')
    const stored = (await serverGet<{ surfaces: UiRecordView[] }>(`/api/sessions/${sessionId}/ui`)).surfaces.filter((s) => s.run_id === runId)
    assert.deepEqual(stored.map((s) => [s.surface_id, s.revision]), [['calc', 1]])
    await page.waitForTimeout(1_000)
    assert.equal(await page.locator(THREAD_CALC).count(), 0, 'offline, the page has not seen it')
    assert.ok(!sse.some((m) => m.event === 'ui_surface'), 'no ui_surface reached the page while offline')

    // back online: the session's stream reconnects from its cursor and the surface arrives
    const tOn = Date.now() - t0
    relay.mend()
    await context.setOffline(false)
    const surface = page.locator(`${THREAD_CALC}[data-run="${runId}"]`)
    await surface.waitFor({ timeout: 20_000 })
    const tShown = Date.now() - t0
    assert.equal(await surface.getAttribute('data-revision'), '1')
    assert.match(await surface.locator('.uis-name').innerText(), /Price calculator A/)
    assert.equal(await surface.getByLabel('Quantity', { exact: true }).inputValue(), '3')
    await page.waitForSelector(`[data-testid="run-${runId}"][data-status="done"]`, { timeout: 20_000 })
    // the evidence it was the stream: a request after going online that carries the cursor, and the ui_surface
    // message on it, numbered after the last event seen before the cut
    const resumed = streams.filter((s) => s.at >= tOn && s.url.startsWith(`/api/sessions/${sessionId}/events?after=`))
    assert.ok(resumed.length > 0, `a reconnect with its cursor: ${JSON.stringify(streams)}`)
    const resumedAfter = Number(new URL(resumed[0]!.url, BASE).searchParams.get('after'))
    assert.ok(resumedAfter >= lastBefore, `it resumes after what it had (${resumedAfter} >= ${lastBefore})`)
    const uiMessages = sse.filter((m) => m.event === 'ui_surface')
    assert.equal(uiMessages.length, 1, 'the ui_surface event came over the stream once')
    assert.ok(uiMessages[0]!.at >= tOn && Number(uiMessages[0]!.id) > lastBefore, JSON.stringify(uiMessages))
    assert.ok(sse.some((m) => m.event === 'run_finished' && m.at >= tOn), 'the replay ran to the run\'s end')
    assert.equal(await page.locator(THREAD_CALC).count(), 1, 'one block in the thread')
    console.log('# reconnect evidence', JSON.stringify({
      offline_at_ms: tOff, online_at_ms: tOn, shown_at_ms: tShown, last_event_id_before_cut: lastBefore,
      events_requests: streams, ui_surface_messages: uiMessages, surface_reads_after_online_ms: surfaceReads.filter((t) => t >= tOn), transcript_reads_after_online_ms: transcriptReads.filter((t) => t >= tOn),
    }))

    // a second cut and recovery (the run is over; the session's stream comes back after its cursor and the session's own ticker reads again): still one
    relay.cut()
    await context.setOffline(true)
    await page.waitForTimeout(1_000)
    relay.mend()
    await context.setOffline(false)
    await page.waitForTimeout(4_000)                                // past the session ticker's 3 s
    assert.equal(await page.locator(THREAD_CALC).count(), 1, 'still one block after a second recovery')
    assert.equal(await page.locator(`${THREAD_CALC}[data-run="${runId}"]`).getAttribute('data-revision'), '1')
    assert.equal(sse.filter((m) => m.event === 'ui_surface').length, 1, 'nothing replayed twice')
    assert.equal(await page.evaluate(() => (window as unknown as { e2eSamePage?: boolean }).e2eSamePage), true, 'the page was never reloaded')
  } finally {
    await context.close()
    await relay.close()
    page = shared
  }
})

test("a finished agent's conversation is read once: the tree changing as another agent runs reads it not again, opening the session reads none, and its card taken back reads it once", async () => {
  const sessionId = await startUiTask('scripted:e', 'look around the working folder')
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 30_000 })
  const reads = new Map<string, number>()
  const count = (r: { url: () => string }) => {
    const m = /\/api\/runs\/([^/]+)\/transcript$/.exec(new URL(r.url()).pathname)
    if (m) reads.set(m[1]!, (reads.get(m[1]!) ?? 0) + 1)
  }
  const order = async (label: string) => {
    const ordered = await api<{ id: string }>(`/api/sessions/${sessionId}/work-orders`, {
      method: 'POST', body: { work_order: { label, prompt: `${label}: list the repository files and report how many there are.`, model: 'scripted:c' } },
    })
    assert.equal(ordered.status, 200, JSON.stringify(ordered.body))
    const runId = ordered.body.id
    await showTeams(page)
    await page.waitForFunction((id) => document.querySelector(`[data-testid="ol-${id}"]`)?.getAttribute('data-status') === 'done', runId, { timeout: 20_000 })
    await page.locator('[data-testid^="card-run_"]').filter({ has: page.locator('.desk-name', { hasText: new RegExp(`^${label}$`) }) }).waitFor({ timeout: 10_000 })
    return runId
  }
  const first = await order('First')
  await page.waitForTimeout(800)                                // the read that follows its end has settled
  page.on('request', count)
  try {
    await order('Second')                                       // its start and its end change the tree twice
    await page.waitForTimeout(800)
    assert.equal(reads.get(first) ?? 0, 0, 'the finished agent was not read again as the tree changed')
    reads.clear()
    await reloadInto(sessionId)
    await page.waitForFunction((id) => document.querySelector(`[data-testid="ol-${id}"]`)?.getAttribute('data-status') === 'done', first, { timeout: 10_000 })
    await page.waitForTimeout(800)
    // its card is on the shelf: nothing shows its conversation, so nothing reads it
    assert.equal(reads.get(first) ?? 0, 0, `the finished agent was not read on opening the session: ${JSON.stringify([...reads])}`)
    await page.locator(`[data-testid="ol-${first}"]`).click()
    await page.locator('[data-testid^="card-run_"]').filter({ has: page.locator('.desk-name', { hasText: /^First$/ }) }).waitFor({ timeout: 10_000 })
    await page.waitForTimeout(800)
    assert.equal(reads.get(first), 1, `its card taken back read it once: ${JSON.stringify([...reads])}`)
    for (const [runId, n] of reads) assert.equal(n, 1, `${runId} was read ${n} times`)
  } finally {
    page.off('request', count)
  }
})

test("a session opens with its finished agents' cards on the shelf; one taken back stays out", async () => {
  const sessionId = await startUiTask('scripted:e', 'look around the working folder')
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 30_000 })
  const ordered = await api<{ id: string }>(`/api/sessions/${sessionId}/work-orders`, {
    method: 'POST', body: { work_order: { label: 'Resting', prompt: 'Resting: list the repository files and report how many there are.', model: 'scripted:c' } },
  })
  assert.equal(ordered.status, 200, JSON.stringify(ordered.body))
  await showTeams(page)
  await page.waitForFunction((id) => document.querySelector(`[data-testid="ol-${id}"]`)?.getAttribute('data-status') === 'done', ordered.body.id, { timeout: 20_000 })
  const card = page.locator('[data-testid^="card-run_"]').filter({ has: page.locator('.desk-name', { hasText: /^Resting$/ }) })
  await card.waitFor({ timeout: 10_000 })                          // it ended while the session was open: its card stays
  await page.waitForTimeout(500)
  assert.equal(await card.count(), 1)
  await reloadInto(sessionId)
  await page.waitForSelector('[data-testid="desk-shelf"]', { timeout: 10_000 })
  assert.equal(await card.count(), 0, 'the finished agent is on the shelf')
  await page.waitForSelector('[data-testid="card-workspace"]')
  await page.click('[data-testid="desk-shelf"]')
  await page.click('.desk-tail-list .desk-chip:has-text("Resting")')
  await card.waitFor({ timeout: 5_000 })
  await page.waitForTimeout(800)
  assert.equal(await card.count(), 1, 'taken back, it stays out')
})

test('the agents board stands last in the thread, under a turn sent after the agents; the thread and a card stay at their bottom as what they show grows', async () => {
  // the session of the previous test: the thread's task, an agent beside it (its card taken back)
  const before = await page.locator('[data-testid^="run-run_"]').count()
  await page.fill('[data-testid="composer"]', 'look around once more')
  await page.click('[data-testid="send"]')
  await page.waitForFunction((n) => { const runs = document.querySelectorAll('[data-testid^="run-run_"]'); return runs.length === n + 1 && runs[n]!.getAttribute('data-status') === 'done' }, before, { timeout: 30_000 })
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="thread"]')!.lastElementChild?.getAttribute('data-testid')), 'agents-board')
  // words streaming into the last entry add no entry: the scroller follows its growing height
  for (const scroller of ['[data-testid="thread"]', '.desk-win.front [data-testid^="agent-view-"]']) {
    await page.evaluate((sel) => { const el = document.querySelector(sel)!; el.scrollTop = el.scrollHeight }, scroller)
    await page.waitForTimeout(100)
    await page.evaluate((sel) => { const grown = document.createElement('div'); grown.style.height = '900px'; document.querySelector(sel)!.lastElementChild!.appendChild(grown) }, scroller)
    await page.waitForFunction((sel) => { const el = document.querySelector(sel)!; return el.scrollHeight - el.scrollTop - el.clientHeight < 2 }, scroller, { timeout: 3_000 })
    // following, the browser's scroll anchoring is off (a turn folding above would scroll it up); scrolled away, on
    const anchor = (sel: string) => page.evaluate((s) => getComputedStyle(document.querySelector(s)!).overflowAnchor, sel)
    assert.equal(await anchor(scroller), 'none', `${scroller} follows with anchoring off`)
    await page.evaluate((sel) => { const el = document.querySelector(sel)!; el.scrollTop = 0 }, scroller)
    await page.waitForFunction((sel) => getComputedStyle(document.querySelector(sel)!).overflowAnchor === 'auto', scroller, { timeout: 3_000 })
    await page.evaluate((sel) => { const el = document.querySelector(sel)!; el.scrollTop = el.scrollHeight }, scroller)
    await page.waitForFunction((sel) => getComputedStyle(document.querySelector(sel)!).overflowAnchor === 'none', scroller, { timeout: 3_000 })
  }
})

test('multi-format attachments: chooser/drop/paste, retry with order, attachment-only send, native gate and safe download', async () => {
  await page.click('[data-testid="new-task"]')
  await page.waitForSelector('[data-testid="hero-composer"]')
  await bypassDirector(page)
  await pickRepoFolder()
  await pickModel('scripted:e')
  await page.setInputFiles('[data-testid="attach-input"]', { name: 'chosen.md', mimeType: 'text/markdown', buffer: Buffer.from('# chosen content') })
  await page.evaluate(() => {
    const drop = new DataTransfer(); drop.items.add(new File(['x,y\n1,2'], 'dropped.csv', { type: 'text/csv' }))
    document.querySelector('[data-testid="hero-composer"]')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: drop }))
    const paste = new DataTransfer(); paste.items.add(new File(['SELECT 42;'], 'pasted.sql', { type: 'application/sql' }))
    document.querySelector('[data-testid="composer"]')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: paste }))
  })
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer-image"].is-ready').length === 3)
  assert.deepEqual(await page.locator('.attachment-caption').evaluateAll((nodes) => nodes.map((n) => n.firstChild?.textContent)), ['chosen.md', 'dropped.csv', 'pasted.sql'])
  let failed = false
  const uploads: string[] = []
  await page.route((url) => url.pathname.endsWith('/attachments'), async (route) => {
    const name = new URL(route.request().url()).searchParams.get('name') ?? ''
    uploads.push(name)
    if (!failed && name === 'dropped.csv') { failed = true; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'synthetic upload failure' }) }); return }
    await route.continue()
  })
  await page.click('[data-testid="send"]') // no words: files alone are a message
  await page.waitForSelector('[data-testid="composer-image"].is-failed')
  assert.equal(await page.locator('[data-testid="composer-image"]').count(), 3)
  await page.getByRole('button', { name: 'Retry file', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer-image"].is-ready').length === 3)
  await page.click('[data-testid="send"]')
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 30_000 })
  assert.deepEqual(uploads, ['chosen.md', 'dropped.csv', 'dropped.csv', 'pasted.sql'])
  assert.match(await page.locator('[data-testid^="run-run_"]').last().innerText(), /chosen.md text\/plain with content; dropped.csv text\/plain with content; pasted.sql text\/plain with content/)
  assert.equal(await page.locator('[data-testid="composer-image"]').count(), 0)
  await page.unrouteAll({ behavior: 'wait' })
  // a route that does not take a PDF itself is still sent it: the run gets it as a file of its own folder
  await pickModel('scripted:d')
  await page.setInputFiles('[data-testid="attach-input"]', { name: 'proof.pdf', mimeType: 'application/pdf', buffer: pdfFixture() })
  await page.fill('[data-testid="composer"]', 'keep this draft')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer-image"].is-ready').length === 1)
  assert.equal(await page.locator('[data-testid="images-unsupported"]').count(), 0)
  assert.equal(await page.locator('[data-testid="send"]').isDisabled(), false)
  assert.equal(await composerText(), 'keep this draft')
  await pickModel('scripted:e')
  await page.setInputFiles('[data-testid="attach-input"]', { name: 'clip.mp4', mimeType: 'video/mp4', buffer: mp4Fixture() })
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer-image"].is-ready').length === 2)
  await page.click('[data-testid="send"]')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="run-run_"][data-status="done"]').length === 2, undefined, { timeout: 30_000 })
  const last = page.locator('[data-testid^="run-run_"]').last()
  assert.match(await last.innerText(), /proof.pdf application\/pdf with content; clip.mp4 video\/mp4 with content/)
  const href = await last.locator('.attachment-card').first().getAttribute('href')
  const response = await page.request.get(BASE + href)
  assert.match(response.headers()['content-disposition'] ?? '', /^attachment;/)
  assert.match(response.headers()['content-security-policy'] ?? '', /sandbox/)
})

test('a long paste joins the message as a text file card, the words typed after it stay words; a short paste is words', async () => {
  const sessionId = await startUiTask('scripted:e', 'look around the working folder')
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 30_000 })
  await bypassDirector(page)
  const paste = (text: string) => page.locator('[data-testid="composer"]').evaluate((el, t) => {
    const data = new DataTransfer()
    data.setData('text/plain', t)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)
  await page.click('[data-testid="composer"]')
  const long = '实验 f88egw：判别器谱归一化，第 3000 步梯度范数爆炸。\n'.repeat(200)
  await paste(long)
  await page.waitForSelector('[data-testid="composer-image"]')
  assert.equal(await page.locator('[data-testid="composer-image"]').count(), 1)
  assert.match(await page.locator('[data-testid="composer-image"]').innerText(), /pasted-text-1\.txt[\s\S]*text\/plain/)
  assert.equal(await composerText(), '')                                    // none of it lands in the box
  await paste('short note')
  assert.equal(await composerText(), 'short note')
  assert.equal(await page.locator('[data-testid="composer-image"]').count(), 1)
  await page.keyboard.type(' — battle this')
  const done = await page.locator('[data-testid^="run-run_"][data-status="done"]').count()
  await page.click('[data-testid="send"]')
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="run-run_"][data-status="done"]').length === n + 1, done, { timeout: 30_000 })
  assert.equal(await page.locator('[data-testid="composer-image"]').count(), 0)
  const runId = (await page.locator('[data-testid^="run-run_"]').last().getAttribute('data-testid'))!.slice(4)
  const detail = (await api<{ user_text: string; attachments: { name: string; bytes: number; file_kind?: string }[] }>(`/api/runs/${runId}`)).body
  assert.equal(detail.user_text, 'short note — battle this')
  assert.deepEqual(detail.attachments.map((a) => [a.name, a.file_kind, a.bytes]), [['pasted-text-1.txt', 'text', Buffer.byteLength(long)]])
  assert.ok(sessionId)
})

test("a session's words go to the agent until the director is called in; the choice stays with the session across reloads", async () => {
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]')
  assert.equal(await page.locator('[data-testid="director-chip"]').count(), 0)                 // no director by default
  await page.click('[data-testid="hero-composer"] [data-testid="restore-director"]')
  await page.waitForSelector('[data-testid="hero-composer"] [data-testid="director-chip"]')
  if (await page.locator('[data-testid="folder-clear"]').count()) await page.click('[data-testid="folder-clear"]')
  await page.fill('[data-testid="composer"]', 'hello director')
  const routed = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/director/messages'))
  await page.click('[data-testid="send"]')
  assert.ok((await routed).ok())
  await page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
  const sessionId = await currentSession()
  await page.reload()
  await page.click(`[data-testid="session-${sessionId}"]`)
  await page.waitForSelector('[data-testid="thread-composer"] [data-testid="director-chip"]')     // kept across the reload
  await page.click('[data-testid="director-chip-remove"]')
  await page.waitForSelector('[data-testid="thread-composer"] [data-testid="restore-director"]')
  await page.reload()
  await page.click(`[data-testid="session-${sessionId}"]`)
  await page.waitForSelector('[data-testid="thread-composer"] [data-testid="restore-director"]')
  assert.equal(await page.locator('[data-testid="director-chip"]').count(), 0)                 // and the × too
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]')
  assert.equal(await page.locator('[data-testid="director-chip"]').count(), 0)                 // a new task starts on the agent again
})

test("the director's model is the person's pick: it opens on it with the first words, and a later pick changes it", async () => {
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]')
  const project = (await api<{ id: string }>('/api/projects', { method: 'POST', body: { no_folder: true } })).body
  const sid = (await api<{ id: string }>(`/api/projects/${project.id}/sessions`, { method: 'POST', body: { model: 'scripted:a', title: 'director model' } })).body.id
  await page.reload()
  await page.click(`[data-testid="session-${sid}"]`)
  await page.waitForSelector('[data-testid="thread-composer"]')
  await page.click('[data-testid="thread-composer"] [data-testid="restore-director"]')
  await page.waitForSelector('[data-testid="thread-composer"] [data-testid="director-chip"]')
  assert.equal(await page.locator('[data-testid="model-picker"]').count(), 0)                     // the agent's picker steps aside
  const picker = page.locator('[data-testid="director-model-picker"]')
  assert.match(await picker.innerText(), /Scripted A/)                                              // nothing picked: the session's model
  await picker.click()
  await page.click('[data-testid="model-option-scripted:dir"]')
  assert.match(await picker.innerText(), /Scripted Director/)
  await page.fill('[data-testid="composer"]', 'hello')
  const said = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/director/messages'))
  await page.click('[data-testid="send"]')
  assert.ok((await said).ok())
  const opened = (await api<{ director: { model: string } | null }>(`/api/sessions/${sid}/director`)).body
  assert.equal(opened.director?.model, 'scripted:dir')
  await page.waitForFunction(() => /Scripted Director/.test(document.querySelector('[data-testid="director-model-picker"]')?.textContent ?? ''))
  await picker.click()
  await page.click('[data-testid="model-option-scripted:b"]')
  await page.waitForFunction(async (id) => {
    const r = await fetch(`/api/sessions/${id}/director`, { headers: { 'x-oasis-code-token': localStorage.getItem('oasis-code.token') ?? '' } })
    return (await r.json()).director?.model === 'scripted:b'
  }, sid, { timeout: 10_000 })
})

/** In-run steering (backend-ts/scripts/e2e_server.ts, route scripted:steer): the run is held at its gate and let go. */
async function steerRelease() {
  for (let i = 0; i < 100; i += 1) {
    const r = await fetch(`${BASE}/e2e/ui-release?gate=steer`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` } })
    if (((await r.json()) as { released: boolean }).released) return
    await new Promise((res) => setTimeout(res, 100))
  }
  throw new Error('the steer run never reached its gate')
}
/** Until the steer run's model request has entered and waits at its gate: words sent from then on go into a later
 *  request (words sent before the first request reaches the model join that first request — the harness's rule). */
async function steerHeld(): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    const r = await fetch(`${BASE}/e2e/ui-gate?gate=steer`, { headers: { authorization: `Bearer ${info.token}` } })
    if (((await r.json()) as { held: boolean }).held) return
    await new Promise((res) => setTimeout(res, 100))
  }
  throw new Error('the steer run never reached its gate')
}
/** Until the run's command is running (its first answer, the command, is in: the next request comes after its result). */
async function commandRunning(runId: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    const r = await fetch(`${BASE}/api/runs/${runId}`, { headers: { 'x-oasis-code-token': info.token } })
    const executions = ((await r.json()) as { executions?: { status: string }[] }).executions ?? []
    if (executions.some((x) => x.status === 'running')) return
    await new Promise((res) => setTimeout(res, 100))
  }
  throw new Error(`run ${runId} never started its command`)
}
const STEER_ROW = '[data-steer-id]'
/** The words in the composer, by the keyboard: two spaces before and after, a blank line between — sent as they stand. */
async function typeSteer(first: string, second: string) {
  await page.click('[data-testid="composer"]')
  await page.keyboard.type(`  ${first}  `)
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type(`  ${second}  `)
}
/** The run on the page that is live now (its section). */
async function liveRunId(): Promise<string> {
  await page.waitForSelector('[data-testid^="run-run_"][data-status="running"]', { timeout: 30_000 })
  return (await page.locator('[data-testid^="run-run_"][data-status="running"]').last().getAttribute('data-testid'))!.slice('run-'.length)
}
/** Whether the steer stands before the agent's words that carry `words`, in the run's section. */
async function steerBefore(runId: string, steerId: string, words: string): Promise<boolean> {
  return page.evaluate(([run, id, text]) => {
    const section = document.querySelector(`[data-testid="run-${run}"]`)
    const row = section?.querySelector(`[data-steer-id="${id}"]`)
    const answer = [...(section?.querySelectorAll('.turn-agent') ?? [])].find((el) => (el.textContent ?? '').includes(text!))
    return !!row && !!answer && !!(row.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING)
  }, [runId, steerId, words] as const)
}
/** Whether `a` stands before `b` on the page. */
async function standsBefore(a: string, b: string): Promise<boolean> {
  return page.evaluate(([x, y]) => {
    const ea = document.querySelector(x!), eb = document.querySelector(y!)
    return !!ea && !!eb && !!(ea.compareDocumentPosition(eb) & Node.DOCUMENT_POSITION_FOLLOWING)
  }, [a, b] as const)
}

test('in-run steering: words sent while the run works go into its next request, as written; stop leaves them undelivered; a run that ended keeps the draft', async () => {
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero-composer"]')
  if (await page.locator('[data-testid="folder-clear"]').count()) await page.click('[data-testid="folder-clear"]')
  await pickModel('scripted:steer')
  await page.fill('[data-testid="composer"]', 'STEER_CASE_TOOL run one command')
  await page.click('[data-testid="send"]')
  await page.waitForSelector('[data-testid="thread-composer"]', { timeout: 30_000 })
  const sessionId = await currentSession()
  const runA = await liveRunId()

  // 1. the run is held in its first request: the composer takes words for it — one button: Stop while it is empty,
  // Send once it holds words; nothing blocked
  await page.waitForSelector(`[data-testid="thread-composer"] [data-testid="stop"][data-steer-run="${runA}"]`)
  assert.equal(await page.locator('[data-testid="thread-composer"] [data-testid="send"]').count(), 0)
  await steerHeld()
  await typeSteer('use the staging   database', 'and @ keep this line')
  await page.waitForSelector(`[data-testid="thread-composer"] [data-testid="send"][data-steer-run="${runA}"]`)
  assert.equal(await page.locator('[data-testid="thread-composer"] [data-testid="stop"]').count(), 0)
  const draft = await composerText()
  const posted = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/runs/${runA}/steer`))
  await page.keyboard.press('Enter')
  const body = (await posted).postDataJSON() as { text: string; client_request_id: string }
  assert.deepEqual(Object.keys(body).sort(), ['client_request_id', 'text'])
  const sent = body.text
  assert.ok(sent.startsWith('  use the staging   database'), JSON.stringify(sent))      // never trimmed
  assert.ok(sent.endsWith('and @ keep this line  '), JSON.stringify(sent))
  assert.match(sent, /\n/)
  assert.equal(sent.replace(/\n/g, ''), draft.replace(/\n/g, ''))
  // queued at the run's tail, grey, the words exactly; the composer is empty again
  const row = page.locator(`[data-testid="run-${runA}"] ${STEER_ROW}`)
  await row.and(page.locator('[data-status="queued"]')).waitFor()
  const steerId = (await row.getAttribute('data-steer-id'))!
  assert.equal(await row.locator('[data-testid="steer-text"]').evaluate((el) => el.textContent), sent)
  assert.equal(await composerText(), '')
  // the run goes on: its command runs, then the words go into its next request — after the result, before the answer
  await steerRelease()
  await page.waitForSelector(`[data-steer-id="${steerId}"][data-status="delivered"]`, { timeout: 30_000 })
  const echo = `STEER_ECHO ${encodeURIComponent(sent)}`
  const answer = page.locator(`[data-testid="run-${runA}"] .turn-agent`).filter({ hasText: echo })
  await answer.waitFor({ timeout: 30_000 })
  await page.waitForSelector(`[data-testid="run-${runA}"][data-status="done"]`, { timeout: 30_000 })
  assert.ok(await standsBefore(`[data-testid="run-${runA}"] .work`, `[data-steer-id="${steerId}"]`), 'after the command')
  assert.ok(await steerBefore(runA, steerId, echo), 'before the answer')
  assert.equal(await threadRunCount(sessionId), 1, 'the same run: none started for the words')

  // 2. a reload reads the finished run again: the steer where it stood, delivered, the words exactly
  await page.reload()
  await page.click(`[data-testid="session-${sessionId}"]`)
  await page.waitForSelector(`[data-steer-id="${steerId}"][data-status="delivered"]`, { timeout: 30_000 })
  assert.equal(await page.locator(`[data-testid="thread"] [data-steer-id="${steerId}"] [data-testid="steer-text"]`).evaluate((el) => el.textContent), sent)
  await page.locator(`[data-testid="run-${runA}"] .turn-agent`).filter({ hasText: echo }).waitFor({ timeout: 30_000 })
  assert.ok(await steerBefore(runA, steerId, echo))
  assert.equal(await page.locator(`[data-testid="run-${runA}"] .turn-user .turn-text`).filter({ hasText: 'Continue.' }).count(), 0)

  // 3. words while the model writes a plain answer (no tool): the run asks once more with them, in the same run
  await page.fill('[data-testid="composer"]', 'STEER_CASE_TEXT answer in words')
  await page.keyboard.press('Enter')
  const runB = await liveRunId()
  await page.waitForSelector(`[data-testid="thread-composer"] [data-testid="stop"][data-steer-run="${runB}"]`)
  await steerHeld()                                       // the model writes its answer now: the words come after it
  await page.click('[data-testid="composer"]')
  await page.keyboard.type('one more thing')
  await page.keyboard.press('Enter')
  const rowB = page.locator(`[data-testid="run-${runB}"] ${STEER_ROW}`)
  await rowB.waitFor()
  await steerRelease()
  await page.waitForSelector(`[data-testid="run-${runB}"] ${STEER_ROW}[data-status="delivered"]`, { timeout: 30_000 })
  await page.locator(`[data-testid="run-${runB}"] .turn-agent`).filter({ hasText: `STEER_ECHO ${encodeURIComponent('one more thing')}` }).waitFor({ timeout: 30_000 })
  assert.ok(await standsBefore(`[data-testid="run-${runB}"] .turn-agent`, `[data-testid="run-${runB}"] ${STEER_ROW}`), 'after the first answer')
  assert.equal(await threadRunCount(sessionId), 2)
  await page.waitForSelector(`[data-testid="run-${runB}"][data-status="done"]`, { timeout: 30_000 })

  // 4. words queued under a long command, a reload while they wait (still queued), then Stop: never delivered, never
  //    carried to a next run; put back in the composer as they were
  await page.fill('[data-testid="composer"]', 'STEER_CASE_STOP a long command')
  await page.keyboard.press('Enter')
  const runC = await liveRunId()
  await page.waitForSelector(`[data-testid="thread-composer"] [data-testid="stop"][data-steer-run="${runC}"]`)
  await commandRunning(runC)                              // queued under the command, not into the first request
  await page.click('[data-testid="composer"]')
  await page.keyboard.type('  wait for me  ')
  await page.keyboard.press('Enter')
  await page.waitForSelector(`[data-testid="run-${runC}"] ${STEER_ROW}[data-status="queued"]`)
  await page.reload()
  await page.click(`[data-testid="session-${sessionId}"]`)
  await page.waitForSelector(`[data-testid="run-${runC}"] ${STEER_ROW}[data-status="queued"]`, { timeout: 30_000 })
  await page.click('[data-testid="thread-composer"] [data-testid="stop"]')
  const undelivered = page.locator(`[data-testid="run-${runC}"] ${STEER_ROW}[data-status="undelivered"]`)
  await undelivered.waitFor({ timeout: 30_000 })
  assert.match(await undelivered.locator('[data-testid="steer-state"]').innerText(), /not delivered/)
  await page.waitForSelector(`[data-testid="run-${runC}"]:not([data-status="running"])`, { timeout: 30_000 })
  assert.equal(await threadRunCount(sessionId), 3, 'nothing carried the words into a next run')
  // the row stands under the floating outline and composer at the thread's foot: the click goes to the button itself
  await undelivered.locator('[data-testid="steer-put-back"]').dispatchEvent('click')
  assert.equal(await composerText(), '  wait for me  ')

  // 5. a run that ends before the words arrive: the harness's 409, the draft kept, no run started for it
  await page.fill('[data-testid="composer"]', 'STEER_CASE_RACE end first')
  await page.keyboard.press('Enter')
  const runD = await liveRunId()
  await page.waitForSelector(`[data-testid="thread-composer"] [data-testid="stop"][data-steer-run="${runD}"]`)
  await steerHeld()
  await page.route(`**/api/runs/${runD}/steer`, async (route) => {
    await steerRelease()
    for (let i = 0; i < 200; i += 1) {
      const r = await fetch(`${BASE}/api/runs/${runD}`, { headers: { 'x-oasis-code-token': info.token } })
      if (!['queued', 'running'].includes(((await r.json()) as { status: string }).status)) break
      await new Promise((res) => setTimeout(res, 100))
    }
    await route.continue()
  })
  await page.click('[data-testid="composer"]')
  await page.keyboard.type('too late')
  const refused = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/runs/${runD}/steer`))
  await page.keyboard.press('Enter')
  const answered = await refused
  assert.equal(answered.status(), 409)
  assert.ok(['run_not_live', 'run_finishing'].includes(((await answered.json()) as { code: string }).code))
  await page.waitForSelector('.toast', { timeout: 10_000 })
  assert.match(await page.locator('.toast').last().innerText(), /ended before your words could join it/)
  assert.equal(await composerText(), 'too late')
  await page.unroute(`**/api/runs/${runD}/steer`)
  await new Promise((res) => setTimeout(res, 500))
  assert.equal(await threadRunCount(sessionId), 4, 'no run started on its own for the words')
  await page.fill('[data-testid="composer"]', '')
})

test('routed simulations: delayed cleanup cannot strand the next page’s ordinary requests', { timeout: 10_000 }, async () => {
  await verifyRoutedSimulationIsolation(browser)
})

// ---- large PDFs and videos: by reference (docs/large-file-attachments-ui.md) --------------------------------------
// UI SIMULATIONS, NOT END-TO-END TESTS OF THE BACKEND. The harness's reference endpoints (POST …/attachments/local
// from the desktop shell, the chunked …/uploads) are answered here by stand-ins in the page's own routes, and the
// real scripted backend is handed the message WITHOUT the references the stand-ins made (they are then shown on the
// run as the harness would show them). So these two verify the page — the composer, the chunking, the cancel, the
// cards, the bridge's use — and nothing of the backend's handling of a reference; the main flow against the real
// endpoints is a separate test that comes with the backend. Every route, listener, patch and bridge these install is
// taken away with their isolated page when they end, pass or fail. Interception stays installed for that page's life.

const MiB = 1024 * 1024

/** A reference as the harness answers it. */
function refOf(name: string, origin: 'local' | 'upload', bytes: number, location: string) {
  return { asset_id: `a_ref_${name.replace(/\W/g, '_')}`, name, media_type: name.endsWith('.pdf') ? 'application/pdf' : name.endsWith('.mov') ? 'video/quicktime' : name.endsWith('.webm') ? 'video/webm' : 'video/mp4',
    bytes, file_kind: name.endsWith('.pdf') ? 'pdf' : 'video', representation: 'ref-v1', origin, location, sha256: origin === 'local' ? null : 'c'.repeat(64) }
}

/** The session's chunked uploads, answered in the page's routes: what was opened, each PUT (offset, bytes), the
 *  status asks, completions and drops; `failOnce` answers one PUT at that offset 503, `slow` holds each PUT a while. */
async function standInUploads(sessionId: string, opts: { chunk: number; failOnce?: number; slow?: number }, made: Map<string, Record<string, unknown>>) {
  const seen = { opened: [] as Record<string, unknown>[], puts: [] as { offset: number; bytes: number }[], status: 0, completed: [] as string[], dropped: [] as string[] }
  const held = new Map<string, { name: string; size: number; received: number }>()
  let failed = false
  await page.route((url) => url.pathname.startsWith(`/api/sessions/${sessionId}/uploads`), async (route) => {
    const req = route.request()
    const rest = new URL(req.url()).pathname.slice(`/api/sessions/${sessionId}/uploads`.length)
    const id = decodeURIComponent(rest.split('/')[1] ?? '')
    try {
      if (req.method() === 'POST' && rest === '') {
        const body = req.postDataJSON() as { name: string; size: number; type: string }
        seen.opened.push(body)
        const uploadId = `u_${seen.opened.length}`
        held.set(uploadId, { name: body.name, size: body.size, received: 0 })
        await route.fulfill({ json: { upload_id: uploadId, chunk_bytes: opts.chunk, received: 0 } }); return
      }
      const upload = held.get(id)
      if (!upload) { await route.fulfill({ status: 404, json: { detail: 'no such upload' } }); return }
      if (req.method() === 'PUT') {
        const offset = Number(new URL(req.url()).searchParams.get('offset'))
        // the chunk's bytes as the page sent them; where the browser does not hand a file-backed body to the route,
        // what the slice at that offset must be (the slicing itself is unit-tested: tests/chunkedUpload.test.ts)
        const body = req.postDataBuffer()
        const bytes = body ? body.length : Math.min(opts.chunk, upload.size - offset)
        if (opts.slow) await new Promise((r) => setTimeout(r, opts.slow))
        seen.puts.push({ offset, bytes })
        if (opts.failOnce === offset && !failed) { failed = true; await route.fulfill({ status: 503, json: { detail: 'synthetic chunk failure' } }); return }
        if (offset !== upload.received) { await route.fulfill({ status: 409, json: { detail: `offset ${offset} is not ${upload.received}` } }); return }
        upload.received += bytes
        await route.fulfill({ json: { received: upload.received } }); return
      }
      if (req.method() === 'GET') { seen.status += 1; await route.fulfill({ json: { upload_id: id, received: upload.received, size: upload.size } }); return }
      if (req.method() === 'POST' && rest.endsWith('/complete')) {
        seen.completed.push(upload.name)
        const ref = refOf(upload.name, 'upload', upload.received, `/e2e-stand-in/data/assets/p_e2e/ref/a_ref_${upload.name.replace(/\W/g, '_')}`)
        made.set(ref.asset_id, ref)
        await route.fulfill({ json: ref }); return
      }
      if (req.method() === 'DELETE') { seen.dropped.push(upload.name); held.delete(id); await route.fulfill({ json: { deleted: true } }); return }
      await route.fulfill({ status: 405, json: { detail: 'not here' } })
    } catch { /* the page dropped the request (a cancel) */ }
  })
  return seen
}

/** The message as the scripted backend can take it: the references the stand-ins made are taken out of what is sent
 *  and shown on the run as the harness would show them — on the answer, the run and the session read back. They are
 *  known by the run's words, set before the message goes, so no read of the run (the answer, a refresh, a reload)
 *  can come before them. Each test sends distinct words. */
async function carryReferences(sessionId: string, made: () => Map<string, Record<string, unknown>>) {
  const bodies: { text?: string; attachments?: string[] }[] = []
  const shown = new Map<string, Record<string, unknown>[]>()
  const show = (run: Record<string, unknown> | null | undefined) => {
    const refs = run && typeof run.user_text === 'string' ? shown.get(run.user_text) : undefined
    if (!run || !refs) return
    const have = new Set(((run.attachments as { asset_id?: string }[] | undefined) ?? []).map((a) => a.asset_id))
    run.attachments = [...((run.attachments as unknown[]) ?? []), ...refs.filter((r) => !have.has(r.asset_id as string))]
  }
  await page.route((url) => url.pathname === `/api/sessions/${sessionId}/chat`, async (route) => {
    const sent = route.request().postDataJSON() as { text?: string; attachments?: string[] }
    bodies.push(sent)
    const refs = (sent.attachments ?? []).filter((id) => made().has(id))
    if (refs.length) shown.set(sent.text ?? '', refs.map((id) => made().get(id)!))
    const response = await route.fetch({ postData: JSON.stringify({ ...sent, attachments: (sent.attachments ?? []).filter((id) => !made().has(id)) }) })
    const run = await response.json().catch(() => null) as Record<string, unknown> | null
    show(run)
    await route.fulfill({ response, json: run })
  })
  await page.route((url) => url.pathname === `/api/sessions/${sessionId}` || /^\/api\/runs\/[^/]+$/.test(url.pathname), async (route) => {
    if (route.request().method() !== 'GET') { await route.fallback(); return }
    const response = await route.fetch()
    const body = await response.json().catch(() => null) as Record<string, unknown> | null
    if (body) { show(body); for (const run of (body.runs as Record<string, unknown>[] | undefined) ?? []) show(run) }
    await route.fulfill({ response, json: body })
  })
  return bodies
}

/** Counts every read of a whole Blob larger than a file head (arrayBuffer, text, stream, bytes, FileReader); `restore`
 *  puts the page's own methods back. */
async function watchWholeReads() {
  await page.evaluate(() => {
    const w = window as unknown as { __wholeReads: string[]; __wholeReadsRestore?: () => void }
    w.__wholeReads = []
    const originals: [object, string, unknown][] = []
    const watch = (proto: object, names: string[], sizeOf: (self: unknown, args: unknown[]) => number) => {
      for (const name of names) {
        const original = (proto as Record<string, unknown>)[name] as ((...a: unknown[]) => unknown) | undefined
        if (!original) continue
        originals.push([proto, name, original])
        ;(proto as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
          if (sizeOf(this, args) > 1024) w.__wholeReads.push(`${name} ${sizeOf(this, args)}`)
          return original.apply(this, args)
        }
      }
    }
    watch(Blob.prototype, ['arrayBuffer', 'text', 'stream', 'bytes'], (self) => (self as Blob).size)
    watch(FileReader.prototype, ['readAsArrayBuffer', 'readAsText', 'readAsDataURL', 'readAsBinaryString'], (_self, args) => (args[0] as Blob | undefined)?.size ?? 0)
    w.__wholeReadsRestore = () => { for (const [proto, name, original] of originals) (proto as Record<string, unknown>)[name] = original; delete (w as { __wholeReads?: unknown }).__wholeReads }
  })
  return {
    reads: () => page.evaluate(() => (window as unknown as { __wholeReads: string[] }).__wholeReads),
    restore: () => page.evaluate(() => { const w = window as unknown as { __wholeReadsRestore?: () => void }; w.__wholeReadsRestore?.(); delete w.__wholeReadsRestore }).catch(() => undefined),
  }
}

/** The desktop shell's attach as a stand-in answers it (null: none installed — a call is refused). Playwright cannot
 *  take an exposed function back, so the page's binding is exposed once and delegates here; a test sets this and
 *  clears it when it ends. */
let shellStandIn: ((session: string, name: string, size: number) => unknown) | null = null
let shellStandInPage: Page | null = null
async function exposeShellStandIn() {
  if (shellStandInPage === page) return
  await page.exposeFunction('e2eAttachLocalFile', (session: string, name: string, size: number) => {
    if (!shellStandIn) throw new Error('no stand-in shell is installed')
    return shellStandIn(session, name, size)
  })
  shellStandInPage = page
}

const uploadRequests = () => {
  const posts: string[] = []
  const on = (r: { method: () => string; url: () => string }) => { if (r.method() === 'POST' && /\/attachments$/.test(new URL(r.url()).pathname)) posts.push(new URL(r.url()).searchParams.get('name') ?? '') }
  page.on('request', on)
  return { posts, stop: () => page.off('request', on) }
}

test('[UI simulation: upload endpoints stood in, references kept from the backend] a browser uploads a PDF or a video in chunks, slices of the File, never read whole: resumed after a failure, cancelled on ask; an image goes as before', async (t) => {
  const shared = page
  const simulation = await openRoutedSimulation(browser)
  page = simulation.page
  page.on('pageerror', (e) => { throw e })
  t.after(async () => { try { await simulation.close() } finally { page = shared } })
  const sessionId = await startUiTask('scripted:e', 'look around the working folder')
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 30_000 })
  await bypassDirector(page)
  const dir = mkdtempSync(join(process.env.OASIS_CODE_E2E_TMP ?? tmpdir(), 'oasis-e2e-large-'))
  let posted: ReturnType<typeof uploadRequests> | null = null
  let watched: Awaited<ReturnType<typeof watchWholeReads>> | null = null
  try {
    const film = join(dir, 'field-trip.mp4')
    writeFileSync(film, Buffer.alloc(9 * MiB + 5, 7))                       // a file on disk: the page gets a File of it
    const made = new Map<string, Record<string, unknown>>()
    const uploadOptions = { chunk: 4 * MiB, failOnce: 4 * MiB, slow: 0 }
    const uploads = await standInUploads(sessionId, uploadOptions, made)
    const bodies = await carryReferences(sessionId, () => made)
    watched = await watchWholeReads()
    const wholeReads = watched.reads
    posted = uploadRequests()
    await page.setInputFiles('[data-testid="attach-input"]', [`${process.cwd()}/../backend-ts/tests/fixtures/images/red-7x5.png`, film])
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer-image"].is-ready').length === 2)
    await page.fill('[data-testid="composer"]', 'what happens in this clip?')
    const done = await page.locator('[data-testid^="run-run_"][data-status="done"]').count()
    await page.click('[data-testid="send"]')
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="run-run_"][data-status="done"]').length === n + 1, done, { timeout: 30_000 })
    // the chunks: each at the offset the harness held, none larger than its chunk size; the failed one sent again
    // after the harness was asked where it got — the whole file, once
    assert.deepEqual(uploads.opened, [{ name: 'field-trip.mp4', size: 9 * MiB + 5, type: 'video/mp4' }])
    assert.deepEqual(uploads.puts.map((p) => p.offset), [0, 4 * MiB, 4 * MiB, 8 * MiB])
    assert.ok(uploads.puts.every((p) => p.bytes <= 4 * MiB))
    assert.equal(uploads.puts.filter((_p, i) => i !== 1).reduce((s, p) => s + p.bytes, 0), 9 * MiB + 5)
    assert.equal(uploads.status, 1)
    assert.deepEqual(uploads.completed, ['field-trip.mp4'])
    assert.deepEqual(await wholeReads(), [])                                  // the page never read the file whole
    // the image went by the one-request upload, as before; the message names both, in the composer's order
    assert.deepEqual(posted.posts, ['red-7x5.png'])
    assert.equal(bodies.at(-1)!.attachments!.length, 2)
    assert.equal(bodies.at(-1)!.attachments![1], 'a_ref_field_trip_mp4')
    assert.match(await page.locator('[data-testid^="run-run_"]').last().innerText(), /I was handed 1 image\(s\): red-7x5\.png/)
    // the uploaded reference is the harness's to serve: a download card
    const card = page.locator('[data-testid^="run-run_"]').last().locator('a.attachment-card')
    assert.equal(await card.getAttribute('href'), `/api/sessions/${sessionId}/attachments/a_ref_field_trip_mp4`)
    assert.match(await card.innerText(), /field-trip\.mp4[\s\S]*video\/mp4 · 9\.0 MiB · download/)
    assert.equal(await page.locator('[data-testid="composer-image"]').count(), 0)
    // Cancel while a chunk is on its way: the harness is asked to drop the upload, the send fails, the words stay
    // Keep interception installed while requests are in flight; only the stand-in's behavior changes.
    uploadOptions.chunk = 2 * MiB
    uploadOptions.slow = 1500
    const completedBeforeCancel = [...uploads.completed]
    const scan = join(dir, 'scan.pdf')
    writeFileSync(scan, Buffer.alloc(6 * MiB, 1))
    await page.setInputFiles('[data-testid="attach-input"]', scan)
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer-image"].is-ready').length === 1)
    await page.fill('[data-testid="composer"]', 'read this scan')
    await page.click('[data-testid="send"]')
    await page.click('[data-testid="composer-transfer-cancel"]', { timeout: 10_000 })
    await page.waitForSelector('[data-testid="composer-image"].is-failed')
    assert.match(await page.locator('[data-testid="composer-image"] .attachment-error').innerText(), /^upload cancelled/)
    assert.deepEqual(uploads.dropped, ['scan.pdf'])                              // asked and confirmed before the card said so
    assert.deepEqual(uploads.completed, completedBeforeCancel)
    assert.equal(await composerText(), 'read this scan')
    assert.deepEqual(await wholeReads(), [])
    await page.locator('[data-testid="composer-image"] button[aria-label^="Remove"]').click()
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer-image"]').length === 0)
    await page.fill('[data-testid="composer"]', '')
  } finally {
    posted?.stop()
    await watched?.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[UI simulation: desktop bridge and endpoints stood in, references kept from the backend] in the desktop app a PDF or a video — chosen, dropped or pasted, small or large — is named where it lies: nothing uploaded; a refusal is said, never uploaded; the card shows its path, no download', async (t) => {
  const shared = page
  const simulation = await openRoutedSimulation(browser)
  page = simulation.page
  page.on('pageerror', (e) => { throw e })
  t.after(async () => { try { await simulation.close() } finally { page = shared } })
  const sessionId = await startUiTask('scripted:e', 'look around the working folder')
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 30_000 })
  await bypassDirector(page)
  // the shell, as the page sees it: the File's path named to the harness (here: a path the test makes of the name),
  // null for a File with no file behind it, a refusal thrown for a path the shell keeps for itself
  const asked: { session: string; name: string; size: number }[] = []
  const made = new Map<string, Record<string, unknown>>()
  const installBridge = () => page.evaluate(() => {
    Object.assign(window, { oasisCodeDesktop: { platform: 'darwin', attachLocalFile: (session: string, file: File) => (window as unknown as { e2eAttachLocalFile: (s: string, n: string, z: number) => Promise<unknown> }).e2eAttachLocalFile(session, file.name, file.size) } })
  })
  let posted: ReturnType<typeof uploadRequests> | null = null
  try {
    shellStandIn = (session, name, size) => {
      asked.push({ session, name, size })
      if (name === 'made.pdf') return null
      if (name === 'secret.mov') throw new Error('refused: secret.mov lies in a folder the app keeps for itself')
      const ref = refOf(name, 'local', size, `/Users/person/Movies/Trip 2026 — 東京/${name}`)
      made.set(ref.asset_id, ref)
      return ref
    }
    await exposeShellStandIn()
    await installBridge()
    const uploads = await standInUploads(sessionId, { chunk: MiB }, made)
    const bodies = await carryReferences(sessionId, () => made)
    posted = uploadRequests()
    // chosen (a small PDF and a large video), dropped (a File made in the page: no file behind it), pasted
    await page.setInputFiles('[data-testid="attach-input"]', [{ name: 'tiny.pdf', mimeType: 'application/pdf', buffer: pdfFixture() }, { name: 'trip.mov', mimeType: 'video/quicktime', buffer: mp4Fixture() }])
    await page.evaluate(() => {
      const drop = new DataTransfer(); drop.items.add(new File(['%PDF-1.4 made in the page'], 'made.pdf', { type: 'application/pdf' }))
      document.querySelector('[data-testid="thread-composer"]')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: drop }))
      const paste = new DataTransfer(); paste.items.add(new File(['webm'], 'pasted.webm', { type: 'video/webm' }))
      document.querySelector('[data-testid="composer"]')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: paste }))
    })
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer-image"].is-ready').length === 4)
    await page.fill('[data-testid="composer"]', 'compare these')
    const done = await page.locator('[data-testid^="run-run_"][data-status="done"]').count()
    await page.click('[data-testid="send"]')
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="run-run_"][data-status="done"]').length === n + 1, done, { timeout: 30_000 })
    // every PDF and video asked the shell first, for this session; only the one with no file behind it was uploaded
    assert.deepEqual(asked.map((a) => [a.session, a.name]), [[sessionId, 'tiny.pdf'], [sessionId, 'trip.mov'], [sessionId, 'made.pdf'], [sessionId, 'pasted.webm']])
    assert.deepEqual(uploads.opened.map((o) => o.name), ['made.pdf'])
    assert.deepEqual(posted.posts, [])
    assert.deepEqual(bodies.at(-1)!.attachments, ['a_ref_tiny_pdf', 'a_ref_trip_mov', 'a_ref_made_pdf', 'a_ref_pasted_webm'])
    // the thread: a local reference is its path as attached, live, not a link; the uploaded one downloads
    const turn = page.locator('[data-testid^="run-run_"]').last()
    assert.deepEqual(await turn.locator('[data-testid="attachment-location"]').allInnerTexts(),
      ['/Users/person/Movies/Trip 2026 — 東京/tiny.pdf', '/Users/person/Movies/Trip 2026 — 東京/trip.mov', '/Users/person/Movies/Trip 2026 — 東京/pasted.webm'])
    assert.equal(await turn.locator('[data-testid="attachment-local"] a, a[data-testid="attachment-local"]').count(), 0)
    assert.match(await turn.locator('[data-testid="attachment-local"]').first().innerText(), /live reference, read where it lies/)
    assert.equal(await turn.locator('a.attachment-card').count(), 1)
    // read back after a reload: the same path, still no download
    await reloadInto(sessionId)
    assert.deepEqual(await page.locator('[data-testid^="run-run_"]').last().locator('[data-testid="attachment-location"]').allInnerTexts(),
      ['/Users/person/Movies/Trip 2026 — 東京/tiny.pdf', '/Users/person/Movies/Trip 2026 — 東京/trip.mov', '/Users/person/Movies/Trip 2026 — 東京/pasted.webm'])
    // a refusal of the shell: said on the file, the words kept, nothing uploaded instead (the reload took the page's
    // stand-in bridge away; it is put back)
    await installBridge()
    const before = { asked: asked.length, opened: uploads.opened.length, posts: posted.posts.length, chats: bodies.length }
    await page.setInputFiles('[data-testid="attach-input"]', { name: 'secret.mov', mimeType: 'video/quicktime', buffer: mp4Fixture() })
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer-image"].is-ready').length === 1)
    await page.fill('[data-testid="composer"]', 'look at this')
    await page.click('[data-testid="send"]')
    await page.waitForSelector('[data-testid="composer-image"].is-failed')
    assert.match(await page.locator('[data-testid="composer-image"] .attachment-error').innerText(), /refused: secret\.mov lies in a folder the app keeps for itself/)
    assert.deepEqual({ asked: asked.length, opened: uploads.opened.length, posts: posted.posts.length, chats: bodies.length }, { ...before, asked: before.asked + 1 })
    assert.equal(await composerText(), 'look at this')
    await page.locator('[data-testid="composer-image"] button[aria-label^="Remove"]').click()
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer-image"]').length === 0)
    await page.fill('[data-testid="composer"]', '')
  } finally {
    shellStandIn = null                                                       // the exposed binding answers nothing now
    posted?.stop()
    await page.evaluate(() => { delete (window as unknown as { oasisCodeDesktop?: unknown }).oasisCodeDesktop }).catch(() => undefined)
  }
})

// ---- full stack: nothing stood in ----------------------------------------------------------------------------------
// The two tests above are UI simulations (their endpoints stood in). This one is the whole path against the real e2e
// server on the same port: the page's real chunked upload of a File larger than a chunk, the real store, the real chat
// and provider boundary, and a scripted route that takes no video (scripted:path) answering back, as one JSON line
// (`PATHPROBE {…}`), every reference note it was handed and a fingerprint of its whole tool definitions (names,
// descriptions, schemas) — on two runs of the session. The answer is read from the real backend's run (its receipt's
// final_text), not from the rendered markdown, so a `#`, `_` or `*` in a note or a path cannot change what is compared.
// Order matters: adding the file only prepares it in the page; the upload itself begins when the message is sent.
test('[full stack: real upload, real backend] a browser\'s video over 20 MiB is uploaded in real chunks; a route that does not take it is handed its stable path, the same on the next run, the tools unchanged', async () => {
  const sessionId = await startUiTask('scripted:path', 'look around the working folder')
  await page.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 30_000 })
  await bypassDirector(page)
  const dir = mkdtempSync(join(process.env.OASIS_CODE_E2E_TMP ?? tmpdir(), 'oasis-e2e-fullstack-'))
  const puts: number[] = []
  const locals: string[] = []
  const onRequest = (r: { method: () => string; url: () => string }) => {
    const url = new URL(r.url())
    if (r.method() === 'PUT' && url.pathname.startsWith(`/api/sessions/${sessionId}/uploads/`)) puts.push(Number(url.searchParams.get('offset')))
    if (url.pathname.endsWith('/attachments/local')) locals.push(url.pathname)
  }
  type ProbeRun = { id: string; user_text?: string; status: string; attachments: Record<string, unknown>[]; receipt: { final_text?: string } }
  const runOf = async (words: string) => {
    const runs = (await api<{ runs: ProbeRun[] }>(`/api/sessions/${sessionId}`)).body.runs.filter((r) => r.user_text === words)
    assert.equal(runs.length, 1, `one run of "${words}"`)
    return runs[0]!
  }
  const probeOf = (run: ProbeRun) => {
    const text = String(run.receipt.final_text ?? '')
    const m = /PATHPROBE (\{[\s\S]*\})\s*$/.exec(text)
    assert.ok(m, text)
    return JSON.parse(m[1]!) as { notes: string[]; tools_sha256: string; tool_count: number; file_pieces: number }
  }
  page.on('request', onRequest)
  try {
    const size = 33 * MiB + 4097                                              // over 20 MiB and over one 32 MiB chunk
    const film = join(dir, 'field clip.mp4')
    writeFileSync(film, mp4Fixture())
    const fd = openSync(film, 'r+'); ftruncateSync(fd, size); closeSync(fd)            // sparse: only the head is written
    // 1. the waiter for the real completion, before anything can complete
    const completed = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/api/sessions/${sessionId}/uploads/`) && /\/complete$/.test(new URL(r.url()).pathname), { timeout: 180_000 })
    // 2. the file is added: prepared in the page only — nothing is uploaded yet
    await page.setInputFiles('[data-testid="attach-input"]', film)
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer-image"].is-ready').length === 1, undefined, { timeout: 60_000 })
    assert.deepEqual(puts, [], 'no chunk goes before the message is sent')
    // 3. the send starts the real upload, then the message
    const done = await page.locator('[data-testid^="run-run_"][data-status="done"]').count()
    const firstWords = 'what happens in this clip?'
    await page.fill('[data-testid="composer"]', firstWords)
    await page.click('[data-testid="send"]')
    const completion = await completed
    assert.equal(completion.status(), 200)
    const ref = await completion.json() as Record<string, unknown>
    assert.equal(ref.representation, 'ref-v1')
    assert.equal(ref.origin, 'upload')
    assert.equal(ref.bytes, size)
    assert.equal(ref.media_type, 'video/mp4')
    assert.equal(ref.name, 'field clip.mp4')
    // the harness names the stored file by its real path (macOS: /tmp is /private/tmp)
    const dataRoot = realpathSync(info.data)
    assert.ok(String(ref.location).startsWith(`${dataRoot}/`), `${String(ref.location)} under ${dataRoot}`)
    // real chunks: two PUTs at the offsets the harness held (its chunk is 32 MiB), the whole file once; nothing local
    assert.deepEqual(puts, [0, 32 * MiB])
    assert.deepEqual(locals, [])
    // the stored file is the one location names, the whole of it (the harness counted every byte: ref.bytes)
    assert.equal(statSync(String(ref.location)).size, size)
    // 4. the run of that message ends; the real backend holds the reference on it, frozen, as completed
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="run-run_"][data-status="done"]').length === n + 1, done, { timeout: 60_000 })
    const firstRun = await runOf(firstWords)
    assert.equal(firstRun.status, 'done')
    // every field the completion answered is on the run's attachment as answered (the run may carry its own extras)
    assert.equal(firstRun.attachments.length, 1)
    assert.deepEqual(Object.fromEntries(Object.keys(ref).map((k) => [k, firstRun.attachments[0]![k]])), ref)
    const a = probeOf(firstRun)
    assert.equal(a.notes.length, 1)
    assert.equal(a.file_pieces, 0)                                            // no bytes travelled: the path line only
    assert.ok(a.notes[0]!.startsWith('[attached file (reference v1): '), a.notes[0])
    assert.ok(a.notes[0]!.includes(`${size} bytes`), a.notes[0])
    assert.ok(a.notes[0]!.includes(String(ref.location)), a.notes[0])         // the stable path, as stored
    assert.ok(a.notes[0]!.includes('its content is not in this message'), a.notes[0])
    assert.ok(a.tool_count > 0)
    // 5. the next run of the session: the same note, word for word, and the same tools, schemas included
    const secondWords = 'and once more?'
    await page.fill('[data-testid="composer"]', secondWords)
    await page.click('[data-testid="send"]')
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="run-run_"][data-status="done"]').length === n + 2, done, { timeout: 60_000 })
    const secondRun = await runOf(secondWords)
    assert.deepEqual(secondRun.attachments, [])
    const b = probeOf(secondRun)
    assert.deepEqual(b.notes, a.notes)
    assert.equal(b.tools_sha256, a.tools_sha256)
    assert.equal(b.tool_count, a.tool_count)
    assert.equal(b.file_pieces, 0)
    assert.deepEqual(puts, [0, 32 * MiB], 'nothing uploaded again')
    // the uploaded reference is served back (Range) by the real backend, from the same session
    const head = await page.evaluate(async ([sid, id]) => { const r = await fetch(`/api/sessions/${sid}/attachments/${id}`, { headers: { range: 'bytes=4-11', 'x-oasis-code-token': localStorage.getItem('oasis-code.token') ?? '' } }); return { status: r.status, text: await r.text() } }, [sessionId, String(ref.asset_id)])
    assert.equal(head.status, 206)
    assert.equal(head.text, 'ftypisom')
  } finally {
    page.off('request', onRequest)
    rmSync(dir, { recursive: true, force: true })
  }
})


test('full access: new sessions default to it and send at once (the harness asks in the conversation: full-access-ask.e2e.ts); no chip until a session is in the sandbox, whose chip changes it back only while idle, beside the mode', async () => {
  // a context of its own (its page's storage its own)
  const context = await browser.newContext()
  const fresh = await context.newPage()
  fresh.on('pageerror', (e) => { throw e })
  const call = async <T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> => fresh.evaluate(async ({ path, method, body }) => {
    const res = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-oasis-code-token': localStorage.getItem('oasis-code.token') ?? '' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }, { path, method: init.method ?? 'GET', body: init.body })
  const chip = () => fresh.locator('[data-testid="access-chip"]')
  const pick = async (id: string) => {
    await fresh.click('[data-testid="model-picker"]')
    await fresh.click(`[data-testid="model-option-${id}"]`)
  }
  try {
    await fresh.goto(`${BASE}/?token=${info.token}`)
    await fresh.waitForSelector('[data-testid="hero"]')
    await bypassDirector(fresh)
    // the start screen: Full access is the default and takes no room
    assert.equal(await fresh.locator('[data-testid="hero-composer"] [data-testid="access-chip"]').count(), 0)
    await pick('scripted:cmd')
    const words = 'add() returns the wrong result; fix it and run the tests'
    await fresh.fill('[data-testid="composer"]', words)
    // the session is made with full access (its mode Auto, as every session starts) and runs: nothing asked on the page
    await fresh.click('[data-testid="send"]')
    await fresh.waitForSelector('[data-testid="thread-composer"]')
    assert.equal(await fresh.locator('dialog[open]').count(), 0)
    const sid = (await fresh.locator('[aria-current="page"][data-testid^="session-"]').getAttribute('data-testid'))!.slice('session-'.length)
    assert.equal((await call<{ access_mode: string }>(`/api/sessions/${sid}/access`)).body.access_mode, 'full')
    assert.equal((await call<{ mode: string }>(`/api/sessions/${sid}/mode`)).body.mode, 'auto')
    await fresh.waitForSelector('[data-testid^="run-run_"][data-status="done"]', { timeout: 60_000 })
    // its command ran outside the OS sandbox, as the user: the execution's record says so
    const runId = (await fresh.locator('[data-testid^="run-run_"]').first().getAttribute('data-testid'))!.slice(4)
    const detail = (await call<{ executions: { isolation: Record<string, unknown> }[] }>(`/api/runs/${runId}`)).body
    assert.ok(detail.executions.length > 0, 'the run ran a command')
    for (const e of detail.executions) {
      assert.equal(e.isolation.access_mode, 'full')
      assert.equal(e.isolation.runtime, 'host')
    }
    assert.equal(await chip().count(), 0, 'a Full session shows no access chip')

    // the session put in the sandbox (as "Use the sandbox" at the first command's question does): its chip shows it,
    // its menu holds the two choices and nothing else, the mode untouched
    assert.equal((await call(`/api/sessions/${sid}/access`, { method: 'PUT', body: { access_mode: 'sandbox' } })).status, 200)
    await fresh.reload()
    await fresh.click(`[data-testid="session-${sid}"]`)
    await fresh.waitForFunction(() => document.querySelector('[data-testid="access-chip"]')?.getAttribute('data-access') === 'sandbox', undefined, { timeout: 10_000 })
    await chip().click()
    assert.deepEqual((await fresh.locator('[data-testid="access-menu"] [role="option"]').allInnerTexts()).map((t) => t.trim()), ['Full access', 'Sandbox'])
    await fresh.keyboard.press('Escape')
    await fresh.waitForSelector('[data-testid="access-menu"]', { state: 'detached' })
    assert.equal((await call<{ mode: string }>(`/api/sessions/${sid}/mode`)).body.mode, 'auto')

    // a run at work holds the access: the choice is offered disabled, saying why; the harness refuses it too (409)
    await pick('scripted:long')
    await fresh.fill('[data-testid="composer"]', 'run something long')
    await fresh.click('[data-testid="send"]')
    await fresh.waitForSelector('.row.activity[data-tool="bash"].running', { timeout: 20_000 })
    await chip().click()
    const full = fresh.locator('[data-testid="access-option-full"]')
    await fresh.waitForFunction(() => (document.querySelector('[data-testid="access-option-full"]') as HTMLButtonElement | null)?.disabled === true, undefined, { timeout: 10_000 })
    assert.equal(await full.getAttribute('title'), 'Stop the active runs first.')
    await fresh.keyboard.press('Escape')
    const refused = await call<{ code: string; blocked_by: { runs: number } }>(`/api/sessions/${sid}/access`, { method: 'PUT', body: { access_mode: 'full' } })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.code, 'access_blocked')
    assert.ok(refused.body.blocked_by.runs >= 1)
    assert.equal(await chip().getAttribute('data-access'), 'sandbox')
    // the run stopped: opening the chip asks again, and the change is offered (Full access, confirmed already: no dialog)
    await fresh.click('[data-testid="stop"]')
    await fresh.waitForSelector('[data-testid^="run-run_"][data-status="cancelled"]', { timeout: 20_000 })
    const deadline = Date.now() + 15_000
    for (;;) {
      await chip().click()
      await fresh.waitForTimeout(300)
      if (!(await full.isDisabled())) break
      await fresh.keyboard.press('Escape')
      assert.ok(Date.now() < deadline, 'the access became changeable once the run and its commands ended')
      await fresh.waitForTimeout(700)
    }
    await full.click()
    await fresh.waitForSelector('[data-testid="access-chip"]', { state: 'detached' })
    assert.equal(await fresh.locator('dialog[open]').count(), 0)
    assert.equal((await call<{ access_mode: string }>(`/api/sessions/${sid}/access`)).body.access_mode, 'full')
  } finally {
    await context.close()
  }
})
