/** Every bot of the page plays one reading of where its agent stands (state/presence.ts), in real Chrome against a
 *  stand-in backend (bot-states-stub.ts — a CONTROLLED FIXTURE: one session whose six participants stand idle,
 *  waiting, thinking, working, blocked and done; the test moves its world and speaks on each run's stream as the
 *  harness would, the real built UI draws it):
 *   - the six states, the same on the thread's answers and live lines, the desk's cards and shelf, a card's own
 *     conversation (RunView), the Agent Teams outline, the relations' lanes and the interaction's step strip;
 *   - a run's tools: forming is no work, several open calls aggregate; in line, then going on; a form the run waits
 *     on, answered in place; a slot waited for; a run of the thread that the tree reads as dispatched (one stream);
 *   - the main agent's watch on its current run alone (set by an older run), a report waiting, the wake run taking
 *     over; the person's stop (idle), an error (blocked), a gate's proposal (blocked until approved); endings settle
 *     to the still icon by the clock, what waits for the person or a watch never does; an older answer never moves;
 *   - every bot picture whole in its box (object-fit contain, not squeezed), the non-square icons measured;
 *   - the brand's reel idle, the identity marks still.
 *  Screenshots (headless Chrome, its own temporary profile; never the system's screen) go to the evidence folder
 *  (OASIS_CODE_EVIDENCE_DIR, default ../reports/bot-states-20261018 — ignored by git).
 *  Run after `npm run build`, one file at a time, on 8399 (OASIS_CODE_E2E_PORT). */

import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright-core'
import { IX, MAIN_CUR, MAIN_OLD, makeRun, participantOf, RUN, S, startBotStub, type BotStub } from './bot-states-stub.ts'

const DIST = realpathSync(resolve(process.env.OASIS_CODE_E2E_DIST ?? join(process.cwd(), 'dist')))
const EVIDENCE = resolve(process.env.OASIS_CODE_EVIDENCE_DIR ?? join(process.cwd(), '..', 'reports', 'bot-states-20261018'))
const SHOTS = join(EVIDENCE, 'shots')
const WAIT_MS = 10_000
const T0 = Date.now()
let stub: BotStub
let browser: Browser
let page: Page
const errors: string[] = []
const shots: { file: string; what: string }[] = []
const measured: unknown[] = []

before(async () => {
  mkdirSync(SHOTS, { recursive: true })
  stub = await startBotStub(DIST, T0)
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  // a browser of the test's own (a fresh temporary profile), headless
  browser = await chromium.launch(executablePath ? { executablePath, headless: true, args: ['--no-sandbox'] } : { channel: 'chrome', headless: true })
  page = await browser.newPage({ viewport: { width: 1680, height: 1050 } })
  page.on('pageerror', (e) => { errors.push(e.message) })
  // the page's clock is the test's: an ending's moment is played forward, not waited for
  await page.clock.install({ time: T0 })
})

after(async () => {
  writeFileSync(join(EVIDENCE, 'shots.json'), JSON.stringify({ shots, measured }, null, 2))
  // an index of the screenshots, opened in the same headless Chrome and shot whole (a contact sheet of the originals)
  if (shots.length && browser) {
    const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
    const html = `<!doctype html><meta charset="utf-8"><title>bot states — screenshots</title><style>body{font:13px system-ui;margin:16px;background:#fafafa}
      .g{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.c{background:#fff;border:1px solid #ddd;border-radius:6px;padding:6px}
      .c img{width:100%;height:220px;object-fit:contain;background:#f0f0f0}.c b{display:block;font-size:12px}.c span{color:#555;font-size:11px}</style>
      <h1 style="font-size:16px">Bot states — real UI in headless Chrome against a controlled fixture (bot-states-stub.ts); originals in shots/</h1><div class="g">${
      shots.map((x) => `<div class="c"><img src="${esc(x.file)}"><b>${esc(x.file)}</b><span>${esc(x.what)}</span></div>`).join('')}</div>`
    writeFileSync(join(EVIDENCE, 'index.html'), html)
    const sheet = await browser.newPage({ viewport: { width: 1600, height: 900 } })
    await sheet.goto(`file://${join(EVIDENCE, 'index.html')}`)
    await sheet.waitForLoadState('load')
    await sheet.screenshot({ path: join(EVIDENCE, 'contact-sheet.png'), fullPage: true })
    await sheet.close()
  }
  await browser?.close()
  await stub?.close()
})

