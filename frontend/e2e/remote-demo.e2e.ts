/** The Remote access card's Connect ChatGPT walkthrough in real Chrome against the e2e backend (port 8399). The
 *  desktop shell is a fake bridge (page.addInitScript): its status says remote access is on with an address, and every
 *  call is recorded — the walkthrough must call none and must never show that address. No model is called (no run is
 *  started), so the e2e server's scripted counters are untouched.
 *
 *  OASIS_CODE_E2E_SHOTS=<folder>: also saves each step's picture for the four themes (light/dark × motion/reduced)
 *  and a few frames of playback there. */

import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright-core'

const PORT = 8399
const BASE = `http://127.0.0.1:${PORT}`
const SECRET = 'S'.repeat(43)
const REAL_URL = `https://e2e-real-host.trycloudflare.com/${SECRET}/mcp/current`
const SHOTS = process.env.OASIS_CODE_E2E_SHOTS || null
const SCENES = ['oasis', 'plugins', 'server', 'risk', 'install', 'work']
let server: ChildProcess
let browser: Browser

before(async () => {
  server = spawn('bun', ['run', 'scripts/e2e_server.ts', String(PORT)], { cwd: `${process.cwd()}/../backend-ts`, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((resolve, reject) => {
    let buf = ''
    server.stdout!.on('data', (d) => { buf += String(d); if (buf.split('\n')[0]!.trim().startsWith('{')) resolve() })
    server.on('exit', (code) => reject(new Error(`e2e server exited ${code}`)))
  })
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/api/meta/build`)).ok) break } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 100)) }
  // which UI is under test: the dist the server serves and its build id (in the log, for the record)
  const meta = await (await fetch(`${BASE}/api/meta/build`)).json() as { ui_build?: string }
  console.log(`[remote-demo e2e] OASIS_CODE_FRONTEND_DIST=${process.env.OASIS_CODE_FRONTEND_DIST ?? '(unset: the repository\'s frontend/dist)'} ui_build=${meta.ui_build}`)
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  browser = await chromium.launch(executablePath ? { executablePath, headless: true, args: ['--no-sandbox'] } : { channel: 'chrome', headless: true })
})

after(async () => {
  await browser?.close()
  // the server this file started, and only it: its PID is still that command (ps) before it is stopped
  const pid = server?.pid
  if (pid && server.exitCode === null) {
    let command = ''
    try { command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim() } catch { /* gone */ }
    if (command.includes('scripts/e2e_server.ts') && command.includes(String(PORT))) server.kill('SIGTERM')
    else if (command) console.log(`[remote-demo e2e] PID ${pid} is not this file's server any more (${command}): left alone`)
  }
})

/** A page with the fake shell (remote access on, with an address, or off) and Settings open at Connections. The
 *  theme follows the emulated system scheme (the Appearance choice System), so a colorScheme here is the one drawn. */
async function openConnections(opts: { on?: boolean; colorScheme?: 'light' | 'dark'; reducedMotion?: 'reduce' | 'no-preference' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: opts.colorScheme ?? 'light', reducedMotion: opts.reducedMotion ?? 'no-preference' })
  const errors: Error[] = []
  page.on('pageerror', (e) => errors.push(e))
  const demoChunks: string[] = []
  page.on('request', (r) => { if (/RemoteAccessDemo-[^/]*\.(js|css)$/.test(r.url())) demoChunks.push(r.url()) })
  const on = opts.on !== false
  await page.addInitScript(({ on, url }) => {
    const calls: string[] = []
    const status = { state: on ? 'connected' : 'off', enabled: on, keep_awake: true, provider: 'quick', host: on ? 'e2e-real-host.trycloudflare.com' : null, url: on ? url : null, error: null, token_set: null, gateway_origin: 'http://127.0.0.1:18499' }
    const record = (name: string) => async () => { calls.push(name); return status }
    Object.assign(window, { qaRemoteCalls: calls, oasisCodeDesktop: { platform: 'darwin', remoteStatus: async () => { calls.push('status'); return status }, setRemote: record('set'), configureRemote: record('configure'), rotateRemote: record('rotate') } })
    localStorage.setItem('oasis-code.theme', 'system')
  }, { on, url: REAL_URL })
  await page.goto(`${BASE}/api/auth/session?token=e2e-token`)
  await page.waitForSelector('[data-testid="settings"]')
  await page.click('[data-testid="settings"]')
  await page.click('[data-testid="settings-tab-connections"]')
  await page.waitForSelector('[data-testid="remote-access"]')
  await page.locator('[data-testid="remote-access"]').scrollIntoViewIfNeeded()
  return { page, errors, demoChunks }
}

