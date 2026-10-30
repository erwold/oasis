/** A command never reads the credential stores on the list — the package registries' and Git's tokens, the cloud
 *  CLIs', the login keychains — and the Seatbelt report says plainly what it still reads: the person's other private
 *  files, and the arguments and environment of their other processes (SEC-04). The real sandbox reads a fixture
 *  HOME (a child process with HOME set, so the list expands under it); the real one is never touched. */

import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CREDENTIAL_READ_DENY, PROCESS_LIMIT, READ_LIMIT } from '../src/execution/isolation.ts'
import { tempDir } from './helpers.ts'

const SENTINELS: Record<string, string> = {
  '.npmrc': '//registry.npmjs.org/:_authToken=SENTINEL_NPMRC',
  '.git-credentials': 'https://u:SENTINEL_GITCRED@example.invalid',
  '.config/git/credentials': 'https://u:SENTINEL_XDG_GITCRED@example.invalid',
  '.pypirc': 'SENTINEL_PYPIRC',
  '.cargo/credentials.toml': 'SENTINEL_CARGO',
  '.azure/accessTokens.json': 'SENTINEL_AZURE',
  'Library/Keychains/fixture.keychain-db': 'SENTINEL_KEYCHAIN',
  '.ssh/id_ed25519': 'SENTINEL_SSH',
  'Documents/notes.txt': 'SENTINEL_DOCUMENTS',
}

test('the credential stores on the list include the package registries\', Git\'s, Azure\'s and the login keychains', () => {
  for (const path of ['~/.npmrc', '~/.git-credentials', '~/.config/git/credentials', '~/.pypirc', '~/.cargo/credentials', '~/.cargo/credentials.toml', '~/.azure', '~/Library/Keychains']) {
    expect(CREDENTIAL_READ_DENY).toContain(path)
  }
  expect(READ_LIMIT).toContain('other private files')
  expect(PROCESS_LIMIT).toContain('environment')
})

const CHILD = `
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
const [src, root, sentinels] = [process.argv[2], process.argv[3], JSON.parse(process.argv[4])]
const { SeatbeltRuntime } = await import(join(src, 'execution/isolation.ts'))
const { sandboxForWorkspace } = await import(join(src, 'workspace/sandbox.ts'))
for (const [rel, text] of Object.entries(sentinels)) { mkdirSync(join(homedir(), rel, '..'), { recursive: true }); writeFileSync(join(homedir(), rel), text) }
const data = join(root, 'data'), ws = join(data, 'workspaces', 'w'), base = join(data, 'base.git')
for (const dir of [ws, base]) mkdirSync(dir, { recursive: true })
const box = sandboxForWorkspace(data, { kind: 'snapshot', source_path: null, base_repo_path: base }, { path: ws }, { network: false })
const out = {}
for (const rel of Object.keys(sentinels)) {
  const argv = new SeatbeltRuntime().command(['/bin/cat', join(homedir(), rel)], box, join(root, 'profile.sb'))
  const r = spawnSync(argv[0], argv.slice(1), { cwd: ws, encoding: 'utf8', timeout: 10000 })
  out[rel] = r.stdout.includes(sentinels[rel]) ? 'read' : 'denied'
}
console.log(JSON.stringify(out))
`

test.skipIf(process.platform !== 'darwin')('macOS: a sandboxed command reads none of the listed credential stores; a document outside the list stays readable', () => {
  const root = realpathSync(tempDir('oasis-credential-deny-'))
  const home = join(root, 'home')
  mkdirSync(home)
  const script = join(root, 'child.ts')
  writeFileSync(script, CHILD)
  const result = spawnSync(process.execPath, [script, join(import.meta.dir, '..', 'src'), root, JSON.stringify(SENTINELS)], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: process.env.TMPDIR ?? '/tmp' }, encoding: 'utf8', timeout: 60_000,
  })
  expect(result.stderr).toBe('')
  expect(JSON.parse(result.stdout.trim())).toEqual({
    '.npmrc': 'denied', '.git-credentials': 'denied', '.config/git/credentials': 'denied', '.pypirc': 'denied', '.cargo/credentials.toml': 'denied',
    '.azure/accessTokens.json': 'denied', 'Library/Keychains/fixture.keychain-db': 'denied', '.ssh/id_ed25519': 'denied',
    // not a credential store on the list: said so in READ_LIMIT
    'Documents/notes.txt': 'read',
  })
}, 60_000)
