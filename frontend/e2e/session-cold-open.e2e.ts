/** Stored-session scheduling/layout regression. Synthetic HTTP responses, the real production build and headless
 * Chrome; no real database, app, model or remote host. Run serially, after build, on an unoccupied 8399. */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { chromium, type Browser, type Page } from 'playwright-core'
import { ProjectSchema, RunSchema, SessionSchema, SessionDetailSchema, RunTreeRowSchema, SESSION_STREAM_READY } from '@oasis-code/contract'
import { startStub, type Stub } from './session-streams-stub.ts'

const PORT = Number(process.env.OASIS_CODE_E2E_PORT ?? 8399)
const BASE = `http://127.0.0.1:${PORT}`
const NOW = '2026-10-31T00:00:00.000Z'
const COUNT = 80
// A generated opaque 900×600 PNG; no fixture download or external image service.
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  const size = Buffer.alloc(4), end = Buffer.alloc(4); size.writeUInt32BE(data.length); end.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([size, body, end])
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(900, 0); ihdr.writeUInt32BE(600, 4); ihdr[8] = 8; ihdr[9] = 2
const pixels = Buffer.alloc((900 * 3 + 1) * 600, 150)
for (let row = 0; row < 600; row++) pixels[row * (900 * 3 + 1)] = 0
const picture = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))])
const ids = ['s_cold_a', 's_cold_b', 's_empty', 's_cold_images']
const imageRequests: number[] = []
const sessions = ids.map(id => SessionSchema.parse({ id, project_id: 'p_cold', title: id, workspace_id: null, model: 'scripted:a', created_at: NOW, updated_at: NOW }))
const runs = (sid: string) => sid === 's_empty' ? [] : sid === 's_cold_images'
  ? [RunSchema.parse({ id: 's_cold_images_0', session_id: sid, project_id: 'p_cold', workspace_id: null, model: 'scripted:a', user_text: 'All eighty pictures in one stored turn', status: 'done', created_at: NOW })]
  : Array.from({ length: COUNT }, (_, i) => ({
  ...RunSchema.parse({ id: `${sid}_${i}`, session_id: sid, project_id: 'p_cold', workspace_id: null, model: 'scripted:a', user_text: `${sid} question ${i}`, status: sid === 's_cold_b' && i === COUNT - 1 ? 'error' : 'done', error: sid === 's_cold_b' && i === COUNT - 1 ? 'synthetic failure detail\n'.repeat(200) : null, created_at: NOW }),
  ...(i === 0 ? { collab: { participant_id: 'pa_fixture', participant_role: 'member', conversation_id: 'cv_fixture', origin: { actor: 'person', request: 'message' }, placement: { surface: 'thread' }, basis: 'recorded' } } : {}),
  ...(i === COUNT - 1 ? { attachments: [{ asset_id: 'late_image', name: 'synthetic.png', media_type: 'image/png', width: 900, height: 600, bytes: picture.length, sha256: 'synthetic' }] } : {}),
}))
let stub: Stub, browser: Browser, page: Page
let releaseImage: () => void = () => {}
const imageReady = new Promise<void>(r => { releaseImage = r })
const errors: string[] = []
const frame = () => page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
const gap = () => page.getByTestId('thread').evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)

