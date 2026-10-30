/** A surface's charts. A series chart is drawn at the size it is laid out at (crisp words and hairlines), its lines
 *  thinned per pixel column (uiChart / uiChartDense): a dot only where a line cannot show a point, a hollow ring on
 *  each series' latest value with a dashed rule at the latest x. The legend is the readout: each series' latest value,
 *  or its own point at the cursor — the pointer or the arrow keys land on an x the data has, never between two. The
 *  exact values are a table built when opened, one page at a time. A new point that arrives while the page is
 *  visible marks its arrival once; the chart keeps its colours, cursor and table page across revisions. */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from 'react'
import { UI_LIMITS, type UiChartSource, type UiElement } from '@oasis-code/contract'
import { ApiError, api } from '../api/client'
import {
  barsOf, exactText, chartPoints, chartSummary, latestX, lineOf, scaleOf, seriesGeometry, seriesOf, seriesSummary, seriesYTicks, utcText, yOf,
  type Range, type SeriesView, type Tick,
} from '../state/uiChart'
import {
  TABLE_PAGE_ROWS, assignColors, chartXs, denseSummary, latestValues, nearestIndex, seriesTablePage, valuesAt, xAtPos, xWords, type CursorValue, type TablePage,
} from '../state/uiChartDense'
import {
  columnDotAt, columnGeometry, columnLatest, columnSummary, columnTablePage, columnValuesAt, columnXs, columnYTicks, firstColumnX, lastColumnX, latestColumnX,
  nearestColumnX, stepColumnX, type ColumnSeries,
} from '../state/uiChartColumns'
import { acquireFeed, ChartFeed, type FeedDeps, type FeedSnapshot, type FeedStatus } from '../state/uiChartFeed'
import { SourcePoints } from '../state/uiChartSource'
import { formatValue, type UiState } from '../state/uiSurface'
import { useArrival, useWidth } from './UiLiveMotion'

type ChartEl = Extract<UiElement, { type: 'chart' }>

export function Chart({ el, state, target = null }: { el: ChartEl; state: UiState; target?: ChartSourceTarget | null }) {
  // keyed by its source: another source (path, format, columns) is another chart — nothing of the one before is drawn
  if (el.props.source !== undefined) return <FileSeriesChart key={JSON.stringify(el.props.source)} props={el.props} source={el.props.source} target={target} />
  if (el.props.series !== undefined) return <SeriesChart props={el.props} series={el.props.series} state={state} />
  return <DataChart el={el} state={state} />
}

const CHART_W = 320
const CHART_H = 140
/** a labelled chart with more points than this has no per-bar tooltip and no always-present table (it has a lazy one) */
const DATA_DETAIL_MAX = 24

