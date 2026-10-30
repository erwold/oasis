/** A surface's chart as geometry (pure: the component draws it as SVG, the tests read it): bars from a zero
 *  baseline (negative values below it), a line through the points; points without a number are gaps, never zero.
 *  Values come from the contract's evaluator; the scale is normalised first, so any finite values — up to
 *  ±Number.MAX_VALUE, whose span overflows — give finite coordinates. */

import { UI_LIMITS, type UiChartSeries, type UiChartXAxis } from '@oasis-code/contract'
import { formatValue, valueAt, type UiState } from './uiSurface.ts'
import { thinRun, type PlotPoint } from './uiChartThin.ts'

export interface ChartPoint { label: string; value: number | null; text: string }

/** The chart's points at the state: each label with its value computed, bounded in number. */
export function chartPoints(data: ReadonlyArray<{ label: string; value: unknown }>, state: UiState): ChartPoint[] {
  return data.slice(0, UI_LIMITS.chartPoints).map((d) => {
    const v = valueAt(d.value, state)
    return { label: d.label, value: typeof v === 'number' && Number.isFinite(v) ? v : null, text: formatValue(v) }
  })
}

/** The value range the plot spans, in units of `unit` (the largest magnitude): lo..hi always includes zero, lies in
 *  [-1, 1] and is never empty — finite whatever the values. */
export interface Scale { unit: number; lo: number; hi: number }

export function scaleOf(points: ChartPoint[]): Scale {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null && Number.isFinite(v))
  const unit = Math.max(0, ...values.map(Math.abs)) || 1
  const lo = Math.min(0, ...values.map((v) => v / unit))
  let hi = Math.max(0, ...values.map((v) => v / unit))
  if (lo === hi) hi = lo + 1
  return { unit, lo, hi }
}

/** y of a value in a plot `height` high (0 at the top); finite for every finite value. */
export const yOf = (v: number, s: Scale, height: number): number => height - ((v / s.unit - s.lo) / (s.hi - s.lo)) * height

export interface Bar { x: number; y: number; width: number; height: number; point: ChartPoint }

/** One bar per point with a number, each in its slot of a plot `width` wide, from the zero line to its value. */
export function barsOf(points: ChartPoint[], width: number, height: number): Bar[] {
  if (!points.length) return []
  const s = scaleOf(points)
  const slot = width / points.length
  const bw = Math.max(1, slot * 0.64)
  const zero = yOf(0, s, height)
  const bars: Bar[] = []
  points.forEach((point, i) => {
    if (point.value === null) return
    const y = yOf(point.value, s, height)
    bars.push({ x: i * slot + (slot - bw) / 2, y: Math.min(y, zero), width: bw, height: Math.max(0.5, Math.abs(zero - y)), point })
  })
  return bars
}

/** The line's path (`M`/`L` commands, a gap where a point has no number) and its dots. */
export function lineOf(points: ChartPoint[], width: number, height: number): { path: string; dots: { x: number; y: number; point: ChartPoint }[] } {
  if (!points.length) return { path: '', dots: [] }
  const s = scaleOf(points)
  const step = points.length > 1 ? width / (points.length - 1) : 0
  const dots: { x: number; y: number; point: ChartPoint }[] = []
  let path = ''
  let pen = false
  points.forEach((point, i) => {
    if (point.value === null) { pen = false; return }
    const x = points.length > 1 ? i * step : width / 2
    const y = yOf(point.value, s, height)
    path += `${pen ? 'L' : 'M'}${round(x)} ${round(y)} `
    pen = true
    dots.push({ x, y, point })
  })
  return { path: path.trim(), dots }
}

const round = (n: number): number => Math.round(n * 100) / 100

/** The chart in words, for a screen reader and the text version: "Revenue: Q1 12, Q2 15". */
export function chartSummary(label: string | undefined, kind: 'bar' | 'line', points: ChartPoint[]): string {
  const head = label?.trim() || `${kind === 'bar' ? 'Bar' : 'Line'} chart`
  if (!points.length) return `${head}: no data`
  return `${head}: ${points.map((p) => `${p.label} ${p.text}`).join(', ')}`
}

// ---------------------------------------------------------------- series (a line chart of several series on an x axis)

/** One point of a series as drawn: its x (a number; on a time axis epoch milliseconds, UTC) and its value computed —
 *  null when it resolves to no finite number (a gap in the line, never zero). */
export interface SeriesPoint { x: number; value: number | null; text: string }
export interface SeriesView {
  id: string
  label: string
  dashed: boolean
  /** the series' colour: its place in the chart's series (0–7; one colour each, kept as long as the order is) */
  color: number
  points: SeriesPoint[]
}