before(async () => {
  stub = await startStub(PORT, resolve(process.env.OASIS_CODE_E2E_DIST ?? 'dist'))
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] })
  page = await context.newPage()
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(() => {
    const violations: unknown[] = []
    Object.assign(window, { __coldViolations: violations })
    addEventListener('DOMContentLoaded', () => new MutationObserver(() => {
      const thread = document.querySelector('.thread-scroll')
      const active = document.querySelector('[data-testid^="session-s_cold_"].active')?.getAttribute('data-testid')?.slice(8)
      if (!thread || !active || active === 's_cold_images') return
      const turns = [...thread.querySelectorAll(':scope > [data-testid^="run-s_cold_"]')]
      if (turns.length !== 0 && turns.length !== 80) violations.push({ kind: 'partial', count: turns.length })
      if (turns.some(e => !e.getAttribute('data-testid')?.startsWith(`run-${active}_`))) violations.push({ kind: 'stale-session' })
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] }))
  })
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/api/projects') return json([{ ...ProjectSchema.parse({ id: 'p_cold', name: 'cold fixture', kind: 'direct', source_path: '/synthetic', base_repo_path: '/synthetic', base_commit: null, base_branch: null, created_at: NOW, updated_at: NOW }), sessions }])
    const session = sessions.find(s => path === `/api/sessions/${s.id}`)
    if (session) return json(SessionDetailSchema.parse({ ...session, runs: runs(session.id), workspace: null, event_cursor: 0, run_count: runs(session.id).length, director_notes: [], active_run: null, active_children: [], pending_approvals: [] }))
    if (path === '/api/runs/s_cold_images_0/transcript') return json({ run_id: 's_cold_images_0', status: 'done', model: 'scripted:a', steers: [], entries: [
      ...Array.from({ length: COUNT }, (_, i) => ({ kind: 'activity', tool: 'read_file', toolCallId: `picture_call_${i}`, args: { path: `picture-${i}.png` },
        result: { status: 'ok', kind: 'image', shown: [{ asset_id: `picture_${i}`, width: 900, height: 600, label: `picture ${i}` }] } })),
      { kind: 'agent', text: 'All eighty pictures remain available.' },
    ] })
    const requestedPicture = /\/attachments\/picture_(\d+)$/.exec(path)
    if (requestedPicture) {
      imageRequests.push(Number(requestedPicture[1]))
      return route.fulfill({ status: 200, contentType: 'image/png', body: picture })
    }
    const transcript = /^\/api\/runs\/(s_cold_[ab])_(\d+)\/transcript$/.exec(path)
    if (transcript) {
      const [, sid, index] = transcript
      return json({ run_id: `${sid}_${index}`, status: sid === 's_cold_b' && Number(index) === COUNT - 1 ? 'error' : 'done', model: 'scripted:a', steers: [], entries: [
        { kind: 'activity', tool: 'read_file', toolCallId: `call_${sid}_${index}`, summary: 'synthetic.txt', args: { path: 'synthetic.txt' }, result: { status: 'ok', content: 'complete synthetic tool result' } },
        { kind: 'agent', text: `## ${sid} answer ${index}\n\n${'Unabridged fixture paragraph with **bold** and a [link](https://example.invalid). '.repeat(12)}\n\n\`\`\`ts\nconst answer = ${index};\n\`\`\`\n\nfind_${sid}_${index}_unique${Number(index) === COUNT - 1 ? `\n\n![growing image](/api/sessions/${sid}/attachments/late_image)` : ''}` },
      ] })
    }
    if (path.includes('/attachments/late_image')) {
      await imageReady
      return route.fulfill({ status: 200, contentType: 'image/png', body: picture })
    }
    if (path.endsWith('/runs/tree')) return json({ runs: runs(path.split('/')[3]!).map(r => RunTreeRowSchema.parse({ ...r, live: false, user_text_head: r.user_text, receipt: null, usage: {}, depth: 0 })) })
    if (path.endsWith('/events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: ${SESSION_STREAM_READY}\ndata: {"cursor":0,"live_runs":[]}\n\n` })
    return route.continue()
  })
})
after(async () => { releaseImage(); await browser?.close(); await stub?.close() })