const demoData = (page: Page) => page.locator('[data-testid="remote-demo"]').evaluate((el) => ({ ...(el as HTMLElement).dataset }))
const shellCalls = (page: Page) => page.evaluate(() => (window as unknown as { qaRemoteCalls: string[] }).qaRemoteCalls.filter((c) => c !== 'status'))
async function openDemo(page: Page) {
  assert.equal(await page.locator('[data-testid="remote-demo-open"]').count(), 1, 'the card has its Connect ChatGPT entry')
  await page.click('[data-testid="remote-demo-open"]')
  await page.waitForSelector('[data-testid="remote-demo"]')
}
/** the stage's own animations, as the page has them */
const stageAnimations = (page: Page) => page.locator('[data-testid="remote-demo"]').evaluate((el) =>
  el.getAnimations({ subtree: true }).map((a) => ({ name: (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? 'animation', state: a.playState, time: Number(a.currentTime ?? 0) })))

test('the card has one Connect ChatGPT entry, off or on; Settings opening loads no walkthrough code, a click loads and plays it', async () => {
  for (const on of [false, true]) {
    const { page, errors, demoChunks } = await openConnections({ on })
    await page.waitForSelector('[data-testid="remote-line"]')
    const entry = page.locator('[data-testid="remote-demo-open"]')
    assert.equal(await entry.count(), 1, `one entry (remote access ${on ? 'on' : 'off'})`)
    assert.equal((await entry.textContent())?.trim(), 'Connect ChatGPT')
    assert.equal(await entry.getAttribute('aria-expanded'), 'false')
    await page.waitForTimeout(800)
    assert.equal(await page.locator('[data-testid="remote-demo"]').count(), 0, 'not open by itself')
    assert.deepEqual(demoChunks, [], 'neither its script nor its stylesheet is loaded with the card')
    await openDemo(page)
    assert.deepEqual((demoChunks as string[]).map((u) => u.split('.').pop()).sort(), ['css', 'js'], 'both loaded on the click, once')
    assert.equal(await entry.getAttribute('aria-expanded'), 'true')
    await page.waitForFunction(() => document.querySelector('[data-testid="remote-demo"]')?.getAttribute('data-running') === 'true')
    assert.equal((await demoData(page)).scene, 'oasis')
    assert.deepEqual(errors, [])
    await page.close()
  }
})

test('the walkthrough never shows the real address nor calls the shell; the real card (its address, Copy, Turn off) is as it was', async () => {
  const { page } = await openConnections()
  await page.waitForSelector('[data-testid="remote-url"]')
  await openDemo(page)
  await page.click('[data-testid="demo-play"]')   // paused: a chosen step is drawn finished, its address shown
  for (const dot of [0, 2]) {
    await page.locator('[data-testid="demo-dot"]').nth(dot).click()
    const html = await page.locator('[data-testid="remote-demo"]').innerHTML()
    assert.ok(!html.includes(SECRET) && !html.includes('e2e-real-host'), 'only the placeholder address')
    assert.ok(html.includes('https://demo.invalid/key/mcp/current'), 'the placeholder address')
  }
  assert.equal(await page.locator('[data-testid="remote-url"]').textContent(), REAL_URL)
  assert.equal(await page.locator('[data-testid="remote-toggle"]').textContent(), 'Turn off')
  assert.equal(await page.locator('[data-testid="remote-copy"]').count(), 1)
  assert.deepEqual(await shellCalls(page), [], 'the walkthrough called nothing of the shell')
  await page.close()
})

test("its styles stay its own: opening it changes nothing outside it (the run view's .rd-head/.rd-name), and the app's class rules do not reach into its picture", async () => {
  const { page } = await openConnections()
  // a FIXTURE: the run view's own classes (RunRecords/RunView: .rd-head, .rd-name), put in the page under the app's
  // real stylesheet (index.css) — the Settings dialog shows no run, so the probe stands in for one
  const probe = () => page.evaluate(() => {
    let host = document.getElementById('qa-style-probe')
    if (!host) { host = document.createElement('div'); host.id = 'qa-style-probe'; host.innerHTML = '<div class="rd-head"><span class="rd-name">a long run name that is cut</span></div>'; document.body.append(host) }
    const pick = (el: Element, props: string[]) => Object.fromEntries(props.map((p) => [p, getComputedStyle(el).getPropertyValue(p)]))
    return { head: pick(host.querySelector('.rd-head')!, ['display', 'justify-content', 'margin-bottom', 'position', 'font-size']), name: pick(host.querySelector('.rd-name')!, ['display', 'flex-direction', 'max-width', 'white-space']) }
  })
  const before = await probe()
  await openDemo(page)
  await page.waitForFunction(() => [...document.styleSheets].some((s) => (s.href ?? '').includes('RemoteAccessDemo')))
  assert.deepEqual(await probe(), before, "the app's .rd-head/.rd-name look the same with the walkthrough's styles loaded")
  const leaks = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="remote-demo"]')!
    const stage = root.querySelector('.demo-stage')!
    const out: string[] = []
    /** a selector list split at its own commas (not those inside (), [] or quotes) */
    const topLevelBranches = (list: string) => {
      const parts: string[] = []; let depth = 0; let quote = ''; let cur = ''
      for (const ch of list) {
        if (quote) { if (ch === quote) quote = '' }
        else if (ch === '"' || ch === "'") quote = ch
        else if (ch === '(' || ch === '[') depth += 1
        else if (ch === ')' || ch === ']') depth -= 1
        else if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue }
        cur += ch
      }
      if (cur.trim()) parts.push(cur.trim())
      return parts
    }
    /** a class in the branch itself (outside attribute brackets and quotes) */
    const namesClass = (branch: string) => /\.[A-Za-z_-]/.test(branch.replace(/\[[^\]]*\]|"[^"]*"|'[^']*'/g, ''))
    for (const sheet of [...document.styleSheets]) {
      const ours = (sheet.href ?? '').includes('RemoteAccessDemo')
      const walk = (rules: CSSRuleList) => {
        for (const r of [...rules]) {
          if (r instanceof CSSMediaRule) { walk(r.cssRules); continue }
          if (!(r instanceof CSSStyleRule)) continue
          let hits: Element[] = []
          try { hits = [...document.querySelectorAll(r.selectorText)] } catch { continue }
          if (ours) { for (const h of hits) if (!root.contains(h)) out.push(`ours outside: ${r.selectorText}`); continue }
          // the app's rules: judged per top-level branch of the selector list, and only a branch that names a class
          // counts — a type branch shared by the whole page (index.css `code, pre, .cmd, .path`: the mono font of every
          // <code>) is the page's base look, not one of the app's classes reaching in
          for (const branch of topLevelBranches(r.selectorText)) {
            if (!namesClass(branch)) continue
            let inside: Element[] = []
            try { inside = [...stage.querySelectorAll(branch)] } catch { continue }
            if (inside.length) out.push(`app inside: ${branch} (of "${r.selectorText}")`)
          }
        }
      }
      try { walk(sheet.cssRules) } catch { /* cross-origin */ }
    }
    return [...new Set(out)]
  })
  assert.deepEqual(leaks, [])
  // nothing of the run view's look in the picture: the plugin's name column is not capped at 40%, the head not sticky
  await page.locator('[data-testid="demo-play"]').click()
  await page.locator('[data-testid="demo-dot"]').nth(4).click()
  const inside = await page.locator('[data-testid="remote-demo"]').evaluate((root) => {
    const s = (sel: string) => getComputedStyle(root.querySelector(sel)!)
    return { nameMax: s('.rdemo-name').maxWidth, nameDisplay: s('.rdemo-name').display, headPosition: s('.rdemo-head').position }
  })
  assert.deepEqual(inside, { nameMax: 'none', nameDisplay: 'flex', headPosition: 'static' })
  // closed (its stylesheet stays loaded for the session): the run view's classes are still as they were
  await page.click('[data-testid="demo-close"]')
  await page.waitForSelector('[data-testid="remote-demo"]', { state: 'detached' })
  assert.deepEqual(await probe(), before, 'after closing too')
  await page.close()
})

