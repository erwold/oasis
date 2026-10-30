import assert from 'node:assert/strict'
import { test } from 'node:test'
import { frameBatch, type Schedule } from '../src/state/frameBatch.ts'

/** A schedule the test runs by hand: what is due, and how often a frame was asked for. */
function manual(): { schedule: Schedule; tick: () => void; asked: () => number } {
  let due: (() => void) | null = null
  let asked = 0
  return {
    schedule: (run) => { asked += 1; due = run; return () => { due = null } },
    tick: () => { const run = due; due = null; run?.() },
    asked: () => asked,
  }
}

test('a burst of events is applied once, in order, on the next frame', () => {
  const clock = manual()
  const applied: number[][] = []
  const batch = frameBatch<number>((items) => applied.push(items), clock.schedule)
  for (let i = 0; i < 500; i += 1) batch.push(i)
  assert.equal(applied.length, 0)
  assert.equal(clock.asked(), 1)
  clock.tick()
  assert.equal(applied.length, 1)
  assert.deepEqual(applied[0], Array.from({ length: 500 }, (_, i) => i))
  batch.push(500)
  assert.equal(clock.asked(), 2)
  clock.tick()
  assert.deepEqual(applied[1], [500])
})

test('a flush applies what waits at once and the frame then finds nothing; a cancel drops it', () => {
  const clock = manual()
  const applied: string[][] = []
  const batch = frameBatch<string>((items) => applied.push(items), clock.schedule)
  batch.push('a'); batch.push('b')
  batch.flush()
  assert.deepEqual(applied, [['a', 'b']])
  clock.tick()
  batch.flush()
  assert.equal(applied.length, 1)
  batch.push('c')
  batch.cancel()
  clock.tick()
  batch.flush()
  assert.equal(applied.length, 1)
})

test('the default schedule applies without frames (a timer stands in)', async () => {
  const applied: number[][] = []
  const batch = frameBatch<number>((items) => applied.push(items))
  batch.push(1); batch.push(2)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(applied, [[1, 2]])
})
