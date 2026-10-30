// Offline tests of the inventory behind THIRD_PARTY_NOTICES.md: pure inputs, and small installed-package trees written
// into a fresh temporary folder (so no node_modules fixture is committed); nothing is installed or fetched.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  bunRuntimeClosure, declaredLicense, licenseFiles, needsReview, npmRuntimePackages, packagesInInputs, parseBunLock, readInstalled, splitSpec,
} from '../lib/inventory.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')

/** Write { 'a/b.json': 'text' } under a new temporary folder and return the folder. */
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'oss-inventory-'))
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), text)
  }
  return root
}
const pj = (name, version, license) => JSON.stringify({ name, version, license })
const modulesFixture = () => tree({
  'with-license/package.json': pj('with-license', '1.0.0', 'Apache-2.0'),
  'with-license/LICENSE.md': 'Apache License fixture',
  'with-license/NOTICE': 'notice fixture',
  'declared-only/package.json': pj('declared-only', '1.0.0', 'MIT'),
})
const beModulesFixture = () => tree({
  'body-parser/package.json': pj('body-parser', '2.3.0', 'MIT'),
  'body-parser/LICENSE': 'MIT bp',
  'body-parser/node_modules/content-type/package.json': pj('content-type', '2.0.0', 'MIT'),
  'body-parser/node_modules/content-type/LICENSE': 'MIT 2.0.0',
  'content-type/package.json': pj('content-type', '1.0.5', 'MIT'),
  'content-type/LICENSE': 'MIT 1.0.5',
  'hono/package.json': pj('hono', '4.0.0', 'MIT'),
  'hono/LICENSE': 'MIT hono',
})

test('bun.lock with trailing commas parses', () => {
  const lock = parseBunLock('{ "a": [1, 2,], "b": { "c": 1, }, }')
  assert.deepEqual(lock, { a: [1, 2], b: { c: 1 } })
})

test('name@version splits keep a scope', () => {
  assert.deepEqual(splitSpec('@scope/pkg@1.2.3'), { name: '@scope/pkg', version: '1.2.3' })
  assert.deepEqual(splitSpec('zod@4.6.5'), { name: 'zod', version: '4.6.5' })
})

test('the bun runtime closure leaves dev dependencies out and follows nested versions', () => {
  const lock = {
    workspaces: { '': { dependencies: { a: '^1', local: 'file:../x' }, devDependencies: { typescript: '^5' } } },
    packages: {
      a: ['a@1.0.0', '', { dependencies: { b: '^2' } }, 'sha'],
      b: ['b@3.0.0', '', {}, 'sha'],
      'a/b': ['b@2.0.0', '', { dependencies: { c: '^1' } }, 'sha'],
      c: ['c@1.0.0', '', {}, 'sha'],
      local: ['local@file:../x', { dependencies: {} }],
      typescript: ['typescript@5.9.3', '', {}, 'sha'],
    },
  }
  const { packages, missing } = bunRuntimeClosure(lock)
  assert.deepEqual(packages.map((p) => `${p.name}@${p.version}`), ['a@1.0.0', 'b@2.0.0', 'c@1.0.0', 'local@file:../x'])
  assert.ok(packages.find((p) => p.name === 'local').local)
  assert.deepEqual(missing, [])
})

test('the real backend lock: runtime closure has the SDK and hono, not typescript or @types/bun', () => {
  const lock = parseBunLock(readFileSync(join(repo, 'backend-ts', 'bun.lock'), 'utf8'))
  const names = bunRuntimeClosure(lock).packages.map((p) => p.name)
  for (const n of ['@modelcontextprotocol/sdk', 'hono', 'zod', 'js-tiktoken']) assert.ok(names.includes(n), n)
  for (const n of ['typescript', '@types/bun']) assert.ok(!names.includes(n), n)
})

test('npm runtime packages exclude dev ones and mark links local', () => {
  const lock = { packages: {
    '': { name: 'root' },
    '../contract': { name: '@x/contract' },
    'node_modules/@x/contract': { resolved: '../contract', link: true },
    'node_modules/react': { version: '19.0.0', license: 'MIT' },
    'node_modules/vite': { version: '8.0.0', dev: true },
    'node_modules/react/node_modules/scheduler': { version: '0.1.0', license: 'MIT' },
  } }
  const out = npmRuntimePackages(lock)
  assert.deepEqual(out.map((p) => p.name), ['@x/contract', 'react', 'scheduler'])
  assert.ok(out[0].local)
})

test('licenses that need review: unknown, copyleft, and an AND with a non-permissive side', () => {
  assert.equal(needsReview('MIT'), false)
  assert.equal(needsReview('(MIT OR GPL-3.0)'), false)
  assert.equal(needsReview('LGPL-2.1-or-later'), true)
  assert.equal(needsReview('OFL-1.1'), true)
  assert.equal(needsReview('MIT AND OFL-1.1'), true)
  assert.equal(needsReview(null), true)
  assert.equal(declaredLicense({ license: { type: 'ISC' } }), 'ISC')
  assert.equal(declaredLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }), 'MIT OR Apache-2.0')
})

test('license files are found by name at a package root; a missing package is reported as not installed', () => {
  const fixtures = modulesFixture()
  assert.deepEqual(licenseFiles(join(fixtures, 'with-license')), ['LICENSE.md', 'NOTICE'])
  const inst = readInstalled(fixtures, 'with-license')
  assert.equal(inst.declared, 'Apache-2.0')
  assert.match(inst.files[0].text, /Apache/)
  const none = readInstalled(fixtures, 'declared-only')
  assert.equal(none.files.length, 0)
  assert.equal(none.declared, 'MIT')
  assert.equal(readInstalled(fixtures, 'absent').installed, false)
})

