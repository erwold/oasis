import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AXIS_H, LANE_H, layoutRelations, watchMarks, type Link } from '../src/state/relationsGraph.ts'
import { hoverChannel, indexLayout, laneRange, OVERSCAN, passingLine, VIRTUAL_ABOVE, viewOf } from '../src/state/relationsViewport.ts'
import { BIG_NOW, bigBoard } from './relationsFixtures.ts'

const shown = (l: Link) => l.kind === 'received' || l.kind === 'cited' || l.kind === 'dispatched'
// a board opened whole (the settled row shown): every lane of it laid out, with one handover from its top to its bottom
const opened = (lanes: number) => {
  const { graph } = bigBoard(lanes)
  const far = { id: 'far', kind: 'cited', from: { kind: 'run', id: 'r5b' }, to: { kind: 'run', id: `r${lanes - 10}a` }, basis: 'recorded', created_at: graph.runs[0]!.created_at }
  return layoutRelations({ ...graph, edges: [...graph.edges, far] as typeof graph.edges }, { width: 600, now: BIG_NOW, clock: () => '', expanded: true })
}

test('a board of no more than VIRTUAL_ABOVE lanes is drawn whole wherever the scroll stands', () => {
  assert.deepEqual(laneRange(VIRTUAL_ABOVE, 10_000, 300), { first: 0, last: VIRTUAL_ABOVE - 1 })
  assert.deepEqual(laneRange(0, 0, 300), { first: 0, last: -1 })
})

test('a long board keeps the lanes on screen and OVERSCAN around them; scrolled to its end, its last lane', () => {
  const height = 600
  const top = laneRange(1000, -200, height)                               // the board starts 200px under the top of the thread
  assert.equal(top.first, 0)
  assert.equal(top.last, Math.floor((height - 200 - AXIS_H) / LANE_H) + OVERSCAN)
  const middle = laneRange(1000, AXIS_H + 500 * LANE_H, height)
  assert.deepEqual(middle, { first: 500 - OVERSCAN, last: 500 + height / LANE_H + OVERSCAN })
  const end = laneRange(1000, AXIS_H + 1000 * LANE_H - height, height)
  assert.equal(end.last, 999)
  assert.ok(end.last - end.first + 1 <= height / LANE_H + 2 * OVERSCAN + 1)
  const below = laneRange(1000, AXIS_H + 2000 * LANE_H, height)            // the board scrolled out above the screen
  assert.deepEqual(below, { first: 999, last: 999 })
})

test('the lanes in range draw their bars, steps and clocks and the arrows with an end on them; what only passes them is counted', () => {
  const layout = opened(1000)
  const index = indexLayout(layout, shown)
  const marks = watchMarks(layout.bars, [{ run_id: 'r2b', label: 'timer' }, { run_id: 'r700b', label: 'exit' }])
  const range = laneRange(layout.lanes.length, AXIS_H + 700 * LANE_H, 600)
  const view = viewOf(index, marks, range)
  const ids = new Set(view.lanes.map((l) => l.id))
  assert.equal(view.lanes.length, range.last - range.first + 1)
  assert.ok(view.bars.every((b) => ids.has(b.lane)) && view.bars.length === 2 * view.lanes.length)
  assert.deepEqual(view.marks.map((m) => m.lane), ['p700'])
  assert.deepEqual(view.ghosts, [])
  // every arrow drawn has an end on a lane drawn
  assert.deepEqual(view.links.filter((l) => !ids.has(l.lane_from) && !ids.has(l.lane_to)).map((l) => l.id), [])
  // a dispatch is drawn with the bar it reaches: from the dispatcher's lane far above, to every bar in range and none other
  const dispatchedHere = view.links.filter((l) => l.kind === 'dispatched')
  assert.equal(dispatchedHere.length, 2 * view.lanes.length)
  assert.ok(dispatchedHere.every((l) => ids.has(l.lane_to)))
  // a handover between two lanes both above the range is not drawn; one into the range from just above is
  assert.ok(!view.links.some((l) => l.id === 'e10'))
  assert.ok(view.links.some((l) => l.id === `e${range.first}`))
  // the citation from far above to far below the screen passes it: counted with the dispatches to the agents below,
  // said over the board; still lit from either of its runs where an end of it is drawn
  assert.ok(!view.links.some((l) => l.id === 'far'))
  assert.deepEqual(view.passing, { dispatched: 2 * (layout.lanes.length - 1 - range.last), cited: 1 })
  assert.equal(passingLine(view.passing), `Not drawn here: ${(2 * (layout.lanes.length - 1 - range.last)).toLocaleString('en-US')} dispatches to agents below · 1 citation — their ends are off screen`)
  assert.ok(index.linksOfRun.get('r990a')!.some((l) => l.id === 'far') && index.linksOfRun.get('r5b')!.some((l) => l.id === 'far'))
  // the first lanes (the running agent, the step still to come) are back once the range comes back to the top
  const back = viewOf(index, marks, laneRange(layout.lanes.length, 0, 600))
  assert.deepEqual(back.ghosts.map((g) => g.lane), ['p1'])
  assert.deepEqual(back.marks.map((m) => m.lane), ['p2'])
  assert.ok(back.links.some((l) => l.id === 'far'))                         // its start is on screen now
  assert.equal(viewOf(index, marks, { first: 0, last: layout.lanes.length - 1 }).passing.dispatched, undefined)
  assert.equal(passingLine({}), null)
})

test('the same screen mounts the same number of lanes, bars and arrows on a board of 100, 300 or 1000 agents', () => {
  const budget = (lanes: number, at: 'top' | 'middle' | 'end') => {
    const layout = opened(lanes)
    const index = indexLayout(layout, shown)
    const top = at === 'top' ? 0 : at === 'middle' ? AXIS_H + Math.floor(layout.lanes.length / 2) * LANE_H : layout.height - 720
    const view = viewOf(index, watchMarks(layout.bars, []), laneRange(layout.lanes.length, top, 720))
    return { lanes: view.lanes.length, bars: view.bars.length, links: view.links.length, ghosts: view.ghosts.length }
  }
  for (const at of ['top', 'middle', 'end'] as const) {
    const sizes = [100, 300, 1000].map((n) => budget(n, at))
    // a screen of 720 px: 24 lanes and 6 on either side; on each, two bars, the dispatches to them and the handovers
    // of the agents next to each other (a crossing far citation, the dispatches below: counted, not drawn)
    for (const s of sizes) {
      assert.ok(s.lanes <= 720 / LANE_H + 2 * OVERSCAN + 1, JSON.stringify(s))
      assert.ok(s.bars <= 2 * s.lanes && s.links <= 4 * s.lanes, JSON.stringify(s))
    }
    assert.deepEqual(sizes[1], sizes[2], `${at}: ${JSON.stringify(sizes)}`)
  }
})

test('the pointer moving over bars tells the listeners only when the run under it changes; the rest is a move', () => {
  const hover = hoverChannel()
  let changes = 0, moves = 0
  hover.subscribe(() => changes++)
  hover.onMove(() => moves++)
  // 300 pointer moves over three bars, then off the board
  for (let i = 0; i < 300; i++) hover.set(`r${Math.floor(i / 100)}`, i)
  hover.set(null, 0)
  assert.equal(changes, 4)
  assert.equal(moves, 297)
  assert.equal(hover.run(), null)
})