test('complete commits, no stale session, follow/scroll/find/selection/copy/folds, delayed attachment', async () => {
  await page.goto(BASE)
  await page.getByTestId(`session-${ids[0]}`).click()
  await page.waitForFunction(n => document.querySelectorAll('.thread-scroll > [data-testid^="run-s_cold_"]').length === n, COUNT)
  await frame()
  assert.ok(await gap() < 2, 'cold opening follows the true bottom')
  const beforeImage = (await page.getByTestId(`run-${ids[0]}_${COUNT - 1}`).boundingBox())!.height
  releaseImage()
  await page.waitForFunction(() => [...document.images].some(i => i.classList.contains('prose-img') && i.src.includes('late_image') && i.complete && i.naturalWidth > 0))
  await page.waitForTimeout(250)
  assert.ok((await page.getByTestId(`run-${ids[0]}_${COUNT - 1}`).boundingBox())!.height > beforeImage + 100, 'the delayed prose image really increased layout height')
  assert.ok(await gap() < 2, 'a delayed attachment cannot unpin follow')
  assert.equal(await page.getByTestId('jump-bottom').count(), 0)

  // The real outline action calls focusTurn; do not scroll the destination with a test-side helper.
  if (!(await page.getByTestId('graph-dock').count())) {
    await page.getByTestId('desk-shelf').click()
    await page.locator('.desk-tail-list .desk-chip[title="Agent Teams"]').click()
  }
  await page.getByTestId(`ol-${ids[0]}_0`).click({ timeout: 5000 })
  await page.waitForTimeout(1800)
  const oldBox = await page.getByTestId(`run-${ids[0]}_0`).boundingBox()
  const viewport = await page.getByTestId('thread').boundingBox()
  assert.ok(oldBox && viewport && oldBox.y >= viewport.y - 16 && oldBox.y < viewport.y + viewport.height, JSON.stringify({ oldBox, viewport, gap: await gap(), jump: await page.getByTestId('jump-bottom').count() }))
  // The outline also raises a card; put floating cards away using their real controls before reading underneath.
  while (await page.locator('[data-testid="card-shelve"]:visible').count()) await page.locator('[data-testid="card-shelve"]:visible').first().click()
  // Compare only the focus line's local glow, contained vs uncontained; never capture a screen or full page.
  const firstTurn = page.getByTestId(`run-${ids[0]}_0`)
  const glow = await firstTurn.locator('.agent-span').evaluate(el => {
    el.classList.remove('flash'); void (el as HTMLElement).offsetWidth; el.classList.add('flash')
    for (const a of el.getAnimations({ subtree: true })) { a.pause(); a.currentTime = 300 }
    const r = el.getBoundingClientRect(); return { x: Math.floor(r.left - 16), y: Math.floor(r.top), width: 28, height: 60 }
  })
  const contained = await page.screenshot({ clip: glow })
  await firstTurn.evaluate(e => e.style.contentVisibility = 'visible')
  const uncontained = await page.screenshot({ clip: glow })
  assert.deepEqual(contained, uncontained, 'paint containment preserves the focus line’s outer glow')
  await firstTurn.evaluate(e => e.style.contentVisibility = '')
  await page.getByTestId(`run-${ids[0]}_0`).locator('.work-head').click()
  assert.equal(await page.getByTestId(`run-${ids[0]}_0`).locator('.work-head').getAttribute('aria-expanded'), 'true')
  await page.getByTestId('composer').fill('draft remains responsive')
  await page.waitForTimeout(200)
  assert.equal(await page.getByTestId(`run-${ids[0]}_0`).locator('.work-head').getAttribute('aria-expanded'), 'true', 'a composer change keeps local open state')
  await page.getByTestId(`run-${ids[0]}_0`).getByTestId('code-copy').click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'const answer = 0;')

  const search = await page.evaluate(needle => {
    document.querySelector('.thread-scroll')!.scrollTop = 0
    getSelection()?.removeAllRanges()
    return (window as unknown as { find: (text: string, caseSensitive: boolean, backwards: boolean, wrap: boolean) => boolean }).find(needle, false, false, true)
  }, `find_${ids[0]}_40_unique`)
  assert.equal(search, true, 'native browser find reaches an unvisited middle turn')
  await frame()
  assert.equal(await page.evaluate(() => getSelection()?.toString()), `find_${ids[0]}_40_unique`)
  await page.waitForFunction(() => {
    const selection = getSelection()!, r = selection.getRangeAt(0).getBoundingClientRect(), view = document.querySelector('.thread-scroll')!.getBoundingClientRect()
    const dock = document.querySelector('.composer-dock')!.getBoundingClientRect()
    return r.top >= view.top && r.bottom <= dock.top
  }, {}, { timeout: 1500 })
  const selection = await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('.thread-scroll')!)
    const s = getSelection()!; s.removeAllRanges(); s.addRange(range)
    const text = s.toString(); s.removeAllRanges(); return text
  })
  for (let i = 0; i < COUNT; i++) assert.ok(selection.includes(`find_${ids[0]}_${i}_unique`), `selection includes turn ${i}`)
  await page.getByTestId('jump-bottom').click()
  await page.waitForTimeout(300)
  assert.ok(await gap() < 2)
  const box = await page.getByTestId('thread').boundingBox()
  await page.mouse.move(box!.x + 200, box!.y + 100)
  await page.mouse.wheel(0, -400)
  await page.waitForTimeout(300)
  assert.ok(await gap() > 48, 'wheel really moved away from the bottom')
  assert.equal(await page.getByTestId('jump-bottom').count(), 1, 'wheel unpinned follow')
  const before = await page.getByTestId('thread').evaluate(e => e.scrollTop)
  await page.waitForTimeout(250)
  assert.ok(Math.abs(await page.getByTestId('thread').evaluate(e => e.scrollTop) - before) < 2, 'manual reading is not pulled back')

  await page.getByTestId(`session-${ids[1]}`).click()
  await page.waitForSelector(`[data-testid="run-${ids[1]}_${COUNT - 1}"]`)
  await frame()
  assert.ok(await gap() < 2, 'A scrolled up → B opens at its bottom, not at A’s held position')
  assert.equal(await page.locator(`[data-testid^="run-${ids[0]}_"]`).count(), 0)
  assert.deepEqual(await page.evaluate(() => (window as unknown as { __coldViolations: unknown[] }).__coldViolations), [])
  assert.deepEqual(errors, [])
})


