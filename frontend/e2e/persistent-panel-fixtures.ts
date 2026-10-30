/** FIXTURES of the persistent-panel scenario (frontend/e2e/persistent-panel.e2e.ts and its backend,
 *  backend-ts/scripts/persistent_ui_e2e_server.ts; the docs: docs/persistent-panel-demo.md). A module, not a test:
 *  importing it runs nothing and starts nothing. Node (the test) and Bun (the server and its scripted models) both
 *  import it, so the panel the scripted owner publishes and the panel the test expects come from the same functions.
 *
 *  What is a FIXTURE here, said plainly:
 *  - the market data: FXDEMO is not a traded instrument. Its quotes are served by a local HTTP server the e2e starts on
 *    the loopback (TICKS, STAGES); every quote body says `"fixture": true`. Nothing here is a market price.
 *  - the three forecasts: fixed arithmetic rules (persistence, a linear drift, a mean reversion) written by the
 *    scenario, not a model's judgement and not advice of any kind. They exist so three independent runs have three
 *    different, checkable answers.
 *  - the "agents": SCRIPTED MODELS (backend-ts/src/llm/scripted.ts) whose tool calls are written in advance. They
 *    prove the harness's path — tool call → RunManager → tools → SQLite → REST/SSE → page — and nothing about what a
 *    real model would do.
 *
 *  The scenario's rules (the owner's, not the product's): every forecast is frozen once published — copied from the
 *  panel as read back, never recomputed; a quote is appended only when its market time is newer than the last one
 *  (equal: a duplicate, older: stale, neither appended); a failed fetch keeps the last successful as-of; an error is
 *  computed only for a forecast point strictly after the common origin (the origin is drawn, never scored) and only
 *  where an actual point exists at exactly that time (no interpolation), "暂无" elsewhere. */

// ---------------------------------------------------------------- the protocol every forecaster shares

export const PANEL_ID = 'fx_forecast'
/** A name of the e2e's own: the server's web hooks resolve it and carry its requests to the local fixture server. */
export const FIXTURE_HOST = 'quotes.fixture.e2e.example'
export const QUOTE_PATH = '/v1/quote'
export const SYMBOL = 'FXDEMO'
export const UNIT = 'points'
export const QUOTE_URL = `https://${FIXTURE_HOST}${QUOTE_PATH}?symbol=${SYMBOL}`
export const FIXTURE_NOTICE = 'FIXTURE market data: a local, scripted test feed. Not a market price, not investment information.'

export const MINUTE_MS = 60_000
/** The forecast origin: the market time of the quote every forecast starts from (a fixture time, UTC). */
export const ORIGIN_MS = Date.UTC(2026, 9, 12, 1, 30, 0, 0)
export const STEP_MS = 5 * MINUTE_MS
/** The forecast points: origin + 5, 10, 15 minutes (market time, epoch ms UTC). */
export const HORIZONS_MS: readonly number[] = [1, 2, 3].map((k) => ORIGIN_MS + k * STEP_MS)

export interface ForecastProtocol {
  symbol: string; unit: string; origin_ms: number; origin: string; horizons_ms: number[]; horizons: string[]; quote_url: string; note: string
}
export const PROTOCOL: ForecastProtocol = {
  symbol: SYMBOL, unit: UNIT, origin_ms: ORIGIN_MS, origin: new Date(ORIGIN_MS).toISOString(),
  horizons_ms: [...HORIZONS_MS], horizons: HORIZONS_MS.map((x) => new Date(x).toISOString()), quote_url: QUOTE_URL, note: FIXTURE_NOTICE,
}
export const protocolBlock = (p: ForecastProtocol = PROTOCOL) => `<forecast_protocol>${JSON.stringify(p)}</forecast_protocol>`
export function protocolIn(text: string): ForecastProtocol | null {
  const m = /<forecast_protocol>([\s\S]*?)<\/forecast_protocol>/.exec(text)
  if (!m) return null
  try { return JSON.parse(m[1]!) as ForecastProtocol } catch { return null }
}

