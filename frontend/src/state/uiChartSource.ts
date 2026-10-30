/** A chart's file source, read incrementally (pure; no I/O — uiChartFeed asks the server for pages and hands them
 *  here). The rules a record follows to become points are the contract's (UiChartSourceSchema):
 *
 *  - records end at a newline (LF; a CR before it is dropped); bytes after the last newline wait for the next page.
 *    Records are split on bytes, so a UTF-8 character cut by a page edge is whole when its record is decoded. A UTF-8
 *    byte order mark at the start of the file is skipped; an empty line is no record.
 *  - JSONL: a record that is not a JSON object is skipped (counted); the next one is read as ever.
 *  - CSV: RFC 4180 (comma; double quotes; "" for a quote inside quotes; a quoted field may hold commas and line breaks);
 *    a quote opens a quoted field only at a field's start (elsewhere it is text); the first record is the header (names
 *    compared after trimming spaces). How the bytes are split into pages never changes which records they make.
 *  - x: a finite number (JSONL: a JSON number; CSV: a decimal number, spaces around it trimmed); on a time axis whole
 *    epoch milliseconds within ±UI_CHART_TIME_MAX_MS. A record without a usable x gives no point.
 *  - a series' value: a finite number is a point; JSON null or any other value present (CSV: a non-empty cell that is
 *    no decimal number, e.g. "nan") is a gap (stored as NaN); absent (JSONL) or an empty cell (CSV) is no point.
 *  - x strictly increases within each series: a point at an x not above its series' last x is skipped (counted).
 *  - a record longer than UI_CHART_SOURCE_LIMITS.recordBytes is skipped (counted) whole, up to its end.
 *
 *  The points are kept in growable typed arrays, never one object per point; the extents (x and finite y) and each
 *  series' latest point are kept as they grow, so nothing that reads them scans the history. */

import { UI_CHART_SOURCE_LIMITS, UI_CHART_TIME_MAX_MS, type UiChartSource, type UiChartXAxis } from '@oasis-code/contract'

// ---------------------------------------------------------------- CRC-32 (IEEE, as zlib's crc32)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** The CRC-32 of `bytes` continued from `crc` (the CRC-32 of the bytes before them; 0 for none) — zlib.crc32's value. */
export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = (crc ^ 0xffffffff) >>> 0
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------- the points

/** One series' points: x and value (NaN: a gap) in data order, x strictly increasing. */
export class SeriesColumn {
  xs = new Float64Array(256)
  ys = new Float64Array(256)
  n = 0
  /** the index of the latest point with a value, or -1 */
  lastFinite = -1
  /** how many points have a value */
  finite = 0
  get lastX(): number { return this.n ? this.xs[this.n - 1]! : Number.NEGATIVE_INFINITY }
  push(x: number, y: number): void {
    if (this.n === this.xs.length) {
      const grow = (a: Float64Array) => { const b = new Float64Array(a.length * 2); b.set(a); return b }
      this.xs = grow(this.xs); this.ys = grow(this.ys)
    }
    this.xs[this.n] = x; this.ys[this.n] = y
    if (Number.isFinite(y)) { this.lastFinite = this.n; this.finite += 1 }
    this.n += 1
  }
}

export interface SourceStats {
  /** records read (lines; CSV rows after the header) */
  records: number
  /** records skipped: not a JSON object, a CSV row that did not parse, longer than the record bound */
  badRecords: number
  /** records without a usable x */
  noX: number
  /** points skipped because their x did not go above their series' last x */
  outOfOrder: number
}

/** What a source holds now: one column per series of the spec (in its order), the extents (kept as points come), the
 *  counts. A reading from the start makes a new one (uiChartFeed's generation). */
