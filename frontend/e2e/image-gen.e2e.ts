/** Generated images in the browser (real Chrome, playwright-core) against the scripted backend, whose image backend
 *  is a fake (no subscription is used, nothing leaves the machine): a request draws an image; the call's row shows
 *  it large with its download; the viewer opens it with a download and closes on Escape; the image dragged into the
 *  composer joins the next message by its id with no upload, and the model edits it.
 *
 *  Needs, from backend-ts/scripts/e2e_server.ts (evidence/frontend-contract.md §3): the `scripted:img` route — it
 *  reads the conversation itself, not a script counted from the start: a last message without an image draws, one
 *  with an image edits (recent_images: 1) — and `GET /api/__e2e/image-requests`, what its fake image backend was asked.
 *  Port 8399 is shared by every e2e: this file refuses to start when something already listens there. */

import { bypassDirector } from './agent-entry.ts'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type Page, type Request } from 'playwright-core'

const PORT = 8399
const BASE = `http://127.0.0.1:${PORT}`
let server: ChildProcess
let info: { token: string }
let browser: Browser
let page: Page

/** Whether something already answers on the port (another e2e under way): never taken over. */
const listening = (port: number) => new Promise<boolean>((resolve) => {
  const socket = createConnection({ host: '127.0.0.1', port })
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('error', () => resolve(false))
})