async function shot(name: string, what: string, selector?: string) {
  const file = join(SHOTS, `${name}.png`)
  if (selector) await page.locator(selector).first().screenshot({ path: file })
  else await page.screenshot({ path: file })
  shots.push({ file: `shots/${name}.png`, what })
}

/** The bot state an element's bot picture says (the first bot image under it). */
const stateOf = (selector: string) => page.locator(selector).locator('img.bot-img').first().getAttribute('data-bot-state')
async function expectState(selector: string, state: string | string[], what: string) {
  const until = Date.now() + WAIT_MS
  const wanted = Array.isArray(state) ? state : [state]
  let seen: string | null = null
  while (Date.now() < until) {
    seen = await stateOf(selector).catch(() => null)
    if (seen !== null && wanted.includes(seen)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.fail(`${what}: ${selector} plays ${seen}, not ${state}`)
}

/** the page reads the session again (its 3 s tick, on the page's clock) */
const sync = () => page.clock.fastForward(3_500)
const MAIN_LANE = '[data-testid="rg-lane-pa_main"]'
/** a run ends as the harness says it: its answer, its record, its run_finished */
async function finish(runId: string, status: string, answer: string, extra: Record<string, unknown> = {}) {
  // its end at the page's time (the page's clock is the test's: paused a while, played forward)
  const at = new Date(await page.evaluate(() => Date.now())).toISOString()
  stub.push(runId, 'text_delta', { text: answer, start: true })
  stub.push(runId, 'text_block', { text: answer })
  stub.patch(runId, { status, finished_at: at, ...extra })
  stub.push(runId, 'run_finished', { status, receipt: { finished_at: at }, ...extra })
}

async function eventually(check: () => boolean, what: string, onFail?: () => Promise<void>) {
  const until = Date.now() + WAIT_MS
  while (Date.now() < until) { if (check()) return; await new Promise((r) => setTimeout(r, 100)) }
  await onFail?.()
  assert.fail(`not within ${WAIT_MS} ms: ${what}`)
}

/** A card off the shelf, by its exact name on the shelf's list (the list opened first: taking one back closes it). */
async function takeBack(title: string) {
  if (!(await page.locator('.desk-tail-list').count())) await page.getByTestId('desk-shelf').click()
  await page.locator(`.desk-tail-list .desk-chip[title="${title}"]`).click()
  await page.locator(`.desk-tail-list .desk-chip[title="${title}"]`).waitFor({ state: 'detached' })
}

/** Whether the element's own bot picture is on top at its centre (nothing covers it on the screen). */
async function uncovered(selector: string) {
  const img = page.locator(selector).locator('img.bot-img').first()
  await img.scrollIntoViewIfNeeded()
  return img.evaluate((el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === el })
}

const turn = (runId: string) => `[data-testid="run-${runId}"]`
const live = (runId: string) => `${turn(runId)} [data-testid="live-line"]`
const lane = (p: string) => `[data-testid="rg-lane-${participantOf(p)}"]`
const step = (p: string) => `[data-testid="interaction-step"][data-node="n_${p.toLowerCase()}"]`
const card = (runId: string) => `[data-testid="card-${runId}"]`
const cardHead = (runId: string) => `${card(runId)} .desk-title`
const runView = (runId: string) => `[data-testid="agent-view-${runId}"] .rd-head`
const outline = (runId: string) => `[data-testid="ol-${runId}"]`
const SIX = [['A', RUN.A, 'idle'], ['B', RUN.B, 'waiting'], ['C', RUN.C, 'thinking'], ['D', RUN.D, 'working'], ['E', RUN.E, 'blocked'], ['F', RUN.F, 'done']] as const

test('the brand plays idle with no run; the start screen too', async () => {
  await page.goto(`http://127.0.0.1:${stub.port}/?token=stub`)
  await page.waitForSelector('[data-testid="bot-reel"]')
  for (const img of await page.locator('[data-testid="bot-reel"] img').all()) assert.equal(await img.getAttribute('data-bot-state'), 'idle')
  assert.match((await page.locator('[data-testid="bot-reel"] img').first().getAttribute('src'))!, /^\/bots\/anim\/idle\/[0-9]{2}-[a-z]+\.webp$/)
  await shot('00-start-brand-idle', 'the start screen: the brand reel plays idle (no run)')
  await shot('00b-brand-rail', 'the rail brand, idle', '[data-testid="brand"]')
})

test('six agents in six states: every place shows the same state', async () => {
  // A stopped and F done a moment ago, as the session opens: their endings play now (25 s)
  for (const id of [RUN.A, RUN.F]) stub.patch(id, { finished_at: new Date().toISOString() })
  await page.getByTestId(`session-${S}`).click()
  await expectState(turn(RUN.A), 'idle', 'the session is drawn')
  // the page's clock stands still while every place is read and shot: the endings of A and F play the whole time
  // (nothing here waits on a timer; the next test lets it run again)
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500))
  try { await sixStates() } finally { await page.clock.resume() }
  assert.deepEqual(errors, [])
})