test('the placeholder address is drawn whole where it is read (step 1 card, step 3 Server URL): nothing clipped, /mcp/current visible', async () => {
  const { page } = await openConnections()
  await openDemo(page)
  await page.click('[data-testid="demo-play"]')   // paused: the steps chosen below are drawn finished
  for (const [dot, selector] of [[0, '.rdemo-url code'], [2, '[data-demo-target="server-url"]']] as const) {
    await page.locator('[data-testid="demo-dot"]').nth(dot).click()
    const box = await page.locator(`[data-testid="remote-demo"] ${selector}`).evaluate((el) => {
      const text = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent!.trim())!
      const range = document.createRange(); range.selectNodeContents(text)
      const r = range.getBoundingClientRect(); const b = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      const inner = b.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth)
      return { text: text.textContent!, scroll: el.scrollWidth, client: el.clientWidth, textRight: r.right, innerRight: inner, ellipsis: cs.textOverflow, fontSize: parseFloat(cs.fontSize) }
    })
    // geometry first: the text's own box ends inside the field, the field does not scroll, nothing is cut off
    assert.ok(box.scroll <= box.client, `step ${dot + 1}: ${selector} does not overflow (${box.scroll} > ${box.client})`)
    assert.ok(box.textRight <= box.innerRight + 0.5, `step ${dot + 1}: the text ends inside the field (${box.textRight} > ${box.innerRight})`)
    assert.ok(box.fontSize >= 9.5, 'readable size')
    assert.match(box.text, /\/mcp\/current$/, `step ${dot + 1}: the path is there`)
    assert.equal(box.text, 'https://demo.invalid/key/mcp/current')
  }
  await page.close()
})

