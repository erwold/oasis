import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UI_LIMITS, parseUiSurfaceSpec, uiChartPointCount, type UiChartSeries } from '@oasis-code/contract'
import {
  chartPoints, latestX, numberTicks, posOf, seriesGeometry, seriesOf, seriesSummary, seriesTable, timeTicks, utcText,
  type SeriesGeometry,
} from '../src/state/uiChart.ts'
import { calculator } from './uiFixtures.ts'

const H = 3_600_000
const T0 = Date.UTC(2026, 9, 12, 0, 0, 0)            // 2026-10-12T00:00:00Z

/** A native spec with one chart element of these props (the contract's whole parser is the judge). */
const chartSpec = (props: Record<string, unknown>) => calculator({
  root: 'c', initial_state: {}, actions: [], elements: { c: { type: 'chart', props } },
})

const series = (id: string, data: { x: number; value: unknown }[], over: Partial<UiChartSeries> = {}): UiChartSeries =>
  ({ id, label: id.toUpperCase(), data, ...over }) as UiChartSeries

/** Every number a geometry holds, for the "no NaN, no Infinity" checks. */
function numbersOf(g: SeriesGeometry): number[] {
  const out: number[] = [g.x.lo, g.x.hi, g.x.unit, g.y.lo, g.y.hi, g.y.unit]
  for (const t of [...g.xTicks, ...g.yTicks]) out.push(t.pos, t.value)
  for (const l of g.lines) {
    for (const d of l.dots) out.push(d.x, d.y)
    for (const n of l.path.match(/-?[\d.]+(e[-+]?\d+)?/g) ?? []) out.push(Number(n))
  }
  return out
}

test('the contract takes a series chart, and keeps the old data chart exactly as it was', () => {
  const ok = chartSpec({ kind: 'line', x_axis: 'time', label: 'BTC', y_label: 'USD', series: [
    series('a', [{ x: T0, value: 1 }, { x: T0 + H, value: null }]), series('b', [], { line_style: 'dashed' }),
  ] })
  assert.ok(parseUiSurfaceSpec(ok).ok)
  assert.ok(parseUiSurfaceSpec(chartSpec({ kind: 'bar', data: [{ label: 'Q1', value: 3 }] })).ok, 'legacy data chart')
  // one of data / series; series only for a line; x_axis only (and always) with series; increasing x
  for (const bad of [
    { kind: 'line', x_axis: 'time', data: [{ label: 'a', value: 1 }], series: [series('a', [])] },
    { kind: 'bar', x_axis: 'number', series: [series('a', [])] },
    { kind: 'line', series: [series('a', [])] },
    { kind: 'line', x_axis: 'number', data: [{ label: 'a', value: 1 }] },
    { kind: 'line', x_axis: 'number', series: [series('a', [{ x: 2, value: 1 }, { x: 2, value: 3 }])] },
    { kind: 'line', x_axis: 'time', series: [series('a', [{ x: T0 + 0.5, value: 1 }])] },
    { kind: 'line', x_axis: 'number', series: [series('a', []), series('a', [])] },
  ]) assert.equal(parseUiSurfaceSpec(chartSpec(bad)).ok, false, JSON.stringify(bad).slice(0, 100))
})

test('the point bound is for every series together (2048 in all), never per series; the spec size bound still holds', () => {
  assert.equal(UI_LIMITS.chartPoints, 2048)
  const many = (id: string, n: number, at: (i: number) => { x: number; value: unknown } = (i) => ({ x: i, value: i })) => series(id, Array.from({ length: n }, (_, i) => at(i)))
  const line = (s: UiChartSeries[]) => parseUiSurfaceSpec(chartSpec({ kind: 'line', x_axis: 'number', series: s }))
  const fits = [many('a', 1000), many('b', 1000), many('c', 48)]
  assert.equal(uiChartPointCount({ series: fits }), UI_LIMITS.chartPoints)
  assert.ok(line(fits).ok)
  const over = line([many('a', 1000), many('b', 1000), many('c', 49)])
  assert.equal(over.ok, false)
  assert.match(over.ok ? '' : over.errors.join('\n'), /2049 points in all, more than 2048/)
  assert.equal(line([many('a', 2049)]).ok, false, 'one series alone')
  // the labelled shape: the same bound
  const labelled = (n: number) => parseUiSurfaceSpec(chartSpec({ kind: 'bar', data: Array.from({ length: n }, (_, i) => ({ label: `s${i}`, value: i })) }))
  assert.ok(labelled(2048).ok)
  assert.equal(labelled(2049).ok, false)
  // 2048 long numbers exceed the spec's 100,000 characters: the size bound is not lifted with the point bound
  const wide = line([many('a', 2048, (i) => ({ x: 1e15 + i, value: -1.2345678901234567e-200 }))])
  assert.equal(wide.ok, false)
  assert.match(wide.ok ? '' : wide.errors.join('\n'), /characters as JSON, more than 100000/)
  // what the page draws is bounded the same way even for a record it is handed as is
  const drawn = seriesOf([many('a', 1200), many('b', 1200), many('c', 10)], {})
  assert.deepEqual(drawn.map((s) => s.points.length), [1200, 848, 0])
  const nine = Array.from({ length: 9 }, (_, i) => many(`s${i}`, 1))
  assert.equal(seriesOf(nine, {}).length, UI_LIMITS.chartSeries)
})

