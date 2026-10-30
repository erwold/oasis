import assert from 'node:assert/strict'
import { test } from 'node:test'
import { useDesk, cardKeptOnUndock, cardsAtRest, cardsOverflowing, fitDesk, fitGrid, floorAt, frontRun, nearestCorner, placeDock, placeStack, placeTail, resizeFrom, TITLE_H, GAP } from '../src/state/desk.ts'

const card = { w: 400, h: 300 }

test('a stack in a corner: the front card in the corner, strips in a column, steps in a cascade, tiles in a grid', () => {
  const column = placeStack(3, 'tr', card, 1200, 800, 'column')
  assert.deepEqual([column[0].x, column[0].y, column[0].depth, column[0].collapsed], [1200 - GAP - 400, GAP, 0, false])
  assert.equal(column[1].h, TITLE_H)
  assert.ok(column[1].y > column[0].y + card.h && column[2].y > column[1].y && column[1].collapsed)
  const up = placeStack(2, 'br', card, 1200, 800, 'column')
  assert.ok(up[1].y < up[0].y, 'from a bottom corner the column runs up')
  const cascade = placeStack(3, 'tl', card, 1200, 800, 'cascade')
  assert.ok(cascade[1].x > cascade[0].x && cascade[1].y > cascade[0].y && !cascade[1].collapsed)
  const grid = placeStack(4, 'tr', card, 1200, 800, 'grid')
  assert.ok(grid.every((p) => p.depth === 0 && p.w <= card.w && p.w >= 160))
  assert.equal(new Set(grid.map((p) => `${p.x},${p.y}`)).size, 4)
  assert.equal(fitGrid(1, card, 1200, 800).cols, 1)
})

test('the tail hangs after the last card and stays on the desk; a dock sits in its corner', () => {
  const tail = placeTail(2, 'tr', card, 1200, 800, 'column')
  const strips = placeStack(3, 'tr', card, 1200, 800, 'column')
  assert.deepEqual(tail, { x: strips[2].x, y: strips[2].y })
  const tall = placeTail(40, 'tr', card, 1200, 400, 'column')
  assert.ok(tall.y <= 400 - GAP - 30)
  assert.deepEqual(placeDock('br', { w: 300, h: 260 }, 1200, 800), { x: 1200 - GAP - 300, y: 800 - GAP - 260 })
  assert.equal(nearestCorner(1100, 700, 1200, 800), 'br')
  assert.equal(nearestCorner(10, 10, 1200, 800), 'tl')
})

test('a resize grows away from the corner, and the front run is the top unshelved card', () => {
  assert.deepEqual(resizeFrom('sw', 'tr', card, -20, 30), { w: 420, h: 330 })
  assert.deepEqual(resizeFrom('e', 'tl', card, 20, 999), { w: 420, h: 300 })
  assert.deepEqual(resizeFrom('n', 'br', card, 999, -10), { w: 400, h: 310 })
  const windows = {
    'run:a': { id: 'run:a', kind: 'run' as const, runId: 'a', z: 2, min: false },
    'run:b': { id: 'run:b', kind: 'run' as const, runId: 'b', z: 5, min: true },
    workspace: { id: 'workspace', kind: 'workspace' as const, z: 9, min: false },
  }
  assert.equal(frontRun(windows), 'a')
})

test('a bottom card beside the composer sits at the desk bottom; one reaching over it stops above it', () => {
  const keep = { right: 900, h: 120 }                                           // the composer: 900 px wide, 120 px tall
  // wide desk: the graph (320 wide) in the bottom-right corner is wholly right of the composer
  const wide = placeDock('br', { w: 320, h: 300 }, 1600, 900, keep)
  assert.equal(wide.y + 300 + GAP, 900)
  // narrow desk: the same corner reaches left of the composer's edge, so it clears its top
  const narrow = placeDock('br', { w: 320, h: 300 }, 1000, 900, keep)
  assert.equal(narrow.y + 300 + GAP, 900 - 120)
  // the left corners always clear it; the top corners and no composer are as before
  assert.equal(placeDock('bl', { w: 320, h: 300 }, 1600, 900, keep).y + 300 + GAP, 780)
  assert.deepEqual(placeDock('tr', { w: 320, h: 300 }, 1600, 900, keep), placeDock('tr', { w: 320, h: 300 }, 1600, 900))
  assert.equal(floorAt(1200, 900, null), 900)
  // a stack's front card follows the same rule
  const [front] = placeStack(1, 'br', { w: 400, h: 500 }, 1600, 900, 'column', keep)
  assert.equal(front!.y + 500 + GAP, 900)
  const [over] = placeStack(1, 'br', { w: 400, h: 500 }, 1200, 900, 'column', keep)
  assert.equal(over!.y + 500 + GAP, 780)
})

