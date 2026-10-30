import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BOTS } from '../src/state/outline.ts'
import { botAt, nextIndex, shuffled } from '../src/state/reel.ts'

test('the reel is every bot once, in the order the random source gives, and turns around', () => {
  let n = 0
  const order = shuffled(BOTS, () => (n += 0.37) % 1)
  assert.equal(order.length, BOTS.length)
  assert.deepEqual([...order].sort(), [...BOTS].sort())
  assert.notDeepEqual(order, [...BOTS])
  assert.deepEqual(shuffled(BOTS, () => 0.999), shuffled(BOTS, () => 0.999))
  assert.equal(nextIndex(0, 20), 1)
  assert.equal(nextIndex(19, 20), 0)
  assert.equal(nextIndex(3, 0), 0)
  assert.equal(botAt(order, BOTS.length), order[0])
  assert.equal(botAt(order, -1), order[BOTS.length - 1])
})