test('series share one x range and one y range; each keeps its colour by its place and its line style', () => {
  const view = seriesOf([
    series('low', [{ x: T0, value: 10 }, { x: T0 + 2 * H, value: 20 }]),
    series('high', [{ x: T0 + H, value: 100 }, { x: T0 + 3 * H, value: 90 }], { line_style: 'dashed' }),
  ], {})
  assert.deepEqual(view.map((s) => [s.color, s.dashed]), [[0, false], [1, true]])
  const g = seriesGeometry(view, 'time', 300, 100)
  // x: from the first point of any series to the last of any
  assert.equal(posOf(T0, g.x), 0)
  assert.equal(posOf(T0 + 3 * H, g.x), 1)
  // y: both series' values inside, the lowest under the highest, on the same scale
  const ys = g.lines.flatMap((l) => l.dots.map((d) => d.y))
  assert.ok(ys.every((y) => y >= 0 && y <= 100))
  const [low, high] = g.lines
  assert.ok(low!.dots[0]!.y > high!.dots[1]!.y, '10 is drawn below 90')
  assert.ok(high!.dots[1]!.y > high!.dots[0]!.y, '90 below 100')
  // the y range is the values' own (a price need not start at zero), padded a little
  assert.ok(g.y.lo * g.y.unit > 0 && g.y.lo * g.y.unit < 10)
  assert.ok(numbersOf(g).every(Number.isFinite))
})

test('a value that is none is a gap in its line — never drawn as zero — and a point alone between gaps still shows', () => {
  const view = seriesOf([series('a', [
    { x: 1, value: 5 }, { x: 2, value: 6 }, { x: 3, value: null }, { x: 4, value: 7 }, { x: 5, value: 'n/a' }, { x: 6, value: { state: 'later' } }, { x: 7, value: 8 },
  ])], { later: 'unknown' })
  assert.deepEqual(view[0]!.points.map((p) => p.value), [5, 6, null, 7, null, null, 8])
  const g = seriesGeometry(view, 'number', 100, 100)
  const line = g.lines[0]!
  assert.equal(line.path.match(/M/g)!.length, 3, 'three runs of the pen: 1–2, 4, 7')
  assert.equal(line.dots.length, 4)
  assert.ok(g.y.lo * g.y.unit > 0, 'no zero came into the range')
  const table = seriesTable(view, 'number')
  assert.deepEqual(table.cells.map((r) => r[0]), ['5', '6', 'no value', '7', 'no value', 'no value', '8'])
})