test('Records → Back preserves following/held mode; an empty session never shows the old rows', async () => {
  await page.getByTestId(`session-${ids[1]}`).click()
  await page.waitForSelector(`[data-testid="run-${ids[1]}_${COUNT - 1}"]`)
  if (await page.getByTestId('jump-bottom').count()) await page.getByTestId('jump-bottom').click()
  await frame()
  await page.getByTestId(`records-${ids[1]}_${COUNT - 1}`).click()
  await page.getByTestId('records-back').click()
  await page.waitForSelector(`[data-testid="run-${ids[1]}_${COUNT - 1}"]`)
  await frame()
  assert.ok(await gap() < 2, 'Back while following returns to bottom')
  await page.getByTestId('thread').evaluate(e => e.scrollTo({ top: 0, behavior: 'instant' }))
  await frame()
  assert.equal(await page.getByTestId('jump-bottom').count(), 1)
  await page.getByTestId(`records-${ids[1]}_0`).click()
  await page.getByTestId('records-back').click()
  await page.waitForSelector(`[data-testid="run-${ids[1]}_0"]`)
  await frame()
  assert.ok(await gap() > 48, 'Back while reading does not force follow')
  await page.getByTestId(`session-${ids[2]}`).click()
  await page.waitForSelector('.thread-empty')
  assert.equal(await page.locator('.thread-scroll > [data-testid^="run-"]').count(), 0)
})