test('it plays the six steps once in order and stops at the end; pause holds it; previous, next, the dots and replay choose', async () => {
  const { page, errors } = await openConnections()
  await openDemo(page)
  await page.locator('[data-testid="remote-demo"]').evaluate((el) => {
    const seen: string[] = [el.getAttribute('data-scene')!]
    ;(window as unknown as { qaScenes: string[] }).qaScenes = seen
    new MutationObserver(() => { const s = el.getAttribute('data-scene')!; if (seen.at(-1) !== s) seen.push(s) }).observe(el, { attributes: true, attributeFilter: ['data-scene'] })
  })
  await page.waitForFunction(() => document.querySelector('[data-testid="remote-demo"]')?.getAttribute('data-status') === 'ended', null, { timeout: 60_000 })
  assert.deepEqual(await page.evaluate(() => (window as unknown as { qaScenes: string[] }).qaScenes), SCENES)
  const end = await demoData(page)
  await page.waitForTimeout(2500)
  assert.deepEqual(await demoData(page), end, 'stopped at the end: no loop')
  assert.equal(await page.locator('[data-testid="demo-play"]').getAttribute('aria-label'), 'Play again')
  assert.equal(await page.locator('[data-testid="demo-dot"][aria-current="step"]').getAttribute('aria-label'), 'Step 6 of 6: New chat → Work → @oasis-code')
  // the finished picture of the last step: Work chosen, @oasis-code in the prompt
  assert.match(await page.locator('[data-testid="remote-demo"] .rdemo-input.is-wide').textContent() ?? '', /@oasis-code/)

  await page.click('[data-testid="demo-replay"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="remote-demo"]')?.getAttribute('data-running') === 'true')
  assert.equal((await demoData(page)).scene, 'oasis')
  await page.click('[data-testid="demo-play"]')   // pause
  const paused = await demoData(page)
  assert.deepEqual([paused.status, paused.running], ['paused', 'false'])
  assert.equal(await page.locator('[data-testid="demo-play"]').getAttribute('aria-label'), 'Play')
  await page.waitForTimeout(1500)
  assert.equal((await demoData(page)).frame, paused.frame, 'paused: the frame stays')
  await page.click('[data-testid="demo-next"]')
  assert.equal((await demoData(page)).scene, 'plugins')
  assert.equal(await page.locator('[data-testid="remote-demo"] .rdemo-menu').count(), 1, "a step chosen while paused is drawn finished (the menu is open)")
  await page.click('[data-testid="demo-prev"]')
  assert.equal((await demoData(page)).scene, 'oasis')
  assert.equal(await page.locator('[data-testid="demo-prev"]').isDisabled(), true)
  await page.locator('[data-testid="demo-dot"]').nth(3).click()
  assert.equal((await demoData(page)).scene, 'risk')
  assert.equal(await page.locator('[data-testid="demo-step"]').textContent(), 'I understand → Create as a plugin')
  assert.deepEqual(errors, [])
  await page.close()
})

