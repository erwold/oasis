/** A file source's series drawn and read (pure). The points are columns of numbers (uiChartSource: x strictly
 *  increasing, NaN a gap), never one object per point; what is drawn is bounded by the plot's width, whatever the
 *  number of points:
 *
 *  - each pixel column of a series keeps at most: the first, lowest, highest and last point of the stretch that
 *    begins it (joined to the column before unless a gap lies between), the same of the stretch that ends it (joined to
 *    the column after unless a gap follows), and — when gaps cut the column into more stretches — the lowest and
 *    highest of the stretches between, as one stroke. So a column is at most 10 points per series, every point's value
 *    within what is drawn (a one-sample spike up or down stays), the data's order kept, and the two sides of a gap are
 *    never joined from one column to another (within one pixel column the strokes between gaps are drawn as one).
 *  - a stretch drawn as one point (alone between gaps) is a dot; a sparse series (at most a point per 8 pixels) is a
 *    dot per point, as an inline chart's.
 *  - the cursor and the legend read the raw points: a binary search for an x, the latest point with a value kept as
 *    the points grow (SeriesColumn.lastFinite).
 *
 *  The cost of a drawing is one pass over the points (no allocation per point); the cursor's look-ups are O(log n). */

import type { UiChartXAxis } from '@oasis-code/contract'
import type { SeriesColumn, SourcePoints } from './uiChartSource.ts'
import { exactText, numberText, numberTicks, posOf, rangeOfExtent, timeTicks, utcText, type Range, type Tick } from './uiChart.ts'
import type { CursorValue } from './uiChartDense.ts'

export interface ColumnSeries {
  id: string
  label: string
  dashed: boolean
  color: number
  col: SeriesColumn
}

export interface ColumnMark { x: number; y: number; key: string }
export interface ColumnLine {
  id: string
  color: number
  dashed: boolean
  path: string
  marks: ColumnMark[]
  /** the series' latest point with a value, where it is drawn */
  latest: { x: number; y: number; at: number } | null
  /** the points the path passes through */
  drawn: number
}
export interface ColumnGeometry { x: Range; y: Range; xTicks: Tick[]; yTicks: Tick[]; lines: ColumnLine[]; points: number }

const HALF_HOUR = 30 * 60_000
const SPARSE_GAP = 8
const round = (n: number): number => Math.round(n * 100) / 100
const clampPx = (n: number): number => (Number.isFinite(n) ? Math.max(-1e6, Math.min(1e6, n)) : 0)

/** The ranges every series shares: x over every point, y over every value (padded as an inline chart's). */
export function columnRanges(points: Pick<SourcePoints, 'xMin' | 'xMax' | 'yMin' | 'yMax'>, axis: UiChartXAxis): { x: Range; y: Range } {
  return { x: rangeOfExtent(points.xMin, points.xMax, 0, axis === 'time' ? HALF_HOUR : undefined), y: rangeOfExtent(points.yMin, points.yMax, 0.08) }
}

/** The y ticks of these points (whatever the plot's size): what the axis' words need room for. */
export const columnYTicks = (points: Pick<SourcePoints, 'xMin' | 'xMax' | 'yMin' | 'yMax'>, axis: UiChartXAxis): Tick[] => numberTicks(columnRanges(points, axis).y, 4, numberText)

/** One stretch's first, lowest, highest and last point within a column (indices; -1: none). */
interface Piece { first: number; lo: number; hi: number; last: number }

export function columnGeometry(series: readonly ColumnSeries[], points: Pick<SourcePoints, 'xMin' | 'xMax' | 'yMin' | 'yMax'>, axis: UiChartXAxis, width: number, height: number): ColumnGeometry {
  const { x, y } = columnRanges(points, axis)
  const total = series.reduce((n, s) => n + s.col.n, 0)
  const lines = series.map((s) => seriesLine(s, x, y, width, height))
  return { x, y, xTicks: axis === 'time' ? timeTicks(x) : numberTicks(x), yTicks: numberTicks(y, 4, numberText), lines, points: total }
}

