/** A dense live chart, pure: per-pixel-column thinning that keeps the data's order, its spikes and ends, and never
 *  joins the two sides of a gap; a cursor that reads the raw point; colours that stay with a series id; a values table
 *  built one bounded page at a time. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { numberText, seriesGeometry, seriesOf, type SeriesView } from '../src/state/uiChart.ts'
import { assignColors, chartXs, latestValues, nearestIndex, seriesTablePage, thinRun, valuesAt, type PlotPoint } from '../src/state/uiChartDense.ts'

const view = (id: string, values: (number | null)[], x0 = 0): SeriesView =>
  ({ id, label: id, dashed: false, color: 0, points: values.map((v, i) => ({ x: x0 + i, value: v, text: v === null ? 'no value' : String(v) })) })
const moves = (path: string) => path.match(/[ML]-?[\d.]+ -?[\d.]+/g) ?? []

test('thinning: one column of many points keeps first, lowest, highest and last, in the data order; the input is untouched', () => {
  const run: PlotPoint[] = [5, 3, 9, 1, 4, 7, 2].map((y, i) => ({ x: 0.1 * i, y, i }))
  const copy = JSON.parse(JSON.stringify(run))
  const kept = thinRun(run, 10)
  assert.deepEqual(kept.map((p) => p.i), [0, 2, 3, 6], 'first, the highest y (9), the lowest y (1), last — by index')
  assert.deepEqual(run, copy)
  // four or fewer per column: as they are
  const sparse: PlotPoint[] = [1, 2, 3, 4].map((y, i) => ({ x: i * 0.2, y, i }))
  assert.deepEqual(thinRun(sparse, 10), sparse)
})

test('a dense series: a one-sample spike, both ends and every column are kept; output is in x order', () => {
  const n = 2000
  const values = Array.from({ length: n }, (_, i) => (i === 1234 ? 500 : Math.sin(i / 50)))
  const g = seriesGeometry([view('a', values)], 'number', 200, 100, 200)
  const line = g.lines[0]!
  assert.ok(line.drawn < n && line.drawn <= 200 * 4, `thinned: ${line.drawn}`)
  const xs = moves(line.path).map((m) => Number(m.slice(1).split(' ')[0]))
  assert.ok(xs.every((x, i) => i === 0 || x >= xs[i - 1]!), 'never back on x')
  const ys = moves(line.path).map((m) => Number(m.split(' ')[1]))
  assert.equal(Math.min(...ys), line.dots[1234]!.y, 'the spike is drawn')
  assert.equal(moves(line.path)[0], `M${line.dots[0]!.x} ${line.dots[0]!.y}`)
  assert.equal(moves(line.path).at(-1), `L${line.dots[n - 1]!.x} ${line.dots[n - 1]!.y}`)
  assert.equal(line.dots.length, n, 'the cursor still has every point')
  assert.equal(line.marks.length, 0, 'no dot per point on a dense line')
  assert.equal(line.latest!.point.x, n - 1)
})

test('a gap is never joined, even when both its sides fall in one pixel column', () => {
  const values: (number | null)[] = Array.from({ length: 1000 }, (_, i) => i % 3)
  values[500] = null
  const g = seriesGeometry([view('a', values)], 'number', 10, 100, 10)     // 100 points per column
  const path = g.lines[0]!.path
  assert.equal((path.match(/M/g) ?? []).length, 2, 'the pen lifts at the gap')
  // the run before the gap ends at point 499; the next one starts at point 501
  const parts = path.split('M').filter(Boolean).map((p) => p.trim())
  const lastBefore = parts[0]!.split(/L/).at(-1)!.trim()
  const firstAfter = parts[1]!.split(/L/)[0]!.trim()
  assert.equal(lastBefore, `${g.lines[0]!.dots[499]!.x} ${g.lines[0]!.dots[499]!.y}`)
  assert.equal(firstAfter, `${g.lines[0]!.dots[500]!.x} ${g.lines[0]!.dots[500]!.y}`, 'dots skip the gap: dot 500 is point 501')
  assert.equal(g.lines[0]!.dots[500]!.point.x, 501)
  // a point alone between two gaps is a mark (the line cannot show it)
  const lone = seriesGeometry([view('b', [...Array.from({ length: 400 }, () => 1), null, 7, null, ...Array.from({ length: 400 }, () => 1)])], 'number', 100, 100)
  assert.deepEqual(lone.lines[0]!.marks.map((m) => m.point.x), [401])
})

test('the cursor lands on an x the data has and reads each series\' raw point there', () => {
  const series = seriesOf([
    { id: 'loss', label: 'loss', data: [{ x: 10, value: 0.123456789 }, { x: 20, value: null }, { x: 30, value: 0.5 }] },
    { id: 'acc', label: 'acc', data: [{ x: 20, value: 0.9 }, { x: 40, value: 0.95 }] },
  ], {})
  const xs = chartXs(series)
  assert.deepEqual(xs, [10, 20, 30, 40])
  assert.equal(xs[nearestIndex(xs, 24)!], 20)
  assert.equal(xs[nearestIndex(xs, 25)!], 20, 'a tie goes to the earlier x')
  assert.equal(xs[nearestIndex(xs, 1e9)!], 40)
  assert.equal(nearestIndex([], 3), null)
  const at10 = valuesAt(series, 10)
  assert.equal(at10[0]!.point!.value, 0.123456789, 'the raw value, not rounded')
  assert.equal(at10[1]!.point, null, 'no point of its own there: nothing interpolated')
  assert.equal(valuesAt(series, 20)[0]!.point!.value, null, 'a gap reads as a gap')
  assert.deepEqual(latestValues(series).map((v) => v.point?.x), [30, 40])
})

test('colours stay with a series id when a later revision puts another series before it', () => {
  const first = assignColors(new Map(), ['loss', 'reward'])
  assert.deepEqual([...first], [['loss', 0], ['reward', 1]], 'a first drawing: by place')
  const next = assignColors(first, ['kl', 'loss', 'reward'])
  assert.deepEqual([next.get('loss'), next.get('reward'), next.get('kl')], [0, 1, 2])
  assert.deepEqual([...first], [['loss', 0], ['reward', 1]], 'the previous map is not changed')
  const dropped = assignColors(next, ['reward', 'lr'])
  assert.deepEqual([dropped.get('reward'), dropped.get('lr')], [1, 0], 'a freed slot is taken again')
})

test('the values table: a bounded page, the newest by default, exact numbers', () => {
  const series = [view('a', Array.from({ length: 250 }, (_, i) => i / 3))]
  const last = seriesTablePage(series, 'number', null)
  assert.deepEqual([last.total, last.pages, last.page, last.from, last.to, last.xs.length], [250, 3, 2, 200, 250, 50])
  assert.equal(last.cells.at(-1)![0], String(249 / 3))
  const first = seriesTablePage(series, 'number', 0)
  assert.deepEqual([first.xs[0]!.text, first.xs.length], ['0', 100])
  assert.equal(seriesTablePage(series, 'number', 99).page, 2, 'a page past the end is the last')
})

test('numbers at a glance keep what they say: small magnitudes in exponent form, the rest as before', () => {
  assert.deepEqual([1e-7, -2.5e-5, 0.00012345678, 0.001, 0, 1234.5678912, -0.5].map(numberText), ['1e-7', '-2.5e-5', '1.235e-4', '0.001', '0', '1,234.567891', '-0.5'])
  const ticks = seriesGeometry([view('lr', [1e-7, 2e-7, 3e-7])], 'number', 100, 100).yTicks
  assert.ok(ticks.length > 1 && ticks.every((t) => t.text !== '0' || t.value === 0), ticks.map((t) => t.text).join(','))
})