// ---------------------------------------------------------------- the fixture market

export interface Quote { symbol: string; unit: string; asof_ms: number; price: number }
/** The fixture's ticks: the origin, then +5 and +10 minutes (the +15 point is never reached: its errors stay 暂无). */
export const TICKS: readonly Quote[] = [
  { symbol: SYMBOL, unit: UNIT, asof_ms: ORIGIN_MS, price: 100 },
  { symbol: SYMBOL, unit: UNIT, asof_ms: ORIGIN_MS + STEP_MS, price: 100.8 },
  { symbol: SYMBOL, unit: UNIT, asof_ms: ORIGIN_MS + 2 * STEP_MS, price: 100.3 },
]

export type FixtureReply = { kind: 'quote'; quote: Quote } | { kind: 'error'; status: number }
/** What the fixture server answers, stage by stage (the test sets the stage; within a stage the replies are served
 *  in order, the last one again for every later request):
 *  0 — the origin quote (the owner's first run and both relay turns);
 *  1 — the +5 min quote, again on the repeated collection (a duplicate, appended once);
 *  2 — HTTP 503 (a failed fetch), then the origin quote again (stale: older than the last as-of), then +10 min. */
export const STAGES: readonly (readonly FixtureReply[])[] = [
  [{ kind: 'quote', quote: TICKS[0]! }],
  [{ kind: 'quote', quote: TICKS[1]! }],
  [{ kind: 'error', status: 503 }, { kind: 'quote', quote: TICKS[0]! }, { kind: 'quote', quote: TICKS[2]! }],
]

export function quoteBody(q: Quote): string {
  return JSON.stringify({ fixture: true, notice: FIXTURE_NOTICE, symbol: q.symbol, unit: q.unit, asof: new Date(q.asof_ms).toISOString(), asof_ms: q.asof_ms, price: q.price })
}

const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const r4 = (x: number) => Math.round(x * 1e4) / 1e4
export const iso = (ms: number) => new Date(ms).toISOString()
/** A market time as the panel shows it: HH:MM UTC of the fixture day. */
export const hhmm = (ms: number) => `${iso(ms).slice(11, 16)} UTC`

/** One fetch_url call, as the scenario reads its result. `source` is the saved response's id (fetch_url's
 *  source_id), or the call's id when nothing was saved: what makes a collection's log row its own. */
export type FetchOutcome =
  | { kind: 'quote'; at: string; source: string; quote: Quote }
  | { kind: 'failed'; at: string; source: string; reason: string }

/** fetch_url's result → an outcome. A body that is not a fixture quote of this symbol and unit is a failure. */
export function outcomeOfFetch(result: unknown, callId: string): FetchOutcome {
  const r = rec(result)
  const at = typeof r.retrieved_at === 'string' ? r.retrieved_at : 'unknown time'
  const source = typeof r.source_id === 'string' ? r.source_id : callId
  if (r.status !== 'ok') {
    const why = r.status === 'http_error' ? `HTTP ${String(r.http_status)}` : `${String(r.status)}${r.reason || r.error ? `: ${String(r.reason ?? r.error).slice(0, 120)}` : ''}`
    return { kind: 'failed', at, source, reason: why }
  }
  let body: Record<string, unknown>
  try { body = rec(JSON.parse(String(r.text ?? ''))) } catch { return { kind: 'failed', at, source, reason: 'the body is not JSON' } }
  const asof = body.asof_ms
  const price = body.price
  if (body.fixture !== true || body.symbol !== SYMBOL || body.unit !== UNIT || typeof asof !== 'number' || !Number.isSafeInteger(asof)
      || typeof price !== 'number' || !Number.isFinite(price)) return { kind: 'failed', at, source, reason: 'not a quote of this symbol and unit' }
  return { kind: 'quote', at, source, quote: { symbol: SYMBOL, unit: UNIT, asof_ms: asof, price } }
}