before(async () => {
  if (await listening(PORT)) throw new Error(`port ${PORT} is in use (another e2e?); wait for it to end`)
  server = spawn('bun', ['run', 'scripts/e2e_server.ts', String(PORT)], { cwd: `${process.cwd()}/../backend-ts`, stdio: ['ignore', 'pipe', 'pipe'] })
  info = await new Promise((resolve, reject) => {
    let buf = ''
    server.stdout!.on('data', (d) => { buf += String(d); const line = buf.split('\n')[0]; if (line.trim().startsWith('{')) resolve(JSON.parse(line)) })
    server.stderr!.on('data', (d) => { if (/Traceback|^error:/m.test(String(d))) reject(new Error(String(d))) })
    server.on('exit', (code) => reject(new Error(`e2e server exited ${code}`)))
  })
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/api/meta/build`); if (r.ok) break } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  browser = await chromium.launch(executablePath ? { executablePath, headless: true, args: ['--no-sandbox'] } : { channel: 'chrome', headless: true })
  page = await browser.newPage()
  page.on('pageerror', (e) => { throw e })
})

after(async () => {
  await browser?.close()
  server?.kill('SIGTERM')
})

async function pickModel(id: string) {
  await bypassDirector(page)
  await page.click('[data-testid="model-picker"]')
  const label = (await page.locator(`[data-testid="model-option-${id}"] .picker-label`).innerText()).trim()
  await page.click(`[data-testid="model-option-${id}"]`)
  await page.waitForFunction((want) => (document.querySelector('[data-testid="model-current"]')?.textContent ?? '').trim() === want, label, { timeout: 5_000 })
}

/** What the fake image backend was asked, in order. */
async function imageRequests(): Promise<{ kind: string; prompt: string; reference_sha256: string[] }[]> {
  const r = await page.request.get(`${BASE}/api/__e2e/image-requests`)
  assert.ok(r.ok(), `GET /api/__e2e/image-requests: ${r.status()}`)
  return r.json()
}

test('draw, see it large, download it, open it, drag it back, and have it edited', async () => {
  const posts: Request[] = []
  page.on('request', (r) => { if (r.method() === 'POST') posts.push(r) })
  await page.goto(`${BASE}/?token=${info.token}`)
  await page.waitForSelector('[data-testid="hero"]')
  await pickModel('scripted:img')
  await page.fill('[data-testid="composer"]', 'draw a red square')
  await page.click('[data-testid="send"]')

  // the call's own row, then its image: large, from the session's attachments, with its download
  await page.waitForSelector('[data-tool="generate_image"]', { timeout: 20_000 })
  const first = page.locator('[data-testid="generated-image"]').first()
  await first.waitFor({ timeout: 20_000 })
  const assetId = await first.getAttribute('data-asset-id')
  assert.ok(assetId)
  const src = await first.locator('img').getAttribute('src')
  assert.match(src ?? '', new RegExp(`^/api/sessions/[A-Za-z0-9_-]+/attachments/${assetId}$`))
  const sessionId = (src ?? '').split('/')[3]!
  const link = first.locator('[data-testid="generated-image-download"]')
  assert.ok(await link.getAttribute('download'))
  assert.equal(await link.getAttribute('href'), src)
  assert.equal(await first.locator('img').evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0), true)
  // no progress or preview was ever invented: the row shows only what the harness said
  assert.equal(await page.locator('[data-tool="generate_image"] progress, [data-tool="generate_image"] [role="progressbar"]').count(), 0)
  await page.waitForFunction(() => /IMG_DONE/.test(document.body.textContent ?? ''), null, { timeout: 20_000 })
  assert.equal((await imageRequests()).at(-1)?.kind, 'generate')

  // the viewer: opened by a click, its download beside its close, gone on Escape
  await first.locator('.generated-image-open').click()
  await page.waitForSelector('[data-testid="media-viewer"]')
  assert.equal(await page.locator('[data-testid="media-viewer-download"]').getAttribute('href'), src)
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="media-viewer"]', { state: 'detached' })

  // a drop no drag of this page began (what a sandboxed frame or another window can produce): a hand-made
  // DataTransfer with this session's real ids and a made-up nonce, dropped on the composer with no dragstart first —
  // refused before anything is read
  const reads: string[] = []
  const onRead = (r: Request) => { if (r.resourceType() === 'fetch' && /\/attachments\//.test(r.url())) reads.push(r.url()) }
  page.on('request', onRead)
  await page.evaluate(([sid, aid]) => {
    const target = document.querySelector('[data-testid="thread-composer"]')!
    const data = new DataTransfer()
    data.setData('application/x-oasis-image', JSON.stringify({ session_id: sid, asset_id: aid, nonce: '00000000-0000-4000-8000-000000000000' }))
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
  }, [sessionId, assetId])
  await page.waitForTimeout(500)
  assert.equal(await page.locator('[data-testid="composer-image"]').count(), 0, 'a forged drop adds nothing')
  assert.deepEqual(reads, [], 'a forged drop reads nothing')
  page.off('request', onRead)

  // dragged for real (Chromium's own drag, from the image to the composer): it joins with no upload, and the message
  // names it by its id
  await first.locator('img').dragTo(page.locator('[data-testid="thread-composer"]'))
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="composer-image"]').length === 1, null, { timeout: 10_000 })
  await page.waitForFunction(() => !document.querySelector('[data-testid="composer-image"].is-converting'), null, { timeout: 10_000 })
  const before = posts.length
  await page.fill('[data-testid="composer"]', 'make it blue')
  await page.click('[data-testid="send"]')
  await page.waitForFunction(() => /IMG_EDITED/.test(document.body.textContent ?? ''), null, { timeout: 20_000 })
  const sent = posts.slice(before)
  assert.equal(sent.filter((r) => /\/attachments(\?|$)/.test(new URL(r.url()).pathname + new URL(r.url()).search)).length, 0, 'no upload')
  const chat = sent.find((r) => new URL(r.url()).pathname === `/api/sessions/${sessionId}/chat`)
  assert.ok(chat, 'the message was sent to the session')
  assert.deepEqual((chat!.postDataJSON() as { attachments?: string[] }).attachments, [assetId])

  // the model edited it: a second image, and the fake backend was asked an edit
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="generated-image"]').length >= 2, null, { timeout: 20_000 })
  assert.equal((await imageRequests()).at(-1)?.kind, 'edit')
})