test('manual persistent selection is not recentered; inner log scrolling leaves outer follow alone; PageUp wins over growth', async () => {
  await page.getByTestId(`session-${ids[1]}`).click()
  await page.waitForSelector(`[data-testid="run-${ids[1]}_${COUNT - 1}"]`)
  await frame()
  while (await page.locator('[data-testid="card-shelve"]:visible').count()) await page.locator('[data-testid="card-shelve"]:visible').first().click()
  const last = page.getByTestId(`run-${ids[1]}_${COUNT - 1}`)
  await last.locator('.run-failure summary').click()
  if (await page.getByTestId('jump-bottom').count()) await page.getByTestId('jump-bottom').click()
  await frame()
  const log = last.locator('.run-failure pre.detail')
  await log.evaluate(e => { e.scrollTop = e.scrollHeight })
  const innerBefore = await log.evaluate(e => e.scrollTop)
  assert.ok(innerBefore > 100)
  const outerBefore = await page.getByTestId('thread').evaluate(e => e.scrollTop)
  const box = (await log.boundingBox())!
  await page.mouse.move(box.x + 30, box.y + 30); await page.mouse.wheel(0, -100); await page.waitForTimeout(150)
  assert.ok(await log.evaluate(e => e.scrollTop) < innerBefore)
  assert.ok(Math.abs(await page.getByTestId('thread').evaluate(e => e.scrollTop) - outerBefore) < 2)
  assert.equal(await page.getByTestId('jump-bottom').count(), 0, 'an inner log wheel did not cancel outer follow')

  // The native PageUp default action and a controlled content height increase occur in one key event.
  await last.locator('.run-failure summary').focus()
  assert.equal(await page.getByTestId('jump-bottom').count(), 0)
  await page.getByTestId('thread').evaluate(e => {
    e.addEventListener('keydown', () => { const growth = document.createElement('div'); growth.style.height = '240px'; growth.style.flexShrink = '0'; e.append(growth) }, { once: true })
  })
  const beforePage = await page.getByTestId('thread').evaluate(e => e.scrollTop)
  await page.keyboard.press('PageUp'); await page.waitForTimeout(250)
  assert.ok(await page.getByTestId('thread').evaluate(e => e.scrollTop) < beforePage)
  assert.equal(await page.getByTestId('jump-bottom').count(), 1, 'non-wheel upward scrolling wins over same-frame growth')
  const held = await page.getByTestId('thread').evaluate(e => e.scrollTop)
  await page.getByTestId('thread').evaluate(e => { const growth = document.createElement('div'); growth.style.height = '180px'; growth.style.flexShrink = '0'; e.append(growth) })
  await frame()
  assert.ok(Math.abs(await page.getByTestId('thread').evaluate(e => e.scrollTop) - held) < 2, 'growth below a held view keeps its position')
  await page.keyboard.press('End'); await page.waitForTimeout(250)
  assert.ok(await gap() < 2)
  assert.equal(await page.getByTestId('jump-bottom').count(), 0, 'one End after growth restores follow')

  await page.getByTestId('thread').evaluate(e => e.scrollTo({ top: 0, behavior: 'instant' }))
  await frame()
  const paragraph = page.getByTestId(`run-${ids[1]}_0`).locator('.turn-text.prose p').first()
  const p = (await paragraph.boundingBox())!
  await page.getByTestId('thread').evaluate(e => {
    const property = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!
    Object.assign(window, { __manualScrollWrites: [] })
    Object.defineProperty(e, 'scrollTop', { configurable: true, get() { return property.get!.call(this) }, set(value) { (window as unknown as { __manualScrollWrites: number[] }).__manualScrollWrites.push(value); property.set!.call(this, value) } })
  })
  await page.mouse.move(p.x + 5, p.y + 8); await page.mouse.down()
  await page.mouse.move(p.x + 180, p.y + 40, { steps: 8 }); await page.mouse.wheel(0, 180)
  await page.waitForTimeout(120); await page.mouse.up(); await page.waitForTimeout(150)
  const selected = await page.evaluate(() => getSelection()?.toString() ?? '')
  assert.ok(selected.length > 10, 'real mouse selection persists after pointerup')
  assert.deepEqual(await page.evaluate(() => (window as unknown as { __manualScrollWrites: number[] }).__manualScrollWrites), [], 'no app recentering during a manual drag')
  await page.keyboard.press('Meta+C')
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), selected)
  await page.getByTestId('thread').evaluate(e => { delete (e as unknown as { scrollTop?: number }).scrollTop })

  // A persistent cross-turn drag too, through the actual browser selection/copy path.
  await page.getByTestId('thread').evaluate(e => { getSelection()?.removeAllRanges(); e.scrollTop = 0 })
  await frame()
  const start = (await page.getByTestId(`run-${ids[1]}_0`).locator('.turn-text.prose p').last().boundingBox())!
  const end = (await page.getByTestId(`run-${ids[1]}_1`).locator('.turn-user .turn-text').boundingBox())!
  await page.mouse.move(start.x + 2, start.y + 8); await page.mouse.down(); await page.mouse.move(end.x + end.width - 2, end.y + 8, { steps: 12 }); await page.mouse.up()
  await page.waitForTimeout(150)
  const cross = await page.evaluate(() => getSelection()?.toString() ?? '')
  assert.ok(cross.includes(`find_${ids[1]}_0_unique`))
  assert.ok(cross.includes('question'))
  await page.keyboard.press('Meta+C'); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), cross)
})