function seriesLine(s: ColumnSeries, xr: Range, yr: Range, width: number, height: number): ColumnLine {
  const { xs, ys, n } = s.col
  const px = (i: number) => round(clampPx(posOf(xs[i]!, xr) * width))
  const py = (i: number) => round(clampPx(height - posOf(ys[i]!, yr) * height))
  let path = ''
  let drawn = 0
  const marks: ColumnMark[] = []
  const latest = s.col.lastFinite >= 0 ? { x: px(s.col.lastFinite), y: py(s.col.lastFinite), at: xs[s.col.lastFinite]! } : null
  if (s.col.finite > 0 && s.col.finite * SPARSE_GAP <= width) {
    // sparse: every point a dot, the line through each stretch as it is
    let pen = false
    for (let i = 0; i < n; i += 1) {
      if (Number.isNaN(ys[i]!)) { pen = false; continue }
      const X = px(i), Y = py(i)
      path += `${pen ? 'L' : 'M'}${X} ${Y} `
      pen = true
      drawn += 1
      marks.push({ x: X, y: Y, key: String(xs[i]) })
    }
    return { id: s.id, color: s.color, dashed: s.dashed, path: path.trim(), marks, latest, drawn }
  }
  // the open polyline: its points so far (to tell a one-point stretch, drawn as a dot)
  let line: number[] = []
  const closeLine = () => {
    if (line.length === 2) marks.push({ x: line[0]!, y: line[1]!, key: `${line[0]}:${line[1]}:${marks.length}` })
    else if (line.length > 2) {
      for (let k = 0; k < line.length; k += 2) path += `${k === 0 ? 'M' : 'L'}${line[k]} ${line[k + 1]} `
    }
    drawn += line.length / 2
    line = []
  }
  const addPoint = (i: number) => {
    const X = px(i), Y = py(i)
    const L = line.length
    if (L >= 2 && line[L - 2] === X && line[L - 1] === Y) return
    line.push(X, Y)
  }
  const emitPiece = (p: Piece) => {
    const keep = [p.first, p.lo, p.hi, p.last].filter((v, k, a) => v >= 0 && a.indexOf(v) === k).sort((a, b) => a - b)
    for (const i of keep) addPoint(i)
  }
  const extend = (p: Piece, i: number) => {
    if (p.first < 0) { p.first = p.lo = p.hi = p.last = i; return }
    if (ys[i]! < ys[p.lo]!) p.lo = i
    if (ys[i]! > ys[p.hi]!) p.hi = i
    p.last = i
  }
  const piece = (): Piece => ({ first: -1, lo: -1, hi: -1, last: -1 })
  let col = Number.NaN
  // the column's first stretch (joined to the line), the stretches between gaps (one stroke), the one under way
  let first = piece(), middle = piece(), current = piece()
  let inFirst = true
  let gap = false
  const endColumn = () => {
    if (inFirst) { emitPiece(first); return }
    // the first stretch ended at a gap (the line was closed then); the middle is a stroke of its own; the current one
    // begins a new line
    if (middle.first >= 0) {
      const lo = middle.lo, hi = middle.hi
      const X = px(middle.first)
      if (py(lo) === py(hi)) marks.push({ x: X, y: py(lo), key: `m${X}:${marks.length}` })
      else path += `M${X} ${py(lo)} L${X} ${py(hi)} `
      drawn += lo === hi ? 1 : 2
    }
    if (current.first >= 0) emitPiece(current)
  }
  for (let i = 0; i < n; i += 1) {
    if (Number.isNaN(ys[i]!)) { gap = true; continue }
    const c = Math.floor(px(i))
    if (c !== col) {
      if (col === col) endColumn()
      col = c
      if (gap) closeLine()
      gap = false
      first = piece(); middle = piece(); current = piece(); inFirst = true
      extend(first, i)
      continue
    }
    if (gap) {
      gap = false
      if (inFirst) { emitPiece(first); closeLine(); inFirst = false }
      else if (current.first >= 0) { for (const k of [current.first, current.lo, current.hi, current.last]) extend(middle, k); current = piece() }
      extend(current, i)
      continue
    }
    extend(inFirst ? first : current, i)
  }
  if (col === col) endColumn()
  closeLine()
  return { id: s.id, color: s.color, dashed: s.dashed, path: path.trim(), marks, latest, drawn }
}

