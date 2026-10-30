/** The desktop app's ChatGPT page scripts (desktop/chatgpt_dom.js) in real Chrome, against pages served as
 * https://chatgpt.com/ by request interception — nothing leaves the machine: the send button is the composer's own,
 * a signed-in page without a composer is not signed out, and generating is a stop button the person can see. */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright-core'

interface PageScripts { stateScript(): string; sendScript(text: string): string; stopScript(): string; answerScript(): string }
const dom = createRequire(import.meta.url)('../../desktop/chatgpt_dom.js') as PageScripts

let browser: Browser

before(async () => {
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  browser = await chromium.launch(executablePath ? { executablePath, headless: true, args: ['--no-sandbox'] } : { channel: 'chrome', headless: true })
})

after(async () => { await browser?.close() })

/** A page at https://chatgpt.com/ holding `body`, signed in (its session answers an access token). */
async function fixture(body: string): Promise<Page> {
  const page = await browser.newPage()
  await page.route('**/*', (route) => {
    const url = route.request().url()
    if (url.endsWith('/api/auth/session')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accessToken: 'fixture-session' }) })
    if (url.startsWith('https://chatgpt.com/')) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>${body}</body></html>` })
    return route.abort()
  })
  await page.goto('https://chatgpt.com/')
  return page
}
const run = async (page: Page, script: string) => JSON.parse(await page.evaluate(script)) as Record<string, unknown>

const COMPOSER = (extra = '') => `<form id="composer"><textarea id="prompt-textarea"></textarea>${extra}
  <button type="submit" data-testid="send-button" onclick="event.preventDefault(); window.__sent = (window.__sent||[]).concat(document.getElementById('prompt-textarea').value); document.getElementById('prompt-textarea').value=''">Send</button></form>`

test("the words go by the composer's own send button, never another form's", async () => {
  const own = await fixture(COMPOSER())
  const bare = await fixture(`<nav><form id="search" onsubmit="event.preventDefault(); window.__searched = true"><input name="q"><button type="submit">Search chats</button></form></nav>
    <main><form id="composer"><textarea id="prompt-textarea"></textarea></form></main>`)
  try {
    assert.deepEqual(await run(own, dom.sendScript('hello 世界')), { accepted: true })
    assert.deepEqual(await own.evaluate(() => (window as unknown as { __sent: string[] }).__sent), ['hello 世界'])
    const out = await run(bare, dom.sendScript('hi'))
    assert.equal(await bare.evaluate(() => (window as unknown as { __searched?: boolean }).__searched === true), false, `the search form was submitted (${JSON.stringify(out)})`)
  } finally { await own.close(); await bare.close() }
})

test('a signed-in page whose composer is gone is signed in, and a send says no_composer', async () => {
  const page = await fixture('<main><div class="new-editor">type here</div></main>')
  try {
    assert.equal((await run(page, dom.stateScript())).logged_in, true)
    const sent = await run(page, dom.sendScript('hi'))
    assert.equal(sent.accepted, false)
    assert.equal(sent.reason, 'no_composer')
  } finally { await page.close() }
})

test('generating is a stop button the person can see with a stop-generating label, not a hidden one or "Stop dictation"', async () => {
  const hidden = await fixture(COMPOSER('<button type="button" data-testid="stop-button" style="display:none">stop</button>'))
  const dictation = await fixture(COMPOSER('<button type="button" aria-label="Stop dictation">mic</button>'))
  const shown = await fixture(COMPOSER('<button type="button" aria-label="停止">stop</button>'))
  try {
    for (const page of [hidden, dictation]) {
      assert.equal((await run(page, dom.stateScript())).generating, false)
      assert.equal((await run(page, dom.answerScript())).generating, false)
      assert.deepEqual(await run(page, dom.stopScript()), { clicked: false })
    }
    assert.deepEqual(await run(dictation, dom.sendScript('hi')), { accepted: true })
    assert.equal((await run(shown, dom.stateScript())).generating, true)
    assert.equal((await run(shown, dom.sendScript('hi'))).reason, 'generating')
  } finally { await hidden.close(); await dictation.close(); await shown.close() }
})