test('one large ended turn is at the bottom on its first content frame, without fetching the head pictures', async () => {
  await page.goto(BASE)
  await page.evaluate(() => {
    const state = { first: null as null | { top: number; height: number; client: number; images: number } }
    Object.assign(window, { __imageOpening: state })
    const observer = new MutationObserver(() => {
      const thread = document.querySelector<HTMLElement>('.thread-scroll[data-session-id="s_cold_images"]')
      if (!thread?.querySelector('[data-testid="run-s_cold_images_0"]')) return
      observer.disconnect()
      requestAnimationFrame(() => requestAnimationFrame(() => {
        state.first = { top: thread.scrollTop, height: thread.scrollHeight, client: thread.clientHeight, images: thread.querySelectorAll('.shown-image img').length }
      }))
    })
    observer.observe(document.body, { childList: true, subtree: true })
  })
  await page.getByTestId('session-s_cold_images').click()
  await page.waitForFunction(() => (window as unknown as { __imageOpening: { first: unknown } }).__imageOpening.first !== null)
  const first = await page.evaluate(() => (window as unknown as { __imageOpening: { first: { top: number; height: number; client: number; images: number } } }).__imageOpening.first)
  assert.equal(first.images, COUNT, 'every picture is mounted in the first full commit')
  assert.ok(first.height > first.client * 5, 'the fixture is a single genuinely tall turn')
  assert.ok(first.height - first.client - first.top < 2, `first content frame is at bottom: ${JSON.stringify(first)}`)
  await page.waitForFunction(() => (document.querySelector<HTMLImageElement>('.shown-image img[src*="picture_79"]')?.naturalWidth ?? 0) > 0)
  assert.ok(imageRequests.includes(COUNT - 1), 'the last picture actually loaded')
  assert.ok(imageRequests.every(i => i >= COUNT / 2), `no wasted head requests before reading there: ${imageRequests}`)
  const firstPicture = page.locator('.shown-image').first()
  await firstPicture.scrollIntoViewIfNeeded()
  await page.waitForFunction(() => (document.querySelector<HTMLImageElement>('.shown-image img[src*="picture_0"]')?.naturalWidth ?? 0) > 0)
  assert.ok(imageRequests.includes(0), 'the full first picture remains reachable and loads when visited')
  await firstPicture.click()
  await page.getByTestId('media-viewer').waitFor()
  await page.keyboard.press('Escape')
  assert.deepEqual(errors, [])
})
