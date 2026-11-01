import assert from 'node:assert/strict'
import { test } from 'node:test'
import { COLLAPSED_PROJECTS_KEY, readCollapsedProjects, writeCollapsedProjects } from '../src/state/railPreferences.ts'

function storage(raw: string | null = null) {
  return { getItem: (_key: string) => raw, setItem: (key: string, value: string) => { assert.equal(key, COLLAPSED_PROJECTS_KEY); raw = value } }
}

test('folder disclosure defaults to expanded and tolerates missing, invalid or unavailable local storage', () => {
  for (const raw of [null, '', 'broken', 'null', 'false', '42', '{}', '"p"']) {
    assert.equal(readCollapsedProjects(storage(raw)).size, 0)
  }
  assert.equal(readCollapsedProjects(null).size, 0)
  const denied = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') } }
  assert.equal(readCollapsedProjects(denied).size, 0)
  assert.doesNotThrow(() => writeCollapsedProjects(denied, new Set(['p'])))
  assert.doesNotThrow(() => writeCollapsedProjects(null, new Set(['p'])))
})

test('only project ids are persisted, independently of loading/order/activity and without mutating the held set', () => {
  const disk = storage('["p", "no-folder", "p", null, 5, {}, "", "constructor", "__proto__"]')
  const held = readCollapsedProjects(disk)
  assert.deepEqual([...held], ['p', 'no-folder', 'constructor', '__proto__'])
  const next = new Set(held)
  next.delete('p'); next.add('not-currently-loaded')
  writeCollapsedProjects(disk, next)
  assert.ok(held.has('p'))
  assert.deepEqual(readCollapsedProjects(disk), next)
  writeCollapsedProjects(disk, new Set())
  assert.equal(readCollapsedProjects(disk).size, 0)
})