// ---------------------------------------------------------------- the three forecasts (fixed rules, not advice)

export type AgentKey = 'owner' | 'A' | 'B'
export const AGENT_KEYS: readonly AgentKey[] = ['owner', 'A', 'B']
export const AGENTS: Record<AgentKey, { label: string; rule: string; mechanism: string; route: string; step: number }> = {
  owner: { label: '主线 owner', rule: '持平：每个时间点 = 起点价', mechanism: '主线 run 自己发布', route: 'scripted:pf-owner', step: 0 },
  A: { label: 'Agent A', rule: '线性漂移：每 5 分钟 +0.40', mechanism: 'relay 回合 A → 主线汇总', route: 'scripted:pf-a', step: 0.4 },
  B: { label: 'Agent B', rule: '均值回归：每 5 分钟 −0.25', mechanism: 'relay 回合 B → 主线汇总', route: 'scripted:pf-b', step: -0.25 },
}

export interface ForecastPoint { x: number; value: number }
export interface Forecast {
  agent: AgentKey; symbol: string; unit: string; origin_ms: number; origin_price: number; issued_at: string; points: ForecastPoint[]
}

/** A forecaster's answer from the origin quote: its rule at every protocol point. */
export function makeForecast(agent: AgentKey, origin: Quote, issuedAt: string): Forecast {
  return {
    agent, symbol: SYMBOL, unit: UNIT, origin_ms: origin.asof_ms, origin_price: origin.price, issued_at: issuedAt,
    points: HORIZONS_MS.map((x, i) => ({ x, value: r4(origin.price + AGENTS[agent].step * (i + 1)) })),
  }
}
/** The bounded, structured form a forecaster hands back in its answer (the relay carries the answer as written). */
export const forecastBlock = (f: Forecast) => `<forecast>${JSON.stringify(f)}</forecast>`

/** A forecast exactly on the protocol: this symbol and unit, the origin, the three points in order, finite values. */
export function validForecast(v: unknown): Forecast | null {
  const f = rec(v)
  if (!AGENT_KEYS.includes(f.agent as AgentKey) || f.symbol !== SYMBOL || f.unit !== UNIT || f.origin_ms !== ORIGIN_MS) return null
  if (typeof f.origin_price !== 'number' || !Number.isFinite(f.origin_price) || typeof f.issued_at !== 'string' || !f.issued_at) return null
  const pts = Array.isArray(f.points) ? f.points.map(rec) : []
  if (pts.length !== HORIZONS_MS.length || pts.some((p, i) => p.x !== HORIZONS_MS[i] || typeof p.value !== 'number' || !Number.isFinite(p.value))) return null
  return {
    agent: f.agent as AgentKey, symbol: SYMBOL, unit: UNIT, origin_ms: ORIGIN_MS, origin_price: f.origin_price, issued_at: f.issued_at,
    points: pts.map((p) => ({ x: p.x as number, value: p.value as number })),
  }
}
/** Every valid <forecast> block in a text, in order (an invalid block is skipped, never repaired). */
export function forecastsIn(text: string): Forecast[] {
  const out: Forecast[] = []
  for (const m of text.matchAll(/<forecast>\s*(\{(?:(?!<forecast>)[\s\S])*?\})\s*<\/forecast>/g)) {
    try { const f = validForecast(JSON.parse(m[1]!)); if (f) out.push(f) } catch { /* not JSON: skipped */ }
  }
  return out
}

// ---------------------------------------------------------------- the panel's model

export interface LogRow { at: string; result: string; asof: string; source: string }
export interface PanelModel {
  /** the actual series: comparison timestamps plus the latest tail, strictly increasing, at most REALIZED_MAX points */
  realized: ForecastPoint[]
  forecasts: Record<AgentKey, Forecast | null>
  /** the newest successful quote's market time, and when that fetch was made */
  last_success: { asof_ms: number; at: string } | null
  /** the newest collection attempt, whatever it gave */
  last_attempt: { at: string; result: string } | null
  /** the collection log, newest last, at most LOG_ROWS */
  log: LogRow[]
}

