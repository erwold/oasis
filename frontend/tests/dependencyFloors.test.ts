/** Packages with a published advisory stay at or above the release that fixed it, in the lock and in what is
 *  installed, for every copy and through every package that pulls one in (a nested copy under a transitive
 *  dependency counts as much as the top-level one):
 *  - katex >= 0.18.2 (GHSA-238p-pmpm-9mq7: inherited properties taken as renderer settings), the UI's math, direct
 *    and through rehype-katex and remark-math → micromark-extension-math;
 *  - source-map-js >= 1.2.2 (GHSA-68fv-2mgg-jv7q: unchecked section offsets in indexed source maps), dev tooling
 *    only, through vite → postcss and jsdom → css-tree. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const FLOORS: Record<string, string> = { katex: '0.18.2', 'source-map-js': '1.2.2' }

/** how each one reaches the tree: a chain of packages, each resolved from the one before (the first from the UI) */
const PATHS: string[][] = [
  ['katex'],
  ['rehype-katex', 'katex'],
  ['remark-math', 'micromark-extension-math', 'katex'],
  ['vite', 'postcss', 'source-map-js'],
  ['jsdom', 'css-tree', 'source-map-js'],
]

function atLeast(version: string, floor: string): boolean {
  const parts = (v: string) => v.split('-')[0]!.split('.').map(Number)
  const [a, b] = [parts(version), parts(floor)]
  for (let i = 0; i < 3; i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return !version.includes('-')   // a prerelease of the floor itself is below it
}

/** the installed package's own package.json (walking up from its entry; some packages export no ./package.json) */
function installed(from: string, name: string): { dir: string; version: string } {
  let dir = dirname(createRequire(from).resolve(name))
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version: string }
      if (pkg.name === name) return { dir, version: pkg.version }
    } catch { /* no package.json here: up */ }
    const up = dirname(dir)
    assert.notEqual(up, dir, `${name}: no package.json above its entry`)
    dir = up
  }
}

test('the floor check itself: below, at and above a floor', () => {
  assert.equal(atLeast('0.16.47', '0.18.2'), false)
  assert.equal(atLeast('0.18.1', '0.18.2'), false)
  assert.equal(atLeast('0.18.2-rc.1', '0.18.2'), false)
  assert.equal(atLeast('0.18.2', '0.18.2'), true)
  assert.equal(atLeast('0.19.0', '0.18.2'), true)
  assert.equal(atLeast('1.2.1', '1.2.2'), false)
  assert.equal(atLeast('1.10.0', '1.2.2'), true)
})

test('every copy of a package with an advisory in the lock is at or above the release that fixed it', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, { version?: string }> }
  const below: string[] = []
  for (const [name, floor] of Object.entries(FLOORS)) {
    const copies = Object.entries(lock.packages).filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
    assert.ok(copies.length > 0, `${name} is in the lock`)
    for (const [path, entry] of copies) if (!atLeast(entry.version ?? '0.0.0', floor)) below.push(`${path} ${entry.version} < ${floor}`)
  }
  assert.deepEqual(below, [])
})

test('what the UI and its tools load, through each package that pulls it in, is at or above the fix', () => {
  const below: string[] = []
  for (const chain of PATHS) {
    let from = import.meta.url
    let found = { dir: '', version: '' }
    for (const name of chain) { found = installed(from, name); from = join(found.dir, 'package.json') }
    const name = chain.at(-1)!
    if (!atLeast(found.version, FLOORS[name]!)) below.push(`${chain.join(' > ')} ${found.version} < ${FLOORS[name]}`)
  }
  assert.deepEqual(below, [])
})
