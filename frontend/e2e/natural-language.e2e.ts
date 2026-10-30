/** Real UI -> lazy native director -> connector -> persisted independent runs. The provider is the backend's
 * scripted fixture, never a live Fable account. Every filesystem read below is of that server's temporary fixture. */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright-core'
import { assertNaturalRuns, chooseNaturalSource, eventually, naturalInteraction, NATURAL_WORDS, pageApi, startNaturalTask, type NaturalInteraction } from './natural-language-driver.ts'

let server: ChildProcess, browser: Browser, page: Page
let base: string, source: string
let info: { token: string; isolation: string; default_model: string; natural_source: string; natural_director: string; natural_sentences: { battle: string; independent: string; slow: string } }
const failures: string[] = []
before(async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const listener = createServer(); listener.on('error', reject)
    listener.listen(Number(process.env.OASIS_CODE_E2E_PORT || 0), '127.0.0.1', () => { const address = listener.address(); const port = typeof address === 'object' && address ? address.port : 0; listener.close(() => resolve(port)) })
  })
  assert.ok(port && port !== 8321)
  base = `http://127.0.0.1:${port}`
  console.info(`e2e app port: ${port}`)
  server = spawn('bun', ['run', 'scripts/e2e_server.ts', String(port), '--natural-default'], { cwd: `${process.cwd()}/../backend-ts`, stdio: ['ignore', 'pipe', 'pipe'] })
  info = await new Promise((resolve, reject) => {
    let stdout = '', stderr = ''
    const timeout = setTimeout(() => reject(new Error(`scripted backend did not start: ${stderr}`)), 30_000)
    server.stdout!.on('data', (data) => { stdout += String(data); const line = stdout.split('\n')[0]; if (line.trim().startsWith('{')) { clearTimeout(timeout); resolve(JSON.parse(line)) } })
    server.stderr!.on('data', (data) => { stderr = (stderr + String(data)).slice(-8000) })
    server.on('error', (error) => { clearTimeout(timeout); reject(error) })
    server.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`scripted backend exited ${code}: ${stderr}`)) })
  })
  assert.equal(info.isolation, 'full', 'do not lower sandbox enforcement to run the acceptance path')
  assert.equal(info.default_model, info.natural_director)
  source = realpathSync(info.natural_source)
  for (const key of ['battle', 'independent', 'slow'] as const) assert.equal(info.natural_sentences[key], NATURAL_WORDS[key])
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { channel: 'chrome', headless: true })
}, { timeout: 45_000 })
after(async () => { await browser?.close(); server?.kill('SIGTERM') })
beforeEach(async () => {
  failures.length = 0
  page = await browser.newPage({ viewport: { width: 1680, height: 1050 } })
  page.on('pageerror', (error) => failures.push(error.message))
  await page.goto(`${base}/?token=${info.token}`)
  // the start screen's words go to the agent until the person calls the director in; the session keeps that choice
  await page.click('[data-testid="hero-composer"] [data-testid="restore-director"]')
  await page.waitForSelector('[data-testid="hero-composer"] [data-testid="director-chip"]')
})
afterEach(async () => { await page?.close(); assert.deepEqual(failures, []) })

function sourceDigest(root: string): string {
  const hash = createHash('sha256')
  const walk = (dir: string) => { for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), stat = lstatSync(path)
    hash.update(path)
    if (stat.isDirectory()) walk(path)
    else if (stat.isFile()) hash.update(readFileSync(path))
    else hash.update('not followed')
  } }
  walk(root); return hash.digest('hex')
}
async function reloadNatural(sid: string) {
  await page.reload()
  await page.getByTestId(`session-${sid}`).click()
  await page.waitForSelector('[data-testid="thread-composer"] [data-testid="director-chip"]')
}