async function sixStates() {
  for (const [p, runId, state] of SIX) {
    await expectState(turn(runId), state, `thread answer/line of ${p}`)
    await expectState(lane(p), state, `lane of ${p}`)
    await expectState(step(p), state, `step of ${p}`)
  }
  // the live lines say it as well (the ended ones have none)
  for (const [, runId, state] of SIX.filter(([, , s]) => !['idle', 'done'].includes(s))) await expectState(live(runId), state, `live line of ${runId}`)
  // the main agent: its current run thinks, its answer of an hour ago is still
  await expectState(turn(MAIN_CUR), 'thinking', 'the main agent now')
  await expectState(turn(MAIN_OLD), 'static', 'the main agent an hour ago')
  // the lanes keep their run's status on data-state (the contract), the picture says the bot's state
  assert.equal(await page.locator(lane('A')).getAttribute('data-state'), 'cancelled')
  assert.equal(await page.locator(lane('B')).getAttribute('data-state'), 'queued')
  await shot('01-thread-six-states', 'the thread: six participants\' answers and live lines, the agents board, the step strip (controlled fixture)')
  await shot('02-lanes-six-states', 'the relations lanes: each lane\'s bot plays its agent\'s state', '[data-testid="agents-relations"]')
  await shot('03-step-strip-six-states', 'the interaction\'s step strip (nodes not yet given run ids: the strip shows; each step plays its run\'s state)', '[data-testid="interaction-strip"]')
  for (const [p, runId, state] of SIX) await shot(`04-thread-${state}-${p}`, `thread turn of agent ${p}: ${state}`, turn(runId))

  // the desk: the ended agents' cards rest on the shelf; their faces play their state too
  await expectState('[data-testid="desk-shelf"]', ['idle', 'done'], 'the shelf (its newest face)')
  await shot('05-desk-shelf', 'the desk\'s shelf: the resting agents\' faces (A idle, F done)', '[data-testid="desk-shelf"]')
  await page.getByTestId('desk-shelf').click()
  await shot('05b-desk-shelf-list', 'the shelf\'s list, each face in its state', '.desk-tail-list')
  for (const name of ['A', 'F']) await takeBack(name)
  await page.locator('button[title="Tile every card across the desk"]').click()
  for (const [p, runId, state] of SIX) {
    await expectState(cardHead(runId), state, `card title of ${p}`)
    await expectState(runView(runId), state, `card conversation head of ${p}`)
  }
  await page.waitForTimeout(1200)                                                    // the cards glide into their tiles
  await shot('06-desk-grid-six-states', 'the desk tiled: six agents\' cards (title bot, conversation head) in six states')
  for (const [p, runId, state] of SIX) await shot(`07-card-${state}-${p}`, `agent ${p}'s card: title bot, state word, conversation head (RunView)`, card(runId))
  await page.locator('button[title="Stack the cards in a column"]').click()

  // the Agent Teams outline (the graph dock, taken back from the shelf when it rests)
  if (!(await page.getByTestId('graph-dock').count())) await takeBack('Agent Teams')
  for (const [p, runId, state] of SIX) await expectState(outline(runId), state, `outline row of ${p}`)
  // the main agent's two runs are two rows (the later one continues no run): the older still, the current thinking
  await expectState(outline(MAIN_OLD), 'static', 'the outline\'s row of the main agent\'s older run')
  await expectState(outline(MAIN_CUR), 'thinking', 'the outline\'s row of the main agent\'s current run')
  await shot('08-outline-six-states', 'the Agent Teams outline: each row\'s bot in its agent\'s state', '[data-testid="graph-dock"]')
}

