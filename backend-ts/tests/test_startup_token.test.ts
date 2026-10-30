/** The startup lines never carry an access token into a pipe or a file: the desktop app copies the backend's and the
 *  director's output into <data>/logs/desktop.log, where a token would sit at rest as a full-access credential
 *  (SEC-01). Printed to a pipe, the link shows `<token>` and says where the token is kept; on a terminal the person
 *  reads, it is whole. */

import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { printedToken } from '../src/api/auth.ts'
import { tempDir } from './helpers.ts'

const where = { explicit: false, env: 'OASIS_CODE_SESSION_TOKEN', dataDir: '/data', filename: 'session-token' }

test('a token is printed whole on a terminal, masked with where it is kept anywhere else', () => {
  expect(printedToken('s3cret-token-value', where, true)).toEqual({ token: 's3cret-token-value', note: null })
  expect(printedToken('s3cret-token-value', where, false)).toEqual({ token: '<token>', note: 'the token is in /data/session-token' })
  expect(printedToken('s3cret-token-value', { ...where, explicit: true }, false)).toEqual({ token: '<token>', note: 'the token is the one set in OASIS_CODE_SESSION_TOKEN' })
})

const children: Bun.Subprocess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill('SIGTERM'); await child.exited }
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('no port'))))
    })
  })
}

/** Starts a process with piped output and reads its stderr until a line matches. */
async function startUntil(argv: string[], env: Record<string, string | undefined>, pattern: RegExp): Promise<string> {
  const child = Bun.spawn(argv, { env, cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' })
  children.push(child)
  const reader = child.stderr.getReader()
  const decoder = new TextDecoder()
  let heard = ''
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    heard += decoder.decode(value)
    if (pattern.test(heard)) break
  }
  reader.releaseLock()
  return heard
}

test('the backend and the director started into a pipe print their links without the tokens', async () => {
  const data = tempDir('oasis-startup-token-')
  const port = await freePort()
  const directorPort = await freePort()
  const env: Record<string, string | undefined> = { ...process.env, OASIS_CODE_DATA: data, OASIS_CODE_PORT: String(port), NO_PROXY: '*', no_proxy: '*' }
  delete env.OASIS_CODE_SESSION_TOKEN
  delete env.OASIS_CODE_DIRECTOR_TOKEN
  const backend = await startUntil(['bun', 'run', 'src/index.ts'], env, /oasis-code on http/)
  const sessionToken = readFileSync(join(data, 'session-token'), 'utf8').trim()
  expect(backend).toContain(`oasis-code on http://127.0.0.1:${port}/?token=<token>  (the token is in ${join(data, 'session-token')}; isolation:`)
  expect(backend).not.toContain(sessionToken)
  const director = await startUntil(['bun', 'run', 'src/index.ts', 'director', '--port', String(directorPort)], env, /oasis-code director on http/)
  const directorToken = readFileSync(join(data, 'director-token'), 'utf8').trim()
  expect(director).toContain(`oasis-code director on http://127.0.0.1:${directorPort}/<token>/mcp  (the token is in ${join(data, 'director-token')};`)
  expect(director).not.toContain(directorToken)
  expect(director).not.toContain(sessionToken)
}, 90_000)