test('pause and resume freeze what moves where it is and never play a finished entrance or click again', async () => {
  const { page } = await openConnections()
  await openDemo(page)
  // a click's ripple is moving (the toggle is pressed ~1.05 s in)
  await page.waitForSelector('[data-testid="remote-demo"] .demo-click', { timeout: 5000 })
  await page.waitForTimeout(80)
  await page.click('[data-testid="demo-play"]')   // pause
  await page.waitForTimeout(100)   // a pause takes hold on the next animation frame
  const frozen = await stageAnimations(page)
  const scene = frozen.find((a) => a.name === 'demo-scene-in')
  assert.ok(scene, 'the entrance is still there')
  assert.equal(scene.state, 'finished', `the finished entrance stays finished when paused: ${JSON.stringify(frozen)}`)
  assert.ok(frozen.some((a) => a.name === 'demo-click' && a.state === 'paused' && a.time > 0 && a.time < 420), `the ripple is paused mid-way: ${JSON.stringify(frozen)}`)
  await page.waitForTimeout(700)
  const still = await stageAnimations(page)
  assert.equal(still.find((a) => a.name === 'demo-click')!.time, frozen.find((a) => a.name === 'demo-click')!.time, 'the ripple does not move while paused')
  await page.click('[data-testid="demo-play"]')   // resume
  const resumed = await stageAnimations(page)
  assert.equal(resumed.find((a) => a.name === 'demo-scene-in')?.state, 'finished', 'the entrance is not played again')
  const ripple = resumed.find((a) => a.name === 'demo-click')
  assert.ok(!ripple || ripple.state === 'running' || ripple.state === 'finished')
  if (ripple) assert.ok(ripple.time >= frozen.find((a) => a.name === 'demo-click')!.time, 'the ripple goes on from where it stopped, not from its start')
  // a whole step later, still no entrance played twice: every entrance is the current scene's, once
  await page.waitForFunction(() => document.querySelector('[data-testid="remote-demo"]')?.getAttribute('data-scene') === 'plugins', null, { timeout: 15_000 })
  await page.waitForTimeout(500)
  await page.click('[data-testid="demo-play"]')
  await page.click('[data-testid="demo-play"]')
  const later = await stageAnimations(page)
  assert.ok(later.filter((a) => a.name === 'demo-scene-in').every((a) => a.state === 'finished'), JSON.stringify(later))
  await page.close()
})