// ---------------------------------------------------------------- the cursor (raw points, binary searches)

/** The index of the first x ≥ `x` in the column (n when none). */
export function lowerBound(col: SeriesColumn, x: number): number {
  let lo = 0, hi = col.n
  while (lo < hi) { const mid = (lo + hi) >> 1; if (col.xs[mid]! < x) lo = mid + 1; else hi = mid }
  return lo
}

/** The x any series has a point at (a value or a gap) nearest to `x`; a tie goes to the earlier. Null for none. */
export function nearestColumnX(series: readonly ColumnSeries[], x: number): number | null {
  let best: number | null = null
  for (const s of series) {
    const c = s.col
    if (!c.n) continue
    const i = lowerBound(c, x)
    for (const j of [i - 1, i]) {
      if (j < 0 || j >= c.n) continue
      const v = c.xs[j]!
      if (best === null || Math.abs(v - x) < Math.abs(best - x) || (Math.abs(v - x) === Math.abs(best - x) && v < best)) best = v
    }
  }
  return best
}

/** The x `steps` places after (or, negative, before) `from` among every x the series have (once each); the last (first)
 *  when there are fewer. `from` null: from past the end. */
export function stepColumnX(series: readonly ColumnSeries[], from: number | null, steps: number): number | null {
  let at = from
  if (at === null) {
    if (steps >= 0) return lastColumnX(series)
    at = Number.POSITIVE_INFINITY
  }
  for (let k = 0; k < Math.abs(steps); k += 1) {
    let next: number | null = null
    for (const s of series) {
      const c = s.col
      if (!c.n) continue
      const lb: number = lowerBound(c, at)
      if (steps > 0) {
        const j: number = lb < c.n && c.xs[lb] === at ? lb + 1 : lb
        if (j < c.n && (next === null || c.xs[j]! < next)) next = c.xs[j]!
      } else if (lb - 1 >= 0 && (next === null || c.xs[lb - 1]! > next)) next = c.xs[lb - 1]!
    }
    if (next === null) break
    at = next
  }
  return Number.isFinite(at) ? at : null
}
export const firstColumnX = (series: readonly ColumnSeries[]): number | null => series.reduce<number | null>((m, s) => (s.col.n && (m === null || s.col.xs[0]! < m) ? s.col.xs[0]! : m), null)
export const lastColumnX = (series: readonly ColumnSeries[]): number | null => series.reduce<number | null>((m, s) => (s.col.n && (m === null || s.col.xs[s.col.n - 1]! > m) ? s.col.xs[s.col.n - 1]! : m), null)

/** The latest x any series has a value at. */
export const latestColumnX = (series: readonly ColumnSeries[]): number | null =>
  series.reduce<number | null>((m, s) => (s.col.lastFinite >= 0 && (m === null || s.col.xs[s.col.lastFinite]! > m) ? s.col.xs[s.col.lastFinite]! : m), null)

const pointOf = (c: SeriesColumn, i: number) => {
  const v = c.ys[i]!
  return Number.isNaN(v) ? { x: c.xs[i]!, value: null, text: 'no value' } : { x: c.xs[i]!, value: v, text: numberText(v) }
}