/** UI_LIMITS.chartPoints (contract): every point of every series together. */
export const CHART_POINTS_MAX = 100
/** A forecast series: the origin point and the three forecast points. */
export const FORECAST_SERIES_POINTS = 1 + HORIZONS_MS.length
/** The actual series' window: what the chart's total leaves after three full forecast series (100 − 3 × 4 = 88). */
export const REALIZED_MAX = CHART_POINTS_MAX - AGENT_KEYS.length * FORECAST_SERIES_POINTS
export const LOG_ROWS = 12

export const RESULT = { appended: '成功：新点已追加', duplicate: '成功：重复（该 market 时间已有）', stale: '过旧：早于已有 as-of，未追加', failed: '失败' } as const

export function emptyModel(): PanelModel {
  return { realized: [], forecasts: { owner: null, A: null, B: null }, last_success: null, last_attempt: null, log: [] }
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Keep comparison timestamps and use the remaining capacity for the newest points. Input points have unique,
 *  increasing x values. This keeps completed comparisons while the tail advances within the chart's fixed bound. */
export function retainComparisonPoints<T extends { x: number }>(points: readonly T[], comparisonTimes: readonly number[], maximum: number): T[] {
  if (points.length <= maximum) return [...points]
  const times = new Set(comparisonTimes)
  const pinned = points.filter((p) => times.has(p.x))
  if (pinned.length >= maximum) throw new Error('comparison points leave no room for the actual tail')
  const tail = points.filter((p) => !times.has(p.x)).slice(-(maximum - pinned.length))
  return [...pinned, ...tail].sort((a, b) => a.x - b.x)
}

/** The outcomes of collections merged into a model — pure and idempotent: an outcome whose log row (by its source)
 *  is already there was merged before (an earlier publication of this same collection) and changes nothing. */
export function applyOutcomes(model: PanelModel, outcomes: readonly FetchOutcome[]): PanelModel {
  const m = clone(model)
  for (const o of outcomes) {
    if (m.log.some((row) => row.source === o.source)) continue
    let result: string
    let asof = ''
    if (o.kind === 'failed') {
      result = `${RESULT.failed}（${o.reason}）`
    } else {
      const last = m.realized.at(-1)?.x ?? -Infinity
      asof = iso(o.quote.asof_ms)
      if (o.quote.asof_ms > last) {
        m.realized.push({ x: o.quote.asof_ms, value: o.quote.price })
        result = RESULT.appended
      } else if (o.quote.asof_ms === last) {
        result = RESULT.duplicate
      } else {
        result = RESULT.stale
      }
      if (result !== RESULT.stale) m.last_success = { asof_ms: m.realized.at(-1)!.x, at: o.at }
    }
    m.last_attempt = { at: o.at, result }
    m.log.push({ at: o.at, result, asof, source: o.source })
  }
  m.realized = retainComparisonPoints(m.realized, HORIZONS_MS, REALIZED_MAX)
  if (m.log.length > LOG_ROWS) m.log = m.log.slice(-LOG_ROWS)
  return m
}

/** A forecast added only where there is none: a published forecast is never replaced. */
export function withForecast(model: PanelModel, f: Forecast): PanelModel {
  if (model.forecasts[f.agent] !== null) return model
  const m = clone(model)
  m.forecasts[f.agent] = clone(f)
  return m
}

export const sameModel = (a: PanelModel, b: PanelModel) => JSON.stringify(a) === JSON.stringify(b)

/** The actual value at exactly a market time, or null. */
const actualAt = (m: PanelModel, x: number) => m.realized.find((p) => p.x === x)?.value ?? null

export interface ErrorRow { [key: string]: string | number }
/** One row per forecast point: the actual (or 暂无), each forecast and its absolute error where the actual exists. */
export function errorRows(m: PanelModel): ErrorRow[] {
  return HORIZONS_MS.map((x, i) => {
    const actual = actualAt(m, x)
    const row: ErrorRow = { t: hhmm(x), actual: actual ?? '暂无' }
    for (const k of AGENT_KEYS) {
      const f = m.forecasts[k]
      const v = f ? f.points[i]!.value : null
      row[`f_${k}`] = v ?? '等待'
      // HORIZONS_MS are all after the origin: the origin itself has no row and no error
      row[`e_${k}`] = v !== null && actual !== null && x > f!.origin_ms ? r4(Math.abs(v - actual)) : '暂无'
    }
    return row
  })
}
/** The points a forecast is scored on: strictly after its origin (the common origin is known to every forecaster —
 *  drawn so the lines start together, never scored) and with an actual point at exactly that market time. */
export function scoredPoints(m: PanelModel, f: Forecast): { x: number; forecast: number; actual: number }[] {
  return f.points.filter((p) => p.x > f.origin_ms).flatMap((p) => { const a = actualAt(m, p.x); return a === null ? [] : [{ x: p.x, forecast: p.value, actual: a }] })
}
/** Mean absolute error over the scored points; null while there is none (no score before coverage). */
export function maeOf(m: PanelModel, k: AgentKey): { value: number | null; n: number } {
  const f = m.forecasts[k]
  if (!f) return { value: null, n: 0 }
  const errs = scoredPoints(m, f).map((p) => Math.abs(p.forecast - p.actual))
  return { value: errs.length ? r4(errs.reduce((s, e) => s + e, 0) / errs.length) : null, n: errs.length }
}
export const coveredCount = (m: PanelModel) => HORIZONS_MS.filter((x) => actualAt(m, x) !== null).length

// ---------------------------------------------------------------- the panel as a present_ui spec, and back

const STATUS = { asof: '最后成功 market as-of', at: '最后成功取数时间', attempt: '最近一次取数' } as const
const series = (k: AgentKey) => `fc_${k}`

export function panelSpec(m: PanelModel): Record<string, unknown> {
  const fcSeries = AGENT_KEYS.map((k) => {
    const f = m.forecasts[k]
    return {
      id: series(k), label: f ? `预测 ${AGENTS[k].label}` : `预测 ${AGENTS[k].label}（等待提交）`, line_style: 'dashed',
      data: f ? [{ x: f.origin_ms, value: f.origin_price }, ...f.points] : [],
    }
  })
  const lastAsof = m.last_success ? iso(m.last_success.asof_ms) : '暂无'
  const covered = coveredCount(m)
  const elements: Record<string, unknown> = {
    root: { type: 'stack', children: ['notice', 'chart', 'status', 'errors', 'mae', 'sources', 'log', 'bounds'] },
    notice: { type: 'text', props: { text: `${SYMBOL} · 单位 ${UNIT} · 预测起点 ${iso(ORIGIN_MS)} · 预测时间点 ${HORIZONS_MS.map(hhmm).join(' / ')}。数据源：FIXTURE（本地受控测试行情，非真实市场）。只对比预测与已发生的数值，不构成任何投资判断。` } },
    chart: { type: 'chart', props: {
      kind: 'line', x_axis: 'time', label: `${SYMBOL}（FIXTURE）实际与三份预测`, y_label: UNIT,
      series: [{ id: 'actual', label: `实际 ${SYMBOL}（FIXTURE）`, line_style: 'solid', data: m.realized.map((p) => ({ ...p })) }, ...fcSeries],
    } },
    status: { type: 'table', props: { caption: '采集状态', columns: [{ key: 'item', label: '项目' }, { key: 'value', label: '值' }], rows: [
      { item: STATUS.asof, value: lastAsof },
      { item: STATUS.at, value: m.last_success?.at ?? '暂无' },
      { item: STATUS.attempt, value: m.last_attempt ? `${m.last_attempt.at} · ${m.last_attempt.result}` : '暂无' },
    ] } },
    errors: { type: 'table', props: {
      caption: `同一时间点的绝对误差（已覆盖 ${covered}/${HORIZONS_MS.length} 个时间点；未发生的时间点为 暂无）`,
      columns: [{ key: 't', label: '时间点' }, { key: 'actual', label: '实际' },
        ...AGENT_KEYS.flatMap((k) => [{ key: `f_${k}`, label: `${AGENTS[k].label} 预测` }, { key: `e_${k}`, label: `${AGENTS[k].label} |误差|` }])],
      rows: errorRows(m),
    } },
    mae: { type: 'row', children: AGENT_KEYS.map((k) => `mae_${k}`) },
    sources: { type: 'table', props: { caption: '预测来源（发布后冻结）', columns: [
      { key: 'agent', label: '预测者' }, { key: 'rule', label: '规则' }, { key: 'mechanism', label: '回传方式' },
      { key: 'issued_at', label: '发布时间' }, { key: 'origin', label: '起点' }, { key: 'origin_price', label: '起点价' },
    ], rows: AGENT_KEYS.map((k) => {
      const f = m.forecasts[k]
      return { agent: AGENTS[k].label, rule: AGENTS[k].rule, mechanism: AGENTS[k].mechanism, issued_at: f?.issued_at ?? '等待提交', origin: iso(ORIGIN_MS), origin_price: f ? f.origin_price : '等待提交' }
    }) } },
    log: { type: 'table', props: { caption: `采集记录（最近 ${LOG_ROWS} 条）`, columns: [
      { key: 'at', label: '取数时间' }, { key: 'result', label: '结果' }, { key: 'asof', label: 'market as-of' }, { key: 'source', label: '来源响应' },
    ], rows: m.log.map((r) => ({ ...r })) } },
    bounds: { type: 'text', props: { text: `图表总点数上限 ${CHART_POINTS_MAX}（所有序列合计）：三份预测各 ${FORECAST_SERIES_POINTS} 点（起点 + ${HORIZONS_MS.length} 个时间点），实际序列最多 ${REALIZED_MAX} 点：保留预测对照时刻的实际点，其余额度保留最新点；超出后省略更早的非对照点。实际点按 market 时间追加去重，过旧的数据不回退。` } },
  }
  for (const k of AGENT_KEYS) {
    const mae = maeOf(m, k)
    elements[`mae_${k}`] = { type: 'metric', props: { label: `MAE ${AGENTS[k].label}（n=${mae.n}）`, value: mae.value ?? '暂无', unit: UNIT } }
  }
  const fallback = `${SYMBOL}（FIXTURE 数据）三方预测对比：最后成功 as-of ${lastAsof}；已覆盖 ${covered}/${HORIZONS_MS.length} 个预测时间点；`
    + AGENT_KEYS.map((k) => { const e = maeOf(m, k); return `${AGENTS[k].label} MAE ${e.value ?? '暂无'}` }).join('，') + '。'
  return { version: 1, surface_id: PANEL_ID, title: `${SYMBOL} 三方预测 vs 实际（FIXTURE 数据）`, kind: 'native', fallback, root: 'root', elements }
}

/** present_ui's arguments for a session-scoped publication at the revision the caller read (0: create). */
export function publishArgs(m: PanelModel, expectedRevision: number): Record<string, unknown> {
  return { ...panelSpec(m), scope: 'session', expected_revision: expectedRevision }
}

/** The model back from a spec as read_ui returns it (or as present_ui was called with): everything the panel shows
 *  is everything there is — no hidden state. Throws when the spec is not this panel. */
export function modelOfSpec(specIn: unknown): PanelModel {
  const spec = rec(specIn)
  const el = rec(spec.elements)
  const chart = rec(rec(el.chart).props)
  if (spec.surface_id !== PANEL_ID || !Array.isArray(chart.series)) throw new Error('not the forecast panel')
  const byId = new Map((chart.series as unknown[]).map(rec).map((s) => [String(s.id), (Array.isArray(s.data) ? s.data : []).map(rec)]))
  const m = emptyModel()
  m.realized = (byId.get('actual') ?? []).map((p) => ({ x: Number(p.x), value: Number(p.value) }))
  const srcRows = (rec(rec(el.sources).props).rows as unknown[] ?? []).map(rec)
  AGENT_KEYS.forEach((k, i) => {
    const pts = byId.get(series(k)) ?? []
    const row = srcRows[i] ?? {}
    if (pts.length === 0 || typeof row.origin_price !== 'number') return
    const f = validForecast({
      agent: k, symbol: SYMBOL, unit: UNIT, origin_ms: Number(pts[0]!.x), origin_price: row.origin_price, issued_at: row.issued_at,
      points: pts.slice(1).map((p) => ({ x: Number(p.x), value: Number(p.value) })),
    })
    if (f === null || Number(pts[0]!.value) !== f.origin_price) throw new Error(`the panel's forecast ${k} is not on the protocol`)
    m.forecasts[k] = f
  })
  const status = new Map((rec(rec(el.status).props).rows as unknown[] ?? []).map(rec).map((r) => [String(r.item), String(r.value)]))
  const asof = status.get(STATUS.asof)
  const at = status.get(STATUS.at)
  if (asof && asof !== '暂无' && at && at !== '暂无') m.last_success = { asof_ms: Date.parse(asof), at }
  const attempt = status.get(STATUS.attempt)
  if (attempt && attempt !== '暂无') {
    const cut = attempt.indexOf(' · ')
    m.last_attempt = { at: attempt.slice(0, cut), result: attempt.slice(cut + 3) }
  }
  m.log = ((rec(rec(el.log).props).rows as unknown[]) ?? []).map(rec).map((r) => ({ at: String(r.at), result: String(r.result), asof: String(r.asof), source: String(r.source) }))
  return m
}

/** The forecast series of a spec, as JSON text: what must stay byte-for-byte the same at every later revision. */
export function forecastSeriesJson(specIn: unknown): Record<AgentKey, string> {
  const chart = rec(rec(rec(rec(specIn).elements).chart).props)
  const all = (Array.isArray(chart.series) ? chart.series : []).map(rec)
  return Object.fromEntries(AGENT_KEYS.map((k) => [k, JSON.stringify(all.find((s) => s.id === series(k))?.data ?? null)])) as Record<AgentKey, string>
}

// ---------------------------------------------------------------- what the person says, the gates

/** Words in the person's messages the scripted routes read (the protocol rides along as a block). */
export const WORDS = {
  start: `PF_START 请为 ${SYMBOL} 建一个持续更新的预测对比面板，并做你自己的那份预测。${protocolBlock()}`,
  relay: `PF_RELAY 请各自独立给出 ${SYMBOL} 的预测，按下面的协议，用 <forecast> 块回传。${protocolBlock()}`,
  aggregate: 'PF_AGGREGATE 把 A、B 的预测汇总进面板，然后定时采集实际数据。',
} as const
/** The watch notes the owner sets: the wake run reads which collection it is. */
export const WAKE_NOTE = (n: number) => `PF_COLLECT ${n}`
/** The wake 2 run waits here (when the test armed it) after publishing the failed collection, before its next fetch. */
export const GATES = { afterFailure: 'pf-after-failure' } as const
/** The final answers' markers. */
export const MARK = {
  created: 'PF_PANEL_CREATED', aggregated: 'PF_AGGREGATED', wake: 'PF_WAKE_DONE', probes: 'PF_PROBES', error: 'PF_ERROR',
} as const
/** The delay of each timer watch (the product's minimum is 30 s). */
export const WAKE_DELAY_S = 30
