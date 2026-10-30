/** Isolated fixture only; never connects to a running user's app. */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext } from 'playwright-core'
const base = 'http://127.0.0.1:8399'
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function available(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE' ? resolve(false) : reject(error))
    server.listen(8399, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}
export async function webSearchFixture() {
  if (!existsSync(fileURLToPath(new URL('../dist/index.html', import.meta.url)))) throw new Error('Run npm run build first')
  // Wait for the one authorized port. Never terminate its existing owner.
  const deadline = Date.now() + 120_000
  while (!await available()) { if (Date.now() > deadline) throw new Error('8399 is still occupied; retry later'); await pause(500) }
  const profile = mkdtempSync(join(process.env.OASIS_CODE_E2E_TMP || tmpdir(), 'search-chrome-'))
  let server: ChildProcess | undefined, context: BrowserContext | undefined
  const close = async () => {
    await context?.close()
    if (server && server.exitCode === null) {
      const exited = new Promise<void>((resolve) => server!.once('exit', () => resolve()))
      server.kill('SIGTERM'); await exited
    }
    rmSync(profile, { recursive: true, force: true })
  }
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, OASIS_CODE_FRONTEND_DIST: fileURLToPath(new URL('../dist', import.meta.url)) }
    for (const key of ['DEEPSEEK_API_KEY', 'ZHIPU_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OASIS_CODE_AUTH_DIR', 'OASIS_CODE_DATA']) delete env[key]
    server = spawn('bun', ['run', 'scripts/e2e_server.ts', '8399'], { cwd: fileURLToPath(new URL('../../backend-ts/', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'] })
    server.stderr!.resume() // drain fixture diagnostics without printing them
    await new Promise<void>((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error('Fixture startup timed out')), 30_000)
      server!.stdout!.on('data', (chunk) => { buffer += String(chunk); if (buffer.split('\n').some((line) => line.trim().startsWith('{'))) { clearTimeout(timer); resolve() } })
      server!.once('exit', () => { clearTimeout(timer); reject(new Error('Fixture failed to start')) })
      server!.once('error', () => { clearTimeout(timer); reject(new Error('Fixture failed to start')) })
    })
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/meta/build`)).ok) break } catch { /* fixture starting */ } await pause(100) }
    const executablePath = process.env.OASIS_CODE_E2E_BROWSER
    context = await chromium.launchPersistentContext(profile, { ...(executablePath ? { executablePath } : { channel: 'chrome' }), headless: true, viewport: { width: 1120, height: 820 } })
    const page = await context.newPage()
    await page.goto(`${base}/api/auth/session?token=e2e-token`)
    await page.getByTestId('settings').click()
    await page.getByTestId('settings-tab-web-search').click()
    await page.waitForSelector('[data-testid="web-search-use-web"]:enabled')
    return { page, close }
  } catch (error) { await close(); throw error }
}