/** Each series' own point at exactly `x` (raw), null where it has none. */
export function columnValuesAt(series: readonly ColumnSeries[], x: number): CursorValue[] {
  return series.map((s) => {
    const i = lowerBound(s.col, x)
    return { id: s.id, label: s.label, color: s.color, dashed: s.dashed, point: i < s.col.n && s.col.xs[i] === x ? pointOf(s.col, i) : null }
  })
}

/** Each series' latest point with a value. */
export function columnLatest(series: readonly ColumnSeries[]): CursorValue[] {
  return series.map((s) => ({ id: s.id, label: s.label, color: s.color, dashed: s.dashed, point: s.col.lastFinite >= 0 ? pointOf(s.col, s.col.lastFinite) : null }))
}

/** Where a series' point at `x` is drawn (it has one with a value there), or null. */
export function columnDotAt(s: ColumnSeries, x: number, xr: Range, yr: Range, width: number, height: number): { x: number; y: number } | null {
  const i = lowerBound(s.col, x)
  if (i >= s.col.n || s.col.xs[i] !== x || Number.isNaN(s.col.ys[i]!)) return null
  return { x: round(clampPx(posOf(x, xr) * width)), y: round(clampPx(height - posOf(s.col.ys[i]!, yr) * height)) }
}

// ---------------------------------------------------------------- the values table and the words

/** Every x any series has, ascending, once each: a merge of the columns (built when the table is open). */
export function columnXs(series: readonly ColumnSeries[]): Float64Array {
  const at = series.map(() => 0)
  const out = new Float64Array(series.reduce((n, s) => n + s.col.n, 0))
  let k = 0
  for (;;) {
    let min = Number.POSITIVE_INFINITY
    series.forEach((s, j) => { if (at[j]! < s.col.n && s.col.xs[at[j]!]! < min) min = s.col.xs[at[j]!]! })
    if (min === Number.POSITIVE_INFINITY) break
    out[k++] = min
    series.forEach((s, j) => { if (at[j]! < s.col.n && s.col.xs[at[j]!] === min) at[j] = at[j]! + 1 })
  }
  return out.subarray(0, k)
}

export interface ColumnTablePage { total: number; page: number; pages: number; from: number; to: number; xs: { x: number; text: string }[]; cells: string[][] }

/** One page of the table (one row per x, one column per series, exact numbers); `page` null: the newest. */
export function columnTablePage(series: readonly ColumnSeries[], all: Float64Array, axis: UiChartXAxis, page: number | null, size = 100): ColumnTablePage {
  const pages = Math.max(1, Math.ceil(all.length / size))
  const p = page === null ? pages - 1 : Math.max(0, Math.min(pages - 1, Math.floor(page)))
  const from = p * size
  const xs = Array.from(all.subarray(from, from + size))
  return {
    total: all.length, page: p, pages, from, to: from + xs.length,
    xs: xs.map((x) => ({ x, text: axis === 'time' ? utcText(x) : exactText(x) })),
    cells: xs.map((x) => series.map((s) => {
      const i = lowerBound(s.col, x)
      if (i >= s.col.n || s.col.xs[i] !== x) return ''
      const v = s.col.ys[i]!
      return Number.isNaN(v) ? 'no value' : exactText(v)
    })),
  }
}

/** The chart in words: how many points, over which x, each series' latest value. */
export function columnSummary(label: string | undefined, series: readonly ColumnSeries[], points: Pick<SourcePoints, 'xMin' | 'xMax'>, axis: UiChartXAxis): string {
  const head = label?.trim() || 'Line chart'
  const total = series.reduce((n, s) => n + s.col.n, 0)
  if (!total) return `${head}: ${series.length} series, no data yet`
  const xText = (x: number) => (axis === 'time' ? utcText(x) : String(x))
  const each = columnLatest(series).map((v) => (v.point ? `${v.label} ${v.point.text} at ${xText(v.point.x)}` : `${v.label} no data yet`))
  return `${head}: ${series.length} series, ${total} points from ${xText(points.xMin)} to ${xText(points.xMax)}; latest: ${each.join('; ')}`
}