test('a hidden page and a stage scrolled out of view hold it: no frame changes, its motion paused, the time away not counted', async () => {
  const { page } = await openConnections()
  await openDemo(page)
  await page.waitForFunction(() => document.querySelector('[data-testid="remote-demo"]')?.getAttribute('data-running') === 'true')
  await page.waitForTimeout(600)
  const setHidden = (hidden: boolean) => page.evaluate((h) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); document.dispatchEvent(new Event('visibilitychange')) }, hidden)
  await setHidden(true)
  const held = await demoData(page)
  assert.deepEqual([held.held, held.running, held.status], ['true', 'false', 'playing'])
  assert.ok((await stageAnimations(page)).every((a) => a.state !== 'running'), 'nothing moves while hidden')
  await page.waitForTimeout(4000)
  assert.equal((await demoData(page)).frame, held.frame)
  await setHidden(false)
  const back = await demoData(page)
  assert.deepEqual([back.running, back.frame, back.scene], ['true', held.frame, 'oasis'], 'back where it was: the 4 s away were not played')

  // out of view: a spacer pushes the card below the dialog's scroll area (the fixture's, not the product's)
  await page.evaluate(() => {
    const body = document.querySelector('[data-testid="settings-panel-connections"]')!
    const spacer = document.createElement('div'); spacer.style.height = '3000px'; spacer.id = 'qa-spacer'
    body.prepend(spacer)
    body.scrollTop = 0
  })
  await page.waitForFunction(() => document.querySelector('[data-testid="remote-demo"]')?.getAttribute('data-held') === 'true')
  const off = await demoData(page)
  await page.waitForTimeout(2000)
  assert.equal((await demoData(page)).frame, off.frame, 'off screen: the frame stays')
  await page.evaluate(() => document.querySelector('[data-testid="remote-demo"]')!.scrollIntoView())
  await page.waitForFunction(() => document.querySelector('[data-testid="remote-demo"]')?.getAttribute('data-running') === 'true')
  assert.equal((await demoData(page)).frame, off.frame)
  await page.close()
})

test('reduced motion: nothing runs, each step is drawn finished and chosen with the steps; turning it on mid-play stops at once', async () => {
  const { page } = await openConnections({ reducedMotion: 'reduce' })
  await openDemo(page)
  let d = await demoData(page)
  assert.deepEqual([d.reduced, d.running, d.status], ['true', 'false', 'paused'])
  assert.equal(await page.locator('[data-testid="demo-play"]').count(), 0, 'no play under reduced motion')
  assert.deepEqual(await stageAnimations(page), [], 'no animation or transition at all')
  assert.match(await page.locator('[data-testid="remote-demo"] .rdemo-url').getAttribute('class') ?? '', /is-shown/, 'step 1 finished: the address shown')
  await page.waitForTimeout(1500)
  assert.equal((await demoData(page)).frame, d.frame)
  for (const scene of SCENES.slice(1)) {
    await page.click('[data-testid="demo-next"]')
    assert.equal((await demoData(page)).scene, scene)
    assert.deepEqual(await stageAnimations(page), [])
  }
  await page.close()

  const live = await openConnections()
  await openDemo(live.page)
  await live.page.waitForFunction(() => document.querySelector('[data-testid="remote-demo"]')?.getAttribute('data-running') === 'true')
  await live.page.emulateMedia({ reducedMotion: 'reduce' })
  await live.page.waitForFunction(() => document.querySelector('[data-testid="remote-demo"]')?.getAttribute('data-reduced') === 'true')
  d = await demoData(live.page)
  assert.deepEqual([d.running, d.status], ['false', 'paused'])
  await live.page.waitForTimeout(1500)
  assert.equal((await demoData(live.page)).frame, d.frame)
  await live.page.emulateMedia({ reducedMotion: 'no-preference' })
  await live.page.waitForFunction(() => document.querySelector('[data-testid="remote-demo"]')?.getAttribute('data-reduced') === 'false')
  assert.equal((await demoData(live.page)).running, 'false', 'motion allowed again: it waits for Play')
  assert.equal(await live.page.locator('[data-testid="demo-play"]').count(), 1)
  await live.page.close()
})