test('a run\'s tools: forming is no work; several open calls aggregate; the last answered, the model thinks', async () => {
  // D has bash open; the model writes a second call: still working (bash runs)
  stub.push(RUN.D, 'tool_call_progress', { tool_call_id: 'tc_d2', tool: 'write_file', chars: 120 })
  await expectState(live(RUN.D), 'working', 'one call open, one forming')
  stub.push(RUN.D, 'tool_result', { tool_call_id: 'tc_d1', tool: 'bash', status: 'ok', exit_code: 0 })
  await expectState(live(RUN.D), 'thinking', 'only a forming call: nothing runs')
  for (const sel of [lane('D'), step('D'), cardHead(RUN.D), outline(RUN.D)]) await expectState(sel, 'thinking', `${sel} with the same run`)
  await shot('10-forming-is-thinking', 'D: a call still being written (forming) is thinking, not working', turn(RUN.D))
  stub.push(RUN.D, 'tool_call', { tool_call_id: 'tc_d2', tool: 'write_file', summary: 'a.ts' })
  stub.push(RUN.D, 'tool_call', { tool_call_id: 'tc_d3', tool: 'web_search', summary: 'peg grammar' })
  await expectState(live(RUN.D), 'working', 'two calls open')
  stub.push(RUN.D, 'tool_result', { tool_call_id: 'tc_d2', tool: 'write_file', status: 'ok' })
  await expectState(live(RUN.D), 'working', 'the other call still runs')
  await shot('11-two-open-one-answered-working', 'D: one of two open calls answered, the other still runs: working', turn(RUN.D))
  stub.push(RUN.D, 'tool_result', { tool_call_id: 'tc_d3', tool: 'web_search', status: 'error', exit_code: 1 })
  await expectState(live(RUN.D), 'thinking', 'every call answered (one failed): the model goes on, not blocked')
  // the run the tree reads as dispatched (a director's order) is the thread's: one stream, no empty copy
  // (on the session's one stream: a second view of a run would read its history again; none did)
  assert.equal(stub.requests.filter((r) => r.path.startsWith(`/api/runs/${RUN.D}/events`)).length, 0)
})

test('in line, then going on; a request slot waited for; a form answered in place', async () => {
  stub.patch(RUN.B, { status: 'running', waiting: null })
  stub.push(RUN.B, 'slot_acquired', { scope: 'workspace:ws_bots' })
  stub.push(RUN.B, 'run_started', { model: 'scripted:a' })
  for (const sel of [live(RUN.B), lane('B'), step('B'), cardHead(RUN.B), outline(RUN.B)]) await expectState(sel, 'thinking', `B going on: ${sel}`)
  stub.push(RUN.C, 'slot_wait', { scope: 'provider:scripted', behind: [RUN.D] })
  await expectState(live(RUN.C), 'waiting', 'C waits for a request slot')
  await expectState(lane('C'), 'waiting', 'its lane too')
  await shot('12-slot-wait-waiting', 'C: a request waits for its slot: waiting', turn(RUN.C))
  stub.push(RUN.C, 'slot_acquired', { scope: 'provider:scripted' })
  await expectState(live(RUN.C), 'thinking', 'the slot taken')
  // E's form: answered in the thread, the same run goes on
  await expectState(cardHead(RUN.E), 'blocked', 'E waits on the person')
  await page.locator(`${turn(RUN.E)} [data-testid="ui-input-submit"]`).first().click()
  await eventually(() => stub.requests.some((r) => r.method === 'POST' && r.path.endsWith('/submit')), 'the answer sent', async () => { await shot('zz-debug-form', 'debug', turn(RUN.E)) })
  for (const sel of [live(RUN.E), lane('E'), cardHead(RUN.E), outline(RUN.E)]) await expectState(sel, 'thinking', `E after the answer: ${sel}`)
  await shot('13-form-submitted-thinking', 'E: the form submitted, the same run thinks again', turn(RUN.E))
})