test('a narrow desk shows the card and the dock within it, one above the other, with only the strips that fit', () => {
  // the desktop app's narrowest window: 720 wide, the rail 260 of it, the desk 40 high less than the window
  const wide = fitDesk({ w: 420, h: 340 }, { w: 300, h: 260 }, 'tr', 'br', 'column', 1200, 720, null)
  assert.deepEqual([wide.card, wide.graph, wide.graphCorner, wide.narrow], [{ w: 420, h: 340 }, { w: 300, h: 260 }, 'br', false])
  // the stack top right, the dock bottom right: one side's height shared — the strips stop above the dock
  const strips = (fit: ReturnType<typeof fitDesk>, n: number) => placeStack(Math.min(n, fit.maxDepth + 1), 'tr', fit.card, 1200, 720, 'column')
  const dockTop = placeDock('br', wide.graph, 1200, 720, null).y
  for (const n of [1, 2, 3, 6]) {
    const fit = fitDesk({ w: 420, h: 340 }, { w: 300, h: 260 }, 'tr', 'br', 'column', 1200, 720, null, n)
    const placed = strips(fit, n)
    assert.ok(Math.max(...placed.map((p) => p.y + p.h)) + GAP <= dockTop, `${n} cards: the stack clears the dock`)
  }
  // on opposite sides the two never meet: the person's card and every strip stay
  assert.equal(fitDesk({ w: 420, h: 340 }, { w: 300, h: 260 }, 'tr', 'bl', 'column', 1200, 720, null, 6).maxDepth, 8)
  const narrow = fitDesk({ w: 420, h: 340 }, { w: 300, h: 260 }, 'tr', 'br', 'column', 391, 723, { right: 391, h: 110 }, 2)
  assert.equal(narrow.narrow, true)
  assert.ok(narrow.card.w <= 391 - 24, 'the card fits the desk')
  assert.ok(narrow.graph.w <= 391 - 24, 'the dock fits the desk')
  assert.equal(narrow.graphCorner, 'br')                                             // the stack at the top: the dock at the bottom
  assert.ok(narrow.graph.h <= Math.floor(723 * 0.4))
  // the front card, its strips, the dock and the composer share the height without meeting
  const pitch = 34 + 8
  assert.ok(12 + narrow.card.h + narrow.maxDepth * pitch + 12 + narrow.graph.h + 110 + 12 <= 723 + 30, 'nothing overlaps')
  assert.ok(narrow.maxDepth < 8)
  assert.equal(narrow.maxDepth, 1)                                                    // two cards: the workspace's strip stays under the front card
  assert.ok(narrow.card.h >= 140 && narrow.card.h < 340)
  // a stack at the bottom sends the dock to the top, on the dock's own side
  assert.equal(fitDesk({ w: 420, h: 340 }, { w: 300, h: 260 }, 'br', 'bl', 'column', 391, 723, null).graphCorner, 'tl')
  // a desk too small for even the minimum: the minimum, never negative
  const tiny = fitDesk({ w: 420, h: 340 }, { w: 300, h: 260 }, 'tr', 'br', 'column', 300, 300, null)
  assert.ok(tiny.card.w >= 220 && tiny.card.h >= 140 && tiny.graph.h >= 160 && tiny.maxDepth >= 0)
})