test('bundler inputs name packages, innermost node_modules first, scopes kept', () => {
  assert.deepEqual(packagesInInputs([
    '/x/node_modules/react/index.js',
    '/x/node_modules/a/node_modules/@s/b/lib.js',
    'C:\\y\\node_modules\\katex\\dist\\katex.mjs',
    '/x/src/App.tsx',
  ]), ['@s/b', 'katex', 'react'])
})

// ---- package instances (F1): nested copies, version drift, build matching by install path -------------------------
import { buildRows } from '../third-party-notices.mjs'
import { bunKeyToInstallPath, installPathsInInputs } from '../lib/inventory.mjs'

test('bun keys and bundler inputs map to install paths, nested and scoped', () => {
  assert.equal(bunKeyToInstallPath('body-parser/content-type'), 'body-parser/node_modules/content-type')
  assert.equal(bunKeyToInstallPath('@s/x/@t/y'), '@s/x/node_modules/@t/y')
  const found = installPathsInInputs(['node_modules/body-parser/node_modules/content-type/index.js', '../contract/node_modules/zod/v4/a.js', 'node_modules/body-parser/node_modules/content-type/b.js'])
  assert.deepEqual([...found].sort((a, b) => a.path.localeCompare(b.path)), [{ root: '', path: 'body-parser/node_modules/content-type' }, { root: '../contract', path: 'zod' }])
})

test('each installed instance is its own row; a nested copy is read from its own folder; drift is never covered', () => {
  const fixtures = beModulesFixture()
  const beLock = {
    workspaces: { '': { name: 'b', dependencies: { 'body-parser': '^2', 'content-type': '^1', hono: '^4' } } },
    packages: {
      'body-parser': ['body-parser@2.3.0', '', { dependencies: { 'content-type': '^2' } }, 'sha'],
      'body-parser/content-type': ['content-type@2.0.0', '', {}, 'sha'],
      'content-type': ['content-type@1.0.5', '', {}, 'sha'],
      hono: ['hono@4.1.0', '', {}, 'sha'],
    },
  }
  const empty = { packages: {} }
  const { rows } = buildRows({
    feLock: empty, deskLock: empty, beLock, contractLock: { workspaces: { '': { name: 'c' } }, packages: {} },
    modulesRoot: '/unused', roots: { frontend: '/none', backend: fixtures, contract: '/none', desktop: '/none' },
    beInputs: ['node_modules/body-parser/node_modules/content-type/index.js', 'node_modules/body-parser/index.js', 'src/index.ts'],
  })
  const be = rows.filter((r) => r.component === 'backend (compiled binary)')
  const byPath = Object.fromEntries(be.map((r) => [r.installPath, r]))
  assert.deepEqual(Object.keys(byPath).sort(), ['body-parser', 'body-parser/node_modules/content-type', 'content-type', 'hono'])
  // the nested 2.0.0 copy is read from its own folder, not from the top-level 1.0.5
  assert.equal(byPath['body-parser/node_modules/content-type'].version, '2.0.0')
  assert.match(byPath['body-parser/node_modules/content-type'].files[0].text, /MIT 2\.0\.0/)
  assert.match(byPath['content-type'].files[0].text, /MIT 1\.0\.5/)
  // build matching is by install path: only the nested copy and body-parser were bundled
  assert.equal(byPath['body-parser/node_modules/content-type'].bundled, 'yes (seen in build)')
  assert.equal(byPath['content-type'].bundled, 'no (not in build inputs)')
  assert.equal(byPath['body-parser'].bundled, 'yes (seen in build)')
  // hono: installed 4.0.0, locked 4.1.0 -> its license is not taken for the locked version, and it is marked for review
  assert.equal(byPath.hono.mismatch, true)
  assert.equal(byPath.hono.review, true)
  assert.deepEqual(byPath.hono.files, [])
  assert.match(byPath.hono.status, /installed copy is 4\.0\.0, the lock pins 4\.1\.0: its license is NOT taken/)
  // no duplicate rows for one instance
  assert.equal(new Set(be.map((r) => r.installPath)).size, be.length)
})

test('a bundled package outside the lock runtime closure is listed as unmatched, never silently dropped', () => {
  const fixtures = beModulesFixture()
  const beLock = {
    workspaces: { '': { name: 'b', dependencies: { hono: '^4' }, devDependencies: { 'content-type': '^1' } } },
    packages: { hono: ['hono@4.0.0', '', {}, 'sha'], 'content-type': ['content-type@1.0.5', '', {}, 'sha'] },
  }
  const empty = { packages: {} }
  const built = buildRows({
    feLock: empty, deskLock: empty, beLock, contractLock: { workspaces: { '': { name: 'c' } }, packages: {} },
    modulesRoot: '/unused', roots: { frontend: '/none', backend: fixtures, contract: '/none', desktop: '/none' },
    beInputs: ['node_modules/hono/index.js', 'node_modules/content-type/index.js'],
  })
  const be = built.rows.filter((r) => r.component === 'backend (compiled binary)')
  assert.deepEqual(be.map((r) => r.installPath), ['hono'])
  assert.deepEqual(built.unmatched, [{ component: 'backend (compiled binary)', path: 'content-type' }])
})

test('the rendered file names every unmatched bundled package', async () => {
  const { render } = await import('../third-party-notices.mjs')
  const text = render({ rows: [], lockHashes: {}, missing: [], unmatched: [{ component: 'backend (compiled binary)', path: 'content-type' }], modulesRootIsRepo: true, buildInputs: true })
  assert.match(text, /Bundled but not in the lock's runtime packages: 1/)
  assert.match(text, /- backend \(compiled binary\): `content-type`/)
})
