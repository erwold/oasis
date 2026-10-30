import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as desktop from '../src/state/desktop.ts'

const api = desktop as unknown as {
  browserFrameSize?: (width: number, height: number) => { width: number; height: number }
  browserPoint?: (rect: { left: number; top: number; width: number; height: number }, x: number, y: number, dragging?: boolean) => { x: number; y: number } | null
  browserWheel?: (x: number, y: number, mode: number) => { deltaX: number; deltaY: number }
}
function need<T>(value: T | undefined): T { assert.equal(typeof value, 'function', 'the fixed desktop mirror has its geometry helpers'); return value as T }

test('the full desktop frame fits small, tall and wide cards, never enlarges beyond 1×, and survives folding', () => {
  const fit = need(api.browserFrameSize)
  assert.deepEqual(fit(457, 356), { width: 457, height: 286 })
  assert.deepEqual(fit(480, 600), { width: 480, height: 300 })
  assert.deepEqual(fit(1200, 400), { width: 640, height: 400 })
  assert.deepEqual(fit(1600, 1200), { width: 1280, height: 800 })
  assert.deepEqual(fit(457, 0), { width: 0, height: 0 })
  assert.deepEqual(fit(457, 356), { width: 457, height: 286 })
})

test('image coordinates map every card scale to the same page; blank space is ignored and captured drags release at an edge', () => {
  const point = need(api.browserPoint)
  for (const [width, height] of [[457, 286], [640, 400], [1280, 800]]) {
    const rect = { left: 150, top: 90, width: width!, height: height! }
    assert.deepEqual(point(rect, 150 + width! / 2, 90 + height! / 2), { x: 640, y: 400 })
    assert.deepEqual(point(rect, 150, 90), { x: 0, y: 0 })
    assert.equal(point(rect, 149, 90), null)
    assert.equal(point(rect, 150, 90 + height!), null)
    assert.deepEqual(point(rect, 149, 90 + height! + 20, true), { x: 0, y: 799 })
    assert.deepEqual(point(rect, 150 + width! + 20, 89, true), { x: 1279, y: 0 })
  }
  assert.equal(point({ left: 0, top: 0, width: 0, height: 0 }, 0, 0, true), null)
})

test('wheel events keep page CSS distances across scales and convert line/page units', () => {
  const wheel = need(api.browserWheel)
  assert.deepEqual(wheel(8, 120, 0), { deltaX: 8, deltaY: 120 })
  assert.deepEqual(wheel(1, 3, 1), { deltaX: 16, deltaY: 48 })
  assert.deepEqual(wheel(0, 1, 2), { deltaX: 0, deltaY: 800 })
})