test('Hero natural GAN battle creates three same-route participants and two real waves, protects source, reloads without rerunning', { timeout: 120_000 }, async () => {
  const before = sourceDigest(source)
  await chooseNaturalSource(page, source)
  const sid = await startNaturalTask(page, info.natural_sentences.battle)
  const ix = await naturalInteraction(page, sid, 'done')
  assert.equal(ix.user_text, NATURAL_WORDS.battle)
  assert.equal(ix.template, 'discussion')
  const ids = await assertNaturalRuns(page, ix, { waves: 2, source, thinking: null })
  assert.equal(sourceDigest(source), before)
  assert.equal(await page.getByTestId('node-adopt').count(), 0)
  await reloadNatural(sid)
  const restored = await naturalInteraction(page, sid, 'done')
  assert.deepEqual(restored.nodes.flatMap((n) => n.run_ids), ids)
  assert.equal(restored.runs_started, 6)
  // the members' runs stand on the session's agents board (their cards rest on the shelf as the session opens): a bar each
  for (const id of ids) await page.getByTestId('agents-relations').getByTestId(`rg-bar-${id}`).waitFor({ state: 'attached', timeout: 10_000 })
  assert.equal(await page.getByTestId('agents-relations').locator('[data-testid^="rg-bar-run_"]').count(), 6)
  assert.equal(await page.getByTestId('node-adopt').count(), 0)
  assert.equal(sourceDigest(source), before)
})

test('ordinary natural collaboration keeps three independent candidates and forwards raw attachments to real first runs', { timeout: 120_000 }, async () => {
  await chooseNaturalSource(page, source)
  await page.setInputFiles('[data-testid="attach-input"]', { name: 'evidence.md', mimeType: 'text/markdown', buffer: Buffer.from('raw experimental material\nno assigned positions\n') })
  await page.waitForSelector('[data-testid="composer-image"].is-ready')
  const sid = await startNaturalTask(page, info.natural_sentences.independent)
  const ix = await naturalInteraction(page, sid, 'done')
  assert.equal(ix.template, 'independent')
  assert.equal(ix.then, 'stop')
  await assertNaturalRuns(page, ix, { waves: 1, attachments: 1, source, thinking: null })
  assert.equal(await page.getByTestId('composer-image').count(), 0)
  assert.equal(ix.events.filter((e) => e.kind === 'adopted').length, 0)
})

