/** Remote access card in real Chrome against the e2e backend (port 8399), its desktop shell standing in through
 *  page.exposeFunction: every call goes to the REAL desktop/remote.js controller (state derivation, Off semantics,
 *  setup through the backend CLI contract) over a scripted launchd and CLI. It proves what the card shows and does for
 *  each controller state — not the Electron app's lifecycle and not real launchd (both verified elsewhere, or
 *  recorded as unverified). */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright-core'

const require = createRequire(import.meta.url)
const { createRemote } = require('../../desktop/remote.js') as { createRemote: (o: Record<string, unknown>) => Record<string, (a?: unknown) => Promise<unknown>> }

const PORT = 8399
const BASE = `http://127.0.0.1:${PORT}`
const SECRET = 'Q'.repeat(43)
let server: ChildProcess
let browser: Browser
let page: Page
const root = mkdtempSync(join(process.env.OASIS_CODE_E2E_TMP || tmpdir(), 'qa-remote-e2e-'))

/** launchd by label, `print` forced to fail while `printFails` is set; the backend CLI's version/setup/revoke. */
function scriptedMac() {
  const dataDir = join(root, 'data'); const agentsDir = join(root, 'agents'); const home = join(root, 'home')
  const gw = join(dataDir, 'gateway')
  for (const d of [dataDir, agentsDir, gw, join(home, '.bun', 'bin')]) mkdirSync(d, { recursive: true })
  const bun = join(home, '.bun', 'bin', 'bun'); writeFileSync(bun, '')
  const jobs = new Map<string, { pid: number; program: string; args: string[]; path: string }>()
  const state = { printFails: false, nextPid: 700 }
  const run = async (command: string, args: string[], opts: { input?: string } = {}) => {
    if (command === '/bin/launchctl') {
      const [verb, ...rest] = args; const target = rest[rest.length - 1]!; const label = target.split('/').pop()!
      if (verb === 'print') {
        if (state.printFails) return { code: 1, stdout: '', stderr: 'Could not print: Operation not permitted' }
        const j = jobs.get(label)
        if (!j) return { code: 113, stdout: '', stderr: `Could not find service "${label}"` }
        return { code: 0, stdout: `${target} = {\n\tpath = ${j.path}\n\tstate = running\n\tprogram = ${j.program}\n\targuments = {\n${j.args.map((a) => `\t\t${a}`).join('\n')}\n\t}\n\tpid = ${j.pid}\n}`, stderr: '' }
      }
      if (verb === 'bootstrap') {
        const text = readFileSync(target, 'utf8')
        const l = /<key>Label<\/key>\s*<string>([^<]+)</.exec(text)![1]!
        const program = /<key>Program<\/key>\s*<string>([^<]+)</.exec(text)![1]!
        const a = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)![1]!.match(/<string>([^<]*)<\/string>/g)!.map((s) => s.replace(/<\/?string>/g, ''))
        jobs.set(l, { pid: state.nextPid++, program, args: a, path: target }); return { code: 0, stdout: '', stderr: '' }
      }
      if (verb === 'bootout') { jobs.delete(label); return { code: 0, stdout: '', stderr: '' } }
      if (verb === 'kickstart') { const j = jobs.get(label); if (j) j.pid = state.nextPid++; return { code: 0, stdout: '', stderr: '' } }
    }
    const at = args.indexOf('gateway')
    const [sub, ...rest] = args.slice(at + 1)
    const flag = (n: string) => rest[rest.indexOf(n) + 1]
    if (sub === 'version') return { code: 0, stdout: '{"build":"e2e"}', stderr: '' }
    if (sub === 'setup') {
      if (flag('--provider') === 'quick') { rmSync(join(gw, 'config.json'), { force: true }); return { code: 0, stdout: '{}', stderr: '' } }
      writeFileSync(join(gw, 'config.json'), JSON.stringify({ version: 1, provider: flag('--provider'), host: flag('--host') }))
      if (opts.input) writeFileSync(join(gw, 'cloudflared-token'), opts.input)
      if (!existsSync(join(gw, 'secret'))) writeFileSync(join(gw, 'secret'), SECRET)
      return { code: 0, stdout: '{}', stderr: '' }
    }
    if (sub === 'revoke') { writeFileSync(join(gw, 'secret'), 'R'.repeat(43)); return { code: 0, stdout: '{}', stderr: '' } }
    return { code: 127, stdout: '', stderr: 'unexpected' }
  }
  const spawnFake = () => { const c = new EventEmitter() as EventEmitter & { kill: () => void }; c.kill = () => {}; return c }
  const remote = createRemote({ dataDir, backend: { command: 'bun', args: ['run', 'src/index.ts'], cwd: '/repo/backend-ts', bundled: false }, harnessPort: String(PORT),
    env: { OASIS_CODE_GATEWAY_PORT: '18499' }, run, spawn: spawnFake, fetchImpl: async () => { throw new TypeError('fetch failed') },
    exists: (p: string) => p === bun, home, uid: 501, agentsDir, pid: process.pid })
  return { remote, state, jobs, gw }
}
const mac = scriptedMac()

