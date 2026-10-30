/** The page shell: every file index.html names by a root path is one the build serves (frontend/public). */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

test('every root-path href and src in index.html is a file of frontend/public', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const named = [...html.matchAll(/\b(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1]!).filter((path) => !path.startsWith('/src/'))
  assert.ok(named.includes('/favicon.png'))
  for (const path of named) assert.ok(existsSync(new URL(`../public${path}`, import.meta.url)), `${path} is not in frontend/public`)
})