test('the main agent\'s watch: waiting on its current run alone, a report waiting, the wake run taking over', async () => {
  await finish(MAIN_CUR, 'done', 'Fixed the tokenizer; I will check the CI run when it ends.')
  await expectState(turn(MAIN_CUR), 'done', 'the main run ended well')
  // a watch the agent set in its older run: it waits now, on the current run alone
  stub.world.watches = [{ id: 'w_ci', session_id: S, run_id: MAIN_OLD, spec: { kind: 'exit', execution_id: 'ex_ci', at: null, every_s: null, pattern: null, field: null, op: null, value: null, stream: 'both', silence_s: null },
    note: 'check CI', summary: 'CI run ends', status: 'active', repeat: false, cooldown_s: 0, max_fires: 1, fires: 0, last_fired_at: null, expires_at: new Date(T0 + 86_400_000).toISOString(), ended_reason: null, created_at: new Date(T0).toISOString(), updated_at: new Date(T0).toISOString() }]
  await sync()
  await expectState(turn(MAIN_CUR), 'waiting', 'the current run waits for its watch')
  await expectState(MAIN_LANE, 'waiting', 'the main agent\'s lane')
  await expectState(turn(MAIN_OLD), 'static', 'the older run that set it: its own result')
  await expectState(turn(RUN.D), 'thinking', 'another agent: untouched')
  await shot('14-watch-waiting-current-run', 'the main agent\'s watch (set by its older run) waits on its current run alone; the older answer stays still')
  // its report waits for the conversation to be free: still waiting, whatever the time
  stub.world.watches = stub.world.watches.map((w) => ({ ...w, status: 'done', fires: 1 }))
  stub.world.wake_events = [{ id: 'wk_1', watch_id: 'w_ci', session_id: S, kind: 'fired', detail: 'CI ended', payload: {}, status: 'pending', run_id: null, created_at: new Date().toISOString(), delivered_at: null }]
  await sync()
  await expectState(turn(MAIN_CUR), 'waiting', 'a report waits for delivery')
  // the wake run takes it: its own state; the run before it is no longer the current one
  const wake = makeRun({ id: 'run_m_wake', status: 'running', created: new Date(T0 + 40_000).toISOString(), user_text: 'A watch reported: CI ended', spawned_by: 'wake' })
  wake.events.push({ event: 'run_started', data: { model: 'scripted:a' } }, { event: 'thinking_delta', data: { text: 'CI passed.', start: true } })
  stub.add(wake)
  stub.world.wake_events = stub.world.wake_events.map((e) => ({ ...e, status: 'delivered', run_id: 'run_m_wake' }))
  await sync()
  await expectState(turn('run_m_wake'), 'thinking', 'the wake run thinks')
  await expectState(turn(MAIN_CUR), ['done', 'static'], 'the run before it: its own ending, no longer waiting')
  await shot('15-wake-run-thinking', 'the watch reported: the wake run thinks; the run before it plays its own ending')
  // the person stops it: idle, then still
  await finish('run_m_wake', 'cancelled', 'Checking the CI log')
  for (const sel of [turn('run_m_wake'), MAIN_LANE]) await expectState(sel, 'idle', `stopped by the person: ${sel}`)
  await shot('16-stopped-idle', 'the person stopped the run: idle (no success, no failure)', turn('run_m_wake'))
})