/** A chart of labelled values (`data`): bars from zero, or one line through them. */
function DataChart({ el, state }: { el: ChartEl; state: UiState }) {
  const { kind, label, data } = el.props
  const points = useMemo(() => chartPoints(data ?? [], state), [data, state])
  const dense = points.length > DATA_DETAIL_MAX
  const summary = dense ? denseSummary(label, kind, points) : chartSummary(label, kind, points)
  const zero = yOf(0, scaleOf(points), CHART_H)
  const bars = kind === 'bar' ? barsOf(points, CHART_W, CHART_H) : []
  const line = kind === 'line' ? lineOf(points, CHART_W, CHART_H) : null
  const dots = line ? (dense ? line.dots.slice(-1) : line.dots) : []
  return (
    <figure className="uis-chart" data-chart={kind} data-points={points.length}>
      {label && <figcaption className="uis-title">{label}</figcaption>}
      {el.props.y_label && <span className="uis-chart-ylabel">{el.props.y_label}</span>}
      <svg viewBox={`-4 -6 ${CHART_W + 8} ${CHART_H + 12}`} role="img" aria-label={summary} focusable="false">
        <line className="uis-chart-axis" x1={0} x2={CHART_W} y1={zero} y2={zero} />
        {bars.map((b, i) => <rect key={i} className="uis-chart-bar" x={b.x} y={b.y} width={b.width} height={b.height} rx={dense ? 0 : 2}>{!dense && <title>{`${b.point.label}: ${b.point.text}`}</title>}</rect>)}
        {line && <path className="uis-chart-line" d={line.path} fill="none" vectorEffect="non-scaling-stroke" />}
        {dots.map((d, i) => <circle key={i} className="uis-chart-dot" cx={d.x} cy={d.y} r={2.5}><title>{`${d.point.label}: ${d.point.text}`}</title></circle>)}
      </svg>
      {points.length > 0 && points.length <= 12 && (
        <div className={`uis-chart-labels ${kind}`} aria-hidden="true" style={kind === 'bar' ? { gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` } : undefined}>
          {points.map((pt, i) => <span key={i} title={`${pt.label}: ${pt.text}`}>{pt.label}</span>)}
        </div>
      )}
      {dense
        ? <LazyValues label={label} count={points.length} head={['Label', 'Value']}
                      rows={(from, to) => points.slice(from, to).map((p) => [p.label, p.text])} />
        : <table className="uis-sr-only"><caption>{summary}</caption><tbody>{points.map((pt, i) => <tr key={i}><th scope="row">{pt.label}</th><td>{pt.text}</td></tr>)}</tbody></table>}
    </figure>
  )
}

/** the room around a series plot for the axes' words (CSS pixels), and its height */
const PAD = { top: 8, right: 12, bottom: 18 }
const PLOT_H = 148
const FALLBACK_W = 560
const TICK_CHAR_PX = 6

type SeriesProps = ChartEl['props']
type Axis = 'time' | 'number'

/** A line as the plot draws it: the path, its dots, its latest point (the hollow ring). */
interface LineView { id: string; dashed: boolean; path: string; marks: { x: number; y: number; key: string }[]; latest: { x: number; y: number; at: number } | null; drawn: number }
interface GeoView { x: Range; xTicks: Tick[]; yTicks: Tick[]; lines: LineView[]; points: number; dotAt: (id: string, x: number) => { x: number; y: number } | null }

/** What a series chart draws and reads, whatever holds its points: inline series (the spec's, at the state) or a file
 *  source (read by the app, as columns). Built once per version of the points; nothing here runs on a pointer move but
 *  the look-ups (nearest, valuesAt, dotAt). */
interface SeriesModel {
  series: { id: string; label: string; dashed: boolean; hasData: boolean }[]
  points: number
  latest: number | null
  yTicks: Tick[]
  summary: string
  geometry: (plotW: number) => GeoView
  nearest: (x: number) => number | null
  /** the x `steps` places from `from` (null: from past the end) among the xs the data has */
  step: (from: number | null, steps: number) => number | null
  first: () => number | null
  last: () => number | null
  valuesAt: (x: number) => CursorValue[]
  latestValues: () => CursorValue[]
  /** a page of the values table (null: the newest); built only while the table is open */
  table: (page: number | null) => TablePage
}

/** The inline series' model: the spec's points (bounded by the contract) through the inline geometry. */
function inlineModel(series: SeriesView[], axis: Axis, label: string | undefined): SeriesModel {
  const xs = chartXs(series)
  return {
    series: series.map((s) => ({ id: s.id, label: s.label, dashed: s.dashed, hasData: s.points.some((p) => p.value !== null) })),
    points: series.reduce((n, s) => n + s.points.length, 0),
    latest: latestX(series),
    yTicks: seriesYTicks(series),
    summary: seriesSummary(label, series, axis),
    geometry: (plotW) => {
      const g = seriesGeometry(series, axis, plotW, PLOT_H, plotW)
      const dots = new Map(g.lines.map((l) => [l.series.id, l.dots]))
      return {
        x: g.x, xTicks: g.xTicks, yTicks: g.yTicks, points: g.points,
        lines: g.lines.map((l) => ({ id: l.series.id, dashed: l.series.dashed, path: l.path, drawn: l.drawn, marks: l.marks.map((d) => ({ x: d.x, y: d.y, key: String(d.point.x) })), latest: l.latest && { x: l.latest.x, y: l.latest.y, at: l.latest.point.x } })),
        dotAt: (id, x) => dots.get(id)?.find((p) => p.point.x === x) ?? null,
      }
    },
    nearest: (x) => { const i = nearestIndex(xs, x); return i === null ? null : xs[i]! },
    step: (from, steps) => {
      if (!xs.length) return null
      const cur = from === null ? xs.length : nearestIndex(xs, from)!
      return xs[Math.max(0, Math.min(xs.length - 1, cur + steps))]!
    },
    first: () => xs[0] ?? null,
    last: () => xs.at(-1) ?? null,
    valuesAt: (x) => valuesAt(series, x),
    latestValues: () => latestValues(series),
    table: (page) => seriesTablePage(series, axis, page),
  }
}

/** A file source's model: its columns as they are at this version (uiChartColumns), never copied into objects. */
function fileModel(source: UiChartSource, snap: FeedSnapshot, axis: Axis, label: string | undefined): SeriesModel {
  const pts = snap.points
  const series: ColumnSeries[] = source.series.map((s, i) => ({ id: s.id, label: s.label, dashed: s.line_style === 'dashed', color: i, col: pts.columns[i]! }))
  let union: Float64Array | null = null
  return {
    series: series.map((s) => ({ id: s.id, label: s.label, dashed: s.dashed, hasData: s.col.finite > 0 })),
    points: pts.points,
    latest: latestColumnX(series),
    yTicks: columnYTicks(pts, axis),
    summary: columnSummary(label, series, pts, axis),
    geometry: (plotW) => {
      const g = columnGeometry(series, pts, axis, plotW, PLOT_H)
      const byId = new Map(series.map((s) => [s.id, s]))
      return {
        x: g.x, xTicks: g.xTicks, yTicks: g.yTicks, points: g.points,
        lines: g.lines.map((l) => ({ id: l.id, dashed: l.dashed, path: l.path, drawn: l.drawn, marks: l.marks, latest: l.latest })),
        dotAt: (id, x) => { const s = byId.get(id); return s ? columnDotAt(s, x, g.x, g.y, plotW, PLOT_H) : null },
      }
    },
    nearest: (x) => nearestColumnX(series, x),
    step: (from, steps) => stepColumnX(series, from, steps),
    first: () => firstColumnX(series),
    last: () => lastColumnX(series),
    valuesAt: (x) => columnValuesAt(series, x),
    latestValues: () => columnLatest(series),
    table: (page) => columnTablePage(series, (union ??= columnXs(series)), axis, page),
  }
}

/** A line chart of series on one x axis (time in UTC, or numbers) and one y axis, shared by every series. */
function SeriesChart({ props, series: input, state }: { props: SeriesProps; series: NonNullable<SeriesProps['series']>; state: UiState }) {
  const axis = props.x_axis ?? 'number'
  const model = useMemo(() => inlineModel(seriesOf(input, state), axis, props.label), [input, state, axis, props.label])
  return <SeriesFrame props={props} axis={axis} model={model} />
}

/** Where a chart's file source is read: the surface (session, anchor run, id) at the revision drawn, and the element. */
export interface ChartSourceTarget { session_id: string; run_id: string; surface_id: string; revision: number; element_id: string }

const STATUS_TEXT: Record<FeedStatus, string> = {
  loading: 'Reading the file…', live: '', missing: 'Waiting for the file', retrying: 'Reconnecting — retrying', refused: 'The file cannot be read', stale: 'The surface changed',
}

/** A line chart of series read from a file: the app reads it page by page while the chart is drawn (uiChartFeed). */
function FileSeriesChart({ props, source, target }: { props: SeriesProps; source: UiChartSource; target: ChartSourceTarget | null }) {
  const axis = props.x_axis ?? 'number'
  const snap = useChartFeed(source, axis, target)
  const model = useMemo(() => fileModel(source, snap ?? EMPTY_SNAPSHOT(source), axis, props.label), [source, snap, axis, props.label])
  const status = target === null ? 'refused' : snap?.status ?? 'loading'
  const note = target === null ? 'A file source is shown on a surface' : status === 'live' ? '' : `${STATUS_TEXT[status]}${snap?.message ? ` (${snap.message})` : ''}`
  return (
    <SeriesFrame props={props} axis={axis} model={model} source={{ status, note, path: source.path, generation: snap?.generation ?? 0, offset: snap?.offset ?? 0, version: snap?.version ?? 0 }} />
  )
}

const EMPTY_SNAPSHOTS = new WeakMap<UiChartSource, FeedSnapshot>()
function EMPTY_SNAPSHOT(source: UiChartSource): FeedSnapshot {
  let s = EMPTY_SNAPSHOTS.get(source)
  if (!s) { s = { version: 0, generation: 0, status: 'loading', message: null, points: new SourcePoints(source.series.length), offset: 0, caughtUp: false, pages: 0, verifies: 0, resets: 0 }; EMPTY_SNAPSHOTS.set(source, s) }
  return s
}

const browserTimers = { setTimer: (fn: () => void, ms: number): unknown => window.setTimeout(fn, ms), clearTimer: (h: unknown) => window.clearTimeout(h as number) }

function feedDeps(t: ChartSourceTarget): FeedDeps {
  return {
    ...browserTimers,
    now: () => Date.now(),
    fetchPage: async (req) => {
      try {
        const page = await api.uiChartSourcePage(t.session_id, t.run_id, t.surface_id, t.element_id, req, req.signal)
        return page.status === 'ok' ? { kind: 'page', page } : { kind: 'missing', reason: page.reason }
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.status === 409 && error.body?.error === 'stale_revision') return { kind: 'stale' }
          if (error.status === 403 || error.status === 404 || error.status === 422) return { kind: 'refused', message: error.detail }
          return { kind: 'error', message: error.detail }
        }
        return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/** The feed of a chart's source while the chart is drawn (shared by every drawing of the same source; let go a while
 *  after the last one goes). Its snapshot changes only when its points or its status do. */
function useChartFeed(source: UiChartSource, axis: Axis, target: ChartSourceTarget | null): FeedSnapshot | null {
  const key = target ? JSON.stringify([target.session_id, target.run_id, target.surface_id, target.element_id, axis, source]) : null
  // the feed with the key it reads: a render of another key (a revision that names another source, another series, an
  // axis) never draws the feed of the one before — it draws nothing until its own feed is held
  const [held, setHeld] = useState<{ key: string; feed: ChartFeed } | null>(null)
  const feed = held !== null && held.key === key ? held.feed : null
  const revision = target?.revision ?? 0
  const revisionRef = useRef(revision)
  revisionRef.current = revision
  useEffect(() => {
    if (key === null || target === null) return
    const h = acquireFeed(key, () => new ChartFeed(source, axis, revisionRef.current, feedDeps(target)), browserTimers)
    setHeld({ key, feed: h.feed })
    return () => { h.release(); setHeld((cur) => (cur?.key === key ? null : cur)) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { feed?.setRevision(revision) }, [feed, revision])
  const subscribe = useCallback((fn: () => void) => (feed ? feed.subscribe(fn) : () => {}), [feed])
  const read = useCallback(() => (feed ? feed.snapshot() : null), [feed])
  const snap = useSyncExternalStore(subscribe, read, read)
  // belt and braces: a snapshot whose columns are not this source's series is never drawn
  return snap !== null && snap.points.columns.length === source.series.length ? snap : null
}

/** The chart's frame — legend, plot, cursor, latest ring, values — the same for every kind of points. */
function SeriesFrame({ props, axis, model, source }: {
  props: SeriesProps; axis: Axis; model: SeriesModel
  source?: { status: string; note: string; path: string; generation: number; offset: number; version: number }
}) {
  // a series keeps its colour by its id while it stays in the chart, whatever a later revision puts before it
  const colors = useRef<Map<string, number>>(new Map())
  const colorOf = useMemo(() => {
    colors.current = assignColors(colors.current, model.series.map((s) => s.id), UI_LIMITS.chartSeries)
    const map = colors.current
    return (id: string) => map.get(id) ?? 0
  }, [model])
  const box = useRef<HTMLDivElement>(null)
  const width = Math.max(160, useWidth(box, FALLBACK_W))
  const left = Math.min(72, Math.max(26, 10 + TICK_CHAR_PX * model.yTicks.reduce((m, t) => Math.max(m, t.text.length), 0)))
  const plotW = Math.max(40, width - left - PAD.right)
  // one column per CSS pixel of the plot: what a dense line keeps is what a pixel can show
  const geo = useMemo(() => model.geometry(plotW), [model, plotW])
  const latest = model.latest
  const hasXs = model.points > 0

  // the cursor: an x the data has, kept across revisions (a later point does not move it); null — the latest values
  const [cursor, setCursor] = useState<number | null>(null)
  const [spoken, setSpoken] = useState('')
  // a later revision that changes the chart's kind of x drops the cursor (its x meant something else); so does a file
  // read again from its start
  useEffect(() => { setCursor(null); setSpoken('') }, [axis, source?.generation])
  const at = cursor !== null && hasXs ? model.nearest(cursor) : null
  const readout: CursorValue[] = useMemo(() => (at !== null ? model.valuesAt(at) : model.latestValues()), [model, at])
  const shownX = at ?? latest
  const speak = useCallback((x: number) => {
    setSpoken(`${xWords(x, axis)}: ${model.valuesAt(x).map((v) => `${v.label} ${v.point === null ? 'none' : v.point.value === null ? 'no value' : exactText(v.point.value)}`).join(', ')}`)
  }, [model, axis])
  const onPointer = (e: PointerEvent<SVGSVGElement>) => {
    if (!hasXs) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pos = (e.clientX - rect.left - left) / plotW
    const x = model.nearest(xAtPos(Math.max(0, Math.min(1, pos)), geo.x))
    if (x !== null && x !== cursor) setCursor(x)
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!hasXs) return
    const step = e.shiftKey ? 10 : 1
    let next: number | null
    switch (e.key) {
      case 'ArrowLeft': next = model.step(at, -step); break
      case 'ArrowRight': next = at === null ? model.last() : model.step(at, step); break
      case 'Home': next = model.first(); break
      case 'End': next = model.last(); break
      case 'Escape': if (cursor === null) return; e.preventDefault(); setCursor(null); setSpoken(''); return
      default: return
    }
    e.preventDefault()
    if (next === null) return
    setCursor(next)
    speak(next)
  }

  const arrival = useArrival(latest)
  const xPx = (x: number) => Math.round(((x / geo.x.unit - geo.x.lo) / (geo.x.hi - geo.x.lo)) * plotW * 100) / 100
  const H = PAD.top + PLOT_H + PAD.bottom
  const drawn = geo.lines.reduce((n, l) => n + l.drawn, 0)
  const marks = geo.lines.reduce((n, l) => n + l.marks.length, 0)
  const byId = new Map(model.series.map((s) => [s.id, s]))
  return (
    <figure className="uis-chart series" data-chart="line" data-x-axis={axis} data-series-count={model.series.length} data-points={geo.points}
            data-drawn={drawn} data-marks={marks} data-latest-x={latest ?? undefined} data-cursor={at ?? undefined} data-testid="ui-chart-series"
            data-source={source ? 'file' : undefined} data-source-status={source?.status} data-source-generation={source?.generation} data-source-offset={source?.offset}
            data-plot-width={plotW} data-plot-left={left}>
      <div className="uis-chart-head">
        {props.label && <figcaption className="uis-title">{props.label}</figcaption>}
        {shownX !== null && (
          <span className={`uis-chart-at${at !== null ? ' cursor' : ''}`} data-testid="ui-chart-at" title={axis === 'time' ? utcText(shownX) : String(shownX)}>
            {axis === 'time' ? utcText(shownX).replace(/^\d{4}-\d\d-\d\d /, '').replace(' UTC', '') : formatValue(shownX)}
          </span>
        )}
        {props.y_label && <span className="uis-chart-ylabel">{props.y_label}</span>}
      </div>
      <ul className="uis-legend" aria-label="Series">
        {readout.map((v) => {
          const s = byId.get(v.id)
          const color = colorOf(v.id)
          return (
            <li key={v.id} className={`uis-series c${color}`} data-series={v.id} data-style={v.dashed ? 'dashed' : 'solid'}>
              <svg width="16" height="8" aria-hidden="true" focusable="false"><line className="uis-series-line" x1={1} x2={15} y1={4} y2={4} strokeDasharray={v.dashed ? '4 3' : undefined} /></svg>
              <span className="uis-legend-label">{v.label}</span>
              {v.point && v.point.value !== null
                ? <span className="uis-legend-value" title={exactText(v.point.value)} data-testid="ui-chart-value" data-x={v.point.x} data-value={exactText(v.point.value)}>{v.point.text}</span>
                : !s?.hasData ? <span className="uis-legend-note">no data yet</span> : <span className="uis-legend-value none">—</span>}
            </li>
          )
        })}
      </ul>
      <div className="uis-plot" ref={box} tabIndex={hasXs ? 0 : undefined} onKeyDown={onKey} onBlur={() => { setCursor(null); setSpoken('') }}
           aria-label={`${props.label?.trim() || 'Chart'}: arrow keys read each point`} role="group" aria-keyshortcuts="ArrowLeft ArrowRight Home End Escape">
        <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img" aria-label={model.summary} focusable="false"
             onPointerMove={onPointer} onPointerLeave={() => setCursor(null)}>
          <g transform={`translate(${left} ${PAD.top})`}>
            {geo.points > 0 && geo.yTicks.map((t, i) => {
              const y = Math.round((PLOT_H - t.pos * PLOT_H) * 100) / 100
              return (
                <g key={`y${i}`}>
                  <line className="uis-chart-grid" x1={0} x2={plotW} y1={y} y2={y} />
                  <text className="uis-chart-tick" x={-6} y={y} textAnchor="end" dominantBaseline="middle">{t.text}</text>
                </g>
              )
            })}
            <line className="uis-chart-axis" x1={0} x2={plotW} y1={PLOT_H} y2={PLOT_H} />
            {geo.points > 0 && geo.xTicks.map((t, i) => (
              <text key={`x${i}`} className="uis-chart-tick" x={Math.round(t.pos * plotW * 100) / 100} y={PLOT_H + 13} textAnchor={t.pos < 0.08 ? 'start' : t.pos > 0.92 ? 'end' : 'middle'}>{t.text}</text>
            ))}
            {geo.points === 0 && <text className="uis-chart-empty" x={plotW / 2} y={PLOT_H / 2} textAnchor="middle" dominantBaseline="middle">Waiting for data</text>}
            {latest !== null && <line className="uis-latest-rule" x1={xPx(latest)} x2={xPx(latest)} y1={0} y2={PLOT_H} data-testid="ui-chart-latest-rule" />}
            {geo.lines.map((l) => (
              <g key={l.id} className={`uis-series c${colorOf(l.id)}`} data-series={l.id} data-style={l.dashed ? 'dashed' : 'solid'} data-drawn={l.drawn}>
                {l.path && <path className="uis-series-line" d={l.path} fill="none" strokeDasharray={l.dashed ? '5 4' : undefined} />}
                {l.marks.map((d) => <circle key={d.key} className="uis-series-dot" cx={d.x} cy={d.y} r={2} />)}
                {l.latest && <circle className="uis-series-latest" cx={l.latest.x} cy={l.latest.y} r={3.5} data-testid="ui-chart-latest" data-x={l.latest.at} />}
                {l.latest && arrival !== null && l.latest.at === latest && <circle key={arrival} className="uis-series-arrive" cx={l.latest.x} cy={l.latest.y} r={3.5} aria-hidden="true" />}
              </g>
            ))}
            {at !== null && (
              <g className="uis-cursor" data-testid="ui-chart-cursor">
                <line className="uis-cursor-rule" x1={xPx(at)} x2={xPx(at)} y1={0} y2={PLOT_H} />
                {geo.lines.map((l) => {
                  const d = geo.dotAt(l.id, at)
                  return d ? <circle key={l.id} className={`uis-cursor-dot uis-series c${colorOf(l.id)}`} cx={d.x} cy={d.y} r={3} /> : null
                })}
              </g>
            )}
          </g>
        </svg>
      </div>
      <span className="uis-sr-only" aria-live="polite" data-testid="ui-chart-spoken">{spoken}</span>
      {axis === 'time' && <span className="uis-chart-note" data-testid="ui-chart-asof">UTC{latest !== null ? ` · latest ${utcText(latest)}` : ''}</span>}
      {source && source.note && <span className="uis-chart-note" role="status" data-testid="ui-chart-source-status" data-status={source.status} title={source.path}>{source.note}</span>}
      {hasXs && <SeriesValues model={model} axis={axis} label={props.label} />}
    </figure>
  )
}

/** The exact values, as a table built only while it is open, one page at a time (the newest page first). */
function SeriesValues({ model, axis, label }: { model: SeriesModel; axis: 'time' | 'number'; label?: string }) {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<number | null>(null)
  const view = useMemo(() => (open ? model.table(page) : null), [open, model, page])
  return (
    <details className="uis-chart-values" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} data-testid="ui-chart-values">
      <summary>Values</summary>
      {view && (
        <>
          <Pager view={view} onPage={(p) => setPage(p >= view.pages - 1 ? null : p)} />
          <div className="uis-table" role="region" tabIndex={0} aria-label={`${label ?? 'Chart'} values`}>
            <table>
              <caption className="uis-sr-only">{model.summary}</caption>
              <thead><tr><th scope="col">{axis === 'time' ? 'Time (UTC)' : 'x'}</th>{model.series.map((s) => <th key={s.id} scope="col" className="num">{s.label}</th>)}</tr></thead>
              <tbody>{view.xs.map((x, i) => <tr key={x.x}><th scope="row">{x.text}</th>{view.cells[i]!.map((c, j) => <td key={j} className="num">{c}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </>
      )}
    </details>
  )
}

function Pager({ view, onPage }: { view: { page: number; pages: number; from: number; to: number; total: number }; onPage: (page: number) => void }) {
  if (view.pages <= 1) return null
  return (
    <div className="uis-pager" data-testid="ui-chart-pager">
      <button type="button" className="uis-link" disabled={view.page === 0} onClick={() => onPage(view.page - 1)} aria-label="Earlier rows">‹</button>
      <span>{view.from + 1}–{view.to} of {view.total.toLocaleString()}</span>
      <button type="button" className="uis-link" disabled={view.page >= view.pages - 1} onClick={() => onPage(view.page + 1)} aria-label="Later rows">›</button>
    </div>
  )
}

/** A labelled chart's values, built only while open, a page at a time. */
function LazyValues({ label, count, head, rows }: { label?: string; count: number; head: [string, string]; rows: (from: number, to: number) => string[][] }) {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(0)
  const pages = Math.max(1, Math.ceil(count / TABLE_PAGE_ROWS))
  const at = Math.min(page, pages - 1)
  const from = at * TABLE_PAGE_ROWS
  const shown = open ? rows(from, from + TABLE_PAGE_ROWS) : []
  return (
    <details className="uis-chart-values" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} data-testid="ui-chart-values">
      <summary>Values</summary>
      {open && (
        <>
          <Pager view={{ page: at, pages, from, to: from + shown.length, total: count }} onPage={setPage} />
          <div className="uis-table" role="region" tabIndex={0} aria-label={`${label ?? 'Chart'} values`}>
            <table>
              <thead><tr><th scope="col">{head[0]}</th><th scope="col" className="num">{head[1]}</th></tr></thead>
              <tbody>{shown.map((r, i) => <tr key={from + i}><th scope="row">{r[0]}</th><td className="num">{r[1]}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
    </details>
  )
}
