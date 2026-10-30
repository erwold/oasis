/** The desktop app attaches only to the backend of its own data directory: /api/meta/build answers a challenge with
 *  a proof of the session token it holds, and the desktop's check (desktop/shell.js, run here as it is) accepts that
 *  answer only from the backend holding the desktop's token on the desktop's port. The token never crosses. */

import { afterEach, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { attachProof } from '../src/api/auth.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'

interface DesktopShell {
  attachChallenge(): string
  classifyAttach(status: number | null, body: unknown, mine: { token: string | null; port: string | number; challenge: string }): string
}
const shell = createRequire(import.meta.url)(join(import.meta.dir, '..', '..', 'desktop', 'shell.js')) as DesktopShell

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

test('the build handshake answers a challenge with the proof the desktop app checks, and nothing else', async () => {
  app = await makeApp()
  const c = new Client(app, { headers: {} })                                           // public: no session needed
  const challenge = shell.attachChallenge()
  const build = await json(await c.get(`/api/meta/build?challenge=${challenge}`))
  const port = app.state.settings.port
  expect(build.attach_proof).toBe(attachProof(app.state.session_token, port, challenge))
  expect(JSON.stringify(build)).not.toContain(app.state.session_token)
  // the desktop of this data directory attaches; one of another data directory, or on another port, does not
  expect(shell.classifyAttach(200, build, { token: app.state.session_token, port, challenge })).toBe('ours')
  expect(shell.classifyAttach(200, build, { token: 'another-data-dirs-token', port, challenge })).toBe('foreign')
  expect(shell.classifyAttach(200, build, { token: app.state.session_token, port: port + 1, challenge })).toBe('foreign')
  expect(shell.classifyAttach(200, build, { token: app.state.session_token, port, challenge: shell.attachChallenge() })).toBe('foreign')
  // no challenge (the UI's handshake) or a malformed one: the same body as before, no proof
  for (const query of ['', '?challenge=short', `?challenge=${'a'.repeat(129)}`, `?challenge=${encodeURIComponent('with/slash-and-enough-chars')}`]) {
    const plain = await json(await c.get(`/api/meta/build${query}`))
    expect(plain.attach_proof).toBeUndefined()
    expect(plain.api_version).toBe('code-v1')
  }
})

test('a listener that answers the handshake like oasis-code but cannot prove the token is never attached to', () => {
  const challenge = shell.attachChallenge()
  const impostor = { source_fingerprint: 'impostor', api_version: 'code-v1' }
  expect(shell.classifyAttach(200, impostor, { token: 'the-desktops-token', port: 8321, challenge })).toBe('foreign')
  expect(shell.classifyAttach(200, { ...impostor, attach_proof: 'x'.repeat(43) }, { token: 'the-desktops-token', port: 8321, challenge })).toBe('foreign')
})