/** The chart's series at the state, bounded as the contract bounds them: at most UI_LIMITS.chartSeries series and
 *  UI_LIMITS.chartPoints points in all (every series together, in order), x finite. */
export function seriesOf(series: ReadonlyArray<UiChartSeries>, state: UiState): SeriesView[] {
  let room: number = UI_LIMITS.chartPoints
  return series.slice(0, UI_LIMITS.chartSeries).map((s, i) => {
    const data = s.data.slice(0, Math.max(0, room))
    room -= data.length
    const points: SeriesPoint[] = []
    for (const d of data) {
      if (typeof d.x !== 'number' || !Number.isFinite(d.x)) continue
      const v = valueAt(d.value, state)
      const value = typeof v === 'number' && Number.isFinite(v) ? v : null
      points.push({ x: d.x, value, text: value === null ? 'no value' : numberText(value) })
    }
    return { id: s.id, label: s.label, dashed: s.line_style === 'dashed', color: i % UI_LIMITS.chartSeries, points }
  })
}

/** An axis' range, normalised by `unit` (the largest magnitude) so that any finite numbers — ±Number.MAX_VALUE
 *  included, whose difference overflows — give finite positions: lo < hi, both finite. */
export interface Range { unit: number; lo: number; hi: number }

/** `flat`: the half width of the band drawn around a single value (in the values' own units; absent: 5% of it). */
function rangeOf(values: number[], pad: number, flat?: number): Range {
  // a loop, not Math.min(...values): any number of values, never the call stack's bound
  let min = Number.POSITIVE_INFINITY, max = Number.NEGATIVE_INFINITY
  for (const v of values) { if (!Number.isFinite(v)) continue; if (v < min) min = v; if (v > max) max = v }
  return rangeOfExtent(min, max, pad, flat)
}

/** The range of values whose lowest is `min` and highest `max` (rangeOf without the values: a source keeps its
 *  extents as it grows). min > max (none): the empty range. */
export function rangeOfExtent(min: number, max: number, pad: number, flat?: number): Range {
  if (!(Number.isFinite(min) && Number.isFinite(max)) || min > max) return { unit: 1, lo: 0, hi: 1 }
  const unit = Math.max(Math.abs(min), Math.abs(max)) || 1
  let lo = min / unit
  let hi = max / unit
  if (hi - lo < 1e-12) {
    // one value (or values the scale cannot tell apart): a band around it
    const given = flat !== undefined ? flat / unit : NaN
    const half = Number.isFinite(given) && given > 1e-12 ? given : Math.max(Math.abs(lo) * 0.05, 0.05)
    lo -= half; hi += half
  } else if (pad > 0) {
    const p = (hi - lo) * pad
    lo -= p; hi += p
  }
  return { unit, lo, hi }
}

/** The position (0..1) of a value on a range; finite for every finite value. */
export const posOf = (v: number, r: Range): number => (v / r.unit - r.lo) / (r.hi - r.lo)

/** A number the scale stands for at normalised `n`, never ±Infinity. */
const realOf = (n: number, unit: number): number => {
  const v = n * unit
  return Number.isFinite(v) ? v : v > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE
}

export interface Tick { pos: number; value: number; text: string }

/** A step of 1, 2 or 5 × 10^k near `raw` (raw > 0, finite). */
function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw))
  const m = raw / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p
}

/** About `count` ticks over a numeric range at round values; the range's ends when no round step fits (a span that
 *  overflows). Every tick is finite and on the range. */
export function numberTicks(r: Range, count = 4, fmt: (v: number) => string = (v) => formatValue(v)): Tick[] {
  const spanReal = (r.hi - r.lo) * r.unit
  const ends = (): Tick[] => [r.lo, r.hi].map((n) => { const v = realOf(n, r.unit); return { pos: posOf(v, r), value: v, text: fmt(v) } })
  if (!Number.isFinite(spanReal) || spanReal <= 0) return ends()
  const step = niceStep(spanReal / count)
  if (!Number.isFinite(step) || step <= 0) return ends()
  const first = Math.ceil((r.lo * r.unit) / step)
  const last = Math.floor((r.hi * r.unit) / step)
  if (!Number.isFinite(first) || !Number.isFinite(last) || last - first > 20) return ends()
  const ticks: Tick[] = []
  for (let k = first; k <= last; k += 1) {
    const v = k * step
    // a tick of 0 when the scale crosses it (k * step leaves -0 and float noise out)
    const value = Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12))
    const pos = posOf(value, r)
    if (Number.isFinite(pos) && pos >= -1e-9 && pos <= 1 + 1e-9) ticks.push({ pos, value, text: fmt(value) })
  }
  return ticks.length ? ticks : ends()
}

const MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
/** round UTC steps: seconds, minutes, hours, days (each a multiple of the one before it starts on a round moment) */
const TIME_STEPS = [
  ...[1, 5, 15, 30].map((n) => n * MS.s), ...[1, 5, 15, 30].map((n) => n * MS.m),
  ...[1, 3, 6, 12].map((n) => n * MS.h), ...[1, 2, 7, 14, 30, 91, 182, 365].map((n) => n * MS.d),
]
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n: number) => String(n).padStart(2, '0')

/** A moment as UTC words, as precise as `step` asks: "14:05", "14:05:30", "Oct 12 14:00", "Oct 12", "2026-10-12". */
export function timeText(ms: number, step: number, span: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '—'
  const hm = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`
  const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
  if (step >= 91 * MS.d || span >= 400 * MS.d) return isoDate(d)
  if (step >= MS.d) return day
  const time = step < MS.m ? `${hm}:${two(d.getUTCSeconds())}` : hm
  return span > MS.d ? `${day} ${time}` : time
}

const isoDate = (d: Date): string => {
  const y = d.getUTCFullYear()
  const year = y < 0 ? `-${String(-y).padStart(6, '0')}` : y > 9999 ? `+${String(y).padStart(6, '0')}` : String(y).padStart(4, '0')
  return `${year}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`
}

/** A moment exactly, in UTC: "2026-10-12 14:05:30 UTC" (milliseconds when it has them). */
export function utcText(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '—'
  const msPart = d.getUTCMilliseconds() ? `.${String(d.getUTCMilliseconds()).padStart(3, '0')}` : ''
  return `${isoDate(d)} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}${msPart} UTC`
}

/** About `count` ticks over a time range at round UTC moments (a whole minute, hour, day …). */
export function timeTicks(r: Range, count = 4): Tick[] {
  const lo = realOf(r.lo, r.unit), hi = realOf(r.hi, r.unit)
  const span = hi - lo
  const step = TIME_STEPS.find((s) => span / s <= count) ?? niceStep(span / count)
  const ticks: Tick[] = []
  if (Number.isFinite(span) && span > 0 && step > 0) {
    for (let t = Math.ceil(lo / step) * step; t <= hi && ticks.length <= 20; t += step) ticks.push({ pos: posOf(t, r), value: t, text: timeText(t, step, span) })
  }
  return ticks.length ? ticks : [lo, hi].map((v) => ({ pos: posOf(v, r), value: v, text: timeText(v, MS.m, 0) }))
}

export interface SeriesDot { x: number; y: number; point: SeriesPoint }
export interface SeriesPath {
  series: SeriesView
  /** the line as drawn: thinned to what a pixel column shows (columns of `width / columns`), lifted at every gap */
  path: string
  /** every point with a value, at its place (what a cursor reads; none of it is thinned) */
  dots: SeriesDot[]
  /** the points the path passes through after thinning */
  drawn: number
  /** the points drawn as a dot: one alone between gaps (no line shows it), and every point of a sparse series */
  marks: SeriesDot[]
  /** the series' latest point with a value */
  latest: SeriesDot | null
}

export interface SeriesGeometry {
  x: Range
  y: Range
  xTicks: Tick[]
  yTicks: Tick[]
  lines: SeriesPath[]
  /** points in all; 0: every series waits for data */
  points: number
}

/** A series is sparse — every point a dot — when its points are at least this far apart on average (plot units). */
const SPARSE_GAP = 8

/** Every series on one x range and one y range (all series share both): a line per series through its points with a
 *  value, broken at a value that is none (a gap, never drawn as zero; the two sides of a gap are never joined, even
 *  in one pixel column). A dense line is thinned per column of `width / columns` — first, lowest, highest and last of
 *  each column, in the data's order — so its peaks, valleys and ends stay; a sparse one is drawn point for point. The
 *  y range is the values' own (a price chart need not start at zero), padded a little. */
export function seriesGeometry(series: SeriesView[], axis: UiChartXAxis, width: number, height: number, columns: number = width): SeriesGeometry {
  const all = series.flatMap((s) => s.points)
  // a single moment: half an hour either side of it; a single number: 5% of it
  const x = rangeOf(all.map((p) => p.x), 0, axis === 'time' ? 30 * MS.m : undefined)
  const y = rangeOf(all.flatMap((p) => (p.value === null ? [] : [p.value])), 0.08)
  const xAt = (v: number) => clampPx(posOf(v, x) * width)
  const yAt = (v: number) => clampPx(height - posOf(v, y) * height)
  const column = columns > 0 && Number.isFinite(columns) ? width / columns : 1
  const lines = series.map((s) => {
    const dots: SeriesDot[] = []
    const marks: SeriesDot[] = []
    const runs: PlotPoint[][] = []
    let run: PlotPoint[] = []
    s.points.forEach((point) => {
      if (point.value === null) { if (run.length) runs.push(run); run = []; return }
      const dot = { x: round(xAt(point.x)), y: round(yAt(point.value)), point }
      run.push({ x: dot.x, y: dot.y, i: dots.length })
      dots.push(dot)
    })
    if (run.length) runs.push(run)
    const sparse = dots.length > 0 && dots.length * SPARSE_GAP <= width
    let path = ''
    let drawn = 0
    for (const r of runs) {
      if (sparse || r.length === 1) for (const p of r) marks.push(dots[p.i]!)
      const kept = thinRun(r, column)
      drawn += kept.length
      kept.forEach((p, k) => { path += `${k === 0 ? 'M' : 'L'}${p.x} ${p.y} ` })
    }
    return { series: s, path: path.trim(), dots, drawn, marks, latest: dots.length ? dots[dots.length - 1]! : null }
  })
  return { x, y, xTicks: axis === 'time' ? timeTicks(x) : numberTicks(x), yTicks: numberTicks(y, 4, numberText), lines, points: all.length }
}

/** The y ticks seriesGeometry gives these series (whatever the plot's size): what the axis' words need room for. */
export const seriesYTicks = (series: SeriesView[]): Tick[] => numberTicks(rangeOf(series.flatMap((s) => s.points.flatMap((p) => (p.value === null ? [] : [p.value]))), 0.08), 4, numberText)

/** A coordinate within a generous band around the plot (finite whatever came in). */
const clampPx = (n: number): number => (Number.isFinite(n) ? Math.max(-1e6, Math.min(1e6, n)) : 0)

/** A number exactly as JavaScript holds it ("61234.5", "1e+308"): the data table's words, never rounded. */
export const exactText = (v: number): string => String(v)

/** A number to read at a glance without losing what it says: as formatValue (grouped, up to 6 decimals) — and a
 *  magnitude under 0.001 (a learning rate, a small loss) in exponent form to 4 significant digits ("3e-7",
 *  "1.235e-5"), never rounded to 0. */
export const numberText = (v: number): string =>
  v !== 0 && Number.isFinite(v) && Math.abs(v) < 1e-3 ? Number(v.toPrecision(4)).toExponential() : formatValue(v)

/** The chart as a table: one row per x any series has (in order), one column per series; a series without a point at
 *  that x has none there (''), a point without a value says so. */
export function seriesTable(series: SeriesView[], axis: UiChartXAxis): { xs: { x: number; text: string }[]; cells: string[][] } {
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b)
  const at = series.map((s) => new Map(s.points.map((p) => [p.x, p])))
  return {
    xs: xs.map((x) => ({ x, text: axis === 'time' ? utcText(x) : exactText(x) })),
    cells: xs.map((x) => at.map((m) => { const p = m.get(x); return p === undefined ? '' : p.value === null ? 'no value' : exactText(p.value) })),
  }
}

/** The chart in words: what it shows, over which x, and each series' latest value. */
export function seriesSummary(label: string | undefined, series: SeriesView[], axis: UiChartXAxis): string {
  const head = label?.trim() || 'Line chart'
  const all = series.flatMap((s) => s.points)
  if (!all.length) return `${head}: ${series.length} series, no data yet`
  const xText = (x: number) => (axis === 'time' ? utcText(x) : formatValue(x))
  const lo = Math.min(...all.map((p) => p.x)), hi = Math.max(...all.map((p) => p.x))
  const each = series.map((s) => {
    const last = [...s.points].reverse().find((p) => p.value !== null)
    return last ? `${s.label} ${last.text} at ${xText(last.x)}` : `${s.label} no data yet`
  })
  return `${head}: ${series.length} series from ${xText(lo)} to ${xText(hi)}; latest: ${each.join('; ')}`
}

/** The latest x any series has a value at: on a time axis, how recent the chart's data is. */
export function latestX(series: SeriesView[]): number | null {
  const xs = series.flatMap((s) => s.points.filter((p) => p.value !== null).map((p) => p.x))
  return xs.length ? Math.max(...xs) : null
}
