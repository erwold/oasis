import test from 'node:test'
import assert from 'node:assert/strict'
import { createConnectionTracker } from '../src/state/runConnections.ts'

test('an unwatched run has no live connection', () => {
  const c = createConnectionTracker()
  assert.equal(c.snapshot(null), 'closed')
  assert.equal(c.snapshot('a'), 'closed')
})
test('connection state moves from connecting to connected to reconnecting', () => {
  const c = createConnectionTracker(), owner = Symbol()
  for (const state of ['connecting', 'connected', 'reconnecting', 'closed'] as const) {
    c.set('a', owner, state)
    assert.equal(c.snapshot('a'), state)
  }
})
test('closing an older watcher does not erase a newer connection', () => {
  const c = createConnectionTracker(), old = Symbol(), current = Symbol()
  c.set('a', old, 'reconnecting'); c.set('a', current, 'connected')
  assert.equal(c.snapshot('a'), 'connected')
  c.set('a', old, 'closed')
  assert.equal(c.snapshot('a'), 'connected')
  c.set('a', current, 'closed')
  assert.equal(c.snapshot('a'), 'closed')
})
test('closing an unknown owner is harmless', () => {
  const c = createConnectionTracker(), owner = Symbol()
  c.set('a', owner, 'connected'); c.set('a', Symbol(), 'closed')
  assert.equal(c.snapshot('a'), 'connected')
})
test('duplicate status reports do not notify; unsubscribe releases the listener', () => {
  const c = createConnectionTracker(), owner = Symbol()
  let count = 0
  const remove = c.subscribe(() => { count += 1 })
  c.set('a', owner, 'connected'); c.set('a', owner, 'connected')
  assert.equal(count, 1)
  remove(); c.set('a', owner, 'closed')
  assert.equal(count, 1)
})
test('runs have independent connection states', () => {
  const c = createConnectionTracker(), owner = Symbol()
  c.set('a', owner, 'connected'); c.set('b', owner, 'reconnecting')
  assert.equal(c.snapshot('a'), 'connected')
  assert.equal(c.snapshot('b'), 'reconnecting')
  c.set('a', owner, 'closed')
  assert.equal(c.snapshot('b'), 'reconnecting')
})