export class SourcePoints {
  readonly columns: SeriesColumn[]
  xMin = Number.POSITIVE_INFINITY
  xMax = Number.NEGATIVE_INFINITY
  yMin = Number.POSITIVE_INFINITY
  yMax = Number.NEGATIVE_INFINITY
  stats: SourceStats = { records: 0, badRecords: 0, noX: 0, outOfOrder: 0 }
  /** the CSV header did not name x or a series' column (the names it lacks); null when nothing is missing */
  missingColumns: string[] | null = null
  constructor(count: number) { this.columns = Array.from({ length: count }, () => new SeriesColumn()) }
  get points(): number { return this.columns.reduce((n, c) => n + c.n, 0) }
  add(series: number, x: number, y: number): void {
    const col = this.columns[series]!
    if (!(x > col.lastX)) { this.stats.outOfOrder += 1; return }
    col.push(x, y)
    if (x < this.xMin) this.xMin = x
    if (x > this.xMax) this.xMax = x
    if (Number.isFinite(y)) { if (y < this.yMin) this.yMin = y; if (y > this.yMax) this.yMax = y }
  }
}

// ---------------------------------------------------------------- the parser

const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

/** An x as the axis takes it, or null. */
export function axisX(v: number, axis: UiChartXAxis): number | null {
  if (!Number.isFinite(v)) return null
  if (axis === 'time' && !(Number.isSafeInteger(v) && Math.abs(v) <= UI_CHART_TIME_MAX_MS)) return null
  return v
}

/** A CSV cell as a number: a decimal number (spaces trimmed), else null. */
export function csvNumber(cell: string): number | null {
  const t = cell.trim()
  if (!DECIMAL.test(t)) return null
  const v = Number(t)
  return Number.isFinite(v) ? v : null
}

/** The fields of one CSV record (its text without the record's line end): RFC 4180; a quote inside an unquoted field is
 *  kept as text. */
export function csvFields(text: string): string[] {
  const out: string[] = []
  let i = 0
  const n = text.length
  for (;;) {
    if (i < n && text[i] === '"') {
      let field = ''
      i += 1
      for (;;) {
        const q = text.indexOf('"', i)
        if (q < 0) { field += text.slice(i); i = n; break }
        field += text.slice(i, q)
        if (text[q + 1] === '"') { field += '"'; i = q + 2; continue }
        i = q + 1
        break
      }
      // anything between the closing quote and the comma is kept (lenient)
      const comma = text.indexOf(',', i)
      field += comma < 0 ? text.slice(i) : text.slice(i, comma)
      out.push(field)
      if (comma < 0) return out
      i = comma + 1
    } else {
      const comma = text.indexOf(',', i)
      if (comma < 0) { out.push(text.slice(i)); return out }
      out.push(text.slice(i, comma))
      i = comma + 1
    }
  }
}

/** Reads a source's bytes as they come, page by page, into SourcePoints. Never throws on what the file holds. */
export class SourceParser {
  readonly points: SourcePoints
  private readonly decoder = new TextDecoder('utf-8')
  /** the bytes of the record under way (after the last record end) */
  private pending: Uint8Array[] = []
  private pendingBytes = 0
  /** the record under way is past the bound: its bytes are dropped up to its end */
  private overlong = false
  /** CSV: inside a quoted field at the end of what came so far; at a field's start; just after a quoted field's quote */
  private quoted = false
  private fieldStart = true
  private closed = false
  /** how many bytes of a byte order mark the file has started with; -1 once decided */
  private bom = 0
  private header: { x: number; cols: number[] } | null = null
  readonly source: Pick<UiChartSource, 'format' | 'x' | 'series'>
  readonly axis: UiChartXAxis
  readonly recordBytes: number
  constructor(source: Pick<UiChartSource, 'format' | 'x' | 'series'>, axis: UiChartXAxis, recordBytes: number = UI_CHART_SOURCE_LIMITS.recordBytes) {
    this.source = source; this.axis = axis; this.recordBytes = recordBytes
    this.points = new SourcePoints(source.series.length)
  }