test('a gate blocks until approved; an error blocks a moment; endings settle; what waits never does', async () => {
  // C proposes an action the gate holds and ends its turn: blocked until the person decides
  stub.world.proposals = [{ proposal_asset_id: 'prop_c', created_at: new Date().toISOString(), tool_name: 'bash', run_id: RUN.C, session_id: S, status: 'pending', decision: null, label: 'git push' }]
  stub.push(RUN.C, 'action_gated', { action: 'bash', reason: 'the session asks before pushing' })
  await finish(RUN.C, 'done', 'I asked to push; waiting for your approval.')
  for (const sel of [turn(RUN.C), lane('C'), cardHead(RUN.C), outline(RUN.C)]) await expectState(sel, 'blocked', `C held by its proposal: ${sel}`)
  // D fails: blocked for a moment
  await finish(RUN.D, 'error', 'Half done', { error: 'the provider refused' })
  for (const sel of [turn(RUN.D), lane('D'), cardHead(RUN.D), outline(RUN.D)]) await expectState(sel, 'blocked', `D failed: ${sel}`)
  // B and E end well
  for (const id of [RUN.B, RUN.E]) {
    await finish(id, 'done', 'Done here.')
    await expectState(turn(id), 'done', `${id} ended well`)
  }
  // a watch of A's (its current run stopped long before): it waits, beyond any ending
  stub.world.watches = [...stub.world.watches, { ...(stub.world.watches[0] as object), id: 'w_a', run_id: RUN.A, status: 'active', fires: 0 }]
  await sync()
  await expectState(turn(RUN.A), 'waiting', 'A waits for its watch')
  await shot('17-gate-error-watch', 'C held by a proposal (blocked), D failed (blocked), B/E done, A waits for its watch')
  // the time passes: every ending settles; the proposal and the watch do not
  await page.clock.fastForward(45_000)
  for (const id of [RUN.B, RUN.D, RUN.E, RUN.F, 'run_m_wake', MAIN_CUR]) await expectState(turn(id), 'static', `${id} settled`)
  await expectState(MAIN_LANE, 'static', 'the main agent settled')
  await expectState(turn(RUN.C), 'blocked', 'the proposal still waits')
  await expectState(turn(RUN.A), 'waiting', 'the watch still waits')
  await shot('18-after-45s-settled', 'after 45 s: endings settled to still icons; the proposal (C) and the watch (A) still wait')
  // the person approves: no longer blocked
  await page.click('[data-testid="card-workspace"] .desk-title')
  await page.waitForSelector('[data-testid="card-workspace"].front')
  await page.getByTestId('approvals').scrollIntoViewIfNeeded()
  await page.getByTestId('approvals').waitFor({ state: 'visible' })
  await shot('19-gate-approval-panel', 'the workspace card\'s approvals: C\'s proposal waits for the person', '[data-testid="approvals"]')
  await page.getByTestId('approve-proposal').first().click()
  for (const sel of [turn(RUN.C), lane('C'), cardHead(RUN.C), outline(RUN.C)]) await expectState(sel, 'static', `C released: ${sel}`)
  await expectState(turn(MAIN_OLD), 'static', 'the answer of an hour ago never moved')
  assert.deepEqual(errors, [])
})