test('a dock put away on the shelf takes no height: the card is as tall as the person makes it, every strip stays', () => {
  const tall = { w: 420, h: 640 }
  const docked = fitDesk(tall, { w: 300, h: 260 }, 'tr', 'br', 'column', 1200, 720, null, 3)
  const shelved = fitDesk(tall, { w: 300, h: 260 }, 'tr', 'br', 'column', 1200, 720, null, 3, false)
  assert.ok(docked.card.h < 400, 'beside the dock the card clears it')
  assert.equal(shelved.card.h, 640)
  assert.equal(shelved.maxDepth, 8)
  // on a narrow desk the card takes the height the dock left, still clear of the composer
  const narrow = fitDesk(tall, { w: 300, h: 260 }, 'tr', 'br', 'column', 391, 723, { right: 391, h: 110 }, 1, false)
  const narrowDocked = fitDesk(tall, { w: 300, h: 260 }, 'tr', 'br', 'column', 391, 723, { right: 391, h: 110 }, 1)
  assert.ok(narrow.card.h > narrowDocked.card.h + 200)
  assert.ok(12 + narrow.card.h + 12 + 110 <= 723 + 30, 'the card clears the composer')
})

test('putting the dock away keeps the card where it was: the height shown beside the dock becomes its own', () => {
  const tall = { w: 420, h: 640 }
  const docked = fitDesk(tall, { w: 300, h: 260 }, 'tr', 'br', 'column', 1200, 720, null, 1)
  const kept = cardKeptOnUndock(docked.card, tall)
  assert.deepEqual(kept, { w: 420, h: docked.card.h })
  assert.equal(fitDesk(kept!, { w: 300, h: 260 }, 'tr', 'br', 'column', 1200, 720, null, 1, false).card.h, docked.card.h)
  assert.equal(cardKeptOnUndock(docked.card, { w: 420, h: 300 }), null)            // a card shorter than the room it had
  assert.equal(cardKeptOnUndock(null, tall), null)                                 // no dock was shown
})

test("a session opens with its finished agents' cards put away: only agents' cards, only those at rest, none twice", () => {
  const windows = {
    workspace: { id: 'workspace', kind: 'workspace' as const, z: 1, min: false },
    graph: { id: 'graph', kind: 'graph' as const, z: 2, min: false },
    'run:a': { id: 'run:a', kind: 'run' as const, runId: 'a', z: 3, min: false },
    'run:b': { id: 'run:b', kind: 'run' as const, runId: 'b', z: 4, min: false },
    'run:c': { id: 'run:c', kind: 'run' as const, runId: 'c', z: 5, min: true },
    'run:x': { id: 'run:x', kind: 'run' as const, z: 6, min: false },
  }
  const resting = new Set(['a', 'c', 'x'])
  assert.deepEqual(cardsAtRest(windows, (id) => resting.has(id)), ['run:a'])
  assert.deepEqual(cardsAtRest(windows, () => false), [])
})

test('a stack too deep shelves its oldest finished cards, never the front one the person just brought forward', () => {
  const card = (id: string, done: boolean) => ({ id, done })
  const resting = (w: { done: boolean }) => w.done
  // the person clicked a finished agent: it is at the front; the cards behind it are live
  const stack = [card('picked', true), card('live1', false), card('live2', false), card('live3', false)]
  assert.deepEqual(cardsOverflowing(stack, resting, 2, false), [])
  // finished cards behind the front go first, the oldest (the back) first
  const mixed = [card('front', true), card('newer', true), card('live', false), card('older', true)]
  assert.deepEqual(cardsOverflowing(mixed, resting, 1, false).map((w) => w.id), ['older', 'newer'])
  // a narrow desk sends whatever does not fit behind the front, finished first
  assert.deepEqual(cardsOverflowing(stack, resting, 1, true).map((w) => w.id), ['live3', 'live2'])
  assert.deepEqual(cardsOverflowing(stack, resting, 8, false), [])
})

test('a new session opens with the Agent Teams dock on the shelf; every other window comes out', () => {
  const desk = useDesk.getState()
  desk.openSession('s-teams-shelved')
  desk.ensure('graph', 'graph')
  desk.ensure('workspace', 'workspace')
  desk.ensure('run:a', 'run', 'a')
  const { windows } = useDesk.getState()
  assert.deepEqual([windows.graph!.min, windows.workspace!.min, windows['run:a']!.min], [true, false, false])
  useDesk.getState().setMin('graph', false)
  useDesk.getState().ensure('graph', 'graph')
  assert.equal(useDesk.getState().windows.graph!.min, false, 'taken back, it stays out')
})
