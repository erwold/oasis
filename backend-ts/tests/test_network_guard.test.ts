/** The suite's zero-cloud guard and its private data directory, and the e2e server's pretend web: nothing reaches a
 *  real host, and the only outbound transport the product has is the global fetch the guard stands in. */

import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultAuthDir, setDefaultAuthDir } from '../src/auth/store.ts'
import { defaultDataDir, getSettings } from '../src/config.ts'
import { pretendWeb } from '../scripts/e2e_server.ts'
import { TestNetworkBlocked, suiteDataDir } from './preload.ts'

test('the global fetch refuses every host but the loopback, before any socket', () => {
  for (const url of ['https://api.openai.com/v1/responses', 'https://api.anthropic.com/v1/messages', 'http://93.184.216.34/', new URL('https://example.com/')]) {
    expect(() => fetch(url)).toThrow(TestNetworkBlocked)
  }
  expect(() => fetch(new Request('https://chatgpt.com/backend-api/codex/responses'))).toThrow(TestNetworkBlocked)
})

test('the default data and credential directories are the suite\'s own temp directory, never ~/.oasis-code', () => {
  const home = join(homedir(), '.oasis-code')
  // an app built earlier in this process pointed the store at its own directory: back to the default
  setDefaultAuthDir(null)
  expect(defaultDataDir()).toBe(suiteDataDir)
  expect(defaultAuthDir()).toBe(suiteDataDir)
  expect(getSettings().data_dir).toBe(suiteDataDir)
  expect(suiteDataDir.startsWith(home)).toBe(false)
})

/** Every .ts file under `dir` but tests kept beside the code (`*.test.ts`: a test may dial its own loopback fixture). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })
}

test('the product reaches the network through the global fetch only (Bun.fetch cannot be guarded)', () => {
  const root = join(import.meta.dir, '..')
  const outbound = [
    /\bBun\.(fetch|connect|udpSocket)\b/,
    /from ['"]node:(https?|http2)['"]/,
    /\b(net|tls)\.connect\b|import\s*\{[^}]*\b(connect|createConnection)\b[^}]*\}\s*from ['"]node:(net|tls)['"]/,
  ]
  // the isolation probe serves a loopback page to itself (createServer): a listener, not a client
  const allowed = new Set([join(root, 'src', 'execution', 'isolation.ts')])
  const offenders = [...sources(join(root, 'src')), ...sources(join(root, 'scripts'))]
    .filter((path) => !allowed.has(path))
    .filter((path) => { const text = readFileSync(path, 'utf8'); return outbound.some((re) => re.test(text)) })
  expect(offenders).toEqual([])
  expect(readFileSync(join(root, 'src', 'execution', 'isolation.ts'), 'utf8')).not.toMatch(/\bhttp\.(request|get)\b|import\s*\{[^}]*\b(request|get)\b[^}]*\}\s*from ['"]node:http['"]/)
})

test('the e2e server\'s pretend web serves its own names and refuses every other one loudly', async () => {
  const web = pretendWeb()
  expect(await web.resolve('docs.e2e.example')).toEqual(['93.184.216.34'])
  expect((await web.fetchImpl('https://docs.e2e.example/guide')).status).toBe(200)
  expect((await web.fetchImpl('https://docs.e2e.example/elsewhere')).status).toBe(404)
  await expect(web.resolve('example.com')).rejects.toThrow(TestNetworkBlocked)
  await expect(web.fetchImpl('https://example.com/page')).rejects.toThrow(TestNetworkBlocked)
  await expect(web.fetchImpl('https://e2e.example.evil.com/')).rejects.toThrow(TestNetworkBlocked)
})