  /** The next bytes of the file, in order. */
  feed(input: Uint8Array): void {
    let bytes = input
    if (this.bom >= 0) {
      // a byte order mark at the file's start (its three bytes may come in separate pages)
      let i = 0
      while (this.bom < 3 && i < bytes.length && bytes[i] === BOM[this.bom]) { this.bom += 1; i += 1 }
      if (this.bom === 3) { this.bom = -1; bytes = bytes.subarray(i) }
      else if (i === bytes.length) return
      else {
        const held = Uint8Array.from(BOM.slice(0, this.bom))
        this.bom = -1
        bytes = concat([held], held.length, bytes.subarray(i))
      }
    }
    const csv = this.source.format === 'csv'
    let from = 0
    for (let i = 0; i < bytes.length; i += 1) {
      const b = bytes[i]!
      if (csv) {
        // the record's framing reads quotes as csvFields does: a quote opens a quoted field only at the field's start;
        // in it, a quote ends it unless the next byte is a quote too ("" — a quote); a quote elsewhere is text
        if (this.quoted) { if (b === 0x22) { this.quoted = false; this.closed = true } continue }
        if (b === 0x22 && (this.fieldStart || this.closed)) { this.quoted = true; this.fieldStart = false; this.closed = false; continue }
        this.closed = false
        if (b === 0x2c) { this.fieldStart = true; continue }
        this.fieldStart = b === 0x0a
      }
      if (b !== 0x0a) continue
      this.endRecord(bytes.subarray(from, i))
      from = i + 1
    }
    if (from < bytes.length) this.keep(bytes.subarray(from))
  }

  private keep(part: Uint8Array): void {
    if (this.overlong) return
    if (this.pendingBytes + part.length > this.recordBytes) {
      // dropped up to its end — the record's end as the quotes say (the quote state goes on unchanged: the same bytes
      // end the same records however they are split into pages)
      this.overlong = true; this.pending = []; this.pendingBytes = 0
      return
    }
    // a copy: the page's buffer is the caller's
    this.pending.push(part.slice())
    this.pendingBytes += part.length
  }

  private endRecord(tail: Uint8Array): void {
    if (this.overlong || this.pendingBytes + tail.length > this.recordBytes) {
      this.overlong = false; this.pending = []; this.pendingBytes = 0
      this.points.stats.badRecords += 1
      return
    }
    const bytes = this.pendingBytes ? concat(this.pending, this.pendingBytes, tail) : tail
    this.pending = []; this.pendingBytes = 0
    let end = bytes.length
    if (end && bytes[end - 1] === 0x0d) end -= 1
    if (end === 0) return
    const text = this.decoder.decode(bytes.subarray(0, end))
    if (this.source.format === 'jsonl') this.jsonRecord(text)
    else this.csvRecord(text)
  }

  private jsonRecord(text: string): void {
    if (!text.trim()) return
    let rec: unknown
    try { rec = JSON.parse(text) } catch { this.points.stats.badRecords += 1; return }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) { this.points.stats.badRecords += 1; return }
    this.points.stats.records += 1
    const o = rec as Record<string, unknown>
    const xv = Object.hasOwn(o, this.source.x) ? o[this.source.x] : undefined
    const x = typeof xv === 'number' ? axisX(xv, this.axis) : null
    if (x === null) { this.points.stats.noX += 1; return }
    this.source.series.forEach((s, i) => {
      if (!Object.hasOwn(o, s.column)) return
      const v = o[s.column]
      this.points.add(i, x, typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN)
    })
  }

  private csvRecord(text: string): void {
    if (!text.trim()) return
    const fields = csvFields(text)
    if (this.header === null) {
      const names = fields.map((f) => f.trim())
      const at = (name: string) => names.indexOf(name.trim())
      const x = at(this.source.x)
      const cols = this.source.series.map((s) => at(s.column))
      const missing = [...(x < 0 ? [this.source.x] : []), ...this.source.series.filter((_, i) => cols[i]! < 0).map((s) => s.column)]
      this.points.missingColumns = missing.length ? missing : null
      this.header = { x, cols }
      return
    }
    this.points.stats.records += 1
    const { x: xi, cols } = this.header
    const raw = xi >= 0 && xi < fields.length ? csvNumber(fields[xi]!) : null
    const x = raw === null ? null : axisX(raw, this.axis)
    if (x === null) { this.points.stats.noX += 1; return }
    cols.forEach((ci, i) => {
      if (ci < 0 || ci >= fields.length) return
      const cell = fields[ci]!
      if (!cell.trim()) return
      const v = csvNumber(cell)
      this.points.add(i, x, v === null ? Number.NaN : v)
    })
  }
}

const BOM = [0xef, 0xbb, 0xbf]

function concat(parts: Uint8Array[], size: number, tail: Uint8Array): Uint8Array {
  const out = new Uint8Array(size + tail.length)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  out.set(tail, at)
  return out
}