before(async () => {
  server = spawn('bun', ['run', 'scripts/e2e_server.ts', String(PORT)], { cwd: `${process.cwd()}/../backend-ts`, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((resolve, reject) => {
    let buf = ''
    server.stdout!.on('data', (d) => { buf += String(d); if (buf.split('\n')[0]!.trim().startsWith('{')) resolve() })
    server.on('exit', (code) => reject(new Error(`e2e server exited ${code}`)))
  })
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/api/meta/build`)).ok) break } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 100)) }
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  browser = await chromium.launch(executablePath ? { executablePath, headless: true, args: ['--no-sandbox'] } : { channel: 'chrome', headless: true })
  page = await browser.newPage()
  page.on('pageerror', (e) => { throw e })
  await page.exposeFunction('qaRemote', (method: string, arg: unknown) => mac.remote[method]!(arg))
  await page.addInitScript(() => {
    const call = (m: string, a?: unknown) => (window as unknown as { qaRemote: (m: string, a?: unknown) => Promise<unknown> }).qaRemote(m, a)
    Object.assign(window, { oasisCodeDesktop: { platform: 'darwin', remoteStatus: () => call('status'), setRemote: (c: unknown) => call('set', c), configureRemote: (c: unknown) => call('configure', c), rotateRemote: () => call('rotate') } })
  })
  await page.goto(`${BASE}/api/auth/session?token=e2e-token`)
  await page.waitForSelector('[data-testid="settings"]')
})

after(async () => {
  await browser?.close()
  server?.kill('SIGTERM')
  rmSync(root, { recursive: true, force: true })
})

const line = () => page.locator('[data-testid="remote-line"]').textContent()
async function lineIs(re: RegExp) { await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-testid="remote-line"]')?.textContent ?? ''), re.source, { timeout: 10_000 }) }

test('the card: off → on with the quick tunnel (installed; its address once the gateway has a name) → a stable tunnel set up → the fixed /mcp/current address → off', async () => {
  await page.click('[data-testid="settings"]')
  // the desktop shell is here: Settings has its Connections tab, and Remote access lives there, not under Accounts
  const tabs = page.locator('[data-testid="settings-dialog"] [role="tab"]')
  assert.deepEqual(await tabs.allInnerTexts(), ['Accounts', 'Appearance', 'Web Search', 'Connections'])
  assert.equal(await page.locator('[data-testid="settings-panel-accounts"] [data-testid="remote-access"]').count(), 0)
  await page.click('[data-testid="settings-tab-connections"]')
  await page.waitForSelector('[data-testid="settings-panel-connections"] [data-testid="remote-access"]')
  await lineIs(/^Off$/)
  await page.click('[data-testid="remote-toggle"]')
  await lineIs(/^Starting/)
  assert.equal(mac.jobs.size, 1, 'the gateway is installed with the quick tunnel: nothing to set up first')
  assert.equal(await page.locator('[data-testid="remote-url"]').count(), 0, 'no address before the quick tunnel has a name')
  assert.match((await page.locator('[data-testid="remote-where"]').textContent())!, /^Quick tunnel/)
  writeFileSync(join(mac.gw, 'secret'), SECRET)
  writeFileSync(join(mac.gw, 'status.json'), JSON.stringify({ provider: 'quick', host: 'aa-bb.trycloudflare.com', updated_at: new Date().toISOString() }))
  await page.waitForSelector('[data-testid="remote-url"]')
  assert.equal(await page.locator('[data-testid="remote-url"]').textContent(), `https://aa-bb.trycloudflare.com/${SECRET}/mcp/current`)
  await page.click('[data-testid="remote-change"]')
  assert.equal(await page.locator('[data-testid="remote-host"]').count(), 0, 'the quick tunnel takes no host')
  await page.selectOption('[data-testid="remote-provider"]', 'external')
  assert.match((await page.locator('[data-testid="remote-step"]').textContent())!, /127\.0\.0\.1:18499/)
  await page.fill('[data-testid="remote-host"]', 'mcp.example.com')
  // away to Accounts and back by keyboard: the half-done setup is as it was left
  await page.locator('[data-testid="settings-tab-connections"]').focus()
  await page.keyboard.press('Home')
  assert.equal(await page.locator('[data-testid="remote-access"]').isVisible(), false)
  await page.keyboard.press('End')
  assert.equal(await page.inputValue('[data-testid="remote-host"]'), 'mcp.example.com')
  assert.equal(await page.inputValue('[data-testid="remote-provider"]'), 'external')
  await page.click('[data-testid="remote-save"]')
  await page.waitForFunction((want) => document.querySelector('[data-testid="remote-url"]')?.textContent === want, `https://mcp.example.com/${SECRET}/mcp/current`, { timeout: 10_000 })
  assert.equal(mac.jobs.size, 1, 'the agent was installed')
  assert.doesNotMatch((await line())!, /^Connected$/, 'just installed is never "connected"')
  await page.click('[data-testid="remote-toggle"]')
  await lineIs(/^Off$/)
  assert.equal(mac.jobs.size, 0)
})

test('Off that cannot be confirmed (launchd print fails) is never shown as Off: Needs attention, still "Turn off", the job kept', async () => {
  await page.click('[data-testid="remote-toggle"]')          // on again (set up already)
  await page.waitForFunction(() => document.querySelector('[data-testid="remote-toggle"]')?.textContent === 'Turn off')
  assert.equal(mac.jobs.size, 1)
  mac.state.printFails = true
  await page.click('[data-testid="remote-toggle"]')          // Off, but launchd cannot be asked
  await lineIs(/^Needs attention/)
  assert.equal(await page.locator('[data-testid="remote-toggle"]').textContent(), 'Turn off')
  assert.equal(mac.jobs.size, 1, 'the job is still there')
  mac.state.printFails = false
  await page.click('[data-testid="remote-toggle"]')          // retry works
  await lineIs(/^Off$/)
  assert.equal(mac.jobs.size, 0)
})