test('keyboard: the controls are reachable and named, the picture is not; Escape closes the walkthrough only and focus returns to the entry', async () => {
  const { page } = await openConnections()
  await openDemo(page)
  const tabbable = await page.locator('[data-testid="remote-demo"] .demo-stage').evaluate((el) => el.querySelectorAll('button, a, input, select, textarea, [tabindex]').length)
  assert.equal(tabbable, 0)
  assert.equal(await page.locator('[data-testid="remote-demo"] .demo-stage').getAttribute('aria-hidden'), 'true')
  await page.focus('[data-testid="remote-demo-open"]')
  const order: string[] = []
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? '')) }
  // from the entry straight to the controls (the picture takes no focus); Previous is disabled on the first step
  assert.deepEqual(order, ['Pause', 'Next step', 'Step 1 of 6: Turn on, copy the address', 'Step 2 of 6: Plugins → + → Add custom MCP server'])
  await page.focus('[data-testid="demo-next"]')
  await page.keyboard.press('Enter')
  assert.equal((await demoData(page)).scene, 'plugins')
  // an input method composing: its Escape (cancelling the composition) is left alone — the walkthrough stays
  const composing = await page.evaluate(() => {
    const e = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })
    document.activeElement!.dispatchEvent(e)
    return { prevented: e.defaultPrevented }
  })
  assert.deepEqual(composing, { prevented: false })
  assert.equal(await page.locator('[data-testid="remote-demo"]').count(), 1, 'still open after a composing Escape')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="remote-demo"]', { state: 'detached' })
  assert.equal(await page.locator('[data-testid="settings-dialog"]').evaluate((d) => (d as HTMLDialogElement).open), true, 'Settings stays open')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'remote-demo-open')
  assert.equal(await page.locator('[data-testid="remote-demo-open"]').getAttribute('aria-expanded'), 'false')
  assert.equal(await page.evaluate(() => document.getAnimations().filter((a) => (a as CSSAnimation).animationName?.startsWith('demo') || (a as CSSAnimation).animationName?.startsWith('rdemo-')).length), 0, 'closed: none of its animations left')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('[data-testid="settings-dialog"]')?.hasAttribute('open'))
  await page.close()
})

test('four themes (light, dark × motion, reduced): every step drawn readable in its tokens', async () => {
  const combos = [['light', 'no-preference'], ['dark', 'no-preference'], ['light', 'reduce'], ['dark', 'reduce']] as const
  for (const [colorScheme, reducedMotion] of combos) {
    const { page, errors } = await openConnections({ colorScheme, reducedMotion })
    await openDemo(page)
    const dir = SHOTS ? join(SHOTS, `${colorScheme}-${reducedMotion === 'reduce' ? 'reduced' : 'motion'}`) : null
    if (dir) mkdirSync(dir, { recursive: true })
    const stage = page.locator('[data-testid="remote-demo"]')
    if (dir && reducedMotion === 'no-preference') {
      // playback as it runs: a frame every 1.5 s until it ends
      for (let i = 0; i < 40; i++) {
        await stage.screenshot({ path: join(dir, `play-${String(i).padStart(2, '0')}.png`) })
        if ((await demoData(page)).status === 'ended') break
        await page.waitForTimeout(1500)
      }
    }
    const colours = new Set<string>()
    for (let i = 0; i < SCENES.length; i++) {
      await page.locator('[data-testid="demo-dot"]').nth(i).click()
      if (reducedMotion === 'no-preference' && (await demoData(page)).status === 'playing') await page.click('[data-testid="demo-play"]')
      await page.locator('[data-testid="demo-dot"]').nth(i).click()   // paused: the finished picture
      assert.equal((await demoData(page)).scene, SCENES[i])
      if (dir) await stage.screenshot({ path: join(dir, `step-${i + 1}-${SCENES[i]}.png`) })
      colours.add(await page.locator('[data-testid="remote-demo"] .rdemo-win').evaluate((el) => getComputedStyle(el).backgroundColor))
      const small = await page.locator('[data-testid="remote-demo"] .demo-stage').evaluate((el) => [...el.querySelectorAll('*')].filter((n) => [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent!.trim()) && parseFloat(getComputedStyle(n).fontSize) < 9.5).map((n) => `${n.className}:${n.textContent}:${getComputedStyle(n).fontSize}`))
      assert.deepEqual(small, [], 'no text under 9.5px')
    }
    const bg = [...colours][0]!
    const light = await page.evaluate((c) => { const m = /oklch\(([\d.]+)/.exec(c) ?? /rgb\((\d+)/.exec(c); return m ? (c.startsWith('oklch') ? Number(m[1]) : Number(m[1]) / 255) : -1 }, bg)
    assert.ok(colorScheme === 'light' ? light > 0.8 : light < 0.4, `${colorScheme}: the windows' surface ${bg}`)
    assert.deepEqual(errors, [])
    await page.close()
  }
})