test('every bot picture is whole in its box: object-fit contain, never squeezed; the non-square icons measured', async () => {
  // A's watch ends (cancelled): its run, stopped long ago, settles to its still icon — the non-square 31-pin.png
  stub.world.watches = stub.world.watches.map((w) => (w.id === 'w_a' ? { ...w, status: 'cancelled', ended_reason: 'cancelled' } : w))
  await sync()
  for (const sel of [turn(RUN.A), lane('A'), cardHead(RUN.A), outline(RUN.A)]) await expectState(sel, 'static', `A settled once its watch ended: ${sel}`)
  // the cards tiled: every place a bot stands is on the page
  await page.locator('button[title="Tile every card across the desk"]').click()
  await page.waitForTimeout(1200)
  const all = await page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('img')].filter((img) => img.getAttribute('src')?.startsWith('/bots/')).map((img) => {
    const css = getComputedStyle(img)
    const box = img.getBoundingClientRect()
    return { src: img.getAttribute('src'), bot: img.dataset.bot ?? null, state: img.dataset.botState ?? null, cls: img.className, where: img.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
      natural: [img.naturalWidth, img.naturalHeight], box: [Math.round(box.width * 10) / 10, Math.round(box.height * 10) / 10], fit: css.objectFit, position: css.objectPosition, shrink: css.flexShrink, complete: img.complete }
  }))
  measured.push(...all)
  assert.ok(all.length > 30, `bot pictures on the page: ${all.length}`)
  for (const img of all) {
    assert.ok(img.cls.split(' ').includes('bot-img'), `every bot picture is a BotImage: ${img.src} in ${img.where}`)
    assert.equal(img.fit, 'contain', `${img.src} in ${img.where}`)
    assert.equal(img.position, '50% 50%', `${img.src} in ${img.where}`)
    assert.ok(img.state, `${img.src} says its state`)
    if (img.box[0] > 0) {
      assert.equal(img.shrink, '0', `${img.src} in ${img.where} is never squeezed by its row`)
      assert.ok(img.complete && img.natural[0] > 0, `${img.src} loaded`)
      assert.equal(img.box[0], img.box[1], `${img.src} in ${img.where}: a square box`)
    }
  }
  // the three non-square still pictures, each on the page as its PNG (not a square animation), in its square box with
  // object-fit contain, centred, not shrunk: the browser draws it whole in the box (what contain means)
  for (const bot of ['22-whistle', '23-signpost', '31-pin']) {
    const still = all.filter((i) => i.src === `/bots/icons/${bot}.png` && i.box[0] > 0)
    assert.ok(still.length >= 3, `${bot}.png shown still in several places: ${still.map((i) => i.where).join(', ')}`)
    for (const i of still) {
      assert.notEqual(i.natural[0], i.natural[1], `${bot}.png is not square (${i.natural.join('×')})`)
      assert.equal(i.state, 'static')
    }
  }
  writeFileSync(join(EVIDENCE, 'bot-images.json'), JSON.stringify(all, null, 2))
  await shot('20-ratio-desk-tiled', 'every card tiled: the still whistle (B), signpost (C) and pin (A) PNGs whole in their square boxes')
  for (const p of ['A', 'B', 'C'] as const) assert.ok(await uncovered(lane(p)), `agent ${p}'s lane bot is not covered`)
  for (const p of ['A', 'B', 'C'] as const) await shot(`22-ratio-lane-${p}`, `agent ${p}'s lane name (.rg-lane-name img: 16×16 box, contain)`, lane(p))
  // each card brought to the front of the stack, its conversation head shot with nothing over it (the Agent Teams dock,
  // which the tiled cards share the desk with, put on the shelf first)
  await page.locator('[data-testid="graph-dock"] [data-testid="card-shelve"]').click()
  await page.getByTestId('graph-dock').waitFor({ state: 'detached' })
  await page.locator('button[title="Stack the cards in a column"]').click()
  for (const [p, runId] of [['A', RUN.A], ['B', RUN.B], ['C', RUN.C]] as const) {
    await page.click(`${card(runId)} .desk-title`)
    await page.waitForSelector(`${card(runId)}.front`)
    await page.waitForTimeout(700)
    assert.ok(await uncovered(runView(runId)), `agent ${p}'s card head is not covered`)
    assert.ok(await uncovered(cardHead(runId)), `agent ${p}'s card title is not covered`)
    await shot(`21-ratio-rd-head-${p}`, `agent ${p}'s card at the front: title bot and conversation head (.rd-head img, 18×18 box, contain), uncovered`, card(runId))
  }
  // the brand's reel: idle, no run
  for (const i of all.filter((x) => x.where === 'bot-reel')) assert.equal(i.state, 'idle')
  void IX
})