test('slow natural battle keeps the chosen director and explicit note queue, pauses/continues without duplicating the first wave', { timeout: 120_000 }, async () => {
  await chooseNaturalSource(page, source)
  const sid = await startNaturalTask(page, info.natural_sentences.slow)
  const started = await naturalInteraction(page, sid, 'running')
  await eventually(() => pageApi<NaturalInteraction>(page, `/api/interactions/${started.id}`), (ix) => ix.nodes.some((n) => n.wave === 1 && n.status === 'done') && ix.nodes.some((n) => n.wave === 1 && n.status === 'running'), 'one completed first node and another real active node')
  await page.getByTestId('interaction-pause').click()
  const paused = await naturalInteraction(page, sid, 'waiting')
  const finishedFirst = paused.nodes.filter((n) => n.status === 'done').flatMap((n) => n.run_ids)
  assert.ok(finishedFirst.length > 0)
  await reloadNatural(sid)
  await page.getByTestId('interaction-continue').click()
  await eventually(() => pageApi<NaturalInteraction>(page, `/api/interactions/${started.id}`), (ix) => ix.status === 'running', 'continued interaction')
  assert.equal(await page.getByTestId('director-chip').count(), 1)
  assert.match(await page.getByTestId('to-chip').innerText(), /director/)
  // A normal message still goes to the director. A second message explicitly chooses the participant queue.
  await page.fill('[data-testid="composer"]', NATURAL_WORDS.followup)
  const routed = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/director/messages'))
  await page.getByTestId('send').click(); assert.ok((await routed).ok())
  await page.getByTestId('to-chip').click(); await page.getByTestId('to-option-everyone').click()
  await page.fill('[data-testid="composer"]', '原始补充材料：保留所有失败结果。')
  const queued = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/interactions/${started.id}/notes`))
  await page.getByTestId('send').click(); assert.ok((await queued).ok())
  const completed = await naturalInteraction(page, sid, 'done')
  for (const id of finishedFirst) assert.equal(completed.nodes.flatMap((n) => n.run_ids).filter((r) => r === id).length, 1)
  assert.equal(completed.runs_started, 6)
  assert.ok(completed.notes.length >= 1)
  assert.equal(completed.notes.at(-1)!.text, '原始补充材料：保留所有失败结果。')
  assert.ok(['delivered', 'partly', 'undelivered'].includes(completed.notes.at(-1)!.status))
  // the person's words to the group: the app's MemberWords (shared with the session share's copy) — "you → everyone",
  // the words, and where they stand, as the record says
  const note = completed.notes.at(-1)!
  const words = page.locator('[data-testid="interaction-note"]').filter({ hasText: note.text })
  await words.first().waitFor()
  assert.equal(await words.count(), 1)
  // the label's own words (textContent): .turn-who is drawn in capitals by CSS (text-transform), which innerText reports
  assert.equal((await words.locator('.turn-who').textContent())?.trim(), 'you → everyone')
  await eventually(() => words.getAttribute('data-note-status'), (s) => s === note.status, 'the note line says the record\'s status')
  assert.equal(await words.locator('.member-words-state').count(), note.status === 'delivered' ? 0 : 1)
  // the share's snapshot of this quiescent session carries the words once, as a group note with that state, and never
  // the app's internal note that carried them into a run
  type Snap = { snapshot: { version: number; items: { kind: string; text?: string; to?: string | null; status?: string }[] } }
  const snap = await eventually(() => pageApi<Snap>(page, `/api/sessions/${sid}/share-snapshot`, {}).catch(() => null), (s) => s !== null, 'a quiescent session to share')
  assert.equal(snap!.snapshot.version, 2)
  const shared = snap!.snapshot.items.filter((i) => i.kind === 'group_note' && i.text === note.text)
  assert.deepEqual(shared.map((i) => [i.to, i.status]), [[null, note.status]])
  assert.equal(snap!.snapshot.items.filter((i) => i.kind === 'message' && (i.text ?? '').includes(note.text)).length, 0, 'the internal note steer is not a message of the share')
  assert.ok(!JSON.stringify(snap!.snapshot).includes('App note:'))
})

test('stop a natural group, reload and do not restart it; completed partial records remain visible', { timeout: 90_000 }, async () => {
  await chooseNaturalSource(page, source)
  const sid = await startNaturalTask(page, info.natural_sentences.slow)
  const ix = await naturalInteraction(page, sid, 'running')
  // the agents board draws the group's runs: while a step works, the playhead stands at now
  await page.getByTestId('agents-relations').getByTestId('rg-now').waitFor({ state: 'attached', timeout: 15_000 })
  await page.getByTestId('interaction-stop').click()
  const stopped = await naturalInteraction(page, sid, 'cancelled')
  const ids = stopped.nodes.flatMap((n) => n.run_ids)
  await reloadNatural(sid)
  const again = await pageApi<NaturalInteraction>(page, `/api/interactions/${ix.id}`)
  assert.equal(again.status, 'cancelled')
  assert.deepEqual(again.nodes.flatMap((n) => n.run_ids), ids)
  assert.equal(again.runs_started, stopped.runs_started)
  assert.match(await page.getByTestId('interaction-line').innerText(), /Stopped/)
  // read back from the records: every run that started is a bar on its participant's lane; no strip in its place
  for (const id of ids) await page.getByTestId('agents-relations').getByTestId(`rg-bar-${id}`).waitFor({ state: 'attached', timeout: 10_000 })
  assert.equal(await page.getByTestId('interaction-strip').count(), 0)
  assert.equal(await page.getByTestId('interaction-continue').count(), 0)
})


test('an explicitly chosen xhigh is forwarded to every participant', { timeout: 120_000 }, async () => {
  await chooseNaturalSource(page, source)
  await page.getByTestId('thinking-chip').click()
  await page.getByTestId('thinking-option-xhigh').click()
  const sid = await startNaturalTask(page, info.natural_sentences.battle, 'xhigh')
  await assertNaturalRuns(page, await naturalInteraction(page, sid, 'done'), { waves: 2, source, thinking: 'xhigh' })
})
