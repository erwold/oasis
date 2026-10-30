/** A dense series chart, pure: what is drawn of many points (min/max per pixel column, the pen lifted at every gap),
 *  where the cursor lands (on a point the data has, never between them), each series' value there (the raw point),
 *  a page of the values table built only when asked for, and colours that stay with a series id across revisions.
 *  Nothing here changes what it is given. */

import type { UiChartXAxis } from '@oasis-code/contract'
import { exactText, utcText, type Range, type SeriesPoint, type SeriesView } from './uiChart.ts'
import { formatValue } from './uiSurface.ts'

export { thinRun, type PlotPoint } from './uiChartThin.ts'

/** The x a position (0..1) on a range stands for. */
export const xAtPos = (pos: number, r: Range): number => (r.lo + pos * (r.hi - r.lo)) * r.unit

/** Every x any series has a point at (a value or a gap), ascending, once each. */
export function chartXs(series: readonly SeriesView[]): number[] {
  const xs = new Set<number>()
  for (const s of series) for (const p of s.points) xs.add(p.x)
  return [...xs].sort((a, b) => a - b)
}

/** The index of the x in `xs` (ascending) nearest to `x`; null for none. A tie goes to the earlier one. */
export function nearestIndex(xs: readonly number[], x: number): number | null {
  if (!xs.length || !Number.isFinite(x)) return xs.length ? (x > 0 ? xs.length - 1 : 0) : null
  let lo = 0, hi = xs.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (xs[mid]! < x) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(xs[lo - 1]! - x) <= Math.abs(xs[lo]! - x)) return lo - 1
  return lo
}

export interface CursorValue { id: string; label: string; color: number; dashed: boolean; point: SeriesPoint | null }

/** Each series' own point at exactly `x` (the data's, never interpolated): null where it has none. */
export function valuesAt(series: readonly SeriesView[], x: number): CursorValue[] {
  return series.map((s) => ({ id: s.id, label: s.label, color: s.color, dashed: s.dashed, point: findX(s.points, x) }))
}

/** Each series' latest point with a value. */
export function latestValues(series: readonly SeriesView[]): CursorValue[] {
  return series.map((s) => {
    let point: SeriesPoint | null = null
    for (let k = s.points.length - 1; k >= 0; k -= 1) if (s.points[k]!.value !== null) { point = s.points[k]!; break }
    return { id: s.id, label: s.label, color: s.color, dashed: s.dashed, point }
  })
}

function findX(points: readonly SeriesPoint[], x: number): SeriesPoint | null {
  // points are in increasing x for a spec the contract accepts: a binary search; a linear look otherwise
  let lo = 0, hi = points.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const v = points[mid]!.x
    if (v === x) return points[mid]!
    if (v < x) lo = mid + 1
    else hi = mid - 1
  }
  return points.find((p) => p.x === x) ?? null
}

export const xWords = (x: number, axis: UiChartXAxis): string => (axis === 'time' ? utcText(x) : formatValue(x))

/** Rows of the values table a page shows. */
export const TABLE_PAGE_ROWS = 100

export interface TablePage { total: number; page: number; pages: number; from: number; to: number; xs: { x: number; text: string }[]; cells: string[][] }

/** One page of the chart as a table (one row per x, one column per series; exact numbers), built for that page only.
 *  `page` null: the last page (the newest rows). */
export function seriesTablePage(series: readonly SeriesView[], axis: UiChartXAxis, page: number | null, size = TABLE_PAGE_ROWS): TablePage {
  const all = chartXs(series)
  const pages = Math.max(1, Math.ceil(all.length / size))
  const at = page === null ? pages - 1 : Math.max(0, Math.min(pages - 1, Math.floor(page)))
  const from = at * size
  const xs = all.slice(from, from + size)
  return {
    total: all.length, page: at, pages, from, to: from + xs.length,
    xs: xs.map((x) => ({ x, text: axis === 'time' ? utcText(x) : exactText(x) })),
    cells: xs.map((x) => series.map((s) => { const p = findX(s.points, x); return p === null ? '' : p.value === null ? 'no value' : exactText(p.value) })),
  }
}

/** Colour slots by series id: an id keeps its slot as long as it is in the chart; a new id takes the lowest free slot.
 *  A first drawing gives the slots in order (the same as by place). Never changes `prev`. */
export function assignColors(prev: ReadonlyMap<string, number>, ids: readonly string[], slots = 8): Map<string, number> {
  const next = new Map<string, number>()
  const used = new Set<number>()
  for (const id of ids) {
    const c = prev.get(id)
    if (c !== undefined && !used.has(c) && !next.has(id)) { next.set(id, c); used.add(c) }
  }
  let free = 0
  for (const id of ids) {
    if (next.has(id)) continue
    while (used.has(free % slots) && used.size < slots) free += 1
    const c = free % slots
    next.set(id, c); used.add(c); free += 1
  }
  return next
}

/** A long chart in words, bounded: how many points, and each series' latest value. */
export function denseSummary(label: string | undefined, kind: 'bar' | 'line', points: readonly { label: string; value: number | null; text: string }[]): string {
  const head = label?.trim() || `${kind === 'bar' ? 'Bar' : 'Line'} chart`
  const values = points.filter((p) => p.value !== null)
  if (!values.length) return `${head}: no data`
  let lo = values[0]!, hi = values[0]!
  for (const p of values) { if (p.value! < lo.value!) lo = p; if (p.value! > hi.value!) hi = p }
  const last = values[values.length - 1]!
  return `${head}: ${points.length} points from ${points[0]!.label} to ${points[points.length - 1]!.label}; lowest ${lo.label} ${lo.text}, highest ${hi.label} ${hi.text}, last ${last.label} ${last.text}`
}