test('a time axis is UTC: round ticks on whole hours, exact moments in the table and the words', () => {
  const view = seriesOf([series('p', [{ x: T0, value: 1 }, { x: T0 + 6 * H, value: 2 }]), series('q', [{ x: T0 + 90 * 60_000, value: 1.5 }])], {})
  const g = seriesGeometry(view, 'time', 300, 100)
  assert.ok(g.xTicks.length >= 3 && g.xTicks.length <= 7)
  for (const t of g.xTicks) {
    assert.equal(t.value % H, 0, 'on a whole UTC hour')
    assert.equal(t.text, `${String(new Date(t.value).getUTCHours()).padStart(2, '0')}:00`, 'said in UTC, whatever the local zone')
  }
  assert.equal(utcText(T0 + 90 * 60_000), '2026-10-12 01:30:00 UTC')
  assert.equal(utcText(T0 + 1), '2026-10-12 00:00:00.001 UTC')
  const table = seriesTable(view, 'time')
  assert.deepEqual(table.xs.map((x) => x.text), ['2026-10-12 00:00:00 UTC', '2026-10-12 01:30:00 UTC', '2026-10-12 06:00:00 UTC'], 'every x of any series, in order')
  assert.deepEqual(table.cells, [['1', ''], ['', '1.5'], ['2', '']], "a series without a point at an x has nothing there")
  assert.equal(latestX(view), T0 + 6 * H)
  assert.match(seriesSummary('BTC', view, 'time'), /^BTC: 2 series from 2026-10-12 00:00:00 UTC to 2026-10-12 06:00:00 UTC; latest: P 2 at 2026-10-12 06:00:00 UTC; Q 1\.5 at/)
  // days apart: the day is said; a single moment: half an hour either side
  const days = seriesGeometry(seriesOf([series('d', [{ x: T0, value: 1 }, { x: T0 + 5 * 24 * H, value: 2 }])], {}), 'time', 300, 100)
  assert.ok(days.xTicks.every((t) => /^[A-Z][a-z]{2} \d{1,2}$/.test(t.text)), days.xTicks.map((t) => t.text).join(','))
  const one = seriesGeometry(seriesOf([series('o', [{ x: T0, value: 1 }])], {}), 'time', 300, 100)
  assert.equal(Math.round(one.x.lo * one.x.unit), T0 - H / 2)
  assert.equal(Math.round(one.x.hi * one.x.unit), T0 + H / 2)
  assert.equal(one.lines[0]!.dots[0]!.x, 150)
})

test('series without points wait for data: nothing to draw, nothing that is not a number', () => {
  const view = seriesOf([series('a', []), series('b', [])], {})
  const g = seriesGeometry(view, 'time', 300, 100)
  assert.equal(g.points, 0)
  assert.deepEqual(g.lines.map((l) => l.path), ['', ''])
  assert.ok(numbersOf(g).every(Number.isFinite))
  assert.equal(seriesSummary('Forecast', view, 'time'), 'Forecast: 2 series, no data yet')
  assert.equal(latestX(view), null)
  assert.deepEqual(seriesTable(view, 'time').xs, [])
  // one series has points, the other still none
  const half = seriesOf([series('a', [{ x: T0, value: 3 }]), series('b', [])], {})
  assert.match(seriesSummary(undefined, half, 'time'), /B no data yet$/)
})

test('negative values and the extremes of a double give finite geometry and finite ticks', () => {
  const max = Number.MAX_VALUE
  const view = seriesOf([
    series('a', [{ x: -max, value: -max }, { x: 0, value: 0 }, { x: max, value: max }]),
    series('b', [{ x: -1e308, value: 1e-308 }, { x: 1e308, value: -1e308 }]),
  ], {})
  const g = seriesGeometry(view, 'number', 300, 100)
  assert.ok(numbersOf(g).every(Number.isFinite), 'no NaN, no Infinity')
  assert.ok(g.yTicks.length >= 2 && g.xTicks.length >= 2)
  assert.ok(g.lines[0]!.dots[0]!.y > g.lines[0]!.dots[2]!.y, '-max below +max')
  // all negative: the range is theirs, round ticks
  const neg = seriesGeometry(seriesOf([series('n', [{ x: 1, value: -120 }, { x: 2, value: -80 }])], {}), 'number', 300, 100)
  assert.ok(neg.y.hi * neg.y.unit < 0)
  assert.ok(neg.yTicks.every((t) => Number.isFinite(t.value) && t.value % 10 === 0))
  // the table keeps every value exactly
  assert.deepEqual(seriesTable(view, 'number').cells[0], ['-1.7976931348623157e+308', ''])
  // round ticks on an ordinary scale
  const ticks = numberTicks({ unit: 62000, lo: 60000 / 62000, hi: 1 })
  assert.deepEqual(ticks.map((t) => t.value), [60000, 60500, 61000, 61500, 62000])
  // a time range at the edge of what a Date holds
  assert.ok(timeTicks({ unit: 8.64e15, lo: 0.999, hi: 1 }).every((t) => Number.isFinite(t.pos)))
})

test('a legacy chart (data) reads as before: chartPoints of its data', () => {
  const pts = chartPoints([{ label: 'Q1', value: 1 }, { label: 'Q2', value: null }], {})
  assert.deepEqual(pts.map((p) => p.value), [1, null])
})
